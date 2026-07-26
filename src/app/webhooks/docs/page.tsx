import type { ReactNode } from 'react';
import {
  Webhook,
  Radio,
  Braces,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { DocsTocNav, type TocSection } from '@/app/api/docs/DocsTocNav';

/* ── Helpers ───────────────────────────────────────────────── */

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="bg-zinc-900 rounded-lg p-4 overflow-x-auto">
      <pre className="text-sm text-zinc-300 font-mono whitespace-pre">{children}</pre>
    </div>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border border-zinc-100 rounded-lg overflow-hidden">
        <thead>
          <tr className="bg-zinc-50 border-b border-zinc-200">
            {head.map(h => (
              <th key={h} className="text-left py-2 px-3 text-xs font-medium text-zinc-500">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-b border-zinc-50 last:border-0 align-top">
              {cells.map((c, j) => (
                <td key={j} className="py-2 px-3 text-xs text-zinc-600">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────── */

export default function WebhooksDocsPage() {
  const tocSections: TocSection[] = [
    { id: 'overview', label: 'Overview', mobileLabel: 'Overview' },
    { id: 'events', label: 'Events', mobileLabel: 'Events', mobilePill: 'bg-violet-50 text-violet-700 hover:bg-violet-100' },
    { id: 'payload', label: 'Payload', mobileLabel: 'Payload' },
    { id: 'signatures', label: 'Signatures', mobileLabel: 'Signatures', mobilePill: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' },
    { id: 'delivery', label: 'Delivery', mobileLabel: 'Delivery', mobilePill: 'bg-blue-50 text-blue-700 hover:bg-blue-100' },
  ];

  return (
    <div>
      {/* ── Page header ── */}
      <header className="bg-white border-b border-zinc-200">
        <div className="max-w-7xl mx-auto px-4 lg:px-6 py-6">
          <div className="flex items-center gap-3.5">
            <div className="p-2.5 bg-violet-50 rounded-xl">
              <Webhook className="text-violet-600" size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-bold text-zinc-900">Webhooks</h1>
                <span className="px-2 py-0.5 text-xs font-semibold bg-violet-50 text-violet-600 rounded-full">
                  Events
                </span>
              </div>
              <p className="text-sm text-zinc-500 mt-1">
                Receive signed events on your own server when invoices change.
              </p>
            </div>
          </div>
        </div>
      </header>

      <DocsTocNav sections={tocSections} infoCutoff={0}>
        <main className="space-y-6 min-w-0">

          {/* ── Overview ── */}
          <section id="overview" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-violet-50 rounded-lg">
                  <Radio className="text-violet-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">How it works</h2>
                  <p className="text-sm text-zinc-500">Create an endpoint, subscribe to events, verify the signature</p>
                </div>
              </div>

              <p className="text-sm text-zinc-600 mb-4">
                Create an endpoint under <strong>Settings &rarr; Webhooks</strong>, subscribe it to one or
                more event types, and copy its signing secret into your receiver. When a matching event
                happens, we POST a signed JSON payload to your URL immediately (one attempt); if it
                fails you can re-send it from the dashboard. Your receiver just needs to verify the
                signature and be idempotent.
              </p>

              <p className="text-sm text-zinc-600">
                The payload always reflects the invoice&apos;s <strong>current</strong> state, which lets a
                receiver <em>reconcile</em> (make its data match) rather than track individual changes.
              </p>
            </div>
          </section>

          {/* ── Events ── */}
          <section id="events" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-violet-50 rounded-lg">
                  <Radio className="text-violet-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">Event types</h2>
                  <p className="text-sm text-zinc-500">Subscribe to all three for full lifecycle sync</p>
                </div>
              </div>

              <SimpleTable
                head={['Event', 'Fires when']}
                rows={[
                  [<code key="e" className="text-brand-600 font-mono text-xs">invoice.paid</code>, 'An invoice enters the paid status.'],
                  [<code key="e" className="text-brand-600 font-mono text-xs">invoice.updated</code>, 'A paid (or previously paid) invoice changes: an edit, an un-pay, or a cancel.'],
                  [<code key="e" className="text-brand-600 font-mono text-xs">invoice.deleted</code>, 'A paid invoice is deleted.'],
                ]}
              />

              <div className="mt-4 p-3 bg-zinc-50 rounded-lg border border-zinc-100">
                <p className="text-sm text-zinc-600">
                  Events fire only for paid-relevant invoices, so editing drafts never sends anything. If your
                  receiver removes data on un-pay/delete, subscribe to <strong>all three</strong> events — not
                  just <code className="text-brand-600 font-mono text-xs">invoice.paid</code>.
                </p>
              </div>
            </div>
          </section>

          {/* ── Payload ── */}
          <section id="payload" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-zinc-100 rounded-lg">
                  <Braces className="text-zinc-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">Payload</h2>
                  <p className="text-sm text-zinc-500">POST body, Content-Type: application/json</p>
                </div>
              </div>

              <CodeBlock>{`{
  "id": "evt_1f0c8b2a...",
  "type": "invoice.paid",
  "sequence": 421,
  "created_at": "2026-07-25T15:41:28.123Z",
  "data": {
    "invoice": {
      "id": "9d1c...",
      "invoice_number": "INV-1043",
      "project_id": "3ab2...",
      "status": "paid",
      "paid": true,
      "invoice_type": "recurring",
      "amount": 2500.00,
      "date": "2026-07-01",
      "due_date": "2026-07-15",
      "paid_date": "2026-07-25",
      "description": "",
      "updated_at": "2026-07-25T15:41:28.000Z"
    },
    "project": { "id": "3ab2...", "name": "Plan for the Future" },
    "line_items": [
      { "id": "li_1", "item_type": "recurring", "amount": 2000.00, "description": "Monthly retainer" },
      { "id": "li_2", "item_type": "reimbursement", "amount": 500.00, "description": "Domain renewal" }
    ],
    "totals_by_type": { "recurring": 2000.00, "reimbursement": 500.00 }
  }
}`}</CodeBlock>

              <div className="mt-4 space-y-2 text-sm text-zinc-600">
                <p>
                  <code className="text-brand-600 font-mono text-xs">sequence</code> is globally monotonic and
                  strictly increases per invoice — drop any event whose sequence is{' '}
                  <code className="text-brand-600 font-mono text-xs">&lt;=</code> the last you applied for that
                  invoice to ignore out-of-order retries.
                </p>
                <p>
                  <code className="text-brand-600 font-mono text-xs">totals_by_type</code> sums line items by{' '}
                  <code className="text-brand-600 font-mono text-xs">item_type</code> (hourly, fixed, recurring,
                  reimbursement); it falls back to <code className="text-brand-600 font-mono text-xs">{'{ <invoice_type>: <amount> }'}</code>{' '}
                  when there are no line items.
                </p>
                <p>
                  <code className="text-brand-600 font-mono text-xs">paid</code> is a convenience boolean; it is{' '}
                  <code className="text-brand-600 font-mono text-xs">false</code> on an un-pay and reflects the
                  last state on delete.
                </p>
              </div>
            </div>
          </section>

          {/* ── Signatures ── */}
          <section id="signatures" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-emerald-50 rounded-lg">
                  <ShieldCheck className="text-emerald-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">Verifying signatures</h2>
                  <p className="text-sm text-zinc-500">Prove the request came from us, unaltered</p>
                </div>
              </div>

              <SimpleTable
                head={['Header', 'Value']}
                rows={[
                  [<code key="h" className="text-brand-600 font-mono text-xs">X-VM-Signature</code>, <code key="v" className="text-zinc-500 font-mono text-xs">t=&lt;unix&gt;,v1=&lt;hex hmac&gt;</code>],
                  [<code key="h" className="text-brand-600 font-mono text-xs">X-VM-Event-Id</code>, 'The event id (evt_...), stable across retries.'],
                  [<code key="h" className="text-brand-600 font-mono text-xs">X-VM-Event-Type</code>, 'The event type.'],
                ]}
              />

              <p className="text-sm text-zinc-600 my-4">
                The signature is <code className="text-brand-600 font-mono text-xs">HMAC-SHA256(secret, &quot;&lt;t&gt;.&lt;rawBody&gt;&quot;)</code>{' '}
                as lowercase hex. Verify against the <strong>raw</strong> body (before JSON parsing), reject stale
                timestamps to block replay, and compare in constant time.
              </p>

              <CodeBlock>{`import crypto from 'node:crypto';

export function verify(secret: string, header: string, rawBody: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map(kv => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}`}</CodeBlock>
            </div>
          </section>

          {/* ── Delivery ── */}
          <section id="delivery" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-blue-50 rounded-lg">
                  <RefreshCw className="text-blue-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">Delivery</h2>
                  <p className="text-sm text-zinc-500">What we expect back, and how failures work</p>
                </div>
              </div>

              <ul className="space-y-2 text-sm text-zinc-600 list-disc pl-5">
                <li>Return any <code className="text-brand-600 font-mono text-xs">2xx</code> to acknowledge. Anything else — or no response within 10 seconds — marks the delivery <code className="text-brand-600 font-mono text-xs">failed</code>.</li>
                <li>Delivery is fire-and-forget: one attempt per event, no automatic retries. A failed delivery can be re-sent manually from <strong>Settings &rarr; Webhooks</strong>.</li>
                <li>A manual re-send (or a re-emitted event) can arrive out of order, so make your handler <strong>idempotent</strong>: key on <code className="text-brand-600 font-mono text-xs">X-VM-Event-Id</code> (or the invoice id) and use <code className="text-brand-600 font-mono text-xs">sequence</code> to ignore stale state.</li>
              </ul>
            </div>
          </section>

        </main>
      </DocsTocNav>
    </div>
  );
}
