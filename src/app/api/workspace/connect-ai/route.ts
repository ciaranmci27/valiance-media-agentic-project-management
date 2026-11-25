import { z } from 'zod';
import { forbidden } from '@/lib/api/errors';
import { connectAiState, setConnectAiEnabled } from '@/lib/api/connect-ai';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

const connectAiSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * "Let people connect AI tools" (business_settings.connect_ai_enabled, on by
 * default). Any member but a guest reads it; only an Owner changes it,
 * written as them so the audit log records who. Off, AI tools cannot sign
 * in and connected ones get 403 until it is on again (their connections are
 * kept). Answers { ready, enabled, api_enabled } (ready: the migration has run).
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service }) => {
    const state = await connectAiState(service);
    return { ready: state.ready, enabled: state.ready && state.enabled, api_enabled: state.apiEnabled };
  }, { noStore: true });
}

export async function PUT(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner turns connecting AI tools on or off', { reason: 'owner_only' });
    const body = await readWorkspaceBody(request, connectAiSchema);
    const state = await setConnectAiEnabled(service, body.enabled);
    return { ready: state.ready, enabled: state.ready && state.enabled, api_enabled: state.apiEnabled };
  }, { noStore: true });
}
