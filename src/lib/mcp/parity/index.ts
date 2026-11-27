import type { PmTool } from '../core';
import { TRASH_TOOLS } from './trash';
import { PROJECTS_TOOLS } from './projects';
import { WORKSPACE_TOOLS } from './workspace';
import { ASSISTANTS_TOOLS } from './assistants';
import { NOTIFICATIONS_TOOLS } from './notifications';
import { INBOX_TOOLS } from './inbox';
import { CRM_TOOLS } from './crm';
import { MONEY_TOOLS } from './money';
import { WORK_TOOLS } from './work';
import { AGENT_ACCESS_TOOLS } from './agent-access';
import { EMAIL_TOOLS } from './email';
import { SETTINGS_TOOLS } from './settings';

/**
 * The tools that close the API and MCP parity gaps (2026-11-27), one file per
 * area, in the order the audit ranked them. Each calls a documented v1 route
 * with the same permission the app checks. Free of server code, like
 * tools.ts, so the docs page can list them; the routes they call are wired
 * in routes.ts (one <area>.routes.ts each).
 */
export const PARITY_TOOLS: PmTool[] = [
  ...TRASH_TOOLS,
  ...PROJECTS_TOOLS,
  ...WORKSPACE_TOOLS,
  ...ASSISTANTS_TOOLS,
  ...NOTIFICATIONS_TOOLS,
  ...INBOX_TOOLS,
  ...CRM_TOOLS,
  ...MONEY_TOOLS,
  ...WORK_TOOLS,
  ...AGENT_ACCESS_TOOLS,
  ...EMAIL_TOOLS,
  ...SETTINGS_TOOLS,
];
