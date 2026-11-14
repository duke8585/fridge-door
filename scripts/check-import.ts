/**
 * Checks normalizer output against import/NORMALIZE.md.
 * Usage: npm run check-import -- <dir with <gid>.json files> [gid ...]
 * Exit 1 if any file fails. Prints one line per file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lintRecipe } from "../shared/lint";
import { ImportRecordSchema, toFieldErrors } from "../shared/schema";

const LlmRecordSchema = ImportRecordSchema.pick({ recipe: true, review: true });

function main(): void {
  const [dir, ...only] = process.argv.slice(2);
  if (!dir) throw new Error("usage: check-import <dir> [gid ...]");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => only.length === 0 || only.includes(f.replace(/\.json$/, "")));
  let failed = 0;
  for (const f of files) {
    let problems: string[];
    try {
      const parsed = LlmRecordSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      problems = parsed.success ? lintRecipe(parsed.data) : Object.entries(toFieldErrors(parsed.error.issues)).map(([p, m]) => `${p}: ${m}`);
    } catch (e) {
      problems = [`unreadable: ${(e as Error).message}`];
    }
    if (problems.length) failed++;
    console.log(`${problems.length ? "FAIL" : "ok  "} ${f}${problems.length ? `\n  - ${problems.join("\n  - ")}` : ""}`);
  }
  console.log(`\n${files.length - failed}/${files.length} passed`);
  if (failed) process.exit(1);
}

main();
