'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import {
  fetchProjectRetainers,
  fetchRetainerDuePeriods,
  generateRetainerPeriod,
  removeProjectRetainer,
  removeRetainerAmount,
  saveProjectRetainer,
  scheduleRetainerAmount,
  setRetainerShares,
  type ProjectRetainerBundle,
} from '@/lib/supabase/queries';
import { ensureLineItems } from '@/lib/invoice-utils';
import type {
  ProjectInvoice,
  ProjectRetainer,
  RetainerBillingTiming,
  RetainerDuePeriod,
  TeamMember,
} from '@/lib/types';

interface RetainersModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  invoices: ProjectInvoice[];
  team: TeamMember[];
  today: string;
  canManage: boolean;
  /** compensation.manage: splits are neither shown nor sent without it. */
  canManageSplits: boolean;
  isDemoMode: boolean;
}

interface SplitRow {
  member_id: string;
  percent: number | '';
}

const EMPTY_BUNDLE: ProjectRetainerBundle = { retainers: [], amounts: [], periods: [], shares: [] };

const TIMING_OPTIONS: Array<{ value: RetainerBillingTiming; label: string; detail: string }> = [
  { value: 'advance', label: 'In advance', detail: 'Billed at the start of the month it covers' },
  { value: 'arrears', label: 'In arrears', detail: 'Billed after the month it covers' },
];

function money(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function shortDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function periodLabel(start: string, end: string): string {
  return `${shortDate(start)} to ${shortDate(end)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: string } | null)?.message;
  return message && message.length < 140 ? message : fallback;
}

export default function RetainersModal({
  isOpen,
  onClose,
  projectId,
  invoices,
  team,
  today,
  canManage,
  canManageSplits,
  isDemoMode,
}: RetainersModalProps) {
  const supabase = useMemo(() => createClient(), []);
  const [bundle, setBundle] = useState<ProjectRetainerBundle>(EMPTY_BUNDLE);
  const [duePeriods, setDuePeriods] = useState<RetainerDuePeriod[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [editing, setEditing] = useState<ProjectRetainer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectRetainer | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [amount, setAmount] = useState<number | ''>('');
  const [timing, setTiming] = useState<RetainerBillingTiming>('advance');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState('');
  const [leadDays, setLeadDays] = useState<number | ''>(1);
  const [splitRows, setSplitRows] = useState<SplitRow[]>([]);
  const [splitFrom, setSplitFrom] = useState(today);
  const [splitDirty, setSplitDirty] = useState(false);
  const [linkedLines, setLinkedLines] = useState<Set<string>>(new Set());
  const [newAmount, setNewAmount] = useState<number | ''>('');
  const [newAmountDate, setNewAmountDate] = useState(today);

  const payableMembers = useMemo(
    () => team.filter((member) => member.role !== 'owner' && member.role !== 'agent'),
    [team],
  );
  const memberName = useCallback(
    (id: string) => team.find((member) => member.id === id)?.name ?? 'Former member',
    [team],
  );
  const invoiceById = useMemo(() => new Map(invoices.map((invoice) => [invoice.id, invoice])), [invoices]);

  const load = useCallback(async () => {
    if (isDemoMode) {
      setBundle(EMPTY_BUNDLE);
      setDuePeriods([]);
      return;
    }
    setLoading(true);
    try {
      const [nextBundle, nextDue] = await Promise.all([
        fetchProjectRetainers(supabase, projectId, canManageSplits),
        canManage ? fetchRetainerDuePeriods(supabase, projectId) : Promise.resolve([]),
      ]);
      setBundle(nextBundle);
      setDuePeriods(nextDue);
    } catch (error) {
      toast('error', errorMessage(error, 'Failed to load retainers'));
    } finally {
      setLoading(false);
    }
  }, [canManage, canManageSplits, isDemoMode, projectId, supabase]);

  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [isOpen, load]);

  // Fixed and recurring lines no retainer has claimed: candidates for "already invoiced".
  const linkableLines = useMemo(() => {
    const result: Array<{ key: string; invoice: ProjectInvoice; lineId: string; label: string; amount: number }> = [];
    for (const invoice of invoices) {
      if (invoice.status === 'cancelled') continue;
      for (const line of ensureLineItems(invoice)) {
        if (line.item_type !== 'recurring' && line.item_type !== 'fixed') continue;
        if (line.retainer_id || !line.service_start_date || line.id.startsWith('legacy:')) continue;
        result.push({
          key: `${invoice.id}:${line.id}`,
          invoice,
          lineId: line.id,
          label: line.description || 'Untitled line',
          amount: Number(line.amount) || 0,
        });
      }
    }
    return result;
  }, [invoices]);

  const currentAmount = useCallback(
    (retainerId: string) => {
      const history = bundle.amounts.filter((row) => row.retainer_id === retainerId);
      const active = [...history].reverse().find((row) => row.effective_date <= today);
      return (active ?? history[0])?.amount ?? 0;
    },
    [bundle.amounts, today],
  );

  const currentShares = useCallback(
    (retainerId: string) =>
      bundle.shares.filter(
        (share) =>
          share.retainer_id === retainerId &&
          share.effective_from <= today &&
          (!share.effective_to || share.effective_to >= today),
      ),
    [bundle.shares, today],
  );

  const openCreate = () => {
    setEditing(null);
    setName('');
    setAmount('');
    setTiming('advance');
    setStartDate(today);
    setEndDate('');
    setLeadDays(1);
    setSplitRows([]);
    setSplitFrom(today);
    setSplitDirty(false);
    setLinkedLines(new Set());
    setShowAdvanced(false);
    setView('form');
  };

  const openEdit = (retainer: ProjectRetainer) => {
    setEditing(retainer);
    setName(retainer.name);
    setAmount(currentAmount(retainer.id));
    setTiming(retainer.billing_timing);
    setStartDate(retainer.start_date);
    setEndDate(retainer.end_date ?? '');
    setLeadDays(retainer.lead_days);
    // A split scheduled for later is what the owner means to edit, so prefer it.
    const upcoming = bundle.shares.filter(
      (share) => share.retainer_id === retainer.id && (!share.effective_to || share.effective_to >= today),
    );
    const latestFrom = upcoming.reduce((latest, share) => (share.effective_from > latest ? share.effective_from : latest), '');
    setSplitRows(
      upcoming
        .filter((share) => share.effective_from === latestFrom)
        .map((share) => ({ member_id: share.member_id, percent: share.percent })),
    );
    setSplitFrom(latestFrom > today ? latestFrom : today);
    setSplitDirty(false);
    setLinkedLines(new Set());
    setNewAmount('');
    setNewAmountDate(today);
    setShowAdvanced(false);
    setView('form');
  };

  const splitTotal = splitRows.reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
  const cleanSplit = splitRows
    .filter((row) => row.member_id && Number(row.percent) > 0)
    .map((row) => ({ member_id: row.member_id, percent: Number(row.percent) }));
  const splitValid =
    splitTotal <= 100 && new Set(cleanSplit.map((row) => row.member_id)).size === cleanSplit.length;

  const canSubmit =
    name.trim().length > 0 &&
    !!startDate &&
    (!endDate || endDate >= startDate) &&
    (editing ? true : amount !== '' && amount >= 0) &&
    splitValid &&
    !busy;

  const submit = async () => {
    if (!canSubmit) return;
    if (isDemoMode) {
      toast('info', 'Retainers are disabled in demo mode');
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await saveProjectRetainer(supabase, editing.id, {
          name: name.trim(),
          billing_timing: timing,
          start_date: startDate,
          end_date: endDate || null,
          lead_days: leadDays === '' ? 1 : leadDays,
        });
        if (canManageSplits && splitDirty) {
          await setRetainerShares(supabase, editing.id, cleanSplit, splitFrom);
        }
        toast('success', 'Retainer updated');
      } else {
        await saveProjectRetainer(supabase, null, {
          project_id: projectId,
          name: name.trim(),
          billing_timing: timing,
          start_date: startDate,
          end_date: endDate || null,
          lead_days: leadDays === '' ? 1 : leadDays,
          amount: Number(amount),
          ...(canManageSplits && cleanSplit.length > 0 ? { shares: cleanSplit } : {}),
          link_lines: linkableLines
            .filter((line) => linkedLines.has(line.key))
            .map((line) => ({ invoice_id: line.invoice.id, line_item_id: line.lineId })),
        });
        toast('success', 'Retainer created');
      }
      setView('list');
      await load();
    } catch (error) {
      toast('error', errorMessage(error, 'Failed to save retainer'));
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async (retainer: ProjectRetainer) => {
    setBusy(true);
    try {
      await saveProjectRetainer(supabase, retainer.id, {
        status: retainer.status === 'active' ? 'paused' : 'active',
      });
      toast('success', retainer.status === 'active' ? 'Retainer paused' : 'Retainer resumed');
      await load();
    } catch (error) {
      toast('error', errorMessage(error, 'Failed to update retainer'));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await removeProjectRetainer(supabase, deleteTarget.id);
      toast('success', 'Retainer deleted');
      setDeleteTarget(null);
      await load();
    } catch (error) {
      toast('error', errorMessage(error, 'Failed to delete retainer'));
    } finally {
      setBusy(false);
    }
  };

  const generateNow = async (retainerId: string, periodStart: string) => {
    setBusy(true);
    try {
      const invoice = await generateRetainerPeriod(supabase, retainerId, periodStart);
      toast('success', `Draft ${invoice.invoice_number} created`);
      await load();
    } catch (error) {
      toast('error', errorMessage(error, 'Failed to create the draft'));
    } finally {
      setBusy(false);
    }
  };

  const scheduleAmount = async () => {
    if (!editing || newAmount === '' || newAmount < 0 || !newAmountDate) return;
    setBusy(true);
    try {
      await scheduleRetainerAmount(supabase, editing.id, newAmount, newAmountDate);
      toast('success', 'Amount scheduled');
      setNewAmount('');
      await load();
    } catch (error) {
      toast('error', errorMessage(error, 'Failed to schedule amount'));
    } finally {
      setBusy(false);
    }
  };

  const deleteAmount = async (amountId: string) => {
    setBusy(true);
    try {
      await removeRetainerAmount(supabase, amountId);
      await load();
    } catch (error) {
      toast('error', errorMessage(error, 'Failed to remove amount'));
    } finally {
      setBusy(false);
    }
  };

  const updateSplitRow = (index: number, patch: Partial<SplitRow>) => {
    setSplitDirty(true);
    setSplitRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const renderPeriods = (retainer: ProjectRetainer) => {
    const handled = bundle.periods.filter((period) => period.retainer_id === retainer.id);
    const due = duePeriods.filter((period) => period.retainer_id === retainer.id && !period.skipped);
    if (handled.length === 0 && due.length === 0) {
      return <p className="px-3 py-2.5 text-xs text-zinc-400">No billing periods yet.</p>;
    }
    return (
      <ul className="divide-y divide-white/[0.08]">
        {handled.map((period) => {
          const invoice = period.invoice_id ? invoiceById.get(period.invoice_id) : undefined;
          const skipped = period.status === 'skipped' || !invoice;
          return (
            <li key={period.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-zinc-200">{periodLabel(period.period_start, period.period_end)}</p>
                {invoice ? <p className="text-[11px] text-zinc-400">{invoice.invoice_number}</p> : null}
              </div>
              {skipped ? (
                <div className="flex items-center gap-2">
                  <Badge variant="default">Skipped</Badge>
                  {canManage ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void generateNow(retainer.id, period.period_start)}>
                      Generate now
                    </Button>
                  ) : null}
                </div>
              ) : (
                <Badge variant={invoice.status === 'paid' ? 'success' : invoice.status === 'draft' ? 'warning' : 'info'}>
                  {invoice.status === 'paid' ? 'Paid' : invoice.status === 'draft' ? 'Drafted' : 'Sent'}
                </Badge>
              )}
            </li>
          );
        })}
        {due.map((period) => (
          <li key={`due:${period.period_start}`} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-200">{periodLabel(period.period_start, period.period_end)}</p>
              <p className="text-[11px] text-zinc-400">{money(period.amount)}{period.prorated ? ', prorated' : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="warning">Due</Badge>
              {canManage ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void generateNow(retainer.id, period.period_start)}>
                  Generate now
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    );
  };

  const renderList = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-400">
          A draft invoice is created before each bill date. Nothing is sent without you.
        </p>
        {canManage ? (
          <Button size="sm" onClick={openCreate} icon={<Plus size={14} />}>
            New retainer
          </Button>
        ) : null}
      </div>

      {loading && bundle.retainers.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-400">Loading retainers</p>
      ) : bundle.retainers.length === 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-8 text-center">
          <p className="text-sm font-medium text-zinc-300">No retainers on this project</p>
          <p className="mt-1 text-xs text-zinc-400">Add one and its invoice line is drafted for you every month.</p>
        </div>
      ) : (
        bundle.retainers.map((retainer) => {
          const shares = currentShares(retainer.id);
          const ended = !!retainer.end_date && retainer.end_date < today;
          return (
            <section key={retainer.id} className="rounded-xl border border-white/[0.08] bg-white/[0.03]">
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-white">{retainer.name}</h3>
                    {ended ? <Badge variant="default">Ended</Badge>
                      : retainer.status === 'paused' ? <Badge variant="warning">Paused</Badge>
                      : <Badge variant="success">Active</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    {money(currentAmount(retainer.id))} per month, billed {retainer.billing_timing === 'advance' ? 'in advance' : 'in arrears'}.
                    {' '}Started {shortDate(retainer.start_date)}{retainer.end_date ? `, ends ${shortDate(retainer.end_date)}` : ''}.
                  </p>
                  {canManageSplits && shares.length > 0 ? (
                    <p className="mt-1 text-xs text-zinc-400">
                      Split: {shares.map((share) => `${memberName(share.member_id)} ${share.percent}%`).join(', ')}
                    </p>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => openEdit(retainer)} icon={<Pencil size={13} />}>
                      Edit
                    </Button>
                    {!ended ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void togglePause(retainer)}
                        icon={retainer.status === 'active' ? <Pause size={13} /> : <Play size={13} />}
                      >
                        {retainer.status === 'active' ? 'Pause' : 'Resume'}
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(retainer)}
                      className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
                      aria-label={`Delete retainer ${retainer.name}`}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="border-t border-white/[0.08]">{renderPeriods(retainer)}</div>
            </section>
          );
        })
      )}
    </div>
  );

  const renderForm = () => {
    const history = editing ? bundle.amounts.filter((row) => row.retainer_id === editing.id) : [];
    return (
      <div className="space-y-5">
        <button
          type="button"
          onClick={() => setView('list')}
          className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-zinc-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
        >
          <ArrowLeft size={13} aria-hidden="true" />
          All retainers
        </button>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Name"
            value={name}
            onChange={setName}
            placeholder="Monthly Marketing Retainer"
            description="Printed as the invoice line."
            className="sm:col-span-2"
          />
          {editing ? null : (
            <NumberInput label="Monthly amount" value={amount} onChange={setAmount} min={0} step={50} prefix="$" />
          )}
          <Select
            label="Billing"
            value={timing}
            onChange={(value) => setTiming(value as RetainerBillingTiming)}
            options={TIMING_OPTIONS}
          />
          <DateInput label="Start date" value={startDate} onChange={setStartDate} />
          <DateInput label="End date (optional)" value={endDate} onChange={setEndDate} />
        </div>
        <p className="text-xs text-zinc-400">
          Periods are calendar months. A partial first or last month is prorated by days, and you can change the amount on the draft.
        </p>

        {canManageSplits ? (
          <fieldset className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">Revenue split</legend>
            <p className="text-xs text-zinc-400">
              A percent of each line, earned by the member when the client pays. Only people who manage compensation see this.
            </p>
            <div className="mt-3 space-y-2">
              {splitRows.map((row, index) => (
                <div key={index} className="flex items-end gap-2">
                  <Select
                    label={index === 0 ? 'Member' : undefined}
                    ariaLabel="Member"
                    value={row.member_id}
                    onChange={(value) => updateSplitRow(index, { member_id: value })}
                    options={payableMembers.map((member) => ({ value: member.id, label: member.name }))}
                    placeholder="Choose a member"
                    size="sm"
                    className="flex-1"
                  />
                  <NumberInput
                    label={index === 0 ? 'Percent' : undefined}
                    aria-label="Percent"
                    value={row.percent}
                    onChange={(value) => updateSplitRow(index, { percent: value })}
                    min={0}
                    max={100}
                    suffix="%"
                    size="sm"
                    className="w-28"
                  />
                  <button
                    type="button"
                    onClick={() => { setSplitDirty(true); setSplitRows((rows) => rows.filter((_, i) => i !== index)); }}
                    className="mb-1 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
                    aria-label="Remove split"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={payableMembers.length === 0}
                onClick={() => { setSplitDirty(true); setSplitRows((rows) => [...rows, { member_id: '', percent: 50 }]); }}
                icon={<Plus size={14} />}
              >
                Add member
              </Button>
              {editing && splitDirty ? (
                <DateInput label="Applies from" value={splitFrom} onChange={setSplitFrom} size="sm" />
              ) : null}
            </div>
            {!splitValid ? (
              <p role="alert" className="mt-2 text-xs text-red-400">
                Splits cannot total more than 100 percent or repeat a member.
              </p>
            ) : splitRows.length > 0 ? (
              <p className="mt-2 text-xs text-zinc-400">You keep {Math.max(0, 100 - splitTotal)}%.</p>
            ) : null}
            {editing && splitDirty ? (
              <p className="mt-2 text-xs text-zinc-400">
                Lines already on an invoice keep the split they were drafted with.
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {!editing && linkableLines.length > 0 ? (
          <fieldset className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">Already invoiced</legend>
            <p className="text-xs text-zinc-400">
              Tick any line you already billed for this retainer. Its month counts as billed, and a paid line earns the split right away.
            </p>
            <div className="mt-3 space-y-2">
              {linkableLines.map((line) => (
                <Checkbox
                  key={line.key}
                  checked={linkedLines.has(line.key)}
                  onChange={(checked) =>
                    setLinkedLines((current) => {
                      const next = new Set(current);
                      if (checked) next.add(line.key); else next.delete(line.key);
                      return next;
                    })
                  }
                  label={`${line.invoice.invoice_number}: ${line.label}`}
                  description={`${money(line.amount)}, ${line.invoice.status}`}
                />
              ))}
            </div>
          </fieldset>
        ) : null}

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((open) => !open)}
            aria-expanded={showAdvanced}
            className="rounded-md text-xs font-medium text-zinc-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
          >
            {showAdvanced ? 'Hide advanced' : 'Advanced'}
          </button>
          {showAdvanced ? (
            <div className="mt-3 space-y-4">
              <NumberInput
                label="Draft lead time"
                value={leadDays}
                onChange={setLeadDays}
                min={0}
                max={28}
                suffix="days"
                description="How long before the bill date the draft appears."
                className="sm:w-56"
              />
              {editing ? (
                <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Amount history</p>
                  <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                    <DateInput label="Effective date" value={newAmountDate} onChange={setNewAmountDate} size="sm" className="flex-1" />
                    <NumberInput label="Monthly amount" value={newAmount} onChange={setNewAmount} min={0} step={50} prefix="$" size="sm" className="flex-1" />
                    <Button size="sm" onClick={() => void scheduleAmount()} disabled={busy || newAmount === ''} icon={<Plus size={14} />}>
                      Schedule
                    </Button>
                  </div>
                  <ul className="mt-3 divide-y divide-white/[0.08] rounded-lg border border-white/[0.08] bg-surface-raised">
                    {[...history].reverse().map((row) => (
                      <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <div>
                          <p className="text-sm font-semibold text-white">{money(row.amount)}</p>
                          <p className="text-xs text-zinc-400">
                            {row.effective_date > today ? 'Starts' : 'Effective'} {shortDate(row.effective_date)}
                          </p>
                        </div>
                        {row.effective_date > today && history.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => void deleteAmount(row.id)}
                            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
                            aria-label={`Remove amount effective ${shortDate(row.effective_date)}`}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/[0.08] pt-4">
          <Button variant="secondary" onClick={() => setView('list')}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {editing ? 'Save retainer' : 'Create retainer'}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={view === 'form' ? (editing ? 'Edit retainer' : 'New retainer') : 'Retainers'} size="2xl">
        <p className="sr-only">
          Recurring monthly billing for this project. Each retainer drafts its invoice line before the bill date.
        </p>
        {view === 'form' ? renderForm() : renderList()}
      </Modal>
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete retainer"
        message={`Delete ${deleteTarget?.name ?? 'this retainer'}? Invoices already created stay as they are, and earnings already recorded are kept.`}
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
