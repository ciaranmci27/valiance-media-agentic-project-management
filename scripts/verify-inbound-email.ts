/**
 * Inbound email end to end, against the real migration in PGlite behind
 * fake-postgrest (with an in-memory Storage) and a fake Resend:
 * - the Resend webhook route (Svix signature, fetch, server-side file copy,
 *   idempotency on retry and duplicate delivery, verification, threading,
 *   mapping, auto-mail, failure and resume without orphans);
 * - the agent API (inbox scope, missing scopes, triage project rules,
 *   status rules, idempotency keys, attachments, summaries, signal, rows
 *   deleted mid-request);
 * - rule 3 (an email-linked task becomes ai_ready only in a human session)
 *   through the task PATCH route, suggestion approval and the database;
 * - contact_emails syncing with contacts.email, inbox routing settings;
 * - the schema.sql snapshot loading on its own.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-inbound-email.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { startFakePostgrest } from './fake-postgrest';
import { asPerson, asService, createEmailDatabase } from './inbound-email-db';
import { FakeResend, FakeStorage, readEml, resendFixture } from './inbound-email-fixtures';
import { signSvix } from '../src/lib/inbound-email/svix';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payloads are checked field by field
type Payload = Record<string, any>;

const ids = {
  owner: randomUUID(), ownerAuth: randomUUID(), ashley: randomUUID(), jeff: randomUUID(),
  acme: randomUUID(), acme2: randomUUID(), birch: randomUUID(), other: randomUUID(),
  dana: randomUUID(), ben: randomUUID(), inboxA: randomUUID(), inboxB: randomUUID(), goal: randomUUID(),
};
const RELAY = 'relay.example.test';
const SECRET = `whsec_${Buffer.from('inbound-email-test-signing-secret!').toString('base64')}`;
const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const keys = { ashley: `pk_live_${randomUUID()}`, ashleyNoEmail: `pk_live_${randomUUID()}`, jeff: `pk_live_${randomUUID()}` };

async function rows<T = Payload>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function seed(db: PGlite) {
  await db.query("UPDATE business_settings SET inbound_email_domain = $1", [RELAY]);
  await db.query(
    `INSERT INTO team_members(id, auth_user_id, name, role) VALUES ($1,$2,'Sam','owner'),($3,NULL,'Ashley P.','agent'),($4,NULL,'Jeff','agent')`,
    [ids.owner, ids.ownerAuth, ids.ashley, ids.jeff],
  );
  await db.query(`INSERT INTO projects(id, name) VALUES ($1,'Acme Roofing'),($2,'Acme Gutters LLC'),($3,'Birch Partners'),($4,'Other client')`,
    [ids.acme, ids.acme2, ids.birch, ids.other]);
  await db.query(`INSERT INTO project_goals(id, project_id) VALUES ($1,$2)`, [ids.goal, ids.acme]);
  // Contacts through the existing columns: the trigger creates contact_emails.
  await db.query(`INSERT INTO contacts(id, name, email) VALUES ($1,'Dana Wu','Dana@Acme-Roofing.example'),($2,'Ben Ortiz','ben@birchpartners.example')`, [ids.dana, ids.ben]);
  await db.query(`INSERT INTO project_contacts(project_id, contact_id) VALUES ($1,$3),($2,$3),($4,$5)`, [ids.acme, ids.acme2, ids.dana, ids.birch, ids.ben]);
  await db.query(`INSERT INTO email_client_domains(domain, project_id) VALUES ('birchpartners.example',$1)`, [ids.birch]);
  // Inboxes: routing addresses come from the address and the default domain.
  await db.query(`INSERT INTO email_inboxes(id, name, address, handler_member_id, verification_code) VALUES ($1,'Ashley','ashley@agency.example',$2,'VM-7K2Q')`, [ids.inboxA, ids.ashley]);
  await db.query(`INSERT INTO email_inboxes(id, name, address, handler_member_id) VALUES ($1,'Billing','billing@agency.example',$2)`, [ids.inboxB, ids.jeff]);
  // Agent permissions beyond the migration's email grants.
  for (const key of ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'agent_activity.write'])
    await db.query("INSERT INTO role_permissions(role, permission_key, access_channel) VALUES ('agent',$1,'api') ON CONFLICT DO NOTHING", [key]);
  for (const member of [ids.ashley, ids.jeff])
    for (const key of ['tasks.manage_all', 'projects.read_all', 'suggestions.manage'])
      await db.query("INSERT INTO team_member_permissions(member_id, permission_key, access_channel, effect) VALUES ($1,$2,'api','allow')", [member, key]);
  const scopes = ['inbound_email.read', 'inbound_email.triage', 'inbound_email.signal', 'tasks.read', 'tasks.manage_all', 'projects.read', 'suggestions.manage'];
  await db.query('INSERT INTO api_keys(key_hash, team_member_id, scopes) VALUES ($1,$2,$3),($4,$2,$5),($6,$7,$3)', [
    hash(keys.ashley), ids.ashley, scopes,
    hash(keys.ashleyNoEmail), scopes.filter((s) => !s.startsWith('inbound_email')),
    hash(keys.jeff), ids.jeff,
  ]);
}

async function main() {
  const db = await createEmailDatabase();
  await seed(db);
  const storage = new FakeStorage();
  // Runs before a request reaches the fake database or Storage, to delete a
  // row in the middle of a route's work.
  let intercept: ((request: IncomingMessage, url: URL) => Promise<void>) | null = null;
  const server = await startFakePostgrest(db, {
    handle: async (request, response, url) => {
      if (intercept) await intercept(request, url);
      return storage.handler(request, response, url);
    },
  });
  const resend = new FakeResend();
  const uninstall = resend.install();
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url,
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key',
    NEXT_PUBLIC_ENABLE_AGENTS: 'true',
    RESEND_API_KEY: resend.apiKey,
    RESEND_INBOUND_WEBHOOK_SECRET: SECRET,
  });

  try {
    const webhook = await import('../src/app/api/inbound-email/resend/route');
    const list = await import('../src/app/api/v1/inbound-emails/route');
    const detail = await import('../src/app/api/v1/inbound-emails/[id]/route');
    const attachmentUrl = await import('../src/app/api/v1/inbound-emails/[id]/attachments/[aid]/url/route');
    const attachmentLabel = await import('../src/app/api/v1/inbound-emails/[id]/attachments/[aid]/route');
    const triage = await import('../src/app/api/v1/inbound-emails/[id]/triage/route');
    const unsummarized = await import('../src/app/api/v1/inbound-emails/triage/unsummarized/route');
    const markSummarized = await import('../src/app/api/v1/inbound-emails/triage/mark-summarized/route');
    const signal = await import('../src/app/api/v1/inbound-emails/signal/route');
    const taskRoute = await import('../src/app/api/v1/tasks/[id]/route');
    const approve = await import('../src/app/api/v1/task-suggestions/[id]/approve/route');

    const deliver = async (emailId: string, options: { secret?: string; timestamp?: number; type?: string } = {}) => {
      const body = JSON.stringify({ type: options.type ?? 'email.received', created_at: '2026-10-05T18:00:00Z', data: { email_id: emailId } });
      const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
      const response = await webhook.POST(new Request('http://localhost/api/inbound-email/resend', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'svix-id': `msg_${emailId}`, 'svix-timestamp': String(timestamp), 'svix-signature': signSvix(options.secret ?? SECRET, `msg_${emailId}`, timestamp, body) },
        body,
      }));
      return { status: response.status, body: (await response.json()) as Payload };
    };
    const add = async (name: string, emailId: string, options: Partial<Parameters<typeof resendFixture>[1]> = {}, replacements: Record<string, string> = {}) => {
      resend.add(await resendFixture(await readEml(name, replacements), { emailId, deliveredTo: [`ashley@${RELAY}`], ...options }));
    };
    const api = async (handler: (r: NextRequest, c: { params: Promise<never> }) => Promise<Response>, method: string, path: string, key: string, params: Record<string, string> = {}, body?: unknown) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), { params: Promise.resolve(params) as Promise<never> });
      return { status: response.status, body: (await response.json()) as Payload };
    };
    const messageBy = async (internetId: string) => (await rows(db, 'SELECT * FROM email_messages WHERE internet_message_id = $1 ORDER BY created_at', [internetId]));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    // ---- Inbox settings -------------------------------------------------
    const [inboxA] = await rows(db, 'SELECT * FROM email_inboxes WHERE id = $1', [ids.inboxA]);
    check('inbox: routing address from the address and the default relay domain', inboxA.routing_address === `ashley@${RELAY}` && inboxA.routing_domain === RELAY, inboxA);
    check('inbox: the handler can read their inbox', (await rows(db, 'SELECT 1 FROM email_inbox_access WHERE inbox_id=$1 AND member_id=$2', [ids.inboxA, ids.ashley])).length === 1);
    const [generated] = await rows(db, "INSERT INTO email_inboxes(name, address) VALUES ('Dup','ashley@elsewhere.example') RETURNING routing_local_part, verification_code");
    check('inbox: a taken local part gets a suffix; a VM-XXXX code is generated', /^ashley-[0-9a-f]{4}$/.test(generated.routing_local_part) && /^VM-[A-Z0-9]{4}$/.test(generated.verification_code), generated);
    await db.query("UPDATE business_settings SET inbound_email_domain = 'mail.other.test'");
    check('inbox: changing the default domain never moves an inbox', (await rows(db, 'SELECT routing_address FROM email_inboxes WHERE id=$1', [ids.inboxA]))[0].routing_address === `ashley@${RELAY}`);
    await db.query('UPDATE business_settings SET inbound_email_domain = $1', [RELAY]);
    await db.query("DELETE FROM email_inboxes WHERE name = 'Dup'");
    let refused = '';
    try { await db.query("INSERT INTO email_client_domains(domain, project_id) VALUES ('gmail.com',$1)", [ids.acme]); } catch (error) { refused = (error as Error).message; }
    check('domains: a public webmail domain is refused by the database', /check constraint/.test(refused), refused);

    // ---- Webhook door ---------------------------------------------------
    await add('owner-original.eml', 're_orig');
    const badSignature = await deliver('re_orig', { secret: `whsec_${Buffer.from('wrong').toString('base64')}` });
    const stale = await deliver('re_orig', { timestamp: Math.floor(Date.now() / 1000) - 600 });
    check('webhook: a bad or stale signature is 401 and stores nothing', badSignature.status === 401 && stale.status === 401 && (await rows(db, 'SELECT 1 FROM email_messages')).length === 0);
    const otherEvent = await deliver('re_orig', { type: 'email.delivered' });
    check('webhook: other event types are acknowledged and ignored', otherEvent.status === 200 && otherEvent.body.status === 'ignored');

    // ---- Ingestion ------------------------------------------------------
    const original = await deliver('re_orig');
    check('ingest: the owner\'s original lands as new', original.status === 200 && original.body.inboxes?.[0]?.outcome === 'completed' && original.body.inboxes[0].status === 'new', original.body);
    const [orig] = await messageBy('orig-1@agency.example');
    const rawObject = storage.objects.get(`inbound-email/${orig.raw_storage_path}`);
    check('ingest: raw .eml stored at {inbox}/{email}/raw.eml with its hash and size', !!orig.raw_uploaded_at && !!rawObject
      && orig.raw_storage_path === `${ids.inboxA}/${orig.id}/raw.eml`
      && createHash('sha256').update(rawObject.bytes).digest('hex') === orig.raw_sha256 && Number(orig.raw_size_bytes) === rawObject.bytes.byteLength, orig);
    check('ingest: inbox last_received_at is set', !!(await rows(db, 'SELECT last_received_at FROM email_inboxes WHERE id=$1', [ids.inboxA]))[0].last_received_at);

    await add('gmail-reply.eml', 're_gmail');
    const gmail = await deliver('re_gmail');
    const [reply] = await messageBy('CAF2xGmail-reply-1@mail.gmail.com');
    check('thread: a reply joins through In-Reply-To', gmail.status === 200 && reply.thread_id === orig.thread_id, gmail.body);
    const candidates = await rows(db, 'SELECT project_id, reason FROM email_message_candidates WHERE message_id=$1 ORDER BY project_id', [reply.id]);
    check('mapping: one contact on two projects gives two candidates and no project', candidates.length === 2 && candidates.every((c) => c.reason === 'contact')
      && (await rows(db, 'SELECT project_id FROM email_threads WHERE id=$1', [reply.thread_id]))[0].project_id === null, candidates);
    const danaRow = (await rows(db, "SELECT contact_id FROM email_message_recipients WHERE message_id=$1 AND kind='from'", [reply.id]))[0];
    check('recipients: the sender row links its contact', danaRow.contact_id === ids.dana, danaRow);
    check('ingest: trust and new_text stored', reply.auth.trust === 'trusted' && reply.new_text.startsWith('Looks great!') && !reply.new_text.includes('> Hi Dana'), reply.auth);

    const uploadsBefore = storage.uploads;
    const retry = await deliver('re_gmail');
    check('idempotency: a webhook retry is already_complete with no new rows or files', retry.body.inboxes?.[0]?.outcome === 'already_complete'
      && storage.uploads === uploadsBefore && (await messageBy('CAF2xGmail-reply-1@mail.gmail.com')).length === 1, retry.body);
    await add('gmail-reply.eml', 're_gmail_dup');
    const duplicate = await deliver('re_gmail_dup');
    check('idempotency: the same Message-ID under another provider id is one row', duplicate.body.inboxes?.[0]?.outcome === 'already_complete'
      && (await messageBy('CAF2xGmail-reply-1@mail.gmail.com')).length === 1 && storage.uploads === uploadsBefore, duplicate.body);

    await add('subject-followup.eml', 're_followup');
    await deliver('re_followup');
    const [followup] = await messageBy('followup-2@acme-roofing.example');
    check('thread: same normalized subject plus a shared participant joins', followup.thread_id === orig.thread_id, followup);

    await add('outlook-reply.eml', 're_outlook', { authentication: { spf: 'pass', dkim: 'gray', dmarc: 'gray' } });
    await deliver('re_outlook');
    const [outlook] = await messageBy('BN8PR11MB1234outlook@BN8PR11MB1234.namprd11.prod.outlook.example');
    const [outlookThread] = await rows(db, 'SELECT * FROM email_threads WHERE id=$1', [outlook.thread_id]);
    check('mapping: one project by contact and domain maps the new thread', outlookThread.project_id === ids.birch && outlookThread.project_source === 'mapped' && outlook.thread_id !== orig.thread_id, outlookThread);
    check('ingest: Outlook quoted block stripped; gray DKIM is untrusted', !outlook.new_text.includes('Sent: Monday') && outlook.auth.trust === 'untrusted', outlook.auth);

    await add('forward-full-history.eml', 're_forward');
    await add('html-only.eml', 're_html', { authentication: null });
    await deliver('re_forward');
    await deliver('re_html');
    const [forward] = await messageBy('fwd-3@agency.example');
    const [htmlOnly] = await messageBy('html-only-4@mail.gmail.com');
    check('ingest: a forward is flagged and keeps its full text', forward.is_forward === true && forward.text_body.includes('Our website shows an error page'));
    check('ingest: HTML-only mail gets new_text from its HTML; unknown trust', htmlOnly.text_body === null && htmlOnly.new_text.includes('logo folder') && htmlOnly.auth.trust === 'unknown', htmlOnly.new_text);
    check('mapping: a public webmail sender without a contact has no candidates', (await rows(db, 'SELECT 1 FROM email_message_candidates WHERE message_id=$1', [htmlOnly.id])).length === 0);

    for (const [name, id] of [['out-of-office.eml', 're_ooo'], ['newsletter.eml', 're_news'], ['bounce.eml', 're_bounce']]) {
      await add(name, id);
      await deliver(id);
    }
    const ignored = await rows(db, "SELECT internet_message_id, auto_mail_reason FROM email_messages WHERE status='ignored' ORDER BY internet_message_id");
    check('auto-mail: out-of-office, newsletter and bounce are ignored with a reason', ignored.length === 3 && ignored.every((m) => !!m.auto_mail_reason), ignored);
    await db.query('UPDATE email_inboxes SET filter_auto_mail = false WHERE id=$1', [ids.inboxA]);
    await add('newsletter.eml', 're_news_unfiltered', { messageId: '<newsletter-6b@acme-supplies.example>' });
    await deliver('re_news_unfiltered');
    const [unfiltered] = await messageBy('newsletter-6b@acme-supplies.example');
    check('auto-mail: with the filter off it stays new, reason kept', unfiltered.status === 'new' && unfiltered.auto_mail_reason === 'precedence: bulk', unfiltered);
    await db.query('UPDATE email_inboxes SET filter_auto_mail = true WHERE id=$1', [ids.inboxA]);

    await add('many-attachments.eml', 're_many');
    await deliver('re_many');
    const [many] = await messageBy('attach-8@acme-roofing.example');
    const stored = await rows(db, 'SELECT * FROM email_attachments WHERE message_id=$1 ORDER BY position', [many.id]);
    const allMatch = stored.every((a) => a.uploaded_at && createHash('sha256').update(storage.objects.get(`inbound-email/${a.storage_path}`)!.bytes).digest('hex') === a.sha256
      && a.storage_path === `${ids.inboxA}/${many.id}/${a.id}`);
    check('attachments: five stored at {inbox}/{email}/{attachment} with matching hashes', stored.length === 5 && allMatch, stored.map((a) => [a.filename, a.storage_path, a.sha256]));

    // Oversized: declared over the cap (skipped without downloading), and
    // undeclared (downloaded, aborted at the cap, then skipped).
    await db.query('UPDATE email_inboxes SET max_attachment_mb = 1 WHERE id=$1', [ids.inboxA]);
    const big = Buffer.alloc(1_200_000, 7).toString('base64').replace(/.{76}/g, '$&\r\n');
    await add('oversized-attachment.eml', 're_big', {}, { BIG_BASE64: big });
    const calls = resend.calls.length;
    await deliver('re_big');
    const [bigMessage] = await messageBy('oversized-10@birchpartners.example');
    const bigAttachments = await rows(db, 'SELECT * FROM email_attachments WHERE message_id=$1 ORDER BY position', [bigMessage.id]);
    check('attachments: over the cap is a skipped row with no file and no download', bigAttachments[0].skipped_reason === 'over_size_cap' && bigAttachments[0].storage_path === null
      && !resend.calls.slice(calls).some((path) => path.endsWith('-att-0')) && !!bigAttachments[1].uploaded_at, bigAttachments.map((a) => [a.filename, a.skipped_reason]));
    await add('oversized-attachment.eml', 're_big_nosize', { hideSizes: true, messageId: '<oversized-10b@birchpartners.example>' }, { BIG_BASE64: big });
    await deliver('re_big_nosize');
    const [bigNoSize] = await messageBy('oversized-10b@birchpartners.example');
    const noSize = await rows(db, 'SELECT * FROM email_attachments WHERE message_id=$1 ORDER BY position', [bigNoSize.id]);
    check('attachments: an undeclared size over the cap is cut off and skipped', bigNoSize.status === 'new' && noSize[0].skipped_reason === 'over_size_cap' && !storage.objects.has(`inbound-email/${ids.inboxA}/${bigNoSize.id}/${noSize[0].id}`), noSize);
    await db.query('UPDATE email_inboxes SET max_attachment_mb = 25 WHERE id=$1', [ids.inboxA]);

    // Verification.
    await add('verification.eml', 're_verify', { deliveredTo: [`ashley@${RELAY}`] });
    const objectsBefore = storage.objects.size;
    const verified = await deliver('re_verify');
    const [afterVerify] = await rows(db, 'SELECT verified_at FROM email_inboxes WHERE id=$1', [ids.inboxA]);
    check('verification: the inbox is verified and the email is gone, files and row', verified.body.inboxes?.[0]?.outcome === 'verified' && !!afterVerify.verified_at
      && (await messageBy('verify-9@agency.example')).length === 0 && storage.objects.size === objectsBefore, verified.body);
    await db.query("UPDATE email_inboxes SET routing_local_part = 'ashley2' WHERE id=$1", [ids.inboxB]);
    await db.query("UPDATE email_inboxes SET verified_at = now() WHERE id=$1", [ids.inboxB]);
    await db.query("UPDATE email_inboxes SET routing_local_part = 'billing' WHERE id=$1", [ids.inboxB]);
    check('inbox: changing the routing address clears verified_at', (await rows(db, 'SELECT verified_at FROM email_inboxes WHERE id=$1', [ids.inboxB]))[0].verified_at === null);

    // Recipients.
    await add('owner-original.eml', 're_nobody', { deliveredTo: [`nobody@${RELAY}`], messageId: '<nobody@agency.example>' });
    const nobody = await deliver('re_nobody');
    check('routing: an unknown recipient stores nothing and is acknowledged', nobody.status === 200 && nobody.body.reason === 'no_inbox' && (await messageBy('nobody@agency.example')).length === 0, nobody.body);
    await add('owner-original.eml', 're_two', { deliveredTo: [`ashley@${RELAY}`, `billing@${RELAY}`], messageId: '<two-inboxes@agency.example>' });
    await deliver('re_two');
    const two = await messageBy('two-inboxes@agency.example');
    check('routing: one email to two inboxes is a row in each', two.length === 2 && new Set(two.map((m) => m.inbox_id)).size === 2, two.map((m) => m.inbox_id));
    await add('owner-original.eml', 're_public', { deliveredTo: ['ashley@agency.example'], messageId: '<public-only@agency.example>' });
    const publicOnly = await deliver('re_public');
    check('routing: a public address alone never matches an inbox', publicOnly.body.reason === 'no_inbox' && (await messageBy('public-only@agency.example')).length === 0, publicOnly.body);
    await add('owner-original.eml', 're_forwarded', { deliveredTo: ['ashley@agency.example'], receivedFor: [`ashley@${RELAY}`], messageId: '<forwarded@agency.example>' });
    await deliver('re_forwarded');
    check('routing: a forwarded message matches through received_for', (await messageBy('forwarded@agency.example'))[0]?.inbox_id === ids.inboxA);
    await add('owner-original.eml', 're_upper', { deliveredTo: [`ASHLEY@${RELAY.toUpperCase()}`], messageId: '<upper@agency.example>' });
    await deliver('re_upper');
    check('routing: recipient matching ignores case', (await messageBy('upper@agency.example'))[0]?.inbox_id === ids.inboxA);

    // Failure and resume: a download fails part-way; Resend retries.
    await add('many-attachments.eml', 're_flaky', { messageId: '<flaky@acme-roofing.example>' });
    resend.failDownloads.add('/re_flaky/attachments/re_flaky-att-2');
    const flaky = await deliver('re_flaky');
    const [flakyRow] = await messageBy('flaky@acme-roofing.example');
    const pending = await rows(db, 'SELECT * FROM email_attachments WHERE message_id=$1 ORDER BY position', [flakyRow.id]);
    check('failure: a failed download answers 500 and leaves the row receiving', flaky.status === 500 && flakyRow.status === 'receiving' && pending.filter((a) => a.uploaded_at).length === 2, pending.map((a) => !!a.uploaded_at));
    check('failure: the inbox records the error', /download answered 503/.test((await rows(db, 'SELECT last_error FROM email_inboxes WHERE id=$1', [ids.inboxA]))[0].last_error ?? ''));
    resend.failDownloads.clear();
    const resumed = await deliver('re_flaky');
    const [flakyDone] = await messageBy('flaky@acme-roofing.example');
    check('failure: the retry resumes and completes', resumed.status === 200 && flakyDone.status === 'new', resumed.body);
    const paths = new Set([
      ...(await rows(db, 'SELECT raw_storage_path AS p FROM email_messages WHERE raw_storage_path IS NOT NULL')).map((r) => `inbound-email/${r.p}`),
      ...(await rows(db, 'SELECT storage_path AS p FROM email_attachments WHERE storage_path IS NOT NULL')).map((r) => `inbound-email/${r.p}`),
    ]);
    check('files: every stored object belongs to a row (no orphans)', [...storage.objects.keys()].every((key) => paths.has(key)), [...storage.objects.keys()].filter((key) => !paths.has(key)));

    // ---- Agent API ------------------------------------------------------
    const listed = await api(list.GET, 'GET', '/api/v1/inbound-emails?limit=100', keys.ashley);
    const listedIds: string[] = listed.body.data.map((m: Payload) => m.id);
    const visibleA = (await rows(db, "SELECT id FROM email_messages WHERE inbox_id=$1 AND status <> 'receiving'", [ids.inboxA])).map((r) => r.id);
    check('list: exactly the granted inbox, newest first, no bodies', listed.status === 200 && listedIds.length === visibleA.length && listedIds.every((id) => visibleA.includes(id))
      && !('text_body' in listed.body.data[0]) && listed.body.meta.total === visibleA.length, { status: listed.status, n: listedIds.length, expected: visibleA.length });
    const listedReply = listed.body.data.find((m: Payload) => m.id === reply.id);
    check('list: sender, trust and candidates', listedReply.from.address === 'dana@acme-roofing.example' && listedReply.trust === 'trusted' && listedReply.candidate_project_ids.length === 2, listedReply);
    const byStatus = await api(list.GET, 'GET', '/api/v1/inbound-emails?status=ignored', keys.ashley);
    check('list: status filter', byStatus.body.data.length === 3 && byStatus.body.data.every((m: Payload) => m.status === 'ignored'));
    const byProject = await api(list.GET, 'GET', `/api/v1/inbound-emails?project_id=${ids.birch}`, keys.ashley);
    check('list: project filter goes through the thread', byProject.body.data.length >= 1 && byProject.body.data.every((m: Payload) => m.project?.id === ids.birch), byProject.body.data.length);
    const otherInbox = await api(list.GET, 'GET', `/api/v1/inbound-emails?inbox_id=${ids.inboxB}`, keys.ashley);
    check('scope: an explicit inbox_id not granted is 403 inbox_scope', otherInbox.status === 403 && otherInbox.body.error.details.reason === 'inbox_scope'
      && /Leave inbox_id out/.test(otherInbox.body.error.details.hint), otherInbox.body);
    const jeffReads = await api(detail.GET, 'GET', `/api/v1/inbound-emails/${reply.id}`, keys.jeff, { id: reply.id });
    const unknownId = randomUUID();
    const unknownRead = await api(detail.GET, 'GET', `/api/v1/inbound-emails/${unknownId}`, keys.jeff, { id: unknownId });
    check('scope: an email in an ungranted inbox is 404, the same answer as an unknown id', jeffReads.status === 404 && unknownRead.status === 404
      && JSON.stringify(jeffReads.body) === JSON.stringify(unknownRead.body), [jeffReads.body, unknownRead.body]);
    const jeffList = await api(list.GET, 'GET', '/api/v1/inbound-emails', keys.jeff);
    check('scope: a member lists only their own inbox', jeffList.body.data.every((m: Payload) => m.inbox_id === ids.inboxB) && jeffList.body.data.length === 1, jeffList.body.data.length);
    const noScope = await api(list.GET, 'GET', '/api/v1/inbound-emails', keys.ashleyNoEmail);
    check('scope: a key without inbound_email.read is 403 missing_key_scope', noScope.status === 403 && noScope.body.error.details.reason === 'missing_key_scope', noScope.body);
    const noSignal = await api(signal.GET, 'GET', '/api/v1/inbound-emails/signal', keys.ashleyNoEmail);
    check('scope: signal needs inbound_email.signal', noSignal.status === 403);

    const shown = await api(detail.GET, 'GET', `/api/v1/inbound-emails/${reply.id}`, keys.ashley, { id: reply.id });
    const d = shown.body.data;
    check('detail: the whole thread oldest first, with candidates and no project yet', shown.status === 200 && d.thread.messages.length >= 3 && d.thread.messages[0].id === orig.id
      && [reply.id, followup.id].every((id) => d.thread.messages.some((m: Payload) => m.id === id))
      && d.candidates.length === 2 && d.project === null && d.auth.trust === 'trusted' && d.from.name === 'Dana Wu', { status: shown.status, n: d?.thread?.messages?.map((m: Payload) => m.subject), c: d.candidates, p: d.project, a: d.auth, f: d.from });
    check('detail: text, HTML as text and new_text', d.text.includes('Looks great!') && d.html_text.includes('Make the phone number bigger.') && !/<(div|br|li|ol)\b/.test(d.html_text), d.html_text);
    const manyDetail = (await api(detail.GET, 'GET', `/api/v1/inbound-emails/${many.id}`, keys.ashley, { id: many.id })).body.data;
    const readable = Object.fromEntries(manyDetail.attachments.map((a: Payload) => [a.filename, [a.kind, a.agent_readable]]));
    check('detail: attachment kinds and readability', JSON.stringify(readable) === JSON.stringify({ 'truck.png': ['image', true], 'signed-quote.pdf': ['pdf', true], 'notes.txt': ['text', true], 'prices.csv': ['text', true], 'old-brief.docx': ['other', false] }), readable);
    await db.query('UPDATE email_attachments SET size_bytes = NULL WHERE id=$1', [noSize[0].id]);
    const noSizeDetail = (await api(detail.GET, 'GET', `/api/v1/inbound-emails/${bigNoSize.id}`, keys.ashley, { id: bigNoSize.id })).body.data;
    const noSizeLabel = await api(attachmentLabel.PATCH, 'PATCH', `/api/v1/inbound-emails/${bigNoSize.id}/attachments/${noSize[0].id}`, keys.ashley, { id: bigNoSize.id, aid: noSize[0].id }, { agent_label: 'Too big to keep' });
    check('detail: an unknown attachment size is null, never 0; known sizes are numbers',
      noSizeDetail.attachments.find((a: Payload) => a.id === noSize[0].id)?.size_bytes === null && noSizeLabel.body.data?.size_bytes === null
      && manyDetail.attachments.every((a: Payload) => typeof a.size_bytes === 'number' && a.size_bytes > 0), [noSizeDetail.attachments, noSizeLabel.body]);

    const png = manyDetail.attachments.find((a: Payload) => a.filename === 'truck.png');
    const docx = manyDetail.attachments.find((a: Payload) => a.filename === 'old-brief.docx');
    const pngUrl = await api(attachmentUrl.GET, 'GET', `/api/v1/inbound-emails/${many.id}/attachments/${png.id}/url`, keys.ashley, { id: many.id, aid: png.id });
    check('attachment url: a readable kind gets a five-minute signed URL', pngUrl.status === 200 && /\/storage\/v1\/object\/sign\/inbound-email\//.test(pngUrl.body.data.url)
      && Math.abs(Date.parse(pngUrl.body.data.expires_at) - Date.now() - 300_000) < 5000, pngUrl.body);
    const docxUrl = await api(attachmentUrl.GET, 'GET', `/api/v1/inbound-emails/${many.id}/attachments/${docx.id}/url`, keys.ashley, { id: many.id, aid: docx.id });
    check('attachment url: other kinds are 403 not_agent_readable', docxUrl.status === 403 && docxUrl.body.error.details.reason === 'not_agent_readable', docxUrl.body);
    await db.query("UPDATE email_inboxes SET agent_readable_types = ARRAY['pdf'] WHERE id=$1", [ids.inboxA]);
    const pngNow = await api(attachmentUrl.GET, 'GET', `/api/v1/inbound-emails/${many.id}/attachments/${png.id}/url`, keys.ashley, { id: many.id, aid: png.id });
    check('attachment url: the inbox setting decides the readable kinds', pngNow.status === 403);
    await db.query("UPDATE email_inboxes SET agent_readable_types = ARRAY['image','pdf','text'] WHERE id=$1", [ids.inboxA]);
    const skippedUrl = await api(attachmentUrl.GET, 'GET', `/api/v1/inbound-emails/${bigMessage.id}/attachments/${bigAttachments[0].id}/url`, keys.ashley, { id: bigMessage.id, aid: bigAttachments[0].id });
    check('attachment url: a skipped file is 409', skippedUrl.status === 409, skippedUrl.body);
    const crossUrl = await api(attachmentUrl.GET, 'GET', `/api/v1/inbound-emails/${reply.id}/attachments/${png.id}/url`, keys.ashley, { id: reply.id, aid: png.id });
    check('attachment url: an attachment of another email is 404', crossUrl.status === 404);
    const labelled = await api(attachmentLabel.PATCH, 'PATCH', `/api/v1/inbound-emails/${many.id}/attachments/${png.id}`, keys.ashley, { id: many.id, aid: png.id }, { agent_label: 'Red truck photo' });
    const extraField = await api(attachmentLabel.PATCH, 'PATCH', `/api/v1/inbound-emails/${many.id}/attachments/${png.id}`, keys.ashley, { id: many.id, aid: png.id }, { agent_label: 'x', filename: 'evil.exe' });
    check('label: agent_label only', labelled.status === 200 && labelled.body.data.agent_label === 'Red truck photo' && extraField.status === 422, [labelled.status, extraField.status]);
    const jeffUrl = await api(attachmentUrl.GET, 'GET', `/api/v1/inbound-emails/${many.id}/attachments/${png.id}/url`, keys.jeff, { id: many.id, aid: png.id });
    const jeffLabel = await api(attachmentLabel.PATCH, 'PATCH', `/api/v1/inbound-emails/${many.id}/attachments/${png.id}`, keys.jeff, { id: many.id, aid: png.id }, { agent_label: 'x' });
    check('scope: attachments of an email in an ungranted inbox are 404', jeffUrl.status === 404 && jeffLabel.status === 404 && jeffUrl.body.error.code === 'NOT_FOUND', [jeffUrl.body, jeffLabel.body]);

    // Tasks for links.
    const taskIn = async (project: string, title: string, readiness: string | null, createdBy: string) =>
      (await rows(db, 'INSERT INTO tasks(project_id, title, ai_readiness, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [project, title, readiness, createdBy]))[0].id as string;
    const acmeTask = await taskIn(ids.acme, 'Bigger phone number', null, ids.ashley);
    const otherTask = await taskIn(ids.other, 'Unrelated', null, ids.owner);

    const triageOf = (id: string, body: unknown, key = keys.ashley) => api(triage.POST, 'POST', `/api/v1/inbound-emails/${id}/triage`, key, { id }, body);
    const notCandidate = await triageOf(reply.id, { outcome: 'task', urgent: false, summary: 'Two banner changes', project_id: ids.birch });
    check('triage: project_id outside the candidates is 422', notCandidate.status === 422 && notCandidate.body.error.details.candidate_project_ids.length === 2, notCandidate.body);
    const wrongTask = await triageOf(reply.id, { outcome: 'task', urgent: false, summary: 'Two banner changes', project_id: ids.acme, links: [{ task_id: otherTask, relation: 'created' }] });
    check('triage: a link to a task in another project is 422', wrongTask.status === 422, wrongTask.body);
    const noProjectLinks = await triageOf(reply.id, { outcome: 'task', urgent: false, summary: 'x', links: [{ task_id: acmeTask, relation: 'created' }] });
    check('triage: links without any project are 422', noProjectLinks.status === 422, noProjectLinks.body);
    const firstTriage = await triageOf(reply.id, { outcome: 'task', urgent: false, summary: 'Two banner changes', project_id: ids.acme, links: [{ task_id: acmeTask, relation: 'created' }] });
    const [replyThread] = await rows(db, 'SELECT * FROM email_threads WHERE id=$1', [reply.thread_id]);
    check('triage: a candidate project sets the thread as inferred; trusted task is handled', firstTriage.status === 201 && replyThread.project_id === ids.acme && replyThread.project_source === 'inferred'
      && (await rows(db, 'SELECT status FROM email_messages WHERE id=$1', [reply.id]))[0].status === 'handled', firstTriage.body);
    check('triage: the link is stored with who linked it', (await rows(db, 'SELECT * FROM email_task_links WHERE task_id=$1', [acmeTask]))[0]?.linked_by === ids.ashley);
    const changeProject = await triageOf(reply.id, { outcome: 'task', urgent: false, summary: 'again', project_id: ids.acme2 });
    check('triage: a thread keeps its project (409)', changeProject.status === 409 && changeProject.body.error.details.reason === 'thread_project_set', changeProject.body);
    const untrusted = await triageOf(outlook.id, { outcome: 'task', urgent: false, summary: 'Send corrected invoice' });
    check('triage: an untrusted sender is needs_ciaran whatever the outcome', untrusted.status === 201 && untrusted.body.data.status === 'needs_ciaran', untrusted.body);
    const mappedChoice = await triageOf(outlook.id, { outcome: 'needs_reply', urgent: false, summary: 'x', project_id: ids.other });
    check('triage: a mapped thread refuses another project_id', mappedChoice.status === 409, mappedChoice.body);
    const doneProject = randomUUID();
    const shelvedProject = randomUUID();
    await db.query("INSERT INTO projects(id, name, status) VALUES ($1,'Finished client','completed')", [doneProject]);
    await db.query("INSERT INTO projects(id, name, archived_at) VALUES ($1,'Shelved client',now())", [shelvedProject]);
    const htmlTriageCount = async () => (await rows(db, 'SELECT count(*)::int AS n FROM email_triage WHERE message_id=$1', [htmlOnly.id]))[0].n;
    const triageBeforeInactive = await htmlTriageCount();
    const completedPick = await triageOf(htmlOnly.id, { outcome: 'needs_reply', urgent: false, summary: 'x', project_id: doneProject });
    const archivedPick = await triageOf(htmlOnly.id, { outcome: 'needs_reply', urgent: false, summary: 'x', project_id: shelvedProject });
    check('triage: a completed or archived project cannot be chosen (422 project_inactive), and nothing is recorded',
      [completedPick, archivedPick].every((r) => r.status === 422 && r.body.error.details.reason === 'project_inactive')
      && completedPick.body.error.details.status === 'completed' && archivedPick.body.error.details.archived === true
      && (await htmlTriageCount()) === triageBeforeInactive
      && (await rows(db, 'SELECT project_id FROM email_threads WHERE id=$1', [htmlOnly.thread_id]))[0].project_id === null
      && (await rows(db, 'SELECT status FROM email_messages WHERE id=$1', [htmlOnly.id]))[0].status === 'new', [completedPick.body, archivedPick.body]);
    const unknownTrust = await triageOf(htmlOnly.id, { outcome: 'needs_reply', urgent: false, summary: 'Update header and footer', suggested_reply: 'Thanks Carla, on it.', project_id: ids.other });
    check('triage: unknown trust is not forced to needs_ciaran; with no candidates any project may be inferred', unknownTrust.status === 201 && unknownTrust.body.data.status === 'handled'
      && unknownTrust.body.data.thread.project_id === ids.other && unknownTrust.body.data.thread.project_source === 'inferred', unknownTrust.body);
    const flagged = await triageOf(forward.id, { outcome: 'needs_ciaran', urgent: true, summary: 'Site down for Acme', question_for_ciaran: 'Restart the server?' });
    check('triage: needs_ciaran outcome sets needs_ciaran', flagged.body.data?.status === 'needs_ciaran', flagged.body);
    const jeffTriage = await triageOf(reply.id, { outcome: 'no_action', urgent: false, summary: 'x' }, keys.jeff);
    check('scope: triage of an email in an ungranted inbox is 404 and records nothing', jeffTriage.status === 404
      && (await rows(db, 'SELECT 1 FROM email_triage WHERE member_id=$1', [ids.jeff])).length === 0, jeffTriage.body);
    await settle();
    const activities = await rows(db, "SELECT * FROM agent_activities WHERE activity_type='email.triaged' ORDER BY created_at");
    check('activity: email.triaged per triage, with no email content in the title', activities.length >= 4 && activities.every((a) => /^(Urgent: t|T)riaged email: /.test(a.title) && !a.title.includes('banner'))
      && activities.some((a) => a.title === 'Urgent: triaged email: flagged for review'), activities.map((a) => a.title));

    // Summaries and signal.
    const sig1 = (await api(signal.GET, 'GET', '/api/v1/inbound-emails/signal', keys.ashley)).body.data;
    const newCount = (await rows(db, "SELECT count(*)::int AS n FROM email_messages WHERE inbox_id=$1 AND status='new'", [ids.inboxA]))[0].n;
    check('signal: new and unsummarized counts', sig1.new_count === newCount && sig1.unsummarized_count === 4 && !!sig1.newest_received_at, sig1);
    const second = await triageOf(reply.id, { outcome: 'task', urgent: false, summary: 'Two banner changes, task linked' });
    const pendingSummary = (await api(unsummarized.GET, 'GET', '/api/v1/inbound-emails/triage/unsummarized', keys.ashley)).body.data as Payload[];
    const replyItem = pendingSummary.find((item) => item.message.id === reply.id);
    check('unsummarized: newest triage per email, older ones listed as superseded', pendingSummary.length === 4 && replyItem?.triage_id === second.body.data.triage.id
      && replyItem?.superseded_triage_ids.length === 1 && replyItem.links.length === 1 && replyItem.project.id === ids.acme, pendingSummary.map((i) => i.message.id));
    const jeffMark = await api(markSummarized.POST, 'POST', '/api/v1/inbound-emails/triage/mark-summarized', keys.jeff, {}, { triage_ids: [replyItem!.triage_id] });
    check('mark-summarized: another inbox\'s triage marks nothing (404)', jeffMark.status === 404 && (await rows(db, 'SELECT 1 FROM email_triage WHERE summarized_at IS NOT NULL')).length === 0, jeffMark.body);
    const marked = await api(markSummarized.POST, 'POST', '/api/v1/inbound-emails/triage/mark-summarized', keys.ashley, {}, { triage_ids: pendingSummary.map((i) => i.triage_id) });
    check('mark-summarized: marks the listed and the superseded triage', marked.status === 200 && marked.body.data.marked === 5, marked.body);
    const sig2 = (await api(signal.GET, 'GET', '/api/v1/inbound-emails/signal', keys.ashley)).body.data;
    check('signal: nothing left to summarize', sig2.unsummarized_count === 0 && (await api(unsummarized.GET, 'GET', '/api/v1/inbound-emails/triage/unsummarized', keys.ashley)).body.data.length === 0, sig2);
    const sigB = (await api(signal.GET, 'GET', `/api/v1/inbound-emails/signal?inbox_id=${ids.inboxB}`, keys.jeff)).body.data;
    check('signal: per inbox', sigB.new_count === 1, sigB);

    // Idempotency keys.
    const triageCount = async (id: string) => (await rows(db, 'SELECT count(*)::int AS n FROM email_triage WHERE message_id=$1', [id]))[0].n as number;
    const activityCount = async (id: string) => (await rows(db, "SELECT count(*)::int AS n FROM agent_activities WHERE activity_type='email.triaged' AND metadata->>'message_id' = $1", [id]))[0].n as number;
    const statusOf = async (id: string) => (await rows(db, 'SELECT status FROM email_messages WHERE id=$1', [id]))[0].status as string;
    const idemKey = `retry-${randomUUID()}`;
    const idemBody = { outcome: 'no_action', urgent: false, summary: 'Thanks for the update', idempotency_key: idemKey };
    const firstKeyed = await triageOf(followup.id, idemBody);
    await settle();
    const keyedCount = await triageCount(followup.id);
    // A person sends it back meanwhile; the retry must not handle it again.
    await db.query("UPDATE email_messages SET status = 'new' WHERE id=$1", [followup.id]);
    const retried = await triageOf(followup.id, { ...idemBody, summary: '  Thanks for the update ', question_for_ciaran: null, links: [] });
    await settle();
    check('idempotency: a retry with the same key is 200 with the first triage, records nothing, emits no event, leaves the status',
      firstKeyed.status === 201 && firstKeyed.body.data.replayed === false && firstKeyed.body.data.triage.idempotency_key === idemKey
      && retried.status === 200 && retried.body.data.replayed === true && retried.body.data.triage.id === firstKeyed.body.data.triage.id
      && retried.body.data.status === 'new' && !('request_hash' in retried.body.data.triage) && !('request_hash' in firstKeyed.body.data.triage)
      && (await triageCount(followup.id)) === keyedCount && keyedCount === 1 && (await statusOf(followup.id)) === 'new' && (await activityCount(followup.id)) === 1,
      [firstKeyed.body, retried.body]);
    const conflicting = await triageOf(followup.id, { ...idemBody, outcome: 'needs_reply' });
    check('idempotency: the same key with another body is 409 idempotency_conflict and records nothing', conflicting.status === 409
      && conflicting.body.error.details.reason === 'idempotency_conflict' && (await triageCount(followup.id)) === 1 && (await statusOf(followup.id)) === 'new', conflicting.body);
    const otherEmail = await triageOf(orig.id, idemBody);
    const shortKey = await triageOf(orig.id, { ...idemBody, idempotency_key: 'short' });
    check('idempotency: a key is per email; under 8 characters is 422', otherEmail.status === 201 && otherEmail.body.data.triage.id !== firstKeyed.body.data.triage.id
      && shortKey.status === 422, [otherEmail.body, shortKey.body]);
    const raceBody = { outcome: 'no_action', urgent: false, summary: 'Race', idempotency_key: `race-${randomUUID()}` };
    const raced = await Promise.all([triageOf(followup.id, raceBody), triageOf(followup.id, raceBody)]);
    await settle();
    check('idempotency: two concurrent sends of one key record one triage and one event', JSON.stringify(raced.map((r) => r.status).sort()) === '[200,201]'
      && raced[0].body.data.triage.id === raced[1].body.data.triage.id && (await triageCount(followup.id)) === 2 && (await activityCount(followup.id)) === 2,
      raced.map((r) => r.body));

    // ---- Rule 3 ---------------------------------------------------------
    const patchTask = (taskId: string, key: string, body: unknown) => api(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${taskId}`, key, { id: taskId }, body);
    const jeffReady = await patchTask(acmeTask, keys.jeff, { ai_readiness: 'ai_ready' });
    const ashleyReady = await patchTask(acmeTask, keys.ashley, { ai_readiness: 'ai_ready' });
    check('rule 3: an agent cannot make an email-linked task ai_ready (403)', jeffReady.status === 403 && jeffReady.body.error.details.reason === 'email_task_human_only' && ashleyReady.status === 403, jeffReady.body);
    const otherEdit = await patchTask(acmeTask, keys.ashley, { title: 'Bigger phone number in the banner', ai_readiness: 'human_only' });
    check('rule 3: other edits still work', otherEdit.status === 200 && otherEdit.body.data.ai_readiness === 'human_only', otherEdit.body);
    let dbRefusal = '';
    try { await asService(db, () => db.query("UPDATE tasks SET ai_readiness = 'ai_ready' WHERE id = $1", [acmeTask])); } catch (error) { dbRefusal = (error as Error).message; }
    check('rule 3: the database refuses the service role', /EMAIL_TASK_HUMAN_ONLY/.test(dbRefusal), dbRefusal);
    let noUser = '';
    try { await db.query("UPDATE tasks SET ai_readiness = 'ai_ready' WHERE id = $1", [acmeTask]); } catch (error) { noUser = (error as Error).message; }
    check('rule 3: a session with no user is refused', /EMAIL_TASK_HUMAN_ONLY/.test(noUser), noUser);
    const human = await asPerson(db, ids.ownerAuth, () =>
      db.query<{ r: Payload }>("SELECT public.save_task($1, $2::jsonb) AS r", [acmeTask, JSON.stringify({ ai_readiness: 'ai_ready' })]));
    check('rule 3: a person signed in to the app can (save_task, authenticated)', human.rows[0].r.task.ai_readiness === 'ai_ready', human.rows[0]);
    const plainTask = await taskIn(ids.acme, 'Not from email', null, ids.owner);
    check('rule 3: unlinked tasks are unaffected', (await patchTask(plainTask, keys.jeff, { ai_readiness: 'ai_ready' })).status === 200);

    // The approve-then-link loophole.
    const [suggestion] = await rows(db, "INSERT INTO task_suggestions(project_id, goal_id, proposed_by, title) VALUES ($1,$2,$3,'Swap banner photo') RETURNING id", [ids.acme, ids.goal, ids.ashley]);
    const approved = await api(approve.POST, 'POST', `/api/v1/task-suggestions/${suggestion.id}/approve`, keys.ashley, { id: suggestion.id }, { ai_readiness: 'ai_ready' });
    const approvedTask = approved.body.data?.task?.id as string;
    check('approve: an agent approval creates an ai_ready task (no email link yet)', approved.status === 200 && approved.body.data.task.ai_readiness === 'ai_ready', approved.body);
    const linkUpdated = await triageOf(reply.id, { outcome: 'task', urgent: false, summary: 'x', links: [{ task_id: approvedTask, relation: 'updated' }] });
    const linkCreated = await triageOf(reply.id, { outcome: 'task', urgent: false, summary: 'x', links: [{ task_id: approvedTask, relation: 'created' }] });
    check('rule 3: an agent cannot link its own ai_ready task to an email', linkUpdated.status === 403 && linkCreated.status === 403 && linkUpdated.body.error.details.reason === 'email_task_human_only', [linkUpdated.body, linkCreated.body]);
    let linkRefusal = '';
    try {
      await asService(db, () => db.query("INSERT INTO email_task_links(message_id, task_id, relation, linked_by) VALUES ($1,$2,'updated',$3)", [reply.id, approvedTask, ids.ashley]));
    } catch (error) { linkRefusal = (error as Error).message; }
    check('rule 3: the database refuses that link too', /EMAIL_TASK_HUMAN_ONLY/.test(linkRefusal), linkRefusal);
    const ownerSpecced = await taskIn(ids.acme, 'Specced by Sam', 'ai_ready', ids.owner);
    const linkSpecced = await triageOf(reply.id, { outcome: 'task', urgent: false, summary: 'Update to a specced task', links: [{ task_id: ownerSpecced, relation: 'updated' }] });
    check('rule 3: an agent may link a task someone else made ai_ready, as updated', linkSpecced.status === 201, linkSpecced.body);

    // ---- Deleted mid-request ---------------------------------------------
    // Each case deletes the row just before the route's last request reaches
    // the database or Storage: the answer is 404, as if it never existed.
    const disposable = async (n: number) => {
      await add('owner-original.eml', `re_gone_${n}`, { messageId: `<gone-${n}@agency.example>` });
      await deliver(`re_gone_${n}`);
      return (await messageBy(`gone-${n}@agency.example`))[0];
    };
    const deleteOn = (match: (request: IncomingMessage, url: URL) => boolean, work: () => Promise<unknown>) => {
      intercept = async (request, url) => {
        if (!match(request, url)) return;
        intercept = null;
        await work();
      };
    };
    try {
      const goneTriage = await disposable(1);
      deleteOn((_r, url) => url.pathname.endsWith('/rpc/email_record_triage'), () => db.query('DELETE FROM email_messages WHERE id=$1', [goneTriage.id]));
      const vanishedTriage = await triageOf(goneTriage.id, { outcome: 'no_action', urgent: false, summary: 'Gone' });
      check('gone: an email deleted before its triage is recorded is 404, not 500', vanishedTriage.status === 404 && vanishedTriage.body.error.code === 'NOT_FOUND', vanishedTriage.body);

      const goneDetail = await disposable(2);
      deleteOn((_r, url) => url.pathname.endsWith('/email_inbox_access'), () => db.query('DELETE FROM email_messages WHERE id=$1', [goneDetail.id]));
      const vanishedDetail = await api(detail.GET, 'GET', `/api/v1/inbound-emails/${goneDetail.id}`, keys.ashley, { id: goneDetail.id });
      check('gone: an email deleted while its detail loads is 404', vanishedDetail.status === 404 && vanishedDetail.body.error.code === 'NOT_FOUND', vanishedDetail.body);

      const flakyFiles = await rows(db, 'SELECT id, filename, storage_path FROM email_attachments WHERE message_id=$1', [flakyDone.id]);
      const dropFile = async (file: Payload) => {
        await db.query('DELETE FROM email_attachments WHERE id=$1', [file.id]);
        storage.objects.delete(`inbound-email/${file.storage_path}`);
      };
      const notes = flakyFiles.find((f) => f.filename === 'notes.txt')!;
      deleteOn((request, url) => request.method === 'PATCH' && url.pathname.endsWith('/email_attachments'), () => dropFile(notes));
      const vanishedLabel = await api(attachmentLabel.PATCH, 'PATCH', `/api/v1/inbound-emails/${flakyDone.id}/attachments/${notes.id}`, keys.ashley, { id: flakyDone.id, aid: notes.id }, { agent_label: 'Notes' });
      check('gone: an attachment deleted before its label is written is 404', vanishedLabel.status === 404 && vanishedLabel.body.error.code === 'NOT_FOUND', vanishedLabel.body);

      const quote = flakyFiles.find((f) => f.filename === 'signed-quote.pdf')!;
      deleteOn((_r, url) => url.pathname.includes('/storage/v1/object/sign/'), () => dropFile(quote));
      const vanishedUrl = await api(attachmentUrl.GET, 'GET', `/api/v1/inbound-emails/${flakyDone.id}/attachments/${quote.id}/url`, keys.ashley, { id: flakyDone.id, aid: quote.id });
      check('gone: an attachment deleted before its URL is signed is 404', vanishedUrl.status === 404 && vanishedUrl.body.error.code === 'NOT_FOUND', vanishedUrl.body);
    } finally {
      intercept = null;
    }

    // ---- contact_emails -------------------------------------------------
    const mia = randomUUID();
    await db.query("INSERT INTO contacts(id, name, email) VALUES ($1,'Mia','Mia@Kite.example')", [mia]);
    const emailsOf = async (id: string) => rows(db, 'SELECT email, is_primary FROM contact_emails WHERE contact_id=$1 ORDER BY email', [id]);
    const contactEmail = async (id: string) => (await rows(db, 'SELECT email FROM contacts WHERE id=$1', [id]))[0].email;
    check('contact_emails: a new contact\'s address becomes its primary, lowercased; the form keeps its spelling',
      JSON.stringify(await emailsOf(mia)) === JSON.stringify([{ email: 'mia@kite.example', is_primary: true }]) && (await contactEmail(mia)) === 'Mia@Kite.example');
    await db.query("INSERT INTO contact_emails(contact_id, email) VALUES ($1,'mia.personal@kite.example')", [mia]);
    check('contact_emails: an extra address is not primary', (await emailsOf(mia)).filter((e) => e.is_primary).length === 1 && (await contactEmail(mia)) === 'Mia@Kite.example');
    await db.query("UPDATE contact_emails SET is_primary = true WHERE contact_id=$1 AND email='mia.personal@kite.example'", [mia]);
    check('contact_emails: promoting an address mirrors it to contacts.email', (await contactEmail(mia)) === 'mia.personal@kite.example' && (await emailsOf(mia)).filter((e) => e.is_primary).length === 1);
    await db.query("UPDATE contacts SET email='mia.new@kite.example' WHERE id=$1", [mia]);
    check('contact_emails: editing contacts.email edits the primary address', JSON.stringify(await emailsOf(mia)) === JSON.stringify([{ email: 'mia.new@kite.example', is_primary: true }, { email: 'mia@kite.example', is_primary: false }]), await emailsOf(mia));
    await db.query("UPDATE contacts SET email='mia@kite.example' WHERE id=$1", [mia]);
    check('contact_emails: setting an existing address promotes it', (await emailsOf(mia)).find((e) => e.email === 'mia@kite.example')?.is_primary === true);
    await db.query("DELETE FROM contact_emails WHERE contact_id=$1 AND is_primary", [mia]);
    check('contact_emails: removing the primary clears contacts.email', (await contactEmail(mia)) === '');
    await db.query("INSERT INTO contacts(name, email) VALUES ('Shared inbox','dana@acme-roofing.example')");
    check('contact_emails: one address may belong to several contacts', (await rows(db, "SELECT 1 FROM contact_emails WHERE email='dana@acme-roofing.example'")).length === 2);
    const [legacy] = await rows(db, "INSERT INTO contacts(name, email) VALUES ('Legacy','n/a') RETURNING id, email");
    check('contact_emails: legacy text that is not an address is left alone', legacy.email === 'n/a' && (await emailsOf(legacy.id)).length === 0);

    // ---- Inbox UI (session routes' services, people only) ---------------
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const inbox = await import('../src/lib/inbound-email/inbox-service');
    const inboxSettings = await import('../src/lib/inbound-email/inbox-settings-service');
    const service = getServiceClient();
    type Access = import('../src/lib/access-control').AccessContext;
    const person = (memberId: string, role: Access['role'], app: Access['app_permissions'], projectIds: string[] = []) =>
      ({ service, memberId, access: { member_id: memberId, role, status: 'active' as const, app_permissions: app, api_permissions: [], project_ids: projectIds } });
    const failsWith = async (work: () => Promise<unknown>) => {
      try { await work(); return 0; } catch (error) { return error instanceof inbox.InboxError ? error.status : -1; }
    };
    const readerId = randomUUID();
    const outsiderId = randomUUID();
    await db.query("INSERT INTO team_members(id, name, role) VALUES ($1,'Rae','member'),($2,'Otto','member')", [readerId, outsiderId]);
    await db.query("UPDATE team_members SET email = 'owner@agency.example' WHERE id = $1", [ids.owner]);
    const owner = person(ids.owner, 'owner', ['*']);
    const reader = person(readerId, 'member', ['inbound_email.read', 'projects.read'], [ids.acme]);
    const outsider = person(outsiderId, 'member', ['projects.read_all']);
    const allThreads = { inboxId: null, projectId: null, tab: 'all' as const, search: '', limit: 200, offset: 0 };

    const ownerList = await inbox.listThreads(owner, allThreads);
    const threadCount = (await rows(db, "SELECT count(DISTINCT thread_id)::int AS n FROM email_messages WHERE status <> 'receiving'"))[0].n;
    const sortedDesc = ownerList.threads.every((t, i, list) => i === 0 || list[i - 1].last_message_at >= t.last_message_at);
    check('inbox ui: manage sees every thread in every inbox, newest activity first', ownerList.total === threadCount && ownerList.counts.all === threadCount
      && sortedDesc && ownerList.inboxes.length === 2, { total: ownerList.total, threadCount, sortedDesc });
    const byId = (list: typeof ownerList, threadId: string) => list.threads.find((t) => t.id === threadId);
    check('inbox ui: needs you (untrusted, needs_ciaran) and needs reply read from messages and triage',
      byId(ownerList, forward.thread_id)?.needs_you === true && byId(ownerList, forward.thread_id)?.urgent === true
      && byId(ownerList, outlook.thread_id)?.untrusted === true && byId(ownerList, outlook.thread_id)?.state === 'needs_you'
      && byId(ownerList, htmlOnly.thread_id)?.needs_reply === true, ownerList.threads.map((t) => [t.subject, t.state]));
    const needsReplyTab = await inbox.listThreads(owner, { ...allThreads, tab: 'needs_reply' });
    check('inbox ui: a status tab filters and the counts agree', needsReplyTab.threads.every((t) => t.needs_reply) && needsReplyTab.total === ownerList.counts.needs_reply && needsReplyTab.total >= 1);
    const ignoredTab = await inbox.listThreads(owner, { ...allThreads, tab: 'ignored' });
    const allIgnored = (await rows(db, "SELECT count(*)::int AS n FROM (SELECT thread_id FROM email_messages WHERE status <> 'receiving' GROUP BY thread_id HAVING bool_and(status = 'ignored')) t"))[0].n;
    check('inbox ui: auto-mail threads sit under Ignored, never Unassigned', allIgnored >= 1 && ignoredTab.total === allIgnored && ignoredTab.threads.every((t) => t.state === 'ignored')
      && (await inbox.listThreads(owner, { ...allThreads, tab: 'unassigned' })).threads.every((t) => t.state !== 'ignored' && !t.project), { allIgnored, ignored: ignoredTab.total });
    const searched = await inbox.listThreads(owner, { ...allThreads, search: 'birch' });
    check('inbox ui: search matches the project name and sender', searched.threads.some((t) => t.id === outlook.thread_id) && searched.total < ownerList.total, searched.threads.map((t) => t.subject));
    const birchOnly = await inbox.listThreads(owner, { ...allThreads, projectId: ids.birch });
    check('inbox ui: project filter', birchOnly.total >= 1 && birchOnly.threads.every((t) => t.project?.id === ids.birch));
    check('inbox ui: the sidebar count is threads waiting on a person', (await inbox.attentionCount(owner)) === ownerList.threads.filter((t) => t.needs_you || t.needs_reply).length);

    check('inbox ui: a reader with no inbox grant sees nothing and cannot open a thread',
      (await inbox.listThreads(reader, allThreads)).total === 0 && (await failsWith(() => inbox.threadDetail(reader, orig.thread_id))) === 404);
    check('inbox ui: no inbox permission is 403', (await failsWith(() => inbox.listThreads(outsider, allThreads))) === 403);
    await db.query('INSERT INTO email_inbox_access(inbox_id, member_id) VALUES ($1,$2)', [ids.inboxA, readerId]);
    const readerList = await inbox.listThreads(reader, allThreads);
    check('inbox ui: a granted reader sees only that inbox; another inbox is 403', readerList.total > 0 && readerList.threads.every((t) => t.inbox_id === ids.inboxA)
      && readerList.inboxes.length === 1 && (await failsWith(() => inbox.listThreads(reader, { ...allThreads, inboxId: ids.inboxB }))) === 403);

    const thread = await inbox.threadDetail(owner, orig.thread_id);
    const replyMessage = thread.messages.find((m) => m.id === reply.id);
    check('inbox ui: thread detail oldest first, with triage, linked tasks and the inferred project', thread.messages[0].id === orig.id
      && replyMessage?.triage?.outcome === 'task' && replyMessage.linked_tasks.some((l) => l.task_id === acmeTask)
      && thread.project?.id === ids.acme && thread.project.source === 'inferred' && thread.candidates.length === 2, { p: thread.project, c: thread.candidates });
    check('inbox ui: teammates and inboxes are never offered as senders to remember',
      !thread.senders.some((s) => s.address === 'owner@agency.example') && thread.senders.some((s) => s.address === 'dana@acme-roofing.example' && s.contact_ids.includes(ids.dana)),
      thread.senders);
    check('inbox ui: a thread sent only by a teammate has no sender to remember', (await inbox.threadDetail(owner, forward.thread_id)).senders.length === 0);

    const pngId = (await rows(db, "SELECT id FROM email_attachments WHERE message_id=$1 AND filename='truck.png'", [many.id]))[0].id;
    const link = await inbox.attachmentDownloadUrl(owner, pngId);
    check('inbox ui: an attachment downloads through a one-minute signed URL', /\/storage\/v1\/object\/sign\/inbound-email\//.test(link.url) && link.expires_in === 60, link);
    check('inbox ui: a skipped attachment is 409; another member without the inbox gets 404',
      (await failsWith(() => inbox.attachmentDownloadUrl(owner, bigAttachments[0].id))) === 409
      && (await failsWith(() => inbox.attachmentDownloadUrl(person(outsiderId, 'member', ['inbound_email.read']), pngId))) === 404);

    await inbox.markThreadHandled(owner, htmlOnly.thread_id);
    const [handledRow] = await rows(db, 'SELECT status, reviewed_at, reviewed_by FROM email_messages WHERE id=$1', [htmlOnly.id]);
    const afterHandled = await inbox.listThreads(owner, allThreads);
    check('inbox ui: mark handled reviews the message, which clears Needs reply', handledRow.status === 'handled' && !!handledRow.reviewed_at && handledRow.reviewed_by === ids.owner
      && byId(afterHandled, htmlOnly.thread_id)?.needs_reply === false && byId(afterHandled, htmlOnly.thread_id)?.state === 'handled', handledRow);
    await inbox.markThreadHandled(owner, forward.thread_id);
    check('inbox ui: mark handled moves needs_ciaran to handled', (await rows(db, 'SELECT status FROM email_messages WHERE id=$1', [forward.id]))[0].status === 'handled');
    const sentBack = await inbox.sendBackToAgent(owner, htmlOnly.thread_id, null);
    const [backRow] = await rows(db, 'SELECT status, reviewed_at FROM email_messages WHERE id=$1', [htmlOnly.id]);
    check('inbox ui: send back makes the newest message New for the agent, unreviewed; twice is 409', sentBack.message_id === htmlOnly.id && backRow.status === 'new' && backRow.reviewed_at === null
      && (await failsWith(() => inbox.sendBackToAgent(owner, htmlOnly.thread_id, null))) === 409, backRow);
    const ignoredId = (await rows(db, "SELECT id, thread_id FROM email_messages WHERE status='ignored' LIMIT 1"))[0];
    await inbox.sendBackToAgent(owner, ignoredId.thread_id, ignoredId.id);
    check('inbox ui: an ignored message can be sent to the agent', (await rows(db, 'SELECT status FROM email_messages WHERE id=$1', [ignoredId.id]))[0].status === 'new');

    const carla = 'carla.mendes@gmail.com';
    check('inbox ui: an agent never creates a mapping (rule 7)', (await failsWith(() => inbox.setThreadProject(person(ids.ashley, 'agent', ['*']), htmlOnly.thread_id,
      { project_id: ids.acme, remember_sender: { address: carla, project_ids: [ids.acme] } }))) === 403);
    check('inbox ui: a public webmail domain cannot be remembered', (await failsWith(() => inbox.setThreadProject(owner, htmlOnly.thread_id,
      { project_id: ids.acme, remember_domain: { domain: 'gmail.com', project_ids: [ids.acme] } }))) === 422);
    check('inbox ui: only a sender of this thread can be remembered', (await failsWith(() => inbox.setThreadProject(owner, htmlOnly.thread_id,
      { project_id: ids.acme, remember_sender: { address: 'stranger@example.com', project_ids: [ids.acme] } }))) === 422);
    check('inbox ui: a project outside the member\'s reach is 403', (await failsWith(() => inbox.setThreadProject(person(readerId, 'member', ['inbound_email.read', 'projects.read', 'contacts.manage'], [ids.acme]), orig.thread_id,
      { project_id: ids.birch }))) === 403);
    const remembered = await inbox.setThreadProject(owner, htmlOnly.thread_id, { project_id: ids.acme, remember_sender: { address: carla, project_ids: [ids.acme, ids.acme2] } });
    const [htmlThread] = await rows(db, 'SELECT project_id, project_source FROM email_threads WHERE id=$1', [htmlOnly.thread_id]);
    const carlaLinks = await rows(db, 'SELECT pc.project_id FROM project_contacts pc JOIN contact_emails ce ON ce.contact_id = pc.contact_id WHERE ce.email=$1 ORDER BY pc.project_id', [carla]);
    check('inbox ui: set project (set by a person) and remember the sender as a contact on each project', htmlThread.project_id === ids.acme && htmlThread.project_source === 'ciaran'
      && remembered.remembered_sender?.created_contact === true && carlaLinks.length === 2, { htmlThread, remembered, carlaLinks });
    const again = await inbox.setThreadProject(owner, htmlOnly.thread_id, { project_id: ids.acme, remember_sender: { address: carla, project_ids: [ids.acme] } });
    check('inbox ui: remembering again reuses the contact and adds nothing', again.remembered_sender?.created_contact === false && again.remembered_sender.linked_project_ids.length === 0);
    // Put the thread back where the deleted-project check below expects it.
    await db.query("UPDATE email_threads SET project_id = $1, project_source = 'inferred' WHERE id = $2", [ids.other, htmlOnly.thread_id]);
    const domain = await inbox.setThreadProject(owner, outlook.thread_id, { project_id: ids.birch, remember_domain: { domain: 'birchpartners.example', project_ids: [ids.birch, ids.acme2] } });
    check('inbox ui: remember the domain adds only the missing project', JSON.stringify(domain.remembered_domain?.added_project_ids) === JSON.stringify([ids.acme2])
      && (await rows(db, "SELECT 1 FROM email_client_domains WHERE domain='birchpartners.example'")).length === 2, domain);

    const sources = await inbox.taskSourceEmails(owner, acmeTask);
    check('inbox ui: a task lists its source emails', sources.link_count >= 1 && sources.emails.some((e) => e.message_id === reply.id && e.thread_id === orig.thread_id), sources);
    const hiddenSources = await inbox.taskSourceEmails(person(outsiderId, 'member', ['projects.read_all']), acmeTask);
    check('inbox ui: without the inbox a task still counts its links (rule 3) but shows none', hiddenSources.link_count === sources.link_count && hiddenSources.emails.length === 0);

    // Settings.
    const manage = person(ids.owner, 'owner', ['*']);
    check('settings: listing inboxes needs inbound_email.manage', (await failsWith(() => inboxSettings.listInboxSettings(reader))) === 403);
    const baseInput = {
      name: 'Support', address: 'Support@Agency.example', routing_local_part: '', routing_domain: '', handler_member_id: ids.jeff, enabled: true,
      retention_days: 30, max_attachment_mb: 10, agent_readable_types: ['pdf' as const], summary_interval_minutes: 15, filter_auto_mail: true, access_member_ids: [readerId],
    };
    const created = await inboxSettings.createInbox(manage, baseInput);
    check('settings: a new inbox takes its routing address from the address and the relay domain; the handler can read it', created.routing_address === `support@${RELAY}`
      && created.address === 'support@agency.example' && created.access_member_ids.includes(ids.jeff) && created.access_member_ids.includes(readerId) && !created.verified_at, created);
    await db.query('UPDATE email_inboxes SET verified_at = now() WHERE id=$1', [created.id]);
    const moved = await inboxSettings.updateInbox(manage, created.id, { ...baseInput, routing_local_part: 'help', access_member_ids: [] });
    check('settings: a new routing address clears verification; access can be narrowed (the handler stays)', moved.routing_address === `help@${RELAY}` && moved.verified_at === null
      && JSON.stringify(moved.access_member_ids) === JSON.stringify([ids.jeff]), moved);
    check('settings: a taken routing address is 409', (await failsWith(() => inboxSettings.createInbox(manage, { ...baseInput, address: 'other@agency.example', routing_local_part: 'help' }))) === 409);
    const listedSettings = await inboxSettings.listInboxSettings(manage);
    check('settings: list shows message counts and the relay domain', listedSettings.relay_domain === RELAY && (listedSettings.inboxes.find((i) => i.id === ids.inboxA)?.message_count ?? 0) > 0);
    await inboxSettings.setRelayDomain(manage, 'Mail.Next.test');
    check('settings: the relay domain changes the default only', (await rows(db, 'SELECT inbound_email_domain FROM business_settings'))[0].inbound_email_domain === 'mail.next.test'
      && (await rows(db, 'SELECT routing_domain FROM email_inboxes WHERE id=$1', [created.id]))[0].routing_domain === RELAY);
    await inboxSettings.setRelayDomain(manage, RELAY);
    const found = await inboxSettings.lookupMx(manage, RELAY, async () => [{ exchange: 'b.mx.test', priority: 20 }, { exchange: 'a.mx.test', priority: 10 }]);
    const missing = await inboxSettings.lookupMx(manage, RELAY, async () => { throw Object.assign(new Error('no'), { code: 'ENOTFOUND' }); });
    check('settings: MX lookup found (by priority) and missing', found.found && found.records[0].exchange === 'a.mx.test' && !missing.found && missing.error === null, [found, missing]);

    // Client email domains.
    check('domains: a public webmail domain is refused before the database', (await failsWith(() => inboxSettings.addClientDomain(manage, ids.acme, 'gmail.com'))) === 422);
    const added = await inboxSettings.addClientDomain(manage, ids.acme, '@Acme-Roofing.example');
    check('domains: added lowercased, a duplicate is 409', added.domain === 'acme-roofing.example' && (await failsWith(() => inboxSettings.addClientDomain(manage, ids.acme, 'acme-roofing.example'))) === 409);
    check('domains: reading needs contacts or inbox access; writing needs manage', (await failsWith(() => inboxSettings.addClientDomain(reader, ids.acme, 'x-corp.example'))) === 403
      && (await inboxSettings.listClientDomains(reader, ids.acme)).some((d) => d.id === added.id));
    await inboxSettings.removeClientDomain(manage, ids.acme, added.id);
    check('domains: removed, and removing again is 404', (await inboxSettings.listClientDomains(manage, ids.acme)).every((d) => d.id !== added.id)
      && (await failsWith(() => inboxSettings.removeClientDomain(manage, ids.acme, added.id))) === 404);

    // A deleted project leaves the thread unassigned, cleanly.
    await db.query('DELETE FROM projects WHERE id=$1', [ids.other]);
    const [orphaned] = await rows(db, 'SELECT project_id, project_source FROM email_threads WHERE id=$1', [htmlOnly.thread_id]);
    check('threads: a deleted project clears project and source', orphaned.project_id === null && orphaned.project_source === null, orphaned);

    // Deletes: no agent route deletes anything.
    check('no deletes: no inbound email route exports DELETE', [list, detail, attachmentUrl, attachmentLabel, triage, unsummarized, markSummarized, signal, webhook].every((m) => !('DELETE' in m)));
    await settle();
  } finally {
    uninstall();
    await server.close();
    await db.close();
  }

  // The schema.sql snapshot stands on its own.
  const snapshot = await createEmailDatabase('schema');
  check('schema.sql: the inbound email section loads', (await rows(snapshot, "SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'email_%' OR tablename = 'contact_emails'"))[0].n === 12);
  await snapshot.close();

  if (failures.length) {
    console.error(`inbound email: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`inbound email: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
