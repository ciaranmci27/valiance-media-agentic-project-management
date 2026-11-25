# The work loop

How an agent finds work, does it and hands it back. Each step names the MCP tool and the REST route it calls. Examples are trimmed to the fields that matter.

Answers over REST look like this:

```json
{ "success": true, "data": { } }
{ "success": false, "error": { "code": "CONFLICT", "message": "...", "details": { "reason": "claimed_by_other" } } }
```

Over MCP, a refusal reads `{ ok: false, status, error: { code, message, reason?, hint? } }`. Fix the call; never repeat it unchanged.

## 1. Find work

`next_task` (`GET /api/v1/tasks/next`) returns the best task for the key's member, or `null`.

- Assigned work comes first.
- Then unassigned work the agent may pick up: only `ai_ready` tasks, and only while its rules allow self-assign.
- It skips backlog, in review, done, blocked and claimed tasks, and projects that are not active.
- Order: priority, then due date, then oldest.
- `?project_id=` narrows it to one project.

It does not claim the task.

## 2. Claim it

`claim_task` (`POST /api/v1/tasks/{id}/claim`) takes a lease: "I am working on this".

```http
POST /api/v1/tasks/7c1e.../claim
x-api-key: <key>

{ "lease_minutes": 60 }
```

```json
{ "success": true, "data": { "id": "7c1e...", "title": "Fix the checkout total",
  "claim": { "member_id": "5d0a...", "member_name": "Build agent", "claimed_at": "...", "expires_at": "..." },
  "renewed": false } }
```

- Default 30 minutes, up to 240.
- `extend_claim` (`POST /api/v1/tasks/{id}/claim/extend`) renews it. Send it well before it runs out.
- `release_task` (`DELETE /api/v1/tasks/{id}/claim`) lets go without finishing.
- Claiming unassigned work assigns it to you. If the lease runs out, the task goes back to the pool.
- Setting the task to done ends the claim and keeps you assigned.

A `409` with reason `claimed_by_other` names who holds it and until when. Pick another task.

```json
{ "success": false, "error": { "code": "CONFLICT",
  "message": "Ana is working on this task until 2026-11-24T16:41:28Z. Pick another task, or try again after that.",
  "details": { "reason": "claimed_by_other", "claimed_by": "9f2b...", "claimed_by_name": "Ana", "expires_at": "2026-11-24T16:41:28Z" } } }
```

Other refusals: `403 self_assign_off`, `403 not_ai_ready`, `403 assigned_to_others`, `409 task_done`.

## 3. Read the brief

`get_task_brief` (`GET /api/v1/tasks/{id}/brief`) is everything needed to start, in one bounded answer:

- the task, its acceptance criteria, subtasks and blockers;
- the project, its pinned brief entries and context;
- the newest 10 comments, files and links;
- any open question, the claim and the latest run;
- the caller's own rules (`self_assign`, `close_policy`, `create_policy`, `escalate_to`);
- `delegated_from`, when another agent handed this task over;
- `omitted` and `cut_to_fit`, saying what was left out and why.

Read it before planning. Reach for `get_task` or `list_task_comments` only for what the brief cut.

## 4. Record the run

A run is one piece of work, start to finish.

`start_run` (`POST /api/v1/agents/runs`):

```json
{
  "task_id": "7c1e...",
  "title": "Fix EU rounding in the checkout total",
  "trigger": "assigned",
  "external_id": "langgraph-run-4821",
  "external_url": "https://traces.example.com/runs/4821",
  "model": "your-model",
  "provider": "anthropic",
  "plan": [{ "title": "Reproduce", "status": "running" }, { "title": "Fix and test", "status": "pending" }]
}
```

- `external_id` is your harness's own run id. Starting again with it returns the same run (200), never a second one.
- `update_run` (`PATCH /api/v1/agents/runs/{id}`): a new `plan`, a progress `note`, and `tokens_in`, `tokens_out`, `cost_usd` as totals so far (so a retry is safe).
- `finish_run` (`POST /api/v1/agents/runs/{id}/finish`): `status` `succeeded` (default), `failed`, `cancelled` or `timed_out`, plus a `summary`. A finished run's status cannot change (`409 run_finished`).
- A run with no update for two hours reads as `timed_out`. On long work, update at least that often.
- `list_runs` and `get_run` read them back. Webhooks: `run.started`, `run.finished`.

### Parent runs and handoff

- `delegate_task` (`POST /api/v1/tasks/{id}/delegate`) hands part of a task to a specialist agent as a subtask assigned to it. Pass your `run_id`. Needs `tasks.manage_all`. Your own create rules apply (approval gives a suggestion, answered 202). Core never picks the specialist.
- The specialist sees `delegated_from` in its brief and starts its run with `parent_run_id` set to that run.
- The whole chain shares one root and one person it is for. A child run for someone else is refused (`403 principal_mismatch`).
- `get_run_tree` (`GET /api/v1/agents/runs/{id}/tree`) shows the chain from any run in it.

## 5. Ask a person

### Questions

`ask_human` (`POST /api/v1/questions`):

```json
{
  "task_id": "7c1e...",
  "question": "EU totals round per line or per invoice? Finance has asked for both before.",
  "choices": ["Per line", "Per invoice"],
  "allow_other": true
}
```

- `asked_to` defaults to the agent's escalation target, then its owners, else the Owner.
- `asked_to_group` asks a group: every member's bell rings, any member answers.
- `expires_at` sets a deadline. After it, the question reads as expired.
- `cancel_question` withdraws it.

### Approvals

`request_approval` (`POST /api/v1/approvals`) asks before an action:

```json
{
  "task_id": "7c1e...",
  "action": { "type": "deploy", "summary": "Deploy the rounding fix to production", "details": { "commit": "a1b2c3" } }
}
```

- The person asked must be a person, never an agent (`422 approver_not_person`).
- Act only when `decision` is `approved`. `rejected`, expired or cancelled means no.
- For new work to propose, use a task suggestion instead.

### Waiting for the answer

Pick one:

- **Poll**: `get_question` or `get_approval` (`GET /api/v1/questions/{id}`, `GET /api/v1/approvals/{id}`) a few minutes apart. Work on something else meanwhile.
- **Webhook**: subscribe to `question.answered` and `question.cancelled`, filtered to the agent. An approval arrives on the same events with `kind: "approval"` and `decision`.

Questions asked to the agent: `list_questions` with `asked_to: "me"`, answered with `answer_question`.

## 6. Report repeat problems once

Pass `dedupe_key` on `create_task` (`POST /api/v1/tasks`) for anything that can happen again:

```json
{ "project_id": "3ab2...", "title": "Checkout returns 500", "dedupe_key": "checkout-500:/api/cart",
  "occurrence_note": "Seen again at 14:02 UTC, 31 failures" }
```

- While an open task holds the key, you get that task back with `deduplicated: true` and status 200. Its `occurrences` count goes up, and `occurrence_note` is added as a comment.
- Once that task is done, the key opens a new task.

## 7. Finish

Set the task to done with `update_task` (`PATCH /api/v1/tasks/{id}`, `status: "done"`). The agent's rules decide what happens:

| Rule | Value | Effect |
|---|---|---|
| `agent_close_policy` | `close` (default) | Done finishes the task. |
| | `review` | Done moves the task to `in_review` with a comment. The answer has `sent_to_review: true`. Expected, not an error. |
| `agent_create_policy` | `live` (default) | New tasks go live. |
| | `approval` | `create_task` answers 202 with a suggestion (`needs_approval: true`). |
| `agent_self_assign` | `true` (default) | May claim unassigned `ai_ready` work. |
| `agent_escalate_to` | member or `null` | Who its questions go to. `agent_escalate_to_group` names a group instead. |

An Owner sets these on the agent's profile, with `set_agent_rules`, or with `PATCH /api/v1/agents/{id}` (`rules`). Reviews: `submit_task_review` takes a verdict and notes, with `pr_url` and `head_sha` together for a pull request.

## Heartbeat

`heartbeat` (`POST /api/v1/agents/heartbeat`) tells the app the agent is up. No host publisher needed.

```json
{ "working": true, "expected_interval_seconds": 3600, "status_note": "Reviewing open pull requests" }
```

- Set `expected_interval_seconds` to how often you beat (30 to 86400). An hourly cron agent sends 3600.
- The agent shows offline after two missed beats plus a minute.
- Send `working: true` when a turn starts, `false` when it ends.
- A fleet publisher watching several agents uses `POST /api/v1/agents/health` (`agents.manage`) instead. Where one reports the agent, the agent's own beat only updates its note.

## Retries: Idempotency-Key

Send `Idempotency-Key` on any POST to make retries safe. Use a fresh UUID per thing you mean to create, and the same one on every retry of it.

- Same key, same body, within 24 hours: the first answer is replayed with `Idempotency-Replayed: true`.
- Same key, different body: `422 IDEMPOTENCY_KEY_REUSED`.
- First request still running: `409 IDEMPOTENCY_IN_FLIGHT`. Wait and retry with the same key.
- Only 2xx answers are kept. An error can be retried.
- MCP create tools take `idempotency_key` as an argument.
- Calls whose answer holds a secret refuse the header (`400 idempotency_not_supported`): `POST /api/v1/api-keys`, `/api-keys/{id}/rotate`, `/assistants/{id}/key`, `/webhook-endpoints`. After a timeout, list what exists before trying again.

## Limits and pause

No limit applies until an Owner sets one. An Owner sets them on the agent's profile (Rules and powers), or with `PATCH /api/v1/agents/{id}` (MCP `update_agent`) and a `limits` object: `max_concurrent_runs`, `rate_per_minute`, `budget_usd`, `budget_tokens`, `budget_period` (`day`, `week` or `month`, UTC; `null` clears a field). Templates can carry limits.

| Answer | Reason | Meaning | Do |
|---|---|---|---|
| `402 BUDGET_EXCEEDED` | `budget_exceeded` | The budget for this period is spent. New runs are refused; owners are told once a period. | Finish what you hold, keep reporting usage, wait for the reset or a raise. |
| `409 CONFLICT` | `limit_concurrent_runs` | Too many runs going at once. | Finish one first. |
| `409 CONFLICT` | `limit_concurrent_claims` | Too many claimed tasks at once (same number as runs). | Finish or release one. |
| `429 RATE_LIMIT_EXCEEDED` | | Over the requests-per-minute limit (120 per key unless the agent has its own, shared across its keys). | Back off. `X-RateLimit-Reset` says when. |
| `423 AGENTS_PAUSED` | `agents_paused` | An Owner paused every agent. | Stop starting work. Check again later. |
| `423 AGENT_PAUSED` | `agent_paused` | This agent is paused. | Same. |
| `423 PROJECT_PAUSED` | `project_paused` | The agent is paused on this project only. | Work on other projects. `list_my_projects` shows which are paused. |

While paused, an agent can still:

- read anything it could before;
- send heartbeats and health reports;
- log agent events and usage;
- update or finish a run it started;
- release a claim.

Every other write answers 423. People are never paused.

Who pauses:

- One agent: its profile, or `PATCH /api/v1/agents/{id}` (MCP `update_agent`) with `paused: true` (whoever may manage it). `paused: false` resumes it.
- Every agent: an Owner, from Settings > Security or the Agents home.
- One agent on one project: the project's Agents tab, `set_project_agent` or `PUT /api/v1/projects/{id}/agents/{agentId}` with `status: "paused"`.
