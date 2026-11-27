import {
  API_ENDPOINT_PERMISSION_SET,
  KEY_ONLY_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_IMPLIED_BY,
  PERMISSIONS,
  permissionLabel,
  type PermissionKey,
} from '@/lib/access-control';
import { NEVER_AGENT_SCOPES } from '@/lib/agents-ui';
import { moduleOfPermission, type ModuleId } from '@/lib/modules/registry';

/**
 * The permission grid's model (pure, client-safe; no UI here). Every
 * permission picker shows the same grid: one row per area (Tasks, Projects,
 * Contacts...), columns View / View all / Manage, and below it a short list
 * of special powers that fit no column (Act for a person, Decide approvals,
 * Provision personal agents...).
 *
 * - PERMISSION_PLACEMENT places every PermissionKey exactly once, by type: a
 *   new permission does not compile until it is placed, and
 *   test:key-management checks the grid holds each key once.
 * - A cell may hold more than one key (Tasks > Manage is create, manage
 *   assigned and manage all). It reads on when all are held, partial when
 *   some are, off when none.
 * - Turning a key on also turns on what it implies (PERMISSION_IMPLIED_BY:
 *   Manage contacts implies View work contacts); turning one off also turns
 *   off whatever implies it, so the grid never shows View off while a key
 *   can still view through Manage.
 * - What may be turned on is the grantable set (grantableSet): never what a
 *   key cannot carry, what an agent never gets (NEVER_AGENT_SCOPES), what the
 *   holder does not have, or what the editor does not hold themselves.
 *   scopeLock says why, in plain words. Turning off is always allowed.
 */

export const GRID_LEVELS = ['view', 'view_all', 'manage'] as const;
export type GridLevel = typeof GRID_LEVELS[number];

export const GRID_LEVEL_LABELS: Record<GridLevel, string> = { view: 'View', view_all: 'View all', manage: 'Manage' };

/** The rows, in the order the grid shows them. */
export const GRID_AREAS = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'projects', label: 'Projects' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'leads', label: 'Leads' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'team', label: 'Team' },
  { id: 'agents', label: 'Agents' },
  { id: 'templates', label: 'Templates' },
  { id: 'time', label: 'Time' },
  { id: 'files', label: 'Files' },
  { id: 'project_context', label: 'Project context' },
  { id: 'communications', label: 'Communications' },
  { id: 'portal', label: 'Client portal' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'billing', label: 'Billing rates' },
  { id: 'finance', label: 'Finance' },
  { id: 'goals', label: 'Goals' },
  { id: 'suggestions', label: 'Suggestions' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'audit', label: 'Audit log' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'api_keys', label: 'API keys' },
  { id: 'settings', label: 'Workspace settings' },
] as const;
export type GridAreaId = typeof GRID_AREAS[number]['id'];

/** Where a permission sits: a cell of an area, or a special power (rank orders the list, lowest first). */
export type GridPlacement = { area: GridAreaId; level: GridLevel } | { power: number };

const cell = (area: GridAreaId, level: GridLevel): GridPlacement => ({ area, level });

export const PERMISSION_PLACEMENT: Record<PermissionKey, GridPlacement> = {
  // Tasks: your own, every task, and changing them.
  'tasks.read_assigned': cell('tasks', 'view'),
  'tasks.read': cell('tasks', 'view_all'),
  'tasks.create': cell('tasks', 'manage'),
  'tasks.manage_assigned': cell('tasks', 'manage'),
  'tasks.manage_all': cell('tasks', 'manage'),
  'projects.read': cell('projects', 'view'),
  'projects.read_all': cell('projects', 'view_all'),
  'projects.manage': cell('projects', 'manage'),
  'project_members.manage': cell('projects', 'manage'),
  'contacts.read': cell('contacts', 'view'),
  'contacts.read_all': cell('contacts', 'view_all'),
  'contacts.manage': cell('contacts', 'manage'),
  'leads.read': cell('leads', 'view'),
  'leads.read_all': cell('leads', 'view_all'),
  'leads.manage': cell('leads', 'manage'),
  'inbound_email.read': cell('inbox', 'view'),
  'inbound_email.signal': cell('inbox', 'view'),
  'inbound_email.triage': cell('inbox', 'manage'),
  'inbound_email.manage': cell('inbox', 'manage'),
  'meetings.write': cell('meetings', 'manage'),
  'team.read': cell('team', 'view'),
  'team.manage': cell('team', 'manage'),
  'agents.manage': cell('agents', 'manage'),
  'templates.manage': cell('templates', 'manage'),
  'time.manage_own': cell('time', 'view'),
  'time.read_all': cell('time', 'view_all'),
  'time.manage_all': cell('time', 'manage'),
  'files.read': cell('files', 'view'),
  'files.upload': cell('files', 'manage'),
  'files.manage': cell('files', 'manage'),
  'project_context.read': cell('project_context', 'view'),
  'project_context.manage': cell('project_context', 'manage'),
  'communications.read': cell('communications', 'view'),
  'communications.manage': cell('communications', 'manage'),
  'portal.read': cell('portal', 'view'),
  'portal.manage': cell('portal', 'manage'),
  'credentials.reveal_shared': cell('credentials', 'view'),
  'credentials.manage': cell('credentials', 'manage'),
  'invoices.read': cell('invoices', 'view'),
  'invoices.manage': cell('invoices', 'manage'),
  'invoices.record_payments': cell('invoices', 'manage'),
  'billing.manage': cell('billing', 'manage'),
  'earnings.own.read': cell('finance', 'view'),
  'finance.company.read': cell('finance', 'view_all'),
  'compensation.manage': cell('finance', 'manage'),
  'payouts.manage': cell('finance', 'manage'),
  'goals.read': cell('goals', 'view'),
  'goals.manage': cell('goals', 'manage'),
  'suggestions.manage': cell('suggestions', 'manage'),
  'reminders.manage_own': cell('reminders', 'manage'),
  'notifications.manage_own': cell('notifications', 'manage'),
  'audit.read': cell('audit', 'view'),
  'webhooks.manage': cell('webhooks', 'manage'),
  'api_keys.manage_all': cell('api_keys', 'manage'),
  'settings.manage': cell('settings', 'manage'),
  'smtp.manage': cell('settings', 'manage'),
  // Special powers: they act for, decide, reach or export beyond one area.
  'agents.act_for': { power: 1 },
  'approvals.decide': { power: 2 },
  'assistants.provision': { power: 3 },
  'access.manage': { power: 4 },
  'groups.manage': { power: 5 },
  'time.approve': { power: 6 },
  'questions.ask': { power: 7 },
  'chat.notify': { power: 8 },
  'notifications.send': { power: 9 },
  'inbound_email.personal': { power: 10 },
  'context.memory': { power: 11 },
  'suggestions.create': { power: 12 },
  'agent_activity.write': { power: 13 },
  'fleet_alerts.write': { power: 14 },
  'identities.link': { power: 15 },
  'identities.read': { power: 16 },
  'audit.export': { power: 17 },
  'agent_events.export': { power: 18 },
  'agents.host': { power: 19 },
};

const DESCRIPTIONS = new Map<string, string>(PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => [p.key, p.description] as const)));

/** The keys of one cell, in PERMISSIONS order (empty for a cell the area does not have). */
export function cellKeys(area: GridAreaId, level: GridLevel): PermissionKey[] {
  return PERMISSIONS.filter((key) => {
    const at = PERMISSION_PLACEMENT[key];
    return 'area' in at && at.area === area && at.level === level;
  });
}

/** The special powers, in the order they are listed. */
export const SPECIAL_POWERS: readonly PermissionKey[] = PERMISSIONS
  .filter((key) => 'power' in PERMISSION_PLACEMENT[key])
  .sort((a, b) => (PERMISSION_PLACEMENT[a] as { power: number }).power - (PERMISSION_PLACEMENT[b] as { power: number }).power);

// ── Who may be given what ───────────────────────────────────────────────

export interface GrantLimits {
  /** A key's scopes (api, the default) or what the app checks (app). */
  channel?: 'app' | 'api';
  /** The holder is an agent: what agents never get is locked. */
  holderIsAgent?: boolean;
  /** What the holder may have (a key's member's own permissions); left out, no limit. */
  holderHolds?: Iterable<string> | null;
  /** The holder's name, for the reason ("Scout isn't allowed to do this"). */
  holderName?: string;
  /** What the editor may hand on (their own permissions); left out, no limit. */
  editorHolds?: Iterable<string> | null;
}

export type ScopeLockKind = 'channel' | 'never_for_agents' | 'holder' | 'editor';

export interface ScopeLock {
  kind: ScopeLockKind;
  /** Plain words for the person looking at the grid. */
  reason: string;
}

const KNOWN = new Set<string>(PERMISSIONS);

const asSet = (values: Iterable<string> | null | undefined): Set<string> | null => (values ? new Set(values) : null);

/** Why a permission cannot be turned on for this holder by this editor, or null when it can. */
export function scopeLock(key: string, limits: GrantLimits = {}): ScopeLock | null {
  const channel = limits.channel ?? 'api';
  if (!KNOWN.has(key)) return { kind: 'channel', reason: "This app doesn't know this permission." };
  if (channel === 'api' && !API_ENDPOINT_PERMISSION_SET.has(key as PermissionKey)) {
    return { kind: 'channel', reason: "Keys can't carry this: it works in the app only." };
  }
  if (channel === 'app' && KEY_ONLY_PERMISSIONS.has(key as PermissionKey)) {
    return { kind: 'channel', reason: 'This only does something for a key, not in the app.' };
  }
  if (limits.holderIsAgent && (NEVER_AGENT_SCOPES as readonly string[]).includes(key)) {
    return { kind: 'never_for_agents', reason: 'Agents never get this.' };
  }
  const holder = asSet(limits.holderHolds);
  if (holder && !holder.has(key)) {
    return { kind: 'holder', reason: `${limits.holderName ?? 'This member'} isn't allowed to do this, so it can't be given here.` };
  }
  const editor = asSet(limits.editorHolds);
  if (editor && !editor.has(key)) {
    return { kind: 'editor', reason: "You don't have this yourself, so you can't give it." };
  }
  return null;
}

/** Every permission scopeLock allows. */
export function grantableSet(limits: GrantLimits = {}): Set<PermissionKey> {
  // The limits' sets are read once, not per key.
  const prepared: GrantLimits = { ...limits, holderHolds: asSet(limits.holderHolds), editorHolds: asSet(limits.editorHolds) };
  return new Set(PERMISSIONS.filter((key) => scopeLock(key, prepared) === null));
}

// ── Grid state ──────────────────────────────────────────────────────────

export type CellState = 'on' | 'partial' | 'off';

export interface GridCell {
  area: GridAreaId;
  level: GridLevel;
  /** Its permissions' plain labels, joined ("Manage projects, Assign project members"). */
  label: string;
  keys: PermissionKey[];
  held: PermissionKey[];
  state: CellState;
}

export interface GridArea {
  id: GridAreaId;
  label: string;
  /** The module the row belongs to (hidden while it is off), or core. */
  module: ModuleId | 'core';
  cells: Partial<Record<GridLevel, GridCell>>;
}

export interface GridPower {
  key: PermissionKey;
  label: string;
  description: string;
  held: boolean;
}

export interface PermissionGridState {
  areas: GridArea[];
  powers: GridPower[];
  /** Scopes this build does not know, kept as they were so a save never drops them. */
  other: string[];
}

function stateOf(keys: readonly PermissionKey[], held: ReadonlySet<string>): CellState {
  const count = keys.filter((key) => held.has(key)).length;
  return count === 0 ? 'off' : count === keys.length ? 'on' : 'partial';
}

/** The grid for a set of scopes (or permissions). */
export function scopesToGrid(scopes: Iterable<string>): PermissionGridState {
  const held = new Set(scopes);
  const areas: GridArea[] = GRID_AREAS.map(({ id, label }) => {
    const cells: Partial<Record<GridLevel, GridCell>> = {};
    for (const level of GRID_LEVELS) {
      const keys = cellKeys(id, level);
      if (keys.length === 0) continue;
      cells[level] = {
        area: id, level, keys,
        label: keys.map(permissionLabel).join(', '),
        held: keys.filter((key) => held.has(key)),
        state: stateOf(keys, held),
      };
    }
    const modules = [...new Set(Object.values(cells).flatMap((c) => c!.keys.map(moduleOfPermission)))];
    return { id, label, module: modules.length === 1 ? modules[0] : 'core', cells };
  });
  const powers = SPECIAL_POWERS.map((key) => ({ key, label: permissionLabel(key), description: DESCRIPTIONS.get(key) ?? '', held: held.has(key) }));
  return { areas, powers, other: [...held].filter((scope) => !KNOWN.has(scope)) };
}

/** The scopes a grid holds, in PERMISSIONS order, then any it did not know. */
export function gridToScopes(grid: PermissionGridState): string[] {
  const held = new Set<string>([
    ...grid.areas.flatMap((area) => Object.values(area.cells).flatMap((c) => c!.held)),
    ...grid.powers.filter((power) => power.held).map((power) => power.key),
  ]);
  return [...PERMISSIONS.filter((key) => held.has(key)), ...grid.other];
}

const IMPLIES = new Map<PermissionKey, PermissionKey[]>();
for (const [lower, higher] of Object.entries(PERMISSION_IMPLIED_BY) as [PermissionKey, readonly PermissionKey[]][]) {
  for (const key of higher) IMPLIES.set(key, [...(IMPLIES.get(key) ?? []), lower]);
}

/** The permissions turning `key` on also turns on (what it implies, and what those imply). */
export function impliedBy(key: PermissionKey): PermissionKey[] {
  const out = new Set<PermissionKey>();
  const visit = (k: PermissionKey) => {
    for (const lower of IMPLIES.get(k) ?? []) if (!out.has(lower)) { out.add(lower); visit(lower); }
  };
  visit(key);
  return [...out];
}

/** The permissions turning `key` off also turns off (whatever implies it, directly or not). */
export function implying(key: PermissionKey): PermissionKey[] {
  const out = new Set<PermissionKey>();
  const visit = (k: PermissionKey) => {
    for (const higher of PERMISSION_IMPLIED_BY[k] ?? []) if (!out.has(higher)) { out.add(higher); visit(higher); }
  };
  visit(key);
  return [...out];
}

/** Turns keys on (only grantable ones, with the grantable keys they imply) or off (with what implies them). */
function apply(held: Set<string>, keys: readonly PermissionKey[], on: boolean, grantable: ReadonlySet<string> | null): void {
  const may = (key: string) => !grantable || grantable.has(key);
  if (on) {
    for (const key of keys) {
      if (!may(key)) continue;
      held.add(key);
      for (const lower of impliedBy(key)) if (may(lower)) held.add(lower);
    }
  } else {
    for (const key of keys) {
      held.delete(key);
      for (const higher of implying(key)) held.delete(higher);
    }
  }
}

function findCell(grid: PermissionGridState, area: GridAreaId, level: GridLevel): GridCell | null {
  return grid.areas.find((a) => a.id === area)?.cells[level] ?? null;
}

/**
 * Sets one cell on or off. On adds its grantable keys (grantable null: all)
 * and what they imply; off removes all its keys, locked or not, and whatever
 * implies them.
 */
export function setCell(grid: PermissionGridState, area: GridAreaId, level: GridLevel, on: boolean, grantable: ReadonlySet<string> | null = null): PermissionGridState {
  const target = findCell(grid, area, level);
  if (!target) return grid;
  const held = new Set(gridToScopes(grid));
  apply(held, target.keys, on, grantable);
  return scopesToGrid(held);
}

/**
 * A click on a cell: on turns off; off turns on (as far as the grantable set
 * allows); partial fills in what it can, or turns off when nothing more can
 * be given (the rest is locked), so a click always does something a person
 * may do. Answers the grid unchanged when nothing could change.
 */
export function toggleCell(grid: PermissionGridState, area: GridAreaId, level: GridLevel, grantable: ReadonlySet<string> | null = null): PermissionGridState {
  const target = findCell(grid, area, level);
  if (!target) return grid;
  const canAdd = target.keys.some((key) => !target.held.includes(key) && (!grantable || grantable.has(key)));
  const on = target.state === 'off' || (target.state === 'partial' && canAdd);
  return setCell(grid, area, level, on, grantable);
}

/** A click on a special power: flips it (turning on only when grantable). */
export function togglePower(grid: PermissionGridState, key: PermissionKey, grantable: ReadonlySet<string> | null = null): PermissionGridState {
  const power = grid.powers.find((p) => p.key === key);
  if (!power) return grid;
  const held = new Set(gridToScopes(grid));
  apply(held, [key], !power.held, grantable);
  return scopesToGrid(held);
}

/** Every cell in a column on (only what is grantable) or off. */
export function selectColumn(grid: PermissionGridState, level: GridLevel, grantable: ReadonlySet<string> | null, on = true): PermissionGridState {
  const held = new Set(gridToScopes(grid));
  for (const area of grid.areas) {
    const target = area.cells[level];
    if (target) apply(held, target.keys, on, grantable);
  }
  return scopesToGrid(held);
}

export interface CellLock {
  area: GridAreaId;
  level: GridLevel;
  /** all: none of its keys can be turned on; some: only part of it can. */
  locked: 'all' | 'some';
  /** Each locked key and why. */
  reasons: { key: PermissionKey; label: string; kind: ScopeLockKind; reason: string }[];
}

/** The cells that cannot (fully) be turned on for these limits, with the reasons. */
export function lockedCells(limits: GrantLimits = {}): CellLock[] {
  const prepared: GrantLimits = { ...limits, holderHolds: asSet(limits.holderHolds), editorHolds: asSet(limits.editorHolds) };
  const out: CellLock[] = [];
  for (const { id } of GRID_AREAS) {
    for (const level of GRID_LEVELS) {
      const keys = cellKeys(id, level);
      const reasons = keys.flatMap((key) => {
        const lock = scopeLock(key, prepared);
        return lock ? [{ key, label: permissionLabel(key), ...lock }] : [];
      });
      if (reasons.length) out.push({ area: id, level, locked: reasons.length === keys.length ? 'all' : 'some', reasons });
    }
  }
  return out;
}

/** The special powers that cannot be turned on for these limits, with the reasons. */
export function lockedPowers(limits: GrantLimits = {}): { key: PermissionKey; label: string; kind: ScopeLockKind; reason: string }[] {
  return SPECIAL_POWERS.flatMap((key) => {
    const lock = scopeLock(key, limits);
    return lock ? [{ key, label: permissionLabel(key), ...lock }] : [];
  });
}
