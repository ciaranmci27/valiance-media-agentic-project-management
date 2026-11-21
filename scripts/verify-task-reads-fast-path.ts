/**
 * The task read fast path (20261117231500_task_reads_fast_path.sql), on the
 * whole schema in PGlite with RLS on: every kind of reader (owner, admin,
 * project member, assigned-only member, guest, someone outside the project)
 * sees exactly the same tasks, assignees, comments, checklist items, reviews
 * and blockers after the migration as before it, including tasks in Trash,
 * projects in Trash and subtasks; and the readers of every project's tasks go
 * through the fast path.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-task-reads-fast-path.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, schemaAt } from './full-schema-db';

const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261117231500_task_reads_fast_path.sql');
const TABLES = ['tasks', 'task_assignees', 'task_comments', 'task_acceptance_criteria', 'task_reviews', 'task_dependencies'];

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}

/** schema.sql before this change: the committed copy when it does not have the fast path yet. */
function schemaBefore(): string {
  const git = (args: string[]) => execFileSync('git', args, { cwd: join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const log = git(['log', '--format=%H', '--', 'supabase/migrations/20261117231500_task_reads_fast_path.sql']).trim().split('\n').filter(Boolean);
  const ref = log.length ? `${log[log.length - 1]}~1` : 'HEAD';
  return schemaAt(ref);
}

const users = { owner: randomUUID(), admin: randomUUID(), member: randomUUID(), assigned: randomUUID(), guest: randomUUID(), outsider: randomUUID() };

async function seed(db: PGlite): Promise<void> {
  await actAs(db, null);
  await db.exec('RESET ROLE'); // the database owner: auth.users is Supabase's
  for (const [name, id] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${name}@agency.example`]);
  }
  const member = async (user: string) => (await db.query<{ id: string }>('SELECT id FROM public.team_members WHERE auth_user_id = $1', [user])).rows[0].id;
  const ids = Object.fromEntries(await Promise.all(Object.entries(users).map(async ([name, user]) => [name, await member(user)])));
  const roles: Record<string, string> = { owner: 'owner', admin: 'admin', member: 'member', assigned: 'member', guest: 'guest', outsider: 'member' };
  for (const [name, role] of Object.entries(roles)) {
    await db.query("UPDATE public.team_members SET role = $1, status = 'active' WHERE id = $2", [role, ids[name]]);
  }
  // The assigned-only reader: tasks they are on, not every task in the project.
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    VALUES ($1, 'tasks.read', 'app', 'deny'), ($1, 'tasks.read_assigned', 'app', 'allow')`, [ids.assigned]);

  const project = async (name: string, deleted = false) => (await db.query<{ id: string }>(
    'INSERT INTO public.projects (name, deleted_at) VALUES ($1, $2) RETURNING id', [name, deleted ? new Date().toISOString() : null])).rows[0].id;
  const acme = await project('Acme');
  const globex = await project('Globex');
  const binned = await project('Binned', true);
  for (const name of ['member', 'assigned', 'guest']) {
    await db.query('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [acme, ids[name]]);
  }

  const task = async (projectId: string, title: string, extra: { deleted?: boolean; parent?: string; createdBy?: string } = {}) => (await db.query<{ id: string }>(
    'INSERT INTO public.tasks (project_id, title, deleted_at, parent_task_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [projectId, title, extra.deleted ? new Date().toISOString() : null, extra.parent ?? null, extra.createdBy ?? null])).rows[0].id;
  const tasks = [
    await task(acme, 'Acme plain'),
    await task(acme, 'Acme assigned'),
    await task(acme, 'Acme in Trash', { deleted: true }),
    await task(acme, 'Acme by the assigned reader', { createdBy: ids.assigned }),
    await task(globex, 'Globex plain'),
    await task(binned, 'Binned project task'),
  ];
  const parent = await task(acme, 'Acme parent');
  tasks.push(parent, await task(acme, 'Acme subtask', { parent }));
  // A parent in Trash hides its live subtask and everything on it.
  const binnedParent = await task(acme, 'Acme parent in Trash');
  const orphan = await task(acme, 'Acme subtask of a parent in Trash', { parent: binnedParent });
  tasks.push(binnedParent, orphan);
  await db.query('INSERT INTO public.task_assignees (task_id, member_id) VALUES ($1, $2), ($3, $2), ($4, $2)', [tasks[1], ids.assigned, parent, orphan]);
  for (const id of tasks) {
    await db.query('INSERT INTO public.task_comments (task_id, user_id, text) VALUES ($1, $2, $3)', [id, ids.owner, 'A comment']);
    await db.query('INSERT INTO public.task_acceptance_criteria (task_id, criterion, sort_order) VALUES ($1, $2, 0)', [id, 'Done when done']);
    await db.query("INSERT INTO public.task_reviews (task_id, round, verdict, summary) VALUES ($1, 1, 'approved', 'Fine')", [id]);
    await db.query('INSERT INTO public.task_assignees (task_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, ids.admin]);
  }
  await db.query('INSERT INTO public.task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2), ($3, $4), ($5, $2)', [tasks[0], tasks[1], tasks[4], tasks[5], orphan]);
  // Only the parent goes to Trash; its subtask stays as it was, hidden through it.
  await db.query('UPDATE public.tasks SET deleted_at = now() WHERE id = $1', [binnedParent]);
  const left = (await db.query<{ deleted_at: string | null }>('SELECT deleted_at FROM public.tasks WHERE id = $1', [orphan])).rows[0];
  if (left.deleted_at) throw new Error('setup: binning the parent also binned its subtask');
}

/** What each reader sees, table by table. */
async function visible(db: PGlite): Promise<Record<string, Record<string, string[]>>> {
  const seen: Record<string, Record<string, string[]>> = {};
  for (const [name, user] of Object.entries(users)) {
    await actAs(db, user);
    seen[name] = {};
    for (const table of TABLES) {
      const key = table === 'task_assignees' ? "task_id::text || ':' || member_id::text"
        : table === 'task_dependencies' ? "task_id::text || ':' || blocked_by_task_id::text" : 'id::text';
      seen[name][table] = (await db.query<{ k: string }>(`SELECT ${key} AS k FROM public.${table}`)).rows.map((row) => row.k).sort();
    }
  }
  await actAs(db, null);
  return seen;
}

async function main() {
  const db = await createFullSchemaDatabase({ schemaSql: schemaBefore() });
  await seed(db);
  const before = await visible(db);
  const migration = readFileSync(MIGRATION, 'utf8');
  await db.exec('RESET ROLE'); // migrations run as the database owner
  await db.exec(migration);
  await db.exec(migration); // applied twice: it must be repeatable
  const after = await visible(db);

  for (const name of Object.keys(users)) {
    for (const table of TABLES) {
      check(`${name} sees the same ${table}`, JSON.stringify(before[name][table]) === JSON.stringify(after[name][table]),
        { before: before[name][table].length, after: after[name][table].length });
    }
  }
  check('the setup is not trivial: the owner sees more tasks than the member, the member more than the assigned reader, the outsider none',
    before.owner.tasks.length > before.member.tasks.length && before.member.tasks.length > before.assigned.tasks.length
      && before.assigned.tasks.length > 0 && before.outsider.tasks.length === 0, Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.tasks.length])));
  check('Trash stays hidden: comments on a task in Trash, in a project in Trash or under a parent in Trash are visible to nobody',
    after.owner.task_comments.length === before.owner.task_comments.length && after.owner.task_comments.length === 6, after.owner.task_comments.length);

  // The fast path is the one taken by readers of every project's tasks, and only by them.
  const fast = async (user: string) => {
    await actAs(db, user);
    const answer = (await db.query<{ ok: boolean }>('SELECT public.can_read_all_tasks() AS ok')).rows[0].ok;
    await actAs(db, null);
    return answer;
  };
  check('owners and admins take the fast path; members, assigned readers and guests do not',
    await fast(users.owner) && await fast(users.admin) && !(await fast(users.member)) && !(await fast(users.assigned)) && !(await fast(users.guest)));

  // schema.sql carries the same policies the migration makes.
  const schema = readFileSync(join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8').replace(/\r/g, '');
  // The re-created policies come after the soft-delete helpers they call, and the helpers are defined once.
  const helpers = schema.indexOf('CREATE OR REPLACE FUNCTION public.task_is_live(');
  check('schema.sql mirrors the migration', TABLES.every((table) => {
    const at = schema.indexOf(`DROP POLICY IF EXISTS ${table}_select ON public.${table};\nCREATE POLICY ${table}_select`);
    return at > helpers && schema.slice(at, schema.indexOf(';', schema.indexOf('USING', at))).includes('can_read_all_tasks');
  }) && helpers > 0 && schema.split('CREATE OR REPLACE FUNCTION public.task_is_live(').length === 2
    && schema.split('CREATE OR REPLACE FUNCTION public.project_is_live(').length === 2);

  await db.close();
  if (failures.length) {
    console.error(`task reads fast path: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`task reads fast path: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
