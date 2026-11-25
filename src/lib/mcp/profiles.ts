import { z } from 'zod';
import { AGENT_PROFILE_VALUE, defineAgentProfiles, mergeAgentProfiles, type AgentProfileDefinition } from '@/lib/extensions/agent-profiles';
import customProfiles from '@/custom/agent-profiles';

/**
 * Agent profiles decide which MCP tools an agent member sees: a registry of
 * core's profiles, then the install's own (src/custom/agent-profiles.ts),
 * then an Owner's own as rows (pm.mcp_profile_rows, merged on the server by
 * lib/api/agent-registries.ts). The key's scopes and the member's
 * permissions still filter every list, and every call still runs through
 * withApi, so a profile can only narrow what a key could do.
 *
 * Core keeps one, generic, which sees every tool its keys allow. The fleet's
 * role profiles (coordinator, builder, auditor, reviewer) are no longer
 * core's: an install that used them has them as rows with the same tool set.
 * Stored values never change: a profile is renamed only by adding a new one.
 *
 * A stored value no registry knows (a profile that was removed or archived)
 * sees only pm_guide until an Owner picks another: it never falls back to
 * more tools.
 */
export const CORE_AGENT_PROFILES: AgentProfileDefinition[] = defineAgentProfiles([
  {
    value: 'generic',
    label: 'Generic',
    description: 'The standard tool set, for new agents and other MCP clients.',
  },
]);

/** Every profile in code: core's, then the install's. An Owner's rows are merged on the server. */
export const AGENT_PROFILES: AgentProfileDefinition[] = mergeAgentProfiles(CORE_AGENT_PROFILES, customProfiles);

/** A profile's value, as team_members.agent_profile stores it. */
export type AgentProfile = string;

export const AGENT_PROFILE_VALUES: readonly AgentProfile[] = AGENT_PROFILES.map((profile) => profile.value);

/** Whether a value names a profile in code (core's or the install's). Writes also accept an Owner's rows (assertKnownAgentProfile). */
export function isAgentProfile(value: unknown): value is AgentProfile {
  return typeof value === 'string' && AGENT_PROFILES.some((profile) => profile.value === value);
}

/**
 * A profile value on a write: its shape here. Whether a registry holds it
 * (code, or an Owner's rows) the server checks before it saves
 * (assertKnownAgentProfile in lib/api/agent-registries.ts).
 */
export const agentProfileSchema = z.string().regex(AGENT_PROFILE_VALUE, {
  error: () => 'agent_profile must be a profile value: lowercase letters, numbers and dashes, starting with a letter',
});

export function agentProfileDefinition(value: string, profiles: readonly AgentProfileDefinition[] = AGENT_PROFILES): AgentProfileDefinition | null {
  return profiles.find((profile) => profile.value === value) ?? null;
}

/**
 * Whether a profile sees a tool, before the key's scopes are asked. A
 * profile without a tool list sees them all; one with a list sees those; an
 * unknown value sees none (pm_guide is the caller's to add). definition,
 * when given (null for unknown), is what the server resolved, rows included;
 * left out, only code's profiles are asked.
 */
export function profileSeesTool(profile: AgentProfile, toolName: string, definition?: AgentProfileDefinition | null): boolean {
  const resolved = definition === undefined ? agentProfileDefinition(profile) : definition;
  if (!resolved) return false;
  return !resolved.tools || resolved.tools.includes(toolName);
}
