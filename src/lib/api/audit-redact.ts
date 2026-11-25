import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * What the audit log stores of a request body or snapshot, decided when the
 * row is written: values under sensitive field names become [redacted] at
 * any depth (null stays null, so a cleared secret still shows), long free
 * text (email bodies, chat text) is cut short, and any other very long
 * string too. The database applies the same field rule to the rows it
 * writes itself (pm.audit_sensitive_key, pm.audit_redact).
 *
 * A field is sensitive when its name holds a word such as secret, password
 * or token (never a count or id of one: tokens_in, token_id), names an API,
 * private, signing or similar key (api_key, signing_key, key_hash, key), or
 * is in the workspace's own list (Settings > Security, audit_redact_keys).
 *
 * On a webhook endpoint's row, a url or webhook_url keeps only its scheme and
 * host: Slack, Discord and Zapier-style addresses carry their token in the
 * path.
 */

export const REDACTED = '[redacted]';

const SECRET_WORDS = new Set(['secret', 'secrets', 'password', 'passwd', 'pwd', 'token', 'authorization', 'cookie', 'apikey', 'credential', 'credentials']);
const EXACT = new Set(['key', 'key_hash', 'x-api-key', 'apikey']);
const SAFE_LAST = new Set(['id', 'ids', 'count', 'prefix', 'at', 'type', 'scope', 'scopes', 'status', 'name', 'length', 'expires', 'version']);
const KEY_KINDS = new Set(['api', 'private', 'signing', 'encryption', 'secret', 'access', 'app', 'master', 'license', 'bot', 'service', 'webhook']);

/** Free text kept to a short excerpt: the change is logged, not the message. */
const FREE_TEXT = new Set(['body', 'body_text', 'body_html', 'html', 'text', 'content', 'message', 'transcript', 'raw', 'raw_email', 'markdown', 'reply', 'draft']);
export const FREE_TEXT_MAX = 280;
export const STRING_MAX = 2000;

/** The words of a field name: camelCase and any separator split, lowercased. */
function words(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function isSensitiveKey(name: string, extra: readonly string[] = []): boolean {
  const lower = name.toLowerCase();
  if (extra.some((key) => key.toLowerCase() === lower)) return true;
  if (EXACT.has(lower)) return true;
  const parts = words(name);
  if (parts.length === 0) return false;
  const last = parts[parts.length - 1];
  if (SAFE_LAST.has(last)) return false;
  // Joined camelCase: apiKey is one word in the database's rule.
  if (parts.some((part) => SECRET_WORDS.has(part)) || SECRET_WORDS.has(parts.join(''))) return true;
  return last === 'key' && parts.length > 1 && KEY_KINDS.has(parts[parts.length - 2]);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... [truncated, ${text.length} characters]` : text;
}

const WEBHOOK_URL_KEYS = new Set(['url', 'webhook_url']);

/** scheme://host of an address, never its path or query (where a webhook's token lives). */
export function urlOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return REDACTED;
  }
}

export interface RedactOptions {
  /** A webhook endpoint's row: url and webhook_url keep only scheme://host. */
  webhookUrls?: boolean;
}

/** A value as the audit log stores it. */
export function redactForAudit(value: unknown, extra: readonly string[] = [], field: string | null = null, depth = 0, options: RedactOptions = {}): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    if (options.webhookUrls && field && WEBHOOK_URL_KEYS.has(field.toLowerCase())) return urlOrigin(value);
    return cut(value, field && FREE_TEXT.has(field.toLowerCase()) ? FREE_TEXT_MAX : STRING_MAX);
  }
  if (typeof value !== 'object') return value;
  // Deeper than anything the API accepts: summarised, never walked forever.
  if (depth > 20) return '[nested too deep]';
  if (Array.isArray(value)) return value.map((item) => redactForAudit(item, extra, field, depth + 1, options));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = item !== null && item !== undefined && isSensitiveKey(key, extra) ? REDACTED : redactForAudit(item, extra, key, depth + 1, options);
  }
  return out;
}

/** Whether an audit row is about a webhook endpoint (its url keeps only scheme://host). */
export function isWebhookRow(row: Record<string, unknown>): boolean {
  return (typeof row.entity_type === 'string' && /^webhook_endpoints?$/.test(row.entity_type))
    || (typeof row.endpoint === 'string' && /\/webhook-endpoints(\/|$)/.test(row.endpoint));
}

const EXTRA_TTL_MS = 60_000;
let extraCache: { keys: string[]; at: number } | null = null;

/** The workspace's own field names to redact (business_settings.audit_redact_keys), cached a minute per server. */
export async function auditRedactKeys(db: SupabaseClient): Promise<string[]> {
  if (extraCache && Date.now() - extraCache.at < EXTRA_TTL_MS) return extraCache.keys;
  const { data, error } = await db.from('business_settings').select('audit_redact_keys').limit(1).maybeSingle();
  // A database before the column has no list of its own.
  const keys = !error && Array.isArray((data as { audit_redact_keys?: unknown } | null)?.audit_redact_keys)
    ? ((data as { audit_redact_keys: unknown[] }).audit_redact_keys).filter((key): key is string => typeof key === 'string')
    : [];
  extraCache = { keys, at: Date.now() };
  return keys;
}

/** Forget the cached list (the Owner just changed it). */
export function resetAuditRedactKeys() {
  extraCache = null;
}

/** The body and snapshot columns of an audit row, redacted. */
export function redactAuditRow<T extends Record<string, unknown>>(row: T, extra: readonly string[]): T {
  const out: Record<string, unknown> = { ...row };
  const options: RedactOptions = { webhookUrls: isWebhookRow(row) };
  for (const column of ['request_body', 'before_snapshot', 'after_snapshot']) {
    if (out[column] !== undefined && out[column] !== null) out[column] = redactForAudit(out[column], extra, null, 0, options);
  }
  if (typeof out.error === 'string') out.error = cut(out.error, STRING_MAX);
  return out as T;
}
