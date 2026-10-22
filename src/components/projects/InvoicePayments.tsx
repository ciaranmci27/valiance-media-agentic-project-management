'use client';

import { useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { INVOICE_PAYMENT_METHODS, type InvoicePayment, type InvoicePaymentMethod, type ProjectInvoice } from '@/lib/types';
import { invoiceOutstanding, invoicePaidTotal, invoiceTotal } from '@/lib/invoice-payments';

const METHOD_LABELS: Record<InvoicePaymentMethod, string> = {
  ach: 'ACH',
  wire: 'Wire',
  check: 'Check',
  card: 'Card',
  cash: 'Cash',
  other: 'Other',
};

export function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDay(day: string): string {
  return new Date(`${day.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function recordedBy(payment: InvoicePayment, keyNames: Map<string, string | null>): string {
  if (payment.recorded_via === 'app') return 'Recorded by hand';
  const name = keyNames.get(payment.id);
  return name ? `Recorded by ${name}` : 'Recorded by an API key';
}

interface InvoicePaymentsProps {
  invoice: ProjectInvoice;
  taxRate: number | null | undefined;
  /** Names of the keys that recorded API payments, by payment id. */
  keyNames: Map<string, string | null>;
  canRecord: boolean;
  today: string;
  onRecord: (payment: { amount: number; paid_date: string; method: InvoicePaymentMethod | null; reference: string | null }) => Promise<boolean>;
  onRemove: (paymentId: string) => Promise<boolean>;
}

/** The payments on one invoice, with Record payment and removal of hand-recorded ones. */
export function InvoicePayments({ invoice, taxRate, keyNames, canRecord, today, onRecord, onRemove }: InvoicePaymentsProps) {
  const payments = invoice.payments ?? [];
  const total = invoiceTotal(invoice, taxRate);
  const paid = invoicePaidTotal(invoice);
  const outstanding = invoiceOutstanding(invoice, taxRate);
  // Paid is settled: payments are recorded against a sent or overdue invoice.
  const canTakePayment = canRecord && (invoice.status === 'sent' || invoice.status === 'overdue') && outstanding > 0;
  const [recording, setRecording] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  if (payments.length === 0 && !canTakePayment) return null;

  const remove = async (paymentId: string) => {
    setRemovingId(paymentId);
    await onRemove(paymentId);
    setRemovingId(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          Payments
          {total !== invoice.amount && (
            <span className="normal-case tracking-normal text-zinc-400"> (total with tax ${formatMoney(total)})</span>
          )}
        </p>
        {canTakePayment && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<Plus size={12} aria-hidden="true" />}
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              setRecording(true);
            }}
          >
            Record payment
          </Button>
        )}
      </div>
      {payments.length === 0 ? (
        <p className="text-xs text-zinc-400">No payments recorded yet.</p>
      ) : (
        <ul className="space-y-1.5" aria-label={`Payments on invoice ${invoice.invoice_number}`}>
          {payments.map((payment) => (
            <li
              key={payment.id}
              className="flex items-center justify-between gap-3 text-xs bg-surface-raised border border-white/[0.06] rounded-md px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-zinc-200">
                  <span className="font-semibold text-white">${formatMoney(payment.amount)}</span>
                  {' on '}
                  {fmtDay(payment.paid_date)}
                  {payment.method ? ` by ${METHOD_LABELS[payment.method]}` : ''}
                </p>
                <p className="text-[11px] text-zinc-400 truncate">
                  {recordedBy(payment, keyNames)}
                  {payment.reference ? `, ref ${payment.reference}` : ''}
                </p>
              </div>
              {canRecord && payment.recorded_via === 'app' && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void remove(payment.id);
                  }}
                  disabled={removingId === payment.id}
                  aria-label={`Remove the $${formatMoney(payment.amount)} payment on ${fmtDay(payment.paid_date)}`}
                  className="p-1.5 text-zinc-400 hover:text-red-400 transition-colors rounded-md hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300 disabled:opacity-50"
                >
                  {removingId === payment.id
                    ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                    : <Trash2 size={13} aria-hidden="true" />}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {payments.length > 0 && outstanding > 0 && (
        <p className="mt-1.5 text-[11px] text-zinc-400">
          ${formatMoney(paid)} paid, ${formatMoney(outstanding)} outstanding
        </p>
      )}
      {recording && (
        <RecordPaymentModal
          invoiceNumber={invoice.invoice_number}
          outstanding={outstanding}
          today={today}
          onClose={() => setRecording(false)}
          onSubmit={async (payment) => {
            const ok = await onRecord(payment);
            if (ok) setRecording(false);
            return ok;
          }}
        />
      )}
    </div>
  );
}

interface RecordPaymentModalProps {
  invoiceNumber: string;
  outstanding: number;
  today: string;
  onClose: () => void;
  onSubmit: (payment: { amount: number; paid_date: string; method: InvoicePaymentMethod | null; reference: string | null }) => Promise<boolean>;
}

function RecordPaymentModal({ invoiceNumber, outstanding, today, onClose, onSubmit }: RecordPaymentModalProps) {
  const [amount, setAmount] = useState<number | ''>(outstanding);
  const [paidDate, setPaidDate] = useState(today);
  const [method, setMethod] = useState<InvoicePaymentMethod | ''>('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  const amountError = amount === ''
    ? undefined
    : amount <= 0
      ? 'Enter more than $0'
      : Math.round(amount * 100) > Math.round(outstanding * 100)
        ? `At most the $${formatMoney(outstanding)} outstanding`
        : undefined;
  const canSave = amount !== '' && !amountError && Boolean(paidDate) && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    await onSubmit({
      amount: Math.round(amount * 100) / 100,
      paid_date: paidDate,
      method: method || null,
      reference: reference.trim() || null,
    });
    setSaving(false);
  };

  return (
    <Modal isOpen onClose={onClose} title={`Record payment on ${invoiceNumber}`} size="sm">
      <form
        className="space-y-3"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <NumberInput
          label="Amount"
          value={amount}
          onChange={setAmount}
          min={0.01}
          max={outstanding}
          step={0.01}
          precision={2}
          prefix="$"
          error={amountError}
          description={`Outstanding: $${formatMoney(outstanding)}`}
          required
          autoFocus
        />
        <DateInput label="Paid on" value={paidDate} onChange={setPaidDate} maxDate={today} required />
        <Select
          label="Method"
          value={method}
          onChange={(value) => setMethod(value as InvoicePaymentMethod | '')}
          options={[
            { value: '', label: 'Not recorded' },
            ...INVOICE_PAYMENT_METHODS.map((value) => ({ value, label: METHOD_LABELS[value] })),
          ]}
        />
        <TextInput
          label="Reference"
          value={reference}
          onChange={(value) => setReference(value)}
          placeholder="Check number or bank reference"
          maxLength={200}
        />
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSave} icon={saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined}>
            Record payment
          </Button>
        </div>
      </form>
    </Modal>
  );
}
