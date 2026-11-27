import { inboxAgentName, syncWaitingNotification, type PlanMessage } from './plans';
import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ENDPOINT_PERMISSION_SET, type AccessChannel, type AccessContext, type PermissionKey } from '@/lib/access-control';
import { accessAllows, accessAllowsProject, apiKeyAllows } from '@/lib/api/access';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { getActorClient } from '@/lib/api/supabase-service';
import { DEFAULT_ITEM_COLOR } from '@/lib/brand';
import { domainOf, normalizeAddress, organizationalDomain } from './email/addresses';
import { attachmentKind } from './attachments';
import { normalizeContentId } from './email/display';
import { isPublicEmailDomain, validateClientDomain } from './email/public-domains';
import type { CandidateReason } from './mapping';
import { attentionCounts, CODE_PIN_MINUTES, codeIn, draftWaiting, matchesSearch, snippetOf, tabCounts, threadFlags, threadInTab, type DraftState, type InboxAttention, type MessageState, type ThreadFlags } from './inbox-view';
import type { MailKind, MailTopic } from './sorting';
import { inboxDisplayName, meetingPackageOf, MEETING_PACKAGE_LABELS } from './inbox-types';
import type {
  InboxAttachment, InboxCandidate, InboxChannel, InboxMeeting, InboxMeetingSummary, InboxReminder, InboxSorting, TaskLinkRelation, InboxLinkedTask, InboxMessage, InboxPerson, InboxSummary, InboxTab,
  InboxLatestCode, InboxThreadDetail, InboxThreadList, InboxThreadSummary, MessageStatus, ProjectSource, RememberableSender, RoutingBasis,
  SetThreadProjectRequest, SetThreadProjectResult, TaskSourceEmails, ThreadProject, TriageOutcome, TrustLevel,
  InboxPlan, InboxPlanItem, InboxReplyPoint, InboxQuestion,
} from './inbox-types';
import type { TriageCategory } from './outreach';
import { comms } from '@/lib/communications/db';
import { memberTriagesInbox, ownerColumnRead, ownersReadPersonalInboxes, readableInboxIdsFor } from './inbox-visibility';
import { pmStorage } from '@/lib/supabase/storage';
import { BUCKETS } from '@/lib/supabase/schema';

/**
 * The Inbox for people signed in to the app (session routes). Reads use the
 * service client, scoped here the way RLS scopes them (can_read_inbox, in
 * inbox-visibility.ts): shared inboxes by inbound_email.manage or a grant
 * with inbound_email.read, personal ones by their owner and the people they
 * shared them with. Reading is read only: the human actions (set or
 * confirm a thread's project and remember the sender or domain, rule 7; mark
 * handled; send back to the agent) need inbound_email.triage or
 * inbound_email.manage. Names from projects the member cannot reach (the
 * thread's project, candidates, linked tasks) are never returned. Nothing
 * here sends, replies to or forwards email, and nothing deletes a message or
 * a file.
 */

export class InboxError extends Error {
  /** reason: a stable word for the API's error details (lib/api/inbox-api.ts); the app shows the message. */
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
  }
}

export interface InboxContext {
  service: SupabaseClient;
  access: AccessContext;
  memberId: string;
  /**
   * Through the API (lib/api/inbox-api.ts): the key's scopes. Left out in the
   * app (session routes). With them every rule here is read on the api
   * channel, as the other inbox API routes read it.
   */
  scopes?: string[];
}

/** The channel a request came in on: the app, or a key. */
export function inboxChannel(ctx: InboxContext): AccessChannel {
  return ctx.scopes ? 'api' : 'app';
}

/**
 * Whether the member may do this. In the app: their app grant. Through the
 * API: their api grant, and the key's scope when it is a permission a key
 * carries (inbound_email.manage is not: as everywhere in the inbox API it is
 * the member's alone).
 */
export function inboxAllows(ctx: InboxContext, permission: PermissionKey): boolean {
  if (!ctx.scopes) return accessAllows(ctx.access, permission, 'app');
  if (API_ENDPOINT_PERMISSION_SET.has(permission)) return apiKeyAllows(ctx.access, ctx.scopes, permission);
  return accessAllows(ctx.access, permission, 'api');
}

/** Whether the member reaches a project, on the request's channel. */
export function inboxReaches(ctx: InboxContext, projectId: string): boolean {
  return accessAllowsProject(ctx.access, projectId, inboxChannel(ctx));
}

/**
 * Who writes, for the team log: in the app the member's actor client;
 * through the API the key's (already ctx.service, logged as the key's member).
 */
export function inboxActor(ctx: InboxContext): SupabaseClient {
  return ctx.scopes ? ctx.service : getActorClient(ctx.memberId, 'app');
}

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 100;

export function assertId(value: string | null | undefined, name = 'id'): string {
  if (!value || !UUID.test(value)) throw new InboxError(400, `${name} must be a UUID`);
  return value.toLowerCase();
}

/** Every row whose `column` is in `ids`, in chunks (URL length) and pages (row cap). */
export async function readIn<T extends Row>(
  ids: readonly string[],
  page: (chunk: string[], from: number, to: number, count: 'exact' | undefined) => PromiseLike<{ data: unknown; error: unknown; count?: number | null }>,
): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    out.push(...await fetchAllRows<T>((from, to, count) =>
      page(chunk, from, to, count) as PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>));
  }
  return out;
}

export async function one<T extends Row>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw error;
  return (data as T | null) ?? null;
}

export async function many<T extends Row>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

/**
 * May open the Inbox at all: shared inbox reading or managing, or a personal
 * inbox of their own (inbound_email.personal is an app permission on either
 * channel, as inbox-visibility reads it). Which inboxes is readableInboxIds.
 */
export function canReadInbox(ctx: InboxContext): boolean {
  return inboxAllows(ctx, 'inbound_email.read') || inboxAllows(ctx, 'inbound_email.manage') || accessAllows(ctx.access, 'inbound_email.personal', 'app');
}

/**
 * Could act on some inbox at all: triage or manage (shared inboxes), or a
 * personal inbox of their own. Which threads is per inbox (loadTriageableThread).
 */
export function canTriageInbox(ctx: InboxContext): boolean {
  // Through the API a key acts on no inbox without the triage scope, its member's own personal inbox included.
  if (ctx.scopes && !ctx.scopes.includes('inbound_email.triage')) return false;
  return inboxAllows(ctx, 'inbound_email.triage') || inboxAllows(ctx, 'inbound_email.manage') || accessAllows(ctx.access, 'inbound_email.personal', 'app');
}

const TRIAGE_DENIED = 'Viewing this inbox is read only. Acting on its email needs permission to triage inbox email, or it being your own inbox.';

export function canManageInboxes(ctx: InboxContext): boolean {
  return inboxAllows(ctx, 'inbound_email.manage');
}

/** Sender rules apply to every inbox, so seeing and changing them takes managing inboxes. */
export function assertCanManageInboxes(ctx: InboxContext) {
  if (!canManageInboxes(ctx)) throw new InboxError(403, 'Sender rules apply to every inbox, so they need permission to manage inboxes.');
}

/** What a project the member cannot reach is called instead of its name. */
export const OTHER_PROJECT_LABEL = 'Another project';

function isPerson(access: AccessContext): boolean {
  return access.role !== 'agent';
}

/** The inboxes this member reads, in the app or through a key (mirrors communications.can_read_inbox). */
export async function readableInboxIds(ctx: InboxContext): Promise<string[]> {
  return readableInboxIdsFor(ctx.service, ctx.memberId, ctx.access, inboxChannel(ctx));
}

async function memberNames(service: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const found = await many<{ id: string; name: string }>(service.from('team_members').select('id, name').in('id', unique));
  return new Map(found.map((row) => [row.id, row.name]));
}

/** Names of the given projects the member can reach; the rest are left out. */
async function projectNames(ctx: InboxContext, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id && inboxReaches(ctx, id)))];
  if (unique.length === 0) return new Map();
  const found = await readIn<{ id: string; name: string }>(unique, (chunk, from, to, count) =>
    ctxSelect(ctx.service, 'projects', 'id, name', count).in('id', chunk).order('id').range(from, to));
  return new Map(found.map((row) => [row.id, row.name]));
}

/** The thread's project name, or a neutral label when the member cannot reach the project. */
function projectLabel(ctx: InboxContext, names: Map<string, string>, id: string): string {
  if (!inboxReaches(ctx, id)) return OTHER_PROJECT_LABEL;
  return names.get(id) ?? 'Project';
}

/** How strongly a project is known, as communications.project_source_rank orders it. */
const SOURCE_RANK: Record<ProjectSource, number> = { person: 1, address: 2, mapped: 3, inferred: 4, guessed: 5 };

/**
 * Every project each thread is filed on, strongest first, named as the member
 * may see them (with the project address that filed one, when they can reach it).
 */
async function threadProjects(ctx: InboxContext, threadIds: string[]): Promise<Map<string, ThreadProject[]>> {
  const byThread = new Map<string, ThreadProject[]>();
  if (threadIds.length === 0) return byThread;
  const filed = await readIn<{ conversation_id: string; project_id: string; source: ProjectSource; endpoint_id: string | null; created_at: string }>(
    [...new Set(threadIds)], (chunk, from, to, count) =>
      ctxSelect(comms(ctx.service), 'conversation_projects', 'conversation_id, project_id, source, endpoint_id, created_at', count)
        .in('conversation_id', chunk).order('conversation_id').order('project_id').range(from, to));
  const endpointIds = [...new Set(filed.map((row) => row.endpoint_id).filter((id): id is string => !!id))];
  const [names, endpoints] = await Promise.all([
    projectNames(ctx, filed.map((row) => row.project_id)),
    endpointIds.length
      ? many<{ id: string; routing_address: string; public_address: string | null }>(comms(ctx.service).from('endpoints')
          .select('id, routing_address, public_address').in('id', endpointIds))
      : Promise.resolve([]),
  ]);
  filed.sort((a, b) => (SOURCE_RANK[a.source] - SOURCE_RANK[b.source]) || a.created_at.localeCompare(b.created_at) || a.project_id.localeCompare(b.project_id));
  for (const row of filed) {
    const endpoint = row.endpoint_id ? endpoints.find((e) => e.id === row.endpoint_id) : undefined;
    const list = byThread.get(row.conversation_id) ?? [];
    list.push({
      id: row.project_id,
      name: projectLabel(ctx, names, row.project_id),
      source: row.source,
      address: endpoint && inboxReaches(ctx, row.project_id) ? endpoint.public_address ?? endpoint.routing_address : null,
    });
    byThread.set(row.conversation_id, list);
  }
  return byThread;
}

/** A public table (service) or a communications one (comms(service)). */
export function ctxSelect(service: SupabaseClient | ReturnType<typeof comms>, table: string, columns: string, count: 'exact' | undefined) {
  // trash-checked: callers name the table; project names for email history include projects in Trash.
  return (service as SupabaseClient).from(table).select(columns, count ? { count } : undefined);
}

async function inboxSummaries(service: SupabaseClient, ids: string[]): Promise<InboxSummary[]> {
  if (ids.length === 0) return [];
  // Before the 1.6.0 migration there is no owner column: every inbox is shared.
  const inboxes = (await ownerColumnRead<{ id: string; name: string; address: string; enabled: boolean; handler_member_id: string | null; owner_member_id?: string | null }[] | null>(
    () => comms(service).from('inboxes').select('id, name, address, enabled, handler_member_id, owner_member_id').in('id', ids).order('name'),
    () => comms(service).from('inboxes').select('id, name, address, enabled, handler_member_id').in('id', ids).order('name'),
  )) ?? [];
  const names = await memberNames(service, inboxes.flatMap((inbox) => [inbox.handler_member_id, inbox.owner_member_id]));
  return inboxes.map((inbox) => ({
    id: inbox.id,
    name: inbox.name,
    address: inbox.address,
    enabled: inbox.enabled,
    handler: inbox.handler_member_id ? { id: inbox.handler_member_id, name: names.get(inbox.handler_member_id) ?? 'Agent' } : null,
    owner: inbox.owner_member_id ? { id: inbox.owner_member_id, name: names.get(inbox.owner_member_id) ?? 'A former teammate' } : null,
  }));
}

function trustOf(auth: unknown): TrustLevel {
  const trust = (auth as Row | null)?.trust;
  return trust === 'trusted' || trust === 'untrusted' ? trust : 'unknown';
}

function latestTriage<T extends { message_id: string; created_at: string; id: string }>(rows: T[]): Map<string, T> {
  const sorted = [...rows].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));
  const latest = new Map<string, T>();
  for (const row of sorted) if (!latest.has(row.message_id)) latest.set(row.message_id, row);
  return latest;
}

export interface ThreadRow {
  id: string;
  inbox_id: string;
  channel: InboxChannel;
  subject_normalized: string;
  project_id: string | null;
  project_source: ProjectSource | null;
  /** Read for thread detail only. */
  project_address_id?: string | null;
  summary?: string | null;
  last_message_at: string;
}

interface StateMessageRow {
  id: string;
  thread_id: string;
  status: MessageStatus | 'receiving';
  subject: string;
  received_at: string;
  auth: unknown;
  reviewed_at: string | null;
  reviewed_by?: string | null;
  routing_basis: RoutingBasis | null;
  original_from_address: string | null;
  original_from_name: string | null;
  kind: MailKind | null;
  topic: MailTopic | null;
}

const ROUTING_COLUMNS = 'routing_basis, original_from_address, original_from_name';

/** Who a message is from, as people read it: the original sender of a teammate's forward, else its From. */
function shownSender(
  row: object,
  from: { name: string; address: string } | null | undefined,
): { name: string; address: string } | null {
  const message = row as Partial<Pick<StateMessageRow, 'routing_basis' | 'original_from_address' | 'original_from_name'>>;
  if (message.routing_basis === 'forwarded_original' && typeof message.original_from_address === 'string') {
    return { name: message.original_from_name ?? '', address: message.original_from_address };
  }
  return from ?? null;
}

interface TriageStateRow { id: string; message_id: string; outcome: TriageOutcome; urgent: boolean; category: TriageCategory | null; created_at: string }

/** communications.meetings as the Inbox reads it. */
interface MeetingRow {
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  organizer_address: string | null;
  doc_url: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
}

const MEETING_COLUMNS = 'title, starts_at, ends_at, organizer_address, doc_url, dismissed_at, dismissed_by';

/** An embedded meeting: an object from PostgREST (one to one), a one-row list from simpler readers. */
function embeddedMeeting(value: unknown): MeetingRow | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === 'object' ? row as MeetingRow : null;
}

/** A meeting as a list row and the thread header show it. */
function meetingSummary(row: MeetingRow, names: Map<string, string>, organizerName = ''): InboxMeetingSummary {
  return {
    title: row.title,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    organizer: row.organizer_address ? { address: row.organizer_address, name: organizerName } : null,
    doc_url: row.doc_url,
    dismissed: row.dismissed_at
      ? { at: row.dismissed_at, by: row.dismissed_by ? { id: row.dismissed_by, name: names.get(row.dismissed_by) ?? 'Someone' } : null }
      : null,
  };
}

/** What a meeting holds, in a line: "Transcript and Gemini's notes". */
function meetingPackagesLine(subjects: string[]): string {
  const kinds = new Set(subjects.map(meetingPackageOf));
  const labels = (['transcript', 'notes'] as const).filter((kind) => kinds.has(kind)).map((kind) => MEETING_PACKAGE_LABELS[kind]);
  return labels.length ? labels.join(' and ') : 'Meeting notes';
}

interface ThreadEntry {
  thread: ThreadRow;
  meeting: MeetingRow | null;
  messages: StateMessageRow[];
  flags: ThreadFlags;
  sender: { name: string; address: string } | null;
  senders: { name: string; address: string }[];
}

/** Every thread in the given inboxes with its messages' states, newest activity first. */
async function loadThreadEntries(service: SupabaseClient, inboxIds: string[], projectId: string | null): Promise<ThreadEntry[]> {
  if (inboxIds.length === 0) return [];
  // One round: threads and their emails both read by inbox, each email with
  // its triage and its From in the same request.
  const [onProject, threadRows, messageRows, agentIds] = await Promise.all([
    // A project's threads: every thread filed on it, whatever else it is filed on.
    projectId
      ? many<{ conversation_id: string }>(comms(service).from('conversation_projects').select('conversation_id').eq('project_id', projectId))
        .then((rows) => new Set(rows.map((row) => row.conversation_id)))
      : Promise.resolve(null),
    // A meeting's own row and the thread's reply drafts ride along, so the list stays four rounds.
    readIn<ThreadRow & Row & { meeting?: unknown; reply_drafts?: DraftState[] }>(inboxIds, (chunk, from, to, count) =>
      ctxSelect(comms(service), 'conversations', `id, inbox_id, channel, subject_normalized, project_id, project_source, summary, last_message_at, meeting:meetings(${MEETING_COLUMNS}), reply_drafts(status, copied_at, created_at, completed_at)`, count)
        .in('inbox_id', chunk).order('id').range(from, to)),
    readIn<StateMessageRow & Row & { triage: TriageStateRow[]; from_participant: { address: string; name: string }[] }>(inboxIds, (chunk, from, to, count) =>
      ctxSelect(comms(service), 'messages', `id, thread_id, status, subject, received_at, auth, reviewed_at, reviewed_by, kind, topic, ${ROUTING_COLUMNS}, `
        + 'triage(id, message_id, outcome, urgent, category, created_at), from_participant:participants(address, name)', count)
        .in('inbox_id', chunk).neq('status', 'receiving').eq('from_participant.kind', 'from').order('id').range(from, to)),
    // Agents: an agent settling earlier mail is not a person marking the thread handled (a ready draft stays).
    many<{ id: string }>(service.from('team_members').select('id').eq('role', 'agent')).then((rows) => new Set(rows.map((row) => row.id))),
  ]);
  const threads = threadRows.filter((thread) => !onProject || onProject.has(thread.id));
  if (threads.length === 0) return [];
  const threadIds = new Set(threads.map((thread) => thread.id));
  const messages = messageRows.filter((message) => threadIds.has(message.thread_id));
  const triage = messages.flatMap((message) => message.triage ?? []);
  const senders = messages.flatMap((message) => (message.from_participant ?? []).slice(0, 1).map((from) => ({ message_id: message.id, ...from })));
  const latest = latestTriage(triage);
  // Every triage counts here, not only the latest: once read as work, a thread is never FYI.
  const everWork = new Set(triage.filter((row) => row.category === 'work').map((row) => row.message_id));
  const fromByMessage = new Map(senders.map((row) => [row.message_id, { name: row.name, address: row.address }]));
  const senderByMessage = new Map(messages.map((message) => [message.id, shownSender(message, fromByMessage.get(message.id))]));
  // Search also finds a forward by the teammate who sent it on.
  const forwarderByMessage = new Map(messages
    .filter((message) => message.routing_basis === 'forwarded_original')
    .map((message) => [message.id, fromByMessage.get(message.id)]));
  const byThread = new Map<string, StateMessageRow[]>();
  for (const message of messages) {
    const list = byThread.get(message.thread_id) ?? [];
    list.push(message);
    byThread.set(message.thread_id, list);
  }
  const entries: ThreadEntry[] = [];
  for (const thread of threads) {
    const list = (byThread.get(thread.id) ?? []).sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0));
    if (list.length === 0) continue;
    const states: MessageState[] = list.map((message) => {
      const triageRow = latest.get(message.id);
      return {
        status: message.status as MessageStatus,
        reviewed_at: message.reviewed_at,
        outcome: triageRow?.outcome ?? null,
        urgent: triageRow?.urgent ?? false,
        trust: trustOf(message.auth),
        kind: message.kind,
        topic: message.topic,
        category: triageRow?.category ?? null,
        ever_work: everWork.has(message.id),
      };
    });
    const threadSenders = list.flatMap((message) => [senderByMessage.get(message.id), forwarderByMessage.get(message.id)])
      .filter((s): s is { name: string; address: string } => !!s);
    entries.push({
      thread,
      meeting: thread.channel === 'meeting' ? embeddedMeeting((thread as { meeting?: unknown }).meeting) : null,
      messages: list,
      flags: threadFlags(states, {
        draft_ready: draftWaiting((thread as { reply_drafts?: DraftState[] }).reply_drafts, list.map((message) => ({
          received_at: message.received_at,
          reviewed_at: message.reviewed_at,
          reviewed_by_person: !!message.reviewed_by && !agentIds.has(message.reviewed_by),
        }))),
      }),
      sender: senderByMessage.get(list[list.length - 1].id) ?? null,
      senders: threadSenders,
    });
  }
  return entries.sort((a, b) => (a.thread.last_message_at < b.thread.last_message_at ? 1 : a.thread.last_message_at > b.thread.last_message_at ? -1 : 0));
}

export interface ThreadListFilters {
  inboxId: string | null;
  projectId: string | null;
  /** Only threads with an email linked to this task. */
  taskId?: string | null;
  tab: InboxTab;
  search: string;
  limit: number;
  offset: number;
}

interface EmailReminderRow extends Row {
  id: string;
  source_message_id: string;
  title: string;
  remind_on: string | null;
  status: 'open' | 'done';
  task_id: string | null;
  project_id: string | null;
  owner_id: string;
  created_by: string | null;
  created_at: string;
}

/**
 * Reminders that came from these emails, seen the way the app shows a
 * reminder anywhere else: a standalone one only to its owner or writer, one
 * on a project to whoever can open the project, and none whose task or
 * project is in the trash.
 */
async function emailReminders(ctx: InboxContext, messageIds: string[], openOnly: boolean): Promise<EmailReminderRow[]> {
  if (messageIds.length === 0) return [];
  const rows = await readIn<EmailReminderRow>(messageIds, (chunk, from, to, count) => {
    const query = ctxSelect(ctx.service, 'reminders', 'id, source_message_id, title, remind_on, status, task_id, project_id, owner_id, created_by, created_at', count)
      .in('source_message_id', chunk).is('deleted_at', null);
    return (openOnly ? query.eq('status', 'open') : query).order('id').range(from, to);
  });
  if (rows.length === 0) return [];
  const taskIds = [...new Set(rows.map((row) => row.task_id).filter((id): id is string => !!id))];
  const projectIds = [...new Set(rows.map((row) => row.project_id).filter((id): id is string => !!id))];
  const [liveTasks, liveProjects] = await Promise.all([
    taskIds.length ? readIn<{ id: string }>(taskIds, (chunk, from, to, count) =>
      ctxSelect(ctx.service, 'tasks', 'id', count).in('id', chunk).is('deleted_at', null).order('id').range(from, to)) : Promise.resolve([]),
    projectIds.length ? readIn<{ id: string }>(projectIds, (chunk, from, to, count) =>
      ctxSelect(ctx.service, 'projects', 'id', count).in('id', chunk).is('deleted_at', null).order('id').range(from, to)) : Promise.resolve([]),
  ]);
  const taskLive = new Set(liveTasks.map((row) => row.id));
  const projectLive = new Set(liveProjects.map((row) => row.id));
  return rows.filter((row) => {
    if (row.task_id && !taskLive.has(row.task_id)) return false;
    if (row.project_id && !projectLive.has(row.project_id)) return false;
    const mine = row.owner_id === ctx.memberId || row.created_by === ctx.memberId;
    return row.project_id ? mine || inboxReaches(ctx, row.project_id) : mine;
  });
}

/** What a page of list rows shows beyond the thread: snippets, file counts, linked tasks and open reminders. */
async function pageDetails(ctx: InboxContext, page: ThreadEntry[]) {
  const latestIds = page.map((entry) => entry.messages[entry.messages.length - 1].id);
  const pageMessageIds = page.flatMap((entry) => entry.messages.map((message) => message.id));
  const [bodies, attachments, { links, liveTaskIds }, openReminders, waiting] = await Promise.all([
    readIn<{ id: string; new_text: string | null; text_body: string | null }>(latestIds, (chunk, from, to, count) =>
      ctxSelect(comms(ctx.service), 'messages', 'id, new_text, text_body', count).in('id', chunk).order('id').range(from, to)),
    readIn<{ id: string; message_id: string; sha256: string | null }>(pageMessageIds, (chunk, from, to, count) =>
      ctxSelect(comms(ctx.service), 'attachments', 'id, message_id, sha256', count).in('message_id', chunk).order('id').range(from, to)),
    (async () => {
      const links = await readIn<{ id: string; message_id: string; task_id: string }>(pageMessageIds, (chunk, from, to, count) =>
        ctxSelect(comms(ctx.service), 'task_links', 'id, message_id, task_id', count).in('message_id', chunk).order('id').range(from, to));
      // Counts only cover tasks the member can open and that are not in the trash.
      const linkedTaskIds = [...new Set(links.map((link) => link.task_id))];
      const liveTasks = linkedTaskIds.length
        ? (await readIn<{ id: string; project_id: string }>(linkedTaskIds, (chunk, from, to, count) =>
            ctxSelect(ctx.service, 'tasks', 'id, project_id', count).in('id', chunk).is('deleted_at', null).order('id').range(from, to)))
            .filter((task) => inboxReaches(ctx, task.project_id))
        : [];
      return { links, liveTaskIds: new Set(liveTasks.map((task) => task.id)) };
    })(),
    // The open reminders these emails set, the same ones the thread shows.
    emailReminders(ctx, pageMessageIds, true),
    // Suggestions still waiting on a person, as the thread lists them (a question is not one).
    readIn<{ id: string; conversation_id: string }>(page.map((entry) => entry.thread.id), (chunk, from, to, count) =>
      ctxSelect(comms(ctx.service), 'plan_items', 'id, conversation_id', count).in('conversation_id', chunk)
        .eq('mode', 'live').in('state', ['pending', 'accepting']).neq('type', 'ask').order('id').range(from, to)),
  ]);
  const suggestions = new Map<string, number>();
  for (const item of waiting) suggestions.set(item.conversation_id, (suggestions.get(item.conversation_id) ?? 0) + 1);
  return { bodies, attachments, links, liveTaskIds, openReminders, suggestions };
}

export async function listThreads(ctx: InboxContext, filters: ThreadListFilters): Promise<InboxThreadList> {
  if (!canReadInbox(ctx)) throw new InboxError(403, 'Forbidden');
  const readable = await readableInboxIds(ctx);
  const inboxId = filters.inboxId ? assertId(filters.inboxId, 'inbox_id') : null;
  const projectId = filters.projectId ? assertId(filters.projectId, 'project_id') : null;
  if (inboxId && !readable.includes(inboxId)) throw new InboxError(403, 'You cannot read this inbox');
  const scope = inboxId ? [inboxId] : readable;
  // The inbox names (with their handlers) are read alongside and awaited only once needed.
  const inboxesRead = inboxSummaries(ctx.service, readable);
  inboxesRead.catch(() => undefined);
  const entries = await loadThreadEntries(ctx.service, scope, projectId);
  // The inbox for one task: threads with any email linked to it.
  let taskThreads: Set<string> | null = null;
  if (filters.taskId) {
    const taskId = assertId(filters.taskId, 'task_id');
    const linked = await many<{ message_id: string }>(comms(ctx.service).from('task_links').select('message_id').eq('task_id', taskId));
    const messageIds = new Set(linked.map((link) => link.message_id));
    taskThreads = new Set(entries.filter((entry) => entry.messages.some((message) => messageIds.has(message.id))).map((entry) => entry.thread.id));
  }
  const inTask = taskThreads ? entries.filter((entry) => taskThreads!.has(entry.thread.id)) : entries;
  // A search matches the projects threads are filed on, so it reads them for every
  // thread first; the plain list reads them for its page only, alongside the rest.
  // Only reachable project names: search must not reveal another project's threads either.
  const [searchFiled, searchInboxes] = filters.search.trim()
    ? await Promise.all([threadProjects(ctx, inTask.map((entry) => entry.thread.id)), inboxesRead])
    : [null, null];
  const searchInboxNames = new Map((searchInboxes ?? []).map((inbox) => [inbox.id, inbox.name]));
  const searched = searchFiled
    ? inTask.filter((entry) => matchesSearch(filters.search, [
        ...entry.messages.map((message) => message.subject),
        ...entry.senders.flatMap((sender) => [sender.name, sender.address]),
        ...(searchFiled.get(entry.thread.id) ?? []).filter((project) => inboxReaches(ctx, project.id)).map((project) => project.name),
        searchInboxNames.get(entry.thread.inbox_id),
      ]))
    : inTask;
  const counts = tabCounts(searched.map((entry) => ({ flags: entry.flags, project_id: entry.thread.project_id })));
  const inTab = searched.filter((entry) => threadInTab(entry.flags, entry.thread.project_id, filters.tab));
  const page = inTab.slice(filters.offset, filters.offset + filters.limit);

  const [inboxes, names, filed, latestCode, { bodies, attachments, links, liveTaskIds, openReminders, suggestions }, dismissers] = await Promise.all([
    inboxesRead,
    projectNames(ctx, page.map((entry) => entry.thread.project_id)),
    searchFiled ?? threadProjects(ctx, page.map((entry) => entry.thread.id)),
    // A search or a task looks for something else; the pinned code is for the plain list.
    filters.search.trim() || filters.taskId ? null : freshCode(ctx, inTask),
    pageDetails(ctx, page),
    memberNames(ctx.service, page.map((entry) => entry.meeting?.dismissed_by)),
  ]);
  const inboxNames = new Map(inboxes.map((inbox) => [inbox.id, inboxDisplayName(inbox, ctx.memberId)]));
  const bodyById = new Map(bodies.map((row) => [row.id, row]));
  const threads: InboxThreadSummary[] = page.map((entry) => {
    const latest = entry.messages[entry.messages.length - 1];
    const body = bodyById.get(latest.id);
    const ids = new Set(entry.messages.map((message) => message.id));
    const meeting = entry.meeting ? meetingSummary(entry.meeting, dismissers) : null;
    return {
      id: entry.thread.id,
      inbox_id: entry.thread.inbox_id,
      inbox_name: inboxNames.get(entry.thread.inbox_id) ?? '',
      channel: entry.thread.channel ?? 'email',
      meeting,
      // A meeting is known by its title; its packages' subjects repeat it.
      subject: meeting?.title || latest.subject || entry.thread.subject_normalized || '',
      project: entry.thread.project_id && entry.thread.project_source
        ? { id: entry.thread.project_id, name: projectLabel(ctx, names, entry.thread.project_id), source: entry.thread.project_source }
        : null,
      projects: (filed.get(entry.thread.id) ?? []).map(({ address: _address, ...project }) => project),
      last_message_at: entry.thread.last_message_at,
      message_count: entry.messages.length,
      sender: entry.sender,
      // A meeting's text describes its packages; what it holds says more.
      snippet: entry.thread.channel === 'meeting'
        ? meetingPackagesLine(entry.messages.map((message) => message.subject))
        : snippetOf(body?.new_text || body?.text_body),
      state: entry.flags.state,
      needs_you: entry.flags.needs_you,
      needs_reply: entry.flags.needs_reply,
      has_new: entry.flags.has_new,
      urgent: entry.flags.urgent,
      untrusted: entry.flags.untrusted,
      draft_ready: entry.flags.draft_ready,
      // A file a reply sent again (the same bytes) counts once.
      attachment_count: new Set(attachments.filter((row) => ids.has(row.message_id)).map((row) => row.sha256 ?? row.id)).size,
      summary: entry.thread.summary ?? null,
      ...(() => {
        const taskIds = new Set(links.filter((link) => ids.has(link.message_id) && liveTaskIds.has(link.task_id)).map((link) => link.task_id));
        return { task_count: taskIds.size, reminder_count: openReminders.filter((reminder) => ids.has(reminder.source_message_id)).length };
      })(),
      suggestion_count: suggestions.get(entry.thread.id) ?? 0,
    };
  });
  // Members always know when Owners can read personal inboxes: one line on the Inbox while it is on.
  const ownersReadPersonal = inboxes.some((inbox) => inbox.owner) ? await ownersReadPersonalInboxes(ctx.service) : false;
  return { inboxes, threads, total: inTab.length, counts, latest_code: latestCode, owners_read_personal: ownersReadPersonal };
}

/** The newest one-time code that arrived in the last CODE_PIN_MINUTES, with the code read from it. */
async function freshCode(ctx: InboxContext, entries: ThreadEntry[]): Promise<InboxLatestCode | null> {
  const since = new Date(Date.now() - CODE_PIN_MINUTES * 60_000).toISOString();
  const newest = entries
    .filter((entry) => entry.flags.code)
    .map((entry) => ({ entry, message: entry.messages[entry.messages.length - 1] }))
    .filter(({ message }) => message.received_at >= since)
    .sort((a, b) => (a.message.received_at < b.message.received_at ? 1 : -1))[0];
  if (!newest) return null;
  const body = await one<{ new_text: string | null; text_body: string | null }>(comms(ctx.service).from('messages')
    .select('new_text, text_body').eq('id', newest.message.id).maybeSingle());
  return {
    thread_id: newest.entry.thread.id,
    sender: newest.entry.sender,
    code: codeIn(newest.message.subject ?? '', body?.new_text || body?.text_body),
    received_at: newest.message.received_at,
  };
}

/**
 * Senders of these filtered pitches who pitched before (another email the
 * agent read as outreach) and have no rule filtering them yet: a person is
 * offered to always filter them.
 */
async function repeatPitchSenders(service: SupabaseClient, pitches: { id: string; address: string }[]): Promise<Set<string>> {
  const addresses = [...new Set(pitches.map((pitch) => pitch.address).filter(Boolean))];
  if (addresses.length === 0) return new Set();
  const own = new Set(pitches.map((pitch) => pitch.id));
  const [fromRows, rules] = await Promise.all([
    many<{ message_id: string; address: string }>(comms(service).from('participants').select('message_id, address').eq('kind', 'from').in('address', addresses)),
    many<{ match_value: string }>(comms(service).from('sender_rules').select('match_value')
      .eq('match_kind', 'address').in('match_value', addresses).eq('action', 'ignore').is('topic', null).is('disabled_at', null)),
  ]);
  const others = fromRows.filter((row) => !own.has(row.message_id));
  if (others.length === 0) return new Set();
  const pitched = await many<{ message_id: string }>(comms(service).from('triage').select('message_id')
    .in('message_id', [...new Set(others.map((row) => row.message_id))]).eq('category', 'outreach'));
  const pitchedIds = new Set(pitched.map((row) => row.message_id));
  const filtered = new Set(rules.map((rule) => rule.match_value));
  return new Set(others.filter((row) => pitchedIds.has(row.message_id) && !filtered.has(row.address)).map((row) => row.address));
}

/** Threads waiting on a person, by how badly, across every inbox the member reads (the sidebar badge). */
export async function attentionCount(ctx: InboxContext): Promise<InboxAttention> {
  if (!canReadInbox(ctx)) return attentionCounts([]);
  const entries = await loadThreadEntries(ctx.service, await readableInboxIds(ctx), null);
  return attentionCounts(entries.map((entry) => entry.flags));
}

export async function loadReadableThread(ctx: InboxContext, threadId: string): Promise<ThreadRow> {
  if (!canReadInbox(ctx)) throw new InboxError(403, 'Forbidden');
  const id = assertId(threadId, 'thread id');
  const thread = await one<ThreadRow & Row>(comms(ctx.service).from('conversations')
    .select('id, inbox_id, channel, subject_normalized, project_id, project_source, project_address_id, summary, last_message_at').eq('id', id).maybeSingle());
  // An inbox the member cannot read looks like no thread at all.
  if (!thread || !(await readableInboxIds(ctx)).includes(thread.inbox_id)) throw new InboxError(404, 'Thread not found');
  return thread;
}

/**
 * A thread to act on (file it, mark it handled, send it back, settle the
 * agent's work): readable, and in an inbox the member triages
 * (inbox-visibility.ts: a shared inbox with triage or manage, their own
 * personal inbox, or one shared with them while they hold triage). Unreadable
 * is 404, as for reading; readable but not theirs to act on is 403.
 */
export async function loadTriageableThread(ctx: InboxContext, threadId: string): Promise<ThreadRow> {
  if (!canTriageInbox(ctx)) throw new InboxError(403, TRIAGE_DENIED);
  const thread = await loadReadableThread(ctx, threadId);
  if (!(await memberTriagesInbox(ctx.service, ctx.memberId, ctx.access, inboxChannel(ctx), thread.inbox_id))) throw new InboxError(403, TRIAGE_DENIED);
  return thread;
}

/** Addresses that belong to us: teammates, inboxes and project addresses. They are never remembered as client senders. */
/** Ours: the team's, the inboxes', your addresses, and any address on one of your domains. */
export async function ownAddresses(service: SupabaseClient): Promise<Pick<Set<string>, 'has'>> {
  const [members, inboxes, projectAddresses, domains] = await Promise.all([
    many<{ email: string | null }>(service.from('team_members').select('email')),
    many<{ address: string; routing_address: string }>(comms(service).from('inboxes').select('address, routing_address')),
    many<{ routing_address: string | null; public_address: string | null }>(comms(service).from('endpoints').select('routing_address, public_address')),
    many<{ domain: string }>(comms(service).from('own_domains').select('domain')),
  ]);
  const ownDomains = new Set(domains.map((row) => row.domain));
  const own = new Set<string>();
  for (const member of members) if (member.email) own.add(member.email.trim().toLowerCase());
  for (const inbox of inboxes) { own.add(inbox.address); own.add(inbox.routing_address); }
  // Your addresses: one with no project has no relay address of its own.
  for (const row of projectAddresses) { if (row.routing_address) own.add(row.routing_address); if (row.public_address) own.add(row.public_address); }
  return { has: (address: string) => own.has(address) || ownDomains.has(address.slice(address.lastIndexOf('@') + 1)) };
}

async function rememberableSenders(service: SupabaseClient, people: { address: string; name: string }[]): Promise<RememberableSender[]> {
  const own = await ownAddresses(service);
  const seen = new Map<string, string>();
  // Newest first, so the latest client sender leads.
  for (const person of [...people].reverse()) {
    if (own.has(person.address) || seen.has(person.address)) continue;
    seen.set(person.address, person.name);
  }
  const addresses = [...seen.keys()];
  if (addresses.length === 0) return [];
  const domains = [...new Set(addresses.flatMap((address) => [domainOf(address), organizationalDomain(domainOf(address))]))];
  const [contactRows, domainRows, senderRows] = await Promise.all([
    many<{ contact_id: string; email: string }>(service.from('contact_emails').select('contact_id, email').in('email', addresses)),
    many<{ domain: string; project_id: string }>(comms(service).from('client_domains').select('domain, project_id').in('domain', domains)),
    many<{ address: string; project_id: string }>(comms(service).from('client_addresses').select('address, project_id').in('address', addresses)),
  ]);
  const contactIds = [...new Set(contactRows.map((row) => row.contact_id))];
  const links = contactIds.length
    ? await many<{ contact_id: string; project_id: string }>(service.from('project_contacts').select('contact_id, project_id').in('contact_id', contactIds))
    : [];
  return addresses.map((address) => {
    const host = domainOf(address);
    const org = organizationalDomain(host);
    const mine = contactRows.filter((row) => row.email === address).map((row) => row.contact_id);
    return {
      address,
      name: seen.get(address) ?? '',
      domain: org,
      domain_is_public: isPublicEmailDomain(host) || isPublicEmailDomain(org),
      contact_ids: mine,
      mapped_project_ids: [...new Set([
        ...links.filter((link) => mine.includes(link.contact_id)).map((link) => link.project_id),
        ...senderRows.filter((row) => row.address === address).map((row) => row.project_id),
      ])],
      domain_project_ids: [...new Set(domainRows.filter((row) => row.domain === host || row.domain === org).map((row) => row.project_id))],
    };
  });
}

export async function threadDetail(ctx: InboxContext, threadId: string): Promise<InboxThreadDetail> {
  const thread = await loadReadableThread(ctx, threadId);
  const service = ctx.service;
  const messages = await many<Row>(comms(service).from('messages')
    .select(`id, channel, status, subject, received_at, sent_at, text_body, html_body, new_text, is_forward, auth, auto_mail_reason, kind, topic, sort_action, sort_reason, sender_rule_id, superseded_by, reviewed_at, reviewed_by, forwarded_by_member_id, ${ROUTING_COLUMNS}`)
    .eq('thread_id', thread.id).neq('status', 'receiving').order('received_at', { ascending: true }).order('id'));
  const ids = messages.map((message) => message.id as string);
  const [inbox] = await inboxSummaries(service, [thread.inbox_id]);
  const [recipients, attachments, triageRows, links, candidates, reminderRows, answerRows, meetingRow] = await Promise.all([
    readIn<Row & { message_id: string; kind: string; address: string; name: string; contact_id: string | null; position: number }>(ids, (chunk, from, to, count) =>
      ctxSelect(comms(service), 'participants', 'id, message_id, kind, address, name, contact_id, position', count).in('message_id', chunk).order('id').range(from, to)),
    readIn<Row>(ids, (chunk, from, to, count) =>
      ctxSelect(comms(service), 'attachments', 'id, message_id, position, filename, content_type, size_bytes, sha256, skipped_reason, uploaded_at, agent_label, content_id', count)
        .in('message_id', chunk).order('id').range(from, to)),
    readIn<Row & { id: string; message_id: string; created_at: string }>(ids, (chunk, from, to, count) =>
      ctxSelect(comms(service), 'triage', 'id, message_id, member_id, outcome, urgent, summary, question_for_human, questions, suggested_reply, category, created_at', count)
        .in('message_id', chunk).order('id').range(from, to)),
    readIn<Row & { message_id: string; task_id: string }>(ids, (chunk, from, to, count) =>
      ctxSelect(comms(service), 'task_links', 'id, message_id, task_id, relation, triage_id, created_at', count).in('message_id', chunk).order('id').range(from, to)),
    readIn<Row & { message_id: string; project_id: string; reason: CandidateReason }>(ids, (chunk, from, to, count) =>
      ctxSelect(comms(service), 'message_candidates', 'message_id, project_id, reason', count).in('message_id', chunk).order('message_id').order('project_id').order('reason').range(from, to)),
    emailReminders(ctx, ids, false),
    readIn<{ id: string; message_id: string; triage_id: string; answer: string; answered_by: string | null; created_at: string }>(ids, (chunk, from, to, count) =>
      ctxSelect(comms(service), 'answers', 'id, message_id, triage_id, answer, answered_by, created_at', count).in('message_id', chunk).order('id').range(from, to)),
    thread.channel === 'meeting'
      ? one<MeetingRow & Row>(comms(service).from('meetings').select(MEETING_COLUMNS).eq('conversation_id', thread.id).maybeSingle())
      : Promise.resolve(null),
  ]);
  const latest = latestTriage(triageRows);
  const everWork = new Set(triageRows.filter((row) => row.category === 'work').map((row) => row.message_id));
  // Who sent each email, as sorting saw it: a teammate's forward by its original sender.
  const senderAddress = (row: Row): string => ((row.routing_basis === 'forwarded_original' && row.original_from_address)
    || recipients.find((r) => r.message_id === row.id && r.kind === 'from')?.address || '') as string;
  const repeatPitchers = await repeatPitchSenders(service, messages
    .filter((row) => row.status === 'ignored' && latest.get(row.id as string)?.category === 'outreach')
    .map((row) => ({ id: row.id as string, address: senderAddress(row) })));
  const plans = await threadPlans(ctx, thread.id, ids);
  const taskIds = [...new Set([...links.map((link) => link.task_id), ...plans.taskIds])];
  const tasks = taskIds.length
    ? await readIn<{ id: string; title: string; status: string; project_id: string }>(taskIds, (chunk, from, to, count) =>
        ctxSelect(service, 'tasks', 'id, title, status, project_id', count).in('id', chunk).is('deleted_at', null).order('id').range(from, to))
    : [];
  const [names, people, viaAddress, filed] = await Promise.all([
    projectNames(ctx, [thread.project_id, ...candidates.map((row) => row.project_id), ...tasks.map((task) => task.project_id), ...plans.projectIds]),
    memberNames(service, [
      ...[...latest.values()].map((row) => row.member_id as string | null),
      ...messages.map((row) => row.reviewed_by as string | null),
      ...messages.map((row) => row.forwarded_by_member_id as string | null),
      ...answerRows.map((row) => row.answered_by),
      meetingRow?.dismissed_by,
    ]),
    thread.project_address_id
      ? one<{ routing_address: string; public_address: string | null }>(comms(service).from('endpoints')
          .select('routing_address, public_address').eq('id', thread.project_address_id).maybeSingle())
      : Promise.resolve(null),
    threadProjects(ctx, [thread.id]),
  ]);

  const peopleOf = (messageId: string, kind: string): InboxPerson[] => recipients
    .filter((row) => row.message_id === messageId && row.kind === kind)
    .sort((a, b) => a.position - b.position)
    .map((row) => ({ address: row.address, name: row.name, contact_id: row.contact_id }));

  const states: MessageState[] = [];
  const presented: InboxMessage[] = messages.map((row) => {
    const id = row.id as string;
    const triageRow = latest.get(id);
    const auth = (row.auth ?? {}) as Row;
    const status = row.status as MessageStatus;
    states.push({
      status,
      reviewed_at: (row.reviewed_at as string | null) ?? null,
      outcome: (triageRow?.outcome as TriageOutcome | undefined) ?? null,
      urgent: Boolean(triageRow?.urgent),
      trust: trustOf(auth),
      kind: (row.kind as MailKind | null) ?? null,
      topic: (row.topic as MailTopic | null) ?? null,
      category: (triageRow?.category as TriageCategory | null | undefined) ?? null,
      ever_work: everWork.has(id),
    });
    const memberId = (triageRow?.member_id as string | null) ?? null;
    const reviewedBy = (row.reviewed_by as string | null) ?? null;
    const forwardedBy = (row.forwarded_by_member_id as string | null) ?? null;
    const basis = ((row.routing_basis as RoutingBasis | null) ?? 'sender');
    const channel = (row.channel as InboxChannel | null) ?? 'email';
    return {
      id,
      channel,
      meeting_package: channel === 'meeting' ? meetingPackageOf(row.subject as string) : null,
      status,
      subject: (row.subject as string) ?? '',
      received_at: row.received_at as string,
      sent_at: (row.sent_at as string | null) ?? null,
      from: peopleOf(id, 'from')[0] ?? null,
      to: peopleOf(id, 'to'),
      cc: peopleOf(id, 'cc'),
      is_forward: Boolean(row.is_forward),
      routing_basis: basis,
      forwarded_by: forwardedBy && basis !== 'sender' ? { member_id: forwardedBy, name: people.get(forwardedBy) ?? 'A teammate' } : null,
      original_sender: basis === 'forwarded_original' ? shownSender(row, null) : null,
      trust: {
        level: trustOf(auth),
        reason: (auth.reason as string | null) ?? null,
        spf: (auth.spf as string | null) ?? null,
        dkim: (auth.dkim as string | null) ?? null,
        dmarc: (auth.dmarc as string | null) ?? null,
      },
      auto_mail_reason: (row.auto_mail_reason as string | null) ?? null,
      sorting: row.kind ? {
        kind: row.kind as InboxSorting['kind'],
        topic: (row.topic as InboxSorting['topic']) ?? null,
        action: (row.sort_action as InboxSorting['action']) ?? null,
        reason: (row.sort_reason as string | null) ?? null,
        rule_id: (row.sender_rule_id as string | null) ?? null,
        superseded_by: (row.superseded_by as string | null) ?? null,
      } : null,
      new_text: (row.new_text as string | null) ?? null,
      text_body: (row.text_body as string | null) ?? null,
      html_body: (row.html_body as string | null) ?? null,
      attachments: attachments
        .filter((attachment) => attachment.message_id === id)
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((attachment): InboxAttachment => ({
          id: attachment.id as string,
          filename: (attachment.filename as string) || 'attachment',
          content_type: attachment.content_type as string,
          size_bytes: attachment.size_bytes == null ? null : Number(attachment.size_bytes),
          kind: attachmentKind(attachment.content_type as string, attachment.filename as string),
          available: !attachment.skipped_reason && !!attachment.uploaded_at,
          skipped_reason: (attachment.skipped_reason as string | null) ?? null,
          agent_label: (attachment.agent_label as string | null) ?? null,
          content_id: attachment.content_id ? normalizeContentId(attachment.content_id as string) : null,
          sha256: (attachment.sha256 as string | null) ?? null,
        })),
      triage: triageRow ? {
        id: triageRow.id,
        outcome: triageRow.outcome as TriageOutcome,
        urgent: Boolean(triageRow.urgent),
        summary: triageRow.summary as string,
        question_for_human: (triageRow.question_for_human as string | null) ?? null,
        questions: (triageRow.questions as InboxQuestion[] | null) ?? null,
        suggested_reply: (triageRow.suggested_reply as string | null) ?? null,
        category: (triageRow.category as TriageCategory | null) ?? null,
        member: memberId ? { id: memberId, name: people.get(memberId) ?? 'Agent' } : null,
        created_at: triageRow.created_at,
      } : null,
      // The newest answer to the question this triage asked.
      answer: (() => {
        const answer = answerRows
          .filter((row) => row.message_id === id && row.triage_id === triageRow?.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        return answer ? {
          text: answer.answer,
          by: answer.answered_by ? { id: answer.answered_by, name: people.get(answer.answered_by) ?? 'Someone' } : null,
          at: answer.created_at,
        } : null;
      })(),
      // A trashed task drops off the thread until it is restored.
      linked_tasks: links
        .filter((link) => link.message_id === id && tasks.some((t) => t.id === link.task_id))
        .map((link): InboxLinkedTask => {
          const task = tasks.find((t) => t.id === link.task_id);
          // A task in a project the member cannot reach keeps its ids, never its title or status.
          const visible = !!task && inboxReaches(ctx, task.project_id);
          return {
            task_id: link.task_id,
            relation: link.relation as TaskLinkRelation,
            by: link.triage_id ? 'agent' as const : 'person' as const,
            title: visible ? task.title : null,
            status: visible ? task.status : null,
            project_id: task?.project_id ?? null,
            project_name: task ? projectLabel(ctx, names, task.project_id) : null,
          };
        }),
      reminders: reminderRows
        .filter((reminder) => reminder.source_message_id === id)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .map((reminder): InboxReminder => ({
          id: reminder.id,
          title: reminder.title as string,
          remind_on: reminder.remind_on ? String(reminder.remind_on).slice(0, 10) : null,
          status: reminder.status as 'open' | 'done',
          task_id: (reminder.task_id as string | null) ?? null,
          mine: reminder.owner_id === ctx.memberId,
          created_by: reminder.created_by ?? null,
        })),
      plan: plans.forMessage(id, (projectId) => projectLabel(ctx, names, projectId), (taskId) => {
        const task = tasks.find((t) => t.id === taskId);
        return task && inboxReaches(ctx, task.project_id) ? task.title : null;
      }, {
        task: (taskId) => tasks.some((t) => t.id === taskId && t.status === 'done'),
        reminder: (reminderId) => reminderRows.some((r) => r.id === reminderId && r.status === 'done'),
      }),
      reply_points: plans.points.filter((point) => point.message_id === id).map((point): InboxReplyPoint => ({
        id: point.id, who: point.who, what: point.what, kind: point.kind, by_when: point.by_when, urgent: point.urgent,
        to_agent: point.to_agent, note: point.note, state: point.state,
      })),
      reviewed_at: (row.reviewed_at as string | null) ?? null,
      reviewed_by: reviewedBy ? { id: reviewedBy, name: people.get(reviewedBy) ?? 'Someone' } : null,
      repeat_pitch: repeatPitchers.has(senderAddress(row)),
    };
  });

  const candidateList: InboxCandidate[] = [...new Set(candidates.map((row) => row.project_id))].map((projectId) => ({
    project_id: projectId,
    name: names.get(projectId) ?? null,
    reasons: [...new Set(candidates.filter((row) => row.project_id === projectId).map((row) => row.reason))],
  }));
  const flags = threadFlags(states);
  const latestMessage = presented[presented.length - 1];
  // Everyone invited, once each, organizer first, named where any package names them.
  let meeting: InboxMeeting | null = null;
  if (meetingRow) {
    const seen = new Map<string, string>();
    for (const row of recipients.filter((r) => r.kind === 'attendee').sort((a, b) => a.position - b.position)) {
      if (!seen.get(row.address)) seen.set(row.address, row.name ?? '');
    }
    const organizer = meetingRow.organizer_address;
    const attendees = [...seen.entries()].map(([address, name]) => ({ address, name }))
      .sort((a, b) => Number(b.address === organizer) - Number(a.address === organizer));
    meeting = { ...meetingSummary(meetingRow, people, organizer ? seen.get(organizer) ?? '' : ''), attendees };
  }
  // The thread's actions show only where the viewer may act on this inbox (inbox-visibility.ts).
  const canTriage = canTriageInbox(ctx) && await memberTriagesInbox(service, ctx.memberId, ctx.access, inboxChannel(ctx), thread.inbox_id);
  return {
    can_triage: canTriage,
    id: thread.id,
    inbox: inbox ?? { id: thread.inbox_id, name: 'Inbox', address: '', enabled: true, handler: null, owner: null },
    channel: thread.channel ?? 'email',
    meeting,
    subject: meeting?.title || latestMessage?.subject || thread.subject_normalized || '',
    project: thread.project_id && thread.project_source
      ? {
          id: thread.project_id,
          name: projectLabel(ctx, names, thread.project_id),
          source: thread.project_source,
          address: viaAddress && inboxReaches(ctx, thread.project_id) ? viaAddress.public_address ?? viaAddress.routing_address : null,
        }
      : null,
    projects: filed.get(thread.id) ?? [],
    state: flags.state,
    urgent: flags.urgent,
    untrusted: flags.untrusted,
    candidates: candidateList,
    messages: presented,
    // A teammate's forward offers the original sender, never the teammate.
    summary: thread.summary ?? null,
    senders: await rememberableSenders(service, presented
      .map((message) => message.original_sender ?? message.from)
      .filter((from): from is { name: string; address: string } => !!from)),
  };
}

/**
 * A short-lived link to one stored attachment: a one-minute download, or
 * with `inline` a five-minute link that opens in the browser (images in an
 * email's HTML, the attachment preview).
 */
export async function attachmentDownloadUrl(ctx: InboxContext, attachmentId: string, options: { inline?: boolean } = {}): Promise<{ url: string; filename: string; expires_in: number }> {
  // Inline only for what the Inbox shows (images, PDFs, text): never a sender's HTML or SVG.
  if (!canReadInbox(ctx)) throw new InboxError(403, 'Forbidden');
  const id = assertId(attachmentId, 'attachment id');
  const attachment = await one<{ id: string; message_id: string; filename: string; content_type: string; storage_path: string | null; uploaded_at: string | null; skipped_reason: string | null }>(
    comms(ctx.service).from('attachments').select('id, message_id, filename, content_type, storage_path, uploaded_at, skipped_reason').eq('id', id).maybeSingle());
  const message = attachment
    ? await one<{ inbox_id: string; status: string }>(comms(ctx.service).from('messages').select('inbox_id, status').eq('id', attachment.message_id).maybeSingle())
    : null;
  if (!attachment || !message || message.status === 'receiving' || !(await readableInboxIds(ctx)).includes(message.inbox_id)) {
    throw new InboxError(404, 'Attachment not found');
  }
  if (options.inline && attachmentKind(attachment.content_type, attachment.filename) === 'other') {
    throw new InboxError(415, 'This file cannot be opened in the browser. Download it instead.');
  }
  if (attachment.skipped_reason || !attachment.storage_path || !attachment.uploaded_at) {
    throw new InboxError(409, 'This file was not stored (it was over the size limit), so there is nothing to download.');
  }
  const expiresIn = options.inline ? 300 : 60;
  const { data, error } = await pmStorage(ctx.service).from(BUCKETS.inboundEmail)
    .createSignedUrl(attachment.storage_path, expiresIn, options.inline ? undefined : { download: attachment.filename || true });
  if (error || !data?.signedUrl) throw new InboxError(502, 'Could not create a download link');
  return { url: data.signedUrl, filename: attachment.filename, expires_in: expiresIn };
}

/**
 * Add a project to the thread beside the others (adding a guessed one
 * confirms it), as the person's (source "person"), and optionally remember
 * the sender (the person becomes a contact on each chosen project) or the
 * sender's domain (a client domain on each chosen project). Taking a project
 * off is removeThreadProject, with its checks. Rule 7: only people create
 * mappings, and only for a sender of this thread. Everything is checked
 * before anything is written.
 */
export async function setThreadProject(
  ctx: InboxContext,
  threadId: string,
  request: SetThreadProjectRequest,
): Promise<SetThreadProjectResult> {
  const thread = await loadTriageableThread(ctx, threadId);
  const projectId = assertId(request.project_id, 'project_id');
  const rememberSender = request.remember_sender ?? null;
  const rememberDomain = request.remember_domain ?? null;
  const allProjectIds = [...new Set([projectId, ...(rememberSender?.project_ids ?? []), ...(rememberDomain?.project_ids ?? [])])].map((id) => assertId(id, 'project_id'));
  for (const id of allProjectIds) {
    if (!inboxReaches(ctx, id)) throw new InboxError(403, 'You cannot assign email to that project');
  }
  const projects = await many<{ id: string; name: string }>(ctx.service.from('projects').select('id, name').in('id', allProjectIds).is('deleted_at', null));
  if (projects.length !== allProjectIds.length) throw new InboxError(404, 'Project not found');

  let sender: RememberableSender | null = null;
  let domain: string | null = null;
  if (rememberSender || rememberDomain) {
    if (!isPerson(ctx.access)) throw new InboxError(403, 'Only a person can remember a sender or domain');
    const threadMessages = await many<{ id: string } & Row>(comms(ctx.service).from('messages')
      .select(`id, ${ROUTING_COLUMNS}`).eq('thread_id', thread.id).neq('status', 'receiving').order('received_at'));
    const messageIds = threadMessages.map((m) => m.id);
    const fromRows = messageIds.length
      ? await many<{ message_id: string; address: string; name: string }>(comms(ctx.service).from('participants')
          .select('message_id, address, name').eq('kind', 'from').in('message_id', messageIds))
      : [];
    // Oldest first, as rememberableSenders expects; a teammate's forward offers its original sender.
    const shown = threadMessages
      .map((message) => shownSender(message, fromRows.find((row) => row.message_id === message.id)))
      .filter((person): person is { name: string; address: string } => !!person);
    const senders = await rememberableSenders(ctx.service, shown);
    if (rememberSender) {
      if (!inboxAllows(ctx, 'contacts.manage')) throw new InboxError(403, 'Remembering a sender needs permission to manage contacts');
      const address = normalizeAddress(rememberSender.address);
      sender = senders.find((candidate) => candidate.address === address) ?? null;
      if (!sender) throw new InboxError(422, 'That address did not send email in this thread');
    }
    if (rememberDomain) {
      if (!inboxAllows(ctx, 'contacts.manage') && !inboxAllows(ctx, 'inbound_email.manage')) {
        throw new InboxError(403, 'Remembering a domain needs permission to manage contacts');
      }
      const valid = validateClientDomain(rememberDomain.domain);
      if (!valid.ok) throw new InboxError(422, valid.error);
      if (!senders.some((candidate) => candidate.domain === valid.domain || domainOf(candidate.address) === valid.domain)) {
        throw new InboxError(422, 'That domain did not send email in this thread');
      }
      domain = valid.domain;
    }
  }

  let rememberedSender: SetThreadProjectResult['remembered_sender'] = null;
  if (sender && rememberSender) {
    // A project that already has the address as a client email address
    // already maps it: nothing to link there, and no contact is needed for it.
    const asClientAddress = new Set((await many<{ project_id: string }>(comms(ctx.service).from('client_addresses')
      .select('project_id').eq('address', sender.address))).map((row) => row.project_id));
    const wanted = [...new Set(rememberSender.project_ids)].filter((id) => !asClientAddress.has(id));
    let contactId = sender.contact_ids[0] ?? null;
    let created = false;
    if (!contactId && wanted.length > 0) {
      const contact = await one<{ id: string }>(ctx.service.from('contacts').insert({
        name: sender.name.trim() || sender.address.split('@')[0],
        email: sender.address,
        color: DEFAULT_ITEM_COLOR,
        created_by: ctx.memberId,
      }).select('id').single());
      if (!contact) throw new InboxError(500, 'Could not create the contact');
      contactId = contact.id;
      created = true;
    }
    const linked: string[] = [];
    const existing = sender.contact_ids.length
      ? await many<{ contact_id: string; project_id: string }>(ctx.service.from('project_contacts').select('contact_id, project_id').in('contact_id', sender.contact_ids))
      : [];
    for (const id of contactId ? wanted : []) {
      // Any contact with this address already on the project maps it.
      if (existing.some((link) => link.project_id === id)) continue;
      const { error } = await ctx.service.from('project_contacts').insert({ project_id: id, contact_id: contactId as string, role: 'Client', is_primary_client: false });
      if (error) throw error;
      linked.push(id);
    }
    rememberedSender = { contact_id: contactId, created_contact: created, linked_project_ids: linked };
  }

  let rememberedDomain: SetThreadProjectResult['remembered_domain'] = null;
  if (domain && rememberDomain) {
    const existing = await many<{ project_id: string }>(comms(ctx.service).from('client_domains').select('project_id').eq('domain', domain));
    const added: string[] = [];
    for (const id of [...new Set(rememberDomain.project_ids)]) {
      if (existing.some((row) => row.project_id === id)) continue;
      const { error } = await comms(ctx.service).from('client_domains').insert({ domain, project_id: id, created_by: ctx.memberId });
      if (error) throw error;
      added.push(id);
    }
    rememberedDomain = { domain, added_project_ids: added };
  }

  const { error } = await comms(ctx.service).rpc('add_conversation_project', { p_conversation_id: thread.id, p_project_id: projectId, p_member_id: ctx.memberId });
  if (error) throw error;
  const project: ThreadProject = { id: projectId, name: projects.find((p) => p.id === projectId)?.name ?? 'Project', source: 'person' };
  return { project, remembered_sender: rememberedSender, remembered_domain: rememberedDomain };
}

/**
 * A person takes a project off the thread. Refused (409) while one of its
 * emails is linked to a task on that project: unlink or move the task first.
 */
export async function removeThreadProject(ctx: InboxContext, threadId: string, projectId: string): Promise<{ removed: boolean }> {
  const thread = await loadTriageableThread(ctx, threadId);
  const id = assertId(projectId, 'project_id');
  if (!inboxReaches(ctx, id)) throw new InboxError(403, 'You cannot change email on that project');
  const { data, error } = await comms(ctx.service).rpc('remove_conversation_project', { p_conversation_id: thread.id, p_project_id: id });
  if (error) {
    if ((error.message ?? '').includes('EMAIL_PROJECT_HAS_TASKS')) {
      throw new InboxError(409, 'A task on that project is linked to this thread. Unlink the task, or move it, first.');
    }
    throw error;
  }
  return { removed: data === true };
}

/**
 * A person dealt with the thread: what waited on the agent or on a person
 * becomes handled, and every message counts as reviewed (which clears Needs
 * reply). Auto-mail stays ignored. The replies it owed are done too: the
 * person's own open "Reply to ..." reminders its emails set close (as theirs,
 * in the team log); every other reminder stays, and so does anyone else's.
 * `closeReplyReminders: false` changes the messages only (a meeting's
 * "Nothing to do", whose Undo puts back exactly what it changed).
 */
export async function markThreadHandled(
  ctx: InboxContext,
  threadId: string,
  { closeReplyReminders = true }: { closeReplyReminders?: boolean } = {},
): Promise<{ handled: number; reviewed: number; closed_reminders: string[] }> {
  const thread = await loadTriageableThread(ctx, threadId);
  const now = new Date().toISOString();
  const handled = await many<{ id: string }>(comms(ctx.service).from('messages')
    .update({ status: 'handled' }).eq('thread_id', thread.id).in('status', ['new', 'needs_human']).select('id'));
  const reviewed = await many<{ id: string }>(comms(ctx.service).from('messages')
    .update({ reviewed_at: now, reviewed_by: ctx.memberId })
    .eq('thread_id', thread.id).eq('status', 'handled').is('reviewed_at', null).select('id'));
  if (!closeReplyReminders) return { handled: handled.length, reviewed: reviewed.length, closed_reminders: [] };
  // The same open reminders the thread shows (none on a task or project in Trash), read in batches.
  const messageIds = (await many<{ id: string }>(comms(ctx.service).from('messages').select('id').eq('thread_id', thread.id))).map((row) => row.id);
  const replies = (await emailReminders(ctx, messageIds, true))
    .filter((row) => row.owner_id === ctx.memberId && /^reply to /i.test(String(row.title)));
  let closed: { id: string; title: string }[] = [];
  if (replies.length) {
    closed = await many<{ id: string; title: string }>(inboxActor(ctx).from('reminders')
      .update({ status: 'done', completed_at: now, completed_by: ctx.memberId })
      .in('id', replies.map((row) => row.id)).eq('status', 'open').is('deleted_at', null).select('id, title'));
  }
  return { handled: handled.length, reviewed: reviewed.length, closed_reminders: closed.map((row) => row.title) };
}

/**
 * Back to the agent: the message (the newest one by default) is New again and
 * she plans it again, from the thread as it is now (its projects, its tasks).
 * Her earlier plans for it are superseded: what still waited on a person
 * (suggestions, and the conversation's open question, so a fresh plan may
 * ask its own) settles as expired with result.superseded, so nothing shows
 * as pending and the bell clears. What already applied stays; the new plan
 * reads it in its context, marked superseded. Going back to New stamps
 * requeued_at (a trigger), which the signal's plans_newest_queued_at wakes on.
 */
export async function sendBackToAgent(ctx: InboxContext, threadId: string, messageId: string | null): Promise<{ message_id: string; superseded: number }> {
  const thread = await loadTriageableThread(ctx, threadId);
  const messages = await many<{ id: string; status: string }>(comms(ctx.service).from('messages')
    .select('id, status').eq('thread_id', thread.id).neq('status', 'receiving').order('received_at', { ascending: false }).order('id', { ascending: false }));
  const target = messageId ? messages.find((message) => message.id === assertId(messageId, 'message_id')) : messages[0];
  if (!target) throw new InboxError(404, 'Message not found');
  if (target.status === 'new') throw new InboxError(409, 'It is already waiting for the agent');
  const superseded = await supersedeWaitingItems(ctx, thread.id, target.id);
  const { error } = await comms(ctx.service).from('messages')
    .update({ status: 'new', reviewed_at: null, reviewed_by: null }).eq('id', target.id).neq('status', 'receiving');
  if (error) throw error;
  return { message_id: target.id, superseded: superseded.length };
}

/** Settles what the message's live plans (and the conversation's open question) still waited on. */
async function supersedeWaitingItems(ctx: InboxContext, conversationId: string, messageId: string): Promise<string[]> {
  const plans = await many<{ id: string }>(comms(ctx.service).from('plans').select('id').eq('message_id', messageId).eq('mode', 'live'));
  const now = new Date().toISOString();
  const settle = { state: 'expired', resolved_by: ctx.memberId, resolved_at: now, result: { superseded: { reason: 'sent_back', at: now, by: ctx.memberId } } };
  const [items, asks] = await Promise.all([
    plans.length
      ? many<{ id: string; plan_id: string }>(comms(ctx.service).from('plan_items').update(settle)
        .in('plan_id', plans.map((plan) => plan.id)).eq('state', 'pending').select('id, plan_id'))
      : Promise.resolve([] as { id: string; plan_id: string }[]),
    many<{ id: string; plan_id: string }>(comms(ctx.service).from('plan_items').update(settle)
      .eq('conversation_id', conversationId).eq('mode', 'live').eq('type', 'ask').eq('state', 'pending').select('id, plan_id')),
  ]);
  const settled = [...items, ...asks];
  if (settled.length) {
    // Their messages' bells follow: read once nothing on them waits. Bookkeeping only.
    try {
      const planIds = [...new Set(settled.map((item) => item.plan_id))];
      const owners = await many<{ message_id: string }>(comms(ctx.service).from('plans').select('message_id').in('id', planIds));
      const touched = await many<PlanMessage & Row>(comms(ctx.service).from('messages')
        .select('id, thread_id, inbox_id, subject, channel').in('id', [...new Set(owners.map((row) => row.message_id))]));
      for (const message of touched) await syncWaitingNotification(ctx.service, message, await inboxAgentName(ctx.service, message.inbox_id));
    } catch (bookkeeping) {
      console.error('[inbox] send back: clearing the bell failed:', bookkeeping);
    }
  }
  return [...new Set(settled.map((item) => item.id))];
}

/**
 * A person answers the agent's question on an email (the newest one whose
 * latest triage asks, by default): the answer is kept against that triage
 * and the email goes back to New, so the agent acts on it at once (stamping
 * requeued_at, as a send back does).
 */
export async function answerAgentQuestion(ctx: InboxContext, threadId: string, messageId: string | null, answer: string): Promise<{ message_id: string }> {
  const thread = await loadTriageableThread(ctx, threadId);
  const messages = await many<{ id: string; status: string }>(comms(ctx.service).from('messages')
    .select('id, status').eq('thread_id', thread.id).neq('status', 'receiving').order('received_at', { ascending: false }).order('id', { ascending: false }));
  const ids = messages.map((message) => message.id);
  const triage = ids.length ? latestTriage(await many<Row & { id: string; message_id: string; created_at: string }>(comms(ctx.service).from('triage')
    .select('id, message_id, question_for_human, created_at').in('message_id', ids))) : new Map();
  const asking = (id: string) => !!triage.get(id)?.question_for_human;
  const target = messageId ? messages.find((message) => message.id === assertId(messageId, 'message_id')) : messages.find((message) => asking(message.id));
  if (!target || !asking(target.id)) throw new InboxError(404, 'No question to answer on this email');
  if (target.status === 'new') throw new InboxError(409, 'It is already waiting for the agent');
  const { error: answerError } = await comms(ctx.service).from('answers')
    .insert({ message_id: target.id, triage_id: triage.get(target.id)!.id, answer, answered_by: ctx.memberId });
  if (answerError) throw answerError;
  const { error } = await comms(ctx.service).from('messages')
    .update({ status: 'new', reviewed_at: null, reviewed_by: null }).eq('id', target.id).neq('status', 'receiving');
  if (error) throw error;
  // A plan's open question on the conversation is answered. Bookkeeping only:
  // the answer is stored and with the agent whatever happens here.
  try {
    const { error: askError } = await comms(ctx.service).from('plan_items')
      .update({ state: 'accepted', resolved_by: ctx.memberId, resolved_at: new Date().toISOString(), result: { answer } })
      .eq('conversation_id', thread.id).eq('type', 'ask').eq('state', 'pending').eq('mode', 'live');
    if (askError) throw askError;
    const { data: asked } = await comms(ctx.service).from('messages').select('id, thread_id, inbox_id, subject').eq('id', target.id).single();
    await syncWaitingNotification(ctx.service, asked as PlanMessage, await inboxAgentName(ctx.service, (asked as PlanMessage).inbox_id));
  } catch (bookkeeping) {
    console.error('[inbox] answer: plan bookkeeping failed:', bookkeeping);
  }
  return { message_id: target.id };
}

/** What a plan item does, in a line. */
/** What an item would add, in full, for a person deciding on it: null when it adds no words. */
function planItemBody(item: Row): string | null {
  const payload = (item.payload ?? {}) as Row;
  const text = item.type === 'comment' ? payload.text
    : item.type === 'create_task' ? payload.description
    : item.type === 'add_reminder' ? payload.notes
    : null;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

function planItemLabel(item: Row, project: (id: string) => string | null, task: (id: string) => string | null): string {
  const payload = (item.payload ?? {}) as Row;
  const taskName = item.task_id ? task(item.task_id as string) ?? 'a task' : 'a task';
  const projectName = item.project_id ? project(item.project_id as string) ?? 'a project' : 'a project';
  switch (item.type) {
    case 'create_task': return payload.parent_task_id
      ? `New subtask of ${task(payload.parent_task_id as string) ?? 'a task'}: ${payload.title}`
      : `New task: ${payload.title}`;
    case 'update_task': {
      const changes = Object.keys((payload.changes ?? {}) as Row).map((key) => (key === 'due_date' ? 'due date' : key === 'project_id' ? 'project' : key.replace('_', ' ')));
      return `Change ${changes.join(' and ')} on ${taskName}`;
    }
    case 'comment': return `Comment on ${taskName}`;
    case 'attach_file': return `Files on ${taskName}`;
    case 'add_reminder': return `Reminder: ${payload.title}${payload.remind_on ? ` (${payload.remind_on})` : ''}`;
    case 'update_reminder': return 'Move a reminder';
    case 'complete_reminder': return 'Tick off a reminder';
    case 'link_task': return `Link ${taskName}`;
    case 'file_project': return `File on ${projectName}`;
    case 'reply_owed': return `Reply owed to ${payload.who}: ${payload.what}`;
    case 'revert_item': return 'Undo an earlier item';
    case 'mute_conversation': return 'Mute this conversation';
    case 'add_context': return `Note for ${projectName}: ${payload.content}`;
    case 'propose_mapping': return `Remember ${payload.address ?? payload.domain} for ${projectName}`;
    case 'create_lead': return `New lead: ${payload.name}`;
    case 'log_interaction': return `Lead note: ${payload.title}`;
    case 'ask': return String(payload.question ?? 'A question');
    default: return String(item.type);
  }
}

/** The newest live plan per message on a thread, and its open and settled replies owed. */
async function threadPlans(ctx: InboxContext, threadId: string, messageIds: string[]) {
  const plans = messageIds.length
    ? await many<{ id: string; message_id: string; status: InboxPlan['status']; created_at: string }>(comms(ctx.service).from('plans')
      .select('id, message_id, status, created_at').eq('conversation_id', threadId).eq('mode', 'live').order('created_at', { ascending: false }))
    : [];
  const newest = new Map<string, (typeof plans)[number]>();
  for (const plan of plans) if (!newest.has(plan.message_id)) newest.set(plan.message_id, plan);
  const planIds = [...newest.values()].map((plan) => plan.id);
  const [items, points] = await Promise.all([
    planIds.length
      ? many<Row & { plan_id: string; position: number }>(comms(ctx.service).from('plan_items')
        .select('id, plan_id, position, type, intent, decision, decision_reason, state, payload, evidence, project_id, task_id, error, result').in('plan_id', planIds).order('position'))
      : Promise.resolve([] as (Row & { plan_id: string; position: number })[]),
    many<Row & InboxReplyPoint & { message_id: string | null }>(comms(ctx.service).from('reply_points')
      .select('id, message_id, who, what, kind, by_when, urgent, to_agent, note, state').eq('conversation_id', threadId).order('created_at')),
  ]);
  return {
    taskIds: items.flatMap((item) => [item.task_id, ((item.payload ?? {}) as Row).parent_task_id] as (string | null | undefined)[])
      .filter((id): id is string => typeof id === 'string' && !!id),
    projectIds: items.map((item) => item.project_id as string | null).filter((id): id is string => !!id),
    points,
    forMessage(messageId: string, project: (id: string) => string | null, task: (id: string) => string | null,
      done: { task: (id: string) => boolean; reminder: (id: string) => boolean }): InboxPlan | null {
      const plan = newest.get(messageId);
      if (!plan) return null;
      return {
        id: plan.id,
        status: plan.status,
        created_at: plan.created_at,
        items: items.filter((item) => item.plan_id === plan.id && item.type !== 'ask').map((item): InboxPlanItem => ({
          id: item.id as string,
          type: item.type as string,
          intent: item.intent as string,
          decision: item.decision as InboxPlanItem['decision'],
          decision_reason: (item.decision_reason as string | null) ?? null,
          state: item.state as InboxPlanItem['state'],
          label: planItemLabel(item, project, task),
          evidence: (item.evidence as string | null) ?? null,
          project_id: (item.project_id as string | null) ?? null,
          project_name: item.project_id ? project(item.project_id as string) : null,
          task_id: (item.task_id as string | null) ?? null,
          error: (item.error as string | null) ?? null,
          body: planItemBody(item),
          // What Change edits before adding: a suggested task's title and due date, a reminder's title.
          ...(item.type === 'create_task' || item.type === 'add_reminder' ? {
            title: (((item.payload ?? {}) as Row).title as string | undefined) ?? null,
            ...(item.type === 'create_task' ? { due_date: (((item.payload ?? {}) as Row).due_date as string | null | undefined) ?? null } : {}),
            ...(item.type === 'add_reminder' ? { remind_on: (((item.payload ?? {}) as Row).remind_on as string | null | undefined) ?? null } : {}),
          } : {}),
          // What it made, finished since: a done task or reminder is not one to wave off.
          ...(['done', 'accepted'].includes(item.state as string) && (item.type === 'create_task' || item.type === 'add_reminder') ? {
            target_done: item.type === 'create_task'
              ? !!item.task_id && done.task(item.task_id as string)
              : typeof ((item.result ?? {}) as Row).reminder_id === 'string' && done.reminder(((item.result ?? {}) as Row).reminder_id as string),
          } : {}),
        })),
      };
    },
  };
}

/** The emails a task came from. link_count covers every link, readable or not. */
export async function taskSourceEmails(ctx: InboxContext, taskId: string): Promise<TaskSourceEmails> {
  const id = assertId(taskId, 'task id');
  const task = await one<{ id: string; project_id: string }>(ctx.service.from('tasks').select('id, project_id').eq('id', id).is('deleted_at', null).maybeSingle());
  if (!task || !inboxReaches(ctx, task.project_id)) throw new InboxError(404, 'Task not found');
  const links = await many<{ message_id: string; relation: TaskLinkRelation; triage_id: string | null; linked_by: string | null; created_at: string }>(comms(ctx.service).from('task_links')
    .select('message_id, relation, triage_id, linked_by, created_at').eq('task_id', id).order('created_at'));
  if (links.length === 0 || !canReadInbox(ctx)) return { link_count: links.length, emails: [] };
  const readable = new Set(await readableInboxIds(ctx));
  const messageIds = [...new Set(links.map((link) => link.message_id))];
  const messages = (await many<{ id: string; thread_id: string; inbox_id: string; channel: InboxChannel | null; subject: string; received_at: string; status: string }>(comms(ctx.service).from('messages')
    .select('id, thread_id, inbox_id, channel, subject, received_at, status').in('id', messageIds)))
    .filter((message) => readable.has(message.inbox_id) && message.status !== 'receiving');
  const meetingThreads = [...new Set(messages.filter((m) => m.channel === 'meeting').map((m) => m.thread_id))];
  const [senders, meetings] = await Promise.all([
    messages.length
      ? many<{ message_id: string; address: string; name: string }>(comms(ctx.service).from('participants')
          .select('message_id, address, name').eq('kind', 'from').in('message_id', messages.map((m) => m.id)))
      : Promise.resolve([]),
    meetingThreads.length
      ? many<{ conversation_id: string; title: string; starts_at: string | null }>(comms(ctx.service).from('meetings')
          .select('conversation_id, title, starts_at').in('conversation_id', meetingThreads))
      : Promise.resolve([]),
  ]);
  const emails = links
    .map((link) => {
      const message = messages.find((m) => m.id === link.message_id);
      if (!message) return null;
      const sender = senders.find((row) => row.message_id === message.id);
      return {
        message_id: message.id,
        thread_id: message.thread_id,
        inbox_id: message.inbox_id,
        channel: message.channel ?? 'email',
        meeting_title: message.channel === 'meeting' ? meetings.find((m) => m.conversation_id === message.thread_id)?.title ?? 'Meeting' : null,
        meeting_starts_at: message.channel === 'meeting' ? meetings.find((m) => m.conversation_id === message.thread_id)?.starts_at ?? null : null,
        subject: message.subject,
        from: sender ? { name: sender.name, address: sender.address } : null,
        received_at: message.received_at,
        relation: link.relation,
        by: link.triage_id ? 'agent' as const : 'person' as const,
        linked_at: link.created_at,
        linked_by: link.linked_by,
      };
    })
    .filter((email): email is NonNullable<typeof email> => !!email);
  return { link_count: links.length, emails };
}
