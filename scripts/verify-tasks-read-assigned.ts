// Exercises the assigned-only task visibility migration against a real
// Postgres (PGlite) with RLS on: a full reader sees the project's tasks, an
// assigned-only reader sees only tasks assigned to or created by them (and
// only those tasks' child rows), nobody sees outside their projects, and an
// assigned-only reader can still create a task through INSERT ... RETURNING.
// Run: node --experimental-strip-types scripts/verify-tasks-read-assigned.ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = '../supabase/migrations/20260924103110_tasks_read_assigned.sql';

async function main() {
  const db = new PGlite();
  let checks = 0;
  const check = (actual: unknown, expected: unknown, label: string) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  const titles = async (sql: string) =>
    (await db.query<{ title: string }>(sql)).rows.map(row => row.title).sort();

  const full = randomUUID();
  const scoped = randomUUID();
  const outsider = randomUUID();
  const project = randomUUID();
  const otherProject = randomUUID();

  // The access helpers as the app defines them, reduced to what the policies
  // read: who is acting, their permissions, and their project memberships.
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.acting (member_id uuid);
    CREATE TABLE public.grants (member_id uuid, permission_key text);
    CREATE TABLE public.project_members (project_id uuid, member_id uuid);
    CREATE FUNCTION public.current_team_member_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT member_id FROM public.acting LIMIT 1 $$;
    CREATE FUNCTION public.has_permission(p_key text, p_channel text DEFAULT 'app') RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.grants WHERE member_id = public.current_team_member_id() AND permission_key = p_key) $$;
    CREATE FUNCTION public.can_access_project(p_project_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.project_members WHERE project_id = p_project_id AND member_id = public.current_team_member_id()) $$;

    CREATE TABLE public.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL,
      title text NOT NULL,
      created_by uuid
    );
    CREATE TABLE public.task_assignees (task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE, member_id uuid, PRIMARY KEY (task_id, member_id));
    CREATE TABLE public.task_subtasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE, title text NOT NULL);

    -- The pre-migration policy and helper, as the access migration left them.
    CREATE FUNCTION public.can_access_task(p_task_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.tasks WHERE id = p_task_id AND public.can_access_project(project_id)) $$;
    ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.task_subtasks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated
      USING (public.has_permission('tasks.read') AND public.can_access_project(project_id));
    CREATE POLICY tasks_insert ON public.tasks FOR INSERT TO authenticated
      WITH CHECK (public.has_permission('tasks.create') AND public.can_access_project(project_id)
        AND created_by = public.current_team_member_id());
    CREATE POLICY task_subtasks_select ON public.task_subtasks FOR SELECT TO authenticated
      USING (public.can_access_task(task_id));
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT, INSERT ON public.tasks, public.task_subtasks, public.task_assignees TO authenticated;
    GRANT SELECT ON public.acting TO authenticated;
  `);

  await db.query('INSERT INTO grants VALUES ($1, $3), ($2, $4), ($2, $5), ($1, $5)', [full, scoped, 'tasks.read', 'tasks.read_assigned', 'tasks.create']);
  await db.query('INSERT INTO grants VALUES ($1, $2)', [outsider, 'tasks.read']);
  await db.query('INSERT INTO project_members VALUES ($1, $2), ($1, $3), ($4, $2)', [project, full, scoped, otherProject]);
  // otherProject has only `full` on it; `outsider` is on nothing.

  const mine = randomUUID();
  const theirs = randomUUID();
  const madeByScoped = randomUUID();
  const elsewhere = randomUUID();
  await db.query(
    `INSERT INTO tasks (id, project_id, title, created_by) VALUES
      ($1, $5, 'Assigned to scoped', $6), ($2, $5, 'Someone else''s', $6),
      ($3, $5, 'Created by scoped', $7), ($4, $8, 'Other project', $6)`,
    [mine, theirs, madeByScoped, elsewhere, project, full, scoped, otherProject],
  );
  await db.query('INSERT INTO task_assignees VALUES ($1, $2), ($3, $4)', [mine, scoped, theirs, full]);
  await db.query("INSERT INTO task_subtasks (task_id, title) VALUES ($1, 'Mine sub'), ($2, 'Theirs sub')", [mine, theirs]);

  const actAs = async (memberId: string) => {
    await db.exec('RESET ROLE; DELETE FROM public.acting;');
    await db.query('INSERT INTO public.acting VALUES ($1)', [memberId]);
    await db.exec('SET ROLE authenticated;');
  };

  // Before the migration, tasks.read_assigned grants nothing.
  await actAs(scoped);
  check(await titles('SELECT title FROM tasks'), [], 'pre-migration: read_assigned alone sees nothing');

  await db.exec('RESET ROLE;');
  const migration = await readFile(new URL(MIGRATION, import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration); // safe to re-run

  await actAs(full);
  check(
    await titles('SELECT title FROM tasks'),
    ['Assigned to scoped', 'Created by scoped', 'Other project', "Someone else's"],
    'full reader: every task in their projects',
  );
  check(await titles('SELECT title FROM task_subtasks'), ['Mine sub', 'Theirs sub'], 'full reader: every subtask');

  await actAs(scoped);
  check(await titles('SELECT title FROM tasks'), ['Assigned to scoped', 'Created by scoped'], 'scoped: assigned or created only');
  check(await titles('SELECT title FROM task_subtasks'), ['Mine sub'], 'scoped: child rows follow the task');
  const inserted = await db.query<{ id: string }>(
    "INSERT INTO tasks (project_id, title, created_by) VALUES ($1, 'New by scoped', $2) RETURNING id",
    [project, scoped],
  );
  check(inserted.rows.length, 1, 'scoped: can create and read back its own new task');

  await actAs(outsider);
  check(await titles('SELECT title FROM tasks'), [], 'outsider: no project, no tasks');

  await db.exec('RESET ROLE;');
  console.log(`tasks read assigned: ${checks} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
