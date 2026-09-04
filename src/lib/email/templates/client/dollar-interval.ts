/**
 * Dollar Interval alert email template.
 * Sent (automatically or via approval) whenever cumulative tracked work
 * crosses the next multiple of the configured dollar interval on an hourly project.
 */

import { ctaButton, escapeHtml, getSiteName, linkLine, paragraph, statGrid } from '../shared';
import { clientEmailLayout, clientHeader, greeting } from './layout';

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
    alert_paragraph: `A quick update on ${ctx.projectName}: tracked work on your project has reached ${label}. Here is where things stand.`,
    closing_line: 'The detailed breakdown is always in your project portal.',
  };
}

interface DollarIntervalParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
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

export function buildDollarIntervalEmail(
  params: DollarIntervalParams,
): { subject: string; html: string; text: string } {
  const { projectName, clientName, portalUrl, logoUrl, milestone, totalAccrued, totalHours, slots } = params;
  const name = getSiteName();
  const hoursLabel = `${totalHours.toFixed(1)} hrs`;

  const body = `
    ${clientHeader({
      projectName,
      logoUrl,
      title: `${fmtCurrency(milestone)} of tracked`,
      tail: 'work.',
      meta: [projectName, 'Milestone', `${hoursLabel} tracked`],
    })}
    ${greeting(clientName)}
    ${paragraph(escapeHtml(slots.alert_paragraph))}
    ${statGrid([
      { label: 'Milestone', value: fmtCurrency(milestone), tone: 'teal' },
      { label: 'Hours tracked', value: hoursLabel },
      { label: 'Total to date', value: fmtCurrency(totalAccrued) },
    ])}
    ${paragraph(escapeHtml(slots.closing_line))}
    ${ctaButton('View project details', portalUrl)}
    ${linkLine(portalUrl)}
  `;

  const html = clientEmailLayout({
    preheader: `${projectName}: ${fmtCurrency(milestone)} of tracked work`,
    body,
    portalUrl,
  });

  const text = [
    `Hi ${clientName},`,
    '',
    slots.alert_paragraph,
    '',
    `Milestone reached: ${fmtCurrency(milestone)}`,
    `Hours tracked: ${hoursLabel}`,
    `Total to date: ${fmtCurrency(totalAccrued)}`,
    '',
    slots.closing_line,
    portalUrl,
    '',
    '---',
    name,
  ].join('\n');

  return { subject: slots.subject, html, text };
}
