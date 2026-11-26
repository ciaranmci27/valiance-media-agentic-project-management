import { z } from 'zod';
import { forbidden } from '@/lib/api/errors';
import { connectAiState, setApiEnabled, setConnectAiEnabled } from '@/lib/api/connect-ai';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

const connectAiSchema = z.object({ enabled: z.boolean().optional(), api_enabled: z.boolean().optional() }).strict()
  .refine((body) => body.enabled !== undefined || body.api_enabled !== undefined, 'Send enabled or api_enabled');

/**
 * Settings > Security's two workspace switches. "Let people connect AI
 * tools" (business_settings.connect_ai_enabled, on by default): off, AI
 * tools cannot sign in and connected ones get 403 until it is on again
 * (their connections are kept). "API access" (business_settings.api_enabled,
 * on by default): off, every API key and connected tool is refused (403
 * api_disabled), nothing revoked. Any member but a guest reads them; only an
 * Owner changes either. Answers { ready, enabled, api_enabled } (ready: the
 * Connect AI migration has run).
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service }) => {
    const state = await connectAiState(service);
    return { ready: state.ready, enabled: state.ready && state.enabled, api_enabled: state.apiEnabled };
  }, { noStore: true });
}

export async function PUT(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner turns API access or connecting AI tools on or off', { reason: 'owner_only' });
    const body = await readWorkspaceBody(request, connectAiSchema);
    let state = await connectAiState(service);
    if (body.api_enabled !== undefined) state = await setApiEnabled(service, body.api_enabled);
    if (body.enabled !== undefined) state = await setConnectAiEnabled(service, body.enabled);
    return { ready: state.ready, enabled: state.ready && state.enabled, api_enabled: state.apiEnabled };
  }, { noStore: true });
}
