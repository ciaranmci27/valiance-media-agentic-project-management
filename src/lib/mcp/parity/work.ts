import { z } from 'zod';
import { AGENT_LABELS_MAX, agentLabelSchema } from '@/lib/agent-events';
import { routeTool, type PmTool } from '../core';
import { atLeastOne, id } from './shared';

const labelList = z.array(agentLabelSchema).min(1).max(AGENT_LABELS_MAX * 4);

/** The smaller task, group, agent and time actions the app has (the audit's low rows). */
export const WORK_TOOLS: PmTool[] = [
  // Tasks
  routeTool({
    name: 'reorder_task',
    lead: 'Move a task to a new place in its board column.',
    detail: 'new_sort_order is its position from 0 among the tasks in the same project and status, as dragging on the board does; the others shift to make room. Needs tasks.manage_all.',
    input: z.object({ task_id: id('task_id'), new_sort_order: z.number().int().min(0) }).strict(),
    permission: 'tasks.manage_all',
    method: 'POST',
    path: '/api/v1/tasks/reorder',
    idempotent: true,
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'reorder_subtasks',
    lead: "Put a task's subtasks in a new order.",
    detail: 'subtask_ids in the order they should show, every subtask of the task. On a task assigned to you, or any with tasks.manage_all.',
    input: z.object({ task_id: id('task_id'), subtask_ids: z.array(id('subtask_ids')).min(1).max(500) }).strict(),
    permission: 'tasks.manage_assigned',
    method: 'PUT',
    path: '/api/v1/tasks/{id}/subtasks/reorder',
    destructive: false,
    request: ({ task_id, subtask_ids }) => ({ params: { id: task_id }, body: { subtask_ids } }),
  }),
  routeTool({
    name: 'update_task_comment',
    lead: 'Edit a comment you wrote on a task.',
    detail: 'Your own comment, or anyone\'s with tasks.manage_all. text replaces it.',
    input: z.object({ task_id: id('task_id'), comment_id: id('comment_id'), text: z.string().min(1).max(10_000) }).strict(),
    permission: 'tasks.read',
    method: 'PATCH',
    path: '/api/v1/tasks/{id}/comments/{commentId}',
    request: ({ task_id, comment_id, text }) => ({ params: { id: task_id, commentId: comment_id }, body: { text } }),
  }),
  routeTool({
    name: 'update_task_file',
    lead: 'Rename a task file or change its note.',
    detail: 'name, or note (null clears it). A file you added, or any with files.manage.',
    input: z.object({
      task_id: id('task_id'),
      file_id: id('file_id'),
      name: z.string().min(1).max(500).optional(),
      note: z.string().max(2000).nullable().optional(),
    }).strict().refine(atLeastOne(['name', 'note']), 'Send name or note'),
    permission: ['files.upload', 'files.manage'],
    method: 'PATCH',
    path: '/api/v1/tasks/{id}/files/{fileId}',
    request: ({ task_id, file_id, ...body }) => ({ params: { id: task_id, fileId: file_id }, body }),
  }),
  routeTool({
    name: 'list_task_source_emails',
    lead: 'List the emails a task was made from or linked to.',
    detail: 'Only emails in inboxes you may read; each with its message id, conversation, sender, subject and how it is linked. Read one with get_email.',
    input: z.object({ task_id: id('task_id') }).strict(),
    permission: 'inbound_email.read',
    module: 'inbox',
    method: 'GET',
    path: '/api/v1/tasks/{id}/messages',
    request: ({ task_id }) => ({ params: { id: task_id } }),
  }),
  routeTool({
    name: 'get_task_repeat',
    lead: 'Read how a task repeats, if it does.',
    detail: 'The repeat rule (every so many days, weeks or months, on which days), when the next copy is made, and whether it is paused. null when it does not repeat. Change it with set_task_repeat.',
    input: z.object({ task_id: id('task_id') }).strict(),
    permission: 'tasks.read',
    method: 'GET',
    path: '/api/v1/tasks/{id}/repeat',
    request: ({ task_id }) => ({ params: { id: task_id } }),
  }),

  // Groups
  routeTool({
    name: 'set_group_member_role',
    lead: "Change someone's role in a group: member or lead.",
    detail: 'A lead is asked first and escalated to. Needs groups.manage.',
    input: z.object({ group_id: id('group_id'), member_id: id('member_id'), role: z.enum(['member', 'lead']) }).strict(),
    permission: 'groups.manage',
    method: 'PATCH',
    path: '/api/v1/groups/{id}/members/{memberId}',
    request: ({ group_id, member_id, role }) => ({ params: { id: group_id, memberId: member_id }, body: { role } }),
  }),

  // Agents
  routeTool({
    name: 'list_agent_roles',
    lead: 'List the roles an agent can be hired into.',
    detail: 'Each role value with its plain label and what it is for, the ones in use first. Pass a value as agent_role on hire_agent or update_agent.',
    input: z.object({}).strict(),
    permission: 'team.read',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/agents/roles',
    request: () => ({}),
  }),
  routeTool({
    name: 'label_agent_activity',
    lead: 'Add or remove labels on an agent activity.',
    detail: 'add and remove are lists of short labels (lowercase words joined by dashes); the analytics view filters by them. Your own activity with agent_activity.write, any agent\'s with agents.manage.',
    input: z.object({ activity_id: id('activity_id'), add: labelList.optional(), remove: labelList.optional() }).strict()
      .refine(atLeastOne(['add', 'remove']), 'Send add or remove'),
    permission: ['agent_activity.write', 'agents.manage'],
    method: 'POST',
    path: '/api/v1/agent-activities/{id}/labels',
    idempotent: true,
    request: ({ activity_id, ...body }) => ({ params: { id: activity_id }, body }),
  }),

  // Time
  routeTool({
    name: 'update_time_entry',
    lead: 'Edit a time entry: times, description, work type, tasks.',
    detail: 'start_time and end_time (ISO times), description, work_type client or internal, and task_ids (replaces the linked tasks). Your own entry while it is not approved, or anyone\'s with time.manage_all; approved or invoiced time is refused with the reason. Start and stop a timer with timer.',
    input: z.object({
      project_id: id('project_id'),
      entry_id: id('entry_id'),
      start_time: z.iso.datetime({ offset: true }).optional(),
      end_time: z.iso.datetime({ offset: true }).nullable().optional(),
      description: z.string().max(5000).optional(),
      work_type: z.enum(['client', 'internal']).optional(),
      task_ids: z.array(id('task_ids')).max(50).optional(),
    }).strict().refine(atLeastOne(['start_time', 'end_time', 'description', 'work_type', 'task_ids']), 'Send something to change'),
    permission: ['time.manage_own', 'time.manage_all'],
    method: 'PATCH',
    path: '/api/v1/projects/{id}/time-entries/{entryId}',
    request: ({ project_id, entry_id, ...body }) => ({ params: { id: project_id, entryId: entry_id }, body }),
  }),
];
