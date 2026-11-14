/** Cover images: content-addressed R2 keys, so a URL never changes meaning and can be cached forever. */
import type { CoverFocus } from "./schema";

export const MAX_COVER_BYTES = 10 * 1024 * 1024;

/** Raster types only: an SVG served from our origin could run script. */
export const COVER_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

/** Why a picked or pasted file cannot be a cover, or undefined if it can. Same limits as the upload route. */
export function coverFileProblem(file: { type: string; size: number }): string | undefined {
  if (!(file.type in COVER_TYPES)) return `Use a JPEG, PNG, WebP, AVIF or GIF image (got ${file.type || "an unknown type"}).`;
  if (file.size > MAX_COVER_BYTES) return "That image is larger than 10 MB, the limit for covers.";
  if (file.size === 0) return "That image is empty.";
  return undefined;
}

export const COVER_KEY = /^covers\/[A-Za-z0-9_-]+\/([0-9a-f]{16})\.(jpg|png|webp|avif|gif)$/;

export async function contentHash(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export const coverKey = (recipeId: string, hash: string, ext: string): string => `covers/${recipeId}/${hash}.${ext}`;

export const coverHash = (key: string | null | undefined): string | undefined => (key ? COVER_KEY.exec(key)?.[1] : undefined);

/** The R2 key doubles as the URL path under /api. */
export const coverUrl = (key: string): string => `/api/${key}`;

export const DEFAULT_FOCUS: CoverFocus = { x: 50, y: 40 };

/** CSS object-position for a cropped cover. The focal point lands at the same relative spot in every crop. */
export const focusPosition = (f: CoverFocus | null | undefined): string => {
  const { x, y } = f ?? DEFAULT_FOCUS;
  return `${x}% ${y}%`;
};

export type Box = { left: number; top: number; width: number; height: number };

const toPercent = (offset: number, size: number): number => Math.round(Math.min(100, Math.max(0, (offset / size) * 100)) * 10) / 10;

/** Pointer position over the rendered image -> focal point, clamped to the image and rounded to 0.1 %. */
export function pointToFocus(clientX: number, clientY: number, box: Box): CoverFocus {
  if (box.width <= 0 || box.height <= 0) return DEFAULT_FOCUS;
  return { x: toPercent(clientX - box.left, box.width), y: toPercent(clientY - box.top, box.height) };
}

/** `?focus=30,20` on a cover upload: the focus that goes with the new image (the importer's proposal). */
export const focusParam = (f: CoverFocus): string => `${f.x},${f.y}`;

export function parseFocusParam(s: string): { x: number; y: number } | undefined {
  const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(s);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
}
