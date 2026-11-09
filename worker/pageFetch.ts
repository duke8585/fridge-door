/**
 * Fetching a user-supplied recipe page. The Worker runs with global_fetch_strictly_public, so
 * fetch() cannot reach private networks anyway; the host check here also rejects obvious private
 * targets before any request and on every redirect hop, so the policy holds in tests and locally.
 */
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const MAX_PAGE_REDIRECTS = 3;
export const PAGE_TIMEOUT_MS = 10_000;

const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  "accept-language": "en,de;q=0.8",
};
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

export type PageFailure = "invalid_url" | "blocked" | "not_html" | "too_large" | "timeout" | "unreachable" | "http_error";
export type FetchedPage = { ok: true; html: string; url: string } | { ok: false; failure: PageFailure; message: string };

const failed = (failure: PageFailure, message: string): FetchedPage => ({ ok: false, failure, message });

/** http(s) on the default ports, to a host that is not obviously private. */
export function checkTarget(raw: string): { ok: true; url: URL } | { ok: false; failure: PageFailure; message: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, failure: "invalid_url", message: "That is not a valid link." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, failure: "invalid_url", message: "Only http and https links can be imported." };
  if (url.username || url.password) return { ok: false, failure: "invalid_url", message: "Links with a user name or password cannot be imported." };
  if (url.port && url.port !== "80" && url.port !== "443") return { ok: false, failure: "blocked", message: `Port ${url.port} is not allowed.` };
  if (isPrivateHost(url.hostname)) return { ok: false, failure: "blocked", message: `${url.hostname} is not a public website.` };
  return { ok: true, url };
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h.includes(":")) return isPrivateIpv6(h);
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isPrivateIpv4(v4.slice(1).map(Number));
  return !h.includes(".") || /\.(localhost|local|internal|lan|home\.arpa|intranet|corp)$/.test(h);
}

function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

function isPrivateIpv6(h: string): boolean {
  if (h === "::" || h === "::1") return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!.split(".").map(Number));
  if (h.startsWith("::ffff:")) return true;
  return /^(f[cd]|fe[89ab])/.test(h);
}

/**
 * GET the page: at most 3 redirects (each hop checked), text/html only, at most 3 MB (header and
 * while reading), 10 s for the whole exchange including the body.
 */
export async function fetchPage(raw: string, timeoutMs = PAGE_TIMEOUT_MS): Promise<FetchedPage> {
  const signal = AbortSignal.timeout(timeoutMs);
  let target = checkTarget(raw);
  try {
    for (let hop = 0; ; hop++) {
      if (!target.ok) return failed(target.failure, target.message);
      const res = await fetch(target.url.href, { redirect: "manual", headers: BROWSER_HEADERS, signal });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (hop >= MAX_PAGE_REDIRECTS) return failed("unreachable", `The link redirects more than ${MAX_PAGE_REDIRECTS} times.`);
        target = checkTarget(new URL(location, target.url).href);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        if ([401, 403, 429, 451].includes(res.status)) return failed("blocked", `The site refused to send the page (HTTP ${res.status}). Some sites block automated readers.`);
        return failed("http_error", `The site answered HTTP ${res.status}.`);
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!HTML_TYPES.has(type)) {
        await res.body?.cancel();
        return failed("not_html", `The link is not a web page (${type || "no content type"}).`);
      }
      if (Number(res.headers.get("content-length") ?? 0) > MAX_PAGE_BYTES) {
        await res.body?.cancel();
        return failed("too_large", "The page is larger than 3 MB.");
      }
      const bytes = await readAtMost(res, MAX_PAGE_BYTES);
      if (!bytes) return failed("too_large", "The page is larger than 3 MB.");
      return { ok: true, html: decode(bytes, res.headers.get("content-type")), url: target.url.href };
    }
  } catch (e) {
    if (signal.aborted) return failed("timeout", `The site did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    return failed("unreachable", `Could not reach the site (${e instanceof Error ? e.message : String(e)}).`);
  }
}

/** The charset from the header, else from a <meta charset> in the first 2 KB, else UTF-8. */
function decode(bytes: ArrayBuffer, contentType: string | null): string {
  const head = new TextDecoder("utf-8").decode(bytes.slice(0, 2048));
  const charset = contentType?.match(/charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** The body, or null as soon as it exceeds `max` bytes. */
export async function readAtMost(res: Response, max: number): Promise<ArrayBuffer | null> {
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
