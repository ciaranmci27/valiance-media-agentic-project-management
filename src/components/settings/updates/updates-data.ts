'use client';

import type { ConnectionInfo, UpdateRun, UpdatesState } from '@/lib/updates/types';
import type { DatabaseUpdates } from '@/lib/updates/database';
import { UPSTREAM_REPO } from '@/lib/updates/config';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { peekRead, setReadData, warmRead, type Read } from '@/lib/query-cache';
import { appLocale } from '@/lib/region';
import { deployDeadline } from './update-phase';

/**
 * Settings > Updates and the update notice share one read of
 * GET /api/workspace/updates, so the notice and the page always agree and a
 * visit to the page refreshes what the notice shows.
 */

/** Where the docs explain creating the repo with the public history and updating. */
export const UPDATING_DOCS_URL = `https://github.com/${UPSTREAM_REPO}#updating`;

/** GitHub's page for a new fine-grained token. */
export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Could not reach the server. Try again in a moment.');
  return payload.data as T;
}

export const updatesRead: Read<UpdatesState> = {
  key: 'workspace-updates',
  // GitHub holds the truth, so no table change makes this stale.
  tables: [],
  ttlMs: 60_000,
  load: async () => parse<UpdatesState>(await fetch('/api/workspace/updates', { cache: 'no-store' })),
};

/** Reads again with a fresh look at GitHub (Check now, Check connection). */
export async function refreshUpdates(): Promise<UpdatesState> {
  const data = await parse<UpdatesState>(await fetch('/api/workspace/updates?refresh=1', { cache: 'no-store' }));
  setReadData(updatesRead, () => data);
  return data;
}

/** Changes the cached state in place, when there is one to change. */
function patchState(change: (state: UpdatesState) => UpdatesState) {
  const current = peekRead(updatesRead);
  if (current) setReadData(updatesRead, () => change(current));
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return parse<T>(await fetch(`/api/workspace/updates/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }));
}

/** Prepare or Apply: the run they return replaces the one on screen. */
export async function startRun(action: 'prepare' | 'apply', version: string): Promise<UpdateRun> {
  const run = await post<UpdateRun>(action, { version });
  patchState((state) => ({ ...state, run }));
  return run;
}

/** Finish setup: stores the token as the workflow's secret. */
export async function finishSetup(): Promise<ConnectionInfo> {
  const connection = await post<ConnectionInfo>('setup', {});
  patchState((state) => ({ ...state, connection }));
  return connection;
}

/** Turns automatic database updates on or off; the status it returns replaces the one on screen. */
export async function saveDatabaseUpdates(automatic: boolean): Promise<DatabaseUpdates | null> {
  const database = await post<DatabaseUpdates | null>('database', { automatic });
  patchState((state) => ({ ...state, database }));
  return database;
}

/** "Nov 12, 2026". */
export function releaseDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', year: 'numeric' });
}

/** While an update moves on GitHub, how often the app asks again. */
export const POLL_MS = 10_000;

/*
 * One poll for the whole app, however many places watch the update (the
 * Updates page and the sidebar): every 10 s while one of them wants it and
 * the tab is visible, stopping the moment it is hidden.
 */
let pollUsers = 0;
let pollTimer: number | null = null;
const pollTick = () => { void warmRead(updatesRead, { force: true }); };

function syncPoll() {
  const want = pollUsers > 0 && !document.hidden;
  if (want && pollTimer === null) pollTimer = window.setInterval(pollTick, POLL_MS);
  if (!want && pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function onPollVisibility() {
  // Back on the tab: catch up at once, then keep going.
  if (!document.hidden && pollUsers > 0) pollTick();
  syncPoll();
}

export function useUpdatesPoll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    pollUsers += 1;
    if (pollUsers === 1) document.addEventListener('visibilitychange', onPollVisibility);
    syncPoll();
    return () => {
      pollUsers -= 1;
      if (pollUsers === 0) document.removeEventListener('visibilitychange', onPollVisibility);
      syncPoll();
    };
  }, [active]);
}

const noSubscribe = () => () => {};

/**
 * Development builds only: /settings/updates?state=<name> shows a sample
 * state (fixtures.ts), read straight from the address so no Suspense
 * boundary is needed for it.
 */
export function useFixtureName(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => (process.env.NODE_ENV === 'development' && window.location.pathname.startsWith('/settings/updates')
      ? new URLSearchParams(window.location.search).get('state')
      : null),
    () => null,
  );
}

/**
 * "Now" for the update screens. It renders once more when a merged run's
 * deploy crosses its 30-minute deadline, so the page and the sidebar turn to
 * "taking long" even though the poll has stopped and nothing else wakes them.
 */
export function useDeployNow(run: UpdateRun | null | undefined): number {
  const deadline = deployDeadline(run ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null || now >= deadline) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [deadline, now]);
  return now;
}
