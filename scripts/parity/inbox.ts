import type { Harness } from './harness';

/**
 * Inbox over the API: sender rules edited by the app's rule (a person who
 * manages inboxes edits any, an agent only agents' rules), conversations
 * read with the app's visibility, and a person's own decisions (mark handled,
 * plan items, replies owed, filing, links) open to their own key and MCP
 * client and refused for company and personal agents (403 people_only).
 */
export async function inboxArea(h: Harness) {
  const { q, key, call, tool, toolNames, check, members } = h;
  const rule = await import('../../src/app/api/v1/inbox/sender-rules/[id]/route');
  const threads = await import('../../src/app/api/v1/inbox/threads/route');
  const thread = await import('../../src/app/api/v1/inbox/threads/[threadId]/route');
  const count = await import('../../src/app/api/v1/inbox/count/route');
  const handled = await import('../../src/app/api/v1/inbox/threads/[threadId]/handled/route');
  const sendBack = await import('../../src/app/api/v1/inbox/threads/[threadId]/send-back/route');
  const projects = await import('../../src/app/api/v1/inbox/threads/[threadId]/projects/route');
  const project = await import('../../src/app/api/v1/inbox/threads/[threadId]/projects/[projectId]/route');
  const links = await import('../../src/app/api/v1/inbox/threads/[threadId]/links/route');
  const dismiss = await import('../../src/app/api/v1/inbox/plan-items/[id]/dismiss/route');
  const resolve = await import('../../src/app/api/v1/inbox/reply-points/[id]/resolve/route');

  // An inbox, its conversations and their emails, waiting on a person.
  const one = async <T = { id: string }>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const P = (await one("INSERT INTO pm.projects (name) VALUES ('Parity Inbox Co') RETURNING id")).id;
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [P, members.member]);
  const T = (await one("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Reply to the parity brief') RETURNING id", [P])).id;
  const inbox = (await one("INSERT INTO pm.inboxes (name, address, triage_mode) VALUES ('Parity desk', 'parity-desk@agency.example', 'plans') RETURNING id")).id;
  await q('INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING', [inbox, members.member, members.agent]);
  const conversation = async (subject: string) => {
    const c = (await one(`INSERT INTO pm.conversations (inbox_id, subject_normalized, channel, last_message_at)
      VALUES ($1, $2, 'email', now() - interval '1 hour') RETURNING id`, [inbox, subject.toLowerCase()])).id;
    const m = (await one(`INSERT INTO pm.messages (inbox_id, thread_id, channel, status, provider, provider_email_id, internet_message_id,
        received_at, subject, kind, auth, text_body, html_body, new_text)
      VALUES ($1, $2, 'email', 'needs_human', 'test', $3, $3, now() - interval '1 hour', $4, 'person', '{"trust":"trusted"}', 'Can you send the brief?', '<p>Can you send the brief?</p>', 'Can you send the brief?')
      RETURNING id`, [inbox, c, `parity-${subject}-${Math.random()}`, subject])).id;
    await q("INSERT INTO pm.participants (message_id, kind, address, name, position) VALUES ($1, 'from', 'dana@parity-client.example', 'Dana Wu', 0)", [m]);
    return { c, m };
  };
  const c1 = await conversation('Parity brief one');
  const c2 = await conversation('Parity brief two');
  const c3 = await conversation('Parity brief three');

  // People hold no Inbox permission on the api channel by default: the member is given read and triage, as an Owner would.
  const allows = ['inbound_email.read', 'inbound_email.triage'];
  await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, k, 'api', 'allow' FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`, [members.member, allows]);
  await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    VALUES ($1, 'inbound_email.read', 'api', 'allow') ON CONFLICT DO NOTHING`, [members.admin]);
  // A personal agent must be live to reach the people-only refusal (with assistants off it is on hold first).
  const assistantsBefore = (await one<{ assistants_enabled: boolean }>('SELECT assistants_enabled FROM pm.business_settings LIMIT 1')).assistants_enabled;
  await q('UPDATE pm.business_settings SET assistants_enabled = true');
  try {
    const ownerKey = await key(members.owner, [...allows, 'projects.read', 'tasks.read']);
    const memberKey = await key(members.member, [...allows, 'projects.read', 'tasks.read']);
    const memberReadKey = await key(members.member, ['inbound_email.read']);
    const adminKey = await key(members.admin, ['inbound_email.read']);
    const agentKey = await key(members.agent, allows);
    const personalKey = await key(members.personal, allows);
    const statusOf = async (m: string) => (await one<{ status: string; reviewed_by: string | null }>('SELECT status, reviewed_by FROM pm.messages WHERE id = $1', [m]));

    // Sender rules
    const personRule = (await one(`INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, reason, created_by)
      VALUES ('domain', 'parity-person.example', NULL, 'ignore', 'person', 'Person decided', $1) RETURNING id`, [members.owner])).id;
    const agentRule = (await one(`INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, reason, created_by)
      VALUES ('domain', 'parity-agent.example', 'usage', 'fyi', 'agent', 'Usage alerts every hour', $1) RETURNING id`, [members.agent])).id;
    const edited = await call(rule.PATCH, ownerKey, 'PATCH', `/api/v1/inbox/sender-rules/${agentRule}`, { id: agentRule }, { action: 'always' });
    const afterEdit = await one<{ action: string; source: string }>('SELECT action, source FROM pm.sender_rules WHERE id = $1', [agentRule]);
    check('inbox rules: an Owner changes what an agent\'s rule does, and it becomes a person\'s', edited.status === 200 && afterEdit.action === 'always' && afterEdit.source === 'person', { edited: edited.json, afterEdit });
    const memberEdit = await call(rule.PATCH, memberKey, 'PATCH', `/api/v1/inbox/sender-rules/${personRule}`, { id: personRule }, { enabled: false });
    check('inbox rules: a member who does not manage inboxes is refused (403)', memberEdit.status === 403, memberEdit.json);
    const agentOnPerson = await call(rule.PATCH, agentKey, 'PATCH', `/api/v1/inbox/sender-rules/${personRule}`, { id: personRule }, { enabled: false });
    check('inbox rules: an agent may not change a person\'s rule (409 person_rule)', agentOnPerson.status === 409 && agentOnPerson.json.error?.details?.reason === 'person_rule', agentOnPerson.json);
    check('inbox rules: and the person\'s rule stays on', (await one<{ disabled_at: string | null }>('SELECT disabled_at FROM pm.sender_rules WHERE id = $1', [personRule])).disabled_at === null);
    const ownRule = (await one(`INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, reason, created_by)
      VALUES ('domain', 'parity-own.example', 'usage', 'ignore', 'agent', 'Usage alerts every hour', $1) RETURNING id`, [members.agent])).id;
    const agentOff = await call(rule.PATCH, agentKey, 'PATCH', `/api/v1/inbox/sender-rules/${ownRule}`, { id: ownRule }, { enabled: false, action: 'fyi' });
    const ownAfter = await one<{ disabled_by: string | null; action: string; source: string }>('SELECT disabled_by, action, source FROM pm.sender_rules WHERE id = $1', [ownRule]);
    check('inbox rules: an agent switches off and changes an agent\'s rule, which stays an agent\'s', agentOff.status === 200 && ownAfter.disabled_by === members.agent && ownAfter.action === 'fyi' && ownAfter.source === 'agent', { agentOff: agentOff.json, ownAfter });
    const overMcp = await tool(ownerKey, 'update_sender_rule', { rule_id: personRule, enabled: false });
    check('inbox rules mcp: update_sender_rule switches a rule off for an Owner', overMcp.listed && overMcp.result.ok === true
      && (await one<{ disabled_by: string | null }>('SELECT disabled_by FROM pm.sender_rules WHERE id = $1', [personRule])).disabled_by === members.owner, overMcp.result);

    // Conversations
    const memberList = await call(threads.GET, memberReadKey, 'GET', '/api/v1/inbox/threads?status=everything');
    const listedIds = (memberList.json.data?.threads ?? []).map((row: { id: string }) => row.id);
    check('inbox threads: a member granted the inbox lists its conversations', memberList.status === 200 && [c1.c, c2.c, c3.c].every((c) => listedIds.includes(c)), memberList.json);
    const adminList = await call(threads.GET, adminKey, 'GET', '/api/v1/inbox/threads?status=everything');
    check('inbox threads: a member not granted the inbox lists none of them', adminList.status === 200
      && !(adminList.json.data?.threads ?? []).some((row: { id: string }) => [c1.c, c2.c, c3.c].includes(row.id)), adminList.json);
    const badTab = await call(threads.GET, memberReadKey, 'GET', '/api/v1/inbox/threads?status=archive');
    check('inbox threads: an unknown tab is a 400', badTab.status === 400, badTab.json);
    const detail = await call(thread.GET, memberReadKey, 'GET', `/api/v1/inbox/threads/${c1.c}`, { threadId: c1.c });
    check('inbox threads: one conversation reads as the app shows it, read only for a read key', detail.status === 200 && detail.json.data?.id === c1.c
      && detail.json.data?.messages?.[0]?.id === c1.m && detail.json.data?.can_triage === false, detail.json);
    const hidden = await call(thread.GET, adminKey, 'GET', `/api/v1/inbox/threads/${c1.c}`, { threadId: c1.c });
    check('inbox threads: a conversation in an inbox the key cannot read is 404', hidden.status === 404, hidden.json);
    const counted = await call(count.GET, memberReadKey, 'GET', '/api/v1/inbox/count');
    check('inbox threads: the count holds the conversations waiting on a person', counted.status === 200 && counted.json.data?.needs_attention >= 3, counted.json);
    const listOver = await tool(memberKey, 'list_inbox_threads', { status: 'everything' });
    check('inbox threads mcp: list_inbox_threads lists them', listOver.listed && listOver.result.ok === true
      && (listOver.result.data?.threads ?? []).some((row: { id: string }) => row.id === c2.c), listOver.result);
    const detailOver = await tool(memberKey, 'get_inbox_thread', { thread_id: c2.c });
    check('inbox threads mcp: get_inbox_thread reads one, its HTML left out where the text has the words', detailOver.result.ok === true
      && detailOver.result.data?.messages?.[0]?.html_body === null && detailOver.result.data?.messages?.[0]?.html_body_omitted === true, detailOver.result);
    const agentReads = await tool(agentKey, 'get_inbox_count', {});
    check('inbox threads mcp: an agent granted the inbox reads its count', agentReads.listed && agentReads.result.ok === true && agentReads.result.data?.needs_attention >= 3, agentReads.result);

    // A person's decisions
    const refusedAgent = await call(handled.POST, agentKey, 'POST', `/api/v1/inbox/threads/${c1.c}/handled`, { threadId: c1.c });
    check('inbox decisions: a company agent is refused (403 people_only)', refusedAgent.status === 403 && refusedAgent.json.error?.details?.reason === 'people_only', refusedAgent.json);
    const refusedPersonal = await call(handled.POST, personalKey, 'POST', `/api/v1/inbox/threads/${c1.c}/handled`, { threadId: c1.c });
    check('inbox decisions: a personal agent is refused (403 people_only)', refusedPersonal.status === 403 && refusedPersonal.json.error?.details?.reason === 'people_only', refusedPersonal.json);
    check('inbox decisions: and the conversation still waits', (await statusOf(c1.m)).status === 'needs_human');
    const readOnly = await call(handled.POST, memberReadKey, 'POST', `/api/v1/inbox/threads/${c1.c}/handled`, { threadId: c1.c });
    check('inbox decisions: a key without inbound_email.triage is refused', readOnly.status === 403, readOnly.json);
    const marked = await call(handled.POST, memberKey, 'POST', `/api/v1/inbox/threads/${c1.c}/handled`, { threadId: c1.c });
    const afterMark = await statusOf(c1.m);
    check('inbox decisions: a person\'s own key marks it handled, as them', marked.status === 200 && marked.json.data?.handled === 1
      && afterMark.status === 'handled' && afterMark.reviewed_by === members.member, { marked: marked.json, afterMark });
    const sentBack = await call(sendBack.POST, memberKey, 'POST', `/api/v1/inbox/threads/${c1.c}/send-back`, { threadId: c1.c }, {});
    check('inbox decisions: and sends it back to the agent', sentBack.status === 200 && (await statusOf(c1.m)).status === 'new', sentBack.json);
    const markedOver = await tool(ownerKey, 'mark_inbox_thread_handled', { thread_id: c2.c });
    check('inbox decisions mcp: an Owner\'s MCP client marks a conversation handled', markedOver.listed && markedOver.result.ok === true
      && (await statusOf(c2.m)).status === 'handled', markedOver.result);
    const agentTools = await toolNames(agentKey);
    const personalTools = await toolNames(personalKey);
    const peopleTools = ['mark_inbox_thread_handled', 'accept_plan_item', 'resolve_reply_owed', 'link_inbox_thread_task'];
    check('inbox decisions mcp: agents, company and personal, do not see the people-only tools',
      peopleTools.every((name) => !agentTools.includes(name) && !personalTools.includes(name)) && agentTools.includes('get_inbox_count'), { agentTools: agentTools.filter((n) => /inbox|plan_item/.test(n)) });
    const agentOver = await tool(agentKey, 'mark_inbox_thread_handled', { thread_id: c3.c });
    check('inbox decisions mcp: called by name anyway, an agent is refused', agentOver.result.ok !== true && (await statusOf(c3.m)).status === 'needs_human', agentOver.result);

    // Plan items and replies owed
    const plan = (await one(`INSERT INTO pm.plans (message_id, conversation_id, member_id, mode, status, summary)
      VALUES ($1, $2, $3, 'live', 'applied', 'Parity plan') RETURNING id`, [c3.m, c3.c, members.agent])).id;
    const item = (await one(`INSERT INTO pm.plan_items (plan_id, position, conversation_id, mode, type, intent, payload, decision, state)
      VALUES ($1, 0, $2, 'live', 'add_reminder', 'waiting_on', '{"type":"add_reminder","title":"Chase the parity brief"}', 'propose', 'pending') RETURNING id`, [plan, c3.c])).id;
    const agentDismiss = await call(dismiss.POST, agentKey, 'POST', `/api/v1/inbox/plan-items/${item}/dismiss`, { id: item });
    check('inbox plans: an agent may not turn down its own proposal for a person (403 people_only)', agentDismiss.status === 403 && agentDismiss.json.error?.details?.reason === 'people_only', agentDismiss.json);
    const dismissed = await call(dismiss.POST, memberKey, 'POST', `/api/v1/inbox/plan-items/${item}/dismiss`, { id: item });
    check('inbox plans: a person turns it down', dismissed.status === 200
      && (await one<{ state: string; resolved_by: string }>('SELECT state, resolved_by FROM pm.plan_items WHERE id = $1', [item])).state === 'dismissed', dismissed.json);
    const restoredOver = await tool(memberKey, 'restore_plan_item', { item_id: item });
    check('inbox plans mcp: restore_plan_item makes it wait again', restoredOver.listed && restoredOver.result.ok === true
      && (await one<{ state: string }>('SELECT state FROM pm.plan_items WHERE id = $1', [item])).state === 'pending', restoredOver.result);
    const point = (await one(`INSERT INTO pm.reply_points (conversation_id, message_id, who, what, kind) VALUES ($1, $2, 'Dana', 'The brief', 'info') RETURNING id`, [c3.c, c3.m])).id;
    const agentResolve = await call(resolve.POST, personalKey, 'POST', `/api/v1/inbox/reply-points/${point}/resolve`, { id: point });
    check('inbox plans: a personal agent may not mark a reply owed done', agentResolve.status === 403, agentResolve.json);
    const resolvedOver = await tool(memberKey, 'resolve_reply_owed', { reply_point_id: point });
    check('inbox plans mcp: resolve_reply_owed marks it done, as the person', resolvedOver.result.ok === true
      && (await one<{ state: string; resolved_by: string }>('SELECT state, resolved_by FROM pm.reply_points WHERE id = $1', [point])).resolved_by === members.member, resolvedOver.result);

    // Filing and links
    const filed = await call(projects.POST, memberKey, 'POST', `/api/v1/inbox/threads/${c3.c}/projects`, { threadId: c3.c }, { project_id: P });
    const filedRow = await q<{ source: string }>('SELECT source FROM pm.conversation_projects WHERE conversation_id = $1 AND project_id = $2', [c3.c, P]);
    check('inbox filing: a person files the conversation on a project, as theirs', filed.status === 201 && filedRow[0]?.source === 'person', { filed: filed.json, filedRow });
    const agentFile = await call(projects.POST, agentKey, 'POST', `/api/v1/inbox/threads/${c3.c}/projects`, { threadId: c3.c }, { project_id: P });
    check('inbox filing: an agent files through its plans, not here (403 people_only)', agentFile.status === 403 && agentFile.json.error?.details?.reason === 'people_only', agentFile.json);
    const linked = await call(links.POST, memberKey, 'POST', `/api/v1/inbox/threads/${c3.c}/links`, { threadId: c3.c }, { task_id: T });
    check('inbox filing: a person links it to a task', linked.status === 201
      && (await q('SELECT 1 FROM pm.task_links WHERE message_id = $1 AND task_id = $2', [c3.m, T])).length === 1, linked.json);
    const blocked = await call(project.DELETE, memberKey, 'DELETE', `/api/v1/inbox/threads/${c3.c}/projects/${P}`, { threadId: c3.c, projectId: P });
    check('inbox filing: a project with a linked task stays on it (409)', blocked.status === 409, blocked.json);
    const unlinked = await tool(memberKey, 'unlink_inbox_thread_task', { thread_id: c3.c, task_id: T });
    check('inbox filing mcp: unlink_inbox_thread_task unlinks it', unlinked.listed && unlinked.result.ok === true
      && (await q('SELECT 1 FROM pm.task_links WHERE message_id = $1 AND task_id = $2', [c3.m, T])).length === 0, unlinked.result);
    const removedOver = await tool(memberKey, 'remove_inbox_thread_project', { thread_id: c3.c, project_id: P });
    check('inbox filing mcp: remove_inbox_thread_project takes the project off', removedOver.result.ok === true
      && (await q('SELECT 1 FROM pm.conversation_projects WHERE conversation_id = $1 AND project_id = $2', [c3.c, P])).length === 0, removedOver.result);
  } finally {
    // The overrides and the switch are this area's own: other areas see them as they were.
    await q('UPDATE pm.business_settings SET assistants_enabled = $1', [assistantsBefore]);
    await q(`DELETE FROM pm.team_member_permissions WHERE access_channel = 'api' AND permission_key = ANY($3::text[]) AND member_id IN ($1, $2)`,
      [members.member, members.admin, allows]);
  }
}
