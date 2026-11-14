/**
 * /authorize: the consent page an MCP client (claude.ai, Claude Code) sends the browser to.
 * The person is whoever the fd_session cookie says (log in first if there is none), and the grant
 * carries only `{user}`. CSRF: the consent handle is single use and bound to the browser by the
 * provider's __Host- cookie, and the post also needs the (SameSite=Lax) session.
 */
import { AuthorizationError, type AuthRequest, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { User } from "../shared/schema";
import { type AuthEnv, escapeHtml, page } from "./auth";
import { readCookie, SESSION_COOKIE, verifySession } from "./session";

/** What every MCP token carries. index.ts re-validates it on each /mcp request. */
export type GrantProps = { user: User };

type AuthorizeEnv = AuthEnv & { OAUTH_PROVIDER: OAuthHelpers };

const TITLE = "Connect";

const message = (status: number, text: string): Response =>
  page(status, `<p class="err" role="alert">${escapeHtml(text)}</p>`, new Headers(), { title: TITLE });

function approvalPage(consent: ConsentDescription, handle: string, user: User, headers: Headers): Response {
  const client = escapeHtml(consent.clientName);
  const loopback = consent.redirectIsLoopback
    ? `<p class="muted">It returns to a program on this computer (${escapeHtml(consent.redirectHost)}). Approve only if you just started this.</p>`
    : `<p class="muted">You will be sent back to ${escapeHtml(consent.redirectHost)}.</p>`;
  const body = `<p><strong>${client}</strong> wants to read and edit your Fridge Door recipes as <strong>${escapeHtml(user)}</strong>.</p>
${loopback}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}"><input type="hidden" name="user" value="${escapeHtml(user)}">
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="cancel" class="secondary">Cancel</button>
</form>`;
  const redirectOrigin = new URL(consent.redirectUri).origin;
  return page(200, body, headers, { title: TITLE, formAction: redirectOrigin === "null" ? undefined : redirectOrigin });
}

function redirectWith(headers: Headers, location?: string): Response {
  if (location) headers.set("location", location);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}

export async function authorize(req: Request, env: AuthorizeEnv): Promise<Response> {
  const user = await verifySession(readCookie(req, SESSION_COOKIE), env.SESSION_SECRET);

  if (req.method === "GET") {
    let authRequest: AuthRequest;
    try {
      authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(req);
    } catch (e) {
      console.warn("invalid authorization request", e);
      return message(400, "This connection request is invalid. Start again from the app that sent you here.");
    }
    if (!user) {
      const url = new URL(req.url);
      return redirectWith(new Headers(), `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    const consent = await env.OAUTH_PROVIDER.describeConsent(authRequest);
    const { handle, headers } = await env.OAUTH_PROVIDER.beginConsent(authRequest);
    return approvalPage(consent, handle, user, headers);
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  const form = await req.formData().catch(() => undefined);
  const handle = form?.get("handle");
  if (typeof handle !== "string" || !handle) return message(400, "This approval form is incomplete. Start again from the app that sent you here.");
  if (!user) return message(401, "Your Fridge Door login expired. Start again from the app that sent you here.");
  if (form?.get("user") !== user) return message(400, "You are now logged in as someone else. Start again from the app that sent you here.");
  try {
    if (form?.get("action") === "cancel") {
      const denied = await env.OAUTH_PROVIDER.denyConsent(req, handle);
      return redirectWith(denied.headers);
    }
    const approved = await env.OAUTH_PROVIDER.approveConsent(req, handle);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: approved.request,
      userId: user,
      metadata: { user },
      scope: approved.request.scope,
      props: { user } satisfies GrantProps,
    });
    return redirectWith(approved.headers, redirectTo);
  } catch (e) {
    if (e instanceof AuthorizationError) return message(400, "This approval expired or was already used. Start again from the app that sent you here.");
    throw e;
  }
}
