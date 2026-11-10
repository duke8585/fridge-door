import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import worker, { mcpApi } from "../../worker/index";
import * as repo from "../../worker/repo";
import type { RecipeInput, User } from "../../shared/schema";
import { b64url } from "../../worker/session";
import { TEST_ORIGIN, TEST_SECRET, authedRequest, fakeD1, fakeR2, oauthBindings, type AuthedInit, type StoredObject } from "./fakes";

let env: Record<string, unknown>;
let sqlite: DatabaseSync;
let objects: Map<string, StoredObject>;

beforeEach(() => {
  const db = fakeD1(resolve(import.meta.dirname, "../../migrations"));
  sqlite = db.sqlite;
  const r2 = fakeR2();
  objects = r2.objects;
  env = { ...oauthBindings(), DB: db.d1, COVERS: r2.r2, ASSETS: {} as Fetcher, SESSION_SECRET: TEST_SECRET };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = (): ExecutionContext => ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;
const call = async (path: string, init: AuthedInit = {}): Promise<Response> =>
  (await worker.fetch((await authedRequest(`${TEST_ORIGIN}${path}`, init)) as never, env as never, ctx())) as Response;

const REDIRECT = "https://client.example/callback";

/** Set-Cookie headers of a response as a Cookie header (name=value pairs). */
const cookiesOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function register(name = "Claude"): Promise<string> {
  const res = await call("/register", {
    as: null,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: name, token_endpoint_auth_method: "none" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}

const authorizePath = (clientId: string, challenge: string): string =>
  `/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "st-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${TEST_ORIGIN}/mcp`,
  })}`;

/** GET /authorize as `as`: the approval page, its handle and the consent binding cookie. */
async function consentPage(clientId: string, challenge: string, as: User) {
  const res = await call(authorizePath(clientId, challenge), { as });
  const html = await res.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  return { res, html, handle: handle!, binding: cookiesOf(res) };
}

const approve = (fields: Record<string, string>, as: User | null, binding: string): Promise<Response> =>
  call("/authorize", {
    as,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: binding },
    body: new URLSearchParams(fields).toString(),
  });

/** The whole browser + client dance: register, approve as `as`, exchange the code. Returns an access token. */
async function connect(as: User): Promise<string> {
  const clientId = await register();
  const { verifier, challenge } = await pkce();
  const page = await consentPage(clientId, challenge, as);
  const res = await approve({ handle: page.handle, user: as, action: "approve" }, as, page.binding);
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const token = await call("/token", {
    as: null,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${TEST_ORIGIN}/mcp` }).toString(),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

type RpcResult = { result?: any; error?: { code: number; message: string } };

async function rpc(token: string, method: string, params: unknown = {}): Promise<RpcResult> {
  const res = await call("/mcp", {
    as: null,
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = res.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .at(-1)!
    : text;
  return JSON.parse(data) as RpcResult;
}

type ToolOutput = { isError?: boolean; text: string; data: any };

async function tool(token: string, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const { result, error } = await rpc(token, "tools/call", { name, arguments: args });
  if (error) throw new Error(`${name}: ${error.message}`);
  const text = (result.content as { text: string }[]).map((c) => c.text).join("\n");
  return { isError: result.isError, text, data: result.structuredContent };
}

const dal = (over: Partial<RecipeInput> = {}): RecipeInput => ({
  title: "Red lentil dal",
  yield: { amount: 4, unit: "servings" },
  time: { total_min: 45, active_min: 15 },
  sections: [
    {
      ingredients: [
        { item: "red lentils", qty: 200, unit: "g", prep: "washed twice" },
        { item: "salt", note: "to taste" },
      ],
    },
  ],
  steps_md: "1. Rinse the lentils.\n2. Simmer 20 min.",
  notes_md: "",
  source_url: "https://www.example.com/dal/",
  tags: ["course:main", "cuisine:indian", "method:one-pot"],
  ...over,
});

describe("OAuth endpoints", () => {
  it("advertises the authorization server and the protected resource", async () => {
    const as = (await (await call("/.well-known/oauth-authorization-server", { as: null })).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      authorization_endpoint: `${TEST_ORIGIN}/authorize`,
      token_endpoint: `${TEST_ORIGIN}/token`,
      registration_endpoint: `${TEST_ORIGIN}/register`,
    });
    // RFC 9728: the metadata of resource /mcp lives at the well-known prefix + /mcp.
    const pr = (await (await call("/.well-known/oauth-protected-resource/mcp", { as: null })).json()) as Record<string, unknown>;
    expect(pr).toMatchObject({ resource: `${TEST_ORIGIN}/mcp`, authorization_servers: [TEST_ORIGIN] });
  });

  it("answers /mcp without a token with 401 and a WWW-Authenticate challenge", async () => {
    const res = await call("/mcp", { as: null, method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("does not let a web session reach /mcp", async () => {
    const res = await call("/mcp", { as: "max", method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});

describe("/authorize", () => {
  it("sends a browser without a session to /login and back to the same /authorize URL", async () => {
    const clientId = await register();
    const path = authorizePath(clientId, (await pkce()).challenge);
    const res = await call(path, { as: null });
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location")!, TEST_ORIGIN);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe(path);
    const back = await call(`/login?next=${encodeURIComponent(path)}`, { as: "max" });
    expect(back.headers.get("location")).toBe(path);
  });

  it("shows the escaped client name and the acting user, with anti-framing headers", async () => {
    const clientId = await register('<img src=x onerror="alert(1)">');
    const page = await consentPage(clientId, (await pkce()).challenge, "partner");
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;</strong> wants to read and edit your Fridge Door recipes as <strong>partner</strong>");
    expect(page.html).not.toContain("<img");
    expect(page.res.headers.get("x-frame-options")).toBe("DENY");
    expect(page.res.headers.get("content-security-policy")).toContain("form-action 'self' https://client.example");
  });

  it("rejects an invalid authorization request", async () => {
    const res = await call(authorizePath("no-such-client", "x".repeat(43)), { as: "max" });
    expect(res.status).toBe(400);
  });

  it("approves only with the browser's consent cookie, the right handle and the same session user", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const page = await consentPage(clientId, challenge, "max");
    expect((await approve({ handle: page.handle, user: "max", action: "approve" }, "max", "")).status).toBe(400);
    expect((await approve({ handle: "forged", user: "max", action: "approve" }, "max", page.binding)).status).toBe(400);
    expect((await approve({ handle: page.handle, user: "max", action: "approve" }, null, page.binding)).status).toBe(401);
    expect((await approve({ handle: page.handle, user: "max", action: "approve" }, "partner", page.binding)).status).toBe(400);
    const ok = await approve({ handle: page.handle, user: "max", action: "approve" }, "max", page.binding);
    expect(ok.status).toBe(302);
    const to = new URL(ok.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("st-1");
    expect(to.searchParams.get("code")).toBeTruthy();
    // single use
    expect((await approve({ handle: page.handle, user: "max", action: "approve" }, "max", page.binding)).status).toBe(400);
  });

  it("Cancel sends access_denied back to the client", async () => {
    const clientId = await register();
    const page = await consentPage(clientId, (await pkce()).challenge, "max");
    const res = await approve({ handle: page.handle, user: "max", action: "cancel" }, "max", page.binding);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("code")).toBeNull();
  });
});

describe("MCP tools", () => {
  it("lists the tools and gives instructions naming the token's user", async () => {
    const token = await connect("partner");
    const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result.instructions).toContain("You act as partner");
    const { result } = await rpc(token, "tools/list");
    expect((result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([
      "add_comment",
      "add_to_shopping_list",
      "create_recipe",
      "get_recipe",
      "get_style_guide",
      "list_ingredients",
      "list_tags",
      "lookup_ingredients",
      "rate",
      "search_recipes",
      "set_cover_from_url",
      "set_ingredient",
      "set_tags",
      "update_recipe",
    ]);
  });

  it("refuses a grant whose user is not a current user", async () => {
    const req = new Request(`${TEST_ORIGIN}/mcp`, { method: "POST", body: "{}" });
    const res = await mcpApi.fetch(req as never, env as never, { ...ctx(), props: { user: "eve" } } as never);
    expect(res.status).toBe(403);
  });

  it("get_style_guide returns the normalization contract and the live tags", async () => {
    const token = await connect("max");
    await tool(token, "create_recipe", { recipe: dal() });
    const { text } = await tool(token, "get_style_guide", {});
    expect(text).toContain("# Recipe normalization contract");
    expect(text).toContain("`course` (1-2): breakfast");
    expect(text).toMatch(/## Tags in use now\n\n.*cuisine:indian \(1\)/);
  });

  it("create_recipe lists every lint problem, then saves the fixed recipe as the token's user with source mcp", async () => {
    const token = await connect("partner");
    const bad = await tool(token, "create_recipe", {
      recipe: dal({ title: "DAL MAKHANI 🍲", tags: ["list:next-up"], steps_md: "Rinse. Simmer.", notes_md: "Link in bio", sections: [{ ingredients: [{ item: "lentils", qty: 1, unit: "g" }, { item: "salt" }] }] }),
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Not saved: 7 problems");
    for (const p of ['tag "list:next-up": list tags are set by the server or the owners, not by the recipe writer', "needs 1-2 course tags, has 0", "emoji in title", "title in caps", "no qty and no note: salt", "steps_md is not a numbered list", "promo text in notes"]) {
      expect(bad.text).toContain(`- ${p}`);
    }
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM recipes").get()).toEqual({ n: 0 });

    const good = await tool(token, "create_recipe", { recipe: dal(), review_notes: ["time estimated: 5 prep + 40 simmer"] });
    expect(good.isError).toBeFalsy();
    expect(good.data).toMatchObject({ id: "red-lentil-dal", tags: ["course:main", "cuisine:indian", "method:one-pot"], url: `${TEST_ORIGIN}/recipes/red-lentil-dal` });
    expect(sqlite.prepare("SELECT author, source FROM recipe_revisions WHERE recipe_id = 'red-lentil-dal'").all()).toEqual([{ author: "partner", source: "mcp" }]);
    expect(sqlite.prepare("SELECT user, body_md FROM comments").all()).toEqual([{ user: "partner", body_md: "Import notes:\n- time estimated: 5 prep + 40 simmer" }]);
  });

  it("create_recipe reports a schema violation precisely", async () => {
    const token = await connect("max");
    const res = await tool(token, "create_recipe", { recipe: { ...dal(), sections: [{ ingredients: [{ item: "flour", qty: 1, unit: "cup" }] }] } });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('recipe.sections.0.ingredients.0.unit: Invalid option: expected one of "g"|"kg"');
  });

  it("create_recipe adds the board tags: todo:method without steps, status:stub for a stub", async () => {
    const token = await connect("max");
    const noMethod = await tool(token, "create_recipe", { recipe: dal({ steps_md: "" }), review_notes: ["no method in source"] });
    expect(noMethod.data.tags).toEqual(["course:main", "cuisine:indian", "method:one-pot", "todo:method"]);
    const stub = await tool(token, "create_recipe", {
      recipe: { title: "Kimchi pancakes", sections: [{ ingredients: [] }], steps_md: "", notes_md: "", source_url: "https://instagram.com/p/abc", tags: ["course:snack", "cuisine:korean"] },
      review_notes: ["stub"],
    });
    expect(stub.data.tags).toEqual(["course:snack", "cuisine:korean", "status:stub"]);
  });

  it("create_recipe stops on a duplicate source_url or similar title unless confirmed", async () => {
    const token = await connect("max");
    await tool(token, "create_recipe", { recipe: dal() });
    const sameUrl = await tool(token, "create_recipe", { recipe: dal({ title: "Masoor dal", source_url: "http://example.com/dal" }) });
    expect(sameUrl.isError).toBe(true);
    expect(sameUrl.text).toContain('"reason":"same source_url"');
    expect(sameUrl.text).toContain('"id":"red-lentil-dal"');
    const sameTitle = await tool(token, "create_recipe", { recipe: dal({ title: "Red lentil dhal", source_url: undefined }) });
    expect(sameTitle.text).toContain('"reason":"similar title"');
    const confirmed = await tool(token, "create_recipe", { recipe: dal({ title: "Red lentil dhal", source_url: undefined }), confirm_duplicate: true });
    expect(confirmed.isError).toBeFalsy();
    expect(confirmed.data.id).toBe("red-lentil-dhal");
  });

  it("search_recipes, get_recipe and list_tags read what was written", async () => {
    const token = await connect("max");
    await tool(token, "create_recipe", { recipe: dal() });
    await tool(token, "create_recipe", { recipe: dal({ title: "Kimchi pancakes", source_url: undefined, steps_md: "", tags: ["course:snack", "cuisine:korean"] }), review_notes: ["stub", "no source"] });
    await tool(token, "rate", { id: "red-lentil-dal", stars: 5 });

    const search = await tool(token, "search_recipes", { query: "lentils", max_total_min: 60 });
    expect(search.data).toEqual({
      total: 1,
      results: [{ id: "red-lentil-dal", title: "Red lentil dal", tags: ["course:main", "cuisine:indian", "method:one-pot"], total_min: 45, ratings: { max: 5 }, has_cover: false, source_url: "https://www.example.com/dal/" }],
    });
    expect((await tool(token, "search_recipes", {})).data.total).toBe(1);
    expect((await tool(token, "search_recipes", { include_stubs: true, tags: ["cuisine:korean"] })).data.results[0].id).toBe("kimchi-pancakes");

    const got = await tool(token, "get_recipe", { id: "red-lentil-dal", scale: 2 });
    expect(got.data.recipe.sections[0].ingredients[0].qty).toBe(200);
    expect(got.data.scaled_sections[0].ingredients[0].qty).toBe(400);
    expect(got.data.markdown).toContain("- 400 g red lentils, washed twice");
    expect(got.data.markdown).toContain("Yield: 8 servings");
    expect(got.data.recipe.ratings).toEqual([{ user: "max", stars: 5 }]);
    expect((await tool(token, "get_recipe", { id: "nope" })).isError).toBe(true);

    const tags = await tool(token, "list_tags", {});
    expect(tags.data.in_use).toContainEqual({ tag: "status:stub", count: 1 });
    expect(tags.data.vocabulary.course).toMatchObject({ values: expect.arrayContaining(["breakfast"]), min: 1, max: 2, set_by: "recipe writer" });
    expect(tags.data.vocabulary.list).toMatchObject({ values: null, set_by: "server or owners" });
  });

  it("update_recipe needs the current updated_at, lints, and recomputes todo:method", async () => {
    const token = await connect("max");
    const created = await tool(token, "create_recipe", { recipe: dal({ steps_md: "" }) });
    const stale = await tool(token, "update_recipe", { id: created.data.id, recipe: dal(), expected_updated_at: "2020-01-01T00:00:00.000Z" });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain(`current updated_at: ${created.data.updated_at}`);
    const linted = await tool(token, "update_recipe", { id: created.data.id, recipe: dal({ steps_md: "Simmer" }), expected_updated_at: created.data.updated_at });
    expect(linted.text).toContain("- steps_md is not a numbered list");
    const ok = await tool(token, "update_recipe", { id: created.data.id, recipe: dal({ tags: [...created.data.tags] }), expected_updated_at: created.data.updated_at });
    expect(ok.isError).toBeFalsy();
    expect(ok.data.tags).toEqual(["course:main", "cuisine:indian", "method:one-pot"]);
    expect(sqlite.prepare("SELECT author, source FROM recipe_revisions WHERE recipe_id = ? ORDER BY id").all(created.data.id)).toEqual([
      { author: "max", source: "mcp" },
      { author: "max", source: "mcp" },
    ]);
  });

  it("the guarded write itself refuses a row that changed after the check", async () => {
    const token = await connect("max");
    const created = await tool(token, "create_recipe", { recipe: dal() });
    const change = { author: "partner", source: "mcp", now: "2099-01-01T00:00:00.000Z" } as const;
    expect(await repo.upsertRecipe(env.DB as D1Database, created.data.id, dal({ title: "Theirs" }), change)).toBe(true);
    expect(await repo.upsertRecipe(env.DB as D1Database, created.data.id, dal({ title: "Ours" }), { ...change, author: "max" }, created.data.updated_at)).toBe(false);
    expect(sqlite.prepare("SELECT title FROM recipes").get()).toEqual({ title: "Theirs" });
    expect(sqlite.prepare("SELECT author FROM recipe_revisions ORDER BY id").all()).toEqual([{ author: "max" }, { author: "partner" }]);
  });

  it("set_tags, rate, add_comment and add_to_shopping_list act as the token's user", async () => {
    const token = await connect("partner");
    const { data } = await tool(token, "create_recipe", { recipe: dal() });
    const tags = await tool(token, "set_tags", { id: data.id, add: ["method:batch", "list:next-up"], remove: ["method:one-pot"] });
    expect(tags.data.tags).toEqual(["course:main", "cuisine:indian", "method:batch", "list:next-up"]);
    expect((await tool(token, "set_tags", { id: data.id, add: ["pasta"] })).text).toContain('"pasta" has no group');
    expect((await tool(token, "set_tags", { id: data.id, add: ["course:pasta"] })).text).toContain('"course:pasta": course is one of');
    expect((await tool(token, "set_tags", { id: data.id, add: ["vegan"] })).data.tags).toContain("diet:vegan");
    expect((await tool(token, "set_tags", { id: data.id, add: ["course:side", "course:soup"] })).text).toContain("course allows at most 2");
    expect(sqlite.prepare("SELECT author, source FROM recipe_revisions WHERE recipe_id = ? ORDER BY id DESC LIMIT 1").get(data.id)).toEqual({ author: "partner", source: "mcp" });

    expect((await tool(token, "rate", { id: data.id, stars: 4 })).data.ratings).toEqual({ partner: 4 });
    expect((await tool(token, "rate", { id: data.id, stars: 6 })).isError).toBe(true);

    const comment = await tool(token, "add_comment", { id: data.id, body_md: "Needs more **garlic**." });
    expect(sqlite.prepare("SELECT user, body_md FROM comments WHERE id = ?").get(comment.data.comment_id)).toEqual({ user: "partner", body_md: "Needs more **garlic**." });

    const shop = await tool(token, "add_to_shopping_list", { id: data.id, scale: 1.5 });
    expect(shop.data).toEqual({ id: data.id, scale: 1.5, added: 2 });
    expect(sqlite.prepare("SELECT item, qty, unit, recipe_id, recipe_title FROM shopping_items ORDER BY item").all()).toEqual([
      { item: "red lentils", qty: 300, unit: "g", recipe_id: data.id, recipe_title: "Red lentil dal" },
      { item: "salt", qty: null, unit: null, recipe_id: data.id, recipe_title: "Red lentil dal" },
    ]);
  });
});

describe("set_cover_from_url", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  async function withRecipe(): Promise<{ token: string; id: string }> {
    const token = await connect("max");
    const { data } = await tool(token, "create_recipe", { recipe: dal() });
    return { token, id: data.id };
  }

  it("follows a redirect and stores the image through the cover path, default focus", async () => {
    const { token, id } = await withRecipe();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      if (url === "https://img.example/a") return new Response(null, { status: 302, headers: { location: "/b.png" } });
      return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
    });
    const res = await tool(token, "set_cover_from_url", { id, image_url: "https://img.example/a" });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual(["https://img.example/a", "https://img.example/b.png"]);
    expect(res.data.cover_key).toMatch(new RegExp(`^covers/${id}/[0-9a-f]{16}\\.png$`));
    expect(res.data.cover_focus).toBeNull();
    expect(objects.get(res.data.cover_key)?.contentType).toBe("image/png");
  });

  it("rejects a non-image content-type, an oversized image, plain http and too many redirects", async () => {
    const { token, id } = await withRecipe();
    vi.stubGlobal("fetch", async () => new Response("<html>", { headers: { "content-type": "text/html" } }));
    expect((await tool(token, "set_cover_from_url", { id, image_url: "https://img.example/page" })).text).toContain('got "text/html"');

    vi.stubGlobal("fetch", async () => new Response(png, { headers: { "content-type": "image/jpeg", "content-length": String(11 * 1024 * 1024) } }));
    expect((await tool(token, "set_cover_from_url", { id, image_url: "https://img.example/big.jpg" })).text).toContain("larger than 10 MB");

    const big = new ReadableStream({
      start(c) {
        for (let i = 0; i < 11; i++) c.enqueue(new Uint8Array(1024 * 1024));
        c.close();
      },
    });
    vi.stubGlobal("fetch", async () => new Response(big, { headers: { "content-type": "image/webp" } }));
    expect((await tool(token, "set_cover_from_url", { id, image_url: "https://img.example/chunked.webp" })).text).toContain("larger than 10 MB");

    expect((await tool(token, "set_cover_from_url", { id, image_url: "http://img.example/a.png" })).text).toContain("Only https");

    vi.stubGlobal("fetch", async () => new Response(null, { status: 301, headers: { location: "https://img.example/again" } }));
    expect((await tool(token, "set_cover_from_url", { id, image_url: "https://img.example/loop" })).text).toContain("More than 3 redirects");

    expect(objects.size).toBe(0);
  });
});

describe("MCP ingredient catalogue", () => {
  it("create_recipe and update_recipe store bases; search_recipes finds a recipe by base", async () => {
    const token = await connect("max");
    const created = await tool(token, "create_recipe", { recipe: dal({ sections: [{ ingredients: [{ item: "red apples", qty: 2, unit: "piece" }, { item: "salt", note: "to taste" }] }] }) });
    const id = created.data.id as string;
    expect((await repo.getRecipe(env.DB as D1Database, id))!.sections[0]!.ingredients.map((i) => i.base)).toEqual(["apple", "salt"]);
    expect((await tool(token, "search_recipes", { query: "apples" })).data.results.map((r: { id: string }) => r.id)).toEqual([id]);
    const updated = await tool(token, "update_recipe", { id, recipe: dal({ sections: [{ ingredients: [{ item: "pears", qty: 2, unit: "piece" }] }] }), expected_updated_at: created.data.updated_at });
    expect(updated.isError).toBeFalsy();
    expect((await repo.getRecipe(env.DB as D1Database, id))!.sections[0]!.ingredients.map((i) => i.base)).toEqual(["pear"]);
  });

  it("lookup_ingredients explains a resolution; set_ingredient teaches the catalogue and re-resolves recipes", async () => {
    const token = await connect("partner");
    const created = await tool(token, "create_recipe", { recipe: dal({ sections: [{ ingredients: [{ item: "Granny Smith apples", qty: 2, unit: "piece" }] }] }) });
    const look = await tool(token, "lookup_ingredients", { items: ["eggplants", "Granny Smith apples"] });
    expect(look.data.results).toEqual([
      { item: "eggplants", base: "aubergine", aisle: "produce", how: "rule", origin: "seed" },
      { item: "Granny Smith apples", base: "granny smith apple", aisle: "other", how: "unknown", origin: null },
    ]);
    const set = await tool(token, "set_ingredient", { item: "Granny Smith apples", base: "apple" });
    expect(set.data).toMatchObject({ base: "apple", aisle: "produce", origin: "seed", recipes_updated: 1 });
    expect((await repo.getRecipe(env.DB as D1Database, created.data.id))!.sections[0]!.ingredients[0]!.base).toBe("apple");
    expect((await tool(token, "list_ingredients", { origin: "user" })).data.total).toBe(0);
    await tool(token, "set_ingredient", { item: "yuzu", base: "yuzu", aisle: "produce" });
    expect((await tool(token, "list_ingredients", { origin: "user" })).data.bases).toEqual([{ base: "yuzu", aisle: "produce", origin: "user", aliases: [] }]);
  });

  it("add_to_shopping_list rows carry base and aisle", async () => {
    const token = await connect("max");
    const created = await tool(token, "create_recipe", { recipe: dal() });
    await tool(token, "add_to_shopping_list", { id: created.data.id });
    expect(sqlite.prepare("SELECT item, base, aisle FROM shopping_items ORDER BY item").all()).toEqual([
      { item: "red lentils", base: "red lentil", aisle: "grains" },
      { item: "salt", base: "salt", aisle: "spices" },
    ]);
  });
});
