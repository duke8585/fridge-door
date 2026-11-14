import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImportRecord, ImportResult, Recipe, RecipeDetail, RecipeSummary } from "../../shared/schema";
import worker from "../../worker/index";
import { type AuthedInit, authedRequest, fakeD1, fakeR2, oauthBindings, type StoredObject, TEST_IMPORT_TOKEN, TEST_LOGINS, TEST_SECRET } from "./fakes";

let env: { DB: D1Database; COVERS: R2Bucket; ASSETS: Fetcher; SESSION_SECRET: string; LOGINS: unknown; IMPORT_TOKEN: string };
let objects: Map<string, StoredObject>;

beforeEach(() => {
  const { r2, objects: o } = fakeR2();
  objects = o;
  env = {
    ...oauthBindings(),
    DB: fakeD1(resolve(import.meta.dirname, "../../migrations")).d1,
    COVERS: r2,
    ASSETS: {} as Fetcher,
    SESSION_SECRET: TEST_SECRET,
    LOGINS: TEST_LOGINS,
    IMPORT_TOKEN: TEST_IMPORT_TOKEN,
  };
});

const call = async (path: string, init: AuthedInit = {}): Promise<Response> =>
  worker.fetch((await authedRequest(`https://recipes.example/api${path}`, init)) as never, env as never, {} as ExecutionContext) as Promise<Response>;
const json = (method: string, body: unknown, extra: AuthedInit = {}): AuthedInit => ({
  ...extra,
  method,
  headers: { "content-type": "application/json", ...(extra.headers as Record<string, string> | undefined) },
  body: JSON.stringify(body),
});

function record(over: Partial<ImportRecord> = {}): ImportRecord {
  return {
    source_ref: "asana:111",
    status: "full",
    section: "GOOD",
    cover: "111/222.jpeg",
    ratings: [
      { user: "alice", stars: 5 },
      { user: "bob", stars: 5 },
    ],
    comments: [
      { user: "alice", body_md: "Less salt next time.", created_at: "2025-01-02T10:00:00.000Z" },
      { user: "bob", body_md: "Lecker!", created_at: "2025-01-03T09:30:00Z" },
    ],
    recipe: {
      title: "Red lentil dal",
      yield: { amount: 4, unit: "servings" },
      time: { total_min: 45, active_min: 20 },
      sections: [{ ingredients: [{ item: "red lentils", qty: 200, unit: "g" }] }],
      steps_md: "1. Rinse.\n2. Simmer.",
      notes_md: "",
      tags: ["course:main", "cuisine:indian"],
    },
    review: [],
    ...over,
  };
}

const importRec = async (rec: unknown, ref = "asana:111") => {
  const res = await call(`/import/${ref}`, json("PUT", rec));
  return { status: res.status, body: (await res.json()) as ImportResult & { fields?: Record<string, string> } };
};
const detail = async (id: string) => (await (await call(`/recipes/${id}`)).json()) as RecipeDetail;

describe("PUT /api/import/:source_ref", () => {
  it("creates the recipe with time, source_ref, ratings and comments", async () => {
    const { status, body } = await importRec(record());
    expect(status).toBe(201);
    expect(body).toEqual({ id: "red-lentil-dal", status: "created", cover_key: null });
    const d = await detail(body.id);
    expect(d.recipe.time).toEqual({ total_min: 45, active_min: 20 });
    expect(d.recipe.source_ref).toBe("asana:111");
    expect(d.recipe.ratings).toEqual([
      { user: "alice", stars: 5 },
      { user: "bob", stars: 5 },
    ]);
    expect(d.comments.map((c) => [c.user, c.body_md, c.created_at])).toEqual([
      ["alice", "Less salt next time.", "2025-01-02T10:00:00.000Z"],
      ["bob", "Lecker!", "2025-01-03T09:30:00.000Z"],
    ]);
  });

  it("is a no-op on an identical re-run, even with keys in another order", async () => {
    const first = await importRec(record());
    const before = await detail(first.body.id);
    const { recipe, ...rest } = record();
    const reordered = { recipe: Object.fromEntries(Object.entries(recipe).reverse()), ...Object.fromEntries(Object.entries(rest).reverse()) };
    const second = await importRec(reordered);
    expect(second).toEqual({ status: 200, body: { id: first.body.id, status: "unchanged", cover_key: null } });
    expect(await detail(first.body.id)).toEqual(before);
  });

  it("replaces content on a changed record, keeping the id and not duplicating comments", async () => {
    const { body } = await importRec(record());
    const changed = record({
      comments: [
        { user: "alice", body_md: "Less salt next time!", created_at: "2025-01-02T10:00:00Z" },
        { user: "bob", body_md: "Lecker!", created_at: "2025-01-03T09:30:00.000Z" },
        { user: "bob", body_md: "Again.", created_at: "2025-02-01T08:00:00Z" },
      ],
      recipe: { ...record().recipe, title: "Red lentil dal (tadka)", time: { total_min: 50 } },
    });
    const res = await importRec(changed);
    expect(res.body).toEqual({ id: body.id, status: "updated", cover_key: null });
    const d = await detail(body.id);
    expect(d.recipe.title).toBe("Red lentil dal (tadka)");
    expect(d.recipe.time).toEqual({ total_min: 50 });
    expect(d.comments.map((c) => c.body_md)).toEqual(["Less salt next time!", "Lecker!", "Again."]);
    expect((await importRec(changed)).body.status).toBe("unchanged");
  });

  it("keeps app-only ratings, comments and edits when the record has not changed", async () => {
    const { body } = await importRec(record({ ratings: [] }));
    await call(`/recipes/${body.id}/rating`, json("PUT", { stars: 2 }, { as: "bob" }));
    await call(`/comments/c-app`, json("PUT", { recipe_id: body.id, body_md: "made it in the app" }));
    const edited = { ...record().recipe, notes_md: "Edited in the app." };
    expect((await call(`/recipes/${body.id}`, json("PUT", edited))).status).toBe(200);
    expect((await importRec(record({ ratings: [] }))).body.status).toBe("unchanged");
    const d = await detail(body.id);
    expect(d.recipe.notes_md).toBe("Edited in the app.");
    expect(d.recipe.ratings).toEqual([{ user: "bob", stars: 2 }]);
    expect(d.comments).toHaveLength(3);
  });

  it("gives a second recipe with the same title its own id", async () => {
    await importRec(record());
    const other = await importRec(record({ source_ref: "asana:999" }), "asana:999");
    expect(other.status).toBe(201);
    expect(other.body.id).toMatch(/^red-lentil-dal-[0-9a-f]{8}$/);
    const list = (await (await call("/recipes")).json()) as RecipeSummary[];
    expect(list).toHaveLength(2);
  });

  it("rejects a source_ref that does not match the URL, and invalid records", async () => {
    expect((await importRec(record(), "asana:222")).body.fields).toEqual({ source_ref: "Does not match the URL" });
    const noTime = { ...record(), recipe: { ...record().recipe, time: undefined } };
    expect((await importRec(noTime)).status).toBe(400);
  });
  it("rejects ratings and comments by someone who is not in LOGINS", async () => {
    const stranger = { ...record(), ratings: [{ user: "eve", stars: 1 }] };
    expect((await importRec(stranger)).body.fields).toEqual({ users: "Not in LOGINS: eve" });
  });
});

describe("time validation", () => {
  const recipe = record().recipe;
  const post = async (time: unknown) => {
    const res = await call("/recipes", json("POST", { ...recipe, time }));
    return { status: res.status, body: (await res.json()) as Recipe & { fields?: Record<string, string> } };
  };
  it("accepts total with optional active, and no time at all", async () => {
    expect((await post({ total_min: 30 })).body.time).toEqual({ total_min: 30 });
    expect((await post({ total_min: 30, active_min: 30 })).body.time).toEqual({ total_min: 30, active_min: 30 });
    const none = await post(undefined);
    expect(none.status).toBe(201);
    expect(none.body.time).toBeUndefined();
  });
  it("rejects active > total, non-integers and non-positive values with field paths", async () => {
    expect((await post({ total_min: 20, active_min: 30 })).body.fields).toEqual({ "time.active_min": "Active time cannot exceed total" });
    expect((await post({ total_min: 12.5 })).body.fields).toHaveProperty("time.total_min");
    expect((await post({ total_min: 0 })).body.fields).toHaveProperty("time.total_min");
    expect((await post({ active_min: 5 })).body.fields).toHaveProperty("time.total_min");
  });
  it("shows time on list summaries", async () => {
    await post({ total_min: 45, active_min: 20 });
    const [s] = (await (await call("/recipes")).json()) as RecipeSummary[];
    expect(s!.time).toEqual({ total_min: 45, active_min: 20 });
  });
});

describe("cover images", () => {
  const jpeg = (fill: number, size = 64): Uint8Array => new Uint8Array(size).fill(fill);
  const putCover = (id: string, bytes: Uint8Array, type = "image/jpeg") =>
    call(`/recipes/${id}/cover`, { method: "PUT", headers: { "content-type": type }, body: bytes });

  it("stores, serves with immutable caching, and replaces the old object", async () => {
    const { body } = await importRec(record());
    const first = (await (await putCover(body.id, jpeg(1))).json()) as Recipe;
    expect(first.cover_key).toMatch(/^covers\/red-lentil-dal\/[0-9a-f]{16}\.jpg$/);

    const got = await call(`/${first.cover_key}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect(got.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(jpeg(1));

    const same = (await (await putCover(body.id, jpeg(1))).json()) as Recipe;
    expect(same.cover_key).toBe(first.cover_key);
    expect([...objects.keys()]).toEqual([first.cover_key]);

    const next = (await (await putCover(body.id, jpeg(2), "image/png")).json()) as Recipe;
    expect(next.cover_key).toMatch(/\.png$/);
    expect([...objects.keys()]).toEqual([next.cover_key]);
    expect((await call(`/${first.cover_key}`)).status).toBe(404);
    expect((await importRec(record())).body).toEqual({ id: body.id, status: "unchanged", cover_key: next.cover_key });
  });

  it("rejects non-raster types, oversized bodies, empty bodies and unknown recipes", async () => {
    const { body } = await importRec(record());
    expect((await putCover(body.id, jpeg(1), "image/svg+xml")).status).toBe(415);
    expect((await putCover(body.id, jpeg(1), "text/plain")).status).toBe(415);
    expect((await putCover(body.id, jpeg(1, 10 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await putCover(body.id, new Uint8Array(0))).status).toBe(400);
    expect((await putCover("nope", jpeg(1))).status).toBe(404);
    expect(objects.size).toBe(0);
    expect((await call("/covers/../secrets")).status).toBe(404);
  });
});

describe("cover focus", () => {
  const patchFocus = async (id: string, cover_focus: unknown) => {
    const res = await call(`/recipes/${id}/cover-focus`, json("PATCH", { cover_focus }));
    return { status: res.status, body: (await res.json()) as Recipe & { fields?: Record<string, string> } };
  };
  const putCover = (id: string, fill: number, query = "") =>
    call(`/recipes/${id}/cover${query}`, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(64).fill(fill) });
  const summary = async (id: string) => ((await (await call("/recipes")).json()) as RecipeSummary[]).find((r) => r.id === id)!;

  it("is null until set, then shows on the recipe and the list; null resets", async () => {
    const { body } = await importRec(record());
    expect((await detail(body.id)).recipe.cover_focus).toBeNull();
    expect((await patchFocus(body.id, { x: 25.5, y: 0 })).body.cover_focus).toEqual({ x: 25.5, y: 0 });
    expect((await summary(body.id)).cover_focus).toEqual({ x: 25.5, y: 0 });
    expect((await patchFocus(body.id, null)).body.cover_focus).toBeNull();
  });

  it("is idempotent: replaying the same PATCH ends in the same state, the last write wins", async () => {
    const { body } = await importRec(record());
    await patchFocus(body.id, { x: 10, y: 90 });
    const again = await patchFocus(body.id, { x: 10, y: 90 });
    expect(again.status).toBe(200);
    expect(again.body.cover_focus).toEqual({ x: 10, y: 90 });
    await patchFocus(body.id, { x: 70, y: 30 });
    expect((await detail(body.id)).recipe.cover_focus).toEqual({ x: 70, y: 30 });
  });

  it("rejects out-of-range and malformed values, and unknown recipes", async () => {
    const { body } = await importRec(record());
    expect((await patchFocus(body.id, { x: 100.1, y: 50 })).body.fields).toEqual({ "cover_focus.x": "0-100" });
    expect((await patchFocus(body.id, { x: 50, y: -1 })).body.fields).toEqual({ "cover_focus.y": "0-100" });
    expect((await patchFocus(body.id, { x: "50", y: 50 })).status).toBe(400);
    expect((await patchFocus(body.id, { x: 50 })).status).toBe(400);
    expect((await call(`/recipes/${body.id}/cover-focus`, json("PATCH", {}))).status).toBe(400);
    expect((await patchFocus("nope", { x: 1, y: 1 })).status).toBe(404);
    expect((await patchFocus(body.id, { x: 0, y: 100 })).body.cover_focus).toEqual({ x: 0, y: 100 });
    expect((await importRec(record({ cover_focus: { x: 50, y: 150 } }))).status).toBe(400);
  });

  it("takes the importer's proposal; null and absent hash the same", async () => {
    const { body } = await importRec(record({ cover_focus: { x: 30, y: 20 } }));
    expect((await detail(body.id)).recipe.cover_focus).toEqual({ x: 30, y: 20 });
    expect((await importRec(record({ cover_focus: { x: 30, y: 20 } }))).body.status).toBe("unchanged");

    const other = (await importRec(record({ source_ref: "asana:999" }), "asana:999")).body;
    expect((await importRec({ ...record({ source_ref: "asana:999" }), cover_focus: null }, "asana:999")).body.status).toBe("unchanged");
    expect((await detail(other.id)).recipe.cover_focus).toBeNull();
  });

  it("a changed record replaces an earlier proposal", async () => {
    const { body } = await importRec(record({ cover_focus: { x: 30, y: 20 } }));
    expect((await importRec(record({ cover_focus: { x: 60, y: 60 } }))).body.status).toBe("updated");
    expect((await detail(body.id)).recipe.cover_focus).toEqual({ x: 60, y: 60 });
  });

  it("a re-import never overwrites a focus the user set, unchanged or changed record", async () => {
    const { body } = await importRec(record({ cover_focus: { x: 30, y: 20 } }));
    await patchFocus(body.id, { x: 80, y: 10 });
    expect((await importRec(record({ cover_focus: { x: 30, y: 20 } }))).body.status).toBe("unchanged");
    expect((await detail(body.id)).recipe.cover_focus).toEqual({ x: 80, y: 10 });

    const changed = record({ cover_focus: { x: 5, y: 5 }, recipe: { ...record().recipe, notes_md: "new" } });
    expect((await importRec(changed)).body.status).toBe("updated");
    const d = await detail(body.id);
    expect(d.recipe.notes_md).toBe("new");
    expect(d.recipe.cover_focus).toEqual({ x: 80, y: 10 });

    await patchFocus(body.id, null);
    expect((await importRec(record({ cover_focus: { x: 1, y: 1 } }))).body.status).toBe("updated");
    expect((await detail(body.id)).recipe.cover_focus).toBeNull();
  });

  it("a new cover image resets the focus (to ?focus= when given); the same bytes keep it", async () => {
    const { body } = await importRec(record());
    expect((await putCover(body.id, 1, "?focus=30,20")).status).toBe(200);
    expect((await detail(body.id)).recipe.cover_focus).toEqual({ x: 30, y: 20 });
    await patchFocus(body.id, { x: 90, y: 90 });
    await putCover(body.id, 1);
    expect((await detail(body.id)).recipe.cover_focus).toEqual({ x: 90, y: 90 });
    await putCover(body.id, 2);
    expect((await detail(body.id)).recipe.cover_focus).toBeNull();
    expect((await putCover(body.id, 3, "?focus=101,0")).status).toBe(400);
    expect((await putCover(body.id, 3, "?focus=abc")).status).toBe(400);
  });

  it("a new cover with ?focus= is a proposal a later changed import may replace", async () => {
    const { body } = await importRec(record());
    await putCover(body.id, 1, "?focus=30,20");
    await importRec(record({ cover_focus: { x: 40, y: 40 } }));
    expect((await detail(body.id)).recipe.cover_focus).toEqual({ x: 40, y: 40 });
  });
});
