import { Bell, CircleArrowUp, Code2, Database, Globe, LayoutGrid, Mail, Receipt, User, type LucideIcon } from 'lucide-react';
import { hourApprovalsExist } from '@/lib/finance/finance-views';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { customSettingsGroups, useCustomSettingsVisibility } from '@/lib/extensions/hooks';

/**
 * The Settings area's menu: one page per group, each listing the ids of the
 * sections it holds. The ids are the old /settings#<id> anchors, so an old
 * deep link finds its page here (see /settings) and still scrolls to its
 * section there.
 */

/** Core groups, then the install's own Settings sections (src/custom), keyed `custom:<key>`. */
export type SettingsGroupKey = 'workspace' | 'updates' | 'account' | 'notifications' | 'billing' | 'portal' | 'email' | 'developers' | 'data' | `custom:${string}`;

export interface SettingsGroup {
  key: SettingsGroupKey;
  href: string;
  label: string;
  icon: LucideIcon;
  sectionIds: string[];
  /** Sections that moved to a sub-page of the group (Email's are pages of their own). */
  sectionHrefs?: Record<string, string>;
}

/** The pages under Settings > Email, each linked from its overview. */
export const EMAIL_PAGES = {
  overview: '/settings/email',
  /** Your own inbox: anyone who may connect one. */
  mine: '/settings/email/inbox',
  handler: '/settings/email/handler',
  /** Every personal inbox's health, and the switch for whether Owners read them. */
  personal: '/settings/email/personal',
  addresses: '/settings/email/addresses',
  rules: '/settings/email/rules',
  sending: '/settings/email/sending',
} as const;

export const SETTINGS_GROUPS: SettingsGroup[] = [
  // Your own account first: everyone has it, so it is also where /settings opens.
  { key: 'account', href: '/settings/account', label: 'Account', icon: User, sectionIds: ['profile', 'timezone', 'password', 'appearance'] },
  // New versions of the app and how to install them (Owners only).
  { key: 'updates', href: '/settings/updates', label: 'Updates', icon: CircleArrowUp, sectionIds: ['updates'] },
  // Workspace-wide: the modules, the brand and the region (Owners only).
  { key: 'workspace', href: '/settings/workspace', label: 'Workspace', icon: LayoutGrid, sectionIds: ['features', 'brand', 'region'] },
  { key: 'notifications', href: '/settings/notifications', label: 'Notifications', icon: Bell, sectionIds: ['notifications'] },
  // Invoice details (Client invoicing) and hour approvals (either money
  // module). Was Business, at /settings/business, which still redirects here;
  // 'business' keeps old /settings#business links landing on this page.
  { key: 'billing', href: '/settings/billing', label: 'Billing', icon: Receipt, sectionIds: ['invoice-details', 'hour-approvals', 'business'] },
  // Portal-wide settings, while the Client portal is on.
  { key: 'portal', href: '/settings/portal', label: 'Client portal', icon: Globe, sectionIds: ['analytics-exclusions'] },
  {
    key: 'email',
    href: '/settings/email',
    label: 'Email',
    icon: Mail,
    sectionIds: ['smtp', 'my-inbox', 'email-inboxes', 'personal-inboxes', 'email-addresses', 'mail-rules'],
    sectionHrefs: {
      smtp: EMAIL_PAGES.sending,
      'my-inbox': EMAIL_PAGES.mine,
      'email-inboxes': EMAIL_PAGES.handler,
      'personal-inboxes': EMAIL_PAGES.personal,
      'email-addresses': EMAIL_PAGES.addresses,
      'mail-rules': EMAIL_PAGES.rules,
    },
  },
  { key: 'developers', href: '/settings/developers', label: 'Developers', icon: Code2, sectionIds: ['api-keys', 'webhooks'] },
  { key: 'data', href: '/settings/data', label: 'Data', icon: Database, sectionIds: ['trash', 'demo-mode'] },
  // The install's own sections, after core's.
  ...customSettingsGroups(),
];

export const DEFAULT_SETTINGS_HREF = '/settings/account';

/** The page that holds an old /settings#<id> section, or null for an unknown id. */
export function settingsHrefForSection(id: string): string | null {
  // Old SMTP anchors had suffixes (#smtp-accounts, say); they all mean Sending.
  const key = id.startsWith('smtp') ? 'smtp' : id;
  const group = SETTINGS_GROUPS.find((g) => g.sectionIds.includes(key));
  return group ? group.sectionHrefs?.[key] ?? group.href : null;
}

/** The group a /settings/<group> path belongs to, or null outside the menu. */
export function settingsGroupForPath(pathname: string): SettingsGroup | null {
  return SETTINGS_GROUPS.find((g) => pathname === g.href || pathname.startsWith(`${g.href}/`)) ?? null;
}

/**
 * Who sees which section, read once so the pages and the menu agree. These are
 * the exact rules the single Settings page used.
 */
export function useSettingsAccess() {
  const { access } = useAuth();
  const { isDemoMode, isEnvForcedDemo } = useDemo();
  const canManageSettings = hasPermission(access, 'settings.manage');
  const canManageSmtp = hasPermission(access, 'smtp.manage');
  const canManageAgents = hasPermission(access, 'agents.manage');
  const canManageWebhooks = hasPermission(access, 'webhooks.manage');
  const canManageInboxes = hasPermission(access, 'inbound_email.manage');
  // Connecting your own inbox: people only, never an agent's session.
  const canConnectOwnInbox = hasPermission(access, 'inbound_email.personal') && access?.role !== 'agent';
  // A role, not a permission: a module switch hides parts of the app from
  // everyone. The demo workspace signs in as an Owner, so it shows there too.
  const isOwner = access?.role === 'owner';
  // Guests are outside collaborators (a client, a contractor): no keys, no Trash.
  const isGuest = access?.role === 'guest';

  const show = {
    features: isOwner,
    // The workspace's name, logo and colors: they change the app for everyone, so Owners only.
    brand: isOwner,
    // Currency, number and date format: every amount everyone sees, so Owners only.
    region: isOwner,
    // Owners only. In demo mode the page says updates are off there.
    updates: isOwner,
    // Billing: invoice details only mean something with Client invoicing on;
    // hour approvals only while hours wait for review (either money module).
    invoiceDetails: canManageSettings && isModuleEnabled(access, 'billing'),
    hourApprovals: canManageSettings && hourApprovalsExist(access),
    // Every active member can create personal keys; none in demo mode.
    apiKeys: !isDemoMode && !isGuest,
    webhooks: canManageWebhooks && !isDemoMode,
    // SMTP is hidden in demo mode; inboxes show there too, on sample data whose changes last until a reload.
    smtp: canManageSmtp && !isDemoMode,
    emailInboxes: canManageInboxes,
    myInbox: canConnectOwnInbox,
    password: !isDemoMode,
    // The exclusions filter portal analytics, so they go with the portal.
    analyticsExclusions: canManageSettings && isModuleEnabled(access, 'portal'),
    // Hidden when the environment forces demo mode on.
    demoMode: canManageSettings && !isEnvForcedDemo,
  };

  // A group shows in the menu while at least one of its sections does.
  const visibleGroups: Record<SettingsGroupKey, boolean> = {
    workspace: show.features || show.brand || show.region,
    updates: show.updates,
    account: true,
    notifications: true,
    billing: show.invoiceDetails || show.hourApprovals,
    portal: show.analyticsExclusions,
    email: show.smtp || show.emailInboxes || show.myInbox,
    developers: show.apiKeys || show.webhooks,
    data: !isGuest,
  };

  const customVisible = useCustomSettingsVisibility();
  return { canManageAgents, canManageSettings, isOwner, show, visibleGroups: { ...visibleGroups, ...customVisible } };
}
