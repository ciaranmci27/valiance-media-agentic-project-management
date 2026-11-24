import { ApiError, forbidden } from '@/lib/api/errors';
import { accessAllows } from '@/lib/api/access';
import { createProjectFromSession, ProjectCreateError } from '@/lib/api/project-create';
import { setupProject } from '@/lib/api/project-setup';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { projectSetupSchema } from '@/lib/schemas/agent-workspaces';

export const dynamic = 'force-dynamic';

/**
 * Sets up a whole project in one call: { project (the create fields),
 * members?, brief?: [{ section, content, pinned? }], goals?: [{ title,
 * description?, target_date? }], agents?: [{ agent_id, template_key?,
 * settings?, instructions?, status? }] }. The project goes through the same
 * create as POST /api/workspace/projects (projects.manage); each part needs
 * its own permission, all checked before the first write. A failure after
 * the project exists moves it to Trash (reason setup_incomplete). Answers
 * { project, assignments, brief, goals }.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller, access, memberId }) => {
    if (!accessAllows(access, 'projects.manage', 'app')) throw forbidden('Creating a project needs projects.manage', { reason: 'missing_permission', needs: 'projects.manage' });
    const body = await readWorkspaceBody(request, projectSetupSchema);
    return setupProject(service, caller, body, async (project) => {
      try {
        return await createProjectFromSession(service, access, memberId, project);
      } catch (error) {
        if (error instanceof ProjectCreateError) {
          throw new ApiError(error.status, error.status === 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR', error.message, { reason: 'project_invalid', part: 'project' });
        }
        throw error;
      }
    });
  }, { status: 201 });
}
