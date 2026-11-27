/**
 * Agent limits and setup security (deep security review of 2.0.50, findings
 * 3, 4, 6, 8, 9 and 11; 20261127002500_agent_limits_security.sql), through
 * the real v1 routes (withApi, supabase-js, a fake PostgREST over PGlite with
 * the full schema), the MCP route and the session logic:
 *
 * - 3: a run's spend only goes up; an agent over its budget, or holding a run
 *   past its max_run_spend_cents, is refused writes as if paused (reads,
 *   heartbeats and usage still work); usage under a run counts even when the
 *   run reports less itself.
 * - 4: an agent's approval goes only to its managers, escalation target,
 *   non-guest people on the project, its orchestrator chain or an Owner; no
 *   agent asks a guest anything.
 * - 6: an act-for pass needs a chat message from that person to this agent
 *   in the last 30 minutes; a DM to someone who did not just write needs
 *   chat.notify, act-for or not.
 * - 8: a key an AI setup session makes carries at most its template's powers;
 *   sensitive ones wait for the Owner's Allow; the session lists its keys; a
 *   webhook to a new address waits switched off.
 * - 9: new agents get a monthly budget, write and send rates, and 90-day
 *   keys; existing ones keep none; writes and sends are counted per agent
 *   across keys; MCP handshakes are counted.
 * - 11: a non-Owner's manage_all key never touches an Owner's key or an
 *   Owner's agent's key.
 * - The migration mirrors schema.sql word for word and upgrades cleanly.
 *
 *   npm run -s test:agent-limits-security
 */
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { NEW_AGENT_KEY_DAYS, NEW_AGENT_SENDS_PER_MINUTE, NEW_AGENT_WRITES_PER_MINUTE } from '../src/lib/agent-defaults';
import { AI_SETUP_CONFIRM_SCOPES, splitSetupScopes } from '../src/lib/ai-setup';
import { keyExpiry } from '../src/lib/developers-settings';
import { emptyHireDraft, hireRequestFrom } from '../src/lib/agents-ui';

const MIGRATION = '20261127002500_agent_limits_security.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = `\n-- ============================================================\n-- LIMITS AND SETUP SECURITY (${MIGRATION})\n-- ============================================================\n`;
const DAY = 86_400_000;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  // Found by its banner: later releases append their own sections after it.
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n-- ', at + BANNER.length);
  const section = SCHEMA_SQL.slice(at + BANNER.length, next > 0 ? next : SCHEMA_SQL.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && section.trimEnd() === MIGRATION_SQL.trimEnd());
  check('migration: no em or en dash', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await old.exec('RESET ROLE');
  const agent = (await old.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old', 'old@example.com', 'agent') RETURNING id")).rows[0].id;
  await old.query('INSERT INTO pm.agent_limits (agent_id, budget_usd) VALUES ($1, 20)', [agent]);
  await applyMigrationsFrom(old, MIGRATION);
  await old.exec(MIGRATION_SQL);
  const kept = (await old.query<Loose>('SELECT budget_usd, write_rate_per_minute, send_rate_per_minute FROM pm.agent_limits WHERE agent_id = $1', [agent])).rows[0];
  check('upgrade: an agent from before keeps its limits and gains no new ones; running it twice is safe', Number(kept.budget_usd) === 20 && kept.write_rate_per_minute === null && kept.send_rate_per_minute === null, kept);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const grants = (await fresh.query<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('agent_write_gate', 'agent_runs_spend_only_up')`)).rows;
  check('grants: the new functions are for the server only', grants.length === 2 && grants.every((g) => !g.anon && !g.auth), grants);
  const tables = (await fresh.query<Loose>(`SELECT bool_or(has_table_privilege(r, t, 'SELECT')) AS any FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['pm.agent_write_windows', 'pm.ai_setup_confirms']) t`)).rows[0];
  check('grants: browsers hold nothing on the new tables', tables.any === false, tables);
  await old.close();
  await fresh.close();
}

function pureChecks() {
  const split = splitSetupScopes(['tasks.read', 'agents.act_for', 'projects.manage', 'tasks.read'], ['tasks.read', 'tasks.create']);
  check('setup scopes: the template\'s are granted, sensitive ones wait, the rest are refused', split.granted.join() === 'tasks.read' && split.confirm.join() === 'agents.act_for' && split.refused.join() === 'projects.manage', split);
  check('setup scopes: a sensitive power in a template still waits', splitSetupScopes(['invoices.manage'], ['invoices.manage']).confirm.join() === 'invoices.manage');
  check('setup scopes: money, people, settings, act-for, keys and webhooks all wait', ['invoices.manage', 'team.manage', 'settings.manage', 'agents.act_for', 'api_keys.manage_all', 'webhooks.manage'].every((s) => (AI_SETUP_CONFIRM_SCOPES as readonly string[]).includes(s)));
  const now = new Date('2026-11-27T12:00:00Z');
  check('key list: a key ending within two weeks says how soon, as a warning', keyExpiry(new Date(now.getTime() + 9 * DAY).toISOString(), now).label === 'Ends in 9 days. Replace it to keep it working'
    && keyExpiry(new Date(now.getTime() + 9 * DAY).toISOString(), now).tone === 'warning');
  const draft = { ...emptyHireDraft('owner-id'), name: 'Nova', scopes: ['tasks.read'] };
  const body = hireRequestFrom(draft) as Loose;
  check(`hire screen: pre-fills no budget, ${NEW_AGENT_WRITES_PER_MINUTE} writes and ${NEW_AGENT_SENDS_PER_MINUTE} messages a minute and a ${NEW_AGENT_KEY_DAYS}-day key`,
    (body.limits?.budget_usd ?? null) === null && body.limits.write_rate_per_minute === 30 && body.limits.send_rate_per_minute === 10 && body.key_expires_in_days === 90, body);
  const cleared = hireRequestFrom({ ...draft, keyDays: '', limits: { ...draft.limits, budget_usd: '', write_rate_per_minute: '' } }) as Loose;
  check('hire screen: a cleared limit is sent as no limit, a cleared key life as until revoked', cleared.limits.budget_usd === null && cleared.limits.write_rate_per_minute === null && cleared.limits.send_rate_per_minute === 10 && cleared.key_expires_in_days === null, cleared);
}

/** Supabase Auth as hiring uses it: a login made for a new agent. */
function authStandIn(db: PGlite) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== '/auth/v1/admin/users' || request.method !== 'POST') return false;
    const text = await new Promise<string>((resolve) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => resolve(raw));
    });
    const body = JSON.parse(text || '{}');
    const id = randomUUID();
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [id, String(body.email).toLowerCase()]);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id, aud: 'authenticated', role: 'authenticated', email: body.email, user_metadata: body.user_metadata ?? {}, app_metadata: {}, created_at: '2026-11-27T00:00:00Z' }));
    return true;
  };
}

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const member = async (name: string, role: string) => {
    const user = randomUUID();
    await q("INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, jsonb_build_object('display_name', $3::text))", [user, `${name.toLowerCase()}@example.com`, name]);
    return (await q<{ id: string }>('UPDATE pm.team_members SET role = $2 WHERE auth_user_id = $1 RETURNING id', [user, role]))[0].id;
  };
  const owner = await member('Olivia', 'owner');
  const admin = await member('Adam', 'admin');
  const morgan = await member('Morgan', 'member');
  const riley = await member('Riley', 'member');
  const newbie = await member('Nate', 'member');
  const guest = await member('Gus', 'guest');
  const lead = await member('Lead', 'agent');
  const worker = await member('Worker', 'agent');
  const other = await member('Other', 'agent');
  const spender = await member('Spender', 'agent');
  const capper = await member('Capper', 'agent');
  const limited = await member('Limited', 'agent');
  const builder = await member('Builder', 'agent');
  const adminsAgent = await member('Helper', 'agent');
  await q('UPDATE pm.team_members SET orchestrator_id = $1 WHERE id = $2', [lead, worker]);
  for (const agent of [lead, worker, other, spender, capper, limited, builder]) await q('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [agent, owner]);
  await q('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [worker, riley]);
  await q('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [adminsAgent, admin]);
  await q("UPDATE pm.team_members SET agent_template_key = 'builder' WHERE id = $1", [builder]);
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  for (const m of [worker, morgan, guest]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [project, m]);
  const keyIds = new Map<string, string>();
  const key = async (memberId: string, scopes: string[], prefix = 'pk_live_') => {
    const secret = `${prefix}${randomUUID().replace(/-/g, '')}`;
    const id = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', $4, $1, $2, $3, 'scoped') RETURNING id`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes, secret.slice(0, 15)]))[0].id;
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, k, 'api', 'allow' FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`, [memberId, scopes]);
    keyIds.set(secret, id);
    return secret;
  };
  const AGENT = ['tasks.read', 'tasks.create', 'questions.ask', 'agent_activity.write', 'projects.read', 'notifications.manage_own'];
  const keys = {
    owner: await key(owner, ['team.read', 'team.manage', 'api_keys.manage_all', 'tasks.read', 'projects.read', 'webhooks.manage', 'agents.act_for']),
    admin: await key(admin, ['api_keys.manage_all', 'team.read']),
    lead: await key(lead, AGENT),
    worker: await key(worker, AGENT),
    worker2: await key(worker, AGENT),
    spender: await key(spender, AGENT),
    capper: await key(capper, AGENT),
    limited: await key(limited, AGENT),
    limited2: await key(limited, AGENT),
    other: await key(other, [...AGENT, 'agents.act_for']),
    builder: await key(builder, AGENT),
    adminsAgent: await key(adminsAgent, AGENT),
  };
  // The admin's own child key (made by the admin's key).
  const child = `pk_live_${randomUUID().replace(/-/g, '')}`;
  await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions, created_by_key_id) VALUES ('Child', 'pk_live_child', $1, $2, '{team.read}', 'scoped', $3)`,
    [createHash('sha256').update(child).digest('hex'), admin, keyIds.get(keys.admin)]);
  return { q, owner, admin, morgan, riley, newbie, guest, lead, worker, other, spender, capper, limited, builder, adminsAgent, project, keys, keyIds, key };
}

async function main() {
  await migrationChecks();
  pureChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn(db) });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', APP_ENCRYPTION_KEY: 'e'.repeat(64), NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const runsRoute = await import('../src/app/api/v1/agents/runs/route');
    const runRoute = await import('../src/app/api/v1/agents/runs/[id]/route');
    const heartbeatRoute = await import('../src/app/api/v1/agents/heartbeat/route');
    const activitiesRoute = await import('../src/app/api/v1/agent-activities/route');
    const tasksRoute = await import('../src/app/api/v1/tasks/route');
    const questionsRoute = await import('../src/app/api/v1/questions/route');
    const approvalsRoute = await import('../src/app/api/v1/approvals/route');
    const hireRoute = await import('../src/app/api/v1/agents/hire/route');
    const agentsRoute = await import('../src/app/api/v1/agents/route');
    const keysRoute = await import('../src/app/api/v1/api-keys/route');
    const keyRoute = await import('../src/app/api/v1/api-keys/[id]/route');
    const revokeRoute = await import('../src/app/api/v1/api-keys/[id]/revoke/route');
    const pauseRoute = await import('../src/app/api/v1/api-keys/[id]/pause/route');
    const unusedRoute = await import('../src/app/api/v1/api-keys/revoke-unused/route');
    const delegationsRoute = await import('../src/app/api/v1/delegations/route');
    const chatRoute = await import('../src/app/api/v1/chat/messages/route');
    const hooksRoute = await import('../src/app/api/v1/webhook-endpoints/route');
    const powersRoute = await import('../src/app/api/v1/agents/[id]/powers/route');
    const mcpRoute = await import('../src/app/api/mcp/route');
    const { assertAgentMayAsk } = await import('../src/lib/api/approver-reach');
    const { decideSetupConfirm, mySetupSessions } = await import('../src/lib/api/ai-setup');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { createPmClient } = await import('../src/lib/supabase/pm-client');
    const service = createPmClient(server.url, 'fake-service-key');

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const ask = (apiKey: string, body: unknown) => call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, apiKey, body);
    const approve = (apiKey: string, body: unknown) => call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, apiKey, body);
    const listTasks = (apiKey: string) => call(tasksRoute.GET, 'GET', '/api/v1/tasks', {}, apiKey);

    // ── Finding 3: budgets are not advisory ──────────────────────────────
    const run = await call(runsRoute.POST, 'POST', '/api/v1/agents/runs', {}, s.keys.spender, { title: 'Work', cost_usd: 1, tokens_in: 100 });
    const runId = run.body?.data?.id as string;
    const lower = await call(runRoute.PATCH, 'PATCH', `/api/v1/agents/runs/${runId}`, { id: runId }, s.keys.spender, { cost_usd: 0.5 });
    check('3: a run\'s cost cannot be lowered (409 spend_decrease)', lower.status === 409 && reason(lower) === 'spend_decrease', lower.body);
    const fewer = await call(runRoute.PATCH, 'PATCH', `/api/v1/agents/runs/${runId}`, { id: runId }, s.keys.spender, { tokens_in: 10 });
    check('3: nor its tokens', fewer.status === 409 && reason(fewer) === 'spend_decrease', fewer.body);
    const same = await call(runRoute.PATCH, 'PATCH', `/api/v1/agents/runs/${runId}`, { id: runId }, s.keys.spender, { cost_usd: 1, tokens_in: 100 });
    check('3: the same total again (a retry) is fine', same.status === 200, same.body);
    await s.q('UPDATE pm.agent_runs SET cost_usd = 0.01, tokens_in = 1 WHERE id = $1', [runId]);
    const stored = (await s.q<Loose>('SELECT cost_usd, tokens_in FROM pm.agent_runs WHERE id = $1', [runId]))[0];
    check('3: the database keeps the larger spend even when a write gets past the server', Number(stored.cost_usd) === 1 && Number(stored.tokens_in) === 100, stored);

    // Usage under a run counts, even when the run reports less.
    await call(activitiesRoute.POST, 'POST', '/api/v1/agent-activities', {}, s.keys.spender, {
      activity_type: 'usage.recorded', payload: { source_usage_id: 'u-hidden', run_id: runId, model: 'm', input_tokens: 10, output_tokens: 10, cost_usd: 6 },
    });
    const state = (await s.q<Loose>('SELECT pm.agent_limit_state($1, true) AS s', [s.spender]))[0].s;
    check('3: usage reported under a run counts when the run itself reports less ($6 usage beside a $1 run)', Number(state.spent_usd) === 6, state);

    await s.q('INSERT INTO pm.agent_limits (agent_id, budget_usd) VALUES ($1, 5)', [s.spender]);
    const overWrite = await ask(s.keys.spender, { question: 'Anything else?' });
    check('3: over its budget, an agent\'s writes are refused (402 budget_exceeded), not only start_run', overWrite.status === 402 && reason(overWrite) === 'budget_exceeded', overWrite.body);
    const overTask = await call(tasksRoute.POST, 'POST', '/api/v1/tasks', {}, s.keys.spender, { project_id: s.project, title: 'More' });
    check('3: ... a new task too', overTask.status === 402 && reason(overTask) === 'budget_exceeded', overTask.body);
    const overRead = await listTasks(s.keys.spender);
    check('3: ... while reads still work', overRead.status === 200, overRead.body);
    const overBeat = await call(heartbeatRoute.POST, 'POST', '/api/v1/agents/heartbeat', {}, s.keys.spender, { working: false });
    const overUsage = await call(activitiesRoute.POST, 'POST', '/api/v1/agent-activities', {}, s.keys.spender, {
      activity_type: 'usage.recorded', payload: { source_usage_id: 'u-after', model: 'm', input_tokens: 1, output_tokens: 1, cost_usd: 0.01 },
    });
    const overFinish = await call(runRoute.PATCH, 'PATCH', `/api/v1/agents/runs/${runId}`, { id: runId }, s.keys.spender, { status: 'succeeded' });
    check('3: ... and so do heartbeats, usage and finishing its run', overBeat.status === 200 && overUsage.status === 201 && overFinish.status === 200, { overBeat: overBeat.body, overUsage: overUsage.body, overFinish: overFinish.body });
    const overStart = await call(runsRoute.POST, 'POST', '/api/v1/agents/runs', {}, s.keys.spender, { title: 'Again' });
    check('3: ... and a new run is refused', overStart.status === 402, overStart.body);
    await s.q('UPDATE pm.agent_limits SET budget_usd = 100 WHERE agent_id = $1', [s.spender]);
    const raised = await ask(s.keys.spender, { question: 'Back at it?' });
    check('3: once an Owner raises the budget, its writes go through again', raised.status === 201, raised.body);

    // A run past its own cap holds every write until it is stopped.
    await s.q('INSERT INTO pm.agent_limits (agent_id, max_run_spend_cents) VALUES ($1, 100)', [s.capper]);
    const capRun = (await s.q<{ id: string }>("INSERT INTO pm.agent_runs (agent_id, title, status) VALUES ($1, 'Big', 'running') RETURNING id", [s.capper]))[0].id;
    await s.q(`INSERT INTO pm.agent_activities (agent_id, activity_type, title, description, metadata) VALUES ($1, 'usage.recorded', 'Usage', '', jsonb_build_object('run_id', $2::text, 'cost_usd', 2.5))`, [s.capper, capRun]);
    const capped = await ask(s.keys.capper, { question: 'More?' });
    const capRow = (await s.q<Loose>('SELECT status FROM pm.agent_runs WHERE id = $1', [capRun]))[0];
    check('3: an agent holding a run past its max_run_spend_cents is refused (402 run_spend_exceeded) and the run is stopped', capped.status === 402 && reason(capped) === 'run_spend_exceeded'
      && capped.body.error.details.stopped === true && capRow.status === 'cancelled', { capped: capped.body, capRow });
    const afterStop = await ask(s.keys.capper, { question: 'Fresh start?' });
    check('3: ... and once it is stopped, the next write goes through', afterStop.status === 201, afterStop.body);

    // ── Finding 9: safe defaults at hire, per-agent buckets ──────────────
    const hired = await call(hireRoute.POST, 'POST', '/api/v1/agents/hire', {}, s.keys.owner, { name: 'Nova', template_key: 'weekly-reporter', create_key: true, scopes: ['tasks.read'] });
    const novaId = hired.body?.data?.agent?.id as string;
    const novaLimits = novaId ? (await s.q<Loose>('SELECT budget_usd, budget_period, write_rate_per_minute, send_rate_per_minute FROM pm.agent_limits WHERE agent_id = $1', [novaId]))[0] : null;
    check(`9: a hired agent starts with no budget, ${NEW_AGENT_WRITES_PER_MINUTE} writes and ${NEW_AGENT_SENDS_PER_MINUTE} messages a minute`, hired.status === 201
      && (novaLimits?.budget_usd ?? null) === null && novaLimits?.write_rate_per_minute === 30 && novaLimits?.send_rate_per_minute === 10, { hired: hired.body, novaLimits });
    const novaKeyEnds = Date.parse(hired.body?.data?.key?.expires_at ?? '');
    check(`9: ... and its key ends in ${NEW_AGENT_KEY_DAYS} days`, Math.abs(novaKeyEnds - (Date.now() + NEW_AGENT_KEY_DAYS * DAY)) < 60_000, hired.body?.data?.key);
    const clear = await call(hireRoute.POST, 'POST', '/api/v1/agents/hire', {}, s.keys.owner, {
      name: 'Free', create_key: true, scopes: ['tasks.read'], key_expires_in_days: null,
      limits: { budget_usd: null, write_rate_per_minute: null, send_rate_per_minute: null },
    });
    const freeId = clear.body?.data?.agent?.id as string;
    const freeLimits = freeId ? await s.q('SELECT * FROM pm.agent_limits WHERE agent_id = $1', [freeId]) : null;
    check('9: an Owner may clear every default at hire (no limits row, a key until revoked)', clear.status === 201 && freeLimits?.length === 0 && clear.body.data.key.expires_at === null, { clear: clear.body, freeLimits });
    const created = await call(agentsRoute.POST, 'POST', '/api/v1/agents', {}, s.keys.owner, { name: 'Plain', email: 'plain@example.com' });
    check('9: an agent added with create_agent starts with the defaults too', created.status === 201 && (created.body.data.limits?.budget_usd ?? null) === null && created.body.data.limits?.write_rate_per_minute === 30, created.body);
    const untouched = await s.q('SELECT agent_id FROM pm.agent_limits WHERE agent_id = $1', [s.lead]);
    check('9: agents made before keep no limits (additive)', untouched.length === 0);
    const plainKey = await call(keysRoute.POST, 'POST', '/api/v1/api-keys', {}, s.keys.owner, { member_id: s.lead, name: 'New lead key', scopes: ['tasks.read'] });
    check('9: a new key for an existing agent ends in 90 days by default', plainKey.status === 201 && Math.abs(Date.parse(plainKey.body.data.key.expires_at) - (Date.now() + 90 * DAY)) < 60_000, plainKey.body);
    const forever = await call(keysRoute.POST, 'POST', '/api/v1/api-keys', {}, s.keys.owner, { member_id: s.lead, name: 'Forever', scopes: ['tasks.read'], expires_in_days: null });
    check('9: ... an Owner may still make one that lasts until revoked', forever.status === 201 && forever.body.data.key.expires_at === null, forever.body);

    await s.q('INSERT INTO pm.agent_limits (agent_id, write_rate_per_minute, send_rate_per_minute) VALUES ($1, 3, 2)', [s.limited]);
    const w1 = await call(heartbeatRoute.POST, 'POST', '/api/v1/agents/heartbeat', {}, s.keys.limited, { working: false });
    const q1 = await ask(s.keys.limited, { question: 'One?' });
    const q2 = await ask(s.keys.limited2, { question: 'Two?' });
    const q3 = await ask(s.keys.limited, { question: 'Three?' });
    check('9: sends are counted per agent across its keys (third message in a minute: 429 send_rate_limited)', w1.status === 200 && q1.status === 201 && q2.status === 201
      && q3.status === 429 && reason(q3) === 'send_rate_limited', { q1: q1.status, q2: q2.status, q3: q3.body });
    const t1 = await call(tasksRoute.POST, 'POST', '/api/v1/tasks', {}, s.keys.limited2, { project_id: s.project, title: 'Write four' });
    check('9: writes are counted per agent across its keys, telemetry not (fourth write: 429 write_rate_limited)', t1.status === 429 && reason(t1) === 'write_rate_limited', t1.body);
    const r1 = await listTasks(s.keys.limited);
    check('9: ... reads are not counted', r1.status === 200, r1.body);

    // MCP handshakes count against the key's rate.
    await s.q('INSERT INTO pm.agent_limits (agent_id, rate_per_minute) VALUES ($1, 2) ON CONFLICT (agent_id) DO UPDATE SET rate_per_minute = 2', [s.other]);
    await s.q('DELETE FROM pm.agent_rate_limit_windows WHERE agent_id = $1', [s.other]);
    const handshake = async () => (await mcpRoute.POST(new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'x-api-key': s.keys.other, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    }))).status;
    const h1 = await handshake();
    const h2 = await handshake();
    const h3 = await handshake();
    check('9: MCP handshakes are counted (the third in a minute at a limit of 2 is 429)', h1 !== 429 && h2 !== 429 && h3 === 429, { h1, h2, h3 });
    await s.q('DELETE FROM pm.agent_limits WHERE agent_id = $1', [s.other]);

    // ── Finding 4: who an agent may ask ──────────────────────────────────
    const toNewbie = await approve(s.keys.worker, { action: { type: 'invoice.pay', summary: 'Pay invoice 4417' }, asked_to: s.newbie });
    check('4: an approval to a member who neither manages it nor works on the project is refused, naming who it may ask', toNewbie.status === 422 && reason(toNewbie) === 'approver_not_allowed'
      && toNewbie.body.error.details.allowed.some((a: Loose) => a.id === s.riley) && !toNewbie.body.error.details.allowed.some((a: Loose) => a.id === s.newbie), toNewbie.body);
    const toGuest = await approve(s.keys.worker, { action: { type: 'invoice.pay', summary: 'Pay it' }, asked_to: s.guest, project_id: s.project });
    check('4: ... to a guest on the project too', toGuest.status === 422 && reason(toGuest) === 'approver_not_allowed', toGuest.body);
    const toAgent = await approve(s.keys.worker, { action: { type: 'invoice.pay', summary: 'Pay it' }, asked_to: s.other });
    check('4: ... and to another agent outside its orchestrator chain', toAgent.status === 422 && reason(toAgent) === 'approver_not_allowed', toAgent.body);
    const toManager = await approve(s.keys.worker, { action: { type: 'invoice.pay', summary: 'Pay it' }, asked_to: s.riley });
    const toOwner = await approve(s.keys.worker, { action: { type: 'invoice.pay', summary: 'Pay it' }, asked_to: s.owner });
    const toPeer = await approve(s.keys.worker, { action: { type: 'invoice.pay', summary: 'Pay it' }, asked_to: s.morgan, project_id: s.project });
    const toLead = await approve(s.keys.worker, { action: { type: 'invoice.pay', summary: 'Pay it' }, asked_to: s.lead });
    const toDefault = await approve(s.keys.worker, { action: { type: 'invoice.pay', summary: 'Pay it' } });
    check('4: its manager, an Owner, a person on the project, its orchestrator and its default all work', [toManager, toOwner, toPeer, toLead, toDefault].every((a) => a.status === 201),
      [toManager, toOwner, toPeer, toLead, toDefault].map((a) => [a.status, reason(a)]));
    const askGuest = await ask(s.keys.lead, { question: 'Can you send the logo?', asked_to: s.guest });
    check('4: an agent never asks a guest a plain question either (422 asked_guest)', askGuest.status === 422 && reason(askGuest) === 'asked_guest', askGuest.body);
    const askAnyone = await ask(s.keys.lead, { question: 'Which font?', asked_to: s.newbie });
    check('4: a plain question keeps today\'s reach (any member)', askAnyone.status === 201, askAnyone.body);
    const withAction = await assertAgentMayAsk(service, s.lead, { asked_to: s.newbie, asked_to_group: null }, null, true).then(() => 'ok', (e) => e?.details?.reason);
    check('4: a question that carries an action follows the approval rule', withAction === 'approver_not_allowed', withAction);

    // ── Finding 6: act-for needs proof, DMs need chat.notify ─────────────
    const identity = (await s.q<{ id: string }>("INSERT INTO pm.member_identities (member_id, provider, external_id, verified_at, verified_method) VALUES ($1, 'telegram', '555001', now(), 'link') RETURNING id", [s.morgan]))[0].id;
    const connection = (await s.q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials, kind) VALUES ('telegram', 'Bot', 'pm1:x', 'company') RETURNING id"))[0].id;
    await s.q('INSERT INTO pm.chat_connection_agents (connection_id, agent_id) VALUES ($1, $2)', [connection, s.other]);
    const mint = () => call(delegationsRoute.POST, 'POST', '/api/v1/delegations', {}, s.keys.other, { provider: 'telegram', external_id: '555001' });
    const cold = await mint();
    check('6: a pass for a linked person who has not written to the agent is refused (403 act_for_no_recent_message)', cold.status === 403 && reason(cold) === 'act_for_no_recent_message', cold.body);
    const inbound = (await s.q<{ id: string }>(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, external_user_id, identity_id, member_id, agent_id, text, created_at)
      VALUES ($1, 'inbound', 'pending', 'c1', '555001', $2, $3, $4, 'hi', now() - interval '45 minutes') RETURNING id`, [connection, identity, s.morgan, s.other]))[0].id;
    const stale = await mint();
    check('6: ... and so is one whose last message is older than 30 minutes', stale.status === 403 && reason(stale) === 'act_for_no_recent_message', stale.body);
    await s.q("UPDATE pm.chat_messages SET created_at = now() - interval '2 minutes' WHERE id = $1", [inbound]);
    const warm = await mint();
    check('6: right after they write, the pass is minted', warm.status === 201 && typeof warm.body?.data?.token === 'string', warm.body);
    await s.q("UPDATE pm.chat_messages SET created_at = now() - interval '40 minutes' WHERE id = $1", [inbound]);
    const dm = await call(chatRoute.POST, 'POST', '/api/v1/chat/messages', {}, s.keys.other, { person_id: s.morgan, text: 'Following up' }, { 'x-act-for': warm.body?.data?.token ?? '' });
    check('6: a DM to someone who did not just write needs chat.notify, even while acting for them', dm.status === 403 && reason(dm) === 'chat_notify_required', dm.body);

    // ── Finding 11: manage_all is not an Owner ───────────────────────────
    const ownerKeyId = s.keyIds.get(s.keys.owner)!;
    const ownersAgentKeyId = s.keyIds.get(s.keys.worker)!;
    const adminsAgentKeyId = s.keyIds.get(s.keys.adminsAgent)!;
    const revokeOwner = await call(revokeRoute.POST, 'POST', `/api/v1/api-keys/${ownerKeyId}/revoke`, { id: ownerKeyId }, s.keys.admin);
    check('11: an Admin\'s manage_all key cannot revoke an Owner\'s key (403 owner_key_protected)', revokeOwner.status === 403 && reason(revokeOwner) === 'owner_key_protected', revokeOwner.body);
    const pauseAgent = await call(pauseRoute.POST, 'POST', `/api/v1/api-keys/${ownersAgentKeyId}/pause`, { id: ownersAgentKeyId }, s.keys.admin);
    check('11: ... nor pause an Owner\'s agent\'s key', pauseAgent.status === 403 && reason(pauseAgent) === 'owner_key_protected', pauseAgent.body);
    const strip = await call(keyRoute.PATCH, 'PATCH', `/api/v1/api-keys/${ownersAgentKeyId}`, { id: ownersAgentKeyId }, s.keys.admin, { scopes: ['tasks.read'] });
    check('11: ... nor strip its scopes', strip.status === 403 && reason(strip) === 'owner_key_protected', strip.body);
    const unused = await call(unusedRoute.POST, 'POST', '/api/v1/api-keys/revoke-unused', {}, s.keys.admin, { dry_run: true });
    const unusedIds = (unused.body?.data?.keys ?? []).map((k: Loose) => k.id);
    check('11: ... and revoke-unused leaves those keys out', unused.status === 200 && !unusedIds.includes(ownerKeyId) && !unusedIds.includes(ownersAgentKeyId), unused.body);
    const pauseOwn = await call(pauseRoute.POST, 'POST', `/api/v1/api-keys/${adminsAgentKeyId}/pause`, { id: adminsAgentKeyId }, s.keys.admin);
    check('11: it still manages keys of agents no Owner manages', pauseOwn.status === 200, pauseOwn.body);
    const ownerPause = await call(pauseRoute.POST, 'POST', `/api/v1/api-keys/${ownersAgentKeyId}/pause`, { id: ownersAgentKeyId }, s.keys.owner);
    check('11: an Owner\'s key still pauses an Owner\'s agent\'s key', ownerPause.status === 200, ownerPause.body);

    // ── Finding 8: an AI setup session's keys ────────────────────────────
    const setupSecret = await s.key(s.owner, ['team.read', 'team.manage', 'project_members.manage', 'projects.read', 'api_keys.manage_all', 'webhooks.manage'], 'pk_setup_');
    const ownerAccess = await resolveMemberAccess(service, s.owner);
    const sessionId = (await s.q<{ id: string }>(`INSERT INTO pm.ai_setup_sessions (member_id, kind, api_key_id, client_name, scopes, expires_at)
      VALUES ($1, 'key', $2, 'AI setup key', $3, now() + interval '1 hour') RETURNING id`,
    [s.owner, s.keyIds.get(setupSecret), ['team.read', 'team.manage', 'api_keys.manage_all', 'webhooks.manage', 'tasks.read', 'tasks.create', 'agents.act_for', 'projects.read', 'projects.manage', 'questions.ask']]))[0].id;
    await s.q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'tasks.read', 'api', 'allow') ON CONFLICT DO NOTHING`, [s.builder]);
    const outside = await call(keysRoute.POST, 'POST', '/api/v1/api-keys', {}, setupSecret, { member_id: s.builder, name: 'Too much', scopes: ['tasks.read', 'projects.manage'] });
    check('8: in a session, a key with a power outside the agent\'s template is refused (403 ai_setup_scope_outside_template)', outside.status === 403 && reason(outside) === 'ai_setup_scope_outside_template'
      && outside.body.error.details.outside_template.join() === 'projects.manage', outside.body);
    const held = await call(keysRoute.POST, 'POST', '/api/v1/api-keys', {}, setupSecret, { member_id: s.builder, name: 'Builder key', scopes: ['tasks.read', 'agents.act_for'] });
    const heldKey = held.body?.data?.key;
    check('8: a sensitive power is left off the key and waits for the Owner (needs_owner_confirm)', held.status === 201 && heldKey?.scopes?.join() === 'tasks.read'
      && held.body.data.needs_owner_confirm?.scopes?.join() === 'agents.act_for', held.body);
    const confirmRow = (await s.q<Loose>('SELECT id, status FROM pm.ai_setup_confirms WHERE api_key_id = $1', [heldKey?.id]))[0];
    const stamped = (await s.q<Loose>('SELECT ai_setup_session_id, expires_at FROM pm.api_keys WHERE id = $1', [heldKey?.id]))[0];
    check('8: the key records its session and ends in 90 days', stamped?.ai_setup_session_id === sessionId && Math.abs(Date.parse(stamped.expires_at) - (Date.now() + 90 * DAY)) < 60_000, stamped);
    const listed = (await mySetupSessions(service, s.owner)).sessions.find((x) => x.id === sessionId);
    check('8: the setup screen lists every key the session made and what waits', listed?.keys.some((k) => k.id === heldKey?.id) === true && listed?.confirms.some((c) => c.id === confirmRow?.id && c.status === 'pending') === true, listed);
    const someoneElse = await decideSetupConfirm(service, { memberId: s.admin, access: (await resolveMemberAccess(service, s.admin))! }, confirmRow?.id ?? randomUUID(), true).then(() => 'ok', (e) => e?.details?.reason ?? String(e));
    check('8: only the Owner whose session it was can allow it', someoneElse === 'not_found', someoneElse);
    const allowed = await decideSetupConfirm(service, { memberId: s.owner, access: ownerAccess! }, confirmRow?.id ?? randomUUID(), true).then((v) => v.status, (e) => `${e?.statusCode} ${e?.message}`);
    const afterAllow = (await s.q<Loose>('SELECT scopes FROM pm.api_keys WHERE id = $1', [heldKey?.id]))[0];
    check('8: the Owner\'s Allow adds the power to the key', allowed === 'allowed' && afterAllow.scopes.includes('agents.act_for'), { allowed, afterAllow });
    const twice = await decideSetupConfirm(service, { memberId: s.owner, access: ownerAccess! }, confirmRow?.id ?? randomUUID(), true).then(() => 'ok', (e) => e?.details?.reason);
    check('8: ... once', twice === 'already_decided', twice);
    const plainOwner = await call(keysRoute.POST, 'POST', '/api/v1/api-keys', {}, s.keys.owner, { member_id: s.other, name: 'Act', scopes: ['agents.act_for'] });
    check('8: outside a session an Owner\'s key makes such a key as before (nothing waits)', plainOwner.status === 201 && !plainOwner.body.data.needs_owner_confirm && plainOwner.body.data.key.scopes.includes('agents.act_for'), plainOwner.body);
    const powersPath = `/api/v1/agents/${s.builder}/powers`;
    const readPowers = await call(powersRoute.GET, 'GET', powersPath, { id: s.builder }, setupSecret);
    check('8: a session reads an agent\'s powers', readPowers.status === 200 && readPowers.body.data.scopes.includes('agents.act_for'), readPowers.body);
    // A second key the session makes lacks act_for (it waits); setting a list with it must not copy it across.
    const second = await call(keysRoute.POST, 'POST', '/api/v1/api-keys', {}, setupSecret, { member_id: s.builder, name: 'Builder key two', scopes: ['tasks.read', 'agents.act_for'] });
    check('8: a second session key comes back without the sensitive power', second.status === 201 && !second.body.data.key.scopes.includes('agents.act_for'), second.body);
    const spread = await call(powersRoute.PUT, 'PUT', powersPath, { id: s.builder }, setupSecret, { scopes: ['tasks.read', 'agents.act_for'] });
    const secondAfter = (await s.q<Loose>('SELECT scopes FROM pm.api_keys WHERE id = $1', [second.body?.data?.key?.id]))[0];
    check('8: ... and set_agent_powers never copies one key\'s sensitive power onto it (403 ai_setup_needs_owner)', spread.status === 403 && reason(spread) === 'ai_setup_needs_owner'
      && spread.body.error.details.needs_owner.join() === 'agents.act_for' && !secondAfter?.scopes?.includes('agents.act_for'), { status: spread.status, body: spread.body, secondAfter });
    const keepPowers = await call(powersRoute.PUT, 'PUT', powersPath, { id: s.builder }, setupSecret, { scopes: ['tasks.read'] });
    check('8: a session may set an agent\'s powers within its template (taking a sensitive one away is fine)', keepPowers.status === 200, keepPowers.body);
    const sensitivePowers = await call(powersRoute.PUT, 'PUT', powersPath, { id: s.builder }, setupSecret, { scopes: ['tasks.read', 'chat.notify'] });
    check('8: ... but never adds a sensitive one (403 ai_setup_needs_owner)', sensitivePowers.status === 403 && reason(sensitivePowers) === 'ai_setup_needs_owner'
      && sensitivePowers.body.error.details.needs_owner.join() === 'chat.notify', sensitivePowers.body);
    const outsidePowers = await call(powersRoute.PUT, 'PUT', powersPath, { id: s.builder }, setupSecret, { scopes: ['tasks.read', 'projects.manage'] });
    check('8: ... nor one outside its template (403 ai_setup_scope_outside_template)', outsidePowers.status === 403 && reason(outsidePowers) === 'ai_setup_scope_outside_template', outsidePowers.body);
    await call(hooksRoute.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner, { name: 'Known', url: 'https://known.example.com/a', events: ['task.created'] });
    const known = await call(hooksRoute.POST, 'POST', '/api/v1/webhook-endpoints', {}, setupSecret, { name: 'Builder wake', url: 'https://known.example.com/b', events: ['task.created'], member_id: s.builder });
    const fresh = await call(hooksRoute.POST, 'POST', '/api/v1/webhook-endpoints', {}, setupSecret, { name: 'Elsewhere', url: 'https://attacker.example.net/x', events: ['task.created'], member_id: s.builder });
    check('8: a session\'s webhook to an address already in use is on at once', known.status === 201 && known.body.data.endpoint.is_active === true && !known.body.data.needs_owner_confirm, known.body);
    check('8: ... one to a new address is made switched off and waits for the Owner', fresh.status === 201 && fresh.body.data.endpoint.is_active === false && fresh.body.data.needs_owner_confirm?.host === 'attacker.example.net', fresh.body);
    await sleep(50);
  } finally {
    await server.close();
    await db.close();
  }
  if (failures.length) {
    console.error(`agent limits security: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`agent limits security: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
