/**
 * Invoice email template for clients.
 * Sent manually from a project invoice row with the invoice PDF attached.
 */

import {
  ctaButton,
  escapeHtml,
  getSiteName,
  brandPrimary,
  brandLight,
  brandSubtle,
  NEUTRAL,
} from '../shared';
import { clientEmailLayout, clientAvatar } from './layout';
import type { InvoiceStatus } from '@/lib/types';

export interface InvoiceEmailSlots {
  subject: string;
  opening_line: string;
  closing_line: string;
}

export function invoiceEmailDefaults(ctx: {
  projectName: string;
  invoiceNumber: string;
  amount: number;
  dueDate: string | null;
  paidDate: string | null;
  status: InvoiceStatus;
}): InvoiceEmailSlots {
  const dueText = ctx.dueDate ? ` due ${fmtDate(ctx.dueDate)}` : '';
  const paidText = ctx.paidDate ? ` on ${fmtDate(ctx.paidDate)}` : '';
  const amount = fmtCurrency(ctx.amount);

  switch (ctx.status) {
    case 'draft':
      return {
        subject: `Draft invoice ${ctx.invoiceNumber} for ${ctx.projectName}`,
        opening_line: `A draft invoice for ${amount} is attached for review. No payment is due until the invoice is finalized.`,
        closing_line: 'Please reply with any changes you would like before we send the final invoice.',
      };
    case 'paid':
      return {
        subject: `Payment received for invoice ${ctx.invoiceNumber}`,
        opening_line: `Thank you, invoice ${ctx.invoiceNumber} for ${amount} is marked paid${paidText}. A copy is attached for your records.`,
        closing_line: 'Thank you again for the payment.',
      };
    case 'overdue':
      return {
        subject: `Overdue invoice ${ctx.invoiceNumber} for ${ctx.projectName}`,
        opening_line: `A quick reminder that invoice ${ctx.invoiceNumber} for ${amount} is past due${dueText}. The invoice PDF is attached for reference.`,
        closing_line: 'Please let us know if you need anything from us to complete payment.',
      };
    case 'cancelled':
      return {
        subject: `Cancelled invoice ${ctx.invoiceNumber} for ${ctx.projectName}`,
        opening_line: `Invoice ${ctx.invoiceNumber} for ${amount} has been cancelled. A copy is attached for your records, and no payment is needed for this invoice.`,
        closing_line: 'Thank you, and we will send a separate invoice if anything replaces this one.',
      };
    case 'sent':
    default:
      return {
        subject: `Invoice ${ctx.invoiceNumber} for ${ctx.projectName}`,
        opening_line: `Invoice ${ctx.invoiceNumber} for ${amount} is attached${dueText}.`,
        closing_line: 'Thank you, and let us know if you have any questions.',
      };
  }
}

interface InvoiceEmailParams {
  projectName: string;
  clientName: string;
  portalUrl: string | null;
  accentColor?: string;
  logoUrl?: string;
  invoiceNumber: string;
  invoiceAmount: number;
  issueDate: string;
  dueDate: string | null;
  paidDate: string | null;
  status: InvoiceStatus;
  slots: InvoiceEmailSlots;
}

function fmtCurrency(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? new Date(year, month - 1, day)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusLabel(value: string): string {
  return value
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function statusDetails(status: InvoiceStatus): {
  eyebrow: string;
  amountLabel: string;
  attachmentSentence: string;
  portalCtaLabel: string;
  note: string;
} {
  switch (status) {
    case 'draft':
      return {
        eyebrow: 'Draft Invoice',
        amountLabel: 'Draft Total',
        attachmentSentence: 'The draft invoice PDF is attached to this email.',
        portalCtaLabel: 'Review draft invoice',
        note: 'This is a draft for review. Payment is not due until the invoice is finalized.',
      };
    case 'paid':
      return {
        eyebrow: 'Payment Received',
        amountLabel: 'Paid',
        attachmentSentence: 'A PDF copy is attached to this email for your records.',
        portalCtaLabel: 'View paid invoice',
        note: 'This invoice is marked paid. No further action is needed.',
      };
    case 'overdue':
      return {
        eyebrow: 'Past Due Invoice',
        amountLabel: 'Past Due',
        attachmentSentence: 'The overdue invoice PDF is attached to this email.',
        portalCtaLabel: 'View overdue invoice',
        note: 'This invoice is past due. Please complete payment when you can.',
      };
    case 'cancelled':
      return {
        eyebrow: 'Cancelled Invoice',
        amountLabel: 'Cancelled Total',
        attachmentSentence: 'A PDF copy of the cancelled invoice is attached for your records.',
        portalCtaLabel: 'View cancelled invoice',
        note: 'This invoice has been cancelled. No payment is needed for it.',
      };
    case 'sent':
    default:
      return {
        eyebrow: 'Invoice',
        amountLabel: 'Amount Due',
        attachmentSentence: 'The PDF invoice is attached to this email.',
        portalCtaLabel: 'View invoice in portal',
        note: 'Payment details are included in the attached invoice.',
      };
  }
}

export function buildInvoiceEmail(
  params: InvoiceEmailParams,
): { subject: string; html: string; text: string } {
  const {
    projectName,
    clientName,
    portalUrl,
    accentColor,
    logoUrl,
    invoiceNumber,
    invoiceAmount,
    issueDate,
    dueDate,
    paidDate,
    status,
    slots,
  } = params;

  const siteName = getSiteName();
  const primary = brandPrimary();
  const light = brandLight();
  const subtle = brandSubtle();
  const safeClient = escapeHtml(clientName);
  const safeProject = escapeHtml(projectName);
  const safeInvoiceNumber = escapeHtml(invoiceNumber);
  const safeStatus = escapeHtml(statusLabel(status));
  const details = statusDetails(status);
  const portalCta = portalUrl ? ctaButton(details.portalCtaLabel, portalUrl) : '';

  const rows = [
    { label: 'Invoice', value: safeInvoiceNumber },
    { label: 'Amount', value: fmtCurrency(invoiceAmount) },
    { label: 'Issued', value: fmtDate(issueDate) },
    ...(dueDate ? [{ label: 'Due', value: fmtDate(dueDate) }] : []),
    ...(paidDate ? [{ label: 'Paid', value: fmtDate(paidDate) }] : []),
    { label: 'Status', value: safeStatus },
  ];

  const detailsHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
      margin: 0 0 24px 0;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid ${NEUTRAL.border};
    ">
      <tr><td style="background-color: ${light}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
      <tr><td style="padding: 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${rows.map((row, index) => `
            <tr>
              <td style="padding: 12px 16px; ${index < rows.length - 1 ? `border-bottom: 1px solid ${NEUTRAL.border};` : ''}">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color: ${NEUTRAL.textMuted}; font-size: 13px; font-weight: 500;">
                      ${escapeHtml(row.label)}
                    </td>
                    <td align="right" style="color: ${NEUTRAL.black}; font-size: 13px; font-weight: 700;">
                      ${row.value}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          `).join('')}
        </table>
      </td></tr>
    </table>
  `;

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
      <tr>
        <td style="padding: 0 14px 0 0; vertical-align: middle;">
          ${clientAvatar(projectName, logoUrl, 44)}
        </td>
        <td style="vertical-align: middle;">
          <p style="margin: 0 0 2px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: ${light}; font-weight: 600;">${escapeHtml(details.eyebrow)}</p>
          <p style="margin: 0; font-size: 22px; font-weight: 700; color: ${NEUTRAL.black}; line-height: 1.3;">${safeProject}</p>
        </td>
      </tr>
    </table>

    <p style="margin: 0 0 8px 0; color: ${NEUTRAL.textBody}; font-size: 15px;">
      Hi ${safeClient},
    </p>
    <p style="margin: 0 0 24px 0; color: ${NEUTRAL.textBody}; font-size: 15px; line-height: 1.7;">
      ${escapeHtml(slots.opening_line)}
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0; border-radius: 10px; overflow: hidden; border: 1px solid ${NEUTRAL.border};">
      <tr><td style="background-color: ${primary}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
      <tr>
        <td style="padding: 24px 16px; text-align: center; background-color: ${subtle};">
          <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: ${NEUTRAL.textMuted}; font-weight: 600;">${escapeHtml(details.amountLabel)}</p>
          <p style="margin: 0; font-size: 28px; font-weight: 800; color: ${primary};">${fmtCurrency(invoiceAmount)}</p>
          <p style="margin: 8px 0 0 0; font-size: 13px; color: ${NEUTRAL.textMuted};">${escapeHtml(details.note)}</p>
        </td>
      </tr>
    </table>

    ${detailsHtml}

    <p style="margin: 0 0 8px 0; color: ${NEUTRAL.textBody}; font-size: 14px;">
      ${escapeHtml(details.attachmentSentence)}
    </p>
    ${portalCta}
    <p style="margin: 0; color: ${NEUTRAL.textMuted}; font-size: 13px;">
      ${escapeHtml(slots.closing_line)}
    </p>
  `;

  const html = clientEmailLayout({
    preheader: `${details.eyebrow}: ${invoiceNumber} for ${projectName}`,
    body,
    portalUrl,
    accentColor,
  });

  const lines = [
    `Hi ${clientName},`,
    '',
    slots.opening_line,
    '',
    `Invoice: ${invoiceNumber}`,
    `Amount: ${fmtCurrency(invoiceAmount)}`,
    `Issued: ${fmtDate(issueDate)}`,
    ...(dueDate ? [`Due: ${fmtDate(dueDate)}`] : []),
    ...(paidDate ? [`Paid: ${fmtDate(paidDate)}`] : []),
    `Status: ${statusLabel(status)}`,
    '',
    details.note,
    details.attachmentSentence,
    '',
    ...(portalUrl ? ['View the invoice in your portal:', portalUrl, ''] : []),
    slots.closing_line,
    '',
    '---',
    siteName,
  ];

  return { subject: slots.subject, html, text: lines.join('\n') };
}
