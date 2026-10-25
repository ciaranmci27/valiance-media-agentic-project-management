'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/ui/Modal';
import RetainersModal from '@/components/projects/RetainersModal';
import { createClient } from '@/lib/supabase/client';
import { loadRead, peekRead } from '@/lib/query-cache';
import { projectBillingPlanRead, projectBillingRunsRead, projectForecastUntilRead, projectRetainersRead } from '@/lib/reads';
import type { BillingForecastItem, ProjectBillingPlan, ProjectBillingRun, ProjectInvoice, TeamMember } from '@/lib/types';
import { BillingForecastList } from './BillingForecastList';
import { HoursBillingForm, describePlan } from './HoursBillingForm';

export type BillingTab = 'upcoming' | 'retainers' | 'hours';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  invoices: ProjectInvoice[];
  team: TeamMember[];
  today: string;
  canManage: boolean;
  canManageSplits: boolean;
  isDemoMode: boolean;
  initialTab?: BillingTab;
}

const TABS: Array<{ key: BillingTab; label: string }> = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'retainers', label: 'Retainers' },
  { key: 'hours', label: 'Hours & terms' },
];

function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Everything that bills this project on its own: what is coming (forecast),
 * the retainers (unchanged), and when hours are drafted plus payment terms.
 * Drafts only; nothing here sends an invoice. Mount it only while open, so
 * each opening starts on initialTab.
 */
export default function BillingModal({
  isOpen, onClose, projectId, invoices, team, today, canManage, canManageSplits, isDemoMode, initialTab = 'upcoming',
}: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<BillingTab>(initialTab);
  // Cached reads (reads.ts), warmed when the Billing tab opens: the modal
  // paints what is already known and reads again behind it.
  const [plan, setPlan] = useState<ProjectBillingPlan | null>(() => peekRead(projectBillingPlanRead(projectId)) ?? null);
  const [runs, setRuns] = useState<ProjectBillingRun[]>(() => (peekRead(projectBillingRunsRead(projectId)) ?? []).slice(0, 8));
  const [forecast, setForecast] = useState<BillingForecastItem[] | null>(
    () => peekRead(projectForecastUntilRead(projectId, addMonths(today, 12))) ?? null);
  const [months, setMonths] = useState(12);
  const activeRetainers = (bundle: { retainers: Array<{ status: string; end_date: string | null }> } | undefined) =>
    (bundle?.retainers ?? []).filter((retainer) => retainer.status === 'active' && (!retainer.end_date || retainer.end_date >= today));
  const [openEndedRetainer, setOpenEndedRetainer] = useState(
    () => activeRetainers(peekRead(projectRetainersRead(projectId, false))).some((retainer) => !retainer.end_date));
  const [hasRetainer, setHasRetainer] = useState(() => activeRetainers(peekRead(projectRetainersRead(projectId, false))).length > 0);
  const [error, setError] = useState<string | null>(null);

  // `fresh` after a change made here; opening uses answers still fresh.
  const load = useCallback(async (fresh = false) => {
    if (isDemoMode) {
      setPlan(null);
      setForecast([]);
      return;
    }
    setError(null);
    try {
      const [nextPlan, nextRuns, bundle, nextForecast] = await Promise.all([
        loadRead(projectBillingPlanRead(projectId), { force: fresh }),
        loadRead(projectBillingRunsRead(projectId), { force: fresh }),
        loadRead(projectRetainersRead(projectId, false), { force: fresh }),
        loadRead(projectForecastUntilRead(projectId, addMonths(today, months)), { force: fresh }),
      ]);
      setPlan(nextPlan);
      setRuns(nextRuns.slice(0, 8));
      setForecast(nextForecast);
      const active = activeRetainers(bundle);
      setHasRetainer(active.length > 0);
      setOpenEndedRetainer(active.some((retainer) => !retainer.end_date));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Billing could not load');
    }
    // activeRetainers reads only today.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDemoMode, months, projectId, today]);

  useEffect(() => {
    if (!isOpen) return;
    const handle = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(handle);
  }, [isOpen, load]);

  const continues = openEndedRetainer || Boolean(plan && plan.hours_trigger !== 'manual' && !plan.ends_on && !plan.paused);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Billing" size="2xl">
      <p className="sr-only">
        What bills this project on its own: upcoming invoices, retainers, and when hours are drafted. Drafts are never sent without you.
      </p>
      <div className="seg-track mb-5" role="tablist" aria-label="Billing">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={`seg-item ${tab === item.key ? 'is-active' : ''}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {isDemoMode && tab !== 'retainers' ? (
        <p className="text-sm text-zinc-400">Billing schedules are disabled in demo mode.</p>
      ) : error && tab !== 'retainers' ? (
        <p className="text-sm text-red-300" role="alert">{error}</p>
      ) : null}

      {tab === 'upcoming' && !isDemoMode && !error && (
        forecast === null ? (
          <p className="text-sm text-zinc-500">Working out what is coming…</p>
        ) : (
          <div className="space-y-4">
            {plan && <p className="text-xs text-zinc-400">{describePlan(plan, hasRetainer)}</p>}
            <BillingForecastList
              items={forecast}
              continues={continues}
              onShowMore={months < 24 ? () => setMonths((value) => value + 12) : undefined}
              emptyText="Nothing bills on its own yet."
            />
          </div>
        )
      )}

      {tab === 'retainers' && (
        <RetainersModal
          embedded
          isOpen={isOpen}
          onClose={onClose}
          projectId={projectId}
          invoices={invoices}
          team={team}
          today={today}
          canManage={canManage}
          canManageSplits={canManageSplits}
          isDemoMode={isDemoMode}
          onChanged={() => void load(true)}
        />
      )}

      {tab === 'hours' && !isDemoMode && !error && (
        plan === null ? (
          <p className="text-sm text-zinc-500">Loading the schedule…</p>
        ) : (
          <HoursBillingForm
            supabase={supabase}
            projectId={projectId}
            plan={plan}
            runs={runs}
            hasRetainer={hasRetainer}
            canManage={canManage}
            today={today}
            onSaved={(saved) => { setPlan(saved); void load(true); }}
          />
        )
      )}
    </Modal>
  );
}
