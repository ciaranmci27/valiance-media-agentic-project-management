# Valiance Media Agentic Project Management

Open-source project management where AI agents work alongside your team. Run projects and tasks, track time, bill clients, handle client email, and let agents propose and do work that people review.

**Built with Next.js 16, React 19, Supabase and Tailwind CSS v4.**

![License](https://img.shields.io/badge/license-MIT-blue)

Each company runs its own install: its own repository, database and hosting. Valiance Media publishes releases, and every install takes them with one command or from the app.

---

## Features

Core is always on. Everything else is a module an Owner can switch on or off.

**Core**
- **Projects** with status, color, team and progress.
- **Tasks** with priorities, tags, assignees, subtasks, comments, files and rich text. Board, list and calendar views, with bulk changes.
- **Team** with roles (Owner, Admin, Member, Guest, Agent), invitations, permissions, time zones and notification preferences.
- **Reminders, notifications and an audit log** with before and after snapshots.
- **REST API** with API keys, filtering, paging and docs at `/api/docs`, plus an MCP server so AI tools can work in the app.

**Modules**
- **Time tracking**: timers, manual entries and approvals.
- **Client invoicing**: invoices, retainers, billing plans, rates, budgets, payments and company revenue.
- **Team pay**: pay rates, payroll, payouts and each person's own earnings.
- **Contacts**: a shared address book linked to projects.
- **Leads**: a sales pipeline with interactions, proposals and one-click conversion to a project.
- **Client portal**: a private page per project where clients see progress, updates and files, with an optional PIN.
- **Inbox**: client email sorted by project. Meeting notes can be posted in through the API too.
- **AI agents**: agents join the team, suggest and work tasks, and people approve what they do.
- **Credentials**: encrypted project logins, shared with the right people.
- **Webhooks**: signed task, question, suggestion, review and invoice events sent to your other systems, filtered by project or by member, so an AI agent hears about its own work. See [WEBHOOKS.md](WEBHOOKS.md).

**Also**: demo mode with sample data, dark theme, keyboard shortcuts, and a layout that works on phones.

---

## Install

You need Node.js 20.9 or newer, a [Supabase](https://supabase.com) project, a GitHub account and (to host it) a [Vercel](https://vercel.com) account.

### 1. Copy the repository, with its history

Updates merge each release into your code, so your repository must start as a copy of this one with its full history. Don't use "Use this template" or a ZIP download: both drop the history.

1. On GitHub, create a new **private** repository with no README, license or .gitignore.
2. Run, with your repository's URL:
   ```bash
   git clone https://github.com/ciaranmci27/valiance-media-agentic-project-management.git my-pm
   cd my-pm
   git checkout -B main "$(git describe --tags --abbrev=0 --match 'v*')"
   git remote rename origin upstream
   git remote add origin https://github.com/<you>/<your-repo>.git
   git push -u origin main
   git push origin --tags
   npm install
   ```

The `checkout` line starts you on the newest release. The public `main` branch can carry work that is not released yet, and an install should only ever run releases. `upstream` is where releases come from. `origin` is your own repository.

### 2. Set up the database

1. In Supabase, open the SQL Editor and run `supabase/schema.sql`. It is the whole database in one file, in its own schemas: `pm` (the app) and `pm_custom` (your own tables). It creates nothing in `public`, so it also fits a project that already holds other apps (see "Using a database you already have"). Features you switch off later simply go unused.
2. In Supabase, open Project Settings, then Data API, and add `pm` and `pm_custom` under **Exposed schemas** (keep the ones already there). On most projects this list lives in the dashboard, so this step is needed. If the app later opens on a **Set up the database** page, step 1 or 2 is not done yet; that page says which.
3. In Supabase, open Authentication, then Sign In / Providers, and turn off **Allow new users to sign up** unless another app on the project needs it. The app creates every account itself (the setup wizard and invitations), and nobody becomes a member just by signing up.
4. Copy `.env.example` to `.env.local`. Set `SUPABASE_DB_URL`: your database's session or direct connection string (Supabase, Connect, port 5432). Not the port 6543 transaction pooler. (`DATABASE_URL` also works and wins if both are set.)
5. Record the database as up to date:
   ```bash
   npm run db:migrate -- --baseline
   ```
   From now on, `npm run db:migrate` applies each release's new migrations.

### 3. Fill in the environment variables

Fill in `.env.local` from `.env.example`. Five are required:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase, Project Settings, API)
- `APP_ENCRYPTION_KEY`: one key for everything the app saves encrypted. Leave it empty and the setup wizard makes one in your browser and shows where to put it (or run `openssl rand -hex 32`). Use the same key locally and in your host, and keep a safe copy: if it is lost, saved passwords and keys cannot be recovered.
- `NEXT_PUBLIC_APP_URL`: `http://localhost:3009` locally.

Everything else is optional, and integration keys (Resend, the GitHub update token, webhook retries) are set in the app's Settings, saved encrypted.

Run it locally with `npm run dev`, then open http://localhost:3009.

### 4. Deploy on Vercel

1. In Vercel, add a new project and import your repository.
2. Add the same environment variables under Project, Settings, Environment Variables, with `NEXT_PUBLIC_APP_URL` set to your real address (for example `https://pm.yourcompany.com`). Mark the keys Sensitive.
3. Add `SUPABASE_DB_URL` too, so each production deploy applies its update's database changes first. Owners can turn that off in **Settings > Updates**.
4. Add `CRON_SECRET` (`openssl rand -hex 32`) to turn on the scheduled jobs in `vercel.json`: inbound email clean-up and the billing draft digest.
5. Deploy.

### 5. First run

Open your app right after it deploys. It checks what is missing and says what to do:

- **Connect Supabase**: a Supabase setting is missing in your host.
- **Set up the database**: `schema.sql` has not run, or `pm` and `pm_custom` are not exposed yet (step 2).
- **Connect your server**: `APP_ENCRYPTION_KEY` or `NEXT_PUBLIC_APP_URL` is missing. It generates the key in your browser (never sent anywhere) and shows where to add it: your host and `.env.local`. Redeploy, then check again.

Then the setup wizard:

1. **Create your account.** The first account becomes the **Owner**. Until someone does this, every visit lands here, so do it before you share the address.
2. **Your workspace**: name, logo and color.
3. **How you will use it**: a preset or modules one by one (next section), and your currency and number format.
4. **Email**: connect the account invites and notifications are sent from (Google, Resend or any SMTP server). You can do this later in **Settings > Email**.
5. **Who invoices are from** (with Client invoicing on), **Your team** and **First projects**, then you are in.

Everything can be changed later in Settings. Owners can look through the wizard again any time from **Settings > Workspace > Features > Preview setup**; a preview saves nothing.

### Using a database you already have

The app can live in a Supabase project your company already uses for other apps, so it can read your own data (for an install's own pages, in `pm_custom`) and share logins:

- Everything the app makes is in `pm` and `pm_custom`, with `pm-` storage buckets and `pm-` scheduled jobs. Nothing in `public` or your other schemas is created, changed or read by the app or its updates.
- Logins are shared, roles are not: someone becomes a PM member only when invited, with their own PM role. An invited person who already has a confirmed login signs in with it (an unconfirmed one is never linked: it could be someone else's sign-up); the app never changes the email or password of a login it did not create.
- Before anyone can claim the Owner account on such a project, the setup wizard asks for a setup code: set `PM_SETUP_CODE` (any long random text) in your host first. Someone who already has a login can claim with it.

### Receiving client email (optional)

The Inbox reads mail sent to your project addresses through [Resend](https://resend.com) receiving:

1. In Resend, add a receiving domain (a subdomain such as `inbox.yourcompany.com` works well) and set its MX records.
2. In Resend, Webhooks, add an `email.received` webhook pointing at `https://<your app>/api/inbound-email/resend`.
3. In the app, **Settings > Email > Receiving**: paste a Resend API key that can read received email (starts with `re_`) and the webhook's signing secret (starts with `whsec_`). Both are saved encrypted.
4. Add your addresses in **Settings > Email**, then send a test email.

### Demo mode

To try the app without a database, set `NEXT_PUBLIC_DEMO_MODE=true` and `DEMO_MODE=true`. Both are required: the server-only `DEMO_MODE` stops a stray public variable from turning off sign-in on a real deployment.

---

## Choose your features

Owners switch modules in **Settings > Workspace > Features**. Presets set a whole mix at once:

| Preset | Modules |
|---|---|
| Agency | All of them |
| Internal team | Time tracking, Credentials, Inbox, AI agents |
| Solo | Time tracking, Contacts, Client invoicing, Webhooks |

Some modules need others: Leads needs Contacts, and Client invoicing and Team pay need Time tracking. Webhooks works on its own; its invoice events also need Client invoicing. The Client portal works on its own; emailing clients needs Contacts. With Client invoicing and Team pay both off, finished hours are approved as they are logged. Turning one on turns on what it needs. Turning one off turns off what needs it.

What turning a module off does:

- It disappears for everyone, Owners included: pages, tabs, menu items, settings and notifications.
- The API answers `403 MODULE_OFF` for it, MCP hides its tools, and its background jobs stop.
- **Nothing is deleted.** Turn it back on and everything is where you left it.

---

## Customize

Your own code, tables and files live in a few client-owned paths:

- `src/custom/`: pages, sidebar entries, project tabs, Dashboard cards, Settings pages, API routes, your theme and Next.js settings. Your name, colors and logos are set in Settings > Workspace > Brand, not in code.
- `supabase/migrations/custom/`: your own tables, in the database schema `pm_custom`.
- `public/custom/`: your own public files.
- `.claude/skills/`, `.claude/agents/` and `.claude/commands/`: your own agent skills, agents and commands, under any name that doesn't start with `pm-`.
- `.github/workflows/custom-*.yml`: your own CI workflows.
- `.claude/settings.local.json` and your `.env` files.

How each plug-in point works: [`src/custom/README.md`](src/custom/README.md). Write your own notes there, not in this README.

**Never edit core files** (everything outside those paths, apart from adding dependencies and scripts to `package.json` and `package-lock.json`, and crons to `vercel.json`). `.claude/settings.json`, the other workflows and this README are core too. Each release replaces core files, so an edit there is lost or stops the next update. `npm run check:core` lists any core file you changed. If you need core to change, ask for it (see Contributing to core).

---

## Updating

Valiance Media publishes each release as a `vX.Y.Z` tag with notes. **Settings > Updates** shows your version, any newer release and its notes. There are two ways to take it.

### In the app

Set this up once:

1. On GitHub, create a fine-grained personal access token for **only your repository**, with the permissions Settings > Updates lists: Contents, Pull requests, Workflows, Actions and Secrets (read and write), and Commit statuses, Deployments and Metadata (read-only).
2. In Settings > Updates, paste the token and your repository (owner/name). They are saved encrypted with `APP_ENCRYPTION_KEY`. (Setting `PM_GITHUB_TOKEN` and `PM_GITHUB_REPO` in your host and redeploying works too.)
3. In Settings > Updates, check the connection, then press **Finish setup**. It stores the token as a secret in your repository for the update workflow.

Your repository must allow merge commits, and `.github/workflows/core-update.yml` must be on its default branch (it comes with the copy).

Then, for each release:

1. **Prepare**: a GitHub workflow merges the release on a new branch, runs the checks and opens a pull request.
2. **Checks** and **Preview**: look at the results and, if your host posts one, the preview.
3. **Apply**: merges the pull request. Your host deploys it.

### From the command line

```bash
npm run upgrade
git push
```

It merges the newest release, which can be several versions ahead, so read the notes of every release in between. It keeps your dependencies, scripts and crons in `package.json` and `vercel.json`, then installs, type-checks and runs the tests. It never pushes. Add `-- --to v1.4.0` for a specific release, or `-- --branch update/v1.4.0` to merge on a new branch.

### If an update stops on a conflict

A conflict means your repository changed a core file that the release also changed. Nothing is merged and your code is left as it was. The update lists the files. Move those changes into `src/custom`, then update again. An AI agent can do this for you: open the project with it and ask it to update to the new version. The repo's agent instructions walk it through.

### Database changes

Releases with a Database section in their notes change the database. When your host has `SUPABASE_DB_URL`, production deploys apply those changes on their own before the new version goes live, unless an Owner turned it off in **Settings > Updates**, which also shows whether every change has landed. Otherwise, run `npm run db:migrate` against your production database right after the update. Core migrations work with the previous release's code too, so running them just before or after the deploy is safe.

### Your repository must share the public history

Updates are git merges. If your repository was started from copied files, the update stops and says so. To fix it, follow the steps in Install, part 1, into a new folder. Then copy in your client-owned paths, re-apply your `package.json` and `vercel.json` changes, and push that to your repository.

---

## For AI agents

- **`AGENTS.md`**: the rules every AI agent reads first. Where custom work goes, how to upgrade, which checks to run. Claude Code, Codex, Cursor and others read it.
- **`src/custom/AGENTS.md`**: your install's own facts (how you ship, run and sign in). Fill it in.
- **`CLAUDE.md`**: loads both for Claude Code.
- **Skills** in `.claude/skills/`: `pm-add-custom-feature`, `pm-add-custom-table`, `pm-upgrade` and `pm-propose-core-change`.
- **The guard**: in an install, a Claude Code hook (`.claude/hooks/guard-core.mjs`) blocks an agent from editing core files and points it to `src/custom` or a core change proposal. It steps aside while a merge is open, so an agent can resolve an update. `npm run check:core` catches anything else before a commit.

---

## Contributing to core

Releases are built in Valiance Media's own repository and mirrored here, so changes reach installs through releases, not direct edits to this repository.

1. Open an issue describing what you need. The best requests ask for a new setting, module or plug-in point, so every install can use it.
2. An AI agent can write the request for you with the `pm-propose-core-change` skill.
3. Pull requests are welcome as illustrations. Accepted changes ship in the next release.

---

## License

MIT. Built by [Valiance Media](https://valiancemedia.com).
