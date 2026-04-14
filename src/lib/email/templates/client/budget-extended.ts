/**
 * Budget Extended email template for clients.
 * Sent when a project's budget value changes (up or down) so the client
 * has a clear record of the new plan and where things currently stand
 * under the updated budget.
 */

import { ctaButton, escapeHtml, getSiteName, brandPrimary, brandLight, NEUTRAL } from '../shared';
import { clientEmailLayout, clientAvatar } from './layout';

export interface BudgetExtendedSlots {
  subject: string;
  alert_paragraph: string;
  closing_line: string;
}

export function budgetExtendedDefaults(ctx: {
  projectName: string;
  oldBudget: number;
  oldBudgetType: 'hours' | 'amount';
  newBudget: number;
  newBudgetType: 'hours' | 'amount';
}): BudgetExtendedSlots {
  const typeChanged = ctx.oldBudgetType !== ctx.newBudgetType;
  const oldLabel = formatValue(ctx.oldBudget, ctx.oldBudgetType);
  const newLabel = formatValue(ctx.newBudget, ctx.newBudgetType);
  // "Extended" only fits a same-unit increase. Any cross-unit change or
  // decrease reads as "updated" to avoid implying a one-way increase.
  const verb = !typeChanged && ctx.newBudget > ctx.oldBudget ? 'extended' : 'updated';
  return {
    subject: `Budget update for ${ctx.projectName}`,
    alert_paragraph: `We wanted to let you know your project budget has been ${verb} from ${oldLabel} to ${newLabel}. Here's where things stand under the updated plan.`,
    closing_line: "Let us know if you have any questions about the updated plan.",
  };
}

interface BudgetExtendedParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
  accentColor?: string;
  logoUrl?: string;
  oldBudget: number;
  oldBudgetType: 'hours' | 'amount';
  newBudget: number;
  newBudgetType: 'hours' | 'amount';
  currentUsage: number;
  slots: BudgetExtendedSlots;
}

function formatValue(value: number, type: 'hours' | 'amount'): string {
  if (type === 'hours') return `${value.toFixed(1)} hrs`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

export function buildBudgetExtendedEmail(
  params: BudgetExtendedParams,
): { subject: string; html: string; text: string } {
  const { projectName, clientName, portalUrl, accentColor, logoUrl, newBudget, newBudgetType, currentUsage, slots } = params;
  const name = getSiteName();
  const remaining = Math.max(0, newBudget - currentUsage);
  const primary = brandPrimary();
  const light = brandLight();
  const safeClient = escapeHtml(clientName);
  const safeProject = escapeHtml(projectName);

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
      <tr>
        <td style="padding: 0 14px 0 0; vertical-align: middle;">
          ${clientAvatar(projectName, logoUrl, 44)}
        </td>
        <td style="vertical-align: middle;">
          <p style="margin: 0 0 2px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: ${light}; font-weight: 600;">Budget Update</p>
          <p style="margin: 0; font-size: 22px; font-weight: 700; color: ${NEUTRAL.black}; line-height: 1.3;">${safeProject}</p>
        </td>
      </tr>
    </table>

    <p style="margin: 0 0 8px 0; color: ${NEUTRAL.textBody}; font-size: 15px;">
      Hi ${safeClient},
    </p>
    <p style="margin: 0 0 24px 0; color: ${NEUTRAL.textBody}; font-size: 15px; line-height: 1.7;">
      ${escapeHtml(slots.alert_paragraph)}
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 28px 0;">
      <tr>
        ${statCard('New Budget', formatValue(newBudget, newBudgetType), primary, NEUTRAL.black, 'padding: 0 6px 0 0;')}
        ${statCard('Used', formatValue(currentUsage, newBudgetType), light, primary, 'padding: 0 3px;')}
        ${statCard('Remaining', formatValue(remaining, newBudgetType), primary, NEUTRAL.black, 'padding: 0 0 0 6px;')}
      </tr>
    </table>

    <p style="margin: 0 0 8px 0; color: ${NEUTRAL.textBody}; font-size: 14px;">
      ${escapeHtml(slots.closing_line)}
    </p>
    ${ctaButton('View Project Details', portalUrl)}
  `;

  const html = clientEmailLayout({
    preheader: `Budget update for ${projectName}`,
    body,
    portalUrl,
    accentColor,
  });

  const text = [
    `Hi ${clientName},`,
    '',
    slots.alert_paragraph,
    '',
    `New Budget: ${formatValue(newBudget, newBudgetType)}`,
    `Used: ${formatValue(currentUsage, newBudgetType)}`,
    `Remaining: ${formatValue(remaining, newBudgetType)}`,
    '',
    slots.closing_line,
    portalUrl,
    '',
    '---',
    name,
  ].join('\n');

  return { subject: slots.subject, html, text };
}
