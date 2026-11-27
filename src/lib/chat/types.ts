import { z } from 'zod';
import { instanceIdSchema } from '@/lib/agent-runs';

/**
 * The chat switchboard's vocabulary: the providers a workspace connects, how
 * each is added, and what the app tells people. Client-safe: no server code
 * here; the adapters (one file per provider) are in lib/chat/providers.
 */

/** Providers with an adapter today. Teams and custom are reserved in the database for adapters to come. */
export const CHAT_PROVIDERS = ['slack', 'telegram', 'discord'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export const CHAT_PROVIDER_LABELS: Record<string, string> = {
  slack: 'Slack',
  telegram: 'Telegram',
  discord: 'Discord',
  teams: 'Microsoft Teams',
  custom: 'Custom',
};

export const chatProviderLabel = (provider: string): string => CHAT_PROVIDER_LABELS[provider] ?? provider;

/**
 * The chat apps Settings offers, in order, each with one line on what it
 * gives. available: false shows the card as "Coming soon", never a flow. To
 * turn one on, add its adapter and its id to CHAT_PROVIDERS, flip available
 * and add its token step to the add dialog.
 */
export const CHAT_APPS: readonly { provider: string; name: string; line: string; available: boolean }[] = [
  { provider: 'slack', name: 'Slack', line: 'Assistants in DMs and company AI in your channels.', available: true },
  { provider: 'telegram', name: 'Telegram', line: 'Assistants and company AI in Telegram chats and groups.', available: true },
  { provider: 'discord', name: 'Discord', line: 'Assistants and company AI in your Discord server.', available: true },
];

/** A chat app that can be connected today: listed as available and with an adapter. */
export const chatAppConnectable = (provider: string): provider is ChatProvider =>
  (CHAT_PROVIDERS as readonly string[]).includes(provider) && CHAT_APPS.some((app) => app.provider === provider && app.available);

/** The address a provider sends messages to, for one connection. */
export const chatInboundPath = (connectionId: string) => `/api/chat/inbound/${connectionId}`;
export const chatInboundUrl = (appUrl: string, connectionId: string) => `${appUrl.replace(/\/+$/, '')}${chatInboundPath(connectionId)}`;

/**
 * Discord sends ordinary messages only over its Gateway, a websocket a
 * serverless host cannot hold, so a small relay the install runs elsewhere
 * holds it and posts each message here, signed. This is its guide.
 */
export const DISCORD_RELAY_README_URL = 'https://github.com/ciaranmci27/valiance-media-agentic-project-management/blob/main/relay/discord/README.md';

/**
 * The permissions the Discord bot is invited with. Personal: none in the
 * server (people DM it; it only needs to share a server with them).
 * Company: View Channels, Send Messages, Read Message History, Send
 * Messages in Threads and Manage Webhooks (replies under each agent's own
 * name and avatar; without it they go as the bot, the agent's name in bold).
 */
export const DISCORD_PERMISSIONS: Record<ChatConnectionKind, string> = {
  personal: '0',
  // 1024 + 2048 + 65536 + 536870912 + 274877906944: bits 10, 11, 16, 29 and 38.
  company: '275414846464',
};

/** The link that adds the Discord bot to a server, with the permissions its kind needs. */
export const discordInviteUrl = (applicationId: string, kind: ChatConnectionKind) =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot&permissions=${DISCORD_PERMISSIONS[kind]}`;

const displayName = z.string().trim().min(1, 'Give it a name').max(100).optional();

/**
 * The two bots. personal: DMs only, each person's message goes to their own
 * personal assistant, under its name. company: channels and DMs, routed to
 * the company agents an Owner picks, by mention, channel or the default.
 */
export const CHAT_CONNECTION_KINDS = ['personal', 'company'] as const;
export type ChatConnectionKind = (typeof CHAT_CONNECTION_KINDS)[number];
export const CHAT_CONNECTION_KIND_LABELS: Record<ChatConnectionKind, string> = {
  personal: 'Personal assistants (DMs)',
  company: 'Company AI (channels and DMs)',
};
const kind = z.enum(CHAT_CONNECTION_KINDS).optional();

/**
 * What can still be added, per provider: the kinds not yet connected. One
 * connection per provider and kind (the database's unique index is per
 * provider workspace and kind; a workspace runs one team chat per provider),
 * so at most one personal and one company bot each. A provider with no kind
 * left is fully connected.
 */
export function freeChatKinds(connections: readonly { provider: string; kind: ChatConnectionKind }[]): Record<ChatProvider, ChatConnectionKind[]> {
  const taken = new Set(connections.map((connection) => `${connection.provider}:${connection.kind}`));
  return Object.fromEntries(
    CHAT_PROVIDERS.map((provider) => [provider, CHAT_CONNECTION_KINDS.filter((k) => !taken.has(`${provider}:${k}`))]),
  ) as Record<ChatProvider, ChatConnectionKind[]>;
}

/** Per channel of a company connection: only mentions, or every message recorded as context. */
export const CHAT_LISTEN_MODES = ['mentions', 'all'] as const;
export type ChatListenMode = (typeof CHAT_LISTEN_MODES)[number];

/** POST /api/workspace/chat-connections: paste what the provider gave you. kind defaults to personal. */
export const createChatConnectionSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('slack'),
    kind,
    display_name: displayName,
    bot_token: z.string().trim().regex(/^xoxb-[A-Za-z0-9-]{10,250}$/, 'The bot token starts with xoxb-: copy it from OAuth & Permissions in your Slack app'),
    signing_secret: z.string().trim().regex(/^[A-Za-z0-9]{16,128}$/, 'The signing secret is under Basic Information in your Slack app'),
  }).strict(),
  z.object({
    provider: z.literal('telegram'),
    kind,
    display_name: displayName,
    bot_token: z.string().trim().regex(/^\d{5,20}:[A-Za-z0-9_-]{30,64}$/, 'The bot token looks like 123456:ABC-DEF...: BotFather sends it when you make the bot'),
  }).strict(),
  z.object({
    provider: z.literal('discord'),
    kind,
    display_name: displayName,
    bot_token: z.string().trim().regex(/^[A-Za-z0-9_-]{18,100}\.[A-Za-z0-9_-]{4,20}\.[A-Za-z0-9_-]{20,120}$/, 'Copy the bot token from the Bot page of your app in the Discord Developer Portal (Reset Token shows it)'),
  }).strict(),
]);
export type CreateChatConnection = z.infer<typeof createChatConnectionSchema>;

/**
 * PATCH /api/workspace/chat-connections/{id}. bot_token and signing_secret
 * replace what the connection signs and sends with, on the same connection:
 * its id, Request URL, history and people's links stay. A new token must be
 * for the same bot (Telegram, Discord) or workspace (Slack). Each is checked
 * against its provider's shape in the server (createChatConnectionSchema).
 */
export const updateChatConnectionSchema = z.object({
  display_name: z.string().trim().min(1, 'Give it a name').max(100).optional(),
  enabled: z.boolean().optional(),
  /** Discord: make a new relay secret (the old one stops working). The answer carries it once, as relay_secret. */
  new_relay_secret: z.literal(true).optional(),
  bot_token: z.string().trim().min(1).max(300).optional(),
  /** Slack only. */
  signing_secret: z.string().trim().min(1).max(200).optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send display_name, enabled, new_relay_secret, bot_token or signing_secret');
export type UpdateChatConnection = z.infer<typeof updateChatConnectionSchema>;

/**
 * PATCH /api/v1/chat/connections/{id}: rename or switch on or off. A bot
 * token, signing secret or relay secret is changed in the app only, by an
 * Owner: a secret never passes through an agent, so those fields are refused.
 */
export const apiUpdateChatConnectionSchema = z.object({
  display_name: z.string().trim().min(1, 'Give it a name').max(100).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send display_name or enabled');
export type ApiUpdateChatConnection = z.infer<typeof apiUpdateChatConnectionSchema>;

/** The provider's own shape for a bot token or Slack signing secret, said in its words (shared by connect and replace). */
export const CHAT_TOKEN_SHAPES: Record<ChatProvider, { bot_token: RegExp; message: string }> = {
  slack: { bot_token: /^xoxb-[A-Za-z0-9-]{10,250}$/, message: 'The bot token starts with xoxb-: copy it from OAuth & Permissions in your Slack app' },
  telegram: { bot_token: /^\d{5,20}:[A-Za-z0-9_-]{30,64}$/, message: 'The bot token looks like 123456:ABC-DEF...: BotFather sends it when you make the bot' },
  discord: { bot_token: /^[A-Za-z0-9_-]{18,100}\.[A-Za-z0-9_-]{4,20}\.[A-Za-z0-9_-]{20,120}$/, message: 'Copy the bot token from the Bot page of your app in the Discord Developer Portal (Reset Token shows it)' },
};
export const SLACK_SIGNING_SECRET_SHAPE = { pattern: /^[A-Za-z0-9]{16,128}$/, message: 'The signing secret is under Basic Information in your Slack app' };

/** A connection with no message in this many days reads Quiet instead of Connected. */
export const CHAT_CONNECTED_DAYS = 14;

/** How often a Discord relay checks in (relay/discord/relay.mjs sends RELAY_HEARTBEAT). */
export const RELAY_HEARTBEAT_SECONDS = 300;
/** A relay that has checked in before and then says nothing for this long has stopped: three heartbeats missed. */
export const RELAY_SILENT_MINUTES = 15;

/**
 * A relay that checks in (relay_seen_at set) but has said nothing, heartbeat
 * or message, for longer than RELAY_SILENT_MINUTES: it has stopped. A relay
 * that never sent a heartbeat (older than this release) is never silent.
 */
export function relaySilent(connection: Pick<ChatConnectionView, 'last_inbound_at' | 'relay_seen_at'>, now = Date.now()): boolean {
  const seen = connection.relay_seen_at ? Date.parse(connection.relay_seen_at) : NaN;
  if (!Number.isFinite(seen)) return false;
  const heard = connection.last_inbound_at ? Date.parse(connection.last_inbound_at) : NaN;
  const last = Number.isFinite(heard) ? Math.max(seen, heard) : seen;
  return now - last > RELAY_SILENT_MINUTES * 60_000;
}

/**
 * A connection's status, honestly, for the Owner's list:
 * - off: switched off.
 * - not_receiving: the provider's last request failed the check (a wrong
 *   signing secret, an old relay secret), and nothing verified came after
 *   it; or a Discord relay that checks in went silent (relaySilent).
 * - waiting: nothing verified heard yet (Discord: the relay's hello).
 * - needs_agents: a company connection with no agents chosen.
 * - connected: a verified request within CHAT_CONNECTED_DAYS.
 * - quiet: heard once, but nothing for longer than that.
 */
export type ChatConnectionHealth = 'off' | 'not_receiving' | 'waiting' | 'needs_agents' | 'connected' | 'quiet';

export function chatConnectionHealth(connection: Pick<ChatConnectionView, 'enabled' | 'kind' | 'agents' | 'last_inbound_at' | 'last_refused_at' | 'relay_seen_at'>, now = Date.now()): ChatConnectionHealth {
  if (!connection.enabled) return 'off';
  const heard = connection.last_inbound_at ? new Date(connection.last_inbound_at).getTime() : null;
  const refused = connection.last_refused_at ? new Date(connection.last_refused_at).getTime() : null;
  if (refused !== null && (heard === null || refused > heard)) return 'not_receiving';
  if (relaySilent(connection, now)) return 'not_receiving';
  if (heard === null) return 'waiting';
  if (connection.kind === 'company' && connection.agents.length === 0) return 'needs_agents';
  return now - heard <= CHAT_CONNECTED_DAYS * 86_400_000 ? 'connected' : 'quiet';
}

/** PUT /api/workspace/chat-connections/{id}/agents: the company agents it reaches, and the default. */
export const chatConnectionAgentsSchema = z.object({
  agent_ids: z.array(z.uuid('agent_ids holds team member ids')).max(100),
  default_agent_id: z.uuid('default_agent_id is a team member id').nullable(),
}).strict().refine((body) => body.default_agent_id === null || body.agent_ids.includes(body.default_agent_id), {
  message: 'The default agent must be one of agent_ids', path: ['default_agent_id'],
});
export type ChatConnectionAgentsInput = z.infer<typeof chatConnectionAgentsSchema>;

/** POST /api/workspace/chat-connections/{id}/channels: a channel id (C0123, -100123) or name (#general, @group). */
export const createChatChannelSchema = z.object({
  channel: z.string().trim().min(1, 'Name the channel, or paste its id').max(255),
  agent_id: z.uuid('agent_id is a team member id'),
  listen: z.enum(CHAT_LISTEN_MODES).optional(),
}).strict();
export type CreateChatChannelInput = z.infer<typeof createChatChannelSchema>;

/** PATCH /api/workspace/chat-connections/{id}/channels/{routeId}. */
export const updateChatChannelSchema = z.object({
  agent_id: z.uuid('agent_id is a team member id').optional(),
  listen: z.enum(CHAT_LISTEN_MODES).optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send agent_id or listen');
export type UpdateChatChannelInput = z.infer<typeof updateChatChannelSchema>;

/** A company agent a connection reaches. */
export interface ChatConnectionAgentView {
  id: string;
  name: string;
  is_default: boolean;
}

/** A channel mapped to one of the connection's agents. */
export interface ChatChannelRouteView {
  id: string;
  channel_id: string;
  channel_name: string | null;
  agent_id: string;
  listen: ChatListenMode;
}

/** A connection as the Owner's screen reads it: never a credential. */
export interface ChatConnectionView {
  id: string;
  provider: string;
  provider_label: string;
  kind: ChatConnectionKind;
  display_name: string;
  external_workspace_id: string | null;
  bot_handle: string | null;
  enabled: boolean;
  /** Where the provider sends messages (Slack's Request URL, the Discord relay's PM_INBOUND_URL). */
  inbound_url: string;
  /** The last verified request from the provider (Discord: from the relay, its hello included; Slack: its URL check too). Null: nothing heard yet. */
  last_inbound_at: string | null;
  /** The last request that failed the provider's check (a wrong signing secret, an old relay secret), or null. */
  last_refused_at: string | null;
  /**
   * Discord: the relay's last heartbeat (every RELAY_HEARTBEAT_SECONDS), or
   * null while its relay sends none (an older relay). Once set, silence past
   * RELAY_SILENT_MINUTES reads not_receiving.
   */
  relay_seen_at?: string | null;
  /**
   * Discord only, and only in the answer that made it (connecting, or
   * new_relay_secret): the secret the relay signs with (PM_RELAY_SECRET).
   * Never shown again.
   */
  relay_secret?: string;
  created_at: string;
  /** Company connections: the agents it reaches (the default marked) and the mapped channels. Empty for personal ones. */
  agents: ChatConnectionAgentView[];
  channels: ChatChannelRouteView[];
  /**
   * Company connections, in the Owner's list: every company agent that could
   * be chosen, and whether it may act for people (agents.act_for), which it
   * needs before it can be.
   */
  candidates?: { id: string; name: string; can_act_for: boolean }[];
  /** Company connections, in the Owner's list: chats the bot heard lately that are not mapped yet, to map by picking. */
  recent_channels?: { id: string; name: string | null; last_at: string }[];
}

/** GET /api/v1/chat/messages?status= (and the deprecated /api/v1/assistant/messages). context: channel messages recorded for you, never to answer. */
export const CHAT_MESSAGE_STATUSES = ['pending', 'notified', 'replied', 'handled', 'unrouted', 'context', 'all'] as const;

/** POST /api/v1/chat/messages/{id}/reply (and the deprecated /api/v1/assistant/messages/{id}/reply). */
export const chatReplySchema = z.object({
  text: z.string().trim().min(1, 'text is required').max(20000),
  /** Default true: answer in the message's thread where the provider has threads. */
  in_thread: z.boolean().optional(),
  /**
   * Slack: the threaded reply also shows in the channel (reply_broadcast).
   * Ignored in a DM, on Telegram, and on Discord, where a reply always shows
   * in the channel (a reply to the message; inside a Discord thread, in the thread).
   */
  also_send_to_channel: z.boolean().optional(),
  /** Send the reply to the sender by DM instead of where they wrote. */
  private: z.boolean().optional(),
  /** The worker replying (a pool): needed while that worker holds the message or its conversation. */
  instance_id: instanceIdSchema.optional(),
}).strict();
export type ChatReplyInput = z.infer<typeof chatReplySchema>;

/** Marking a message handled: the worker doing it, while a worker holds it. */
export const chatHandledSchema = z.object({
  instance_id: instanceIdSchema.optional(),
});
export type ChatHandledInput = z.infer<typeof chatHandledSchema>;

/** A link sent with a message, shown the provider's way: a Slack link, a Telegram button, a Discord masked link. */
export const chatLinkSchema = z.object({
  url: z.string().trim().max(2000).regex(/^https:\/\/[^\s<>|]+$/, 'link.url is an https address'),
  label: z.string().trim().min(1, 'link.label is required').max(80).regex(/^[^\r\n]+$/, 'link.label is one line'),
}).strict();
export type ChatLink = z.infer<typeof chatLinkSchema>;

/**
 * POST /api/v1/chat/messages: an agent starts a conversation. A personal
 * assistant messages its own person only (person_id may be left out). A
 * company agent names a channel mapped to it, or a person (person_id) to DM.
 * connection_id or provider picks the connection when more than one fits.
 */
export const chatSendSchema = z.object({
  text: z.string().trim().min(1, 'text is required').max(20000),
  person_id: z.uuid('person_id is a team member id').optional(),
  channel: z.string().trim().min(1).max(255).optional(),
  connection_id: z.uuid('connection_id is a chat connection id').optional(),
  provider: z.enum(CHAT_PROVIDERS).optional(),
  link: chatLinkSchema.optional(),
}).strict().refine((body) => !(body.person_id && body.channel), { message: 'Send person_id or channel, not both', path: ['channel'] });
export type ChatSendInput = z.infer<typeof chatSendSchema>;

/** What an inbound file is, as the agent reads it. */
export const CHAT_ATTACHMENT_KINDS = ['photo', 'voice', 'audio', 'video', 'document'] as const;
export type ChatAttachmentKind = (typeof CHAT_ATTACHMENT_KINDS)[number];

/** The largest file the app fetches for an agent (Telegram's bot download limit). */
export const CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** An inbound file as the agent reads it: never the provider's file id or address. */
export interface ChatAttachmentView {
  index: number;
  kind: ChatAttachmentKind;
  name: string | null;
  mime_type: string | null;
  size: number | null;
  duration_seconds: number | null;
  download: { method: 'GET'; path: string };
}

/** Where a chat message was said: the conversation, whether it is a DM with the bot, and the company mapping for it. */
export interface ChatChannelInfo {
  id: string;
  name: string | null;
  /** A one-to-one chat with the bot; null for messages recorded before 20261125001100. */
  direct: boolean | null;
  /** The company agent this channel is mapped to, if any. */
  mapped_agent_id: string | null;
  listen: ChatListenMode | null;
}

/** The body that mints a delegation pass for a company message's sender (POST /api/v1/delegations). */
export interface ChatActFor {
  method: 'POST';
  path: '/api/v1/delegations';
  body: { provider: string; external_id: string; workspace_id: string | null };
}

/** What an agent reads for one inbound message (the poll and the webhook carry the same). */
export interface AssistantChatMessage {
  id: string;
  status: string;
  text: string;
  created_at: string;
  provider: string;
  connection_id: string;
  connection_kind: ChatConnectionKind;
  conversation_id: string;
  thread_id: string | null;
  external_message_id: string | null;
  external_user_id: string | null;
  person: { id: string; name: string } | null;
  agent_id: string | null;
  /** false: context only, recorded so the agent knows what was said. Never answer it. */
  is_request: boolean;
  /** How a company message reached the agent: direct, mention, channel or default; null for personal ones. */
  route: string | null;
  channel: ChatChannelInfo;
  /**
   * A company request from a linked person: mint a pass for them with this
   * and send it as X-Act-For on the work and the reply. Null otherwise (a
   * personal agent already acts for its person).
   */
  act_for: ChatActFor | null;
  /** Files sent with it (photos, voice notes, documents), each fetched through its download path. Empty when none. */
  attachments: ChatAttachmentView[];
  /** The message an agent started (POST /api/v1/chat/messages) that this one answers, or null. */
  in_reply_to: string | null;
  /** The conversation it belongs to (a DM, or a thread in a channel): claim it whole, or read it with GET /api/v1/chat/conversations/{id}. Null before the database update. */
  chat_conversation_id?: string | null;
  /** The live lease on it (its agent, and the worker holding it), or null. */
  claim?: { agent_id: string; instance_id: string | null; claimed_at: string | null; expires_at: string } | null;
}

/** The words the app sends on its own. Plain and short; the link is the one-time link. */
export const CHAT_WORDS = {
  linkPrompt: (workspace: string, url: string, code?: string) =>
    `Hi! I don't know who you are in ${workspace} yet. Open this link while signed in to connect this account: ${url}\n${code ? `When it asks, type this code: ${code}\nNever share the link or the code. ` : ''}It works once and expires in 15 minutes.`,
  linkAgain: 'I sent you a link to connect this account a moment ago. Open it while signed in. If it expires, message me again for a new one.',
  linkDirectly: 'Message me directly to connect your account.',
  inactive: 'This account is not active here. Ask your admin.',
  noAssistant: "You don't have an assistant yet. Ask your admin to set one up.",
  assistantsOff: 'Assistants are off in this workspace right now. Ask your admin.',
  /** A connection an Owner switched off, spoken to. Once a day per chat. */
  connectionOff: 'This chat is switched off here. Ask your admin.',
  /** After someone links their account from the link the bot sent: who answers them here now. */
  linked: (name: string) => `Linked. ${name} answers you here now.`,
  linkedNoAssistant: "Linked. You don't have an assistant yet: ask your admin to set one up.",
  linkedCompany: 'Linked. Ask away: the AI here now knows who you are.',
  /** A company bot with nobody to answer here: no agent named, no channel mapping, no default. */
  noAgentHere: 'No AI is set up to answer here yet. Ask your admin.',
  agentsOff: 'AI agents are not turned on yet. Ask your admin.',
  /** A company agent the person may not use (who can use it, or only through its orchestrator). */
  agentNotAvailable: (name: string) => `${name} is not available to you. Ask one of its managers if you need it.`,
  agentThroughOrchestrator: (name: string, orchestrator: string) => `${name} takes work through ${orchestrator}. Ask ${orchestrator} instead.`,
  /** A company agent that asks its managers first: they were asked; the next message goes through once one approves. */
  agentAskFirst: (name: string) => `${name} asks its managers before it helps here. I've asked them. Message again once one of them approves.`,
} as const;

/**
 * The one line the app sends, once per chat per spell, when the person's
 * assistant will not answer right now. {name} is the assistant's own name;
 * {page} is what the workspace calls assistants (the page's name).
 */
export const QUIET_WORDS = {
  onHold: (name: string) => `${name} is on hold right now and will answer when it's back.`,
  /** Held for it: what they send meanwhile reaches it when they resume (the newest 20). */
  paused: (name: string, page: string, url: string) => `${name} is paused. Resume it from your ${page} page: it gets what you send meanwhile when you do.\n${url}`,
  pausedByAdmin: (name: string) => `${name} is paused by an admin. It gets what you send meanwhile when they resume it.`,
  /** On hold, and its host stopped reporting. fixer: an admin was told, or the person fixes it in Settings. */
  hostDown: (name: string, fixer: 'admin' | 'settings') =>
    `${name} is on hold and its host is not responding. ${fixer === 'admin' ? 'Your admin has been told.' : 'Fix it in AI > Setup.'}`,
  /** Not working: why ("its key expired or was revoked"), then who fixes it. */
  broken: (name: string, why: string, fixer: 'admin' | 'settings') =>
    `${name} can't answer right now${why ? `: ${why}` : ''}. ${fixer === 'admin' ? 'Your admin has been told.' : 'Fix it in AI > Setup.'}`,
  /** A company agent that is paused, suspended, never connected, or whose host stopped reporting. */
  companyDown: (name: string) => `${name} can't answer right now. Try again later.`,
} as const;
