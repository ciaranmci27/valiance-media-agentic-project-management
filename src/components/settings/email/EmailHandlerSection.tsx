'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Inbox, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { CopyValueButton, EmailConnectChecklist } from '@/components/settings/EmailConnectChecklist';
import { InboxCard, inboxEditButtonId } from '@/components/settings/email/InboxCard';
import {
  InboxForm,
  emptyInboxForm,
  formFromInbox,
  inboxInput,
  inboxRequest,
  validateInboxForm,
  type InboxFormErrors,
  type InboxFormState,
} from '@/components/settings/email/InboxForm';
import { MxStatusBlock, RelayDomainRow, type MxCheck } from '@/components/settings/email/InboxSetup';
import { isWaiting } from '@/components/settings/email/inbox-status';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { announceInboxChange, inboxSettingsClient } from '@/lib/communications/inbox-client';
import type { InboxSettings, InboxSettingsList } from '@/lib/communications/inbox-types';

/**
 * Settings > Email > Who handles your mail: each inbox with its handler,
 * readers, retention, switch and triage mode, an add/edit form, what to do
 * right after adding one, and Setup folded below: the relay domain, MX
 * status and each inbox's relay address with its connect checklist. Inboxes
 * are turned off (after asking), never deleted. Replies are never sent from here.
 */

/** How often the list refreshes while an enabled inbox waits for its first email. */
const WAITING_POLL_MS = 20_000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function domainsOf(data: InboxSettingsList): string[] {
  return [...new Set([data.relay_domain, ...data.inboxes.map((inbox) => inbox.routing_domain)].filter(Boolean))].sort();
}

export function EmailHandlerSection() {
  const { isDemoMode } = useDemo();
  const { team, emailsRefreshSignal } = useApp();
  const client = useMemo(() => inboxSettingsClient(isDemoMode), [isDemoMode]);
  const setupId = useId();
  const addButtonId = useId();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  /** The list loaded at least once, so the relay domain and rows are real. */
  const [loaded, setLoaded] = useState(false);
  const [relay, setRelay] = useState('');
  const [inboxes, setInboxes] = useState<InboxSettings[]>([]);
  const [mx, setMx] = useState<Record<string, MxCheck>>({});
  /** Inboxes whose switch is saving: one change per inbox at a time, each on its own. */
  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(new Set());
  const togglingRef = useRef(new Set<string>());
  /** The list as last rendered, so a switch saves from the inbox as it is now. */
  const inboxesRef = useRef<InboxSettings[]>([]);
  /** An inbox about to be turned off, waiting for the person to confirm. */
  const [offTarget, setOffTarget] = useState<InboxSettings | null>(null);
  /** The inbox just created: its next step shows until dismissed. */
  const [createdId, setCreatedId] = useState<string | null>(null);
  /** null until the person opens or closes Setup; until then it follows whether setup is needed. */
  const [setupChoice, setSetupChoice] = useState<boolean | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<InboxSettings | null>(null);
  const [form, setForm] = useState<InboxFormState>(() => emptyInboxForm([]));
  const [errors, setErrors] = useState<InboxFormErrors>({});
  const [saving, setSaving] = useState(false);

  // ─── Fetch ──────────────────────────────────────────────────────────────────

  const checkMx = useCallback(
    (domains: string[]) => {
      if (!domains.length) return;
      setMx((current) => {
        const next = { ...current };
        domains.forEach((domain) => {
          next[domain] = { state: 'checking' };
        });
        return next;
      });
      domains.forEach(async (domain) => {
        try {
          const result = await client.mx(domain);
          setMx((current) => ({ ...current, [domain]: { state: 'done', result } }));
        } catch (error) {
          setMx((current) => ({ ...current, [domain]: { state: 'failed', message: errorMessage(error, 'Lookup failed') } }));
        }
      });
    },
    [client],
  );

  /** Quiet loads (refreshes) keep what is shown when they fail. */
  const load = useCallback(async (quiet = false): Promise<InboxSettingsList | null> => {
    try {
      const data = await client.list();
      setRelay(data.relay_domain);
      setInboxes(data.inboxes);
      setLoadError(null);
      setLoaded(true);
      return data;
    } catch (error) {
      if (!quiet) setLoadError(errorMessage(error, 'Could not load the inbox'));
      return null;
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await load();
      if (cancelled) return;
      setLoading(false);
      if (data) checkMx(domainsOf(data));
    })();
    return () => {
      cancelled = true;
    };
  }, [load, checkMx]);

  /** Reload, then look up only domains that have not been checked yet. */
  const reloadAndCheckNew = async () => {
    const data = await load();
    if (data) checkMx(domainsOf(data).filter((domain) => !mx[domain]));
  };

  const retryLoad = async () => {
    setRetrying(true);
    await reloadAndCheckNew();
    setRetrying(false);
  };

  // Live status: refresh quietly when email data changes (realtime), and
  // every WAITING_POLL_MS while an enabled inbox waits for its first email.
  const firstSignal = useRef(emailsRefreshSignal);
  useEffect(() => {
    if (firstSignal.current === emailsRefreshSignal) return;
    void load(true);
  }, [emailsRefreshSignal, load]);

  const anyWaiting = inboxes.some(isWaiting);
  useEffect(() => {
    if (!anyWaiting || loadError) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [anyWaiting, loadError, load]);

  const domains = useMemo(() => domainsOf({ relay_domain: relay, inboxes }), [relay, inboxes]);

  useEffect(() => {
    inboxesRef.current = inboxes;
  }, [inboxes]);

  // ─── Relay domain ───────────────────────────────────────────────────────────

  const saveRelay = async (domain: string): Promise<boolean> => {
    try {
      const result = await client.setRelayDomain(domain);
      setRelay(result.relay_domain);
      toast('success', 'Relay domain saved');
      if (!mx[result.relay_domain]) checkMx([result.relay_domain]);
      return true;
    } catch (error) {
      toast('error', errorMessage(error, 'Could not save the relay domain'));
      return false;
    }
  };

  // ─── Form ───────────────────────────────────────────────────────────────────

  const openForm = (inbox: InboxSettings | null) => {
    // Its switch is saving: the form would start from the old state.
    if (inbox && togglingRef.current.has(inbox.id)) return;
    setForm(inbox ? formFromInbox(inbox, team) : emptyInboxForm(team));
    setErrors({});
    setEditing(inbox);
    setShowForm(true);
  };

  /** Closes the form; focus goes back to what opened it (Edit on its card, or Add inbox). */
  const closeForm = () => {
    const opener = editing ? inboxEditButtonId(editing.id) : addButtonId;
    setForm(emptyInboxForm(team));
    setErrors({});
    setEditing(null);
    setShowForm(false);
    requestAnimationFrame(() => document.getElementById(opener)?.focus());
  };

  const updateField = <K extends keyof InboxFormState>(field: K, value: InboxFormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field as keyof InboxFormErrors];
      return next;
    });
  };

  const handleSave = async () => {
    const found = validateInboxForm(form, relay);
    setErrors(found);
    if (Object.keys(found).length) {
      toast('error', 'Check the highlighted fields');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        // The switch is the card's: send it as it is now, never as it was when the form opened.
        const current = inboxesRef.current.find((inbox) => inbox.id === editing.id) ?? editing;
        const updated = await client.update(editing.id, inboxRequest(form, current.enabled));
        setInboxes((list) => list.map((item) => (item.id === updated.id ? updated : item)));
        toast('success', 'Inbox updated');
      } else {
        const created = await client.create(inboxRequest(form, true));
        setCreatedId(created.id);
        toast('success', `${created.name} created`);
      }
      announceInboxChange();
      closeForm();
      await reloadAndCheckNew();
    } catch (error) {
      toast('error', errorMessage(error, 'Could not save the inbox'));
    } finally {
      setSaving(false);
    }
  };

  /** Turning off drops mail, so it asks first; turning on does not. */
  const requestToggle = (inbox: InboxSettings) => {
    if (togglingRef.current.has(inbox.id)) return;
    if (inbox.enabled) setOffTarget(inbox);
    else void handleToggle(inbox);
  };

  const setToggling = (id: string, on: boolean) => {
    if (on) togglingRef.current.add(id);
    else togglingRef.current.delete(id);
    setTogglingIds(new Set(togglingRef.current));
  };

  const handleToggle = async (target: InboxSettings) => {
    if (togglingRef.current.has(target.id)) return;
    // The rest of the inbox as it is now, so a switch never undoes an edit saved since.
    const inbox = inboxesRef.current.find((item) => item.id === target.id) ?? target;
    setToggling(inbox.id, true);
    try {
      const updated = await client.update(inbox.id, { ...inboxInput(inbox), enabled: !inbox.enabled });
      setInboxes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      announceInboxChange();
      toast('success', updated.enabled ? `${updated.name} turned on` : `${updated.name} turned off`);
    } catch (error) {
      toast('error', errorMessage(error, 'Could not update the inbox'));
    } finally {
      setToggling(inbox.id, false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <section className="glass-card rounded-xl p-4 lg:p-6" aria-busy="true">
        <SectionHeading />
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin motion-reduce:animate-none text-zinc-400" size={24} aria-label="Loading the inbox" role="status" />
        </div>
      </section>
    );
  }

  const needsSetup = !relay || inboxes.length === 0 || inboxes.some(isWaiting);
  const created = createdId ? inboxes.find((inbox) => inbox.id === createdId) ?? null : null;
  const setupOpen = setupChoice ?? needsSetup;

  return (
    <section id="email-inboxes" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      <SectionHeading
        action={!showForm && loaded ? (
          <Button id={addButtonId} size="sm" className="flex-shrink-0 whitespace-nowrap" onClick={() => openForm(null)} icon={<Plus size={14} aria-hidden="true" />}>
            <span className="sm:hidden">Add</span>
            <span className="hidden sm:inline">Add inbox</span>
          </Button>
        ) : null}
      />

      {showForm && (
        <InboxForm
          form={form}
          errors={errors}
          editing={editing}
          relay={relay}
          team={team}
          saving={saving}
          onChange={updateField}
          onSave={handleSave}
          onCancel={closeForm}
        />
      )}

      {created && !showForm && (
        <div className="mb-6 rounded-lg border border-white/[0.08] bg-white/[0.03] p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-white">{created.name} is ready. One step left.</h3>
              <p className="mt-0.5 text-xs text-zinc-400">
                Forward its address to its relay address at your mail host, then send a test email.
              </p>
            </div>
            <Button size="sm" variant="secondary" className="flex-shrink-0" onClick={() => setCreatedId(null)}>Done</Button>
          </div>
          <EmailConnectChecklist
            routingAddress={created.routing_address}
            publicAddress={created.address}
            lastReceivedAt={created.last_received_at}
            verification={{ code: created.verification_code, verifiedAt: created.verified_at }}
            offNote={created.enabled ? null : 'Off. Mail sent here is dropped, not queued. Turn it on to receive again.'}
          />
        </div>
      )}

      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
          <p className="flex items-start gap-2 text-sm text-red-300 min-w-0">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span className="min-w-0">{loadError}</span>
          </p>
          <Button size="sm" variant="secondary" className="flex-shrink-0" onClick={retryLoad} disabled={retrying}>
            {retrying ? 'Retrying...' : 'Retry'}
          </Button>
        </div>
      ) : inboxes.length > 0 ? (
        <>
          <ul className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
            {inboxes.map((inbox) => (
              <InboxCard
                key={inbox.id}
                inbox={inbox}
                team={team}
                toggling={togglingIds.has(inbox.id)}
                editing={showForm && editing?.id === inbox.id}
                onEdit={() => openForm(inbox)}
                onToggle={() => requestToggle(inbox)}
              />
            ))}
          </ul>
          <p className="text-xs text-zinc-400 mt-3">
            Inboxes are turned off, never deleted, so stored mail and its files stay until retention removes them.
          </p>
        </>
      ) : !showForm ? (
        <div className="text-center py-6 text-zinc-400">
          <Inbox className="mx-auto mb-2" size={24} aria-hidden="true" />
          <p className="text-sm">No inbox yet</p>
          <p className="text-xs mt-1">Add one and choose who reads the mail that reaches it</p>
        </div>
      ) : null}

      {loaded && (
        <div className="mt-6 border-t border-white/[0.06] pt-5">
          <button
            type="button"
            onClick={() => setSetupChoice(!setupOpen)}
            aria-expanded={setupOpen}
            aria-controls={setupId}
            className="flex w-full items-center justify-between gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium text-white">Setup</span>
              <span className="block text-xs text-zinc-400">Relay domain, MX records and how to connect each inbox.</span>
            </span>
            <ChevronDown
              size={16}
              aria-hidden="true"
              className={`flex-shrink-0 text-zinc-400 transition-transform motion-reduce:transition-none ${setupOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {setupOpen && (
            <div id={setupId} className="mt-4">
              <RelayDomainRow relay={relay} onSave={saveRelay} />
              {domains.length > 0 && <MxStatusBlock domains={domains} checks={mx} onRefresh={() => checkMx(domains)} />}
              {inboxes.length > 0 && (
                <ul className="space-y-4">
                  {inboxes.map((inbox) => (
                    <li key={inbox.id} className="space-y-2">
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                        <span className="text-xs text-zinc-400 flex-shrink-0">{inbox.name}&apos;s relay address</span>
                        <code title={inbox.routing_address} className="min-w-0 truncate px-1.5 py-0.5 bg-white/[0.06] rounded text-xs font-mono text-zinc-300">
                          {inbox.routing_address}
                        </code>
                        <CopyValueButton value={inbox.routing_address} label={`Copy ${inbox.routing_address}`} />
                      </div>
                      <EmailConnectChecklist
                        routingAddress={inbox.routing_address}
                        publicAddress={inbox.address}
                        lastReceivedAt={inbox.last_received_at}
                        verification={{ code: inbox.verification_code, verifiedAt: inbox.verified_at }}
                        offNote={inbox.enabled ? null : 'Off. Mail sent here is dropped, not queued. Turn it on to receive again.'}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!offTarget}
        onClose={() => setOffTarget(null)}
        onConfirm={() => {
          if (offTarget) void handleToggle(offTarget);
        }}
        title={`Turn off ${offTarget?.name ?? 'this inbox'}?`}
        message={`Mail sent to ${offTarget?.address ?? 'it'}, and to your addresses that deliver to it, is dropped while it is off, not queued. Mail already in it stays. You can turn it back on any time.`}
        confirmLabel="Turn off"
        variant="danger"
        doubleConfirm={false}
      />
    </section>
  );
}

function SectionHeading({ action = null }: { action?: React.ReactNode }) {
  return (
    <SettingsSectionHeader
      icon={Inbox}
      title="Who handles your mail"
      description="Who reads the mail that reaches your addresses, and who else can see it. Replies are never sent from here; you answer from your own mail."
      action={action}
    />
  );
}
