/**
 * Server-side orchestration for client-facing email communications.
 *
 * Supports five communication types:
 *   - portal_welcome     (manual)
 *   - project_summary    (manual)
 *   - budget_threshold   (automated, percentage alert_mode)
 *   - dollar_interval    (automated, dollar_interval alert_mode)
 *   - budget_extended    (automated on budget change)
 *
 * Exposes preview / send / enqueue-for-approval / approve / dismiss primitives
 * plus the automation evaluators used by time-entry and project PATCH hooks.
 */

import { getServiceClient } from '@/lib/api/supabase-service';
import { sendTransactional } from './send-mail';
import {
  buildPortalWelcomeEmail,
  portalWelcomeDefaults,
  type PortalWelcomeSlots,
} from './templates/client/portal-welcome';
import {
  buildProjectSummaryEmail,
  projectSummaryDefaults,
  type ProjectSummarySlots,
} from './templates/client/project-summary';
import {
  buildBudgetThresholdEmail,
  budgetThresholdDefaults,
  type BudgetThresholdSlots,
} from './templates/client/budget-threshold';
import {
  buildDollarIntervalEmail,
  dollarIntervalDefaults,
  type DollarIntervalSlots,
} from './templates/client/dollar-interval';
import {
  buildBudgetExtendedEmail,
  budgetExtendedDefaults,
  type BudgetExtendedSlots,
} from './templates/client/budget-extended';
import { getSiteUrl } from './templates/shared';
import { getLatestBudgetHistoryId, type BudgetType } from '@/lib/project-budget-history';
import type { ClientCommType, ProjectInvoice } from '@/lib/types';
import { paidHourlyLineItemTotal, invoicedTotalsByItemType } from '@/lib/invoice-utils';

// ─── Types ────────────────────────────────────────────────────────────────────

type AlertMode = 'percentage' | 'dollar_interval' | 'none';

export interface SendResult {
  success: boolean;
  error?: string;
  communicationId?: string;
}

export interface Recipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface RenderedCommunication {
  to: string[];
  cc: string[];
  bcc: string[];
  contactId: string;
  subject: string;
  html: string;
  text: string;
  defaults: Record<string, string>;
  metadata: Record<string, any>;
}

export interface RenderError {
  error: string;
}

/** Extra runtime context required for specific comm types. */
export interface RenderContext {
  thresholdPct?: number;
  milestone?: number;
  oldBudget?: number;
  newBudget?: number;
  oldBudgetType?: 'hours' | 'amount';
  newBudgetType?: 'hours' | 'amount';
}

// ─── Recipient helpers ───────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmailList(emails: string[] | undefined): string[] {
  if (!emails) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const e = (raw || '').trim();
    if (!e || !EMAIL_RE.test(e)) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Resolves the final recipient arrays for a send:
 * - If override.to is non-empty, use it (normalized). Otherwise fall back to
 *   the primary client's email as the single To.
 * - cc/bcc default to empty arrays and dedupe against To.
 */
function resolveRecipients(
  primaryEmail: string,
  override?: Partial<Recipients>,
): Recipients {
  const overrideTo = normalizeEmailList(override?.to);
  const to = overrideTo.length ? overrideTo : normalizeEmailList([primaryEmail]);
  const toSet = new Set(to.map(e => e.toLowerCase()));
  const cc = normalizeEmailList(override?.cc).filter(e => !toSet.has(e.toLowerCase()));
  const ccSet = new Set([...toSet, ...cc.map(e => e.toLowerCase())]);
  const bcc = normalizeEmailList(override?.bcc).filter(e => !ccSet.has(e.toLowerCase()));
  return { to, cc, bcc };
}

// ─── Data loaders ─────────────────────────────────────────────────────────────

interface PrimaryClient {
  contactId: string;
  name: string;
  email: string;
}

async function getPrimaryClient(projectId: string): Promise<PrimaryClient | null> {
  const supabase = getServiceClient();
  const { data } = await supabase
    .from('project_contacts')
    .select('contact_id, contact:contacts(id, name, email)')
    .eq('project_id', projectId)
    .eq('is_primary_client', true)
    .limit(1)
    .maybeSingle();

  if (!data?.contact) return null;
  const c = data.contact as any;
  if (!c.email) return null;
  return { contactId: c.id, name: c.name || 'there', email: c.email };
}

interface PortalInfo {
  token: string;
  accentColor: string;
  logoUrl: string;
  welcomeMessage: string;
  notificationThresholds: number[];
  alertMode: AlertMode;
  dollarInterval: number | null;
  requireApproval: boolean;
  rearmThresholdsOnBudgetChange: boolean;
}

async function getPortalInfo(projectId: string): Promise<PortalInfo | null> {
  const supabase = getServiceClient();
  const { data } = await supabase
    .from('portal_settings')
    .select(`
      token, accent_color, logo_url, welcome_message,
      notification_thresholds, alert_mode, dollar_interval, require_alert_approval,
      rearm_thresholds_on_budget_change, enabled
    `)
    .eq('project_id', projectId)
    .maybeSingle();

  if (!data || !data.enabled) return null;
  return {
    token: data.token,
    accentColor: data.accent_color,
    logoUrl: data.logo_url,
    welcomeMessage: data.welcome_message,
    notificationThresholds: data.notification_thresholds || [50, 75, 90, 100],
    alertMode: (data.alert_mode as AlertMode) || 'percentage',
    dollarInterval: data.dollar_interval ? Number(data.dollar_interval) : null,
    requireApproval: data.require_alert_approval !== false,
    rearmThresholdsOnBudgetChange: data.rearm_thresholds_on_budget_change === true,
  };
}

function portalUrl(token: string): string {
  return `${getSiteUrl()}/portal/${token}`;
}

interface ProjectRow {
  id: string;
  name: string;
  hourly_tracking: boolean;
  hourly_rate: number | null;
  budget_type: 'hours' | 'amount' | null;
  budget_value: number | null;
  created_by: string | null;
}

async function getProject(projectId: string): Promise<ProjectRow | null> {
  const supabase = getServiceClient();
  const { data } = await supabase
    .from('projects')
    .select('id, name, hourly_tracking, hourly_rate, budget_type, budget_value, created_by')
    .eq('id', projectId)
    .maybeSingle();
  return (data as ProjectRow | null) ?? null;
}

/** Returns the team member who should approve automated emails for this project. */
async function getApprovalRecipients(project: ProjectRow): Promise<string[]> {
  if (project.created_by) return [project.created_by];
  const supabase = getServiceClient();
  const { data } = await supabase
    .from('project_members')
    .select('member_id')
    .eq('project_id', project.id);
  return (data || []).map(r => r.member_id).filter(Boolean);
}

// ─── Hour + invoice helpers ───────────────────────────────────────────────────

function getWorkedHoursFromSegments(segments: any[]): number {
  if (!segments || segments.length === 0) return 0;
  let totalMs = 0;
  for (const seg of segments) {
    const startMs = new Date(seg.start).getTime();
    const endMs = seg.end ? new Date(seg.end).getTime() : Date.now();
    totalMs += Math.max(0, endMs - startMs);
  }
  return totalMs / 3_600_000;
}

function computeUnpaidHours(
  entries: Array<{ end_time: string | null; start_time: string; segments: any[] }>,
  invoices: ProjectInvoice[],
  hourlyRate: number,
): number {
  if (hourlyRate <= 0) return 0;

  // Pool only the hourly portion of paid invoices. A single invoice can mix
  // hourly, fixed, recurring, and reimbursement line items, so we walk
  // line_items rather than bucketing by the invoice-level invoice_type.
  let pool = paidHourlyLineItemTotal(invoices);

  const finalized = entries
    .filter(e => e.end_time !== null)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  let unpaid = 0;
  for (const entry of finalized) {
    const hours = getWorkedHoursFromSegments(entry.segments);
    const cost = hours * hourlyRate;
    if (pool >= cost) {
      pool -= cost;
    } else if (pool > 0) {
      const coveredHours = pool / hourlyRate;
      unpaid += hours - coveredHours;
      pool = 0;
    } else {
      unpaid += hours;
    }
  }
  return unpaid;
}

interface BudgetUsage {
  totalHours: number;
  totalAccrued: number;
  currentUsage: number;
}

/** Computes current budget usage using the same rules as InvoicesPanel. */
async function getBudgetUsage(project: ProjectRow): Promise<BudgetUsage> {
  const supabase = getServiceClient();
  const { data: entries } = await supabase
    .from('project_time_entries')
    .select('segments, end_time')
    .eq('project_id', project.id)
    .not('end_time', 'is', null);

  const totalHours = (entries || []).reduce(
    (sum, e) => sum + getWorkedHoursFromSegments(e.segments || []),
    0,
  );

  const rate = project.hourly_rate || 0;
  const totalAccrued = rate * totalHours;

  let currentUsage = 0;
  if (project.budget_type === 'hours') {
    currentUsage = totalHours;
  } else if (project.budget_type === 'amount') {
    if (project.hourly_tracking && rate > 0) {
      currentUsage = totalAccrued;
    } else {
      const { data: invoices } = await supabase
        .from('project_invoices')
        .select('id, amount, status, invoice_type, line_items')
        .eq('project_id', project.id)
        .neq('status', 'draft');
      const totals = invoicedTotalsByItemType((invoices || []) as ProjectInvoice[]);
      currentUsage = totals.hourly + totals.fixed + totals.recurring;
    }
  }

  return { totalHours, totalAccrued, currentUsage };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

export async function renderCommunication(
  projectId: string,
  type: ClientCommType,
  slotOverrides: Record<string, string> = {},
  context: RenderContext = {},
  recipientsOverride?: Partial<Recipients>,
): Promise<RenderedCommunication | RenderError> {
  const project = await getProject(projectId);
  if (!project) return { error: 'Project not found' };

  const portal = await getPortalInfo(projectId);
  if (!portal) return { error: 'Portal is not enabled for this project' };

  const client = await getPrimaryClient(projectId);
  if (!client) return { error: 'No primary client contact with an email address' };

  const recipients = resolveRecipients(client.email, recipientsOverride);
  if (recipients.to.length === 0) {
    return { error: 'At least one valid To recipient is required' };
  }

  // Strip empty / whitespace-only overrides so they fall through to defaults.
  // Required slots (subject, alert_paragraph, etc.) recover their non-empty
  // default copy; truly optional slots (welcome_message, closing_note,
  // custom_paragraph) have '' as their default and stay empty. This is the
  // single source of truth preventing blank-subject / blank-body emails
  // regardless of whether the value came from the approver modal or a
  // misbehaving API caller.
  const overrides: Record<string, string> = Object.fromEntries(
    Object.entries(slotOverrides).filter(([, v]) => typeof v === 'string' && v.trim().length > 0),
  );

  const common = {
    projectName: project.name,
    clientName: client.name,
    portalUrl: portalUrl(portal.token),
    accentColor: portal.accentColor,
    logoUrl: portal.logoUrl || undefined,
  };

  if (type === 'portal_welcome') {
    const defaults = portalWelcomeDefaults({
      projectName: project.name,
      portalWelcomeMessage: portal.welcomeMessage,
    });
    const slots: PortalWelcomeSlots = { ...defaults, ...(overrides as Partial<PortalWelcomeSlots>) };
    const { subject, html, text } = buildPortalWelcomeEmail({ ...common, slots });
    return {
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      contactId: client.contactId,
      subject,
      html,
      text,
      defaults: defaults as unknown as Record<string, string>,
      metadata: {},
    };
  }

  if (type === 'project_summary') {
    const usage = await getBudgetUsage(project);
    const supabase = getServiceClient();
    const isHourly = project.hourly_tracking ?? false;
    const hourlyRate = project.hourly_rate ?? 0;

    const { data: invoices } = await supabase
      .from('project_invoices')
      .select('*')
      .eq('project_id', projectId)
      .neq('status', 'draft');
    const activeInvoices = (invoices || []) as ProjectInvoice[];

    const { data: entries } = await supabase
      .from('project_time_entries')
      .select('start_time, end_time, segments')
      .eq('project_id', projectId);
    const allEntries = entries || [];

    const totalInvoiced = activeInvoices.reduce((sum, inv) => sum + inv.amount, 0);
    const totalPaid = activeInvoices
      .filter(inv => inv.status === 'paid')
      .reduce((sum, inv) => sum + inv.amount, 0);

    // Bucket invoiced dollars by line-item type, not by the invoice-level
    // invoice_type, so a mixed invoice contributes correctly to each bucket.
    const invoicedByType = invoicedTotalsByItemType(activeInvoices);
    const hourlyInvoiced = invoicedByType.hourly;
    const nonHourlyOwed = invoicedByType.fixed + invoicedByType.recurring + invoicedByType.reimbursement;
    const serviceInvoiced = invoicedByType.hourly + invoicedByType.fixed + invoicedByType.recurring;
    const billableTotal = Math.max(hourlyRate * usage.totalHours, hourlyInvoiced) + nonHourlyOwed;
    const outstanding = isHourly
      ? Math.max(0, billableTotal - totalPaid)
      : Math.max(0, totalInvoiced - totalPaid);

    let unpaidHours: number | null = null;
    if (isHourly && hourlyRate > 0) {
      unpaidHours = computeUnpaidHours(
        allEntries.map(e => ({
          end_time: e.end_time,
          start_time: e.start_time,
          segments: e.segments || [],
        })),
        activeInvoices,
        hourlyRate,
      );
    }

    const paidInvoices = activeInvoices
      .filter((inv): inv is ProjectInvoice & { paid_date: string } => inv.status === 'paid' && !!inv.paid_date)
      .sort((a, b) => new Date(b.paid_date).getTime() - new Date(a.paid_date).getTime());
    const lastPaid = paidInvoices[0] || null;

    let budgetUsed: number | null = null;
    if (project.budget_type && project.budget_value) {
      budgetUsed = project.budget_type === 'hours'
        ? usage.totalHours
        : (isHourly ? hourlyRate * usage.totalHours : serviceInvoiced);
    }

    const defaults = projectSummaryDefaults({ projectName: project.name });
    const slots: ProjectSummarySlots = { ...defaults, ...(overrides as Partial<ProjectSummarySlots>) };
    const { subject, html, text } = buildProjectSummaryEmail({
      ...common,
      unpaidHours,
      hourlyRate: isHourly ? hourlyRate : null,
      currentBalance: outstanding,
      lastPaymentDate: lastPaid?.paid_date || null,
      lastPaymentAmount: lastPaid?.amount || null,
      budgetType: project.budget_type,
      budgetValue: project.budget_value,
      budgetUsed,
      slots,
    });

    return {
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      contactId: client.contactId,
      subject,
      html,
      text,
      defaults: defaults as unknown as Record<string, string>,
      metadata: {},
    };
  }

  if (type === 'budget_threshold') {
    if (!project.budget_type || !project.budget_value) {
      return { error: 'Project has no budget configured' };
    }
    const thresholdPct = context.thresholdPct;
    if (!thresholdPct || thresholdPct <= 0) {
      return { error: 'thresholdPct required for budget_threshold' };
    }
    const usage = await getBudgetUsage(project);
    const defaults = budgetThresholdDefaults({
      projectName: project.name,
      thresholdPct,
      budgetType: project.budget_type,
    });
    const slots: BudgetThresholdSlots = { ...defaults, ...(overrides as Partial<BudgetThresholdSlots>) };
    const { subject, html, text } = buildBudgetThresholdEmail({
      ...common,
      budgetType: project.budget_type,
      budgetValue: project.budget_value,
      currentUsage: usage.currentUsage,
      thresholdPct,
      slots,
    });
    return {
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      contactId: client.contactId,
      subject,
      html,
      text,
      defaults: defaults as unknown as Record<string, string>,
      metadata: { threshold: thresholdPct },
    };
  }

  if (type === 'dollar_interval') {
    if (!project.hourly_tracking || !project.hourly_rate) {
      return { error: 'Dollar interval alerts require an hourly project' };
    }
    const milestone = context.milestone;
    if (!milestone || milestone <= 0) {
      return { error: 'milestone required for dollar_interval' };
    }
    const usage = await getBudgetUsage(project);
    const defaults = dollarIntervalDefaults({ projectName: project.name, milestone });
    const slots: DollarIntervalSlots = { ...defaults, ...(overrides as Partial<DollarIntervalSlots>) };
    const { subject, html, text } = buildDollarIntervalEmail({
      ...common,
      milestone,
      totalAccrued: usage.totalAccrued,
      hourlyRate: project.hourly_rate,
      totalHours: usage.totalHours,
      slots,
    });
    return {
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      contactId: client.contactId,
      subject,
      html,
      text,
      defaults: defaults as unknown as Record<string, string>,
      metadata: { type: 'dollar_interval', milestone },
    };
  }

  if (type === 'budget_extended') {
    if (!project.budget_type) return { error: 'Project has no budget configured' };
    const { oldBudget, newBudget } = context;
    if (oldBudget === undefined || newBudget === undefined) {
      return { error: 'oldBudget and newBudget required for budget_extended' };
    }
    // Fallback to the current (new) project type for either side if the caller
    // didn't supply it. This preserves correct rendering for legacy pending rows
    // that were enqueued before type-aware metadata existed.
    const oldBudgetType = context.oldBudgetType ?? project.budget_type;
    const newBudgetType = context.newBudgetType ?? project.budget_type;
    const usage = await getBudgetUsage(project);
    const defaults = budgetExtendedDefaults({
      projectName: project.name,
      oldBudget,
      oldBudgetType,
      newBudget,
      newBudgetType,
    });
    const slots: BudgetExtendedSlots = { ...defaults, ...(overrides as Partial<BudgetExtendedSlots>) };
    const { subject, html, text } = buildBudgetExtendedEmail({
      ...common,
      oldBudget,
      oldBudgetType,
      newBudget,
      newBudgetType,
      currentUsage: usage.currentUsage,
      slots,
    });
    return {
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      contactId: client.contactId,
      subject,
      html,
      text,
      defaults: defaults as unknown as Record<string, string>,
      metadata: { oldBudget, newBudget, oldBudgetType, newBudgetType },
    };
  }

  return { error: `Unknown communication type: ${type}` };
}

// ─── Persistence helpers ──────────────────────────────────────────────────────

interface InsertRowArgs {
  projectId: string;
  contactId: string;
  type: ClientCommType;
  status: 'sent' | 'pending' | 'failed';
  subject: string;
  renderedHtml: string;
  renderedText: string;
  slotOverrides: Record<string, string>;
  metadata: Record<string, any>;
  recipients: Recipients;
  triggeredBy?: string | null;
}

type InsertOutcome =
  | { outcome: 'inserted'; id: string }
  | { outcome: 'duplicate' }
  | { outcome: 'error'; error: string };

/**
 * Inserts a new communication row.
 *
 * Returns 'duplicate' when a partial unique index (see migration
 * 20260415_client_comm_dedup.sql) blocks the insert because another
 * concurrent eval already wrote a dedup row for the same automated
 * threshold/milestone tuple. Callers MUST treat this as "another
 * process is handling it" and abort sending.
 */
async function insertCommunication(args: InsertRowArgs): Promise<InsertOutcome> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('client_communications')
    .insert({
      project_id: args.projectId,
      contact_id: args.contactId,
      notification_type: args.type,
      status: args.status,
      subject: args.subject,
      rendered_html: args.renderedHtml,
      rendered_text: args.renderedText,
      slot_overrides: args.slotOverrides,
      metadata: args.metadata,
      recipients: args.recipients,
      triggered_by: args.triggeredBy ?? null,
      sent_at: args.status === 'sent' ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (error) {
    // Postgres unique_violation: another process won the dedup race.
    if ((error as any).code === '23505') return { outcome: 'duplicate' };
    return { outcome: 'error', error: error.message };
  }
  if (!data) return { outcome: 'error', error: 'Insert returned no row' };
  return { outcome: 'inserted', id: data.id };
}

/**
 * Marks a previously inserted row as failed and stamps the error.
 * Also clears sent_at so reporting doesn't claim a successful send
 * for a row whose SMTP attempt actually failed. The unique-index
 * WHERE clause excludes status='failed' so this releases the dedup
 * lock and a future eval can retry.
 */
async function markCommunicationFailed(commId: string, errorMsg: string): Promise<void> {
  const supabase = getServiceClient();
  // Read existing metadata so we don't clobber it when stamping the error.
  const { data: row } = await supabase
    .from('client_communications')
    .select('metadata')
    .eq('id', commId)
    .maybeSingle();
  const prevMeta = (row?.metadata as Record<string, any> | null) || {};
  await supabase
    .from('client_communications')
    .update({
      status: 'failed',
      sent_at: null,
      metadata: { ...prevMeta, send_error: errorMsg },
    })
    .eq('id', commId);
}

async function notifyApprovers(
  project: ProjectRow,
  commId: string,
  type: ClientCommType,
  subject: string,
) {
  const recipients = await getApprovalRecipients(project);
  if (recipients.length === 0) return;
  const supabase = getServiceClient();
  const labels: Record<ClientCommType, string> = {
    portal_welcome: 'Portal welcome',
    project_summary: 'Project summary',
    budget_threshold: 'Budget threshold alert',
    dollar_interval: 'Dollar interval alert',
    budget_extended: 'Budget update',
  };
  const title = `${labels[type]} ready for review`;
  const link = `/projects/${project.id}?tab=communications&pending=${commId}`;
  for (const userId of recipients) {
    supabase
      .rpc('upsert_notification', {
        p_user_id: userId,
        p_title: title,
        p_message: `${project.name}: ${subject}`,
        p_link: link,
        p_entity_type: 'project',
        p_entity_id: project.id,
      })
      .then(
        () => {},
        (err) => {
          console.error('[client-notifications] notifyApprovers failed', {
            projectId: project.id,
            commId,
            userId,
            error: err?.message || err,
          });
        },
      );
  }
}

// ─── Public primitives ────────────────────────────────────────────────────────

/** Returns the rendered email without sending it. */
export async function previewCommunication(
  projectId: string,
  type: ClientCommType,
  slotOverrides: Record<string, string> = {},
  context: RenderContext = {},
  recipients?: Partial<Recipients>,
): Promise<RenderedCommunication | RenderError> {
  return renderCommunication(projectId, type, slotOverrides, context, recipients);
}

/**
 * Renders and sends, logging as `sent`.
 *
 * Order of operations is "insert dedup row first, then send" rather than
 * "send first, then log." That ordering matters for automated comm types
 * (budget_threshold, dollar_interval) because the partial unique indexes
 * on the dedup row act as the only protection against two concurrent eval
 * runs each shipping the same email. If we sent first, both racers would
 * pass the SMTP step before either one tried to record the row. Inserting
 * first turns the unique index into the lock.
 *
 * Failure handling: if the insert succeeds but SMTP fails, the row is
 * flipped to status='failed' which releases the unique-index lock so
 * the next eval can retry. If the insert collides with an existing
 * dedup row (Postgres 23505), we treat the call as a no-op success.
 */
export async function sendCommunication(
  projectId: string,
  type: ClientCommType,
  opts: {
    slotOverrides?: Record<string, string>;
    triggeredBy?: string | null;
    context?: RenderContext;
    extraMetadata?: Record<string, any>;
    recipients?: Partial<Recipients>;
  } = {},
): Promise<SendResult> {
  const rendered = await renderCommunication(
    projectId,
    type,
    opts.slotOverrides || {},
    opts.context || {},
    opts.recipients,
  );
  if ('error' in rendered) return { success: false, error: rendered.error };
  if (!rendered.subject.trim() || !rendered.html.trim()) {
    return { success: false, error: 'Rendered email is missing required content' };
  }

  const inserted = await insertCommunication({
    projectId,
    contactId: rendered.contactId,
    type,
    // Optimistic 'sent'. The race window between insert and SMTP
    // confirmation is short, and on send failure we flip to 'failed'
    // below. The alternative (insert as 'pending' first) would cause
    // automated rows to briefly appear in the human approval queue.
    status: 'sent',
    subject: rendered.subject,
    renderedHtml: rendered.html,
    renderedText: rendered.text,
    slotOverrides: opts.slotOverrides || {},
    metadata: { ...rendered.metadata, ...(opts.extraMetadata || {}) },
    recipients: { to: rendered.to, cc: rendered.cc, bcc: rendered.bcc },
    triggeredBy: opts.triggeredBy ?? null,
  });

  if (inserted.outcome === 'duplicate') {
    // Another process already raced to send this exact dedup tuple.
    // Returning success without sending is the correct no-op.
    return { success: true };
  }
  if (inserted.outcome === 'error') {
    return { success: false, error: inserted.error };
  }

  const commId = inserted.id;
  const sendRes = await sendTransactional({
    to: rendered.to,
    cc: rendered.cc.length ? rendered.cc : undefined,
    bcc: rendered.bcc.length ? rendered.bcc : undefined,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  if (!sendRes.success) {
    await markCommunicationFailed(commId, sendRes.error || 'Send failed');
    return { success: false, error: sendRes.error || 'Send failed' };
  }

  return { success: true, communicationId: commId };
}

/** Renders and stores a pending row awaiting team approval. */
export async function enqueuePendingCommunication(
  projectId: string,
  type: ClientCommType,
  opts: {
    slotOverrides?: Record<string, string>;
    context?: RenderContext;
    extraMetadata?: Record<string, any>;
    recipients?: Partial<Recipients>;
  } = {},
): Promise<SendResult> {
  const rendered = await renderCommunication(
    projectId,
    type,
    opts.slotOverrides || {},
    opts.context || {},
    opts.recipients,
  );
  if ('error' in rendered) return { success: false, error: rendered.error };
  if (!rendered.subject.trim() || !rendered.html.trim()) {
    return { success: false, error: 'Rendered email is missing required content' };
  }

  const project = await getProject(projectId);
  if (!project) return { success: false, error: 'Project not found' };

  const inserted = await insertCommunication({
    projectId,
    contactId: rendered.contactId,
    type,
    status: 'pending',
    subject: rendered.subject,
    renderedHtml: rendered.html,
    renderedText: rendered.text,
    slotOverrides: opts.slotOverrides || {},
    metadata: { ...rendered.metadata, ...(opts.extraMetadata || {}) },
    recipients: { to: rendered.to, cc: rendered.cc, bcc: rendered.bcc },
    triggeredBy: null,
  });

  if (inserted.outcome === 'duplicate') {
    // Another concurrent eval already enqueued this same dedup tuple.
    // Skip notifying approvers a second time.
    return { success: true };
  }
  if (inserted.outcome === 'error') {
    return { success: false, error: inserted.error };
  }

  await notifyApprovers(project, inserted.id, type, rendered.subject);
  return { success: true, communicationId: inserted.id };
}

/** Approves a pending communication: sends it and marks the row as sent. */
export async function approveCommunication(
  commId: string,
  triggeredBy: string | null,
  slotOverrides?: Record<string, string>,
  recipientsOverride?: Partial<Recipients>,
): Promise<SendResult> {
  const supabase = getServiceClient();
  const { data: row } = await supabase
    .from('client_communications')
    .select('id, project_id, contact_id, notification_type, status, subject, rendered_html, rendered_text, slot_overrides, metadata, recipients, contact:contacts(email)')
    .eq('id', commId)
    .maybeSingle();
  if (!row) return { success: false, error: 'Communication not found' };
  if (row.status !== 'pending') return { success: false, error: 'Communication is not pending' };

  const contact = row.contact as any;
  if (!contact?.email) return { success: false, error: 'Contact has no email address' };

  let subject = row.subject || '';
  let html = row.rendered_html || '';
  // Preserve the plain-text alternative across approval. Falls back to the
  // stored render so SMTP still gets a multipart body even when the
  // approver doesn't edit any slots. Empty string means "no text", which
  // is OK only for legacy rows enqueued before rendered_text existed.
  let text = (row.rendered_text as string | null) || '';
  let finalOverrides = (row.slot_overrides as Record<string, string>) || {};
  let finalMetadata = (row.metadata as Record<string, any>) || {};

  // Resolve final recipients: start from what was stored at enqueue time,
  // falling back to the contact's email, then merge the approval-time override.
  const storedRecipients = (row.recipients as Partial<Recipients> | null) || {};
  const baseRecipients: Partial<Recipients> = {
    to: storedRecipients.to?.length ? storedRecipients.to : [contact.email],
    cc: storedRecipients.cc || [],
    bcc: storedRecipients.bcc || [],
  };
  const finalRecipients = resolveRecipients(
    contact.email,
    recipientsOverride ?? baseRecipients,
  );
  if (finalRecipients.to.length === 0) {
    return { success: false, error: 'At least one valid To recipient is required' };
  }

  // If overrides were edited at approval time, re-render with current data.
  if (slotOverrides) {
    finalOverrides = { ...finalOverrides, ...slotOverrides };
    const ctx: RenderContext = {
      thresholdPct: finalMetadata.threshold,
      milestone: finalMetadata.milestone,
      oldBudget: finalMetadata.oldBudget,
      newBudget: finalMetadata.newBudget,
      oldBudgetType: finalMetadata.oldBudgetType,
      newBudgetType: finalMetadata.newBudgetType,
    };
    const rendered = await renderCommunication(
      row.project_id,
      row.notification_type as ClientCommType,
      finalOverrides,
      ctx,
      finalRecipients,
    );
    if ('error' in rendered) return { success: false, error: rendered.error };
    subject = rendered.subject;
    html = rendered.html;
    text = rendered.text;
  }

  // Final guard: refuse to send if the stored row lost its rendered body
  // or the re-render above produced empty output. Protects against legacy
  // rows, template bugs, or callers passing every slot as whitespace.
  if (!subject.trim() || !html.trim()) {
    return { success: false, error: 'Email is missing a subject or body' };
  }

  const sendRes = await sendTransactional({
    to: finalRecipients.to,
    cc: finalRecipients.cc.length ? finalRecipients.cc : undefined,
    bcc: finalRecipients.bcc.length ? finalRecipients.bcc : undefined,
    subject,
    html,
    text: text || undefined,
  });
  if (!sendRes.success) return { success: false, error: sendRes.error || 'Send failed' };

  // CAS on status='pending' so a racing dismiss can't leave this row in a
  // half-dismissed / half-sent state. The pre-read check at line 868 is not
  // enough on its own because a dismiss can land between read and write.
  await supabase
    .from('client_communications')
    .update({
      status: 'sent',
      subject,
      rendered_html: html,
      rendered_text: text,
      slot_overrides: finalOverrides,
      recipients: finalRecipients,
      triggered_by: triggeredBy,
      sent_at: new Date().toISOString(),
    })
    .eq('id', commId)
    .eq('status', 'pending');

  return { success: true, communicationId: commId };
}

/** Marks a pending communication as dismissed without sending. */
export async function dismissCommunication(
  commId: string,
  triggeredBy: string | null,
): Promise<SendResult> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from('client_communications')
    .update({
      status: 'dismissed',
      triggered_by: triggeredBy,
      dismissed_at: new Date().toISOString(),
    })
    .eq('id', commId)
    .eq('status', 'pending');
  if (error) return { success: false, error: error.message };
  return { success: true, communicationId: commId };
}

/**
 * Inserts a dismissed dedup row for a threshold or milestone that was
 * crossed at the same time as a higher one. Used to collapse a multi-
 * crossing eval into a single email (the highest), while still
 * recording the lower crossings so they never fire later.
 *
 * A unique-violation (23505) means a previous run already recorded this
 * crossing; that is the desired idempotent outcome. Any other error
 * (auth, constraint, schema drift) is logged so it's not silently masked.
 */
async function insertSupersededDismissal(args: {
  projectId: string;
  contactId: string;
  type: 'budget_threshold' | 'dollar_interval';
  metadata: Record<string, any>;
}): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.from('client_communications').insert({
    project_id: args.projectId,
    contact_id: args.contactId,
    notification_type: args.type,
    status: 'dismissed',
    slot_overrides: {},
    metadata: { auto_dismissed: true, reason: 'superseded_by_higher', ...args.metadata },
    recipients: { to: [], cc: [], bcc: [] },
    triggered_by: null,
    dismissed_at: new Date().toISOString(),
  });
  if (error && (error as any).code !== '23505') {
    console.error('[client-notifications] insertSupersededDismissal failed', {
      projectId: args.projectId,
      type: args.type,
      metadata: args.metadata,
      error: error.message,
    });
  }
}

/**
 * Automation dispatch: either sends directly or enqueues for approval
 * based on the project's `require_alert_approval` setting.
 */
async function dispatchAutomated(
  projectId: string,
  type: ClientCommType,
  context: RenderContext,
  extraMetadata: Record<string, any> = {},
): Promise<SendResult> {
  const portal = await getPortalInfo(projectId);
  if (!portal) return { success: false, error: 'Portal disabled' };
  if (portal.requireApproval) {
    return enqueuePendingCommunication(projectId, type, { context, extraMetadata });
  }
  return sendCommunication(projectId, type, { context, extraMetadata });
}

// ─── Automation evaluators ────────────────────────────────────────────────────

/**
 * Called after time-entry mutations. Routes to the configured alert_mode.
 * Fire-and-forget safe: swallows its own errors.
 */
export async function evaluateBudgetAlerts(projectId: string): Promise<void> {
  try {
    const project = await getProject(projectId);
    if (!project) return;
    const portal = await getPortalInfo(projectId);
    if (!portal || portal.alertMode === 'none') return;

    if (portal.alertMode === 'percentage') {
      await evaluatePercentageAlerts(project, portal);
    } else if (portal.alertMode === 'dollar_interval') {
      await evaluateDollarIntervalAlerts(project, portal);
    }
  } catch {
    // Never let automation failures surface to the caller.
  }
}

async function evaluatePercentageAlerts(project: ProjectRow, portal: PortalInfo): Promise<void> {
  if (!project.budget_type || !project.budget_value || project.budget_value <= 0) return;

  const usage = await getBudgetUsage(project);
  const currentPct = (usage.currentUsage / project.budget_value) * 100;
  const thresholds = [...portal.notificationThresholds].sort((a, b) => a - b);

  // When rearm mode is on, a threshold only counts as "handled" if it was
  // fired under the current budget era (latest project_budget_history row).
  // When off, any past firing blocks re-sending (absolute behavior).
  const currentEraId = portal.rearmThresholdsOnBudgetChange
    ? await getLatestBudgetHistoryId(project.id)
    : null;

  const supabase = getServiceClient();
  const { data: existing } = await supabase
    .from('client_communications')
    .select('metadata, status')
    .eq('project_id', project.id)
    .eq('notification_type', 'budget_threshold')
    .in('status', ['pending', 'sent', 'dismissed']);

  const handled = new Set<number>();
  for (const row of existing || []) {
    const meta = (row.metadata as any) || {};
    const t = meta.threshold;
    if (typeof t !== 'number') continue;
    if (portal.rearmThresholdsOnBudgetChange) {
      // Rearm mode: only rows fired under the CURRENT era count as handled.
      if (meta.fired_under_history_id === currentEraId) handled.add(t);
    } else {
      // Absolute mode: a row blocks re-firing only if it was fired under the
      // same budget type. Type switches (e.g. amount -> hours) treat the new
      // budget as distinct, so 75% under the new unit can fire again. Legacy
      // rows (no fired_under_budget_type) stay conservative and always block.
      const firedType = meta.fired_under_budget_type;
      if (!firedType || firedType === project.budget_type) handled.add(t);
    }
  }

  const fireMeta: Record<string, any> = {};
  if (currentEraId) fireMeta.fired_under_history_id = currentEraId;
  if (project.budget_type) fireMeta.fired_under_budget_type = project.budget_type;

  // Collapse storms: if a single eval crosses multiple thresholds (e.g. a
  // large timer bump goes from 40% straight to 95%, crossing 50/75/90), we
  // send one email for the highest and auto-dismiss the lower crossings so
  // they don't fire on the next eval. thresholds is ascending.
  const crossed = thresholds.filter(t => currentPct >= t && !handled.has(t));
  if (crossed.length === 0) return;
  const highest = crossed[crossed.length - 1];
  const skipped = crossed.slice(0, -1);

  if (skipped.length > 0) {
    const primary = await getPrimaryClient(project.id);
    if (primary) {
      for (const t of skipped) {
        await insertSupersededDismissal({
          projectId: project.id,
          contactId: primary.contactId,
          type: 'budget_threshold',
          metadata: { threshold: t, superseded_by: highest, ...fireMeta },
        });
      }
    }
  }

  await dispatchAutomated(
    project.id,
    'budget_threshold',
    { thresholdPct: highest },
    fireMeta,
  );
}

async function evaluateDollarIntervalAlerts(project: ProjectRow, portal: PortalInfo): Promise<void> {
  if (!project.hourly_tracking || !project.hourly_rate || project.hourly_rate <= 0) return;
  const interval = portal.dollarInterval;
  if (!interval || interval <= 0) return;

  const usage = await getBudgetUsage(project);
  if (usage.totalAccrued <= 0) return;

  const latestMilestone = Math.floor(usage.totalAccrued / interval) * interval;
  if (latestMilestone <= 0) return;

  const supabase = getServiceClient();
  const { data: existing } = await supabase
    .from('client_communications')
    .select('metadata')
    .eq('project_id', project.id)
    .eq('notification_type', 'dollar_interval')
    .in('status', ['pending', 'sent', 'dismissed']);

  const sent = new Set<number>();
  for (const row of existing || []) {
    const m = (row.metadata as any)?.milestone;
    if (typeof m === 'number') sent.add(m);
  }

  // Collapse storms: if tracked accrual jumped past several milestones in a
  // single eval, fire once for the highest crossed milestone and silently
  // dismiss the intermediate ones so they never trigger later.
  const crossed: number[] = [];
  for (let m = interval; m <= latestMilestone; m += interval) {
    if (!sent.has(m)) crossed.push(m);
  }
  if (crossed.length === 0) return;
  const highest = crossed[crossed.length - 1];
  const skipped = crossed.slice(0, -1);

  if (skipped.length > 0) {
    const primary = await getPrimaryClient(project.id);
    if (primary) {
      for (const m of skipped) {
        await insertSupersededDismissal({
          projectId: project.id,
          contactId: primary.contactId,
          type: 'dollar_interval',
          metadata: { milestone: m, superseded_by: highest },
        });
      }
    }
  }

  await dispatchAutomated(project.id, 'dollar_interval', { milestone: highest }, { milestone: highest });
}

/**
 * Called when a project's budget_value or budget_type changes.
 *
 * Behavior:
 * - If both sides represent a real budget (type + positive value), sends the
 *   "Budget updated" email with BOTH units rendered in their own unit.
 * - Handles type-only changes (e.g. $5,000 -> 5,000 hrs) as meaningful changes.
 * - In absolute mode, silently marks already-crossed thresholds at the new
 *   budget as dismissed so they don't re-fire. Dismissal rows are stamped
 *   with the current budget type so a later type switch can allow re-firing.
 * - In rearm mode, skips auto-dismiss so thresholds fire fresh in the new era.
 */
export async function handleBudgetChange(
  projectId: string,
  oldBudgetType: BudgetType,
  oldBudgetValue: number | null,
  newBudgetType: BudgetType,
  newBudgetValue: number | null,
  triggeredBy: string | null = null,
  newHistoryId: string | null = null,
): Promise<void> {
  try {
    // True no-op: nothing changed on either field.
    if (oldBudgetType === newBudgetType && oldBudgetValue === newBudgetValue) return;

    const project = await getProject(projectId);
    if (!project) return;
    const portal = await getPortalInfo(projectId);
    if (!portal) return;

    // Only send the "budget updated" email when BOTH sides are a real budget.
    // Initial set (null -> X), clears (X -> null), and zero/negative budgets
    // don't fit the "from X to Y" framing.
    const oldIsReal = oldBudgetType != null && oldBudgetValue != null && oldBudgetValue > 0;
    const newIsReal = newBudgetType != null && newBudgetValue != null && newBudgetValue > 0;
    if (oldIsReal && newIsReal) {
      await dispatchAutomated(
        projectId,
        'budget_extended',
        {
          oldBudget: oldBudgetValue,
          newBudget: newBudgetValue,
          oldBudgetType: oldBudgetType as 'hours' | 'amount',
          newBudgetType: newBudgetType as 'hours' | 'amount',
        },
        {
          oldBudget: oldBudgetValue,
          newBudget: newBudgetValue,
          oldBudgetType,
          newBudgetType,
        },
      );
    }

    // Rearm mode: every budget change starts a new era. Thresholds already
    // crossed under the new budget SHOULD fire fresh, so skip auto-dismiss
    // entirely and let evaluatePercentageAlerts handle them under the new era.
    if (portal.rearmThresholdsOnBudgetChange) return;

    // Absolute mode: pre-mark already-crossed thresholds at the new budget as
    // dismissed, so evaluateBudgetAlerts won't fire duplicates. Skip when the
    // new state has no usable budget (type missing or value <= 0).
    if (
      portal.alertMode === 'percentage' &&
      newBudgetType &&
      newBudgetValue != null &&
      newBudgetValue > 0
    ) {
      const usage = await getBudgetUsage({
        ...project,
        budget_type: newBudgetType,
        budget_value: newBudgetValue,
      });
      const currentPct = (usage.currentUsage / newBudgetValue) * 100;

      const supabase = getServiceClient();
      const { data: existing } = await supabase
        .from('client_communications')
        .select('metadata')
        .eq('project_id', projectId)
        .eq('notification_type', 'budget_threshold')
        // Match the eval query's status filter. Excluding 'failed' here
        // means a prior failed send won't be auto-dismissed away; the
        // next eval is still free to retry it.
        .in('status', ['pending', 'sent', 'dismissed']);
      // Only count rows under the SAME budget type as "already handled" for
      // this type's dedup. A type switch lets thresholds under the new unit
      // re-fire. Legacy rows without fired_under_budget_type stay conservative
      // and always block.
      const handled = new Set<number>();
      for (const row of existing || []) {
        const meta = (row.metadata as any) || {};
        const t = meta.threshold;
        if (typeof t !== 'number') continue;
        const firedType = meta.fired_under_budget_type;
        if (!firedType || firedType === newBudgetType) handled.add(t);
      }

      const primary = await getPrimaryClient(projectId);
      if (!primary) return;

      for (const threshold of portal.notificationThresholds) {
        if (currentPct >= threshold && !handled.has(threshold)) {
          await supabase.from('client_communications').insert({
            project_id: projectId,
            contact_id: primary.contactId,
            notification_type: 'budget_threshold',
            status: 'dismissed',
            subject: null,
            rendered_html: null,
            slot_overrides: {},
            metadata: {
              threshold,
              auto_dismissed: true,
              reason: 'budget_change',
              fired_under_budget_type: newBudgetType,
              ...(newHistoryId ? { fired_under_history_id: newHistoryId } : {}),
            },
            triggered_by: triggeredBy,
            dismissed_at: new Date().toISOString(),
          });
        }
      }
    }
  } catch {
    // Never let automation failures surface to the caller.
  }
}

// ─── Legacy exports (kept for existing time-entry route imports) ──────────────

/**
 * @deprecated Use `evaluateBudgetAlerts` directly. Kept so existing
 * time-entry route imports keep working during the migration.
 */
export const checkBudgetThresholds = evaluateBudgetAlerts;

/** @deprecated Use `sendCommunication(projectId, 'portal_welcome', ...)`. */
export async function sendPortalWelcome(projectId: string): Promise<SendResult> {
  return sendCommunication(projectId, 'portal_welcome');
}

/** @deprecated Use `sendCommunication(projectId, 'project_summary', ...)`. */
export async function sendProjectSummary(projectId: string): Promise<SendResult> {
  return sendCommunication(projectId, 'project_summary');
}
