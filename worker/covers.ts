import { contentHash, coverKey } from "../shared/cover";
import type { CoverFocus } from "../shared/schema";
import * as repo from "./repo";

/** An image already checked against the cover type and size limits. `ai`: Workers AI generated it. */
export type CoverUpload = { bytes: ArrayBuffer; type: string; ext: string; focus: CoverFocus | null; ai: boolean };

/**
 * Same bytes -> same key -> no write. A new image writes the new object, points the row at it
 * (focus reset to `upload.focus`, cover_ai to `upload.ai`), then deletes the old object.
 * Returns false, and drops the new object, when the cover changed from `currentKey` meanwhile.
 */
export async function storeCover(
  env: { DB: D1Database; COVERS: R2Bucket },
  id: string,
  currentKey: string | null,
  upload: CoverUpload,
  now: string,
): Promise<boolean> {
  const key = coverKey(id, await contentHash(upload.bytes), upload.ext);
  if (key === currentKey) return true;
  await env.COVERS.put(key, upload.bytes, { httpMetadata: { contentType: upload.type } });
  if (!(await repo.setCoverKey(env.DB, id, currentKey, { key, focus: upload.focus, ai: upload.ai }, now))) {
    if ((await repo.getCoverKey(env.DB, id))?.cover_key !== key) await env.COVERS.delete(key);
    return false;
  }
  if (currentKey) await env.COVERS.delete(currentKey);
  return true;
}
