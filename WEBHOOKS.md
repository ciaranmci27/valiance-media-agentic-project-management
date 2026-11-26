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
deliveries wait. `chat.message` and `assistant.message` are the exception: they
are queued only while the Webhooks module is on when the message arrives. A
message that arrives while it is off is never queued and waits for its agent as
pending (`GET /api/v1/chat/messages`).

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
| `question.expired` | An open question passes its `expires_at` without an answer (stored within five minutes, or sooner when someone reads it). | the question |
| `suggestion.created` | A task suggestion is made. | the suggestion |
| `suggestion.decided` | A suggestion is approved, rejected or declined. | the suggestion |
| `run.started` | An agent starts a run (POST /api/v1/agents/runs, MCP start_run). | the run |
| `run.updated` | An unfinished run changes status: `waiting` (on a person: the agent said so, or asked a question or approval naming the run) or back to `running`. | the run |
| `run.finished` | An agent run finishes: `succeeded`, `failed`, `cancelled` or `timed_out` (a run with no update for two hours is stored as `timed_out` within five minutes; a run waiting on a person never is while a question naming it is open, and after seven days with none). | the run |
| `agent.offline` | An agent stops responding: its heartbeat is older than two missed beats plus a minute. Paused agents and personal assistants are skipped. | the agent |
| `agent.online` | An agent that went offline reports again. | the agent |
| `agent.paused` | An agent may no longer start work: it was paused, or an Owner paused every agent. Once per change, one event per agent: pausing one agent while every agent is paused, or pausing every agent while one is already paused on its own, changes nothing for it and sends nothing. | the agent |
| `agent.resumed` | An agent may start work again: its own pause or the workspace pause ended (and the other is not on). | the agent |
| `budget.exceeded` | An agent's spend this budget period first reaches its budget (`budget_usd` or `budget_tokens`). Once a period, when the app first sees it: after usage is reported, at a refused run start, or when the agent reads its status. | the agent |
| `template.run` | A task template is used (by hand, POST /api/v1/task-templates/{id}/run, MCP run_task_template). Each task it makes also sends its own `task.created`. | the run |
| `agent_event.created` | An agent records any event (POST /api/v1/agent-activities, MCP log_activity, host telemetry, a fleet alert). Opt in only: never a default. | the event itself |
| `chat.message` | A chat message for an agent: a person messages their own assistant (the personal bot), or a company agent is asked, or hears channel context (the company bot). Opt in only, and only on an endpoint filtered to an agent or scoped to an assistant setup. | the chat message |
| `assistant.message` | Deprecated alias of `chat.message` for personal assistants, kept unchanged for at least three releases: a person messages their own assistant. Opt in only, and only on an endpoint filtered to a personal agent or scoped to an assistant setup. Subscribe to one of the two, not both. | the chat message |
| `invoice.paid` | An invoice enters the `paid` status. | the invoice |
| `invoice.updated` | A paid (or previously paid) invoice changes: an edit, an un-pay, a cancel. | the invoice |
| `invoice.deleted` | A paid invoice is deleted. | the invoice |
| `invoice.payment_recorded` | A payment is recorded against an invoice. | the invoice |
| `invoice.payment_removed` | A payment is removed from an invoice. | the invoice |

What sends nothing: reordering tasks, claiming or releasing a task (bookkeeping,
unless the claim assigns the task, which is a `task.updated`), changes to a
task's other fields (tags, parent), anything on a task in Trash, a suggestion
asking for more information, updates to a running run that keep its status (its plan, notes, tokens),
turns recorded without a run, and invoice drafts.

Time passing is an event too. Every five minutes the database's watchdog
(`pm.run_watchdog`, pg_cron job `pm-agent-watchdog`) stores what readers used
to work out on their own, once: a run with no update for two hours becomes
`timed_out` (`run.finished`; a run `waiting` on a person is skipped while a
question naming it is open, and waiting with none gets seven days), an open question past `expires_at` becomes
`expired` (`question.expired`), and an agent whose heartbeat went quiet goes
offline (`agent.offline`, then `agent.online` when it reports again). Each
sends its event once, never again on the next run.

One save is one event: every change to a task in one transaction folds into one
`task.updated` (its `changes` lists them all), and a task created with its
assignees is one `task.created` that names them.

## Filters

Each endpoint has three filters, plus one for agent events and one for
assistant hosts. Empty means everything.

- **Events**: the types above.
- **Projects** (`project_ids`): only events on these projects. A task moved
  between projects reaches both projects' endpoints. An event with no project
  (a question asked on nothing) never matches a project list.
- **Member** (`member_id`): only events that **concern** that member. This is
  how an agent gets a webhook for its own work. An event concerns:
  - for a task event, a comment or a review: the task's assignees and the
    holder of a live claim on it, plus anyone the change took off the task (an
    assignee who was removed hears that they were);
  - for a question: the member asked (`asked_to`) or, for a question asked to a
    group, every member of that group; the asker (`asked_by`); and the person an
    agent asked it for (`principal_id`), when there is one;
  - for a suggestion: who proposed it and who it would be assigned to;
  - for a run: the agent whose run it is;
  - for `agent.offline`, `agent.online`, `agent.paused`, `agent.resumed` and
    `budget.exceeded`: the agent;
  - for an agent event: the agent that recorded it (a fleet alert names no
    agent, so an endpoint with a member filter never receives one);
  - for a chat message: the agent it is for. It goes only to an endpoint
    whose member filter is exactly that agent or whose assistant setup made
    it, never to one with neither or with a project filter (saving an
    endpoint that lists `chat.message` without an agent as its member or an
    assistant setup is refused, 422 `chat_message_needs_agent`; one that lists
    `assistant.message` without a personal agent, 422
    `assistant_message_needs_personal_agent`);
  - for an invoice: nobody, so an endpoint with a member filter never receives
    invoice events.

  The one definition is the database function `pm.webhook_event_members` (a
  run's is its agent, set by its trigger); every payload lists the result as
  `data.member_ids`. Writing a comment does not
  make the author concerned: an agent does not wake up for its own comment.
- **Agent event types** (`agent_event_types`): for `agent_event.created`, only
  these activity types (such as `work.done`, `usage.recorded`,
  `custom.acme.deploy`). Empty means every type.
- **Assistant setup** (`assistant_setup_id`, instead of `member_id`): only
  events that concern a personal agent that assistant setup made,
  `chat.message` and `assistant.message` included. This is how an assistant
  host serves thousands of people with one endpoint and one secret; each
  payload's `member_ids` (and `agent_id` on chat messages) say which assistant.
  A company agent's chat never reaches a setup scope.
  Only an Owner, or a key with `assistants.provision`, sets it (403
  `setup_scope_not_allowed` otherwise). Settings lists it as "All assistants:"
  and the setup. A setup an endpoint is scoped to cannot be deleted until the
  endpoint goes (409 `setup_has_webhooks`); turn the setup off instead.

## Where events may go

An endpoint's URL is HTTPS to a public address. Saving one refuses
`localhost`, cloud metadata names and literal private addresses. Each
delivery resolves the host once, refuses it when any address it resolves to
is private, loopback, link-local (169.254.169.254 included), carrier-grade NAT
(100.64.0.0/10), multicast, reserved, unspecified, or IPv6 unique local
(`fc00::/7`) or link-local, and then connects to that checked address, so a
name cannot point the check at one address and the connection at another.
A refused delivery is a failed attempt, retried with backoff like any other,
with the reason in its last error. Redirects are never followed: a `3xx` is a
failed attempt with its status recorded, so give the final URL.

On a host whose receivers live on its own private network, set
`WEBHOOKS_ALLOW_PRIVATE_TARGETS=true` to allow private addresses (and plain
http on localhost). Local development (`npm run dev`) allows them too.

## Retries and ordering

- Any non-`2xx` response (a redirect included), a refused target, or no
  response within 10s, is a failed attempt. The
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
- Retries are on by default. Once `APP_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL`
  (the app's address) and Supabase Vault are all there and the Webhooks module
  is on, the app turns them on by itself: the server makes the scheduler
  secret, saves it encrypted in the app, and writes it with the app's address
  to Supabase Vault as `pm_webhook_scheduler_secret` and
  `pm_webhook_scheduler_url`. The Webhook retries card in Settings >
  Developers says which is missing, and an Owner can turn them off there
  (**Turn off**; they stay off until an Owner turns them on again). While
  they are off, a failed delivery only goes out again on the next change or
  when someone presses "Send pending deliveries now" in the Webhooks section.
- An endpoint that fails 5 attempts in a row, or keeps failing for 24 hours,
  rings the bell once for the Owners and whoever manages webhooks ("Webhook
  {name} keeps failing", with the last error). A success resets it and
  clears that bell. Nothing is sent to the endpoint about it.
- Finished deliveries (sent or failed) are kept 30 days by default, then
  removed with their events once no delivery needs them. An Owner changes
  this in Settings > Security > Keeping data (Keep forever is a choice).
  Pending deliveries are never removed.
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
- `agent_event.created` events are each their own subject, so a slow
  endpoint never holds the rest back, and they are **not ordered**. Each
  carries the event's `seq`; for an ordered, complete record use the export
  (below).
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
  "data": { },
  "api_version": "2026-11-25"
}
```

- `api_version` is the contract's version (also the `X-PM-API-Version`
  header on every `/api/v1` answer and `api_version` on
  `GET /api/v1/mcp/tools`). It changes only on a breaking change; payloads
  only ever gain fields. Events stored before 2026-11-25 have none. See
  [Compatibility](docs/agents/README.md#compatibility).
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
and its `question` also carries `kind: "approval"`, `action: { type, summary, details?, external_url?, external_id? }`,
`decision` (`approved`, `rejected` or `null`), `decided_by` (who decided, or
`null`) and `decided_via` (how: `app`, `api_key`, `agent` or `act_for`; `null`
until decided, and on an approval decided before this was recorded). A plain
question carries none of these five.
A question asked to a group has `asked_to: null` and also carries
`asked_to_group` (the group's id; any member may answer, and `answered_by` says
who). A question an agent asked while acting for someone (the `X-Act-For`
header) also carries `principal_id`, the person it acted for. A question or
approval that holds one of the asker's runs (asked with `run_id`) carries
`run_id`: while it is open that run is `waiting`. Each is present only when
set, so a plain question's payload is unchanged.

**Suggestion events** add
`suggestion: { id, project_id, goal_id, proposed_by, assigned_to, title, description, reasoning, priority, effort_estimate, status, reviewed_by, reviewed_at, rejection_reason, info_request, converted_task_id, bundle_key, created_at, updated_at }`.
The task an approval makes arrives as its own `task.created`, which names the
suggestion in `source_task_suggestion_id`.

**Run events** (`run.started`, `run.updated`, `run.finished`) add
`run: { id, agent_id, task_id, project_id, status, title, summary, model, trigger, tokens_in, tokens_out, cost_usd, external_id, external_url, started_at, finished_at, updated_at }`.
`status` is `running`, `waiting` (on a person, `run.updated` only), `succeeded`,
`failed`, `cancelled` or `timed_out`.
`tokens_in`, `tokens_out` and `cost_usd` (US dollars) are the run's own totals
as its harness reported them, `null` when it did not. `external_id` is the
harness's own run id and `external_url` its trace link. A run started with
`parent_run_id` (a specialist's run on work another run handed it) also carries
`parent_run_id` and `root_run_id` (the first run of its chain); any other run
leaves both out, so its payload is unchanged.

**Agent events** (`agent.offline`, `agent.online`) add
`agent: { id, name, reported_at, expected_interval_seconds, stale_after_seconds }`
(its last report, how often it promised to report, and the silence that made
it offline) and `offline_since` (its last report before it went quiet).
`agent.offline` also carries `released_task_ids`: tasks whose claim ran out
while it was silent, free for others again. Both have `project_id`,
`task_id`, `project` and `actor_id` set to `null`, so an endpoint with a
project filter never receives them.

**Pause events** (`agent.paused`, `agent.resumed`) add `agent: { id, name }`,
`paused` (true on `agent.paused`), `reason` (`agent_paused` for the agent's own
pause, `agents_paused` for the workspace pause; on `agent.resumed`, the pause
that ended), `agent_paused_at` and `workspace_paused_at` (when each pause began,
`null` when it is not on). `project_id`, `task_id`, `project` are `null`;
`actor_id` is who paused or resumed it.

**`budget.exceeded`** adds `agent: { id, name }` and
`budget: { period, period_start, budget_usd, budget_tokens, spent_usd, spent_tokens }`:
the period (`day`, `week` or `month`, UTC), when it began, the caps (`null` for
none) and the spend at that moment, counted as the budget counts it. New runs
are refused until the period resets or an Owner raises the budget. `project_id`,
`task_id` and `project` are `null`; `actor_id` is whose request found it spent.

**Template events** (`template.run`) add
`run: { id, template_id, template_version, template_name, project_id, run_by, via, schedule_id, start_date, field_values, task_ids, created_at }`,
plus `project` and `project_id`. `via` is `app`, `api`, `mcp` or `schedule`;
`task_ids` lists every task the use made, subtasks included, in the order they
were made. It concerns who ran it and everyone its tasks were assigned to, so an
endpoint filtered to an agent hears about a playbook that gives it work.

**`agent_event.created`** carries
`agent_event: { id, seq, source, occurred_at, agent_id, type, labels, title, payload, project_id, task_id, run_id, principal_id }`,
plus `project_id`, `task_id` and `member_ids` (the agent). `agent_event` has the
same shape as a row of the export: `source` is `activity`, `type` the activity
type, `payload` the event's validated payload, `labels` the labels the agent or
its harness set (an empty list when none), `run_id` the run a turn belongs to,
and `principal_id` the person the agent acted for. Only a new event sends one;
a later change (labels edited, a turn labelled late) shows in the export.

**`chat.message`** never carries chat text: chat is private, so the agent
reads the text with its own key. Its `data` holds:

| Field | Meaning |
| --- | --- |
| `message` | `{ id, created_at, provider, connection_id, connection_kind, conversation_id, thread_id, external_message_id, external_user_id }`: the message's id, when it arrived, the chat provider (`slack`, `telegram`, `discord`), the app's chat connection and its kind, the provider's conversation and thread (`null` without one), the provider's own message id and the sender's provider id. |
| `agent_id` | The agent it is for. |
| `connection_kind` | `personal` (the personal bot: DMs to a person's own assistant) or `company` (the company bot: channels and DMs to company agents). |
| `is_request` | `true`: someone asked, answer it. `false`: context, a channel message recorded because the channel listens to everything; never answer it, and there is no `reply`. |
| `route` | How a company message reached the agent: `direct` (a DM, to the default agent), `mention` (the agent named with @), `channel` (the channel mapped to it) or `default` (the bot mentioned in an unmapped channel) or `reply` (an answer to a message the agent started). `null` for personal messages. |
| `channel` | `{ id, name, direct, mapped_agent_id, listen }`: where it was said, whether that is a DM with the bot, and the channel's mapping (`listen` is `mentions` or `all`). |
| `thread` | `{ id, message_ids }`: the thread it is in (`null` at the top of a channel) and the ids of the thread so far, oldest first: up to the 10 latest earlier messages there for this agent and its answers. |
| `person` | `{ id, name }`: who wrote it, or `null` for a stranger (unlinked) in a listening channel. |
| `has_attachments` | Whether files came with it (photos, voice notes, documents). A message with only a file is a request like any other. |
| `attachment_count` | How many. Read their kinds, names and download paths with the message (`attachments`), and fetch each through `GET /api/v1/chat/messages/{id}/attachments/{n}`: never a provider address. |
| `in_reply_to` | The id of the message this agent started (`POST /api/v1/chat/messages`) that this one answers, or `null`. |
| `act_for` | A company request from a linked person: `{ method: "POST", path: "/api/v1/delegations", body: { provider, external_id, workspace_id } }`. Mint a pass with it and send it as `X-Act-For` on the work and the reply: the agent acts for the sender, never with more than both may. `null` otherwise (a personal agent already acts for its person). |
| `read` | `{ "method": "GET", "path": "/api/v1/chat/messages/{id}" }`: where the text is. |
| `reply` | `{ "method": "POST", "path": "/api/v1/chat/messages/{id}/reply" }`, or `null` for context. |
| `member_ids` | The agent, as for every event. |

It has no `project_id`, `task_id`, `project` or `actor_id`. A retry of the
same chat message from its provider never sends a second event, and Slack's
two events for one channel mention (`message` and `app_mention`) record it once.

A message an agent starts (`POST /api/v1/chat/messages`) sends no event: the
agent made it and has the answer. It is recorded as a started message, and a
reply to it reaches the agent as `chat.message`.

**`assistant.message`** (deprecated: use `chat.message`) is what a personal
assistant got before, unchanged. It never carries chat text either. Its
`data` holds:

| Field | Meaning |
| --- | --- |
| `message` | `{ id, created_at, provider, connection_id, conversation_id, thread_id }`: the message's id, when it arrived, the chat provider (`slack`, `telegram`, `discord`), the app's chat connection, and the provider's conversation and thread (`null` without a thread). |
| `person` | `{ id, name }`: the person who wrote it, the assistant's own person. |
| `agent_id` | The personal agent it is for. |
| `thread_ids` | The ids of the thread so far, oldest first: up to the 10 latest earlier messages in the same conversation and thread, theirs and the assistant's answers to them. |
| `read` | `{ "method": "GET", "path": "/api/v1/assistant/messages/{id}" }`: where the text is. |
| `reply` | `{ "method": "POST", "path": "/api/v1/assistant/messages/{id}/reply" }`: where to answer. |
| `member_ids` | The agent, as for every event. |

It has no `project_id`, `task_id`, `project` or `actor_id`. A retry of the
same chat message from its provider never sends a second event.

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

## Piping every agent event to a data system

Everything the agents do is recorded as agent events (`agent_activities`) and
runs (`agent_runs`). To keep a complete copy in a warehouse or log pipeline:

1. Make an API key for the data system with the `agent_events.export` scope
   (Settings > Developers; no role holds it by default, so give it to the key's
   member as an API permission). A member without `projects.read_all` exports
   only events and runs on its projects.
2. Page `GET /api/v1/agent-events/export?limit=1000` and store each row by
   `id`. Each page answers `meta.next_cursor` and `meta.has_more`.
3. Save `next_cursor` after each page and pass it as `since_cursor` next time.
   Poll every minute or so, or right after an `agent_event.created` webhook.

Rows come in the order they changed. A row that changes again (labels edited,
a turn labelled late, a run updated or finished) comes again with its new
state, so load by `id` and let the newest win. Rows written in a transaction
still open wait until it ends, so a resumed export never skips a row that
committed late and never repeats one that has not changed. `types` (such as
`usage.recorded,turn.completed,run`; `run` for runs) and `agents` (member ids)
narrow it. Cursors are tied to the database's transaction ids: after a
pg_dump and restore into a new cluster, re-export from the start (no
`since_cursor`) and load by `id`. Each row: `id`, `seq`, `source` (`activity` or `run`),
`occurred_at`, `agent_id`, `type`, `labels`, `title`, `payload` (for a run:
its status, summary, model, provider, trigger, tokens, cost, plan, notes,
metadata and times), `project_id`, `task_id`, `run_id`, `principal_id`.
