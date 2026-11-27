import type { SupabaseClient } from '@supabase/supabase-js';
import { LEGACY_BUCKET } from '@/lib/supabase/schema';
import { pmStorage } from '@/lib/supabase/storage';
import { parseStoredFileUrl, type PrivateBucket } from './stored-file-url';

/**
 * Short signed links for the app's private stored files (see
 * stored-file-url.ts), made with a client that may read the bucket (a service
 * client, or a member's own session, whose storage policies then decide).
 * The caller has already decided the reader may open them (the portal's
 * token, an API key's scope, a session's storage_object_allowed).
 *
 * One storage call per bucket, however many files: a grid of thumbnails is
 * one request. A file still in its pre-2.0 bucket is signed there. Any other
 * address maps to itself; a stored file that cannot be signed maps to null.
 */
export async function signStoredFileUrls(
  client: SupabaseClient,
  urls: (string | null | undefined)[],
  expiresInSeconds: number,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const byBucket = new Map<PrivateBucket, Map<string, string[]>>();
  for (const url of urls) {
    if (!url || out.has(url)) continue;
    const stored = parseStoredFileUrl(url);
    if (!stored) {
      out.set(url, url);
      continue;
    }
    out.set(url, null);
    const paths = byBucket.get(stored.bucket) ?? new Map<string, string[]>();
    paths.set(stored.path, [...(paths.get(stored.path) ?? []), url]);
    byBucket.set(stored.bucket, paths);
  }
  await Promise.all([...byBucket].map(async ([bucket, paths]) => {
    const sign = async (bucketName: string, wanted: string[]) => {
      try {
        // trash-checked: a Storage bucket, not a table.
        const { data, error } = await client.storage.from(bucketName).createSignedUrls(wanted, expiresInSeconds);
        if (error || !data) return;
        for (const item of data) {
          if (item.error || !item.signedUrl || !item.path) continue;
          for (const url of paths.get(item.path) ?? []) out.set(url, item.signedUrl);
        }
      } catch {
        // Left unsigned (null): the caller keeps the stored address or the checked route.
      }
    };
    await sign(bucket, [...paths.keys()]);
    const missing = [...paths].filter(([, list]) => list.some((url) => out.get(url) === null)).map(([path]) => path);
    if (missing.length) await sign(LEGACY_BUCKET[bucket], missing);
  }));
  return out;
}

/**
 * One signed link (see signStoredFileUrls), optionally as a download with a
 * file name. Any other address comes back unchanged; a stored file that
 * cannot be signed comes back as null.
 */
export async function signStoredFileUrl(
  service: SupabaseClient,
  url: string | null | undefined,
  expiresInSeconds: number,
  options: { download?: string | boolean } = {},
): Promise<string | null> {
  if (!url) return url ?? null;
  const stored = parseStoredFileUrl(url);
  if (!stored) return url;
  if (!options.download) return (await signStoredFileUrls(service, [url], expiresInSeconds)).get(url) ?? null;
  // trash-checked: a Storage bucket, not a table.
  const { data, error } = await pmStorage(service).from(stored.bucket)
    .createSignedUrl(stored.path, expiresInSeconds, { download: options.download });
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** The rows with their `file_url` signed (the stored address kept when it is not a private file or cannot be signed). */
export async function signFileUrls<T extends { file_url?: string | null }>(client: SupabaseClient, rows: T[], expiresInSeconds: number): Promise<T[]> {
  const signed = await signStoredFileUrls(client, rows.map((row) => row.file_url), expiresInSeconds);
  return rows.map((row) => (row.file_url && parseStoredFileUrl(row.file_url) ? { ...row, file_url: signed.get(row.file_url) ?? row.file_url } : row));
}

/** The rows with a `download_url`: a signed link for a private stored file, else the stored address (null for none). */
export async function withDownloadUrls<T extends { file_url?: string | null }>(client: SupabaseClient, rows: T[], expiresInSeconds: number): Promise<(T & { download_url: string | null })[]> {
  const usable = rows.map((row) => (row.file_url && row.file_url !== '#' ? row.file_url : null));
  const signed = await signStoredFileUrls(client, usable, expiresInSeconds);
  return rows.map((row, i) => ({ ...row, download_url: usable[i] ? signed.get(usable[i]!) ?? null : null }));
}
