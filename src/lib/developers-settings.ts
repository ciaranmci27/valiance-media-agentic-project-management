import { API_ENDPOINT_PERMISSIONS, PERMISSION_GROUPS, type PermissionKey } from '@/lib/access-control';
import { SENSITIVE_SCOPES, type ScopeGroup } from '@/lib/agents-ui';
import { webhookUrlError } from '@/lib/webhooks/endpoint-input';
import {
  INVOICE_WEBHOOK_EVENT_TYPES,
  type ApiKey,
  type WebhookAmountBasis,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '@/lib/types';

/**
 * Settings > Developers, its rules on their own: who sees which section, a
 * person's keys sorted into what they manage here and what lives elsewhere,
 * the dates a key row shows, rotation choices, and the webhook endpoint
 * form's groups and checks. Pure: no React, no network.
 */

// ── Sections ────────────────────────────────────────────────────────────

/**
 * What the Webhooks section shows:
 * - manage: the endpoints, for anyone who may manage them while the module is on.
 * - turn-on: the module is off and this person is an Owner, who may switch it on here.
 * - ask-owner: the module is off and this person could manage webhooks once it is on.
 * - hidden: nothing to do here (the demo workspace, or no webhook access).
 */
export type WebhooksSectionState = 'manage' | 'turn-on' | 'ask-owner' | 'hidden';

export function webhooksSectionState(input: {
  isDemoMode: boolean;
  moduleOn: boolean;
  /** Holds webhooks.manage by role or override, whether or not the module is on. */
  holdsPermission: boolean;
  isOwner: boolean;
}): WebhooksSectionState {
  if (input.isDemoMode) return 'hidden';
  if (input.moduleOn) return input.holdsPermission ? 'manage' : 'hidden';
  if (input.isOwner) return 'turn-on';
  return input.holdsPermission ? 'ask-owner' : 'hidden';
}

// ── Keys ────────────────────────────────────────────────────────────────

/** A key that no longer works: revoked, or past its end (a rotated key's overlap, say). */
export function keyEnded(key: Pick<ApiKey, 'revoked_at' | 'expires_at'>, now: Date = new Date()): boolean {
  return !!key.revoked_at || (!!key.expires_at && new Date(key.expires_at).getTime() <= now.getTime());
}

export interface KeyGroups {
  /** The signed-in person's own working keys: created, rotated and revoked here. */
  mine: ApiKey[];
  /** Other people's working keys, which an Owner with api_keys.manage_all sees. */
  people: ApiKey[];
  /** Agents' working keys: each is managed on its agent's profile (Connect). */
  agents: ApiKey[];
  /** Revoked or expired, newest first. */
  ended: ApiKey[];
}

/** Sorts the keys the person can see into the lists the page shows. */
export function groupApiKeys(keys: readonly ApiKey[], me: string | null, agentIds: ReadonlySet<string>, now: Date = new Date()): KeyGroups {
  const groups: KeyGroups = { mine: [], people: [], agents: [], ended: [] };
  for (const key of keys) {
    if (keyEnded(key, now)) groups.ended.push(key);
    else if (key.team_member_id && agentIds.has(key.team_member_id)) groups.agents.push(key);
    else if (key.team_member_id === me) groups.mine.push(key);
    else groups.people.push(key);
  }
  const endedAt = (key: ApiKey) => new Date(key.revoked_at ?? key.expires_at ?? key.updated_at).getTime();
  groups.ended.sort((a, b) => endedAt(b) - endedAt(a));
  return groups;
}

/**
 * An agent's key on this page: always listed and revocable (an Owner must be
 * able to stop one even with the Agents module off, when its profile is out
 * of reach); Open Connect only while that profile can be opened.
 */
export function agentKeyRow(input: { agentsOn: boolean; canManageAgents: boolean }): { listed: true; revoke: true; openConnect: boolean } {
  return { listed: true, revoke: true, openConnect: input.agentsOn && input.canManageAgents };
}

export interface KeyExpiry {
  label: string;
  tone: 'muted' | 'warning' | 'danger';
}

const HOUR = 3_600_000;

/**
 * When a key stops working, in plain words: "No expiry", "Expires Mar 3"
 * (from formatDate), "Ends in 5 hours" inside two days (a rotated key's
 * overlap), "Expired".
 */
export function keyExpiry(expiresAt: string | null | undefined, now: Date = new Date(), formatDate: (iso: string) => string = (iso) => iso.slice(0, 10)): KeyExpiry {
  if (!expiresAt) return { label: 'No expiry', tone: 'muted' };
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (left <= 0) return { label: 'Expired', tone: 'danger' };
  if (left < HOUR) {
    const minutes = Math.max(1, Math.round(left / 60_000));
    return { label: `Ends in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`, tone: 'warning' };
  }
  if (left < 48 * HOUR) {
    const hours = Math.round(left / HOUR);
    return { label: `Ends in ${hours} ${hours === 1 ? 'hour' : 'hours'}`, tone: 'warning' };
  }
  return { label: `Expires ${formatDate(expiresAt)}`, tone: 'muted' };
}

/** How long the old key keeps working after a rotation (the API takes 0 to 168 hours). */
export const ROTATE_OVERLAP_DEFAULT_HOURS = 24;
const ROTATE_OVERLAP_HOURS = [0, 1, 24, 72, 168] as const;

export function rotateOverlapOptions(): { value: string; label: string; detail: string }[] {
  const label = (hours: number) => {
    if (hours === 0) return 'Stop it now';
    if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    const days = hours / 24;
    return days === 1 ? '24 hours' : `${days} days`;
  };
  return ROTATE_OVERLAP_HOURS.map((hours) => ({
    value: String(hours),
    label: hours === ROTATE_OVERLAP_DEFAULT_HOURS ? `${label(hours)} (default)` : label(hours),
    detail: hours === 0 ? 'Anything still using the old key stops at once' : 'Time to swap the new key into your tools',
  }));
}

/** How long a new personal key lasts: 30 days, 90 days, a year, or until revoked ('none'). */
const KEY_LIFETIME_DAYS = [30, 90, 365] as const;
export const NO_KEY_EXPIRY = 'none';

/**
 * The New key dialog's expiry choices, each saying when the key would stop,
 * and the one it starts on: the workspace's personal key lifetime (null: no
 * expiry), marked as the default. A lifetime that is none of the standard
 * ones is offered too. For anyone but an Owner a lifetime that is set is
 * also the limit: only choices within it are offered, and No expiry is not.
 */
export function keyLifetimeChoices(
  workspaceDays: number | null,
  /** When a key made now would stop, in words ("on Dec 25, 2026"). */
  endsOn: (days: number) => string = (days) => `in ${days} days`,
  { owner = false }: { owner?: boolean } = {},
): { options: { value: string; label: string; description: string }[]; initial: string } {
  const label = (days: number) => (days === 365 ? '1 year' : `${days} ${days === 1 ? 'day' : 'days'}`);
  const capped = workspaceDays !== null && !owner;
  const days = [...new Set([...KEY_LIFETIME_DAYS, ...(workspaceDays === null ? [] : [workspaceDays])])]
    .filter((d) => !capped || d <= workspaceDays!)
    .sort((a, b) => a - b);
  const initial = workspaceDays === null ? NO_KEY_EXPIRY : String(workspaceDays);
  const note = (value: string, detail: string) => (value !== initial ? detail
    : capped ? `Your workspace's default and longest. ${detail}` : `Your workspace's default. ${detail}`);
  return {
    options: [
      ...days.map((d) => ({ value: String(d), label: label(d), description: note(String(d), `It stops working ${endsOn(d)}.`) })),
      ...(capped ? [] : [{ value: NO_KEY_EXPIRY, label: 'No expiry', description: note(NO_KEY_EXPIRY, 'It works until you rotate or revoke it.') }]),
    ],
    initial,
  };
}

/** A choice as the API takes it: days, or null for no expiry. */
export function keyLifetimeDays(choice: string): number | null {
  return choice === NO_KEY_EXPIRY ? null : Number(choice);
}

/**
 * What a person's key may do, in the plain words and groups the Access page
 * uses. Unlike an agent's picker, every API scope the person holds is
 * offered; one no group lists still shows, under Other, so nothing they
 * could grant before is lost.
 */
export function keyScopeGroups(available: readonly string[]): ScopeGroup[] {
  const allowed = new Set(available);
  const apiScopes = new Set<string>(API_ENDPOINT_PERMISSIONS);
  const listed = new Set<string>();
  const groups: ScopeGroup[] = PERMISSION_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    scopes: group.permissions
      .filter((p) => apiScopes.has(p.key) && allowed.has(p.key))
      .map((p) => {
        listed.add(p.key);
        return { key: p.key, label: p.label, description: p.description, sensitive: SENSITIVE_SCOPES.includes(p.key) };
      }),
  })).filter((group) => group.scopes.length > 0);
  const rest = [...allowed].filter((scope) => !listed.has(scope)).sort();
  if (rest.length > 0) {
    groups.push({
      id: 'other',
      label: 'Other',
      scopes: rest.map((key) => ({ key: key as PermissionKey, label: key, description: '', sensitive: SENSITIVE_SCOPES.includes(key as PermissionKey) })),
    });
  }
  return groups;
}

// ── Webhooks ────────────────────────────────────────────────────────────

export const WEBHOOK_EVENT_LABELS: Record<string, string> = {
  'task.created': 'Task created',
  'task.updated': 'Task updated',
  'task.deleted': 'Task moved to Trash',
  'comment.created': 'Comment added',
  'question.asked': 'Question asked',
  'question.answered': 'Question answered',
  'question.cancelled': 'Question withdrawn',
  'suggestion.created': 'Suggestion made',
  'suggestion.decided': 'Suggestion decided',
  'review.submitted': 'Review submitted',
  'run.started': 'Agent run started',
  'run.finished': 'Agent run finished',
  'agent_event.created': 'Every agent event',
  'assistant.message': 'Chat message for an assistant',
  'invoice.paid': 'Invoice paid',
  'invoice.updated': 'Invoice updated',
  'invoice.deleted': 'Invoice deleted',
  'invoice.payment_recorded': 'Payment recorded',
  'invoice.payment_removed': 'Payment removed',
};

export interface WebhookEventGroup {
  id: 'work' | 'questions' | 'runs' | 'invoices' | 'agent_events' | 'assistant';
  label: string;
  description: string;
  events: readonly string[];
  /** Offered only while Client invoicing is on. */
  invoices?: boolean;
}

/** The event picker, in plain groups. Agent events and assistant chat are opt in: never a default. */
export const WEBHOOK_EVENT_GROUPS: readonly WebhookEventGroup[] = [
  {
    id: 'work',
    label: 'Work',
    description: 'Tasks made, changed or moved to Trash, comments, suggestions and reviews.',
    events: ['task.created', 'task.updated', 'task.deleted', 'comment.created', 'suggestion.created', 'suggestion.decided', 'review.submitted'],
  },
  { id: 'questions', label: 'Questions', description: 'Questions asked, answered or withdrawn.', events: ['question.asked', 'question.answered', 'question.cancelled'] },
  { id: 'runs', label: 'Agent runs', description: 'When an agent starts and finishes a run.', events: ['run.started', 'run.finished'] },
  {
    id: 'invoices',
    label: 'Invoices',
    description: 'Invoices paid, changed or deleted, and payments recorded or removed.',
    events: INVOICE_WEBHOOK_EVENT_TYPES,
    invoices: true,
  },
  {
    id: 'agent_events',
    label: 'Agent events',
    description: 'Everything your agents record, for a data system. This can be many events an hour.',
    events: ['agent_event.created'],
  },
  {
    id: 'assistant',
    label: 'Assistant chat',
    description: 'A chat message a person sends their own assistant, for the host that answers it. Pick the assistant under Member.',
    events: ['assistant.message'],
  },
];

const INVOICE_EVENTS: readonly string[] = INVOICE_WEBHOOK_EVENT_TYPES;

export function hasInvoiceEvents(events: readonly string[]): boolean {
  return events.some((event) => INVOICE_EVENTS.includes(event));
}

/** The groups offered: invoices only while Client invoicing is on. */
export function webhookEventGroups(billingOn: boolean): WebhookEventGroup[] {
  return WEBHOOK_EVENT_GROUPS.filter((group) => !group.invoices || billingOn);
}

/** The endpoint form, as typed. memberId '' means everyone; agentEventTypes is comma-separated. */
export interface WebhookDraft {
  name: string;
  url: string;
  description: string;
  events: string[];
  amountBasis: WebhookAmountBasis;
  projectIds: string[];
  memberId: string;
  agentEventTypes: string;
}

export type WebhookStep = 'endpoint' | 'events' | 'filters';

/** "work.done, usage.recorded , work.done" reads as ['work.done', 'usage.recorded']. */
export function parseAgentEventTypes(text: string): string[] {
  return [...new Set(text.split(',').map((type) => type.trim()).filter(Boolean))];
}

const AGENT_EVENT_TYPE = /^[a-z][a-z0-9_.]{0,99}$/;

/** The first problem on a step, or null. Invoice events kept from when invoicing was on still count, though hidden. */
export function webhookStepProblem(draft: WebhookDraft, step: WebhookStep): string | null {
  if (step === 'endpoint') {
    if (!draft.name.trim()) return 'Give the endpoint a name.';
    // HTTPS, except plain http on localhost for local development (the API's rule too).
    const urlError = webhookUrlError(draft.url.trim());
    return urlError ? `${urlError}.` : null;
  }
  if (step === 'events') return draft.events.length === 0 ? 'Choose at least one event.' : null;
  if (!draft.events.includes('agent_event.created')) return null;
  const bad = parseAgentEventTypes(draft.agentEventTypes).find((type) => !AGENT_EVENT_TYPE.test(type));
  return bad ? `${bad} is not an agent event type.` : null;
}

/** The first step with a problem, so Save lands where the fix is. */
export function firstWebhookProblem(draft: WebhookDraft): { step: WebhookStep; message: string } | null {
  for (const step of ['endpoint', 'events', 'filters'] as const) {
    const message = webhookStepProblem(draft, step);
    if (message) return { step, message };
  }
  return null;
}

/**
 * The columns a save writes. agent_event_types is written only where it
 * applies (or to clear it), so an endpoint without agent events saves on a
 * database from before that column.
 */
export function webhookFields(draft: WebhookDraft, editingHadTypes: boolean) {
  const wantsTypes = draft.events.includes('agent_event.created');
  const types = parseAgentEventTypes(draft.agentEventTypes);
  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    events: draft.events,
    description: draft.description.trim(),
    amount_basis: draft.amountBasis,
    project_ids: draft.projectIds.length > 0 ? draft.projectIds : null,
    member_id: draft.memberId || null,
    ...(wantsTypes || editingHadTypes ? { agent_event_types: wantsTypes && types.length > 0 ? types : null } : {}),
  };
}

export interface EndpointHealth {
  state: 'paused' | 'failing' | 'retrying' | 'ok' | 'idle';
  /** Failed for good, among the recent deliveries loaded. */
  failed: number;
  /** Waiting out a backoff after a failed try. */
  retrying: number;
}

/** An endpoint's state from its recent deliveries: paused wins, then failures, then retries. */
export function endpointHealth(endpoint: Pick<WebhookEndpoint, 'id' | 'is_active' | 'last_delivery_at'>, deliveries: readonly WebhookDelivery[]): EndpointHealth {
  const own = deliveries.filter((delivery) => delivery.endpoint_id === endpoint.id);
  const failed = own.filter((delivery) => delivery.status === 'failed').length;
  const retrying = own.filter((delivery) => delivery.status === 'pending' && delivery.attempts > 0).length;
  const state = !endpoint.is_active ? 'paused'
    : failed > 0 ? 'failing'
      : retrying > 0 ? 'retrying'
        : endpoint.last_delivery_at || own.length > 0 ? 'ok' : 'idle';
  return { state, failed, retrying };
}

/**
 * What an endpoint is sent, one short label per group: "Work" when every
 * event in it is on, "Work: 3 of 7" when some are. Invoice events kept while
 * Client invoicing is off still show, so nothing is hidden.
 */
export function eventSummary(events: readonly string[]): string[] {
  const on = new Set(events);
  const known = new Set(WEBHOOK_EVENT_GROUPS.flatMap((group) => group.events));
  const labels = WEBHOOK_EVENT_GROUPS.flatMap((group) => {
    const count = group.events.filter((event) => on.has(event)).length;
    if (count === 0) return [];
    return [count === group.events.length ? group.label : `${group.label}: ${count} of ${group.events.length}`];
  });
  // An event this screen does not know yet (a newer server) still shows by name.
  return [...labels, ...events.filter((event) => !known.has(event))];
}
