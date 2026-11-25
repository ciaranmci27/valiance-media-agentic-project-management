import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { badRequest } from '@/lib/api/errors';
import { addScopedEntry, readScopedBrief } from '@/lib/api/context-scopes';
import { addScopedEntrySchema, isContextScope, type AddScopedEntry } from '@/lib/context-scopes';
import { isBriefSection } from '@/lib/project-brief';

export const dynamic = 'force-dynamic';

/**
 * One scope's context as a brief: scope_type (workspace, group, project,
 * agent or member) and scope_id (left out for the workspace). Each section's
 * first page, pinned first then newest, or one section's page with section,
 * offset and limit. Who reads which scope: lib/api/context-scopes.ts (a
 * person's memory: only them and their own assistant while they allow it).
 *
 * Permission: any API scope; each scope has its own rule (a project's needs project_context.read).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const scopeType = searchParams.get('scope_type') ?? '';
  if (!isContextScope(scopeType)) throw badRequest('scope_type is workspace, group, project, agent or member', { reason: 'invalid_scope' });
  const section = searchParams.get('section');
  if (section && !isBriefSection(section)) throw badRequest('Unknown section', { reason: 'invalid_section' });
  const ref = { scope_type: scopeType, scope_id: searchParams.get('scope_id') || null };
  return success(await readScopedBrief(supabase, { memberId: teamMemberId, access, scopes }, ref, {
    section: section && isBriefSection(section) ? section : null,
    offset: Math.max(0, Number(searchParams.get('offset') ?? 0) || 0),
    limit: Number(searchParams.get('limit') ?? 0) || undefined,
  }));
}, { permission: [...API_ENDPOINT_PERMISSIONS] });

/**
 * Adds an entry to a scope: scope_type, scope_id (left out for the
 * workspace), content, section (default overview) and pinned. An agent may
 * write its own agent notes and, as a personal agent, its person's memory
 * while they allow it; the workspace is an Owner's (or settings.manage), a
 * group its managers' and members' with project_context.manage, a project
 * needs project_context.manage. Recorded as written by an agent when an
 * agent writes it.
 *
 * Permission: any API scope; each scope has its own rule.
 */
export const POST = withApi<AddScopedEntry>(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const entry = await addScopedEntry(supabase, { memberId: teamMemberId, access, scopes }, body);
  logAudit(supabase, {
    method: 'POST', endpoint: '/api/v1/context', entityType: 'project_context', entityId: entry.id, apiKeyId, teamMemberId,
    requestBody: { scope_type: body.scope_type, scope_id: body.scope_id ?? null, section: entry.section, pinned: entry.pinned }, statusCode: 201,
  });
  return created(entry);
}, { schema: addScopedEntrySchema, permission: [...API_ENDPOINT_PERMISSIONS] });
