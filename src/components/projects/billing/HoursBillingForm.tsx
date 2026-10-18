'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { Select } from '@/components/ui/inputs/Select';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { fetchBillingForecast, saveBillingPlan } from '@/lib/supabase/queries';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BillingForecastItem, HoursCapMode, HoursTrigger, ProjectBillingPlan, ProjectBillingRun } from '@/lib/types';
import { BillingForecastList, money } from './BillingForecastList';

const TRIGGERS: Array<{ value: HoursTrigger; label: string; description: string }> = [
  { value: 'manual', label: 'By hand', description: 'You add tracked time to an invoice yourself, as before.' },
  { value: 'days_of_month', label: 'On set days of the month', description: 'For example the 1st and the 16th.' },
  { value: 'every_weeks', label: 'Every few weeks', description: 'Every 1 to 12 weeks from a date you pick.' },
  { value: 'reaches_amount', label: 'When unbilled hours reach an amount', description: 'Bills all unbilled hours once they reach it.' },
  { value: 'fixed_blocks', label: 'In fixed blocks', description: 'Bills exactly that amount each time it builds up; the rest rolls into the next block.' },
];

const DAY_OPTIONS = [
  ...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: ordinal(i + 1) })),
  { value: '31', label: 'Last day' },
];

const TERMS = [0, 7, 14, 15, 30, 45, 60];

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function dayName(day: number): string {
  return day === 31 ? 'last day' : ordinal(day);
}

function listJoin(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The plan in one plain sentence, so the rule is never a puzzle. */
export function describePlan(plan: ProjectBillingPlan, hasRetainer: boolean): string {
  const terms = plan.payment_terms_days === 0 ? 'due on receipt' : `due in ${plan.payment_terms_days} days`;
  if (plan.hours_trigger === 'manual') {
    return `Hours are invoiced by hand. Drafted invoices are ${terms}.`;
  }
  const cap = plan.cap_mode === 'amount' && plan.cap_value
    ? ` up to ${money(plan.cap_value)} (the rest waits for the next draft)`
    : plan.cap_mode === 'hours' && plan.cap_value
      ? ` up to ${plan.cap_value} hours (the rest waits for the next draft)`
      : '';
  let when = '';
  if (plan.hours_trigger === 'days_of_month') {
    when = `On the ${listJoin(plan.days_of_month.map(dayName))} of each month, just after midnight, approved hours through the day before${cap} go on a draft`;
  } else if (plan.hours_trigger === 'every_weeks') {
    when = `Every ${plan.every_weeks === 1 ? 'week' : `${plan.every_weeks} weeks`}${plan.weeks_anchor ? ` from ${new Date(`${plan.weeks_anchor}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}, approved hours through the day before${cap} go on a draft`;
  } else if (plan.hours_trigger === 'reaches_amount') {
    when = `Once approved unbilled hours reach ${plan.trigger_amount ? money(plan.trigger_amount) : 'the amount'}, all of them${cap} go on a draft`;
  } else {
    when = `Each time ${plan.trigger_amount ? money(plan.trigger_amount) : 'the amount'} of approved hours builds up, exactly that much goes on a draft and the rest rolls into the next block`;
  }
  const combine = hasRetainer && ['days_of_month', 'every_weeks'].includes(plan.hours_trigger)
    ? plan.combine_with_retainer
      ? ' On a day the retainer bills, the hours join that invoice.'
      : ' On a day the retainer bills, the hours get their own invoice.'
    : '';
  const minimum = plan.min_amount > 0 ? ` Drafts under ${money(plan.min_amount)} are skipped until more builds up.` : '';
  const paused = plan.paused ? ' Paused for now.' : '';
  return `${when}.${combine}${minimum} Time awaiting approval waits for the next draft. Invoices are ${terms}. Nothing is sent without you.${paused}`;
}

const RUN_LABEL: Record<ProjectBillingRun['outcome'], string> = {
  drafted: 'Drafted',
  merged: 'Added to the retainer invoice',
  nothing_due: 'Nothing to bill',
  below_minimum: 'Under the minimum',
  failed: 'Failed',
};

interface Props {
  supabase: SupabaseClient;
  projectId: string;
  plan: ProjectBillingPlan;
  runs: ProjectBillingRun[];
  hasRetainer: boolean;
  canManage: boolean;
  today: string;
  onSaved: (plan: ProjectBillingPlan) => void;
}

export function HoursBillingForm({ supabase, projectId, plan, runs, hasRetainer, canManage, today, onSaved }: Props) {
  const [draft, setDraft] = useState<ProjectBillingPlan>(plan);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<BillingForecastItem[] | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const customTerms = !TERMS.includes(draft.payment_terms_days);
  const [termsMode, setTermsMode] = useState<string>(customTerms ? 'custom' : String(draft.payment_terms_days));

  useEffect(() => setDraft(plan), [plan]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(plan);
  const set = <K extends keyof ProjectBillingPlan>(key: K, value: ProjectBillingPlan[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const scheduled = draft.hours_trigger === 'days_of_month' || draft.hours_trigger === 'every_weeks';
  const amountTrigger = draft.hours_trigger === 'reaches_amount' || draft.hours_trigger === 'fixed_blocks';
  const problem = useMemo(() => {
    if (draft.hours_trigger === 'days_of_month' && draft.days_of_month.length === 0) return 'Pick at least one day.';
    if (draft.hours_trigger === 'every_weeks' && !draft.weeks_anchor) return 'Pick the date of the first draft.';
    if (amountTrigger && !(draft.trigger_amount && draft.trigger_amount > 0)) return 'Enter the amount.';
    if (draft.cap_mode !== 'none' && draft.hours_trigger !== 'fixed_blocks' && !(draft.cap_value && draft.cap_value > 0)) return 'Enter the limit, or choose No limit.';
    if (draft.ends_on && draft.ends_on < today) return 'The stop date has already passed.';
    return null;
  }, [draft, amountTrigger, today]);

  // Live preview of the next drafts with the unsaved settings.
  useEffect(() => {
    if (problem) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      const until = new Date(`${today}T12:00:00`);
      until.setMonth(until.getMonth() + 3);
      fetchBillingForecast(supabase, projectId, { until: until.toISOString().slice(0, 10), previewPlan: draft })
        .then((items) => { if (!cancelled) { setPreview(items.slice(0, 4)); setPreviewError(false); } })
        .catch(() => { if (!cancelled) setPreviewError(true); });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [draft, problem, projectId, supabase, today]);

  const save = async () => {
    if (problem) return;
    setSaving(true);
    try {
      const { project_id: _ignored, starts_on: startsOn, ...settings } = draft;
      void _ignored;
      const saved = await saveBillingPlan(supabase, projectId, {
        ...settings,
        cap_value: draft.cap_mode === 'none' ? null : draft.cap_value,
        // A new trigger starts today: leave starts_on out and the server sets
        // it (sending null would store no start and let the first run draft a
        // date that passed before drafting was switched on).
        ...(draft.hours_trigger === plan.hours_trigger && startsOn ? { starts_on: startsOn } : {}),
      });
      onSaved(saved);
      toast('success', 'Billing schedule saved');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save the billing schedule');
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canManage || saving;

  return (
    <div className="space-y-6">
      <fieldset disabled={disabled} className="space-y-5">
        <RadioGroup<HoursTrigger>
          label="How unbilled hours get invoiced"
          value={draft.hours_trigger}
          onChange={(value) => set('hours_trigger', value)}
          options={TRIGGERS}
          disabled={disabled}
        />

        {draft.hours_trigger === 'days_of_month' && (
          <MultiSelect
            label="Days of the month"
            description="Up to four. Short months use their last day."
            options={DAY_OPTIONS}
            value={draft.days_of_month.map(String)}
            onChange={(values) => set('days_of_month', values.map(Number).sort((a, b) => a - b))}
            maxSelections={4}
            disabled={disabled}
          />
        )}

        {draft.hours_trigger === 'every_weeks' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberInput
              label="Every how many weeks"
              value={draft.every_weeks}
              min={1}
              max={12}
              step={1}
              onChange={(value) => set('every_weeks', value === '' ? 1 : Math.min(12, Math.max(1, Math.round(value))))}
              disabled={disabled}
            />
            <DateInput
              label="First draft on"
              value={draft.weeks_anchor ?? ''}
              minDate={today}
              onChange={(value) => set('weeks_anchor', value || null)}
              disabled={disabled}
            />
          </div>
        )}

        {amountTrigger && (
          <NumberInput
            label={draft.hours_trigger === 'fixed_blocks' ? 'Block size' : 'Draft when unbilled hours reach'}
            description={draft.hours_trigger === 'fixed_blocks'
              ? 'Each invoice is exactly this amount. A session can be split across two blocks.'
              : 'Checked every hour. The draft holds all unbilled hours at that moment.'}
            prefix="$"
            value={draft.trigger_amount ?? ''}
            min={1}
            step={100}
            precision={2}
            onChange={(value) => set('trigger_amount', value === '' ? null : value)}
            disabled={disabled}
          />
        )}

        {draft.hours_trigger !== 'manual' && draft.hours_trigger !== 'fixed_blocks' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Each draft holds"
              value={draft.cap_mode}
              onChange={(value) => set('cap_mode', value as HoursCapMode)}
              options={[
                { value: 'none', label: 'All unbilled hours' },
                { value: 'amount', label: 'Up to an amount' },
                { value: 'hours', label: 'Up to a number of hours' },
              ]}
              disabled={disabled}
            />
            {draft.cap_mode !== 'none' && (
              <NumberInput
                label={draft.cap_mode === 'amount' ? 'Limit' : 'Hours limit'}
                description="The rest waits for the next draft."
                prefix={draft.cap_mode === 'amount' ? '$' : undefined}
                suffix={draft.cap_mode === 'hours' ? 'h' : undefined}
                value={draft.cap_value ?? ''}
                min={0.25}
                step={draft.cap_mode === 'amount' ? 100 : 1}
                precision={2}
                onChange={(value) => set('cap_value', value === '' ? null : value)}
                disabled={disabled}
              />
            )}
          </div>
        )}

        {scheduled && hasRetainer && (
          <Toggle
            checked={draft.combine_with_retainer}
            onChange={(checked) => set('combine_with_retainer', checked)}
            label="Put hours on the retainer invoice"
            description="When both land on the same day, send one invoice. Off: two invoices that day."
            disabled={disabled}
          />
        )}

        {draft.hours_trigger !== 'manual' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberInput
              label="Skip a draft under"
              description="Small amounts wait for the next draft. 0 drafts any amount."
              prefix="$"
              value={draft.min_amount}
              min={0}
              step={50}
              precision={2}
              onChange={(value) => set('min_amount', value === '' ? 0 : value)}
              disabled={disabled}
            />
            <DateInput
              label="Stop drafting after (optional)"
              value={draft.ends_on ?? ''}
              minDate={today}
              clearable
              onChange={(value) => set('ends_on', value || null)}
              disabled={disabled}
            />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Payment terms"
            helperText="Sets the due date of every drafted invoice on this project, retainer drafts included."
            value={termsMode}
            onChange={(value) => {
              setTermsMode(value);
              if (value !== 'custom') set('payment_terms_days', Number(value));
            }}
            options={[
              ...TERMS.map((days) => ({ value: String(days), label: days === 0 ? 'Due on receipt' : `Net ${days}` })),
              { value: 'custom', label: 'Custom' },
            ]}
            disabled={disabled}
          />
          {termsMode === 'custom' && (
            <NumberInput
              label="Days until due"
              value={draft.payment_terms_days}
              min={0}
              max={120}
              step={1}
              onChange={(value) => set('payment_terms_days', value === '' ? 0 : Math.min(120, Math.max(0, Math.round(value))))}
              disabled={disabled}
            />
          )}
        </div>

        {draft.hours_trigger !== 'manual' && (
          <Toggle
            checked={draft.paused}
            onChange={(checked) => set('paused', checked)}
            label="Paused"
            description="Nothing is drafted while paused. Hours keep building up and are billed after you resume."
            disabled={disabled}
          />
        )}
      </fieldset>

      <div className="rounded-lg border border-brand-500/20 bg-brand-500/[0.06] px-4 py-3">
        <p className="text-sm text-zinc-200" aria-live="polite">{describePlan(draft, hasRetainer)}</p>
        {problem && <p className="mt-1.5 text-xs text-amber-300">{problem}</p>}
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
          {dirty ? 'Next drafts with these settings' : 'Next drafts'}
        </h4>
        {previewError ? (
          <p className="text-sm text-zinc-400">The preview could not load. Saving still works.</p>
        ) : preview === null ? (
          <p className="text-sm text-zinc-500">Working out the next drafts…</p>
        ) : (
          <BillingForecastList items={preview} emptyText="Nothing scheduled in the next three months." />
        )}
      </div>

      {runs.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Recent runs</h4>
          <ul className="divide-y divide-white/[0.05] rounded-lg border border-white/[0.06]">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3.5 py-2 text-xs">
                <span className="text-zinc-300 tabular-nums">
                  {new Date(`${run.run_date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  {' · '}
                  <span className={run.outcome === 'failed' ? 'text-red-300' : 'text-zinc-200'}>{RUN_LABEL[run.outcome]}</span>
                  {run.amount !== null && run.outcome !== 'nothing_due' && <span className="text-zinc-400"> · {money(run.amount)}</span>}
                </span>
                <span className="text-zinc-500">
                  {run.outcome === 'failed' && run.detail ? run.detail : null}
                  {run.pending_hours > 0 && `${run.pending_hours.toFixed(2)} h awaiting approval left out`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canManage && (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDraft(plan)} disabled={!dirty || saving}>Reset</Button>
          <Button onClick={() => void save()} disabled={!dirty || Boolean(problem) || saving}>
            {saving ? 'Saving…' : 'Save schedule'}
          </Button>
        </div>
      )}
    </div>
  );
}
