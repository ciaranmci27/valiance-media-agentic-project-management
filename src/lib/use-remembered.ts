'use client';

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/** The saved value, when there is one this browser kept and `accept` takes. */
function readSaved<T>(key: string, accept: (value: unknown) => value is T): { found: true; value: T } | { found: false } {
  if (typeof window === 'undefined') return { found: false };
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return { found: false };
    const parsed: unknown = JSON.parse(raw);
    return accept(parsed) ? { found: true, value: parsed } : { found: false };
  } catch {
    return { found: false };
  }
}

/**
 * A view choice this browser remembers (a filter, a sort, a range): state
 * that starts at the saved value, or `initial`, and saves every change.
 * Storage that is blocked or full only means the choice is not remembered.
 * `accept` checks a saved value, so an old or hand-edited one falls back to
 * `initial`. For views rendered in the browser only (the Agents page renders
 * under a search-params boundary), so the first render already has it.
 */
export function useRemembered<T>(key: string, initial: T, accept: (value: unknown) => value is T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const saved = readSaved(key, accept);
    return saved.found ? saved.value : initial;
  });

  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Not remembered.
      }
      return resolved;
    });
  }, [key]);

  return [value, set];
}
