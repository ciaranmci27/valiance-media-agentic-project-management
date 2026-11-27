import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { getServiceClient } from '@/lib/api/supabase-service';
import { storedFileRedirect } from '@/lib/storage/open-stored-file';
import { signStoredFileUrl } from '@/lib/storage/sign-stored-file';
import { parseStoredFileUrl } from '@/lib/storage/stored-file-url';

export const dynamic = 'force-dynamic';

/** Long enough to open or start a download, short enough that a copied link soon dies. */
const LINK_SECONDS = 300;

/**
 * Opens one of the app's private stored files (a project, lead or contact
 * file, an invoice PDF, a portal attachment) for a signed-in member: `u` is
 * the address stored with the record. The database decides whether this
 * member may read it (pm.storage_object_allowed, the rule the storage
 * policies apply), then the answer is a redirect to a five-minute signed
 * link. A file the member may not open answers exactly like a missing one.
 * Grids sign their thumbnails in one batch instead (useSignedFileUrls).
 */
export async function GET(request: NextRequest) {
  const session = await requireSessionAccess();
  if (session.error) return session.error;

  const url = request.nextUrl.searchParams.get('u');
  const download = request.nextUrl.searchParams.get('download') === '1';
  const fileName = parseStoredFileUrl(url)?.path.split('/').pop()?.replace(/^\d{10,}-/, '') || true;
  const answer = await storedFileRedirect(url, {
    allowed: async (bucket, path) => {
      const { data, error } = await session.data.client.rpc('storage_object_allowed', { p_bucket: bucket, p_name: path, p_action: 'read' });
      return { data, error };
    },
    sign: (stored) => signStoredFileUrl(getServiceClient(), stored, LINK_SECONDS, download ? { download: fileName } : {}),
  });
  if (answer.status === 404) {
    return NextResponse.json({ error: 'File not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const response = NextResponse.redirect(answer.location, 302);
  response.headers.set('Cache-Control', 'private, max-age=240');
  return response;
}
