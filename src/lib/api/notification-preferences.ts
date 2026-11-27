import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NotificationCategory, NotificationPreferences } from '@/lib/types';
import {
  CHAT_ON_BY_DEFAULT, DELIVERY_KEYS, EMAIL_ON_BY_DEFAULT, NOTIFICATION_CATEGORY_KEYS, type DeliveryKey,
} from '@/lib/notification-defaults';
import { ApiError, notFound } from './errors';

/**
 * Settings > Notifications over the API and in the app: your own choices,
 * stored on your team member row. In the app every notice always shows (the
 * in_app choices remain for the categories that can be muted there); email
 * and chat are chosen per kind (each category, and needs_you for what waits
 * on you), each behind its own switch. Absent in-app means on; email and
 * chat fall back to their defaults (needs_you on for both).
 */

/** Every category Settings > Notifications shows. */
export const NOTIFICATION_CATEGORIES = NOTIFICATION_CATEGORY_KEYS;

// A category added to the type but not here fails the type check.
type Unlisted = Exclude<NotificationCategory, (typeof NOTIFICATION_CATEGORIES)[number]>;
const everyCategoryListed: [Unlisted] extends [never] ? true : never = true;
void everyCategoryListed;

const inAppChoices = z.partialRecord(z.enum(NOTIFICATION_CATEGORIES), z.boolean());
const deliveryChoices = z.partialRecord(z.enum(DELIVERY_KEYS), z.boolean());

export const notificationPreferencesPatchSchema = z.object({
  in_app: inAppChoices.optional(),
  email_enabled: z.boolean().optional(),
  email: deliveryChoices.optional(),
  chat_enabled: z.boolean().optional(),
  chat: deliveryChoices.optional(),
}).strict().refine(
  (body) => [body.in_app, body.email_enabled, body.email, body.chat_enabled, body.chat].some((value) => value !== undefined),
  'Send in_app, email_enabled, email, chat_enabled or chat',
);
export type NotificationPreferencesPatch = z.infer<typeof notificationPreferencesPatchSchema>;

export interface NotificationPreferencesView {
  /** Each category, on or off in the app. */
  in_app: Record<NotificationCategory, boolean>;
  email_enabled: boolean;
  /** Each kind (needs_you and every category), on or off by email (only sent while email_enabled). */
  email: Record<DeliveryKey, boolean>;
  /** Whether the workspace can send email at all; email_enabled cannot be turned on without it. */
  email_available: boolean;
  chat_enabled: boolean;
  /** Each kind, on or off in your chat (only sent while chat_enabled). */
  chat: Record<DeliveryKey, boolean>;
  /** Whether you have a linked chat account a connected bot can message; chat_enabled cannot be turned on without it. */
  chat_available: boolean;
}

interface PrefsRow {
  notification_prefs: NotificationPreferences | null;
  email_notifications_enabled: boolean | null;
  email_notification_prefs: Partial<Record<DeliveryKey, boolean>> | null;
  chat_notifications_enabled?: boolean | null;
  chat_notification_prefs?: Partial<Record<DeliveryKey, boolean>> | null;
}

const BASE_COLUMNS = 'notification_prefs, email_notifications_enabled, email_notification_prefs';
const COLUMNS = `${BASE_COLUMNS}, chat_notifications_enabled, chat_notification_prefs`;
const missingColumn = (error: { code?: string } | null) => !!error && (error.code === '42703' || error.code === 'PGRST204');

const chatNotReady = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Chat notifications need the latest database update. Ask an Owner to apply it in Settings > Updates.', {
  reason: 'database_update_needed', migration: '20261127003500_notifications_delivery.sql',
});

async function readRow(db: SupabaseClient, memberId: string): Promise<PrefsRow & { chatReady: boolean }> {
  const full = await db.from('team_members').select(COLUMNS).eq('id', memberId).maybeSingle();
  if (missingColumn(full.error)) {
    // Before 20261127003500: no chat choices yet.
    const base = await db.from('team_members').select(BASE_COLUMNS).eq('id', memberId).maybeSingle();
    if (base.error) throw base.error;
    if (!base.data) throw notFound('Team member');
    return { ...(base.data as PrefsRow), chatReady: false };
  }
  if (full.error) throw full.error;
  if (!full.data) throw notFound('Team member');
  return { ...(full.data as PrefsRow), chatReady: true };
}

async function emailAvailable(db: SupabaseClient): Promise<boolean> {
  const { count } = await db.from('smtp_accounts').select('id', { count: 'exact', head: true });
  return (count ?? 0) > 0;
}

/** Whether a connected chat bot can reach this person: a verified linked account and an enabled connection on that provider. */
export async function chatAvailable(db: SupabaseClient, memberId: string): Promise<boolean> {
  const { data: identities } = await db.from('member_identities').select('provider').eq('member_id', memberId).not('verified_at', 'is', null);
  const providers = [...new Set(((identities ?? []) as { provider: string }[]).map((row) => row.provider))];
  if (providers.length === 0) return false;
  const { data: connections } = await db.from('chat_connections').select('provider').eq('enabled', true);
  return ((connections ?? []) as { provider: string }[]).some((row) => providers.includes(row.provider));
}

function choicesOf(stored: Partial<Record<DeliveryKey, boolean>> | null | undefined, defaults: ReadonlySet<DeliveryKey>): Record<DeliveryKey, boolean> {
  const values = stored ?? {};
  return Object.fromEntries(DELIVERY_KEYS.map((key) => [key, values[key] ?? defaults.has(key)])) as Record<DeliveryKey, boolean>;
}

function present(row: PrefsRow, available: { email: boolean; chat: boolean }): NotificationPreferencesView {
  const inApp = row.notification_prefs ?? {};
  return {
    in_app: Object.fromEntries(NOTIFICATION_CATEGORIES.map((key) => [key, inApp[key] !== false])) as Record<NotificationCategory, boolean>,
    email_enabled: row.email_notifications_enabled === true,
    email: choicesOf(row.email_notification_prefs, EMAIL_ON_BY_DEFAULT),
    email_available: available.email,
    chat_enabled: row.chat_notifications_enabled === true,
    chat: choicesOf(row.chat_notification_prefs, CHAT_ON_BY_DEFAULT),
    chat_available: available.chat,
  };
}

export async function readNotificationPreferences(db: SupabaseClient, memberId: string): Promise<NotificationPreferencesView> {
  const [row, email, chat] = await Promise.all([readRow(db, memberId), emailAvailable(db), chatAvailable(db, memberId)]);
  return present(row, { email, chat });
}

/** Changes only the choices sent, as the switches do; answers the before and after for the audit row. */
export async function updateNotificationPreferences(db: SupabaseClient, memberId: string, patch: NotificationPreferencesPatch) {
  const [row, email, chat] = await Promise.all([readRow(db, memberId), emailAvailable(db), chatAvailable(db, memberId)]);
  if (patch.email_enabled === true && !email) {
    throw new ApiError(409, 'CONFLICT', 'This workspace cannot send email yet, so email notifications cannot be turned on. An Owner sets up email sending in Settings.', { reason: 'email_not_set_up' });
  }
  if ((patch.chat_enabled !== undefined || patch.chat !== undefined) && !row.chatReady) throw chatNotReady();
  if (patch.chat_enabled === true && !chat) {
    throw new ApiError(409, 'CONFLICT', 'Link a chat account first (Your AI > Chat accounts), on an app the workspace has connected, so notifications have somewhere to go.', { reason: 'chat_not_linked' });
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
  if (patch.chat) changes.chat_notification_prefs = { ...(row.chat_notification_prefs ?? {}), ...patch.chat };
  if (patch.chat_enabled !== undefined) changes.chat_notifications_enabled = patch.chat_enabled;
  const { data, error } = await db.from('team_members').update(changes).eq('id', memberId)
    .select(row.chatReady ? COLUMNS : BASE_COLUMNS).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Team member');
  return { before: present(row, { email, chat }), after: present(data as unknown as PrefsRow, { email, chat }) };
}
