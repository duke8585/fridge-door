/**
 * Ingredient resolution against the D1 catalogue. Steps 1 and 2 (exact alias, then the rules) are
 * resolveLocal in shared/catalogue.ts. Step 3 asks Claude Haiku for what is still unknown and
 * stores the answers as 'auto' entries. Step 4: without a key, during an outage, or when the call
 * fails, the rule result stands with aisle 'other' and nothing is stored, so a later save asks again.
 * A save never waits on more than one short model call and never fails because of it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  AISLE_IDS,
  AISLES,
  buildCatalogue,
  resolveLocal,
  type Aisle,
  storedName,
  type Catalogue,
} from "../shared/catalogue";
import type { RecipeInput, ShoppingItem } from "../shared/schema";
import { aiState, noteOutage, strictSchema, type AiEnv } from "./ai";
import * as repo from "./repo";

export const CLASSIFY_MODEL = "claude-haiku-5-5";
const TOOL_NAME = "record_ingredients";
/** Items per model call: one call covers any recipe, the backfill needs several. */
const BATCH = 60;

export type Place = { base: string; aisle: Aisle };

const ClassifiedSchema = z.object({
  ingredients: z.array(z.object({ item: z.string(), base: z.string(), aisle: z.enum(AISLE_IDS) })),
});

const CLASSIFY_TOOL: Anthropic.Beta.BetaTool = {
  name: TOOL_NAME,
  description: "Record the base and aisle of every item. Call exactly once.",
  input_schema: strictSchema(z.toJSONSchema(ClassifiedSchema, { io: "input" })) as Anthropic.Beta.BetaTool.InputSchema,
  strict: true,
};

export const CLASSIFY_SYSTEM = `You sort ingredient names from recipes into the shopping catalogue of a household that shops in a German supermarket.

For every item give:
- base: the generic ingredient a shopper looks for. English, lowercase, last word singular. Drop variety, brand, colour, size, ripeness, freshness and preparation, unless they change what you buy: "Granny Smith apples" -> apple, "finely chopped fresh parsley" -> parsley, but brown sugar, smoked paprika, red lentil, coconut milk and ground coriander stay as they are. Reuse a base from the known bases whenever one fits; make a new one only when none does.
- A base is always a shelf noun, never a temperature, colour or other modifier. For alternatives ("cold or sparkling water") name the shared ingredient ("water"). "frozen X" stays "frozen X" in the frozen aisle. Tap water and ice go to home. Use other only when nothing fits.
- aisle: where the supermarket shelves the base, one of:
${AISLES.map((a) => `  - ${a.id}: ${a.label}`).join("\n")}

Answer only by calling ${TOOL_NAME} once, with one entry per item and the item copied exactly.`;

export function classifyMessage(items: readonly string[], knownBases: readonly string[]): string {
  return [`Known bases: ${knownBases.join(", ") || "(none yet)"}`, "", "Items:", ...items.map((i) => `- ${i}`), "", `Call ${TOOL_NAME} now.`].join("\n");
}

/** One Haiku call. Answers for items that were not asked, or with an empty base, are dropped. */
async function classifyBatch(client: Anthropic, items: readonly string[], knownBases: readonly string[]): Promise<Map<string, Place>> {
  const res = await client.beta.messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 4000,
    system: CLASSIFY_SYSTEM,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [{ role: "user", content: classifyMessage(items, knownBases) }],
  });
  const call = res.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME);
  const parsed = ClassifiedSchema.safeParse(call?.input);
  const asked = new Set(items);
  const out = new Map<string, Place>();
  for (const c of parsed.success ? parsed.data.ingredients : []) {
    const base = storedName(c.base);
    if (asked.has(c.item) && base && base.length <= 60) out.set(c.item, { base, aisle: c.aisle });
  }
  return out;
}

/**
 * Step 3 for the unknown items, stored as 'auto' entries. Returns what the model answered, with the
 * catalogue's aisle where the model picked a base that exists. Empty when the model cannot run.
 */
async function classifyUnknown(env: AiEnv, cat: Catalogue, items: readonly string[]): Promise<Map<string, Place>> {
  const out = new Map<string, Place>();
  const now = new Date();
  const ai = await aiState(env, now);
  if (!ai.ok || items.length === 0) return out;
  const client = new Anthropic({ apiKey: ai.apiKey, maxRetries: 0, timeout: 20_000 });
  const known = [...cat.aisles.keys()];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    let answers: Map<string, Place>;
    try {
      answers = await classifyBatch(client, batch, known);
    } catch (e) {
      const outage = await noteOutage(env, e, now);
      console.error(JSON.stringify({ event: "ingredient_classify_error", outage, message: e instanceof Error ? e.message : String(e) }));
      break;
    }
    const entries = [...answers].map(([item, p]) => ({ alias: storedName(item), base: p.base, aisle: cat.aisles.get(p.base) ?? p.aisle }));
    await repo.addAutoEntries(env.DB, entries, now.toISOString());
    for (const [item, p] of answers) out.set(item, { base: p.base, aisle: cat.aisles.get(p.base) ?? p.aisle });
  }
  return out;
}

export type Resolver = { cat: Catalogue; places: Map<string, Place>; unknown: number };

/** The base and aisle of every item. `model: false` stops at the rules (the deterministic backfill). */
export async function resolveItems(env: AiEnv, items: Iterable<string>, opts: { model: boolean } = { model: true }): Promise<Resolver> {
  const cat = buildCatalogue(await repo.loadCatalogue(env.DB));
  const places = new Map<string, Place>();
  const unknown: string[] = [];
  for (const item of new Set(items)) {
    const r = resolveLocal(cat, item);
    places.set(item, { base: r.base, aisle: r.aisle });
    if (r.how === "unknown") unknown.push(item);
  }
  const classified = opts.model ? await classifyUnknown(env, cat, unknown) : new Map<string, Place>();
  const authoritative = buildCatalogue(await repo.loadCatalogue(env.DB));
  for (const item of places.keys()) {
    const r = resolveLocal(authoritative, item);
    places.set(item, { base: r.base, aisle: r.aisle });
  }
  return { cat: authoritative, places, unknown: unknown.length - classified.size };
}

const withBases = <T extends Pick<RecipeInput, "sections">>(input: T, places: ReadonlyMap<string, Place>): T => ({
  ...input,
  sections: input.sections.map((s) => ({ ...s, ingredients: s.ingredients.map((i) => ({ ...i, base: places.get(i.item)!.base })) })),
});

/** The recipe as saved: every ingredient's base resolved from its item, whatever the writer sent as base. */
export async function resolveRecipe<T extends RecipeInput>(env: AiEnv, input: T): Promise<T> {
  const { places } = await resolveItems(env, input.sections.flatMap((s) => s.ingredients.map((i) => i.item)));
  return withBases(input, places);
}

/**
 * Shopping rows as stored: a live row without a base is resolved (older clients, items typed in
 * offline that the phone's catalogue did not know), a row without an aisle gets its base's aisle.
 * Rows that have both, and tombstones, pass unchanged.
 */
export async function placeShopping(env: AiEnv, items: readonly ShoppingItem[]): Promise<ShoppingItem[]> {
  const open = items.filter((i) => !i.deleted && (!i.base || !i.aisle));
  if (open.length === 0) return [...items];
  const { cat, places } = await resolveItems(env, open.filter((i) => !i.base).map((i) => i.item));
  return items.map((i) => {
    if (i.deleted || (i.base && i.aisle)) return i;
    const base = i.base ?? places.get(i.item)!.base;
    return { ...i, base, aisle: cat.aisles.get(base) ?? places.get(i.item)?.aisle ?? "other" };
  });
}

export type BackfillResult = { recipes: number; updated: number; items: number; unknown: number; nextCursor: string | null };

/**
 * Resolves the bases of every stored recipe again and writes the ones that changed. Idempotent: a
 * second run with the same catalogue writes nothing, and a run after the catalogue learned more
 * (or with a key that was missing before) converges on the new answers.
 */
export async function backfillBases(env: AiEnv, opts: { model: boolean; cursor?: string }): Promise<BackfillResult> {
  const rows = await repo.allSections(env.DB, opts.cursor);
  const parsed = rows.map((r) => ({ ...r, sections: JSON.parse(r.sections_json) as RecipeInput["sections"] }));
  const items = parsed.flatMap((r) => r.sections.flatMap((s) => s.ingredients.map((i) => i.item)));
  const { places, unknown } = await resolveItems(env, items, opts);
  let updated = 0;
  for (const r of parsed) {
    const after = JSON.stringify(withBases({ sections: r.sections }, places).sections);
    if (after !== r.sections_json && (await repo.setSectionBases(env.DB, r.id, r.sections_json, after))) updated++;
  }
  return { recipes: rows.length, updated, items: places.size, unknown, nextCursor: rows.length === 50 ? rows.at(-1)!.id : null };
}
