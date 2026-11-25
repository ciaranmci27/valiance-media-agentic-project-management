import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * How long a new key lasts. An agent's: the workspace's agent key lifetime
 * (business_settings.agent_key_lifetime_days), set by an Owner. A person's:
 * what they choose when they make it (expires_in_days), else the workspace's
 * personal key lifetime (business_settings.personal_key_lifetime_days, also
 * an Owner's). For anyone but an Owner, a lifetime that is set is also the
 * longest a new key may last. Null means until revoked, the default for
 * both, so nothing changes until an Owner sets one. Keys made before keep theirs.
 */

export const KEY_LIFETIME_MAX_DAYS = 3650;

const missingColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || /agent_key_lifetime_days/.test(error.message ?? ''));
const missingPersonalColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || /personal_key_lifetime_days/.test(error.message ?? ''));

/** The lifetime in days, or null (until revoked). A database before 20261124001300 has none. */
export async function agentKeyLifetimeDays(service: SupabaseClient): Promise<number | null> {
  const { data, error } = await service.from('business_settings').select('agent_key_lifetime_days').limit(1).maybeSingle();
  if (missingColumn(error)) return null;
  if (error) throw error;
  const days = (data as { agent_key_lifetime_days?: number | null } | null)?.agent_key_lifetime_days;
  return typeof days === 'number' && days > 0 ? days : null;
}

/** When a key made now for this member ends: the lifetime for an agent, null for a person. */
export async function agentKeyExpiry(service: SupabaseClient, memberId: string, now = new Date()): Promise<string | null> {
  const [{ data: member, error }, days] = await Promise.all([
    service.from('team_members').select('role').eq('id', memberId).maybeSingle(),
    agentKeyLifetimeDays(service),
  ]);
  if (error) throw error;
  if ((member as { role?: string } | null)?.role !== 'agent' || days === null) return null;
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/** Sets the lifetime (null: until revoked) on the workspace's one settings row. */
export async function setAgentKeyLifetimeDays(service: SupabaseClient, days: number | null): Promise<number | null> {
  const { data: row, error: readError } = await service.from('business_settings').select('id').limit(1).maybeSingle();
  if (readError) throw readError;
  const { data, error } = row
    ? await service.from('business_settings').update({ agent_key_lifetime_days: days }).eq('id', (row as { id: string }).id).select('agent_key_lifetime_days').single()
    : await service.from('business_settings').insert({ agent_key_lifetime_days: days }).select('agent_key_lifetime_days').single();
  if (error) throw error;
  return (data as { agent_key_lifetime_days: number | null }).agent_key_lifetime_days;
}

/** A person's default key lifetime in days, or null (until revoked). A database before 20261125000200 has none. */
export async function personalKeyLifetimeDays(service: SupabaseClient): Promise<number | null> {
  const { data, error } = await service.from('business_settings').select('personal_key_lifetime_days').limit(1).maybeSingle();
  if (missingPersonalColumn(error)) return null;
  if (error) throw error;
  const days = (data as { personal_key_lifetime_days?: number | null } | null)?.personal_key_lifetime_days;
  return typeof days === 'number' && days > 0 ? days : null;
}

/** Sets a person's default key lifetime (null: until revoked) on the workspace's one settings row. */
export async function setPersonalKeyLifetimeDays(service: SupabaseClient, days: number | null): Promise<number | null> {
  const { data: row, error: readError } = await service.from('business_settings').select('id').limit(1).maybeSingle();
  if (readError) throw readError;
  const { data, error } = row
    ? await service.from('business_settings').update({ personal_key_lifetime_days: days }).eq('id', (row as { id: string }).id).select('personal_key_lifetime_days').single()
    : await service.from('business_settings').insert({ personal_key_lifetime_days: days }).select('personal_key_lifetime_days').single();
  if (error) throw error;
  return (data as { personal_key_lifetime_days: number | null }).personal_key_lifetime_days;
}

/**
 * When a key made now for this member ends. The lifetime that applies is the
 * workspace's agent key lifetime for an agent's key, its personal key
 * lifetime for a person's. expiresInDays: what the request chose (days, or
 * null for no expiry); left out, that lifetime. An Owner's choice stands;
 * for anyone else the lifetime, when set, is also the most they may choose:
 * no expiry, or a longer one, ends at the lifetime instead.
 */
export async function newKeyExpiry(
  service: SupabaseClient,
  memberId: string,
  expiresInDays: number | null | undefined,
  granter: { role: string },
  now = new Date(),
): Promise<string | null> {
  const { data: member, error } = await service.from('team_members').select('role').eq('id', memberId).maybeSingle();
  if (error) throw error;
  const lifetime = (member as { role?: string } | null)?.role === 'agent' ? await agentKeyLifetimeDays(service) : await personalKeyLifetimeDays(service);
  const days = expiresInDays === undefined ? lifetime
    : granter.role === 'owner' || lifetime === null ? expiresInDays
    : expiresInDays === null ? lifetime : Math.min(expiresInDays, lifetime);
  return days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString();
}
