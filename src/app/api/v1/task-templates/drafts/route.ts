import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { listTemplateDrafts, templateDraftFiltersFrom } from '@/lib/api/template-drafts';

/**
 * Template run drafts on projects the key's member can open, newest first,
 * paged, without previews: status (pending, approved, rejected, expired),
 * what each proposes, who proposed and decided it, its approval (question_id)
 * and the run an approval made. Filters: project_id, template_id, status.
 *
 * Permission: tasks.create or templates.manage.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listTemplateDrafts(supabase, { memberId: teamMemberId, access, scopes }, { ...templateDraftFiltersFrom(searchParams), offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: ['tasks.create', 'templates.manage'] });
