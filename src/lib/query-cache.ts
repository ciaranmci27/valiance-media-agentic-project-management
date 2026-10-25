'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * The app's one read cache, for everything a screen fetches outside the
 * store's boot load: a project's activity, its emails waiting on you, a
 * task's files, a report range. One system, so every screen opens the same
 * way:
 *
 *  - A cached answer is readable DURING render, so a repeat visit paints the
 *    real content on the first frame with no loading state.
 *  - An aged or changed answer stays on screen while the fresh one loads
 *    behind it: a screen never goes back to a skeleton once it has data.
 *  - Anyone can warm a read ahead of the click (`warmRead`): pointing at a
 *    project or a task fetches what its screen will ask for, so it is ready
 *    when it opens.
 *  - A read names the tables it comes from. Live sync calls
 *    `invalidateTables` as rows change, so a cached answer is refreshed by the
 *    same realtime events that refresh the store, never by polling.
 *
 * Reads are described once, in `src/lib/reads.ts`, so a screen and whatever
 * warms it always share one key.
 */

/** One read: its identity, how to load it, and what makes it stale. */
export interface Read<T> {
  /** Unique across the app: "project-activity:<id>". */
  key: string;
  load: () => Promise<T>;
  /** Tables whose changes make this answer stale (see invalidateTables). */
  tables?: readonly string[];
  /** How long an answer counts as fresh before a mount refreshes it. */
  ttlMs?: number;
}

interface Entry {
  data: unknown;
  at: number;
  /** A table it reads from changed since: shown, but refreshed on sight. */
  stale: boolean;
  tables: readonly string[];
}

const DEFAULT_TTL_MS = 30_000;
/** Bounded so a long session cannot grow it without limit (least recently stored goes first). */
const MAX_ENTRIES = 150;

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
/**
 * Keys whose latest load failed. With nothing cached the screen shows the
 * failure; with an answer cached it stays shown. Either way nothing retries
 * on its own until the next change, warm or reload, so a failing read can
 * never loop.
 */
const failures = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const versions = new Map<string, number>();
/** Bumped by clearReads, so a load started before a sign-out never lands after it. */
let generation = 0;

function notify(key: string) {
  versions.set(key, (versions.get(key) ?? 0) + 1);
  for (const listener of listeners.get(key) ?? []) listener();
}

function store(key: string, data: unknown, tables: readonly string[]) {
  entries.delete(key);
  entries.set(key, { data, at: Date.now(), stale: false, tables });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  failures.delete(key);
  notify(key);
}

/** The cached answer, or undefined. Safe to call during render. */
export function peekRead<T>(read: Read<T>): T | undefined {
  return entries.get(read.key)?.data as T | undefined;
}

/**
 * Load a read unless a fresh answer is cached (`force` skips that check).
 * Concurrent callers share one request, so a warm, a mount and a refresh
 * never fetch twice. Rejects with the load's error, for a screen that must
 * report it; warmRead is the fire-and-forget form.
 */
export function loadRead<T>(read: Read<T>, options: { force?: boolean } = {}): Promise<T> {
  const entry = entries.get(read.key);
  const fresh = entry && !entry.stale && Date.now() - entry.at < (read.ttlMs ?? DEFAULT_TTL_MS);
  if (fresh && !options.force) return Promise.resolve(entry.data as T);
  const running = inflight.get(read.key) as Promise<T> | undefined;
  if (running) return running;

  const started = generation;
  const request = read.load()
    .then((data) => {
      if (started === generation) store(read.key, data, read.tables ?? []);
      return data;
    }, (error: unknown) => {
      if (started === generation) failures.add(read.key);
      throw error;
    })
    .finally(() => {
      inflight.delete(read.key);
      if (started === generation) notify(read.key);
    });
  inflight.set(read.key, request);
  notify(read.key);
  return request;
}

/**
 * Load a read unless a fresh answer is cached, never rejecting: resolves to
 * the answer, or undefined when the load failed (the failure is the hook's
 * to show). For warming ahead of a click.
 */
export function warmRead<T>(read: Read<T>, options: { force?: boolean } = {}): Promise<T | undefined> {
  return loadRead(read, options).catch((error: unknown) => {
    console.warn(`[reads] ${read.key} failed`, error);
    return undefined;
  });
}

/**
 * Put an answer in place after a local write (an upload, a removal), so
 * every screen showing it updates at once without a round trip.
 */
export function setReadData<T>(read: Read<T>, update: (current: T | undefined) => T) {
  store(read.key, update(entries.get(read.key)?.data as T | undefined), read.tables ?? []);
}

/** Warm many reads at once (a project's whole Overview, a task's panel). */
export function warmReads(reads: readonly Read<unknown>[]) {
  for (const read of reads) void warmRead(read);
}

/**
 * Rows changed in these tables (live sync, or a local write that has no
 * realtime echo): every answer read from them is marked stale, and screens
 * showing one refresh it while keeping it on screen.
 */
export function invalidateTables(tables: readonly string[]) {
  for (const [key, entry] of entries) {
    if (entry.tables.some((table) => tables.includes(table))) {
      entries.set(key, { ...entry, stale: true });
      failures.delete(key);
      notify(key);
    }
  }
}

/** Everything may have changed (the tab slept, live sync reconnected). */
export function invalidateAllReads() {
  for (const [key, entry] of entries) {
    entries.set(key, { ...entry, stale: true });
    failures.delete(key);
    notify(key);
  }
}

/** Forget everything: sign-out, or a switch of person. */
export function clearReads() {
  generation++;
  const keys = [...entries.keys(), ...failures];
  entries.clear();
  failures.clear();
  inflight.clear();
  keys.forEach(notify);
}

export interface ReadState<T> {
  data: T | undefined;
  /** Nothing to show yet: paint a skeleton, never a guess. */
  loading: boolean;
  /** An answer is on screen while a newer one loads behind it. */
  revalidating: boolean;
  /** The load failed and there is nothing cached to show. */
  failed: boolean;
  /** Read again now, keeping what is shown. */
  reload: () => void;
}

const noop = () => {};

/**
 * A cached read for a screen. Pass null to read nothing (no access, demo
 * mode). A cached answer paints on the first render; an aged or stale one is
 * refreshed behind itself.
 */
export function useRead<T>(read: Read<T> | null): ReadState<T> {
  const key = read?.key ?? null;
  // The key is the identity: callers rebuild the read object every render.
  const latest = useRef(read);
  useEffect(() => { latest.current = read; });

  const subscribe = useCallback((listener: () => void) => {
    if (!key) return noop;
    const set = listeners.get(key) ?? new Set<() => void>();
    set.add(listener);
    listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
    };
  }, [key]);
  useSyncExternalStore(subscribe, () => (key ? versions.get(key) ?? 0 : 0), () => 0);

  // Load on mount and whenever the answer goes stale while shown.
  useEffect(() => {
    if (!key || !latest.current) return;
    // Only a stale answer refreshes itself, and not straight after a failed
    // try: every notice (a load starting or settling) would otherwise retry.
    const refresh = () => {
      const current = latest.current;
      if (current && entries.get(key)?.stale && !failures.has(key) && !inflight.has(key)) void warmRead(current);
    };
    void warmRead(latest.current);
    return subscribe(refresh);
  }, [key, subscribe]);

  const reload = useCallback(() => {
    if (latest.current) void warmRead(latest.current, { force: true });
  }, []);

  const entry = key ? entries.get(key) : undefined;
  const failed = !!key && !entry && failures.has(key) && !inflight.has(key);
  return {
    data: entry?.data as T | undefined,
    loading: !!key && !entry && !failed,
    revalidating: !!entry && inflight.has(key!),
    failed,
    reload,
  };
}
