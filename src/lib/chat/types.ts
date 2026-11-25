import { z } from 'zod';

/**
 * The chat switchboard's vocabulary: the providers a workspace connects, how
 * each is added, and what the app tells people. Client-safe: no server code
 * here; the adapters (one file per provider) are in lib/chat/providers.
 */

/** Providers with an adapter today. Teams and custom are reserved in the database for adapters to come. */
export const CHAT_PROVIDERS = ['slack', 'telegram'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export const CHAT_PROVIDER_LABELS: Record<string, string> = {
  slack: 'Slack',
  telegram: 'Telegram',
  teams: 'Microsoft Teams',
  custom: 'Custom',
};

export const chatProviderLabel = (provider: string): string => CHAT_PROVIDER_LABELS[provider] ?? provider;

/** The address a provider sends messages to, for one connection. */
export const chatInboundPath = (connectionId: string) => `/api/chat/inbound/${connectionId}`;
export const chatInboundUrl = (appUrl: string, connectionId: string) => `${appUrl.replace(/\/+$/, '')}${chatInboundPath(connectionId)}`;

const displayName = z.string().trim().min(1, 'Give it a name').max(100).optional();

/** POST /api/workspace/chat-connections: paste what the provider gave you. */
export const createChatConnectionSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('slack'),
    display_name: displayName,
    bot_token: z.string().trim().regex(/^xoxb-[A-Za-z0-9-]{10,250}$/, 'The bot token starts with xoxb-: copy it from OAuth & Permissions in your Slack app'),
    signing_secret: z.string().trim().regex(/^[A-Za-z0-9]{16,128}$/, 'The signing secret is under Basic Information in your Slack app'),
  }).strict(),
  z.object({
    provider: z.literal('telegram'),
    display_name: displayName,
    bot_token: z.string().trim().regex(/^\d{5,20}:[A-Za-z0-9_-]{30,64}$/, 'The bot token looks like 123456:ABC-DEF...: BotFather sends it when you make the bot'),
  }).strict(),
]);
export type CreateChatConnection = z.infer<typeof createChatConnectionSchema>;

/** PATCH /api/workspace/chat-connections/{id}. */
export const updateChatConnectionSchema = z.object({
  display_name: z.string().trim().min(1, 'Give it a name').max(100).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send display_name or enabled');

/** A connection as the Owner's screen reads it: never a credential. */
export interface ChatConnectionView {
  id: string;
  provider: string;
  provider_label: string;
  display_name: string;
  external_workspace_id: string | null;
  bot_handle: string | null;
  enabled: boolean;
  /** Where the provider sends messages (Slack's Request URL). */
  inbound_url: string;
  last_inbound_at: string | null;
  created_at: string;
}

/** GET /api/v1/assistant/messages?status=. */
export const CHAT_MESSAGE_STATUSES = ['pending', 'notified', 'replied', 'handled', 'unrouted', 'all'] as const;

/** POST /api/v1/assistant/messages/{id}/reply. */
export const chatReplySchema = z.object({
  text: z.string().trim().min(1, 'text is required').max(20000),
  /** Default true: answer in the message's thread where the provider has threads. */
  in_thread: z.boolean().optional(),
}).strict();
export type ChatReplyInput = z.infer<typeof chatReplySchema>;

/** What an assistant reads for one inbound message (the poll and the webhook carry the same). */
export interface AssistantChatMessage {
  id: string;
  status: string;
  text: string;
  created_at: string;
  provider: string;
  connection_id: string;
  conversation_id: string;
  thread_id: string | null;
  external_message_id: string | null;
  external_user_id: string | null;
  person: { id: string; name: string } | null;
  agent_id: string | null;
}

/** The words the app sends on its own. Plain and short; the link is the one-time link. */
export const CHAT_WORDS = {
  linkPrompt: (workspace: string, url: string) =>
    `Hi! I don't know who you are in ${workspace} yet. Open this link while signed in to connect this account: ${url}\nIt works once and expires in 15 minutes.`,
  linkAgain: 'I sent you a link to connect this account. Open it while signed in; if it expired, message me again in an hour.',
  linkDirectly: 'Message me directly to connect your account.',
  inactive: 'This account is not active here. Ask your admin.',
  noAssistant: "You don't have an assistant yet. Ask your admin to set one up.",
  paused: 'Your assistant is paused. Your admin has been told.',
  pausedByYou: (url: string) => `Your assistant is paused. Resume it here: ${url}`,
  assistantsOff: 'Assistants are not turned on yet. Ask your admin.',
} as const;
