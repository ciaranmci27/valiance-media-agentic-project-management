import type { EndpointDoc } from '../docs-data';

const TRASH_SCOPES = ['the permission that moves that record to Trash (projects.manage for a project, tasks.manage_all for a task, groups.manage for a group, and so on)'];

export const TRASH_ENDPOINTS: EndpointDoc[] = [
  {
    method: 'GET', path: '/api/v1/trash', group: 'Trash', scopes: TRASH_SCOPES,
    description: 'What is in Trash that this key could restore, newest first: record_type, id, label, context (its project, task or lead), project_id, deleted_at, deleted_by, deleted_by_name and blocker (what must come back first, or null). The same rules as Settings > Trash, read on the key\'s api channel. MCP: list_trash.',
    queryParams: [
      { name: 'types', type: 'string', description: 'Comma list of record types (projects, tasks, task_comments, reminders, contacts, leads, project_time_entries, groups, ...)' },
      { name: 'limit', type: 'number', description: '1-500, default 100' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/trash/:type/:recordId/restore', group: 'Trash', scopes: TRASH_SCOPES,
    description: 'Brings one record back from Trash exactly as it was. Whoever could move it there may restore it. 404 when it is not in Trash or out of the key\'s reach; 409 names what must come back first (its task or project), or what clashes (a group whose slug another live group now uses). Answers { restored: true, record_type, id }. MCP: restore_from_trash (credentials over REST only).',
    params: [
      { name: 'type', type: 'string', required: true, description: 'The record type, as GET /api/v1/trash names it' },
      { name: 'recordId', type: 'uuid', required: true, description: 'The record' },
    ],
  },
];
