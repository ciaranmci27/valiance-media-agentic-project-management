# Changelog

Every release has a section here, newest first. The release workflow publishes a version's section as its GitHub release notes, and the app shows it to owners before they update.

Each section starts with `## X.Y.Z (YYYY-MM-DD)` and uses these headings, leaving out any that are empty:

- `### Added`: new things an install can use.
- `### Changed`: existing behaviour that works differently.
- `### Database`: the core migration files in the release, one per line. `npm run db:migrate` applies them.
- `### Breaking`: what an install must do when it takes this release.

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
