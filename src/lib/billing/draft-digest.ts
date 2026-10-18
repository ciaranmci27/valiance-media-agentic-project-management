import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTransactional } from '@/lib/email/send-mail';
import { buildNotificationEmail } from '@/lib/email/templates/team/notification';
import { emailCategoryEnabled } from '@/lib/notification-defaults';
import type { NotificationPreferences } from '@/lib/types';

/**
 * The morning email about auto drafts (retainer and scheduled hours) made
 * since the last one: one message per owner or admin who has email
 * notifications on and has not turned "Invoice drafts" off. A notice whose
 * invoice is no longer a draft (already sent, or deleted) is dropped quietly.
 * Every notice it handles is marked, so a rerun never emails twice.
 */
export interface DraftDigestResult {
  drafts: number;
  recipients: number;
  emailed: number;
  outcome: 'sent' | 'nothing_new' | 'no_recipients' | 'failed';
}

interface NoticeRow {
  invoice_id: string;
  project_id: string;
  summary: string;
  project_invoices: { invoice_number: string; amount: number | string; status: string } | null;
}

type Send = typeof sendTransactional;

function money(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export async function runDraftDigest(service: SupabaseClient, send: Send = sendTransactional): Promise<DraftDigestResult> {
  const { data, error } = await service
    .from('billing_draft_notices')
    .select('invoice_id, project_id, summary, project_invoices(invoice_number, amount, status)')
    .is('emailed_at', null)
    .order('created_at');
  if (error) throw error;
  const notices = (data ?? []) as unknown as NoticeRow[];
  if (notices.length === 0) return { drafts: 0, recipients: 0, emailed: 0, outcome: 'nothing_new' };

  const live = notices.filter((notice) => notice.project_invoices?.status === 'draft');
  const markAll = async () => {
    const { error: markError } = await service
      .from('billing_draft_notices')
      .update({ emailed_at: new Date().toISOString() })
      .in('invoice_id', notices.map((notice) => notice.invoice_id));
    if (markError) throw markError;
  };
  if (live.length === 0) {
    await markAll();
    return { drafts: 0, recipients: 0, emailed: 0, outcome: 'nothing_new' };
  }

  const { data: members, error: membersError } = await service
    .from('team_members')
    .select('id, email, role, status, email_notifications_enabled, email_notification_prefs')
    .in('role', ['owner', 'admin'])
    .eq('status', 'active');
  if (membersError) throw membersError;
  const recipients = (members ?? []).filter((member) =>
    member.email && member.email_notifications_enabled
    && emailCategoryEnabled(member.email_notification_prefs as NotificationPreferences | null, 'invoice_drafts'));

  if (recipients.length === 0) {
    await markAll();
    return { drafts: live.length, recipients: 0, emailed: 0, outcome: 'no_recipients' };
  }

  const total = live.reduce((sum, notice) => sum + Number(notice.project_invoices?.amount ?? 0), 0);
  const title = live.length === 1 ? 'An invoice draft is ready to send' : `${live.length} invoice drafts are ready to send`;
  const message = live.length === 1
    ? live[0].summary
    : `${money(total)} in drafts, waiting for you to review and send. Nothing has been sent to a client.`;
  const projectIds = [...new Set(live.map((notice) => notice.project_id))];
  const { data: projects, error: projectsError } = await service.from('projects').select('id, name').in('id', projectIds);
  if (projectsError) throw projectsError;
  const projectName = new Map((projects ?? []).map((project) => [project.id as string, project.name as string]));
  const { html, text } = buildNotificationEmail({
    title,
    message,
    link: projectIds.length === 1 ? `/projects/${projectIds[0]}?tab=invoices` : '/finances/billing',
    details: live.slice(0, 8).map((notice) => ({
      label: `${notice.project_invoices?.invoice_number ?? 'Invoice'} · ${projectName.get(notice.project_id) ?? 'Project'}`,
      value: money(Number(notice.project_invoices?.amount ?? 0)),
    })),
  });

  const results = await Promise.allSettled(recipients.map((member) => send({
    to: member.email as string,
    subject: title,
    html,
    text,
  })));
  const emailed = results.filter((result) => result.status === 'fulfilled' && result.value.success).length;
  // Mark only when at least one went out, so a broken mail account retries tomorrow.
  if (emailed > 0) await markAll();
  return { drafts: live.length, recipients: recipients.length, emailed, outcome: emailed > 0 ? 'sent' : 'failed' };
}
