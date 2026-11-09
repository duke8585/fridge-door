import type { UrlImportDraft } from "../../shared/urlImport";
import { newId } from "../lib/id";

/** An import result waiting for the editor, plus whether the user already chose "import anyway". */
export type PendingImport = { draft: UrlImportDraft; forced: boolean };

/**
 * Handed from the import page to the editor by token (/recipes/new?import=<token>). Kept in memory
 * and in sessionStorage, so a reload of the editor tab keeps the draft; nothing is saved to the server.
 */
const memory = new Map<string, PendingImport>();
const key = (token: string): string => `fd_import_${token}`;

export function stashImport(pending: PendingImport): string {
  const token = newId();
  memory.set(token, pending);
  try {
    sessionStorage.setItem(key(token), JSON.stringify(pending));
  } catch {
    // Private mode or a full quota: the in-memory copy still works until a reload.
  }
  return token;
}

export function takeImport(token: string): PendingImport | undefined {
  const hit = memory.get(token);
  if (hit) return hit;
  try {
    const raw = sessionStorage.getItem(key(token));
    return raw ? (JSON.parse(raw) as PendingImport) : undefined;
  } catch {
    return undefined;
  }
}

export function dropImport(token: string): void {
  memory.delete(token);
  try {
    sessionStorage.removeItem(key(token));
  } catch {
    // Nothing stored.
  }
}
