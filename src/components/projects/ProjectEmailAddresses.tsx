'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, AtSign, Loader2, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import type { ProjectEmailAddress, ProjectEmailAddressList } from '@/lib/inbound-email/inbox-types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { CopyValueButton, EmailConnectChecklist } from '@/components/settings/EmailConnectChecklist';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { Toggle } from '@/components/ui/inputs/Toggle';

interface ProjectEmailAddressesProps {
  isOpen: boolean;
  projectId: string;
}

interface FormState {
  /** null adds a new address; otherwise the address being edited. */
  editing: ProjectEmailAddress | null;
  local: string;
  publicAddress: string;
  inboxId: string;
}

interface FormErrors {
  local?: string;
  publicAddress?: string;
  inboxId?: string;
}

const LOCAL_PART_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ICON_BUTTON =
  'p-1 rounded text-zinc-500 transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
/** How often the list refreshes while an address waits for its first email. */
const WAITING_POLL_MS = 20_000;

/** What clients see, falling back to the routing address. */
const shownAddress = (row: ProjectEmailAddress) => row.public_address ?? row.routing_address;

/**
 * The project's own email addresses: mail to one lands in the inbox it names,
 * filed on this project. A project can have several, so an address can change
 * without dropping mail from clients still writing to the old one: add the new
 * one and turn the old one off later. Readers see the list; people who manage
 * contacts or the inbox add, edit, turn off and delete. Each address shows how
 * to connect it (EmailConnectChecklist) and whether mail has come through.
 */
export function ProjectEmailAddresses({ isOpen, projectId }: ProjectEmailAddressesProps) {
  const { emailsRefreshSignal } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const canManage = hasPermission(access, 'contacts.manage') || hasPermission(access, 'inbound_email.manage');
  const canManageInboxes = hasPermission(access, 'inbound_email.manage');
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const baseId = useId();

  const [data, setData] = useState<ProjectEmailAddressList | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProjectEmailAddress | null>(null);

  /** A quiet load (the waiting poll) shows no spinner and keeps the list on failure. */
  const load = useCallback(async (signal: { cancelled: boolean }, quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const list = await client.listAddresses(projectId);
      if (!signal.cancelled) setData(list);
    } catch (error) {
      if (!signal.cancelled && !quiet) setLoadError(error instanceof Error ? error.message : 'Could not load the addresses');
    } finally {
      if (!signal.cancelled && !quiet) setLoading(false);
    }
  }, [client, projectId]);

  // Fetch when the panel opens, on realtime email changes, and on retry.
  useEffect(() => {
    if (!isOpen || !projectId) return;
    const signal = { cancelled: false };
    void load(signal);
    return () => { signal.cancelled = true; };
  }, [isOpen, projectId, emailsRefreshSignal, reloadKey, load]);

  // Live status: while an address that takes mail waits for its first email,
  // check again now and then (realtime changes reload above as well).
  const anyWaiting = !!data?.addresses.some((row) =>
    row.enabled && !row.last_received_at && data.inboxes.some((inbox) => inbox.id === row.inbox_id && inbox.enabled));
  useEffect(() => {
    if (!isOpen || !anyWaiting || loadError) return;
    const signal = { cancelled: false };
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(signal, true);
    }, WAITING_POLL_MS);
    return () => {
      signal.cancelled = true;
      clearInterval(timer);
    };
  }, [isOpen, anyWaiting, loadError, load]);

  // A fresh panel starts with the form closed.
  useEffect(() => {
    if (isOpen) return;
    setForm(null);
    setErrors({});
    setFormError(null);
  }, [isOpen]);

  const addresses = data?.addresses ?? [];
  const inboxes = useMemo(() => data?.inboxes ?? [], [data]);
  const inboxName = (id: string) => inboxes.find((inbox) => inbox.id === id);
  const inboxOptions = useMemo<SelectOption[]>(
    () => inboxes.map((inbox) => ({ value: inbox.id, label: inbox.enabled ? inbox.name : `${inbox.name} (off)`, detail: inbox.address })),
    [inboxes],
  );

  const replaceRow = (row: ProjectEmailAddress) =>
    setData((prev) => (prev ? { ...prev, addresses: prev.addresses.map((existing) => (existing.id === row.id ? row : existing)) } : prev));

  const openAdd = () => {
    setForm({ editing: null, local: '', publicAddress: '', inboxId: inboxes.find((inbox) => inbox.enabled)?.id ?? '' });
    setErrors({});
    setFormError(null);
  };

  const openEdit = (row: ProjectEmailAddress) => {
    setForm({ editing: row, local: row.routing_local_part, publicAddress: row.public_address ?? '', inboxId: row.inbox_id });
    setErrors({});
    setFormError(null);
  };

  const closeForm = () => {
    setForm(null);
    setErrors({});
    setFormError(null);
  };

  const change = <K extends keyof Omit<FormState, 'editing'>>(field: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [field]: value } : prev));
    const key = field as keyof FormErrors;
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
    if (formError) setFormError(null);
  };

  const local = form?.local.trim().toLowerCase() ?? '';
  const publicAddress = form?.publicAddress.trim().toLowerCase() ?? '';
  const domain = form?.editing?.routing_domain ?? data?.relay_domain ?? '';
  // Left empty, the routing local part comes from the public address (the server does the same).
  const effectiveLocal = local || publicAddress.split('@')[0].replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '');
  const routingChanged = !!form?.editing && effectiveLocal !== form.editing.routing_local_part;

  const validate = (): FormErrors => {
    const next: FormErrors = {};
    if (local && !LOCAL_PART_PATTERN.test(local)) next.local = 'Use letters, numbers, dots, dashes or underscores';
    if (!local && !publicAddress) next.local = 'Enter the routing address, such as p4tf';
    if (publicAddress && !EMAIL_PATTERN.test(publicAddress)) next.publicAddress = 'Enter a full address, such as p4tf@yourdomain.com';
    if (!form?.inboxId) next.inboxId = 'Choose the inbox that receives this mail';
    return next;
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form || saving) return;
    const found = validate();
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setSaving(true);
    setFormError(null);
    const input = { inbox_id: form.inboxId, routing_local_part: local, public_address: publicAddress || null };
    try {
      if (form.editing) {
        const row = await client.updateAddress(projectId, form.editing.id, input);
        replaceRow(row);
        toast('success', `Saved ${shownAddress(row)}`);
      } else {
        const row = await client.addAddress(projectId, { ...input, enabled: true });
        setData((prev) => (prev ? { ...prev, addresses: [...prev.addresses.filter((existing) => existing.id !== row.id), row] } : prev));
        toast('success', `Added ${shownAddress(row)}`);
      }
      closeForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not save the address');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (row: ProjectEmailAddress) => {
    if (togglingId) return;
    setTogglingId(row.id);
    try {
      const updated = await client.updateAddress(projectId, row.id, { enabled: !row.enabled });
      replaceRow(updated);
      toast('success', updated.enabled ? `Turned on ${shownAddress(updated)}` : `Turned off ${shownAddress(updated)}`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change the address');
    } finally {
      setTogglingId(null);
    }
  };

  const executeRemove = async () => {
    const target = removeTarget;
    if (!target) return;
    try {
      await client.removeAddress(projectId, target.id);
      setData((prev) => (prev ? { ...prev, addresses: prev.addresses.filter((row) => row.id !== target.id) } : prev));
      if (form?.editing?.id === target.id) closeForm();
      toast('success', `Deleted ${shownAddress(target)}`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not delete the address');
    }
  };

  const headingId = `${baseId}-heading`;
  const formHeadingId = `${baseId}-form`;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <AtSign size={14} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
          <h4 id={headingId} className="text-sm font-medium text-white">
            Project addresses <span className="font-normal text-zinc-400">(optional)</span>
          </h4>
          {loading && (
            <Loader2 size={14} className="text-zinc-500 animate-spin motion-reduce:animate-none" aria-label="Loading addresses" role="status" />
          )}
        </div>
        <p className="text-xs text-zinc-400">
          Mail to one of these lands in its inbox, already filed on this project. Keep an old address on while clients still use it.
        </p>
      </div>

      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2">
          <p className="text-xs text-red-400">{loadError}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
            Retry
          </Button>
        </div>
      ) : addresses.length > 0 ? (
        <ul className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-lg">
          {addresses.map((row) => {
            const inbox = inboxName(row.inbox_id);
            const shown = shownAddress(row);
            return (
              <li key={row.id} className="px-3 py-2.5 space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <p className={`min-w-0 font-mono text-sm break-all ${row.enabled ? 'text-zinc-200' : 'text-zinc-500'}`}>{shown}</p>
                  {canManage ? (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Tooltip content={row.enabled ? 'Turn off' : 'Turn on'}>
                        <Toggle
                          size="sm"
                          checked={row.enabled}
                          onChange={() => void toggle(row)}
                          disabled={togglingId === row.id}
                          aria-label={`Receive mail at ${shown}`}
                        />
                      </Tooltip>
                      <Tooltip content="Edit">
                        <button
                          type="button"
                          onClick={() => openEdit(row)}
                          aria-label={`Edit ${shown}`}
                          className={`${ICON_BUTTON} hover:text-brand-300 hover:bg-brand-500/15`}
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                      </Tooltip>
                      <Tooltip content="Delete">
                        <button
                          type="button"
                          onClick={() => setRemoveTarget(row)}
                          aria-label={`Delete ${shown}`}
                          className={`${ICON_BUTTON} hover:text-red-400 hover:bg-red-500/15`}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    </div>
                  ) : (
                    <span className="text-xs text-zinc-500 flex-shrink-0">{row.enabled ? 'On' : 'Off'}</span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-xs text-zinc-500 flex-shrink-0">Routing</span>
                  <code className="min-w-0 truncate px-1.5 py-0.5 bg-white/[0.06] rounded text-xs font-mono text-zinc-300">
                    {row.routing_address}
                  </code>
                  <CopyValueButton value={row.routing_address} label={`Copy ${row.routing_address}`} />
                </div>

                <p className="text-xs text-zinc-400">
                  Inbox: <span className="text-zinc-300">{inbox?.name ?? 'Unknown inbox'}</span>
                </p>

                <EmailConnectChecklist
                  routingAddress={row.routing_address}
                  publicAddress={row.public_address}
                  lastReceivedAt={row.last_received_at}
                  offNote={!row.enabled
                    ? 'Off. Mail sent here is dropped, not queued.'
                    : inbox && !inbox.enabled
                      ? `Its inbox, ${inbox.name}, is disabled, so mail sent here is dropped, not queued.`
                      : null}
                />
              </li>
            );
          })}
        </ul>
      ) : !loading && data && inboxes.length > 0 ? (
        <p className="text-xs text-zinc-400">None yet. Add one to give this client its own address.</p>
      ) : null}

      {/* No inbox to deliver to: say where to make one, instead of a dead button. */}
      {data && !loadError && inboxes.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <p className="min-w-0 text-xs text-zinc-400">
            An address needs an inbox to deliver to, and there is none yet.
            {!canManageInboxes && ' Ask an admin to add an inbox.'}
          </p>
          {canManageInboxes && (
            <Button href="/settings#email-inboxes" size="sm" variant="secondary" className="flex-shrink-0" icon={<Settings size={14} aria-hidden="true" />}>
              Add an inbox in Settings
            </Button>
          )}
        </div>
      )}

      {canManage && data && !loadError && inboxes.length > 0 && (
        form ? (
          <form onSubmit={handleSave} noValidate aria-labelledby={formHeadingId} className="space-y-3 rounded-lg border border-white/[0.08] bg-white/[0.03] p-3">
            <h5 id={formHeadingId} className="text-sm font-medium text-white">
              {form.editing ? `Edit ${shownAddress(form.editing)}` : 'Add an address'}
            </h5>
            <TextInput
              label="Public address (optional)"
              type="email"
              value={form.publicAddress}
              onChange={(value) => change('publicAddress', value)}
              placeholder="p4tf@yourdomain.com"
              autoComplete="off"
              spellCheck={false}
              error={errors.publicAddress}
              disabled={saving}
            />
            <TextInput
              label="Routing address"
              value={form.local}
              onChange={(value) => change('local', value)}
              placeholder={publicAddress ? effectiveLocal || 'p4tf' : 'p4tf'}
              suffix={`@${domain}`}
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              error={errors.local}
              disabled={saving}
            />
            <Select
              label="Inbox"
              visibleLabel="Inbox"
              value={form.inboxId}
              onChange={(value) => change('inboxId', value)}
              options={inboxOptions}
              placeholder={inboxOptions.length ? 'Choose an inbox' : 'No inboxes yet'}
              error={errors.inboxId}
              disabled={saving || inboxOptions.length === 0}
            />
            {publicAddress && effectiveLocal && domain && (
              <p className="text-xs text-zinc-400">
                After saving, forward <span className="font-mono break-all text-zinc-300">{publicAddress}</span> to{' '}
                <span className="font-mono break-all text-zinc-300">{effectiveLocal}@{domain}</span> at your mail host.
              </p>
            )}
            {routingChanged && form.editing && (
              <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.08] p-2.5 text-xs text-amber-300">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                <span className="min-w-0">
                  Saving stops <span className="font-mono break-all">{form.editing.routing_address}</span> working at once, and mail that
                  clients still send there is dropped. To change it without losing mail, add the new address instead and turn this one
                  off later.
                </span>
              </div>
            )}
            {formError && <p role="alert" className="text-xs text-red-400">{formError}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={closeForm} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? 'Saving...' : form.editing ? 'Save' : 'Add address'}
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            onClick={openAdd}
            icon={<Plus size={14} aria-hidden="true" />}
            className="w-full"
            variant="secondary"
          >
            Add email address
          </Button>
        )
      )}

      {/* Portaled: the Modal panel is transformed, which would trap a fixed overlay inside it. */}
      {canManage && typeof document !== 'undefined' && createPortal(
        <ConfirmDialog
          isOpen={!!removeTarget}
          onClose={() => setRemoveTarget(null)}
          onConfirm={executeRemove}
          title="Delete address"
          message={`Mail to ${removeTarget ? shownAddress(removeTarget) : 'this address'} will be dropped. Threads it already filed keep this project. To pause it instead, turn it off.`}
          confirmLabel="Delete"
          variant="danger"
          doubleConfirm={false}
        />,
        document.body,
      )}
    </section>
  );
}
