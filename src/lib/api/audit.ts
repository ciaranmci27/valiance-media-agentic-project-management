import { SupabaseClient } from '@supabase/supabase-js';

export async function logAudit(
  supabase: SupabaseClient,
  params: {
    method: string;
    endpoint: string;
    entityType?: string;
    entityId?: string;
    apiKeyId: string;
    teamMemberId?: string | null;
    requestBody?: any;
    beforeSnapshot?: any;
    afterSnapshot?: any;
    statusCode: number;
    error?: string;
  }
): Promise<void> {
  // Fire-and-forget: don't await, don't let failures propagate
  supabase
    .from('api_audit_log')
    .insert({
      method: params.method,
      endpoint: params.endpoint,
      entity_type: params.entityType || null,
      entity_id: params.entityId || null,
      api_key_id: params.apiKeyId,
      team_member_id: params.teamMemberId || null,
      request_body: params.requestBody || null,
      before_snapshot: params.beforeSnapshot || null,
      after_snapshot: params.afterSnapshot || null,
      status_code: params.statusCode,
      error: params.error || null,
    })
    .then(() => {
      // Opportunistic cleanup: ~1% chance per write
      if (Math.random() < 0.01) {
        supabase.rpc('cleanup_api_audit_log').then(() => {}, () => {});
      }
    }, () => {});
}
