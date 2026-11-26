'use client';

import { useEffect, useMemo, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';
import { isModuleEnabled } from '@/lib/access-control';
import { workspaceApi } from '@/lib/agent-workspace';
import { useAuth } from '@/lib/auth-context';
import { DATA_RETENTION_FIELDS, DATA_RETENTION_RUN_UTC, retentionChoices, shortenedRetention, type DataRetentionKey, type DataRetentionSettings } from '@/lib/data-retention';
import { useRetentionConfirm } from '@/components/settings/security/RetentionConfirm';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { dataRetentionRead } from '@/lib/reads';

const FOREVER = 'forever';
const toValue = (days: number | null) => (days === null ? FOREVER : String(days));
const toDays = (value: string) => (value === FOREVER ? null : Number(value));

/**
 * Settings > Security > Keeping data (Owners only): how long data that grows
 * on its own is kept, one plain choice each, "Keep forever" included. A
 * daily job removes what is older; anything still in use stays. Shortening
 * a period asks first, with about how many rows go and when. Settings for a
 * module that is off are hidden. The demo shows the defaults, with nothing
 * to change, and says so.
 */
export function DataRetentionSection() {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const read = useRead(dataRetentionRead(isDemoMode));
  const settings = read.data;
  const [draft, setDraft] = useState<Record<DataRetentionKey, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = useMemo(() => DATA_RETENTION_FIELDS.filter((field) => !field.module || isModuleEnabled(access, field.module)), [access]);
  const saved = useMemo(() => (settings
    ? Object.fromEntries(fields.map((field) => [field.key, toValue(settings[field.key])])) as Record<DataRetentionKey, string>
    : null), [settings, fields]);
  useEffect(() => { setDraft(saved); }, [saved]);

  const changed = !!draft && !!saved && fields.some((field) => draft[field.key] !== saved[field.key]);
  const confirm = useRetentionConfirm(DATA_RETENTION_RUN_UTC);

  const save = () => {
    if (!draft || !saved || !settings) return;
    const body = Object.fromEntries(fields.filter((field) => draft[field.key] !== saved[field.key]).map((field) => [field.key, toDays(draft[field.key])])) as Partial<DataRetentionSettings>;
    const shorter = shortenedRetention(settings, body, fields.map((field) => field.key));
    void confirm.ask(shorter.map((key) => {
      const field = fields.find((f) => f.key === key)!;
      return { key, label: field.label, days: body[key] as number, unit: key === 'chat_retention_days' ? 'texts' as const : 'rows' as const };
    }), () => { void write(body); });
  };

  const write = async (body: Partial<DataRetentionSettings>) => {
    setBusy(true);
    try {
      const next = await workspaceApi<DataRetentionSettings>('/api/workspace/data-retention', { method: 'PUT', body });
      setReadData(dataRetentionRead(isDemoMode), () => next);
      invalidateTables(['business_settings']);
      toast('success', 'Data retention saved');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (fields.length === 0) return null;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="data-retention-heading">
      <SettingsSectionHeader
        icon={HardDrive}
        headingId="data-retention-heading"
        title="Keeping data"
        description="How long data that grows on its own is kept. Older data is removed once a day; anything still in use stays."
      />
      {!settings || !draft ? (
        <p className="text-sm text-zinc-400" role="status">{read.failed ? 'Could not load the settings.' : 'Loading'}</p>
      ) : (
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          {isDemoMode && (
            <p role="note" className="rounded-lg bg-white/[0.04] px-3.5 py-3 text-sm text-zinc-300 sm:col-span-2">Sample settings: changes are off in the demo.</p>
          )}
          {fields.map((field) => (
            <Select
              key={field.key}
              label={field.label}
              value={draft[field.key]}
              onChange={(value) => setDraft((current) => (current ? { ...current, [field.key]: value } : current))}
              options={retentionChoices(field, settings[field.key]).map((choice) => ({ value: toValue(choice.value), label: choice.label }))}
              helperText={field.help}
              disabled={busy || isDemoMode}
            />
          ))}
          <div className="flex justify-end gap-2 sm:col-span-2">
            {changed && (
              <Button variant="ghost" onClick={() => setDraft(saved)}>Discard</Button>
            )}
            <Button onClick={save} disabled={!changed || busy || confirm.counting || isDemoMode}>{busy ? 'Saving' : confirm.counting ? 'Checking' : 'Save'}</Button>
          </div>
        </div>
      )}
      {confirm.dialog}
    </section>
  );
}
