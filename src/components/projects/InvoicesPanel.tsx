'use client';
import { FileInput } from '@/components/ui/inputs/FileInput';

import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Receipt,
  Plus,
  Edit2,
  Trash2,
  FileDown,
  X,
  Upload,
  File,
  Loader2,
  ChevronDown,
  Copy,
  Clock,
  Eye,
  AlertTriangle,
  ListChecks,
  Send,
  Repeat,
  CalendarClock,
  CircleCheck,
  Wallet,
} from 'lucide-react';
import { InvoicePreviewModal } from '@/components/projects/InvoicePreviewModal';
import ClientEmailPreviewModal from '@/components/projects/ClientEmailPreviewModal';
import BillingModal, { type BillingTab } from '@/components/projects/billing/BillingModal';
import { InvoiceLineSplit, type LineSplit } from '@/components/projects/InvoiceLineSplit';
import { InvoicePayments, formatMoney } from '@/components/projects/InvoicePayments';
import { invoiceOutstanding, invoicePaidTotal, invoiceTotal, isPartiallyPaid } from '@/lib/invoice-payments';
import { KpiRow, KpiTile } from '@/components/ui/KpiTile';
import { Bone, CardAction, EmptyCard, NoMatches, RailCard, RailLayout, Skeleton, SubNav, TabToolbar, ToolbarButton } from '@/components/projects/TabLayout';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { Button } from '@/components/ui/Button';
import { computeInvoiceSummary } from '@/lib/invoice-summary';
import {
  fetchBillingForecast,
  fetchProjectInvoicePayments,
  fetchBillingRuns,
  fetchInvoiceLineShares,
  fetchRetainerDuePeriods,
  setInvoiceLineShares,
} from '@/lib/supabase/queries';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import Modal from '@/components/ui/Modal';
import { useDemo } from '@/lib/demo-context';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toLocalDateKey, toLocalDateString } from '@/lib/date-utils';
import {
  INVOICE_STATUSES,
  INVOICE_LINE_ITEM_TYPES,
  RECURRENCE_FREQUENCIES,
  type InvoiceStatus,
  type InvoiceLineItemType,
  type InvoiceLineItem,
  type RecurrenceFrequency,
  type InvoiceTimeEntryAllocation,
  type RetainerDuePeriod,
  type BillingForecastItem,
} from '@/lib/types';
import { HourlyRateSchedule } from './HourlyRateSchedule';
import {
  ensureLineItems,
  lineItemsTotal,
  dominantInvoiceType,
  newLineItemId,
  suggestServiceEnd,
  buildUnpaidHoursLineItem,
  buildPartialUnpaidHoursLineItem,
  buildPartialUnpaidHoursLineItemByAmount,
  heldRangesFromInvoices,
  billedHourlyPool,
  formatUnpaidHoursDescription,
  type UnpaidHoursLineItemDraft,
} from '@/lib/invoice-utils';

interface InvoicesPanelProps {
  projectId: string;
  projectColor?: string;
}

const statusColors: Record<string, string> = {
  draft: 'bg-white/[0.06] text-zinc-300',
  sent: 'bg-blue-500/15 text-blue-300',
  paid: 'bg-emerald-500/15 text-emerald-300',
  overdue: 'bg-red-500/15 text-red-300',
  cancelled: 'bg-white/[0.06] text-zinc-500',
};

function formatCurrency(value: number): string {
  return value % 1 === 0
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const allocations = draft.allocations.filter(
    (allocation) => !excludedIds.has(allocation.time_entry_id),
  );
  if (allocations.length === 0) return null;
  const entries = allocations
    .map((allocation) => entryById.get(allocation.time_entry_id))
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
function fmtRetainerMonth(dateStr: string): string {
  const [year, month] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

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
    addInvoice,
    updateInvoice,
    deleteInvoice,
    recordInvoicePayment,
    removeInvoicePayment,
    getInvoicesByProject,
    getProject,
    updateProject,
    getTimeEntriesByProject,
    getPrimaryClient,
    team,
  } = useApp();
  const { teamMemberId, access } = useAuth();
  const { isDemoMode } = useDemo();
  const currentMember = team.find((m) => m.id === teamMemberId);
  const preferredTimezone =
    currentMember?.timezone && currentMember.timezone !== 'UTC'
      ? currentMember.timezone
      : undefined;
  // YYYY-MM-DD for "today" in the user's preferred zone. If the stored zone is
  // still the unset default, fall back to the browser's local day.
  const todayLocalDate = toLocalDateString(preferredTimezone);
  const invoices = getInvoicesByProject(projectId);
  const project = getProject(projectId);
  const primaryClient = getPrimaryClient(projectId);
  const hasPrimaryClientEmail = !!primaryClient?.contact?.email;
  const canEmailInvoices =
    hasPermission(access, 'communications.manage') && hasPermission(access, 'invoices.manage');
  const canManageInvoices = hasPermission(access, 'invoices.manage');
  const canRecordPayments = canManageInvoices || hasPermission(access, 'invoices.record_payments');
  // Splits are compensation: invoices.manage alone never sees or sends them.
  const canManageSplits = canManageInvoices && hasPermission(access, 'compensation.manage');

  // UI state
  const [isAdding, setIsAdding] = useState(false);
  const [billingTab, setBillingTab] = useState<BillingTab | null>(null);
  const retainerClient = useMemo(() => createClient(), []);
  // The next invoice that drafts itself, and what each auto draft left out
  // (time awaiting approval), for the panel's "Next draft" line and draft cards.
  const [upcomingDrafts, setUpcomingDrafts] = useState<BillingForecastItem[]>([]);
  // False until the first forecast answers, so the card never says "nothing" while it loads.
  const [upcomingLoaded, setUpcomingLoaded] = useState(false);
  // Which invoices the table shows: all, unpaid (sent or overdue), drafts, paid.
  const [invoiceFilter, setInvoiceFilter] = useState<'all' | 'open' | 'draft' | 'paid'>('all');
  const [invoiceQuery, setInvoiceQuery] = useState('');
  const [leftOutByInvoice, setLeftOutByInvoice] = useState<Map<string, number>>(new Map());
  // Retainer periods that are due (or were skipped) and can be added as ready lines.
  const [dueRetainerPeriods, setDueRetainerPeriods] = useState<RetainerDuePeriod[]>([]);
  // Revenue splits per line. Only lines touched in this form are written on
  // save, so a split inherited from a retainer is never wiped by accident.
  const [formLineShares, setFormLineShares] = useState<Record<string, LineSplit[]>>({});
  const touchedShareLinesRef = useRef<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [previewInvoiceId, setPreviewInvoiceId] = useState<string | null>(null);
  const [emailInvoiceId, setEmailInvoiceId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const emailManual = useMemo(
    () =>
      emailInvoiceId
        ? { type: 'invoice' as const, context: { invoiceId: emailInvoiceId } }
        : undefined,
    [emailInvoiceId],
  );

  // Unpaid-hours partial picker ; lets the user invoice less than the full
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
    setExpandedIds((prev) => {
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
  // invoice's due/issue date ; used to cascade updates if those dates change
  // later. A user editing a service date removes that line item from the set.
  const autoSeededRef = useRef<Set<string>>(new Set());

  // Calculate hours from time entries
  const timeEntries = getTimeEntriesByProject(projectId);
  const {
    isHourly,
    hourlyRate,
    finalizedHourEntries,
    totalHours,
    hasBudget,
    budgetType,
    budgetValue,
    totalInvoiced,
    taxRate,
    totalPaid,
    billableTotal,
    outstanding,
    budgetUsed,
    budgetPct,
  } = computeInvoiceSummary(project, invoices, timeEntries);

  // Type options: non-hourly projects can't create hourly line items.
  const typeOptions = isHourly
    ? INVOICE_LINE_ITEM_TYPES.map((t) => ({ value: t, label: lineItemTypeLabel(t) }))
    : INVOICE_LINE_ITEM_TYPES.filter((t) => t !== 'hourly').map((t) => ({
        value: t,
        label: lineItemTypeLabel(t),
      }));
  const defaultType: InvoiceLineItemType = isHourly ? 'hourly' : 'fixed';

  // Roll up unbilled hours into a draft hourly line item. Computed from
  // finalized entries vs. the FIFO pool of dollars covered by paid hourly line
  // items, minus the hours other draft, sent or overdue invoices already hold
  // (heldHours). So a draft reserves its time: the next "Add tracked time"
  // never offers it again, and the scheduled drafting in SQL
  // (invoice_unbilled_slices) reaches the same answer. Hoisted out of the
  // original IIFE so the partial-amount picker can re-walk FIFO at commit
  // time to find the right end-date cutoff for less-than-full invoices.
  // Paid hourly dollars plus live hourly lines with no sessions behind them
  // (typed over by hand): both are billed, so FIFO starts after them.
  const paidHourlyPool = isHourly
    ? billedHourlyPool(
        editingId ? invoices.filter((invoice) => invoice.id !== editingId) : invoices,
      )
    : 0;
  const heldHours = heldRangesFromInvoices(invoices, editingId);
  const allUnpaidHoursDraft = isHourly
    ? buildUnpaidHoursLineItem(finalizedHourEntries, paidHourlyPool, hourlyRate, undefined, heldHours)
    : null;
  const customPeriodIsValid =
    unpaidPeriodMode === 'all' ||
    (Boolean(unpaidPeriodStart) &&
      Boolean(unpaidPeriodEnd) &&
      unpaidPeriodStart <= unpaidPeriodEnd);
  const periodEligibleEntryIds = new Set(
    finalizedHourEntries
      .filter((entry) => {
        if (unpaidPeriodMode === 'all') return true;
        if (!customPeriodIsValid) return false;
        const dateKey = toLocalDateKey(entry.start_time, preferredTimezone);
        return dateKey >= unpaidPeriodStart && dateKey <= unpaidPeriodEnd;
      })
      .map((entry) => entry.id),
  );
  const unpaidHoursDraft = isHourly
    ? buildUnpaidHoursLineItem(
        finalizedHourEntries,
        paidHourlyPool,
        hourlyRate,
        periodEligibleEntryIds,
        heldHours,
      )
    : null;
  const parsedPickerAmount = parseFloat(unpaidPickerAmount);
  const parsedPickerHours = parseFloat(unpaidPickerHours);
  const baseSelectedUnpaidDraft =
    unpaidPickerMode === 'amount'
      ? Number.isFinite(parsedPickerAmount) && parsedPickerAmount > 0
        ? buildPartialUnpaidHoursLineItemByAmount(
            finalizedHourEntries,
            paidHourlyPool,
            hourlyRate,
            parsedPickerAmount,
            periodEligibleEntryIds,
            heldHours,
          )
        : null
      : Number.isFinite(parsedPickerHours) && parsedPickerHours > 0
        ? buildPartialUnpaidHoursLineItem(
            finalizedHourEntries,
            paidHourlyPool,
            hourlyRate,
            parsedPickerHours,
            periodEligibleEntryIds,
            heldHours,
          )
        : null;
  const timeEntryById = new Map(finalizedHourEntries.map((entry) => [entry.id, entry] as const));
  const selectedUnpaidDraft = removeExcludedAllocations(
    baseSelectedUnpaidDraft,
    excludedTimeEntryIds,
    timeEntryById,
  );
  const selectedSessionIds = new Set(
    selectedUnpaidDraft?.allocations.map((allocation) => allocation.time_entry_id) ?? [],
  );
  const conflictingInvoiceNumbers = [
    ...new Set(
      invoices
        .filter(
          (invoice) =>
            invoice.id !== editingId &&
            (invoice.status === 'draft' ||
              invoice.status === 'sent' ||
              invoice.status === 'overdue'),
        )
        .filter((invoice) =>
          (invoice.time_allocations ?? []).some((allocation) =>
            selectedSessionIds.has(allocation.time_entry_id),
          ),
        )
        .map((invoice) => invoice.invoice_number),
    ),
  ];
  const lastSelectedAllocation = selectedUnpaidDraft?.allocations.at(-1) ?? null;
  const lastSelectedEntry = lastSelectedAllocation
    ? timeEntryById.get(lastSelectedAllocation.time_entry_id)
    : null;
  const lastSessionIsPartial = Boolean(
    lastSelectedAllocation &&
      lastSelectedEntry &&
      (lastSelectedAllocation.start_offset_hours > 0.000001 ||
        lastSelectedAllocation.start_offset_hours + lastSelectedAllocation.allocated_hours <
          lastSelectedEntry.hours - 0.000001),
  );
  const pickerExceedsAvailable =
    unpaidPickerMode === 'amount'
      ? Number.isFinite(parsedPickerAmount) &&
        parsedPickerAmount > (unpaidHoursDraft?.amount ?? 0) + 0.005
      : Number.isFinite(parsedPickerHours) &&
        parsedPickerHours > (unpaidHoursDraft?.hours ?? 0) + 0.000001;
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
    setFormLineShares({});
    touchedShareLinesRef.current.clear();
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

  const formOpen = isAdding || Boolean(editingId);

  // The next self-drafting invoice and each auto draft's left-out time. Reads
  // need invoices.read; refreshed when invoices change or Billing closes.
  const canReadInvoices = hasPermission(access, 'invoices.read');
  const invoiceSignature = invoices.map((invoice) => `${invoice.id}:${invoice.status}`).join(',');

  // Which API key recorded each API payment (keys are not readable directly).
  const [keyNames, setKeyNames] = useState<Map<string, string | null>>(new Map());
  const apiPaymentSignature = invoices
    .flatMap((invoice) => (invoice.payments ?? []).filter((payment) => payment.recorded_via === 'api').map((payment) => payment.id))
    .join(',');
  useEffect(() => {
    if (isDemoMode || !apiPaymentSignature) return;
    let cancelled = false;
    fetchProjectInvoicePayments(retainerClient, projectId)
      .then((rows) => {
        if (!cancelled) setKeyNames(new Map(rows.map((row) => [row.id, row.api_key_name ?? null])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiPaymentSignature, isDemoMode, projectId, retainerClient]);
  useEffect(() => {
    if (!canReadInvoices || isDemoMode || billingTab !== null) return;
    let cancelled = false;
    const until = new Date(`${todayLocalDate}T12:00:00`);
    until.setDate(until.getDate() + 62);
    Promise.all([
      fetchBillingForecast(retainerClient, projectId, { until: until.toISOString().slice(0, 10) }),
      fetchBillingRuns(retainerClient, projectId, 40),
    ])
      .then(([forecast, runs]) => {
        if (cancelled) return;
        setUpcomingDrafts(forecast.filter((item) => item.status === 'upcoming').slice(0, 3));
        setUpcomingLoaded(true);
        setLeftOutByInvoice(new Map(runs
          .filter((run) => run.invoice_id && run.pending_hours > 0)
          .map((run) => [run.invoice_id as string, run.pending_hours])));
      })
      // Before the billing migration is applied the reads fail: show nothing.
      .catch(() => { if (!cancelled) { setUpcomingDrafts([]); setLeftOutByInvoice(new Map()); setUpcomingLoaded(true); } });
    return () => { cancelled = true; };
  }, [billingTab, canReadInvoices, invoiceSignature, isDemoMode, projectId, retainerClient, todayLocalDate]);

  useEffect(() => {
    if (!formOpen || !canManageInvoices || isDemoMode) return;
    let cancelled = false;
    fetchRetainerDuePeriods(retainerClient, projectId)
      .then((periods) => { if (!cancelled) setDueRetainerPeriods(periods); })
      .catch(() => { if (!cancelled) setDueRetainerPeriods([]); });
    return () => { cancelled = true; };
  }, [formOpen, canManageInvoices, isDemoMode, projectId, retainerClient]);

  useEffect(() => {
    if (!editingId || !canManageSplits || isDemoMode) return;
    let cancelled = false;
    fetchInvoiceLineShares(retainerClient, editingId)
      .then((rows) => {
        if (cancelled) return;
        const grouped: Record<string, LineSplit[]> = {};
        for (const row of rows) {
          (grouped[row.line_item_id] ??= []).push({ member_id: row.member_id, percent: row.percent });
        }
        setFormLineShares(grouped);
      })
      .catch(() => toast('error', 'Failed to load the revenue split'));
    return () => { cancelled = true; };
  }, [editingId, canManageSplits, isDemoMode, retainerClient]);

  const splitMembers = useMemo(
    () => team.filter((member) => member.role !== 'owner' && member.role !== 'agent'),
    [team],
  );

  const offeredRetainerPeriods = dueRetainerPeriods.filter(
    (period) =>
      !formLineItems.some(
        (li) =>
          li.retainer_id === period.retainer_id &&
          li.service_start_date?.slice(0, 7) === period.period_start.slice(0, 7),
      ),
  );

  const insertRetainerLine = (period: RetainerDuePeriod) => {
    const id = newLineItemId();
    setFormLineItems((items) => {
      const onlyBlank =
        items.length === 1 && !(Number(items[0].amount) > 0) && !items[0].description.trim();
      const base = onlyBlank ? [] : items;
      return [
        ...base,
        {
          id,
          position: base.length,
          item_type: 'recurring',
          amount: period.amount,
          description: period.description,
          service_start_date: period.period_start,
          service_end_date: period.period_end,
          recurrence_frequency: 'monthly',
          retainer_id: period.retainer_id,
        },
      ];
    });
    setAmountDrafts((drafts) => ({ ...drafts, [id]: String(period.amount) }));
  };

  // Written after the invoice itself: the save RPC needs invoices.manage, the
  // split needs compensation.manage, and the line JSON must never carry it.
  const persistLineShares = async (invoiceId: string, items: InvoiceLineItem[]) => {
    const touched = touchedShareLinesRef.current;
    if (!canManageSplits || isDemoMode || touched.size === 0) return;
    try {
      const splittable = new Set(
        items.filter((li) => li.item_type === 'fixed' || li.item_type === 'recurring').map((li) => li.id),
      );
      const existing = await fetchInvoiceLineShares(retainerClient, invoiceId);
      const next = existing
        .filter((row) => splittable.has(row.line_item_id) && !touched.has(row.line_item_id))
        .map((row) => ({ line_item_id: row.line_item_id, member_id: row.member_id, percent: row.percent }));
      for (const lineId of touched) {
        if (!splittable.has(lineId)) continue;
        for (const row of formLineShares[lineId] ?? []) {
          if (row.member_id && row.percent > 0) next.push({ line_item_id: lineId, ...row });
        }
      }
      await setInvoiceLineShares(retainerClient, invoiceId, next);
    } catch (error) {
      const message = (error as { message?: string } | null)?.message;
      toast('error', message && message.length < 140 ? message : 'Invoice saved, but the split could not be saved');
    }
  };

  // Line item mutators
  const addLineItem = () => {
    setFormLineItems((items) => {
      const fresh = makeLineItem(defaultType, items.length);
      setAmountDrafts((d) => ({ ...d, [fresh.id]: '' }));
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
    const mappedLineItemIds = new Set(
      formTimeAllocations.map((allocation) => allocation.line_item_id),
    );
    setFormLineItems((items) => {
      const filtered = items.filter((li) => !mappedLineItemIds.has(li.id));
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
      setAmountDrafts((d) => ({ ...d, [fresh.id]: String(amount) }));
      // If the form started with the default empty placeholder line, drop it.
      const trimmed = filtered.filter(
        (li) =>
          !(
            li.amount === 0 &&
            li.description === '' &&
            li.item_type === defaultType &&
            filtered.length === 1
          ),
      );
      return [...trimmed, fresh].map((li, i) => ({ ...li, position: i }));
    });
    setFormTimeAllocations((previous) => [
      ...previous.filter((allocation) => !mappedLineItemIds.has(allocation.line_item_id)),
      ...allocations.map((allocation) => ({ ...allocation, line_item_id: lineItemId })),
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
      heldHours,
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
      heldHours,
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

  // Final commit ; runs the FIFO walk against unpaid entries so the line
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
    setFormTimeAllocations((previous) =>
      previous.filter((allocation) => allocation.line_item_id !== id),
    );
    setAmountDrafts((d) => {
      const { [id]: _drop, ...rest } = d;
      return rest;
    });
    setFormLineItems((items) => {
      const next = items.filter((li) => li.id !== id).map((li, i) => ({ ...li, position: i }));
      if (next.length === 0) {
        const fresh = makeLineItem(defaultType, 0);
        setAmountDrafts((d) => ({ ...d, [fresh.id]: '' }));
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
    setFormTimeAllocations((previous) =>
      previous.filter((allocation) => allocation.line_item_id !== id),
    );
    setAmountDrafts((d) => ({ ...d, [id]: raw }));
    const parsed = parseFloat(raw);
    setFormLineItems((items) =>
      items.map((li) => {
        if (li.id !== id) return li;
        if (raw.trim() === '') return { ...li, amount: 0 };
        return Number.isFinite(parsed) ? { ...li, amount: parsed } : li;
      }),
    );
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
      setFormTimeAllocations((previous) =>
        previous.filter((allocation) => allocation.line_item_id !== id),
      );
    }
    setFormLineItems((items) =>
      items.map((li) => {
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
        if (
          next.item_type === 'recurring' &&
          next.service_start_date &&
          next.recurrence_frequency &&
          !next.service_end_date
        ) {
          next.service_end_date = suggestServiceEnd(
            next.service_start_date,
            next.recurrence_frequency,
          );
        }
        return next;
      }),
    );
  };

  // Cascade due/invoice date changes into auto-seeded recurring line items.
  useEffect(() => {
    const seed = formDueDate || formDate;
    if (!seed) return;
    if (autoSeededRef.current.size === 0) return;
    setFormLineItems((items) =>
      items.map((li) => {
        if (li.item_type !== 'recurring') return li;
        if (!autoSeededRef.current.has(li.id)) return li;
        const freq = li.recurrence_frequency || 'monthly';
        return {
          ...li,
          service_start_date: seed,
          service_end_date: suggestServiceEnd(seed, freq),
        };
      }),
    );
  }, [formDueDate, formDate]);

  const handleFileUpload = async (
    file: File,
  ): Promise<{
    file_url: string;
    file_name: string;
    file_size: number;
    mime_type: string;
  } | null> => {
    const supabase = createClient();
    const path = `invoices/${projectId}/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from('entity-files').upload(path, file);
    if (error) {
      toast('error', 'Failed to upload file');
      return null;
    }
    const {
      data: { publicUrl },
    } = supabase.storage.from('entity-files').getPublicUrl(path);
    return {
      file_url: publicUrl,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type,
    };
  };

  const validLineItems = (items: InvoiceLineItem[]) =>
    items.filter((li) => (Number(li.amount) || 0) > 0 || li.description.trim().length > 0);

  const formTotal = lineItemsTotal(formLineItems);

  const canSave = () => {
    if (!formNumber.trim()) return false;
    if (formStatus === 'paid' && !formPaidDate) return false;
    const items = validLineItems(formLineItems);
    if (items.length === 0) return false;
    for (const li of items) {
      if ((Number(li.amount) || 0) < 0) return false;
      if (
        li.service_start_date &&
        li.service_end_date &&
        li.service_start_date > li.service_end_date
      )
        return false;
    }
    return true;
  };

  const handleAdd = async () => {
    if (!canSave()) return;
    setSaving(true);

    try {
      let fileData: {
        file_url: string;
        file_name: string;
        file_size: number;
        mime_type: string;
      } | null = null;
      if (formFile) {
        fileData = await handleFileUpload(formFile);
        if (!fileData) {
          setSaving(false);
          return;
        }
      }

      const items = validLineItems(formLineItems).map((li, i) => ({
        ...li,
        position: i,
        amount: Number(li.amount) || 0,
      }));
      const validIds = new Set(items.map((item) => item.id));

      const created = await addInvoice({
        project_id: projectId,
        invoice_number: formNumber.trim(),
        amount: lineItemsTotal(items),
        status: formStatus,
        invoice_type: dominantInvoiceType(items),
        line_items: items,
        time_allocations: formTimeAllocations.filter(
          (allocation) =>
            validIds.has(allocation.line_item_id) && isMeaningfulTimeAllocation(allocation),
        ),
        date: formDate,
        due_date: formDueDate || null,
        paid_date: formStatus === 'paid' ? formPaidDate || null : null,
        description: formDescription.trim(),
        file_url: fileData?.file_url ?? null,
        file_name: fileData?.file_name ?? null,
        file_size: fileData?.file_size ?? null,
        mime_type: fileData?.mime_type ?? null,
        created_by: teamMemberId,
      });
      if (!created) return;
      await persistLineShares(created.id, items);

      resetForm();
      setIsAdding(false);
      toast('success', 'Invoice created');
    } finally {
      setSaving(false);
    }
  };

  const startDuplicating = (invoice: (typeof invoices)[number]) => {
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
    setAmountDrafts(
      Object.fromEntries(cloned.map((li) => [li.id, li.amount === 0 ? '' : String(li.amount)])),
    );
    setIsAdding(true);
  };

  const startEditing = (invoice: (typeof invoices)[number]) => {
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
    setAmountDrafts(
      Object.fromEntries(loaded.map((li) => [li.id, li.amount === 0 ? '' : String(li.amount)])),
    );
    setFormFile(null);
    setExistingFileUrl(invoice.file_url);
    setExistingFileName(invoice.file_name);
    // Clear stale auto-seed tracking from any prior edit ; the IDs from a
    // different invoice must not leak into the cascade effect.
    autoSeededRef.current.clear();
  };

  const handleSaveEdit = async () => {
    if (!editingId || !canSave()) return;
    setSaving(true);

    try {
      let fileData: {
        file_url: string;
        file_name: string;
        file_size: number;
        mime_type: string;
      } | null = null;
      if (formFile) {
        fileData = await handleFileUpload(formFile);
        if (!fileData) {
          setSaving(false);
          return;
        }
      }

      const items = validLineItems(formLineItems).map((li, i) => ({
        ...li,
        position: i,
        amount: Number(li.amount) || 0,
      }));
      const validIds = new Set(items.map((item) => item.id));

      const updates: Record<string, unknown> = {
        invoice_number: formNumber.trim(),
        amount: lineItemsTotal(items),
        status: formStatus,
        invoice_type: dominantInvoiceType(items),
        line_items: items,
        time_allocations: formTimeAllocations.filter(
          (allocation) =>
            validIds.has(allocation.line_item_id) && isMeaningfulTimeAllocation(allocation),
        ),
        date: formDate,
        due_date: formDueDate || null,
        paid_date: formStatus === 'paid' ? formPaidDate || null : null,
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
      await persistLineShares(editingId, items);

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
    const allocations = formTimeAllocations.filter(
      (allocation) => allocation.line_item_id === lineItem.id,
    );
    const hours = allocations.reduce(
      (sum, allocation) => sum + Number(allocation.allocated_hours),
      0,
    );
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
    const linkedAllocations = formTimeAllocations.filter(
      (allocation) => allocation.line_item_id === li.id,
    );
    const isTrackedTimeLine = li.item_type === 'hourly' && linkedAllocations.length > 0;
    if (isTrackedTimeLine) {
      const linkedHours = linkedAllocations.reduce(
        (sum, allocation) => sum + Number(allocation.allocated_hours),
        0,
      );
      const linkedEntries = linkedAllocations
        .map((allocation) => timeEntryById.get(allocation.time_entry_id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
      const linkedPeriod =
        linkedEntries.length > 0
          ? `${fmtTrackedDate(linkedEntries[0].start_time)} – ${fmtTrackedDate(linkedEntries[linkedEntries.length - 1].start_time)}`
          : null;

      return (
        <div
          key={li.id}
          className="rounded-md border border-brand-500/30 bg-brand-500/15 p-3 space-y-3"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-brand-500/30 bg-surface-raised text-brand-300">
              <ListChecks size={14} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-xs font-semibold text-white">Tracked time</p>
                <p className="text-sm font-semibold tabular-nums text-white">
                  ${formatCurrency(li.amount)}
                </p>
              </div>
              <p className="mt-0.5 text-[11px] text-zinc-400">
                {formatHours(linkedHours)} hrs · {linkedAllocations.length}{' '}
                {linkedAllocations.length === 1 ? 'session' : 'sessions'}
                {linkedPeriod ? ` · ${linkedPeriod}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => removeLineItem(li.id)}
              className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-surface-raised hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
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
              onChange={(value) => patchLineItem(li.id, { description: value })}
              placeholder="Describe the work billed…"
              name={`invoice-description-${li.id}`}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => reviewTrackedLineItem(li)}
              className="inline-flex h-[30px] items-center justify-center gap-1.5 rounded-md border border-brand-500/30 bg-surface-raised px-3 text-xs font-medium text-brand-300 transition-colors hover:border-brand-500/30 hover:bg-brand-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Eye size={12} aria-hidden="true" />
              Review time
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        key={li.id}
        className="rounded-md border border-white/[0.08] bg-surface-raised p-2.5 space-y-2"
      >
        <div className="flex flex-wrap items-start gap-2">
          <div className="w-28 flex-shrink-0">
            <Select
              size="sm"
              value={li.item_type}
              onChange={(v) => patchLineItem(li.id, { item_type: v as InvoiceLineItemType })}
              options={typeOptions}
            />
          </div>
          <div className="w-28 flex-shrink-0">
            <TextInput
              size="sm"
              value={amountDrafts[li.id] ?? (li.amount === 0 ? '' : String(li.amount))}
              onChange={(v) => updateAmountDraft(li.id, v)}
              placeholder="0.00"
              prefix="$"
            />
          </div>
          <div className="basis-full sm:basis-0 sm:flex-1 min-w-0 order-last sm:order-none">
            <TextInput
              size="sm"
              value={li.description}
              onChange={(v) => patchLineItem(li.id, { description: v })}
              placeholder="Line description"
            />
          </div>
          <button
            type="button"
            onClick={() => removeLineItem(li.id)}
            disabled={!canDelete && formLineItems.length === 1}
            className="ml-auto sm:ml-0 p-1.5 text-zinc-500 hover:text-red-500 transition-colors rounded-md hover:bg-white/[0.03] disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Remove line item"
          >
            <X size={14} />
          </button>
        </div>
        {showServiceDates && (
          <div
            className={`grid gap-2 grid-cols-1 ${showFrequency ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}
          >
            {showFrequency && (
              <Select
                size="sm"
                label="Frequency"
                value={li.recurrence_frequency || 'monthly'}
                onChange={(v) =>
                  patchLineItem(li.id, { recurrence_frequency: v as RecurrenceFrequency })
                }
                options={RECURRENCE_FREQUENCIES.map((f) => ({
                  value: f,
                  label: f.charAt(0).toUpperCase() + f.slice(1),
                }))}
              />
            )}
            <DateInput
              label="Service Start"
              value={li.service_start_date || ''}
              onChange={(v) => patchLineItem(li.id, { service_start_date: v || null })}
              size="sm"
            />
            <DateInput
              label="Service End"
              value={li.service_end_date || ''}
              onChange={(v) => patchLineItem(li.id, { service_end_date: v || null })}
              size="sm"
            />
          </div>
        )}
        {canManageSplits && showServiceDates && (
          <InvoiceLineSplit
            lineAmount={Number(li.amount) || 0}
            splits={formLineShares[li.id]}
            inheritsOnSave={Boolean(li.retainer_id)}
            members={splitMembers}
            onChange={(splits) => {
              touchedShareLinesRef.current.add(li.id);
              setFormLineShares((current) => ({ ...current, [li.id]: splits }));
            }}
          />
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
          onChange={(v) => setFormStatus(v as InvoiceStatus)}
          options={INVOICE_STATUSES.map((s) => ({
            value: s,
            label: s.charAt(0).toUpperCase() + s.slice(1),
          }))}
          size="sm"
        />
      </div>

      <div className={`grid gap-2 grid-cols-2 ${formStatus === 'paid' ? 'sm:grid-cols-3' : ''}`}>
        <DateInput label="Invoice Date" value={formDate} onChange={setFormDate} size="sm" />
        <DateInput label="Due Date" value={formDueDate} onChange={setFormDueDate} size="sm" />
        {formStatus === 'paid' && (
          <DateInput label="Paid Date" value={formPaidDate} onChange={setFormPaidDate} size="sm" />
        )}
      </div>

      {/* Line items editor */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium text-input-text-label">Line Items</span>
          <span className="text-xs font-medium text-input-text-label">
            Total <span className="text-white">${formatCurrency(formTotal)}</span>
          </span>
        </div>
        <div className="space-y-2">
          {formLineItems.map((li) => renderLineItem(li, formLineItems.length > 1))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={addLineItem}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-300 hover:text-brand-300 transition-colors"
          >
            <Plus size={12} strokeWidth={2.5} />
            Add line
          </button>
          {allUnpaidHoursDraft && !unpaidPickerOpen && formTimeAllocations.length === 0 && (
            <button
              type="button"
              onClick={openUnpaidPicker}
              title={allUnpaidHoursDraft.description}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-300 hover:text-brand-300 transition-colors"
            >
              <Clock size={12} strokeWidth={2.5} />
              Add tracked time (${formatCurrency(allUnpaidHoursDraft.amount)})
            </button>
          )}
          {offeredRetainerPeriods.map((period) => (
            <button
              key={`${period.retainer_id}:${period.period_start}`}
              type="button"
              onClick={() => insertRetainerLine(period)}
              title={`${fmtServicePeriod(period.period_start, period.period_end) ?? ''}${period.skipped ? ' (skipped earlier)' : ''}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-300 hover:text-brand-300 transition-colors"
            >
              <Repeat size={12} strokeWidth={2.5} aria-hidden="true" />
              Add {period.retainer_name}, {fmtRetainerMonth(period.period_start)} (${formatCurrency(period.amount)})
            </button>
          ))}
        </div>

        {allUnpaidHoursDraft && unpaidPickerOpen && (
          <div className="mt-2 overflow-hidden rounded-lg border border-brand-500/30 bg-surface-raised shadow-sm">
            <div className="border-b border-brand-500/30 bg-brand-500/15 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-white">Add tracked time</p>
                  <p className="mt-0.5 text-[11px] text-zinc-400">
                    FIFO automatically selects the oldest outstanding time.
                  </p>
                </div>
                <p className="text-[11px] text-zinc-400">
                  Available{' '}
                  <span className="font-semibold tabular-nums text-white">
                    ${formatCurrency(unpaidHoursDraft?.amount ?? 0)}
                  </span>
                  <span className="text-zinc-500">
                    {' '}
                    · {formatHours(unpaidHoursDraft?.hours ?? 0)} hrs
                  </span>
                </p>
              </div>
            </div>

            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-zinc-300">Time period</span>
                <div className="seg-track seg-sm" role="group" aria-label="Tracked time period">
                  {(['all', 'custom'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPickerPeriodMode(mode)}
                      aria-pressed={unpaidPeriodMode === mode}
                      className={`seg-item ${unpaidPeriodMode === mode ? 'is-active' : ''}`}
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
                    onChange={(value) => {
                      setUnpaidPeriodStart(value);
                      setExcludedTimeEntryIds(new Set());
                    }}
                    size="sm"
                  />
                  <DateInput
                    label="Through"
                    value={unpaidPeriodEnd}
                    onChange={(value) => {
                      setUnpaidPeriodEnd(value);
                      setExcludedTimeEntryIds(new Set());
                    }}
                    size="sm"
                  />
                </div>
              )}

              {!customPeriodIsValid && (
                <p className="text-[11px] text-red-400" role="alert">
                  Choose a valid start and end date.
                </p>
              )}

              {customPeriodIsValid && !unpaidHoursDraft && (
                <p
                  className="rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11px] text-zinc-300"
                  role="status"
                >
                  No outstanding sessions start inside this period.
                </p>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-zinc-300">Invoice by</span>
                <div className="seg-track seg-sm" role="group" aria-label="Invoice tracked time by">
                  {(['amount', 'hours'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPickerMode(mode)}
                      aria-pressed={unpaidPickerMode === mode}
                      className={`seg-item ${unpaidPickerMode === mode ? 'is-active' : ''}`}
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
                <p className="text-[11px] text-red-400" role="alert">
                  {unpaidPickerMode === 'amount' ? 'Amount' : 'Hours'} exceeds the available
                  tracked-time balance.
                </p>
              )}

              {baseSelectedUnpaidDraft && (
                <div
                  className="rounded-md border border-white/[0.08] bg-white/[0.03]"
                  aria-live="polite"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                        Calculated selection
                      </p>
                      {selectedUnpaidDraft ? (
                        <>
                          <p className="mt-1 text-xs font-medium text-white">
                            {formatHours(selectedUnpaidDraft.hours)} hrs ·{' '}
                            {selectedUnpaidDraft.allocations.length}{' '}
                            {selectedUnpaidDraft.allocations.length === 1 ? 'session' : 'sessions'}
                          </p>
                          <p className="mt-0.5 text-[11px] text-zinc-400">
                            {fmtTrackedDate(selectedUnpaidDraft.startDate)} –{' '}
                            {fmtTrackedDate(selectedUnpaidDraft.endDate)}
                          </p>
                        </>
                      ) : (
                        <p className="mt-1 text-xs font-medium text-white">No sessions selected</p>
                      )}
                    </div>
                    <p className="text-sm font-semibold tabular-nums text-white">
                      ${formatCurrency(selectedUnpaidDraft?.amount ?? 0)}
                    </p>
                  </div>

                  {excludedTimeEntryIds.size > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.08] px-3 py-2 text-[11px] text-zinc-300">
                      <p>
                        {excludedTimeEntryIds.size}{' '}
                        {excludedTimeEntryIds.size === 1 ? 'session' : 'sessions'} excluded. The
                        total was reduced without adding replacement time.
                      </p>
                      <button
                        type="button"
                        onClick={() => setExcludedTimeEntryIds(new Set())}
                        className="font-medium text-brand-300 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        Reset to FIFO
                      </button>
                    </div>
                  )}

                  {lastSessionIsPartial && lastSelectedAllocation && lastSelectedEntry && (
                    <div className="border-t border-white/[0.08] px-3 py-2 text-[11px] text-zinc-300">
                      This invoice includes{' '}
                      <span className="font-medium text-white">
                        {formatHours(lastSelectedAllocation.allocated_hours)} hrs
                      </span>{' '}
                      from the final {formatHours(lastSelectedEntry.hours)}-hr session.
                    </div>
                  )}

                  {conflictingInvoiceNumbers.length > 0 && (
                    <div className="flex gap-2 border-t border-amber-500/30 bg-amber-500/15 px-3 py-2 text-[11px] text-amber-300">
                      <AlertTriangle
                        size={13}
                        className="mt-0.5 flex-shrink-0"
                        aria-hidden="true"
                      />
                      <p>
                        Some selected sessions are already attached to{' '}
                        {conflictingInvoiceNumbers.join(', ')}. Review before adding them again.
                      </p>
                    </div>
                  )}

                  {selectedUnpaidDraft && (
                    <button
                      type="button"
                      onClick={() => setUnpaidReviewOpen((open) => !open)}
                      aria-expanded={unpaidReviewOpen}
                      className="flex w-full items-center justify-between border-t border-white/[0.08] px-3 py-2 text-left text-[11px] font-medium text-brand-300 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                    >
                      <span>Review included time</span>
                      <ChevronDown
                        size={13}
                        className={`transition-transform ${unpaidReviewOpen ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                      />
                    </button>
                  )}

                  {unpaidReviewOpen && selectedUnpaidDraft && (
                    <div className="max-h-64 overflow-y-auto border-t border-white/[0.08] bg-surface-raised overscroll-contain">
                      {selectedUnpaidDraft.allocations.map((allocation, index) => {
                        const entry = timeEntryById.get(allocation.time_entry_id);
                        return (
                          <div
                            key={`${allocation.time_entry_id}:${index}`}
                            className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-start gap-3 border-b border-white/[0.06] px-3 py-2.5 last:border-b-0"
                          >
                            <div className="min-w-0">
                              <p className="text-[11px] font-medium text-zinc-100">
                                {entry ? fmtTrackedDate(entry.start_time) : 'Tracked session'}
                              </p>
                              <p
                                className="mt-0.5 truncate text-[11px] text-zinc-400"
                                title={entry?.description || undefined}
                              >
                                {entry?.description || 'No description'}
                              </p>
                            </div>
                            <p className="whitespace-nowrap text-[11px] tabular-nums text-zinc-300">
                              {formatHours(allocation.allocated_hours)} hrs
                            </p>
                            <p className="whitespace-nowrap text-[11px] font-medium tabular-nums text-white">
                              ${formatCurrency(allocation.allocated_amount)}
                            </p>
                            <button
                              type="button"
                              onClick={() =>
                                setExcludedTimeEntryIds((previous) => {
                                  const next = new Set(previous);
                                  next.add(allocation.time_entry_id);
                                  return next;
                                })
                              }
                              aria-label={`Remove ${entry?.description || 'tracked session'} from invoice`}
                              title="Remove from invoice"
                              className="-m-1 rounded p-1 text-zinc-500 transition-colors hover:bg-red-500/15 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
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
                <Button type="button" variant="ghost" size="sm" onClick={closeUnpaidPicker}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={commitUnpaidPicker}
                  disabled={!pickerSelectionIsValid}
                  icon={<Plus size={12} strokeWidth={2.5} aria-hidden="true" />}
                >
                  Add to invoice
                </Button>
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
        <FileInput
          ref={fileInputRef}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              setFormFile(file);
              setExistingFileUrl(null);
              setExistingFileName(null);
            }
          }}
        />
        {formFile ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg">
            <File size={14} className="text-zinc-500 flex-shrink-0" />
            <span className="text-sm text-zinc-300 truncate flex-1">{formFile.name}</span>
            <button
              onClick={() => setFormFile(null)}
              className="p-0.5 text-zinc-500 hover:text-red-500 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        ) : existingFileUrl ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg">
            <File size={14} className="text-zinc-500 flex-shrink-0" />
            <span className="text-sm text-zinc-300 truncate flex-1">
              {existingFileName || 'Attached file'}
            </span>
            <button
              onClick={() => {
                setExistingFileUrl(null);
                setExistingFileName(null);
              }}
              className="p-0.5 text-zinc-500 hover:text-red-500 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-300 border border-dashed border-white/[0.12] hover:border-zinc-400 rounded-lg transition-colors"
          >
            <Upload size={14} />
            Attach file
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end">
        <Button type="button" variant="ghost" onClick={handleCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={mode === 'add' ? handleAdd : handleSaveEdit}
          disabled={!canSave() || saving}
          icon={saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : undefined}
        >
          {mode === 'add' ? 'Save' : 'Update'}
        </Button>
      </div>
    </div>
  );

  // ── Tab layout ──
  const sortedInvoices = [...invoices].sort((a, b) => b.date.localeCompare(a.date));
  const isOpenInvoice = (status: InvoiceStatus) => status === 'sent' || status === 'overdue';
  const filterCounts = {
    all: invoices.length,
    open: invoices.filter((inv) => isOpenInvoice(inv.status)).length,
    draft: invoices.filter((inv) => inv.status === 'draft').length,
    paid: invoices.filter((inv) => inv.status === 'paid').length,
  };
  const invoiceNeedle = invoiceQuery.trim().toLowerCase();
  const visibleInvoices = sortedInvoices.filter((inv) =>
    (invoiceFilter === 'all'
      ? true
      : invoiceFilter === 'open'
        ? isOpenInvoice(inv.status)
        : inv.status === invoiceFilter) &&
    (!invoiceNeedle ||
      inv.invoice_number.toLowerCase().includes(invoiceNeedle) ||
      (inv.description || '').toLowerCase().includes(invoiceNeedle) ||
      ensureLineItems(inv).some((li) => (li.description || '').toLowerCase().includes(invoiceNeedle))),
  );
  const overdueTotal = invoices
    .filter((inv) => inv.status === 'overdue')
    .reduce((sum, inv) => sum + invoiceOutstanding(inv, taxRate), 0);
  const paidShare = totalInvoiced > 0 ? Math.round((totalPaid / totalInvoiced) * 100) : 0;
  const budgetTone =
    budgetPct >= 90 ? 'bg-red-400' : budgetPct >= 75 ? 'bg-amber-400' : 'bg-emerald-400';

  // Table columns, shared by the header and every row (container widths, so
  // the table only goes columnar when its own box is wide enough).
  const INVOICE_COLS =
    '@2xl:grid-cols-[84px_minmax(0,1fr)_64px_64px_64px_104px_60px]';

  const statusControl = (invoice: (typeof invoices)[number]) => (
    // The pill is the status menu: changing it is how an invoice is marked paid.
    <div
      className="relative inline-flex items-center"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span
        className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[invoice.status]}`}
      >
        {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
      </span>
      <div className="[&_button]:!bg-transparent [&_button]:!border-transparent [&_button]:!shadow-none [&_button]:!ring-0 [&_button]:!text-transparent [&_button]:!px-2 [&_button]:!py-0.5 [&_button]:!text-xs [&_svg]:!text-transparent [&_span]:!text-transparent">
        <Select
          size="sm"
          aria-label={`Status of ${invoice.invoice_number}`}
          value={invoice.status}
          onChange={(v) => {
            void updateInvoice(invoice.id, { status: v as InvoiceStatus });
          }}
          options={INVOICE_STATUSES.map((s) => ({
            value: s,
            label: s.charAt(0).toUpperCase() + s.slice(1),
          }))}
        />
      </div>
    </div>
  );

  const invoiceBadges = (invoice: (typeof invoices)[number]) => {
    const items = ensureLineItems(invoice);
    const leftOut = leftOutByInvoice.get(invoice.id);
    return (
      <>
        {isPartiallyPaid(invoice, taxRate) && (
          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/15 text-amber-300">
            Part paid ${formatMoney(invoicePaidTotal(invoice))} of ${formatMoney(invoiceTotal(invoice, taxRate))}
          </span>
        )}
        {invoice.auto_generated && invoice.status === 'draft' && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-brand-500/15 text-brand-300"
            title={leftOut
              ? `Drafted automatically. ${leftOut.toFixed(2)} h awaiting approval was left out and goes on the next draft. Review and send it.`
              : 'Drafted automatically (retainer or hours schedule). Review and send it.'}
          >
            <Repeat size={10} aria-hidden="true" />
            Auto draft{leftOut ? ` · ${leftOut.toFixed(1)} h waiting` : ''}
          </span>
        )}
        {items.length > 1 ? (
          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-white/[0.06] text-zinc-400">
            {items.length} items
          </span>
        ) : (
          items[0]?.item_type && items[0].item_type !== 'hourly' && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-white/[0.06] text-zinc-400 capitalize">
              {items[0].item_type}
            </span>
          )
        )}
      </>
    );
  };

  const invoiceActions = (invoice: (typeof invoices)[number]) => (
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <RowActionsMenu
        label={`Actions for ${invoice.invoice_number}`}
        actions={[
          { label: 'Preview PDF', icon: <Eye size={14} />, onClick: () => setPreviewInvoiceId(invoice.id) },
          ...(canEmailInvoices
            ? [{ label: 'Email to client', icon: <Send size={14} />, onClick: () => openInvoiceEmailPreview(invoice.id) }]
            : []),
          { label: 'Edit', icon: <Edit2 size={14} />, onClick: () => startEditing(invoice), divider: true },
          { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => startDuplicating(invoice) },
          { label: 'Delete', icon: <Trash2 size={14} />, onClick: () => setDeleteTarget(invoice.id), variant: 'danger' as const, divider: true },
        ]}
      />
    </div>
  );

  const renderInvoiceDetails = (invoice: (typeof invoices)[number]) => {
    const items = ensureLineItems(invoice);
    return (
      <div className="px-5 pb-5 pt-4 bg-white/[0.02] border-t border-white/[0.05] grid grid-cols-1 @2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6">
        <div className="min-w-0">
          {items.length > 0 && (
            <>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                {items.length > 1 ? 'Line items' : 'Line item'}
              </h4>
              <ul className="rounded-lg border border-white/[0.06] divide-y divide-white/[0.05]">
                {items.map((li) => {
                  const period = fmtServicePeriod(li.service_start_date, li.service_end_date);
                  return (
                    <li key={li.id} className="flex items-start justify-between gap-4 px-3 py-2.5">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-white/[0.06] text-zinc-300 capitalize">
                            {lineItemTypeLabel(li.item_type)}
                          </span>
                          {li.item_type === 'recurring' && li.recurrence_frequency && (
                            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/15 text-amber-300 capitalize">
                              {li.recurrence_frequency}
                            </span>
                          )}
                          {period && <span className="text-xs text-zinc-500">{period}</span>}
                        </div>
                        {li.description && <p className="text-sm text-zinc-300 break-words">{li.description}</p>}
                      </div>
                      <span className="text-sm font-medium tabular-nums text-white flex-shrink-0">
                        ${formatCurrency(li.amount)}
                      </span>
                    </li>
                  );
                })}
                {items.length > 1 && (
                  <li className="flex items-center justify-between px-3 py-2.5 bg-white/[0.02]">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Total</span>
                    <span className="text-sm font-semibold tabular-nums text-white">${formatCurrency(invoice.amount)}</span>
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <InvoicePayments
            invoice={invoice}
            taxRate={taxRate}
            keyNames={keyNames}
            canRecord={canRecordPayments}
            today={todayLocalDate}
            onRecord={(payment) => recordInvoicePayment(invoice.id, payment)}
            onRemove={(paymentId) => removeInvoicePayment(invoice.id, paymentId)}
          />
          {invoice.description && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Notes</h4>
              <p className="text-sm text-zinc-300 whitespace-pre-wrap break-words">{invoice.description}</p>
            </div>
          )}
          {invoice.file_url && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Attachment</h4>
              <a
                href={invoice.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-brand-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded"
              >
                <FileDown size={14} aria-hidden="true" />
                {invoice.file_name || 'Download'}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderInvoiceRow = (invoice: (typeof invoices)[number]) => {
    const isExpanded = expandedIds.has(invoice.id);
    const expandButton = (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          toggleExpanded(invoice.id);
        }}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Hide' : 'Show'} details for ${invoice.invoice_number}`}
        className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <ChevronDown size={16} className={`transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
    );
    const dueLabel = invoice.due_date && invoice.due_date !== invoice.date ? fmtDate(invoice.due_date) : null;
    return (
      <div key={invoice.id} className={isExpanded ? 'bg-white/[0.015]' : ''}>
        {/* Whole row toggles details for the mouse; the chevron is the keyboard control. */}
        <div onClick={() => toggleExpanded(invoice.id)} className="cursor-pointer hover:bg-white/[0.02] transition-colors">
          {/* Columns, when the table box is wide enough */}
          <div className={`hidden @2xl:grid ${INVOICE_COLS} gap-3 items-center px-5 py-3`}>
            <div>{statusControl(invoice)}</div>
            <div className="min-w-0">
              <span className="text-sm font-semibold text-white">{invoice.invoice_number}</span>
              {/* Badges get their own line so every number lines up. */}
              <div className="flex items-center gap-1.5 flex-wrap empty:hidden mt-1">{invoiceBadges(invoice)}</div>
            </div>
            <span className="text-sm text-zinc-400 tabular-nums">{fmtDate(invoice.date)}</span>
            <span className="text-sm text-zinc-400 tabular-nums">{dueLabel ?? <span className="text-zinc-600">-</span>}</span>
            <span className="text-sm tabular-nums text-emerald-400">
              {invoice.paid_date ? fmtDate(invoice.paid_date) : <span className="text-zinc-600">-</span>}
            </span>
            <span className="text-sm font-semibold tabular-nums text-white text-right">${formatCurrency(invoice.amount)}</span>
            <div className="flex items-center justify-end gap-0.5">
              {invoiceActions(invoice)}
              {expandButton}
            </div>
          </div>
          {/* Two-line card, when it is not */}
          <div className="@2xl:hidden px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              {statusControl(invoice)}
              <span className="text-sm font-semibold text-white">{invoice.invoice_number}</span>
              <span className="ml-auto text-sm font-semibold tabular-nums text-white">${formatCurrency(invoice.amount)}</span>
            </div>
            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-zinc-400">
              <span>Issued {fmtDate(invoice.date)}</span>
              {dueLabel && <span>Due {dueLabel}</span>}
              {invoice.paid_date && <span className="text-emerald-400">Paid {fmtDate(invoice.paid_date)}</span>}
              {invoiceBadges(invoice)}
              <span className="ml-auto flex items-center gap-0.5">
                {invoiceActions(invoice)}
                {expandButton}
              </span>
            </div>
          </div>
        </div>
        {isExpanded && renderInvoiceDetails(invoice)}
      </div>
    );
  };

  return (
    <>
      <TabToolbar
        search={invoices.length > 0 ? { value: invoiceQuery, onChange: setInvoiceQuery, placeholder: 'Search invoices' } : undefined}
        filters={
          invoices.length > 0 && (
            <SubNav
              label="Show invoices"
              active={invoiceFilter}
              onChange={setInvoiceFilter}
              items={[
                { key: 'all', label: 'All', count: filterCounts.all },
                { key: 'open', label: 'Unpaid', count: filterCounts.open },
                { key: 'draft', label: 'Drafts', count: filterCounts.draft },
                { key: 'paid', label: 'Paid', count: filterCounts.paid },
              ]}
            />
          )
        }
        actions={
          <ToolbarButton
            variant="secondary"
            icon={<CalendarClock />}
            label="Billing settings"
            onClick={() => setBillingTab('upcoming')}
            title="Retainers, scheduled hourly drafts, payment terms and what bills next"
          />
        }
        primary={<ToolbarButton icon={<Plus />} label="New invoice" onClick={openAddForm} />}
      />

      <KpiRow className={`mb-6 ${isHourly ? '' : 'lg:grid-cols-3'}`}>
        {isHourly && (
          <KpiTile
            label="Billable"
            value={`$${formatCurrency(Math.round(billableTotal))}`}
            icon={Clock}
            context={`${Math.round(totalHours)}h at $${Math.round(hourlyRate)}/hr`}
          />
        )}
        <KpiTile
          label="Invoiced"
          value={`$${formatCurrency(Math.round(totalInvoiced))}`}
          icon={Receipt}
          context={`${filterCounts.all - invoices.filter((inv) => inv.status === 'cancelled').length} invoices`}
        />
        <KpiTile
          label="Paid"
          value={`$${formatCurrency(Math.round(totalPaid))}`}
          icon={CircleCheck}
          tone="positive"
          context={totalInvoiced > 0 ? `${paidShare}% of invoiced` : 'Nothing invoiced yet'}
        />
        <KpiTile
          label="Outstanding"
          value={`$${formatCurrency(Math.round(outstanding))}`}
          icon={Wallet}
          tone={outstanding > 0 ? 'warning' : 'default'}
          context={
            overdueTotal > 0
              ? `$${formatCurrency(Math.round(overdueTotal))} overdue`
              : outstanding > 0
                ? isHourly ? 'Includes hours not yet invoiced' : 'To collect'
                : 'All settled'
          }
        />
      </KpiRow>

      <RailLayout
        rail={
          <>
            <RailCard
              title="Upcoming drafts"
              icon={<CalendarClock size={16} className="text-zinc-400" aria-hidden="true" />}
              action={
                <CardAction onClick={() => setBillingTab('upcoming')}>Manage</CardAction>
              }
            >
              {!upcomingLoaded && !isDemoMode ? (
                <Skeleton label="Loading upcoming drafts" className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="space-y-1.5">
                      <div className="flex justify-between gap-3">
                        <Bone className="h-3.5 w-12" />
                        <Bone className="h-3.5 w-16" />
                      </div>
                      <Bone className={`h-2.5 ${i % 2 ? 'w-1/2' : 'w-3/4'}`} />
                    </div>
                  ))}
                </Skeleton>
              ) : upcomingDrafts.length > 0 ? (
                <ul className="space-y-3">
                  {upcomingDrafts.map((draft) => (
                    <li key={`${draft.date}-${draft.sources}`} className="min-w-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium text-zinc-200">
                          {new Date(`${draft.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                        <span className="text-sm font-semibold tabular-nums text-white">
                          {draft.estimated > 0 ? '~' : ''}${formatCurrency(Math.round((draft.exact + draft.estimated) * 100) / 100)}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 truncate">
                        {draft.lines.map((line) => line.label).join(' + ')}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-zinc-500">
                  Nothing drafts itself yet. Set up a retainer or hours schedule in Billing settings.
                </p>
              )}
            </RailCard>

            {isHourly && (
              <RailCard
                title="Hourly rate"
                icon={<Clock size={16} className="text-zinc-400" aria-hidden="true" />}
                action={
                  <CardAction onClick={() => setEditingRate((open) => !open)} aria-expanded={editingRate}>
                    {editingRate ? 'Done' : 'Change'}
                  </CardAction>
                }
              >
                <p className="text-2xl font-bold tabular-nums text-white">
                  ${formatCurrency(hourlyRate)}
                  <span className="text-sm font-medium text-zinc-500">/hr</span>
                </p>
                {editingRate && (
                  <HourlyRateSchedule
                    projectId={projectId}
                    fallbackRate={hourlyRate}
                    today={todayLocalDate}
                    timezone={preferredTimezone}
                    isDemoMode={isDemoMode}
                    onCurrentRateChange={(rate) => updateProject(projectId, { hourly_rate: rate })}
                  />
                )}
              </RailCard>
            )}

            {hasBudget && (
              <RailCard title="Budget" icon={<Wallet size={16} className="text-zinc-400" aria-hidden="true" />}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-2xl font-bold tabular-nums text-white">{Math.round(budgetPct)}%</p>
                  <p className="text-xs text-zinc-500 tabular-nums">
                    {budgetType === 'hours'
                      ? `${formatCurrency(Math.round(budgetUsed))} of ${formatCurrency(budgetValue)} hrs`
                      : `$${formatCurrency(Math.round(budgetUsed))} of $${formatCurrency(budgetValue)}`}
                  </p>
                </div>
                <div
                  className="mt-3 h-1.5 rounded-full bg-white/[0.06] overflow-hidden"
                  role="progressbar"
                  aria-valuenow={Math.round(budgetPct)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Budget used"
                >
                  <div className={`h-full rounded-full ${budgetTone}`} style={{ width: `${budgetPct}%` }} />
                </div>
              </RailCard>
            )}
          </>
        }
      >
        {invoices.length > 0 ? (
          <section className="@container glass-card rounded-xl overflow-hidden" aria-label="Invoices">
            <div className={`hidden @2xl:grid ${INVOICE_COLS} gap-3 px-5 py-2.5 border-b border-white/[0.06] text-[11px] font-semibold uppercase tracking-wider text-zinc-400`}>
              <span>Status</span>
              <span>Invoice</span>
              <span>Issued</span>
              <span>Due</span>
              <span>Paid</span>
              <span className="text-right">Amount</span>
              <span className="sr-only">Actions</span>
            </div>
            {visibleInvoices.length > 0 ? (
              <div className="divide-y divide-white/[0.05]">{visibleInvoices.map(renderInvoiceRow)}</div>
            ) : (
              <NoMatches>No invoices in this view.</NoMatches>
            )}
          </section>
        ) : (
          <EmptyCard
            icon={<Receipt />}
            title="No invoices yet"
            description="Invoices you create or that draft themselves show up here. Use New invoice to create one."
          />
        )}
      </RailLayout>

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

      <InvoicePreviewModal invoiceId={previewInvoiceId} onClose={() => setPreviewInvoiceId(null)} />

      {billingTab !== null && <BillingModal
        isOpen
        initialTab={billingTab ?? 'upcoming'}
        onClose={() => setBillingTab(null)}
        projectId={projectId}
        invoices={invoices}
        team={team}
        today={todayLocalDate}
        canManage={canManageInvoices}
        canManageSplits={canManageSplits}
        isDemoMode={isDemoMode}
      />}

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
