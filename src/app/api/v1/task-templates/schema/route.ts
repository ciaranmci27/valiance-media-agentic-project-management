import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { templateSchemaDocument } from '@/lib/task-template-schema';

/**
 * The JSON template, as JSON Schema (draft 2020-12): template (what create
 * takes), update (a change), run (what run and preview take), the error
 * codes validate, create, update, preview and run answer with, and a worked
 * example. Built from the zod schema the server checks with, so it never drifts.
 *
 * Permission: tasks.create, templates.manage or projects.manage.
 */
export const GET = withApi(async () => success(templateSchemaDocument()),
  { permission: ['tasks.create', 'templates.manage', 'projects.manage'] });
