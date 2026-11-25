'use client';

import { useState } from 'react';
import Link from 'next/link';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { StepFooter, StepPanel, Stepper, type FlowStep } from '@/components/ui/Stepper';
import { SecretOnce } from '@/components/agent/ConnectPanel';
import {
  firstWebhookProblem,
  hasInvoiceEvents,
  webhookEventGroups,
  webhookStepProblem,
  WEBHOOK_EVENT_LABELS,
  type WebhookDraft,
  type WebhookStep,
} from '@/lib/developers-settings';
import { WEBHOOK_SIGNATURE_HEADER } from '@/lib/webhooks/sign';
import {
  INVOICE_WEBHOOK_EVENT_TYPES,
  WORK_WEBHOOK_EVENT_TYPES,
  type WebhookAmountBasis,
  type WebhookEndpoint,
} from '@/lib/types';

// What an endpoint is sent for invoice.amount, each line amount and totals_by_type.
const AMOUNT_BASIS_OPTIONS: Array<{ value: WebhookAmountBasis; label: string; detail: string }> = [
  { value: 'gross', label: 'Gross', detail: 'What the client was billed' },
  { value: 'net', label: 'Net of splits', detail: 'What is left after revenue splits' },
];

const FORM_STEPS: readonly (FlowStep & { key: WebhookStep })[] = [
  { key: 'endpoint', label: 'Endpoint' },
  { key: 'events', label: 'Events' },
  { key: 'filters', label: 'Filters' },
];
const SECRET_STEP: FlowStep = { key: 'secret', label: 'Secret' };

/** Saves the draft: the new endpoint's signing secret on create, null after an edit. Throws to stay open. */
export type SaveEndpoint = (draft: WebhookDraft) => Promise<string | null>;

function draftFrom(endpoint: WebhookEndpoint | null, billingOn: boolean): WebhookDraft {
  if (!endpoint) {
    return {
      name: '',
      url: '',
      description: '',
      // A new endpoint starts on the full invoice lifecycle (a receiver that
      // reconciles needs un-pay, edit and delete too, not just invoice.paid),
      // or on every work event when there is no invoicing.
      events: billingOn ? [...INVOICE_WEBHOOK_EVENT_TYPES] : [...WORK_WEBHOOK_EVENT_TYPES],
      amountBasis: 'gross',
      projectIds: [],
      memberId: '',
      agentEventTypes: '',
    };
  }
  return {
    name: endpoint.name,
    url: endpoint.url,
    description: endpoint.description,
    events: [...endpoint.events],
    amountBasis: endpoint.amount_basis ?? 'gross',
    projectIds: endpoint.project_ids ?? [],
    memberId: endpoint.member_id ?? '',
    agentEventTypes: (endpoint.agent_event_types ?? []).join(', '),
  };
}

/**
 * New endpoint and Edit endpoint, one dialog: where to send, which events,
 * which filters, then (new only) the signing secret with how to verify it.
 * Editing opens with every step reachable and Save on each.
 */
export function WebhookEndpointDialog({ isOpen, editing, billingOn, projectOptions, memberOptions, onSave, onClose }: {
  isOpen: boolean;
  editing: WebhookEndpoint | null;
  billingOn: boolean;
  projectOptions: SelectOption[];
  memberOptions: SelectOption[];
  onSave: SaveEndpoint;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!busy) onClose(); }} title={editing ? `Edit ${editing.name}` : 'New webhook endpoint'} size="xl">
      {isOpen && (
        <EndpointFlow
          key={editing?.id ?? 'new'}
          editing={editing}
          billingOn={billingOn}
          projectOptions={projectOptions}
          memberOptions={memberOptions}
          onSave={onSave}
          onClose={onClose}
          onBusy={setBusy}
        />
      )}
    </Modal>
  );
}

function EndpointFlow({ editing, billingOn, projectOptions, memberOptions, onSave, onClose, onBusy }: {
  editing: WebhookEndpoint | null;
  billingOn: boolean;
  projectOptions: SelectOption[];
  memberOptions: SelectOption[];
  onSave: SaveEndpoint;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<WebhookDraft>(() => draftFrom(editing, billingOn));
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(editing ? FORM_STEPS.length - 1 : 0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const steps = editing ? FORM_STEPS : [...FORM_STEPS, SECRET_STEP];
  const last = FORM_STEPS.length - 1;
  const set = <K extends keyof WebhookDraft>(key: K, value: WebhookDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (error) setError(null);
  };

  const go = (index: number) => {
    setError(null);
    setStep(index);
    setReached((prev) => Math.max(prev, index));
  };

  const next = () => {
    const problem = webhookStepProblem(draft, FORM_STEPS[step].key);
    if (problem) return setError(problem);
    go(step + 1);
  };

  const save = async () => {
    const problem = firstWebhookProblem(draft);
    if (problem) {
      setStep(FORM_STEPS.findIndex((s) => s.key === problem.step));
      setError(problem.message);
      return;
    }
    setSaving(true);
    onBusy(true);
    setError(null);
    try {
      const made = await onSave(draft);
      if (made) {
        setSecret(made);
        setStep(FORM_STEPS.length);
        setReached(FORM_STEPS.length);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : editing ? 'Could not save the endpoint.' : 'Could not create the endpoint.');
    } finally {
      setSaving(false);
      onBusy(false);
    }
  };

  const toggleEvent = (event: string) =>
    set('events', draft.events.includes(event) ? draft.events.filter((e) => e !== event) : [...draft.events, event]);
  // A group's box turns all of its events on, or all off when they all are.
  const toggleGroup = (groupEvents: readonly string[]) => {
    const allOn = groupEvents.every((e) => draft.events.includes(e));
    set('events', allOn ? draft.events.filter((e) => !groupEvents.includes(e)) : [...new Set([...draft.events, ...groupEvents])]);
  };

  const footer = (
    <StepFooter
      onBack={step > 0 ? () => go(step - 1) : undefined}
      onNext={step === last ? () => { void save(); } : next}
      nextLabel={step === last ? (editing ? 'Save changes' : 'Create endpoint') : 'Next'}
      busy={saving}
      busyLabel={editing ? 'Saving' : 'Creating'}
      error={error}
      extra={editing && step < last ? (
        <Button variant="secondary" onClick={() => { void save(); }} disabled={saving}>Save changes</Button>
      ) : undefined}
    />
  );

  return (
    <div className="space-y-6">
      <Stepper
        steps={steps}
        current={step}
        reached={secret ? steps.length - 1 : reached}
        onJump={secret ? undefined : (index) => go(index)}
        label="Endpoint progress"
      />

      {step === 0 && (
        <StepPanel stepKey="hook-endpoint" title="Where should events go?" description="An HTTPS address in your system that accepts POST requests. Plain http works only for localhost.">
          <div className="space-y-4">
            <TextInput label="Name" value={draft.name} onChange={(v) => set('name', v)} placeholder="Personal finance" maxLength={100} required autoFocus />
            <TextInput label="Endpoint URL" type="url" value={draft.url} onChange={(v) => set('url', v)} placeholder="https://your-app.com/api/webhooks" required />
            <TextInput label="Description (optional)" value={draft.description} onChange={(v) => set('description', v)} placeholder="What this endpoint is for" />
          </div>
          {footer}
        </StepPanel>
      )}

      {step === 1 && (
        <StepPanel stepKey="hook-events" title="Which events?" description="Tick a group for all of its events, or pick single ones.">
          <div className="space-y-4">
            <div role="group" aria-label="Events" className="rounded-lg border border-white/[0.08] bg-surface-raised divide-y divide-white/[0.06]">
              {webhookEventGroups(billingOn).map((group) => {
                const on = group.events.filter((evt) => draft.events.includes(evt)).length;
                return (
                  <div key={group.id} className="divide-y divide-white/[0.06]">
                    <div className="bg-white/[0.02] px-3 py-2.5">
                      <Checkbox
                        size="sm"
                        checked={on === group.events.length}
                        indeterminate={on > 0 && on < group.events.length}
                        onChange={() => toggleGroup(group.events)}
                        label={group.label}
                        description={group.description}
                      />
                    </div>
                    {group.events.length > 1 && group.events.map((evt) => (
                      <div key={evt} className="py-2.5 pl-8 pr-3">
                        <Checkbox
                          size="sm"
                          checked={draft.events.includes(evt)}
                          onChange={() => toggleEvent(evt)}
                          label={WEBHOOK_EVENT_LABELS[evt]}
                          description={evt}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            {billingOn && hasInvoiceEvents(draft.events) && (
              <Select
                label="Invoice amounts"
                value={draft.amountBasis}
                onChange={(value) => set('amountBasis', value as WebhookAmountBasis)}
                options={AMOUNT_BASIS_OPTIONS}
                description="Net sends what is left after revenue splits. The split itself is never sent."
              />
            )}
            {!billingOn && hasInvoiceEvents(draft.events) && (
              <p className="text-xs text-zinc-400">Invoice events this endpoint already has wait while Client invoicing is off.</p>
            )}
          </div>
          {footer}
        </StepPanel>
      )}

      {step === 2 && (
        <StepPanel stepKey="hook-filters" title="Only some of them?" description="Leave these empty to send every chosen event.">
          <div className="space-y-4">
            <MultiSelect
              label="Projects"
              value={draft.projectIds}
              onChange={(v) => set('projectIds', v)}
              options={projectOptions}
              placeholder="Every project"
              description="Only events on these projects."
            />
            <Select
              label="Member"
              visibleLabel="Member"
              value={draft.memberId}
              onChange={(v) => set('memberId', v)}
              options={memberOptions}
              searchable
              description="Only events that concern this member: tasks assigned to or claimed by them, comments and reviews on those tasks, questions asked to or by them, and their suggestions. For an agent, this is its own work."
            />
            {draft.events.includes('agent_event.created') && (
              <TextInput
                label="Agent event types"
                value={draft.agentEventTypes}
                onChange={(v) => set('agentEventTypes', v)}
                placeholder="Every type"
                description="Only these types, comma-separated (work.done, usage.recorded, custom.acme.deploy). Pick an agent under Member to send only its events."
              />
            )}
          </div>
          {footer}
        </StepPanel>
      )}

      {secret && step === FORM_STEPS.length && (
        <StepPanel stepKey="hook-secret" title={`${draft.name.trim()} is ready`} description="Your receiver uses this secret to check each request really came from here.">
          <SecretOnce
            secret={{ secret }}
            heading="Copy the signing secret into your receiver now."
            what="Signing secret"
            copyLabel="Copy secret"
            hint={(
              <>
                Each request carries an <span className="font-mono">{WEBHOOK_SIGNATURE_HEADER}</span> header, <span className="font-mono">t=&lt;time&gt;,v1=&lt;signature&gt;</span>.
                Compute HMAC-SHA256 of <span className="font-mono">&lt;time&gt;.&lt;raw body&gt;</span> with this secret, compare it with v1, and refuse old times.
                You can reveal the secret again from the endpoint&apos;s row.{' '}
                <Link href="/webhooks/docs" className="font-medium underline underline-offset-2">Full guide</Link>
              </>
            )}
          />
          <div className="mt-6 flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </StepPanel>
      )}
    </div>
  );
}
