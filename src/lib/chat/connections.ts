import { insertAuditRows } from '@/lib/api/audit';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { appKeyReady, open, seal } from '@/lib/crypto/app-key';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { accessAllows, resolveMemberAccess } from '@/lib/api/access';
import { assistantPending, missingAssistantSchema } from '@/lib/api/assistant';
import { chatAdapter, ChatProviderError, type ChatCredentials } from './providers';
import { newRelaySecret } from './providers/discord';
import {
  chatInboundUrl, chatProviderLabel,
  type ChatChannelRouteView, type ChatConnectionAgentsInput, type ChatConnectionAgentView, type ChatConnectionKind, type ChatConnectionView,
  type ChatListenMode, type CreateChatChannelInput, type CreateChatConnection, type UpdateChatChannelInput,
} from './types';

/**
 * Chat connections, managed by an Owner: paste what the provider gave you,
 * the app checks it with the provider (and does Telegram's webhook), and
 * stores the credentials sealed with APP_ENCRYPTION_KEY (purpose chat, bound
 * to the connection's id). Without the key nothing is saved: a bot token is
 * never stored in plain text. Discord also gets a relay secret, made here
 * and answered once (relay_secret): its relay signs every message with it.
 *
 * A connection is one of two bots: personal (DMs only, to each person's own
 * assistant) or company (channels and DMs, to the company agents chosen
 * here, one of them the default, with channels mapped to an agent and a
 * listen mode each). Server only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_COLUMNS = 'id, provider, external_workspace_id, display_name, bot_handle, credentials, enabled, last_inbound_at, created_by, created_at';
export const CONNECTION_COLUMNS = `${LEGACY_COLUMNS}, kind, external_bot_id`;
const ROUTE_COLUMNS = 'id, connection_id, channel_id, channel_name, agent_id, listen';

function requireOwner(access: AccessContext) {
  if (access.role !== 'owner' || access.status !== 'active') throw forbidden('Only an Owner manages chat connections', { reason: 'owner_only' });
}

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingAssistantSchema(error)) throw assistantPending();
  throw error;
}

/** Company chat needs 20261125001100: until then a company write answers 503. */
const companyPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Company chat works once the database update 20261125001100_chat_targets.sql is applied', {
  reason: 'migration_pending',
});
const missingColumn = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || /kind|external_bot_id/.test(error.message ?? '') && /column/.test(error.message ?? ''));

export function sealCredentials(connectionId: string, credentials: ChatCredentials): string {
  return seal('chat', JSON.stringify(credentials), connectionId);
}

/** The connection's credentials; throws when APP_ENCRYPTION_KEY is missing or changed. */
export function openCredentials(row: { id: string; credentials: string }): ChatCredentials {
  return JSON.parse(open('chat', row.credentials, row.id)) as ChatCredentials;
}

/** A connection's kind; every connection before 20261125001100 is personal. */
export const connectionKind = (row: Row | null | undefined): ChatConnectionKind => (row?.kind === 'company' ? 'company' : 'personal');

export function presentConnection(row: Row, appUrl: string, extras: { agents?: ChatConnectionAgentView[]; channels?: ChatChannelRouteView[] } = {}): ChatConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    provider_label: chatProviderLabel(row.provider),
    kind: connectionKind(row),
    display_name: row.display_name,
    external_workspace_id: row.external_workspace_id ?? null,
    bot_handle: row.bot_handle ?? null,
    enabled: row.enabled !== false,
    inbound_url: chatInboundUrl(appUrl, row.id),
    last_inbound_at: row.last_inbound_at ?? null,
    created_at: row.created_at,
    agents: extras.agents ?? [],
    channels: extras.channels ?? [],
  };
}

/** One connection; on a database before 20261125001100 it reads as personal. */
export async function loadConnection(service: SupabaseClient, id: string): Promise<Row | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await service.from('chat_connections').select(CONNECTION_COLUMNS).eq('id', id).maybeSingle();
  if (missingColumn(error)) {
    const legacy = await service.from('chat_connections').select(LEGACY_COLUMNS).eq('id', id).maybeSingle();
    if (legacy.error) fail(legacy.error);
    return legacy.data ? { ...(legacy.data as Row), kind: 'personal', external_bot_id: null } : null;
  }
  if (error) fail(error);
  return (data as Row | null) ?? null;
}

/** The company agents of these connections, with names, the default first. */
async function agentsOf(service: SupabaseClient, connectionIds: string[]): Promise<Map<string, ChatConnectionAgentView[]>> {
  const out = new Map<string, ChatConnectionAgentView[]>();
  if (connectionIds.length === 0) return out;
  const { data, error } = await service.from('chat_connection_agents').select('connection_id, agent_id, is_default, created_at').in('connection_id', connectionIds).order('created_at');
  if (error) {
    if (missingAssistantSchema(error)) return out;
    throw error;
  }
  const rows = (data ?? []) as Row[];
  const names = await namesOf(service, [...new Set(rows.map((row) => row.agent_id as string))]);
  for (const row of rows) {
    const list = out.get(row.connection_id) ?? [];
    list.push({ id: row.agent_id, name: names.get(row.agent_id) ?? 'Agent', is_default: row.is_default === true });
    out.set(row.connection_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => Number(b.is_default) - Number(a.is_default));
  return out;
}

async function routesOf(service: SupabaseClient, connectionIds: string[]): Promise<Map<string, ChatChannelRouteView[]>> {
  const out = new Map<string, ChatChannelRouteView[]>();
  if (connectionIds.length === 0) return out;
  const { data, error } = await service.from('chat_channel_routes').select(ROUTE_COLUMNS).in('connection_id', connectionIds).order('created_at').order('id');
  if (error) {
    if (missingAssistantSchema(error)) return out;
    throw error;
  }
  for (const row of (data ?? []) as Row[]) {
    const list = out.get(row.connection_id) ?? [];
    list.push(presentRoute(row));
    out.set(row.connection_id, list);
  }
  return out;
}

const presentRoute = (row: Row): ChatChannelRouteView => ({
  id: row.id, channel_id: row.channel_id, channel_name: row.channel_name ?? null, agent_id: row.agent_id, listen: row.listen === 'all' ? 'all' : 'mentions',
});

async function namesOf(service: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await service.from('team_members').select('id, name').in('id', ids);
  return new Map(((data ?? []) as Row[]).map((row) => [row.id as string, row.name as string]));
}

async function presentFull(service: SupabaseClient, row: Row, appUrl: string): Promise<ChatConnectionView> {
  if (connectionKind(row) !== 'company') return presentConnection(row, appUrl);
  const [agents, channels] = await Promise.all([agentsOf(service, [row.id]), routesOf(service, [row.id])]);
  return presentConnection(row, appUrl, { agents: agents.get(row.id), channels: channels.get(row.id) });
}

export async function listChatConnections(service: SupabaseClient, access: AccessContext, appUrl: string): Promise<ChatConnectionView[]> {
  requireOwner(access);
  let { data, error }: { data: unknown; error: { code?: string; message?: string } | null } = await service.from('chat_connections').select(CONNECTION_COLUMNS).order('created_at').order('id');
  if (missingColumn(error)) ({ data, error } = await service.from('chat_connections').select(LEGACY_COLUMNS).order('created_at').order('id'));
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  const company = rows.filter((row) => connectionKind(row) === 'company').map((row) => row.id as string);
  const [agents, channels] = await Promise.all([agentsOf(service, company), routesOf(service, company)]);
  return rows.map((row) => presentConnection(row, appUrl, { agents: agents.get(row.id), channels: channels.get(row.id) }));
}

const providerError = (error: unknown): never => {
  if (error instanceof ChatProviderError) throw new ApiError(422, 'VALIDATION_ERROR', error.message, { reason: 'provider_refused', provider: error.provider, code: error.code });
  throw error;
};

/** Adds a connection: checked with the provider first, saved only once it works. */
export async function createChatConnection(
  service: SupabaseClient,
  access: AccessContext,
  memberId: string,
  input: CreateChatConnection,
  appUrl: string,
): Promise<ChatConnectionView> {
  requireOwner(access);
  if (!appKeyReady()) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Add the encryption key first (Settings > Workspace > Encryption): bot tokens are only stored encrypted.', { reason: 'encryption_key_missing' });
  }
  const kind: ChatConnectionKind = input.kind ?? 'personal';
  const adapter = chatAdapter(input.provider)!;
  const id = randomUUID();
  // Each adapter's connect returns what is stored (Telegram adds its secret token, Discord its relay secret).
  const credentials: ChatCredentials = input.provider === 'slack'
    ? { bot_token: input.bot_token, signing_secret: input.signing_secret }
    : { bot_token: input.bot_token };
  const connected = await adapter.connect({ credentials, inboundUrl: chatInboundUrl(appUrl, id), displayName: input.display_name, kind }).catch(providerError);
  const row: Row = {
    id,
    provider: input.provider,
    external_workspace_id: connected.workspaceId,
    display_name: connected.displayName.slice(0, 100),
    bot_handle: connected.botHandle,
    credentials: sealCredentials(id, connected.credentials),
    created_by: memberId,
    kind,
    external_bot_id: connected.botId,
  };
  let { data, error }: { data: unknown; error: { code?: string; message?: string } | null } = await service.from('chat_connections').insert(row).select(CONNECTION_COLUMNS).single();
  if (missingColumn(error)) {
    if (kind === 'company') {
      await adapter.disconnect(connected.credentials);
      throw companyPending();
    }
    const { kind: _kind, external_bot_id: _bot, ...legacy } = row;
    void _kind; void _bot;
    ({ data, error } = await service.from('chat_connections').insert(legacy).select(LEGACY_COLUMNS).single());
  }
  if (error?.code === '23505') {
    await adapter.disconnect(connected.credentials);
    const what = input.provider === 'slack' ? 'app' : 'bot';
    throw new ApiError(409, 'CONFLICT', `That ${chatProviderLabel(input.provider)} ${what} is already connected, or this ${input.provider === 'slack' ? 'workspace' : 'bot'} already has a ${kind} connection. A personal and a company connection each need their own ${what}.`, { reason: 'connection_exists' });
  }
  if (error) fail(error);
  await audit(service, memberId, 'POST', id, { provider: input.provider, kind, workspace: connected.workspaceId });
  const view = presentConnection(data as Row, appUrl);
  return connected.relaySecret ? { ...view, relay_secret: connected.relaySecret } : view;
}

/** Stores credentials an adapter changed while sending (Discord's channel webhooks). Never fails the send. */
export async function storeCredentials(service: SupabaseClient, connectionId: string, credentials: ChatCredentials): Promise<void> {
  try {
    const { error } = await service.from('chat_connections').update({ credentials: sealCredentials(connectionId, credentials) }).eq('id', connectionId);
    if (error) console.error(`[chat] connection ${connectionId}: could not store credentials`, error.code);
  } catch (error) {
    console.error(`[chat] connection ${connectionId}: could not seal credentials`, (error as Error)?.message);
  }
}

export async function updateChatConnection(
  service: SupabaseClient,
  access: AccessContext,
  memberId: string,
  id: string,
  patch: { display_name?: string; enabled?: boolean; new_relay_secret?: true },
  appUrl: string,
): Promise<ChatConnectionView> {
  requireOwner(access);
  const row = await loadConnection(service, id);
  if (!row) throw notFound('Chat connection');
  const { new_relay_secret: rotate, ...fields } = patch;
  const changes: Row = { ...fields };
  let relaySecret: string | null = null;
  if (rotate) {
    // The old secret stops working at once; the relay needs the new one.
    if (row.provider !== 'discord') throw new ApiError(409, 'CONFLICT', 'Only a Discord connection has a relay secret', { reason: 'no_relay' });
    let credentials: ChatCredentials;
    try {
      credentials = openCredentials(row as { id: string; credentials: string });
    } catch {
      throw new ApiError(409, 'CONFLICT', "This connection's credentials cannot be opened (the encryption key changed). Connect it again.", { reason: 'credentials_unreadable' });
    }
    relaySecret = newRelaySecret();
    changes.credentials = sealCredentials(id, { ...credentials, relay_secret: relaySecret });
  }
  if (Object.keys(changes).length) {
    const { error } = await service.from('chat_connections').update(changes).eq('id', id);
    if (error) fail(error);
  }
  await audit(service, memberId, 'PATCH', id, rotate ? { ...fields, new_relay_secret: true } : fields);
  const view = await presentFull(service, (await loadConnection(service, id))!, appUrl);
  return relaySecret ? { ...view, relay_secret: relaySecret } : view;
}

/** Removes a connection and its chat history; Telegram's webhook goes with it. */
export async function deleteChatConnection(service: SupabaseClient, access: AccessContext, memberId: string, id: string): Promise<{ id: string; deleted: true }> {
  requireOwner(access);
  const row = await loadConnection(service, id);
  if (!row) throw notFound('Chat connection');
  try {
    await chatAdapter(row.provider)?.disconnect(openCredentials(row as { id: string; credentials: string }));
  } catch {
    // A key that changed leaves nothing to undo with the provider; the row still goes.
  }
  const { error } = await service.from('chat_connections').delete().eq('id', id);
  if (error) fail(error);
  await audit(service, memberId, 'DELETE', id, { provider: row.provider });
  return { id, deleted: true };
}

// ── Company connections: agents and channels ────────────────────────────

async function requireCompany(service: SupabaseClient, access: AccessContext, id: string): Promise<Row> {
  requireOwner(access);
  const row = await loadConnection(service, id);
  if (!row) throw notFound('Chat connection');
  if (connectionKind(row) !== 'company') {
    throw new ApiError(409, 'CONFLICT', 'Only a company connection reaches chosen agents and channels. A personal one sends each person to their own assistant.', { reason: 'not_a_company_connection' });
  }
  return row;
}

/**
 * Which company agents a company connection reaches, and the default one.
 * Each must be a shared (not personal) agent that may act for people
 * (agents.act_for): it answers for the person who wrote, within what both
 * may do. Agents taken off lose their channel mappings.
 */
export async function setConnectionAgents(
  service: SupabaseClient,
  access: AccessContext,
  memberId: string,
  id: string,
  input: ChatConnectionAgentsInput,
  appUrl: string,
): Promise<ChatConnectionView> {
  const row = await requireCompany(service, access, id);
  const ids = [...new Set(input.agent_ids)];
  if (ids.length) {
    const { data, error } = await service.from('team_members').select('id, name, role, delegate_of, status').in('id', ids);
    if (error) fail(error);
    const found = new Map(((data ?? []) as Row[]).map((member) => [member.id as string, member]));
    for (const agentId of ids) {
      const agent = found.get(agentId);
      if (!agent || agent.role !== 'agent') throw new ApiError(422, 'VALIDATION_ERROR', 'agent_ids holds someone who is not an agent', { reason: 'not_an_agent', agent_id: agentId });
      if (agent.delegate_of) {
        throw new ApiError(422, 'VALIDATION_ERROR', `${agent.name} is a personal assistant: it answers its person on the personal connection, not here`, { reason: 'personal_agent', agent_id: agentId });
      }
      const agentAccess = await resolveMemberAccess(service, agentId);
      if (!agentAccess || !accessAllows(agentAccess, 'agents.act_for', 'api')) {
        throw new ApiError(422, 'VALIDATION_ERROR', `${agent.name} may not act for people yet. Grant it Act for a person in Team > Access first: it answers for whoever wrote, within what they may do.`, {
          reason: 'agent_cannot_act_for', agent_id: agentId, needs: 'agents.act_for',
        });
      }
    }
  }
  const table = () => service.from('chat_connection_agents');
  let removeQuery = table().delete().eq('connection_id', id);
  if (ids.length) removeQuery = removeQuery.not('agent_id', 'in', `(${ids.join(',')})`);
  const { error: removeError } = await removeQuery;
  if (removeError) failCompany(removeError);
  const { error: clearError } = await table().update({ is_default: false }).eq('connection_id', id).eq('is_default', true);
  if (clearError) failCompany(clearError);
  const { data: kept, error: keptError } = await table().select('agent_id').eq('connection_id', id);
  if (keptError) failCompany(keptError);
  const have = new Set(((kept ?? []) as Row[]).map((entry) => entry.agent_id as string));
  const added = ids.filter((agentId) => !have.has(agentId));
  if (added.length) {
    const { error: insertError } = await table().insert(added.map((agentId) => ({ connection_id: id, agent_id: agentId, created_by: memberId })));
    if (insertError) failCompany(insertError);
  }
  if (input.default_agent_id) {
    const { error: defaultError } = await table().update({ is_default: true }).eq('connection_id', id).eq('agent_id', input.default_agent_id);
    if (defaultError) failCompany(defaultError);
  }
  await audit(service, memberId, 'PUT', id, { agent_ids: ids, default_agent_id: input.default_agent_id }, '/agents');
  return presentFull(service, row, appUrl);
}

function failCompany(error: { code?: string; message?: string }): never {
  if (missingAssistantSchema(error)) throw companyPending();
  throw error;
}

async function requireConnectionAgent(service: SupabaseClient, connectionId: string, agentId: string) {
  const { data, error } = await service.from('chat_connection_agents').select('agent_id').eq('connection_id', connectionId).eq('agent_id', agentId).maybeSingle();
  if (error) failCompany(error);
  if (!data) throw new ApiError(422, 'VALIDATION_ERROR', 'Add that agent to this connection first, then map a channel to it', { reason: 'agent_not_on_connection' });
}

/** Maps a channel (an id, or a name the provider resolves) to one of the connection's agents. listen defaults to mentions. */
export async function addChatChannel(
  service: SupabaseClient,
  access: AccessContext,
  memberId: string,
  id: string,
  input: CreateChatChannelInput,
  appUrl: string,
): Promise<ChatConnectionView> {
  const row = await requireCompany(service, access, id);
  await requireConnectionAgent(service, id, input.agent_id);
  const adapter = chatAdapter(row.provider);
  if (!adapter) throw new ApiError(501, 'NOT_IMPLEMENTED', `${row.provider} has no adapter yet`, { reason: 'no_adapter' });
  let credentials: ChatCredentials;
  try {
    credentials = openCredentials(row as { id: string; credentials: string });
  } catch {
    throw new ApiError(409, 'CONFLICT', 'This connection\'s credentials cannot be opened (the encryption key changed). Connect it again.', { reason: 'credentials_unreadable' });
  }
  const channel = await adapter.resolveChannel(credentials, input.channel).catch(providerError);
  const listen: ChatListenMode = input.listen ?? 'mentions';
  const { error } = await service.from('chat_channel_routes').insert({
    connection_id: id, channel_id: channel.id, channel_name: channel.name, agent_id: input.agent_id, listen, created_by: memberId,
  });
  if (error?.code === '23505') throw new ApiError(409, 'CONFLICT', 'That channel is already mapped. Change its agent or listening instead.', { reason: 'channel_exists' });
  if (error) failCompany(error);
  await audit(service, memberId, 'POST', id, { channel_id: channel.id, agent_id: input.agent_id, listen }, '/channels');
  return presentFull(service, row, appUrl);
}

export async function updateChatChannel(
  service: SupabaseClient,
  access: AccessContext,
  memberId: string,
  id: string,
  routeId: string,
  patch: UpdateChatChannelInput,
  appUrl: string,
): Promise<ChatConnectionView> {
  const row = await requireCompany(service, access, id);
  if (!UUID.test(routeId)) throw notFound('Channel');
  if (patch.agent_id) await requireConnectionAgent(service, id, patch.agent_id);
  const { data, error } = await service.from('chat_channel_routes').update(patch).eq('id', routeId).eq('connection_id', id).select('id').maybeSingle();
  if (error) failCompany(error);
  if (!data) throw notFound('Channel');
  await audit(service, memberId, 'PATCH', id, { channel_route_id: routeId, ...patch }, `/channels/${routeId}`);
  return presentFull(service, row, appUrl);
}

export async function deleteChatChannel(service: SupabaseClient, access: AccessContext, memberId: string, id: string, routeId: string, appUrl: string): Promise<ChatConnectionView> {
  const row = await requireCompany(service, access, id);
  if (!UUID.test(routeId)) throw notFound('Channel');
  const { data, error } = await service.from('chat_channel_routes').delete().eq('id', routeId).eq('connection_id', id).select('id').maybeSingle();
  if (error) failCompany(error);
  if (!data) throw notFound('Channel');
  await audit(service, memberId, 'DELETE', id, { channel_route_id: routeId }, `/channels/${routeId}`);
  return presentFull(service, row, appUrl);
}

async function audit(service: SupabaseClient, memberId: string, method: string, id: string, body: Row, subpath = '') {
  const { error } = await insertAuditRows(service, {
    method, endpoint: `/api/workspace/chat-connections${method === 'POST' && !subpath ? '' : `/${id}`}${subpath}`, entity_type: 'chat_connection', entity_id: id,
    team_member_id: memberId, request_body: body, status_code: 200, via: 'app',
  });
  if (error) console.error('[chat] audit write failed', error.code);
}
