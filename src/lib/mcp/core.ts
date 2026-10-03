import { z } from 'zod';
import type { PermissionKey } from '@/lib/access-control';
import type { AgentProfile } from './profiles';

/**
 * The PM MCP server's building blocks, free of server code so the docs page
 * can list the tools. A tool never decides who may do what: it names the v1
 * route(s) it calls, and every call runs that route's own handler through
 * withApi as the caller's key. The `permission` here only decides whether a
 * key sees the tool; if it were wrong, withApi would still refuse the call.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One in-process v1 call: a route template such as /api/v1/tasks/{id}. */
export interface RouteCall {
  method: HttpMethod;
  path: string;
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

export interface RouteEnvelope {
  success?: boolean;
  data?: unknown;
  meta?: Record<string, unknown>;
  error?: { code?: string; message?: string; details?: unknown };
}

export interface RouteResult {
  status: number;
  envelope: RouteEnvelope | null;
}

export type CallRoute = (call: RouteCall) => Promise<RouteResult>;

/** Facts about the caller a tool may need to fill in, never to authorize. */
export interface ToolContext {
  /** The key's member: routes that require a member id in the body get this one. */
  memberId: string;
}

/** What a tool hands back: a v1 answer to map, or a finished payload. */
export type ToolOutcome =
  | { kind: 'route'; result: RouteResult; present?: (data: unknown, meta?: Record<string, unknown>) => unknown }
  | { kind: 'payload'; payload: Record<string, unknown> };

export interface PmTool {
  name: string;
  /** One sentence of 60 characters or fewer; Hermes shows it with the name. */
  lead: string;
  /** What follows the lead: when to use it, what it returns, its limits. */
  detail: string;
  /** Strict input; arguments are checked here before any route runs. */
  input: z.ZodObject;
  /** Any of these (with the permissions that imply them) makes the tool visible. */
  permission: PermissionKey | PermissionKey[];
  /** The v1 routes the tool calls, for the drift check and the docs. */
  routes: Array<{ method: HttpMethod; path: string }>;
  write: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /** Profiles that see this tool. Every profile sees the generic set today. */
  profiles?: readonly AgentProfile[];
  /** The route refuses members who are not agents, so only agents see it. */
  agentsOnly?: boolean;
  run: (args: Record<string, unknown>, call: CallRoute, context: ToolContext) => Promise<ToolOutcome>;
}

/** A tool that is exactly one v1 call. */
export function routeTool<I extends z.ZodObject>(config: {
  name: string;
  lead: string;
  detail: string;
  input: I;
  permission: PermissionKey | PermissionKey[];
  method: HttpMethod;
  path: string;
  destructive?: boolean;
  idempotent?: boolean;
  profiles?: readonly AgentProfile[];
  agentsOnly?: boolean;
  request: (args: z.infer<I>, context: ToolContext) => Omit<RouteCall, 'method' | 'path'>;
  present?: (data: unknown, meta?: Record<string, unknown>) => unknown;
}): PmTool {
  const write = config.method !== 'GET';
  return {
    name: config.name,
    lead: config.lead,
    detail: config.detail,
    input: config.input,
    permission: config.permission,
    routes: [{ method: config.method, path: config.path }],
    write,
    destructive: config.destructive ?? (config.method === 'DELETE' || config.method === 'PATCH' || config.method === 'PUT'),
    idempotent: config.idempotent ?? (config.method !== 'POST'),
    profiles: config.profiles,
    agentsOnly: config.agentsOnly,
    run: async (args, call, context) => ({
      kind: 'route',
      result: await call({ method: config.method, path: config.path, ...config.request(args as z.infer<I>, context) }),
      present: config.present,
    }),
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: 'object' };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export function toolDefinition(tool: PmTool): McpToolDefinition {
  const json = z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return {
    name: tool.name,
    description: `${tool.lead} ${tool.detail}`,
    inputSchema: { ...json, type: 'object', additionalProperties: false },
    annotations: {
      readOnlyHint: !tool.write,
      destructiveHint: tool.write && !!tool.destructive,
      idempotentHint: !tool.write || !!tool.idempotent,
      openWorldHint: false,
    },
  };
}
