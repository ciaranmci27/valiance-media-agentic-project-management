'use client';

import { useMemo, useState } from 'react';
import { CalendarRange, FolderKanban, TrendingUp } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { getWorkedHoursByDay } from '@/lib/time-entry-utils';
import { computeMemberEarningsSummary } from '@/lib/finance/summary';
import type {
  EmployeeEarningsData,
  Project,
} from '@/lib/types';

type RangePreset = '7d' | '30d' | '90d' | 'all';

const RANGE_OPTIONS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatMoney(value: number): string {
  const absolute = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-$${absolute}` : `$${absolute}`;
}

function formatAxis(value: number): string {
  if (value === 0) return '$0';
  const prefix = value < 0 ? '-$' : '$';
  const absolute = Math.abs(value);
  return absolute >= 1000
    ? `${prefix}${(absolute / 1000).toFixed(absolute % 1000 === 0 ? 0 : 1)}K`
    : `${prefix}${Math.round(absolute)}`;
}

function niceStep(span: number): number {
  const raw = Math.max(span, 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  if (residual <= 1) return magnitude;
  if (residual <= 2) return 2 * magnitude;
  if (residual <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

export function EmployeeEarningsDashboard({ projects, data }: { projects: Project[]; data: EmployeeEarningsData }) {
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [showApproved, setShowApproved] = useState(true);
  const [showPending, setShowPending] = useState(true);

  const dashboard = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = toDateKey(today);
    const earliestKeys = [
      ...data.entries.map(entry => toDateKey(new Date(entry.start_time))),
      ...data.adjustments.filter(item => !item.voided_at).map(item => item.effective_date),
    ].sort();
    const daysBack = preset === '7d' ? 6 : preset === '30d' ? 29 : preset === '90d' ? 89 : null;
    const startDate = new Date(today);
    if (daysBack !== null) startDate.setDate(startDate.getDate() - daysBack);
    const startKey = daysBack === null ? (earliestKeys[0] || todayKey) : toDateKey(startDate);
    const dayCount = Math.max(1, Math.round((today.getTime() - new Date(`${startKey}T00:00:00`).getTime()) / 86400000) + 1);
    const bars = Array.from({ length: dayCount }, (_, index) => {
      const date = new Date(`${startKey}T00:00:00`);
      date.setDate(date.getDate() + index);
      const dateKey = toDateKey(date);
      return {
        dateKey,
        label: dateKey === todayKey ? 'Today' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        approved: 0,
        pending: 0,
      };
    });
    const barByDate = new Map(bars.map(bar => [bar.dateKey, bar]));
    const projectRows = new Map<string, { approved: number; pending: number; hours: number }>();
    let pending = 0;
    let hours = 0;

    for (const entry of data.entries) {
      if (entry.approval_status !== 'approved' && entry.approval_status !== 'pending') continue;
      const rate = Number(entry.compensation_rate || 0);
      for (const [dateKey, workedHours] of getWorkedHoursByDay(entry)) {
        if (dateKey < startKey || dateKey > todayKey) continue;
        const amount = workedHours * rate;
        const bar = barByDate.get(dateKey);
        const projectRow = projectRows.get(entry.project_id) || { approved: 0, pending: 0, hours: 0 };
        projectRow.hours += workedHours;
        hours += workedHours;
        if (entry.approval_status === 'approved') {
          projectRow.approved += amount;
          if (bar) bar.approved += amount;
        } else {
          pending += amount;
          projectRow.pending += amount;
          if (bar) bar.pending += amount;
        }
        projectRows.set(entry.project_id, projectRow);
      }
    }

    for (const adjustment of data.adjustments) {
      if (adjustment.voided_at || adjustment.effective_date < startKey || adjustment.effective_date > todayKey) continue;
      const amount = Number(adjustment.amount) * (adjustment.adjustment_type === 'deduction' ? -1 : 1);
      const bar = barByDate.get(adjustment.effective_date);
      if (bar) bar.approved += amount;
      if (adjustment.project_id) {
        const row = projectRows.get(adjustment.project_id) || { approved: 0, pending: 0, hours: 0 };
        row.approved += amount;
        projectRows.set(adjustment.project_id, row);
      }
    }

    const paid = data.payouts
      .filter(payout => !payout.voided_at && payout.payment_date >= startKey && payout.payment_date <= todayKey)
      .reduce((sum, payout) => sum + Number(payout.amount), 0);
    // Headline approved-earned (in range) + all-time owed come from the shared finance
    // summary so they match the Dashboard's "Earned"/"Owed" cards exactly.
    const { earned: approved, owed } = computeMemberEarningsSummary(data, { startKey, endKey: todayKey });

    const projectLookup = new Map(projects.map(project => [project.id, project]));
    const byProject = Array.from(projectRows.entries())
      .map(([projectId, values]) => ({
        projectId,
        name: projectLookup.get(projectId)?.name || 'Unknown project',
        color: projectLookup.get(projectId)?.color || '#a1a1aa',
        ...values,
      }))
      .sort((a, b) => (b.approved + b.pending) - (a.approved + a.pending));

    return { startKey, todayKey, bars, approved, pending, paid, owed, hours, byProject };
  }, [data, preset, projects]);

  const visibleValues = dashboard.bars.map(bar => {
    const approved = showApproved ? bar.approved : 0;
    const pending = showPending ? bar.pending : 0;
    return { positive: Math.max(0, approved) + Math.max(0, pending), negative: Math.min(0, approved) };
  });
  const rawMax = Math.max(1, ...visibleValues.map(value => value.positive));
  const rawMin = Math.min(0, ...visibleValues.map(value => value.negative));
  const step = niceStep(rawMax - rawMin);
  const axisMax = Math.max(step, Math.ceil(rawMax / step) * step);
  const axisMin = Math.min(0, Math.floor(rawMin / step) * step);
  const axisRange = axisMax - axisMin;
  const zeroBottom = Math.abs(axisMin) / axisRange * 100;
  const positiveArea = axisMax / axisRange * 100;
  const negativeArea = Math.abs(axisMin) / axisRange * 100;
  const axisTicks: number[] = [];
  for (let value = axisMin; value <= axisMax + step / 2; value += step) axisTicks.push(value);
  const hasChartData = dashboard.bars.some(bar => Math.abs(bar.approved) > 0.005 || bar.pending > 0.005);

  return (
    <div className="space-y-4 lg:space-y-6">
      <section className="rounded-xl border border-white/[0.08] bg-surface-raised">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2">
            <CalendarRange size={18} className="text-zinc-400" />
            <h2 className="font-semibold text-white">Overview</h2>
          </div>
          <div className="w-40"><Select size="sm" ariaLabel="Earnings date range" value={preset} onChange={value => setPreset(value as RangePreset)} options={RANGE_OPTIONS} /></div>
        </div>
        <div className="grid grid-cols-2 gap-5 px-5 py-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Earned" value={formatMoney(dashboard.approved)} tone="approved" />
          <Stat label="Pending" value={formatMoney(dashboard.pending)} tone="pending" />
          <Stat label="Paid" value={formatMoney(dashboard.paid)} tone="approved" />
          <Stat label="Owed (all-time)" value={formatMoney(dashboard.owed)} tone="pending" />
          <Stat label="Hours" value={`${dashboard.hours.toFixed(1)}h`} />
        </div>
      </section>

      <section className="rounded-xl border border-white/[0.08] bg-surface-raised">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2"><TrendingUp size={18} className="text-zinc-400" /><h2 className="font-semibold text-white">Daily Earnings</h2></div>
          <span className="text-xs font-medium text-zinc-500">{RANGE_OPTIONS.find(option => option.value === preset)?.label}</span>
        </div>
        <div className="px-5 pb-4 pt-5">
          {!showApproved && !showPending ? (
            <ChartEmpty title="No data series selected" detail="Turn on Approved or Pending below" />
          ) : !hasChartData ? (
            <ChartEmpty title="No earnings in this range" detail="Submitted and approved time will appear here" />
          ) : (
            <div className="flex h-72 gap-2">
              <div className="flex w-12 flex-col justify-between py-0.5 text-right">
                {[...axisTicks].reverse().map(tick => <span key={tick} className="text-[10px] font-medium text-zinc-500">{formatAxis(tick)}</span>)}
              </div>
              <div className="relative flex-1">
                {axisTicks.map(tick => <div key={tick} className={`absolute inset-x-0 border-t ${tick === 0 && axisMin < 0 ? 'border-white/[0.12]' : 'border-white/[0.06]'}`} style={{ top: `${(axisMax - tick) / axisRange * 100}%` }} />)}
                <div className="relative z-[1] flex h-full items-stretch gap-[3px]">
                  {dashboard.bars.map((bar, index) => {
                    const approved = showApproved ? bar.approved : 0;
                    const pending = showPending ? bar.pending : 0;
                    const approvedPositive = Math.max(0, approved);
                    const approvedNegative = Math.min(0, approved);
                    const approvedPositiveHeight = approvedPositive / axisMax * 100;
                    const pendingHeight = pending / axisMax * 100;
                    const negativeHeight = axisMin < 0 ? Math.abs(approvedNegative) / Math.abs(axisMin) * 100 : 0;
                    const labelStep = Math.max(1, Math.floor(dashboard.bars.length / 6));
                    const showLabel = index === 0 || index === dashboard.bars.length - 1 || index % labelStep === 0;
                    return (
                      <div key={bar.dateKey} className="group relative min-w-0 flex-1">
                        <div className="absolute inset-x-0 flex flex-col justify-end" style={{ bottom: `${zeroBottom}%`, height: `${positiveArea}%` }}>
                          {pending > 0 && <div className="w-full rounded-t bg-amber-300 transition-colors group-hover:bg-amber-400" style={{ height: `${Math.max(pendingHeight, 1.5)}%` }} />}
                          {approvedPositive > 0 && <div className={`w-full bg-emerald-500 transition-colors group-hover:bg-emerald-600 ${pending <= 0 ? 'rounded-t' : ''}`} style={{ height: `${Math.max(approvedPositiveHeight, 1.5)}%` }} />}
                        </div>
                        {approvedNegative < 0 && <div className="absolute inset-x-0" style={{ top: `${positiveArea}%`, height: `${negativeArea}%` }}><div className="w-full rounded-b bg-rose-400" style={{ height: `${Math.max(negativeHeight, 2)}%` }} /></div>}
                        {(Math.abs(approved) > 0.005 || pending > 0.005) && (
                          <div className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-20 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-surface-overlay border border-white/[0.08] px-2.5 py-2 text-[10px] text-white shadow-lg group-hover:block">
                            <p className="mb-1 font-semibold text-zinc-200">{bar.label}</p>
                            {Math.abs(approved) > 0.005 && <p>Approved <span className="ml-2 font-semibold">{formatMoney(approved)}</span></p>}
                            {pending > 0.005 && <p>Pending <span className="ml-2 font-semibold">{formatMoney(pending)}</span></p>}
                          </div>
                        )}
                        {showLabel && <span className="absolute top-[calc(100%+8px)] left-1/2 w-16 -translate-x-1/2 truncate text-center text-[10px] font-medium text-zinc-500">{bar.label}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3">
            <LegendButton label="Approved" active={showApproved} color="bg-emerald-500" activeClass="bg-emerald-500/15" onClick={() => setShowApproved(value => !value)} />
            <LegendButton label="Pending" active={showPending} color="bg-amber-300" activeClass="bg-amber-500/15" onClick={() => setShowPending(value => !value)} />
          </div>
        </div>
      </section>

      {dashboard.byProject.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-white/[0.08] bg-surface-raised">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-4"><FolderKanban size={18} className="text-zinc-400" /><h2 className="font-semibold text-white">By Project</h2></div>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-5 border-b border-white/[0.06] px-5 py-2 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            <span>Project</span><span className="w-24 text-right">Approved</span><span className="w-24 text-right">Pending</span><span className="w-20 text-right">Hours</span>
          </div>
          <div className="divide-y divide-white/[0.06]">
            {dashboard.byProject.map(project => (
              <div key={project.projectId} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-5 px-5 py-3.5">
                <div className="flex min-w-0 items-center gap-2.5"><span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: project.color }} /><span className="truncate text-sm font-medium text-white">{project.name}</span></div>
                <span className="w-24 text-right text-sm font-semibold text-emerald-400">{formatMoney(project.approved)}</span>
                <span className="w-24 text-right text-sm font-semibold text-amber-400">{formatMoney(project.pending)}</span>
                <span className="w-20 text-right text-sm font-medium text-violet-400">{project.hours.toFixed(1)}h</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'approved' | 'pending' }) {
  const color = tone === 'approved' ? 'text-emerald-400' : tone === 'pending' ? 'text-amber-400' : 'text-white';
  return <div><p className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</p><p className={`text-sm font-semibold ${color}`}>{value}</p></div>;
}

function ChartEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="flex h-72 flex-col items-center justify-center text-center"><span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06]"><TrendingUp size={18} className="text-zinc-500" /></span><p className="text-sm font-medium text-zinc-400">{title}</p><p className="mt-1 text-xs text-zinc-500">{detail}</p></div>;
}

function LegendButton({ label, active, color, activeClass, onClick }: { label: string; active: boolean; color: string; activeClass: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${active ? activeClass : 'opacity-40 hover:opacity-70'}`}><span className={`h-2.5 w-2.5 rounded-sm ${active ? color : 'bg-zinc-300'}`} /><span className="text-[11px] font-medium text-zinc-300">{label}</span></button>;
}
