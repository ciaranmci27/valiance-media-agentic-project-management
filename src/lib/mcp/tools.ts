import { z } from 'zod';
import {
  AGENT_EVENT_SCHEMAS, AGENT_EVENT_TYPES, AGENT_LABELS_MAX, agentLabelSchema, CUSTOM_EVENT_TYPE_PATTERN, isOpenEventType, isServerEvent, isTelemetryEvent, NOTE_EVENT_TYPE,
  openEventSchema, type AgentEventType,
} from '@/lib/agent-events';
import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { agentLimitsPatchSchema } from '@/lib/agent-limits';
import { WEBHOOK_EVENT_TYPES } from '@/lib/types';
import { planSchema } from '@/lib/communications/plan-schemas';
import { AGENT_MESSAGE_STATUSES, triageSchema } from '@/lib/communications/schemas';
import { MAIL_TOPICS, RULE_ACTIONS } from '@/lib/communications/sorting';
import { TEMPLATE_NAME_MAX, templateFieldSchema, templateTaskSchema } from '@/lib/task-templates';
import { PLANS_CUTOVER_REMOVAL } from '@/lib/api/version';
import { idempotencyKeyInput, routeTool, type PmTool } from './core';

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
 * Left out on purpose: credentials, outbound client email, invoices, rates, time
 * approval, team writes other than setting up an agent, every delete (move to Trash) but a
 * webhook endpoint's, the unscoped app activity feed, suggestion approve/decline, and the fleet
 * publisher's agent health (an agent reports its own with heartbeat).
 *
 * The inbox tools (list_inbox through get_inbox_signal) are the agent API at
 * /api/v1/inbox, its channel-neutral paths: what a triage agent may do with
 * a key and nothing more. Marking a thread handled or not a task, moving it
 * back to the Inbox, answering a decision card and asking for a draft are a
 * person's, in the app, so they have no tool. Meeting packages and the
 * shadow-plan compare report stay REST only.
 *
 * The agent setup tools (create_agent through import_agent_config) are for whoever sets
 * agents up, usually an Owner's own MCP client: their permissions (team.manage,
 * project_members.manage, api_keys.manage_all, webhooks.manage) keep them off an agent's list.
 */

export const GUIDE_TOOL = 'pm_guide';

/** The caller's own context pack, which pm_guide adds as `context` (server.ts). */
export const GUIDE_CONTEXT_PATH = '/api/v1/agents/me/context';

const id = (what: string) => z.uuid(`${what} must be a uuid`);
const page = z.number().int().min(1).optional().describe('Page number, from 1');
const limit = (fallback: number) =>
  z.number().int().min(1).max(100).default(fallback).describe(`Rows per page (1-100, default ${fallback})`);
const order = z.enum(['asc', 'desc']).optional().describe('Default desc');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const TASK_STATUS = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done']);
const PRIORITY = z.enum(['low', 'medium', 'high', 'urgent']);
const TASK_TYPE = z.enum(['engineering', 'research', 'audit', 'marketing', 'copywriting', 'operations', 'general']);
// null or human_only: a person does it. needs_spec: meant for an agent,
// spec not written yet. ai_ready: specced, the only value agents claim.
const AI_READINESS = z.enum(['ai_ready', 'needs_spec', 'human_only']);
const CONTEXT_CATEGORY = z.enum(['business_context', 'existing_work', 'technical_decision', 'constraint', 'lesson_learned']);
const BRIEF_SECTION = z.enum(['overview', 'rules', 'decisions', 'links', 'glossary', 'history']);
const AGENT_ROLE = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'A role is lowercase words joined by dashes, 40 characters at most');
const ASSIGNMENT_STATUS = z.enum(['active', 'paused']);
const EFFORT = z.enum(['small', 'medium', 'large']);
const API_SCOPE = z.enum(API_ENDPOINT_PERMISSIONS);
const WEBHOOK_EVENT = z.enum(WEBHOOK_EVENT_TYPES);
// generic, an install's profile or an Owner's own (list_agent_profiles); the route checks it exists.
const AGENT_PROFILE = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'A profile value is lowercase letters, numbers and dashes').describe('generic, or a value list_agent_profiles names');
const CONTEXT_SCOPE = z.enum(['workspace', 'group', 'project', 'agent', 'member']);
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
    parent_task_id: row.parent_task_id ?? null,
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

/**
 * One email, bounded like a task: a long email or a long thread must never
 * make it unreadable. html_text is left out wherever text has the words, the
 * email's own text is cut at `current`, and the thread shows its newest
 * messages by their own words (new_text; text only when there is none), each
 * cut at `thread`. Every cut is flagged; REST keeps the full answer.
 */
const EMAIL_LIMITS = { current: 8000, thread: 800, threadShown: 8, draft: 3000 };
/** Tighter in the triage context, which also carries every project in scope. */
const CONTEXT_EMAIL_LIMITS = { current: 4000, thread: 500, threadShown: 5, draft: 1500 };

function cutText(row: Record<string, unknown>, field: string, max: number): Record<string, unknown> {
  const value = row[field];
  return typeof value === 'string' && value.length > max ? { ...row, [field]: short(value, max), [`${field}_truncated`]: true } : row;
}

function boundedMessage(row: Record<string, unknown>, max: number, inThread: boolean): Record<string, unknown> {
  let out = { ...row };
  // Whitespace is not text, as the app reads a body (readableBody in email/prepare.ts).
  const filled = (field: string) => typeof row[field] === 'string' && (row[field] as string).trim().length > 0;
  if (filled('text') && row.html_text != null) out = { ...out, html_text: null, html_text_omitted: true };
  if (inThread && filled('new_text') && row.text != null) out = { ...out, text: null, text_omitted: true };
  for (const field of ['new_text', 'text', 'html_text']) out = cutText(out, field, max);
  return out;
}

function emailInFull(limits: typeof EMAIL_LIMITS) {
  return (data: unknown) => {
    if (!data || typeof data !== 'object') return data;
    const email = boundedMessage(data as Record<string, unknown>, limits.current, false);
    const thread = email.thread as Record<string, unknown> | null | undefined;
    if (!thread || typeof thread !== 'object') return email;
    const messages = Array.isArray(thread.messages) ? (thread.messages as Record<string, unknown>[]) : [];
    const drafts = Array.isArray(thread.reply_drafts) ? (thread.reply_drafts as Record<string, unknown>[]) : [];
    return {
      ...email,
      thread: {
        ...thread,
        messages: messages.slice(-limits.threadShown).map((message) => boundedMessage(message, limits.thread, true)),
        ...(messages.length > limits.threadShown ? { messages_note: `Newest ${limits.threadShown} of ${messages.length} messages.` } : {}),
        reply_drafts: drafts.map((draft) => cutText(draft, 'body', limits.draft)),
      },
    };
  };
}

/**
 * The triage context's projects, bounded: each keeps its newest open tasks,
 * their first open subtasks and its newest recent items, and then the whole
 * context shrinks until it fits CONTEXT_LIMITS.total, the same way the task
 * brief fits (task-brief.ts): recent items first, then subtasks, then open
 * tasks down to a few per project, then the email's thread, then the last
 * open tasks. Each cut is noted where it happened and named in cut_to_fit.
 */
const CONTEXT_LIMITS = { openTasks: 15, subtasks: 5, recent: 10, openTasksFloor: 3, total: 36_000 };

type Row = Record<string, unknown>;
const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

function triageContextInFull(data: unknown) {
  if (!data || typeof data !== 'object') return data;
  const context = { ...(data as Row), message: emailInFull(CONTEXT_EMAIL_LIMITS)((data as Row).message) } as Row;
  // What REST answered, for the notes: open tasks and recent items per project, open subtasks per task.
  const totals = new Map<object, number>();
  const projects = rowsOf(context.projects).map((project): Row => {
    const openTasks = rowsOf(project.open_tasks).map((task): Row => {
      const copy: Row = { ...task, subtasks: rowsOf(task.subtasks).slice(0, CONTEXT_LIMITS.subtasks) };
      totals.set(copy, rowsOf(task.subtasks).length);
      return copy;
    });
    const copy: Row = { ...project, open_tasks: openTasks.slice(0, CONTEXT_LIMITS.openTasks), recent: rowsOf(project.recent).slice(0, CONTEXT_LIMITS.recent) };
    totals.set(copy, openTasks.length);
    totals.set(copy.recent as Row[], rowsOf(project.recent).length);
    return copy;
  });
  context.projects = projects;

  const note = () => {
    for (const project of projects) {
      const tasks = project.open_tasks as Row[];
      const recent = project.recent as Row[];
      const openTotal = totals.get(project) ?? tasks.length;
      const recentTotal = totals.get(recent) ?? recent.length;
      if (tasks.length < openTotal) project.open_tasks_note = `Newest ${tasks.length} of ${openTotal} open tasks; search_tasks with project_id lists them all.`;
      if (recent.length < recentTotal) project.recent_note = `Newest ${recent.length} of ${recentTotal} recent items.`;
      for (const task of tasks) {
        const subtasks = task.subtasks as Row[];
        const subtaskTotal = totals.get(task) ?? subtasks.length;
        if (subtasks.length < subtaskTotal) task.subtasks_note = `First ${subtasks.length} of ${subtaskTotal} open subtasks.`;
      }
    }
  };
  note();
  const size = () => {
    note();
    return JSON.stringify(context).length;
  };
  if (size() <= CONTEXT_LIMITS.total) return context;

  const cutToFit: string[] = [];
  context.cut_to_fit = cutToFit;
  const shrink = (step: string, more: () => boolean) => {
    let cutHere = false;
    while (size() > CONTEXT_LIMITS.total && more()) cutHere = true;
    if (cutHere) cutToFit.push(step);
  };
  // Each pop takes from whichever holds the most, so projects shrink evenly.
  const popFromLargest = (lists: Row[][], floor = 0) => {
    const largest = lists.reduce<Row[] | null>((best, list) => (list.length > floor && (!best || list.length > best.length) ? list : best), null);
    return !!largest && largest.pop() !== undefined;
  };
  const allTasks = () => projects.flatMap((project) => project.open_tasks as Row[]);
  shrink('recent', () => popFromLargest(projects.map((project) => project.recent as Row[])));
  shrink('subtasks', () => popFromLargest(allTasks().map((task) => task.subtasks as Row[])));
  shrink('open_tasks', () => popFromLargest(projects.map((project) => project.open_tasks as Row[]), CONTEXT_LIMITS.openTasksFloor));
  const thread = ((context.message as Row | null)?.thread ?? null) as Row | null;
  shrink('thread', () => {
    const messages = rowsOf(thread?.messages);
    if (!thread || messages.length <= 1) return false;
    thread.messages = messages.slice(1);
    thread.messages_note = `Newest ${messages.length - 1} messages shown to fit; get_email has more.`;
    return true;
  });
  shrink('open_tasks', () => popFromLargest(projects.map((project) => project.open_tasks as Row[])));
  return context;
}

/** Typed events an agent may log; usage and turn telemetry come from the host publishers. */
const AGENT_EVENTS = AGENT_EVENT_TYPES.filter((type) => !isTelemetryEvent(type) && !isServerEvent(type)) as [AgentEventType, ...AgentEventType[]];

export const PM_TOOLS: PmTool[] = [
  {
    name: GUIDE_TOOL,
    lead: 'Read first: how the PM tools work and their limits.',
    detail: 'Covers ids, task flow, reviews, time, suggestions, events and errors, lists the tools this key can use, and gives your own setup as context: your rules in plain words, scopes, projects, conventions and webhooks.',
    input: z.object({}).strict(),
    permission: [],
    routes: [{ method: 'GET', path: GUIDE_CONTEXT_PATH }],
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
    detail: 'Active entries by default. Filter by category, section (the brief\'s), pinned or since (ISO time) to keep it small; up to 500 entries. To find entries about something, search_project_context.',
    input: z.object({
      project_id: id('project_id'),
      category: CONTEXT_CATEGORY.optional(),
      section: BRIEF_SECTION.optional(),
      pinned: z.boolean().optional().describe('true: only pinned entries (they go into every agent\'s context); false: only the rest'),
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
    name: 'search_project_context',
    lead: "Search a project's context notes by words.",
    detail: 'Full text over active entries, best match first: words, "a phrase", -word to leave out. Each entry has its brief section, pinned and rank. Pinned entries are already in get_task_brief; search finds the rest. limit 1 to 50 (default 20).',
    input: z.object({
      project_id: id('project_id'),
      q: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(50).optional(),
    }).strict(),
    permission: 'project_context.read',
    method: 'GET',
    path: '/api/v1/projects/{id}/context/search',
    request: ({ project_id, ...query }) => ({ params: { id: project_id }, query }),
  }),
  routeTool({
    name: 'add_project_context',
    lead: 'Add a context note to a project.',
    detail: 'Recorded as written by an agent. For existing_work with a file_path, the active note for that file is updated instead. section (the brief\'s) defaults to the one its category reads in; pinned puts it into every agent\'s context for the project, so pin only what every task needs.',
    input: z.object({
      project_id: id('project_id'),
      category: CONTEXT_CATEGORY,
      content: z.string().min(1).max(20_000),
      file_path: z.string().min(1).max(500).optional(),
      section: BRIEF_SECTION.optional(),
      pinned: z.boolean().optional(),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'project_context.manage',
    method: 'POST',
    path: '/api/v1/projects/{id}/context',
    request: ({ project_id, ...body }) => ({ params: { id: project_id }, body: { ...body, source: 'agent' } }),
  }),
  routeTool({
    name: 'search_context',
    lead: 'Search context at every level by words.',
    detail: 'Full text across every scope you read at once: company knowledge (workspace), your groups, the projects you reach, your own notes (agent) and, for a personal agent whose person allows it, their memory (member). Best match first: words, "a phrase", -word to leave out. Each entry has scope_type, scope_id, its section, pinned and rank. scope_types narrows it. Pinned entries are already in get_task_brief and pm_guide; search finds the rest. limit 1 to 50 (default 20).',
    input: z.object({
      q: z.string().min(1).max(500),
      scope_types: z.array(CONTEXT_SCOPE).min(1).max(5).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }).strict(),
    permission: [...API_ENDPOINT_PERMISSIONS],
    method: 'GET',
    path: '/api/v1/context/search',
    request: ({ scope_types, ...query }) => ({ query: { ...query, ...(scope_types ? { scope_types: scope_types.join(',') } : {}) } }),
  }),
  routeTool({
    name: 'add_context',
    lead: 'Add a context note at any level: your notes, a memory.',
    detail: "scope_type agent with your own id keeps a note for yourself; member with your person's id (works_for) saves something they want you to remember, only while they turned on Remember things for me; workspace, group or project follow their own rules (the workspace: an Owner; a project: project_context.manage). scope_id names the group, project, agent or person (leave it out for the workspace). section defaults to overview; pinned puts it into your context every time, so pin only what you always need. Recorded as written by an agent.",
    input: z.object({
      scope_type: CONTEXT_SCOPE,
      scope_id: id('scope_id').optional(),
      content: z.string().min(1).max(20_000),
      section: BRIEF_SECTION.optional(),
      pinned: z.boolean().optional(),
      idempotency_key: idempotencyKeyInput,
    }).strict().refine((value) => (value.scope_type === 'workspace') === !value.scope_id, 'Send scope_id for every scope but the workspace'),
    permission: [...API_ENDPOINT_PERMISSIONS],
    method: 'POST',
    path: '/api/v1/context',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'list_my_projects',
    lead: 'List your project assignments and what each asks.',
    detail: 'Each project you are assigned to as an agent: status (paused: start no new work there), template, settings and your instructions for that project. Newest first, paged.',
    input: z.object({
      status: ASSIGNMENT_STATUS.optional(),
      template: z.string().min(1).max(100).optional(),
      page, limit: limit(25),
    }).strict(),
    permission: [...API_ENDPOINT_PERMISSIONS],
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agents/me/projects',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'list_project_agents',
    lead: 'List the agents on a project and their settings.',
    detail: "Each agent's status, template, settings, instructions and the template's settings form. An agent's key sees only its own assignment. Filters: status, template.",
    input: z.object({
      project_id: id('project_id'),
      status: ASSIGNMENT_STATUS.optional(),
      template: z.string().min(1).max(100).optional(),
      page, limit: limit(25),
    }).strict(),
    permission: 'projects.read',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/projects/{id}/agents',
    request: ({ project_id, ...query }) => ({ params: { id: project_id }, query }),
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
      parent_task_id: id('parent_task_id').optional().describe("Only this task's subtasks"),
      top_level: z.boolean().optional().describe('Only top-level tasks, no subtasks'),
      sort: z.enum(['created_at', 'updated_at', 'title', 'status', 'priority', 'due_date']).optional(),
      order, page, limit: limit(20),
    }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/tasks',
    request: ({ top_level, ...args }) => ({ query: { ...args, ...(top_level ? { top_level: 'true' } : {}) } }),
    present: mapRows(taskSummary),
  }),
  routeTool({
    name: 'get_task',
    lead: 'Get one task in full, with its latest review.',
    detail: `Includes its parent (for a subtask), its subtasks (each a task with status and assignees), acceptance criteria, blockers, dependencies_met (false unless every blocker is done), latest_run (the newest agent run on it: status, agent and times; null while AI agents is off) and the newest ${TASK_COMMENTS_SHOWN} comments; list_task_comments has older ones. Very long text is cut and flagged.`,
    input: z.object({ task_id: id('task_id') }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/tasks/{id}',
    request: (args) => ({ params: { id: args.task_id } }),
    present: taskInFull,
  }),
  routeTool({
    name: 'get_task_brief',
    lead: 'Get everything you need to start work on a task.',
    detail:
      'One call before you start: the task (acceptance criteria, subtasks, blockers and dependencies_met), its project and the project\'s active context entries, the newest 10 comments, its files and links, the open question if it is waiting on someone, who holds the claim, the latest agent run on it, and your own rules (self_assign, close_policy, create_policy, escalate_to). Long text is cut and flagged; parts your key cannot read are listed in omitted.',
    input: z.object({ task_id: id('task_id') }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/tasks/{id}/brief',
    request: (args) => ({ params: { id: args.task_id } }),
  }),
  routeTool({
    name: 'next_task',
    lead: 'Get the best task for you to work on next.',
    detail:
      'Tasks assigned to you first, then unassigned work you may pick up (agents: AI Ready work, if your rules allow). Leaves out backlog, in review, done, blocked tasks, inactive projects and tasks someone else has claimed. Highest priority first, then soonest due, then oldest. Answers with the task (pickup says assigned or unassigned) or null. It does not claim it: call claim_task next.',
    input: z.object({ project_id: id('project_id').optional() }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/tasks/next',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'claim_task',
    lead: 'Claim a task so no one else works on it.',
    detail:
      'A work lease for lease_minutes (default 30, 1 to 240): extend_claim renews it while you work, release_task ends it, and setting the task to done ends it too. You can claim a task assigned to you, or an unassigned one you may pick up, which assigns it to you; if that claim runs out, another member may claim the task and the assignment moves to them. Claiming one you hold renews it. If someone else holds it the answer is 409 with who and until when: pick another task.',
    input: z.object({
      task_id: id('task_id'),
      lease_minutes: z.number().int().min(1).max(240).optional(),
    }).strict(),
    permission: 'tasks.manage_assigned',
    method: 'POST',
    path: '/api/v1/tasks/{id}/claim',
    idempotent: true,
    request: ({ task_id, ...body }) => ({ params: { id: task_id }, body }),
  }),
  routeTool({
    name: 'extend_claim',
    lead: 'Renew your claim on a task while you work on it.',
    detail: 'Sets it to run out lease_minutes from now (default 30, 1 to 240). Call it well before the claim runs out on long work. 409 when you no longer hold it: claim it again.',
    input: z.object({
      task_id: id('task_id'),
      lease_minutes: z.number().int().min(1).max(240).optional(),
    }).strict(),
    permission: 'tasks.manage_assigned',
    method: 'POST',
    path: '/api/v1/tasks/{id}/claim/extend',
    idempotent: true,
    request: ({ task_id, ...body }) => ({ params: { id: task_id }, body }),
  }),
  routeTool({
    name: 'release_task',
    lead: 'Release your claim on a task without finishing it.',
    detail: "For when you stop or hand it back. If claiming had assigned the task to you, you are unassigned again (unassigned: true); work a person assigned to you stays assigned. released is false when nobody held a live claim. With tasks.manage_all you can release anyone's stuck claim.",
    input: z.object({ task_id: id('task_id') }).strict(),
    permission: 'tasks.manage_assigned',
    method: 'DELETE',
    path: '/api/v1/tasks/{id}/claim',
    destructive: false,
    request: ({ task_id }) => ({ params: { id: task_id } }),
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
    name: 'list_task_files',
    lead: "List a task's files and attachments.",
    detail: "Uploads, linked email attachments (source.type email, with its subject when you can open its inbox), linked project files and web links (kind link, the address in url), oldest first. Open a file with get_task_file_link; a link's url is the address itself.",
    input: z.object({ task_id: id('task_id') }).strict(),
    permission: 'files.read',
    method: 'GET',
    path: '/api/v1/tasks/{id}/files',
    request: ({ task_id }) => ({ params: { id: task_id } }),
  }),
  routeTool({
    name: 'get_task_file_link',
    lead: 'Get a short-lived link to open one task file.',
    detail: 'A one-minute download link, or with inline true a five-minute link for images, PDFs and text. A linked email attachment opens only if its inbox lets agents read that kind.',
    input: z.object({ task_id: id('task_id'), file_id: id('file_id'), inline: z.boolean().optional() }).strict(),
    permission: 'files.read',
    method: 'GET',
    path: '/api/v1/tasks/{id}/files/{fileId}/url',
    request: ({ task_id, file_id, inline }) => ({ params: { id: task_id, fileId: file_id }, query: inline ? { inline: 'true' } : {} }),
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
    lead: 'Create a task in a project, or a subtask under a task.',
    detail: "Without tasks.manage_all the task is assigned to you and no one else. Blockers and the goal must be in the same project. With parent_task_id it is a subtask, a full task in the parent's project (leave out project_id); subtasks go one level deep, under a task you may manage. dedupe_key names an incident: while an open task in the project holds it, you get that task back with deduplicated: true and its occurrences counted (occurrence_note is added as a comment) instead of a second task; once it is done, the same key makes a new task. If your rules need approval for new tasks, you get a task suggestion with needs_approval: true instead; if they send finished work to review, a done task is created In Review (sent_to_review: true).",
    input: z.object({
      project_id: id('project_id').optional(),
      parent_task_id: id('parent_task_id').optional(),
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
      dedupe_key: z.string().min(1).max(200).optional().describe('Incident key, such as "checkout-500:/api/cart". One open task per key in a project'),
      occurrence_note: z.string().min(1).max(20_000).optional().describe('What happened this time; added as a comment when the key already has an open task'),
      idempotency_key: idempotencyKeyInput,
    }).strict().refine((value) => value.project_id || value.parent_task_id, 'Send project_id, or parent_task_id for a subtask'),
    permission: 'tasks.create',
    method: 'POST',
    path: '/api/v1/tasks',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_task',
    lead: "Change a task's fields, status or blockers.",
    detail:
      'Send only what changes. acceptance_criteria REPLACES every criterion and clears their satisfied flags; use add_acceptance_criterion or update_acceptance_criterion for one. Changing assignees needs tasks.manage_all. project_id moves it: you must be able to change it and to create tasks in the new project; its subtasks, comments, files and reminders go with it and its goal is cleared. Anyone on it who cannot open the new project refuses the move by name: send lost_access unassign to take them off, or add_to_project to add them (needs project_members.manage). If your rules send finished work to review, status done moves it to in_review instead (sent_to_review: true). Answers with the bare task row.',
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
      lost_access: z.enum(['refuse', 'unassign', 'add_to_project']).optional(),
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
    input: z.object({ task_id: id('task_id'), text: z.string().min(1).max(20_000), idempotency_key: idempotencyKeyInput }).strict(),
    permission: 'tasks.read',
    method: 'POST',
    path: '/api/v1/tasks/{id}/comments',
    // The route requires user_id but always uses the key's member.
    request: ({ task_id, text }, context) => ({ params: { id: task_id }, body: { user_id: context.memberId, text } }),
  }),
  routeTool({
    name: 'add_task_file',
    lead: 'Attach a file or a link to a task.',
    detail:
      "Exactly one of: email_attachment_id (links the email's own file, no copy), entity_file_id (a file on the task's project), content_base64 with name (the bytes, 3 MB at most), or url (a web address: a Loom, a design, a shared doc). Adding one the task already has returns that entry. note says why it is there.",
    input: z.object({
      task_id: id('task_id'),
      email_attachment_id: id('email_attachment_id').optional(),
      entity_file_id: id('entity_file_id').optional(),
      content_base64: z.string().min(1).max(4_194_304).optional(),
      url: z.string().min(1).max(8192).optional(),
      name: z.string().min(1).max(255).optional(),
      mime_type: z.string().max(255).optional(),
      note: z.string().min(1).max(500).optional(),
      idempotency_key: idempotencyKeyInput,
    }).strict().refine(
      (value) => [value.email_attachment_id, value.entity_file_id, value.content_base64, value.url].filter((source) => source !== undefined).length === 1,
      'Send exactly one of email_attachment_id, entity_file_id, content_base64 or url',
    ).refine((value) => value.content_base64 === undefined || value.name !== undefined, 'content_base64 needs a name'),
    permission: 'files.upload',
    method: 'POST',
    path: '/api/v1/tasks/{id}/files',
    request: ({ task_id, ...body }) => ({ params: { id: task_id }, body }),
  }),
  routeTool({
    name: 'set_task_parent',
    lead: 'Move a task under another task, or back to top level.',
    detail: "When a task turns out to belong under a bigger one, move it with this instead of recreating it: it keeps its comments, files, assignees and history. parent_task_id null makes it top-level. One level deep: the parent cannot be a subtask, and a task with subtasks cannot become one. Under a task in another project it moves there (needs tasks.manage_all, and no blocker links).",
    input: z.object({ task_id: id('task_id'), parent_task_id: id('parent_task_id').nullable() }).strict(),
    permission: 'tasks.manage_assigned',
    method: 'PATCH',
    path: '/api/v1/tasks/{id}',
    request: ({ task_id, parent_task_id }) => ({ params: { id: task_id }, body: { parent_task_id } }),
  }),
  routeTool({
    name: 'add_subtask',
    lead: 'Add a subtask to a task by title.',
    detail: 'A quick subtask: a task under it with only a title, at the end of its list. To set an assignee, due date or description, use create_task with parent_task_id.',
    input: z.object({ task_id: id('task_id'), title: z.string().min(1).max(500), idempotency_key: idempotencyKeyInput }).strict(),
    permission: 'tasks.manage_assigned',
    method: 'POST',
    path: '/api/v1/tasks/{id}/subtasks',
    request: ({ task_id, title }) => ({ params: { id: task_id }, body: { title } }),
  }),
  routeTool({
    name: 'update_subtask',
    lead: 'Rename a subtask or mark it done or not done.',
    detail: 'The subtask must belong to the task. A subtask is a task: update_task changes anything else on it.',
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
    input: z.object({ task_id: id('task_id'), criterion: z.string().min(1).max(2000), idempotency_key: idempotencyKeyInput }).strict(),
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
  // Task templates: one task or a playbook, used again and again.
  routeTool({
    name: 'list_task_templates',
    lead: 'List task templates and playbooks you can use.',
    detail: 'By name, paged, without their tasks (get_task_template has them). project_id lists only those usable in that project: unlocked ones and the ones locked to it. Each with fields (the fill-ins run_task_template asks for), item_count, task_count, project_id (locked to it, or null), run_count and last_run_at.',
    input: z.object({
      search: z.string().min(1).max(200).optional(),
      project_id: id('project_id').optional(),
      page,
      limit: limit(50),
    }).strict(),
    permission: ['tasks.create', 'templates.manage'],
    method: 'GET',
    path: '/api/v1/task-templates',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'get_task_template',
    lead: 'Read one task template with its tasks.',
    detail: 'items are its tasks in order, each with title, description, priority, tags, assignee ("runner" for whoever uses it, a member id, or null), due_in_days (after the start date) and subtasks. {key} in a title or description is a fill-in from fields.',
    input: z.object({ template_id: id('template_id') }).strict(),
    permission: ['tasks.create', 'templates.manage'],
    method: 'GET',
    path: '/api/v1/task-templates/{id}',
    request: ({ template_id }) => ({ params: { id: template_id } }),
  }),
  routeTool({
    name: 'run_task_template',
    lead: 'Use a task template: create all its tasks at once.',
    detail: 'Creates every task and subtask in the project, fill-ins replaced by values (one per field, by key) and due dates counted from start_date (YYYY-MM-DD, default today). Leave out project_id for a template locked to a project; another project is 422 locked_to_project. Needs tasks.create on the project. Answers { run, tasks, notes }: notes say who was left unassigned because they cannot open the project.',
    input: z.object({
      template_id: id('template_id'),
      project_id: id('project_id').optional(),
      start_date: date.optional(),
      values: z.record(z.string(), z.string().max(200)).optional().describe('A value for every fill-in field, by key: { "product": "Aurora" }'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'tasks.create',
    method: 'POST',
    path: '/api/v1/task-templates/{id}/run',
    request: ({ template_id, ...body }) => ({ params: { id: template_id }, body }),
    present: (data) => {
      const result = (data ?? {}) as { run?: unknown; tasks?: Record<string, unknown>[]; notes?: string[] };
      return {
        run: result.run,
        tasks: (result.tasks ?? []).map((task) => ({
          id: task.id, title: task.title, parent_task_id: task.parent_task_id ?? null, due_date: task.due_date ?? null, assignee_ids: task.assignee_ids ?? [],
        })),
        notes: result.notes ?? [],
      };
    },
  }),
  routeTool({
    name: 'create_task_template',
    lead: 'Create a task template or playbook for everyone.',
    detail: 'Needs templates.manage. items are the tasks in order (1 to 50), each with optional subtasks (one level). assignee is "runner" (whoever uses it), a member id, or null; due_in_days counts from the start date picked when it is used. Every {key} used in a title or description needs a field { key, label }. project_id locks it to that project.',
    input: z.object({
      name: z.string().min(1).max(TEMPLATE_NAME_MAX),
      description: z.string().max(2000).optional(),
      project_id: id('project_id').nullable().optional(),
      fields: z.array(templateFieldSchema).max(10).optional(),
      items: z.array(templateTaskSchema).min(1).max(50),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'templates.manage',
    method: 'POST',
    path: '/api/v1/task-templates',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_task_template',
    lead: 'Change a task template: its name, fields or tasks.',
    detail: 'Needs templates.manage. Send only what changes; fields and items are replaced whole, so send both when the fill-ins change. Its version goes up when what it makes changes. Runs already made keep the version they used.',
    input: z.object({
      template_id: id('template_id'),
      name: z.string().min(1).max(TEMPLATE_NAME_MAX).optional(),
      description: z.string().max(2000).optional(),
      project_id: id('project_id').nullable().optional(),
      fields: z.array(templateFieldSchema).max(10).optional(),
      items: z.array(templateTaskSchema).min(1).max(50).optional(),
    }).strict().refine(atLeastOne(['name', 'description', 'project_id', 'fields', 'items']), 'Send at least one field to change'),
    permission: 'templates.manage',
    method: 'PATCH',
    path: '/api/v1/task-templates/{id}',
    request: ({ template_id, ...body }) => ({ params: { id: template_id }, body }),
  }),
  {
    name: 'submit_task_review',
    lead: "Record a review verdict on a task's work.",
    detail:
      'Needs tasks.manage_all; assignees cannot review their own work. For a pull request send pr_url and head_sha together: one verdict per commit, so if this commit was already reviewed, the first verdict stands and is returned with already_reviewed. For other work (a document, a data fix, a design) send neither: a verdict and your notes in summary, each one a new round.',
    input: z.object({
      task_id: id('task_id'),
      verdict: z.enum(['approved', 'changes_requested']),
      summary: z.string().min(1).max(20_000),
      pr_url: z.url().optional(),
      head_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'head_sha must be the full 40-character commit SHA').optional(),
    }).strict().refine((args) => (args.pr_url === undefined) === (args.head_sha === undefined), {
      message: 'Send pr_url and head_sha together for a pull request, or neither for other work',
      path: ['head_sha'],
    }),
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
      idempotency_key: idempotencyKeyInput,
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
      "Goes to the workspace owner. About one inbox (name inbox_id, message_id or conversation_id, one you read), it goes to that inbox's decision recipient when it has one, else the owner. Pass the entity_id of what it is about to avoid duplicate unread notifications for the same thing. For a question you need answered, use ask_human instead: the answer comes back to you.",
    input: z.object({
      title: z.string().min(1).max(200),
      message: z.string().min(1).max(5000),
      link: z.string().min(1).max(2000).nullable().optional(),
      entity_type: z.enum(['task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question']).optional(),
      entity_id: id('entity_id').nullable().optional(),
      inbox_id: id('inbox_id').optional().describe('The inbox it is about'),
      message_id: id('message_id').optional().describe('The email it is about (its inbox decides who gets it)'),
      conversation_id: id('conversation_id').optional().describe('The conversation it is about (its inbox decides who gets it)'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'notifications.send',
    // The agent-to-owner channel: the route answers only with AI agents on.
    module: 'agents',
    method: 'POST',
    path: '/api/v1/notifications',
    request: (body) => ({ body: { ...body, audience: 'owner' } }),
  }),
  // Questions: ask a person (or another agent) and get the answer back.
  routeTool({
    name: 'ask_human',
    lead: 'Ask a person a question and wait for the answer.',
    detail:
      "For when you are stuck on something only a person can decide: never guess. Put it on the task (task_id) or project (project_id) it is about, or neither (with questions.ask and no tasks.read, only neither). asked_to defaults to whoever your rules escalate to, else the Owner; asked_to_group asks a group instead (any member answers; list_groups has the ids). choices (1 to 10 short strings) become buttons; allow_other (default true) also lets them answer in their own words. expires_at (ISO time) closes it unanswered after that. run_id names your own unfinished run this question holds: the run waits on a person (status waiting, never timed out) until the question is answered, cancelled or expires, then runs again. Their bell rings and a task with an open question reads as waiting on them. Answers with the question (status open): poll get_question until status is answered, then act on answer_choice and answer_text.",
    input: z.object({
      question: z.string().min(1).max(2000).describe('The question, with the context the person needs to answer it'),
      task_id: id('task_id').optional(),
      project_id: id('project_id').optional(),
      asked_to: id('asked_to').optional().describe('Team member to ask; default your escalation target or the Owner'),
      asked_to_group: id('asked_to_group').optional().describe('A group to ask instead of one member: any member answers'),
      choices: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
      allow_other: z.boolean().optional(),
      expires_at: z.string().min(1).max(40).optional().describe('ISO 8601 time after which the question closes as expired'),
      run_id: id('run_id').optional().describe('Your own unfinished run this question holds: it waits on a person while the question is open'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: ['tasks.read', 'questions.ask'],
    method: 'POST',
    path: '/api/v1/questions',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'get_question',
    lead: 'Read one question and its answer, if there is one.',
    detail: 'status is open, answered, cancelled or expired (an open question past expires_at reads as expired). Once answered: answer_choice, answer_text, answered_by_name, answered_at. Poll it after ask_human, a few minutes apart.',
    input: z.object({ question_id: id('question_id') }).strict(),
    permission: ['tasks.read', 'questions.ask'],
    method: 'GET',
    path: '/api/v1/questions/{id}',
    request: ({ question_id }) => ({ params: { id: question_id } }),
  }),
  routeTool({
    name: 'list_questions',
    lead: 'List questions you asked, were asked, or can see.',
    detail: 'Newest first. status open, answered, cancelled, expired or all (default all); asked_by me and asked_to me for your own (asked_to me takes in your groups); asked_to_group for questions asked to one group; task_id or project_id for one place; kind question or approval for only one kind (both by default). Questions asked to you with can_answer true are yours to answer with answer_question.',
    input: z.object({
      status: z.enum(['open', 'answered', 'cancelled', 'expired', 'all']).optional(),
      asked_by: z.union([z.literal('me'), id('asked_by')]).optional(),
      asked_to: z.union([z.literal('me'), id('asked_to')]).optional(),
      asked_to_group: id('asked_to_group').optional(),
      task_id: id('task_id').optional(),
      project_id: id('project_id').optional(),
      kind: z.enum(['question', 'approval']).optional(),
      page,
      limit: limit(20),
    }).strict(),
    permission: ['tasks.read', 'questions.ask'],
    method: 'GET',
    path: '/api/v1/questions',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'answer_question',
    lead: 'Answer a question you were asked.',
    detail: 'Send choice (one of its choices), text, or both. Without choices, text is the answer; with choices and allow_other false, a choice is required. Only the member asked (any member, for a question asked to a group), the Owner, or a member who may manage the team can answer. An approval (kind approval) takes choice approve or reject, with text as an optional note, and only whoever it names (or the Owner) decides it: an approval asked to you as an agent, with your own key; one that names a person, only with approvals.decide on the key (acting for the person, held by them too), never from a connected AI tool (403 approval_needs_person: the person decides it in the app). can_answer says whether you may. 409 when it is already answered, cancelled or expired.',
    input: z.object({
      question_id: id('question_id'),
      choice: z.string().min(1).max(200).optional(),
      text: z.string().min(1).max(5000).optional(),
    }).strict().refine(atLeastOne(['choice', 'text']), 'Send choice, text, or both'),
    permission: 'tasks.read',
    method: 'POST',
    path: '/api/v1/questions/{id}/answer',
    request: ({ question_id, ...body }) => ({ params: { id: question_id }, body }),
  }),
  routeTool({
    name: 'cancel_question',
    lead: 'Withdraw a question you asked that is still open.',
    detail: 'For when you found the answer yourself or no longer need it. Clears the asked member\'s bell. Only whoever asked, the Owner, or a member who may manage the team. 409 once it is answered, cancelled or expired.',
    input: z.object({ question_id: id('question_id') }).strict(),
    permission: ['tasks.read', 'questions.ask'],
    method: 'POST',
    path: '/api/v1/questions/{id}/cancel',
    destructive: true,
    idempotent: false,
    request: ({ question_id }) => ({ params: { id: question_id } }),
  }),
  // Approvals: ask a person to approve an action before you do it.
  routeTool({
    name: 'request_approval',
    lead: 'Ask a person to approve an action before you do it.',
    detail:
      "For an action a person must allow first: a deploy, an email to a client, spending money, deleting data, a merge. action.type names it in your words (deploy, send_email, spend, delete_data, merge, ...), action.summary says exactly what will happen in one line, action.details (optional JSON) carries the rest, and question adds context. action.external_url (https) and action.external_id name the object in another system you work in: the person sees Open in its host. On a task (task_id), a project (project_id) or neither (with questions.ask and no tasks.read, only neither). asked_to defaults to your escalation target, else the Owner, and must be a person unless you name an agent in asked_to (a reviewer agent, which decides with its own key; never yourself); asked_to_group asks a group (any person in it decides). expires_at (ISO time) closes it unanswered. run_id names your own unfinished run it holds: the run waits on a person until it is decided, cancelled or expires. Answers with the approval (status open, decision null): poll get_approval until decision is approved or rejected, and act only on approved. Expired or cancelled means no. For new work to propose, use create_task_suggestion instead.",
    input: z.object({
      action: z.object({
        type: z.string().min(1).max(63).describe('The kind of action, lowercase: deploy, send_email, spend, delete_data, merge, or your own'),
        summary: z.string().min(1).max(300).describe('Exactly what will happen, in one line a person can approve'),
        details: z.record(z.string(), z.unknown()).optional().describe('Anything else as JSON: an amount, a recipient, a link'),
        external_url: z.string().min(1).max(2000).optional().describe('https link to the object in your own system (a bill, a payment): the person opens it from the request'),
        external_id: z.string().min(1).max(200).optional().describe('The id of the object in your own system'),
      }).strict(),
      question: z.string().min(1).max(2000).optional().describe('Context for the person deciding; the summary when left out'),
      task_id: id('task_id').optional(),
      project_id: id('project_id').optional(),
      asked_to: id('asked_to').optional().describe('The person (or reviewer agent) to ask; default your escalation target or the Owner'),
      asked_to_group: id('asked_to_group').optional().describe('A group to ask instead: any person in it decides'),
      expires_at: z.string().min(1).max(40).optional().describe('ISO 8601 time after which it closes as expired'),
      run_id: id('run_id').optional().describe('Your own unfinished run this approval holds: it waits on a person while the approval is open'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: ['tasks.read', 'questions.ask'],
    method: 'POST',
    path: '/api/v1/approvals',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'get_approval',
    lead: 'Read one approval and its decision, if there is one.',
    detail: 'decision is approved, rejected or null; decided_by_name and answer_text (the note) come with it. status open, answered, cancelled or expired: only decision approved lets you act. Poll it after request_approval, a few minutes apart.',
    input: z.object({ approval_id: id('approval_id') }).strict(),
    permission: ['tasks.read', 'questions.ask'],
    method: 'GET',
    path: '/api/v1/approvals/{id}',
    request: ({ approval_id }) => ({ params: { id: approval_id } }),
  }),
  // Reminders: next steps on a task, follow-ups on a project, or standalone
  routeTool({
    name: 'list_reminders',
    lead: 'List reminders: open ones first, by when they are due.',
    detail:
      'Yours, ones you wrote, and shared ones on projects you can open. status open (default), done or all; owner me to skip ones for others; due_by YYYY-MM-DD for what is due by then. A task\'s open reminders are its next steps.',
    input: z.object({
      status: z.enum(['open', 'done', 'all']).optional(),
      owner: z.enum(['me', 'anyone']).optional(),
      task_id: id('task_id').optional(),
      project_id: id('project_id').optional(),
      due_by: date.optional(),
      page, limit: limit(25),
    }).strict(),
    permission: 'reminders.manage_own',
    method: 'GET',
    path: '/api/v1/reminders',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'add_reminder',
    lead: 'Add a reminder: a next step, follow-up or date to keep.',
    detail:
      'Hang it on a task (its next step: what the task is waiting on), a project, or nothing. remind_on (YYYY-MM-DD) and remind_at (HH:MM, needs a date) are optional; a dated one rings its owner at the time, or 8 am. owner_id gives it to a person (yours otherwise). Check list_reminders first: never add one twice.',
    input: z.object({
      title: z.string().min(1).max(500),
      notes: z.string().max(5000).optional(),
      task_id: id('task_id').optional(),
      project_id: id('project_id').optional(),
      remind_on: date.nullable().optional(),
      remind_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)').nullable().optional(),
      owner_id: id('owner_id').optional(),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'reminders.manage_own',
    method: 'POST',
    path: '/api/v1/reminders',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_reminder',
    lead: 'Tick off, reopen or change a reminder.',
    detail:
      'status done ticks it off (open reopens it). Change title, notes, remind_on or remind_at; remind_on null removes the date and its time. A task moved to done closes its reminders on its own.',
    input: z.object({
      reminder_id: id('reminder_id'),
      title: z.string().min(1).max(500).optional(),
      notes: z.string().max(5000).optional(),
      remind_on: date.nullable().optional(),
      remind_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)').nullable().optional(),
      status: z.enum(['open', 'done']).optional(),
    }).strict().refine(atLeastOne(['title', 'notes', 'remind_on', 'remind_at', 'status']), 'Send at least one field to change'),
    permission: 'reminders.manage_own',
    method: 'PATCH',
    path: '/api/v1/reminders/{id}',
    request: ({ reminder_id, ...body }) => ({ params: { id: reminder_id }, body }),
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
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agent-activities',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'log_activity',
    lead: 'Log a typed agent event to the activity feed.',
    detail:
      "Agents only. The feed line is written by the server from the payload. Payloads: work.claimed/work.done {task_id?, task_title}; work.milestone {task_id?, kind: subtask|criterion|comment|commit|session|note, detail}; work.handoff {task_title, pr_url?, round?}; pr.merged {pr_url, additions, deletions}; review.started {task_title, round}; review.verdict {verdict, round, pr_url?, findings?}; audit.finding {subject, findings, note?}; audit.no_work {reason}; spec.completed {subject}; queue.empty {queue: review|work|spec|audit}; blocked {task_id?, reason}; billing.started|paused|resumed|stopped {task_id?}. For anything else: note {title, task_id?, detail?}, or your own custom.<namespace>.<name> {title, task_id?, ...your fields}; title (plain text, at most 200 characters) is the feed line. They never change your status or the analytics. labels (optional, up to 20, such as client:acme or deploy) group the event in analytics and travel with it to the company's data system.",
    input: z.object({
      activity_type: z.union([
        z.enum(AGENT_EVENTS),
        z.literal(NOTE_EVENT_TYPE),
        z.string().regex(CUSTOM_EVENT_TYPE_PATTERN, 'activity_type must be a typed event, note, or custom.<namespace>.<name>'),
      ]),
      payload: z.record(z.string(), z.unknown()),
      project_id: id('project_id').nullable().optional(),
      labels: z.array(agentLabelSchema).max(AGENT_LABELS_MAX).optional().describe('Up to 20 labels for grouping and export: lowercase letters, numbers and . _ : -, such as client:acme or deploy'),
    }).strict().superRefine((args, ctx) => {
      const type = args.activity_type as string;
      // A type outside the vocabulary is already refused above.
      const schema = isOpenEventType(type) ? openEventSchema(type) : AGENT_EVENT_SCHEMAS[type as AgentEventType];
      if (!schema) return;
      const parsed = schema.safeParse(args.payload);
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
  routeTool({
    name: 'get_my_status',
    lead: 'Check whether you may start work now: pause and budget.',
    detail:
      "Call it before each turn. can_start_work false means skip the turn: skip_reason says why (agents_paused: an Owner paused every agent; agent_paused: you are paused; budget_exceeded: your budget for this period is spent). Also answers paused, paused_reason, paused_at, budget { period, period_start, resets_at, spent_usd, spent_tokens, budget_usd, budget_tokens, exceeded } (spend counted as the budget counts it) and limits. Pause and budget only refuse calls into this app, so an agent working in another system needs this to stop there too. If the call fails on the network, go ahead. Any key reads it, paused or not.",
    input: z.object({}).strict(),
    permission: [...API_ENDPOINT_PERMISSIONS],
    method: 'GET',
    path: '/api/v1/agents/me/status',
    request: () => ({}),
  }),
  routeTool({
    name: 'heartbeat',
    lead: 'Tell the app you are up, and whether you are working.',
    detail:
      "Agents only. Call it at least every expected_interval_seconds (default 60, 30 to 86400; it is remembered once set), and when a turn starts and ends with working true or false. Status views show you offline after two missed beats plus a minute, so an agent that runs hourly sets 3600. status_note is a line on what you are doing (each beat replaces it). turn_started_at defaults to when the turn's first beat said working. If a fleet publisher already reports you, its facts stand and a beat only writes status_note; it does not count as a beat (publisher_reports: true). Answers with stale_after_seconds.",
    input: z.object({
      working: z.boolean().optional().describe('A turn is running right now. Left out: not working'),
      turn_started_at: z.iso.datetime({ offset: true }).optional().describe('When the running turn began'),
      expected_interval_seconds: z.number().int().min(30).max(86_400).optional(),
      status_note: z.string().min(1).max(280).optional(),
    }).strict(),
    permission: ['agent_activity.write', 'tasks.read'],
    agentsOnly: true,
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agents/heartbeat',
    destructive: false,
    idempotent: true,
    request: (body) => ({ body }),
  }),
  // Runs: one run of an agent, from start to finish, with its trace link.
  routeTool({
    name: 'start_run',
    lead: 'Start a run: record that you began a piece of work.',
    detail:
      "Call it when you begin work (on a task: task_id), and finish_run when you are done. external_id is your harness's own run id: starting again with it answers with the same run (created false), so a retry never makes two. external_url is your trace link (a LangSmith, Langfuse or session URL). trigger says what started you: assigned, scheduled, webhook, chat or manual. plan lists your steps ({ title, status: pending|running|done|skipped|failed }). Answers with the run; keep its id for update_run, finish_run and the run_id of your turn records.",
    input: z.object({
      task_id: id('task_id').optional(),
      project_id: id('project_id').optional(),
      title: z.string().min(1).max(300).optional().describe('What this run is doing, in a line'),
      trigger: z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/).optional().describe('assigned, scheduled, webhook, chat, manual, or your own lower-case word'),
      external_id: z.string().min(1).max(300).optional().describe("Your harness's own run id"),
      external_url: z.url().max(2000).optional().describe('Your trace link'),
      model: z.string().min(1).max(200).optional(),
      provider: z.string().min(1).max(100).optional().describe('The provider the run uses: anthropic, openai, google, ...'),
      plan: z.array(z.object({ title: z.string().min(1).max(200), status: z.enum(['pending', 'running', 'done', 'skipped', 'failed']).optional() }).strict()).max(50).optional(),
      note: z.string().min(1).max(500).optional().describe('A first progress note'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Anything else, up to 8000 characters as JSON'),
      parent_run_id: id('parent_run_id').optional().describe("The run that handed you this work (get_task_brief's delegated_from.run_id); it acts for the same person"),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: ['agent_activity.write', 'tasks.read', 'agents.manage'],
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agents/runs',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_run',
    lead: 'Update a run: its plan, a progress note, tokens so far.',
    detail:
      'plan replaces the plan; note adds a progress note (the newest 50 are kept); tokens_in, tokens_out and cost_usd (US dollars) are totals so far, not increments, so a retry is safe. Also title, summary, model, task_id, external_url, metadata. Send one at least every two hours on long work: a run with no update for two hours reads as timed_out. status waiting says you wait on a person (ask_human or request_approval with run_id does it for you): a waiting run never times out while a question naming it is open, and after seven days with none. Any update without status waiting brings it back to running. Only your own runs.',
    input: z.object({
      run_id: id('run_id'),
      title: z.string().min(1).max(300).optional(),
      summary: z.string().min(1).max(4000).optional(),
      plan: z.array(z.object({ title: z.string().min(1).max(200), status: z.enum(['pending', 'running', 'done', 'skipped', 'failed']).optional() }).strict()).max(50).optional(),
      note: z.string().min(1).max(500).optional(),
      tokens_in: z.number().int().min(0).optional(),
      tokens_out: z.number().int().min(0).optional(),
      cost_usd: z.number().min(0).optional(),
      model: z.string().min(1).max(200).optional(),
      provider: z.string().min(1).max(100).optional(),
      task_id: id('task_id').nullable().optional(),
      external_url: z.url().max(2000).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      status: z.enum(['running', 'waiting']).optional().describe('waiting: you wait on a person; running: back at work. Finish with finish_run'),
    }).strict().refine(atLeastOne(['title', 'summary', 'plan', 'note', 'tokens_in', 'tokens_out', 'cost_usd', 'model', 'provider', 'task_id', 'external_url', 'metadata', 'status']), 'Send at least one field to change'),
    permission: ['agent_activity.write', 'tasks.read', 'agents.manage'],
    module: 'agents',
    method: 'PATCH',
    path: '/api/v1/agents/runs/{id}',
    destructive: false,
    request: ({ run_id, ...body }) => ({ params: { id: run_id }, body }),
  }),
  routeTool({
    name: 'finish_run',
    lead: 'Finish a run: succeeded, failed, cancelled or timed out.',
    detail:
      'Call it when the run ends, with status (default succeeded) and any final details: summary (what happened), tokens_in, tokens_out, cost_usd (final totals), external_url. Finishing again with the same status answers with the run; another status is 409 run_finished. Only your own runs.',
    input: z.object({
      run_id: id('run_id'),
      status: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out']).optional(),
      summary: z.string().min(1).max(4000).optional(),
      tokens_in: z.number().int().min(0).optional(),
      tokens_out: z.number().int().min(0).optional(),
      cost_usd: z.number().min(0).optional(),
      provider: z.string().min(1).max(100).optional(),
      external_url: z.url().max(2000).optional(),
      note: z.string().min(1).max(500).optional(),
    }).strict(),
    permission: ['agent_activity.write', 'tasks.read', 'agents.manage'],
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agents/runs/{id}/finish',
    destructive: false,
    idempotent: true,
    request: ({ run_id, ...body }) => ({ params: { id: run_id }, body }),
  }),
  routeTool({
    name: 'list_runs',
    lead: 'List runs, newest first: yours, or every agent\'s.',
    detail:
      "source run is a run started with start_run; source turn is a turn your host recorded without a run, read as a finished run. Your own runs; with agents.manage every agent's (agent_id narrows it). Filter by task_id, project_id, status (running, waiting, succeeded, failed, cancelled, timed_out) or source.",
    input: z.object({
      agent_id: z.union([z.literal('me'), id('agent_id')]).optional(),
      task_id: id('task_id').optional(),
      project_id: id('project_id').optional(),
      status: z.enum(['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out', 'all']).optional(),
      source: z.enum(['run', 'turn', 'all']).optional(),
      page,
      limit: limit(20),
    }).strict(),
    permission: ['agent_activity.write', 'tasks.read', 'agents.manage'],
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agents/runs',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'get_run',
    lead: 'Get one run in full: plan, notes, turns and tokens.',
    detail: 'status reads timed_out for a run still running two hours after its last update; waiting while it waits on a person. turns counts the turn records that named it.',
    input: z.object({ run_id: id('run_id') }).strict(),
    permission: ['agent_activity.write', 'tasks.read', 'agents.manage'],
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agents/runs/{id}',
    request: ({ run_id }) => ({ params: { id: run_id } }),
  }),
  routeTool({
    name: 'get_run_tree',
    lead: 'Get the chain of runs a run belongs to, root first.',
    detail: "From any run in it: every run from the root, in start order, across every task the chain worked on, with parent_run_id, depth (0 for the root), agent, task, status, title and principal_id, and the tasks each delegated (mode subtask or assign). principal_id on the tree is the person the whole chain works for; levels counts its depth levels; max_depth is the deepest a run may sit (8). Another agent's run leaves out its summary, tokens, cost and trace link (visible false). You read a tree you have a run in, one that delegated to you, or any with agents.manage.",
    input: z.object({ run_id: id('run_id') }).strict(),
    permission: ['agent_activity.write', 'tasks.read', 'agents.manage'],
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agents/runs/{id}/tree',
    request: ({ run_id }) => ({ params: { id: run_id } }),
  }),
  routeTool({
    name: 'delegate_task',
    lead: 'Hand work to another agent: a new subtask, or a whole task.',
    detail: "mode subtask (default) creates a subtask of task_id assigned to agent_id (an active agent; list_agents has them), the same way create_task with parent_task_id does; title is required. mode assign hands task_id itself (top-level or a subtask) to the agent, as it is: the agent is added to its assignees, and with reassign true you come off it. Either way you need tasks.manage_all, the agent must reach the project, and your own rules apply (approval gives a suggestion for a subtask). Name your current run as run_id so the task is linked to it: the receiver starts its run with parent_run_id and get_run_tree shows the chain, at any depth. A chain keeps the person it works for: work for them stays where both they and the receiver reach (403 principal_mismatch for someone else), at most 8 hand-offs deep (409 chain_too_deep), never back to an agent above you (409 delegation_cycle). A personal agent hands work only to company agents. ai_readiness defaults to ai_ready. Answers with the task (task_id) and mode. Choosing the receiver is yours.",
    input: z.object({
      task_id: id('task_id'),
      agent_id: id('agent_id'),
      mode: z.enum(['subtask', 'assign']).optional().describe('subtask (default): a new subtask of task_id; assign: task_id itself'),
      reassign: z.boolean().optional().describe('mode assign: you come off the task as the agent goes on'),
      title: z.string().min(1).max(500).optional().describe('The new subtask\'s title (mode subtask)'),
      description: z.string().max(50_000).optional(),
      priority: PRIORITY.optional(),
      due_date: date.nullable().optional(),
      acceptance_criteria: z.array(z.string().min(1).max(2000)).max(50).optional(),
      ai_readiness: AI_READINESS.nullable().optional(),
      run_id: id('run_id').optional().describe('Your current run, which delegates it'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'tasks.create',
    requires: ['tasks.manage_all'],
    module: 'agents',
    method: 'POST',
    path: '/api/v1/tasks/{id}/delegate',
    request: ({ task_id, ...body }) => ({ params: { id: task_id }, body }),
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
  // Groups: named sets of people and agents, asked, escalated to and owning agents like one member.
  routeTool({
    name: 'list_groups',
    lead: 'List groups: teams of people you can ask at once.',
    detail: 'By name, paged, each with member_count, lead_count and is_member. search matches name or slug; member (me or a member id) lists only the groups that member is in. Use a group id as asked_to_group in ask_human or request_approval.',
    input: z.object({
      search: z.string().min(1).max(200).optional(),
      member: z.string().min(1).max(40).optional().describe('me, or a team member id'),
      page,
      limit: limit(50),
    }).strict(),
    permission: ['team.read', 'groups.manage'],
    method: 'GET',
    path: '/api/v1/groups',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'get_group',
    lead: 'Read one group: its name, description and counts.',
    detail: 'member_count and lead_count; list_group_members has who is in it.',
    input: z.object({ group_id: id('group_id') }).strict(),
    permission: ['team.read', 'groups.manage'],
    method: 'GET',
    path: '/api/v1/groups/{id}',
    request: ({ group_id }) => ({ params: { id: group_id } }),
  }),
  routeTool({
    name: 'list_group_members',
    lead: "List a group's members, leads first.",
    detail: 'Paged. search matches names; role member or lead. Each with member_id, name, team_role (agent for an agent), status and role.',
    input: z.object({
      group_id: id('group_id'),
      search: z.string().min(1).max(200).optional(),
      role: z.enum(['member', 'lead']).optional(),
      page,
      limit: limit(50),
    }).strict(),
    permission: ['team.read', 'groups.manage'],
    method: 'GET',
    path: '/api/v1/groups/{id}/members',
    request: ({ group_id, ...query }) => ({ params: { id: group_id }, query }),
  }),
  routeTool({
    name: 'create_group',
    lead: 'Create a group, with its first members and leads.',
    detail: 'Needs groups.manage. slug is made from the name when left out (409 slug_taken when another group has it). external_id is a directory\'s id for the group. member_ids and lead_ids add people and agents (up to 500).',
    input: z.object({
      name: z.string().min(1).max(100),
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lowercase letters, numbers and dashes').optional(),
      description: z.string().max(2000).optional(),
      external_id: z.string().min(1).max(255).nullable().optional(),
      member_ids: z.array(id('member_ids')).max(500).optional(),
      lead_ids: z.array(id('lead_ids')).max(500).optional(),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'groups.manage',
    method: 'POST',
    path: '/api/v1/groups',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_group',
    lead: "Change a group's name, slug or description.",
    detail: 'Needs groups.manage. Send only what changes: name, slug, description, external_id.',
    input: z.object({
      group_id: id('group_id'),
      name: z.string().min(1).max(100).optional(),
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lowercase letters, numbers and dashes').optional(),
      description: z.string().max(2000).optional(),
      external_id: z.string().min(1).max(255).nullable().optional(),
    }).strict().refine(atLeastOne(['name', 'slug', 'description', 'external_id']), 'Send at least one field to change'),
    permission: 'groups.manage',
    method: 'PATCH',
    path: '/api/v1/groups/{id}',
    request: ({ group_id, ...body }) => ({ params: { id: group_id }, body }),
  }),
  routeTool({
    name: 'add_group_members',
    lead: 'Add people or agents to a group.',
    detail: 'Needs groups.manage. member_ids (up to 500) join with role member (default) or lead; anyone already in it takes the role sent. Answers { added, updated }.',
    input: z.object({
      group_id: id('group_id'),
      member_ids: z.array(id('member_ids')).min(1).max(500),
      role: z.enum(['member', 'lead']).optional(),
    }).strict(),
    permission: 'groups.manage',
    method: 'POST',
    path: '/api/v1/groups/{id}/members',
    idempotent: true,
    request: ({ group_id, ...body }) => ({ params: { id: group_id }, body }),
  }),
  routeTool({
    name: 'remove_group_member',
    lead: 'Take someone out of a group.',
    detail: 'Needs groups.manage. Questions already asked to the group stay as they are.',
    input: z.object({ group_id: id('group_id'), member_id: id('member_id') }).strict(),
    permission: 'groups.manage',
    method: 'DELETE',
    path: '/api/v1/groups/{id}/members/{memberId}',
    request: ({ group_id, member_id }) => ({ params: { id: group_id, memberId: member_id } }),
  }),
  // Linked identities: who a chat account is, and how to reach people and groups.
  routeTool({
    name: 'resolve_identity',
    lead: 'Find which member a chat account belongs to.',
    detail: "provider (slack, teams, telegram, discord, github, email or custom.<name>), external_id (the account's id there, such as a Slack user id) and workspace_id for providers with workspaces. Only accounts the person verified resolve; anything else is 404 identity_not_found: send them create_identity_link. A suspended member reads active false: do not act for them.",
    input: z.object({
      provider: z.string().min(1).max(60),
      external_id: z.string().min(1).max(255),
      workspace_id: z.string().min(1).max(255).optional(),
    }).strict(),
    permission: 'identities.read',
    method: 'GET',
    path: '/api/v1/identities/resolve',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'get_member_identities',
    lead: 'How to reach a member: their verified chat accounts.',
    detail: 'provider narrows it (such as slack). Answers { member, identities }; each identity has provider, external_id, workspace_id and handle.',
    input: z.object({ member_id: id('member_id'), provider: z.string().min(1).max(60).optional() }).strict(),
    permission: 'identities.read',
    method: 'GET',
    path: '/api/v1/members/{id}/identities',
    request: ({ member_id, ...query }) => ({ params: { id: member_id }, query }),
  }),
  routeTool({
    name: 'get_group_identities',
    lead: 'How to reach a group: each member and their accounts.',
    detail: 'Paged, leads first. provider narrows it (such as slack). A suspended member is listed with active false and no accounts.',
    input: z.object({ group_id: id('group_id'), provider: z.string().min(1).max(60).optional(), page, limit: limit(50) }).strict(),
    permission: 'identities.read',
    method: 'GET',
    path: '/api/v1/groups/{id}/identities',
    request: ({ group_id, ...query }) => ({ params: { id: group_id }, query }),
  }),
  routeTool({
    name: 'create_identity_link',
    lead: 'Get a one-time link for a person to verify an account.',
    detail: 'For a chat account that does not resolve yet. Send url only as a direct message to that account itself, never in a channel: whoever confirms it lets agents act for them through the account. They open it signed in and confirm. Lasts 15 minutes and works once. Pass member_id whenever you know who it should be: then only that member can confirm it.',
    input: z.object({
      provider: z.string().min(1).max(60),
      external_id: z.string().min(1).max(255),
      workspace_id: z.string().min(1).max(255).optional(),
      handle: z.string().min(1).max(255).optional().describe('How the account is shown, such as @maria'),
      member_id: id('member_id').optional(),
    }).strict(),
    permission: 'identities.link',
    method: 'POST',
    path: '/api/v1/identities/link-requests',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'set_agent_rules',
    lead: 'Set what an agent may do on its own.',
    detail:
      "Needs team.manage; for agent members only. agent_self_assign: may pick up unassigned work. agent_close_policy: close (done finishes a task) or review (done moves it to in_review). agent_create_policy: live (new tasks go live) or approval (they become task suggestions). agent_escalate_to: a member id, or null for the Owner; agent_escalate_to_group: a group instead (any member answers; naming one clears the other). Send only what changes; answers with the member.",
    input: z.object({
      agent_id: id('agent_id'),
      agent_self_assign: z.boolean().optional(),
      agent_close_policy: z.enum(['close', 'review']).optional(),
      agent_create_policy: z.enum(['live', 'approval']).optional(),
      agent_escalate_to: id('agent_escalate_to').nullable().optional(),
      agent_escalate_to_group: id('agent_escalate_to_group').nullable().optional(),
    }).strict().refine(
      atLeastOne(['agent_self_assign', 'agent_close_policy', 'agent_create_policy', 'agent_escalate_to', 'agent_escalate_to_group']),
      'Send at least one rule to change',
    ),
    permission: 'team.manage',
    module: 'agents',
    method: 'PATCH',
    path: '/api/v1/team-members/{id}',
    request: ({ agent_id, ...body }) => ({ params: { id: agent_id }, body }),
  }),
  // Agent setup
  routeTool({
    name: 'create_agent',
    lead: 'Add an AI agent to the team.',
    detail:
      "Owner keys only (team.manage, AI agents module), as on the Team page. email is an address only this agent uses: it gets no sign-in link and works through keys. title (shown with its name), avatar and agent_profile (which MCP tools it sees) are optional. Then set_agent_projects, set_agent_rules, create_api_key and create_webhook_endpoint, and check everything with get_agent_setup. Answers with the member.",
    input: z.object({
      name: z.string().min(1).max(100),
      email: z.email('email must be an email address'),
      title: z.string().max(80).optional(),
      avatar: z.string().max(2000).optional(),
      agent_profile: AGENT_PROFILE.optional(),
      agent_role: AGENT_ROLE.optional().describe('A label for people (builder, code-reviewer); it drives no behaviour'),
      description: z.string().max(2000).optional(),
      owner_ids: z.array(id('owner_ids')).max(20).optional().describe('People responsible for it besides you (you always become one)'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'team.manage',
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agents',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'list_agents',
    lead: 'List the agents with their roles, owners and health.',
    detail: "By name, paged: each agent's role label, owners, template, live health, current run and how many projects it is on. Filters: role, owner (me or a member id), template, project, status (active or suspended), search.",
    input: z.object({
      role: AGENT_ROLE.optional(),
      owner: z.string().min(1).max(40).optional().describe('me, or a team member id'),
      template: z.string().min(1).max(100).optional(),
      project: id('project').optional(),
      status: z.enum(['active', 'suspended']).optional(),
      search: z.string().min(1).max(200).optional(),
      page, limit: limit(25),
    }).strict(),
    permission: 'team.read',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agents',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'update_agent',
    lead: "Change an agent's name, rules, owners, limits or pause.",
    detail: "For an Owner, team.manage or one of the agent's owners (403 not_agent_owner otherwise). Send only what changes: name, title, description, avatar_url, agent_role (null clears it), rules (self_assign, close_policy, create_policy, escalate_to, escalate_to_group). owner_ids replaces its owners (people, never agents) and owner_group_ids its owner groups (any member manages it); both are for an Owner or one of its owners. limits (max_concurrent_runs, rate_per_minute, budget_usd, budget_tokens, budget_period; null clears one) is a workspace Owner's only (403 owner_only). paused true stops its writes (reads, heartbeats and telemetry go on; other writes answer 423 agent_paused), false resumes it. Keys stay create_api_key's.",
    input: z.object({
      agent_id: id('agent_id'),
      name: z.string().min(1).max(100).optional(),
      title: z.string().max(80).nullable().optional(),
      description: z.string().max(2000).nullable().optional(),
      avatar_url: z.string().max(2000).nullable().optional(),
      agent_role: AGENT_ROLE.nullable().optional(),
      rules: z.object({
        self_assign: z.boolean().optional(),
        close_policy: z.enum(['close', 'review']).optional(),
        create_policy: z.enum(['live', 'approval']).optional(),
        escalate_to: id('escalate_to').nullable().optional(),
        escalate_to_group: id('escalate_to_group').nullable().optional(),
      }).strict().optional(),
      owner_ids: z.array(id('owner_ids')).max(20).optional(),
      owner_group_ids: z.array(id('owner_group_ids')).max(20).optional(),
      limits: agentLimitsPatchSchema.optional(),
      paused: z.boolean().optional(),
    }).strict().refine(
      atLeastOne(['name', 'title', 'description', 'avatar_url', 'agent_role', 'rules', 'owner_ids', 'owner_group_ids', 'limits', 'paused']),
      'Send at least one field to change',
    ),
    permission: 'team.read',
    module: 'agents',
    method: 'PATCH',
    path: '/api/v1/agents/{id}',
    request: ({ agent_id, ...body }) => ({ params: { id: agent_id }, body }),
  }),
  routeTool({
    name: 'set_project_agent',
    lead: 'Assign an agent to a project, with settings.',
    detail: "Adds the agent to the project or changes its assignment there: status (active or paused), template_key, settings (checked against the template's fields: 422 invalid_settings names each one; list_agent_templates shows them) and instructions for this project only (up to 8000 characters). Adding it also gives it project access, which only an Owner or project_members.manage may do: an owner of the agent without it sets the agent up only on projects it is already on (403 project_access_needed). Needs project_members.manage or to own the agent, on a project you reach.",
    input: z.object({
      project_id: id('project_id'),
      agent_id: id('agent_id'),
      status: ASSIGNMENT_STATUS.optional(),
      template_key: z.string().min(1).max(100).nullable().optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
      instructions: z.string().max(8000).optional(),
    }).strict(),
    permission: ['project_members.manage', 'team.read'],
    module: 'agents',
    method: 'PUT',
    path: '/api/v1/projects/{id}/agents/{agentId}',
    request: ({ project_id, agent_id, ...body }) => ({ params: { id: project_id, agentId: agent_id }, body }),
  }),
  routeTool({
    name: 'remove_project_agent',
    lead: 'Take an agent off a project.',
    detail: 'Removes its assignment (settings and instructions). Its project access stays: set_agent_projects changes that. Needs project_members.manage or to own the agent.',
    input: z.object({ project_id: id('project_id'), agent_id: id('agent_id') }).strict(),
    permission: ['project_members.manage', 'team.read'],
    module: 'agents',
    method: 'DELETE',
    path: '/api/v1/projects/{id}/agents/{agentId}',
    request: ({ project_id, agent_id }) => ({ params: { id: project_id, agentId: agent_id } }),
  }),
  routeTool({
    name: 'setup_project',
    lead: 'Set up a whole project in one call.',
    detail: "The project (in project: the fields POST /api/v1/projects takes), members (member ids), brief entries ({ section, content, pinned }), goals ({ title, description, target_date }) and agents ({ agent_id, template_key, settings, instructions }). Each part needs its own permission, all checked before anything is written; a failure partway moves the project to Trash (reason setup_incomplete). Read the plan back to the person first. Answers { project, assignments, brief, goals }.",
    input: z.object({
      project: z.record(z.string(), z.unknown()).describe('The project fields: name (required), description, color, status, start_date, due_date and the rest POST /api/v1/projects takes'),
      members: z.array(id('members')).max(500).optional(),
      brief: z.array(z.object({ section: BRIEF_SECTION, content: z.string().min(1).max(20_000), pinned: z.boolean().optional() }).strict()).max(200).optional(),
      goals: z.array(z.object({
        title: z.string().min(1).max(500),
        description: z.string().max(5000).optional(),
        target_date: z.string().max(40).nullable().optional(),
      }).strict()).max(50).optional(),
      agents: z.array(z.object({
        agent_id: id('agent_id'),
        template_key: z.string().min(1).max(100).nullable().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        instructions: z.string().max(8000).optional(),
        status: ASSIGNMENT_STATUS.optional(),
      }).strict()).max(200).optional(),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'projects.manage',
    method: 'POST',
    path: '/api/v1/projects/setup',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'get_agent_setup',
    lead: "Read an agent's whole setup to check it.",
    detail:
      'The member, its rules, its projects and project reach, its live API keys (never a secret) with available_scopes (what a key for it may carry), and the webhook endpoints filtered to it. A part your key may not read is null and named in omitted.',
    input: z.object({ agent_id: id('agent_id') }).strict(),
    permission: 'team.read',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agents/{id}/setup',
    request: (args) => ({ params: { id: args.agent_id } }),
  }),
  routeTool({
    name: 'set_agent_projects',
    lead: 'Add an agent to projects or take it off them.',
    detail:
      "Needs project_members.manage; agents only, and only projects your own member reaches. An agent works in the projects it is on unless its role reaches every project (get_agent_setup shows projects.access). Answers with what changed and the agent's projects now.",
    input: z.object({
      agent_id: id('agent_id'),
      add: z.array(id('add')).max(100).optional(),
      remove: z.array(id('remove')).max(100).optional(),
    }).strict().refine((value) => (value.add?.length ?? 0) + (value.remove?.length ?? 0) > 0, 'Send a project to add or remove'),
    permission: 'project_members.manage',
    module: 'agents',
    method: 'PATCH',
    path: '/api/v1/agents/{id}/projects',
    request: ({ agent_id, ...body }) => ({ params: { id: agent_id }, body }),
  }),
  routeTool({
    name: 'create_api_key',
    lead: 'Make an API key for an agent; the secret shows once.',
    detail:
      "Needs api_keys.manage_all, and an Owner's key for an agent (agent_id may also be your own member). The new key is tied to yours: revoking yours revokes it. Every scope must be one the agent holds (get_agent_setup lists them as available_scopes) and one your own key carries: a key never grants more than it has. read_only refuses its writes. The answer's secret is the only copy: hand it to the agent's host now. No idempotency_key: on a timeout, list_api_keys before trying again.",
    input: z.object({
      agent_id: id('agent_id'),
      name: z.string().min(1).max(100),
      scopes: z.array(API_SCOPE).min(1),
      read_only: z.boolean().optional(),
      expires_in_days: z.number().int().min(1).max(3650).nullable().optional().describe("Days until the key stops working, or null for no expiry; left out, the workspace's key lifetime for that member, which caps it unless yours is an Owner's key"),
    }).strict(),
    permission: 'api_keys.manage_all',
    method: 'POST',
    path: '/api/v1/api-keys',
    request: ({ agent_id, read_only, ...body }) => ({ body: { member_id: agent_id, ...body, permissions: read_only ? 'read_only' : 'scoped' } }),
  }),
  routeTool({
    name: 'list_api_keys',
    lead: 'List API keys, never their secrets.',
    detail: 'Needs api_keys.manage_all. member_id narrows to one member; live keys only unless include_revoked.',
    input: z.object({
      member_id: id('member_id').optional(),
      include_revoked: z.boolean().optional(),
      page, limit: limit(25),
    }).strict(),
    permission: 'api_keys.manage_all',
    method: 'GET',
    path: '/api/v1/api-keys',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'revoke_api_key',
    lead: 'Revoke an API key for good.',
    detail: 'Needs api_keys.manage_all. Keys it made over the API, and keys those made, are revoked with it (cascaded_revokes). Whatever uses them stops working at once; a revoke cannot be undone. Revoking again answers with the key as it is.',
    input: z.object({ key_id: id('key_id') }).strict(),
    permission: 'api_keys.manage_all',
    method: 'POST',
    path: '/api/v1/api-keys/{id}/revoke',
    destructive: true,
    idempotent: true,
    request: (args) => ({ params: { id: args.key_id } }),
  }),
  routeTool({
    name: 'rotate_api_key',
    lead: 'Replace a key, keeping the old one alive for a while.',
    detail: "Needs api_keys.manage_all (an Owner's key for an agent's key), or assistants.provision for a personal agent's key. The new key has the same member, scopes and name; the old one keeps working for overlap_hours (default 24, 0 to 168), then stops. A key is replaced once: rotate the new one next time. The answer's secret is the only copy: hand it to the host now, before the old key stops. No idempotency_key.",
    input: z.object({ key_id: id('key_id'), overlap_hours: z.number().min(0).max(168).optional() }).strict(),
    permission: ['api_keys.manage_all', 'assistants.provision'],
    method: 'POST',
    path: '/api/v1/api-keys/{id}/rotate',
    request: ({ key_id, ...body }) => ({ params: { id: key_id }, body }),
  }),
  routeTool({
    name: 'list_assistants',
    lead: "List people's personal agents, never a secret.",
    detail: 'Needs assistants.provision. Each with its person, template, status (paused_with_person when its person was suspended) and live keys. needs_key true lists the active ones with no live key: the ones a harness collects a key for (POST /api/v1/assistants/{id}/key, REST only). person_id narrows to one person.',
    input: z.object({ needs_key: z.boolean().optional(), person_id: id('person_id').optional(), page, limit: limit(25) }).strict(),
    permission: 'assistants.provision',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/assistants',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'list_assistant_setups',
    lead: 'List which template each role or group gets.',
    detail: "Needs assistants.provision on an Owner's key. Each setup matches a role or a group, names a template and default settings (name_template, title, description, rules), and is on or off.",
    input: z.object({}).strict(),
    permission: 'assistants.provision',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/assistant-setups',
    request: () => ({}),
  }),
  routeTool({
    name: 'create_assistant_setup',
    lead: 'Give a role or a group a personal agent each.',
    detail: "Needs assistants.provision on an Owner's key. match_role (owner, admin, member, guest) or match_group_id, exactly one; template_key defaults to personal-assistant; settings.name_template uses {first_name} and {name}. New people with the role get theirs when they join; run provision_assistants for everyone already here. 409 setup_exists when that role or group already has one with the template.",
    input: z.object({
      match_role: z.enum(['owner', 'admin', 'member', 'guest']).optional(),
      match_group_id: id('match_group_id').optional(),
      template_key: z.string().min(1).max(64).optional(),
      settings: z.object({
        name_template: z.string().min(1).max(80).optional(),
        title: z.string().max(80).nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
        rules: z.object({
          agent_self_assign: z.boolean().optional(),
          agent_close_policy: z.enum(['close', 'review']).optional(),
          agent_create_policy: z.enum(['live', 'approval']).optional(),
        }).strict().optional(),
      }).strict().optional(),
      enabled: z.boolean().optional(),
    }).strict(),
    permission: 'assistants.provision',
    module: 'agents',
    method: 'POST',
    path: '/api/v1/assistant-setups',
    request: (args) => ({ body: args }),
  }),
  routeTool({
    name: 'provision_assistants',
    lead: 'Make personal agents for everyone a setup matches.',
    detail: "Needs assistants.provision on an Owner's key. Idempotent: run it again and nothing new is made. limit people per call (default 100, at most 500): call again until remaining is 0. Run dry_run true first and read the plan back to the person; a dry run pages with after (next_after). setup_id runs one setup. Agents are made without keys.",
    input: z.object({
      dry_run: z.boolean().optional(),
      setup_id: id('setup_id').optional(),
      limit: z.number().int().min(1).max(500).optional(),
      after: id('after').optional(),
    }).strict(),
    permission: 'assistants.provision',
    module: 'agents',
    method: 'POST',
    path: '/api/v1/assistants/provision',
    idempotent: true,
    request: (args) => ({ body: args }),
  }),
  routeTool({
    name: 'list_chat_messages',
    lead: 'List chat messages sent to you.',
    detail: 'For a person\'s own assistant, or a company agent on a company chat connection. status pending (the default: messages no webhook was sent for, waiting for you), notified, replied, handled, unrouted, context (channel messages recorded for you to know, never to answer) or all; limit 1 to 100. Each has its text, person, provider, connection_kind, channel, is_request and the thread so far, oldest first. Answer each request with reply_in_chat, or mark_chat_handled when no answer is needed.',
    input: z.object({
      status: z.enum(['pending', 'notified', 'replied', 'handled', 'unrouted', 'context', 'all']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
    permission: 'notifications.manage_own',
    agentsOnly: true,
    chatAgentsOnly: true,
    module: 'agents',
    method: 'GET',
    path: '/api/v1/chat/messages',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'get_chat_message',
    lead: 'Read one chat message sent to you.',
    detail: 'message_id is from chat.message (which carries ids only, never text) or list_chat_messages. Answers its text, person, provider, channel, is_request and the thread so far. A company request also carries act_for: mint a pass for the person with it (POST /api/v1/delegations) and work and reply with X-Act-For.',
    input: z.object({ message_id: id('message_id') }).strict(),
    permission: 'notifications.manage_own',
    agentsOnly: true,
    chatAgentsOnly: true,
    module: 'agents',
    method: 'GET',
    path: '/api/v1/chat/messages/{id}',
    request: ({ message_id }) => ({ params: { id: message_id } }),
  }),
  routeTool({
    name: 'reply_in_chat',
    lead: 'Reply in the chat a message came from.',
    detail: 'message_id is the chat message you answer (from chat.message, get_chat_message or list_chat_messages); the app sends text through Slack, Telegram or Discord under your name (Slack; Discord through a channel webhook, else your name in bold), in its thread unless in_thread is false, and marks the message replied. In a company channel the answer threads under the message; also_send_to_channel shows it in the channel too (Slack; on Discord a reply always shows in the channel). private sends it to the sender by DM. A company request needs X-Act-For for its sender (403 act_for_required); context is never answered (409 not_a_request). Plain text, their tone. 502 provider_refused when the provider refuses, with its reason.',
    input: z.object({
      message_id: id('message_id'),
      text: z.string().min(1).max(20000),
      in_thread: z.boolean().optional(),
      also_send_to_channel: z.boolean().optional(),
      private: z.boolean().optional(),
    }).strict(),
    permission: 'notifications.manage_own',
    agentsOnly: true,
    chatAgentsOnly: true,
    module: 'agents',
    method: 'POST',
    path: '/api/v1/chat/messages/{id}/reply',
    request: ({ message_id, ...body }) => ({ params: { id: message_id }, body }),
  }),
  routeTool({
    name: 'send_chat_message',
    lead: 'Start a chat conversation: a digest, an alert or a report.',
    detail: 'A personal assistant messages only its own person, by DM (leave out person_id). A company agent posts in a channel mapped to it (channel: its id or #name; being the default agent does not widen this), or DMs a member (person_id) while acting for them with X-Act-For, or unasked only with chat.notify. link { url (https), label } shows as a Slack link, a Telegram button or a Discord link. Under your name where the provider allows. A reply to it comes back to you as chat.message. connection_id or provider picks the connection when several fit (409 choose_connection lists them). Rate limited per agent and per recipient each hour (429 chat_rate_limited). Plain text, their tone.',
    input: z.object({
      text: z.string().min(1).max(20000),
      person_id: id('person_id').optional(),
      channel: z.string().min(1).max(255).optional(),
      connection_id: id('connection_id').optional(),
      provider: z.enum(['slack', 'telegram', 'discord']).optional(),
      link: z.object({ url: z.string().min(1).max(2000), label: z.string().min(1).max(80) }).strict().optional(),
    }).strict(),
    permission: 'notifications.manage_own',
    agentsOnly: true,
    chatAgentsOnly: true,
    module: 'agents',
    method: 'POST',
    path: '/api/v1/chat/messages',
    request: (args) => ({ body: args }),
  }),
  routeTool({
    name: 'mark_chat_handled',
    lead: 'Mark a chat message handled without replying.',
    detail: 'The request stops showing as pending. Repeating it changes nothing. Context needs no marking.',
    input: z.object({ message_id: id('message_id') }).strict(),
    permission: 'notifications.manage_own',
    agentsOnly: true,
    chatAgentsOnly: true,
    module: 'agents',
    method: 'POST',
    path: '/api/v1/chat/messages/{id}/handled',
    idempotent: true,
    request: ({ message_id }) => ({ params: { id: message_id } }),
  }),
  routeTool({
    name: 'list_webhook_endpoints',
    lead: 'List webhook endpoints, never their secrets.',
    detail: 'Needs webhooks.manage. member_id narrows to endpoints filtered to that member; assistant_setup_id to those scoped to that assistant setup; active to the ones on or off.',
    input: z.object({ member_id: id('member_id').optional(), assistant_setup_id: id('assistant_setup_id').optional(), active: z.boolean().optional() }).strict(),
    permission: 'webhooks.manage',
    method: 'GET',
    path: '/api/v1/webhook-endpoints',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'create_webhook_endpoint',
    lead: 'Add a webhook endpoint; its secret shows once.',
    detail:
      "Needs webhooks.manage. url is HTTPS to a public address (never localhost or a private network; redirects are not followed). events: what to send (invoice events need Client invoicing). project_ids limits it to those projects; member_id to events that concern that member, such as an agent's own work, which is how an agent's harness gets woken. assistant_setup_id instead of member_id: every personal agent that assistant setup made, assistant.message included, so an assistant host keeps one endpoint for all of them (an Owner's key, or one with assistants.provision; each payload's agent_id says which assistant). agent_event.created (every agent event, opt in) takes agent_event_types to narrow it. The answer's secret signs every delivery and is the only copy: put it in the receiver now. No idempotency_key: on a timeout, list_webhook_endpoints before trying again.",
    input: z.object({
      name: z.string().min(1).max(100),
      url: z.string().min(1).max(2000),
      events: z.array(WEBHOOK_EVENT).min(1),
      description: z.string().max(500).optional(),
      amount_basis: z.enum(['gross', 'net']).optional(),
      project_ids: z.array(id('project_ids')).max(200).nullable().optional(),
      member_id: id('member_id').nullable().optional(),
      assistant_setup_id: id('assistant_setup_id').nullable().optional().describe('Every personal agent this assistant setup made (not with member_id)'),
      agent_event_types: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/)).max(100).nullable().optional().describe('For agent_event.created: only these agent event types'),
      is_active: z.boolean().optional(),
    }).strict(),
    permission: 'webhooks.manage',
    method: 'POST',
    path: '/api/v1/webhook-endpoints',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_webhook_endpoint',
    lead: "Change a webhook endpoint's events, filters or state.",
    detail: 'Needs webhooks.manage. Send only what changes. is_active false pauses deliveries; project_ids, member_id or assistant_setup_id null removes that filter. The secret never changes.',
    input: z.object({
      endpoint_id: id('endpoint_id'),
      name: z.string().min(1).max(100).optional(),
      url: z.string().min(1).max(2000).optional(),
      events: z.array(WEBHOOK_EVENT).min(1).optional(),
      description: z.string().max(500).optional(),
      amount_basis: z.enum(['gross', 'net']).optional(),
      project_ids: z.array(id('project_ids')).max(200).nullable().optional(),
      member_id: id('member_id').nullable().optional(),
      assistant_setup_id: id('assistant_setup_id').nullable().optional(),
      agent_event_types: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/)).max(100).nullable().optional(),
      is_active: z.boolean().optional(),
    }).strict().refine(
      atLeastOne(['name', 'url', 'events', 'description', 'amount_basis', 'project_ids', 'member_id', 'assistant_setup_id', 'agent_event_types', 'is_active']),
      'Send at least one field to change',
    ),
    permission: 'webhooks.manage',
    method: 'PATCH',
    path: '/api/v1/webhook-endpoints/{id}',
    request: ({ endpoint_id, ...body }) => ({ params: { id: endpoint_id }, body }),
  }),
  routeTool({
    name: 'delete_webhook_endpoint',
    lead: 'Delete a webhook endpoint.',
    detail: 'Needs webhooks.manage. Events stop going to its URL and its delivery history goes too. To pause it instead, update_webhook_endpoint with is_active false.',
    input: z.object({ endpoint_id: id('endpoint_id') }).strict(),
    permission: 'webhooks.manage',
    method: 'DELETE',
    path: '/api/v1/webhook-endpoints/{id}',
    request: (args) => ({ params: { id: args.endpoint_id } }),
  }),
  routeTool({
    name: 'get_agent_context',
    lead: "Read an agent's context pack, as its key sees it.",
    detail:
      "The pack its own key gets in pm_guide: who it is, its key's scopes in plain words, its rules, projects, the MCP tools it sees, house conventions, health reporting, webhooks and its template's brief. format markdown answers the same as an AGENTS.md text to hand its host instead. key_id picks one of its keys; left out, its newest key, or the scopes it holds when it has none. Scopes and tools need api_keys.manage_all and webhooks webhooks.manage, else null and named in omitted. Generated now, never stored. REST: GET /api/v1/agents/{id}/context?format=md for the file.",
    input: z.object({
      agent_id: id('agent_id'),
      key_id: id('key_id').optional(),
      format: z.enum(['pack', 'markdown']).optional().describe('pack (default): the pack as JSON; markdown: the AGENTS.md text'),
    }).strict(),
    permission: 'team.read',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agents/{id}/context',
    request: ({ agent_id, key_id, format }) => ({ params: { id: agent_id }, query: { key_id, format: format ?? 'pack' } }),
  }),
  routeTool({
    name: 'list_agent_templates',
    lead: 'List the agent templates you can start an agent from.',
    detail:
      "Core's (data-health-watcher, inbox-triage while the Inbox is on, builder, weekly-reporter, personal-assistant, external-agent for an agent that works in another system) and this workspace's own. Each: the rules it sets, the scopes a key for it should carry, the brief added to the agent's context pack, and suggested webhook events. Apply one with apply_agent_template.",
    input: z.object({}).strict(),
    permission: 'team.manage',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agent-templates',
    request: () => ({}),
  }),
  routeTool({
    name: 'apply_agent_template',
    lead: 'Apply a template to an agent: its rules, maybe a key.',
    detail:
      "Needs team.manage; agents only. Sets the template's rules. Your key must carry every scope the template suggests (403 scope_escalation otherwise; nothing changes). create_key true also makes a key with those scopes (an Owner's key with api_keys.manage_all, every scope held by the agent): its secret is in this answer only, so hand it to the agent's host now. Answers with the rules, the key or the scopes still to grant, and webhook_events to use with create_webhook_endpoint. No idempotency_key: on a timeout, get_agent_setup before trying again.",
    input: z.object({
      agent_id: id('agent_id'),
      template: z.string().min(1).max(100),
      create_key: z.boolean().optional(),
      key_name: z.string().min(1).max(100).optional(),
      read_only: z.boolean().optional(),
    }).strict(),
    permission: 'team.manage',
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agents/{id}/template',
    request: ({ agent_id, ...body }) => ({ params: { id: agent_id }, body }),
  }),
  routeTool({
    name: 'export_agent_config',
    lead: "Export an agent's configuration as a document.",
    detail:
      'A versioned document import_agent_config reads back, here or in another workspace: name, title, profile, rules, projects by id and name, live keys (names and scopes), webhook endpoints filtered to it (URL, events, project filter) and the template it was set up from. Never a secret or a hash. Keys need api_keys.manage_all and webhooks webhooks.manage; without one that part is null and named in omitted.',
    input: z.object({ agent_id: id('agent_id') }).strict(),
    permission: 'team.read',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agents/{id}/export',
    request: (args) => ({ params: { id: args.agent_id } }),
  }),
  routeTool({
    name: 'import_agent_config',
    lead: 'Create or update an agent from an exported document.',
    detail:
      "Needs team.manage. Without agent_id it adds a new agent (Owner keys only; email is an address only it uses, name overrides the document's); with agent_id it updates that agent. Projects and the escalation target match by id, then by name, among what you reach; what does not match is listed in unmatched, and parts your key cannot change in not_applied. Projects are only added. Keys are made only with create_keys, new webhook endpoints only with create_webhooks, and their secrets are in this answer only. dry_run true answers the plan and changes nothing: run it first. No idempotency_key: on a timeout, get_agent_setup before trying again.",
    input: z.object({
      document: z.record(z.string(), z.unknown()).describe('The document export_agent_config answered'),
      agent_id: id('agent_id').optional(),
      name: z.string().min(1).max(100).optional(),
      email: z.email('email must be an email address').optional(),
      dry_run: z.boolean().optional(),
      create_keys: z.boolean().optional(),
      create_webhooks: z.boolean().optional(),
    }).strict(),
    permission: 'team.manage',
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agents/import',
    request: (body) => ({ body }),
  }),
  // The registries: an Owner's own profiles and templates, as rows beside code's.
  routeTool({
    name: 'list_agent_profiles',
    lead: 'List the agent profiles: which MCP tools an agent sees.',
    detail: "Core's (generic), this install's and the workspace's own, each with value, label, description, tools (null: every tool its keys allow) and source (core, install or workspace). include_archived adds archived ones. An agent gets one through create_agent, the Team page or import_agent_config.",
    input: z.object({ include_archived: z.boolean().optional() }).strict(),
    permission: 'team.read',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agent-profiles',
    request: ({ include_archived }) => ({ query: include_archived ? { include_archived: 'true' } : {} }),
  }),
  routeTool({
    name: 'create_agent_profile',
    lead: 'Add a profile of your own: a named set of MCP tools.',
    detail: "Owner only. value (lowercase, dashes, at most 40), label, description, and tools: the tool names it sees (pm_guide always), or null for every tool its keys allow. A profile only narrows what an agent's keys could do. A value code already holds is refused (409 registry_key_taken); a tool name that does not exist is refused (422).",
    input: z.object({
      value: AGENT_PROFILE,
      label: z.string().min(1).max(80),
      description: z.string().min(1).max(500),
      tools: z.array(z.string().min(1).max(64)).min(1).max(300).nullable().optional(),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'team.manage',
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agent-profiles',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_agent_profile',
    lead: 'Change or archive a profile of your own.',
    detail: "Owner only; core's and the install's profiles live in code. Send only what changes: label, description, tools (null: every tool), archived (true archives it, false brings it back). A profile agents still use cannot be archived (409 profile_in_use): move them first.",
    input: z.object({
      value: AGENT_PROFILE,
      label: z.string().min(1).max(80).optional(),
      description: z.string().min(1).max(500).optional(),
      tools: z.array(z.string().min(1).max(64)).min(1).max(300).nullable().optional(),
      archived: z.boolean().optional(),
    }).strict().refine(atLeastOne(['label', 'description', 'tools', 'archived']), 'Send at least one field to change'),
    permission: 'team.manage',
    module: 'agents',
    method: 'PATCH',
    path: '/api/v1/agent-profiles/{value}',
    request: ({ value, ...body }) => ({ params: { value }, body }),
  }),
  routeTool({
    name: 'create_agent_template',
    lead: 'Add a template of your own to start agents from.',
    detail: "Owner only, no deploy needed. key, label, description, rules (agent_self_assign, agent_close_policy close or review, agent_create_policy live or approval), scopes (the API scopes a key for it carries), context (its brief, at most 2,000 characters), and optionally webhook_events, module, settings (per-project fields), role, profile (one list_agent_profiles names) and limits. Checked exactly as code's templates are. A key code already holds is refused (409 registry_key_taken). It then shows in list_agent_templates and works with apply_agent_template.",
    input: z.object({
      key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100),
      label: z.string().min(1).max(80),
      description: z.string().min(1).max(500),
      rules: z.object({ agent_self_assign: z.boolean(), agent_close_policy: z.enum(['close', 'review']), agent_create_policy: z.enum(['live', 'approval']) }).strict(),
      scopes: z.array(API_SCOPE).min(1).max(100),
      context: z.string().min(1).max(2000),
      webhook_events: z.array(WEBHOOK_EVENT).max(50).optional(),
      module: z.string().min(1).max(40).optional(),
      settings: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
      role: AGENT_ROLE.optional(),
      profile: AGENT_PROFILE.optional(),
      limits: z.record(z.string(), z.unknown()).optional(),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'team.manage',
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agent-templates',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'update_agent_template',
    lead: 'Change or archive a template of your own.',
    detail: "Owner only; core's and the install's templates live in code. Send only what changes (label, description, rules, scopes, context, webhook_events, module, settings, role, profile, limits) or archived (true archives it, false brings it back). Agents already set up from it keep their setup.",
    input: z.object({
      key: z.string().min(1).max(100),
      label: z.string().min(1).max(80).optional(),
      description: z.string().min(1).max(500).optional(),
      rules: z.object({ agent_self_assign: z.boolean(), agent_close_policy: z.enum(['close', 'review']), agent_create_policy: z.enum(['live', 'approval']) }).strict().optional(),
      scopes: z.array(API_SCOPE).min(1).max(100).optional(),
      context: z.string().min(1).max(2000).optional(),
      webhook_events: z.array(WEBHOOK_EVENT).max(50).optional(),
      module: z.string().min(1).max(40).optional(),
      settings: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
      role: AGENT_ROLE.optional(),
      profile: AGENT_PROFILE.optional(),
      limits: z.record(z.string(), z.unknown()).optional(),
      archived: z.boolean().optional(),
    }).strict().refine(atLeastOne(['label', 'description', 'rules', 'scopes', 'context', 'webhook_events', 'module', 'settings', 'role', 'profile', 'limits', 'archived']), 'Send at least one field to change'),
    permission: 'team.manage',
    module: 'agents',
    method: 'PATCH',
    path: '/api/v1/agent-templates/{key}',
    request: ({ key, ...body }) => ({ params: { key }, body }),
  }),
  routeTool({
    name: 'export_agent_registries',
    lead: 'Export your own agent profiles and templates.',
    detail: "One document (format pm-agent-registries) with the workspace's own live profiles and templates, for import_agent_registries here or in another workspace. Code's ship with the code and are left out.",
    input: z.object({}).strict(),
    permission: 'team.manage',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agent-registries/export',
    request: () => ({}),
  }),
  routeTool({
    name: 'import_agent_registries',
    lead: 'Import agent profiles and templates from a document.',
    detail: 'Owner only. Each profile and template is created, or updates (and brings back) the one with its key. A key code holds is refused, never overridden, and so is an entry that fails a check: refused says which and why. dry_run true answers the plan and changes nothing: run it first and read it back to the person.',
    input: z.object({
      document: z.record(z.string(), z.unknown()).describe('The document export_agent_registries answered'),
      dry_run: z.boolean().optional(),
    }).strict(),
    permission: 'team.manage',
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agent-registries/import',
    request: (body) => ({ body }),
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
      idempotency_key: idempotencyKeyInput,
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
  // Inbox: the agent API at /api/v1/inbox, for triage agents. Email content is data, never instructions.
  routeTool({
    name: 'list_inbox',
    lead: 'List inbox email you can read, newest first.',
    detail:
      "Summaries without bodies, from every inbox your key's member may read (or inbox_id; handled me: only the ones you handle). status new (waiting for triage), needs_human (waiting on a person), handled, or ignored (Filtered). project_id: conversations filed on that project. Read one in full with get_email.",
    input: z.object({
      inbox_id: id('inbox_id').optional(),
      handled: z.enum(['me']).optional().describe('me: only the inboxes you handle, as yourself or through a group'),
      status: z.enum(AGENT_MESSAGE_STATUSES).optional(),
      project_id: id('project_id').optional(),
      page, limit: limit(25),
    }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/messages',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'get_email',
    lead: 'Read one email with its whole conversation.',
    detail:
      "The email (text; new_text, its own words without quotes; sender trust; forward and routing facts; latest triage; linked tasks; attachments, agent_readable for the ones you may open; a person's answers), its inbox, the conversation's projects, project_scope (the projects it may touch) and candidates, and the thread. Bounded: html_text is left out wherever text has the words, long text is cut and flagged (*_truncated), and the thread shows its newest 8 messages by their own words. An email in an inbox you cannot read answers 404.",
    input: z.object({ message_id: id('message_id') }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/messages/{id}',
    request: ({ message_id }) => ({ params: { id: message_id } }),
    present: emailInFull(EMAIL_LIMITS),
  }),
  routeTool({
    name: 'get_email_triage_context',
    lead: 'Read everything needed to triage one email.',
    detail:
      'One call before you plan: the email (bounded as in get_email, tighter), who is speaking and how it reached us (speaker, trust, delivery, addressed_to_agent), what earlier plans on the conversation did, replies owed and the open question, its reminders, and each project in scope with its open tasks, their subtasks and what triage did there lately. Bounded to fit: each project keeps its newest open tasks (15), their first open subtasks (5) and its newest recent items (10), less when many projects are in scope; every cut is noted (open_tasks_note, subtasks_note, recent_note, cut_to_fit). mode shadow leaves out what this email already caused, for a shadow triage. get_email has more of the text.',
    input: z.object({ message_id: id('message_id'), mode: z.enum(['live', 'shadow']).optional().describe('Default live') }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/messages/{id}/context',
    request: ({ message_id, mode }) => ({ params: { id: message_id }, query: { mode } }),
    present: triageContextInFull,
  }),
  routeTool({
    name: 'get_email_attachment_link',
    lead: 'Get a five-minute link to an email attachment.',
    detail: 'Only for the kinds the inbox lets agents read (agent_readable true in get_email): 403 not_agent_readable otherwise, 409 when the file was not stored.',
    input: z.object({ message_id: id('message_id'), attachment_id: id('attachment_id') }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/messages/{id}/attachments/{aid}/url',
    request: ({ message_id, attachment_id }) => ({ params: { id: message_id, aid: attachment_id } }),
  }),
  routeTool({
    name: 'get_triage_queue',
    lead: 'List the emails a triage job should plan next.',
    detail:
      'Oldest first, from your inboxes (or inbox_id; handled me: only the ones you handle). mode plans (default): new email in inboxes switched to plans once its conversation has been quiet a few minutes (meetings and urgent machine mail at once). mode shadow: email the older triage handled in shadow inboxes that no shadow plan covers yet. limit 1-100, default 20.',
    input: z.object({
      mode: z.enum(['plans', 'shadow']).optional(),
      inbox_id: id('inbox_id').optional(),
      handled: z.enum(['me']).optional().describe('me: only the inboxes you handle, as yourself or through a group'),
      limit: z.number().int().min(1).max(100).optional().describe('1-100, default 20'),
    }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/queue',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'submit_triage_plan',
    lead: 'Submit a triage plan for one email.',
    detail:
      'Applies in inboxes switched to plans (and for every meeting); anywhere else it is recorded as shadow and applies nothing. A summary, then items, each with a type, an intent, evidence and confidence: create_task, update_task, comment, attach_file, add_reminder, update_reminder, complete_reminder, link_task, file_project, reply_owed, revert_item, mute_conversation, add_context, propose_mapping, create_lead, log_interaction, or ask (one question at most). Every item is checked first: one bad item rejects the plan (422 with each problem, nothing written). Then the policy decides each: apply, apply unsure, propose (waits for a person) or reject, with its reason. idempotency_key is per email: the same plan again replays, finishing an interrupted one; another plan with it is 409.',
    input: z.object({ message_id: id('message_id'), ...planSchema.shape }).strict(),
    permission: 'inbound_email.triage',
    method: 'POST',
    path: '/api/v1/inbox/messages/{id}/plan',
    idempotencyKeyIn: 'body',
    request: ({ message_id, ...body }) => ({ params: { id: message_id }, body }),
  }),
  routeTool({
    name: 'record_email_triage',
    lead: 'Record the older triage outcome for one email.',
    detail:
      "For inboxes on the older triage. outcome no_action, task, needs_reply or needs_human, a summary, links to tasks (created, updated or related) and project_ids to file it on, each in its project_scope (422 project_out_of_scope otherwise, nothing written). category outreach files it in Filtered unless a guardrail keeps it; outreach is always no_action. needs_human, or an unverified sender, leaves it waiting on a person: put the one-line question in question_for_human, and up to three questions with 2-4 options and your recommended pick, which the Inbox shows as a decision card. settles_earlier closes what the conversation's earlier emails waited on (a verified sender only). idempotency_key (8-100 characters) is per email: the same body replays, another is 409. Nothing is sent.",
    input: z.object({ message_id: id('message_id'), ...triageSchema.shape }).strict(),
    permission: 'inbound_email.triage',
    deprecated: { replacement: 'submit_triage_plan', removal: PLANS_CUTOVER_REMOVAL },
    method: 'POST',
    path: '/api/v1/inbox/messages/{id}/triage',
    idempotencyKeyIn: 'body',
    request: ({ message_id, ...body }) => ({ params: { id: message_id }, body }),
  }),
  routeTool({
    name: 'create_task_from_email',
    lead: 'Create the task an email asks for, linked to it.',
    detail:
      "On a project in the email's project_scope (422 project_out_of_scope otherwise, and nothing is created), linked to the email as created and filed on its conversation. The fields are create_task's; source_note says why, in your words. Your rules apply as on create_task: if new tasks need approval you get a task suggestion (needs_approval: true, the email's message_id in its metadata) and nothing is linked yet; if finished work goes to review, a done task starts In Review. Left out, project_id and assignee_ids come from the email's inbox defaults (its message's inbox.default_project_id and default_assignee_ids); what you send always wins. Needs tasks.create and inbound_email.triage. To link a task that already exists, use links on record_email_triage or a link_task plan item.",
    input: z.object({
      message_id: id('message_id'),
      project_id: id('project_id').optional().describe("Default: the inbox's default project; required when it has none"),
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
      source_note: z.string().min(1).max(200).optional().describe("Why you made it, such as from Dana's email; shown on the task"),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'tasks.create',
    requires: ['inbound_email.triage'],
    module: 'inbox',
    method: 'POST',
    path: '/api/v1/inbox/messages/{id}/tasks',
    request: ({ message_id, ...body }) => ({ params: { id: message_id }, body }),
  }),
  routeTool({
    name: 'label_email_attachment',
    lead: 'Set the display label on an email attachment.',
    detail: 'One line (at most 200 characters) saying what the file is, shown in the Inbox; null clears it. Changes nothing else.',
    input: z.object({ message_id: id('message_id'), attachment_id: id('attachment_id'), agent_label: z.string().min(1).max(200).nullable() }).strict(),
    permission: 'inbound_email.triage',
    method: 'PATCH',
    path: '/api/v1/inbox/messages/{id}/attachments/{aid}',
    destructive: false,
    request: ({ message_id, attachment_id, agent_label }) => ({ params: { id: message_id, aid: attachment_id }, body: { agent_label } }),
  }),
  routeTool({
    name: 'list_inbox_questions',
    lead: 'List questions you asked that still wait on a person.',
    detail: "Across your inboxes (or inbox_id), oldest first: each email's sender, subject, project, the question and when it was asked. A person answering it in the Inbox, or marking the thread handled, takes it off.",
    input: z.object({ inbox_id: id('inbox_id').optional() }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/questions',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'list_reply_drafts',
    lead: 'List reply drafts people asked you to write.',
    detail: 'In your inboxes (or inbox_id; handled me: only the ones you handle), up to 50. status requested (default, waiting on you, oldest first), ready or failed (newest first). Each names the email to answer (message_id) and what the person wants said (instructions). Read the email with get_email, then answer with write_reply_draft.',
    input: z.object({ status: z.enum(['requested', 'ready', 'failed']).optional(), inbox_id: id('inbox_id').optional(), handled: z.enum(['me']).optional().describe('me: only the inboxes you handle, as yourself or through a group'), }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/reply-drafts',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'write_reply_draft',
    lead: 'Write a reply draft a person asked for.',
    detail: 'Send body (the reply text) or failure (why you could not write one), not both. Only a waiting request takes an answer (409 draft_answered otherwise). The person copies it into their own mail: nothing is sent.',
    input: z.object({
      draft_id: id('draft_id'),
      body: z.string().min(1).max(20_000).optional(),
      failure: z.string().min(1).max(500).optional(),
    }).strict().refine((value) => (value.body === undefined) !== (value.failure === undefined), 'Send the draft as body, or why there is none as failure'),
    permission: 'inbound_email.triage',
    method: 'PUT',
    path: '/api/v1/inbox/reply-drafts/{id}',
    destructive: false,
    request: ({ draft_id, ...body }) => ({ params: { id: draft_id }, body }),
  }),
  routeTool({
    name: 'list_sender_rules',
    lead: 'List the live sender rules that sort arriving mail.',
    detail: "Each: what it matches (an address or a domain), its topic, its action (ignore, fyi or always), who made it (person or agent), why, and a plain label. A rule for one inbox also has scope inbox and its inbox_id. inbox_id: only the rules that sort that inbox's mail (the workspace's and its own).",
    input: z.object({ inbox_id: id('inbox_id').optional() }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/sender-rules',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'list_inbox_senders',
    lead: 'List who sends mail to your inboxes, busiest first.',
    detail: "The patterns behind sender rules, over the last days (default 30, at most 90), in your inboxes (or inbox_id: that inbox's mail and the rules that sort it): per sender, how many emails, their kinds, topics and sorting actions, the latest triage outcomes, how many tasks they led to, and the live rules covering them. Up to 200 senders.",
    input: z.object({ days: z.number().int().min(1).max(90).optional(), inbox_id: id('inbox_id').optional() }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/senders',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'add_sender_rule',
    lead: 'Add a sender rule from a pattern you saw.',
    detail:
      "For mail that arrives from now on. Name the one topic it covers, so the sender's other mail still reaches triage, and say in reason what pattern it is based on. Never money, account_risk or security (422). It replaces your own rule for the same sender and topic (in either scope), and never overlaps a person's rule, live or switched off (409 person_rule). scope inbox with inbox_id makes it sort only that inbox's mail; left out, it is for the workspace. Look at list_inbox_senders first.",
    input: z.object({
      match_kind: z.enum(['address', 'domain']),
      match_value: z.string().min(3).max(320).describe('An address such as alerts@tool.com, or a domain such as tool.com'),
      topic: z.enum(MAIL_TOPICS),
      action: z.enum(RULE_ACTIONS).describe('ignore: Filtered; fyi: kept as an update; always: always triaged'),
      reason: z.string().min(10).max(500).describe('A sentence on the pattern this rule is based on'),
      scope: z.enum(['workspace', 'inbox']).optional().describe('workspace: every inbox; inbox: only inbox_id'),
      inbox_id: id('inbox_id').optional().describe('The inbox a scope inbox rule is for, one you triage'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'inbound_email.triage',
    method: 'POST',
    path: '/api/v1/inbox/sender-rules',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'list_unsummarized_triage',
    lead: 'List triage not yet included in a summary.',
    detail: 'For a batched summary: the newest triage of each email from the last 14 days that drove an outcome (a task, a reminder, a reply owed or a question) and was not summarized yet, oldest first, with sender, subject, routing, projects and linked tasks (no bodies), in your inboxes (or inbox_id). After you send the summary, mark_triage_summarized with their ids.',
    input: z.object({ inbox_id: id('inbox_id').optional() }).strict(),
    permission: 'inbound_email.read',
    deprecated: { replacement: 'the answer from submit_triage_plan (each item and its decision): summarize as you plan', removal: PLANS_CUTOVER_REMOVAL },
    method: 'GET',
    path: '/api/v1/inbox/triage/unsummarized',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'mark_triage_summarized',
    lead: 'Mark triage as included in a summary.',
    detail: 'Also clears older unsummarized triage of the same emails (superseded_triage_ids). All or nothing: an id outside your inboxes marks nothing and is listed (404).',
    input: z.object({ triage_ids: z.array(id('triage_ids')).min(1).max(500) }).strict(),
    permission: 'inbound_email.triage',
    deprecated: { replacement: 'the answer from submit_triage_plan (each item and its decision): summarize as you plan', removal: PLANS_CUTOVER_REMOVAL },
    method: 'POST',
    path: '/api/v1/inbox/triage/mark-summarized',
    idempotent: true,
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'get_inbox_signal',
    lead: 'Check for new mail and inbox work waiting.',
    detail: 'Counts for a cheap poll across your inboxes (or inbox_id; handled me: only the ones you handle): new_count and newest_received_at (for the older triage), plans_new_count and plans_newest_received_at (ready to plan), plans_newest_queued_at (the newest time anything ready joined the queue, an old message sent back or answered included: wake on it), shadow_pending_count, unsummarized_count, drafts_requested and waiting_count (questions waiting on a person). Needs inbound_email.signal.',
    input: z.object({ inbox_id: id('inbox_id').optional(), handled: z.enum(['me']).optional().describe('me: only the inboxes you handle, as yourself or through a group'), }).strict(),
    permission: 'inbound_email.signal',
    method: 'GET',
    path: '/api/v1/inbox/signal',
    request: (args) => ({ query: args }),
  }),
];
