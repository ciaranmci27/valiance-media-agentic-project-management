import type { NotificationCategory, NotificationPreferences } from '@/lib/types';
import { isReceiptCategory } from '@/lib/notifications';

/**
 * What a person chooses delivery by: a notification category, or needs_you
 * for everything that waits on them (a question or approval asked, an
 * agent's findings, an inbox decision). In the app every notice always shows;
 * email and chat follow these choices.
 */
export type DeliveryKey = NotificationCategory | 'needs_you';

/** Every category Settings > Notifications shows, in its order. */
export const NOTIFICATION_CATEGORY_KEYS = [
  'task_created', 'task_deleted', 'task_status', 'task_assignments', 'task_updates', 'task_subtasks', 'task_comments',
  'project_created', 'project_deleted', 'project_updates', 'project_contacts', 'portal_settings', 'portal_updates',
  'time_entries', 'invoice_drafts', 'entity_files',
  'contact_created', 'contact_deleted', 'contact_updates',
  'team_members', 'api_keys',
  'lead_created', 'lead_deleted', 'lead_status', 'lead_updates', 'lead_interactions', 'lead_proposals', 'lead_contacts', 'lead_conversions',
  'agent_suggestions', 'agent_goals', 'agent_autonomous', 'agent_activity',
] as const satisfies readonly NotificationCategory[];

/** Every key email and chat are chosen by: Needs you first, then each category. */
export const DELIVERY_KEYS = ['needs_you', ...NOTIFICATION_CATEGORY_KEYS] as const satisfies readonly DeliveryKey[];

const CATEGORY_KEYS: ReadonlySet<string> = new Set(NOTIFICATION_CATEGORY_KEYS);

/**
 * The key a notice is delivered by, from its category: needs_you for a
 * notice announcing a Needs you item, the category itself when a person can
 * choose it, else null (only in the app). Mirrors pm.notification_pref_key.
 */
export function deliveryKeyOf(category: string | null | undefined): DeliveryKey | null {
  if (isReceiptCategory(category)) return 'needs_you';
  return category && CATEGORY_KEYS.has(category) ? category as NotificationCategory : null;
}

/**
 * Email kinds that are ON unless the member turns them off. Everything else
 * is opt-in. Needs you is on: something waits on the person. Invoice drafts
 * are on: a drafted invoice waits on a person, and missing one delays getting
 * paid (their email is the morning summary). Either way, nothing is emailed
 * unless the member has email notifications enabled at all.
 */
export const EMAIL_ON_BY_DEFAULT: ReadonlySet<DeliveryKey> = new Set<DeliveryKey>(['needs_you', 'invoice_drafts']);

/** Chat kinds that are ON unless turned off, once chat is on: only what waits on the person. */
export const CHAT_ON_BY_DEFAULT: ReadonlySet<DeliveryKey> = new Set<DeliveryKey>(['needs_you']);

type DeliveryPrefs = Partial<Record<DeliveryKey, boolean>> | NotificationPreferences;

export function emailCategoryEnabled(prefs: DeliveryPrefs | null | undefined, key: DeliveryKey): boolean {
  const value = (prefs as Partial<Record<DeliveryKey, boolean>> | null | undefined)?.[key];
  return value === undefined ? EMAIL_ON_BY_DEFAULT.has(key) : value === true;
}

export function chatCategoryEnabled(prefs: DeliveryPrefs | null | undefined, key: DeliveryKey): boolean {
  const value = (prefs as Partial<Record<DeliveryKey, boolean>> | null | undefined)?.[key];
  return value === undefined ? CHAT_ON_BY_DEFAULT.has(key) : value === true;
}

/**
 * Whether a kind of update reaches a person by email or chat. A kind switched
 * off in the app is off everywhere: its notice is never raised, so nothing is
 * queued for it (lib/api/team-notice.ts, pm.enqueue_notification_deliveries).
 */
export function updateDelivers(input: { inApp: boolean; channelOn: boolean; choice: boolean }): boolean {
  return input.inApp && input.channelOn && input.choice;
}
