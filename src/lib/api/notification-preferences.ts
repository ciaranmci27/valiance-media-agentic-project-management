import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NotificationCategory, NotificationPreferences } from '@/lib/types';
import { EMAIL_ON_BY_DEFAULT } from '@/lib/notification-defaults';
import { ApiError, notFound } from './errors';

/**
 * Settings > Notifications over the API: your own in-app and email choices
 * per category and the email master switch, stored on your team member row
 * as the app stores them. Absent in-app means on; email is explicit either
 * way (some categories are on by default).
 */

/** Every category Settings > Notifications shows. */
export const NOTIFICATION_CATEGORIES = [
  'task_created', 'task_deleted', 'task_status', 'task_assignments', 'task_updates', 'task_subtasks', 'task_comments',
  'project_created', 'project_deleted', 'project_updates', 'project_contacts', 'portal_settings', 'portal_updates',
  'time_entries', 'invoice_drafts', 'entity_files',
  'contact_created', 'contact_deleted', 'contact_updates',
  'team_members', 'api_keys',
  'lead_created', 'lead_deleted', 'lead_status', 'lead_updates', 'lead_interactions', 'lead_proposals', 'lead_contacts', 'lead_conversions',
  'agent_suggestions', 'agent_goals', 'agent_autonomous', 'agent_activity',
] as const satisfies readonly NotificationCategory[];

// A category added to the type but not here fails the type check.
type Unlisted = Exclude<NotificationCategory, (typeof NOTIFICATION_CATEGORIES)[number]>;
const everyCategoryListed: [Unlisted] extends [never] ? true : never = true;
void everyCategoryListed;

const choices = z.partialRecord(z.enum(NOTIFICATION_CATEGORIES), z.boolean());

export const notificationPreferencesPatchSchema = z.object({
  in_app: choices.optional(),
  email_enabled: z.boolean().optional(),
  email: choices.optional(),
}).strict().refine((body) => body.in_app !== undefined || body.email_enabled !== undefined || body.email !== undefined, 'Send in_app, email_enabled or email');
export type NotificationPreferencesPatch = z.infer<typeof notificationPreferencesPatchSchema>;

export interface NotificationPreferencesView {
  /** Each category, on or off in the app. */
  in_app: Record<NotificationCategory, boolean>;
  email_enabled: boolean;
  /** Each category, on or off by email (only sent while email_enabled). */
  email: Record<NotificationCategory, boolean>;
  /** Whether the workspace can send email at all; email_enabled cannot be turned on without it. */
  email_available: boolean;
}

interface PrefsRow { notification_prefs: NotificationPreferences | null; email_notifications_enabled: boolean | null; email_notification_prefs: NotificationPreferences | null }

async function readRow(db: SupabaseClient, memberId: string): Promise<PrefsRow> {
  const { data, error } = await db.from('team_members').select('notification_prefs, email_notifications_enabled, email_notification_prefs').eq('id', memberId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Team member');
  return data as PrefsRow;
}

async function emailAvailable(db: SupabaseClient): Promise<boolean> {
  const { count } = await db.from('smtp_accounts').select('id', { count: 'exact', head: true });
  return (count ?? 0) > 0;
}

function present(row: PrefsRow, available: boolean): NotificationPreferencesView {
  const inApp = row.notification_prefs ?? {};
  const email = row.email_notification_prefs ?? {};
  return {
    in_app: Object.fromEntries(NOTIFICATION_CATEGORIES.map((key) => [key, inApp[key] !== false])) as Record<NotificationCategory, boolean>,
    email_enabled: row.email_notifications_enabled === true,
    email: Object.fromEntries(NOTIFICATION_CATEGORIES.map((key) => [key, email[key] ?? EMAIL_ON_BY_DEFAULT.has(key)])) as Record<NotificationCategory, boolean>,
    email_available: available,
  };
}

export async function readNotificationPreferences(db: SupabaseClient, memberId: string): Promise<NotificationPreferencesView> {
  const [row, available] = await Promise.all([readRow(db, memberId), emailAvailable(db)]);
  return present(row, available);
}

/** Changes only the categories sent, as the toggles do; answers the before and after for the audit row. */
export async function updateNotificationPreferences(db: SupabaseClient, memberId: string, patch: NotificationPreferencesPatch) {
  const [row, available] = await Promise.all([readRow(db, memberId), emailAvailable(db)]);
  if (patch.email_enabled === true && !available) {
    throw new ApiError(409, 'CONFLICT', 'This workspace cannot send email yet, so email notifications cannot be turned on. An Owner sets up email sending in Settings.', { reason: 'email_not_set_up' });
  }
  const changes: Partial<PrefsRow> = {};
  if (patch.in_app) {
    const next: NotificationPreferences = { ...(row.notification_prefs ?? {}) };
    // As the toggle stores it: off is false, on removes the entry (absent means on).
    for (const [key, on] of Object.entries(patch.in_app) as [NotificationCategory, boolean][]) {
      if (on) delete next[key];
      else next[key] = false;
    }
    changes.notification_prefs = next;
  }
  if (patch.email) changes.email_notification_prefs = { ...(row.email_notification_prefs ?? {}), ...patch.email };
  if (patch.email_enabled !== undefined) changes.email_notifications_enabled = patch.email_enabled;
  const { data, error } = await db.from('team_members').update(changes).eq('id', memberId)
    .select('notification_prefs, email_notifications_enabled, email_notification_prefs').maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Team member');
  return { before: present(row, available), after: present(data as PrefsRow, available) };
}
