'use client';

import { useId, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { DOMAIN_PATTERN, focusAfterPaint } from '@/components/settings/email/your-addresses';
import type { OwnDomain } from '@/lib/communications/inbox-types';

/**
 * Your domains, under the list of addresses: any address on one reads as
 * written to you, listed or not. Add one inline; removing one asks first.
 * Closing the form, or removing a domain, leaves focus on the next thing to
 * use: Add domain, or the next domain's remove button.
 */
export function YourDomains({
  domains,
  busy,
  onAdd,
  onRemove,
}: {
  domains: OwnDomain[];
  busy: ReadonlySet<string>;
  /** Resolves to null, or the reason it could not be added. */
  onAdd: (domain: string) => Promise<string | null>;
  /** Resolves to true once it is removed. */
  onRemove: (domain: OwnDomain) => Promise<boolean>;
}) {
  const baseId = useId();
  const addButtonId = `${baseId}-add`;
  const removeButtonId = (id: string) => `${baseId}-remove-${id}`;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<OwnDomain | null>(null);

  const focusSoon = (id: string) => focusAfterPaint(() => document.getElementById(id), () => document.getElementById(addButtonId));

  const close = () => {
    setAdding(false);
    setDraft('');
    setError(undefined);
    focusSoon(addButtonId);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const domain = draft.trim().toLowerCase().replace(/^@/, '');
    if (!DOMAIN_PATTERN.test(domain)) {
      setError('Enter a domain such as yourdomain.com');
      return;
    }
    setSaving(true);
    const failure = await onAdd(domain);
    setSaving(false);
    if (failure) setError(failure);
    else close();
  };

  const remove = async (row: OwnDomain) => {
    const at = domains.findIndex((domain) => domain.id === row.id);
    const next = domains[at + 1] ?? domains[at - 1] ?? null;
    if (await onRemove(row)) focusSoon(next ? removeButtonId(next.id) : addButtonId);
  };

  return (
    <div className="mt-6 border-t border-white/[0.06] pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-sm font-medium text-white">Your domains</h3>
          <p className="mt-0.5 text-xs text-zinc-400">
            Any address on these domains reads as written to you, listed or not. Listed addresses still set the project and whose.
          </p>
        </div>
        {!adding && (
          <Button id={addButtonId} size="sm" variant="secondary" className="flex-shrink-0" onClick={() => setAdding(true)} icon={<Plus size={14} aria-hidden="true" />}>
            Add domain
          </Button>
        )}
      </div>

      {adding && (
        <form onSubmit={submit} noValidate aria-label="Add a domain" className="mt-3 flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <TextInput
              label="Domain"
              value={draft}
              onChange={(value) => {
                setDraft(value);
                setError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close();
              }}
              placeholder="yourdomain.com"
              error={error}
              size="sm"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex gap-2 sm:pt-6">
            <Button type="submit" size="sm" disabled={saving}>{saving ? 'Adding...' : 'Add'}</Button>
            <Button type="button" size="sm" variant="secondary" onClick={close}>Cancel</Button>
          </div>
        </form>
      )}

      {domains.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Your domains">
          {domains.map((row) => {
            const rowBusy = busy.has(row.id);
            return (
              <li key={row.id} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] py-1 pl-3 pr-1">
                <span className="min-w-0 break-words font-mono text-sm text-zinc-200">{row.domain}</span>
                <Tooltip content={rowBusy ? 'Removing' : 'Remove'}>
                  {/* While it is removed the button stays, so focus stays on it. */}
                  <button
                    type="button"
                    id={removeButtonId(row.id)}
                    onClick={() => {
                      if (!rowBusy) setRemoveTarget(row);
                    }}
                    aria-disabled={rowBusy || undefined}
                    aria-label={rowBusy ? `Removing ${row.domain}` : `Remove ${row.domain}`}
                    className="flex-shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-400"
                  >
                    {rowBusy
                      ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <X size={14} aria-hidden="true" />}
                  </button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      ) : !adding ? (
        <p className="mt-3 text-xs text-zinc-400">None yet. Only listed addresses read as yours.</p>
      ) : null}

      <ConfirmDialog
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) void remove(removeTarget);
        }}
        returnFocus={() => document.getElementById(addButtonId)}
        title={`Remove ${removeTarget?.domain ?? 'domain'}?`}
        message={`Addresses on ${removeTarget?.domain ?? 'it'} that aren't listed will stop reading as written to you, and may be suggested again for review. Listed addresses keep their project and whose.`}
        confirmLabel="Remove"
        variant="danger"
        doubleConfirm={false}
      />
    </div>
  );
}
