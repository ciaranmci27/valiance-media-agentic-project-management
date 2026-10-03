import 'server-only';
import { NextRequest } from 'next/server';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';
import type { AccessContext, PermissionKey } from '@/lib/access-control';
import { accessAllows } from '@/lib/api/access';
import { permissionAlternatives } from '@/lib/api/middleware';
import { apiRequestContext } from '@/lib/api/request-context';
import type { CallRoute, PmTool, RouteEnvelope, ToolOutcome } from './core';
import { toolDefinition } from './core';
import { PM_GUIDE } from './guide';
import { routeHandler } from './handlers';
import type { AgentProfile } from './profiles';
import { GUIDE_TOOL, PM_TOOLS } from './tools';

/** Who the key acts as, resolved by resolveApiKey for this request. */
export interface McpCaller {
  key: string;
  origin: string;
  access: AccessContext;
  scopes: string[];
  readOnly: boolean;
  member: { id: string; name: string; role: string };
  profile: AgentProfile;
}

/** Hermes spills larger results to disk; reads over this are refused with a hint. */
export const MAX_RESULT_CHARS = 40_000;

/**
 * 403s that mean the key itself cannot do this, now or on a retry. Anything
 * else forbidden (a project, task or lead outside the member's reach) is the
 * agent's choice of target, which it can change, so it comes back as an
 * ordinary result: Hermes opens a circuit breaker after three error results
 * in a row, which should take a bad key or an outage, not a wrong id.
 */
const FATAL_FORBIDDEN = new Set([
  'missing_key_scope',
  'missing_member_permission',
  'missing_key_scope_and_member_permission',
  'member_suspended',
  'api_disabled',
  'read_only_key',
]);

function payloadResult(payload: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

export function refusal(status: number, code: string, message: string, details: unknown = {}): CallToolResult {
  const extra = Array.isArray(details) ? { issues: details } : (details ?? {}) as Record<string, unknown>;
  const fatal = status === 401 || status === 429 || status >= 500
    || (status === 403 && FATAL_FORBIDDEN.has(String(extra.reason)));
  return payloadResult({ ok: false, status, error: { code, message, ...extra } }, fatal);
}

/** Whether a key sees a tool: its profile, its read-only flag, and the permission on key AND member. */
export function toolVisible(tool: PmTool, caller: Pick<McpCaller, 'access' | 'scopes' | 'readOnly' | 'profile'>): boolean {
  if (tool.profiles && !tool.profiles.includes(caller.profile)) return false;
  if (tool.agentsOnly && caller.access.role !== 'agent') return false;
  if (tool.write && caller.readOnly) return false;
  if (tool.name === GUIDE_TOOL) return true;
  const wanted = (Array.isArray(tool.permission) ? tool.permission : [tool.permission])
    .flatMap((permission: PermissionKey) => permissionAlternatives(permission));
  return wanted.some((permission) => caller.scopes.includes(permission) && accessAllows(caller.access, permission, 'api'));
}

export function toolsFor(caller: Pick<McpCaller, 'access' | 'scopes' | 'readOnly' | 'profile'>): PmTool[] {
  return PM_TOOLS.filter((tool) => toolVisible(tool, caller));
}

/**
 * Runs one v1 route handler in this process as the caller's key, inside the
 * { via: 'mcp' } request context. withApi then checks the key, permission,
 * project/task/lead scope and rate limit, parses the body with the route's
 * own schema, and the route writes its audit row tagged via = mcp, exactly
 * as for REST.
 */
export function routeCaller(caller: Pick<McpCaller, 'key' | 'origin'>): CallRoute {
  return async ({ method, path, params = {}, query, body }) => {
    const handler = routeHandler(path, method);
    if (!handler) return { status: 500, envelope: { success: false, error: { code: 'INTERNAL_ERROR', message: `No handler for ${method} ${path}` } } };
    const concrete = path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      search.set(name, String(value));
    }
    const headers: Record<string, string> = { 'x-api-key': caller.key };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await apiRequestContext.run({ via: 'mcp' }, () => handler(
      new NextRequest(`${caller.origin}${concrete}${search.size ? `?${search}` : ''}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      { params: Promise.resolve(params) },
    ));
    const envelope = (await response.json().catch(() => null)) as RouteEnvelope | null;
    return { status: response.status, envelope };
  };
}

export function outcomeResult(outcome: ToolOutcome, write: boolean, maxChars = MAX_RESULT_CHARS): CallToolResult {
  if (outcome.kind === 'payload') return payloadResult(outcome.payload, outcome.payload.ok === false);
  const { status, envelope } = outcome.result;
  if (status >= 400 || !envelope?.success) {
    const error = envelope?.error;
    return refusal(status >= 400 ? status : 500, error?.code ?? 'INTERNAL_ERROR', error?.message ?? 'Something went wrong on the server.', error?.details);
  }
  const data = outcome.present ? outcome.present(envelope.data, envelope.meta) : envelope.data;
  const payload: Record<string, unknown> = { ok: true, data, ...(envelope.meta ? { meta: envelope.meta } : {}) };
  // Writes always report what happened; only reads, which can be narrowed,
  // are refused for size.
  if (!write && JSON.stringify(payload).length > maxChars) {
    return refusal(413, 'RESULT_TOO_LARGE', `The answer is over ${maxChars.toLocaleString('en-US')} characters.`, {
      reason: 'result_too_large',
      hint: 'Narrow it: filter by project or status, or page with a smaller limit.',
    });
  }
  return payloadResult(payload);
}

/**
 * One server per HTTP request (the endpoint is stateless). The tool list is
 * the caller's, tools/call accepts only tools on it, and arguments are
 * checked against the tool's schema before any route runs.
 */
export function createPmServer(caller: McpCaller): Server {
  const tools = toolsFor(caller);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const call = routeCaller(caller);
  const server = new Server(
    { name: 'valiance-pm', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Valiance Media project management: projects, tasks, time, suggestions, leads. Call pm_guide first.',
    },
  );

  server.setRequestHandler('tools/list', async () => ({ tools: tools.map(toolDefinition) }));

  server.setRequestHandler('tools/call', async (request) => {
    const name = request.params.name;
    const tool = byName.get(name);
    const raw = request.params.arguments;
    let result: CallToolResult;
    if (!tool) {
      result = refusal(404, 'NOT_FOUND', `No tool named ${name} for this key.`, {
        reason: 'unknown_tool',
        hint: "List the tools again; your key's scopes and your agent profile decide which you can use.",
      });
    } else if (tool.name === GUIDE_TOOL) {
      result = payloadResult({
        ok: true,
        guide: PM_GUIDE,
        you: { name: caller.member.name, role: caller.member.role, profile: caller.profile, read_only_key: caller.readOnly },
        tools: tools.filter((t) => t.name !== GUIDE_TOOL).map((t) => t.name),
      });
    } else {
      const parsed = tool.input.safeParse(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
      if (!parsed.success) {
        result = refusal(422, 'VALIDATION_ERROR', 'Check the arguments.', {
          reason: 'invalid_arguments',
          issues: parsed.error.issues.map((issue) => ({
            argument: issue.path.join('.') || (issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : ''),
            message: issue.message,
          })),
        });
      } else {
        result = await tool.run(parsed.data as Record<string, unknown>, call, { memberId: caller.member.id })
          .then((outcome) => outcomeResult(outcome, tool.write))
          .catch((failure: unknown) => {
            console.error(`[mcp] ${name}`, failure);
            return refusal(500, 'INTERNAL_ERROR', 'Something went wrong on the server.', { reason: 'internal' });
          });
      }
    }
    return server.projectCallToolResult(result, undefined);
  });

  return server;
}
