import { createAssistantSetup, listAssistantSetups } from '@/lib/api/personal-agents';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { createAssistantSetupSchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

/**
 * Assistant setups: which template a role or a group gets for its people's
 * personal agents, with default settings (name_template, title,
 * description, rules), on or off. Owner only, with AI agents on. GET answers
 * { setups }, roles first.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => ({ setups: await listAssistantSetups(service, caller) }));
}

/**
 * Adds a setup: match_role or match_group_id (exactly one), template_key
 * (default personal-assistant), settings, enabled (default true). 409
 * setup_exists when that role or group already has one with the template.
 * New people with the role get their agent when they join; everyone else is
 * provisioned with POST /api/workspace/assistants/provision.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, createAssistantSetupSchema);
    return createAssistantSetup(service, caller, body);
  }, { status: 201 });
}
