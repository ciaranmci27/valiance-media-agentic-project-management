import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { isModuleEnabled, type AccessContext } from '@/lib/access-control';
import { INVOICE_WEBHOOK_EVENT_TYPES, type WebhookEndpoint } from '@/lib/types';
import { ApiError, forbidden } from './errors';
import { apiKeyAllows } from './access';
import { insertWebhookEndpoint, withEndpointColumns } from '@/lib/supabase/queries';
import { sealWebhookSecret } from '@/lib/webhooks/secret';

/**
 * Webhook endpoints over the v1 API (/api/v1/webhook-endpoints), next to
 * Settings > Developers. The writes are the screen's own (queries.ts); this
 * holds what the API adds: the signing secret leaves only in the answer that
 * creates it, and filters must name things that exist.
 */

/** An endpoint as the API shows it: everything but the signing secret. */
export type PublicWebhookEndpoint = Omit<WebhookEndpoint, 'secret'>;

const PUBLIC_COLUMNS =
  'id, name, url, events, is_active, description, amount_basis, project_ids, member_id, agent_event_types, assistant_setup_id, created_by, last_delivery_at, created_at, updated_at';

export function publicEndpoint(endpoint: WebhookEndpoint): PublicWebhookEndpoint {
  const { secret: _secret, ...rest } = endpoint;
  void _secret;
  // A database before 20261124001200 has no agent event filter, before 20261125000900 no setup scope: none (null).
  return { ...rest, agent_event_types: rest.agent_event_types ?? null, assistant_setup_id: rest.assistant_setup_id ?? null };
}

/** Endpoints newest first, optionally only those filtered to one member or scoped to one assistant setup. Never the secret. */
export async function listWebhookEndpoints(
  service: SupabaseClient,
  filter: { memberId?: string | null; assistantSetupId?: string | null; active?: boolean | null } = {},
): Promise<PublicWebhookEndpoint[]> {
  const rows = await withEndpointColumns<PublicWebhookEndpoint[] | null>(PUBLIC_COLUMNS, (columns) => {
    let query = service.from('webhook_endpoints').select(columns).order('created_at', { ascending: false });
    if (filter.memberId) query = query.eq('member_id', filter.memberId);
    if (filter.assistantSetupId) query = query.eq('assistant_setup_id', filter.assistantSetupId);
    if (typeof filter.active === 'boolean') query = query.eq('is_active', filter.active);
    return query;
  });
  return rows ?? [];
}

/**
 * Adds an endpoint from the server with its secret sealed at rest (bound to
 * the endpoint's id, chosen here), or stored as given while the host has no
 * APP_ENCRYPTION_KEY. The caller keeps the plaintext to show once.
 */
export async function insertServerWebhookEndpoint(
  service: SupabaseClient,
  endpoint: Omit<Parameters<typeof insertWebhookEndpoint>[1], 'id'>,
): Promise<WebhookEndpoint> {
  const id = randomUUID();
  return insertWebhookEndpoint(service, { ...endpoint, id, secret: sealWebhookSecret(id, endpoint.secret) });
}

const INVOICE_EVENTS: readonly string[] = INVOICE_WEBHOOK_EVENT_TYPES;

/**
 * Whether a caller may scope an endpoint to an assistant setup (every
 * personal agent it made): an active Owner, or a key carrying
 * assistants.provision (the assistant host's), as for the setups
 * themselves. scopes is the key's on the api channel; null or left out for
 * a signed-in member, who must be an Owner.
 */
export function canScopeToAssistantSetup(access: AccessContext, scopes?: string[] | null): boolean {
  if (access.role === 'owner' && access.status === 'active') return true;
  // Signed in, only an Owner (the database guard says the same); assistants.provision is a key scope.
  return !!scopes && apiKeyAllows(access, scopes, 'assistants.provision');
}

/**
 * Checks an endpoint's filters and events before a write: every project is
 * live, the member exists, the assistant setup exists and the caller may
 * scope to it, and invoice events are added only while Client invoicing is
 * on. An endpoint keeps invoice events it already had while invoicing is
 * off (they send nothing until it is back), as the screen does.
 */
export async function checkWebhookFields(
  service: SupabaseClient,
  access: AccessContext,
  fields: { events?: string[]; project_ids?: string[] | null; member_id?: string | null; assistant_setup_id?: string | null },
  existing?: Pick<WebhookEndpoint, 'events'> & { member_id?: string | null; assistant_setup_id?: string | null },
  scopes?: string[] | null,
): Promise<void> {
  const memberId = fields.member_id !== undefined ? fields.member_id : existing?.member_id ?? null;
  const setupId = fields.assistant_setup_id !== undefined ? fields.assistant_setup_id : existing?.assistant_setup_id ?? null;
  if (memberId && setupId) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'An endpoint is filtered to one member or scoped to one assistant setup, not both: set the other to null', {
      reason: 'one_scope',
    });
  }
  if (fields.assistant_setup_id && fields.assistant_setup_id !== (existing?.assistant_setup_id ?? null)) {
    if (!canScopeToAssistantSetup(access, scopes)) {
      throw forbidden('Only an Owner, or a key with assistants.provision, scopes an endpoint to an assistant setup', {
        reason: 'setup_scope_not_allowed', needs: 'assistants.provision',
      });
    }
    const { data, error } = await service.from('assistant_setups').select('id').eq('id', fields.assistant_setup_id).maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(422, 'VALIDATION_ERROR', 'assistant_setup_id is not an assistant setup', { reason: 'unknown_assistant_setup' });
  }
  // Chat is private: assistant.message goes only to an endpoint filtered to a personal agent or scoped to an assistant setup.
  const events = fields.events ?? existing?.events ?? [];
  if (events.includes('assistant.message') && !setupId) {
    const { data: agent, error: agentError } = memberId
      ? await service.from('team_members').select('id, role, delegate_of').eq('id', memberId).maybeSingle()
      : { data: null, error: null };
    if (agentError) throw agentError;
    const row = agent as { role?: string; delegate_of?: string | null } | null;
    if (!row || row.role !== 'agent' || !row.delegate_of) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'assistant.message goes only to an endpoint filtered to a personal agent or scoped to an assistant setup: set member_id to that agent, or assistant_setup_id', {
        reason: 'assistant_message_needs_personal_agent',
      });
    }
  }
  // chat.message: only to an endpoint filtered to an agent (personal or company) or scoped to an assistant setup.
  if (events.includes('chat.message') && !setupId) {
    const { data: agent, error: agentError } = memberId
      ? await service.from('team_members').select('id, role').eq('id', memberId).maybeSingle()
      : { data: null, error: null };
    if (agentError) throw agentError;
    if ((agent as { role?: string } | null)?.role !== 'agent') {
      throw new ApiError(422, 'VALIDATION_ERROR', 'chat.message goes only to an endpoint filtered to an agent or scoped to an assistant setup: set member_id to that agent, or assistant_setup_id', {
        reason: 'chat_message_needs_agent',
      });
    }
  }
  if (fields.events && !isModuleEnabled(access, 'billing')) {
    const had = new Set(existing?.events ?? []);
    const added = fields.events.filter((event) => INVOICE_EVENTS.includes(event) && !had.has(event));
    if (added.length > 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', `Invoice events need Client invoicing, which is switched off: ${added.join(', ')}`, {
        reason: 'module_off',
        module: 'billing',
      });
    }
  }
  const projectIds = [...new Set(fields.project_ids ?? [])];
  if (projectIds.length > 0) {
    const { data, error } = await service.from('projects').select('id').in('id', projectIds).is('deleted_at', null);
    if (error) throw error;
    const found = new Set(((data ?? []) as { id: string }[]).map((row) => row.id));
    const missing = projectIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'project_ids holds projects that do not exist or are in Trash', { project_ids: missing });
    }
  }
  if (fields.member_id) {
    const { data, error } = await service.from('team_members').select('id').eq('id', fields.member_id).maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(422, 'VALIDATION_ERROR', 'member_id is not a team member');
  }
}
