import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { validateTemplate } from '@/lib/api/task-templates';

const validateBodySchema = z.object({
  /** The template (as create takes it), or with template_id a change (as update takes it). */
  template: z.record(z.string(), z.unknown()),
  template_id: z.uuid('template_id must be a uuid').optional(),
}).strict();

/**
 * Checks a template without saving it: the same rules create and update
 * apply. Answers 200 with { valid, errors, template, can_save }: every error
 * with its JSON path (items[2].depends_on[0]), a code, a message and a fix;
 * template is what would be saved (every task keyed). With template_id, the
 * template is a change to that one.
 *
 * Permission: templates.manage or projects.manage.
 */
export const POST = withApi<z.infer<typeof validateBodySchema>>(async ({ supabase, body, teamMemberId, access, scopes }) =>
  success(await validateTemplate(supabase, { memberId: teamMemberId, access, scopes }, body.template, body.template_id ?? null)),
{ schema: validateBodySchema, permission: ['templates.manage', 'projects.manage'] });
