'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Coins, Database, RotateCw } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { currencyName, sameRegion, type Region } from '@/lib/region';
import { useRegion } from '@/lib/region/context';
import { SaveBar } from './BrandSection';
import { OutcomeLine, type Outcome } from './OutcomeLine';
import { RegionFields, RegionPreview } from './RegionFields';
import { saveRegion, workspaceRegionRead } from './region-settings';

const DESCRIPTION = 'The currency and format every amount and date shows in, across the app, the client portal, emails and invoices.';

/**
 * Settings > Workspace > Region (Owners only): currency, number and date
 * format, and the first day of the week. Saves from the bar that shows while
 * anything is unsaved; a save leaves one line with Undo. Invoices, retainers
 * and billing plans keep the currency they were made in.
 */
export function RegionSection() {
  const router = useRouter();
  const live = useRegion();
  const { isDemoMode } = useDemo();
  const read = useRead(isDemoMode ? null : workspaceRegionRead);

  const local = isDemoMode || read.data?.status === 'local';
  const migration = read.data?.status === 'migration' ? read.data.message : null;
  const ready = read.data?.status === 'ready' ? read.data.data : null;

  const [localRegion, setLocalRegion] = useState<Region | null>(null);
  const saved: Region = local ? localRegion ?? live : ready?.region ?? live;
  const [draft, setDraft] = useState<Region | null>(null);
  const form = draft ?? saved;
  const dirty = draft !== null && !sameRegion(draft, saved);
  const [saving, setSaving] = useState(false);
  const [bar, setBar] = useState<Outcome | null>(null);
  const [line, setLine] = useState<Outcome | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const apply = async (next: Region): Promise<string | null> => {
    if (local) {
      setLocalRegion(next);
      return null;
    }
    setSaving(true);
    const result = await saveRegion(next);
    setSaving(false);
    if (!result.ok) return result.message;
    router.refresh();
    return null;
  };

  const restore = async (previous: Region) => {
    const error = await apply(previous);
    setDraft(null);
    setLine(error
      ? { tone: 'error', text: `Not undone. ${error}`, onRetry: () => { void restore(previous); } }
      : { tone: 'done', text: `Undone. Back to ${currencyName(previous.currency)}.` });
  };

  const save = async () => {
    if (!dirty || saving || migration) return;
    const previous = saved;
    const next = form;
    setBar(null);
    const error = await apply(next);
    if (error) {
      setBar({ tone: 'error', text: `Not saved. ${error}` });
      return;
    }
    setDraft((current) => (current && !sameRegion(current, next) ? current : null));
    setLine({
      tone: 'done',
      text: local
        ? 'Region saved on this page. The demo workspace keeps it until you reload.'
        : 'Region saved. Everyone sees it now.',
      onUndo: () => { void restore(previous); },
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && dirty) {
      event.preventDefault();
      void save();
    }
  };

  const loading = !local && read.loading;
  const failed = !local && read.failed;
  const currencyChanged = form.currency !== saved.currency;

  return (
    <section className="glass-card @container rounded-xl p-4 lg:p-5" onKeyDown={onKeyDown}>
      <SettingsSectionHeader icon={Coins} title="Region" description={DESCRIPTION} />

      {local && <p className="-mt-3 mb-6 text-xs text-zinc-400">Demo workspace: changes last until you reload.</p>}

      {loading ? (
        <div aria-busy="true" aria-label="Loading region" className="grid grid-cols-1 gap-8 motion-safe:animate-pulse @2xl:grid-cols-[minmax(0,1fr)_17.5rem]">
          <div className="space-y-6">
            <div className="h-16 rounded-input bg-white/[0.03]" />
            <div className="h-10 w-72 rounded-input bg-white/[0.03]" />
          </div>
          <div className="h-60 rounded-xl bg-white/[0.03]" />
        </div>
      ) : failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-red-500/[0.1] px-3.5 py-3">
          <p className="min-w-0 flex-1 text-sm text-zinc-200">Couldn&apos;t load your region.</p>
          <Button size="sm" variant="secondary" onClick={read.reload} icon={<RotateCw size={13} aria-hidden="true" />}>Try again</Button>
        </div>
      ) : (
        <>
          {migration && (
            <div role="status" className="mb-6 flex items-start gap-3 rounded-lg bg-amber-500/[0.1] px-3.5 py-3">
              <Database size={16} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">{migration}</p>
                <p className="mt-0.5 text-xs text-zinc-400">The region can be set once the database is up to date. Until then, amounts show in US dollars.</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-8 @2xl:grid-cols-[minmax(0,1fr)_17.5rem] @2xl:gap-10">
            <fieldset disabled={!!migration} className="min-w-0">
              <legend className="sr-only">Region settings</legend>
              <RegionFields
                value={form}
                disabled={!!migration || saving}
                onChange={(patch) => {
                  setDraft({ ...form, ...patch });
                  setBar(null);
                  setLine(null);
                }}
                currencyHint={currencyChanged
                  ? `Invoices, retainers and billing plans you already have stay in ${saved.currency}. New ones use ${form.currency}. Hourly rates, pay rates and budgets have no currency of their own, so they show in ${form.currency} as they are, not converted.`
                  : undefined}
              />
              {line && <OutcomeLine outcome={line} busy={saving} className="mt-6" />}
            </fieldset>

            <aside aria-label="Preview" className="min-w-0 @2xl:sticky @2xl:top-6 @2xl:self-start">
              <h3 className="mb-3 text-xs font-medium text-zinc-400">Preview</h3>
              <RegionPreview region={form} />
            </aside>
          </div>

          {(dirty || bar) && (
            <SaveBar
              dirty={dirty}
              saving={saving}
              blocked={migration ? 'Run the latest database migration first.' : null}
              outcome={bar}
              onSave={() => { void save(); }}
              onDiscard={() => { setDraft(null); setBar(null); }}
            />
          )}
        </>
      )}
    </section>
  );
}
