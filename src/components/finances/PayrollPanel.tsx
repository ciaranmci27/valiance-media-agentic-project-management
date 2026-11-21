'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import {
  Clock3,
  DollarSign,
  Landmark,
  ListChecks,
  Plus,
  WalletCards,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { StatStrip } from '@/components/ui/StatStrip';
import { getWorkedHours } from '@/lib/time-entry-utils';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { demoPayrollData } from '@/lib/demo-data';
import { loadRead, peekRead } from '@/lib/query-cache';
import { payrollRead } from '@/lib/finance/payroll-read';
import type {
  Project,
  TeamMember,
  TeamMemberEarningAdjustment,
  TeamMemberHourlyRate,
  TeamMemberPayout,
  TeamMemberPayoutAllocation,
  TeamMemberShareEarning,
  TimeEntry,
} from '@/lib/types';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Select } from '@/components/ui/inputs/Select';
import { Avatar } from '@/components/ui/Avatar';
import { AgentSessionModal } from '@/components/finances/AgentSessionModal';

type PayrollData = {
  entries: TimeEntry[];
  rates: TeamMemberHourlyRate[];
  adjustments: TeamMemberEarningAdjustment[];
  payouts: TeamMemberPayout[];
  allocations: TeamMemberPayoutAllocation[];
  shareEarnings: TeamMemberShareEarning[];
};

const EMPTY: PayrollData = {
  entries: [],
  rates: [],
  adjustments: [],
  payouts: [],
  allocations: [],
  shareEarnings: [],
};
const money = (value: number) =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ROLE_BADGE_CLASSES: Record<TeamMember['role'], string> = {
  owner: 'bg-amber-500/15 text-amber-300',
  admin: 'bg-brand-500/15 text-brand-300',
  member: 'bg-white/[0.06] text-zinc-300',
  guest: 'bg-amber-500/15 text-amber-300',
  agent: 'bg-purple-500/15 text-purple-300',
};

type EarningsFilter = 'all' | 'pending' | 'approved' | 'unpaid';
type EarningsRow = {
  id: string;
  kind: 'time' | 'adjustment' | 'share';
  date: string;
  description: string;
  projectName: string;
  status: 'pending' | 'approved';
  amount: number;
  remaining: number;
  hours?: number;
  rate?: number;
};

/**
 * `reviewOnly` renders just the time-review queue, for a reviewer who has no
 * company-finance view: their own earnings already have a page of their own.
 */
export function PayrollPanel({ team, projects, reviewOnly = false }: { team: TeamMember[]; projects: Project[]; reviewOnly?: boolean }) {
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const canManageCompensation = hasPermission(access, 'compensation.manage');
  const canManagePayouts = hasPermission(access, 'payouts.manage');
  const canManage = canManageCompensation || canManagePayouts;
  const canApprove = hasPermission(access, 'time.approve');
  // Pay is Team pay's: with it off, review needs no rate and shows no pay.
  // Agent billed-time conversion and invoiceable hours are Client invoicing's.
  const isPayEnabled = isModuleEnabled(access, 'team_pay');
  const isInvoicingEnabled = isModuleEnabled(access, 'billing');
  // Payroll is one cached read (reads.ts), shared with the store's earnings
  // and the compensation modal: a read already made paints at once.
  const [data, setData] = useState<PayrollData>(() => {
    const cached = peekRead(payrollRead);
    return cached ? { ...EMPTY, ...cached } : EMPTY;
  });
  const [loading, setLoading] = useState(() => !peekRead(payrollRead));
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
  const [ledgerMemberId, setLedgerMemberId] = useState<string | null>(null);
  const [earningsFilter, setEarningsFilter] = useState<EarningsFilter>('all');
  const [sessionEntryId, setSessionEntryId] = useState<string | null>(null);
  const [showReviewQueue, setShowReviewQueue] = useState(false);
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
  const payableMemberIds = useMemo(
    () => new Set(payableMembers.map((member) => member.id)),
    [payableMembers],
  );
  // Approval covers every non-owner, agents included: approval gates whether
  // time becomes client-billable, which is separate from payroll (agents cost
  // $0 internally but their approved time still flows to invoices).
  const reviewableMemberIds = useMemo(
    () => new Set(team.filter((member) => member.role !== 'owner').map((member) => member.id)),
    [team],
  );
  const agentMemberIds = useMemo(
    () => new Set(team.filter((member) => member.role === 'agent').map((member) => member.id)),
    [team],
  );
  const hasPayableIdentity = canManage
    ? payableMembers.length > 0
    : payableMembers.some((member) => member.id === teamMemberId);
  // Reviewers with only agent workers still need the panel for the queue.
  const hasPanelIdentity =
    hasPayableIdentity || ((canManage || canApprove) && reviewableMemberIds.size > 0);

  // `fresh` after a write; otherwise a recent answer is used as it is.
  const load = useCallback(async (fresh = false) => {
    if (!hasPanelIdentity) return;
    if (isDemoMode) {
      setData({ ...EMPTY, ...demoPayrollData });
      setLoading(false);
      return;
    }
    if (!peekRead(payrollRead)) setLoading(true);
    try {
      setData({ ...EMPTY, ...(await loadRead(payrollRead, { force: fresh })) });
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Failed to load payroll');
    } finally {
      setLoading(false);
    }
  }, [hasPanelIdentity, isDemoMode]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const pending = useMemo(
    () =>
      data.entries.filter(
        (entry) =>
          entry.approval_status === 'pending' &&
          entry.member_id !== teamMemberId &&
          reviewableMemberIds.has(entry.member_id),
      ),
    [data.entries, reviewableMemberIds, teamMemberId],
  );
  // Recently rejected entries stay re-reviewable so an accidental reject is
  // recoverable in one click instead of requiring a token edit to resubmit.
  const rejectedRecent = useMemo(() => {
    const cutoff = Date.now() - 30 * 86_400_000;
    return data.entries.filter(
      (entry) =>
        entry.approval_status === 'rejected' &&
        entry.member_id !== teamMemberId &&
        reviewableMemberIds.has(entry.member_id) &&
        Date.parse(entry.updated_at) >= cutoff,
    );
  }, [data.entries, reviewableMemberIds, teamMemberId]);
  const reviewQueueCount = pending.length + rejectedRecent.length;
  const allocatedByEntry = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of data.allocations)
      if (row.time_entry_id)
        map.set(
          row.time_entry_id,
          (map.get(row.time_entry_id) || 0) + Number(row.allocated_amount),
        );
    return map;
  }, [data.allocations]);
  const allocatedByAdjustment = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of data.allocations)
      if (row.adjustment_id)
        map.set(
          row.adjustment_id,
          (map.get(row.adjustment_id) || 0) + Number(row.allocated_amount),
        );
    return map;
  }, [data.allocations]);

  const allocatedByShareEarning = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of data.allocations)
      if (row.share_earning_id)
        map.set(
          row.share_earning_id,
          (map.get(row.share_earning_id) || 0) + Number(row.allocated_amount),
        );
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
      const amount =
        Number(adjustment.amount) * (adjustment.adjustment_type === 'deduction' ? -1 : 1);
      const current = ensure(adjustment.member_id);
      current.earned += amount;
      current.owed += amount - (allocatedByAdjustment.get(adjustment.id) || 0);
      map.set(adjustment.member_id, current);
    }
    // Revenue-split earnings. A reversed one still counts: the deduction
    // written with the reversal is what takes it back.
    for (const earning of data.shareEarnings) {
      if (earning.voided_at) continue;
      const amount = Number(earning.amount);
      const current = ensure(earning.member_id);
      current.earned += amount;
      current.owed += amount - (allocatedByShareEarning.get(earning.id) || 0);
      map.set(earning.member_id, current);
    }
    for (const payout of data.payouts) {
      if (payout.voided_at) continue;
      const current = ensure(payout.member_id);
      current.paid += Number(payout.amount);
      map.set(payout.member_id, current);
    }
    return map;
  }, [
    allocatedByAdjustment,
    allocatedByEntry,
    allocatedByShareEarning,
    data.adjustments,
    data.entries,
    data.payouts,
    data.shareEarnings,
  ]);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const earningsRows = useMemo<EarningsRow[]>(() => {
    if (!ledgerMemberId) return [];
    const rows: EarningsRow[] = [];
    for (const entry of data.entries) {
      if (
        entry.member_id !== ledgerMemberId ||
        !['pending', 'approved'].includes(entry.approval_status || '')
      )
        continue;
      const hours = getWorkedHours(entry);
      const rate = Number(entry.compensation_rate || 0);
      const amount = hours * rate;
      rows.push({
        id: entry.id,
        kind: 'time',
        date: entry.start_time,
        description:
          entry.description || (entry.work_type === 'internal' ? 'Internal work' : 'Client work'),
        projectName: projectNames.get(entry.project_id) || 'Unknown project',
        status: entry.approval_status as 'pending' | 'approved',
        amount,
        remaining:
          entry.approval_status === 'approved'
            ? amount - (allocatedByEntry.get(entry.id) || 0)
            : amount,
        hours,
        rate,
      });
    }
    for (const adjustment of data.adjustments) {
      if (adjustment.member_id !== ledgerMemberId || adjustment.voided_at) continue;
      const amount =
        Number(adjustment.amount) * (adjustment.adjustment_type === 'deduction' ? -1 : 1);
      rows.push({
        id: adjustment.id,
        kind: 'adjustment',
        date: `${adjustment.effective_date}T00:00:00`,
        description:
          adjustment.description ||
          (adjustment.adjustment_type === 'bonus' ? 'Bonus' : 'Deduction'),
        projectName: adjustment.project_id
          ? projectNames.get(adjustment.project_id) || 'Unknown project'
          : 'General adjustment',
        status: 'approved',
        amount,
        remaining: amount - (allocatedByAdjustment.get(adjustment.id) || 0),
      });
    }
    for (const earning of data.shareEarnings) {
      if (earning.member_id !== ledgerMemberId || earning.voided_at) continue;
      const amount = Number(earning.amount);
      rows.push({
        id: earning.id,
        kind: 'share',
        date: `${earning.earned_date}T00:00:00`,
        description: [earning.invoice_number, earning.description, `${Number(earning.percent)}% share`]
          .filter(Boolean)
          .join(' - '),
        projectName: earning.project_id
          ? projectNames.get(earning.project_id) || 'Unknown project'
          : 'Deleted project',
        status: 'approved',
        amount,
        remaining: amount - (allocatedByShareEarning.get(earning.id) || 0),
      });
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }, [
    allocatedByAdjustment,
    allocatedByEntry,
    allocatedByShareEarning,
    data.adjustments,
    data.entries,
    data.shareEarnings,
    ledgerMemberId,
    projectNames,
  ]);
  const filteredEarningsRows = useMemo(
    () =>
      earningsRows.filter((row) => {
        if (earningsFilter === 'pending') return row.status === 'pending';
        if (earningsFilter === 'approved') return row.status === 'approved';
        if (earningsFilter === 'unpaid')
          return row.status === 'approved' && Math.abs(row.remaining) > 0.005;
        return true;
      }),
    [earningsFilter, earningsRows],
  );
  const earningsSummary = useMemo(
    () => ({
      approved: earningsRows
        .filter((row) => row.status === 'approved')
        .reduce((sum, row) => sum + row.amount, 0),
      pending: earningsRows
        .filter((row) => row.status === 'pending')
        .reduce((sum, row) => sum + row.amount, 0),
      unpaid: earningsRows
        .filter((row) => row.status === 'approved' && Math.abs(row.remaining) > 0.005)
        .reduce((sum, row) => sum + row.remaining, 0),
    }),
    [earningsRows],
  );
  const hasEffectiveRate = (memberId: string, startTime: string) =>
    data.rates.some(
      (rate) =>
        rate.member_id === memberId &&
        new Date(rate.effective_at).getTime() <= new Date(startTime).getTime(),
    );

  // Demo mode simulates every payroll action locally (including the agent
  // billing conversion on approval) so the full workflow is explorable
  // without touching real data. Reloading demo mode resets everything.
  const applyDemoAction = (body: Record<string, unknown>) => {
    const action = String(body.action || '');
    setData((prev) => {
      if (action === 'review') {
        const ids = new Set(Array.isArray(body.entry_ids) ? body.entry_ids.map(String) : []);
        const decision = body.decision as 'approved' | 'rejected';
        const adjustments = (
          body.adjusted_minutes && typeof body.adjusted_minutes === 'object'
            ? body.adjusted_minutes
            : {}
        ) as Record<string, number>;
        return {
          ...prev,
          entries: prev.entries.map((entry) => {
            if (
              !ids.has(entry.id) ||
              !['pending', 'rejected'].includes(entry.approval_status || '')
            )
              return entry;
            if (decision === 'rejected') {
              return {
                ...entry,
                approval_status: 'rejected' as const,
                rejection_reason: String(body.reason || ''),
              };
            }
            const updated: TimeEntry = {
              ...entry,
              approval_status: 'approved' as const,
              approved_at: new Date().toISOString(),
            };
            if (agentMemberIds.has(entry.member_id) && !entry.billing_converted_at) {
              const workedMs = adjustments[entry.id]
                ? adjustments[entry.id] * 60000
                : (entry.segments || []).reduce(
                    (total, segment) =>
                      segment.end
                        ? total + Math.max(0, Date.parse(segment.end) - Date.parse(segment.start))
                        : total,
                    0,
                  );
              const multiplier =
                entry.billing_multiplier && entry.billing_multiplier > 0
                  ? entry.billing_multiplier
                  : 1;
              if (workedMs > 0) {
                const billedEnd = new Date(
                  Date.parse(entry.start_time) + Math.round(workedMs * multiplier),
                ).toISOString();
                updated.segments = [{ start: entry.start_time, end: billedEnd }];
                updated.end_time = billedEnd;
                updated.billing_converted_at = new Date().toISOString();
              }
            }
            return updated;
          }),
        };
      }
      const nowIso = new Date().toISOString();
      if (action === 'schedule_rate') {
        return {
          ...prev,
          rates: [
            ...prev.rates,
            {
              id: crypto.randomUUID(),
              member_id: String(body.member_id),
              hourly_rate: Number(body.hourly_rate),
              effective_at: String(body.effective_at),
              created_by: teamMemberId,
              created_at: nowIso,
              updated_at: nowIso,
            },
          ],
        };
      }
      if (action === 'adjustment') {
        return {
          ...prev,
          adjustments: [
            ...prev.adjustments,
            {
              id: crypto.randomUUID(),
              member_id: String(body.member_id),
              adjustment_type: body.adjustment_type as 'bonus' | 'deduction',
              amount: Number(body.amount),
              effective_date: String(body.effective_date),
              project_id: null,
              description: String(body.description || ''),
              created_by: teamMemberId,
              voided_at: null,
              voided_by: null,
              created_at: nowIso,
              updated_at: nowIso,
            },
          ],
        };
      }
      if (action === 'payout') {
        const payoutId = crypto.randomUUID();
        const allocationRows = (Array.isArray(body.allocations) ? body.allocations : []) as {
          time_entry_id?: string | null;
          adjustment_id?: string | null;
          allocated_amount: number;
        }[];
        return {
          ...prev,
          payouts: [
            ...prev.payouts,
            {
              id: payoutId,
              member_id: String(body.member_id),
              payment_date: String(body.payment_date),
              amount: Number(body.amount),
              payment_method: String(body.payment_method || ''),
              reference: String(body.reference || ''),
              notes: '',
              created_by: teamMemberId,
              voided_at: null,
              voided_by: null,
              created_at: nowIso,
              updated_at: nowIso,
            },
          ],
          allocations: [
            ...prev.allocations,
            ...allocationRows.map((row) => ({
              id: crypto.randomUUID(),
              payout_id: payoutId,
              time_entry_id: row.time_entry_id ?? null,
              adjustment_id: row.adjustment_id ?? null,
              allocated_amount: Number(row.allocated_amount),
              created_at: nowIso,
            })),
          ],
        };
      }
      return prev;
    });
  };

  const post = async (body: Record<string, unknown>) => {
    if (isDemoMode) {
      applyDemoAction(body);
      return null;
    }
    const response = await fetch('/api/workspace/payroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Payroll action failed');
    await load(true);
    return payload.data;
  };

  // Single-entry review from the agent session modal; approval optionally
  // carries the reviewer's adjusted worked minutes into the conversion.
  const reviewSession = (
    entryId: string,
    decision: 'approved' | 'rejected',
    options?: { adjustedMinutes?: number | null; reason?: string },
  ) =>
    runExclusive(async () => {
      try {
        await post({
          action: 'review',
          entry_ids: [entryId],
          decision,
          ...(decision === 'rejected' ? { reason: options?.reason || null } : {}),
          ...(decision === 'approved' && options?.adjustedMinutes
            ? { adjusted_minutes: { [entryId]: options.adjustedMinutes } }
            : {}),
        });
        setSelected((current) => {
          const next = new Set(current);
          next.delete(entryId);
          return next;
        });
        setSessionEntryId(null);
        toast(
          'success',
          decision === 'approved'
            ? isInvoicingEnabled ? 'Session approved and converted' : 'Session approved'
            : 'Session rejected',
        );
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'Review failed');
      }
    });

  const approveSelected = () =>
    runExclusive(async () => {
      try {
        await post({ action: 'review', entry_ids: [...selected], decision: 'approved' });
        setSelected(new Set());
        toast('success', 'Selected time approved');
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'Approval failed');
      }
    });

  const rejectSelected = () =>
    runExclusive(async () => {
      try {
        await post({
          action: 'review',
          entry_ids: [...selected],
          decision: 'rejected',
          reason: rejectionReason.trim() || null,
        });
        setSelected(new Set());
        setShowReject(false);
        setRejectionReason('');
        toast('success', 'Selected time rejected');
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'Review failed');
      }
    });

  const openPayout = (memberId: string) => {
    setPayMemberId(memberId);
    setPayAmount(Math.max(0, balances.get(memberId)?.owed || 0).toFixed(2));
  };

  const openRate = (memberId: string) => {
    setRateMemberId(memberId);
    setRateAmount('');
    setShowRate(true);
  };

  const openAdjustment = (memberId: string) => {
    setAdjustmentMemberId(memberId);
    setAdjustmentType('bonus');
    setAdjustmentAmount('');
    setAdjustmentDescription('');
    setShowAdjustment(true);
  };

  const openEarnings = (memberId: string) => {
    setLedgerMemberId(memberId);
    setEarningsFilter('all');
  };

  const recordPayout = () =>
    runExclusive(async () => {
      if (!payMemberId) return;
      const amount = Number(payAmount);
      const owed = balances.get(payMemberId)?.owed || 0;
      if (!Number.isFinite(amount) || amount <= 0 || amount > owed + 0.005) {
        toast('error', 'Payment must be positive and no more than the current balance');
        return;
      }
      const allocations: Array<{
        time_entry_id?: string;
        adjustment_id?: string;
        share_earning_id?: string;
        allocated_amount: number;
      }> = [];
      const negativeAdjustments = data.adjustments
        .filter(
          (item) =>
            item.member_id === payMemberId &&
            !item.voided_at &&
            item.adjustment_type === 'deduction',
        )
        .map((item) => ({
          item,
          remaining: -Number(item.amount) - (allocatedByAdjustment.get(item.id) || 0),
        }))
        .filter((row) => row.remaining < -0.005);
      let target = amount;
      for (const row of negativeAdjustments) {
        allocations.push({ adjustment_id: row.item.id, allocated_amount: row.remaining });
        target -= row.remaining;
      }
      const positiveClaims: Array<{
        date: string;
        time_entry_id?: string;
        adjustment_id?: string;
        share_earning_id?: string;
        remaining: number;
      }> = [
        ...data.entries
          .filter(
            (entry) => entry.member_id === payMemberId && entry.approval_status === 'approved',
          )
          .map((entry) => ({
            date: entry.start_time,
            time_entry_id: entry.id,
            remaining:
              getWorkedHours(entry) * Number(entry.compensation_rate || 0) -
              (allocatedByEntry.get(entry.id) || 0),
          })),
        ...data.adjustments
          .filter(
            (item) =>
              item.member_id === payMemberId && !item.voided_at && item.adjustment_type === 'bonus',
          )
          .map((item) => ({
            date: item.effective_date,
            adjustment_id: item.id,
            remaining: Number(item.amount) - (allocatedByAdjustment.get(item.id) || 0),
          })),
        ...data.shareEarnings
          .filter((item) => item.member_id === payMemberId && !item.voided_at)
          .map((item) => ({
            date: item.earned_date,
            share_earning_id: item.id,
            remaining: Number(item.amount) - (allocatedByShareEarning.get(item.id) || 0),
          })),
      ]
        .filter((claim) => claim.remaining > 0.005)
        .sort((a, b) => a.date.localeCompare(b.date));
      for (const claim of positiveClaims) {
        if (target <= 0.005) break;
        const applied = Math.min(target, claim.remaining);
        allocations.push({
          time_entry_id: claim.time_entry_id,
          adjustment_id: claim.adjustment_id,
          share_earning_id: claim.share_earning_id,
          allocated_amount: Number(applied.toFixed(2)),
        });
        target -= applied;
      }
      if (target > 0.01)
        return toast('error', 'The payment could not be allocated to approved earnings');
      try {
        await post({
          action: 'payout',
          member_id: payMemberId,
          payment_date: new Date().toISOString().slice(0, 10),
          amount,
          payment_method: paymentMethod,
          reference: paymentReference,
          allocations,
        });
        setPayMemberId(null);
        setPaymentMethod('');
        setPaymentReference('');
        toast('success', 'Payment recorded');
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'Payment failed');
      }
    });

  const scheduleRate = () =>
    runExclusive(async () => {
      const rate = Number(rateAmount);
      if (!rateMemberId || rateAmount === '' || !Number.isFinite(rate) || rate < 0) {
        toast('error', 'Enter a valid hourly rate');
        return;
      }
      try {
        const result = (await post({
          action: 'schedule_rate',
          member_id: rateMemberId,
          hourly_rate: rate,
          effective_at: `${rateDate}T00:00:00.000Z`,
        })) as { updated_entries?: number } | null;
        setShowRate(false);
        setRateAmount('');
        const updatedEntries = Number(result?.updated_entries || 0);
        toast(
          'success',
          updatedEntries > 0
            ? `Rate scheduled and ${updatedEntries} unpaid ${updatedEntries === 1 ? 'entry' : 'entries'} recalculated`
            : 'Pay rate scheduled',
        );
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'Rate update failed');
      }
    });

  const addAdjustment = () =>
    runExclusive(async () => {
      const adjustment = Number(adjustmentAmount);
      if (
        !adjustmentMemberId ||
        adjustmentAmount === '' ||
        !Number.isFinite(adjustment) ||
        adjustment <= 0
      ) {
        toast('error', 'Enter a valid amount');
        return;
      }
      try {
        await post({
          action: 'adjustment',
          member_id: adjustmentMemberId,
          adjustment_type: adjustmentType,
          amount: adjustment,
          effective_date: new Date().toISOString().slice(0, 10),
          description: adjustmentDescription,
        });
        setShowAdjustment(false);
        setAdjustmentAmount('');
        setAdjustmentDescription('');
        toast('success', adjustmentType === 'bonus' ? 'Bonus added' : 'Deduction added');
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'Adjustment failed');
      }
    });

  const membersWithLedgerActivity = useMemo(
    () =>
      new Set([
        ...data.entries.map((entry) => entry.member_id),
        ...data.rates.map((rate) => rate.member_id),
        ...data.adjustments.map((adjustment) => adjustment.member_id),
        ...data.payouts.map((payout) => payout.member_id),
      ]),
    [data.adjustments, data.entries, data.payouts, data.rates],
  );
  const visibleMembers = reviewOnly
    ? []
    : canManage
      ? payableMembers.filter(
          (member) => member.status === 'active' || membersWithLedgerActivity.has(member.id),
        )
      : payableMembers.filter((member) => member.id === teamMemberId);
  const ownBalance = teamMemberId ? balances.get(teamMemberId) : undefined;
  const rateMember = team.find((member) => member.id === rateMemberId);
  const adjustmentMember = team.find((member) => member.id === adjustmentMemberId);
  const ledgerMember = team.find((member) => member.id === ledgerMemberId);
  // One row per person: Earned, Paid, Owed and their actions. A table on
  // wider screens, a block per person on phones, like the Team list.
  const renderPayTable = (members: TeamMember[], placeholders: boolean) => {
    const rows = members.map((member) => {
      const balance = balances.get(member.id) || { earned: 0, paid: 0, owed: 0 };
      const missingApprovedRates = placeholders
        ? 0
        : data.entries.filter(
            (entry) =>
              entry.member_id === member.id &&
              entry.approval_status === 'approved' &&
              !hasEffectiveRate(entry.member_id, entry.start_time),
          ).length;
      const actions: RowAction[] = canManage && !placeholders
        ? [
            { label: 'View earnings', icon: <ListChecks size={14} />, onClick: () => openEarnings(member.id) },
            ...(canManagePayouts && balance.owed > 0.005
              ? [{ label: 'Record payment', icon: <Landmark size={14} />, onClick: () => openPayout(member.id) }]
              : []),
            ...(canManageCompensation
              ? [
                  { label: 'Add adjustment', icon: <Plus size={14} />, onClick: () => openAdjustment(member.id) },
                  { label: 'Pay rate', icon: <DollarSign size={14} />, onClick: () => openRate(member.id) },
                ]
              : []),
          ]
        : [];
      return { member, balance, missingApprovedRates, actions };
    });
    const amount = (value: number, className: string) =>
      placeholders ? (
        <span className="inline-block h-4 w-16 rounded bg-white/[0.07] motion-safe:animate-pulse" aria-hidden="true" />
      ) : (
        <span className={`tabular-nums ${className}`}>{money(value)}</span>
      );
    const owedClass = (owed: number) => (owed > 0.005 ? 'font-medium text-amber-300' : 'text-zinc-400');
    const person = ({ member, missingApprovedRates }: (typeof rows)[number]) => (
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={member.name} src={member.avatar} size="sm" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-sm font-medium text-white">{member.name}</p>
            <span className={`flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize ${ROLE_BADGE_CLASSES[member.role]}`}>
              {member.role}
            </span>
          </div>
          {missingApprovedRates > 0 && (() => {
            const text = `${missingApprovedRates} approved ${missingApprovedRates === 1 ? 'entry needs' : 'entries need'} a pay rate`;
            return canManageCompensation ? (
              <button
                type="button"
                onClick={() => openRate(member.id)}
                className="mt-0.5 rounded text-left text-xs font-medium text-amber-300 hover:text-amber-200 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {text}. Set rate
              </button>
            ) : (
              <p className="mt-0.5 text-xs font-medium text-amber-300">{text}</p>
            );
          })()}
        </div>
      </div>
    );
    return (
      <>
        <table className="hidden w-full border-collapse text-left md:table">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th scope="col" className="px-5 py-2.5 text-xs font-semibold text-zinc-400">Person</th>
              <th scope="col" className="px-4 py-2.5 text-right text-xs font-semibold text-zinc-400">Earned</th>
              <th scope="col" className="px-4 py-2.5 text-right text-xs font-semibold text-zinc-400">Paid</th>
              <th scope="col" className="px-4 py-2.5 text-right text-xs font-semibold text-zinc-400">Owed</th>
              <th scope="col" className="w-12 px-4 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.member.id} className="border-b border-white/[0.05] last:border-0">
                <td className="px-5 py-3 align-middle">{person(row)}</td>
                <td className="px-4 py-3 text-right align-middle text-sm">{amount(row.balance.earned, 'text-zinc-200')}</td>
                <td className="px-4 py-3 text-right align-middle text-sm">{amount(row.balance.paid, 'text-zinc-300')}</td>
                <td className="px-4 py-3 text-right align-middle text-sm">{amount(row.balance.owed, owedClass(row.balance.owed))}</td>
                <td className="px-4 py-3 text-right align-middle">
                  {row.actions.length > 0 && (
                    <RowActionsMenu actions={row.actions} label={`Pay actions for ${row.member.name}`} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="divide-y divide-white/[0.06] md:hidden">
          {rows.map((row) => (
            <li key={row.member.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                {person(row)}
                {row.actions.length > 0 && (
                  <RowActionsMenu actions={row.actions} label={`Pay actions for ${row.member.name}`} />
                )}
              </div>
              <dl className="mt-2.5 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-zinc-500">Earned</dt>
                  <dd className="mt-0.5">{amount(row.balance.earned, 'text-zinc-200')}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Paid</dt>
                  <dd className="mt-0.5">{amount(row.balance.paid, 'text-zinc-300')}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Owed</dt>
                  <dd className="mt-0.5">{amount(row.balance.owed, owedClass(row.balance.owed))}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </>
    );
  };

  if (!hasPanelIdentity) return null;
  // Whether this panel has anything to show depends on fetched data, so while
  // that is in flight it renders only when the store ALREADY proves there is
  // content: someone payable on the team. With an all-agent roster there is
  // nobody to pay, and the panel used to paint its header and a loading line
  // before discovering that and removing itself, which read as the page
  // breaking. Now it either appears once, complete, or never appears.
  if (loading && (reviewOnly || !hasPayableIdentity)) return null;
  if (!reviewOnly && !loading && visibleMembers.length === 0 && pending.length === 0) return null;

  return (
    <section className="rounded-xl border border-white/[0.08] bg-surface-raised">
      <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            {isPayEnabled
              ? <WalletCards size={18} className="text-brand-300" />
              : <Clock3 size={18} className="text-brand-300" aria-hidden="true" />}
            <h2 className="font-semibold text-white">
              {reviewOnly ? 'Time review' : canManage ? 'Team pay' : 'My earnings'}
            </h2>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            {reviewOnly
              ? 'Submitted hours from the projects you review.'
              : 'Approved work, adjustments, and recorded payments in one ledger.'}
          </p>
        </div>
        {canApprove && reviewQueueCount > 0 && (
          <button
            type="button"
            onClick={() => setShowReviewQueue(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-surface-raised px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-white/[0.12] hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
          >
            <Clock3 size={14} className="text-amber-400" aria-hidden="true" />
            Review hours
            {pending.length > 0 && (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-amber-300">
                {pending.length}
              </span>
            )}
          </button>
        )}
      </div>

      {loading ? (
        // The ledger's figures come from the server, so they cannot exist on
        // first paint. Everything else can: the roster is already in the store,
        // so the panel opens in its final shape with real names, and only the
        // amounts resolve. Nothing moves when they land.
        <>
          {renderPayTable(canManage ? payableMembers : payableMembers.filter((member) => member.id === teamMemberId), true)}
          <span className="sr-only" role="status">
            Loading team pay
          </span>
        </>
      ) : (
        <>
          <Modal
            isOpen={showReviewQueue && canApprove && reviewQueueCount > 0}
            onClose={() => setShowReviewQueue(false)}
            title="Hours awaiting review"
            size="2xl"
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-zinc-400">
                  {pending.length} submitted {pending.length === 1 ? 'entry' : 'entries'}.
                  {isInvoicingEnabled ? (
                    <>
                      {' '}Approving makes the hours invoiceable
                      {pending.some((entry) => agentMemberIds.has(entry.member_id))
                        ? '; agent sessions convert on approval'
                        : ''}
                      .
                    </>
                  ) : ' Approving accepts the hours as worked.'}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={selected.size === 0 || submitting}
                    onClick={() => setShowReject(true)}
                  >
                    Reject selected
                  </Button>
                  <Button
                    size="sm"
                    disabled={selected.size === 0 || submitting}
                    onClick={approveSelected}
                  >
                    Approve selected
                  </Button>
                </div>
              </div>
              <div className="max-h-[55vh] space-y-1.5 overflow-y-auto">
                {pending.map((entry) => {
                  const member = team.find((item) => item.id === entry.member_id);
                  const hours = getWorkedHours(entry);
                  // Agents have no compensation rate by design ($0 internal
                  // cost); their entries are approvable without one.
                  const isAgentEntry = agentMemberIds.has(entry.member_id);
                  const missingRate =
                    isPayEnabled && !isAgentEntry && !hasEffectiveRate(entry.member_id, entry.start_time);
                  return (
                    <Checkbox
                      key={entry.id}
                      checked={selected.has(entry.id)}
                      disabled={missingRate}
                      onChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(entry.id);
                          else next.delete(entry.id);
                          return next;
                        })
                      }
                      className="w-full items-center rounded-lg border border-white/[0.08] bg-surface-raised px-3.5 py-2.5 transition-colors hover:border-white/[0.12]"
                      label={
                        <span className="flex w-full min-w-0 items-center gap-4 font-normal">
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="text-sm font-medium text-zinc-100">
                                {member?.name || 'Team member'}
                              </span>
                              {isAgentEntry && (
                                <span className="flex-shrink-0 rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-300">
                                  AI agent
                                </span>
                              )}
                              <span className="flex-shrink-0 text-[11px] text-zinc-500">
                                {new Date(entry.start_time).toLocaleDateString('en-US', {
                                  month: 'short',
                                  day: 'numeric',
                                })}
                              </span>
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-zinc-400">
                              {entry.description || 'No description'}
                            </span>
                          </span>
                          <span className="flex flex-shrink-0 items-center gap-3">
                            {isAgentEntry && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setShowReviewQueue(false);
                                  setSessionEntryId(entry.id);
                                }}
                                className="rounded-lg border border-brand-500/30 bg-brand-500/15 px-2.5 py-1.5 text-xs font-medium text-brand-300 transition-colors hover:bg-brand-500/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
                              >
                                Review
                              </button>
                            )}
                            <span className="text-right">
                              <span className="block text-sm font-semibold tabular-nums text-white">
                                {hours.toFixed(2)}
                                <span className="ml-0.5 text-xs font-normal text-zinc-500">h</span>
                              </span>
                              {isPayEnabled && !isAgentEntry && !missingRate && (
                                <span className="block text-[11px] tabular-nums text-zinc-500">
                                  {money(hours * Number(entry.compensation_rate || 0))}
                                </span>
                              )}
                              {missingRate && (
                                <span className="block text-[11px] font-semibold text-red-400">
                                  Rate required
                                </span>
                              )}
                            </span>
                          </span>
                        </span>
                      }
                    />
                  );
                })}
                {pending.length === 0 && (
                  <p className="py-2 text-center text-xs text-zinc-500">Nothing awaiting review.</p>
                )}
              </div>

              {rejectedRecent.length > 0 && (
                <div className="border-t border-white/[0.06] pt-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Recently rejected
                  </p>
                  <div className="max-h-40 space-y-1.5 overflow-y-auto">
                    {rejectedRecent.map((entry) => {
                      const member = team.find((item) => item.id === entry.member_id);
                      const hours = getWorkedHours(entry);
                      const isAgentEntry = agentMemberIds.has(entry.member_id);
                      return (
                        <div
                          key={entry.id}
                          className="flex w-full min-w-0 items-center gap-4 rounded-lg border border-white/[0.08] bg-surface-raised px-3.5 py-2.5"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="text-sm font-medium text-zinc-100">
                                {member?.name || 'Team member'}
                              </span>
                              {isAgentEntry && (
                                <span className="flex-shrink-0 rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-300">
                                  AI agent
                                </span>
                              )}
                              <span className="flex-shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                                Rejected
                              </span>
                              <span className="flex-shrink-0 text-[11px] text-zinc-500">
                                {new Date(entry.start_time).toLocaleDateString('en-US', {
                                  month: 'short',
                                  day: 'numeric',
                                })}
                              </span>
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-zinc-400">
                              {entry.rejection_reason || entry.description || 'No description'}
                            </span>
                          </span>
                          <span className="flex flex-shrink-0 items-center gap-3">
                            {isAgentEntry ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setShowReviewQueue(false);
                                  setSessionEntryId(entry.id);
                                }}
                                className="rounded-lg border border-brand-500/30 bg-brand-500/15 px-2.5 py-1.5 text-xs font-medium text-brand-300 transition-colors hover:bg-brand-500/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
                              >
                                Review
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={submitting}
                                onClick={() => reviewSession(entry.id, 'approved')}
                                className="rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50"
                              >
                                Approve
                              </button>
                            )}
                            <span className="text-right text-sm font-semibold tabular-nums text-white">
                              {hours.toFixed(2)}
                              <span className="ml-0.5 text-xs font-normal text-zinc-500">h</span>
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </Modal>

          {reviewOnly && (
            <p className="px-5 py-4 text-sm text-zinc-400">
              {pending.length === 0
                ? 'No hours are waiting for review.'
                : `${pending.length} submitted ${pending.length === 1 ? 'entry is' : 'entries are'} waiting. Open Review hours to approve or reject.`}
            </p>
          )}
          {!reviewOnly && renderPayTable(canManage ? visibleMembers : visibleMembers.slice(0, 1), false)}
          {!canManage && !reviewOnly && ownBalance && data.payouts.length > 0 && (
            <div className="px-5 py-3 border-t border-white/[0.06] text-xs text-zinc-400">
              Latest payment: {money(Number(data.payouts[0].amount))} on{' '}
              {new Date(`${data.payouts[0].payment_date}T00:00:00`).toLocaleDateString()}
            </div>
          )}
        </>
      )}

      <Modal
        isOpen={Boolean(ledgerMemberId)}
        onClose={() => setLedgerMemberId(null)}
        title={`${ledgerMember?.name || 'Team member'} earnings`}
        size="4xl"
      >
        <div className="space-y-4">
          <StatStrip
            label="Earnings summary"
            stats={[
              { label: 'Approved', value: money(earningsSummary.approved), tone: 'success' },
              { label: 'Pending', value: money(earningsSummary.pending), tone: 'warning' },
              {
                label: 'Paid',
                value: money(ledgerMemberId ? balances.get(ledgerMemberId)?.paid || 0 : 0),
                tone: 'success',
              },
              { label: 'Unpaid', value: money(earningsSummary.unpaid), tone: 'warning' },
            ]}
          />

          <div className="seg-track flex-wrap">
            {(
              [
                ['all', 'All'],
                ['pending', 'Pending'],
                ['approved', 'Approved'],
                ['unpaid', 'Unpaid'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setEarningsFilter(value)}
                className={`seg-item ${earningsFilter === value ? 'is-active' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>

          {filteredEarningsRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/[0.08] px-6 py-10 text-center text-sm text-zinc-400">
              No {earningsFilter === 'all' ? '' : `${earningsFilter} `}earnings found.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-white/[0.08]">
              <div className="hidden grid-cols-[minmax(0,1fr)_110px_90px_110px] gap-4 border-b border-white/[0.06] bg-white/[0.03] px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-zinc-500 md:grid">
                <span>Earning</span>
                <span className="text-right">Time</span>
                <span className="text-right">Status</span>
                <span className="text-right">Amount</span>
              </div>
              <div className="max-h-[48vh] divide-y divide-white/[0.06] overflow-y-auto">
                {filteredEarningsRows.map((row) => {
                  const unpaid = row.status === 'approved' && Math.abs(row.remaining) > 0.005;
                  const statusLabel =
                    row.status === 'pending'
                      ? 'Pending'
                      : row.amount < 0
                        ? 'Adjustment'
                        : unpaid
                          ? 'Unpaid'
                          : row.amount > 0
                            ? 'Paid'
                            : 'Approved';
                  const statusClass =
                    row.status === 'pending'
                      ? 'bg-amber-500/15 text-amber-300'
                      : unpaid
                        ? 'bg-orange-500/15 text-orange-300'
                        : 'bg-emerald-500/15 text-emerald-300';
                  return (
                    <div
                      key={`${row.kind}-${row.id}`}
                      className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_110px_90px_110px] md:items-center md:gap-4"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-white">
                            {row.description}
                          </p>
                          {row.kind === 'adjustment' && (
                            <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                              Adjustment
                            </span>
                          )}
                          {row.kind === 'share' && (
                            <span className="rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-medium text-brand-300">
                              Revenue share
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-zinc-400">
                          {row.projectName} · {new Date(row.date).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="text-left text-xs tabular-nums text-zinc-400 md:text-right">
                        {row.hours !== undefined ? (
                          <>
                            <span className="font-medium text-zinc-300">
                              {row.hours.toFixed(2)}h
                            </span>
                            <span className="block">{money(row.rate || 0)}/hr</span>
                          </>
                        ) : (
                          'One-time'
                        )}
                      </div>
                      <div className="md:text-right">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusClass}`}
                        >
                          {statusLabel}
                        </span>
                      </div>
                      <div className="text-left md:text-right">
                        <p
                          className={`text-sm font-semibold tabular-nums ${row.amount < 0 ? 'text-red-400' : 'text-white'}`}
                        >
                          {money(row.amount)}
                        </p>
                        {unpaid && (
                          <p className="text-[10px] font-medium text-orange-400">
                            {money(row.remaining)} remaining
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(payMemberId)}
        onClose={() => setPayMemberId(null)}
        title="Record team payment"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-300">
            This payment will be allocated against approved earnings in FIFO order.
          </p>
          <NumberInput
            label="Amount"
            min={0.01}
            step={0.01}
            prefix="$"
            value={payAmount === '' ? '' : Number(payAmount)}
            onChange={(value) => setPayAmount(value === '' ? '' : String(value))}
          />
          <TextInput
            label="Payment method"
            value={paymentMethod}
            onChange={setPaymentMethod}
            placeholder="ACH, check, cash..."
          />
          <TextInput
            label="Reference"
            value={paymentReference}
            onChange={setPaymentReference}
            placeholder="Optional transaction reference"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPayMemberId(null)}>
              Cancel
            </Button>
            <Button onClick={recordPayout} disabled={submitting}>
              Record payment
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showReject}
        onClose={() => setShowReject(false)}
        title="Reject selected time"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-300">
            The team member can correct a rejected entry. Saving the correction will submit it for
            review again.
          </p>
          <Textarea
            label="Reason"
            value={rejectionReason}
            onChange={setRejectionReason}
            placeholder="Explain what needs to be corrected"
            rows={3}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowReject(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={rejectSelected} disabled={submitting}>
              Reject time
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showRate}
        onClose={() => setShowRate(false)}
        title={`Pay rate for ${rateMember?.name || 'team member'}`}
        size="sm"
      >
        <div className="space-y-4">
          <NumberInput
            label="Hourly rate"
            min={0}
            step={0.01}
            prefix="$"
            suffix="/hr"
            value={rateAmount === '' ? '' : Number(rateAmount)}
            onChange={(value) => setRateAmount(value === '' ? '' : String(value))}
          />
          <DateInput label="Effective date" value={rateDate} onChange={setRateDate} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowRate(false)}>
              Cancel
            </Button>
            <Button onClick={scheduleRate} disabled={submitting}>
              Schedule rate
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        isOpen={showAdjustment}
        onClose={() => setShowAdjustment(false)}
        title={`Adjust earnings for ${adjustmentMember?.name || 'team member'}`}
        size="sm"
      >
        <div className="space-y-4">
          <Select
            label="Type"
            value={adjustmentType}
            onChange={(value) => setAdjustmentType(value as 'bonus' | 'deduction')}
            options={[
              { value: 'bonus', label: 'Bonus' },
              { value: 'deduction', label: 'Deduction' },
            ]}
          />
          <NumberInput
            label="Amount"
            min={0.01}
            step={0.01}
            prefix="$"
            value={adjustmentAmount === '' ? '' : Number(adjustmentAmount)}
            onChange={(value) => setAdjustmentAmount(value === '' ? '' : String(value))}
          />
          <TextInput
            label="Description"
            value={adjustmentDescription}
            onChange={setAdjustmentDescription}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowAdjustment(false)}>
              Cancel
            </Button>
            <Button onClick={addAdjustment} disabled={submitting}>
              Add adjustment
            </Button>
          </div>
        </div>
      </Modal>
      {sessionEntryId &&
        (() => {
          const sessionEntry = data.entries.find((item) => item.id === sessionEntryId);
          if (!sessionEntry) return null;
          return (
            <AgentSessionModal
              entry={sessionEntry}
              member={team.find((item) => item.id === sessionEntry.member_id)}
              projectName={
                projects.find((project) => project.id === sessionEntry.project_id)?.name ||
                'Project'
              }
              submitting={submitting}
              onApprove={(adjustedMinutes) =>
                reviewSession(sessionEntry.id, 'approved', { adjustedMinutes })
              }
              onReject={(reason) => reviewSession(sessionEntry.id, 'rejected', { reason })}
              onClose={() => {
                setSessionEntryId(null);
                setShowReviewQueue(true);
              }}
            />
          );
        })()}
    </section>
  );
}
