// Exercises the atomic task save migration against a real Postgres (PGlite):
// create and patch in one call, lists left alone when NULL, cleared when empty,
// a failure part-way rolling the whole save back, unknown columns refused, and
// an RLS-denied update reported instead of passing as a save.
// Run: node --experimental-strip-types scripts/verify-atomic-task-save.ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = '../supabase/migrations/20260923235152_atomic_task_save.sql';

async function main() {
  const db = new PGlite();
  let checks = 0;
  const check = (actual: unknown, expected: unknown, label: string) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  const rejects = async (promise: Promise<unknown>, pattern: RegExp, label: string) => {
    await assert.rejects(promise, pattern, label);
    checks++;
  };
  const rows = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T,>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0];
  const save = async (id: string | null, task: object, assignees: string[] | null = null, criteria: string[] | null = null, blockers: string[] | null = null) =>
    (await one<{ result: { task: Record<string, unknown>; criteria: { criterion: string; satisfied: boolean }[] } }>(
      'SELECT public.save_task($1, $2::jsonb, $3::uuid[], $4::text[], $5::uuid[]) AS result',
      [id, JSON.stringify(task), assignees, criteria, blockers],
    )).result;

  const ana = randomUUID();
  const ben = randomUUID();
  const project = randomUUID();

  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.team_members (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.projects (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES public.projects(id),
      title text NOT NULL,
      description text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'todo',
      priority text NOT NULL DEFAULT 'medium',
      due_date date,
      tags text[] NOT NULL DEFAULT '{}',
      sort_order int NOT NULL DEFAULT 0,
      ai_readiness text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.task_assignees (
      task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
      member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, member_id)
    );
    CREATE TABLE public.task_acceptance_criteria (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
      criterion text NOT NULL,
      satisfied boolean NOT NULL DEFAULT false,
      sort_order int NOT NULL DEFAULT 0
    );
    CREATE TABLE public.task_dependencies (
      task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
      blocked_by_task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, blocked_by_task_id),
      CHECK (task_id <> blocked_by_task_id)
    );
  `);
  await db.query("INSERT INTO team_members VALUES ($1, 'Ana'), ($2, 'Ben')", [ana, ben]);
  await db.query("INSERT INTO projects VALUES ($1, 'Client')", [project]);

  const migration = await readFile(new URL(MIGRATION, import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration); // safe to re-run

  // Create: row, assignees, criteria and blockers together.
  const blocker = await save(null, { project_id: project, title: 'Blocker' });
  const created = await save(
    null,
    { project_id: project, title: 'Launch', tags: ['web', 'seo'], due_date: '2026-10-01', status: 'todo' },
    [ana, ana],
    ['Loads fast', 'Passes review'],
    [String(blocker.task.id)],
  );
  const taskId = String(created.task.id);
  check(created.task.title, 'Launch', 'created title');
  check(created.task.tags, ['web', 'seo'], 'json array becomes text[]');
  check(created.criteria.map(c => c.criterion), ['Loads fast', 'Passes review'], 'criteria in order');
  check((await rows('SELECT member_id FROM task_assignees WHERE task_id = $1', [taskId])).length, 1, 'duplicate assignee collapsed');
  check((await rows('SELECT 1 FROM task_dependencies WHERE task_id = $1', [taskId])).length, 1, 'blocker saved');

  // Patch one column: everything else, and every list, stays as it was.
  await db.query('UPDATE task_acceptance_criteria SET satisfied = true WHERE task_id = $1', [taskId]);
  const patched = await save(taskId, { title: 'Launch v2' });
  check(patched.task.title, 'Launch v2', 'patched title');
  check(patched.task.status, 'todo', 'status untouched by a title patch');
  check(patched.task.tags, ['web', 'seo'], 'tags untouched');
  check(patched.criteria.every(c => c.satisfied), true, 'criteria (and satisfied flags) untouched when NULL');
  check((await rows('SELECT 1 FROM task_assignees WHERE task_id = $1', [taskId])).length, 1, 'assignees untouched when NULL');

  // Replace a list; clear another with an empty array.
  await save(taskId, {}, [ben], null, []);
  check((await rows<{ member_id: string }>('SELECT member_id FROM task_assignees WHERE task_id = $1', [taskId])).map(r => r.member_id), [ben], 'assignees replaced');
  check((await rows('SELECT 1 FROM task_dependencies WHERE task_id = $1', [taskId])).length, 0, 'empty list clears blockers');

  // A failure after the row update rolls back the row AND the list delete.
  await rejects(save(taskId, { title: 'Should not stick', status: 'done' }, [randomUUID()]), /foreign key/i, 'unknown assignee fails');
  const after = await one<{ title: string; status: string }>('SELECT title, status FROM tasks WHERE id = $1', [taskId]);
  check(after, { title: 'Launch v2', status: 'todo' }, 'task row rolled back');
  check((await rows<{ member_id: string }>('SELECT member_id FROM task_assignees WHERE task_id = $1', [taskId])).map(r => r.member_id), [ben], 'assignees survive the failed save');

  // A failed create leaves no task behind.
  const before = (await rows('SELECT 1 FROM tasks')).length;
  await rejects(save(null, { project_id: project, title: 'Orphan' }, [randomUUID()]), /foreign key/i, 'create with bad assignee fails');
  check((await rows('SELECT 1 FROM tasks')).length, before, 'no half-created task');

  await rejects(save(taskId, { not_a_column: 1 }), /unknown task column "not_a_column"/, 'unknown column refused');
  await rejects(save(null, {}), /needs its columns/, 'empty create refused');
  await rejects(save(randomUUID(), { title: 'x' }), /not found or not permitted/, 'missing task reported');

  // Criteria full replace resets satisfied flags, as documented.
  const replaced = await save(taskId, {}, null, ['Only one']);
  check(replaced.criteria.map(c => [c.criterion, c.satisfied]), [['Only one', false]], 'criteria replaced and reset');

  // RLS: a denied update is zero rows, and that is an error, not a save.
  await db.exec(`
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
    ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tasks_read ON public.tasks FOR SELECT TO authenticated USING (true);
    CREATE POLICY tasks_no_update ON public.tasks FOR UPDATE TO authenticated USING (false);
    SET ROLE authenticated;
  `);
  await rejects(save(taskId, { title: 'Sneaky' }), /not found or not permitted/, 'RLS-denied update raises');
  await db.exec('RESET ROLE;');
  check((await one<{ title: string }>('SELECT title FROM tasks WHERE id = $1', [taskId])).title, 'Launch v2', 'denied update changed nothing');

  // anon cannot call it at all.
  await db.exec('SET ROLE anon;');
  await rejects(save(taskId, { title: 'anon' }), /permission denied/i, 'anon has no execute');
  await db.exec('RESET ROLE;');

  console.log(`atomic task save: ${checks} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
