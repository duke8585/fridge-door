import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import worker from "../../worker/index";
import { authRoutes, allowlist, normalizeEmail, type AuthEnv } from "../../worker/auth";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  STATE_COOKIE,
  STATE_MAX_AGE_S,
  b64url,
  signSession,
  signState,
  verifySession,
  verifyState,
} from "../../worker/session";
import type { RecipeDetail } from "../../shared/schema";
import type { RevisionListItem } from "../../shared/revisions";
import { TEST_IMPORT_TOKEN, TEST_SECRET, authedRequest, fakeD1, fakeR2, oauthBindings, type AuthedInit } from "./fakes";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const ORIGIN = "https://fridge-door-stg.example.workers.dev";

const authEnv: AuthEnv = {
  SESSION_SECRET: TEST_SECRET,
  IMPORT_TOKEN: TEST_IMPORT_TOKEN,
  GOOGLE_CLIENT_ID: "g-client",
  GOOGLE_CLIENT_SECRET: "g-secret",
  GITHUB_CLIENT_ID: "gh-client",
  GITHUB_CLIENT_SECRET: "gh-secret",
  LOGINS: { max: { google: "bob.smith@googlemail.com" }, nadine: { google: "alice.jones@gmail.com", github: "4242" } },
};

const get = (path: string, headers: Record<string, string> = {}, env: AuthEnv = authEnv, origin = ORIGIN) =>
  authRoutes(new Request(`${origin}${path}`, { headers }), env, NOW) as Promise<Response>;

const setCookies = (res: Response): string[] => res.headers.getSetCookie();
const cookieValue = (res: Response, name: string): string | undefined =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]!
    .slice(name.length + 1);

describe("allowlist", () => {
  it("normalizes emails: case, googlemail, gmail dots", () => {
    expect(normalizeEmail(" Bob.Smith@GoogleMail.com ")).toBe("bobsmith@gmail.com");
    expect(normalizeEmail("b.o.b.s.m.i.t.h@gmail.com")).toBe("bobsmith@gmail.com");
    expect(normalizeEmail("First.Last@Example.org")).toBe("first.last@example.org");
  });
  it("matches the configured google list through normalization", () => {
    const list = allowlist(authEnv.LOGINS, "google");
    expect(list.get(normalizeEmail("bobsmith@gmail.com"))).toBe("max");
    expect(list.get(normalizeEmail("Alice.Jones@googlemail.com"))).toBe("nadine");
    expect(list.get(normalizeEmail("someone@gmail.com"))).toBeUndefined();
  });
  it("leaves out a person without that provider", () => {
    expect([...allowlist(authEnv.LOGINS, "github")]).toEqual([["4242", "nadine"]]);
  });
  it("fails closed on missing config, unknown users or fields, bad keys and shared logins", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(allowlist(undefined, "google").size).toBe(0);
    expect(allowlist({}, "google").size).toBe(0);
    expect(allowlist('{"max":{"google":"a@b.c"}}', "google").size).toBe(0);
    expect(allowlist({ max: { google: "a@b.c" }, admin: { google: "x@y.z" } }, "google").size).toBe(0);
    expect(allowlist({ max: { google: "a@b.c", gitlab: "1" } }, "google").size).toBe(0);
    expect(allowlist({ max: { github: "123" }, nadine: { github: "octocat" } }, "github").size).toBe(0);
    expect(allowlist({ max: { google: "a.b@gmail.com" }, nadine: { google: "ab@googlemail.com" } }, "google").size).toBe(0);
  });
});

describe("session cookie", () => {
  it("round-trips the user until it expires", async () => {
    const v = await signSession(TEST_SECRET, "nadine", NOW);
    expect(v).toMatch(/^nadine\.\d+\.[\w-]{43}$/);
    expect(await verifySession(v, TEST_SECRET, NOW)).toBe("nadine");
    expect(await verifySession(v, TEST_SECRET, NOW + (SESSION_MAX_AGE_S - 1) * 1000)).toBe("nadine");
    expect(await verifySession(v, TEST_SECRET, NOW + SESSION_MAX_AGE_S * 1000)).toBeNull();
  });
  it("rejects tampering, another secret, a missing secret and junk", async () => {
    const v = await signSession(TEST_SECRET, "nadine", NOW);
    const [, exp, mac] = v.split(".");
    expect(await verifySession(`max.${exp}.${mac}`, TEST_SECRET, NOW)).toBeNull();
    expect(await verifySession(`nadine.${Number(exp) + 1}.${mac}`, TEST_SECRET, NOW)).toBeNull();
    expect(await verifySession(v, "other-secret", NOW)).toBeNull();
    expect(await verifySession(v, undefined, NOW)).toBeNull();
    expect(await verifySession(v, "", NOW)).toBeNull();
    expect(await verifySession("admin.9999999999.x", TEST_SECRET, NOW)).toBeNull();
    expect(await verifySession(undefined, TEST_SECRET, NOW)).toBeNull();
  });
});

describe("state cookie", () => {
  const state = { provider: "google", nonce: "n1", next: "/recipes/ä", verifier: "v1" } as const;
  it("round-trips within 10 minutes, including non-ASCII next paths", async () => {
    const v = await signState(TEST_SECRET, state, NOW);
    expect(await verifyState(v, TEST_SECRET, NOW + (STATE_MAX_AGE_S - 1) * 1000)).toMatchObject(state);
    expect(await verifyState(v, TEST_SECRET, NOW + STATE_MAX_AGE_S * 1000)).toBeNull();
  });
  it("rejects tampering, another secret and a session cookie", async () => {
    const v = await signState(TEST_SECRET, state, NOW);
    const [payload, mac] = v.split(".");
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ ...state, next: "/evil", exp: 9999999999 })));
    expect(await verifyState(`${forged}.${mac}`, TEST_SECRET, NOW)).toBeNull();
    expect(await verifyState(`${payload}.${mac}`, "other-secret", NOW)).toBeNull();
    expect(await verifyState(await signSession(TEST_SECRET, "max", NOW), TEST_SECRET, NOW)).toBeNull();
  });
});

describe("login pages", () => {
  it("serves the login page with both providers and keeps a safe next", async () => {
    const res = await get("/login?next=/shopping");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("<title>Log in - Fridge Door</title>");
    expect(html).toContain('href="/auth/google/start?next=%2Fshopping"');
    expect(html).toContain('href="/auth/github/start?next=%2Fshopping"');
    expect(html).not.toContain("/auth/dev");
    expect(await (await get("/login?next=//evil.example")).text()).toContain('href="/auth/google/start"');
  });
  it("sends a logged-in visitor straight to next", async () => {
    const res = await get("/login?next=/shopping", { cookie: `${SESSION_COOKIE}=${await signSession(TEST_SECRET, "max", NOW)}` });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/shopping");
  });
  it("logs out only with POST, clearing the session", async () => {
    const res = (await authRoutes(new Request(`${ORIGIN}/logout`, { method: "POST" }), authEnv, NOW))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(setCookies(res)).toEqual([`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`]);
    expect((await get("/logout")).status).toBe(405);
  });
  it("offers dev login only with DEV_LOGIN on a loopback host", async () => {
    const dev = { ...authEnv, DEV_LOGIN: "true" };
    const post = (origin: string, env: AuthEnv) =>
      authRoutes(new Request(`${origin}/auth/dev`, { method: "POST", body: new URLSearchParams({ user: "nadine", next: "/shopping" }) }), env, NOW) as Promise<Response>;
    expect(await (await get("/login", {}, dev, "http://localhost:8788")).text()).toContain("Dev: log in as nadine");
    expect(await (await get("/login", {}, dev)).text()).not.toContain("/auth/dev");
    const ok = await post("http://localhost:8788", dev);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/shopping");
    expect(await verifySession(cookieValue(ok, SESSION_COOKIE), TEST_SECRET, NOW)).toBe("nadine");
    for (const res of [await post(ORIGIN, dev), await post("http://localhost:8788", authEnv)]) {
      expect(res.status).toBe(404);
      expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
    }
  });
  it("fails closed without SESSION_SECRET", async () => {
    expect((await get("/auth/google/start", {}, { ...authEnv, SESSION_SECRET: undefined })).status).toBe(503);
  });
});

describe("OAuth start", () => {
  it("google: PKCE S256, redirect_uri from the request origin, signed state cookie", async () => {
    const res = await get("/auth/google/start?next=/recipes/dal");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = to.searchParams;
    expect(q.get("client_id")).toBe("g-client");
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(q.get("scope")).toBe("openid email");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    const set = setCookies(res)[0]!;
    expect(set).toMatch(new RegExp(`^${STATE_COOKIE}=[\\w-]+\\.[\\w-]{43}; Path=/auth/; Max-Age=${STATE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax$`));
    const state = await verifyState(cookieValue(res, STATE_COOKIE), TEST_SECRET, NOW);
    if (state?.provider !== "google") throw new Error("expected google state");
    expect(state.next).toBe("/recipes/dal");
    expect(q.get("state")).toBe(state.nonce);
    expect(q.get("nonce")).toBe(state.nonce);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state.verifier)));
    expect(q.get("code_challenge")).toBe(challenge);
  });
  it("github: read:user scope and the GitHub authorize URL", async () => {
    const res = await get("/auth/github/start");
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("scope")).toBe("read:user");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);
    expect((await verifyState(cookieValue(res, STATE_COOKIE), TEST_SECRET, NOW))?.provider).toBe("github");
  });
  it("503 when the provider has no credentials", async () => {
    expect((await get("/auth/github/start", {}, { ...authEnv, GITHUB_CLIENT_SECRET: undefined })).status).toBe(503);
  });
});

describe("OAuth callback", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const idToken = (claims: Record<string, unknown>): string =>
    ["{}", JSON.stringify(claims), "sig"].map((p) => b64url(new TextEncoder().encode(p))).join(".");

  async function googleLogin(claims: Record<string, unknown>) {
    const start = await get("/auth/google/start?next=/shopping");
    const sent = new URL(start.headers.get("location")!).searchParams;
    fetchMock.mockResolvedValue(
      Response.json({ id_token: idToken({ iss: "https://accounts.google.com", aud: "g-client", nonce: sent.get("nonce"), email_verified: true, ...claims }) }),
    );
    const res = await get(`/auth/google/callback?code=the-code&state=${sent.get("state")}`, { cookie: `${STATE_COOKIE}=${cookieValue(start, STATE_COOKIE)}` });
    return { res, session: await verifySession(cookieValue(res, SESSION_COOKIE), TEST_SECRET, NOW) };
  }

  it("google: exchanges the code with the PKCE verifier and logs in the allowlisted user", async () => {
    const { res, session } = await googleLogin({ email: "bobsmith@gmail.com" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/shopping");
    expect(session).toBe("max");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init!.body as URLSearchParams);
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    const set = setCookies(res);
    expect(set).toContain(`${STATE_COOKIE}=; Path=/auth/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    expect(set.find((c) => c.startsWith(SESSION_COOKIE))).toMatch(`; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`);
  });
  it("google: rejects an unverified email", async () => {
    const { res, session } = await googleLogin({ email: "bobsmith@gmail.com", email_verified: false });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not verified");
    expect(session).toBeNull();
  });
  it("google: rejects an email that is not allowlisted", async () => {
    const { res, session } = await googleLogin({ email: "stranger@gmail.com" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("stranger@gmail.com is not allowed");
    expect(session).toBeNull();
  });
  it("google: rejects an id_token for another client or nonce", async () => {
    expect((await googleLogin({ email: "bobsmith@gmail.com", aud: "someone-else" })).res.status).toBe(502);
    expect((await googleLogin({ email: "bobsmith@gmail.com", nonce: "replayed" })).res.status).toBe(502);
  });
  it("google: a failed token exchange is a 502 without a session", async () => {
    const start = await get("/auth/google/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    fetchMock.mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    const res = await get(`/auth/google/callback?code=x&state=${state}`, { cookie: `${STATE_COOKIE}=${cookieValue(start, STATE_COOKIE)}` });
    expect(res.status).toBe(502);
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects a bad state: wrong param, no cookie, forged cookie, other provider, expired", async () => {
    const start = await get("/auth/google/start");
    const good = cookieValue(start, STATE_COOKIE)!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const cb = (q: string, cookie?: string, path = "/auth/google/callback") => get(`${path}?code=c&${q}`, cookie ? { cookie: `${STATE_COOKIE}=${cookie}` } : {});
    const ghState = await signState(TEST_SECRET, { provider: "github", nonce: "n", next: "/" }, NOW);
    const expired = await signState(TEST_SECRET, { provider: "google", nonce: "n", next: "/", verifier: "v" }, NOW - STATE_MAX_AGE_S * 1000);
    for (const res of [
      await cb("state=wrong", good),
      await cb(`state=${state}`),
      await cb(`state=${state}`, `${good}x`),
      await cb("state=n", ghState),
      await cb("state=n", expired),
    ]) {
      expect(res.status).toBe(400);
      expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("a cancelled login is a 403 and clears the state cookie", async () => {
    const start = await get("/auth/github/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const res = await get(`/auth/github/callback?error=access_denied&state=${state}`, { cookie: `${STATE_COOKIE}=${cookieValue(start, STATE_COOKIE)}` });
    expect(res.status).toBe(403);
    expect(cookieValue(res, STATE_COOKIE)).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function githubAnswers(id: number) {
    fetchMock.mockImplementation(async (url) =>
      String(url).startsWith("https://github.com/login/oauth/access_token")
        ? Response.json({ access_token: "gho_test", token_type: "bearer", scope: "read:user" })
        : Response.json({ id, login: "someone" }),
    );
  }
  async function githubLogin(env: AuthEnv = authEnv) {
    const start = await get("/auth/github/start?next=/shopping", {}, env);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const res = await get(`/auth/github/callback?code=c&state=${state}`, { cookie: `${STATE_COOKIE}=${cookieValue(start, STATE_COOKIE)}` }, env);
    return { res, session: await verifySession(cookieValue(res, SESSION_COOKIE), TEST_SECRET, NOW) };
  }

  it("github: keys the allowlist by numeric id", async () => {
    githubAnswers(4242);
    const { res, session } = await githubLogin();
    expect(res.status).toBe(302);
    expect(session).toBe("nadine");
    const [userUrl, userInit] = fetchMock.mock.calls[1]!;
    expect(userUrl).toBe("https://api.github.com/user");
    expect(new Headers(userInit!.headers).get("authorization")).toBe("Bearer gho_test");
  });
  it("github: an empty allowlist lets nobody in and names the id to add", async () => {
    githubAnswers(4242);
    const { res, session } = await githubLogin({ ...authEnv, LOGINS: { max: { google: "bob.smith@googlemail.com" } } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("id 4242");
    expect(session).toBeNull();
  });
});

describe("Worker: who may do what", () => {
  let env: AuthEnv & { DB: D1Database; COVERS: R2Bucket; ASSETS: Fetcher };
  beforeEach(() => {
    const assets = { fetch: async () => new Response("asset") } as unknown as Fetcher;
    env = { ...authEnv, ...oauthBindings(), DB: fakeD1(resolve(import.meta.dirname, "../../migrations")).d1, COVERS: fakeR2().r2, ASSETS: assets };
  });
  const call = async (path: string, init: AuthedInit = {}): Promise<Response> =>
    (await worker.fetch((await authedRequest(`${ORIGIN}${path}`, init)) as never, env as never, {} as ExecutionContext)) as Response;
  const jsonInit = (method: string, body: unknown, extra: AuthedInit = {}): AuthedInit => ({
    ...extra,
    method,
    headers: { "content-type": "application/json", ...(extra.headers as Record<string, string> | undefined) },
    body: JSON.stringify(body),
  });

  it("without a session: 401 JSON for /api, redirect for pages, 401 for assets, manifest public", async () => {
    const api = await call("/api/recipes", { as: null });
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: "auth_required" });
    const nav = await call("/recipes/pancakes?servings=6", { as: null, headers: { accept: "text/html" } });
    expect(nav.status).toBe(302);
    expect(nav.headers.get("location")).toBe("/login?next=%2Frecipes%2Fpancakes%3Fservings%3D6");
    expect((await call("/assets/index-abc.js", { as: null })).status).toBe(401);
    expect((await call("/sw.js", { as: null })).status).toBe(401);
    expect(await (await call("/manifest.webmanifest", { as: null })).text()).toBe("asset");
    expect(await (await call("/assets/index-abc.js")).text()).toBe("asset");
  });
  it("/api/me is the session user", async () => {
    expect(await (await call("/api/me", { as: "nadine" })).json()).toEqual({ user: "nadine" });
  });
  it("attributes ratings, comments and revisions to the session, ignoring x-user and user cookies", async () => {
    const spoof = { "x-user": "max", cookie: "user=max" };
    const dal = { title: "Dal", sections: [{ ingredients: [] }], steps_md: "", notes_md: "", tags: [] };
    expect((await call("/api/recipes", jsonInit("POST", dal, { as: "max" }))).status).toBe(201);
    await call("/api/recipes/dal/rating", jsonInit("PUT", { stars: 3 }, { as: "nadine", headers: spoof }));
    await call("/api/comments/c1", jsonInit("PUT", { recipe_id: "dal", body_md: "hi" }, { as: "nadine", headers: spoof }));
    await call("/api/recipes/dal/tags", jsonInit("PATCH", { add: ["course:dessert"] }, { as: "nadine", headers: spoof }));
    const d = (await (await call("/api/recipes/dal")).json()) as RecipeDetail;
    expect(d.recipe.ratings).toEqual([{ user: "nadine", stars: 3 }]);
    expect(d.comments.map((c) => c.user)).toEqual(["nadine"]);
    const revs = (await (await call("/api/recipes/dal/revisions")).json()) as RevisionListItem[];
    expect(revs[0]?.author).toBe("nadine");
    expect((await call("/api/comments/c1", jsonInit("PUT", { recipe_id: "dal", body_md: "mine now" }, { as: "max" }))).status).toBe(403);
  });

  describe("import bearer token", () => {
    const record = {
      source_ref: "asana:1",
      status: "full",
      section: "GOOD",
      cover: null,
      ratings: [],
      comments: [],
      recipe: { title: "Bearer dal", time: { total_min: 10 }, sections: [{ ingredients: [] }], steps_md: "", notes_md: "", tags: [] },
      review: [],
    };
    const bearer = (token: string) => ({ as: null, headers: { authorization: `Bearer ${token}` } });

    it("accepts the token on the import and cover routes, acting as max", async () => {
      const res = await call("/api/import/asana:1", jsonInit("PUT", record, bearer(TEST_IMPORT_TOKEN)));
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const cover = await call(`/api/recipes/${id}/cover`, { ...bearer(TEST_IMPORT_TOKEN), method: "PUT", headers: { authorization: `Bearer ${TEST_IMPORT_TOKEN}`, "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) });
      expect(cover.status).toBe(200);
      const revs = (await (await call(`/api/recipes/${id}/revisions`)).json()) as RevisionListItem[];
      expect(revs[0]).toMatchObject({ source: "import", author: "max" });
    });
    it("rejects a wrong token, a missing IMPORT_TOKEN, and the token on other routes", async () => {
      expect((await call("/api/import/asana:1", jsonInit("PUT", record, bearer("nope")))).status).toBe(401);
      env.IMPORT_TOKEN = undefined;
      expect((await call("/api/import/asana:1", jsonInit("PUT", record, bearer("")))).status).toBe(401);
      env.IMPORT_TOKEN = TEST_IMPORT_TOKEN;
      expect((await call("/api/recipes", bearer(TEST_IMPORT_TOKEN))).status).toBe(401);
      expect((await call("/api/recipes/dal/rating", jsonInit("PUT", { stars: 1 }, bearer(TEST_IMPORT_TOKEN)))).status).toBe(401);
      expect((await call("/", { ...bearer(TEST_IMPORT_TOKEN), headers: { authorization: `Bearer ${TEST_IMPORT_TOKEN}`, accept: "text/html" } })).status).toBe(302);
    });
  });
});
