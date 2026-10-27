'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Pencil, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { HOSTNAME_PATTERN } from '@/components/settings/email/InboxForm';
import type { MxStatus } from '@/lib/communications/inbox-types';

/**
 * The once-only setup behind every inbox: the relay domain new routing
 * addresses take, and whether each domain's MX record points mail at the
 * app. Shown folded under Setup on Settings > Email > Who handles your mail.
 */

const ICON_BUTTON =
  'p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

export type MxCheck =
  | { state: 'checking' }
  | { state: 'done'; result: MxStatus }
  | { state: 'failed'; message: string };

export function RelayDomainRow({
  relay,
  onSave,
}: {
  relay: string;
  onSave: (domain: string) => Promise<boolean>;
}) {
  const [editingRelay, setEditingRelay] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const start = () => {
    setDraft(relay);
    setError(undefined);
    setEditingRelay(true);
  };

  const save = async () => {
    const domain = draft.trim().toLowerCase();
    if (!HOSTNAME_PATTERN.test(domain)) {
      setError('Enter a domain such as relay.yourdomain.com');
      return;
    }
    setSaving(true);
    const ok = await onSave(domain);
    setSaving(false);
    if (ok) setEditingRelay(false);
  };

  return (
    <div className="mb-4 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg">
      {editingRelay ? (
        <div className="space-y-3">
          <TextInput
            label="Relay domain"
            value={draft}
            onChange={(value) => {
              setDraft(value);
              setError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditingRelay(false);
            }}
            placeholder="relay.yourdomain.com"
            error={error}
            size="sm"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditingRelay(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Relay domain</p>
            <p className="text-sm font-mono text-zinc-300 truncate mt-0.5">
              {relay || <span className="font-sans text-zinc-400">Not set</span>}
            </p>
          </div>
          <Tooltip content="Edit relay domain">
            <button
              type="button"
              onClick={start}
              aria-label="Edit relay domain"
              className={ICON_BUTTON}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      )}
      <p className="text-xs text-zinc-400 mt-2">
        New inboxes get a relay address{' '}
        <span className="font-mono text-zinc-300">
          &lt;name&gt;@{relay || '<domain>'}
        </span>
        . Existing inboxes keep their own.
      </p>
    </div>
  );
}

export function MxStatusBlock({
  domains,
  checks,
  onRefresh,
}: {
  domains: string[];
  checks: Record<string, MxCheck>;
  onRefresh: () => void;
}) {
  const anyChecking = domains.some((domain) => checks[domain]?.state === 'checking');

  return (
    <div className="mb-6 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-sm font-medium text-white">MX records</p>
        <Tooltip content="Check MX records again">
          <button
            type="button"
            onClick={onRefresh}
            disabled={anyChecking}
            aria-label="Check MX records again"
            className={`${ICON_BUTTON} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <ul className="space-y-3" aria-live="polite">
        {domains.map((domain) => (
          <MxLine key={domain} domain={domain} check={checks[domain]} />
        ))}
      </ul>
    </div>
  );
}

function MxLine({ domain, check }: { domain: string; check: MxCheck | undefined }) {
  const label = (
    <>
      MX record for <span className="font-mono">{domain}</span>:
    </>
  );

  if (!check || check.state === 'checking') {
    return (
      <li className="flex items-center gap-2 text-sm text-zinc-300">
        <Loader2 className="animate-spin motion-reduce:animate-none text-zinc-400 flex-shrink-0" size={14} aria-hidden="true" />
        <span className="min-w-0 break-all">
          {label} <span className="text-zinc-400">Checking...</span>
        </span>
      </li>
    );
  }

  if (check.state === 'failed' || check.result.error) {
    const failure = check.state === 'failed' ? check.message : check.result.error;
    return (
      <li className="flex items-start gap-2 text-sm text-zinc-300">
        <AlertTriangle className="text-red-300 flex-shrink-0 mt-0.5" size={14} aria-hidden="true" />
        <span className="min-w-0 break-all">
          {label} <span className="text-red-300">Could not check. {failure}</span>
        </span>
      </li>
    );
  }

  const { result } = check;
  const records = [...result.records].sort((a, b) => a.priority - b.priority);

  return (
    <li className="text-sm text-zinc-300">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            result.found ? 'bg-emerald-500' : 'bg-red-400'
          }`}
        />
        <span className="min-w-0 break-all">
          {label}{' '}
          <span className={result.found ? 'text-emerald-300' : 'text-red-300'}>
            {result.found ? 'Found' : 'Missing'}
          </span>
        </span>
      </div>
      {result.found ? (
        records.length > 0 && (
          <ul className="mt-1 ml-[18px] space-y-0.5">
            {records.map((record) => (
              <li
                key={`${record.priority}-${record.exchange}`}
                className="text-xs font-mono text-zinc-400 break-all"
              >
                {record.priority} {record.exchange}
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="mt-1 ml-[18px] text-xs text-zinc-400">
          Add an MX record for this domain at your DNS provider so mail can arrive.
        </p>
      )}
    </li>
  );
}
