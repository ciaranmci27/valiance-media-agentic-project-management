/**
 * The end-to-end suite's shared pieces: the local stack's settings, real HTTP
 * against the running app (signed-in people with their session cookie,
 * agents with their API key, MCP over HTTP), the database for setup and
 * checks, the people every scenario uses, bounded polling, one log line per
 * step, and cleanup.
 *
 * Only ever talks to this machine: the settings come from
 * scripts/local/.env.test.local and every address is checked to be local.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServerClient } from '@supabase/ssr';
import { Client } from 'pg';
import { fetchWhileCompiling } from './retry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are read field by field
export type Json = any;

export const LOCAL_DIR = join(__dirname, '..', 'local');
export const ENV_FILE = join(LOCAL_DIR, '.env.test.local');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertLocal(value: string | undefined, name: string): void {
  let host = '';
  try {
    host = new URL(value ?? '').hostname;
  } catch {
    // falls through
  }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`${name} is not on this machine (${host || 'unset'}). The end-to-end suite only ever uses the local stack.`);
}

/** KEY=VALUE lines of scripts/local/.env.test.local. */
export function readStackEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) throw new Error('No scripts/local/.env.test.local. Run npm run local:up and npm run local:seed first (scripts/local/README.md).');
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  assertLocal(out.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL');
  assertLocal(out.DATABASE_URL, 'DATABASE_URL');
  return out;
}

// ── Logging and checks ───────────────────────────────────────────────────

let stepCount = 0;
export function step(line: string): void {
  stepCount += 1;
  console.log(`    ok  ${line}`);
}
export const stepsLogged = () => stepCount;

export class E2EFailure extends Error {}

export function check(condition: unknown, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const detail = evidence === undefined ? '' : `\n        evidence: ${JSON.stringify(evidence).slice(0, 1500)}`;
    throw new E2EFailure(`${message}${detail}`);
  }
}

export function equal<T>(actual: T, expected: T, message: string, evidence?: unknown): void {
  check(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, evidence);
}

/** Polls until `probe` answers something truthy, at most `timeoutMs`; never a fixed sleep. */
export async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value as T;
      last = value;
    } catch (error) {
      last = error instanceof Error ? error.message : error;
    }
    if (Date.now() > deadline) throw new E2EFailure(`Timed out after ${timeoutMs} ms waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

export const tag = randomBytes(3).toString('hex');
export const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// ── HTTP ─────────────────────────────────────────────────────────────────

export interface Answer {
  status: number;
  body: Json;
  headers: Headers;
}

/** First requests compile the route in dev mode: generous, but bounded. */
const REQUEST_TIMEOUT_MS = 90_000;

export async function http(baseUrl: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; raw?: BodyInit; redirect?: RequestRedirect } = {}): Promise<Answer> {
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined = init.raw;
  if (init.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = JSON.stringify(init.body);
  }
  const method = init.method ?? (body ? 'POST' : 'GET');
  // A route compiling (a dropped connection, an HTML 5xx) is retried for up to a minute; the app's own answers never are (retry.ts).
  const { response, text } = await fetchWhileCompiling(() => fetch(url, {
    method,
    headers,
    body,
    redirect: init.redirect ?? 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }), { method, onRetry: (why, attempt) => console.log(`    ..  retry ${attempt} of ${method} ${path}: ${why}`) });
  let parsed: Json = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  // A dev-server error page: keep the one line that says what broke (a build error names the module).
  if (response.status >= 500 && typeof parsed === 'string' && parsed.includes('<html')) {
    const reason = /Module not found: [^\\"<]+/.exec(parsed)?.[0] ?? /"message":"([^"]{0,300})/.exec(parsed)?.[1] ?? 'an HTML error page';
    parsed = { server_error: reason };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** The data of a { data } or { success, data } answer, after checking the status. */
export function dataOf(answer: Answer, expected: number | number[], what: string): Json {
  const wanted = Array.isArray(expected) ? expected : [expected];
  check(wanted.includes(answer.status), `${what}: HTTP ${answer.status}, expected ${wanted.join(' or ')}`, answer.body);
  return answer.body && typeof answer.body === 'object' && 'data' in answer.body ? answer.body.data : answer.body;
}

/** The error code of a refused answer, whichever shape it has. */
export function errorOf(answer: Answer): { code: string | null; message: string; reason: string | null; details: Json } {
  const error = answer.body?.error;
  if (typeof error === 'string') return { code: null, message: error, reason: null, details: null };
  return { code: error?.code ?? null, message: error?.message ?? '', reason: error?.details?.reason ?? null, details: error?.details ?? null };
}

// ── Callers ──────────────────────────────────────────────────────────────

export interface Ctx {
  baseUrl: string;
  env: Record<string, string>;
  db: Client;
  people: People;
  cleanup: Cleanup;
}

/** A signed-in person: the session cookie the app's own login sets. */
export class Person {
  constructor(
    readonly ctx: { baseUrl: string; env: Record<string, string> },
    readonly name: string,
    readonly email: string,
    readonly memberId: string,
    readonly authUserId: string,
    private cookie: string,
    readonly accessToken: string,
  ) {}

  call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; redirect?: RequestRedirect } = {}): Promise<Answer> {
    return http(this.ctx.baseUrl, path, { ...init, headers: { cookie: this.cookie, ...(init.headers ?? {}) } });
  }

  get(path: string) { return this.call(path); }
  post(path: string, body?: unknown) { return this.call(path, { method: 'POST', body: body ?? {} }); }
  put(path: string, body: unknown) { return this.call(path, { method: 'PUT', body }); }
  patch(path: string, body: unknown) { return this.call(path, { method: 'PATCH', body }); }

  /** What the browser reads straight from the database API with this person's token (row security decides). */
  rest(pathAndQuery: string): Promise<Answer> {
    return http(this.ctx.env.NEXT_PUBLIC_SUPABASE_URL, `${this.ctx.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: this.ctx.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, authorization: `Bearer ${this.accessToken}`, 'accept-profile': 'pm' },
    });
  }

  /** A write the browser makes straight to the database API (row security and triggers decide). */
  restInsert(table: string, row: Record<string, unknown>): Promise<Answer> {
    return http(this.ctx.env.NEXT_PUBLIC_SUPABASE_URL, `${this.ctx.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: this.ctx.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, authorization: `Bearer ${this.accessToken}`,
        'content-profile': 'pm', prefer: 'return=representation',
      },
      body: row,
    });
  }
}

/** An API key's caller: x-api-key on /api/v1, and MCP over HTTP. */
export class KeyCaller {
  constructor(readonly baseUrl: string, readonly key: string, readonly label: string) {}

  call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
    return http(this.baseUrl, path, { ...init, headers: { 'x-api-key': this.key, ...(init.headers ?? {}) } });
  }
  get(path: string) { return this.call(path); }
  post(path: string, body?: unknown) { return this.call(path, { method: 'POST', body: body ?? {} }); }
  put(path: string, body: unknown) { return this.call(path, { method: 'PUT', body }); }
  patch(path: string, body: unknown) { return this.call(path, { method: 'PATCH', body }); }

  private mcpVersion: string | null = null;
  private mcpId = 0;

  /** One JSON-RPC call to /api/mcp (stateless Streamable HTTP, JSON answers). */
  async mcp(method: string, params: Json = {}): Promise<Answer> {
    const headers: Record<string, string> = { 'x-api-key': this.key, accept: 'application/json, text/event-stream' };
    if (this.mcpVersion) headers['mcp-protocol-version'] = this.mcpVersion;
    const isNotification = method.startsWith('notifications/');
    const answer = await http(this.baseUrl, '/api/mcp', {
      method: 'POST', headers,
      body: isNotification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.mcpId, method, params },
    });
    // The server may answer as a one-message event stream: read its data line as the JSON body.
    if (typeof answer.body === 'string' && answer.body.startsWith('event:')) {
      const data = answer.body.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      try { answer.body = JSON.parse(data); } catch { /* left as text for the evidence line */ }
    }
    return answer;
  }

  async mcpConnect(): Promise<Json> {
    const init = await this.mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pm-e2e', version: '1.0.0' } });
    check(init.status === 200 && init.body?.result?.protocolVersion, `MCP initialize answered HTTP ${init.status}`, init.body);
    this.mcpVersion = init.body.result.protocolVersion;
    const ack = await this.mcp('notifications/initialized');
    check(ack.status === 202 || ack.status === 200, `MCP initialized notification answered HTTP ${ack.status}`, ack.body);
    return init.body.result;
  }

  /** tools/call; answers the tool's structured result. */
  async tool(name: string, args: Json = {}): Promise<Json> {
    const answer = await this.mcp('tools/call', { name, arguments: args });
    check(answer.status === 200 && answer.body?.result, `MCP ${name} answered HTTP ${answer.status}`, answer.body);
    const result = answer.body.result;
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find((part: Json) => part.type === 'text')?.text;
    try { return JSON.parse(text); } catch { return text; }
  }
}

/** Signs in with email and password exactly as the app's login does, and keeps the cookies @supabase/ssr set. */
export async function signIn(ctx: { baseUrl: string; env: Record<string, string> }, email: string, password: string, ids: { name: string; memberId: string }): Promise<Person> {
  const jar = new Map<string, string>();
  const client = createServerClient(ctx.env.NEXT_PUBLIC_SUPABASE_URL, ctx.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => { for (const { name, value } of cookies) { if (value) jar.set(name, value); else jar.delete(name); } },
    },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new E2EFailure(`Could not sign in as ${email}: ${error?.message ?? 'no session'}`);
  const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  check(cookie.includes('auth-token'), `No session cookie was set for ${email}`);
  return new Person(ctx, ids.name, email, ids.memberId, data.user.id, cookie, data.session.access_token);
}

// ── People ───────────────────────────────────────────────────────────────

/**
 * The seeded Owner (owner@acme.test, scripts/local/README.md) does what only
 * an Owner may (hire agents, mint their keys). The suite's own people are
 * made once through the app's invite route and reused on every run, with a
 * fresh password each run, so the seeded team's counts are never touched.
 */
export interface People {
  owner: Person;
  requester: Person; // a member who talks to agents in chat and answers them in the app
  manager: Person; // a member who owns the gated agent and decides its approvals
  outsider: Person; // a member outside a gated agent's audience
  guest: Person; // a guest on the suite's guest project only
}

const E2E_PEOPLE = [
  { key: 'requester', name: 'E2E Riley Requester', email: 'e2e-requester@acme.test', role: 'member' },
  { key: 'manager', name: 'E2E Morgan Manager', email: 'e2e-manager@acme.test', role: 'member' },
  { key: 'outsider', name: 'E2E Olive Outsider', email: 'e2e-outsider@acme.test', role: 'member' },
  { key: 'guest', name: 'E2E Gale Guest', email: 'e2e-guest@acme.test', role: 'guest' },
] as const;

const freshPassword = () => `E2e-${randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}9`;

async function setPassword(env: Record<string, string>, authUserId: string, password: string): Promise<void> {
  const answer = await http(env.NEXT_PUBLIC_SUPABASE_URL, `${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${authUserId}`, {
    method: 'PUT',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: { password },
  });
  check(answer.status === 200, `Could not set the test password (HTTP ${answer.status})`, answer.body);
}

export async function preparePeople(ctx: { baseUrl: string; env: Record<string, string>; db: Client }): Promise<People> {
  const { env, db } = ctx;
  check(env.LOCAL_OWNER_EMAIL && env.LOCAL_OWNER_PASSWORD, 'The seeded Owner is missing from scripts/local/.env.test.local: run npm run local:seed');
  const ownerRow = (await db.query(`SELECT id, name FROM pm.team_members WHERE email = $1`, [env.LOCAL_OWNER_EMAIL])).rows[0];
  check(ownerRow, 'The seeded Owner is not in the database: run npm run local:seed');
  const owner = await signIn(ctx, env.LOCAL_OWNER_EMAIL, env.LOCAL_OWNER_PASSWORD, { name: ownerRow.name, memberId: ownerRow.id });

  const out: Partial<People> = { owner };
  for (const spec of E2E_PEOPLE) {
    let row = (await db.query(`SELECT id, name, auth_user_id, status, role FROM pm.team_members WHERE email = $1`, [spec.email])).rows[0];
    const password = freshPassword();
    if (!row) {
      // Team > Invite, with a password (the route's API form), as the Owner.
      const invited = await owner.post('/api/team-members/invite', { name: spec.name, email: spec.email, role: spec.role, password });
      check(invited.status === 200 || invited.status === 201, `Inviting ${spec.email} answered HTTP ${invited.status}`, invited.body);
      row = (await db.query(`SELECT id, name, auth_user_id, status, role FROM pm.team_members WHERE email = $1`, [spec.email])).rows[0];
      check(row, `${spec.email} was invited but has no team row`);
    } else {
      // Reused from an earlier run: active again, with this run's password.
      if (row.status !== 'active') await db.query(`UPDATE pm.team_members SET status = 'active' WHERE id = $1`, [row.id]);
      await setPassword(env, row.auth_user_id, password);
    }
    equal(row.role, spec.role, `${spec.email} role`);
    out[spec.key] = await signIn(ctx, spec.email, password, { name: row.name, memberId: row.id });
  }
  return out as People;
}

// ── Cleanup ──────────────────────────────────────────────────────────────

/**
 * What a scenario made, undone at its end (pass or fail), newest first. The
 * app never hard-deletes projects, tasks, agents or questions, so cleanup
 * leaves nothing live instead: projects in Trash, agents suspended, keys
 * revoked, open questions cancelled, chat connections removed.
 */
export class Cleanup {
  private steps: { what: string; run: () => Promise<unknown> }[] = [];
  add(what: string, run: () => Promise<unknown>): void {
    this.steps.push({ what, run });
  }
  async runAll(): Promise<string[]> {
    const failures: string[] = [];
    for (const item of this.steps.reverse()) {
      try {
        await item.run();
      } catch (error) {
        failures.push(`${item.what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.steps = [];
    return failures;
  }
}

/** Retires everything an agent made in a test: keys revoked, open questions cancelled, suspended. */
export async function retireAgent(db: Client, agentId: string): Promise<void> {
  await db.query(`UPDATE pm.api_keys SET revoked_at = now() WHERE team_member_id = $1 AND revoked_at IS NULL`, [agentId]);
  await db.query(`UPDATE pm.questions SET status = 'cancelled', cancelled_at = now() WHERE status = 'open' AND (asked_by = $1 OR asked_to = $1)`, [agentId]);
  await db.query(`UPDATE pm.team_members SET status = 'suspended' WHERE id = $1`, [agentId]);
}

export async function trashProject(db: Client, projectId: string): Promise<void> {
  await db.query(`UPDATE pm.questions SET status = 'cancelled', cancelled_at = now() WHERE status = 'open' AND project_id = $1`, [projectId]);
  await db.query(`UPDATE pm.projects SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [projectId]);
}

// ── Fixtures made through the app ────────────────────────────────────────

/** A personal key for a person, made in Settings > API keys (its secret once). */
export async function personalKey(ctx: Ctx, person: Person, scopes: string[], label: string): Promise<{ id: string; caller: KeyCaller }> {
  const made = dataOf(await person.post('/api/workspace/api-keys', { name: `E2E ${label} ${tag}`, scopes }), [200, 201], `${person.name} makes a key`);
  const secret = made.secret;
  const id = made.key?.id;
  check(typeof secret === 'string' && id, 'The new key answer has no secret or id', made);
  ctx.cleanup.add(`revoke key ${id}`, () => ctx.db.query(`UPDATE pm.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]));
  return { id, caller: new KeyCaller(ctx.baseUrl, secret, label) };
}

/** A project made over the API with the Owner's key, its members included; in Trash at cleanup. */
export async function makeProject(ctx: Ctx, ownerKey: KeyCaller, name: string, memberIds: string[] = []): Promise<{ id: string; name: string }> {
  const project = dataOf(await ownerKey.post('/api/v1/projects', { name: `E2E ${name} ${tag}`, member_ids: memberIds }), 201, `create project ${name}`);
  ctx.cleanup.add(`trash project ${project.id}`, () => trashProject(ctx.db, project.id));
  return { id: project.id, name: project.name };
}

/** The Owner's setup key: projects with their members, tasks, files and portals. */
export const OWNER_SETUP_SCOPES = [
  'projects.read', 'projects.manage', 'project_members.manage', 'tasks.read', 'tasks.create', 'tasks.manage_all',
  'files.read', 'files.upload', 'portal.read', 'portal.manage',
];

/** Hires an agent the way the Hire an agent screen does, with a key; retired at cleanup. */
export async function hire(ctx: Ctx, body: Record<string, unknown>): Promise<{ agent: Json; key: KeyCaller; keyId: string; result: Json }> {
  const result = dataOf(await ctx.people.owner.post('/api/workspace/agents', { create_key: true, request_id: randomUUID(), ...body }), 201, `hire ${String(body.name)}`);
  check(result.agent?.id, 'The hire answer has no agent', result);
  ctx.cleanup.add(`retire agent ${result.agent.id}`, () => retireAgent(ctx.db, result.agent.id));
  check(typeof result.key?.secret === 'string', 'The hire answer has no key secret', { ...result, key: result.key ? { ...result.key, secret: '<hidden>' } : null });
  return { agent: result.agent, key: new KeyCaller(ctx.baseUrl, result.key.secret, String(body.name)), keyId: result.key.id, result };
}

export function uuid(): string {
  return randomUUID();
}
