import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AUDIT_PAGE_SIZE,
  type AgentsPauseState,
  type AuditEntry,
  type AuditSettings,
  type AuditSettingsPatch,
} from '@/lib/audit-log';
import { resetAuditRedactKeys } from './audit-redact';
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
 * One page of the audit log, newest first, with the names of who did it and
 * who it was for. Filters: member (who), acting_for (principal), action (text
 * in the method, endpoint or entity type), from and to (days, inclusive, UTC).
 */
export async function listAuditLog(db: SupabaseClient, searchParams: URLSearchParams): Promise<{ entries: AuditEntry[]; total: number; page: number; page_size: number; names: Record<string, string> }> {
  const member = searchParams.get('member');
  const actingFor = searchParams.get('acting_for');
  const action = (searchParams.get('action') ?? '').trim();
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const page = Math.max(0, Math.floor(Number(searchParams.get('page') ?? 0)) || 0);
  if (member && !UUID.test(member)) throw badRequest('member must be a team member id');
  if (actingFor && !UUID.test(actingFor)) throw badRequest('acting_for must be a team member id');
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) throw badRequest('from and to are days: YYYY-MM-DD');
  if (action.length > 100) throw badRequest('action is 100 characters at most');

  let query = db.from('api_audit_log').select(AUDIT_COLUMNS, { count: 'exact' });
  if (member) query = query.eq('team_member_id', member);
  if (actingFor) query = query.eq('principal_id', actingFor);
  if (from) query = query.gte('timestamp', `${from}T00:00:00Z`);
  if (to) query = query.lt('timestamp', new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString());
  if (action) {
    // Commas and parentheses would break the filter list; they mean nothing in an action.
    const term = action.replace(/[,()*"\\]/g, ' ').trim();
    const method = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'].find((m) => m === term.toUpperCase());
    if (method) query = query.eq('method', method);
    else if (term) query = query.or(`endpoint.ilike.*${term}*,entity_type.ilike.*${term}*`);
  }
  const { data, count, error } = await query
    .order('timestamp', { ascending: false })
    .order('id', { ascending: false })
    .range(page * AUDIT_PAGE_SIZE, page * AUDIT_PAGE_SIZE + AUDIT_PAGE_SIZE - 1);
  if (error) throw error;
  const entries = (data ?? []) as unknown as AuditEntry[];
  const ids = [...new Set(entries.flatMap((entry) => [entry.team_member_id, entry.principal_id]).filter((id): id is string => !!id))];
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data: people, error: peopleError } = await db.from('team_members').select('id, name').in('id', ids);
    if (peopleError) throw peopleError;
    for (const person of (people ?? []) as Row[]) names[person.id as string] = person.name as string;
  }
  return { entries, total: count ?? 0, page, page_size: AUDIT_PAGE_SIZE, names };
}
