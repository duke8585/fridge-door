import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AISLE_IDS, buildCatalogue, type CatalogueData, singularKey, storedName } from "../../shared/catalogue";
import type { ImportRecord, Recipe, RecipeInput, RecipeSummary, ShoppingItem, ShoppingSyncResponse } from "../../shared/schema";
import worker from "../../worker/index";
import { type AuthedInit, authedRequest, fakeD1, fakeR2, oauthBindings, TEST_IMPORT_TOKEN, TEST_LOGINS, TEST_SECRET } from "./fakes";

let env: Record<string, unknown>;
let sqlite: DatabaseSync;
let claude: Response[];
let sentToClaude: any[];

beforeEach(() => {
  const db = fakeD1(resolve(import.meta.dirname, "../../migrations"));
  sqlite = db.sqlite;
  env = {
    ...oauthBindings(),
    DB: db.d1,
    COVERS: fakeR2().r2,
    ASSETS: {} as Fetcher,
    SESSION_SECRET: TEST_SECRET,
    LOGINS: TEST_LOGINS,
    IMPORT_TOKEN: TEST_IMPORT_TOKEN,
    ANTHROPIC_API_KEY: "sk-test",
  };
  claude = [];
  sentToClaude = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (!req.url.startsWith("https://api.anthropic.com/")) return new Response("not found", { status: 404 });
    sentToClaude.push(await req.json());
    const next = claude.shift();
    if (!next) throw new Error("unexpected model call");
    return next;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const call = async <T = any>(path: string, init: AuthedInit = {}): Promise<{ status: number; body: T }> => {
  const res = (await worker.fetch(
    (await authedRequest(`https://recipes.example/api${path}`, init)) as never,
    env as never,
    {} as ExecutionContext,
  )) as Response;
  return { status: res.status, body: (await res.json()) as T };
};
const json = (method: string, body: unknown, extra: AuthedInit = {}): AuthedInit => ({
  ...extra,
  method,
  headers: { "content-type": "application/json", ...(extra.headers as object) },
  body: JSON.stringify(body),
});

const haiku = (ingredients: { item: string; base: string; aisle: string }[]): Response =>
  Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "tool_use", id: "toolu_1", name: "record_ingredients", input: { ingredients } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 60 },
  });
const apiError = (status: number, type: string, message: string): Response => Response.json({ type: "error", error: { type, message } }, { status });

const recipe = (items: string[], over: Partial<RecipeInput> = {}): RecipeInput => ({
  title: "Apple crumble",
  sections: [{ ingredients: items.map((item) => ({ item, qty: 1, unit: "piece" as const })) }],
  steps_md: "1. Bake.",
  notes_md: "",
  tags: ["course:dessert"],
  time: { total_min: 50 },
  ...over,
});
const bases = (r: Recipe): (string | undefined)[] => r.sections.flatMap((s) => s.ingredients.map((i) => i.base));
const entry = (base: string) => sqlite.prepare("SELECT aisle, origin FROM ingredient_bases WHERE base = ?").get(base);
const alias = (a: string) => sqlite.prepare("SELECT base, origin FROM ingredient_aliases WHERE alias = ?").get(a);

describe("the seed catalogue", () => {
  const data = (): { bases: { base: string; aisle: string }[]; aliases: { alias: string; base: string }[] } => ({
    bases: sqlite.prepare("SELECT base, aisle FROM ingredient_bases").all() as never,
    aliases: sqlite.prepare("SELECT alias, base FROM ingredient_aliases").all() as never,
  });
  it("is stored in lookup form, in known aisles, with every alias pointing at a base", () => {
    const { bases: b, aliases: a } = data();
    expect(b.length).toBeGreaterThan(250);
    const names = new Set(b.map((x) => x.base));
    for (const x of b) {
      expect(storedName(x.base), x.base).toBe(x.base);
      expect(AISLE_IDS).toContain(x.aisle);
    }
    for (const x of a) {
      expect(storedName(x.alias), x.alias).toBe(x.alias);
      expect(names.has(x.base), `${x.alias} -> ${x.base}`).toBe(true);
      expect(names.has(x.alias), `alias ${x.alias} is also a base`).toBe(false);
    }
  });
  it("resolves plurals of every base to that base", () => {
    const cat = buildCatalogue({ bases: data().bases.map((x) => ({ ...x, aisle: x.aisle as never, origin: "seed" })), aliases: [] });
    expect([...cat.names.keys()].filter((b) => singularKey(b) !== b)).toEqual([]);
  });
});

describe("every save path stores a base on each ingredient", () => {
  it("editor create and update, without a model call for known items", async () => {
    const created = await call<Recipe>("/recipes", json("POST", recipe(["Red Apples", "dark brown sugar", "butter"])));
    expect(created.status).toBe(201);
    expect(bases(created.body)).toEqual(["apple", "brown sugar", "butter"]);
    const updated = await call<Recipe>(`/recipes/${created.body.id}`, json("PUT", recipe(["ripe pears"])));
    expect(bases(updated.body)).toEqual(["pear"]);
    expect(sentToClaude).toHaveLength(0);
  });

  it("ignores a base the writer sent", async () => {
    const input = recipe(["apples"]);
    input.sections[0]!.ingredients[0]!.base = "banana";
    expect(bases((await call<Recipe>("/recipes", json("POST", input))).body)).toEqual(["apple"]);
  });

  it("batch import and restore", async () => {
    const rec: ImportRecord = {
      source_ref: "asana:1",
      status: "full",
      section: null,
      cover: null,
      ratings: [],
      comments: [],
      recipe: { ...recipe(["chopped tomatoes"]), time: { total_min: 50 } },
      review: [],
    };
    const imported = await call<{ id: string }>("/import/asana:1", json("PUT", rec, { as: null, headers: { authorization: `Bearer ${TEST_IMPORT_TOKEN}` } }));
    expect(imported.status).toBe(201);
    const id = imported.body.id;
    expect(bases((await call<{ recipe: Recipe }>(`/recipes/${id}`)).body.recipe)).toEqual(["chopped tomato"]);
    await call(`/recipes/${id}`, json("PUT", recipe(["sand"])));
    const revs = (await call<{ id: number }[]>(`/recipes/${id}/revisions`)).body;
    const restored = await call<Recipe>(`/recipes/${id}/revisions/${revs.at(-1)!.id}/restore`, json("POST", {}));
    expect(bases(restored.body)).toEqual(["chopped tomato"]);
  });

  it("asks Haiku once for the unknown items and stores its answers as auto entries", async () => {
    claude.push(
      haiku([
        { item: "Granny Smith apples", base: "apple", aisle: "produce" },
        { item: "za'atar", base: "za'atar", aisle: "spices" },
      ]),
    );
    const created = await call<Recipe>("/recipes", json("POST", recipe(["Granny Smith apples", "za'atar", "butter"])));
    expect(bases(created.body)).toEqual(["apple", "za'atar", "butter"]);
    expect(sentToClaude).toHaveLength(1);
    expect(sentToClaude[0].model).toBe("claude-haiku-5-5");
    expect(sentToClaude[0].messages[0].content).toContain("- Granny Smith apples\n- za'atar\n");
    expect(alias("granny smith apple")).toEqual({ base: "apple", origin: "auto" });
    expect(entry("za'atar")).toEqual({ aisle: "spices", origin: "auto" });
    // learned: the next save resolves them without the model
    await call("/recipes", json("POST", recipe(["granny smith apple", "za'atar"], { title: "Other" })));
    expect(sentToClaude).toHaveLength(1);
  });

  it("without a key: the rule result, aisle other, nothing stored, the save goes through", async () => {
    delete env.ANTHROPIC_API_KEY;
    const created = await call<Recipe>("/recipes", json("POST", recipe(["fresh Shiso Leaves"])));
    expect(created.status).toBe(201);
    expect(bases(created.body)).toEqual(["shiso leaf"]);
    expect(entry("shiso leaf")).toBeUndefined();
    expect(sentToClaude).toHaveLength(0);
  });

  it("with the credit used up: falls back, records the outage, and skips the model meanwhile", async () => {
    claude.push(apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."));
    const created = await call<Recipe>("/recipes", json("POST", recipe(["mystery root"])));
    expect(created.status).toBe(201);
    expect(bases(created.body)).toEqual(["mystery root"]);
    expect(sqlite.prepare("SELECT reason FROM ai_status").get()).toEqual({ reason: "credits_exhausted" });
    await call("/recipes", json("POST", recipe(["other mystery"], { title: "Second" })));
    expect(sentToClaude).toHaveLength(1);
  });

  it("when the call fails otherwise or answers nonsense: falls back without blocking", async () => {
    claude.push(apiError(529, "overloaded_error", "Overloaded"));
    expect((await call<Recipe>("/recipes", json("POST", recipe(["odd thing"])))).status).toBe(201);
    claude.push(haiku([{ item: "not asked", base: "x", aisle: "produce" }]));
    const second = await call<Recipe>("/recipes", json("POST", recipe(["odd thing"], { title: "Second" })));
    expect(bases(second.body)).toEqual(["odd thing"]);
    expect(entry("x")).toBeUndefined();
  });
});

describe("recipe search", () => {
  it('"apples" finds a recipe with "red apple" through its base, also in the list summaries', async () => {
    await call("/recipes", json("POST", recipe(["red apple"], { title: "Crumble" })));
    await call("/recipes", json("POST", recipe(["eggplant"], { title: "Parmigiana" })));
    expect((await call<RecipeSummary[]>("/recipes?q=apples")).body.map((r) => r.title)).toEqual(["Crumble"]);
    expect((await call<RecipeSummary[]>("/recipes?q=aubergines")).body.map((r) => r.title)).toEqual(["Parmigiana"]);
    const list = (await call<RecipeSummary[]>("/recipes")).body;
    expect(list.find((r) => r.title === "Parmigiana")?.bases).toEqual(["aubergine"]);
  });
});

const sync = (items: ShoppingItem[], since = 0, extra: Record<string, unknown> = {}) =>
  call<ShoppingSyncResponse>("/shopping/sync", json("POST", { items, since, ...extra }));
const row = (id: string, item: string, over: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id,
  item,
  checked: false,
  updated_at: "2026-11-09T10:00:00.000Z",
  ...over,
});

describe("shopping sync", () => {
  it("fills base and aisle for rows from older clients and keeps what newer clients send", async () => {
    const res = await sync([row("a", "apples"), row("b", "red apple", { base: "apple", aisle: "dairy" }), row("c", "butter", { base: "butter" })]);
    const byId = new Map(res.body.items.map((i) => [i.id, i]));
    expect(byId.get("a")).toMatchObject({ base: "apple", aisle: "produce" });
    expect(byId.get("b")).toMatchObject({ base: "apple", aisle: "dairy" });
    expect(byId.get("c")).toMatchObject({ base: "butter", aisle: "dairy" });
    expect(res.body.catalogue_version).toMatch(/^\d+$/);
  });

  it("drops an aisle id it does not know instead of rejecting the batch", async () => {
    const res = await sync([row("a", "apples", { base: "apple", aisle: "garden" as never })]);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ aisle: "produce" });
  });

  it("keeps one household aisle order, last write wins", async () => {
    expect((await sync([])).body.aisle_order).toBeNull();
    await sync([], 0, { aisle_order: { order: ["dairy", "produce"], updated_at: "2026-11-09T10:00:00.000Z" } });
    await sync([], 0, { aisle_order: { order: ["frozen"], updated_at: "2026-11-09T09:00:00.000Z" } });
    const { aisle_order } = (await sync([])).body;
    expect(aisle_order!.order.slice(0, 3)).toEqual(["dairy", "produce", "bakery"]);
    expect(aisle_order!.order).toHaveLength(AISLE_IDS.length);
  });
});

describe("the catalogue API", () => {
  it("a move to another aisle makes a user entry the next rows pick up, and changes the version", async () => {
    const before = (await call<CatalogueData>("/catalogue")).body;
    expect((await call("/catalogue/bases/apple", json("PUT", { aisle: "sweets-snacks" }))).status).toBe(200);
    expect(entry("apple")).toEqual({ aisle: "sweets-snacks", origin: "user" });
    const res = await sync([row("a", "apples")]);
    expect(res.body.items[0]).toMatchObject({ base: "apple", aisle: "sweets-snacks" });
    expect(res.body.catalogue_version).not.toBe(before.version);
    expect((await call("/catalogue/bases/apple", json("PUT", { aisle: "garden" }))).status).toBe(400);
  });

  it("the backfill resolves stored recipes once, is idempotent, and accepts the import token", async () => {
    sqlite
      .prepare(
        `INSERT INTO recipes (id, title, sections_json, steps_md, notes_md, tags_json, created_at, updated_at)
         VALUES ('old', 'Old', '[{"ingredients":[{"item":"red apples","qty":2,"unit":"piece"},{"item":"shiso leaves","note":"a few"}]}]', '1. Cook.', '', '["course:main"]', 'T', 'T')`,
      )
      .run();
    claude.push(haiku([{ item: "shiso leaves", base: "shiso leaf", aisle: "international" }]));
    const token = { as: null, headers: { authorization: `Bearer ${TEST_IMPORT_TOKEN}` } } as const;
    const first = await call("/catalogue/backfill", { ...token, method: "PUT" });
    expect(first.body).toEqual({ recipes: 1, updated: 1, shopping: 0, items: 2, unknown: 0, nextCursor: null });
    const row = sqlite.prepare("SELECT sections_json, updated_at FROM recipes WHERE id = 'old'").get() as { sections_json: string; updated_at: string };
    expect(JSON.parse(row.sections_json)[0].ingredients.map((i: { base: string }) => i.base)).toEqual(["apple", "shiso leaf"]);
    expect(row.updated_at).toBe("T");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM recipe_revisions").get()).toEqual({ n: 0 });
    expect((await call("/catalogue/backfill", { ...token, method: "PUT" })).body).toMatchObject({ updated: 0, unknown: 0 });
    expect(sentToClaude).toHaveLength(1);
  });

  it("the backfill regroups shopping rows placed under an older catalogue, and clients see the move", async () => {
    await sync([
      row("w", "cold or sparkling water", { base: "cold", aisle: "other" }),
      row("s", "granulated stevia", { base: "granulated stevia", aisle: "other" }),
      row("b", "butter", { base: "butter", aisle: "dairy" }),
      row("gone", "hot water", { base: "hot water", aisle: "other", deleted: true }),
    ]);
    const before = (await sync([])).body.rev;
    const token = { as: null, headers: { authorization: `Bearer ${TEST_IMPORT_TOKEN}` } } as const;
    expect((await call("/catalogue/backfill", { ...token, method: "PUT" })).body).toMatchObject({ shopping: 2 });
    const moved = (await sync([], before)).body.items;
    expect(moved.map((i) => [i.id, i.base, i.aisle])).toEqual([
      ["w", "water", "home"],
      ["s", "stevia", "oils-sauces"],
    ]);
    expect(moved.every((i) => i.updated_at > "2026-11-09T10:00:00.000Z")).toBe(true);
    expect((await call("/catalogue/backfill", { ...token, method: "PUT" })).body).toMatchObject({ shopping: 0 });
    expect(sentToClaude).toHaveLength(0);
  });
});

describe("correction concurrency regressions", () => {
  it("uses user priority, original timestamps and retry-safe LWW with monotonic generation", async () => {
    const repo = await import("../../worker/repo");
    const db = env.DB as D1Database;
    await repo.addAutoEntries(db, [{ alias: "test food", base: "test food", aisle: "other" }], "2099-01-01T00:00:00.000Z");
    const before = Number(await repo.catalogueVersion(db));
    await repo.setBaseAisle(db, "test food", "produce", "2026-01-01T00:00:00.000Z");
    expect(entry("test food")).toEqual({ aisle: "produce", origin: "user" });
    expect(Number(await repo.catalogueVersion(db))).toBeGreaterThan(before);
    await repo.setBaseAisle(db, "test food", "dairy", "2026-02-01T00:00:00.000Z");
    const generation = await repo.catalogueVersion(db);
    await repo.setBaseAisle(db, "test food", "produce", "2026-01-01T00:00:00.000Z");
    expect(entry("test food")!.aisle).toBe("dairy");
    expect(await repo.catalogueVersion(db)).toBe(generation);
  });

  it("returns the authoritative correction made while AI is pending", async () => {
    const repo = await import("../../worker/repo");
    const { resolveItems } = await import("../../worker/catalogue");
    vi.stubGlobal("fetch", async () => {
      await repo.setUserEntry(env.DB as D1Database, { alias: "mystery leaf", base: "parsley", aisle: "frozen" }, "2026-11-10T00:00:00.000Z");
      return haiku([{ item: "mystery leaf", base: "basil", aisle: "produce" }]);
    });
    const result = await resolveItems(env as never, ["mystery leaf"]);
    expect(result.places.get("mystery leaf")).toEqual({ base: "parsley", aisle: "frozen" });
  });

  it("preserves product-changing descriptors", async () => {
    const { resolveLocal } = await import("../../shared/catalogue");
    const repo = await import("../../worker/repo");
    const cat = buildCatalogue(await repo.loadCatalogue(env.DB as D1Database));
    expect(resolveLocal(cat, "dried parsley").base).toBe("dried parsley");
    expect(resolveLocal(cat, "smoked mystery butter").base).toBe("smoked mystery butter");
  });

  it("places the seeded names the way the shopping list should group them", async () => {
    const { resolveLocal } = await import("../../shared/catalogue");
    const repo = await import("../../worker/repo");
    const cat = buildCatalogue(await repo.loadCatalogue(env.DB as D1Database));
    const place = (item: string) => {
      const r = resolveLocal(cat, item);
      return [r.base, r.aisle];
    };
    expect(place("cold or sparkling water")).toEqual(["water", "home"]);
    expect(place("hot water")).toEqual(["water", "home"]);
    expect(place("tap water")).toEqual(["water", "home"]);
    expect(place("ice cubes")).toEqual(["ice", "home"]);
    expect(place("sparkling water")).toEqual(["sparkling water", "drinks"]);
    expect(place("granulated stevia")).toEqual(["stevia", "oils-sauces"]);
    expect(place("stevia powder")).toEqual(["stevia", "oils-sauces"]);
    expect(place("low fat cottage cheese")).toEqual(["cottage cheese", "dairy"]);
    expect(place("low carb tortilla")).toEqual(["tortilla", "international"]);
    expect(place("frozen blueberries")).toEqual(["frozen blueberry", "frozen"]);
    expect(place("frozen mixed berries")).toEqual(["frozen berry", "frozen"]);
    expect(resolveLocal(cat, "frozen jackfruit").aisle).toBe("frozen");
    expect(place("red bell pepper")).toEqual(["bell pepper", "produce"]);
    expect(place("kalamata olives")).toEqual(["olive", "canned"]);
    expect(place("white miso")).toEqual(["miso paste", "international"]);
    expect(place("silken tofu")).toEqual(["tofu", "dairy"]);
    expect(place("plain flour")).toEqual(["flour", "baking"]);
    expect(place("self-raising flour")).toEqual(["flour", "baking"]);
    expect(place("dried wakame")).toEqual(["wakame", "international"]);
    expect(place("hot sauce")).toEqual(["hot sauce", "oils-sauces"]);
    expect(place("ice cream")).toEqual(["ice cream", "frozen"]);
    expect(place("white wine")).toEqual(["white wine", "drinks"]);
    for (const item of ["matcha", "matcha powder"]) expect(place(item), item).toEqual(["matcha powder", "baking"]);
    expect(place("chicken or vegetable stock")).toEqual(["chicken stock", "spices"]);
    for (const [item, base] of [
      ["ice-cold water", "water"],
      ["just-off-boil water", "water"],
      ["cold filtered water", "water"],
      ["whole milk", "milk"],
      ["unsweetened Greek yogurt", "greek yogurt"],
      ["light soy sauce", "soy sauce"],
      ["light brown sugar", "brown sugar"],
      ["shiitake mushrooms", "mushroom"],
      ["baby potatoes", "potato"],
      ["canned coconut milk", "coconut milk"],
      ["parchment paper", "baking paper"],
      ["tamari", "soy sauce"],
    ] as const)
      expect(place(item)[0], item).toBe(base);
    expect(place("butter or margarine")).toEqual(["butter", "dairy"]);
  });

  it("the aisle migration keeps a base a person moved", () => {
    const sql = readFileSync(resolve(import.meta.dirname, "../../migrations/0010_catalogue_aisles.sql"), "utf8");
    sqlite.prepare("UPDATE ingredient_bases SET aisle = 'drinks', origin = 'user' WHERE base = 'water'").run();
    sqlite.exec("UPDATE ingredient_bases SET aisle = 'drinks', origin = 'seed' WHERE base = 'ice'");
    sqlite.exec(sql);
    expect(entry("water")).toEqual({ aisle: "drinks", origin: "user" });
    expect(entry("ice")).toEqual({ aisle: "home", origin: "seed" });
  });
});
