import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AUDIT_PAGE_SIZE,
  auditReferencedIds,
  type AgentsPauseState,
  type AuditEntry,
  type AuditSettings,
  type AuditSettingsPatch,
} from '@/lib/audit-log';
import { resetAuditRedactKeys } from './audit-redact';
import { MAX_PAGE, readPage } from './pagination';
import { ApiError, badRequest } from './errors';
import { missingLimitsSchema } from './agent-limits';

/**
 * The workspace's kill switch for agents and its audit settings, both on the
 * business row, and the audit log as Settings > Security pages it. Writes go
 * through the client the caller passes: a session route passes one that
 * names the signed-in member (getActorClient(..., 'app')), so the database
 * audits the change itself (pm.audit_app_change).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const migrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'This works once the database update 20261124001500_limits_audit.sql is applied', { reason: 'migration_pending' });

async function settingsRow(db: SupabaseClient, columns: string): Promise<Row | null> {
  const { data, error } = await db.from('business_settings').select(`id, ${columns}`).limit(1).maybeSingle();
  if (error) {
    if (missingLimitsSchema(error)) return null;
    throw error;
  }
  return (data as Row | null) ?? null;
}

async function writeSettings(db: SupabaseClient, id: string | null, changes: Row): Promise<void> {
  const { error } = id
    ? await db.from('business_settings').update(changes).eq('id', id)
    : await db.from('business_settings').insert(changes);
  if (error) {
    if (missingLimitsSchema(error)) throw migrationPending();
    throw error;
  }
}

export async function agentsPauseState(db: SupabaseClient): Promise<AgentsPauseState> {
  const row = await settingsRow(db, 'agents_paused_at, agents_paused_by');
  if (!row?.agents_paused_at) return { paused_at: null, paused_by: null };
  let pausedBy: AgentsPauseState['paused_by'] = null;
  if (row.agents_paused_by) {
    const { data } = await db.from('team_members').select('id, name').eq('id', row.agents_paused_by).maybeSingle();
    pausedBy = data ? { id: (data as Row).id, name: (data as Row).name } : null;
  }
  return { paused_at: row.agents_paused_at as string, paused_by: pausedBy };
}

/** Pauses or resumes every agent. Pausing again keeps when and by whom it was first paused. */
export async function setAgentsPaused(db: SupabaseClient, paused: boolean, memberId: string): Promise<AgentsPauseState> {
  const row = await settingsRow(db, 'agents_paused_at');
  if (row === null) {
    // No row yet, or no column yet: tell which.
    const { error } = await db.from('business_settings').select('agents_paused_at').limit(1);
    if (error) throw migrationPending();
  }
  const already = !!row?.agents_paused_at;
  if (paused && !already) await writeSettings(db, row?.id ?? null, { agents_paused_at: new Date().toISOString(), agents_paused_by: memberId });
  if (!paused && already) await writeSettings(db, row!.id as string, { agents_paused_at: null, agents_paused_by: null });
  return agentsPauseState(db);
}

export async function auditSettings(db: SupabaseClient): Promise<AuditSettings> {
  const row = await settingsRow(db, 'audit_retention_days, audit_redact_keys');
  return {
    retention_days: typeof row?.audit_retention_days === 'number' ? row.audit_retention_days : null,
    redact_keys: Array.isArray(row?.audit_redact_keys) ? row!.audit_redact_keys as string[] : [],
  };
}

export async function setAuditSettings(db: SupabaseClient, patch: AuditSettingsPatch): Promise<AuditSettings> {
  const row = await settingsRow(db, 'audit_retention_days');
  if (row === null) {
    const { error } = await db.from('business_settings').select('audit_retention_days').limit(1);
    if (error) throw migrationPending();
  }
  const changes: Row = {};
  if (patch.retention_days !== undefined) changes.audit_retention_days = patch.retention_days;
  if (patch.redact_keys !== undefined) changes.audit_redact_keys = [...new Set(patch.redact_keys.map((key) => key.trim()).filter(Boolean))];
  await writeSettings(db, row?.id ?? null, changes);
  resetAuditRedactKeys();
  return auditSettings(db);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const AUDIT_COLUMNS = 'id, timestamp, method, endpoint, entity_type, entity_id, team_member_id, principal_id, api_key_id, via, status_code, error, request_body, before_snapshot, after_snapshot';

/**
 * A day bound for the audit filters: an ISO time as given (Settings sends
 * the viewer's local day as from = its start, to = the start of the day
 * after, exclusive), or a day (YYYY-MM-DD, UTC; to is then inclusive).
 */
function auditBound(value: string | null, end: boolean): string | null {
  if (!value) return null;
  if (DAY.test(value)) return end ? new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString() : `${value}T00:00:00Z`;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw badRequest('from and to are days (YYYY-MM-DD) or ISO times');
  return new Date(at).toISOString();
}

/** The audit log's filters from the query string, checked. */
function auditFilters(searchParams: URLSearchParams) {
  const member = searchParams.get('member');
  const actingFor = searchParams.get('acting_for');
  const action = (searchParams.get('action') ?? '').trim();
  if (member && !UUID.test(member)) throw badRequest('member must be a team member id');
  if (actingFor && !UUID.test(actingFor)) throw badRequest('acting_for must be a team member id');
  if (action.length > 100) throw badRequest('action is 100 characters at most');
  return { member, actingFor, action, from: auditBound(searchParams.get('from'), false), to: auditBound(searchParams.get('to'), true), before: auditCursor(searchParams.get('before')) };
}

/**
 * Show more's cursor: the time and id of the last row shown ("<timestamp>|<id>"),
 * so the next rows are the ones older than it however many arrived since.
 * Paging by offset would repeat or skip rows while the log grows.
 */
function auditCursor(raw: string | null): { timestamp: string; id: string } | null {
  if (!raw) return null;
  const [timestamp, id] = raw.split('|');
  if (!id || !UUID.test(id) || !/^[0-9T:.+\- Z]{10,40}$/.test(timestamp ?? '') || Number.isNaN(Date.parse(timestamp))) throw badRequest('before must be the time and id of a row, as "<timestamp>|<id>"');
  return { timestamp, id };
}

/** The audit log query with these filters, newest first. */
function filteredAuditQuery(db: SupabaseClient, filters: ReturnType<typeof auditFilters>, count: boolean) {
  let query = db.from('api_audit_log').select(AUDIT_COLUMNS, count ? { count: 'exact' } : undefined);
  if (filters.member) query = query.eq('team_member_id', filters.member);
  if (filters.actingFor) query = query.eq('principal_id', filters.actingFor);
  if (filters.from) query = query.gte('timestamp', filters.from);
  if (filters.to) query = query.lt('timestamp', filters.to);
  if (filters.before) {
    // Newest first by time then id, so "older" is an earlier time, or the same time and a lower id.
    const at = `"${filters.before.timestamp}"`;
    query = query.or(`timestamp.lt.${at},and(timestamp.eq.${at},id.lt.${filters.before.id})`);
  }
  if (filters.action) {
    // Commas and parentheses would break the filter list; they mean nothing in an action.
    const term = filters.action.replace(/[,()*"\\]/g, ' ').trim();
    const method = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'].find((m) => m === term.toUpperCase());
    if (method) query = query.eq('method', method);
    else if (term) query = query.or(`endpoint.ilike.*${term}*,entity_type.ilike.*${term}*`);
  }
  return query.order('timestamp', { ascending: false }).order('id', { ascending: false });
}

/** Where a referenced id's name lives: the table and its name column. */
const NAMED_TABLES: { table: string; column: string }[] = [
  { table: 'team_members', column: 'name' },
  { table: 'groups', column: 'name' },
  { table: 'projects', column: 'name' },
  { table: 'tasks', column: 'title' },
  { table: 'api_keys', column: 'name' },
  { table: 'task_templates', column: 'name' },
  { table: 'initiatives', column: 'name' },
];

/**
 * The names of who did it and who it was for; with `everything`, also of
 * each person, group, project, task, key, template and initiative a row
 * names (for the screen's plain labels: auditReferencedIds). A table a
 * database does not have is skipped.
 */
async function auditNames(db: SupabaseClient, entries: readonly AuditEntry[], everything = false): Promise<Record<string, string>> {
  const ids = [...new Set(entries.flatMap((entry) => [entry.team_member_id, entry.principal_id]).filter((id): id is string => !!id))];
  const names: Record<string, string> = {};
  for (let at = 0; at < ids.length; at += 200) {
    const { data: people, error: peopleError } = await db.from('team_members').select('id, name').in('id', ids.slice(at, at + 200));
    if (peopleError) throw peopleError;
    for (const person of (people ?? []) as Row[]) names[person.id as string] = person.name as string;
  }
  if (!everything) return names;
  const referenced = [...new Set(entries.flatMap((entry) => auditReferencedIds(entry)))].filter((id) => !(id in names));
  if (referenced.length === 0) return names;
  await Promise.all(NAMED_TABLES.map(async ({ table, column }) => {
    for (let at = 0; at < referenced.length; at += 200) {
      // includes-deleted: a record removed or in Trash still names what it was
      const { data, error } = await db.from(table).select(`id, ${column}`).in('id', referenced.slice(at, at + 200));
      if (error) return;
      for (const row of (data ?? []) as Row[]) {
        const label = row[column];
        if (typeof label === 'string' && label.trim() && !(String(row.id) in names)) names[String(row.id)] = label;
      }
    }
  }));
  return names;
}

/**
 * One page of the audit log, newest first, with the names of who did it and
 * who it was for. Filters: member (who), acting_for (principal), action (text
 * in the method, endpoint or entity type), from and to (ISO times, to
 * exclusive; or days, inclusive, UTC), before (a cursor: only rows older
 * than that row; total then counts those).
 */
export async function listAuditLog(db: SupabaseClient, searchParams: URLSearchParams): Promise<{ entries: AuditEntry[]; total: number; page: number; page_size: number; names: Record<string, string> }> {
  const filters = auditFilters(searchParams);
  // A cursor (before) reads from the top of what is older; page stays for older callers.
  const page = filters.before ? 0 : Math.min(MAX_PAGE, Math.max(0, Math.floor(Number(searchParams.get('page') ?? 0)) || 0));
  const { data, count, error } = await readPage(filteredAuditQuery(db, filters, true), { offset: page * AUDIT_PAGE_SIZE, limit: AUDIT_PAGE_SIZE });
  if (error) throw error;
  const entries = (data ?? []) as unknown as AuditEntry[];
  return { entries, total: count ?? 0, page, page_size: AUDIT_PAGE_SIZE, names: await auditNames(db, entries, true) };
}

/** The most rows one Settings export holds; past it, narrow the filters (or use the export API). */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;
const AUDIT_EXPORT_BATCH = 1000;

/**
 * Every audit row matching the Settings filters, newest first, for the
 * Export button: up to AUDIT_EXPORT_MAX_ROWS (truncated says when there were
 * more). The cursor export API (GET /api/v1/audit/export) is for systems.
 */
export async function exportAuditRows(db: SupabaseClient, searchParams: URLSearchParams): Promise<{ entries: AuditEntry[]; names: Record<string, string>; truncated: boolean }> {
  const filters = auditFilters(searchParams);
  const entries: AuditEntry[] = [];
  let truncated = false;
  for (let at = 0; ; at += AUDIT_EXPORT_BATCH) {
    const { data, error } = await filteredAuditQuery(db, filters, false).range(at, at + AUDIT_EXPORT_BATCH - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as AuditEntry[];
    entries.push(...batch);
    if (batch.length < AUDIT_EXPORT_BATCH) break;
    if (entries.length >= AUDIT_EXPORT_MAX_ROWS) {
      truncated = true;
      break;
    }
  }
  return { entries: entries.slice(0, AUDIT_EXPORT_MAX_ROWS), names: await auditNames(db, entries), truncated };
}
