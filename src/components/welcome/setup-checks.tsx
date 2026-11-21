'use client';

import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Info, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { Read } from '@/lib/query-cache';

/** The setup wizard's checks, as /api/workspace/setup-checks answers them (never a value, only set or not). */
export interface SetupChecks {
  env: Array<{ name: string; set: boolean; required: boolean; purpose: string }>;
  communications: 'ready' | 'not_exposed' | 'missing' | 'unknown';
  emailConfigured: boolean;
}

export const setupChecksRead: Read<SetupChecks> = {
  key: 'workspace-setup-checks',
  tables: ['smtp_accounts'],
  ttlMs: 60_000,
  load: async () => {
    const response = await fetch('/api/workspace/setup-checks', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not run the setup checks');
    return payload.data as SetupChecks;
  },
};

export const SCHEMA_FIX_STEPS = [
  'Open your project in Supabase.',
  'Go to Project Settings, then Data API.',
  'Under Exposed schemas, add communications.',
  'Save, then press Check again here.',
];

/**
 * Whether the install is wired up, on day one: a quiet line when every
 * variable is set, the list (missing first) when one is not. A missing
 * required variable is red; a missing optional one names what waits on it.
 */
export function EnvChecksPanel({ checks, loading, failed, onReload }: {
  checks: SetupChecks | undefined;
  loading: boolean;
  failed: boolean;
  onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (loading) {
    return <div aria-busy="true" aria-label="Checking your setup" className="h-11 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />;
  }
  if (failed || !checks) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2.5 text-xs text-zinc-300">
        <span className="min-w-0 flex-1">Could not check your setup.</span>
        <Button type="button" size="sm" variant="ghost" onClick={onReload} icon={<RotateCw size={12} aria-hidden="true" />}>Try again</Button>
      </div>
    );
  }

  const missing = checks.env.filter((item) => !item.set);
  const requiredMissing = missing.filter((item) => item.required);
  const allSet = missing.length === 0;
  const expanded = open || requiredMissing.length > 0;
  const sorted = [...checks.env].sort((a, b) => Number(a.set) - Number(b.set) || Number(b.required) - Number(a.required));

  return (
    <div className={`rounded-lg ${requiredMissing.length ? 'bg-red-500/[0.08]' : 'bg-white/[0.03]'}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expanded}
        disabled={requiredMissing.length > 0}
        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-default"
      >
        {allSet
          ? <Check size={14} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
          : requiredMissing.length
            ? <AlertTriangle size={14} className="flex-shrink-0 text-red-300" aria-hidden="true" />
            : <Info size={14} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />}
        <span className="min-w-0 flex-1 text-zinc-200">
          {allSet
            ? 'Setup check: every environment variable is set.'
            : requiredMissing.length
              ? `${requiredMissing.length} required environment variable${requiredMissing.length > 1 ? 's are' : ' is'} missing. Parts of the app will not work until ${requiredMissing.length > 1 ? 'they are' : 'it is'} set.`
              : `Everything needed is set. ${missing.length} optional environment variable${missing.length > 1 ? 's are' : ' is'} not set.`}
        </span>
        {requiredMissing.length === 0 && (
          <ChevronDown size={14} className={`flex-shrink-0 text-zinc-400 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-white/[0.06] px-3 pb-3 pt-2">
          <ul className="space-y-1.5">
            {sorted.map((item) => (
              <li key={item.name} className="flex items-start gap-2 text-xs">
                {item.set
                  ? <Check size={13} className="mt-0.5 flex-shrink-0 text-emerald-300" aria-label="Set" />
                  : <X size={13} className={`mt-0.5 flex-shrink-0 ${item.required ? 'text-red-300' : 'text-zinc-500'}`} aria-label="Not set" />}
                <span className="min-w-0">
                  <span className="font-mono text-[11px] text-zinc-200">{item.name}</span>
                  <span className="text-zinc-400"> {item.purpose}{!item.set && !item.required ? ' Optional.' : ''}</span>
                </span>
              </li>
            ))}
          </ul>
          {!allSet && (
            <p className="mt-3 text-[11px] leading-relaxed text-zinc-400">
              Add them where the app runs (your host&apos;s environment settings, or .env.local on your computer), redeploy or restart, then check again. Each is described in .env.example.
            </p>
          )}
          {!allSet && (
            <Button type="button" size="sm" variant="ghost" className="mt-2 -ml-2.5" onClick={onReload} icon={<RotateCw size={12} aria-hidden="true" />}>Check again</Button>
          )}
        </div>
      )}
    </div>
  );
}
