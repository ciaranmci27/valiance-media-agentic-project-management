import { forbidden } from '@/lib/api/errors';
import { dataRetentionSettings, setDataRetentionSettings } from '@/lib/api/data-retention';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { dataRetentionSchema } from '@/lib/data-retention';

export const dynamic = 'force-dynamic';

/**
 * Keeping data (Settings > Security): how long webhook deliveries, agent
 * uptime history, agent events, agent runs and chat message text are kept,
 * in days, or null to keep forever. Owner only. A daily job applies them.
 * Answers every setting.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner sees data retention', { reason: 'owner_only' });
    return dataRetentionSettings(service);
  }, { noStore: true });
}

export async function PUT(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner changes data retention', { reason: 'owner_only' });
    const body = await readWorkspaceBody(request, dataRetentionSchema);
    return setDataRetentionSettings(service, body);
  }, { noStore: true });
}
