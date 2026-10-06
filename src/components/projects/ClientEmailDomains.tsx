'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Globe, Loader2, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import type { ClientEmailDomain } from '@/lib/inbound-email/inbox-types';
import { validateClientDomain } from '@/lib/inbound-email/public-domains';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { fieldLabelClass } from '@/components/ui/inputs/_shared';

interface ClientEmailDomainsProps {
  isOpen: boolean;
  projectId: string;
}

const byDomain = (a: ClientEmailDomain, b: ClientEmailDomain) => a.domain.localeCompare(b.domain);

/**
 * The project's client email domains: mail from any address at one of these
 * maps to the project. Everyone who can see the project sees the list; people
 * who manage contacts or the inbox can add and remove domains.
 */
export function ClientEmailDomains({ isOpen, projectId }: ClientEmailDomainsProps) {
  const { emailsRefreshSignal } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const canManage = hasPermission(access, 'contacts.manage') || hasPermission(access, 'inbound_email.manage');
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const inputId = useId();

  const [domains, setDomains] = useState<ClientEmailDomain[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ClientEmailDomain | null>(null);

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await client.listDomains(projectId);
      if (!signal.cancelled) setDomains([...rows].sort(byDomain));
    } catch (error) {
      if (!signal.cancelled) setLoadError(error instanceof Error ? error.message : 'Could not load domains');
    } finally {
      if (!signal.cancelled) setLoading(false);
    }
  }, [client, projectId]);

  // Fetch when the panel opens, on realtime email changes, and on retry.
  useEffect(() => {
    if (!isOpen || !projectId) return;
    const signal = { cancelled: false };
    void load(signal);
    return () => { signal.cancelled = true; };
  }, [isOpen, projectId, emailsRefreshSignal, reloadKey, load]);

  // A fresh panel starts with an empty add field.
  useEffect(() => {
    if (isOpen) return;
    setDraft('');
    setAddError(undefined);
  }, [isOpen]);

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (adding) return;
    const result = validateClientDomain(draft);
    if (!result.ok) {
      setAddError(result.error);
      return;
    }
    setAdding(true);
    setAddError(undefined);
    try {
      const row = await client.addDomain(projectId, result.domain);
      setDomains(prev => [...prev.filter(d => d.id !== row.id), row].sort(byDomain));
      setDraft('');
      toast('success', `Added ${row.domain}`);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Could not add the domain');
    } finally {
      setAdding(false);
    }
  };

  const executeRemove = async () => {
    const target = removeTarget;
    if (!target) return;
    try {
      await client.removeDomain(projectId, target.id);
      setDomains(prev => prev.filter(d => d.id !== target.id));
      toast('success', `Removed ${target.domain}`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not remove the domain');
    }
  };

  return (
    <section aria-labelledby={`${inputId}-heading`} className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
          <h3 id={`${inputId}-heading`} className="text-sm font-medium text-white">Client email domains</h3>
          {loading && (
            <Loader2 size={14} className="text-zinc-500 animate-spin motion-reduce:animate-none" aria-label="Loading domains" role="status" />
          )}
        </div>
        <p className="text-xs text-zinc-400">
          Mail from any address at these domains maps to this project. Public email services like gmail.com can&apos;t be added; add the person as a contact instead.
        </p>
      </div>

      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2">
          <p className="text-xs text-red-400">{loadError}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReloadKey(key => key + 1)}>
            Retry
          </Button>
        </div>
      ) : domains.length > 0 ? (
        <ul className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-lg">
          {domains.map(domain => (
            <li key={domain.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="font-mono text-sm text-zinc-300 truncate">@{domain.domain}</span>
              {canManage && (
                <button
                  type="button"
                  onClick={() => setRemoveTarget(domain)}
                  aria-label={`Remove ${domain.domain}`}
                  className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/15 transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : !loading ? (
        <p className="text-xs text-zinc-500">No client domains yet</p>
      ) : null}

      {canManage && (
        <form onSubmit={handleAdd} noValidate className="space-y-1.5">
          <label htmlFor={inputId} className={fieldLabelClass()}>Add a domain</label>
          <div className="flex items-start gap-2">
            <TextInput
              id={inputId}
              value={draft}
              onChange={(value) => {
                setDraft(value);
                if (addError) setAddError(undefined);
              }}
              placeholder="acme.com"
              prefix="@"
              autoComplete="off"
              spellCheck={false}
              error={addError}
              disabled={adding}
              className="flex-1 min-w-0"
            />
            <Button type="submit" disabled={adding || !draft.trim()} className="flex-shrink-0">
              {adding ? 'Adding...' : 'Add'}
            </Button>
          </div>
        </form>
      )}

      {/* Portaled: the Modal panel is transformed, which would trap a fixed overlay inside it. */}
      {canManage && typeof document !== 'undefined' && createPortal(
        <ConfirmDialog
          isOpen={!!removeTarget}
          onClose={() => setRemoveTarget(null)}
          onConfirm={executeRemove}
          title="Remove domain"
          message={`Mail from ${removeTarget?.domain ?? 'this domain'} will no longer map to this project.`}
          confirmLabel="Remove"
          variant="danger"
          doubleConfirm={false}
        />,
        document.body,
      )}
    </section>
  );
}
