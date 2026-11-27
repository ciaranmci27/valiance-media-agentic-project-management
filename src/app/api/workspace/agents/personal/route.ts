import { hirePersonalAssistant, hirePersonalSchema } from '@/lib/api/personal-hire';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Hire a personal assistant for one person (the hire screen's personal
 * path): made from the Personal assistant template, without a key; when
 * they already have one it is answered with created false. Owner only,
 * with assistants on (lib/api/personal-hire.ts).
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, hirePersonalSchema);
    return hirePersonalAssistant(service, caller, body);
  });
}
