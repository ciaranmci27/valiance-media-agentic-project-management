/**
 * Approval decisions (20261125000700_approval_decisions.sql): whoever an
 * approval names decides it, and an AI tool never stands in for a person's
 * decision. Through the real v1 routes, the MCP route (keys and Connect AI
 * tokens) and the questions service as the app uses it, on a fake PostgREST
 * over PGlite with the full schema:
 * - The person named decides in the app; decided_via app is stored and the
 *   question.answered webhook carries it. The Owner overrides in the app.
 * - Their connected AI tool is refused (403 approval_needs_person), even
 *   with approvals.decide among its scopes; so is the Owner's.
 * - Their own key without approvals.decide is refused; with it, it decides
 *   (decided_via api_key). The same for the Owner's override.
 * - An agent named in asked_to may be asked, and decides with its own key
 *   (decided_via agent); others are not_asked. An agent never asks itself,
 *   and an escalation default that lands on an agent is still refused.
 * - Acting for a person (X-Act-For): refused without approvals.decide on
 *   the key, or when the person does not hold it; with both it decides as
 *   the person (decided_by them, decided_via act_for); never its own request.
 * - Plain questions answer exactly as before (no decided_via anywhere).
 * - approvals.decide: core; admins and members hold it on the API (so a
 *   person adds it to their own key without an Owner), no agent does, no
 *   key carries it by default, never a connect scope.
 * - The migration, run twice on the schema before it, matches schema.sql,
 *   and the previous release still decides approvals.
 *
 *   npm run -s test:approval-decisions
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';

const MIGRATION = '20261125000700_approval_decisions.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- APPROVAL DECISIONS (20261125000700_approval_decisions.sql)';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const APPROVAL = { type: 'deploy', summary: 'Deploy v2.4.0 to production' };

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the approval decisions section is there', at > 0 && banner > 0);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('ALTER TABLE pm.questions ADD COLUMN IF NOT EXISTS decided_via')).trim();
  check('schema.sql: the section mirrors the migration body', body.length > 1000 && SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const agent = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Bot', 'bot@example.com', 'agent') RETURNING id"))[0].id;
  const person = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'owner') RETURNING id"))[0].id;
  const insert = `INSERT INTO pm.questions (asked_by, asked_to, question, kind, action, choices, allow_other)
    VALUES ($1, $2, 'Deploy?', 'approval', '{"type":"deploy","summary":"Deploy"}', '["approve","reject"]', false) RETURNING id`;
  const before = (await q<{ id: string }>(insert, [agent, person]))[0].id;
  await q("UPDATE pm.questions SET status = 'answered', answer_choice = 'approve', answered_by = $2, answered_at = now() WHERE id = $1", [before, person]);
  await applyMigrationsFrom(old, MIGRATION);
  const kept = (await q<Loose>('SELECT status, decided_via FROM pm.questions WHERE id = $1', [before]))[0];
  check('upgrade: an approval decided before reads as decided, with no decided_via', kept?.status === 'answered' && kept.decided_via === null, kept);
  // The previous release decides without decided_via.
  const open = (await q<{ id: string }>(insert, [agent, person]))[0].id;
  const oldWrite = await old.query("UPDATE pm.questions SET status = 'answered', answer_choice = 'reject', answered_by = $2, answered_at = now() WHERE id = $1 RETURNING decided_via", [open, person])
    .then((r) => r.rows as Loose[], (e: Error) => e.message);
  check('upgrade: the previous release still decides approvals', Array.isArray(oldWrite) && oldWrite[0]?.decided_via === null, oldWrite);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  const grants = (await q<Loose>("SELECT has_function_privilege('anon', 'pm.emit_question_webhook()', 'EXECUTE') AS anon, has_function_privilege('authenticated', 'pm.emit_question_webhook()', 'EXECUTE') AS auth"))[0];
  check('function: the webhook trigger is callable by no browser role', grants.anon === false && grants.auth === false, grants);
  await old.close();
  await fresh.close();
}

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string) =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase().replace(/\s/g, '')}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const mia = await member('Mia', 'member');
  const max = await member('Max', 'member');
  const nina = await member('Nina', 'member');
  const builder = await member('Builder', 'agent');
  const reviewer = await member('Reviewer AI', 'agent');
  const relay = await member('Relay', 'agent');
  const apex = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  // Relay escalates to another agent: an approval has no one to go to by default.
  await q('UPDATE pm.team_members SET agent_escalate_to = $1 WHERE id = $2', [reviewer, relay]);
  // An Owner took approvals.decide away from Max in Team > Roles & permissions.
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'approvals.decide', 'api', 'deny')", [max]);
  for (const m of [mia, max, nina, builder, reviewer, relay]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [apex, m]);
  // A key, with its scopes granted to its member on the API (as an Owner does in Team > Roles & permissions).
  const key = async (memberId: string, scopes: string[], grant = true) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [sha(secret), memberId, scopes]);
    if (grant) {
      await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
        SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    }
    return secret;
  };
  // A Connect AI connection: its key (permissions connection), grant and a live access token.
  const client = (await q<{ id: string }>("INSERT INTO pm.oauth_clients (client_id, client_name, redirect_uris) VALUES ('pmc_test', 'Claude', '{https://claude.ai/callback}') RETURNING id"))[0].id;
  const connection = async (memberId: string, scopes: string[]) => {
    const keyId = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Claude', 'pmk_', $1, $2, $3, 'connection') RETURNING id`, [sha(randomUUID()), memberId, scopes]))[0].id;
    const grant = (await q<{ id: string }>(`INSERT INTO pm.oauth_grants (client_id, member_id, api_key_id, scopes, redirect_uri)
      VALUES ($1, $2, $3, $4, 'https://claude.ai/callback') RETURNING id`, [client, memberId, keyId, scopes]))[0].id;
    const token = `pmat_${randomUUID().replace(/-/g, '')}`;
    await q("INSERT INTO pm.oauth_tokens (grant_id, kind, token_hash, expires_at) VALUES ($1, 'access', $2, now() + interval '1 hour')", [grant, sha(token)]);
    return token;
  };
  const pass = async (agentId: string, principalId: string) => {
    const token = `pd_${randomUUID().replace(/-/g, '')}`;
    await q("INSERT INTO pm.delegation_tokens (token_hash, agent_id, principal_id, minted_via, expires_at) VALUES ($1, $2, $3, 'session', now() + interval '15 minutes')",
      [sha(token), agentId, principalId]);
    return token;
  };
  const READ = ['tasks.read', 'projects.read'];
  const AGENT = ['tasks.read', 'tasks.manage_assigned', 'projects.read', 'agent_activity.write'];
  const connectScopes = ['projects.read', 'projects.read_all', 'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'reminders.manage_own'];
  const keys = {
    builder: await key(builder, AGENT),
    reviewer: await key(reviewer, AGENT),
    // Mia: a plain key, and one she added approvals.decide to (she holds it as a member).
    miaPlain: await key(mia, READ),
    miaDecide: await key(mia, [...READ, 'approvals.decide'], false),
    maxPlain: await key(max, READ),
    ownerPlain: await key(owner, READ),
    ownerDecide: await key(owner, [...READ, 'approvals.decide']),
    relayPlain: await key(relay, [...READ, 'agents.act_for']),
    relayDecide: await key(relay, [...READ, 'agents.act_for', 'approvals.decide']),
    // A connection holds what its person holds: even approvals.decide changes nothing.
    miaConnection: await connection(mia, [...connectScopes, 'approvals.decide']),
    ownerConnection: await connection(owner, [...connectScopes, 'approvals.decide']),
    relayForMia: await pass(relay, mia),
    relayForMax: await pass(relay, max),
    // An agent that may change projects and decide for a person, acting for the Owner (answers that do the thing).
    relayManage: await key(relay, [...READ, 'agents.act_for', 'approvals.decide', 'projects.manage']),
    relayForOwner: await pass(relay, owner),
  };
  return { q, owner, mia, max, nina, builder, reviewer, relay, apex, keys };
}

async function main() {
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const approvalsRoute = await import('../src/app/api/v1/approvals/route');
    const questionsRoute = await import('../src/app/api/v1/questions/route');
    const questionRoute = await import('../src/app/api/v1/questions/[id]/route');
    const answerRoute = await import('../src/app/api/v1/questions/[id]/answer/route');
    const mcpRoute = await import('../src/app/api/mcp/route');
    const { answerQuestion, getQuestion } = await import('../src/lib/api/questions');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { CONNECT_SCOPES, connectScopesFor } = await import('../src/lib/connect-ai');
    const { API_ENDPOINT_PERMISSIONS, PERMISSIONS, apiScopesFor } = await import('../src/lib/access-control');
    const { PERMISSION_MODULE } = await import('../src/lib/modules/registry');
    const { NEVER_AGENT_SCOPES } = await import('../src/lib/agents-ui');
    const { decisionLine } = await import('../src/lib/questions');

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string,
      params: Record<string, string>, apiKey: string, body?: unknown, actFor?: string): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(actFor ? { 'x-act-for': actFor } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json() };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const request = async (body: Record<string, unknown>) => {
      const made = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.builder, { project_id: s.apex, action: APPROVAL, ...body });
      if (made.status !== 201) throw new Error(`approval not made: ${JSON.stringify(made.body)}`);
      return made.body.data.id as string;
    };
    const answer = (apiKey: string, id: string, body: unknown, actFor?: string) =>
      call(answerRoute.POST, 'POST', `/api/v1/questions/${id}/answer`, { id }, apiKey, body, actFor);
    const read = (apiKey: string, id: string, actFor?: string) => call(questionRoute.GET, 'GET', `/api/v1/questions/${id}`, { id }, apiKey, undefined, actFor);
    const stored = async (id: string) => (await s.q<Loose>('SELECT status, answered_by, decided_via FROM pm.questions WHERE id = $1', [id]))[0];
    const mcp = async (credential: { bearer?: string; key?: string }, name: string, args: Record<string, unknown>) => {
      const response = await mcpRoute.POST(new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
          ...(credential.bearer ? { authorization: `Bearer ${credential.bearer}` } : {}),
          ...(credential.key ? { 'x-api-key': credential.key } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }));
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text); } catch { body = null; }
      return body?.result?.structuredContent as Loose ?? { http: response.status, text: text.slice(0, 500) };
    };
    const appCtx = async (memberId: string) => ({ db: getServiceClient(), access: (await resolveMemberAccess(getServiceClient(), memberId))!, memberId, channel: 'app' as const });
    const hooks = async (id: string) => s.q<Loose>("SELECT event_type, payload FROM pm.webhook_events WHERE resource_type = 'question' AND resource_id = $1 ORDER BY sequence", [id]);
    await s.q(`INSERT INTO pm.webhook_endpoints (name, url, secret, events)
      VALUES ('All', 'https://hooks.example.test/all', 'whsec_a', '{question.asked,question.answered,question.cancelled}')`);

    // ── Plumbing ────────────────────────────────────────────────────────
    check('permission: approvals.decide is a core permission and an API scope', PERMISSIONS.includes('approvals.decide')
      && PERMISSION_MODULE['approvals.decide'] === 'core' && API_ENDPOINT_PERMISSIONS.includes('approvals.decide'));
    check('permission: never a connect scope; an agent key may carry it (acting for someone)', !CONNECT_SCOPES.includes('approvals.decide')
      && !NEVER_AGENT_SCOPES.includes('approvals.decide'));
    check('permission: admins and members hold it on the API by default; agents and guests do not', (await s.q<Loose>("SELECT role, access_channel FROM pm.role_permissions WHERE permission_key = 'approvals.decide' ORDER BY role"))
      .map((r: Loose) => `${r.role}:${r.access_channel}`).join(',') === 'admin:api,member:api');
    const ninaAccess = await resolveMemberAccess(getServiceClient(), s.nina);
    const builderAccess = await resolveMemberAccess(getServiceClient(), s.builder);
    check('permission: a member may add it to their own key without an Owner; an agent may not', apiScopesFor(ninaAccess).includes('approvals.decide')
      && !apiScopesFor(builderAccess).includes('approvals.decide'));
    check('permission: no key carries it by default', (await s.q<Loose>("SELECT count(*)::int AS n FROM pm.api_keys WHERE 'approvals.decide' = ANY(scopes) AND team_member_id = $1", [s.nina]))[0].n === 0);
    const ownerAccess = await resolveMemberAccess(getServiceClient(), s.owner);
    check('permission: an Owner\'s connection never gets it, though the Owner holds it', !connectScopesFor(ownerAccess).includes('approvals.decide')
      && !connectScopesFor(ownerAccess, { withMemory: true }).includes('approvals.decide'));

    // ── The person named, in the app ────────────────────────────────────
    const inApp = await request({ asked_to: s.mia });
    const miaApp = await appCtx(s.mia);
    const before = await getQuestion(miaApp, inApp);
    check('app: the person named may decide it', before.can_answer === true, before.can_answer);
    const decided = await answerQuestion(miaApp, inApp, { choice: 'approve', text: 'After 6pm' });
    check('app: the person named decides in the app; decided_via app', decided.decision === 'approved' && decided.decided_by === s.mia
      && decided.decided_via === 'app' && (await stored(inApp)).decided_via === 'app', [decided, await stored(inApp)]);
    const answeredHook = (await hooks(inApp)).find((e) => e.event_type === 'question.answered')?.payload.data.question;
    const askedHook = (await hooks(inApp)).find((e) => e.event_type === 'question.asked')?.payload.data.question;
    check('webhook: question.answered carries decided_via; question.asked has it null', answeredHook?.decided_via === 'app' && answeredHook.decided_by === s.mia
      && askedHook && 'decided_via' in askedHook && askedHook.decided_via === null, [answeredHook, askedHook]);
    const polled = await call(questionRoute.GET, 'GET', `/api/v1/questions/${inApp}`, { id: inApp }, s.keys.builder);
    check('poll: the asking agent reads decided_via', polled.body.data?.decided_via === 'app', polled.body.data);

    const override = await request({ asked_to: s.mia });
    const byOwner = await answerQuestion(await appCtx(s.owner), override, { choice: 'reject' });
    check('app: the Owner overrides in the app (decided_by the Owner, decided_via app)', byOwner.decided_by === s.owner && byOwner.decided_via === 'app', byOwner);
    const notMax = await request({ asked_to: s.mia });
    const maxTry = await answerQuestion(await appCtx(s.max), notMax, { choice: 'approve' }).then(() => 'decided', (e: Loose) => e?.details?.reason);
    check('app: someone else is not_asked', maxTry === 'not_asked', maxTry);

    // ── A connected AI tool ─────────────────────────────────────────────
    const forMia = await request({ asked_to: s.mia });
    const miaToolView = await mcp({ bearer: s.keys.miaConnection }, 'get_approval', { approval_id: forMia });
    check('connection: the person\'s own tool sees it but may not decide it', miaToolView?.ok === true && miaToolView.data.can_answer === false, miaToolView);
    const miaTool = await mcp({ bearer: s.keys.miaConnection }, 'answer_question', { question_id: forMia, choice: 'approve' });
    check('connection: the person\'s connected AI tool is refused, even with approvals.decide in its scopes', miaTool?.ok === false && miaTool.status === 403
      && miaTool.error?.reason === 'approval_needs_person' && /connected AI tool/.test(miaTool.error?.message ?? '') && /in the app/.test(miaTool.error?.hint ?? ''), miaTool);
    const ownerTool = await mcp({ bearer: s.keys.ownerConnection }, 'answer_question', { question_id: forMia, choice: 'approve' });
    check('connection: the Owner\'s connected AI tool is refused too', ownerTool?.ok === false && ownerTool.error?.reason === 'approval_needs_person', ownerTool);
    const forOwner = await request({ asked_to: s.owner });
    const ownerOwn = await mcp({ bearer: s.keys.ownerConnection }, 'answer_question', { question_id: forOwner, choice: 'approve' });
    check('connection: even on an approval asked to the Owner', ownerOwn?.ok === false && ownerOwn.error?.reason === 'approval_needs_person', ownerOwn);
    check('connection: nothing was decided', (await stored(forMia)).status === 'open' && (await stored(forOwner)).status === 'open');

    // ── The person's own key ────────────────────────────────────────────
    const plainKey = await answer(s.keys.miaPlain, forMia, { choice: 'approve' });
    check('key: the person\'s key without approvals.decide is refused, saying what is needed', plainKey.status === 403 && reason(plainKey) === 'approval_needs_person'
      && plainKey.body.error?.details?.needs === 'approvals.decide' && /approvals\.decide/.test(plainKey.body.error?.message ?? ''), plainKey.body);
    const plainView = await read(s.keys.miaPlain, forMia);
    check('key: can_answer is false for that key', plainView.body.data?.can_answer === false, plainView.body.data?.can_answer);
    const decideKey = await answer(s.keys.miaDecide, forMia, { choice: 'approve' });
    check('key: with approvals.decide it decides; decided_via api_key', decideKey.status === 200 && decideKey.body.data?.decided_by === s.mia
      && decideKey.body.data?.decided_via === 'api_key' && (await stored(forMia)).decided_via === 'api_key', decideKey.body);
    const ownerPlain = await answer(s.keys.ownerPlain, forOwner, { choice: 'approve' });
    check('key: the Owner\'s key without approvals.decide is refused', ownerPlain.status === 403 && reason(ownerPlain) === 'approval_needs_person', ownerPlain.body);
    const toMiaAgain = await request({ asked_to: s.mia });
    const ownerOverride = await answer(s.keys.ownerDecide, toMiaAgain, { choice: 'reject' });
    check('key: the Owner\'s override with approvals.decide (api_key)', ownerOverride.status === 200 && ownerOverride.body.data?.decided_by === s.owner
      && ownerOverride.body.data?.decided_via === 'api_key', ownerOverride.body);
    const notNamed = await request({ asked_to: s.max });
    const miaOnMax = await answer(s.keys.miaDecide, notNamed, { choice: 'approve' });
    check('key: approvals.decide is no say over an approval that names someone else', miaOnMax.status === 403 && reason(miaOnMax) === 'not_asked', miaOnMax.body);
    const overMcp = await request({ asked_to: s.mia });
    const keyOverMcp = await mcp({ key: s.keys.miaPlain }, 'answer_question', { question_id: overMcp, choice: 'approve' });
    const decideOverMcp = await mcp({ key: s.keys.miaDecide }, 'answer_question', { question_id: overMcp, choice: 'approve' });
    check('MCP: answer_question follows the same rule for keys', keyOverMcp?.ok === false && keyOverMcp.error?.reason === 'approval_needs_person'
      && decideOverMcp?.ok === true && decideOverMcp.data.decided_via === 'api_key', [keyOverMcp, decideOverMcp]);

    // ── An agent asked by name ──────────────────────────────────────────
    // An agent approver only from its orchestrator chain (security review finding 4).
    const unrelated = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.builder, { project_id: s.apex, action: { type: 'merge', summary: 'Merge PR #12' }, asked_to: s.reviewer });
    check('agent: an agent outside its orchestrator chain is not an approver (422 approver_not_allowed)', unrelated.status === 422 && reason(unrelated) === 'approver_not_allowed', unrelated.body);
    await s.q('UPDATE pm.team_members SET orchestrator_id = $1 WHERE id = $2', [s.reviewer, s.builder]);
    const askedReviewer = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.builder, { project_id: s.apex, action: { type: 'merge', summary: 'Merge PR #12' }, asked_to: s.reviewer });
    check('agent: its orchestrator, named in asked_to, may be asked to approve', askedReviewer.status === 201 && askedReviewer.body.data?.asked_to === s.reviewer, askedReviewer.body);
    const toReviewer = askedReviewer.body.data?.id as string;
    const askItself = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.reviewer, { project_id: s.apex, action: APPROVAL, asked_to: s.reviewer });
    check('agent: an agent never asks itself to approve', askItself.status === 422 && reason(askItself) === 'asked_self', askItself.body);
    const byDefault = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.relayPlain, { project_id: s.apex, action: APPROVAL });
    check('agent: an escalation default that lands on an agent is still refused', byDefault.status === 422 && reason(byDefault) === 'approver_not_person', byDefault.body);
    const builderOnOwn = await answer(s.keys.builder, toReviewer, { choice: 'approve' });
    check('agent: the agent that asked cannot decide it', builderOnOwn.status === 403 && reason(builderOnOwn) === 'not_asked', builderOnOwn.body);
    // A row asked by and to the same agent (never made by the API) is still no self-approval.
    const selfRow = (await s.q<{ id: string }>(`INSERT INTO pm.questions (project_id, asked_by, asked_to, question, kind, action, choices, allow_other)
      VALUES ($1, $2, $2, 'Merge?', 'approval', '{"type":"merge","summary":"Merge"}', '["approve","reject"]', false) RETURNING id`, [s.apex, s.reviewer]))[0].id;
    const selfDecide = await answer(s.keys.reviewer, selfRow, { choice: 'approve' });
    check('agent: an agent never approves its own request', selfDecide.status === 403 && reason(selfDecide) === 'not_asked', selfDecide.body);
    const reviewerView = await read(s.keys.reviewer, toReviewer);
    check('agent: the agent named may decide it with its own key, no extra scope', reviewerView.body.data?.can_answer === true, reviewerView.body.data);
    const otherAgent = await answer(s.keys.relayDecide, toReviewer, { choice: 'approve' });
    check('agent: another agent is not_asked', otherAgent.status === 403 && reason(otherAgent) === 'not_asked', otherAgent.body);
    const byReviewer = await mcp({ key: s.keys.reviewer }, 'answer_question', { question_id: toReviewer, choice: 'approve', text: 'Tests pass' });
    check('agent: the agent asked decides it (MCP); decided_via agent', byReviewer?.ok === true && byReviewer.data.decided_by === s.reviewer
      && byReviewer.data.decided_via === 'agent' && (await stored(toReviewer)).decided_via === 'agent', byReviewer);
    // Back to no orchestrator: its plain questions go where they are addressed again.
    await s.q('UPDATE pm.team_members SET orchestrator_id = NULL WHERE id = $1', [s.builder]);

    // ── An agent acting for a person ────────────────────────────────────
    const actFor = await request({ asked_to: s.mia });
    const relayPlain = await answer(s.keys.relayPlain, actFor, { choice: 'approve' }, s.keys.relayForMia);
    check('act-for: without approvals.decide on the key it is refused', relayPlain.status === 403 && reason(relayPlain) === 'approval_needs_person'
      && /approvals\.decide/.test(relayPlain.body.error?.message ?? ''), relayPlain.body);
    const relayNoPass = await answer(s.keys.relayDecide, actFor, { choice: 'approve' });
    check('act-for: without X-Act-For the agent is no one named', relayNoPass.status === 403 && reason(relayNoPass) === 'not_asked', relayNoPass.body);
    const forMax = await request({ asked_to: s.max });
    const relayForMax = await answer(s.keys.relayDecide, forMax, { choice: 'approve' }, s.keys.relayForMax);
    check('act-for: refused when the person does not hold approvals.decide', relayForMax.status === 403 && reason(relayForMax) === 'approval_needs_person', relayForMax.body);
    const actView = await read(s.keys.relayDecide, actFor, s.keys.relayForMia);
    check('act-for: can_answer is true with both', actView.body.data?.can_answer === true, actView.body.data);
    const relayDecides = await answer(s.keys.relayDecide, actFor, { choice: 'approve' }, s.keys.relayForMia);
    check('act-for: with approvals.decide on the key and held by the person it decides, as the person (act_for)', relayDecides.status === 200
      && relayDecides.body.data?.decided_by === s.mia && relayDecides.body.data?.decided_by_name === 'Mia' && relayDecides.body.data?.decided_via === 'act_for'
      && (await stored(actFor)).answered_by === s.mia && (await stored(actFor)).decided_via === 'act_for', relayDecides.body);
    const ownRequest = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.relayDecide, { project_id: s.apex, action: APPROVAL, asked_to: s.mia }, s.keys.relayForMia);
    const selfApprove = await answer(s.keys.relayDecide, ownRequest.body.data?.id, { choice: 'approve' }, s.keys.relayForMia);
    check('act-for: an agent never decides a request it made, even for the person named', ownRequest.status === 201 && selfApprove.status === 403
      && reason(selfApprove) === 'not_asked', [ownRequest.body, selfApprove.body]);

    // ── Plain questions: unchanged ──────────────────────────────────────
    const plain = await call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.builder, { project_id: s.apex, question: 'Round up or down?', choices: ['Up', 'Down'], asked_to: s.mia });
    const plainAnswer = await answer(s.keys.miaPlain, plain.body.data.id, { choice: 'Up' });
    check('question: a plain question is answered with a key that has no approvals.decide', plainAnswer.status === 200 && plainAnswer.body.data?.answered_by === s.mia
      && !('decided_via' in plainAnswer.body.data) && !('kind' in plainAnswer.body.data) && (await stored(plain.body.data.id)).decided_via === null, plainAnswer.body);
    const plainHook = (await hooks(plain.body.data.id)).find((e) => e.event_type === 'question.answered')?.payload.data.question;
    check('question: its webhook carries no decided_via', !!plainHook && !('decided_via' in plainHook), plainHook);
    const plain2 = await call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.builder, { project_id: s.apex, question: 'Which locale first?', asked_to: s.mia });
    const toolAnswer = await mcp({ bearer: s.keys.miaConnection }, 'answer_question', { question_id: plain2.body.data.id, text: 'German' });
    check('question: a connected AI tool still answers a plain question', toolAnswer?.ok === true && toolAnswer.data.answer_text === 'German', toolAnswer);

    // ── Answers that act say what they do (review of wave 3, finding 2) ──
    const words = await import('../src/lib/question-actions-text');
    const turnOn = { type: 'project.update', details: { project_id: s.apex, time_tracking_enabled: true }, on_choice: 'approve' };
    check('words: an approval that acts says what approving does, in the app\'s words',
      words.actionSentence(turnOn, { approval: true, projectName: 'Acme Site' }) === 'Approving turns time tracking on for Acme Site.');
    check('words: a question names the choice that acts', words.actionSentence({ ...turnOn, details: { project_id: s.apex, time_tracking_enabled: false }, on_choice: 'Yes' }, { approval: false, projectName: 'Acme Site' })
      === 'Choosing "Yes" turns time tracking off for Acme Site.');
    check('words: someone who cannot do it is told so, in plain words',
      words.actionCannotSentence(turnOn, { approval: true, projectName: 'Acme Site', reason: 'needs projects.manage' }) === 'You cannot turn time tracking on for Acme Site (you cannot manage projects), so approving is not open to you.');
    check('words: a chat message shows the sentence despite quotes, case and punctuation', words.showsSentence('OK! *Approving turns time tracking ON for Acme Site* - reply yes to go ahead', 'Approving turns time tracking on for Acme Site.')
      && !words.showsSentence('Shall I go ahead?', 'Approving turns time tracking on for Acme Site.'));
    const acting = await call(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.builder, {
      project_id: s.apex, asked_to: s.owner, action: { type: 'project.update', summary: 'Shall I continue?', details: { project_id: s.apex, time_tracking_enabled: true } },
    });
    const actingId = acting.body.data?.id as string;
    const ownerView = await getQuestion(await appCtx(s.owner), actingId);
    const sentence = ownerView.proposed_actions?.[0]?.sentence;
    check('acts: the approval carries the server\'s sentence, never the agent\'s summary', acting.status === 201 && sentence === 'Approving turns time tracking on for Apex.'
      && ownerView.proposed_actions?.[0]?.you_may_perform === true && !ownerView.proposed_actions?.[0]?.you_cannot, ownerView.proposed_actions);
    const miaView = await getQuestion(await appCtx(s.mia), actingId).catch(() => null);
    if (miaView) {
      check('acts: a reader who cannot do it is told so (you_may_perform false, you_cannot)', miaView.proposed_actions?.[0]?.you_may_perform === false
        && /^You cannot turn time tracking on/.test(miaView.proposed_actions?.[0]?.you_cannot ?? ''), miaView.proposed_actions);
    }
    // Over chat, the agent answering for the person must have shown them the sentence first.
    const unseen = await answer(s.keys.relayManage, actingId, { choice: 'approve' }, s.keys.relayForOwner);
    check('acts: an agent answering for a person who was never shown the sentence in chat is refused (409 action_not_shown), with the sentence to show',
      unseen.status === 409 && reason(unseen) === 'action_not_shown' && unseen.body.error?.details?.sentence === sentence && (await stored(actingId)).status === 'open', unseen.body);
    const connection = (await s.q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials) VALUES ('telegram', 'Bot', 'pm1:test-sealed') RETURNING id"))[0].id;
    await s.q(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, text, member_id, agent_id)
      VALUES ($1, 'outbound', 'sent', 'c1', $2, $3, $4)`, [connection, `Before I go on: ${sentence} Reply yes to approve.`, s.owner, s.relay]);
    const seen = await answer(s.keys.relayManage, actingId, { choice: 'approve' }, s.keys.relayForOwner);
    const apexNow = (await s.q<Loose>('SELECT time_tracking_enabled FROM pm.projects WHERE id = $1', [s.apex]))[0];
    check('acts: once the person was shown it in chat, the answer does the thing', seen.status === 200 && seen.body.data?.performed?.status === 'done' && apexNow.time_tracking_enabled === true, seen.body);

    // ── The database ────────────────────────────────────────────────────
    const onPlain =await db.query("UPDATE pm.questions SET decided_via = 'app' WHERE id = $1", [plain.body.data.id]).then(() => 'stored', (e: Error) => e.message);
    check('db: decided_via is refused on a plain question', onPlain !== 'stored', onPlain);
    const unknown = await db.query("UPDATE pm.questions SET decided_via = 'email' WHERE id = $1", [inApp]).then(() => 'stored', (e: Error) => e.message);
    check('db: an unknown decided_via is refused', unknown !== 'stored', unknown);

    // ── How the screens say it ──────────────────────────────────────────
    const line = (decided_via: Loose, name: string | null, yours = false, decision: Loose = 'approved', answer_text: string | null = null) =>
      decisionLine({ decision, decided_by_name: name, decided_via, answer_text }, yours);
    check('screen: "Approved by Mia in the app"', line('app', 'Mia') === 'Approved by Mia in the app', line('app', 'Mia'));
    check('screen: "Approved by Reviewer AI"', line('agent', 'Reviewer AI') === 'Approved by Reviewer AI', line('agent', 'Reviewer AI'));
    check('screen: an API key and an agent acting for someone say so', line('api_key', 'Mia', false, 'rejected') === 'Rejected by Mia with an API key'
      && line('act_for', 'Mia') === 'Approved by Mia through an agent', [line('api_key', 'Mia', false, 'rejected'), line('act_for', 'Mia')]);
    check('screen: yours in the app reads "You approved", with the note', line('app', 'Mia', true, 'approved', 'Go') === 'You approved: Go'
      && line(null, null) === 'Approved', [line('app', 'Mia', true, 'approved', 'Go'), line(null, null)]);
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`approval decisions: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
