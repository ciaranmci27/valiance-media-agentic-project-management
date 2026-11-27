/**
 * One database for every parity area (test:api-parity): the whole real
 * schema in PGlite behind fake-postgrest, the real v1 route handlers (withApi,
 * real supabase-js) and the real MCP server, run as the service role the way
 * production runs them. The service client is cached per process, so the
 * areas share this one database and each seeds its own rows.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { startFakePostgrest, type ExtraHandler } from '../fake-postgrest';
import { FakeStorage } from '../inbound-email-fixtures';
import { createFullSchemaDatabase } from '../full-schema-db';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are read loosely in checks
export type Json = { success?: boolean; data?: any; meta?: any; error?: { code: string; message: string; details?: any } };
// Params typed never, so a route with typed params ({ id }) is a Handler too; call() hands them in as given.
export type Handler = (request: NextRequest, context: { params: Promise<never> }) => Promise<Response>;

export interface Members {
  owner: string;
  admin: string;
  member: string;
  /** A company agent (role agent, no person). */
  agent: string;
  /** The member's personal agent (delegate_of member). */
  personal: string;
}

export interface Harness {
  db: PGlite;
  members: Members;
  ownerUser: string;
  memberUser: string;
  q: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** A live key for a member with these scopes (secret answered). */
  key: (memberId: string, scopes: string[], options?: { readOnly?: boolean }) => Promise<string>;
  /** Calls a v1 handler as a key. */
  call: (handler: Handler, key: string, method: string, path: string, params?: Record<string, string>, body?: unknown) => Promise<{ status: number; json: Json }>;
  /** Calls a tool over the real MCP server as a key; answers the tool's structured content and whether it was listed. */
  tool: (key: string, name: string, args: Record<string, unknown>) => Promise<{ listed: boolean; result: Json & { ok?: boolean; status?: number } }>;
  /** Tool names a key sees in tools/list. */
  toolNames: (key: string) => Promise<string[]>;
  check: (label: string, ok: boolean, detail?: unknown) => void;
  /** Supabase Storage behind the same server (uploads land in storage.objects). */
  storage: FakeStorage;
  /** An area's stand-in for Supabase Auth (/auth/v1/...), or null for none. */
  setAuth: (handler: ExtraHandler | null) => void;
}

const hash = (key: string) => createHash('sha256').update(key).digest('hex');
export const OWNER_USER = '00000000-0000-0000-0000-00000000c0a1';
export const ADMIN_USER = '00000000-0000-0000-0000-00000000c0a2';
export const MEMBER_USER = '00000000-0000-0000-0000-00000000c0a3';

export async function createHarness(check: Harness['check']): Promise<Harness & { close: () => Promise<void> }> {
  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  // Rate limiting is not under test here (the other API suites stub it the same way).
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)',
    [OWNER_USER, 'owner@example.com', ADMIN_USER, 'admin@example.com', MEMBER_USER, 'member@example.com']);
  const rows = (await db.query<{ id: string; auth_user_id: string }>('SELECT id, auth_user_id FROM pm.team_members')).rows;
  const byUser = (user: string) => rows.find((m) => m.auth_user_id === user)!.id;
  const owner = byUser(OWNER_USER);
  const admin = byUser(ADMIN_USER);
  const member = byUser(MEMBER_USER);
  await db.query("UPDATE pm.team_members SET role = 'owner', name = 'Olive Owner' WHERE id = $1", [owner]);
  await db.query("UPDATE pm.team_members SET role = 'admin', name = 'Ada Admin' WHERE id = $1", [admin]);
  await db.query("UPDATE pm.team_members SET role = 'member', name = 'Max Member' WHERE id = $1", [member]);
  const agent = (await db.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Alexa', 'alexa@agents.invalid', 'agent') RETURNING id")).rows[0].id;
  const personal = (await db.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template) VALUES ('Max''s Assistant', 'max-assistant@agents.invalid', 'agent', $1, 'personal-assistant') RETURNING id", [member])).rows[0].id;

  const storage = new FakeStorage();
  let auth: ExtraHandler | null = null;
  const server = await startFakePostgrest(db, {
    handle: async (request, response, url) => (auth && url.pathname.startsWith('/auth/v1/') ? auth(request, response, url) : storage.handler(request, response, url)),
  });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  // New webhook signing secrets are only stored encrypted (lib/webhooks/secret.ts).
  process.env.APP_ENCRYPTION_KEY = 'e'.repeat(64);

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  const key = async (memberId: string, scopes: string[], options: { readOnly?: boolean } = {}) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Test key', 'pk_live', $1, $2, $3, $4)`, [hash(secret), memberId, scopes, options.readOnly ? 'read_only' : 'scoped']);
    return secret;
  };
  const call: Harness['call'] = async (handler, secret, method, path, params = {}, body) => {
    const response = await handler(new NextRequest(`http://localhost${path}`, {
      method,
      headers: { 'x-api-key': secret, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { params: Promise.resolve(params) as Promise<never> });
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : {}) as Json };
  };

  const mcpRoute = await import('../../src/app/api/mcp/route');
  let rpcId = 100;
  const rpc = async (secret: string, method: string, params: unknown) => {
    const response = await mcpRoute.POST(new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': secret },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    }));
    const text = await response.text();
    return JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text);
  };
  const toolNames = async (secret: string) => ((await rpc(secret, 'tools/list', {})).result?.tools ?? []).map((t: { name: string }) => t.name) as string[];
  const tool: Harness['tool'] = async (secret, name, args) => {
    const listed = (await toolNames(secret)).includes(name);
    const answer = await rpc(secret, 'tools/call', { name, arguments: args });
    return { listed, result: answer.result?.structuredContent ?? answer.error ?? answer };
  };

  return {
    db, members: { owner, admin, member, agent, personal }, ownerUser: OWNER_USER, memberUser: MEMBER_USER,
    q, key, call, tool, toolNames, check, storage, setAuth: (handler) => { auth = handler; },
    close: async () => { await server.close?.(); await db.close(); },
  };
}
