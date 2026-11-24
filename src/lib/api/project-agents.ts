import type { SupabaseClient } from '@supabase/supabase-js';
import { findAgentTemplate, listAgentTemplates } from '@/lib/agent-templates';
import type { AgentTemplate } from '@/lib/extensions/agent-templates';
import {
  PROJECT_AGENT_INSTRUCTIONS_MAX,
  settingsErrorFields,
  validateTemplateSettings,
  type ProjectAgentAssignment,
  type ProjectAgentStatus,
  type SettingsValues,
} from '@/lib/project-agents';
import { accessAllows, accessAllowsProject } from './access';
import { callerChannel, callerHolds, canManageAgent, type AgentCaller } from './agent-owners';
import { requireAgentsEnabled } from './agents';
import { ApiError, forbidden, notFound } from './errors';

/**
 * Agents on projects (pm.project_agents), for the session routes, the v1
 * API and MCP alike.
 *
 * - Read: anyone who can open the project reads its agents, with the AI
 *   agents module on. An agent reads only its own assignments.
 * - Write: project_members.manage (as for a project's members) or the
 *   right to manage that agent (an Owner, team.manage, or one of its
 *   owners), and only on projects the caller reaches.
 * - Adding an agent to a project also gives it project access
 *   (project_members) when it lacks it, but only for a workspace Owner or
 *   project_members.manage: an agent's key acts with its project access, so
 *   an owner without that permission configures the agent only on projects
 *   it is already on (403 project_access_needed otherwise). Removing an
 *   assignment leaves access as it is: access is changed where project
 *   members are.
 * - Settings are checked against the template's declared fields
 *   (lib/project-agents.ts); a new assignment starts from their defaults.
 *   template_key must name a template this workspace has, with its module on.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export const PROJECT_AGENT_COLUMNS = 'id, project_id, agent_id, status, template_key, settings, instructions, created_by, created_at, updated_at';
/** A page of assignments: the most one read answers. */
export const PROJECT_AGENTS_PAGE_MAX = 200;

const missingTable = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42P01' || error.code === 'PGRST205' || /project_agents.*(does not exist|schema cache)|schema cache.*project_agents/i.test(error.message ?? ''));

/** The update has not run yet: say so plainly instead of a 500. */
export function migrationPending(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Agent workspaces need the database update 20261124000800_agent_workspaces.sql', { reason: 'migration_pending' });
}

export interface AssignmentInput {
  status?: ProjectAgentStatus;
  template_key?: string | null;
  settings?: SettingsValues | Record<string, unknown>;
  instructions?: string;
}

/** A template this workspace offers (module on), or a 422 naming the choices. */
export function requireTemplate(caller: AgentCaller, key: string): AgentTemplate {
  const available = listAgentTemplates(caller.access);
  const template = findAgentTemplate(key);
  if (!template) {
    throw new ApiError(422, 'VALIDATION_ERROR', `No agent template named ${key}`, { reason: 'unknown_template', templates: available.map((t) => t.key) });
  }
  if (!available.includes(template)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `The ${template.label} template needs the ${template.module} module, which is switched off`, {
      reason: 'module_off', module: template.module,
    });
  }
  return template;
}

/** The settings form of a template key; [] for none or one this workspace does not have. */
export function settingsSchemaOf(templateKey: string | null) {
  return (templateKey ? findAgentTemplate(templateKey)?.settings : undefined) ?? [];
}

/** Settings checked against a template, or a 422 listing every problem (errors, and fields for a form). */
export function checkSettings(template: AgentTemplate | null, settings: unknown, withDefaults: boolean, where = ''): SettingsValues {
  const result = validateTemplateSettings(template?.settings, settings, { withDefaults });
  if (result.ok) return result.settings;
  throw new ApiError(422, 'VALIDATION_ERROR', `${where}${result.errors.map((e) => e.message).join('; ')}`, {
    reason: 'invalid_settings',
    template: template?.key ?? null,
    errors: result.errors,
    fields: settingsErrorFields(result.errors),
  });
}

export function checkInstructions(instructions: unknown): string {
  if (instructions === undefined || instructions === null) return '';
  if (typeof instructions !== 'string') throw new ApiError(422, 'VALIDATION_ERROR', 'instructions must be text', { reason: 'invalid_instructions' });
  if (instructions.length > PROJECT_AGENT_INSTRUCTIONS_MAX) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Instructions must be ${PROJECT_AGENT_INSTRUCTIONS_MAX} characters or fewer`, { reason: 'instructions_too_long', max: PROJECT_AGENT_INSTRUCTIONS_MAX });
  }
  return instructions;
}

/** An active agent member, or 404 / 422. */
export async function loadAgent(service: SupabaseClient, agentId: string): Promise<{ id: string; name: string; role: string; status: string; avatar: string | null }> {
  const { data, error } = await service.from('team_members').select('id, name, role, status, avatar').eq('id', agentId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Agent');
  const row = data as { id: string; name: string; role: string; status: string; avatar: string | null };
  if (row.role !== 'agent') throw new ApiError(422, 'VALIDATION_ERROR', `${row.name} is not an agent`, { reason: 'agents_only' });
  return row;
}

/** A live project the caller reaches, or 404 / 403. */
export async function requireReachableProject(service: SupabaseClient, caller: AgentCaller, projectId: string): Promise<{ id: string; name: string }> {
  const { data, error } = await service.from('projects').select('id, name').eq('id', projectId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, 'NOT_FOUND', 'Project not found. It may be in Trash.', { reason: 'not_found_or_in_trash', resource: 'project' });
  if (!accessAllowsProject(caller.access, projectId, callerChannel(caller))) {
    throw forbidden('Project scope denied', { reason: 'project_scope', project_id: projectId, hint: 'You can only change agents on projects you reach.' });
  }
  return data as { id: string; name: string };
}

/** Whether the caller may add, change or remove this agent's assignments (projects checked separately). */
export async function canAssignAgent(service: SupabaseClient, caller: AgentCaller, agentId: string): Promise<boolean> {
  return callerHolds(caller, 'project_members.manage') || canManageAgent(service, caller, agentId);
}

/** Whether the caller may give an agent access to a project: a workspace Owner, or project_members.manage. */
export function canGrantProjectAccess(caller: AgentCaller): boolean {
  return (caller.access.role === 'owner' && caller.access.status === 'active') || callerHolds(caller, 'project_members.manage');
}

export function projectAccessNeeded(projectIds: string[]): ApiError {
  return forbidden('The agent is not on this project, and only an Owner or a member with project_members.manage adds it', {
    reason: 'project_access_needed',
    project_ids: projectIds,
    hint: 'Ask an Owner or a project manager to add the agent to the project; then you can set it up there.',
  });
}

/** Whether an agent is a member of a project. */
async function agentOnProject(service: SupabaseClient, agentId: string, projectId: string): Promise<boolean> {
  const { data, error } = await service.from('project_members').select('member_id').eq('project_id', projectId).eq('member_id', agentId).maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function requireAssignAgent(service: SupabaseClient, caller: AgentCaller, agentId: string): Promise<void> {
  if (await canAssignAgent(service, caller, agentId)) return;
  throw forbidden('Assigning an agent to a project needs project_members.manage, or to be one of its owners', {
    reason: 'not_agent_owner',
    hint: 'Ask an Owner, a project manager or one of the agent\'s owners.',
  });
}

/** Rows as the API answers them, with the agent's name and the template's settings form, in two reads at most. */
export async function presentAssignments(service: SupabaseClient, rows: Row[], projectNames?: Map<string, string>): Promise<ProjectAgentAssignment[]> {
  const agentIds = [...new Set(rows.map((row) => row.agent_id as string))];
  const projectIds = projectNames ? [] : [...new Set(rows.map((row) => row.project_id as string))];
  const [agents, projects] = await Promise.all([
    agentIds.length
      ? service.from('team_members').select('id, name, avatar, agent_role').in('id', agentIds).then(({ data, error }) => { if (error) throw error; return (data ?? []) as Row[]; })
      : Promise.resolve([] as Row[]),
    projectIds.length
      ? service.from('projects').select('id, name').in('id', projectIds).is('deleted_at', null).then(({ data, error }) => { if (error) throw error; return (data ?? []) as Row[]; })
      : Promise.resolve([] as Row[]),
  ]);
  const agentById = new Map(agents.map((agent) => [agent.id as string, agent]));
  const names = projectNames ?? new Map(projects.map((project) => [project.id as string, project.name as string]));
  return rows.map((row) => {
    const agent = agentById.get(row.agent_id);
    return {
      agent_id: row.agent_id,
      agent_name: agent?.name ?? 'An agent',
      avatar_url: agent?.avatar || null,
      agent_role: agent?.agent_role ?? null,
      status: row.status,
      template_key: row.template_key ?? null,
      settings: (row.settings ?? {}) as SettingsValues,
      instructions: row.instructions ?? '',
      settings_schema: settingsSchemaOf(row.template_key ?? null),
      created_at: row.created_at,
      updated_at: row.updated_at,
      project_id: row.project_id,
      ...(names.has(row.project_id) ? { project_name: names.get(row.project_id) } : {}),
    };
  });
}

export interface AssignmentFilters {
  status?: string | null;
  template?: string | null;
  offset: number;
  limit: number;
}

/**
 * A project's agents, newest first, paged. The caller must reach the
 * project; an agent sees only its own row.
 */
export async function listProjectAgents(service: SupabaseClient, caller: AgentCaller, projectId: string, filters: AssignmentFilters) {
  requireAgentsEnabled(caller.access);
  const project = await requireReachableProject(service, caller, projectId);
  let query = service.from('project_agents').select(PROJECT_AGENT_COLUMNS, { count: 'exact' }).eq('project_id', projectId);
  if (caller.access.role === 'agent') query = query.eq('agent_id', caller.memberId);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.template) query = query.eq('template_key', filters.template);
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(filters.offset, filters.offset + filters.limit - 1);
  if (missingTable(error)) throw migrationPending();
  if (error) throw error;
  const rows = await presentAssignments(service, (data ?? []) as Row[], new Map([[project.id, project.name]]));
  return { rows, total: count ?? rows.length };
}

/**
 * One agent's assignments as the viewer may see them: projects the viewer
 * cannot reach are counted in hidden_count, never named. Newest first, paged.
 */
export async function listAgentAssignments(service: SupabaseClient, viewer: AgentCaller, agentId: string, filters: AssignmentFilters) {
  let query = service.from('project_agents').select(`${PROJECT_AGENT_COLUMNS}, project:projects!inner(id, name)`, { count: 'exact' })
    .eq('agent_id', agentId).is('project.deleted_at', null);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.template) query = query.eq('template_key', filters.template);
  const self = viewer.memberId === agentId;
  const reachAll = self || accessAllows(viewer.access, 'projects.read_all', callerChannel(viewer));
  // A viewer who reaches only some projects reads only those, so a page is never short.
  if (!reachAll) query = query.in('project_id', viewer.access.project_ids.length ? viewer.access.project_ids : ['00000000-0000-0000-0000-000000000000']);
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(filters.offset, filters.offset + filters.limit - 1);
  if (missingTable(error)) throw migrationPending();
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const names = new Map(rows.map((row) => {
    const project = Array.isArray(row.project) ? row.project[0] : row.project;
    return [row.project_id as string, (project?.name as string) ?? ''];
  }));
  let hidden = 0;
  if (!reachAll) {
    const { count: all, error: countError } = await service.from('project_agents').select('id', { count: 'exact', head: true }).eq('agent_id', agentId);
    if (countError) throw countError;
    hidden = Math.max(0, (all ?? 0) - (count ?? 0));
  }
  return {
    rows: await presentAssignments(service, rows.map(({ project: _project, ...row }) => row), names),
    total: count ?? rows.length,
    hidden_count: hidden,
  };
}

/**
 * Gives an agent access to projects it is not on yet, in one read and one
 * write. Answers the projects it was added to (the project activity log
 * records each, as for any member added).
 */
export async function ensureProjectAccess(service: SupabaseClient, agentId: string, projectIds: string[]): Promise<string[]> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return [];
  const { data, error } = await service.from('project_members').select('project_id').eq('member_id', agentId).in('project_id', ids);
  if (error) throw error;
  const on = new Set(((data ?? []) as { project_id: string }[]).map((row) => row.project_id));
  const missing = ids.filter((id) => !on.has(id));
  if (missing.length) {
    const { error: insertError } = await service.from('project_members').insert(missing.map((project_id) => ({ project_id, member_id: agentId })));
    if (insertError) throw insertError;
  }
  return missing;
}

/** A new assignment's row, checked: the template, its settings with defaults, and the instructions. */
export function newAssignmentRow(caller: AgentCaller, projectId: string, agentId: string, input: AssignmentInput, where = ''): Row {
  const template = input.template_key ? requireTemplate(caller, input.template_key) : null;
  return {
    project_id: projectId,
    agent_id: agentId,
    status: input.status ?? 'active',
    template_key: template?.key ?? null,
    settings: checkSettings(template, input.settings ?? {}, true, where),
    instructions: checkInstructions(input.instructions),
    created_by: caller.memberId,
  };
}

/**
 * Adds an agent to a project or changes its assignment there (PUT). A new
 * one also gives the agent project access when it lacks it. Answers the
 * assignment, whether it was created, and whether access was added.
 */
export async function putProjectAgent(service: SupabaseClient, caller: AgentCaller, projectId: string, agentId: string, input: AssignmentInput) {
  requireAgentsEnabled(caller.access);
  const project = await requireReachableProject(service, caller, projectId);
  const agent = await loadAgent(service, agentId);
  await requireAssignAgent(service, caller, agentId);
  const onProject = await agentOnProject(service, agentId, projectId);
  if (!onProject && !canGrantProjectAccess(caller)) throw projectAccessNeeded([projectId]);

  const { data: existing, error } = await service.from('project_agents').select(PROJECT_AGENT_COLUMNS).eq('project_id', projectId).eq('agent_id', agentId).maybeSingle();
  if (missingTable(error)) throw migrationPending();
  if (error) throw error;

  let row: Row;
  let created = false;
  let accessAdded: string[] = [];
  if (!existing) {
    if (agent.status !== 'active') {
      throw new ApiError(422, 'VALIDATION_ERROR', `${agent.name} is suspended. Reactivate them in Team first.`, { reason: 'member_suspended' });
    }
    const insert = newAssignmentRow(caller, projectId, agentId, input);
    if (!onProject) accessAdded = await ensureProjectAccess(service, agentId, [projectId]);
    const { data, error: insertError } = await service.from('project_agents').insert(insert).select(PROJECT_AGENT_COLUMNS).single();
    if (insertError) throw insertError;
    row = data as Row;
    created = true;
  } else {
    const current = existing as Row;
    const patch: Row = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.instructions !== undefined) patch.instructions = checkInstructions(input.instructions);
    const templateChanges = input.template_key !== undefined && (input.template_key ?? null) !== (current.template_key ?? null);
    if (templateChanges) {
      const template = input.template_key ? requireTemplate(caller, input.template_key) : null;
      patch.template_key = template?.key ?? null;
      // A new template starts its settings over, from what was sent and its defaults.
      patch.settings = checkSettings(template, input.settings ?? {}, true);
    } else if (input.settings !== undefined) {
      const template = current.template_key ? findAgentTemplate(current.template_key) : null;
      patch.settings = checkSettings(template, input.settings, false);
    }
    if (Object.keys(patch).length === 0) {
      row = current;
    } else {
      const { data, error: updateError } = await service.from('project_agents').update(patch).eq('id', current.id).select(PROJECT_AGENT_COLUMNS).single();
      if (updateError) throw updateError;
      row = data as Row;
    }
  }
  const [assignment] = await presentAssignments(service, [row], new Map([[project.id, project.name]]));
  return { assignment, created, access_added: accessAdded.length > 0 };
}

/** Takes an agent off a project. Its project access stays. Answers whether there was an assignment. */
export async function removeProjectAgent(service: SupabaseClient, caller: AgentCaller, projectId: string, agentId: string): Promise<{ removed: boolean; assignment: ProjectAgentAssignment | null }> {
  requireAgentsEnabled(caller.access);
  await requireReachableProject(service, caller, projectId);
  await requireAssignAgent(service, caller, agentId);
  const { data, error } = await service.from('project_agents').delete().eq('project_id', projectId).eq('agent_id', agentId).select(PROJECT_AGENT_COLUMNS);
  if (missingTable(error)) throw migrationPending();
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const [assignment] = rows.length ? await presentAssignments(service, rows) : [null];
  return { removed: rows.length > 0, assignment };
}

/** The caller's own assignment on a project, if it has one (for its context pack and task brief). */
export async function ownAssignment(service: SupabaseClient, agentId: string, projectId: string): Promise<Row | null> {
  const { data, error } = await service.from('project_agents').select(PROJECT_AGENT_COLUMNS).eq('project_id', projectId).eq('agent_id', agentId).maybeSingle();
  if (error) return null;
  return (data as Row | null) ?? null;
}
