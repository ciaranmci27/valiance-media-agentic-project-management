import { NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { InboxError, attachmentDownloadUrl } from '@/lib/inbound-email/inbox-service';

export const dynamic = 'force-dynamic';

/**
 * Opens a stored attachment in the browser: a redirect to a five-minute
 * signed link. Images inside an email's HTML and the attachment preview
 * load through this, so the link in the page never expires.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { service, access, memberId } = auth.data;
  try {
    const link = await attachmentDownloadUrl({ service, access, memberId }, id, { inline: true });
    const response = NextResponse.redirect(link.url, 302);
    response.headers.set('Cache-Control', 'private, max-age=240');
    return response;
  } catch (error) {
    if (error instanceof InboxError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[inbox] attachment view failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
