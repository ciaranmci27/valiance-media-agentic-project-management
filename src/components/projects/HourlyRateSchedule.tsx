'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import type { ProjectHourlyRate } from '@/lib/types';

interface HourlyRateScheduleProps {
  projectId: string;
  fallbackRate: number;
  today: string;
  timezone?: string;
  isDemoMode: boolean;
  onCurrentRateChange: (rate: number) => void;
}

function localMidnightIso(dateKey: string, timezone?: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (timezone) {
    const guess = new Date(Date.UTC(year, month - 1, day));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(guess);
    const get = (type: Intl.DateTimeFormatPartTypes) => {
      const value = parts.find(part => part.type === type)?.value ?? '00';
      return value === '24' ? '00' : value;
    };
    const displayedAsUtc = Date.parse(
      `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`,
    );
    return new Date(guess.getTime() - (displayedAsUtc - guess.getTime())).toISOString();
  }
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

function displayDate(iso: string, timezone?: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

export function HourlyRateSchedule({
  projectId,
  fallbackRate,
  today,
  timezone,
  isDemoMode,
  onCurrentRateChange,
}: HourlyRateScheduleProps) {
  const supabase = useMemo(() => createClient(), []);
  const [rates, setRates] = useState<ProjectHourlyRate[]>([]);
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [rate, setRate] = useState<number | ''>(fallbackRate || '');
  const [saving, setSaving] = useState(false);
  const [renderedAt] = useState(() => Date.now());
  const onCurrentRateChangeRef = useRef(onCurrentRateChange);

  useEffect(() => {
    onCurrentRateChangeRef.current = onCurrentRateChange;
  }, [onCurrentRateChange]);

  const loadRates = useCallback(async () => {
    if (isDemoMode) {
      setRates([]);
      return;
    }
    const { data, error } = await supabase
      .from('project_hourly_rates')
      .select('*')
      .eq('project_id', projectId)
      .order('effective_at', { ascending: false });
    if (error) {
      toast('error', 'Failed to load rate schedule');
      return;
    }
    const loaded = (data || []) as ProjectHourlyRate[];
    setRates(loaded);
    const now = Date.now();
    const active = loaded.find(item => new Date(item.effective_at).getTime() <= now);
    if (active && Number(active.hourly_rate) !== fallbackRate) {
      onCurrentRateChangeRef.current(Number(active.hourly_rate));
    }
  }, [fallbackRate, isDemoMode, projectId, supabase]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadRates(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadRates]);

  const addRate = async () => {
    if (rate === '' || rate < 0 || !effectiveDate) return;
    if (isDemoMode) {
      toast('info', 'Rate scheduling is disabled in demo mode');
      return;
    }
    setSaving(true);
    const effectiveAt = localMidnightIso(effectiveDate, timezone);
    const { error } = await supabase.from('project_hourly_rates').insert({
      project_id: projectId,
      hourly_rate: rate,
      effective_at: effectiveAt,
    });
    setSaving(false);
    if (error) {
      toast('error', error.code === '23505' ? 'A rate already starts on that date' : 'Failed to schedule rate');
      return;
    }
    if (new Date(effectiveAt).getTime() <= Date.now()) onCurrentRateChange(rate);
    toast('success', 'Hourly rate scheduled');
    await loadRates();
  };

  const deleteRate = async (id: string) => {
    if (rates.length <= 1) {
      toast('error', 'Keep at least one rate in the schedule');
      return;
    }
    const { error } = await supabase.from('project_hourly_rates').delete().eq('id', id);
    if (error) {
      toast('error', 'Failed to remove scheduled rate');
      return;
    }
    toast('success', 'Scheduled rate removed');
    await loadRates();
  };

  return (
    <div className="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <DateInput
          label="Effective date"
          value={effectiveDate}
          onChange={setEffectiveDate}
          size="sm"
          className="flex-1"
        />
        <NumberInput
          label="Hourly rate"
          value={rate}
          onChange={setRate}
          min={0}
          step={5}
          prefix="$"
          suffix="/hr"
          size="sm"
          className="flex-1"
        />
        <Button size="sm" onClick={addRate} disabled={saving || rate === ''} icon={<Plus size={14} />}>
          Schedule
        </Button>
      </div>

      <div className="mt-4 divide-y divide-white/[0.08] rounded-lg border border-white/[0.08] bg-surface-raised">
        {rates.length > 0 ? rates.map(item => {
          const isFuture = new Date(item.effective_at).getTime() > renderedAt;
          return (
            <div key={item.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div>
                <p className="text-sm font-semibold text-white">${Number(item.hourly_rate).toFixed(2)}/hr</p>
                <p className="text-xs text-zinc-400">
                  {isFuture ? 'Starts' : 'Effective'} {displayDate(item.effective_at, timezone)}
                </p>
              </div>
              {isFuture ? (
                <button
                  type="button"
                  onClick={() => void deleteRate(item.id)}
                  className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-red-500/15 hover:text-red-400"
                  aria-label={`Remove rate effective ${displayDate(item.effective_at, timezone)}`}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
          );
        }) : (
          <p className="px-3 py-3 text-xs text-zinc-400">
            The current ${fallbackRate.toFixed(2)}/hr rate will be used until a schedule is added.
          </p>
        )}
      </div>
    </div>
  );
}
