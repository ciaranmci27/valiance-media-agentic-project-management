'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown } from 'lucide-react';
import type { PortalData } from '@/lib/types';
import { SectionCard, SectionCount, SectionHeader } from './SectionHeader';
import { formatDay, formatMoney } from './format';
import { summariseInvoices } from './stats';

const INVOICES_INITIAL = 6;

/** Teal once it is settled, copper while it is waiting, error once it is late; drafts stay neutral. */
const STATUS_CHIP: Record<string, string> = {
  paid: 'vm-chip-teal',
  sent: 'vm-chip-copper',
  due: 'vm-chip-copper',
  overdue: 'vm-chip-error',
};

type Invoice = PortalData['invoices'][number];

function Sep() {
  return <span className="opacity-50" aria-hidden="true"> / </span>;
}

/**
 * One invoice: number and status, its dates on one line, the amount, a
 * chevron. A 12-column grid from `sm`; on a phone the dates drop under the
 * number and the amount stays on the first line.
 */
function InvoiceRow({ invoice, onOpen }: { invoice: Invoice; onOpen: (invoiceNumber: string) => void }) {
  const chip = STATUS_CHIP[invoice.status] ?? '';
  const statusLabel = invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1);
  const amount = invoice.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <li className="vm-row flex items-center gap-1 py-1 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={() => onOpen(invoice.invoice_number)}
        aria-label={`Preview invoice ${invoice.invoice_number}, ${statusLabel}, $${amount}`}
        className="-mx-3 grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1.5 rounded-xl px-3 py-4 text-left transition-colors hover:bg-white/[0.03] sm:grid-cols-12"
      >
        <span className="flex min-w-0 items-center gap-3 sm:col-span-4">
          <span className="vm-mono truncate text-[15px]">{invoice.invoice_number}</span>
          <span className={`vm-chip ${chip}`}>{statusLabel}</span>
        </span>
        <span className="vm-faint order-last col-span-3 text-[13px] sm:order-none sm:col-span-4">
          {invoice.paid_date ? (
            <span>Paid {formatDay(invoice.paid_date)}</span>
          ) : (
            <>
              <span>Issued {formatDay(invoice.date)}</span>
              {invoice.due_date && (
                <>
                  <Sep />
                  <span>Due {formatDay(invoice.due_date)}</span>
                </>
              )}
            </>
          )}
        </span>
        <span className="vm-mono text-right text-[17px] sm:col-span-3">${amount}</span>
        <ChevronRight size={16} className="vm-faint justify-self-end sm:col-span-1" aria-hidden="true" />
      </button>
      {invoice.file_url && (
        <a
          href={invoice.file_url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Download ${invoice.file_name || `attachment for ${invoice.invoice_number}`}`}
          className="vm-icon-btn shrink-0"
        >
          <FileDown size={16} aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

/**
 * What is owed, and what that figure is made of. This is the only place in
 * the portal that states a balance, because it is the only place that can
 * qualify it: on an hourly project part of the balance may be tracked work
 * that has not been invoiced yet, and the list underneath is the evidence.
 */
function BalanceSummary({
  invoices,
  billing,
}: {
  invoices: PortalData['invoices'];
  billing: PortalData['billing'];
}) {
  const { balanceDue, uninvoiced } = summariseInvoices(invoices, billing);
  const open = invoices.filter(i => i.status !== 'paid' && i.status !== 'draft' && i.status !== 'cancelled').length;

  let note = '';
  if (uninvoiced > 0 && open > 0) {
    note = `Across ${open} open ${open === 1 ? 'invoice' : 'invoices'}, plus $${formatMoney(uninvoiced)} of tracked work not yet invoiced.`;
  } else if (uninvoiced > 0) {
    note = `Tracked work not yet invoiced. You will get an invoice before anything is due.`;
  } else if (open > 0) {
    note = `Across ${open} open ${open === 1 ? 'invoice' : 'invoices'}.`;
  } else {
    note = 'Nothing outstanding.';
  }

  return (
    <div className="vm-tile mb-7 px-5 py-5 sm:px-6">
      <p className="vm-label">Balance due</p>
      <p className={`vm-stat mt-2.5 ${balanceDue > 0 ? 'text-(--vm-copper-300)' : ''}`}>${formatMoney(balanceDue)}</p>
      <p className="vm-faint mt-2.5 max-w-[46ch] text-[13px] leading-relaxed">{note}</p>
    </div>
  );
}

export function InvoicesSection({
  invoices,
  billing,
  onOpen,
}: {
  invoices: PortalData['invoices'];
  billing: PortalData['billing'];
  onOpen: (invoiceNumber: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  // Newest first.
  const sorted = useMemo(
    () => [...invoices].sort((a, b) => b.date.localeCompare(a.date) || b.invoice_number.localeCompare(a.invoice_number)),
    [invoices],
  );
  const visible = showAll ? sorted : sorted.slice(0, INVOICES_INITIAL);

  return (
    <SectionCard sectionKey="show_invoices">
      <SectionHeader title="Invoices" right={<SectionCount>{invoices.length}</SectionCount>} />

      <BalanceSummary invoices={invoices} billing={billing} />

      {sorted.length === 0 && (
        <p className="vm-muted text-[15px]">No invoices yet.</p>
      )}

      <ul>
        {visible.map((invoice) => (
          <InvoiceRow key={invoice.id} invoice={invoice} onOpen={onOpen} />
        ))}
      </ul>

      {sorted.length > INVOICES_INITIAL && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
          className="vm-btn vm-btn-ghost vm-btn-sm mt-6 w-full sm:w-auto"
        >
          <ChevronDown size={15} aria-hidden="true" className={`transition-transform ${showAll ? 'rotate-180' : ''}`} />
          {showAll ? 'Show fewer' : `Show all ${sorted.length}`}
        </button>
      )}
    </SectionCard>
  );
}
