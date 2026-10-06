'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Inbox,
  Plus,
  Pencil,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { toast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { CopyValueButton, EmailConnectChecklist, relativeTime } from '@/components/settings/EmailConnectChecklist';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { announceInboxChange, inboxSettingsClient } from '@/lib/inbound-email/inbox-client';
import {
  AGENT_READABLE_TYPES,
  type AgentReadableType,
  type InboxSettings,
  type InboxSettingsInput,
  type InboxSettingsList,
  type MxStatus,
} from '@/lib/inbound-email/inbox-types';
import type { TeamMember } from '@/lib/types';

/**
 * Settings for the read-only client email inboxes: the relay domain new
 * inboxes route through, its MX status, one row per inbox with its connect
 * checklist (forwarder, test email with the verification code, live status),
 * and an inline add/edit form. Inboxes are disabled, never deleted. Nothing
 * here sends email.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ICON_BUTTON =
  'p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

const TYPE_LABELS: Record<AgentReadableType, string> = {
  image: 'Images',
  pdf: 'PDFs',
  text: 'Text files',
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_PART_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const HOSTNAME_PATTERN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const LIMITS = {
  retention_days: { min: 1, max: 3650, label: 'Retention' },
  max_attachment_mb: { min: 1, max: 50, label: 'Max attachment size' },
  summary_interval_minutes: { min: 5, max: 1440, label: 'Summary interval' },
} as const;
type LimitField = keyof typeof LIMITS;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The local part the server uses when the routing local part is left empty. */
function defaultLocalPart(address: string): string {
  return address.split('@')[0].trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function unique<T>(ids: T[]): T[] {
  return [...new Set(ids)];
}

function readers(inbox: InboxSettings): number {
  return unique([
    ...inbox.access_member_ids,
    ...(inbox.handler_member_id ? [inbox.handler_member_id] : []),
  ]).length;
}

function domainsOf(data: InboxSettingsList): string[] {
  return unique(
    [data.relay_domain, ...data.inboxes.map((inbox) => inbox.routing_domain)].filter(Boolean),
  ).sort();
}

/** The full input for an inbox as saved, so a single-field change keeps the rest. */
function toInput(inbox: InboxSettings): InboxSettingsInput {
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
    access_member_ids: inbox.access_member_ids,
  };
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  address: string;
  routing_local_part: string;
  routing_domain: string;
  /** Empty string = no handler. */
  handler_member_id: string;
  enabled: boolean;
  retention_days: number | '';
  max_attachment_mb: number | '';
  summary_interval_minutes: number | '';
  agent_readable_types: AgentReadableType[];
  filter_auto_mail: boolean;
  access_member_ids: string[];
}

type FormErrors = Partial<
  Record<'name' | 'address' | 'routing_local_part' | 'routing_domain' | LimitField, string>
>;

const EMPTY_FORM: FormState = {
  name: '',
  address: '',
  routing_local_part: '',
  routing_domain: '',
  handler_member_id: '',
  enabled: true,
  retention_days: 90,
  max_attachment_mb: 25,
  summary_interval_minutes: 30,
  agent_readable_types: [...AGENT_READABLE_TYPES],
  filter_auto_mail: true,
  access_member_ids: [],
};

function formFromInbox(inbox: InboxSettings): FormState {
  return {
    name: inbox.name,
    address: inbox.address,
    routing_local_part: inbox.routing_local_part,
    routing_domain: inbox.routing_domain,
    handler_member_id: inbox.handler_member_id ?? '',
    enabled: inbox.enabled,
    retention_days: inbox.retention_days,
    max_attachment_mb: inbox.max_attachment_mb,
    summary_interval_minutes: inbox.summary_interval_minutes,
    agent_readable_types: [...inbox.agent_readable_types],
    filter_auto_mail: inbox.filter_auto_mail,
    access_member_ids: [...inbox.access_member_ids],
  };
}

function effectiveRouting(form: FormState, relay: string) {
  return {
    local: form.routing_local_part.trim().toLowerCase() || defaultLocalPart(form.address),
    domain: form.routing_domain.trim().toLowerCase() || relay,
  };
}

function validate(form: FormState, relay: string): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = 'Enter a name';
  if (!EMAIL_PATTERN.test(form.address.trim())) {
    errors.address = 'Enter a valid email address, such as ashley@yourdomain.com';
  }
  const { local, domain } = effectiveRouting(form, relay);
  if (!local) {
    if (!errors.address) errors.routing_local_part = 'Enter a routing local part';
  } else if (!LOCAL_PART_PATTERN.test(local)) {
    errors.routing_local_part = 'Use letters, numbers, dots, dashes or underscores';
  }
  if (!domain) errors.routing_domain = 'Enter a routing domain, or set the relay domain first';
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

function toRequest(form: FormState): InboxSettingsInput {
  const handler = form.handler_member_id || null;
  return {
    name: form.name.trim(),
    address: form.address.trim().toLowerCase(),
    routing_local_part: form.routing_local_part.trim().toLowerCase(),
    routing_domain: form.routing_domain.trim().toLowerCase(),
    handler_member_id: handler,
    enabled: form.enabled,
    retention_days: Number(form.retention_days),
    max_attachment_mb: Number(form.max_attachment_mb),
    agent_readable_types: AGENT_READABLE_TYPES.filter((type) =>
      form.agent_readable_types.includes(type),
    ),
    summary_interval_minutes: Number(form.summary_interval_minutes),
    filter_auto_mail: form.filter_auto_mail,
    // The handler can always read its inbox.
    access_member_ids: unique([...form.access_member_ids, ...(handler ? [handler] : [])]),
  };
}

// ─── MX state ─────────────────────────────────────────────────────────────────

type MxCheck =
  | { state: 'checking' }
  | { state: 'done'; result: MxStatus }
  | { state: 'failed'; message: string };

/** How often the list refreshes while an enabled inbox waits for its first email. */
const WAITING_POLL_MS = 20_000;

const isWaiting = (inbox: InboxSettings) => inbox.enabled && !inbox.verified_at && !inbox.last_received_at;

// ─── Section ──────────────────────────────────────────────────────────────────

export function EmailInboxesSection() {
  const { isDemoMode } = useDemo();
  const { team, emailsRefreshSignal } = useApp();
  const client = useMemo(() => inboxSettingsClient(isDemoMode), [isDemoMode]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  /** The list loaded at least once, so the relay domain and rows are real. */
  const [loaded, setLoaded] = useState(false);
  const [relay, setRelay] = useState('');
  const [inboxes, setInboxes] = useState<InboxSettings[]>([]);
  const [mx, setMx] = useState<Record<string, MxCheck>>({});
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<InboxSettings | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  // ─── Fetch ──────────────────────────────────────────────────────────────────

  const checkMx = useCallback(
    (domains: string[]) => {
      if (!domains.length) return;
      setMx((current) => {
        const next = { ...current };
        domains.forEach((domain) => {
          next[domain] = { state: 'checking' };
        });
        return next;
      });
      domains.forEach(async (domain) => {
        try {
          const result = await client.mx(domain);
          setMx((current) => ({ ...current, [domain]: { state: 'done', result } }));
        } catch (error) {
          setMx((current) => ({
            ...current,
            [domain]: { state: 'failed', message: errorMessage(error, 'Lookup failed') },
          }));
        }
      });
    },
    [client],
  );

  /** Quiet loads (refreshes) keep what is shown when they fail. */
  const load = useCallback(async (quiet = false): Promise<InboxSettingsList | null> => {
    try {
      const data = await client.list();
      setRelay(data.relay_domain);
      setInboxes(data.inboxes);
      setLoadError(null);
      setLoaded(true);
      return data;
    } catch (error) {
      if (!quiet) setLoadError(errorMessage(error, 'Could not load inboxes'));
      return null;
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await load();
      if (cancelled) return;
      setLoading(false);
      if (data) checkMx(domainsOf(data));
    })();
    return () => {
      cancelled = true;
    };
  }, [load, checkMx]);

  /** Reload, then look up only domains that have not been checked yet. */
  const reloadAndCheckNew = async () => {
    const data = await load();
    if (data) checkMx(domainsOf(data).filter((domain) => !mx[domain]));
  };

  const retryLoad = async () => {
    setRetrying(true);
    const data = await load();
    setRetrying(false);
    if (data) checkMx(domainsOf(data).filter((domain) => !mx[domain]));
  };

  // Live status: refresh quietly when email data changes (realtime), and
  // every WAITING_POLL_MS while an enabled inbox waits for its first email.
  const firstSignal = useRef(emailsRefreshSignal);
  useEffect(() => {
    if (firstSignal.current === emailsRefreshSignal) return;
    void load(true);
  }, [emailsRefreshSignal, load]);

  const anyWaiting = inboxes.some(isWaiting);
  useEffect(() => {
    if (!anyWaiting || loadError) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [anyWaiting, loadError, load]);

  const domains = useMemo(
    () => domainsOf({ relay_domain: relay, inboxes }),
    [relay, inboxes],
  );

  // ─── Team ───────────────────────────────────────────────────────────────────

  const memberName = useCallback(
    (id: string | null) => (id ? team.find((m) => m.id === id)?.name ?? 'Unknown member' : null),
    [team],
  );

  // ─── Relay domain ───────────────────────────────────────────────────────────

  const saveRelay = async (domain: string): Promise<boolean> => {
    try {
      const result = await client.setRelayDomain(domain);
      setRelay(result.relay_domain);
      toast('success', 'Relay domain saved');
      if (!mx[result.relay_domain]) checkMx([result.relay_domain]);
      return true;
    } catch (error) {
      toast('error', errorMessage(error, 'Could not save the relay domain'));
      return false;
    }
  };

  // ─── Form handlers ──────────────────────────────────────────────────────────

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setEditing(null);
    setShowForm(false);
  };

  const handleAdd = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setEditing(null);
    setShowForm(true);
  };

  const handleEdit = (inbox: InboxSettings) => {
    setForm(formFromInbox(inbox));
    setErrors({});
    setEditing(inbox);
    setShowForm(true);
  };

  const updateField = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field as keyof FormErrors];
      return next;
    });
  };

  const handleSave = async () => {
    const found = validate(form, relay);
    setErrors(found);
    if (Object.keys(found).length) {
      toast('error', 'Check the highlighted fields');
      return;
    }

    setSaving(true);
    try {
      const input = toRequest(form);
      if (editing) {
        await client.update(editing.id, input);
        toast('success', 'Inbox updated');
      } else {
        await client.create(input);
        toast('success', 'Inbox created');
      }
      announceInboxChange();
      resetForm();
      await reloadAndCheckNew();
    } catch (error) {
      toast('error', errorMessage(error, 'Could not save the inbox'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (inbox: InboxSettings) => {
    setTogglingId(inbox.id);
    try {
      const updated = await client.update(inbox.id, { ...toInput(inbox), enabled: !inbox.enabled });
      setInboxes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      announceInboxChange();
      toast('success', updated.enabled ? `${updated.name} enabled` : `${updated.name} disabled`);
    } catch (error) {
      toast('error', errorMessage(error, 'Could not update the inbox'));
    } finally {
      setTogglingId(null);
    }
  };

  // ─── Loading state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <section className="glass-card rounded-xl p-4 lg:p-6" aria-busy="true">
        <div className="flex items-center gap-3">
          <SectionIcon />
          <div>
            <h2 className="font-semibold text-white">Email inboxes</h2>
            <p className="text-sm text-zinc-400">Loading...</p>
          </div>
        </div>
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin text-zinc-500" size={24} aria-hidden="true" />
        </div>
      </section>
    );
  }

  // ─── Loaded ─────────────────────────────────────────────────────────────────

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <SectionIcon />
          <div className="min-w-0">
            <h2 className="font-semibold text-white">Email inboxes</h2>
            <p className="text-sm text-zinc-400 hidden sm:block">
              Client email your agents read and triage. Read only: nothing is ever sent from here.
            </p>
          </div>
        </div>
        {!showForm && loaded && (
          <Button size="sm" className="flex-shrink-0 whitespace-nowrap" onClick={handleAdd} icon={<Plus size={14} aria-hidden="true" />}>
            <span className="sm:hidden">Add</span>
            <span className="hidden sm:inline">Add inbox</span>
          </Button>
        )}
      </div>

      {loaded && <RelayDomainRow relay={relay} onSave={saveRelay} />}

      {loaded && domains.length > 0 && (
        <MxStatusBlock domains={domains} checks={mx} onRefresh={() => checkMx(domains)} />
      )}

      {showForm && (
        <InboxForm
          form={form}
          errors={errors}
          editing={editing}
          relay={relay}
          team={team}
          saving={saving}
          memberName={memberName}
          onChange={updateField}
          onSave={handleSave}
          onCancel={resetForm}
        />
      )}

      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
          <p className="flex items-start gap-2 text-sm text-red-300 min-w-0">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span className="min-w-0">{loadError}</span>
          </p>
          <Button size="sm" variant="secondary" className="flex-shrink-0" onClick={retryLoad} disabled={retrying}>
            {retrying ? 'Retrying...' : 'Retry'}
          </Button>
        </div>
      ) : inboxes.length > 0 ? (
        <>
          <ul className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
            {inboxes.map((inbox) => (
              <InboxRow
                key={inbox.id}
                inbox={inbox}
                handlerName={memberName(inbox.handler_member_id)}
                toggling={togglingId === inbox.id}
                onEdit={() => handleEdit(inbox)}
                onToggle={() => handleToggle(inbox)}
              />
            ))}
          </ul>
          <p className="text-xs text-zinc-500 mt-3">
            Inboxes are disabled, never deleted, so stored mail and its files stay intact until
            retention removes them.
          </p>
        </>
      ) : !showForm ? (
        <div className="text-center py-6 text-zinc-400">
          <Inbox className="mx-auto mb-2" size={24} aria-hidden="true" />
          <p className="text-sm">No inboxes yet</p>
          <p className="text-xs mt-1">Add one for each agent that reads client email</p>
        </div>
      ) : null}
    </section>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function SectionIcon() {
  return (
    <div className="p-2 bg-brand-500/15 rounded-lg flex-shrink-0">
      <Inbox className="text-brand-300" size={20} aria-hidden="true" />
    </div>
  );
}

function RelayDomainRow({
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
              {relay || <span className="font-sans text-zinc-500">Not set</span>}
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
      <p className="text-xs text-zinc-500 mt-2">
        New inboxes get{' '}
        <span className="font-mono text-zinc-400">
          &lt;local&gt;@{relay || '<domain>'}
        </span>
        . Existing inboxes keep their own domain.
      </p>
    </div>
  );
}

function MxStatusBlock({
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
        <p className="text-sm font-medium text-white">Mail routing</p>
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
        <Loader2 className="animate-spin text-zinc-500 flex-shrink-0" size={14} aria-hidden="true" />
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

function InboxRow({
  inbox,
  handlerName,
  toggling,
  onEdit,
  onToggle,
}: {
  inbox: InboxSettings;
  handlerName: string | null;
  toggling: boolean;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const count = readers(inbox);

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-white truncate">{inbox.name}</p>
            <Badge variant={inbox.enabled ? 'success' : 'default'}>
              {inbox.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>

          <p className="text-xs text-zinc-400 truncate">{inbox.address}</p>

          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs text-zinc-500 flex-shrink-0">Routing address</span>
            <code className="px-1.5 py-0.5 bg-white/[0.06] rounded text-xs font-mono text-zinc-300 truncate">
              {inbox.routing_address}
            </code>
            <CopyValueButton value={inbox.routing_address} label="Copy routing address" />
          </div>

          <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-zinc-500">
            <li>
              Handler: <span className="text-zinc-400">{handlerName ?? 'No handler'}</span>
            </li>
            <li>
              {count === 1 ? '1 person can read it' : `${count} people can read it`}
            </li>
            {inbox.project_address_count > 0 && (
              <li>
                {inbox.project_address_count === 1
                  ? '1 project address routes here'
                  : `${inbox.project_address_count} project addresses route here`}
              </li>
            )}
          </ul>

          {inbox.last_error && (
            <p className="flex items-start gap-1.5 text-xs text-red-300">
              <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
              <span className="min-w-0">
                <span className="sr-only">Last error: </span>
                {inbox.last_error}
                {inbox.last_error_at && (
                  <span className="text-zinc-400"> ({relativeTime(inbox.last_error_at)})</span>
                )}
              </span>
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Tooltip content="Edit inbox">
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${inbox.name}`}
              className="p-1.5 text-zinc-500 hover:text-brand-300 hover:bg-brand-500/15 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={inbox.enabled ? 'Disable inbox' : 'Enable inbox'}>
            <Toggle
              size="sm"
              checked={inbox.enabled}
              onChange={onToggle}
              disabled={toggling}
              aria-label={`Receive mail for ${inbox.name}`}
            />
          </Tooltip>
        </div>
      </div>

      <div className="mt-3">
        <EmailConnectChecklist
          routingAddress={inbox.routing_address}
          publicAddress={inbox.address}
          lastReceivedAt={inbox.last_received_at}
          verification={{ code: inbox.verification_code, verifiedAt: inbox.verified_at }}
          offNote={inbox.enabled ? null : 'Disabled. Mail sent here is dropped, not queued. Turn it on to receive again.'}
        />
      </div>
    </li>
  );
}

function InboxForm({
  form,
  errors,
  editing,
  relay,
  team,
  saving,
  memberName,
  onChange,
  onSave,
  onCancel,
}: {
  form: FormState;
  errors: FormErrors;
  editing: InboxSettings | null;
  relay: string;
  team: TeamMember[];
  saving: boolean;
  memberName: (id: string | null) => string | null;
  onChange: <K extends keyof FormState>(field: K, value: FormState[K]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { local, domain } = effectiveRouting(form, relay);
  const routingChanged =
    editing !== null && (local !== editing.routing_local_part || domain !== editing.routing_domain);

  const handlerOptions = useMemo<SelectOption[]>(() => {
    const agents = team.filter((m) => m.role === 'agent');
    const people = team.filter((m) => m.role !== 'agent');
    const byName = (a: TeamMember, b: TeamMember) => a.name.localeCompare(b.name);
    return [
      { value: '', label: 'No handler' },
      ...[...agents].sort(byName).map((m) => ({ value: m.id, label: m.name, group: 'Agents' })),
      ...[...people].sort(byName).map((m) => ({ value: m.id, label: m.name, group: 'People' })),
    ];
  }, [team]);

  const accessOptions = useMemo(
    () =>
      [...team]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => ({ value: m.id, label: m.role === 'agent' ? `${m.name} (agent)` : m.name })),
    [team],
  );

  const toggleType = (type: AgentReadableType, checked: boolean) => {
    onChange(
      'agent_readable_types',
      checked
        ? unique([...form.agent_readable_types, type])
        : form.agent_readable_types.filter((t) => t !== type),
    );
  };

  const handlerName = memberName(form.handler_member_id || null);

  return (
    <form
      className="mb-6 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg space-y-4 animate-slideDown"
      aria-label={editing ? `Edit ${editing.name}` : 'New inbox'}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h3 className="text-sm font-medium text-white">{editing ? 'Edit inbox' : 'New inbox'}</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TextInput
          label="Name"
          value={form.name}
          onChange={(value) => onChange('name', value)}
          placeholder="e.g. Ashley"
          error={errors.name}
          required
          autoFocus
        />
        <TextInput
          label="Public address"
          type="email"
          value={form.address}
          onChange={(value) => onChange('address', value)}
          placeholder="e.g. ashley@yourdomain.com"
          description="The address clients write to"
          error={errors.address}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextInput
            label="Routing local part"
            value={form.routing_local_part}
            onChange={(value) => onChange('routing_local_part', value)}
            placeholder={defaultLocalPart(form.address) || 'e.g. ashley'}
            description="Empty: from the address"
            error={errors.routing_local_part}
            autoComplete="off"
            spellCheck={false}
          />
          <TextInput
            label="Routing domain"
            value={form.routing_domain}
            onChange={(value) => onChange('routing_domain', value)}
            placeholder={relay || 'relay.yourdomain.com'}
            description="Empty: the relay domain"
            error={errors.routing_domain}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <p className="text-xs text-zinc-400" aria-live="polite">
          Routing address:{' '}
          <span className="font-mono text-zinc-300 break-all">
            {local || '<local>'}@{domain || '<domain>'}
          </span>
        </p>
        {routingChanged && (
          <p className="flex items-start gap-1.5 text-xs text-amber-300" role="status">
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            Changing the routing address clears verification. Update the forwarder, then send the
            verification email again.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label="Handler"
          value={form.handler_member_id}
          onChange={(value) => onChange('handler_member_id', value)}
          options={handlerOptions}
          placeholder="No handler"
          description="The agent that triages this inbox. It can always read it."
        />
        <div className="space-y-1.5">
          <MultiSelect
            label="People who can read it"
            options={accessOptions}
            value={form.access_member_ids}
            onChange={(value) => onChange('access_member_ids', value)}
            placeholder="Only the handler"
            searchable
          />
          {handlerName && (
            <p className="text-xs text-zinc-500">
              {handlerName} handles this inbox, so they can always read it and are added on save.
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <NumberInput
          label="Retention"
          value={form.retention_days}
          onChange={(value) => onChange('retention_days', value)}
          min={LIMITS.retention_days.min}
          max={LIMITS.retention_days.max}
          suffix="days"
          error={errors.retention_days}
          required
        />
        <NumberInput
          label="Max attachment size"
          value={form.max_attachment_mb}
          onChange={(value) => onChange('max_attachment_mb', value)}
          min={LIMITS.max_attachment_mb.min}
          max={LIMITS.max_attachment_mb.max}
          suffix="MB"
          error={errors.max_attachment_mb}
          required
        />
        <NumberInput
          label="Summary interval"
          value={form.summary_interval_minutes}
          onChange={(value) => onChange('summary_interval_minutes', value)}
          min={LIMITS.summary_interval_minutes.min}
          max={LIMITS.summary_interval_minutes.max}
          suffix="min"
          error={errors.summary_interval_minutes}
          required
        />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-zinc-300 mb-2">Agent can open</legend>
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Toggle
          label="Enabled"
          checked={form.enabled}
          onChange={(checked) => onChange('enabled', checked)}
        />
        <Toggle
          label="Filter auto-mail"
          checked={form.filter_auto_mail}
          onChange={(checked) => onChange('filter_auto_mail', checked)}
          description="Newsletters, out-of-office replies and bounces are kept but marked Ignored"
        />
      </div>

      <div className="flex gap-2 mt-5 pt-4 border-t border-white/[0.08]">
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
