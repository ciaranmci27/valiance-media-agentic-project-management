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
  'audit.export',
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
  'approvals.decide',
  'questions.ask',
  'templates.manage',
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
  'chat.notify',
  'project_context.read',
  'project_context.manage',
  'context.memory',
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
  // Deciding, over the API, an approval that names a person (or as the Owner's
  // override): a person adds it to their own key on purpose. Admins and
  // members hold it on the API, no key carries it by default, no agent holds
  // it, and a connected AI tool never decides one.
  'approvals.decide',
  // Asking a person a question or for an approval that names no task or
  // project, without tasks.read (an agent that works in another system).
  // Admins, members and agents hold it on the API, so whoever hires an agent
  // can hand it on; no key carries it by default. tasks.read still allows
  // asking too.
  'questions.ask',
  // Task templates: the library and its playbooks (using one needs tasks.create). Owners and Admins by default.
  'templates.manage',
  'time.manage_own', 'time.read_all', 'time.manage_all', 'time.approve',
  'contacts.read', 'contacts.read_all', 'contacts.manage',
  'leads.read', 'leads.read_all', 'leads.manage',
  'files.read', 'files.upload', 'files.manage',
  'portal.read', 'portal.manage', 'communications.read', 'communications.manage',
  'inbound_email.read', 'inbound_email.triage', 'inbound_email.signal',
  'credentials.reveal_shared', 'credentials.manage',
  'invoices.read', 'invoices.manage', 'invoices.record_payments', 'billing.manage', 'agents.manage',
  'project_context.read', 'project_context.manage', 'goals.read', 'goals.manage',
  // A person's own memory (context scope member) through their own key or a connected AI tool.
  'context.memory',
  'suggestions.create', 'suggestions.manage', 'agent_activity.write', 'fleet_alerts.write',
  'meetings.write',
  // Setting up an agent from a chat (POST /api/v1/api-keys, /api/v1/webhook-endpoints).
  // No role holds either on the api channel by default; an Owner's key can.
  'api_keys.manage_all', 'webhooks.manage',
  // Groups, linked identities and acting for a person (a chat harness). Owners only by default.
  'groups.manage', 'identities.link', 'identities.read', 'agents.act_for',
  // A company agent DMs a member who did not ask (an unprompted alert). No role holds it by default.
  'chat.notify',
  // Every agent event and run, in order, for a data system (GET /api/v1/agent-events/export). No role holds it by default.
  'agent_events.export',
  // A harness that runs people's personal agents: lists them and collects each one's key once. No role but Owner
  // (who holds every permission) has it, and it works only on a key that carries it, which an Owner makes for the
  // assistant service (Settings > Assistants). By hand, POST /api/v1/api-keys never makes a key for someone else's assistant.
  'assistants.provision',
  // Every audit row, in order, for a compliance or data system (GET /api/v1/audit/export). Owners only by default.
  'audit.export',
] as const satisfies readonly PermissionKey[];

export const API_ENDPOINT_PERMISSION_SET = new Set<PermissionKey>(API_ENDPOINT_PERMISSIONS);

/**
 * The broader permissions that imply each one: whoever holds one on the
 * right may do what the one on the left allows (withApi accepts either, and
 * the permission grid turns the left one on with them). Viewing all projects
 * or managing them implies viewing assigned ones, managing all tasks implies
 * viewing and managing assigned ones, and so on.
 */
export const PERMISSION_IMPLIED_BY: Partial<Record<PermissionKey, readonly PermissionKey[]>> = {
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
  'invoices.record_payments': ['invoices.manage'],
  'project_context.read': ['project_context.manage'],
  'goals.read': ['goals.manage'],
};
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
      { key: 'team.read', label: 'View team', description: 'See who is on the team and how to reach them.' },
      { key: 'team.manage', label: 'Manage team', description: 'Invite people, change their details, and suspend or bring back anyone but an Owner.' },
      { key: 'groups.manage', label: 'Manage groups', description: 'Make groups and choose who is in them. Powerful: a group can own agents and decide approvals, so whoever has this can add themselves to one.' },
      { key: 'identities.link', label: 'Link chat accounts', description: 'Send a person a one-time link to connect their Slack, Teams or Telegram account. For the key of a chat connection.' },
      { key: 'identities.read', label: 'Look up chat accounts', description: 'Find which person a connected chat account belongs to, and how to reach a person or group in chat. For the key of a chat connection.' },
      { key: 'access.manage', label: 'Manage access', description: 'Change role defaults and individual permissions in Roles & permissions, for everyone but Owners and never their own. Powerful: they can give others any permission. Only an Owner gives this one.' },
      { key: 'settings.manage', label: 'Business settings', description: 'Change workspace settings and the business details printed on invoices.' },
      { key: 'smtp.manage', label: 'Email settings', description: 'Set up the email accounts the workspace sends from.' },
      { key: 'audit.read', label: 'View audit log', description: 'See the full history of changes on every project, in activity feeds and through a key. The audit log in Settings stays with Owners.' },
      { key: 'audit.export', label: 'Export audit log', description: 'Let a key copy every audit log row, in order, into a compliance or reporting system. Read only. Owners have it; no other role does unless an Owner gives it.' },
      { key: 'api_keys.manage_all', label: 'Manage all API keys', description: 'See, edit and revoke everyone\'s API keys.' },
      { key: 'webhooks.manage', label: 'Manage webhooks', description: 'Add, change and remove webhooks that send events to other systems, and see what was sent.' },
      { key: 'notifications.manage_own', label: 'Manage own notifications', description: 'Let a key read and clear its own person\'s notifications.' },
      { key: 'notifications.send', label: 'Send notifications', description: 'Let a key send in-app notifications, such as an agent asking an Owner for help.' },
      { key: 'reminders.manage_own', label: 'Manage reminders', description: 'Let a key add, change and tick off reminders its person owns or wrote, and shared ones on projects they can open. An agent may write one for someone else.' },
    ],
  },
  {
    id: 'projects',
    label: 'Projects and work',
    permissions: [
      { key: 'projects.read', label: 'View assigned projects', description: 'See the projects they are added to.' },
      { key: 'projects.read_all', label: 'View all projects', description: 'See every project, including ones they are not added to.' },
      { key: 'projects.manage', label: 'Manage projects', description: 'Create, edit, archive and delete projects.' },
      { key: 'project_members.manage', label: 'Assign project members', description: 'Choose who is added to a project.' },
      { key: 'tasks.read', label: 'View tasks', description: 'See every task in the projects they can open.' },
      { key: 'tasks.read_assigned', label: 'View assigned tasks', description: 'Without View tasks, see only the tasks assigned to them or that they created. In the app only.' },
      { key: 'tasks.create', label: 'Create tasks', description: 'Create tasks in the projects they can open.' },
      { key: 'tasks.manage_assigned', label: 'Manage assigned tasks', description: 'Edit tasks assigned to them.' },
      { key: 'tasks.manage_all', label: 'Manage all tasks', description: 'Edit any task in the projects they can open.' },
      { key: 'approvals.decide', label: 'Decide approvals over the API', description: 'Let a key approve or reject a request that names this person (for an Owner, any request), as if they clicked it. Without it, they decide in the app. A key gets it only when its person adds it, and a connected AI tool never does.' },
      { key: 'questions.ask', label: 'Ask people', description: 'Let a key ask people a question, or ask for an approval, that is not tied to a task or project. For an agent that works in another system.' },
      { key: 'templates.manage', label: 'Manage templates', description: 'Create, edit and remove task templates for everyone. Using a template only needs Create tasks.' },
      { key: 'time.manage_own', label: 'Manage own time', description: 'Track and edit their own time until it is approved.' },
      { key: 'time.read_all', label: 'View all time', description: 'See everyone\'s time entries.' },
      { key: 'time.manage_all', label: 'Manage all time', description: 'Edit everyone\'s time entries.' },
      { key: 'time.approve', label: 'Approve time', description: 'Approve or reject submitted time, except their own.' },
    ],
  },
  {
    id: 'client',
    label: 'Client operations',
    permissions: [
      { key: 'contacts.read', label: 'View work contacts', description: 'See contacts linked to the projects they are on.' },
      { key: 'contacts.read_all', label: 'View all contacts', description: 'See every contact.' },
      { key: 'contacts.manage', label: 'Manage contacts', description: 'Add, edit and remove contacts.' },
      { key: 'leads.read', label: 'View assigned leads', description: 'See the leads assigned to them.' },
      { key: 'leads.read_all', label: 'View all leads', description: 'See every lead.' },
      { key: 'leads.manage', label: 'Manage leads', description: 'Add and work sales leads.' },
      { key: 'files.read', label: 'View files', description: 'See files on work they can open.' },
      { key: 'files.upload', label: 'Upload files', description: 'Upload files to projects they can open.' },
      { key: 'files.manage', label: 'Manage all files', description: 'Rename, share and delete files on work they can open.' },
      { key: 'portal.read', label: 'View client portal', description: 'See client portal settings and content.' },
      { key: 'portal.manage', label: 'Manage client portal', description: 'Set up and publish the client portal.' },
      { key: 'communications.read', label: 'View communications', description: 'See the history of messages with clients.' },
      { key: 'communications.manage', label: 'Manage communications', description: 'Send and manage messages to clients.' },
      { key: 'inbound_email.read', label: 'View inbox', description: 'Read email in the shared inboxes they are given. Read only.' },
      { key: 'inbound_email.triage', label: 'Triage inbox email', description: 'Sort inbox email: mark threads handled, send them back to the agent, and set their project. Never sends email.' },
      { key: 'inbound_email.signal', label: 'Poll inbox signal', description: 'Let a key check for new mail, and how much, in the inboxes they are given.' },
      { key: 'inbound_email.manage', label: 'Manage email inboxes', description: 'Create shared inboxes, choose who reads them, and read them all. Can see and turn off personal inboxes, and reads them only while the workspace allows it.' },
      { key: 'inbound_email.personal', label: 'Connect your own inbox', description: 'Connect their own inbox, pick the agent that sorts it, and choose who else can read it.' },
    ],
  },
  {
    id: 'financial',
    label: 'Financial and sensitive',
    permissions: [
      { key: 'credentials.reveal_shared', label: 'Reveal shared credentials', description: 'Reveal the passwords and logins shared with them.' },
      { key: 'credentials.manage', label: 'Manage credentials', description: 'Add, reveal, share and delete project passwords and logins.' },
      { key: 'invoices.read', label: 'View invoices', description: 'See invoices and what clients are billed.' },
      { key: 'invoices.manage', label: 'Manage invoices', description: 'Create and edit invoices and set their status.' },
      { key: 'invoices.record_payments', label: 'Record invoice payments', description: 'Record and remove payments on sent invoices. For an accounting tool\'s key.' },
      { key: 'billing.manage', label: 'Manage billing rates', description: 'See and schedule client billing rates.' },
      { key: 'finance.company.read', label: 'View company finance', description: 'See revenue, costs and company profit.' },
      { key: 'earnings.own.read', label: 'View own earnings', description: 'See their own approved earnings and payments.' },
      { key: 'compensation.manage', label: 'Manage compensation', description: 'Schedule pay rates and adjustments.' },
      { key: 'payouts.manage', label: 'Manage payouts', description: 'Record team payments and how they are split.' },
    ],
  },
  {
    id: 'automation',
    label: 'Agents and automation',
    permissions: [
      { key: 'agents.manage', label: 'Manage agents', description: 'Set up AI agents, their rules and the projects they work on.' },
      { key: 'agents.act_for', label: 'Act for a person', description: 'Let an AI agent work on behalf of the person who asked it, limited to what both of them may do.' },
      { key: 'chat.notify', label: 'Message people unasked', description: 'Let a company AI agent message a person in chat who did not ask it, such as an alert or a report. Without it, it only answers people who write to it.' },
      { key: 'project_context.read', label: 'View project context', description: 'Read the saved notes and context on projects they can open.' },
      { key: 'project_context.manage', label: 'Manage project context', description: 'Write and edit project notes and context.' },
      { key: 'context.memory', label: 'Read and write my personal memory', description: 'Let a person\'s own key or connected AI tool read and add to what their assistant remembers about them. Never for agents.' },
      { key: 'goals.read', label: 'View goals', description: 'See agent goals.' },
      { key: 'goals.manage', label: 'Manage goals', description: 'Create and change agent goals.' },
      { key: 'suggestions.create', label: 'Propose suggestions', description: 'Let a key make and update its own suggestions for people to review.' },
      { key: 'suggestions.manage', label: 'Manage suggestions', description: 'Review, accept and turn down agent suggestions.' },
      { key: 'agent_activity.write', label: 'Log agent activity', description: 'Let an AI agent record what it did.' },
      { key: 'assistants.provision', label: 'Provision personal agents', description: 'For the key of the service that runs people\'s personal assistants: list them and collect each one\'s key once, so nobody handles those keys by hand.' },
      { key: 'agent_events.export', label: 'Export agent events', description: 'Let a key copy every agent event and run, in order, into a reporting or data system. Read only.' },
      { key: 'fleet_alerts.write', label: 'Post fleet alerts', description: 'For the key of the server that runs your agents, often an agent\'s own key: post alerts about the whole server, such as an agent that stopped. With this alone a key posts nothing else.' },
      { key: 'meetings.write', label: 'Post meetings', description: 'Let a person\'s meeting script post each meeting\'s transcript or notes into an inbox they can read. Never for agents.' },
    ],
  },
];

const PERMISSION_LABELS = new Map<string, string>(PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => [p.key, p.label] as const)));

/** A permission's plain label ("Manage webhooks"), or the key itself for one this build does not know. */
export function permissionLabel(key: string): string {
  return PERMISSION_LABELS.get(key) ?? key;
}

/** Keys in plain words, joined: "Manage webhooks, Decide approvals over the API". */
export function permissionLabels(keys: readonly string[]): string {
  return keys.map(permissionLabel).join(', ');
}

/**
 * Permissions the server honours only for a key (the api channel): ticking
 * one on the App channel would change nothing, so Roles & permissions does
 * not offer them there and tags them "Keys only" on API.
 */
export const KEY_ONLY_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'notifications.manage_own', 'reminders.manage_own', 'suggestions.create', 'agent_activity.write', 'fleet_alerts.write',
  'meetings.write', 'agent_events.export', 'audit.export', 'approvals.decide', 'questions.ask', 'chat.notify',
  'context.memory', 'agents.act_for', 'assistants.provision', 'identities.link', 'identities.read', 'inbound_email.signal',
  'notifications.send',
]);

/**
 * Permissions Roles & permissions never offers, because nothing reads them.
 * Empty today; a permission retired from use goes here (its stored rows stay).
 */
export const UNOFFERED_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([]);

/** The permissions the App channel offers: those the app itself checks. */
export const APP_CHANNEL_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>(
  PERMISSIONS.filter((key) => !KEY_ONLY_PERMISSIONS.has(key) && !UNOFFERED_PERMISSIONS.has(key)),
);

/** The channels Roles & permissions offers for a role: an agent never signs in, so it has only API. */
export function accessChannelsFor(role: TeamRole): AccessChannel[] {
  return role === 'agent' ? ['api'] : ['app', 'api'];
}

/**
 * Whether Roles & permissions offers a permission on a channel for a role:
 * App only where the app checks it, API only for API scopes, never one
 * nothing reads, and for the Agent role (or one agent) never one an agent
 * cannot use (neverForAgents: the agents' own list, NEVER_AGENT_SCOPES).
 */
export function permissionOffered(
  key: PermissionKey,
  channel: AccessChannel,
  role: TeamRole,
  neverForAgents: readonly PermissionKey[] = [],
): boolean {
  if (UNOFFERED_PERMISSIONS.has(key)) return false;
  if (!accessChannelsFor(role).includes(channel)) return false;
  if (channel === 'app') return APP_CHANNEL_PERMISSIONS.has(key);
  if (!API_ENDPOINT_PERMISSION_SET.has(key)) return false;
  return role !== 'agent' || !neverForAgents.includes(key);
}
