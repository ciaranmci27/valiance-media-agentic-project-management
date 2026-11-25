# Changelog

Every release has a section here, newest first. The release workflow publishes a version's section as its GitHub release notes, and the app shows it to owners before they update.

Each section starts with `## X.Y.Z (YYYY-MM-DD)` and uses these headings, leaving out any that are empty:

- `### Added`: new things an install can use.
- `### Changed`: existing behaviour that works differently.
- `### Database`: the core migration files in the release, one per line. `npm run db:migrate` applies them.
- `### Breaking`: what an install must do when it takes this release.

## 2.0.33 (2026-11-25)

### Changed
- **Edit project opens in the side panel**, like a task, instead of a centered box. Sections read top to bottom (Basics, People, Schedule, Time and budget, Billing) with the save bar pinned at the bottom. Closing with unsaved edits asks first, and a blocked save jumps to the field that needs fixing.
- Project edits check that the due date is not before the start date and that the billing email looks right.
- A contact added from Edit project becomes the primary client.

## 2.0.32 (2026-11-25)

### Added
- **Key lifetimes on Settings > Developers**: Owners set how long new people's keys and AI agent keys last. For everyone but an Owner, that lifetime is also the longest key they can make.
- MCP `update_agent` takes `limits` and `paused`, the same as `PATCH /api/v1/agents/:id`.

### Changed
- An Assistant shows **On hold** while every agent is paused or its own agent is paused, instead of Working. Chat replies wait until it is resumed.
- The `project_paused` hint points agents at `list_my_projects`.
- API docs and `WEBHOOKS.md` cover agent limits, pause and owner groups, run parent and root ids, approvals asked of a group, the personal-assistant template, `context.memory` and the `assistant.message` payload.

## 2.0.31 (2026-11-25)

### Added
- **Wake signal for mail sent back**: `GET /api/v1/inbox/signal` (and MCP `get_inbox_signal`) adds `plans_newest_queued_at`, the latest of when ready mail arrived or was put back for the agent (sent back, answered, moved out of Filtered). Agent hosts should wake when it moves.
- **Expiry for personal API keys**: new keys take an expiry (30 days, 90 days, 1 year or none) in the New key dialog, and `expires_in_days` over the API and MCP. Owners can set a personal key lifetime (`/api/workspace/key-settings/personal`) that is the maximum for everyone else, as the agent key lifetime already is.
- Approving a suggestion an agent made from an email links that email to the new task.
- **Docs for bringing your own agent**: `docs/agents/` covers the work loop, events and webhooks, identity and access, setting everything up from a chat, and Assistants.

### Changed
- People in a group that handles an inbox read it while they are in the group, and lose it when they leave or the group stops handling it.
- A suggestion that names an email (`metadata.message_id`) must name one its maker can read (422 `message_not_readable`); an agent's approval files the email under the normal project rules.

### Database
- `20261125000200_followups.sql`: `messages.requeued_at`, the personal key lifetime, group inbox access derived from membership, and removal of the access rows earlier releases copied for group handlers.

## 2.0.30 (2026-11-25)

### Added
- **Agent handoff**: a run may start under a parent run (`parent_run_id`), and the whole chain shares one root and one person it is for, which no agent can switch. `delegate_task` (MCP) and `POST /api/v1/tasks/{id}/delegate` hand a subtask to a specialist agent through the normal assignment rules; `get_run_tree` shows the chain, and the run view lists parent and children.
- **Context at every level**: alongside project briefs, company knowledge (Settings > Workspace), group knowledge (each group's page), agent notes (each agent's profile) and personal memory. Personal memory is seen only by its person and, when they switch on "Remember things for me", their own assistant; never by an Owner. Agents read pinned entries for their level in their briefing and task brief, and search across what they may see (`search_context`, `add_context`, `/api/v1/context`).
- **Agent templates and tool profiles as data**: Owners create, edit and archive them over the API and MCP, and export or import them, without a code change. Code-defined ones still work and cannot be overridden.
- Personal memory needs the new permission `context.memory` for a person's own keys, and a connected AI tool reaches it only when the person ticks it on the consent screen.

### Changed
- Core MCP profiles are now just `generic`; other profiles in use on an install are kept as workspace profiles with the same tools.
- An Owner can no longer make or rotate a key for someone else's personal assistant: only the person, or the assistant host collecting its key, can.
- Re-binding a personal assistant to another person resets its settings.

### Database
- `20261125000100_handoff_scopes_registries.sql`: run lineage and task delegations, context scopes on project context with personal memory rules, template and profile rows, the agent's template key on the member, and `context.memory`.

## 2.0.29 (2026-11-25)

### Added
- **Connect AI** (Settings > Account, and the sidebar): anyone connects Claude, ChatGPT, Cursor, Claude Code or Codex to their own projects and tasks by pasting one address and signing in. The tool can read their projects and tasks, create tasks, update tasks assigned to them and manage their own reminders, never more than they can, and never admin powers or keys, even for an Owner. Each person sees their connected apps, where each returns to, and can disconnect any of them. A personal key is offered for tools that cannot sign in.
- The MCP server is now an OAuth 2.1 protected resource: discovery documents (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`), open client registration, authorization code with PKCE (S256), rotating refresh tokens with reuse detection, and a consent screen that names where the tool returns to.
- **Owners can turn connections off** for the whole workspace (Settings > Security); suspending a person disconnects their tools for good.
- **Tool catalog**: `GET /api/v1/mcp/tools` lists the tools a caller may use, with their schemas and a version, so another MCP server can offer them.

### Changed
- Sign-in and the connect consent page can no longer be shown inside another site's frame.

### Database
- `20261125000000_connect_ai.sql`: OAuth clients, codes, grants and tokens (stored only as hashes), the workspace switch, an hourly clean-up (`pm-oauth-sweep`), and suspension revoking a person's connections.

## 2.0.28 (2026-11-25)

### Changed
- Core checks read a database schema file over 1 MB again (one test stopped at 1 MB in 2.0.27). No app change; take this release instead of 2.0.27 if your checks failed.

## 2.0.27 (2026-11-25)

### Added
- **Limits per agent** (an agent's Rules and powers, Owner): runs at once, requests per minute (across all its keys) and a budget in dollars or tokens per day, week or month. Over budget, new runs are refused (402) and its owners are told once per period; usage is always recorded. Templates can carry limits. No limit applies until one is set.
- **Pause**: pause one agent from its profile, or every agent at once (Owner only) from Settings > Security or the Agents home. Paused agents still read, report health and usage, and finish or release what they hold; people are never paused. Pausing an agent's assignment on a project stops its writes there.
- **Audit log** (Settings > Security, Owner): filter by who, who it was for, action and date, keep entries for as long as you choose (`audit_retention_days`, daily clean-up), and export with `GET /api/v1/audit/export` (permission `audit.export`). Signed-in changes to members, keys, agents, settings, permissions and modules are recorded too.

### Changed
- The audit log is append-only: nothing can edit or delete an entry except the retention clean-up, and secrets, tokens and webhook address paths are removed before anything is written. Public and signed-in database roles can no longer write to it or to the team activity log.

### Database
- `20261124001500_limits_audit.sql`: agent limits, the pause switches, a single request gate for limits and pause, the audit log export order, append-only and retention, write-time redaction, and audit rows for signed-in security changes.

## 2.0.26 (2026-11-24)

### Added
- **Assistant**: each person's own assistant, with its own page (`/assistant`, shown under the name your workspace gives it). It shows what the assistant did (with Undo), what needs you, and plain switches: Sort my inbox, Create tasks for me, Draft replies, Remind me, plus Pause. No keys, scopes or templates ever show. The switches are enforced by the server, including inside inbox sorting. A broken assistant tells the person "paused" and tells their admin.
- **Settings > Assistants** (Owner): turn assistants on, name them, choose who gets one by role or group, give everyone theirs with a preview first, and see which ones need attention.
- **Chat connections**: an Owner connects Slack or Telegram once. Messages reach the app, which checks the sender's linked account and passes the message to that person's assistant (webhook `assistant.message`, carrying ids only, or a poll). The assistant answers with `POST /api/v1/assistant/messages/{id}/reply`. Strangers get a connect link only in a direct message. Chat text stays private to the person's assistant.
- **Developers settings, reorganised**: API keys, Webhooks and MCP and API docs. Keys and webhook endpoints are made in short step dialogs that show their secret once, keys can be rotated with an overlap, and Webhooks stays visible with a "Turn on webhooks" option when the feature is off.

### Changed
- Personal agents may read and sort only their own person's inboxes, never shared ones, and see only projects their person can open.

### Database
- `20261124001400_assistant_chat.sql`: assistant preferences, chat connections (sealed credentials), chat messages, chat rate limits, the `assistant.message` webhook (sent only to a personal agent's own endpoints), and a trigger that keeps "Sort my inbox" following the person's inboxes.

## 2.0.25 (2026-11-24)

### Added
- **Personal agents**: an agent bound to one person (`delegate_of`) always sees and does only what that person may, owns nothing beyond them, escalates to them first, and records them as who its work is for. One per person per template.
- **Assistant setups by role or group** (Owner): `POST /api/workspace/assistants/provision` gives everyone a personal agent in one action (paged, with a dry run), and new members get one when they join. The agent tool collects each agent's key once (`POST /api/v1/assistants/{id}/key`, permission `assistants.provision`), so nobody handles hundreds of secrets.
- **Leaving cleans up**: suspending a person pauses their personal agents and revokes their keys, passes and pending links in one step, and removes them as owner of agents until they return. Re-binding or unbinding a personal agent revokes its keys. Personal agents never get a sign-in.
- **Key lifetime and rotation**: an optional lifetime for new agent keys (Settings, `key-settings`), and `POST /api/v1/api-keys/{id}/rotate` for a new secret with the old one kept for an overlap (24 hours by default, at most 7 days). Revoking a key also revokes what it, and every key it was rotated from, made.
- **Webhook signing secrets are encrypted** for new endpoints when `APP_ENCRYPTION_KEY` is set. Settings > Encryption moves existing ones; deliveries never rewrite a secret in this release.
- **Project badges from an install**: `projectBadges` in `src/custom/index.ts`.

### Changed
- Suggestions waiting for review count in every project you can reach, from any agent, no longer only in projects with one company's autonomy switch. Core screens no longer show or edit that company's fleet fields; an install edits them from its own project tab.
- Core agent screens use generic wording ("Directed by a person", "Woken on demand", "Replied in chat").
- A new core agent template, Personal assistant.

### Database
- `20261124001300_personal_agents_secrets.sql`: personal agent binding and its guards, assistant setups, provisioning, the suspend and re-bind cascades, key lifetime and rotation (with an hourly `pm-api-key-rotations` job), and a key revoke that follows rotations.

## 2.0.24 (2026-11-24)

### Changed
- Fixes the 2.0.23 build: a quote in the API docs text stopped the app from compiling. Take this release instead of 2.0.23.

## 2.0.23 (2026-11-24)

### Added
- **Move to project**: a task action everywhere tasks appear (card and row menus, the task panel and page, bulk selection, and an agent's task receipts in the inbox). Comments, files, subtasks (including ones in Trash), reminders, links, claims and activity move with it. Nobody gains access silently: if assignees cannot open the target project, you choose to remove them or add them to it. Moving a conversation offers to move the tasks an agent made from it. Over the API and MCP: `PATCH /api/v1/tasks/{id}` or `update_task` with `project_id`, plus an optional `lost_access`.
- **Agent event labels**: agents attach labels to any event when they log it, or later with `POST /api/v1/agent-activities/{id}/labels`. Analytics has a Labels breakdown, and `GET /api/v1/agent-activities?label=` filters by label.
- **Export every agent event to a data system**: `GET /api/v1/agent-events/export` (scope `agent_events.export`) returns every event and run in order from a resumable cursor, never skipping or repeating one. A webhook event, `agent_event.created`, can be opted into per endpoint, with a type filter. After restoring the database from a dump into a new cluster, export again from the start.
- **Cost by provider**: usage and runs may name a `provider`. Analytics splits usage by model and provider, and keeps priced and unpriced usage apart.
- **AI provider plans** (Settings > Workspace): an Owner records a subscription's monthly cost, and Analytics shows an estimated share, labelled as an estimate and never added to measured cost.
- Analytics totals are computed on the server, so long ranges and large teams load in full.

### Changed
- "Send back to the agent" now settles the earlier plan and its open question, so the agent's new plan is accepted, and the thread shows that a new plan is coming. The agent's context marks `sent_back`, superseded plans and tasks in Trash.
- The thread header has a labelled "Mark handled" button and a separate "More actions" button.
- Moving a task over the API needs `tasks.create` in the target project. A key that manages only its own tasks can now move them.

### Database
- `20261124001200_agent_event_pipeline.sql`: event labels, an export sequence on events and runs, `provider` on runs, the `agent_event.created` webhook, the provider plans table, and server-side analytics aggregates (`agent_analytics_window_v2`, `agent_run_stats`, `agent_question_stats`).

## 2.0.22 (2026-11-24)

### Added
- **Groups** (Team > Groups): Finance, Legal, Support. A question or approval can go to a group, and any member answers; an agent can escalate to a group, and a group can own an agent. API and MCP. Managing groups (`groups.manage`) is Owner-only by default: its holder can join groups that own agents or decide approvals.
- **Linked chat accounts**: people link their Slack, Teams, Telegram or other chat accounts (Settings > Account), confirmed through a one-time link the assistant sends them, or linked by an Owner. Agent tools look up who a chat user is and how to reach a person or group (`/api/v1/identities/resolve`, scope `identities.read`).
- **Acting for someone**: an agent with `agents.act_for` gets a 15-minute pass for a person with a linked account (`POST /api/v1/delegations`, header `X-Act-For`). While acting, it sees and does only what both it and that person may, and every run, question, task, comment and audit row records who it was for (`principal_id`).
- **Analytics** (Agents > Analytics, formerly Usage): selectable stat tiles with sparklines (runs and success, busy time, tasks done, PRs, tokens in and out, model cost, questions and time to answer, incidents, rework, blocked time) driving one chart, and breakdowns by agent, project, model and role. Revenue and profit appear only when billing is on, an agent actually bills, and the viewer may see finances. Unpriced or subscription usage reads "Unpriced", never $0.
- **Analytics cards from an install**: `agentAnalyticsCards` in `src/custom/index.ts` adds cards below the breakdown.
- **Inbox handlers and defaults**: an inbox can be handled by several agents, people or groups, with one primary. Each inbox can name a default assignee, a default project and who gets its decisions (Owner only); they apply only when a request leaves them out. Sender rules can apply to one inbox (`scope: 'inbox'`, `inbox_id`), and a person's rule always wins over an agent's. Queue, drafts and signal take `?handled=me`.
- An agent's decision now shows inside its reply in the email thread.

### Changed
- The Usage tab is now Analytics; old links redirect. One company's fleet cards (billing gaps, model evals, dispatcher reliability, Telegram attention) left the core view.
- A person's workspace sender rule switches off agents' rules for the same sender and topic, and is always applied first.
- `POST /api/v1/notifications` may name an inbox, message or conversation; with `audience: "owner"` it then reaches that inbox's decision recipient.

### Database
- `20261124000900_identity_groups_principal.sql`: groups and group members, questions asked to a group, escalation and ownership by group, linked identities and link requests, delegation tokens, and `principal_id` on runs, questions, tasks, comments, activities and the audit log.
- `20261124001000_inbox_handlers.sql`: inbox handlers, per-inbox defaults and sender rule scope.

## 2.0.21 (2026-11-24)

### Added
- **Hire an agent** (`/agent/new`): a guided page instead of a team invite. Pick a template, give it a name, role, owners and personality, choose its projects with each project's settings and instructions, set its powers and rules in plain words, then connect it: a key shown once and ready-to-paste setup for Claude Code, Codex or any MCP client, plus its briefing as an AGENTS.md. Also one call: `POST /api/workspace/agents`, v1 and MCP `create_agent`.
- **Agent profiles** (`/agent/{id}`): live status, current run, what it needs from you, runs, projects, rules and powers, keys and its briefing.
- **Agents home redesigned**: one Needs you inbox (your agents first), a roster that stays usable at hundreds of agents (search, filters, roles, owners, grouping, paging), a runs feed and usage.
- **Agents on projects**: each project has an Agents tab. An agent on a project has its own settings (a form declared by its template, such as a repository and branches for a builder or a check interval for a watcher), its own instructions and a pause switch. API and MCP: `/api/v1/projects/{id}/agents`, `set_project_agent`, `list_my_projects`.
- **Project brief**: project context becomes a brief with sections (overview, goals, rules, decisions, links, glossary, history), pinned entries every agent reads, and search (`search_project_context`). Existing entries are sorted into sections.
- **Guided project setup** (`/projects/new`): basics, brief, goals, agents and people in one flow, or one call (`POST /api/v1/projects/setup`, MCP `setup_project`).
- **Agent roles and owners**: an optional role label (builder, reviewer, anything) and one or more people who own each agent. Owners get its questions and alerts first and can manage it on projects it is already on; keys and project access stay with Owners and project managers.
- Agents' briefings and task briefs include their project settings, instructions, role and the pinned brief.

### Changed
- An agent's questions go to its `escalate_to`, then its first owner, then the oldest workspace Owner.
- Agents are hired, not invited: the team invite no longer offers the agent role.
- The old per-project agent page redirects to the project's Agents tab.

### Database
- `20261124000800_agent_workspaces.sql`: `project_agents`, `agent_owners`, agent role and description on members, brief sections, pinned entries and search on project context, and an agent counts view.

## 2.0.20 (2026-11-24)

### Added
- **Inbox triage over MCP.** Eighteen tools give any MCP agent the email triage loop the REST API already offers: `list_inbox`, `get_triage_queue`, `get_email`, `get_email_triage_context`, `submit_triage_plan`, `record_email_triage`, `create_task_from_email`, reply drafts, sender rules, attachment links and labels, inbox questions, the unsummarized-triage list and the inbox signal. Each calls its REST route with the caller's key, so an agent reaches only the inboxes it may read. Long threads and busy projects are trimmed to fit, with notes saying what was cut. `pm_guide` adds an inbox section for keys that see these tools.

### Changed
- Creating a task from an email (`POST /api/v1/inbox/messages/{id}/tasks`) follows the agent's rules like `POST /api/v1/tasks`: an agent whose new tasks need approval gets a suggestion (202, with the email's id in its metadata) instead of a live task, and one whose finished work goes to review gets the task in review. Agents on the default rules see no change.

## 2.0.19 (2026-11-24)

### Added
- **Approvals.** An agent asks a person to approve an action before doing it (a deploy, an email, a payment, a merge): `POST /api/v1/approvals` (MCP `request_approval`, `get_approval`), on a task, a project or neither, with an optional expiry. It arrives like a question, with the action's type and every detail shown and Approve or Reject buttons; only the person asked, or the Owner, decides, and the asked person must be a person, not an agent. Decisions come back by polling, `answer_question`, or the `question.*` webhooks.
- **Reviews without a PR.** `submit_task_review` takes a verdict and notes on any work; `pr_url` and `head_sha` are optional but come together. PR reviews behave exactly as before.
- **Agents' own events.** Activity types `note` and `custom.<namespace>.<name>` with a plain-text `title` (up to 200 characters) record anything an agent wants on the feed without a core change. They never change an agent's status, the needs-you list or analytics totals.
- **Tool profiles as a registry.** Installs add their own MCP profiles in `src/custom/agent-profiles.ts`, each listing the tools it sees. Core profiles see the same tools as before.

### Changed
- `src/custom` has a new starter file, `agent-profiles.ts` (an empty list for installs that merge).
- A member whose install profile is later removed from code sees only `pm_guide` until an Owner picks another profile.

### Database
- `20261124000600_open_agent_vocabulary.sql`: `questions.kind` and `action` for approvals, and the activity type and agent profile checks become shape patterns (validation of known values moves to code). Existing rows are unchanged.

## 2.0.18 (2026-11-24)

### Added
- **Runs.** One record per piece of agent work: status, plan, progress notes, tokens, cost, model, what started it, the task it was for, and a link to the harness's own trace. `POST /api/v1/agents/runs` to start (a repeated `external_id` updates the same run), `PATCH` and `/finish` while working, `GET` to list and read; MCP `start_run`, `update_run`, `finish_run`, `list_runs`, `get_run`. Only the run's agent, or a key with `agents.manage`, writes it; a finished run's outcome is fixed. A run silent for two hours reads as timed out.
- Agents that never start runs still show their work: each `turn.completed` that names no run appears in the runs feed as a finished run (scheduled turns that did nothing are left out). A turn that names its run (`run_id` or `run_external_id`, optional) is counted on that run. Usage and cost totals are unchanged.
- A task shows its latest run (status, agent, title, times) in `GET /api/v1/tasks/{id}` and `get_task_brief` while AI agents are on.
- Webhook events `run.started` and `run.finished`.

### Database
- `20261124000500_agent_runs.sql`: the `agent_runs` table (server writes, members read their own or all with `agents.manage`), the `agent_run_feed` view, run webhook triggers, and a partial index on `agent_activities` for turns that name a run.

## 2.0.17 (2026-11-24)

### Added
- **Context packs.** Each agent gets a briefing generated live from its real setup: who it is, what its key may do in plain words, its rules, the projects it reaches, the tools it can call, the house conventions (start with `get_task_brief`, claim before working, `ask_human` when stuck, and so on), how it reports health, and its webhooks. `pm_guide` now includes it as `context`; `GET /api/v1/agents/me/context` returns it for the calling key, and `?format=md` or `?format=skill` downloads it as an AGENTS.md or SKILL.md for a harness's repo. It is never stored, so it never goes stale, and it only shows what the viewer may see.
- **Agent templates**: data-health watcher, inbox triage, builder and weekly reporter, each a set of rules, suggested scopes and webhook events, and a brief. `GET /api/v1/agent-templates`, `POST /api/v1/agents/{id}/template` (MCP `list_agent_templates`, `apply_agent_template`). Templates grant nothing the caller could not grant. Installs add their own in `src/custom/agent-templates.ts`.
- **Export and import.** `GET /api/v1/agents/{id}/export` saves an agent's setup as a file (no secrets); `POST /api/v1/agents/import` creates or updates an agent from it through the same checks as the setup tools, with a dry run, a report of anything it could not match, and keys or webhooks made only when asked. A failed import revokes the keys and removes the webhooks it made.

### Changed
- `src/custom` has a new starter file, `agent-templates.ts`. An install that merges this release gets it as an empty list.

## 2.0.16 (2026-11-24)

### Added
- **Set up an agent from a chat.** Everything the agent setup screens do is now an API and MCP tool, so an AI can configure an agent from a description: `create_agent` (`POST /api/v1/agents`, Owner only), `create_api_key`, `list_api_keys`, `revoke_api_key` (`/api/v1/api-keys`), `set_agent_projects` (`PATCH /api/v1/agents/{id}/projects`), webhook endpoints (`/api/v1/webhook-endpoints`), and `get_agent_setup` to check the result. Agent keys never see these tools.
- A key made over the API grants only scopes the calling key carries and the new key's member holds. Only an Owner makes keys for another member, and only for an agent. Secrets are shown once and never stored for replay.
- **Key lineage.** A key made over the API remembers the key that made it, and revoking a key (from Settings or the API) also revokes every key it made, each logged.
- `api_keys.manage_all` and `webhooks.manage` can be granted to API keys in Team > Access. No role has them on the API by default.

### Changed
- `/api/v1/team-members`: no key can create an Owner or make someone one; adding an agent or Admin is Owner only; an Owner's own row changes only with that Owner's key.

### Database
- `20261124000400_agent_setup_api.sql`: `api_keys.created_by_key_id` (fixed once set) and `revoke_api_key_tree` (service role only). Apply it before making keys over the API.

## 2.0.15 (2026-11-24)

### Added
- **Heartbeat from the agent itself.** `POST /api/v1/agents/heartbeat` (MCP `heartbeat`): any agent reports that it is up, whether it is working, a short status note, and how often it promises to beat (`expected_interval_seconds`, 30 to 86400). An agent is shown offline after two missed beats plus a minute, so an hourly agent no longer looks down between runs. No container or host publisher needed. Where a host publisher already reports an agent, the publisher stays the source of liveness and the agent's beat only updates its note.
- **Idempotency-Key** on every API POST: a retry with the same key replays the first successful answer (`Idempotency-Replayed: true`) instead of doing the work twice; the same key with a different body is refused (422), and one still running answers 409. Keys last 24 hours. MCP create tools take `idempotency_key`.
- **Task brief.** `GET /api/v1/tasks/{id}/brief` (MCP `get_task_brief`): the task, its project and context, recent comments, files, blockers, open question, claim and the caller's agent rules in one bounded answer, cut to fit with flags saying what was left out. The MCP guide tells agents to start every task with it.

### Changed
- The host health publisher may leave out `container` and may declare `expected_interval_seconds`; its current body works unchanged.

### Database
- `20261124000300_agent_plumbing.sql`: heartbeat columns on `agent_health` (`container` optional, `expected_interval_seconds`, `status_note`), the `api_idempotency_keys` table with its claim and cleanup functions (service role only), and the hourly `pm-api-idempotency-cleanup` job.

## 2.0.14 (2026-11-24)

### Added
- **Webhooks for work.** Endpoints can subscribe to `task.created`, `task.updated`, `task.deleted`, `comment.created`, `question.asked`, `question.answered`, `question.cancelled`, `suggestion.created`, `suggestion.decided` and `review.submitted`, on the same signing, retries and re-send as invoice events. Each payload is the subject's current state plus `project_id`, `task_id`, `member_ids` (who it concerns) and `actor_id` (who made the change, so an agent can skip its own). `task.updated` lists what changed; reordering and claims send nothing. Events for one task arrive in order. See WEBHOOKS.md.
- **Filters per endpoint**: only some projects, and only events that concern one member (their tasks, claims, questions and suggestions). An agent's harness can now hear about its own work and nothing else.
- Endpoints can be edited in Settings > Developers.

### Changed
- Webhooks no longer need Client invoicing. Work events need only the Webhooks module; invoice events still need both, and existing endpoints receive exactly what they did before. Webhook retries run whenever Webhooks is on.
- Writes through the API, MCP and the app send due webhooks straight after the change instead of waiting for the next retry run.

### Database
- `20261124000200_agent_webhooks.sql`: the work event triggers (one existence check, nothing written when no endpoint listens), endpoint project and member filters, per-subject ordering, and the retry claim and schedule gated on Webhooks only.

## 2.0.13 (2026-11-24)

### Added
- **Questions.** Any member (an agent or a person) asks another a question and gets the answer back, on a task, a project or neither: `POST /api/v1/questions` with optional choices (1 to 10, shown as buttons), free-text answers allowed by default, and an optional expiry. `GET /api/v1/questions/{id}` to poll for the answer, `GET /api/v1/questions` to list, `/answer` and `/cancel`. MCP: `ask_human`, `get_question`, `list_questions`, `answer_question`, `cancel_question`. The person asked defaults to whoever the agent's rules escalate to, else the Owner.
- The asked person's bell rings and links to My Tasks, where the question shows under "Needs you now" with its answer card; a task with an open question shows it on the card and in the task panel, and `GET /api/v1/tasks/{id}` returns `open_question`. Answering, cancelling, expiring or trashing the question clears the bell.
- Who sees a question follows task access: the asker, the person asked, and members who can open its task or project. The person asked can always answer, even without access to the task.

### Database
- `20261124000100_questions.sql`: the `questions` table (soft delete, server writes only, member reads by task and project access) and its triggers that keep a task's project, ring and clear the bell.

## 2.0.12 (2026-11-24)

### Added
- **Claims.** An agent (or a person) takes a task for a set time: `POST /api/v1/tasks/{id}/claim` (default 30 minutes, up to 240), `/claim/extend` while working, `DELETE` to release. Nobody else can claim it meanwhile. A claim that runs out frees the task; work a claim picked up goes back to the pool on release or expiry. The task shows who is working on it, and managers can release a stuck claim. MCP: `claim_task`, `extend_claim`, `release_task`.
- **What next.** `GET /api/v1/tasks/next` (MCP `next_task`): the caller's assigned work first, then unassigned work it may pick up, skipping blocked, claimed, in-review and done tasks.
- **Incident keys.** Creating a task with `dedupe_key` returns the open task with that key in the project instead of a duplicate, and counts the repeat ("Happened 6 times"). A repeat after it is done opens a new task.
- **Rules per agent** (Team, an agent's settings; `PATCH /api/v1/team-members/{id}`; MCP `set_agent_rules`): can it pick up unassigned work, does finishing close the task or send it to review, do its new tasks go live or wait for approval (as suggestions), and who it escalates to. Defaults keep today's behaviour.

### Database
- `20261124000000_agent_work_blocks.sql`: claim, incident key and agent rule columns, the claim and next-task functions (service role only), task triggers that leave claims out of edits and unread marks, and `task_suggestions.goal_id` optional (a suggestion an agent's rules turned it into may have no goal).

## 2.0.11 (2026-11-23)

### Changed
- Triage plan items aim work at `owner`, `company`, `teammate`, `client` or `other` only; the older values one company's agents sent are no longer accepted. Audit question selections start with `AUDIT_QUESTIONS:` only.

### Database
- `20261123000600_neutral_names_only.sql`: renames stored plan items from the older `ciaran` and `agency` to `owner` and `company`, renames selections starting `GREG_QUESTIONS:` to `AUDIT_QUESTIONS:` (same meaning), and limits the addressee rule to the five values.

### Breaking
- An agent of your own that still sends `addressee: "ciaran"` or `"agency"`, or writes `GREG_QUESTIONS:`, must send `owner` or `company` and write `AUDIT_QUESTIONS:` instead. Such a plan item is now refused with a 422.

## 2.0.10 (2026-11-22)

### Changed
- An auditing agent's "findings are waiting on you" notification clears for any agent's name once no finding waits, not only one agent's exact title.
- An auditing agent's question selection is read from a project context entry starting `AUDIT_QUESTIONS:`. Entries starting with the older `GREG_QUESTIONS:` still read the same.

### Database
- `20261123000500_neutral_findings_notification.sql`: the findings trigger clears any notification titled "... findings are waiting on you" on the project.

## 2.0.9 (2026-11-22)

### Changed
- An agent project's pipeline strip shows its last merge again: it now reads the typed `pr.merged` event (older untyped rows still count).
- Agent wording fits any team's agents: "an agent" instead of "the dev agent" in task tooltips, the API docs and the MCP guide; directed turns are "a person messaging the agent" rather than Telegram; no "on the VPS" instructions.
- The API docs page shows a generic MCP config (`.mcp.json` for Claude Code and most clients) before the Hermes example.

## 2.0.8 (2026-11-22)

### Changed
- Database functions are locked down: the public (anon) key can call none of the app's functions, and signed-in members only the ones their screens, row policies and checks use. Each function already checked permissions inside; this closes the door as well.
- `npm run test:function-grants` (part of `test:core`) fails when a function is open wider than it should be.

### Database
- `20261123000400_function_grants.sql`: revokes EXECUTE from PUBLIC and anon on every function in `pm`, keeps members only on the functions they need, keeps the service role on everything it had, and removes Supabase's default grants on new functions in `pm` (and anon's in `pm_custom`). Postgres still gives every new function to PUBLIC, so each new core function revokes it itself, and the test checks.

### Breaking
- Your own browser code can call only the core `pm` functions listed in `scripts/verify-function-grants.ts`; call any other from your server code (`src/custom/api.ts`). Your own functions in `pm_custom`: Postgres still lets everyone call a new function, so add `REVOKE ALL ON FUNCTION pm_custom.your_function(...) FROM PUBLIC, anon` to any the public must not call.

## 2.0.7 (2026-11-22)

### Changed
- The live 3D agent room (Agent > Live, `/live`) is gone from the app, with its 3D models and textures (about 18 MB), the YouTube jukebox route and five 3D libraries (`three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing`, `suncalc`). It was built around one company's four agents. Old links (`/agent/live`, `/live`, `/command`) open the Agent page.

### Breaking
- If your own code in `src/custom` imported anything from `src/components/command` or used those libraries, add the libraries to `package.json` yourself and copy what you need into `src/custom`. The `team_members.scene_preferences` column stays for now and is no longer read or written.

## 2.0.6 (2026-11-22)

### Changed
- The live agent floor (`/live`, Agent > Live and `/api/live/state`) needs a signed-in member who manages agents. It was open to anyone with the address and showed real task titles, reviews and agent activity.

### Breaking
- A screen that showed `/live` without signing in (a wall display, a shared link) now lands on the sign-in page. Sign in there with an account that manages agents.

## 2.0.5 (2026-11-22)

### Changed
- The live agent room (Agent > Live) seats any workspace's agents: four stations by role (auditor, planner, builder, reviewer), filled by name, then by job title, then by any agent left, and labelled with each agent's own name or the role.
- Triage plans name who work is aimed at as `owner` or `company` (with `teammate`, `client`, `other`). Agents that still send the older `ciaran` and `agency` keep working: they read as `owner` and `company`.
- Review, inbox and settings text no longer names one company's people or clients: "Reviewed and waiting on your merge", example addresses like `acme@yourdomain.com`, neutral MCP profile descriptions.

### Database
- `20261123000300_neutral_addressee.sql`: `plan_items.addressee` accepts `owner` and `company` (the older values stay valid) and defaults to `owner`.

## 2.0.4 (2026-11-22)

### Changed
- A new install whose database is not ready shows **Set up the database** with the steps (run `supabase/schema.sql`, add `pm` and `pm_custom` to Supabase's exposed schemas) instead of a sign-in page nobody can use.
- The README, `.env.example`, agent skills and guides match 2.0: five required variables, the rest optional or set in Settings; the setup screens in order; receiving client email with Resend; your own tables in `pm_custom`; webhook retries turned on in Settings > Developers.

## 2.0.3 (2026-11-22)

### Changed
- Settings > Developers > Webhook retries shows only while retries are off. Turned on there, it shows the result, and it is gone on the next visit: once on, there is nothing to manage.

## 2.0.2 (2026-11-22)

### Added
- Settings > Workspace > Brand: "Show active projects" lists the first five active projects in their own section of the sidebar, now set apart from how the Projects item works (Page opens the Projects page, Menu folds the active projects under it). Each workspace keeps what its sidebar showed; the setup wizard's presets set both.

### Changed
- Settings > Workspace > Encryption shows only while there is something to do: the app key is missing or invalid, or saved values still use the older keys. After a move it shows the result, and it is gone on the next visit.
- Every migration run refreshes the app's scheduled jobs (pg_cron) in a transaction of their own. A large migration, like the 2.0 move, could leave pg_cron running its jobs as they were before, so webhook retries failed. Installs already on 2.0 are fixed by their next deploy that applies database updates, or by running `npm run db:migrate` once.

### Database
- `20261123000200_sidebar_active_projects.sql`: `workspace_brand.sidebar_active_projects`, on where the sidebar listed projects (`sidebar_projects` = list), off where they were a menu.

## 2.0.1 (2026-11-22)

### Changed
- Core checks pass on installs and the public repo again: the task source test no longer rebuilds an old schema from this repo's own git history, which differs there.

## 2.0.0 (2026-11-23)

The app moves into its own schema, so it can share a Supabase project with a company's other apps: their tables, logins and data stay theirs, and the app's updates only ever change the app's own schema.

### Added
- Everything the app makes lives in schema `pm` (an install's own tables in `pm_custom`). Nothing of the app is created in `public`. Supabase-global names carry a prefix: storage buckets `pm-<name>`, storage policies `pm: <name>`, scheduled jobs `pm-<name>`, Vault entries `pm_<name>`.
- Install into a Supabase project that already has other apps ("Using a database you already have" in the README). Logins are shared and roles are not: an invited person who already has a confirmed login signs in with it, with their own PM role, and the app never changes the email or password of a login it did not create.
- On such a project, claiming the Owner account needs a setup code from the host (`PM_SETUP_CODE`); someone who already has a login can claim with it.
- `npm run test:pm-schema`: a fresh install matches an upgraded one, and installing next to another app changes nothing of theirs.
- `npm run storage:copy-to-pm` and `npm run fix:custom-schema` (see Breaking).

### Changed
- Team members are added by the app's server (`pm.add_team_member`), never by a sign-up: nobody becomes a member just by having a login. Fresh installs have no trigger on `auth.users`; upgraded ones keep theirs until 2.1.
- Production builds apply database changes after the app has built, then check the database can serve the new version before it goes live. A failed build never leaves the database ahead of the live version.
- check:core reads custom migrations against `pm_custom` (files dated before 2.0 against `custom`).

### Database
- `20261123000000_move_to_pm.sql`: moves every table, view, sequence and function of the app from `public` and `communications` into `pm`, with its data, indexes, constraints, row security, triggers and realtime. Only the app's own objects move (named in the file). Also: prefixed jobs, Vault entries and storage buckets (with their policies; the old buckets stay until 2.1), `custom` into `pm_custom`, and a bridge for the previous version during the deploy (views and wrappers in the old places, removed in 2.1).
- `20261123000100_team_members_from_server.sql`: `pm.add_team_member`, `pm.login_for_email`, `pm.logins_exist` (service role only) and `team_members.login_owned`.

### Breaking
- Take 1.11 first: it creates `pm` and `pm_custom` and adds them to Supabase's exposed schemas. Settings > Updates says if they are missing; the 2.0 build refuses to deploy until they are there, and the live version keeps running.
- The move runs with the update when your host has `SUPABASE_DB_URL` (automatic database updates). Otherwise run `npm run db:migrate` against production right after merging; until the move has run, the 2.0 build refuses to go live.
- Files: the build copies your files into the `pm-` buckets (or run `npm run storage:copy-to-pm`). Until it finishes, reads fall back to the old buckets, and links already sent keep working. The brand logos are linked from `pm-brand` directly, so if they cannot be copied the build stops and the live version keeps running.
- Your own code: run `npm run fix:custom-schema` (it changes `custom` to `pm_custom` in `src/custom`). New custom migrations use `pm_custom`.
- Anything outside the app that reads your Supabase tables directly (a script, another tool) must read schema `pm` instead of `public`. The app's own API (`/api/v1`) and its MCP server are unchanged.
- During the deploy, browser tabs still on the previous version stop getting live updates, and members' reads of projects and time entries there can fail until the tab reloads.

## 1.11.0 (2026-11-22)

### Added
- The empty schemas `pm` (the app) and `pm_custom` (an install's own), ready for 2.0, which moves the app into them so it can share a database with a company's other apps. The migration adds both to Supabase's exposed schemas itself, keeping every schema already listed. The setup wizard and Settings > Updates say how to add them when it couldn't.
- `npm run test:outsiders`: a signed-in account with no active membership reads and changes nothing in any of the app's tables.

### Changed
- Outsiders get nothing. An account with no active membership (another app's user on a shared Supabase project, or a deactivated member) could read the agent health, Trash event and region tables, and upload, change or delete files in the avatars, portal files and entity files buckets. Each now needs an active membership; members see no difference, and public file links keep working.
- The migration runner keeps its tracking table with the app's tables and never creates or reads one in a database that doesn't hold the app (or whose `public.app_migrations` belongs to another app).

### Database
- `20261122100000_pm_schemas_and_outsiders.sql`: the `pm` and `pm_custom` schemas, their exposure, and the members-only policies.

## 1.10.0 (2026-11-22)

### Added
- One encryption key for the whole app: `APP_ENCRYPTION_KEY` (64 hex characters) encrypts email account passwords, project credentials and integration secrets, with a separate key derived for each use.
- Settings > Workspace > Encryption (Owners) shows the key's state and moves values saved under the older keys onto the new one (`npm run secrets:reencrypt` does the same from a terminal).
- Integration secrets set in the app instead of the host, saved encrypted, with the host's variables still working as a fallback:
  - The Resend receiving key and webhook signing secret: Settings > Email > Receiving.
  - The GitHub update token and repository: Settings > Updates.
- "Turn on webhook retries" in Settings > Developers makes the scheduler secret, saves it, and writes it with the app's address into Supabase Vault. No hand-made secret or Vault entry.
- The setup wizard starts with "Connect your server" when a required setting is missing (`APP_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL`), with a key generated in the browser and the steps to add it. Nothing else opens until they are set; this only applies before the first Owner exists.
- When the Supabase settings themselves are missing, every page shows a plain setup page naming them, instead of an error.

### Changed
- `SMTP_ENCRYPTION_KEY` and `PROJECT_CREDENTIALS_ENCRYPTION_KEY` are no longer needed for new installs. On existing installs they keep opening what was saved under them until it has been moved. New values use `APP_ENCRYPTION_KEY` as soon as it is set, and the older keys until then, so nothing breaks before you add it.
- The setup checks list `APP_ENCRYPTION_KEY` as required (a value that isn't 64 hex characters counts as not set) instead of the two older keys.

### Database
- `20261122090000_app_secrets.sql`: the encrypted integration secrets table (service role only), and the Vault writer for webhook retries (made only where Supabase Vault exists).

### Breaking
- None for running installs. To finish moving: add `APP_ENCRYPTION_KEY` to your host and redeploy, run the move in Settings > Workspace > Encryption, then remove the two older keys once it says nothing is left. Keep a safe copy of the key: if it is lost, saved passwords and keys cannot be recovered.

## 1.9.0 (2026-11-21)

### Added
- Settings > Updates has a Database updates card for Owners: whether each update changes the database on its own while it deploys, a switch to turn that off and apply changes by hand, the steps to set it up when the host lacks the connection string, and a check that every database change this version carries has landed, naming any that did not.
- The setup wizard's checks include `SUPABASE_DB_URL`, so a new install knows on day one whether updates will change its database on their own.

### Changed
- Production deploys apply pending migrations whenever the host has `SUPABASE_DB_URL` (or `DATABASE_URL`), unless an Owner turned it off in Settings > Updates. `MIGRATE_ON_DEPLOY=true` is no longer needed; `MIGRATE_ON_DEPLOY=false` now keeps deploys from ever changing the database.
- Only an Owner can change automatic database updates or whether Owners read personal inboxes. Admins who manage business settings could change the second before; now the app and the database both refuse.

### Database
- `20261121090000_database_updates_switch.sql`: the Owner's switch for automatic database updates, and a guard so only an Owner changes it or the personal inbox policy.

### Breaking
- If your host has `SUPABASE_DB_URL` set but not `MIGRATE_ON_DEPLOY=true`, production deploys start applying database changes on their own from this release. To keep applying them by hand, set `MIGRATE_ON_DEPLOY=false` in your host before you take this update: that alone keeps deploys from changing the database. (Later you can turn the switch off in Settings > Updates and remove the variable.)
- A deploy leaves a database alone, with a warning in the build log, when the database has no record of its migrations (it was loaded from `schema.sql` without `npm run db:migrate -- --baseline`). Settings > Updates says so and gives the command.

## 1.8.0 (2026-11-21)

### Added
- A fresh install starts at the setup wizard. Step 1 is Create your account: the first account becomes the Owner, with no need to add a user in Supabase first. Until someone does it, every visit goes there; after that it is gone for good.
- The wizard's Email step connects the account invites and notifications are sent from (Google, Resend or any SMTP server), checking the connection before it saves, with an optional test email. If `SMTP_ENCRYPTION_KEY` is missing it shows how to add it.
- Owners can look through the setup wizard any time from Settings > Workspace > Features > Preview setup. A preview shows every step, the account step included, and saves nothing.

### Changed
- The setup wizard can no longer be skipped as a whole. Optional steps still have Skip for now.
- Projects as a menu in the sidebar (Settings > Workspace > Brand) starts closed every time the app opens, and stays as you leave it while you move between pages. It no longer has a New project link (new projects start on the Projects page or the Dashboard). All projects is the last item, shown when there are four or more projects or when some are completed or archived.

### Database
- `20261121080000_first_owner_lock.sql`: two sign-ups at the same moment can no longer both become the first Owner.

## 1.7.0 (2026-11-21)

### Added
- Region, in Settings > Workspace (Owners): the workspace's currency, its number and date format, and the day weeks start on, with a live preview and Undo. Every amount and date in the app, the client portal, invoice PDFs and emails follows it. The setup wizard asks for the currency and format with the parts of the app, and makes sure a currency is chosen when Client invoicing or Team pay is on.
- Invoices, retainers and billing plans keep the currency they were made in, so changing the workspace currency never relabels them. Retainers in different currencies on one project draft as separate invoices, and the invoice form only offers retainer months and tracked time in the invoice's own currency. Invoices in the public API carry a read-only `currency` (ISO 4217).

### Changed
- Money shows in the workspace currency and locale: no decimals from 1,000 up, the currency's decimals below only when there are any, and none ever for currencies such as JPY. Pay rates, payroll and earnings use the workspace currency. A single invoice always shows its exact amount; only totals round.
- Totals over invoices count only the workspace currency and say how many invoices in other currencies they leave out, instead of adding different currencies together.
- Calendars, date pickers, the timesheet and "this week" figures start on the workspace's first day of the week, Monday by default. Calendars and date pickers used to start on Sunday.
- Activity lines, Trash labels and billing notices written by the database show amounts in the record's own currency, with their cents as before.

### Database
- 20261121070000_workspace_region.sql

## 1.6.1 (2026-11-21)

### Changed
- Only the person or an Owner changes a sign-in email. The email decides who can reset the password, so an Admin could otherwise take over someone else's account, and with it their personal inbox.
- `npm run test:core` passes in installs again: a 1.6.0 test read an old schema by a commit only the source repository has.

## 1.6.0 (2026-11-21)

### Added
- A setup wizard for the first Owner: workspace name, logo and color; how you'll use it (a preset, then each part on or off); invoice details when Client invoicing is on; an email check; inviting the team; and the first projects. Every step can be skipped, and it picks up where it left off. A check at the top says if a required environment variable is missing. After it, the Dashboard shows a short Getting started list for anything skipped.
- Invitations: invited people get an email with a link to choose their own password (it works once and lasts 7 days). When email is not set up, the inviter copies the link instead. People who have not signed in yet show as Invited on the Team page, with Resend invite and Copy invite link.
- Personal inboxes: anyone can connect their own email in Settings > Email > Your inbox (Owners, Admins and Members by default), choose the agent that sorts it, and share it with named people. It is private: Owners see that it exists and whether it works, not its mail, unless an Owner turns on "Owners can read personal inboxes", which everyone then sees. The owner of a personal inbox triages it.
- Projects in the sidebar, in Settings > Workspace > Brand: a list of the first five (as before) or a menu of every active project under Projects. The wizard's preset picks one: a list for Agency, a menu for Internal team and Solo.

### Changed
- The theme follows the device live when set to System, keeps in step across open tabs, and a System choice on your account clears a Light or Dark left on the device.
- The Inbox is for any email about your projects, not only clients': wording across the Inbox, projects and tasks says email, and a project's client email domains and addresses are now its Sender domains and Sender addresses.
- Every project shows its Time tracking tab while Time is on; with tracking off for that project, the tab says so and offers to turn it on.
- Team pay is called Team pay everywhere (the Finances tab, its card and the Team row menu's Pay rate) and is one table of people. Members with approved hours and no pay rate are told to ask an Owner.
- Stat strips line up their values, fall back to two rows or a list before a label would be cut off, and agent analytics speaks plainly ("No usage data yet").
- One format for hours ("2.5h") and money (cents below $1,000, whole dollars above); counts are no longer in the code font.
- Settings > Client portal saves exclusions as you add or remove them, with Undo. On phones, the Settings tabs keep the current one in view.
- Sentence case for buttons and headings that were still in Title Case, and for table headers.
- Only Owners invite agents or send an agent a sign-in link, since an agent can sort personal inboxes.

### Database
- 20261121060000_personal_inboxes.sql
- 20261121061500_team_invites.sql
- 20261121063000_sidebar_projects_style.sql

## 1.5.0 (2026-11-21)

### Added
- Team pay, a module of its own: pay rates, payroll, payouts and each person's earnings. Client invoicing (the former Billing and finance) keeps invoices, retainers, payments and company revenue. Turn on either, both or neither in Settings > Workspace > Features.
- One Time view: your hours week by week, and the team's for people who see all time (each person's days in their own timezone, agent hours as worked time), with the review queue where approvals apply. It is a tab in Finances when a money module is on, and its own page at /time when neither is.
- Settings > Billing (Owners): invoice details with Client invoicing on, hour approvals with either money module on. Settings > Client portal holds the portal analytics exclusions.

### Changed
- With neither money module on, finished hours are approved as they are logged and stay editable. With either on, approved hours stay locked as before.
- The client portal no longer needs Contacts. Client emails now do: with Contacts off, none are sent.
- Finances is tabbed (Overview, Time, Payroll, My earnings), each tab shown only to people who may see it; the sidebar names the page each person actually gets.
- Settings starts with Account, then Updates and Workspace. /settings/business now opens Settings > Billing.

### Database
- 20261121050000_team_pay_module.sql

### Breaking
- Team pay arrives matching your current Billing switch. If you run payroll without client invoicing, turn Team pay on and Client invoicing off in Features.

## 1.4.0 (2026-11-21)

### Added
- Team member profiles: click anyone on the Team page to see who they are (role, local time, joined, last active), their open and recently finished tasks, their projects, their hours (with Time on), their recent activity and simple usage (active days, actions this month, last sign-in). What a viewer sees follows their role: Owners and Admins see everything, Members see a colleague's shared projects and tasks, Guests see only people on their shared projects. Edit, Permissions and a new Suspend / Reactivate action work from the profile and the Team page.

### Changed
- Numbers in a row are one stat strip instead of a grid of separate tiles, across the dashboard, finances, payroll, billing, portal analytics, agent analytics, project tabs and profiles. On phones a strip becomes a label and value list.
- `npm run upgrade` clears Next.js's generated route types before type-checking, so a leftover `.next` folder no longer fails the check after a merge.
- The loading screen no longer breaks a short workspace name mid-word.

## 1.3.0 (2026-11-21)

### Changed
- Owners only, by default: the Admin role no longer starts with company money (revenue, invoices, payroll, pay rates, payouts) or workspace setup (business details, email setup, webhooks). Admins still run the team, projects, tasks and hour reviews. An Owner can grant any of these to a person in Access control.
- A workspace always keeps at least one active Owner: demoting, suspending or removing the last one is refused.
- Guests (clients, contractors) see only the people on the projects they share, without email addresses, and cannot create API keys or open Trash.
- When the Inbox's database schema is not exposed in Supabase, the Inbox and Settings > Email say how to fix it, in place of a load error. The README install steps include it.
- Access messages say "Ask an Owner or Admin".

### Database
- 20261121040000_owner_only_defaults.sql

### Breaking
- Admins lose the money and workspace-setup permissions listed above. If an Admin needs them, an Owner grants them in Team, Roles & permissions or a person's Access control.
- New installs: in Supabase, Project Settings, Data API, add `communications` to Exposed schemas, or the Inbox stays off.

## 1.2.0 (2026-11-20)

### Changed
- The database is one file: `supabase/schema.sql`. The agent tables, API keys for agents and the API audit log (formerly `supabase/schema_ai_agent.sql`) are part of it, and the Features switches decide what is used. A fresh install runs that one file.
- A fresh install's API audit log, project goals, task suggestions and agent activity log get their intended access rules. Before, installs built from the schema files kept open rules on those four tables: any signed-in member could read and write them. The migration below fixes installs made that way.
- Removed an unfinished accounting invoice source draft (`supabase/schema/accounting-invoice-source.sql` and the `/api/internal/accounting/invoices/snapshot` route it needed), which no install used, and `supabase/seed.sql`, a stale demo data script that emptied the main tables.

### Database
- 20261121031500_agent_table_access_policies.sql

## 1.1.3 (2026-11-20)

### Changed
- A fresh install works: `supabase/schema.sql` and `supabase/schema_ai_agent.sql` now run on a new Supabase project without errors. Before, the SQL editor stopped partway (an outdated REVOKE, an Owner check a new database cannot pass, and a Realtime step naming a table the second file creates). The test database now applies both files strictly, the way Supabase does.
- `public/pdf.worker.min.mjs` is no longer tracked: `npm install` writes it, and on Windows its line endings made the working tree look changed, which stopped `npm run upgrade`. If an upgrade stops on that file, run `git checkout -- public/pdf.worker.min.mjs` and upgrade again.
- Core checks pass in the public repo: the update tests load libsodium in a way its 0.7.16 release supports.
- The first-run brand step says where the light logo shows.

## 1.1.2 (2026-11-20)

### Changed
- The email parser is postal-mime 4.2.1 everywhere: the monorepo's tests ran 4.0.4 while installs and production run 4.2.1, which keeps a text attachment's final line break. Core checks pass in the public repo.

## 1.1.1 (2026-11-20)

### Changed
- Core checks pass in the public repo and in installs: five more core tests read the schema from the monorepo's path.

## 1.1.0 (2026-11-20)

### Added
- Inbox: the agent's reply card under each email and meeting. It lists what the agent suggests or did, every task and reminder it made with its own action (Not a task, Not needed, Unlink, Restore), and Add all, Undo all and Restore all for everything at once.
- Inbox: reminders the agent set from an email have Not needed with Undo, like Not a task on its tasks.

### Changed
- A reload right after a change always reads fresh data, so Undo never shows the old state.
- Core checks pass in the public repo and in installs: a core test read the schema from the monorepo's path, and another failed now and then on timing.

## 1.0.0 (2026-11-20)

### Added

- Workspace modules. Owners switch whole parts of the app on or off in Settings > Workspace > Features: Time tracking, Billing and finance, Contacts, Leads, Client portal, Inbox, AI agents, Credentials and Webhooks. Presets (Agency, Internal team, Solo) set a mix at once, and modules that need another switch together. A module that is off is hidden everywhere, for everyone, Owners included; the API answers `403 MODULE_OFF`, MCP hides its tools and its background jobs stop. No data is deleted: switching it back on restores everything.
- First-run setup. On a fresh install the Dashboard asks the Owner to pick a preset or choose features, once.
- Brand settings. Owners set the workspace's name, tagline, description, brand color (the full shade scale is generated from one pick, with optional per-shade overrides), accent color, light and dark logos and favicon in Settings > Workspace > Brand. The app, the client portal, emails and invoice PDFs all read it, and a change shows on the next page load. With no logo uploaded, every place shows the name instead; with no favicon, one is drawn from the name's first letter and the brand color.
- A home for each install's own work, which core never edits, so updates never conflict with it: code in `src/custom`, database changes in `supabase/migrations/custom` (in a database schema named `custom`), files in `public/custom`, agent skills, agents and commands in `.claude/skills`, `.claude/agents` and `.claude/commands` under any name that does not start with `pm-`, and CI workflows in `.github/workflows/custom-*.yml`.
- Plug-in points in `src/custom`: sidebar entries, pages at `/x/<slug>`, project tabs, Dashboard cards, Settings pages, API routes at `/api/x/<path>` (signed-in members only unless a route says otherwise), public paths, and the theme and Next.js settings. Each item can follow a module, a permission or roles.
- Versioned releases. Each release is a `vX.Y.Z` tag and a GitHub release with these notes. `npm run upgrade` merges a release, keeps the install's own dependencies, scripts and crons in `package.json` and `vercel.json`, then installs, type-checks and runs the tests. It never pushes. A conflict in any other file stops the update and leaves the repo as it was.
- In-app updates. Settings > Updates shows the installed version, any newer release and its notes. With a GitHub token set up (`PM_GITHUB_TOKEN`, `PM_GITHUB_REPO`), an Owner prepares the update (a GitHub workflow merges it on a branch, runs the checks and opens a pull request), looks at the checks and preview, then applies it. Without the token, the page explains how to update with `npm run upgrade`.
- `npm run check:core`. It fails when an install has changed a core file or a custom migration reaches outside the `custom` schema, and says how to fix it. A GitHub workflow runs it with type-check, lint and tests on every pull request.
- A migration runner, `npm run db:migrate`. It applies new core migrations, then the install's own, each in its own transaction, and records them in `public.app_migrations`. `--status` lists applied and pending files and `--dry-run` shows what would run. With `MIGRATE_ON_DEPLOY=true`, production deploys on Vercel apply migrations before the build.
- Instructions for AI agents: `AGENTS.md` (core's rules), `src/custom/AGENTS.md` (the install's own facts), and the skills `pm-add-custom-feature`, `pm-add-custom-table`, `pm-upgrade` and `pm-propose-core-change`. In an install, a Claude Code hook stops agents from editing core files and points them to `src/custom` instead.

### Changed

- The AI agents module replaces the `NEXT_PUBLIC_ENABLE_AGENTS` environment variable.
- With Billing and finance off, Finances becomes Time and shows only time approvals, and approving time needs no pay rate.
- The client portal, billing crons, webhooks, payroll, budget emails and inbox plans each check their module. A portal link answers like an unknown link while the portal is off.
- Three internal pay functions that any signed-in user could call are now internal only.
- Invoice PDFs, emails and the portal read the logo, name and colors from Settings > Workspace > Brand, so an install's own brand reaches them.
- Open tabs pick up a module switch at once, and demo mode can switch modules.

### Database

- 20261120194316_workspace_modules.sql
- 20261120201517_module_guards.sql
- 20261121001500_workspace_brand.sql
- 20261121003000_neutral_relay_domain_default.sql

### Breaking

- Your repository must carry the public repo's history to take updates. If yours was made by copying files, clone the public repo, copy your own work into the client-owned paths above, and push that as your repository. `npm run upgrade` explains the steps if it finds no shared history.
- Adopt the migration runner once. First apply the four migrations under Database above if your database does not have them yet: in Supabase, open the SQL Editor, paste and run `supabase/migrations/20261120194316_workspace_modules.sql`, then `supabase/migrations/20261120201517_module_guards.sql`, then `supabase/migrations/20261121001500_workspace_brand.sql`, then `supabase/migrations/20261121003000_neutral_relay_domain_default.sql`, in that order (all four are safe to re-run). Then run `npm run db:migrate -- --baseline` with `SUPABASE_DB_URL` (or `DATABASE_URL`) set to your database's session or direct connection URL (not the port 6543 transaction pooler). After that, `npm run db:migrate` applies every new migration.
- `NEXT_PUBLIC_ENABLE_AGENTS` no longer does anything, and every module starts switched on. If you ran with agents off, switch AI agents off in Settings > Workspace > Features after updating, then remove the variable.
- The brand moved out of code into Settings > Workspace > Brand, and core no longer ships its own logo and favicon files. A workspace starts with the neutral name "Workspace", no logo and the default teal. After updating, an Owner sets the name, colors, logos and favicon there. If you changed the name, colors or logo in core files, restore those files first.
- Move any other edits you made to core files into `src/custom`, and any database changes into `supabase/migrations/custom` in the `custom` schema. `npm run check:core` lists what is left.
