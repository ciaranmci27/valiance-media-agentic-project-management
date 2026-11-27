/**
 * Pure rules behind an agent's Access tab, its keys, Settings > Developers'
 * key hygiene and the hire flow's branches (client-safe, no I/O). The server
 * (lib/api/agent-powers.ts, lib/api/key-hygiene.ts) uses the same functions,
 * so what a screen previews is what the server does.
 */

// ── What it may do: one list ────────────────────────────────────────────

export interface PowerKey {
  id: string;
  scopes?: readonly string[] | null;
  revoked_at?: string | null;
  expires_at?: string | null;
  disabled_at?: string | null;
  key_prefix?: string | null;
  prefix?: string | null;
}

/** A key that still works or can work again: not revoked, not ended, not a one-hour AI setup key. Paused keys count. */
export function isLivePowerKey(key: PowerKey, now: number): boolean {
  if (key.revoked_at || key.disabled_at) return false;
  if (key.expires_at && new Date(key.expires_at).getTime() <= now) return false;
  const prefix = key.key_prefix ?? key.prefix ?? '';
  return !prefix.startsWith('pk_setup_');
}

/**
 * What an agent may do, as ONE list: everything its live keys carry and
 * every power given to it on its own (a per-member allow on the API
 * channel). Saving this list puts it on every live key and takes away an
 * own power left out, so a key never lacks what the agent was given and the
 * agent never keeps a power no key shows.
 */
export function mergedPowers(keys: readonly PowerKey[], ownAllows: readonly string[], now: number): string[] {
  const set = new Set<string>(ownAllows);
  for (const key of keys) if (isLivePowerKey(key, now)) for (const scope of key.scopes ?? []) set.add(scope);
  return [...set].sort();
}

const sameScopes = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((scope) => set.has(scope));
};

/** True when its live keys and own powers disagree: some key lacks part of the one list. */
export function powersOutOfStep(keys: readonly PowerKey[], ownAllows: readonly string[], now: number): boolean {
  const merged = mergedPowers(keys, ownAllows, now);
  const live = keys.filter((key) => isLivePowerKey(key, now));
  return live.some((key) => !sameScopes(key.scopes ?? [], merged));
}

/** What a save changes: the live keys whose scopes differ from the list, and the own powers it takes away. */
export function powersPlan(keys: readonly PowerKey[], ownAllows: readonly string[], chosen: readonly string[], now: number) {
  const next = [...new Set(chosen)].sort();
  const live = keys.filter((key) => isLivePowerKey(key, now));
  return {
    scopes: next,
    keysToChange: live.filter((key) => !sameScopes(key.scopes ?? [], next)).map((key) => key.id),
    ownToRemove: [...new Set(ownAllows)].filter((scope) => !next.includes(scope)).sort(),
  };
}

/** Plain words for how many things it may do ("Can do 1 thing", "Can do 12 things"). */
export function powersCountWords(count: number): string {
  if (count === 0) return 'Can do nothing yet';
  return `Can do ${count} ${count === 1 ? 'thing' : 'things'}`;
}

// ── Keys ────────────────────────────────────────────────────────────────

/** Replace key keeps the old secret working this long, so the host swaps it in without dropping off. */
export const REPLACE_OVERLAP_HOURS = 1;

/** A key nobody used for this many days counts as unused. */
export const UNUSED_KEY_DAYS = 90;

export interface HygieneKey {
  id: string;
  created_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
  expires_at?: string | null;
  disabled_at?: string | null;
  paused_at?: string | null;
  permissions?: string | null;
  key_prefix?: string | null;
}

/**
 * Why a key counts as unused, or null: never used at all (and made over a
 * day ago, so a key just handed to a host is never caught), or not used for
 * UNUSED_KEY_DAYS. Only keys that still work or are paused; never a connected
 * AI tool's key (Settings > Account disconnects those) or a one-hour AI setup key.
 */
export function unusedReason(key: HygieneKey, now: number, days: number = UNUSED_KEY_DAYS): 'never_used' | 'stale' | null {
  if (key.revoked_at || key.disabled_at) return null;
  if (key.expires_at && new Date(key.expires_at).getTime() <= now) return null;
  if (key.permissions === 'connection') return null;
  if ((key.key_prefix ?? '').startsWith('pk_setup_')) return null;
  const dayMs = 86_400_000;
  if (!key.last_used_at) {
    const made = key.created_at ? new Date(key.created_at).getTime() : 0;
    return now - made >= dayMs ? 'never_used' : null;
  }
  return now - new Date(key.last_used_at).getTime() >= days * dayMs ? 'stale' : null;
}

/** The keys Revoke unused keys would revoke, oldest use first. */
export function unusedKeys<K extends HygieneKey>(keys: readonly K[], now: number, days: number = UNUSED_KEY_DAYS): (K & { unused: 'never_used' | 'stale' })[] {
  return keys
    .map((key) => ({ key, unused: unusedReason(key, now, days) }))
    .filter((row): row is { key: K; unused: 'never_used' | 'stale' } => row.unused !== null)
    .sort((a, b) => (a.key.last_used_at ?? '').localeCompare(b.key.last_used_at ?? '') || (a.key.created_at ?? '').localeCompare(b.key.created_at ?? ''))
    .map(({ key, unused }) => ({ ...key, unused }));
}

/** "Never used" or "Unused for 90 days", for the preview list. */
export function unusedWords(reason: 'never_used' | 'stale', days: number = UNUSED_KEY_DAYS): string {
  return reason === 'never_used' ? 'Never used' : `Unused for ${days}+ days`;
}

/** Making a key for an agent that already has a live one asks to replace it instead (keys stay hashed: never revealed). */
export function liveKeyOf<K extends PowerKey>(keys: readonly K[], now: number): K | null {
  return keys.find((key) => isLivePowerKey(key, now)) ?? null;
}

// ── Who can use it ──────────────────────────────────────────────────────

export type AudienceKind = 'everyone' | 'role' | 'group' | 'member';
export interface AudienceEntry { kind: AudienceKind; ref: string | null; effect: 'include' | 'exclude' }

/** The picker's value for one entry ("everyone", "role:admin", "group:<id>", "member:<id>"). */
export function audienceValue(entry: Pick<AudienceEntry, 'kind' | 'ref'>): string {
  return entry.kind === 'everyone' ? 'everyone' : `${entry.kind}:${entry.ref}`;
}

export function audienceFromValue(value: string, effect: 'include' | 'exclude'): AudienceEntry | null {
  if (value === 'everyone') return { kind: 'everyone', ref: null, effect };
  const at = value.indexOf(':');
  if (at < 0) return null;
  const kind = value.slice(0, at) as AudienceKind;
  const ref = value.slice(at + 1);
  if (!['role', 'group', 'member'].includes(kind) || !ref) return null;
  return { kind, ref, effect };
}

/**
 * The audience as two picker lists: who can use it (an empty list means
 * everyone who may give it work) and the Except list.
 */
export function audienceLists(entries: readonly AudienceEntry[]): { include: string[]; exclude: string[] } {
  return {
    include: entries.filter((e) => e.effect === 'include').map(audienceValue),
    exclude: entries.filter((e) => e.effect === 'exclude').map(audienceValue),
  };
}

/**
 * The two picker lists back as the audience the server takes. "Everyone"
 * (or nothing picked) saves as no include rows (today's behaviour). A subject in both lists stays
 * only in Except (an exclude always wins, and the server refuses doubles).
 */
export function audienceFromLists(include: readonly string[], exclude: readonly string[]): AudienceEntry[] {
  const excluded = new Set(exclude);
  const inc = [...new Set(include)].filter((value) => !excluded.has(value));
  // Everyone, alone or beside others, is everyone: no include rows.
  const includes = inc.includes('everyone') ? [] : inc;
  const out: AudienceEntry[] = [];
  for (const value of includes) { const entry = audienceFromValue(value, 'include'); if (entry) out.push(entry); }
  for (const value of [...excluded]) { const entry = audienceFromValue(value, 'exclude'); if (entry && entry.kind !== 'everyone') out.push(entry); }
  return out;
}

/**
 * The includes after a pick: choosing Everyone clears the rest, choosing
 * anyone else takes Everyone away; nothing left means everyone.
 */
export function pickIncludes(previous: string[], next: string[]): string[] {
  const before = previous.length ? previous : ['everyone'];
  const added = next.filter((v) => !before.includes(v));
  if (added.includes('everyone')) return [];
  return next.filter((v) => v !== 'everyone');
}

/** Agents it may work for: other company agents, never itself or one already under it (the chart would loop). */
export function orchestratorChoices<A extends { id: string; orchestrator_id: string | null; personal?: boolean }>(agents: readonly A[], agentId: string): A[] {
  const under = new Set<string>([agentId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const agent of agents) {
      if (agent.orchestrator_id && under.has(agent.orchestrator_id) && !under.has(agent.id)) { under.add(agent.id); grew = true; }
    }
  }
  return agents.filter((agent) => !under.has(agent.id) && !agent.personal);
}

/** The one line under Works for: what "no skipping levels" means for this agent. */
export function worksForWords(agentName: string, orchestratorName: string | null, reportCount: number): string {
  if (!orchestratorName) {
    return reportCount
      ? `${agentName} is at the top. It hands work only to the ${reportCount === 1 ? 'agent' : `${reportCount} agents`} directly under it.`
      : `${agentName} works for no one. Pick an orchestrator to put it on a team.`;
  }
  return `No skipping levels: work reaches ${agentName} through ${orchestratorName}, and ${agentName} hands work only to agents directly under it.`;
}

// ── Hire ────────────────────────────────────────────────────────────────

export type HireKind = 'company' | 'personal';

export const COMPANY_HIRE_STEPS = [
  { key: 'template', label: 'Template' },
  { key: 'identity', label: 'Identity' },
  { key: 'team', label: 'Team' },
  { key: 'audience', label: 'Users' },
  { key: 'projects', label: 'Projects' },
  { key: 'powers', label: 'Access' },
  { key: 'review', label: 'Review' },
  { key: 'connect', label: 'Connect' },
  { key: 'done', label: 'Done' },
] as const;

export const PERSONAL_HIRE_STEPS = [
  { key: 'person', label: 'For whom' },
  { key: 'chat', label: 'Connect chat' },
  { key: 'done', label: 'Try it' },
] as const;

export function hireStepsFor(kind: HireKind) {
  return kind === 'personal' ? PERSONAL_HIRE_STEPS : COMPANY_HIRE_STEPS;
}

/**
 * The gentle line the hire screen shows when hiring a second company agent
 * and no agent works under an orchestrator yet: null when it does not apply.
 */
export function orchestratorSuggestion(companyAgents: readonly { orchestrator_id: string | null; role?: string | null; template_key?: string | null; report_count?: number }[], templateKey: string | null): string | null {
  if (templateKey === 'orchestrator') return null;
  if (companyAgents.length < 1) return null;
  const hasTeam = companyAgents.some((agent) => agent.orchestrator_id || (agent.report_count ?? 0) > 0 || agent.role === 'orchestrator' || agent.template_key === 'orchestrator');
  return hasTeam ? null : 'Tip: with more than one agent, add an orchestrator first. It takes the work, hands it to the right agent and brings you only real decisions.';
}

/** Who a personal assistant is for: the person, whether they already have one, and the words for it. */
export function personalHireState(personId: string | null, personName: string | null, existing: readonly { delegate_of: string; name: string; id: string }[]): { ready: boolean; existing: { id: string; name: string } | null; words: string } {
  if (!personId) return { ready: false, existing: null, words: 'Pick who it is for.' };
  const theirs = existing.find((agent) => agent.delegate_of === personId) ?? null;
  if (theirs) return { ready: false, existing: { id: theirs.id, name: theirs.name }, words: `${personName ?? 'They'} already ${personName ? 'has' : 'have'} ${theirs.name}.` };
  return { ready: true, existing: null, words: `${personName ?? 'They'} get${personName ? 's' : ''} a personal assistant that works only for them.` };
}

// ── Settings > Developers tabs ──────────────────────────────────────────

export const KEY_TABS = [
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'revoked', label: 'Revoked' },
] as const;
export type KeyTab = (typeof KEY_TABS)[number]['key'];

/** Which tab a key sits on: working, paused, or ended for good (revoked, expired or switched off). */
export function keyTabOf(key: { revoked_at?: string | null; expires_at?: string | null; disabled_at?: string | null; paused_at?: string | null }, now: number): KeyTab {
  if (key.revoked_at || key.disabled_at) return 'revoked';
  if (key.expires_at && new Date(key.expires_at).getTime() <= now) return 'revoked';
  return key.paused_at ? 'paused' : 'active';
}
