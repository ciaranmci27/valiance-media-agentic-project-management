'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CalendarClock } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Select } from '@/components/ui/inputs/Select';
import { BillingForecastList, money } from '@/components/projects/billing/BillingForecastList';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { useDemo } from '@/lib/demo-context';
import { createClient } from '@/lib/supabase/client';
import { fetchBillingForecast } from '@/lib/supabase/queries';
import type { BillingForecastItem } from '@/lib/types';

const RANGES = [
  { value: '3', label: 'Next 3 months' },
  { value: '6', label: 'Next 6 months' },
  { value: '12', label: 'Next 12 months' },
];

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Every invoice that bills on its own, across projects: retainers and
 * scheduled hours, by month, with exact amounts apart from estimates.
 * Answers "what will I bill in November" in one place. Read only.
 */
export default function BillingCalendarPage() {
  const router = useRouter();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const supabase = useMemo(() => createClient(), []);
  const canRead = hasPermission(access, 'invoices.read');
  const [months, setMonths] = useState('6');
  const [projectFilter, setProjectFilter] = useState('');
  const [items, setItems] = useState<BillingForecastItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canRead || isDemoMode) return;
    setError(null);
    try {
      const from = today();
      setItems(await fetchBillingForecast(supabase, null, { from, until: addMonths(from, Number(months)) }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Upcoming invoices could not load');
    }
  }, [canRead, isDemoMode, months, supabase]);

  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items ?? []) if (item.project_id && item.project_name) seen.set(item.project_id, item.project_name);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);
  const visible = (items ?? []).filter((item) => !projectFilter || item.project_id === projectFilter);
  const exact = visible.reduce((sum, item) => sum + item.exact, 0);
  const estimated = visible.reduce((sum, item) => sum + item.estimated, 0);
  const drafted = visible.filter((item) => item.status === 'draft').length;

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Upcoming invoices"
        subtitle={<span className="hidden sm:inline">Everything that bills on its own: retainers and scheduled hours. Drafts are never sent without you.</span>}
        actions={(
          <Link
            href="/finances"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-zinc-300 border border-white/[0.08] bg-surface-raised hover:bg-white/[0.03] hover:text-white rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Finances
          </Link>
        )}
      />

      <div className="p-4 lg:p-6 space-y-4 lg:space-y-6">
        {!canRead ? (
          <div className="rounded-xl border border-white/[0.08] bg-surface-raised p-8 text-center text-sm text-zinc-400">
            You do not have access to invoices.
          </div>
        ) : isDemoMode ? (
          <div className="rounded-xl border border-white/[0.08] bg-surface-raised p-8 text-center text-sm text-zinc-400">
            Upcoming invoices are not available in demo mode.
          </div>
        ) : (
          <div className="glass-card rounded-xl">
            <div className="px-5 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/[0.06]">
              <div className="flex items-center gap-2">
                <CalendarClock size={18} className="text-zinc-400" aria-hidden="true" />
                <h2 className="font-semibold text-white">Billing calendar</h2>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                {projects.length > 1 && (
                  <div className="w-full sm:w-56">
                    <Select
                      ariaLabel="Project"
                      value={projectFilter}
                      onChange={setProjectFilter}
                      options={[{ value: '', label: 'All projects' }, ...projects.map(([id, name]) => ({ value: id, label: name }))]}
                    />
                  </div>
                )}
                <div className="w-full sm:w-44">
                  <Select ariaLabel="Range" value={months} onChange={setMonths} options={RANGES} />
                </div>
              </div>
            </div>

            {items !== null && visible.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-white/[0.06] border-b border-white/[0.06]">
                <div className="bg-surface-raised/40 px-5 py-3.5">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500">Fixed (exact)</p>
                  <p className="mt-1 text-lg font-semibold text-white tabular-nums">{money(exact)}</p>
                </div>
                <div className="bg-surface-raised/40 px-5 py-3.5">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500">Hours (estimated)</p>
                  <p className="mt-1 text-lg font-semibold text-zinc-300 tabular-nums">~{money(estimated)}</p>
                </div>
                <div className="bg-surface-raised/40 px-5 py-3.5 col-span-2 sm:col-span-1">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500">Drafted, waiting on you</p>
                  <p className="mt-1 text-lg font-semibold text-white tabular-nums">{drafted}</p>
                </div>
              </div>
            )}

            <div className="p-5">
              {error ? (
                <p className="text-sm text-red-300" role="alert">{error}</p>
              ) : items === null ? (
                <p className="text-sm text-zinc-500">Working out what is coming…</p>
              ) : (
                <BillingForecastList
                  items={visible}
                  showProject
                  emptyText="Nothing bills on its own in this range."
                  onOpenProject={(projectId) => router.push(`/projects/${projectId}?tab=invoices`)}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
