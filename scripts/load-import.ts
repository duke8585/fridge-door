/**
 * Loads import records (import/out/<gid>.json) into a running app. Idempotent: an unchanged
 * record is a no-op on the server, and a cover is uploaded only when the recipe has none or the
 * file's content hash differs from the one in its key.
 *
 * Usage: RECIPES_IMPORT_TOKEN=<IMPORT_TOKEN of that env> npm run load-import -- <base url> <out dir> <images dir> [gid ...]
 * The token is sent as `Authorization: Bearer`; the server accepts it on the import and cover routes only.
 * Exit 1 if any record failed. Prints one line per record that changed or failed, then the counts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { contentHash, coverHash, focusParam } from "../shared/cover";
import { type ImportRecord, ImportRecordSchema, type ImportResult, type ImportStatus, toFieldErrors } from "../shared/schema";

const CONTENT_TYPE: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

type Outcome = ImportStatus | "failed";

class Client {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  async put(path: string, body: string | Uint8Array, contentType: string): Promise<unknown> {
    const res = await fetch(new URL(`/api${path}`, this.base), {
      method: "PUT",
      headers: { "content-type": contentType, authorization: `Bearer ${this.token}` },
      body,
      redirect: "manual",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  }
}

async function loadOne(client: Client, rec: ImportRecord, imagesDir: string): Promise<{ status: ImportStatus; id: string; cover: boolean }> {
  const res = (await client.put(`/import/${encodeURIComponent(rec.source_ref)}`, JSON.stringify(rec), "application/json")) as ImportResult;
  if (!rec.cover) return { status: res.status, id: res.id, cover: false };
  const bytes = readFileSync(join(imagesDir, rec.cover));
  if (coverHash(res.cover_key) === (await contentHash(bytes))) return { status: res.status, id: res.id, cover: false };
  const type = CONTENT_TYPE[extname(rec.cover).toLowerCase()];
  if (!type) throw new Error(`unsupported cover type: ${rec.cover}`);
  // A new image resets the focal point on the server; send the record's proposal along with it.
  const focus = rec.cover_focus ? `?focus=${focusParam(rec.cover_focus)}` : "";
  await client.put(`/recipes/${encodeURIComponent(res.id)}/cover${focus}`, bytes, type);
  return { status: res.status === "unchanged" ? "updated" : res.status, id: res.id, cover: true };
}

async function main(): Promise<void> {
  const [base, outDir, imagesDir, ...only] = process.argv.slice(2);
  if (!base || !outDir || !imagesDir) throw new Error("usage: load-import <base url> <out dir> <images dir> [gid ...]");
  const token = process.env.RECIPES_IMPORT_TOKEN;
  if (!token) throw new Error("set RECIPES_IMPORT_TOKEN (the IMPORT_TOKEN secret of the target env)");
  const client = new Client(base, token);
  const files = readdirSync(outDir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => only.length === 0 || only.includes(f.replace(/\.json$/, "")))
    .sort();
  const counts: Record<Outcome, number> = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  for (const f of files) {
    let outcome: Outcome;
    let line: string | undefined;
    try {
      const parsed = ImportRecordSchema.safeParse(JSON.parse(readFileSync(join(outDir, f), "utf8")));
      if (!parsed.success)
        throw new Error(
          Object.entries(toFieldErrors(parsed.error.issues))
            .map(([p, m]) => `${p}: ${m}`)
            .join("; "),
        );
      const r = await loadOne(client, parsed.data, imagesDir);
      outcome = r.status;
      if (outcome !== "unchanged") line = `${outcome.padEnd(9)} ${f} -> /recipes/${r.id}${r.cover ? " (+cover)" : ""}`;
    } catch (e) {
      outcome = "failed";
      line = `failed    ${f}: ${(e as Error).message}`;
    }
    counts[outcome]++;
    if (line) console.log(line);
  }
  console.log(`\n${files.length} records: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.failed} failed`);
  if (counts.failed) process.exit(1);
}

await main();
