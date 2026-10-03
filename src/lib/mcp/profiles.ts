/**
 * Agent profiles decide which MCP tools an agent member sees. Only the
 * generic tool set exists today; the four named profiles are the fleet's
 * roles, and each gets its own tools when its Hermes plugin moves to the MCP
 * server. Until then a named profile sees the generic set. The key's scopes
 * and the member's permissions still filter every list, and every call still
 * runs through withApi, so a profile can only narrow what a key could do.
 */
export const AGENT_PROFILES = [
  {
    value: 'generic',
    label: 'Generic',
    description: 'The standard tool set, for new agents and other MCP clients.',
  },
  {
    value: 'coordinator',
    label: 'Coordinator',
    description: 'Plans and assigns work, keeps projects and leads current (Ashley).',
  },
  {
    value: 'builder',
    label: 'Builder',
    description: 'Works assigned tasks, tracks time and raises blockers (Jeff).',
  },
  {
    value: 'auditor',
    label: 'Auditor',
    description: 'Audits projects against their goals and proposes tasks (Greg).',
  },
  {
    value: 'reviewer',
    label: 'Reviewer',
    description: 'Reviews finished work and records verdicts (John).',
  },
] as const;

export type AgentProfile = (typeof AGENT_PROFILES)[number]['value'];

export const AGENT_PROFILE_VALUES: readonly AgentProfile[] = AGENT_PROFILES.map((profile) => profile.value);

export function isAgentProfile(value: unknown): value is AgentProfile {
  return typeof value === 'string' && (AGENT_PROFILE_VALUES as readonly string[]).includes(value);
}
