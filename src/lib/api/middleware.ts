import { after, NextRequest } from 'next/server';
import { ZodSchema, ZodError } from 'zod';
import { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext, PermissionKey } from '@/lib/access-control';
import { getServiceClient } from './supabase-service';
import { hashApiKey } from './crypto';
import { checkRateLimit } from './rate-limit';
import { ApiError, unauthorized, forbidden, tooManyRequests, badRequest } from './errors';
import { errorResponse } from './response';
import { accessAllows, accessAllowsProject, resolveMemberAccess } from './access';

function applyRateLimitHeaders(
  response: Response,
  rateInfo: { remaining: number; resetAt: number } | null,
): Response {
  if (rateInfo) {
    response.headers.set('X-RateLimit-Limit', '120');
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
}

interface WithApiOptions<TBody> {
  schema?: ZodSchema<TBody>;
  permission?: PermissionKey | PermissionKey[];
}

type HandlerFn<TBody, TParams> = (ctx: ApiContext<TBody, TParams>) => Promise<Response>;

function inferredPermission(pathname: string, method: string): PermissionKey {
  const write = method !== 'GET' && method !== 'HEAD';
  if (pathname.includes('/credentials')) {
    return pathname.endsWith('/reveal') ? 'credentials.reveal_shared' : write ? 'credentials.manage' : 'credentials.reveal_shared';
  }
  if (pathname.includes('/communications')) return write ? 'communications.manage' : 'communications.read';
  if (pathname.includes('/notifications')) return 'notifications.manage_own';
  if (pathname.includes('/time-entries')) return 'time.manage_own';
  if (pathname.includes('/tasks')) {
    if (!write) return 'tasks.read';
    if (/\/api\/v1\/tasks\/?$/.test(pathname) && method === 'POST') return 'tasks.create';
    if (/\/api\/v1\/tasks\/[^/]+\/?$/.test(pathname) && method === 'DELETE') return 'tasks.manage_all';
    if (pathname.includes('/comments')) return 'tasks.read';
    return 'tasks.manage_assigned';
  }
  if (pathname.includes('/leads')) return write ? 'leads.manage' : 'leads.read';
  if (pathname.includes('/contacts')) return write ? 'contacts.manage' : 'contacts.read';
  if (pathname.includes('/entity-files')) return method === 'POST' ? 'files.upload' : write ? 'files.manage' : 'files.read';
  if (pathname.includes('/portal')) return write ? 'portal.manage' : 'portal.read';
  if (pathname.includes('/context')) return write ? 'project_context.manage' : 'project_context.read';
  if (pathname.includes('/goals')) return write ? 'goals.manage' : 'goals.read';
  if (pathname.includes('/suggestions')) return 'suggestions.manage';
  if (pathname.includes('/audit-log')) return 'audit.read';
  if (pathname.includes('/team-members')) return write ? 'team.manage' : 'team.read';
  if (pathname.includes('/activities')) return write ? 'agents.manage' : 'audit.read';
  return write ? 'projects.manage' : 'projects.read';
}

function permissionAlternatives(permission: PermissionKey): PermissionKey[] {
  const implications: Partial<Record<PermissionKey, PermissionKey[]>> = {
    'team.read': ['team.manage'],
    'projects.read': ['projects.read_all', 'projects.manage'],
    'tasks.read': ['tasks.manage_all'],
    'tasks.manage_assigned': ['tasks.manage_all'],
    'contacts.read': ['contacts.read_all', 'contacts.manage'],
    'leads.read': ['leads.read_all', 'leads.manage'],
    'files.read': ['files.manage'],
    'portal.read': ['portal.manage'],
    'communications.read': ['communications.manage'],
    'credentials.reveal_shared': ['credentials.manage'],
    'invoices.read': ['invoices.manage'],
    'project_context.read': ['project_context.manage'],
    'goals.read': ['goals.manage'],
  };
  return [permission, ...(implications[permission] || [])];
}

export function withApi<TBody = unknown, TParams = Record<string, string>>(
  handler: HandlerFn<TBody, TParams>,
  options?: WithApiOptions<TBody>,
) {
  return async (
    request: NextRequest,
    routeContext?: { params?: Promise<TParams> | TParams },
  ): Promise<Response> => {
    let rateInfo: { remaining: number; resetAt: number } | null = null;

    try {
      const apiKey = request.headers.get('x-api-key');
      if (!apiKey) throw unauthorized('Missing x-api-key header', { reason: 'missing_api_key' });

      const keyHash = await hashApiKey(apiKey);
      const supabase = getServiceClient();
      const { data: keyRow, error: keyError } = await supabase
        .from('api_keys')
        .select('id, permissions, team_member_id, scopes, expires_at, disabled_at')
        .eq('key_hash', keyHash)
        .is('revoked_at', null)
        .maybeSingle();

      if (keyError || !keyRow) throw unauthorized('Invalid or revoked API key', { reason: 'invalid_api_key' });
      if (keyRow.disabled_at) throw unauthorized('API key is disabled', { reason: 'api_key_disabled' });
      if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() <= Date.now()) {
        throw unauthorized('API key is expired', { reason: 'api_key_expired' });
      }
      if (!keyRow.team_member_id) throw unauthorized('API key is not linked to a team member', { reason: 'api_key_not_linked' });

      const [{ data: businessSettings }, access] = await Promise.all([
        supabase.from('business_settings').select('api_enabled').limit(1).maybeSingle(),
        resolveMemberAccess(supabase, keyRow.team_member_id),
      ]);
      if (businessSettings?.api_enabled === false) throw forbidden('Workspace API access is disabled', { reason: 'api_disabled' });
      if (!access || access.status !== 'active') throw forbidden('Linked team member is suspended', { reason: 'member_suspended' });

      const rateResult = await checkRateLimit(supabase, keyRow.id);
      rateInfo = { remaining: rateResult.remaining, resetAt: rateResult.resetAt };
      if (!rateResult.allowed) throw tooManyRequests();

      const method = request.method;
      const isWrite = method !== 'GET' && method !== 'HEAD';
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

      const requiredPermission = options?.permission
        || inferredPermission(request.nextUrl.pathname, method);
      const configuredPermissions = Array.isArray(requiredPermission)
        ? requiredPermission
        : [requiredPermission];
      const requiredPermissions = [...new Set(configuredPermissions.flatMap(permissionAlternatives))];
      const scopes = Array.isArray(keyRow.scopes) ? keyRow.scopes : [];
      const grantedPermission = requiredPermissions.find((permission) =>
        scopes.includes(permission) && accessAllows(access, permission, 'api'));
      if (!grantedPermission) {
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

      const projectId = (resolvedParams as Record<string, string>).id;
      if (projectId && request.nextUrl.pathname.includes('/projects/')
        && !accessAllowsProject(access, projectId, 'api')) {
        throw forbidden('Project scope denied', {
          reason: 'project_scope',
          grant_on: 'project_membership',
          project_id: projectId,
          hint: 'Assign the linked member to this project, or grant projects.read_all.',
        });
      }

      const taskMatch = request.nextUrl.pathname.match(/^\/api\/v1\/tasks\/([^/]+)/);
      if (taskMatch) {
        const taskId = taskMatch[1];
        const { data: task } = await supabase
          .from('tasks')
          .select('id, project_id, task_assignees(member_id)')
          .eq('id', taskId)
          .maybeSingle();
        if (!task) throw forbidden('Task scope denied', { reason: 'not_found_or_forbidden', resource: 'task' });
        if (!accessAllowsProject(access, task.project_id, 'api')) {
          throw forbidden('Project scope denied', {
            reason: 'project_scope',
            grant_on: 'project_membership',
            project_id: task.project_id,
            hint: "Assign the linked member to this task's project, or grant projects.read_all.",
          });
        }
        const isCommentWrite = request.nextUrl.pathname.includes('/comments') && isWrite;
        if (isWrite && !isCommentWrite && grantedPermission === 'tasks.manage_assigned') {
          const keyCanManageAll = scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
          const assigned = (task.task_assignees || []).some((row: { member_id: string }) => row.member_id === keyRow.team_member_id);
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
      if (leadMatch && !accessAllows(access, 'leads.read_all', 'api')) {
        const { data: lead } = await supabase
          .from('leads')
          .select('id, assigned_to, lead_members(member_id)')
          .eq('id', leadMatch[1])
          .maybeSingle();
        const assigned = lead?.assigned_to === keyRow.team_member_id
          || (lead?.lead_members || []).some((row: { member_id: string }) => row.member_id === keyRow.team_member_id);
        if (!assigned) {
          throw forbidden('Lead scope denied', {
            reason: 'lead_scope',
            grant_on: 'lead_assignment',
            hint: 'Assign the linked member to this lead, or grant leads.read_all.',
          });
        }
      }

      const contactMatch = request.nextUrl.pathname.match(/^\/api\/v1\/contacts\/([^/]+)/);
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

      let body = undefined as unknown as TBody;
      if (options?.schema && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        const raw = await request.json().catch(() => {
          throw badRequest('Request body must be valid JSON');
        });
        body = options.schema.parse(raw);
      }

      after(async () => {
        await supabase
          .from('api_keys')
          .update({ last_used_at: new Date().toISOString() })
          .eq('id', keyRow.id);
      });

      const response = await handler({
        supabase,
        params: resolvedParams,
        body,
        searchParams: request.nextUrl.searchParams,
        apiKeyId: keyRow.id,
        permissions: keyRow.permissions,
        teamMemberId: keyRow.team_member_id,
        access,
        scopes,
      });
      return applyRateLimitHeaders(response, rateInfo);
    } catch (err) {
      if (err instanceof ZodError) {
        return applyRateLimitHeaders(errorResponse(422, 'VALIDATION_ERROR', 'Validation failed', err.issues), rateInfo);
      }
      if (err instanceof ApiError) {
        return applyRateLimitHeaders(errorResponse(err.statusCode, err.code, err.message, err.details), rateInfo);
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
