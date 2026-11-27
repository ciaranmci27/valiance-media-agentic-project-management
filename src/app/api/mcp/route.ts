import { NextResponse, type NextRequest } from 'next/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { ApiError } from '@/lib/api/errors';
import { MCP_BODY_LIMIT, assertDeclaredBodySize, readBodyText } from '@/lib/api/body-limit';
import { resolveApiKey } from '@/lib/api/middleware';
import { resolveAgentProfile } from '@/lib/api/agent-registries';
import { bearerChallenge } from '@/lib/api/connect-ai';
import { isConnectAccessToken } from '@/lib/connect-ai';
import { ACT_FOR_HEADER } from '@/lib/delegation';
import { createPmServer, type McpCaller } from '@/lib/mcp/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The PM MCP server: Streamable HTTP, stateless, JSON responses. It serves
 * the 2026-07-28 protocol and the older initialize handshake (which Hermes
 * still sends) from one server definition.
 *
 * Authentication is the v1 API key in x-api-key (or Authorization: Bearer).
 * The key, the member's permissions and the member's agent profile decide
 * which tools are listed; every tool call runs v1 route handlers as that key,
 * so permissions, project scope, rate limit and the audit log are REST's.
 * Revoking the key closes both doors. An X-Act-For header (a delegation
 * token) makes every call act for that person, within their access: the tool
 * list is the agent's and the person's together, and each call carries the
 * token on to its route.
 *
 * Connect AI: a person's AI tool signs in with OAuth and sends its access
 * token as Authorization: Bearer pmat_... The token stands for its
 * connection's key (the connect scopes only) and the person's own access, so
 * the tools listed and every call are theirs, and audit rows say mcp_oauth.
 * A 401 carries the WWW-Authenticate challenge naming the protected resource
 * metadata, so a tool given only this address finds where to sign in.
 */
const mcp = createMcpHandler(
  ({ authInfo }) => createPmServer(authInfo?.extra?.caller as McpCaller),
  {
    legacy: 'stateless',
    responseMode: 'json',
    onerror: (error) => console.error('[mcp]', error.message),
  },
);

function rpcError(status: number, message: string, data?: unknown, headers: Record<string, string> = {}) {
  return NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: -32001, message, ...(data ? { data } : {}) } },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } },
  );
}

function readKey(request: NextRequest): string | null {
  const header = request.headers.get('x-api-key')?.trim();
  if (header) return header;
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
}

/** Browsers send Origin; server clients such as Hermes do not. A foreign one is refused. */
function foreignOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.nextUrl.host;
  } catch {
    return true;
  }
}

/** A 401 with the challenge: error="invalid_token" when a sign-in token came and is not live. */
function unauthorizedRpc(request: NextRequest, message: string, data: unknown, tokenSent: boolean) {
  const challenge = bearerChallenge(request.nextUrl.origin, tokenSent ? { code: 'invalid_token', description: message } : undefined);
  return rpcError(401, message, data, { 'WWW-Authenticate': challenge });
}

export async function POST(request: NextRequest) {
  if (foreignOrigin(request)) return rpcError(403, 'This origin may not call the PM MCP server.');
  // A body that says it is too large is refused before the key is looked up.
  try {
    assertDeclaredBodySize(request.headers, MCP_BODY_LIMIT);
  } catch (caught) {
    if (caught instanceof ApiError) return rpcError(caught.statusCode, caught.message, caught.details);
    throw caught;
  }
  const key = readKey(request);
  const connect = isConnectAccessToken(key);
  if (!key) {
    return unauthorizedRpc(request, 'Sign in to use this MCP server: connect your AI tool, or send an API key in x-api-key.', { reason: 'missing_api_key' }, false);
  }

  let caller: McpCaller;
  try {
    const actFor = request.headers.get(ACT_FOR_HEADER);
    const { supabase, keyRow, access, principal, connection, aiSetup } = await resolveApiKey(key, actFor, { connect: true });
    const { data: member } = await supabase
      .from('team_members')
      .select('*')
      .eq('id', keyRow.team_member_id)
      .maybeSingle();
    const profile = access.role === 'agent' && typeof member?.agent_profile === 'string' ? member.agent_profile : 'generic';
    caller = {
      key: key as string,
      origin: request.nextUrl.origin,
      signal: request.signal,
      access,
      scopes: Array.isArray(keyRow.scopes) ? keyRow.scopes : [],
      readOnly: keyRow.permissions === 'read_only',
      member: { id: keyRow.team_member_id, name: member?.name ?? 'Unknown', role: access.role },
      // Before the migration adds the column, every agent is generic. A stored
      // profile the registry does not know is kept, and sees only pm_guide.
      profile,
      // An Owner's row, or code's (no read); null for a value nothing knows (pm_guide only).
      profileDefinition: await resolveAgentProfile(supabase, profile),
      ...(principal && actFor ? { actFor, principalId: principal.id } : {}),
      ...(connection ? { connection: true } : {}),
      ...(aiSetup ? { aiSetup: { scopes: aiSetup.scopes, only: aiSetup.kind === 'key', clientName: aiSetup.clientName, expiresAt: aiSetup.expiresAt } } : {}),
    };
  } catch (caught) {
    if (caught instanceof ApiError && caught.statusCode === 401) return unauthorizedRpc(request, caught.message, caught.details, connect);
    if (caught instanceof ApiError) return rpcError(caught.statusCode, caught.message, caught.details);
    console.error('[mcp] key', caught);
    return rpcError(500, 'Something went wrong on the server.', { reason: 'internal' });
  }

  // The body is read here, never past MCP_BODY_LIMIT (a chunked body has no
  // length to check), and handed on as text.
  let bounded: Request;
  try {
    const text = await readBodyText(request, MCP_BODY_LIMIT);
    bounded = new Request(request.url, { method: request.method, headers: request.headers, body: text });
  } catch (caught) {
    if (caught instanceof ApiError) return rpcError(caught.statusCode, caught.message, caught.details);
    throw caught;
  }

  return mcp.fetch(bounded, {
    authInfo: { token: caller.key, clientId: caller.member.id, scopes: caller.scopes, extra: { caller } },
  });
}

/** Stateless: there is no stream to open and no session to end. */
function methodNotAllowed() {
  return rpcError(405, 'Method not allowed. Send JSON-RPC with POST.', undefined, { Allow: 'POST' });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
