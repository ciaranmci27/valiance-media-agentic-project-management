'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Mail, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import type { ClientSenderAddress } from '@/lib/inbound-email/inbox-types';
import { validateClientSenderAddress } from '@/lib/inbound-email/addresses';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { fieldLabelClass } from '@/components/ui/inputs/_shared';

interface ClientEmailAddressesProps {
  isOpen: boolean;
  projectId: string;
}

const rowKey = (row: ClientSenderAddress) => `${row.source}:${row.address}`;

/**
 * Exact client addresses whose mail maps to the project, as one list: every
 * address of the project's contacts (tagged Contact, managed in Contacts, not
 * removable here) and client email addresses added on the project, public
 * services like gmail.com included (removable). An address that is both shows
 * once, as the contact's, with its added row still removable. Everyone who
 * can see the project sees the list; people who manage contacts or the inbox
 * add and remove client email addresses.
 */
export function ClientEmailAddresses({ isOpen, projectId }: ClientEmailAddressesProps) {
  const { emailsRefreshSignal, contacts, contactEmails, projectContacts } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const canManage = hasPermission(access, 'contacts.manage') || hasPermission(access, 'inbound_email.manage');
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const inputId = useId();

  const [addresses, setAddresses] = useState<ClientSenderAddress[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ClientSenderAddress | null>(null);

  // Changes to this project's contacts (realtime keeps these slices fresh)
  // change the list, so they refetch it; changes elsewhere do not.
  const contactsKey = useMemo(() => {
    const ids = new Set(projectContacts.filter(link => link.project_id === projectId).map(link => link.contact_id));
    const names = contacts.filter(contact => ids.has(contact.id)).map(contact => `${contact.id}:${contact.name}`).sort();
    const emails = contactEmails.filter(row => ids.has(row.contact_id)).map(row => `${row.contact_id}:${row.email}`).sort();
    return `${[...ids].sort().join(',')}|${names.join(',')}|${emails.join(',')}`;
  }, [contacts, contactEmails, projectContacts, projectId]);

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await client.listSenders(projectId);
      if (!signal.cancelled) setAddresses(list.addresses);
    } catch (error) {
      if (!signal.cancelled) setLoadError(error instanceof Error ? error.message : 'Could not load addresses');
    } finally {
      if (!signal.cancelled) setLoading(false);
    }
  }, [client, projectId]);

  // Fetch when the panel opens, on realtime email or contact changes, and on retry.
  useEffect(() => {
    if (!isOpen || !projectId) return;
    const signal = { cancelled: false };
    void load(signal);
    return () => { signal.cancelled = true; };
  }, [isOpen, projectId, emailsRefreshSignal, contactsKey, reloadKey, load]);

  // A fresh panel starts with an empty add field.
  useEffect(() => {
    if (isOpen) return;
    setDraft('');
    setAddError(undefined);
  }, [isOpen]);

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (adding) return;
    if (!draft.trim()) {
      setAddError('Type an address, such as bob@gmail.com');
      return;
    }
    const result = validateClientSenderAddress(draft);
    if (!result.ok) {
      setAddError(result.error);
      return;
    }
    const known = addresses.find(row => row.address === result.address);
    if (known) {
      setAddError(known.source === 'contact'
        ? `${result.address} belongs to a contact on this project, so it already routes here.`
        : `${result.address} is already on this project.`);
      return;
    }
    setAdding(true);
    setAddError(undefined);
    try {
      const row = await client.addSender(projectId, result.address);
      setAddresses(prev => {
        const contactsFirst = prev.filter(r => r.source === 'contact');
        const manual = [...prev.filter(r => r.source === 'manual' && r.address !== row.address), row]
          .sort((a, b) => a.address.localeCompare(b.address));
        return [...contactsFirst, ...manual];
      });
      setDraft('');
      toast('success', `Added ${row.address}`);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Could not add the address');
    } finally {
      setAdding(false);
    }
  };

  const executeRemove = async () => {
    const target = removeTarget;
    if (!target?.id) return;
    try {
      await client.removeSender(projectId, target.id);
      // A contact's address stays on the list, through the contact.
      setAddresses(prev => prev.flatMap(row => {
        if (row.id !== target.id) return [row];
        return row.source === 'contact' ? [{ ...row, id: null, created_at: null }] : [];
      }));
      toast('success', `Removed ${target.address}`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not remove the address');
    }
  };

  return (
    <section aria-labelledby={`${inputId}-heading`} className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Mail size={14} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
          <h4 id={`${inputId}-heading`} className="text-sm font-medium text-white">
            Client email addresses <span className="font-normal text-zinc-400">(optional)</span>
          </h4>
          {loading && (
            <Loader2 size={14} className="text-zinc-500 animate-spin motion-reduce:animate-none" aria-label="Loading addresses" role="status" />
          )}
        </div>
        <p className="text-xs text-zinc-400">
          Mail from these exact addresses maps to this project, even from gmail.com. Contact addresses are managed in Contacts.
        </p>
      </div>

      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2">
          <p className="text-xs text-red-400">{loadError}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReloadKey(key => key + 1)}>
            Retry
          </Button>
        </div>
      ) : addresses.length > 0 ? (
        <ul className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-lg">
          {addresses.map(row => (
            <li key={rowKey(row)} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm text-zinc-300 truncate">{row.address}</p>
                {row.contact_name && <p className="text-xs text-zinc-400 truncate">{row.contact_name}</p>}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {row.source === 'contact' && (
                  <Badge>
                    Contact<span className="sr-only">, managed in Contacts</span>
                  </Badge>
                )}
                {canManage && row.id && (
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(row)}
                    aria-label={row.source === 'contact' ? `Remove ${row.address} as an added address` : `Remove ${row.address}`}
                    className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/15 transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : !loading ? (
        <p className="text-xs text-zinc-400">None yet. Optional: add one when a client writes from a personal address.</p>
      ) : null}

      {canManage && (
        <form onSubmit={handleAdd} noValidate className="space-y-1.5">
          <label htmlFor={inputId} className={fieldLabelClass()}>Add an address</label>
          <div className="flex items-start gap-2">
            <TextInput
              id={inputId}
              type="email"
              value={draft}
              onChange={(value) => {
                setDraft(value);
                if (addError) setAddError(undefined);
              }}
              placeholder="bob@gmail.com"
              autoComplete="off"
              spellCheck={false}
              error={addError}
              disabled={adding}
              className="flex-1 min-w-0"
            />
            {/* Focusable while empty, so a keyboard or screen reader user reaches it and hears why it does nothing. */}
            <Button
              type="submit"
              disabled={adding}
              aria-disabled={!draft.trim() || undefined}
              aria-describedby={!draft.trim() ? `${inputId}-hint` : undefined}
              className="flex-shrink-0 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
            >
              {adding ? 'Adding...' : 'Add'}
            </Button>
          </div>
          <span id={`${inputId}-hint`} className="sr-only">Type an address first</span>
        </form>
      )}

      {/* Portaled: the Modal panel is transformed, which would trap a fixed overlay inside it. */}
      {canManage && typeof document !== 'undefined' && createPortal(
        <ConfirmDialog
          isOpen={!!removeTarget}
          onClose={() => setRemoveTarget(null)}
          onConfirm={executeRemove}
          title="Remove address"
          message={removeTarget?.source === 'contact'
            ? `${removeTarget.address} belongs to a contact, so its mail keeps landing here.`
            : `Mail from ${removeTarget?.address ?? 'this address'} will no longer map to this project.`}
          confirmLabel="Remove"
          variant="danger"
          doubleConfirm={false}
        />,
        document.body,
      )}
    </section>
  );
}
