import { NextResponse, type NextRequest } from 'next/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { ApiError } from '@/lib/api/errors';
import { resolveApiKey } from '@/lib/api/middleware';
import { isAgentProfile } from '@/lib/mcp/profiles';
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
 * Revoking the key closes both doors.
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

export async function POST(request: NextRequest) {
  if (foreignOrigin(request)) return rpcError(403, 'This origin may not call the PM MCP server.');
  const key = readKey(request);

  let caller: McpCaller;
  try {
    const { supabase, keyRow, access } = await resolveApiKey(key);
    const { data: member } = await supabase
      .from('team_members')
      .select('*')
      .eq('id', keyRow.team_member_id)
      .maybeSingle();
    caller = {
      key: key as string,
      origin: request.nextUrl.origin,
      access,
      scopes: Array.isArray(keyRow.scopes) ? keyRow.scopes : [],
      readOnly: keyRow.permissions === 'read_only',
      member: { id: keyRow.team_member_id, name: member?.name ?? 'Unknown', role: access.role },
      // Before the migration adds the column, every agent is generic.
      profile: isAgentProfile(member?.agent_profile) && access.role === 'agent' ? member.agent_profile : 'generic',
    };
  } catch (caught) {
    if (caught instanceof ApiError) return rpcError(caught.statusCode, caught.message, caught.details);
    console.error('[mcp] key', caught);
    return rpcError(500, 'Something went wrong on the server.', { reason: 'internal' });
  }

  return mcp.fetch(request, {
    authInfo: { token: caller.key, clientId: caller.member.id, scopes: caller.scopes, extra: { caller } },
  });
}

/** Stateless: there is no stream to open and no session to end. */
function methodNotAllowed() {
  return rpcError(405, 'Method not allowed. Send JSON-RPC with POST.', undefined, { Allow: 'POST' });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
