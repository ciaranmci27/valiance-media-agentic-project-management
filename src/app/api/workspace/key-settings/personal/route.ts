import { insertAuditRows } from '@/lib/api/audit';
import { forbidden } from '@/lib/api/errors';
import { personalKeyLifetimeDays, setPersonalKeyLifetimeDays } from '@/lib/api/key-lifetime';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { personalKeySettingsSchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

/**
 * How long a person's new key lasts unless they choose otherwise, and for
 * anyone but an Owner the longest they may choose (personal_key_lifetime_days;
 * null: until revoked, no limit, the default). Every
 * member reads it (the New key dialog starts from it); only an Owner changes
 * it. Keys made before keep their own expiry. Answers { personal_key_lifetime_days }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service }) => ({ personal_key_lifetime_days: await personalKeyLifetimeDays(service) }));
}

export async function PATCH(request: Request) {
  return workspaceRoute(request, async ({ service, access, memberId }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner changes key settings', { reason: 'owner_only' });
    const body = await readWorkspaceBody(request, personalKeySettingsSchema);
    const before = await personalKeyLifetimeDays(service);
    const days = await setPersonalKeyLifetimeDays(service, body.personal_key_lifetime_days);
    const { error } = await insertAuditRows(service, {
      method: 'PATCH', endpoint: '/api/workspace/key-settings/personal', entity_type: 'workspace_key_settings', team_member_id: memberId,
      before_snapshot: { personal_key_lifetime_days: before }, after_snapshot: { personal_key_lifetime_days: days }, status_code: 200, via: 'app',
    });
    if (error) console.error('[key-settings] audit write failed', error);
    return { personal_key_lifetime_days: days };
  });
}
