import { z } from 'zod';
import { idempotencyKeyInput, routeTool, type PmTool } from '../core';
import { INBOX_TABS } from '@/lib/communications/inbox-types';
import { ANSWER_MAX } from '@/lib/communications/inbox-decisions';
import { RULE_ACTIONS } from '@/lib/communications/sorting';
import { atLeastOne, id } from './shared';

/**
 * A conversation's emails, bounded for a tool answer: the HTML part is left
 * out wherever the text part has the words, and long text is cut and
 * flagged (*_truncated), as get_email bounds one email.
 */
const THREAD_TEXT_MAX = 8000;
type Row = Record<string, unknown>;

function boundedThread(data: unknown) {
  if (!data || typeof data !== 'object') return data;
  const thread = data as Row;
  const messages = Array.isArray(thread.messages) ? (thread.messages as Row[]) : [];
  const cut = (row: Row, field: string): Row => {
    const value = row[field];
    return typeof value === 'string' && value.length > THREAD_TEXT_MAX
      ? { ...row, [field]: value.slice(0, THREAD_TEXT_MAX), [`${field}_truncated`]: true }
      : row;
  };
  return {
    ...thread,
    messages: messages.map((message) => {
      const hasText = [message.new_text, message.text_body].some((value) => typeof value === 'string' && value.trim() !== '');
      let out: Row = hasText && message.html_body != null ? { ...message, html_body: null, html_body_omitted: true } : message;
      for (const field of ['new_text', 'text_body', 'html_body']) out = cut(out, field);
      return out;
    }),
  };
}

const threadId = id('thread_id').describe('The conversation, from list_inbox_threads');
const PERSON_ONLY = 'Your own decision as a person: only your own key or connected AI tool, never an agent.';

/** Inbox setup, rules and a person's decisions. */
export const INBOX_TOOLS: PmTool[] = [
  // Sender rules
  routeTool({
    name: 'update_sender_rule',
    lead: 'Change what a sender rule does, or switch it off.',
    detail: "action ignore (Filtered), fyi (kept as an update) or always (always triaged); enabled false switches it off, true back on (409 when another rule now covers the same sender). Rules are never deleted. A person needs to manage inboxes, and changing a rule's action makes it theirs. An agent changes only agents' rules, never a person's or one a person switched off (409 person_rule). Rule ids come from list_sender_rules.",
    input: z.object({
      rule_id: id('rule_id'),
      action: z.enum(RULE_ACTIONS).optional(),
      enabled: z.boolean().optional(),
    }).strict().refine(atLeastOne(['action', 'enabled']), 'Send action, enabled or both'),
    permission: 'inbound_email.triage',
    method: 'PATCH',
    path: '/api/v1/inbox/sender-rules/{id}',
    destructive: false,
    request: ({ rule_id, ...body }) => ({ params: { id: rule_id }, body }),
  }),

  // Conversations
  routeTool({
    name: 'list_inbox_threads',
    lead: 'List Inbox conversations, newest activity first.',
    detail: "The Inbox's own list, by conversation rather than by email (list_inbox lists emails): each with its state, flags, projects and newest email, plus every tab's count. status is the tab: all (default), fyi, updates, codes, ignored (Filtered), everything, or the filters needs_you, needs_reply, new, handled, unassigned. inbox_id, project_id, task_id and q narrow it; limit 1-200 (default 50) and offset page it. Only the inboxes your key's member reads.",
    input: z.object({
      status: z.enum(INBOX_TABS).optional(),
      inbox_id: id('inbox_id').optional(),
      project_id: id('project_id').optional(),
      task_id: id('task_id').optional(),
      q: z.string().min(1).max(200).optional().describe('Search sender, subject and text'),
      limit: z.number().int().min(1).max(200).optional().describe('1-200, default 50'),
      offset: z.number().int().min(0).optional(),
    }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/threads',
    request: (query) => ({ query }),
  }),
  routeTool({
    name: 'get_inbox_thread',
    lead: 'Read one Inbox conversation as the app shows it.',
    detail: "Every email, oldest first, with what the agent made of each (triage, plans and their items with ids, replies owed), attachments, linked tasks, the projects it is filed on, can_triage (whether you may act on it) and its newest reply draft. Bounded: the HTML part is left out where the text has the words, and long text is cut (*_truncated). A conversation in an inbox you cannot read is 404.",
    input: z.object({ thread_id: threadId }).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/threads/{threadId}',
    request: ({ thread_id }) => ({ params: { threadId: thread_id } }),
    present: boundedThread,
  }),
  routeTool({
    name: 'get_inbox_count',
    lead: 'Count Inbox conversations waiting on a person.',
    detail: "The Inbox badge: needs_attention (the total), then urgent, decide and reply, across every inbox your key's member reads.",
    input: z.object({}).strict(),
    permission: 'inbound_email.read',
    method: 'GET',
    path: '/api/v1/inbox/count',
    request: () => ({}),
  }),

  // A person's decisions on a conversation
  routeTool({
    name: 'mark_inbox_thread_handled',
    lead: 'Mark an Inbox conversation handled.',
    detail: `What waited on the agent or on a person becomes handled, every email counts as reviewed, and your own open "Reply to" reminders from it close. Nothing is sent. ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/handled',
    idempotent: true,
    request: ({ thread_id }) => ({ params: { threadId: thread_id } }),
  }),
  routeTool({
    name: 'send_inbox_thread_to_agent',
    lead: 'Send an email back to the agent to plan again.',
    detail: `The email (message_id; the conversation's newest by default) is New again and the agent plans it from the conversation as it is now. What its earlier plans still waited on settles as superseded. 409 when it already waits for the agent. ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId, message_id: id('message_id').optional() }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/send-back',
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),
  routeTool({
    name: 'move_email_to_inbox',
    lead: 'Move a filtered email back to the Inbox.',
    detail: `For a pitch the agent filtered that was not one: the email is New and read in full, and if you manage inboxes its sender is always read in full from now on (a rule for that exact address, answered as rule). 409 when it is not filtered. ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId, message_id: id('message_id') }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/move-to-inbox',
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),
  routeTool({
    name: 'answer_inbox_question',
    lead: "Answer the agent's question on an email.",
    detail: `The decision card's answer, in your words (or the option you pick): kept with the email, which goes back to the agent to act on. message_id: the email asking (the newest one asking by default). 404 when nothing asks. ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId, message_id: id('message_id').optional(), answer: z.string().trim().min(1).max(ANSWER_MAX) }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/answer',
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),
  routeTool({
    name: 'request_reply_draft',
    lead: 'Ask the agent to draft a reply to a conversation.',
    detail: `Against its newest email, with instructions on what to say (optional). One request waits per conversation: asking again while one waits answers that one. On a personal inbox with no agent of its own, your assistant writes it. 409 when nobody can (no agent or assistant, or Sort my inbox off), or the writer has Draft replies off. You copy the draft into your own mail: nothing is sent. ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId, instructions: z.string().trim().max(2000).optional(), idempotency_key: idempotencyKeyInput }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/draft',
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),
  routeTool({
    name: 'mark_reply_draft_copied',
    lead: 'Mark a reply draft as copied into your mail.',
    detail: `For a written draft (409 otherwise); the first copy is the one kept. Nothing is sent. ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId, draft_id: id('draft_id') }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/draft/copied',
    idempotent: true,
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),
  routeTool({
    name: 'undo_agent_work',
    lead: 'Undo everything the agent did with a conversation.',
    detail: `Undo all: with message_ids, only those emails; with task_id, only the agent's links to that task. A live plan is undone through its items (a task changed since stays); an older triage's tasks and reminders go to Trash and its links are removed. Answers the receipt (plan_items, tasks, reminders, links, kept) that restore_agent_work takes. ${PERSON_ONLY}`,
    input: z.object({
      thread_id: threadId,
      message_ids: z.array(id('message_ids')).min(1).max(200).optional(),
      task_id: id('task_id').optional(),
    }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/agent-work',
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),
  routeTool({
    name: 'restore_agent_work',
    lead: 'Put back what undo_agent_work took back.',
    detail: `Send the receipt undo_agent_work answered, as it came. Only what belongs to this conversation comes back; what cannot is listed in kept. ${PERSON_ONLY}`,
    input: z.object({
      thread_id: threadId,
      plan_items: z.array(id('plan_items')).max(500),
      tasks: z.array(id('tasks')).max(500),
      reminders: z.array(id('reminders')).max(500),
      links: z.array(z.object({
        message_id: id('message_id'),
        task_id: id('task_id'),
        relation: z.enum(['created', 'updated', 'related']),
        triage_id: id('triage_id').nullable(),
        linked_by: id('linked_by').nullable(),
      }).strict()).max(500),
      kept: z.array(z.unknown()).max(500).optional(),
    }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/agent-work/restore',
    idempotent: true,
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),

  // A meeting's suggestions
  routeTool({
    name: 'add_all_meeting_suggestions',
    lead: "Accept every waiting suggestion of a meeting.",
    detail: `Add all: each is applied as yours through the usual accept; questions are left for an answer. A second call adds nothing twice. Undo is per item (undo_plan_item). Meetings only (422 for email). ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/add-all',
    idempotent: true,
    request: ({ thread_id }) => ({ params: { threadId: thread_id } }),
  }),
  routeTool({
    name: 'mark_meeting_nothing_to_do',
    lead: 'Say a meeting needs no new work.',
    detail: `Nothing to do: its waiting suggestions and questions are skipped, its messages handled and reviewed, and who said so recorded. Nothing is created or trashed. Answers the receipt (undo) that undo_meeting_nothing_to_do takes. Meetings only. ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/nothing-to-do',
    request: ({ thread_id }) => ({ params: { threadId: thread_id } }),
  }),
  routeTool({
    name: 'undo_meeting_nothing_to_do',
    lead: "Undo a meeting's Nothing to do.",
    detail: `Send the undo receipt mark_meeting_nothing_to_do answered (skipped and handled): the suggestions wait again, the messages go back as they were, and the mark clears. Only what is still as it left it. ${PERSON_ONLY}`,
    input: z.object({
      thread_id: threadId,
      skipped: z.array(id('skipped')).max(500),
      handled: z.array(z.object({
        id: id('id'),
        status: z.enum(['new', 'needs_human', 'handled']),
        unreviewed: z.boolean(),
      }).strict()).max(500),
    }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/nothing-to-do/undo',
    idempotent: true,
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),

  // The agent's plans
  routeTool({
    name: 'accept_plan_item',
    lead: "Accept the agent's proposal, as yours.",
    detail: `A plan item waiting for an OK (its id from get_inbox_thread), applied as yours. Change its project_id, task_id, title or due_date (YYYY-MM-DD, or null) as you accept. 409 when it no longer waits. ${PERSON_ONLY}`,
    input: z.object({
      item_id: id('item_id'),
      project_id: id('project_id').optional(),
      task_id: id('task_id').optional(),
      title: z.string().trim().min(1).max(500).optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/plan-items/{id}/accept',
    request: ({ item_id, ...body }) => ({ params: { id: item_id }, body }),
  }),
  routeTool({
    name: 'dismiss_plan_item',
    lead: "Turn down the agent's proposal.",
    detail: `The plan item is skipped; restore_plan_item makes it wait again. ${PERSON_ONLY}`,
    input: z.object({ item_id: id('item_id') }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/plan-items/{id}/dismiss',
    request: ({ item_id }) => ({ params: { id: item_id } }),
  }),
  routeTool({
    name: 'undo_plan_item',
    lead: 'Undo one thing the agent did.',
    detail: `An applied plan item is taken back: a task it made goes to Trash (Not a task), a reminder it set goes to Trash, a link is removed. A task changed since is left alone and reported (changed_since). restore_plan_item takes it back. ${PERSON_ONLY}`,
    input: z.object({ item_id: id('item_id') }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/plan-items/{id}/undo',
    request: ({ item_id }) => ({ params: { id: item_id } }),
  }),
  routeTool({
    name: 'restore_plan_item',
    lead: 'Take back an undo or a skip of a plan item.',
    detail: `An undone item's work comes back; a skipped suggestion waits again. 409 when it cannot. ${PERSON_ONLY}`,
    input: z.object({ item_id: id('item_id') }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/plan-items/{id}/restore',
    request: ({ item_id }) => ({ params: { id: item_id } }),
  }),
  routeTool({
    name: 'undo_triage_plan',
    lead: 'Undo everything the agent did with one email.',
    detail: `Every applied item of the email's live plan (its id from get_inbox_thread) is undone, as undo_plan_item does each. ${PERSON_ONLY}`,
    input: z.object({ plan_id: id('plan_id') }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/plans/{id}/undo',
    request: ({ plan_id }) => ({ params: { id: plan_id } }),
  }),
  routeTool({
    name: 'resolve_reply_owed',
    lead: 'Mark a reply owed as done.',
    detail: `A reply the agent noted is owed on a conversation (its id from get_inbox_thread) is done. ${PERSON_ONLY}`,
    input: z.object({ reply_point_id: id('reply_point_id') }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/reply-points/{id}/resolve',
    idempotent: true,
    request: ({ reply_point_id }) => ({ params: { id: reply_point_id } }),
  }),

  // Filing and links
  routeTool({
    name: 'add_inbox_thread_project',
    lead: 'File an Inbox conversation on a project.',
    detail: `Beside its other projects (or confirming one the agent guessed), as yours. remember_sender (an address that wrote in this conversation, needs contacts.manage) or remember_domain maps future mail to the projects you name. ${PERSON_ONLY} Agents file through submit_triage_plan.`,
    input: z.object({
      thread_id: threadId,
      project_id: id('project_id'),
      remember_sender: z.object({ address: z.string().trim().min(3).max(320), project_ids: z.array(id('project_ids')).min(1).max(20) }).strict().optional(),
      remember_domain: z.object({ domain: z.string().trim().min(3).max(253), project_ids: z.array(id('project_ids')).min(1).max(20) }).strict().optional(),
    }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/projects',
    idempotent: true,
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),
  routeTool({
    name: 'remove_inbox_thread_project',
    lead: 'Take a project off an Inbox conversation.',
    detail: `409 while one of its emails is linked to a task on that project: unlink or move the task first. ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId, project_id: id('project_id') }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'DELETE',
    path: '/api/v1/inbox/threads/{threadId}/projects/{projectId}',
    request: ({ thread_id, project_id }) => ({ params: { threadId: thread_id, projectId: project_id } }),
  }),
  routeTool({
    name: 'link_inbox_thread_task',
    lead: 'Link an Inbox conversation to a task.',
    detail: `Its newest email (or message_id) is tied to the task, as yours; relation related (default: about the task, asks no change), updated or created. The conversation is filed on the task's project too (project_set). ${PERSON_ONLY} Agents link through submit_triage_plan.`,
    input: z.object({
      thread_id: threadId,
      task_id: id('task_id'),
      relation: z.enum(['created', 'updated', 'related']).optional(),
      message_id: id('message_id').optional(),
    }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'POST',
    path: '/api/v1/inbox/threads/{threadId}/links',
    idempotent: true,
    request: ({ thread_id, ...body }) => ({ params: { threadId: thread_id }, body }),
  }),
  routeTool({
    name: 'unlink_inbox_thread_task',
    lead: 'Unlink an Inbox conversation from a task.',
    detail: `Every link between its emails and the task goes, whoever made it. The task stays. ${PERSON_ONLY}`,
    input: z.object({ thread_id: threadId, task_id: id('task_id') }).strict(),
    permission: 'inbound_email.triage',
    peopleOnly: true,
    method: 'DELETE',
    path: '/api/v1/inbox/threads/{threadId}/links',
    request: ({ thread_id, task_id }) => ({ params: { threadId: thread_id }, query: { task_id } }),
  }),
];
