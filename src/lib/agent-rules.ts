import { z } from 'zod';

/**
 * Per-agent rules: what an agent member may do on its own, beyond the
 * permissions it shares with people. Stored on team_members, meaningful only
 * for role 'agent' (people ignore them). The defaults are how agents behaved
 * before the rules existed, so an agent nobody configured sees no change.
 *
 * - agent_self_assign: may pick up (claim) unassigned work, which assigns it.
 * - agent_close_policy: 'close' finishes a task it sets to done; 'review'
 *   moves it to in_review instead, with a comment saying why.
 * - agent_create_policy: 'live' makes its new tasks live; 'approval' turns
 *   each into a task suggestion someone approves.
 * - agent_escalate_to: who it escalates to; unset falls back to the Owner.
 *
 * Which projects it works in and whether it may create tasks at all stay on
 * the shared permissions (tasks.create, project access).
 */

export const AGENT_CLOSE_POLICIES = ['close', 'review'] as const;
export const AGENT_CREATE_POLICIES = ['live', 'approval'] as const;
export type AgentClosePolicy = (typeof AGENT_CLOSE_POLICIES)[number];
export type AgentCreatePolicy = (typeof AGENT_CREATE_POLICIES)[number];

export interface AgentRules {
  agent_self_assign: boolean;
  agent_close_policy: AgentClosePolicy;
  agent_create_policy: AgentCreatePolicy;
  agent_escalate_to: string | null;
}

export const DEFAULT_AGENT_RULES: AgentRules = {
  agent_self_assign: true,
  agent_close_policy: 'close',
  agent_create_policy: 'live',
  agent_escalate_to: null,
};

export const AGENT_RULE_FIELDS = Object.keys(DEFAULT_AGENT_RULES) as (keyof AgentRules)[];

/** A change to an agent's rules: any of the four, at least one. */
export const agentRulesUpdateSchema = z.object({
  agent_self_assign: z.boolean().optional(),
  agent_close_policy: z.enum(AGENT_CLOSE_POLICIES).optional(),
  agent_create_policy: z.enum(AGENT_CREATE_POLICIES).optional(),
  agent_escalate_to: z.string().uuid('agent_escalate_to must be a team member id').nullable().optional(),
});
export type AgentRulesUpdate = z.infer<typeof agentRulesUpdateSchema>;

/** The plain labels the Team page shows, so the screen and the docs say the same. */
export const AGENT_RULE_LABELS = {
  agent_self_assign: 'Can pick up unassigned work',
  agent_close_policy: 'When it finishes',
  agent_create_policy: 'New tasks it creates',
  agent_escalate_to: 'Escalates to',
} as const;

export const CLOSE_POLICY_OPTIONS: { value: AgentClosePolicy; label: string; detail: string }[] = [
  { value: 'close', label: 'Close the task', detail: 'Setting a task to Done finishes it.' },
  { value: 'review', label: 'Send to review', detail: 'Done moves the task to In Review for a person to check.' },
];

export const CREATE_POLICY_OPTIONS: { value: AgentCreatePolicy; label: string; detail: string }[] = [
  { value: 'live', label: 'Go live', detail: 'New tasks appear on the board right away.' },
  { value: 'approval', label: 'Need approval', detail: 'Each new task waits in Suggestions until someone approves it.' },
];

/** The escalation picker's empty choice. */
export const ESCALATE_DEFAULT_LABEL = 'The Owner';

/** Reads the rules off a member row, filling what an older database lacks with the defaults. */
export function agentRulesOf(row: Partial<Record<keyof AgentRules, unknown>> | null | undefined): AgentRules {
  return {
    agent_self_assign: typeof row?.agent_self_assign === 'boolean' ? row.agent_self_assign : DEFAULT_AGENT_RULES.agent_self_assign,
    agent_close_policy: row?.agent_close_policy === 'review' ? 'review' : 'close',
    agent_create_policy: row?.agent_create_policy === 'approval' ? 'approval' : 'live',
    agent_escalate_to: typeof row?.agent_escalate_to === 'string' ? row.agent_escalate_to : null,
  };
}
