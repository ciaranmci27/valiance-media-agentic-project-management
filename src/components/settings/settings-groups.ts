import { Bell, Building2, Code2, Database, Mail, User, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';

/**
 * The Settings area's menu: one page per group, each listing the ids of the
 * sections it holds. The ids are the old /settings#<id> anchors, so an old
 * deep link finds its page here (see /settings) and still scrolls to its
 * section there.
 */

export type SettingsGroupKey = 'account' | 'notifications' | 'business' | 'email' | 'developers' | 'data';

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
  handler: '/settings/email/handler',
  addresses: '/settings/email/addresses',
  rules: '/settings/email/rules',
  sending: '/settings/email/sending',
} as const;

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { key: 'account', href: '/settings/account', label: 'Account', icon: User, sectionIds: ['profile', 'timezone', 'password', 'appearance'] },
  { key: 'notifications', href: '/settings/notifications', label: 'Notifications', icon: Bell, sectionIds: ['notifications'] },
  { key: 'business', href: '/settings/business', label: 'Business', icon: Building2, sectionIds: ['business'] },
  {
    key: 'email',
    href: '/settings/email',
    label: 'Email',
    icon: Mail,
    sectionIds: ['smtp', 'email-inboxes', 'email-addresses', 'mail-rules'],
    sectionHrefs: {
      smtp: EMAIL_PAGES.sending,
      'email-inboxes': EMAIL_PAGES.handler,
      'email-addresses': EMAIL_PAGES.addresses,
      'mail-rules': EMAIL_PAGES.rules,
    },
  },
  { key: 'developers', href: '/settings/developers', label: 'Developers', icon: Code2, sectionIds: ['api-keys', 'webhooks'] },
  { key: 'data', href: '/settings/data', label: 'Data', icon: Database, sectionIds: ['trash', 'analytics-exclusions', 'demo-mode'] },
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

  const show = {
    business: canManageSettings,
    // Every active member can create personal keys; none in demo mode.
    apiKeys: !isDemoMode,
    webhooks: canManageWebhooks && !isDemoMode,
    // SMTP is hidden in demo mode; inboxes show there too, on sample data whose changes last until a reload.
    smtp: canManageSmtp && !isDemoMode,
    emailInboxes: canManageInboxes,
    password: !isDemoMode,
    analyticsExclusions: canManageSettings,
    // Hidden when the environment forces demo mode on.
    demoMode: canManageSettings && !isEnvForcedDemo,
  };

  // A group shows in the menu while at least one of its sections does.
  const visibleGroups: Record<SettingsGroupKey, boolean> = {
    account: true,
    notifications: true,
    business: show.business,
    email: show.smtp || show.emailInboxes,
    developers: show.apiKeys || show.webhooks,
    data: true,
  };

  return { canManageAgents, show, visibleGroups };
}
