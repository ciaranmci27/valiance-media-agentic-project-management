'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Toggle } from '@/components/ui/Toggle';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import Link from 'next/link';
import { Webhook, Plus, Copy, Check, Trash2, RefreshCw, Eye, EyeOff, Send, BookOpen } from 'lucide-react';
import { generateWebhookSecret } from '@/lib/webhooks/sign';
import {
  fetchWebhookEndpoints,
  insertWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  fetchWebhookDeliveries,
  requeueWebhookDelivery,
} from '@/lib/supabase/queries';
import { WEBHOOK_EVENT_TYPES, type WebhookEndpoint, type WebhookDelivery, type WebhookDeliveryStatus } from '@/lib/types';

const EVENT_LABELS: Record<string, string> = {
  'invoice.paid': 'Invoice paid',
  'invoice.updated': 'Invoice updated',
  'invoice.deleted': 'Invoice deleted',
};

const STATUS_STYLES: Record<WebhookDeliveryStatus, string> = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  delivering: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  succeeded: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  failed: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
};

function formatWhen(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function WebhooksPanel({ teamMemberId }: { teamMemberId: string | null }) {
  const supabase = createClient();

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  // Default to the full invoice lifecycle: a receiver that reconciles needs
  // un-pay/edit/delete too, not just invoice.paid.
  const [events, setEvents] = useState<string[]>([...WEBHOOK_EVENT_TYPES]);
  const [saving, setSaving] = useState(false);

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
    (async () => { await load(); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleEvent(evt: string) {
    setEvents(prev => prev.includes(evt) ? prev.filter(e => e !== evt) : [...prev, evt]);
  }

  function resetForm() {
    setName(''); setUrl(''); setDescription(''); setEvents([...WEBHOOK_EVENT_TYPES]); setShowForm(false);
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) { toast('error', 'Name is required'); return; }
    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      toast('error', 'Enter a valid URL'); return;
    }
    // Require HTTPS, except plain http on localhost for local development.
    const isLocalhost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
      toast('error', 'Endpoint URL must use HTTPS'); return;
    }
    if (events.length === 0) { toast('error', 'Select at least one event'); return; }

    setSaving(true);
    try {
      const secret = generateWebhookSecret();
      const created = await insertWebhookEndpoint(supabase, {
        name: trimmedName,
        url: trimmedUrl,
        secret,
        events,
        description: description.trim(),
        created_by: teamMemberId,
      });
      setEndpoints(prev => [created, ...prev]);
      setNewSecret({ name: created.name, secret });
      resetForm();
    } catch (e) {
      console.error('Failed to create webhook', e);
      toast('error', 'Failed to create webhook endpoint');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(endpoint: WebhookEndpoint) {
    const next = !endpoint.is_active;
    setEndpoints(prev => prev.map(e => e.id === endpoint.id ? { ...e, is_active: next } : e));
    try {
      await updateWebhookEndpoint(supabase, endpoint.id, { is_active: next });
    } catch (e) {
      console.error(e);
      setEndpoints(prev => prev.map(el => el.id === endpoint.id ? { ...el, is_active: endpoint.is_active } : el));
      toast('error', 'Failed to update endpoint');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setEndpoints(prev => prev.filter(e => e.id !== target.id));
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
    } catch { /* clipboard blocked */ }
  }

  async function handleRunNow() {
    setRunning(true);
    try {
      const res = await fetch('/api/internal/webhooks/dispatch', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const summary = await res.json();
      toast('success', `Dispatched ${summary.delivered ?? 0} delivery(s)`);
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
              Send signed events to external systems when invoices change.
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
            <Button size="sm" onClick={() => setShowForm(true)} icon={<Plus size={14} />}>
              <span className="sm:hidden">New</span>
              <span className="hidden sm:inline">New Endpoint</span>
            </Button>
          )}
        </div>
      </div>

      {/* One-time secret reveal */}
      {newSecret && (
        <div className="mb-6 p-4 bg-emerald-500/15 border border-emerald-500/30 rounded-lg space-y-3">
          <div className="flex items-center gap-2">
            <Check size={16} className="text-emerald-400" aria-hidden="true" />
            <p className="text-sm font-medium text-emerald-300">Endpoint “{newSecret.name}” created</p>
          </div>
          <p className="text-xs text-emerald-300">
            Copy this signing secret into your receiver now (it verifies each request). You can reveal it again below at any time.
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
          <Button size="sm" variant="secondary" onClick={() => setNewSecret(null)}>Done</Button>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="mb-6 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg space-y-3">
          <h4 className="text-sm font-medium text-white">New endpoint</h4>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Personal Finance"' />
          <Input label="Endpoint URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-app.com/api/webhooks/invoices" />
          <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this endpoint is for" />
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Events</label>
            <div className="rounded-lg border border-white/[0.08] bg-surface-raised divide-y divide-white/[0.06]">
              {WEBHOOK_EVENT_TYPES.map((evt) => (
                <div key={evt} className="px-3 py-2.5">
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
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating…' : 'Create endpoint'}
            </Button>
            <Button size="sm" variant="secondary" onClick={resetForm} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Endpoints list */}
      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : endpoints.length === 0 ? (
        <p className="text-sm text-zinc-500">No webhook endpoints yet. Create one to start relaying events.</p>
      ) : (
        <ul className="space-y-3">
          {endpoints.map((endpoint) => (
            <li key={endpoint.id} className="p-4 bg-white/[0.02] border border-white/[0.08] rounded-lg">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white truncate">{endpoint.name}</span>
                    {!endpoint.is_active && (
                      <span className="text-[11px] uppercase tracking-wide text-zinc-500 border border-white/[0.1] rounded px-1.5 py-0.5">Paused</span>
                    )}
                  </div>
                  <p className="text-xs font-mono text-zinc-400 break-all mt-0.5">{endpoint.url}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {endpoint.events.map((evt) => (
                      <span key={evt} className="text-[11px] text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded px-1.5 py-0.5">
                        {EVENT_LABELS[evt] || evt}
                      </span>
                    ))}
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-2">Last delivery: {formatWhen(endpoint.last_delivery_at)}</p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={handleRunNow}
                    disabled={running}
                    aria-label="Send pending deliveries now"
                    title="Send pending deliveries now"
                    className="p-2 text-zinc-400 hover:text-brand-300 hover:bg-white/[0.06] rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
                  >
                    <Send size={15} />
                  </button>
                  <Toggle checked={endpoint.is_active} onChange={() => handleToggleActive(endpoint)}
                    aria-label={endpoint.is_active ? 'Pause endpoint' : 'Activate endpoint'} />
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
                  onClick={() => setShownSecrets(prev => ({ ...prev, [endpoint.id]: !prev[endpoint.id] }))}
                  aria-label={shownSecrets[endpoint.id] ? 'Hide signing secret' : 'Reveal signing secret'}
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
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-white/[0.08]">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-white/[0.06]">
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Code</th>
                  <th className="px-3 py-2 font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium sr-only">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{d.webhook_events?.event_type || '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[11px] border rounded px-1.5 py-0.5 ${STATUS_STYLES[d.status]}`}>{d.status}</span>
                    </td>
                    <td className="px-3 py-2 text-zinc-400 font-mono">{d.last_status_code ?? '—'}</td>
                    <td className="px-3 py-2 text-zinc-400 font-mono">{d.attempts}</td>
                    <td className="px-3 py-2 text-zinc-500 whitespace-nowrap">{formatWhen(d.created_at)}</td>
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
