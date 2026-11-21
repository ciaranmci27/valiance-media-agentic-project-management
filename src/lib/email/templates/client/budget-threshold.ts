/**
 * Budget threshold alert email template for clients.
 * Sent automatically (or via approval) when tracked work crosses a configured percentage.
 */

import type { Brand } from '@/lib/brand';
import { ctaButton, escapeHtml, getSiteName, linkLine, paragraph, statGrid, withEmailBrand } from '../shared';
import { formatMoneyExact } from '@/lib/format';
import { clientEmailLayout, clientHeader, formatEmailHours, greeting, usageMeter, type EmailRegion } from './layout';

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
  const label = ctx.budgetType === 'hours' ? 'hours budget' : 'budget';
  return {
    subject: `${ctx.projectName} has reached ${ctx.thresholdPct}% of its budget`,
    alert_paragraph: `A heads up: your project has reached ${ctx.thresholdPct}% of its ${label}. Here is where things stand.`,
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
  /** The workspace region: a project budget is in the workspace currency. */
  region: EmailRegion;
}

function formatValue(value: number, type: 'hours' | 'amount', region: EmailRegion): string {
  if (type === 'hours') {
    return formatEmailHours(value, region.locale);
  }
  return formatMoneyExact(value, region);
}

/** Renders with the workspace's brand (getBrand), so the name, logo and colors are this workspace's. */
export function buildBudgetThresholdEmail(params: BudgetThresholdParams & { brand: Brand }): { subject: string; html: string; text: string } {
  return withEmailBrand(params.brand, () => renderBudgetThresholdEmail(params));
}

function renderBudgetThresholdEmail(params: BudgetThresholdParams): { subject: string; html: string; text: string } {
  const { projectName, clientName, portalUrl, logoUrl, budgetType, budgetValue, currentUsage, thresholdPct, slots, region } = params;
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
      meta: [projectName, 'Budget alert', `${formatValue(budgetValue, budgetType, region)} budget`],
    })}
    ${greeting(clientName)}
    ${paragraph(escapeHtml(slots.alert_paragraph))}
    ${usageMeter({
      percent: usedPct,
      left: `${usedPct}% used`,
      right: `${formatValue(remaining, budgetType, region)} remaining`,
    })}
    ${statGrid([
      { label: 'Budget', value: formatValue(budgetValue, budgetType, region) },
      { label: 'Used', value: formatValue(currentUsage, budgetType, region), tone: attention ? 'copper' : 'teal' },
      { label: 'Remaining', value: formatValue(remaining, budgetType, region) },
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
    `Budget: ${formatValue(budgetValue, budgetType, region)}`,
    `Used: ${formatValue(currentUsage, budgetType, region)} (${usedPct}%)`,
    `Remaining: ${formatValue(remaining, budgetType, region)}`,
    '',
    slots.closing_line,
    portalUrl,
    '',
    '---',
    name,
  ].join('\n');

  return { subject: slots.subject, html, text };
}
