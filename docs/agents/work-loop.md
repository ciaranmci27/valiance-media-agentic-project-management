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
- the task's initiative (the body of work it belongs to), with its pinned brief entries;
- the newest 10 comments, files and links;
- any open question, the claim and the latest run;
- the caller's own rules (`self_assign`, `close_policy`, `create_policy`, `escalate_to`);
- `delegated_from`, when another agent handed this task over;
- `omitted` and `cut_to_fit`, saying what was left out and why.

Read it before planning. Reach for `get_task` or `list_task_comments` only for what the brief cut.

### Initiatives

An initiative is a named body of work inside a project: an owner, a status (`planned`, `active`, `paused`, `done`), a health while active, its own board (the project's tasks with its `initiative_id`) and a log. A goal is different: an outcome to reach (`project_goal_id`). A task belongs to at most one initiative; a subtask always has its parent's.

When a task has one, its brief carries `initiative`. To work the initiative itself:

1. `get_initiative` (`GET /api/v1/projects/{id}/initiatives/{initiativeId}`): the header and progress, open issues (newest 20), the last 10 log entries and the pinned brief entries, each list with `more`.
2. `search_tasks` with `initiative_id` for its board.
3. Record what happened with `add_initiative_entry`: `update` (news), `decision` (what was decided and why), `issue` (what blocks the work; it starts open, and `update_initiative_entry` with `status: resolved` closes it) or `note`.

Three places, three jobs. The log is the dated record. The brief is standing knowledge everyone on it should always know (`add_context` with `scope_type: initiative`). Work you propose is a task suggestion (`create_task_suggestion`), never a log entry.

The log needs `tasks.read` and is never a guest's. Creating and changing initiatives needs `tasks.create` in the project.

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
- `update_run` (`PATCH /api/v1/agents/runs/{id}`): a new `plan`, a progress `note`, and `tokens_in`, `tokens_out`, `cost_usd` as totals so far (so a retry is safe). These totals are the run's spend; usage that names the run is not added again ([How spend is counted](#how-spend-is-counted)).
- `finish_run` (`POST /api/v1/agents/runs/{id}/finish`): `status` `succeeded` (default), `failed`, `cancelled` or `timed_out`, plus a `summary`. A finished run's status cannot change (`409 run_finished`).
- A run with no update for two hours is stored as `timed_out` (within five minutes; `run.finished` goes out once), and its status cannot change after that. On long work, update at least that often.
- `list_runs` and `get_run` read them back. Webhooks: `run.started`, `run.updated` (status `waiting`, or back to `running`), `run.finished`.

### Waiting on a person

A run can be `waiting`: neither running nor finished. Use it when the next step is a person's answer.

- **Pass `run_id` when you ask.** `ask_human` and `request_approval` take your own unfinished run's id. While the question is open, the run is `waiting` and never times out. Another agent's run is `422 run_not_yours`; a finished run is `409 run_finished`.
- **When the answer comes** (or the question is cancelled or expires), and no other open question names the run, it is `running` again and its two hours start over.
- **Or say it yourself:** `update_run` with `status: "waiting"`. With no open question naming it, a waiting run is stored as `timed_out` after seven days without an update.
- **Any update you send without `status: "waiting"` makes it `running` again.** To add a progress note while you still wait, send `status: "waiting"` with it. A note from someone else (`agents.manage`) leaves it waiting.
- **Finish from waiting** as usual: `finish_run` with `succeeded`, `failed` or `cancelled`.
- Turns that name a waiting run keep it waiting and restart its clock.
- Analytics show it as "Waiting on a person", never as a timeout, and leave it out of the success rate until it finishes. It does not count against `max_concurrent_runs`.

### Parent runs and handoff

- `delegate_task` (`POST /api/v1/tasks/{id}/delegate`) hands work to another agent. Pass your `run_id`. Needs `tasks.manage_all`. Core never picks the receiver.
  - `mode: "subtask"` (the default) makes a subtask of the task, assigned to the receiver. Your own create rules apply (approval gives a suggestion, answered 202).
  - `mode: "assign"` hands the task itself over, as it is: top-level, or a subtask. The receiver joins its assignees; `reassign: true` takes you off (and ends your claim). Answered 200.
- The receiver sees `delegated_from` (with `mode`) in its brief and starts its run with `parent_run_id` set to that run.
- A reviewer asked for an approval (or a question) directly, with the asker's `run_id`, may start his run with `parent_run_id` set to that run: while it is open, or up to 24 hours after he decides it. Group questions do not count. Linking reads nothing more of the asker's run.
- The whole chain shares one root and one person it is for. A child run for someone else is refused (`403 principal_mismatch`).
- `get_run_tree` (`GET /api/v1/agents/runs/{id}/tree`) shows the chain from any run in it.

### Chains of agents

Subtasks go one level deep. Chains do not: a run can be the parent of runs on any task, so work can pass through several agents and stay one run tree.

Example: Ana asks her personal agent, Ashley, to fix the pricing page.

1. **Ashley** starts a run. It is made for Ana (`principal_id`), because a personal agent always works for its person. She creates the task (or finds it) and hands it to the company agent: `delegate_task` with `mode: "assign"`, `agent_id` Alexa, `run_id` her run.
2. **Alexa** reads `delegated_from` in the brief and starts her run with `parent_run_id` set to Ashley's run. Ana is carried down as principal. Alexa plans the work and hands the build to Jeff as a subtask (`mode: "subtask"`, her `run_id`).
3. **Jeff** starts his run under Alexa's. When the build is done, he hands his subtask to the reviewer (`mode: "assign"`, his `run_id`).
4. **The reviewer** starts a run under Jeff's.

`get_run_tree` from any of these runs shows all four: Ashley at depth 0, Alexa 1, Jeff 2, the reviewer 3 (`levels: 4`), each on its own task, all with Ana as `principal_id`.

The guards:

| Rule | Refusal |
|---|---|
| A chain keeps its person. Acting for someone else on it, or handing it to another person's personal agent, is refused. | `403 principal_mismatch` |
| A hand-off and a child run in a chain for a person are checked with your access and theirs together, as `X-Act-For` would: only projects both reach, only what both may do. | `404` for a task out of reach, `403` for a missing permission |
| The receiver must reach the task's project. | `422 receiver_no_project_access` |
| At most 8 hand-offs below the first run. | `409 chain_too_deep` |
| Never to an agent that already ran a run above yours (handing work back up would loop), including yourself. | `409 delegation_cycle` |
| A personal agent delegates only while acting for its person, and only to company agents. | `403 personal_agent_not_acting`, `403 receiver_is_personal_agent` |

Every hand-off in a chain for a person needs what that hand-off needs (`tasks.manage_all`) held by the person too, never only by the agents. A company agent's other calls during the chain use its own key; to keep those inside the person's reach too, act for them (`X-Act-For`).

A task holds one delegation link: handing it on again replaces it. The runs keep the whole chain.

## 5. Ask a person

### Questions

`ask_human` (`POST /api/v1/questions`):

```json
{
  "task_id": "7c1e...",
  "run_id": "9a40...",
  "question": "EU totals round per line or per invoice? Finance has asked for both before.",
  "choices": ["Per line", "Per invoice"],
  "allow_other": true
}
```

- `asked_to` defaults to the agent's escalation target, then its owners, else the Owner.
- `asked_to_group` asks a group: every member's bell rings, any member answers.
- `expires_at` sets a deadline. After it, the question is stored as expired, `question.expired` goes out, and whoever asked (for an agent, its owners) is told once.
- `cancel_question` withdraws it.
- `run_id` names your run: it waits on the answer ([Waiting on a person](#waiting-on-a-person)).

### Approvals

`request_approval` (`POST /api/v1/approvals`) asks before an action:

```json
{
  "task_id": "7c1e...",
  "action": { "type": "deploy", "summary": "Deploy the rounding fix to production", "details": { "commit": "a1b2c3" } }
}
```

- Name a person, or a reviewer agent on purpose, in `asked_to`. A default (your escalation target) that lands on an agent is refused (`422 approver_not_person`). Never yourself (`422 asked_self`).
- Act only when `decision` is `approved`. `rejected`, expired or cancelled means no.
- `run_id` holds your run while it waits, as on a question.
- Whoever the approval names decides it, or the Owner. `decided_via` says how: `app`, `api_key`, `agent` or `act_for`.

Deciding an approval (`answer_question` with `choice: "approve"` or `"reject"`):

- An approval that names a person, or a group of people (or the Owner's override), is decided in the app, signed in. Over the API it needs a key that carries `approvals.decide`.
- An approval asked to an agent by name is decided by that agent with its own key, no extra scope.
- Admins and members hold `approvals.decide` on the API, but no key carries it by default. A person adds it to their own key on purpose.
- An agent acting for the person (`X-Act-For`, or a personal agent) needs `approvals.decide` on its key, held by the person too. The decision is recorded as the person's. It never decides a request it made.
- A connected AI tool (Connect AI) never decides one, whatever its scopes.
- Refused: `403 approval_needs_person`, with a hint. Not the one named: `403 not_asked`. `can_answer` tells you first.
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

Work that comes back on a rhythm (a weekly report, the 1st of the month) needs no loop of your own: `set_task_repeat` makes the next copy of a task, and `create_template_schedule` runs a playbook on a schedule ([Task templates](templates.md#run-a-template-on-a-schedule)).

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

No limit applies until an Owner sets one. An Owner sets them on the agent's profile (Rules and powers), or with `PATCH /api/v1/agents/{id}` (MCP `update_agent`) and a `limits` object: `max_concurrent_runs`, `rate_per_minute`, `budget_usd`, `budget_tokens`, `budget_period` (`day`, `week` or `month`, UTC; `null` clears a field). Templates can carry limits. How the budget counts spend: [How spend is counted](#how-spend-is-counted).

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

Pause and budget refuse calls into this app only. An agent that also works elsewhere checks `get_my_status` (`GET /api/v1/agents/me/status`) before each turn and skips the turn when `can_start_work` is false ([External agents](external-agents.md#check-before-each-turn)). Webhooks `agent.paused`, `agent.resumed` and `budget.exceeded` tell its host at once.

Who pauses:

- One agent: Pause in its profile's header (one click, no confirmation), or `PATCH /api/v1/agents/{id}` (MCP `update_agent`) with `paused: true` (whoever may manage it). `paused: false` resumes it.
- Every agent: an Owner, from Settings > Security or the Agents home.
- One agent on one project: the project's Agents tab, `set_project_agent` or `PUT /api/v1/projects/{id}/agents/{agentId}` with `status: "paused"`.

### How spend is counted

The budget and Analytics count spend the same way, once:

- **Work under a run counts as the run's own totals.** Its `cost_usd`, `tokens_in` and `tokens_out` are the truth.
- **Usage and turns that name a run never add again.** Send `run_id` (or `run_external_id`) on `usage.recorded` and `turn.completed` to say they belong to a run. They only stand in where the run reports no cost or tokens of its own.
- **Usage that names no run adds on top.** So a run reporting $60 plus $50 of `usage.recorded` with no run is $110.
- **Turns that name no run add their own tokens** only for an agent that reports no `usage.recorded` that period. Otherwise the usage already counts that work.
- **Spent tokens are input plus output.** Cached tokens show in Analytics but never count against `budget_tokens`.
- **Spend knows who it was for.** Each counted run, usage or turn carries the person the agent acted for (`principal_id`: `X-Act-For`, or a personal agent's person), so spend can be read by person. Work the agent did as itself has none.

A run counts in the period it started. Usage counts at its `recorded_at`. Usage sent before `run_id` was accepted on it names no run, so it adds on top.
