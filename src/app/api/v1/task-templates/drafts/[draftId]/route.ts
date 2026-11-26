import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { getTemplateDraft } from '@/lib/api/template-drafts';

/**
 * One draft, with its preview while it is pending: the run preview as the
 * reader would approve it, each task marked change: added when the draft
 * adds it, removed_tasks (the template's steps it leaves out) and
 * template_changed_since when the template moved on.
 *
 * Permission: tasks.create or templates.manage.
 */
export const GET = withApi<unknown, { draftId: string }>(async ({ supabase, params, teamMemberId, access, scopes }) =>
  success(await getTemplateDraft(supabase, { memberId: teamMemberId, access, scopes }, params.draftId)),
{ permission: ['tasks.create', 'templates.manage'] });
