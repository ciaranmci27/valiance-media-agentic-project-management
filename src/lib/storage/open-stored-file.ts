import { parseStoredFileUrl } from './stored-file-url';

type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };

/**
 * The access check (pm.storage_object_allowed) is not in the database yet:
 * new code running before 20261127001200 was applied. PostgREST answers
 * PGRST202 for a function it does not know; Postgres itself 42883.
 */
export function isMissingFunction(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883';
}

/**
 * Where /api/storage/file sends a signed-in member for a stored file's
 * address: a signed link when the database says they may read it, nothing
 * (404) when it says no or the address is not one of the app's files. Until
 * the migration that adds the check is applied, the buckets are still
 * public, so the stored address itself opens: the answer is that address.
 */
export async function storedFileRedirect(
  url: string | null | undefined,
  deps: {
    allowed: (bucket: string, path: string) => Promise<RpcAnswer>;
    sign: (url: string) => Promise<string | null>;
  },
): Promise<{ status: 302; location: string } | { status: 404 }> {
  const stored = parseStoredFileUrl(url);
  if (!url || !stored) return { status: 404 };
  const { data, error } = await deps.allowed(stored.bucket, stored.path);
  if (error) return isMissingFunction(error) ? { status: 302, location: url } : { status: 404 };
  if (data !== true) return { status: 404 };
  const signed = await deps.sign(url);
  return signed ? { status: 302, location: signed } : { status: 404 };
}
