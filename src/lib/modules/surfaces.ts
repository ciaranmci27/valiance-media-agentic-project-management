import { MODULE_IDS, type ModuleId } from '@/lib/modules/registry';

/**
 * Where each module lives: its tables, its database functions and its routes.
 * The registry says what a module is; this says what switching it off must
 * reach. `npm run test:module-guards` walks the real schema and the route
 * folders against it:
 *
 * - every table and every SECURITY DEFINER function a signed-in member can
 *   call is claimed by one module or listed as core;
 * - every policy on a module's tables, and every module function, asks for
 *   one of that module's permissions or for `module_enabled('<module>')`;
 * - every route file under the folders below is claimed by exactly one
 *   module, a shared route or core.
 *
 * Adding a table, function or route: claim it here in the same change.
 */

export interface ModuleSurface {
  /** Tables (in schema pm) holding the module's data. */
  tables: string[];
  /** Database functions of the module (in schema pm). */
  rpcs: string[];
  /** Route folders under src/app; a folder claims everything beneath it. */
  routes: string[];
}

export const MODULE_SURFACES: Record<ModuleId, ModuleSurface> = {
  time: {
    tables: ['project_time_entries', 'time_entry_tasks'],
    rpcs: ['review_time_entries', 'review_time_entries_api', 'get_accessible_time_entries', 'apply_agent_billing_conversion', 'time_entry_is_live'],
    routes: ['api/v1/projects/[id]/time-entries', 'api/workspace/time-entries', '(protected)/time'],
  },
  billing: {
    tables: [
      'project_invoices', 'invoice_payments', 'invoice_time_entry_allocations',
      'project_billing_plans', 'project_billing_runs', 'billing_draft_notices', 'project_budget_history',
      'project_hourly_rates', 'project_retainers', 'project_retainer_amounts', 'project_retainer_periods',
    ],
    rpcs: [
      'invoice_hours_draft', 'save_project_invoice_with_allocations', 'suggest_project_invoice_number',
      'schedule_retainer_amount', 'generate_retainer_period', 'retainer_due_periods',
      'save_project_retainer', 'retainer_accruing_lines', 'save_project_billing_plan', 'billing_forecast',
      'remove_invoice_payment', 'project_invoice_payments', 'record_invoice_payment',
      'invoice_is_live', 'retainer_is_live', 'generate_retainer_drafts', 'generate_billing_drafts',
    ],
    routes: [
      'api/v1/invoices', 'api/v1/billing', 'api/v1/projects/[id]/invoices', 'api/v1/projects/[id]/hourly-rates',
      'api/projects/[id]/invoices', 'api/projects/[id]/budget-change', 'api/projects/[id]/budget-history',
      // Budget emails also need the Client portal and Contacts; the route checks all three.
      'api/projects/[id]/budget-alerts',
      'api/internal/billing',
      '(protected)/finances/billing',
    ],
  },
  team_pay: {
    // Revenue splits on retainers and invoice lines are pay: who earns what
    // from the client's money, behind compensation.manage.
    tables: [
      'team_member_hourly_rates', 'team_member_earning_adjustments', 'team_member_payouts',
      'team_member_payout_allocations', 'team_member_share_earnings', 'project_retainer_shares',
      'invoice_line_shares',
    ],
    rpcs: [
      'schedule_team_member_hourly_rate', 'record_team_member_payout', 'resolve_team_member_hourly_rate',
      'validate_team_member_payout', 'set_retainer_shares', 'set_invoice_line_shares',
    ],
    routes: [],
  },
  webhooks: {
    tables: ['webhook_endpoints', 'webhook_events', 'webhook_deliveries'],
    rpcs: ['claim_webhook_deliveries', 'complete_webhook_delivery', 'requeue_webhook_delivery', 'webhook_retry_kick'],
    routes: ['api/internal/webhooks', 'webhooks/docs'],
  },
  contacts: {
    tables: ['contacts', 'contact_emails', 'project_contacts'],
    rpcs: ['contact_is_live'],
    routes: ['api/v1/contacts', 'api/v1/projects/[id]/contacts', '(protected)/contacts'],
  },
  sales: {
    tables: ['leads', 'lead_contacts', 'lead_fields', 'lead_interactions', 'lead_members', 'lead_proposals'],
    rpcs: ['can_access_lead', 'lead_is_live'],
    routes: ['api/v1/leads', '(protected)/leads'],
  },
  portal: {
    tables: ['portal_settings', 'portal_events', 'portal_updates', 'portal_update_attachments'],
    rpcs: ['portal_update_is_live'],
    routes: ['api/portal', 'api/v1/projects/[id]/portal', 'api/projects/[id]/portal-analytics', 'portal'],
  },
  inbox: {
    tables: [
      'client_communications',
      'answers', 'attachments', 'client_addresses',
      'client_domains', 'conversation_projects', 'conversations',
      'endpoints', 'files', 'ignored_addresses',
      'inbox_access', 'inboxes', 'maintenance_runs',
      'meetings', 'message_candidates', 'message_endpoints',
      'messages', 'own_domains', 'participants',
      'plan_items', 'plans', 'reply_drafts',
      'reply_points', 'sender_rules', 'task_links',
      'triage',
    ],
    rpcs: ['can_read_inbox', 'can_read_message', 'can_manage_inbox'],
    routes: [
      'api/v1/inbound-emails', 'api/v1/inbox', 'api/v1/projects/[id]/communications',
      'api/v1/projects/[id]/client-notifications', 'api/v1/tasks/[id]/emails', 'api/v1/tasks/[id]/messages',
      'api/projects/[id]/client-communications',
      // The mail webhook keeps storing with the Inbox off; nothing acts on it until it is back on.
      'api/inbound-email', 'api/internal/inbound-email',
      'api/workspace/inbox', 'api/workspace/email-addresses', 'api/workspace/email-domains', 'api/workspace/email-inboxes',
      'api/workspace/my-inbox',
      'api/workspace/projects/[id]/email-addresses', 'api/workspace/projects/[id]/email-domains',
      'api/workspace/projects/[id]/email-senders', 'api/workspace/tasks/[id]/source-emails',
      '(protected)/inbox',
      '(protected)/settings/(sections)/email/addresses', '(protected)/settings/(sections)/email/handler',
      '(protected)/settings/(sections)/email/rules', '(protected)/settings/(sections)/email/inbox',
      '(protected)/settings/(sections)/email/personal',
    ],
  },
  credentials: {
    tables: ['project_credentials', 'project_credential_members'],
    rpcs: ['get_accessible_credential_metadata', 'can_access_credential', 'set_credential_members', 'credential_is_live'],
    routes: ['api/credentials', 'api/v1/projects/[id]/credentials', 'api/workspace/credentials'],
  },
  agents: {
    tables: [
      'agent_health', 'agent_health_history', 'agent_activities', 'project_goals', 'task_suggestions',
      'agent_billing_gap_reviews', 'analytics_tracking_starts', 'task_reopens',
    ],
    rpcs: [],
    routes: [
      'api/v1/agent-activities', 'api/v1/agents', 'api/v1/projects/[id]/goals', 'api/v1/task-suggestions',
      'api/live', 'live', '(protected)/agent',
    ],
  },
};

/** Routes that serve several modules and check each part's module inside. */
export const SHARED_ROUTES: Array<{ route: string; modules: ModuleId[] }> = [
  // Pay (Team pay) and time approvals (Time tracking) on one page.
  { route: 'api/workspace/payroll', modules: ['team_pay', 'time'] },
  // Finances: company revenue and invoices (Client invoicing), payroll and
  // earnings (Team pay), the timesheet (Time tracking). The layout gates on
  // Time, which both money modules need; each tab checks its own module.
  { route: '(protected)/finances', modules: ['billing', 'team_pay', 'time'] },
];

/** Always on: what every workspace has. */
export const CORE_ROUTES: string[] = [
  'api/[...unknown]', 'api/brand', 'api/docs', 'api/email-preview', 'api/encryption', 'api/logo', 'api/mcp', 'api/notifications',
  'api/smtp', 'api/team-members', 'api/whats-my-ip', 'api/youtube',
  'api/v1/activities', 'api/v1/audit-log', 'api/v1/entity-files', 'api/v1/notifications', 'api/v1/reminders',
  'api/v1/tasks', 'api/v1/team-members', 'api/v1/projects',
  'api/workspace/access', 'api/workspace/api-keys', 'api/workspace/brand', 'api/workspace/me', 'api/workspace/region', 'api/workspace/modules', 'api/workspace/setup-checks', 'api/workspace/secrets', 'api/workspace/encryption', 'api/workspace/webhook-retries', 'api/welcome',
  'api/workspace/projects', 'api/workspace/tasks', 'api/workspace/team-directory', 'api/workspace/team-members',
  'api/workspace/updates',
  // The install's own routes and pages (src/custom): each item names its own module, permission or role.
  'api/x', '(protected)/x',
  '(protected)/dashboard', '(protected)/my-tasks', '(protected)/notifications', '(protected)/projects',
  '(protected)/reminders', '(protected)/settings', '(protected)/team', '(protected)/welcome',
  // Public and developer pages.
  'smtp/docs', '(dashboard)/email-preview', 'dev',
];

/** Core tables: projects, tasks, team, files, reminders, settings, keys, context, audit. */
export const CORE_TABLES: string[] = [
  'activities', 'api_audit_log', 'api_keys', 'api_rate_limit_windows', 'business_settings', 'entity_files',
  'permission_modules', 'project_context', 'project_members', 'projects', 'reminders', 'role_permissions',
  'smtp_accounts', 'task_acceptance_criteria', 'task_assignees', 'task_comments', 'task_dependencies',
  'task_events', 'task_files', 'task_reviews', 'task_subtasks', 'task_views', 'tasks',
  'team_invites', 'team_member_notifications', 'team_member_permissions', 'team_members', 'trash_events', 'workspace_brand',
  'workspace_modules', 'workspace_region', 'app_secrets',
];

/** Core functions a signed-in member may call. */
export const CORE_RPCS: string[] = [
  'is_admin', 'get_team_directory', 'current_team_member_role', 'current_team_member_id', 'has_permission',
  'module_enabled', 'get_my_access_context', 'can_access_project', 'can_access_task', 'can_read_all_tasks',
  'can_read_task_row', 'can_manage_task', 'can_access_file_entity', 'can_read_activity', 'can_see_reminder',
  'activity_member_name', 'activity_actor', 'workspace_today', 'consume_api_rate_limit',
  'list_trash', 'can_trash_record', 'soft_delete_record', 'restore_record', 'trash_restore_blocker',
  'trash_delete_blocker', 'project_is_live', 'task_is_live', 'file_entity_is_live',
  // The workspace region: the currency new money is stamped with, and amounts as the app writes them.
  'workspace_currency', 'format_money',
];

/**
 * "Is this row live" predicates used inside RLS policies. Each answers one
 * boolean about an id the caller already has, never a module's data, so
 * they carry no module check of their own: the policies they serve do.
 */
export const LIVENESS_RPCS: ReadonlySet<string> = new Set([
  'time_entry_is_live', 'invoice_is_live', 'retainer_is_live', 'contact_is_live', 'lead_is_live',
  'portal_update_is_live', 'credential_is_live', 'project_is_live', 'task_is_live', 'file_entity_is_live',
]);

/** Whether `dir` is `prefix` or lies beneath it. */
function under(dir: string, prefix: string): boolean {
  return dir === prefix || dir.startsWith(`${prefix}/`);
}

export type RouteOwner =
  | { kind: 'module'; module: ModuleId; prefix: string }
  | { kind: 'shared'; modules: ModuleId[]; prefix: string }
  | { kind: 'core'; prefix: string };

/**
 * Who a route folder (relative to src/app, e.g. "api/v1/leads/[id]")
 * belongs to: the longest claiming folder wins, so a module's folder inside
 * a core one (time entries under projects) is the module's. Null when
 * nothing claims it.
 */
export function routeOwner(dir: string): RouteOwner | null {
  const claims: RouteOwner[] = [
    ...MODULE_IDS.flatMap((module) => MODULE_SURFACES[module].routes.map((prefix): RouteOwner => ({ kind: 'module', module, prefix }))),
    ...SHARED_ROUTES.map(({ route, modules }): RouteOwner => ({ kind: 'shared', modules, prefix: route })),
    ...CORE_ROUTES.map((prefix): RouteOwner => ({ kind: 'core', prefix })),
  ];
  let best: RouteOwner | null = null;
  for (const claim of claims) {
    if (under(dir, claim.prefix) && (!best || claim.prefix.length > best.prefix.length)) best = claim;
  }
  return best;
}

/** Every route folder claimed, with who claims it, for the duplicate check. */
export function routeClaims(): Array<{ prefix: string; owner: string }> {
  return [
    ...MODULE_IDS.flatMap((module) => MODULE_SURFACES[module].routes.map((prefix) => ({ prefix, owner: module }))),
    ...SHARED_ROUTES.map(({ route, modules }) => ({ prefix: route, owner: `shared:${modules.join('+')}` })),
    ...CORE_ROUTES.map((prefix) => ({ prefix, owner: 'core' })),
  ];
}
