import { restoreScopedEntries } from '@/lib/api/context-scopes';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { restoreEntriesSchema } from '@/lib/context-scopes';

export const dynamic = 'force-dynamic';

/** Undo of Clear: archived entries back, each in a scope the member may write. Answers { restored: [ids] }. */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, restoreEntriesSchema);
    return restoreScopedEntries(service, caller, body.entry_ids);
  });
}
