import { assistantStatusList } from '@/lib/api/assistant';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Every person's assistant with its state (working, paused by its person,
 * getting ready, broken and why), broken ones first. Owner only. Answers
 * { assistants }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => ({ assistants: await assistantStatusList(service, access) }), { noStore: true });
}
