import { z } from 'zod';
import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { routeTool, type PmTool } from '../core';
import { id } from './shared';

/**
 * An agent's Access tab and Hire > Personal assistant over MCP: what a company
 * agent may do as one list, revoking unused keys, and giving a person their
 * assistant. Same routes and permissions as the app.
 */
export const AGENT_ACCESS_TOOLS: PmTool[] = [
  routeTool({
    name: 'get_agent_powers',
    lead: 'Read what a company agent may do, as one list.',
    detail: 'scopes merges what its live keys carry with powers given to it on its own; out_of_step says a live key lacks part of the list. Needs api_keys.manage_all.',
    input: z.object({ agent_id: id('agent_id') }).strict(),
    module: 'agents',
    permission: 'api_keys.manage_all',
    method: 'GET',
    path: '/api/v1/agents/{id}/powers',
    request: ({ agent_id }) => ({ params: { id: agent_id } }),
  }),
  routeTool({
    name: 'set_agent_powers',
    lead: 'Replace what a company agent may do.',
    detail: 'scopes is the whole list: it goes on every live key, and a power given to the agent on its own that the list leaves out is taken away (one an Owner set needs an Owner key). 409 no_live_key until it has a working key. Needs api_keys.manage_all.',
    input: z.object({ agent_id: id('agent_id'), scopes: z.array(z.string().min(1).max(100)).min(1).max(300) }).strict(),
    module: 'agents',
    permission: 'api_keys.manage_all',
    method: 'PUT',
    path: '/api/v1/agents/{id}/powers',
    idempotent: true,
    request: ({ agent_id, scopes }) => ({ params: { id: agent_id }, body: { scopes } }),
  }),
  routeTool({
    name: 'revoke_unused_keys',
    lead: 'Preview or revoke keys unused for 90 days.',
    detail: 'dry_run true (the default) lists them with why and the keys each would take down. dry_run false with key_ids from that preview revokes the ones still unused; a key used since is skipped. A key that made a key still in use, or yours, stays (kept_keys says why). Revoking is final. Needs api_keys.manage_all.',
    input: z.object({
      dry_run: z.boolean().optional(),
      key_ids: z.array(id('key_ids')).max(200).optional(),
    }).strict().refine((body) => body.dry_run !== false || (body.key_ids?.length ?? 0) > 0, 'Send the key_ids from the preview to revoke them'),
    permission: 'api_keys.manage_all',
    method: 'POST',
    path: '/api/v1/api-keys/revoke-unused',
    destructive: true,
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'hire_personal_assistant',
    lead: 'Give one person their personal assistant.',
    detail: 'One per person: when they have one, created is false and nothing is made. An Owner key only; assistants must be on. Its harness collects a key separately.',
    input: z.object({ person_id: id('person_id'), name: z.string().trim().min(1).max(80).optional() }).strict(),
    permission: 'assistants.provision',
    method: 'POST',
    path: '/api/v1/assistants/for-person',
    idempotent: true,
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'clear_agent_notes',
    lead: 'Clear every note an agent wrote in its own notes.',
    detail: 'Archived, not deleted: restore_context brings them back. Notes a person wrote or checked stay. For the people who manage the agent (agents.manage), and the agent itself (agent_activity.write).',
    input: z.object({ scope_type: z.literal('agent'), scope_id: id('scope_id'), written_by: z.literal('agent') }).strict(),
    permission: ['agents.manage', 'agent_activity.write'],
    method: 'POST',
    path: '/api/v1/context/clear',
    destructive: true,
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'restore_context',
    lead: 'Bring archived context entries back.',
    detail: 'Each entry must be in a scope you may write; one out of reach or not archived is skipped. A pinned note restored into your own context comes back unpinned. Answers restored ids.',
    input: z.object({ entry_ids: z.array(id('entry_ids')).min(1).max(200) }).strict(),
    permission: [...API_ENDPOINT_PERMISSIONS],
    method: 'POST',
    path: '/api/v1/context/restore',
    idempotent: true,
    request: (body) => ({ body }),
  }),
];
