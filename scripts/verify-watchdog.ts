/**
 * The watchdog and retention (20261125001300_watchdog_retention.sql), on the
 * full schema over PGlite:
 * - An agent that stopped responding: one bell for its owner, one
 *   agent.offline naming the claims that ran out, nothing more on the next
 *   run; when it reports again, agent.online and one "is back". A paused
 *   agent, a personal assistant and an agent silent long before are not
 *   rung.
 * - A run with no update for two hours is stored as timed_out once, with
 *   one run.finished.
 * - A run waiting on a person: a question naming it makes it wait and keeps
 *   the watchdog off it; answered, cancelled or expired, it runs again with
 *   its clock restarted (run.updated each way); waiting by hand times out
 *   after seven days; a finish from waiting is a finish; the database
 *   refuses a question naming someone else's run.
 * - An expired question sends question.expired and tells whoever asked
 *   once, whether the watchdog or a read stored it; an agent's question
 *   tells its owners.
 * - An endpoint failing 5 attempts in a row tells the Owners and webhook
 *   managers once, sends nothing to the endpoint, and a success resets it
 *   and clears the bell.
 * - Retries default on: the app turns them on once they can run; an Owner
 *   turns them off, then nothing turns them on again and the database sends
 *   no kick.
 * - Retention removes old finished deliveries but keeps pending ones, keeps
 *   everything while a setting is null, and blanks old chat text but keeps
 *   its row and dedupe key. Runs go only through the job.
 * - Only an Owner changes these settings in the database.
 * - The migration, run twice on the schema without it, matches schema.sql.
 *
 *   npm run -s test:watchdog
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';

const MIGRATION = '20261125001300_watchdog_retention.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = `-- WATCHDOG AND RETENTION (${MIGRATION})`;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Loose = any;

const OWNER_LOGIN = { id: '0b5c1e9a-6f7d-4c1e-9a1b-000000000001', email: 'olivia@example.com' };
const ADMIN_LOGIN = { id: '0b5c1e9a-6f7d-4c1e-9a1b-000000000002', email: 'ana@example.com' };

/**
 * schema.sql without this migration's section: what an install had before it.
 * A later section that calls a function this migration creates goes too (it
 * could not load without it); the later migrations bring it back, as they do
 * on an upgrade.
 */
function schemaWithoutSection(): string {
  const heading = /\n-- =+\n-- [A-Z][^\n]*\(\d{14}_[a-z0-9_]+\.sql\)/g;
  const starts: number[] = [];
  for (let m = heading.exec(SCHEMA_SQL); m; m = heading.exec(SCHEMA_SQL)) starts.push(m.index);
  const at = SCHEMA_SQL.indexOf(SECTION);
  const sections = starts.map((s, i) => SCHEMA_SQL.slice(s, starts[i + 1] ?? SCHEMA_SQL.length));
  const own = starts.filter((s) => s < at).length - 1;
  const created = [...MIGRATION_SQL.matchAll(/CREATE OR REPLACE FUNCTION (pm\.[a-z_]+)\(/g)].map((m) => m[1]);
  const later = sections.slice(own + 1).filter((piece) => !created.some((name) => piece.includes(`${name}(`)));
  return SCHEMA_SQL.slice(0, starts[0]) + sections.slice(0, own).join('') + later.join('');
}

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  check('schema.sql: the watchdog and retention section is there', at > 0);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('ALTER TABLE pm.business_settings')).trim();
  check('schema.sql: the section mirrors the migration body', body.length > 5000 && SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: schemaWithoutSection() });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  // Data from before: a long-expired question, and a business row.
  const a = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'owner') RETURNING id"))[0].id;
  const b = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Mia', 'mia@example.com', 'member') RETURNING id"))[0].id;
  await q("INSERT INTO pm.questions (asked_by, asked_to, question, status, expires_at) VALUES ($1, $2, 'Old?', 'expired', now() - interval '30 days')", [a, b]);
  await old.exec(MIGRATION_SQL);
  await old.exec(MIGRATION_SQL);
  const settings = (await q<Loose>('SELECT webhook_retention_days, agent_health_history_days, agent_activity_retention_days, agent_run_retention_days, chat_retention_days, webhook_retries_off FROM pm.business_settings'))[0];
  check('upgrade: the existing business row gets the defaults (30, 90, keep forever, retries not turned off)', settings?.webhook_retention_days === 30 && settings.agent_health_history_days === 90
    && settings.agent_activity_retention_days === null && settings.agent_run_retention_days === null && settings.chat_retention_days === null && settings.webhook_retries_off === false, settings);
  const ran = (await q<Loose>('SELECT pm.run_watchdog() AS w'))[0].w;
  check('upgrade: a question that expired long before is not told about', ran.askers_told === 0
    && (await q('SELECT 1 FROM pm.team_member_notifications')).length === 0, ran);
  // An upgrade runs the later migrations after it: one that redefines what it also sets (the notification types) wins, as it does there.
  await applyMigrationsFrom(old, `${MIGRATION}~`);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema without it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const grants = (await q<Loose>(`SELECT
      bool_or(has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS browser
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pm' AND p.proname IN ('run_watchdog', 'apply_data_retention', 'agent_people_to_tell', 'track_webhook_endpoint_health', 'heartbeat_stale_after_seconds', 'watchdog_ago', 'agent_runs_forbid_delete')`))[0];
  check('functions: no browser role runs the watchdog, retention or their helpers', grants.browser === false, grants);
  const table = (await q<Loose>("SELECT has_table_privilege('authenticated', 'pm.watchdog_marks', 'SELECT') AS auth, has_table_privilege('anon', 'pm.watchdog_marks', 'SELECT') AS anon"))[0];
  check('watchdog_marks: server only', table.auth === false && table.anon === false, table);
  await old.close();
  await fresh.close();
}

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await q('UPDATE pm.workspace_modules SET enabled = true');
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    }
    return id;
  };
  const owner = await member('Olivia', 'owner', OWNER_LOGIN);
  const ana = await member('Ana', 'admin', ADMIN_LOGIN);
  const pat = await member('Pat', 'member');
  const mia = await member('Mia', 'member');
  const nova = await member('Nova', 'agent');
  const sleepy = await member('Sleepy', 'agent');
  const relic = await member('Relic', 'agent');
  const buddy = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template) VALUES ('Buddy', 'buddy@agents.invalid', 'agent', $1, 'personal-assistant') RETURNING id", [mia]))[0].id;
  await q('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [nova, pat]);
  await q('UPDATE pm.team_members SET agent_paused_at = now() WHERE id = $1', [sleepy]);
  // Mia manages webhooks (Team > Roles & permissions).
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'webhooks.manage', 'app', 'allow')", [mia]);
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  const listening = (await q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events)
    VALUES ('Harness', 'https://harness.example.test/hook', 'whsec_h', ARRAY['agent.offline', 'agent.online', 'run.finished', 'question.expired']) RETURNING id`))[0].id;
  const flaky = (await q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events)
    VALUES ('Zapier', 'https://flaky.example.test/hook', 'whsec_f', ARRAY['task.created']) RETURNING id`))[0].id;
  return { q, owner, ana, pat, mia, nova, sleepy, relic, buddy, project, listening, flaky };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const watchdog = async (s: Seed) => (await s.q<Loose>('SELECT pm.run_watchdog() AS w'))[0].w;
const events = async (s: Seed, type: string) => s.q<Loose>('SELECT payload FROM pm.webhook_events WHERE event_type = $1 ORDER BY sequence', [type]);
const bells = async (s: Seed, entity: string, id: string) =>
  s.q<Loose>('SELECT user_id, title, message, link, cleared_at FROM pm.team_member_notifications WHERE entity_type = $1 AND entity_id = $2 ORDER BY user_id', [entity, id]);

async function agentChecks(s: Seed) {
  // Nova promised a beat a minute and has been silent ten: offline after three.
  await s.q("INSERT INTO pm.agent_health (member_id, container, container_running, reported_at, expected_interval_seconds) VALUES ($1, 'nova', true, now() - interval '10 minutes', 60)", [s.nova]);
  await s.q("INSERT INTO pm.agent_health (member_id, container, container_running, reported_at, expected_interval_seconds) VALUES ($1, 'sleepy', true, now() - interval '10 minutes', 60)", [s.sleepy]);
  await s.q("INSERT INTO pm.agent_health (member_id, container, container_running, reported_at, expected_interval_seconds) VALUES ($1, 'relic', true, now() - interval '20 days', 60)", [s.relic]);
  await s.q("INSERT INTO pm.agent_health (member_id, container, container_running, reported_at, expected_interval_seconds) VALUES ($1, 'buddy', true, now() - interval '10 minutes', 60)", [s.buddy]);
  // An hourly agent seen 90 minutes ago is fine (stale after two hours and a minute).
  const hourly = (await s.q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Hourly', 'hourly@example.com', 'agent') RETURNING id"))[0].id;
  await s.q("INSERT INTO pm.agent_health (member_id, container, container_running, reported_at, expected_interval_seconds) VALUES ($1, 'hourly', true, now() - interval '90 minutes', 3600)", [hourly]);
  // Its claim ran out while it was silent; an older one ran out before.
  const lapsed = (await s.q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, claimed_by, claimed_at, claim_expires_at) VALUES ($1, 'Fix checkout', $2, now() - interval '40 minutes', now() - interval '2 minutes') RETURNING id", [s.project, s.nova]))[0].id;
  await s.q("INSERT INTO pm.tasks (project_id, title, claimed_by, claimed_at, claim_expires_at) VALUES ($1, 'Old claim', $2, now() - interval '3 hours', now() - interval '2 hours')", [s.project, s.nova]);

  const first = await watchdog(s);
  const offline = await events(s, 'agent.offline');
  const novaOffline = offline.filter((e) => e.payload.data.agent.id === s.nova);
  check('offline: one agent.offline for Nova, naming the claim that ran out while silent', novaOffline.length === 1
    && JSON.stringify(novaOffline[0].payload.data.released_task_ids) === JSON.stringify([lapsed])
    && novaOffline[0].payload.data.member_ids.includes(s.nova) && novaOffline[0].payload.data.agent.stale_after_seconds === 180, novaOffline.map((e) => e.payload.data));
  const novaBells = await bells(s, 'member', s.nova);
  check('offline: its owner gets one bell, in plain words, linking to the agent', novaBells.length === 1 && novaBells[0].user_id === s.pat
    && novaBells[0].title === 'Nova stopped responding' && novaBells[0].message === 'Nova stopped responding 10 minutes ago, its claimed task went back to the queue.'
    && novaBells[0].link === `/agent/${s.nova}`, novaBells);
  check('offline: a paused agent is skipped', offline.every((e) => e.payload.data.agent.id !== s.sleepy) && (await bells(s, 'member', s.sleepy)).length === 0);
  check('offline: a personal assistant is left to its own path', offline.every((e) => e.payload.data.agent.id !== s.buddy) && (await bells(s, 'member', s.buddy)).length === 0);
  check('offline: an hourly agent between runs is not offline', offline.every((e) => e.payload.data.agent.id !== hourly));
  check('offline: an agent silent long before is marked (event) but rings no bell', offline.some((e) => e.payload.data.agent.id === s.relic)
    && (await bells(s, 'member', s.relic)).length === 0, first);

  const second = await watchdog(s);
  check('offline: the next run repeats nothing', second.agents_offline === 0 && (await events(s, 'agent.offline')).length === offline.length
    && (await bells(s, 'member', s.nova)).length === 1, second);

  await s.q('UPDATE pm.agent_health SET reported_at = now() WHERE member_id = $1', [s.nova]);
  const back = await watchdog(s);
  const online = (await events(s, 'agent.online')).filter((e) => e.payload.data.agent.id === s.nova);
  const backBells = await bells(s, 'member', s.nova);
  check('online: it reports again, one agent.online with when it went quiet', back.agents_online === 1 && online.length === 1 && !!online[0].payload.data.offline_since, back);
  check('online: one short "is back" for whoever heard it went quiet', backBells.length === 1 && backBells[0].title === 'Nova is back' && backBells[0].message === 'Nova is responding again.', backBells);
  const again = await watchdog(s);
  check('online: the next run repeats nothing', again.agents_online === 0 && (await events(s, 'agent.online')).length === 1, again);

  // Silent long before: back again, no bell, since none rang.
  await s.q('UPDATE pm.agent_health SET reported_at = now() WHERE member_id = $1', [s.relic]);
  await watchdog(s);
  check('online: an agent never rung comes back without a bell', (await bells(s, 'member', s.relic)).length === 0
    && (await events(s, 'agent.online')).some((e) => e.payload.data.agent.id === s.relic));
}

async function runChecks(s: Seed) {
  const stale = (await s.q<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, started_at, updated_at) VALUES ($1, 'Long job', now() - interval '4 hours', now() - interval '3 hours') RETURNING id", [s.nova]))[0].id;
  const live = (await s.q<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, started_at, updated_at) VALUES ($1, 'Fresh job', now() - interval '1 hour', now() - interval '30 minutes') RETURNING id", [s.nova]))[0].id;
  const ran = await watchdog(s);
  const rows = await s.q<Loose>('SELECT id, status, finished_at, started_at, now() - interval \'3 hours\' AS last_update FROM pm.agent_runs WHERE id IN ($1, $2)', [stale, live]);
  const timedOut = rows.find((r) => r.id === stale);
  check('runs: a run two hours past its last update is stored as timed_out, ending at its last update', ran.runs_timed_out === 1 && timedOut?.status === 'timed_out'
    && Math.abs(new Date(timedOut.finished_at).getTime() - new Date(timedOut.last_update).getTime()) < 5000, rows);
  check('runs: a run updated recently keeps running', rows.find((r) => r.id === live)?.status === 'running');
  const finished = (await events(s, 'run.finished')).filter((e) => e.payload.data.run.id === stale);
  check('runs: one run.finished with status timed_out', finished.length === 1 && finished[0].payload.data.run.status === 'timed_out', finished.map((e) => e.payload.data.run));
  const again = await watchdog(s);
  check('runs: the next run repeats nothing', again.runs_timed_out === 0 && (await events(s, 'run.finished')).filter((e) => e.payload.data.run.id === stale).length === 1, again);
  const late = await s.q<Loose>("UPDATE pm.agent_runs SET status = 'succeeded' WHERE id = $1 RETURNING status", [stale]);
  check('runs: a late finish keeps timed_out (a finished run keeps its status)', late[0]?.status === 'timed_out', late);
}

/**
 * A run waiting on a person: a question naming it makes it wait and keeps
 * the watchdog off it; the answer (or an expiry) brings it back to running
 * with its clock restarted; a run waiting by hand times out after seven
 * days; a finish from waiting is a finish.
 */
async function waitingChecks(s: Seed) {
  const hook = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events)
    VALUES ('Waits', 'https://waits.example.test/hook', 'whsec_w', ARRAY['run.updated', 'run.finished', 'question.asked']) RETURNING id`))[0].id;
  // updated_at is the clock: move it back by hand, past the trigger that stamps it.
  const age = async (runId: string, interval: string) => {
    await s.q('ALTER TABLE pm.agent_runs DISABLE TRIGGER set_agent_runs_updated_at');
    await s.q(`UPDATE pm.agent_runs SET updated_at = now() - $2::interval WHERE id = $1`, [runId, interval]);
    await s.q('ALTER TABLE pm.agent_runs ENABLE TRIGGER set_agent_runs_updated_at');
  };
  const run = async (title: string, status = 'running', updated = '1 minute') => (await s.q<{ id: string }>(
    `INSERT INTO pm.agent_runs (agent_id, title, status, started_at, updated_at) VALUES ($1, $2, $3, now() - interval '30 days', now() - $4::interval) RETURNING id`,
    [s.nova, title, status, updated]))[0].id;
  const ask = async (runId: string, text: string, expired = false) => (await s.q<{ id: string }>(
    `INSERT INTO pm.questions (asked_by, asked_to, question, run_id, expires_at) VALUES ($1, $2, $3, $4, ${expired ? "now() - interval '1 minute'" : 'NULL'}) RETURNING id`,
    [s.nova, s.owner, text, runId]))[0].id;
  const answer = (questionId: string) => s.q(
    "UPDATE pm.questions SET status = 'answered', answer_text = 'Per line', answered_by = $2, answered_at = now() WHERE id = $1", [questionId, s.owner]);
  const state = async (runId: string) => (await s.q<Loose>(
    "SELECT status, finished_at, extract(epoch FROM now() - updated_at) AS quiet_seconds FROM pm.agent_runs WHERE id = $1", [runId]))[0];
  const feedStatus = async (runId: string) => (await s.q<Loose>('SELECT status FROM pm.agent_run_feed WHERE id = $1', [runId]))[0]?.status;

  // Asked with run_id: the run waits on a person.
  const held = await run('Rounding rule', 'running', '3 hours');
  const question = await ask(held, 'Per line or per invoice?');
  const asked = await state(held);
  check('waiting: a question naming a running run makes it waiting, its clock restarted', asked.status === 'waiting' && asked.finished_at === null
    && Number(asked.quiet_seconds) < 60, asked);
  const askedEvent = (await events(s, 'question.asked')).find((e) => e.payload.data.question.id === question);
  check('waiting: question.asked carries run_id', askedEvent?.payload.data.question.run_id === held, askedEvent?.payload.data.question);

  // Hours pass with no update: the open question keeps the watchdog off it.
  await age(held, '3 hours');
  check('waiting: the run feed reads it waiting, not timed_out', (await feedStatus(held)) === 'waiting', await feedStatus(held));
  const quiet = await watchdog(s);
  check('waiting: two hours with an open question naming it is not a timeout', (await state(held)).status === 'waiting', { ran: quiet, run: await state(held) });

  // The answer: running again, clock restarted.
  await answer(question);
  const resumed = await state(held);
  check('waiting: once answered the run is running again and its clock restarts', resumed.status === 'running' && Number(resumed.quiet_seconds) < 60, resumed);
  await watchdog(s);
  check('waiting: a run back from waiting is not timed out by its old silence', (await state(held)).status === 'running', await state(held));
  const updates = (await events(s, 'run.updated')).filter((e) => e.payload.data.run.id === held).map((e) => e.payload.data.run.status);
  check('waiting: run.updated goes out for waiting, then running', JSON.stringify(updates) === JSON.stringify(['waiting', 'running']), updates);
  check('waiting: no run.finished for a run that waited', (await events(s, 'run.finished')).every((e) => e.payload.data.run.id !== held));

  // Two open questions: the run waits until the last one closes.
  const twice = await run('Two asks');
  const first = await ask(twice, 'Which region?');
  const second = await ask(twice, 'Which currency?');
  await answer(first);
  check('waiting: with another question still open, the run keeps waiting', (await state(twice)).status === 'waiting', await state(twice));
  await s.q("UPDATE pm.questions SET status = 'cancelled', cancelled_by = $2, cancelled_at = now() WHERE id = $1", [second, s.nova]);
  check('waiting: a cancelled last question brings it back to running', (await state(twice)).status === 'running', await state(twice));

  // An expiry closes the question too: the watchdog stores it, the run runs again.
  const lapsing = await run('Lapsing ask');
  await ask(lapsing, 'Ship before Friday?', true);
  check('waiting: asked (already past due), the run waits until the expiry is stored', (await state(lapsing)).status === 'waiting', await state(lapsing));
  await watchdog(s);
  check('waiting: the stored expiry brings it back to running', (await state(lapsing)).status === 'running', await state(lapsing));

  // Waiting by hand, no question: seven days.
  const byHand = await run('Waiting by hand', 'waiting', '3 days');
  const longHeld = await run('Long ask', 'waiting', '8 days');
  await ask(longHeld, 'Still there?');
  await age(longHeld, '8 days');
  await watchdog(s);
  check('waiting: waiting by hand for three days is not timed out', (await state(byHand)).status === 'waiting', await state(byHand));
  check('waiting: eight days waiting with an open question is still waiting', (await state(longHeld)).status === 'waiting', await state(longHeld));
  await age(byHand, '8 days');
  check('waiting: the run feed reads eight quiet days waiting by hand as timed_out', (await feedStatus(byHand)) === 'timed_out', await feedStatus(byHand));
  const lapsed = await watchdog(s);
  const lapsedRow = await state(byHand);
  check('waiting: waiting by hand eight days with no question is stored as timed_out', lapsed.runs_timed_out === 1 && lapsedRow.status === 'timed_out' && !!lapsedRow.finished_at, { lapsed, lapsedRow });
  check('waiting: and sends run.finished once', (await events(s, 'run.finished')).filter((e) => e.payload.data.run.id === byHand && e.payload.data.run.status === 'timed_out').length === 1);

  // A finish from waiting.
  const finishing = await run('Finish while waiting', 'waiting');
  const done = (await s.q<Loose>("UPDATE pm.agent_runs SET status = 'succeeded' WHERE id = $1 RETURNING status, finished_at", [finishing]))[0];
  check('waiting: a run finishes from waiting, with its finish time', done.status === 'succeeded' && !!done.finished_at, done);
  const late = (await s.q<Loose>("UPDATE pm.agent_runs SET status = 'waiting' WHERE id = $1 RETURNING status", [finishing]))[0];
  check('waiting: a finished run cannot wait again', late.status === 'succeeded', late);

  // Only its asker's own run.
  const other = (await s.q<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title) VALUES ($1, 'Not Nova''s') RETURNING id", [s.relic]))[0].id;
  const refused = await s.q("INSERT INTO pm.questions (asked_by, asked_to, question, run_id) VALUES ($1, $2, 'Hijack?', $3)", [s.nova, s.owner, other])
    .then(() => null, (error: Error) => error.message);
  check("waiting: the database refuses a question naming another member's run", !!refused && /own run/.test(refused), refused);
  await s.q('UPDATE pm.webhook_endpoints SET is_active = false WHERE id = $1', [hook]);
}

async function questionChecks(s: Seed) {
  const ask = async (by: string, to: string, text: string, extra = '') =>
    (await s.q<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question, expires_at${extra ? ', task_id' : ''}) VALUES ($1, $2, $3, now() - interval '1 minute'${extra ? ', $4' : ''}) RETURNING id`, extra ? [by, to, text, extra] : [by, to, text]))[0].id;
  // Asked open, then the deadline passes (inserted past due: the trigger asks it as open).
  const mine = await ask(s.pat, s.owner, 'Ship Friday?');
  const task = (await s.q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Rounding') RETURNING id", [s.project]))[0].id;
  const novas = await ask(s.nova, s.owner, 'Per line or per invoice?', task);
  const ran = await watchdog(s);
  const states = await s.q<Loose>('SELECT id, status FROM pm.questions WHERE id IN ($1, $2)', [mine, novas]);
  check('questions: open questions past their time are stored as expired', ran.questions_expired === 2 && states.every((r) => r.status === 'expired'), { ran, states });
  const expired = await events(s, 'question.expired');
  check('questions: one question.expired each', expired.length === 2 && expired.every((e) => e.payload.data.question.status === 'expired'), expired.map((e) => e.payload.data.question.id));
  const patBell = (await bells(s, 'question', mine)).filter((b) => b.user_id !== s.owner);
  check('questions: a person who asked hears it once', patBell.length === 1 && patBell[0].user_id === s.pat && patBell[0].title === 'Your question to Olivia expired without an answer'
    && patBell[0].message === 'Ship Friday?' && patBell[0].cleared_at === null, patBell);
  const novaBell = (await bells(s, 'question', novas)).filter((b) => b.cleared_at === null);
  check('questions: an agent\'s question goes to its owners, linking to the task', novaBell.length === 1 && novaBell[0].user_id === s.pat
    && novaBell[0].title === "Nova's question to Olivia expired without an answer" && novaBell[0].link === `/projects/${s.project}?task=${task}`, novaBell);
  const again = await watchdog(s);
  check('questions: the next run repeats nothing', again.questions_expired === 0 && again.askers_told === 0 && (await events(s, 'question.expired')).length === 2, again);

  // A read stores the expiry first (expireDueQuestions): the event still goes, and the asker still hears.
  const read = (await s.q<{ id: string }>("INSERT INTO pm.questions (asked_by, asked_to, question, expires_at) VALUES ($1, $2, 'Budget ok?', now() + interval '1 hour') RETURNING id", [s.mia, s.owner]))[0].id;
  await s.q("UPDATE pm.questions SET expires_at = now() - interval '1 second' WHERE id = $1", [read]);
  await s.q("UPDATE pm.questions SET status = 'expired' WHERE status = 'open' AND expires_at <= now()");
  check('questions: a read that stores it sends question.expired too', (await events(s, 'question.expired')).length === 3);
  await watchdog(s);
  const miaBell = (await bells(s, 'question', read)).filter((b) => b.user_id !== s.owner);
  check('questions: and the asker hears on the next watchdog run', miaBell.length === 1 && miaBell[0].user_id === s.mia, miaBell);
}

async function webhookFailureChecks(s: Seed) {
  const event = (await s.q<{ id: string }>(`INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
    VALUES ('evt_flaky', nextval('pm.webhook_event_seq'), 'task.created', 'task', gen_random_uuid(), '{}') RETURNING id`))[0].id;
  const delivery = (await s.q<{ id: string }>('INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id) VALUES ($1, $2) RETURNING id', [event, s.flaky]))[0].id;
  const eventsBefore = (await s.q<Loose>('SELECT count(*)::int AS n FROM pm.webhook_events'))[0].n;
  const attempt = async (status: number) => {
    await s.q('UPDATE pm.webhook_deliveries SET next_attempt_at = now() - interval \'1 second\' WHERE id = $1', [delivery]);
    const claimed = (await s.q<Loose>('SELECT * FROM pm.claim_webhook_deliveries(20)')).find((c) => c.delivery_id === delivery);
    return (await s.q<Loose>('SELECT pm.complete_webhook_delivery($1, $2, $3, $4, NULL) AS outcome', [delivery, claimed?.attempt_token, status, status === 200 ? null : `HTTP ${status} from receiver`]))[0].outcome;
  };
  for (let i = 0; i < 4; i++) await attempt(500);
  const four = await watchdog(s);
  check('webhooks: four failures in a row tell nobody yet', four.webhooks_failing === 0 && (await bells(s, 'webhook', s.flaky)).length === 0, four);
  await attempt(500);
  const five = await watchdog(s);
  const told = await bells(s, 'webhook', s.flaky);
  check('webhooks: the fifth tells the Owner and whoever manages webhooks, once', five.webhooks_failing === 1
    && JSON.stringify(told.map((b) => b.user_id).sort()) === JSON.stringify([s.owner, s.mia].sort())
    && told.every((b) => b.title === 'Webhook Zapier keeps failing' && b.message === 'Last error: HTTP 500 from receiver' && b.link === '/settings/developers#webhooks'), told);
  check('webhooks: nobody else is told (a member without the permission)', told.every((b) => b.user_id !== s.pat));
  await attempt(500);
  const six = await watchdog(s);
  check('webhooks: more failures do not repeat it', six.webhooks_failing === 0 && (await bells(s, 'webhook', s.flaky)).length === 2, six);
  check('webhooks: nothing is sent to the endpoint about it', (await s.q<Loose>('SELECT count(*)::int AS n FROM pm.webhook_events'))[0].n === eventsBefore);
  const ok = await attempt(200);
  const after = await bells(s, 'webhook', s.flaky);
  const mark = await s.q<Loose>("SELECT * FROM pm.watchdog_marks WHERE kind = 'webhook_failing' AND subject_id = $1", [s.flaky]);
  check('webhooks: a success resets it and clears the bell', ok === 'succeeded' && mark.length === 0 && after.every((b) => b.cleared_at !== null), { ok, mark, after });
  // Failing again starts a new count: four is still not enough.
  const second = (await s.q<{ id: string }>('INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id) VALUES ($1, $2) RETURNING id', [event, s.flaky]))[0].id;
  await s.q('UPDATE pm.webhook_deliveries SET status = \'delivering\' WHERE id = $1', [second]);
  await s.q('UPDATE pm.webhook_deliveries SET status = \'pending\', last_error = \'timeout\' WHERE id = $1', [second]);
  const counted = await s.q<Loose>("SELECT failures FROM pm.watchdog_marks WHERE kind = 'webhook_failing' AND subject_id = $1", [s.flaky]);
  check('webhooks: after a reset the count starts again at one', counted[0]?.failures === 1, counted);
}

async function retentionChecks(s: Seed) {
  const event = async (age: string) => (await s.q<{ id: string }>(`INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload, created_at)
    VALUES ('evt_' || replace(gen_random_uuid()::text, '-', ''), nextval('pm.webhook_event_seq'), 'task.created', 'task', gen_random_uuid(), '{}', now() - $1::interval) RETURNING id`, [age]))[0].id;
  const delivery = async (eventId: string, status: string, age: string) => (await s.q<{ id: string }>(`INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id, status, created_at)
    VALUES ($1, $2, $3, now() - $4::interval) RETURNING id`, [eventId, s.listening, status, age]))[0].id;
  const oldSent = await event('40 days');
  const oldSentDelivery = await delivery(oldSent, 'succeeded', '40 days');
  const oldPending = await event('40 days');
  const oldPendingDelivery = await delivery(oldPending, 'pending', '40 days');
  const recent = await event('2 days');
  const recentDelivery = await delivery(recent, 'succeeded', '2 days');

  // Agent uptime history: two old rows and one newer for Nova; one old row only for Ghost.
  const ghost = (await s.q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Ghost', 'ghost@example.com', 'agent') RETURNING id"))[0].id;
  await s.q(`INSERT INTO pm.agent_health_history (member_id, container_running, turn_running, changed_at) VALUES
    ($1, true, false, now() - interval '200 days'), ($1, false, false, now() - interval '150 days'), ($1, true, false, now() - interval '5 days'),
    ($2, true, false, now() - interval '300 days')`, [s.nova, ghost]);

  // Chat: an old answered message, an old one still waiting, a recent one.
  const connection = (await s.q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials) VALUES ('slack', 'Slack', 'pm1:x') RETURNING id"))[0].id;
  const chat = async (status: string, age: string, key: string) => (await s.q<{ id: string }>(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, thread_id, dedupe_key, agent_id, text, created_at)
    VALUES ($1, 'inbound', $2, 'C1', 'T1', $3, $4, 'Private words', now() - $5::interval) RETURNING id`, [connection, status, key, s.buddy, age]))[0].id;
  const oldChat = await chat('replied', '60 days', 'k-old');
  const waitingChat = await chat('pending', '60 days', 'k-wait');
  const recentChat = await chat('replied', '1 day', 'k-new');

  // Old activity and an old finished run.
  await s.q("INSERT INTO pm.agent_activities (agent_id, activity_type, title, created_at) VALUES ($1, 'custom', 'Old note', now() - interval '400 days'), ($1, 'billing.started', 'Billing', now() - interval '400 days')", [s.nova]);
  const oldRun = (await s.q<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, status, started_at, finished_at) VALUES ($1, 'Ancient', 'succeeded', now() - interval '400 days', now() - interval '399 days') RETURNING id", [s.nova]))[0].id;
  // An old parent run whose finished child is newer than the cutoff: the
  // parent goes, the child stays with its lineage cleared (ON DELETE SET NULL).
  const oldParent = (await s.q<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, status, started_at, finished_at) VALUES ($1, 'Old parent', 'succeeded', now() - interval '400 days', now() - interval '399 days') RETURNING id", [s.nova]))[0].id;
  const newerChild = (await s.q<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, status, started_at, finished_at, parent_run_id) VALUES ($1, 'Newer child', 'succeeded', now() - interval '10 days', now() - interval '9 days', $2) RETURNING id", [s.nova, oldParent]))[0].id;
  await s.q("UPDATE pm.webhook_deliveries d SET status = 'succeeded', delivered_at = now() FROM pm.webhook_events ev WHERE ev.id = d.webhook_event_id AND ev.resource_id IN ($1, $2)", [oldParent, newerChild]);

  // With every setting null nothing goes.
  await s.q('UPDATE pm.business_settings SET webhook_retention_days = NULL, agent_health_history_days = NULL');
  const none = (await s.q<Loose>('SELECT pm.apply_data_retention() AS r'))[0].r;
  check('retention: with every setting on Keep forever, nothing is removed', Object.values(none).every((n) => n === 0)
    && (await s.q('SELECT 1 FROM pm.webhook_deliveries WHERE id = $1', [oldSentDelivery])).length === 1
    && (await s.q("SELECT 1 FROM pm.chat_messages WHERE text = 'Private words'")).length === 3, none);

  await s.q('UPDATE pm.business_settings SET webhook_retention_days = 30, agent_health_history_days = 90, chat_retention_days = 30, agent_activity_retention_days = 365, agent_run_retention_days = 365');
  const ran = await s.q<Loose>('SELECT pm.apply_data_retention() AS r').then((rows) => rows[0].r, (e: Error) => ({ error: e.message }));
  check('retention: runs without error with an old parent run whose child is newer', !ran.error, ran);
  const left = async (table: string, id: string) => (await s.q(`SELECT 1 FROM pm.${table} WHERE id = $1`, [id])).length === 1;
  const child = (await s.q<Loose>('SELECT parent_run_id, root_run_id FROM pm.agent_runs WHERE id = $1', [newerChild]))[0];
  check('retention: the old parent goes; its newer child stays, its parent and root cleared', !(await left('agent_runs', oldParent))
    && child?.parent_run_id === null && child.root_run_id === null && ran.agent_runs === 1, { ran, child });
  const liveParent = (await s.q<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, status, started_at, finished_at) VALUES ($1, 'Live parent', 'succeeded', now() - interval '2 days', now() - interval '2 days') RETURNING id", [s.nova]))[0].id;
  const liveChild = (await s.q<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, status, started_at, finished_at, parent_run_id) VALUES ($1, 'Live child', 'succeeded', now() - interval '1 day', now() - interval '1 day', $2) RETURNING id", [s.nova, liveParent]))[0].id;
  await s.q('UPDATE pm.agent_runs SET parent_run_id = NULL, root_run_id = NULL WHERE id = $1', [liveChild]);
  const kept = (await s.q<Loose>('SELECT parent_run_id, root_run_id FROM pm.agent_runs WHERE id = $1', [liveChild]))[0];
  check('retention: a link to a run that still exists still cannot be cleared', kept?.parent_run_id === liveParent && kept.root_run_id === liveParent, kept);
  check('retention: an old delivered delivery and its event go', !(await left('webhook_deliveries', oldSentDelivery)) && !(await left('webhook_events', oldSent)), ran);
  check('retention: an old pending delivery and its event stay', await left('webhook_deliveries', oldPendingDelivery) && await left('webhook_events', oldPending));
  check('retention: a recent delivered delivery stays', await left('webhook_deliveries', recentDelivery) && await left('webhook_events', recent));
  const history = await s.q<Loose>("SELECT member_id FROM pm.agent_health_history WHERE changed_at < now() - interval '90 days'");
  check('retention: old uptime history goes, but each agent keeps its newest row', history.length === 1 && history[0].member_id === ghost
    && (await s.q("SELECT 1 FROM pm.agent_health_history WHERE member_id = $1 AND changed_at BETWEEN now() - interval '6 days' AND now() - interval '4 days'", [s.nova])).length === 1, history);
  const chats = await s.q<Loose>('SELECT id, text, dedupe_key, thread_id, status FROM pm.chat_messages WHERE id IN ($1, $2, $3)', [oldChat, waitingChat, recentChat]);
  const blanked = chats.find((c) => c.id === oldChat);
  check('retention: old chat text is blanked, the row keeps its dedupe key and thread', blanked?.text === '' && blanked.dedupe_key === 'k-old' && blanked.thread_id === 'T1' && blanked.status === 'replied', chats);
  check('retention: a message still waiting for its assistant, and a recent one, keep their text',
    chats.find((c) => c.id === waitingChat)?.text === 'Private words' && chats.find((c) => c.id === recentChat)?.text === 'Private words', chats);
  const dup = await s.q<Loose>("INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, dedupe_key, text) VALUES ($1, 'inbound', 'pending', 'C1', 'k-old', 'again')", [connection]).then(() => 'inserted', (e: Error) => e.message);
  check('retention: a provider retry of a blanked message is still the same message (dedupe key unique)', /duplicate|unique/i.test(dup), dup);
  const acts = await s.q<Loose>("SELECT activity_type FROM pm.agent_activities WHERE created_at < now() - interval '300 days'");
  check('retention: old agent events go, billing events stay', acts.length === 1 && acts[0].activity_type === 'billing.started', acts);
  check('retention: an old run whose run.finished is still pending stays', await left('agent_runs', oldRun), ran);
  await s.q("UPDATE pm.webhook_deliveries d SET status = 'succeeded', delivered_at = now() FROM pm.webhook_events ev WHERE ev.id = d.webhook_event_id AND ev.resource_id = $1", [oldRun]);
  const runsGo = (await s.q<Loose>('SELECT pm.apply_data_retention() AS r'))[0].r;
  check('retention: once delivered, the old finished run goes through the job', !(await left('agent_runs', oldRun)) && runsGo.agent_runs === 1, runsGo);
  const byHand = await s.q("DELETE FROM pm.agent_runs WHERE status <> 'running'").then(() => 'deleted', (e: Error) => e.message);
  check('retention: runs are still never deleted by hand', /never permanently deleted/.test(byHand), byHand);
  const twice = (await s.q<Loose>('SELECT pm.apply_data_retention() AS r'))[0].r;
  check('retention: a second run finds nothing more', Object.values(twice).every((n) => n === 0), twice);
}

async function guardChecks(db: PGlite) {
  const attempt = async (login: string, sql: string) => {
    await actAs(db, login);
    await db.exec('RESET ROLE');
    const out = await db.query(sql).then(() => 'ok', (error: Error) => error.message);
    await actAs(db, null);
    await db.exec('RESET ROLE');
    return out;
  };
  const admin = await attempt(ADMIN_LOGIN.id, 'UPDATE pm.business_settings SET chat_retention_days = 7');
  const retries = await attempt(ADMIN_LOGIN.id, 'UPDATE pm.business_settings SET webhook_retries_off = true');
  const owner = await attempt(OWNER_LOGIN.id, 'UPDATE pm.business_settings SET chat_retention_days = 7');
  check('settings: an admin cannot change retention or retries in the database', /Only an Owner/.test(admin) && /Only an Owner/.test(retries), [admin, retries]);
  check('settings: an Owner can', owner === 'ok', owner);
  const range = await db.query('UPDATE pm.business_settings SET agent_run_retention_days = 3').then(() => 'ok', (e: Error) => e.message);
  check('settings: below the minimum is refused', /retention_days_check/.test(range), range);
}

async function retriesChecks(db: PGlite) {
  // Supabase Vault stand-in: store_webhook_scheduler writes the two names the kick reads.
  await db.exec(`CREATE OR REPLACE FUNCTION pm.store_webhook_scheduler(p_url text, p_secret text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      IF p_url NOT LIKE 'http%' THEN RAISE EXCEPTION 'p_url must be an http(s) address'; END IF;
      DELETE FROM vault.decrypted_secrets WHERE name IN ('pm_webhook_scheduler_url', 'pm_webhook_scheduler_secret');
      INSERT INTO vault.decrypted_secrets VALUES ('pm_webhook_scheduler_url', p_url), ('pm_webhook_scheduler_secret', p_secret);
    END $$;
    GRANT EXECUTE ON FUNCTION pm.store_webhook_scheduler(text, text) TO service_role;`);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'), NEXT_PUBLIC_APP_URL: 'https://pm.example.test',
  });
  delete process.env.WEBHOOK_SCHEDULER_ENABLED;
  try {
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const retries = await import('../src/lib/webhooks/retries');
    const service = getServiceClient();
    const { clearSecretCache, readSecret } = await import('../src/lib/secrets/store');
    // Two app servers setting retries up at once. Server A's Vault write is
    // held until server B is done, and B's app write lands after A's: written
    // one after the other, the app ends with B's secret and Vault with A's.
    const server = (hold: { setUpAfter?: Promise<unknown>; appWriteMs?: number }) => new Proxy(service, {
      get(target, prop, receiver) {
        if (prop === 'rpc') {
          return (fn: string, args?: Record<string, unknown>) => {
            const setUpWrite = /^https?:/.test(String(args?.p_url ?? '')) && (fn === 'store_webhook_scheduler' || fn === 'set_up_webhook_scheduler');
            return setUpWrite && hold.setUpAfter ? hold.setUpAfter.then(() => target.rpc(fn, args)) : target.rpc(fn, args);
          };
        }
        if (prop === 'from') {
          return (table: string) => {
            const builder = target.from(table);
            if (table !== 'app_secrets' || !hold.appWriteMs) return builder;
            return new Proxy(builder, {
              get(b, p, r) {
                if (p !== 'upsert') return Reflect.get(b, p, r);
                return (...args: unknown[]) => new Promise((done) => setTimeout(done, hold.appWriteMs)).then(() => Reflect.apply(b.upsert, b, args));
              },
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof service;
    const race = async (setUp: (client: typeof service) => Promise<unknown>) => {
      let bDone!: () => void;
      const afterB = new Promise<void>((done) => { bDone = done; });
      const answers = await Promise.all([setUp(server({ setUpAfter: afterB })), setUp(server({ appWriteMs: 50 })).finally(() => bDone())]);
      clearSecretCache();
      const app = await readSecret(service, 'webhook_scheduler_secret', { ...process.env, WEBHOOK_SCHEDULER_SECRET: undefined });
      const vault = (await db.query<Loose>("SELECT decrypted_secret AS v FROM vault.decrypted_secrets WHERE name = 'pm_webhook_scheduler_secret'")).rows;
      return { answers, same: !!app && vault.length === 1 && vault[0].v === app };
    };
    const before = await retries.webhookRetriesState(service);
    check('retries: off before anything turned them on', before.on === false && before.turnedOff === false && before.vault === true, before);
    const auto = await race((client) => retries.ensureWebhookRetries(client));
    const turned = auto.answers.filter((a) => a === true).length === 1;
    const on = await retries.webhookRetriesState(service);
    const vault = await db.query<Loose>("SELECT name FROM vault.decrypted_secrets WHERE name LIKE 'pm_webhook_scheduler_%' ORDER BY name");
    check('retries: on by default once they can run (secret saved, Vault written)', turned && on.on && on.source === 'app' && vault.rows.length === 2, { auto, on, vault: vault.rows });
    check('retries: two servers turning them on at once leave the app and Vault with the same secret, turned on once', auto.same && turned, auto);
    // A due delivery: the kick sends.
    await db.query("UPDATE pm.webhook_deliveries SET status = 'pending', next_attempt_at = now() - interval '1 minute' WHERE endpoint_id = (SELECT id FROM pm.webhook_endpoints WHERE name = 'Harness') AND status = 'pending'");
    const kicked = (await db.query<Loose>('SELECT pm.webhook_retry_kick() AS id')).rows[0].id;
    check('retries: the database kicks while they are on', kicked !== null, kicked);
    const owner = (await db.query<{ id: string }>("SELECT id FROM pm.team_members WHERE name = 'Olivia'")).rows[0].id;
    const off = await retries.turnOffWebhookRetries(service, owner);
    retries.resetWebhookRetriesCheck();
    const again = await retries.ensureWebhookRetries(service);
    const quiet = (await db.query<Loose>('SELECT pm.webhook_retry_kick() AS id')).rows[0].id;
    check('retries: an Owner turns them off; nothing turns them on again, and the database sends no kick', off.on === false && off.turnedOff === true && again === false && quiet === null, { off, again, quiet });
    const back = await retries.turnOnWebhookRetries(service, owner);
    check('retries: an Owner turns them on again', back.on === true && back.turnedOff === false, back);
    const owners = await race((client) => retries.turnOnWebhookRetries(client, owner));
    check('retries: two turn-ons at once leave the app and Vault with the same secret', owners.same, owners);
  } finally {
    await server.close();
  }
}

async function main() {
  await migrationChecks();
  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  await agentChecks(s);
  await runChecks(s);
  await questionChecks(s);
  await waitingChecks(s);
  await webhookFailureChecks(s);
  await retentionChecks(s);
  await guardChecks(db);
  await retriesChecks(db);
  await db.close();

  if (failures.length) {
    console.error(`verify-watchdog: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`verify-watchdog: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
