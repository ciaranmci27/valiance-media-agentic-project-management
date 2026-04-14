/**
 * Budget threshold alert email template for clients.
 * Sent automatically (or via approval) when tracked work crosses a configured percentage.
 */

import { ctaButton, escapeHtml, getSiteName, brandPrimary, brandLight, brandSubtle, NEUTRAL } from '../shared';
import { clientEmailLayout, clientAvatar } from './layout';

export interface BudgetThresholdSlots {
  subject: string;
  alert_paragraph: string;
  closing_line: string;
}

export function budgetThresholdDefaults(ctx: {
  projectName: string;
  thresholdPct: number;
  budgetType: 'hours' | 'amount';
}): BudgetThresholdSlots {
  const label = ctx.budgetType === 'hours' ? 'hours' : 'dollar';
  return {
    subject: `${ctx.projectName} has reached ${ctx.thresholdPct}% of its budget`,
    alert_paragraph: `Just a heads up: your project has reached ${ctx.thresholdPct}% of its ${label} budget. Here's a quick snapshot.`,
    closing_line: 'You can view the full breakdown in your project portal.',
  };
}

interface BudgetThresholdParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
  accentColor?: string;
  logoUrl?: string;
  budgetType: 'hours' | 'amount';
  budgetValue: number;
  currentUsage: number;
  thresholdPct: number;
  slots: BudgetThresholdSlots;
}

function formatValue(value: number, type: 'hours' | 'amount'): string {
  if (type === 'hours') {
    return `${value.toFixed(1)} hrs`;
  }
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function progressBar(pct: number, fillColor: string): string {
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  const remaining = 100 - clamped;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0;">
      <tr>
        <td style="
          background-color: ${fillColor};
          height: 12px;
          width: ${clamped}%;
          border-radius: ${remaining === 0 ? '6px' : '6px 0 0 6px'};
        "></td>
        ${remaining > 0 ? `<td style="
          background-color: ${NEUTRAL.border};
          height: 12px;
          width: ${remaining}%;
          border-radius: ${clamped === 0 ? '6px' : '0 6px 6px 0'};
        "></td>` : ''}
      </tr>
    </table>
  `;
}

function statCard(label: string, value: string, accent: string, valueColor: string, padStyle: string): string {
  return `
    <td width="33%" style="${padStyle} vertical-align: top;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius: 10px; overflow: hidden; border: 1px solid ${NEUTRAL.border};">
        <tr><td style="background-color: ${accent}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
        <tr>
          <td style="padding: 18px 12px; text-align: center; background-color: ${NEUTRAL.white};">
            <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: ${NEUTRAL.textMuted}; font-weight: 600;">${label}</p>
            <p style="margin: 0; font-size: 22px; font-weight: 800; color: ${valueColor};">${value}</p>
          </td>
        </tr>
      </table>
    </td>
  `;
}

export function buildBudgetThresholdEmail(
  params: BudgetThresholdParams,
): { subject: string; html: string; text: string } {
  const { projectName, clientName, portalUrl, accentColor, logoUrl, budgetType, budgetValue, currentUsage, thresholdPct, slots } = params;
  const name = getSiteName();
  const remaining = Math.max(0, budgetValue - currentUsage);
  const primary = brandPrimary();
  const light = brandLight();
  const subtle = brandSubtle();
  const safeClient = escapeHtml(clientName);
  const safeProject = escapeHtml(projectName);

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
      <tr>
        <td style="padding: 0 14px 0 0; vertical-align: middle; width: 44px;">
          ${clientAvatar(projectName, logoUrl, 44)}
        </td>
        <td style="vertical-align: middle;">
          <p style="margin: 0 0 2px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: ${light}; font-weight: 600;">Budget Alert</p>
          <p style="margin: 0; font-size: 22px; font-weight: 700; color: ${NEUTRAL.black}; line-height: 1.3;">${safeProject}</p>
        </td>
        <td align="right" style="vertical-align: middle;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="
                background-color: ${subtle};
                border-radius: 20px;
                padding: 5px 14px;
                font-size: 14px;
                font-weight: 700;
                color: ${primary};
              ">${thresholdPct}%</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin: 0 0 8px 0; color: ${NEUTRAL.textBody}; font-size: 15px;">
      Hi ${safeClient},
    </p>
    <p style="margin: 0 0 24px 0; color: ${NEUTRAL.textBody}; font-size: 15px; line-height: 1.7;">
      ${escapeHtml(slots.alert_paragraph)}
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 6px 0;">
      <tr>
        <td>${progressBar(thresholdPct, light)}</td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 20px 0;">
      <tr>
        <td style="font-size: 12px; color: ${NEUTRAL.textMuted}; font-weight: 500;">${thresholdPct}% used</td>
        <td align="right" style="font-size: 12px; color: ${NEUTRAL.textMuted}; font-weight: 500;">${formatValue(budgetValue, budgetType)} total</td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 28px 0;">
      <tr>
        ${statCard('Budget', formatValue(budgetValue, budgetType), primary, NEUTRAL.black, 'padding: 0 6px 0 0;')}
        ${statCard('Used', formatValue(currentUsage, budgetType), light, primary, 'padding: 0 3px;')}
        ${statCard('Remaining', formatValue(remaining, budgetType), primary, NEUTRAL.black, 'padding: 0 0 0 6px;')}
      </tr>
    </table>

    <p style="margin: 0 0 8px 0; color: ${NEUTRAL.textBody}; font-size: 14px;">
      ${escapeHtml(slots.closing_line)}
    </p>
    ${ctaButton('View Project Details', portalUrl)}
  `;

  const html = clientEmailLayout({
    preheader: `${projectName} has reached ${thresholdPct}% of its budget`,
    body,
    portalUrl,
    accentColor,
  });

  const text = [
    `Hi ${clientName},`,
    '',
    slots.alert_paragraph,
    '',
    `Budget: ${formatValue(budgetValue, budgetType)}`,
    `Used: ${formatValue(currentUsage, budgetType)}`,
    `Remaining: ${formatValue(remaining, budgetType)}`,
    '',
    slots.closing_line,
    portalUrl,
    '',
    '---',
    name,
  ].join('\n');

  return { subject: slots.subject, html, text };
}
