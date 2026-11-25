import { z } from 'zod';

/**
 * The audit log as Settings > Security reads it, and the settings around it.
 * Shared by the session routes and the screens.
 */

/** How long rows are kept: null keeps them forever (the default). */
export const AUDIT_RETENTION_MIN_DAYS = 30;
export const AUDIT_RETENTION_MAX_DAYS = 3650;
export const AUDIT_RETENTION_CHOICES: { value: number | null; label: string }[] = [
  { value: null, label: 'Keep forever' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
  { value: 2555, label: '7 years' },
];

const REDACT_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

export const auditSettingsSchema = z.object({
  retention_days: z.number().int().min(AUDIT_RETENTION_MIN_DAYS, `Keep rows at least ${AUDIT_RETENTION_MIN_DAYS} days`).max(AUDIT_RETENTION_MAX_DAYS).nullable().optional(),
  redact_keys: z.array(z.string().trim().regex(REDACT_KEY, 'A field name is letters, numbers, dots, dashes or underscores, 64 at most')).max(100).optional(),
}).strict().refine((body) => body.retention_days !== undefined || body.redact_keys !== undefined, 'Send retention_days or redact_keys');
export type AuditSettingsPatch = z.infer<typeof auditSettingsSchema>;

export interface AuditSettings {
  retention_days: number | null;
  redact_keys: string[];
}

export const agentsPauseSchema = z.object({ paused: z.boolean() }).strict();

export interface AgentsPauseState {
  paused_at: string | null;
  paused_by: { id: string; name: string } | null;
}

export const AUDIT_PAGE_SIZE = 50;

export interface AuditEntry {
  id: string;
  timestamp: string;
  method: string;
  endpoint: string;
  entity_type: string | null;
  entity_id: string | null;
  team_member_id: string | null;
  principal_id: string | null;
  api_key_id: string | null;
  via: 'rest' | 'mcp' | 'app' | 'mcp_oauth';
  status_code: number;
  error: string | null;
  request_body: unknown;
  before_snapshot: unknown;
  after_snapshot: unknown;
}

export interface AuditFilters {
  /** Who did it (team_member_id). */
  member: string | null;
  /** Who it was done for (principal_id). */
  actingFor: string | null;
  /** Text in the action (method, endpoint or entity type). */
  action: string;
  /** YYYY-MM-DD, inclusive. */
  from: string | null;
  to: string | null;
}

export const NO_AUDIT_FILTERS: AuditFilters = { member: null, actingFor: null, action: '', from: null, to: null };

/** The query string for /api/workspace/audit-log. */
export function auditQuery(filters: AuditFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.member) params.set('member', filters.member);
  if (filters.actingFor) params.set('acting_for', filters.actingFor);
  if (filters.action.trim()) params.set('action', filters.action.trim());
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (page > 0) params.set('page', String(page));
  return params.toString();
}

/** The action in words: what was done, to what, from where. */
export function auditActionLabel(entry: Pick<AuditEntry, 'method' | 'endpoint' | 'entity_type'>): string {
  const verb: Record<string, string> = { POST: 'Created', PUT: 'Set', PATCH: 'Changed', DELETE: 'Removed', GET: 'Read' };
  const what = (entry.entity_type ?? entry.endpoint.split('/').filter(Boolean).slice(-1)[0] ?? 'item').replace(/_/g, ' ');
  return `${verb[entry.method] ?? entry.method} ${what}`;
}

export const VIA_LABELS: Record<AuditEntry['via'], string> = { app: 'App', rest: 'API', mcp: 'MCP', mcp_oauth: 'Connected AI tool' };
