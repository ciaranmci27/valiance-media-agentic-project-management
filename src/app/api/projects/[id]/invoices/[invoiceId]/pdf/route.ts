import { NextResponse } from 'next/server';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';
import { buildInvoicePdfAttachment } from '@/lib/email/client-notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function contentDispositionFilename(filename: string): string {
  return filename.replace(/["\r\n]/g, '');
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; invoiceId: string }> },
) {
  const { id: projectId, invoiceId } = await ctx.params;
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const canReadInvoices = accessAllows(auth.data.access, 'invoices.read')
    || accessAllows(auth.data.access, 'invoices.manage');
  if (!canReadInvoices || !accessAllowsProject(auth.data.access, projectId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // `?theme=paper` asks for the print version on white; the dark canvas is the default.
  const theme = new URL(req.url).searchParams.get('theme') === 'paper' ? 'paper' : 'dark';
  const attachment = await buildInvoicePdfAttachment(projectId, invoiceId, auth.data.memberId, theme);
  if ('error' in attachment) {
    return NextResponse.json({ error: attachment.error }, { status: 400 });
  }

  const body = new Uint8Array(attachment.content);
  return new NextResponse(body, {
    headers: {
      'Content-Type': attachment.contentType,
      'Content-Length': String(body.byteLength),
      'Content-Disposition': `inline; filename="${contentDispositionFilename(attachment.filename)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
