'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Receipt, Plus, Edit2, Trash2, FileDown, X, Upload, File,
  Loader2, ChevronDown, Copy, Clock, Eye, AlertTriangle, ListChecks, Send,
} from 'lucide-react';
import { InvoicePreviewModal } from '@/components/projects/InvoicePreviewModal';
import ClientEmailPreviewModal from '@/components/projects/ClientEmailPreviewModal';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import Modal from '@/components/ui/Modal';
import { useDemo } from '@/lib/demo-context';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toLocalDateKey, toLocalDateString } from '@/lib/date-utils';
import {
  INVOICE_STATUSES, INVOICE_LINE_ITEM_TYPES, RECURRENCE_FREQUENCIES,
  type InvoiceStatus, type InvoiceLineItemType, type InvoiceLineItem, type RecurrenceFrequency,
  type InvoiceTimeEntryAllocation,
} from '@/lib/types';
import { getWorkedHours } from '@/lib/time-entry-utils';
import { HourlyRateSchedule } from './HourlyRateSchedule';
import {
  ensureLineItems, lineItemsTotal, dominantInvoiceType, newLineItemId, suggestServiceEnd,
  paidHourlyLineItemTotal, buildUnpaidHoursLineItem, buildPartialUnpaidHoursLineItem,
  buildPartialUnpaidHoursLineItemByAmount, formatUnpaidHoursDescription, totalBillableAmount,
  type UnpaidHoursLineItemDraft,
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

function formatHours(value: number): string {
  if (value > 0 && value < 0.0001) return '<0.0001';
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function isMeaningfulTimeAllocation(allocation: InvoiceTimeEntryAllocation): boolean {
  return Number(allocation.allocated_hours) > 0 && Number(allocation.allocated_amount) > 0;
}

function fmtTrackedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

function removeExcludedAllocations(
  draft: UnpaidHoursLineItemDraft | null,
  excludedIds: ReadonlySet<string>,
  entryById: ReadonlyMap<string, { start_time: string; end_time: string | null }>,
): UnpaidHoursLineItemDraft | null {
  if (!draft || excludedIds.size === 0) return draft;
  const allocations = draft.allocations.filter(allocation => !excludedIds.has(allocation.time_entry_id));
  if (allocations.length === 0) return null;
  const entries = allocations
    .map(allocation => entryById.get(allocation.time_entry_id))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  if (entries.length === 0) return null;
  const hours = allocations.reduce((sum, allocation) => sum + allocation.allocated_hours, 0);
  const amount = allocations.reduce((sum, allocation) => sum + allocation.allocated_amount, 0);
  const startDate = entries[0].start_time;
  const endDate = entries[entries.length - 1].end_time ?? entries[entries.length - 1].start_time;
  return {
    allocations,
    hours,
    amount: Math.round(amount * 100) / 100,
    startDate,
    endDate,
    description: formatUnpaidHoursDescription(hours, startDate, endDate),
  };
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

function lineItemTypeLabel(type: InvoiceLineItemType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function makeLineItem(defaultType: InvoiceLineItemType, position = 0): InvoiceLineItem {
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
    getProject, updateProject, getTimeEntriesByProject, getPrimaryClient, team,
  } = useApp();
  const { teamMemberId, access } = useAuth();
  const { isDemoMode } = useDemo();
  const currentMember = team.find(m => m.id === teamMemberId);
  const preferredTimezone = currentMember?.timezone && currentMember.timezone !== 'UTC'
    ? currentMember.timezone
    : undefined;
  // YYYY-MM-DD for "today" in the user's preferred zone. If the stored zone is
  // still the unset default, fall back to the browser's local day.
  const todayLocalDate = toLocalDateString(preferredTimezone);
  const invoices = getInvoicesByProject(projectId);
  const project = getProject(projectId);
  const primaryClient = getPrimaryClient(projectId);
  const hasPrimaryClientEmail = !!primaryClient?.contact?.email;
  const canEmailInvoices = hasPermission(access, 'communications.manage')
    && hasPermission(access, 'invoices.manage');

  // UI state
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [previewInvoiceId, setPreviewInvoiceId] = useState<string | null>(null);
  const [emailInvoiceId, setEmailInvoiceId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const emailManual = useMemo(
    () => (emailInvoiceId ? { type: 'invoice' as const, context: { invoiceId: emailInvoiceId } } : undefined),
    [emailInvoiceId],
  );

  // Unpaid-hours partial picker — lets the user invoice less than the full
  // outstanding balance with auto-synced amount/hours fields.
  const [unpaidPickerOpen, setUnpaidPickerOpen] = useState(false);
  const [unpaidPickerAmount, setUnpaidPickerAmount] = useState('');
  const [unpaidPickerHours, setUnpaidPickerHours] = useState('');
  const [unpaidPickerMode, setUnpaidPickerMode] = useState<'amount' | 'hours'>('amount');
  const [unpaidReviewOpen, setUnpaidReviewOpen] = useState(false);
  const [unpaidPeriodMode, setUnpaidPeriodMode] = useState<'all' | 'custom'>('all');
  const [unpaidPeriodStart, setUnpaidPeriodStart] = useState('');
  const [unpaidPeriodEnd, setUnpaidPeriodEnd] = useState('');
  const [excludedTimeEntryIds, setExcludedTimeEntryIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openInvoiceEmailPreview = (invoiceId: string) => {
    if (!canEmailInvoices) {
      toast('error', 'You do not have permission to send invoices');
      return;
    }
    if (!hasPrimaryClientEmail) {
      toast('error', 'Set a primary client contact with an email first');
      return;
    }
    if (isDemoMode) {
      toast('success', 'Invoice email sent (demo)');
      return;
    }
    setEmailInvoiceId(invoiceId);
  };

  // Form state
  const [formNumber, setFormNumber] = useState('');
  const [formDate, setFormDate] = useState('');
  const [formDueDate, setFormDueDate] = useState('');
  const [formPaidDate, setFormPaidDate] = useState('');
  const [formStatus, setFormStatus] = useState<InvoiceStatus>('draft');
  const [formDescription, setFormDescription] = useState('');
  const [formLineItems, setFormLineItems] = useState<InvoiceLineItem[]>([]);
  const [formTimeAllocations, setFormTimeAllocations] = useState<InvoiceTimeEntryAllocation[]>([]);
  // Per-line-item raw string drafts for the amount input so users can type
  // intermediate values like "" / "0." / ".5" without parseFloat clobbering
  // them on every keystroke.
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});
  const [formFile, setFormFile] = useState<File | null>(null);
  const [existingFileUrl, setExistingFileUrl] = useState<string | null>(null);
  const [existingFileName, setExistingFileName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Rate schedule editor state
  const [editingRate, setEditingRate] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tracks recurring line items whose service dates were auto-seeded from the
  // invoice's due/issue date — used to cascade updates if those dates change
  // later. A user editing a service date removes that line item from the set.
  const autoSeededRef = useRef<Set<string>>(new Set());

  // Calculate hours from time entries
  const timeEntries = getTimeEntriesByProject(projectId);
  const isHourly = project?.client_time_billing
    ? project.client_time_billing === 'hourly'
    : project?.hourly_tracking ?? false;
  const hourlyRate = project?.hourly_rate ?? 0;
  const finalizedHourEntries = isHourly
    ? timeEntries
        .filter(te => te.end_time !== null
          && te.work_type !== 'internal'
          && (te.approval_status === undefined || te.approval_status === 'approved'))
        .map(te => ({
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

  // Aggregate totals across all active invoices' line items.
  // Outstanding preserves the hourly-vs-non-hourly formula from lessons.md.
  const activeInvoices = invoices.filter(inv => inv.status !== 'cancelled');
  const totalInvoiced = activeInvoices.reduce((sum, inv) => sum + inv.amount, 0);
  const totalPaid = invoices.filter(inv => inv.status === 'paid').reduce((sum, inv) => sum + inv.amount, 0);
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
  const billableTotal = Math.max(accruedHourlyTotal, hourlyInvoiced) + serviceInvoiced + reimbursementInvoiced;
  const outstanding = isHourly
    ? Math.max(0, billableTotal - totalPaid)
    : Math.max(0, totalInvoiced - totalPaid);

  // Budget progress
  let budgetUsed = 0;
  if (hasBudget) {
    if (budgetType === 'hours') {
      budgetUsed = totalHours;
    } else {
      budgetUsed = isHourly ? accruedHourlyTotal : serviceLineTotal;
    }
  }
  const budgetPct = hasBudget && budgetValue > 0 ? Math.min(100, (budgetUsed / budgetValue) * 100) : 0;

  // Type options: non-hourly projects can't create hourly line items.
  const typeOptions = isHourly
    ? INVOICE_LINE_ITEM_TYPES.map(t => ({ value: t, label: lineItemTypeLabel(t) }))
    : INVOICE_LINE_ITEM_TYPES.filter(t => t !== 'hourly').map(t => ({ value: t, label: lineItemTypeLabel(t) }));
  const defaultType: InvoiceLineItemType = isHourly ? 'hourly' : 'fixed';

  // Roll up unpaid hours into a draft hourly line item. Computed from finalized
  // entries vs. the FIFO pool of dollars covered by paid hourly line items, so
  // saving an invoice as `paid` automatically shrinks the next click's amount.
  // Drafts/sent invoices don't drain the pool, which matches how the rest of
  // the panel reasons about "paid hours". Hoisted out of the original IIFE
  // so the partial-amount picker can re-walk FIFO at commit time to find
  // the right end-date cutoff for less-than-full invoices.
  const paidHourlyPool = isHourly
    ? paidHourlyLineItemTotal(editingId ? invoices.filter(invoice => invoice.id !== editingId) : invoices)
    : 0;
  const allUnpaidHoursDraft = isHourly
    ? buildUnpaidHoursLineItem(finalizedHourEntries, paidHourlyPool, hourlyRate)
    : null;
  const customPeriodIsValid = unpaidPeriodMode === 'all'
    || (Boolean(unpaidPeriodStart) && Boolean(unpaidPeriodEnd) && unpaidPeriodStart <= unpaidPeriodEnd);
  const periodEligibleEntryIds = new Set(
    finalizedHourEntries
      .filter(entry => {
        if (unpaidPeriodMode === 'all') return true;
        if (!customPeriodIsValid) return false;
        const dateKey = toLocalDateKey(entry.start_time, preferredTimezone);
        return dateKey >= unpaidPeriodStart && dateKey <= unpaidPeriodEnd;
      })
      .map(entry => entry.id),
  );
  const unpaidHoursDraft = isHourly
    ? buildUnpaidHoursLineItem(finalizedHourEntries, paidHourlyPool, hourlyRate, periodEligibleEntryIds)
    : null;
  const parsedPickerAmount = parseFloat(unpaidPickerAmount);
  const parsedPickerHours = parseFloat(unpaidPickerHours);
  const baseSelectedUnpaidDraft = unpaidPickerMode === 'amount'
    ? (Number.isFinite(parsedPickerAmount) && parsedPickerAmount > 0
        ? buildPartialUnpaidHoursLineItemByAmount(
            finalizedHourEntries,
            paidHourlyPool,
            hourlyRate,
            parsedPickerAmount,
            periodEligibleEntryIds,
          )
        : null)
    : (Number.isFinite(parsedPickerHours) && parsedPickerHours > 0
        ? buildPartialUnpaidHoursLineItem(
            finalizedHourEntries,
            paidHourlyPool,
            hourlyRate,
            parsedPickerHours,
            periodEligibleEntryIds,
          )
        : null);
  const timeEntryById = new Map(finalizedHourEntries.map(entry => [entry.id, entry] as const));
  const selectedUnpaidDraft = removeExcludedAllocations(
    baseSelectedUnpaidDraft,
    excludedTimeEntryIds,
    timeEntryById,
  );
  const selectedSessionIds = new Set(
    selectedUnpaidDraft?.allocations.map(allocation => allocation.time_entry_id) ?? [],
  );
  const conflictingInvoiceNumbers = [...new Set(
    invoices
      .filter(invoice => (
        invoice.id !== editingId
        && (invoice.status === 'draft' || invoice.status === 'sent' || invoice.status === 'overdue')
      ))
      .filter(invoice => (invoice.time_allocations ?? []).some(allocation => selectedSessionIds.has(allocation.time_entry_id)))
      .map(invoice => invoice.invoice_number),
  )];
  const lastSelectedAllocation = selectedUnpaidDraft?.allocations.at(-1) ?? null;
  const lastSelectedEntry = lastSelectedAllocation
    ? timeEntryById.get(lastSelectedAllocation.time_entry_id)
    : null;
  const lastSessionIsPartial = Boolean(
    lastSelectedAllocation
    && lastSelectedEntry
    && (
      lastSelectedAllocation.start_offset_hours > 0.000001
      || lastSelectedAllocation.start_offset_hours + lastSelectedAllocation.allocated_hours < lastSelectedEntry.hours - 0.000001
    )
  );
  const pickerExceedsAvailable = unpaidPickerMode === 'amount'
    ? Number.isFinite(parsedPickerAmount) && parsedPickerAmount > (unpaidHoursDraft?.amount ?? 0) + 0.005
    : Number.isFinite(parsedPickerHours) && parsedPickerHours > (unpaidHoursDraft?.hours ?? 0) + 0.000001;
  const pickerSelectionIsValid = Boolean(selectedUnpaidDraft && !pickerExceedsAvailable);
  const availableTrackedAmount = unpaidHoursDraft?.amount;
  const availableTrackedHours = unpaidHoursDraft?.hours;

  useEffect(() => {
    if (!unpaidPickerOpen) return;
    setExcludedTimeEntryIds(new Set());
    if (availableTrackedAmount === undefined || availableTrackedHours === undefined) {
      setUnpaidPickerAmount('');
      setUnpaidPickerHours('');
      return;
    }
    setUnpaidPickerAmount(String(availableTrackedAmount));
    setUnpaidPickerHours(availableTrackedHours.toFixed(4).replace(/\.?0+$/, ''));
  }, [
    unpaidPickerOpen,
    unpaidPeriodMode,
    unpaidPeriodStart,
    unpaidPeriodEnd,
    availableTrackedAmount,
    availableTrackedHours,
  ]);

  const resetForm = () => {
    setFormNumber('');
    setFormDate('');
    setFormDueDate('');
    setFormPaidDate('');
    setFormStatus('draft');
    setFormDescription('');
    const initial = [makeLineItem(defaultType, 0)];
    setFormLineItems(initial);
    setFormTimeAllocations([]);
    setAmountDrafts({ [initial[0].id]: '' });
    setUnpaidPickerOpen(false);
    setUnpaidPickerMode('amount');
    setUnpaidReviewOpen(false);
    setUnpaidPeriodMode('all');
    setUnpaidPeriodStart('');
    setUnpaidPeriodEnd('');
    setExcludedTimeEntryIds(new Set());
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
    setFormDate(todayLocalDate);
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
  // Insert (or replace) an unpaid-hours line item with the given amount /
  // hours / description. Defaults pull from the full outstanding draft, but
  // the picker can override with partial values.
  const insertUnpaidHoursLineItem = (
    amount: number,
    description: string,
    allocations: Array<Omit<InvoiceTimeEntryAllocation, 'line_item_id'>>,
  ) => {
    const lineItemId = newLineItemId();
    const mappedLineItemIds = new Set(formTimeAllocations.map(allocation => allocation.line_item_id));
    setFormLineItems(items => {
      const filtered = items.filter(li => !mappedLineItemIds.has(li.id));
      const fresh: InvoiceLineItem = {
        id: lineItemId,
        position: filtered.length,
        item_type: 'hourly',
        amount,
        description,
        service_start_date: null,
        service_end_date: null,
        recurrence_frequency: null,
      };
      setAmountDrafts(d => ({ ...d, [fresh.id]: String(amount) }));
      // If the form started with the default empty placeholder line, drop it.
      const trimmed = filtered.filter(li => !(li.amount === 0 && li.description === '' && li.item_type === defaultType && filtered.length === 1));
      return [...trimmed, fresh].map((li, i) => ({ ...li, position: i }));
    });
    setFormTimeAllocations(previous => [
      ...previous.filter(allocation => !mappedLineItemIds.has(allocation.line_item_id)),
      ...allocations.map(allocation => ({ ...allocation, line_item_id: lineItemId })),
    ]);
  };

  // Open / sync helpers for the partial-amount picker.
  const openUnpaidPicker = () => {
    if (!allUnpaidHoursDraft) return;
    setUnpaidPickerAmount(String(allUnpaidHoursDraft.amount));
    setUnpaidPickerHours(allUnpaidHoursDraft.hours.toFixed(4).replace(/\.?0+$/, ''));
    setUnpaidPickerMode('amount');
    setUnpaidReviewOpen(false);
    setUnpaidPeriodMode('all');
    setUnpaidPeriodStart('');
    setUnpaidPeriodEnd('');
    setExcludedTimeEntryIds(new Set());
    setUnpaidPickerOpen(true);
  };
  const closeUnpaidPicker = () => {
    setUnpaidPickerOpen(false);
    setUnpaidReviewOpen(false);
  };
  const handleUnpaidAmountChange = (raw: string) => {
    setUnpaidPickerAmount(raw);
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    const draft = buildPartialUnpaidHoursLineItemByAmount(
      finalizedHourEntries,
      paidHourlyPool,
      hourlyRate,
      parsed,
      periodEligibleEntryIds,
    );
    if (draft) setUnpaidPickerHours(draft.hours.toFixed(4).replace(/\.?0+$/, ''));
  };
  const handleUnpaidHoursChange = (raw: string) => {
    setUnpaidPickerHours(raw);
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    const draft = buildPartialUnpaidHoursLineItem(
      finalizedHourEntries,
      paidHourlyPool,
      hourlyRate,
      parsed,
      periodEligibleEntryIds,
    );
    if (draft) setUnpaidPickerAmount(String(draft.amount));
  };
  const setPickerMode = (mode: 'amount' | 'hours') => {
    const current = selectedUnpaidDraft ?? unpaidHoursDraft;
    if (current) {
      setUnpaidPickerAmount(String(current.amount));
      setUnpaidPickerHours(current.hours.toFixed(4).replace(/\.?0+$/, ''));
    }
    setUnpaidPickerMode(mode);
  };
  const setPickerPeriodMode = (mode: 'all' | 'custom') => {
    setExcludedTimeEntryIds(new Set());
    setUnpaidPeriodMode(mode);
    if (mode === 'custom' && allUnpaidHoursDraft) {
      setUnpaidPeriodStart(toLocalDateKey(allUnpaidHoursDraft.startDate, preferredTimezone));
      setUnpaidPeriodEnd(toLocalDateKey(allUnpaidHoursDraft.endDate, preferredTimezone));
    }
  };

  // Final commit — runs the FIFO walk against unpaid entries so the line
  // item's date range reflects which actual sessions are being invoiced
  // (earliest unpaid through the entry where the cutoff lands), not the
  // full unpaid range as if everything were being paid.
  const commitUnpaidPicker = () => {
    if (!selectedUnpaidDraft) return;
    insertUnpaidHoursLineItem(
      selectedUnpaidDraft.amount,
      selectedUnpaidDraft.description,
      selectedUnpaidDraft.allocations,
    );
    setUnpaidPickerOpen(false);
    setUnpaidReviewOpen(false);
  };
  const removeLineItem = (id: string) => {
    autoSeededRef.current.delete(id);
    setFormTimeAllocations(previous => previous.filter(allocation => allocation.line_item_id !== id));
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
    // A manual amount edit intentionally detaches the generated session
    // mapping. The user can reopen "Add unpaid hours" to regenerate it.
    setFormTimeAllocations(previous => previous.filter(allocation => allocation.line_item_id !== id));
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
    if (patch.item_type && patch.item_type !== 'hourly') {
      setFormTimeAllocations(previous => previous.filter(allocation => allocation.line_item_id !== id));
    }
    setFormLineItems(items => items.map(li => {
      if (li.id !== id) return li;
      const next: InvoiceLineItem = { ...li, ...patch };
      // If item_type changed away from recurring, drop the frequency.
      if (patch.item_type && patch.item_type !== 'recurring' && li.item_type === 'recurring') {
        next.recurrence_frequency = null;
      }
      // Hourly and reimbursement line items don't carry a service window.
      if (patch.item_type === 'hourly' || patch.item_type === 'reimbursement') {
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
      const validIds = new Set(items.map(item => item.id));

      const created = await addInvoice({
        project_id: projectId,
        invoice_number: formNumber.trim(),
        amount: lineItemsTotal(items),
        status: formStatus,
        invoice_type: dominantInvoiceType(items),
        line_items: items,
        time_allocations: formTimeAllocations.filter(allocation => (
          validIds.has(allocation.line_item_id) && isMeaningfulTimeAllocation(allocation)
        )),
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
      if (!created) return;

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
    setFormDate(todayLocalDate);
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
    setFormTimeAllocations([]);
    setAmountDrafts(Object.fromEntries(cloned.map(li => [li.id, li.amount === 0 ? '' : String(li.amount)])));
    setIsAdding(true);
  };

  const startEditing = (invoice: typeof invoices[number]) => {
    setIsAdding(false);
    setUnpaidPickerOpen(false);
    setUnpaidReviewOpen(false);
    setEditingId(invoice.id);
    setFormNumber(invoice.invoice_number);
    setFormDate(invoice.date);
    setFormDueDate(invoice.due_date || '');
    setFormPaidDate(invoice.paid_date || '');
    setFormStatus(invoice.status);
    setFormDescription(invoice.description || '');
    const loaded = ensureLineItems(invoice).map((li, i) => ({ ...li, position: i }));
    setFormLineItems(loaded);
    setFormTimeAllocations((invoice.time_allocations ?? []).filter(isMeaningfulTimeAllocation));
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
      const validIds = new Set(items.map(item => item.id));

      const updates: Record<string, unknown> = {
        invoice_number: formNumber.trim(),
        amount: lineItemsTotal(items),
        status: formStatus,
        invoice_type: dominantInvoiceType(items),
        line_items: items,
        time_allocations: formTimeAllocations.filter(allocation => (
          validIds.has(allocation.line_item_id) && isMeaningfulTimeAllocation(allocation)
        )),
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

      const updated = await updateInvoice(editingId, updates);
      if (!updated) return;

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

  const reviewTrackedLineItem = (lineItem: InvoiceLineItem) => {
    const allocations = formTimeAllocations.filter(allocation => allocation.line_item_id === lineItem.id);
    const hours = allocations.reduce((sum, allocation) => sum + Number(allocation.allocated_hours), 0);
    setUnpaidPickerAmount(String(lineItem.amount));
    setUnpaidPickerHours(hours.toFixed(4).replace(/\.?0+$/, ''));
    setUnpaidPickerMode('amount');
    setUnpaidPeriodMode('all');
    setUnpaidPeriodStart('');
    setUnpaidPeriodEnd('');
    setExcludedTimeEntryIds(new Set());
    setUnpaidReviewOpen(true);
    setUnpaidPickerOpen(true);
  };

  // Render a single editable line item row
  const renderLineItem = (li: InvoiceLineItem, canDelete: boolean) => {
    const showFrequency = li.item_type === 'recurring';
    const showServiceDates = li.item_type === 'fixed' || li.item_type === 'recurring';
    const linkedAllocations = formTimeAllocations.filter(allocation => allocation.line_item_id === li.id);
    const isTrackedTimeLine = li.item_type === 'hourly' && linkedAllocations.length > 0;
    if (isTrackedTimeLine) {
      const linkedHours = linkedAllocations.reduce(
        (sum, allocation) => sum + Number(allocation.allocated_hours),
        0,
      );
      const linkedEntries = linkedAllocations
        .map(allocation => timeEntryById.get(allocation.time_entry_id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
      const linkedPeriod = linkedEntries.length > 0
        ? `${fmtTrackedDate(linkedEntries[0].start_time)} – ${fmtTrackedDate(linkedEntries[linkedEntries.length - 1].start_time)}`
        : null;

      return (
        <div key={li.id} className="rounded-md border border-brand-200 bg-brand-50/30 p-3 space-y-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-brand-200 bg-white text-brand-600">
              <ListChecks size={14} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-xs font-semibold text-zinc-900">Tracked time</p>
                <p className="text-sm font-semibold tabular-nums text-zinc-900">${formatCurrency(li.amount)}</p>
              </div>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                {formatHours(linkedHours)} hrs · {linkedAllocations.length} {linkedAllocations.length === 1 ? 'session' : 'sessions'}
                {linkedPeriod ? ` · ${linkedPeriod}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => removeLineItem(li.id)}
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label="Remove tracked time"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <TextInput
              size="sm"
              label="Invoice description"
              value={li.description}
              onChange={value => patchLineItem(li.id, { description: value })}
              placeholder="Describe the work billed…"
              name={`invoice-description-${li.id}`}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => reviewTrackedLineItem(li)}
              className="inline-flex h-[30px] items-center justify-center gap-1.5 rounded-md border border-brand-200 bg-white px-3 text-xs font-medium text-brand-700 transition-colors hover:border-brand-300 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Eye size={12} aria-hidden="true" />
              Review time
            </button>
          </div>
        </div>
      );
    }

    return (
      <div key={li.id} className="rounded-md border border-zinc-200 bg-white p-2.5 space-y-2">
        <div className="flex flex-wrap items-start gap-2">
          <div className="w-28 flex-shrink-0">
            <Select
              size="sm"
              value={li.item_type}
              onChange={v => patchLineItem(li.id, { item_type: v as InvoiceLineItemType })}
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
    <div className="space-y-4">
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
          {allUnpaidHoursDraft && !unpaidPickerOpen && formTimeAllocations.length === 0 && (
            <button
              type="button"
              onClick={openUnpaidPicker}
              title={allUnpaidHoursDraft.description}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 transition-colors"
            >
              <Clock size={12} strokeWidth={2.5} />
              Add tracked time (${formatCurrency(allUnpaidHoursDraft.amount)})
            </button>
          )}
        </div>

        {allUnpaidHoursDraft && unpaidPickerOpen && (
          <div className="mt-2 overflow-hidden rounded-lg border border-brand-200 bg-white shadow-sm">
            <div className="border-b border-brand-100 bg-brand-50/60 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-zinc-900">Add tracked time</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500">FIFO automatically selects the oldest outstanding time.</p>
                </div>
                <p className="text-[11px] text-zinc-500">
                  Available <span className="font-semibold tabular-nums text-zinc-900">${formatCurrency(unpaidHoursDraft?.amount ?? 0)}</span>
                  <span className="text-zinc-400"> · {formatHours(unpaidHoursDraft?.hours ?? 0)} hrs</span>
                </p>
              </div>
            </div>

            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-zinc-700">Time period</span>
                <div className="inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-0.5" role="group" aria-label="Tracked time period">
                  {(['all', 'custom'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPickerPeriodMode(mode)}
                      aria-pressed={unpaidPeriodMode === mode}
                      className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                        unpaidPeriodMode === mode
                          ? 'bg-white text-zinc-900 shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-800'
                      }`}
                    >
                      {mode === 'all' ? 'All outstanding' : 'Custom dates'}
                    </button>
                  ))}
                </div>
              </div>

              {unpaidPeriodMode === 'custom' && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <DateInput
                    label="From"
                    value={unpaidPeriodStart}
                    onChange={value => {
                      setUnpaidPeriodStart(value);
                      setExcludedTimeEntryIds(new Set());
                    }}
                    size="sm"
                  />
                  <DateInput
                    label="Through"
                    value={unpaidPeriodEnd}
                    onChange={value => {
                      setUnpaidPeriodEnd(value);
                      setExcludedTimeEntryIds(new Set());
                    }}
                    size="sm"
                  />
                </div>
              )}

              {!customPeriodIsValid && (
                <p className="text-[11px] text-red-600" role="alert">Choose a valid start and end date.</p>
              )}

              {customPeriodIsValid && !unpaidHoursDraft && (
                <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] text-zinc-600" role="status">
                  No outstanding sessions start inside this period.
                </p>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-zinc-700">Invoice by</span>
                <div className="inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-0.5" role="group" aria-label="Invoice tracked time by">
                  {(['amount', 'hours'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPickerMode(mode)}
                      aria-pressed={unpaidPickerMode === mode}
                      className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                        unpaidPickerMode === mode
                          ? 'bg-white text-zinc-900 shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-800'
                      }`}
                    >
                      {mode === 'amount' ? 'Amount' : 'Hours'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <TextInput
                  size="sm"
                  label="Amount"
                  description={unpaidPickerMode === 'hours' ? 'Calculated' : undefined}
                  prefix="$"
                  value={unpaidPickerAmount}
                  onChange={handleUnpaidAmountChange}
                  readOnly={unpaidPickerMode !== 'amount'}
                  placeholder="0.00"
                  name="tracked-time-amount"
                  autoComplete="off"
                />
                <TextInput
                  size="sm"
                  label="Hours"
                  description={unpaidPickerMode === 'amount' ? 'Calculated' : undefined}
                  value={unpaidPickerHours}
                  onChange={handleUnpaidHoursChange}
                  readOnly={unpaidPickerMode !== 'hours'}
                  placeholder="0"
                  name="tracked-time-hours"
                  autoComplete="off"
                />
              </div>

              {pickerExceedsAvailable && (
                <p className="text-[11px] text-red-600" role="alert">
                  {unpaidPickerMode === 'amount' ? 'Amount' : 'Hours'} exceeds the available tracked-time balance.
                </p>
              )}

              {baseSelectedUnpaidDraft && (
                <div className="rounded-md border border-zinc-200 bg-zinc-50/70" aria-live="polite">
                  <div className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Calculated selection</p>
                      {selectedUnpaidDraft ? (
                        <>
                          <p className="mt-1 text-xs font-medium text-zinc-900">
                            {formatHours(selectedUnpaidDraft.hours)} hrs · {selectedUnpaidDraft.allocations.length} {selectedUnpaidDraft.allocations.length === 1 ? 'session' : 'sessions'}
                          </p>
                          <p className="mt-0.5 text-[11px] text-zinc-500">
                            {fmtTrackedDate(selectedUnpaidDraft.startDate)} – {fmtTrackedDate(selectedUnpaidDraft.endDate)}
                          </p>
                        </>
                      ) : (
                        <p className="mt-1 text-xs font-medium text-zinc-900">No sessions selected</p>
                      )}
                    </div>
                    <p className="text-sm font-semibold tabular-nums text-zinc-900">${formatCurrency(selectedUnpaidDraft?.amount ?? 0)}</p>
                  </div>

                  {excludedTimeEntryIds.size > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-600">
                      <p>
                        {excludedTimeEntryIds.size} {excludedTimeEntryIds.size === 1 ? 'session' : 'sessions'} excluded. The total was reduced without adding replacement time.
                      </p>
                      <button
                        type="button"
                        onClick={() => setExcludedTimeEntryIds(new Set())}
                        className="font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        Reset to FIFO
                      </button>
                    </div>
                  )}

                  {lastSessionIsPartial && lastSelectedAllocation && lastSelectedEntry && (
                    <div className="border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-600">
                      This invoice includes <span className="font-medium text-zinc-900">{formatHours(lastSelectedAllocation.allocated_hours)} hrs</span> from the final {formatHours(lastSelectedEntry.hours)}-hr session.
                    </div>
                  )}

                  {conflictingInvoiceNumbers.length > 0 && (
                    <div className="flex gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                      <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                      <p>
                        Some selected sessions are already attached to {conflictingInvoiceNumbers.join(', ')}. Review before adding them again.
                      </p>
                    </div>
                  )}

                  {selectedUnpaidDraft && (
                    <button
                      type="button"
                      onClick={() => setUnpaidReviewOpen(open => !open)}
                      aria-expanded={unpaidReviewOpen}
                      className="flex w-full items-center justify-between border-t border-zinc-200 px-3 py-2 text-left text-[11px] font-medium text-brand-700 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                    >
                      <span>Review included time</span>
                      <ChevronDown size={13} className={`transition-transform ${unpaidReviewOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                  )}

                  {unpaidReviewOpen && selectedUnpaidDraft && (
                    <div className="max-h-64 overflow-y-auto border-t border-zinc-200 bg-white overscroll-contain">
                      {selectedUnpaidDraft.allocations.map((allocation, index) => {
                        const entry = timeEntryById.get(allocation.time_entry_id);
                        return (
                          <div
                            key={`${allocation.time_entry_id}:${index}`}
                            className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-start gap-3 border-b border-zinc-100 px-3 py-2.5 last:border-b-0"
                          >
                            <div className="min-w-0">
                              <p className="text-[11px] font-medium text-zinc-800">{entry ? fmtTrackedDate(entry.start_time) : 'Tracked session'}</p>
                              <p className="mt-0.5 truncate text-[11px] text-zinc-500" title={entry?.description || undefined}>
                                {entry?.description || 'No description'}
                              </p>
                            </div>
                            <p className="whitespace-nowrap text-[11px] tabular-nums text-zinc-600">{formatHours(allocation.allocated_hours)} hrs</p>
                            <p className="whitespace-nowrap text-[11px] font-medium tabular-nums text-zinc-900">${formatCurrency(allocation.allocated_amount)}</p>
                            <button
                              type="button"
                              onClick={() => setExcludedTimeEntryIds(previous => {
                                const next = new Set(previous);
                                next.add(allocation.time_entry_id);
                                return next;
                              })}
                              aria-label={`Remove ${entry?.description || 'tracked session'} from invoice`}
                              title="Remove from invoice"
                              className="-m-1 rounded p-1 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                            >
                              <X size={13} aria-hidden="true" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={closeUnpaidPicker}
                  className="rounded-md px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={commitUnpaidPicker}
                  disabled={!pickerSelectionIsValid}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus size={11} strokeWidth={2.5} aria-hidden="true" />
                  Add to invoice
                </button>
              </div>
            </div>
          </div>
        )}
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
    <>
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
        <div className="px-5 py-3 border-b border-zinc-100 bg-zinc-50/50 flex-shrink-0 overflow-x-auto">
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
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-semibold text-zinc-900">${Math.round(hourlyRate)}</p>
                    <button
                      onClick={() => setEditingRate(open => !open)}
                      className="p-0.5 text-zinc-400 hover:text-brand-600 transition-colors"
                      aria-label="Manage hourly rate schedule"
                    >
                      <Clock size={12} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          {isHourly && editingRate ? (
            <HourlyRateSchedule
              projectId={projectId}
              fallbackRate={hourlyRate}
              today={todayLocalDate}
              timezone={currentMember?.timezone && currentMember.timezone !== 'UTC' ? currentMember.timezone : undefined}
              isDemoMode={isDemoMode}
              onCurrentRateChange={rate => updateProject(projectId, { hourly_rate: rate })}
            />
          ) : null}
        </div>

        {/* Invoice list */}
        {invoices.length > 0 ? (
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {invoices.sort((a, b) => b.date.localeCompare(a.date)).map(invoice => {
              const items = ensureLineItems(invoice);
              const hasMultipleLines = items.length > 1;
              const singleItemType = items[0]?.item_type;
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
                              onChange={v => { void updateInvoice(invoice.id, { status: v as InvoiceStatus }); }}
                              options={INVOICE_STATUSES.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
                            />
                          </div>
                        </div>
                        <span className="text-sm font-semibold text-zinc-900">{invoice.invoice_number}</span>
                        {hasMultipleLines ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-zinc-100 text-zinc-500">
                            {items.length} items
                          </span>
                        ) : singleItemType && singleItemType !== 'hourly' && (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-zinc-100 text-zinc-500 capitalize">
                            {singleItemType}
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
                            onClick={e => { e.stopPropagation(); setPreviewInvoiceId(invoice.id); }}
                            aria-label="Preview invoice PDF"
                            className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                          >
                            <Eye size={13} />
                          </button>
                          {canEmailInvoices ? (
                            <button
                              onClick={e => { e.stopPropagation(); openInvoiceEmailPreview(invoice.id); }}
                              aria-label="Email invoice"
                              className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                            >
                              <Send size={13} />
                            </button>
                          ) : null}
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
                                        {lineItemTypeLabel(li.item_type)}
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
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
              <Receipt size={18} className="text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-500">No invoices yet</p>
            <p className="text-xs text-zinc-400 mt-1">Create invoices to track billing for this project</p>
          </div>
        )}
      </div>
      </div>

      <Modal
        isOpen={isAdding || Boolean(editingId)}
        onClose={handleCancel}
        title={editingId ? `Edit invoice ${formNumber}` : 'Create invoice'}
        size="6xl"
      >
        <div className="mx-auto w-full max-w-6xl pb-1">
          {renderForm(editingId ? 'edit' : 'add')}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDelete}
        title="Delete Invoice"
        message="Are you sure you want to delete this invoice? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />

      <InvoicePreviewModal
        invoiceId={previewInvoiceId}
        onClose={() => setPreviewInvoiceId(null)}
      />

      <ClientEmailPreviewModal
        open={Boolean(emailInvoiceId)}
        onClose={() => setEmailInvoiceId(null)}
        projectId={projectId}
        manual={emailManual}
        onCompleted={() => setEmailInvoiceId(null)}
      />
    </>
  );
}
