import type { Handler, Harness, Json } from './harness';

/** Route modules typed with their own params, read as the harness calls them. */
const routes = <M extends object>(module: M) => module as unknown as Record<keyof M, Handler>;
const reason = (json: Json) => json.error?.details?.reason;

/**
 * Assistants and chat connections: an Owner's key switches assistants and
 * names them, reads every assistant's status, binds a personal agent, edits
 * and removes a setup, and manages chat connections (never seeing a secret);
 * everyone else is refused. A person's own key reads and changes their own
 * assistant, undoes its work and lists their personal agents; an agent is
 * refused there. MCP calls the same routes. Workspace settings changed here
 * are put back at the end.
 */
export async function assistantsArea(h: Harness) {
  const { q, key, call, tool, toolNames, check, members } = h;
  const settings = routes(await import('../../src/app/api/v1/assistants/settings/route'));
  const status = await import('../../src/app/api/v1/assistants/status/route');
  const bind = routes(await import('../../src/app/api/v1/assistants/bind/route'));
  const setup = routes(await import('../../src/app/api/v1/assistant-setups/[id]/route'));
  const me = routes(await import('../../src/app/api/v1/me/assistant/route'));
  const undo = routes(await import('../../src/app/api/v1/me/assistant/undo/route'));
  const activity = await import('../../src/app/api/v1/me/assistant/activity/route');
  const personalAgents = await import('../../src/app/api/v1/me/personal-agents/route');
  const connections = await import('../../src/app/api/v1/chat/connections/route');
  const connection = routes(await import('../../src/app/api/v1/chat/connections/[id]/route'));
  const connectionAgents = routes(await import('../../src/app/api/v1/chat/connections/[id]/agents/route'));
  const channels = routes(await import('../../src/app/api/v1/chat/connections/[id]/channels/route'));
  const channel = routes(await import('../../src/app/api/v1/chat/connections/[id]/channels/[channelId]/route'));

  const before = (await q<{ assistants_enabled: boolean; assistant_label: string | null }>('SELECT assistants_enabled, assistant_label FROM pm.business_settings LIMIT 1'))[0];
  // An admin who holds team.manage on the API too, so the refusal below is the Owner rule, not a missing permission.
  await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'team.manage', 'api', 'allow')
    ON CONFLICT (member_id, permission_key, access_channel) DO UPDATE SET effect = 'allow'`, [members.admin]);
  try {
    const ownerKey = await key(members.owner, ['team.manage', 'assistants.provision', 'tasks.read', 'tasks.manage_assigned']);
    const adminKey = await key(members.admin, ['team.manage', 'tasks.read', 'tasks.manage_assigned']);
    const memberKey = await key(members.member, ['team.manage', 'assistants.provision', 'tasks.read', 'tasks.manage_assigned']);
    const agentKey = await key(members.agent, ['team.manage', 'tasks.read', 'tasks.manage_assigned']);
    const personalKey = await key(members.personal, ['tasks.read', 'tasks.manage_assigned']);

    // ── Assistants on/off and their name ──
    const read = await call(settings.GET, ownerKey, 'GET', '/api/v1/assistants/settings');
    check('assistants: the owner reads the assistants switch and name', read.status === 200 && typeof read.json.data?.enabled === 'boolean' && typeof read.json.data?.label === 'string', read.json);
    const turned = await call(settings.PATCH, ownerKey, 'PATCH', '/api/v1/assistants/settings', {}, { enabled: true, label: 'Parity Helpers' });
    const stored = (await q<{ assistants_enabled: boolean; assistant_label: string | null }>('SELECT assistants_enabled, assistant_label FROM pm.business_settings LIMIT 1'))[0];
    check('assistants: the owner turns assistants on and names them', turned.status === 200 && turned.json.data?.enabled === true && turned.json.data?.label === 'Parity Helpers'
      && stored.assistants_enabled === true && stored.assistant_label === 'Parity Helpers', { turned: turned.json, stored });
    const viaApi = await q<{ endpoint: string; via: string | null }>("SELECT endpoint, via FROM pm.api_audit_log WHERE entity_type = 'business_settings' AND endpoint = '/api/v1/assistants/settings'");
    check('assistants: the change is audited as the API, not the app', viaApi.length > 0 && viaApi.every((row) => row.via !== 'app'), viaApi);
    const adminTurn = await call(settings.PATCH, adminKey, 'PATCH', '/api/v1/assistants/settings', {}, { enabled: false });
    check('assistants: an admin with team.manage may not switch assistants (403 owner_only)', adminTurn.status === 403 && reason(adminTurn.json) === 'owner_only', adminTurn.json);
    const adminRead = await call(settings.GET, adminKey, 'GET', '/api/v1/assistants/settings');
    check('assistants: nor read the switch (403 owner_only)', adminRead.status === 403 && reason(adminRead.json) === 'owner_only', adminRead.json);
    const memberTurn = await call(settings.PATCH, memberKey, 'PATCH', '/api/v1/assistants/settings', {}, { enabled: false });
    check('assistants: a member is refused', memberTurn.status === 403, memberTurn.json);
    const agentTurn = await call(settings.PATCH, agentKey, 'PATCH', '/api/v1/assistants/settings', {}, { enabled: false });
    check('assistants: an agent is refused', agentTurn.status === 403, agentTurn.json);
    check('assistants: still on after the refused calls', (await q<{ assistants_enabled: boolean }>('SELECT assistants_enabled FROM pm.business_settings LIMIT 1'))[0].assistants_enabled === true);
    const renamed = await tool(ownerKey, 'update_assistant_settings', { label: 'Parity Aides' });
    check('assistants mcp: update_assistant_settings is listed for the owner and renames them', renamed.listed && renamed.result.ok === true && renamed.result.data?.label === 'Parity Aides'
      && (await q<{ assistant_label: string }>('SELECT assistant_label FROM pm.business_settings LIMIT 1'))[0].assistant_label === 'Parity Aides', renamed.result);
    const readOver = await tool(ownerKey, 'get_assistant_settings', {});
    check('assistants mcp: get_assistant_settings reads it', readOver.result.ok === true && readOver.result.data?.enabled === true, readOver.result);
    const agentTools = await toolNames(agentKey);
    check('assistants mcp: an agent key does not see the owner switches', !agentTools.includes('update_assistant_settings') && !agentTools.includes('bind_personal_agent'), agentTools.filter((n) => n.includes('assistant')));

    // ── Status of every assistant ──
    const list = await call(status.GET, ownerKey, 'GET', '/api/v1/assistants/status');
    check("assistants: the owner reads every assistant's status, the member's included", list.status === 200
      && (list.json.data?.assistants ?? []).some((row: { id: string; person: { id: string } }) => row.id === members.personal && row.person.id === members.member), list.json);
    const adminList = await call(status.GET, adminKey, 'GET', '/api/v1/assistants/status');
    check('assistants: an admin may not read the status list (403 owner_only)', adminList.status === 403 && reason(adminList.json) === 'owner_only', adminList.json);
    const listOver = await tool(ownerKey, 'list_assistant_status', {});
    check('assistants mcp: list_assistant_status lists them', listOver.result.ok === true && Array.isArray(listOver.result.data?.assistants), listOver.result);

    // ── Bind / unbind a personal agent ──
    const bindy = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Parity Bindy', 'parity-bindy@agents.invalid', 'agent') RETURNING id"))[0].id;
    const adminBind = await call(bind.POST, adminKey, 'POST', '/api/v1/assistants/bind', {}, { agent_id: bindy, person_id: members.admin });
    check('assistants: an admin may not bind an agent to a person (403 owner_only)', adminBind.status === 403 && reason(adminBind.json) === 'owner_only', adminBind.json);
    const bound = await call(bind.POST, ownerKey, 'POST', '/api/v1/assistants/bind', {}, { agent_id: bindy, person_id: members.admin });
    const boundRow = (await q<{ delegate_of: string | null }>('SELECT delegate_of FROM pm.team_members WHERE id = $1', [bindy]))[0];
    check('assistants: the owner binds the agent to a person', bound.status === 200 && bound.json.data?.agent?.delegate_of === members.admin && boundRow.delegate_of === members.admin, { bound: bound.json, boundRow });
    // A key made for that person: unbinding revokes it.
    await key(bindy, ['tasks.read']);
    const unbound = await tool(ownerKey, 'bind_personal_agent', { agent_id: bindy, person_id: null });
    check('assistants mcp: bind_personal_agent makes it a shared agent again', unbound.result.ok === true
      && (await q<{ delegate_of: string | null }>('SELECT delegate_of FROM pm.team_members WHERE id = $1', [bindy]))[0].delegate_of === null, unbound.result);
    const liveKeys = await q<{ id: string }>('SELECT id FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [bindy]);
    check("assistants: unbinding revoked the key it held for its person", liveKeys.length === 0, liveKeys);

    // ── Assistant setups: edit and delete over MCP ──
    const setupId = (await q<{ id: string }>("INSERT INTO pm.assistant_setups (match_role, template_key, settings) VALUES ('guest', 'personal-assistant', '{}') RETURNING id"))[0].id;
    const memberPatch = await call(setup.PATCH, memberKey, 'PATCH', `/api/v1/assistant-setups/${setupId}`, { id: setupId }, { enabled: false });
    check('assistants: a member may not edit an assistant setup', memberPatch.status === 403, memberPatch.json);
    const edited = await tool(ownerKey, 'update_assistant_setup', { setup_id: setupId, enabled: false, settings: { name_template: '{first_name} Parity Aide' } });
    const setupRow = (await q<{ enabled: boolean; settings: { name_template?: string } }>('SELECT enabled, settings FROM pm.assistant_setups WHERE id = $1', [setupId]))[0];
    check('assistants mcp: update_assistant_setup switches it off and sets its settings', edited.listed && edited.result.ok === true && setupRow.enabled === false
      && setupRow.settings.name_template === '{first_name} Parity Aide', { result: edited.result, setupRow });
    const memberDelete = await tool(memberKey, 'delete_assistant_setup', { setup_id: setupId });
    check('assistants mcp: a member does not see or pass delete_assistant_setup', !memberDelete.listed && memberDelete.result.ok !== true, memberDelete.result);
    const removed = await tool(ownerKey, 'delete_assistant_setup', { setup_id: setupId });
    check('assistants mcp: delete_assistant_setup removes it', removed.result.ok === true
      && (await q('SELECT id FROM pm.assistant_setups WHERE id = $1', [setupId])).length === 0, removed.result);

    // ── My assistant (a person's own key) ──
    const mine = await call(me.GET, memberKey, 'GET', '/api/v1/me/assistant');
    check('my assistant: the member reads their own assistant', mine.status === 200 && mine.json.data?.assistant?.id === members.personal, mine.json);
    const agentMine = await call(me.GET, agentKey, 'GET', '/api/v1/me/assistant');
    check('my assistant: a company agent is refused (403 people_only)', agentMine.status === 403 && reason(agentMine.json) === 'people_only', agentMine.json);
    const personalMine = await call(me.GET, personalKey, 'GET', '/api/v1/me/assistant');
    check('my assistant: the personal agent itself is refused (403 people_only)', personalMine.status === 403 && reason(personalMine.json) === 'people_only', personalMine.json);
    const changed = await call(me.PATCH, memberKey, 'PATCH', '/api/v1/me/assistant', {}, { tone: 'brief', switches: { create_tasks: false } });
    const prefs = (await q<{ tone: string; switches: { create_tasks?: boolean } }>('SELECT tone, switches FROM pm.assistant_preferences WHERE agent_id = $1', [members.personal]))[0];
    check('my assistant: the member changes its tone and a switch', changed.status === 200 && changed.json.data?.assistant?.preferences?.tone === 'brief'
      && prefs?.tone === 'brief' && prefs?.switches?.create_tasks === false, { changed: changed.json, prefs });
    const agentChange = await call(me.PATCH, agentKey, 'PATCH', '/api/v1/me/assistant', {}, { tone: 'formal' });
    check('my assistant: an agent may not change it (403 people_only)', agentChange.status === 403 && reason(agentChange.json) === 'people_only', agentChange.json);
    // Paused by an admin: the person may not resume it.
    await q("UPDATE pm.team_members SET status = 'suspended', suspended_at = now(), suspended_by = $2 WHERE id = $1", [members.personal, members.owner]);
    const resume = await call(me.PATCH, memberKey, 'PATCH', '/api/v1/me/assistant', {}, { paused: false });
    check('my assistant: resuming an admin pause is refused (403 paused_by_admin)', resume.status === 403 && reason(resume.json) === 'paused_by_admin', resume.json);
    await q("UPDATE pm.team_members SET status = 'active', suspended_at = NULL, suspended_by = NULL WHERE id = $1", [members.personal]);
    const paused = await tool(memberKey, 'update_my_assistant', { paused: true });
    const pausedRow = (await q<{ status: string; suspended_by: string | null }>('SELECT status, suspended_by FROM pm.team_members WHERE id = $1', [members.personal]))[0];
    check('my assistant mcp: update_my_assistant pauses it, by the member', paused.listed && paused.result.ok === true && pausedRow.status === 'suspended' && pausedRow.suspended_by === members.member, { result: paused.result, pausedRow });
    const resumed = await tool(memberKey, 'update_my_assistant', { paused: false, tone: 'warm', switches: { create_tasks: true } });
    check('my assistant mcp: and the member resumes their own pause', resumed.result.ok === true
      && (await q<{ status: string }>('SELECT status FROM pm.team_members WHERE id = $1', [members.personal]))[0].status === 'active', resumed.result);

    // Undo: a task the assistant made goes to Trash, then comes back.
    const P = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Parity Assistant Co') RETURNING id"))[0].id;
    const T = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, created_by) VALUES ($1, 'Book the parity offsite', $2) RETURNING id", [P, members.personal]))[0].id;
    const feed = await call(activity.GET, memberKey, 'GET', '/api/v1/me/assistant/activity');
    check("my assistant: the activity lists the task it made, with its undo", feed.status === 200
      && (feed.json.data?.items ?? []).some((item: { id: string; undo: { kind: string } | null }) => item.id === `created:${T}` && item.undo?.kind === 'task_created'), feed.json);
    const agentFeed = await call(activity.GET, agentKey, 'GET', '/api/v1/me/assistant/activity');
    check('my assistant: an agent may not read the activity (403 people_only)', agentFeed.status === 403 && reason(agentFeed.json) === 'people_only', agentFeed.json);
    const undone = await call(undo.POST, memberKey, 'POST', '/api/v1/me/assistant/undo', {}, { kind: 'task_created', id: T });
    check('my assistant: undo sends the task it made to Trash', undone.status === 200 && undone.json.data?.undone === true
      && !!(await q<{ deleted_at: string | null }>('SELECT deleted_at FROM pm.tasks WHERE id = $1', [T]))[0].deleted_at, undone.json);
    const agentUndo = await call(undo.POST, agentKey, 'POST', '/api/v1/me/assistant/undo', {}, { kind: 'task_restore', id: T });
    check('my assistant: an agent may not undo (403 people_only)', agentUndo.status === 403 && reason(agentUndo.json) === 'people_only', agentUndo.json);
    const restored = await tool(memberKey, 'undo_assistant_action', { kind: 'task_restore', id: T });
    check('my assistant mcp: undo_assistant_action brings it back', restored.result.ok === true
      && (await q<{ deleted_at: string | null }>('SELECT deleted_at FROM pm.tasks WHERE id = $1', [T]))[0].deleted_at === null, restored.result);
    const othersTask = await call(undo.POST, adminKey, 'POST', '/api/v1/me/assistant/undo', {}, { kind: 'task_created', id: T });
    check("my assistant: someone else's assistant's work reads as missing", othersTask.status === 404, othersTask.json);

    const agentsMine = await call(personalAgents.GET, memberKey, 'GET', '/api/v1/me/personal-agents');
    check('my assistant: the member lists their personal agents', agentsMine.status === 200
      && (agentsMine.json.data?.assistants ?? []).some((row: { id: string }) => row.id === members.personal), agentsMine.json);
    const agentsOver = await tool(memberKey, 'list_my_personal_agents', {});
    check('my assistant mcp: list_my_personal_agents lists them', agentsOver.result.ok === true && (agentsOver.result.data?.assistants ?? []).length > 0, agentsOver.result);
    const mineOver = await tool(memberKey, 'get_my_assistant', {});
    check('my assistant mcp: get_my_assistant reads it', mineOver.listed && mineOver.result.ok === true && mineOver.result.data?.assistant?.id === members.personal, mineOver.result);
    const agentList = await toolNames(agentKey);
    check('my assistant mcp: an agent key sees none of the my-assistant tools', !['get_my_assistant', 'update_my_assistant', 'undo_assistant_action', 'list_my_assistant_activity', 'list_my_personal_agents']
      .some((name) => agentList.includes(name)), agentList.filter((n) => n.includes('my_')));
    const agentOver = await tool(agentKey, 'get_my_assistant', {});
    check('my assistant mcp: called by name, an agent is still refused', agentOver.result.ok !== true, agentOver.result);

    // ── Chat connections (Owner, never a secret) ──
    const sealed = 'pm1:parity-fake-sealed-credential';
    const company = (await q<{ id: string }>(`INSERT INTO pm.chat_connections (provider, display_name, bot_handle, credentials, kind, external_bot_id, created_by)
      VALUES ('telegram', 'Parity Company Bot', 'parity_company_bot', $1, 'company', 'parity-bot-1', $2) RETURNING id`, [sealed, members.owner]))[0].id;
    const personalBot = (await q<{ id: string }>(`INSERT INTO pm.chat_connections (provider, display_name, bot_handle, credentials, kind, external_bot_id, created_by)
      VALUES ('slack', 'Parity Personal Bot', 'parity_personal_bot', $1, 'personal', 'parity-bot-2', $2) RETURNING id`, [sealed, members.owner]))[0].id;

    const listed = await call(connections.GET, ownerKey, 'GET', '/api/v1/chat/connections');
    const row = (listed.json.data?.connections ?? []).find((c: { id: string }) => c.id === company);
    check('chat: the owner lists connections with their health', listed.status === 200 && row?.kind === 'company' && row?.health === 'waiting' && row?.display_name === 'Parity Company Bot', listed.json);
    const text = JSON.stringify(listed.json);
    check('chat: the list holds no credential or secret', !text.includes('parity-fake-sealed') && !/"(credentials|bot_token|signing_secret|relay_secret)"/.test(text), text.slice(0, 400));
    const memberList = await call(connections.GET, memberKey, 'GET', '/api/v1/chat/connections');
    check('chat: a member is refused', memberList.status === 403, memberList.json);
    const adminConnList = await call(connections.GET, adminKey, 'GET', '/api/v1/chat/connections');
    check('chat: an admin with team.manage is refused (403 owner_only)', adminConnList.status === 403 && reason(adminConnList.json) === 'owner_only', adminConnList.json);
    const agentConnList = await call(connections.GET, agentKey, 'GET', '/api/v1/chat/connections');
    check('chat: an agent is refused', agentConnList.status === 403, agentConnList.json);

    const renamedConn = await call(connection.PATCH, ownerKey, 'PATCH', `/api/v1/chat/connections/${company}`, { id: company }, { display_name: 'Parity Ops Bot' });
    check('chat: the owner renames a connection', renamedConn.status === 200 && renamedConn.json.data?.display_name === 'Parity Ops Bot' && typeof renamedConn.json.data?.health === 'string'
      && (await q<{ display_name: string }>('SELECT display_name FROM pm.chat_connections WHERE id = $1', [company]))[0].display_name === 'Parity Ops Bot', renamedConn.json);
    const tokenSwap = await call(connection.PATCH, ownerKey, 'PATCH', `/api/v1/chat/connections/${company}`, { id: company }, { bot_token: '123456:abcdefghijklmnopqrstuvwxyz0123456789' });
    check('chat: a bot token is never accepted over the API (422 unrecognized key)', tokenSwap.status === 422
      && (await q<{ credentials: string }>('SELECT credentials FROM pm.chat_connections WHERE id = $1', [company]))[0].credentials === sealed, tokenSwap.json);
    const offOver = await tool(ownerKey, 'update_chat_connection', { connection_id: company, enabled: false });
    check('chat mcp: update_chat_connection switches it off (health off)', offOver.listed && offOver.result.ok === true && offOver.result.data?.health === 'off'
      && (await q<{ enabled: boolean }>('SELECT enabled FROM pm.chat_connections WHERE id = $1', [company]))[0].enabled === false, offOver.result);
    await tool(ownerKey, 'update_chat_connection', { connection_id: company, enabled: true });

    // Agents: a company agent must be allowed to act for people first.
    const notYet = await call(connectionAgents.PUT, ownerKey, 'PUT', `/api/v1/chat/connections/${company}/agents`, { id: company }, { agent_ids: [members.agent], default_agent_id: members.agent });
    check('chat: an agent that may not act for people is refused (422 agent_cannot_act_for)', notYet.status === 422 && reason(notYet.json) === 'agent_cannot_act_for', notYet.json);
    const personalOn = await call(connectionAgents.PUT, ownerKey, 'PUT', `/api/v1/chat/connections/${company}/agents`, { id: company }, { agent_ids: [members.personal], default_agent_id: null });
    check('chat: a personal assistant is never a company bot agent (422 personal_agent)', personalOn.status === 422 && reason(personalOn.json) === 'personal_agent', personalOn.json);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'agents.act_for', 'api', 'allow')
      ON CONFLICT (member_id, permission_key, access_channel) DO UPDATE SET effect = 'allow'`, [members.agent]);
    try {
      const memberSet = await call(connectionAgents.PUT, memberKey, 'PUT', `/api/v1/chat/connections/${company}/agents`, { id: company }, { agent_ids: [members.agent], default_agent_id: members.agent });
      check('chat: a member may not pick the agents', memberSet.status === 403, memberSet.json);
      const set = await tool(ownerKey, 'set_chat_connection_agents', { connection_id: company, agent_ids: [members.agent], default_agent_id: members.agent });
      const agentRows = await q<{ agent_id: string; is_default: boolean }>('SELECT agent_id, is_default FROM pm.chat_connection_agents WHERE connection_id = $1', [company]);
      check('chat mcp: set_chat_connection_agents sets the agent and the DM default', set.result.ok === true
        && agentRows.length === 1 && agentRows[0].agent_id === members.agent && agentRows[0].is_default === true
        && set.result.data?.agents?.[0]?.id === members.agent, { result: set.result, agentRows });
      const onPersonal = await call(connectionAgents.PUT, ownerKey, 'PUT', `/api/v1/chat/connections/${personalBot}/agents`, { id: personalBot }, { agent_ids: [members.agent], default_agent_id: null });
      check('chat: a personal connection has no agents to pick (409 not_a_company_connection)', onPersonal.status === 409 && reason(onPersonal.json) === 'not_a_company_connection', onPersonal.json);

      // Channels: mapping asks the provider with the stored token; the fake one cannot be opened, so it is refused there.
      const mapRefused = await call(channels.POST, ownerKey, 'POST', `/api/v1/chat/connections/${company}/channels`, { id: company }, { channel: '#general', agent_id: members.agent });
      check('chat: mapping by name needs a token the server can open (409 credentials_unreadable)', mapRefused.status === 409 && reason(mapRefused.json) === 'credentials_unreadable', mapRefused.json);
      const routeId = (await q<{ id: string }>(`INSERT INTO pm.chat_channel_routes (connection_id, channel_id, channel_name, agent_id, listen, created_by)
        VALUES ($1, '-100555', 'parity-room', $2, 'mentions', $3) RETURNING id`, [company, members.agent, members.owner]))[0].id;
      const memberChannel = await call(channel.PATCH, memberKey, 'PATCH', `/api/v1/chat/connections/${company}/channels/${routeId}`, { id: company, channelId: routeId }, { listen: 'all' });
      check('chat: a member may not change a channel', memberChannel.status === 403, memberChannel.json);
      const listen = await tool(ownerKey, 'update_chat_channel', { connection_id: company, channel_id: routeId, listen: 'all' });
      check('chat mcp: update_chat_channel sets listen all', listen.result.ok === true
        && (await q<{ listen: string }>('SELECT listen FROM pm.chat_channel_routes WHERE id = $1', [routeId]))[0].listen === 'all', listen.result);
      const unmapped = await call(channel.DELETE, ownerKey, 'DELETE', `/api/v1/chat/connections/${company}/channels/${routeId}`, { id: company, channelId: routeId });
      check('chat: the owner unmaps the channel', unmapped.status === 200 && (await q('SELECT id FROM pm.chat_channel_routes WHERE id = $1', [routeId])).length === 0, unmapped.json);
    } finally {
      await q("DELETE FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'agents.act_for' AND access_channel = 'api'", [members.agent]);
    }

    const memberDeleteConn = await call(connection.DELETE, memberKey, 'DELETE', `/api/v1/chat/connections/${personalBot}`, { id: personalBot });
    check('chat: a member may not remove a connection', memberDeleteConn.status === 403 && (await q('SELECT id FROM pm.chat_connections WHERE id = $1', [personalBot])).length === 1, memberDeleteConn.json);
    const deleteTools = await toolNames(ownerKey);
    check('chat mcp: the owner sees delete_chat_connection, never a tool that connects an app', deleteTools.includes('delete_chat_connection') && !deleteTools.some((name) => /create_chat_connection|connect_chat/.test(name)), deleteTools.filter((n) => n.includes('chat')));
    const deleted = await tool(ownerKey, 'delete_chat_connection', { connection_id: personalBot });
    check('chat mcp: delete_chat_connection removes it', deleted.result.ok === true && deleted.result.data?.deleted === true
      && (await q('SELECT id FROM pm.chat_connections WHERE id = $1', [personalBot])).length === 0, deleted.result);
    await q('DELETE FROM pm.chat_connections WHERE id = $1', [company]);
  } finally {
    await q("DELETE FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'team.manage' AND access_channel = 'api'", [members.admin]);
    await q('UPDATE pm.business_settings SET assistants_enabled = $1, assistant_label = $2', [before.assistants_enabled, before.assistant_label]);
  }
}
