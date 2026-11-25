import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * How long a new agent key lasts: the workspace's agent key lifetime
 * (business_settings.agent_key_lifetime_days), set by an Owner. Null means
 * until revoked, the default, so nothing changes until an Owner sets it.
 * People's own keys never get one here, and keys made before keep theirs.
 */

export const KEY_LIFETIME_MAX_DAYS = 3650;

const missingColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || /agent_key_lifetime_days/.test(error.message ?? ''));

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
