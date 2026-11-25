import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest } from './errors';
import { decodeCursor, encodeCursor, EXPORT_LIMIT_DEFAULT, EXPORT_LIMIT_MAX, type ExportPosition } from './agent-event-export';

/**
 * The audit log export (GET /api/v1/audit/export) for a compliance or data
 * system: every audit row in the order it was written, as the agent event
 * export pages (pm.audit_log_export, (change_txid, seq), only past finished
 * transactions), so a resumed export never skips a row that committed late.
 * Rows never change (the log is append-only), so each row comes once.
 *
 * cursor is opaque (`c1.<change_txid>.<seq>`); since (an ISO time) narrows
 * to rows written from then on. NDJSON with format=ndjson, the API
 * envelope otherwise.
 */

export interface AuditExportQuery {
  after: ExportPosition;
  limit: number;
  since: string | null;
  ndjson: boolean;
}

export function parseAuditExportQuery(searchParams: URLSearchParams): AuditExportQuery {
  const rawLimit = searchParams.get('limit');
  const limit = rawLimit === null ? EXPORT_LIMIT_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_LIMIT_MAX) {
    throw badRequest(`limit is a whole number from 1 to ${EXPORT_LIMIT_MAX}`, { reason: 'invalid_limit' });
  }
  const since = searchParams.get('since');
  if (since !== null && since !== '' && Number.isNaN(Date.parse(since))) {
    throw badRequest('since is an ISO 8601 time, such as 2026-11-01T00:00:00Z', { reason: 'invalid_since' });
  }
  const format = searchParams.get('format');
  if (format !== null && format !== 'ndjson' && format !== 'json') throw badRequest('format is ndjson or json', { reason: 'invalid_format' });
  return {
    after: decodeCursor(searchParams.get('cursor') ?? searchParams.get('since_cursor')),
    limit,
    since: since ? new Date(since).toISOString() : null,
    ndjson: format === 'ndjson',
  };
}

export interface AuditExportPage {
  data: Record<string, unknown>[];
  next_cursor: string;
  has_more: boolean;
}

const missingFunction = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883' || /audit_log_export/.test(error.message ?? ''));

export async function exportAuditLog(service: SupabaseClient, query: AuditExportQuery): Promise<AuditExportPage> {
  const { data, error } = await service.rpc('audit_log_export', {
    p_after_txid: query.after.txid,
    p_after_seq: query.after.seq,
    p_limit: query.limit + 1,
    p_since: query.since,
  });
  if (error) {
    if (missingFunction(error)) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'The export works once the database update 20261124001500_limits_audit.sql is applied', { reason: 'migration_pending' });
    }
    throw error;
  }
  const rows = (data ?? []) as { change_txid: number | string; seq: number | string; entry: Record<string, unknown> }[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((row) => row.entry),
    next_cursor: last ? encodeCursor({ txid: String(last.change_txid), seq: String(last.seq) }) : encodeCursor(query.after),
    has_more: rows.length > query.limit,
  };
}
