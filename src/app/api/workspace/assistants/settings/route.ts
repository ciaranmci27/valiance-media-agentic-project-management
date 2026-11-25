import { readAssistantSettings, updateAssistantSettings } from '@/lib/api/assistant';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { forbidden } from '@/lib/api/errors';
import { assistantSettingsSchema } from '@/lib/assistant';

export const dynamic = 'force-dynamic';

/** Whether assistants are on and what the workspace calls them. Owner only. */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner manages assistants', { reason: 'owner_only' });
    return readAssistantSettings(service);
  }, { noStore: true });
}

/** Turns assistants on or off (enabled) and names them (label; null for the default). Owner only. */
export async function PATCH(request: Request) {
  return workspaceRoute(request, async ({ service, access, memberId }) => {
    const body = await readWorkspaceBody(request, assistantSettingsSchema);
    return updateAssistantSettings(service, access, memberId, body);
  }, { noStore: true });
}
