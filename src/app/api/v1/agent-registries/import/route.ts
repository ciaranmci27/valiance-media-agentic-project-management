import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { importRegistries, registryImportSchema, type RegistryImport } from '@/lib/api/agent-registries';

export const dynamic = 'force-dynamic';

/**
 * Brings agent profiles and templates in from an exported document: each is
 * created, or updates (and brings back) the row with its key. A key code
 * holds is refused, never overridden, and so is an entry that fails a check;
 * both are listed in refused with why. dry_run true answers the plan and
 * writes nothing: run it first.
 *
 * Permission: team.manage, Owner only, with the AI agents module on.
 */
export const POST = withApi<RegistryImport>(async ({ supabase, body, access, teamMemberId, apiKeyId }) => {
  requireAgentsEnabled(access);
  const plan = await importRegistries(supabase, { memberId: teamMemberId, access }, body);
  if (!plan.dry_run) {
    logAudit(supabase, { method: 'POST', endpoint: '/api/v1/agent-registries/import', entityType: 'agent_registry', apiKeyId, teamMemberId, requestBody: { dry_run: false }, afterSnapshot: plan, statusCode: 200 });
  }
  return success(plan);
}, { schema: registryImportSchema, permission: 'team.manage' });
