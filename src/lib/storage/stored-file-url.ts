/**
 * Files the app keeps in its private buckets (pm-entity-files: project, lead
 * and contact files and invoice PDFs; pm-portal-files: portal update
 * attachments) are stored in the database by the public address Supabase
 * gave them at upload. Those buckets are private (20261127001200), so that
 * address no longer opens: the app opens them through /api/storage/file,
 * which checks the reader may open the record the file belongs to and then
 * redirects to a short signed link. The portal and the API sign them on the
 * server instead (sign-stored-file.ts).
 *
 * Safe in the browser and on the server: no secrets, no server imports.
 */

/** The private buckets, by every name they have had (pre-2.0 names first map to their pm- twin). */
const PRIVATE_BUCKETS: Record<string, PrivateBucket> = {
  'pm-entity-files': 'pm-entity-files',
  'pm-portal-files': 'pm-portal-files',
  'entity-files': 'pm-entity-files',
  'portal-files': 'pm-portal-files',
};

export type PrivateBucket = 'pm-entity-files' | 'pm-portal-files';

export interface StoredFile {
  /** The pm- bucket (an object still in the pre-2.0 bucket is found through it). */
  bucket: PrivateBucket;
  /** The object's path in the bucket, decoded. */
  path: string;
}

// Only the public address the app stored; a signed link already opens on its own.
const STORAGE_PATH = /^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/;

/**
 * The bucket and path of a stored file's address, or null when the address
 * is not one of this app's private files (an outside link, an avatar, '#').
 * Only addresses on this app's own Supabase project count, when it is known.
 */
export function parseStoredFileUrl(url: string | null | undefined, supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): StoredFile | null {
  if (!url || typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (supabaseUrl) {
    try {
      if (parsed.origin !== new URL(supabaseUrl).origin) return null;
    } catch {
      return null;
    }
  }
  const match = STORAGE_PATH.exec(parsed.pathname);
  if (!match) return null;
  const bucket = PRIVATE_BUCKETS[match[1]];
  if (!bucket) return null;
  let path: string;
  try {
    path = match[2].split('/').map((segment) => decodeURIComponent(segment)).join('/');
  } catch {
    return null;
  }
  const segments = path.split('/');
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..') || /[\u0000-\u001f\\]/.test(path)) return null;
  return { bucket, path };
}

/**
 * Where the browser opens a stored file: its address unchanged when it is
 * not one of the app's private files, otherwise /api/storage/file (a
 * redirect to a short signed link, after checking the reader may open it).
 * `download` asks for a download with the file's own name.
 */
export function storedFileHref(url: string | null | undefined, options: { download?: boolean } = {}): string {
  if (!url) return '';
  if (!parseStoredFileUrl(url)) return url;
  return `/api/storage/file?u=${encodeURIComponent(url)}${options.download ? '&download=1' : ''}`;
}
