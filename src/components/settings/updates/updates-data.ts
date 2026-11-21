'use client';

import { compareVersions, type ConnectionInfo, type ReleaseInfo, type UpdateRun, type UpdatesState } from '@/lib/updates/types';
import { UPSTREAM_REPO } from '@/lib/updates/config';
import { peekRead, setReadData, type Read } from '@/lib/query-cache';

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

/** The newest pending release (pending is oldest first). */
export function newestPending(state: UpdatesState): ReleaseInfo | null {
  return state.pending.length ? state.pending[state.pending.length - 1] : null;
}

/** A run still moving on GitHub, worth polling for. */
export function isRunMoving(run: UpdateRun | null): boolean {
  if (!run) return false;
  if (run.stage === 'preparing' || run.stage === 'applying') return true;
  return run.stage === 'ready' && run.checks.some((check) => check.state === 'running');
}

/**
 * The run the steps follow, or null to start fresh at Prepare. A finished run
 * for an older release than the newest one gives way to a new Prepare (each
 * release includes the ones before it); a run still moving always shows.
 */
export function activeRun(state: UpdatesState): UpdateRun | null {
  const run = state.run;
  if (!run) return null;
  if (isRunMoving(run)) return run;
  if (run.stage === 'applied') return compareVersions(run.version, state.current) > 0 ? run : null;
  const newest = newestPending(state);
  if (newest && compareVersions(run.version, newest.version) < 0) return null;
  if (compareVersions(run.version, state.current) <= 0) return null;
  return run;
}

/** "Nov 12, 2026". */
export function releaseDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
