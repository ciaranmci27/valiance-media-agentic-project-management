import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { exportAuditLog, parseAuditExportQuery } from '@/lib/api/audit-export';

export const dynamic = 'force-dynamic';

/**
 * Every audit row, in the order it was written, for a compliance or data
 * system: a page after cursor (since narrows to rows from an ISO time on)
 * and next_cursor to resume from. format=ndjson answers one row per line,
 * with the cursor in the X-Next-Cursor and X-Has-More headers. Needs
 * audit.export on key and member (Owners hold it).
 */
export const GET = withApi(async ({ supabase, searchParams }) => {
  const query = parseAuditExportQuery(searchParams);
  const page = await exportAuditLog(supabase, query);
  if (query.ndjson) {
    return new NextResponse(page.data.map((row) => JSON.stringify(row)).join('\n') + (page.data.length ? '\n' : ''), {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Next-Cursor': page.next_cursor,
        'X-Has-More': String(page.has_more),
        'Cache-Control': 'no-store',
      },
    });
  }
  return NextResponse.json({
    success: true,
    data: page.data,
    meta: { next_cursor: page.next_cursor, has_more: page.has_more, count: page.data.length },
  });
}, { permission: 'audit.export' });
