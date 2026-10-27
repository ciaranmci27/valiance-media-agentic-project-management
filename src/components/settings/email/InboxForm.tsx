'use client';

import { useId, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import {
  AGENT_READABLE_TYPES,
  type AgentReadableType,
  type InboxSettings,
  type InboxSettingsInput,
} from '@/lib/communications/inbox-types';
import type { TeamMember } from '@/lib/types';

/**
 * The add/edit form for an inbox (Settings > Email > Who handles your mail).
 * It leads with the plain questions in the order people answer them: who
 * handles the mail, what the inbox is called, its address, and who else can
 * read it. Everything technical sits under Advanced with working defaults.
 */

const TYPE_LABELS: Record<AgentReadableType, string> = {
  image: 'Images',
  pdf: 'PDFs',
  text: 'Text files',
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_PART_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
export const HOSTNAME_PATTERN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const LIMITS = {
  retention_days: { min: 1, max: 3650 },
  max_attachment_mb: { min: 1, max: 50 },
  summary_interval_minutes: { min: 5, max: 1440 },
} as const;
type LimitField = keyof typeof LIMITS;

/** Fields under Advanced: an error in one opens it. */
const ADVANCED_FIELDS = ['routing_local_part', 'routing_domain', 'retention_days', 'max_attachment_mb', 'summary_interval_minutes'] as const;

/** The relay name the server uses when it is left empty. */
function defaultLocalPart(address: string): string {
  return address.split('@')[0].trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

const byName = (a: TeamMember, b: TeamMember) => a.name.localeCompare(b.name);

function unique<T>(ids: T[]): T[] {
  return [...new Set(ids)];
}

/** The full input for an inbox as saved, so a single-field change keeps the rest. */
export function inboxInput(inbox: InboxSettings): InboxSettingsInput {
  return {
    name: inbox.name,
    address: inbox.address,
    routing_local_part: inbox.routing_local_part,
    routing_domain: inbox.routing_domain,
    handler_member_id: inbox.handler_member_id,
    enabled: inbox.enabled,
    retention_days: inbox.retention_days,
    max_attachment_mb: inbox.max_attachment_mb,
    agent_readable_types: inbox.agent_readable_types,
    summary_interval_minutes: inbox.summary_interval_minutes,
    filter_auto_mail: inbox.filter_auto_mail,
    triage_mode: inbox.triage_mode,
    access_member_ids: inbox.access_member_ids,
  };
}

export const TRIAGE_MODE_OPTIONS: SelectOption[] = [
  { value: 'legacy', label: 'Current triage' },
  { value: 'shadow', label: 'Current, with plans in shadow' },
  { value: 'plans', label: 'Plans' },
];

export type HandlerKind = 'agent' | 'person' | 'none';

export interface InboxFormState {
  /** Who handles it: an agent, a teammate, or nobody (people with access read it). */
  handler_kind: HandlerKind;
  /** Empty string = not chosen yet. */
  handler_member_id: string;
  name: string;
  address: string;
  routing_local_part: string;
  routing_domain: string;
  retention_days: number | '';
  max_attachment_mb: number | '';
  summary_interval_minutes: number | '';
  agent_readable_types: AgentReadableType[];
  filter_auto_mail: boolean;
  triage_mode: 'legacy' | 'shadow' | 'plans';
  access_member_ids: string[];
}

export type InboxFormErrors = Partial<
  Record<'handler_member_id' | 'name' | 'address' | 'routing_local_part' | 'routing_domain' | LimitField, string>
>;

/** A new inbox: an agent handles it when the team has one. */
export function emptyInboxForm(team: TeamMember[]): InboxFormState {
  const agents = team.filter((m) => m.role === 'agent' && m.status !== 'suspended');
  return {
    handler_kind: agents.length > 0 ? 'agent' : 'person',
    handler_member_id: agents.length === 1 ? agents[0].id : '',
    name: '',
    address: '',
    routing_local_part: '',
    routing_domain: '',
    retention_days: 90,
    max_attachment_mb: 25,
    summary_interval_minutes: 30,
    agent_readable_types: [...AGENT_READABLE_TYPES],
    filter_auto_mail: true,
    triage_mode: 'legacy',
    access_member_ids: [],
  };
}

export function formFromInbox(inbox: InboxSettings, team: TeamMember[]): InboxFormState {
  const handler = inbox.handler_member_id ? team.find((m) => m.id === inbox.handler_member_id) : null;
  return {
    handler_kind: !inbox.handler_member_id ? 'none' : handler?.role === 'agent' ? 'agent' : 'person',
    handler_member_id: inbox.handler_member_id ?? '',
    name: inbox.name,
    address: inbox.address,
    routing_local_part: inbox.routing_local_part,
    routing_domain: inbox.routing_domain,
    retention_days: inbox.retention_days,
    max_attachment_mb: inbox.max_attachment_mb,
    summary_interval_minutes: inbox.summary_interval_minutes,
    agent_readable_types: [...inbox.agent_readable_types],
    filter_auto_mail: inbox.filter_auto_mail,
    triage_mode: inbox.triage_mode,
    access_member_ids: [...inbox.access_member_ids],
  };
}

function effectiveRouting(form: InboxFormState, relay: string) {
  return {
    local: form.routing_local_part.trim().toLowerCase() || defaultLocalPart(form.address),
    domain: form.routing_domain.trim().toLowerCase() || relay,
  };
}

export function validateInboxForm(form: InboxFormState, relay: string): InboxFormErrors {
  const errors: InboxFormErrors = {};
  if (form.handler_kind !== 'none' && !form.handler_member_id) {
    errors.handler_member_id = form.handler_kind === 'agent' ? 'Choose the agent, or pick Nobody' : 'Choose the teammate, or pick Nobody';
  }
  if (!form.name.trim()) errors.name = 'Enter a name';
  if (!EMAIL_PATTERN.test(form.address.trim())) {
    errors.address = 'Enter the address in full, such as finance@yourdomain.com';
  }
  const { local, domain } = effectiveRouting(form, relay);
  if (!local) {
    if (!errors.address) errors.routing_local_part = 'Enter a relay name';
  } else if (!LOCAL_PART_PATTERN.test(local)) {
    errors.routing_local_part = 'Use letters, numbers, dots, dashes or underscores';
  }
  if (!domain) errors.routing_domain = 'Enter a relay domain, or set one under Setup first';
  else if (!HOSTNAME_PATTERN.test(domain)) {
    errors.routing_domain = 'Enter a domain such as relay.yourdomain.com';
  }
  (Object.keys(LIMITS) as LimitField[]).forEach((field) => {
    const { min, max } = LIMITS[field];
    const value = form[field];
    if (value === '' || !Number.isInteger(value) || value < min || value > max) {
      errors[field] = `Enter a whole number from ${min} to ${max}`;
    }
  });
  return errors;
}

/**
 * The request the form saves. The form has no on/off switch: `enabled` is
 * the inbox's switch as it is now (the card's), so saving never undoes it.
 */
export function inboxRequest(form: InboxFormState, enabled: boolean): InboxSettingsInput {
  const handler = form.handler_kind === 'none' ? null : form.handler_member_id || null;
  return {
    name: form.name.trim(),
    address: form.address.trim().toLowerCase(),
    routing_local_part: form.routing_local_part.trim().toLowerCase(),
    routing_domain: form.routing_domain.trim().toLowerCase(),
    handler_member_id: handler,
    enabled,
    retention_days: Number(form.retention_days),
    max_attachment_mb: Number(form.max_attachment_mb),
    agent_readable_types: AGENT_READABLE_TYPES.filter((type) => form.agent_readable_types.includes(type)),
    summary_interval_minutes: Number(form.summary_interval_minutes),
    filter_auto_mail: form.filter_auto_mail,
    triage_mode: form.triage_mode,
    // The handler can always read its inbox.
    access_member_ids: unique([...form.access_member_ids, ...(handler ? [handler] : [])]),
  };
}

/** What the handler does with the mail, in a sentence; the inbox card says the same. */
export function handlerSentence(handler: Pick<TeamMember, 'name' | 'role'> | null | undefined): string {
  if (!handler) return 'Nobody is assigned; people with access read it.';
  if (handler.role === 'agent') {
    return `${handler.name} reads the mail that reaches these addresses, files it on its project and turns requests into tasks.`;
  }
  return `${handler.name} reads the mail that reaches these addresses.`;
}

export function InboxForm({
  form,
  errors,
  editing,
  relay,
  team,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  form: InboxFormState;
  errors: InboxFormErrors;
  editing: InboxSettings | null;
  relay: string;
  team: TeamMember[];
  saving: boolean;
  onChange: <K extends keyof InboxFormState>(field: K, value: InboxFormState[K]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const advancedId = useId();
  const [advancedChoice, setAdvancedChoice] = useState(false);
  const advancedError = ADVANCED_FIELDS.some((field) => errors[field]);
  const advancedOpen = advancedChoice || advancedError;

  const { local, domain } = effectiveRouting(form, relay);
  const routingChanged = editing !== null && (local !== editing.routing_local_part || domain !== editing.routing_domain);

  const agents = useMemo(() => team.filter((m) => m.role === 'agent' && m.status !== 'suspended').sort(byName), [team]);
  const people = useMemo(() => team.filter((m) => m.role !== 'agent' && m.status !== 'suspended').sort(byName), [team]);
  const handler = form.handler_kind === 'none' ? null : team.find((m) => m.id === form.handler_member_id) ?? null;

  const handlerOptions = useMemo<SelectOption[]>(() => {
    const list = form.handler_kind === 'agent' ? agents : people;
    const options = list.map((m) => ({ value: m.id, label: m.name }));
    // A suspended handler an inbox already has stays shown.
    const current = team.find((m) => m.id === form.handler_member_id);
    if (current && !list.includes(current) && (current.role === 'agent') === (form.handler_kind === 'agent')) {
      options.push({ value: current.id, label: current.name });
    }
    return options;
  }, [form.handler_kind, form.handler_member_id, agents, people, team]);

  const accessOptions = useMemo(
    () =>
      [...team]
        .filter((m) => m.id !== (handler?.id ?? ''))
        .sort(byName)
        .map((m) => ({ value: m.id, label: m.role === 'agent' ? `${m.name} (agent)` : m.name })),
    [team, handler],
  );

  const chooseKind = (kind: HandlerKind) => {
    onChange('handler_kind', kind);
    const list = kind === 'agent' ? agents : kind === 'person' ? people : [];
    const keep = list.some((m) => m.id === form.handler_member_id);
    if (!keep) onChange('handler_member_id', kind === 'agent' && agents.length === 1 ? agents[0].id : '');
  };

  const chooseHandler = (id: string) => {
    onChange('handler_member_id', id);
    // A new inbox is named after its handler until it is given a name.
    const member = team.find((m) => m.id === id);
    if (member && !editing && !form.name.trim()) onChange('name', member.name);
  };

  const toggleType = (type: AgentReadableType, checked: boolean) => {
    onChange(
      'agent_readable_types',
      checked ? unique([...form.agent_readable_types, type]) : form.agent_readable_types.filter((t) => t !== type),
    );
  };

  return (
    <form
      className="mb-6 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg space-y-5 animate-slideDown"
      aria-label={editing ? `Edit ${editing.name}` : 'New inbox'}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h3 className="text-sm font-medium text-white">{editing ? `Edit ${editing.name}` : 'New inbox'}</h3>

      <div className="space-y-3">
        <RadioGroup<HandlerKind>
          label="Who handles this mail"
          value={form.handler_kind}
          onChange={chooseKind}
          orientation="horizontal"
          options={[
            { value: 'agent', label: 'An agent', disabled: agents.length === 0 && form.handler_kind !== 'agent' },
            { value: 'person', label: 'A teammate' },
            { value: 'none', label: 'Nobody' },
          ]}
        />
        {form.handler_kind !== 'none' && (
          <div className="max-w-sm">
            <Select
              label={form.handler_kind === 'agent' ? 'Which agent' : 'Which teammate'}
              visibleLabel={form.handler_kind === 'agent' ? 'Which agent' : 'Which teammate'}
              value={form.handler_member_id}
              onChange={chooseHandler}
              options={handlerOptions}
              placeholder={form.handler_kind === 'agent' ? 'Choose an agent' : 'Choose a teammate'}
              emptyText={form.handler_kind === 'agent' ? 'No agents on the team yet' : 'Nobody on the team yet'}
              searchable={handlerOptions.length > 8}
              error={errors.handler_member_id}
            />
          </div>
        )}
        <p className="text-xs text-zinc-400" aria-live="polite">
          {form.handler_kind === 'none' || handler ? handlerSentence(handler) : 'Choose who reads it.'}
          {form.handler_kind === 'agent' && agents.length === 0 && ' No agents on the team yet.'}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TextInput
          label="Name"
          value={form.name}
          onChange={(value) => onChange('name', value)}
          placeholder="e.g. Finance"
          description="Shown in the Inbox"
          error={errors.name}
          required
        />
        <TextInput
          label="Its address"
          type="email"
          value={form.address}
          onChange={(value) => onChange('address', value)}
          placeholder="e.g. finance@yourdomain.com"
          description="What people write to"
          error={errors.address}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>

      <div className="max-w-xl space-y-1.5">
        <MultiSelect
          label={handler ? 'Who else can read it' : 'Who can read it'}
          options={accessOptions}
          value={form.access_member_ids.filter((id) => id !== handler?.id)}
          onChange={(value) => onChange('access_member_ids', value)}
          placeholder={handler ? `Only ${handler.name}` : 'Nobody chosen'}
          searchable
        />
        {handler && <p className="text-xs text-zinc-400">{handler.name} handles it, so they can always read it.</p>}
      </div>

      <div className="border-t border-white/[0.08] pt-4">
        <button
          type="button"
          onClick={() => setAdvancedChoice(!advancedOpen)}
          aria-expanded={advancedOpen}
          aria-controls={advancedId}
          className="flex w-full items-center justify-between gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-white">Advanced</span>
            <span className="block text-xs text-zinc-400">Relay address, how long mail is kept, attachments and triage. The defaults work.</span>
          </span>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`flex-shrink-0 text-zinc-400 transition-transform motion-reduce:transition-none ${advancedOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {advancedOpen && (
          <div id={advancedId} className="mt-4 space-y-5">
            <div className="space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <TextInput
                  label="Relay name"
                  value={form.routing_local_part}
                  onChange={(value) => onChange('routing_local_part', value)}
                  placeholder={defaultLocalPart(form.address) || 'e.g. finance'}
                  description="Empty: the name of its address"
                  error={errors.routing_local_part}
                  autoComplete="off"
                  spellCheck={false}
                />
                <TextInput
                  label="Relay domain"
                  value={form.routing_domain}
                  onChange={(value) => onChange('routing_domain', value)}
                  placeholder={relay || 'relay.yourdomain.com'}
                  description="Empty: the relay domain under Setup"
                  error={errors.routing_domain}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <p className="text-xs text-zinc-400" aria-live="polite">
                Your mail host forwards its mail to{' '}
                <span className="font-mono text-zinc-200 break-all">
                  {local || '<name>'}@{domain || '<domain>'}
                </span>
              </p>
              {routingChanged && (
                <p className="flex items-start gap-1.5 text-xs text-amber-300" role="status">
                  <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                  Changing the relay address clears verification. Point the forwarder at the new one, then send the verification email again.
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <NumberInput
                label="Keep mail for"
                value={form.retention_days}
                onChange={(value) => onChange('retention_days', value)}
                min={LIMITS.retention_days.min}
                max={LIMITS.retention_days.max}
                suffix="days"
                error={errors.retention_days}
                required
              />
              <NumberInput
                label="Largest attachment"
                value={form.max_attachment_mb}
                onChange={(value) => onChange('max_attachment_mb', value)}
                min={LIMITS.max_attachment_mb.min}
                max={LIMITS.max_attachment_mb.max}
                suffix="MB"
                error={errors.max_attachment_mb}
                required
              />
              <NumberInput
                label="Summary every"
                value={form.summary_interval_minutes}
                onChange={(value) => onChange('summary_interval_minutes', value)}
                min={LIMITS.summary_interval_minutes.min}
                max={LIMITS.summary_interval_minutes.max}
                suffix="min"
                error={errors.summary_interval_minutes}
                required
              />
            </div>

            {form.handler_kind === 'agent' && (
              <fieldset>
                <legend className="text-sm font-medium text-zinc-300 mb-2">Files the agent may open</legend>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {AGENT_READABLE_TYPES.map((type) => (
                    <Checkbox
                      key={type}
                      label={TYPE_LABELS[type]}
                      checked={form.agent_readable_types.includes(type)}
                      onChange={(checked) => toggleType(type, checked)}
                    />
                  ))}
                </div>
              </fieldset>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Select
                label="Triage"
                visibleLabel="Triage"
                value={form.triage_mode}
                onChange={(value) => onChange('triage_mode', value as InboxFormState['triage_mode'])}
                options={TRIAGE_MODE_OPTIONS}
                description="Plans in shadow runs the new triage beside the current one, applying nothing, so the two can be compared."
              />
              <Toggle
                label="Filter automatic mail"
                checked={form.filter_auto_mail}
                onChange={(checked) => onChange('filter_auto_mail', checked)}
                description="Newsletters, out-of-office replies and bounces are kept but marked Filtered"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-4 border-t border-white/[0.08]">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving...' : editing ? 'Save changes' : 'Create inbox'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
