import 'server-only';
import { revalidatePath, revalidateTag, unstable_cache } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceClient } from '@/lib/api/supabase-service';
import { DEFAULT_BRAND } from './defaults';
import { EMPTY_BRAND_SETTINGS, WORKSPACE_BRAND_COLUMNS, resolveBrand, rowToSettings, type WorkspaceBrandRow } from './resolve';
import type { Brand, BrandSettings } from './types';

/**
 * Server reads of the brand. One cached read serves every page render, email,
 * PDF and portal response; saving in Settings > Workspace > Brand expires it
 * (expireBrand), so a change shows on the next request.
 */

export const BRAND_CACHE_TAG = 'workspace-brand';

function isDemo(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || process.env.DEMO_MODE === 'true';
}

export interface StoredBrand {
  settings: BrandSettings;
  /** False when the brand table is not there yet (the migration has not run). */
  tableReady: boolean;
}

function isSchemaMissing(error: { code?: string | null; message?: string | null }): boolean {
  if (['42P01', 'PGRST205'].includes(error.code || '')) return true;
  const message = (error.message || '').toLowerCase();
  return message.includes('workspace_brand') && (message.includes('does not exist') || message.includes('schema cache'));
}

/**
 * The stored brand, uncached. Throws on a database error other than a missing
 * table, so a blip never caches the neutral default in place of the real brand.
 */
export async function readStoredBrand(client: SupabaseClient = getServiceClient()): Promise<StoredBrand> {
  const read = () => client.from('workspace_brand').select(WORKSPACE_BRAND_COLUMNS).limit(1).maybeSingle();
  let brand = await read();
  // One more try on a blip before giving up.
  if (brand.error && !isSchemaMissing(brand.error)) brand = await read();
  if (brand.error && !isSchemaMissing(brand.error)) throw new Error(`Brand read failed: ${brand.error.message}`);
  return {
    settings: brand.error ? { ...EMPTY_BRAND_SETTINGS } : rowToSettings(brand.data as WorkspaceBrandRow | null),
    tableReady: !brand.error,
  };
}

const cachedStoredBrand = unstable_cache(() => readStoredBrand(), ['workspace-brand-v1'], {
  tags: [BRAND_CACHE_TAG],
  // A backstop only: saving expires the tag at once.
  revalidate: 3600,
});

/**
 * The brand every screen, email and PDF shows. Never throws: with no database
 * (a build without credentials, the demo workspace) or a failed read it is
 * core's default, and a failed read is not cached.
 */
export async function getBrand(): Promise<Brand> {
  if (isDemo() || !process.env.NEXT_PUBLIC_SUPABASE_URL) return DEFAULT_BRAND;
  try {
    let stored: StoredBrand;
    try {
      stored = await cachedStoredBrand();
    } catch (error) {
      // Outside a Next.js request (scripts, tests) there is no cache to use: read directly.
      if (!String((error as Error)?.message ?? '').includes('incrementalCache missing')) throw error;
      stored = await readStoredBrand();
    }
    return resolveBrand(stored.settings);
  } catch (error) {
    console.error('[brand] read failed, showing the default brand', error);
    return DEFAULT_BRAND;
  }
}

/** Expire every cached copy of the brand: the read, and the rendered layout. */
export function expireBrand(): void {
  revalidateTag(BRAND_CACHE_TAG, { expire: 0 });
  revalidatePath('/', 'layout');
}
