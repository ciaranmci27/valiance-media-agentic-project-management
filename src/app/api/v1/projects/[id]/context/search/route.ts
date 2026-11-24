import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { searchProjectContext } from '@/lib/api/project-brief';

/**
 * A project's active context entries matching q, best first, over the
 * full-text index: web search syntax (words, "a phrase", -not). Each entry
 * has its brief section, pinned and rank. limit 1 to 50 (default 20).
 *
 * Permission: project_context.read.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams }) => {
  const q = searchParams.get('q')?.trim() ?? '';
  if (!q) throw badRequest('Send q, the words to search for', { reason: 'query_required' });
  const limit = Number(searchParams.get('limit') ?? 20) || 20;
  return success(await searchProjectContext(supabase, params.id, q, limit));
});
