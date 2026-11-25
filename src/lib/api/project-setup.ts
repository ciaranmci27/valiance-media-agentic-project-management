import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled } from '@/lib/access-control';
import { moveToTrash } from '@/lib/supabase/trash';
import type { BriefEntry, BriefGoal } from '@/lib/project-brief';
import type { ProjectAgentAssignment } from '@/lib/project-agents';
import type { ProjectSetup } from '@/lib/schemas/agent-workspaces';
import { callerHolds, type AgentCaller } from './agent-owners';
import { briefEntry, briefInsertRow } from './project-brief';
import { BRIEF_CONTEXT_COLUMNS } from './project-context';
import { validateMemberIds } from './project-create';
import {
  canGrantProjectAccess, loadAgent, migrationPending, newAssignmentRow, presentAssignments, PROJECT_AGENT_COLUMNS, projectAccessNeeded, requireAssignAgent,
} from './project-agents';
import { ApiError, forbidden, moduleOff } from './errors';
import { agentTemplateRegistry } from './agent-registries';

/**
 * Setting up a whole project in one call, the way an agent is hired in one:
 * the project (through the one create path, lib/api/project-create.ts), its
 * members, its brief, its goals and its agents with their settings and
 * instructions. The screens (POST /api/workspace/projects/setup), the v1 API
 * (POST /api/v1/projects/setup) and MCP (setup_project) share it.
 *
 * - The project create's own rules, then each part's: members need
 *   project_members.manage, the brief project_context.manage, goals
 *   goals.manage, and agents a workspace Owner or project_members.manage
 *   (they get access to the new project); goals and agents need AI agents on. Settings are
 *   checked against each agent's template. Everything is checked before the
 *   first write.
 * - A failure after the project exists moves it to Trash (with everything
 *   this call put under it) and answers what happened: nothing half made
 *   stays live. An Owner can restore it from Trash.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const PLACEHOLDER_PROJECT = '00000000-0000-4000-8000-000000000000';

export interface ProjectSetupResult {
  project: Record<string, unknown> & { id: string };
  assignments: ProjectAgentAssignment[];
  brief: BriefEntry[];
  goals: BriefGoal[];
}

/**
 * Plans and applies a setup. `create` is the channel's own project create
 * (the screens' or the API's), called with the project fields plus every
 * member id.
 */
export async function setupProject(
  service: SupabaseClient,
  caller: AgentCaller,
  input: ProjectSetup,
  create: (project: Record<string, unknown>) => Promise<Record<string, unknown> & { id: string }>,
): Promise<ProjectSetupResult> {
  // 1. Every part's permission and shape, before anything is written.
  const members = [...new Set(input.members ?? [])];
  if (members.length) {
    if (!callerHolds(caller, 'project_members.manage')) {
      throw forbidden('Adding project members needs project_members.manage', { reason: 'missing_permission', needs: 'project_members.manage', part: 'members' });
    }
    try {
      await validateMemberIds(service, members);
    } catch (error) {
      throw new ApiError(422, 'VALIDATION_ERROR', error instanceof Error ? error.message : 'Invalid team member assignment', { reason: 'member_not_active', part: 'members' });
    }
  }
  if (input.brief?.length && !callerHolds(caller, 'project_context.manage')) {
    throw forbidden('Writing a project brief needs project_context.manage', { reason: 'missing_permission', needs: 'project_context.manage', part: 'brief' });
  }
  if (input.goals?.length) {
    if (!isModuleEnabled(caller.access, 'agents')) throw moduleOff('agents');
    if (!callerHolds(caller, 'goals.manage')) {
      throw forbidden('Adding goals needs goals.manage', { reason: 'missing_permission', needs: 'goals.manage', part: 'goals' });
    }
  }
  const agentRows: Row[] = [];
  if (input.agents?.length) {
    if (!isModuleEnabled(caller.access, 'agents')) throw moduleOff('agents');
    // The agents join a new project: that is project access, an Owner's or a project manager's to give.
    if (!canGrantProjectAccess(caller)) throw projectAccessNeeded([]);
    const seen = new Set<string>();
    const templates = await agentTemplateRegistry(service);
    for (const entry of input.agents) {
      if (seen.has(entry.agent_id)) throw new ApiError(422, 'VALIDATION_ERROR', 'An agent is named twice', { reason: 'duplicate_agent', agent_id: entry.agent_id });
      seen.add(entry.agent_id);
      const agent = await loadAgent(service, entry.agent_id);
      if (agent.status !== 'active') {
        throw new ApiError(422, 'VALIDATION_ERROR', `${agent.name} is suspended. Reactivate them in Team first.`, { reason: 'member_suspended', agent_id: agent.id });
      }
      await requireAssignAgent(service, caller, agent.id);
      agentRows.push(newAssignmentRow(caller, PLACEHOLDER_PROJECT, agent.id, entry, `${agent.name}: `, templates));
    }
  }
  const briefRows = (input.brief ?? []).map((entry) => briefInsertRow(PLACEHOLDER_PROJECT, entry, caller.access.role === 'agent' ? 'agent' : 'human'));

  const projectBody: Record<string, unknown> = { ...input.project };
  if (members.length) {
    const named = Array.isArray(projectBody.member_ids) ? (projectBody.member_ids as unknown[]).filter((id): id is string => typeof id === 'string') : [];
    projectBody.member_ids = [...new Set([...named, ...members])];
  }

  // 2. The project, then each part; a failure after it moves the project to Trash.
  const project = await create(projectBody);
  const done: string[] = ['project created'];
  try {
    let brief: BriefEntry[] = [];
    if (briefRows.length) {
      const { data, error } = await service.from('project_context').insert(briefRows.map((row) => ({ ...row, project_id: project.id }))).select(BRIEF_CONTEXT_COLUMNS);
      if (error) throw error;
      brief = ((data ?? []) as unknown as Row[]).map(briefEntry);
      done.push(`${brief.length} brief entries`);
    }
    let goals: BriefGoal[] = [];
    if (input.goals?.length) {
      const { data, error } = await service.from('project_goals').insert(input.goals.map((goal) => ({
        project_id: project.id, title: goal.title, description: goal.description || '', target_date: goal.target_date || null, status: 'active', created_by: caller.memberId,
      }))).select('id, title, description, target_date, status');
      if (error) throw error;
      goals = ((data ?? []) as Row[]).map((goal) => ({ id: goal.id, title: goal.title, description: goal.description ?? null, target_date: goal.target_date ?? null, status: goal.status }));
      done.push(`${goals.length} goals`);
    }
    let assignments: ProjectAgentAssignment[] = [];
    if (agentRows.length) {
      // Project access for every agent not on it yet, in one read and one write.
      const { data: on, error: onError } = await service.from('project_members').select('member_id').eq('project_id', project.id);
      if (onError) throw onError;
      const have = new Set(((on ?? []) as { member_id: string }[]).map((row) => row.member_id));
      const missing = agentRows.map((row) => row.agent_id as string).filter((id) => !have.has(id));
      if (missing.length) {
        const { error } = await service.from('project_members').insert(missing.map((member_id) => ({ project_id: project.id, member_id })));
        if (error) throw error;
      }
      const { data, error } = await service.from('project_agents').insert(agentRows.map((row) => ({ ...row, project_id: project.id }))).select(PROJECT_AGENT_COLUMNS);
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') throw migrationPending();
        throw error;
      }
      assignments = await presentAssignments(service, (data ?? []) as Row[], new Map([[project.id, String(project.name ?? '')]]));
      done.push(`${assignments.length} agents assigned`);
    }
    return {
      project: { ...project, member_ids: [...new Set([...((project.member_ids as string[] | undefined) ?? []), ...missingAccess(project, agentRows)])] },
      assignments,
      brief,
      goals,
    };
  } catch (failure) {
    const cause = failure instanceof Error ? failure.message : String((failure as { message?: string })?.message ?? failure);
    let trashed = false;
    try {
      trashed = await moveToTrash(service, 'projects', project.id, caller.memberId);
    } catch (error) {
      console.error('[projects] setup rollback: moving the project to Trash failed', error);
    }
    const details = {
      reason: 'setup_incomplete',
      project_id: project.id,
      done,
      rolled_back: trashed ? ['project moved to Trash, with everything this call added to it'] : [],
      ...(trashed ? {} : { rollback_failed: ['moving the project to Trash'] }),
      cause,
    };
    if (failure instanceof ApiError) {
      throw new ApiError(failure.statusCode, failure.code, `The project was not set up: ${failure.message}`, { ...(failure.details as Row | undefined), ...details });
    }
    throw new ApiError(500, 'SETUP_INCOMPLETE', 'The project setup stopped partway. The project was moved to Trash.', details);
  }
}

function missingAccess(project: Row, agentRows: Row[]): string[] {
  const have = new Set((project.member_ids as string[] | undefined) ?? []);
  return agentRows.map((row) => row.agent_id as string).filter((id) => !have.has(id));
}
