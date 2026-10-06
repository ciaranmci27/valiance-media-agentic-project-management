import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { domainOf, organizationalDomain } from './addresses';
import { trustedAuthservIds } from './auth-results';
import { ATTACHED_HEAD_BYTES, fromRfc822Head, inlineForwardedSender, isAttachedMessage, type ForwardedSender } from './forwarded';
import { resolveMapping, threadProjectDecision } from './mapping';
import type { InboundEmail, InboundFile } from './normalized';
import { prepareEmail, readableBody, type PreparedEmail } from './prepare';
import { chooseThread, referencedIds, THREAD_SUBJECT_WINDOW_DAYS, type SubjectThread } from './threading';

/**
 * The provider-agnostic ingestion core. A transport hands it one received
 * email (InboundEmail); for each inbox the email was delivered to it:
 * 1. creates the message, recipient and attachment rows (status receiving),
 *    idempotent on the provider id and on (inbox, Message-ID);
 * 2. while the inbox is not verified yet, if the subject carries its
 *    verification code, marks the inbox verified and deletes the message
 *    (files first, then the row): it never reaches an agent. Once verified,
 *    such an email is ordinary mail;
 * 3. copies the raw .eml and each attachment within the size cap into the
 *    private bucket, server-side, hashing as it reads, and records size and
 *    SHA-256 per file (a retry resumes with the files not yet stored);
 * 4. threads, maps and files the message as new or ignored. The visible
 *    sender decides the project, unless it is a verified teammate: then a
 *    forward maps by its original sender, and a teammate's own email
 *    copied to the inbox maps by the client addresses in To and Cc.
 * Any failure throws, so the transport answers non-2xx and the provider
 * retries; rows exist before their files, so nothing is ever orphaned, and
 * a message left in receiving is cleaned up by retention, files first.
 * A file that keeps failing does not hold its message back for long: from
 * the FILE_GIVE_UP_FAILURES-th failed run, or once the message is
 * FILE_GIVE_UP_AGE_MINUTES old, it is skipped (download_failed) and the
 * email arrives without it (email_files_failed).
 * Nothing here sends email.
 */

export const INBOUND_EMAIL_BUCKET = 'inbound-email';
/** The bucket's per-object limit (50 MiB); a larger raw message is not stored. */
export const MAX_OBJECT_BYTES = 52_428_800;
const MIB = 1024 * 1024;
/**
 * Failed runs, or the age, after which a file that will not download or
 * store is given up on. Resend retries a failed webhook for about a day
 * (5 s, 5 min, 30 min, 2 h, 5 h, 10 h), so the fifth run is about 2.5 hours
 * in; retention deletes a message still receiving after 24 hours.
 */
export const FILE_GIVE_UP_FAILURES = 5;
export const FILE_GIVE_UP_AGE_MINUTES = 6 * 60;

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

/** A project's own address: its mail goes to inbox_id, filed on project_id. */
interface ProjectAddressRow {
  id: string;
  project_id: string;
  inbox_id: string;
  routing_address: string;
  public_address: string | null;
}

/** One inbox the email goes to, and the project address that sends it there, if any. */
interface InboxTarget {
  inbox: InboxRow;
  projectAddress: ProjectAddressRow | null;
}

const INBOX_COLUMNS = 'id, address, routing_address, enabled, max_attachment_mb, verification_code, verified_at, filter_auto_mail';

/**
 * Where an email goes. Every address it was delivered to (the provider's to,
 * cc, bcc and received_for, then the To and Cc headers, in that order) is
 * looked up, case-insensitively, against inbox routing addresses and enabled
 * project addresses. A forwarded message usually names only the public
 * address in its headers; the routing address then arrives in received_for
 * (the `for` clause of the receiving server's Received header). Public
 * addresses never match: mail for an unknown routing address, a disabled
 * project address, or a disabled inbox is not stored.
 *
 * Each matched inbox takes the email once. When project addresses match, the
 * one that comes first in that recipient order decides the project for its
 * inbox; others for the same inbox are ignored, and an inbox's own routing
 * address never outranks a project address (it names no project). Project
 * addresses on different inboxes each deliver a copy with their own project.
 */
async function matchInboxes(supabase: SupabaseClient, prepared: PreparedEmail): Promise<InboxTarget[]> {
  const headerAddresses = prepared.recipients.filter((r) => r.kind === 'to' || r.kind === 'cc').map((r) => r.address);
  const lookup = [...new Set([...prepared.deliveredTo, ...headerAddresses])];
  if (lookup.length === 0) return [];
  const [direct, addressed] = await Promise.all([
    supabase.from('email_inboxes').select(INBOX_COLUMNS).in('routing_address', lookup),
    supabase.from('email_project_addresses').select('id, project_id, inbox_id, routing_address, public_address')
      .in('routing_address', lookup).eq('enabled', true),
  ]);
  if (direct.error) throw direct.error;
  if (addressed.error) throw addressed.error;
  const rank = (address: string) => lookup.indexOf(address);
  const projectAddresses = ((addressed.data ?? []) as ProjectAddressRow[]).sort((a, b) => rank(a.routing_address) - rank(b.routing_address));

  const inboxes = new Map(((direct.data ?? []) as InboxRow[]).map((inbox) => [inbox.id, inbox]));
  const missing = [...new Set(projectAddresses.map((row) => row.inbox_id))].filter((id) => !inboxes.has(id));
  if (missing.length) {
    const { data, error } = await supabase.from('email_inboxes').select(INBOX_COLUMNS).in('id', missing);
    if (error) throw error;
    for (const inbox of (data ?? []) as InboxRow[]) inboxes.set(inbox.id, inbox);
  }

  // Each inbox in the order its first matching address appears.
  const targets = new Map<string, { target: InboxTarget; position: number }>();
  const reach = (inbox: InboxRow | undefined, position: number, projectAddress: ProjectAddressRow | null) => {
    if (!inbox?.enabled) return;
    const existing = targets.get(inbox.id);
    if (!existing) {
      targets.set(inbox.id, { target: { inbox, projectAddress }, position });
      return;
    }
    existing.position = Math.min(existing.position, position);
    if (!existing.target.projectAddress && projectAddress) existing.target.projectAddress = projectAddress;
  };
  for (const row of projectAddresses) reach(inboxes.get(row.inbox_id), rank(row.routing_address), row);
  for (const inbox of (direct.data ?? []) as InboxRow[]) reach(inbox, rank(inbox.routing_address), null);
  return [...targets.values()].sort((a, b) => a.position - b.position).map((entry) => entry.target);
}

export async function ingestInbound(supabase: SupabaseClient, email: InboundEmail): Promise<IngestResult> {
  const prepared = prepareEmail(email, { trustedAuthservIds: trustedAuthservIds() });
  const targets = await matchInboxes(supabase, prepared);
  if (targets.length === 0) {
    // Logged only: there is no inbox to record it on, and nothing is stored.
    console.warn(`[inbound-email] no enabled inbox or project address for ${prepared.deliveredTo.join(', ') || 'no recipients'}`);
    return { kind: 'no_inbox', delivered_to: prepared.deliveredTo };
  }
  const outcomes: InboxOutcome[] = [];
  for (const { inbox, projectAddress } of targets) {
    try {
      outcomes.push(await ingestIntoInbox(supabase, inbox, projectAddress, email, prepared));
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
 * cut-off download must never be stored as the file). Downloads ask for
 * identity encoding; if a server compresses anyway, fetch decodes the body
 * and Content-Length counts the compressed bytes, so it is not compared.
 */
export async function readCapped(response: Response, cap: number): Promise<{ bytes: Buffer; sha256: string } | null> {
  const header = response.headers.get('content-length');
  const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
  const declared = header === null || (encoding !== '' && encoding !== 'identity') ? null : Number(header);
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

/**
 * Stores every file not stored yet. Each file is tried on its own, so one
 * that fails does not stop the others. When any failed, the run is counted
 * (email_files_failed): early on it throws so the provider retries; once
 * the files are given up on, they are skipped and the message completes.
 */
async function storeFiles(supabase: SupabaseClient, inbox: InboxRow, email: InboundEmail, started: StartRpcResult): Promise<void> {
  const message = started.message;
  // Each message names its file (fetchFile, upload).
  const failed: string[] = [];
  const failedAttachmentIds: string[] = [];
  let rawFailed = false;

  if (message.raw_storage_path && !message.raw_uploaded_at && email.raw) {
    let read: { bytes: Buffer; sha256: string } | null = null;
    try {
      read = await readCapped(await fetchFile(email.raw, 'raw message'), MAX_OBJECT_BYTES);
      if (read) await upload(supabase, message.raw_storage_path, read.bytes, 'message/rfc822');
    } catch (error) {
      rawFailed = true;
      failed.push((error as Error).message);
    }
    if (!rawFailed) {
      // Too large for the bucket (read null): the parsed bodies and attachments still stand.
      const { error } = await supabase.from('email_messages').update(read
        ? { raw_size_bytes: read.bytes.byteLength, raw_sha256: read.sha256, raw_uploaded_at: new Date().toISOString() }
        : { raw_storage_path: null }).eq('id', message.id);
      if (error) throw error;
    }
  } else if (message.raw_storage_path && !message.raw_uploaded_at && !email.raw) {
    const { error } = await supabase.from('email_messages').update({ raw_storage_path: null }).eq('id', message.id);
    if (error) throw error;
  }

  const cap = Math.min(inbox.max_attachment_mb * MIB, MAX_OBJECT_BYTES);
  for (const row of started.attachments) {
    if (!row.storage_path || row.uploaded_at) continue;
    let read: { bytes: Buffer; sha256: string } | null;
    try {
      // By the provider's id; for the same message delivered again under other
      // ids, by position when the filename agrees.
      const byPosition = email.attachments[row.position];
      const source = email.attachments.find((a) => a.provider_attachment_id && a.provider_attachment_id === row.provider_attachment_id)
        ?? (byPosition && (byPosition.filename ?? '') === row.filename ? byPosition : undefined);
      if (!source) throw new Error(`attachment ${row.position} is no longer offered by the provider`);
      read = await readCapped(await fetchFile(source.source, `attachment ${row.position}`), cap);
      if (read) await upload(supabase, row.storage_path, read.bytes, row.content_type);
    } catch (error) {
      failedAttachmentIds.push(row.id);
      failed.push((error as Error).message);
      continue;
    }
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
    const { error } = await supabase.from('email_attachments').update({
      size_bytes: read.bytes.byteLength,
      sha256: read.sha256,
      uploaded_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (error) throw error;
  }

  if (failed.length === 0) return;
  const summary = failed.join('; ');
  const { data, error } = await supabase.rpc('email_files_failed', {
    p_message_id: message.id,
    p_attachment_ids: failedAttachmentIds,
    p_raw: rawFailed,
    p_max_failures: FILE_GIVE_UP_FAILURES,
    p_max_age_minutes: FILE_GIVE_UP_AGE_MINUTES,
  });
  if (error) throw error;
  const outcome = data as { receiving: boolean; gave_up: boolean; failures: number };
  if (!outcome.gave_up) throw new Error(summary);
  // Delivered without those files: the thread shows them as not stored, and
  // the inbox status says why.
  const what = failedAttachmentIds.length === 0 ? 'its original .eml' : failedAttachmentIds.length === 1 ? '1 attachment' : `${failedAttachmentIds.length} attachments`;
  await recordInboxError(supabase, inbox.id, `An email arrived without ${what} after ${outcome.failures} failed tries (${summary})`);
}

async function ingestIntoInbox(
  supabase: SupabaseClient,
  inbox: InboxRow,
  projectAddress: ProjectAddressRow | null,
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

  // While the inbox is not verified, a verification email proves the route
  // works and is then deleted, files first (a retried run may have stored
  // some), then the row. Once verified, the code is ordinary text.
  if (!inbox.verified_at && prepared.message.subject.toUpperCase().includes(inbox.verification_code.toUpperCase())) {
    const now = new Date().toISOString();
    const { error: verifyError } = await supabase.from('email_inboxes').update({ verified_at: now, last_received_at: now }).eq('id', inbox.id);
    if (verifyError) throw verifyError;
    if (projectAddress) {
      // It came through a project address, which is connected too.
      const { error: addressError } = await supabase.from('email_project_addresses').update({ last_received_at: now }).eq('id', projectAddress.id);
      if (addressError) throw addressError;
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
  return finalize(supabase, inbox, projectAddress, messageId, prepared, email);
}

/** A response body's first `limit` bytes; the rest is never read. */
async function readHead(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

/**
 * The original sender of a forward attached whole (the first message/rfc822
 * or .eml attachment): its From header, read from the stored copy, else
 * from the provider. Null when there is none or it cannot be read; the
 * email then routes as a teammate's own.
 */
async function attachedForwardSender(supabase: SupabaseClient, messageId: string, email: InboundEmail): Promise<ForwardedSender | null> {
  const { data, error } = await supabase.from('email_attachments')
    .select('position, filename, content_type, provider_attachment_id, storage_path, uploaded_at')
    .eq('message_id', messageId).order('position');
  if (error) throw error;
  const row = ((data ?? []) as { position: number; filename: string; content_type: string; provider_attachment_id: string | null; storage_path: string | null; uploaded_at: string | null }[])
    .find((attachment) => isAttachedMessage(attachment.content_type, attachment.filename));
  if (!row) return null;
  try {
    if (row.storage_path && row.uploaded_at) {
      const stored = await supabase.storage.from(INBOUND_EMAIL_BUCKET).download(row.storage_path);
      if (stored.error) throw stored.error;
      return fromRfc822Head(new Uint8Array(await stored.data.slice(0, ATTACHED_HEAD_BYTES).arrayBuffer()));
    }
    const source = email.attachments.find((a) => a.provider_attachment_id && a.provider_attachment_id === row.provider_attachment_id)
      ?? email.attachments[row.position];
    if (!source) return null;
    return fromRfc822Head(await readHead(await fetchFile(source.source, `attachment ${row.position}`), ATTACHED_HEAD_BYTES));
  } catch (readError) {
    console.warn(`[inbound-email] could not read the forwarded message attached to ${messageId}`, readError);
    return null;
  }
}

type RoutingBasis = 'sender' | 'forwarded_original' | 'team_recipients';

interface TeamMemberRow {
  id: string;
  email: string | null;
  role: string;
  status: string;
}

async function finalize(
  supabase: SupabaseClient,
  inbox: InboxRow,
  projectAddress: ProjectAddressRow | null,
  messageId: string,
  prepared: PreparedEmail,
  email: InboundEmail,
): Promise<InboxOutcome> {
  const [{ data: message, error: messageError }, inboxRows, projectAddressRows, memberRows] = await Promise.all([
    supabase.from('email_messages')
      .select('id, subject_normalized, in_reply_to, reference_ids, received_at, auto_mail_reason')
      .eq('id', messageId)
      .single(),
    supabase.from('email_inboxes').select('address, routing_address'),
    supabase.from('email_project_addresses').select('routing_address, public_address'),
    supabase.from('team_members').select('id, email, role, status'),
  ]);
  if (messageError) throw messageError;
  if (inboxRows.error) throw inboxRows.error;
  if (projectAddressRows.error) throw projectAddressRows.error;
  if (memberRows.error) throw memberRows.error;

  // Ours, never clients: every inbox's addresses and every project address.
  const inboxAddresses = new Set([
    inbox.address,
    inbox.routing_address,
    ...((inboxRows.data ?? []) as { address: string; routing_address: string }[]).flatMap((row) => [row.address, row.routing_address]),
    ...((projectAddressRows.data ?? []) as { routing_address: string; public_address: string | null }[])
      .flatMap((row) => [row.routing_address, row.public_address ?? '']),
  ].filter(Boolean).map((address) => address.toLowerCase()));
  // And the team's: never shared participants, never the client a teammate wrote to.
  const members = (memberRows.data ?? []) as TeamMemberRow[];
  const teamAddresses = new Set(members.map((member) => (member.email ?? '').trim().toLowerCase()).filter(Boolean));
  const fromAddress = prepared.fromAddress;
  const isClient = (address: string) => !inboxAddresses.has(address) && !teamAddresses.has(address);

  // Routing. The visible sender decides, unless it is a verified teammate (an
  // active person, not an agent, with trusted sender auth): then a forward
  // routes by its original sender (one layer deep), and anything else, a
  // teammate's own email copied to the inbox, by the client addresses it went to.
  const teamSender = fromAddress && prepared.message.auth.trust === 'trusted'
    ? members.find((member) => member.role !== 'agent' && member.status === 'active' && (member.email ?? '').trim().toLowerCase() === fromAddress) ?? null
    : null;
  let basis: RoutingBasis = 'sender';
  let original: ForwardedSender | null = null;
  let mappingAddresses: string[] = fromAddress && !inboxAddresses.has(fromAddress) ? [fromAddress] : [];
  if (teamSender) {
    original = inlineForwardedSender(prepared.message.subject, readableBody(prepared.message.text_body, prepared.message.html_body))
      ?? await attachedForwardSender(supabase, messageId, email);
    if (original) {
      basis = 'forwarded_original';
      mappingAddresses = inboxAddresses.has(original.address) ? [] : [original.address];
    } else {
      basis = 'team_recipients';
      mappingAddresses = [...new Set(prepared.recipients.filter((row) => (row.kind === 'to' || row.kind === 'cc') && isClient(row.address)).map((row) => row.address))];
    }
  }
  const people = [...new Set([
    ...prepared.recipients.map((row) => row.address).filter((address) => !inboxAddresses.has(address)),
    ...mappingAddresses,
  ])];

  // Mapping: every contact that has a mapping address, its domain, and the exact address on a project.
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
  const senderContactIds = [...new Set(mappingAddresses.flatMap((address) => [...(contactsByAddress.get(address) ?? [])]))];
  const mappingDomains = [...new Set(mappingAddresses.flatMap((address) => [domainOf(address), organizationalDomain(domainOf(address))]))];
  const [contactProjects, domainProjects, senderProjects] = await Promise.all([
    senderContactIds.length
      ? supabase.from('project_contacts').select('project_id').in('contact_id', senderContactIds)
      : Promise.resolve({ data: [], error: null }),
    mappingDomains.length
      ? supabase.from('email_client_domains').select('project_id').in('domain', mappingDomains)
      : Promise.resolve({ data: [], error: null }),
    mappingAddresses.length
      ? supabase.from('email_client_addresses').select('project_id').in('address', mappingAddresses)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contactProjects.error) throw contactProjects.error;
  if (domainProjects.error) throw domainProjects.error;
  if (senderProjects.error) throw senderProjects.error;
  const projectIdsOf = (result: { data: unknown }) => ((result.data ?? []) as { project_id: string }[]).map((row) => row.project_id);
  const everyProject = [...new Set([...projectIdsOf(contactProjects), ...projectIdsOf(domainProjects), ...projectIdsOf(senderProjects)])];
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
    senderProjectIds: projectIdsOf(senderProjects).filter((id) => live.has(id)),
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
        .filter((row) => row.thread_id === thread.id && isClient(row.address))
        .map((row) => row.address),
    }));
  }
  // Inbox and team addresses are on nearly every thread, so they never count as shared.
  const choice = chooseThread({
    referenced: (referenced ?? []) as { thread_id: string; received_at: string }[],
    subjectNormalized: message.subject_normalized,
    subjectThreads,
    participants: people.filter(isClient),
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
      ...threadProjectDecision(joinedThread, mapping, projectAddress),
      received_via_address_id: projectAddress?.id ?? null,
      routing_basis: basis,
      forwarded_by_member_id: teamSender?.id ?? null,
      original_from_address: original?.address ?? null,
      original_from_name: original?.name ?? null,
      candidates: mapping.candidates,
      recipient_contacts: recipientContacts,
    },
  });
  if (completeError) throw completeError;
  const result = completed as { already_complete: boolean; status: string; thread_id: string };
  if (result.already_complete) return { inbox_id: inbox.id, email_id: messageId, outcome: 'already_complete', status: result.status };
  return { inbox_id: inbox.id, email_id: messageId, outcome: 'completed', status: result.status, thread_id: result.thread_id };
}
