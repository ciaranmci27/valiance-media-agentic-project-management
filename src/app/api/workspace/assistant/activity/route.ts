import { myAssistantActivity } from '@/lib/api/assistant';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * What the signed-in person's assistant did in the last 30 days, newest
 * first, each line with its undo when one exists, and its reply drafts ready
 * for the person. Answers { items, drafts }.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, ({ service, memberId, access }) => myAssistantActivity(service, memberId, access), { noStore: true });
}
