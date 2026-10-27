/**
 * Subtasks are tasks: the text subtasks copy in once (same ids, done kept,
 * Trash kept, nothing logged or unread) and the old table is frozen; a
 * subtask is one level deep, in its parent's project, added only by someone
 * who can manage the parent; set_task_parent nests and promotes, moving a
 * task across projects only when it may; a parent's move takes its subtasks;
 * access follows the parent; Trash hides a parent's subtasks and brings a
 * subtask back only after its parent; the team log and unread events say
 * what happened on the subtask and its parent.
 *
 * Runs on PGlite (real Postgres) over the whole real schema, migrated from
 * the schema before this change and fresh from schema.sql; nothing touches a
 * live database.
 *
 *   npm run -s test:subtasks
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, schemaBeforeMigration } from './full-schema-db';

const MIGRATION = '20261026212748_subtasks_are_tasks.sql';
const OWNER_USER = '00000000-0000-0000-0000-0000000000e1';
const MANAGER_USER = '00000000-0000-0000-0000-0000000000e2';
const READER_USER = '00000000-0000-0000-0000-0000000000e3';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function attempt(db: PGlite, sql: string, params: unknown[] = []) {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** schema.sql before this change: the commit that added the migration's parent, or HEAD while it is uncommitted. */
function schemaBefore(): string {
  try {
    return schemaBeforeMigration(MIGRATION);
  } catch {
    return execFileSync('git', ['show', 'HEAD:app/supabase/schema.sql'], {
      cwd: join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  }
}

type Db = { db: PGlite; q: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]> };

function wrap(db: PGlite): Db {
  return { db, q: async (sql, params = []) => (await db.query(sql, params)).rows as never };
}

async function superuser(db: PGlite) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false), set_config('request.headers', '', false)");
}

async function seedPeople({ db, q }: Db) {
  await superuser(db);
  await db.exec(`INSERT INTO auth.users (id, email) VALUES
    ('${OWNER_USER}', 'owner@example.com'), ('${MANAGER_USER}', 'manager@example.com'), ('${READER_USER}', 'reader@example.com')`);
  const people = await q<{ id: string; auth_user_id: string }>('SELECT id, auth_user_id FROM public.team_members');
  const id = (user: string) => people.find((m) => m.auth_user_id === user)!.id;
  const owner = id(OWNER_USER);
  const manager = id(MANAGER_USER);
  const reader = id(READER_USER);
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'app', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read', 'tasks.create', 'tasks.manage_all']) AS key`, [manager]);
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'app', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read_assigned', 'tasks.create', 'tasks.manage_assigned']) AS key`, [reader]);
  // Only their own tasks: whatever the member role grants by default.
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'app', 'deny' FROM unnest(ARRAY['tasks.read', 'tasks.manage_all', 'projects.read_all']) AS key`, [reader]);
  return { owner, manager, reader };
}

async function project({ q }: Db, name: string, members: string[]) {
  const id = (await q<{ id: string }>('INSERT INTO public.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
  for (const member of members) await q('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [id, member]);
  return id;
}

async function task({ q }: Db, projectId: string, title: string, extra: { parent?: string; createdBy?: string } = {}) {
  return (await q<{ id: string }>('INSERT INTO public.tasks (project_id, title, parent_task_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [projectId, title, extra.parent ?? null, extra.createdBy ?? null]))[0].id;
}

// --- The copy --------------------------------------------------------------------
async function migratedCopy() {
  const db = await createFullSchemaDatabase({ schemaSql: schemaBefore() });
  const w = wrap(db);
  const { q } = w;
  const { owner } = await seedPeople(w);
  const p = await project(w, 'Happy Innovations', []);
  await superuser(db);
  const parent = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'Launch site', $2) RETURNING id", [p, owner]))[0].id;
  const gone = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, deleted_at) VALUES ($1, 'Old idea', now()) RETURNING id", [p]))[0].id;
  const [done, open, trashed] = (await q<{ id: string }>(`INSERT INTO public.task_subtasks (task_id, title, completed, sort_order, deleted_at) VALUES
    ($1, 'Copy approved', true, 0, NULL), ($1, 'DNS cut over', false, 1, NULL), ($1, 'Old step', false, 2, now()) RETURNING id`, [parent])).map((r) => r.id);
  const underGone = (await q<{ id: string }>("INSERT INTO public.task_subtasks (task_id, title) VALUES ($1, 'Under a trashed task') RETURNING id", [gone]))[0].id;
  const activitiesBefore = Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM public.activities'))[0].n);
  const eventsBefore = Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM public.task_events'))[0].n);

  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
  await db.exec(sql);
  await db.exec(sql);

  const rows = await q<{ id: string; parent_task_id: string; status: string; completed_at: string | null; sort_order: number; deleted_at: string | null; created_via: string; created_by: string | null; project_id: string }>(
    'SELECT id, parent_task_id, status, completed_at, sort_order, deleted_at, created_via, created_by, project_id FROM public.tasks WHERE parent_task_id IS NOT NULL ORDER BY sort_order, title');
  const byId = new Map(rows.map((r) => [r.id, r]));
  check('copy: every text subtask is a task with the same id, once (re-run safe)', rows.length === 4 && [done, open, trashed, underGone].every((id) => byId.has(id)), rows);
  check('copy: done stays done with a completion time', byId.get(done)?.status === 'done' && byId.get(done)?.completed_at !== null, byId.get(done));
  check('copy: open is To Do, order kept, parent and project set',
    byId.get(open)?.status === 'todo' && byId.get(open)?.sort_order === 1 && byId.get(open)?.parent_task_id === parent && byId.get(open)?.project_id === p, byId.get(open));
  check('copy: one in Trash arrives in Trash', byId.get(trashed)?.deleted_at !== null);
  check('copy: made by the parent\'s creator, from before tracking', byId.get(open)?.created_by === owner && byId.get(open)?.created_via === 'unknown', byId.get(open));
  check('copy: logs nothing',
    Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM public.activities'))[0].n) === activitiesBefore);
  check('copy: marks nothing unread', Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM public.task_events'))[0].n) === eventsBefore);
  check('copy: the old table is frozen',
    (await attempt(db, "INSERT INTO public.task_subtasks (task_id, title) VALUES ($1, 'late')", [parent]))?.includes('Subtasks are tasks now') === true);
  await actAs(db, null);
  check('copy: Trash lists the trashed subtask once, as a subtask of its parent',
    (await q<{ record_type: string; context: string }>('SELECT record_type, context FROM public.list_trash() WHERE id = $1', [trashed]))
      .map((r) => `${r.record_type}:${r.context}`).join() === 'tasks:Subtask of Launch site');
  await db.close();
}

// --- The rules -----------------------------------------------------------------
async function rules(db: PGlite, label: string) {
  const w = wrap(db);
  const { q } = w;
  const { owner, manager, reader } = await seedPeople(w);
  const P = await project(w, 'Apex', [manager, reader]);
  const Q = await project(w, 'Brightside', [manager, reader]);
  await superuser(db);
  const parent = await task(w, P, 'Homepage', { createdBy: owner });
  const other = await task(w, P, 'Footer', { createdBy: owner });
  const elsewhere = await task(w, Q, 'Logo', { createdBy: owner });
  const blocked = await task(w, Q, 'Blocked thing', { createdBy: owner });
  await q('INSERT INTO public.task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [blocked, elsewhere]);
  await q('INSERT INTO public.task_assignees (task_id, member_id) VALUES ($1, $2)', [parent, reader]);
  const err = (m: string | null, text: string) => m?.includes(text) === true;

  // Adding a subtask in the app.
  await actAs(db, MANAGER_USER);
  const sub = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, parent_task_id, created_by) VALUES ($1, 'Hero copy', $2, $3) RETURNING id",
    [P, parent, manager]))[0].id;
  await superuser(db);
  const added = await q<{ type: string; description: string; metadata: { parent_task_id: string } }>(
    "SELECT type, description, metadata FROM public.activities WHERE entity_id = $1", [sub]);
  check(`${label}: adding a subtask logs "Added subtask"`,
    added.length === 1 && added[0].type === 'subtask.added' && added[0].description === 'Added subtask "Hero copy" to "Homepage"' && added[0].metadata.parent_task_id === parent, added);
  check(`${label}: the parent hears about it`,
    (await q("SELECT 1 FROM public.task_events WHERE task_id = $1 AND kind = 'subtask'", [parent])).length === 1);

  // The rules.
  await actAs(db, MANAGER_USER);
  check(`${label}: one level deep`,
    err(await attempt(db, "INSERT INTO public.tasks (project_id, title, parent_task_id, created_by) VALUES ($1, 'Too deep', $2, $3)", [P, sub, manager]), 'one level deep'));
  check(`${label}: a subtask stays in its parent's project`,
    err(await attempt(db, "INSERT INTO public.tasks (project_id, title, parent_task_id, created_by) VALUES ($1, 'Wrong place', $2, $3)", [Q, parent, manager]), "parent task's project"));
  check(`${label}: a subtask cannot move projects on its own`,
    err(await attempt(db, 'UPDATE public.tasks SET project_id = $1 WHERE id = $2', [Q, sub]), "parent task's project"));
  check(`${label}: a task with subtasks cannot become one`,
    err(await attempt(db, 'SELECT public.set_task_parent($1, $2)', [parent, other]), 'It has 1 subtask.'));
  check(`${label}: not under itself`, err(await attempt(db, 'SELECT public.set_task_parent($1, $1)', [other]), 'its own subtask'));
  check(`${label}: not under a subtask`, err(await attempt(db, 'SELECT public.set_task_parent($1, $2)', [other, sub]), 'one level deep'));

  // Nest and promote.
  await q('SELECT public.set_task_parent($1, $2)', [other, parent]);
  let row = (await q<{ parent_task_id: string; sort_order: number }>('SELECT parent_task_id, sort_order FROM public.tasks WHERE id = $1', [other]))[0];
  check(`${label}: nesting puts it last under the parent`, row.parent_task_id === parent && row.sort_order === 1, row);
  await q('SELECT public.set_task_parent($1, NULL)', [other]);
  row = (await q<{ parent_task_id: string; sort_order: number }>('SELECT parent_task_id, sort_order FROM public.tasks WHERE id = $1', [other]))[0];
  check(`${label}: promoting makes it top-level`, row.parent_task_id === null, row);
  await superuser(db);
  const log = (await q<{ type: string; description: string }>("SELECT type, description FROM public.activities WHERE entity_id = $1 ORDER BY created_at, type", [other]));
  check(`${label}: nesting and promoting are logged as such, not as edits`,
    log.map((l) => l.type).sort().join() === 'task.nested,task.promoted'
      && log.some((l) => l.description === 'Moved "Footer" under "Homepage"') && log.some((l) => l.description === 'Made "Footer" a top-level task'), log);

  // Across projects.
  await actAs(db, READER_USER);
  check(`${label}: moving across projects needs manage_all`,
    err(await attempt(db, 'SELECT public.set_task_parent($1, $2)', [elsewhere, parent]), 'manage all tasks')
      || err(await attempt(db, 'SELECT public.set_task_parent($1, $2)', [elsewhere, parent]), 'not found'));
  await actAs(db, MANAGER_USER);
  check(`${label}: a task with blocker links stays in its project`,
    err(await attempt(db, 'SELECT public.set_task_parent($1, $2)', [blocked, parent]), 'blocked by, or blocks'));
  const free = await (async () => { await superuser(db); return task(w, Q, 'Favicon', { createdBy: owner }); })();
  await actAs(db, MANAGER_USER);
  await q('SELECT public.set_task_parent($1, $2)', [free, parent]);
  check(`${label}: nesting under another project's task moves it there`,
    (await q<{ project_id: string }>('SELECT project_id FROM public.tasks WHERE id = $1', [free]))[0].project_id === P);

  // A parent's move takes its subtasks, quietly.
  await superuser(db);
  const before = Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM public.activities WHERE entity_id = $1", [sub]))[0].n);
  const eventsBefore = Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM public.task_events WHERE task_id = $1', [sub]))[0].n);
  await actAs(db, MANAGER_USER);
  await q('UPDATE public.tasks SET project_id = $1 WHERE id = $2', [Q, parent]);
  await superuser(db);
  check(`${label}: a parent's move takes its subtasks`,
    (await q<{ project_id: string }>('SELECT DISTINCT project_id FROM public.tasks WHERE parent_task_id = $1', [parent])).map((r) => r.project_id).join() === Q);
  check(`${label}: the subtasks' move is not logged or unread on its own`,
    Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM public.activities WHERE entity_id = $1", [sub]))[0].n) === before
      && Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM public.task_events WHERE task_id = $1', [sub]))[0].n) === eventsBefore);
  await actAs(db, MANAGER_USER);
  await q('UPDATE public.tasks SET project_id = $1 WHERE id = $2', [P, parent]);

  // Access follows the parent.
  await actAs(db, READER_USER);
  const visible = new Set((await q<{ id: string }>('SELECT id FROM public.tasks')).map((r) => r.id));
  check(`${label}: an assigned-only reader sees the subtasks of their task`, visible.has(parent) && visible.has(sub) && visible.has(free), [...visible]);
  check(`${label}: and can work them`, (await q('UPDATE public.tasks SET status = $1 WHERE id = $2 RETURNING id', ['done', sub])).length === 1);
  check(`${label}: and add one`,
    (await attempt(db, "INSERT INTO public.tasks (project_id, title, parent_task_id, created_by) VALUES ($1, 'Alt text', $2, $3)", [P, parent, reader])) === null);
  await superuser(db);
  const theirs = await task(w, P, 'Pricing page', { createdBy: owner });
  const mine = await task(w, P, 'Pricing table', { parent: theirs, createdBy: owner });
  const notMine = await task(w, P, 'Pricing FAQ', { parent: theirs, createdBy: owner });
  await q('INSERT INTO public.task_assignees (task_id, member_id) VALUES ($1, $2)', [mine, reader]);
  await actAs(db, READER_USER);
  const seen = new Set((await q<{ id: string }>('SELECT id FROM public.tasks')).map((r) => r.id));
  check(`${label}: on a subtask, they read its parent for context but not its other subtasks`,
    seen.has(mine) && seen.has(theirs) && !seen.has(notMine), { mine: seen.has(mine), theirs: seen.has(theirs), notMine: seen.has(notMine) });
  check(`${label}: but cannot add subtasks to a parent they do not manage`,
    err(await attempt(db, "INSERT INTO public.tasks (project_id, title, parent_task_id, created_by) VALUES ($1, 'Sneaky', $2, $3)", [P, theirs, reader]), 'cannot add subtasks'));

  // Trash.
  await actAs(db, READER_USER);
  check(`${label}: whoever manages the parent can trash its subtask`,
    (await q<{ ok: boolean }>("SELECT public.soft_delete_record('tasks', $1) AS ok", [sub]))[0].ok === true);
  await actAs(db, MANAGER_USER);
  check(`${label}: a subtask comes back after its parent`,
    (await q("SELECT public.soft_delete_record('tasks', $1)", [parent])).length === 1
      && err(await attempt(db, "SELECT public.restore_record('tasks', $1)", [sub]), 'Restore the task it belongs to first'));
  const hidden = new Set((await q<{ id: string }>('SELECT id FROM public.tasks')).map((r) => r.id));
  check(`${label}: a parent in Trash hides its subtasks`, !hidden.has(free) && !hidden.has(parent), [...hidden]);
  check(`${label}: and nothing new can join it`,
    err(await attempt(db, "INSERT INTO public.tasks (project_id, title, parent_task_id, created_by) VALUES ($1, 'Late', $2, $3)", [P, parent, manager]), ''));
  await q("SELECT public.restore_record('tasks', $1)", [parent]);
  await q("SELECT public.restore_record('tasks', $1)", [sub]);
  check(`${label}: restoring the parent then the subtask brings both back`,
    (await q('SELECT 1 FROM public.tasks WHERE id = ANY($1)', [[parent, sub, free]])).length === 3);

  // A trashed subtask cannot come back two levels deep.
  await superuser(db);
  const host = await task(w, P, 'Host', { createdBy: owner });
  const lone = await task(w, P, 'Lone', { createdBy: owner });
  const leftover = await task(w, P, 'Leftover', { parent: lone, createdBy: owner });
  await actAs(db, MANAGER_USER);
  await q("SELECT public.soft_delete_record('tasks', $1)", [leftover]);
  await q('SELECT public.set_task_parent($1, $2)', [lone, host]);
  check(`${label}: a subtask whose parent became a subtask cannot come back under it`,
    err(await attempt(db, "SELECT public.restore_record('tasks', $1)", [leftover]), 'one level deep'));

  // Unread on the parent.
  await superuser(db);
  await db.query("SELECT set_config('request.headers', $1, false)", [JSON.stringify({ 'x-actor-member-id': manager, 'x-actor-via': 'api' })]);
  await actAs(db, null);
  await db.query("SELECT set_config('request.headers', $1, false)", [JSON.stringify({ 'x-actor-member-id': manager, 'x-actor-via': 'api' })]);
  const parentEvents = async () => Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM public.task_events WHERE task_id = $1 AND kind = 'subtask'", [theirs]))[0].n);
  const n0 = await parentEvents();
  await q("UPDATE public.tasks SET status = 'in_progress' WHERE id = $1", [notMine]);
  const n1 = await parentEvents();
  await q("UPDATE public.tasks SET status = 'done' WHERE id = $1", [notMine]);
  const n2 = await parentEvents();
  check(`${label}: a subtask finishing is news on its parent; moving between open columns is not`, n1 === n0 && n2 === n0 + 1, { n0, n1, n2 });
  check(`${label}: finishing every subtask leaves the parent as it was`,
    (await q<{ status: string }>('SELECT status FROM public.tasks WHERE id = $1', [theirs]))[0].status === 'todo');
}

async function main() {
  await migratedCopy();
  {
    const db = await createFullSchemaDatabase({ schemaSql: schemaBefore() });
    await db.exec('RESET ROLE');
    const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    await rules(db, 'migrated');
    await db.close();
  }
  const fresh = await createFullSchemaDatabase();
  await rules(fresh, 'schema.sql');
  await fresh.close();

  if (failures.length) {
    console.error(`subtasks: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`subtasks: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
