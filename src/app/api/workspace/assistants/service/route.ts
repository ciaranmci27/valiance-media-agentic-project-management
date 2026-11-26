import { assistantServiceView, makeAssistantServiceKey } from '@/lib/api/assistant';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * The agent service that runs everyone's assistants: none (no key carries
 * assistants.provision), waiting (a key exists, nothing collected with it
 * yet) or connected, with its live keys (never a secret). Owner only.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => assistantServiceView(service, access), { noStore: true });
}

/**
 * Makes the agent service's key for the signed-in Owner, shown once:
 * assistants.provision and webhooks.manage, plus the scopes the assistants'
 * templates carry. Answers { key, secret, scopes }.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, access, memberId }) => makeAssistantServiceKey(service, access, memberId), { noStore: true });
}
