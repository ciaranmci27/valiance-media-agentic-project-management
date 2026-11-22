import type { SupabaseClient } from '@supabase/supabase-js';
import { LEGACY_BUCKET, type BucketId } from './schema';

/**
 * Installs from before 2.0: copies every file from the old buckets into the
 * pm- ones, inside Supabase (no download), keeping each path. Files already
 * copied are skipped, so it is safe to run again (the build runs it after
 * the move, and `npm run storage:copy-to-pm` runs it by hand). The old
 * buckets stay as they are until 2.1: links already sent keep working.
 */

export interface CopyResult {
  bucket: string;
  copied: number;
  skipped: number;
  failed: string[];
}

const PAGE = 1000;
/** Copies at once: each is one request inside Supabase, well under its rate limits. */
const COPY_CONCURRENCY = 8;

async function listAll(client: SupabaseClient, bucket: string, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client.storage.from(bucket).list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`could not list ${bucket}/${prefix}: ${error.message}`);
    for (const entry of data ?? []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A folder has no id: list inside it.
      if (entry.id === null) paths.push(...(await listAll(client, bucket, path)));
      else paths.push(path);
    }
    if (!data || data.length < PAGE) break;
  }
  return paths;
}

const alreadyThere = (error: { message?: string; statusCode?: string | number } | null) =>
  !!error && (String(error.statusCode) === '409' || /already exists|duplicate/i.test(error.message ?? ''));

export async function copyLegacyBuckets(client: SupabaseClient, log: (line: string) => void = () => {}): Promise<CopyResult[]> {
  const { data: buckets, error } = await client.storage.listBuckets();
  if (error) throw new Error(`could not list buckets: ${error.message}`);
  const present = new Set((buckets ?? []).map((b) => b.id));
  const results: CopyResult[] = [];
  for (const [target, legacy] of Object.entries(LEGACY_BUCKET) as Array<[BucketId, string]>) {
    if (!present.has(legacy) || !present.has(target)) continue;
    const result: CopyResult = { bucket: target, copied: 0, skipped: 0, failed: [] };
    const paths = await listAll(client, legacy);
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const path = paths[next++];
        const copied = await client.storage.from(legacy).copy(path, path, { destinationBucket: target });
        if (!copied.error) result.copied += 1;
        else if (alreadyThere(copied.error as { message?: string; statusCode?: string | number })) result.skipped += 1;
        else result.failed.push(path);
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, paths.length) }, worker));
    log(`${legacy} -> ${target}: ${result.copied} copied, ${result.skipped} already there${result.failed.length ? `, ${result.failed.length} failed` : ''}`);
    results.push(result);
  }
  return results;
}
