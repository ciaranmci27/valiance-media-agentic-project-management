/**
 * Budget Extended email template for clients.
 * Sent when a project's budget value changes (up or down) so the client
 * has a clear record of the new plan and where things currently stand
 * under the updated budget.
 */

import { ctaButton, escapeHtml, getSiteName, kvRows, linkLine, paragraph, statGrid } from '../shared';
import { clientEmailLayout, clientHeader, greeting, usageMeter } from './layout';

export interface BudgetExtendedSlots {
  subject: string;
  alert_paragraph: string;
  closing_line: string;
}

/**
 * "Extended" only fits a same-unit increase. Any cross-unit change or
 * decrease reads as "updated" to avoid implying a one-way increase.
 */
function changeVerb(ctx: {
  oldBudget: number;
  oldBudgetType: 'hours' | 'amount';
  newBudget: number;
  newBudgetType: 'hours' | 'amount';
}): 'extended' | 'updated' {
  const typeChanged = ctx.oldBudgetType !== ctx.newBudgetType;
  return !typeChanged && ctx.newBudget > ctx.oldBudget ? 'extended' : 'updated';
}

export function budgetExtendedDefaults(ctx: {
  projectName: string;
  oldBudget: number;
  oldBudgetType: 'hours' | 'amount';
  newBudget: number;
  newBudgetType: 'hours' | 'amount';
}): BudgetExtendedSlots {
  const oldLabel = formatValue(ctx.oldBudget, ctx.oldBudgetType);
  const newLabel = formatValue(ctx.newBudget, ctx.newBudgetType);
  const verb = changeVerb(ctx);
  return {
    subject: `Budget update for ${ctx.projectName}`,
    alert_paragraph: `Your project budget has been ${verb} from ${oldLabel} to ${newLabel}. Here is where things stand under the updated plan.`,
    closing_line: 'Let us know if you have any questions about the updated plan.',
  };
}

interface BudgetExtendedParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
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

export function buildBudgetExtendedEmail(
  params: BudgetExtendedParams,
): { subject: string; html: string; text: string } {
  const {
    projectName, clientName, portalUrl, logoUrl,
    oldBudget, oldBudgetType, newBudget, newBudgetType, currentUsage, slots,
  } = params;
  const name = getSiteName();
  const remaining = Math.max(0, newBudget - currentUsage);
  const usedPct = newBudget > 0 ? Math.round((currentUsage / newBudget) * 100) : 0;
  const attention = usedPct >= 90;
  const verb = changeVerb({ oldBudget, oldBudgetType, newBudget, newBudgetType });
  const oldLabel = formatValue(oldBudget, oldBudgetType);
  const newLabel = formatValue(newBudget, newBudgetType);

  const body = `
    ${clientHeader({
      projectName,
      logoUrl,
      title: 'Your budget was',
      tail: `${verb}.`,
      meta: [projectName, 'Budget update', `${oldLabel} to ${newLabel}`],
    })}
    ${greeting(clientName)}
    ${paragraph(escapeHtml(slots.alert_paragraph))}
    ${kvRows([
      { label: 'Previous budget', value: oldLabel },
      { label: 'New budget', value: newLabel, strong: true },
    ])}
    ${usageMeter({
      percent: usedPct,
      left: `${usedPct}% of the new budget used`,
      right: `${formatValue(remaining, newBudgetType)} remaining`,
    })}
    ${statGrid([
      { label: 'Used', value: formatValue(currentUsage, newBudgetType), tone: attention ? 'copper' : 'teal' },
      { label: 'Remaining', value: formatValue(remaining, newBudgetType) },
    ])}
    ${paragraph(escapeHtml(slots.closing_line))}
    ${ctaButton('View project details', portalUrl)}
    ${linkLine(portalUrl)}
  `;

  const html = clientEmailLayout({
    preheader: `Budget update for ${projectName}`,
    body,
    portalUrl,
  });

  const text = [
    `Hi ${clientName},`,
    '',
    slots.alert_paragraph,
    '',
    `Previous budget: ${oldLabel}`,
    `New budget: ${newLabel}`,
    `Used: ${formatValue(currentUsage, newBudgetType)} (${usedPct}%)`,
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
