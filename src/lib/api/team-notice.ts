import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { resolveMemberAccess } from '@/lib/api/access';
import { upsertNotification } from '@/lib/api/notifications';
import { deliverDueNotifications } from '@/lib/notification-delivery';
import { isReceiptCategory } from '@/lib/notifications';

/** Whether a member may open what a notice is about. */
export type CanSee = (access: AccessContext, memberId: string) => boolean | Promise<boolean>;

export interface TeamNotice {
  title: string;
  message: string;
  /** An in-app path, already checked against the notice's subject. */
  link: string | null;
  entity_type: string | null;
  entity_id: string | null;
  category: string;
  /** Kept for callers from before the delivery queue (20261127003500): email now carries the title, message and link. */
  email?: { subject?: string; details?: { label: string; value: string }[] };
}

/**
 * Delivers a notice to team members: only active ones, only those who could
 * open its subject themselves (`canSee`), in the bell when their preferences
 * allow it, and by email or chat when they asked for that kind (queued as
 * the notice is raised, sent here at once by lib/notification-delivery). The caller never
 * notifies themselves. Shared by /api/notifications and the server-composed
 * notices (/api/workspace/announce).
 */
export async function deliverTeamNotice(
  service: SupabaseClient,
  input: { recipientIds: string[]; callerId: string; notice: TeamNotice; canSee: CanSee },
): Promise<{ notified: number; emailed: number; withheld: number; error?: string }> {
  const { notice, callerId, canSee } = input;
  const { data: members, error: fetchError } = await service
    .from('team_members')
    .select('id, email, status, notification_prefs, email_notifications_enabled, email_notification_prefs')
    .in('id', input.recipientIds.filter((id) => id !== callerId))
    .eq('status', 'active');
  if (fetchError || !members) return { notified: 0, emailed: 0, withheld: 0, error: 'Failed to fetch recipients' };

  // A member only hears about what they could open themselves.
  const audience = (await Promise.all(members.map(async (member) => {
    const access = await resolveMemberAccess(service, member.id);
    return access && await canSee(access, member.id) ? member : null;
  }))).filter((member): member is (typeof members)[number] => member !== null);

  const inApp = audience.filter((member) => {
    const prefs = (member.notification_prefs || {}) as Record<string, boolean>;
    return prefs[notice.category] !== false;
  });
  await Promise.all(inApp.map((member) =>
    upsertNotification(service, {
      userId: member.id,
      title: notice.title,
      message: notice.message,
      link: notice.link,
      entityType: notice.entity_type,
      entityId: notice.entity_id,
      // A receipt is its producer's to name; a screen's notice is always an update.
      category: isReceiptCategory(notice.category) ? null : notice.category,
      actorId: callerId,
    }).catch((error: { message?: string }) => {
      console.error('[notifications] in-app upsert failed', { userId: member.id, error: error?.message });
    }),
  ));

  // Email (and chat) go out from the one delivery point: raising the notice
  // queued what each person asked for; this sends theirs now, not a minute later.
  let emailed = 0;
  try {
    const run = await deliverDueNotifications(service, { memberIds: inApp.map((member) => member.id) });
    emailed = run.sent.email;
  } catch (error) {
    // The scheduled pass sends them on its next call.
    console.error('[notifications] immediate delivery failed', { error: (error as Error)?.message });
  }
  return { notified: inApp.length, emailed, withheld: members.length - audience.length };
}
