import { isModuleEnabled, type AccessContext, type PermissionKey } from '@/lib/access-control';
import { accessAllows } from '@/lib/api/access';
import { permissionAlternatives } from '@/lib/api/middleware';
import type { PmTool } from './core';
import type { AgentProfile } from './profiles';
import { GUIDE_TOOL, PM_TOOLS } from './tools';

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
}

/**
 * Whether a key sees a tool: its profile, its read-only flag, its module, and
 * the permission on key AND member. A permission of a switched-off module is
 * held by nobody, so a module's tools go with it.
 */
export function toolVisible(tool: PmTool, caller: ToolViewer): boolean {
  if (tool.profiles && !tool.profiles.includes(caller.profile)) return false;
  if (tool.agentsOnly && caller.access.role !== 'agent') return false;
  if (tool.module && !isModuleEnabled(caller.access, tool.module)) return false;
  if (tool.write && caller.readOnly) return false;
  if (tool.name === GUIDE_TOOL) return true;
  const wanted = (Array.isArray(tool.permission) ? tool.permission : [tool.permission])
    .flatMap((permission: PermissionKey) => permissionAlternatives(permission));
  return wanted.some((permission) => caller.scopes.includes(permission) && accessAllows(caller.access, permission, 'api'));
}

export function toolsFor(caller: ToolViewer): PmTool[] {
  return PM_TOOLS.filter((tool) => toolVisible(tool, caller));
}
