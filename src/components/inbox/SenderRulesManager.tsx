'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, Loader2, User } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { Select } from '@/components/ui/inputs/Select';
import { Toggle } from '@/components/ui/Toggle';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { inboxClient } from '@/lib/communications/inbox-client';
import type { InboxSenderRule } from '@/lib/communications/inbox-rules';

const ACTION_OPTIONS = [
  { value: 'ignore', label: 'Filter' },
  { value: 'fyi', label: 'FYI only' },
  { value: 'always', label: 'Always triage' },
];

type RuleChange = { action?: 'ignore' | 'fyi' | 'always'; enabled?: boolean };

/**
 * The sender rules and the changes the list makes to them, loaded while
 * `active` (an open modal, a mounted page). Each rule saves on its own, so a
 * quick change to one never waits for, or undoes, a change to another.
 */
export function useSenderRules(active: boolean, onChanged: () => void) {
  const { isDemoMode } = useDemo();
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const [rules, setRules] = useState<InboxSenderRule[] | null>(null);
  /** Why the list could not load; the list shows it with Retry. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Rules with a change in flight: one change per rule at a time. */
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const savingRef = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      setRules((await client.senderRules()).rules);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : 'Could not load the rules');
    }
  }, [client]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const change = async (rule: InboxSenderRule, request: RuleChange) => {
    if (savingRef.current.has(rule.id)) return;
    savingRef.current.add(rule.id);
    setSaving(new Set(savingRef.current));
    try {
      const { rule: updated } = await client.updateSenderRule(rule.id, request);
      setRules((current) => current?.map((row) => (row.id === updated.id ? updated : row)) ?? current);
      onChanged();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not change the rule');
    } finally {
      savingRef.current.delete(rule.id);
      setSaving(new Set(savingRef.current));
    }
  };

  return { rules, loadError, saving, change, reload: load };
}

/**
 * Every sender rule in one list: what it covers, what it does (changeable),
 * who made it and why, how many emails it sorted, and a switch. Rules are
 * switched off, never deleted.
 */
export function SenderRulesList({
  rules,
  loadError = null,
  onRetry,
  saving,
  onChange,
  className = '',
  scrollLabel,
}: {
  rules: InboxSenderRule[] | null;
  /** The list could not load: shown with Retry instead of an empty list. */
  loadError?: string | null;
  onRetry?: () => Promise<void> | void;
  /** Rules with a change in flight. */
  saving: ReadonlySet<string>;
  onChange: (rule: InboxSenderRule, request: RuleChange) => void;
  /** Extra classes on the list, such as a max height. */
  className?: string;
  /** With a max height the list scrolls: it then takes focus for the keyboard, named by this. */
  scrollLabel?: string;
}) {
  if (loadError && rules === null) return <RulesLoadError message={loadError} onRetry={onRetry} />;
  if (rules === null) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-zinc-400" role="status">
        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Loading rules
      </p>
    );
  }
  // A refresh that failed after the list loaded keeps the list, under the error.
  const refreshError = loadError ? <div className="mb-3"><RulesLoadError message={loadError} onRetry={onRetry} /></div> : null;
  if (rules.length === 0) return <>{refreshError}<p className="py-8 text-center text-sm text-zinc-400">No rules yet.</p></>;

  return (
    <>
      {refreshError}
      <ul
        className={`divide-y divide-white/[0.06] rounded-xl border border-white/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${className}`}
        {...(scrollLabel ? { tabIndex: 0, 'aria-label': scrollLabel } : {})}
      >
        {rules.map((rule) => {
          const off = !!rule.disabled_at;
          // While a rule saves its controls keep focus but take no input.
          const busy = saving.has(rule.id);
          const Source = rule.source === 'agent' ? Bot : User;
          return (
            <li key={rule.id} className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${off ? 'opacity-60' : ''}`}>
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-sm font-medium text-white">{rule.label}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-zinc-400">
                  <Tooltip content={rule.reason || (rule.source === 'agent' ? 'Made by the agent' : 'Made by a person')} disabled={!rule.reason}>
                    <span className="inline-flex items-center gap-1">
                      <Source size={11} aria-hidden="true" />
                      {rule.created_by_name ?? (rule.source === 'agent' ? 'Agent' : 'Someone')}
                    </span>
                  </Tooltip>
                  <span aria-hidden="true">·</span>
                  <span>{rule.hit_count} {rule.hit_count === 1 ? 'email' : 'emails'} sorted</span>
                  {off && <><span aria-hidden="true">·</span><span>Off</span></>}
                  {busy && (
                    <Loader2 size={11} className="animate-spin motion-reduce:animate-none" role="status" aria-label={`Saving the rule for ${rule.label}`} />
                  )}
                </p>
                {rule.reason && <p className="sr-only">Why: {rule.reason}</p>}
              </div>
              <div className="w-36">
                <Select
                  ariaLabel={`What happens to ${rule.label}`}
                  value={rule.action}
                  onChange={(value) => onChange(rule, { action: value as 'ignore' | 'fyi' | 'always' })}
                  options={ACTION_OPTIONS}
                  size="sm"
                  disabled={off}
                  ariaDisabled={busy}
                />
              </div>
              <Toggle
                checked={!off}
                onChange={(checked) => {
                  if (!busy) onChange(rule, { enabled: checked });
                }}
                aria-disabled={busy || undefined}
                aria-label={`Rule for ${rule.label}`}
              />
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * The rules from the Inbox, in a modal. New rules come from a thread ("Filter
 * mail like this"), from Settings > Email > Mail rules, or from the agent
 * spotting a pattern.
 */
export function SenderRulesManager({ isOpen, onClose, onChanged }: { isOpen: boolean; onClose: () => void; onChanged: () => void }) {
  const { rules, loadError, saving, change, reload } = useSenderRules(isOpen, onChanged);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Mail rules" size="2xl">
      <p className="mb-4 text-sm text-zinc-300">
        What happens to mail from a sender as it arrives. Make one from any thread with Filter mail like this. Rules apply to new mail; switching one off keeps its history.
      </p>
      <SenderRulesList
        rules={rules}
        loadError={loadError}
        onRetry={reload}
        saving={saving}
        onChange={(rule, request) => void change(rule, request)}
      />
    </Modal>
  );
}

/** The rules could not load: say so, with Retry, rather than "No rules yet". */
function RulesLoadError({ message, onRetry }: { message: string; onRetry?: () => Promise<void> | void }) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
      <p className="flex min-w-0 items-start gap-2 text-sm text-red-300">
        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
        <span className="min-w-0">{message}</span>
      </p>
      {onRetry && (
        <Button size="sm" variant="secondary" className="flex-shrink-0" onClick={() => void retry()} aria-disabled={retrying || undefined}>
          {retrying ? 'Retrying...' : 'Retry'}
        </Button>
      )}
    </div>
  );
}
