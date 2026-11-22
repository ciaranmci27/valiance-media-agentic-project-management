# Webhooks

Outbound webhooks let an external system react when invoices change, without a
native integration. Create an endpoint under **Settings > Developers**, subscribe
it to one or more event types, and copy the signing secret into your receiver.

Delivery uses a transactional outbox: a database trigger records the event and
fans out one delivery per subscribed endpoint; a dispatcher signs and POSTs it
immediately after the change. A failed attempt is retried automatically with
backoff, up to 8 attempts; after that you can re-send it from Settings >
Developers, which shows each delivery's attempts, last error and next try.

## Retries and ordering

- Any non-`2xx` response, or no response within 10s, is a failed attempt. The
  delivery goes back in the queue and is tried again after about 1 minute,
  then 3, 9, 27 and 81 minutes, 4 hours, then 12 hours. After the 8th attempt
  it is marked `failed` and waits for a manual re-send (which restarts the
  attempt budget).
- Retries are sent on a schedule by the database. The Supabase pg_cron job
  `pm-webhook-retries` checks every minute (`pm.webhook_retry_kick`) and, when
  a delivery is due, POSTs to `/api/internal/webhooks/scheduled`. It is not a
  Vercel cron because Vercel's Hobby plan allows only daily crons. It runs
  only while the Webhooks and Client invoicing modules are on.
- To set it up, an Owner presses **Turn on webhook retries** in Settings >
  Developers. The server makes the scheduler secret, saves it encrypted in the
  app, and writes it with the app's address to Supabase Vault as
  `pm_webhook_scheduler_secret` and `pm_webhook_scheduler_url`. It needs
  `APP_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL` set to the app's address, and
  Supabase Vault; the card says which is missing. Until retries are on, a
  failed delivery only goes out again on the next invoice change or when
  someone presses "Send pending deliveries now" in the Webhooks section.
- Older installs may instead set `WEBHOOK_SCHEDULER_ENABLED=true` and
  `WEBHOOK_SCHEDULER_SECRET` in the host, with the same secret and the app URL
  in Vault under the names above. The app reads these only as a fallback; a
  secret saved in the app wins.
- Each attempt holds a 2-minute lease. If a dispatcher run dies mid-delivery,
  the next run takes the delivery back once the lease expires, so nothing is
  left stuck in `delivering`. It counts as an attempt.
- Events for one invoice reach an endpoint one at a time in `sequence` order:
  a later event waits while an earlier one for the same invoice is pending or
  in flight. An event that has used all its attempts stops holding the line.
- Because a retry or a lost acknowledgement can send the same event again,
  receivers must be idempotent on `X-VM-Event-Id`.

## Event types

| Type | Fires when |
| --- | --- |
| `invoice.paid` | An invoice enters the `paid` status. |
| `invoice.updated` | A paid (or previously paid) invoice changes: an edit, an un-pay, a cancel. |
| `invoice.deleted` | A paid invoice is deleted. |

Events fire only for paid-relevant invoices, so editing drafts never sends
anything. The payload always reflects the invoice's **current** state, which lets
a receiver reconcile rather than track deltas.

## Payload

`POST` with `Content-Type: application/json`:

```json
{
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
    "project": { "id": "3ab2...", "name": "Acme Website" },
    "line_items": [
      { "id": "li_1", "item_type": "recurring", "amount": 2000.00, "description": "Monthly retainer" },
      { "id": "li_2", "item_type": "reimbursement", "amount": 500.00, "description": "Domain renewal" }
    ],
    "totals_by_type": { "recurring": 2000.00, "reimbursement": 500.00 }
  }
}
```

Notes:

- `sequence` is globally monotonic. For a given invoice it strictly increases,
  so a receiver can drop out-of-order retries by ignoring any event whose
  `sequence` is `<=` the last one it applied for that invoice.
- `totals_by_type` sums `line_items` by `item_type` (`hourly`, `fixed`,
  `recurring`, `reimbursement`). If an invoice has no explicit line items, it
  falls back to `{ <invoice_type>: <amount> }`.
- A `fixed` or `recurring` line can be negative: a discount. It never carries a
  revenue split, so on a `net` endpoint it comes out of the company's share,
  and a type's subtotal can be negative.
- `paid` is a convenience boolean (`status === 'paid'`). On `invoice.updated`
  after an un-pay it is `false`; on `invoice.deleted` it reflects the last state.

## Headers

| Header | Value |
| --- | --- |
| `X-VM-Signature` | `t=<unix_seconds>,v1=<hex hmac>` |
| `X-VM-Event-Id` | The event `id` (`evt_...`), stable across retries. |
| `X-VM-Event-Type` | The event `type`. |

## Verifying the signature

The signature is `HMAC-SHA256(secret, "<t>.<rawBody>")` as lowercase hex, where
`t` is the unix timestamp from the header. Verify against the **raw** request
body (before JSON parsing), reject stale timestamps to block replay, and compare
in constant time.

```ts
import crypto from 'node:crypto';

export function verify(secret: string, header: string, rawBody: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map(kv => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Return `2xx` to acknowledge. Any other status (or a timeout past 10s) is a
failed attempt and is retried as described under Retries and ordering.
A manual re-send (or a redelivered event) can still arrive out of order, so make
your handler **idempotent** (key on `X-VM-Event-Id` or the invoice id) and use
`sequence` to ignore stale state.
