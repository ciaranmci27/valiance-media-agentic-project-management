import type { EndpointDoc } from '../docs-data';

const OWNER = ['team.manage, on an Owner\'s key'];
const OWN_READ = ['tasks.read, on a person\'s own key or connected AI tool (agents are refused)'];
const OWN_WRITE = ['tasks.manage_assigned, on a person\'s own key or connected AI tool (agents are refused)'];
const CONNECTION_ID = { name: 'id', type: 'uuid', required: true, description: 'Chat connection ID' };
const CHANNEL_ID = { name: 'channelId', type: 'uuid', required: true, description: "The channel mapping's id, from the connection's channels" };
const CONNECTION_ANSWER = 'Answers the connection as GET /api/v1/chat/connections lists it, with its health, never a secret.';

/** Assistants and chat connections. */
export const ASSISTANTS_ENDPOINTS: EndpointDoc[] = [
  // Assistants (Owner)
  {
    method: 'GET', path: '/api/v1/assistants/settings', group: 'Personal Agents', scopes: OWNER,
    description: "Whether assistants are on and what the workspace calls them, as Settings > Assistants shows it: { enabled, label, custom_label } (custom_label null when the workspace uses the default). An Owner's key only (403 owner_only). MCP: get_assistant_settings.",
  },
  {
    method: 'PATCH', path: '/api/v1/assistants/settings', group: 'Personal Agents', scopes: OWNER,
    description: "Turns assistants on or off and names them. While off, every personal agent's key is refused (423 assistants_off). An Owner's key only (403 owner_only). Answers the settings again. MCP: update_assistant_settings.",
    body: [
      { name: 'enabled', type: 'boolean', required: false, description: 'Assistants on or off' },
      { name: 'label', type: 'string|null', required: false, description: 'What the workspace calls them (one line, at most 40 characters); null for the default' },
    ],
  },
  {
    method: 'GET', path: '/api/v1/assistants/status', group: 'Personal Agents', scopes: OWNER,
    description: "Every person's assistant with its state (working, paused, on_hold, getting_ready, broken), reason, host_down, its person and created_at, broken ones first, as Settings > Assistants > Status shows it. Answers { assistants }. An Owner's key only (403 owner_only). MCP: list_assistant_status.",
  },
  {
    method: 'POST', path: '/api/v1/assistants/bind', group: 'Personal Agents', scopes: OWNER,
    description: "Makes an agent someone's personal agent (person_id), or a shared agent again (null); the person becomes its owner. Re-binding or unbinding revokes every key the agent holds, with their descendants, and every delegation token it holds. 422 person_is_agent or person_suspended. Answers { agent: { id, name, delegate_of } }. An Owner's key only (403 owner_only), with the AI agents module on. MCP: bind_personal_agent.",
    body: [
      { name: 'agent_id', type: 'uuid', required: true, description: 'The agent' },
      { name: 'person_id', type: 'uuid|null', required: true, description: 'The active person it will work for; null makes it a shared agent' },
    ],
  },

  // My assistant (a person's own key or connected AI tool)
  {
    method: 'GET', path: '/api/v1/me/assistant', group: 'Personal Agents', scopes: OWN_READ,
    description: "The key's person's own assistant, as My Assistant shows it: enabled and label (the workspace switch and name), agents_on, assistant (id, name, state, reason, host_down, fixer, preferences, has_personal_inbox) or null when they have none, and connections (the chat apps they can link). A broken assistant's admins are told, once a day. An agent's key is refused (403 people_only). MCP: get_my_assistant.",
  },
  {
    method: 'PATCH', path: '/api/v1/me/assistant', group: 'Personal Agents', scopes: OWN_WRITE,
    description: "Changes the person's own assistant. Send only what changes. Resuming an assistant an admin paused is refused (403 paused_by_admin). 404 when they have none. Answers the same view as GET. An agent's key is refused (403 people_only). MCP: update_my_assistant.",
    body: [
      { name: 'name', type: 'string', required: false, description: 'At most 60 characters' },
      { name: 'tone', type: 'warm|brief|formal', required: false, description: 'How it writes' },
      { name: 'personality', type: 'string|null', required: false, description: 'A note on how it should be (at most 1000 characters); null clears it' },
      { name: 'avatar_tone', type: 'number|null', required: false, description: '1 to 8' },
      { name: 'switches', type: 'object', required: false, description: 'sort_inbox, create_tasks, draft_replies, remind_me, remember: each true or false' },
      { name: 'paused', type: 'boolean', required: false, description: 'Pause or resume it' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/me/assistant/undo', group: 'Personal Agents', scopes: OWN_WRITE,
    description: "Takes back one thing the person's own assistant did: task_created (the task goes to Trash), task_completed (the task is reopened) or task_restore (a task it made comes back out of Trash). Another assistant's work reads as missing (404). An inbox sort is undone with the Inbox's own undo (422 use_inbox_undo). Answers { undone: true, status? }. An agent's key is refused (403 people_only). MCP: undo_assistant_action.",
    body: [
      { name: 'kind', type: 'task_created|task_completed|inbox_sorted|task_restore', required: true, description: "The item's undo kind, from GET /api/v1/me/assistant/activity" },
      { name: 'id', type: 'uuid', required: true, description: 'The task' },
    ],
  },
  {
    method: 'GET', path: '/api/v1/me/assistant/activity', group: 'Personal Agents', scopes: OWN_READ,
    description: "What the person's own assistant did in the last 30 days, newest first: items (kind, text, at, href, undo or null) and drafts (its reply drafts ready for the person). 404 when they have no assistant. An agent's key is refused (403 people_only). MCP: list_my_assistant_activity.",
  },
  {
    method: 'GET', path: '/api/v1/me/personal-agents', group: 'Personal Agents', scopes: OWN_READ,
    description: "The key's person's own personal agents, newest first: each with its template_key, status (paused_with_person when it was paused with them), its person and live keys, never a secret. Answers { assistants }, with the AI agents module on. An agent's key is refused (403 people_only). MCP: list_my_personal_agents.",
  },

  // Chat connections (Owner; connecting and secrets stay in the app)
  {
    method: 'GET', path: '/api/v1/chat/connections', group: 'Chat', scopes: OWNER,
    description: "The workspace's chat connections, as Settings > Assistants > Chat apps lists them: id, provider, provider_label, kind (personal or company), display_name, external_workspace_id, bot_handle, enabled, health (off, not_receiving, waiting, needs_agents, connected, quiet), inbound_url, last_inbound_at, last_refused_at, created_at, and for Discord relay_seen_at (the relay's last heartbeat, null for a relay that sends none; a relay quiet for 15 minutes after one reads not_receiving); a company one also agents (the default first), channels, candidates and recent_channels. Never a token or secret. Answers { connections }. Connecting an app or replacing its bot token, signing secret or relay secret is done in the app only. An Owner's key only (403 owner_only). MCP: list_chat_connections.",
  },
  {
    method: 'PATCH', path: '/api/v1/chat/connections/:id', group: 'Chat', scopes: OWNER,
    description: `Renames a connection or switches it on or off. bot_token, signing_secret and new_relay_secret are refused here (422): a secret is changed in the app only. ${CONNECTION_ANSWER} An Owner's key only. MCP: update_chat_connection.`,
    params: [CONNECTION_ID],
    body: [
      { name: 'display_name', type: 'string', required: false, description: 'At most 100 characters' },
      { name: 'enabled', type: 'boolean', required: false, description: 'On or off' },
      { name: 'answer_buttons', type: 'boolean', required: false, description: 'Slack only (422 answer_buttons_slack_only otherwise): answer buttons on the app\'s question and approval messages. Off by default; turn on after pasting actions_url as the Interactivity Request URL in the Slack app, or presses fail. Until then the message comes with its link.' },
    ],
  },
  {
    method: 'DELETE', path: '/api/v1/chat/connections/:id', group: 'Chat', scopes: OWNER,
    description: "Removes a connection with its chat history, agents and channel mappings (Telegram's webhook is deleted with it). Cannot be undone. Answers { id, deleted: true }. An Owner's key only. MCP: delete_chat_connection.",
    params: [CONNECTION_ID],
  },
  {
    method: 'PUT', path: '/api/v1/chat/connections/:id/agents', group: 'Chat', scopes: OWNER,
    description: `Which company agents a company connection reaches, and the one a DM goes to. Each must be a shared agent that may act for people (422 agent_cannot_act_for, personal_agent, not_an_agent). Agents left out lose their channel mappings. 409 not_a_company_connection. ${CONNECTION_ANSWER} An Owner's key only. MCP: set_chat_connection_agents.`,
    params: [CONNECTION_ID],
    body: [
      { name: 'agent_ids', type: 'uuid[]', required: true, description: 'The whole list (at most 100; empty clears it)' },
      { name: 'default_agent_id', type: 'uuid|null', required: true, description: 'One of agent_ids, or null' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/chat/connections/:id/channels', group: 'Chat', scopes: OWNER,
    description: `Maps a channel of a company connection to one of its agents. The app resolves a name with the provider using the stored bot token, which never leaves the server. 422 agent_not_on_connection, 409 channel_exists. ${CONNECTION_ANSWER} (201) An Owner's key only. MCP: map_chat_channel.`,
    params: [CONNECTION_ID],
    body: [
      { name: 'channel', type: 'string', required: true, description: 'An id (Slack C0123, a Telegram chat id) or a name the provider resolves (#general, @group)' },
      { name: 'agent_id', type: 'uuid', required: true, description: "One of the connection's agents" },
      { name: 'listen', type: 'mentions|all', required: false, description: 'Default mentions' },
    ],
  },
  {
    method: 'PATCH', path: '/api/v1/chat/connections/:id/channels/:channelId', group: 'Chat', scopes: OWNER,
    description: `Changes a mapped channel's agent or listen mode. ${CONNECTION_ANSWER} An Owner's key only. MCP: update_chat_channel.`,
    params: [CONNECTION_ID, CHANNEL_ID],
    body: [
      { name: 'agent_id', type: 'uuid', required: false, description: "Another of the connection's agents" },
      { name: 'listen', type: 'mentions|all', required: false, description: 'Mentions or all' },
    ],
  },
  {
    method: 'DELETE', path: '/api/v1/chat/connections/:id/channels/:channelId', group: 'Chat', scopes: OWNER,
    description: `Unmaps a channel: a mention of the bot there goes to the default agent again. ${CONNECTION_ANSWER} An Owner's key only. MCP: unmap_chat_channel.`,
    params: [CONNECTION_ID, CHANNEL_ID],
  },
];
