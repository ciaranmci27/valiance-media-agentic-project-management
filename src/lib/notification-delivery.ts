import type { SupabaseClient } from '@supabase/supabase-js';
import { getBrand } from '@/lib/brand/server';
import { sendTransactional } from '@/lib/email/send-mail';
import { absoluteUrl } from '@/lib/email/templates/shared';
import { buildNotificationEmail } from '@/lib/email/templates/team/notification';
import { sendSystemChatNotice } from '@/lib/chat/outbound';
import { ChatProviderError } from '@/lib/chat/providers';
import { safeNotificationLink } from '@/lib/notifications';

/**
 * The one server delivery point for notifications by email and chat
 * (20261127003500_notifications_delivery.sql). Every notice, whoever raised
 * it (a screen, the API, a database trigger), lands in
 * pm.team_member_notifications; raising one queues an email and a chat
 * delivery as the person chose in Settings > Notifications; this sends them.
 *
 * It runs from pg_cron (POST /api/internal/notifications/deliver, every
 * minute while something is due) and right after the app raises a notice
 * itself, so a person hears about a comment at once, not a minute later.
 *
 * - Email only while the workspace can send email; otherwise the delivery
 *   is skipped and says so.
 * - Chat is a DM to the person's own verified linked account from a
 *   connected bot, the notice's one line and a link back to the app
 *   (sendSystemChatNotice: never to anyone else, the same hourly limit per
 *   person as agents' messages).
 * - A notice read, done or cleared before its turn is skipped, not sent.
 * - A failed send is tried again after 1 and 5 minutes, then left failed.
 */

export interface DeliveryRun {
  claimed: number;
  sent: { email: number; chat: number };
  skipped: number;
  failed: number;
}

interface Claimed {
  delivery_id: string;
  channel: 'email' | 'chat';
  attempts: number;
  member_id: string;
  member_email: string | null;
  member_name: string | null;
  notification_id: string;
  title: string;
  message: string | null;
  link: string | null;
  category: string | null;
}

/** The database has no queue yet (before 20261127003500): nothing to deliver. */
const missingQueue = (error: { code?: string; message?: string } | null) =>
  !!error && (['42883', 'PGRST202', '42P01', 'PGRST205'].includes(error.code ?? '') || /does not exist|could not find the function/i.test(error.message ?? ''));

/** The chat line: the notice's title and, when it adds anything, the first line of its message. */
export function chatLine(title: string, message: string | null): string {
  const first = (message ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const line = first && !title.includes(first) ? `${title}: ${first}` : title;
  return line.length > 600 ? `${line.slice(0, 597)}...` : line;
}

/**
 * Sends what is due, at most `limit` (and only these people's when
 * memberIds is given: the app's own right-after pass). Never throws for one
 * delivery: each records its own outcome.
 */
export async function deliverDueNotifications(
  service: SupabaseClient,
  options: {
    limit?: number;
    memberIds?: string[];
    /** The mailer (tests pass their own); the workspace's SMTP account by default. */
    mailer?: (message: { to: string; subject: string; html: string; text: string }) => Promise<{ success: boolean; error?: string }>;
  } = {},
): Promise<DeliveryRun> {
  const mailer = options.mailer ?? sendTransactional;
  const run: DeliveryRun = { claimed: 0, sent: { email: 0, chat: 0 }, skipped: 0, failed: 0 };
  const { data, error } = await service.rpc('claim_notification_deliveries', {
    p_limit: options.limit ?? 25,
    p_member_ids: options.memberIds?.length ? options.memberIds : null,
  });
  if (error) {
    if (missingQueue(error)) return run;
    throw error;
  }
  const due = (data ?? []) as Claimed[];
  run.claimed = due.length;
  if (due.length === 0) return run;
  const brand = await getBrand();

  const complete = async (id: string, outcome: 'sent' | 'skipped' | 'failed', why: string | null) => {
    const { error: completeError } = await service.rpc('complete_notification_delivery', { p_delivery_id: id, p_outcome: outcome, p_error: why });
    if (completeError) console.error('[notifications] could not record a delivery', { id, error: completeError.message });
    if (outcome === 'skipped') run.skipped += 1;
    if (outcome === 'failed') run.failed += 1;
  };

  for (const item of due) {
    const link = safeNotificationLink(item.link);
    try {
      if (item.channel === 'email') {
        if (!item.member_email) {
          await complete(item.delivery_id, 'skipped', 'No email address');
          continue;
        }
        const { html, text } = buildNotificationEmail({ brand, title: item.title, message: item.message ?? '', link });
        const sent = await mailer({ to: item.member_email, subject: item.title, html, text });
        if (sent.success) {
          run.sent.email += 1;
          await complete(item.delivery_id, 'sent', null);
        } else if (/no smtp|not configured|no email account/i.test(sent.error ?? '')) {
          await complete(item.delivery_id, 'skipped', 'Email sending is not set up');
        } else {
          await complete(item.delivery_id, 'failed', sent.error ?? 'Email failed');
        }
        continue;
      }
      const sent = await sendSystemChatNotice(service, item.member_id, {
        text: chatLine(item.title, item.message),
        link: link ? { url: absoluteUrl(link), label: `Open in ${brand.name}` } : null,
        as: { username: brand.name, iconUrl: null },
      });
      if (sent.status === 'sent') {
        run.sent.chat += 1;
        await complete(item.delivery_id, 'sent', null);
      } else {
        await complete(item.delivery_id, 'skipped', sent.reason === 'no_linked_chat' ? 'No linked chat account' : 'Too many chat messages this hour');
      }
    } catch (sendError) {
      const message = sendError instanceof ChatProviderError || sendError instanceof Error ? sendError.message : 'Delivery failed';
      await complete(item.delivery_id, 'failed', message);
    }
  }
  return run;
}
