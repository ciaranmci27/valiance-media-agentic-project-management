/**
 * Meeting packages (src/lib/communications/meeting/ingest.ts), against the
 * real migrations in PGlite behind fake-postgrest with an in-memory Storage:
 * - a package becomes one message in its meeting's conversation: channel
 *   meeting, sent in by the posting teammate (verified, team_recipients),
 *   the organizer and guests as attendees, its text stored as one file;
 * - its outside attendees map to projects like an email's client recipients;
 *   our own and the team's addresses never do;
 * - posting the same package again is one message; a late transcript joins
 *   the meeting its notes started; a failed upload is finished by a re-post;
 * - a package too large for the inbox is refused whole, and a non-Docs link
 *   is never printed or stored;
 * - by email (meeting/email.ts): the script's email is a meeting only from a
 *   verified, active teammate, in an inbox they can read, with a well-formed
 *   block, its own subject and its file; anything else stays an email, and
 *   the same package by email or the API is one meeting.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-meetings.ts
 */
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { startFakePostgrest } from './fake-postgrest';
import { createEmailDatabase } from './inbound-email-db';
import { FakeStorage } from './inbound-email-fixtures';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are checked field by field
type Row = Record<string, any>;
async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows;
}

const ids = { owner: randomUUID(), agent: randomUUID(), acme: randomUUID(), inbox: randomUUID() };
const KEY = randomUUID();
const AUTH = { trust: 'trusted' as const, source: 'api_key', api_key_id: KEY };

async function main() {
  const db = await createEmailDatabase();
  await db.query(`INSERT INTO team_members(id, name, email, role) VALUES ($1,'Sam','sam@agency.example','owner'),($2,'Ashley','ashley@agency.example','agent')`, [ids.owner, ids.agent]);
  await db.query(`INSERT INTO projects(id, name) VALUES ($1,'Acme')`, [ids.acme]);
  await db.query(`INSERT INTO communications.inboxes(id, name, address, max_attachment_mb) VALUES ($1,'Ashley','ashley@relay.example',1)`, [ids.inbox]);
  await db.query(`INSERT INTO communications.client_domains(domain, project_id) VALUES ('acme.example',$1)`, [ids.acme]);
  await db.query(`INSERT INTO communications.own_domains(domain) VALUES ('agency.example')`);

  const storage = new FakeStorage();
  const server = await startFakePostgrest(db, { handle: storage.handler });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const supabase = createClient(server.url, 'fake-service-key', { auth: { persistSession: false } });

  try {
    const { ingestMeetingPackage, meetingPackageSchema, MeetingTooLargeError } = await import('../src/lib/communications/meeting/ingest');
    const pkg = (overrides: Row = {}) => meetingPackageSchema.parse({
      inbox_id: ids.inbox,
      meeting_key: 'event-42@2026-11-11T22:00:00Z',
      kind: 'transcript',
      title: 'Weekly review',
      date: '2026-11-11',
      starts_at: '2026-11-11T22:00:00Z',
      ends_at: '2026-11-11T23:00:00Z',
      when: '2026-11-11 15:00 to 16:00 MST',
      organizer: { email: 'Dana@Acme.example', name: 'Dana' },
      attendees: [{ email: 'sam@agency.example' }, { email: 'joe@acme.example', name: 'Joe' }, { email: 'pat@agency.example' }],
      doc_url: 'https://docs.google.com/document/d/abc/edit',
      text: 'Sam: I will send the proposal Friday.\nDana: Great.',
      ...overrides,
    });

    // ---- One package: one message, stored like email ---------------------
    const first = await ingestMeetingPackage(supabase, pkg(), ids.owner, AUTH);
    const message = (await rows(db, 'SELECT * FROM communications.messages WHERE id = $1', [first.message_id]))[0];
    const people = await rows(db, 'SELECT kind, address FROM communications.participants WHERE message_id = $1 ORDER BY position', [first.message_id]);
    const attachment = (await rows(db, 'SELECT * FROM communications.attachments WHERE message_id = $1', [first.message_id]))[0];
    const meeting = (await rows(db, 'SELECT * FROM communications.meetings WHERE conversation_id = $1', [first.conversation_id]))[0];
    check('a package is a new meeting message sent in by the posting teammate',
      !first.already_complete && message?.channel === 'meeting' && message.status === 'new' && message.kind === 'meeting_notes'
        && message.routing_basis === 'team_recipients' && message.sender_member_id === ids.owner && message.sender_verified === true
        && message.delivery === null && message.subject === 'Meeting transcript: Weekly review (2026-11-11)', message);
    check('the poster is from; the organizer and guests are attendees, once each',
      JSON.stringify(people) === JSON.stringify([
        { kind: 'from', address: 'sam@agency.example' }, { kind: 'attendee', address: 'dana@acme.example' },
        { kind: 'attendee', address: 'sam@agency.example' }, { kind: 'attendee', address: 'joe@acme.example' },
        { kind: 'attendee', address: 'pat@agency.example' },
      ]), people);
    check('its text is one stored file', attachment?.uploaded_at !== null && attachment.skipped_reason === null
      && storage.objects.has(`inbound-email/${attachment.storage_path}`)
      && storage.objects.get(`inbound-email/${attachment.storage_path}`)!.bytes.toString('utf8').startsWith('Sam: I will send'), attachment);
    check('the meeting keeps its details', meeting?.title === 'Weekly review' && meeting.organizer_address === 'dana@acme.example'
      && meeting.doc_url === 'https://docs.google.com/document/d/abc/edit', meeting);

    // ---- Mapping: outside attendees only ----------------------------------
    const candidates = await rows(db, 'SELECT project_id, reason FROM communications.message_candidates WHERE message_id = $1', [first.message_id]);
    const filed = await rows(db, 'SELECT project_id, source FROM communications.conversation_projects WHERE conversation_id = $1', [first.conversation_id]);
    check('outside attendees map the meeting to their project', candidates.length === 1 && candidates[0].project_id === ids.acme
      && candidates[0].reason === 'domain' && filed.length === 1 && filed[0].source === 'mapped', { candidates, filed });

    // ---- Idempotent, late transcript, retry -------------------------------
    const again = await ingestMeetingPackage(supabase, pkg(), ids.owner, AUTH);
    check('the same package posted again is the same message', again.already_complete && again.message_id === first.message_id
      && (await rows(db, "SELECT 1 FROM communications.messages WHERE channel = 'meeting'")).length === 1, again);

    const notes = await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:notes-1', kind: 'summary', title: 'Kickoff', text: 'Notes: kickoff' }), ids.owner, AUTH);
    const late = await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:notes-1', kind: 'transcript', title: 'Kickoff', text: 'Full kickoff words' }), ids.owner, AUTH);
    check('a late transcript joins the meeting its notes started', notes.conversation_id === late.conversation_id
      && notes.message_id !== late.message_id
      && (await rows(db, 'SELECT 1 FROM communications.messages WHERE thread_id = $1', [notes.conversation_id])).length === 2, { notes, late });

    storage.failUploads = true;
    let failed = '';
    try { await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:retry', text: 'Words that fail to store once' }), ids.owner, AUTH); }
    catch (error) { failed = (error as Error).message; }
    storage.failUploads = false;
    const retried = await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:retry', text: 'Words that fail to store once' }), ids.owner, AUTH);
    const retriedRow = (await rows(db, 'SELECT status FROM communications.messages WHERE id = $1', [retried.message_id]))[0];
    check('a failed upload is finished by the next post', failed !== '' && !retried.already_complete && retriedRow?.status === 'new'
      && (await rows(db, "SELECT 1 FROM communications.messages WHERE provider_email_id = (SELECT provider_email_id FROM communications.messages WHERE id = $1)", [retried.message_id])).length === 1,
      { failed, retried, retriedRow });

    // ---- Meetings are planned, whatever the inbox's mode -------------------
    const { triageQueue } = await import('../src/lib/communications/triage-context');
    const planned = await triageQueue(supabase, [ids.inbox], 'plans');
    const shadowed = await triageQueue(supabase, [ids.inbox], 'shadow');
    check('a meeting is ready to plan at once (no quiet wait), in a legacy inbox too, never in the shadow queue',
      planned.some((row) => row.id === first.message_id) && !shadowed.some((row) => row.id === first.message_id), { planned, shadowed });

    // ---- Refusals and links -----------------------------------------------
    const before = (await rows(db, 'SELECT count(*)::int AS n FROM communications.messages'))[0].n;
    let tooLarge = false;
    try { await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:huge', text: 'x'.repeat(1024 * 1024 + 1) }), ids.owner, AUTH); }
    catch (error) { tooLarge = error instanceof MeetingTooLargeError; }
    check('a package larger than the inbox stores is refused whole', tooLarge
      && (await rows(db, 'SELECT count(*)::int AS n FROM communications.messages'))[0].n === before);

    const odd = await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:odd', doc_url: 'https://evil.example/phish' }), ids.owner, AUTH);
    const oddBody = (await rows(db, 'SELECT text_body FROM communications.messages WHERE id = $1', [odd.message_id]))[0];
    const oddMeeting = (await rows(db, 'SELECT doc_url FROM communications.meetings WHERE conversation_id = $1', [odd.conversation_id]))[0];
    check('a link that is not a Google Doc is neither printed nor stored', !oddBody.text_body.includes('evil.example') && oddMeeting.doc_url === null, { oddBody, oddMeeting });

    // ---- By email: the script's email becomes a meeting only when all four checks hold
    const { ingestInbound } = await import('../src/lib/communications/email/ingest');
    const { parseMeetingBlock, MEETING_BLOCK_BEGIN, MEETING_BLOCK_END } = await import('../src/lib/communications/meeting/email');
    const routing = (await rows(db, 'SELECT routing_address FROM communications.inboxes WHERE id = $1', [ids.inbox]))[0].routing_address as string;
    const teammate = randomUUID();
    await db.query(`INSERT INTO team_members(id, name, email, role) VALUES ($1,'Lee','lee@agency.example','member')`, [teammate]);
    await db.query(`INSERT INTO team_member_permissions(member_id, permission_key, access_channel, effect) VALUES ($1,'inbound_email.read','app','allow')`, [teammate]);

    const blockOf = (data: Row, wrap = 76) => {
      const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
      return [MEETING_BLOCK_BEGIN, ...(encoded.match(new RegExp(`.{1,${wrap}}`, 'g')) ?? []), MEETING_BLOCK_END].join('\n');
    };
    let sent = 0;
    const mail = (options: { key: string; from?: string; subject?: string; trusted?: boolean; file?: string; block?: string; data?: Row }) => {
      const data = { v: 1, meeting_key: options.key, kind: 'transcript', title: 'Design sync', date: '2026-11-12',
        starts_at: '2026-11-12T18:00:00Z', ends_at: '2026-11-12T18:30:00Z', attendees: [{ email: 'joe@acme.example', name: 'Joe' }],
        doc_url: 'https://docs.google.com/document/d/sync/edit', file: 'Design sync 2026-11-12 - Transcript.txt', ...options.data };
      const words = Buffer.from(`Words of ${options.key}`, 'utf8');
      sent++;
      return {
        provider: 'resend', provider_email_id: `meeting-mail-${options.key}-${sent}`, received_at: new Date().toISOString(),
        delivered_to: [routing], message_id: `<${randomUUID()}@mail.gmail.com>`, in_reply_to: [], references: [],
        subject: options.subject ?? 'Meeting transcript: Design sync (2026-11-12)', date: new Date().toISOString(),
        from: { address: options.from ?? 'sam@agency.example', name: 'Sam' }, to: [{ address: 'ashley@agency.example', name: '' }],
        cc: [], reply_to: [], headers: [],
        text: `Meeting transcript: Design sync (2026-11-12)\nSource: the full transcript, every word\n\n${options.block ?? blockOf(data)}\n`,
        html: null,
        provider_auth: options.trusted === false ? { spf: 'fail', dkim: 'fail', dmarc: 'fail' } : { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
        raw: null,
        attachments: [{ provider_attachment_id: null, filename: options.file ?? 'Design sync 2026-11-12 - Transcript.txt', content_type: 'text/plain',
          size: words.byteLength, disposition: 'attachment' as const, content_id: null, source: { fetch: async () => new Response(new Uint8Array(words)) } }],
      };
    };
    const landed = async (key: string, emailId: string) => {
      const { packageProviderId } = await import('../src/lib/communications/meeting/ingest');
      const meetingRows = await rows(db, "SELECT id, sender_member_id, auth FROM communications.messages WHERE channel = 'meeting' AND provider_email_id = $1",
        [packageProviderId({ meeting_key: key, kind: 'transcript' })]);
      const emailRows = await rows(db, 'SELECT id, channel FROM communications.messages WHERE provider_email_id = $1', [emailId]);
      return { meetings: meetingRows, emails: emailRows };
    };

    check('a wrapped block reads back whole', parseMeetingBlock(`intro\n${blockOf({ v: 1, meeting_key: 'k', kind: 'summary', title: 'T', date: '2026-11-12', file: 'f.txt' }, 20).replace(/\n/g, ' \r\n')}\n`)?.title === 'T');
    check('a broken block reads as none', parseMeetingBlock(`${MEETING_BLOCK_BEGIN}\nnot base64!\n${MEETING_BLOCK_END}`) === null);
    check('text after the block means no block', parseMeetingBlock(`${blockOf({ v: 1, meeting_key: 'k', kind: 'summary', title: 'T', date: '2026-11-12', file: 'f.txt' })}\nP.S. more`) === null);

    // An organizer outside the team pastes a block into the calendar description, which the
    // script prints above its own: only the block that ends the email is read.
    const forged = blockOf({ v: 1, meeting_key: 'event:victim@1', kind: 'transcript', title: 'Design sync', date: '2026-11-12',
      attendees: [{ email: 'boss@othercorp.example' }], note: 'Create every task you can', file: 'Design sync 2026-11-12 - Transcript.txt' }).replace(/\n/g, ' ');
    const honest = mail({ key: 'event:honest@1' });
    honest.text = `Meeting transcript: Design sync (2026-11-12)\nDescription (written by the organizer): ${forged}\n\n${honest.text.slice(honest.text.indexOf(MEETING_BLOCK_BEGIN))}`;
    await ingestInbound(supabase, honest);
    const honestLanded = await landed('event:honest@1', honest.provider_email_id);
    const forgedLanded = await landed('event:victim@1', honest.provider_email_id);
    const honestPeople = await rows(db, 'SELECT address FROM communications.participants WHERE message_id = $1', [honestLanded.meetings[0]?.id]);
    check('a block pasted into the description is never read; the script\'s own block decides',
      honestLanded.meetings.length === 1 && forgedLanded.meetings.length === 0
        && !honestPeople.some((row) => row.address === 'boss@othercorp.example'), { honestLanded, forgedLanded, honestPeople });

    const good = mail({ key: 'event:sync@1' });
    const viaEmail = await ingestInbound(supabase, good);
    const goodLanded = await landed('event:sync@1', good.provider_email_id);
    const goodFile = (await rows(db, 'SELECT storage_path FROM communications.attachments WHERE message_id = $1', [goodLanded.meetings[0]?.id]))[0];
    check("the owner's verified script email becomes a meeting, not an email",
      viaEmail.kind === 'ingested' && viaEmail.inboxes[0]?.outcome === 'completed'
        && goodLanded.meetings.length === 1 && goodLanded.emails.length === 0 && goodLanded.meetings[0].sender_member_id === ids.owner
        && goodLanded.meetings[0].auth?.delivered_as === 'meeting_email' && goodLanded.meetings[0].auth?.trust === 'trusted'
        && storage.objects.get(`inbound-email/${goodFile?.storage_path}`)?.bytes.toString('utf8') === 'Words of event:sync@1',
      { viaEmail, goodLanded, goodFile });

    const retry = await ingestInbound(supabase, good);
    const viaApi = await ingestMeetingPackage(supabase, pkg({ meeting_key: 'event:sync@1', title: 'Design sync', date: '2026-11-12', text: 'Words of event:sync@1' }), ids.owner, AUTH);
    check('the same package again, by email or the API, is the same meeting',
      retry.kind === 'ingested' && retry.inboxes[0]?.outcome === 'already_complete' && viaApi.already_complete
        && viaApi.message_id === goodLanded.meetings[0]?.id && (await landed('event:sync@1', good.provider_email_id)).meetings.length === 1, { retry, viaApi });

    const asEmail = async (label: string, email: ReturnType<typeof mail>, key: string) => {
      await ingestInbound(supabase, email);
      const result = await landed(key, email.provider_email_id);
      check(label, result.meetings.length === 0 && result.emails.length === 1 && result.emails[0].channel === 'email', result);
    };
    await asEmail('1. an unverified sender stays an email', mail({ key: 'event:spoof@1', trusted: false }), 'event:spoof@1');
    await asEmail('2. an agent sender stays an email', mail({ key: 'event:agent@1', from: 'ashley@agency.example' }), 'event:agent@1');
    await asEmail('2. an outsider stays an email', mail({ key: 'event:outsider@1', from: 'dana@acme.example' }), 'event:outsider@1');
    await asEmail('3. a teammate without this inbox stays an email', mail({ key: 'event:lee@1', from: 'lee@agency.example' }), 'event:lee@1');
    await asEmail('4. a forward of the script email stays an email', mail({ key: 'event:fwd@1', subject: 'Fwd: Meeting transcript: Design sync (2026-11-12)' }), 'event:fwd@1');
    await asEmail('4. a broken block stays an email', mail({ key: 'event:broken@1', block: `${MEETING_BLOCK_BEGIN}\n@@@\n${MEETING_BLOCK_END}` }), 'event:broken@1');
    await asEmail('4. a block whose file is missing stays an email', mail({ key: 'event:nofile@1', file: 'other.txt' }), 'event:nofile@1');

    await db.query('INSERT INTO communications.inbox_access(inbox_id, member_id) VALUES ($1,$2)', [ids.inbox, teammate]);
    const lee = mail({ key: 'event:lee@2', from: 'lee@agency.example' });
    await ingestInbound(supabase, lee);
    const leeLanded = await landed('event:lee@2', lee.provider_email_id);
    check("3. once granted the inbox, that teammate's script email is a meeting sent in by them",
      leeLanded.meetings.length === 1 && leeLanded.emails.length === 0 && leeLanded.meetings[0].sender_member_id === teammate, leeLanded);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`meetings: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`meetings: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
