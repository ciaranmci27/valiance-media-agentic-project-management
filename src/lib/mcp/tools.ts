import { z } from 'zod';
import { AGENT_EVENT_SCHEMAS, AGENT_EVENT_TYPES, isServerEvent, isTelemetryEvent, type AgentEventType } from '@/lib/agent-events';
import { routeTool, type PmTool } from './core';

/**
 * The PM MCP server's tools: a curated set over the v1 API (it has no
 * operation registry, so tools are written by hand). Names carry their
 * domain noun and each lead says plainly what the tool does in 60 characters
 * or fewer: Hermes shows agents the name and the first sentence, and its
 * tool search matches on them. The server key is `pm`, so names arrive as
 * mcp__pm__<tool>.
 *
 * Inputs are strict and check what the routes leave to the database (query
 * enums and uuids), so a bad argument is a readable refusal, not a 500.
 * Fields a route requires but decides itself (a comment's author, a timer's
 * member) are filled from the key, never asked for.
 *
 * Left out on purpose: credentials, client emails (outbound, and the inbound
 * inbox at /api/v1/inbound-emails, which has its own plugin tools), invoices, rates, time
 * approval, team writes, every hard delete, the unscoped app activity feed,
 * suggestion approve/decline, and agent health.
 */

export const GUIDE_TOOL = 'pm_guide';

const id = (what: string) => z.uuid(`${what} must be a uuid`);
const page = z.number().int().min(1).optional().describe('Page number, from 1');
const limit = (fallback: number) =>
  z.number().int().min(1).max(100).default(fallback).describe(`Rows per page (1-100, default ${fallback})`);
const order = z.enum(['asc', 'desc']).optional().describe('Default desc');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const TASK_STATUS = z.enum(['todo', 'in_progress', 'in_review', 'done']);
const PRIORITY = z.enum(['low', 'medium', 'high', 'urgent']);
const TASK_TYPE = z.enum(['engineering', 'research', 'audit', 'marketing', 'copywriting', 'operations', 'general']);
// null or human_only: a person does it. needs_spec: meant for the dev agent,
// spec not written yet. ai_ready: specced, the only value the dev agent claims.
const AI_READINESS = z.enum(['ai_ready', 'needs_spec', 'human_only']);
const CONTEXT_CATEGORY = z.enum(['business_context', 'existing_work', 'technical_decision', 'constraint', 'lesson_learned']);
const EFFORT = z.enum(['small', 'medium', 'large']);
const atLeastOne = (fields: string[]) => (value: Record<string, unknown>) =>
  fields.some((field) => value[field] !== undefined);

const short = (text: unknown, max = 300) =>
  typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : text;
const count = (rows: unknown, done?: (row: Record<string, unknown>) => boolean) => {
  const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  return done ? { done: list.filter(done).length, total: list.length } : list.length;
};

/** List rows embed every comment; agents get a summary and read one task in full with get_task. */
function taskSummary(row: Record<string, unknown>) {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    task_type: row.task_type,
    ai_readiness: row.ai_readiness,
    due_date: row.due_date,
    tags: row.tags,
    assignee_ids: row.assignee_ids,
    blocked_by_ids: row.blocked_by_ids,
    project_goal_id: row.project_goal_id,
    description: short(row.description),
    subtasks: count(row.subtasks, (s) => s.completed === true),
    acceptance_criteria: count(row.acceptance_criteria, (c) => c.satisfied === true),
    comment_count: count(row.comments),
    updated_at: row.updated_at,
  };
}

function projectSummary(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    description: short(row.description),
    member_ids: row.member_ids,
    autonomous_enabled: row.autonomous_enabled,
    repo_path: row.repo_path,
    archived_at: row.archived_at,
    updated_at: row.updated_at,
  };
}

/**
 * One task, bounded: a long spec, a long review or years of comments must
 * never make a task unreadable. Long text is cut with a flag and only the
 * newest comments come back; list_task_comments pages through the rest.
 */
const TASK_TEXT_MAX = 15_000;
const REVIEW_TEXT_MAX = 3000;
const COMMENT_TEXT_MAX = 1500;
const TASK_COMMENTS_SHOWN = 10;
function taskInFull(data: unknown) {
  if (!data || typeof data !== 'object') return data;
  const task = data as Record<string, unknown>;
  const comments = Array.isArray(task.comments) ? (task.comments as Record<string, unknown>[]) : [];
  const review = task.latest_review as Record<string, unknown> | null | undefined;
  const description = typeof task.description === 'string' ? task.description : '';
  return {
    ...task,
    description: short(description, TASK_TEXT_MAX),
    ...(description.length > TASK_TEXT_MAX ? { description_truncated: true } : {}),
    latest_review: review ? { ...review, summary: short(review.summary, REVIEW_TEXT_MAX) } : review ?? null,
    comments: comments.slice(-TASK_COMMENTS_SHOWN).map((comment) => ({ ...comment, text: short(comment.text, COMMENT_TEXT_MAX) })),
    comment_count: comments.length,
    ...(comments.length > TASK_COMMENTS_SHOWN ? { comments_note: `Newest ${TASK_COMMENTS_SHOWN} of ${comments.length}; list_task_comments has the rest.` } : {}),
  };
}

const mapRows = (fn: (row: Record<string, unknown>) => unknown) => (data: unknown) =>
  Array.isArray(data) ? data.map((row) => fn(row as Record<string, unknown>)) : data;

/** Typed events an agent may log; usage and turn telemetry come from the host publishers. */
const AGENT_EVENTS = AGENT_EVENT_TYPES.filter((type) => !isTelemetryEvent(type) && !isServerEvent(type)) as [AgentEventType, ...AgentEventType[]];

export const PM_TOOLS: PmTool[] = [
  {
    name: GUIDE_TOOL,
    lead: 'Read first: how the PM tools work and their limits.',
    detail: 'Covers ids, task flow, reviews, time, suggestions, events and errors, and lists the tools this key can use.',
    input: z.object({}).strict(),
    permission: [],
    routes: [],
    write: false,
    run: async () => ({ kind: 'payload', payload: { ok: true } }),
  },

  // Projects
  routeTool({
    name: 'list_projects',
    lead: 'List the projects this key can see.',
    detail: 'Summaries; read one project in full with get_project.',
    input: z.object({
      search: z.string().min(1).max(200).optional(),
      status: z.enum(['active', 'completed', 'archived']).optional(),
      include_archived: z.boolean().optional(),
      autonomous_enabled: z.boolean().optional(),
      sort: z.enum(['created_at', 'updated_at', 'name', 'status']).optional(),
      order, page, limit: limit(25),
    }).strict(),
    permission: 'projects.read',
    method: 'GET',
    path: '/api/v1/projects',
    request: (args) => ({ query: args }),
    present: mapRows(projectSummary),
  }),
  routeTool({
    name: 'get_project',
    lead: 'Get one project with its settings.',
    detail: 'Includes the agent settings (autonomy, branches, repo path, suggestion caps).',
    input: z.object({ project_id: id('project_id') }).strict(),
    permission: 'projects.read',
    method: 'GET',
    path: '/api/v1/projects/{id}',
    request: (args) => ({ params: { id: args.project_id } }),
  }),
  routeTool({
    name: 'get_project_context',
    lead: "Read a project's context notes (decisions, constraints).",
    detail: 'Active entries by default. Filter by category or since (ISO time) to keep it small; up to 500 entries.',
    input: z.object({
      project_id: id('project_id'),
      category: CONTEXT_CATEGORY.optional(),
      inactive: z.boolean().optional().describe('true: archived entries only'),
      since: z.iso.datetime({ offset: true }).optional(),
    }).strict(),
    permission: 'project_context.read',
    method: 'GET',
    path: '/api/v1/projects/{id}/context',
    request: ({ project_id, inactive, ...query }) => ({
      params: { id: project_id },
      query: { ...query, ...(inactive ? { is_active: 'false' } : {}) },
    }),
  }),
  routeTool({
    name: 'add_project_context',
    lead: 'Add a context note to a project.',
    detail: 'Recorded as written by an agent. For existing_work with a file_path, the active note for that file is updated instead.',
    input: z.object({
      project_id: id('project_id'),
      category: CONTEXT_CATEGORY,
      content: z.string().min(1).max(20_000),
      file_path: z.string().min(1).max(500).optional(),
    }).strict(),
    permission: 'project_context.manage',
    method: 'POST',
    path: '/api/v1/projects/{id}/context',
    request: ({ project_id, ...body }) => ({ params: { id: project_id }, body: { ...body, source: 'agent' } }),
  }),
  routeTool({
    name: 'list_project_goals',
    lead: "List a project's goals.",
    detail: 'Archived goals are never listed.',
    input: z.object({
      project_id: id('project_id'),
      status: z.enum(['active', 'achieved', 'paused', 'abandoned']).optional(),
      page, limit: limit(25),
    }).strict(),
    permission: 'goals.read',
    method: 'GET',
    path: '/api/v1/projects/{id}/goals',
    request: ({ project_id, ...query }) => ({ params: { id: project_id }, query }),
  }),

  // Tasks
  routeTool({
    name: 'search_tasks',
    lead: 'Search tasks by project, status, assignee or text.',
    detail: 'Summaries with progress counts; read one task in full (comments, latest review, dependencies) with get_task.',
    input: z.object({
      search: z.string().min(1).max(200).optional(),
      project_id: id('project_id').optional(),
      status: TASK_STATUS.optional(),
      priority: PRIORITY.optional(),
      assignee_id: id('assignee_id').optional(),
      task_type: TASK_TYPE.optional(),
      ai_readiness: AI_READINESS.optional(),
      project_goal_id: id('project_goal_id').optional(),
      sort: z.enum(['created_at', 'updated_at', 'title', 'status', 'priority', 'due_date']).optional(),
      order, page, limit: limit(20),
    }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/tasks',
    request: (args) => ({ query: args }),
    present: mapRows(taskSummary),
  }),
  routeTool({
    name: 'get_task',
    lead: 'Get one task in full, with its latest review.',
    detail: `Includes subtasks, acceptance criteria, blockers, dependencies_met (false unless every blocker is done) and the newest ${TASK_COMMENTS_SHOWN} comments; list_task_comments has older ones. Very long text is cut and flagged.`,
    input: z.object({ task_id: id('task_id') }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/tasks/{id}',
    request: (args) => ({ params: { id: args.task_id } }),
    present: taskInFull,
  }),
  routeTool({
    name: 'list_task_comments',
    lead: "List a task's comments, oldest first.",
    detail: 'Pages through every comment; get_task shows only the newest.',
    input: z.object({ task_id: id('task_id'), page, limit: limit(25) }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/tasks/{id}/comments',
    request: ({ task_id, ...query }) => ({ params: { id: task_id }, query }),
  }),
  routeTool({
    name: 'list_task_reviews',
    lead: "List a task's review history, newest first.",
    detail: 'get_task already carries the latest review.',
    input: z.object({ task_id: id('task_id'), page, limit: limit(25) }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/tasks/{id}/reviews',
    request: ({ task_id, ...query }) => ({ params: { id: task_id }, query }),
  }),
  routeTool({
    name: 'create_task',
    lead: 'Create a task in a project.',
    detail: 'Without tasks.manage_all the task is assigned to you and no one else. Blockers and the goal must be in the same project.',
    input: z.object({
      project_id: id('project_id'),
      title: z.string().min(1).max(500),
      description: z.string().max(50_000).optional(),
      status: TASK_STATUS.optional(),
      priority: PRIORITY.optional(),
      due_date: date.nullable().optional(),
      tags: z.array(z.string().min(1).max(100)).max(50).optional(),
      assignee_ids: z.array(id('assignee_ids')).max(20).optional(),
      project_goal_id: id('project_goal_id').nullable().optional(),
      task_type: TASK_TYPE.nullable().optional(),
      ai_readiness: AI_READINESS.nullable().optional(),
      acceptance_criteria: z.array(z.string().min(1).max(2000)).max(50).optional(),
      blocked_by_ids: z.array(id('blocked_by_ids')).max(50).optional(),
    }).strict(),
    permission: 'tasks.create',
    method: 'POST',
    path: '/api/v1/tasks',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_task',
    lead: "Change a task's fields, status or blockers.",
    detail:
      'Send only what changes. acceptance_criteria REPLACES every criterion and clears their satisfied flags; use add_acceptance_criterion or update_acceptance_criterion for one. Changing assignees or project needs tasks.manage_all. Answers with the bare task row.',
    input: z.object({
      task_id: id('task_id'),
      title: z.string().min(1).max(500).optional(),
      description: z.string().max(50_000).optional(),
      status: TASK_STATUS.optional(),
      priority: PRIORITY.optional(),
      due_date: date.nullable().optional(),
      tags: z.array(z.string().min(1).max(100)).max(50).optional(),
      assignee_ids: z.array(id('assignee_ids')).max(20).optional(),
      project_id: id('project_id').optional(),
      project_goal_id: id('project_goal_id').nullable().optional(),
      task_type: TASK_TYPE.nullable().optional(),
      ai_readiness: AI_READINESS.nullable().optional(),
      acceptance_criteria: z.array(z.string().min(1).max(2000)).max(50).optional(),
      blocked_by_ids: z.array(id('blocked_by_ids')).max(50).optional(),
    }).strict().refine(
      atLeastOne(['title', 'description', 'status', 'priority', 'due_date', 'tags', 'assignee_ids', 'project_id', 'project_goal_id', 'task_type', 'ai_readiness', 'acceptance_criteria', 'blocked_by_ids']),
      'Send at least one field to change',
    ),
    permission: 'tasks.manage_assigned',
    method: 'PATCH',
    path: '/api/v1/tasks/{id}',
    request: ({ task_id, ...body }) => ({ params: { id: task_id }, body }),
  }),
  routeTool({
    name: 'add_task_comment',
    lead: 'Add a comment to a task.',
    detail: 'Posted under your own name.',
    input: z.object({ task_id: id('task_id'), text: z.string().min(1).max(20_000) }).strict(),
    permission: 'tasks.read',
    method: 'POST',
    path: '/api/v1/tasks/{id}/comments',
    // The route requires user_id but always uses the key's member.
    request: ({ task_id, text }, context) => ({ params: { id: task_id }, body: { user_id: context.memberId, text } }),
  }),
  routeTool({
    name: 'add_subtask',
    lead: 'Add a subtask to a task.',
    detail: 'Added at the end of the list.',
    input: z.object({ task_id: id('task_id'), title: z.string().min(1).max(500) }).strict(),
    permission: 'tasks.manage_assigned',
    method: 'POST',
    path: '/api/v1/tasks/{id}/subtasks',
    request: ({ task_id, title }) => ({ params: { id: task_id }, body: { title } }),
  }),
  routeTool({
    name: 'update_subtask',
    lead: 'Rename a subtask or mark it done or not done.',
    detail: 'The subtask must belong to the task.',
    input: z.object({
      task_id: id('task_id'),
      subtask_id: id('subtask_id'),
      title: z.string().min(1).max(500).optional(),
      completed: z.boolean().optional(),
    }).strict().refine(atLeastOne(['title', 'completed']), 'Send title or completed'),
    permission: 'tasks.manage_assigned',
    method: 'PATCH',
    path: '/api/v1/tasks/{id}/subtasks/{subtaskId}',
    request: ({ task_id, subtask_id, ...body }) => ({ params: { id: task_id, subtaskId: subtask_id }, body }),
  }),
  routeTool({
    name: 'add_acceptance_criterion',
    lead: 'Add one acceptance criterion to a task.',
    detail: 'Leaves the existing criteria as they are.',
    input: z.object({ task_id: id('task_id'), criterion: z.string().min(1).max(2000) }).strict(),
    permission: 'tasks.manage_assigned',
    method: 'POST',
    path: '/api/v1/tasks/{id}/acceptance-criteria',
    request: ({ task_id, criterion }) => ({ params: { id: task_id }, body: { criterion } }),
  }),
  routeTool({
    name: 'update_acceptance_criterion',
    lead: 'Reword an acceptance criterion or mark it met.',
    detail: 'The criterion must belong to the task.',
    input: z.object({
      task_id: id('task_id'),
      criterion_id: id('criterion_id'),
      criterion: z.string().min(1).max(2000).optional(),
      satisfied: z.boolean().optional(),
    }).strict().refine(atLeastOne(['criterion', 'satisfied']), 'Send criterion or satisfied'),
    permission: 'tasks.manage_assigned',
    method: 'PATCH',
    path: '/api/v1/tasks/{id}/acceptance-criteria/{criterionId}',
    request: ({ task_id, criterion_id, ...body }) => ({ params: { id: task_id, criterionId: criterion_id }, body }),
  }),
  {
    name: 'submit_task_review',
    lead: "Record a review verdict on a task's pull request.",
    detail:
      'Needs tasks.manage_all; assignees cannot review their own work. One verdict per pull request commit: if this commit was already reviewed, the first verdict stands and is returned with already_reviewed.',
    input: z.object({
      task_id: id('task_id'),
      verdict: z.enum(['approved', 'changes_requested']),
      summary: z.string().min(1).max(20_000),
      pr_url: z.url(),
      head_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'head_sha must be the full 40-character commit SHA'),
    }).strict(),
    permission: 'tasks.manage_all',
    routes: [{ method: 'POST', path: '/api/v1/tasks/{id}/reviews' }],
    write: true,
    destructive: false,
    idempotent: true,
    run: async (args, call) => {
      const { task_id, ...body } = args as { task_id: string; verdict: string } & Record<string, unknown>;
      const result = await call({ method: 'POST', path: '/api/v1/tasks/{id}/reviews', params: { id: task_id }, body });
      return {
        kind: 'route',
        result,
        // The route answers a repeat for the same commit with the first review.
        present: (data) => {
          const row = data as { verdict?: string; summary?: string } | null;
          return row && (row.verdict !== body.verdict || row.summary !== body.summary)
            ? { ...row, already_reviewed: true }
            : data;
        },
      };
    },
  },

  // Time
  routeTool({
    name: 'list_time_entries',
    lead: "List time entries on a project, newest first.",
    detail: 'Your own entries unless your key holds time.read_all. running=true lists open timers.',
    input: z.object({
      project_id: id('project_id'),
      running: z.boolean().optional(),
      task_id: id('task_id').optional(),
      member_id: id('member_id').optional().describe('Needs time.read_all; otherwise your own entries'),
      page, limit: limit(25),
    }).strict(),
    permission: ['time.manage_own', 'time.read_all', 'time.manage_all'],
    method: 'GET',
    path: '/api/v1/projects/{id}/time-entries',
    request: ({ project_id, ...query }) => ({ params: { id: project_id }, query }),
  }),
  {
    name: 'timer',
    lead: 'Start, pause, resume or stop your timer on a project.',
    detail:
      'start opens a live timer (one per project at a time); pause, resume and stop need its entry_id; log records a finished block with start_time and end_time. A resume after a pause that crossed into another day closes the entry instead: check finalized in the answer.',
    input: z.object({
      action: z.enum(['start', 'pause', 'resume', 'stop', 'log']),
      project_id: id('project_id'),
      entry_id: id('entry_id').optional().describe('pause, resume and stop'),
      description: z.string().max(2000).optional().describe('start and log'),
      work_type: z.enum(['client', 'internal']).optional().describe('start and log; default client'),
      task_ids: z.array(id('task_ids')).max(20).optional().describe('start and log'),
      start_time: z.string().min(1).optional().describe('log only: ISO time'),
      end_time: z.string().min(1).optional().describe('log only: ISO time'),
      timezone: z.string().min(1).max(100).optional().describe('log only: zone for times without an offset'),
    }).strict().superRefine((args, ctx) => {
      const needsEntry = args.action === 'pause' || args.action === 'resume' || args.action === 'stop';
      if (needsEntry && !args.entry_id) ctx.addIssue({ code: 'custom', path: ['entry_id'], message: `${args.action} needs entry_id` });
      if (!needsEntry && args.entry_id) ctx.addIssue({ code: 'custom', path: ['entry_id'], message: `${args.action} takes no entry_id` });
      const timed = args.start_time !== undefined || args.end_time !== undefined || args.timezone !== undefined;
      if (args.action === 'log' && (!args.start_time || !args.end_time)) ctx.addIssue({ code: 'custom', path: ['start_time'], message: 'log needs start_time and end_time' });
      if (args.action !== 'log' && timed) ctx.addIssue({ code: 'custom', path: ['start_time'], message: 'start_time, end_time and timezone are for log only' });
      const details = args.description !== undefined || args.work_type !== undefined || args.task_ids !== undefined;
      if (needsEntry && details) ctx.addIssue({ code: 'custom', path: ['description'], message: `${args.action} takes only project_id and entry_id` });
    }),
    permission: ['time.manage_own', 'time.manage_all'],
    routes: [
      { method: 'POST', path: '/api/v1/projects/{id}/time-entries' },
      { method: 'POST', path: '/api/v1/projects/{id}/time-entries/{entryId}/pause' },
      { method: 'POST', path: '/api/v1/projects/{id}/time-entries/{entryId}/resume' },
      { method: 'POST', path: '/api/v1/projects/{id}/time-entries/{entryId}/stop' },
    ],
    write: true,
    destructive: false,
    idempotent: false,
    run: async (args, call, context) => {
      const { action, project_id, entry_id, ...rest } = args as {
        action: 'start' | 'pause' | 'resume' | 'stop' | 'log';
        project_id: string;
        entry_id?: string;
      } & Record<string, unknown>;
      if (action === 'start' || action === 'log') {
        // The route requires member_id and uses the key's own member unless
        // the key may manage everyone's time; timers here are always yours.
        return {
          kind: 'route',
          result: await call({
            method: 'POST',
            path: '/api/v1/projects/{id}/time-entries',
            params: { id: project_id },
            body: { member_id: context.memberId, ...rest },
          }),
        };
      }
      const result = await call({
        method: 'POST',
        path: `/api/v1/projects/{id}/time-entries/{entryId}/${action}`,
        params: { id: project_id, entryId: entry_id as string },
      });
      return {
        kind: 'route',
        result,
        present: (data) => {
          const row = data as { end_time?: string | null } | null;
          return action === 'resume' && row?.end_time ? { ...row, finalized: true } : data;
        },
      };
    },
  },

  // Suggestions
  routeTool({
    name: 'list_task_suggestions',
    lead: 'List task suggestions awaiting or past review.',
    detail: 'Filter by status, project, goal or proposer.',
    input: z.object({
      status: z.enum(['pending', 'needs_info', 'approved', 'rejected', 'declined']).optional(),
      project_id: id('project_id').optional(),
      goal_id: id('goal_id').optional(),
      proposed_by: id('proposed_by').optional(),
      task_type: TASK_TYPE.optional(),
      page, limit: limit(25),
    }).strict(),
    permission: ['suggestions.create', 'suggestions.manage'],
    method: 'GET',
    path: '/api/v1/task-suggestions',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'get_task_suggestion',
    lead: 'Get one task suggestion, with any info request.',
    detail: 'info_request holds what the owner asked when the status is needs_info.',
    input: z.object({ suggestion_id: id('suggestion_id') }).strict(),
    permission: ['suggestions.create', 'suggestions.manage'],
    method: 'GET',
    path: '/api/v1/task-suggestions/{id}',
    request: (args) => ({ params: { id: args.suggestion_id } }),
  }),
  routeTool({
    name: 'create_task_suggestion',
    lead: 'Propose a task for the owner to approve.',
    detail:
      'Agents only. It needs a goal in the same project and stays pending until the owner decides. bundle_with groups it with another pending suggestion for one review.',
    input: z.object({
      project_id: id('project_id'),
      goal_id: id('goal_id'),
      title: z.string().min(1).max(500),
      description: z.string().min(1).max(20_000),
      reasoning: z.string().min(1).max(20_000),
      priority: PRIORITY.optional(),
      effort_estimate: EFFORT.nullable().optional(),
      assigned_to: id('assigned_to').nullable().optional(),
      task_type: TASK_TYPE.nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      bundle_with: id('bundle_with').nullable().optional(),
    }).strict(),
    permission: 'suggestions.create',
    agentsOnly: true,
    method: 'POST',
    path: '/api/v1/task-suggestions',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_task_suggestion',
    lead: 'Edit a suggestion, or answer an info request on it.',
    detail:
      "To answer an info request, add your answer to the description. Without suggestions.manage you can only edit your own. metadata replaces the whole object. Status changes are the owner's.",
    input: z.object({
      suggestion_id: id('suggestion_id'),
      title: z.string().min(1).max(500).optional(),
      description: z.string().min(1).max(20_000).optional(),
      reasoning: z.string().min(1).max(20_000).optional(),
      priority: PRIORITY.optional(),
      effort_estimate: EFFORT.nullable().optional(),
      task_type: TASK_TYPE.nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }).strict().refine(
      atLeastOne(['title', 'description', 'reasoning', 'priority', 'effort_estimate', 'task_type', 'metadata']),
      'Send at least one field to change',
    ),
    permission: ['suggestions.create', 'suggestions.manage'],
    method: 'PATCH',
    path: '/api/v1/task-suggestions/{id}',
    request: ({ suggestion_id, ...body }) => ({ params: { id: suggestion_id }, body }),
  }),

  // Notifications and events
  routeTool({
    name: 'list_notifications',
    lead: 'List your own notifications, newest first.',
    detail: 'is_read=false for unread only.',
    input: z.object({
      is_read: z.boolean().optional(),
      entity_type: z.enum(['task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question']).optional(),
      page, limit: limit(25),
    }).strict(),
    permission: 'notifications.manage_own',
    method: 'GET',
    path: '/api/v1/notifications',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'notify_owner',
    lead: 'Send the owner a notification, such as a question.',
    detail:
      'Goes to the workspace owner. Pass the entity_id of what it is about to avoid duplicate unread notifications for the same thing.',
    input: z.object({
      title: z.string().min(1).max(200),
      message: z.string().min(1).max(5000),
      link: z.string().min(1).max(2000).nullable().optional(),
      entity_type: z.enum(['task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question']).optional(),
      entity_id: id('entity_id').nullable().optional(),
    }).strict(),
    permission: 'notifications.send',
    method: 'POST',
    path: '/api/v1/notifications',
    request: (body) => ({ body: { ...body, audience: 'owner' } }),
  }),
  routeTool({
    name: 'list_agent_activity',
    lead: 'List the agent activity feed, newest first.',
    detail: 'Filter by agent, project or activity_type. Rows without a project are hidden unless your key can read every project.',
    input: z.object({
      agent_id: id('agent_id').optional(),
      project_id: id('project_id').optional(),
      activity_type: z.string().min(1).max(100).optional(),
      page, limit: limit(25),
    }).strict(),
    permission: 'audit.read',
    method: 'GET',
    path: '/api/v1/agent-activities',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'log_activity',
    lead: 'Log a typed agent event to the activity feed.',
    detail:
      "Agents only. The feed line is written by the server from the payload; free-text events are not accepted. Payloads: work.claimed/work.done {task_id?, task_title}; work.milestone {task_id?, kind: subtask|criterion|comment|commit|session|note, detail}; work.handoff {task_title, pr_url?, round?}; pr.merged {pr_url, additions, deletions}; review.started {task_title, round}; review.verdict {verdict, round, pr_url?, findings?}; audit.finding {subject, findings, note?}; audit.no_work {reason}; spec.completed {subject}; queue.empty {queue: review|work|spec|audit}; blocked {task_id?, reason}; billing.started|paused|resumed|stopped {task_id?}.",
    input: z.object({
      activity_type: z.enum(AGENT_EVENTS),
      payload: z.record(z.string(), z.unknown()),
      project_id: id('project_id').nullable().optional(),
    }).strict().superRefine((args, ctx) => {
      const parsed = AGENT_EVENT_SCHEMAS[args.activity_type].safeParse(args.payload);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({ code: 'custom', path: ['payload', ...issue.path.map(String)], message: issue.message });
    }),
    permission: 'agent_activity.write',
    agentsOnly: true,
    method: 'POST',
    path: '/api/v1/agent-activities',
    request: (body) => ({ body }),
  }),

  // Team, leads, contacts
  routeTool({
    name: 'list_team',
    lead: 'List team members and their roles.',
    detail: 'Use the ids for assignees.',
    input: z.object({ search: z.string().min(1).max(200).optional(), page, limit: limit(50) }).strict(),
    permission: 'team.read',
    method: 'GET',
    path: '/api/v1/team-members',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'list_leads',
    lead: 'List sales leads this key can see.',
    detail: 'Without leads.read_all, only leads you are assigned to.',
    input: z.object({
      search: z.string().min(1).max(200).optional(),
      status: z.enum(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost']).optional(),
      source: z.enum(['referral', 'website', 'social', 'cold_outreach', 'event', 'network', 'other']).optional(),
      assigned_to: id('assigned_to').optional(),
      include_archived: z.boolean().optional(),
      sort: z.enum(['created_at', 'updated_at', 'name', 'email', 'company', 'status', 'source', 'value']).optional(),
      order, page, limit: limit(25),
    }).strict(),
    permission: 'leads.read',
    method: 'GET',
    path: '/api/v1/leads',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'get_lead',
    lead: 'Get one sales lead.',
    detail: 'A lead you cannot see answers 403, the same as one that does not exist.',
    input: z.object({ lead_id: id('lead_id') }).strict(),
    permission: 'leads.read',
    method: 'GET',
    path: '/api/v1/leads/{id}',
    request: (args) => ({ params: { id: args.lead_id } }),
  }),
  routeTool({
    name: 'log_lead_interaction',
    lead: 'Record a call, email, meeting or note on a lead.',
    detail: 'occurred_at defaults to now; scheduled_at plans a follow-up.',
    input: z.object({
      lead_id: id('lead_id'),
      type: z.enum(['call', 'email', 'meeting', 'note', 'follow_up']).optional(),
      title: z.string().min(1).max(500),
      description: z.string().max(20_000).optional(),
      occurred_at: z.iso.datetime({ offset: true }).optional(),
      scheduled_at: z.iso.datetime({ offset: true }).nullable().optional(),
      completed: z.boolean().optional(),
    }).strict(),
    permission: 'leads.manage',
    method: 'POST',
    path: '/api/v1/leads/{id}/interactions',
    request: ({ lead_id, ...body }) => ({ params: { id: lead_id }, body }),
  }),
  routeTool({
    name: 'list_contacts',
    lead: 'List client contacts this key can see.',
    detail: 'Without contacts.read_all, only contacts linked to your projects.',
    input: z.object({
      search: z.string().min(1).max(200).optional(),
      sort: z.enum(['created_at', 'updated_at', 'name', 'email', 'company']).optional(),
      order, page, limit: limit(25),
    }).strict(),
    permission: 'contacts.read',
    method: 'GET',
    path: '/api/v1/contacts',
    request: (args) => ({ query: args }),
  }),
];
