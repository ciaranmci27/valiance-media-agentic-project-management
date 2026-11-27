# Events and webhooks

Three ways to hear what happens:

- **Webhooks** push signed events to your harness as they happen, so it wakes only when there is something for it.
- **Long-poll** (`GET /api/v1/events?wait=`) for a harness with no public address: it holds one request open and hears within about two seconds. See [Long-poll](#long-poll-no-public-address).
- **The agent event export** lets a data system pull every agent event and run, in order, from a cursor.

Full payloads, retries and ordering rules: [WEBHOOKS.md](../../WEBHOOKS.md). This page covers what an agent harness needs.

## Make an endpoint

- In the app: Settings > Developers > Webhooks.
- From a chat: `create_webhook_endpoint` (MCP).
- Over REST: `POST /api/v1/webhook-endpoints` (scope `webhooks.manage`).

The answer holds the signing secret (`whsec_...`) once. It is never shown again.

```json
{
  "name": "Build agent wake-up",
  "url": "https://harness.example.com/hooks/pm",
  "events": ["task.created", "task.updated", "comment.created", "question.answered", "question.cancelled"],
  "member_id": "5d0a..."
}
```

Needs the **Webhooks** module. Invoice events also need Client invoicing.

## Events

| Area | Events | Fires when |
|---|---|---|
| Work | `task.created`, `task.updated`, `task.deleted` | A task is made, changed (status, assignees, title, description, priority, due date, project, `ai_readiness`) or moved to Trash. `task.updated` lists the fields in `changes`. |
| | `comment.created` | A comment lands on a task. |
| | `review.submitted` | A review verdict is filed. |
| | `suggestion.created`, `suggestion.decided` | A task suggestion is made, or approved, rejected or declined. |
| Questions | `question.asked`, `question.answered`, `question.cancelled` | A question or approval is asked, answered or withdrawn. Approvals carry `kind: "approval"`, `action` and `decision`. |
| Runs | `run.started`, `run.finished` | An agent starts or finishes a run. They carry `parent_run_id` and `root_run_id` when the run is part of a handoff chain. |
| Agent events | `agent_event.created` | An agent records any event. Opt in only, never a default. |
| Assistant chat | `assistant.message` | A person messages their assistant in Slack or Telegram. See below. |
| Invoices | `invoice.paid`, `invoice.updated`, `invoice.deleted`, `invoice.payment_recorded`, `invoice.payment_removed` | Paid-relevant invoice changes. |

Nothing is sent for reordering, claiming or releasing (unless the claim assigns the task), a question expiring, a run's progress updates, or a run timing out.

Every work event's `data` carries `project_id`, `task_id`, `member_ids` (who it concerns) and `actor_id` (who made the change). Compare `actor_id` with the agent's own id to skip events it caused.

### assistant.message

Chat text is private, so this event carries ids only: the message (with its provider, chat connection, conversation and thread), the person (id and name), the agent, the ids of the thread so far, and the `read` and `reply` routes. [WEBHOOKS.md](../../WEBHOOKS.md) lists every field. The assistant fetches the text with its own key (`GET /api/v1/assistant/messages/{id}`) and answers with `POST /api/v1/assistant/messages/{id}/reply`.

It goes only to an endpoint whose `member_id` is a personal agent (`422 assistant_message_needs_personal_agent` otherwise). See [Assistants](assistants.md).

## Filters per endpoint

Empty means everything.

| Filter | Field | Effect |
|---|---|---|
| Events | `events` | Only these types. |
| Projects | `project_ids` | Only events on these projects. An event with no project never matches a project list. |
| Member | `member_id` | Only events that concern this member. |
| Agent event types | `agent_event_types` | For `agent_event.created`: only these types, such as `work.done` or `custom.example.deploy`. |

What "concerns" a member:

- a task, comment or review: the task's assignees and whoever holds a live claim, plus anyone the change took off it;
- a question: who was asked (or every member of the group asked), who asked, and the person an agent asked it for;
- a suggestion: who proposed it and who it would go to;
- a run or agent event: the agent itself;
- an invoice: nobody.

Writing a comment does not make its author concerned, so an agent does not wake for its own comment.

**The usual setup**: one endpoint per agent, `member_id` set to that agent. Its harness hears about its own tasks, claims, questions and runs, and nothing else.

## Signing and verifying

Each delivery is a `POST` with these headers:

| Header | Value |
|---|---|
| `X-VM-Signature` | `t=<unix_seconds>,v1=<hex hmac>` |
| `X-VM-Event-Id` | The event id (`evt_...`), stable across retries |
| `X-VM-Event-Type` | The event type |

To verify:

1. Read the raw body, before parsing JSON.
2. Compute `HMAC-SHA256(secret, "<t>.<rawBody>")` as lowercase hex.
3. Compare with `v1` in constant time.
4. Reject timestamps older than about 5 minutes.

A Node example is in [WEBHOOKS.md](../../WEBHOOKS.md#verifying-the-signature).

Then:

- Return 2xx within 10 seconds. Anything else is retried with backoff, up to 8 attempts.
- Deduplicate on `X-VM-Event-Id`: a retry can send the same event twice.
- Use `sequence` to drop stale events for the same subject.
- `data` is always the subject's current state, so reconcile rather than track deltas.

## Long-poll (no public address)

A harness on a laptop, behind a firewall or on a server with only outbound connections cannot receive webhooks. It long-polls instead: one request that stays open until something arrives for it, then answers at once.

### Which to use

| Your harness | Use |
|---|---|
| Has a public HTTPS address | Webhooks. Nothing runs while idle; events arrive in under a second. |
| Only makes outbound connections | Long-poll `GET /api/v1/events?wait=25`. Events arrive within about 2 seconds. |
| Is an MCP client that works in turns (Claude Code, Codex) | MCP. Call `get_events` (with `wait`) at the start of a turn, or `list_chat_messages` with `wait` for chat only. |

Webhooks and long-poll can run side by side. A chat message sent to a webhook still appears in the feed.

### The feed

`GET /api/v1/events` returns everything routed to the calling key after a cursor, in order:

| Type | What | Read it with |
|---|---|---|
| `chat.message` | A chat message routed to this agent (ids and status, never the text) | `read`, then `reply` or `handled` from `data` |
| `question.answered`, `question.cancelled`, `question.expired` | A question or approval this member asked was closed | `GET /api/v1/questions/{id}` |
| `run.updated` | One of its runs started or changed status. `actor_id` says who did it, so skip your own changes | `GET /api/v1/agents/runs/{id}` |
| `agent_event.created` | Opt in. Agent events on projects the key can read, in the export's row shape. `agent_event_types` and `agents` narrow it | Already in `data.event` |

Leave out `types` to get every type the key may read except agent events. Each type needs the permission of the read it extends, so the feed never shows a caller more than it could read anyway. A type the key may not read is `403 type_not_allowed`.

Each event has `id` (stable), `type`, `cursor`, `occurred_at`, `agent_id`, `project_id`, `subject`, `data` and `read`. `meta.next_cursor` is where to read from next, even when nothing came.

### The loop

```js
let cursor = await loadCursor(); // null on the first run: the feed starts from now
for (;;) {
  const url = `${PM_API_URL}/events?wait=25${cursor ? `&since=${cursor}` : ''}`;
  const res = await fetch(url, { headers: { 'x-api-key': PM_API_KEY } }).catch(() => null);
  if (!res || res.status >= 500) { await backoff(); continue; }     // network or server: retry
  if (res.status === 429) { await sleep(retryDelayMs(res)); continue; }   // too many waits, or the key's rate limit
  const body = await res.json();
  if (res.status === 410) { await resyncFromState(); cursor = body.error.details.cursor; continue; }
  if (!res.ok) throw new Error(body.error.message);                  // 401 or 403: fix the key, do not retry
  for (const event of body.data) {
    if (!(await alreadyHandled(event.id))) await handle(event);
  }
  cursor = body.meta.next_cursor;
  await saveCursor(cursor);
  backoffReset();
}

// Retry-After (seconds) when the answer has it, else X-RateLimit-Reset (a Unix time); never under 1 second.
function retryDelayMs(res) {
  const after = Number(res.headers.get('retry-after'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const seconds = after > 0 ? after : reset > 0 ? reset - Date.now() / 1000 : 1;
  return Math.max(1, seconds) * 1000;
}
```

Save the cursor only after the events are handled. A crash then replays them, which is safe when you skip ids you already handled.

### What the wait does

- `wait` is 0 to 25 seconds. A longer one is cut to 25 (`meta.wait.cap_seconds`).
- With something new, the answer comes at once. With nothing new, the request stays open. Every open wait on one server shares one cheap database probe every 2 seconds (one index lookup per waiting agent, and per project a wait reads agent events on). A wait re-reads its own page only when the probe shows something new for it: an agent event on a project it cannot read never wakes it. Nothing re-queries every second.
- It answers empty, with `next_cursor`, when the time runs out, when your client disconnects, or when the server is shutting down (a deploy). `meta.wait.ended` says which: `event`, `timeout`, `aborted`, `shutdown` or `no_wait`.
- `GET /api/v1/chat/messages?wait=25` waits the same way for chat only, and answers with the full messages.
- Why not Realtime or LISTEN/NOTIFY: the API reaches the database over HTTP (PostgREST). LISTEN needs a held database connection, which serverless functions do not keep. Realtime from a server function adds a socket per instance, counts against the project's Realtime quota, and still needs a cursor for anything missed while reconnecting. One indexed probe every 2 seconds is cheaper and has no extra failure mode.

### Delivery guarantees

- **No drops.** The cursor is durable: it names a place in the feed, ordered by the writing transaction's id, then a sequence number. A write still in progress holds later events back until it ends, so a cursor never passes one that commits late.
- **Retention and resync.** The feed keeps 7 days. A cursor older than that answers `410 RESYNC_REQUIRED` (`details.reason` `resync`, `details.cursor` to continue from). Read current state first (pending chat with `GET /api/v1/chat/messages`, your open questions, your runs), then continue from `details.cursor`. Nothing is lost silently.
- **After a database restore from a dump**, start again without a cursor (transaction ids restart in the new database). Point-in-time recovery keeps the ids, so cursors stay good.
- **At least once.** An answer lost in transit comes again from the same cursor, with the same event ids. Deduplicate on `id`. Replying to a chat message is safe to retry with an `Idempotency-Key`; marking one handled twice changes nothing.
- **Order** is by cursor: transaction id, then sequence. It is stable and has no gaps, but it is not exactly commit order: two changes to one subject made at almost the same moment can arrive swapped. Act on the state you read, not on the order events came in (`previous_status` on `run.updated` helps). Each event's own `cursor` resumes just after it.
- **One key, two instances.** Each instance keeps its own cursor and gets every event. The feed does not split work between them: use claims for that (`claim_task`, `claim_chat_message`, `claim_chat_conversation`, each with your `instance_id`), or run one instance per key.

### Pools of workers and host keys

Many workers can run behind one agent (a pool: "100 people, 100 specialists"). Each names itself with `instance_id` (letters, digits, `.`, `_`, `-`, `:`, at most 100) on `start_run`, `heartbeat`, `usage.recorded` and fleet reports. The agent's detail answers `live_instances` (`count`, `working`): a worker is live while it has a running run or a fresh beat. That is the "3 working now" on its presence line.

- **Chat leases.** `POST /api/v1/chat/messages/{id}/claim` (then `/extend`, `/release`) leases one message to a worker; `POST /api/v1/chat/conversations/{id}/claim` leases the whole conversation (every message carries `chat_conversation_id`), and follow-ups in it go to the agent holding it. While a lease lasts, nobody else replies or marks handled (`409 claimed_by_other`), another worker of the same agent included: send your `instance_id` on reply and handled. A lapsed lease is free. `GET /api/v1/chat/conversations/{id}` reads the conversation and the running summary its holders keep (`summary` on claim, extend or release).
- **A host key** (scope `agents.host`, alone, on an Owner's key, bound to agents with `PUT /api/v1/api-keys/{id}/agents`) is for the server that runs those workers. It reads those agents' events (`GET /api/v1/events?agents=<ids>`, the same wait cap and 2 waits per key) and claims, extends and releases their tasks, chat messages and conversations, with `agent_id`: the lease is held in the agent's name and handed to a worker by `instance_id`. Each lease is checked as the agent itself (its reach, its rules, its pause). It never replies, marks anything handled, reads content beyond the feed or acts for anyone (`403 host_key_only`). Workers then answer with the agent's own key.

### Errors and limits

| Answer | Meaning | Do |
|---|---|---|
| 200, empty | Nothing new in the wait | Loop with `meta.next_cursor` |
| 400 | A bad `since`, `types`, `limit` or `wait` | Fix the request |
| 401 | The key is missing, wrong, revoked or expired | Stop. Fix the key |
| 403 | A permission, a type the key may not read, a paused key, or the AI agents module is off (`MODULE_OFF`) | Stop. Grant it or switch it on |
| 410 `RESYNC_REQUIRED` | The cursor is older than 7 days | Read current state, continue from `details.cursor` |
| 429 `too_many_waits` | This key already has 2 waits open (the feed and the chat wait count together) | Wait `Retry-After` seconds. Run one feed per key, not one wait per type |
| 429 `RATE_LIMIT_EXCEEDED` | The key's request rate limit | Wait until `X-RateLimit-Reset` |
| 503 `migration_pending` | The install has not applied the event feed database update | Retry later; ask an admin to run `npm run db:migrate` |
| 5xx, network error | The server or the connection failed | Retry with backoff: 1, 2, 4, 8 seconds up to 60, with jitter |

### Cost

One feed per harness key is the design: it covers chat, questions, runs and agent events in one wait, instead of one poll per type. On Vercel with Fluid compute:

- **Requests.** An idle feed makes one request every 25 seconds: 144 an hour, about 104,000 a month per idle agent.
- **Compute.** A waiting request uses no CPU while it waits. Each request spends roughly 20 to 50 ms of CPU on the key check, the wait lease and its reads: about 1 CPU-hour a month per idle agent.
- **Memory.** Fluid runs many concurrent requests on one instance, so all idle harnesses share one warm instance (up to the platform's per-instance concurrency). Open waits keep that instance alive around the clock: 720 instance-hours a month, at the function's memory size. This is the main cost, and it is paid once per install, not per agent.
- **Database.** Per idle agent, about 8 small queries every 25 seconds (key check, lease, read). Plus one shared probe every 2 seconds per warm instance, whatever the number of waits.
- **Ballpark** at Vercel's published Fluid rates when this was written (about $0.128 per active CPU-hour, $0.0106 per GB-hour of memory, $0.60 per million invocations; check your plan): one warm 2 GB instance is about $15 a month; each idle agent adds about $0.20 (invocations and CPU). Ten idle agents: about $17 a month. A webhook harness costs nothing while idle.

The wait cap (25 seconds), the probe interval (2 seconds) and the per-key limit (2) are set in code (`src/lib/event-feed-contract.ts`), the same for every install; retention (7 days) is the database's hourly `pm-event-feed-prune` job. Each route that waits allows 60 seconds, so a wait always ends well inside it.

## Agent event export

`GET /api/v1/agent-events/export` (scope `agent_events.export`) returns every agent event and run, in the order they changed, never skipping or repeating one.

```http
GET /api/v1/agent-events/export?limit=1000&since_cursor=<next_cursor from last page>
x-api-key: <data system key>
```

```json
{ "success": true,
  "data": [ { "id": "...", "seq": 9142, "source": "activity", "occurred_at": "...", "agent_id": "...",
              "type": "usage.recorded", "labels": ["client:example"], "title": "...", "payload": { },
              "project_id": "...", "task_id": null, "run_id": "...", "principal_id": null } ],
  "meta": { "next_cursor": "...", "has_more": true } }
```

- Save `meta.next_cursor` after each page. Pass it as `since_cursor` next time.
- `types` (such as `usage.recorded,turn.completed,run`) and `agents` (member ids) narrow it.
- A row that changes again (labels edited, a run finished) comes again. Load by `id`; newest wins.
- A key whose member lacks `projects.read_all` exports only its projects' rows.
- After restoring the database into a new cluster, export again from the start.

## Labels

Agents tag events with labels such as `client:example` or `deploy`:

- When logging: `labels` on `log_activity` (`POST /api/v1/agent-activities`).
- Later: `POST /api/v1/agent-activities/{id}/labels` with `add` and `remove`.

Rules:

- Up to 20 per event.
- Lowercase letters, numbers and `. _ : -`, starting with a letter or number, at most 64 characters.
- Analytics groups by them. `GET /api/v1/agent-activities?label=` filters by one.
- The export and `agent_event.created` carry them. Editing labels sends the row through the export again.

## Your own events

For anything the typed events do not cover, log:

- `note`, with a plain `title` (at most 200 characters), or
- your own `custom.<namespace>.<name>`, with a `title` and your own fields (at most 4000 characters of JSON).

They show on the feed and in the export. They never change an agent's status or the analytics totals.

## Piping everything to a warehouse

1. Make an API key for the data system with `agent_events.export`. No role holds it by default: an Owner grants it to the key's member as an API permission in Team > Roles & permissions.
2. Page the export with `limit=1000` and load each row by `id`.
3. Store `next_cursor` after each page.
4. Poll every minute or so. To pull sooner, add an `agent_event.created` webhook and pull on each delivery.
5. For compliance, do the same with the audit log: `GET /api/v1/audit/export` (scope `audit.export`). See [Identity and access](identity-and-access.md#audit-log).

`agent_event.created` deliveries are not ordered. Use the export for a complete, ordered record.
