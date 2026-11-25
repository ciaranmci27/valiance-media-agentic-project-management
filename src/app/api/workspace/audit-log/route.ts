import { forbidden } from '@/lib/api/errors';
import { listAuditLog } from '@/lib/api/workspace-controls';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Settings > Security > Audit log (Owner only): one page of the audit log,
 * newest first. Filters: member (who did it), acting_for (who it was done
 * for), action (text in the method, endpoint or entity type), from and to
 * (YYYY-MM-DD, inclusive, UTC), page. Answers { entries, total, page,
 * page_size, names }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner reads the audit log here', { reason: 'owner_only' });
    return listAuditLog(service, new URL(request.url).searchParams);
  }, { noStore: true });
}
