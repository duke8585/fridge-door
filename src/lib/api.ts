import type { FieldErrors, ValidationErrorBody } from "../../shared/schema";

/** Thrown for any HTTP response that is not 2xx. `fields` is set on zod validation errors, `body` is the parsed JSON. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields?: FieldErrors,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** Thrown when the request never reached the server (offline, DNS, timeout). */
export class NetworkError extends Error {}

/**
 * 401: the session cookie is missing or expired. Not a rejection of the change itself:
 * the outbox keeps the op and the UI asks the user to log in again.
 */
export class AuthError extends ApiError {}

/** Where the "log in" link should send the user, returning to the current page. */
export const loginHref = (): string => `/login?next=${encodeURIComponent(location.pathname + location.search)}`;

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const v = body as Partial<ValidationErrorBody> | null;
    if (res.status === 401) throw new AuthError(401, "Please log in again");
    throw new ApiError(res.status, v?.error ?? `HTTP ${res.status}`, v?.error === "validation" ? v.fields : undefined, body);
  }
  return body as T;
}
