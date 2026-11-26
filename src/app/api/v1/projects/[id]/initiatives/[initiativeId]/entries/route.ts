import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { addEntry, entryFiltersFrom, listEntries } from '@/lib/api/initiatives';
import { createInitiativeEntrySchema, INITIATIVE_READ_LIMITS, type CreateInitiativeEntryInput } from '@/lib/initiatives';

type Params = { id: string; initiativeId: string };

/**
 * An initiative's log, the dated record, newest first: updates, decisions,
 * issues (open or resolved) and notes. Filters: kind, status (issues). 50 a
 * page by default (limit up to 100).
 *
 * Permission: tasks.read (the right to comment on the project's tasks); never a guest.
 */
export const GET = withApi<unknown, Params>(async ({ supabase, params, searchParams, teamMemberId, access, scopes }) => {
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || String(INITIATIVE_READ_LIMITS.entriesPage), 10) || INITIATIVE_READ_LIMITS.entriesPage));
  const { rows, total } = await listEntries(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.initiativeId,
    { ...entryFiltersFrom(searchParams), offset: (page - 1) * limit, limit });
  return paginated(rows, { page, limit, total });
}, { permission: 'tasks.read' });

/**
 * Adds an entry to the log under the key's member: kind (update, decision,
 * issue, note), title, body and an optional task_id in the same project. An
 * issue starts open. Standing knowledge belongs in the initiative's brief
 * (POST /api/v1/context, scope initiative); a proposed task is a task
 * suggestion.
 *
 * Permission: tasks.read; never a guest.
 */
export const POST = withApi<CreateInitiativeEntryInput, Params>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const entry = await addEntry(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.initiativeId, body);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/projects/${params.id}/initiatives/${params.initiativeId}/entries`, entityType: 'initiative_entry', entityId: entry.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: entry, statusCode: 201 });
  return created(entry);
}, { schema: createInitiativeEntrySchema, permission: 'tasks.read' });
