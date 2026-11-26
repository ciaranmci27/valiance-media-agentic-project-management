/**
 * Schedules (20261126000400_schedules.sql): recurring templates and task
 * repeats on one scheduler, over the real services and routes (a fake
 * PostgREST over PGlite with the full schema):
 * - Next-run math for each recurrence (every N days, weeks on weekdays,
 *   monthly on a day with the 31st clamped to the month's end, the first and
 *   last weekday), in two time zones and across clock changes.
 * - A claim is never made twice, even when two runners race, and the
 *   (schedule, date) backstop holds.
 * - Catch-up after downtime runs only the latest missed date, anchored to it.
 * - skip_if_open records its reason; date and month fill in.
 * - A runner who lost access pauses the schedule and is told; a failure is
 *   retried once, then pauses; the end date stops it.
 * - A task repeat makes the next copy with shifted dates, unchecked
 *   subtasks and the same initiative, follows the newest copy, catches up
 *   once; after_done waits for done.
 * - The internal route refuses without the scheduler secret.
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   the tables and functions are server only; the kick only calls while due.
 * - REST, session routes and MCP.
 *
 *   npm run -s test:schedules
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase, applyMigrationsFrom, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import {
  dateInZone, describeRecurrence, lastOnOrBefore, nextAfter, nextOnOrAfter, occursOn, recurrenceSchema, scheduleFills, upcomingDates, zonedMidnight,
  type Recurrence,
} from '../src/lib/schedules';

const MIGRATION = '20261126000400_schedules.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- SCHEDULES (20261126000400_schedules.sql)\n-- ============================================================\n';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NY = 'America/New_York';
const LONDON = 'Europe/London';
const LOGIN = { id: id(3101), email: 'olivia@studio.example' };

// ── Pure: the recurrence math ────────────────────────────────────────────

function pureChecks() {
  const r = (rule: Partial<Recurrence> & Pick<Recurrence, 'freq'>) => recurrenceSchema.parse(rule);
  const daily3 = r({ freq: 'daily', interval: 3 });
  check('daily: every 3 days from the start, never before it', upcomingDates(daily3, '2026-12-30', '2026-12-01', 4).join() === '2026-12-30,2027-01-02,2027-01-05,2027-01-08'
    && nextOnOrAfter(daily3, '2026-12-30', '2027-01-03') === '2027-01-05' && lastOnOrBefore(daily3, '2026-12-30', '2027-01-04') === '2027-01-02');

  const biweekly = r({ freq: 'weekly', interval: 2, weekdays: [1, 4] });
  // Start Wed 2026-12-02: its week (Mon Nov 30) is week 0, so Thu Dec 3, then Mon Dec 14, Thu Dec 17.
  check('weekly: every 2 weeks on Monday and Thursday, counted from the start\'s week', upcomingDates(biweekly, '2026-12-02', '2026-12-02', 4).join() === '2026-12-03,2026-12-14,2026-12-17,2026-12-28'
    && !occursOn(biweekly, '2026-12-02', '2026-12-07') && lastOnOrBefore(biweekly, '2026-12-02', '2026-12-13') === '2026-12-03');

  const monthEnd = r({ freq: 'monthly', month_day: 31 });
  check('monthly: the 31st clamps to each month\'s last day, a leap February included', upcomingDates(monthEnd, '2027-12-01', '2027-12-01', 5).join() === '2027-12-31,2028-01-31,2028-02-29,2028-03-31,2028-04-30'
    && nextAfter(monthEnd, '2027-12-01', '2028-01-31') === '2028-02-29');
  const quarterly = r({ freq: 'monthly', interval: 3, month_day: 15 });
  check('monthly: every 3 months on the 15th, counted from the start\'s month', upcomingDates(quarterly, '2026-11-20', '2026-11-20', 3).join() === '2027-02-15,2027-05-15,2027-08-15');
  const lastFriday = r({ freq: 'monthly', month_week: -1, month_weekday: 5 });
  const firstMonday = r({ freq: 'monthly', month_week: 1, month_weekday: 1 });
  check('monthly: the last Friday and the first Monday', upcomingDates(lastFriday, '2026-12-01', '2026-12-01', 3).join() === '2026-12-25,2027-01-29,2027-02-26'
    && upcomingDates(firstMonday, '2026-12-01', '2026-12-01', 3).join() === '2026-12-07,2027-01-04,2027-02-01'
    && lastOnOrBefore(lastFriday, '2026-12-01', '2027-01-28') === '2026-12-25');
  check('words: plain recurrence labels', describeRecurrence(monthEnd) === 'Every month on the last day' && describeRecurrence(r({ freq: 'monthly', month_day: 1 })) === 'Every month on the 1st'
    && describeRecurrence(biweekly) === 'Every 2 weeks on Monday and Thursday' && describeRecurrence(r({ freq: 'weekly', weekdays: [1] })) === 'Every Monday'
    && describeRecurrence(lastFriday) === 'Every month on the last Friday' && describeRecurrence(r({ freq: 'weekly', weekdays: [5, 4, 3, 2, 1] })) === 'Every weekday',
  [describeRecurrence(monthEnd), describeRecurrence(biweekly), describeRecurrence(lastFriday)]);
  const refused = [
    recurrenceSchema.safeParse({ freq: 'weekly' }).success,
    recurrenceSchema.safeParse({ freq: 'monthly' }).success,
    recurrenceSchema.safeParse({ freq: 'monthly', month_day: 1, month_week: 1, month_weekday: 1 }).success,
    recurrenceSchema.safeParse({ freq: 'daily', interval: 400 }).success,
  ];
  check('schema: weekly needs weekdays, monthly needs one way of picking the day, intervals are capped', refused.every((ok) => !ok), refused);

  // Clock changes, in two time zones: a day starts at its local midnight.
  check('time zones: New York\'s day starts at 05:00Z before the March change and 04:00Z after', zonedMidnight('2026-03-08', NY).toISOString() === '2026-03-08T05:00:00.000Z'
    && zonedMidnight('2026-03-09', NY).toISOString() === '2026-03-09T04:00:00.000Z' && zonedMidnight('2026-11-02', NY).toISOString() === '2026-11-02T05:00:00.000Z');
  check('time zones: London\'s day starts at 00:00Z in winter and 23:00Z the evening before in summer', zonedMidnight('2026-03-29', LONDON).toISOString() === '2026-03-29T00:00:00.000Z'
    && zonedMidnight('2026-03-30', LONDON).toISOString() === '2026-03-29T23:00:00.000Z');
  let wrong: string | null = null;
  for (const zone of [NY, LONDON, 'America/Santiago', 'Australia/Sydney']) {
    for (let day = 0; day < 366 && !wrong; day++) {
      const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
      const start = zonedMidnight(date, zone);
      if (dateInZone(start, zone) !== date || dateInZone(start.getTime() - 1, zone) === date) wrong = `${zone} ${date} ${start.toISOString()}`;
    }
  }
  check('time zones: every day of a year in four zones starts on its own date and the moment before is the day before (midnight skipped in Santiago included)', !wrong, wrong);
  const weekly = r({ freq: 'weekly', weekdays: [0] });
  const runs = upcomingDates(weekly, '2026-10-25', '2026-10-25', 2).map((d) => zonedMidnight(d, NY).toISOString());
  check('time zones: a weekly run keeps local midnight across the November change', runs.join() === '2026-10-25T04:00:00.000Z,2026-11-01T04:00:00.000Z'
    && zonedMidnight('2026-11-08', NY).toISOString() === '2026-11-08T05:00:00.000Z', runs);
  check('fills: date and month for a run date', JSON.stringify(scheduleFills('2026-12-01')) === '{"date":"2026-12-01","month":"December 2026"}');
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n-- ', at + BANNER.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && SCHEMA_SQL.slice(at + BANNER.length, next < 0 ? undefined : next) === MIGRATION_SQL);
  check('migration: no em or en dash', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  const later = readdirSync(join(__dirname, '..', 'supabase', 'migrations')).filter((f) => f.endsWith('.sql') && f > MIGRATION);
  check('migration: every later migration has its own section after this one', later.every((f) => SCHEMA_SQL.indexOf(`(${f})`, at + BANNER.length) > 0), later);

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await old.exec('RESET ROLE');
  // A task the previous release finishes still finishes (the new trigger touches only schedules).
  const oldProject = (await old.query<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Old') RETURNING id")).rows[0].id;
  const oldTask = (await old.query<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status) VALUES ($1, 'Old', 'todo') RETURNING id", [oldProject])).rows[0].id;
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql (fresh equals upgraded)', diff.length === 0, diff.slice(0, 10));
  const finished = await old.query("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [oldTask]).then(() => true, (e: Error) => e.message);
  check('compatibility: finishing a task with no repeat works as before', finished === true, finished);
  await old.close();

  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;
  const grants = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_schema = 'pm' AND table_name IN ('schedules', 'schedule_occurrences') AND grantee IN ('anon', 'authenticated')`))[0].n;
  const fns = (await q<{ claim: boolean; kick: boolean }>(`SELECT has_function_privilege('authenticated', 'pm.claim_schedule_occurrence(uuid, timestamptz, date, date, timestamptz, text, uuid)', 'EXECUTE') AS claim,
    has_function_privilege('authenticated', 'pm.schedules_kick()', 'EXECUTE') AS kick`))[0];
  check('database: schedules and occurrences are server only; members cannot claim or kick', grants === 0 && !fns.claim && !fns.kick, { grants, fns });
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Kick') RETURNING id"))[0].id;
  const task = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, due_date) VALUES ($1, 'Kick', 'todo', '2026-12-07') RETURNING id", [project]))[0].id;
  const kick = async () => (await q<{ k: string | null }>('SELECT pm.schedules_kick()::text AS k'))[0].k;
  await q("INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES ('pm_webhook_scheduler_url', 'https://pm.example.com'), ('pm_webhook_scheduler_secret', 'x')");
  const schedule = (await q<{ id: string }>(`INSERT INTO pm.schedules (kind, task_id, project_id, recurrence, start_date, next_run_at, next_on)
    VALUES ('task', $1, $2, '{"freq":"daily"}', '2026-12-07', now() + interval '1 day', '2026-12-08') RETURNING id`, [task, project]))[0].id;
  const notDue = await kick();
  await q("UPDATE pm.schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [schedule]);
  const due = await kick();
  check('kick: calls the app only while a schedule is due', notDue === null && due === '1', { notDue, due });
  await q("UPDATE pm.schedules SET mode = 'after_done', next_run_at = NULL WHERE id = $1", [schedule]);
  await q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [task]);
  const marked = (await q<Loose>('SELECT next_run_at, done_on FROM pm.schedules WHERE id = $1', [schedule]))[0];
  check('trigger: completing the task an after_done repeat follows makes it due now', marked.next_run_at !== null && marked.done_on !== null, marked);
  const job = (await q<{ n: number }>("SELECT count(*)::int AS n FROM cron.job WHERE jobname = 'pm-schedules-due'"))[0].n;
  check('cron: no job where pg_cron is missing (PGlite)', job === 0);
  const twice = await fresh.query(`INSERT INTO pm.schedule_occurrences (schedule_id, scheduled_for) VALUES ($1, '2026-12-08'), ($1, '2026-12-08')`, [schedule]).then(() => null, (e: Error) => e.message);
  check('backstop: one occurrence per schedule and date', /idx_schedule_occurrences_once|duplicate/.test(twice ?? ''), twice);
  await fresh.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    const memberId = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role, timezone) VALUES ($1, $2, $3, 'America/New_York') RETURNING id",
      [name, login?.email ?? `${name.toLowerCase()}@studio.example`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, memberId]);
    }
    return memberId;
  };
  const owner = await member('Olivia', 'owner', LOGIN);
  const morgan = await member('Morgan', 'member');
  const sam = await member('Sam', 'member');
  const nina = await member('Nina', 'member');
  const projectId = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Payroll') RETURNING id"))[0].id;
  for (const m of [morgan, sam, nina]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [projectId, m]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, ['templates.manage', 'tasks.create', 'tasks.read', 'tasks.manage_all', 'projects.read', 'projects.read_all']),
    nina: await key(nina, ['tasks.create', 'tasks.read', 'tasks.manage_assigned', 'projects.read']),
  };
  const template = (await q<{ id: string }>(`INSERT INTO pm.task_templates (name, fields, key_dates, roles, items, created_by) VALUES (
    'Monthly payroll',
    '[{"key":"month","label":"Month"},{"key":"client","label":"Client"}]',
    '[{"key":"start","label":"Run date"},{"key":"review","label":"Review"}]',
    '[{"key":"owner","label":"Owner"}]',
    '[{"key":"upload","title":"Upload {client} payroll for {month}","role":"owner","due_in_days":2},{"key":"check","title":"Review {month}","anchor":"review","due_in_days":0}]',
    $1) RETURNING id`, [owner]))[0].id;
  return { q, owner, morgan, sam, nina, projectId, keys, template };
}

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const authStandIn = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: LOGIN.id, aud: 'authenticated', role: 'authenticated', email: LOGIN.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-26T00:00:00Z' }));
      return true;
    }
    return false;
  };
  const server = await startFakePostgrest(db, { handle: authStandIn });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  // A signed-in Olivia for the session routes.
  const cookie = `sb-${new URL(server.url).hostname.split('.')[0]}-auth-token`;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sessionValue = `base64-${Buffer.from(JSON.stringify({
    access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: LOGIN.id, email: LOGIN.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`,
    refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: exp,
    user: { id: LOGIN.id, email: LOGIN.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-26T00:00:00Z' },
  })).toString('base64url')}`;
  const store = { getAll: () => [{ name: cookie, value: sessionValue }], get: (k: string) => (k === cookie ? { name: cookie, value: sessionValue } : undefined), set: () => undefined };
  (createRequire(__filename)('next/headers') as { cookies: () => Promise<typeof store> }).cookies = async () => store;

  try {
    const { createPmClient } = await import('../src/lib/supabase/pm-client');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const api = await import('../src/lib/api/schedules');
    const service = createPmClient(server.url, 'fake-service-key', { auth: { persistSession: false, autoRefreshToken: false } });
    const callerFor = async (memberId: string) => ({ memberId, access: (await resolveMemberAccess(service, memberId))!, scopes: null });
    const owner = await callerFor(s.owner);
    const one = async <T = Loose>(sql: string, params: unknown[] = []) => (await s.q<T>(sql, params))[0];
    const count = async (sql: string, params: unknown[] = []) => (await one<{ n: number }>(sql, params)).n;
    const at = (iso: string) => new Date(iso);
    const errorOf = (promise: Promise<unknown>) => promise.then(() => null, (error: Loose) => error);

    // ── Template schedules ───────────────────────────────────────────────
    const created = await api.createTemplateSchedule(service, owner, s.template, {
      project_id: s.projectId, recurrence: { freq: 'monthly', interval: 1, month_day: 31 }, start_date: '2026-11-01',
      roles: { owner: 'runner' }, values: { client: 'Acme' }, key_date_offsets: { review: 5 }, create_initiative: false, skip_if_open: true,
    }, at('2026-12-01T15:00:00Z'));
    check('create: the workspace zone by default, next run the 31st, the next five dates clamped to month ends', created.timezone === NY && created.next_on === '2026-12-31'
      && created.next_run_at === '2026-12-31T05:00:00.000Z' && created.upcoming.join() === '2026-12-31,2027-01-31,2027-02-28,2027-03-31,2027-04-30'
      && created.run_as === s.owner && created.recurrence_label === 'Every month on the last day', created);
    const badRole = await errorOf(api.createTemplateSchedule(service, owner, s.template, { project_id: s.projectId, recurrence: { freq: 'daily', interval: 1 }, roles: { writer: 'runner' }, values: { client: 'Acme' }, key_date_offsets: { launch: 1 }, create_initiative: false, skip_if_open: true }));
    const paths = (badRole?.details?.errors ?? []).map((e: Loose) => e.path);
    check('create: checked like a run, every error at its path, nothing saved', badRole?.statusCode === 422 && paths.includes('roles.writer') && paths.includes('key_date_offsets.launch')
      && await count('SELECT count(*)::int AS n FROM pm.schedules') === 1, badRole?.details);
    const missingValue = await errorOf(api.createTemplateSchedule(service, owner, s.template, { project_id: s.projectId, recurrence: { freq: 'daily', interval: 1 }, roles: {}, values: {}, key_date_offsets: {}, create_initiative: false, skip_if_open: true }));
    check('create: month is filled on each run, so only client is missing', missingValue?.statusCode === 422 && (missingValue.details.errors as Loose[]).map((e) => e.path).join() === 'values.client', missingValue?.details);

    // A daily schedule, due now, run by two runners at once.
    const daily = await api.createTemplateSchedule(service, owner, s.template, {
      project_id: s.projectId, recurrence: { freq: 'daily', interval: 1 }, start_date: '2026-12-01', roles: { owner: 'runner' }, values: { client: 'Acme' },
      key_date_offsets: { review: 5 }, create_initiative: false, skip_if_open: true,
    }, at('2026-12-01T15:00:00Z'));
    const tick1 = at('2026-12-01T15:05:00Z');
    const [a, b] = await Promise.all([api.runDueSchedules(service, tick1), api.runDueSchedules(service, tick1)]);
    const runs1 = await s.q<Loose>('SELECT id, via, schedule_id, key_dates, field_values, task_ids FROM pm.task_template_runs WHERE schedule_id = $1', [daily.id]);
    check('claim: two runners at once make one run, never two', runs1.length === 1 && a.created + b.created === 1 && runs1[0].via === 'schedule'
      && await count('SELECT count(*)::int AS n FROM pm.schedule_occurrences WHERE schedule_id = $1', [daily.id]) === 1, { runs1, a, b });
    const run1 = runs1[0] ?? {};
    const titles = (await s.q<{ title: string; due_date: string; assignees: string[] }>(`SELECT t.title, t.due_date::text, array(SELECT member_id::text FROM pm.task_assignees WHERE task_id = t.id) AS assignees
      FROM pm.tasks t WHERE t.id = ANY($1::uuid[]) ORDER BY t.title`, [run1.task_ids ?? []]));
    check('fills: month and client fill in; key dates anchor to the run date plus offsets; "runner" is the schedule\'s runner', run1.field_values?.month === 'December 2026'
      && run1.key_dates?.start === '2026-12-01' && run1.key_dates?.review === '2026-12-06'
      && titles.some((t) => t.title === 'Upload Acme payroll for December 2026' && t.due_date === '2026-12-03' && t.assignees.includes(s.owner))
      && titles.some((t) => t.title === 'Review December 2026' && t.due_date === '2026-12-06'), { run1, titles });
    const afterClaim = await one<Loose>('SELECT next_on::text, next_run_at, last_outcome FROM pm.schedules WHERE id = $1', [daily.id]);
    check('claim: next_run_at moves on to the next local midnight', afterClaim.next_on === '2026-12-02' && new Date(afterClaim.next_run_at).toISOString() === '2026-12-02T05:00:00.000Z'
      && afterClaim.last_outcome === 'created', afterClaim);
    const stale = await service.rpc('claim_schedule_occurrence', { p_schedule_id: daily.id, p_expected_run_at: '2026-12-01T05:00:00Z', p_scheduled_for: '2026-12-01', p_next_on: '2026-12-02', p_next_run_at: '2026-12-02T05:00:00Z' });
    check('claim: a runner holding an old next_run_at claims nothing', stale.data === null && !stale.error, stale);
    // The backstop: a date that already has an occurrence is never made again, even when next_run_at says so.
    await s.q("UPDATE pm.schedules SET next_on = '2026-12-01', next_run_at = '2026-12-01T05:00:00Z' WHERE id = $1", [daily.id]);
    const backstop = await service.rpc('claim_schedule_occurrence', { p_schedule_id: daily.id, p_expected_run_at: '2026-12-01T05:00:00Z', p_scheduled_for: '2026-12-01', p_next_on: '2026-12-02', p_next_run_at: '2026-12-02T05:00:00Z' });
    check('backstop: a date already run returns no claim and the schedule still moves on', backstop.data === null
      && (await one<Loose>('SELECT next_on::text FROM pm.schedules WHERE id = $1', [daily.id])).next_on === '2026-12-02', backstop);

    // Skip if open: the first run's tasks are still open.
    await api.runDueSchedules(service, at('2026-12-02T15:00:00Z'));
    const skipped = await one<Loose>("SELECT status, reason FROM pm.schedule_occurrences WHERE schedule_id = $1 AND scheduled_for = '2026-12-02'", [daily.id]);
    check('skip if open: the run is skipped with its reason while the previous run has an open task', skipped?.status === 'skipped' && skipped.reason === 'previous_run_open'
      && await count('SELECT count(*)::int AS n FROM pm.task_template_runs WHERE schedule_id = $1', [daily.id]) === 1, skipped);
    await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = ANY($1::uuid[])", [run1.task_ids]);

    // Catch-up: down for a week; only the latest missed date runs, dated from it.
    await api.runDueSchedules(service, at('2026-12-09T18:00:00Z'));
    const caught = await s.q<Loose>("SELECT scheduled_for::text FROM pm.schedule_occurrences WHERE schedule_id = $1 AND status = 'created' ORDER BY scheduled_for", [daily.id]);
    const latestRun = await one<Loose>('SELECT key_dates, field_values FROM pm.task_template_runs WHERE schedule_id = $1 ORDER BY created_at DESC LIMIT 1', [daily.id]);
    check('catch-up: after downtime only the latest missed date runs, its key dates anchored to that date', caught.map((r) => r.scheduled_for).join() === '2026-12-01,2026-12-09'
      && latestRun.key_dates.start === '2026-12-09' && latestRun.key_dates.review === '2026-12-14'
      && (await one<Loose>('SELECT next_on::text FROM pm.schedules WHERE id = $1', [daily.id])).next_on === '2026-12-10', { caught, latestRun });

    // End date: the last run happens, then it ends; a schedule past its end ends without running.
    await api.updateSchedule(service, owner, daily.id, { end_date: '2026-12-10', skip_if_open: false }, at('2026-12-09T18:30:00Z'));
    await api.runDueSchedules(service, at('2026-12-10T15:00:00Z'));
    const ended = await one<Loose>('SELECT status, next_on, next_run_at FROM pm.schedules WHERE id = $1', [daily.id]);
    await api.runDueSchedules(service, at('2026-12-12T15:00:00Z'));
    check('end date: the run on the end date happens, then the schedule ends and makes nothing more', ended.status === 'ended' && ended.next_on === null && ended.next_run_at === null
      && await count("SELECT count(*)::int AS n FROM pm.schedule_occurrences WHERE schedule_id = $1 AND scheduled_for > '2026-12-10'", [daily.id]) === 0
      && await count("SELECT count(*)::int AS n FROM pm.schedule_occurrences WHERE schedule_id = $1 AND scheduled_for = '2026-12-10' AND status = 'created'", [daily.id]) === 1, ended);

    // Lost access: Morgan sets one up, then leaves the project.
    const morgan = await callerFor(s.morgan);
    const morganSchedule = await api.createTemplateSchedule(service, morgan, s.template, {
      project_id: s.projectId, recurrence: { freq: 'weekly', interval: 1, weekdays: [1] }, start_date: '2026-12-07', roles: {}, values: { client: 'Bolt' },
      key_date_offsets: {}, create_initiative: false, skip_if_open: false,
    }, at('2026-12-01T15:00:00Z'));
    await s.q('DELETE FROM pm.project_members WHERE project_id = $1 AND member_id = $2', [s.projectId, s.morgan]);
    await api.runDueSchedules(service, at('2026-12-07T15:00:00Z'));
    const lost = await one<Loose>('SELECT status, paused_reason FROM pm.schedules WHERE id = $1', [morganSchedule.id]);
    const lostOccurrence = await one<Loose>('SELECT status, reason FROM pm.schedule_occurrences WHERE schedule_id = $1', [morganSchedule.id]);
    const told = await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE user_id = $1 AND entity_type = 'schedule' AND entity_id = $2", [s.morgan, morganSchedule.id]);
    check('lost access: the run is skipped, the schedule pauses and its runner is notified', lost.status === 'paused' && lost.paused_reason === 'lost_access'
      && lostOccurrence?.status === 'skipped' && lostOccurrence.reason === 'lost_access' && told === 1
      && await count('SELECT count(*)::int AS n FROM pm.task_template_runs WHERE schedule_id = $1', [morganSchedule.id]) === 0, { lost, lostOccurrence, told });

    // A failure is tried once more on the next tick, then the schedule pauses.
    const failing = await api.createTemplateSchedule(service, owner, s.template, {
      project_id: s.projectId, recurrence: { freq: 'daily', interval: 1 }, start_date: '2026-12-20', roles: { owner: s.sam }, values: { client: 'Core' },
      key_date_offsets: {}, create_initiative: false, skip_if_open: false,
    }, at('2026-12-19T15:00:00Z'));
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.sam]);
    await api.runDueSchedules(service, at('2026-12-20T15:00:00Z'));
    const firstTry = await one<Loose>('SELECT status, attempts, error FROM pm.schedule_occurrences WHERE schedule_id = $1', [failing.id]);
    const stillActive = (await one<Loose>('SELECT status FROM pm.schedules WHERE id = $1', [failing.id])).status;
    await api.runDueSchedules(service, at('2026-12-20T15:05:00Z'));
    const secondTry = await one<Loose>("SELECT status, attempts FROM pm.schedule_occurrences WHERE schedule_id = $1 AND scheduled_for = '2026-12-20'", [failing.id]);
    const pausedFailing = await one<Loose>('SELECT status, paused_reason FROM pm.schedules WHERE id = $1', [failing.id]);
    check('failure: logged with its error, retried once on the next tick, then the schedule pauses with a notification', firstTry?.status === 'failed' && firstTry.attempts === 1
      && /Owner/.test(firstTry.error ?? '') && stillActive === 'active' && secondTry?.status === 'failed' && secondTry.attempts === 2
      && pausedFailing.status === 'paused' && pausedFailing.paused_reason === 'failed_twice'
      && await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE user_id = $1 AND entity_type = 'schedule' AND entity_id = $2", [s.owner, failing.id]) === 1,
    { firstTry, stillActive, secondTry, pausedFailing });
    await s.q("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [s.sam]);
    const resumed = await api.updateSchedule(service, owner, failing.id, { status: 'active' }, at('2026-12-22T15:00:00Z'));
    check('resume: from today, missed dates not made', resumed.status === 'active' && resumed.next_on === '2026-12-22' && resumed.paused_reason === null, resumed);

    // ── Task repeats ─────────────────────────────────────────────────────
    const initiative = (await one<{ id: string }>("INSERT INTO pm.initiatives (project_id, name, status) VALUES ($1, 'Ops', 'active') RETURNING id", [s.projectId])).id;
    const task = (await one<{ id: string }>(`INSERT INTO pm.tasks (project_id, title, description, status, priority, tags, due_date, initiative_id, created_by)
      VALUES ($1, 'Weekly report', 'Numbers for the week', 'in_progress', 'high', ARRAY['ops'], '2026-12-07', $2, $3) RETURNING id`, [s.projectId, initiative, s.owner])).id;
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [task, s.nina]);
    await s.q(`INSERT INTO pm.tasks (project_id, title, status, priority, due_date, parent_task_id, sort_order) VALUES
      ($1, 'Pull numbers', 'done', 'medium', '2026-12-06', $2, 0), ($1, 'Write it up', 'todo', 'medium', NULL, $2, 1)`, [s.projectId, task]);
    const set = await api.setTaskRepeat(service, owner, task, { recurrence: { freq: 'weekly', interval: 1, weekdays: [1] }, mode: 'schedule' }, at('2026-12-01T15:00:00Z'));
    check('repeat: the next copy is due a week later, made when this one falls due', set.repeat.next_on === '2026-12-14' && set.repeat.next_run_at === '2026-12-07T05:00:00.000Z'
      && set.due_date_set === false && set.repeat.recurrence_label === 'Every Monday', set);
    await api.runDueSchedules(service, at('2026-12-07T05:10:00Z'));
    const copy = await one<Loose>(`SELECT t.id, t.title, t.description, t.status, t.priority, t.tags, t.due_date::text, t.initiative_id,
      array(SELECT member_id::text FROM pm.task_assignees WHERE task_id = t.id) AS assignees
      FROM pm.tasks t WHERE t.project_id = $1 AND t.title = 'Weekly report' AND t.id <> $2 AND t.parent_task_id IS NULL`, [s.projectId, task]);
    const copySubs = copy ? await s.q<Loose>('SELECT title, status, due_date::text FROM pm.tasks WHERE parent_task_id = $1 ORDER BY sort_order', [copy.id]) : [];
    check('repeat: the copy keeps title, description, priority, tags, assignees and initiative, due a week on', !!copy && copy.status === 'todo' && copy.priority === 'high'
      && copy.description === 'Numbers for the week' && copy.tags.join() === 'ops' && copy.due_date === '2026-12-14' && copy.initiative_id === initiative
      && copy.assignees.join() === s.nina, copy);
    check('repeat: subtasks are copied unchecked, their due dates shifted alike', copySubs.length === 2 && copySubs.every((t) => t.status === 'todo')
      && copySubs[0].due_date === '2026-12-13' && copySubs[1].due_date === null, copySubs);
    const following = await one<Loose>("SELECT task_id, next_on::text, next_run_at FROM pm.schedules WHERE kind = 'task' AND id = $1", [set.repeat.id]);
    check('repeat: the series follows its newest copy', following.task_id === copy?.id && following.next_on === '2026-12-21'
      && new Date(following.next_run_at).toISOString() === '2026-12-14T05:00:00.000Z', following);
    await api.runDueSchedules(service, at('2026-12-29T12:00:00Z'));
    const series = await s.q<Loose>("SELECT due_date::text FROM pm.tasks WHERE project_id = $1 AND title = 'Weekly report' AND parent_task_id IS NULL ORDER BY due_date", [s.projectId]);
    check('repeat: after downtime one copy, for the next date after the latest missed one', series.map((r) => r.due_date).join() === '2026-12-07,2026-12-14,2027-01-04', series);

    // After done.
    const chore = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority, created_by) VALUES ($1, 'Water plants', 'todo', 'low', $2) RETURNING id", [s.projectId, s.owner])).id;
    const choreSet = await api.setTaskRepeat(service, owner, chore, { recurrence: { freq: 'daily', interval: 3 }, mode: 'after_done' }, at('2026-12-01T15:00:00Z'));
    check('after done: a task without a due date gets the first date, and the repeat waits for done', choreSet.due_date_set && choreSet.due_date === '2026-12-01'
      && choreSet.repeat.next_run_at === null && choreSet.repeat.mode === 'after_done', choreSet);
    await api.runDueSchedules(service, at('2026-12-05T15:00:00Z'));
    const beforeDone = await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Water plants'");
    await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [chore]);
    await s.q("UPDATE pm.schedules SET done_on = '2026-12-05' WHERE id = $1", [choreSet.repeat.id]);
    await Promise.all([api.runDueSchedules(service, new Date()), api.runDueSchedules(service, new Date())]);
    await api.runDueSchedules(service, new Date());
    const chores = await s.q<Loose>("SELECT due_date::text, status FROM pm.tasks WHERE title = 'Water plants' ORDER BY due_date", []);
    check('after done: nothing until it is done; then one copy due 3 days after that day, never two', beforeDone === 1
      && chores.map((r) => `${r.due_date}:${r.status}`).join() === '2026-12-01:done,2026-12-08:todo', chores);

    // After done, twice in one day: each copy completed gets a next copy on a new date.
    const dailyCheck = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority, created_by) VALUES ($1, 'Daily check', 'todo', 'low', $2) RETURNING id", [s.projectId, s.owner])).id;
    const dailySet = await api.setTaskRepeat(service, owner, dailyCheck, { recurrence: { freq: 'daily', interval: 1 }, mode: 'after_done' }, at('2026-12-01T15:00:00Z'));
    await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [dailyCheck]);
    await s.q("UPDATE pm.schedules SET done_on = '2026-12-05' WHERE id = $1", [dailySet.repeat.id]);
    await api.runDueSchedules(service, new Date());
    const secondCopy = await one<{ id: string }>("SELECT id FROM pm.tasks WHERE title = 'Daily check' AND status = 'todo'");
    if (secondCopy) {
      await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [secondCopy.id]);
      await s.q("UPDATE pm.schedules SET done_on = '2026-12-05' WHERE id = $1", [dailySet.repeat.id]);
      await api.runDueSchedules(service, new Date());
    }
    const dailies = await s.q<Loose>("SELECT due_date::text, status FROM pm.tasks WHERE title = 'Daily check' ORDER BY due_date");
    const dailyRow = await one<Loose>('SELECT status, next_run_at FROM pm.schedules WHERE id = $1', [dailySet.repeat.id]);
    check('after done: two copies completed on one day each make a next copy, on a new date, and the repeat keeps waiting', dailies.map((r) => `${r.due_date}:${r.status}`).join()
      === '2026-12-01:done,2026-12-06:done,2026-12-07:todo' && dailyRow.status === 'active' && dailyRow.next_run_at === null, { dailies, dailyRow });

    // A schedule that runs as an agent: what the API's request gate and the personal assistant switch refuse, it does too.
    const atlas = (await one<{ id: string }>("INSERT INTO pm.team_members (name, email, role, timezone) VALUES ('Atlas', 'atlas@studio.example', 'agent', 'America/New_York') RETURNING id")).id;
    for (const permission of ['tasks.create', 'tasks.read']) {
      await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'api', 'allow') ON CONFLICT DO NOTHING", [atlas, permission]);
    }
    await s.q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [s.projectId, atlas]);
    const agentRepeat = async (title: string, runner = atlas) => {
      const taskId = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority, due_date, created_by) VALUES ($1, $2, 'todo', 'low', '2026-12-07', $3) RETURNING id", [s.projectId, title, runner])).id;
      const scheduleId = (await one<{ id: string }>(`INSERT INTO pm.schedules (kind, task_id, project_id, recurrence, timezone, start_date, next_on, next_run_at, run_as, created_by)
        VALUES ('task', $1, $2, '{"freq":"daily","interval":1}', 'America/New_York', '2026-12-07', '2026-12-08', '2026-12-07T05:00:00Z', $3, $3) RETURNING id`, [taskId, s.projectId, runner])).id;
      return { taskId, scheduleId };
    };
    const outcomeOf = async (scheduleId: string) => ({
      schedule: await one<Loose>('SELECT status, paused_reason FROM pm.schedules WHERE id = $1', [scheduleId]),
      occurrence: await one<Loose>('SELECT status, reason FROM pm.schedule_occurrences WHERE schedule_id = $1 ORDER BY scheduled_for DESC LIMIT 1', [scheduleId]),
      told: await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_type = 'schedule' AND entity_id = $1", [scheduleId]),
    });
    const fine = await agentRepeat('Agent fine');
    await api.runDueSchedules(service, at('2026-12-07T05:10:00Z'));
    const fineOutcome = await outcomeOf(fine.scheduleId);
    check('agent runner: an agent that may create tasks makes its copy (the control for the pauses below)', fineOutcome.occurrence?.status === 'created' && fineOutcome.schedule.status === 'active', fineOutcome);
    await s.q('UPDATE pm.schedules SET deleted_at = now() WHERE id = $1', [fine.scheduleId]);

    const paused = await agentRepeat('Agent paused');
    await s.q('UPDATE pm.team_members SET agent_paused_at = now() WHERE id = $1', [atlas]);
    await api.runDueSchedules(service, at('2026-12-07T05:10:00Z'));
    const pausedOutcome = await outcomeOf(paused.scheduleId);
    await s.q('UPDATE pm.team_members SET agent_paused_at = NULL WHERE id = $1', [atlas]);
    check('agent runner: a paused agent makes nothing; the schedule pauses (runner_paused) and says so', pausedOutcome.occurrence?.status === 'skipped' && pausedOutcome.occurrence.reason === 'runner_paused'
      && pausedOutcome.schedule.status === 'paused' && pausedOutcome.schedule.paused_reason === 'runner_paused' && pausedOutcome.told === 1, pausedOutcome);

    const onProject = await agentRepeat('Agent paused on the project');
    await s.q("INSERT INTO pm.project_agents (project_id, agent_id, status) VALUES ($1, $2, 'paused')", [s.projectId, atlas]);
    await api.runDueSchedules(service, at('2026-12-07T05:10:00Z'));
    const projectOutcome = await outcomeOf(onProject.scheduleId);
    await s.q("UPDATE pm.project_agents SET status = 'active' WHERE agent_id = $1", [atlas]);
    const everyone = await agentRepeat('Every agent paused');
    await s.q('UPDATE pm.business_settings SET agents_paused_at = now()');
    await s.q('INSERT INTO pm.business_settings (agents_paused_at) SELECT now() WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)');
    await api.runDueSchedules(service, at('2026-12-07T05:10:00Z'));
    const everyoneOutcome = await outcomeOf(everyone.scheduleId);
    await s.q('UPDATE pm.business_settings SET agents_paused_at = NULL');
    check('agent runner: paused on the project, or every agent paused, pauses the schedule too', projectOutcome.occurrence?.reason === 'runner_paused' && projectOutcome.schedule.status === 'paused'
      && everyoneOutcome.occurrence?.reason === 'runner_paused' && everyoneOutcome.schedule.status === 'paused', { projectOutcome, everyoneOutcome });

    // Nina's personal agent, whose person turned "create tasks" off.
    const pal = (await one<{ id: string }>("INSERT INTO pm.team_members (name, email, role, timezone, delegate_of) VALUES ('Pal', 'pal@studio.example', 'agent', 'America/New_York', $1) RETURNING id", [s.nina])).id;
    for (const permission of ['tasks.create', 'tasks.read']) {
      await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'api', 'allow') ON CONFLICT DO NOTHING", [pal, permission]);
    }
    await s.q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [s.projectId, pal]);
    await s.q(`INSERT INTO pm.assistant_preferences (agent_id, switches) VALUES ($1, '{"create_tasks": false}')`, [pal]);
    const switchedOff = await agentRepeat('Assistant switched off', pal);
    await api.runDueSchedules(service, at('2026-12-07T05:10:00Z'));
    const switchOutcome = await outcomeOf(switchedOff.scheduleId);
    check('personal agent: with "create tasks" off, nothing is made; the schedule pauses (assistant_switch_off) and says so', switchOutcome.occurrence?.status === 'skipped'
      && switchOutcome.occurrence.reason === 'assistant_switch_off' && switchOutcome.schedule.paused_reason === 'assistant_switch_off' && switchOutcome.told === 1
      && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Assistant switched off'") === 1, switchOutcome);

    // Reading: someone who sees only their own tasks sees only their own tasks' repeats.
    const rita = (await one<{ id: string }>("INSERT INTO pm.team_members (name, email, role, timezone) VALUES ('Rita', 'rita@studio.example', 'member', 'America/New_York') RETURNING id")).id;
    await s.q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [s.projectId, rita]);
    await s.q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES
      ($1, 'tasks.read', 'app', 'deny'), ($1, 'tasks.read_assigned', 'app', 'allow') ON CONFLICT DO NOTHING`, [rita]);
    const ritaTask = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority, due_date) VALUES ($1, 'Rita''s rounds', 'todo', 'low', '2026-12-09') RETURNING id", [s.projectId])).id;
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [ritaTask, rita]);
    await api.setTaskRepeat(service, owner, ritaTask, { recurrence: { freq: 'weekly', interval: 1, weekdays: [3] }, mode: 'schedule' }, at('2026-12-01T15:00:00Z'));
    const ritaCaller = await callerFor(rita);
    const ritaList = await api.listSchedules(service, ritaCaller, { kind: 'task', offset: 0, limit: 100 });
    const weekly = await one<{ id: string }>("SELECT id FROM pm.schedules WHERE kind = 'task' AND id = $1", [set.repeat.id]);
    const ritaOther = await errorOf(api.getSchedule(service, ritaCaller, weekly.id));
    const ritaRepeat = await errorOf(api.getTaskRepeat(service, ritaCaller, task));
    check('read assigned: only repeats of tasks they are on are listed, and another task\'s repeat reads as missing', ritaList.rows.length === 1 && ritaList.rows[0].task_id === ritaTask
      && ritaList.rows[0].task_title === "Rita's rounds" && ritaOther?.statusCode === 404 && ritaRepeat?.statusCode === 404,
    { rows: ritaList.rows.map((r) => r.task_title), other: ritaOther?.statusCode, repeat: ritaRepeat?.statusCode });
    const createOnly = { memberId: s.nina, access: (await resolveMemberAccess(service, s.nina))!, scopes: ['tasks.create', 'projects.read'] };
    const keyList = await api.listSchedules(service, createOnly, { offset: 0, limit: 100 });
    check('read: a key that may create tasks but not read them sees no task repeats', keyList.rows.every((r) => r.kind === 'template') && keyList.rows.length > 0, keyList.rows.map((r) => r.kind));

    // ── The internal route ───────────────────────────────────────────────
    const secret = 's'.repeat(40);
    Object.assign(process.env, { WEBHOOK_SCHEDULER_ENABLED: 'true', WEBHOOK_SCHEDULER_SECRET: secret });
    const route = await import('../src/app/api/internal/schedules/run/route');
    const call = (header?: string) => route.POST(new Request('http://localhost/api/internal/schedules/run', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { authorization: header } : {}) }, body: '{"source":"pg_cron"}',
    }));
    const none = await call();
    const wrongSecret = await call(`Bearer ${'t'.repeat(40)}`);
    const right = await call(`Bearer ${secret}`);
    const rightBody = await right.json() as Loose;
    check('route: refuses without the scheduler secret or with a wrong one, runs with it', none.status === 401 && wrongSecret.status === 401 && right.status === 200
      && typeof rightBody.created === 'number', { none: none.status, wrong: wrongSecret.status, right: right.status, rightBody });

    // ── REST, session routes and MCP ─────────────────────────────────────
    const v1Schedules = await import('../src/app/api/v1/task-templates/[id]/schedules/route');
    const v1Repeat = await import('../src/app/api/v1/tasks/[id]/repeat/route');
    const v1One = await import('../src/app/api/v1/schedules/[id]/route');
    const v1History = await import('../src/app/api/v1/schedules/[id]/occurrences/route');
    const sessionList = await import('../src/app/api/workspace/schedules/route');
    const sessionRepeat = await import('../src/app/api/workspace/tasks/[id]/repeat/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
    const read = async (response: Response) => ({ status: response.status, body: await response.json().catch(() => null) as Loose });
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
        { params: Promise.resolve(params) } as never));
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name)!;
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };

    const restCreate = await v1(v1Schedules.POST, 'POST', `/api/v1/task-templates/${s.template}/schedules`, { id: s.template }, s.keys.owner,
      { project_id: s.projectId, recurrence: { freq: 'weekly', weekdays: [5] }, values: { client: 'Rest' }, roles: { owner: 'runner' } });
    const restBad = await v1(v1Schedules.POST, 'POST', `/api/v1/task-templates/${s.template}/schedules`, { id: s.template }, s.keys.owner,
      { project_id: s.projectId, recurrence: { freq: 'weekly' }, values: { client: 'Rest' } });
    const restPause = restCreate.body?.data?.id ? await v1(v1One.PATCH, 'PATCH', `/api/v1/schedules/${restCreate.body.data.id}`, { id: restCreate.body.data.id }, s.keys.owner, { status: 'paused' }) : null;
    const history = await v1(v1History.GET, 'GET', `/api/v1/schedules/${daily.id}/occurrences`, { id: daily.id }, s.keys.owner);
    check('rest: create (201), a bad recurrence is a 422, pause, and the history lists every date', restCreate.status === 201 && restCreate.body.data.recurrence_label === 'Every Friday'
      && restBad.status === 422 && restPause?.status === 200 && restPause.body.data.status === 'paused' && restPause.body.data.next_on === null
      && history.status === 200 && history.body.data.length >= 4, { restCreate: restCreate.body, restBad: restBad.status, restPause: restPause?.body, history: history.body?.data?.length });

    // Nina may repeat her own task, not someone else's.
    const ninaTask = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority, due_date) VALUES ($1, 'Nina''s check', 'todo', 'medium', '2026-12-10') RETURNING id", [s.projectId])).id;
    await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [ninaTask, s.nina]);
    const otherTask = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority) VALUES ($1, 'Not hers', 'todo', 'medium') RETURNING id", [s.projectId])).id;
    const ninaOwn = await v1(v1Repeat.PUT, 'PUT', `/api/v1/tasks/${ninaTask}/repeat`, { id: ninaTask }, s.keys.nina, { recurrence: { freq: 'monthly', month_day: 10 } });
    const ninaOther = await v1(v1Repeat.PUT, 'PUT', `/api/v1/tasks/${otherTask}/repeat`, { id: otherTask }, s.keys.nina, { recurrence: { freq: 'monthly', month_day: 10 } });
    check('rest: a member repeats a task they are on, not someone else\'s', ninaOwn.status === 200 && ninaOwn.body.data.repeat.next_on === '2027-01-10'
      && ninaOther.status === 403, { ninaOwn: ninaOwn.body, ninaOther: ninaOther.body });

    const sessionSet = await session(sessionRepeat.PUT, 'PUT', `/api/workspace/tasks/${otherTask}/repeat`, { id: otherTask }, { recurrence: { freq: 'weekly', weekdays: [3] }, mode: 'after_done' });
    const listed = await session(sessionList.GET, 'GET', '/api/workspace/schedules?kind=task');
    const cleared = await session(sessionRepeat.DELETE, 'DELETE', `/api/workspace/tasks/${otherTask}/repeat`, { id: otherTask });
    check('session: set a repeat, list repeats (with the scheduler state), stop it', sessionSet.status === 200 && sessionSet.body.data.repeat.mode === 'after_done'
      && listed.status === 200 && listed.body.data.schedules.some((r: Loose) => r.task_id === otherTask) && listed.body.data.scheduler_ready === true
      && cleared.status === 200 && cleared.body.data.removed === true
      && await count("SELECT count(*)::int AS n FROM pm.schedules WHERE task_id = $1 AND deleted_at IS NULL", [otherTask]) === 0, { sessionSet: sessionSet.body, listed: listed.status, cleared: cleared.body });

    const mcpSet = await runTool(s.keys.owner, s.owner, 'set_task_repeat', { task_id: otherTask, recurrence: { freq: 'daily', interval: 2 } });
    const mcpList = await runTool(s.keys.owner, s.owner, 'list_schedules', { kind: 'template' });
    const mcpPause = await runTool(s.keys.owner, s.owner, 'pause_schedule', { schedule_id: created.id });
    const mcpResume = await runTool(s.keys.owner, s.owner, 'resume_schedule', { schedule_id: created.id });
    const mcpCreate = await runTool(s.keys.owner, s.owner, 'create_template_schedule', { template_id: s.template, project_id: s.projectId, recurrence: { freq: 'monthly', month_week: 1, month_weekday: 1 }, values: { client: 'Mcp' }, idempotency_key: 'sched-1' });
    check('mcp: set a task repeat, list, pause, resume and create a schedule', mcpSet.ok && mcpSet.data.repeat.recurrence_label === 'Every 2 days'
      && mcpList.ok && mcpList.data.every((r: Loose) => r.kind === 'template') && mcpPause.ok && mcpPause.data.status === 'paused'
      && mcpResume.ok && mcpResume.data.status === 'active' && mcpCreate.ok && mcpCreate.data.recurrence_label === 'Every month on the first Monday',
    { mcpSet: mcpSet.error ?? mcpSet.ok, mcpList: mcpList.ok, mcpPause: mcpPause.error, mcpResume: mcpResume.error, mcpCreate: mcpCreate.error ?? mcpCreate.data });
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`schedules: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
