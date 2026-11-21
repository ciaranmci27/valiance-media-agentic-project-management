import 'server-only';
import { revalidatePath, revalidateTag, unstable_cache } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceClient } from '@/lib/api/supabase-service';
import { setActiveRegion } from './active';
import { WORKSPACE_REGION_COLUMNS, rowToRegion, type WorkspaceRegionRow } from './resolve';
import { DEFAULT_REGION, type Region } from './types';

/**
 * Server reads of the region. One cached read serves every page render,
 * email, PDF and portal response; saving in Settings > Workspace > Region
 * expires it (expireRegion), so a change shows on the next request.
 */

export const REGION_CACHE_TAG = 'workspace-region';

function isDemo(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || process.env.DEMO_MODE === 'true';
}

export interface StoredRegion {
  region: Region;
  /** False when the region table is not there yet (the 1.7.0 migration has not run). */
  tableReady: boolean;
}

function isSchemaMissing(error: { code?: string | null; message?: string | null }): boolean {
  if (['42P01', 'PGRST205'].includes(error.code || '')) return true;
  const message = (error.message || '').toLowerCase();
  return message.includes('workspace_region') && (message.includes('does not exist') || message.includes('schema cache'));
}

/**
 * The stored region, uncached. A missing table reads as the default (USD,
 * en-US, Monday: what the app always used). Throws on any other database
 * error, so a blip never caches the default in place of the real region.
 */
export async function readStoredRegion(client: SupabaseClient = getServiceClient()): Promise<StoredRegion> {
  const read = () => client.from('workspace_region').select(WORKSPACE_REGION_COLUMNS).limit(1).maybeSingle();
  let result = await read();
  if (result.error && !isSchemaMissing(result.error)) result = await read();
  if (result.error && !isSchemaMissing(result.error)) throw new Error(`Region read failed: ${result.error.message}`);
  return {
    region: result.error ? { ...DEFAULT_REGION } : rowToRegion(result.data as WorkspaceRegionRow | null),
    tableReady: !result.error,
  };
}

const cachedStoredRegion = unstable_cache(() => readStoredRegion(), ['workspace-region-v1'], {
  tags: [REGION_CACHE_TAG],
  // A backstop only: saving expires the tag at once.
  revalidate: 3600,
});

/**
 * The region every screen, email and PDF uses. Never throws: with no
 * database (a build without credentials, the demo workspace) or a failed
 * read it is the default, and a failed read is not cached.
 */
export async function getRegion(): Promise<Region> {
  if (isDemo() || !process.env.NEXT_PUBLIC_SUPABASE_URL) return DEFAULT_REGION;
  let region: Region;
  try {
    let stored: StoredRegion;
    try {
      stored = await cachedStoredRegion();
    } catch (error) {
      // Outside a Next.js request (scripts, tests) there is no cache to use: read directly.
      if (!String((error as Error)?.message ?? '').includes('incrementalCache missing')) throw error;
      stored = await readStoredRegion();
    }
    region = stored.region;
  } catch (error) {
    console.error('[region] read failed, using the default region', error);
    return DEFAULT_REGION;
  }
  // One workspace per install: plain format calls on the server follow it too.
  setActiveRegion(region);
  return region;
}

/** Expire every cached copy of the region: the read, and the rendered layout. */
export function expireRegion(): void {
  revalidateTag(REGION_CACHE_TAG, { expire: 0 });
  revalidatePath('/', 'layout');
}
