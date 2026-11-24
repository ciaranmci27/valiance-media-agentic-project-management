import { z } from 'zod';
import { defineAgentProfiles, mergeAgentProfiles, type AgentProfileDefinition } from '@/lib/extensions/agent-profiles';
import customProfiles from '@/custom/agent-profiles';

/**
 * Agent profiles decide which MCP tools an agent member sees: a registry of
 * core's profiles, then the install's own (src/custom/agent-profiles.ts). The
 * key's scopes and the member's permissions still filter every list, and
 * every call still runs through withApi, so a profile can only narrow what a
 * key could do.
 *
 * Core's five see every tool their keys allow. Four carry role names (a
 * coordinator plans and assigns, a builder does assigned work, an auditor
 * checks projects against their goals, a reviewer reviews finished work):
 * any install may use them, and a profile of an install's own lists the tools
 * it sees. Stored values never change: a profile is renamed only by adding a
 * new one.
 *
 * A stored value the registry does not know (an install's profile that was
 * removed) sees only pm_guide until an Owner picks another: it never falls
 * back to more tools.
 */
export const CORE_AGENT_PROFILES: AgentProfileDefinition[] = defineAgentProfiles([
  {
    value: 'generic',
    label: 'Generic',
    description: 'The standard tool set, for new agents and other MCP clients.',
  },
  {
    value: 'coordinator',
    label: 'Coordinator',
    description: 'Plans and assigns work, keeps projects and leads current',
  },
  {
    value: 'builder',
    label: 'Builder',
    description: 'Works assigned tasks, tracks time and raises blockers',
  },
  {
    value: 'auditor',
    label: 'Auditor',
    description: 'Audits projects against their goals and proposes tasks',
  },
  {
    value: 'reviewer',
    label: 'Reviewer',
    description: 'Reviews finished work and records verdicts',
  },
]);

/** Every profile: core's, then the install's. */
export const AGENT_PROFILES: AgentProfileDefinition[] = mergeAgentProfiles(CORE_AGENT_PROFILES, customProfiles);

/** A profile's value, as team_members.agent_profile stores it. */
export type AgentProfile = string;

export const AGENT_PROFILE_VALUES: readonly AgentProfile[] = AGENT_PROFILES.map((profile) => profile.value);

/** Whether a value names a profile in the registry: what a write accepts. */
export function isAgentProfile(value: unknown): value is AgentProfile {
  return typeof value === 'string' && AGENT_PROFILES.some((profile) => profile.value === value);
}

/** A profile value on a write: one the registry holds, anything else refused. */
export const agentProfileSchema = z.string().refine(isAgentProfile, {
  error: () => `agent_profile must be one of: ${AGENT_PROFILES.map((profile) => profile.value).join(', ')}`,
});

export function agentProfileDefinition(value: string): AgentProfileDefinition | null {
  return AGENT_PROFILES.find((profile) => profile.value === value) ?? null;
}

/**
 * Whether a profile sees a tool, before the key's scopes are asked. Core's
 * profiles see them all; an install's sees the ones it lists; an unknown
 * value sees none (pm_guide is the caller's to add).
 */
export function profileSeesTool(profile: AgentProfile, toolName: string): boolean {
  const definition = agentProfileDefinition(profile);
  if (!definition) return false;
  return !definition.tools || definition.tools.includes(toolName);
}
