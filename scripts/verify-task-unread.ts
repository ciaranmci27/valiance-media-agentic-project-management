/**
 * Unread tasks: every change worth knowing about on a task becomes an event
 * with who made it and how, whatever path made it; a member's own changes in
 * the app never read as unread to them, an agent's or a key's always do;
 * creation, reordering and Trash are not changes; a look clears it and Mark
 * all read clears many, skipping what the member cannot see. The migration
 * applies to the schema as it was and runs twice.
 *
 * Runs on PGlite (real Postgres) over the whole real schema; nothing touches
 * a live database.
 *
 *   npm run -s test:task-unread
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, schemaBeforeMigration } from './full-schema-db';

const MIGRATION = '20261025011928_task_unread_updates.sql';
const OWNER_USER = '00000000-0000-0000-0000-0000000000d1';
const MEMBER_USER = '00000000-0000-0000-0000-0000000000d2';

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

type Update = {
  task_id: string;
  seen_at: string | null;
  total: number;
  kinds: Record<string, number>;
  last_member_id: string | null;
  last_via: string;
  last_kind: string;
};

async function run(db: PGlite, label: string) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const superuser = async () => {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false), set_config('request.headers', '', false)");
  };
  const asServer = async (headers: Record<string, string> | null) => {
    await actAs(db, null);
    await db.query("SELECT set_config('request.headers', $1, false)", [headers ? JSON.stringify(headers) : '']);
  };
  const updatesFor = async (user: string) => {
    await actAs(db, user);
    const rows = await q<Update>('SELECT * FROM public.my_task_updates()');
    return new Map(rows.map((row) => [row.task_id, row]));
  };
  const eventCount = async (taskId: string) => {
    await superuser();
    return Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM public.task_events WHERE task_id = $1', [taskId]))[0].n);
  };

  // --- Seed -------------------------------------------------------------------
  await superuser();
  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${OWNER_USER}', 'owner@example.com'), ('${MEMBER_USER}', 'member@example.com')`);
  const people = await q<{ id: string; auth_user_id: string }>('SELECT id, auth_user_id FROM public.team_members');
  const owner = people.find((m) => m.auth_user_id === OWNER_USER)!.id;
  const member = people.find((m) => m.auth_user_id === MEMBER_USER)!.id;
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'app', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read', 'tasks.manage_all']) AS key`, [member]);
  const ashley = (await q<{ id: string }>("INSERT INTO public.team_members (name, email, role) VALUES ('Ashley', 'ashley@example.com', 'agent') RETURNING id"))[0].id;
  const project = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Happy Innovations') RETURNING id"))[0].id;
  await db.query('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [project, member]);
  const task = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'Homepage hero', $2) RETURNING id", [project, owner]))[0].id;
  const other = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'Footer logo', $2) RETURNING id", [project, owner]))[0].id;
  const elsewhere = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  const hidden = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Not theirs') RETURNING id", [elsewhere]))[0].id;
  check(`${label}: a new task is not a change`, await eventCount(task) === 0);

  // --- Creation in one transaction --------------------------------------------
  await actAs(db, OWNER_USER);
  await db.exec('BEGIN');
  const fresh = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'Saved with its people', $2) RETURNING id", [project, owner]))[0].id;
  await db.query('INSERT INTO public.task_assignees (task_id, member_id) VALUES ($1, $2)', [fresh, member]);
  await db.query("INSERT INTO public.task_subtasks (task_id, title) VALUES ($1, 'First step')", [fresh]);
  await db.exec('COMMIT');
  check(`${label}: what is saved with a new task is part of creating it`, await eventCount(fresh) === 0);

  // --- Who made it --------------------------------------------------------------
  await actAs(db, OWNER_USER);
  await db.query("UPDATE public.tasks SET title = 'Homepage hero v2' WHERE id = $1", [task]);
  let owners = await updatesFor(OWNER_USER);
  let members = await updatesFor(MEMBER_USER);
  check(`${label}: my own edit in the app is not unread to me`, !owners.has(task), [...owners.values()]);
  const edit = members.get(task);
  check(`${label}: it is unread to a teammate, as an edit by me in the app`,
    edit?.total === 1 && edit.kinds.edit === 1 && edit.last_member_id === owner && edit.last_via === 'app' && edit.seen_at === null, edit);

  await asServer({ 'x-actor-member-id': ashley, 'x-actor-via': 'api' });
  await db.query("INSERT INTO public.task_comments (task_id, user_id, text) VALUES ($1, $2, 'Anthony prefers option B')", [task, ashley]);
  owners = await updatesFor(OWNER_USER);
  const comment = owners.get(task);
  check(`${label}: an agent's comment is unread to everyone`,
    comment?.total === 1 && comment.kinds.comment === 1 && comment.last_member_id === ashley && comment.last_via === 'api' && comment.last_kind === 'comment', comment);
  members = await updatesFor(MEMBER_USER);
  check(`${label}: counts add up by kind`, members.get(task)?.total === 2 && members.get(task)?.kinds.comment === 1 && members.get(task)?.kinds.edit === 1, members.get(task));

  await asServer({ 'x-actor-member-id': owner, 'x-actor-via': 'mcp' });
  await db.query("UPDATE public.tasks SET priority = 'high' WHERE id = $1", [other]);
  owners = await updatesFor(OWNER_USER);
  check(`${label}: my own key is not me: its change is unread to me`, owners.get(other)?.last_via === 'mcp' && owners.get(other)?.last_member_id === owner, owners.get(other));

  await asServer({ 'x-actor-member-id': owner, 'x-actor-via': 'app' });
  await db.query("INSERT INTO public.task_comments (task_id, user_id, text) VALUES ($1, $2, 'Routed for me')", [other, owner]);
  owners = await updatesFor(OWNER_USER);
  check(`${label}: the app's routes acting for me are me`, owners.get(other)?.total === 1, owners.get(other));

  await asServer(null);
  await db.query("INSERT INTO public.task_subtasks (task_id, title) VALUES ($1, 'From the server')", [other]);
  await superuser();
  const system = (await q<{ via: string; member_id: string | null }>("SELECT via, member_id FROM public.task_events WHERE task_id = $1 AND kind = 'subtask'", [other]))[0];
  check(`${label}: the server with no one behind it is system`, system?.via === 'system' && system.member_id === null, system);

  // --- Not changes --------------------------------------------------------------
  const before = await eventCount(task);
  await actAs(db, MEMBER_USER);
  await db.query('UPDATE public.tasks SET sort_order = sort_order + 5 WHERE id = $1', [task]);
  check(`${label}: reordering is not a change`, await eventCount(task) === before);

  await actAs(db, MEMBER_USER);
  await db.exec('BEGIN');
  for (const text of ['Loads under 2s', 'Works on mobile', 'Matches the mockup']) {
    await db.query('INSERT INTO public.task_acceptance_criteria (task_id, criterion) VALUES ($1, $2)', [task, text]);
  }
  await db.exec('COMMIT');
  check(`${label}: one save is one change per kind`, await eventCount(task) === before + 1);

  await actAs(db, MEMBER_USER);
  await db.query("UPDATE public.tasks SET status = 'in_progress' WHERE id = $1", [task]);
  owners = await updatesFor(OWNER_USER);
  check(`${label}: a status move is its own kind`, owners.get(task)?.kinds.status === 1 && owners.get(task)?.last_kind === 'status', owners.get(task));

  await superuser();
  const updatedAt = (await q<{ updated_at: string }>('SELECT updated_at::text FROM public.tasks WHERE id = $1', [task]))[0].updated_at;
  const logged = Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM public.activities WHERE type = 'task.updated' AND entity_id = $1", [task]))[0].n);
  await asServer({ 'x-actor-member-id': ashley, 'x-actor-via': 'api' });
  await db.query("INSERT INTO public.task_comments (task_id, user_id, text) VALUES ($1, $2, 'One more')", [task, ashley]);
  await superuser();
  check(`${label}: recording a change never moves the task or the team log`,
    (await q<{ updated_at: string }>('SELECT updated_at::text FROM public.tasks WHERE id = $1', [task]))[0].updated_at === updatedAt
      && Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM public.activities WHERE type = 'task.updated' AND entity_id = $1", [task]))[0].n) === logged);

  // --- Seen -------------------------------------------------------------------
  await actAs(db, OWNER_USER);
  await db.query('SELECT public.mark_task_seen($1)', [task]);
  owners = await updatesFor(OWNER_USER);
  check(`${label}: opening a task clears it`, !owners.has(task));
  members = await updatesFor(MEMBER_USER);
  check(`${label}: only for the one who opened it`, members.has(task));

  await asServer({ 'x-actor-member-id': ashley, 'x-actor-via': 'api' });
  await db.query("INSERT INTO public.task_comments (task_id, user_id, text) VALUES ($1, $2, 'He signed off')", [task, ashley]);
  owners = await updatesFor(OWNER_USER);
  check(`${label}: a change after the look is unread again, with when I looked`,
    owners.get(task)?.total === 1 && owners.get(task)?.seen_at !== null, owners.get(task));

  await actAs(db, MEMBER_USER);
  const marked = (await q<{ n: number }>('SELECT public.mark_tasks_seen($1) AS n', [[task, other, hidden]]))[0].n;
  members = await updatesFor(MEMBER_USER);
  check(`${label}: Mark all read clears many and skips what I cannot see`, marked === 2 && !members.has(task) && !members.has(other), { marked });
  await superuser();
  check(`${label}: and writes nothing for the task I cannot see`,
    (await q('SELECT 1 FROM public.task_views WHERE task_id = $1', [hidden])).length === 0);

  // --- Trash and access ---------------------------------------------------------
  await asServer({ 'x-actor-member-id': ashley, 'x-actor-via': 'api' });
  await db.query("INSERT INTO public.task_comments (task_id, user_id, text) VALUES ($1, $2, 'Before Trash')", [other, ashley]);
  const beforeTrash = await eventCount(other);
  await asServer({ 'x-actor-member-id': owner, 'x-actor-via': 'app' });
  await db.query('UPDATE public.tasks SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [other, owner]);
  check(`${label}: moving to Trash is not a change`, await eventCount(other) === beforeTrash);
  members = await updatesFor(MEMBER_USER);
  check(`${label}: a task in Trash is never unread`, !members.has(other));

  await asServer({ 'x-actor-member-id': ashley, 'x-actor-via': 'api' });
  await db.query("UPDATE public.tasks SET title = 'Still hidden' WHERE id = $1", [hidden]);
  await actAs(db, MEMBER_USER);
  check(`${label}: nobody reads changes on a task they cannot see`,
    (await q('SELECT 1 FROM public.task_events WHERE task_id = $1', [hidden])).length === 0
      && !(await updatesFor(MEMBER_USER)).has(hidden));
  await actAs(db, MEMBER_USER);
  check(`${label}: nobody writes events by hand`,
    (await attempt(db, "INSERT INTO public.task_events (task_id, via, kind) VALUES ($1, 'app', 'edit')", [task])) !== null);
  check(`${label}: Mark all read refuses a huge list`,
    (await attempt(db, 'SELECT public.mark_tasks_seen(array_fill($1::uuid, ARRAY[1001]))', [task])) !== null);
}

async function main() {
  {
    const db = await createFullSchemaDatabase({ schemaSql: schemaBeforeMigration(MIGRATION) });
    await db.exec('RESET ROLE');
    // This migration and everything after it, to today's schema.
    await applyMigrationsFrom(db, MIGRATION);
    await run(db, 'migrated');
    await db.close();
  }
  const fresh = await createFullSchemaDatabase();
  await run(fresh, 'schema.sql');
  await fresh.close();

  if (failures.length) {
    console.error(`task unread: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`task unread: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
