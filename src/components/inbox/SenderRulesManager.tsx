'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, User } from 'lucide-react';
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

/**
 * Every sender rule in one list: what it covers, what it does (changeable),
 * who made it and why, how many emails it sorted, and a switch. Rules are
 * switched off, never deleted. New rules come from a thread ("Filter mail
 * like this") or from the agent spotting a pattern.
 */
export function SenderRulesManager({ isOpen, onClose, onChanged }: { isOpen: boolean; onClose: () => void; onChanged: () => void }) {
  const { isDemoMode } = useDemo();
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const [rules, setRules] = useState<InboxSenderRule[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRules((await client.senderRules()).rules);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not load the rules');
      setRules([]);
    }
  }, [client]);
  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  const change = async (rule: InboxSenderRule, request: { action?: 'ignore' | 'fyi' | 'always'; enabled?: boolean }) => {
    setSaving(rule.id);
    try {
      const { rule: updated } = await client.updateSenderRule(rule.id, request);
      setRules((current) => current?.map((row) => (row.id === updated.id ? updated : row)) ?? current);
      onChanged();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not change the rule');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Sender rules" size="2xl">
      <p className="mb-4 text-sm text-zinc-300">
        What happens to mail from a sender as it arrives. Make one from any thread with Filter mail like this. Rules apply to new mail; switching one off keeps its history.
      </p>
      {rules === null ? (
        <p className="flex items-center gap-2 py-8 text-sm text-zinc-400" role="status">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Loading rules
        </p>
      ) : rules.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-400">No rules yet.</p>
      ) : (
        <ul className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.07]">
          {rules.map((rule) => {
            const off = !!rule.disabled_at;
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
                  </p>
                  {rule.reason && <p className="sr-only">Why: {rule.reason}</p>}
                </div>
                <div className="w-36">
                  <Select
                    ariaLabel={`What happens to ${rule.label}`}
                    value={rule.action}
                    onChange={(value) => void change(rule, { action: value as 'ignore' | 'fyi' | 'always' })}
                    options={ACTION_OPTIONS}
                    size="sm"
                    disabled={off || saving === rule.id}
                  />
                </div>
                <Toggle
                  checked={!off}
                  onChange={(checked) => void change(rule, { enabled: checked })}
                  disabled={saving === rule.id}
                  aria-label={`Rule for ${rule.label}`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
