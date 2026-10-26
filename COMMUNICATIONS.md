# Communications

Everything people send us (today email, next SMS, later Slack or Telegram) is
data brought into the database for the agent to act on. It lives in its own
Postgres schema, `communications`, built so a new channel adds an adapter and
reuses everything else.

```
channel webhook -> adapter (one per channel) -> communications core -> agent API + Inbox
```

- **Adapter**: receives a provider's webhook, verifies it, and turns it into
  core rows. Email's adapter is `src/lib/communications/email/`; nothing
  outside that folder knows about MIME, Message-IDs or DKIM.
- **Core**: conversations, messages, the projects a conversation is on, the
  sender's scope, triage, task links. The same for every channel.
- **Consumers**: the agent (Ashley) through `/api/v1/inbox/*`, and people
  through the Inbox (`/api/workspace/inbox/*`). Neither cares which channel a
  message came from.

## Reaching the schema

`communications` is an exposed schema, served by the Data API next to
`public`. Code reaches it through one accessor (`src/lib/communications/db.ts`):

```ts
comms(client).from('messages')
comms(client).rpc('message_scope', { p_message_id })
```

Never write `client.from('messages')`: that queries `public`.

Grants:

- `service_role` (the app's server, the agent API) has every table, view and
  function.
- `authenticated` can only `SELECT`, under RLS (`can_read_inbox`,
  `can_read_message`), for live sync and the task-link counts.
- `anon` has nothing.
- Every write goes through the server, and the functions that write check
  `auth.role() = 'service_role'` themselves.

Live sync: `store.tsx` subscribes to `postgres_changes` on the
`communications` schema and keys tables schema-qualified
(`communications.messages`), so a bare name never collides with a `public`
table. `INBOX_TABLES` in `inbox-types.ts` lists them.

**Exposing it (done once, 2026-10-26).** Dashboard > Data API > Exposed
schemas lists `communications`. The dashboard setting alone did not reach the
API server, because the database role holds its own copy, so it is also set
there:

```sql
ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, communications';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
```

Any schema added to the API later must be added to that line too.
`communications_legacy` (a frozen copy of the 17 tables from before the move,
kept for recovery) is deliberately not exposed and is dropped by the contract
migration.

## Tables

| Table | What it holds |
| --- | --- |
| `inboxes`, `inbox_access` | An agent's inbox (e.g. Ashley's relay address) and who may read it. |
| `endpoints` | A project's own address (`hi@relay...`): mail through it belongs to that project. `channel` says which kind. |
| `client_domains`, `client_addresses` | Senders mapped to a project by domain or exact address. Contacts map through `contact_emails`. |
| `conversations` | A thread. `channel`, subject, summary. |
| `conversation_projects` | Every project a conversation is on, with its `source` (below). |
| `messages` | One received message: sender, body, `kind` (person, team, meeting_notes, notification, marketing), `status`, `channel`, `external_id`, `sender_member_id`, `sender_verified`. Still keyed to its conversation by `thread_id`. |
| `message_endpoints` | Every endpoint a message arrived through (mail to `hi@` and `p4tf@` at once keeps both). |
| `message_candidates` | The projects its sender maps to, and why (contact, domain, sender). |
| `participants` | From, To, Cc. View `conversation_participants` rolls them up. |
| `attachments`, `files` | Attachments; `files` stores each byte-identical file once per inbox. |
| `triage` | The agent's read of a message: outcome, summary, question, `project_ids` it filed on. |
| `task_links` | Message to task: created, updated or related. |
| `answers` | A person's answer to the agent's question on a conversation. |
| `reply_drafts`, `sender_rules`, `maintenance_runs` | Drafts on request, a person's sorting rules, retention bookkeeping. |

## Projects: one conversation, several projects

A meeting or a teammate's email can cover several projects, so a conversation
links to any number of them (`conversation_projects`), and each item (a task,
a reminder) is filed on its own project.

Each link records how it got there. A stronger source replaces a weaker one,
never the other way:

| Source | Meaning |
| --- | --- |
| `person` | Someone set or confirmed it, or answered the agent's question. |
| `address` | The message came through that project's endpoint. |
| `mapped` | The sender maps to exactly this one project. |
| `inferred` | The sender maps to several; the agent picked this one. |
| `guessed` | Nothing mapped; the agent chose from the content. Shown as "(guessed)". |

## Scope: what a message may touch

The safety rule is about the sender: a client's email must never file work on
another client's project. It lives in SQL only, in
`communications.scope_source(message, project)` and
`communications.message_scope(message)`.

A message may touch:

- **conversation**: the conversation's projects. A `guessed` one only counts
  for a teammate's message, so a client's reply can't ride on a guess.
- **endpoint**: the project of each endpoint it came through.
- **mapped**: its sender's candidate projects.
- **team**: any open project, when `sender_member_id` is set (a verified
  teammate wrote or forwarded it).
- **meeting_notes**: any open project, when it is sorted `meeting_notes`
  and `sender_verified`.
- **answered**: any open project, but only for the email a person answered
  the agent's question on. Other emails in the conversation don't inherit it.

"Open" is `project_accepts_messages`: not trashed, not archived, status
`active`.

Every write a message causes is checked against this in the database:
`record_triage` (each named project and each linked task's project),
`link_message_task`, `file_message_project`, and reminders created from a
message. An out-of-scope project raises `EMAIL_PROJECT_OUT_OF_SCOPE`
and nothing is written; the API answers 422 with `reason:
project_out_of_scope` and the message's `project_scope`.

A person (Inbox) adds a project with `add_conversation_project` (recorded as
`person`) and removes one with `remove_conversation_project`. Removal is
refused while a linked task sits in that project. Nothing replaces a
conversation's projects wholesale: `set_conversation_project` only adds.

Writes that file a project lock the conversation row first, so two links on
one conversation run in turn.

Migrations are applied in order and each is safe to re-run on its own, but
never re-run `20261026091944_communications_schema.sql` after the migrations
that follow it: it would put back its own versions of functions they replaced.

## How an email arrives

1. Resend posts to `/api/inbound-email/resend`. `email/resend.ts` and
   `email/svix.ts` verify it and normalize it to an `InboundEmail`.
2. `email/ingest.ts` calls `email_start_message` (rows created, status
   `receiving`, idempotent on the provider id and Message-ID), stores the
   raw message and attachments in the private bucket, then threads, maps and
   sorts it and calls `email_complete_message`.
3. `email_complete_message` marks the message `new` or `ignored` and, when
   the conversation has no project yet, files one: the endpoint's project,
   else the sender's single mapping. Anything more is the agent's or a
   person's call.
4. The agent finds new work through `GET /api/v1/inbox/signal`, reads the
   message and its `project_scope`, and calls
   `POST /api/v1/inbox/messages/:id/triage` with `project_ids` and task
   links. `POST /api/v1/inbox/messages/:id/tasks` checks scope before the
   task exists, then creates it and links it to the message as `created`.
5. Retention (`/api/internal/inbound-email/retention`, daily) and the orphan
   sweep (weekly) clean up, files first.

The agent-facing contract is on the API docs page (`src/app/api/docs/docs-data.ts`).

## Triage plans

Each message gets one **plan** from the triage agent: a summary and items
(`src/lib/communications/plan-schemas.ts`). The app decides each item with
one pure policy (`triage-policy.ts`), then applies, stores and undoes them
(`plans.ts`).

| Decision | Meaning |
| --- | --- |
| apply | done now |
| apply_unsure | done now, shown as unsure, one tap to undo |
| propose | waits for a person, who is notified (one bell notification per message) |
| reject | not done, with the reason |

**Item intents.** Every item names why it exists:

| Intent | Meaning |
| --- | --- |
| `new_work` | someone asks for a deliverable |
| `change` | alters tracked work: revision, date, cancellation |
| `handoff` | what the work waited on arrived |
| `waiting_on` | someone owes Ciaran something |
| `commitment` | Ciaran promised or asked for something |
| `reply_owed` | someone waits on Ciaran, or on the agent |
| `owner_instruction` | Ciaran telling the agent what to do |
| `new_business` | leads, referrals, partnerships |
| `money` | our own books only |
| `account_risk` | expiries, suspensions, security |
| `context` | facts, advice, identity changes |
| `noise` | nothing to do |

**Item types:**
- tasks: `create_task`, `update_task`, `comment`, `attach_file`
- reminders: `add_reminder`, `update_reminder`, `complete_reminder`
- filing and links: `link_task`, `file_project`
- what Ciaran owes: `reply_owed`, a point on `communications.reply_points`, one per thing owed, amended rather than repeated
- corrections: `revert_item`, `mute_conversation`
- facts and leads: `add_context`, `propose_mapping`, `create_lead`, `log_interaction`
- `ask`: filing only, at most one open per conversation, and only when there is no default

**Who is speaking** is worked out by the app (`speaker.ts`), never by the
agent: owner, teammate, client, client_colleague, prospect, machine or
stranger. The app also records whether the agent was addressed.

**The policy, in order:**
1. Only Ciaran mutes. Only Ciaran or a teammate undoes earlier work. A client's cancel becomes a comment and a reply owed.
2. Ciaran writing to the agent is an instruction. His copied mail yields only his promises, what he waits on, and context. His forward with no note is context only.
3. A suspicious plan or an untrusted sender only proposes. An unknown sender proposes money and account matters.
4. A blind copy only files. Bulk mail only feeds money, account risk and context.
5. Strangers and prospects reach no client work.
6. A completed or archived project takes no new task. A project outside the message's scope is proposed, never refused.
7. Facts, mappings and leads propose. A field a person set is proposed; one the agent set changes as unsure. Assignment, readiness and status wait for a person, except a teammate putting their own task in review.
8. Low confidence, or work aimed at someone other than Ciaran or the agency, applies as unsure.

**Live and shadow.** `inboxes.triage_mode` picks the triage an inbox runs:

| Mode | What runs |
| --- | --- |
| `legacy` | the older per-tool triage |
| `shadow` | the older triage keeps the real work; a plan triage records decisions only, so the two can be compared on real mail |
| `plans` | the plan triage alone |

The agent API:
- `GET /api/v1/inbox/queue?mode=plans|shadow` lists the messages to plan. It waits until a conversation has been quiet for 3 minutes, and skips muted ones.
- `GET /api/v1/inbox/messages/:id/context` returns everything to read before planning.
- `POST /api/v1/inbox/messages/:id/plan` submits the plan.

A live plan also writes a `triage` row (`triage.plan_id`), so the Inbox, the
questions and the summary feed keep working unchanged.

The full catalog of situations and expected outcomes is kept with the agent's
evals (`evals/ashley-triage/catalog.md` in the agents repo). To add a
situation:
1. If it needs one, add an intent or item type to `triage-policy.ts`, `plan-schemas.ts` and the `plan_items` checks.
2. Write one paragraph in the agent's triage instructions.
3. Add one eval case and one row to `scripts/verify-triage-policy.ts`.

## Adding a channel (SMS, Slack, ...)

Every table and rule above is shared. A new channel needs:

1. **Allow the channel.** One migration widens the `channel` checks on
   `endpoints`, `conversations` and `messages` (today `IN ('email')`), and
   makes the email-only message columns nullable or moves them to an email
   detail table.
2. **Map its senders.** SMS needs phone numbers mapped to projects (a
   `sender_mappings` table that absorbs `client_domains` and
   `client_addresses` is the intended shape). Slack and Telegram users map to
   team members, which sets `sender_member_id` and so the `team` basis.
3. **Write the adapter** in `src/lib/communications/<channel>/`: a webhook
   route that verifies the provider's signature, then creates a conversation
   and message with the channel set and the provider's id in `external_id`
   (the Twilio SID, the Slack `ts`), and records `message_endpoints`.
4. **Register endpoints.** A Twilio number or a Slack channel becomes an
   `endpoints` row on its project, so `#client-acme` files on Acme the way
   `hi@relay` files on Happy Innovations.
5. **Show it.** A channel icon in the Inbox. Triage, scope, task links, the
   agent API and Ashley need no change.

A new email address for a project needs none of this: add it in the project's
email settings (one `endpoints` row).

## Legacy names

Until the contract migration ships (branch `communications-contract`):

- `conversations.project_id`, `project_source` and `project_address_id` are
  kept in step with `conversation_projects` by a trigger, for older readers.
- `/api/v1/inbound-emails/*` serves the same handlers as `/api/v1/inbox/*`.
- Payloads carry `thread_id` and `project` beside `conversation_id` and
  `projects`.

New code reads `conversation_projects`, `conversation_id` and `projects` only.
Permission names stay `inbound_email.*`.

## Tests

`npm run test:inbound-email` runs the library, ingest, retention, migration
(applied twice, compared against `schema.sql`) and scope suites on PGlite.
