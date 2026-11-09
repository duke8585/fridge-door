import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import worker from "../../worker/index";
import type { Recipe, RecipeInput } from "../../shared/schema";
import type { Revision, RevisionListItem } from "../../shared/revisions";
import { LEGACY_TAGS, upgradeTags } from "../../shared/tags";
import { TEST_SECRET, authedRequest, fakeD1, fakeR2, oauthBindings, type AuthedInit } from "./fakes";

const MIGRATIONS = resolve(import.meta.dirname, "../../migrations");
const MIGRATION = "0006_tag_groups.sql";
const sql = readFileSync(resolve(MIGRATIONS, MIGRATION), "utf8");

let env: { DB: D1Database; COVERS: R2Bucket; ASSETS: Fetcher; SESSION_SECRET: string };
let sqlite: DatabaseSync;

beforeEach(() => {
  const db = fakeD1(MIGRATIONS, { before: MIGRATION });
  sqlite = db.sqlite;
  env = { ...oauthBindings(), DB: db.d1, COVERS: fakeR2().r2, ASSETS: {} as Fetcher, SESSION_SECRET: TEST_SECRET };
});

const call = async <T>(path: string, init: AuthedInit = {}): Promise<{ status: number; body: T }> => {
  const res = (await worker.fetch((await authedRequest(`https://recipes.example/api${path}`, init)) as never, env as never, {} as ExecutionContext)) as Response;
  return { status: res.status, body: (await res.json()) as T };
};
const json = (method: string, body: unknown): AuthedInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const OLD_AT = "2026-11-01T08:00:00.000Z";
function row(id: string, tags: string[]): void {
  sqlite
    .prepare(
      `INSERT INTO recipes (id, title, sections_json, steps_md, notes_md, tags_json, created_at, updated_at)
       VALUES (?, ?, '[{"ingredients":[{"item":"flour","qty":200,"unit":"g"}]}]', '1. Mix.', '', ?, ?, ?)`,
    )
    .run(id, `Recipe ${id}`, JSON.stringify(tags), OLD_AT, OLD_AT);
}
/** A revision row as an earlier build wrote it, built with the same SQL the Worker uses. */
function revisionFromRow(id: string, source: string, author: string | null, at: string): void {
  sqlite
    .prepare(
      `INSERT INTO recipe_revisions (recipe_id, snapshot, author, source, created_at)
       SELECT id, json_object('title', title,
         'yield', json(CASE WHEN yield_amount IS NULL THEN NULL ELSE json_object('amount', yield_amount, 'unit', yield_unit) END),
         'time', json(CASE WHEN time_total_min IS NULL THEN NULL ELSE json_object('total_min', time_total_min, 'active_min', time_active_min) END),
         'sections', json(sections_json), 'steps_md', steps_md, 'notes_md', notes_md, 'source_url', source_url, 'tags', json(tags_json)),
         ?, ?, ? FROM recipes WHERE id = ?`,
    )
    .run(author, source, at, id);
}
const tagsOf = (id: string): string[] => JSON.parse((sqlite.prepare("SELECT tags_json FROM recipes WHERE id = ?").get(id) as { tags_json: string }).tags_json);
const revisions = async (id: string) => (await call<RevisionListItem[]>(`/recipes/${id}/revisions`)).body;
const brief = (list: RevisionListItem[]) => list.map((r) => [r.source, r.author, r.changes]);

describe("migration 0006 (tag groups)", () => {
  it("carries exactly LEGACY_TAGS from shared/tags.ts", () => {
    const pairs = Object.fromEntries([...sql.matchAll(/^\s+\('([^']+)', '([^']+)'\)[,;]$/gm)].map((m) => [m[1], m[2]]));
    expect(pairs).toEqual(LEGACY_TAGS);
  });

  it("maps every kind of old tag as upgradeTags does, keeps order, drops a duplicate it creates, and records baseline + migration", async () => {
    const old = ["main", "oven", "next-up", "stub", "needs-method", "friends", "birthday", "vegan", "indian"];
    row("a", old);
    row("b", ["breakfast", "course:breakfast"]);
    row("c", ["course:main", "list:next-up"]);
    sqlite.exec(sql);

    expect(tagsOf("a")).toEqual(["course:main", "method:oven", "list:next-up", "status:stub", "todo:method", "list:friends", "list:birthday", "diet:vegan", "cuisine:indian"]);
    expect(tagsOf("a")).toEqual(upgradeTags(old));
    expect(tagsOf("b")).toEqual(["course:breakfast"]);
    expect(tagsOf("c")).toEqual(["course:main", "list:next-up"]);

    const a = await revisions("a");
    expect(brief(a).map(([source, author]) => [source, author])).toEqual([
      ["migration", null],
      ["baseline", null],
    ]);
    expect(a[0]!.changes[0]).toMatch(/^tags \+course:main .* -main /);
    expect(a[1]!.created_at).toBe(OLD_AT);
    expect((await call<{ recipe: Recipe }>("/recipes/a")).body.recipe.updated_at).toBe(OLD_AT);
    expect(a[0]!.created_at > OLD_AT).toBe(true);
    expect(await revisions("c")).toEqual([]);
  });

  it("adds one migration revision on top of existing history", async () => {
    row("h", ["soup"]);
    revisionFromRow("h", "editor", "max", OLD_AT);
    sqlite.exec(sql);
    expect(brief(await revisions("h"))).toEqual([
      ["migration", null, ["tags +course:soup -soup"]],
      ["editor", "max", []],
    ]);
  });

  it("writes snapshots the Worker's own writes compare equal to (a no-op save records nothing)", async () => {
    row("n", ["main"]);
    sqlite.exec(sql);
    const before = (await revisions("n")).length;
    const r = (await call<{ recipe: Recipe }>("/recipes/n")).body.recipe;
    const input: RecipeInput = { title: r.title, sections: r.sections, steps_md: r.steps_md, notes_md: r.notes_md, tags: r.tags };
    expect((await call(`/recipes/n`, json("PUT", input))).status).toBe(200);
    expect(await revisions("n")).toHaveLength(before);
  });

  it("stops before writing anything when a loose tag is neither mapped nor a kebab word", () => {
    row("ok", ["main"]);
    row("x", ["main", "Quick dinner"]);
    expect(() => sqlite.exec(sql)).toThrow(/unknown_tag_see_0006/);
    expect(tagsOf("ok")).toEqual(["main"]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM recipe_revisions").get()).toEqual({ n: 0 });
  });
});

describe("restoring a snapshot from before the tag groups", () => {
  it("maps its tags and drops loose ones", async () => {
    row("r", ["main", "quick_old", "vegan"]);
    revisionFromRow("r", "editor", "max", OLD_AT);
    sqlite.prepare(`UPDATE recipes SET tags_json = '["main"]' WHERE id = 'r'`).run();
    sqlite.exec(sql);
    const list = await revisions("r");
    const old = list.at(-1)!;
    expect((await call<Revision>(`/recipes/r/revisions/${old.id}`)).body.snapshot.tags).toEqual(["main", "quick_old", "vegan"]);

    const res = await call<Recipe>(`/recipes/r/revisions/${old.id}/restore`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(["course:main", "diet:vegan"]);
    expect(brief(await revisions("r"))[0]).toEqual(["restore", "max", ["tags +diet:vegan"]]);
  });
});

describe("tag edits queued by an old build", () => {
  it("map legacy names on the server and reject a tag that cannot be upgraded", async () => {
    row("t", ["main"]);
    sqlite.exec(sql);
    const res = await call<Recipe>("/recipes/t/tags", json("PATCH", { add: ["vegan", "next-up"], remove: ["main"] }));
    expect(res.status).toBe(200);
    expect(tagsOf("t")).toEqual(["diet:vegan", "list:next-up"]);
    const loose = await call<{ fields: Record<string, string> }>("/recipes/t/tags", json("PATCH", { add: ["quick dinner"] }));
    expect(loose.status).toBe(400);
    expect(loose.body.fields["add.0"]).toMatch(/has no group/);
  });
});
