/**
 * Inbound email retention and the orphan sweep, against the real migration
 * in PGlite behind fake-postgrest with an in-memory Storage:
 * - the cron routes refuse requests without the right CRON_SECRET bearer;
 * - retention deletes files first, then rows (checked at the moment Storage
 *   is asked), per inbox retention_days, stuck receiving rows over 24 h,
 *   threads left empty, never tasks;
 * - a Storage failure leaves that message's rows and files, and the next run
 *   resumes; the batch budget leaves the rest for the next run;
 * - the orphan sweep deletes only objects no row owns, keeps a young
 *   receiving message's files and paths it does not recognize;
 * - each run is recorded in email_maintenance_runs.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-inbound-email-retention.ts
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

const BUCKET = 'inbound-email';
const CRON_SECRET = 'cron-secret-for-tests-0123456789abcdef';
const ids = { owner: randomUUID(), project: randomUUID(), contact: randomUUID(), inboxA: randomUUID(), inboxB: randomUUID() };

async function rows<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

interface Made { id: string; thread: string | null; paths: string[] }

/** A message with its rows and files. Ages: received `days` ago, row created `createdHours` ago. */
async function makeMessage(db: PGlite, storage: FakeStorage, options: {
  inbox: string; status?: string; days: number; createdHours?: number; thread?: string | null; newThread?: boolean;
  attachments?: number; raw?: boolean; triage?: boolean; task?: string;
}): Promise<Made> {
  const id = randomUUID();
  const status = options.status ?? 'new';
  let thread = options.thread ?? null;
  if (!thread && options.newThread !== false && status !== 'receiving') {
    thread = (await rows(db, "INSERT INTO email_threads(inbox_id, subject_normalized) VALUES ($1, 'subject') RETURNING id", [options.inbox]))[0].id;
  }
  const raw = options.raw !== false ? `${options.inbox}/${id}/raw.eml` : null;
  await db.query(
    `INSERT INTO email_messages(id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id, subject,
       received_at, created_at, raw_storage_path, completed_at)
     VALUES ($1::uuid,$2,$3,$4::text,'test',$1::text,$1::text || '@test.example','Subject',
       now() - make_interval(days => $5::int), now() - make_interval(hours => $6::int), $7,
       CASE WHEN $4::text = 'receiving' THEN NULL ELSE now() END)`,
    [id, options.inbox, thread, status, options.days, options.createdHours ?? options.days * 24, raw],
  );
  const paths = raw ? [raw] : [];
  for (let position = 0; position < (options.attachments ?? 0); position++) {
    const attachment = randomUUID();
    const path = `${options.inbox}/${id}/${attachment}`;
    await db.query('INSERT INTO email_attachments(id, message_id, position, filename, storage_path) VALUES ($1,$2,$3,$4,$5)', [attachment, id, position, `file-${position}.pdf`, path]);
    paths.push(path);
  }
  for (const path of paths) storage.objects.set(`${BUCKET}/${path}`, { bytes: Buffer.from(`bytes of ${path}`), contentType: 'application/octet-stream' });
  await db.query("INSERT INTO email_message_recipients(message_id, kind, address, contact_id) VALUES ($1,'from','dana@client.example',$2),($1,'to','ashley@relay.example',NULL)", [id, ids.contact]);
  await db.query("INSERT INTO email_message_candidates(message_id, project_id, reason) VALUES ($1,$2,'contact')", [id, ids.project]);
  if (options.triage) {
    const triage = (await rows(db, "INSERT INTO email_triage(message_id, outcome, summary) VALUES ($1,'task','Did a thing') RETURNING id", [id]))[0].id;
    if (options.task) await db.query("INSERT INTO email_task_links(message_id, task_id, relation, triage_id) VALUES ($1,$2,'created',$3)", [id, options.task, triage]);
  }
  return { id, thread, paths };
}

async function main() {
  const db = await createEmailDatabase();
  await db.query(`INSERT INTO team_members(id, name, role) VALUES ($1,'Sam','owner')`, [ids.owner]);
  await db.query(`INSERT INTO projects(id, name) VALUES ($1,'Acme')`, [ids.project]);
  await db.query(`INSERT INTO contacts(id, name, email) VALUES ($1,'Dana','dana@client.example')`, [ids.contact]);
  await db.query(`INSERT INTO email_inboxes(id, name, address, retention_days) VALUES ($1,'Ashley','ashley@agency.example',90),($2,'Billing','billing@agency.example',7)`, [ids.inboxA, ids.inboxB]);
  const task = (await rows(db, "INSERT INTO tasks(project_id, title, description, created_by) VALUES ($1,'From an email','Every detail copied here',$2) RETURNING id", [ids.project, ids.owner]))[0].id as string;

  const storage = new FakeStorage();
  const server = await startFakePostgrest(db, { handle: storage.handler });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url,
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key',
    CRON_SECRET,
  });
  const supabase = createClient(server.url, 'fake-service-key', { auth: { persistSession: false } });
  const exists = (path: string) => storage.objects.has(`${BUCKET}/${path}`);
  const messageExists = async (id: string) => (await rows(db, 'SELECT 1 FROM email_messages WHERE id=$1', [id])).length === 1;
  const lastRun = async (kind: string) => (await rows(db, 'SELECT * FROM email_maintenance_runs WHERE kind=$1', [kind]))[0];

  try {
    const { runRetention, runOrphanSweep } = await import('../src/lib/inbound-email/retention');
    const retentionRoute = await import('../src/app/api/internal/inbound-email/retention/route');
    const sweepRoute = await import('../src/app/api/internal/inbound-email/orphan-sweep/route');
    const call = async (route: { GET: (r: Request) => Promise<Response> }, path: string, authorization?: string) => {
      const response = await route.GET(new Request(`http://localhost${path}`, { headers: authorization ? { authorization } : {} }));
      return { status: response.status, body: (await response.json()) as Row };
    };

    // ---- Auth -----------------------------------------------------------
    const bare = await call(retentionRoute, '/api/internal/inbound-email/retention');
    const wrong = await call(retentionRoute, '/api/internal/inbound-email/retention', 'Bearer not-the-secret-at-all');
    const notBearer = await call(sweepRoute, '/api/internal/inbound-email/orphan-sweep', CRON_SECRET);
    const wrongSweep = await call(sweepRoute, '/api/internal/inbound-email/orphan-sweep', `Bearer ${CRON_SECRET}x`);
    check('auth: no header, a wrong secret or a bare secret is 401', bare.status === 401 && wrong.status === 401 && notBearer.status === 401 && wrongSweep.status === 401,
      [bare.status, wrong.status, notBearer.status, wrongSweep.status]);
    delete process.env.CRON_SECRET;
    const off = await call(retentionRoute, '/api/internal/inbound-email/retention', `Bearer ${CRON_SECRET}`);
    process.env.CRON_SECRET = 'short';
    const weak = await call(retentionRoute, '/api/internal/inbound-email/retention', 'Bearer short');
    process.env.CRON_SECRET = CRON_SECRET;
    check('auth: without CRON_SECRET the routes are off (404); a too-short secret is 503', off.status === 404 && weak.status === 503, [off.status, weak.status]);
    check('auth: refused requests ran nothing', (await rows(db, 'SELECT 1 FROM email_maintenance_runs')).length === 0);

    // ---- Retention ------------------------------------------------------
    const oldAlone = await makeMessage(db, storage, { inbox: ids.inboxA, days: 100, attachments: 2, triage: true, task });
    const oldInThread = await makeMessage(db, storage, { inbox: ids.inboxA, days: 100, attachments: 1 });
    const youngInThread = await makeMessage(db, storage, { inbox: ids.inboxA, days: 5, thread: oldInThread.thread });
    const keptA = await makeMessage(db, storage, { inbox: ids.inboxA, days: 30, attachments: 1, status: 'handled', triage: true });
    const oldB = await makeMessage(db, storage, { inbox: ids.inboxB, days: 30, attachments: 1, status: 'ignored' });
    const youngB = await makeMessage(db, storage, { inbox: ids.inboxB, days: 3 });
    const stuck = await makeMessage(db, storage, { inbox: ids.inboxA, status: 'receiving', days: 2, createdHours: 30, attachments: 1 });
    const receivingYoung = await makeMessage(db, storage, { inbox: ids.inboxA, status: 'receiving', days: 200, createdHours: 2, attachments: 1 });
    const tasksBefore = (await rows(db, 'SELECT id, title, description, status FROM tasks ORDER BY id'));

    // Files first: whenever Storage is asked to delete, every row that owns
    // one of those paths must still be there.
    const orderViolations: string[] = [];
    let removeCalls = 0;
    storage.onRemove = async (paths) => {
      removeCalls++;
      for (const path of paths) {
        const owned = await rows(db, 'SELECT 1 FROM email_messages WHERE raw_storage_path=$1 UNION ALL SELECT 1 FROM email_attachments WHERE storage_path=$1', [path]);
        if (owned.length === 0) orderViolations.push(path);
      }
    };

    const first = await call(retentionRoute, '/api/internal/inbound-email/retention', `Bearer ${CRON_SECRET}`);
    const s1 = first.body;
    check('retention: the route runs with the right bearer', first.status === 200 && s1.kind === 'retention' && s1.outcome === 'complete', s1);
    check('retention: files are deleted while their rows still exist', removeCalls > 0 && orderViolations.length === 0, orderViolations);
    check('retention: messages past retention_days and stuck receiving are gone', !(await messageExists(oldAlone.id)) && !(await messageExists(oldInThread.id))
      && !(await messageExists(oldB.id)) && !(await messageExists(stuck.id)));
    check('retention: their files are gone', [...oldAlone.paths, ...oldInThread.paths, ...oldB.paths, ...stuck.paths].every((path) => !exists(path)));
    check('retention: per inbox retention_days (30 days kept at 90, gone at 7)', await messageExists(keptA.id) && keptA.paths.every(exists) && !(await messageExists(oldB.id)));
    check('retention: recent messages are kept with their files', await messageExists(youngInThread.id) && await messageExists(youngB.id) && [...youngInThread.paths, ...youngB.paths].every(exists));
    check('retention: a receiving row under 24 h old is kept, however old its received_at', await messageExists(receivingYoung.id) && receivingYoung.paths.every(exists));
    const leftovers = await rows(db, `SELECT 'attachments' AS t FROM email_attachments WHERE message_id = ANY($1::uuid[])
      UNION ALL SELECT 'triage' FROM email_triage WHERE message_id = ANY($1::uuid[])
      UNION ALL SELECT 'links' FROM email_task_links WHERE message_id = ANY($1::uuid[])
      UNION ALL SELECT 'recipients' FROM email_message_recipients WHERE message_id = ANY($1::uuid[])
      UNION ALL SELECT 'candidates' FROM email_message_candidates WHERE message_id = ANY($1::uuid[])`,
      [[oldAlone.id, oldInThread.id, oldB.id, stuck.id]]);
    check('retention: attachments, triage, task links, recipients and candidates go with the message', leftovers.length === 0, leftovers);
    check('retention: a thread left empty is dropped; a thread with a recent message stays',
      (await rows(db, 'SELECT 1 FROM email_threads WHERE id = ANY($1::uuid[])', [[oldAlone.thread, oldB.thread]])).length === 0
      && (await rows(db, 'SELECT 1 FROM email_threads WHERE id = $1', [oldInThread.thread])).length === 1);
    check('retention: tasks keep their own content', JSON.stringify(await rows(db, 'SELECT id, title, description, status FROM tasks ORDER BY id')) === JSON.stringify(tasksBefore));
    check('retention: counts', s1.messages_deleted === 3 && s1.stuck_deleted === 1 && s1.threads_deleted === 2 && s1.files_deleted === 3 + 2 + 2 + 2 && s1.failures === 0
      && s1.by_inbox[ids.inboxA]?.messages_deleted === 2 && s1.by_inbox[ids.inboxA]?.stuck_deleted === 1 && s1.by_inbox[ids.inboxB]?.messages_deleted === 1, s1);
    const run1 = await lastRun('retention');
    check('retention: the run is recorded', run1?.outcome === 'complete' && run1.messages_deleted === 3 && run1.stuck_deleted === 1 && run1.threads_deleted === 2 && run1.more_pending === false && !!run1.finished_at, run1);
    storage.onRemove = undefined;

    const again = await runRetention(supabase);
    check('retention: re-running with nothing due deletes nothing', again.outcome === 'complete' && again.messages_deleted === 0 && again.stuck_deleted === 0 && again.files_deleted === 0
      && await messageExists(keptA.id) && keptA.paths.every(exists), again);

    // A Storage failure holds back only that message, and the next run resumes.
    const flakyA = await makeMessage(db, storage, { inbox: ids.inboxA, days: 120, attachments: 2, triage: true });
    const fineA = await makeMessage(db, storage, { inbox: ids.inboxA, days: 110, attachments: 1 });
    const fineB = await makeMessage(db, storage, { inbox: ids.inboxB, days: 10 });
    storage.failRemove.add(flakyA.paths[1]);
    const partial = await runRetention(supabase, { batchSize: 2 });
    check('failure: the message whose file failed keeps its rows and files', await messageExists(flakyA.id) && flakyA.paths.every(exists)
      && (await rows(db, 'SELECT 1 FROM email_attachments WHERE message_id=$1', [flakyA.id])).length === 2
      && (await rows(db, 'SELECT 1 FROM email_triage WHERE message_id=$1', [flakyA.id])).length === 1
      && (await rows(db, 'SELECT 1 FROM email_threads WHERE id=$1', [flakyA.thread])).length === 1);
    check('failure: the rest of the batch still goes', !(await messageExists(fineA.id)) && !(await messageExists(fineB.id)) && [...fineA.paths, ...fineB.paths].every((path) => !exists(path)));
    check('failure: counted and reported as partial', partial.outcome === 'partial' && partial.failures === 1 && partial.failed_message_ids[0] === flakyA.id
      && partial.messages_deleted === 2 && /storage delete failed/.test(partial.last_error ?? ''), partial);
    const run2 = await lastRun('retention');
    check('failure: the recorded run says partial with the error', run2.outcome === 'partial' && run2.failures === 1 && /storage delete failed/.test(run2.last_error ?? ''), run2);
    storage.failRemove.clear();
    const resumed = await runRetention(supabase, { batchSize: 2 });
    check('failure: the next run resumes and finishes', resumed.outcome === 'complete' && resumed.messages_deleted === 1 && !(await messageExists(flakyA.id))
      && flakyA.paths.every((path) => !exists(path)) && (await rows(db, 'SELECT 1 FROM email_threads WHERE id=$1', [flakyA.thread])).length === 0, resumed);

    // Bounded batches: a run stops at its budget and says more is pending.
    const many = [];
    for (let i = 0; i < 5; i++) many.push(await makeMessage(db, storage, { inbox: ids.inboxB, days: 40 + i, attachments: 1 }));
    const bounded = await runRetention(supabase, { batchSize: 2, maxMessages: 3 });
    const remaining = (await Promise.all(many.map((m) => messageExists(m.id)))).filter(Boolean).length;
    check('batches: a run handles at most its budget, oldest first, and says more is pending', bounded.outcome === 'partial' && bounded.more_pending && bounded.messages_deleted === 3
      && remaining === 2 && !(await messageExists(many[4].id)) && await messageExists(many[0].id), { bounded, remaining });
    check('batches: the recorded run says more_pending', (await lastRun('retention')).more_pending === true);
    const timed = await runRetention(supabase, { budgetMs: 0 });
    check('batches: an exhausted time budget starts nothing', timed.messages_deleted === 0 && timed.more_pending && remaining === 2, timed);
    const rest = await runRetention(supabase, { batchSize: 2 });
    check('batches: the next run takes the rest', rest.outcome === 'complete' && rest.messages_deleted === 2 && many.every((m) => m.paths.every((path) => !exists(path))), rest);

    // ---- Orphan sweep ---------------------------------------------------
    const kept = [...keptA.paths, ...youngInThread.paths, ...youngB.paths, ...receivingYoung.paths];
    const orphanInMessage = `${ids.inboxA}/${keptA.id}/${randomUUID()}`;
    const orphanNoMessage = `${ids.inboxA}/${randomUUID()}/raw.eml`;
    const orphanOtherInbox = `${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    const youngReceivingExtra = `${ids.inboxA}/${receivingYoung.id}/${randomUUID()}`;
    const stray = 'notes/readme.txt';
    for (const path of [orphanInMessage, orphanNoMessage, orphanOtherInbox, youngReceivingExtra, stray]) {
      storage.objects.set(`${BUCKET}/${path}`, { bytes: Buffer.from(path), contentType: 'text/plain' });
    }
    const listedBefore = storage.listCalls;
    const sweptBefore = [...storage.objects.keys()].filter((key) => key.startsWith(`${BUCKET}/`)).length;
    const sweep = await runOrphanSweep(supabase, { batchSize: 3 });
    check('sweep: deletes objects no row owns', [orphanInMessage, orphanNoMessage, orphanOtherInbox].every((path) => !exists(path)) && sweep.files_deleted === 3, sweep);
    check('sweep: keeps every file a row owns', kept.every(exists), kept.filter((path) => !exists(path)));
    check('sweep: keeps files under a message still receiving (under 24 h)', exists(youngReceivingExtra));
    check('sweep: leaves unexpected paths alone and counts them', exists(stray) && sweep.unrecognized === 1);
    check('sweep: pages through the whole bucket', sweep.objects_scanned === sweptBefore && storage.listCalls - listedBefore >= 3 && sweep.outcome === 'complete', { sweep, calls: storage.listCalls - listedBefore });
    const sweepRun = await lastRun('orphan_sweep');
    check('sweep: the run is recorded', sweepRun?.outcome === 'complete' && sweepRun.files_deleted === 3 && sweepRun.objects_scanned === sweptBefore, sweepRun);
    const viaRoute = await call(sweepRoute, '/api/internal/inbound-email/orphan-sweep', `Bearer ${CRON_SECRET}`);
    check('sweep: the route runs with the right bearer; a second sweep finds nothing', viaRoute.status === 200 && viaRoute.body.files_deleted === 0 && viaRoute.body.outcome === 'complete', viaRoute.body);

    // Once the receiving row is over 24 h old, its unclaimed file is an orphan
    // (its claimed files go with the row in retention).
    await db.query("UPDATE email_messages SET created_at = now() - interval '25 hours' WHERE id=$1", [receivingYoung.id]);
    const later = await runOrphanSweep(supabase);
    check('sweep: an old receiving row protects only its own paths', !exists(youngReceivingExtra) && receivingYoung.paths.every(exists) && later.files_deleted === 1, later);

    // Only the service role may run the database side.
    let refused = '';
    try { await db.query("SELECT public.email_retention_delete($1::jsonb)", [JSON.stringify([keptA.id])]); } catch (error) { refused = (error as Error).message; }
    check('database: retention functions need the service role', /Service role required/.test(refused) && await messageExists(keptA.id), refused);
  } finally {
    await server.close();
    await db.close();
  }

  // The schema.sql snapshot carries the same functions.
  const snapshot = await createEmailDatabase('schema');
  const fns = await rows(snapshot, "SELECT proname FROM pg_proc WHERE proname IN ('email_retention_due','email_retention_delete','email_storage_known_paths','email_record_maintenance_run')");
  check('schema.sql: the retention section loads', fns.length === 4 && (await rows(snapshot, "SELECT 1 FROM pg_tables WHERE tablename='email_maintenance_runs'")).length === 1);
  await snapshot.close();

  if (failures.length) {
    console.error(`inbound email retention: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`inbound email retention: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
