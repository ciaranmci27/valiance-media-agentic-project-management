# Local test stack

The real app (not demo mode) on a Supabase stack in Docker on this machine, with seeded data and real writes. It never reads `.env.local` and never talks to a hosted database.

## Start

From the `app` folder, with Docker running:

1. `npm run local:up`: starts the stack, loads `supabase/schema.sql` into an empty database (as a fresh install does), records every migration as applied (`db:migrate --baseline`), and writes `scripts/local/.env.test.local`.
2. `npm run local:seed`: adds the people, agents and data below. Safe to run again.
3. `npm run local:dev` (or the launch config `app-local`): the app at http://localhost:3010.
4. Sign in at http://localhost:3010/login with an account below.

After new code with new migrations, run `npm run local:up` again: it applies them, the way `npm run db:migrate` does (that command itself reads `.env.local`, so never run it for this stack).

`npm run local:down` stops the stack and keeps its data. `npm run local:down -- --reset` deletes the data too; then run steps 1 and 2 again.

## Accounts

Emails are below. Passwords are generated on the first seed and kept in `scripts/local/.env.test.local` (`LOCAL_<ROLE>_PASSWORD`, gitignored); the seed prints them when it makes them.

| Who | Email | Role |
|---|---|---|
| Morgan Hale | owner@acme.test | Owner (made through the setup wizard's first-Owner code) |
| Priya Shah | admin@acme.test | Admin |
| Sam Rivera | member@acme.test | Member |
| Jordan Lee | assigned@acme.test | Member who sees only tasks assigned to them (View tasks denied, View assigned tasks allowed) |
| Casey Brooks | guest@acme.test | Guest on Website relaunch |

Agents (no sign-in; each has an API key in the env file as `LOCAL_AGENT_<NAME>_API_KEY`):

- **Atlas**, the company agent: coordinator, key with `agents.act_for`, `approvals.decide`, inbox triage; handles the Hello inbox.
- **Forge**, builder (builder template), on Website relaunch and Mobile app MVP.
- **Lens**, reviewer, on Website relaunch.
- Personal assistants for the Owner and every Member (assistant setups by role).

## What the seed makes

- Workspace "Acme Studio", setup finished.
- Groups Design and Client services.
- Projects Website relaunch, Mobile app MVP and Q1 marketing campaign, each with tasks, subtasks, an initiative with log entries, and one task that repeats weekly.
- Templates: Client onboarding (company-wide, roles, key dates, dependencies) and Weekly campaign report (Q1 marketing campaign) with a schedule every Friday.
- Inbox hello@acme.test (Atlas handles it) and a project address for Website relaunch, with four emails: a client thread with a reply, a lead and a receipt.
- Questions and approvals: Atlas asks the Owner about a quote, Forge asks the Owner to approve a deploy, Lens asks the Design group.

## Addresses

| What | Where |
|---|---|
| App | http://localhost:3010 |
| Supabase API | http://127.0.0.1:55321 |
| Database | postgresql://postgres:postgres@127.0.0.1:55322/postgres |
| Studio | http://127.0.0.1:55323 |
| Mailpit (every email the stack's auth sends, such as password resets) | http://127.0.0.1:55324 |

## How production stays out

`dev.mjs` starts Next with every setting from `scripts/local/.env.test.local` as real environment variables, every other setting the app reads set to empty, and Next's own `.env` loading switched off. `guard-env.cjs` is preloaded into every Node process of the server: `.env*` files read as missing (also when one changes while it runs), the process stops unless Supabase and the database are on 127.0.0.1, and `fetch` refuses hosted Supabase addresses. Each process logs `[local-guard] on in pid ...` with the Supabase URL it uses.

The server builds into `.next-local`, apart from the usual `npm run dev` (port 3009), so both can run at once. Next prints that it updated `tsconfig.json` for that folder; the guard blocks that write, so `tsconfig.json` and `next-env.d.ts` stay as they are.

## What differs from a real install

- **Outgoing email**: no SMTP account is set up. Invites show their link instead of sending it. Add an account in Settings > Email to test sending.
- **Incoming email**: no Resend webhook reaches this machine. The seed's emails go through the app's own ingest code; new mail would need a call to `ingestInbound`.
- **Scheduled jobs**: pg_cron and pg_net run in the database container. The seed points the scheduler (schedules, webhook retries) at `http://host.docker.internal:3010` so it reaches the dev server. Turning webhook retries off and on in Settings points it back at `localhost:3010`, which the container cannot reach: run `npm run local:seed` again.
- **Google sign-in**: not set up; email and password only.
- **Agents**: they exist with keys, but no agent runtime is connected, so nothing works their tasks unless you call the API or MCP with their keys.
- **Settings > Updates**: checking for releases on GitHub fails without a token.
