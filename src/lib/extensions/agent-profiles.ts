import { ExtensionError } from './registry';

/**
 * Agent profiles: which MCP tools an agent member sees, as code. Core ships
 * its profiles (lib/mcp/profiles.ts) and an install adds its own in
 * src/custom/agent-profiles.ts. A profile only narrows: the key's scopes and
 * the member's permissions still filter every list, and every call still runs
 * through the API's checks. It adds nothing to the security model.
 *
 * - value: what team_members.agent_profile stores. Lowercase letters, numbers
 *   and dashes, starting with a letter, at most 40; unique across core and
 *   the install.
 * - tools: the tool names it sees (pm_guide always). Left out, it sees every
 *   tool its keys allow, as core's profiles do.
 *
 * Data only, so it runs in the browser (the Team page lists the profiles)
 * and the server alike.
 */
export interface AgentProfileDefinition {
  value: string;
  label: string;
  description: string;
  tools?: readonly string[];
}

export const AGENT_PROFILE_VALUE = /^[a-z][a-z0-9-]{0,39}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function fail(message: string): never {
  throw new ExtensionError(message);
}

function checkProfile(profile: AgentProfileDefinition) {
  const where = `agent profile "${profile.value}"`;
  if (!AGENT_PROFILE_VALUE.test(profile.value ?? '')) {
    fail(`agent profile value "${profile.value}" must be lowercase letters, numbers and dashes, starting with a letter, at most 40 characters.`);
  }
  if (!profile.label?.trim()) fail(`${where} needs a label.`);
  if (!profile.description?.trim()) fail(`${where} needs a description.`);
  if (profile.tools !== undefined) {
    if (!Array.isArray(profile.tools) || profile.tools.length === 0) fail(`${where}: tools lists at least one tool, or is left out for every tool.`);
    for (const tool of profile.tools) {
      if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) fail(`${where}: "${tool}" is not a tool name.`);
    }
  }
}

/** Validates a list of agent profiles and returns it, tools deduplicated. */
export function defineAgentProfiles(profiles: readonly AgentProfileDefinition[] = []): AgentProfileDefinition[] {
  const seen = new Set<string>();
  return profiles.map((profile) => {
    checkProfile(profile);
    if (seen.has(profile.value)) fail(`two agent profiles use the value "${profile.value}". Each value must be unique.`);
    seen.add(profile.value);
    return { ...profile, ...(profile.tools ? { tools: [...new Set(profile.tools)] } : {}) };
  });
}

/** Core's profiles then the install's; an install's value that repeats a core one stops the build. */
export function mergeAgentProfiles(core: readonly AgentProfileDefinition[], custom: readonly AgentProfileDefinition[]): AgentProfileDefinition[] {
  const coreValues = new Set(core.map((profile) => profile.value));
  for (const profile of custom) {
    if (coreValues.has(profile.value)) {
      fail(`the agent profile value "${profile.value}" is core's. Give the install's profile its own value.`);
    }
  }
  return [...core, ...defineAgentProfiles(custom)];
}

/** Names a profile lists that are not tools, so a typo stops the build instead of hiding a tool. */
export function checkAgentProfileTools(profiles: readonly AgentProfileDefinition[], toolNames: readonly string[]) {
  const known = new Set(toolNames);
  for (const profile of profiles) {
    for (const tool of profile.tools ?? []) {
      if (!known.has(tool)) fail(`agent profile "${profile.value}": there is no MCP tool "${tool}".`);
    }
  }
}
