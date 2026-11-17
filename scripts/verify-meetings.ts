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
 *   is never printed or stored.
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
    const first = await ingestMeetingPackage(supabase, pkg(), ids.owner, KEY);
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
    const again = await ingestMeetingPackage(supabase, pkg(), ids.owner, KEY);
    check('the same package posted again is the same message', again.already_complete && again.message_id === first.message_id
      && (await rows(db, "SELECT 1 FROM communications.messages WHERE channel = 'meeting'")).length === 1, again);

    const notes = await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:notes-1', kind: 'summary', title: 'Kickoff', text: 'Notes: kickoff' }), ids.owner, KEY);
    const late = await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:notes-1', kind: 'transcript', title: 'Kickoff', text: 'Full kickoff words' }), ids.owner, KEY);
    check('a late transcript joins the meeting its notes started', notes.conversation_id === late.conversation_id
      && notes.message_id !== late.message_id
      && (await rows(db, 'SELECT 1 FROM communications.messages WHERE thread_id = $1', [notes.conversation_id])).length === 2, { notes, late });

    storage.failUploads = true;
    let failed = '';
    try { await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:retry', text: 'Words that fail to store once' }), ids.owner, KEY); }
    catch (error) { failed = (error as Error).message; }
    storage.failUploads = false;
    const retried = await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:retry', text: 'Words that fail to store once' }), ids.owner, KEY);
    const retriedRow = (await rows(db, 'SELECT status FROM communications.messages WHERE id = $1', [retried.message_id]))[0];
    check('a failed upload is finished by the next post', failed !== '' && !retried.already_complete && retriedRow?.status === 'new'
      && (await rows(db, "SELECT 1 FROM communications.messages WHERE provider_email_id = (SELECT provider_email_id FROM communications.messages WHERE id = $1)", [retried.message_id])).length === 1,
      { failed, retried, retriedRow });

    // ---- Refusals and links -----------------------------------------------
    const before = (await rows(db, 'SELECT count(*)::int AS n FROM communications.messages'))[0].n;
    let tooLarge = false;
    try { await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:huge', text: 'x'.repeat(1024 * 1024 + 1) }), ids.owner, KEY); }
    catch (error) { tooLarge = error instanceof MeetingTooLargeError; }
    check('a package larger than the inbox stores is refused whole', tooLarge
      && (await rows(db, 'SELECT count(*)::int AS n FROM communications.messages'))[0].n === before);

    const odd = await ingestMeetingPackage(supabase, pkg({ meeting_key: 'doc:odd', doc_url: 'https://evil.example/phish' }), ids.owner, KEY);
    const oddBody = (await rows(db, 'SELECT text_body FROM communications.messages WHERE id = $1', [odd.message_id]))[0];
    const oddMeeting = (await rows(db, 'SELECT doc_url FROM communications.meetings WHERE conversation_id = $1', [odd.conversation_id]))[0];
    check('a link that is not a Google Doc is neither printed nor stored', !oddBody.text_body.includes('evil.example') && oddMeeting.doc_url === null, { oddBody, oddMeeting });
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
