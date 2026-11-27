import { z } from 'zod';

/**
 * How long the workspace keeps data that grows on its own (Settings >
 * Security > Keeping data). Each setting is a number of days on the business
 * row, or null to keep forever; pm.apply_data_retention applies them once a
 * day (20261125001300_watchdog_retention.sql).
 */
export const DATA_RETENTION_KEYS = [
  'webhook_retention_days',
  'agent_health_history_days',
  'agent_activity_retention_days',
  'agent_run_retention_days',
  'chat_retention_days',
] as const;
export type DataRetentionKey = typeof DATA_RETENTION_KEYS[number];

export type DataRetentionSettings = Record<DataRetentionKey, number | null>;

export interface DataRetentionField {
  key: DataRetentionKey;
  label: string;
  help: string;
  /** The fewest days the database accepts. */
  minDays: number;
  /** What a new workspace starts with. */
  defaultDays: number | null;
  /** Shown only while this module is on. */
  module?: 'webhooks' | 'agents';
}

export const DATA_RETENTION_FIELDS: readonly DataRetentionField[] = [
  { key: 'webhook_retention_days', label: 'Updates sent to other apps', help: 'Sent and failed ones. Ones still waiting to send always stay.', minDays: 7, defaultDays: 30, module: 'webhooks' },
  { key: 'agent_health_history_days', label: 'When agents were online', help: 'Each agent keeps whether it is online now.', minDays: 7, defaultDays: 90, module: 'agents' },
  { key: 'agent_activity_retention_days', label: 'What agents did', help: 'Anything used for billing always stays.', minDays: 30, defaultDays: null, module: 'agents' },
  { key: 'agent_run_retention_days', label: 'Finished agent work', help: 'Work an agent finished. Anything still in use stays.', minDays: 30, defaultDays: null, module: 'agents' },
  { key: 'chat_retention_days', label: 'Chat message text', help: 'The text is removed; the message stays in its thread.', minDays: 7, defaultDays: null, module: 'agents' },
];

export const DATA_RETENTION_DEFAULTS: DataRetentionSettings = Object.fromEntries(
  DATA_RETENTION_FIELDS.map((field) => [field.key, field.defaultDays]),
) as DataRetentionSettings;

const CHOICES: { value: number | null; label: string }[] = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
  { value: null, label: 'Keep forever' },
];

/** The choices one setting offers: none below its minimum, and its current value if it is not a listed one. */
export function retentionChoices(field: DataRetentionField, current: number | null): { value: number | null; label: string }[] {
  const listed = CHOICES.filter((choice) => choice.value === null || choice.value >= field.minDays);
  return current === null || listed.some((choice) => choice.value === current)
    ? listed
    : [...listed, { value: current, label: `${current} days` }].sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity));
}

// ── Shortening a period ─────────────────────────────────────────────────

/** Days, with forever (null) longer than any number of days. */
const daysOrForever = (days: number | null) => (days === null ? Infinity : days);

/** The settings whose period gets shorter (each removes older rows at the next cleanup), in the order given. */
export function shortenedRetention<K extends string>(saved: Record<K, number | null>, next: Partial<Record<K, number | null>>, keys: readonly K[]): K[] {
  return keys.filter((key) => next[key] !== undefined && daysOrForever(next[key] as number | null) < daysOrForever(saved[key]));
}

/** The daily cleanup jobs' times, UTC (pg_cron pm-retention and pm-audit-retention). */
export const DATA_RETENTION_RUN_UTC = { hour: 3, minute: 47 } as const;
export const AUDIT_RETENTION_RUN_UTC = { hour: 3, minute: 23 } as const;

/** The next time a daily UTC job runs after now. */
export function nextDailyRun(at: { hour: number; minute: number }, now: Date = new Date()): Date {
  const run = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), at.hour, at.minute));
  if (run.getTime() <= now.getTime()) run.setUTCDate(run.getUTCDate() + 1);
  return run;
}

/** How many rows a period removes, in words: "about 1,240 rows", "no rows yet". Chat text is blanked, not removed. */
export function rowsInWords(rows: number | null, unit: 'rows' | 'texts' = 'rows'): string {
  if (rows === null) return unit === 'texts' ? 'older message text' : 'older rows';
  if (rows === 0) return unit === 'texts' ? 'no message text yet' : 'no rows yet';
  const one = unit === 'texts' ? 'message text' : 'row';
  const many = unit === 'texts' ? 'message texts' : 'rows';
  return `about ${rows.toLocaleString('en-US')} ${rows === 1 ? one : many}`;
}

/**
 * The confirmation before a shorter period is saved: one line per setting,
 * what goes and about how many rows, then when and that it cannot be undone.
 */
export function retentionConfirmMessage(
  items: readonly { label: string; days: number; rows: number | null; unit?: 'rows' | 'texts' }[],
  runsAt: string,
): string {
  const lines = items.map((item) => `${item.label}: ${item.unit === 'texts' ? 'blanks' : 'removes'} ${rowsInWords(item.rows, item.unit)} older than ${item.days} days.`);
  return `${lines.join(' ')} This happens at the next daily cleanup, ${runsAt}, and cannot be undone.`;
}

export const dataRetentionSchema = z.object(Object.fromEntries(
  DATA_RETENTION_FIELDS.map((field) => [field.key, z.number().int().min(field.minDays, `${field.label}: keep at least ${field.minDays} days`).max(3650).nullable().optional()]),
) as Record<DataRetentionKey, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>).strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one setting');
export type DataRetentionPatch = z.infer<typeof dataRetentionSchema>;
