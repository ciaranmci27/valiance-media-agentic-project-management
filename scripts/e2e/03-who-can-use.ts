/**
 * 3. Who can use an agent: an agent whose audience is one member. A member
 * outside it is refused at every door (company chat, assigning a new task,
 * delegating), while the member inside it gets through. Then ask first: the
 * member's request makes one approval (asking again does not make a second),
 * the agent's manager approves it in the app, the request goes through once,
 * and the same request again needs a new approval.
 */
import { companyTelegram, linkTelegram, needsYou } from './02-chat-to-done';
import { OWNER_SETUP_SCOPES, check, dataOf, equal, errorOf, hire, makeProject, personalKey, step, tag, type Ctx, type Json } from './harness';
import type { Scenario } from './run';

const MEMBER_KEY_SCOPES = ['tasks.read', 'tasks.create', 'tasks.manage_all', 'projects.read'];

const scenario: Scenario = {
  name: 'Who can use an agent: audience, refusals at every door, ask first',
  async run(ctx: Ctx) {
    const { owner, requester, manager, outsider } = ctx.people;
    const ownerKey = (await personalKey(ctx, owner, OWNER_SETUP_SCOPES, 'owner setup')).caller;
    const project = await makeProject(ctx, ownerKey, 'Audience', [requester.memberId, manager.memberId, outsider.memberId]);
    const gate = await hire(ctx, {
      name: `E2E Gatekeeper ${tag}`, project_ids: [project.id], owner_ids: [manager.memberId],
      scopes: ['tasks.read', 'tasks.manage_assigned', 'projects.read', 'notifications.manage_own', 'agent_activity.write'],
    });
    dataOf(await gate.key.post('/api/v1/agents/heartbeat', { working: true }), 200, 'gatekeeper heartbeat');
    const set = dataOf(await manager.put(`/api/workspace/agents/${gate.agent.id}/access`, {
      audience: [{ kind: 'member', ref: requester.memberId, effect: 'include' }],
    }), 200, 'the manager limits who can use the agent');
    check(JSON.stringify(set).includes(requester.memberId), 'The audience names the requester', set);
    step(`${manager.name} (its owner) limited "${gate.agent.name}" to ${requester.name}`);

    // Both may assign anyone's tasks (Team > Permissions: "Manage all tasks"), so only the agent's audience decides.
    for (const person of [requester, outsider]) {
      for (const channel of ['app', 'api']) {
        await ctx.db.query(
          `INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect, created_by) VALUES ($1, 'tasks.manage_all', $2, 'allow', $3)
           ON CONFLICT (member_id, permission_key, access_channel) DO UPDATE SET effect = 'allow'`,
          [person.memberId, channel, owner.memberId],
        );
      }
      ctx.cleanup.add(`drop ${person.name} manage_all`, () => ctx.db.query(`DELETE FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'tasks.manage_all'`, [person.memberId]));
    }
    const insiderKey = (await personalKey(ctx, requester, MEMBER_KEY_SCOPES, 'insider')).caller;
    const outsiderKey = (await personalKey(ctx, outsider, MEMBER_KEY_SCOPES, 'outsider')).caller;
    step('Owner let the insider and the outsider manage all tasks (Team > Permissions)');

    // ── Chat door ──
    const chat = await companyTelegram(ctx, gate.agent.id);
    const outsiderTg = await linkTelegram(ctx, outsider);
    const insiderTg = await linkTelegram(ctx, requester);
    const refusedChat = await chat.dm(outsiderTg, 'Can you draft the release notes?');
    equal(refusedChat.status, 200, 'chat webhook answer');
    equal(refusedChat.body?.status, 'unrouted', 'the outsider\'s DM is not routed');
    const reply = (await ctx.db.query(`SELECT text FROM pm.chat_messages WHERE reply_to_id = $1 AND direction = 'outbound'`, [refusedChat.body.id])).rows[0];
    check(reply && /is not available to you/.test(reply.text), 'The bot tells the outsider the agent is not available to them', reply);
    const okChat = await chat.dm(insiderTg, 'Can you draft the release notes?');
    check(['pending', 'notified'].includes(okChat.body?.status), 'The insider\'s DM reaches the agent', okChat.body);
    step('Chat: the outsider is told the agent is not available; the insider\'s DM reaches it');

    // ── Assign door: a member adds an assignee on the task panel, which the browser
    //    writes straight to the database API (the guard_agent_assignment trigger decides). ──
    const outsiderTask = dataOf(await outsiderKey.post('/api/v1/tasks', { project_id: project.id, title: `Outsider's own task ${tag}` }), 201, 'outsider makes a task');
    const insiderOwnTask = dataOf(await insiderKey.post('/api/v1/tasks', { project_id: project.id, title: `Insider asks ${tag}` }), 201, 'insider makes a task');
    const refusedAssign = await outsider.restInsert('task_assignees', { task_id: outsiderTask.id, member_id: gate.agent.id });
    equal(refusedAssign.status, 403, 'assigning the agent as the outsider', refusedAssign.body);
    check(/agent_not_available/.test(refusedAssign.body?.message ?? ''), 'The refusal says the agent is not available', refusedAssign.body);
    const okAssign = await requester.restInsert('task_assignees', { task_id: insiderOwnTask.id, member_id: gate.agent.id });
    equal(okAssign.status, 201, 'the insider assigns the agent', okAssign.body);
    const keyAssign = await outsiderKey.patch(`/api/v1/tasks/${outsiderTask.id}`, { assignee_ids: [outsider.memberId, gate.agent.id] });
    equal(keyAssign.status, 403, 'assigning the agent over the API as the outsider', keyAssign.body);
    equal(errorOf(keyAssign).reason, 'agent_not_available', 'API assign refusal reason', keyAssign.body);
    equal(keyAssign.body.error.details?.why, 'not_in_audience', 'API assign refusal why', keyAssign.body);
    const keyCreate = await insiderKey.post('/api/v1/tasks', { project_id: project.id, title: `Insider assigns ${tag}`, assignee_ids: [gate.agent.id] });
    equal(keyCreate.status, 201, 'the insider makes a task for the agent over the API', keyCreate.body);
    step('Assign: the outsider is refused on the task panel and over the API (403); the insider assigns');

    // ── Delegate door ──
    const refusedDelegate = await outsiderKey.post(`/api/v1/tasks/${outsiderTask.id}/delegate`, { agent_id: gate.agent.id, title: 'Draft the notes' });
    equal(refusedDelegate.status, 403, 'delegating to the agent as the outsider', refusedDelegate.body);
    equal(errorOf(refusedDelegate).reason, 'agent_not_available', 'delegate refusal reason', refusedDelegate.body);
    step('Delegate: the outsider is refused (403 agent_not_available)');

    // ── Ask first ──
    dataOf(await manager.put(`/api/workspace/agents/${gate.agent.id}/access`, { ask_first: true }), 200, 'the manager turns on ask first');
    const insiderTask = dataOf(await insiderKey.post('/api/v1/tasks', { project_id: project.id, title: `Insider's own task ${tag}` }), 201, 'insider makes a task');
    const managerBefore = (await needsYou(manager)).length;
    const asked = await insiderKey.post(`/api/v1/tasks/${insiderTask.id}/delegate`, { agent_id: gate.agent.id, title: 'Draft the release notes' });
    equal(asked.status, 202, 'a request under ask first waits');
    const approvalId = asked.body.data?.approval_id;
    check(approvalId && asked.body.data.status === 'awaiting_approval', 'The answer names the approval it waits on', asked.body);
    const again = await insiderKey.post(`/api/v1/tasks/${insiderTask.id}/delegate`, { agent_id: gate.agent.id, title: 'Draft the release notes' });
    equal(again.status, 202, 'asking again still waits');
    equal(again.body.data?.approval_id, approvalId, 'asking again reuses the same approval');
    const approvals = (await ctx.db.query(`SELECT id, asked_to FROM pm.questions WHERE kind = 'approval' AND action->>'type' = 'agent.use' AND status = 'open' AND action->'details'->>'key' LIKE $1`, [`${gate.agent.id}:%`])).rows;
    equal(approvals.length, 1, 'open agent.use approvals for the agent');
    equal(approvals[0].asked_to, manager.memberId, 'the approval goes to the agent\'s owner');
    const managerWaiting = await needsYou(manager);
    equal(managerWaiting.length, managerBefore + 1, 'manager Needs you with one approval');
    step(`Ask first: the insider's request waits on one approval (asked twice, still one) in ${manager.name}'s Needs you`);

    const decided = dataOf(await manager.post(`/api/workspace/questions/${approvalId}/answer`, { choice: 'approve' }), 200, 'the manager approves in the app');
    equal(decided.decision, 'approved', 'decision');
    equal((await needsYou(manager)).length, managerBefore, 'manager Needs you after approving');
    const through = await insiderKey.post(`/api/v1/tasks/${insiderTask.id}/delegate`, { agent_id: gate.agent.id, title: 'Draft the release notes' });
    equal(through.status, 201, 'the approved request goes through');
    equal(through.body.data?.delegated_to, gate.agent.id, 'delegated to the agent');
    step('The manager approved in the app; the same request now goes through (201)');

    const once = await insiderKey.post(`/api/v1/tasks/${insiderTask.id}/delegate`, { agent_id: gate.agent.id, title: 'Draft the release notes' });
    equal(once.status, 202, 'the same request a second time waits again');
    const second: Json = once.body.data;
    check(second.approval_id && second.approval_id !== approvalId, 'A used approval lets a request through once: the repeat needs a new one', { first: approvalId, second });
    step('An approval lets a request through once: the repeat waits on a new approval');
  },
};

export default scenario;
