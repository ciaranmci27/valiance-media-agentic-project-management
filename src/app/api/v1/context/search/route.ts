import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { searchScopedContext } from '@/lib/api/context-scopes';
import { isContextScope, type ContextScope } from '@/lib/context-scopes';

export const dynamic = 'force-dynamic';

/**
 * Searches every context scope the caller reads at once (the workspace, its
 * groups, the projects it reaches, its own agent notes and the agents it
 * manages, and its memory), best first: web search syntax (words, "a
 * phrase", -not). scope_types narrows it (comma separated). Each entry
 * carries its scope_type and scope_id, section, pinned and rank. limit 1 to
 * 50 (default 20).
 *
 * Permission: any API scope; each scope has its own rule (a project's needs project_context.read).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const q = searchParams.get('q')?.trim() ?? '';
  if (!q) throw badRequest('Send q, the words to search for', { reason: 'query_required' });
  const types = (searchParams.get('scope_types') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = types.filter((type) => !isContextScope(type));
  if (unknown.length) throw badRequest(`Unknown scope types: ${unknown.join(', ')}`, { reason: 'invalid_scope' });
  return success(await searchScopedContext(supabase, { memberId: teamMemberId, access, scopes }, q, {
    scopeTypes: types as ContextScope[],
    limit: Number(searchParams.get('limit') ?? 20) || 20,
  }));
}, { permission: [...API_ENDPOINT_PERMISSIONS] });
