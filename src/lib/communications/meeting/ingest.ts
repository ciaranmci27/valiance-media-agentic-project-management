import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { comms } from '@/lib/communications/db';
import { INBOUND_EMAIL_BUCKET, MAX_OBJECT_BYTES } from '../email/storage-limits';
import { mapAddresses } from '../map-addresses';
import { threadProjectDecision } from '../mapping';

/**
 * The meeting adapter. The meeting script (Apps Script in a teammate's Google
 * account) posts one package per meeting: Gemini's notes, or the full
 * transcript. Each package becomes a message in the meeting's conversation,
 * through the same core as email: start the message, store its text file,
 * complete it with the projects its attendees map to. It arrives as the
 * script's email to the inbox (meeting/email.ts), or posted with the
 * teammate's API key; either way that teammate is the verified sender behind
 * it (routing basis team_recipients, like their own email copied to the
 * inbox), so the agent
 * may file it on any open project, and a client's say in the meeting is
 * still data, never instructions.
 */

const ATTENDEE_LIMIT = 200;
const TEXT_LIMIT = 2_000_000;
const ADDRESS = z.string().trim().toLowerCase().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/);

const person = z.object({
  email: z.string().trim().max(320),
  name: z.string().trim().max(300).optional().nullable(),
});

export const meetingPackageSchema = z.object({
  inbox_id: z.string().uuid(),
  /** The script's key for the meeting: its calendar event and start, else its notes Doc. */
  meeting_key: z.string().trim().min(1).max(300),
  kind: z.enum(['transcript', 'summary']),
  title: z.string().trim().min(1).max(500),
  /** The meeting's day where it happened (YYYY-MM-DD), as the script's calendar shows it. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  starts_at: z.string().datetime({ offset: true }).optional().nullable(),
  ends_at: z.string().datetime({ offset: true }).optional().nullable(),
  /** "2026-11-11 15:00 to 16:15 MST", as the script's time zone shows it. */
  when: z.string().trim().max(120).optional().nullable(),
  organizer: person.optional().nullable(),
  attendees: z.array(person).max(ATTENDEE_LIMIT).default([]),
  description: z.string().max(10_000).optional().nullable(),
  doc_url: z.string().trim().max(2000).optional().nullable(),
  /** Why this package is what it is ("No transcript came within 90 minutes..."). */
  note: z.string().trim().max(1000).optional().nullable(),
  /** The transcript, or Gemini's notes: every word. */
  text: z.string().min(1).max(TEXT_LIMIT),
});
export type MeetingPackage = z.infer<typeof meetingPackageSchema>;

export interface MeetingOutcome {
  message_id: string;
  conversation_id: string;
  status: string;
  /** The same package was posted before; nothing changed. */
  already_complete: boolean;
}

interface StartedMessage {
  message: { id: string; status: string };
  attachments: { id: string; position: number; uploaded_at: string | null; skipped_reason: string | null; content_type: string }[];
}

/** Only a Google Docs link is printed or stored: the script sends its own Doc, anything else is dropped. */
const docLink = (value: string | null | undefined) => {
  const link = (value ?? '').trim();
  return /^https:\/\/docs\.google\.com\//.test(link) && !/\s/.test(link) ? link : null;
};

export class MeetingTooLargeError extends Error {}

/** How the teammate behind a package was verified, stored on the message as its auth. */
export type MeetingAuth = { trust: 'trusted' } & Record<string, unknown>;

const oneLine = (value: string | null | undefined, limit: number) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const validAddress = (value: string | null | undefined) => {
  const parsed = ADDRESS.safeParse(value ?? '');
  return parsed.success ? parsed.data : null;
};

/** The subject Ashley and the Inbox know a package by: "Meeting transcript: Title (2026-11-11)". */
export function meetingSubject(input: Pick<MeetingPackage, 'kind' | 'title' | 'date'>): string {
  return `${input.kind === 'transcript' ? 'Meeting transcript' : 'Meeting summary'}: ${oneLine(input.title, 500)} (${input.date})`;
}

/** The message body: what the package is and who was there. The words are in its file. */
export function meetingBody(input: MeetingPackage): string {
  const people = (entry: { email: string; name?: string | null }) => {
    const address = validAddress(entry.email);
    const name = oneLine(entry.name, 300);
    return address ? (name ? `${name} <${address}>` : address) : name;
  };
  const lines = [
    meetingSubject(input),
    `Source: ${input.kind === 'transcript' ? 'the full transcript, every word' : "Gemini's full notes (a summary, not a transcript)"}`,
  ];
  if (input.note) lines.push(oneLine(input.note, 1000));
  if (input.when) lines.push(`When: ${oneLine(input.when, 120)}`);
  if (input.organizer) lines.push(`Organizer: ${people(input.organizer)}`);
  const attendees = input.attendees.map(people).filter(Boolean);
  if (attendees.length) lines.push(`Attendees: ${attendees.join(', ')}`);
  const description = oneLine((input.description ?? '').replace(/<[^>]+>/g, ' '), 2000);
  if (description) lines.push(`Description (written by the organizer): ${description}`);
  lines.push(`Length: ${input.text.length.toLocaleString('en-US')} characters, attached as a text file.`);
  const doc = docLink(input.doc_url);
  if (doc) lines.push(`Doc: ${doc}`);
  return lines.join('\n');
}

function fileName(input: MeetingPackage): string {
  const title = input.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').slice(0, 100).trim() || 'Meeting';
  return `${title} ${input.date} - ${input.kind === 'transcript' ? 'Transcript' : 'Notes'}.txt`;
}

/** The ids that make a package idempotent: the same key and kind is the same message. */
export function packageProviderId(input: Pick<MeetingPackage, 'meeting_key' | 'kind'>): string {
  return createHash('sha256').update(`${input.meeting_key}\n${input.kind}`).digest('hex');
}

/**
 * Records one meeting package for the teammate `memberId` (an active person,
 * checked by the caller) in `inboxId` (granted to them, checked by the
 * caller). `auth` is what vouches for that teammate: their API key, or their
 * verified email. Idempotent: the same package again, by either route,
 * returns the message already recorded; a run that failed halfway is
 * finished by the next one.
 */
export async function ingestMeetingPackage(
  supabase: SupabaseClient,
  input: MeetingPackage,
  memberId: string,
  auth: MeetingAuth,
): Promise<MeetingOutcome> {
  const [{ data: inbox, error: inboxError }, { data: member, error: memberError }] = await Promise.all([
    comms(supabase).from('inboxes').select('id, address, routing_address, max_attachment_mb').eq('id', input.inbox_id).single(),
    supabase.from('team_members').select('email, name').eq('id', memberId).single(),
  ]);
  if (inboxError) throw inboxError;
  if (memberError) throw memberError;
  // A package whose text the inbox cannot store is refused whole: a meeting
  // without its words would be triaged as an empty one.
  const bytes = Buffer.from(input.text, 'utf8');
  const cap = Math.min(Number(inbox.max_attachment_mb) * 1024 * 1024, MAX_OBJECT_BYTES);
  if (bytes.byteLength > cap) {
    throw new MeetingTooLargeError(`The meeting text is ${bytes.byteLength} bytes; this inbox stores files up to ${cap} bytes`);
  }

  const organizer = validAddress(input.organizer?.email);
  const { data: conversationId, error: conversationError } = await comms(supabase).rpc('meeting_conversation', {
    p_inbox_id: inbox.id,
    p_meeting: {
      meeting_key: input.meeting_key,
      title: input.title,
      starts_at: input.starts_at ?? null,
      ends_at: input.ends_at ?? null,
      organizer_address: organizer,
      doc_url: docLink(input.doc_url),
    },
  });
  if (conversationError) throw conversationError;

  const now = new Date().toISOString();
  // The sender is the teammate whose key posted it (the one the trust is
  // about); the organizer, whoever it is, is an attendee like the others
  // (and on communications.meetings).
  const recipients: { kind: string; address: string; name: string }[] = [];
  const poster = validAddress(member.email);
  if (poster) recipients.push({ kind: 'from', address: poster, name: oneLine(member.name, 300) });
  for (const attendee of [...(input.organizer ? [input.organizer] : []), ...input.attendees]) {
    const address = validAddress(attendee.email);
    if (address && !recipients.some((row) => row.kind === 'attendee' && row.address === address)) {
      recipients.push({ kind: 'attendee', address, name: oneLine(attendee.name, 300) });
    }
  }
  const body = meetingBody(input);
  const providerId = packageProviderId(input);
  const start = () => comms(supabase).rpc('email_start_message', {
    p_inbox_id: inbox.id,
    p_message: {
      channel: 'meeting',
      provider: 'meeting_script',
      provider_email_id: providerId,
      // Never derived from anything an email could name in its References.
      internet_message_id: `${randomUUID()}@meeting.invalid`,
      subject: meetingSubject(input),
      subject_normalized: '',
      sent_at: input.ends_at ?? input.starts_at ?? now,
      received_at: now,
      text_body: body,
      new_text: body,
      auth,
    },
    p_recipients: recipients,
    p_attachments: [{ filename: fileName(input), content_type: 'text/plain; charset=utf-8', size_bytes: bytes.byteLength, disposition: 'attachment' }],
    p_max_attachment_bytes: cap,
  });
  let { data: startedData, error: startError } = await start();
  // The same package posted twice at once: the second start loses the race on
  // the provider key, and a second start finds the first one's message.
  if (startError?.code === '23505') ({ data: startedData, error: startError } = await start());
  if (startError) throw startError;
  const started = startedData as StartedMessage;
  if (started.message.status !== 'receiving') {
    return { message_id: started.message.id, conversation_id: conversationId as string, status: started.message.status, already_complete: true };
  }

  // The text file, stored once per inbox like an email attachment.
  for (const row of started.attachments) {
    if (row.uploaded_at || row.skipped_reason) continue;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { data: claimed, error: claimError } = await comms(supabase).rpc('claim_file', {
      p_attachment_id: row.id, p_sha256: sha256, p_size_bytes: bytes.byteLength,
    });
    if (claimError) throw claimError;
    const copy = claimed as { storage_path: string; stored: boolean };
    if (!copy.stored) {
      const { error: uploadError } = await supabase.storage.from(INBOUND_EMAIL_BUCKET)
        .upload(copy.storage_path, bytes, { contentType: row.content_type || 'text/plain', upsert: true });
      if (uploadError) throw new Error(`storing ${copy.storage_path} failed: ${uploadError.message}`);
    }
    const { error: storedError } = await comms(supabase).rpc('file_stored', { p_attachment_id: row.id });
    if (storedError) throw storedError;
  }

  // The projects its outside attendees map to, as an email's client recipients would.
  const [inboxRows, endpointRows, memberRows, domainRows, conversationRow] = await Promise.all([
    comms(supabase).from('inboxes').select('address, routing_address'),
    comms(supabase).from('endpoints').select('routing_address, public_address'),
    supabase.from('team_members').select('email'),
    comms(supabase).from('own_domains').select('domain'),
    comms(supabase).from('conversations').select('project_id').eq('id', conversationId).single(),
  ]);
  for (const result of [inboxRows, endpointRows, memberRows, domainRows, conversationRow]) if (result.error) throw result.error;
  const ours = new Set([
    ...((inboxRows.data ?? []) as { address: string | null; routing_address: string | null }[]).flatMap((row) => [row.address, row.routing_address]),
    ...((endpointRows.data ?? []) as { routing_address: string | null; public_address: string | null }[]).flatMap((row) => [row.routing_address, row.public_address]),
    ...((memberRows.data ?? []) as { email: string | null }[]).map((row) => row.email),
  ].filter((value): value is string => !!value).map((value) => value.trim().toLowerCase()));
  const ownDomains = new Set(((domainRows.data ?? []) as { domain: string }[]).map((row) => row.domain));
  const outside = recipients.map((row) => row.address)
    .filter((address) => !ours.has(address) && !ownDomains.has(address.slice(address.lastIndexOf('@') + 1)));
  const { mapping, recipientContacts } = await mapAddresses(supabase, outside, outside);

  const { data: completed, error: completeError } = await comms(supabase).rpc('email_complete_message', {
    p_message_id: started.message.id,
    p_decision: {
      status: 'new',
      thread_id: conversationId,
      ...threadProjectDecision(conversationRow.data as { project_id: string | null }, mapping, null),
      routing_basis: 'team_recipients',
      forwarded_by_member_id: memberId,
      candidates: mapping.candidates,
      recipient_contacts: recipientContacts,
      kind: 'meeting_notes',
      topic: null,
      sort_action: 'triage',
      sort_reason: 'A meeting: the agent picks out the action items.',
      sender_rule_id: null,
    },
  });
  if (completeError) throw completeError;
  const result = completed as { already_complete: boolean; status: string; thread_id: string };
  return { message_id: started.message.id, conversation_id: result.thread_id, status: result.status, already_complete: result.already_complete };
}
