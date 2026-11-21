'use client';

import { useMemo } from 'react';
import { Select } from '@/components/ui/inputs/Select';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { formatHours, formatMoney, formatMoneyExact } from '@/lib/format';
import { WEEK_STARTS, WEEK_START_LABELS, type Region, type WeekStart } from '@/lib/region';
import { currencyOptions, localeOptions } from './region-settings';

/**
 * The currency, locale and week start pickers, shared by Settings >
 * Workspace > Region and the setup wizard.
 */
export function RegionFields({ value, onChange, disabled = false, showWeekStart = true, currencyHint }: {
  value: Region;
  onChange: (patch: Partial<Region>) => void;
  disabled?: boolean;
  showWeekStart?: boolean;
  currencyHint?: string;
}) {
  const currencies = useMemo(() => currencyOptions(value.currency, value.locale), [value.currency, value.locale]);
  const locales = useMemo(() => localeOptions(value.locale), [value.locale]);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Select
          visibleLabel="Currency"
          label="Currency"
          searchable
          value={value.currency}
          options={currencies}
          onChange={(currency) => onChange({ currency })}
          disabled={disabled}
          helperText={currencyHint ?? 'New invoices, retainers and pay use it.'}
          emptyText="No currency matches."
        />
        <Select
          visibleLabel="Format"
          label="Number and date format"
          searchable
          value={value.locale}
          options={locales}
          onChange={(locale) => onChange({ locale })}
          disabled={disabled}
          helperText="How amounts and dates read: 1,234.50 or 1.234,50."
          emptyText="No format matches."
        />
      </div>
      {showWeekStart && (
        <RadioGroup<string>
          label="Weeks start on"
          orientation="horizontal"
          value={String(value.weekStart)}
          onChange={(next) => onChange({ weekStart: Number(next) as WeekStart })}
          options={WEEK_STARTS.map((day) => ({ value: String(day), label: WEEK_START_LABELS[day] }))}
          disabled={disabled}
        />
      )}
    </div>
  );
}

/** A sample of what everyone will see: a total, an invoice line, hours and a date. */
export function RegionPreview({ region, className = '' }: { region: Region; className?: string }) {
  const options = { currency: region.currency, locale: region.locale };
  const sample = new Date(2026, 2, 14, 15, 30);
  let date = '';
  let short = '';
  try {
    date = sample.toLocaleDateString(region.locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    short = sample.toLocaleDateString(region.locale, { month: 'short', day: 'numeric' });
  } catch {
    date = sample.toDateString();
  }
  const rows: [string, string][] = [
    ['Total', formatMoney(12480, options)],
    ['Small total', formatMoney(86.5, options)],
    ['Invoice line', formatMoneyExact(1234.5, options)],
    ['Hours', formatHours(2.5, region.locale)],
    ['Date', date],
    ['Short date', short],
  ];
  return (
    <dl aria-label="Preview" className={`divide-y divide-white/[0.06] rounded-xl bg-white/[0.03] px-4 ${className}`}>
      {rows.map(([label, text]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-xs text-zinc-400">{label}</dt>
          <dd className="min-w-0 truncate text-right text-sm tabular-nums text-zinc-100">{text}</dd>
        </div>
      ))}
    </dl>
  );
}
