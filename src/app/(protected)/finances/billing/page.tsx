'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock, ChevronLeft } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Select } from '@/components/ui/inputs/Select';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatStrip } from '@/components/ui/StatStrip';
import { BillingForecastList, money } from '@/components/projects/billing/BillingForecastList';
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
  const { isDemoMode } = useDemo();
  const supabase = useMemo(() => createClient(), []);
  const [months, setMonths] = useState('6');
  const [projectFilter, setProjectFilter] = useState('');
  const [items, setItems] = useState<BillingForecastItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (isDemoMode) return;
    setError(null);
    try {
      const from = today();
      setItems(await fetchBillingForecast(supabase, null, { from, until: addMonths(from, Number(months)) }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Upcoming invoices could not load');
    }
  }, [isDemoMode, months, supabase]);

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

  const back = (
    <Link
      href="/finances"
      className="inline-flex items-center gap-1 text-zinc-400 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
    >
      <ChevronLeft size={14} aria-hidden="true" />
      Finances
    </Link>
  );

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header title="Upcoming invoices" subtitle={back} />

      <div className="p-4 lg:p-6 space-y-6">
        {isDemoMode ? (
          <EmptyState framed icon={<CalendarClock />} title="Not in demo mode" description="Upcoming invoices show here in a real workspace." />
        ) : (
          <Card
            title="Billing calendar"
            icon={<CalendarClock />}
            description="Everything that bills on its own: retainers and scheduled hours. Drafts are never sent without you."
            action={(
              <>
                {projects.length > 1 && (
                  <div className="w-full sm:w-52">
                    <Select
                      size="sm"
                      ariaLabel="Project"
                      value={projectFilter}
                      onChange={setProjectFilter}
                      options={[{ value: '', label: 'All projects' }, ...projects.map(([id, name]) => ({ value: id, label: name }))]}
                    />
                  </div>
                )}
                <div className="w-full sm:w-40">
                  <Select size="sm" ariaLabel="Range" value={months} onChange={setMonths} options={RANGES} />
                </div>
              </>
            )}
            bodyClassName="px-4 pb-4 lg:px-5 lg:pb-5 space-y-4"
          >
            {items !== null && visible.length > 0 && (
              <StatStrip
                bare
                className="border-y border-white/[0.06] py-4"
                label="Billing totals"
                stats={[
                  { label: 'Fixed (exact)', value: money(exact) },
                  { label: 'Hours (estimated)', value: `~${money(estimated)}` },
                  { label: 'Drafted, waiting on you', value: drafted },
                ]}
              />
            )}

            {error ? (
              <EmptyState compact variant="error" title="Upcoming invoices could not load" description={error} onRetry={() => void load()} />
            ) : items === null ? (
              <div className="space-y-3" aria-busy="true" aria-label="Loading upcoming invoices">
                {Array.from({ length: 3 }, (_, i) => <div key={i} className="h-10 rounded-lg bg-white/[0.04] motion-safe:animate-pulse" />)}
              </div>
            ) : visible.length === 0 ? (
              <EmptyState
                compact
                icon={<CalendarClock />}
                title="Nothing bills on its own in this range"
                description="Add a retainer or schedule hourly drafts on a project's Invoices tab to see what is coming."
              />
            ) : (
              <BillingForecastList
                items={visible}
                showProject
                emptyText="Nothing bills on its own in this range."
                onOpenProject={(projectId) => router.push(`/projects/${projectId}?tab=invoices`)}
              />
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
