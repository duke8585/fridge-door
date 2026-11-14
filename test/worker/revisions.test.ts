import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentOf, type Revision, type RevisionListItem } from "../../shared/revisions";
import type { ImportRecord, Recipe, RecipeInput, User } from "../../shared/schema";
import worker from "../../worker/index";
import { type AuthedInit, authedRequest, fakeD1, fakeR2, oauthBindings, TEST_LOGINS, TEST_SECRET } from "./fakes";

let env: { DB: D1Database; COVERS: R2Bucket; ASSETS: Fetcher; SESSION_SECRET: string; LOGINS: unknown };
let sqlite: DatabaseSync;
const T0 = new Date("2026-11-08T10:00:00.000Z").getTime();
const at = (min: number): void => {
  vi.setSystemTime(T0 + min * 60_000);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  const db = fakeD1(resolve(import.meta.dirname, "../../migrations"));
  sqlite = db.sqlite;
  env = { ...oauthBindings(), DB: db.d1, COVERS: fakeR2().r2, ASSETS: {} as Fetcher, SESSION_SECRET: TEST_SECRET, LOGINS: TEST_LOGINS };
});
afterEach(() => {
  vi.useRealTimers();
});

const call = async <T>(path: string, init: AuthedInit = {}): Promise<{ status: number; body: T }> => {
  const res = (await worker.fetch(
    (await authedRequest(`https://recipes.example/api${path}`, init)) as never,
    env as never,
    {} as ExecutionContext,
  )) as Response;
  return { status: res.status, body: (await res.json()) as T };
};
const send = (method: string, body: unknown, as: User = "alice"): AuthedInit => ({
  method,
  as,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const revisions = async (id: string) => (await call<RevisionListItem[]>(`/recipes/${id}/revisions`)).body;
const revision = async (id: string, rev: number) => (await call<Revision>(`/recipes/${id}/revisions/${rev}`)).body;
const recipe = async (id: string) => (await call<{ recipe: Recipe }>(`/recipes/${id}`)).body.recipe;
const brief = (list: RevisionListItem[]) => list.map((r) => [r.source, r.author, r.changes]);

const dal: RecipeInput = {
  title: "Red lentil dal",
  yield: { amount: 4, unit: "servings" },
  time: { total_min: 45 },
  sections: [{ ingredients: [{ item: "red lentils", qty: 200, unit: "g" }, { item: "salt" }] }],
  steps_md: "1. Rinse.\n2. Simmer.",
  notes_md: "",
  tags: ["course:main"],
};

/** A recipe as the seed (or a pre-0004 import) left it: a row with no revisions yet. */
function seedRow(id = "pancakes"): void {
  sqlite
    .prepare(
      `INSERT INTO recipes (id, title, yield_amount, yield_unit, sections_json, steps_md, notes_md, source_url, tags_json, created_at, updated_at)
       VALUES (?, 'Fluffy pancakes', 4, 'servings', '[{"ingredients":[{"item":"flour","qty":200,"unit":"g"}]}]', '1. Mix.', '', NULL, '["course:breakfast"]',
               '2026-11-01T08:00:00.000Z', '2026-11-01T08:00:00.000Z')`,
    )
    .run(id);
}
const pancakes: RecipeInput = {
  title: "Fluffy pancakes",
  yield: { amount: 4, unit: "servings" },
  sections: [{ ingredients: [{ item: "flour", qty: 200, unit: "g" }] }],
  steps_md: "1. Mix.",
  notes_md: "",
  tags: ["course:breakfast"],
};

describe("revisions on editor saves", () => {
  it("records the created content, then each change with author and a summary", async () => {
    const { body: created } = await call<Recipe>("/recipes", send("POST", dal));
    at(1);
    await call(`/recipes/${created.id}`, send("PUT", { ...dal, title: "Dal tadka", tags: ["course:main", "diet:vegan"] }, "bob"));
    const list = await revisions(created.id);
    expect(brief(list)).toEqual([
      ["editor", "bob", ["title", "tags +diet:vegan"]],
      ["editor", "alice", []],
    ]);
    expect(list[0]!.created_at).toBe("2026-11-08T10:01:00.000Z");
    expect((await revision(created.id, list[0]!.id)).snapshot).toEqual({ ...dal, title: "Dal tadka", tags: ["course:main", "diet:vegan"] });
  });

  it("records nothing for a save that changes nothing", async () => {
    const { body: created } = await call<Recipe>("/recipes", send("POST", dal));
    await call(`/recipes/${created.id}`, send("PUT", dal));
    await call(`/recipes/${created.id}/tags`, send("PATCH", { add: ["course:main"] }));
    expect(await revisions(created.id)).toHaveLength(1);
  });

  it("does not version ratings, comments or the cover focus", async () => {
    const { body: created } = await call<Recipe>("/recipes", send("POST", dal));
    await call(`/recipes/${created.id}/rating`, send("PUT", { stars: 4 }));
    await call(`/recipes/${created.id}/cover-focus`, send("PATCH", { cover_focus: { x: 10, y: 10 } }));
    await call("/comments/c1", send("PUT", { recipe_id: created.id, body_md: "yum" }));
    expect(await revisions(created.id)).toHaveLength(1);
  });
});

describe("baseline backfill", () => {
  it("the first change of a recipe without history records its prior content first", async () => {
    seedRow();
    expect(await revisions("pancakes")).toEqual([]);
    at(5);
    await call("/recipes/pancakes", send("PUT", { ...pancakes, steps_md: "1. Mix.\n2. Fry." }));
    const list = await revisions("pancakes");
    expect(brief(list)).toEqual([
      ["editor", "alice", ["steps"]],
      ["baseline", null, []],
    ]);
    expect(list[1]!.created_at).toBe("2026-11-01T08:00:00.000Z");
    expect((await revision("pancakes", list[1]!.id)).snapshot).toEqual(pancakes);
  });

  it("a no-op write on a recipe without history records nothing, not even a baseline", async () => {
    seedRow();
    await call("/recipes/pancakes", send("PUT", pancakes));
    expect(await revisions("pancakes")).toEqual([]);
  });

  it("a tag change is a first change too", async () => {
    seedRow();
    await call("/recipes/pancakes/tags", send("PATCH", { add: ["course:dessert"] }, "bob"));
    expect(brief(await revisions("pancakes"))).toEqual([
      ["tags", "bob", ["tags +course:dessert"]],
      ["baseline", null, []],
    ]);
  });
});

describe("tag revisions coalesce per user for 10 minutes", () => {
  beforeEach(() => seedRow());
  const tag = (delta: { add?: string[]; remove?: string[] }, user: User = "alice") => call("/recipes/pancakes/tags", send("PATCH", delta, user));

  it("folds the same user's tag edits into their latest tags revision", async () => {
    await tag({ add: ["course:dessert"] });
    at(4);
    await tag({ add: ["list:quick"] });
    at(9);
    await tag({ remove: ["course:breakfast"] });
    const list = await revisions("pancakes");
    expect(brief(list)).toEqual([
      ["tags", "alice", ["tags +course:dessert +list:quick -course:breakfast"]],
      ["baseline", null, []],
    ]);
    expect(list[0]!.created_at).toBe("2026-11-08T10:09:00.000Z");
  });

  it("starts a new revision after 10 minutes, for another user, or after another kind of change", async () => {
    await tag({ add: ["list:a"] });
    at(11);
    await tag({ add: ["list:b"] });
    at(12);
    await tag({ add: ["list:c"] }, "bob");
    at(13);
    await tag({ add: ["list:d"] });
    at(14);
    await call("/recipes/pancakes", send("PUT", { ...pancakes, title: "Pancakes", tags: ["course:breakfast", "list:a", "list:b", "list:c", "list:d"] }));
    at(15);
    await tag({ add: ["list:e"] });
    expect(brief(await revisions("pancakes"))).toEqual([
      ["tags", "alice", ["tags +list:e"]],
      ["editor", "alice", ["title"]],
      ["tags", "alice", ["tags +list:d"]],
      ["tags", "bob", ["tags +list:c"]],
      ["tags", "alice", ["tags +list:b"]],
      ["tags", "alice", ["tags +list:a"]],
      ["baseline", null, []],
    ]);
  });

  it("an add undone within the window leaves no revision behind", async () => {
    await tag({ add: ["list:oops"] });
    at(1);
    await tag({ remove: ["list:oops"] });
    expect(await revisions("pancakes")).toEqual([]);
  });
});

describe("revisions on import", () => {
  const rec = (over: Partial<RecipeInput> = {}, extra: Partial<ImportRecord> = {}): ImportRecord => ({
    source_ref: "asana:1",
    status: "full",
    section: null,
    cover: null,
    ratings: [],
    comments: [],
    recipe: { ...dal, time: { total_min: 45 }, ...over },
    review: [],
    ...extra,
  });
  const put = (r: ImportRecord) => call<{ id: string }>("/import/asana:1", send("PUT", r));

  it("records created and updated, nothing for unchanged or ratings-only records", async () => {
    const { body } = await put(rec());
    await put(rec());
    await put(rec({}, { ratings: [{ user: "alice", stars: 5 }] }));
    at(1);
    await put(rec({ notes_md: "Better the next day." }, { ratings: [{ user: "alice", stars: 5 }] }));
    expect(brief(await revisions(body.id))).toEqual([
      ["import", "alice", ["notes"]],
      ["import", "alice", []],
    ]);
  });

  it("an already-imported recipe gets its pre-import content as baseline", async () => {
    seedRow();
    sqlite.prepare("UPDATE recipes SET source_ref = 'asana:1', import_hash = 'old' WHERE id = 'pancakes'").run();
    await put(rec({ title: "Fluffy pancakes" }));
    expect(brief(await revisions("pancakes")).map(([s]) => s)).toEqual(["import", "baseline"]);
  });
});

describe("restore", () => {
  it("writes the old content and tags back as a 'restore' revision, keeping ratings", async () => {
    seedRow();
    await call("/recipes/pancakes/rating", send("PUT", { stars: 5 }));
    at(1);
    await call(
      "/recipes/pancakes",
      send("PUT", { ...pancakes, title: "Ruined", sections: [{ ingredients: [{ item: "sand", qty: 1, unit: "kg" }] }], tags: [] }),
    );
    const baseline = (await revisions("pancakes")).at(-1)!;
    at(2);
    const res = await call<Recipe>(`/recipes/pancakes/revisions/${baseline.id}/restore`, send("POST", {}, "bob"));
    expect(res.status).toBe(200);
    const withBase = { ...pancakes, sections: [{ ingredients: [{ item: "flour", qty: 200, unit: "g" as const, base: "flour" }] }] };
    expect(contentOf(res.body)).toEqual(contentOf({ ...withBase, yield: { amount: 4, unit: "servings" } }));
    expect(contentOf(await recipe("pancakes"))).toEqual(contentOf(withBase));
    expect((await recipe("pancakes")).ratings).toEqual([{ user: "alice", stars: 5 }]);
    expect(brief(await revisions("pancakes"))).toEqual([
      ["restore", "bob", ["title", "tags +course:breakfast", "ingredients +1 -1"]],
      ["editor", "alice", ["title", "tags -course:breakfast", "ingredients +1 -1"]],
      ["baseline", null, []],
    ]);
  });

  it("is idempotent: restoring the current version again records nothing", async () => {
    seedRow();
    await call("/recipes/pancakes", send("PUT", { ...pancakes, title: "Ruined" }));
    const baseline = (await revisions("pancakes")).at(-1)!;
    await call(`/recipes/pancakes/revisions/${baseline.id}/restore`, send("POST", {}));
    const again = await call<Recipe>(`/recipes/pancakes/revisions/${baseline.id}/restore`, send("POST", {}));
    expect(again.status).toBe(200);
    expect(again.body.title).toBe("Fluffy pancakes");
    expect(await revisions("pancakes")).toHaveLength(3);
  });

  it("404s for unknown recipes, revisions of another recipe and malformed ids", async () => {
    seedRow();
    seedRow("other");
    await call("/recipes/other", send("PUT", { ...pancakes, title: "Other" }));
    const foreign = (await revisions("other"))[0]!.id;
    expect((await call(`/recipes/pancakes/revisions/${foreign}`)).status).toBe(404);
    expect((await call(`/recipes/pancakes/revisions/${foreign}/restore`, send("POST", {}))).status).toBe(404);
    expect((await call("/recipes/pancakes/revisions/abc")).status).toBe(404);
    expect((await call("/recipes/nope/revisions")).status).toBe(404);
    expect((await recipe("pancakes")).title).toBe("Fluffy pancakes");
  });
});
