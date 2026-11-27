import 'server-only';
import type { HttpMethod } from '../core';
import * as trash from '@/app/api/v1/trash/route';
import * as trashRestore from '@/app/api/v1/trash/[type]/[recordId]/restore/route';
import { PROJECTS_ROUTE_MODULES } from './projects.routes';
import { WORKSPACE_ROUTE_MODULES } from './workspace.routes';
import { ASSISTANTS_ROUTE_MODULES } from './assistants.routes';
import { NOTIFICATIONS_ROUTE_MODULES } from './notifications.routes';
import { INBOX_ROUTE_MODULES } from './inbox.routes';
import { CRM_ROUTE_MODULES } from './crm.routes';
import { MONEY_ROUTE_MODULES } from './money.routes';
import { WORK_ROUTE_MODULES } from './work.routes';
import { EMAIL_ROUTE_MODULES } from './email.routes';
import { SETTINGS_ROUTE_MODULES } from './settings.routes';
import * as agentPowers from '@/app/api/v1/agents/[id]/powers/route';
import * as revokeUnused from '@/app/api/v1/api-keys/revoke-unused/route';
import * as personalForPerson from '@/app/api/v1/assistants/for-person/route';
import * as contextClear from '@/app/api/v1/context/clear/route';
import * as contextRestore from '@/app/api/v1/context/restore/route';

type RouteModule = Partial<Record<HttpMethod, unknown>>;

/** The v1 route module behind each parity tool's path (handlers.ts merges these into ROUTE_MODULES). */
export const PARITY_ROUTE_MODULES: Record<string, RouteModule> = {
  // Trash
  '/api/v1/trash': trash,
  '/api/v1/trash/{type}/{recordId}/restore': trashRestore,
  ...PROJECTS_ROUTE_MODULES,
  ...WORKSPACE_ROUTE_MODULES,
  ...ASSISTANTS_ROUTE_MODULES,
  ...NOTIFICATIONS_ROUTE_MODULES,
  ...INBOX_ROUTE_MODULES,
  ...CRM_ROUTE_MODULES,
  ...MONEY_ROUTE_MODULES,
  ...WORK_ROUTE_MODULES,
  ...EMAIL_ROUTE_MODULES,
  ...SETTINGS_ROUTE_MODULES,
  // An agent's Access tab and Hire > Personal assistant
  '/api/v1/agents/{id}/powers': agentPowers,
  '/api/v1/api-keys/revoke-unused': revokeUnused,
  '/api/v1/assistants/for-person': personalForPerson,
  // Clearing what an agent wrote in its own notes, and its Undo
  '/api/v1/context/clear': contextClear,
  '/api/v1/context/restore': contextRestore,
};
