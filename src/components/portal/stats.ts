import type { PortalData } from '@/lib/types';

/**
 * The billing picture, computed the way the portal has always computed it.
 *
 * It is deliberately not reduced to a single headline figure: on an hourly
 * project the balance can include tracked work that has not been invoiced
 * yet, so the card shows what has been invoiced and what has been paid
 * beside it and says when the difference is un-invoiced work.
 */
export function summariseInvoices(invoices: PortalData['invoices'], billing: PortalData['billing']) {
  const active = invoices.filter(i => i.status !== 'draft' && i.status !== 'cancelled');
  const invoiced = active.reduce((s, i) => s + i.amount, 0);
  const paid = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + i.amount, 0);

  // Break down by line-item type so mixed invoices are counted correctly.
  // Falls back to flat invoice_type when line_items is empty (legacy rows).
  let hourlyInvoiced = 0;
  let nonHourlyOwed = 0;
  for (const inv of active) {
    const items = Array.isArray(inv.line_items) && inv.line_items.length > 0
      ? inv.line_items
      : [{ item_type: inv.invoice_type, amount: inv.amount }];
    for (const li of items) {
      if (li.item_type === 'hourly') hourlyInvoiced += Number(li.amount) || 0;
      else nonHourlyOwed += Number(li.amount) || 0;
    }
  }

  // Billable = hourly work plus service and reimbursement lines owed.
  const billable = billing
    ? Math.max(billing.billable_total, hourlyInvoiced) + nonHourlyOwed
    : invoiced;
  const balanceDue = billing
    ? Math.max(0, billable - paid)
    : Math.max(0, invoiced - paid);

  // Tracked work that is owed but has not appeared on an invoice yet.
  const uninvoiced = Math.max(0, billable - invoiced);

  return { billable, invoiced, paid, balanceDue, uninvoiced };
}
