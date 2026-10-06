import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { siteConfig } from '@/site-config';
import { domainOf, normalizeAddress, organizationalDomain } from './addresses';
import { attachmentKind } from './attachments';
import { isPublicEmailDomain, validateClientDomain } from './public-domains';
import { matchesSearch, needsAttention, snippetOf, tabCounts, threadFlags, threadInTab, type MessageState, type ThreadFlags } from './inbox-view';
import type {
  InboxAttachment, InboxCandidate, InboxLinkedTask, InboxMessage, InboxPerson, InboxSummary, InboxTab,
  InboxThreadDetail, InboxThreadList, InboxThreadSummary, MessageStatus, ProjectSource, RememberableSender,
  SetThreadProjectRequest, SetThreadProjectResult, TaskSourceEmails, ThreadProject, TriageOutcome, TrustLevel,
} from './inbox-types';

/**
 * The Inbox for people signed in to the app (session routes). Reads use the
 * service client, scoped here the way RLS scopes them (can_read_email_inbox):
 * inbound_email.manage reads every inbox, inbound_email.read the inboxes the
 * member was granted. Writes are the human actions only: set or confirm a
 * thread's project (and remember the sender or domain, rule 7), mark handled,
 * send back to the agent. Nothing here sends, replies to or forwards email,
 * and nothing deletes a message or a file.
 */

export class InboxError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface InboxContext {
  service: SupabaseClient;
  access: AccessContext;
  memberId: string;
}

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 100;

export function assertId(value: string | null | undefined, name = 'id'): string {
  if (!value || !UUID.test(value)) throw new InboxError(400, `${name} must be a UUID`);
  return value.toLowerCase();
}

/** Every row whose `column` is in `ids`, in chunks (URL length) and pages (row cap). */
async function readIn<T extends Row>(
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

async function one<T extends Row>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw error;
  return (data as T | null) ?? null;
}

async function many<T extends Row>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

export function canReadInbox(access: AccessContext): boolean {
  return accessAllows(access, 'inbound_email.read') || accessAllows(access, 'inbound_email.manage');
}

function isPerson(access: AccessContext): boolean {
  return access.role !== 'agent';
}

/** The inboxes this member reads (mirrors can_read_email_inbox). */
export async function readableInboxIds(ctx: InboxContext): Promise<string[]> {
  if (accessAllows(ctx.access, 'inbound_email.manage')) {
    return (await many<{ id: string }>(ctx.service.from('email_inboxes').select('id').order('created_at'))).map((row) => row.id);
  }
  if (!accessAllows(ctx.access, 'inbound_email.read')) return [];
  return (await many<{ inbox_id: string }>(ctx.service.from('email_inbox_access').select('inbox_id').eq('member_id', ctx.memberId)))
    .map((row) => row.inbox_id);
}

async function memberNames(service: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const found = await many<{ id: string; name: string }>(service.from('team_members').select('id, name').in('id', unique));
  return new Map(found.map((row) => [row.id, row.name]));
}

async function projectNames(service: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const found = await readIn<{ id: string; name: string }>(unique, (chunk, from, to, count) =>
    ctxSelect(service, 'projects', 'id, name', count).in('id', chunk).order('id').range(from, to));
  return new Map(found.map((row) => [row.id, row.name]));
}

function ctxSelect(service: SupabaseClient, table: string, columns: string, count: 'exact' | undefined) {
  return service.from(table).select(columns, count ? { count } : undefined);
}

async function inboxSummaries(service: SupabaseClient, ids: string[]): Promise<InboxSummary[]> {
  if (ids.length === 0) return [];
  const inboxes = await many<{ id: string; name: string; address: string; enabled: boolean; handler_member_id: string | null }>(
    service.from('email_inboxes').select('id, name, address, enabled, handler_member_id').in('id', ids).order('name'));
  const names = await memberNames(service, inboxes.map((inbox) => inbox.handler_member_id));
  return inboxes.map((inbox) => ({
    id: inbox.id,
    name: inbox.name,
    address: inbox.address,
    enabled: inbox.enabled,
    handler: inbox.handler_member_id ? { id: inbox.handler_member_id, name: names.get(inbox.handler_member_id) ?? 'Agent' } : null,
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

interface ThreadRow {
  id: string;
  inbox_id: string;
  subject_normalized: string;
  project_id: string | null;
  project_source: ProjectSource | null;
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
}

interface ThreadEntry {
  thread: ThreadRow;
  messages: StateMessageRow[];
  flags: ThreadFlags;
  sender: { name: string; address: string } | null;
  senders: { name: string; address: string }[];
}

/** Every thread in the given inboxes with its messages' states, newest activity first. */
async function loadThreadEntries(service: SupabaseClient, inboxIds: string[], projectId: string | null): Promise<ThreadEntry[]> {
  if (inboxIds.length === 0) return [];
  const threads = await readIn<ThreadRow & Row>(inboxIds, (chunk, from, to, count) => {
    let query = ctxSelect(service, 'email_threads', 'id, inbox_id, subject_normalized, project_id, project_source, last_message_at', count)
      .in('inbox_id', chunk);
    if (projectId) query = query.eq('project_id', projectId);
    return query.order('id').range(from, to);
  });
  if (threads.length === 0) return [];
  const threadIds = new Set(threads.map((thread) => thread.id));
  const messages = (await readIn<StateMessageRow & Row>(inboxIds, (chunk, from, to, count) =>
    ctxSelect(service, 'email_messages', 'id, thread_id, status, subject, received_at, auth, reviewed_at', count)
      .in('inbox_id', chunk).neq('status', 'receiving').order('id').range(from, to)))
    .filter((message) => threadIds.has(message.thread_id));
  const messageIds = messages.map((message) => message.id);
  const [triage, senders] = await Promise.all([
    readIn<{ id: string; message_id: string; outcome: TriageOutcome; urgent: boolean; created_at: string }>(messageIds, (chunk, from, to, count) =>
      ctxSelect(service, 'email_triage', 'id, message_id, outcome, urgent, created_at', count).in('message_id', chunk).order('id').range(from, to)),
    readIn<{ id: string; message_id: string; address: string; name: string }>(messageIds, (chunk, from, to, count) =>
      ctxSelect(service, 'email_message_recipients', 'id, message_id, address, name', count).in('message_id', chunk).eq('kind', 'from').order('id').range(from, to)),
  ]);
  const latest = latestTriage(triage);
  const senderByMessage = new Map(senders.map((row) => [row.message_id, { name: row.name, address: row.address }]));
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
      };
    });
    const threadSenders = list.map((message) => senderByMessage.get(message.id)).filter((s): s is { name: string; address: string } => !!s);
    entries.push({
      thread,
      messages: list,
      flags: threadFlags(states),
      sender: senderByMessage.get(list[list.length - 1].id) ?? null,
      senders: threadSenders,
    });
  }
  return entries.sort((a, b) => (a.thread.last_message_at < b.thread.last_message_at ? 1 : a.thread.last_message_at > b.thread.last_message_at ? -1 : 0));
}

export interface ThreadListFilters {
  inboxId: string | null;
  projectId: string | null;
  tab: InboxTab;
  search: string;
  limit: number;
  offset: number;
}

export async function listThreads(ctx: InboxContext, filters: ThreadListFilters): Promise<InboxThreadList> {
  if (!canReadInbox(ctx.access)) throw new InboxError(403, 'Forbidden');
  const readable = await readableInboxIds(ctx);
  const inboxId = filters.inboxId ? assertId(filters.inboxId, 'inbox_id') : null;
  const projectId = filters.projectId ? assertId(filters.projectId, 'project_id') : null;
  if (inboxId && !readable.includes(inboxId)) throw new InboxError(403, 'You cannot read this inbox');
  const scope = inboxId ? [inboxId] : readable;
  const [inboxes, entries] = await Promise.all([
    inboxSummaries(ctx.service, readable),
    loadThreadEntries(ctx.service, scope, projectId),
  ]);
  const names = await projectNames(ctx.service, entries.map((entry) => entry.thread.project_id));
  const inboxNames = new Map(inboxes.map((inbox) => [inbox.id, inbox.name]));
  const searched = filters.search.trim()
    ? entries.filter((entry) => matchesSearch(filters.search, [
        ...entry.messages.map((message) => message.subject),
        ...entry.senders.flatMap((sender) => [sender.name, sender.address]),
        entry.thread.project_id ? names.get(entry.thread.project_id) : null,
        inboxNames.get(entry.thread.inbox_id),
      ]))
    : entries;
  const counts = tabCounts(searched.map((entry) => ({ flags: entry.flags, project_id: entry.thread.project_id })));
  const inTab = searched.filter((entry) => threadInTab(entry.flags, entry.thread.project_id, filters.tab));
  const page = inTab.slice(filters.offset, filters.offset + filters.limit);

  const latestIds = page.map((entry) => entry.messages[entry.messages.length - 1].id);
  const pageMessageIds = page.flatMap((entry) => entry.messages.map((message) => message.id));
  const [bodies, attachments] = await Promise.all([
    readIn<{ id: string; new_text: string | null; text_body: string | null }>(latestIds, (chunk, from, to, count) =>
      ctxSelect(ctx.service, 'email_messages', 'id, new_text, text_body', count).in('id', chunk).order('id').range(from, to)),
    readIn<{ id: string; message_id: string }>(pageMessageIds, (chunk, from, to, count) =>
      ctxSelect(ctx.service, 'email_attachments', 'id, message_id', count).in('message_id', chunk).order('id').range(from, to)),
  ]);
  const bodyById = new Map(bodies.map((row) => [row.id, row]));
  const threads: InboxThreadSummary[] = page.map((entry) => {
    const latest = entry.messages[entry.messages.length - 1];
    const body = bodyById.get(latest.id);
    const ids = new Set(entry.messages.map((message) => message.id));
    return {
      id: entry.thread.id,
      inbox_id: entry.thread.inbox_id,
      inbox_name: inboxNames.get(entry.thread.inbox_id) ?? '',
      subject: latest.subject || entry.thread.subject_normalized || '',
      project: entry.thread.project_id && entry.thread.project_source
        ? { id: entry.thread.project_id, name: names.get(entry.thread.project_id) ?? 'Project', source: entry.thread.project_source }
        : null,
      last_message_at: entry.thread.last_message_at,
      message_count: entry.messages.length,
      sender: entry.sender,
      snippet: snippetOf(body?.new_text || body?.text_body),
      state: entry.flags.state,
      needs_you: entry.flags.needs_you,
      needs_reply: entry.flags.needs_reply,
      has_new: entry.flags.has_new,
      urgent: entry.flags.urgent,
      untrusted: entry.flags.untrusted,
      attachment_count: attachments.filter((row) => ids.has(row.message_id)).length,
    };
  });
  return { inboxes, threads, total: inTab.length, counts };
}

/** Threads waiting on a person, across every inbox the member reads (the sidebar badge). */
export async function attentionCount(ctx: InboxContext): Promise<number> {
  if (!canReadInbox(ctx.access)) return 0;
  const entries = await loadThreadEntries(ctx.service, await readableInboxIds(ctx), null);
  return entries.filter((entry) => needsAttention(entry.flags)).length;
}

async function loadReadableThread(ctx: InboxContext, threadId: string): Promise<ThreadRow> {
  if (!canReadInbox(ctx.access)) throw new InboxError(403, 'Forbidden');
  const id = assertId(threadId, 'thread id');
  const thread = await one<ThreadRow & Row>(ctx.service.from('email_threads')
    .select('id, inbox_id, subject_normalized, project_id, project_source, last_message_at').eq('id', id).maybeSingle());
  // An inbox the member cannot read looks like no thread at all.
  if (!thread || !(await readableInboxIds(ctx)).includes(thread.inbox_id)) throw new InboxError(404, 'Thread not found');
  return thread;
}

/** Addresses that belong to us: teammates and inboxes. They are never remembered as client senders. */
async function ownAddresses(service: SupabaseClient): Promise<Set<string>> {
  const [members, inboxes] = await Promise.all([
    many<{ email: string | null }>(service.from('team_members').select('email')),
    many<{ address: string; routing_address: string }>(service.from('email_inboxes').select('address, routing_address')),
  ]);
  const own = new Set<string>();
  for (const member of members) if (member.email) own.add(member.email.trim().toLowerCase());
  for (const inbox of inboxes) { own.add(inbox.address); own.add(inbox.routing_address); }
  return own;
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
  const [contactRows, domainRows] = await Promise.all([
    many<{ contact_id: string; email: string }>(service.from('contact_emails').select('contact_id, email').in('email', addresses)),
    many<{ domain: string; project_id: string }>(service.from('email_client_domains').select('domain, project_id').in('domain', domains)),
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
      mapped_project_ids: [...new Set(links.filter((link) => mine.includes(link.contact_id)).map((link) => link.project_id))],
      domain_project_ids: [...new Set(domainRows.filter((row) => row.domain === host || row.domain === org).map((row) => row.project_id))],
    };
  });
}

export async function threadDetail(ctx: InboxContext, threadId: string): Promise<InboxThreadDetail> {
  const thread = await loadReadableThread(ctx, threadId);
  const service = ctx.service;
  const messages = await many<Row>(service.from('email_messages')
    .select('id, status, subject, received_at, sent_at, text_body, html_body, new_text, is_forward, auth, auto_mail_reason, reviewed_at, reviewed_by')
    .eq('thread_id', thread.id).neq('status', 'receiving').order('received_at', { ascending: true }).order('id'));
  const ids = messages.map((message) => message.id as string);
  const [inbox] = await inboxSummaries(service, [thread.inbox_id]);
  const [recipients, attachments, triageRows, links, candidates] = await Promise.all([
    readIn<Row & { message_id: string; kind: string; address: string; name: string; contact_id: string | null; position: number }>(ids, (chunk, from, to, count) =>
      ctxSelect(service, 'email_message_recipients', 'id, message_id, kind, address, name, contact_id, position', count).in('message_id', chunk).order('id').range(from, to)),
    readIn<Row>(ids, (chunk, from, to, count) =>
      ctxSelect(service, 'email_attachments', 'id, message_id, position, filename, content_type, size_bytes, skipped_reason, uploaded_at, agent_label', count)
        .in('message_id', chunk).order('id').range(from, to)),
    readIn<Row & { id: string; message_id: string; created_at: string }>(ids, (chunk, from, to, count) =>
      ctxSelect(service, 'email_triage', 'id, message_id, member_id, outcome, urgent, summary, question_for_ciaran, suggested_reply, created_at', count)
        .in('message_id', chunk).order('id').range(from, to)),
    readIn<Row & { message_id: string; task_id: string }>(ids, (chunk, from, to, count) =>
      ctxSelect(service, 'email_task_links', 'id, message_id, task_id, relation, created_at', count).in('message_id', chunk).order('id').range(from, to)),
    readIn<Row & { message_id: string; project_id: string; reason: 'contact' | 'domain' }>(ids, (chunk, from, to, count) =>
      ctxSelect(service, 'email_message_candidates', 'message_id, project_id, reason', count).in('message_id', chunk).order('message_id').order('project_id').order('reason').range(from, to)),
  ]);
  const latest = latestTriage(triageRows);
  const taskIds = [...new Set(links.map((link) => link.task_id))];
  const tasks = taskIds.length
    ? await readIn<{ id: string; title: string; status: string; project_id: string }>(taskIds, (chunk, from, to, count) =>
        ctxSelect(service, 'tasks', 'id, title, status, project_id', count).in('id', chunk).order('id').range(from, to))
    : [];
  const [names, people] = await Promise.all([
    projectNames(service, [thread.project_id, ...candidates.map((row) => row.project_id)]),
    memberNames(service, [...[...latest.values()].map((row) => row.member_id as string | null), ...messages.map((row) => row.reviewed_by as string | null)]),
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
    });
    const memberId = (triageRow?.member_id as string | null) ?? null;
    const reviewedBy = (row.reviewed_by as string | null) ?? null;
    return {
      id,
      status,
      subject: (row.subject as string) ?? '',
      received_at: row.received_at as string,
      sent_at: (row.sent_at as string | null) ?? null,
      from: peopleOf(id, 'from')[0] ?? null,
      to: peopleOf(id, 'to'),
      cc: peopleOf(id, 'cc'),
      is_forward: Boolean(row.is_forward),
      trust: {
        level: trustOf(auth),
        reason: (auth.reason as string | null) ?? null,
        spf: (auth.spf as string | null) ?? null,
        dkim: (auth.dkim as string | null) ?? null,
        dmarc: (auth.dmarc as string | null) ?? null,
      },
      auto_mail_reason: (row.auto_mail_reason as string | null) ?? null,
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
        })),
      triage: triageRow ? {
        id: triageRow.id,
        outcome: triageRow.outcome as TriageOutcome,
        urgent: Boolean(triageRow.urgent),
        summary: triageRow.summary as string,
        question_for_ciaran: (triageRow.question_for_ciaran as string | null) ?? null,
        suggested_reply: (triageRow.suggested_reply as string | null) ?? null,
        member: memberId ? { id: memberId, name: people.get(memberId) ?? 'Agent' } : null,
        created_at: triageRow.created_at,
      } : null,
      linked_tasks: links
        .filter((link) => link.message_id === id)
        .map((link): InboxLinkedTask => {
          const task = tasks.find((t) => t.id === link.task_id);
          return {
            task_id: link.task_id,
            relation: link.relation as 'created' | 'updated',
            title: task?.title ?? null,
            status: task?.status ?? null,
            project_id: task?.project_id ?? null,
          };
        }),
      reviewed_at: (row.reviewed_at as string | null) ?? null,
      reviewed_by: reviewedBy ? { id: reviewedBy, name: people.get(reviewedBy) ?? 'Someone' } : null,
    };
  });

  const candidateList: InboxCandidate[] = [...new Set(candidates.map((row) => row.project_id))].map((projectId) => ({
    project_id: projectId,
    name: names.get(projectId) ?? null,
    reasons: [...new Set(candidates.filter((row) => row.project_id === projectId).map((row) => row.reason))],
  }));
  const flags = threadFlags(states);
  const latestMessage = presented[presented.length - 1];
  return {
    id: thread.id,
    inbox: inbox ?? { id: thread.inbox_id, name: 'Inbox', address: '', enabled: true, handler: null },
    subject: latestMessage?.subject || thread.subject_normalized || '',
    project: thread.project_id && thread.project_source
      ? { id: thread.project_id, name: names.get(thread.project_id) ?? 'Project', source: thread.project_source }
      : null,
    state: flags.state,
    urgent: flags.urgent,
    untrusted: flags.untrusted,
    candidates: candidateList,
    messages: presented,
    senders: await rememberableSenders(service, presented.map((message) => message.from).filter((from): from is InboxPerson => !!from)),
  };
}

/** A short-lived download link for one stored attachment. */
export async function attachmentDownloadUrl(ctx: InboxContext, attachmentId: string): Promise<{ url: string; filename: string; expires_in: number }> {
  if (!canReadInbox(ctx.access)) throw new InboxError(403, 'Forbidden');
  const id = assertId(attachmentId, 'attachment id');
  const attachment = await one<{ id: string; message_id: string; filename: string; storage_path: string | null; uploaded_at: string | null; skipped_reason: string | null }>(
    ctx.service.from('email_attachments').select('id, message_id, filename, storage_path, uploaded_at, skipped_reason').eq('id', id).maybeSingle());
  const message = attachment
    ? await one<{ inbox_id: string; status: string }>(ctx.service.from('email_messages').select('inbox_id, status').eq('id', attachment.message_id).maybeSingle())
    : null;
  if (!attachment || !message || message.status === 'receiving' || !(await readableInboxIds(ctx)).includes(message.inbox_id)) {
    throw new InboxError(404, 'Attachment not found');
  }
  if (attachment.skipped_reason || !attachment.storage_path || !attachment.uploaded_at) {
    throw new InboxError(409, 'This file was not stored (it was over the size limit), so there is nothing to download.');
  }
  const expiresIn = 60;
  const { data, error } = await ctx.service.storage.from('inbound-email')
    .createSignedUrl(attachment.storage_path, expiresIn, { download: attachment.filename || true });
  if (error || !data?.signedUrl) throw new InboxError(502, 'Could not create a download link');
  return { url: data.signedUrl, filename: attachment.filename, expires_in: expiresIn };
}

/**
 * Set or confirm the thread's project (source "ciaran"), and optionally
 * remember the sender (the person becomes a contact on each chosen project)
 * or the sender's domain (a client domain on each chosen project). Rule 7:
 * only people create mappings, and only for a sender of this thread.
 * Everything is checked before anything is written.
 */
export async function setThreadProject(ctx: InboxContext, threadId: string, request: SetThreadProjectRequest): Promise<SetThreadProjectResult> {
  const thread = await loadReadableThread(ctx, threadId);
  const projectId = assertId(request.project_id, 'project_id');
  const rememberSender = request.remember_sender ?? null;
  const rememberDomain = request.remember_domain ?? null;
  const allProjectIds = [...new Set([projectId, ...(rememberSender?.project_ids ?? []), ...(rememberDomain?.project_ids ?? [])])].map((id) => assertId(id, 'project_id'));
  for (const id of allProjectIds) {
    if (!accessAllowsProject(ctx.access, id)) throw new InboxError(403, 'You cannot assign email to that project');
  }
  const projects = await many<{ id: string; name: string }>(ctx.service.from('projects').select('id, name').in('id', allProjectIds));
  if (projects.length !== allProjectIds.length) throw new InboxError(404, 'Project not found');

  let sender: RememberableSender | null = null;
  let domain: string | null = null;
  if (rememberSender || rememberDomain) {
    if (!isPerson(ctx.access)) throw new InboxError(403, 'Only a person can remember a sender or domain');
    const messageIds = (await many<{ id: string }>(ctx.service.from('email_messages')
      .select('id').eq('thread_id', thread.id).neq('status', 'receiving').order('received_at'))).map((m) => m.id);
    const fromRows = messageIds.length
      ? await many<{ message_id: string; address: string; name: string }>(ctx.service.from('email_message_recipients')
          .select('message_id, address, name').eq('kind', 'from').in('message_id', messageIds))
      : [];
    // Oldest first, as rememberableSenders expects.
    fromRows.sort((a, b) => messageIds.indexOf(a.message_id) - messageIds.indexOf(b.message_id));
    const senders = await rememberableSenders(ctx.service, fromRows);
    if (rememberSender) {
      if (!accessAllows(ctx.access, 'contacts.manage')) throw new InboxError(403, 'Remembering a sender needs permission to manage contacts');
      const address = normalizeAddress(rememberSender.address);
      sender = senders.find((candidate) => candidate.address === address) ?? null;
      if (!sender) throw new InboxError(422, 'That address did not send email in this thread');
    }
    if (rememberDomain) {
      if (!accessAllows(ctx.access, 'contacts.manage') && !accessAllows(ctx.access, 'inbound_email.manage')) {
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
    let contactId = sender.contact_ids[0] ?? null;
    let created = false;
    if (!contactId) {
      const contact = await one<{ id: string }>(ctx.service.from('contacts').insert({
        name: sender.name.trim() || sender.address.split('@')[0],
        email: sender.address,
        color: siteConfig.colors.brand[500],
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
    for (const id of [...new Set(rememberSender.project_ids)]) {
      // Any contact with this address already on the project maps it.
      if (existing.some((link) => link.project_id === id)) continue;
      const { error } = await ctx.service.from('project_contacts').insert({ project_id: id, contact_id: contactId, role: 'Client', is_primary_client: false });
      if (error) throw error;
      linked.push(id);
    }
    rememberedSender = { contact_id: contactId, created_contact: created, linked_project_ids: linked };
  }

  let rememberedDomain: SetThreadProjectResult['remembered_domain'] = null;
  if (domain && rememberDomain) {
    const existing = await many<{ project_id: string }>(ctx.service.from('email_client_domains').select('project_id').eq('domain', domain));
    const added: string[] = [];
    for (const id of [...new Set(rememberDomain.project_ids)]) {
      if (existing.some((row) => row.project_id === id)) continue;
      const { error } = await ctx.service.from('email_client_domains').insert({ domain, project_id: id, created_by: ctx.memberId });
      if (error) throw error;
      added.push(id);
    }
    rememberedDomain = { domain, added_project_ids: added };
  }

  const { error } = await ctx.service.from('email_threads').update({ project_id: projectId, project_source: 'ciaran' }).eq('id', thread.id);
  if (error) throw error;
  const project: ThreadProject = { id: projectId, name: projects.find((p) => p.id === projectId)?.name ?? 'Project', source: 'ciaran' };
  return { project, remembered_sender: rememberedSender, remembered_domain: rememberedDomain };
}

/**
 * A person dealt with the thread: what waited on the agent or on a person
 * becomes handled, and every message counts as reviewed (which clears Needs
 * reply). Auto-mail stays ignored.
 */
export async function markThreadHandled(ctx: InboxContext, threadId: string): Promise<{ handled: number; reviewed: number }> {
  const thread = await loadReadableThread(ctx, threadId);
  const now = new Date().toISOString();
  const handled = await many<{ id: string }>(ctx.service.from('email_messages')
    .update({ status: 'handled' }).eq('thread_id', thread.id).in('status', ['new', 'needs_ciaran']).select('id'));
  const reviewed = await many<{ id: string }>(ctx.service.from('email_messages')
    .update({ reviewed_at: now, reviewed_by: ctx.memberId })
    .eq('thread_id', thread.id).eq('status', 'handled').is('reviewed_at', null).select('id'));
  return { handled: handled.length, reviewed: reviewed.length };
}

/** Back to the agent: the message (the newest one by default) is New again and she re-triages it. */
export async function sendBackToAgent(ctx: InboxContext, threadId: string, messageId: string | null): Promise<{ message_id: string }> {
  const thread = await loadReadableThread(ctx, threadId);
  const messages = await many<{ id: string; status: string }>(ctx.service.from('email_messages')
    .select('id, status').eq('thread_id', thread.id).neq('status', 'receiving').order('received_at', { ascending: false }).order('id', { ascending: false }));
  const target = messageId ? messages.find((message) => message.id === assertId(messageId, 'message_id')) : messages[0];
  if (!target) throw new InboxError(404, 'Message not found');
  if (target.status === 'new') throw new InboxError(409, 'It is already waiting for the agent');
  const { error } = await ctx.service.from('email_messages')
    .update({ status: 'new', reviewed_at: null, reviewed_by: null }).eq('id', target.id).neq('status', 'receiving');
  if (error) throw error;
  return { message_id: target.id };
}

/** The emails a task came from. link_count covers every link, readable or not. */
export async function taskSourceEmails(ctx: InboxContext, taskId: string): Promise<TaskSourceEmails> {
  const id = assertId(taskId, 'task id');
  const task = await one<{ id: string; project_id: string }>(ctx.service.from('tasks').select('id, project_id').eq('id', id).maybeSingle());
  if (!task || !accessAllowsProject(ctx.access, task.project_id)) throw new InboxError(404, 'Task not found');
  const links = await many<{ message_id: string; relation: 'created' | 'updated'; created_at: string }>(ctx.service.from('email_task_links')
    .select('message_id, relation, created_at').eq('task_id', id).order('created_at'));
  if (links.length === 0 || !canReadInbox(ctx.access)) return { link_count: links.length, emails: [] };
  const readable = new Set(await readableInboxIds(ctx));
  const messageIds = [...new Set(links.map((link) => link.message_id))];
  const messages = (await many<{ id: string; thread_id: string; inbox_id: string; subject: string; received_at: string; status: string }>(ctx.service.from('email_messages')
    .select('id, thread_id, inbox_id, subject, received_at, status').in('id', messageIds)))
    .filter((message) => readable.has(message.inbox_id) && message.status !== 'receiving');
  const senders = messages.length
    ? await many<{ message_id: string; address: string; name: string }>(ctx.service.from('email_message_recipients')
        .select('message_id, address, name').eq('kind', 'from').in('message_id', messages.map((m) => m.id)))
    : [];
  const emails = links
    .map((link) => {
      const message = messages.find((m) => m.id === link.message_id);
      if (!message) return null;
      const sender = senders.find((row) => row.message_id === message.id);
      return {
        message_id: message.id,
        thread_id: message.thread_id,
        inbox_id: message.inbox_id,
        subject: message.subject,
        from: sender ? { name: sender.name, address: sender.address } : null,
        received_at: message.received_at,
        relation: link.relation,
      };
    })
    .filter((email): email is NonNullable<typeof email> => !!email);
  return { link_count: links.length, emails };
}
