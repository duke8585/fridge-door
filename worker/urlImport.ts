/**
 * Import from a link. POST /api/import-url fetches the page, extracts it and asks Claude for a
 * draft; nothing is saved. Without the model (no key, credits used up, key rejected) the draft is
 * mapped from the page's schema.org data, or is a stub. POST /api/import-url/save stores the
 * (edited) draft through the same ingest path as MCP create_recipe, then fetches the cover.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Context } from "hono";
import { z } from "zod";
import { findDuplicates, stripTracking } from "../shared/duplicates";
import { toFieldErrors, type ValidationErrorBody } from "../shared/schema";
import type { AiUnavailable, UrlImportDraft, UrlImportError, UrlImportSaved, UrlImportStatus } from "../shared/urlImport";
import { aiState, noteOutage } from "./ai";
import type { Env } from "./app";
import { storeCover } from "./covers";
import { type Extraction, extractPage, type PageMeta, str } from "./extract";
import { type Draft, DraftSchema, draftProblems, ingestRecipe } from "./ingest";
import { ldDraft } from "./ldDraft";
import { fetchCoverImage } from "./mcp";
import { checkTarget, fetchPage } from "./pageFetch";
import { type ContentKind, draftRecipe, IMPORT_MODEL } from "./recipeLlm";
import * as repo from "./repo";

type Ctx = Context<Env>;

export const IMPORTS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Notes at least this long are treated as the recipe text when the page itself has none. */
const NOTES_AS_RECIPE_CHARS = 150;
const SOCIAL_HOSTS = ["instagram.com", "tiktok.com", "youtube.com", "youtu.be", "facebook.com", "fb.watch"];
const NO_AI = "imported without AI";

const RequestSchema = z.object({
  url: z.string().trim().min(1, "Paste a link").max(2000),
  notes: z.string().max(4000).optional(),
  force: z.boolean().default(false),
});
const SaveSchema = DraftSchema.extend({
  confirm_duplicate: z.boolean().default(false),
  cover_url: z.url().nullable().default(null),
});

const errorJson = (c: Ctx, body: UrlImportError, status: 409 | 422 | 429 | 502) => c.json(body, status);

const isSocial = (url: URL): boolean => {
  const host = url.hostname.toLowerCase();
  return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
};

export async function importStatus(c: Ctx): Promise<Response> {
  const now = new Date();
  const ai = await aiState(c.env, now);
  const usage_30d = await repo.urlImportUsageSince(c.env.DB, new Date(now.getTime() - 30 * DAY_MS).toISOString());
  return c.json<UrlImportStatus>({ ai: ai.ok ? "available" : ai.reason, until: ai.ok ? null : ai.until, usage_30d });
}

export async function importFromUrl(c: Ctx): Promise<Response> {
  const body = RequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json<ValidationErrorBody>({ error: "validation", fields: toFieldErrors(body.error.issues) }, 400);
  const { url, notes, force } = body.data;
  const target = checkTarget(url);
  if (!target.ok) {
    if (target.failure === "invalid_url") return c.json<ValidationErrorBody>({ error: "validation", fields: { url: target.message } }, 400);
    return errorJson(c, { error: "fetch_failed", failure: target.failure, message: target.message }, 422);
  }

  const user = c.get("user");
  const now = new Date();
  const recent = await repo.urlImportsSince(c.env.DB, user, new Date(now.getTime() - HOUR_MS).toISOString());
  if (recent.count >= IMPORTS_PER_HOUR) {
    const retry = recent.oldest ? Math.max(1, Math.ceil((Date.parse(recent.oldest) + HOUR_MS - now.getTime()) / 1000)) : 3600;
    return errorJson(
      c,
      { error: "rate_limited", message: `At most ${IMPORTS_PER_HOUR} imports per hour. Try again in ${Math.ceil(retry / 60)} min.`, retry_after_s: retry },
      429,
    );
  }

  const sourceUrl = stripTracking(target.url.href);
  const index = await repo.recipeIndex(c.env.DB);
  if (!force) {
    const same = findDuplicates({ title: "", source_url: sourceUrl }, index).filter((d) => d.reason === "same source_url");
    if (same.length) return errorJson(c, { error: "duplicate", message: "This link was imported before.", candidates: same }, 409);
  }
  const logId = await repo.logUrlImport(c.env.DB, user, now.toISOString(), new Date(now.getTime() - 90 * DAY_MS).toISOString());

  const social = isSocial(target.url);
  const page = await fetchPage(sourceUrl);
  if (!page.ok && !social) return errorJson(c, { error: "fetch_failed", failure: page.failure, message: page.message }, 422);
  const extracted: Extraction = page.ok ? extractPage(page.html, page.url) : { kind: "none", meta: {} };
  const { meta } = extracted;
  const respond = (draft: Draft, extraction: UrlImportDraft["extraction"], ai_unavailable: AiUnavailable | null, problems?: string[]) =>
    c.json<UrlImportDraft>({ ...draftResponse(draft, extraction, meta, index, problems), ai_unavailable });

  let kind: ContentKind;
  let content: string;
  if (!social && extracted.kind !== "none") {
    kind = extracted.kind;
    content = extracted.text;
  } else if ((notes?.trim().length ?? 0) >= NOTES_AS_RECIPE_CHARS) {
    kind = "notes";
    content = meta.title ? `Title: ${meta.title}` : "(nothing readable)";
  } else {
    const why = social ? "video or social post: the recipe is not on the page as text" : "no recipe text on the page";
    return respond(stubDraft(sourceUrl, meta, notes, [why]), "stub", null);
  }

  /** The model is needed but cannot run: map the schema.org data, else a stub. */
  const withoutAi = (reason: AiUnavailable): Response => {
    if (extracted.kind === "json-ld") {
      const title = cleanTitle(str(extracted.recipe.name) ?? meta.title, sourceUrl);
      return respond(ldDraft(extracted.recipe, sourceUrl, title), "json-ld", reason);
    }
    return respond(stubDraft(sourceUrl, meta, notes, [NO_AI]), "stub", reason);
  };

  const ai = await aiState(c.env, now);
  if (!ai.ok) return withoutAi(ai.reason);
  const client = new Anthropic({ apiKey: ai.apiKey, maxRetries: 1, timeout: 120_000 });
  let result;
  try {
    result = await draftRecipe(client, { sourceUrl, kind, content, title: meta.title, notes });
  } catch (e) {
    const outage = await noteOutage(c.env, e, now);
    console.error(
      JSON.stringify({
        event: "url_import_model_error",
        outage,
        status: e instanceof Anthropic.APIError ? e.status : null,
        type: e instanceof Anthropic.APIError ? e.type : null,
      }),
    );
    if (outage) return withoutAi(outage);
    const why = e instanceof Anthropic.RateLimitError ? "the model is busy" : e instanceof Anthropic.APIError ? `HTTP ${e.status ?? "error"}` : "no answer";
    return errorJson(c, { error: "model_failed", message: `The model could not write the draft (${why}). Try again in a minute.` }, 502);
  }
  await repo.recordUrlImportUsage(c.env.DB, logId, IMPORT_MODEL, result.usage);
  console.log(JSON.stringify({ event: "url_import", user, host: target.url.hostname, kind, model: IMPORT_MODEL, ok: result.ok, usage: result.usage }));
  if (!result.ok) return errorJson(c, { error: "model_failed", message: result.message }, 502);
  return respond(result.draft, kind, null, result.problems);
}

function draftResponse(
  draft: Draft,
  extraction: UrlImportDraft["extraction"],
  meta: PageMeta,
  index: repo.IndexedRecipe[],
  problems = draftProblems(draft),
): Omit<UrlImportDraft, "ai_unavailable"> {
  return {
    recipe: draft.recipe,
    review_notes: draft.review_notes,
    problems,
    cover_url: meta.image ?? null,
    extraction,
    duplicates: findDuplicates({ title: draft.recipe.title }, index),
  };
}

/** The contract's stub, built without a model: nothing on the page to normalize, so nothing to invent. */
export function stubDraft(sourceUrl: string, meta: PageMeta, notes: string | undefined, why: string[]): Draft {
  return {
    recipe: {
      title: cleanTitle(meta.title, sourceUrl),
      sections: [{ ingredients: [] }],
      steps_md: "",
      notes_md: notes?.trim() ?? "",
      tags: [],
      source_url: sourceUrl,
    },
    review_notes: ["stub", ...why],
  };
}

const PLATFORM_SUFFIX = /\s*[|\-:]\s*(TikTok|YouTube|Instagram|Facebook)(\s*-\s*Make Your Day)?\s*$/i;

/** A page title without platform noise, emojis or hashtags, else "Recipe from <host>". */
export function cleanTitle(raw: string | undefined, sourceUrl: string): string {
  let t = raw ?? "";
  const insta = t.match(/^(.*?) on Instagram:\s*["“](.*)["”]?$/s);
  if (insta) t = insta[2]!.trim() || `Instagram post by ${insta[1]}`;
  t = t
    .split(/\r?\n/)[0]!
    .replace(PLATFORM_SUFFIX, "")
    .replace(/[“”"]+$/, "")
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 100) t = `${t.slice(0, 100).replace(/\s+\S*$/, "")}...`;
  return t || `Recipe from ${new URL(sourceUrl).hostname.replace(/^www\./, "")}`;
}

/** Field errors keyed like the editor's (no "recipe." prefix). */
const editorFieldErrors = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) =>
  toFieldErrors(issues.map((i) => ({ ...i, path: i.path[0] === "recipe" ? i.path.slice(1) : i.path })));

export async function saveImported(c: Ctx): Promise<Response> {
  const body = SaveSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json<ValidationErrorBody>({ error: "validation", fields: editorFieldErrors(body.error.issues) }, 400);
  const { confirm_duplicate, cover_url, ...draft } = body.data;
  const user = c.get("user");
  const now = new Date().toISOString();
  const result = await ingestRecipe(c.env, draft, { author: user, source: "url-import", confirmDuplicate: confirm_duplicate, now });
  if (!result.ok && result.reason === "problems") {
    return errorJson(c, { error: "problems", message: "The recipe does not follow the style guide yet.", problems: result.problems }, 422);
  }
  if (!result.ok) return errorJson(c, { error: "duplicate", message: "A recipe like this exists already.", candidates: result.candidates }, 409);
  const cover_error = cover_url ? await saveCover(c, result.id, cover_url, now) : undefined;
  const recipe = (await repo.getRecipe(c.env.DB, result.id))!;
  return c.json<UrlImportSaved>({ recipe, comments: await repo.listComments(c.env.DB, result.id), ...(cover_error && { cover_error }) }, 201);
}

/** The recipe is saved either way; a cover that fails is reported, not fatal. */
async function saveCover(c: Ctx, id: string, url: string, now: string): Promise<string | undefined> {
  const target = checkTarget(url);
  if (!target.ok) return target.message;
  try {
    const image = await fetchCoverImage(target.url.href);
    if (!image.ok) return image.message;
    await storeCover(c.env, id, null, { bytes: image.bytes, type: image.type, ext: image.ext, focus: null }, now);
    return undefined;
  } catch (e) {
    return `Could not download the cover (${e instanceof Error ? e.message : String(e)}).`;
  }
}
