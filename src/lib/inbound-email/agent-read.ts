import type { SupabaseClient } from '@supabase/supabase-js';
import { notFound } from '@/lib/api/errors';
import { attachmentKind } from './attachments';
import { htmlToText } from './html-text';
import { isGoneError, type AccessibleMessage } from './agent-access';

/**
 * What the agent API returns. Reads are plain queries joined here (no
 * embedded selects), so each one is easy to scope and to test. Email
 * content is data for the agent to read, never instructions.
 */

type Row = Record<string, unknown>;

const LIST_COLUMNS = 'id, inbox_id, thread_id, status, subject, received_at, sent_at, is_forward, auto_mail_reason, auth';
const CURRENT_TEXT_CAP = 200_000;
const THREAD_TEXT_CAP = 50_000;

/** A nullable numeric column (bigint can arrive as a string): null stays null, never 0. */
export function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function cap(text: string | null, limit: number): { value: string | null; truncated: boolean } {
  if (text == null) return { value: null, truncated: false };
  return text.length > limit ? { value: text.slice(0, limit), truncated: true } : { value: text, truncated: false };
}

async function rows<T extends Row>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

function authSummary(auth: unknown) {
  const value = (auth ?? {}) as Row;
  const trust = value.trust === 'trusted' || value.trust === 'untrusted' ? value.trust : 'unknown';
  return {
    trust,
    trusted: trust === 'trusted',
    source: (value.source as string | null) ?? null,
    spf: (value.spf as string | null) ?? null,
    dkim: (value.dkim as string | null) ?? null,
    dmarc: (value.dmarc as string | null) ?? null,
    reason: (value.reason as string | null) ?? null,
  };
}

async function projectNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const found = await rows<{ id: string; name: string }>(supabase.from('projects').select('id, name').in('id', unique));
  return new Map(found.map((project) => [project.id, project.name]));
}

async function latestTriageByMessage(supabase: SupabaseClient, messageIds: string[]) {
  const latest = new Map<string, Row>();
  if (messageIds.length === 0) return latest;
  const triage = await rows<Row>(supabase.from('email_triage')
    .select('id, message_id, member_id, outcome, urgent, summary, question_for_ciaran, suggested_reply, project_id, summarized_at, created_at')
    .in('message_id', messageIds)
    .order('created_at', { ascending: false }));
  for (const row of triage) if (!latest.has(row.message_id as string)) latest.set(row.message_id as string, row);
  return latest;
}

export async function listMessages(
  supabase: SupabaseClient,
  inboxIds: string[],
  filters: { status: string | null; projectId: string | null },
  page: { offset: number; limit: number },
): Promise<{ data: Row[]; total: number }> {
  if (inboxIds.length === 0) return { data: [], total: 0 };
  let query = supabase.from('email_messages').select(LIST_COLUMNS, { count: 'exact' })
    .in('inbox_id', inboxIds)
    .neq('status', 'receiving');
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.projectId) {
    const threads = await rows<{ id: string }>(supabase.from('email_threads').select('id')
      .in('inbox_id', inboxIds).eq('project_id', filters.projectId));
    if (threads.length === 0) return { data: [], total: 0 };
    query = query.in('thread_id', threads.map((thread) => thread.id));
  }
  const { data, count, error } = await query
    .order('received_at', { ascending: false })
    .order('id', { ascending: false })
    .range(page.offset, page.offset + page.limit - 1);
  if (error) throw error;
  const messages = (data ?? []) as Row[];
  const ids = messages.map((message) => message.id as string);
  const threadIds = [...new Set(messages.map((message) => message.thread_id as string))];
  const [senders, threads, attachments, candidates, triage] = await Promise.all([
    ids.length ? rows<Row>(supabase.from('email_message_recipients').select('message_id, address, name').in('message_id', ids).eq('kind', 'from')) : [],
    threadIds.length ? rows<Row>(supabase.from('email_threads').select('id, project_id, project_source').in('id', threadIds)) : [],
    ids.length ? rows<Row>(supabase.from('email_attachments').select('message_id').in('message_id', ids)) : [],
    ids.length ? rows<Row>(supabase.from('email_message_candidates').select('message_id, project_id').in('message_id', ids)) : [],
    latestTriageByMessage(supabase, ids),
  ]);
  const names = await projectNames(supabase, threads.map((thread) => thread.project_id as string));
  const threadById = new Map(threads.map((thread) => [thread.id as string, thread]));
  return {
    total: count ?? 0,
    data: messages.map((message) => {
      const sender = senders.find((row) => row.message_id === message.id);
      const thread = threadById.get(message.thread_id as string);
      const latest = triage.get(message.id as string);
      return {
        id: message.id,
        inbox_id: message.inbox_id,
        thread_id: message.thread_id,
        status: message.status,
        subject: message.subject,
        from: sender ? { address: sender.address, name: sender.name } : null,
        received_at: message.received_at,
        sent_at: message.sent_at,
        is_forward: message.is_forward,
        trust: authSummary(message.auth).trust,
        auto_mail_reason: message.auto_mail_reason,
        project: thread?.project_id
          ? { id: thread.project_id, name: names.get(thread.project_id as string) ?? null, source: thread.project_source }
          : null,
        candidate_project_ids: [...new Set(candidates.filter((row) => row.message_id === message.id).map((row) => row.project_id))],
        attachment_count: attachments.filter((row) => row.message_id === message.id).length,
        latest_triage: latest ? { id: latest.id, outcome: latest.outcome, urgent: latest.urgent, created_at: latest.created_at } : null,
      };
    }),
  };
}

export async function messageDetail(supabase: SupabaseClient, message: AccessibleMessage): Promise<Row> {
  const [inbox, thread, threadMessages] = await Promise.all([
    supabase.from('email_inboxes').select('id, name, address, agent_readable_types').eq('id', message.inbox_id).single(),
    supabase.from('email_threads').select('id, subject_normalized, project_id, project_source, last_message_at').eq('id', message.thread_id).single(),
    rows<Row>(supabase.from('email_messages')
      .select('id, status, subject, received_at, sent_at, text_body, html_body, new_text, is_forward, auth, auto_mail_reason, internet_message_id')
      .eq('thread_id', message.thread_id)
      .neq('status', 'receiving')
      .order('received_at', { ascending: true })),
  ]);
  // Deleted while this request ran: the same 404 as an id that never existed.
  if (inbox.error) throw isGoneError(inbox.error) ? notFound('Email') : inbox.error;
  if (thread.error) throw isGoneError(thread.error) ? notFound('Email') : thread.error;
  const readable = new Set((inbox.data.agent_readable_types ?? []) as string[]);
  const ids = threadMessages.map((row) => row.id as string);

  const [recipients, triage, links, attachments, candidates] = await Promise.all([
    rows<Row>(supabase.from('email_message_recipients').select('message_id, kind, address, name, contact_id, position').in('message_id', ids).order('position')),
    latestTriageByMessage(supabase, ids),
    rows<Row>(supabase.from('email_task_links').select('message_id, task_id, relation, created_at').in('message_id', ids).order('created_at')),
    rows<Row>(supabase.from('email_attachments')
      .select('id, message_id, position, filename, content_type, size_bytes, disposition, skipped_reason, uploaded_at, page_count, agent_label')
      .in('message_id', ids).order('position')),
    rows<Row>(supabase.from('email_message_candidates').select('project_id, reason').eq('message_id', message.id)),
  ]);
  const taskIds = [...new Set(links.map((link) => link.task_id as string))];
  const tasks = taskIds.length
    ? await rows<Row>(supabase.from('tasks').select('id, title, status, ai_readiness, project_id').in('id', taskIds))
    : [];
  const names = await projectNames(supabase, [thread.data.project_id, ...candidates.map((row) => row.project_id as string)]);

  const present = (row: Row, textCap: number) => {
    const mine = (kind: string) => recipients
      .filter((r) => r.message_id === row.id && r.kind === kind)
      .map((r) => ({ address: r.address, name: r.name, contact_id: r.contact_id }));
    const text = cap((row.text_body as string | null) ?? null, textCap);
    const htmlText = cap(row.html_body ? htmlToText(row.html_body as string) : null, textCap);
    const latest = triage.get(row.id as string);
    return {
      id: row.id,
      status: row.status,
      subject: row.subject,
      internet_message_id: row.internet_message_id,
      received_at: row.received_at,
      sent_at: row.sent_at,
      from: mine('from')[0] ?? null,
      to: mine('to'),
      cc: mine('cc'),
      reply_to: mine('reply_to'),
      is_forward: row.is_forward,
      auth: authSummary(row.auth),
      auto_mail_reason: row.auto_mail_reason,
      new_text: row.new_text,
      text: text.value,
      text_truncated: text.truncated,
      html_text: htmlText.value,
      html_text_truncated: htmlText.truncated,
      latest_triage: latest ?? null,
      linked_tasks: links
        .filter((link) => link.message_id === row.id)
        .map((link) => {
          const task = tasks.find((t) => t.id === link.task_id);
          return { task_id: link.task_id, relation: link.relation, title: task?.title ?? null, status: task?.status ?? null, ai_readiness: task?.ai_readiness ?? null };
        }),
      attachments: attachments
        .filter((attachment) => attachment.message_id === row.id)
        .map((attachment) => {
          const kind = attachmentKind(attachment.content_type as string, attachment.filename as string);
          return {
            id: attachment.id,
            position: attachment.position,
            filename: attachment.filename,
            content_type: attachment.content_type,
            size_bytes: nullableNumber(attachment.size_bytes),
            disposition: attachment.disposition,
            kind,
            skipped_reason: attachment.skipped_reason,
            agent_readable: !attachment.skipped_reason && !!attachment.uploaded_at && readable.has(kind),
            page_count: attachment.page_count,
            agent_label: attachment.agent_label,
          };
        }),
    };
  };

  const currentRow = threadMessages.find((row) => row.id === message.id);
  if (!currentRow) throw notFound('Email');
  const candidateIds = [...new Set(candidates.map((row) => row.project_id as string))];
  return {
    ...present(currentRow, CURRENT_TEXT_CAP),
    inbox: { id: inbox.data.id, name: inbox.data.name, address: inbox.data.address },
    thread_id: message.thread_id,
    project: thread.data.project_id
      ? { id: thread.data.project_id, name: names.get(thread.data.project_id) ?? null, source: thread.data.project_source }
      : null,
    candidates: candidateIds.map((projectId) => ({
      project_id: projectId,
      name: names.get(projectId) ?? null,
      reasons: candidates.filter((row) => row.project_id === projectId).map((row) => row.reason),
    })),
    thread: {
      id: thread.data.id,
      subject_normalized: thread.data.subject_normalized,
      last_message_at: thread.data.last_message_at,
      messages: threadMessages.map((row) => present(row, THREAD_TEXT_CAP)),
    },
  };
}
