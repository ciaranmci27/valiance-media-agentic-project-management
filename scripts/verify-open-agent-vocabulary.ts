/**
 * The open agent vocabulary (20261124000600_open_agent_vocabulary.sql)
 * through the real v1 API (withApi, supabase-js, a fake PostgREST over
 * PGlite), and over MCP:
 * - Approvals: a question of kind approval. Request on a task; the bell says
 *   "Approval request from ..."; My Tasks lists it for the person asked; only
 *   the person asked or the Owner decides (a team manager and the asker are
 *   refused); approve or reject with a note; polling reads the decision; the
 *   question.* webhooks carry kind, action, decision and decided_by; expiry
 *   reads as no decision; an agent is never the approver; MCP
 *   request_approval and get_approval. A plain question reads, rings and
 *   webhooks exactly as before.
 * - Reviews: a pull request review behaves as before (one verdict per
 *   commit, rounds per PR, latest_review is the stored row); a review
 *   without a PR records a verdict and notes with its own rounds; one of
 *   pr_url and head_sha alone is refused.
 * - Events: note and custom.<namespace>.<name> are stored with their plain,
 *   bounded title; malformed ones are refused; every known type still
 *   validates and keeps its exact title; an invalid known event gets the
 *   same answer as before; open events never move an agent's state, and
 *   analytics totals are the same with or without them.
 * - Profiles: core profiles keep their tool sets, an install's profile sees
 *   the tools it lists, an unknown profile is refused on write and sees only
 *   pm_guide if stored, and the database checks only the value's shape.
 * - The migration on the schema before it matches schema.sql and runs twice.
 *
 *   npm run -s test:open-agent-vocabulary
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import type { AgentActivity, TeamMember } from '../src/lib/types';

const MIGRATION = '20261124000600_open_agent_vocabulary.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- OPEN AGENT VOCABULARY (20261124000600_open_agent_vocabulary.sql)';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };

const SHA_1 = 'a'.repeat(40);
const SHA_2 = 'B'.repeat(40);
const PR = 'https://github.com/acme/shop/pull/12';

/** A plain question's fields, in order, as the API has always answered them. */
const QUESTION_VIEW_KEYS = ['id', 'project_id', 'project_name', 'task_id', 'task_title', 'asked_by', 'asked_by_name', 'asked_to', 'asked_to_name',
  'question', 'choices', 'allow_other', 'status', 'answer_choice', 'answer_text', 'answered_by', 'answered_by_name', 'answered_at', 'cancelled_by',
  'cancelled_at', 'expires_at', 'created_at', 'updated_at', 'can_answer', 'can_cancel'];
/** A task's open_question, as GET /tasks/:id has always carried it. */
const OPEN_QUESTION_KEYS = ['id', 'question', 'choices', 'allow_other', 'asked_by', 'asked_to', 'expires_at', 'created_at', 'asked_by_name', 'asked_to_name'];
/** A question webhook's question object before approvals. */
const QUESTION_WEBHOOK_KEYS = ['id', 'project_id', 'task_id', 'asked_by', 'asked_to', 'question', 'choices', 'allow_other', 'status', 'answer_choice',
  'answer_text', 'answered_by', 'answered_at', 'cancelled_by', 'cancelled_at', 'expires_at', 'created_at', 'updated_at', 'deleted_at'];

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string) =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const builder = await member('Builder', 'agent');
  const reviewer = await member('Reviewer', 'agent');
  const helper = await member('Helper', 'agent');
  const scout = await member('Scout', 'agent');
  const morgan = await member('Morgan', 'member');
  const max = await member('Max', 'member');
  // Helper escalates to another agent: an approval has no one to go to by default.
  await q('UPDATE pm.team_members SET agent_escalate_to = $1 WHERE id = $2', [builder, helper]);
  const apex = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  for (const m of [builder, reviewer, helper, scout, morgan, max]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [apex, m]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  const AGENT = ['tasks.read', 'tasks.manage_assigned', 'projects.read', 'project_context.read', 'files.read', 'agent_activity.write', 'audit.read'];
  const keys = {
    owner: await key(owner, ['tasks.read', 'projects.read', 'projects.read_all', 'team.manage', 'agents.manage']),
    builder: await key(builder, AGENT),
    reviewer: await key(reviewer, [...AGENT, 'tasks.manage_all']),
    helper: await key(helper, AGENT),
    scout: await key(scout, AGENT),
    morgan: await key(morgan, ['tasks.read', 'projects.read']),
    max: await key(max, ['tasks.read', 'projects.read', 'team.manage']),
  };
  const task = async (title: string, assignees: string[] = [builder]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [apex, title]))[0].id;
    for (const m of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  return { q, owner, builder, reviewer, helper, scout, morgan, max, apex, keys, task };
}

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the open agent vocabulary section is there', at > 0 && banner > 0);
  check('schema.sql: the section mirrors the migration body',
    SCHEMA_SQL.slice(at).includes(MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('ALTER TABLE pm.questions\n  ADD COLUMN IF NOT EXISTS kind')).trim()));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const oq = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const [asker, person] = [
    (await oq<{ id: string }>("INSERT INTO pm.team_members (name, email, role, agent_profile) VALUES ('Fleet', 'fleet@example.com', 'agent', 'reviewer') RETURNING id"))[0].id,
    (await oq<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'owner') RETURNING id"))[0].id,
  ];
  const before = (await oq<{ id: string }>("INSERT INTO pm.questions (asked_by, asked_to, question, choices) VALUES ($1, $2, 'Up or down?', '[\"Up\",\"Down\"]') RETURNING id", [asker, person]))[0].id;
  await oq("INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata) VALUES ($1, 'work.claimed', 'Claimed: x', '{\"task_title\":\"x\"}')", [asker]);
  await applyMigrationsFrom(old, MIGRATION);
  const kept = (await oq('SELECT kind, action FROM pm.questions WHERE id = $1', [before]))[0];
  check('upgrade: a question asked before reads as kind question, with no action', kept?.kind === 'question' && kept.action === null, kept);
  check('upgrade: stored profiles and activity types are kept', (await oq("SELECT 1 FROM pm.team_members WHERE agent_profile = 'reviewer'")).length === 1
    && (await oq("SELECT 1 FROM pm.agent_activities WHERE activity_type = 'work.claimed'")).length === 1);
  // What the previous release does still works: it asks without kind or action.
  const after = (await oq<{ kind: string }>("INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Ship it?') RETURNING kind", [asker, person]))[0];
  check('upgrade: the previous release still asks plain questions', after?.kind === 'question', after);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await old.close();
  await fresh.close();
}

/** One realistic payload per known type, and the exact title it has always had. */
const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const T0 = '2026-11-20T10:00:00+00:00';
const T1 = '2026-11-20T10:04:00+00:00';
const KNOWN_EVENTS: Record<string, { payload: Record<string, unknown>; title: string }> = {
  'work.claimed': { payload: { task_id: TASK_ID, task_title: 'Fix the checkout total' }, title: 'Claimed: Fix the checkout total' },
  'work.milestone': { payload: { task_id: TASK_ID, kind: 'commit', detail: 'Round per line' }, title: 'Committed: Round per line' },
  'work.handoff': { payload: { task_title: 'Fix the checkout total', pr_url: PR, round: 2 }, title: 'PR #12 ready for review (round 2)' },
  'work.done': { payload: { task_title: 'Fix the checkout total' }, title: 'Finished: Fix the checkout total' },
  'pr.merged': { payload: { pr_url: PR, additions: 10, deletions: 2, head_sha: SHA_1 }, title: 'Merged PR #12' },
  'usage.recorded': { payload: { source_usage_id: 'u-1', model: 'claude-opus', input_tokens: 1000, output_tokens: 200, cost_usd: 0.1, recorded_at: T1 }, title: 'Recorded 1200 tokens for claude-opus' },
  'turn.completed': { payload: { source_turn_id: 'cron:t1', origin: 'scheduled', duration_ms: 95000, started_at: T0, finished_at: T1, outcome: 'work' }, title: 'Ran 1m 35s (scheduled)' },
  'turn.outcome': { payload: { source_turn_id: 'cron:t9', outcome: 'idle' }, title: 'Turn labelled idle' },
  'turn.failed': { payload: { source_turn_id: 'cron:f1', failure: 'dead', started_at: T0, finished_at: T1, duration_ms: 240000, error: 'gone', job_name: 'Work', trigger: 'schedule' }, title: 'Turn died mid-run: Work' },
  'agent.restarted': { payload: { kind: 'container', started_at: T0, deploy_commit: 'abc1234', source_ref: 'restart:container:t0' }, title: 'Container restarted' },
  'attention.message': { payload: { kind: 'blocking_question', at: T1, solicited: false, session_id: 's1', source_ref: 'attention:s1:c1' }, title: 'Asked a blocking question' },
  'dispatch.wake': { payload: { kind: 'state_change', at: T1, waited_seconds: 42, source_ref: 'wake:t1' }, title: 'Woken by the dispatcher after 42s' },
  'billing.gap': { payload: { start: T0, end: T1, minutes: 4, phase: 'mid_turn', origin: 'scheduled', source_turn_id: 'cron:w1' }, title: 'Billing gap: 4 min mid turn' },
  'eval.result': { payload: { suite: 'finance', score: 18, total: 20, passed: 18, failed: 2, complete: true, model: 'gpt-b', started_at: '20261010T190000Z' }, title: 'Eval finance: 18/20' },
  'review.started': { payload: { task_title: 'Fix the checkout total', round: 1, pr_url: PR }, title: 'Review round 1 started: PR #12' },
  'review.verdict': { payload: { verdict: 'approved', round: 2, pr_url: PR, head_sha: SHA_1, findings: 0 }, title: 'Approved PR #12 (round 2)' },
  'audit.finding': { payload: { subject: 'Checkout', findings: 2, note: 'Two rounding paths' }, title: 'Audit found 2 issues: Checkout' },
  'audit.no_work': { payload: { reason: 'Nothing changed since the last audit' }, title: 'No eligible audit work: Nothing changed since the last audit' },
  'spec.completed': { payload: { subject: 'Refunds' }, title: 'Spec completed: Refunds' },
  'queue.empty': { payload: { queue: 'review' }, title: 'Nothing to review' },
  blocked: { payload: { task_id: TASK_ID, reason: 'Need the Stripe key' }, title: 'Blocked: Need the Stripe key' },
  'email.triaged': { payload: { message_id: TASK_ID, thread_id: TASK_ID, outcome: 'task', urgent: false, links: 1 }, title: 'Triaged email: task' },
  'billing.started': { payload: { task_id: TASK_ID, description: 'Checkout' }, title: 'Billing started: Checkout' },
  'billing.paused': { payload: { task_id: TASK_ID }, title: 'Billing paused' },
  'billing.resumed': { payload: { task_id: TASK_ID }, title: 'Billing resumed' },
  'billing.stopped': { payload: { task_id: TASK_ID }, title: 'Billing stopped' },
};

async function main() {
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const questionsRoute = await import('../src/app/api/v1/questions/route');
    const questionRoute = await import('../src/app/api/v1/questions/[id]/route');
    const answerRoute = await import('../src/app/api/v1/questions/[id]/answer/route');
    const approvalsRoute = await import('../src/app/api/v1/approvals/route');
    const approvalRoute = await import('../src/app/api/v1/approvals/[id]/route');
    const taskRoute = await import('../src/app/api/v1/tasks/[id]/route');
    const reviewsRoute = await import('../src/app/api/v1/tasks/[id]/reviews/route');
    const activitiesRoute = await import('../src/app/api/v1/agent-activities/route');
    const agentsRoute = await import('../src/app/api/v1/agents/route');
    const myContextRoute = await import('../src/app/api/v1/agents/me/context/route');
    const { PM_TOOLS, GUIDE_TOOL } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
    const { toolsFor } = await import('../src/lib/mcp/visibility');
    const profiles = await import('../src/lib/mcp/profiles');
    const extensionProfiles = await import('../src/lib/extensions/agent-profiles');
    const { listQuestions } = await import('../src/lib/api/questions');
    const { resolveMemberAccess, accessAllows } = await import('../src/lib/api/access');
    const { permissionAlternatives } = await import('../src/lib/api/middleware');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { computeNeedsYou } = await import('../src/lib/autonomy');
    const { API_ENDPOINT_PERMISSIONS, isModuleEnabled } = await import('../src/lib/access-control');
    const events = await import('../src/lib/agent-events');
    const { createAgentActivitySchema } = await import('../src/lib/schemas/agent-activity');
    const { createAgentSchema } = await import('../src/lib/schemas/team-members');
    const { classifyActivity } = await import('../src/lib/agent-status');
    const statusLib = await import('../src/lib/agent-status') as Loose;
    const questionsLib = await import('../src/lib/questions') as Loose;
    const lastMergeAt = statusLib.lastMergeAt as (rows: unknown[], projectId: string) => string | null;
    const approvalDetailRows = questionsLib.approvalDetailRows as (action: unknown) => { rows: { key: string; value: string }[]; hidden: number };
    const approvalTypeLabel = questionsLib.approvalTypeLabel as (type: string) => string;
    const APPROVAL_DETAIL_KEY_MAX = questionsLib.APPROVAL_DETAIL_KEY_MAX as number;
    const APPROVAL_DETAIL_VALUE_MAX = questionsLib.APPROVAL_DETAIL_VALUE_MAX as number;

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>,
      method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json() };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    // jsonb keeps its own key order; compare objects key by key.
    const sorted = (value: unknown): string => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y))) : v));
    const request = (apiKey: string, body: unknown) => call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, apiKey, body);
    const getApproval = (apiKey: string, id: string) => call(approvalRoute.GET, 'GET', `/api/v1/approvals/${id}`, { id }, apiKey);
    const ask = (apiKey: string, body: unknown) => call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, apiKey, body);
    const getQuestion = (apiKey: string, id: string) => call(questionRoute.GET, 'GET', `/api/v1/questions/${id}`, { id }, apiKey);
    const answer = (apiKey: string, id: string, body: unknown) => call(answerRoute.POST, 'POST', `/api/v1/questions/${id}/answer`, { id }, apiKey, body);
    const readTask = (apiKey: string, id: string) => call(taskRoute.GET, 'GET', `/api/v1/tasks/${id}`, { id }, apiKey);
    const review = (apiKey: string, id: string, body: unknown) => call(reviewsRoute.POST, 'POST', `/api/v1/tasks/${id}/reviews`, { id }, apiKey, body);
    const post = (apiKey: string, body: unknown) => call(activitiesRoute.POST, 'POST', '/api/v1/agent-activities', {}, apiKey, body);
    const bell = async (id: string) => s.q<Loose>("SELECT user_id, title, message, link, cleared_at FROM pm.team_member_notifications WHERE entity_type = 'question' AND entity_id = $1", [id]);
    const hooks = async (id: string) => s.q<Loose>("SELECT event_type, payload FROM pm.webhook_events WHERE resource_type = 'question' AND resource_id = $1 ORDER BY sequence", [id]);
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const tool = PM_TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      const parsed = tool.input.safeParse(args);
      if (!parsed.success) return { ok: false, invalid: parsed.error.issues };
      return outcomeResult(await tool.run(parsed.data as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), tool.write).structuredContent as Loose;
    };
    await s.q(`INSERT INTO pm.webhook_endpoints (name, url, secret, events)
      VALUES ('All', 'https://hooks.example.test/all', 'whsec_a', '{question.asked,question.answered,question.cancelled,review.submitted}')`);

    // =========================================================================================
    // Approvals
    // =========================================================================================
    const deploy = await s.task('Ship the checkout fix');
    const action = { type: 'deploy', summary: 'Deploy v2.3.0 to production', details: { commit: SHA_1, environment: 'production' } };
    const made = await request(s.keys.builder, { task_id: deploy, action });
    const a1 = made.body.data;
    check('approval: requested on a task, to the Owner by default, open with no decision', made.status === 201 && a1?.kind === 'approval'
      && a1.status === 'open' && a1.asked_to === s.owner && a1.task_id === deploy && a1.project_id === s.apex && a1.decision === null
      && a1.decided_by === null && JSON.stringify(a1.choices) === '["approve","reject"]' && a1.allow_other === false
      && a1.question === 'Deploy v2.3.0 to production' && sorted(a1.action) === sorted(action) && a1.can_answer === false && a1.can_cancel === true, made.body);
    const a1Bell = await bell(a1.id);
    check('approval: the bell rings for the person asked, as an approval request', a1Bell.length === 1 && a1Bell[0].user_id === s.owner
      && a1Bell[0].title === 'Approval request from Builder' && a1Bell[0].message === 'Deploy v2.3.0 to production' && a1Bell[0].link === '/my-tasks' && a1Bell[0].cleared_at === null, a1Bell);
    const withContext = await request(s.keys.builder, { action: { type: 'send_email', summary: 'Email the March invoice to Acme' }, question: 'They asked for it twice; the total is $4,200.', asked_to: s.morgan, project_id: s.apex });
    check('approval: on a project, to a named person, with context as its question', withContext.status === 201 && withContext.body.data?.task_id === null
      && withContext.body.data?.project_id === s.apex
      && withContext.body.data?.asked_to === s.morgan && withContext.body.data?.question === 'They asked for it twice; the total is $4,200.'
      && withContext.body.data?.action.summary === 'Email the March invoice to Acme', withContext.body);

    // A plain question beside it: exactly as before.
    const plain = await ask(s.keys.builder, { task_id: deploy, question: 'Round the EU total up or down?', choices: ['Up', 'Down'] });
    const p1 = plain.body.data;
    check('question: a plain question has exactly the fields it always had, in order', plain.status === 201
      && JSON.stringify(Object.keys(p1)) === JSON.stringify(QUESTION_VIEW_KEYS), Object.keys(p1 ?? {}));
    check('question: its bell reads as before', (await bell(p1.id))[0]?.title === 'Question from Builder');

    // Who may decide.
    const byManager = await answer(s.keys.max, a1.id, { choice: 'approve' });
    check('decide: a team manager may answer questions but not decide an approval', byManager.status === 403 && reason(byManager) === 'not_asked'
      && /Only the person asked, or the Owner/.test(byManager.body.error?.message), byManager.body);
    const managerOnPlain = await getQuestion(s.keys.max, p1.id);
    check('decide: the same manager still may answer the plain question (unchanged)', managerOnPlain.body.data?.can_answer === true, managerOnPlain.body.data?.can_answer);
    const byAsker = await answer(s.keys.builder, a1.id, { choice: 'approve' });
    check('decide: the agent that asked cannot approve its own request', byAsker.status === 403, byAsker.status);
    const noChoice = await answer(s.keys.owner, a1.id, { text: 'Looks fine' });
    check('decide: a note alone is not a decision', noChoice.status === 422 && reason(noChoice) === 'choice_required', noChoice.body);
    const maybe = await answer(s.keys.owner, a1.id, { choice: 'maybe' });
    check('decide: only approve or reject', maybe.status === 422 && reason(maybe) === 'unknown_choice', maybe.body);

    // My Tasks: the Owner's open approvals are theirs to decide in place.
    const ownerAccess = await resolveMemberAccess(getServiceClient(), s.owner);
    const ownerCtx = { db: getServiceClient(), access: ownerAccess!, memberId: s.owner, channel: 'app' as const };
    const open = (await listQuestions(ownerCtx, { status: 'open', offset: 0, limit: 200, oldestFirst: true })).rows;
    const needs = computeNeedsYou({ tasks: [], suggestions: [], projects: [], teamMemberId: s.owner, includeSuggestions: false, oversight: false, questions: open });
    const card = needs.find((item) => item.kind === 'question' && item.openQuestion?.id === a1.id);
    check('My Tasks: the approval is a "needs you" row the Owner can decide', !!card && card.openQuestion?.kind === 'approval' && card.openQuestion.can_answer === true, needs.map((n) => n.kind));

    // The task read carries it; a plain open question keeps its exact shape.
    const plainOnly = await s.task('Only a question here');
    await ask(s.keys.builder, { task_id: plainOnly, question: 'Which locale first?' });
    const plainTask = await readTask(s.keys.builder, plainOnly);
    check('task: a plain open_question has exactly the fields it always had', JSON.stringify(Object.keys(plainTask.body.data?.open_question ?? {})) === JSON.stringify(OPEN_QUESTION_KEYS), plainTask.body.data?.open_question);
    const approvalTask = await readTask(s.keys.builder, deploy);
    check('task: an approval as open_question adds kind and action', approvalTask.body.data?.open_question?.id === a1.id
      && approvalTask.body.data?.open_question.kind === 'approval' && approvalTask.body.data?.open_question.action?.type === 'deploy', approvalTask.body.data?.open_question);

    // The Owner decides.
    const decided = await answer(s.keys.owner, a1.id, { choice: 'Approve', text: 'Go after 6pm' });
    check('decide: the Owner approves with a note', decided.status === 200 && decided.body.data?.decision === 'approved' && decided.body.data?.answer_choice === 'approve'
      && decided.body.data?.decided_by === s.owner && decided.body.data?.decided_by_name === 'Olivia' && decided.body.data?.answer_text === 'Go after 6pm', decided.body);
    check('decide: deciding clears the bell', (await bell(a1.id))[0]?.cleared_at !== null);
    const twice = await answer(s.keys.owner, a1.id, { choice: 'reject' });
    check('decide: a second decision is 409', twice.status === 409 && reason(twice) === 'question_answered', twice.body);
    const polled = await getApproval(s.keys.builder, a1.id);
    check('poll: the agent reads the decision', polled.status === 200 && polled.body.data?.decision === 'approved' && polled.body.data?.status === 'answered', polled.body);
    const notApproval = await getApproval(s.keys.builder, p1.id);
    check('poll: a plain question is not an approval (404)', notApproval.status === 404, notApproval.body);
    const forMorgan = withContext.body.data?.id as string;
    const ownerInPlace = await answer(s.keys.owner, forMorgan, { choice: 'reject', text: 'Wait for the credit note' });
    check('decide: the Owner may decide in place of the person asked', ownerInPlace.status === 200 && ownerInPlace.body.data?.decision === 'rejected'
      && ownerInPlace.body.data?.decided_by === s.owner, ownerInPlace.body);

    // Webhooks.
    const a1Hooks = await hooks(a1.id);
    const askedHook = a1Hooks.find((e) => e.event_type === 'question.asked')?.payload.data.question;
    const answeredHook = a1Hooks.find((e) => e.event_type === 'question.answered')?.payload.data.question;
    check('webhooks: question.asked carries kind, action and no decision yet', askedHook?.kind === 'approval' && askedHook.action?.summary === action.summary
      && askedHook.decision === null && askedHook.decided_by === null, askedHook);
    check('webhooks: question.answered carries the decision and who decided', answeredHook?.decision === 'approved' && answeredHook.decided_by === s.owner, answeredHook);
    const plainHook = (await hooks(p1.id))[0]?.payload.data.question;
    check('webhooks: a plain question\'s payload has exactly the keys it always had', !!plainHook
      && JSON.stringify(Object.keys(plainHook).sort()) === JSON.stringify([...QUESTION_WEBHOOK_KEYS].sort()), Object.keys(plainHook ?? {}));

    // Expiry.
    const soon = await request(s.keys.builder, { action: { type: 'spend', summary: 'Buy a $49 font licence' }, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    await s.q("UPDATE pm.questions SET expires_at = now() - interval '1 minute' WHERE id = $1", [soon.body.data?.id]);
    const expired = await getApproval(s.keys.builder, soon.body.data?.id);
    check('expiry: an approval past its time reads expired, with no decision', expired.body.data?.status === 'expired' && expired.body.data?.decision === null, expired.body);
    const late = await answer(s.keys.owner, soon.body.data?.id, { choice: 'approve' });
    check('expiry: it can no longer be decided', late.status === 409 && reason(late) === 'question_expired', late.body);
    const past = await request(s.keys.builder, { action: { type: 'spend', summary: 'x' }, expires_at: '2020-01-01T00:00:00Z' });
    check('expiry: an expiry in the past is refused', past.status === 422 && reason(past) === 'expires_in_past', past.body);

    // Who can be asked, and what a request must say.
    const toAgent = await request(s.keys.builder, { action: { type: 'merge', summary: 'Merge PR #12' }, asked_to: s.reviewer });
    check('ask: an agent is never the approver', toAgent.status === 422 && reason(toAgent) === 'approver_not_person', toAgent.body);
    const viaAgent = await request(s.keys.helper, { action: { type: 'merge', summary: 'Merge PR #12' } });
    check('ask: an escalation target that is an agent is refused too', viaAgent.status === 422 && reason(viaAgent) === 'approver_not_person', viaAgent.body);
    for (const [label, body] of [
      ['a type with capitals and spaces', { action: { type: 'Deploy Now', summary: 'x' } }],
      ['an empty summary', { action: { type: 'deploy', summary: '  ' } }],
      ['a summary over 300 characters', { action: { type: 'deploy', summary: 'x'.repeat(301) } }],
      ['details over 4000 characters', { action: { type: 'deploy', summary: 'x', details: { blob: 'x'.repeat(4000) } } }],
      ['a field the action does not know', { action: { type: 'deploy', summary: 'x', amount: 5 } }],
      ['choices (an approval has its own)', { action: { type: 'deploy', summary: 'x' }, choices: ['Yes'] }],
      ['no action', { question: 'Can I?' }],
    ] as const) {
      const refused = await request(s.keys.builder, body);
      check(`request: ${label} is refused`, refused.status === 422, [refused.status, refused.body?.error]);
    }

    // The database holds the shape too, and kind and action never change.
    const badShape = await db.query("INSERT INTO pm.questions (asked_by, asked_to, question, kind, action, choices, allow_other) VALUES ($1, $2, 'x', 'approval', '{\"type\":\"deploy\",\"summary\":\"x\"}', '[\"Yes\"]', false)", [s.builder, s.owner]).then(() => 'stored', (e: Error) => e.message);
    check('db: an approval with other choices is refused', badShape !== 'stored', badShape);
    const noAction = await db.query("INSERT INTO pm.questions (asked_by, asked_to, question, kind, choices, allow_other) VALUES ($1, $2, 'x', 'approval', '[\"approve\",\"reject\"]', false)", [s.builder, s.owner]).then(() => 'stored', (e: Error) => e.message);
    check('db: an approval without an action is refused', noAction !== 'stored', noAction);
    await s.q("UPDATE pm.questions SET kind = 'question', action = NULL WHERE id = $1", [a1.id]);
    const still = (await s.q<Loose>('SELECT kind, action FROM pm.questions WHERE id = $1', [a1.id]))[0];
    check('db: kind and action never change once written', still.kind === 'approval' && still.action?.type === 'deploy', still);

    // Lists.
    const onlyApprovals = await call(questionsRoute.GET, 'GET', '/api/v1/questions?kind=approval&limit=100', {}, s.keys.builder);
    const onlyQuestions = await call(questionsRoute.GET, 'GET', '/api/v1/questions?kind=question&limit=100', {}, s.keys.builder);
    const both = await call(questionsRoute.GET, 'GET', '/api/v1/questions?limit=100', {}, s.keys.builder);
    check('list: kind=approval lists approvals only, kind=question plain ones only, and no kind both', onlyApprovals.body.data?.length >= 3
      && onlyApprovals.body.data?.every((r: Loose) => r.kind === 'approval') && onlyQuestions.body.data?.every((r: Loose) => r.kind === undefined)
      && both.body.data?.length === onlyApprovals.body.data?.length + onlyQuestions.body.data?.length, [onlyApprovals.body.data?.length, onlyQuestions.body.data?.length, both.body.data?.length]);
    const approvalsList = await call(approvalsRoute.GET, 'GET', '/api/v1/approvals?status=answered', {}, s.keys.builder);
    check('list: GET /approvals lists approvals, with the question filters', approvalsList.status === 200 && approvalsList.body.data?.length === 2
      && approvalsList.body.data?.every((r: Loose) => r.kind === 'approval' && r.status === 'answered'), approvalsList.body);
    const badKind = await call(questionsRoute.GET, 'GET', '/api/v1/questions?kind=poll', {}, s.keys.builder);
    check('list: an unknown kind is 400', badKind.status === 400, badKind.status);

    // MCP.
    const mcpAsk = await runTool(s.keys.builder, s.builder, 'request_approval', { action: { type: 'delete_data', summary: 'Delete 312 test orders' }, project_id: s.apex, idempotency_key: randomUUID() });
    const mcpGet = await runTool(s.keys.builder, s.builder, 'get_approval', { approval_id: mcpAsk?.data?.id });
    check('MCP: request_approval and get_approval', mcpAsk?.ok === true && mcpAsk?.data?.kind === 'approval' && mcpGet?.ok === true && mcpGet.data.decision === null
      && mcpGet.data.project_id === s.apex, [mcpAsk, mcpGet]);
    const mcpDecide = await runTool(s.keys.owner, s.owner, 'answer_question', { question_id: mcpAsk?.data?.id, choice: 'reject', text: 'Keep them for the audit' });
    const mcpAfter = await runTool(s.keys.builder, s.builder, 'get_approval', { approval_id: mcpAsk?.data?.id });
    check('MCP: decided through answer_question, read back with get_approval', mcpDecide?.ok === true && mcpAfter?.data?.decision === 'rejected'
      && mcpAfter.data.answer_text === 'Keep them for the audit', [mcpDecide, mcpAfter]);

    // =========================================================================================
    // Reviews
    // =========================================================================================
    const work = await s.task('Fix the EU rounding');
    const pr1 = await review(s.keys.reviewer, work, { verdict: 'changes_requested', summary: 'Rounds the total, not each line', pr_url: PR, head_sha: SHA_1 });
    const pr1Again = await review(s.keys.reviewer, work, { verdict: 'approved', summary: 'Different mind', pr_url: PR, head_sha: SHA_1 });
    check('PR review: round 1, and the same commit again answers the first verdict', pr1.status === 201 && pr1.body.data?.round === 1
      && pr1Again.status === 201 && pr1Again.body.data?.id === pr1.body.data?.id && pr1Again.body.data?.verdict === 'changes_requested', [pr1.body, pr1Again.body]);
    const pr2 = await review(s.keys.reviewer, work, { verdict: 'approved', summary: 'Per line now', pr_url: PR, head_sha: SHA_2 });
    check('PR review: the next commit is round 2, its SHA stored in lower case', pr2.status === 201 && pr2.body.data?.round === 2 && pr2.body.data?.head_sha === SHA_2.toLowerCase(), pr2.body);
    const afterPr = await readTask(s.keys.builder, work);
    const latest = afterPr.body.data?.latest_review;
    const LATEST_KEYS = ['id', 'round', 'verdict', 'summary', 'pr_url', 'head_sha', 'reviewer_member_id', 'created_at'];
    check('PR review: latest_review has its exact shape and the stored values, as before', !!latest
      && JSON.stringify(Object.keys(latest)) === JSON.stringify(LATEST_KEYS)
      && LATEST_KEYS.every((key) => JSON.stringify(latest[key]) === JSON.stringify(pr2.body.data[key]))
      && latest.head_sha === SHA_2.toLowerCase() && latest.pr_url === PR && latest.round === 2 && latest.verdict === 'approved'
      && latest.reviewer_member_id === s.reviewer, { latest, posted: pr2.body.data });
    const doc = await review(s.keys.reviewer, work, { verdict: 'changes_requested', summary: 'The runbook misses the rollback step' });
    check('work review: a verdict and notes with no PR, round 1 of its own', doc.status === 201 && doc.body.data?.pr_url === null && doc.body.data?.head_sha === null
      && doc.body.data?.round === 1 && doc.body.data?.summary === 'The runbook misses the rollback step', doc.body);
    const doc2 = await review(s.keys.reviewer, work, { verdict: 'approved', summary: 'Rollback added', pr_url: null, head_sha: null });
    check('work review: the next is round 2 (nulls read as left out)', doc2.status === 201 && doc2.body.data?.round === 2, doc2.body);
    const afterDoc = (await readTask(s.keys.builder, work)).body.data?.latest_review;
    check('work review: latest_review is now it, with no head_sha (a merge gate fails closed)', afterDoc?.id === doc2.body.data?.id && afterDoc.head_sha === null, afterDoc);
    const onlyUrl = await review(s.keys.reviewer, work, { verdict: 'approved', summary: 'x', pr_url: PR });
    const onlySha = await review(s.keys.reviewer, work, { verdict: 'approved', summary: 'x', head_sha: SHA_1 });
    check('reviews: pr_url without head_sha, or head_sha without pr_url, is refused', onlyUrl.status === 422 && onlySha.status === 422, [onlyUrl.status, onlySha.status]);
    const shortSha = await review(s.keys.reviewer, work, { verdict: 'approved', summary: 'x', pr_url: PR, head_sha: 'abc1234' });
    check('PR review: a short SHA is still refused', shortSha.status === 422, shortSha.status);
    const selfReview = await review(s.keys.builder, work, { verdict: 'approved', summary: 'Mine is fine' });
    check('reviews: an assignee still cannot review its own work', selfReview.status === 403, selfReview.status);
    const reviewHooks = await s.q<Loose>("SELECT payload FROM pm.webhook_events WHERE event_type = 'review.submitted' AND payload->'data'->'review'->>'id' = $1", [doc.body.data?.id]);
    check('work review: review.submitted carries null pr_url and head_sha', reviewHooks.length === 1 && reviewHooks[0].payload.data.review.pr_url === null
      && reviewHooks[0].payload.data.review.head_sha === null, reviewHooks);
    const loop = await s.task('Write the refund policy');
    for (let i = 0; i < 6; i++) await review(s.keys.reviewer, loop, { verdict: 'changes_requested', summary: `Round ${i + 1}` });
    const handed = (await s.q<Loose>('SELECT ai_readiness FROM pm.tasks WHERE id = $1', [loop]))[0];
    check('work review: past 5 rounds of changes, the task goes to a person, as PR reviews do', handed.ai_readiness === 'human_only', handed);
    const mcpDoc = await runTool(s.keys.reviewer, s.reviewer, 'submit_task_review', { task_id: work, verdict: 'approved', summary: 'Design matches the brief' });
    const mcpHalf = await runTool(s.keys.reviewer, s.reviewer, 'submit_task_review', { task_id: work, verdict: 'approved', summary: 'x', pr_url: PR });
    check('MCP: submit_task_review without a PR works; with only pr_url it is refused', mcpDoc?.ok === true && mcpDoc.data.pr_url === null && mcpHalf?.ok === false, [mcpDoc, mcpHalf]);

    // =========================================================================================
    // Events
    // =========================================================================================
    const evTask = await s.task('Check the backups');
    const note = await post(s.keys.builder, { activity_type: 'note', project_id: s.apex, payload: { title: '  Checked   the\nbackups <b>twice</b> ', task_id: evTask, detail: 'All 3 regions' } });
    check('note: stored with its title, made plain (one line, trimmed) and kept as text', note.status === 201 && note.body.data?.activity_type === 'note'
      && note.body.data?.title === 'Checked the backups <b>twice</b>' && note.body.data?.reference_type === 'task' && note.body.data?.reference_id === evTask
      && note.body.data?.metadata.detail === 'All 3 regions', note.body);
    const custom = await post(s.keys.builder, { activity_type: 'custom.acme.backup_checked', payload: { title: 'Backups verified in 3 regions', size_gb: 12, regions: ['eu', 'us', 'ap'] } });
    check('custom: stored with its title and its own fields', custom.status === 201 && custom.body.data?.activity_type === 'custom.acme.backup_checked'
      && custom.body.data?.title === 'Backups verified in 3 regions' && custom.body.data?.metadata.size_gb === 12 && custom.body.data?.metadata.regions.length === 3, custom.body);
    for (const [label, body] of [
      ['a title over 200 characters', { activity_type: 'note', payload: { title: 'x'.repeat(201) } }],
      ['an empty title', { activity_type: 'note', payload: { title: ' \n ' } }],
      ['no title', { activity_type: 'custom.acme.ping', payload: { size: 1 } }],
      ['a custom payload over 4000 characters', { activity_type: 'custom.acme.dump', payload: { title: 'x', blob: 'x'.repeat(4000) } }],
      ['a custom type with capitals', { activity_type: 'custom.Acme.ping', payload: { title: 'x' } }],
      ['a custom type without a name', { activity_type: 'custom.acme', payload: { title: 'x' } }],
      ['a custom type with four parts', { activity_type: 'custom.acme.a.b', payload: { title: 'x' } }],
      ['a made-up type', { activity_type: 'acme.ping', payload: { title: 'x' } }],
      ['a note with a non-uuid task_id', { activity_type: 'note', payload: { title: 'x', task_id: 'nope' } }],
    ] as const) {
      const refused = await post(s.keys.builder, body);
      check(`events: ${label} is refused`, refused.status === 422, [refused.status, refused.body?.error?.message]);
    }
    const mcpNote = await runTool(s.keys.builder, s.builder, 'log_activity', { activity_type: 'note', payload: { title: 'Rotated the API key' } });
    const mcpCustom = await runTool(s.keys.builder, s.builder, 'log_activity', { activity_type: 'custom.acme.key_rotated', payload: { title: 'Key rotated', key: 'stripe' } });
    const mcpBad = await runTool(s.keys.builder, s.builder, 'log_activity', { activity_type: 'note', payload: { detail: 'no title' } });
    check('MCP: log_activity takes note and custom events, and refuses one without a title', mcpNote?.ok === true && mcpNote.data.title === 'Rotated the API key'
      && mcpCustom?.ok === true && mcpCustom.data.activity_type === 'custom.acme.key_rotated' && mcpBad?.ok === false, [mcpNote, mcpCustom, mcpBad]);
    const badDbType = await db.query("INSERT INTO pm.agent_activities (agent_id, activity_type, title) VALUES ($1, 'Not A Type', 'x')", [s.builder]).then(() => 'stored', (e: Error) => e.message);
    check('db: an activity type of the wrong shape is refused', badDbType !== 'stored', badDbType);

    // Every known type: still valid, same title.
    check('known: every known type has a fixture here', events.AGENT_EVENT_TYPES.every((t) => t in KNOWN_EVENTS) && Object.keys(KNOWN_EVENTS).length === events.AGENT_EVENT_TYPES.length,
      events.AGENT_EVENT_TYPES.filter((t) => !(t in KNOWN_EVENTS)));
    for (const type of events.AGENT_EVENT_TYPES) {
      const fixture = KNOWN_EVENTS[type];
      const parsed = events.AGENT_EVENT_SCHEMAS[type].safeParse(fixture.payload);
      check(`known: ${type} validates and keeps its title`, parsed.success && events.formatEventTitle(type, parsed.data as Record<string, unknown>) === fixture.title,
        parsed.success ? events.formatEventTitle(type, parsed.data as Record<string, unknown>) : parsed.error.issues);
      check(`known: ${type} is not an open type`, !events.isOpenEventType(type));
      if (events.isServerEvent(type)) continue;
      const stored = await post(s.keys.builder, { activity_type: type, payload: fixture.payload });
      check(`known: ${type} is stored through the API with its title`, stored.status === 201 && stored.body.data?.title === fixture.title
        && stored.body.data?.activity_type === type, [stored.status, stored.body?.data?.title ?? stored.body?.error]);
    }
    const legacy = await post(s.keys.builder, { activity_type: 'task_started', title: 'Started the checkout fix' });
    check('known: a legacy write is still accepted', legacy.status === 201 && legacy.body.data?.title === 'Started the checkout fix', legacy.body);
    for (const body of [{ activity_type: 'blocked', payload: {} }, { activity_type: 'nonsense', payload: { title: 'x' } }, { activity_type: 'work.claimed' }]) {
      const refused = await post(s.keys.builder, body);
      const expected = createAgentActivitySchema.safeParse(body);
      check(`known: an invalid ${body.activity_type} gets exactly the answer it got before`, refused.status === 422 && !expected.success
        && JSON.stringify(refused.body.error?.details) === JSON.stringify(expected.error.issues), refused.body);
    }

    // State: an open event never moves an agent's mood.
    const classify = (type: string, title: string) => classifyActivity({ activity_type: type, title, created_at: new Date().toISOString() } as never);
    check('state: a note titled "Blocked: ..." is not a block, nor work', JSON.stringify(classify('note', 'Blocked: waiting on the key'))
      === JSON.stringify({ isSilentType: true, reportsNoWork: false, reportsDone: false, isBlocked: false, isWork: false }));
    check('state: a custom event is silent too', classify('custom.acme.done', 'Done, nothing left').isSilentType && !classify('custom.acme.done', 'Done, nothing left').reportsDone);
    check('state: known types classify as before', classify('blocked', 'Blocked: x').isBlocked && classify('work.claimed', 'Claimed: x').isWork
      && classify('queue.empty', 'Nothing to review').reportsNoWork && classify('heartbeat', 'alive').isSilentType);

    // Screens that read title prose skip open events.
    const busyTask = { id: randomUUID(), project_id: s.apex, status: 'in_progress', assignee_ids: [s.builder], ai_readiness: null } as never;
    const row = (type: string, title: string, at: string) => ({ activity_type: type, title, description: '', reference_type: 'task', reference_id: (busyTask as { id: string }).id, created_at: at, project_id: s.apex });
    const blockedFrom = (activity: ReturnType<typeof row>[]) => computeNeedsYou({ tasks: [busyTask], suggestions: [], projects: [], teamMemberId: s.owner,
      includeSuggestions: false, oversight: true, agentActivity: activity }).filter((item) => item.kind === 'blocked');
    check('needs you: a note titled "BLOCKED: ..." is not a blocked agent', blockedFrom([row('note', 'BLOCKED: waiting on the key', '2026-11-24T10:00:00Z')]).length === 0);
    check('needs you: nor does a later note hide a real block', blockedFrom([row('custom', 'BLOCKED: need the Stripe key', '2026-11-24T10:00:00Z'),
      row('custom.acme.ping', 'Still here', '2026-11-24T11:00:00Z')]).length === 1);
    check('needs you: an untyped "BLOCKED: ..." row still reads as blocked, as before', blockedFrom([row('custom', 'BLOCKED: need the Stripe key', '2026-11-24T10:00:00Z')])[0]?.question === 'need the Stripe key');
    const merges = (activity: ReturnType<typeof row>[]) => lastMergeAt(activity, s.apex);
    check('pipeline: a note titled "PR merged ..." is not the project\'s last merge', merges([row('note', 'PR merged #12, yay', '2026-11-24T10:00:00Z')]) === null);
    check('pipeline: pr.merged and an untyped "PR merged" row still are, as before', merges([row('pr.merged', 'Merged PR #12', '2026-11-24T09:00:00Z'),
      row('custom', 'PR merged #13', '2026-11-24T10:00:00Z'), row('note', 'PR merged #14', '2026-11-24T11:00:00Z')]) === '2026-11-24T10:00:00Z');

    // The approval card shows what is being approved, as plain text.
    const detailRows = approvalDetailRows({ type: 'deploy', summary: 'Deploy docs fix', details: {
      environment: 'production', amount: 5000, live: true, owner: null, regions: ['eu', 'us'], nested: { a: { b: [1, 2] } },
      html: '<img src=x onerror=alert(1)>', long: 'x'.repeat(500), [`k${'y'.repeat(100)}`]: 'v',
    } });
    const byKey = Object.fromEntries(detailRows.rows.map((r) => [r.key, r.value]));
    check('approval card: the action type is a readable label', approvalTypeLabel('send_email') === 'Send email' && approvalTypeLabel('deploy') === 'Deploy'
      && approvalTypeLabel('delete-data.v2') === 'Delete data v2');
    check('approval card: details are key/value rows of plain text', byKey.environment === 'production' && byKey.amount === '5000' && byKey.live === 'true'
      && byKey.owner === 'null' && byKey.regions === '["eu","us"]' && byKey.nested === '{"a":{"b":[1,2]}}', detailRows);
    check('approval card: markup stays text, and long keys and values are cut', byKey.html === '<img src=x onerror=alert(1)>'
      && byKey.long.length === APPROVAL_DETAIL_VALUE_MAX && byKey.long.endsWith('…')
      && detailRows.rows.every((r) => r.key.length <= APPROVAL_DETAIL_KEY_MAX && r.value.length <= APPROVAL_DETAIL_VALUE_MAX), detailRows.rows.map((r) => [r.key.length, r.value.length]));
    const many = approvalDetailRows({ type: 'spend', summary: 'x', details: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])) });
    check('approval card: at most 20 rows, with a count of the rest', many.rows.length === 20 && many.hidden === 10, many.hidden);
    check('approval card: no details, no rows', approvalDetailRows({ type: 'merge', summary: 'x' }).rows.length === 0);

    // Analytics: the same totals with or without open events.
    const { fetchAgentAnalyticsWindow, fetchAgentActivityRange } = await import('../src/lib/supabase/queries');
    const { computeTelemetryAnalytics } = await import('../src/lib/agent-telemetry-analytics');
    const { computeAgentAnalytics, computePipelineLatency } = await import('../src/lib/agent-analytics');
    const { activitiesFromWindow } = await import('../src/lib/agent-analytics-window');
    const range = { startKey: '2026-10-01', endKey: '2026-10-07' };
    const team = [{ id: s.builder, name: 'Builder', role: 'agent' }, { id: s.reviewer, name: 'Reviewer', role: 'agent' }] as TeamMember[];
    const RTASK = await s.task('Analytics task');
    const APR = 'https://github.com/acme/shop/pull/77';
    const insert = (agent: string, type: string, metadata: Record<string, unknown>, created: string) => s.q(
      `INSERT INTO pm.agent_activities (agent_id, project_id, activity_type, title, reference_type, reference_id, metadata, created_at)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7)`,
      [agent, s.apex, type, metadata.task_id ? 'task' : null, metadata.task_id ?? null, JSON.stringify(metadata), created]);
    const turn = (agent: string, id: string, start: string, minutes: number, extra: Record<string, unknown> = {}) => insert(agent, 'turn.completed', {
      source_turn_id: id, origin: 'scheduled', duration_ms: minutes * 60_000, started_at: start,
      finished_at: new Date(Date.parse(start) + minutes * 60_000).toISOString(), outcome: 'work', job_name: 'Work', ...extra,
    }, new Date(Date.parse(start) + (minutes + 1) * 60_000).toISOString());
    for (let day = 1; day <= 7; day++) await turn(s.builder, `an:${day}`, `2026-10-0${day}T14:00:00.000Z`, 12, { tokens_scope: 'turn', tokens: { input: 1000 * day, output: 50 } });
    await insert(s.builder, 'work.handoff', { task_id: RTASK, task_title: 'Ship', pr_url: APR }, '2026-10-02T09:00:00.000Z');
    await insert(s.reviewer, 'review.verdict', { task_id: RTASK, verdict: 'approved', round: 1, pr_url: APR }, '2026-10-02T10:00:00.000Z');
    await insert(s.builder, 'pr.merged', { task_id: RTASK, pr_url: APR, additions: 10, deletions: 2 }, '2026-10-02T11:00:00.000Z');
    await insert(s.builder, 'work.milestone', { task_id: RTASK, kind: 'commit', detail: 'again' }, '2026-10-03T14:05:00.000Z');
    await insert(s.builder, 'usage.recorded', { source_usage_id: 'an-u1', model: 'm', input_tokens: 500, output_tokens: 40, cached_tokens: 0, cost_usd: 0.25, recorded_at: '2026-10-04T14:05:00.000Z' }, '2026-10-04T14:06:00.000Z');
    const supabase = getServiceClient();
    const stable = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e9) / 1e9 : v));
    const figures = async () => {
      const out: Record<string, string> = {};
      const raw = await fetchAgentActivityRange(supabase, range);
      const win = await fetchAgentAnalyticsWindow(supabase, range);
      for (const [name, source] of [['raw', raw], ['window', win]] as const) {
        const rows = source.rows as AgentActivity[];
        const delivery = computeAgentAnalytics({ activities: rows, timeEntries: [], team, projects: [], range, timezone: 'UTC', now: Date.parse('2026-10-10T00:00:00Z') });
        const t = computeTelemetryAnalytics({
          activities: rows, fleetActivities: source.fleet, team, range, timezone: 'UTC',
          attributionUsage: 'attribution' in source ? source.attribution : undefined,
          mergedPrsByAgent: new Map(delivery.agents.map((r) => [r.agentId, r.prsMerged])),
        });
        out[name] = stable({ delivery: delivery.agents, daily: delivery.daily, latency: computePipelineLatency(rows, range, 'UTC'),
          fleet: t.fleet, perAgent: t.perAgent, daily2: t.daily, tokens: t.tokens, attention: t.attention, quality: t.quality });
      }
      return out;
    };
    const before = await figures();
    check('analytics: the dataset counts rework, handoffs and merges', /"rework":[1-9]/.test(before.window) && before.raw === before.window, before.window.slice(0, 300));
    // Open events that would each read as a touch on the approved task inside a turn.
    await insert(s.builder, 'note', { title: 'Looked again', task_id: RTASK }, '2026-10-05T14:05:00.000Z');
    await insert(s.builder, 'custom.acme.poke', { title: 'Poked it', task_id: RTASK }, '2026-10-06T14:05:00.000Z');
    await insert(s.reviewer, 'custom.acme.review_note', { title: 'Approved, see notes', task_id: RTASK, verdict: 'approved' }, '2026-10-04T10:00:00.000Z');
    const after = await figures();
    check('analytics: totals are identical with the open events in the range (window read)', after.window === before.window);
    check('analytics: and identical on the raw read', after.raw === before.raw);
    const asked = await supabase.rpc('agent_analytics_window', { p_from: '2026-09-30T00:00:00Z', p_to: '2026-10-08T23:59:59Z', p_late_to: '2026-10-08T23:59:59Z' });
    const withOpen = activitiesFromWindow(asked.data, { includeOpenEvents: true }).rows.filter((r) => events.isOpenEventType(r.activity_type));
    const withoutOpen = activitiesFromWindow(asked.data).rows.filter((r) => events.isOpenEventType(r.activity_type));
    check('analytics: open events come back only when asked for', withOpen.length === 3 && withoutOpen.length === 0, [withOpen.length, withoutOpen.length]);

    // =========================================================================================
    // Profiles
    // =========================================================================================
    check('profiles: core keeps its five values, in order', JSON.stringify(profiles.CORE_AGENT_PROFILES.map((p) => p.value))
      === JSON.stringify(['generic', 'coordinator', 'builder', 'auditor', 'reviewer']) && profiles.CORE_AGENT_PROFILES.every((p) => p.tools === undefined));
    check('profiles: no tool is limited to a profile (as before)', PM_TOOLS.every((tool) => !tool.profiles));
    // The visibility rule as it was before the registry, to compare against.
    type Viewer = Parameters<typeof toolsFor>[0];
    const before0 = (caller: Viewer) => PM_TOOLS.filter((tool) => {
      if (tool.profiles && !tool.profiles.includes(caller.profile)) return false;
      if (tool.agentsOnly && caller.access.role !== 'agent') return false;
      if (tool.module && !isModuleEnabled(caller.access, tool.module)) return false;
      if (tool.write && caller.readOnly) return false;
      if (tool.name === GUIDE_TOOL) return true;
      const wanted = (Array.isArray(tool.permission) ? tool.permission : [tool.permission]).flatMap((p) => permissionAlternatives(p));
      return wanted.some((p) => caller.scopes.includes(p) && accessAllows(caller.access, p, 'api'));
    }).map((tool) => tool.name);
    const viewers = [
      { who: 'builder, every scope', access: (await resolveMemberAccess(supabase, s.builder))!, scopes: [...API_ENDPOINT_PERMISSIONS] as string[], readOnly: false },
      { who: 'builder, read only', access: (await resolveMemberAccess(supabase, s.builder))!, scopes: [...API_ENDPOINT_PERMISSIONS] as string[], readOnly: true },
      { who: 'owner, its key', access: ownerAccess!, scopes: ['tasks.read', 'projects.read', 'team.manage', 'agents.manage'], readOnly: false },
    ];
    for (const viewer of viewers) {
      for (const profile of profiles.CORE_AGENT_PROFILES.map((p) => p.value)) {
        const now = toolsFor({ ...viewer, profile }).map((tool) => tool.name);
        const was = before0({ ...viewer, profile });
        check(`profiles: ${profile} (${viewer.who}) sees exactly the tools it saw before`, JSON.stringify(now) === JSON.stringify(was) && now.length > 5, { now: now.length, was: was.length });
      }
    }
    // An install's own profile, registered as src/custom/agent-profiles.ts would.
    const [supportDesk] = extensionProfiles.defineAgentProfiles([{
      value: 'support-desk', label: 'Support desk', description: 'Answers questions on tasks.', tools: ['list_projects', 'get_task', 'ask_human', 'request_approval', 'list_projects'],
    }]);
    check('profiles: an install\'s profile is checked and its tools deduplicated', supportDesk.tools?.length === 4);
    profiles.AGENT_PROFILES.push(supportDesk);
    const desk = toolsFor({ ...viewers[0], profile: 'support-desk' }).map((tool) => tool.name);
    check('profiles: an install\'s profile sees its listed tools and pm_guide', JSON.stringify(desk) === JSON.stringify(['pm_guide', 'list_projects', 'get_task', 'ask_human', 'request_approval']), desk);
    const deskReadOnly = toolsFor({ ...viewers[1], profile: 'support-desk' }).map((tool) => tool.name);
    check('profiles: and still only what its key allows (read only: no writes)', JSON.stringify(deskReadOnly) === JSON.stringify(['pm_guide', 'list_projects', 'get_task']), deskReadOnly);
    await s.q("UPDATE pm.team_members SET agent_profile = 'support-desk' WHERE id = $1", [s.scout]);
    const deskPack = (await call(myContextRoute.GET, 'GET', '/api/v1/agents/me/context?format=pack', {}, s.keys.scout)).body?.data?.pack;
    const deskTools = (deskPack?.tools ?? []).map((t: Loose) => t.name);
    check('profiles: a member stored with it sees just those tools in its context pack', deskTools.includes('get_task') && deskTools.includes('pm_guide')
      && !deskTools.includes('search_tasks') && !deskTools.includes('log_activity') && deskPack.member.profile === 'support-desk', deskTools);
    const agentBody = (agentProfile: string) => ({ name: 'Desk', email: 'desk@agents.example.com', agent_profile: agentProfile });
    check('profiles: a new agent may take an install\'s profile or a core one, never another', createAgentSchema.safeParse(agentBody('support-desk')).success
      && createAgentSchema.safeParse(agentBody('reviewer')).success && !createAgentSchema.safeParse(agentBody('ghost')).success);
    const ghost = await call(agentsRoute.POST, 'POST', '/api/v1/agents', {}, s.keys.owner, { name: 'Ghost', email: 'ghost@agents.example.com', agent_profile: 'ghost' });
    check('profiles: an unknown profile is refused on write', ghost.status === 422, ghost.body);
    check('profiles: isAgentProfile knows the registry', profiles.isAgentProfile('reviewer') && profiles.isAgentProfile('support-desk') && !profiles.isAgentProfile('ghost'));
    await s.q("UPDATE pm.team_members SET agent_profile = 'ghost' WHERE id = $1", [s.scout]);
    const ghostPack = (await call(myContextRoute.GET, 'GET', '/api/v1/agents/me/context?format=pack', {}, s.keys.scout)).body?.data?.pack;
    check('profiles: a stored value the registry does not know sees only pm_guide', JSON.stringify((ghostPack?.tools ?? []).map((t: Loose) => t.name)) === '["pm_guide"]', ghostPack?.tools);
    const badDbProfile = await db.query("UPDATE pm.team_members SET agent_profile = 'Not Valid!' WHERE id = $1", [s.scout]).then(() => 'stored', (e: Error) => e.message);
    check('db: a profile value of the wrong shape is refused', badDbProfile !== 'stored', badDbProfile);
    const throws = (run: () => unknown) => { try { run(); return false; } catch (error) { return (error as Error).name === 'ExtensionError' || error instanceof Error; } };
    check('profiles: a bad value, a repeat, a clash with core or an unknown tool stops the build',
      throws(() => extensionProfiles.defineAgentProfiles([{ value: 'Bad Value', label: 'x', description: 'x' }]))
      && throws(() => extensionProfiles.defineAgentProfiles([{ value: 'a', label: 'x', description: 'x' }, { value: 'a', label: 'y', description: 'y' }]))
      && throws(() => extensionProfiles.mergeAgentProfiles(profiles.CORE_AGENT_PROFILES, [{ value: 'builder', label: 'x', description: 'x' }]))
      && throws(() => extensionProfiles.checkAgentProfileTools([{ value: 'a', label: 'x', description: 'x', tools: ['no_such_tool'] }], PM_TOOLS.map((t) => t.name)))
      && !throws(() => extensionProfiles.checkAgentProfileTools(profiles.AGENT_PROFILES, PM_TOOLS.map((t) => t.name))));
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`open agent vocabulary: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
