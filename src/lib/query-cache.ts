'use client';

import { useEffect, useState } from 'react';

/**
 * A small read-through cache for page-level queries.
 *
 * The app store holds the workspace and is the right home for data every page
 * shares. Reports are different: they ask for one range, the answer is large,
 * and it is wanted rarely but instantly. Fetching that on mount means the page
 * paints, then corrects itself a moment later, which reads as the page being
 * slow even when the query is fast.
 *
 * Three rules make it feel immediate:
 *
 *  - Cached answers are readable DURING render, so a repeat visit paints the
 *    real numbers on the first frame with no loading state at all.
 *  - A stale answer is shown while a fresh one loads behind it, so returning
 *    to a page is never a blank wait.
 *  - Anyone can warm a key ahead of time with `prefetchQuery`, so a page can
 *    be ready before it is opened.
 *
 * Deliberately not a general data layer: no mutation tracking, no garbage
 * collection beyond a size cap. It exists so reports open instantly.
 */

interface Entry<T> {
  data: T;
  at: number;
  failed: boolean;
}

const cache = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const subscribers = new Map<string, Set<() => void>>();

/** Bounded so a long session cannot grow it without limit. */
const MAX_ENTRIES = 40;
const DEFAULT_TTL_MS = 60_000;

function remember<T>(key: string, data: T, failed: boolean): void {
  if (cache.size >= MAX_ENTRIES) {
    // Oldest insertion first: Map preserves insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, { data, at: Date.now(), failed });
  for (const notify of subscribers.get(key) ?? []) notify();
}

/** The cached answer for a key, or undefined. Safe to call during render. */
export function readQuery<T>(key: string): T | undefined {
  const entry = cache.get(key) as Entry<T> | undefined;
  return entry && !entry.failed ? entry.data : undefined;
}

/**
 * Load a key into the cache if it is missing or stale. Concurrent callers for
 * the same key share one request, so a prefetch and a mount never double-fetch.
 */
export function prefetchQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T | undefined> {
  const entry = cache.get(key) as Entry<T> | undefined;
  const fresh = entry && !entry.failed && Date.now() - entry.at < ttlMs;
  if (fresh) return Promise.resolve(entry!.data);

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = fetcher()
    .then((data) => {
      remember(key, data, false);
      return data;
    })
    .catch(() => {
      // A failure is remembered only as a signal, never as data: the previous
      // good answer stays readable rather than a page going blank on a blip.
      if (!cache.has(key)) remember(key, undefined, true);
      for (const notify of subscribers.get(key) ?? []) notify();
      return undefined;
    })
    .finally(() => { inflight.delete(key); });

  inflight.set(key, request);
  return request;
}

export interface CachedQuery<T> {
  data: T | undefined;
  /** No answer yet: the caller should show its skeleton, never stale numbers. */
  loading: boolean;
  /** Showing a cached answer while a newer one loads. */
  revalidating: boolean;
  failed: boolean;
}

export function useCachedQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): CachedQuery<T> {
  const [, bump] = useState(0);

  useEffect(() => {
    const notify = () => bump((n) => n + 1);
    const set = subscribers.get(key) ?? new Set<() => void>();
    set.add(notify);
    subscribers.set(key, set);
    void prefetchQuery(key, fetcher, ttlMs);
    return () => {
      set.delete(notify);
      if (set.size === 0) subscribers.delete(key);
    };
    // The fetcher is rebuilt every render by most callers; the key is the
    // identity that matters, exactly as it is for the cache itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ttlMs]);

  const entry = cache.get(key) as Entry<T> | undefined;
  const has = Boolean(entry && !entry.failed);
  return {
    data: has ? entry!.data : undefined,
    loading: !has && !(entry?.failed ?? false),
    revalidating: has && inflight.has(key),
    failed: entry?.failed ?? false,
  };
}
