import type { EndpointDoc } from '../docs-data';

const GROUP = 'Inbound Email';
const READ = ['inbound_email.read'];
/** A person's own decision (owner decision 2026-11-27): refused for agents, company or personal (403 people_only). */
const PERSON = ['inbound_email.triage (a person\'s own key or connected AI tool; agents are refused, 403 people_only)'];
const PERSON_NOTE = ' A person\'s own decision: their own key or connected AI tool acting as them; any agent, company or personal, is refused (403 people_only). Acting on a conversation needs it to be in an inbox the key\'s member triages (a shared one with inbound_email.triage, their own personal inbox, or one shared with them while they hold triage): 404 when unreadable, 403 when read only.';
const threadParam = { name: 'threadId', type: 'uuid', required: true, description: 'The conversation (thread), from GET /api/v1/inbox/threads' };
const itemParam = { name: 'id', type: 'uuid', required: true, description: 'The plan item, from GET /api/v1/inbox/threads/:threadId' };

/** Inbox setup, rules and a person's decisions. */
export const INBOX_ENDPOINTS: EndpointDoc[] = [
  // Sender rules
  {
    method: 'PATCH', path: '/api/v1/inbox/sender-rules/:id', group: GROUP, scopes: ['inbound_email.triage', 'a person also needs to manage inboxes (inbound_email.manage on the member)'],
    description: 'Change what a sender rule does, or switch it off or back on. Rules are never deleted. The app\'s rule (Inbox > Rules): a person needs to manage inboxes, and changing a rule\'s action makes it theirs (source person). An agent changes only agents\' rules, never a person\'s or one a person switched off (409 person_rule); a rule for one inbox only where it acts on that inbox, and a personal agent never the workspace\'s. Switching one back on while another rule covers the same sender, topic and scope is 409. Answers { rule }. MCP: update_sender_rule.',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The rule, from GET /api/v1/inbox/sender-rules' }],
    body: [
      { name: 'action', type: 'string', required: false, description: 'ignore (Filtered), fyi (kept as an update) or always (always triaged)' },
      { name: 'enabled', type: 'boolean', required: false, description: 'false switches it off, true back on' },
    ],
  },

  // Conversations
  {
    method: 'GET', path: '/api/v1/inbox/threads', group: GROUP, scopes: READ,
    description: 'Conversations (threads), as the Inbox lists them: newest activity first, from the inboxes the key\'s member reads (the same rule as the app, on the api channel). Answers { inboxes, threads, total, counts (per tab), latest_code, owners_read_personal }. The messages routes (/api/v1/inbox/messages) stay: these add the app\'s unit, a conversation with its state, flags and projects. MCP: list_inbox_threads.',
    queryParams: [
      { name: 'status', type: 'string', description: 'The tab: all (default), fyi, updates, codes, ignored, everything, needs_you, needs_reply, new, handled, unassigned' },
      { name: 'inbox_id', type: 'uuid', description: 'One inbox the key reads' },
      { name: 'project_id', type: 'uuid', description: 'Conversations filed on this project' },
      { name: 'task_id', type: 'uuid', description: 'Conversations linked to this task' },
      { name: 'q', type: 'string', description: 'Search, up to 200 characters' },
      { name: 'limit', type: 'number', description: '1-200, default 50' },
      { name: 'offset', type: 'number', description: 'From 0' },
    ],
  },
  {
    method: 'GET', path: '/api/v1/inbox/threads/:threadId', group: GROUP, scopes: READ,
    description: 'One conversation, as the Inbox shows it: every email oldest first with its triage, attachments and linked tasks, the projects it is filed on, its plans (items with ids), replies owed, can_triage (whether the key\'s member may act on it) and reply_draft (its newest). 404 for a conversation in an inbox the key cannot read. MCP: get_inbox_thread (bounded text).',
    params: [threadParam],
  },
  {
    method: 'GET', path: '/api/v1/inbox/count', group: GROUP, scopes: READ,
    description: 'The Inbox badge: conversations waiting on a person across every inbox the key\'s member reads. Answers { needs_attention, total, urgent, decide, reply }. MCP: get_inbox_count.',
  },

  // A person's decisions on a conversation
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/handled', group: GROUP, scopes: PERSON,
    description: `Mark handled: what waited on the agent or on a person becomes handled, every email counts as reviewed, and the person's own open "Reply to" reminders from it close. Nothing is sent. Answers { handled, reviewed, closed_reminders }.${PERSON_NOTE} MCP: mark_inbox_thread_handled.`,
    params: [threadParam],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/send-back', group: GROUP, scopes: PERSON,
    description: `Back to the agent: the email (the newest by default) is New again and the agent plans it again; what its earlier plans still waited on settles as superseded. 409 when it already waits. Answers { message_id, superseded }.${PERSON_NOTE} MCP: send_inbox_thread_to_agent.`,
    params: [threadParam],
    body: [{ name: 'message_id', type: 'uuid', required: false, description: 'The email; the newest by default' }],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/move-to-inbox', group: GROUP, scopes: PERSON,
    description: `Move to Inbox: a filtered email is New and read in full, and for a member who manages inboxes its sender is always read in full from now on (a rule for that exact address). 409 when it is not filtered. Answers { message_id, rule }.${PERSON_NOTE} MCP: move_email_to_inbox.`,
    params: [threadParam],
    body: [{ name: 'message_id', type: 'uuid', required: true, description: 'The filtered email' }],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/answer', group: GROUP, scopes: PERSON,
    description: `Answer the agent's question (a decision card): the answer is kept with the email, which goes back to the agent. 404 when nothing asks; 409 when it already waits for the agent. Answers { message_id }.${PERSON_NOTE} MCP: answer_inbox_question.`,
    params: [threadParam],
    body: [
      { name: 'answer', type: 'string', required: true, description: 'Up to 2000 characters' },
      { name: 'message_id', type: 'uuid', required: false, description: 'The email asking; the newest one asking by default' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/draft', group: GROUP, scopes: PERSON,
    description: `Ask the inbox's agent for a reply draft to the newest email. One request waits per conversation: asking again while one waits answers that one. 409 when the inbox has no agent, or its assistant has Draft replies off. Nothing is sent. Answers the draft (201).${PERSON_NOTE} MCP: request_reply_draft.`,
    params: [threadParam],
    body: [{ name: 'instructions', type: 'string', required: false, description: 'What to say, up to 2000 characters' }],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/draft/copied', group: GROUP, scopes: PERSON,
    description: `The person copied a written draft into their own mail (409 for one not written); the first copy is kept. Nothing is sent. Answers the draft.${PERSON_NOTE} MCP: mark_reply_draft_copied.`,
    params: [threadParam],
    body: [{ name: 'draft_id', type: 'uuid', required: true, description: 'The draft' }],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/agent-work', group: GROUP, scopes: PERSON,
    description: `Undo all: everything the agent did with these emails (or the whole conversation), or only its links to one task, taken back. Answers the receipt { plan_items, tasks, reminders, links, kept } that POST .../agent-work/restore takes.${PERSON_NOTE} MCP: undo_agent_work.`,
    params: [threadParam],
    body: [
      { name: 'message_ids', type: 'uuid[]', required: false, description: 'Up to 200; every email of the conversation when left out' },
      { name: 'task_id', type: 'uuid', required: false, description: 'Only the agent\'s links to this task' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/agent-work/restore', group: GROUP, scopes: PERSON,
    description: `Restore all: send the receipt Undo all answered; what belongs to this conversation comes back. (The app sends DELETE .../agent-work with it; over the API it is a POST, since a DELETE here carries no body.) Answers { restored, kept }.${PERSON_NOTE} MCP: restore_agent_work.`,
    params: [threadParam],
    body: [
      { name: 'plan_items', type: 'uuid[]', required: true, description: 'From the receipt' },
      { name: 'tasks', type: 'uuid[]', required: true, description: 'From the receipt' },
      { name: 'reminders', type: 'uuid[]', required: true, description: 'From the receipt' },
      { name: 'links', type: 'object[]', required: true, description: 'From the receipt: message_id, task_id, relation, triage_id, linked_by' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/add-all', group: GROUP, scopes: PERSON,
    description: `Add all: every waiting suggestion of a meeting, accepted as the person's through the usual accept (questions are left). A second call adds nothing twice; undo is per item. Meetings only. Answers what was added.${PERSON_NOTE} MCP: add_all_meeting_suggestions.`,
    params: [threadParam],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/nothing-to-do', group: GROUP, scopes: PERSON,
    description: `Nothing to do: a meeting's waiting suggestions are skipped, its messages handled, and the dismissal recorded. Meetings only. Answers the dismissal and its undo receipt, which POST .../nothing-to-do/undo takes.${PERSON_NOTE} MCP: mark_meeting_nothing_to_do.`,
    params: [threadParam],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/nothing-to-do/undo', group: GROUP, scopes: PERSON,
    description: `Undo Nothing to do with its receipt: the suggestions wait again, the messages go back as they were, the mark clears. (The app sends DELETE .../nothing-to-do with it; over the API it is a POST, since a DELETE here carries no body.) Answers { cleared }.${PERSON_NOTE} MCP: undo_meeting_nothing_to_do.`,
    params: [threadParam],
    body: [
      { name: 'skipped', type: 'uuid[]', required: true, description: 'From the receipt' },
      { name: 'handled', type: 'object[]', required: true, description: 'From the receipt: id, status, unreviewed' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/projects', group: GROUP, scopes: PERSON,
    description: `File the conversation on a project beside its others (or confirm one the agent guessed), as the person's (source person), optionally remembering the sender (needs contacts.manage) or domain for future mail. Agents file through POST /api/v1/inbox/messages/:id/plan. Answers { project, remembered_sender, remembered_domain } (201).${PERSON_NOTE} MCP: add_inbox_thread_project.`,
    params: [threadParam],
    body: [
      { name: 'project_id', type: 'uuid', required: true, description: 'A project the key reaches' },
      { name: 'remember_sender', type: 'object', required: false, description: '{ address, project_ids }: an address that wrote in this conversation' },
      { name: 'remember_domain', type: 'object', required: false, description: '{ domain, project_ids }' },
    ],
  },
  {
    method: 'DELETE', path: '/api/v1/inbox/threads/:threadId/projects/:projectId', group: GROUP, scopes: PERSON,
    description: `Take a project off the conversation; 409 while one of its emails is linked to a task on that project. Answers { removed }.${PERSON_NOTE} MCP: remove_inbox_thread_project.`,
    params: [threadParam, { name: 'projectId', type: 'uuid', required: true, description: 'The project' }],
  },
  {
    method: 'POST', path: '/api/v1/inbox/threads/:threadId/links', group: GROUP, scopes: PERSON,
    description: `Link the conversation (its newest email, or message_id) to a task on a project the key reaches, as the person's; the conversation is filed on that project too. Agents link through their plans. Answers { task_id, message_id, relation, project_set } (201).${PERSON_NOTE} MCP: link_inbox_thread_task.`,
    params: [threadParam],
    body: [
      { name: 'task_id', type: 'uuid', required: true, description: 'The task' },
      { name: 'relation', type: 'string', required: false, description: 'related (default), updated or created' },
      { name: 'message_id', type: 'uuid', required: false, description: 'The email; the newest by default' },
    ],
  },
  {
    method: 'DELETE', path: '/api/v1/inbox/threads/:threadId/links', group: GROUP, scopes: PERSON,
    description: `Unlink the conversation from a task: every link between its emails and the task goes, whoever made it. The task stays. Answers { removed }.${PERSON_NOTE} MCP: unlink_inbox_thread_task.`,
    params: [threadParam],
    queryParams: [{ name: 'task_id', type: 'uuid', description: 'Required: the task' }],
  },

  // The agent's plans
  {
    method: 'POST', path: '/api/v1/inbox/plan-items/:id/accept', group: GROUP, scopes: PERSON,
    description: `Accept the agent's proposal, applied as the person's, optionally changing its project, task, title or date. 409 when it no longer waits.${PERSON_NOTE} MCP: accept_plan_item.`,
    params: [itemParam],
    body: [
      { name: 'project_id', type: 'uuid', required: false, description: 'Another project' },
      { name: 'task_id', type: 'uuid', required: false, description: 'Another task' },
      { name: 'title', type: 'string', required: false, description: 'Up to 500 characters' },
      { name: 'due_date', type: 'string', required: false, description: 'YYYY-MM-DD, or null' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/inbox/plan-items/:id/dismiss', group: GROUP, scopes: PERSON,
    description: `Turn down the agent's proposal. Answers { dismissed: true }.${PERSON_NOTE} MCP: dismiss_plan_item.`,
    params: [itemParam],
  },
  {
    method: 'POST', path: '/api/v1/inbox/plan-items/:id/undo', group: GROUP, scopes: PERSON,
    description: `Undo one thing the agent did (Not a task, for a task it made: to Trash); a task changed since is left alone and reported (changed_since).${PERSON_NOTE} MCP: undo_plan_item.`,
    params: [itemParam],
  },
  {
    method: 'POST', path: '/api/v1/inbox/plan-items/:id/restore', group: GROUP, scopes: PERSON,
    description: `Take back an undo (the item's work comes back) or a skip (the suggestion waits again).${PERSON_NOTE} MCP: restore_plan_item.`,
    params: [itemParam],
  },
  {
    method: 'POST', path: '/api/v1/inbox/plans/:id/undo', group: GROUP, scopes: PERSON,
    description: `Undo everything the agent did with one email (its live plan). Answers { items }.${PERSON_NOTE} MCP: undo_triage_plan.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The live plan, from GET /api/v1/inbox/threads/:threadId' }],
  },
  {
    method: 'POST', path: '/api/v1/inbox/reply-points/:id/resolve', group: GROUP, scopes: PERSON,
    description: `Mark a reply owed as done. Answers { resolved: true }.${PERSON_NOTE} MCP: resolve_reply_owed.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The reply owed, from GET /api/v1/inbox/threads/:threadId' }],
  },
];
