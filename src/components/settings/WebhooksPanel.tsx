'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { appLocale } from '@/lib/region';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { Select } from '@/components/ui/inputs/Select';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import Link from 'next/link';
import {
  Webhook,
  Plus,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  Eye,
  EyeOff,
  Send,
  BookOpen,
  Pencil,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { isModuleEnabled } from '@/lib/access-control';
import { generateWebhookSecret } from '@/lib/webhooks/sign';
import { webhookUrlError } from '@/lib/webhooks/endpoint-input';
import {
  fetchWebhookEndpoints,
  insertWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  fetchWebhookDeliveries,
  requeueWebhookDelivery,
} from '@/lib/supabase/queries';
import {
  INVOICE_WEBHOOK_EVENT_TYPES,
  WORK_WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookAmountBasis,
  type WebhookEndpoint,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from '@/lib/types';

const EVENT_LABELS: Record<string, string> = {
  'task.created': 'Task created',
  'task.updated': 'Task updated',
  'task.deleted': 'Task moved to Trash',
  'comment.created': 'Comment added',
  'question.asked': 'Question asked',
  'question.answered': 'Question answered',
  'question.cancelled': 'Question withdrawn',
  'suggestion.created': 'Suggestion made',
  'suggestion.decided': 'Suggestion decided',
  'review.submitted': 'Review submitted',
  'invoice.paid': 'Invoice paid',
  'invoice.updated': 'Invoice updated',
  'invoice.deleted': 'Invoice deleted',
  'invoice.payment_recorded': 'Payment recorded',
  'invoice.payment_removed': 'Payment removed',
};

// The event picker, in groups. Invoices show only while Client invoicing is on.
const EVENT_GROUPS: Array<{ label: string; events: readonly string[]; invoices?: boolean }> = [
  { label: 'Tasks', events: ['task.created', 'task.updated', 'task.deleted', 'comment.created'] },
  { label: 'Questions', events: ['question.asked', 'question.answered', 'question.cancelled'] },
  { label: 'Suggestions and reviews', events: ['suggestion.created', 'suggestion.decided', 'review.submitted'] },
  { label: 'Invoices', events: INVOICE_WEBHOOK_EVENT_TYPES, invoices: true },
];
const INVOICE_EVENTS: readonly string[] = INVOICE_WEBHOOK_EVENT_TYPES;
const EVERYONE = '';

// What an endpoint is sent for invoice.amount, each line amount and totals_by_type.
const AMOUNT_BASIS_OPTIONS: Array<{ value: WebhookAmountBasis; label: string; detail: string }> = [
  { value: 'gross', label: 'Gross', detail: 'What the client was billed' },
  { value: 'net', label: 'Net of splits', detail: 'What is left after revenue splits' },
];

const STATUS_STYLES: Record<WebhookDeliveryStatus, string> = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  delivering: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  succeeded: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  failed: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
};

// A pending delivery that has already been tried is waiting out its backoff.
function deliveryLabel(d: WebhookDelivery): string {
  return d.status === 'pending' && d.attempts > 0 ? 'retrying' : d.status;
}

function deliveryDetail(d: WebhookDelivery): string {
  if (d.status === 'succeeded') return `Delivered ${formatWhen(d.delivered_at)}`;
  if (d.status === 'delivering') return 'Sending now';
  if (d.status === 'failed') return d.last_error || 'Failed';
  if (d.attempts > 0) return `${d.last_error || 'Failed'}, next try ${formatWhen(d.next_attempt_at)}`;
  return 'Queued';
}

function formatWhen(value: string | null): string {
  if (!value) return 'not set';
  return new Date(value).toLocaleString(appLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WebhooksPanel({ teamMemberId }: { teamMemberId: string | null }) {
  const supabase = createClient();
  const { projects, team } = useApp();
  const { access } = useAuth();
  // Invoice events need Client invoicing; without it they are neither offered nor sent.
  const billingOn = isModuleEnabled(access, 'billing');

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);

  // A new endpoint starts on the full invoice lifecycle (a receiver that
  // reconciles needs un-pay, edit and delete too, not just invoice.paid), or
  // on every work event when there is no invoicing.
  const defaultEvents = () => (billingOn ? [...INVOICE_WEBHOOK_EVENT_TYPES] : [...WORK_WEBHOOK_EVENT_TYPES]);

  // Create and edit form (editing holds the endpoint being changed)
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>(defaultEvents);
  const [amountBasis, setAmountBasis] = useState<WebhookAmountBasis>('gross');
  // Filters: no projects means every project; EVERYONE means no member filter.
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [memberId, setMemberId] = useState<string>(EVERYONE);
  const [saving, setSaving] = useState(false);

  const projectOptions = projects
    .map((p) => ({ value: p.id, label: p.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const memberOptions = [
    { value: EVERYONE, label: 'Everyone' },
    ...team
      .filter((m) => m.status !== 'suspended' || m.id === memberId)
      .map((m) => ({ value: m.id, label: m.name, detail: m.title || (m.role === 'agent' ? 'Agent' : undefined) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Unknown project';
  const memberName = (id: string) => team.find((m) => m.id === id)?.name ?? 'Unknown member';
  const eventGroups = EVENT_GROUPS.filter((group) => !group.invoices || billingOn);

  // One-time secret reveal after creation
  const [newSecret, setNewSecret] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Per-endpoint secret visibility
  const [shownSecrets, setShownSecrets] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<WebhookEndpoint | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [eps, dels] = await Promise.all([
        fetchWebhookEndpoints(supabase),
        fetchWebhookDeliveries(supabase, 25),
      ]);
      setEndpoints(eps);
      setDeliveries(dels);
    } catch (e) {
      console.error('Failed to load webhooks', e);
      toast('error', 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleEvent(evt: string) {
    setEvents((prev) => (prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt]));
  }

  // A group's box turns all of its events on, or all off when they all are.
  function toggleGroup(groupEvents: readonly string[]) {
    setEvents((prev) => {
      const allOn = groupEvents.every((e) => prev.includes(e));
      return allOn ? prev.filter((e) => !groupEvents.includes(e)) : [...new Set([...prev, ...groupEvents])];
    });
  }

  function resetForm() {
    setName('');
    setUrl('');
    setDescription('');
    setEvents(defaultEvents());
    setAmountBasis('gross');
    setProjectIds([]);
    setMemberId(EVERYONE);
    setEditing(null);
    setShowForm(false);
  }

  function startEdit(endpoint: WebhookEndpoint) {
    setNewSecret(null);
    setEditing(endpoint);
    setName(endpoint.name);
    setUrl(endpoint.url);
    setDescription(endpoint.description);
    setEvents([...endpoint.events]);
    setAmountBasis(endpoint.amount_basis ?? 'gross');
    setProjectIds(endpoint.project_ids ?? []);
    setMemberId(endpoint.member_id ?? EVERYONE);
    setShowForm(true);
  }

  async function handleSave() {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) {
      toast('error', 'Name is required');
      return;
    }
    // HTTPS, except plain http on localhost for local development (the API's rule too).
    const urlError = webhookUrlError(trimmedUrl);
    if (urlError) {
      toast('error', urlError);
      return;
    }
    // Invoice events kept from when invoicing was on still count, though hidden.
    if (events.length === 0) {
      toast('error', 'Select at least one event');
      return;
    }
    const fields = {
      name: trimmedName,
      url: trimmedUrl,
      events,
      description: description.trim(),
      amount_basis: amountBasis,
      project_ids: projectIds.length > 0 ? projectIds : null,
      member_id: memberId || null,
    };

    setSaving(true);
    try {
      if (editing) {
        const updated = await updateWebhookEndpoint(supabase, editing.id, fields);
        setEndpoints((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
        toast('success', 'Webhook endpoint saved');
        resetForm();
        return;
      }
      const secret = generateWebhookSecret();
      const created = await insertWebhookEndpoint(supabase, { ...fields, secret, created_by: teamMemberId });
      setEndpoints((prev) => [created, ...prev]);
      setNewSecret({ name: created.name, secret });
      resetForm();
    } catch (e) {
      console.error('Failed to save webhook', e);
      toast('error', editing ? 'Failed to save webhook endpoint' : 'Failed to create webhook endpoint');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(endpoint: WebhookEndpoint) {
    const next = !endpoint.is_active;
    setEndpoints((prev) => prev.map((e) => (e.id === endpoint.id ? { ...e, is_active: next } : e)));
    try {
      await updateWebhookEndpoint(supabase, endpoint.id, { is_active: next });
    } catch (e) {
      console.error(e);
      setEndpoints((prev) =>
        prev.map((el) => (el.id === endpoint.id ? { ...el, is_active: endpoint.is_active } : el)),
      );
      toast('error', 'Failed to update endpoint');
    }
  }

  async function handleAmountBasis(endpoint: WebhookEndpoint, next: WebhookAmountBasis) {
    if (next === endpoint.amount_basis) return;
    setEndpoints((prev) => prev.map((e) => (e.id === endpoint.id ? { ...e, amount_basis: next } : e)));
    try {
      await updateWebhookEndpoint(supabase, endpoint.id, { amount_basis: next });
      toast('success', next === 'net' ? 'Sending amounts net of splits' : 'Sending gross amounts');
    } catch (e) {
      console.error(e);
      setEndpoints((prev) =>
        prev.map((el) => (el.id === endpoint.id ? { ...el, amount_basis: endpoint.amount_basis } : el)),
      );
      toast('error', 'Failed to update endpoint');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setEndpoints((prev) => prev.filter((e) => e.id !== target.id));
    try {
      await deleteWebhookEndpoint(supabase, target.id);
      toast('success', 'Webhook endpoint deleted');
    } catch (e) {
      console.error(e);
      toast('error', 'Failed to delete endpoint');
      load();
    }
  }

  async function handleCopySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }

  async function handleRunNow() {
    setRunning(true);
    try {
      const res = await fetch('/api/internal/webhooks/dispatch', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const summary = await res.json();
      const retrying = summary.retrying ? `, ${summary.retrying} will retry` : '';
      toast('success', `Delivered ${summary.delivered ?? 0}${retrying}`);
      await load();
    } catch (e) {
      console.error(e);
      toast('error', 'Failed to run dispatcher');
    } finally {
      setRunning(false);
    }
  }

  async function handleRetry(delivery: WebhookDelivery) {
    try {
      await requeueWebhookDelivery(supabase, delivery.id);
      await fetch('/api/internal/webhooks/dispatch', { method: 'POST' }).catch(() => {});
      await load();
    } catch (e) {
      console.error(e);
      toast('error', 'Failed to resend delivery');
    }
  }

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-violet-500/15 rounded-lg">
            <Webhook className="text-violet-400" size={20} aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-semibold text-white">Webhooks</h2>
            <p className="text-sm text-zinc-400 hidden sm:block">
              Send signed events to agents and other systems when work or invoices change.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/webhooks/docs">
            <Button size="sm" variant="secondary" icon={<BookOpen size={14} />}>
              Docs
            </Button>
          </Link>
          {!showForm && !newSecret && (
            <Button size="sm" onClick={() => { resetForm(); setShowForm(true); }} icon={<Plus size={14} />}>
              <span className="sm:hidden">New</span>
              <span className="hidden sm:inline">New endpoint</span>
            </Button>
          )}
        </div>
      </div>

      {/* One-time secret reveal */}
      {newSecret && (
        <div className="mb-6 p-4 bg-emerald-500/15 border border-emerald-500/30 rounded-lg space-y-3">
          <div className="flex items-center gap-2">
            <Check size={16} className="text-emerald-400" aria-hidden="true" />
            <p className="text-sm font-medium text-emerald-300">
              Endpoint “{newSecret.name}” created
            </p>
          </div>
          <p className="text-xs text-emerald-300">
            Copy this signing secret into your receiver now (it verifies each request). You can
            reveal it again below at any time.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-surface-raised border border-emerald-500/30 rounded-lg text-sm font-mono text-zinc-100 break-all select-all">
              {newSecret.secret}
            </code>
            <button
              onClick={() => handleCopySecret(newSecret.secret)}
              aria-label="Copy signing secret"
              className="p-2 text-emerald-400 hover:bg-emerald-500/15 rounded-lg transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setNewSecret(null)}>
            Done
          </Button>
        </div>
      )}

      {/* Create and edit form */}
      {showForm && (
        <div className="mb-6 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg space-y-3">
          <h4 className="text-sm font-medium text-white">{editing ? `Edit ${editing.name}` : 'New endpoint'}</h4>
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='e.g. "Personal Finance"'
          />
          <Input
            label="Endpoint URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-app.com/api/webhooks"
          />
          <Input
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this endpoint is for"
          />
          <MultiSelect
            label="Projects"
            value={projectIds}
            onChange={setProjectIds}
            options={projectOptions}
            placeholder="Every project"
            description="Only events on these projects. Leave empty for every project."
          />
          <Select
            label="Member"
            value={memberId}
            onChange={setMemberId}
            options={memberOptions}
            searchable
            description="Only events that concern this member: tasks assigned to or claimed by them, comments and reviews on those tasks, questions asked to or by them, and their suggestions. For an agent, this is its own work."
          />
          {billingOn && (
            <Select
              label="Amounts"
              value={amountBasis}
              onChange={(value) => setAmountBasis(value as WebhookAmountBasis)}
              options={AMOUNT_BASIS_OPTIONS}
              description="For invoice events. Net sends what is left after revenue splits. The split itself is never sent."
            />
          )}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Events</label>
            <div className="rounded-lg border border-white/[0.08] bg-surface-raised divide-y divide-white/[0.06]">
              {eventGroups.map((group) => {
                const on = group.events.filter((evt) => events.includes(evt)).length;
                return (
                  <div key={group.label} className="divide-y divide-white/[0.06]">
                    <div className="px-3 py-2.5 bg-white/[0.02]">
                      <Checkbox
                        size="sm"
                        checked={on === group.events.length}
                        indeterminate={on > 0 && on < group.events.length}
                        onChange={() => toggleGroup(group.events)}
                        label={group.label}
                      />
                    </div>
                    {group.events.map((evt) => (
                      <div key={evt} className="py-2.5 pl-8 pr-3">
                        <Checkbox
                          size="sm"
                          checked={events.includes(evt)}
                          onChange={() => toggleEvent(evt)}
                          label={EVENT_LABELS[evt]}
                          description={evt}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {editing ? (saving ? 'Saving…' : 'Save changes') : (saving ? 'Creating…' : 'Create endpoint')}
            </Button>
            <Button size="sm" variant="secondary" onClick={resetForm} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Endpoints list */}
      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : endpoints.length === 0 ? (
        <p className="text-sm text-zinc-400">
          No webhook endpoints yet. Create one to start relaying events.
        </p>
      ) : (
        <ul className="space-y-3">
          {endpoints.map((endpoint) => (
            <li
              key={endpoint.id}
              className="p-4 bg-white/[0.02] border border-white/[0.08] rounded-lg"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white truncate">{endpoint.name}</span>
                    {!endpoint.is_active && (
                      <span className="text-[11px] uppercase tracking-wide text-zinc-400 border border-white/[0.1] rounded px-1.5 py-0.5">
                        Paused
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-mono text-zinc-400 break-all mt-0.5">{endpoint.url}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {endpoint.events.map((evt) => (
                      <span
                        key={evt}
                        className="text-[11px] text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded px-1.5 py-0.5"
                      >
                        {EVENT_LABELS[evt] || evt}
                      </span>
                    ))}
                  </div>
                  {(endpoint.project_ids || endpoint.member_id) && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {endpoint.project_ids && (
                        <span className="text-[11px] text-zinc-400 border border-white/[0.1] rounded px-1.5 py-0.5">
                          Projects: {endpoint.project_ids.map(projectName).join(', ')}
                        </span>
                      )}
                      {endpoint.member_id && (
                        <span className="text-[11px] text-zinc-400 border border-white/[0.1] rounded px-1.5 py-0.5">
                          Concerns {memberName(endpoint.member_id)}
                        </span>
                      )}
                    </div>
                  )}
                  {!billingOn && endpoint.events.some((evt) => INVOICE_EVENTS.includes(evt)) && (
                    <p className="text-[11px] text-zinc-400 mt-2">
                      Invoice events wait while Client invoicing is off.
                    </p>
                  )}
                  <p className="text-[11px] text-zinc-400 mt-2">
                    Last delivery: {formatWhen(endpoint.last_delivery_at)}
                  </p>
                  {billingOn && endpoint.events.some((evt) => INVOICE_EVENTS.includes(evt)) && (
                    <Select
                      size="sm"
                      label="Amounts"
                      value={endpoint.amount_basis ?? 'gross'}
                      onChange={(value) => handleAmountBasis(endpoint, value as WebhookAmountBasis)}
                      options={AMOUNT_BASIS_OPTIONS}
                      className="mt-3 max-w-[15rem]"
                    />
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => startEdit(endpoint)}
                    aria-label="Edit endpoint"
                    title="Edit endpoint"
                    className="p-2 text-zinc-400 hover:text-brand-300 hover:bg-white/[0.06] rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={handleRunNow}
                    disabled={running}
                    aria-label="Send pending deliveries now"
                    title="Send pending deliveries now"
                    className="p-2 text-zinc-400 hover:text-brand-300 hover:bg-white/[0.06] rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
                  >
                    <Send size={15} />
                  </button>
                  <Toggle
                    checked={endpoint.is_active}
                    onChange={() => handleToggleActive(endpoint)}
                    aria-label={endpoint.is_active ? 'Pause endpoint' : 'Activate endpoint'}
                  />
                  <button
                    onClick={() => setDeleteTarget(endpoint)}
                    aria-label="Delete endpoint"
                    className="p-2 text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {/* Secret reveal */}
              <div className="flex items-center gap-2 mt-3">
                <code className="flex-1 px-2.5 py-1.5 bg-surface-raised border border-white/[0.08] rounded-md text-xs font-mono text-zinc-300 break-all select-all">
                  {shownSecrets[endpoint.id] ? endpoint.secret : '•'.repeat(24)}
                </code>
                <button
                  onClick={() =>
                    setShownSecrets((prev) => ({ ...prev, [endpoint.id]: !prev[endpoint.id] }))
                  }
                  aria-label={
                    shownSecrets[endpoint.id] ? 'Hide signing secret' : 'Reveal signing secret'
                  }
                  className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {shownSecrets[endpoint.id] ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button
                  onClick={() => handleCopySecret(endpoint.secret)}
                  aria-label="Copy signing secret"
                  className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <Copy size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Recent deliveries */}
      {!loading && deliveries.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-white">Recent deliveries</h4>
            <button
              onClick={load}
              aria-label="Refresh deliveries"
              className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
          {/* Rows keep their height; the list scrolls past about ten, with its column names pinned. */}
          <div
            role="region"
            tabIndex={0}
            aria-label="Recent deliveries"
            className="max-h-96 overflow-auto rounded-lg border border-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-[1] bg-surface-raised">
                <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-400 border-b border-white/[0.06]">
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Code</th>
                  <th className="px-3 py-2 font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">Detail</th>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium sr-only">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">
                      {d.webhook_events?.event_type || ';'}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`text-[11px] border rounded px-1.5 py-0.5 ${STATUS_STYLES[d.status]}`}
                      >
                        {deliveryLabel(d)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-zinc-400 font-mono">
                      {d.last_status_code ?? 'None'}
                    </td>
                    <td className="px-3 py-2 text-zinc-400 font-mono whitespace-nowrap">
                      {d.attempts}/{WEBHOOK_MAX_ATTEMPTS}
                    </td>
                    <td
                      className="px-3 py-2 text-zinc-400 max-w-[18rem] truncate"
                      title={deliveryDetail(d)}
                    >
                      {deliveryDetail(d)}
                    </td>
                    <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">
                      {formatWhen(d.created_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {d.status === 'failed' && (
                        <button
                          onClick={() => handleRetry(d)}
                          className="text-xs text-brand-300 hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded px-1"
                        >
                          Resend
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete webhook endpoint"
        message={`Delete “${deleteTarget?.name}”? Events will stop being delivered to this URL.`}
        confirmLabel="Delete"
        variant="danger"
        doubleConfirm={false}
      />
    </section>
  );
}
