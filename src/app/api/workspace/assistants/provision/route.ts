import { provisionAssistants } from '@/lib/api/personal-agents';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { provisionAssistantsSchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

/**
 * Makes a personal agent for every active person an enabled setup matches
 * (by role, or by being in its group) who has none from its template.
 * Owner only. Idempotent; limit people per call (default 100, at most 500);
 * dry_run true writes nothing and pages with after (next_after). setup_id
 * runs one setup. Agents are made without keys: their harness collects each
 * key once (POST /api/v1/assistants/{id}/key). Answers what it made (or
 * would), total_missing and remaining.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, provisionAssistantsSchema);
    return provisionAssistants(service, caller, body);
  });
}
