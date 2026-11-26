import { cleanSettings, settingsDefaults, validateSettings, INSTRUCTIONS_MAX } from '@/lib/agents-ui';
import type { SettingsField, SettingsValues } from '@/lib/project-agents';

/**
 * Pure rules behind a project's Agents tab, its brief and project setup, so
 * the screens say what the server does. Client-safe.
 */

// ── Who changes an agent's setup on a project ───────────────────────────

export interface AssignmentViewer {
  isOwner: boolean;
  /** project_members.manage */
  manageMembers: boolean;
  /** team.manage */
  manageTeam: boolean;
  memberId: string | null;
}

/**
 * Changes any setup on a project (its agents already there): an Owner,
 * project_members.manage or team.manage, as the server's canAssignAgent.
 */
export function editsEveryAssignment(viewer: AssignmentViewer): boolean {
  return viewer.isOwner || viewer.manageMembers || viewer.manageTeam;
}

/** Whether the viewer owns an agent: in person, or through a group they are in (as isAgentOwner). */
export function ownsAgent(
  viewer: Pick<AssignmentViewer, 'memberId'>,
  agent: { owners?: readonly { id: string }[] | null; owner_groups?: readonly { id: string }[] | null },
  myGroupIds: readonly string[],
): boolean {
  if (!viewer.memberId) return false;
  if (agent.owners?.some((owner) => owner.id === viewer.memberId)) return true;
  const mine = new Set(myGroupIds);
  return !!agent.owner_groups?.some((group) => mine.has(group.id));
}

/** Whether the viewer may change this agent's setup here: everyone who edits every setup, and the agent's owners. */
export function canEditAssignment(
  viewer: AssignmentViewer,
  agent: { owners?: readonly { id: string }[] | null; owner_groups?: readonly { id: string }[] | null } | undefined,
  myGroupIds: readonly string[],
): boolean {
  return editsEveryAssignment(viewer) || (!!agent && ownsAgent(viewer, agent, myGroupIds));
}

/** An agent's profile opens for agents.manage and for its owners (the /agent layout's rule). */
export function canOpenAgentProfile(manageAgents: boolean, owns: boolean): boolean {
  return manageAgents || owns;
}

/** "4 set up (1 paused) · 2 with access, not set up", or "No agents yet." */
export function agentsTabSummary(setUp: number, paused: number, accessOnly: number): string {
  if (setUp === 0 && accessOnly === 0) return 'No agents yet.';
  return [
    setUp ? `${setUp} set up${paused ? ` (${paused} paused)` : ''}` : null,
    accessOnly ? `${accessOnly} with access, not set up` : null,
  ].filter(Boolean).join(' · ');
}

// ── Saving a setup: required settings checked before the PUT ────────────

export interface AssignmentDraft {
  templateKey: string | null;
  schema: readonly SettingsField[];
  settings: SettingsValues;
  instructions: string;
  status?: 'active' | 'paused';
}

export interface AssignmentBody {
  status: 'active' | 'paused';
  template_key: string | null;
  settings: SettingsValues;
  instructions: string;
}

/** A new setup starting from the template's defaults. */
export function draftFromTemplate(templateKey: string | null, schema: readonly SettingsField[], status: 'active' | 'paused' = 'active'): AssignmentDraft {
  return { templateKey, schema, settings: settingsDefaults(schema), instructions: '', status };
}

/** What is wrong with a draft, keyed by field (instructions too); {} when it can be sent. */
export function assignmentDraftErrors(draft: AssignmentDraft): Record<string, string> {
  const errors = validateSettings(draft.schema, draft.settings);
  if (draft.instructions.length > INSTRUCTIONS_MAX) errors.instructions = `Keep instructions under ${INSTRUCTIONS_MAX} characters.`;
  return errors;
}

/**
 * Checks a draft and only then saves it: a required setting left empty
 * answers its errors and nothing is sent. Answers {} once saved.
 */
export async function submitAssignment(draft: AssignmentDraft, save: (body: AssignmentBody) => Promise<void>): Promise<Record<string, string>> {
  const errors = assignmentDraftErrors(draft);
  if (Object.keys(errors).length) return errors;
  await save({
    status: draft.status ?? 'active',
    template_key: draft.templateKey || null,
    settings: cleanSettings(draft.settings),
    instructions: draft.instructions.trim(),
  });
  return {};
}

// ── Pinned entries: how many an agent actually reads ────────────────────

/**
 * What reaches an agent from one scope (a project's brief, company or group
 * knowledge, an agent's notes): the newest pinned entries, at most perScope,
 * each cut to entry characters. The server's caps (PACK_LIMITS and
 * SCOPED_PINNED_LIMITS) read these.
 */
export const PINNED_REACH = { perScope: 5, entry: 500 } as const;

export interface PinnedReach {
  /** Every pinned entry the screen holds. */
  pinned: number;
  /** Pinned entries agents read in full or cut. */
  reaching: Set<string>;
  /** Pinned, but past the limit: agents find these by search only. */
  beyond: Set<string>;
  /** Reaching, but longer than the limit: agents read the start. */
  cut: Set<string>;
}

export function pinnedReach(entries: readonly { id: string; pinned: boolean; updated_at: string; content: string }[], pinnedTotal?: number): PinnedReach {
  const pinned = entries.filter((e) => e.pinned).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const reaching = new Set(pinned.slice(0, PINNED_REACH.perScope).map((e) => e.id));
  const beyond = new Set(pinned.slice(PINNED_REACH.perScope).map((e) => e.id));
  const cut = new Set(pinned.filter((e) => reaching.has(e.id) && e.content.length > PINNED_REACH.entry).map((e) => e.id));
  return { pinned: Math.max(pinnedTotal ?? 0, pinned.length), reaching, beyond, cut };
}

/** The header's honest line: "3 pinned, agents always see them" or "5 of 7 pinned reach agents; they find the rest by search". */
export function pinnedReachLine(pinned: number): string | null {
  if (pinned === 0) return null;
  if (pinned <= PINNED_REACH.perScope) return `${pinned} pinned, agents always see ${pinned === 1 ? 'it' : 'them'}`;
  return `${PINNED_REACH.perScope} of ${pinned} pinned reach agents; they find the rest by search`;
}

// ── Project setup: the creator keeps access ─────────────────────────────

/**
 * People on a new project. Someone who reaches only the projects they are
 * on (no projects.read_all) stays on it, or the project they just made
 * would close on them. Answers the list to save and, for who reaches every
 * project, a warning when they took themselves off.
 */
export function setupMembers(memberIds: readonly string[], creatorId: string | null, readsAll: boolean): { memberIds: string[]; locked: boolean; warning: string | null } {
  const ids = [...new Set(memberIds)];
  if (!creatorId) return { memberIds: ids, locked: false, warning: null };
  if (!readsAll) return { memberIds: ids.includes(creatorId) ? ids : [creatorId, ...ids], locked: true, warning: null };
  return {
    memberIds: ids,
    locked: false,
    warning: ids.includes(creatorId) ? null : 'You are not on it. You can still open it, since you see every project, but it will not show as yours.',
  };
}

// ── Brief entries ───────────────────────────────────────────────────────

/**
 * The row changes a brief entry patch makes. A person who edits an entry's
 * words, or marks it checked, takes it over: "Written by an agent" clears.
 * An agent's own edit leaves who wrote it as it was.
 */
export function briefEntryChanges(
  before: { section?: string | null; category?: string | null; source?: string | null },
  patch: { content?: string; pinned?: boolean; is_active?: boolean; checked?: boolean },
  byAgent: boolean,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (patch.content !== undefined) changes.content = patch.content;
  if (patch.pinned !== undefined) changes.pinned = patch.pinned;
  if (patch.is_active !== undefined) changes.is_active = patch.is_active;
  const personTakesOver = !byAgent && (patch.checked === true || patch.content !== undefined);
  if (personTakesOver && before.source !== 'human') changes.source = 'human';
  return changes;
}
