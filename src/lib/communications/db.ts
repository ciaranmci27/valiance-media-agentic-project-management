/**
 * The Inbox's tables: inboxes, conversations, messages, triage and every
 * other table and function of inbound communication. Since 2.0 they live in
 * the app's schema (pm) with everything else; this accessor stays so the
 * Inbox code reads the same: comms(client).from('messages'),
 * comms(client).rpc('signal').
 *
 * Cached reads and live sync still label these tables `communications.<name>`
 * (INBOX_CACHE_PREFIX), so an Inbox table and a core table of a similar name
 * never share a cache entry.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PM_SCHEMA } from '@/lib/supabase/schema';

/** The schema the Inbox's tables are in (the app's own, since 2.0). */
export const COMMS_SCHEMA = PM_SCHEMA;

/** The label cached reads and live sync give the Inbox's tables. */
export const INBOX_CACHE_PREFIX = 'communications';

/** The Inbox's tables (in pm since 2.0), for live sync to label them. */
export const INBOX_TABLE_NAMES: ReadonlySet<string> = new Set([
  'answers', 'attachments', 'client_addresses', 'client_domains', 'conversation_projects', 'conversations', 'endpoints',
  'files', 'ignored_addresses', 'inbox_access', 'inboxes', 'maintenance_runs', 'meetings', 'message_candidates',
  'message_endpoints', 'messages', 'own_domains', 'participants', 'plan_items', 'plans', 'reply_drafts', 'reply_points',
  'sender_rules', 'task_links', 'triage', 'conversation_participants',
]);

export function comms(client: SupabaseClient) {
  return client.schema(COMMS_SCHEMA);
}
