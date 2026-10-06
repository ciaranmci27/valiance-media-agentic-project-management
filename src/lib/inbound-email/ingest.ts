import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { domainOf, organizationalDomain } from './addresses';
import { trustedAuthservIds } from './auth-results';
import { mappedProjectForThread, resolveMapping } from './mapping';
import type { InboundEmail, InboundFile } from './normalized';
import { prepareEmail, type PreparedEmail } from './prepare';
import { chooseThread, referencedIds, THREAD_SUBJECT_WINDOW_DAYS, type SubjectThread } from './threading';

/**
 * The provider-agnostic ingestion core. A transport hands it one received
 * email (InboundEmail); for each inbox the email was delivered to it:
 * 1. creates the message, recipient and attachment rows (status receiving),
 *    idempotent on the provider id and on (inbox, Message-ID);
 * 2. if the subject carries the inbox's verification code, marks the inbox
 *    verified and deletes the message (files first, then the row): it never
 *    reaches an agent;
 * 3. copies the raw .eml and each attachment within the size cap into the
 *    private bucket, server-side, hashing as it reads, and records size and
 *    SHA-256 per file (a retry resumes with the files not yet stored);
 * 4. threads, maps and files the message as new or ignored.
 * Any failure throws, so the transport answers non-2xx and the provider
 * retries; rows exist before their files, so nothing is ever orphaned, and
 * a message left in receiving is cleaned up by retention, files first.
 * Nothing here sends email.
 */

export const INBOUND_EMAIL_BUCKET = 'inbound-email';
/** The bucket's per-object limit (50 MiB); a larger raw message is not stored. */
export const MAX_OBJECT_BYTES = 52_428_800;
const MIB = 1024 * 1024;

export type InboxOutcome =
  | { inbox_id: string; email_id: string; outcome: 'completed'; status: string; thread_id: string }
  | { inbox_id: string; email_id: string; outcome: 'already_complete'; status: string }
  | { inbox_id: string; outcome: 'verified' };

export type IngestResult =
  | { kind: 'no_inbox'; delivered_to: string[] }
  | { kind: 'ingested'; inboxes: InboxOutcome[] };

interface InboxRow {
  id: string;
  address: string;
  routing_address: string;
  enabled: boolean;
  max_attachment_mb: number;
  verification_code: string;
  verified_at: string | null;
  filter_auto_mail: boolean;
}

interface StartRpcResult {
  created: boolean;
  message: { id: string; inbox_id: string; status: string; raw_storage_path: string | null; raw_uploaded_at: string | null };
  attachments: {
    id: string; position: number; filename: string; content_type: string; size_bytes: number | null;
    provider_attachment_id: string | null; storage_path: string | null; skipped_reason: string | null; uploaded_at: string | null;
  }[];
}

/** Records the newest ingestion failure on the inbox, for the settings status. Best effort. */
export async function recordInboxError(supabase: SupabaseClient, inboxId: string, message: string): Promise<void> {
  const { error } = await supabase
    .from('email_inboxes')
    .update({ last_error: message.slice(0, 1000), last_error_at: new Date().toISOString() })
    .eq('id', inboxId);
  if (error) console.error('[inbound-email] could not record inbox error', error);
}

/**
 * The inboxes an email belongs to: every address it was delivered to (the
 * provider's to, cc, bcc and received_for, plus the To and Cc headers)
 * against inbox routing addresses, case-insensitively, on any domain. A
 * forwarded message usually names only the public address in its headers;
 * the routing address then arrives in received_for (the `for` clause of the
 * receiving server's Received header). Public addresses never match: mail
 * for an unknown routing address is not stored.
 */
async function matchInboxes(supabase: SupabaseClient, prepared: PreparedEmail): Promise<InboxRow[]> {
  const columns = 'id, address, routing_address, enabled, max_attachment_mb, verification_code, verified_at, filter_auto_mail';
  const headerAddresses = prepared.recipients.filter((r) => r.kind === 'to' || r.kind === 'cc').map((r) => r.address);
  const lookup = [...new Set([...prepared.deliveredTo, ...headerAddresses])];
  if (lookup.length === 0) return [];
  const { data, error } = await supabase.from('email_inboxes').select(columns).in('routing_address', lookup);
  if (error) throw error;
  return ((data ?? []) as InboxRow[]).filter((inbox) => inbox.enabled);
}

export async function ingestInbound(supabase: SupabaseClient, email: InboundEmail): Promise<IngestResult> {
  const prepared = prepareEmail(email, { trustedAuthservIds: trustedAuthservIds() });
  const inboxes = await matchInboxes(supabase, prepared);
  if (inboxes.length === 0) {
    // Logged only: there is no inbox to record it on, and nothing is stored.
    console.warn(`[inbound-email] no enabled inbox for ${prepared.deliveredTo.join(', ') || 'no recipients'}`);
    return { kind: 'no_inbox', delivered_to: prepared.deliveredTo };
  }
  const outcomes: InboxOutcome[] = [];
  for (const inbox of inboxes) {
    try {
      outcomes.push(await ingestIntoInbox(supabase, inbox, email, prepared));
    } catch (error) {
      await recordInboxError(supabase, inbox.id, `Could not take in ${email.provider} email ${email.provider_email_id}: ${(error as Error).message}`);
      throw error;
    }
  }
  return { kind: 'ingested', inboxes: outcomes };
}

/**
 * Reads a response body up to `cap` bytes, hashing as it goes; null when
 * larger. A body shorter or longer than its Content-Length is an error (a
 * cut-off download must never be stored as the file).
 */
async function readCapped(response: Response, cap: number): Promise<{ bytes: Buffer; sha256: string } | null> {
  const header = response.headers.get('content-length');
  const declared = header === null ? null : Number(header);
  if (declared !== null && Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), sha256: hash.digest('hex') };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) return null;
      hash.update(value);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (declared !== null && Number.isFinite(declared) && declared !== size) {
    throw new Error(`download was ${size} bytes, Content-Length said ${declared}`);
  }
  return { bytes: Buffer.concat(chunks), sha256: hash.digest('hex') };
}

async function fetchFile(file: InboundFile, label: string): Promise<Response> {
  const response = await file.fetch();
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} download answered ${response.status}`);
  }
  return response;
}

async function upload(supabase: SupabaseClient, path: string, bytes: Buffer, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from(INBOUND_EMAIL_BUCKET).upload(path, bytes, {
    contentType: contentType || 'application/octet-stream',
    // The row owns this path; a retry after a partial run rewrites the same bytes.
    upsert: true,
  });
  if (error) throw new Error(`storing ${path} failed: ${error.message}`);
}

async function storeFiles(supabase: SupabaseClient, inbox: InboxRow, email: InboundEmail, started: StartRpcResult): Promise<void> {
  const message = started.message;
  if (message.raw_storage_path && !message.raw_uploaded_at && email.raw) {
    const read = await readCapped(await fetchFile(email.raw, 'raw message'), MAX_OBJECT_BYTES);
    if (!read) {
      // Too large for the bucket: the parsed bodies and attachments still stand.
      const { error } = await supabase.from('email_messages').update({ raw_storage_path: null }).eq('id', message.id);
      if (error) throw error;
    } else {
      await upload(supabase, message.raw_storage_path, read.bytes, 'message/rfc822');
      const { error } = await supabase.from('email_messages').update({
        raw_size_bytes: read.bytes.byteLength,
        raw_sha256: read.sha256,
        raw_uploaded_at: new Date().toISOString(),
      }).eq('id', message.id);
      if (error) throw error;
    }
  } else if (message.raw_storage_path && !message.raw_uploaded_at && !email.raw) {
    const { error } = await supabase.from('email_messages').update({ raw_storage_path: null }).eq('id', message.id);
    if (error) throw error;
  }

  const cap = Math.min(inbox.max_attachment_mb * MIB, MAX_OBJECT_BYTES);
  for (const row of started.attachments) {
    if (!row.storage_path || row.uploaded_at) continue;
    // By the provider's id; for the same message delivered again under other
    // ids, by position when the filename agrees.
    const byPosition = email.attachments[row.position];
    const source = email.attachments.find((a) => a.provider_attachment_id && a.provider_attachment_id === row.provider_attachment_id)
      ?? (byPosition && (byPosition.filename ?? '') === row.filename ? byPosition : undefined);
    if (!source) throw new Error(`attachment ${row.position} is no longer offered by the provider`);
    const read = await readCapped(await fetchFile(source.source, `attachment ${row.position}`), cap);
    if (!read) {
      const { error } = await supabase.from('email_attachments')
        .update({ storage_path: null, skipped_reason: 'over_size_cap' }).eq('id', row.id);
      if (error) throw error;
      continue;
    }
    if (row.size_bytes != null && Number(row.size_bytes) !== read.bytes.byteLength) {
      // The stored size is the real one; the listing's figure is informational.
      console.warn(`[inbound-email] attachment ${row.id} is ${read.bytes.byteLength} bytes; the provider listed ${row.size_bytes}`);
    }
    await upload(supabase, row.storage_path, read.bytes, row.content_type);
    const { error } = await supabase.from('email_attachments').update({
      size_bytes: read.bytes.byteLength,
      sha256: read.sha256,
      uploaded_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (error) throw error;
  }
}

async function ingestIntoInbox(
  supabase: SupabaseClient,
  inbox: InboxRow,
  email: InboundEmail,
  prepared: PreparedEmail,
): Promise<InboxOutcome> {
  const { data, error } = await supabase.rpc('email_start_message', {
    p_inbox_id: inbox.id,
    p_message: prepared.message,
    p_recipients: prepared.recipients,
    p_attachments: email.attachments.map((attachment) => ({
      filename: attachment.filename ?? '',
      content_type: attachment.content_type ?? '',
      size_bytes: attachment.size,
      disposition: attachment.disposition,
      content_id: attachment.content_id,
      provider_attachment_id: attachment.provider_attachment_id,
    })),
    p_max_attachment_bytes: Math.min(inbox.max_attachment_mb * MIB, MAX_OBJECT_BYTES),
  });
  if (error) throw error;
  const started = data as StartRpcResult;
  const messageId = started.message.id;
  if (started.message.status !== 'receiving') {
    return { inbox_id: inbox.id, email_id: messageId, outcome: 'already_complete', status: started.message.status };
  }

  // A verification email proves the route works and is then deleted, files
  // first (a retried run may have stored some), then the row.
  if (prepared.message.subject.toUpperCase().includes(inbox.verification_code.toUpperCase())) {
    if (!inbox.verified_at) {
      const { error: verifyError } = await supabase.from('email_inboxes').update({ verified_at: new Date().toISOString() }).eq('id', inbox.id);
      if (verifyError) throw verifyError;
    }
    const paths = [started.message.raw_storage_path, ...started.attachments.map((a) => a.storage_path)].filter((p): p is string => !!p);
    if (paths.length) {
      const { error: removeError } = await supabase.storage.from(INBOUND_EMAIL_BUCKET).remove(paths);
      if (removeError) throw new Error(`could not delete the verification email's files: ${removeError.message}`);
    }
    const { error: deleteError } = await supabase.from('email_messages').delete().eq('id', messageId);
    if (deleteError) throw deleteError;
    return { inbox_id: inbox.id, outcome: 'verified' };
  }

  await storeFiles(supabase, inbox, email, started);
  return finalize(supabase, inbox, messageId, prepared);
}

async function finalize(supabase: SupabaseClient, inbox: InboxRow, messageId: string, prepared: PreparedEmail): Promise<InboxOutcome> {
  const { data: message, error: messageError } = await supabase
    .from('email_messages')
    .select('id, subject_normalized, in_reply_to, reference_ids, received_at, auto_mail_reason')
    .eq('id', messageId)
    .single();
  if (messageError) throw messageError;

  const inboxAddresses = new Set([inbox.address, inbox.routing_address].map((address) => address.toLowerCase()));
  const fromAddress = prepared.fromAddress;
  const people = [...new Set(prepared.recipients.map((row) => row.address).filter((address) => !inboxAddresses.has(address)))];

  // Mapping: every contact that has the sender's address, and the sender's domain.
  const { data: contactRows, error: contactError } = people.length
    ? await supabase.from('contact_emails').select('contact_id, email').in('email', people)
    : { data: [], error: null };
  if (contactError) throw contactError;
  const contactsByAddress = new Map<string, Set<string>>();
  for (const row of (contactRows ?? []) as { contact_id: string; email: string }[]) {
    if (!contactsByAddress.has(row.email)) contactsByAddress.set(row.email, new Set());
    contactsByAddress.get(row.email)!.add(row.contact_id);
  }
  const recipientContacts = [...contactsByAddress.entries()]
    .filter(([, ids]) => ids.size === 1)
    .map(([address, ids]) => ({ address, contact_id: [...ids][0] }));
  const senderIsPerson = !!fromAddress && !inboxAddresses.has(fromAddress);
  const senderContactIds = senderIsPerson ? [...(contactsByAddress.get(fromAddress as string) ?? [])] : [];
  const fromDomain = senderIsPerson ? domainOf(fromAddress as string) : null;
  const [contactProjects, domainProjects] = await Promise.all([
    senderContactIds.length
      ? supabase.from('project_contacts').select('project_id').in('contact_id', senderContactIds)
      : Promise.resolve({ data: [], error: null }),
    fromDomain
      ? supabase.from('email_client_domains').select('project_id').in('domain', [...new Set([fromDomain, organizationalDomain(fromDomain)])])
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contactProjects.error) throw contactProjects.error;
  if (domainProjects.error) throw domainProjects.error;
  const projectIdsOf = (result: { data: unknown }) => ((result.data ?? []) as { project_id: string }[]).map((row) => row.project_id);
  const everyProject = [...new Set([...projectIdsOf(contactProjects), ...projectIdsOf(domainProjects)])];
  // Archived projects take no new mail.
  const { data: liveProjects, error: projectError } = everyProject.length
    ? await supabase.from('projects').select('id, status, archived_at').in('id', everyProject)
    : { data: [], error: null };
  if (projectError) throw projectError;
  const live = new Set(((liveProjects ?? []) as { id: string; status: string; archived_at: string | null }[])
    .filter((project) => !project.archived_at && project.status !== 'archived')
    .map((project) => project.id));
  const mapping = resolveMapping({
    contactProjectIds: projectIdsOf(contactProjects).filter((id) => live.has(id)),
    domainProjectIds: projectIdsOf(domainProjects).filter((id) => live.has(id)),
  });

  // Threading, inside this inbox only.
  const ids = referencedIds((message.in_reply_to ?? []) as string[], (message.reference_ids ?? []) as string[]);
  const { data: referenced, error: referencedError } = ids.length
    ? await supabase.from('email_messages').select('thread_id, received_at')
        .eq('inbox_id', inbox.id).in('internet_message_id', ids).not('thread_id', 'is', null)
    : { data: [], error: null };
  if (referencedError) throw referencedError;

  let subjectThreads: SubjectThread[] = [];
  if (message.subject_normalized && !(referenced ?? []).length) {
    const since = new Date(Date.parse(message.received_at) - THREAD_SUBJECT_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: threads, error: threadError } = await supabase.from('email_threads')
      .select('id, subject_normalized, last_message_at')
      .eq('inbox_id', inbox.id)
      .eq('subject_normalized', message.subject_normalized)
      .gte('last_message_at', since)
      .order('last_message_at', { ascending: false })
      .limit(20);
    if (threadError) throw threadError;
    const threadIds = ((threads ?? []) as { id: string }[]).map((thread) => thread.id);
    const { data: participants, error: participantError } = threadIds.length
      ? await supabase.from('email_thread_participants').select('thread_id, address').in('thread_id', threadIds)
      : { data: [], error: null };
    if (participantError) throw participantError;
    subjectThreads = ((threads ?? []) as { id: string; subject_normalized: string; last_message_at: string }[]).map((thread) => ({
      thread_id: thread.id,
      subject_normalized: thread.subject_normalized,
      last_message_at: thread.last_message_at,
      participants: ((participants ?? []) as { thread_id: string; address: string }[])
        .filter((row) => row.thread_id === thread.id && !inboxAddresses.has(row.address))
        .map((row) => row.address),
    }));
  }
  const choice = chooseThread({
    referenced: (referenced ?? []) as { thread_id: string; received_at: string }[],
    subjectNormalized: message.subject_normalized,
    subjectThreads,
    participants: people,
    receivedAt: message.received_at,
  });

  let joinedThread: { project_id: string | null } | null = null;
  if (choice.kind === 'existing') {
    const { data: thread, error } = await supabase.from('email_threads').select('project_id').eq('id', choice.thread_id).single();
    if (error) throw error;
    joinedThread = thread;
  }

  const status = message.auto_mail_reason && inbox.filter_auto_mail ? 'ignored' : 'new';
  const { data: completed, error: completeError } = await supabase.rpc('email_complete_message', {
    p_message_id: messageId,
    p_decision: {
      status,
      thread_id: choice.kind === 'existing' ? choice.thread_id : null,
      project_id: mappedProjectForThread(joinedThread, mapping),
      candidates: mapping.candidates,
      recipient_contacts: recipientContacts,
    },
  });
  if (completeError) throw completeError;
  const result = completed as { already_complete: boolean; status: string; thread_id: string };
  if (result.already_complete) return { inbox_id: inbox.id, email_id: messageId, outcome: 'already_complete', status: result.status };
  return { inbox_id: inbox.id, email_id: messageId, outcome: 'completed', status: result.status, thread_id: result.thread_id };
}
