/**
 * Generated covers: Workers AI draws the finished dish from the recipe (shared/coverArt.ts) and the
 * image goes through the same storeCover as any other cover, marked cover_ai. Without the AI
 * binding (local dev, forks) nothing is generated and nothing fails.
 */
import { coverPrompt } from "../shared/coverArt";
import { storeCover } from "./covers";
import * as repo from "./repo";

export const COVER_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export type CoverGenEnv = { DB: D1Database; COVERS: R2Bucket; AI?: Ai };

export type GenerateResult =
  | { status: "generated" }
  | { status: "skipped"; reason: "not_found" | "has_cover" | "cover_changed" }
  | { status: "unavailable"; reason: "no_ai_binding" | "model_error" | "no_image" };

/** One image for one recipe that has no cover. Never throws for a model failure. */
export async function generateCover(env: CoverGenEnv, id: string): Promise<GenerateResult> {
  const recipe = await repo.getRecipe(env.DB, id);
  if (!recipe) return { status: "skipped", reason: "not_found" };
  if (recipe.cover_key) return { status: "skipped", reason: "has_cover" };
  if (!env.AI) {
    console.warn(`cover generation skipped for ${id}: no AI binding`);
    return { status: "unavailable", reason: "no_ai_binding" };
  }
  let image: string | undefined;
  try {
    ({ image } = await env.AI.run(COVER_MODEL, { prompt: coverPrompt(recipe), steps: 8 }));
  } catch (e) {
    console.warn(`cover generation failed for ${id}`, e);
    return { status: "unavailable", reason: "model_error" };
  }
  if (!image) {
    console.warn(`cover generation for ${id} returned no image`);
    return { status: "unavailable", reason: "no_image" };
  }
  const bytes = Uint8Array.from(atob(image), (ch) => ch.charCodeAt(0));
  const stored = await storeCover(env, id, null, { bytes: bytes.buffer, type: "image/jpeg", ext: "jpg", focus: null, ai: true }, new Date().toISOString());
  return stored ? { status: "generated" } : { status: "skipped", reason: "cover_changed" };
}

/** After a create (MCP, link import): generate once the response is out. Errors are logged, never thrown. */
export function generateCoverLater(waitUntil: (p: Promise<unknown>) => void, env: CoverGenEnv, id: string): void {
  waitUntil(generateCover(env, id).catch((e) => console.warn(`cover generation for ${id} failed`, e)));
}
