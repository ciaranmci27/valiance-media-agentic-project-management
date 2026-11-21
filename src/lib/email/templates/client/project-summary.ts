/**
 * Project Summary email template for clients.
 * Sent manually as a status update. Carefully framed to avoid bill-like language.
 *
 * Editable copy lives in `ProjectSummarySlots`. Numbers (hours, balance, budget
 * progress, dates) are always computed from real project state. With Billing
 * and finance switched off (`billing: false`) the email carries none of them:
 * no balance, payment or budget, only the update and the portal link.
 */

import type { Brand } from '@/lib/brand';
import {
  EMAIL,
  FONT_MONO,
  FONT_SANS,
  accentPalette,
  ctaButton,
  escapeHtml,
  getSiteName,
  kvRows,
  label,
  linkLine,
  paragraph,
  statGrid,
  tile,
  withEmailBrand,
} from '../shared';
import { formatMoneyExact } from '@/lib/format';
import { clientEmailLayout, clientHeader, formatEmailHours, greeting, usageMeter, type EmailRegion } from './layout';

export interface ProjectSummarySlots {
  subject: string;
  opening_line: string;
  closing_line: string;
  custom_paragraph: string;
}

export function projectSummaryDefaults(ctx: { projectName: string }): ProjectSummarySlots {
  return {
    subject: `Project update: ${ctx.projectName}`,
    opening_line: 'Here is a quick update on where things stand with your project.',
    closing_line: 'Let us know if you have any questions.',
    custom_paragraph: '',
  };
}

interface ProjectSummaryParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
  logoUrl?: string;
  unpaidHours: number | null;
  hourlyRate: number | null;
  currentBalance: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
  /** The paid invoice's own currency; left out, the workspace's. */
  lastPaymentCurrency?: string | null;
  budgetType: 'hours' | 'amount' | null;
  budgetValue: number | null;
  budgetUsed: number | null;
  /** False when Client invoicing is switched off: every money and budget line is left out. */
  billing?: boolean;
  slots: ProjectSummarySlots;
  /** The workspace region: the balance and budget are in the workspace currency. */
  region: EmailRegion;
  /** A short line under the balance when it leaves out invoices in another currency. */
  balanceNote?: string;
}

/** Date-only strings (YYYY-MM-DD) are read as local dates so they never slip a day. */
function formatSummaryDate(value: string | Date, locale: string): string {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else {
    const [year, month, day] = value.split('-').map(Number);
    date = /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
      ? new Date(year, month - 1, day)
      : new Date(value);
  }
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Renders with the workspace's brand (getBrand), so the name, logo and colors are this workspace's. */
export function buildProjectSummaryEmail(params: ProjectSummaryParams & { brand: Brand }): { subject: string; html: string; text: string } {
  return withEmailBrand(params.brand, () => renderProjectSummaryEmail(params));
}

function renderProjectSummaryEmail(params: ProjectSummaryParams): { subject: string; html: string; text: string } {
  const {
    projectName, clientName, portalUrl, logoUrl,
    unpaidHours, hourlyRate, currentBalance,
    lastPaymentDate, lastPaymentAmount, lastPaymentCurrency,
    budgetType, budgetValue, budgetUsed,
    slots, region, balanceNote,
  } = params;
  const name = getSiteName();
  const fmtCurrency = (value: number, currency?: string | null) => formatMoneyExact(value, { currency: currency || region.currency, locale: region.locale });
  const fmtHours = (value: number) => formatEmailHours(value, region.locale);
  const fmtDate = (value: string | Date) => formatSummaryDate(value, region.locale);
  const teal = accentPalette();
  const billing = params.billing !== false;

  const allCaughtUp = currentBalance <= 0 && (!unpaidHours || unpaidHours <= 0);

  let statsHtml = '';
  if (!billing) {
    // No balance to report: the update stands on its own.
  } else if (allCaughtUp) {
    statsHtml = tile(
      `${label('Balance', { color: teal.bright })}
       <p style="margin: 0 0 4px 0; font-family: ${FONT_MONO}; font-size: 24px; line-height: 1.1; font-weight: 300; letter-spacing: -0.02em; color: ${teal.bright};">All caught up</p>
       <p style="margin: 0; font-family: ${FONT_SANS}; font-size: 14px; line-height: 1.5; color: ${EMAIL.body};">No outstanding balance at this time.</p>`,
      { tone: 'teal', padding: '20px 22px' },
    );
  } else {
    const stats: Array<{ label: string; value: string }> = [];
    if (unpaidHours && unpaidHours > 0 && hourlyRate && hourlyRate > 0) {
      stats.push({ label: 'Hours since last payment', value: fmtHours(unpaidHours) });
    }
    if (currentBalance > 0) {
      stats.push({ label: 'Current balance', value: fmtCurrency(currentBalance) });
    }
    if (stats.length > 0) statsHtml = statGrid(stats);
    if (currentBalance > 0 && balanceNote) statsHtml += paragraph(escapeHtml(balanceNote), { muted: true, size: 13 });
  }

  // Plain-text lines for the facts beneath the numbers. The HTML renders the
  // payment as a key/value row and the budget as a meter.
  const detailRows: Array<{ label: string; value: string }> = [];

  let paymentHtml = '';
  if (billing && lastPaymentDate && lastPaymentAmount && lastPaymentAmount > 0) {
    const row = { label: 'Last payment', value: `${fmtCurrency(lastPaymentAmount, lastPaymentCurrency)} on ${fmtDate(lastPaymentDate)}` };
    detailRows.push(row);
    paymentHtml = kvRows([row]);
  }

  let budgetHtml = '';
  if (billing && budgetType && budgetValue && budgetValue > 0 && budgetUsed !== null) {
    const pct = Math.min(100, Math.round((budgetUsed / budgetValue) * 100));
    const fmt = budgetType === 'hours' ? fmtHours : (value: number) => fmtCurrency(value);
    detailRows.push({ label: 'Budget progress', value: `${pct}% of ${fmt(budgetValue)}` });
    budgetHtml = `
      ${label('Budget progress', { margin: '4px 0 10px 0' })}
      ${usageMeter({ percent: pct, left: `${pct}% used`, right: `${fmt(budgetUsed)} of ${fmt(budgetValue)}` })}`;
  }

  const body = `
    ${clientHeader({
      projectName,
      logoUrl,
      title: 'Where things',
      tail: 'stand.',
      meta: [projectName, 'Project update', fmtDate(new Date())],
    })}
    ${greeting(clientName)}
    ${paragraph(escapeHtml(slots.opening_line))}
    ${statsHtml}
    ${paymentHtml}
    ${budgetHtml}
    ${slots.custom_paragraph ? paragraph(escapeHtml(slots.custom_paragraph)) : ''}
    ${paragraph('The full breakdown is in your project portal.')}
    ${ctaButton('View full details', portalUrl)}
    ${linkLine(portalUrl)}
    ${paragraph(escapeHtml(slots.closing_line), { muted: true, size: 13 })}
  `;

  const html = clientEmailLayout({
    preheader: `Project update for ${projectName}`,
    body,
    portalUrl,
  });

  const lines = [
    `Hi ${clientName},`,
    '',
    slots.opening_line,
    '',
  ];
  if (!billing) {
    // No balance lines.
  } else if (allCaughtUp) {
    lines.push('All caught up. No outstanding balance at this time.', '');
  } else {
    if (unpaidHours && unpaidHours > 0) {
      lines.push(`Hours since last payment: ${fmtHours(unpaidHours)}`);
    }
    if (currentBalance > 0) {
      lines.push(`Current balance: ${fmtCurrency(currentBalance)}`);
      if (balanceNote) lines.push(balanceNote);
    }
    lines.push('');
  }
  detailRows.forEach(r => lines.push(`${r.label}: ${r.value}`));
  if (detailRows.length > 0) lines.push('');
  if (slots.custom_paragraph) lines.push(slots.custom_paragraph, '');
  lines.push(
    'The full breakdown is in your project portal:',
    portalUrl,
    '',
    slots.closing_line,
    '',
    '---',
    name,
  );

  return { subject: slots.subject, html, text: lines.join('\n') };
}
