import { z } from 'zod';
import { aiSetupView, startConnectionSetup, startKeySetup } from '@/lib/api/ai-setup';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Set up agents with AI (Hire an agent, first screen): the signed-in
 * person's connected tools that could set agents up, their live and recent
 * sessions with the agents each made, and whether they may start one.
 * Answers AiSetupView. Polled while a session is live.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, access }) => aiSetupView(service, memberId, access, new URL(request.url).origin), { noStore: true });
}

const startSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connection'), grant_id: z.uuid('grant_id must be a connected app id') }).strict(),
  z.object({ kind: z.literal('key') }).strict(),
]);

/**
 * Starts a one-hour session (an Owner, as hiring is): kind connection lets
 * one of their connected tools use the agent setup tools with their powers;
 * kind key makes a setup key of their own, its secret in this answer only.
 * Starting again for the same tool, or another key, ends the earlier one.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, access, appUrl }) => {
    const body = await readWorkspaceBody(request, startSchema);
    if (body.kind === 'connection') return { session: await startConnectionSetup(service, access, memberId, body.grant_id) };
    return startKeySetup(service, access, memberId, appUrl);
  }, { status: 201, noStore: true });
}
