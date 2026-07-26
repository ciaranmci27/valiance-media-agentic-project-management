export const TEAM_ROLES = ['owner', 'admin', 'member', 'guest', 'agent'] as const;
export type TeamRole = typeof TEAM_ROLES[number];

export const MEMBER_STATUSES = ['active', 'suspended'] as const;
export type MemberStatus = typeof MEMBER_STATUSES[number];

export const PERMISSIONS = [
  'team.read',
  'team.manage',
  'access.manage',
  'settings.manage',
  'smtp.manage',
  'audit.read',
  'api_keys.manage_all',
  'webhooks.manage',
  'notifications.manage_own',
  'projects.read',
  'projects.read_all',
  'projects.manage',
  'project_members.manage',
  'tasks.read',
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
  'credentials.reveal_shared',
  'credentials.manage',
  'invoices.read',
  'invoices.manage',
  'billing.manage',
  'finance.company.read',
  'earnings.own.read',
  'compensation.manage',
  'payouts.manage',
  'agents.manage',
  'project_context.read',
  'project_context.manage',
  'goals.read',
  'goals.manage',
  'suggestions.create',
  'suggestions.manage',
  'agent_activity.write',
] as const;

export type PermissionKey = typeof PERMISSIONS[number];

export const API_ENDPOINT_PERMISSIONS = [
  'team.read', 'team.manage', 'audit.read', 'notifications.manage_own',
  'projects.read', 'projects.read_all', 'projects.manage', 'project_members.manage',
  'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'tasks.manage_all',
  'time.manage_own', 'time.read_all', 'time.manage_all', 'time.approve',
  'contacts.read', 'contacts.read_all', 'contacts.manage',
  'leads.read', 'leads.read_all', 'leads.manage',
  'files.read', 'files.upload', 'files.manage',
  'portal.read', 'portal.manage', 'communications.read', 'communications.manage',
  'credentials.reveal_shared', 'credentials.manage',
  'invoices.read', 'invoices.manage', 'billing.manage', 'agents.manage',
  'project_context.read', 'project_context.manage', 'goals.read', 'goals.manage',
  'suggestions.create', 'suggestions.manage', 'agent_activity.write',
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
}

export const EMPTY_ACCESS_CONTEXT: AccessContext | null = null;

export function hasPermission(
  access: AccessContext | null | undefined,
  permission: PermissionKey,
  channel: AccessChannel = 'app',
): boolean {
  if (!access || access.status !== 'active') return false;
  const permissions = channel === 'app' ? access.app_permissions : access.api_permissions;
  return permissions.includes('*') || permissions.includes(permission);
}

export function canAccessProject(
  access: AccessContext | null | undefined,
  projectId: string,
): boolean {
  if (!access || access.status !== 'active') return false;
  return hasPermission(access, 'projects.read_all')
    || (hasPermission(access, 'projects.read') && access.project_ids.includes(projectId));
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
      { key: 'access.manage', label: 'Manage access', description: 'Change role defaults and individual overrides. Owner-only in practice.' },
      { key: 'settings.manage', label: 'Business settings', description: 'Manage workspace and invoice identity settings.' },
      { key: 'smtp.manage', label: 'Email settings', description: 'Manage SMTP accounts and outbound email configuration.' },
      { key: 'audit.read', label: 'View audit log', description: 'Review security and API activity.' },
      { key: 'api_keys.manage_all', label: 'Manage all API keys', description: 'Inspect, disable, and revoke every member key.' },
      { key: 'webhooks.manage', label: 'Manage webhooks', description: 'Create, edit, and remove outbound webhook endpoints and view deliveries.' },
      { key: 'notifications.manage_own', label: 'Manage own notifications', description: 'Read and update only the member\'s own notifications through the API.' },
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
      { key: 'project_context.read', label: 'View project context', description: 'Read saved context for accessible projects.' },
      { key: 'project_context.manage', label: 'Manage project context', description: 'Create and edit project context.' },
      { key: 'goals.read', label: 'View goals', description: 'View agent goals.' },
      { key: 'goals.manage', label: 'Manage goals', description: 'Create and manage agent goals.' },
      { key: 'suggestions.create', label: 'Propose suggestions', description: 'Create and update the member\'s own agent suggestions.' },
      { key: 'suggestions.manage', label: 'Manage suggestions', description: 'Review and act on agent suggestions.' },
      { key: 'agent_activity.write', label: 'Log agent activity', description: 'Allow an AI agent to record its own activity through the API.' },
    ],
  },
];
