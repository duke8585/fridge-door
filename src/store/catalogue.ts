import { buildCatalogue, EMPTY_CATALOGUE, type Aisle, type Catalogue, type CatalogueData } from "../../shared/catalogue";
import { api } from "../lib/api";
import { signal } from "../lib/signal";
import { loadSummaries } from "./recipes";
import { kvGet, kvSet } from "./idb";

/**
 * The ingredient catalogue, cached in IndexedDB so the list groups and search resolve offline.
 * The sync response says which version the server has; a different one is fetched.
 */
export const catalogue = signal<Catalogue>(EMPTY_CATALOGUE);
let version: string | undefined;

export async function loadCatalogue(): Promise<void> {
  const cached = await kvGet<CatalogueData>("catalogue");
  if (cached && catalogue.get() === EMPTY_CATALOGUE) {
    version = cached.version;
    catalogue.set(buildCatalogue(cached));
  }
}

export async function refreshCatalogue(serverVersion: string): Promise<void> {
  if (serverVersion === version) return;
  const data = await api<CatalogueData>("/catalogue");
  await loadSummaries();
  version = data.version;
  await kvSet("catalogue", data);
  catalogue.set(buildCatalogue(data));
}

/** A move shows at once; the server's copy replaces it on the next version change. */
export function setLocalAisle(base: string, aisle: Aisle): void {
  const cat = catalogue.get();
  catalogue.set({ names: new Map(cat.names).set(base, base), aisles: new Map(cat.aisles).set(base, aisle) });
}
