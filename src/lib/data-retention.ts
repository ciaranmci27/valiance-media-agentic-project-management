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
  { key: 'webhook_retention_days', label: 'Webhook deliveries', help: 'Sent and failed ones. Waiting ones always stay.', minDays: 7, defaultDays: 30, module: 'webhooks' },
  { key: 'agent_health_history_days', label: 'Agent uptime history', help: 'Each agent keeps its latest state.', minDays: 7, defaultDays: 90, module: 'agents' },
  { key: 'agent_activity_retention_days', label: 'Agent events', help: 'Billing events always stay.', minDays: 30, defaultDays: null, module: 'agents' },
  { key: 'agent_run_retention_days', label: 'Agent runs', help: 'Finished runs. Runs still in use stay.', minDays: 30, defaultDays: null, module: 'agents' },
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

export const dataRetentionSchema = z.object(Object.fromEntries(
  DATA_RETENTION_FIELDS.map((field) => [field.key, z.number().int().min(field.minDays, `${field.label}: keep at least ${field.minDays} days`).max(3650).nullable().optional()]),
) as Record<DataRetentionKey, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>).strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one setting');
export type DataRetentionPatch = z.infer<typeof dataRetentionSchema>;
