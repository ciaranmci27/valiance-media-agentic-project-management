import type { SupabaseClient } from '@supabase/supabase-js';
import { NEW_AGENT_KEY_DAYS } from '@/lib/agent-defaults';

/**
 * How long a new key lasts. An agent's: the workspace's agent key lifetime
 * (business_settings.agent_key_lifetime_days), set by an Owner. A person's:
 * what they choose when they make it (expires_in_days), else the workspace's
 * personal key lifetime (business_settings.personal_key_lifetime_days, also
 * an Owner's). For anyone but an Owner, a lifetime that is set is also the
 * longest a new key may last. A company agent's new key with no workspace
 * lifetime set ends after NEW_AGENT_KEY_DAYS (src/lib/agent-defaults.ts);
 * an Owner may still make one that lasts until revoked (expires_in_days
 * null). A person's and a personal assistant's: null means until revoked,
 * so nothing changes for them until an Owner sets a lifetime. Keys made
 * before keep theirs.
 */

export const KEY_LIFETIME_MAX_DAYS = 3650;

/**
 * The lifetime a new key for this member gets when nothing is chosen: the
 * workspace's agent key lifetime for an agent, else NEW_AGENT_KEY_DAYS for a
 * company agent (a personal assistant's key, collected by its host, keeps
 * no default); for a person, the personal key lifetime.
 */
async function defaultLifetime(service: SupabaseClient, member: { role?: string; delegate_of?: string | null } | null): Promise<number | null> {
  if (member?.role !== 'agent') return personalKeyLifetimeDays(service);
  const workspace = await agentKeyLifetimeDays(service);
  if (workspace !== null) return workspace;
  return member.delegate_of ? null : NEW_AGENT_KEY_DAYS;
}

/** The member a key is for: its role and, for an agent, whether it is someone's personal assistant. */
async function keyMember(service: SupabaseClient, memberId: string): Promise<{ role?: string; delegate_of?: string | null } | null> {
  const { data, error } = await service.from('team_members').select('role, delegate_of').eq('id', memberId).maybeSingle();
  if (error && (error.code === '42703' || error.code === 'PGRST204')) {
    const { data: older, error: olderError } = await service.from('team_members').select('role').eq('id', memberId).maybeSingle();
    if (olderError) throw olderError;
    return older as { role?: string } | null;
  }
  if (error) throw error;
  return data as { role?: string; delegate_of?: string | null } | null;
}

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

/** When a key made now for this member ends: the default lifetime for an agent (defaultLifetime), null for a person. */
export async function agentKeyExpiry(service: SupabaseClient, memberId: string, now = new Date()): Promise<string | null> {
  const member = await keyMember(service, memberId);
  if (member?.role !== 'agent') return null;
  const days = await defaultLifetime(service, member);
  return days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString();
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
 * null for no expiry); left out, that lifetime (for a company agent with
 * none set, NEW_AGENT_KEY_DAYS). An Owner's choice stands;
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
  const member = await keyMember(service, memberId);
  const days = expiresInDays === undefined
    ? await defaultLifetime(service, member)
    : capKeyLifetime(expiresInDays, member?.role === 'agent' ? await agentKeyLifetimeDays(service) : await personalKeyLifetimeDays(service), granter.role);
  return days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString();
}

/**
 * A chosen lifetime held to the workspace's (days; null: until revoked). An
 * Owner's choice stands; for anyone else a lifetime that is set is the most
 * they get: no expiry, or a longer one, ends at the lifetime instead.
 */
export function capKeyLifetime(chosen: number | null, lifetime: number | null, granterRole: string): number | null {
  if (granterRole === 'owner' || lifetime === null) return chosen;
  return chosen === null ? lifetime : Math.min(chosen, lifetime);
}

/**
 * How long a rotated key's successor lasts, in days (null: until revoked).
 * An agent's: the default lifetime of any new agent key (the workspace's
 * agent key lifetime, else NEW_AGENT_KEY_DAYS for a company agent).
 * A person's: as long as the old key was made to last (created to expiry),
 * held to the workspace's personal key lifetime for anyone but an Owner, so
 * a rotation never turns a capped key into one that never ends.
 */
export function rotatedKeyLifetimeDays(input: {
  agent: boolean;
  old: { created_at: string; expires_at: string | null };
  agentLifetimeDays: number | null;
  personalLifetimeDays: number | null;
  granterRole: string;
}): number | null {
  if (input.agent) return input.agentLifetimeDays;
  const { created_at, expires_at } = input.old;
  const made = expires_at ? Math.max(0, Date.parse(expires_at) - Date.parse(created_at)) / 86_400_000 : null;
  // A lifetime under an hour reads as an hour, so a successor is never born expired.
  const chosen = made === null ? null : Math.max(made, 1 / 24);
  return capKeyLifetime(chosen, input.personalLifetimeDays, input.granterRole);
}

/** When a rotated key's successor made now ends (null: until revoked), by rotatedKeyLifetimeDays. */
export async function rotatedKeyExpiry(
  service: SupabaseClient,
  old: { team_member_id: string; created_at: string; expires_at: string | null },
  granter: { role: string },
  now = new Date(),
): Promise<string | null> {
  const member = await keyMember(service, old.team_member_id);
  const agent = member?.role === 'agent';
  const days = rotatedKeyLifetimeDays({
    agent,
    old,
    agentLifetimeDays: agent ? await defaultLifetime(service, member) : null,
    personalLifetimeDays: agent ? null : await personalKeyLifetimeDays(service),
    granterRole: granter.role,
  });
  return days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString();
}
