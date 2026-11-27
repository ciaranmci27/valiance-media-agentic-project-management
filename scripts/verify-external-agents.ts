/**
 * External agents (20261125001400_external_agents.sql): the app as the
 * control plane for an agent that works in another system.
 * - GET /api/v1/agents/me/status: a key with only agent_activity.write reads
 *   it; its own pause, the workspace pause and a spent budget show; pausing
 *   sends agent.paused once and resuming agent.resumed, once per change of
 *   whether the agent may start work.
 * - budget.exceeded: once a period, however many requests see it spent.
 * - questions.ask: with it and no tasks.read, a question and an approval
 *   naming nothing are asked; naming a task or project is refused; reads
 *   show only its own on nothing. tasks.read alone asks as before.
 * - action.external_url: https only (javascript: and http: refused),
 *   stored, read back and carried in the question.* webhooks.
 * - The External agent template: its scopes, and no task scopes.
 * - questions.ask is held on the API by admins, members and agents, so
 *   whoever hires an agent may hand it on.
 * - The migration, run twice on the schema without it, matches schema.sql.
 *
 *   npm run -s test:external-agents
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { API_ENDPOINT_PERMISSIONS, PERMISSIONS } from '../src/lib/access-control';
import { PERMISSION_MODULE } from '../src/lib/modules/registry';
import { CORE_AGENT_TEMPLATES, findAgentTemplate } from '../src/lib/agent-templates';
import { scopeGroups } from '../src/lib/agents-ui';
import { approvalActionSchema, externalLinkHost } from '../src/lib/questions';
import { composeAgentStatus } from '../src/lib/api/agent-status';
import { PM_TOOLS } from '../src/lib/mcp/tools';
import { WEBHOOK_EVENT_TYPES } from '../src/lib/types';
import { WEBHOOK_EVENT_GROUPS, WEBHOOK_EVENT_LABELS } from '../src/lib/developers-settings';

const MIGRATION = '20261125001400_external_agents.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = `-- EXTERNAL AGENTS (${MIGRATION})`;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

/** schema.sql without this migration's section: what an install had before it. */
function schemaWithoutSection(): string {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const start = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  const next = /\n-- =+\n-- [A-Z][^\n]*\(\d{14}_[a-z0-9_]+\.sql\)/g;
  next.lastIndex = at + SECTION.length;
  const end = next.exec(SCHEMA_SQL)?.index ?? SCHEMA_SQL.length;
  // A later section changes pm.agent_status again (20261127001000): it is left out too and applied after.
  const later = SCHEMA_SQL.lastIndexOf('\n-- ====', SCHEMA_SQL.indexOf(LATER_SECTION));
  return SCHEMA_SQL.slice(0, start) + SCHEMA_SQL.slice(end, later);
}

const LATER_SECTION = '-- ORCHESTRATORS AND WHO CAN USE AN AGENT (20261127001000_agent_hierarchy_access.sql)';

const q = (db: PGlite) => async <T = Loose>(sql: string, params: unknown[] = []) => {
  await db.exec('RESET ROLE');
  return (await db.query<T>(sql, params)).rows;
};

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  check('schema.sql: the external agents section is there', at > 0);
  check('schema.sql: the section mirrors the migration', SCHEMA_SQL.slice(at - 100).includes(MIGRATION_SQL.slice(MIGRATION_SQL.indexOf(SECTION)).trim()));
  check('migration: additive (no DROP of a table, column or function)', !/\bDROP\s+(TABLE|FUNCTION|COLUMN|VIEW)\b/i.test(MIGRATION_SQL));

  const old = await createFullSchemaDatabase({ schemaSql: schemaWithoutSection() });
  const run = q(old);
  check('upgrade: before it, pm.agent_status does not exist (the comparison below can fail)',
    (await run<Loose>("SELECT to_regprocedure('pm.agent_status(uuid)') AS f"))[0].f === null);
  await old.exec(MIGRATION_SQL);
  await old.exec(MIGRATION_SQL);
  // A later migration changes pm.agent_status again (assistants_off): it runs after, as an upgrade does.
  await applyMigrationsFrom(old, '20261127001000_agent_hierarchy_access.sql');
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema without it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  // Admins and members hold it too, so whoever hires an agent can hand it on (apply the External agent template).
  const roleRows = await run<Loose>("SELECT role, access_channel FROM pm.role_permissions WHERE permission_key = 'questions.ask' ORDER BY role");
  check('upgrade: admins, members and agents hold questions.ask on the API, once each; guests do not', JSON.stringify(roleRows.map((r: Loose) => `${r.role}:${r.access_channel}`))
    === JSON.stringify(['admin:api', 'agent:api', 'member:api']), roleRows);
  const grants = await run<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace
      AND p.proname IN ('agent_status', 'emit_agent_pause_event', 'emit_agent_pause_webhook', 'emit_workspace_pause_webhook', 'emit_budget_exceeded_webhook')`);
  check('grants: five new functions, none callable by anon or members', grants.length === 5 && grants.every((g: Loose) => !g.anon && !g.auth), grants);
  await old.close();
  await fresh.close();
}

// ── Code: permission, template, events, tools ────────────────────────────

function codeChecks() {
  check('permission: questions.ask is a core API scope', PERMISSIONS.includes('questions.ask')
    && (API_ENDPOINT_PERMISSIONS as readonly string[]).includes('questions.ask') && PERMISSION_MODULE['questions.ask'] === 'core');
  check('permission: an agent key may carry it (offered in the hire flow\'s powers)', scopeGroups(['questions.ask', 'agent_activity.write'])
    .some((g) => g.scopes.some((s) => s.key === 'questions.ask')));

  const template = findAgentTemplate('external-agent');
  check('template: External agent is a core template', !!template && CORE_AGENT_TEMPLATES.some((t) => t.key === 'external-agent') && template.label === 'External agent');
  check('template: reports, runs and asks (agent_activity.write, questions.ask)', !!template
    && template.scopes.includes('agent_activity.write') && template.scopes.includes('questions.ask'), template?.scopes);
  check('template: no task or project scopes, so no task writes and no queue', !!template
    && !template.scopes.some((s) => s.startsWith('tasks.') || s.startsWith('projects.')), template?.scopes);
  check('template: never self-assigns and asks no module', template?.rules.agent_self_assign === false && !template?.module);
  check('template: the brief explains the check before each turn', !!template && /get_my_status/.test(template.context) && /can_start_work/.test(template.context)
    && /external_url/.test(template.context));
  check('template: it hears pause and budget events', !!template && ['agent.paused', 'agent.resumed', 'budget.exceeded'].every((e) => template.webhook_events?.includes(e as never)));

  const events = ['agent.paused', 'agent.resumed', 'budget.exceeded'];
  check('events: registered, labelled and in the Agents group', events.every((e) => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(e) && !!WEBHOOK_EVENT_LABELS[e]
    && WEBHOOK_EVENT_GROUPS.find((g) => g.id === 'runs')?.events.includes(e)));
  const webhooksDoc = readFileSync(join(__dirname, '..', 'WEBHOOKS.md'), 'utf8');
  check('events: documented in WEBHOOKS.md', events.every((e) => webhooksDoc.includes(`| \`${e}\` |`)));

  const tool = PM_TOOLS.find((t) => t.name === 'get_my_status');
  check('mcp: get_my_status reads the status route, for any key', !!tool && tool.routes?.[0]?.path === '/api/v1/agents/me/status' && tool.routes[0].method === 'GET'
    && (Array.isArray(tool.permission) ? tool.permission : [tool.permission]).includes('agent_activity.write'));
  const ask = PM_TOOLS.find((t) => t.name === 'request_approval');
  check('mcp: request_approval takes questions.ask and the external link', !!ask && (ask.permission as string[]).includes('questions.ask')
    && JSON.stringify(ask.input.safeParse({ action: { type: 'pay_bill', summary: 'Pay', external_url: 'https://books.example.com/b/1', external_id: 'b1' } }).success) === 'true');

  const parse = (external_url: string) => approvalActionSchema.safeParse({ type: 'pay_bill', summary: 'Pay', external_url }).success;
  check('external_url: https passes; javascript:, http:, data: and credentials are refused', parse('https://books.example.com/bills/1')
    && !parse('javascript:alert(1)') && !parse('http://books.example.com/bills/1') && !parse('data:text/html,hi') && !parse('https://u:p@books.example.com/x')
    && !parse(`https://books.example.com/${'a'.repeat(2000)}`));
  check('external_url: the card names the host, and nothing for an unsafe stored link', externalLinkHost({ external_url: 'https://www.books.example.com/b/1' }) === 'books.example.com'
    && externalLinkHost({ external_url: 'javascript:alert(1)' }) === null && externalLinkHost(null) === null);

  const status = composeAgentStatus({ memberId: 'm', agent: true, workspacePausedAt: '2026-11-25T10:00:00Z', agentPausedAt: '2026-11-25T09:00:00Z', state: null });
  check('status: the workspace pause wins over the agent\'s own', status.paused_reason === 'agents_paused' && status.paused_at === '2026-11-25T10:00:00.000Z' && !status.can_start_work);
  const person = composeAgentStatus({ memberId: 'p', agent: false, workspacePausedAt: '2026-11-25T10:00:00Z', agentPausedAt: null, state: null });
  check('status: a person is never paused', person.paused === false && person.can_start_work === true && person.workspace_paused_at === null);
}

// ── Over the real routes ─────────────────────────────────────────────────

async function routeChecks() {
  const db = await createFullSchemaDatabase();
  const run = q(db);
  await run('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await run('UPDATE pm.workspace_modules SET enabled = true');
  const member = async (name: string, role: string) => (await run<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id',
    [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const ledger = await member('Ledger', 'agent');
  const builder = await member('Builder', 'agent');
  await run('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [ledger, owner]);
  const project = (await run<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Books') RETURNING id"))[0].id;
  await run('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2), ($1, $3)', [project, ledger, builder]).catch(() => undefined);
  const task = (await run<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status) VALUES ($1, 'Reconcile November', 'todo') RETURNING id", [project]))[0].id;
  if (!(await run('SELECT 1 FROM pm.business_settings')).length) await run('INSERT INTO pm.business_settings DEFAULT VALUES');
  await run(`INSERT INTO pm.webhook_endpoints (name, url, secret, events)
    VALUES ('Harness', 'https://harness.example.test/hook', 'whsec_h', ARRAY['agent.paused', 'agent.resumed', 'budget.exceeded', 'question.asked'])`);

  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await run(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return secret;
  };
  const activityKey = await key(ledger, ['agent_activity.write']);
  const askKey = await key(ledger, ['agent_activity.write', 'questions.ask']);
  const readerKey = await key(builder, ['tasks.read']);

  const server = await startFakePostgrest(db, { handle: async (_req: IncomingMessage, _res: ServerResponse) => false });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  try {
    const statusRoute = await import('../src/app/api/v1/agents/me/status/route');
    const questionsRoute = await import('../src/app/api/v1/questions/route');
    const approvalsRoute = await import('../src/app/api/v1/approvals/route');
    const approvalRoute = await import('../src/app/api/v1/approvals/[id]/route');
    const activitiesRoute = await import('../src/app/api/v1/agent-activities/route');
    type Handler = (request: NextRequest, context: never) => Promise<Response>;
    const call = async (handler: Handler, method: string, path: string, apiKey: string, body?: unknown, params: Record<string, string> = {}) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      const text = await response.text();
      let parsed: Loose = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      return { status: response.status, body: parsed, headers: response.headers };
    };
    const status = (apiKey = activityKey) => call(statusRoute.GET as Handler, 'GET', '/api/v1/agents/me/status', apiKey);
    const events = async (type: string, agentId = ledger) => (await run<Loose>('SELECT payload FROM pm.webhook_events WHERE event_type = $1 ORDER BY sequence', [type]))
      .filter((row) => row.payload.data?.agent?.id === agentId);
    const waitFor = async (ok: () => Promise<boolean>) => {
      for (let i = 0; i < 40 && !(await ok()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    };

    // Status, with an activity-only key.
    const first = await status();
    check('status: a key with only agent_activity.write reads it (200)', first.status === 200 && first.body?.data?.member_id === ledger, first.body);
    check('status: not paused, no budget: may start work', first.body?.data?.can_start_work === true && first.body.data.paused === false
      && first.body.data.skip_reason === null && first.body.data.limits === null && first.body.data.budget?.exceeded === false, first.body?.data);
    check('status: never cached', first.headers.get('cache-control') === 'no-store');

    // Its own pause.
    await run('UPDATE pm.team_members SET agent_paused_at = now() WHERE id = $1', [ledger]);
    const paused = await status();
    check('status: its own pause shows (agent_paused), and it may not start work', paused.status === 200 && paused.body?.data?.paused === true
      && paused.body.data.paused_reason === 'agent_paused' && paused.body.data.can_start_work === false && paused.body.data.skip_reason === 'agent_paused', paused.body?.data);
    const pausedEvents = await events('agent.paused');
    check('events: pausing sends agent.paused once, naming the agent and the switch', pausedEvents.length === 1 && pausedEvents[0].payload.data.reason === 'agent_paused'
      && pausedEvents[0].payload.data.paused === true && pausedEvents[0].payload.data.member_ids?.includes(ledger), pausedEvents);
    await run("UPDATE pm.team_members SET agent_paused_at = now() + interval '1 second' WHERE id = $1", [ledger]);
    check('events: a new pause time on a paused agent sends nothing more', (await events('agent.paused')).length === 1);
    await run('UPDATE pm.team_members SET agent_paused_at = NULL WHERE id = $1', [ledger]);
    const resumed = await events('agent.resumed');
    check('events: resuming sends agent.resumed once', resumed.length === 1 && resumed[0].payload.data.paused === false && resumed[0].payload.data.reason === 'agent_paused', resumed);
    check('status: resumed, it may start work again', (await status()).body?.data?.can_start_work === true);

    // The workspace pause.
    await run('UPDATE pm.business_settings SET agents_paused_at = now()');
    const workspace = await events('agent.paused');
    check('events: the workspace pause sends agent.paused to each agent (reason agents_paused)', workspace.length === 2 && workspace[1].payload.data.reason === 'agents_paused'
      && (await events('agent.paused', builder)).length === 1, workspace.map((e) => e.payload.data.reason));
    const wsStatus = await status();
    check('status: the workspace pause shows (agents_paused)', wsStatus.body?.data?.paused_reason === 'agents_paused' && wsStatus.body.data.workspace_paused_at !== null, wsStatus.body?.data);
    await run('UPDATE pm.team_members SET agent_paused_at = now() WHERE id = $1', [ledger]);
    check('events: pausing the agent while every agent is paused changes nothing for it, so nothing is sent', (await events('agent.paused')).length === 2);
    await run('UPDATE pm.business_settings SET agents_paused_at = NULL');
    check('events: lifting the workspace pause resumes Builder, not Ledger (still paused on its own)', (await events('agent.resumed')).length === 1
      && (await events('agent.resumed', builder)).length === 1);
    check('status: Ledger still reads its own pause', (await status()).body?.data?.paused_reason === 'agent_paused');
    await run('UPDATE pm.team_members SET agent_paused_at = NULL WHERE id = $1', [ledger]);
    check('events: resuming Ledger then sends its agent.resumed', (await events('agent.resumed')).length === 2);

    // budget.exceeded, once a period.
    await run("INSERT INTO pm.agent_limits (agent_id, budget_usd, budget_period) VALUES ($1, 10, 'month')", [ledger]);
    const usage = (cost: number) => call(activitiesRoute.POST as Handler, 'POST', '/api/v1/agent-activities', activityKey, {
      activity_type: 'usage.recorded',
      payload: { source_usage_id: `u-${randomUUID()}`, model: 'claude-opus', input_tokens: 1000, output_tokens: 0, cost_usd: cost, recorded_at: new Date().toISOString() },
    });
    const under = await usage(4);
    await new Promise((resolve) => setTimeout(resolve, 200));
    check('budget: usage with no run counts ($4 of $10): may still start work', under.status === 201 && (await status()).body?.data?.budget?.spent_usd === 4
      && (await events('budget.exceeded')).length === 0, under.body);
    const over = await usage(8);
    await waitFor(async () => (await events('budget.exceeded')).length > 0);
    const exceeded = await events('budget.exceeded');
    check('budget: passing the budget sends budget.exceeded once, with the spend', over.status === 201 && exceeded.length === 1
      && exceeded[0].payload.data.budget.spent_usd === 12 && Number(exceeded[0].payload.data.budget.budget_usd) === 10 && exceeded[0].payload.data.budget.period === 'month', exceeded.map((e) => e.payload.data));
    const overStatus = await status();
    check('status: over budget, it may not start work (budget_exceeded)', overStatus.body?.data?.can_start_work === false && overStatus.body.data.skip_reason === 'budget_exceeded'
      && overStatus.body.data.budget.exceeded === true && overStatus.body.data.budget.spent_usd === 12 && overStatus.body.data.limits?.budget_usd === 10
      && !!overStatus.body.data.budget.resets_at, overStatus.body?.data);
    await usage(1);
    await Promise.all([status(), status(), status()]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    check('budget: more usage and more reads in the same period send nothing more', (await events('budget.exceeded')).length === 1);
    // A new period: nobody told about it yet. Three reads at once claim it once.
    await run('UPDATE pm.agent_limits SET budget_alerted_period = NULL WHERE agent_id = $1', [ledger]);
    await Promise.all([status(), status(), status()]);
    await waitFor(async () => (await events('budget.exceeded')).length > 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    check('budget: in a period nobody was told about, reading the status sends it once (three reads at once)', (await events('budget.exceeded')).length === 2);

    // Over its budget, its other writes are held too (security review finding 3); then an Owner raises it.
    const heldAsk = await call(questionsRoute.POST as Handler, 'POST', '/api/v1/questions', askKey, { question: 'May I go over budget?' });
    check('budget: over budget, a question is held like any write (402 budget_exceeded)', heldAsk.status === 402 && heldAsk.body?.error?.details?.reason === 'budget_exceeded', heldAsk.body);
    await run('UPDATE pm.agent_limits SET budget_usd = 1000 WHERE agent_id = $1', [ledger]);

    // questions.ask without tasks.read.
    const plain =await call(questionsRoute.POST as Handler, 'POST', '/api/v1/questions', activityKey, { question: 'Which account?' });
    check('ask: without tasks.read or questions.ask, asking is refused (403)', plain.status === 403, plain.body);
    const asked = await call(questionsRoute.POST as Handler, 'POST', '/api/v1/questions', askKey, { question: 'Is vendor Acme the same as Acme Ltd?', choices: ['Same', 'Different'] });
    check('ask: questions.ask alone asks a question that names nothing (201)', asked.status === 201 && asked.body?.data?.asked_to === owner, asked.body);
    const approval = await call(approvalsRoute.POST as Handler, 'POST', '/api/v1/approvals', askKey, {
      action: { type: 'pay_bill', summary: 'Pay Acme Supplies $4,180.00', external_url: 'https://books.example.com/bills/8812', external_id: 'bill_8812' },
    });
    check('ask: questions.ask alone requests an approval that names nothing, with its external link stored', approval.status === 201
      && approval.body?.data?.action?.external_url === 'https://books.example.com/bills/8812' && approval.body.data.action.external_id === 'bill_8812', approval.body);
    const stored = (await run<Loose>('SELECT action FROM pm.questions WHERE id = $1', [approval.body?.data?.id]))[0]?.action;
    check('ask: the link is kept in the action JSON', stored?.external_url === 'https://books.example.com/bills/8812' && stored?.external_id === 'bill_8812', stored);
    const asking = (await run<Loose>("SELECT payload FROM pm.webhook_events WHERE event_type = 'question.asked' ORDER BY sequence")).map((r) => r.payload.data.question);
    check('ask: question.asked carries the external link on the approval', asking.some((qn: Loose) => qn.action?.external_url === 'https://books.example.com/bills/8812' && qn.action?.external_id === 'bill_8812'), asking);
    const readBack = await call(approvalRoute.GET as Handler, 'GET', `/api/v1/approvals/${approval.body?.data?.id}`, askKey, undefined, { id: approval.body?.data?.id });
    check('ask: it reads its own approval back with the link', readBack.status === 200 && readBack.body?.data?.action?.external_id === 'bill_8812', readBack.body);
    for (const [label, body] of [['a task', { question: 'Done?', task_id: task }], ['a project', { question: 'Done?', project_id: project }]] as const) {
      const refused = await call(questionsRoute.POST as Handler, 'POST', '/api/v1/questions', askKey, body);
      check(`ask: questions.ask alone naming ${label} is refused (403 place_needs_tasks_read)`, refused.status === 403 && refused.body?.error?.details?.reason === 'place_needs_tasks_read', refused.body);
    }
    const onTaskApproval = await call(approvalsRoute.POST as Handler, 'POST', '/api/v1/approvals', askKey, { action: { type: 'pay_bill', summary: 'Pay' }, task_id: task });
    check('ask: an approval naming a task is refused too', onTaskApproval.status === 403 && onTaskApproval.body?.error?.details?.reason === 'place_needs_tasks_read', onTaskApproval.body);
    for (const [label, url] of [['javascript:', 'javascript:alert(document.cookie)'], ['http:', 'http://books.example.com/bills/1']]) {
      const bad = await call(approvalsRoute.POST as Handler, 'POST', '/api/v1/approvals', askKey, { action: { type: 'pay_bill', summary: 'Pay', external_url: url } });
      check(`external_url: ${label} is refused (422)`, bad.status === 422, bad.body);
    }

    // tasks.read alone, as before.
    const onTask = await call(questionsRoute.POST as Handler, 'POST', '/api/v1/questions', readerKey, { question: 'Which ledger for November?', task_id: task, asked_to: ledger });
    check('tasks.read: a question on a task is asked as before (201)', onTask.status === 201 && onTask.body?.data?.task_id === task, onTask.body);
    const onNothing = await call(questionsRoute.POST as Handler, 'POST', '/api/v1/questions', readerKey, { question: 'Anything else?' });
    check('tasks.read: a question on nothing too', onNothing.status === 201, onNothing.body);
    const readerList = await call(questionsRoute.GET as Handler, 'GET', '/api/v1/questions', readerKey);
    check('tasks.read: its list holds the question on the task', readerList.status === 200 && readerList.body?.data?.some((row: Loose) => row.task_id === task), readerList.body);

    // What a questions.ask key reads: its own on nothing, never one on a task (even one asked to it).
    const askList = await call(questionsRoute.GET as Handler, 'GET', '/api/v1/questions', askKey);
    const ids = (askList.body?.data ?? []).map((row: Loose) => row.id);
    check('read: a questions.ask key lists its own questions on nothing', askList.status === 200 && ids.includes(asked.body?.data?.id) && ids.includes(approval.body?.data?.id), askList.body);
    check('read: but not a question on a task, though it was asked to it', !ids.includes(onTask.body?.data?.id) && (askList.body?.data ?? []).every((row: Loose) => row.task_id === null && row.project_id === null), ids);
    const withTasks = await call(questionsRoute.GET as Handler, 'GET', '/api/v1/questions', await key(ledger, ['tasks.read']));
    check('read: the same agent with tasks.read sees that question (the check above can fail)', (withTasks.body?.data ?? []).some((row: Loose) => row.id === onTask.body?.data?.id), withTasks.body);
  } finally {
    await server.close();
    await db.close();
  }
}

async function main() {
  codeChecks();
  await migrationChecks();
  await routeChecks();
  if (failures.length) {
    console.error(`external agents: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`external agents: ${passed} checks passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
