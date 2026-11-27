import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { myPersonalAgents } from '@/lib/api/personal-agents';

export const dynamic = 'force-dynamic';

/**
 * The key's person's own personal agents, newest first, as Settings >
 * Account lists them: each with its template, status (paused_with_person
 * when it was paused with them) and live keys, never a secret. Answers
 * { assistants }, with the AI agents module on.
 *
 * Permission: tasks.read, on a person's own key.
 */
export const GET = withApi(async ({ supabase, access, teamMemberId }) => {
  assertPersonCaller(access);
  requireAgentsEnabled(access);
  return success({ assistants: await myPersonalAgents(supabase, teamMemberId) });
}, { permission: 'tasks.read' });
