import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import worker from "../../worker/index";
import type { Bookmark, Recipe, RecipeSummary, User } from "../../shared/schema";
import { TEST_SECRET, authedRequest, fakeD1, fakeR2, oauthBindings, type AuthedInit } from "./fakes";

let env: { DB: D1Database; COVERS: R2Bucket; ASSETS: Fetcher; SESSION_SECRET: string };
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
  env = { ...oauthBindings(), DB: db.d1, COVERS: fakeR2().r2, ASSETS: {} as Fetcher, SESSION_SECRET: TEST_SECRET };
});
afterEach(() => {
  vi.useRealTimers();
});

const call = async <T>(path: string, init: AuthedInit = {}): Promise<{ status: number; body: T }> => {
  const res = (await worker.fetch((await authedRequest(`https://recipes.example/api${path}`, init)) as never, env as never, {} as ExecutionContext)) as Response;
  return { status: res.status, body: (await res.json()) as T };
};
const send = (method: string, body: unknown, as: User = "max"): AuthedInit => ({
  method,
  as,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const bookmark = (id: string, on: boolean, as: User = "max") => call<Recipe>(`/recipes/${id}/bookmark`, send("PUT", { on }, as));
const listed = async (id: string): Promise<Bookmark[]> => (await call<RecipeSummary[]>("/recipes")).body.find((r) => r.id === id)!.bookmarks;
const updatedAt = async (id: string): Promise<string> => (await call<{ recipe: Recipe }>(`/recipes/${id}`)).body.recipe.updated_at;

const dal = { title: "Dal", sections: [{ ingredients: [] }], steps_md: "", notes_md: "", tags: [] };

describe("PUT /recipes/:id/bookmark", () => {
  beforeEach(async () => {
    await call("/recipes", send("POST", dal));
  });

  it("is per person, shown in the recipe and the list, and removed on off", async () => {
    at(1);
    expect((await bookmark("dal", true, "max")).body.bookmarks).toEqual([{ user: "max", at: "2026-11-08T10:01:00.000Z" }]);
    at(2);
    await bookmark("dal", true, "nadine");
    expect(await listed("dal")).toEqual([
      { user: "max", at: "2026-11-08T10:01:00.000Z" },
      { user: "nadine", at: "2026-11-08T10:02:00.000Z" },
    ]);
    expect((await bookmark("dal", false, "max")).body.bookmarks.map((b) => b.user)).toEqual(["nadine"]);
  });

  it("is idempotent and keeps the first created_at", async () => {
    at(1);
    await bookmark("dal", true);
    at(5);
    expect((await bookmark("dal", true)).body.bookmarks).toEqual([{ user: "max", at: "2026-11-08T10:01:00.000Z" }]);
    await bookmark("dal", false);
    expect((await bookmark("dal", false)).status).toBe(200);
    expect(await listed("dal")).toEqual([]);
  });

  it("is not a content edit: no revision, updated_at unchanged", async () => {
    const before = await updatedAt("dal");
    const revs = sqlite.prepare("SELECT COUNT(*) AS n FROM recipe_revisions").get();
    at(30);
    await bookmark("dal", true);
    await bookmark("dal", false);
    expect(await updatedAt("dal")).toBe(before);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM recipe_revisions").get()).toEqual(revs);
  });

  it("answers 404 for an unknown recipe and 400 for a bad body", async () => {
    expect((await bookmark("nope", true)).status).toBe(404);
    expect((await call("/recipes/dal/bookmark", send("PUT", { on: "yes" }))).status).toBe(400);
  });

  it("goes away with the recipe", async () => {
    await bookmark("dal", true);
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.prepare("DELETE FROM recipes WHERE id = 'dal'").run();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM bookmarks").get()).toEqual({ n: 0 });
  });
});
