import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { createInitiative, initiativeFiltersFrom, listInitiatives } from '@/lib/api/initiatives';
import { createInitiativeSchema, type CreateInitiativeInput } from '@/lib/initiatives';

/**
 * A project's initiatives (bodies of work, each with its own board and log),
 * in order, paged. Done ones are left out unless include_done=true, or
 * status names one. Each with its owner, progress (top-level tasks done of
 * those the key's member can see; null without a task permission) and, for
 * whoever may read the log, open_issue_count and last_entry_at.
 *
 * Permission: projects.read (and the project).
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listInitiatives(supabase, { memberId: teamMemberId, access, scopes }, params.id,
    { ...initiativeFiltersFrom(searchParams), offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: 'projects.read' });

/**
 * Creates an initiative in the project: name, description, an owner (a
 * member or a group), status (default planned), health (active only),
 * start_date and target_date (YYYY-MM-DD). It goes last in the project's
 * order unless sort_order says otherwise.
 *
 * Permission: tasks.create (and the project).
 */
export const POST = withApi<CreateInitiativeInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const initiative = await createInitiative(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/projects/${params.id}/initiatives`, entityType: 'initiative', entityId: initiative.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: initiative, statusCode: 201 });
  return created(initiative);
}, { schema: createInitiativeSchema, permission: 'tasks.create' });
