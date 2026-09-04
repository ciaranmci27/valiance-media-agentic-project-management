/**
 * Budget threshold alert email template for clients.
 * Sent automatically (or via approval) when tracked work crosses a configured percentage.
 */

import { ctaButton, escapeHtml, getSiteName, linkLine, paragraph, statGrid } from '../shared';
import { clientEmailLayout, clientHeader, greeting, usageMeter } from './layout';

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
    alert_paragraph: `A heads up: your project has reached ${ctx.thresholdPct}% of its ${label} budget. Here is where things stand.`,
    closing_line: 'The full breakdown is in your project portal.',
  };
}

interface BudgetThresholdParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
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

export function buildBudgetThresholdEmail(
  params: BudgetThresholdParams,
): { subject: string; html: string; text: string } {
  const { projectName, clientName, portalUrl, logoUrl, budgetType, budgetValue, currentUsage, thresholdPct, slots } = params;
  const name = getSiteName();
  const remaining = Math.max(0, budgetValue - currentUsage);
  // The bar shows real usage, which can sit a little past the threshold that
  // fired this email. The heading keeps the threshold the client was told about.
  const usedPct = budgetValue > 0 ? Math.round((currentUsage / budgetValue) * 100) : thresholdPct;
  const attention = usedPct >= 90;

  const body = `
    ${clientHeader({
      projectName,
      logoUrl,
      title: `${thresholdPct}% of the budget is`,
      tail: 'used.',
      meta: [projectName, 'Budget alert', `${formatValue(budgetValue, budgetType)} budget`],
    })}
    ${greeting(clientName)}
    ${paragraph(escapeHtml(slots.alert_paragraph))}
    ${usageMeter({
      percent: usedPct,
      left: `${usedPct}% used`,
      right: `${formatValue(remaining, budgetType)} remaining`,
    })}
    ${statGrid([
      { label: 'Budget', value: formatValue(budgetValue, budgetType) },
      { label: 'Used', value: formatValue(currentUsage, budgetType), tone: attention ? 'copper' : 'teal' },
      { label: 'Remaining', value: formatValue(remaining, budgetType) },
    ])}
    ${paragraph(escapeHtml(slots.closing_line))}
    ${ctaButton('View project details', portalUrl)}
    ${linkLine(portalUrl)}
  `;

  const html = clientEmailLayout({
    preheader: `${projectName} has reached ${thresholdPct}% of its budget`,
    body,
    portalUrl,
  });

  const text = [
    `Hi ${clientName},`,
    '',
    slots.alert_paragraph,
    '',
    `Budget: ${formatValue(budgetValue, budgetType)}`,
    `Used: ${formatValue(currentUsage, budgetType)} (${usedPct}%)`,
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
