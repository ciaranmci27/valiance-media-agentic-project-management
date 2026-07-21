'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clock3, DollarSign, Landmark, ListChecks, MoreVertical, Plus, WalletCards } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { getWorkedHours } from '@/lib/time-entry-utils';
import { hasPermission } from '@/lib/access-control';
import { useAuth } from '@/lib/auth-context';
import type { Project, TeamMember, TeamMemberEarningAdjustment, TeamMemberHourlyRate, TeamMemberPayout, TeamMemberPayoutAllocation, TimeEntry } from '@/lib/types';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Select } from '@/components/ui/Select';
import { Avatar } from '@/components/ui/Avatar';

type PayrollData = {
  entries: TimeEntry[];
  rates: TeamMemberHourlyRate[];
  adjustments: TeamMemberEarningAdjustment[];
  payouts: TeamMemberPayout[];
  allocations: TeamMemberPayoutAllocation[];
};

const EMPTY: PayrollData = { entries: [], rates: [], adjustments: [], payouts: [], allocations: [] };
const money = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ROLE_BADGE_CLASSES: Record<TeamMember['role'], string> = {
  owner: 'bg-amber-100 text-amber-800',
  admin: 'bg-brand-100 text-brand-700',
  member: 'bg-zinc-100 text-zinc-700',
  guest: 'bg-amber-100 text-amber-700',
  agent: 'bg-purple-100 text-purple-700',
};

type EarningsFilter = 'all' | 'pending' | 'approved' | 'unpaid';
type EarningsRow = {
  id: string;
  kind: 'time' | 'adjustment';
  date: string;
  description: string;
  projectName: string;
  status: 'pending' | 'approved';
  amount: number;
  remaining: number;
  hours?: number;
  rate?: number;
};

export function PayrollPanel({ team, projects }: { team: TeamMember[]; projects: Project[] }) {
  const { access, teamMemberId } = useAuth();
  const canManageCompensation = hasPermission(access, 'compensation.manage');
  const canManagePayouts = hasPermission(access, 'payouts.manage');
  const canManage = canManageCompensation || canManagePayouts;
  const canApprove = hasPermission(access, 'time.approve');
  const [data, setData] = useState<PayrollData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showReject, setShowReject] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [payMemberId, setPayMemberId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [rateMemberId, setRateMemberId] = useState('');
  const [rateAmount, setRateAmount] = useState('');
  const [rateDate, setRateDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [showRate, setShowRate] = useState(false);
  const [showAdjustment, setShowAdjustment] = useState(false);
  const [adjustmentMemberId, setAdjustmentMemberId] = useState('');
  const [adjustmentType, setAdjustmentType] = useState<'bonus' | 'deduction'>('bonus');
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentDescription, setAdjustmentDescription] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [menuMemberId, setMenuMemberId] = useState<string | null>(null);
  const [ledgerMemberId, setLedgerMemberId] = useState<string | null>(null);
  const [earningsFilter, setEarningsFilter] = useState<EarningsFilter>('all');
  // Single-flight lock for money actions. The ref blocks re-entry synchronously
  // (before React re-renders), so a rapid double-click cannot record a duplicate
  // payout/adjustment; the state flag drives the disabled button styling.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const runExclusive = useCallback(async (fn: () => Promise<void>) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await fn();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, []);
  const payableMembers = useMemo(
    () => team.filter((member) => member.role !== 'owner' && member.role !== 'agent'),
    [team],
  );
  const payableMemberIds = useMemo(() => new Set(payableMembers.map((member) => member.id)), [payableMembers]);
  const hasPayableIdentity = canManage
    ? payableMembers.length > 0
    : payableMembers.some((member) => member.id === teamMemberId);

  const load = useCallback(async () => {
    if (!hasPayableIdentity) return;
    setLoading(true);
    try {
      const response = await fetch('/api/workspace/payroll', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to load payroll');
      setData(payload.data);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Failed to load payroll');
    } finally {
      setLoading(false);
    }
  }, [hasPayableIdentity]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const pending = useMemo(
    () => data.entries.filter((entry) => entry.approval_status === 'pending' && entry.member_id !== teamMemberId && payableMemberIds.has(entry.member_id)),
    [data.entries, payableMemberIds, teamMemberId],
  );
  const allocatedByEntry = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of data.allocations) if (row.time_entry_id) map.set(row.time_entry_id, (map.get(row.time_entry_id) || 0) + Number(row.allocated_amount));
    return map;
  }, [data.allocations]);
  const allocatedByAdjustment = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of data.allocations) if (row.adjustment_id) map.set(row.adjustment_id, (map.get(row.adjustment_id) || 0) + Number(row.allocated_amount));
    return map;
  }, [data.allocations]);

  const balances = useMemo(() => {
    const map = new Map<string, { earned: number; paid: number; owed: number }>();
    const ensure = (id: string) => map.get(id) || { earned: 0, paid: 0, owed: 0 };
    for (const entry of data.entries) {
      if (entry.approval_status !== 'approved') continue;
      const amount = getWorkedHours(entry) * Number(entry.compensation_rate || 0);
      const current = ensure(entry.member_id);
      current.earned += amount;
      current.owed += amount - (allocatedByEntry.get(entry.id) || 0);
      map.set(entry.member_id, current);
    }
    for (const adjustment of data.adjustments) {
      if (adjustment.voided_at) continue;
      const amount = Number(adjustment.amount) * (adjustment.adjustment_type === 'deduction' ? -1 : 1);
      const current = ensure(adjustment.member_id);
      current.earned += amount;
      current.owed += amount - (allocatedByAdjustment.get(adjustment.id) || 0);
      map.set(adjustment.member_id, current);
    }
    for (const payout of data.payouts) {
      if (payout.voided_at) continue;
      const current = ensure(payout.member_id);
      current.paid += Number(payout.amount);
      map.set(payout.member_id, current);
    }
    return map;
  }, [allocatedByAdjustment, allocatedByEntry, data.adjustments, data.entries, data.payouts]);
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const earningsRows = useMemo<EarningsRow[]>(() => {
    if (!ledgerMemberId) return [];
    const rows: EarningsRow[] = [];
    for (const entry of data.entries) {
      if (entry.member_id !== ledgerMemberId || !['pending', 'approved'].includes(entry.approval_status || '')) continue;
      const hours = getWorkedHours(entry);
      const rate = Number(entry.compensation_rate || 0);
      const amount = hours * rate;
      rows.push({
        id: entry.id,
        kind: 'time',
        date: entry.start_time,
        description: entry.description || (entry.work_type === 'internal' ? 'Internal work' : 'Client work'),
        projectName: projectNames.get(entry.project_id) || 'Unknown project',
        status: entry.approval_status as 'pending' | 'approved',
        amount,
        remaining: entry.approval_status === 'approved' ? amount - (allocatedByEntry.get(entry.id) || 0) : amount,
        hours,
        rate,
      });
    }
    for (const adjustment of data.adjustments) {
      if (adjustment.member_id !== ledgerMemberId || adjustment.voided_at) continue;
      const amount = Number(adjustment.amount) * (adjustment.adjustment_type === 'deduction' ? -1 : 1);
      rows.push({
        id: adjustment.id,
        kind: 'adjustment',
        date: `${adjustment.effective_date}T00:00:00`,
        description: adjustment.description || (adjustment.adjustment_type === 'bonus' ? 'Bonus' : 'Deduction'),
        projectName: adjustment.project_id ? (projectNames.get(adjustment.project_id) || 'Unknown project') : 'General adjustment',
        status: 'approved',
        amount,
        remaining: amount - (allocatedByAdjustment.get(adjustment.id) || 0),
      });
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }, [allocatedByAdjustment, allocatedByEntry, data.adjustments, data.entries, ledgerMemberId, projectNames]);
  const filteredEarningsRows = useMemo(() => earningsRows.filter((row) => {
    if (earningsFilter === 'pending') return row.status === 'pending';
    if (earningsFilter === 'approved') return row.status === 'approved';
    if (earningsFilter === 'unpaid') return row.status === 'approved' && Math.abs(row.remaining) > 0.005;
    return true;
  }), [earningsFilter, earningsRows]);
  const earningsSummary = useMemo(() => ({
    approved: earningsRows.filter((row) => row.status === 'approved').reduce((sum, row) => sum + row.amount, 0),
    pending: earningsRows.filter((row) => row.status === 'pending').reduce((sum, row) => sum + row.amount, 0),
    unpaid: earningsRows.filter((row) => row.status === 'approved' && Math.abs(row.remaining) > 0.005).reduce((sum, row) => sum + row.remaining, 0),
  }), [earningsRows]);
  const hasEffectiveRate = (memberId: string, startTime: string) => data.rates.some(
    (rate) => rate.member_id === memberId && new Date(rate.effective_at).getTime() <= new Date(startTime).getTime(),
  );

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/workspace/payroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Payroll action failed');
    await load();
    return payload.data;
  };

  const approveSelected = () => runExclusive(async () => {
    try {
      await post({ action: 'review', entry_ids: [...selected], decision: 'approved' });
      setSelected(new Set());
      toast('success', 'Selected time approved');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Approval failed'); }
  });

  const rejectSelected = () => runExclusive(async () => {
    try {
      await post({ action: 'review', entry_ids: [...selected], decision: 'rejected', reason: rejectionReason.trim() || null });
      setSelected(new Set());
      setShowReject(false);
      setRejectionReason('');
      toast('success', 'Selected time rejected');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Review failed'); }
  });

  const openPayout = (memberId: string) => {
    setPayMemberId(memberId);
    setPayAmount(Math.max(0, balances.get(memberId)?.owed || 0).toFixed(2));
    setMenuMemberId(null);
  };

  const openRate = (memberId: string) => {
    setRateMemberId(memberId);
    setRateAmount('');
    setShowRate(true);
    setMenuMemberId(null);
  };

  const openAdjustment = (memberId: string) => {
    setAdjustmentMemberId(memberId);
    setAdjustmentType('bonus');
    setAdjustmentAmount('');
    setAdjustmentDescription('');
    setShowAdjustment(true);
    setMenuMemberId(null);
  };

  const openEarnings = (memberId: string) => {
    setLedgerMemberId(memberId);
    setEarningsFilter('all');
    setMenuMemberId(null);
  };

  const recordPayout = () => runExclusive(async () => {
    if (!payMemberId) return;
    const amount = Number(payAmount);
    const owed = balances.get(payMemberId)?.owed || 0;
    if (!Number.isFinite(amount) || amount <= 0 || amount > owed + 0.005) {
      toast('error', 'Payment must be positive and no more than the current balance');
      return;
    }
    const allocations: Array<{ time_entry_id?: string; adjustment_id?: string; allocated_amount: number }> = [];
    const negativeAdjustments = data.adjustments
      .filter((item) => item.member_id === payMemberId && !item.voided_at && item.adjustment_type === 'deduction')
      .map((item) => ({ item, remaining: -Number(item.amount) - (allocatedByAdjustment.get(item.id) || 0) }))
      .filter((row) => row.remaining < -0.005);
    let target = amount;
    for (const row of negativeAdjustments) {
      allocations.push({ adjustment_id: row.item.id, allocated_amount: row.remaining });
      target -= row.remaining;
    }
    const positiveClaims: Array<{ date: string; time_entry_id?: string; adjustment_id?: string; remaining: number }> = [
      ...data.entries.filter((entry) => entry.member_id === payMemberId && entry.approval_status === 'approved').map((entry) => ({
        date: entry.start_time,
        time_entry_id: entry.id,
        remaining: getWorkedHours(entry) * Number(entry.compensation_rate || 0) - (allocatedByEntry.get(entry.id) || 0),
      })),
      ...data.adjustments.filter((item) => item.member_id === payMemberId && !item.voided_at && item.adjustment_type === 'bonus').map((item) => ({
        date: item.effective_date,
        adjustment_id: item.id,
        remaining: Number(item.amount) - (allocatedByAdjustment.get(item.id) || 0),
      })),
    ].filter((claim) => claim.remaining > 0.005).sort((a, b) => a.date.localeCompare(b.date));
    for (const claim of positiveClaims) {
      if (target <= 0.005) break;
      const applied = Math.min(target, claim.remaining);
      allocations.push({ time_entry_id: claim.time_entry_id, adjustment_id: claim.adjustment_id, allocated_amount: Number(applied.toFixed(2)) });
      target -= applied;
    }
    if (target > 0.01) return toast('error', 'The payment could not be allocated to approved earnings');
    try {
      await post({ action: 'payout', member_id: payMemberId, payment_date: new Date().toISOString().slice(0, 10), amount, payment_method: paymentMethod, reference: paymentReference, allocations });
      setPayMemberId(null);
      setPaymentMethod('');
      setPaymentReference('');
      toast('success', 'Payment recorded');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Payment failed'); }
  });

  const scheduleRate = () => runExclusive(async () => {
    const rate = Number(rateAmount);
    if (!rateMemberId || rateAmount === '' || !Number.isFinite(rate) || rate < 0) {
      toast('error', 'Enter a valid hourly rate');
      return;
    }
    try {
      const result = await post({ action: 'schedule_rate', member_id: rateMemberId, hourly_rate: rate, effective_at: `${rateDate}T00:00:00.000Z` }) as { updated_entries?: number } | null;
      setShowRate(false);
      setRateAmount('');
      const updatedEntries = Number(result?.updated_entries || 0);
      toast('success', updatedEntries > 0
        ? `Rate scheduled and ${updatedEntries} unpaid ${updatedEntries === 1 ? 'entry' : 'entries'} recalculated`
        : 'Compensation rate scheduled');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Rate update failed'); }
  });

  const addAdjustment = () => runExclusive(async () => {
    const adjustment = Number(adjustmentAmount);
    if (!adjustmentMemberId || adjustmentAmount === '' || !Number.isFinite(adjustment) || adjustment <= 0) {
      toast('error', 'Enter a valid amount');
      return;
    }
    try {
      await post({ action: 'adjustment', member_id: adjustmentMemberId, adjustment_type: adjustmentType, amount: adjustment, effective_date: new Date().toISOString().slice(0, 10), description: adjustmentDescription });
      setShowAdjustment(false);
      setAdjustmentAmount('');
      setAdjustmentDescription('');
      toast('success', adjustmentType === 'bonus' ? 'Bonus added' : 'Deduction added');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Adjustment failed'); }
  });

  const membersWithLedgerActivity = useMemo(() => new Set([
    ...data.entries.map((entry) => entry.member_id),
    ...data.rates.map((rate) => rate.member_id),
    ...data.adjustments.map((adjustment) => adjustment.member_id),
    ...data.payouts.map((payout) => payout.member_id),
  ]), [data.adjustments, data.entries, data.payouts, data.rates]);
  const visibleMembers = canManage
    ? payableMembers.filter((member) => member.status === 'active' || membersWithLedgerActivity.has(member.id))
    : payableMembers.filter((member) => member.id === teamMemberId);
  const ownBalance = teamMemberId ? balances.get(teamMemberId) : undefined;
  const rateMember = team.find((member) => member.id === rateMemberId);
  const adjustmentMember = team.find((member) => member.id === adjustmentMemberId);
  const ledgerMember = team.find((member) => member.id === ledgerMemberId);
  if (!hasPayableIdentity || (!loading && visibleMembers.length === 0)) return null;

  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100">
        <div>
          <div className="flex items-center gap-2"><WalletCards size={18} className="text-brand-600" /><h2 className="font-semibold text-zinc-900">{canManage ? 'Team compensation' : 'My earnings'}</h2></div>
          <p className="text-xs text-zinc-500 mt-1">Approved work, adjustments, and recorded payments in one ledger.</p>
        </div>
      </div>

      {loading ? <div className="p-6 text-sm text-zinc-500">Loading compensation ledger...</div> : (
        <>
          {canApprove && pending.length > 0 && (
            <div className="p-5 border-b border-zinc-100 bg-amber-50/40">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2"><Clock3 size={16} className="text-amber-600" /><span className="text-sm font-semibold text-zinc-900">{pending.length} submitted {pending.length === 1 ? 'entry' : 'entries'} awaiting review</span></div>
                <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={selected.size === 0 || submitting} onClick={() => setShowReject(true)}>Reject selected</Button><Button size="sm" disabled={selected.size === 0 || submitting} onClick={approveSelected}>Approve selected</Button></div>
              </div>
              <div className="space-y-1 max-h-56 overflow-y-auto">
                {pending.map((entry) => {
                  const member = team.find((item) => item.id === entry.member_id);
                  const hours = getWorkedHours(entry);
                  const missingRate = !hasEffectiveRate(entry.member_id, entry.start_time);
                  return <Checkbox
                    key={entry.id}
                    checked={selected.has(entry.id)}
                    disabled={missingRate}
                    onChange={(checked) => setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(entry.id);
                      else next.delete(entry.id);
                      return next;
                    })}
                    className="w-full items-center rounded-lg border border-zinc-200 bg-white px-3 py-2"
                    label={<span className="flex w-full min-w-0 items-center gap-3 font-normal"><span className="min-w-0 flex-1"><span className="text-sm font-medium text-zinc-800">{member?.name || 'Team member'}</span><span className="block truncate text-xs text-zinc-500">{entry.description || 'No description'} / {new Date(entry.start_time).toLocaleDateString()}</span></span><span className="text-sm tabular-nums text-zinc-700">{hours.toFixed(2)}h</span>{missingRate ? <span className="text-xs font-semibold text-red-600">Rate required</span> : <span className="text-sm font-medium tabular-nums text-zinc-900">{money(hours * Number(entry.compensation_rate || 0))}</span>}</span>}
                  />;
                })}
              </div>
            </div>
          )}

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-zinc-100">
            {(canManage ? visibleMembers : visibleMembers.slice(0, 1)).map((member) => {
              const balance = balances.get(member.id) || { earned: 0, paid: 0, owed: 0 };
              const missingApprovedRates = data.entries.filter((entry) => entry.member_id === member.id
                && entry.approval_status === 'approved'
                && !hasEffectiveRate(entry.member_id, entry.start_time)).length;
              return <div key={member.id} className="relative p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={member.name} src={member.avatar} size="sm" />
                    <div className="flex min-w-0 items-center gap-1.5">
                      <p className="truncate text-sm font-semibold text-zinc-900">{member.name}</p>
                      <span className={`flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize ${ROLE_BADGE_CLASSES[member.role]}`}>{member.role}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {balance.owed <= 0.005 && <CheckCircle2 size={18} className="text-emerald-500" />}
                    {canManage && (
                      <div className="relative">
                        <button
                          type="button"
                          aria-label={`Compensation actions for ${member.name}`}
                          aria-expanded={menuMemberId === member.id}
                          onClick={() => setMenuMemberId((current) => current === member.id ? null : member.id)}
                          className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                        >
                          <MoreVertical size={16} />
                        </button>
                        {menuMemberId === member.id && (
                          <>
                            <button type="button" aria-label="Close compensation menu" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuMemberId(null)} />
                            <div className="absolute right-0 top-8 z-20 min-w-[190px] rounded-lg border border-zinc-200 bg-white py-1 shadow-xl">
                              <button type="button" onClick={() => openEarnings(member.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-50"><ListChecks size={14} />View earnings</button>
                              {canManagePayouts && balance.owed > 0.005 && <button type="button" onClick={() => openPayout(member.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-50"><Landmark size={14} />Record payment</button>}
                              {canManageCompensation && <button type="button" onClick={() => openAdjustment(member.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-50"><Plus size={14} />Add adjustment</button>}
                              {canManageCompensation && <button type="button" onClick={() => openRate(member.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-50"><DollarSign size={14} />Schedule rate</button>}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div><p className="text-[10px] uppercase text-zinc-400">Earned</p><p className="text-sm font-semibold">{money(balance.earned)}</p></div>
                  <div><p className="text-[10px] uppercase text-zinc-400">Paid</p><p className="text-sm font-semibold text-emerald-700">{money(balance.paid)}</p></div>
                  <div><p className="text-[10px] uppercase text-zinc-400">Owed</p><p className="text-sm font-semibold text-amber-700">{money(balance.owed)}</p></div>
                </div>
                {missingApprovedRates > 0 && <p className="mt-3 text-xs font-medium text-red-600">{missingApprovedRates} approved {missingApprovedRates === 1 ? 'entry needs' : 'entries need'} a compensation rate</p>}
              </div>;
            })}
          </div>
          {!canManage && ownBalance && data.payouts.length > 0 && <div className="px-5 py-3 border-t border-zinc-100 text-xs text-zinc-500">Latest payment: {money(Number(data.payouts[0].amount))} on {new Date(`${data.payouts[0].payment_date}T00:00:00`).toLocaleDateString()}</div>}
        </>
      )}

      <Modal isOpen={Boolean(ledgerMemberId)} onClose={() => setLedgerMemberId(null)} title={`${ledgerMember?.name || 'Team member'} earnings`} size="4xl">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <LedgerStat label="Approved" value={money(earningsSummary.approved)} tone="approved" />
            <LedgerStat label="Pending" value={money(earningsSummary.pending)} tone="pending" />
            <LedgerStat label="Paid" value={money(ledgerMemberId ? balances.get(ledgerMemberId)?.paid || 0 : 0)} tone="approved" />
            <LedgerStat label="Unpaid" value={money(earningsSummary.unpaid)} tone="pending" />
          </div>

          <div className="flex flex-wrap gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
            {([
              ['all', 'All'],
              ['pending', 'Pending'],
              ['approved', 'Approved'],
              ['unpaid', 'Unpaid'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setEarningsFilter(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${earningsFilter === value ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {filteredEarningsRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-200 px-6 py-10 text-center text-sm text-zinc-500">No {earningsFilter === 'all' ? '' : `${earningsFilter} `}earnings found.</div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-zinc-200">
              <div className="hidden grid-cols-[minmax(0,1fr)_110px_90px_110px] gap-4 border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-zinc-400 md:grid">
                <span>Earning</span><span className="text-right">Time</span><span className="text-right">Status</span><span className="text-right">Amount</span>
              </div>
              <div className="max-h-[48vh] divide-y divide-zinc-100 overflow-y-auto">
                {filteredEarningsRows.map((row) => {
                  const unpaid = row.status === 'approved' && Math.abs(row.remaining) > 0.005;
                  const statusLabel = row.status === 'pending' ? 'Pending' : row.amount < 0 ? 'Adjustment' : unpaid ? 'Unpaid' : row.amount > 0 ? 'Paid' : 'Approved';
                  const statusClass = row.status === 'pending'
                    ? 'bg-amber-50 text-amber-700'
                    : unpaid
                      ? 'bg-orange-50 text-orange-700'
                      : 'bg-emerald-50 text-emerald-700';
                  return (
                    <div key={`${row.kind}-${row.id}`} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_110px_90px_110px] md:items-center md:gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-zinc-900">{row.description}</p>
                          {row.kind === 'adjustment' && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">Adjustment</span>}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-zinc-500">{row.projectName} · {new Date(row.date).toLocaleDateString()}</p>
                      </div>
                      <div className="text-left text-xs tabular-nums text-zinc-500 md:text-right">
                        {row.hours !== undefined ? <><span className="font-medium text-zinc-700">{row.hours.toFixed(2)}h</span><span className="block">{money(row.rate || 0)}/hr</span></> : 'One-time'}
                      </div>
                      <div className="md:text-right"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusClass}`}>{statusLabel}</span></div>
                      <div className="text-left md:text-right">
                        <p className={`text-sm font-semibold tabular-nums ${row.amount < 0 ? 'text-red-600' : 'text-zinc-900'}`}>{money(row.amount)}</p>
                        {unpaid && <p className="text-[10px] font-medium text-orange-600">{money(row.remaining)} remaining</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </Modal>

      <Modal isOpen={Boolean(payMemberId)} onClose={() => setPayMemberId(null)} title="Record team payment" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-zinc-600">This payment will be allocated against approved earnings in FIFO order.</p>
          <NumberInput label="Amount" min={0.01} step={0.01} prefix="$" value={payAmount === '' ? '' : Number(payAmount)} onChange={(value) => setPayAmount(value === '' ? '' : String(value))} />
          <TextInput label="Payment method" value={paymentMethod} onChange={setPaymentMethod} placeholder="ACH, check, cash..." />
          <TextInput label="Reference" value={paymentReference} onChange={setPaymentReference} placeholder="Optional transaction reference" />
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setPayMemberId(null)}>Cancel</Button><Button onClick={recordPayout} disabled={submitting}>Record payment</Button></div>
        </div>
      </Modal>

      <Modal isOpen={showReject} onClose={() => setShowReject(false)} title="Reject selected time" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-zinc-600">The team member can correct a rejected entry. Saving the correction will submit it for review again.</p>
          <Textarea label="Reason" value={rejectionReason} onChange={setRejectionReason} placeholder="Explain what needs to be corrected" rows={3} />
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setShowReject(false)}>Cancel</Button><Button variant="danger" onClick={rejectSelected} disabled={submitting}>Reject time</Button></div>
        </div>
      </Modal>

      <Modal isOpen={showRate} onClose={() => setShowRate(false)} title={`Schedule rate for ${rateMember?.name || 'team member'}`} size="sm">
        <div className="space-y-4">
          <NumberInput label="Hourly rate" min={0} step={0.01} prefix="$" suffix="/hr" value={rateAmount === '' ? '' : Number(rateAmount)} onChange={(value) => setRateAmount(value === '' ? '' : String(value))} />
          <DateInput label="Effective date" value={rateDate} onChange={setRateDate} />
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setShowRate(false)}>Cancel</Button><Button onClick={scheduleRate} disabled={submitting}>Schedule rate</Button></div>
        </div>
      </Modal>
      <Modal isOpen={showAdjustment} onClose={() => setShowAdjustment(false)} title={`Adjust earnings for ${adjustmentMember?.name || 'team member'}`} size="sm">
        <div className="space-y-4">
          <Select label="Type" value={adjustmentType} onChange={(value) => setAdjustmentType(value as 'bonus' | 'deduction')} options={[{ value: 'bonus', label: 'Bonus' }, { value: 'deduction', label: 'Deduction' }]} />
          <NumberInput label="Amount" min={0.01} step={0.01} prefix="$" value={adjustmentAmount === '' ? '' : Number(adjustmentAmount)} onChange={(value) => setAdjustmentAmount(value === '' ? '' : String(value))} />
          <TextInput label="Description" value={adjustmentDescription} onChange={setAdjustmentDescription} />
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setShowAdjustment(false)}>Cancel</Button><Button onClick={addAdjustment} disabled={submitting}>Add adjustment</Button></div>
        </div>
      </Modal>
    </section>
  );
}

function LedgerStat({ label, value, tone }: { label: string; value: string; tone?: 'approved' | 'pending' }) {
  const color = tone === 'approved' ? 'text-emerald-700' : tone === 'pending' ? 'text-amber-700' : 'text-zinc-900';
  return <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2.5"><p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{label}</p><p className={`mt-0.5 text-sm font-semibold tabular-nums ${color}`}>{value}</p></div>;
}
