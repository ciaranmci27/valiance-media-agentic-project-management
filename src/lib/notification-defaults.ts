import type { NotificationCategory, NotificationPreferences } from '@/lib/types';

/**
 * Email categories that are ON unless the member turns them off. Everything
 * else is opt-in. Invoice drafts are on by default: a drafted invoice waits on
 * a person, and missing one delays getting paid. Either way, nothing is
 * emailed unless the member has email notifications enabled at all.
 */
export const EMAIL_ON_BY_DEFAULT: ReadonlySet<NotificationCategory> = new Set<NotificationCategory>(['invoice_drafts']);

export function emailCategoryEnabled(prefs: NotificationPreferences | null | undefined, category: NotificationCategory): boolean {
  const value = prefs?.[category];
  return value === undefined ? EMAIL_ON_BY_DEFAULT.has(category) : value === true;
}
