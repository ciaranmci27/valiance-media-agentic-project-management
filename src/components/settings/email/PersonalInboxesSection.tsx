'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Users } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { relativeTime } from '@/components/settings/EmailConnectChecklist';
import { useSettingsAccess } from '@/components/settings/settings-groups';
import { currentError, inboxStatus, STATUS_DOT } from '@/components/settings/email/inbox-status';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { announceInboxChange, inboxSettingsClient } from '@/lib/communications/inbox-client';
import type { PersonalInboxHealth } from '@/lib/communications/inbox-types';

/**
 * Settings > Email > Personal inboxes, for those who manage inboxes: every
 * teammate's own inbox, shown only as that it exists and how it is doing,
 * never its mail. Each can be turned off (when someone leaves) or back on.
 * Above them, the one switch that lets Owners read personal inboxes, which
 * only someone who manages business settings changes.
 */

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function PersonalInboxesSection() {
  const { isDemoMode } = useDemo();
  const { emailsRefreshSignal } = useApp();
  // Only an Owner changes whether Owners read personal inboxes (the server and database agree).
  const { isOwner } = useSettingsAccess();
  const client = useMemo(() => inboxSettingsClient(isDemoMode), [isDemoMode]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inboxes, setInboxes] = useState<PersonalInboxHealth[]>([]);
  const [ownersRead, setOwnersRead] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(new Set());
  const togglingRef = useRef(new Set<string>());
  const [offTarget, setOffTarget] = useState<PersonalInboxHealth | null>(null);

  const load = useCallback(async (quiet = false) => {
    try {
      const data = await client.list();
      setInboxes(data.personal ?? []);
      setOwnersRead(!!data.owners_read_personal);
      setLoadError(null);
    } catch (error) {
      if (!quiet) setLoadError(errorMessage(error, 'Could not load personal inboxes'));
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void load().then(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const firstSignal = useRef(emailsRefreshSignal);
  useEffect(() => {
    if (firstSignal.current === emailsRefreshSignal) return;
    void load(true);
  }, [emailsRefreshSignal, load]);

  const savePolicy = async (next: boolean) => {
    setPolicySaving(true);
    try {
      const result = await client.setPersonalPolicy(next);
      setOwnersRead(result.owners_read_personal);
      announceInboxChange();
      toast('success', result.owners_read_personal ? 'Owners can read personal inboxes' : 'Personal inboxes are private');
    } catch (error) {
      toast('error', errorMessage(error, 'Could not save the setting'));
    } finally {
      setPolicySaving(false);
    }
  };

  const setToggling = (id: string, on: boolean) => {
    if (on) togglingRef.current.add(id);
    else togglingRef.current.delete(id);
    setTogglingIds(new Set(togglingRef.current));
  };

  const toggle = async (inbox: PersonalInboxHealth) => {
    if (togglingRef.current.has(inbox.id)) return;
    setToggling(inbox.id, true);
    try {
      const updated = await client.switchPersonal(inbox.id, !inbox.enabled);
      setInboxes((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      announceInboxChange();
      toast('success', `${ownerLabel(updated)} turned ${updated.enabled ? 'on' : 'off'}`);
    } catch (error) {
      toast('error', errorMessage(error, 'Could not change the inbox'));
    } finally {
      setToggling(inbox.id, false);
    }
  };

  const requestToggle = (inbox: PersonalInboxHealth) => {
    if (togglingRef.current.has(inbox.id)) return;
    if (inbox.enabled) setOffTarget(inbox);
    else void toggle(inbox);
  };

  return (
    <section id="personal-inboxes" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      <SettingsSectionHeader
        icon={Users}
        title="Personal inboxes"
        description="Inboxes teammates connected for their own mail. You see that each exists and how it is doing, never its mail, and you can turn one off when someone leaves."
      />

      <div className="mb-6 flex items-start gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] p-4">
        <div className="min-w-0 flex-1">
          <p id="owners-read-personal-label" className="text-sm font-medium text-zinc-100">Owners can read personal inboxes</p>
          <p id="owners-read-personal-description" className="mt-0.5 text-xs leading-relaxed text-zinc-400">
            {isOwner
              ? 'While on, Owners read every personal inbox, and each one says so to its owner.'
              : 'Only an Owner changes this.'}
          </p>
        </div>
        <Toggle
          aria-labelledby="owners-read-personal-label"
          aria-describedby="owners-read-personal-description"
          className="mt-0.5 flex-shrink-0"
          checked={ownersRead}
          onChange={(checked) => {
            if (isOwner && !policySaving) void savePolicy(checked);
          }}
          disabled={!isOwner || policySaving || loading}
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin motion-reduce:animate-none text-zinc-400" size={24} aria-label="Loading personal inboxes" role="status" />
        </div>
      ) : loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
          <p className="flex items-start gap-2 text-sm text-red-300 min-w-0">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span className="min-w-0">{loadError}</span>
          </p>
          <Button size="sm" variant="secondary" className="flex-shrink-0" onClick={() => void load()}>Retry</Button>
        </div>
      ) : inboxes.length > 0 ? (
        <ul className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
          {inboxes.map((inbox) => {
            const status = inboxStatus(inbox);
            const error = currentError(inbox);
            const toggling = togglingIds.has(inbox.id);
            return (
              <li key={inbox.id} className="px-4 py-4 space-y-2">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-white break-words">{ownerLabel(inbox)}</h3>
                      <Badge variant={inbox.enabled ? 'success' : 'default'}>{inbox.enabled ? 'On' : 'Off'}</Badge>
                    </div>
                    <p title={inbox.address} className="mt-0.5 truncate font-mono text-xs text-zinc-400">{inbox.address}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {toggling && (
                      <Loader2 size={14} className="animate-spin text-zinc-400 motion-reduce:animate-none" role="status" aria-label={`Saving ${ownerLabel(inbox)}`} />
                    )}
                    <Tooltip content={inbox.enabled ? 'Turn off' : 'Turn on'}>
                      <Toggle
                        size="sm"
                        checked={inbox.enabled}
                        onChange={() => {
                          if (!toggling) requestToggle(inbox);
                        }}
                        aria-disabled={toggling || undefined}
                        aria-label={`Receive mail for ${ownerLabel(inbox)}`}
                      />
                    </Tooltip>
                  </div>
                </div>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                  <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT[status.tone]}`} />
                  <span className={status.tone === 'on' ? 'text-emerald-300' : 'text-zinc-400'}>{status.text}</span>
                  <span className="text-zinc-500 tabular-nums">{plural(inbox.message_count, 'email', 'emails')}</span>
                </p>
                {error && (
                  <p className="flex items-start gap-1.5 text-xs text-red-300">
                    <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                    <span className="min-w-0 break-words">
                      <span className="sr-only">Last error: </span>
                      {error}
                      {inbox.last_error_at && <span className="text-zinc-400"> ({relativeTime(inbox.last_error_at)})</span>}
                    </span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-4 text-center text-sm text-zinc-400">Nobody has connected their own inbox yet.</p>
      )}

      <ConfirmDialog
        isOpen={!!offTarget}
        onClose={() => setOffTarget(null)}
        onConfirm={() => {
          if (offTarget) void toggle(offTarget);
        }}
        title={`Turn off ${offTarget ? ownerLabel(offTarget) : 'this inbox'}?`}
        message={`Mail forwarded from ${offTarget?.address ?? 'it'} is dropped while it is off, not queued. Mail already in it stays. It can be turned back on any time.`}
        confirmLabel="Turn off"
        variant="danger"
        doubleConfirm={false}
      />
    </section>
  );
}

function ownerLabel(inbox: PersonalInboxHealth): string {
  return inbox.owner ? `${inbox.owner.name}'s inbox` : inbox.name;
}
