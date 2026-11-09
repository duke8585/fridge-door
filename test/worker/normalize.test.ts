import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vocabularyLines } from "../../shared/tags";

const guide = readFileSync(resolve(import.meta.dirname, "../../import/NORMALIZE.md"), "utf8");

describe("import/NORMALIZE.md", () => {
  it("lists exactly the tag groups of shared/tags.ts (paste the expected lines between the markers)", () => {
    const block = guide.match(/<!-- generated from TAG_GROUPS[^\n]*-->\n([\s\S]*?)\n<!-- end generated -->/);
    expect(block?.[1]?.split("\n")).toEqual(vocabularyLines());
  });
});
