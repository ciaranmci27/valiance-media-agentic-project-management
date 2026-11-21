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
- **Inbox**: client email and meetings sorted by project.
- **AI agents**: agents join the team, suggest and work tasks, and people approve what they do.
- **Credentials**: encrypted project logins, shared with the right people.
- **Webhooks**: invoice events sent to your other systems.

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

1. In Supabase, open the SQL Editor and run `supabase/schema.sql`. It is the whole database in one file; features you switch off later simply go unused.
2. In Supabase, open Project Settings, then Data API, and add `communications` to **Exposed schemas** (keep `public` and `graphql_public`). The Inbox lives in that schema.
3. In Supabase, open Authentication, then Sign In / Providers, and turn off **Allow new users to sign up**. The app creates every account itself (the setup wizard and invitations), and with sign-ups on, anyone with your public key could make themselves a member.
4. Copy `.env.example` to `.env.local`. Set `SUPABASE_DB_URL`: your database's session or direct connection string (Supabase, Connect, port 5432). Not the port 6543 transaction pooler. (`DATABASE_URL` also works and wins if both are set.)
5. Record the database as up to date:
   ```bash
   npm run db:migrate -- --baseline
   ```
   From now on, `npm run db:migrate` applies each release's new migrations.

### 3. Fill in the environment variables

Fill in `.env.local` from `.env.example`. Each variable has a line saying what it is for. You need at least:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase, Project Settings, API)
- `PROJECT_CREDENTIALS_ENCRYPTION_KEY` and `SMTP_ENCRYPTION_KEY` (generate each with `openssl rand -hex 32`)
- `NEXT_PUBLIC_APP_URL` (your app's address)

Run it locally with `npm run dev`, then open http://localhost:3009.

### 4. Deploy on Vercel

1. In Vercel, add a new project and import your repository.
2. Add the same environment variables under Project, Settings, Environment Variables.
3. Add `SUPABASE_DB_URL` too, so each production deploy applies its update's database changes first. Owners can turn that off in **Settings > Updates**.
4. Deploy.

### 5. First run

Open your app right after it deploys. On a fresh database it goes straight to the setup wizard:

1. **Create your account.** The first account becomes the **Owner**. Until someone does this, every visit lands here, so do it before you share the address.
2. **Your workspace**: name, logo and color.
3. **How you will use it**: a preset or modules one by one (next section), and your currency and number format.
4. **Email**: connect the account invites and notifications are sent from (Google, Resend or any SMTP server). It needs only `SMTP_ENCRYPTION_KEY` (see "Fill in the environment variables"); the wizard shows how to add it if it is missing. You can do this later in **Settings > Email**.
5. **Your team** and **First projects**, then you are in.

Everything can be changed later in Settings. Owners can look through the wizard again any time from **Settings > Workspace > Features > Preview setup**; a preview saves nothing.

To try the app without a database, set `NEXT_PUBLIC_DEMO_MODE=true` and `DEMO_MODE=true`. Both are required: the server-only `DEMO_MODE` stops a stray public variable from turning off sign-in on a real deployment.

---

## Choose your features

Owners switch modules in **Settings > Workspace > Features**. Presets set a whole mix at once:

| Preset | Modules |
|---|---|
| Agency | All of them |
| Internal team | Time tracking, Credentials, Inbox, AI agents |
| Solo | Time tracking, Contacts, Client invoicing, Webhooks |

Some modules need others: Leads needs Contacts, Client invoicing and Team pay need Time tracking, and Webhooks needs Client invoicing. The Client portal works on its own; emailing clients needs Contacts. With Client invoicing and Team pay both off, finished hours are approved as they are logged. Turning one on turns on what it needs. Turning one off turns off what needs it.

What turning a module off does:

- It disappears for everyone, Owners included: pages, tabs, menu items, settings and notifications.
- The API answers `403 MODULE_OFF` for it, MCP hides its tools, and its background jobs stop.
- **Nothing is deleted.** Turn it back on and everything is where you left it.

---

## Customize

Your own code, tables and files live in a few client-owned paths:

- `src/custom/`: pages, sidebar entries, project tabs, Dashboard cards, Settings pages, API routes, your theme and Next.js settings. Your name, colors and logos are set in Settings > Workspace > Brand, not in code.
- `supabase/migrations/custom/`: your own tables, in a database schema named `custom`.
- `public/custom/`: your own public files.
- `.claude/skills/`, `.claude/agents/` and `.claude/commands/`: your own agent skills, agents and commands, under any name that doesn't start with `pm-`.
- `.github/workflows/custom-*.yml`: your own CI workflows.
- `.claude/settings.local.json` and your `.env` files.

How each plug-in point works: [`src/custom/README.md`](src/custom/README.md). Write your own notes there, not in this README.

**Never edit core files** (everything outside those paths, apart from adding dependencies and scripts to `package.json` and crons to `vercel.json`). `.claude/settings.json`, the other workflows and this README are core too. Each release replaces core files, so an edit there is lost or stops the next update. `npm run check:core` lists any core file you changed. If you need core to change, ask for it (see Contributing to core).

---

## Updating

Valiance Media publishes each release as a `vX.Y.Z` tag with notes. **Settings > Updates** shows your version, any newer release and its notes. There are two ways to take it.

### In the app

Set this up once:

1. On GitHub, create a fine-grained personal access token for **only your repository**, with the permissions Settings > Updates lists: Contents, Pull requests, Workflows, Actions and Secrets (read and write), and Commit statuses, Deployments and Metadata (read-only).
2. In Vercel, add `PM_GITHUB_TOKEN` (the token) and `PM_GITHUB_REPO` (your repository as owner/name), then redeploy.
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
