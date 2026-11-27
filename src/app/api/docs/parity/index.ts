import type { EndpointDoc } from '../docs-data';
import { TRASH_ENDPOINTS } from './trash';
import { PROJECTS_ENDPOINTS } from './projects';
import { WORKSPACE_ENDPOINTS } from './workspace';
import { ASSISTANTS_ENDPOINTS } from './assistants';
import { NOTIFICATIONS_ENDPOINTS } from './notifications';
import { INBOX_ENDPOINTS } from './inbox';
import { CRM_ENDPOINTS } from './crm';
import { MONEY_ENDPOINTS } from './money';

/** The API and MCP parity routes (2026-11-27), one file per area. Each names its own scopes. */
export const PARITY_ENDPOINTS: EndpointDoc[] = [
  ...TRASH_ENDPOINTS,
  ...PROJECTS_ENDPOINTS,
  ...WORKSPACE_ENDPOINTS,
  ...ASSISTANTS_ENDPOINTS,
  ...NOTIFICATIONS_ENDPOINTS,
  ...INBOX_ENDPOINTS,
  ...CRM_ENDPOINTS,
  ...MONEY_ENDPOINTS,
];
