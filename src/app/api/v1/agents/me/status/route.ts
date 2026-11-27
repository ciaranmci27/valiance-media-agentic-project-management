import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { loadAgentStatus } from '@/lib/api/agent-status';
import { openWorkProjects, projectBlockers, workNeedsTimer } from '@/lib/api/readiness';
import { badRequest } from '@/lib/api/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = 'force-dynamic';

/**
 * May the calling agent start work now? Check it before each turn: paused
 * (the workspace pause, or the agent's own), the budget this period (spend
 * by the shared rule, the caps, exceeded) and its limits. Skip the turn when
 * can_start_work is false; on a network error, go ahead (fail open). Pause
 * and budget only refuse calls into this app, so an agent that works in
 * another system needs this to stop there too. Never cached.
 *
 * blockers lists what in the app would stop its work before it starts
 * (time_tracking_off: a project that tracks no time while its work needs a
 * timer), on the projects of its open work; with project_id or task_id, on
 * that project alone, and can_start_work is false (skip_reason
 * time_tracking_off) while one stands.
 *
 * Permission: any API scope the key carries and its member holds, so a key
 * with only agent_activity.write reads it. A paused agent reads it too.
 */
export const GET = withApi(async ({ supabase, teamMemberId, access, scopes, searchParams }) => {
  const status = await loadAgentStatus(supabase, teamMemberId);
  const projectParam = searchParams.get('project_id');
  const taskParam = searchParams.get('task_id');
  if ((projectParam && !UUID.test(projectParam)) || (taskParam && !UUID.test(taskParam))) throw badRequest('project_id and task_id are uuids');
  let projectId = projectParam;
  if (taskParam) {
    const { data } = await supabase.from('tasks').select('project_id').eq('id', taskParam).is('deleted_at', null).maybeSingle();
    projectId = (data as { project_id?: string } | null)?.project_id ?? projectId;
  }
  const needsTimer = workNeedsTimer(access, scopes);
  const asked = projectId ? [projectId].filter((id) => access.api_permissions.includes('*') || access.api_permissions.includes('projects.read_all') || access.project_ids.includes(id)) : null;
  status.blockers = status.agent && needsTimer
    ? await projectBlockers(supabase, asked ?? await openWorkProjects(supabase, teamMemberId), needsTimer)
    : [];
  if (asked && status.blockers.length && status.can_start_work) {
    status.can_start_work = false;
    status.skip_reason = status.blockers[0].reason;
  }
  const response = success(status);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}, { permission: [...API_ENDPOINT_PERMISSIONS] });
