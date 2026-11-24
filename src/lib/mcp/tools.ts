import { z } from 'zod';
import { AGENT_EVENT_SCHEMAS, AGENT_EVENT_TYPES, isServerEvent, isTelemetryEvent, type AgentEventType } from '@/lib/agent-events';
import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { WEBHOOK_EVENT_TYPES } from '@/lib/types';
import { idempotencyKeyInput, routeTool, type PmTool } from './core';
import { AGENT_PROFILE_VALUES, type AgentProfile } from './profiles';

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
 * approval, team writes other than setting up an agent, every delete (move to Trash) but a
 * webhook endpoint's, the unscoped app activity feed, suggestion approve/decline, and the fleet
 * publisher's agent health (an agent reports its own with heartbeat).
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
const EFFORT = z.enum(['small', 'medium', 'large']);
const API_SCOPE = z.enum(API_ENDPOINT_PERMISSIONS);
const WEBHOOK_EVENT = z.enum(WEBHOOK_EVENT_TYPES);
const AGENT_PROFILE = z.enum(AGENT_PROFILE_VALUES as [AgentProfile, ...AgentProfile[]]);
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
      idempotency_key: idempotencyKeyInput,
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
    detail: `Includes its parent (for a subtask), its subtasks (each a task with status and assignees), acceptance criteria, blockers, dependencies_met (false unless every blocker is done) and the newest ${TASK_COMMENTS_SHOWN} comments; list_task_comments has older ones. Very long text is cut and flagged.`,
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
      'One call before you start: the task (acceptance criteria, subtasks, blockers and dependencies_met), its project and the project\'s active context entries, the newest 10 comments, its files and links, the open question if it is waiting on someone, who holds the claim, and your own rules (self_assign, close_policy, create_policy, escalate_to). Long text is cut and flagged; parts your key cannot read are listed in omitted.',
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
      'Send only what changes. acceptance_criteria REPLACES every criterion and clears their satisfied flags; use add_acceptance_criterion or update_acceptance_criterion for one. Changing assignees or project needs tasks.manage_all. If your rules send finished work to review, status done moves it to in_review instead (sent_to_review: true). Answers with the bare task row.',
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
      'Goes to the workspace owner. Pass the entity_id of what it is about to avoid duplicate unread notifications for the same thing. For a question you need answered, use ask_human instead: the answer comes back to you.',
    input: z.object({
      title: z.string().min(1).max(200),
      message: z.string().min(1).max(5000),
      link: z.string().min(1).max(2000).nullable().optional(),
      entity_type: z.enum(['task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question']).optional(),
      entity_id: id('entity_id').nullable().optional(),
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
      "For when you are stuck on something only a person can decide: never guess. Put it on the task (task_id) or project (project_id) it is about, or neither. asked_to defaults to whoever your rules escalate to, else the Owner. choices (1 to 10 short strings) become buttons; allow_other (default true) also lets them answer in their own words. expires_at (ISO time) closes it unanswered after that. Their bell rings and a task with an open question reads as waiting on them. Answers with the question (status open): poll get_question until status is answered, then act on answer_choice and answer_text.",
    input: z.object({
      question: z.string().min(1).max(2000).describe('The question, with the context the person needs to answer it'),
      task_id: id('task_id').optional(),
      project_id: id('project_id').optional(),
      asked_to: id('asked_to').optional().describe('Team member to ask; default your escalation target or the Owner'),
      choices: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
      allow_other: z.boolean().optional(),
      expires_at: z.string().min(1).max(40).optional().describe('ISO 8601 time after which the question closes as expired'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'tasks.read',
    method: 'POST',
    path: '/api/v1/questions',
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'get_question',
    lead: 'Read one question and its answer, if there is one.',
    detail: 'status is open, answered, cancelled or expired (an open question past expires_at reads as expired). Once answered: answer_choice, answer_text, answered_by_name, answered_at. Poll it after ask_human, a few minutes apart.',
    input: z.object({ question_id: id('question_id') }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/questions/{id}',
    request: ({ question_id }) => ({ params: { id: question_id } }),
  }),
  routeTool({
    name: 'list_questions',
    lead: 'List questions you asked, were asked, or can see.',
    detail: 'Newest first. status open, answered, cancelled, expired or all (default all); asked_by me and asked_to me for your own; task_id or project_id for one place. Questions asked to you with can_answer true are yours to answer with answer_question.',
    input: z.object({
      status: z.enum(['open', 'answered', 'cancelled', 'expired', 'all']).optional(),
      asked_by: z.union([z.literal('me'), id('asked_by')]).optional(),
      asked_to: z.union([z.literal('me'), id('asked_to')]).optional(),
      task_id: id('task_id').optional(),
      project_id: id('project_id').optional(),
      page,
      limit: limit(20),
    }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/questions',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'answer_question',
    lead: 'Answer a question you were asked.',
    detail: 'Send choice (one of its choices), text, or both. Without choices, text is the answer; with choices and allow_other false, a choice is required. Only the member asked, the Owner, or a member who may manage the team can answer. 409 when it is already answered, cancelled or expired.',
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
    permission: 'tasks.read',
    method: 'POST',
    path: '/api/v1/questions/{id}/cancel',
    destructive: true,
    idempotent: false,
    request: ({ question_id }) => ({ params: { id: question_id } }),
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
    name: 'set_agent_rules',
    lead: 'Set what an agent may do on its own.',
    detail:
      "Needs team.manage; for agent members only. agent_self_assign: may pick up unassigned work. agent_close_policy: close (done finishes a task) or review (done moves it to in_review). agent_create_policy: live (new tasks go live) or approval (they become task suggestions). agent_escalate_to: a member id, or null for the Owner. Send only what changes; answers with the member.",
    input: z.object({
      agent_id: id('agent_id'),
      agent_self_assign: z.boolean().optional(),
      agent_close_policy: z.enum(['close', 'review']).optional(),
      agent_create_policy: z.enum(['live', 'approval']).optional(),
      agent_escalate_to: id('agent_escalate_to').nullable().optional(),
    }).strict().refine(
      atLeastOne(['agent_self_assign', 'agent_close_policy', 'agent_create_policy', 'agent_escalate_to']),
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
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'team.manage',
    module: 'agents',
    method: 'POST',
    path: '/api/v1/agents',
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
    name: 'list_webhook_endpoints',
    lead: 'List webhook endpoints, never their secrets.',
    detail: 'Needs webhooks.manage. member_id narrows to endpoints filtered to that member; active to the ones on or off.',
    input: z.object({ member_id: id('member_id').optional(), active: z.boolean().optional() }).strict(),
    permission: 'webhooks.manage',
    method: 'GET',
    path: '/api/v1/webhook-endpoints',
    request: (args) => ({ query: args }),
  }),
  routeTool({
    name: 'create_webhook_endpoint',
    lead: 'Add a webhook endpoint; its secret shows once.',
    detail:
      "Needs webhooks.manage. url is HTTPS (http only on localhost). events: what to send (invoice events need Client invoicing). project_ids limits it to those projects; member_id to events that concern that member, such as an agent's own work, which is how an agent's harness gets woken. The answer's secret signs every delivery and is the only copy: put it in the receiver now. No idempotency_key: on a timeout, list_webhook_endpoints before trying again.",
    input: z.object({
      name: z.string().min(1).max(100),
      url: z.string().min(1).max(2000),
      events: z.array(WEBHOOK_EVENT).min(1),
      description: z.string().max(500).optional(),
      amount_basis: z.enum(['gross', 'net']).optional(),
      project_ids: z.array(id('project_ids')).max(200).nullable().optional(),
      member_id: id('member_id').nullable().optional(),
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
    detail: 'Needs webhooks.manage. Send only what changes. is_active false pauses deliveries; project_ids or member_id null removes that filter. The secret never changes.',
    input: z.object({
      endpoint_id: id('endpoint_id'),
      name: z.string().min(1).max(100).optional(),
      url: z.string().min(1).max(2000).optional(),
      events: z.array(WEBHOOK_EVENT).min(1).optional(),
      description: z.string().max(500).optional(),
      amount_basis: z.enum(['gross', 'net']).optional(),
      project_ids: z.array(id('project_ids')).max(200).nullable().optional(),
      member_id: id('member_id').nullable().optional(),
      is_active: z.boolean().optional(),
    }).strict().refine(
      atLeastOne(['name', 'url', 'events', 'description', 'amount_basis', 'project_ids', 'member_id', 'is_active']),
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
      "Core's (data-health-watcher, inbox-triage while the Inbox is on, builder, weekly-reporter) and this workspace's own. Each: the rules it sets, the scopes a key for it should carry, the brief added to the agent's context pack, and suggested webhook events. Apply one with apply_agent_template.",
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
];
