import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled, type AccessContext } from '@/lib/access-control';
import { INVOICE_WEBHOOK_EVENT_TYPES, type WebhookEndpoint } from '@/lib/types';
import { ApiError } from './errors';
import { withEndpointColumns } from '@/lib/supabase/queries';

/**
 * Webhook endpoints over the v1 API (/api/v1/webhook-endpoints), next to
 * Settings > Developers. The writes are the screen's own (queries.ts); this
 * holds what the API adds: the signing secret leaves only in the answer that
 * creates it, and filters must name things that exist.
 */

/** An endpoint as the API shows it: everything but the signing secret. */
export type PublicWebhookEndpoint = Omit<WebhookEndpoint, 'secret'>;

const PUBLIC_COLUMNS =
  'id, name, url, events, is_active, description, amount_basis, project_ids, member_id, agent_event_types, created_by, last_delivery_at, created_at, updated_at';

export function publicEndpoint(endpoint: WebhookEndpoint): PublicWebhookEndpoint {
  const { secret: _secret, ...rest } = endpoint;
  void _secret;
  // A database before 20261124001200 has no agent event filter: none (null).
  return { ...rest, agent_event_types: rest.agent_event_types ?? null };
}

/** Endpoints newest first, optionally only those filtered to one member. Never the secret. */
export async function listWebhookEndpoints(
  service: SupabaseClient,
  filter: { memberId?: string | null; active?: boolean | null } = {},
): Promise<PublicWebhookEndpoint[]> {
  const rows = await withEndpointColumns<PublicWebhookEndpoint[] | null>(PUBLIC_COLUMNS, (columns) => {
    let query = service.from('webhook_endpoints').select(columns).order('created_at', { ascending: false });
    if (filter.memberId) query = query.eq('member_id', filter.memberId);
    if (typeof filter.active === 'boolean') query = query.eq('is_active', filter.active);
    return query;
  });
  return rows ?? [];
}

const INVOICE_EVENTS: readonly string[] = INVOICE_WEBHOOK_EVENT_TYPES;

/**
 * Checks an endpoint's filters and events before a write: every project is
 * live, the member exists, and invoice events are added only while Client
 * invoicing is on. An endpoint keeps invoice events it already had while
 * invoicing is off (they send nothing until it is back), as the screen does.
 */
export async function checkWebhookFields(
  service: SupabaseClient,
  access: AccessContext,
  fields: { events?: string[]; project_ids?: string[] | null; member_id?: string | null },
  existing?: Pick<WebhookEndpoint, 'events'>,
): Promise<void> {
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
