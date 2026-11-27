import 'server-only';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { apiScopesFor, type AccessContext } from '@/lib/access-control';
import {
  AI_SETUP_KEY_NAME, AI_SETUP_KEY_PREFIX, AI_SETUP_MINUTES, aiSetupKeyScopes, aiSetupRoute, mayStartAiSetup,
  type AiSetupAgentView, type AiSetupConfirmView, type AiSetupKeyView, type AiSetupKind, type AiSetupSessionView, type AiSetupView,
} from '@/lib/ai-setup';
import { editApiKey } from './key-edit';
import { buildConnectInfo, type ConnectInfo } from '@/lib/agent-connect';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';
import { insertAuditRows } from './audit';
import { connectAiState, listConnections, mcpResource } from './connect-ai';
import { hashApiKey } from './crypto';
import { ApiError, forbidden } from './errors';

/**
 * Set up agents with AI, on the server (see lib/ai-setup.ts for the rules):
 * starting and ending a session, finding the live one behind a request, the
 * extra checks a session's calls get, and what the hire page shows.
 *
 * A session never widens what a route allows: on the setup routes its calls
 * carry the person's API powers (scopes, as of the start), and withApi still
 * checks each against the person's live access. The checks here only narrow
 * further: a key or webhook it makes must be an agent's, and every agent it
 * touches must be an agent.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

/** A live session behind a request: what withApi, the MCP server and the audit log need. */
export interface AiSetupGrant {
  /** Null for a setup key whose session row cannot be read (it stays limited to the setup routes). */
  sessionId: string | null;
  kind: AiSetupKind;
  memberId: string;
  clientName: string;
  /** The person's API powers when it started: what a call on a setup route may carry. */
  scopes: string[];
  expiresAt: string | null;
}

const missingTable = (error: { code?: string; message?: string } | null) =>
  !!error && (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error.code ?? '') || /ai_setup_sessions|schema cache|does not exist/i.test(error.message ?? ''));

const SESSION_COLUMNS = 'id, member_id, kind, grant_id, api_key_id, client_name, scopes, created_at, expires_at, ended_at';

function grantFrom(row: Row): AiSetupGrant {
  return {
    sessionId: row.id, kind: row.kind, memberId: row.member_id, clientName: row.client_name,
    scopes: Array.isArray(row.scopes) ? row.scopes : [], expiresAt: row.expires_at,
  };
}

/** The live session elevating a connection, or null (none, ended, expired, or before the migration). */
export async function connectionSetupGrant(service: SupabaseClient, grantId: string, memberId: string, access: AccessContext): Promise<AiSetupGrant | null> {
  // Only someone who may hire is ever elevated; a person who stopped being an Owner loses it at once.
  if (!mayStartAiSetup(access)) return null;
  const { data, error } = await service.from('ai_setup_sessions').select(SESSION_COLUMNS)
    .eq('grant_id', grantId).eq('member_id', memberId).eq('kind', 'connection')
    .is('ended_at', null).gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) {
    if (missingTable(error)) return null;
    throw error;
  }
  return data ? grantFrom(data as Row) : null;
}

/**
 * The session behind a setup key. The key is limited to the setup routes by
 * its prefix alone, so a row that cannot be read still leaves it limited,
 * with no powers beyond its own scopes.
 */
export async function keySetupGrant(service: SupabaseClient, apiKeyId: string, memberId: string, access: AccessContext): Promise<AiSetupGrant> {
  const limited: AiSetupGrant = { sessionId: null, kind: 'key', memberId, clientName: AI_SETUP_KEY_NAME, scopes: [], expiresAt: null };
  const { data, error } = await service.from('ai_setup_sessions').select(SESSION_COLUMNS)
    .eq('api_key_id', apiKeyId).eq('kind', 'key').is('ended_at', null).gt('expires_at', new Date().toISOString())
    .limit(1).maybeSingle();
  if (error) {
    if (missingTable(error)) return limited;
    throw error;
  }
  if (!data || (data as Row).member_id !== memberId) return limited;
  const grant = grantFrom(data as Row);
  return mayStartAiSetup(access) ? grant : { ...grant, scopes: [] };
}

// ── Narrowing a session's calls ─────────────────────────────────────────

const AGENT_PATH = /^\/api\/v1\/agents\/([^/]+)(?:\/|$)/;
const PROJECT_AGENT_PATH = /^\/api\/v1\/projects\/[^/]+\/agents\/([^/]+)\/?$/;

function refuseNotAgent(what: string): never {
  throw forbidden(`While setting up agents with AI, ${what} must be an agent`, {
    reason: 'ai_setup_agents_only',
    hint: 'An AI setup session changes agents only: never a person, and never you.',
  });
}

/**
 * The extra checks on a call a session's powers let through: every agent
 * the path names is an agent; a key or a webhook it makes is for an agent
 * (never the person, whose own keys stay theirs to make); a webhook always
 * names that agent, so it only ever carries that agent's own work.
 */
export async function assertAiSetupCall(service: SupabaseClient, input: { method: string; pathname: string; body: unknown; memberId: string }): Promise<void> {
  const route = aiSetupRoute(input.method, input.pathname);
  if (!route) throw forbidden('This is not part of setting up agents', { reason: 'ai_setup_only' });
  const ids: { id: string; what: string }[] = [];
  const agentMatch = route.startsWith('/api/v1/agents/{id}') ? AGENT_PATH.exec(input.pathname) : null;
  if (agentMatch) ids.push({ id: decodeURIComponent(agentMatch[1]), what: 'the member it changes' });
  const projectAgent = route === '/api/v1/projects/{id}/agents/{agentId}' ? PROJECT_AGENT_PATH.exec(input.pathname) : null;
  if (projectAgent) ids.push({ id: decodeURIComponent(projectAgent[1]), what: 'the member it assigns' });
  if (input.method === 'POST' && (route === '/api/v1/api-keys' || route === '/api/v1/webhook-endpoints')) {
    const memberId = (input.body as Row | null)?.member_id;
    const what = route === '/api/v1/api-keys' ? "the key's member" : "the webhook's member";
    if (typeof memberId !== 'string' || !memberId || memberId === input.memberId) refuseNotAgent(what);
    ids.push({ id: memberId, what });
  }
  if (ids.length === 0) return;
  const { data, error } = await service.from('team_members').select('id, role').in('id', [...new Set(ids.map((i) => i.id))]);
  if (error) throw error;
  const roles = new Map(((data ?? []) as Row[]).map((row) => [row.id as string, row.role as string]));
  for (const { id, what } of ids) {
    // An unknown id is left to the route, which answers 404 as it always does.
    if (roles.has(id) && roles.get(id) !== 'agent') refuseNotAgent(what);
    if (id === input.memberId) refuseNotAgent(what);
  }
}

// ── Starting and ending ─────────────────────────────────────────────────

function requireMayStart(access: AccessContext) {
  if (!mayStartAiSetup(access)) {
    throw forbidden('Only someone who may hire agents (an Owner) can let an AI tool set them up', { reason: 'owner_only' });
  }
}

const expiry = () => new Date(Date.now() + AI_SETUP_MINUTES * 60_000).toISOString();

async function auditSession(service: SupabaseClient, row: {
  memberId: string; sessionId: string; apiKeyId: string | null; step: 'started' | 'ended'; kind: AiSetupKind; clientName: string; expiresAt?: string; scopes?: string[];
}) {
  const { error } = await insertAuditRows(service, {
    method: row.step === 'started' ? 'POST' : 'DELETE',
    endpoint: row.step === 'started' ? '/api/workspace/ai-setup' : `/api/workspace/ai-setup/${row.sessionId}`,
    entity_type: 'ai_setup_session',
    entity_id: row.sessionId,
    api_key_id: row.apiKeyId,
    team_member_id: row.memberId,
    request_body: { step: row.step, kind: row.kind, tool: row.clientName, ...(row.expiresAt ? { expires_at: row.expiresAt } : {}), ...(row.scopes ? { scopes: row.scopes } : {}) },
    status_code: row.step === 'started' ? 201 : 200,
    via: 'app',
  });
  if (error) console.error('[ai-setup] audit write failed:', error.message);
}

/** Ends the person's live sessions for one connection, or every live key session of theirs. */
async function endLive(service: SupabaseClient, memberId: string, match: { grantId: string } | { kind: 'key' }) {
  let query = service.from('ai_setup_sessions').select(SESSION_COLUMNS).eq('member_id', memberId).is('ended_at', null);
  query = 'grantId' in match ? query.eq('grant_id', match.grantId) : query.eq('kind', 'key');
  const { data, error } = await query;
  if (error) throw error;
  for (const row of (data ?? []) as Row[]) await endSession(service, memberId, row);
}

async function endSession(service: SupabaseClient, endedBy: string, row: Row): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await service.from('ai_setup_sessions').update({ ended_at: now, ended_by: endedBy }).eq('id', row.id).is('ended_at', null);
  if (error) throw error;
  // A setup key stops at once; disabled rather than revoked, so the agents' keys it made stay.
  if (row.kind === 'key' && row.api_key_id) {
    const { error: keyError } = await service.from('api_keys').update({ disabled_at: now }).eq('id', row.api_key_id).is('revoked_at', null);
    if (keyError) throw keyError;
  }
  await auditSession(service, { memberId: row.member_id, sessionId: row.id, apiKeyId: row.api_key_id ?? null, step: 'ended', kind: row.kind, clientName: row.client_name });
}

/** Lets one of the person's connected tools set up agents for an hour. */
export async function startConnectionSetup(service: SupabaseClient, access: AccessContext, memberId: string, grantId: string): Promise<AiSetupSessionView> {
  requireMayStart(access);
  const state = await connectAiState(service);
  if (!state.enabled || !state.apiEnabled) {
    throw new ApiError(409, 'CONFLICT', 'Connected AI tools are turned off for this workspace. Use a setup key, or turn Connect AI on in Settings > Security.', { reason: 'connect_ai_off' });
  }
  const { data: grant, error } = await service.from('oauth_grants').select('id, member_id, api_key_id, client_id, revoked_at').eq('id', grantId).maybeSingle();
  if (error) throw error;
  if (!grant || grant.member_id !== memberId || grant.revoked_at) {
    throw new ApiError(404, 'NOT_FOUND', 'That connected app was not found. It may have been disconnected.', { reason: 'not_found' });
  }
  const { data: client } = await service.from('oauth_clients').select('client_name').eq('id', grant.client_id).maybeSingle();
  await endLive(service, memberId, { grantId });
  const scopes = apiScopesFor(access);
  const { data: row, error: insertError } = await service.from('ai_setup_sessions').insert({
    member_id: memberId, kind: 'connection', grant_id: grantId, api_key_id: grant.api_key_id, client_name: client?.client_name ?? 'AI tool',
    scopes, expires_at: expiry(),
  }).select(SESSION_COLUMNS).single();
  if (insertError) {
    if (missingTable(insertError)) throw migrationRequired();
    throw insertError;
  }
  await auditSession(service, { memberId, sessionId: row.id, apiKeyId: grant.api_key_id, step: 'started', kind: 'connection', clientName: row.client_name, expiresAt: row.expires_at, scopes });
  return sessionView(row as Row, []);
}

const migrationRequired = () => new ApiError(409, 'MIGRATION_REQUIRED', 'Run the latest database migration first.', { reason: 'migration_required' });

/** A one-hour setup key of the person's own: shown once, setup scopes only, setup routes only. */
export async function startKeySetup(service: SupabaseClient, access: AccessContext, memberId: string, appUrl: string): Promise<{ session: AiSetupSessionView; secret: string; connect: ConnectInfo }> {
  requireMayStart(access);
  const { data: settings } = await service.from('business_settings').select('api_enabled').limit(1).maybeSingle();
  if (settings?.api_enabled === false) {
    throw new ApiError(409, 'CONFLICT', 'API access is turned off for this workspace. An Owner can turn it on in Settings > Security.', { reason: 'api_disabled' });
  }
  // Fails before any key exists when the table is missing.
  const probe = await service.from('ai_setup_sessions').select('id').limit(1);
  if (probe.error) {
    if (missingTable(probe.error)) throw migrationRequired();
    throw probe.error;
  }
  await endLive(service, memberId, { kind: 'key' });
  const expiresAt = expiry();
  const secret = `${AI_SETUP_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
  const { data: key, error: keyError } = await service.from('api_keys').insert({
    name: AI_SETUP_KEY_NAME,
    key_prefix: secret.slice(0, 15),
    key_hash: await hashApiKey(secret),
    created_by: memberId,
    team_member_id: memberId,
    permissions: 'scoped',
    scopes: aiSetupKeyScopes(access),
    expires_at: expiresAt,
  }).select(API_KEY_COLUMNS).single();
  if (keyError || !key) throw keyError ?? new Error('Failed to create the setup key');
  const keyId = (key as unknown as Row).id as string;
  const scopes = apiScopesFor(access);
  const { data: row, error } = await service.from('ai_setup_sessions').insert({
    member_id: memberId, kind: 'key', api_key_id: keyId, client_name: AI_SETUP_KEY_NAME, scopes, expires_at: expiresAt,
  }).select(SESSION_COLUMNS).single();
  if (error) {
    await service.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', keyId);
    throw error;
  }
  await auditSession(service, { memberId, sessionId: row.id, apiKeyId: keyId, step: 'started', kind: 'key', clientName: AI_SETUP_KEY_NAME, expiresAt, scopes });
  return { session: sessionView(row as Row, []), secret, connect: buildConnectInfo(appUrl) };
}

/** Ends one of the person's sessions now. */
export async function endAiSetup(service: SupabaseClient, memberId: string, sessionId: string): Promise<void> {
  const { data, error } = await service.from('ai_setup_sessions').select(SESSION_COLUMNS).eq('id', sessionId).maybeSingle();
  if (error) {
    if (missingTable(error)) throw new ApiError(404, 'NOT_FOUND', 'That setup session was not found.', { reason: 'not_found' });
    throw error;
  }
  const row = data as Row | null;
  if (!row || row.member_id !== memberId) throw new ApiError(404, 'NOT_FOUND', 'That setup session was not found.', { reason: 'not_found' });
  if (row.ended_at) return;
  await endSession(service, memberId, row);
}

// ── What the hire page shows ────────────────────────────────────────────

const RECENT_MS = 2 * 60 * 60_000;
/**
 * Where a hire and an added agent are recorded: AGENT_HIRE_ENDPOINT
 * (agent-context.ts, not imported here: withApi loads this module, and
 * agent-context reaches back to withApi) and POST /api/v1/agents.
 */
export const AI_SETUP_AGENT_ENDPOINTS = ['/api/workspace/agents', '/api/v1/agents'];
const AGENT_ENDPOINTS = AI_SETUP_AGENT_ENDPOINTS;

function sessionView(row: Row, agents: AiSetupAgentView[], keys: AiSetupKeyView[] = [], confirms: AiSetupConfirmView[] = []): AiSetupSessionView {
  const active = !row.ended_at && new Date(row.expires_at).getTime() > Date.now();
  return {
    id: row.id, kind: row.kind, client_name: row.client_name, grant_id: row.grant_id ?? null,
    created_at: row.created_at, expires_at: row.expires_at, ended_at: row.ended_at ?? null, active, agents, keys, confirms,
  };
}

/**
 * The keys each session made (api_keys.ai_setup_session_id) and what each
 * asked for that waits on the Owner. Empty on a database before them.
 */
async function keysAndConfirms(service: SupabaseClient, sessionIds: string[]): Promise<{ keys: Map<string, AiSetupKeyView[]>; confirms: Map<string, AiSetupConfirmView[]> }> {
  const keys = new Map<string, AiSetupKeyView[]>();
  const confirms = new Map<string, AiSetupConfirmView[]>();
  if (sessionIds.length === 0) return { keys, confirms };
  const [keyRows, confirmRows] = await Promise.all([
    service.from('api_keys').select('id, name, key_prefix, team_member_id, scopes, created_at, expires_at, revoked_at, ai_setup_session_id')
      .in('ai_setup_session_id', sessionIds).order('created_at', { ascending: false }),
    service.from('ai_setup_confirms').select('id, session_id, kind, agent_id, api_key_id, scopes, host, status, created_at')
      .in('session_id', sessionIds).order('created_at'),
  ]);
  if (keyRows.error && !missingTable(keyRows.error)) throw keyRows.error;
  if (confirmRows.error && !missingTable(confirmRows.error)) throw confirmRows.error;
  const kRows = (keyRows.error ? [] : keyRows.data ?? []) as Row[];
  const cRows = (confirmRows.error ? [] : confirmRows.data ?? []) as Row[];
  const memberIds = [...new Set([...kRows.map((k) => k.team_member_id), ...cRows.map((c) => c.agent_id)].filter(Boolean))] as string[];
  const { data: members, error } = memberIds.length ? await service.from('team_members').select('id, name').in('id', memberIds) : { data: [], error: null };
  if (error) throw error;
  const nameOf = new Map(((members ?? []) as Row[]).map((m) => [m.id as string, m.name as string]));
  const keyNames = new Map(kRows.map((k) => [k.id as string, k.name as string]));
  for (const k of kRows) {
    const list = keys.get(k.ai_setup_session_id) ?? [];
    list.push({
      id: k.id, name: k.name, key_prefix: k.key_prefix, agent_id: k.team_member_id ?? null, agent_name: k.team_member_id ? nameOf.get(k.team_member_id) ?? null : null,
      scopes: k.scopes ?? [], created_at: k.created_at, expires_at: k.expires_at ?? null, revoked_at: k.revoked_at ?? null,
    });
    keys.set(k.ai_setup_session_id, list);
  }
  for (const c of cRows) {
    const list = confirms.get(c.session_id) ?? [];
    list.push({
      id: c.id, kind: c.kind, agent_id: c.agent_id ?? null, agent_name: c.agent_id ? nameOf.get(c.agent_id) ?? null : null,
      key_name: c.api_key_id ? keyNames.get(c.api_key_id) ?? null : null, scopes: c.scopes ?? [], host: c.host ?? null, status: c.status, created_at: c.created_at,
    });
    confirms.set(c.session_id, list);
  }
  return { keys, confirms };
}

/** The agents each session made: audit rows of a hire or an added agent, by its key, while it lived. */
async function agentsBySession(service: SupabaseClient, sessions: Row[]): Promise<Map<string, AiSetupAgentView[]>> {
  const out = new Map<string, AiSetupAgentView[]>(sessions.map((s) => [s.id as string, []]));
  const keyed = sessions.filter((s) => s.api_key_id);
  if (keyed.length === 0) return out;
  const since = keyed.map((s) => s.created_at as string).sort()[0];
  const { data: audits, error } = await service.from('api_audit_log')
    .select('entity_id, api_key_id, timestamp, status_code')
    .eq('entity_type', 'team_member').eq('method', 'POST').in('endpoint', AGENT_ENDPOINTS)
    .in('api_key_id', keyed.map((s) => s.api_key_id as string)).gte('timestamp', since).lt('status_code', 300)
    .order('timestamp', { ascending: false }).limit(500);
  if (error) throw error;
  const bySession = new Map<string, string[]>();
  for (const audit of (audits ?? []) as Row[]) {
    const at = new Date(audit.timestamp).getTime();
    const session = keyed.find((s) => s.api_key_id === audit.api_key_id && at >= new Date(s.created_at).getTime()
      && at <= new Date(s.ended_at ?? s.expires_at).getTime());
    if (!session || !audit.entity_id) continue;
    const list = bySession.get(session.id) ?? [];
    if (!list.includes(audit.entity_id)) list.push(audit.entity_id);
    bySession.set(session.id, list);
  }
  const agentIds = [...new Set([...bySession.values()].flat())];
  if (agentIds.length === 0) return out;
  const [members, memberships, keys] = await Promise.all([
    service.from('team_members').select('id, name, avatar, title, agent_role, status, role, created_at').in('id', agentIds),
    service.from('project_members').select('member_id, project:projects(id, name, deleted_at)').in('member_id', agentIds),
    service.from('api_keys').select('team_member_id, scopes').in('team_member_id', agentIds).is('revoked_at', null),
  ]);
  for (const result of [members, memberships, keys]) if (result.error) throw result.error;
  const projectsOf = new Map<string, { id: string; name: string }[]>();
  for (const row of (memberships.data ?? []) as Row[]) {
    const project = Array.isArray(row.project) ? row.project[0] : row.project;
    if (!project || project.deleted_at) continue;
    projectsOf.set(row.member_id, [...(projectsOf.get(row.member_id) ?? []), { id: project.id, name: project.name }]);
  }
  const powersOf = new Map<string, Set<string>>();
  for (const row of (keys.data ?? []) as Row[]) {
    const set = powersOf.get(row.team_member_id) ?? new Set<string>();
    for (const scope of row.scopes ?? []) set.add(scope);
    powersOf.set(row.team_member_id, set);
  }
  const memberById = new Map(((members.data ?? []) as Row[]).filter((m) => m.role === 'agent').map((m) => [m.id as string, m]));
  for (const [sessionId, ids] of bySession) {
    out.set(sessionId, ids.flatMap((id) => {
      const m = memberById.get(id);
      if (!m) return [];
      return [{
        id, name: m.name, avatar: m.avatar || null, title: m.title ?? null, agent_role: m.agent_role ?? null, status: m.status ?? 'active',
        created_at: m.created_at, powers: powersOf.get(id)?.size ?? 0,
        projects: (projectsOf.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      }];
    }));
  }
  return out;
}

/** The person's sessions: live ones, and ones that ended in the last two hours. */
export async function mySetupSessions(service: SupabaseClient, memberId: string): Promise<{ ready: boolean; sessions: AiSetupSessionView[] }> {
  const { data, error } = await service.from('ai_setup_sessions').select(SESSION_COLUMNS)
    .eq('member_id', memberId).gte('created_at', new Date(Date.now() - RECENT_MS - AI_SETUP_MINUTES * 60_000).toISOString())
    .order('created_at', { ascending: false }).limit(20);
  if (error) {
    if (missingTable(error)) return { ready: false, sessions: [] };
    throw error;
  }
  const rows = ((data ?? []) as Row[]).filter((row) => {
    const ended = new Date(row.ended_at ?? row.expires_at).getTime();
    return ended > Date.now() - RECENT_MS;
  });
  const [agents, made] = await Promise.all([agentsBySession(service, rows), keysAndConfirms(service, rows.map((row) => row.id as string))]);
  return { ready: true, sessions: rows.map((row) => sessionView(row, agents.get(row.id) ?? [], made.keys.get(row.id) ?? [], made.confirms.get(row.id) ?? [])) };
}

/**
 * The Owner says yes (allow) or no to what a session asked for. Only the
 * person whose session it was, signed in, decides, and only once: a
 * decided one is 409. Allowing adds the powers to the key through the same
 * edit Settings uses (so every grant rule applies again, as that person
 * now), or switches the webhook on. This never passes through an agent or
 * an API key: its whole point is a person saying yes in the app.
 */
export async function decideSetupConfirm(
  service: SupabaseClient, person: { memberId: string; access: AccessContext }, confirmId: string, allow: boolean,
): Promise<AiSetupConfirmView> {
  const { data, error } = await service.from('ai_setup_confirms').select('id, session_id, member_id, kind, agent_id, api_key_id, webhook_endpoint_id, scopes, host, status, created_at')
    .eq('id', confirmId).maybeSingle();
  if (error && !missingTable(error)) throw error;
  const row = (error ? null : data) as Row | null;
  if (!row || row.member_id !== person.memberId) throw new ApiError(404, 'NOT_FOUND', 'That request was not found.', { reason: 'not_found' });
  if (row.status !== 'pending') throw new ApiError(409, 'CONFLICT', allow ? 'That was already decided.' : 'That was already decided.', { reason: 'already_decided', status: row.status });
  if (allow) {
    if (!mayStartAiSetup(person.access)) throw forbidden('Only an Owner allows what an AI setup asked for', { reason: 'owner_only' });
    if (row.kind === 'key_scopes') {
      const { data: key, error: keyError } = await service.from('api_keys').select('scopes').eq('id', row.api_key_id).maybeSingle();
      if (keyError) throw keyError;
      if (!key) throw new ApiError(404, 'NOT_FOUND', 'That key is gone.', { reason: 'key_gone' });
      const result = await editApiKey(service, { memberId: person.memberId, access: person.access }, row.api_key_id, {
        scopes: [...new Set([...((key as Row).scopes ?? []), ...(row.scopes ?? [])])],
      });
      if (result.status !== 200) throw new ApiError(result.status, result.status === 404 ? 'NOT_FOUND' : 'CONFLICT', result.body.error, { reason: 'key_not_changed' });
    } else {
      const { error: hookError } = await service.from('webhook_endpoints').update({ is_active: true }).eq('id', row.webhook_endpoint_id);
      if (hookError) throw hookError;
    }
  }
  const decidedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await service.from('ai_setup_confirms')
    .update({ status: allow ? 'allowed' : 'declined', decided_at: decidedAt, decided_by: person.memberId })
    .eq('id', confirmId).eq('status', 'pending').select('id').maybeSingle();
  if (updateError) throw updateError;
  if (!updated) throw new ApiError(409, 'CONFLICT', 'That was already decided.', { reason: 'already_decided' });
  const { error: auditError } = await insertAuditRows(service, {
    method: 'POST', endpoint: `/api/workspace/ai-setup/confirms/${confirmId}`, entity_type: 'ai_setup_confirm', entity_id: confirmId,
    api_key_id: null, team_member_id: person.memberId,
    request_body: { allow, kind: row.kind, scopes: row.scopes ?? [], host: row.host ?? null, api_key_id: row.api_key_id ?? null, webhook_endpoint_id: row.webhook_endpoint_id ?? null },
    status_code: 200, via: 'app',
  });
  if (auditError) console.error('[ai-setup] confirm audit write failed:', auditError.message);
  return {
    id: row.id, kind: row.kind, agent_id: row.agent_id ?? null, agent_name: null, key_name: null, scopes: row.scopes ?? [], host: row.host ?? null,
    status: allow ? 'allowed' : 'declined', created_at: row.created_at,
  };
}

export async function aiSetupView(service: SupabaseClient, memberId: string, access: AccessContext, origin: string): Promise<AiSetupView> {
  const [state, connections, mine] = await Promise.all([connectAiState(service), listConnections(service, memberId), mySetupSessions(service, memberId)]);
  return {
    ready: mine.ready,
    may_start: mayStartAiSetup(access),
    connect_enabled: state.ready && state.enabled && state.apiEnabled,
    connections: connections.map((c) => ({ id: c.id, client_name: c.client_name, redirect_host: c.redirect_host })),
    sessions: mine.sessions,
    mcp_url: mcpResource(origin),
  };
}
