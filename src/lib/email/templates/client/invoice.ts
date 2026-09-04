/**
 * Invoice email template for clients.
 * Sent manually from a project invoice row with the invoice PDF attached.
 */

import {
  EMAIL,
  FONT_MONO,
  FONT_SANS,
  accentPalette,
  chip,
  ctaButton,
  escapeHtml,
  getSiteName,
  kvRows,
  label,
  linkLine,
  paragraph,
  tile,
} from '../shared';
import { clientEmailLayout, clientHeader, greeting } from './layout';
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
  const overdueText = ctx.dueDate ? `was due ${fmtDate(ctx.dueDate)} and is now past due` : 'is past due';
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
        opening_line: `A quick reminder that invoice ${ctx.invoiceNumber} for ${amount} ${overdueText}. The invoice PDF is attached for reference.`,
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
        opening_line: `Invoice ${ctx.invoiceNumber} for ${amount} is attached${dueText ? ` and is${dueText}` : ''}.`,
        closing_line: 'Thank you, and let us know if you have any questions.',
      };
  }
}

interface InvoiceEmailParams {
  projectName: string;
  clientName: string;
  portalUrl: string | null;
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

type Tone = 'teal' | 'copper' | 'error' | 'neutral';

function statusDetails(status: InvoiceStatus): {
  eyebrow: string;
  title: string;
  tail: string;
  /** Tint of the amount tile. Neutral for open and draft invoices. */
  tileTone: Tone;
  /** Tone of the status pill. Sent reads teal: open and on track. */
  chipTone: Tone;
  amountLabel: string;
  attachmentSentence: string;
  portalCtaLabel: string;
  note: string;
} {
  switch (status) {
    case 'draft':
      return {
        eyebrow: 'Draft invoice',
        title: 'Draft invoice for',
        tail: 'review.',
        tileTone: 'neutral',
        chipTone: 'neutral',
        amountLabel: 'Draft total',
        attachmentSentence: 'The draft invoice PDF is attached to this email.',
        portalCtaLabel: 'Review draft invoice',
        note: 'This is a draft for review. Payment is not due until the invoice is finalized.',
      };
    case 'paid':
      return {
        eyebrow: 'Payment received',
        title: 'Payment',
        tail: 'received.',
        tileTone: 'teal',
        chipTone: 'teal',
        amountLabel: 'Amount paid',
        attachmentSentence: 'A PDF copy is attached to this email for your records.',
        portalCtaLabel: 'View paid invoice',
        note: 'This invoice is marked paid. No further action is needed.',
      };
    case 'overdue':
      return {
        eyebrow: 'Past due invoice',
        title: 'This invoice is',
        tail: 'past due.',
        tileTone: 'copper',
        chipTone: 'copper',
        amountLabel: 'Past due',
        attachmentSentence: 'The overdue invoice PDF is attached to this email.',
        portalCtaLabel: 'View overdue invoice',
        note: 'This invoice is past due. Please complete payment when you can.',
      };
    case 'cancelled':
      return {
        eyebrow: 'Cancelled invoice',
        title: 'Invoice',
        tail: 'cancelled.',
        tileTone: 'error',
        chipTone: 'error',
        amountLabel: 'Cancelled total',
        attachmentSentence: 'A PDF copy of the cancelled invoice is attached for your records.',
        portalCtaLabel: 'View cancelled invoice',
        note: 'This invoice has been cancelled. No payment is needed for it.',
      };
    case 'sent':
    default:
      return {
        eyebrow: 'Invoice',
        title: 'Your invoice is',
        tail: 'ready.',
        tileTone: 'neutral',
        chipTone: 'teal',
        amountLabel: 'Amount due',
        attachmentSentence: 'The PDF invoice is attached to this email.',
        portalCtaLabel: 'View invoice in portal',
        note: 'Payment details are included in the attached invoice.',
      };
  }
}

function amountColor(tone: Tone): string {
  if (tone === 'teal') return accentPalette().bright;
  if (tone === 'copper') return EMAIL.copper300;
  if (tone === 'error') return EMAIL.error;
  return EMAIL.ink;
}

export function buildInvoiceEmail(
  params: InvoiceEmailParams,
): { subject: string; html: string; text: string } {
  const {
    projectName,
    clientName,
    portalUrl,
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
  const details = statusDetails(status);
  const amount = fmtCurrency(invoiceAmount);

  const heroTile = tile(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align: top;">
          ${label(details.amountLabel)}
          <p style="margin: 0; font-family: ${FONT_MONO}; font-size: 32px; line-height: 1.1; font-weight: 300; letter-spacing: -0.02em; color: ${amountColor(details.tileTone)};">${escapeHtml(amount)}</p>
        </td>
        <td align="right" style="vertical-align: top; text-align: right; padding: 0 0 0 12px;">
          ${chip(statusLabel(status), details.chipTone)}
        </td>
      </tr>
    </table>
    <p style="margin: 14px 0 0 0; font-family: ${FONT_SANS}; font-size: 13px; line-height: 1.5; color: ${EMAIL.muted};">${escapeHtml(details.note)}</p>`,
    { tone: details.tileTone, padding: '20px 22px' },
  );

  const rows = [
    { label: 'Invoice', value: invoiceNumber, strong: true },
    { label: 'Issued', value: fmtDate(issueDate) },
    ...(dueDate ? [{ label: 'Due', value: fmtDate(dueDate) }] : []),
    ...(paidDate ? [{ label: 'Paid', value: fmtDate(paidDate) }] : []),
  ];

  const body = `
    ${clientHeader({
      projectName,
      logoUrl,
      title: details.title,
      tail: details.tail,
      meta: [projectName, `Invoice ${invoiceNumber}`, `Issued ${fmtDate(issueDate)}`],
    })}
    ${greeting(clientName)}
    ${paragraph(escapeHtml(slots.opening_line))}
    ${heroTile}
    ${kvRows(rows)}
    ${paragraph(escapeHtml(details.attachmentSentence))}
    ${portalUrl ? ctaButton(details.portalCtaLabel, portalUrl) : ''}
    ${portalUrl ? linkLine(portalUrl) : ''}
    ${paragraph(escapeHtml(slots.closing_line), { muted: true, size: 13 })}
  `;

  const html = clientEmailLayout({
    preheader: `${details.eyebrow}: ${invoiceNumber} for ${projectName}`,
    body,
    portalUrl,
  });

  const lines = [
    `Hi ${clientName},`,
    '',
    slots.opening_line,
    '',
    `${details.amountLabel}: ${amount}`,
    `Status: ${statusLabel(status)}`,
    `Invoice: ${invoiceNumber}`,
    `Issued: ${fmtDate(issueDate)}`,
    ...(dueDate ? [`Due: ${fmtDate(dueDate)}`] : []),
    ...(paidDate ? [`Paid: ${fmtDate(paidDate)}`] : []),
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
