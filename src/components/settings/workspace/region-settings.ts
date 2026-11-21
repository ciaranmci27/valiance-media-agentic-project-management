'use client';

import { setReadData, type Read } from '@/lib/query-cache';
import {
  CURRENCIES,
  LOCALES,
  currencyName,
  currencySymbol,
  localeName,
  type Region,
} from '@/lib/region';
import type { SelectOption } from '@/components/ui/inputs/Select';

/**
 * The Owner's side of the workspace region, shared by Settings > Workspace >
 * Region and the setup wizard: one read and one save. Every screen else reads
 * the region from the page render (useRegion, useMoney), so a successful
 * write is followed by router.refresh().
 */

export interface RegionData {
  region: Region;
  defaults: Region;
}

export type RegionState =
  | { status: 'ready'; data: RegionData }
  /** The region migration has not run: nothing can be saved yet. */
  | { status: 'migration'; message: string }
  /** The demo workspace has no database: edits stay on this page until a reload. */
  | { status: 'local' };

class RegionRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function fallbackMessage(status: number): string {
  if (status === 409) return 'Run the latest database migration first.';
  if (status === 403) return 'Only the workspace Owner can change the region.';
  return 'Something went wrong on the server. Try again.';
}

async function parse(response: Response): Promise<RegionData> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new RegionRequestError(payload.error || fallbackMessage(response.status), response.status);
  return payload.data as RegionData;
}

/** Owner only. The region changes only through this route, so it is read once a session. */
export const workspaceRegionRead: Read<RegionState> = {
  key: 'workspace-region',
  tables: ['workspace_region'],
  ttlMs: 10 * 60_000,
  load: async () => {
    try {
      return { status: 'ready', data: await parse(await fetch('/api/workspace/region', { cache: 'no-store' })) };
    } catch (error) {
      if (error instanceof RegionRequestError && error.status === 409) return { status: 'migration', message: error.message };
      if (error instanceof RegionRequestError && error.status === 403) return { status: 'local' };
      throw error;
    }
  },
};

export type RegionResult = { ok: true; data: RegionData } | { ok: false; message: string; migration: boolean };

export async function saveRegion(region: Region): Promise<RegionResult> {
  try {
    const data = await parse(await fetch('/api/workspace/region', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(region),
    }));
    setReadData<RegionState>(workspaceRegionRead, () => ({ status: 'ready', data }));
    return { ok: true, data };
  } catch (error) {
    if (error instanceof RegionRequestError) {
      const migration = error.status === 409;
      if (migration) setReadData<RegionState>(workspaceRegionRead, () => ({ status: 'migration', message: error.message }));
      return { ok: false, message: error.message, migration };
    }
    return { ok: false, message: 'Could not reach the server. Check your connection and try again.', migration: false };
  }
}

/** Common currencies first ("EUR, Euro, €"), then the current one if it is not among them. */
export function currencyOptions(current: string, locale: string): SelectOption[] {
  const codes: string[] = [...CURRENCIES];
  if (!codes.includes(current)) codes.unshift(current);
  return codes.map((code) => {
    const name = currencyName(code);
    const symbol = currencySymbol(code, locale);
    return {
      value: code,
      label: `${code}, ${name}`,
      detail: symbol !== code ? symbol : undefined,
      keywords: `${code} ${name} ${symbol}`,
    };
  });
}

/** Common locales ("English (United Kingdom)"), then the current one if it is not among them. */
export function localeOptions(current: string): SelectOption[] {
  const tags: string[] = [...LOCALES];
  if (!tags.includes(current)) tags.unshift(current);
  return tags.map((tag) => ({ value: tag, label: localeName(tag), detail: tag, keywords: `${tag} ${localeName(tag)}` }));
}
