'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
  ListChecks,
  KeyRound,
} from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { SecretOnce } from '@/components/agent/ConnectPanel';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { Select } from '@/components/ui/inputs/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { WebhookEndpointDialog, type SaveEndpoint } from '@/components/settings/WebhookEndpointDialog';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { isModuleEnabled } from '@/lib/access-control';
import { webhookRetriesRead } from '@/components/settings/secrets-data';
import { useRead } from '@/lib/query-cache';
import { assistantSetupsRead } from '@/lib/reads';
import type { AssistantSetupView } from '@/lib/assistant';
import { generateWebhookSecret } from '@/lib/webhooks/sign';
import {
  deliveryDetailLine, endpointHealth, eventSummary, hasInvoiceEvents, webhookFields, webhookSaveError, CHAT_WEBHOOK_EVENTS, ENDPOINT_HEALTH_DELIVERIES,
  type EndpointHealth,
} from '@/lib/developers-settings';
import {
  fetchWebhookEndpoints,
  insertWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  fetchWebhookDeliveries,
  requeueWebhookDelivery,
} from '@/lib/supabase/queries';
import {
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookEndpoint,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from '@/lib/types';
import { formatInZone } from '@/lib/time-format';

const SETUP_ROLE_WORDS: Record<string, string> = { owner: 'Owners', admin: 'Admins', member: 'Members', guest: 'Guests' };

/** "Members, Personal assistant": who a setup gives assistants to, and its template. */
function setupName(setup: AssistantSetupView): string {
  const who = setup.match_role ? SETUP_ROLE_WORDS[setup.match_role] ?? setup.match_role : setup.match_group_name ?? 'A removed group';
  return setup.template_label ? `${who}, ${setup.template_label}` : who;
}

export const WEBHOOKS_DESCRIPTION = 'Send signed events to your other systems, such as an AI agent, a data warehouse or your accounting tool, when work, questions, agent runs or invoices change.';

const ALL_ENDPOINTS = '';

const STATUS_STYLES: Record<WebhookDeliveryStatus, string> = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  delivering: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  succeeded: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  failed: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
};

const HEALTH: Record<EndpointHealth['state'], { label: (h: EndpointHealth) => string; className: string }> = {
  ok: { label: () => 'Active', className: 'bg-emerald-500/[0.14] text-emerald-300' },
  idle: { label: () => 'Active, nothing sent yet', className: 'bg-white/[0.06] text-zinc-300' },
  paused: { label: () => 'Paused', className: 'bg-white/[0.06] text-zinc-300' },
  retrying: { label: (h) => `Retrying ${h.retrying}`, className: 'bg-amber-500/[0.14] text-amber-300' },
  failing: { label: (h) => `${h.failed} failed`, className: 'bg-red-500/[0.14] text-red-300' },
};

const ICON_BUTTON = 'p-1.5 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

// A pending delivery that has already been tried is waiting out its backoff.
function deliveryLabel(d: WebhookDelivery): string {
  return d.status === 'pending' && d.attempts > 0 ? 'retrying' : d.status;
}


function formatWhen(value: string | null): string {
  if (!value) return 'not yet';
  return formatInZone(value, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** What deleting an endpoint stops, beyond its URL: people's assistants for a setup or chat endpoint, and its history. */
function deleteMessage(endpoint: WebhookEndpoint): string {
  const chat = endpoint.events.some((event) => CHAT_WEBHOOK_EVENTS.includes(event));
  const assistants = endpoint.assistant_setup_id
    ? ' People\'s assistants from its assistant setup stop answering.'
    : chat ? ' The agent it carries chat for stops answering chat.' : '';
  return `Delete “${endpoint.name}”? Events stop being delivered to ${endpoint.url}.${assistants} Its delivery history, and anything still waiting to send, is removed.`;
}

/**
 * Settings > Developers > Webhooks, while the module is on: the endpoints
 * (status, last delivery, failures, filters, the signing secret on demand),
 * one dialog to add or edit one, and the recent deliveries with resend,
 * filtered to one endpoint from its row.
 */
export function WebhooksPanel({ teamMemberId }: { teamMemberId: string | null }) {
  const supabase = createClient();
  const { projects, team } = useApp();
  const { access } = useAuth();
  // Invoice events need Client invoicing; without it they are neither offered nor sent.
  const billingOn = isModuleEnabled(access, 'billing');
  // Whether scheduled retries run (Owners read it). Unknown counts as on, as before.
  const retries = useRead(access?.role === 'owner' ? webhookRetriesRead : null);
  const retriesOn = retries.data ? retries.data.on : true;
  const deliveryDetail = (d: WebhookDelivery) => deliveryDetailLine(d, retriesOn, formatWhen);

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  // Each endpoint's own latest deliveries, for its health (never just the newest across all of them).
  const [healthDeliveries, setHealthDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<{ editing: WebhookEndpoint | null } | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState(ALL_ENDPOINTS);
  const deliveriesRef = useRef<HTMLDivElement>(null);

  const projectOptions = projects
    .map((p) => ({ value: p.id, label: p.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const editingMember = dialog?.editing?.member_id ?? null;
  const memberOptions = [
    { value: '', label: 'Everyone' },
    ...team
      .filter((m) => m.status !== 'suspended' || m.id === editingMember)
      .map((m) => ({ value: m.id, label: m.name, detail: m.title || (m.role === 'agent' ? 'Agent' : undefined) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Unknown project';
  const memberName = (id: string) => team.find((m) => m.id === id)?.name ?? 'Unknown member';
  const memberKind = (id: string) => {
    const member = team.find((m) => m.id === id);
    if (!member) return null;
    return member.role !== 'agent' ? 'person' as const : member.delegate_of ? 'personal_agent' as const : 'agent' as const;
  };
  const endpointName = (id: string) => endpoints.find((e) => e.id === id)?.name ?? 'Deleted endpoint';
  // Setup names only when an endpoint is scoped to one (Owners read setups; others see the plain label).
  const setups = useRead(endpoints.some((e) => e.assistant_setup_id) ? assistantSetupsRead : null).data ?? [];
  const setupLabel = (id: string) => {
    const setup = setups.find((s) => s.id === id);
    return setup ? `All assistants: ${setupName(setup)}` : 'All assistants from a setup';
  };

  // Per-endpoint secret visibility
  const [shownSecrets, setShownSecrets] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Secrets sealed at rest (pm1:), opened by the server on demand.
  const [openedSecrets, setOpenedSecrets] = useState<Record<string, string>>({});
  const isSealed = (endpoint: WebhookEndpoint) => endpoint.secret.startsWith('pm1:');
  async function readSecret(endpoint: WebhookEndpoint): Promise<string | null> {
    if (!isSealed(endpoint)) return endpoint.secret;
    if (openedSecrets[endpoint.id]) return openedSecrets[endpoint.id];
    const res = await fetch(`/api/workspace/webhook-endpoints/${endpoint.id}/secret`, { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    const secret: string | null = res.ok ? body?.data?.secret ?? null : null;
    if (!secret) {
      toast('error', body?.error?.message ?? 'Could not open the signing secret');
      return null;
    }
    setOpenedSecrets((prev) => ({ ...prev, [endpoint.id]: secret }));
    return secret;
  }
  const [deleteTarget, setDeleteTarget] = useState<WebhookEndpoint | null>(null);
  const [pauseTarget, setPauseTarget] = useState<WebhookEndpoint | null>(null);
  const [secretTarget, setSecretTarget] = useState<WebhookEndpoint | null>(null);
  const [newSecret, setNewSecret] = useState<{ endpoint: WebhookEndpoint; secret: string } | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [eps, dels] = await Promise.all([
        fetchWebhookEndpoints(supabase),
        fetchWebhookDeliveries(supabase, 25),
      ]);
      // Health reads each endpoint's own newest deliveries, one small read each.
      const own = await Promise.all(eps.map(async (endpoint) => [endpoint.id, await fetchWebhookDeliveries(supabase, ENDPOINT_HEALTH_DELIVERIES, endpoint.id)] as const));
      setEndpoints(eps);
      setDeliveries(dels);
      setHealthDeliveries(Object.fromEntries(own));
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

  const saveEndpoint: SaveEndpoint = async (draft) => {
    const editing = dialog?.editing ?? null;
    const fields = webhookFields(draft, !!editing?.agent_event_types);
    try {
      if (editing) {
        const updated = await updateWebhookEndpoint(supabase, editing.id, fields);
        setEndpoints((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
        toast('success', 'Webhook endpoint saved');
        return null;
      }
      const secret = generateWebhookSecret();
      const created = await insertWebhookEndpoint(supabase, { ...fields, secret, created_by: teamMemberId });
      setEndpoints((prev) => [created, ...prev]);
      return secret;
    } catch (e) {
      console.error('Failed to save webhook', e);
      // The database's own rules (chat, setup scope, permission) say what to change; anything else asks to try again.
      throw new Error(webhookSaveError(e, !!editing));
    }
  };

  async function handleToggleActive(endpoint: WebhookEndpoint, confirmed = false) {
    const next = !endpoint.is_active;
    // Pausing drops events instead of holding them, so it asks first.
    if (!next && !confirmed) {
      setPauseTarget(endpoint);
      return;
    }
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

  async function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setEndpoints((prev) => prev.filter((e) => e.id !== target.id));
    if (deliveriesFor === target.id) setDeliveriesFor(ALL_ENDPOINTS);
    try {
      await deleteWebhookEndpoint(supabase, target.id);
      toast('success', 'Webhook endpoint deleted');
    } catch (e) {
      console.error(e);
      toast('error', 'Failed to delete endpoint');
      load();
    }
  }

  async function handleNewSecret() {
    if (!secretTarget) return;
    const endpoint = secretTarget;
    setSecretTarget(null);
    try {
      const res = await fetch(`/api/workspace/webhook-endpoints/${endpoint.id}/secret`, { method: 'POST', cache: 'no-store' });
      const body = await res.json().catch(() => null);
      const secret: string | null = res.ok ? body?.data?.secret ?? null : null;
      if (!secret) throw new Error(body?.error?.message ?? 'Could not make a new signing secret.');
      // The row's copy is stale now: the next reveal reads the new one.
      setOpenedSecrets((prev) => ({ ...prev, [endpoint.id]: secret }));
      void load();
      setNewSecret({ endpoint, secret });
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not make a new signing secret.');
    }
  }

  async function handleCopySecret(endpoint: WebhookEndpoint) {
    const secret = await readSecret(endpoint);
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopiedId(endpoint.id);
      toast('success', 'Signing secret copied');
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast('error', 'Could not copy. Reveal the secret and copy it instead.');
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
      toast('error', 'Could not send deliveries');
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

  const showDeliveries = (endpoint: WebhookEndpoint) => {
    setDeliveriesFor(endpoint.id);
    requestAnimationFrame(() => deliveriesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const shownDeliveries = deliveriesFor ? deliveries.filter((d) => d.endpoint_id === deliveriesFor) : deliveries;
  const deliveryFilterOptions = [
    { value: ALL_ENDPOINTS, label: 'All endpoints' },
    ...endpoints.map((e) => ({ value: e.id, label: e.name })),
  ];

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="webhooks-heading">
      <SettingsSectionHeader
        icon={Webhook}
        title="Webhooks"
        headingId="webhooks-heading"
        description={WEBHOOKS_DESCRIPTION}
        action={(
          <Button size="sm" onClick={() => setDialog({ editing: null })} icon={<Plus size={14} aria-hidden="true" />}>
            New endpoint
          </Button>
        )}
      />

      {/* Endpoints list */}
      {loading ? (
        <p role="status" className="text-sm text-zinc-400">Loading endpoints</p>
      ) : endpoints.length === 0 ? (
        <div className="rounded-lg bg-white/[0.03] px-4 py-6 text-center">
          <Webhook className="mx-auto mb-2 text-zinc-400" size={22} aria-hidden="true" />
          <p className="text-sm font-medium text-zinc-200">No endpoints yet</p>
          <p className="mt-1 text-xs text-zinc-400">Add one to start sending events. <Link href="/webhooks/docs" className="font-medium text-brand-300 underline underline-offset-2">How webhooks work</Link></p>
        </div>
      ) : (
        <ul className="space-y-3">
          {endpoints.map((endpoint) => {
            const health = endpointHealth(endpoint, healthDeliveries[endpoint.id] ?? deliveries);
            const look = HEALTH[health.state];
            return (
              <li key={endpoint.id} className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate font-medium text-white">{endpoint.name}</span>
                      <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${look.className}`}>{look.label(health)}</span>
                    </div>
                    <p className="mt-0.5 break-all font-mono text-xs text-zinc-400">{endpoint.url}</p>
                    {endpoint.description && <p className="mt-1 text-xs text-zinc-400">{endpoint.description}</p>}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <Toggle
                      checked={endpoint.is_active}
                      onChange={() => handleToggleActive(endpoint)}
                      aria-label={endpoint.is_active ? `Pause ${endpoint.name}` : `Turn on ${endpoint.name}`}
                    />
                    <RowActionsMenu
                      label={`Actions for ${endpoint.name}`}
                      actions={[
                        { label: 'Edit', icon: <Pencil size={14} aria-hidden="true" />, onClick: () => setDialog({ editing: endpoint }) },
                        { label: 'View deliveries', icon: <ListChecks size={14} aria-hidden="true" />, onClick: () => showDeliveries(endpoint) },
                        { label: 'New signing secret', icon: <KeyRound size={14} aria-hidden="true" />, onClick: () => setSecretTarget(endpoint) },
                        { label: 'Delete', icon: <Trash2 size={14} aria-hidden="true" />, onClick: () => setDeleteTarget(endpoint), variant: 'danger', divider: true },
                      ]}
                    />
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {eventSummary(endpoint.events).map((label) => (
                    <span key={label} className="rounded bg-brand-500/[0.12] px-1.5 py-0.5 text-[11px] text-brand-200">{label}</span>
                  ))}
                  {endpoint.project_ids && (
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-300">
                      Projects: {endpoint.project_ids.map(projectName).join(', ')}
                    </span>
                  )}
                  {endpoint.member_id && (
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-300">
                      Concerns {memberName(endpoint.member_id)}
                    </span>
                  )}
                  {endpoint.assistant_setup_id && (
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-300">
                      {setupLabel(endpoint.assistant_setup_id)}
                    </span>
                  )}
                  {endpoint.agent_event_types && (
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-300">
                      Agent events: {endpoint.agent_event_types.join(', ')}
                    </span>
                  )}
                  {billingOn && hasInvoiceEvents(endpoint.events) && endpoint.amount_basis === 'net' && (
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-300">Amounts net of splits</span>
                  )}
                </div>
                {!billingOn && hasInvoiceEvents(endpoint.events) && (
                  <p className="mt-2 text-[11px] text-zinc-400">Invoice events wait while Client invoicing is off.</p>
                )}

                <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
                  <span>Last delivery {formatWhen(endpoint.last_delivery_at)}</span>
                  {health.failed > 0 && <span className={health.state === 'failing' ? 'text-red-300' : 'text-zinc-400'}>{health.state === 'failing' ? `${health.failed} failed recently` : `${health.failed} failed earlier, delivered since`}</span>}
                  {health.retrying > 0 && <span className="text-amber-300">{health.retrying} retrying</span>}
                  {(health.failed > 0 || health.retrying > 0) && (
                    <button type="button" onClick={() => showDeliveries(endpoint)} className="rounded font-medium text-brand-300 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                      See deliveries
                    </button>
                  )}
                </p>

                {/* Signing secret, on demand */}
                <div className="mt-3 flex items-center gap-2">
                  <span className="sr-only">Signing secret</span>
                  <code className="min-w-0 flex-1 select-all break-all rounded-md border border-white/[0.08] bg-surface-raised px-2.5 py-1.5 font-mono text-xs text-zinc-300">
                    {shownSecrets[endpoint.id] ? (isSealed(endpoint) ? openedSecrets[endpoint.id] ?? '' : endpoint.secret) : '•'.repeat(24)}
                  </code>
                  <Tooltip content={shownSecrets[endpoint.id] ? 'Hide signing secret' : 'Reveal signing secret'}>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!shownSecrets[endpoint.id] && !(await readSecret(endpoint))) return;
                        setShownSecrets((prev) => ({ ...prev, [endpoint.id]: !prev[endpoint.id] }));
                      }}
                      aria-label={shownSecrets[endpoint.id] ? 'Hide signing secret' : 'Reveal signing secret'}
                      className={ICON_BUTTON}
                    >
                      {shownSecrets[endpoint.id] ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                    </button>
                  </Tooltip>
                  <Tooltip content="Copy signing secret">
                    <button type="button" onClick={() => { void handleCopySecret(endpoint); }} aria-label="Copy signing secret" className={ICON_BUTTON}>
                      {copiedId === endpoint.id ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                    </button>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Recent deliveries */}
      {!loading && endpoints.length > 0 && (
        <div ref={deliveriesRef} id="webhook-deliveries" className="mt-6 scroll-mt-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-medium text-white">Recent deliveries</h3>
            {endpoints.length > 1 && (
              <Select
                size="sm"
                ariaLabel="Show deliveries for"
                value={deliveriesFor}
                onChange={setDeliveriesFor}
                options={deliveryFilterOptions}
                className="w-44"
              />
            )}
            <Button size="sm" variant="secondary" onClick={() => { void handleRunNow(); }} disabled={running} icon={<Send size={13} aria-hidden="true" />}>
              {running ? 'Sending' : 'Send pending now'}
            </Button>
            <Tooltip content="Refresh deliveries">
              <button type="button" onClick={load} aria-label="Refresh deliveries" className={ICON_BUTTON}>
                <RefreshCw size={14} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>

          {shownDeliveries.length === 0 ? (
            <p className="rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm text-zinc-400">
              {deliveriesFor ? `Nothing sent to ${endpointName(deliveriesFor)} recently.` : 'Nothing sent yet. Deliveries show here as events happen.'}
            </p>
          ) : (
            <>
              {/* Phones: one card per delivery. */}
              <ul aria-label="Recent deliveries" className="max-h-[32rem] space-y-2 overflow-y-auto sm:hidden">
                {shownDeliveries.map((d) => (
                  <li key={d.id} className="rounded-lg border border-white/[0.08] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm text-zinc-200">{d.webhook_events?.event_type || 'Event'}</span>
                      <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${STATUS_STYLES[d.status]}`}>{deliveryLabel(d)}</span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-400">{deliveryDetail(d)}</p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                      <span className="min-w-0 truncate">
                        {[
                          deliveriesFor ? null : endpointName(d.endpoint_id),
                          // A delivered one already says when, above.
                          d.status === 'succeeded' ? null : formatWhen(d.created_at),
                          `try ${d.attempts}/${WEBHOOK_MAX_ATTEMPTS}`,
                        ].filter(Boolean).join(', ')}
                      </span>
                      {d.status === 'failed' && (
                        <button type="button" onClick={() => handleRetry(d)} className="rounded px-1 text-xs font-medium text-brand-300 hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                          Resend
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>

              {/* Rows keep their height; the list scrolls past about ten, with its column names pinned. */}
              <div
                role="region"
                tabIndex={0}
                aria-label="Recent deliveries"
                className="hidden max-h-96 overflow-auto rounded-lg border border-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface sm:block"
              >
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-[1] bg-surface-raised">
                    <tr className="border-b border-white/[0.06] text-left text-[11px] uppercase tracking-wide text-zinc-400">
                      <th className="px-3 py-2 font-medium">Event</th>
                      {!deliveriesFor && <th className="px-3 py-2 font-medium">Endpoint</th>}
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Code</th>
                      <th className="px-3 py-2 font-medium">Attempts</th>
                      <th className="px-3 py-2 font-medium">Detail</th>
                      <th className="px-3 py-2 font-medium">When</th>
                      <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05]">
                    {shownDeliveries.map((d) => (
                      <tr key={d.id}>
                        <td className="whitespace-nowrap px-3 py-2 text-zinc-300">{d.webhook_events?.event_type || 'Event'}</td>
                        {!deliveriesFor && <td className="max-w-[10rem] truncate px-3 py-2 text-zinc-400">{endpointName(d.endpoint_id)}</td>}
                        <td className="px-3 py-2">
                          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${STATUS_STYLES[d.status]}`}>{deliveryLabel(d)}</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-400">{d.last_status_code ?? 'None'}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-zinc-400">{d.attempts}/{WEBHOOK_MAX_ATTEMPTS}</td>
                        <td className="max-w-[18rem] px-3 py-2 text-zinc-400">
                          <span className="line-clamp-2 break-words">{deliveryDetail(d)}</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{formatWhen(d.created_at)}</td>
                        <td className="px-3 py-2 text-right">
                          {d.status === 'failed' && (
                            <button
                              type="button"
                              onClick={() => handleRetry(d)}
                              className="rounded px-1 text-xs text-brand-300 hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
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
            </>
          )}
        </div>
      )}

      <p className="mt-6 flex items-center gap-2 text-xs text-zinc-400">
        <BookOpen size={13} aria-hidden="true" className="flex-shrink-0" />
        <span>
          Payloads, signatures and retries are in the <Link href="/webhooks/docs" className="font-medium text-brand-300 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">webhook docs</Link>.
        </span>
      </p>

      <WebhookEndpointDialog
        isOpen={!!dialog}
        editing={dialog?.editing ?? null}
        billingOn={billingOn}
        projectOptions={projectOptions}
        memberOptions={memberOptions}
        memberKind={memberKind}
        onSave={saveEndpoint}
        onClose={() => setDialog(null)}
      />

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete webhook endpoint"
        message={deleteTarget ? deleteMessage(deleteTarget) : ''}
        confirmLabel="Delete"
        variant="danger"
        doubleConfirm={false}
      />

      <ConfirmDialog
        isOpen={!!pauseTarget}
        onClose={() => setPauseTarget(null)}
        onConfirm={() => { const target = pauseTarget; setPauseTarget(null); if (target) void handleToggleActive(target, true); }}
        title={`Pause ${pauseTarget?.name ?? 'this endpoint'}?`}
        message={pauseTarget ? `While paused, events are not sent or kept. Anything that happens until you turn it back on will never reach ${pauseTarget.url}.` : ''}
        confirmLabel="Pause"
        variant="danger"
        doubleConfirm={false}
      />

      <ConfirmDialog
        isOpen={!!secretTarget}
        onClose={() => setSecretTarget(null)}
        onConfirm={() => { void handleNewSecret(); }}
        title={`New signing secret for ${secretTarget?.name ?? 'this endpoint'}?`}
        message="The old secret stops at once: every delivery from now on is signed with the new one, so put it into your receiver straight away. The endpoint keeps its filters and delivery history."
        confirmLabel="Make a new secret"
        variant="danger"
        doubleConfirm={false}
      />

      <Modal isOpen={!!newSecret} onClose={() => {}} title={newSecret ? `New secret for ${newSecret.endpoint.name}` : 'New signing secret'} size="md">
        {newSecret && (
          <div className="space-y-4">
            <SecretOnce
              secret={{ secret: newSecret.secret }}
              heading="Copy the new signing secret into your receiver now."
              what="Signing secret"
              copyLabel="Copy secret"
              hint="The old secret no longer verifies. You can reveal this one again from the endpoint's row."
            />
            <div className="flex justify-end">
              <Button onClick={() => setNewSecret(null)}>Done</Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
