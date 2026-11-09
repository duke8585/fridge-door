/** Wire types of import from a link (POST /api/import-url, /api/import-url/save, GET /api/import-url/status). No runtime imports. */
import type { DuplicateCandidate } from "./duplicates";
import type { Comment, Recipe, RecipeInput } from "./schema";

export type UrlImportRequest = { url: string; notes?: string; force?: boolean };

/** Where the draft came from: structured page data, page text, the user's notes, or nothing (stub, no model call). */
export type ImportExtraction = "json-ld" | "text" | "notes" | "stub";

/** A draft for the editor, not saved yet. `problems` are contract violations left after the retry. */
export type UrlImportDraft = {
  recipe: RecipeInput;
  review_notes: string[];
  problems: string[];
  cover_url: string | null;
  extraction: ImportExtraction;
  /** Recipes with a similar title (the same URL was already checked before the model call). */
  duplicates: DuplicateCandidate[];
  /** Set when the model was needed but not available, so the draft was filled without AI. */
  ai_unavailable: AiUnavailable | null;
};

/** Why import runs without AI: no key on the server, the API credits are used up, or the key was rejected. */
export type AiUnavailable = "not_configured" | "credits_exhausted" | "key_rejected";

/** GET /api/import-url/status. `until`: when the model is tried again after an outage. Usage covers the last 30 days. */
export type UrlImportStatus = {
  ai: "available" | AiUnavailable;
  until: string | null;
  usage_30d: { imports: number; model_imports: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
};

export const AI_UNAVAILABLE_TEXT: Record<AiUnavailable, string> = {
  credits_exhausted: "AI import credits are used up, so this draft was filled without AI. Top up the Anthropic credits to get full imports again.",
  key_rejected: "The Anthropic API key was rejected, so this draft was filled without AI. Check the key to get full imports again.",
  not_configured: "AI import is not set up on this server (no Anthropic API key), so this draft was filled without AI.",
};

export type UrlImportSaveRequest = { recipe: RecipeInput; review_notes: string[]; confirm_duplicate: boolean; cover_url: string | null };
export type UrlImportSaved = { recipe: Recipe; comments: Comment[]; cover_error?: string };

/** Error bodies besides the usual `validation` and `auth_required`. */
export type UrlImportError =
  | { error: "rate_limited"; message: string; retry_after_s: number }
  | { error: "duplicate"; message: string; candidates: DuplicateCandidate[] }
  | { error: "fetch_failed"; failure: string; message: string }
  | { error: "model_failed"; message: string }
  | { error: "problems"; message: string; problems: string[] };
