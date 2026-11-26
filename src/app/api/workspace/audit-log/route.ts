import { NextResponse } from 'next/server';
import { badRequest, forbidden } from '@/lib/api/errors';
import { exportAuditRows, listAuditLog } from '@/lib/api/workspace-controls';
import { workspaceRoute } from '@/lib/api/workspace-route';
import { auditCsv } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

/**
 * Settings > Security > Audit log (Owner only): one page of the audit log,
 * newest first. Filters: member (who did it), acting_for (who it was done
 * for), action (text in the method, endpoint or entity type), from and to
 * (ISO times, to exclusive, as Settings sends the viewer's local days; or
 * YYYY-MM-DD, inclusive, UTC), page. Answers { entries, total, page,
 * page_size, names }. format=csv answers every matching row instead, as a
 * CSV download (the Export button; X-Truncated: true past the cap).
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner reads the audit log here', { reason: 'owner_only' });
    const searchParams = new URL(request.url).searchParams;
    const format = searchParams.get('format');
    if (format === null) return listAuditLog(service, searchParams);
    if (format !== 'csv') throw badRequest('format is csv');
    const { entries, names, truncated } = await exportAuditRows(service, searchParams);
    const day = new Date().toISOString().slice(0, 10);
    return new NextResponse(auditCsv(entries, names), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-log-${day}.csv"`,
        'X-Truncated': String(truncated),
        'X-Row-Count': String(entries.length),
        'Cache-Control': 'no-store',
      },
    });
  }, { noStore: true });
}
