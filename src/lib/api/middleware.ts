import { NextRequest } from 'next/server';
import { ZodSchema, ZodError } from 'zod';
import { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled, PERMISSION_IMPLIED_BY, type AccessContext, type PermissionKey } from '@/lib/access-control';
import { getActorClient, getServiceClient } from './supabase-service';
import { hashApiKey } from './crypto';
import { assertBadKeyBudget, noteBadKey, trustedClientIp } from './bad-key-limit';
import { passRequestGate, pausedRefusal, projectPausedRefusal, pauseExempt, type RequestGate } from './request-gate';
import { writeGateRefusal } from './write-gate';
import { ApiError, unauthorized, forbidden, tooManyRequests, badRequest, notFound, moduleOff } from './errors';
import { errorResponse } from './response';
import { JSON_BODY_LIMIT, assertDeclaredBodySize, readBodyText } from './body-limit';
import { accessAllows, accessAllowsProject, moduleOffFor, resolveMemberAccess } from './access';
import { apiRequestContext } from './request-context';
import { verifyActFor } from './delegation';
import { resolveConnection, type ConnectionContext } from './connect-ai';
import { isConnectAccessToken } from '@/lib/connect-ai';
import { aiSetupRoute, isAiSetupKey } from '@/lib/ai-setup';
import { assertAiSetupCall, connectionSetupGrant, keySetupGrant, type AiSetupGrant } from './ai-setup';
import { ACT_FOR_HEADER } from '@/lib/delegation';
import { liveTaskIds } from './task-guards';
import { afterResponse } from './after-response';
import { kickWebhooks } from '@/lib/webhooks/kick';
import { API_VERSION, API_VERSION_HEADER } from './version';
import { BODY_DEPTH_MAX, bodyProblem } from '@/lib/schemas/shared';
import { missingPauseColumns, successorPaused } from './key-manage';
import {
  claimIdempotencyKey,
  finishIdempotencyKey,
  idempotencyKeyFrom,
  idempotencyRequestHash,
  releaseIdempotencyKey,
  type IdempotencyClaim,
} from './idempotency';

/** Static routes under /api/v1/tasks/ that are not a task id. */
export const TASK_COLLECTION_ACTIONS: ReadonlySet<string> = new Set(['reorder', 'next']);

/** Whole seconds until `resetAt` (ms), at least 1; a minute when unknown. */
function retryAfterSeconds(resetAt: number | null): string {
  if (resetAt === null || !Number.isFinite(resetAt)) return '60';
  return String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
}

/** Every answer withApi gives: the contract version (lib/api/version.ts), and the rate limit once it is known. */
function applyRateLimitHeaders(
  response: Response,
  rateInfo: { remaining: number; resetAt: number; limit: number } | null,
): Response {
  response.headers.set(API_VERSION_HEADER, API_VERSION);
  // Every 429 says when to come back: its own window if it named one, else the key's.
  if (response.status === 429 && !response.headers.has('Retry-After')) {
    response.headers.set('Retry-After', retryAfterSeconds(rateInfo?.resetAt ?? null));
  }
  if (rateInfo) {
    response.headers.set('X-RateLimit-Limit', String(rateInfo.limit));
    response.headers.set('X-RateLimit-Remaining', String(rateInfo.remaining));
    response.headers.set('X-RateLimit-Reset', String(Math.ceil(rateInfo.resetAt / 1000)));
  }
  return response;
}

export interface ApiContext<TBody = unknown, TParams = Record<string, string>> {
  supabase: SupabaseClient;
  params: TParams;
  body: TBody;
  searchParams: URLSearchParams;
  apiKeyId: string;
  permissions: string;
  teamMemberId: string;
  access: AccessContext;
  scopes: string[];
  /** The person the key's agent acts for (a checked X-Act-For token), or null. */
  principalId: string | null;
  /** This request's origin, for links the answer carries (NEXT_PUBLIC_APP_URL wins where it is set). */
  origin: string;
  /** Aborted when the caller goes away: a long-poll wait (lib/api/long-poll.ts) ends early on it. */
  signal: AbortSignal;
}

/** The one answer for a task that is missing, in Trash, or in a project out of reach. */
export function taskNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Task not found. It may be in Trash.', { reason: 'not_found_or_in_trash', resource: 'task' });
}

interface WithApiOptions<TBody> {
  schema?: ZodSchema<TBody>;
  /** An empty request body is read as {} instead of refused (for optional fields). */
  optionalBody?: boolean;
  /**
   * What the API key and its member must hold (or a permission that implies
   * it; any one of a list). Every route names it: nothing is inferred from the
   * path. withApi has no opt-out: every call needs a key. A public or
   * signed-in route is not a withApi route (custom routes: auth 'public' or
   * 'session' in src/custom/api.ts).
   */
  permission: PermissionKey | PermissionKey[];
  /**
   * The answer holds a secret shown once (a new API key, a webhook signing
   * secret). Such a POST refuses an Idempotency-Key: a stored answer would
   * keep the secret in the database and hand it out again on a retry.
   */
  returnsSecret?: boolean;
  /**
   * A PATCH that also takes Idempotency-Key, as every POST does: a retry
   * with the same key and body gets the first answer back (task templates).
   */
  idempotentPatch?: boolean;
  /**
   * Also accepts a Connect AI access token in Authorization: Bearer (the
   * tool catalog). Elsewhere a connection's token works only through the
   * MCP server, the one resource it is issued for.
   */
  acceptsConnection?: boolean;
  /**
   * The largest body this route reads, in bytes (default JSON_BODY_LIMIT,
   * 1 MB). Larger bodies answer 413 PAYLOAD_TOO_LARGE before they are parsed.
   * Only routes that carry a file inline raise it (FILE_BODY_LIMIT).
   */
  maxBodyBytes?: number;
}

type HandlerFn<TBody, TParams> = (ctx: ApiContext<TBody, TParams>) => Promise<Response>;

/** A permission plus the broader ones that imply it, as withApi accepts them (PERMISSION_IMPLIED_BY). */
export function permissionAlternatives(permission: PermissionKey): PermissionKey[] {
  return [permission, ...(PERMISSION_IMPLIED_BY[permission] || [])];
}

export interface ApiKeyRow {
  id: string;
  permissions: string;
  team_member_id: string;
  scopes: string[] | null;
  expires_at: string | null;
  disabled_at: string | null;
}

export interface ResolvedApiKey {
  supabase: SupabaseClient;
  keyRow: ApiKeyRow;
  /** With an X-Act-For token: the agent's and the person's access together. */
  access: AccessContext;
  /**
   * Set when a valid X-Act-For token came with the key (tokenId), and always
   * for a personal agent's key: the person it works for (tokenId null when
   * no token came).
   */
  principal: { id: string; tokenId: string | null; personal: boolean } | null;
  /** Set when a Connect AI access token made the request: the person's own connection. */
  connection?: ConnectionContext | null;
  /**
   * An AI setup session behind the request (lib/ai-setup.ts): a connection
   * elevated for an hour, or a setup key. withApi applies it on the setup
   * routes only; a setup key is refused everywhere else.
   */
  aiSetup?: AiSetupGrant | null;
}

export interface ResolveApiKeyOptions {
  /**
   * Accept a Connect AI access token (pmat_...). Only the MCP route, its
   * in-process calls and routes that opt in (acceptsConnection) do: anywhere
   * else such a token is 401 connect_token_not_accepted.
   */
  connect?: boolean;
  /**
   * The caller's trusted address (trustedClientIp). An address that sent
   * too many keys matching nothing lately is answered 429 before the
   * lookup (lib/api/bad-key-limit.ts); null counts nothing.
   */
  clientIp?: string | null;
}

/**
 * Who an API key acts as: the key must exist, be live and linked, the
 * workspace API must be on and the member active. Throws the same ApiErrors
 * every v1 route answers with. It does not count toward the rate limit and
 * checks no permission; withApi does both per request. The MCP server uses it
 * to decide which tools a key sees.
 *
 * With actFor (the X-Act-For header) the key's agent acts for a person: the
 * token must be live and the agent's own (else 401 act_for_invalid), and the
 * access answered is the agent's and the person's together. Without it,
 * nothing changes.
 *
 * A personal agent (team_members.delegate_of) always acts for its person:
 * resolveMemberAccess answers its access and theirs together, and the person
 * is the principal with or without the header. A token it sends must name
 * that same person (else 403 delegate_only).
 */
export async function resolveApiKey(apiKey: string | null, actFor: string | null = null, options: ResolveApiKeyOptions = {}): Promise<ResolvedApiKey> {
  if (!apiKey) throw unauthorized('Missing x-api-key header', { reason: 'missing_api_key' });
  const clientIp = options.clientIp ?? null;
  // Before any lookup: an address flooding wrong keys never reaches the database.
  assertBadKeyBudget(clientIp);
  if (isConnectAccessToken(apiKey)) {
    if (!options.connect) {
      throw unauthorized("A connected AI tool's sign-in works only on the MCP server", {
        reason: 'connect_token_not_accepted',
        hint: 'Call the MCP server with this token, or use an API key here.',
      });
    }
    // A connection is the person themselves: there is nobody else to act for.
    if (actFor !== null) {
      throw forbidden('This is not available while acting for someone', { reason: 'act_for_not_allowed', hint: 'A connected AI tool already acts as its person. Send the request without X-Act-For.' });
    }
    const service = getServiceClient();
    const resolved = await resolveConnection(service, apiKey).catch((error: unknown) => {
      if (error instanceof ApiError && (error.details as { reason?: string } | undefined)?.reason === 'invalid_token') noteBadKey(clientIp, apiKey);
      throw error;
    });
    const aiSetup = await connectionSetupGrant(service, resolved.connection.grantId, resolved.keyRow.team_member_id, resolved.access);
    return { supabase: service, keyRow: resolved.keyRow, access: resolved.access, principal: null, connection: resolved.connection, aiSetup };
  }

  const keyHash = await hashApiKey(apiKey);
  const supabase = getServiceClient();
  const lookup = (columns: string) => supabase
    .from('api_keys')
    .select(columns)
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .maybeSingle();
  const KEY_COLUMNS = 'id, permissions, team_member_id, scopes, expires_at, disabled_at';
  let { data: found, error: keyError } = await lookup(`${KEY_COLUMNS}, paused_at`);
  // A database before 20261127000600 has no paused_at: no key there is paused.
  if (missingPauseColumns(keyError)) ({ data: found, error: keyError } = await lookup(KEY_COLUMNS));
  const keyRow = found as unknown as (ApiKeyRow & { paused_at?: string | null }) | null;

  if (keyError || !keyRow) {
    if (!keyError) noteBadKey(clientIp, apiKey);
    throw unauthorized('Invalid or revoked API key', { reason: 'invalid_api_key' });
  }
  if (keyRow.disabled_at) throw unauthorized('API key is disabled', { reason: 'api_key_disabled' });
  if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() <= Date.now()) {
    throw unauthorized('API key is expired', { reason: 'api_key_expired' });
  }
  if (keyRow.paused_at) {
    throw unauthorized('API key is paused', {
      reason: 'api_key_paused',
      hint: 'Whoever manages this key resumes it in Settings > Developers, or with POST /api/v1/api-keys/{id}/resume. It keeps the same secret.',
    });
  }
  // A replaced key ends at its overlap, so only a key with an end can have a
  // successor: while that successor is paused, this secret is stopped too.
  if (keyRow.expires_at && await successorPaused(supabase, keyRow.id)) {
    throw unauthorized('API key is paused', {
      reason: 'api_key_paused',
      hint: 'This key was replaced, and its replacement is paused. Whoever manages the replacement resumes it in Settings > Developers.',
    });
  }
  if (!keyRow.team_member_id) throw unauthorized('API key is not linked to a team member', { reason: 'api_key_not_linked' });

  const [{ data: businessSettings }, access] = await Promise.all([
    supabase.from('business_settings').select('api_enabled').limit(1).maybeSingle(),
    resolveMemberAccess(supabase, keyRow.team_member_id),
  ]);
  if (businessSettings?.api_enabled === false) throw forbidden('Workspace API access is disabled', { reason: 'api_disabled' });
  if (!access || access.status !== 'active') throw forbidden('Linked team member is suspended', { reason: 'member_suspended' });
  // AI agents switched off: agents (workspace and personal) do nothing, on
  // every route and the MCP server, until an Owner turns the module on again.
  if (access.role === 'agent' && !isModuleEnabled(access, 'agents')) throw moduleOff('agents');
  // A setup key works for its person alone, on the setup routes alone.
  if (isAiSetupKey(apiKey)) {
    if (actFor !== null) throw forbidden('This is not available while acting for someone', { reason: 'act_for_not_allowed', hint: 'A setup key acts as its person. Send the request without X-Act-For.' });
    const aiSetup = await keySetupGrant(supabase, keyRow.id, keyRow.team_member_id, access);
    return { supabase, keyRow: keyRow as ApiKeyRow, access, principal: null, aiSetup };
  }
  if (actFor !== null) {
    const acting = await verifyActFor(supabase, actFor, keyRow as ApiKeyRow, access);
    return { supabase, keyRow: keyRow as ApiKeyRow, access: acting.access, principal: { id: acting.principalId, tokenId: acting.tokenId, personal: !!access.principal_id } };
  }
  return { supabase, keyRow: keyRow as ApiKeyRow, access, principal: access.principal_id ? { id: access.principal_id, tokenId: null, personal: true } : null };
}

/** The X-Act-For token on a request: the header, else the one the MCP server carries for its in-process calls. */
export function actForFrom(request: NextRequest): string | null {
  const header = request.headers.get(ACT_FOR_HEADER);
  if (header !== null) return header;
  return apiRequestContext.getStore()?.actFor ?? null;
}

export function withApi<TBody = unknown, TParams = Record<string, string>>(
  handler: HandlerFn<TBody, TParams>,
  options: WithApiOptions<TBody>,
) {
  return async (
    request: NextRequest,
    routeContext?: { params?: Promise<TParams> | TParams },
  ): Promise<Response> => {
    let rateInfo: { remaining: number; resetAt: number; limit: number } | null = null;
    // The Idempotency-Key this request claimed, until its answer is stored or the key released.
    let idempotency: IdempotencyClaim | null = null;
    let service: SupabaseClient | null = null;

    try {
      // A body that says it is too large is refused before anything else is
      // done; one without a length is counted as it is read below.
      const bodyLimit = options?.maxBodyBytes ?? JSON_BODY_LIMIT;
      if (request.method !== 'GET' && request.method !== 'HEAD') assertDeclaredBodySize(request.headers, bodyLimit);
      const actFor = actForFrom(request);
      // A connection's token comes in-process from the MCP server (which
      // checked it first) or, where a route opts in, as a bearer token.
      const inConnection = apiRequestContext.getStore()?.connection === true;
      const bearer = options?.acceptsConnection ? /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null : null;
      const credential = request.headers.get('x-api-key') ?? (bearer && isConnectAccessToken(bearer) ? bearer : null);
      const { supabase, keyRow, access, principal, connection, aiSetup } = await resolveApiKey(credential, actFor, { connect: inConnection || !!options?.acceptsConnection, clientIp: trustedClientIp(request.headers) });
      service = supabase;

      // An AI setup session (lib/ai-setup.ts) reaches the setup routes only.
      // There its calls carry the person's API powers as of its start, still
      // checked against their access below; a setup key goes nowhere else.
      const onSetupRoute = !!aiSetup && aiSetupRoute(request.method, request.nextUrl.pathname) !== null;
      if (aiSetup?.kind === 'key' && !onSetupRoute) {
        throw forbidden('This setup key only sets up agents', {
          reason: 'ai_setup_only',
          hint: 'It works with the agent setup tools for an hour. Use your own key or a connected AI tool for anything else.',
        });
      }
      const setupGrant = onSetupRoute ? aiSetup : null;

      // The rate limit and, for an agent, what is paused, in one call.
      const gate: RequestGate = await passRequestGate(supabase, keyRow.id, keyRow.team_member_id);
      rateInfo = { remaining: gate.remaining, resetAt: gate.resetAt, limit: gate.limit };
      if (!gate.allowed) throw tooManyRequests();

      const method = request.method;
      const isWrite = method !== 'GET' && method !== 'HEAD';
      // A paused agent (the kill switch, or its own pause) still reads,
      // beats and reports telemetry; its other writes stop here.
      if (isWrite) {
        const paused = pausedRefusal(gate, request.nextUrl.pathname, method);
        if (paused) throw paused;
        // Over its budget or holding a run past its cap, an agent is refused
        // the same writes as a paused one; its writes and sends are counted
        // per agent, across all its keys.
        if (gate.agent && !pauseExempt(request.nextUrl.pathname, method)) {
          const limited = await writeGateRefusal(supabase, keyRow.team_member_id, request.nextUrl.pathname, method);
          if (limited) throw limited;
        }
      }
      // An agent paused on a project writes nothing there (what is exempt above too stays open).
      const projectWriteRefusal = (id: string) => (isWrite && !pauseExempt(request.nextUrl.pathname, method) ? projectPausedRefusal(gate, id) : null);
      if (keyRow.permissions === 'read_only' && method !== 'GET' && method !== 'HEAD') {
        throw forbidden('Read-only API key cannot perform write operations', {
          reason: 'read_only_key',
          grant_on: 'api_key',
          hint: 'This API key is read-only. Use a key that permits write operations.',
        });
      }

      let resolvedParams = {} as TParams;
      if (routeContext?.params) {
        resolvedParams = routeContext.params instanceof Promise
          ? await routeContext.params
          : routeContext.params;
      }

      const requiredPermission = options.permission;
      const configuredPermissions = Array.isArray(requiredPermission)
        ? requiredPermission
        : [requiredPermission];
      const requiredPermissions = [...new Set(configuredPermissions.flatMap(permissionAlternatives))];
      const keyScopes = Array.isArray(keyRow.scopes) ? keyRow.scopes : [];
      const scopes = setupGrant ? [...new Set([...keyScopes, ...setupGrant.scopes])] : keyScopes;
      // A host key (agents.host) does only what agents.host opens: the host
      // feed and leases in its agents' names. However else it is scoped, it
      // never replies, marks anything handled, reads content or acts for
      // anyone, and only an Owner's key is one.
      const hostKey = keyScopes.includes('agents.host');
      if (hostKey && !requiredPermissions.includes('agents.host')) {
        throw forbidden('A host key only reads its agents\' events and holds leases for them', {
          reason: 'host_key_only',
          hint: 'Use the agent\'s own key for anything else: replying, reading messages, changing tasks.',
        });
      }
      const grantedPermission = hostKey
        ? (accessAllows(access, 'agents.host', 'api') ? 'agents.host' as PermissionKey : undefined)
        : requiredPermissions.find((permission) => scopes.includes(permission) && accessAllows(access, permission, 'api'));
      if (!grantedPermission) {
        // A switched-off module is not a grant problem: no scope or role fixes
        // it, so say so before naming what to grant.
        const offModule = moduleOffFor(access, requiredPermissions);
        if (offModule) throw moduleOff(offModule);
        // Authorization is two-factor: a permission must be on BOTH the API key's
        // scopes AND the linked member's api_permissions. Report which side is
        // missing so the caller knows where to grant access, not just what.
        const missingKeyScopes = requiredPermissions.filter((p) => !scopes.includes(p));
        const missingMemberPermissions = requiredPermissions.filter((p) => !accessAllows(access, p, 'api'));
        const grantableViaKey = requiredPermissions.filter((p) => accessAllows(access, p, 'api') && !scopes.includes(p));
        const grantableViaMember = requiredPermissions.filter((p) => scopes.includes(p) && !accessAllows(access, p, 'api'));
        let reason: string;
        let grantOn: string;
        let hint: string;
        if (grantableViaKey.length > 0) {
          reason = 'missing_key_scope';
          grantOn = 'api_key';
          hint = `Add one of [${grantableViaKey.join(', ')}] to this API key's scopes.`;
        } else if (grantableViaMember.length > 0) {
          reason = 'missing_member_permission';
          grantOn = 'member_role';
          hint = `Grant one of [${grantableViaMember.join(', ')}] to the linked member's role or permission overrides.`;
        } else {
          reason = 'missing_key_scope_and_member_permission';
          grantOn = 'api_key_and_member_role';
          hint = `Grant one of [${requiredPermissions.join(', ')}] to BOTH this API key's scopes and the linked member's role.`;
        }
        throw forbidden(`API scope required: ${requiredPermissions.join(' or ')}`, {
          reason,
          grant_on: grantOn,
          hint,
          required: requiredPermissions,
          missing_key_scopes: missingKeyScopes,
          missing_member_permissions: missingMemberPermissions,
        });
      }

      if (hostKey) {
        if (access.role !== 'owner') {
          throw forbidden('A host key must be an Owner\'s key', { reason: 'host_key_not_owner', hint: 'An Owner makes the host key and binds it to agents (PUT /api/v1/api-keys/{id}/agents).' });
        }
        if (actFor !== null) {
          throw forbidden('This is not available while acting for someone', { reason: 'act_for_not_allowed', hint: 'A host key never acts for anyone. Send the request without X-Act-For.' });
        }
      }

      // Acting for a person, routes that read what is the agent's own by
      // grant rather than by project (its bell, the inboxes and credentials
      // shared with it) are closed: nothing there is the person's.
      // A personal agent's own bell stays its own; inboxes and credentials
      // shared with it are closed, as for any agent acting for someone.
      // A personal agent reaches the Inbox too, but only its person's own
      // personal inboxes they gave it ("Sort my inbox"): inbox-visibility
      // narrows what it reads to those.
      if (principal) {
        const path = request.nextUrl.pathname;
        const ownBell = principal.personal;
        const inboxPath = path.startsWith('/api/v1/inbox') || path.startsWith('/api/v1/inbound-emails') || /^\/api\/v1\/tasks\/[^/]+\/messages/.test(path);
        const ownByGrant = (inboxPath && !principal.personal) || path.includes('/credentials')
          || (!ownBell && path.startsWith('/api/v1/notifications') && !(method === 'POST' && /^\/api\/v1\/notifications\/?$/.test(path)));
        if (ownByGrant) {
          throw forbidden('This is not available while acting for someone', {
            reason: 'act_for_not_allowed',
            hint: ownBell
              ? 'A personal agent works within its person\'s reach: inboxes and credentials shared with the agent itself stay closed.'
              : 'Send the request without X-Act-For: it reads what is shared with your agent itself, not with the person.',
          });
        }
      }

      const projectId = (resolvedParams as Record<string, string>).id;
      if (projectId && request.nextUrl.pathname.includes('/projects/')) {
        if (!accessAllowsProject(access, projectId, 'api')) {
          throw forbidden('Project scope denied', {
            reason: 'project_scope',
            grant_on: 'project_membership',
            project_id: projectId,
            hint: 'Assign the linked member to this project, or grant projects.read_all.',
          });
        }
        // A project in Trash takes everything under it out of reach, so no
        // nested route can read or change what belongs to it.
        const { data: liveProject } = await supabase
          .from('projects')
          .select('id')
          .eq('id', projectId)
          .is('deleted_at', null)
          .maybeSingle();
        if (!liveProject) throw notFound('Project');
        const pausedHere = projectWriteRefusal(projectId);
        if (pausedHere) throw pausedHere;
      }

      // `reorder` is a collection action, not a task id; its handler authorizes
      // the body's task_id itself. Everything else stays fail-closed: matching
      // "UUID-shaped" segments instead would let the other spellings Postgres
      // accepts for a uuid (no hyphens, braces) skip this check.
      const taskMatch = request.nextUrl.pathname.match(/^\/api\/v1\/tasks\/([^/]+)/);
      if (taskMatch && !TASK_COLLECTION_ACTIONS.has(taskMatch[1])) {
        const taskId = taskMatch[1];
        // A task in Trash, or in a project in Trash, reads as missing.
        const { data: task } = await supabase
          .from('tasks')
          .select('id, project_id, parent_task_id, task_assignees(member_id), project:projects!inner(id)')
          .eq('id', taskId)
          .is('deleted_at', null)
          .is('project.deleted_at', null)
          .maybeSingle();
        // So does a subtask whose parent is in Trash.
        const parentGone = !!task?.parent_task_id && !(await liveTaskIds(supabase, [task.id])).has(task.id);
        // Not found, never "denied": an agent told "denied" takes it for a
        // permission problem. A task in a project the key cannot open answers
        // exactly the same, so the answer never confirms that an id exists or
        // names its project.
        if (!task || parentGone || !accessAllowsProject(access, task.project_id, 'api')) throw taskNotFound();
        const pausedHere = projectWriteRefusal(task.project_id);
        if (pausedHere) throw pausedHere;
        const isCommentWrite = request.nextUrl.pathname.includes('/comments') && isWrite;
        // Claiming decides for itself who may (an unassigned task can be
        // picked up, which assigns it), so it skips the assigned-only check.
        const isClaim = /^\/api\/v1\/tasks\/[^/]+\/claim(\/extend)?\/?$/.test(request.nextUrl.pathname);
        if (isWrite && !isCommentWrite && !isClaim && grantedPermission === 'tasks.manage_assigned') {
          const keyCanManageAll = scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
          let assigned = (task.task_assignees || []).some((row: { member_id: string }) => row.member_id === keyRow.team_member_id);
          // A subtask is also theirs to work when its parent is.
          if (!assigned && task.parent_task_id) {
            const { data: onParent } = await supabase
              .from('task_assignees')
              .select('member_id')
              .eq('task_id', task.parent_task_id)
              .eq('member_id', keyRow.team_member_id)
              .maybeSingle();
            assigned = !!onParent;
          }
          if (!keyCanManageAll && !assigned) {
            throw forbidden('This API key can only modify assigned tasks', {
              reason: 'assigned_only',
              grant_on: 'api_key_and_member_role',
              hint: "Grant 'tasks.manage_all' to both the API key scopes and the linked member to modify unassigned tasks.",
            });
          }
        }
      }

      const leadMatch = request.nextUrl.pathname.match(/^\/api\/v1\/leads\/([^/]+)/);
      if (leadMatch) {
        // A lead in Trash reads as missing, and takes everything under it along.
        const { data: lead } = await supabase
          .from('leads')
          .select('id, assigned_to, lead_members(member_id)')
          .eq('id', leadMatch[1])
          .is('deleted_at', null)
          .maybeSingle();
        const readAll = accessAllows(access, 'leads.read_all', 'api');
        if (!lead && readAll) throw notFound('Lead');
        // Acting for a person, the agent's own assignment is no reach of
        // theirs: a lead has no project and no principal, so only
        // leads.read_all (held by both) opens one.
        const assigned = !access.principal_id && (lead?.assigned_to === keyRow.team_member_id
          || (lead?.lead_members || []).some((row: { member_id: string }) => row.member_id === keyRow.team_member_id));
        if (!readAll && !assigned) {
          throw forbidden('Lead scope denied', {
            reason: 'lead_scope',
            grant_on: 'lead_assignment',
            hint: 'Assign the linked member to this lead, or grant leads.read_all.',
          });
        }
      }

      const contactMatch = request.nextUrl.pathname.match(/^\/api\/v1\/contacts\/([^/]+)/);
      if (contactMatch) {
        const { data: liveContact } = await supabase
          .from('contacts')
          .select('id')
          .eq('id', contactMatch[1])
          .is('deleted_at', null)
          .maybeSingle();
        if (!liveContact) throw notFound('Contact');
      }
      if (contactMatch && !accessAllows(access, 'contacts.read_all', 'api')) {
        const contactScopeDenied = {
          reason: 'contact_scope',
          grant_on: 'project_membership',
          hint: 'Grant contacts.read_all, or link this contact to a project the member can access.',
        };
        if (access.project_ids.length === 0) throw forbidden('Contact scope denied', contactScopeDenied);
        const { data: link } = await supabase
          .from('project_contacts')
          .select('contact_id')
          .eq('contact_id', contactMatch[1])
          .in('project_id', access.project_ids)
          .limit(1)
          .maybeSingle();
        if (!link) throw forbidden('Contact scope denied', contactScopeDenied);
      }

      // Idempotency-Key applies to POST (and a PATCH that opts in); it is
      // checked before the body is read, so a bad key is a 400 whatever the body holds.
      const idempotencyKey = method === 'POST' || (method === 'PATCH' && options?.idempotentPatch) ? idempotencyKeyFrom(request.headers) : null;
      if (idempotencyKey && options?.returnsSecret) {
        throw badRequest('Idempotency-Key is not accepted here: the answer holds a secret that is shown only once', {
          reason: 'idempotency_not_supported',
          hint: 'Send the request without the header. If it times out, list what exists before trying again.',
        });
      }
      const parsesBody = !!options?.schema && (method === 'POST' || method === 'PUT' || method === 'PATCH');
      // A route with no schema reads the request itself (custom /api/x routes
      // do), so the key's hash reads a clone and leaves the body to it.
      const text = parsesBody ? await readBodyText(request, bodyLimit) : idempotencyKey ? await readBodyText(request.clone(), bodyLimit) : '';

      let body = undefined as unknown as TBody;
      if (options?.schema && parsesBody) {
        let raw: unknown = {};
        if (text.trim() || !options.optionalBody) {
          try {
            raw = JSON.parse(text);
          } catch {
            throw badRequest('Request body must be valid JSON');
          }
        }
        // A body nested past any real one: refused before anything walks it.
        const deep = bodyProblem(raw, { text: false });
        if (deep) {
          throw new ApiError(422, 'VALIDATION_ERROR', `The body nests more than ${BODY_DEPTH_MAX} levels deep (at ${deep.path})`, {
            reason: 'too_deep', field: deep.path, max_depth: BODY_DEPTH_MAX,
          });
        }
        body = options.schema.parse(raw);
        // NUL or a lone surrogate would fail in the database as a 500: refuse it here, by field.
        // Checked on what the schema kept: a field it cleans, or a key it drops, passes as before.
        const unstorable = bodyProblem(body);
        if (unstorable) {
          throw new ApiError(422, 'VALIDATION_ERROR', `${unstorable.path} holds a character that cannot be stored (NUL or half of a surrogate pair)`, {
            reason: 'invalid_text', field: unstorable.path,
          });
        }
      }
      // A session's call changes agents only (lib/api/ai-setup.ts).
      if (setupGrant) await assertAiSetupCall(supabase, { method, pathname: request.nextUrl.pathname, body, memberId: keyRow.team_member_id });

      // Last, once the request is known to be valid and allowed: a refused
      // request claims nothing. A replay answers without running the handler.
      if (idempotencyKey) {
        const claimed = await claimIdempotencyKey(supabase, {
          apiKeyId: keyRow.id,
          path: request.nextUrl.pathname,
          key: idempotencyKey,
          requestHash: idempotencyRequestHash(request.nextUrl.search, text),
        });
        if (claimed.state === 'replay') return applyRateLimitHeaders(claimed.response, rateInfo);
        if (claimed.state === 'claimed') idempotency = claimed.claim;
      }

      afterResponse('last_used_at update', async () => {
        await supabase
          .from('api_keys')
          .update({ last_used_at: new Date().toISOString() })
          .eq('id', keyRow.id);
      });

      // The MCP server marks its in-process calls; a header could be sent by anyone.
      const via = apiRequestContext.getStore()?.via ?? 'rest';
      const principalId = principal?.id ?? null;
      const pausedProjectIds = gate.agent ? gate.pausedProjectIds : [];
      const aiSetupContext = setupGrant ? { sessionId: setupGrant.sessionId, memberId: setupGrant.memberId, clientName: setupGrant.clientName } : null;
      const response = await apiRequestContext.run({ via, keyId: keyRow.id, principalId, actFor, pausedProjectIds, connection: !!connection, aiSetup: aiSetupContext }, () => handler({
        // Writes are logged as the key's member (agents are left out by the
        // database), and a task it creates records the key itself.
        supabase: getActorClient(keyRow.team_member_id, via === 'mcp' ? 'mcp' : 'api', keyRow.id),
        params: resolvedParams,
        body,
        searchParams: request.nextUrl.searchParams,
        apiKeyId: keyRow.id,
        permissions: keyRow.permissions,
        teamMemberId: keyRow.team_member_id,
        access,
        scopes,
        principalId,
        origin: request.nextUrl.origin,
        signal: request.signal,
      }));
      if (idempotency) {
        // Stored before the answer leaves, so a retry that arrives right after gets it.
        await finishIdempotencyKey(supabase, idempotency, response);
        idempotency = null;
      }
      // A write may have queued webhook events (REST and MCP both land here): send them now.
      if (isWrite && response.ok) kickWebhooks(access);
      return applyRateLimitHeaders(response, rateInfo);
    } catch (err) {
      // The handler failed: free the key so a retry runs again.
      if (idempotency && service) await releaseIdempotencyKey(service, idempotency);
      if (err instanceof ZodError) {
        return applyRateLimitHeaders(errorResponse(422, 'VALIDATION_ERROR', 'Validation failed', err.issues), rateInfo);
      }
      if (err instanceof ApiError) {
        const response = errorResponse(err.statusCode, err.code, err.message, err.details);
        // A 429 with its own window (chat_rate_limited's reset_at) waits for that, not the key's.
        const ownReset = err.statusCode === 429 ? Date.parse(String((err.details as { reset_at?: unknown } | undefined)?.reset_at ?? '')) : NaN;
        if (Number.isFinite(ownReset)) response.headers.set('Retry-After', retryAfterSeconds(ownReset));
        return applyRateLimitHeaders(response, rateInfo);
      }
      // Attach a request id so an opaque 500 can be traced to its server log.
      const requestId = crypto.randomUUID();
      console.error(`[API Error] request_id=${requestId}`, err);
      return applyRateLimitHeaders(
        errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred', { request_id: requestId }),
        rateInfo,
      );
    }
  };
}
