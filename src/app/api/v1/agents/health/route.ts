import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { agentHealthReportSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { badRequest } from '@/lib/api/errors';

/**
 * Infrastructure heartbeats from the VPS publisher.
 *
 * This is the app's only authoritative view of agent liveness: whether each
 * container is up and whether a turn is executing right now, straight from
 * the same sources the deploy tooling trusts (docker state and the agents'
 * execution ledgers). Prose in agent_activities stays the narrative layer;
 * this feed decides working / idle / offline.
 *
 * Upsert-in-place by design: the table holds current state, one row per
 * agent, and readers treat a stale reported_at as an outage because the
 * publisher promises a beat every minute. That contract is why this endpoint
 * never accepts partial silence as normal: a publisher that can only report
 * some agents still reports the others' containers as down, which is the
 * truth as far as it can see.
 *
 * Permission: agents.manage, explicitly. The path does not contain the
 * substrings the permission inference recognizes, and defaulting a write
 * to projects.manage would let a broader key than intended feed this table.
 */
export const POST = withApi<z.infer<typeof agentHealthReportSchema>>(async ({ supabase, body }) => {
  requireAgentsEnabled();

  // Body arrives schema-validated: withApi parses and enforces the zod
  // schema passed in the options below before the handler runs.
  const { reports } = body;

  // Every reported id must be a real agent member: this table drives status
  // UI for the whole fleet, and a typo'd uuid silently upserting a ghost row
  // would render a phantom agent forever.
  const ids = [...new Set(reports.map((r) => r.member_id))];
  const { data: members, error: memberError } = await supabase
    .from('team_members')
    .select('id, role')
    .in('id', ids);
  if (memberError) throw memberError;
  const agentIds = new Set((members || []).filter((m) => m.role === 'agent').map((m) => m.id));
  const unknown = ids.filter((id) => !agentIds.has(id));
  if (unknown.length > 0) {
    throw badRequest(`Not agent team members: ${unknown.join(', ')}`);
  }

  const now = new Date().toISOString();
  const { error } = await supabase.from('agent_health').upsert(
    reports.map((r) => ({
      member_id: r.member_id,
      container: r.container,
      container_running: r.container_running,
      turn_running: r.turn_running,
      turn_started_at: r.turn_started_at ?? null,
      reported_at: now,
    })),
    { onConflict: 'member_id' }
  );
  if (error) throw error;

  return success({ reported: reports.length, reported_at: now });
}, { schema: agentHealthReportSchema, permission: 'agents.manage' });
