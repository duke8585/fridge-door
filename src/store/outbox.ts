import { signal } from "../lib/signal";
import { db, type QueuedOp } from "./idb";
import type { OutboxOp } from "./ops";

/** Number of mutations not yet acknowledged by the server (shown in the header). */
export const pendingCount = signal(0);

let kick: () => void = () => {};
/** sync.ts registers its flush trigger here to avoid an import cycle. */
export function onEnqueue(fn: () => void): void {
  kick = fn;
}

export async function enqueue(...ops: OutboxOp[]): Promise<void> {
  const tx = (await db()).transaction("outbox", "readwrite");
  await Promise.all([...ops.map((op) => tx.store.add(op as QueuedOp)), tx.done]);
  await refreshPending();
  kick();
}

export async function allOps(): Promise<QueuedOp[]> {
  return (await db()).getAll("outbox");
}

export async function removeOps(seqs: number[]): Promise<void> {
  if (seqs.length === 0) return;
  const tx = (await db()).transaction("outbox", "readwrite");
  await Promise.all([...seqs.map((s) => tx.store.delete(s)), tx.done]);
  await refreshPending();
}

export async function refreshPending(): Promise<void> {
  pendingCount.set(await (await db()).count("outbox"));
}
