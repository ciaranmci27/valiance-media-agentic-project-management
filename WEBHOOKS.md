# Webhooks

Outbound webhooks let an external system react when work or invoices change,
without a native integration. An AI agent harness uses them to wake up when
there is something for its agent: a task assigned to it, a comment on its task,
a question asked to it, an answer to its question, a review of its work.
Create an endpoint under **Settings > Developers**, subscribe it to one or more
event types, optionally narrow it to some projects or to one member, and copy
the signing secret into your receiver.

Delivery uses a transactional outbox: a database trigger records the event and
fans out one delivery per matching endpoint in the same transaction as the
change; a dispatcher signs and POSTs it right after. A failed attempt is
retried automatically with backoff, up to 8 attempts; after that you can
re-send it from Settings > Developers, which shows each delivery's attempts,
last error and next try.

## Modules

Webhooks needs only the **Webhooks** module. Invoice events also need **Client
invoicing**: while it is off, invoice events wait in order (their attempts
untouched) and go out once it is back on. Every other event goes out with
Client invoicing off. While the Webhooks module is off, nothing goes out and
deliveries wait.

## Event types

| Type | Fires when | Subject |
| --- | --- | --- |
| `task.created` | A task is created (with the assignees saved with it), or restored from Trash. | the task |
| `task.updated` | A task's status, assignees, title, description, priority, due date, project, or who may work it (`ai_readiness`) changes. `data.changes` names the fields. | the task |
| `task.deleted` | A task is moved to Trash. | the task |
| `comment.created` | A comment is added to a task. | the task |
| `review.submitted` | A review verdict is filed on a task. | the task |
| `question.asked` | A question is asked (or opens again, or comes back from Trash open). | the question |
| `question.answered` | A question is answered. | the question |
| `question.cancelled` | A question is withdrawn, or moved to Trash while open. | the question |
| `suggestion.created` | A task suggestion is made. | the suggestion |
| `suggestion.decided` | A suggestion is approved, rejected or declined. | the suggestion |
| `run.started` | An agent starts a run (POST /api/v1/agents/runs, MCP start_run). | the run |
| `run.finished` | An agent run finishes: `succeeded`, `failed`, `cancelled` or `timed_out`. | the run |
| `invoice.paid` | An invoice enters the `paid` status. | the invoice |
| `invoice.updated` | A paid (or previously paid) invoice changes: an edit, an un-pay, a cancel. | the invoice |
| `invoice.deleted` | A paid invoice is deleted. | the invoice |
| `invoice.payment_recorded` | A payment is recorded against an invoice. | the invoice |
| `invoice.payment_removed` | A payment is removed from an invoice. | the invoice |

What sends nothing: reordering tasks, claiming or releasing a task (bookkeeping,
unless the claim assigns the task, which is a `task.updated`), changes to a
task's other fields (tags, parent), anything on a task in Trash, a question
expiring (an open question past `expires_at` reads as expired), a suggestion
asking for more information, updates to a running run (its plan, notes, tokens),
a run timing out (a run with no update for two hours reads as `timed_out`;
only a finish sends `run.finished`), turns recorded without a run, and invoice
drafts.

One save is one event: every change to a task in one transaction folds into one
`task.updated` (its `changes` lists them all), and a task created with its
assignees is one `task.created` that names them.

## Filters

Each endpoint has three filters. Empty means everything.

- **Events**: the types above.
- **Projects** (`project_ids`): only events on these projects. A task moved
  between projects reaches both projects' endpoints. An event with no project
  (a question asked on nothing) never matches a project list.
- **Member** (`member_id`): only events that **concern** that member. This is
  how an agent gets a webhook for its own work. An event concerns:
  - for a task event, a comment or a review: the task's assignees and the
    holder of a live claim on it, plus anyone the change took off the task (an
    assignee who was removed hears that they were);
  - for a question: the member asked (`asked_to`) and the asker (`asked_by`);
  - for a suggestion: who proposed it and who it would be assigned to;
  - for a run: the agent whose run it is;
  - for an invoice: nobody, so an endpoint with a member filter never receives
    invoice events.

  The one definition is the database function `pm.webhook_event_members` (a
  run's is its agent, set by its trigger); every payload lists the result as
  `data.member_ids`. Writing a comment does not
  make the author concerned: an agent does not wake up for its own comment.

## Retries and ordering

- Any non-`2xx` response, or no response within 10s, is a failed attempt. The
  delivery goes back in the queue and is tried again after about 1 minute,
  then 3, 9, 27 and 81 minutes, 4 hours, then 12 hours. After the 8th attempt
  it is marked `failed` and waits for a manual re-send (which restarts the
  attempt budget).
- Every write through the API (REST or MCP), and saving a task, a comment or an
  invoice in the app, sends the events it queued right after the response.
  Anything else waits for the next send. Retries are sent on a schedule by the
  database. The
  Supabase pg_cron job `pm-webhook-retries` checks every minute
  (`pm.webhook_retry_kick`) and, when a delivery is due, POSTs to
  `/api/internal/webhooks/scheduled`. It is not a Vercel cron because Vercel's
  Hobby plan allows only daily crons. It runs while the Webhooks module is on;
  an invoice delivery does not count as due while Client invoicing is off.
- To set it up, an Owner presses **Turn on webhook retries** in Settings >
  Developers. The server makes the scheduler secret, saves it encrypted in the
  app, and writes it with the app's address to Supabase Vault as
  `pm_webhook_scheduler_secret` and `pm_webhook_scheduler_url`. It needs
  `APP_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL` set to the app's address, and
  Supabase Vault; the card says which is missing. Until retries are on, a
  failed delivery only goes out again on the next change or when someone
  presses "Send pending deliveries now" in the Webhooks section.
- Older installs may instead set `WEBHOOK_SCHEDULER_ENABLED=true` and
  `WEBHOOK_SCHEDULER_SECRET` in the host, with the same secret and the app URL
  in Vault under the names above. The app reads these only as a fallback; a
  secret saved in the app wins.
- Each attempt holds a 2-minute lease. If a dispatcher run dies mid-delivery,
  the next run takes the delivery back once the lease expires, so nothing is
  left stuck in `delivering`. It counts as an attempt.
- **Ordering is per subject** (the table above): events for one subject reach
  an endpoint one at a time in `sequence` order. A later event waits while an
  earlier one for the same subject is pending or in flight. A task's comments
  and reviews share the task's line, so a harness sees them in the order they
  happened. Different subjects never hold each other up. An event that has
  used all its attempts stops holding the line.
- Because a retry or a lost acknowledgement can send the same event again,
  receivers must be idempotent on `X-VM-Event-Id`.

## Payload

`POST` with `Content-Type: application/json`. Every event has the same
envelope, and `data` always reflects the subject's **current** state, which
lets a receiver reconcile rather than track deltas.

```json
{
  "id": "evt_1f0c8b2a...",
  "type": "task.updated",
  "sequence": 421,
  "created_at": "2026-11-24T15:41:28.123Z",
  "data": { }
}
```

- `sequence` is globally monotonic. For a given subject it strictly increases,
  so a receiver can drop out-of-order retries by ignoring any event whose
  `sequence` is `<=` the last one it applied for that subject.

### Work events

Every work event's `data` carries the ids a harness keys on:

| Field | Meaning |
| --- | --- |
| `project_id` | The project, or `null` (a question asked on nothing). |
| `task_id` | The task, or `null` (a question not on a task, a suggestion not yet a task). |
| `member_ids` | Who the event concerns (see Filters), sorted. |
| `actor_id` | The member (person or agent) who made the change, when known; `null` for scripts, cron jobs and keys with no member. An agent can skip events it caused itself. |
| `project` | `{ "id", "name" }`, or `null` with no project. |

**Task events** (`task.created`, `task.updated`, `task.deleted`) add `task`,
and `task.updated` adds `changes`:

```json
{
  "id": "evt_...",
  "type": "task.updated",
  "sequence": 512,
  "created_at": "2026-11-24T15:41:28.123Z",
  "data": {
    "task": {
      "id": "7c1e...",
      "project_id": "3ab2...",
      "parent_task_id": null,
      "title": "Fix the checkout total",
      "description": "EU rounding",
      "status": "in_progress",
      "priority": "high",
      "due_date": "2026-12-01",
      "tags": ["eu"],
      "ai_readiness": "ai_ready",
      "assignee_ids": ["5d0a..."],
      "claimed_by": "5d0a...",
      "claim_expires_at": "2026-11-24T16:41:28.000Z",
      "created_by": "9f2b...",
      "created_via": "app",
      "source_task_suggestion_id": null,
      "completed_at": null,
      "created_at": "2026-11-24T15:00:00.000Z",
      "updated_at": "2026-11-24T15:41:28.000Z",
      "deleted_at": null
    },
    "changes": ["assignee_ids", "status"],
    "project": { "id": "3ab2...", "name": "Acme Website" },
    "project_id": "3ab2...",
    "task_id": "7c1e...",
    "member_ids": ["5d0a..."],
    "actor_id": "9f2b..."
  }
}
```

`claimed_by` and `claim_expires_at` are set only while a claim is live.
`changes` uses these names: `status`, `assignee_ids`, `title`, `description`,
`priority`, `due_date`, `project_id`, `ai_readiness`.

**`comment.created`** adds the task (as above) and
`comment: { id, task_id, author_id, text, created_at }`.

**`review.submitted`** adds the task and
`review: { id, task_id, round, verdict, summary, pr_url, head_sha, reviewer_id, created_at }`.
`verdict` is `approved` or `changes_requested`. `pr_url` and `head_sha` are both
`null` on a review of work without a pull request (a document, a data fix).

**Question events** add
`question: { id, project_id, task_id, asked_by, asked_to, question, choices, allow_other, status, answer_choice, answer_text, answered_by, answered_at, cancelled_by, cancelled_at, expires_at, created_at, updated_at, deleted_at }`.
An approval (a question an agent asks before an action) uses the same events,
and its `question` also carries `kind: "approval"`, `action: { type, summary, details? }`,
`decision` (`approved`, `rejected` or `null`) and `decided_by` (who decided, or
`null`). A plain question carries none of these four.

**Suggestion events** add
`suggestion: { id, project_id, goal_id, proposed_by, assigned_to, title, description, reasoning, priority, effort_estimate, status, reviewed_by, reviewed_at, rejection_reason, info_request, converted_task_id, bundle_key, created_at, updated_at }`.
The task an approval makes arrives as its own `task.created`, which names the
suggestion in `source_task_suggestion_id`.

**Run events** (`run.started`, `run.finished`) add
`run: { id, agent_id, task_id, project_id, status, title, summary, model, trigger, tokens_in, tokens_out, cost_usd, external_id, external_url, started_at, finished_at, updated_at }`.
`tokens_in`, `tokens_out` and `cost_usd` (US dollars) are the run's own totals
as its harness reported them, `null` when it did not. `external_id` is the
harness's own run id and `external_url` its trace link.

### Invoice events

Unchanged since webhooks began:

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
    "amount_basis": "gross",
    "line_items": [
      { "id": "li_1", "item_type": "recurring", "amount": 2000.00, "description": "Monthly retainer" },
      { "id": "li_2", "item_type": "reimbursement", "amount": 500.00, "description": "Domain renewal" }
    ],
    "totals_by_type": { "recurring": 2000.00, "reimbursement": 500.00 }
  }
}
```

Notes:

- Invoice events fire only for paid-relevant invoices, so editing drafts never
  sends anything.
- `totals_by_type` sums `line_items` by `item_type` (`hourly`, `fixed`,
  `recurring`, `reimbursement`). If an invoice has no explicit line items, it
  falls back to `{ <invoice_type>: <amount> }`.
- `amount_basis` is set per endpoint (invoice events only). With `net`,
  `invoice.amount`, each line amount and `totals_by_type` are what is left
  after revenue splits; the split itself is never sent.
- A `fixed` or `recurring` line can be negative: a discount. It never carries a
  revenue split, so on a `net` endpoint it comes out of the company's share,
  and a type's subtotal can be negative.
- `paid` is a convenience boolean (`status === 'paid'`). On `invoice.updated`
  after an un-pay it is `false`; on `invoice.deleted` it reflects the last state.
- The payment events add `payment`, `paid_total` and `outstanding`.

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
your handler **idempotent** (key on `X-VM-Event-Id` or the subject's id) and use
`sequence` to ignore stale state.
