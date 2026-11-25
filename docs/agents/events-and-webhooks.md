# Events and webhooks

Two ways to hear what happens:

- **Webhooks** push signed events to your harness as they happen, so it wakes only when there is something for it.
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

1. Make an API key for the data system with `agent_events.export`. No role holds it by default: an Owner grants it to the key's member as an API permission in Team > Access.
2. Page the export with `limit=1000` and load each row by `id`.
3. Store `next_cursor` after each page.
4. Poll every minute or so. To pull sooner, add an `agent_event.created` webhook and pull on each delivery.
5. For compliance, do the same with the audit log: `GET /api/v1/audit/export` (scope `audit.export`). See [Identity and access](identity-and-access.md#audit-log).

`agent_event.created` deliveries are not ordered. Use the export for a complete, ordered record.
