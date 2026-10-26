/**
 * The communications schema: inboxes, conversations, messages, triage and
 * every other table and function of inbound communication. It is served by
 * the API like public (an exposed schema), so any client reaches it through
 * this accessor: comms(client).from('messages'), comms(client).rpc('signal').
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const COMMS_SCHEMA = 'communications';

export function comms(client: SupabaseClient) {
  return client.schema(COMMS_SCHEMA);
}
