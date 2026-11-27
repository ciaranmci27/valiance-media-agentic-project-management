/**
 * 2. From a company chat message to a finished task, across two agents and
 * a person:
 *
 * a person writes to the company bot (a test Telegram connection; the
 * provider's request is simulated with its real secret-token header) ->
 * routed to the orchestrator -> the orchestrator starts a run, makes a task
 * and delegates a subtask to its specialist (delegate_task with run_id) ->
 * the specialist claims it and starts a child run (parent_run_id) -> hits a
 * blocker and asks its orchestrator -> the orchestrator asks the person for
 * an approval -> the person approves in the app (the session route the hub
 * uses) -> the event feed (GET /api/v1/events, cursor + wait) delivers
 * question.answered to the orchestrator -> it answers its specialist, whose
 * own wait wakes -> the specialist finishes -> the task is done.
 *
 * At each step the person's Needs you (open questions asked to them), their
 * unread badge and the notices behind them are checked.
 */
import { randomInt } from 'node:crypto';
import { seal } from '../../src/lib/crypto/app-key';
import {
  OWNER_SETUP_SCOPES, check, dataOf, equal, hire, http, makeProject, personalKey, step, tag, uuid, waitFor,
  type Ctx, type Json, type KeyCaller, type Person,
} from './harness';
import type { Scenario } from './run';

/** The work scopes an orchestrator or specialist key carries. */
export const AGENT_WORK_SCOPES = [
  'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'agent_activity.write', 'team.read',
  'questions.ask', 'notifications.manage_own',
];

export interface TestChat {
  connectionId: string;
  /** Sends one Telegram DM from this account to the company bot, as Telegram's webhook would. */
  dm: (fromTelegramId: number, text: string) => Promise<{ status: number; body: Json }>;
}

/** A company Telegram connection with made-up credentials, its default agent, and identities linked by an admin. */
export async function companyTelegram(ctx: Ctx, defaultAgentId: string, agentIds: string[] = []): Promise<TestChat> {
  const connectionId = uuid();
  const secretToken = `e2e${tag}${uuid().replace(/-/g, '')}`;
  const credentials = { bot_token: `${randomInt(10_000, 99_999)}:E2E${uuid().replace(/-/g, '')}`, secret_token: secretToken };
  // Sealed with the app key exactly as Settings > Chat seals a pasted token (AAD: the connection id).
  const sealed = seal('chat', JSON.stringify(credentials), connectionId, { APP_ENCRYPTION_KEY: ctx.env.APP_ENCRYPTION_KEY });
  await ctx.db.query(
    `INSERT INTO pm.chat_connections (id, provider, display_name, bot_handle, credentials, kind, enabled, created_by)
     VALUES ($1, 'telegram', $2, $3, $4, 'company', true, $5)`,
    [connectionId, `E2E company bot ${tag}`, `e2e_${tag}_bot`, sealed, ctx.people.owner.memberId],
  );
  ctx.cleanup.add(`remove chat connection ${connectionId}`, async () => {
    await ctx.db.query(`DELETE FROM pm.chat_connection_agents WHERE connection_id = $1`, [connectionId]);
    await ctx.db.query(`UPDATE pm.chat_connections SET enabled = false WHERE id = $1`, [connectionId]);
  });
  for (const agentId of [defaultAgentId, ...agentIds]) {
    await ctx.db.query(`INSERT INTO pm.chat_connection_agents (connection_id, agent_id, is_default) VALUES ($1, $2, $3)`, [connectionId, agentId, agentId === defaultAgentId]);
  }
  let updateId = randomInt(1_000_000, 9_000_000);
  return {
    connectionId,
    dm: async (fromTelegramId, text) => {
      updateId += 1;
      const update = {
        update_id: updateId,
        message: {
          message_id: updateId, date: Math.floor(Date.now() / 1000), text,
          from: { id: fromTelegramId, is_bot: false, first_name: 'E2E', username: `e2e_${fromTelegramId}` },
          chat: { id: fromTelegramId, type: 'private' },
        },
      };
      return http(ctx.baseUrl, `/api/chat/inbound/${connectionId}`, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secretToken }, body: update });
    },
  };
}

/** Links a person's Telegram account to them, verified by an admin (Settings > Chat accounts). */
export async function linkTelegram(ctx: Ctx, person: Person): Promise<number> {
  const telegramId = randomInt(100_000_000, 999_999_999);
  await ctx.db.query(
    `INSERT INTO pm.member_identities (member_id, provider, external_id, handle, verified_at, verified_method, created_by)
     VALUES ($1, 'telegram', $2, $3, now(), 'admin', $4)`,
    [person.memberId, String(telegramId), `@e2e_${telegramId}`, ctx.people.owner.memberId],
  );
  ctx.cleanup.add(`unlink telegram ${telegramId}`, () => ctx.db.query(`DELETE FROM pm.member_identities WHERE provider = 'telegram' AND external_id = $1`, [String(telegramId)]));
  return telegramId;
}

/** The person's Needs you questions: open questions asked to them, as My Tasks and the sidebar count read them. */
export async function needsYou(person: Person): Promise<Json[]> {
  const open = dataOf(await person.get('/api/workspace/questions'), 200, `${person.name} reads their questions`) as Json[];
  return open.filter((question) => question.asked_to === person.memberId && question.status === 'open');
}

export async function unreadBadge(person: Person): Promise<number> {
  return dataOf(await person.get('/api/workspace/notifications?count=1'), 200, `${person.name} reads the badge`).unread;
}

/** The newest cursor of an agent's event feed (from now). */
export async function feedCursor(agent: KeyCaller, types: string): Promise<string> {
  const head = await agent.get(`/api/v1/events?types=${types}`);
  check(head.status === 200 && head.body?.meta?.next_cursor, `${agent.label} reads the event feed head`, head.body);
  return head.body.meta.next_cursor;
}

/** Waits on the event feed (the route's own long poll, at most 20 s per call) until an event matches. */
export async function nextEvent(agent: KeyCaller, cursor: string, types: string, match: (event: Json) => boolean, timeoutMs = 45_000): Promise<{ event: Json; cursor: string }> {
  const deadline = Date.now() + timeoutMs;
  let at = cursor;
  while (Date.now() < deadline) {
    const answer = await agent.get(`/api/v1/events?types=${types}&since=${encodeURIComponent(at)}&wait=20`);
    check(answer.status === 200, `${agent.label} event feed answered HTTP ${answer.status}`, answer.body);
    const found = (answer.body.data as Json[]).find(match);
    if (found) return { event: found, cursor: answer.body.meta.next_cursor };
    at = answer.body.meta.next_cursor ?? at;
  }
  throw new Error(`${agent.label}: no matching ${types} event within ${timeoutMs} ms`);
}

const scenario: Scenario = {
  name: 'Company chat to a finished task through orchestrator, specialist and a person',
  async run(ctx: Ctx) {
    const { owner, requester } = ctx.people;
    const ownerKey = (await personalKey(ctx, owner, OWNER_SETUP_SCOPES, 'owner setup')).caller;
    const project = await makeProject(ctx, ownerKey, 'Chat flow', [requester.memberId]);

    const orch = await hire(ctx, { name: `E2E Orchestrator ${tag}`, project_ids: [project.id], scopes: [...AGENT_WORK_SCOPES, 'tasks.manage_all'] });
    const spec = await hire(ctx, { name: `E2E Specialist ${tag}`, project_ids: [project.id], scopes: AGENT_WORK_SCOPES });
    const access = dataOf(await owner.put(`/api/workspace/agents/${spec.agent.id}/access`, { orchestrator_id: orch.agent.id, reachable_directly: false }), 200, 'set the specialist under its orchestrator');
    equal(access.orchestrator_id ?? access.access?.orchestrator_id, orch.agent.id, 'specialist orchestrator');
    step(`Owner hired an orchestrator and a specialist that takes work only through it`);

    for (const agent of [orch, spec]) dataOf(await agent.key.post('/api/v1/agents/heartbeat', { working: true }), 200, `${agent.agent.name} heartbeat`);
    step('Both agents report working (heartbeat)');

    const chat = await companyTelegram(ctx, orch.agent.id);
    const telegramId = await linkTelegram(ctx, requester);
    const baseline = { needs: (await needsYou(requester)).length, unread: await unreadBadge(requester) };
    step(`Company Telegram bot connected with the orchestrator as default; ${requester.name} linked (Needs you ${baseline.needs}, unread ${baseline.unread})`);

    // ── The person asks in chat ──
    const sent = await chat.dm(telegramId, 'Please publish the spring landing page today.');
    equal(sent.status, 200, 'Telegram webhook answer');
    check(['pending', 'notified'].includes(sent.body?.status), 'The DM is routed to an agent', sent.body);
    const recorded = (await ctx.db.query(`SELECT agent_id, member_id, route, status FROM pm.chat_messages WHERE id = $1`, [sent.body.id])).rows[0];
    equal(recorded.agent_id, orch.agent.id, 'the DM goes to the orchestrator');
    equal(recorded.member_id, requester.memberId, 'the DM is from the requester');
    equal(recorded.route, 'direct', 'route');
    const replay = await chat.dm(telegramId, 'x');
    check(replay.status === 200, 'A second DM is taken', replay.body);
    step(`Telegram DM recorded for the orchestrator (route direct, ${sent.body.status})`);

    const inbox = dataOf(await orch.key.get('/api/v1/chat/messages?status=all&limit=20'), 200, 'orchestrator reads chat');
    const message = (inbox.messages as Json[]).find((m) => m.id === sent.body.id);
    check(message && /spring landing page/.test(message.text), 'The orchestrator reads the DM over the API', inbox);
    step('Orchestrator read the DM (GET /api/v1/chat/messages)');

    // ── Orchestrator: run, task, delegate ──
    const run = dataOf(await orch.key.post('/api/v1/agents/runs', { title: 'Publish the spring landing page', project_id: project.id, trigger: 'chat' }), 201, 'orchestrator starts a run');
    const task = dataOf(await orch.key.post('/api/v1/tasks', { project_id: project.id, title: `Publish the spring landing page ${tag}`, assignee_ids: [orch.agent.id], status: 'in_progress' }), 201, 'orchestrator makes the task');
    dataOf(await orch.key.post(`/api/v1/chat/messages/${sent.body.id}/handled`), 200, 'mark the DM handled');
    const delegated = dataOf(await orch.key.post(`/api/v1/tasks/${task.id}/delegate`, {
      agent_id: spec.agent.id, mode: 'subtask', title: 'Build and publish the landing page', run_id: run.id, acceptance_criteria: ['Page is live'],
    }), 201, 'orchestrator delegates to its specialist');
    const subtaskId = delegated.task_id ?? delegated.id;
    equal(delegated.delegated_to, spec.agent.id, 'delegated to');
    equal(delegated.run_id, run.id, 'delegation run');
    step(`Orchestrator started run ${run.id.slice(0, 8)}, made the task and delegated a subtask (run_id set)`);

    // ── Specialist: claim and child run ──
    const brief = dataOf(await spec.key.get(`/api/v1/tasks/${subtaskId}/brief`), 200, 'specialist reads the brief');
    equal(brief.delegated_from?.run_id, run.id, 'the brief carries the delegating run');
    const claimed = dataOf(await spec.key.post(`/api/v1/tasks/${subtaskId}/claim`, { lease_minutes: 30 }), 200, 'specialist claims');
    check(claimed.claimed_by === spec.agent.id || JSON.stringify(claimed).includes(spec.agent.id), 'The claim is the specialist\'s', claimed);
    const otherClaim = await orch.key.post(`/api/v1/tasks/${subtaskId}/claim`, {});
    check(otherClaim.status === 409 || otherClaim.status === 403, 'A second agent cannot claim it while held', otherClaim.body);
    const child = dataOf(await spec.key.post('/api/v1/agents/runs', { title: 'Build the page', task_id: subtaskId, parent_run_id: run.id }), 201, 'specialist starts a child run');
    equal(child.parent_run_id, run.id, 'child run parent');
    step('Specialist read the brief, claimed the subtask (a second claim is refused) and started a child run');

    // ── Blocker: specialist asks its orchestrator ──
    const orchCursor = await feedCursor(orch.key, 'question.answered');
    const specCursor = await feedCursor(spec.key, 'question.answered');
    const blocker = dataOf(await spec.key.post('/api/v1/questions', {
      question: 'Publishing needs a sign-off on the hero copy. May I publish?', task_id: subtaskId, asked_to: orch.agent.id, run_id: child.id,
    }), 201, 'specialist asks its orchestrator');
    equal(blocker.asked_to, orch.agent.id, 'blocker asked to');
    const orchQuestions = dataOf(await orch.key.get('/api/v1/questions?status=open&asked_to=me'), 200, 'orchestrator lists its questions');
    check((orchQuestions as Json[]).some((q) => q.id === blocker.id), 'The orchestrator sees the blocker', orchQuestions);
    const orchBell = dataOf(await orch.key.get('/api/v1/notifications?limit=50'), 200, 'orchestrator notifications');
    const bellItems = Array.isArray(orchBell) ? orchBell : orchBell.items ?? orchBell.notifications ?? [];
    check(bellItems.some((n: Json) => n.entity_id === blocker.id), 'The orchestrator has a notice for the blocker', orchBell);
    equal((await needsYou(requester)).length, baseline.needs, 'requester Needs you while agents talk');
    step('Specialist asked its orchestrator; the orchestrator sees it and has a notice; the person is not bothered yet');

    // ── Orchestrator asks the person ──
    const approval = dataOf(await orch.key.post('/api/v1/approvals', {
      action: { type: 'page.publish', summary: 'Publish the spring landing page' }, question: 'Can I publish the spring landing page today?',
      asked_to: requester.memberId, task_id: task.id, run_id: run.id,
    }), 201, 'orchestrator requests approval');
    const waiting = await needsYou(requester);
    equal(waiting.length, baseline.needs + 1, 'requester Needs you after the approval request');
    check(waiting.some((q) => q.id === approval.id && q.kind === 'approval'), 'The approval is in the requester\'s Needs you', waiting);
    equal(await unreadBadge(requester), baseline.unread, 'a Needs you notice is a receipt, never an unread update');
    const receipt = (await ctx.db.query(`SELECT category, cleared_at FROM pm.team_member_notifications WHERE user_id = $1 AND entity_id = $2`, [requester.memberId, approval.id])).rows;
    check(receipt.length === 1 && receipt[0].category === 'approval_requested' && !receipt[0].cleared_at, 'One approval_requested notice for the requester', receipt);
    step(`Orchestrator asked ${requester.name} to approve: Needs you ${baseline.needs} -> ${waiting.length}, unread badge unchanged`);

    // ── The person answers in the app; the orchestrator's wait wakes ──
    const orchWait = nextEvent(orch.key, orchCursor, 'question.answered', (event) => event.subject?.id === approval.id);
    const answered = dataOf(await requester.post(`/api/workspace/questions/${approval.id}/answer`, { choice: 'approve' }), 200, 'requester approves in the app');
    equal(answered.status, 'answered', 'approval status');
    equal(answered.decision ?? answered.answer_choice, answered.decision ? 'approved' : 'approve', 'approval decision');
    const { event: approvedEvent } = await orchWait;
    equal(approvedEvent.type, 'question.answered', 'event type');
    equal(approvedEvent.data?.question?.status, 'answered', 'event question status');
    // The event is a pointer: the agent reads the decision where it says.
    const decided = dataOf(await orch.key.get(approvedEvent.read.path), 200, 'orchestrator reads the decision');
    equal(decided.decision, 'approved', 'decision the orchestrator reads');
    equal((await needsYou(requester)).length, baseline.needs, 'requester Needs you after answering');
    const cleared = (await ctx.db.query(`SELECT cleared_at FROM pm.team_member_notifications WHERE user_id = $1 AND entity_id = $2`, [requester.memberId, approval.id])).rows;
    check(cleared.length === 1 && cleared[0].cleared_at, 'The approval notice clears once answered', cleared);
    step(`${requester.name} approved in the app; the orchestrator's event feed delivered question.answered; Needs you back to ${baseline.needs}, notice cleared`);

    // ── Orchestrator unblocks its specialist; the specialist's wait wakes ──
    const specWait = nextEvent(spec.key, specCursor, 'question.answered', (event) => event.subject?.id === blocker.id);
    dataOf(await orch.key.post(`/api/v1/questions/${blocker.id}/answer`, { text: 'Approved by the requester. Publish it.' }), 200, 'orchestrator answers the specialist');
    const { event: unblocked } = await specWait;
    equal(unblocked.type, 'question.answered', 'specialist event type');
    const orchBellAfter = (await ctx.db.query(`SELECT cleared_at FROM pm.team_member_notifications WHERE user_id = $1 AND entity_id = $2`, [orch.agent.id, blocker.id])).rows;
    check(orchBellAfter.every((row) => row.cleared_at), 'The orchestrator\'s notice for the blocker clears once answered', orchBellAfter);
    step('Orchestrator answered its specialist; the specialist\'s event feed delivered question.answered');

    // ── Finish ──
    const subDone = dataOf(await spec.key.patch(`/api/v1/tasks/${subtaskId}`, { status: 'done' }), 200, 'specialist finishes the subtask');
    check(['done', 'in_review'].includes(subDone.status), 'The subtask is finished', subDone);
    dataOf(await spec.key.post(`/api/v1/agents/runs/${child.id}/finish`, { summary: 'Published' }), 200, 'specialist finishes its run');
    if (subDone.status === 'in_review') dataOf(await orch.key.patch(`/api/v1/tasks/${subtaskId}`, { status: 'done' }), 200, 'orchestrator accepts the review');
    const parentDone = dataOf(await orch.key.patch(`/api/v1/tasks/${task.id}`, { status: 'done' }), 200, 'orchestrator finishes the task');
    equal(parentDone.status, 'done', 'task status');
    dataOf(await orch.key.post(`/api/v1/agents/runs/${run.id}/finish`, { summary: 'Landing page published' }), 200, 'orchestrator finishes its run');
    const tree = dataOf(await orch.key.get(`/api/v1/agents/runs/${run.id}/tree`), 200, 'run tree');
    const childRow = (tree.runs as Json[]).find((r) => r.id === child.id);
    check(childRow && childRow.parent_run_id === run.id && childRow.status === 'succeeded', 'The run tree holds the finished child run under the orchestrator\'s', tree);
    check((tree.runs as Json[]).find((r) => r.id === run.id)?.delegated?.some((d: Json) => d.delegated_to === spec.agent.id), 'The tree records the delegation', tree);
    const finalTasks = (await ctx.db.query(`SELECT id, status, completed_at FROM pm.tasks WHERE id = ANY($1)`, [[task.id, subtaskId]])).rows;
    check(finalTasks.length === 2 && finalTasks.every((row) => row.status === 'done' && row.completed_at), 'Both tasks are done with a completion time', finalTasks);
    equal((await needsYou(requester)).length, baseline.needs, 'requester Needs you at the end');
    step(`Specialist and orchestrator finished; task and subtask done; run tree has 2 levels; Needs you ${baseline.needs}`);
  },
};

export default scenario;
