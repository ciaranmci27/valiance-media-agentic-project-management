import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { alertOf, assistantFixer, readAssistantSettings, findPersonalAgent, missingAssistantSchema, notifyAssistantBroken, statesOf } from '@/lib/api/assistant';
import { BROKEN_WORDS, type AssistantFixer, type AssistantStatus } from '@/lib/assistant';
import { createLinkRequest, findIdentity } from '@/lib/api/identities';
import { afterResponse } from '@/lib/api/after-response';
import { gateAgentWork } from '@/lib/api/agent-access';
import { conversationHolder, threadKeyOf } from './claims';
import { ApiError } from '@/lib/api/errors';
import { readStoredBrand } from '@/lib/brand/server';
import { enabledModuleSet } from '@/lib/modules/server';
import { runDispatch } from '@/lib/webhooks/dispatch';
import { connectionKind, openCredentials, loadConnection } from './connections';
import { chatAdapter, type ChatAdapter, type ChatCredentials, type ParsedInbound } from './providers';
import { CHAT_WORDS, QUIET_WORDS } from './types';
import { assistantMessagePayload, chatMessagePayload } from './messages';

/**
 * A chat provider's request to /api/chat/inbound/{connection_id}, end to end:
 *
 * 1. The connection must exist, have an adapter and readable credentials,
 *    and the adapter must verify the request (Slack's signature, Telegram's
 *    secret token, the Discord relay's signature) before anything is read. Each of those failing answers
 *    the same 401, so nobody can tell whether a connection exists. A known
 *    connection's refused request is stamped (last_refused_at), so Settings
 *    can say it is not receiving. Slack's URL challenge is answered once
 *    verified, and counts as heard. An event from another Slack workspace
 *    than the connection's is ignored. A connection switched off answers a
 *    message spoken to it with one line a day per chat: it is switched off.
 * 2. A retry of a delivery already recorded (the provider's event id) is a
 *    no-op; inbound messages are rate limited per connection and per sender.
 * 3. The connection's kind decides the rest.
 *
 * The personal bot (kind personal, every connection made before company
 * chat): DMs only; anything said in a channel or group is ignored and never
 * recorded.
 *  - The sender is resolved through a verified linked account in this
 *    connection's workspace (or, for providers with no workspaces, one with
 *    none). Someone unknown gets a one-time link to connect their account
 *    (the existing link handshake), and no second one while that link is
 *    still open (unused and unexpired). Someone suspended or with no
 *    assistant gets one plain line.
 *  - A paused assistant (by its person, or by an admin) is not sent the
 *    message yet: it is held (unrouted, for its agent, not handled) and
 *    delivered when the assistant works again, oldest first, the newest
 *    HELD_CHAT_LIMIT of them (deliverHeldChat). Otherwise the message is recorded
 *    for the person's assistant and sent to its webhook: assistant.message
 *    (exactly as before) and chat.message, both ids only; with no endpoint
 *    it waits for the assistant to fetch it. No act-for token: a personal
 *    agent is already narrowed to its person.
 *  - When the assistant will not answer right now (on hold, paused, broken:
 *    the states the person's page shows), the app says so itself, with why,
 *    once per chat per spell. A broken one, or one on hold whose host
 *    stopped reporting, tells its admins (once a day), and the line says an
 *    admin was told only when one was; an Owner, or someone with nobody to
 *    tell, is pointed to Settings > Assistants instead.
 *
 * The company bot (kind company): channels and DMs, to the company agents
 * the Owner chose (routeCompany has the rules). A request (a DM, a mention
 * of the bot or of an agent by name) from a linked person is recorded for
 * its agent with that person as the sender, the principal its agent acts
 * for. A channel with listen all records every other message as context
 * (is_request false, status context), strangers' too, with their provider
 * id and no member; context is never answered and never acted on. A
 * stranger's request gets the link handshake in a DM, and "message me
 * directly" in a channel. An agent that is on hold, paused or whose host is
 * down gets the same once-per-spell line, with its name. A request is
 * checked like every other door (agent-access.ts): someone the agent is not
 * available to, or one only reachable through its orchestrator, is told so and the
 * agent never sees it; one that asks first asks its managers once per
 * conversation, and the person's messages there go through once approved.
 *
 * Replies to a message an agent started (POST /api/v1/chat/messages): in
 * its thread, quoting it, or in a DM the next messages after it, go back to
 * that agent (route reply on the company bot; reply_to_id names the started
 * message on both). Files sent with a message are recorded as references
 * (attachments) and fetched only when the agent asks; a message with only a
 * file is a message like any other.
 *
 * Nothing logs a token, and message text never reaches a log.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;
type Message = Extract<ParsedInbound, { kind: 'message' }>;
type Ctx = { connection: Row; adapter: ChatAdapter; credentials: ChatCredentials };

export interface InboundResult {
  status: number;
  body: Record<string, unknown>;
}

/** Inbound messages per connection per minute. */
export const CHAT_RATE_LIMIT = 120;
/** Inbound messages per sender per minute, so one stranger cannot flood a public bot. */
export const CHAT_SENDER_RATE_LIMIT = 20;
const CHAT_RATE_WINDOW_SECONDS = 60;
/** Messages held while an assistant was paused that reach it when it works again: the newest this many. */
export const HELD_CHAT_LIMIT = 20;

const done = (body: Record<string, unknown>, status = 200): InboundResult => ({ status, body });
/** The one answer for an unknown connection, a bad signature, no adapter or unreadable credentials. */
const refused = (): InboundResult => done({ error: 'Unauthorized' }, 401);

/**
 * Answers in the conversation the message came from (in a company channel,
 * threaded under it), recorded as outbound; a send failure is recorded,
 * never thrown.
 */
async function answer(
  service: SupabaseClient,
  ctx: Ctx,
  inbound: { id: string; conversationId: string; threadId: string | null; replyTo?: string | null },
  text: string,
): Promise<void> {
  let externalId: string | null = null;
  let error: string | null = null;
  try {
    externalId = (await ctx.adapter.send(ctx.credentials, { conversationId: inbound.conversationId, threadId: inbound.threadId, replyTo: inbound.replyTo ?? null, text })).externalMessageId;
  } catch (failure) {
    error = failure instanceof Error ? failure.message.slice(0, 500) : 'Send failed';
    console.error(`[chat] reply on connection ${ctx.connection.id} failed: ${error}`);
  }
  await service.from('chat_messages').insert({
    connection_id: ctx.connection.id, direction: 'outbound', status: error ? 'failed' : 'sent',
    conversation_id: inbound.conversationId, thread_id: inbound.threadId, external_message_id: externalId,
    reply_to_id: inbound.id, text, error,
  });
}

/**
 * A press sent to a provider's separate interactivity address (Slack sends
 * button presses there, form encoded, signed like every Slack request).
 * Verified with the connection's own secret before anything is read, then
 * answered as its person (lib/chat/answers.ts). Telegram presses come
 * through handleChatInbound with its messages.
 */
export async function handleChatAction(
  service: SupabaseClient,
  connectionId: string,
  request: { headers: Headers; body: string },
): Promise<InboundResult> {
  let connection: Row | null;
  try {
    connection = await loadConnection(service, connectionId);
  } catch (error) {
    if (missingAssistantSchema(error as { code?: string })) return refused();
    throw error;
  }
  if (!connection || connection.enabled === false) return refused();
  const adapter = chatAdapter(connection.provider);
  if (!adapter?.parseAction) return refused();
  let credentials: ChatCredentials;
  try {
    credentials = openCredentials(connection as { id: string; credentials: string });
  } catch {
    return refused();
  }
  if (!adapter.verify({ headers: request.headers, body: request.body, credentials })) {
    await stampRefused(service, connection.id);
    return refused();
  }
  const parsed = adapter.parseAction(request.body);
  if (parsed.kind !== 'button') return done({ status: 'ignored', reason: parsed.kind === 'ignore' ? parsed.reason : 'not_a_press' });
  if (adapter.hasWorkspaces && connection.external_workspace_id && parsed.workspaceId !== connection.external_workspace_id) {
    return done({ status: 'ignored', reason: 'other_workspace' });
  }
  const { handleAnswerButton } = await import('./answers');
  const result = await handleAnswerButton(service, connection, adapter, credentials, parsed);
  await stampHeard(service, connection.id);
  return done({ status: result.outcome });
}

/** One message against a rate window; a function that returns a table answers rows. */
async function allowed(service: SupabaseClient, connectionId: string, subject: string, limit: number): Promise<boolean> {
  const { data, error } = await service.rpc('consume_chat_rate_limit', {
    p_connection_id: connectionId, p_subject: subject, p_limit: limit, p_window_seconds: CHAT_RATE_WINDOW_SECONDS,
  });
  if (error) throw error;
  const window = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean } | null;
  return window?.allowed === true;
}

export async function handleChatInbound(
  service: SupabaseClient,
  connectionId: string,
  request: { headers: Headers; body: string },
  appUrl: string,
): Promise<InboundResult> {
  let connection: Row | null;
  try {
    connection = await loadConnection(service, connectionId);
  } catch (error) {
    if (missingAssistantSchema(error as { code?: string })) return refused();
    throw error;
  }
  if (!connection) return refused();
  const adapter = chatAdapter(connection.provider);
  if (!adapter) return refused();
  let credentials: ChatCredentials;
  try {
    credentials = openCredentials(connection as { id: string; credentials: string });
  } catch {
    console.error(`[chat] connection ${connection.id}: credentials cannot be opened (APP_ENCRYPTION_KEY missing or changed)`);
    return refused();
  }
  if (!adapter.verify({ headers: request.headers, body: request.body, credentials })) {
    await stampRefused(service, connection.id);
    return refused();
  }

  const parsed: ParsedInbound = adapter.parse(request.body, request.headers);
  // Slack's URL check, signed: the signing secret works, so the connection is heard.
  if (parsed.kind === 'challenge') {
    await stampHeard(service, connection.id);
    return done({ challenge: parsed.challenge });
  }
  // A relay's hello or heartbeat (Discord): verified, so the connection is heard. Nothing is recorded.
  if (parsed.kind === 'ping') {
    await stampHeard(service, connection.id, parsed.heartbeat === true);
    return done({ status: 'ok' });
  }
  if (parsed.kind === 'ignore') return done({ status: 'ignored', reason: parsed.reason });
  // Another workspace's event (a Slack app installed twice): not this connection's.
  if (adapter.hasWorkspaces && connection.external_workspace_id && parsed.workspaceId !== connection.external_workspace_id) {
    return done({ status: 'ignored', reason: 'other_workspace' });
  }
  // A press of one of the app's answer buttons (lib/chat/answers.ts): answered as its person, never recorded as a message.
  if (parsed.kind === 'button') {
    const { handleAnswerButton } = await import('./answers');
    const result = await handleAnswerButton(service, connection, adapter, credentials, parsed);
    await stampHeard(service, connection.id);
    return done({ status: result.outcome });
  }

  // A retry of what is already recorded: nothing more to do.
  const { data: seen } = await service.from('chat_messages').select('id').eq('connection_id', connection.id).eq('dedupe_key', parsed.dedupeKey).maybeSingle();
  if (seen) return done({ status: 'duplicate', id: (seen as Row).id });

  if (!(await allowed(service, connection.id, '', CHAT_RATE_LIMIT))) return done({ error: 'Too many messages. Try again in a minute.' }, 429);
  if (!(await allowed(service, connection.id, `user:${parsed.userId}`, CHAT_SENDER_RATE_LIMIT))) return done({ error: 'Too many messages. Try again in a minute.' }, 429);

  const kind = connectionKind(connection);
  // The personal bot answers DMs only: a channel or group is never its business.
  if (kind === 'personal' && !parsed.direct) return done({ status: 'ignored', reason: 'personal_dm_only' });
  // Switched off: one line a day where someone spoke to it, never silence; nothing recorded.
  if (connection.enabled === false) {
    if (parsed.direct || parsed.addressed) await offNoticeOnce(service, { connection, adapter, credentials }, parsed);
    return done({ status: 'ignored', reason: 'connection_off' });
  }

  console.info(`[chat] inbound on ${connection.provider} ${kind} connection ${connection.id}, ${parsed.text.length} characters`);
  await service.from('chat_connections').update({ last_inbound_at: new Date().toISOString() }).eq('id', connection.id);
  const ctx: Ctx = { connection, adapter, credentials };
  if (kind === 'company') return handleCompany(service, ctx, parsed, appUrl);
  return handlePersonal(service, ctx, parsed, appUrl);
}

const missingColumn = (error: { code?: string } | null | undefined) => !!error && (error.code === '42703' || error.code === 'PGRST204');

/**
 * Records an inbound message; a race with a retry (the same dedupe key) is a
 * duplicate (null). Its files go with it; on a database before
 * 20261125001500 (no attachments column) it is recorded without them.
 */
function recorder(service: SupabaseClient, connection: Row, parsed: Message) {
  return async (fields: Row): Promise<string | null> => {
    const row: Row = {
      connection_id: connection.id, direction: 'inbound', conversation_id: parsed.conversationId, thread_id: parsed.threadId,
      external_message_id: parsed.messageId, external_user_id: parsed.userId, dedupe_key: parsed.dedupeKey, text: parsed.text.slice(0, 40000),
      ...(parsed.attachments?.length ? { attachments: parsed.attachments.slice(0, 20) } : {}), ...fields,
    };
    let { data, error } = await service.from('chat_messages').insert(row).select('id').single();
    if (missingColumn(error) && 'attachments' in row) {
      delete row.attachments;
      ({ data, error } = await service.from('chat_messages').insert(row).select('id').single());
    }
    if (error?.code === '23505') return null;
    if (error) throw error;
    return (data as Row).id as string;
  };
}

/** How long a DM stays with the agent that started it, after the last word there. */
export const STARTED_DM_STICKS_MS = 24 * 60 * 60_000;

/**
 * The message an agent started that this one answers, and that agent: a
 * thread under it or a quote of it (by the provider's message id), or, in a
 * DM, the latest word there within a day being that started message or a
 * reply already routed back to it. Null otherwise, and on a database before
 * 20261125001500.
 */
async function startedMessageAnswered(service: SupabaseClient, connectionId: string, parsed: Message): Promise<{ id: string; agentId: string } | null> {
  const refs = [...new Set([parsed.threadId, parsed.replyToMessageId].filter((ref): ref is string => !!ref))];
  if (refs.length) {
    const { data, error } = await service.from('chat_messages').select('id, agent_id')
      .eq('connection_id', connectionId).eq('conversation_id', parsed.conversationId).eq('direction', 'outbound').eq('initiated', true)
      .in('external_message_id', refs).not('agent_id', 'is', null).order('created_at', { ascending: false }).limit(1);
    if (missingColumn(error)) return null;
    if (error) throw error;
    const found = ((data ?? []) as Row[])[0];
    if (found) return { id: found.id, agentId: found.agent_id };
  }
  if (!parsed.direct) return null;
  const since = new Date(Date.now() - STARTED_DM_STICKS_MS).toISOString();
  const { data, error } = await service.from('chat_messages').select('id, direction, initiated, agent_id, route, reply_to_id')
    .eq('connection_id', connectionId).eq('conversation_id', parsed.conversationId).gte('created_at', since)
    .or('and(direction.eq.outbound,initiated.is.true),and(direction.eq.inbound,is_request.is.true,agent_id.not.is.null)')
    .order('created_at', { ascending: false }).limit(1);
  if (missingColumn(error)) return null;
  if (error) throw error;
  const latest = ((data ?? []) as Row[])[0];
  if (!latest?.agent_id) return null;
  if (latest.direction === 'outbound') return { id: latest.id, agentId: latest.agent_id };
  if (latest.route === 'reply' && latest.reply_to_id) return { id: latest.reply_to_id, agentId: latest.agent_id };
  return null;
}

/**
 * Someone not linked yet: a one-time link in a one-to-one chat, never where
 * others read it. While the last link sent is still open (unused and
 * unexpired), a reminder instead of a second link; once it is used or has
 * expired, a fresh one at once. The link names nobody as its requester: the
 * person started it themselves by messaging the bot.
 */
async function strangerWords(service: SupabaseClient, ctx: Ctx, parsed: Message, workspaceId: string | null, appUrl: string): Promise<string> {
  if (!parsed.direct) return CHAT_WORDS.linkDirectly;
  const { adapter } = ctx;
  let openQuery = service.from('identity_link_requests').select('id').eq('provider', adapter.identityProvider).eq('external_id', parsed.userId)
    .is('consumed_at', null).gt('expires_at', new Date().toISOString());
  openQuery = workspaceId === null ? openQuery.is('workspace_id', null) : openQuery.eq('workspace_id', workspaceId);
  const { data: open } = await openQuery.limit(1);
  if ((open ?? []).length) return CHAT_WORDS.linkAgain;
  const link = await createLinkRequest(service, { memberId: null, keyId: null } as unknown as { memberId: string; keyId: string | null }, {
    provider: adapter.identityProvider, external_id: parsed.userId, workspace_id: workspaceId, handle: parsed.userHandle,
  }, appUrl, { withCode: true });
  let workspace = 'this workspace';
  try { workspace = (await readStoredBrand(service)).settings.name?.trim() || workspace; } catch { /* the default name */ }
  return CHAT_WORDS.linkPrompt(workspace, link.url, link.code);
}

/** The sender: a verified identity in this connection's workspace, and its member when that is an active person. */
async function senderOf(service: SupabaseClient, ctx: Ctx, parsed: Message) {
  const workspaceId = ctx.adapter.hasWorkspaces ? (ctx.connection.external_workspace_id ?? parsed.workspaceId) : null;
  const identity = await findIdentity(service, { provider: ctx.adapter.identityProvider, external_id: parsed.userId, workspace_id: workspaceId });
  const verified = identity && identity.verified_at ? identity : null;
  let member: Row | null = null;
  if (verified) {
    const { data } = await service.from('team_members').select('id, name, role, status').eq('id', verified.member_id).maybeSingle();
    member = data as Row | null;
  }
  const person = member && member.role !== 'agent' && member.status !== 'suspended' ? member : null;
  return { workspaceId, identity: verified, member, person };
}

// ── The personal bot ──────────────────────────────────────────────────────

async function handlePersonal(service: SupabaseClient, ctx: Ctx, parsed: Message, appUrl: string): Promise<InboundResult> {
  const { connection } = ctx;
  const record = recorder(service, connection, parsed);
  const unrouted = async (fields: Row, words: string | null): Promise<InboundResult> => {
    const id = await record({ status: 'unrouted', handled_at: new Date().toISOString(), ...fields });
    if (!id) return done({ status: 'duplicate' });
    if (words) await answer(service, ctx, { id, conversationId: parsed.conversationId, threadId: parsed.threadId }, words);
    return done({ status: 'unrouted', id });
  };

  const [modules, settings] = await Promise.all([enabledModuleSet(service), readAssistantSettings(service)]);
  if (!modules.has('agents') || !settings.enabled) return unrouted({}, CHAT_WORDS.assistantsOff);

  // Who is it? Only a verified linked account in this connection's workspace says.
  const sender = await senderOf(service, ctx, parsed);
  if (!sender.identity) return unrouted({}, await strangerWords(service, ctx, parsed, sender.workspaceId, appUrl));
  if (!sender.person) return unrouted({ identity_id: sender.identity.id }, CHAT_WORDS.inactive);
  const member = sender.person;
  const known = { member_id: member.id, identity_id: sender.identity.id };

  const agent = await findPersonalAgent(service, member.id);
  if (!agent) return unrouted(known, CHAT_WORDS.noAssistant);
  const status = (await statesOf(service, [agent])).get(agent.id)!;
  const alert = alertOf(status);
  const fixer = alert ? await assistantFixer(service, agent.id, { id: member.id, role: member.role }) : 'admin';
  const quiet = {
    ctx, agentId: agent.id, conversationId: parsed.conversationId, threadId: parsed.threadId, replyTo: null,
    // The same state the person's page shows, and when that spell began: one line per chat per spell.
    spell: `${status.state}:${status.reason ?? ''}:${status.since ?? ''}`,
    text: quietWords(status, agent.name, settings.label, `${appUrl.replace(/\/+$/, '')}/assistant`, fixer),
    addressed: true,
  };
  const tellAdmins = () => alert
    ? notifyAssistantBroken(service, { id: agent.id, name: agent.name }, { id: member.id, name: member.name }, alert)
    : Promise.resolve(0);

  // Paused by its person or by an admin: held for it (unrouted, not
  // handled), never sent to it now; deliverHeldChat sends it on resume.
  if (status.state === 'paused' || (status.state === 'on_hold' && status.reason === 'paused_by_admin')) {
    const id = await record({ ...known, agent_id: agent.id, status: 'unrouted' });
    if (!id) return done({ status: 'duplicate' });
    await tellAdmins();
    await noticeOnce(service, { ...quiet, replyToId: id });
    return done({ status: 'unrouted', id, held: true });
  }

  // Anything held for it while it was paused goes first, oldest first.
  await deliverHeldChat(service, agent.id);

  // For the assistant: recorded, then sent to its webhook or left for it to
  // fetch. On hold or broken it answers once it is back; the person hears
  // why once. An answer to a message it started names that message.
  const started = await startedMessageAnswered(service, connection.id, parsed);
  const answering = started && started.agentId === agent.id ? { reply_to_id: started.id } : {};
  const id = await record({ ...known, agent_id: agent.id, status: 'pending', ...answering });
  if (!id) return done({ status: 'duplicate' });
  const result = await deliver(service, id, agent.id, modules.has('webhooks'), { legacy: true, request: true });
  await tellAdmins();
  await noticeOnce(service, { ...quiet, replyToId: id });
  return result;
}

// ── The company bot ───────────────────────────────────────────────────────

/** A company agent a connection reaches, with what its state needs. */
export interface CompanyAgent {
  id: string;
  name: string;
  is_default: boolean;
  row: Row;
}

/** What routeCompany decides for one message. */
export type CompanyRoute =
  | { kind: 'ignore'; reason: string }
  | { kind: 'request' | 'context'; agent: CompanyAgent | null; route: 'direct' | 'mention' | 'channel' | 'default' | 'reply' };

/**
 * The agent a message names: "@" and its name, case-insensitive, with no
 * letter or digit right before the @ or right after the name. The longest
 * name wins, so "@Ops AI Lead" is not read as "@Ops AI".
 */
export function agentNamed<T extends { name: string }>(text: string, agents: T[]): T | null {
  const lower = text.toLowerCase();
  const word = /[\p{L}\p{N}_]/u;
  for (const agent of [...agents].sort((a, b) => b.name.length - a.name.length)) {
    const name = agent.name.trim().toLowerCase();
    if (!name) continue;
    for (let at = lower.indexOf(`@${name}`); at !== -1; at = lower.indexOf(`@${name}`, at + 1)) {
      const before = at === 0 ? '' : lower.charAt(at - 1);
      const after = lower.charAt(at + 1 + name.length);
      if ((!before || !word.test(before)) && (!after || !word.test(after))) return agent;
    }
  }
  return null;
}

/**
 * The company bot's routing, in order:
 * 1. An agent named with "@" (one this connection reaches): a request to it (route mention).
 * 1a. An answer to a message an agent started (answering: that agent), while
 *    the connection still reaches it: a request to it (route reply).
 * 2. A DM to the bot: a request to the default agent (route direct).
 * 3. A mapped channel: a mention of the bot is a request to the mapped
 *    agent; with listen all, any other message is context for it (route channel).
 * 4. A mention of the bot in an unmapped channel: a request to the default agent (route default).
 * 5. Anything else is ignored and not recorded.
 * A request with no agent to take it (no default) is answered "No AI is set up to answer here yet."
 */
export function routeCompany(input: {
  direct: boolean;
  botMentioned: boolean;
  text: string;
  agents: CompanyAgent[];
  channel: { agent_id: string; listen: string } | null;
  /** The agent whose started message this answers, if any. */
  answering?: string | null;
}): CompanyRoute {
  const named = agentNamed(input.text, input.agents);
  const fallback = input.agents.find((agent) => agent.is_default) ?? null;
  if (named) return { kind: 'request', agent: named, route: 'mention' };
  const starter = input.answering ? input.agents.find((agent) => agent.id === input.answering) ?? null : null;
  if (starter) return { kind: 'request', agent: starter, route: 'reply' };
  if (input.direct) return { kind: 'request', agent: fallback, route: 'direct' };
  const mapped = input.channel ? input.agents.find((agent) => agent.id === input.channel!.agent_id) ?? null : null;
  if (input.channel && mapped) {
    if (input.botMentioned) return { kind: 'request', agent: mapped, route: 'channel' };
    if (input.channel.listen === 'all') return { kind: 'context', agent: mapped, route: 'channel' };
    return { kind: 'ignore', reason: 'not_addressed' };
  }
  if (input.botMentioned) return { kind: 'request', agent: fallback, route: 'default' };
  return { kind: 'ignore', reason: 'not_addressed' };
}

const COMPANY_AGENT_COLUMNS = 'id, name, status, suspended_by, suspended_at, delegate_of, created_at';

async function companyAgents(service: SupabaseClient, connectionId: string): Promise<CompanyAgent[]> {
  const { data, error } = await service.from('chat_connection_agents').select('agent_id, is_default').eq('connection_id', connectionId);
  if (error) throw error;
  const links = (data ?? []) as Row[];
  if (links.length === 0) return [];
  const { data: members, error: memberError } = await service.from('team_members').select(COMPANY_AGENT_COLUMNS)
    .in('id', links.map((link) => link.agent_id as string)).eq('role', 'agent').is('delegate_of', null);
  if (memberError) throw memberError;
  const byId = new Map(((members ?? []) as Row[]).map((member) => [member.id as string, member]));
  return links.filter((link) => byId.has(link.agent_id)).map((link) => {
    const row = byId.get(link.agent_id)!;
    return { id: row.id, name: row.name, is_default: link.is_default === true, row };
  });
}

async function handleCompany(service: SupabaseClient, ctx: Ctx, parsed: Message, appUrl: string): Promise<InboundResult> {
  const { connection } = ctx;
  // Slack sends a channel mention twice (app_mention and message, each with
  // its own event id): the message itself is recorded once. This check saves
  // the work; when both arrive at once, the unique index on the provider
  // message (20261125001100) refuses the second insert, which the recorder
  // reads as a duplicate (23505).
  if (parsed.messageId) {
    const { data: twin } = await service.from('chat_messages').select('id').eq('connection_id', connection.id).eq('direction', 'inbound')
      .eq('conversation_id', parsed.conversationId).eq('external_message_id', parsed.messageId).limit(1);
    if ((twin ?? []).length) return done({ status: 'duplicate', id: (twin as Row[])[0].id });
  }
  const botMentioned = parsed.direct || parsed.addressed === true
    || (!!connection.external_bot_id && (parsed.mentions ?? []).includes(connection.external_bot_id))
    || mentionsBot(parsed.text, connection.bot_handle);
  const [modules, agents, channelRow] = await Promise.all([
    enabledModuleSet(service),
    companyAgents(service, connection.id),
    service.from('chat_channel_routes').select('agent_id, listen').eq('connection_id', connection.id).eq('channel_id', parsed.conversationId).maybeSingle()
      .then(({ data, error }) => { if (error) throw error; return data as Row | null; }),
  ]);
  const started = await startedMessageAnswered(service, connection.id, parsed);
  let decision = routeCompany({
    direct: parsed.direct, botMentioned, text: parsed.text, agents, channel: channelRow as { agent_id: string; listen: string } | null, answering: started?.agentId ?? null,
  });
  if (decision.kind === 'ignore') return done({ status: 'ignored', reason: decision.reason });
  // A follow-up in a conversation an agent holds goes to that agent (a claim on
  // the conversation), unless the message names another agent or answers one.
  if (decision.kind === 'request' && (decision.route === 'direct' || decision.route === 'channel' || decision.route === 'default')) {
    const key = threadKeyOf({ thread_id: parsed.threadId ?? null, external_message_id: parsed.messageId ?? null, is_direct: parsed.direct }, true);
    const holderId = await conversationHolder(service, connection.id, parsed.conversationId, key);
    const holder = holderId ? agents.find((agent) => agent.id === holderId) ?? null : null;
    if (holder) decision = { ...decision, agent: holder };
  }

  const record = recorder(service, connection, parsed);
  // A channel answer starts a thread on the message; a DM answers in place.
  const replyTo = parsed.direct ? null : parsed.messageId;
  const unrouted = async (fields: Row, words: string | null): Promise<InboundResult> => {
    const id = await record({ status: 'unrouted', handled_at: new Date().toISOString(), is_direct: parsed.direct, route: decision.route, ...fields });
    if (!id) return done({ status: 'duplicate' });
    if (words) await answer(service, ctx, { id, conversationId: parsed.conversationId, threadId: parsed.threadId, replyTo }, words);
    return done({ status: 'unrouted', id });
  };
  if (!modules.has('agents')) return unrouted({}, decision.kind === 'request' ? CHAT_WORDS.agentsOff : null);

  const sender = await senderOf(service, ctx, parsed);

  // Context: recorded for the mapped agent so it knows what was said, never
  // a request. A stranger's keeps the provider id and no member.
  if (decision.kind === 'context') {
    const agent = decision.agent!;
    const id = await record({
      agent_id: agent.id, status: 'context', is_request: false, is_direct: false, route: decision.route,
      member_id: sender.person?.id ?? null, identity_id: sender.person ? sender.identity!.id : null,
    });
    if (!id) return done({ status: 'duplicate' });
    await deliver(service, id, agent.id, modules.has('webhooks'), { legacy: false, request: false });
    return done({ status: 'context', id });
  }

  // A request: only from a linked, active person.
  if (!sender.identity) return unrouted({}, await strangerWords(service, ctx, parsed, sender.workspaceId, appUrl));
  if (!sender.person) return unrouted({ identity_id: sender.identity.id }, CHAT_WORDS.inactive);
  const known = { member_id: sender.person.id, identity_id: sender.identity.id };
  const agent = decision.agent;
  if (!agent) return unrouted(known, CHAT_WORDS.noAgentHere);

  // Who can use it, only through its orchestrator, ask first: the same rule as every other door.
  // An approval covers this person and agent in this conversation.
  try {
    const pending = await gateAgentWork(service, {
      agentId: agent.id, personId: sender.person.id, byAgentId: null,
      entry: decision.route === 'mention' ? 'mention' : 'chat',
      target: `chat:${connection.id}:${parsed.conversationId}`,
      ask: { summary: `${sender.person.name ?? 'Someone'} wants to use ${agent.name} in chat` },
    });
    if (pending) return unrouted(known, CHAT_WORDS.agentAskFirst(agent.name));
  } catch (error) {
    const details = error instanceof ApiError ? (error.details as Record<string, unknown> | undefined) : undefined;
    if (details?.reason !== 'agent_not_available') throw error;
    const words = details.why === 'only_through_orchestrator' && typeof details.orchestrator_name === 'string'
      ? CHAT_WORDS.agentThroughOrchestrator(agent.name, details.orchestrator_name)
      : CHAT_WORDS.agentNotAvailable(agent.name);
    return unrouted(known, words);
  }

  const status = (await statesOf(service, [agent.row])).get(agent.id)!;
  const quiet = {
    ctx, agentId: agent.id, conversationId: parsed.conversationId, threadId: parsed.threadId, replyTo,
    spell: `${status.state}:${status.reason ?? ''}:${status.since ?? ''}`,
    text: companyQuietWords(status, agent.name),
    addressed: true,
  };
  const fields = { ...known, agent_id: agent.id, is_direct: parsed.direct, route: decision.route, ...(decision.route === 'reply' && started ? { reply_to_id: started.id } : {}) };

  // Suspended: recorded, never sent to it (its keys stop working anyway).
  if (agent.row.status === 'suspended') {
    const id = await record({ ...fields, status: 'unrouted', handled_at: new Date().toISOString() });
    if (!id) return done({ status: 'duplicate' });
    await noticeOnce(service, { ...quiet, replyToId: id });
    return done({ status: 'unrouted', id });
  }
  const id = await record({ ...fields, status: 'pending' });
  if (!id) return done({ status: 'duplicate' });
  const result = await deliver(service, id, agent.id, modules.has('webhooks'), { legacy: false, request: true });
  await noticeOnce(service, { ...quiet, replyToId: id });
  return result;
}

/**
 * Sends a recorded message to the agent's webhook: chat.message, and for a
 * personal one assistant.message too (exactly as before), or leaves it
 * pending for the poll. A request sent to any endpoint reads notified;
 * context stays context either way.
 */
async function deliver(service: SupabaseClient, id: string, agentId: string, webhooksOn: boolean, options: { legacy: boolean; request: boolean }): Promise<InboundResult> {
  const waiting = done({ status: options.request ? 'pending' : 'context', id });
  if (!webhooksOn) return waiting;
  let emitted = false;
  if (options.legacy) {
    const payload = await assistantMessagePayload(service, id);
    const { data, error } = await service.rpc('emit_assistant_message', { p_message_id: id, p_agent_id: agentId, p_data: payload });
    if (error) console.error(`[chat] could not queue assistant.message for ${id}`, error.code);
    else emitted = data === true;
  }
  try {
    const payload = await chatMessagePayload(service, id);
    const { data, error } = await service.rpc('emit_chat_message', { p_message_id: id, p_agent_id: agentId, p_data: payload });
    // Before 20261125001100 there is no chat.message: assistant.message alone.
    if (error) {
      if (!missingAssistantSchema(error)) console.error(`[chat] could not queue chat.message for ${id}`, error.code);
    } else if (data === true) emitted = true;
  } catch (error) {
    if (!missingAssistantSchema(error as { code?: string })) console.error(`[chat] could not build chat.message for ${id}`, (error as { code?: string })?.code ?? error);
  }
  if (!emitted) return waiting;
  if (options.request) await service.from('chat_messages').update({ status: 'notified' }).eq('id', id).eq('status', 'pending');
  afterResponse('webhook dispatch', () => runDispatch());
  return done({ status: options.request ? 'notified' : 'context', id });
}

/** Why it is not working, in the middle of a sentence: "its key expired or was revoked". */
const brokenWhy = (status: AssistantStatus): string =>
  status.state === 'broken' ? BROKEN_WORDS[status.reason].replace(/\.$/, '').replace(/^./, (first) => first.toLowerCase()) : '';

/**
 * The line for an assistant that will not answer right now, with why, or
 * null when it will (working, getting ready). An admin "has been told" only
 * when one was (fixer admin); otherwise it says where to fix it.
 */
export function quietWords(status: AssistantStatus, name: string, page: string, resumeUrl: string, fixer: AssistantFixer = 'admin'): string | null {
  if (status.state === 'on_hold') {
    if (status.hostDown) return QUIET_WORDS.hostDown(name, fixer);
    if (status.reason === 'paused_by_admin') return QUIET_WORDS.pausedByAdmin(name);
    return QUIET_WORDS.onHold(name);
  }
  if (status.state === 'paused') return QUIET_WORDS.paused(name, page, resumeUrl);
  if (status.state === 'broken') return QUIET_WORDS.broken(name, brokenWhy(status), fixer);
  return null;
}

/** A company agent: on hold (a pause meant to end) says it will answer; suspended, unconnected or a dead host says it can't. */
export function companyQuietWords(status: AssistantStatus, name: string): string | null {
  if (status.state === 'on_hold' && !status.hostDown && status.reason !== 'paused_by_admin') return QUIET_WORDS.onHold(name);
  if (status.state === 'on_hold' || status.state === 'paused' || status.state === 'broken') return QUIET_WORDS.companyDown(name);
  return null;
}

/** The connection was heard: a verified request, its refusals left behind. */
/**
 * The connection is heard now. A relay's heartbeat also stamps relay_seen_at
 * (20261127002600), so its silence later reads Not receiving; on a database
 * before it, only last_inbound_at is stamped.
 */
async function stampHeard(service: SupabaseClient, connectionId: string, heartbeat = false): Promise<void> {
  const now = new Date().toISOString();
  if (heartbeat) {
    const { error } = await service.from('chat_connections').update({ last_inbound_at: now, relay_seen_at: now }).eq('id', connectionId);
    if (!missingColumn(error)) return;
  }
  await service.from('chat_connections').update({ last_inbound_at: now }).eq('id', connectionId);
}

/**
 * A request to a known connection failed the provider's check: stamped at
 * most once a minute, so a flood costs no more than a write a minute.
 * Never fails the answer (a database before 20261127000100 has no column).
 */
async function stampRefused(service: SupabaseClient, connectionId: string): Promise<void> {
  try {
    const now = Date.now();
    const { data, error: readError } = await service.from('chat_connections').select('last_refused_at').eq('id', connectionId).maybeSingle();
    if (readError) return;
    const last = (data as Row | null)?.last_refused_at;
    if (last && now - new Date(last).getTime() < 60_000) return;
    const { error } = await service.from('chat_connections').update({ last_refused_at: new Date(now).toISOString() }).eq('id', connectionId);
    if (error && !missingColumn(error)) console.error(`[chat] connection ${connectionId}: could not record a refused request`, error.code);
  } catch {
    // The 401 stands either way.
  }
}

/**
 * A switched-off connection spoken to: "This chat is switched off here. Ask
 * your admin.", once a day per chat (the marker is the line's own outbound
 * row, keyed by the chat and the day). In a channel, in the message's
 * thread. Never fails the request.
 */
async function offNoticeOnce(service: SupabaseClient, ctx: Ctx, parsed: Message): Promise<void> {
  const { connection, adapter, credentials } = ctx;
  const day = new Date().toISOString().slice(0, 10);
  const marker = `off:${createHash('sha256').update([connection.id, parsed.conversationId, day].join('\n')).digest('hex')}`;
  const text = CHAT_WORDS.connectionOff;
  try {
    const { data, error } = await service.from('chat_messages').insert({
      connection_id: connection.id, direction: 'outbound', status: 'sent', conversation_id: parsed.conversationId, thread_id: parsed.threadId, text, dedupe_key: marker,
    }).select('id').single();
    if (error?.code === '23505') return;
    if (error) throw error;
    const rowId = (data as Row).id as string;
    try {
      const sent = await adapter.send(credentials, { conversationId: parsed.conversationId, threadId: parsed.threadId, replyTo: parsed.direct ? null : parsed.messageId, text });
      await service.from('chat_messages').update({ external_message_id: sent.externalMessageId }).eq('id', rowId);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message.slice(0, 500) : 'Send failed';
      await service.from('chat_messages').update({ status: 'failed', error: reason, dedupe_key: null }).eq('id', rowId);
    }
  } catch (error) {
    console.error(`[chat] off notice on connection ${connection.id} could not be recorded`, (error as { code?: string })?.code ?? error);
  }
}

/**
 * Sends a personal assistant what was held for it while it was paused (by
 * its person or an admin): inbound messages recorded for it as unrouted and
 * not yet handled. The newest HELD_CHAT_LIMIT go to it, oldest first, as
 * pending messages (and to its webhook, as any message); older ones are
 * marked handled and stay in the record. Only for an agent that is not
 * suspended. Answers how many it sent. Safe to call often: with nothing
 * held it is one read.
 */
export async function deliverHeldChat(service: SupabaseClient, agentId: string): Promise<number> {
  const { data, error } = await service.from('chat_messages').select('id, created_at')
    .eq('agent_id', agentId).eq('direction', 'inbound').eq('status', 'unrouted').is('handled_at', null)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(500);
  if (error) {
    if (missingAssistantSchema(error)) return 0;
    throw error;
  }
  const held = (data ?? []) as Row[];
  if (held.length === 0) return 0;
  const { data: agent } = await service.from('team_members').select('id, status').eq('id', agentId).maybeSingle();
  if (!agent || (agent as Row).status === 'suspended') return 0;
  const sending = held.slice(0, HELD_CHAT_LIMIT).reverse();
  const dropped = held.slice(HELD_CHAT_LIMIT).map((row) => row.id as string);
  if (dropped.length) {
    await service.from('chat_messages').update({ handled_at: new Date().toISOString() }).in('id', dropped).eq('status', 'unrouted');
  }
  const webhooksOn = (await enabledModuleSet(service)).has('webhooks');
  let sent = 0;
  for (const row of sending) {
    // Claimed one at a time, so two callers never send the same message twice.
    const { data: claimed } = await service.from('chat_messages').update({ status: 'pending' }).eq('id', row.id).eq('status', 'unrouted').is('handled_at', null).select('id');
    if (!(claimed ?? []).length) continue;
    await deliver(service, row.id as string, agentId, webhooksOn, { legacy: true, request: true });
    sent++;
  }
  return sent;
}

/** The bot's own handle (@name) in the text: a mention in a shared chat. */
function mentionsBot(text: string, handle: string | null | undefined): boolean {
  const bare = (handle ?? '').replace(/^@/, '').trim().toLowerCase();
  return bare.length > 0 && text.toLowerCase().includes(`@${bare}`);
}

/**
 * Sends the "can't answer right now" line at most once per chat per spell.
 * The marker is the notice's own outbound row: its dedupe_key hashes the
 * agent, the conversation and the spell (state, reason, when it began),
 * so the unique (connection_id, dedupe_key) index lets one notice through
 * even when two messages race. A new spell (resumed, then held again) has a
 * new start, so a new key. Only where the message spoke to the bot. A send
 * that fails is recorded as failed and frees the marker, so the next message
 * tries again; nothing here ever fails the inbound request.
 */
async function noticeOnce(service: SupabaseClient, notice: {
  ctx: Ctx;
  agentId: string; conversationId: string; threadId: string | null; replyTo: string | null; replyToId: string;
  spell: string; text: string | null; addressed: boolean;
}): Promise<void> {
  if (!notice.text || !notice.addressed) return;
  const { connection, adapter, credentials } = notice.ctx;
  try {
    const marker = `notice:${createHash('sha256').update([notice.agentId, notice.conversationId, notice.spell].join('\n')).digest('hex')}`;
    const { data, error } = await service.from('chat_messages').insert({
      connection_id: connection.id, direction: 'outbound', status: 'sent', conversation_id: notice.conversationId, thread_id: notice.threadId,
      reply_to_id: notice.replyToId, text: notice.text, dedupe_key: marker,
    }).select('id').single();
    if (error?.code === '23505') return;
    if (error) throw error;
    const rowId = (data as Row).id as string;
    try {
      const sent = await adapter.send(credentials, { conversationId: notice.conversationId, threadId: notice.threadId, replyTo: notice.replyTo, text: notice.text });
      await service.from('chat_messages').update({ external_message_id: sent.externalMessageId }).eq('id', rowId);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message.slice(0, 500) : 'Send failed';
      console.error(`[chat] notice on connection ${connection.id} failed: ${reason}`);
      await service.from('chat_messages').update({ status: 'failed', error: reason, dedupe_key: null }).eq('id', rowId);
    }
  } catch (error) {
    console.error(`[chat] notice on connection ${connection.id} could not be recorded`, (error as { code?: string })?.code ?? error);
  }
}

/**
 * After someone links their chat account from the link the bot sent them,
 * the bot says so in that chat, so they know to write again: "Linked. Nova
 * answers you here now." (their assistant's name) on the personal bot, a
 * plain "ask away" on the company bot. The chat is the newest one this
 * account wrote to on a switched-on connection of that provider (and Slack
 * workspace). Never throws: linking stands either way.
 */
export async function greetLinkedAccount(service: SupabaseClient, identity: { provider: string; external_id: string; workspace_id: string | null; member_id: string }): Promise<boolean> {
  try {
    const { data } = await service.from('chat_messages').select('id, connection_id, conversation_id, thread_id, created_at')
      .eq('direction', 'inbound').eq('external_user_id', identity.external_id).order('created_at', { ascending: false }).limit(10);
    for (const message of (data ?? []) as Row[]) {
      const connection = await loadConnection(service, message.connection_id);
      if (!connection || connection.enabled === false) continue;
      const adapter = chatAdapter(connection.provider);
      if (!adapter || adapter.identityProvider !== identity.provider) continue;
      if (adapter.hasWorkspaces && (connection.external_workspace_id ?? null) !== (identity.workspace_id ?? null)) continue;
      const credentials = openCredentials(connection as { id: string; credentials: string });
      let text: string = CHAT_WORDS.linkedCompany;
      if (connectionKind(connection) === 'personal') {
        const agent = await findPersonalAgent(service, identity.member_id);
        text = agent ? CHAT_WORDS.linked(agent.name) : CHAT_WORDS.linkedNoAssistant;
      }
      await answer(service, { connection, adapter, credentials }, { id: message.id, conversationId: message.conversation_id, threadId: message.thread_id ?? null }, text);
      return true;
    }
  } catch (error) {
    console.error('[chat] could not greet a linked account', (error as { code?: string })?.code ?? error);
  }
  return false;
}
