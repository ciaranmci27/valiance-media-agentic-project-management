import type { Project, ProjectInvoice, TimeEntry } from '@/lib/types';
import { ensureLineItems, totalBillableAmount } from '@/lib/invoice-utils';
import { invoiceAmountPaid } from '@/lib/invoice-payments';
import { getWorkedHours, isClientBillable } from '@/lib/time-entry-utils';

/**
 * A project's billing totals: what the Billing tab's tiles show and what the
 * Overview quotes, computed in one place so the two never disagree.
 *
 * Outstanding keeps the hourly vs non-hourly rule: an hourly project owes its
 * accrued billable time (invoiced or not) minus what was paid; any other
 * project owes what was invoiced minus what was paid.
 */
export function computeInvoiceSummary(
  project: Project | undefined,
  invoices: ProjectInvoice[],
  timeEntries: TimeEntry[],
) {
  const isHourly = project?.client_time_billing
    ? project.client_time_billing === 'hourly'
    : (project?.hourly_tracking ?? false);
  const hourlyRate = project?.hourly_rate ?? 0;
  const finalizedHourEntries = isHourly
    ? timeEntries
        .filter(isClientBillable)
        .map((te) => ({
          id: te.id,
          start_time: te.start_time,
          end_time: te.end_time,
          hours: getWorkedHours(te),
          hourly_rate: te.hourly_rate,
          description: te.description,
        }))
    : [];
  const totalHours = finalizedHourEntries.reduce((sum, entry) => sum + entry.hours, 0);
  const accruedHourlyTotal = totalBillableAmount(finalizedHourEntries, hourlyRate);
  const hasBudget = project?.budget_type != null && project?.budget_value != null;
  const budgetType = project?.budget_type ?? null;
  const budgetValue = project?.budget_value ?? 0;

  const activeInvoices = invoices.filter((inv) => inv.status !== 'cancelled');
  const totalInvoiced = activeInvoices.reduce((sum, inv) => sum + inv.amount, 0);
  // Part payments count their share of the amount; a paid invoice counts in full.
  const taxRate = project?.tax_rate ?? null;
  const totalPaid = activeInvoices.reduce((sum, inv) => sum + invoiceAmountPaid(inv, taxRate), 0);
  let hourlyInvoiced = 0;
  let serviceInvoiced = 0;
  let reimbursementInvoiced = 0;
  for (const inv of activeInvoices) {
    for (const li of ensureLineItems(inv)) {
      if (li.item_type === 'hourly') hourlyInvoiced += Number(li.amount) || 0;
      else if (li.item_type === 'reimbursement') reimbursementInvoiced += Number(li.amount) || 0;
      else serviceInvoiced += Number(li.amount) || 0;
    }
  }
  const serviceLineTotal = hourlyInvoiced + serviceInvoiced;
  // Billable = service work plus reimbursable charges the client still owes.
  const billableTotal =
    Math.max(accruedHourlyTotal, hourlyInvoiced) + serviceInvoiced + reimbursementInvoiced;
  const outstanding = isHourly
    ? Math.max(0, billableTotal - totalPaid)
    : Math.max(0, totalInvoiced - totalPaid);

  let budgetUsed = 0;
  if (hasBudget) {
    budgetUsed = budgetType === 'hours' ? totalHours : isHourly ? accruedHourlyTotal : serviceLineTotal;
  }
  const budgetPct =
    hasBudget && budgetValue > 0 ? Math.min(100, (budgetUsed / budgetValue) * 100) : 0;

  return {
    isHourly,
    hourlyRate,
    finalizedHourEntries,
    totalHours,
    accruedHourlyTotal,
    hasBudget,
    budgetType,
    budgetValue,
    activeInvoices,
    totalInvoiced,
    taxRate,
    totalPaid,
    billableTotal,
    outstanding,
    budgetUsed,
    budgetPct,
  };
}
