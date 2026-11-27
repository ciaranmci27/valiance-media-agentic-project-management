import type { Harness } from './harness';

/** The smaller task, group, agent and time tools: each calls its existing route with its permission. */
export async function workArea(h: Harness) {
  const { q, key, tool, check, members } = h;
  const P = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Contoso Intranet') RETURNING id"))[0].id;
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [P, members.agent]);
  const T = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Set up the staff directory') RETURNING id", [P]))[0].id;
  await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [T, members.agent]);
  const S1 = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, parent_task_id, title, sort_order) VALUES ($1, $2, 'Import people', 0) RETURNING id", [P, T]))[0].id;
  const S2 = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, parent_task_id, title, sort_order) VALUES ($1, $2, 'Add photos', 1) RETURNING id", [P, T]))[0].id;
  const agentKey = await key(members.agent, ['tasks.read', 'tasks.manage_assigned', 'projects.read']);
  const ownerKey = await key(members.owner, ['groups.manage', 'team.read', 'tasks.read', 'tasks.manage_all', 'projects.read', 'projects.read_all']);

  const reordered = await tool(agentKey, 'reorder_subtasks', { task_id: T, subtask_ids: [S2, S1] });
  const order = (await q<{ id: string }>('SELECT id FROM pm.tasks WHERE parent_task_id = $1 ORDER BY sort_order', [T])).map((r) => r.id);
  check('work mcp: the assignee reorders the subtasks', reordered.listed && reordered.result.ok === true && JSON.stringify(order) === JSON.stringify([S2, S1]), { result: reordered.result, order });
  const boardMove = await tool(agentKey, 'reorder_task', { task_id: T, new_sort_order: 0 });
  check('work mcp: moving on the board needs tasks.manage_all (not listed, refused)', !boardMove.listed && boardMove.result.ok !== true, boardMove.result);

  const G = (await q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Design crew', 'design-crew') RETURNING id"))[0].id;
  await q("INSERT INTO pm.group_members (group_id, member_id, role) VALUES ($1, $2, 'member')", [G, members.member]);
  const promoted = await tool(ownerKey, 'set_group_member_role', { group_id: G, member_id: members.member, role: 'lead' });
  check('work mcp: an Owner makes a group member its lead', promoted.result.ok === true
    && (await q<{ role: string }>('SELECT role FROM pm.group_members WHERE group_id = $1 AND member_id = $2', [G, members.member]))[0].role === 'lead', promoted.result);
  const agentPromote = await tool(agentKey, 'set_group_member_role', { group_id: G, member_id: members.member, role: 'member' });
  check('work mcp: an agent without groups.manage cannot', !agentPromote.listed && agentPromote.result.ok !== true, agentPromote.result);

  const roles = await tool(ownerKey, 'list_agent_roles', {});
  check('work mcp: list_agent_roles answers the roles', roles.result.ok === true && Array.isArray(roles.result.data?.roles ?? roles.result.data), roles.result);
}
