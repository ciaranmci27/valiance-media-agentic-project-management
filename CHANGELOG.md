# Changelog

Every release has a section here, newest first. The release workflow publishes a version's section as its GitHub release notes, and the app shows it to owners before they update.

Each section starts with `## X.Y.Z (YYYY-MM-DD)` and uses these headings, leaving out any that are empty:

- `### Added`: new things an install can use.
- `### Changed`: existing behaviour that works differently.
- `### Database`: the core migration files in the release, one per line. `npm run db:migrate` applies them.
- `### Breaking`: what an install must do when it takes this release.

## 2.0.52 (2026-11-27)

### Changed
- **Agent limits are enforced, not advisory.** An agent over its budget, or holding a run past `max_run_spend_cents`, is refused every write a paused agent is (402 `budget_exceeded`, `run_spend_exceeded`); a run's cost and tokens only go up (409 `spend_decrease`), and usage under a run counts even when the run reports less. New per-agent limits `write_rate_per_minute` and `send_rate_per_minute` count across all its keys, and MCP handshakes count against the key's rate.
- **Safe defaults at hire.** A new company agent starts with 30 writes and 10 messages a minute and keys that end after 90 days, with no spend budget until an Owner sets one, pre-filled on the hire Access step and clearable (numbers in `src/lib/agent-defaults.ts`). Existing agents and keys keep what they had. A key list says when a key ends within two weeks.
- **Who an agent may ask.** An agent's approval (and a question whose answer acts) goes only to its managers, escalation target, people on the project who are not guests, its orchestrator chain or an Owner (422 `approver_not_allowed` with who it may ask). No agent asks a guest anything.
- **Act-for needs proof.** A pass for a chat account needs a message from it to that agent in the last 30 minutes (403 `act_for_no_recent_message`); a DM to someone who did not just write needs `chat.notify`, acting for them or not.
- **AI setup is boxed in.** A key a setup session makes carries at most its template's powers; money, people, settings, act-for, keys, webhooks and credentials wait for the Owner's Allow on the setup screen, as does a webhook to a new address. The setup screen lists every key the session made, with Revoke. A setup session may now set an agent's powers (`set_agent_powers`), within the same limits.
- A key with `api_keys.manage_all` that is not an Owner's never pauses, revokes, edits or strips an Owner's key or an Owner's agent's key (403 `owner_key_protected`).
- docs/operating/security-model.md: what the app guarantees, what to set up once, and the known limits.

### Database
- `20261127002500_agent_limits_security.sql`: write and send rates per agent, the write gate, spend that only goes up, run spend counted with its usage, AI setup keys and the requests that wait on the Owner.

### Breaking
- **Harnesses that act for chat users mint the pass right after the message arrives** (within 30 minutes), and DMs to people who did not just write need `chat.notify`. An agent asking a reviewer agent to approve must have it as its orchestrator, or ask a person.
- **An agent over its budget is held on every write, not only `start_run`**: 402 `budget_exceeded` (and `run_spend_exceeded` for an unfinished run past `max_run_spend_cents`) on anything a paused agent is refused. Heartbeats, telemetry, finishing a run and releasing claims still work. Only agents that already have a budget are affected.
- **Run cost and tokens only go up**: sending a lower `cost_usd`, `tokens_in` or `tokens_out` on `update_run` or a retried start is 409 `spend_decrease`. Send running totals.
- **New agent keys end after 90 days when no lifetime is sent**, including `create_api_key` for an existing agent and the successor of a never-ending agent key on rotate. A harness that mints keys without `expires_in_days` must renew them (the key list warns two weeks ahead).
- **Agents made over the API start with 30 writes and 10 messages a minute** (429 `write_rate_limited`, `send_rate_limited`), and MCP `initialize` and `tools/list` now count against the key's rate.
- **Approvals and questions whose answer acts go only to people the agent may ask** (422 `approver_not_allowed`), and a question to a guest is 422 `asked_guest`.
- A key with `api_keys.manage_all` that is not an Owner's gets 403 `owner_key_protected` on an Owner's key or an Owner's agent's key.
- **In an AI setup session**, keys come back without sensitive powers (`needs_owner_confirm` says which), a power outside the template is 403 `ai_setup_scope_outside_template`, a key with nothing left to grant is 422 `ai_setup_nothing_granted`, a webhook to a new address is made switched off, and `set_agent_powers` refuses sensitive powers (403 `ai_setup_needs_owner`).

## 2.0.51 (2026-11-27)

### Added
- **One AI area.** The sidebar's Assistant and Agents become one "AI" entry with three tabs: Your assistant (your own assistant, Connect AI and Chat accounts, moved out of Settings > Account), Company AI (the agents as an org chart with who each works for and who can use it, plus Runs and Analytics) and Setup (Owners: assistants, the agent service, chat apps, keys). With assistants off, nobody sees assistant screens; Owners get one card to turn them on. Old addresses (`/agent`, `/agent/<id>`, `/agent/new`, `/assistant`, `/settings/assistants`) redirect.
- **Needs you hub.** Every question, approval, blocked run, review and suggestion from an agent lands in one list, answered in one tap, with who asked, how long it has waited and what it unblocks. An agent comment starting with "[BLOCKED]" shows there too until agents send a blocked run.
- **An agent's Access tab.** Who it works for, who can use it, Ask first, Only through its orchestrator, Asks people directly, and what it may do as one list: its powers and its keys' scopes are one set, edited in the permission grid and saved to every live key (`GET`/`PUT /api/v1/agents/:id/powers`, MCP `get_agent_powers`, `set_agent_powers`). Keys live here: edit, pause, one-click Replace key (the old key works one more hour), revoke with one confirm.
- **Revoke unused keys** in Settings > Developers (keys never used or unused for 90 days, previewed first, with the keys each revoke would also take down; a key tree still in use or holding your own key is kept), with Active, Paused and Revoked tabs. `POST /api/v1/api-keys/revoke-unused`, MCP `revoke_unused_keys`.
- **Hiring starts with "Personal assistant or company agent?"** A new Orchestrator template (receives work, routes it to its team, settles their blockers, brings people one short question), a nudge to add one when hiring a second company agent, and docs/agents/structure-your-team.md. `POST /api/v1/assistants/for-person` (MCP `hire_personal_assistant`) gives one person their assistant.
- **Worker pools.** Several workers can run one agent: `instance_id` on runs, heartbeats and usage, with live workers on the agent (`live_instances`). Chat messages and conversations can be claimed like tasks (`/api/v1/chat/messages/:id/claim|extend|release`, `/api/v1/chat/conversations/:id/claim|extend|release`, MCP `claim_chat_message` and the others); follow-ups in a held conversation go to its holder. `GET /api/v1/chat/conversations/:id` (MCP `get_chat_conversation`). `resume_notes` on runs. A host key (`agents.host`, an Owner's key bound to some agents) reads their events at `GET /api/v1/events?agents=` and holds leases in their names, nothing else.
- **Answers that do the thing.** A question or approval can carry a whitelisted action (first: turning a project's time tracking on or off) that the app performs with the answerer's own permissions when they choose it. Every place a person answers shows one sentence the app writes from the action itself (never the agent's words), and says so when they cannot do it. Reads gain `proposed_actions[].sentence`, `you_may_perform` and `you_cannot`.
- **Blocked runs.** `PATCH /api/v1/agents/runs/:id` with status `blocked` and a reason tells the agent's managers and shows in Needs you until the run moves.
- `max_run_spend_cents` in agent limits stops a run that costs more. `next_task` and `get_my_status` say up front when work cannot start (`skip_reason: time_tracking_off`).
- **Everything in the app over the API and MCP.** About 75 new `/api/v1` routes and 200 MCP tools: Trash list and restore, project edit and archive, goals, brief entries, portal settings (never the link or PIN), pausing every agent, workspace settings, assistants, chat connections (never a token), notifications (done, snooze, groups), webhook delivery history, requeue and secret rotation, inbox rules and filing, a person's inbox decisions (people and their connected AI tools only, never agents), contacts and leads, identities, template runs, billing. Money and team writes need scopes agents never hold by default; `settings.manage` is new and never for agents.
- `POST /api/v1/context/clear` and `/restore` (MCP `clear_agent_notes`, `restore_context`): clear what an agent wrote in its own notes, with Undo.
- docs/operating/backups-and-recovery.md: what Trash covers, point-in-time recovery, copying Storage files, the encryption key, testing a restore.
- `npm run test:e2e`: real flows over HTTP on the local Docker stack (scripts/e2e/README.md).

### Changed
- **Specialists ask their orchestrator first.** A question from an agent that has an orchestrator, sent to a person, goes to its orchestrator unless "Asks people directly" is on (`ask_people_directly`); `requested_to` says who it was meant for. Approvals and questions that carry an action are not rerouted.
- **Security**: a portal PIN check is one locked step per portal with limits per visitor, per portal and per day, and an unreadable visitor address still counts. A link the chat bot sends to someone it does not know carries a short code to type on the confirm page. Changing your own email or password needs your current password (a fresh sign-in for Google-only accounts), signs out other sessions and tells the old address. Signed-in writes from another site are refused. An agent cannot pin notes into its own context or a person's memory. Portal visitors cannot upload web pages, scripts or SVG files; uploads are capped at 50 MB and 50 a day per portal. Every response carries HSTS (one year, this host only), nosniff, Referrer-Policy and frame-ancestors. Database errors answer in plain words. SMTP tests only try mail ports on public hosts. Revealing a saved credential in the app is audited. A key made by hiring an agent over the API goes down with the key that made it.
- A confirm dialog asks once (no second "Are you absolutely sure?").
- An agent restoring its own archived notes gets pinned ones back unpinned. A password reset link used too late says it timed out. `GET /api/v1/trash` answers in a few queries per page.
- The agent page's Rules and powers tab is called Rules.

### Database
- `20261127002000_agent_runtime.sql`: worker instances, chat conversations and claims, resume notes, host keys, run spend limit, blocked runs, actions on questions, orchestrator-first questions.
- `20261127002400_security_fixes.sql`: the portal PIN limiter and chat link confirm codes.

### Breaking
- **Agents under an orchestrator now send questions to it first.** If an orchestrator's harness does not answer its team's questions, turn on "Asks people directly" on the specialist's Access tab (or `PUT /api/v1/agents/:id/access` with `ask_people_directly: true`).
- **Signed-in writes need a same-site Origin.** A script that calls `/api/workspace/*` or other session routes with a browser cookie from another site is refused; use an API key and `/api/v1` instead.
- **An agent answering an acting question for its person must show them the action first.** When an agent answers for the person it works for with the choice that performs an action, it must have sent that person the action's sentence in chat since the question was asked, or the answer is refused with 409 `action_not_shown` (which carries the sentence to send).
- **Agents cannot pin their own notes.** An agent saving `pinned: true` into its own notes or its person's memory gets 403 `agent_cannot_pin`, and editing a pinned note there gets 403 `pinned_note_kept`. Save without `pinned` (a person pins what every run needs) and add a new note instead of editing a pinned one.
- **Revoking a key takes down the agent keys it made by hiring over the API.** Keys made that way before this release are not linked and stay.
- **Old AI addresses redirect.** `/agent`, `/agent/<id>`, `/agent/new`, `/assistant` and `/settings/assistants` redirect to `/ai`. Custom links keep working; update them when convenient.
- Apply this release's migrations with or before the deploy. Until they run, chat claims, host keys and blocked runs do not work, and a portal with a PIN stays locked.

## 2.0.50 (2026-11-27)

### Added
- **Orchestrators and who can use an agent.** An agent can work under an orchestrator (any depth up to 4, no loops), and the org tree reads at `GET /api/v1/agents/tree` (MCP `get_agent_tree`). Each company agent has "who can use it": everyone, roles, groups or people, with exceptions, limited further by every orchestrator above it. The app checks it everywhere work reaches an agent: assigning, chat, mentions, hand-offs, child runs, approving suggestions and repeats. An agent under an orchestrator takes work only from it, hands work only to its own team, and stops picking up unassigned work by itself. "Ask first" turns a request into one approval for the agent's managers. `GET`/`PUT /api/v1/agents/:id/access` (MCP `get_agent_access`, `set_agent_access`). See docs/agents/identity-and-access.md, "Orchestrators and who can use an agent".
- **Near-instant events without a public address.** `GET /api/v1/events` is a cursor feed (chat messages, answered questions, run updates, optional agent events) that waits up to 25 seconds for something new; `wait` also works on `GET /api/v1/chat/messages`. MCP `get_events`. Cost, limits and failure handling are in docs/agents/events-and-webhooks.md. New docs/agents/what-belongs-where.md: what the core owns and what a harness or install owns.
- API key Pause and Resume in Settings > Developers and on an agent's Connect tab, with Undo.
- Notifications show who sent them.
- One logo set for the services the app connects to, with a state badge (connected, waiting, problem), and a provider picker where you used to type a provider.
- Template warnings when key dates are out of order or a task is due before one it waits on; validate answers `warnings`.
- `download_url` (a short signed link) on file reads over the API: entity files, invoices, portal updates and their attachments.

### Changed
- **Security**: files in project, lead, contact, invoice and portal storage are private and open through short signed links; who may read, change or delete a file follows the record it belongs to. Comments cannot be moved to another task or given another author. Time entry links follow the time entry. Lead notes are shown as safe text. The sign-in check now runs on every page (signed-out visits go to the sign-in page) and the API answers cross-origin requests. Notifications are limited to records sender and recipients can both open, links to that record's pages; a link that is not an in-app path is dropped and the notice still goes out. Guests no longer send notifications directly; their comments and uploads still notify the team. Request bodies over 1 MB (5 MB with inline files, 6 MB for MCP) answer 413. A task the caller cannot see answers the same 404 as one that does not exist. Webhook endpoints only receive events their creator can read. Avatar links must be https or the app's own.
- **API**: a page past the end answers an empty page (was 500), and every list keeps a stable order across pages. Dates accept YYYY-MM-DD or any ISO 8601 date-time, stored as the date written, and refuse days that do not exist; years 1900 to 2200. Text has sensible limits (title 500, name 200, description 100,000, comment 50,000, 50 tags) and refuses invisible control characters; bodies nested deeper than 64 levels answer 422. Every 429 carries Retry-After. The person or agent asked can answer a question with `questions.ask` or `approvals.decide`.
- **Agents and schedules**: with the AI agents module off, agent keys get `403 MODULE_OFF` and agent-run schedules wait. Resuming a schedule on a skipped day runs it that day. A schedule that pauses itself tells its people. Questions to someone who is suspended expire and the asker is told. A power given to an agent with a key is taken back when it leaves the agent's last key. Reorder and assignee changes are safe under concurrent use. Run history keeps whole chains together until all of it is past retention.
- **Screens**: a name can no longer be saved empty. Guests see only the questions and approvals that involve them. Analytics counts only finished runs in success rates. The audit log reads in plain words. One time zone rule: your profile's zone, from your browser until you choose one. The agent page no longer shifts while it loads. Hiring cannot create the same agent twice. Moving to Trash acts at once with Undo.

### Database
- `20261127001000_agent_hierarchy_access.sql`: orchestrators, who can use an agent, ask first.
- `20261127001100_event_feed.sql`: the event feed and its 7-day pruning job `pm-event-feed-prune`.
- `20261127001200_security_hardening.sql`: storage access rules and private file buckets, comment and time link rules, server-set fields.
- `20261127001300_api_hardening.sql`: an expired claim cannot be extended.
- `20261127001400_lifecycle_fixes.sql`: schedules, suspended members' questions, key-given powers, safe reorder, run retention.
- `20261127001500_ui_fixes.sql`: guest question visibility, hire requests, finished-run counts, the time zone flag.

### Breaking
- **Apply this release's migrations with or before the deploy.** New code before the migrations: reordering tasks, `GET /api/v1/events` and setting an agent's access answer 503 until they run. Migrations before new code: stored file links stop opening in the previous release's screens (client portal included) until the new code is live.
- **A webhook endpoint follows its maker's reach.** It stops receiving a project's events when the person or agent who made it cannot read that project (or is suspended). Check endpoints made by people who have since lost access.
- **Signed-out visits now redirect to the sign-in page** (the request filter never ran before). An install that relied on a page being open without signing in must list it in `src/custom/middleware.ts`.
- **Stored public file addresses no longer open.** API readers use `download_url`.
- **With the AI agents module off, agent keys are refused** (`403 MODULE_OFF`).

## 2.0.49 (2026-11-27)

### Added
- **Edit an agent's key in place**: "Edit name and access" on agent keys in Settings > Developers and Edit on each key in the agent's Connect tab. An Owner can add a power the agent's role lacks (such as Act for a person) right there; it is granted to the agent and put on the key in one step, with no new key to copy.
- **A private release repository works too.** Optional `PM_UPSTREAM_TOKEN` (a read-only token for the release repository) lets Core checks, the Core update workflow, `npm run upgrade` and Settings > Updates read releases when the repository is private. With a public repository and no token, nothing changes. `npm run upgrade -- --fetch-only` fetches release tags and prints the newest, merging nothing (it adds the `upstream` remote if it is missing).
- **One design system, written down and checked.** `DESIGN.md` has binding Rules for every screen. New shared pieces: `Pill`, `PanelHeader`, `Card`, `EmptyState`, `UndoLine`, `SaveBar`, `IconButton`, `ShowMore`, `Tabs`, `FilterButton`, `LineChart`, `PermissionGrid`, and one time format family (`src/lib/time-format.ts`). `/design` shows every pattern with the real components, in light and dark. `npm run check:design` fails on banned markup above a baseline that only goes down; it checks custom code in `src/custom` too.
- A toast can carry one action, such as Undo.
- `AGENTS.md` release rule: everything a person can do in the app ships with its REST route and MCP tool, or a stated reason it must stay with a person.

### Changed
- Roles & permissions refuses to give an agent a permission on the app channel (`422 agent_api_only`): agents only use the API, so the grant would do nothing. Removing an old one still works.
- The Core update workflow scopes each GitHub token to its own repository URL.
- Status labels are sentence case ("In progress") everywhere and use five tones; `Badge variant="purple"` now shows the brand tone.
- A person or agent has the same avatar tone and initials everywhere; avatar colors no longer come from the brand color.
- Times read one way: "5 min ago", "2 h ago", "Yesterday", "Nov 26"; durations "16 min", "1 h 5 min".
- Side panels have one header, with no uppercase label above the title.
- A selected stat is underlined in the brand color instead of filled. Cards are padded 16px on phones and 20px on wide screens.
- Light mode: pale status text and unticked boxes now meet contrast.

## 2.0.48 (2026-11-27)

### Added
- **Set up agents with AI.** Hire an agent now starts with "Set it up with AI" or "Step by step". An Owner lets a connected AI tool (Claude, ChatGPT) set up agents for one hour, or makes a one-hour setup key for a tool that is not connected. The page shows each agent as the AI makes it, with Review and End access now. Over MCP the session adds `hire_agent` and the setup tools only; over REST, `POST /api/v1/agents/hire`. Every change is recorded as the tool acting for the Owner.
- **API keys you can manage**: Pause and Resume (the secret keeps working again on resume), edit a key's name and scopes, and each key's state (active, paused, expired, revoked) with a `state` filter. Over the API: `POST /api/v1/api-keys/:id/pause` and `/resume`, `PATCH /api/v1/api-keys/:id`, MCP `pause_api_key`, `resume_api_key`, `update_api_key`. Every change is in the audit log with before and after.
- **Hiring and agent profiles**: upload a picture when hiring or later from the profile, a review step before hiring, powers beyond the agent's role (Owner only), the key in the connect snippets' header, a webhook field, and Take off project.
- **Settings > Assistants** starts with the Agent service step (its key shown once, then Waiting, then Connected). Chat connections show Waiting, Connected, Quiet, Not receiving or Off; a bot token or Slack signing secret can be replaced in place; messages sent while an assistant was paused are delivered when it works again.
- **Notifications foundation**: mark notifications done, snooze anything until later, a grouped feed, and one Needs-you count shared by My Tasks and Agents. `GET /api/v1/notifications` gains `view` and `category` filters and new fields.
- **Agents home**: a Decided view, and declining a suggestion with a reason.
- **Projects and groups**: change the template a project's agent works from, Pause here for an agent with access but no setup, Mark checked on entries an agent wrote, a group's "Used for" list, and "Also change the role of anyone already in it" when adding people to a group (`only_new`).
- **Settings**: audit log CSV export, a preview of what a shorter retention removes, a preview of the keys a revoke takes with it, and each webhook endpoint's health.
- **Design rules**: `DESIGN.md` now has binding Rules for every screen, and `AGENTS.md` points every builder at them.

### Changed
- Notices that announce something waiting on you (a question, an approval, an agent's findings, an inbox decision) no longer appear in the Notifications list or its count; the item itself lives in My Tasks or Agents, counted once.
- A paused key's replaced secret stops working too, and a key cannot be rotated while it is paused.
- Removing an agent from a project's members also removes its setup on that project.
- Adding people to a group no longer changes the role of anyone already in it unless you tick the option.
- An added key scope must be held by the person editing the key as well as by the key's member. An AI setup key cannot be edited, paused or rotated.
- Replacing a Telegram bot token refuses another bot's token before touching that bot's webhook.
- Keys an AI setup session makes for agents do not depend on the setup key, so revoking it later leaves them working.

### Database
- `20261127000100_assistant_fixes.sql`: personal agents held while Assistants is off, chat connection refusals, switching a connection's agents in one step.
- `20261127000200_agents_home_fixes.sql`: one display status for agent runs, and runs in the feed name their task.
- `20261127000400_project_agent_fixes.sql`: an agent's project setup goes when its project membership does; pinning keeps an entry's updated time.
- `20261127000500_ai_setup.sql`: AI setup sessions.
- `20261127000600_key_management.sql`: pausing API keys.
- `20261127000700_notifications_foundation.sql`: notification categories, done and snooze, the grouped feed.

### Breaking
- **Personal agents need Assistants on.** While Settings > Assistants is off, personal agents are held: their writes get `423 assistants_off`. If you run personal agents, turn Assistants on before or right after updating.

## 2.0.47 (2026-11-26)

### Added
- **Templates live with the work.** Settings > Templates lists company-wide and project-only templates with a switch between them, and every project has its own templates behind "Manage templates" at the foot of the "From a template" picker. The Templates sidebar entry is gone; `/templates` now opens Settings > Templates.
- **A new template editor**: key dates ("Launch date", with one main date), roles (required or not, with a default person), fill-in fields (text, date, person or choice), an AI guidance note, and steps that are due a number of days before or after a key date, done by a role, a person or whoever runs it, and that can wait on other steps. Problems show at the exact field as you type, and Save waits until there are none.
- **Running a template** is a short flow: key dates, roles, fields, then a preview of every dated, assigned task (past due dates flagged) before anything is made. By default the run creates an initiative for its tasks, and you land on it.
- **Change dates**: an initiative made from a template shows which template and key dates it came from, and Change dates moves its unfinished tasks with the new dates, after a preview that lists what moves and what keeps its date (tasks you changed by hand stay unless you tick them). Over the API: `POST /api/v1/task-templates/runs/:runId/reflow` (MCP `reflow_template_run`) with `dry_run`.
- **AI drafts a run, a person approves it.** An agent proposes a run (`draft_template_run`, `POST /api/v1/task-templates/:id/drafts`), which becomes an approval for a person. The project's Initiatives tab shows a Needs approval card, and the approval offers Review: the same dated task list, with steps the agent added or left out marked. Only a person approves, the tasks are created as them, and a draft is never run twice.
- **Recurring work on one scheduler**: schedule a template (every Monday, the 1st of each month, the last Friday, every 2 weeks, in your time zone, with an end date), with its own roles and fill-ins, optional initiative per run and "skip if the last one is still open"; and Repeat on any task, on a schedule or after it is done, copying title, description, people, tags, priority, initiative and subtasks with shifted dates. Missed dates after downtime run once; a schedule whose owner lost access, was paused or turned the assistant switch off pauses and says why. Settings > Templates lists schedules with their next run and history. API `/api/v1/schedules`, `/api/v1/task-templates/:id/schedules`, `/api/v1/tasks/:id/repeat`, and MCP tools.

### Changed
- Edit project, the template editor and the initiative panel share one "discard changes?" guard.
- An install's own sidebar item placed after Templates now sits after Projects.

### Database
- `20261126000300_template_reflow_drafts.sql`: AI-drafted template runs and their approval, and moving a run's dates.
- `20261126000400_schedules.sql`: schedules for templates and repeating tasks, their occurrence history, and the `pm-schedules-due` job.

## 2.0.46 (2026-11-26)

### Added
- **Initiatives**: a named body of work inside a project, with an owner (a person or a group), a status (planned, active, paused, done), its health while active (on track, at risk, blocked), dates, and its own tasks, log and brief. A project's new Initiatives tab shows each one as a card with its progress; an initiative's page has its Tasks (the project board, kept to its tasks), a Log of updates, decisions, issues and notes, and a Brief. On the project's Tasks tab, filter by initiative, see each task's initiative on its card, and set it on a task. A task belongs to at most one initiative; subtasks follow their parent; moving a task to another project clears it. Guests see initiatives and progress but never the log, and the client portal never shows them.
- Initiatives over the API and MCP: `/api/v1/projects/:id/initiatives` (with `/entries`), tools `list_initiatives`, `get_initiative` (an agent's starting read: header, progress, open issues, recent log, pinned brief), `create_initiative`, `update_initiative`, `list_initiative_entries`, `add_initiative_entry`, `update_initiative_entry`; `create_task`, `update_task`, `search_tasks` and `GET /api/v1/tasks` take `initiative_id`; `get_task_brief` adds the task's initiative. Webhooks `initiative.created`, `initiative.updated`, `initiative.deleted`, `initiative_entry.created`, `initiative_entry.updated`; `task.*` payloads add `initiative_id`.
- **Templates, version 2 (API and MCP)**: named key dates (each task due a number of days before or after one, negative allowed), roles mapped to a person or agent when the template runs (optionally required, with a default member), dependencies between top-level steps (carried onto the real tasks), a guidance note for AI, and a template that belongs to one project or to the whole company. A run can create an initiative for its tasks (`create_initiative: true`). Agents build templates predictably: `GET /api/v1/task-templates/schema` publishes the format, `validate` returns every error with its exact path and a fix hint, and `preview` shows the exact dated, assigned task list a run would create, writing nothing. See `docs/agents/templates.md`.

### Changed
- A project's own templates are written by whoever manages the project; company-wide templates still need `templates.manage`.
- `template.run` payloads add `key_dates` and `initiative_id`.
- The unsummarized-triage and inbox questions lists accept `handled=me`.

### Database
- `20261126000100_initiatives.sql`: initiatives and their log, `tasks.initiative_id`, the initiative brief scope, Trash, activity, live updates and webhooks for them.
- `20261126000200_templates_v2.sql`: template key dates, roles and guidance, a run's key dates, role members and initiative, and the link from a run to the tasks it made.

## 2.0.45 (2026-11-26)

### Changed
- A reviewer agent asked directly for an approval or a question that names the asker's run (`run_id`) can start its own run under that run (`parent_run_id`), so builder and reviewer sit in one run tree. This works while the question is open, or for 24 hours after it is answered; group questions do not link.
- Run trees show only the place in the chain, not the title or task, for runs on projects the reader cannot open.

## 2.0.44 (2026-11-26)

### Changed
- **Settings > Updates shows where you are.** Up to date is a calm confirmation with when it last checked. An available update is one clear "X is ready" with how far behind you are, any breaking or database notes called out, and Update now. While updating, the page is a single progress view (step N of 4, how long it has run, what is happening now) with nothing asking you to act until Apply; a stopped update says what failed and the one thing to do; a deploy that takes over 30 minutes says so and points at your host's deploys; afterwards it says "You're on X" with what changed.
- Owners see a small update mark beside their profile in the sidebar and beside Updates in Settings: a dot when an update is available, a progress ring while one runs, amber when it needs you or the deploy is slow, red when it stopped.
- Update now, Try again and Apply update show only when the GitHub connection can update; otherwise the page shows what to fix.
- Connect AI is no longer linked under the profile in the sidebar; it stays in Settings > Account.
- Core checks pass on Windows checkouts that convert line endings.

## 2.0.43 (2026-11-26)

### Changed
- Step headers in dialogs and setup flows fit the space they sit in: every step name where there is room, only the current step's name in a narrower dialog (others on hover), and a compact progress bar when narrow. The Add chat app dialog's fourth step no longer runs off the edge.

## 2.0.42 (2026-11-26)

### Changed
- Slack messages from agents never notify a whole channel: `<!channel>`, `<!here>`, `<!everyone>`, user groups and any other broadcast form arrive as plain text. People mentioned by name still are.
- A Discord reply that saves or drops a channel webhook no longer undoes a relay secret rotated at the same moment.

## 2.0.41 (2026-11-26)

### Added
- **Company chat**: a chat connection is now either for personal assistants (direct messages only, as before) or for company AI. A company bot reaches the agents an Owner picks: mention one by name, map a channel to one, or message the bot directly for the default. Each channel listens to mentions only or to every message (kept as context, never answered). Replies go in a thread, can also go to the channel or privately to the sender, and on Slack carry the agent's name and picture. The sender is who the work is for, so the agent never does more than both may. New webhook `chat.message` and routes `/api/v1/chat/messages`; see `docs/agents/company-chat.md`.
- **Approvals name who decides**: an approval goes to a person, a group, or an agent named on purpose (a reviewer agent decides with its own key; nobody approves their own request). A person's approval is decided in the app, or over the API only with a key that carries the new `approvals.decide`; a connected AI tool can never decide one. Every decision records how it was made (`decided_via`: app, api_key, agent, act_for).
- **Agent watchdog**: every 5 minutes the app notices what time changed. An agent that stops responding tells its owners ("Nova stopped responding 12 minutes ago") and again when it is back; webhooks `agent.offline` and `agent.online`. Runs idle for 2 hours are stored as timed out (`run.finished`). Questions past their expiry close and tell whoever asked (`question.expired`). A webhook that keeps failing tells the Owners.
- **Keeping data** (Settings > Security, Owner): how long to keep webhook deliveries (30 days by default), uptime history (90 days), agent events, finished runs and chat text (forever by default). A daily job applies it.
- **One webhook for every assistant**: an endpoint can serve every assistant an assistant setup made (`assistant_setup_id`), instead of one endpoint and secret per person.
- **API version**: every `/api/v1` answer carries `X-PM-API-Version`, every webhook envelope carries `api_version`, and the tool catalog returns it. `docs/agents/README.md` states the compatibility promise: the contract only gains fields, and removals are announced first.
- **Discord** is a third chat app beside Slack and Telegram, for personal and company connections. Discord sends messages only over a live connection, so each install runs the small relay in `relay/discord` (one command or Docker) on a server it controls; the app signs and checks every relayed message. Company replies carry each agent's name and picture through a channel webhook.
- **Chat apps in Settings** start from Slack, Telegram and Discord cards, then one Add chat app action that offers only the connections still free.
- **Agents can start a conversation**: `POST /api/v1/chat/messages` (MCP `send_chat_message`). A personal assistant messages only its own person; a company agent posts only in channels mapped to it, and messages a person directly only while acting for them or with the new `chat.notify`. Replies come back to the same agent. Rate limited per agent and per recipient.
- **Files in chat**: photos, voice notes, audio, documents and video from Telegram, Slack and Discord arrive as attachments, and the agent a message went to downloads them through `GET /api/v1/chat/messages/{id}/attachments/{n}` (never exposing a provider address or token; 20 MB cap).
- **Waiting on a person**: a run can be `waiting` while its agent waits for an answer. A question or approval may name its `run_id`; the run waits while the question is open, and goes back to running when it is answered, so human-gated work never times out. A run set to waiting by hand times out after 7 days. Webhook `run.updated`.
- **Chains of agents**: `delegate_task` with `mode: assign` hands a whole task to another agent, so a person, their assistant, a company agent and its specialists form one run tree at any depth (up to 8), with the person recorded as who it is for throughout. Cycles and deeper chains are refused, and a hand-off never widens access.
- **Agents that work in other systems**: `GET /api/v1/agents/me/status` (MCP `get_my_status`) tells any agent key whether it may start work (paused or over budget), with webhooks `agent.paused`, `agent.resumed` and `budget.exceeded`. The new `questions.ask` lets an agent ask people or request approvals without project access, approvals can link to the thing they are about (`action.external_url`, shown as "Open in ..."), and a new External agent template sets this up. See `docs/agents/external-agents.md`.

### Changed
- Email-made tasks, reminders, reply-draft notices and "needs you" notices follow each inbox's own defaults (default assignee and project, primary handler, decision recipient) whenever a request leaves them out. A triage plan's new task follows the agent's create rules, so an agent that needs sign-off makes a suggestion. The person who asked for a draft hears when it is ready.
- Agent spend is counted once: a run's own totals, plus usage and turns that name no run. Budgets and Analytics use the same rule, so a budget can no longer be passed by spend reported two ways. Usage may name its run (`run_id`).
- Webhook retries are on by default when webhooks are set up; an Owner can turn them off.
- Webhooks are only sent to public addresses (private, loopback and cloud metadata addresses are refused, and redirects are not followed). Set `WEBHOOKS_ALLOW_PRIVATE_TARGETS=true` for receivers on your own private network.
- New inboxes use plan-based triage. Older email triage routes, tools and fields are marked deprecated in the API docs with their replacements, and the deprecated tools are left out of the tool list; all of them keep working.
- `/api/v1/assistant/messages` and `assistant.message` are deprecated aliases of the chat routes and `chat.message` for personal assistants.
- Every API route states its permission explicitly. The audit history route always needs `audit.read`.
- Agent spend records who the work was for, so it can be split by person.

### Database
- `20261125000700_approval_decisions.sql`: how approvals were decided, and `approvals.decide` for admins and members on the API.
- `20261125000800_agent_spend.sql`: one rule for agent spend, used by budgets and Analytics.
- `20261125000900_webhook_setup_scope.sql`: webhook endpoints for an assistant setup, and single-pass webhook fan-out.
- `20261125001100_chat_targets.sql`: personal and company chat connections, the agents and channels a company bot reaches, and chat context.
- `20261125001200_contract_cleanup.sql`: plans as the default triage mode for new inboxes, and `api_version` on webhook envelopes.
- `20261125001300_watchdog_retention.sql`: the agent watchdog, retries on by default, and data retention.
- `20261125001400_external_agents.sql`: agent status, pause and budget events, and `questions.ask`.
- `20261125001500_chat_outbound_media.sql`: messages agents start, chat attachments and their retention, and `chat.notify`.
- `20261125001600_delegation_chain.sql`: how a task was handed on, and depth and cycle guards for chains of runs.

## 2.0.40 (2026-11-25)

### Added
- **Inbox handling for agents**: `GET /api/v1/inbound-emails/{id}` (also `/api/v1/inbox/messages/{id}`) and `GET /api/v1/inbox/messages/{id}/context` add `handled_by_me`, `primary_handler`, `default_assignee`, `default_assignee_ids` (a group default resolves to its leads), `default_project_id` and `decision_recipient` to `inbox`. `latest_triage` carries `category`. The email list (`GET /api/v1/inbound-emails`, MCP `list_inbox`) accepts `handled=me`.
- **An assistant that cannot answer says so in chat**, once per hold: on hold, paused by its person (with a link to resume) or unable to answer (its admin is told). Strangers and group chatter not addressed to it get nothing new.
- An assistant on hold whose host stopped reporting shows "On hold. Its host is not responding." on its person's page and in Settings > Assistants > Status, and admins are told once a day.
- Agent owners without `agents.manage` can open their own agent's page, with what they may change. `GET /api/v1/agents/{id}` adds `is_owner`.

### Changed
- The sidebar Agents badge counts everything in Needs you (questions, approvals, blocked work, reviews and suggestions), the same number as the tab.
- Agents > Analytics opens on Runs; Revenue and Profit come after Runs, Busy time and Tokens.
- Agent keys are made in the same step dialog as personal keys.
- Linked chat accounts are called "Chat accounts" in Settings > Account and on the Assistant page, with Unlink in both.
- Pause or resume one agent from its profile header in one click.
- Webhook signing secrets stored before encryption are sealed the next time they are delivered with or revealed, when `APP_ENCRYPTION_KEY` is set. Signatures do not change.
- Audit retention no longer keeps rows only because they name an agent template.

### Database
- `20261125000600_table_grants.sql`: the browser database roles hold only the table rights the app uses (anon reads only the workspace brand; signed-in members keep exactly what their row policies allow, never TRUNCATE, REFERENCES or TRIGGER), the same for future tables, and the audit retention change.

## 2.0.39 (2026-11-25)

### Changed
- **A real conversation stays in the Inbox.** A conversation the agent ever read as work no longer moves to FYI when a later read finds nothing left to do; it stays in the Inbox as handled. Only mail that never needed anyone goes to FYI.
- **A reply draft waiting to be copied keeps its conversation in the Inbox**, with a "Draft ready" pill, until it is copied, a newer email arrives, or a person marks it handled. The list updates as soon as a draft is written or copied.
- **A forward and the sender's later reply are one conversation.** When someone forwards a client's email in and the client then replies directly, the reply joins the same conversation (same inbox, same subject, within 30 days, exact address match). New mail only; existing conversations are not merged.
- The reply draft shows as the agent's card ("Drafted a reply", your request, the draft, Copy and Ask again) and takes the place of a quiet "No action needed" line.

### Database
- `20261125000500_inbox_threads.sql`: reply drafts join live updates.

## 2.0.38 (2026-11-25)

### Changed
- **In-app updates open their pull request on your own repository.** The update workflow could try to open it on the public repo instead, because the upgrade adds a remote named `upstream`, and fail at its last step with "Resource not accessible by personal access token (createPullRequest)", even with the right token. Every `gh pr` call now names your repository.
- **Settings > Updates tests write access too**, with requests GitHub always rejects, so nothing in your repository changes. A permission that looks missing shows as "Check permissions" with the permission named; updates can still run.
- The token setup lists all eight permissions as a numbered list, in the app and the README.

### Breaking
- An install on 2.0.37 or earlier runs its old update workflow, which can fail at the last step. Update to 2.0.38 once from the command line (`npm run upgrade`, then push). After that, Settings > Updates works.

## 2.0.37 (2026-11-25)

### Added
- **Sign in with Google**, next to email and password. An Owner picks the sign-in methods in Settings > Workspace (under Brand): email and password, Google, or both. The login page shows only what really works: Google appears only while the Google provider is on in Supabase, and Google only shows a single "Continue with Google" button.
- **Forgot password** on the login page: an email link to set a new password. The answer never says whether an account exists.
- **Sign-in in Settings > Account**: set or change your password, and link or unlink Google, always keeping one way in. A login another app made (a shared Supabase project) keeps its password; the app never changes it.
- Invites can be accepted with Google when the Google email matches the invite. The first Owner can be claimed with Google after the setup code.
- A member with no photo gets their Google photo; a photo they set is never replaced.
- Changing the sign-in methods warns, by name, who would have no way in.

### Changed
- Only people on the team get in, by password or Google; anyone else is signed out with a plain message. Nobody is ever added by signing in.
- The minimum password length in Settings > Account is 8, matching invites.

### Database
- `20261125000400_google_sign_in.sql`: `business_settings.sign_in_methods` (default both), Owner-only like other workspace settings, and three service-only functions the sign-in screens use.

### Breaking
- To offer Google, turn on the Google provider in Supabase (Authentication > Sign In / Providers), add `<your app url>/auth/callback` to Redirect URLs, and turn on manual linking. On a Supabase project shared with other apps, Google may already be on: your existing members can then sign in with Google as soon as this release lands. Choose Email and password in Settings > Workspace if you do not want that.

## 2.0.36 (2026-11-25)

### Changed
- A task templates test no longer fails at random on a slow machine: its database call limit leaves room for background work. Nothing in the app changed.

## 2.0.35 (2026-11-25)

### Changed
- **Any project color**: next to the preset colors, a custom swatch opens a picker with a hex field, in Edit project and in project setup.
- Active projects in the sidebar are listed A to Z.

## 2.0.34 (2026-11-25)

### Added
- **Task templates**: set up repeat work once, then make it in one click. A template is one task or a playbook of tasks with subtasks, due dates counted in days from a start date, fill-in fields such as `{product}` used in titles and descriptions, and an assignee per task (a named person, or whoever uses it). A template can be locked to one project.
- **Where to use them**: a Templates page in the sidebar, "From a template" in the New task panel, and "From a template" on a project's Tasks tab. Using one shows every task it will make before anything is created, and makes them all or none.
- `templates.manage` permission (Owners and Admins by default) to set templates up; using one needs `tasks.create` and access to the project.
- REST `/api/v1/task-templates` (list, get, create, update, delete to Trash, `POST /:id/run`, `GET /:id/runs`), MCP tools `list_task_templates`, `get_task_template`, `run_task_template`, `create_task_template`, `update_task_template`, and the `template.run` webhook event.
- Templates go to Settings > Trash and can be restored.

### Database
- `20261125000300_task_templates.sql`: `task_templates`, `task_template_runs`, the `task_template_run_stats` view, the `templates.manage` permission, and task templates added to the Trash functions.

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
