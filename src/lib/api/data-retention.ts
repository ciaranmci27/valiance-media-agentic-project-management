import type { SupabaseClient } from '@supabase/supabase-js';
import { DATA_RETENTION_DEFAULTS, DATA_RETENTION_KEYS, type DataRetentionPatch, type DataRetentionSettings } from '@/lib/data-retention';
import { ApiError } from './errors';
import { missingLimitsSchema } from './agent-limits';

/**
 * Keeping data (Settings > Security): the retention settings on the business
 * row, read and written by the server for an Owner. The daily job
 * pm.apply_data_retention applies them.
 */

const COLUMNS = DATA_RETENTION_KEYS.join(', ');

const migrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'This works once the database update 20261125001300_watchdog_retention.sql is applied', { reason: 'migration_pending' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- read field by field
type Row = Record<string, any>;

function settingsOf(row: Row | null): DataRetentionSettings {
  if (!row) return { ...DATA_RETENTION_DEFAULTS };
  return Object.fromEntries(DATA_RETENTION_KEYS.map((key) => [key, typeof row[key] === 'number' ? row[key] : null])) as DataRetentionSettings;
}

export async function dataRetentionSettings(db: SupabaseClient): Promise<DataRetentionSettings> {
  const { data, error } = await db.from('business_settings').select(`id, ${COLUMNS}`).limit(1).maybeSingle();
  if (error) {
    if (missingLimitsSchema(error)) throw migrationPending();
    throw error;
  }
  return settingsOf(data as Row | null);
}

/** Writes the settings sent (null keeps forever), keeping the rest. */
export async function setDataRetentionSettings(db: SupabaseClient, patch: DataRetentionPatch): Promise<DataRetentionSettings> {
  const { data: row, error: readError } = await db.from('business_settings').select('id').limit(1).maybeSingle();
  if (readError) throw readError;
  const changes: Row = {};
  for (const key of DATA_RETENTION_KEYS) if (patch[key] !== undefined) changes[key] = patch[key];
  const { error } = row
    ? await db.from('business_settings').update(changes).eq('id', (row as Row).id)
    : await db.from('business_settings').insert(changes);
  if (error) {
    if (missingLimitsSchema(error)) throw migrationPending();
    throw error;
  }
  return dataRetentionSettings(db);
}

/** A setting the retention preview counts: Keeping data's, or the audit log's (audit_retention_days). */
export type RetentionPreviewKey = (typeof DATA_RETENTION_KEYS)[number] | 'audit_retention_days';

/**
 * About how many rows each period would remove at the next daily cleanup
 * (chat: how many texts it would blank), counted the way the jobs choose
 * them (pm.apply_data_retention, pm.purge_audit_log) less the few rows they
 * keep for state. Null for a period kept forever or a table this database
 * lacks. Nothing changes.
 */
export async function retentionPreview(db: SupabaseClient, periods: Partial<Record<RetentionPreviewKey, number | null>>, now: Date = new Date()): Promise<Partial<Record<RetentionPreviewKey, number | null>>> {
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const count = async (key: RetentionPreviewKey, days: number): Promise<number | null> => {
    const before = cutoff(days);
    const head = { count: 'exact' as const, head: true };
    const query = key === 'webhook_retention_days'
      ? db.from('webhook_deliveries').select('id', head).in('status', ['succeeded', 'failed']).lt('created_at', before)
      : key === 'agent_health_history_days'
        ? db.from('agent_health_history').select('id', head).lt('changed_at', before)
        : key === 'agent_activity_retention_days'
          ? db.from('agent_activities').select('id', head).lt('created_at', before).not('activity_type', 'like', 'billing.%')
          : key === 'agent_run_retention_days'
            ? db.from('agent_runs').select('id', head).neq('status', 'running').lt('finished_at', before)
            : key === 'chat_retention_days'
              ? db.from('chat_messages').select('id', head).neq('text', '').lt('created_at', before)
              : db.from('api_audit_log').select('id', head).lt('timestamp', before);
    const { count: rows, error } = await query;
    return error ? null : rows ?? 0;
  };
  const entries = await Promise.all(Object.entries(periods).map(async ([key, days]) => [
    key, typeof days === 'number' && days > 0 ? await count(key as RetentionPreviewKey, days) : null,
  ] as const));
  return Object.fromEntries(entries);
}
