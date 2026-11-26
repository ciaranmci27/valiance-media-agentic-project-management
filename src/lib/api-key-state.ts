/**
 * Where an API key stands, in one word (pure, client-safe), so the server's
 * lists and the Settings tabs (Active, Paused, Ended) agree:
 *
 * - active: works.
 * - paused: refused at sign-in until resumed (paused_at, 20261127000600). It
 *   keeps its secret.
 * - expired: ended on its own: past expires_at (a rotated key's overlap too),
 *   or switched off with its AI setup session (disabled_at).
 * - revoked: ended for good by someone.
 *
 * Ended is expired and revoked together, as Settings > Developers already
 * groups them (lib/developers-settings.ts, groupApiKeys). An ended key is
 * never also paused: ending wins.
 */

export const API_KEY_STATES = ['active', 'paused', 'expired', 'revoked'] as const;
export type ApiKeyState = typeof API_KEY_STATES[number];

/** What a list may be narrowed to: one state, or ended (expired and revoked). */
export const API_KEY_STATE_FILTERS = [...API_KEY_STATES, 'ended'] as const;
export type ApiKeyStateFilter = typeof API_KEY_STATE_FILTERS[number];

export interface ApiKeyStateFields {
  revoked_at: string | null;
  expires_at?: string | null;
  disabled_at?: string | null;
  paused_at?: string | null;
}

export function apiKeyState(key: ApiKeyStateFields, now: number = Date.now()): ApiKeyState {
  if (key.revoked_at) return 'revoked';
  if (key.disabled_at) return 'expired';
  if (key.expires_at && new Date(key.expires_at).getTime() <= now) return 'expired';
  if (key.paused_at) return 'paused';
  return 'active';
}

export function keyMatchesState(key: ApiKeyStateFields, filter: ApiKeyStateFilter, now: number = Date.now()): boolean {
  const state = apiKeyState(key, now);
  return filter === 'ended' ? state === 'expired' || state === 'revoked' : state === filter;
}

/** A ?state= value: null when none was sent, undefined when it is not one of API_KEY_STATE_FILTERS. */
export function parseKeyStateFilter(value: string | null): ApiKeyStateFilter | null | undefined {
  if (value === null || value === '') return null;
  return (API_KEY_STATE_FILTERS as readonly string[]).includes(value) ? value as ApiKeyStateFilter : undefined;
}

/** How many keys are in each state, for the tabs' counts. */
export function countKeyStates(keys: readonly ApiKeyStateFields[], now: number = Date.now()): Record<ApiKeyState, number> {
  const counts: Record<ApiKeyState, number> = { active: 0, paused: 0, expired: 0, revoked: 0 };
  for (const key of keys) counts[apiKeyState(key, now)]++;
  return counts;
}
