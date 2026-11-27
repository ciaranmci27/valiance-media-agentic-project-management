/**
 * The app teaching agents about themselves, and agent setups that repeat,
 * over the real v1 routes (withApi, supabase-js, a fake PostgREST over
 * PGlite with the full schema, a stand-in for Supabase Auth's admin API):
 * - Context pack: generated from the agent's real rules, key scopes,
 *   projects, tools and webhooks, changing when they change; the workspace
 *   brand and member names come from the database; bounded; as JSON, an
 *   AGENTS.md (format=md) or a SKILL.md, never cached.
 * - pm_guide over the real MCP route keeps its contract (guide, you, tools)
 *   and adds the caller's own pack as context.
 * - Templates: each core template applies; a key that could not grant a
 *   template's scopes cannot apply it, Owner or not; a key is made only as
 *   POST /api/v1/api-keys would; the install's templates join core's
 *   (src/custom/agent-templates.ts) and a clash stops the build.
 * - Export then import into a fresh agent round trips; no secret or hash
 *   in the export or the audit log; dry run writes nothing; unmatched
 *   projects, members, templates and webhook filters are reported; keys
 *   and endpoints are made only when asked, with their secrets once.
 *
 *   npm run -s test:agent-context
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { ExtensionError } from '../src/lib/extensions/registry';
import { defineAgentTemplates, mergeAgentTemplates, type AgentTemplate } from '../src/lib/extensions/agent-templates';
import { AGENT_TEMPLATES, CORE_AGENT_TEMPLATES, listAgentTemplates } from '../src/lib/agent-templates';
import customTemplates from '../src/custom/agent-templates';
import type { AccessContext } from '../src/lib/access-control';
import { MODULE_IDS } from '../src/lib/modules/registry';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; text: string; headers: Headers };

const OWNER_SCOPES = ['team.manage', 'project_members.manage', 'api_keys.manage_all', 'webhooks.manage', 'tasks.read', 'tasks.create',
  'tasks.manage_assigned', 'projects.read', 'project_context.read', 'notifications.send', 'agent_activity.write', 'files.read',
  'time.manage_own', 'goals.read', 'inbound_email.read', 'inbound_email.triage', 'reminders.manage_own', 'notifications.manage_own',
  // The External agent template's (20261125001400_external_agents.sql).
  'questions.ask',
  // The Orchestrator template's: it sees its team.
  'team.read'];
const AGENT_KEY_SCOPES = ['tasks.read', 'tasks.manage_assigned', 'tasks.create', 'projects.read', 'agent_activity.write'];

/** Supabase Auth's admin API, as much of it as creating a login needs. */
function authStandIn(db: PGlite) {
  const emails = new Set<string>();
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
      return true;
    };
    if (url.pathname !== '/auth/v1/admin/users' || request.method !== 'POST') return false;
    const text = await new Promise<string>((resolve) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => resolve(raw));
    });
    const body = JSON.parse(text || '{}');
    const email = String(body.email).toLowerCase();
    if (emails.has(email)) return json(422, { code: 'email_exists', message: 'A user with this email address has already been registered' });
    emails.add(email);
    const id = randomUUID();
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [id, email]);
    return json(200, { id, aud: 'authenticated', role: 'authenticated', email, user_metadata: body.user_metadata ?? {}, app_metadata: {}, created_at: '2026-11-24T00:00:00Z' });
  };
}

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  // The install's own name: the pack must say it, never a name from code.
  await q("UPDATE pm.workspace_brand SET name = 'Northwind Ops'");
  // builder left core for a row (the update makes one where a member used it): this install has it.
  await q("INSERT INTO pm.mcp_profile_rows (value, label, description) VALUES ('builder', 'Builder', 'Works assigned tasks, tracks time and raises blockers')");
  const member = async (name: string, role: string) =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const ada = await member('Ada', 'admin');
  const morgan = await member('Morgan', 'member');
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>("INSERT INTO pm.projects (name, created_at) VALUES ($1, now() - interval '1 day') RETURNING id", [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const apex = await project('Apex', [ada]);
  const queue = await project('Queue', []);
  for (const permission of ['team.manage', 'team.read', 'api_keys.manage_all', 'project_members.manage', 'webhooks.manage']) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'api', 'allow')", [ada, permission]);
  }
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.read_all', 'api', 'deny')", [ada]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, OWNER_SCOPES),
    ownerNarrow: await key(owner, ['team.manage', 'api_keys.manage_all', 'tasks.read']),
    ada: await key(ada, ['team.manage', 'team.read', 'api_keys.manage_all', 'project_members.manage', 'tasks.read', 'projects.read']),
    // Ada reading an agent's setup with webhooks.manage but no api_keys.manage_all.
    adaHooks: await key(ada, ['team.read', 'webhooks.manage', 'projects.read']),
    // Ada, and the scopes an agent with no team or webhook permission holds.
    adaRead: await key(ada, ['team.read', 'projects.read']),
    // Ada, hiring an External agent: the template's scopes on her own key.
    adaExternal: await key(ada, ['team.manage', 'team.read', 'agent_activity.write', 'questions.ask']),
  };
  return { q, owner, ada, morgan, apex, queue, keys };
}

function access(modules = [...MODULE_IDS]): AccessContext {
  return { member_id: randomUUID(), role: 'owner', status: 'active', app_permissions: ['*'], api_permissions: ['*'], project_ids: [], modules };
}

const thrown = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof ExtensionError ? error.message : `not an ExtensionError: ${String(error)}`;
  }
};

function templateChecks() {
  const sample: AgentTemplate = {
    key: 'release-notes', label: 'Release notes', description: 'Writes release notes.',
    rules: { agent_self_assign: false, agent_close_policy: 'review', agent_create_policy: 'approval' },
    scopes: ['tasks.read', 'projects.read'], context: 'Each Friday, draft release notes.',
  };
  check('templates: core ships the seven generic ones', JSON.stringify(CORE_AGENT_TEMPLATES.map((t) => t.key)) === JSON.stringify(['orchestrator', 'data-health-watcher', 'inbox-triage', 'builder', 'weekly-reporter', 'personal-assistant', 'external-agent']));
  check("templates: the install's file loads and is a list of templates", Array.isArray(customTemplates));
  check("templates: the registry is core's, then the install's", JSON.stringify(AGENT_TEMPLATES.map((t) => t.key)) === JSON.stringify([...CORE_AGENT_TEMPLATES, ...customTemplates].map((t) => t.key)));
  const merged = mergeAgentTemplates(CORE_AGENT_TEMPLATES, [sample, { ...sample, key: 'inbox-helper', module: 'inbox' }]);
  check("templates: an install's templates come after core's", merged.length === CORE_AGENT_TEMPLATES.length + 2 && merged[CORE_AGENT_TEMPLATES.length].key === 'release-notes');
  check("templates: a module's templates hide while it is off", !listAgentTemplates(access(MODULE_IDS.filter((m) => m !== 'inbox')), merged).some((t) => t.key === 'inbox-helper' || t.key === 'inbox-triage')
    && listAgentTemplates(access(), merged).some((t) => t.key === 'inbox-helper'));
  check("templates: an install's key that repeats core's stops the build, naming it", /"builder" is core's/.test(thrown(() => mergeAgentTemplates(CORE_AGENT_TEMPLATES, [{ ...sample, key: 'builder' }])) ?? ''));
  check('templates: two with one key stop the build', /two agent templates use the key "release-notes"/.test(thrown(() => defineAgentTemplates([sample, sample])) ?? ''));
  check('templates: an app-only permission is not a scope', /"access.manage" is not an API scope/.test(thrown(() => defineAgentTemplates([{ ...sample, scopes: ['access.manage'] as never }])) ?? ''));
  check('templates: keys are lowercase with dashes', /must be lowercase/.test(thrown(() => defineAgentTemplates([{ ...sample, key: 'Release Notes' }])) ?? ''));
  check('templates: rules are checked', /rules need/.test(thrown(() => defineAgentTemplates([{ ...sample, rules: { ...sample.rules, agent_close_policy: 'ship' as never } }])) ?? ''));
  check('templates: unknown events and modules are refused', /unknown webhook event/.test(thrown(() => defineAgentTemplates([{ ...sample, webhook_events: ['task.exploded' as never] }])) ?? '')
    && /unknown module/.test(thrown(() => defineAgentTemplates([{ ...sample, module: 'rockets' as never }])) ?? ''));
  check('templates: the brief is bounded', /over 2000 characters/.test(thrown(() => defineAgentTemplates([{ ...sample, context: 'x'.repeat(2001) }])) ?? ''));
}

async function main() {
  templateChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn(db) });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', APP_ENCRYPTION_KEY: 'e'.repeat(64), NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const agentsRoute = await import('../src/app/api/v1/agents/route');
    const projectsRoute = await import('../src/app/api/v1/agents/[id]/projects/route');
    const keysRoute = await import('../src/app/api/v1/api-keys/route');
    const hooksRoute = await import('../src/app/api/v1/webhook-endpoints/route');
    const memberRoute = await import('../src/app/api/v1/team-members/[id]/route');
    const myContextRoute = await import('../src/app/api/v1/agents/me/context/route');
    const contextRoute = await import('../src/app/api/v1/agents/[id]/context/route');
    const exportRoute = await import('../src/app/api/v1/agents/[id]/export/route');
    const importRoute = await import('../src/app/api/v1/agents/import/route');
    const templateRoute = await import('../src/app/api/v1/agents/[id]/template/route');
    const templatesRoute = await import('../src/app/api/v1/agent-templates/route');
    const mcpRoute = await import('../src/app/api/mcp/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller, toolsFor } = await import('../src/lib/mcp/server');
    const { PM_GUIDE, SETUP_TOOLS } = await import('../src/lib/mcp/guide');
    const { resolveApiKey } = await import('../src/lib/api/middleware');
    const { PACK_LIMITS } = await import('../src/lib/api/agent-context');

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>,
      method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      const text = await response.text();
      let parsed: Loose = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      return { status: response.status, body: parsed, text, headers: response.headers };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
    const myContext = (apiKey: string, query = '') => call(myContextRoute.GET, 'GET', `/api/v1/agents/me/context${query}`, {}, apiKey);
    const contextOf = (apiKey: string, id: string, query = '') => call(contextRoute.GET, 'GET', `/api/v1/agents/${id}/context${query}`, { id }, apiKey);
    const exportOf = (apiKey: string, id: string) => call(exportRoute.GET, 'GET', `/api/v1/agents/${id}/export`, { id }, apiKey);
    const importDoc = (apiKey: string, body: unknown, headers?: Record<string, string>) => call(importRoute.POST, 'POST', '/api/v1/agents/import', {}, apiKey, body, headers);
    const applyTemplate = (apiKey: string, id: string, body: unknown, headers?: Record<string, string>) =>
      call(templateRoute.POST, 'POST', `/api/v1/agents/${id}/template`, { id }, apiKey, body, headers);
    const newAgent = async (name: string, profile = 'builder') => {
      const made = await call(agentsRoute.POST, 'POST', '/api/v1/agents', {}, s.keys.owner, { name, email: `${name.toLowerCase()}@agents.example.com`, title: 'Builder', agent_profile: profile });
      if (made.status !== 201) throw new Error(`could not add ${name}: ${made.text}`);
      return made.body.data.id as string;
    };
    const counts = async () => (await s.q(`SELECT
      (SELECT count(*)::int FROM pm.team_members) AS members, (SELECT count(*)::int FROM pm.api_keys) AS keys,
      (SELECT count(*)::int FROM pm.webhook_endpoints) AS hooks, (SELECT count(*)::int FROM pm.project_members) AS memberships,
      (SELECT count(*)::int FROM pm.api_audit_log) AS audit`))[0];

    // --- An agent, set up through the S5a routes ----------------------------------------------
    const agent = await newAgent('Scout');
    await call(projectsRoute.PATCH, 'PATCH', `/api/v1/agents/${agent}/projects`, { id: agent }, s.keys.owner, { add: [s.apex, s.queue] });
    await call(memberRoute.PATCH, 'PATCH', `/api/v1/team-members/${agent}`, { id: agent }, s.keys.owner, { agent_close_policy: 'review', agent_self_assign: false, agent_escalate_to: s.morgan });
    const minted = await call(keysRoute.POST, 'POST', '/api/v1/api-keys', {}, s.keys.owner, { member_id: agent, name: 'Scout harness', scopes: AGENT_KEY_SCOPES });
    const agentSecret = minted.body.data.secret as string;
    const hook = await call(hooksRoute.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner, {
      name: 'Scout wake', url: 'https://hooks.example.com/scout/wake', events: ['task.created', 'comment.created'], project_ids: [s.apex, s.queue], member_id: agent,
    });
    const hookSecret = hook.body.data.secret as string;
    check('setup: the agent, its key and its webhook exist', !!agentSecret && !!hookSecret, [minted.body, hook.body]);

    // --- The pack, as the agent's own key reads it ---------------------------------------------
    const mine = await myContext(agentSecret);
    const pack = mine.body?.data?.pack ?? {};
    check('pack: answers { pack, markdown }, never cached', mine.status === 200 && typeof mine.body?.data?.markdown === 'string' && mine.headers.get('cache-control') === 'no-store', mine.body);
    check('pack: the workspace brand and the member, from the database', pack.workspace === 'Northwind Ops' && pack.member?.name === 'Scout' && pack.member?.title === 'Builder'
      && pack.member?.is_agent === true && pack.member?.profile === 'builder', pack.member);
    check('pack: the key it was read with', pack.key?.source === 'this_key' && pack.key?.name === 'Scout harness' && pack.key?.read_only === false, pack.key);
    check("pack: the key's scopes, each in plain words", JSON.stringify(pack.scopes?.map((x: Loose) => x.scope).sort()) === JSON.stringify([...AGENT_KEY_SCOPES].sort())
      && pack.scopes?.every((x: Loose) => x.label && x.label !== x.scope), pack.scopes);
    check('pack: its real rules, in plain words', pack.rules?.self_assign === false && pack.rules?.close_policy === 'review' && pack.rules?.create_policy === 'live'
      && pack.rules?.escalate_to?.id === s.morgan && pack.rules?.escalate_to?.name === 'Morgan'
      && pack.rules?.says?.some((line: string) => /In Review/.test(line)) && pack.rules?.says?.some((line: string) => /Morgan/.test(line)), pack.rules);
    check('pack: the projects it reaches, by name', pack.projects?.access === 'member' && JSON.stringify(pack.projects?.list?.map((p: Loose) => p.name)) === JSON.stringify(['Apex', 'Queue']), pack.projects);
    const resolved = await resolveApiKey(agentSecret);
    // The builder row lists no tools, so it sees what generic sees.
    const expectedTools = toolsFor({ access: resolved.access, scopes: AGENT_KEY_SCOPES, readOnly: false, profile: 'generic' }).map((t) => t.name);
    check('pack: exactly the MCP tools this key sees', JSON.stringify(pack.tools?.map((t: Loose) => t.name)) === JSON.stringify(expectedTools) && pack.tools?.every((t: Loose) => t.lead), pack.tools?.map((t: Loose) => t.name));
    const conventions = (pack.conventions ?? []).join('\n');
    check('pack: the house conventions for the tools it can use', /get_task_brief/.test(conventions) && /claim_task/.test(conventions) && /dedupe_key/.test(conventions)
      && /idempotency_key/.test(conventions) && /heartbeat/.test(conventions), pack.conventions);
    check('pack: a convention for a tool it cannot see is left out', !expectedTools.includes('ask_human') ? !/ask_human on the task/.test(conventions) : true);
    check('pack: no host publisher, so it is told to beat', pack.health?.publisher_reports === false && /every 60 seconds/.test(conventions), pack.health);
    check('pack: its webhook, the host only for a key without webhooks.manage', pack.webhooks?.length === 1 && pack.webhooks[0].url === 'https://hooks.example.com'
      && JSON.stringify(pack.webhooks[0].events) === JSON.stringify(['task.created', 'comment.created']) && pack.webhooks[0].projects?.[0]?.name === 'Apex', pack.webhooks);
    check('pack: no secret anywhere', !mine.text.includes(agentSecret) && !mine.text.includes(hookSecret) && !mine.text.includes('key_hash') && !mine.text.includes('whsec_'));
    check('pack: bounded', JSON.stringify(pack).length < PACK_LIMITS.total, JSON.stringify(pack).length);

    await s.q("INSERT INTO pm.agent_health (member_id, container, container_running, reported_at) VALUES ($1, 'scout-1', true, now())", [agent]);
    await call(memberRoute.PATCH, 'PATCH', `/api/v1/team-members/${agent}`, { id: agent }, s.keys.owner, { agent_close_policy: 'close', agent_self_assign: true, agent_escalate_to: null });
    const changed = (await myContext(agentSecret)).body?.data?.pack ?? {};
    check('pack: changes when the rules change, never stored', changed.rules?.close_policy === 'close' && changed.rules?.self_assign === true && changed.rules?.escalate_to?.name === 'Olivia'
      && changed.rules?.says?.some((line: string) => /finishes it/.test(line)) && changed.rules?.says?.some((line: string) => /unassigned/.test(line) && /may pick up/.test(line)), changed.rules);
    check('pack: a host publisher means no heartbeat needed', changed.health?.publisher_reports === true && changed.conventions?.some((line: string) => /do not need heartbeat/.test(line)), changed.health);
    await call(projectsRoute.PATCH, 'PATCH', `/api/v1/agents/${agent}/projects`, { id: agent }, s.keys.owner, { remove: [s.queue] });
    const fewer = (await myContext(agentSecret)).body?.data?.pack ?? {};
    check('pack: and when its projects change', JSON.stringify(fewer.projects?.list?.map((p: Loose) => p.name)) === JSON.stringify(['Apex']), fewer.projects);
    check('pack: a webhook filter project it no longer reaches is not named, even to itself', JSON.stringify(fewer.webhooks?.[0]?.projects)
      === JSON.stringify([{ id: s.apex, name: 'Apex' }, { id: null, name: 'A project you cannot see' }]) && !JSON.stringify(fewer).includes('Queue') && !JSON.stringify(fewer).includes(s.queue), fewer.webhooks);
    await call(projectsRoute.PATCH, 'PATCH', `/api/v1/agents/${agent}/projects`, { id: agent }, s.keys.owner, { add: [s.queue] });

    // --- Markdown files ------------------------------------------------------------------------
    const md = await myContext(agentSecret, '?format=md');
    check('format=md: an AGENTS.md download, never cached', md.status === 200 && /^text\/markdown/.test(md.headers.get('content-type') ?? '')
      && md.headers.get('content-disposition') === 'attachment; filename="AGENTS.md"' && md.headers.get('cache-control') === 'no-store', [md.status, [...md.headers.entries()]]);
    check('format=md: says who, where, the rules, projects, conventions and tools', md.text.startsWith('# Scout (Builder) at Northwind Ops') && /## Your rules/.test(md.text)
      && /Apex/.test(md.text) && /## How we work here/.test(md.text) && /`get_task_brief`/.test(md.text) && !md.text.includes(agentSecret), md.text.slice(0, 400));
    check('format=md: no em dashes in what the app writes', !md.text.includes('—'));
    const skill = await myContext(agentSecret, '?format=skill');
    check('format=skill: a SKILL.md with front matter', skill.status === 200 && skill.text.startsWith('---\nname: project-management\ndescription: ')
      && skill.headers.get('content-disposition') === 'attachment; filename="SKILL.md"', skill.text.slice(0, 200));
    const badFormat = await myContext(agentSecret, '?format=pdf');
    check('format: anything else is 400', badFormat.status === 400, badFormat.body);

    // --- The pack, read by whoever sets the agent up -------------------------------------------
    const ownerView = await contextOf(s.keys.owner, agent);
    const ov = ownerView.body?.data?.pack ?? {};
    check("by id: an Owner reads the agent's pack, as its newest key sees it", ownerView.status === 200 && ov.key?.source === 'agent_key' && ov.key?.name === 'Scout harness'
      && JSON.stringify(ov.tools?.map((t: Loose) => t.name)) === JSON.stringify(expectedTools), ov.key);
    check('by id: the full webhook URL for a key with webhooks.manage', ov.webhooks?.[0]?.url === 'https://hooks.example.com/scout/wake', ov.webhooks);
    const adaView = await contextOf(s.keys.ada, agent);
    check('by id: projects the reader cannot reach are counted, not named; webhooks need webhooks.manage, as in get_agent_setup', adaView.status === 200
      && JSON.stringify(adaView.body.data.pack.projects.list.map((p: Loose) => p.name)) === JSON.stringify(['Apex']) && adaView.body.data.pack.projects.hidden_count === 1
      && adaView.body.data.pack.webhooks === null && adaView.body.data.pack.omitted.some((o: Loose) => o.part === 'webhooks' && o.needs === 'webhooks.manage')
      && !adaView.text.includes('Queue') && !adaView.text.includes('hooks.example.com') && !adaView.text.includes('Scout wake'), adaView.body.data?.pack);
    const adaHooksView = await contextOf(s.keys.adaHooks, agent);
    const ahv = adaHooksView.body?.data?.pack ?? {};
    check('by id: with webhooks.manage the endpoint shows, but a filter project the reader cannot reach is not named', adaHooksView.status === 200
      && ahv.webhooks?.[0]?.url === 'https://hooks.example.com/scout/wake'
      && JSON.stringify(ahv.webhooks?.[0]?.projects) === JSON.stringify([{ id: s.apex, name: 'Apex' }, { id: null, name: 'A project you cannot see' }])
      && !adaHooksView.text.includes('Queue') && !adaHooksView.text.includes(s.queue), ahv.webhooks);
    check("by id: an agent's scopes and tools need api_keys.manage_all, as available_scopes does", ahv.scopes === null && ahv.tools === null && ahv.key === null
      && ahv.inactive_scopes === null && ahv.omitted?.some((o: Loose) => o.needs === 'api_keys.manage_all') && Array.isArray(ahv.conventions) && ahv.conventions.length > 0, ahv);
    const adaReadView = await contextOf(s.keys.adaRead, agent);
    check('by id: team.read alone shows neither scopes, tools nor webhooks', adaReadView.status === 200 && adaReadView.body.data.pack.scopes === null
      && adaReadView.body.data.pack.webhooks === null && /^# Scout/.test(adaReadView.body.data.markdown) && !/## What you may do/.test(adaReadView.body.data.markdown), adaReadView.body.data?.pack);
    const packOnly = await contextOf(s.keys.owner, agent, '?format=pack');
    const markdownOnly = await contextOf(s.keys.owner, agent, '?format=markdown');
    check('format=pack and format=markdown answer one part each', packOnly.status === 200 && !!packOnly.body.data.pack && !('markdown' in packOnly.body.data)
      && markdownOnly.status === 200 && typeof markdownOnly.body.data.markdown === 'string' && !('pack' in markdownOnly.body.data), [packOnly.body, markdownOnly.status]);
    const ownerMd = await contextOf(s.keys.owner, agent, '?format=md');
    check('by id: format=md too', ownerMd.status === 200 && ownerMd.headers.get('content-disposition') === 'attachment; filename="AGENTS.md"');
    check('by id: an agent key may not read it (team.read)', (await contextOf(agentSecret, agent)).status === 403);
    check('by id: a person is not an agent', (await contextOf(s.keys.owner, s.morgan)).status === 422);
    const otherKey = await contextOf(s.keys.owner, agent, `?key_id=${randomUUID()}`);
    check('by id: key_id must be one of its keys', otherKey.status === 404, otherKey.body);

    // --- pm_guide over the real MCP route ------------------------------------------------------
    const rpc = async (apiKey: string, body: unknown, protocol?: string) => {
      const response = await mcpRoute.POST(new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey, ...(protocol ? { 'mcp-protocol-version': protocol } : {}) },
        body: JSON.stringify(body),
      }));
      const text = await response.text();
      return JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text) as Loose;
    };
    const guideFor = async (apiKey: string) => {
      const hello = await rpc(apiKey, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes', version: '1' } } });
      const result = await rpc(apiKey, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pm_guide', arguments: {} } }, String(hello.result?.protocolVersion));
      return result.result?.structuredContent as Loose;
    };
    const guide = await guideFor(agentSecret);
    check('pm_guide: the old contract holds: the same guide text, you and the tool list', guide?.ok === true && guide.guide === PM_GUIDE && guide.you?.name === 'Scout'
      && guide.you?.profile === 'builder' && guide.you?.read_only_key === false
      && JSON.stringify(guide.tools) === JSON.stringify(expectedTools.filter((name) => name !== 'pm_guide')), guide && { you: guide.you, tools: guide.tools });
    check("pm_guide: adds the key's own pack as context, without repeating the tools", guide?.context?.member?.name === 'Scout' && guide.context.workspace === 'Northwind Ops'
      && guide.context.rules?.close_policy === 'close' && !('tools' in guide.context), guide?.context);
    check('pm_guide: stays well under the MCP read cap', JSON.stringify(guide).length < 40_000, JSON.stringify(guide).length);
    const ownerGuide = await guideFor(s.keys.owner);
    check('pm_guide: setup keys get the template and export pointers; agents do not', /list_agent_templates/.test(ownerGuide?.guide) && /import_agent_config/.test(ownerGuide?.guide)
      && !/list_agent_templates/.test(guide?.guide ?? ''), ownerGuide?.guide?.slice(-600));
    check('pm_guide: a person gets their own context, with no agent rules', ownerGuide?.context?.member?.is_agent === false && ownerGuide.context.rules === null, ownerGuide?.context?.member);

    // --- Templates through the setup API -------------------------------------------------------
    const listed = await call(templatesRoute.GET, 'GET', '/api/v1/agent-templates', {}, s.keys.owner);
    check('list: every template with its rules, scopes, brief and events', listed.status === 200
      && JSON.stringify(listed.body.data.map((t: Loose) => t.key)) === JSON.stringify(AGENT_TEMPLATES.map((t) => t.key))
      && listed.body.data.every((t: Loose) => t.rules && t.scopes.length && t.context), listed.body);
    await s.q("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'inbox'");
    const noInbox = await call(templatesRoute.GET, 'GET', '/api/v1/agent-templates', {}, s.keys.owner);
    check('list: inbox triage only while the Inbox is on', noInbox.status === 200 && !noInbox.body.data.some((t: Loose) => t.key === 'inbox-triage'), noInbox.body);
    const inboxOff = await applyTemplate(s.keys.owner, agent, { template: 'inbox-triage' });
    check('apply: a template whose module is off is refused', inboxOff.status === 422 && reason(inboxOff) === 'module_off', inboxOff.body);
    await s.q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'inbox'");
    check('list: agent keys may not list them', (await call(templatesRoute.GET, 'GET', '/api/v1/agent-templates', {}, agentSecret)).status === 403);

    for (const template of CORE_AGENT_TEMPLATES) {
      const target = await newAgent(`T${template.key.replace(/-/g, '')}`, 'generic');
      const applied = await applyTemplate(s.keys.owner, target, { template: template.key });
      const row = (await s.q('SELECT agent_self_assign, agent_close_policy, agent_create_policy FROM pm.team_members WHERE id = $1', [target]))[0];
      check(`apply ${template.key}: sets its rules`, applied.status === 200 && row.agent_self_assign === template.rules.agent_self_assign
        && row.agent_close_policy === template.rules.agent_close_policy && row.agent_create_policy === template.rules.agent_create_policy
        && applied.body.data?.key?.created === null && JSON.stringify(applied.body.data?.key?.scopes) === JSON.stringify(template.scopes)
        && applied.headers.get('cache-control') === 'no-store', applied.body);
    }

    const builder = await newAgent('Bob');
    const keysBefore = (await counts()).keys;
    const withKey = await applyTemplate(s.keys.owner, builder, { template: 'builder', create_key: true });
    const builderTemplate = CORE_AGENT_TEMPLATES.find((t) => t.key === 'builder') as AgentTemplate;
    check("apply builder with create_key: a key with the template's scopes, its secret once", withKey.status === 200 && /^pk_live_/.test(withKey.body.data?.key?.secret ?? '')
      && JSON.stringify(withKey.body.data?.key?.created?.scopes) === JSON.stringify(builderTemplate.scopes) && withKey.body.data?.key?.created?.created_by_key_id
      && JSON.stringify(withKey.body.data?.webhook_events) === JSON.stringify(builderTemplate.webhook_events) && (await counts()).keys === keysBefore + 1, withKey.body);
    const replay = await applyTemplate(s.keys.owner, builder, { template: 'builder', create_key: true }, { 'idempotency-key': randomUUID() });
    check('apply: Idempotency-Key is refused, since the answer can hold a secret', replay.status === 400 && reason(replay) === 'idempotency_not_supported', replay.body);

    const reporter = await newAgent('Rita');
    const rulesBefore = (await s.q('SELECT agent_close_policy, agent_create_policy FROM pm.team_members WHERE id = $1', [reporter]))[0];
    const adaApply = await applyTemplate(s.keys.ada, reporter, { template: 'weekly-reporter' });
    check("apply: a non-owner's key that lacks the template's scopes is 403 scope_escalation", adaApply.status === 403 && reason(adaApply) === 'scope_escalation'
      && adaApply.body.error?.details?.beyond_caller?.includes('goals.read'), adaApply.body);
    // An admin who may hire agents applies External agent: questions.ask is an admin's on the API by
    // default (20261125001400_external_agents.sql); agent_activity.write is an Owner's grant to her.
    const outside = await newAgent('Xena', 'generic');
    const adaNoActivity = await applyTemplate(s.keys.adaExternal, outside, { template: 'external-agent' });
    check('apply external-agent: an admin holds questions.ask on the API; only what an Owner has not granted is beyond her', adaNoActivity.status === 403
      && JSON.stringify(adaNoActivity.body.error?.details?.beyond_caller) === JSON.stringify(['agent_activity.write']), adaNoActivity.body);
    await s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'agent_activity.write', 'api', 'allow')", [s.ada]);
    const adaExternal = await applyTemplate(s.keys.adaExternal, outside, { template: 'external-agent' });
    await s.q("DELETE FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'agent_activity.write'", [s.ada]);
    check('apply external-agent: an admin with team.manage applies it from her own key', adaExternal.status === 200, adaExternal.body);
    const narrowApply = await applyTemplate(s.keys.ownerNarrow, reporter, { template: 'weekly-reporter' });
    check("apply: an Owner's key is held to the same rule", narrowApply.status === 403 && reason(narrowApply) === 'scope_escalation', narrowApply.body);
    const rulesAfter = (await s.q('SELECT agent_close_policy, agent_create_policy FROM pm.team_members WHERE id = $1', [reporter]))[0];
    check('apply: a refused template changes nothing', JSON.stringify(rulesBefore) === JSON.stringify(rulesAfter), [rulesBefore, rulesAfter]);
    const unknownTemplate = await applyTemplate(s.keys.owner, reporter, { template: 'nope' });
    check('apply: an unknown template names the ones there are', unknownTemplate.status === 422 && reason(unknownTemplate) === 'unknown_template'
      && unknownTemplate.body.error?.details?.templates?.includes('builder'), unknownTemplate.body);
    const onPerson = await applyTemplate(s.keys.owner, s.morgan, { template: 'builder' });
    check('apply: people are not agents', onPerson.status === 422, onPerson.body);

    await applyTemplate(s.keys.owner, agent, { template: 'builder' });
    await settle();
    const withTemplate = (await contextOf(s.keys.owner, agent)).body?.data ?? {};
    check("pack: the template's brief once applied", withTemplate.pack?.template?.key === 'builder' && /claim_task/.test(withTemplate.pack?.template?.context ?? '')
      && /## Your job: Builder/.test(withTemplate.markdown ?? ''), withTemplate.pack?.template);

    // --- Export --------------------------------------------------------------------------------
    await call(memberRoute.PATCH, 'PATCH', `/api/v1/team-members/${agent}`, { id: agent }, s.keys.owner, { agent_escalate_to: s.morgan });
    const exported = await exportOf(s.keys.owner, agent);
    const doc = exported.body?.data ?? {};
    check('export: a versioned document', exported.status === 200 && doc.format === 'pm-agent-config' && doc.version === 1 && doc.workspace === 'Northwind Ops', doc);
    check('export: member, rules and escalation by id and name', doc.member?.name === 'Scout' && doc.member?.title === 'Builder' && doc.member?.agent_profile === 'builder'
      && doc.rules?.agent_close_policy === builderTemplate.rules.agent_close_policy && doc.rules?.agent_escalate_to?.id === s.morgan && doc.rules?.agent_escalate_to?.name === 'Morgan', [doc.member, doc.rules]);
    check('export: projects by id and name', JSON.stringify(doc.projects) === JSON.stringify([{ id: s.apex, name: 'Apex' }, { id: s.queue, name: 'Queue' }]), doc.projects);
    check("export: keys' names and scopes", doc.keys?.length === 1 && doc.keys[0].name === 'Scout harness' && JSON.stringify(doc.keys[0].scopes) === JSON.stringify(AGENT_KEY_SCOPES)
      && doc.keys[0].permissions === 'scoped' && Object.keys(doc.keys[0]).sort().join() === 'name,permissions,scopes', doc.keys);
    check('export: webhooks with URL, events and project filter', doc.webhooks?.length === 1 && doc.webhooks[0].url === 'https://hooks.example.com/scout/wake'
      && JSON.stringify(doc.webhooks[0].projects) === JSON.stringify([{ id: s.apex, name: 'Apex' }, { id: s.queue, name: 'Queue' }]) && !('secret' in doc.webhooks[0]), doc.webhooks);
    check('export: the template it was set up from', doc.template === 'builder', doc.template);
    check('export: never a secret or a hash', !exported.text.includes(agentSecret) && !exported.text.includes(hookSecret) && !exported.text.includes('whsec_')
      && !exported.text.includes('pk_live_') && !exported.text.includes('key_hash') && !exported.text.includes('"secret"'), exported.text.slice(0, 300));
    const adaExport = await exportOf(s.keys.ada, agent);
    check('export: parts the key may not read are null and named, unreachable projects left out', adaExport.status === 200 && adaExport.body.data.webhooks === null
      && adaExport.body.data.projects.length === 1 && adaExport.body.data.omitted.some((o: Loose) => o.needs === 'webhooks.manage'), adaExport.body.data);
    const adaHooksExport = await exportOf(s.keys.adaHooks, agent);
    check('export: a webhook filter project the exporter cannot reach is not named', adaHooksExport.status === 200 && adaHooksExport.body.data.keys === null
      && JSON.stringify(adaHooksExport.body.data.webhooks?.[0]?.projects) === JSON.stringify([{ id: s.apex, name: 'Apex' }, { id: null, name: 'A project you cannot see' }])
      && !adaHooksExport.text.includes('Queue') && !adaHooksExport.text.includes(s.queue), adaHooksExport.body.data);

    // --- Import: dry run, then for real into a fresh agent -------------------------------------
    const before = await counts();
    const dry = await importDoc(s.keys.owner, { document: doc, name: 'Scout Two', email: 'scout2@agents.example.com', dry_run: true, create_keys: true, create_webhooks: true });
    check('dry run: the plan, nothing written', dry.status === 200 && dry.body.data?.dry_run === true && dry.body.data?.agent?.action === 'create'
      && dry.body.data?.projects?.add?.length === 2 && dry.body.data?.keys?.create?.length === 1 && dry.body.data?.webhooks?.create?.length === 1
      && dry.body.data?.keys?.created?.length === 0 && dry.body.data?.webhooks?.created?.length === 0, dry.body);
    await settle();
    check('dry run: writes nothing at all', JSON.stringify(await counts()) === JSON.stringify(before), [before, await counts()]);

    const noFlags = await importDoc(s.keys.owner, { document: doc, name: 'Scout Lite', email: 'scoutlite@agents.example.com' });
    check('import: without create_keys no key is made, and it says what to make', noFlags.status === 201 && noFlags.body.data?.keys?.created?.length === 0
      && noFlags.body.data?.keys?.create?.length === 1 && noFlags.body.data?.webhooks?.created?.length === 0
      && noFlags.body.data?.next?.some((line: string) => /create_keys/.test(line)) && (await s.q('SELECT id FROM pm.api_keys WHERE team_member_id = $1', [noFlags.body.data?.agent?.id])).length === 0, noFlags.body);

    const real = await importDoc(s.keys.owner, { document: doc, name: 'Scout Two', email: 'scout2@agents.example.com', create_keys: true, create_webhooks: true });
    const copy = real.body.data?.agent?.id as string;
    check('import: a new agent, with its keys and endpoints and their secrets once', real.status === 201 && !!copy && real.headers.get('cache-control') === 'no-store'
      && /^pk_live_/.test(real.body.data?.keys?.created?.[0]?.secret ?? '') && /^whsec_/.test(real.body.data?.webhooks?.created?.[0]?.secret ?? ''), real.body);
    const copied = (await exportOf(s.keys.owner, copy)).body?.data ?? {};
    await settle();
    const shape = (d: Loose) => JSON.stringify({
      title: d.member?.title, profile: d.member?.agent_profile, rules: d.rules, projects: d.projects, keys: d.keys,
      webhooks: d.webhooks?.map((w: Loose) => ({ ...w })), template: d.template,
    });
    check('round trip: export, import, export again gives the same configuration', shape(copied) === shape(doc) && copied.member?.name === 'Scout Two', [JSON.parse(shape(doc)), JSON.parse(shape(copied))]);
    const importedKey = real.body.data?.keys?.created?.[0]?.secret as string;
    const keyWorks = await myContext(importedKey);
    check("round trip: the imported key works, and its pack names the copy", keyWorks.status === 200 && keyWorks.body.data.pack.member.name === 'Scout Two'
      && keyWorks.body.data.pack.template?.key === 'builder', keyWorks.body?.data?.pack?.member);
    const auditText = JSON.stringify(await s.q("SELECT request_body, after_snapshot FROM pm.api_audit_log WHERE endpoint = '/api/v1/agents/import'"));
    check('import: audited, never with a secret', auditText.includes(copy) && !auditText.includes(importedKey) && !auditText.includes('whsec_') && !auditText.includes('pk_live_'), auditText.slice(0, 400));
    const replayImport = await importDoc(s.keys.owner, { document: doc, email: 'x@agents.example.com', dry_run: true }, { 'idempotency-key': randomUUID() });
    check('import: Idempotency-Key is refused', replayImport.status === 400 && reason(replayImport) === 'idempotency_not_supported', replayImport.body);

    // --- Import: what does not match is reported --------------------------------------------
    const foreign = {
      ...doc,
      projects: [{ id: randomUUID(), name: 'Apex' }, { id: randomUUID(), name: 'Nowhere' }],
      rules: { ...doc.rules, agent_escalate_to: { id: randomUUID(), name: 'Nobody Here' } },
      webhooks: [{ ...doc.webhooks[0], url: 'https://hooks.example.com/other', projects: [{ id: randomUUID(), name: 'Elsewhere' }] }],
      keys: [],
      template: 'not-a-template',
    };
    const report = await importDoc(s.keys.owner, { document: foreign, agent_id: copy, dry_run: true });
    const unmatched = report.body.data?.unmatched ?? [];
    check('unmatched: a project matches by name when its id does not', report.status === 200 && report.body.data?.projects?.already?.some((p: Loose) => p.name === 'Apex'), report.body.data?.projects);
    check('unmatched: the project, member and webhook filter that do not match are named', unmatched.some((u: Loose) => u.kind === 'project' && u.ref === 'Nowhere')
      && unmatched.some((u: Loose) => u.kind === 'escalate_to' && u.ref === 'Nobody Here')
      && unmatched.some((u: Loose) => u.kind === 'webhook_project' && u.ref === 'Elsewhere'), unmatched);
    check('unmatched: a template this workspace does not have is not applied, and not recorded', report.body.data?.template === null
      && report.body.data?.not_applied?.some((n: Loose) => /not-a-template/.test(n.part)), report.body.data);
    const auditBefore = (await counts()).audit;
    const unknownImportTemplate = await importDoc(s.keys.owner, { document: { ...doc, keys: [], webhooks: [], template: 'not-a-template' }, agent_id: copy });
    await settle();
    const templateRows = await s.q("SELECT request_body FROM pm.api_audit_log WHERE endpoint = '/api/v1/agents/import' AND entity_id = $1 ORDER BY timestamp DESC LIMIT 1", [copy]);
    check('unmatched: the import audit row records no unknown template', unknownImportTemplate.status === 200 && (await counts()).audit > auditBefore
      && templateRows[0]?.request_body?.template === null, templateRows);
    check('unmatched: an endpoint whose filter does not match is skipped, never widened', report.body.data?.webhooks?.skipped?.length === 1 && report.body.data?.webhooks?.create?.length === 0, report.body.data?.webhooks);

    // --- Import: the setup API's rules hold --------------------------------------------------
    const adaCreate = await importDoc(s.keys.ada, { document: doc, email: 'adacopy@agents.example.com' });
    check('import: only an Owner adds an agent', adaCreate.status === 403 && reason(adaCreate) === 'owner_only', adaCreate.body);
    const keyCount = (await counts()).keys;
    const rulesBeforeNarrow = JSON.stringify((await s.q('SELECT agent_self_assign, agent_close_policy, agent_create_policy FROM pm.team_members WHERE id = $1', [copy]))[0]);
    const narrow = await importDoc(s.keys.ownerNarrow, {
      document: { ...doc, rules: { ...doc.rules, agent_create_policy: 'approval' }, keys: [{ name: 'Another harness', scopes: AGENT_KEY_SCOPES }] }, agent_id: copy, create_keys: true,
    });
    check("import: create_keys from a key that lacks the scopes is 403 before anything changes", narrow.status === 403 && ['scope_escalation', 'missing_key_scope'].includes(reason(narrow))
      && (await counts()).keys === keyCount
      && JSON.stringify((await s.q('SELECT agent_self_assign, agent_close_policy, agent_create_policy FROM pm.team_members WHERE id = $1', [copy]))[0]) === rulesBeforeNarrow, narrow.body);
    const adaUpdate = await importDoc(s.keys.ada, { document: { ...doc, keys: [], webhooks: [] }, agent_id: copy, dry_run: true });
    check('import: a non-owner updating only sees projects it reaches', adaUpdate.status === 200 && adaUpdate.body.data?.unmatched?.some((u: Loose) => u.ref === 'Queue'), adaUpdate.body);
    const changedDoc = { ...doc, rules: { ...doc.rules, agent_create_policy: 'approval' }, webhooks: [{ ...doc.webhooks[0], events: ['task.created'] }] };
    const update = await importDoc(s.keys.owner, { document: changedDoc, agent_id: copy });
    const updatedRow = (await s.q('SELECT agent_create_policy FROM pm.team_members WHERE id = $1', [copy]))[0];
    const updatedHooks = await s.q('SELECT events FROM pm.webhook_endpoints WHERE member_id = $1', [copy]);
    check('import onto an agent: rules updated, the matching key kept, the endpoint matched by URL updated', update.status === 200 && updatedRow.agent_create_policy === 'approval'
      && update.body.data?.keys?.existing?.length === 1 && update.body.data?.keys?.create?.length === 0
      && updatedHooks.length === 1 && JSON.stringify(updatedHooks[0].events) === JSON.stringify(['task.created']), [update.body, updatedHooks]);

    // --- Import: who and what it may change -------------------------------------------------
    const ontoOwner = await importDoc(s.keys.owner, { document: doc, agent_id: s.owner, dry_run: true });
    check('import: never onto an Owner', ontoOwner.status === 403 && reason(ontoOwner) === 'owner_protected', ontoOwner.body);
    const ontoPerson = await importDoc(s.keys.owner, { document: doc, agent_id: s.morgan, dry_run: true });
    check('import: never onto a person', ontoPerson.status === 422 && reason(ontoPerson) === 'agents_only', ontoPerson.body);
    const hooksBefore = (await counts()).hooks;
    const newHookDoc = { ...doc, keys: [], webhooks: [{ ...doc.webhooks[0], url: 'https://hooks.example.com/ada' }] };
    const adaHooksFlag = await importDoc(s.keys.ada, { document: newHookDoc, agent_id: copy, create_webhooks: true });
    check('import: create_webhooks without webhooks.manage is 403', adaHooksFlag.status === 403 && reason(adaHooksFlag) === 'missing_key_scope' && (await counts()).hooks === hooksBefore, adaHooksFlag.body);
    const adaHooksNoFlag = await importDoc(s.keys.ada, { document: newHookDoc, agent_id: copy });
    check('import: without webhooks.manage, webhooks are not_applied and nothing is written', adaHooksNoFlag.status === 200
      && adaHooksNoFlag.body.data?.not_applied?.some((n: Loose) => n.part === 'webhooks' && n.needs === 'webhooks.manage') && (await counts()).hooks === hooksBefore, adaHooksNoFlag.body);
    const adaKeys = await importDoc(s.keys.ada, { document: { ...doc, webhooks: [], keys: [{ name: 'Ada made', scopes: ['tasks.read'] }] }, agent_id: copy, create_keys: true });
    check('import: create_keys on an update from a non-owner key that holds the scopes is 403 owner_only', adaKeys.status === 403 && reason(adaKeys) === 'owner_only'
      && (await s.q("SELECT id FROM pm.api_keys WHERE name = 'Ada made'")).length === 0, adaKeys.body);
    const loner = await newAgent('Loner');
    const narrowProjects = await importDoc(s.keys.ownerNarrow, { document: { ...doc, keys: [], webhooks: [] }, agent_id: loner });
    check('import: projects without project_members.manage are not_applied, no membership', narrowProjects.status === 200
      && narrowProjects.body.data?.not_applied?.some((n: Loose) => n.part === 'projects' && n.needs === 'project_members.manage')
      && (await s.q('SELECT project_id FROM pm.project_members WHERE member_id = $1', [loner])).length === 0, narrowProjects.body);

    // --- A failure partway: secrets are never stranded ---------------------------------------
    await s.q(`CREATE FUNCTION pm.test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = 'Boom key' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
    await s.q('CREATE TRIGGER test_boom BEFORE INSERT ON pm.api_keys FOR EACH ROW EXECUTE FUNCTION pm.test_boom()');
    const boomDoc = {
      ...doc,
      keys: [{ name: 'Good key', scopes: ['tasks.read'] }, { name: 'Boom key', scopes: ['tasks.read'] }],
      webhooks: [{ ...doc.webhooks[0], url: 'https://hooks.example.com/boom' }],
    };
    const boom = await importDoc(s.keys.owner, { document: boomDoc, name: 'Boomer', email: 'boomer@agents.example.com', create_keys: true, create_webhooks: true });
    const boomer = boom.body?.error?.details?.agent_id as string;
    await settle();
    const liveKeys = boomer ? await s.q('SELECT name FROM pm.api_keys WHERE team_member_id = $1 AND revoked_at IS NULL', [boomer]) : [{}];
    const boomHooks = boomer ? await s.q('SELECT id FROM pm.webhook_endpoints WHERE member_id = $1', [boomer]) : [{}];
    check('rollback: the failure answers with the new agent, what was undone and what stays', boom.status === 500 && reason(boom) === 'import_incomplete' && !!boomer
      && boom.body.error.details.agent_created === true && boom.body.error.details.rolled_back?.keys?.length === 1 && boom.body.error.details.rolled_back?.webhooks?.length === 1
      && boom.body.error.details.remains?.some((line: string) => /agent stays/.test(line)) && !boom.text.includes('pk_live_') && !boom.text.includes('whsec_'), boom.body);
    check('rollback: no live key and no endpoint whose secret nobody holds', liveKeys.length === 0 && boomHooks.length === 0, [liveKeys, boomHooks]);
    const boomAudit = boomer ? await s.q('SELECT method, endpoint, status_code FROM pm.api_audit_log WHERE entity_id = $1 OR request_body->>\'imported_for\' = $1::text OR request_body->>\'rolled_back_import_for\' = $1::text', [boomer]) : [];
    const boomRow = (method: string, pattern: RegExp, status?: number) => boomAudit.some((row: Loose) => row.method === method && pattern.test(row.endpoint) && (status === undefined || row.status_code === status));
    check('rollback: audit rows for the import, the key made and revoked, the endpoint made and deleted', boomRow('POST', /^\/api\/v1\/agents\/import$/, 500)
      && boomRow('POST', /^\/api\/v1\/api-keys$/) && boomRow('DELETE', /^\/api\/v1\/webhook-endpoints\//) && boomRow('POST', /^\/api\/v1\/webhook-endpoints$/), boomAudit);
    const revokeRows = await s.q("SELECT entity_id FROM pm.api_audit_log WHERE endpoint LIKE '/api/v1/api-keys/%/revoke' AND team_member_id = $1", [s.owner]);
    check('rollback: the revoke has its own row', revokeRows.length >= 1, revokeRows);
    const retry = boomer ? await importDoc(s.keys.owner, { document: { ...boomDoc, keys: [{ name: 'Good key', scopes: ['tasks.read'] }] }, agent_id: boomer, dry_run: true }) : null;
    check('rollback: a retry does not take the undone key or endpoint for existing', retry?.status === 200 && retry.body.data?.keys?.existing?.length === 0
      && retry.body.data?.keys?.create?.length === 1 && retry.body.data?.webhooks?.create?.length === 1 && retry.body.data?.webhooks?.update?.length === 0, retry?.body);

    const boomTemplate = await newAgent('Tempo');
    const boomApply = await applyTemplate(s.keys.owner, boomTemplate, { template: 'builder', create_key: true, key_name: 'Boom key' });
    await settle();
    const tempoAudit = await s.q('SELECT status_code, error FROM pm.api_audit_log WHERE endpoint = $1', [`/api/v1/agents/${boomTemplate}/template`]);
    check('rollback: a template whose key fails says the rules were applied, and audits it', boomApply.status === 500 && reason(boomApply) === 'key_not_made'
      && boomApply.body.error.details.rules?.agent_close_policy === 'review' && tempoAudit.length === 1 && tempoAudit[0].status_code === 500 && /Rules applied/.test(tempoAudit[0].error ?? '')
      && (await s.q('SELECT id FROM pm.api_keys WHERE team_member_id = $1', [boomTemplate])).length === 0, [boomApply.body, tempoAudit]);
    await s.q('DROP TRIGGER test_boom ON pm.api_keys');
    await s.q('DROP FUNCTION pm.test_boom()');

    // --- MCP ---------------------------------------------------------------------------------
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((tool) => tool.name === name);
      if (!t) throw new Error(`no tool ${name}`);
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };
    const mcpList = await runTool(s.keys.owner, s.owner, 'list_agent_templates', {});
    check('MCP: list_agent_templates', mcpList?.ok === true && mcpList.data?.length === AGENT_TEMPLATES.length, mcpList);
    const mcpContext = await runTool(s.keys.owner, s.owner, 'get_agent_context', { agent_id: agent });
    check('MCP: get_agent_context answers the pack alone', mcpContext?.ok === true && mcpContext.data?.pack?.member?.name === 'Scout' && !('markdown' in (mcpContext.data ?? {})), mcpContext?.error);
    const mcpMarkdown = await runTool(s.keys.owner, s.owner, 'get_agent_context', { agent_id: agent, format: 'markdown' });
    check('MCP: get_agent_context format markdown answers the AGENTS.md text', mcpMarkdown?.ok === true && /^# Scout/.test(mcpMarkdown.data?.markdown ?? '') && !('pack' in (mcpMarkdown.data ?? {})), mcpMarkdown?.error);

    // The most webhooks a pack lists, each filtered to 200 projects: still under the MCP read cap.
    const hooky = await newAgent('Hooky');
    const many = (await s.q<{ id: string }>("INSERT INTO pm.projects (name, created_at) SELECT 'Filter project number ' || g || ' with a long name', now() FROM generate_series(1, 200) g RETURNING id")).map((row) => row.id);
    for (let i = 0; i < 25; i++) {
      await s.q(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, project_ids, member_id)
        VALUES ($1, $2, 'whsec_test', $3, $4, $5)`, [`Endpoint ${i} with a long descriptive name`, `https://hooks.example.com/hooky/${i}/${'x'.repeat(200)}`,
        ['task.created', 'task.updated', 'task.deleted', 'comment.created', 'question.asked', 'question.answered', 'review.submitted'], many, hooky]);
    }
    const heavy = await runTool(s.keys.owner, s.owner, 'get_agent_context', { agent_id: hooky });
    check('MCP: a pack with the most webhooks and filter projects stays under the read cap', heavy?.ok === true && JSON.stringify(heavy).length < 40_000
      && JSON.stringify(heavy.data.pack).length <= PACK_LIMITS.total && heavy.data.pack.webhooks.every((w: Loose) => w.projects.length <= 10 && w.more_projects > 0), heavy?.error ?? JSON.stringify(heavy?.data?.pack ?? {}).length);
    const heavyMarkdown = await runTool(s.keys.owner, s.owner, 'get_agent_context', { agent_id: hooky, format: 'markdown' });
    check('MCP: and its markdown too', heavyMarkdown?.ok === true && JSON.stringify(heavyMarkdown).length < 40_000, heavyMarkdown?.error);
    const mcpExport = await runTool(s.keys.owner, s.owner, 'export_agent_config', { agent_id: agent });
    check('MCP: export_agent_config', mcpExport?.ok === true && mcpExport.data?.format === 'pm-agent-config', mcpExport?.error);
    const mcpDry = await runTool(s.keys.owner, s.owner, 'import_agent_config', { document: mcpExport.data, email: 'mcp@agents.example.com', dry_run: true });
    check('MCP: import_agent_config dry run', mcpDry?.ok === true && mcpDry.data?.dry_run === true && mcpDry.data?.agent?.action === 'create', mcpDry?.error);
    const mcpApply = await runTool(s.keys.ada, s.ada, 'apply_agent_template', { agent_id: reporter, template: 'weekly-reporter' });
    check('MCP: apply_agent_template keeps the escalation rule, as a result the caller can read', mcpApply?.ok === false && mcpApply.status === 403 && mcpApply.error?.reason === 'scope_escalation', mcpApply);
    const visible = async (apiKey: string) => {
      const { access: keyAccess, keyRow } = await resolveApiKey(apiKey);
      return toolsFor({ access: keyAccess, scopes: keyRow.scopes ?? [], readOnly: keyRow.permissions === 'read_only', profile: 'generic' }).map((t) => t.name);
    };
    const newTools = ['get_agent_context', 'list_agent_templates', 'apply_agent_template', 'export_agent_config', 'import_agent_config'];
    check('MCP: the new tools are setup tools', newTools.every((name) => SETUP_TOOLS.includes(name)));
    const ownerTools = await visible(s.keys.owner);
    check('MCP: an Owner key with the permissions sees them all', newTools.every((name) => ownerTools.includes(name)), newTools.filter((name) => !ownerTools.includes(name)));
    const agentTools = await visible(agentSecret);
    check('MCP: an agent key sees none of them', !newTools.some((name) => agentTools.includes(name)), agentTools);
    check('MCP: tools that can return a secret take no idempotency_key', ['apply_agent_template', 'import_agent_config'].every((name) => !('idempotency_key' in (PM_TOOLS.find((t) => t.name === name)?.input.shape ?? {}))));
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`agent context: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`agent context: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
