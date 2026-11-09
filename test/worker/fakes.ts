/**
 * Just enough of D1 and R2 to run the real Worker in vitest. D1 is SQLite underneath, so
 * node:sqlite runs the same SQL (upserts, ?NNN params) with the real migrations.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { User } from "../../shared/schema";
import { SESSION_COOKIE, signSession } from "../../worker/session";

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}
  bind(...params: SQLInputValue[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.params).changes) } };
  }
}

/** `before`: apply only the migrations whose file name sorts before it (to test a later migration on old data). */
export function fakeD1(migrationsDir: string, opts: { before?: string } = {}): { d1: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    if (opts.before && f >= opts.before) break;
    sqlite.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  const d1 = {
    prepare: (sql: string) => new FakeStatement(sqlite, sql),
    batch: async (stmts: FakeStatement[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          const st = sqlite.prepare(s.sql);
          if (st.columns().length > 0) return { results: st.all(...s.params), meta: { changes: 0 } };
          return { results: [], meta: { changes: Number(st.run(...s.params).changes) } };
        });
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { d1: d1 as unknown as D1Database, sqlite };
}

export type StoredObject = { bytes: Uint8Array; contentType?: string };

export function fakeR2(): { r2: R2Bucket; objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  const r2 = {
    put: async (key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
      objects.set(key, { bytes: new Uint8Array(value.slice(0)), contentType: opts?.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const o = objects.get(key);
      return o ? { body: o.bytes, httpMetadata: { contentType: o.contentType }, httpEtag: `"${key}"` } : null;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  };
  return { r2: r2 as unknown as R2Bucket, objects };
}

export const TEST_SECRET = "test-session-secret";
export const TEST_IMPORT_TOKEN = "test-import-token";

/** `as`: the session user to send (default max), or null for no session cookie. */
export type AuthedInit = RequestInit & { as?: User | null };

export async function authedRequest(url: string, { as = "max", ...init }: AuthedInit = {}): Promise<Request> {
  const req = new Request(url, init);
  if (as) req.headers.append("cookie", `${SESSION_COOKIE}=${await signSession(TEST_SECRET, as)}`);
  return req;
}

/** Map-backed KV with what OAuthProvider uses: get (text/json), put, delete, prefix list. TTLs are ignored. */
export function fakeKV(): { kv: KVNamespace; data: Map<string, string> } {
  const data = new Map<string, string>();
  const kv = {
    get: async (key: string, opts?: "text" | "json" | { type?: "text" | "json" }) => {
      const v = data.get(key);
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  };
  return { kv: kv as unknown as KVNamespace, data };
}

export const TEST_ORIGIN = "https://recipes.example";
/** Bindings index.ts needs on top of the app's: the OAuth store and the MCP resource URL. */
export const oauthBindings = (): { OAUTH_KV: KVNamespace; MCP_RESOURCE: string } => ({ OAUTH_KV: fakeKV().kv, MCP_RESOURCE: `${TEST_ORIGIN}/mcp` });
