import type { Harness } from './harness';

/**
 * Trash: a key lists and restores exactly what its member could move to
 * Trash over the API; restore puts the record back as it was, a blocked
 * restore says what comes first, and MCP calls the same routes.
 */
export async function trashArea(h: Harness) {
  const { q, key, call, tool, check, members } = h;
  const trash = await import('../../src/app/api/v1/trash/route');
  const restore = await import('../../src/app/api/v1/trash/[type]/[recordId]/restore/route');
  const task = await import('../../src/app/api/v1/tasks/[id]/route');
  const project = await import('../../src/app/api/v1/projects/[id]/route');

  const P = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Trash Co') RETURNING id"))[0].id;
  const P2 = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Elsewhere Inc') RETURNING id"))[0].id;
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [P, members.member]);
  const T = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Write the welcome email') RETURNING id", [P]))[0].id;
  const T2 = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Secret roadmap') RETURNING id", [P2]))[0].id;

  const ownerKey = await key(members.owner, ['projects.read', 'projects.read_all', 'projects.manage', 'tasks.read', 'tasks.manage_all']);
  // A member's key: tasks.manage_all on the key, but the member role does not hold it on the api channel.
  const memberKey = await key(members.member, ['projects.read', 'tasks.read', 'tasks.manage_all', 'tasks.manage_assigned']);

  await call(task.DELETE, ownerKey, 'DELETE', `/api/v1/tasks/${T}`, { id: T });
  await call(task.DELETE, ownerKey, 'DELETE', `/api/v1/tasks/${T2}`, { id: T2 });

  const listed = await call(trash.GET, ownerKey, 'GET', '/api/v1/trash?types=tasks');
  const ids = (listed.json.data ?? []).map((row: { id: string }) => row.id);
  check('trash: the owner lists both trashed tasks with label and who deleted them', listed.status === 200 && ids.includes(T) && ids.includes(T2)
    && listed.json.data.find((row: { id: string }) => row.id === T)?.label === 'Write the welcome email'
    && listed.json.data.find((row: { id: string }) => row.id === T)?.deleted_by === members.owner, listed.json);
  const memberList = await call(trash.GET, memberKey, 'GET', '/api/v1/trash');
  check('trash: a member whose role cannot delete tasks lists none of them', memberList.status === 200
    && !(memberList.json.data ?? []).some((row: { id: string }) => row.id === T || row.id === T2), memberList.json);
  const badType = await call(trash.GET, ownerKey, 'GET', '/api/v1/trash?types=passwords');
  check('trash: an unknown type is a 400', badType.status === 400, badType.json);

  const refused = await call(restore.POST, memberKey, 'POST', `/api/v1/trash/tasks/${T}/restore`, { type: 'tasks', recordId: T });
  check('trash: a member may not restore what they could not delete (404, nothing confirmed)', refused.status === 404 && refused.json.error?.details?.reason === 'not_in_trash', refused.json);
  check('trash: and it stays in Trash', !!(await q<{ deleted_at: string | null }>('SELECT deleted_at FROM pm.tasks WHERE id = $1', [T]))[0].deleted_at);

  const restored = await call(restore.POST, ownerKey, 'POST', `/api/v1/trash/tasks/${T}/restore`, { type: 'tasks', recordId: T });
  check('trash: the owner restores the task', restored.status === 200 && restored.json.data?.restored === true && restored.json.data?.record_type === 'tasks', restored.json);
  const back = (await q<{ deleted_at: string | null; title: string }>('SELECT deleted_at, title FROM pm.tasks WHERE id = $1', [T]))[0];
  check('trash: the task is back as it was', back.deleted_at === null && back.title === 'Write the welcome email', back);
  const again = await call(restore.POST, ownerKey, 'POST', `/api/v1/trash/tasks/${T}/restore`, { type: 'tasks', recordId: T });
  check('trash: restoring a live record is 404', again.status === 404, again.json);

  // A task whose project is in Trash: the project comes first.
  await call(task.DELETE, ownerKey, 'DELETE', `/api/v1/tasks/${T}`, { id: T });
  await call(project.DELETE, ownerKey, 'DELETE', `/api/v1/projects/${P}`, { id: P });
  const blocked = await call(restore.POST, ownerKey, 'POST', `/api/v1/trash/tasks/${T}/restore`, { type: 'tasks', recordId: T });
  check('trash: a task in a trashed project is 409, saying what comes first', blocked.status === 409 && /project/i.test(blocked.json.error?.message ?? ''), blocked.json);
  const projectBack = await call(restore.POST, ownerKey, 'POST', `/api/v1/trash/projects/${P}/restore`, { type: 'projects', recordId: P });
  check('trash: a project in Trash restores (its id is not taken for a live project)', projectBack.status === 200, projectBack.json);

  // MCP: the same routes.
  const listedOver = await tool(ownerKey, 'list_trash', { types: ['tasks'] });
  check('trash mcp: list_trash is listed for the owner key and lists the task', listedOver.listed && listedOver.result.ok === true
    && (listedOver.result.data ?? []).some((row: { id: string }) => row.id === T), listedOver.result);
  const restoredOver = await tool(ownerKey, 'restore_from_trash', { record_type: 'tasks', id: T });
  check('trash mcp: restore_from_trash brings it back', restoredOver.result.ok === true && restoredOver.result.data?.restored === true, restoredOver.result);
  const credentialOver = await tool(ownerKey, 'restore_from_trash', { record_type: 'project_credentials', id: T });
  check('trash mcp: credentials are not restorable through a tool', credentialOver.result.ok !== true && credentialOver.result.status === 422, credentialOver.result);

  await trashListCost(h, P, P2);
}

/**
 * Review of wave 3, finding 7: listing Trash reads rows and reach in batches,
 * so a page costs a bounded number of queries, and answers exactly what the
 * one-row-at-a-time check answers (the same check restore uses).
 */
async function trashListCost(h: Harness, P: string, P2: string) {
  const { q, check, members } = h;
  const { getServiceClient } = await import('../../src/lib/api/supabase-service');
  const { resolveMemberAccess } = await import('../../src/lib/api/access');
  const { listTrashForApi, apiMayTrash } = await import('../../src/lib/api/trash-api');
  const { TRASH_TABLES } = await import('../../src/lib/supabase/trash');
  type Loose = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a counting wrapper over the client
  const base = getServiceClient();
  let queries = 0;
  const counted = new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'from' || prop === 'rpc') return (...args: Loose[]) => { queries += 1; return (value as Loose).apply(target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as typeof base;

  // A mixed Trash: subtasks under a task the member is on (in and out of reach), comments by the member and by others, reminders with and without a task.
  const one = async (sql: string, params: unknown[]) => (await q<{ id: string }>(sql, params))[0].id;
  const parentIn = await one("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Launch plan') RETURNING id", [P]);
  const parentOut = await one("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Other plan') RETURNING id", [P2]);
  await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $3), ($2, $3)', [parentIn, parentOut, members.member]);
  for (let i = 0; i < 12; i += 1) {
    const project = i % 3 === 0 ? P2 : P;
    const parent = project === P ? parentIn : parentOut;
    await q("INSERT INTO pm.tasks (project_id, parent_task_id, title, deleted_at, deleted_by) VALUES ($1, $2, $3, now() - make_interval(mins => $4), $5)", [project, parent, `Step ${i}`, i, members.owner]);
    await q("INSERT INTO pm.task_comments (task_id, user_id, text, deleted_at, deleted_by) VALUES ($1, $2, $3, now() - make_interval(mins => $4), $2)", [parent, i % 2 ? members.member : members.owner, `Note ${i}`, 100 + i]);
    await q("INSERT INTO pm.reminders (owner_id, title, task_id, deleted_at, deleted_by) VALUES ($1, $2, $3, now() - make_interval(mins => $4), $1)", [i % 4 === 3 ? members.owner : members.member, `Remind ${i}`, i % 2 ? parent : null, 200 + i]);
  }

  const reference = async (caller: Parameters<typeof listTrashForApi>[0], limit: number) => {
    const { data } = await base.rpc('list_trash', { p_types: null, p_limit: 2000 });
    const items = ((data ?? []) as Loose[]).sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
    const out: Loose[] = [];
    for (const item of items) {
      if (out.length >= limit) break;
      if (!TRASH_TABLES.includes(item.record_type)) continue;
      const { data: row } = await base.from(item.record_type).select('*').eq('id', item.id).maybeSingle();
      if (row && await apiMayTrash({ ...caller, service: base }, item.record_type, row as Loose)) out.push(item);
    }
    return out;
  };
  const scopes = ['projects.read', 'projects.read_all', 'projects.manage', 'tasks.read', 'tasks.manage_all', 'tasks.manage_assigned', 'reminders.manage_own'];
  for (const [who, memberId] of [['owner', members.owner], ['member', members.member]] as const) {
    const caller = { service: counted, access: (await resolveMemberAccess(base, memberId))!, scopes, memberId };
    for (const limit of [500, 5]) {
      const before = await reference(caller, limit);
      queries = 0;
      const after = await listTrashForApi(caller, null, limit);
      check(`trash list: ${who}, limit ${limit}: the batched list answers exactly what the row-by-row check does (${after.length} of them)`,
        JSON.stringify(after) === JSON.stringify(before) && before.length > 0, { before: before.map((i: Loose) => i.label), after: after.map((i) => i.label) });
      if (limit === 500) check(`trash list: ${who}: a page of ${before.length} rows costs a bounded number of queries (${queries})`, queries <= 12, queries);
    }
  }
}
