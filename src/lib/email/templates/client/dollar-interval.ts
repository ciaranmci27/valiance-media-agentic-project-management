/**
 * Dollar Interval alert email template.
 * Sent (automatically or via approval) whenever cumulative tracked work
 * crosses the next multiple of the configured dollar interval on an hourly project.
 */

import { ctaButton, escapeHtml, getSiteName, brandPrimary, brandLight, NEUTRAL } from '../shared';
import { clientEmailLayout, clientAvatar } from './layout';

export interface DollarIntervalSlots {
  subject: string;
  alert_paragraph: string;
  closing_line: string;
}

export function dollarIntervalDefaults(ctx: {
  projectName: string;
  milestone: number;
}): DollarIntervalSlots {
  const label = fmtCurrency(ctx.milestone);
  return {
    subject: `${ctx.projectName}: ${label} of tracked work`,
    alert_paragraph: `Quick update on ${ctx.projectName}: tracked work on your project has reached ${label}. Here's a snapshot of where things stand.`,
    closing_line: 'You can always review the detailed breakdown in your project portal.',
  };
}

interface DollarIntervalParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
  accentColor?: string;
  logoUrl?: string;
  milestone: number;
  totalAccrued: number;
  hourlyRate: number;
  totalHours: number;
  slots: DollarIntervalSlots;
}

function fmtCurrency(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function statCard(label: string, value: string, accent: string, valueColor: string, padStyle: string): string {
  return `
    <td width="50%" style="${padStyle} vertical-align: top;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius: 10px; overflow: hidden; border: 1px solid ${NEUTRAL.border};">
        <tr><td style="background-color: ${accent}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
        <tr>
          <td style="padding: 20px 16px; text-align: center; background-color: ${NEUTRAL.white};">
            <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: ${NEUTRAL.textMuted}; font-weight: 600;">${label}</p>
            <p style="margin: 0; font-size: 24px; font-weight: 800; color: ${valueColor};">${value}</p>
          </td>
        </tr>
      </table>
    </td>
  `;
}

export function buildDollarIntervalEmail(
  params: DollarIntervalParams,
): { subject: string; html: string; text: string } {
  const { projectName, clientName, portalUrl, accentColor, logoUrl, milestone, totalAccrued, totalHours, slots } = params;
  const name = getSiteName();
  const primary = brandPrimary();
  const light = brandLight();
  const safeClient = escapeHtml(clientName);
  const safeProject = escapeHtml(projectName);
  const hoursLabel = `${totalHours.toFixed(1)} hrs`;

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
      <tr>
        <td style="padding: 0 14px 0 0; vertical-align: middle;">
          ${clientAvatar(projectName, logoUrl, 44)}
        </td>
        <td style="vertical-align: middle;">
          <p style="margin: 0 0 2px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: ${light}; font-weight: 600;">Milestone Reached</p>
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
        ${statCard('Milestone', fmtCurrency(milestone), primary, primary, 'padding: 0 8px 0 0;')}
        ${statCard('Hours tracked', hoursLabel, light, NEUTRAL.black, 'padding: 0 0 0 8px;')}
      </tr>
    </table>

    <p style="margin: 0 0 8px 0; color: ${NEUTRAL.textBody}; font-size: 14px;">
      ${escapeHtml(slots.closing_line)}
    </p>
    ${ctaButton('View Project Details', portalUrl)}
  `;

  const html = clientEmailLayout({
    preheader: `${projectName}: ${fmtCurrency(milestone)} of tracked work`,
    body,
    portalUrl,
    accentColor,
  });

  const text = [
    `Hi ${clientName},`,
    '',
    slots.alert_paragraph,
    '',
    `Milestone reached: ${fmtCurrency(milestone)}`,
    `Hours tracked: ${hoursLabel}`,
    `Total accrued: ${fmtCurrency(totalAccrued)}`,
    '',
    slots.closing_line,
    portalUrl,
    '',
    '---',
    name,
  ].join('\n');

  return { subject: slots.subject, html, text };
}
