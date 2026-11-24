import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest } from './errors';
import type { AccessContext } from '@/lib/access-control';

/**
 * The agent event export (GET /api/v1/agent-events/export): every agent
 * event (agent_activities) and run (agent_runs), in the order they changed,
 * for a data system. pm.agent_event_export pages them in (change_txid, seq)
 * order and only from transactions that have finished, so a resumed export
 * never skips a row that committed late and never repeats one that has not
 * changed since. A row that changes again (labels edited, a run finished)
 * comes again with its new state and a higher position: load by id.
 *
 * The cursor is opaque to callers: `c1.<change_txid>.<seq>` of the last row
 * sent. No cursor starts from the beginning. Cursors are tied to the
 * database's transaction ids: after a pg_dump and restore into a new cluster,
 * a data system re-exports from the start and loads by id.
 */

export const EXPORT_LIMIT_DEFAULT = 500;
export const EXPORT_LIMIT_MAX = 1000;

const CURSOR = /^c1\.(\d{1,19})\.(\d{1,19})$/;
const TYPE = /^[a-z][a-z0-9_.]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExportPosition {
  txid: string;
  seq: string;
}

export function encodeCursor(position: ExportPosition): string {
  return `c1.${position.txid}.${position.seq}`;
}

export function decodeCursor(cursor: string | null): ExportPosition {
  if (cursor === null || cursor === '') return { txid: '0', seq: '0' };
  const match = CURSOR.exec(cursor);
  if (!match) throw badRequest('since_cursor is not a cursor this endpoint gave out', { reason: 'invalid_cursor' });
  return { txid: match[1], seq: match[2] };
}

/** A comma-separated list, each item checked; null when the parameter is absent or empty. */
function list(value: string | null, field: string, valid: RegExp, max: number): string[] | null {
  if (value === null || value.trim() === '') return null;
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  const bad = items.filter((item) => !valid.test(item));
  if (bad.length > 0) throw badRequest(`${field} holds values it cannot match: ${bad.slice(0, 5).join(', ')}`, { reason: `invalid_${field}` });
  if (items.length > max) throw badRequest(`${field} lists at most ${max} values`, { reason: `invalid_${field}` });
  return items;
}

export interface ExportQuery {
  after: ExportPosition;
  limit: number;
  types: string[] | null;
  agents: string[] | null;
}

export function parseExportQuery(searchParams: URLSearchParams): ExportQuery {
  const rawLimit = searchParams.get('limit');
  const limit = rawLimit === null ? EXPORT_LIMIT_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_LIMIT_MAX) {
    throw badRequest(`limit is a whole number from 1 to ${EXPORT_LIMIT_MAX}`, { reason: 'invalid_limit' });
  }
  return {
    after: decodeCursor(searchParams.get('since_cursor')),
    limit,
    types: list(searchParams.get('types'), 'types', TYPE, 100),
    agents: list(searchParams.get('agents'), 'agents', UUID, 200),
  };
}

/** One exported row: the stable schema the webhook agent_event.created also sends. */
export interface AgentEventRow {
  id: string;
  seq: number;
  source: 'activity' | 'run';
  occurred_at: string;
  agent_id: string | null;
  type: string;
  labels: string[];
  title: string | null;
  payload: Record<string, unknown>;
  project_id: string | null;
  task_id: string | null;
  run_id: string | null;
  principal_id: string | null;
}

export interface ExportPage {
  data: AgentEventRow[];
  next_cursor: string;
  has_more: boolean;
}

/** Postgres or PostgREST for a function the database does not have yet. */
const missingFunction = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883' || /agent_event_export/.test(error.message ?? ''));

/**
 * One page. A key that cannot read every project exports only events and
 * runs on its projects (as GET /api/v1/agent-activities lists them).
 */
export async function exportAgentEvents(service: SupabaseClient, access: AccessContext, query: ExportQuery): Promise<ExportPage> {
  const readsAll = access.api_permissions.includes('*') || access.api_permissions.includes('projects.read_all');
  if (!readsAll && access.project_ids.length === 0) return { data: [], next_cursor: encodeCursor(query.after), has_more: false };
  const { data, error } = await service.rpc('agent_event_export', {
    p_after_txid: query.after.txid,
    p_after_seq: query.after.seq,
    p_limit: query.limit + 1,
    p_types: query.types,
    p_agents: query.agents,
    p_project_ids: readsAll ? null : access.project_ids,
  });
  if (error) {
    if (missingFunction(error)) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'The export works once the database update 20261124001200_agent_event_pipeline.sql is applied', { reason: 'migration_pending' });
    }
    throw error;
  }
  const rows = (data ?? []) as { change_txid: number | string; seq: number | string; event: AgentEventRow }[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((row) => row.event),
    next_cursor: last ? encodeCursor({ txid: String(last.change_txid), seq: String(last.seq) }) : encodeCursor(query.after),
    has_more: rows.length > query.limit,
  };
}
