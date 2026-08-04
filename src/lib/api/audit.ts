import { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';

export function logAudit(
  supabase: SupabaseClient,
  params: {
    method: string;
    endpoint: string;
    entityType?: string;
    entityId?: string;
    apiKeyId: string;
    teamMemberId?: string | null;
    requestBody?: unknown;
    beforeSnapshot?: unknown;
    afterSnapshot?: unknown;
    statusCode: number;
    error?: string;
  }
): void {
  // Keep the request fast while guaranteeing Next.js keeps the work alive
  // after the response has been sent.
  after(async () => {
    await supabase.from('api_audit_log').insert({
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
    });
  });
}
