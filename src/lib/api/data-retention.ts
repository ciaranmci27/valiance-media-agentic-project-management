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
