import { contentHash, coverKey } from "../shared/cover";
import type { CoverFocus } from "../shared/schema";
import * as repo from "./repo";

/** An image already checked against the cover type and size limits. */
export type CoverUpload = { bytes: ArrayBuffer; type: string; ext: string; focus: CoverFocus | null };

/**
 * Same bytes -> same key -> no write. A new image writes the new object, points the row at it
 * (focus reset to `upload.focus`), then deletes the old object.
 */
export async function storeCover(
  env: { DB: D1Database; COVERS: R2Bucket },
  id: string,
  currentKey: string | null,
  upload: CoverUpload,
  now: string,
): Promise<void> {
  const key = coverKey(id, await contentHash(upload.bytes), upload.ext);
  if (key === currentKey) return;
  await env.COVERS.put(key, upload.bytes, { httpMetadata: { contentType: upload.type } });
  await repo.setCoverKey(env.DB, id, key, upload.focus, now);
  if (currentKey) await env.COVERS.delete(currentKey);
}
