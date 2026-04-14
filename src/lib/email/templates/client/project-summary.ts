/**
 * Project Summary email template for clients.
 * Sent manually as a status update. Carefully framed to avoid bill-like language.
 *
 * Editable copy lives in `ProjectSummarySlots`. Numbers (hours, balance, budget
 * progress, dates) are always computed from real project state.
 */

import { ctaButton, escapeHtml, getSiteName, brandPrimary, brandLight, brandSubtle, NEUTRAL } from '../shared';
import { clientEmailLayout, clientAvatar } from './layout';

export interface ProjectSummarySlots {
  subject: string;
  opening_line: string;
  closing_line: string;
  custom_paragraph: string;
}

export function projectSummaryDefaults(ctx: { projectName: string }): ProjectSummarySlots {
  return {
    subject: `Project update: ${ctx.projectName}`,
    opening_line: "Here's a quick update on where things stand with your project.",
    closing_line: 'Let us know if you have any questions.',
    custom_paragraph: '',
  };
}

interface ProjectSummaryParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
  accentColor?: string;
  logoUrl?: string;
  unpaidHours: number | null;
  hourlyRate: number | null;
  currentBalance: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
  budgetType: 'hours' | 'amount' | null;
  budgetValue: number | null;
  budgetUsed: number | null;
  slots: ProjectSummarySlots;
}

function fmtCurrency(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtHours(value: number): string {
  return `${value.toFixed(1)} hrs`;
}

export function buildProjectSummaryEmail(
  params: ProjectSummaryParams,
): { subject: string; html: string; text: string } {
  const {
    projectName, clientName, portalUrl, accentColor, logoUrl,
    unpaidHours, hourlyRate, currentBalance,
    lastPaymentDate, lastPaymentAmount,
    budgetType, budgetValue, budgetUsed,
    slots,
  } = params;
  const name = getSiteName();
  const primary = brandPrimary();
  const light = brandLight();
  const subtle = brandSubtle();

  const safeClient = escapeHtml(clientName);
  const safeProject = escapeHtml(projectName);

  const allCaughtUp = currentBalance <= 0 && (!unpaidHours || unpaidHours <= 0);

  let statsHtml = '';
  if (allCaughtUp) {
    statsHtml = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0; border-radius: 10px; overflow: hidden; border: 1px solid ${NEUTRAL.border};">
        <tr><td style="background-color: ${primary}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
        <tr>
          <td style="padding: 28px; text-align: center; background-color: ${subtle};">
            <p style="margin: 0 0 8px 0; font-size: 32px; line-height: 1;">&#10003;</p>
            <p style="margin: 0 0 4px 0; font-size: 20px; font-weight: 700; color: ${primary};">All caught up</p>
            <p style="margin: 0; font-size: 14px; color: ${NEUTRAL.textMuted};">No outstanding balance at this time.</p>
          </td>
        </tr>
      </table>
    `;
  } else {
    const cards: string[] = [];

    if (unpaidHours && unpaidHours > 0 && hourlyRate && hourlyRate > 0) {
      cards.push(`
        <td width="${currentBalance > 0 ? '49%' : '100%'}" style="${currentBalance > 0 ? 'padding: 0 8px 0 0;' : ''} vertical-align: top;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius: 10px; overflow: hidden; border: 1px solid ${NEUTRAL.border};">
            <tr><td style="background-color: ${light}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
            <tr>
              <td style="padding: 20px 16px; text-align: center; background-color: ${NEUTRAL.white};">
                <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: ${NEUTRAL.textMuted}; font-weight: 600;">Hours since last payment</p>
                <p style="margin: 0; font-size: 24px; font-weight: 800; color: ${NEUTRAL.black};">${fmtHours(unpaidHours)}</p>
              </td>
            </tr>
          </table>
        </td>
      `);
    }
    if (currentBalance > 0) {
      cards.push(`
        <td width="${cards.length > 0 ? '49%' : '100%'}" style="${cards.length > 0 ? 'padding: 0 0 0 8px;' : ''} vertical-align: top;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius: 10px; overflow: hidden; border: 1px solid ${NEUTRAL.border};">
            <tr><td style="background-color: ${primary}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
            <tr>
              <td style="padding: 20px 16px; text-align: center; background-color: ${NEUTRAL.white};">
                <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: ${NEUTRAL.textMuted}; font-weight: 600;">Current balance</p>
                <p style="margin: 0; font-size: 24px; font-weight: 800; color: ${primary};">${fmtCurrency(currentBalance)}</p>
              </td>
            </tr>
          </table>
        </td>
      `);
    }

    if (cards.length > 0) {
      statsHtml = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
          <tr>${cards.join('')}</tr>
        </table>
      `;
    }
  }

  const detailRows: Array<{ label: string; value: string }> = [];

  if (lastPaymentDate && lastPaymentAmount && lastPaymentAmount > 0) {
    const dateStr = new Date(lastPaymentDate).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    detailRows.push({ label: 'Last payment', value: `${fmtCurrency(lastPaymentAmount)} on ${dateStr}` });
  }

  if (budgetType && budgetValue && budgetValue > 0 && budgetUsed !== null) {
    const pct = Math.min(100, Math.round((budgetUsed / budgetValue) * 100));
    if (budgetType === 'hours') {
      detailRows.push({ label: 'Budget progress', value: `${pct}% of ${fmtHours(budgetValue)}` });
    } else {
      detailRows.push({ label: 'Budget progress', value: `${pct}% of ${fmtCurrency(budgetValue)}` });
    }
  }

  const detailsHtml = detailRows.length > 0 ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
      margin: 0 0 24px 0;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid ${NEUTRAL.border};
    ">
      <tr><td style="background-color: ${light}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
      <tr><td style="padding: 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${detailRows.map((r, i) => `
            <tr>
              <td style="padding: 12px 16px; ${i < detailRows.length - 1 ? `border-bottom: 1px solid ${NEUTRAL.border};` : ''}">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color: ${NEUTRAL.textMuted}; font-size: 13px; font-weight: 500;">
                      ${escapeHtml(r.label)}
                    </td>
                    <td align="right" style="color: ${NEUTRAL.black}; font-size: 13px; font-weight: 600;">
                      ${escapeHtml(r.value)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          `).join('')}
        </table>
      </td></tr>
    </table>
  ` : '';

  const customParagraphBlock = slots.custom_paragraph
    ? `<p style="margin: 0 0 24px 0; color: ${NEUTRAL.textBody}; font-size: 15px; line-height: 1.7;">${escapeHtml(slots.custom_paragraph)}</p>`
    : '';

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
      <tr>
        <td style="padding: 0 14px 0 0; vertical-align: middle;">
          ${clientAvatar(projectName, logoUrl, 44)}
        </td>
        <td style="vertical-align: middle;">
          <p style="margin: 0 0 2px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: ${light}; font-weight: 600;">Project Update</p>
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

    ${statsHtml}
    ${detailsHtml}
    ${customParagraphBlock}

    <p style="margin: 0 0 8px 0; color: ${NEUTRAL.textBody}; font-size: 14px;">
      You can view the full details in your project portal anytime.
    </p>
    ${ctaButton('View Full Details', portalUrl)}
    <p style="margin: 0; color: ${NEUTRAL.textMuted}; font-size: 13px;">
      ${escapeHtml(slots.closing_line)}
    </p>
  `;

  const html = clientEmailLayout({
    preheader: `Project update for ${projectName}`,
    body,
    portalUrl,
    accentColor,
  });

  const lines = [
    `Hi ${clientName},`,
    '',
    slots.opening_line,
    '',
  ];
  if (allCaughtUp) {
    lines.push('All caught up! No outstanding balance at this time.', '');
  } else {
    if (unpaidHours && unpaidHours > 0) {
      lines.push(`Hours since last payment: ${fmtHours(unpaidHours)}`);
    }
    if (currentBalance > 0) {
      lines.push(`Current balance: ${fmtCurrency(currentBalance)}`);
    }
    lines.push('');
  }
  detailRows.forEach(r => lines.push(`${r.label}: ${r.value}`));
  if (detailRows.length > 0) lines.push('');
  if (slots.custom_paragraph) lines.push(slots.custom_paragraph, '');
  lines.push(
    'View the full details:',
    portalUrl,
    '',
    slots.closing_line,
    '',
    '---',
    name,
  );

  return { subject: slots.subject, html, text: lines.join('\n') };
}
