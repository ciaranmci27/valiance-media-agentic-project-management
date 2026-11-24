'use client';

import { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import extensions from '@/custom';
import {
  matchPage,
  settingsSectionAllowed,
  visibleNavItems,
  visibleTo,
} from './registry';

/**
 * How core's screens read the install's extensions (src/custom/index.ts),
 * filtered for the signed-in member: module switches, permissions and roles.
 */

export { extensions };

export function useCustomNavItems() {
  const { access } = useAuth();
  return useMemo(() => visibleNavItems(access, extensions), [access]);
}

/** The custom page at /x/<segments>, or null when there is none or this member may not see it. */
export function useCustomPage(segments: readonly string[]) {
  const { access } = useAuth();
  const match = matchPage(extensions.pages, segments);
  return match && visibleTo(access, [match.page]).length ? match : null;
}

export function useCustomProjectTabs() {
  const { access } = useAuth();
  return useMemo(() => visibleTo(access, extensions.projectTabs), [access]);
}

export function useCustomDashboardWidgets(placement: 'top' | 'bottom') {
  const { access } = useAuth();
  return useMemo(
    () => visibleTo(access, extensions.dashboardWidgets).filter((widget) => (widget.placement ?? 'bottom') === placement),
    [access, placement],
  );
}

/** The install's cards for the Agents page's Analytics tab, filtered for this member. */
export function useCustomAgentAnalyticsCards() {
  const { access } = useAuth();
  return useMemo(() => visibleTo(access, extensions.agentAnalyticsCards), [access]);
}

/** The href of a custom Settings section. */
export const customSettingsHref = (key: string) => `/settings/custom/${key}`;

/** A custom section's id in the Settings menu: prefixed, so it can never collide with a core group. */
export const customSettingsGroupKey = (key: string) => `custom:${key}` as const;

/**
 * The install's Settings sections as Settings menu groups, in the shape of
 * SETTINGS_GROUPS, to append after the core groups.
 */
export function customSettingsGroups(): Array<{
  key: `custom:${string}`;
  href: string;
  label: string;
  icon: LucideIcon;
  sectionIds: string[];
}> {
  return extensions.settingsSections.map((section) => ({
    key: customSettingsGroupKey(section.key),
    href: customSettingsHref(section.key),
    label: section.label,
    icon: section.icon,
    sectionIds: [],
  }));
}

/** Which custom Settings groups this member sees, keyed like customSettingsGroups(). Owners only by default. */
export function useCustomSettingsVisibility(): Record<`custom:${string}`, boolean> {
  const { access } = useAuth();
  return useMemo(
    () => Object.fromEntries(extensions.settingsSections.map((section) => [
      customSettingsGroupKey(section.key),
      settingsSectionAllowed(access, section),
    ])),
    [access],
  );
}

/** The custom Settings section with this key, when this member may see it. */
export function useCustomSettingsSection(key: string) {
  const { access } = useAuth();
  const section = extensions.settingsSections.find((s) => s.key === key);
  return section && settingsSectionAllowed(access, section) ? section : null;
}
