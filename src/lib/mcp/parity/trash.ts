import { z } from 'zod';
import { routeTool, type PmTool } from '../core';
import { TRASH_PERMISSIONS, TRASH_TYPES } from '@/lib/supabase/trash';
import { id } from './shared';

/** Credentials are restored over REST only: nothing about a credential passes through an agent's tools. */
const MCP_TRASH_TYPES = TRASH_TYPES.filter((type) => type !== 'project_credentials') as [string, ...string[]];

/** Trash: what a key could move there, it can see and bring back. */
export const TRASH_TOOLS: PmTool[] = [
  routeTool({
    name: 'list_trash',
    lead: 'List what is in Trash that you could restore.',
    detail: 'Newest first: record_type, id, label, context (its project, task or lead), project_id, when and by whom it was deleted, and blocker (what must come back first, or null). Only what your key could have moved to Trash. types narrows to some record types; limit 1-500, default 100. Bring one back with restore_from_trash.',
    input: z.object({
      types: z.array(z.enum(MCP_TRASH_TYPES)).min(1).max(MCP_TRASH_TYPES.length).optional().describe('Record types, such as tasks or projects'),
      limit: z.number().int().min(1).max(500).optional(),
    }).strict(),
    permission: TRASH_PERMISSIONS,
    method: 'GET',
    path: '/api/v1/trash',
    request: ({ types, limit }) => ({ query: { types: types?.join(','), limit } }),
  }),
  routeTool({
    name: 'restore_from_trash',
    lead: 'Bring a record back from Trash exactly as it was.',
    detail: "The same rules as Settings > Trash: whoever could move it there may restore it. 404 when it is not in Trash or out of your reach; 409 names what must come back first (its task or project). Answers { restored: true, record_type, id }.",
    input: z.object({ record_type: z.enum(MCP_TRASH_TYPES), id: id('id') }).strict(),
    permission: TRASH_PERMISSIONS,
    method: 'POST',
    path: '/api/v1/trash/{type}/{recordId}/restore',
    idempotent: true,
    request: ({ record_type, id: recordId }) => ({ params: { type: record_type, recordId } }),
  }),
];
