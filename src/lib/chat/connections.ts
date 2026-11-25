import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { appKeyReady, open, seal } from '@/lib/crypto/app-key';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { assistantPending, missingAssistantSchema } from '@/lib/api/assistant';
import { chatAdapter, ChatProviderError, type ChatCredentials } from './providers';
import { chatInboundUrl, chatProviderLabel, type ChatConnectionView, type CreateChatConnection } from './types';

/**
 * Chat connections, managed by an Owner: paste what the provider gave you,
 * the app checks it with the provider (and does Telegram's webhook), and
 * stores the credentials sealed with APP_ENCRYPTION_KEY (purpose chat, bound
 * to the connection's id). Without the key nothing is saved: a bot token is
 * never stored in plain text. Server only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONNECTION_COLUMNS = 'id, provider, external_workspace_id, display_name, bot_handle, credentials, enabled, last_inbound_at, created_by, created_at';

function requireOwner(access: AccessContext) {
  if (access.role !== 'owner' || access.status !== 'active') throw forbidden('Only an Owner manages chat connections', { reason: 'owner_only' });
}

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingAssistantSchema(error)) throw assistantPending();
  throw error;
}

export function sealCredentials(connectionId: string, credentials: ChatCredentials): string {
  return seal('chat', JSON.stringify(credentials), connectionId);
}

/** The connection's credentials; throws when APP_ENCRYPTION_KEY is missing or changed. */
export function openCredentials(row: { id: string; credentials: string }): ChatCredentials {
  return JSON.parse(open('chat', row.credentials, row.id)) as ChatCredentials;
}

export function presentConnection(row: Row, appUrl: string): ChatConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    provider_label: chatProviderLabel(row.provider),
    display_name: row.display_name,
    external_workspace_id: row.external_workspace_id ?? null,
    bot_handle: row.bot_handle ?? null,
    enabled: row.enabled !== false,
    inbound_url: chatInboundUrl(appUrl, row.id),
    last_inbound_at: row.last_inbound_at ?? null,
    created_at: row.created_at,
  };
}

export async function loadConnection(service: SupabaseClient, id: string): Promise<Row | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await service.from('chat_connections').select(CONNECTION_COLUMNS).eq('id', id).maybeSingle();
  if (error) fail(error);
  return (data as Row | null) ?? null;
}

export async function listChatConnections(service: SupabaseClient, access: AccessContext, appUrl: string): Promise<ChatConnectionView[]> {
  requireOwner(access);
  const { data, error } = await service.from('chat_connections').select(CONNECTION_COLUMNS).order('created_at').order('id');
  if (error) fail(error);
  return ((data ?? []) as Row[]).map((row) => presentConnection(row, appUrl));
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
  const adapter = chatAdapter(input.provider)!;
  const id = randomUUID();
  const credentials: ChatCredentials = input.provider === 'slack'
    ? { bot_token: input.bot_token, signing_secret: input.signing_secret }
    : { bot_token: input.bot_token };
  const connected = await adapter.connect({ credentials, inboundUrl: chatInboundUrl(appUrl, id), displayName: input.display_name }).catch(providerError);
  const { data, error } = await service.from('chat_connections').insert({
    id,
    provider: input.provider,
    external_workspace_id: connected.workspaceId,
    display_name: connected.displayName.slice(0, 100),
    bot_handle: connected.botHandle,
    credentials: sealCredentials(id, connected.credentials),
    created_by: memberId,
  }).select(CONNECTION_COLUMNS).single();
  if (error?.code === '23505') {
    await adapter.disconnect(connected.credentials);
    throw new ApiError(409, 'CONFLICT', `That ${chatProviderLabel(input.provider)} ${input.provider === 'slack' ? 'workspace' : 'bot'} is already connected`, { reason: 'connection_exists' });
  }
  if (error) fail(error);
  await audit(service, memberId, 'POST', id, { provider: input.provider, workspace: connected.workspaceId });
  return presentConnection(data as Row, appUrl);
}

export async function updateChatConnection(
  service: SupabaseClient,
  access: AccessContext,
  memberId: string,
  id: string,
  patch: { display_name?: string; enabled?: boolean },
  appUrl: string,
): Promise<ChatConnectionView> {
  requireOwner(access);
  const row = await loadConnection(service, id);
  if (!row) throw notFound('Chat connection');
  const { data, error } = await service.from('chat_connections').update(patch).eq('id', id).select(CONNECTION_COLUMNS).single();
  if (error) fail(error);
  await audit(service, memberId, 'PATCH', id, patch);
  return presentConnection(data as Row, appUrl);
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

async function audit(service: SupabaseClient, memberId: string, method: string, id: string, body: Row) {
  const { error } = await service.from('api_audit_log').insert({
    method, endpoint: `/api/workspace/chat-connections${method === 'POST' ? '' : `/${id}`}`, entity_type: 'chat_connection', entity_id: id,
    team_member_id: memberId, request_body: body, status_code: 200, via: 'app',
  });
  if (error) console.error('[chat] audit write failed', error.code);
}
