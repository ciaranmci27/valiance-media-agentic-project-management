/**
 * A message's project scope, in the database (schema.sql on PGlite):
 * - each basis: the conversation's projects (a guess only for a teammate),
 *   the project addresses it came through, its sender's mappings, a verified
 *   teammate, verified meeting notes, a person's answer on that very email;
 * - a stranger touches nothing; a finished project only when already filed;
 * - record_triage files every named project and every linked task's, or
 *   nothing at all when one is out of scope; sources only ever get stronger;
 * - link_message_task and file_message_project, a person's link anywhere;
 * - the copy on conversations follows the strongest project;
 * - message_scope as the agent reads it; nobody but the service role runs any of it.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-conversation-scope.ts
 */
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase } from './full-schema-db';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  owner: id(1), ashley: id(2), tom: id(3),
  acme: id(10), birch: id(11), cobalt: id(12), delta: id(13),
  inbox: id(20), hi: id(21),
  task: { acme: id(30), birch: id(31), cobalt: id(32), delta: id(33) },
};
let next = 100;

type Row = Record<string, unknown>;
const rows = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Row>(sql, params)).rows;
const one = async (db: PGlite, sql: string, params: unknown[] = []) => (await rows(db, sql, params))[0];
async function fails(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.exec('SAVEPOINT attempt');
    await db.query(sql, params);
    await db.exec('RELEASE SAVEPOINT attempt');
    return '';
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT attempt');
    return (error as Error).message;
  }
}

/** A conversation with one message; returns both ids. */
async function message(db: PGlite, fields: {
  conversation?: string; candidates?: string[]; endpoint?: boolean; teammate?: boolean; kind?: string; verified?: boolean; receivedAt?: string;
} = {}) {
  const conversation = fields.conversation ?? id(next++);
  if (!fields.conversation) await db.query('INSERT INTO communications.conversations (id, inbox_id) VALUES ($1, $2)', [conversation, ids.inbox]);
  const messageId = id(next++);
  await db.query(`INSERT INTO communications.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id,
      received_at, kind, sender_verified, sender_member_id, routing_basis, forwarded_by_member_id)
    VALUES ($1, $2, $3, 'new', 'test', $9, $9, $4, $5, $6, $7, $8, $7)`, [
    messageId, ids.inbox, conversation, fields.receivedAt ?? '2026-10-26T10:00:00Z', fields.kind ?? 'person',
    fields.verified ?? false, fields.teammate ? ids.tom : null, fields.teammate ? 'team_recipients' : 'sender', `m-${messageId}`,
  ]);
  for (const project of fields.candidates ?? []) {
    await db.query("INSERT INTO communications.message_candidates (message_id, project_id, reason) VALUES ($1, $2, 'domain')", [messageId, project]);
  }
  if (fields.endpoint) await db.query('INSERT INTO communications.message_endpoints (message_id, endpoint_id) VALUES ($1, $2)', [messageId, ids.hi]);
  return { conversation, message: messageId };
}
const scope = async (db: PGlite, messageId: string, project: string) =>
  (await one(db, 'SELECT communications.scope_source($1, $2) AS s', [messageId, project])).s as string | null;
const triage = (messageId: string, links: string[], projectIds: string[] = []) => [
  'SELECT communications.record_triage(p_message_id => $1, p_member_id => $2, p_triage => $3, p_links => $4, p_project_ids => $5, p_status => $6) AS r',
  [messageId, ids.ashley, JSON.stringify({ outcome: 'task', summary: 'Filed' }), JSON.stringify(links.map((task) => ({ task_id: task, relation: 'created' }))), projectIds, 'handled'],
] as [string, unknown[]];
const projectsOf = async (db: PGlite, conversation: string) =>
  Object.fromEntries((await rows(db, 'SELECT project_id, source FROM communications.conversation_projects WHERE conversation_id = $1', [conversation]))
    .map((row) => [row.project_id, row.source]));

async function main() {
  const db = await createFullSchemaDatabase();
  try {
    await db.exec(`
      INSERT INTO public.team_members (id, name, email, role) VALUES
        ('${ids.owner}', 'Owner', 'owner@agency.example', 'owner'), ('${ids.ashley}', 'Ashley', 'ashley@agency.example', 'agent'),
        ('${ids.tom}', 'Tom', 'tom@agency.example', 'member');
      INSERT INTO public.projects (id, name, status) VALUES ('${ids.acme}', 'Acme', 'active'), ('${ids.birch}', 'Birch', 'active'),
        ('${ids.cobalt}', 'Cobalt', 'completed'), ('${ids.delta}', 'Delta', 'active');
      INSERT INTO public.tasks (id, project_id, title, created_by) VALUES
        ('${ids.task.acme}', '${ids.acme}', 'Acme task', '${ids.owner}'), ('${ids.task.birch}', '${ids.birch}', 'Birch task', '${ids.owner}'),
        ('${ids.task.cobalt}', '${ids.cobalt}', 'Cobalt task', '${ids.owner}'), ('${ids.task.delta}', '${ids.delta}', 'Delta task', '${ids.owner}');
      UPDATE public.business_settings SET inbound_email_domain = 'relay.example.test';
      INSERT INTO communications.inboxes (id, name, address, handler_member_id) VALUES ('${ids.inbox}', 'Ashley', 'ashley@agency.example', '${ids.ashley}');
      INSERT INTO communications.endpoints (id, project_id, inbox_id, public_address) VALUES ('${ids.hi}', '${ids.acme}', '${ids.inbox}', 'hi@acme.example');
    `);
    await actAs(db, null);
    await db.exec('BEGIN');

    // ---- Bases --------------------------------------------------------------
    const viaAddress = await message(db, { endpoint: true });
    check('endpoint: mail through a project address may touch that project, as address',
      await scope(db, viaAddress.message, ids.acme) === 'address' && await scope(db, viaAddress.message, ids.delta) === null);
    const twoMapped = await message(db, { candidates: [ids.acme, ids.birch] });
    check('mapped: several candidates are inferred, anything else is out',
      await scope(db, twoMapped.message, ids.acme) === 'inferred' && await scope(db, twoMapped.message, ids.birch) === 'inferred'
      && await scope(db, twoMapped.message, ids.delta) === null);
    const oneMapped = await message(db, { candidates: [ids.birch] });
    check('mapped: one candidate is mapped', await scope(db, oneMapped.message, ids.birch) === 'mapped');
    const stranger = await message(db);
    const strangerView = (await one(db, 'SELECT communications.message_scope($1) AS s', [stranger.message])).s as Row;
    check('stranger: an unmapped sender touches nothing', await scope(db, stranger.message, ids.acme) === null
      && JSON.stringify([strangerView.bases, strangerView.projects, strangerView.any_project, strangerView.any_source]) === '[[],[],false,null]', strangerView);
    const teammate = await message(db, { teammate: true });
    check('team: a verified teammate may touch any project taking mail, as guessed; not a finished one',
      await scope(db, teammate.message, ids.delta) === 'guessed' && await scope(db, teammate.message, ids.cobalt) === null);
    const notes = await message(db, { kind: 'meeting_notes', verified: true });
    const fakeNotes = await message(db, { kind: 'meeting_notes', verified: false });
    check('meeting notes: verified notes may touch any project (guessed); unverified ones nothing',
      await scope(db, notes.message, ids.delta) === 'guessed' && await scope(db, fakeNotes.message, ids.delta) === null);

    // A person's answer opens the message it answers, and no other.
    const earlier = await message(db, { receivedAt: '2026-10-26T08:00:00Z' });
    const asked = await message(db, { conversation: earlier.conversation, receivedAt: '2026-10-26T09:00:00Z' });
    const [askedTriage] = await rows(db, `INSERT INTO communications.triage (message_id, member_id, outcome, summary, question_for_human)
      VALUES ($1, $2, 'needs_human', 'Which project?', 'Acme or Delta?') RETURNING id`, [asked.message, ids.ashley]);
    await db.query(`INSERT INTO communications.answers (message_id, triage_id, answer, answered_by, created_at)
      VALUES ($1, $2, 'Delta', $3, '2026-10-26T09:30:00Z')`, [asked.message, askedTriage.id, ids.owner]);
    const later = await message(db, { conversation: asked.conversation, receivedAt: '2026-10-26T11:00:00Z' });
    check('answered: the answered message may touch any project, as person; a later reply may not',
      await scope(db, asked.message, ids.delta) === 'person' && await scope(db, later.message, ids.delta) === null);
    const earlierView = (await one(db, 'SELECT communications.message_scope($1) AS s', [earlier.message])).s as Row;
    check('answered: an earlier email on the conversation is not opened by the answer',
      await scope(db, earlier.message, ids.delta) === null && earlierView.any_project === false, earlierView);

    // ---- record_triage ------------------------------------------------------
    const [filed] = await rows(db, ...triage(teammate.message, [ids.task.acme, ids.task.delta]));
    const filedProjects = await projectsOf(db, teammate.conversation);
    const filedTriage = (filed.r as Row).triage as Row;
    check('triage: a teammate\'s email files a task on two projects, both on the conversation, both on the triage',
      filedProjects[ids.acme] === 'guessed' && filedProjects[ids.delta] === 'guessed'
      && JSON.stringify(filedTriage.project_ids) === JSON.stringify([ids.acme, ids.delta].sort()) && filedTriage.project_id === null
      && (await rows(db, 'SELECT 1 FROM communications.task_links WHERE message_id = $1', [teammate.message])).length === 2, { filedProjects, filedTriage });
    check('triage: the response lists the conversation\'s projects',
      ((filed.r as Row).thread as Row & { projects: unknown[] }).projects.length === 2);

    const refused = await fails(db, ...triage(stranger.message, [ids.task.delta]));
    check('triage: a stranger\'s link to another project is refused in the database, and nothing is written',
      /EMAIL_PROJECT_OUT_OF_SCOPE/.test(refused)
      && (await rows(db, 'SELECT 1 FROM communications.triage WHERE message_id = $1', [stranger.message])).length === 0
      && (await rows(db, 'SELECT 1 FROM communications.task_links WHERE message_id = $1', [stranger.message])).length === 0
      && Object.keys(await projectsOf(db, stranger.conversation)).length === 0, refused);
    check('triage: a missing task is refused', /EMAIL_LINK_TASK_NOT_FOUND/.test(await fails(db, ...triage(teammate.message, [id(999)]))));
    check('triage: a named project with no task is filed too',
      !(await fails(db, ...triage(viaAddress.message, [], [ids.acme]))) && (await projectsOf(db, viaAddress.conversation))[ids.acme] === 'address');

    // The conversation basis: a client's reply rides on a settled project, never on a guess.
    const clientReply = await message(db, { conversation: teammate.conversation });
    check('conversation: a stranger\'s reply cannot use the projects the agent guessed from a teammate',
      await scope(db, clientReply.message, ids.acme) === null);
    const mappedThread = await message(db, { candidates: [ids.birch] });
    await db.query(...triage(mappedThread.message, [ids.task.birch]));
    const mappedReply = await message(db, { conversation: mappedThread.conversation });
    check('conversation: a stranger\'s reply may touch a project the conversation was filed on by mapping',
      await scope(db, mappedReply.message, ids.birch) === 'mapped');
    await db.query("UPDATE public.projects SET status = 'completed' WHERE id = $1", [ids.birch]);
    check('conversation: a filed project stays reachable after it is finished', await scope(db, mappedReply.message, ids.birch) === 'mapped');
    await db.query("UPDATE public.projects SET status = 'active' WHERE id = $1", [ids.birch]);

    // Sources only get stronger.
    await db.query('SELECT communications.file_message_project($1, $2, $3, true)', [teammate.message, ids.acme, ids.owner]);
    await db.query(...triage(teammate.message, [ids.task.acme]));
    check('sources: a person\'s word upgrades a guess and a later guess never downgrades it',
      (await projectsOf(db, teammate.conversation))[ids.acme] === 'person');
    const [copy] = await rows(db, 'SELECT project_id, project_source FROM communications.conversations WHERE id = $1', [teammate.conversation]);
    check('copy: the conversation\'s project columns follow its strongest project', copy.project_id === ids.acme && copy.project_source === 'person', copy);

    // ---- Links and filing ---------------------------------------------------
    const personLink = await one(db, 'SELECT communications.link_message_task($1, $2, $3, $4, true) AS r', [stranger.message, ids.task.cobalt, 'related', ids.owner]);
    check('link: a person links a task from any project, filing it as person', (personLink.r as Row).source === 'person'
      && (await projectsOf(db, stranger.conversation))[ids.cobalt] === 'person');
    check('link: the agent\'s link out of scope is refused',
      /EMAIL_PROJECT_OUT_OF_SCOPE/.test(await fails(db, 'SELECT communications.link_message_task($1, $2, $3, $4)', [fakeNotes.message, ids.task.delta, 'created', ids.ashley])));
    check('file: out of scope is refused', /EMAIL_PROJECT_OUT_OF_SCOPE/.test(await fails(db, 'SELECT communications.file_message_project($1, $2, $3)', [oneMapped.message, ids.acme, ids.ashley])));
    await db.query('SELECT communications.set_conversation_project($1, $2, $3)', [teammate.conversation, ids.birch, ids.owner]);
    const afterSet = await projectsOf(db, teammate.conversation);
    check('set: a person setting a project adds it and takes none off',
      afterSet[ids.birch] === 'person' && afterSet[ids.acme] === 'person' && afterSet[ids.delta] === 'guessed', afterSet);

    // The single-project triage still files one project.
    const legacy = await message(db, { candidates: [ids.birch] });
    await db.query(`SELECT communications.record_triage(p_message_id => $1, p_member_id => $2, p_triage => $3, p_links => '[]'::jsonb,
      p_project_id => $4, p_status => 'handled')`, [legacy.message, ids.ashley, JSON.stringify({ outcome: 'no_action', summary: 'Seen' }), ids.birch]);
    check('legacy: the single-project triage still files its project', (await projectsOf(db, legacy.conversation))[ids.birch] === 'inferred');

    // ---- Delivery: how a message reached us ------------------------------------
    // One of your addresses with no project, and a domain of yours.
    await db.exec("RESET ROLE; INSERT INTO communications.endpoints (inbox_id, public_address) SELECT id, 'me@personal.example' FROM communications.inboxes LIMIT 1; "
      + "INSERT INTO communications.own_domains (domain) VALUES ('ours.example')");
    await actAs(db, null);
    const delivered = async (to: string[], cc: string[] = [], fields: { forwarded?: boolean; autoMail?: boolean } = {}) => {
      const sent = await message(db);
      if (fields.autoMail) await db.query("UPDATE communications.messages SET auto_mail_reason = 'list' WHERE id = $1", [sent.message]);
      let position = 0;
      for (const [kind, list] of [['to', to], ['cc', cc]] as const) {
        for (const address of list) {
          await db.query('INSERT INTO communications.participants (message_id, kind, address, position) VALUES ($1, $2, $3, $4)', [sent.message, kind, address, position++]);
        }
      }
      return one(db, 'SELECT * FROM communications.delivery_of($1, $2)', [sent.message, fields.forwarded ?? false]);
    };
    const client = (n: number) => `client${n}@acme.example`;
    check('delivery: to the inbox with one other is direct', JSON.stringify(await delivered(['ashley@agency.example', client(1)]))
      === JSON.stringify({ delivery: 'direct', audience_size: 2 }));
    check('delivery: to a project address, one of your addresses or any address on your domain is direct',
      (await delivered(['hi@acme.example'])).delivery === 'direct' && (await delivered(['me@personal.example'])).delivery === 'direct'
      && (await delivered(['anyone@ours.example'])).delivery === 'direct');
    check('delivery: to a teammate is direct', (await delivered(['tom@agency.example'])).delivery === 'direct');
    check('delivery: to us among three others is a group', (await delivered(['ashley@agency.example', client(1), client(2)], [client(3)])).delivery === 'group');
    check('delivery: only in copy is cc', (await delivered([client(1)], ['ashley@agency.example'])).delivery === 'cc');
    check('delivery: none of ours among the recipients is bcc', (await delivered([client(1)])).delivery === 'bcc');
    check('delivery: a teammate\'s forward is forwarded', (await delivered(['ashley@agency.example'], [], { forwarded: true })).delivery === 'forwarded');
    check('delivery: automated mail is broadcast', (await delivered(['ashley@agency.example'], [], { autoMail: true })).delivery === 'broadcast');
    const recorded = await message(db);
    await db.query("INSERT INTO communications.participants (message_id, kind, address) VALUES ($1, 'cc', 'ashley@agency.example')", [recorded.message]);
    await db.query('SELECT communications.set_message_delivery($1)', [recorded.message]);
    const [stored] = await rows(db, 'SELECT delivery, audience_size FROM communications.messages WHERE id = $1', [recorded.message]);
    check('delivery: set_message_delivery stores it on the message', stored.delivery === 'cc' && stored.audience_size === 1, stored);

    // ---- The agent's view -----------------------------------------------------
    const view = (await one(db, 'SELECT communications.message_scope($1) AS s', [twoMapped.message])).s as Row & { projects: Row[] };
    check('message_scope: names the mapped projects and no wildcard', JSON.stringify(view.bases) === '["mapped"]'
      && view.projects.length === 2 && view.any_project === false, view);
    const teamView = (await one(db, 'SELECT communications.message_scope($1) AS s', [teammate.message])).s as Row & { projects: Row[] };
    check('message_scope: a teammate\'s message may touch any project, as guessed', teamView.any_project === true && teamView.any_source === 'guessed'
      && (teamView.bases as string[]).includes('team') && (teamView.bases as string[]).includes('conversation'), teamView);
    await db.exec('COMMIT');

    // ---- Nobody else runs it ---------------------------------------------------
    await db.exec(`RESET ROLE; INSERT INTO auth.users (id, email) VALUES ('${id(90)}', 'rae@agency.example')`);
    await actAs(db, id(90));
    await db.exec('BEGIN');
    for (const call of ['communications.scope_source($1, $1)', 'communications.message_scope($1)', 'communications.file_message_project($1, $1, $1)', 'communications.delivery_of($1, false)', 'communications.set_message_delivery($1)']) {
      check(`grants: a signed-in person cannot run ${call.split('(')[0]}`, /permission denied/.test(await fails(db, `SELECT ${call}`, [ids.acme])));
    }
    await db.exec('ROLLBACK');
  } finally {
    await db.close();
  }

  if (failures.length) {
    console.error(`conversation scope: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`conversation scope: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
