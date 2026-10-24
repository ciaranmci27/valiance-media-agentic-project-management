'use client';

import { useMemo, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import { domainOf, organizationalDomain } from '@/lib/inbound-email/addresses';
import { isPublicEmailDomain } from '@/lib/inbound-email/public-domains';
import { TOPIC_PLURALS } from '@/lib/inbound-email/sender-rules';
import type { InboxMessage } from '@/lib/inbound-email/inbox-types';

type Action = 'ignore' | 'fyi' | 'always';

const ACTIONS: { value: Action; label: string; description: string }[] = [
  { value: 'ignore', label: 'Filter it', description: 'Goes straight to Filtered. Nobody reads it.' },
  { value: 'fyi', label: 'FYI only', description: 'The agent reads it and mentions it, but never flags you.' },
  { value: 'always', label: 'Always triage', description: 'The agent reads it fully, even when it looks like noise.' },
];

/**
 * A sender rule from an email: this address or its whole domain, all its
 * mail or only this topic, and what to do with it. Filtering can also clear
 * this thread's open mail from the sender now.
 */
export function SenderRuleDialog({ isOpen, onClose, threadId, message, agentName, onSaved }: {
  isOpen: boolean;
  onClose: () => void;
  threadId: string;
  message: InboxMessage;
  agentName: string;
  onSaved: () => Promise<void> | void;
}) {
  const { isDemoMode } = useDemo();
  const sender = (message.original_sender ?? message.from)?.address ?? '';
  const domain = sender ? organizationalDomain(domainOf(sender)) : '';
  const domainAllowed = !!domain && !isPublicEmailDomain(domain);
  const topic = message.sorting?.topic ?? null;
  const [scope, setScope] = useState<'address' | 'domain'>('address');
  const [topicOnly, setTopicOnly] = useState<'topic' | 'all'>(topic ? 'topic' : 'all');
  const [action, setAction] = useState<Action>('ignore');
  const [filterNow, setFilterNow] = useState(true);
  const [saving, setSaving] = useState(false);

  const actions = useMemo(() => ACTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description.replace('The agent', agentName),
  })), [agentName]);

  const save = async () => {
    if (!sender) return;
    setSaving(true);
    try {
      const result = await inboxClient(isDemoMode).createSenderRule({
        match_kind: scope,
        match_value: scope === 'address' ? sender : domain,
        topic: topic && topicOnly === 'topic' ? topic : null,
        action,
        thread_id: action === 'ignore' && filterNow ? threadId : null,
      });
      toast('success', result.filtered > 0 ? `Rule saved. ${result.filtered} open ${result.filtered === 1 ? 'email' : 'emails'} filtered.` : 'Rule saved. It applies to mail from now on.');
      await onSaved();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not save the rule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Filter mail like this" size="lg">
      <div className="space-y-5">
        <p className="sr-only">Choose which mail from this sender the rule covers and what happens to it.</p>
        <RadioGroup
          label="From"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'address', label: sender || 'This sender', description: 'Only this address.' },
            {
              value: 'domain',
              label: domain ? `Anyone at ${domain}` : 'Their domain',
              description: domainAllowed ? 'Every address at this domain, and its subdomains.' : `${domain || 'This'} is a public email service, so only the exact address can have a rule.`,
              disabled: !domainAllowed,
            },
          ]}
        />
        {topic && (
          <RadioGroup
            label="Which mail"
            value={topicOnly}
            onChange={setTopicOnly}
            options={[
              { value: 'topic', label: TOPIC_PLURALS[topic], description: 'Only mail about this, like this email.' },
              { value: 'all', label: 'All of it', description: 'Everything this sender sends, whatever it is about.' },
            ]}
          />
        )}
        <RadioGroup label="What happens" value={action} onChange={setAction} options={actions} />
        {action === 'ignore' && (
          <Checkbox checked={filterNow} onChange={setFilterNow} label="Filter this thread's open mail from them now" />
        )}
        <div className="flex justify-end gap-2 border-t border-white/[0.08] pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !sender}>{saving ? 'Saving...' : 'Save rule'}</Button>
        </div>
      </div>
    </Modal>
  );
}
