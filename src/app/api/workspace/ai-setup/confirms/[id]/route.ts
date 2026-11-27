import { z } from 'zod';
import { decideSetupConfirm } from '@/lib/api/ai-setup';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const decideSchema = z.object({ allow: z.boolean() }).strict();

/**
 * The signed-in Owner allows (allow true) or declines what their AI setup
 * session asked for: sensitive powers for a key it made, or a webhook to a
 * new address (made switched off). Answers the request as it now stands;
 * 409 already_decided the second time.
 *
 * Session only, never REST or MCP: this is a person confirming what an AI
 * asked for, so an AI or an API key must never be able to say yes to it
 * (the same reason starting a setup session is session only).
 */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, memberId, access }) => {
    const body = await readWorkspaceBody(request, decideSchema);
    return decideSetupConfirm(service, { memberId, access }, (await params).id, body.allow);
  }, { noStore: true });
}
