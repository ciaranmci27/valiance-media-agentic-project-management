import type { SupabaseClient } from '@supabase/supabase-js';
import { AGENT_RULE_FIELDS, agentRulesOf, type AgentRules, type AgentRulesUpdate } from '@/lib/agent-rules';
import { insertComment } from '@/lib/supabase/queries';
import { firstActiveOwner } from './agent-owners';
import { ApiError } from './errors';

/** A member with the rules that apply to them: an agent's own, or the defaults for a person. */
export interface MemberRules {
  id: string;
  name: string;
  role: string;
  isAgent: boolean;
  rules: AgentRules;
}

const missingColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || /does not exist|schema cache/i.test(error.message ?? ''));

/**
 * The member's rules. People always get the defaults (the rules are for
 * agents). A database without the rules columns yet (new code deployed
 * before its migration) reads as the defaults too, which is how every agent
 * behaved before them.
 */
export async function loadMemberRules(supabase: SupabaseClient, memberId: string): Promise<MemberRules> {
  const columns = ['id', 'name', 'role', ...AGENT_RULE_FIELDS].join(', ');
  let { data, error } = await supabase.from('team_members').select(columns).eq('id', memberId).maybeSingle();
  if (missingColumn(error)) {
    ({ data, error } = await supabase.from('team_members').select('id, name, role').eq('id', memberId).maybeSingle());
  }
  if (error) throw error;
  const row = (data ?? {}) as unknown as Record<string, unknown>;
  const isAgent = row.role === 'agent';
  return {
    id: memberId,
    name: typeof row.name === 'string' ? row.name : 'This agent',
    role: typeof row.role === 'string' ? row.role : 'member',
    isAgent,
    rules: agentRulesOf(isAgent ? (row as Partial<Record<keyof AgentRules, unknown>>) : null),
  };
}

/** What a close policy did to a status change, for the response and the comment. */
export interface CloseOutcome {
  status: string | undefined;
  sentToReview: boolean;
}

/**
 * An agent whose close policy is review cannot finish a task: done becomes
 * in_review. Anything else passes through unchanged.
 */
export function applyClosePolicy(member: MemberRules, status: string | undefined, currentStatus?: string): CloseOutcome {
  if (status === 'done' && currentStatus !== 'done' && member.isAgent && member.rules.agent_close_policy === 'review') {
    return { status: 'in_review', sentToReview: true };
  }
  return { status, sentToReview: false };
}

export const sentToReviewNote = (member: MemberRules) =>
  `Sent to review instead of done: ${member.name}'s rules have a person check its finished work.`;

/** The comment that says why a task went to review instead of done, under the agent's name. */
export async function commentSentToReview(supabase: SupabaseClient, taskId: string, member: MemberRules) {
  await insertComment(supabase, taskId, member.id, sentToReviewNote(member));
}

/**
 * Who an agent escalates to: its own agent_escalate_to while that member is
 * active, else its first active owner (pm.agent_owners, oldest first), else
 * the workspace Owner (the oldest active one). Projects have no lead in this
 * schema, so there is no project step. Null only when the workspace has no
 * active Owner.
 */
export async function escalationTarget(supabase: SupabaseClient, memberId: string): Promise<string | null> {
  const member = await loadMemberRules(supabase, memberId);
  const chosen = member.isAgent ? member.rules.agent_escalate_to : null;
  if (chosen) {
    const { data } = await supabase.from('team_members').select('id').eq('id', chosen).eq('status', 'active').maybeSingle();
    if (data) return chosen;
  }
  if (member.isAgent) {
    const owner = await firstActiveOwner(supabase, memberId);
    if (owner) return owner;
  }
  const { data: owners, error } = await supabase
    .from('team_members')
    .select('id')
    .eq('role', 'owner')
    .eq('status', 'active')
    .order('created_at')
    .limit(1);
  if (error) throw error;
  return ((owners ?? []) as { id: string }[])[0]?.id ?? null;
}

/**
 * Checks a change to a member's rules and returns the columns to write. The
 * rules are only for agent members (after this save's role, if it changes
 * one), and an agent escalates to another active member, never itself.
 * Throws ApiError (422) with a plain message otherwise.
 */
export async function agentRulesColumns(
  supabase: SupabaseClient,
  target: { id: string; role: string },
  update: AgentRulesUpdate,
): Promise<Partial<AgentRules>> {
  const columns: Partial<AgentRules> = {};
  for (const field of AGENT_RULE_FIELDS) {
    if (update[field] !== undefined) (columns as Record<string, unknown>)[field] = update[field];
  }
  if (Object.keys(columns).length === 0) return columns;
  if (target.role !== 'agent') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Agent rules apply only to agent members');
  }
  if (columns.agent_escalate_to) {
    if (columns.agent_escalate_to === target.id) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'An agent cannot escalate to itself');
    }
    const { data } = await supabase
      .from('team_members')
      .select('id')
      .eq('id', columns.agent_escalate_to)
      .eq('status', 'active')
      .maybeSingle();
    if (!data) throw new ApiError(422, 'VALIDATION_ERROR', 'agent_escalate_to must be an active team member');
  }
  return columns;
}
