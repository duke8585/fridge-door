/**
 * Login with Google or GitHub, for the two allowlisted people only. Runs in front of everything
 * (assets.run_worker_first), so it covers the JS/CSS/shell as well as /api.
 *
 * - GET /login: provider buttons. /auth/<provider>/start sets a signed single-use state cookie
 *   and redirects to the provider; /auth/<provider>/callback checks it, asks the provider who
 *   this is, looks the identity up in LOGINS and sets `fd_session`.
 * - The acting user comes only from the session (or, on the import routes, from IMPORT_TOKEN).
 * - Without a session: /api/* -> 401 JSON {error:"auth_required"}, page navigations ->
 *   302 /login?next=..., other requests -> 401. The manifest and icons stay public because
 *   browsers fetch the manifest without cookies.
 */
import { z } from "zod";
import { type User, UserSchema } from "../shared/schema";
import {
  b64url,
  constantTimeEqual,
  fromB64url,
  type NewOAuthState,
  type OAuthState,
  randomToken,
  readCookie,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  STATE_COOKIE,
  STATE_MAX_AGE_S,
  signSession,
  signState,
  verifySession,
  verifyState,
} from "./session";

export type AuthEnv = {
  SESSION_SECRET?: string;
  IMPORT_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  LOGINS?: unknown;
  /** "true" only in .dev.vars. Also needs a loopback host, so it cannot work on a deployed Worker. */
  DEV_LOGIN?: string;
};

export const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/manifest.webmanifest", "/icon.svg", "/favicon.ico"]);
/** The loader (scripts/load-import.ts) and the base backfill may use `Authorization: Bearer <IMPORT_TOKEN>` here, acting as the first user in LOGINS. */
const BEARER_ROUTES: readonly RegExp[] = [/^\/api\/import\/[^/]+$/, /^\/api\/recipes\/[^/]+\/cover$/, /^\/api\/catalogue\/backfill$/];

const NO_STORE = { "cache-control": "no-store" };

// ---------- allowlist ----------

/** Lowercase; googlemail.com is gmail.com, and gmail ignores dots in the local part. */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  const domain = e.slice(at + 1) === "googlemail.com" ? "gmail.com" : e.slice(at + 1);
  const local = domain === "gmail.com" ? e.slice(0, at).replaceAll(".", "") : e.slice(0, at);
  return `${local}@${domain}`;
}

const NORMALIZE_KEY: Record<ProviderId, (k: string) => string | null> = {
  google: (k) => (k.includes("@") ? normalizeEmail(k) : null),
  github: (k) => (/^\d+$/.test(k) ? k : null),
};

const LoginsSchema = z.record(UserSchema, z.strictObject({ google: z.string().optional(), github: z.string().optional() }));
type Logins = z.infer<typeof LoginsSchema>;

/** The people who exist are the keys of LOGINS. Invalid config means nobody. */
function parseLogins(raw: unknown): Logins {
  const parsed = LoginsSchema.safeParse(raw);
  if (!parsed.success) console.error("invalid LOGINS config; nobody can log in");
  return parsed.success ? parsed.data : {};
}

export const users = (env: AuthEnv): User[] => Object.keys(parseLogins(env.LOGINS));

export function allowlist(raw: unknown, provider: ProviderId): ReadonlyMap<string, User> {
  const entries = Object.entries(parseLogins(raw)).flatMap(([user, ids]) =>
    ids[provider] === undefined ? [] : [[NORMALIZE_KEY[provider](ids[provider]), user] as const],
  );
  const keys = entries.map(([k]) => k);
  if (keys.includes(null) || new Set(keys).size < keys.length) {
    console.error(`invalid LOGINS config; nobody can log in with ${provider}`);
    return new Map();
  }
  return new Map(entries as [string, User][]);
}

// ---------- providers ----------

type ProviderId = "google" | "github";
type Credentials = { id: string; secret: string };
type Identified = { ok: true; key: string; label: string } | { ok: false; status: 403 | 502; message: string };

type Provider = {
  label: string;
  credentials(env: AuthEnv): Credentials | null;
  allowlist(env: AuthEnv): ReadonlyMap<string, User>;
  /** The state to remember in the cookie, and where to send the browser. */
  start(clientId: string, redirectUri: string, next: string): Promise<{ state: NewOAuthState; url: URL }>;
  identify(creds: Credentials, code: string, redirectUri: string, state: OAuthState): Promise<Identified>;
};

const creds = (id: string | undefined, secret: string | undefined): Credentials | null => (id && secret ? { id, secret } : null);
const failed = (status: 403 | 502, message: string): Identified => ({ ok: false, status, message });
const formPost = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(body),
});

const GoogleClaimsSchema = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string(),
  nonce: z.string(),
  email: z.string(),
  email_verified: z.boolean(),
});

/**
 * The id_token comes straight from Google's token endpoint over TLS, so its signature need not be
 * checked (OIDC Core 3.1.3.7). Issuer, audience and nonce still are.
 */
function googleClaims(idToken: string, clientId: string, nonce: string): z.infer<typeof GoogleClaimsSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fromB64url(idToken.split(".")[1] ?? "")));
  } catch {
    return null;
  }
  const claims = GoogleClaimsSchema.safeParse(raw);
  return claims.success && claims.data.aud === clientId && claims.data.nonce === nonce ? claims.data : null;
}

const google: Provider = {
  label: "Google",
  credentials: (env) => creds(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
  allowlist: (env) => allowlist(env.LOGINS, "google"),
  async start(clientId, redirectUri, next) {
    const state = { provider: "google", nonce: randomToken(), next, verifier: randomToken() } as const;
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state.verifier)));
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      state: state.nonce,
      nonce: state.nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return { state, url };
  },
  async identify(c, code, redirectUri, state) {
    if (state.provider !== "google") return failed(502, "Login state mismatch.");
    const res = await fetch(
      "https://oauth2.googleapis.com/token",
      formPost({ client_id: c.id, client_secret: c.secret, code, code_verifier: state.verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
    );
    if (!res.ok) {
      console.error("google token exchange failed", res.status, await res.text());
      return failed(502, "Google did not accept the login. Please try again.");
    }
    const token = z.object({ id_token: z.string() }).safeParse(await res.json().catch(() => null));
    const claims = token.success ? googleClaims(token.data.id_token, c.id, state.nonce) : null;
    if (!claims) return failed(502, "Google sent an unexpected answer. Please try again.");
    if (!claims.email_verified) return failed(403, `Google has not verified ${claims.email}.`);
    return { ok: true, key: normalizeEmail(claims.email), label: claims.email };
  },
};

const github: Provider = {
  label: "GitHub",
  credentials: (env) => creds(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
  allowlist: (env) => allowlist(env.LOGINS, "github"),
  async start(clientId, redirectUri, next) {
    const state = { provider: "github", nonce: randomToken(), next } as const;
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "read:user",
      state: state.nonce,
      allow_signup: "false",
    }).toString();
    return { state, url };
  },
  async identify(c, code, redirectUri) {
    const res = await fetch(
      "https://github.com/login/oauth/access_token",
      formPost({ client_id: c.id, client_secret: c.secret, code, redirect_uri: redirectUri }),
    );
    const token = z.object({ access_token: z.string() }).safeParse(await res.json().catch(() => null));
    if (!res.ok || !token.success) {
      console.error("github token exchange failed", res.status);
      return failed(502, "GitHub did not accept the login. Please try again.");
    }
    // The token is used for this one request and then dropped; it is never stored.
    const userRes = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token.data.access_token}`, accept: "application/vnd.github+json", "user-agent": "fridge-door" },
    });
    const user = z.object({ id: z.number().int(), login: z.string() }).safeParse(await userRes.json().catch(() => null));
    if (!userRes.ok || !user.success) return failed(502, "Could not read your GitHub profile. Please try again.");
    // Keyed by the numeric id: logins can be renamed and then claimed by someone else.
    return { ok: true, key: String(user.data.id), label: `GitHub user ${user.data.login} (id ${user.data.id})` };
  },
};

const PROVIDERS: Record<ProviderId, Provider> = { google, github };

// ---------- responses ----------

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * `formAction` widens CSP form-action beyond 'self': browsers apply it to the redirect that answers
 * a form post too, and the MCP approval form redirects to the client's origin.
 */
export function page(status: number, body: string, headers: Headers = new Headers(), opts: { title?: string; formAction?: string } = {}): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(opts.title ?? "Log in")} - Fridge Door</title>
<style>body{font:16px/1.4 system-ui,sans-serif;background:#fffaf5;color:#1c1917;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;padding:1.5rem;border-radius:12px;box-shadow:0 1px 4px #0002;width:min(20rem,90vw);display:grid;gap:.75rem}
.btn,button{font:inherit;padding:.6rem;border-radius:8px;border:0;background:#c2410c;color:#fff;text-align:center;text-decoration:none;cursor:pointer}
.btn.gh{background:#24292f}form{display:grid;gap:.5rem;border-top:1px dashed #d6d3d1;padding-top:.75rem}
.err{color:#b91c1c;margin:0}.muted{color:#78716c;font-size:.875rem;margin:0}h1{font-size:1.2rem;margin:0}
button.secondary{background:#e7e5e4;color:#1c1917}</style></head>
<body><main><h1>Fridge Door</h1>${body}</main></body></html>`;
  headers.set("cache-control", "no-store");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${opts.formAction ? ` ${opts.formAction}` : ""}; frame-ancestors 'none'`,
  );
  return new Response(html, { status, headers });
}

const loginHref = (next: string): string => (next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);

function errorPage(status: number, message: string, next: string, headers?: Headers): Response {
  return page(status, `<p class="err" role="alert">${escapeHtml(message)}</p><a class="btn" href="${escapeHtml(loginHref(next))}">Back to login</a>`, headers);
}

function loginPage(next: string, dev: boolean, env: AuthEnv): Response {
  const q = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
  const devForm = dev
    ? `<form method="post" action="/auth/dev"><p class="muted">Local dev only</p><input type="hidden" name="next" value="${escapeHtml(next)}">
${users(env)
  .map((u) => `<button type="submit" name="user" value="${u}">Dev: log in as ${u}</button>`)
  .join("")}</form>`
    : "";
  return page(
    200,
    `<a class="btn" href="/auth/google/start${escapeHtml(q)}">Continue with Google</a>
<a class="btn gh" href="/auth/github/start${escapeHtml(q)}">Continue with GitHub</a>${devForm}`,
  );
}

const cookie = (name: string, value: string, maxAge: number, path = "/"): string =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function redirect(to: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ ...NO_STORE, location: to });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
}

/** Only same-origin paths; never back into the login flow. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.startsWith("/login") || raw.startsWith("/logout") || raw.startsWith("/auth/")) return "/";
  return raw;
}

const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const devLoginEnabled = (url: URL, env: AuthEnv): boolean => env.DEV_LOGIN === "true" && LOOPBACK.has(url.hostname);

// ---------- routes ----------

/**
 * Handles /login, /logout and /auth/*. Returns undefined for every other path.
 * `nowMs` is injectable for tests.
 */
export async function authRoutes(req: Request, env: AuthEnv, nowMs: number = Date.now()): Promise<Response | undefined> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path === "/logout") {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...NO_STORE, allow: "POST" } });
    return redirect("/login", [cookie(SESSION_COOKIE, "", 0)], 303);
  }
  if (path === "/login") {
    const next = safeNext(url.searchParams.get("next"));
    if (await sessionUser(req, env, nowMs)) return redirect(next);
    return loginPage(next, devLoginEnabled(url, env), env);
  }
  if (!path.startsWith("/auth/")) return undefined;

  const secret = env.SESSION_SECRET;
  if (!secret) return errorPage(503, "Login is not configured on this server (SESSION_SECRET is missing).", "/");

  if (path === "/auth/dev" && req.method === "POST" && devLoginEnabled(url, env)) {
    const form = await req.formData().catch(() => undefined);
    const user = form?.get("user");
    const next = form?.get("next");
    if (typeof user !== "string" || !users(env).includes(user)) return errorPage(400, "Pick one of the users.", "/");
    return redirect(safeNext(typeof next === "string" ? next : "/"), [cookie(SESSION_COOKIE, await signSession(secret, user, nowMs), SESSION_MAX_AGE_S)], 303);
  }

  const m = path.match(/^\/auth\/(google|github)\/(start|callback)$/);
  if (!m || req.method !== "GET") return errorPage(404, "Not found.", "/");
  const provider = PROVIDERS[m[1] as ProviderId];
  const redirectUri = `${url.origin}/auth/${m[1]}/callback`;
  const c = provider.credentials(env);

  if (m[2] === "start") {
    const next = safeNext(url.searchParams.get("next"));
    if (!c) return errorPage(503, `${provider.label} login is not configured on this server.`, next);
    const { state, url: to } = await provider.start(c.id, redirectUri, next);
    return redirect(to.toString(), [cookie(STATE_COOKIE, await signState(secret, state, nowMs), STATE_MAX_AGE_S, "/auth/")]);
  }

  // Callback. The state cookie is cleared on every outcome, so it works once.
  const headers = new Headers({ "set-cookie": cookie(STATE_COOKIE, "", 0, "/auth/") });
  const state = await verifyState(readCookie(req, STATE_COOKIE), secret, nowMs);
  const next = state?.next ?? "/";
  const given = url.searchParams.get("state");
  if (!state || state.provider !== m[1] || !given || !(await constantTimeEqual(given, state.nonce))) {
    return errorPage(400, "This login attempt expired or was already used. Please start again.", next, headers);
  }
  if (url.searchParams.has("error")) return errorPage(403, `${provider.label} login was cancelled.`, next, headers);
  const code = url.searchParams.get("code");
  if (!code) return errorPage(400, `${provider.label} sent no login code. Please start again.`, next, headers);
  if (!c) return errorPage(503, `${provider.label} login is not configured on this server.`, next, headers);

  let who: Identified;
  try {
    who = await provider.identify(c, code, redirectUri, state);
  } catch (e) {
    console.error(`${m[1]} login failed`, e);
    who = failed(502, `Could not reach ${provider.label}. Please try again.`);
  }
  if (!who.ok) return errorPage(who.status, who.message, next, headers);
  const user = provider.allowlist(env).get(who.key);
  if (!user) {
    console.warn("login rejected: not allowlisted", m[1], who.label);
    return errorPage(403, `${who.label} is not allowed to use Fridge Door.`, next, headers);
  }
  headers.set("location", next);
  headers.set("cache-control", "no-store");
  headers.append("set-cookie", cookie(SESSION_COOKIE, await signSession(secret, user, nowMs), SESSION_MAX_AGE_S));
  return new Response(null, { status: 302, headers });
}

/** The acting user: the session, or on the import routes a matching IMPORT_TOKEN bearer. Never anything the client claims. */
/** The session's user while they are still in LOGINS, so removing someone ends their sessions. */
export async function sessionUser(req: Request, env: AuthEnv, nowMs: number = Date.now()): Promise<User | null> {
  const user = await verifySession(readCookie(req, SESSION_COOKIE), env.SESSION_SECRET, nowMs);
  return user && users(env).includes(user) ? user : null;
}

export async function requestUser(req: Request, env: AuthEnv, nowMs: number = Date.now()): Promise<User | null> {
  const session = await sessionUser(req, env, nowMs);
  if (session) return session;
  const bearer = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!bearer || !env.IMPORT_TOKEN || req.method !== "PUT") return null;
  if (!BEARER_ROUTES.some((r) => r.test(new URL(req.url).pathname))) return null;
  return (await constantTimeEqual(bearer, env.IMPORT_TOKEN)) ? (users(env)[0] ?? null) : null;
}

/** Response for a request without a valid session (non-/api; Hono answers /api with 401 JSON). */
export function unauthenticated(req: Request): Response {
  const url = new URL(req.url);
  const isPage =
    (req.method === "GET" || req.method === "HEAD") &&
    (req.headers.get("sec-fetch-mode") === "navigate" || (req.headers.get("accept") ?? "").includes("text/html"));
  if (isPage) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  return new Response("Login required", { status: 401, headers: { ...NO_STORE, "content-type": "text/plain" } });
}
