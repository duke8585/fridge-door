/**
 * Signed cookies for login: the 90-day session and the short-lived OAuth state.
 * Both are `<payload>.<HMAC-SHA256>` keyed by SESSION_SECRET, with a different label per kind so
 * one can never be replayed as the other. Rotating SESSION_SECRET logs everyone out.
 * Only standard web APIs, so this runs in workerd and in the node unit tests.
 */
import { z } from "zod";
import { USERS, type User, UserSchema } from "../shared/schema";

export const SESSION_COOKIE = "fd_session";
export const SESSION_MAX_AGE_S = 90 * 24 * 60 * 60;
export const STATE_COOKIE = "fd_oauth_state";
export const STATE_MAX_AGE_S = 10 * 60;

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on malformed input. */
export function fromB64url(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

export const randomToken = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Hashes both sides first, so the comparison is fixed-length and leaks nothing about either string. */
export async function constantTimeEqual(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return bytesEqual(new Uint8Array(a), new Uint8Array(b));
}

async function mac(secret: string, label: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`${label}.${data}`)));
}

async function macMatches(secret: string, label: string, data: string, given: string): Promise<boolean> {
  return bytesEqual(enc.encode(given), enc.encode(await mac(secret, label, data)));
}

const nowS = (nowMs: number): number => Math.floor(nowMs / 1000);

/** `<user>.<expiry unix seconds>.<hmac>` */
export async function signSession(secret: string, user: User, nowMs: number = Date.now()): Promise<string> {
  const payload = `${user}.${nowS(nowMs) + SESSION_MAX_AGE_S}`;
  return `${payload}.${await mac(secret, "fd-session.v1", payload)}`;
}

const SESSION_RE = new RegExp(`^(${USERS.join("|")})\\.(\\d{1,12})\\.([A-Za-z0-9_-]{43})$`);

export async function verifySession(value: string | undefined, secret: string | undefined, nowMs: number = Date.now()): Promise<User | null> {
  const m = secret ? value?.match(SESSION_RE) : null;
  if (!m || Number(m[2]) <= nowS(nowMs)) return null;
  if (!(await macMatches(secret!, "fd-session.v1", `${m[1]}.${m[2]}`, m[3]!))) return null;
  return UserSchema.parse(m[1]);
}

/** What the start route remembers for the callback. Google adds the PKCE verifier. */
const OAuthStateSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("google"), nonce: z.string(), next: z.string(), verifier: z.string(), exp: z.number() }),
  z.object({ provider: z.literal("github"), nonce: z.string(), next: z.string(), exp: z.number() }),
]);
export type OAuthState = z.infer<typeof OAuthStateSchema>;
type WithoutExp<S> = S extends unknown ? Omit<S, "exp"> : never;
export type NewOAuthState = WithoutExp<OAuthState>;

export async function signState(secret: string, state: NewOAuthState, nowMs: number = Date.now()): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ ...state, exp: nowS(nowMs) + STATE_MAX_AGE_S })));
  return `${payload}.${await mac(secret, "fd-oauth-state.v1", payload)}`;
}

export async function verifyState(value: string | undefined, secret: string, nowMs: number = Date.now()): Promise<OAuthState | null> {
  const m = value?.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
  if (!m || !(await macMatches(secret, "fd-oauth-state.v1", m[1]!, m[2]!))) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fromB64url(m[1]!)));
  } catch {
    return null;
  }
  const parsed = OAuthStateSchema.safeParse(raw);
  return parsed.success && parsed.data.exp > nowS(nowMs) ? parsed.data : null;
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
