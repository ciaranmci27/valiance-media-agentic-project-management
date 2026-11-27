/**
 * Lifecycle fixes (20261127001400_lifecycle_fixes.sql), over the real schema
 * on PGlite, the real services and routes and the real supabase-js client
 * (a fake PostgREST):
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   the previous release's reflow call still works.
 * - Schedules: resuming on a day the schedule skipped makes that day's run,
 *   as the answer says; a day that made its run is never promised again.
 *   A schedule that pauses itself tells the people who can fix it (an
 *   agent's people, else the Owners), and the notice clears on resume. A
 *   schedule whose template is in Trash reads as paused, and resuming it
 *   says why it cannot.
 * - A suspended member is no longer asked: their open questions and
 *   approvals expire now, saying why, and whoever asked is told once.
 * - AI agents switched off: agent keys get 403 MODULE_OFF on REST and the
 *   MCP door, agent-run schedules wait unclaimed and run when it is on
 *   again, and runs do not time out meanwhile.
 * - Key edit: taking a beyond-role scope off an agent's last key carrying
 *   it takes the power away; another key carrying it keeps it.
 * - Races, fired together: reorders keep unique positions, adding the same
 *   people to a group never fails, replacing assignees leaves one list (and
 *   pm.save_task serializes per task), a refused repeat changes nothing.
 * - Change dates: refused while the initiative is in Trash; the initiative's
 *   start and target follow the key dates.
 * - Data retention keeps a run tree while any run in it is recent.
 * - Schedule dates are bounded to 2000 to 2099.
 *
 *   npm run -s test:lifecycle-fixes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { scheduleUpdateSchema, taskRepeatSchema, templateScheduleSchema, upcomingDates, recurrenceSchema } from '../src/lib/schedules';

const MIGRATION = '20261127001400_lifecycle_fixes.sql';
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- LIFECYCLE FIXES (20261127001400_lifecycle_fixes.sql)\n-- ============================================================\n';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LOGIN = { id: id(9101), email: 'olivia@studio.example' };

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n-- ', at + BANNER.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && SCHEMA_SQL.slice(at + BANNER.length, next < 0 ? undefined : next) === MIGRATION_SQL);
  check('migration: no em or en dash', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  const later = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f > MIGRATION);
  check('migration: every later migration has its own section after this one', later.every((f) => SCHEMA_SQL.indexOf(`(${f})`, at + BANNER.length) > 0), later);
  const fresh = await createFullSchemaDatabase();
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;
  // PGlite runs one statement at a time, so two saves can never interleave
  // here: the lock that keeps them apart on Postgres is checked by its source.
  const saveTask = (await q<{ def: string }>("SELECT pg_get_functiondef('pm.save_task(uuid, jsonb, uuid[], text[], uuid[])'::regprocedure) AS def"))[0].def;
  check('save_task: takes a per-task lock before it writes, so two replaces at once leave one list', /pg_advisory_xact_lock\(hashtext\('pm\.save_task'\), hashtext\(v_task_id::text\)\)/.test(saveTask)
    && saveTask.indexOf('pg_advisory_xact_lock') < saveTask.indexOf('DELETE FROM pm.task_assignees'));
  if (at < 0) {
    await fresh.close();
    return;
  }

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await old.exec('RESET ROLE');
  await applyMigrationsFrom(old, MIGRATION);
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql (fresh equals upgraded)', diff.length === 0, diff.slice(0, 10));
  await old.close();

  const grants = (await q<Loose>(`SELECT has_function_privilege('authenticated', 'pm.move_task_to_position(uuid, integer)', 'EXECUTE') AS move,
    has_function_privilege('anon', 'pm.move_task_to_position(uuid, integer)', 'EXECUTE') AS move_anon,
    has_function_privilege('authenticated', 'pm.close_asks_of_suspended_member()', 'EXECUTE') AS close,
    has_function_privilege('authenticated', 'pm.save_task(uuid, jsonb, uuid[], text[], uuid[])', 'EXECUTE') AS save`))[0];
  check('grants: the reorder function is server only; save_task stays callable by members', !grants.move && !grants.move_anon && !grants.close && grants.save, grants);

  // The previous release's reflow call (p_initiative { id, from, to }) still moves the target.
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Old call') RETURNING id"))[0].id;
  const template = (await q<{ id: string }>(`INSERT INTO pm.task_templates (name, fields, key_dates, roles, items) VALUES ('T', '[]', '[{"key":"start","label":"Start"}]', '[]', '[{"key":"a","title":"A"}]') RETURNING id`))[0].id;
  const initiative = (await q<{ id: string }>("INSERT INTO pm.initiatives (project_id, name, status, start_date, target_date) VALUES ($1, 'I', 'active', '2027-01-04', '2027-01-04') RETURNING id", [project]))[0].id;
  const run = (await q<{ id: string }>(`INSERT INTO pm.task_template_runs (template_id, template_version, snapshot, project_id, via, key_dates, initiative_id, task_ids, start_date)
    VALUES ($1, 1, '{}', $2, 'api', '{"start":"2027-01-04"}', $3, '{}', '2027-01-04') RETURNING id`, [template, project, initiative]))[0].id;
  const answer = (await q<{ r: Loose }>(`SELECT pm.reflow_task_template_run($1, '{"start":"2027-01-04"}', '{"start":"2027-01-11"}', '2027-01-11', '[]', $2) AS r`,
    [run, JSON.stringify({ id: initiative, from: '2027-01-04', to: '2027-01-11' })]))[0].r;
  const moved = (await q<Loose>('SELECT start_date::text, target_date::text FROM pm.initiatives WHERE id = $1', [initiative]))[0];
  check('compatibility: the previous release\'s reflow call moves the target and leaves the start', answer.initiative_moved === true && moved.target_date === '2027-01-11' && moved.start_date === '2027-01-04', { answer, moved });
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
      [name, login?.email ?? `${name.toLowerCase().replace(/\s+/g, '.')}@studio.example`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, memberId]);
    }
    return memberId;
  };
  const owner = await member('Olivia', 'owner', LOGIN);
  const morgan = await member('Morgan', 'member');
  const sam = await member('Sam', 'member');
  const temp = await member('Temp Person', 'member');
  const atlas = await member('Atlas', 'agent');
  const lens = await member('Lens', 'agent');
  const projectId = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('State Lab') RETURNING id"))[0].id;
  for (const m of [morgan, sam, temp, atlas, lens]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [projectId, m]);
  // Morgan owns Atlas; Lens has nobody, so the Owners hear about it.
  await q('INSERT INTO pm.agent_owners (agent_id, member_id, created_by) VALUES ($1, $2, $3)', [atlas, morgan, owner]);
  for (const permission of ['tasks.create', 'tasks.read']) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'api', 'allow') ON CONFLICT DO NOTHING", [atlas, permission]);
  }
  const key = async (memberId: string, scopes: string[], name = 'Seed key') => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    const keyId = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ($1, 'pk_live', $2, $3, $3, $4, 'scoped') RETURNING id`, [name, createHash('sha256').update(secret).digest('hex'), memberId, scopes]))[0].id;
    return { secret, id: keyId };
  };
  const keys = {
    owner: await key(owner, ['templates.manage', 'tasks.create', 'tasks.read', 'tasks.manage_all', 'projects.read', 'projects.read_all', 'team.read']),
    atlas: await key(atlas, ['tasks.create', 'tasks.read', 'projects.read']),
  };
  const template = (await q<{ id: string }>(`INSERT INTO pm.task_templates (name, fields, key_dates, roles, items, created_by) VALUES (
    'Daily check', '[]', '[{"key":"start","label":"Kickoff"},{"key":"golive","label":"Go-live","main":true}]', '[]',
    '[{"key":"prep","title":"Prep","due_in_days":0},{"key":"ship","title":"Ship","anchor":"golive","due_in_days":0}]', $1) RETURNING id`, [owner]))[0].id;
  return { q, owner, morgan, sam, temp, atlas, lens, projectId, keys, key, template };
}

async function main() {
  // ── Pure: schedule dates are bounded ───────────────────────────────────
  const daily = recurrenceSchema.parse({ freq: 'daily' });
  const farStart = templateScheduleSchema.safeParse({ recurrence: { freq: 'daily' }, start_date: '9999-12-31' });
  const farEnd = scheduleUpdateSchema.safeParse({ end_date: '2150-01-01' });
  const oldStart = templateScheduleSchema.safeParse({ recurrence: { freq: 'daily' }, start_date: '1999-12-31' });
  const fine = templateScheduleSchema.safeParse({ recurrence: { freq: 'daily' }, start_date: '2099-12-30', end_date: '2099-12-31' });
  const repeatEnd = taskRepeatSchema.safeParse({ recurrence: { freq: 'daily' }, end_date: '3000-01-01' });
  check('dates: a schedule takes start and end dates from 2000 to 2099 only, everywhere', !farStart.success && !farEnd.success && !oldStart.success && fine.success && !repeatEnd.success,
    { farStart: farStart.success, farEnd: farEnd.success, oldStart: oldStart.success, fine: fine.success, repeatEnd: repeatEnd.success });
  check('dates: the upcoming list stops at the last date it takes, never repeating one', upcomingDates(daily, '2099-12-30', '2099-12-30', 5).join() === '2099-12-30,2099-12-31',
    upcomingDates(daily, '2099-12-30', '2099-12-30', 5));

  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  // Olivia signed in, for the session routes (Team > Roles & permissions).
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
    const one = async <T = Loose>(sql: string, params: unknown[] = []) => (await s.q<T>(sql, params))[0];
    const count = async (sql: string, params: unknown[] = []) => (await one<{ n: number }>(sql, params)).n;
    const at = (iso: string) => new Date(iso);
    const errorOf = (promise: Promise<unknown>) => promise.then(() => null, (error: Loose) => error);
    const owner = await callerFor(s.owner);
    const read = async (response: Response) => ({ status: response.status, body: await response.json().catch(() => null) as Loose });
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, apiKey: string, body?: unknown, params: Record<string, string> = {}) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const bells = (entityId: string) => s.q<Loose>("SELECT user_id, title, cleared_at FROM pm.team_member_notifications WHERE entity_id = $1 ORDER BY user_id", [entityId]);

    // ── 1 and 2: a schedule run by an agent pauses itself, is resumed the same day ──
    const scheduleRow = async (runner: string, start: string, extra: Record<string, unknown> = {}) => (await one<{ id: string }>(`INSERT INTO pm.schedules
      (kind, template_id, project_id, recurrence, timezone, start_date, next_on, next_run_at, run_as, created_by, skip_if_open, create_initiative, key_date_offsets)
      VALUES ('template', $1, $2, '{"freq":"daily","interval":1}', 'America/New_York', $3, $3, $4, $5, $5, false, $6, '{}') RETURNING id`,
    [s.template, s.projectId, start, `${start}T05:00:00Z`, runner, extra.create_initiative === true])).id;
    const atlasSchedule = await scheduleRow(s.atlas, '2026-12-01');
    await s.q('UPDATE pm.team_members SET agent_paused_at = now() WHERE id = $1', [s.atlas]);
    await api.runDueSchedules(service, at('2026-12-01T15:00:00Z'));
    const autoPaused = await one<Loose>('SELECT status, paused_reason, next_on::text FROM pm.schedules WHERE id = $1', [atlasSchedule]);
    const toldPaused = await bells(atlasSchedule);
    check('pause notice: an agent-run schedule that pauses itself tells the agent\'s people (Morgan, its owner), not the paused agent', autoPaused.status === 'paused'
      && autoPaused.paused_reason === 'runner_paused' && toldPaused.length === 1 && toldPaused[0].user_id === s.morgan && toldPaused[0].cleared_at === null, { autoPaused, toldPaused });

    await s.q('UPDATE pm.team_members SET agent_paused_at = NULL WHERE id = $1', [s.atlas]);
    const resumed = await api.updateSchedule(service, owner, atlasSchedule, { status: 'active' }, at('2026-12-01T16:00:00Z'));
    const resumedBells = await bells(atlasSchedule);
    check('pause notice: clears when the schedule is resumed', resumedBells.length === 1 && resumedBells[0].cleared_at !== null, resumedBells);
    const summary = await api.runDueSchedules(service, at('2026-12-01T16:05:00Z'));
    const todays = await one<Loose>("SELECT status, reason FROM pm.schedule_occurrences WHERE schedule_id = $1 AND scheduled_for = '2026-12-01'", [atlasSchedule]);
    const runs = await count('SELECT count(*)::int AS n FROM pm.task_template_runs WHERE schedule_id = $1', [atlasSchedule]);
    check('resume: on a day it skipped, the answer promises today and today\'s run is made', resumed.next_on === '2026-12-01' && resumed.upcoming[0] === '2026-12-01'
      && summary.created === 1 && todays?.status === 'created' && runs === 1, { resumed: resumed.next_on, upcoming: resumed.upcoming, summary, todays, runs });

    // Paused by hand after today's run, resumed the same day: the answer says tomorrow, and tomorrow it runs.
    await api.updateSchedule(service, owner, atlasSchedule, { status: 'paused' }, at('2026-12-01T17:00:00Z'));
    const again = await api.updateSchedule(service, owner, atlasSchedule, { status: 'active' }, at('2026-12-01T17:05:00Z'));
    const noDouble = await api.runDueSchedules(service, at('2026-12-01T17:10:00Z'));
    check('resume: on a day that already made its run, the answer names tomorrow and nothing is made twice', again.next_on === '2026-12-02' && again.upcoming[0] === '2026-12-02'
      && noDouble.created === 0 && await count('SELECT count(*)::int AS n FROM pm.task_template_runs WHERE schedule_id = $1', [atlasSchedule]) === 1, { again: again.next_on, noDouble });

    // Lens has no owner: the Owners hear. A person who ran it and was suspended: the Owners too.
    const lensSchedule = await scheduleRow(s.lens, '2026-12-03');
    await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'tasks.create', 'api', 'allow'), ($1, 'tasks.read', 'api', 'allow') ON CONFLICT DO NOTHING", [s.lens]);
    await s.q('UPDATE pm.team_members SET agent_paused_at = now() WHERE id = $1', [s.lens]);
    const samSchedule = await scheduleRow(s.sam, '2026-12-03');
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.sam]);
    await api.runDueSchedules(service, at('2026-12-03T15:00:00Z'));
    await api.runDueSchedules(service, at('2026-12-03T15:06:00Z'));
    const lensBells = await bells(lensSchedule);
    const samBells = await bells(samSchedule);
    check('pause notice: an agent with nobody named tells the Owners; a suspended runner\'s schedule tells the Owners, never the suspended person',
      lensBells.map((b) => b.user_id).join() === s.owner && samBells.length > 0 && samBells.every((b) => b.user_id === s.owner), { lensBells, samBells });
    await s.q("UPDATE pm.team_members SET status = 'active', agent_paused_at = NULL WHERE id IN ($1, $2)", [s.sam, s.lens]);

    // A template in Trash: the schedule reads as paused now, and resuming says why it cannot.
    const trashSchedule = await api.createTemplateSchedule(service, owner, s.template, {
      project_id: s.projectId, recurrence: { freq: 'weekly', interval: 1, weekdays: [1] }, start_date: '2026-12-07', roles: {}, values: {}, key_date_offsets: {}, create_initiative: false, skip_if_open: false,
    }, at('2026-12-01T15:00:00Z'));
    const activeBefore = (await api.listSchedules(service, owner, { status: 'active', offset: 0, limit: 100 })).rows.map((r) => r.id);
    await s.q('UPDATE pm.task_templates SET deleted_at = now() WHERE id = $1', [s.template]);
    const inTrash = await api.getSchedule(service, owner, trashSchedule.id);
    const activeList = await api.listSchedules(service, owner, { status: 'active', offset: 0, limit: 100 });
    const pausedList = await api.listSchedules(service, owner, { status: 'paused', offset: 0, limit: 100 });
    const pagedPaused = await api.listSchedules(service, owner, { status: 'paused', offset: 0, limit: 1 });
    check('template in Trash: ?status= filters by what a schedule reads, with matching totals (paused includes them, active leaves them out)',
      activeBefore.includes(trashSchedule.id) && activeBefore.every((sid) => pausedList.rows.some((r) => r.id === sid) && !activeList.rows.some((r) => r.id === sid))
      && pausedList.rows.every((r) => r.status === 'paused') && activeList.rows.every((r) => r.status === 'active')
      && pausedList.total === pausedList.rows.length && activeList.total === activeList.rows.length && pagedPaused.total === pausedList.total,
    { activeBefore, active: activeList.rows.map((r) => [r.id, r.status]), activeTotal: activeList.total, paused: pausedList.rows.map((r) => [r.id, r.status]), pausedTotal: pausedList.total, paged: pagedPaused.total });
    await api.updateSchedule(service, owner, trashSchedule.id, { status: 'paused' });
    const resumeInTrash = await errorOf(api.updateSchedule(service, owner, trashSchedule.id, { status: 'active' }));
    await s.q('UPDATE pm.task_templates SET deleted_at = NULL WHERE id = $1', [s.template]);
    check('template in Trash: the schedule reads as paused (the template is in Trash) with no dates, and is not listed as active', inTrash.status === 'paused'
      && inTrash.paused_reason === 'template_gone' && inTrash.next_on === null && inTrash.upcoming.length === 0
      && !activeList.rows.some((r) => r.id === trashSchedule.id), { inTrash: { status: inTrash.status, reason: inTrash.paused_reason, next: inTrash.next_on, upcoming: inTrash.upcoming } });
    check('template in Trash: resuming says so plainly (409 template_in_trash)', resumeInTrash?.statusCode === 409 && resumeInTrash.details?.reason === 'template_in_trash'
      && /Trash/.test(resumeInTrash.message), { status: resumeInTrash?.statusCode, details: resumeInTrash?.details, message: resumeInTrash?.message });

    // ── 3: a suspended member is no longer asked ─────────────────────────
    await s.q(`INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Harness', 'https://harness.example.test/hook', 'whsec_h', ARRAY['question.expired'])`);
    const run = (await one<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title) VALUES ($1, 'Asking') RETURNING id", [s.atlas])).id;
    const question = (await one<{ id: string }>("INSERT INTO pm.questions (project_id, asked_by, asked_to, question, run_id) VALUES ($1, $2, $3, 'Ship it?', $4) RETURNING id", [s.projectId, s.atlas, s.temp, run])).id;
    const approval = (await one<{ id: string }>(`INSERT INTO pm.questions (project_id, asked_by, asked_to, question, kind, action, choices, allow_other)
      VALUES ($1, $2, $3, 'Approve the merge?', 'approval', '{"type":"merge","summary":"Merge PR 7"}', '["approve","reject"]', false) RETURNING id`, [s.projectId, s.atlas, s.temp])).id;
    const runWaiting = (await one<Loose>('SELECT status FROM pm.agent_runs WHERE id = $1', [run])).status;
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.temp]);
    const closed = await s.q<Loose>("SELECT q.id, q.status, to_jsonb(q) ->> 'expired_reason' AS expired_reason, q.expires_at FROM pm.questions q WHERE q.id IN ($1, $2)", [question, approval]);
    const askerBells = await s.q<Loose>("SELECT user_id, title FROM pm.team_member_notifications WHERE entity_type = 'question' AND entity_id IN ($1, $2) AND user_id <> $3", [question, approval, s.temp]);
    const tempBells = await s.q<Loose>("SELECT cleared_at FROM pm.team_member_notifications WHERE entity_type = 'question' AND entity_id IN ($1, $2) AND user_id = $3", [question, approval, s.temp]);
    const runAfter = (await one<Loose>('SELECT status FROM pm.agent_runs WHERE id = $1', [run])).status;
    const expiredEvents = await s.q<Loose>("SELECT payload FROM pm.webhook_events WHERE event_type = 'question.expired'");
    check('suspended: their open question and approval expire now, saying why', closed.length === 2
      && closed.every((r) => r.status === 'expired' && r.expired_reason === 'asked_member_suspended' && r.expires_at !== null), closed);
    check('suspended: whoever asked hears once (Atlas\'s owner Morgan), the asked bells clear, the held run runs again', askerBells.length === 2
      && askerBells.every((b) => b.user_id === s.morgan && /expired without .*: Temp Person was suspended/.test(b.title)) && tempBells.every((b) => b.cleared_at !== null)
      && runWaiting === 'waiting' && runAfter === 'running', { askerBells, tempBells, runWaiting, runAfter });
    check('suspended: question.expired tells the asking agent why (expired_reason)', expiredEvents.length === 2
      && expiredEvents.every((e) => e.payload.data.question.expired_reason === 'asked_member_suspended'), expiredEvents.map((e) => e.payload.data.question));
    const watchdog = (await one<{ r: Loose }>('SELECT pm.run_watchdog() AS r')).r;
    check('suspended: the watchdog does not tell them a second time', watchdog.askers_told === 0
      && await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_type = 'question' AND entity_id IN ($1, $2) AND user_id = $3", [question, approval, s.morgan]) === 2, watchdog);
    const { listQuestions, getQuestion, answerQuestion } = await import('../src/lib/api/questions');
    const ctx = { db: service, memberId: s.owner, access: owner.access, channel: 'app' } as Loose;
    const view = await getQuestion(ctx, question).catch((e: Loose) => e);
    const answerLate = await errorOf(answerQuestion(ctx, question, { text: 'yes' } as Loose));
    check('suspended: the question reads expired_reason, and answering it says plainly why it closed', view?.expired_reason === 'asked_member_suspended'
      && answerLate?.statusCode === 409 && /suspended/.test(answerLate.message) && answerLate.details?.expired_reason === 'asked_member_suspended',
    { view: view?.expired_reason ?? view?.message, answer: answerLate?.message });
    void listQuestions;
    await s.q("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [s.temp]);

    // ── 4: AI agents switched off ────────────────────────────────────────
    const contextRoute = await import('../src/app/api/v1/agents/me/context/route');
    const tasksRoute = await import('../src/app/api/v1/tasks/route');
    const mcpRoute = await import('../src/app/api/mcp/route');
    const atlasDaily = await scheduleRow(s.atlas, '2026-12-10');
    await s.q("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'agents'");
    const offContext = await v1(contextRoute.GET, 'GET', '/api/v1/agents/me/context', s.keys.atlas.secret);
    const offCreate = await v1(tasksRoute.POST, 'POST', '/api/v1/tasks', s.keys.atlas.secret, { project_id: s.projectId, title: 'Made while agents are off' });
    const personRead = await v1(tasksRoute.GET, 'GET', `/api/v1/tasks?project_id=${s.projectId}`, s.keys.owner.secret);
    const offMcp = await mcpRoute.POST(new NextRequest('http://localhost/api/mcp', {
      method: 'POST', headers: { 'x-api-key': s.keys.atlas.secret, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const offMcpBody = await offMcp.json().catch(() => null) as Loose;
    check('agents off: an agent key gets 403 MODULE_OFF on REST reads and writes and on the MCP server; a person\'s key still works',
      offContext.status === 403 && offContext.body?.error?.code === 'MODULE_OFF' && offCreate.status === 403 && offCreate.body?.error?.code === 'MODULE_OFF'
      && offMcp.status === 403 && JSON.stringify(offMcpBody).includes('agents') && personRead.status === 200
      && await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Made while agents are off'") === 0,
    { offContext: offContext.body, offCreate: offCreate.status, offMcp: offMcp.status, offMcpBody, personRead: personRead.status });
    // No run_as: whoever set it up runs it. A person's still runs; an agent's waits too.
    const noRunner = async (creator: string) => {
      const sid = await scheduleRow(creator, '2026-12-10');
      await s.q('UPDATE pm.schedules SET run_as = NULL WHERE id = $1', [sid]);
      return sid;
    };
    const personNoRunner = await noRunner(s.owner);
    const agentNoRunner = await noRunner(s.atlas);
    const offRun = await api.runDueSchedules(service, at('2026-12-10T15:00:00Z'));
    const heldRow = await one<Loose>('SELECT status, next_on::text FROM pm.schedules WHERE id = $1', [atlasDaily]);
    const personMade = await count("SELECT count(*)::int AS n FROM pm.schedule_occurrences WHERE schedule_id = $1 AND status = 'created'", [personNoRunner]);
    const agentMade = await count('SELECT count(*)::int AS n FROM pm.schedule_occurrences WHERE schedule_id = $1', [agentNoRunner]);
    check('agents off: a schedule with no run_as still runs when a person set it up, and waits when an agent did', personMade === 1 && agentMade === 0 && offRun.created === 1,
      { personMade, agentMade, offRun });
    await s.q("UPDATE pm.schedules SET status = 'paused' WHERE id IN ($1, $2)", [personNoRunner, agentNoRunner]);
    await s.q("INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES ('pm_webhook_scheduler_url', 'https://pm.example.com'), ('pm_webhook_scheduler_secret', 'x') ON CONFLICT DO NOTHING").catch(() => undefined);
    await s.q("UPDATE pm.schedules SET status = 'paused' WHERE id <> $1 AND status = 'active'", [atlasDaily]);
    await s.q("UPDATE pm.schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [atlasDaily]);
    const kickOff = (await one<{ k: string | null }>('SELECT pm.schedules_kick()::text AS k')).k;
    check('agents off: an agent-run schedule makes nothing and claims nothing, and the kick does not fire for it', offRun.created === 1 && offRun.due === 1
      && await count('SELECT count(*)::int AS n FROM pm.schedule_occurrences WHERE schedule_id = $1', [atlasDaily]) === 0 && heldRow.status === 'active' && kickOff === null,
    { offRun, heldRow, kickOff });
    const staleRun = (await one<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, started_at, updated_at) VALUES ($1, 'Quiet', now() - interval '4 hours', now() - interval '3 hours') RETURNING id", [s.atlas])).id;
    const offWatch = (await one<{ r: Loose }>('SELECT pm.run_watchdog() AS r')).r;
    const staleOff = (await one<Loose>('SELECT status FROM pm.agent_runs WHERE id = $1', [staleRun])).status;
    await s.q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'agents'");
    await s.q("UPDATE pm.schedules SET next_run_at = '2026-12-10T05:00:00Z' WHERE id = $1", [atlasDaily]);
    const onRun = await api.runDueSchedules(service, at('2026-12-12T15:00:00Z'));
    const caughtUp = await s.q<Loose>("SELECT scheduled_for::text, status FROM pm.schedule_occurrences WHERE schedule_id = $1", [atlasDaily]);
    const onWatch = (await one<{ r: Loose }>('SELECT pm.run_watchdog() AS r')).r;
    const onContext = await v1(contextRoute.GET, 'GET', '/api/v1/agents/me/context', s.keys.atlas.secret);
    check('agents off: runs do not time out while it is off', offWatch.runs_timed_out === 0 && staleOff === 'running', { offWatch, staleOff });
    check('agents on again: the key works, the schedule runs its latest date once, and stale runs time out', onContext.status === 200 && onRun.created === 1
      && caughtUp.length === 1 && caughtUp[0].scheduled_for === '2026-12-12' && caughtUp[0].status === 'created' && onWatch.runs_timed_out >= 1,
    { onContext: onContext.status, onRun, caughtUp, onWatch });

    // ── 5: a power beyond the agent's role lives on its keys ─────────────
    const { editApiKey, editApiKeyOverApi } = await import('../src/lib/api/key-edit');
    const roleHas = await count("SELECT count(*)::int AS n FROM pm.role_permissions WHERE role = 'agent' AND access_channel = 'api' AND permission_key = 'team.read'");
    const lensKey = await s.key(s.lens, ['tasks.read'], 'Lens key');
    const editor = { memberId: s.owner, access: owner.access };
    const grant = async () => count("SELECT count(*)::int AS n FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'team.read' AND access_channel = 'api' AND effect = 'allow'", [s.lens]);
    const given = await editApiKey(service, editor, lensKey.id, { scopes: ['tasks.read', 'team.read'] });
    const afterGive = await grant();
    const taken = await editApiKey(service, editor, lensKey.id, { scopes: ['tasks.read'] });
    const afterTake = await grant();
    const audit = await one<Loose>("SELECT request_body FROM pm.api_audit_log WHERE entity_id = $1 AND method = 'PATCH' ORDER BY timestamp DESC LIMIT 1", [lensKey.id]);
    check('key edit: taking a beyond-role scope off the agent\'s only key carrying it takes the power away, said in the answer and the audit row', roleHas === 0
      && given.status === 200 && afterGive === 1 && taken.status === 200 && afterTake === 0
      && JSON.stringify((taken.body as Loose).scopes_revoked) === '["team.read"]' && JSON.stringify(audit?.request_body?.scopes_revoked) === '["team.read"]',
    { roleHas, given: given.status, afterGive, taken: taken.body, afterTake, audit: audit?.request_body });
    // Two keys carry it: taking it off one keeps the power for the other.
    await editApiKey(service, editor, lensKey.id, { scopes: ['tasks.read', 'team.read'] });
    const second = await s.key(s.lens, ['tasks.read', 'team.read'], 'Lens second');
    await editApiKey(service, editor, lensKey.id, { scopes: ['tasks.read'] });
    const keptForOther = await grant();
    // Over the API too: the last key carrying it loses it, and so does the agent.
    const apiCaller = { memberId: s.owner, access: owner.access, scopes: ['api_keys.manage_all', 'team.read', 'tasks.read'], apiKeyId: s.keys.owner.id, via: 'rest' as const };
    await editApiKeyOverApi(service, apiCaller, second.id, { scopes: ['tasks.read'] });
    const afterApi = await grant();
    check('key edit: another live key carrying it keeps the power; taking it off that last key over the API takes it away', keptForOther === 1 && afterApi === 0, { keptForOther, afterApi });
    // An allow an Owner set in Team > Roles & permissions is theirs: a key edit never takes it.
    await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'team.read', 'api', 'allow')", [s.lens]);
    await editApiKey(service, editor, lensKey.id, { scopes: ['tasks.read', 'team.read'] });
    const ownersKept = await editApiKey(service, editor, lensKey.id, { scopes: ['tasks.read'] });
    check('key edit: an allow an Owner set by hand stays when the scope comes off the key', ownersKept.status === 200 && (ownersKept.body as Loose).scopes_revoked === undefined
      && await grant() === 1, ownersKept.body);
    // A key gives it, then the Owner sets Deny and Allow in Team > Roles & permissions: it is the Owner's now.
    const accessRoute = await import('../src/app/api/workspace/access/route');
    const setAccess = async (effect: 'allow' | 'deny') => (await accessRoute.PUT(new Request('http://localhost/api/workspace/access', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'member', member_id: s.lens, permission_key: 'projects.read_all', access_channel: 'api', effect }),
    }))).status;
    const ownerGrant = async () => count("SELECT count(*)::int AS n FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'projects.read_all' AND access_channel = 'api' AND effect = 'allow'", [s.lens]);
    const ownersKey = await s.key(s.lens, ['tasks.read'], 'Lens third');
    const keyGave = await editApiKey(service, editor, ownersKey.id, { scopes: ['tasks.read', 'projects.read_all'] });
    const denied = await setAccess('deny');
    const allowed = await setAccess('allow');
    const keyTook = await editApiKey(service, editor, ownersKey.id, { scopes: ['tasks.read'] });
    check('key edit: a power a key gave, then set Deny and Allow by an Owner, is the Owner\'s: taking it off the key leaves the allow', JSON.stringify((keyGave.body as Loose).scopes_given) === '["projects.read_all"]'
      && denied === 200 && allowed === 200 && keyTook.status === 200 && (keyTook.body as Loose).scopes_revoked === undefined && await ownerGrant() === 1,
    { keyGave: keyGave.body, denied, allowed, keyTook: keyTook.body, grant: await ownerGrant() });
    // A failed edit puts back a deny it replaced as the Owner's own (not a key's grant).
    await s.q("UPDATE pm.team_member_permissions SET effect = 'deny' WHERE member_id = $1 AND permission_key = 'projects.read_all' AND access_channel = 'api'", [s.lens]);
    const { addAgentScopeGrants, removeAgentScopeGrants } = await import('../src/lib/api/agent-scope-grants');
    const undone = await addAgentScopeGrants(service, s.lens, ['projects.read_all'], s.owner);
    await removeAgentScopeGrants(service, s.lens, undone);
    const restored = await one<Loose>("SELECT effect, given_with_key FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'projects.read_all' AND access_channel = 'api'", [s.lens]);
    check('key edit: undoing a grant over a deny puts the deny back unmarked', undone.wasDenied.join() === 'projects.read_all' && restored?.effect === 'deny' && restored.given_with_key === false, { undone, restored });

    // ── 6: races ─────────────────────────────────────────────────────────
    // What PGlite can show: it runs one statement at a time, so separate
    // requests interleave (the 2.0.49 reorder, group add and repeat races fail
    // here) but statements inside one function never do. The locks inside
    // pm.move_task_to_position and pm.save_task are checked by their source.
    const moveDef = (await one<{ def: string }>("SELECT pg_get_functiondef('pm.move_task_to_position(uuid, integer)'::regprocedure) AS def")).def;
    check('reorder: the move takes a per-sibling-list lock, then reads the task again before it renumbers', /pg_advisory_xact_lock\(hashtext\('pm\.task_order'\)/.test(moveDef)
      && moveDef.indexOf('pg_advisory_xact_lock') < moveDef.lastIndexOf('SELECT * INTO v_task') && moveDef.indexOf('pg_advisory_xact_lock') < moveDef.indexOf('UPDATE pm.tasks'));
    const reorderRoute = await import('../src/app/api/v1/tasks/reorder/route');
    const parent = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority) VALUES ($1, 'Race parent', 'todo', 'medium') RETURNING id", [s.projectId])).id;
    const subs: string[] = [];
    for (let i = 0; i < 6; i++) subs.push((await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority, parent_task_id, sort_order) VALUES ($1, $2, 'todo', 'medium', $3, $4) RETURNING id", [s.projectId, `Sub ${i}`, parent, i])).id);
    let duplicateRounds = 0;
    for (let round = 0; round < 3; round++) {
      const answers = await Promise.all(subs.map((taskId, i) => v1(reorderRoute.POST, 'POST', '/api/v1/tasks/reorder', s.keys.owner.secret, { task_id: taskId, new_sort_order: (i * 5 + round * 2) % 6 })));
      const orders = (await s.q<{ sort_order: number }>('SELECT sort_order FROM pm.tasks WHERE parent_task_id = $1 ORDER BY sort_order', [parent])).map((r) => r.sort_order);
      if (orders.join() !== '0,1,2,3,4,5' || answers.some((a) => a.status !== 200)) duplicateRounds++;
    }
    check('race (requests interleaved): six reorders at once, three rounds, leave positions 0 to 5, each once', duplicateRounds === 0, duplicateRounds);

    const { addGroupMembers } = await import('../src/lib/api/groups');
    const group = (await one<{ id: string }>("INSERT INTO pm.groups (name, slug, created_by) VALUES ('Race group', 'race-group', $1) RETURNING id", [s.owner])).id;
    const adds = await Promise.all(Array.from({ length: 6 }, () => addGroupMembers(service, owner as Loose, group, { member_ids: [s.morgan, s.sam], role: 'member' } as Loose)
      .then((r) => ({ ok: true as const, added: r.added }), (e: Loose) => ({ ok: false as const, error: e?.message ?? String(e) }))));
    const addedTotal = adds.flatMap((a) => (a.ok ? a.added : []));
    check('race (requests interleaved): adding the same people to a group six times at once never fails, and each is added once', adds.every((a) => a.ok)
      && addedTotal.length === 2 && await count('SELECT count(*)::int AS n FROM pm.group_members WHERE group_id = $1', [group]) === 2, adds);

    const { patchTask } = await import('../src/lib/supabase/queries');
    const contested = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority) VALUES ($1, 'Contested', 'todo', 'medium') RETURNING id", [s.projectId])).id;
    let bothAssigned = 0;
    for (let round = 0; round < 8; round++) {
      await Promise.all([patchTask(service, contested, {}, [s.morgan]), patchTask(service, contested, {}, [s.atlas])]);
      const people = (await s.q<{ member_id: string }>('SELECT member_id FROM pm.task_assignees WHERE task_id = $1', [contested])).map((r) => r.member_id);
      if (people.length !== 1) bothAssigned++;
    }
    // Serial on PGlite: passes with or without the lock (the save_task source check above guards the lock).
    check('serial: two "replace assignees" sent together leave one list', bothAssigned === 0, bothAssigned);

    // ── 7: a refused repeat changes nothing ──────────────────────────────
    // Three repeats at once on a task with no due date, each with its own first date (Mon 11-30, Wed 12-02, Fri 11-27), four rounds.
    const raceRounds: Loose[] = [];
    for (let round = 0; round < 4; round++) {
      const repeatTask = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority, created_by) VALUES ($1, $2, 'todo', 'medium', $3) RETURNING id", [s.projectId, `Repeat race ${round}`, s.owner])).id;
      const rules = [{ freq: 'weekly', interval: 1, weekdays: [1] }, { freq: 'weekly', interval: 1, weekdays: [3] }, { freq: 'weekly', interval: 1, weekdays: [5] }];
      if (round % 2) rules.reverse();
      const sets = await Promise.all(rules.map((recurrence) => api.setTaskRepeat(service, owner, repeatTask, { recurrence, mode: 'schedule' } as Loose, at('2026-11-26T15:00:00Z'))
        .then((r) => ({ ok: true as const, due: r.due_date }), (e: Loose) => ({ ok: false as const, status: e?.statusCode }))));
      const dueNow = (await one<Loose>('SELECT due_date FROM pm.tasks WHERE id = $1', [repeatTask])).due_date;
      const series = await one<Loose>('SELECT start_date::text FROM pm.schedules WHERE task_id = $1 AND deleted_at IS NULL', [repeatTask]);
      const won = sets.filter((r) => r.ok);
      raceRounds.push({ ok: won.length === 1 && sets.filter((r) => !r.ok && r.status === 409).length === 2 && dueNow === (won[0] as Loose)?.due && series?.start_date === dueNow, sets, dueNow, series });
    }
    check('repeat race: one wins, the others are refused (409) and change nothing: the task is due on the winner\'s date', raceRounds.every((r) => r.ok), raceRounds.filter((r) => !r.ok));
    const farTask = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, priority, due_date) VALUES ($1, 'Far', 'todo', 'medium', '9999-12-31') RETURNING id", [s.projectId])).id;
    const farRepeat = await errorOf(api.setTaskRepeat(service, owner, farTask, { recurrence: { freq: 'daily', interval: 1 }, mode: 'schedule' } as Loose));
    check('dates: a task due in 9999 cannot repeat (422), and no repeat is saved', farRepeat?.statusCode === 422
      && await count('SELECT count(*)::int AS n FROM pm.schedules WHERE task_id = $1', [farTask]) === 0, farRepeat?.details);

    // ── 8: Change dates and the initiative ──────────────────────────────
    const { createTemplateRun } = await import('../src/lib/api/task-templates');
    const { reflowTemplateRun } = await import('../src/lib/api/template-reflow');
    const made = await createTemplateRun(service, owner, s.template, {
      project_id: s.projectId, key_dates: { start: '2027-01-04', golive: '2027-01-15' }, values: {}, roles: {}, create_initiative: true,
    } as Loose, 'api');
    const runId = made.run.id as string;
    const iniId = (await one<Loose>('SELECT initiative_id FROM pm.task_template_runs WHERE id = $1', [runId])).initiative_id;
    const iniBefore = await one<Loose>('SELECT start_date::text, target_date::text FROM pm.initiatives WHERE id = $1', [iniId]);
    const preview = await reflowTemplateRun(service, owner, runId, { key_dates: { start: '2027-01-06' }, dry_run: true } as Loose);
    const moved = await reflowTemplateRun(service, owner, runId, { key_dates: { start: '2027-01-06' } } as Loose);
    const iniAfter = await one<Loose>('SELECT start_date::text, target_date::text FROM pm.initiatives WHERE id = $1', [iniId]);
    check('change dates: the initiative\'s start follows the earliest key date (said in the dry run and done); its target stays on the main one', iniBefore.start_date === '2027-01-04'
      && iniBefore.target_date === '2027-01-15' && iniAfter.target_date === '2027-01-15'
      && preview.initiative?.start_follows === true && preview.initiative.start_to === '2027-01-06'
      && moved.initiative?.start_follows === true && iniAfter.start_date === '2027-01-06', { iniBefore, preview: preview.initiative, moved: moved.initiative, iniAfter });
    const golive = await reflowTemplateRun(service, owner, runId, { key_dates: { golive: '2027-01-29' } } as Loose);
    const iniGolive = await one<Loose>('SELECT start_date::text, target_date::text FROM pm.initiatives WHERE id = $1', [iniId]);
    check('change dates: moving the main key date moves the target; the start stays', golive.initiative?.follows === true && iniGolive.target_date === '2027-01-29'
      && iniGolive.start_date === '2027-01-06', { golive: golive.initiative, iniGolive });

    const tasksBefore = await s.q<Loose>('SELECT id, due_date FROM pm.tasks WHERE id = ANY($1::uuid[]) ORDER BY id', [made.tasks.map((t: Loose) => t.id)]);
    await s.q('UPDATE pm.initiatives SET deleted_at = now() WHERE id = $1', [iniId]);
    const trashedDry = await errorOf(reflowTemplateRun(service, owner, runId, { key_dates: { start: '2027-02-01' }, dry_run: true } as Loose));
    const trashedReal = await errorOf(reflowTemplateRun(service, owner, runId, { key_dates: { start: '2027-02-01' } } as Loose));
    const tasksAfter = await s.q<Loose>('SELECT id, due_date FROM pm.tasks WHERE id = ANY($1::uuid[]) ORDER BY id', [made.tasks.map((t: Loose) => t.id)]);
    const runDates = (await one<Loose>('SELECT key_dates FROM pm.task_template_runs WHERE id = $1', [runId])).key_dates;
    const sqlRefusal = await db.query(`SELECT pm.reflow_task_template_run($1, $2, '{"start":"2027-02-01","golive":"2027-01-29"}', '2027-02-01', '[]', NULL)`, [runId, JSON.stringify(runDates)]).then(() => null, (e: Error) => e.message);
    await s.q('UPDATE pm.initiatives SET deleted_at = NULL WHERE id = $1', [iniId]);
    check('change dates: while the initiative is in Trash, nothing moves (409 initiative_in_trash, the dry run too, the database refuses as well)',
      trashedDry?.statusCode === 409 && trashedDry.details?.reason === 'initiative_in_trash' && trashedReal?.statusCode === 409
      && JSON.stringify(tasksBefore) === JSON.stringify(tasksAfter) && runDates.start === '2027-01-06' && /initiative_in_trash/.test(sqlRefusal ?? ''),
    { dry: trashedDry?.details, real: trashedReal?.details, runDates, sqlRefusal });

    // ── 9: data retention keeps a tree while any run in it is recent ─────
    await s.q('UPDATE pm.business_settings SET agent_run_retention_days = 30');
    await s.q('INSERT INTO pm.business_settings (agent_run_retention_days) SELECT 30 WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)');
    const oldRoot = (await one<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, status, started_at, updated_at, finished_at) VALUES ($1, 'Old root', 'succeeded', now() - interval '400 days', now() - interval '399 days', now() - interval '399 days') RETURNING id", [s.atlas])).id;
    const youngChild = (await one<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, parent_run_id, status, started_at, updated_at, finished_at) VALUES ($1, 'Young child', $2, 'succeeded', now() - interval '2 days', now() - interval '1 day', now() - interval '1 day') RETURNING id", [s.atlas, oldRoot])).id;
    const goneRoot = (await one<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, status, started_at, updated_at, finished_at) VALUES ($1, 'Gone root', 'succeeded', now() - interval '400 days', now() - interval '399 days', now() - interval '399 days') RETURNING id", [s.atlas])).id;
    const goneChild = (await one<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, parent_run_id, status, started_at, updated_at, finished_at) VALUES ($1, 'Gone child', $2, 'succeeded', now() - interval '300 days', now() - interval '299 days', now() - interval '299 days') RETURNING id", [s.atlas, goneRoot])).id;
    const retained = (await one<{ r: Loose }>('SELECT pm.apply_data_retention() AS r')).r;
    const child = await one<Loose>('SELECT parent_run_id, root_run_id FROM pm.agent_runs WHERE id = $1', [youngChild]);
    const rootKept = await count('SELECT count(*)::int AS n FROM pm.agent_runs WHERE id = $1', [oldRoot]);
    const goneLeft = await count('SELECT count(*)::int AS n FROM pm.agent_runs WHERE id IN ($1, $2)', [goneRoot, goneChild]);
    check('retention: a recent run keeps its old root and lineage; a tree past the window goes whole', rootKept === 1 && child.parent_run_id === oldRoot
      && child.root_run_id === oldRoot && goneLeft === 0 && retained.agent_runs >= 2, { rootKept, child, goneLeft, retained });
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`lifecycle fixes: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
