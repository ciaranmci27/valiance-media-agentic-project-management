'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Inbox, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { CopyValueButton, EmailConnectChecklist, relativeTime } from '@/components/settings/EmailConnectChecklist';
import { currentError, inboxStatus, isWaiting, STATUS_DOT } from '@/components/settings/email/inbox-status';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { announceInboxChange, inboxSettingsClient } from '@/lib/communications/inbox-client';
import { OWNERS_READ_PERSONAL_LINE, type InboxSettings, type MyInboxInput } from '@/lib/communications/inbox-types';
import type { TeamMember } from '@/lib/types';

/**
 * Settings > Email > Your inbox: connect your own email. Forward your mail to
 * the relay address, verify it, pick the agent that sorts it and, if you
 * like, who else may read it. Nobody else reads it, Owners included, unless
 * the workspace lets Owners read personal inboxes (then a line says so).
 * Turned off, never deleted once it holds mail; an empty one can be removed.
 */

const WAITING_POLL_MS = 20_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The Select value for "no agent". */
const NOBODY = 'none';

interface FormState {
  address: string;
  handler: string;
  access_member_ids: string[];
}

const byName = (a: TeamMember, b: TeamMember) => a.name.localeCompare(b.name);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function inputOf(form: FormState, enabled: boolean): MyInboxInput {
  const handler = form.handler === NOBODY ? null : form.handler || null;
  return {
    address: form.address.trim().toLowerCase(),
    handler_member_id: handler,
    enabled,
    access_member_ids: form.access_member_ids.filter((id) => id !== handler),
  };
}

function inputOfInbox(inbox: InboxSettings, enabled = inbox.enabled): MyInboxInput {
  return {
    address: inbox.address,
    handler_member_id: inbox.handler_member_id,
    enabled,
    access_member_ids: inbox.access_member_ids.filter((id) => id !== inbox.handler_member_id),
  };
}

export function PersonalInboxSection() {
  const { isDemoMode } = useDemo();
  const { team, emailsRefreshSignal } = useApp();
  const { access } = useAuth();
  const myId = access?.member_id ?? null;
  const client = useMemo(() => inboxSettingsClient(isDemoMode), [isDemoMode]);
  const connectButtonId = useId();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inboxes, setInboxes] = useState<InboxSettings[]>([]);
  const [ownersRead, setOwnersRead] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<InboxSettings | null>(null);
  const [form, setForm] = useState<FormState>({ address: '', handler: '', access_member_ids: [] });
  const [addressError, setAddressError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(new Set());
  const togglingRef = useRef(new Set<string>());
  const [offTarget, setOffTarget] = useState<InboxSettings | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InboxSettings | null>(null);

  const agents = useMemo(() => team.filter((m) => m.role === 'agent' && m.status !== 'suspended').sort(byName), [team]);

  // ─── Fetch ──────────────────────────────────────────────────────────────────

  const load = useCallback(async (quiet = false) => {
    try {
      const data = await client.myInboxes();
      setInboxes(data.inboxes);
      setOwnersRead(data.owners_read_personal);
      setLoadError(null);
    } catch (error) {
      if (!quiet) setLoadError(errorMessage(error, 'Could not load your inbox'));
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

  // Live status: refresh quietly when email data changes, and while an inbox waits for its first email.
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

  // ─── Form ───────────────────────────────────────────────────────────────────

  const openForm = (inbox: InboxSettings | null) => {
    if (inbox && togglingRef.current.has(inbox.id)) return;
    setForm(inbox
      ? { address: inbox.address, handler: inbox.handler_member_id ?? NOBODY, access_member_ids: inbox.access_member_ids.filter((id) => id !== inbox.handler_member_id) }
      : { address: '', handler: agents.length === 1 ? agents[0].id : '', access_member_ids: [] });
    setAddressError(undefined);
    setEditing(inbox);
    setFormOpen(true);
  };

  const closeForm = () => {
    const opener = editing ? `my-inbox-edit-${editing.id}` : connectButtonId;
    setFormOpen(false);
    setEditing(null);
    requestAnimationFrame(() => document.getElementById(opener)?.focus());
  };

  const save = async () => {
    const address = form.address.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setAddressError('Enter your email address, such as you@yourdomain.com');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const current = inboxes.find((inbox) => inbox.id === editing.id) ?? editing;
        const updated = await client.updateMine(editing.id, inputOf(form, current.enabled));
        setInboxes((list) => list.map((item) => (item.id === updated.id ? updated : item)));
        toast('success', 'Your inbox is saved');
      } else {
        const created = await client.createMine(inputOf(form, true));
        setInboxes((list) => [...list, created]);
        toast('success', 'Inbox added. Forward your mail to finish.');
      }
      announceInboxChange();
      closeForm();
    } catch (error) {
      toast('error', errorMessage(error, 'Could not save your inbox'));
    } finally {
      setSaving(false);
    }
  };

  // ─── Switch and remove ──────────────────────────────────────────────────────

  const setToggling = (id: string, on: boolean) => {
    if (on) togglingRef.current.add(id);
    else togglingRef.current.delete(id);
    setTogglingIds(new Set(togglingRef.current));
  };

  const toggle = async (target: InboxSettings) => {
    if (togglingRef.current.has(target.id)) return;
    const inbox = inboxes.find((item) => item.id === target.id) ?? target;
    setToggling(inbox.id, true);
    try {
      const updated = await client.updateMine(inbox.id, inputOfInbox(inbox, !inbox.enabled));
      setInboxes((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      announceInboxChange();
      toast('success', updated.enabled ? 'Your inbox is on' : 'Your inbox is off');
    } catch (error) {
      toast('error', errorMessage(error, 'Could not change your inbox'));
    } finally {
      setToggling(inbox.id, false);
    }
  };

  /** Turning off drops mail, so it asks first; turning on does not. */
  const requestToggle = (inbox: InboxSettings) => {
    if (togglingRef.current.has(inbox.id)) return;
    if (inbox.enabled) setOffTarget(inbox);
    else void toggle(inbox);
  };

  const remove = async (inbox: InboxSettings) => {
    try {
      await client.removeMine(inbox.id);
      setInboxes((list) => list.filter((item) => item.id !== inbox.id));
      announceInboxChange();
      toast('success', `${inbox.address} removed`);
    } catch (error) {
      toast('error', errorMessage(error, 'Could not remove it'));
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  const heading = (
    <SettingsSectionHeader
      icon={Inbox}
      title="Your inbox"
      description="Forward your own email here and your agent sorts it with your projects: colleagues, partners, clients. Only you and the people you choose can read it. Replies are never sent from here."
      action={!formOpen && !loading && !loadError ? (
        <Button id={connectButtonId} size="sm" className="flex-shrink-0 whitespace-nowrap" onClick={() => openForm(null)} icon={<Plus size={14} aria-hidden="true" />}>
          <span className="sm:hidden">{inboxes.length ? 'Add' : 'Connect'}</span>
          <span className="hidden sm:inline">{inboxes.length ? 'Add an address' : 'Connect your email'}</span>
        </Button>
      ) : null}
    />
  );

  if (loading) {
    return (
      <section className="glass-card rounded-xl p-4 lg:p-6" aria-busy="true">
        {heading}
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin motion-reduce:animate-none text-zinc-400" size={24} aria-label="Loading your inbox" role="status" />
        </div>
      </section>
    );
  }

  return (
    <section id="my-inbox" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      {heading}

      {ownersRead && <p className="-mt-2 mb-4 text-[11px] text-zinc-500">{OWNERS_READ_PERSONAL_LINE}</p>}

      {formOpen && (
        <MyInboxForm
          form={form}
          editing={editing}
          team={team}
          agents={agents}
          myId={myId}
          addressError={addressError}
          saving={saving}
          onChange={(next) => {
            setForm(next);
            setAddressError(undefined);
          }}
          onSave={save}
          onCancel={closeForm}
        />
      )}

      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
          <p className="flex items-start gap-2 text-sm text-red-300 min-w-0">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span className="min-w-0">{loadError}</span>
          </p>
          <Button size="sm" variant="secondary" className="flex-shrink-0" onClick={() => void load()}>Retry</Button>
        </div>
      ) : inboxes.length > 0 ? (
        <>
          <ul className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
            {inboxes.map((inbox) => (
              <MyInboxCard
                key={inbox.id}
                inbox={inbox}
                team={team}
                toggling={togglingIds.has(inbox.id)}
                editing={formOpen && editing?.id === inbox.id}
                onEdit={() => openForm(inbox)}
                onToggle={() => requestToggle(inbox)}
                onRemove={() => setRemoveTarget(inbox)}
              />
            ))}
          </ul>
          <p className="text-xs text-zinc-400 mt-3">
            An inbox that holds mail is turned off, never deleted, so its mail stays until it is 90 days old.
          </p>
        </>
      ) : !formOpen ? (
        <div className="text-center py-6 text-zinc-400">
          <Inbox className="mx-auto mb-2" size={24} aria-hidden="true" />
          <p className="text-sm">Your email is not connected yet</p>
          <p className="text-xs mt-1">Connect it to see your mail sorted by project, with tasks your agent made from it.</p>
        </div>
      ) : null}

      <ConfirmDialog
        isOpen={!!offTarget}
        onClose={() => setOffTarget(null)}
        onConfirm={() => {
          if (offTarget) void toggle(offTarget);
        }}
        title="Turn off your inbox?"
        message={`Mail you forward from ${offTarget?.address ?? 'your address'} is dropped while it is off, not queued. Mail already here stays. You can turn it back on any time.`}
        confirmLabel="Turn off"
        variant="danger"
      />
      <ConfirmDialog
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) void remove(removeTarget);
        }}
        title={`Remove ${removeTarget?.address ?? 'this address'}?`}
        message="It holds no mail yet, so nothing is lost. Stop forwarding to its relay address at your mail host too."
        confirmLabel="Remove"
        variant="danger"
      />
    </section>
  );
}

function MyInboxForm({
  form,
  editing,
  team,
  agents,
  myId,
  addressError,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  form: FormState;
  editing: InboxSettings | null;
  team: TeamMember[];
  agents: TeamMember[];
  myId: string | null;
  addressError: string | undefined;
  saving: boolean;
  onChange: (next: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const handler = form.handler && form.handler !== NOBODY ? team.find((m) => m.id === form.handler) ?? null : null;
  const handlerOptions = useMemo<SelectOption[]>(() => {
    const options = [{ value: NOBODY, label: 'Nobody, I read it myself' }, ...agents.map((m) => ({ value: m.id, label: m.name }))];
    // A suspended agent this inbox already has stays shown.
    const current = team.find((m) => m.id === form.handler);
    if (current && !agents.includes(current) && current.role === 'agent') options.push({ value: current.id, label: current.name });
    return options;
  }, [agents, team, form.handler]);
  const accessOptions = useMemo(
    () => [...team]
      .filter((m) => m.id !== myId && m.id !== handler?.id && m.status !== 'suspended')
      .sort(byName)
      .map((m) => ({ value: m.id, label: m.role === 'agent' ? `${m.name} (agent)` : m.name })),
    [team, myId, handler],
  );

  return (
    <form
      className="mb-6 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg space-y-5 animate-slideDown"
      aria-label={editing ? `Edit ${editing.address}` : 'Connect your email'}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h3 className="text-sm font-medium text-white">{editing ? `Edit ${editing.address}` : 'Connect your email'}</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TextInput
          label="Your email address"
          type="email"
          value={form.address}
          onChange={(value) => onChange({ ...form, address: value })}
          placeholder="e.g. you@yourdomain.com"
          description="The address your mail arrives at"
          error={addressError}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <Select
          label="Who sorts it"
          visibleLabel="Who sorts it"
          value={form.handler}
          onChange={(value) => onChange({ ...form, handler: value })}
          options={handlerOptions}
          placeholder="Choose an agent"
          description={handler ? `${handler.name} files your mail on its project and turns requests into tasks.` : 'Pick an agent to file your mail on its project and turn requests into tasks.'}
          searchable={handlerOptions.length > 8}
        />
      </div>

      <div className="max-w-xl space-y-1.5">
        <MultiSelect
          label="Who else can read it"
          options={accessOptions}
          value={form.access_member_ids.filter((id) => id !== handler?.id)}
          onChange={(value) => onChange({ ...form, access_member_ids: value })}
          placeholder={handler ? `Only you and ${handler.name}` : 'Only you'}
          searchable
        />
        <p className="text-xs text-zinc-400">Optional, for example an assistant. Nobody else sees it.</p>
      </div>

      <div className="flex gap-2 pt-4 border-t border-white/[0.08]">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving...' : editing ? 'Save changes' : 'Connect'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function MyInboxCard({
  inbox,
  team,
  toggling,
  editing,
  onEdit,
  onToggle,
  onRemove,
}: {
  inbox: InboxSettings;
  team: TeamMember[];
  toggling: boolean;
  editing: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const handler = inbox.handler_member_id ? team.find((m) => m.id === inbox.handler_member_id) ?? null : null;
  const others = inbox.access_member_ids
    .filter((id) => id !== inbox.handler_member_id)
    .map((id) => team.find((m) => m.id === id)?.name ?? 'Unknown member')
    .sort((a, b) => a.localeCompare(b));
  const status = inboxStatus(inbox);
  const error = currentError(inbox);
  const switchLocked = toggling || editing;

  return (
    <li className="px-4 py-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-medium text-white" title={inbox.address}>{inbox.address}</h3>
            <Badge variant={inbox.enabled ? 'success' : 'default'}>{inbox.enabled ? 'On' : 'Off'}</Badge>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-zinc-400">
            <span className="flex-shrink-0">Forward to</span>
            <span title={inbox.routing_address} className="min-w-0 truncate font-mono">{inbox.routing_address}</span>
            <CopyValueButton value={inbox.routing_address} label={`Copy ${inbox.routing_address}`} />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {toggling && (
            <Loader2 size={14} className="animate-spin text-zinc-400 motion-reduce:animate-none" role="status" aria-label={`Saving ${inbox.address}`} />
          )}
          {inbox.message_count === 0 && (
            <Tooltip content="Remove">
              <button
                type="button"
                onClick={onRemove}
                aria-label={`Remove ${inbox.address}`}
                className="p-1.5 text-zinc-400 hover:text-red-300 hover:bg-red-500/15 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          <Tooltip content="Edit">
            <button
              type="button"
              id={`my-inbox-edit-${inbox.id}`}
              onClick={() => {
                if (!toggling) onEdit();
              }}
              aria-disabled={toggling || undefined}
              aria-label={`Edit ${inbox.address}`}
              className="p-1.5 text-zinc-400 hover:text-brand-300 hover:bg-brand-500/15 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={editing ? 'Save or cancel the edit first' : inbox.enabled ? 'Turn off' : 'Turn on'}>
            <Toggle
              size="sm"
              checked={inbox.enabled}
              onChange={() => {
                if (!switchLocked) onToggle();
              }}
              aria-disabled={switchLocked || undefined}
              aria-label={`Receive mail for ${inbox.address}`}
            />
          </Tooltip>
        </div>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <div className="min-w-0">
          <dt className="text-zinc-400">Sorted by</dt>
          <dd className="text-zinc-200 break-words">{inbox.handler_member_id ? handler?.name ?? 'An agent no longer on the team' : 'Nobody, you read it yourself'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-zinc-400">Who else can read it</dt>
          <dd className="text-zinc-200 break-words">{others.length ? others.join(', ') : 'Nobody else'}</dd>
        </div>
      </dl>

      {/* While waiting, the checklist below says so; the line would repeat it. */}
      {!isWaiting(inbox) && (
        <p className="flex items-center gap-2 text-xs">
          <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT[status.tone]}`} />
          <span className={status.tone === 'on' ? 'text-emerald-300' : 'text-zinc-400'}>{status.text}</span>
        </p>
      )}

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

      <EmailConnectChecklist
        personal
        routingAddress={inbox.routing_address}
        publicAddress={inbox.address}
        lastReceivedAt={inbox.last_received_at}
        verification={{ code: inbox.verification_code, verifiedAt: inbox.verified_at }}
        offNote={inbox.enabled ? null : 'Off. Mail forwarded here is dropped, not queued. Turn it on to receive again.'}
      />
    </li>
  );
}
