import type { AisleOrder } from "../../shared/catalogue";
import { nextTimestamp } from "../../shared/shopping";
import { signal } from "../lib/signal";
import { kvGet, kvSet } from "./idb";
import { enqueue } from "./outbox";

/** The household's aisle order; null until someone reorders (the default order applies). Last write wins on updated_at. */
export const aisleOrder = signal<AisleOrder | null>(null);

export async function loadAisleOrder(): Promise<void> {
  const cached = await kvGet<AisleOrder>("aisleOrder");
  if (cached && !aisleOrder.get()) aisleOrder.set(cached);
}

export async function setAisleOrder(order: AisleOrder["order"]): Promise<void> {
  const next: AisleOrder = { order, updated_at: nextTimestamp(aisleOrder.get()?.updated_at) };
  aisleOrder.set(next);
  await kvSet("aisleOrder", next);
  await enqueue({ kind: "aisle.order", order: next });
}

/** The server's order wins unless the local one is newer (a reorder still on its way). */
export async function applyRemoteAisleOrder(remote: AisleOrder | null | undefined): Promise<void> {
  const local = aisleOrder.get();
  if (!remote || (local && local.updated_at > remote.updated_at)) return;
  if (local && local.updated_at === remote.updated_at && local.order.join() === remote.order.join()) return;
  aisleOrder.set(remote);
  await kvSet("aisleOrder", remote);
}
