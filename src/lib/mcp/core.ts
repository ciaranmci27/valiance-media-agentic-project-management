import { z } from 'zod';
import type { PermissionKey } from '@/lib/access-control';
import type { ModuleId } from '@/lib/modules/registry';
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
  /** Sent as the Idempotency-Key header, so a retried POST runs once (withApi). */
  idempotencyKey?: string;
}

/**
 * The optional argument create-type tools take: the same value on a retry
 * returns the first answer instead of creating a second record. It shares
 * the REST store (Idempotency-Key), keyed by the API key and route.
 */
export const IDEMPOTENCY_KEY_ARGUMENT = 'idempotency_key';
export const idempotencyKeyInput = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'Use visible ASCII characters only, such as a UUID')
  .optional()
  .describe('A unique value for this request, such as a UUID. Retry with the same value and you get the first answer back instead of a duplicate (24 hours)');

export interface RouteEnvelope {
  success?: boolean;
  data?: unknown;
  meta?: Record<string, unknown>;
  error?: { code?: string; message?: string; details?: unknown };
}

export interface RouteResult {
  status: number;
  envelope: RouteEnvelope | null;
  /** A 429's Retry-After, in seconds. */
  retryAfter?: number;
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
  /**
   * Every one of these too, for a route that checks a second permission
   * itself (a task made from an email needs tasks.create and
   * inbound_email.triage), so the tool is listed only when the call can pass.
   */
  requires?: readonly PermissionKey[];
  /** The v1 routes the tool calls, for the drift check and the docs. */
  routes: Array<{ method: HttpMethod; path: string }>;
  write: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /** Profiles that see this tool. Every profile sees the generic set today. */
  profiles?: readonly AgentProfile[];
  /** The route refuses members who are not agents, so only agents see it. */
  agentsOnly?: boolean;
  /** The route serves only a person's own agent (access.principal_id), so only it sees the tool. */
  personalOnly?: boolean;
  /**
   * Chat: a person's own agent, or a company agent (one that may act for
   * people, agents.act_for on key and member, as every agent a company chat
   * connection reaches must). Other agents never see it.
   */
  chatAgentsOnly?: boolean;
  /**
   * A person's own decision (marking an Inbox conversation handled, a plan
   * item accepted): only a person's own key or connected AI tool acting as
   * them. Agents, company or personal, never see it, and its route refuses
   * them (403 people_only, lib/api/people-only.ts).
   */
  peopleOnly?: boolean;
  /**
   * A module the tool needs beyond its permission's own, for a tool whose
   * permission is core but whose route belongs to a module. Switched off, the
   * tool is not listed.
   */
  module?: ModuleId;
  /**
   * A tool on its way out: left off tools/list, the catalog and the context
   * pack, so new callers never build on it, but still callable by name (for
   * a key that may use it) until it is removed. See docs/agents/README.md,
   * "Compatibility".
   */
  deprecated?: ToolDeprecation;
  run: (args: Record<string, unknown>, call: CallRoute, context: ToolContext) => Promise<ToolOutcome>;
}

export interface ToolDeprecation {
  /** What to use instead. */
  replacement: string;
  /** When it goes. */
  removal: string;
}

/** A tool that is exactly one v1 call. */
export function routeTool<I extends z.ZodObject>(config: {
  name: string;
  lead: string;
  detail: string;
  input: I;
  permission: PermissionKey | PermissionKey[];
  requires?: readonly PermissionKey[];
  method: HttpMethod;
  path: string;
  destructive?: boolean;
  idempotent?: boolean;
  profiles?: readonly AgentProfile[];
  agentsOnly?: boolean;
  personalOnly?: boolean;
  chatAgentsOnly?: boolean;
  peopleOnly?: boolean;
  module?: ModuleId;
  deprecated?: ToolDeprecation;
  /**
   * Where idempotency_key goes: the Idempotency-Key header (default), or the
   * body, for a route with its own key in its body schema (triage and plans,
   * whose replay also finishes interrupted work). Then it stays in the args.
   */
  idempotencyKeyIn?: 'header' | 'body';
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
    requires: config.requires,
    routes: [{ method: config.method, path: config.path }],
    write,
    destructive: config.destructive ?? (config.method === 'DELETE' || config.method === 'PATCH' || config.method === 'PUT'),
    idempotent: config.idempotent ?? (config.method !== 'POST'),
    profiles: config.profiles,
    agentsOnly: config.agentsOnly,
    personalOnly: config.personalOnly,
    chatAgentsOnly: config.chatAgentsOnly,
    peopleOnly: config.peopleOnly,
    module: config.module,
    deprecated: config.deprecated,
    run: async (args, call, context) => {
      if (config.idempotencyKeyIn === 'body') {
        return { kind: 'route', result: await call({ method: config.method, path: config.path, ...config.request(args as z.infer<I>, context) }), present: config.present };
      }
      // idempotency_key is the call's, never the route's body or query.
      const { [IDEMPOTENCY_KEY_ARGUMENT]: idempotencyKey, ...rest } = args;
      return {
        kind: 'route',
        result: await call({
          method: config.method,
          path: config.path,
          ...config.request(rest as z.infer<I>, context),
          ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
        }),
        present: config.present,
      };
    },
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
