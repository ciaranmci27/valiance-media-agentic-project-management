/**
 * A task moved to done while the mover's own timer runs on that project joins
 * that session. Runs the real migration on PGlite (real Postgres) over minimal
 * tables; nothing touches a live database.
 *
 *   npm run -s test:done-timer-link
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261016065559_link_done_task_to_running_timer.sql');

const OWNER_USER = '00000000-0000-0000-0000-0000000000a1';
const OTHER_USER = '00000000-0000-0000-0000-0000000000a2';
const STRANGER_USER = '00000000-0000-0000-0000-0000000000a3';
const OWNER = '00000000-0000-0000-0000-0000000000b1';
const OTHER = '00000000-0000-0000-0000-0000000000b2';
const P1 = '00000000-0000-0000-0000-0000000000c1';
const P2 = '00000000-0000-0000-0000-0000000000c2';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function main() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.team_members (id uuid PRIMARY KEY, auth_user_id uuid);
    CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL,
      title text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'todo');
    CREATE TABLE public.project_time_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL,
      member_id uuid NOT NULL, end_time timestamptz, segments jsonb NOT NULL DEFAULT '[]'::jsonb);
    CREATE TABLE public.time_entry_tasks (time_entry_id uuid NOT NULL, task_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (time_entry_id, task_id));
    INSERT INTO public.team_members VALUES ('${OWNER}', '${OWNER_USER}'), ('${OTHER}', '${OTHER_USER}');
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  // The migration is safe to run twice.
  await db.exec(readFileSync(MIGRATION, 'utf8'));

  const as = (user: string | null) => db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
  const entry = async (project: string, member: string, state: 'running' | 'paused' | 'stopped' | 'empty') => {
    const segments = state === 'empty' ? [] : state === 'running'
      ? [{ start: '2026-10-15T15:00:00Z', end: '2026-10-15T16:00:00Z' }, { start: '2026-10-15T16:10:00Z', end: null }]
      : [{ start: '2026-10-15T15:00:00Z', end: '2026-10-15T16:00:00Z' }];
    const end = state === 'stopped' ? '2026-10-15T16:00:00Z' : null;
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO public.project_time_entries (project_id, member_id, end_time, segments) VALUES ($1, $2, $3, $4) RETURNING id',
      [project, member, end, JSON.stringify(segments)]);
    return rows[0].id;
  };
  const task = async (project: string, status = 'todo') => {
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO public.tasks (project_id, status) VALUES ($1, $2) RETURNING id', [project, status]);
    return rows[0].id;
  };
  const links = async (taskId: string) =>
    (await db.query<{ time_entry_id: string }>('SELECT time_entry_id FROM public.time_entry_tasks WHERE task_id = $1', [taskId]))
      .rows.map((r) => r.time_entry_id);
  const setStatus = (taskId: string, status: string) => db.query('UPDATE public.tasks SET status = $1 WHERE id = $2', [status, taskId]);
  const clearEntries = () => db.exec('DELETE FROM public.time_entry_tasks; DELETE FROM public.project_time_entries;');

  // Dragged to done while his timer runs on that project: linked to that session.
  let running = await entry(P1, OWNER, 'running');
  let t = await task(P1);
  await as(OWNER_USER);
  await setStatus(t, 'done');
  check('running timer on the same project: the task joins that session', JSON.stringify(await links(t)) === JSON.stringify([running]), await links(t));

  // Out of done and back in: still one link, no error.
  await setStatus(t, 'in_progress');
  await setStatus(t, 'done');
  check('done again later: one link, no duplicate', (await links(t)).length === 1, await links(t));

  // A save that keeps it done (a title edit, or status written unchanged) adds nothing.
  await db.query("UPDATE public.tasks SET title = 'renamed', status = 'done' WHERE id = $1", [t]);
  check('saving a done task again adds nothing', (await links(t)).length === 1);

  // The API and agents: no signed-in user, nothing linked.
  t = await task(P1);
  await as(null);
  await setStatus(t, 'done');
  check('API writes (no auth.uid) never link', (await links(t)).length === 0);

  // Paused, stopped, or an empty session: not running, nothing linked.
  for (const state of ['paused', 'stopped', 'empty'] as const) {
    await clearEntries();
    await entry(P1, OWNER, state);
    t = await task(P1);
    await as(OWNER_USER);
    await setStatus(t, 'done');
    check(`a ${state} session is not linked`, (await links(t)).length === 0, await links(t));
  }

  // His timer runs on another project only.
  await clearEntries();
  await entry(P2, OWNER, 'running');
  t = await task(P1);
  await as(OWNER_USER);
  await setStatus(t, 'done');
  check('his timer on another project is not linked', (await links(t)).length === 0);

  // Someone else's timer runs on this project: only the mover's own time counts.
  await clearEntries();
  await entry(P1, OTHER, 'running');
  running = await entry(P1, OWNER, 'running');
  t = await task(P1);
  await as(OWNER_USER);
  await setStatus(t, 'done');
  check("only the mover's own session is linked, not a teammate's", JSON.stringify(await links(t)) === JSON.stringify([running]), await links(t));

  // A signed-in user who is not a team member (a portal client): nothing.
  t = await task(P1);
  await as(STRANGER_USER);
  await setStatus(t, 'done');
  check('a signed-in non-member never links', (await links(t)).length === 0);

  // Created already done (not a move): nothing.
  await as(OWNER_USER);
  t = await task(P1, 'done');
  check('a task created as done is not a move to done', (await links(t)).length === 0);

  // The trigger is the only way in: the function cannot be called directly.
  const { rows } = await db.query<{ ok: boolean }>(
    "SELECT has_function_privilege('authenticated', 'public.link_done_task_to_running_timer()', 'execute') AS ok");
  check('signed-in users cannot call the function directly', rows[0].ok === false);

  await db.close();
  if (failures.length) {
    console.error(`${failures.length} failed, ${passed} passed`);
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`done-timer link: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
