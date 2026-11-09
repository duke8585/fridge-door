import { useEffect, useState } from "react";

/**
 * Two-tap confirmation: `tap(key)` arms `key` on the first tap and returns true on the second.
 * An armed key disarms by itself after `ms`, or when another key is tapped.
 */
export function useArmed<K>(ms = 3000): { armed: K | null; tap: (key: K) => boolean; disarm: () => void } {
  const [armed, setArmed] = useState<K | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), ms);
    return () => clearTimeout(t);
  }, [armed, ms]);
  const tap = (key: K): boolean => {
    if (armed === key) {
      setArmed(null);
      return true;
    }
    setArmed(key);
    return false;
  };
  return { armed, tap, disarm: () => setArmed(null) };
}
