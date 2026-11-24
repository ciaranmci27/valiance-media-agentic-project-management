import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { listAgentTemplates } from '@/lib/agent-templates';

/**
 * The agent templates this install offers: core's, then its own from
 * src/custom/agent-templates.ts. Each has a key, label, description, the
 * rules it sets, the scopes a key for it should carry, the brief added to
 * the agent's context pack and suggested webhook events. A template whose
 * module is off is not listed. Apply one with POST /api/v1/agents/{id}/template.
 *
 * Permission: team.manage, with the AI agents module on.
 */
export const GET = withApi(async ({ access }) => {
  requireAgentsEnabled(access);
  return success(listAgentTemplates(access).map((template) => ({
    key: template.key,
    label: template.label,
    description: template.description,
    rules: template.rules,
    scopes: template.scopes,
    context: template.context,
    webhook_events: template.webhook_events ?? [],
    module: template.module ?? null,
  })));
}, { permission: 'team.manage' });
