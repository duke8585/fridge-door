import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SectionSchema } from "../../shared/schema";
import { tagProblem } from "../../shared/tags";
import { fakeD1 } from "./fakes";

describe("demo seed", () => {
  const { sqlite } = fakeD1(resolve(import.meta.dirname, "../../migrations"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(readFileSync(resolve(import.meta.dirname, "../../seed/seed.sql"), "utf8"));
  const rows = sqlite.prepare("SELECT id, sections_json, tags_json FROM recipes").all() as { id: string; sections_json: string; tags_json: string }[];

  // INSERT OR IGNORE drops a row that breaks a constraint without an error, so count them.
  it("loads every recipe on the current schema", () => {
    expect(rows.length).toBe(10);
  });

  it("has valid sections and only tags of the scheme", () => {
    for (const r of rows) {
      expect(() => z.array(SectionSchema).parse(JSON.parse(r.sections_json)), r.id).not.toThrow();
      for (const tag of JSON.parse(r.tags_json) as string[]) expect(tagProblem(tag), r.id).toBeNull();
    }
  });
});
