import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Recipe, RecipeInput, RecipeSummary } from "../../shared/schema";
import { COVER_MODEL } from "../../worker/coverGen";
import worker from "../../worker/index";
import {
  type AuthedInit,
  authedRequest,
  fakeD1,
  fakeR2,
  oauthBindings,
  type StoredObject,
  TEST_IMPORT_TOKEN,
  TEST_LOGINS,
  TEST_ORIGIN,
  TEST_SECRET,
} from "./fakes";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

let env: Record<string, unknown>;
let sqlite: DatabaseSync;
let objects: Map<string, StoredObject>;
let run: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const db = fakeD1(resolve(import.meta.dirname, "../../migrations"));
  sqlite = db.sqlite;
  const r2 = fakeR2();
  objects = r2.objects;
  run = vi.fn(async () => ({ image: b64(JPEG) }));
  env = {
    ...oauthBindings(),
    DB: db.d1,
    COVERS: r2.r2,
    ASSETS: {} as Fetcher,
    SESSION_SECRET: TEST_SECRET,
    IMPORT_TOKEN: TEST_IMPORT_TOKEN,
    LOGINS: TEST_LOGINS,
    AI: { run },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const ctx = (): ExecutionContext => ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;
const call = async (path: string, init: AuthedInit = {}): Promise<Response> =>
  (await worker.fetch((await authedRequest(`${TEST_ORIGIN}${path}`, init)) as never, env as never, ctx())) as Response;
const json = (method: string, body: unknown): AuthedInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const generate = (id: string, init: AuthedInit = {}) => call(`/api/recipes/${id}/cover/generate`, { method: "PUT", ...init });
const upload = (id: string, bytes: Uint8Array) => call(`/api/recipes/${id}/cover`, { method: "PUT", headers: { "content-type": "image/png" }, body: bytes });

const dal: RecipeInput = {
  title: "Red lentil dal",
  sections: [{ ingredients: [{ item: "red lentils" }, { item: "salt" }] }],
  steps_md: "1. Simmer the lentils.\n2. Serve with rice.",
  notes_md: "",
  tags: ["course:main"],
};

async function createDal(): Promise<string> {
  const res = await call("/api/recipes", json("POST", dal));
  expect(res.status).toBe(201);
  return ((await res.json()) as Recipe).id;
}
const detail = async (id: string): Promise<Recipe> => ((await (await call(`/api/recipes/${id}`)).json()) as { recipe: Recipe }).recipe;
const summary = async (id: string): Promise<RecipeSummary> => ((await (await call("/api/recipes")).json()) as RecipeSummary[]).find((r) => r.id === id)!;

describe("PUT /api/recipes/:id/cover/generate", () => {
  it("generates a jpeg cover from the recipe's prompt and marks it AI in the detail and the summary", async () => {
    const id = await createDal();
    const res = await generate(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "generated" });
    expect(run).toHaveBeenCalledOnce();
    const [model, input] = run.mock.calls[0]!;
    expect(model).toBe(COVER_MODEL);
    expect(input).toMatchObject({
      steps: 8,
      prompt: expect.stringContaining('finished dish "Red lentil dal". Ingredients: red lentils, salt. How it is served: Serve with rice.'),
    });

    const recipe = await detail(id);
    expect(recipe.cover_key).toMatch(new RegExp(`^covers/${id}/[0-9a-f]{16}\\.jpg$`));
    expect(recipe.cover_ai).toBe(true);
    expect(await summary(id)).toMatchObject({ cover_key: recipe.cover_key, cover_ai: true });
    expect(objects.get(recipe.cover_key!)).toEqual({ bytes: JPEG, contentType: "image/jpeg" });
  });

  it("skips a recipe that has a cover, without calling the model", async () => {
    const id = await createDal();
    await upload(id, PNG);
    expect(await (await generate(id)).json()).toEqual({ status: "skipped", reason: "has_cover" });
    expect(run).not.toHaveBeenCalled();
    expect((await detail(id)).cover_ai).toBe(false);
  });

  it("answers unavailable, without failing, when there is no AI binding or the model fails", async () => {
    const id = await createDal();
    delete env.AI;
    const none = await generate(id);
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ status: "unavailable", reason: "no_ai_binding" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no AI binding"));

    env.AI = { run: async () => Promise.reject(new Error("capacity")) };
    expect(await (await generate(id)).json()).toEqual({ status: "unavailable", reason: "model_error" });
    env.AI = { run: async () => ({}) };
    expect(await (await generate(id)).json()).toEqual({ status: "unavailable", reason: "no_image" });
    expect((await detail(id)).cover_key).toBeUndefined();
    expect(objects.size).toBe(0);
  });

  it("404s an unknown recipe", async () => {
    expect((await generate("nope")).status).toBe(404);
  });

  it("keeps a cover set while the image was being generated, and drops the generated one", async () => {
    const id = await createDal();
    run.mockImplementationOnce(async () => {
      await upload(id, PNG);
      return { image: b64(JPEG) };
    });
    expect(await (await generate(id)).json()).toEqual({ status: "skipped", reason: "cover_changed" });
    const recipe = await detail(id);
    expect(recipe).toMatchObject({ cover_key: expect.stringMatching(/\.png$/), cover_ai: false });
    expect([...objects.keys()]).toEqual([recipe.cover_key]);
  });

  it("records no revision: covers are not content", async () => {
    const id = await createDal();
    const before = sqlite.prepare("SELECT COUNT(*) AS n FROM recipe_revisions").get();
    await generate(id);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM recipe_revisions").get()).toEqual(before);
  });
});

describe("cover_ai", () => {
  it("stays through a focus change and resets when a new image replaces the generated one", async () => {
    const id = await createDal();
    await generate(id);
    const focus = await call(`/api/recipes/${id}/cover-focus`, json("PATCH", { cover_focus: { x: 20, y: 30 } }));
    expect(((await focus.json()) as Recipe).cover_ai).toBe(true);

    const generated = (await detail(id)).cover_key!;
    await upload(id, PNG);
    const recipe = await detail(id);
    expect(recipe).toMatchObject({ cover_key: expect.stringMatching(/\.png$/), cover_ai: false });
    expect(objects.has(generated)).toBe(false);
  });

  it("is false for a recipe that never had a generated cover", async () => {
    const id = await createDal();
    expect((await detail(id)).cover_ai).toBe(false);
    expect((await summary(id)).cover_ai).toBe(false);
  });
});

describe("who may generate", () => {
  const bearer = (token = TEST_IMPORT_TOKEN): AuthedInit => ({ as: null, headers: { authorization: `Bearer ${token}` } });

  it("accepts a session and the import token on exactly this route", async () => {
    const id = await createDal();
    expect((await generate(id, { as: "bob" })).status).toBe(200);
    const other = await createDal();
    const res = await generate(other, bearer());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "generated" });
  });

  it("rejects a wrong token, another method and look-alike paths", async () => {
    const id = await createDal();
    expect((await generate(id, bearer("nope"))).status).toBe(401);
    expect((await call(`/api/recipes/${id}/cover/generate`, { method: "POST", ...bearer() })).status).toBe(401);
    expect((await call(`/api/recipes/${id}/cover/generated`, { method: "PUT", ...bearer() })).status).toBe(401);
    expect((await call(`/api/recipes/${id}/cover/generate/x`, { method: "PUT", ...bearer() })).status).toBe(401);
    expect((await call(`/api/recipes/a/b/cover/generate`, { method: "PUT", ...bearer() })).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("an editor create does not generate a cover", async () => {
    const waits: Promise<unknown>[] = [];
    const req = await authedRequest(`${TEST_ORIGIN}/api/recipes`, json("POST", dal));
    const res = (await worker.fetch(req as never, env as never, { ...ctx(), waitUntil: (p: Promise<unknown>) => waits.push(p) } as never)) as Response;
    expect(res.status).toBe(201);
    await Promise.all(waits);
    expect(run).not.toHaveBeenCalled();
  });
});
