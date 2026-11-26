import { isModuleEnabled, type AccessContext, type PermissionKey } from '@/lib/access-control';
import { accessAllows } from '@/lib/api/access';
import { permissionAlternatives } from '@/lib/api/middleware';
import { checkAgentProfileTools, type AgentProfileDefinition } from '@/lib/extensions/agent-profiles';
import type { PmTool } from './core';
import { AGENT_PROFILES, profileSeesTool, type AgentProfile } from './profiles';
import { GUIDE_TOOL, PM_TOOLS } from './tools';

// A profile that names a tool that does not exist stops here, on first load.
checkAgentProfileTools(AGENT_PROFILES, PM_TOOLS.map((tool) => tool.name));

/**
 * Which tools a key sees, apart from the server so the context pack
 * (lib/api/agent-context.ts) lists the same tools the MCP server would,
 * without importing the route handlers.
 */
export interface ToolViewer {
  access: AccessContext;
  scopes: string[];
  readOnly: boolean;
  profile: AgentProfile;
  /**
   * The profile as the server resolved it (an Owner's row, or null when no
   * registry knows the value). Left out, only code's profiles are asked.
   */
  profileDefinition?: AgentProfileDefinition | null;
}

/**
 * Whether a key sees a tool: its profile, its read-only flag, its module, and
 * the permission (and any it also requires) on key AND member. A permission
 * of a switched-off module is held by nobody, so a module's tools go with it.
 */
export function toolVisible(tool: PmTool, caller: ToolViewer): boolean {
  if (tool.profiles && !tool.profiles.includes(caller.profile)) return false;
  if (tool.name !== GUIDE_TOOL && !profileSeesTool(caller.profile, tool.name, caller.profileDefinition)) return false;
  if (tool.agentsOnly && caller.access.role !== 'agent') return false;
  if (tool.personalOnly && !(caller.access.role === 'agent' && caller.access.principal_id)) return false;
  if (tool.module && !isModuleEnabled(caller.access, tool.module)) return false;
  if (tool.write && caller.readOnly) return false;
  if (tool.name === GUIDE_TOOL) return true;
  const held = (permission: PermissionKey) => caller.scopes.includes(permission) && accessAllows(caller.access, permission, 'api');
  if (tool.chatAgentsOnly && !(caller.access.role === 'agent' && (caller.access.principal_id || held('agents.act_for')))) return false;
  const wanted = (Array.isArray(tool.permission) ? tool.permission : [tool.permission])
    .flatMap((permission: PermissionKey) => permissionAlternatives(permission));
  return wanted.some(held) && (tool.requires ?? []).every((permission) => permissionAlternatives(permission).some(held));
}

/**
 * The tools a key is offered: tools/list, the catalog (GET /api/v1/mcp/tools),
 * pm_guide and the context pack. A deprecated tool is never offered, so new
 * callers do not build on it.
 */
export function toolsFor(caller: ToolViewer): PmTool[] {
  return PM_TOOLS.filter((tool) => !tool.deprecated && toolVisible(tool, caller));
}

/**
 * The tools a key may call by name: everything it is offered, plus the
 * deprecated tools it could use, which keep working until they are removed.
 */
export function callableToolsFor(caller: ToolViewer): PmTool[] {
  return PM_TOOLS.filter((tool) => toolVisible(tool, caller));
}
