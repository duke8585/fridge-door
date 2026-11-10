/**
 * What every Anthropic call in the Worker shares: whether the model may be called now (key set,
 * no recorded outage), how an API error is classified, and the strict tool schema conversion.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AiUnavailable } from "../shared/urlImport";
import * as repo from "./repo";

/** ANTHROPIC_API_KEY is optional everywhere: without it the Worker does what it can without a model. */
export type AiEnv = { DB: D1Database; ANTHROPIC_API_KEY?: string };

/** How long a credits or key outage skips the model before trying it again. */
export const OUTAGE_MS = 60 * 60 * 1000;

/**
 * Credits used up: 402 billing_error, the spend-limit error code, or the 400 "credit balance is
 * too low" invalid_request_error. Key rejected: 401/403. Anything else is not an outage.
 */
export function classifyOutage(e: unknown): Exclude<AiUnavailable, "not_configured"> | null {
  if (!(e instanceof Anthropic.APIError)) return null;
  const message = e.apiMessage ?? e.message;
  if (e.status === 402 || e.type === "billing_error" || e.errorCode === "enforced_spend_limit_reached") return "credits_exhausted";
  if (e.status === 400 && /credit balance/i.test(message)) return "credits_exhausted";
  if (e.status === 401 || e.status === 403 || e.type === "authentication_error" || e.type === "permission_error") return "key_rejected";
  return null;
}

export type AiState = { ok: true; apiKey: string } | { ok: false; reason: AiUnavailable; until: string | null };

export async function aiState(env: AiEnv, now: Date): Promise<AiState> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: "not_configured", until: null };
  const outage = await repo.getAiOutage(env.DB, now.toISOString());
  return outage ? { ok: false, ...outage } : { ok: true, apiKey };
}

/** Records an outage when `e` is one, so every caller skips the model for OUTAGE_MS. Returns the classification. */
export async function noteOutage(env: AiEnv, e: unknown, now: Date): Promise<ReturnType<typeof classifyOutage>> {
  const outage = classifyOutage(e);
  if (outage) await repo.setAiOutage(env.DB, { reason: outage, until: new Date(now.getTime() + OUTAGE_MS).toISOString() });
  return outage;
}

/** Keywords strict tool schemas accept. Length, range and count limits are checked by zod and the lint instead. */
const STRICT_KEYS = new Set(["type", "properties", "required", "items", "enum", "const", "anyOf", "description", "format"]);

export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, strictSchema(s)]));
    else if (STRICT_KEYS.has(k)) out[k] = strictSchema(v);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}
