/**
 * Entry point. OAuthProvider serves the MCP authorization server (metadata, /register, /token)
 * and checks the bearer token on /mcp. Everything else (the app, /api, login, and our /authorize
 * consent page) goes to the default handler unchanged.
 */
import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { UserSchema } from "../shared/schema";
import { appHandler, type Bindings } from "./app";
import { createFridgeServer } from "./mcp";
import { authorize } from "./oauth";

export type Env = Bindings & {
  /** OAuth clients, grants and tokens, managed by OAuthProvider. */
  OAUTH_KV: KVNamespace;
  /** Public URL of /mcp (wrangler.jsonc vars). Tokens are bound to it. */
  MCP_RESOURCE: string;
};

export const mcpApi = {
  fetch(req, env, ctx) {
    // The grant could predate a change to USERS: only a current user may act.
    const user = UserSchema.safeParse((ctx.props as { user?: unknown } | undefined)?.user);
    if (!user.success) return new Response("Forbidden", { status: 403 });
    const handler = createMcpHandler(() => createFridgeServer({ env, user: user.data, origin: new URL(req.url).origin }));
    return handler(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

const defaultHandler = {
  fetch(req, env, ctx) {
    // OAuthProvider adds OAUTH_PROVIDER to the env it passes to this handler.
    if (new URL(req.url).pathname === "/authorize") return authorize(req, env as Env & { OAUTH_PROVIDER: OAuthHelpers });
    return appHandler.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

/** resourceMetadata is per environment, so the provider is built from the first request's env. */
let cached: { resource: string; provider: OAuthProvider<Env> } | undefined;

function provider(resource: string): OAuthProvider<Env> {
  if (cached?.resource !== resource) {
    cached = {
      resource,
      provider: new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpApi,
        defaultHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        resourceMetadata: { resource, resource_name: "Fridge Door recipes" },
      }),
    };
  }
  return cached.provider;
}

export default {
  fetch(req, env, ctx) {
    return provider(env.MCP_RESOURCE).fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
