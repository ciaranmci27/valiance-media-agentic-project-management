import type { SupabaseClient } from '@supabase/supabase-js';
import { escalationRecipient } from './agent-rules';
import { ownerGroupIds } from './agent-owners';
import { activeGroupMembers } from './groups';
import { ApiError } from './errors';

/**
 * Who an agent may ask to approve something (deep security review of 2.0.50,
 * finding 4). An approval (request_approval, or a question that carries an
 * action the answer performs) from an agent goes only to:
 * - its managers: its owners in person and the members of its owner groups;
 * - its escalation target (a member, or a group and its members), which for
 *   a personal agent is its person;
 * - a person on the task's (or named) project who is not a guest;
 * - an agent in its orchestrator chain (its orchestrator, theirs, and up);
 * - an Owner.
 * Anyone else is refused (422 approver_not_allowed) with the people it may
 * ask, so a fooled agent cannot pick a newcomer, a client guest or another
 * agent to say yes. A plain question (no action) keeps today's reach,
 * except that an agent never asks a guest (422 asked_guest): a guest only
 * hears from the people who invited them.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export interface ApproverReach {
  members: Map<string, { name: string; why: string }>;
  groups: Map<string, string>;
}

const ORCHESTRATOR_DEPTH = 4;

async function names(db: SupabaseClient, ids: string[]): Promise<Map<string, Row>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from('team_members').select('id, name, role, status').in('id', [...new Set(ids)]);
  if (error) throw error;
  return new Map(((data ?? []) as Row[]).map((row) => [row.id as string, row]));
}

/** Everyone an agent may ask for an approval on this project (null: none named). */
export async function approverReach(db: SupabaseClient, agentId: string, projectId: string | null): Promise<ApproverReach> {
  const why = new Map<string, string>();
  const groups = new Map<string, string>();
  const add = (id: string | null | undefined, reason: string) => { if (id && id !== agentId && !why.has(id)) why.set(id, reason); };

  const { data: owners, error: ownersError } = await db.from('agent_owners').select('member_id').eq('agent_id', agentId);
  if (ownersError) throw ownersError;
  for (const row of (owners ?? []) as Row[]) add(row.member_id, 'manages it');
  for (const groupId of await ownerGroupIds(db, agentId)) {
    groups.set(groupId, 'manages it');
    for (const member of await activeGroupMembers(db, groupId, { peopleOnly: true })) add(member.id, 'manages it');
  }

  const recipient = await escalationRecipient(db, agentId);
  if (recipient?.kind === 'member') add(recipient.id, 'its escalation target');
  if (recipient?.kind === 'group') {
    groups.set(recipient.id, 'its escalation group');
    for (const member of await activeGroupMembers(db, recipient.id, { peopleOnly: true })) add(member.id, 'in its escalation group');
  }

  // Its orchestrator chain, at most four levels up (the hierarchy's own limit).
  let current = agentId;
  for (let depth = 0; depth < ORCHESTRATOR_DEPTH; depth++) {
    const { data, error } = await db.from('team_members').select('orchestrator_id').eq('id', current).maybeSingle();
    if (error) break; // a database before the hierarchy: no chain
    const next = (data as Row | null)?.orchestrator_id as string | null | undefined;
    if (!next || next === agentId || why.has(next)) break;
    add(next, 'its orchestrator');
    current = next;
  }

  if (projectId) {
    const { data, error } = await db.from('project_members').select('member_id').eq('project_id', projectId);
    if (error) throw error;
    for (const row of (data ?? []) as Row[]) add(row.member_id, 'on the project');
  }

  const { data: ownerRows, error: ownerError } = await db.from('team_members').select('id').eq('role', 'owner').eq('status', 'active');
  if (ownerError) throw ownerError;
  for (const row of (ownerRows ?? []) as Row[]) add(row.id, 'an Owner');

  // Only active members count; on the project, only people who are not guests.
  const rows = await names(db, [...why.keys()]);
  const members = new Map<string, { name: string; why: string }>();
  for (const [id, reason] of why) {
    const row = rows.get(id);
    if (!row || (row.status ?? 'active') !== 'active' || row.role === 'guest') continue;
    // People on the project only: an agent there is not an approver for that reason alone.
    if (reason === 'on the project' && row.role === 'agent') continue;
    members.set(id, { name: String(row.name ?? 'Someone'), why: reason });
  }
  return { members, groups };
}

/** The 422 for an approver outside the agent's reach, naming who it may ask. */
export function approverNotAllowed(reach: ApproverReach): ApiError {
  const allowed = [...reach.members].map(([id, m]) => ({ id, name: m.name, why: m.why }));
  const shown = allowed.slice(0, 12).map((m) => `${m.name} (${m.why})`).join(', ');
  return new ApiError(422, 'VALIDATION_ERROR', `You can ask for an approval only from your managers, your escalation target, people on the project, your orchestrator or an Owner. You may ask: ${shown || 'an Owner'}${allowed.length > 12 ? `, and ${allowed.length - 12} more` : ''}.`, {
    reason: 'approver_not_allowed',
    allowed: allowed.slice(0, 50),
    allowed_groups: [...reach.groups].map(([id, why]) => ({ id, why })),
    hint: 'Leave asked_to out to reach your escalation target, or name one of the people in allowed.',
  });
}

/**
 * Refuses an agent's approval (or a question that performs an action) to
 * anyone outside its reach, and any agent's question to a guest.
 */
export async function assertAgentMayAsk(
  db: SupabaseClient,
  agentId: string,
  addressee: { asked_to: string | null; asked_to_group: string | null },
  projectId: string | null,
  approval: boolean,
): Promise<void> {
  if (!approval) {
    if (!addressee.asked_to) return;
    const { data, error } = await db.from('team_members').select('role').eq('id', addressee.asked_to).maybeSingle();
    if (error) throw error;
    if ((data as Row | null)?.role === 'guest') {
      throw new ApiError(422, 'VALIDATION_ERROR', 'An agent does not ask guests: a guest hears only from the people who invited them. Ask someone on your team instead.', {
        reason: 'asked_guest',
        hint: 'Leave asked_to out to reach your escalation target.',
      });
    }
    return;
  }
  const reach = await approverReach(db, agentId, projectId);
  const allowed = addressee.asked_to ? reach.members.has(addressee.asked_to) : !!addressee.asked_to_group && reach.groups.has(addressee.asked_to_group);
  if (!allowed) throw approverNotAllowed(reach);
}
