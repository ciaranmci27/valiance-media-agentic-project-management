/**
 * PM MCP server end to end. The real /api/mcp route resolves real keys
 * (resolveApiKey with the real supabase-js client, against a pglite database
 * holding the access tables behind the PostgREST stand-in), in both protocol
 * eras and as Hermes's raw legacy posts. notify_owner runs the real v1
 * notifications route through withApi, so the audit row's via = mcp is
 * checked for real. Every other tool runs against a stand-in for its route
 * handler that records exactly what the tool sent, which is what the MCP
 * layer owns: argument checks, path/query/body mapping, fields filled from
 * the key, result mapping and size caps. The real routes stay covered by
 * the drift check (every tool's routes resolve to an exported handler).
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-mcp.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startFakePostgrest } from './fake-postgrest';
import { toolDefinition, type PmTool } from '../src/lib/mcp/core';
import { GUIDE_TOOL, PM_TOOLS } from '../src/lib/mcp/tools';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 700)}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payloads are checked field by field
type Payload = Record<string, any>;
type ToolResult = { isError?: boolean; structuredContent?: Payload; content?: { type: string; text?: string }[] };

const OWNER = randomUUID();
const AGENT = randomUUID();
const ADMIN = randomUUID();
const PROJECT = randomUUID();
const TASK = randomUUID();
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

async function seed(db: PGlite) {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO service_role;
    CREATE TABLE public.team_members (id uuid PRIMARY KEY, name text NOT NULL, role text NOT NULL, status text NOT NULL DEFAULT 'active',
      agent_profile text NOT NULL DEFAULT 'generic');
    CREATE TABLE public.api_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key_hash text NOT NULL, permissions text NOT NULL DEFAULT 'scoped',
      team_member_id uuid, scopes text[] NOT NULL DEFAULT '{}', expires_at timestamptz, disabled_at timestamptz, revoked_at timestamptz,
      last_used_at timestamptz);
    CREATE TABLE public.business_settings (id serial PRIMARY KEY, api_enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE public.role_permissions (role text, permission_key text, access_channel text);
    CREATE TABLE public.team_member_permissions (member_id uuid, permission_key text, access_channel text, effect text);
    CREATE TABLE public.project_members (member_id uuid, project_id uuid);
    CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text, message text, link text,
      entity_type text, entity_id text);
    CREATE TABLE public.api_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), method text, endpoint text, entity_type text,
      entity_id uuid, api_key_id uuid, team_member_id uuid, request_body jsonb, before_snapshot jsonb, after_snapshot jsonb,
      status_code integer, error text, via text NOT NULL DEFAULT 'rest');
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'reset_at', now() + make_interval(secs => p_window_seconds)) $$;
    CREATE FUNCTION public.upsert_notification(p_user_id uuid, p_title text, p_message text, p_link text, p_entity_type text, p_entity_id text)
      RETURNS void LANGUAGE sql AS $$ INSERT INTO public.notifications(user_id, title, message, link, entity_type, entity_id)
      VALUES (p_user_id, p_title, p_message, p_link, p_entity_type, p_entity_id) $$;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    INSERT INTO public.business_settings DEFAULT VALUES;
  `);
  await db.query(
    "INSERT INTO team_members(id,name,role,agent_profile) VALUES ($1,'Owner','owner','generic'),($2,'Jeff','agent','builder'),($3,'Ada','admin','generic')",
    [OWNER, AGENT, ADMIN],
  );
  const agentPermissions = ['tasks.read', 'tasks.manage_assigned', 'notifications.send', 'agent_activity.write', 'time.manage_own', 'projects.read', 'suggestions.create'];
  for (const key of agentPermissions)
    await db.query("INSERT INTO role_permissions VALUES ('agent',$1,'api')", [key]);
  for (const key of ['tasks.read', 'projects.read', 'agent_activity.write', 'suggestions.create', 'team.read'])
    await db.query("INSERT INTO role_permissions VALUES ('admin',$1,'api')", [key]);
  await db.query('INSERT INTO project_members VALUES ($1,$2),($3,$2)', [AGENT, PROJECT, ADMIN]);
}

async function main() {
  // The catalog, before anything runs.
  const names = PM_TOOLS.map((tool) => tool.name);
  check('catalog: names are unique', new Set(names).size === names.length);
  check('catalog: snake_case names short enough for mcp__pm__ and the 64-character cap', names.every((n) => /^[a-z][a-z0-9_]{0,55}$/.test(n)), names);
  check('catalog: the guide is first', names[0] === GUIDE_TOOL);
  for (const tool of PM_TOOLS) {
    const definition = toolDefinition(tool);
    const schema = definition.inputSchema as { type: string; properties?: Record<string, unknown>; additionalProperties?: boolean };
    check(`catalog: ${tool.name} lead is one sentence of 60 characters or fewer`, tool.lead.length <= 60 && tool.lead.endsWith('.') && !tool.lead.slice(0, -1).includes('. '), tool.lead);
    check(`schema: ${tool.name} has a closed object root`, schema.type === 'object' && schema.additionalProperties === false && !('$schema' in schema));
    check(`annotations: ${tool.name} read-only exactly when it writes nothing`, definition.annotations.readOnlyHint === !tool.write);
    // The acting member always comes from the key; only list_time_entries
    // takes a member_id, and only to read someone else's (time.read_all).
    check(`catalog: ${tool.name} never asks who is acting`, !['user_id', 'reviewer_member_id', 'created_by'].some((f) => f in (schema.properties ?? {})) && (!('member_id' in (schema.properties ?? {})) || tool.name === 'list_time_entries'));
  }
  check('catalog: no tool exposes notification audience', !('audience' in ((toolDefinition(PM_TOOLS.find((t) => t.name === 'notify_owner') as PmTool).inputSchema.properties as object) ?? {})));
  check('catalog: no tool offers free-text custom events', !JSON.stringify(toolDefinition(PM_TOOLS.find((t) => t.name === 'log_activity') as PmTool).inputSchema).includes('"custom"'));
  check('catalog: telemetry events stay with the host publishers', !JSON.stringify(toolDefinition(PM_TOOLS.find((t) => t.name === 'log_activity') as PmTool).inputSchema).includes('usage.recorded'));
  check('catalog: the inbound email inbox is not exposed over MCP', PM_TOOLS.every((tool) => tool.routes.every((route) => !route.path.includes('inbound-email'))));
  check('catalog: server-composed events are not loggable', !JSON.stringify(toolDefinition(PM_TOOLS.find((t) => t.name === 'log_activity') as PmTool).inputSchema).includes('email.triaged'));

  const db = new PGlite();
  await seed(db);
  const keys = { owner: `pk_live_${randomUUID()}`, agent: `pk_live_${randomUUID()}`, readOnly: `pk_live_${randomUUID()}`, admin: `pk_live_${randomUUID()}` };
  const agentScopes = ['tasks.read', 'tasks.manage_assigned', 'notifications.send', 'agent_activity.write', 'time.manage_own', 'projects.read', 'suggestions.create'];
  await db.query("INSERT INTO api_keys(key_hash,team_member_id,scopes) VALUES ($1,$2,$3)", [hash(keys.owner), OWNER, ['tasks.read', 'tasks.manage_all', 'tasks.create', 'projects.read', 'leads.read', 'team.read', 'notifications.send', 'audit.read']]);
  await db.query("INSERT INTO api_keys(key_hash,team_member_id,scopes) VALUES ($1,$2,$3)", [hash(keys.agent), AGENT, agentScopes]);
  await db.query("INSERT INTO api_keys(key_hash,team_member_id,scopes,permissions) VALUES ($1,$2,$3,'read_only')", [hash(keys.readOnly), AGENT, agentScopes]);
  await db.query("INSERT INTO api_keys(key_hash,team_member_id,scopes) VALUES ($1,$2,$3)", [hash(keys.admin), ADMIN, ['tasks.read', 'projects.read', 'agent_activity.write', 'suggestions.create', 'team.read']]);
  const server = await startFakePostgrest(db);
  process.env.NEXT_PUBLIC_SUPABASE_URL = server.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
  process.env.NEXT_PUBLIC_ENABLE_AGENTS = 'true';

  try {
    const { ROUTE_MODULES, routeHandler } = await import('../src/lib/mcp/handlers');
    const { outcomeResult } = await import('../src/lib/mcp/server');
    const mcpRoute = await import('../src/app/api/mcp/route');

    for (const tool of PM_TOOLS)
      for (const route of tool.routes)
        check(`drift: ${tool.name} calls ${route.method} ${route.path}, which exists`, !!routeHandler(route.path, route.method));

    // Stand-ins record what each tool sends; the real notifications route stays.
    type Captured = { method: string; url: URL; headers: Headers; params: Record<string, string>; body: unknown };
    const captured: Captured[] = [];
    let respond: (c: Captured) => { status: number; body: unknown } = () => ({ status: 200, body: { success: true, data: { ok: 'stand-in' } } });
    const realNotifications = ROUTE_MODULES['/api/v1/notifications'];
    const standIn = async (request: NextRequest, context: { params: Promise<Record<string, string>> }) => {
      const text = await request.text();
      const entry: Captured = { method: request.method, url: new URL(request.url), headers: request.headers, params: await context.params, body: text ? JSON.parse(text) : undefined };
      captured.push(entry);
      const { status, body } = respond(entry);
      return Response.json(body, { status });
    };
    for (const path of Object.keys(ROUTE_MODULES))
      ROUTE_MODULES[path] = path === '/api/v1/notifications'
        ? { ...realNotifications, GET: standIn }
        : { GET: standIn, POST: standIn, PATCH: standIn, PUT: standIn, DELETE: standIn };

    const post = (body: unknown, headers: Record<string, string> = {}) =>
      mcpRoute.POST(new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      }));
    const rpc = async (response: Response): Promise<Payload> => {
      const text = await response.text();
      return JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text) as Payload;
    };
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes', version: '2026.7.20' } } };

    // The door.
    check('http: GET is 405', (await mcpRoute.GET()).status === 405);
    const noKey = await post(initialize);
    check('http: no key is 401 missing_api_key', noKey.status === 401 && (await rpc(noKey)).error?.data?.reason === 'missing_api_key');
    const bogus = await post(initialize, { 'x-api-key': 'pk_live_nope' });
    check('http: an unknown key is 401', bogus.status === 401 && (await rpc(bogus)).error?.data?.reason === 'invalid_api_key');
    check('http: a foreign Origin is 403', (await post(initialize, { 'x-api-key': keys.agent, origin: 'https://evil.example' })).status === 403);
    check('http: Authorization: Bearer works', (await post(initialize, { authorization: `Bearer ${keys.agent}` })).status === 200);
    const hello = await post(initialize, { 'x-api-key': keys.agent });
    const helloBody = await rpc(hello);
    check('legacy: initialize answers with tools', hello.status === 200 && helloBody.result?.serverInfo?.name === 'valiance-pm' && !!helloBody.result?.capabilities?.tools, helloBody);
    const legacyHeaders = { 'x-api-key': keys.agent, 'mcp-protocol-version': String(helloBody.result?.protocolVersion) };
    check('legacy: initialized notification is accepted', (await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, legacyHeaders)).status === 202);
    const rawList = await rpc(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, legacyHeaders));
    check('legacy: tools/list without a session', Array.isArray(rawList.result?.tools) && rawList.result.tools.length > 5, rawList);

    const connect = async (key: string, era: 'legacy' | 'modern') => {
      const client = new Client({ name: 'verify-mcp', version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
      await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
        requestInit: { headers: { 'x-api-key': key } },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new NextRequest(input instanceof Request ? input : String(input), init as ConstructorParameters<typeof NextRequest>[1]);
          if (request.method === 'POST') return mcpRoute.POST(request);
          return request.method === 'DELETE' ? mcpRoute.DELETE() : mcpRoute.GET();
        },
      }));
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as ToolResult;
    const listNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

    const agent = await connect(keys.agent, 'legacy');
    const agentModern = await connect(keys.agent, 'modern');
    const readOnly = await connect(keys.readOnly, 'legacy');
    const admin = await connect(keys.admin, 'legacy');
    const owner = await connect(keys.owner, 'modern');
    try {
      // Which tools each key sees.
      const agentTools = await listNames(agent);
      check('per key: both eras list the same tools', JSON.stringify(agentTools) === JSON.stringify(await listNames(agentModern)));
      check('per key: the agent sees its granted tools', ['get_task', 'update_task', 'add_task_comment', 'timer', 'notify_owner', 'log_activity', 'create_task_suggestion', 'list_projects'].every((n) => agentTools.includes(n)), agentTools);
      check('per key: nothing outside its scopes', !['submit_task_review', 'list_leads', 'list_team', 'create_task', 'list_agent_activity', 'add_project_context'].some((n) => agentTools.includes(n)), agentTools);
      const readOnlyTools = await listNames(readOnly);
      check('per key: a read-only key sees no write tools', readOnlyTools.length > 2 && !readOnlyTools.some((n) => PM_TOOLS.find((t) => t.name === n)?.write), readOnlyTools);
      const adminTools = await listNames(admin);
      check('per key: agent-only tools are hidden from people', !adminTools.includes('log_activity') && !adminTools.includes('create_task_suggestion') && adminTools.includes('list_team'), adminTools);
      const ownerTools = await listNames(owner);
      check('per key: tasks.manage_all opens reviews and implies task writes', ownerTools.includes('submit_task_review') && ownerTools.includes('update_task') && ownerTools.includes('create_task'), ownerTools);

      await db.query("INSERT INTO team_member_permissions VALUES ($1,'notifications.send','api','deny')", [AGENT]);
      check('per key: a member permission taken away hides the tool', !(await listNames(agent)).includes('notify_owner'));
      await db.query("DELETE FROM team_member_permissions WHERE member_id=$1", [AGENT]);

      const guide = await call(agent, GUIDE_TOOL);
      check('guide: conventions, who you are, your tools', /dependencies_met/.test(guide.structuredContent?.guide) && guide.structuredContent?.you?.profile === 'builder' && guide.structuredContent?.tools?.length === agentTools.length - 1, guide.structuredContent?.you);

      // What reaches the routes.
      const last = () => captured[captured.length - 1];
      captured.length = 0;
      respond = () => ({ status: 200, body: { success: true, data: [{ id: TASK, title: 'T', description: 'x'.repeat(900), comments: [{}, {}, {}], subtasks: [{ completed: true }, { completed: false }], acceptance_criteria: [{ satisfied: true }] }], meta: { page: 1, limit: 20, total: 1, total_pages: 1 } } });
      const found = await call(agent, 'search_tasks', { project_id: PROJECT, status: 'in_progress' });
      check('map: search_tasks sends a GET with the filters and default limit', last()?.method === 'GET' && last()?.url.pathname === '/api/v1/tasks' && last()?.url.searchParams.get('status') === 'in_progress' && last()?.url.searchParams.get('project_id') === PROJECT && last()?.url.searchParams.get('limit') === '20', last()?.url.search);
      check('map: the key travels with every call, and no via header (the label is set in process)', last()?.headers.get('x-api-key') === keys.agent && last()?.headers.get('x-api-via') === null);
      const row = found.structuredContent?.data?.[0];
      check('present: task lists are summaries with counts', row?.comment_count === 3 && row?.subtasks?.done === 1 && row?.subtasks?.total === 2 && !('comments' in row) && row?.description.length < 400, row);
      check('present: list meta passes through', found.structuredContent?.meta?.total === 1);

      const comments = Array.from({ length: 15 }, (_, i) => ({ id: randomUUID(), text: `${i}:${'c'.repeat(3000)}` }));
      respond = () => ({ status: 200, body: { success: true, data: { id: TASK, title: 'Big', description: 'd'.repeat(60_000), comments, latest_review: { verdict: 'approved', summary: 's'.repeat(9000) } } } });
      const bigTask = await call(agent, 'get_task', { task_id: TASK });
      const shown = bigTask.structuredContent?.data;
      check('present: a huge task still reads, cut and flagged', bigTask.structuredContent?.ok === true && shown?.description_truncated === true && shown?.description.length <= 15_001 && shown?.latest_review?.summary.length <= 3001, bigTask.structuredContent?.error ?? Object.keys(shown ?? {}));
      check('present: get_task shows the newest 10 comments and says how many there are', shown?.comments?.length === 10 && shown?.comment_count === 15 && shown?.comments?.[9]?.text.startsWith('14:') && /list_task_comments/.test(shown?.comments_note), shown?.comments_note);
      respond = () => ({ status: 200, body: { success: true, data: [], meta: { page: 2, limit: 5, total: 15, total_pages: 3 } } });
      await call(agent, 'list_task_comments', { task_id: TASK, page: 2, limit: 5 });
      check('map: list_task_comments pages the comments route', last()?.url.pathname === `/api/v1/tasks/${TASK}/comments` && last()?.url.searchParams.get('page') === '2' && last()?.url.searchParams.get('limit') === '5');

      respond = () => ({ status: 201, body: { success: true, data: { id: randomUUID() } } });
      await call(agent, 'add_task_comment', { task_id: TASK, text: 'Done with the migration.' });
      check('map: comments are posted as the key member', last()?.url.pathname === `/api/v1/tasks/${TASK}/comments` && (last()?.body as Payload)?.user_id === AGENT && (last()?.body as Payload)?.text === 'Done with the migration.', last()?.body);
      await call(agent, 'timer', { action: 'start', project_id: PROJECT, description: 'Spec', task_ids: [TASK] });
      check('map: timer start posts for the key member', last()?.url.pathname === `/api/v1/projects/${PROJECT}/time-entries` && (last()?.body as Payload)?.member_id === AGENT && !('action' in (last()?.body as Payload)), last()?.body);
      const entry = randomUUID();
      await call(agent, 'timer', { action: 'pause', project_id: PROJECT, entry_id: entry });
      check('map: timer pause hits the pause route with no body', last()?.url.pathname === `/api/v1/projects/${PROJECT}/time-entries/${entry}/pause` && last()?.body === undefined && last()?.params.entryId === entry, last()?.url.pathname);
      respond = () => ({ status: 200, body: { success: true, data: { id: entry, end_time: '2026-10-02T10:00:00Z' } } });
      const resumed = await call(agent, 'timer', { action: 'resume', project_id: PROJECT, entry_id: entry });
      check('present: a resume that closed the entry says finalized', resumed.structuredContent?.data?.finalized === true);
      const before = captured.length;
      const noEntry = await call(agent, 'timer', { action: 'stop', project_id: PROJECT });
      check('args: timer stop without entry_id is refused before any route', noEntry.isError !== true && noEntry.structuredContent?.status === 422 && captured.length === before, noEntry.structuredContent);
      const loneStart = await call(agent, 'timer', { action: 'start', project_id: PROJECT, start_time: '2026-10-02T09:00:00Z' });
      check('args: a start_time on start is refused (it would silently start a live timer)', loneStart.structuredContent?.status === 422 && captured.length === before);
      const badEnum = await call(agent, 'search_tasks', { status: 'blocked' });
      check('args: an enum the database would 500 on is a 422', badEnum.structuredContent?.status === 422 && badEnum.isError !== true && captured.length === before);
      const extra = await call(agent, 'get_task', { task_id: TASK, include: 'everything' });
      check('args: unknown arguments are refused', extra.structuredContent?.status === 422 && /include/.test(JSON.stringify(extra.structuredContent?.error?.issues)));
      const emptyUpdate = await call(agent, 'update_task', { task_id: TASK });
      check('args: an update with nothing to change is refused', emptyUpdate.structuredContent?.status === 422);

      respond = () => ({ status: 201, body: { success: true, data: { id: randomUUID() } } });
      await call(owner, 'submit_task_review', { task_id: TASK, verdict: 'approved', summary: 'Good', pr_url: 'https://github.com/o/r/pull/1', head_sha: 'a'.repeat(40) });
      check('map: review body is the verdict, summary, PR and SHA', JSON.stringify(Object.keys(last()?.body as object).sort()) === JSON.stringify(['head_sha', 'pr_url', 'summary', 'verdict']));
      respond = () => ({ status: 201, body: { success: true, data: { id: randomUUID(), verdict: 'changes_requested', summary: 'Needs work' } } });
      const repeat = await call(owner, 'submit_task_review', { task_id: TASK, verdict: 'approved', summary: 'Good', pr_url: 'https://github.com/o/r/pull/1', head_sha: 'a'.repeat(40) });
      check('present: a repeat review of the same commit says already_reviewed', repeat.structuredContent?.data?.already_reviewed === true);
      respond = () => ({ status: 201, body: { success: true, data: { id: randomUUID(), verdict: 'approved', summary: 'Earlier words' } } });
      const sameVerdict = await call(owner, 'submit_task_review', { task_id: TASK, verdict: 'approved', summary: 'Good', pr_url: 'https://github.com/o/r/pull/1', head_sha: 'a'.repeat(40) });
      check('present: a repeat with the same verdict but other words is flagged too', sameVerdict.structuredContent?.data?.already_reviewed === true);

      respond = () => ({ status: 201, body: { success: true, data: { id: randomUUID() } } });
      const event = await call(agent, 'log_activity', { activity_type: 'work.claimed', payload: { task_id: TASK, task_title: 'Ship MCP' }, project_id: PROJECT });
      check('map: typed events pass through', event.structuredContent?.ok === true && (last()?.body as Payload)?.activity_type === 'work.claimed');
      const badPayload = await call(agent, 'log_activity', { activity_type: 'work.claimed', payload: { task_id: TASK } });
      check('args: an event payload is checked against the vocabulary', badPayload.structuredContent?.status === 422 && /payload/.test(JSON.stringify(badPayload.structuredContent?.error?.issues)));
      const custom = await call(agent, 'log_activity', { activity_type: 'custom', payload: {} });
      check('args: custom events are refused', custom.structuredContent?.status === 422);

      // Error mapping: fixable refusals are results, key and server faults are errors.
      const statusOf = async (status: number, details: unknown) => {
        respond = () => ({ status, body: { success: false, error: { code: 'X', message: 'm', details } } });
        return call(agent, 'get_task', { task_id: TASK });
      };
      const scope = await statusOf(403, { reason: 'project_scope' });
      check('errors: a task outside your reach is ok:false, not isError', scope.isError !== true && scope.structuredContent?.status === 403 && scope.structuredContent?.error?.reason === 'project_scope');
      const keyScope = await statusOf(403, { reason: 'missing_key_scope' });
      check('errors: a key without the scope is isError', keyScope.isError === true);
      const notFound = await statusOf(404, undefined);
      check('errors: 404 is ok:false', notFound.isError !== true && notFound.structuredContent?.status === 404);
      const zod = await statusOf(422, [{ path: ['title'], message: 'Required' }]);
      check('errors: route validation issues come through', zod.isError !== true && Array.isArray(zod.structuredContent?.error?.issues));
      const crash = await statusOf(500, { request_id: 'r' });
      check('errors: a server error is isError', crash.isError === true);
      const limited = await statusOf(429, undefined);
      check('errors: the rate limit is isError', limited.isError === true);

      const big = outcomeResult({ kind: 'route', result: { status: 200, envelope: { success: true, data: 'x'.repeat(50_000) } } }, false);
      check('size: a read over the cap is ok:false result_too_large', big.isError !== true && (big.structuredContent as Payload)?.error?.reason === 'result_too_large');
      const bigWrite = outcomeResult({ kind: 'route', result: { status: 200, envelope: { success: true, data: 'x'.repeat(50_000) } } }, true);
      check('size: a write always reports what happened', (bigWrite.structuredContent as Payload)?.ok === true);

      // The real route, end to end: withApi, the audit row, via = mcp.
      const notified = await call(agent, 'notify_owner', { title: 'Question', message: 'Which branch?', entity_type: 'task', entity_id: TASK });
      check('real route: notify_owner reaches the owner', notified.structuredContent?.ok === true && notified.structuredContent?.data?.notified === 1, notified.structuredContent);
      const inbox = await db.query<{ user_id: string }>('SELECT user_id FROM notifications');
      check('real route: only the owner was notified', inbox.rows.length === 1 && inbox.rows[0].user_id === OWNER, inbox.rows);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const audit = await db.query<{ via: string; team_member_id: string }>("SELECT via, team_member_id FROM api_audit_log WHERE endpoint='/api/v1/notifications'");
      check('real route: the audit row says via mcp, under the agent', audit.rows.length === 1 && audit.rows[0].via === 'mcp' && audit.rows[0].team_member_id === AGENT, audit.rows);
      const used = await db.query<{ last_used_at: string | null }>('SELECT last_used_at FROM api_keys WHERE key_hash=$1', [hash(keys.agent)]);
      check('real route: last_used_at still recorded', !!used.rows[0]?.last_used_at);
      const restPost = realNotifications.POST as (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
      const restCall = await restPost(new NextRequest('http://localhost/api/v1/notifications', {
        method: 'POST',
        headers: { 'x-api-key': keys.agent, 'content-type': 'application/json', 'x-api-via': 'mcp' },
        body: JSON.stringify({ title: 'REST', message: 'Plain REST call' }),
      }), { params: Promise.resolve({}) });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const restAudit = await db.query<{ via: string }>("SELECT via FROM api_audit_log WHERE request_body->>'title'='REST'");
      check('real route: a REST call is logged via rest, even when it claims mcp in a header', restCall.status === 201 && restAudit.rows[0]?.via === 'rest', restAudit.rows);

      // A key that stops working is refused at the door.
      await db.query("UPDATE team_members SET status='suspended' WHERE id=$1", [AGENT]);
      const suspended = await post({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, legacyHeaders);
      check('door: a suspended member is 403', suspended.status === 403, suspended.status);
      await db.query("UPDATE team_members SET status='active' WHERE id=$1", [AGENT]);
      await db.query('UPDATE business_settings SET api_enabled=false');
      check('door: the workspace API switch closes MCP too', (await post({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, legacyHeaders)).status === 403);
      await db.query('UPDATE business_settings SET api_enabled=true');
    } finally {
      await Promise.allSettled([agent.close(), agentModern.close(), readOnly.close(), admin.close(), owner.close()]);
    }
  } finally {
    await server.close();
    await db.close();
  }
  if (failures.length) {
    console.error(`PM MCP server: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`PM MCP server: ${passed} checks passed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
