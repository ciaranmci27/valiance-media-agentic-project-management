import 'server-only';
import { NextRequest } from 'next/server';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';
import type { AccessContext } from '@/lib/access-control';
import { apiRequestContext } from '@/lib/api/request-context';
import type { CallRoute, RouteEnvelope, ToolOutcome } from './core';
import { toolDefinition } from './core';
import { apiKeyAllows } from '@/lib/api/access';
import { INBOX_TOOLS, PM_ACTING_FOR_GUIDE, PM_GUIDE, PM_INBOX_GUIDE, PM_SETUP_GUIDE, SETUP_TOOLS } from './guide';
import { routeHandler } from './handlers';
import type { AgentProfile } from './profiles';
import type { AgentProfileDefinition } from '@/lib/extensions/agent-profiles';
import { GUIDE_CONTEXT_PATH, GUIDE_TOOL } from './tools';
import { callableToolsFor, toolsFor } from './visibility';

export { callableToolsFor, toolsFor, toolVisible } from './visibility';

/** Who the key acts as, resolved by resolveApiKey for this request. */
export interface McpCaller {
  key: string;
  origin: string;
  access: AccessContext;
  scopes: string[];
  readOnly: boolean;
  member: { id: string; name: string; role: string };
  profile: AgentProfile;
  /** The profile as the server resolved it (an Owner's row included); null when no registry knows it. */
  profileDefinition?: AgentProfileDefinition | null;
  /** A checked X-Act-For token: every call acts for this person (principalId). */
  actFor?: string;
  principalId?: string;
  /** A Connect AI connection: key is its OAuth access token, which the in-process calls carry. */
  connection?: boolean;
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

/**
 * Runs one v1 route handler in this process as the caller's key, inside the
 * { via: 'mcp' } request context. withApi then checks the key, permission,
 * project/task/lead scope and rate limit, parses the body with the route's
 * own schema, and the route writes its audit row tagged via = mcp, exactly
 * as for REST.
 */
export function routeCaller(caller: Pick<McpCaller, 'key' | 'origin' | 'actFor' | 'connection'>): CallRoute {
  return async ({ method, path, params = {}, query, body, idempotencyKey }) => {
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
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await apiRequestContext.run({ via: 'mcp', actFor: caller.actFor ?? null, connection: caller.connection === true }, () => handler(
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
 * The caller's own context pack (GET /api/v1/agents/me/context, run as the
 * key like every tool), added to pm_guide as `context`: who it is, its rules
 * in plain words, scopes, projects, conventions and webhooks. The tool list
 * is left out because pm_guide already lists it. Null when the pack cannot be
 * read (an older database, a blip), so the guide itself never fails.
 */
async function guideContext(call: CallRoute): Promise<Record<string, unknown> | null> {
  try {
    const { status, envelope } = await call({ method: 'GET', path: GUIDE_CONTEXT_PATH, query: { format: 'pack' } });
    const pack = (envelope?.data as { pack?: unknown } | undefined)?.pack;
    if (status !== 200 || !envelope?.success || !pack || typeof pack !== 'object') return null;
    const { tools: _tools, ...rest } = pack as Record<string, unknown>;
    void _tools;
    return rest;
  } catch (failure) {
    console.error('[mcp] pm_guide context', failure);
    return null;
  }
}

/**
 * One server per HTTP request (the endpoint is stateless). The tool list is
 * the caller's, tools/call accepts only tools on it, and arguments are
 * checked against the tool's schema before any route runs.
 */
export function createPmServer(caller: McpCaller): Server {
  const tools = toolsFor(caller);
  // Deprecated tools are not listed, but a caller that still names one gets it.
  const byName = new Map(callableToolsFor(caller).map((tool) => [tool.name, tool]));
  const call = routeCaller(caller);
  const server = new Server(
    { name: 'project-management', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Project management for this workspace: projects, tasks, time, suggestions, leads. Call pm_guide first.',
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
        guide: [
          PM_GUIDE,
          ...(tools.some((t) => INBOX_TOOLS.includes(t.name)) ? [PM_INBOX_GUIDE] : []),
          ...(tools.some((t) => SETUP_TOOLS.includes(t.name)) ? [PM_SETUP_GUIDE] : []),
          ...(apiKeyAllows(caller.access, caller.scopes, 'agents.act_for') || caller.principalId ? [PM_ACTING_FOR_GUIDE] : []),
        ].join('\n\n'),
        you: {
          name: caller.member.name, role: caller.member.role, profile: caller.profile, read_only_key: caller.readOnly,
          ...(caller.principalId ? { acting_for: caller.principalId } : {}),
        },
        tools: tools.filter((t) => t.name !== GUIDE_TOOL).map((t) => t.name),
        context: await guideContext(call),
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
