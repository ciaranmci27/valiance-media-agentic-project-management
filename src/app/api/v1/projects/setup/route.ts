import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { ApiError } from '@/lib/api/errors';
import { createProjectFromApi } from '@/lib/api/project-create';
import { setupProject } from '@/lib/api/project-setup';
import { createProjectSchema, projectSetupSchema, type ProjectSetup } from '@/lib/schemas';

/**
 * Sets up a whole project in one call: the project (the fields POST
 * /api/v1/projects takes, through the same create), members (member ids),
 * brief entries ({ section, content, pinned? }), goals ({ title,
 * description?, target_date? }) and agents ({ agent_id, template_key?,
 * settings?, instructions?, status? }). Each part needs its own permission
 * (project_members.manage, project_context.manage, goals.manage, assigning
 * the agent), all checked before the first write. A failure after the
 * project exists moves it to Trash (500 SETUP_INCOMPLETE, or the cause's own
 * status, with reason setup_incomplete). Answers { project, assignments,
 * brief, goals } (201).
 *
 * Permission: projects.manage.
 */
export const POST = withApi<ProjectSetup>(async ({ supabase, body, access, scopes, apiKeyId, teamMemberId }) => {
  const caller = { memberId: teamMemberId, access, scopes };
  const result = await setupProject(supabase, caller, body, async (project) => {
    const parsed = createProjectSchema.safeParse(project);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError(422, 'VALIDATION_ERROR', `project.${issue?.path.join('.') || ''}: ${issue?.message ?? 'Invalid project'}`, { reason: 'project_invalid', part: 'project' });
    }
    return createProjectFromApi(supabase, { access, scopes, teamMemberId }, parsed.data as Record<string, unknown>);
  });
  logAudit(supabase, {
    method: 'POST', endpoint: '/api/v1/projects/setup', entityType: 'project', entityId: result.project.id, apiKeyId, teamMemberId, requestBody: body,
    afterSnapshot: { project: result.project, assignments: result.assignments.map((a) => a.agent_id), brief: result.brief.length, goals: result.goals.length }, statusCode: 201,
  });
  return created(result);
}, { schema: projectSetupSchema, permission: 'projects.manage' });
