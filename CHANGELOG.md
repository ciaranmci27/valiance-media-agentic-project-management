# Changelog

Every release has a section here, newest first. The release workflow publishes a version's section as its GitHub release notes, and the app shows it to owners before they update.

Each section starts with `## X.Y.Z (YYYY-MM-DD)` and uses these headings, leaving out any that are empty:

- `### Added`: new things an install can use.
- `### Changed`: existing behaviour that works differently.
- `### Database`: the core migration files in the release, one per line. `npm run db:migrate` applies them.
- `### Breaking`: what an install must do when it takes this release.

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
