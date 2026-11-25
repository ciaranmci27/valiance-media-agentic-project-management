import { forbidden } from '@/lib/api/errors';
import { auditSettings, setAuditSettings } from '@/lib/api/workspace-controls';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { auditSettingsSchema } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

/**
 * How long the audit log keeps rows (retention_days, 30 to 3650; null keeps
 * them forever) and the workspace's own field names to redact beside the
 * built-in list (redact_keys). Owner only; a change is itself audited.
 * Answers { retention_days, redact_keys }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner sees audit settings', { reason: 'owner_only' });
    return auditSettings(service);
  }, { noStore: true });
}

export async function PUT(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner changes audit settings', { reason: 'owner_only' });
    const body = await readWorkspaceBody(request, auditSettingsSchema);
    return setAuditSettings(service, body);
  }, { noStore: true });
}
