import { useSyncExternalStore } from "react";

/** Minimal observable value. Replaces a state library; React reads it via useSyncExternalStore. */
export type Signal<T> = {
  get: () => T;
  set: (next: T) => void;
  update: (fn: (prev: T) => T) => void;
  subscribe: (fn: () => void) => () => void;
};

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subs = new Set<() => void>();
  const set = (next: T): void => {
    if (Object.is(next, value)) return;
    value = next;
    for (const fn of subs) fn();
  };
  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useSignal<T>(s: Signal<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}
