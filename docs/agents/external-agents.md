# External agents

An agent that works in another system, overseen from here. A bookkeeper agent works in your accounting app; this app gives it an identity, watches its health, counts its spend, can pause it, holds its approvals and lets you chat with it. It has no projects and no task queue here.

## When to use it

Use it when the agent's work lives somewhere else (an accounting app, a CRM, a warehouse system) and you want one place to see and control your agents. If the agent works tasks and projects in this app, use another template (Builder, Data health watcher).

## Set it up

1. An Owner turns on the **AI agents** module (Settings > Workspace > Features). For webhooks, turn on **Webhooks** too.
2. **Agents**, then **Hire an agent** (`/agent/new`), and pick **External agent**. Or, from an Owner's MCP client, `create_agent` and `apply_agent_template` with `template: "external-agent"` and `create_key: true`.
3. Leave projects empty. It needs none.
4. Its key carries:

| Scope | For |
|---|---|
| `agent_activity.write` | Heartbeats, runs, usage and other agent events |
| `questions.ask` | Questions and approvals that name no task or project |

   Reading its own status and its context pack needs no scope of its own: every key may.
5. Put the key in the host's environment as `PM_API_KEY` and connect it ([Bring your own agent](README.md), step 2).
6. Set a budget and a rate limit on its profile (Rules and powers) if you want them. Spend counts from the first run or usage report.

Optional: a webhook endpoint filtered to the agent (`member_id`), subscribed to `agent.paused`, `agent.resumed`, `budget.exceeded`, `question.answered` and `question.cancelled`, so its host hears at once instead of at the next check.

## Check before each turn

Pause and budget refuse calls into this app. Work the agent does in its own system never calls here, so it must ask first.

Before each turn, call `GET /api/v1/agents/me/status` (MCP `get_my_status`):

```json
{ "success": true, "data": {
  "member_id": "5d0a...", "agent": true,
  "can_start_work": false, "skip_reason": "budget_exceeded",
  "paused": false, "paused_reason": null, "paused_at": null,
  "workspace_paused_at": null, "agent_paused_at": null,
  "budget": { "period": "month", "period_start": "2026-11-01T00:00:00.000Z", "resets_at": "2026-12-01T00:00:00.000Z",
    "spent_usd": 104.2, "spent_tokens": 3120000, "budget_usd": 100, "budget_tokens": null, "exceeded": true },
  "limits": { "max_concurrent_runs": 2, "rate_per_minute": 60, "budget_usd": 100, "budget_tokens": null, "budget_period": "month" },
  "checked_at": "2026-11-25T14:02:11.000Z" } }
```

The contract:

- `can_start_work` false: skip the turn. Check again on the next one.
- `skip_reason` says why: `agents_paused` (an Owner paused every agent), `agent_paused` (this agent), `budget_exceeded` (its budget for the period is spent).
- A network error or a 5xx: go ahead. The check fails open, so an outage here never stops your books.
- A 401 or 403: the key is revoked, expired or the member suspended. Stop and tell a person.
- It is one database read and never cached, so calling it every turn is fine. It counts toward the rate limit like any call.
- A pause on one project is left out: it stops work on that project here, not the agent.

With webhooks, `agent.paused` and `agent.resumed` arrive once per change of whether the agent may start work, and `budget.exceeded` once per period. Treat them as a nudge; the status check is the truth.

## Report runs and usage

Record each piece of work as a run, so it shows in Analytics and counts toward the budget:

1. `start_run` (`POST /api/v1/agents/runs`) with no `task_id`, an `external_id` (your own id for the job, so a retry returns the same run) and an `external_url` (where a person sees it in your system).
2. `update_run` with `tokens_in`, `tokens_out` and `cost_usd` as totals so far.
3. `finish_run` with `succeeded` or `failed` and a `summary`.

Usage with no run counts too: send `usage.recorded` (`log_activity`, or `POST /api/v1/agent-activities`) for model calls outside any run, and it adds to the period's spend. Usage that names a run (`run_id`) is part of that run and never adds twice ([How spend is counted](work-loop.md#how-spend-is-counted)).

A paused agent may still finish or update a run it started and report usage, so it winds down cleanly.

## Ask for approvals

Before an action a person must allow (paying a bill, emailing a client, deleting records), request an approval that links to the object in your system:

```json
{
  "action": {
    "type": "pay_bill",
    "summary": "Pay Acme Supplies $4,180.00 from Operating",
    "details": { "due": "2026-11-30", "account": "Operating" },
    "external_url": "https://books.example.com/bills/8812",
    "external_id": "bill_8812"
  }
}
```

- `POST /api/v1/approvals` (MCP `request_approval`). Leave out `task_id` and `project_id`: `questions.ask` covers approvals and questions that name neither. Naming one needs `tasks.read` (`403 place_needs_tasks_read`).
- `external_url` must be `https` (up to 2,000 characters); any other scheme is refused. `external_id` is your id for the object (up to 200 characters).
- The person sees **Open in books.example.com** on the request and decides there.
- Act only when `decision` is `approved`. Poll `get_approval`, or hear `question.answered`.
- Questions work the same way: `ask_human` with no task or project.
- With `questions.ask` alone, the agent reads and withdraws only its own questions and approvals that name no task or project.

## Health

- `heartbeat` when a turn starts (`working: true`) and ends (`false`), with `expected_interval_seconds` set to how often it runs. It shows offline after two missed beats plus a minute, and its owners are told once (`agent.offline`, then `agent.online`).
- A run with no update for two hours is stored as timed out. Update long jobs at least that often.
- Its profile shows its runs, spend, health and anything waiting on a person, like any agent.
