import { moduleOfPermission, type ModuleId } from '@/lib/modules/registry';

export const TEAM_ROLES = ['owner', 'admin', 'member', 'guest', 'agent'] as const;
export type TeamRole = typeof TEAM_ROLES[number];

export const MEMBER_STATUSES = ['active', 'suspended'] as const;
export type MemberStatus = typeof MEMBER_STATUSES[number];

export const PERMISSIONS = [
  'team.read',
  'team.manage',
  'groups.manage',
  'identities.link',
  'identities.read',
  'access.manage',
  'settings.manage',
  'smtp.manage',
  'audit.read',
  'api_keys.manage_all',
  'webhooks.manage',
  'notifications.manage_own',
  'notifications.send',
  'reminders.manage_own',
  'projects.read',
  'projects.read_all',
  'projects.manage',
  'project_members.manage',
  'tasks.read',
  'tasks.read_assigned',
  'tasks.create',
  'tasks.manage_assigned',
  'tasks.manage_all',
  'time.manage_own',
  'time.read_all',
  'time.manage_all',
  'time.approve',
  'contacts.read',
  'contacts.read_all',
  'contacts.manage',
  'leads.read',
  'leads.read_all',
  'leads.manage',
  'files.read',
  'files.upload',
  'files.manage',
  'portal.read',
  'portal.manage',
  'communications.read',
  'communications.manage',
  'inbound_email.read',
  'inbound_email.triage',
  'inbound_email.signal',
  'inbound_email.manage',
  'inbound_email.personal',
  'credentials.reveal_shared',
  'credentials.manage',
  'invoices.read',
  'invoices.manage',
  'invoices.record_payments',
  'billing.manage',
  'finance.company.read',
  'earnings.own.read',
  'compensation.manage',
  'payouts.manage',
  'agents.manage',
  'agents.act_for',
  'project_context.read',
  'project_context.manage',
  'goals.read',
  'goals.manage',
  'suggestions.create',
  'suggestions.manage',
  'agent_activity.write',
  'fleet_alerts.write',
  'meetings.write',
  'agent_events.export',
  'assistants.provision',
] as const;

export type PermissionKey = typeof PERMISSIONS[number];

export const API_ENDPOINT_PERMISSIONS = [
  'team.read', 'team.manage', 'audit.read', 'notifications.manage_own', 'notifications.send', 'reminders.manage_own',
  'projects.read', 'projects.read_all', 'projects.manage', 'project_members.manage',
  'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'tasks.manage_all',
  'time.manage_own', 'time.read_all', 'time.manage_all', 'time.approve',
  'contacts.read', 'contacts.read_all', 'contacts.manage',
  'leads.read', 'leads.read_all', 'leads.manage',
  'files.read', 'files.upload', 'files.manage',
  'portal.read', 'portal.manage', 'communications.read', 'communications.manage',
  'inbound_email.read', 'inbound_email.triage', 'inbound_email.signal',
  'credentials.reveal_shared', 'credentials.manage',
  'invoices.read', 'invoices.manage', 'invoices.record_payments', 'billing.manage', 'agents.manage',
  'project_context.read', 'project_context.manage', 'goals.read', 'goals.manage',
  'suggestions.create', 'suggestions.manage', 'agent_activity.write', 'fleet_alerts.write',
  'meetings.write',
  // Setting up an agent from a chat (POST /api/v1/api-keys, /api/v1/webhook-endpoints).
  // No role holds either on the api channel by default; an Owner's key can.
  'api_keys.manage_all', 'webhooks.manage',
  // Groups, linked identities and acting for a person (a chat harness). Owners only by default.
  'groups.manage', 'identities.link', 'identities.read', 'agents.act_for',
  // Every agent event and run, in order, for a data system (GET /api/v1/agent-events/export). No role holds it by default.
  'agent_events.export',
  // A harness that runs people's personal agents: lists them and collects each one's key once. No role holds it by default.
  'assistants.provision',
] as const satisfies readonly PermissionKey[];

export const API_ENDPOINT_PERMISSION_SET = new Set<PermissionKey>(API_ENDPOINT_PERMISSIONS);
export type AccessChannel = 'app' | 'api';
export type PermissionEffect = 'allow' | 'deny';

export interface AccessContext {
  member_id: string;
  role: TeamRole;
  status: MemberStatus;
  app_permissions: Array<PermissionKey | '*'>;
  api_permissions: Array<PermissionKey | '*'>;
  project_ids: string[];
  /**
   * The workspace's switched-on modules. A permission of a module that is off
   * is held by nobody, owners included. Absent (demo data, an older server)
   * means every module is on.
   */
  modules?: ModuleId[];
  /**
   * Set when an agent acts for a person (X-Act-For): that person's member id.
   * The permissions and project reach here are then the agent's and the
   * person's together (intersectAccess), never more than either.
   */
  principal_id?: string;
}

export const EMPTY_ACCESS_CONTEXT: AccessContext | null = null;

export function hasPermission(
  access: AccessContext | null | undefined,
  permission: PermissionKey,
  channel: AccessChannel = 'app',
): boolean {
  if (!access || access.status !== 'active') return false;
  if (!permissionModuleEnabled(access, permission)) return false;
  const permissions = channel === 'app' ? access.app_permissions : access.api_permissions;
  return permissions.includes('*') || permissions.includes(permission);
}

/** Whether a module is switched on for this workspace (core is always on). */
export function isModuleEnabled(access: AccessContext | null | undefined, id: ModuleId): boolean {
  return !access?.modules || access.modules.includes(id);
}

function permissionModuleEnabled(access: AccessContext, permission: PermissionKey): boolean {
  const mod = moduleOfPermission(permission);
  return mod === 'core' || isModuleEnabled(access, mod);
}

/**
 * The scopes a key for this member may carry: API endpoint permissions the
 * member holds on the api channel, in the order the API lists them. Creating
 * and editing a key both check against it.
 */
export function apiScopesFor(access: AccessContext | null | undefined): PermissionKey[] {
  return API_ENDPOINT_PERMISSIONS.filter((scope) => hasPermission(access, scope, 'api'));
}

/**
 * Who may edit a key's name and scopes: the member it acts as, or a holder
 * of api_keys.manage_all. A creator who is not the key's member may still
 * revoke it, but not change what it can do.
 */
export function canEditApiKey(
  access: AccessContext | null | undefined,
  memberId: string | null | undefined,
  key: { team_member_id: string | null },
): boolean {
  return (!!memberId && key.team_member_id === memberId) || hasPermission(access, 'api_keys.manage_all');
}

/**
 * May open the Inbox: reading or managing shared inboxes, or connecting your
 * own (a personal inbox needs no other inbox permission). Which inboxes it
 * shows is the server's call (inbox-visibility.ts).
 */
export function canOpenInbox(access: AccessContext | null | undefined): boolean {
  return hasPermission(access, 'inbound_email.read') || hasPermission(access, 'inbound_email.manage') || hasPermission(access, 'inbound_email.personal');
}

/** Either task read grant: every task in accessible projects, or only your own (RLS decides which rows). */
export function canReadTasks(access: AccessContext | null | undefined): boolean {
  return hasPermission(access, 'tasks.read') || hasPermission(access, 'tasks.read_assigned');
}

/** Mirrors tasks_update RLS: any task with manage_all, or your own with manage_assigned. */
export function canEditTask(
  access: AccessContext | null | undefined,
  task: { assignee_ids: string[] },
  memberId: string | null | undefined,
  /** For a subtask: whoever is on its parent may work it too, as the database allows. */
  parent?: { assignee_ids: string[] } | null,
): boolean {
  return hasPermission(access, 'tasks.manage_all')
    || (hasPermission(access, 'tasks.manage_assigned') && !!memberId
      && (task.assignee_ids.includes(memberId) || !!parent?.assignee_ids.includes(memberId)));
}

/**
 * Whether a member could open a task in this project once assigned. A task
 * assigned to someone who cannot see its project is invisible to them, and
 * assigning never adds anyone to a project. Members without a reach level
 * (demo data) are not filtered out.
 */
export function canBeAssignedInProject(
  member: { id: string; status?: string | null; project_access?: 'all' | 'member' | 'none' },
  project: { member_ids: string[] },
): boolean {
  if (member.status === 'suspended') return false;
  if (member.project_access === undefined || member.project_access === 'all') return true;
  return member.project_access === 'member' && project.member_ids.includes(member.id);
}

/** Deleting, and changing who a task is assigned to, need manage_all. */
export function canManageAllTasks(access: AccessContext | null | undefined): boolean {
  return hasPermission(access, 'tasks.manage_all');
}

export function canAccessProject(
  access: AccessContext | null | undefined,
  projectId: string,
): boolean {
  if (!access || access.status !== 'active') return false;
  return hasPermission(access, 'projects.read_all')
    || (hasPermission(access, 'projects.read') && access.project_ids.includes(projectId));
}

/** Both sides' grants: '*' is everything, so the other side decides. */
function intersectGrants(a: Array<PermissionKey | '*'>, b: Array<PermissionKey | '*'>): Array<PermissionKey | '*'> {
  // Viewing all projects implies viewing assigned ones, so either spelling meets the other.
  const widen = (list: Array<PermissionKey | '*'>): Array<PermissionKey | '*'> =>
    (list.includes('projects.read_all') && !list.includes('projects.read') ? [...list, 'projects.read'] : list);
  const left = widen(a);
  const right = widen(b);
  if (left.includes('*')) return [...right];
  if (right.includes('*')) return [...left];
  const keep = new Set(right);
  return left.filter((permission) => keep.has(permission));
}

/**
 * Whether a context reaches every project through the API: the API channel
 * only. Acting for someone is always an API request, so a read_all held on
 * the app channel alone must never widen it.
 */
const readsAllProjects = (access: AccessContext) =>
  access.api_permissions.includes('*') || access.api_permissions.includes('projects.read_all');

/**
 * What an agent may do while acting for a person (X-Act-For): every
 * permission both hold, on each channel, and only the projects both reach (a
 * side with projects.read_all on its API channel reaches every project). Active only while both
 * are. It stays the agent's own context (member, role, modules), with
 * principal_id naming the person. Pure, so the API and MCP share one rule.
 */
export function intersectAccess(agent: AccessContext, principal: AccessContext): AccessContext {
  let projectIds: string[];
  if (readsAllProjects(agent) && readsAllProjects(principal)) projectIds = [...new Set([...agent.project_ids, ...principal.project_ids])];
  else if (readsAllProjects(agent)) projectIds = [...principal.project_ids];
  else if (readsAllProjects(principal)) projectIds = [...agent.project_ids];
  else {
    const theirs = new Set(principal.project_ids);
    projectIds = agent.project_ids.filter((id) => theirs.has(id));
  }
  return {
    member_id: agent.member_id,
    role: agent.role,
    status: agent.status === 'active' && principal.status === 'active' ? 'active' : 'suspended',
    app_permissions: intersectGrants(agent.app_permissions, principal.app_permissions),
    api_permissions: intersectGrants(agent.api_permissions, principal.api_permissions),
    project_ids: projectIds,
    ...(agent.modules ? { modules: agent.modules } : {}),
    principal_id: principal.member_id,
  };
}

export const PERMISSION_GROUPS: Array<{
  id: string;
  label: string;
  permissions: Array<{ key: PermissionKey; label: string; description: string }>;
}> = [
  {
    id: 'workspace',
    label: 'Workspace',
    permissions: [
      { key: 'team.read', label: 'View team', description: 'View the safe team directory.' },
      { key: 'team.manage', label: 'Manage team', description: 'Invite, edit, suspend, and reactivate non-Owner members.' },
      { key: 'groups.manage', label: 'Manage groups', description: 'Create, edit, and remove groups, and choose who is in them. A power permission: a group can own agents and decide approvals, so whoever holds this can add themselves to those groups. Anyone who can view the team sees groups.' },
      { key: 'identities.link', label: 'Link chat accounts', description: 'Ask a person to link a chat account (Slack, Teams, Telegram) through a one-time sign-in link. Meant for a chat harness key.' },
      { key: 'identities.read', label: 'Look up chat accounts', description: 'Find which member a verified chat account belongs to, and how to reach a member or group. Meant for a chat harness key.' },
      { key: 'access.manage', label: 'Manage access', description: 'Change role defaults and individual overrides. Owner-only in practice.' },
      { key: 'settings.manage', label: 'Business settings', description: 'Manage workspace and invoice identity settings.' },
      { key: 'smtp.manage', label: 'Email settings', description: 'Manage SMTP accounts and outbound email configuration.' },
      { key: 'audit.read', label: 'View audit log', description: 'Review security and API activity.' },
      { key: 'api_keys.manage_all', label: 'Manage all API keys', description: 'Inspect, edit, disable, and revoke every member key.' },
      { key: 'webhooks.manage', label: 'Manage webhooks', description: 'Create, edit, and remove outbound webhook endpoints and view deliveries.' },
      { key: 'notifications.manage_own', label: 'Manage own notifications', description: 'Read and update only the member\'s own notifications through the API.' },
      { key: 'notifications.send', label: 'Send notifications', description: 'Send in-app notifications to the Owner (agent questions and escalations).' },
      { key: 'reminders.manage_own', label: 'Manage reminders', description: 'Read, add, tick off and change reminders through the API: reminders the member owns or wrote, and shared ones on projects it can open. An agent may write one for someone else.' },
    ],
  },
  {
    id: 'projects',
    label: 'Projects and work',
    permissions: [
      { key: 'projects.read', label: 'View assigned projects', description: 'View projects assigned to the member.' },
      { key: 'projects.read_all', label: 'View all projects', description: 'Bypass project assignment for project reads.' },
      { key: 'projects.manage', label: 'Manage projects', description: 'Create, edit, archive, and delete projects.' },
      { key: 'project_members.manage', label: 'Assign project members', description: 'Change which people can access a project.' },
      { key: 'tasks.read', label: 'View tasks', description: 'View tasks inside accessible projects.' },
      { key: 'tasks.read_assigned', label: 'View assigned tasks', description: 'Without View tasks, see only tasks assigned to (or created by) the member inside accessible projects. App only.' },
      { key: 'tasks.create', label: 'Create tasks', description: 'Create tasks inside accessible projects.' },
      { key: 'tasks.manage_assigned', label: 'Manage assigned tasks', description: 'Edit tasks assigned to the member.' },
      { key: 'tasks.manage_all', label: 'Manage all tasks', description: 'Edit any task in accessible projects.' },
      { key: 'time.manage_own', label: 'Manage own time', description: 'Track and edit personal unapproved time.' },
      { key: 'time.read_all', label: 'View all time', description: 'View other members time entries.' },
      { key: 'time.manage_all', label: 'Manage all time', description: 'Edit other members time entries.' },
      { key: 'time.approve', label: 'Approve time', description: 'Approve or reject submitted time, excluding personal entries.' },
    ],
  },
  {
    id: 'client',
    label: 'Client operations',
    permissions: [
      { key: 'contacts.read', label: 'View work contacts', description: 'View contacts linked to assigned projects.' },
      { key: 'contacts.read_all', label: 'View all contacts', description: 'View contacts outside assigned projects.' },
      { key: 'contacts.manage', label: 'Manage contacts', description: 'Create, edit, and remove contacts.' },
      { key: 'leads.read', label: 'View assigned leads', description: 'View leads assigned to the member.' },
      { key: 'leads.read_all', label: 'View all leads', description: 'View every lead in the workspace.' },
      { key: 'leads.manage', label: 'Manage leads', description: 'Create and manage sales leads.' },
      { key: 'files.read', label: 'View files', description: 'View files attached to accessible work.' },
      { key: 'files.upload', label: 'Upload files', description: 'Upload files to accessible projects.' },
      { key: 'files.manage', label: 'Manage all files', description: 'Rename, share, and delete files from accessible work.' },
      { key: 'portal.read', label: 'View client portal', description: 'View portal settings and content.' },
      { key: 'portal.manage', label: 'Manage client portal', description: 'Configure and publish client portal content.' },
      { key: 'communications.read', label: 'View communications', description: 'View client communication history.' },
      { key: 'communications.manage', label: 'Manage communications', description: 'Send and manage client communications.' },
      { key: 'inbound_email.read', label: 'View inbox', description: 'Read email in the shared inboxes granted to the member, read only. Through the API, only those inboxes.' },
      { key: 'inbound_email.triage', label: 'Triage inbox email', description: 'Record triage on inbox email and label attachments through the API. In the app, mark threads handled, send them back to the agent, and set the project of a thread. Never sends email.' },
      { key: 'inbound_email.signal', label: 'Poll inbox signal', description: 'Read new-mail and summary counts for granted inboxes through the API.' },
      { key: 'inbound_email.manage', label: 'Manage email inboxes', description: 'Create and edit shared inboxes and who can read them, and read every shared inbox. Sees that personal inboxes exist and can turn them off, but reads them only while the workspace allows it.' },
      { key: 'inbound_email.personal', label: 'Connect your own inbox', description: 'Connect, change and remove your own personal inboxes, pick the agent that sorts them, and choose who else can read them.' },
    ],
  },
  {
    id: 'financial',
    label: 'Financial and sensitive',
    permissions: [
      { key: 'credentials.reveal_shared', label: 'Reveal shared credentials', description: 'Reveal credentials explicitly shared with the member.' },
      { key: 'credentials.manage', label: 'Manage credentials', description: 'Create, reveal, share, and delete project credentials.' },
      { key: 'invoices.read', label: 'View invoices', description: 'View invoices and client billing amounts.' },
      { key: 'invoices.manage', label: 'Manage invoices', description: 'Create, edit, and record invoice status.' },
      { key: 'invoices.record_payments', label: 'Record invoice payments', description: 'Record and remove payments received against sent invoices. Meant for the API key of an accounting tool.' },
      { key: 'billing.manage', label: 'Manage billing rates', description: 'View and schedule client billing rates.' },
      { key: 'finance.company.read', label: 'View company finance', description: 'View revenue, costs, and company profit.' },
      { key: 'earnings.own.read', label: 'View own earnings', description: 'View personal approved earnings and payment history.' },
      { key: 'compensation.manage', label: 'Manage compensation', description: 'Schedule employee rates and adjustments.' },
      { key: 'payouts.manage', label: 'Manage payouts', description: 'Record and allocate team payments.' },
    ],
  },
  {
    id: 'automation',
    label: 'Agents and automation',
    permissions: [
      { key: 'agents.manage', label: 'Manage agents', description: 'Configure AI agent behavior and assignments.' },
      { key: 'agents.act_for', label: 'Act for a person', description: 'Allow an AI agent to act for the person who asked it (X-Act-For), within that person\'s access and its own.' },
      { key: 'project_context.read', label: 'View project context', description: 'Read saved context for accessible projects.' },
      { key: 'project_context.manage', label: 'Manage project context', description: 'Create and edit project context.' },
      { key: 'goals.read', label: 'View goals', description: 'View agent goals.' },
      { key: 'goals.manage', label: 'Manage goals', description: 'Create and manage agent goals.' },
      { key: 'suggestions.create', label: 'Propose suggestions', description: 'Create and update the member\'s own agent suggestions.' },
      { key: 'suggestions.manage', label: 'Manage suggestions', description: 'Review and act on agent suggestions.' },
      { key: 'agent_activity.write', label: 'Log agent activity', description: 'Allow an AI agent to record its own activity through the API.' },
      { key: 'assistants.provision', label: 'Provision personal agents', description: 'Allow the key of the harness that runs people\'s personal agents to list them and collect each one\'s key once, so nobody handles those keys by hand. An Owner\'s key carries it; no role holds it by default.' },
      { key: 'agent_events.export', label: 'Export agent events', description: 'Allow a data system key to read every agent event and run, in order, from a resumable cursor (GET /api/v1/agent-events/export). Read only.' },
      { key: 'fleet_alerts.write', label: 'Post fleet alerts', description: 'Allow a host key to record fleet-wide alerts that name no agent. A key with this scope posts nothing else.' },
      { key: 'meetings.write', label: 'Post meetings', description: 'Allow a teammate\'s meeting script to post each meeting (transcript or notes) into an inbox they can read. Never an agent\'s key.' },
    ],
  },
];
