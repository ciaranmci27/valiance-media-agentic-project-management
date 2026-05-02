'use client';

import { useState, useRef, useEffect } from 'react';
import {
  Receipt, Plus, Edit2, Trash2, FileDown, X, Upload, File,
  Loader2, ChevronDown, Copy, Clock,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useDemo } from '@/lib/demo-context';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import {
  INVOICE_STATUSES, INVOICE_TYPES, RECURRENCE_FREQUENCIES,
  type InvoiceStatus, type InvoiceType, type InvoiceLineItem, type RecurrenceFrequency,
} from '@/lib/types';
import { getWorkedHours } from '@/lib/time-entry-utils';
import {
  ensureLineItems, lineItemsTotal, dominantInvoiceType, newLineItemId, suggestServiceEnd,
  paidHourlyLineItemTotal, buildUnpaidHoursLineItem,
} from '@/lib/invoice-utils';

interface InvoicesPanelProps {
  projectId: string;
  projectColor?: string;
}

const statusColors: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600',
  sent: 'bg-blue-50 text-blue-700',
  paid: 'bg-emerald-50 text-emerald-700',
  overdue: 'bg-red-50 text-red-700',
  cancelled: 'bg-zinc-100 text-zinc-400',
};

function formatCurrency(value: number): string {
  return value % 1 === 0 ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format YYYY-MM-DD to "Mon D" or "Mon D, YYYY" if year differs from current */
function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  const month = date.toLocaleString('en-US', { month: 'short' });
  return y !== now.getFullYear() ? `${month} ${d}, ${y}` : `${month} ${d}`;
}

/** Render a service period: "Apr 1 - Apr 30" or "Apr 1, 2026" if a single date. */
function fmtServicePeriod(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  if (start && end && start !== end) return `${fmtDate(start)} \u2013 ${fmtDate(end)}`;
  return fmtDate(start ?? end!);
}

function makeLineItem(defaultType: InvoiceType, position = 0): InvoiceLineItem {
  return {
    id: newLineItemId(),
    position,
    item_type: defaultType,
    amount: 0,
    description: '',
    service_start_date: null,
    service_end_date: null,
    recurrence_frequency: defaultType === 'recurring' ? 'monthly' : null,
  };
}

export default function InvoicesPanel({ projectId, projectColor }: InvoicesPanelProps) {
  const {
    addInvoice, updateInvoice, deleteInvoice, getInvoicesByProject,
    getProject, updateProject, getTimeEntriesByProject,
  } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const invoices = getInvoicesByProject(projectId);
  const project = getProject(projectId);

  // UI state
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Form state
  const [formNumber, setFormNumber] = useState('');
  const [formDate, setFormDate] = useState('');
  const [formDueDate, setFormDueDate] = useState('');
  const [formPaidDate, setFormPaidDate] = useState('');
  const [formStatus, setFormStatus] = useState<InvoiceStatus>('draft');
  const [formDescription, setFormDescription] = useState('');
  const [formLineItems, setFormLineItems] = useState<InvoiceLineItem[]>([]);
  // Per-line-item raw string drafts for the amount input so users can type
  // intermediate values like "" / "0." / ".5" without parseFloat clobbering
  // them on every keystroke.
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});
  const [formFile, setFormFile] = useState<File | null>(null);
  const [existingFileUrl, setExistingFileUrl] = useState<string | null>(null);
  const [existingFileName, setExistingFileName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Inline editing state
  const [editingRate, setEditingRate] = useState(false);
  const [rateValue, setRateValue] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tracks recurring line items whose service dates were auto-seeded from the
  // invoice's due/issue date — used to cascade updates if those dates change
  // later. A user editing a service date removes that line item from the set.
  const autoSeededRef = useRef<Set<string>>(new Set());

  // Calculate hours from time entries
  const timeEntries = getTimeEntriesByProject(projectId);
  const totalHours = timeEntries.reduce((sum, te) => {
    if (!te.end_time) return sum; // exclude unfinalized (running / paused) timers
    return sum + getWorkedHours(te);
  }, 0);

  const isHourly = project?.hourly_tracking ?? false;
  const hourlyRate = project?.hourly_rate ?? 0;
  const hasBudget = project?.budget_type != null && project?.budget_value != null;
  const budgetType = project?.budget_type ?? null;
  const budgetValue = project?.budget_value ?? 0;

  // Aggregate totals across all active invoices' line items.
  // Outstanding preserves the hourly-vs-non-hourly formula from lessons.md.
  const activeInvoices = invoices.filter(inv => inv.status !== 'cancelled');
  const totalInvoiced = activeInvoices.reduce((sum, inv) => sum + inv.amount, 0);
  const totalPaid = invoices.filter(inv => inv.status === 'paid').reduce((sum, inv) => sum + inv.amount, 0);
  let hourlyInvoiced = 0;
  let fixedInvoiced = 0;
  for (const inv of activeInvoices) {
    for (const li of ensureLineItems(inv)) {
      if (li.item_type === 'hourly') hourlyInvoiced += Number(li.amount) || 0;
      else fixedInvoiced += Number(li.amount) || 0;
    }
  }
  // Billable = hourly work (whichever is higher: tracked or invoiced) + fixed/recurring charges
  const billableTotal = Math.max(hourlyRate * totalHours, hourlyInvoiced) + fixedInvoiced;
  const outstanding = isHourly
    ? Math.max(0, billableTotal - totalPaid)
    : Math.max(0, totalInvoiced - totalPaid);

  // Budget progress
  let budgetUsed = 0;
  if (hasBudget) {
    if (budgetType === 'hours') {
      budgetUsed = totalHours;
    } else {
      budgetUsed = isHourly ? hourlyRate * totalHours : totalInvoiced;
    }
  }
  const budgetPct = hasBudget && budgetValue > 0 ? Math.min(100, (budgetUsed / budgetValue) * 100) : 0;

  // Type options: non-hourly projects can't create hourly line items.
  const typeOptions = isHourly
    ? INVOICE_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))
    : INVOICE_TYPES.filter(t => t !== 'hourly').map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }));
  const defaultType: InvoiceType = isHourly ? 'hourly' : 'fixed';

  // Roll up unpaid hours into a draft hourly line item. Computed from finalized
  // entries vs. the FIFO pool of dollars covered by paid hourly line items, so
  // saving an invoice as `paid` automatically shrinks the next click's amount.
  // Drafts/sent invoices don't drain the pool, which matches how the rest of
  // the panel reasons about "paid hours".
  const unpaidHoursDraft = (() => {
    if (!isHourly || hourlyRate <= 0) return null;
    const paidPool = paidHourlyLineItemTotal(invoices);
    const finalized = timeEntries
      .filter(te => te.end_time !== null)
      .map(te => ({
        id: te.id,
        start_time: te.start_time,
        end_time: te.end_time,
        hours: getWorkedHours(te),
      }));
    return buildUnpaidHoursLineItem(finalized, paidPool, hourlyRate);
  })();

  const resetForm = () => {
    setFormNumber('');
    setFormDate('');
    setFormDueDate('');
    setFormPaidDate('');
    setFormStatus('draft');
    setFormDescription('');
    const initial = [makeLineItem(defaultType, 0)];
    setFormLineItems(initial);
    setAmountDrafts({ [initial[0].id]: '' });
    setFormFile(null);
    setExistingFileUrl(null);
    setExistingFileName(null);
    autoSeededRef.current.clear();
  };

  const openAddForm = () => {
    resetForm();
    setEditingId(null);
    const maxNum = invoices.reduce((max, inv) => {
      const match = inv.invoice_number.match(/(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    const nextNum = String(maxNum + 1).padStart(3, '0');
    setFormNumber(`INV-${nextNum}`);
    setFormDate(new Date().toISOString().split('T')[0]);
    setIsAdding(true);
  };

  // Line item mutators
  const addLineItem = () => {
    setFormLineItems(items => {
      const fresh = makeLineItem(defaultType, items.length);
      setAmountDrafts(d => ({ ...d, [fresh.id]: '' }));
      return [...items, fresh];
    });
  };
  // Insert (or replace) the auto-generated unpaid-hours line item. We replace
  // any prior one in the same form so clicking the button twice doesn't stack
  // duplicate rows; the user can always tweak the description afterwards.
  const addUnpaidHoursLineItem = () => {
    if (!unpaidHoursDraft) return;
    setFormLineItems(items => {
      const filtered = items.filter(li => !(li.item_type === 'hourly' && li.description === unpaidHoursDraft.description && li.amount === unpaidHoursDraft.amount));
      const fresh: InvoiceLineItem = {
        id: newLineItemId(),
        position: filtered.length,
        item_type: 'hourly',
        amount: unpaidHoursDraft.amount,
        description: unpaidHoursDraft.description,
        service_start_date: null,
        service_end_date: null,
        recurrence_frequency: null,
      };
      setAmountDrafts(d => ({ ...d, [fresh.id]: String(unpaidHoursDraft.amount) }));
      // If the form started with the default empty placeholder line, drop it.
      const trimmed = filtered.filter(li => !(li.amount === 0 && li.description === '' && li.item_type === defaultType && filtered.length === 1));
      return [...trimmed, fresh].map((li, i) => ({ ...li, position: i }));
    });
  };
  const removeLineItem = (id: string) => {
    autoSeededRef.current.delete(id);
    setAmountDrafts(d => {
      const { [id]: _drop, ...rest } = d;
      return rest;
    });
    setFormLineItems(items => {
      const next = items.filter(li => li.id !== id).map((li, i) => ({ ...li, position: i }));
      if (next.length === 0) {
        const fresh = makeLineItem(defaultType, 0);
        setAmountDrafts(d => ({ ...d, [fresh.id]: '' }));
        return [fresh];
      }
      return next;
    });
  };
  // Update both the raw draft string and the numeric amount used in totals.
  // Invalid partials (e.g. "1.") keep the last numeric amount so the chart
  // and outstanding totals don't flicker to 0 while the user is typing.
  const updateAmountDraft = (id: string, raw: string) => {
    setAmountDrafts(d => ({ ...d, [id]: raw }));
    const parsed = parseFloat(raw);
    setFormLineItems(items => items.map(li => {
      if (li.id !== id) return li;
      if (raw.trim() === '') return { ...li, amount: 0 };
      return Number.isFinite(parsed) ? { ...li, amount: parsed } : li;
    }));
  };
  const patchLineItem = (id: string, patch: Partial<InvoiceLineItem>) => {
    // A direct user edit of a service date unlinks this item from auto-seeding.
    if ('service_start_date' in patch || 'service_end_date' in patch) {
      autoSeededRef.current.delete(id);
    }
    // Leaving recurring also stops cascading updates.
    if (patch.item_type && patch.item_type !== 'recurring') {
      autoSeededRef.current.delete(id);
    }
    setFormLineItems(items => items.map(li => {
      if (li.id !== id) return li;
      const next: InvoiceLineItem = { ...li, ...patch };
      // If item_type changed away from recurring, drop the frequency.
      if (patch.item_type && patch.item_type !== 'recurring' && li.item_type === 'recurring') {
        next.recurrence_frequency = null;
      }
      // Hourly line items don't carry a service window.
      if (patch.item_type === 'hourly') {
        next.service_start_date = null;
        next.service_end_date = null;
      }
      // Flipping to recurring: default frequency to monthly and seed service_start
      // from due date (falling back to invoice date) if not already set. Register
      // the item so cascading due/invoice date edits keep it in sync.
      if (patch.item_type === 'recurring' && li.item_type !== 'recurring') {
        next.recurrence_frequency = next.recurrence_frequency ?? 'monthly';
        if (!next.service_start_date) {
          autoSeededRef.current.add(id);
          const seed = formDueDate || formDate;
          if (seed) next.service_start_date = seed;
        }
      }
      // Auto-suggest service_end when recurring + start + frequency are known and end is empty.
      if (next.item_type === 'recurring' && next.service_start_date && next.recurrence_frequency && !next.service_end_date) {
        next.service_end_date = suggestServiceEnd(next.service_start_date, next.recurrence_frequency);
      }
      return next;
    }));
  };

  // Cascade due/invoice date changes into auto-seeded recurring line items.
  useEffect(() => {
    const seed = formDueDate || formDate;
    if (!seed) return;
    if (autoSeededRef.current.size === 0) return;
    setFormLineItems(items => items.map(li => {
      if (li.item_type !== 'recurring') return li;
      if (!autoSeededRef.current.has(li.id)) return li;
      const freq = li.recurrence_frequency || 'monthly';
      return {
        ...li,
        service_start_date: seed,
        service_end_date: suggestServiceEnd(seed, freq),
      };
    }));
  }, [formDueDate, formDate]);

  const handleFileUpload = async (file: File): Promise<{ file_url: string; file_name: string; file_size: number; mime_type: string } | null> => {
    const supabase = createClient();
    const path = `invoices/${projectId}/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from('entity-files').upload(path, file);
    if (error) {
      toast('error', 'Failed to upload file');
      return null;
    }
    const { data: { publicUrl } } = supabase.storage.from('entity-files').getPublicUrl(path);
    return { file_url: publicUrl, file_name: file.name, file_size: file.size, mime_type: file.type };
  };

  const validLineItems = (items: InvoiceLineItem[]) =>
    items.filter(li => (Number(li.amount) || 0) > 0 || li.description.trim().length > 0);

  const formTotal = lineItemsTotal(formLineItems);

  const canSave = () => {
    if (!formNumber.trim()) return false;
    if (formStatus === 'paid' && !formPaidDate) return false;
    const items = validLineItems(formLineItems);
    if (items.length === 0) return false;
    for (const li of items) {
      if ((Number(li.amount) || 0) < 0) return false;
      if (li.service_start_date && li.service_end_date && li.service_start_date > li.service_end_date) return false;
    }
    return true;
  };

  const handleAdd = async () => {
    if (!canSave()) return;
    setSaving(true);

    try {
      let fileData: { file_url: string; file_name: string; file_size: number; mime_type: string } | null = null;
      if (formFile) {
        fileData = await handleFileUpload(formFile);
        if (!fileData) { setSaving(false); return; }
      }

      const items = validLineItems(formLineItems).map((li, i) => ({ ...li, position: i, amount: Number(li.amount) || 0 }));

      await addInvoice({
        project_id: projectId,
        invoice_number: formNumber.trim(),
        amount: lineItemsTotal(items),
        status: formStatus,
        invoice_type: dominantInvoiceType(items),
        line_items: items,
        date: formDate,
        due_date: formDueDate || null,
        paid_date: formStatus === 'paid' ? (formPaidDate || null) : null,
        description: formDescription.trim(),
        file_url: fileData?.file_url ?? null,
        file_name: fileData?.file_name ?? null,
        file_size: fileData?.file_size ?? null,
        mime_type: fileData?.mime_type ?? null,
        created_by: teamMemberId,
      });

      resetForm();
      setIsAdding(false);
      toast('success', 'Invoice created');
    } finally {
      setSaving(false);
    }
  };

  const startDuplicating = (invoice: typeof invoices[number]) => {
    resetForm();
    setEditingId(null);
    const maxNum = invoices.reduce((max, inv) => {
      const match = inv.invoice_number.match(/(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    const nextNum = String(maxNum + 1).padStart(3, '0');
    setFormNumber(`INV-${nextNum}`);
    setFormDate(new Date().toISOString().split('T')[0]);
    setFormDueDate('');
    setFormPaidDate('');
    setFormStatus('draft');
    setFormDescription(invoice.description || '');
    const cloned = ensureLineItems(invoice).map((li, i) => ({
      ...li,
      id: newLineItemId(),
      position: i,
    }));
    setFormLineItems(cloned);
    setAmountDrafts(Object.fromEntries(cloned.map(li => [li.id, li.amount === 0 ? '' : String(li.amount)])));
    setIsAdding(true);
  };

  const startEditing = (invoice: typeof invoices[number]) => {
    setIsAdding(false);
    setEditingId(invoice.id);
    setFormNumber(invoice.invoice_number);
    setFormDate(invoice.date);
    setFormDueDate(invoice.due_date || '');
    setFormPaidDate(invoice.paid_date || '');
    setFormStatus(invoice.status);
    setFormDescription(invoice.description || '');
    const loaded = ensureLineItems(invoice).map((li, i) => ({ ...li, position: i }));
    setFormLineItems(loaded);
    setAmountDrafts(Object.fromEntries(loaded.map(li => [li.id, li.amount === 0 ? '' : String(li.amount)])));
    setFormFile(null);
    setExistingFileUrl(invoice.file_url);
    setExistingFileName(invoice.file_name);
    // Clear stale auto-seed tracking from any prior edit — the IDs from a
    // different invoice must not leak into the cascade effect.
    autoSeededRef.current.clear();
  };

  const handleSaveEdit = async () => {
    if (!editingId || !canSave()) return;
    setSaving(true);

    try {
      let fileData: { file_url: string; file_name: string; file_size: number; mime_type: string } | null = null;
      if (formFile) {
        fileData = await handleFileUpload(formFile);
        if (!fileData) { setSaving(false); return; }
      }

      const items = validLineItems(formLineItems).map((li, i) => ({ ...li, position: i, amount: Number(li.amount) || 0 }));

      const updates: Record<string, unknown> = {
        invoice_number: formNumber.trim(),
        amount: lineItemsTotal(items),
        status: formStatus,
        invoice_type: dominantInvoiceType(items),
        line_items: items,
        date: formDate,
        due_date: formDueDate || null,
        paid_date: formStatus === 'paid' ? (formPaidDate || null) : null,
        description: formDescription.trim(),
      };

      if (fileData) {
        updates.file_url = fileData.file_url;
        updates.file_name = fileData.file_name;
        updates.file_size = fileData.file_size;
        updates.mime_type = fileData.mime_type;
      }

      await updateInvoice(editingId, updates);

      resetForm();
      setEditingId(null);
      toast('success', 'Invoice updated');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    resetForm();
    setEditingId(null);
    setIsAdding(false);
  };

  const executeDelete = () => {
    if (deleteTarget) {
      deleteInvoice(deleteTarget);
      toast('success', 'Invoice deleted');
    }
  };

  const handleRateBlur = () => {
    setEditingRate(false);
    const parsed = parseFloat(rateValue);
    if (isNaN(parsed) || parsed < 0) return;
    updateProject(projectId, { hourly_rate: parsed });
  };

  const handleRateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRateBlur();
    } else if (e.key === 'Escape') {
      setEditingRate(false);
    }
  };

  // Render a single editable line item row
  const renderLineItem = (li: InvoiceLineItem, canDelete: boolean) => {
    const showFrequency = li.item_type === 'recurring';
    const showServiceDates = li.item_type !== 'hourly';
    return (
      <div key={li.id} className="rounded-md border border-zinc-200 bg-white p-2.5 space-y-2">
        <div className="flex flex-wrap items-start gap-2">
          <div className="w-28 flex-shrink-0">
            <Select
              size="sm"
              value={li.item_type}
              onChange={v => patchLineItem(li.id, { item_type: v as InvoiceType })}
              options={typeOptions}
            />
          </div>
          <div className="w-28 flex-shrink-0">
            <TextInput
              size="sm"
              value={amountDrafts[li.id] ?? (li.amount === 0 ? '' : String(li.amount))}
              onChange={v => updateAmountDraft(li.id, v)}
              placeholder="0.00"
              prefix="$"
            />
          </div>
          <div className="basis-full sm:basis-0 sm:flex-1 min-w-0 order-last sm:order-none">
            <TextInput
              size="sm"
              value={li.description}
              onChange={v => patchLineItem(li.id, { description: v })}
              placeholder="Line description"
            />
          </div>
          <button
            type="button"
            onClick={() => removeLineItem(li.id)}
            disabled={!canDelete && formLineItems.length === 1}
            className="ml-auto sm:ml-0 p-1.5 text-zinc-400 hover:text-red-500 transition-colors rounded-md hover:bg-zinc-50 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Remove line item"
          >
            <X size={14} />
          </button>
        </div>
        {showServiceDates && (
          <div className={`grid gap-2 grid-cols-1 ${showFrequency ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
            {showFrequency && (
              <Select
                size="sm"
                label="Frequency"
                value={li.recurrence_frequency || 'monthly'}
                onChange={v => patchLineItem(li.id, { recurrence_frequency: v as RecurrenceFrequency })}
                options={RECURRENCE_FREQUENCIES.map(f => ({ value: f, label: f.charAt(0).toUpperCase() + f.slice(1) }))}
              />
            )}
            <DateInput
              label="Service Start"
              value={li.service_start_date || ''}
              onChange={v => patchLineItem(li.id, { service_start_date: v || null })}
              size="sm"
            />
            <DateInput
              label="Service End"
              value={li.service_end_date || ''}
              onChange={v => patchLineItem(li.id, { service_end_date: v || null })}
              size="sm"
            />
          </div>
        )}
      </div>
    );
  };

  // Shared form fields renderer
  const renderForm = (mode: 'add' | 'edit') => (
    <div className={mode === 'add' ? 'border border-brand-200 bg-brand-50/30 rounded-lg p-4 space-y-3' : 'space-y-3'}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <TextInput
          label="Invoice #"
          autoFocus
          value={formNumber}
          onChange={setFormNumber}
          placeholder="INV-001"
          size="sm"
        />
        <Select
          label="Status"
          value={formStatus}
          onChange={v => setFormStatus(v as InvoiceStatus)}
          options={INVOICE_STATUSES.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
          size="sm"
        />
      </div>

      <div className={`grid gap-2 grid-cols-2 ${formStatus === 'paid' ? 'sm:grid-cols-3' : ''}`}>
        <DateInput
          label="Invoice Date"
          value={formDate}
          onChange={setFormDate}
          size="sm"
        />
        <DateInput
          label="Due Date"
          value={formDueDate}
          onChange={setFormDueDate}
          size="sm"
        />
        {formStatus === 'paid' && (
          <DateInput
            label="Paid Date"
            value={formPaidDate}
            onChange={setFormPaidDate}
            size="sm"
          />
        )}
      </div>

      {/* Line items editor */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium text-input-text-label">Line Items</span>
          <span className="text-xs font-medium text-input-text-label">
            Total <span className="text-zinc-900">${formatCurrency(formTotal)}</span>
          </span>
        </div>
        <div className="space-y-2">
          {formLineItems.map(li => renderLineItem(li, formLineItems.length > 1))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={addLineItem}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 transition-colors"
          >
            <Plus size={12} strokeWidth={2.5} />
            Add line
          </button>
          {unpaidHoursDraft && (
            <button
              type="button"
              onClick={addUnpaidHoursLineItem}
              title={unpaidHoursDraft.description}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 transition-colors"
            >
              <Clock size={12} strokeWidth={2.5} />
              Add unpaid hours (${formatCurrency(unpaidHoursDraft.amount)})
            </button>
          )}
        </div>
      </div>

      <Textarea
        label="Invoice Notes"
        value={formDescription}
        onChange={setFormDescription}
        placeholder="Optional notes, payment terms, or a thank-you"
        rows={2}
        size="sm"
      />

      {/* File upload */}
      <div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) {
              setFormFile(file);
              setExistingFileUrl(null);
              setExistingFileName(null);
            }
          }}
        />
        {formFile ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg">
            <File size={14} className="text-zinc-400 flex-shrink-0" />
            <span className="text-sm text-zinc-700 truncate flex-1">{formFile.name}</span>
            <button
              onClick={() => setFormFile(null)}
              className="p-0.5 text-zinc-400 hover:text-red-500 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        ) : existingFileUrl ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg">
            <File size={14} className="text-zinc-400 flex-shrink-0" />
            <span className="text-sm text-zinc-700 truncate flex-1">{existingFileName || 'Attached file'}</span>
            <button
              onClick={() => { setExistingFileUrl(null); setExistingFileName(null); }}
              className="p-0.5 text-zinc-400 hover:text-red-500 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 border border-dashed border-zinc-300 hover:border-zinc-400 rounded-lg transition-colors"
          >
            <Upload size={14} />
            Attach file
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={handleCancel}
          className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={mode === 'add' ? handleAdd : handleSaveEdit}
          disabled={!canSave() || saving}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving && <Loader2 size={13} className="animate-spin" />}
          {mode === 'add' ? 'Save' : 'Update'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[600px]">
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between flex-shrink-0 border-b border-zinc-100">
        <div className="flex items-center gap-2">
          <Receipt size={18} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-900">
            Invoices
            {invoices.length > 0 && (
              <span className="ml-1.5 text-xs font-medium text-zinc-400">({invoices.length})</span>
            )}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openAddForm}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
          >
            <Plus size={14} />
            Add
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Balance Summary */}
        {!isAdding && !editingId && <div className="px-5 py-3 border-b border-zinc-100 bg-zinc-50/50 flex-shrink-0 overflow-x-auto">
          <div className="flex gap-4 min-w-max">
            {/* Budget (read-only, configured in project settings) */}
            {hasBudget && (
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Budget</p>
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-semibold text-zinc-900">
                    {budgetType === 'hours' ? `${formatCurrency(budgetValue)} hrs` : `$${formatCurrency(budgetValue)}`}
                  </p>
                  {budgetValue > 0 && (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                      budgetPct >= 100 ? 'bg-red-50 text-red-700'
                        : budgetPct >= 90 ? 'bg-red-50 text-red-600'
                        : budgetPct >= 75 ? 'bg-orange-50 text-orange-600'
                        : budgetPct >= 50 ? 'bg-amber-50 text-amber-600'
                        : budgetPct >= 25 ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-emerald-50 text-emerald-500'
                    }`}>
                      {Math.round(budgetPct)}%
                    </span>
                  )}
                </div>
              </div>
            )}
            {isHourly && (
              <div className="shrink-0 min-w-[5.5rem]">
                <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Billable</p>
                <p className="text-sm font-semibold text-zinc-900">${formatCurrency(billableTotal)}</p>
              </div>
            )}
            <div className="shrink-0 min-w-[5.5rem]">
              <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Invoiced</p>
              <p className="text-sm font-semibold text-zinc-900">${formatCurrency(totalInvoiced)}</p>
            </div>
            <div className="shrink-0 min-w-[5.5rem]">
              <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Paid</p>
              <p className="text-sm font-semibold text-emerald-600">${formatCurrency(totalPaid)}</p>
            </div>
            <div className="shrink-0 min-w-[5.5rem]">
              <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Outstanding</p>
              <p className={`text-sm font-semibold ${outstanding > 0 ? 'text-amber-600' : 'text-zinc-400'}`}>${formatCurrency(outstanding)}</p>
            </div>
            {isHourly && (
              <>
                <div className="shrink-0 min-w-[5.5rem]">
                  <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Total Hours</p>
                  <p className="text-sm font-semibold text-zinc-900">{Math.round(totalHours)}</p>
                </div>
                <div className="shrink-0 min-w-[5.5rem]">
                  <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Hourly Rate</p>
                  {editingRate ? (
                    <div className="inline-flex items-center w-24">
                      <TextInput
                        autoFocus
                        value={rateValue}
                        onChange={setRateValue}
                        onBlur={handleRateBlur}
                        onKeyDown={handleRateKeyDown}
                        prefix="$"
                        size="sm"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-semibold text-zinc-900">${Math.round(hourlyRate)}</p>
                      <button
                        onClick={() => { setEditingRate(true); setRateValue(String(hourlyRate)); }}
                        className="p-0.5 text-zinc-400 hover:text-brand-600 transition-colors"
                      >
                        <Edit2 size={12} />
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>}
        {/* Add form */}
        {isAdding && !editingId && (
          <div className="m-5">
            {renderForm('add')}
          </div>
        )}

        {/* Invoice list */}
        {invoices.length > 0 ? (
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {invoices.sort((a, b) => b.date.localeCompare(a.date)).map(invoice => {
              const isEditing = editingId === invoice.id;

              if (isEditing) {
                return (
                  <div
                    key={invoice.id}
                    className="p-3 rounded-lg border border-brand-200 bg-brand-50/30"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[invoice.status]}`}>
                        {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                      </span>
                      <span className="text-sm font-semibold text-zinc-900">{invoice.invoice_number}</span>
                      <span className="text-xs text-zinc-400">Editing</span>
                    </div>
                    {renderForm('edit')}
                  </div>
                );
              }

              const items = ensureLineItems(invoice);
              const hasMultipleLines = items.length > 1;
              const isExpanded = expandedIds.has(invoice.id);
              const hasDetails = items.length > 0 || !!invoice.description || !!invoice.file_url;

              return (
                <div
                  key={invoice.id}
                  className="group rounded-lg border border-zinc-200 hover:border-zinc-300 transition-colors"
                >
                  <div
                    className={`p-3 ${hasDetails ? 'cursor-pointer' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded-lg`}
                    {...(hasDetails && {
                      role: 'button',
                      tabIndex: 0,
                      'aria-expanded': isExpanded,
                      'aria-label': isExpanded ? 'Hide invoice details' : 'Show invoice details',
                      onClick: () => toggleExpanded(invoice.id),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleExpanded(invoice.id);
                        }
                      },
                    })}
                  >
                    <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <div
                          className="relative inline-flex items-center"
                          onClick={e => e.stopPropagation()}
                          onKeyDown={e => e.stopPropagation()}
                        >
                          <span className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[invoice.status]}`}>
                            {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                          </span>
                          <div className="[&_button]:!bg-transparent [&_button]:!border-transparent [&_button]:!shadow-none [&_button]:!ring-0 [&_button]:!text-transparent [&_button]:!px-2 [&_button]:!py-0.5 [&_button]:!text-xs [&_svg]:!text-transparent">
                            <Select
                              size="sm"
                              value={invoice.status}
                              onChange={v => updateInvoice(invoice.id, { status: v as InvoiceStatus })}
                              options={INVOICE_STATUSES.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
                            />
                          </div>
                        </div>
                        <span className="text-sm font-semibold text-zinc-900">{invoice.invoice_number}</span>
                        {hasMultipleLines ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-zinc-100 text-zinc-500">
                            {items.length} items
                          </span>
                        ) : invoice.invoice_type && invoice.invoice_type !== 'hourly' && (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-zinc-100 text-zinc-500 capitalize">
                            {invoice.invoice_type}
                          </span>
                        )}
                      </div>
                      <span className="text-sm font-semibold text-zinc-900">
                        ${formatCurrency(invoice.amount)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 text-xs text-zinc-500 min-w-0 flex-wrap">
                        <span>Issued: {fmtDate(invoice.date)}</span>
                        {invoice.due_date && invoice.due_date !== invoice.date && <span>Due: {fmtDate(invoice.due_date)}</span>}
                        {invoice.paid_date && <span className="text-emerald-600">Paid: {fmtDate(invoice.paid_date)}</span>}
                      </div>
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
                          <button
                            onClick={e => { e.stopPropagation(); startEditing(invoice); }}
                            aria-label="Edit invoice"
                            className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                          >
                            <Edit2 size={13} />
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); startDuplicating(invoice); }}
                            aria-label="Duplicate invoice"
                            className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                          >
                            <Copy size={13} />
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setDeleteTarget(invoice.id); }}
                            aria-label="Delete invoice"
                            className="p-1.5 text-zinc-400 hover:text-red-500 transition-colors rounded-md hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        {hasDetails && (
                          <ChevronDown
                            size={14}
                            aria-hidden="true"
                            className={`hidden sm:block text-zinc-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}
                          />
                        )}
                      </div>
                    </div>
                  </div>

                  {isExpanded && hasDetails && (
                    <div className="px-3 pb-3 pt-0 space-y-3 border-t border-zinc-100 bg-zinc-50/40 rounded-b-lg">
                      {items.length > 0 && (
                        <div className="pt-3">
                          <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-1.5">
                            {hasMultipleLines ? 'Line items' : 'Line item'}
                          </p>
                          <div className="space-y-1.5">
                            {items.map(li => {
                              const period = fmtServicePeriod(li.service_start_date, li.service_end_date);
                              return (
                                <div key={li.id} className="flex items-start justify-between gap-3 text-xs bg-white border border-zinc-100 rounded-md px-2.5 py-2">
                                  <div className="flex-1 min-w-0 space-y-1">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-zinc-100 text-zinc-600 capitalize">
                                        {li.item_type}
                                      </span>
                                      {li.item_type === 'recurring' && li.recurrence_frequency && (
                                        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-50 text-amber-700 capitalize">
                                          {li.recurrence_frequency}
                                        </span>
                                      )}
                                      {period && (
                                        <span className="text-[10px] text-zinc-500">{period}</span>
                                      )}
                                    </div>
                                    {li.description && (
                                      <p className="text-xs text-zinc-700 break-words">{li.description}</p>
                                    )}
                                  </div>
                                  <span className="text-xs font-semibold text-zinc-900 flex-shrink-0 pt-0.5">
                                    ${formatCurrency(li.amount)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {(invoice.description || hasMultipleLines) && (
                        <div className="flex items-start justify-between gap-4">
                          {invoice.description ? (
                            <div className="min-w-0 flex-1">
                              <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-1">Notes</p>
                              <p className="text-xs text-zinc-700 whitespace-pre-wrap break-words">{invoice.description}</p>
                            </div>
                          ) : (
                            <div aria-hidden="true" />
                          )}
                          {hasMultipleLines && (
                            <div className="flex-shrink-0 text-right">
                              <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-1">Total</p>
                              <p className="text-sm font-semibold text-zinc-900">${formatCurrency(invoice.amount)}</p>
                            </div>
                          )}
                        </div>
                      )}

                      {invoice.file_url && (
                        <div>
                          <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-1">Attachment</p>
                          <a
                            href={invoice.file_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded"
                          >
                            <FileDown size={12} />
                            {invoice.file_name || 'Download'}
                          </a>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : !isAdding ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
              <Receipt size={18} className="text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-500">No invoices yet</p>
            <p className="text-xs text-zinc-400 mt-1">Create invoices to track billing for this project</p>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDelete}
        title="Delete Invoice"
        message="Are you sure you want to delete this invoice? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
