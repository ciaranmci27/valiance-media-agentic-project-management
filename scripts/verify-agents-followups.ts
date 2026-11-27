/**
 * Follow-ups for agents (20261127002900_agents_followups.sql), on the full
 * schema over PGlite, through the real v1 route (withApi, supabase-js, a fake
 * PostgREST):
 *
 * - Announce: a task comment posted with notify: true tells the task's
 *   people (assignees and creator) once each, never the author, nobody who
 *   cannot open the task; it needs notifications.send (403, nothing
 *   written); an agent's notify counts against send_rate_per_minute (429,
 *   nothing written); without notify nobody is told and nothing is counted.
 * - The alarm: an agent with no owners that stops responding tells the
 *   workspace Owners once, in plain words; the next check repeats nothing;
 *   when it comes back the notice already read moves to done. An expired
 *   question tells the person it was asked of, once.
 * - The migration mirrors schema.sql word for word, runs twice on the schema
 *   before it, and its new function is for the server only.
 *
 *   npm run -s test:agents-followups
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';

const MIGRATION = '20261127002900_agents_followups.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const RULE = '-- ============================================================';
const BANNER = `\n${RULE}\n-- FOLLOW-UPS FOR AGENTS (${MIGRATION})\n${RULE}\n`;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const next = at < 0 ? -1 : SCHEMA_SQL.indexOf(`\n${RULE}\n`, at + BANNER.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && SCHEMA_SQL.slice(at + BANNER.length, next < 0 ? undefined : next) === MIGRATION_SQL);
  check('migration: no em or en dash', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  if (at < 0) return;
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await old.exec('RESET ROLE');
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const grants = (await fresh.query<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('agent_send_gate', 'run_watchdog')`)).rows;
  check('grants: the send gate and the watchdog are for the server only', grants.length === 2 && grants.every((g) => !g.anon && !g.auth), grants);
  await old.close();
  await fresh.close();
}

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await q('UPDATE pm.workspace_modules SET enabled = true');
  const member = async (name: string, role: string) => {
    const user = randomUUID();
    await q("INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, jsonb_build_object('display_name', $3::text))", [user, `${name.toLowerCase()}@example.com`, name]);
    return (await q<{ id: string }>('UPDATE pm.team_members SET role = $2 WHERE auth_user_id = $1 RETURNING id', [user, role]))[0].id;
  };
  const owner = await member('Olivia', 'owner');
  const mia = await member('Mia', 'member');
  const ned = await member('Ned', 'member');
  const outsider = await member('Otto', 'member');
  const scout = await member('Scout', 'agent');
  const quiet = await member('Quiet', 'agent');
  const ashley = await member('Ashley', 'agent');
  await q('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2), ($3, $2)', [scout, owner, quiet]);
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  const hidden = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Hidden') RETURNING id"))[0].id;
  for (const m of [mia, ned, scout, quiet]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [project, m]);
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [hidden, scout]);
  const task = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, created_by) VALUES ($1, 'Ship the landing page', $2) RETURNING id", [project, ned]))[0].id;
  await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2), ($1, $3)', [task, mia, scout]);
  // Otto created a task in a project he is not on: he cannot open it, so he is never told.
  const hiddenTask = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, created_by) VALUES ($1, 'Private work', $2) RETURNING id", [hidden, outsider]))[0].id;
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', $4, $1, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes, secret.slice(0, 15)]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, k, 'api', 'allow' FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  const keys = {
    scout: await key(scout, ['tasks.read', 'notifications.send']),
    quiet: await key(quiet, ['tasks.read']),
  };
  return { q, owner, mia, ned, outsider, scout, quiet, ashley, project, hidden, task, hiddenTask, keys };
}

async function main() {
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const commentsRoute = await import('../src/app/api/v1/tasks/[id]/comments/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const call = async (apiKey: string, taskId: string, body: unknown): Promise<Answer> => {
      const response = await commentsRoute.POST(new NextRequest(`http://localhost/api/v1/tasks/${taskId}/comments`, {
        method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: taskId }) } as never);
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const told = async (taskId: string) => (await s.q<Loose>("SELECT user_id, title, message, link FROM pm.team_member_notifications WHERE entity_type = 'task' AND entity_id = $1 ORDER BY user_id", [taskId]));
    const comments = async (taskId: string) => Number((await s.q<Loose>('SELECT count(*)::int AS n FROM pm.task_comments WHERE task_id = $1', [taskId]))[0].n);
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;

    // ── Announce ─────────────────────────────────────────────────────────
    const plain = await call(s.keys.scout, s.task, { user_id: s.scout, text: 'Draft is up.' });
    check('announce: without notify, the comment is posted and nobody is told', plain.status === 201 && plain.body?.data?.notified === undefined && (await told(s.task)).length === 0, plain.body);
    const loud = await call(s.keys.scout, s.task, { user_id: s.scout, text: 'The landing page is live: please check the copy.', notify: true });
    const bells = await told(s.task);
    const expected = [s.mia, s.ned].sort();
    check('announce: notify tells the assignees and the creator, never the author', loud.status === 201 && loud.body?.data?.notified === 2
      && JSON.stringify(bells.map((b) => b.user_id)) === JSON.stringify(expected), { body: loud.body, bells });
    check('announce: in plain words, linking to the task', bells.every((b) => b.title === 'New comment on "Ship the landing page"'
      && b.message === 'Scout: "The landing page is live: please check the copy."' && b.link === `/projects/${s.project}?task=${s.task}`), bells);
    const outsiderTold = await call(s.keys.scout, s.hiddenTask, { user_id: s.scout, text: 'Done here.', notify: true });
    check('announce: someone who cannot open the task is not told', outsiderTold.status === 201 && outsiderTold.body?.data?.notified === 0 && (await told(s.hiddenTask)).length === 0, outsiderTold.body);
    const before = await comments(s.task);
    const noPower = await call(s.keys.quiet, s.task, { user_id: s.quiet, text: 'Me too.', notify: true });
    check('announce: notify without notifications.send is 403 and writes nothing', noPower.status === 403 && reason(noPower) === 'missing_permission'
      && await comments(s.task) === before, noPower.body);

    await s.q('INSERT INTO pm.agent_limits (agent_id, send_rate_per_minute) VALUES ($1, 1)', [s.scout]);
    await s.q('DELETE FROM pm.agent_write_windows WHERE agent_id = $1', [s.scout]);
    const firstSend = await call(s.keys.scout, s.task, { user_id: s.scout, text: 'One more thing.', notify: true });
    const quietOne = await call(s.keys.scout, s.task, { user_id: s.scout, text: 'A note, no bell.' });
    const counted = await comments(s.task);
    const overSend = await call(s.keys.scout, s.task, { user_id: s.scout, text: 'And another.', notify: true });
    check('announce: an agent\'s notify counts as a send; a plain comment does not', firstSend.status === 201 && quietOne.status === 201, [firstSend.body, quietOne.body]);
    check('announce: past send_rate_per_minute it is 429 send_rate_limited, nothing written', overSend.status === 429 && reason(overSend) === 'send_rate_limited'
      && await comments(s.task) === counted, overSend.body);

    const tool = PM_TOOLS.find((t) => t.name === 'add_task_comment') as Loose;
    let request: Loose = null;
    await tool?.run?.({ task_id: s.task, text: 'Hi', notify: true }, async (routeCall: Loose) => { request = routeCall; return { status: 201, body: {} }; }, { memberId: s.scout });
    check('mcp: add_task_comment takes notify and sends it on', !!tool && tool.input.safeParse({ task_id: s.task, text: 'Hi', notify: true }).success
      && request?.body?.notify === true, request);

    // ── The alarm ────────────────────────────────────────────────────────
    await s.q("INSERT INTO pm.agent_health (member_id, container, container_running, reported_at, expected_interval_seconds) VALUES ($1, 'ashley', true, now() - interval '2 hours', 60)", [s.ashley]);
    const watchdog = async () => (await s.q<Loose>('SELECT pm.run_watchdog() AS w'))[0].w;
    const alarms = async () => s.q<Loose>("SELECT user_id, title, message, is_read, done_at FROM pm.team_member_notifications WHERE entity_type = 'member' AND entity_id = $1 ORDER BY created_at", [s.ashley]);
    await watchdog();
    const rung = await alarms();
    check('alarm: an agent with no owners tells the Owners once, in plain words', rung.length === 1 && rung[0].user_id === s.owner && rung[0].title === 'Ashley stopped responding'
      && rung[0].message === 'Ashley stopped responding. Its last check-in was 2 hours ago.', rung);
    await watchdog();
    check('alarm: the next check repeats nothing', (await alarms()).length === 1);
    await s.q("UPDATE pm.team_member_notifications SET is_read = true WHERE entity_type = 'member' AND entity_id = $1", [s.ashley]);
    await s.q('UPDATE pm.agent_health SET reported_at = now() WHERE member_id = $1', [s.ashley]);
    await watchdog();
    const settled = await alarms();
    check('alarm: back again, the read alarm moves to done and "is back" is the one open notice', settled.length === 2
      && settled.find((n) => n.title === 'Ashley stopped responding')?.done_at !== null
      && settled.filter((n) => n.done_at === null).map((n) => n.title).join() === 'Ashley is back', settled);

    const question = (await s.q<{ id: string }>("INSERT INTO pm.questions (asked_by, asked_to, question, expires_at) VALUES ($1, $2, 'Which logo goes on the page?', now() - interval '1 minute') RETURNING id", [s.scout, s.mia]))[0].id;
    const first = await watchdog();
    const askedOf = await s.q<Loose>("SELECT user_id, title, message, category FROM pm.team_member_notifications WHERE entity_type = 'question' AND entity_id = $1 AND user_id = $2 AND cleared_at IS NULL", [question, s.mia]);
    check('alarm: the person an expired question was asked of hears once, in plain words', askedOf.length === 1 && askedOf[0].title === "Scout's question to you expired without an answer"
      && askedOf[0].message === 'Which logo goes on the page?' && askedOf[0].category === 'question_expired' && first.asked_told === 1, { askedOf, first });
    const again = await watchdog();
    check('alarm: and not again on the next check', again.asked_told === 0
      && (await s.q<Loose>("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_type = 'question' AND entity_id = $1 AND user_id = $2 AND cleared_at IS NULL", [question, s.mia]))[0].n === 1, again);
  } finally {
    await server.close();
    await db.close();
  }
  if (failures.length) {
    console.error(`agents follow-ups: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`agents follow-ups: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
