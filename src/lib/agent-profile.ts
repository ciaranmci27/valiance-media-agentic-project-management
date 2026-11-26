import type { AgentRulesDraft } from '@/lib/agent-rules';
import { ESCALATE_DEFAULT_LABEL } from '@/lib/agent-rules';
import type { BudgetPeriod } from '@/lib/agent-limits';
import type { AgentDetail, AgentKeyView, AgentOwner } from '@/lib/agent-workspace';
import { normalizeRole, ownerPickerValue, splitOwnerPicker } from '@/lib/agents-ui';
import { groupTargetLabel } from '@/lib/groups';

/**
 * The agent profile's logic, on its own (pure, client-safe): which keys
 * still work, what the owners picker starts on and offers, who an agent
 * escalates to by default, what holds it back, and how the Rules and powers
 * form follows saves made here and elsewhere. Tested by
 * scripts/verify-agent-profile.ts.
 */

// ── Keys ────────────────────────────────────────────────────────────────

/** Where a key stands: working, or ended (past its expiry, switched off, revoked). */
export type KeyState = 'active' | 'expired' | 'disabled' | 'revoked';

export function keyState(key: Pick<AgentKeyView, 'revoked_at' | 'expires_at' | 'disabled_at'>, now: number): KeyState {
  if (key.revoked_at) return 'revoked';
  if (key.disabled_at) return 'disabled';
  if (key.expires_at && new Date(key.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

/** Keys that still work, in the order given. */
export function activeKeys<K extends Pick<AgentKeyView, 'revoked_at' | 'expires_at' | 'disabled_at'>>(keys: readonly K[], now: number): K[] {
  return keys.filter((key) => keyState(key, now) === 'active');
}

/** Ended keys that are still listed (expired or switched off, never revoked): shown so they can be cleaned up. */
export function endedKeys<K extends Pick<AgentKeyView, 'revoked_at' | 'expires_at' | 'disabled_at'>>(keys: readonly K[], now: number): K[] {
  return keys.filter((key) => { const state = keyState(key, now); return state === 'expired' || state === 'disabled'; });
}

/** What its working keys may do, sorted: an ended key grants nothing. */
export function heldKeyScopes(keys: readonly Pick<AgentKeyView, 'scopes' | 'revoked_at' | 'expires_at' | 'disabled_at'>[], now: number): string[] {
  return [...new Set(activeKeys(keys, now).flatMap((key) => key.scopes))].sort();
}

/** The scopes a new key starts on: what its working keys carry, else its template's. */
export function newKeyPresetScopes(keyScopes: readonly string[], templateScopes: readonly string[] | null | undefined): string[] {
  return [...(keyScopes.length ? keyScopes : templateScopes ?? [])];
}

/**
 * What the New key picker starts ticked: the preset's scopes you may give,
 * and for an agent, only what it holds unless you are an Owner (who may give
 * it the rest with the key; agent-scope-grants.ts).
 */
export function startingKeyScopes(preset: readonly string[], available: readonly string[], agentHeld: readonly string[] | null, owner: boolean): string[] {
  return preset.filter((scope) => available.includes(scope) && (owner || !agentHeld || agentHeld.includes(scope)));
}

/** New key on an existing agent: what a power its role lacks says when an Owner may give it with the key. */
export const AGENT_KEY_SCOPE_BEYOND_ROLE = "Agents don't have this by default; this gives it to this agent.";

// ── Owners ──────────────────────────────────────────────────────────────

export interface OwnerPerson { id: string; name: string; role: string; status?: string | null }

/**
 * The owners picker's choices: active people and groups, plus any current
 * owner who is suspended or gone, marked, so they show as a chip and can be
 * removed (the picker drops a value with no option).
 */
export function ownerPickerOptions(
  people: readonly OwnerPerson[],
  groups: readonly { id: string; name: string }[],
  owners: readonly AgentOwner[],
): { value: string; label: string }[] {
  const active = people.filter((p) => p.role !== 'agent' && p.status !== 'suspended');
  const activeIds = new Set(active.map((p) => p.id));
  const inactiveOwners = owners.filter((o) => !activeIds.has(o.id));
  return [
    ...active.map((p) => ({ value: p.id, label: p.name })),
    ...inactiveOwners.map((o) => ({ value: o.id, label: `${o.name || 'Former member'} (suspended)` })),
    ...groups.map((g) => ({ value: ownerPickerValue([], [g.id])[0], label: groupTargetLabel(g.name) })),
  ];
}

/** What Change opens on: always the saved owners and groups, never an earlier draft. */
export function ownersEditorStart(owners: readonly Pick<AgentOwner, 'id'>[], ownerGroups: readonly { id: string }[]): string[] {
  return ownerPickerValue(owners.map((o) => o.id), ownerGroups.map((g) => g.id));
}

/** The PATCH body for the picker's choice: groups only when they change or the agent has some. */
export function ownersSaveBody(value: readonly string[], savedGroupCount: number): { owner_ids: string[]; owner_group_ids?: string[] } {
  const { ownerIds, groupIds } = splitOwnerPicker(value);
  return { owner_ids: ownerIds, ...(groupIds.length > 0 || savedGroupCount > 0 ? { owner_group_ids: groupIds } : {}) };
}

/** Whether saving this choice takes the viewer off the agent's owners (in person or through every group of theirs). */
export function dropsViewer(saved: readonly string[], next: readonly string[], viewerId: string | null | undefined, viewerGroupIds: ReadonlySet<string>): boolean {
  if (!viewerId) return false;
  const owns = (value: readonly string[]) => {
    const { ownerIds, groupIds } = splitOwnerPicker(value);
    return ownerIds.includes(viewerId) || groupIds.some((id) => viewerGroupIds.has(id));
  };
  return owns(saved) && !owns(next);
}

// ── Escalation ──────────────────────────────────────────────────────────

/**
 * The escalation picker's empty choice with who that is today: its first
 * active owner, then its first owner group, else a workspace Owner (the
 * server's order).
 */
export function escalateDefaultLabel(owners: readonly { id: string; name: string }[], ownerGroups: readonly { name: string }[], suspendedIds: ReadonlySet<string>): string {
  const first = owners.find((o) => !suspendedIds.has(o.id));
  if (first) return `${ESCALATE_DEFAULT_LABEL} (first: ${first.name})`;
  if (ownerGroups.length) return `${ESCALATE_DEFAULT_LABEL} (first: ${groupTargetLabel(ownerGroups[0].name)})`;
  return `${ESCALATE_DEFAULT_LABEL} (none yet: a workspace Owner)`;
}

// ── What holds it back ──────────────────────────────────────────────────

const PERIOD_WORDS: Record<BudgetPeriod, string> = { day: 'today', week: 'this week', month: 'this month' };

export function periodWords(period: BudgetPeriod): string {
  return PERIOD_WORDS[period] ?? 'this month';
}

export type AgentHold =
  | { kind: 'suspended' }
  | { kind: 'workspace_paused'; at: string | null; by: string | null }
  | { kind: 'person_paused'; person: string; at: string | null }
  | { kind: 'paused'; at: string }
  | { kind: 'budget'; period: BudgetPeriod };

/**
 * Everything stopping it now, most fundamental first: suspended, every
 * agent paused, its person's pause, its own pause, a spent budget. A
 * suspended agent shows only that: nothing else matters until it is back.
 */
export function agentHolds(input: {
  suspended: boolean;
  workspacePausedAt: string | null;
  workspacePausedBy?: string | null;
  person: { name: string; paused_at: string | null } | null;
  pausedAt: string | null;
  budgetSpent: boolean;
  budgetPeriod: BudgetPeriod;
}): AgentHold[] {
  if (input.suspended) return [{ kind: 'suspended' }];
  const holds: AgentHold[] = [];
  if (input.workspacePausedAt) holds.push({ kind: 'workspace_paused', at: input.workspacePausedAt, by: input.workspacePausedBy ?? null });
  if (input.person?.paused_at) holds.push({ kind: 'person_paused', person: input.person.name, at: input.person.paused_at });
  if (input.pausedAt) holds.push({ kind: 'paused', at: input.pausedAt });
  if (input.budgetSpent) holds.push({ kind: 'budget', period: input.budgetPeriod });
  return holds;
}

// ── The Rules and powers form ───────────────────────────────────────────

export interface ProfileForm {
  name: string;
  title: string;
  role: string;
  description: string;
  rules: AgentRulesDraft;
}

export interface ProfileFormState {
  draft: ProfileForm;
  /** The saved values the draft started from. */
  base: ProfileForm;
  /** Someone saved a change elsewhere while this draft had edits. */
  conflict: boolean;
}

export function profileFormOf(detail: Pick<AgentDetail, 'agent' | 'rules'>, rulesOf: (rules: AgentDetail['rules']) => AgentRulesDraft): ProfileForm {
  return {
    name: detail.agent.name,
    title: detail.agent.title ?? '',
    role: detail.agent.agent_role ?? '',
    description: detail.agent.description ?? '',
    rules: rulesOf(detail.rules),
  };
}

/** The form as it saves: names and words trimmed, the role in its stored form. */
export function trimmedProfileForm(form: ProfileForm): ProfileForm {
  return {
    name: form.name.trim(),
    title: form.title.trim(),
    role: normalizeRole(form.role) ?? '',
    description: form.description.trim(),
    rules: form.rules,
  };
}

/** Two forms that save the same way compare equal ("Scout " and "Scout"). */
export function sameProfileForm(a: ProfileForm, b: ProfileForm): boolean {
  return JSON.stringify(trimmedProfileForm(a)) === JSON.stringify(trimmedProfileForm(b));
}

export function startProfileForm(saved: ProfileForm): ProfileFormState {
  return { draft: saved, base: saved, conflict: false };
}

/**
 * After a save here: what was sent, trimmed, is the new saved base, and a
 * draft still equal to it takes the trimmed values, so Save and Discard go
 * quiet ("Scout " saved reads "Scout"). Edits typed while it saved stay.
 */
export function savedProfileForm(state: ProfileFormState, submitted: ProfileForm): ProfileFormState {
  const saved = trimmedProfileForm(submitted);
  return { draft: sameProfileForm(state.draft, saved) ? saved : state.draft, base: saved, conflict: false };
}

/**
 * Follows the saved values: untouched, the form takes the new ones; with
 * edits, they stay and the form says the saved values moved under them.
 * Answers the same state when nothing changed.
 */
export function syncProfileForm(state: ProfileFormState, saved: ProfileForm): ProfileFormState {
  if (sameProfileForm(state.base, saved)) return state;
  if (sameProfileForm(state.draft, state.base)) return startProfileForm(saved);
  if (sameProfileForm(state.draft, saved)) return startProfileForm(saved);
  return { draft: state.draft, base: saved, conflict: true };
}
