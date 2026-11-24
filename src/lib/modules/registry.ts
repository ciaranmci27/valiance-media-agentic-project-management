import type { PermissionKey } from '@/lib/access-control';

/**
 * The parts of the app a workspace can switch on or off. Core (projects,
 * tasks, team, notifications, reminders, settings, API keys) is always on and
 * has no id here.
 *
 * One rule enforces a module everywhere: a permission whose module is off is
 * held by nobody, owners included. The database applies it in
 * `has_permission()` (so RLS, RPCs and the API agree), and `hasPermission()`
 * applies it in the app. Switching a module off hides it; nothing is deleted.
 *
 * Adding a module or a permission: add it here, then seed
 * `pm.workspace_modules` / `pm.permission_modules` in the same
 * release's migration (a module needs its row: the app counts a missing row
 * as on, `get_my_access_context()` as off). `npm run test:modules` fails until
 * the two agree.
 */
export const MODULE_IDS = [
  'time',
  'billing',
  'team_pay',
  'contacts',
  'sales',
  'portal',
  'inbox',
  'agents',
  'credentials',
  'webhooks',
] as const;

export type ModuleId = typeof MODULE_IDS[number];

export type ModuleGroup = 'work' | 'clients' | 'money' | 'communication' | 'automation';

export interface ModuleDefinition {
  id: ModuleId;
  /** What people call it, used everywhere the module is named. */
  label: string;
  /** One plain line on what it is for. */
  description: string;
  /** The places in the app it adds, named the way the app names them. */
  adds: string[];
  group: ModuleGroup;
  /** Modules this one cannot work without. Turning this on turns them on. */
  dependsOn: ModuleId[];
}

export const MODULE_GROUPS: Array<{ id: ModuleGroup; label: string }> = [
  { id: 'work', label: 'Work' },
  { id: 'clients', label: 'Clients and sales' },
  { id: 'money', label: 'Money' },
  { id: 'communication', label: 'Communication' },
  { id: 'automation', label: 'Automation' },
];

export const MODULES: Record<ModuleId, ModuleDefinition> = {
  time: {
    id: 'time',
    label: 'Time tracking',
    description: "Track hours on projects with timers and manual entries, and see your week and your team's.",
    adds: ['Time tracking tab on projects', 'Timers', 'Timesheet'],
    group: 'work',
    dependsOn: [],
  },
  credentials: {
    id: 'credentials',
    label: 'Credentials',
    description: 'Keep logins for each project encrypted and share them with the right people.',
    adds: ['Credentials tab on projects'],
    group: 'work',
    dependsOn: [],
  },
  contacts: {
    id: 'contacts',
    label: 'Contacts',
    description: 'A shared address book of the people you work with, linked to projects.',
    adds: ['Contacts page', 'Client contacts on projects'],
    group: 'clients',
    dependsOn: [],
  },
  sales: {
    id: 'sales',
    label: 'Leads',
    description: 'A sales pipeline from first contact to won, with proposals and one-click conversion to a project.',
    adds: ['Leads page', 'Pipeline on the dashboard'],
    group: 'clients',
    dependsOn: ['contacts'],
  },
  portal: {
    id: 'portal',
    label: 'Client portal',
    description: 'A private page per project where clients see progress, updates and files without logging in.',
    adds: ['Client portal tab on projects', 'Portal analytics'],
    group: 'clients',
    dependsOn: [],
  },
  billing: {
    id: 'billing',
    label: 'Client invoicing',
    description: 'Bill clients for hours, retainers and fixed fees, record what they pay, and see company revenue.',
    adds: ['Finances page', 'Billing tab on projects', 'Invoices and payments', 'Retainers and billing plans', 'Rates and budgets', 'Hour approvals'],
    group: 'money',
    dependsOn: ['time'],
  },
  team_pay: {
    id: 'team_pay',
    label: 'Team pay',
    description: 'Pay your team for their hours: set pay rates, run payroll and record payouts. Each person sees their own earnings.',
    adds: ['Team pay tab in Finances', 'Pay rates and payouts', 'My earnings', 'Hour approvals'],
    group: 'money',
    dependsOn: ['time'],
  },
  webhooks: {
    id: 'webhooks',
    label: 'Webhooks',
    description: 'Send task, question and invoice events to other systems, such as an AI agent or your accounting tool.',
    adds: ['Webhooks in Settings > Developers'],
    group: 'automation',
    // Invoice events also need Client invoicing; every other event needs only this.
    dependsOn: [],
  },
  inbox: {
    id: 'inbox',
    label: 'Inbox',
    description: 'Email and meetings in one place, sorted by project, with emails sent to clients. Everyone can connect their own inbox.',
    adds: ['Inbox page', 'Communication tab on projects', 'Email settings for inboxes'],
    group: 'communication',
    dependsOn: [],
  },
  agents: {
    id: 'agents',
    label: 'AI agents',
    description: 'AI agents join the team: they suggest and work tasks, and you review what they do.',
    adds: ['Agent page', 'Task suggestions', 'Project goals', 'Live office'],
    group: 'automation',
    dependsOn: [],
  },
};

/**
 * The module each permission belongs to. A `Record` over every permission key,
 * so a new permission does not compile until it is placed.
 */
export const PERMISSION_MODULE: Record<PermissionKey, ModuleId | 'core'> = {
  'team.read': 'core',
  'team.manage': 'core',
  'groups.manage': 'core',
  'identities.link': 'core',
  'identities.read': 'core',
  'access.manage': 'core',
  'settings.manage': 'core',
  'smtp.manage': 'core',
  'audit.read': 'core',
  'api_keys.manage_all': 'core',
  'webhooks.manage': 'webhooks',
  'notifications.manage_own': 'core',
  'notifications.send': 'core',
  'reminders.manage_own': 'core',
  'projects.read': 'core',
  'projects.read_all': 'core',
  'projects.manage': 'core',
  'project_members.manage': 'core',
  'tasks.read': 'core',
  'tasks.read_assigned': 'core',
  'tasks.create': 'core',
  'tasks.manage_assigned': 'core',
  'tasks.manage_all': 'core',
  'time.manage_own': 'time',
  'time.read_all': 'time',
  'time.manage_all': 'time',
  'time.approve': 'time',
  'contacts.read': 'contacts',
  'contacts.read_all': 'contacts',
  'contacts.manage': 'contacts',
  'leads.read': 'sales',
  'leads.read_all': 'sales',
  'leads.manage': 'sales',
  'files.read': 'core',
  'files.upload': 'core',
  'files.manage': 'core',
  'portal.read': 'portal',
  'portal.manage': 'portal',
  'communications.read': 'inbox',
  'communications.manage': 'inbox',
  'inbound_email.read': 'inbox',
  'inbound_email.triage': 'inbox',
  'inbound_email.signal': 'inbox',
  'inbound_email.manage': 'inbox',
  'inbound_email.personal': 'inbox',
  'credentials.reveal_shared': 'credentials',
  'credentials.manage': 'credentials',
  'invoices.read': 'billing',
  'invoices.manage': 'billing',
  'invoices.record_payments': 'billing',
  'billing.manage': 'billing',
  'finance.company.read': 'billing',
  'earnings.own.read': 'team_pay',
  'compensation.manage': 'team_pay',
  'payouts.manage': 'team_pay',
  'agents.manage': 'agents',
  'agents.act_for': 'agents',
  // Saved context any AI working the project reads (an agent or a person's own Claude over MCP).
  'project_context.read': 'core',
  'project_context.manage': 'core',
  'goals.read': 'agents',
  'goals.manage': 'agents',
  'suggestions.create': 'agents',
  'suggestions.manage': 'agents',
  'agent_activity.write': 'agents',
  'fleet_alerts.write': 'agents',
  'agent_events.export': 'agents',
  'meetings.write': 'inbox',
};

export type PresetId = 'agency' | 'team' | 'solo';

export interface PresetDefinition {
  id: PresetId;
  label: string;
  description: string;
  modules: ModuleId[];
}

export const PRESETS: Record<PresetId, PresetDefinition> = {
  agency: {
    id: 'agency',
    label: 'Agency',
    description: 'Client work end to end: leads, contacts, the client portal, time, invoicing, team pay and AI agents.',
    modules: [...MODULE_IDS],
  },
  team: {
    id: 'team',
    label: 'Internal team',
    description: 'A company running its own projects: tasks, time, the inbox and AI agents. No clients or invoicing; Team pay can be added.',
    modules: ['time', 'credentials', 'inbox', 'agents'],
  },
  solo: {
    id: 'solo',
    label: 'Solo',
    description: 'One person serving clients: projects, time, contacts and invoices.',
    modules: ['time', 'contacts', 'billing', 'webhooks'],
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === 'string' && (MODULE_IDS as readonly string[]).includes(value);
}

/** The module a permission belongs to; an unknown key counts as core. */
export function moduleOfPermission(permission: string): ModuleId | 'core' {
  return (PERMISSION_MODULE as Record<string, ModuleId | 'core'>)[permission] ?? 'core';
}

/** Modules that depend on `id`, directly or through another module. */
export function dependentsOf(id: ModuleId): ModuleId[] {
  const out = new Set<ModuleId>();
  const visit = (target: ModuleId) => {
    for (const mod of MODULE_IDS) {
      if (!out.has(mod) && MODULES[mod].dependsOn.includes(target)) {
        out.add(mod);
        visit(mod);
      }
    }
  };
  visit(id);
  return MODULE_IDS.filter((mod) => out.has(mod));
}

/** Modules `id` needs, directly or through another module. */
export function requirementsOf(id: ModuleId): ModuleId[] {
  const out = new Set<ModuleId>();
  const visit = (target: ModuleId) => {
    for (const dep of MODULES[target].dependsOn) {
      if (!out.has(dep)) {
        out.add(dep);
        visit(dep);
      }
    }
  };
  visit(id);
  return MODULE_IDS.filter((mod) => out.has(mod));
}

/**
 * The enabled set after switching one module, with dependencies kept whole:
 * turning a module on turns on what it needs, turning it off turns off what
 * needs it. Returned in registry order.
 */
export function applyModuleChange(enabled: Iterable<ModuleId>, id: ModuleId, on: boolean): ModuleId[] {
  const next = new Set(enabled);
  if (on) {
    next.add(id);
    for (const dep of requirementsOf(id)) next.add(dep);
  } else {
    next.delete(id);
    for (const dependent of dependentsOf(id)) next.delete(dependent);
  }
  return MODULE_IDS.filter((mod) => next.has(mod));
}

/** A set with every dependency satisfied: drops modules whose requirements are off. */
export function normalizeModules(enabled: Iterable<ModuleId>): ModuleId[] {
  const next = new Set(enabled);
  let changed = true;
  while (changed) {
    changed = false;
    for (const mod of MODULE_IDS) {
      if (next.has(mod) && MODULES[mod].dependsOn.some((dep) => !next.has(dep))) {
        next.delete(mod);
        changed = true;
      }
    }
  }
  return MODULE_IDS.filter((mod) => next.has(mod));
}

/** The preset whose modules are exactly `enabled`, or null for a custom mix. */
export function presetFor(enabled: Iterable<ModuleId>): PresetId | null {
  const set = new Set(enabled);
  for (const id of PRESET_IDS) {
    const mods = PRESETS[id].modules;
    if (mods.length === set.size && mods.every((mod) => set.has(mod))) return id;
  }
  return null;
}
