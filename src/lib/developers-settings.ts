import { API_ENDPOINT_PERMISSIONS, PERMISSION_GROUPS, type PermissionKey } from '@/lib/access-control';
import { SENSITIVE_SCOPES, type ScopeGroup } from '@/lib/agents-ui';
import { isAiSetupKey } from '@/lib/ai-setup';
import { NEW_AGENT_KEY_DAYS } from '@/lib/agent-defaults';
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

/** A key that no longer works: revoked, disabled, or past its end (a rotated key's overlap, say). */
export function keyEnded(key: Pick<ApiKey, 'revoked_at' | 'expires_at'> & { disabled_at?: string | null }, now: Date = new Date()): boolean {
  return !!key.revoked_at || !!key.disabled_at || (!!key.expires_at && new Date(key.expires_at).getTime() <= now.getTime());
}

/**
 * Pause or Resume for a key's menu (lib/api/key-manage.ts): a working key
 * pauses, a paused one resumes, an ended key does neither (ending wins) and
 * a one-hour AI setup key (pk_setup_) never changes, so it has neither.
 */
export function keyPauseAction(
  key: Pick<ApiKey, 'revoked_at' | 'expires_at' | 'key_prefix'> & { disabled_at?: string | null; paused_at?: string | null },
  now: Date = new Date(),
): 'pause' | 'resume' | null {
  if (keyEnded(key, now) || isAiSetupKey(key.key_prefix)) return null;
  return key.paused_at ? 'resume' : 'pause';
}

/**
 * The keys a newer key replaced (its rotated_from), while that newer key is
 * not revoked: they work out their overlap and are rotated no further.
 */
export function replacedKeyIds(keys: readonly Pick<ApiKey, 'rotated_from' | 'revoked_at'>[]): Set<string> {
  return new Set(keys.filter((key) => key.rotated_from && !key.revoked_at).map((key) => key.rotated_from as string));
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
  const endedAt = (key: ApiKey) => new Date(key.revoked_at ?? key.disabled_at ?? key.expires_at ?? key.updated_at).getTime();
  groups.ended.sort((a, b) => endedAt(b) - endedAt(a));
  return groups;
}

/**
 * An agent's key on this page: always listed and revocable (an Owner must be
 * able to stop one even with the Agents module off, when its profile is out
 * of reach); Open Connect only where the person can act there: the profile
 * opens (agents on, agents.manage) and its Connect tab shows the keys
 * (api_keys.manage_all, the server's rule for an agent's keys). Anyone else
 * is told who makes and rotates agent keys instead of being sent to a tab
 * that shows them nothing.
 */
export function agentKeyRow(input: { agentsOn: boolean; canManageAgents: boolean; canManageAllKeys: boolean }): { listed: true; revoke: true; openConnect: boolean } {
  return { listed: true, revoke: true, openConnect: input.agentsOn && input.canManageAgents && input.canManageAllKeys };
}

/** Who makes and rotates an agent's keys, for someone who cannot. */
export const AGENT_KEYS_WHO = "An Owner, or someone who manages every API key, makes and rotates agent keys on each agent's profile.";

export interface KeyExpiry {
  label: string;
  tone: 'muted' | 'warning' | 'danger';
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * When a key stops working, in plain words: "No expiry", "Expires Mar 3"
 * (from formatDate), "Ends in 9 days. Replace it to keep it working" inside
 * two weeks (new agent keys end after 90 days), "Ends in 5 hours" inside two
 * days (a rotated key's overlap), "Expired".
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
  // Two weeks out, say how soon, so a key is replaced before it stops working.
  if (left < 14 * DAY) {
    const days = Math.round(left / DAY);
    return { label: `Ends in ${days} days. Replace it to keep it working`, tone: 'warning' };
  }
  return { label: `Expires ${formatDate(expiresAt)}`, tone: 'muted' };
}

/** After a rotation: when the new key ends, in one line. */
export function rotatedKeyExpiryLine(expiresAt: string | null, formatEnd: (iso: string) => string = (iso) => iso.slice(0, 10)): string {
  return expiresAt ? `The new key expires ${formatEnd(expiresAt)}.` : 'The new key has no expiry.';
}

/**
 * Before a rotation: how long the new key will last. A person's lasts as
 * long as this one was made to last, within the workspace's key lifetime (the
 * server's rule, rotatedKeyLifetimeDays); an agent's gets the agent key lifetime.
 */
export function rotationLifetimeNote(key: Pick<ApiKey, 'created_at' | 'expires_at'>, agent = false): string {
  if (agent) return "The new key lasts as long as your workspace's agent key lifetime. You see its end date before you copy it.";
  if (!key.expires_at) return "This key has no expiry. The new one has none either, unless your workspace limits how long keys last. You see its end date before you copy it.";
  const days = Math.max(1, Math.round((Date.parse(key.expires_at) - Date.parse(key.created_at)) / 86_400_000));
  return `The new key lasts ${lifetimeLabel(days)}, as long as this one was made to, within your workspace's key lifetime. You see its end date before you copy it.`;
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

/** A lifetime in words: "30 days", "1 year". */
const lifetimeLabel = (days: number) => (days === 365 ? '1 year' : `${days} ${days === 1 ? 'day' : 'days'}`);

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
  const label = lifetimeLabel;
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

/**
 * Settings > Developers, Key lifetimes: what an Owner picks for new keys.
 * The New key dialog's standard choices, a lifetime already set that is none
 * of them, and No expiry.
 */
export function keyLifetimeSettingOptions(current: number | null): { value: string; label: string }[] {
  const days = [...new Set([...KEY_LIFETIME_DAYS, ...(current === null ? [] : [current])])].sort((a, b) => a - b);
  return [...days.map((d) => ({ value: String(d), label: lifetimeLabel(d) })), { value: NO_KEY_EXPIRY, label: 'No expiry' }];
}

/**
 * Settings > Developers, Key lifetimes, AI agent keys. Nothing set means a
 * company agent's key ends after NEW_AGENT_KEY_DAYS (key-lifetime.ts), so
 * that choice says so instead of "No expiry"; a key that never ends is
 * picked per key by an Owner.
 */
export function agentKeyLifetimeSettingOptions(current: number | null): { value: string; label: string }[] {
  const days = [...new Set([...KEY_LIFETIME_DAYS, ...(current === null ? [] : [current])])].filter((d) => d !== NEW_AGENT_KEY_DAYS || d === current).sort((a, b) => a - b);
  return [{ value: NO_KEY_EXPIRY, label: `${lifetimeLabel(NEW_AGENT_KEY_DAYS)} (default)` }, ...days.map((d) => ({ value: String(d), label: lifetimeLabel(d) }))];
}

/** A lifetime as a choice: its days, or 'none' for no expiry. */
export const keyLifetimeChoice = (days: number | null): string => (days === null ? NO_KEY_EXPIRY : String(days));

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
  'question.expired': 'Question expired',
  'suggestion.created': 'Suggestion made',
  'suggestion.decided': 'Suggestion decided',
  'review.submitted': 'Review submitted',
  'run.started': 'Agent run started',
  'run.updated': 'Agent run waiting or back at work',
  'run.finished': 'Agent run finished',
  'agent.offline': 'Agent stopped responding',
  'agent.online': 'Agent back',
  'agent.paused': 'Agent paused',
  'agent.resumed': 'Agent resumed',
  'budget.exceeded': 'Agent budget spent',
  'template.run': 'Template used',
  'initiative.created': 'Initiative made',
  'initiative.updated': 'Initiative changed',
  'initiative.deleted': 'Initiative moved to Trash',
  'initiative_entry.created': 'Initiative log entry added',
  'initiative_entry.updated': 'Initiative log entry changed',
  'agent_event.created': 'Every agent event',
  'assistant.message': 'Chat message for an assistant (old name)',
  'chat.message': 'Chat message for an agent',
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
  /** Older names still sent to endpoints that have them: shown only while ticked, never added by the group box. */
  legacyEvents?: readonly string[];
  /** Offered only while Client invoicing is on. */
  invoices?: boolean;
}

/** The event picker, in plain groups. Agent events and assistant chat are opt in: never a default. */
export const WEBHOOK_EVENT_GROUPS: readonly WebhookEventGroup[] = [
  {
    id: 'work',
    label: 'Work',
    description: 'Tasks made, changed or moved to Trash, comments, suggestions, reviews, templates used, and initiatives and their logs.',
    events: [
      'task.created', 'task.updated', 'task.deleted', 'comment.created', 'suggestion.created', 'suggestion.decided', 'review.submitted', 'template.run',
      'initiative.created', 'initiative.updated', 'initiative.deleted', 'initiative_entry.created', 'initiative_entry.updated',
    ],
  },
  { id: 'questions', label: 'Questions', description: 'Questions asked, answered, withdrawn or expired.', events: ['question.asked', 'question.answered', 'question.cancelled', 'question.expired'] },
  { id: 'runs', label: 'Agents', description: 'When an agent starts a run, waits on a person, finishes, stops responding or comes back, is paused or resumed, or spends its budget.', events: ['run.started', 'run.updated', 'run.finished', 'agent.offline', 'agent.online', 'agent.paused', 'agent.resumed', 'budget.exceeded'] },
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
    label: 'Chat',
    description: 'A chat message for an agent: a person writing to their own assistant, or company chat for a company agent. For the host that answers it. Pick the agent under Member on the next step.',
    events: ['chat.message'],
    legacyEvents: ['assistant.message'],
  },
];

/** A group's events as this endpoint sees them: its own, plus any older name it already has. */
export function groupEventsFor(group: WebhookEventGroup, current: readonly string[]): string[] {
  return [...group.events, ...(group.legacyEvents ?? []).filter((event) => current.includes(event))];
}

/** Events that carry chat: private, so only to one agent or an assistant setup, never filtered by project. */
export const CHAT_WEBHOOK_EVENTS: readonly string[] = ['chat.message', 'assistant.message'];

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

/**
 * What the form knows beyond the draft: what kind of member each id is (an
 * agent, and whether it is a person's own assistant), and whether the
 * endpoint is scoped to an assistant setup (every assistant it made), which
 * then takes the place of a member.
 */
export interface WebhookFormContext {
  memberKind?: (id: string) => 'person' | 'agent' | 'personal_agent' | null;
  setupScoped?: boolean;
}

/**
 * The first problem on a step, or null. Invoice events kept from when
 * invoicing was on still count, though hidden. The filters step also holds
 * the database's chat rules, so they are met before a save, never after:
 * chat goes to one agent (an old assistant.message, to one person's own
 * assistant) or an assistant setup, is never filtered by project, and a
 * setup-scoped endpoint has no member.
 */
export function webhookStepProblem(draft: WebhookDraft, step: WebhookStep, context: WebhookFormContext = {}): string | null {
  if (step === 'endpoint') {
    if (!draft.name.trim()) return 'Give the endpoint a name.';
    // HTTPS to a public address; local development also allows http on localhost (the API's rule too).
    const urlError = webhookUrlError(draft.url.trim());
    return urlError ? `${urlError}.` : null;
  }
  if (step === 'events') return draft.events.length === 0 ? 'Choose at least one event.' : null;
  if (context.setupScoped && draft.memberId) return 'This endpoint sends for every assistant from a setup, so it cannot also be limited to one member. Set Member to Everyone.';
  const chat = draft.events.some((event) => CHAT_WEBHOOK_EVENTS.includes(event));
  if (chat && draft.projectIds.length > 0) return 'Chat is never tied to a project, so a project filter would stop every chat message. Clear Projects, or untick Chat.';
  if (chat && !context.setupScoped) {
    const kind = draft.memberId ? context.memberKind?.(draft.memberId) ?? null : null;
    if (draft.events.includes('chat.message') && kind !== 'agent' && kind !== 'personal_agent') {
      return 'Chat needs one agent under Member: chat is private, so it only goes to the agent it is for.';
    }
    if (draft.events.includes('assistant.message') && kind !== 'personal_agent') {
      return 'Chat for an assistant (old name) needs one person\'s own assistant under Member. Untick it to send Chat to a company agent.';
    }
  }
  if (!draft.events.includes('agent_event.created')) return null;
  const bad = parseAgentEventTypes(draft.agentEventTypes).find((type) => !AGENT_EVENT_TYPE.test(type));
  return bad ? `${bad} is not an agent event type.` : null;
}

/** The first step with a problem, so Save lands where the fix is. */
export function firstWebhookProblem(draft: WebhookDraft, context: WebhookFormContext = {}): { step: WebhookStep; message: string } | null {
  for (const step of ['endpoint', 'events', 'filters'] as const) {
    const message = webhookStepProblem(draft, step, context);
    if (message) return { step, message };
  }
  return null;
}

/**
 * A failed endpoint save in words the person can act on: the database's
 * chat and scope rules and a refused permission each say what to change;
 * another check names its own reason; anything else asks to try again.
 */
export function webhookSaveError(error: unknown, editing: boolean): string {
  const fallback = editing ? 'Could not save the endpoint. Try again.' : 'Could not create the endpoint. Try again.';
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  const text = message ?? '';
  if (/assistant\.message goes only/.test(text)) return 'Chat for an assistant (old name) needs one person\'s own assistant under Member.';
  if (/chat\.message goes only/.test(text)) return 'Chat needs one agent under Member: chat is private, so it only goes to the agent it is for.';
  if (/one_scope|one member or scoped to one assistant setup/.test(text)) return 'This endpoint sends for every assistant from a setup, so it cannot also be limited to one member. Set Member to Everyone.';
  if (code === 'encryption_key_missing') return 'Add the encryption key first (Settings > Workspace > Encryption): webhook signing secrets are only stored encrypted.';
  if (/Only an Owner(, or a key with assistants\.provision,)? scopes an endpoint/.test(text)) return 'Only an Owner can send events for a whole assistant setup.';
  if (code === '42501' || code === 'missing_permission') return 'You no longer have permission to manage webhooks. Ask an Owner.';
  if (code === '23514' && text) return `The endpoint was refused: ${text}`;
  // The server's own check of a field (an address that is not HTTPS or not public, an unknown event): its words.
  if ((code === 'invalid_body' || code === 'VALIDATION_ERROR') && text) return `The endpoint was refused: ${text}`;
  return fallback;
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
  /** Failed for good, among this endpoint's latest deliveries loaded. */
  failed: number;
  /** Waiting out a backoff after a failed try. */
  retrying: number;
}

/** How many of each endpoint's newest deliveries the panel reads for its health. */
export const ENDPOINT_HEALTH_DELIVERIES = 20;

/**
 * An endpoint's state from its own latest deliveries (each endpoint's, not
 * the newest across all of them): paused wins; failing only when its newest
 * finished delivery failed, so one that failed and then recovered is healthy
 * (its older failures stay as a count); then retries waiting out a backoff.
 */
export function endpointHealth(endpoint: Pick<WebhookEndpoint, 'id' | 'is_active' | 'last_delivery_at'>, deliveries: readonly WebhookDelivery[]): EndpointHealth {
  const own = deliveries.filter((delivery) => delivery.endpoint_id === endpoint.id);
  const failed = own.filter((delivery) => delivery.status === 'failed').length;
  const retrying = own.filter((delivery) => delivery.status === 'pending' && delivery.attempts > 0).length;
  const finishedAt = (delivery: WebhookDelivery) => Date.parse(delivery.last_attempt_at ?? delivery.delivered_at ?? delivery.updated_at ?? delivery.created_at);
  const newestFinished = own
    .filter((delivery) => delivery.status === 'failed' || delivery.status === 'succeeded')
    .sort((a, b) => finishedAt(b) - finishedAt(a))[0];
  const state = !endpoint.is_active ? 'paused'
    : newestFinished?.status === 'failed' ? 'failing'
      : retrying > 0 ? 'retrying'
        : endpoint.last_delivery_at || own.length > 0 ? 'ok' : 'idle';
  return { state, failed, retrying };
}

/**
 * A delivery's detail line. A retry waiting out its backoff says when it
 * goes, unless scheduled retries are off: then nothing sends it on its own,
 * so it says how to send it now.
 */
export function deliveryDetailLine(
  delivery: Pick<WebhookDelivery, 'status' | 'attempts' | 'last_error' | 'delivered_at' | 'next_attempt_at'>,
  retriesOn: boolean,
  formatWhen: (iso: string | null) => string,
): string {
  if (delivery.status === 'succeeded') return `Delivered ${formatWhen(delivery.delivered_at)}`;
  if (delivery.status === 'delivering') return 'Sending now';
  if (delivery.status === 'failed') return delivery.last_error || 'Failed';
  if (delivery.attempts > 0) {
    return retriesOn
      ? `${delivery.last_error || 'Failed'}, next try ${formatWhen(delivery.next_attempt_at)}`
      : `${delivery.last_error || 'Failed'}. Waiting: retries are off, so use Send pending now.`;
  }
  return 'Queued';
}

/**
 * What an endpoint is sent, one short label per group: "Work" when every
 * event in it is on, "Work: 3 of 7" when some are. Invoice events kept while
 * Client invoicing is off still show, so nothing is hidden.
 */
export function eventSummary(events: readonly string[]): string[] {
  const on = new Set(events);
  const known = new Set(WEBHOOK_EVENT_GROUPS.flatMap((group) => [...group.events, ...(group.legacyEvents ?? [])]));
  const labels = WEBHOOK_EVENT_GROUPS.flatMap((group) => {
    const count = group.events.filter((event) => on.has(event)).length;
    const legacy = (group.legacyEvents ?? []).some((event) => on.has(event));
    if (count === 0) return legacy ? [`${group.label} (old name)`] : [];
    return [count === group.events.length ? group.label : `${group.label}: ${count} of ${group.events.length}`];
  });
  // An event this screen does not know yet (a newer server) still shows by name.
  return [...labels, ...events.filter((event) => !known.has(event))];
}
