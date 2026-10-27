'use client';

import { useId, useMemo, useState } from 'react';
import { Filter, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { toast } from '@/components/ui/Toast';
import { SENDER_RULE_ACTIONS } from '@/components/inbox/SenderRuleDialog';
import { SenderRulesList, useSenderRules } from '@/components/inbox/SenderRulesManager';
import { useDemo } from '@/lib/demo-context';
import { announceInboxChange, inboxClient } from '@/lib/communications/inbox-client';
import { ruleTarget, TOPIC_PLURALS } from '@/lib/communications/sender-rules';
import { MAIL_TOPICS, type MailTopic, type RuleAction } from '@/lib/communications/sorting';

/**
 * Settings > Email > Mail rules: what happens to a sender's mail before the
 * handler sees it. The list changes what a rule does or switches it off
 * (never deleted); the form adds one for an address or a whole domain.
 */

const TOPIC_OPTIONS: SelectOption[] = [
  { value: '', label: 'All of it' },
  ...MAIL_TOPICS.map((topic) => ({ value: topic, label: TOPIC_PLURALS[topic] })),
];

interface RuleForm {
  sender: string;
  topic: '' | MailTopic;
  action: RuleAction;
  reason: string;
}

const EMPTY_RULE: RuleForm = { sender: '', topic: '', action: 'ignore', reason: '' };

/** In Settings the rule is about whoever handles the inbox, agent or person. */
const RULE_ACTIONS = SENDER_RULE_ACTIONS.map((option) => ({
  ...option,
  description: option.description.replace('The agent', 'The handler'),
}));

export function MailRulesSection() {
  const { isDemoMode } = useDemo();
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const { rules, loadError, saving, change, reload } = useSenderRules(true, () => announceInboxChange());
  const addButtonId = useId();

  const [form, setForm] = useState<RuleForm | null>(null);
  const [senderError, setSenderError] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);

  const update = <K extends keyof RuleForm>(field: K, value: RuleForm[K]) => {
    setForm((current) => (current ? { ...current, [field]: value } : current));
    if (field === 'sender') setSenderError(undefined);
  };

  /** Closes the form; focus goes back to Add rule, which shows again once it is gone. */
  const close = () => {
    setForm(null);
    setSenderError(undefined);
    requestAnimationFrame(() => document.getElementById(addButtonId)?.focus());
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form || adding) return;
    const kind = form.sender.includes('@') ? 'address' : 'domain';
    const target = ruleTarget(kind, form.sender);
    if (!target.ok) {
      setSenderError(target.error);
      return;
    }
    setAdding(true);
    try {
      await client.createSenderRule({
        match_kind: kind,
        match_value: target.value,
        topic: form.topic || null,
        action: form.action,
        reason: form.reason.trim(),
        thread_id: null,
      });
      toast('success', 'Rule saved. It applies to mail from now on.');
      announceInboxChange();
      close();
      // A rule for the same sender and topic was switched off and replaced.
      await reload();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save the rule');
    } finally {
      setAdding(false);
    }
  };

  return (
    <section id="mail-rules" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      <SettingsSectionHeader
        icon={Filter}
        title="Mail rules"
        description="What happens to a sender's mail as it arrives: filtered, FYI only or always triaged."
        action={!form && !isDemoMode ? (
          <Button id={addButtonId} size="sm" className="flex-shrink-0 whitespace-nowrap" onClick={() => setForm(EMPTY_RULE)} icon={<Plus size={14} aria-hidden="true" />}>
            <span className="sm:hidden">Add</span>
            <span className="hidden sm:inline">Add rule</span>
          </Button>
        ) : null}
      />

      {isDemoMode && (
        <p className="mb-4 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">
          Mail rules are off in demo mode.
        </p>
      )}

      {form && (
        <form
          onSubmit={save}
          noValidate
          aria-label="New mail rule"
          className="mb-6 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg space-y-4 animate-slideDown"
        >
          <h3 className="text-sm font-medium text-white">New rule</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextInput
              label="From"
              value={form.sender}
              onChange={(value) => update('sender', value)}
              placeholder="alerts@tool.com or tool.com"
              description="An address, or a domain for everyone there"
              error={senderError}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              required
            />
            <Select
              label="Which mail"
              visibleLabel="Which mail"
              value={form.topic}
              onChange={(value) => update('topic', value as RuleForm['topic'])}
              options={TOPIC_OPTIONS}
              description="All of it, or only mail about one thing"
            />
          </div>
          <RadioGroup
            label="What happens"
            value={form.action}
            onChange={(value) => update('action', value)}
            options={RULE_ACTIONS}
          />
          <TextInput
            label="Why (optional)"
            value={form.reason}
            onChange={(value) => update('reason', value)}
            placeholder="e.g. Weekly usage digest nobody reads"
            maxLength={500}
          />
          <div className="flex gap-2 pt-4 border-t border-white/[0.08]">
            <Button type="submit" disabled={adding}>{adding ? 'Saving...' : 'Save rule'}</Button>
            <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
          </div>
        </form>
      )}

      {!isDemoMode && (
        <>
          <SenderRulesList
            rules={rules}
            loadError={loadError}
            onRetry={reload}
            saving={saving}
            onChange={(rule, request) => void change(rule, request)}
            className="max-h-[32rem] overflow-y-auto"
            scrollLabel="Mail rules"
          />
          <p className="text-xs text-zinc-400 mt-3">
            Rules apply to new mail. Switching one off keeps its history. You can also make one from any email with Filter mail like this.
          </p>
        </>
      )}
    </section>
  );
}
