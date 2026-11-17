import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { accessAllows, resolveMemberAccess } from '@/lib/api/access';
import { comms } from '@/lib/communications/db';
import type { InboundAttachment, InboundEmail } from '../email/normalized';
import { readableBody, type PreparedEmail } from '../email/prepare';
import { verifiedTeamSender, type TeamMemberRow } from '../email/team-sender';
import { meetingPackageSchema, meetingSubject, type MeetingPackage } from './ingest';

/**
 * Meetings by email. The meeting script emails each package to the inbox like
 * any teammate's email: a readable body, the transcript or notes as a text
 * file, and the meeting's details (title, times, attendees, Doc) in a block
 * the app reads. Such an email becomes a meeting, not an email, only when all
 * of these hold, so nothing here names a person or an address:
 *   1. the sender's authentication is trusted (DMARC, or DKIM aligned with From);
 *   2. the sender is an active teammate, not an agent;
 *   3. the inbox it landed in is one that teammate can read in the app;
 *   4. the block is well formed, the subject is the one the script writes for
 *      it, and the file it names is attached.
 * Anything else (an outsider, a forward, a broken block) stays an ordinary
 * email. The same package arriving again, by email or the API, is the same
 * message.
 */

export const MEETING_BLOCK_BEGIN = '-----BEGIN PM MEETING-----';
export const MEETING_BLOCK_END = '-----END PM MEETING-----';
/** Far above any real block (200 attendees and a 10k description encode to about 40k). */
const BLOCK_LIMIT = 100_000;

export const meetingEmailSchema = meetingPackageSchema
  .omit({ inbox_id: true, text: true })
  .extend({
    v: z.literal(1),
    /** The attached file holding every word. */
    file: z.string().trim().min(1).max(300),
  });
export type MeetingEmailData = z.infer<typeof meetingEmailSchema>;

/**
 * The meeting details in an email body: base64 JSON between the markers,
 * line breaks and spaces ignored (mail may wrap it). Only the block that
 * ends the body counts: the script writes it last, and text above it (a
 * title, the organizer's calendar description) can be written by someone
 * outside, so a block pasted there is never read. Null when absent or not
 * exactly what the script writes.
 */
export function parseMeetingBlock(body: string): MeetingEmailData | null {
  const start = body.lastIndexOf(MEETING_BLOCK_BEGIN);
  if (start < 0) return null;
  const end = body.indexOf(MEETING_BLOCK_END, start);
  if (end < 0 || body.slice(end + MEETING_BLOCK_END.length).trim() !== '') return null;
  const encoded = body.slice(start + MEETING_BLOCK_BEGIN.length, end).replace(/\s+/g, '');
  if (!encoded || encoded.length > BLOCK_LIMIT || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const parsed = meetingEmailSchema.safeParse(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface MeetingEmail {
  member: TeamMemberRow;
  data: MeetingEmailData;
  file: InboundAttachment;
}

/**
 * The meeting this email carries, when its block, subject and file are the
 * script's and its sender is a verified teammate (checks 1, 2 and 4). Which
 * inboxes take it as a meeting is checked per inbox (memberCanReadInbox).
 */
export async function meetingEmailOf(supabase: SupabaseClient, email: InboundEmail, prepared: PreparedEmail): Promise<MeetingEmail | null> {
  const data = parseMeetingBlock(readableBody(prepared.message.text_body, prepared.message.html_body));
  if (!data) return null;
  // A forward or reply quoting the block has a subject of its own.
  const words = (value: string) => value.replace(/\s+/g, ' ').trim();
  if (words(prepared.message.subject) !== words(meetingSubject(data))) return null;
  const file = email.attachments.find((attachment) => (attachment.filename ?? '').trim() === data.file);
  if (!file) return null;
  if (prepared.message.auth.trust !== 'trusted' || !prepared.fromAddress) return null;
  const [memberRows, addressRows] = await Promise.all([
    supabase.from('team_members').select('id, email, role, status'),
    comms(supabase).from('endpoints').select('public_address, owner_member_id').not('owner_member_id', 'is', null),
  ]);
  if (memberRows.error) throw memberRows.error;
  if (addressRows.error) throw addressRows.error;
  const addresses = (addressRows.data ?? []) as { public_address: string | null; owner_member_id: string }[];
  const ownerOf = (address: string) => addresses.find((row) => row.public_address === address)?.owner_member_id ?? null;
  const member = verifiedTeamSender((memberRows.data ?? []) as TeamMemberRow[], prepared.fromAddress, prepared.message.auth.trust, ownerOf);
  return member ? { member, data, file } : null;
}

/** Whether the teammate can read the inbox in the app, as the Inbox decides it (can_read_inbox). */
export async function memberCanReadInbox(supabase: SupabaseClient, memberId: string, inboxId: string): Promise<boolean> {
  const access = await resolveMemberAccess(supabase, memberId);
  if (!access) return false;
  if (accessAllows(access, 'inbound_email.manage', 'app')) return true;
  if (!accessAllows(access, 'inbound_email.read', 'app')) return false;
  const { data, error } = await comms(supabase).from('inbox_access').select('inbox_id')
    .eq('inbox_id', inboxId).eq('member_id', memberId).maybeSingle();
  if (error) throw error;
  return !!data;
}

/** The package for one inbox, with the attached file's words; null when they do not make a valid package. */
export function meetingPackageFromEmail(data: MeetingEmailData, inboxId: string, text: string): MeetingPackage | null {
  // The schema drops the block's own fields (v, file) as unknown keys.
  const parsed = meetingPackageSchema.safeParse({ ...data, inbox_id: inboxId, text: text.replace(/\u0000/g, '') });
  return parsed.success ? parsed.data : null;
}
