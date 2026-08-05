import type { SupabaseClient, User } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import type { AccessContext, PermissionKey, TeamRole } from '@/lib/access-control';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';

export interface SessionAccessResult {
  user: User;
  memberId: string;
  access: AccessContext;
  service: SupabaseClient;
  client: SupabaseClient;
}

type SessionAccessResponse =
  | { data: SessionAccessResult; error: null }
  | { data: null; error: NextResponse };

// A permission resolver must fail CLOSED. We only fall back to the legacy path
// during the pre-migration bootstrap window, which is identifiable by the DB
// reporting the new columns/tables as not existing. Every other error
// (transient, connectivity, RLS) returns null upstream so a restricted or
// suspended member is never silently escalated to a full-access context.
function isSchemaMissingError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const code = error.code || '';
  // 42P01 undefined_table, 42703 undefined_column, 42883 undefined_function,
  // PGRST205/PGRST204 PostgREST schema-cache misses for missing table/column.
  if (['42P01', '42703', '42883', 'PGRST205', 'PGRST204'].includes(code)) return true;
  const message = (error.message || '').toLowerCase();
  return message.includes('does not exist') || message.includes('schema cache');
}

export async function resolveMemberAccess(
  service: SupabaseClient,
  memberId: string,
): Promise<AccessContext | null> {
  const memberResult = await service
    .from('team_members')
    .select('id, role, status')
    .eq('id', memberId)
    .maybeSingle();

  // This fallback keeps a code-first deployment usable during the short window
  // before the additive authorization migration is applied. It is only safe to
  // enter when the schema is genuinely missing; any other error fails closed.
  if (memberResult.error) {
    if (!isSchemaMissingError(memberResult.error)) return null;
    const { data: legacyMember } = await service
      .from('team_members')
      .select('id, role')
      .eq('id', memberId)
      .maybeSingle();
    if (!legacyMember) return null;
    const legacyRole = legacyMember.role as TeamRole;
    const { data: projectRows } = await service
      .from('project_members')
      .select('project_id')
      .eq('member_id', memberId);
    const legacyManagement = legacyRole === 'admin' || legacyRole === 'owner';
    return {
      member_id: legacyMember.id,
      role: legacyRole,
      status: 'active',
      app_permissions: legacyManagement ? ['*'] : [],
      api_permissions: legacyManagement ? ['*'] : [],
      project_ids: (projectRows || []).map((row) => row.project_id),
    };
  }

  const member = memberResult.data;

  if (!member) return null;

  const role = member.role as TeamRole;
  const [roleResult, overrideResult, projectResult] = await Promise.all([
    role === 'owner'
      ? Promise.resolve({ data: [], error: null })
      : service
          .from('role_permissions')
          .select('permission_key, access_channel')
          .eq('role', role)
          .order('access_channel')
          .order('permission_key'),
    service
      .from('team_member_permissions')
      .select('permission_key, access_channel, effect')
      .eq('member_id', memberId)
      .order('access_channel')
      .order('permission_key'),
    service.from('project_members').select('project_id').eq('member_id', memberId).order('project_id'),
  ]);

  // An admin running against the pre-migration schema should retain the legacy
  // management experience. New roles remain closed by default until migrated.
  // Only bootstrap when the permission tables are genuinely absent; a transient
  // error on either query fails closed rather than escalating to '*'. Real
  // suspension state (already read above) is always honored.
  if (role !== 'owner' && (roleResult.error || overrideResult.error)) {
    const errors = [roleResult.error, overrideResult.error].filter(Boolean);
    if (!errors.every((err) => isSchemaMissingError(err))) return null;
    const legacyManagement = role === 'admin';
    return {
      member_id: member.id,
      role,
      status: member.status === 'suspended' ? 'suspended' : 'active',
      app_permissions: legacyManagement ? ['*'] : [],
      api_permissions: legacyManagement ? ['*'] : [],
      project_ids: (projectResult.data || []).map((row) => row.project_id),
    };
  }

  const roleRows = roleResult.data;
  const overrideRows = overrideResult.data;
  const projectRows = projectResult.data;

  const app = new Set<string>();
  const api = new Set<string>();
  if (role === 'owner') {
    app.add('*');
    api.add('*');
  } else {
    for (const row of roleRows || []) {
      (row.access_channel === 'api' ? api : app).add(row.permission_key);
    }
    // Apply allow overrides first, then deny overrides, so a deny always wins
    // over a conflicting allow for the same member/permission/channel regardless
    // of row order returned by the database.
    const overrides = overrideRows || [];
    for (const row of overrides) {
      if (row.effect !== 'allow') continue;
      (row.access_channel === 'api' ? api : app).add(row.permission_key);
    }
    for (const row of overrides) {
      if (row.effect === 'allow') continue;
      (row.access_channel === 'api' ? api : app).delete(row.permission_key);
    }
  }

  return {
    member_id: member.id,
    role,
    status: member.status === 'suspended' ? 'suspended' : 'active',
    app_permissions: [...app] as AccessContext['app_permissions'],
    api_permissions: [...api] as AccessContext['api_permissions'],
    project_ids: (projectRows || []).map((row) => row.project_id),
  };
}

export function accessAllows(
  access: AccessContext,
  permission: PermissionKey,
  channel: 'app' | 'api' = 'app',
): boolean {
  if (access.status !== 'active') return false;
  const permissions = channel === 'app' ? access.app_permissions : access.api_permissions;
  return permissions.includes('*') || permissions.includes(permission);
}

export function accessAllowsProject(
  access: AccessContext,
  projectId: string,
  channel: 'app' | 'api' = 'app',
): boolean {
  return accessAllows(access, 'projects.read_all', channel)
    || (accessAllows(access, 'projects.read', channel) && access.project_ids.includes(projectId));
}

export function apiKeyAllows(
  access: AccessContext,
  scopes: string[],
  permission: PermissionKey,
): boolean {
  return scopes.includes(permission) && accessAllows(access, permission, 'api');
}

export async function accessAllowsEntity(
  service: SupabaseClient,
  access: AccessContext,
  memberId: string,
  entityType: string,
  entityId: string,
  channel: 'app' | 'api' = 'api',
): Promise<boolean> {
  if (entityType === 'project') return accessAllowsProject(access, entityId, channel);

  if (entityType === 'task') {
    const { data: task } = await service.from('tasks').select('project_id').eq('id', entityId).maybeSingle();
    return Boolean(task && accessAllowsProject(access, task.project_id, channel));
  }

  if (entityType === 'contact') {
    if (accessAllows(access, 'contacts.read_all', channel)) return true;
    if (!accessAllows(access, 'contacts.read', channel) || access.project_ids.length === 0) return false;
    const { data: link } = await service
      .from('project_contacts')
      .select('project_id')
      .eq('contact_id', entityId)
      .in('project_id', access.project_ids)
      .limit(1)
      .maybeSingle();
    return Boolean(link);
  }

  if (entityType === 'lead') {
    if (accessAllows(access, 'leads.read_all', channel)) return true;
    if (!accessAllows(access, 'leads.read', channel)) return false;
    const { data: lead } = await service.from('leads').select('assigned_to').eq('id', entityId).maybeSingle();
    if (lead?.assigned_to === memberId) return true;
    const { data: membership } = await service
      .from('lead_members')
      .select('lead_id')
      .eq('lead_id', entityId)
      .eq('member_id', memberId)
      .maybeSingle();
    return Boolean(membership);
  }

  return false;
}

export function sanitizeProjectForAccess<T extends Record<string, unknown>>(
  project: T,
  access: AccessContext,
  channel: 'app' | 'api' = 'app',
): T {
  const sanitized: Record<string, unknown> = { ...project };
  if (!accessAllows(access, 'billing.manage', channel)) {
    Object.assign(sanitized, {
      hourly_rate: null,
      budget_type: null,
      budget_value: null,
      billing_address: null,
      billing_email: null,
      tax_rate: null,
      invoice_pdf_options: undefined,
      client_time_billing: undefined,
    });
  }
  // The agent block that used to live here is gone on purpose.
  //
  // autonomous_enabled, auto_merge_enabled, integration_branch,
  // production_branch, suggestion_queue_cap, audit_interval_hours,
  // suggestions_per_cycle and repo_path are OPERATING PARAMETERS the agents read to
  // decide what to do. They are not secrets and they are not settings from the
  // reader's point of view: changing any of them still requires agents.manage,
  // enforced in the PATCH handlers, which is where the boundary belongs.
  //
  // Blanking them was silently catastrophic, twice, because a zeroed parameter
  // is a valid instruction rather than an error. autonomous_enabled forced to
  // false told every scheduled loop that no project anywhere wanted work, and
  // cost 25 hours of downtime in which Jeff answered PICKUP_IDLE roughly 50
  // times with an approved task assigned to him. Fixing only that field left
  // the concurrency field reading 0, which told him he may run no tasks at all,
  // so he investigated the work properly and then declined it. Every request
  // returned 200 and every container stayed healthy through both.
  //
  // A read path that quietly rewrites values into a legal-looking lie is worse
  // than one that refuses. If a caller should not see these, deny the endpoint.
  return sanitized as T;
}

export function sanitizeTimeEntryForAccess<T extends Record<string, unknown>>(
  entry: T,
  access: AccessContext,
  channel: 'app' | 'api' = 'app',
): T {
  const sanitized: Record<string, unknown> = { ...entry };
  if (!accessAllows(access, 'billing.manage', channel)) {
    sanitized.hourly_rate = undefined;
    sanitized.billing_multiplier = undefined;
  }
  const isOwnEntry = entry.member_id === access.member_id;
  const canSeeCompensation = accessAllows(access, 'compensation.manage', channel)
    || accessAllows(access, 'payouts.manage', channel)
    || (isOwnEntry && accessAllows(access, 'earnings.own.read', channel));
  if (!canSeeCompensation) sanitized.compensation_rate = undefined;
  return sanitized as T;
}

export async function requireSessionAccess(options?: {
  permission?: PermissionKey;
  projectId?: string;
}): Promise<SessionAccessResponse> {
  const sessionClient = await createClient();
  const { data: { user }, error } = await sessionClient.auth.getUser();
  if (error || !user) {
    return { data: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const service = getServiceClient();
  const { data: member } = await service
    .from('team_members')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (!member) {
    return { data: null, error: NextResponse.json({ error: 'Team member not found' }, { status: 403 }) };
  }

  const access = await resolveMemberAccess(service, member.id);
  if (!access || access.status !== 'active') {
    return { data: null, error: NextResponse.json({ error: 'Account suspended' }, { status: 403 }) };
  }
  if (options?.permission && !accessAllows(access, options.permission, 'app')) {
    return { data: null, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  if (options?.projectId && !accessAllowsProject(access, options.projectId)) {
    return { data: null, error: NextResponse.json({ error: 'Project access denied' }, { status: 403 }) };
  }

  return {
    data: { user, memberId: member.id, access, service, client: sessionClient },
    error: null,
  };
}
