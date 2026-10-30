/**
 * Subtasks through the real v1 API (withApi, supabase-js, a fake PostgREST
 * over PGlite): POST /tasks with parent_task_id makes a subtask in the
 * parent's project, last in its list, only under a task the key may manage;
 * GET shows a task's parent and subtasks and filters by parent or top level;
 * PATCH parent_task_id nests and promotes with the database's rules and the
 * project-move guards; the old /subtasks routes work on subtask tasks; a
 * parent in Trash takes its subtasks out of reach.
 *
 *   npm run -s test:subtasks
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function seed(db: PGlite) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION public.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string) =>
    (await q<{ id: string }>("INSERT INTO public.team_members (name, email, role) VALUES ($1, $2, 'agent') RETURNING id", [name, `${name}@example.com`]))[0].id;
  const ashley = await member('ashley');
  const jeff = await member('jeff');
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO public.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const apex = await project('Apex', [ashley, jeff]);
  const bright = await project('Brightside', [ashley]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO public.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    await q(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  // Ashley may manage every task; Jeff only what he is on.
  const ashleyKey = await key(ashley, ['tasks.read', 'tasks.create', 'tasks.manage_all', 'tasks.manage_assigned', 'projects.read', 'projects.read_all']);
  const jeffKey = await key(jeff, ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read']);
  const task = async (projectId: string, title: string, assignee?: string) => {
    const id = (await q<{ id: string }>('INSERT INTO public.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [projectId, title]))[0].id;
    if (assignee) await q('INSERT INTO public.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, assignee]);
    return id;
  };
  return {
    q, ashley, jeff, apex, bright, ashleyKey, jeffKey,
    launch: await task(apex, 'Launch site', jeff),
    pricing: await task(apex, 'Pricing page'),
    loose: await task(apex, 'Hero copy'),
    jeffsOwn: await task(apex, 'Alt text', jeff),
    elsewhere: await task(bright, 'Favicon'),
  };
}

type Answer = { status: number; body: { data?: Record<string, unknown> & Record<string, unknown>[]; error?: { message?: string }; meta?: { total?: number } } };

async function main() {
  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const list = await import('../src/app/api/v1/tasks/route');
    const one = await import('../src/app/api/v1/tasks/[id]/route');
    const legacy = await import('../src/app/api/v1/tasks/[id]/subtasks/route');
    const legacyOne = await import('../src/app/api/v1/tasks/[id]/subtasks/[subtaskId]/route');
    const legacyOrder = await import('../src/app/api/v1/tasks/[id]/subtasks/reorder/route');
    const reorder = await import('../src/app/api/v1/tasks/reorder/route');
    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>,
      method: string, path: string, params: Record<string, string>, body?: unknown, apiKey = s.ashleyKey): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json() };
    };
    const message = (answer: Answer) => answer.body.error?.message ?? '';
    const create = (body: unknown, key = s.ashleyKey) => call(list.POST, 'POST', '/api/v1/tasks', {}, body, key);
    const patch = (id: string, body: unknown, key = s.ashleyKey) => call(one.PATCH, 'PATCH', `/api/v1/tasks/${id}`, { id }, body, key);
    const get = (id: string, key = s.ashleyKey) => call(one.GET, 'GET', `/api/v1/tasks/${id}`, { id }, undefined, key);

    // --- Creating subtasks ---------------------------------------------------------
    const first = await create({ parent_task_id: s.launch, title: 'Copy approved' });
    const second = await create({ parent_task_id: s.launch, title: 'DNS cut over', due_date: '2026-11-02' });
    check('a subtask is created in its parent\'s project, without project_id',
      first.status === 201 && first.body.data?.project_id === s.apex && first.body.data?.parent_task_id === s.launch, first);
    check('each new subtask goes last', first.body.data?.sort_order === 0 && second.body.data?.sort_order === 1, [first.body.data?.sort_order, second.body.data?.sort_order]);
    const firstId = first.body.data!.id as string;
    const secondId = second.body.data!.id as string;
    const mismatch = await create({ parent_task_id: s.launch, project_id: s.bright, title: 'Wrong place' });
    check('a project that is not the parent\'s is refused', mismatch.status === 400 && message(mismatch).includes("parent task's project"), mismatch);
    const deep = await create({ parent_task_id: firstId, title: 'Too deep' });
    check('subtasks go one level deep', deep.status === 400 && message(deep).includes('one level deep'), deep);
    const neither = await create({ title: 'Nowhere' });
    check('a task needs a project or a parent', neither.status === 422, neither);
    const jeffs = await create({ parent_task_id: s.launch, title: 'Smoke test' }, s.jeffKey);
    check('a key on the parent can add subtasks to it', jeffs.status === 201, jeffs);
    const notJeffs = await create({ parent_task_id: s.pricing, title: 'Sneaky' }, s.jeffKey);
    check('but not to a task it is not on', notJeffs.status === 403, notJeffs);

    // --- Reading --------------------------------------------------------------------
    // (GET /tasks/:id embeds blockers through a named foreign key, which the
    // fake PostgREST does not serve; its subtasks come from the same helper.)
    const listedTasks = await call(list.GET, 'GET', `/api/v1/tasks?project_id=${s.apex}&top_level=true`, {});
    const launchRow = (listedTasks.body.data as unknown as { id: string; subtasks: { title: string; completed: boolean; status: string; task_id: string }[] }[])
      .find((t) => t.id === s.launch);
    const subtasks = launchRow?.subtasks ?? [];
    check('a task lists its subtasks in order, as tasks',
      subtasks.map((t) => t.title).join() === 'Copy approved,DNS cut over,Smoke test'
        && subtasks.every((t) => t.completed === false && t.status === 'todo' && t.task_id === s.launch), subtasks);
    const children = await call(list.GET, 'GET', `/api/v1/tasks?parent_task_id=${s.launch}`, {});
    check('the list filters by parent', children.body.meta?.total === 3, children.body.meta);
    const topLevel = await call(list.GET, 'GET', `/api/v1/tasks?top_level=true&project_id=${s.apex}`, {});
    check('top_level leaves subtasks out', (topLevel.body.data as unknown as { parent_task_id: string | null }[]).every((t) => t.parent_task_id === null)
      && topLevel.body.meta?.total === 4, topLevel.body.meta);

    // --- Working a subtask ------------------------------------------------------------
    const done = await patch(firstId, { status: 'done' }, s.jeffKey);
    check('a key on the parent can work its subtasks', done.status === 200 && done.body.data?.status === 'done', done);
    const moveAlone = await patch(firstId, { project_id: s.bright });
    check('a subtask cannot move projects on its own', moveAlone.status === 400 && message(moveAlone).includes("parent task's project"), moveAlone);

    // --- Nesting and promoting ----------------------------------------------------------
    const nest = await patch(s.loose, { parent_task_id: s.launch });
    check('PATCH parent_task_id nests a task, last', nest.status === 200 && nest.body.data?.parent_task_id === s.launch && nest.body.data?.sort_order === 3, nest);
    const promote = await patch(s.loose, { parent_task_id: null });
    check('and null makes it top-level', promote.status === 200 && promote.body.data?.parent_task_id === null, promote);
    const withChildren = await patch(s.launch, { parent_task_id: s.pricing });
    check('a task with subtasks cannot become one', withChildren.status === 400 && message(withChildren).includes('subtasks'), withChildren);
    const both = await patch(s.loose, { parent_task_id: s.launch, project_id: s.bright });
    check('parent and project together are refused', both.status === 400, both);
    const jeffNest = await patch(s.jeffsOwn, { parent_task_id: s.pricing }, s.jeffKey);
    check('a key can only nest under a task it may manage', jeffNest.status === 403, jeffNest);
    const jeffNestOk = await patch(s.jeffsOwn, { parent_task_id: s.launch, title: 'Alt text for every image' }, s.jeffKey);
    check('nesting with other changes applies both', jeffNestOk.status === 200 && jeffNestOk.body.data?.parent_task_id === s.launch
      && jeffNestOk.body.data?.title === 'Alt text for every image', jeffNestOk);
    const jeffPromote = await patch(firstId, { parent_task_id: null }, s.jeffKey);
    check('working a subtask through its parent does not stretch to promoting it', jeffPromote.status === 403, jeffPromote);
    const jeffPromoteOwn = await patch(s.jeffsOwn, { parent_task_id: null }, s.jeffKey);
    const jeffRenest = await patch(s.jeffsOwn, { parent_task_id: s.launch }, s.jeffKey);
    check('but a key on the subtask itself can', jeffPromoteOwn.status === 200 && jeffRenest.status === 200, [jeffPromoteOwn.status, jeffRenest.status]);
    const across = await patch(s.elsewhere, { parent_task_id: s.launch });
    check('nesting under another project\'s task moves it there', across.status === 200 && across.body.data?.project_id === s.apex, across);

    // --- The old subtask routes ----------------------------------------------------------
    const quick = await call(legacy.POST, 'POST', `/api/v1/tasks/${s.pricing}/subtasks`, { id: s.pricing }, { title: 'FAQ' });
    const quickId = quick.body.data?.id as string;
    check('POST /subtasks makes a subtask task, in the old shape',
      quick.status === 201 && quick.body.data?.task_id === s.pricing && quick.body.data?.completed === false, quick);
    const ticked = await call(legacyOne.PATCH, 'PATCH', `/api/v1/tasks/${s.pricing}/subtasks/${quickId}`, { id: s.pricing, subtaskId: quickId }, { completed: true });
    check('completed: true finishes it', ticked.status === 200 && ticked.body.data?.status === 'done' && ticked.body.data?.completed === true, ticked);
    const untick = await call(legacyOne.PATCH, 'PATCH', `/api/v1/tasks/${s.pricing}/subtasks/${quickId}`, { id: s.pricing, subtaskId: quickId }, { completed: false });
    check('completed: false reopens it to To Do', untick.body.data?.status === 'todo', untick);
    const foreign = await call(legacyOne.PATCH, 'PATCH', `/api/v1/tasks/${s.pricing}/subtasks/${firstId}`, { id: s.pricing, subtaskId: firstId }, { title: 'x' });
    check('a subtask of another task is not found there', foreign.status === 404, foreign);
    const legacyList = await call(legacy.GET, 'GET', `/api/v1/tasks/${s.launch}/subtasks`, { id: s.launch });
    check('GET /subtasks lists them', legacyList.body.meta?.total === 5, legacyList.body.meta);
    const order = [secondId, firstId];
    const ordered = await call(legacyOrder.PUT, 'PUT', `/api/v1/tasks/${s.launch}/subtasks/reorder`, { id: s.launch }, { subtask_ids: order });
    const afterOrder = await s.q<{ id: string; sort_order: number }>('SELECT id, sort_order FROM public.tasks WHERE id = ANY($1) ORDER BY sort_order', [order]);
    check('PUT /subtasks/reorder orders them', ordered.status === 200 && afterOrder.map((r) => r.id).join() === order.join(), afterOrder);
    const topBefore = JSON.stringify(await s.q('SELECT id, sort_order FROM public.tasks WHERE parent_task_id IS NULL ORDER BY id'));
    const moved = await call(reorder.POST, 'POST', '/api/v1/tasks/reorder', {}, { task_id: firstId, new_sort_order: 0 });
    const order2 = await s.q<{ id: string }>('SELECT id FROM public.tasks WHERE parent_task_id = $1 AND deleted_at IS NULL ORDER BY sort_order', [s.launch]);
    const topAfter = JSON.stringify(await s.q('SELECT id, sort_order FROM public.tasks WHERE parent_task_id IS NULL ORDER BY id'));
    check('reordering a subtask stays among its siblings',
      moved.status === 200 && order2[0]?.id === firstId && topBefore === topAfter, { status: moved.status, first: order2[0]?.id === firstId, top: topBefore === topAfter });
    const removed = await call(legacyOne.DELETE, 'DELETE', `/api/v1/tasks/${s.pricing}/subtasks/${quickId}`, { id: s.pricing, subtaskId: quickId });
    const pricingRead = await call(legacy.GET, 'GET', `/api/v1/tasks/${s.pricing}/subtasks`, { id: s.pricing });
    check('DELETE /subtasks/:id moves it to Trash', removed.status === 200 && pricingRead.body.meta?.total === 0, pricingRead.body.meta);

    // --- Trash ------------------------------------------------------------------------------
    const trashed = await call(one.DELETE, 'DELETE', `/api/v1/tasks/${s.launch}`, { id: s.launch });
    const hidden = await get(firstId);
    const listed = await call(list.GET, 'GET', `/api/v1/tasks?project_id=${s.apex}`, {});
    const ids = (listed.body.data as unknown as { id: string }[]).map((t) => t.id);
    check('a parent in Trash takes its subtasks out of reach', trashed.status === 200 && hidden.status === 404 && !ids.includes(firstId) && !ids.includes(secondId),
      { trashed: trashed.status, hidden: hidden.status, ids });
    const orphan = await create({ parent_task_id: s.launch, title: 'Late' });
    check('nothing joins a parent in Trash', orphan.status === 404, orphan);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`subtasks api: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`subtasks api: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
