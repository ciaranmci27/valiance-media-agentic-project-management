import { SupabaseClient } from '@supabase/supabase-js';
import { afterResponse } from './after-response';
import { currentAuditVia, currentConnection, currentPrincipalId } from './request-context';
import { auditRedactKeys, redactAuditRow } from './audit-redact';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- audit rows are plain JSON
type AuditRow = Record<string, any>;

/**
 * Writes audit rows as every server path should: bodies and snapshots
 * redacted (audit-redact.ts) and, inside a request that acts for a person,
 * principal_id set (a row that names its own is kept as it is). Answers what
 * the insert answered, so callers keep their own error handling.
 */
export async function insertAuditRows(db: SupabaseClient, rows: AuditRow | AuditRow[]): Promise<{ error: { code?: string; message: string } | null }> {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return { error: null };
  const extra = await auditRedactKeys(db);
  const principalId = currentPrincipalId();
  // Inside a Connect AI connection's request, what names the MCP door names the connection.
  const connection = currentConnection();
  const prepared = list.map((row) => {
    const named = principalId && row.principal_id === undefined ? { ...row, principal_id: principalId } : row;
    return redactAuditRow(connection && named.via === 'mcp' ? { ...named, via: 'mcp_oauth' } : named, extra);
  });
  const { error } = await db.from('api_audit_log').insert(Array.isArray(rows) ? prepared : prepared[0]);
  return { error };
}

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
  // Read while the request is still in scope; the write runs after it.
  const via = currentAuditVia();
  const principalId = currentPrincipalId();
  // Keep the request fast while guaranteeing Next.js keeps the work alive
  // after the response has been sent.
  afterResponse('audit log write', async () => {
    const { error } = await insertAuditRows(supabase, {
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
      // Sent only for MCP (and a Connect AI connection on it), so REST logging never depends on the column.
      ...(via !== 'rest' ? { via } : {}),
      // Sent only when acting for a person, so other logging never depends on the column.
      ...(principalId ? { principal_id: principalId } : {}),
    });
    if (error) throw error;
  });
}
