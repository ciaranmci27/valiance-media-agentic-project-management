import type { Harness } from './harness';

/**
 * Projects, goals and brief entries: update_project reports what it left
 * alone and keeps budget history, archive round-trips, goals and brief
 * entries change over MCP as the app changes them, and the portal tools
 * never show the client's link token or PIN.
 */
export async function projectsArea(h: Harness) {
  const { q, key, call, tool, check, members } = h;
  const project = await import('../../src/app/api/v1/projects/[id]/route');

  const P = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Northwind Rebrand') RETURNING id"))[0].id;
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2), ($1, $3)', [P, members.member, members.agent]);
  const ownerKey = await key(members.owner, ['projects.read', 'projects.read_all', 'projects.manage', 'project_members.manage', 'billing.manage',
    'goals.read', 'goals.manage', 'project_context.read', 'project_context.manage', 'contacts.read', 'contacts.manage', 'portal.read', 'portal.manage']);
  // Without billing.manage: billing fields are left alone, and now the answer says so.
  const plainKey = await key(members.owner, ['projects.read', 'projects.read_all', 'projects.manage']);
  const agentKey = await key(members.agent, ['projects.read', 'project_context.read', 'project_context.manage', 'goals.read', 'goals.manage', 'tasks.read']);

  // -- update_project -------------------------------------------------------
  const plain = await call(project.PATCH, plainKey, 'PATCH', `/api/v1/projects/${P}`, { id: P }, { name: 'Northwind Rebrand 2027', budget_value: 120, budget_type: 'hours' });
  check('projects: without billing.manage the name changes and the budget is left alone, named in meta.ignored_fields',
    plain.status === 200 && plain.json.data?.name === 'Northwind Rebrand 2027' && plain.json.data?.budget_value === null
    && JSON.stringify(plain.json.meta?.ignored_fields?.map((f: { field: string }) => f.field).sort()) === JSON.stringify(['budget_type', 'budget_value'])
    && plain.json.meta.ignored_fields.every((f: { needs: string }) => f.needs === 'billing.manage'), plain.json);
  const plainMembers = await call(project.PATCH, plainKey, 'PATCH', `/api/v1/projects/${P}`, { id: P }, { member_ids: [members.member] });
  check('projects: replacing the people needs project_members.manage', plainMembers.status === 403, plainMembers.json);

  const budget = await tool(ownerKey, 'update_project', { project_id: P, budget_type: 'hours', budget_value: 80, member_ids: [members.member, members.admin, members.agent] });
  check('projects mcp: update_project sets the budget and the people', budget.listed && budget.result.ok === true && Number(budget.result.data?.budget_value) === 80
    && !budget.result.meta?.ignored_fields, budget.result);
  const history = await q<{ new_budget_type: string | null; new_budget_value: string | null }>(
    'SELECT * FROM pm.project_budget_history WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1', [P]);
  check('projects: the budget change is kept in budget history', history.length === 1 && Number((history[0] as Record<string, unknown>).new_budget_value ?? (history[0] as Record<string, unknown>).new_value) === 80, history);
  const people = (await q<{ member_id: string }>('SELECT member_id FROM pm.project_members WHERE project_id = $1 ORDER BY member_id', [P])).map((r) => r.member_id).sort();
  check('projects: the people are replaced as sent', JSON.stringify(people) === JSON.stringify([members.admin, members.member, members.agent].sort()), people);
  const agentUpdate = await tool(agentKey, 'update_project', { project_id: P, name: 'Hijacked' });
  check('projects mcp: an agent without projects.manage neither sees nor runs update_project', !agentUpdate.listed && agentUpdate.result.ok !== true, agentUpdate.result);

  const archived = await tool(ownerKey, 'archive_project', { project_id: P });
  check('projects mcp: archive_project archives it', archived.result.ok === true && !!(await q<{ archived_at: string | null }>('SELECT archived_at FROM pm.projects WHERE id = $1', [P]))[0].archived_at, archived.result);
  const unarchived = await tool(ownerKey, 'unarchive_project', { project_id: P });
  check('projects mcp: unarchive_project brings it back', unarchived.result.ok === true && (await q<{ archived_at: string | null }>('SELECT archived_at FROM pm.projects WHERE id = $1', [P]))[0].archived_at === null, unarchived.result);

  // -- Goals ------------------------------------------------------------------
  const goal = await tool(ownerKey, 'create_project_goal', { project_id: P, title: 'Launch the new site' });
  const goalId = goal.result.data?.id as string;
  check('goals mcp: create_project_goal adds it', goal.result.ok === true && !!goalId, goal.result);
  const achieved = await tool(ownerKey, 'update_project_goal', { project_id: P, goal_id: goalId, status: 'achieved' });
  check('goals mcp: update_project_goal marks it achieved', achieved.result.ok === true
    && (await q<{ status: string }>('SELECT status FROM pm.project_goals WHERE id = $1', [goalId]))[0].status === 'achieved', achieved.result);
  const archivedGoal = await tool(ownerKey, 'archive_project_goal', { project_id: P, goal_id: goalId });
  check('goals mcp: archive_project_goal archives it', archivedGoal.result.ok === true && archivedGoal.result.data?.archived === true, archivedGoal.result);

  // -- Brief entries ------------------------------------------------------------
  const added = await tool(agentKey, 'add_context', { scope_type: 'project', scope_id: P, content: 'Use the navy palette from the brand book.', section: 'rules' });
  const entryId = added.result.data?.id as string;
  check('brief: the agent adds a project brief entry (written by an agent)', added.result.ok === true && !!entryId, added.result);
  const listed = await tool(ownerKey, 'list_context', { scope_type: 'project', scope_id: P });
  check('brief mcp: list_context reads the project brief with the entry', listed.result.ok === true && JSON.stringify(listed.result.data).includes(entryId), listed.result);
  const moved = await tool(ownerKey, 'update_context_entry', { entry_id: entryId, section: 'decisions', pinned: true, checked: true });
  const row = (await q<{ section: string | null; pinned: boolean; source: string | null }>('SELECT * FROM pm.project_context WHERE id = $1', [entryId]))[0] as Record<string, unknown>;
  check('brief mcp: update_context_entry moves, pins and marks it checked', moved.result.ok === true && row.section === 'decisions' && row.pinned === true, { result: moved.result, row });
  const empty = await tool(ownerKey, 'update_context_entry', { entry_id: entryId });
  check('brief mcp: an update with nothing to change is refused before any route', empty.result.ok !== true && empty.result.status === 422, empty.result);
  const removed = await tool(ownerKey, 'archive_context_entry', { entry_id: entryId });
  check('brief mcp: archive_context_entry archives it', removed.result.ok === true && removed.result.data?.archived === true, removed.result);

  // -- Portal: never the token or PIN ----------------------------------------------
  await q("INSERT INTO pm.portal_settings (project_id, token, enabled, pin) VALUES ($1, 'p-secret-token-123', true, '4321')", [P]);
  const portalRead = await tool(ownerKey, 'get_portal_settings', { project_id: P });
  check('portal mcp: get_portal_settings shows the switches but never the token or PIN', portalRead.result.ok === true && portalRead.result.data?.enabled === true
    && portalRead.result.data?.has_pin === true && !JSON.stringify(portalRead.result).includes('p-secret-token-123') && !JSON.stringify(portalRead.result).includes('4321'), portalRead.result);
  const portalPin = await tool(ownerKey, 'update_portal_settings', { project_id: P, pin: '0000' });
  check('portal mcp: a tool cannot set the PIN', portalPin.result.ok !== true && portalPin.result.status === 422, portalPin.result);
  const update = await tool(ownerKey, 'post_portal_update', { project_id: P, title: 'Homepage design approved' });
  check('portal mcp: post_portal_update posts for the client', update.result.ok === true
    && (await q<{ n: number }>("SELECT count(*)::int AS n FROM pm.portal_updates WHERE project_id = $1 AND title = 'Homepage design approved'", [P]))[0].n === 1, update.result);
}
