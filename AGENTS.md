# Agent instructions

Read this first, then `src/custom/AGENTS.md` (this install's own facts).

## What this is

An open-source project management app (Next.js 16, React 19, Supabase). Many companies run their own install of it. Valiance Media builds the core and publishes releases as `vX.Y.Z` tags on the public repo `ciaranmci27/valiance-media-agentic-project-management`. Each install keeps that repo's history and merges every release.

## Where you are

Run this once, from the app folder:

```bash
test -f "$(git rev-parse --show-toplevel)/app/package.json" && echo source || echo install
```

- **source**: Valiance Media's monorepo, where the core is built. The app is its `app/` folder. Edit core freely. Every core change follows **Release rules** below. The client-owned paths below are Valiance Media's own here, used like any install's: the public sync replaces them with the starter versions in the monorepo's `release/app-custom-stubs/` (see `release/README.md`), so they never ship. Change what installs start with only there.
- **install**: a company's own copy. **Never edit core files.** Put everything in the client-owned paths:

| Path | What goes there |
|---|---|
| `src/custom/` | Code: pages, tabs, cards, settings, API routes, theme, Next config, env docs |
| `supabase/migrations/custom/` | SQL, only in the database schema `pm_custom` (core lives in `pm`) |
| `public/custom/` | Public files (images, downloads), served at `/custom/<name>` |
| `.claude/skills/<name>/` | Your own agent skills; any name not starting with `pm-` |
| `.claude/agents/<name>`, `.claude/commands/<name>` | Your own agent definitions and commands, files or folders; any name not starting with `pm-` |
| `.github/workflows/custom-*.yml` (or `.yaml`) | Your own CI workflows |
| `.claude/settings.local.json`, `.env*` files except `.env.example` | Local settings and secrets |

`.claude/settings.json`, the other workflows and the root `README.md` are core: use `.claude/settings.local.json` and `src/custom/README.md` instead.

Three core files an install may also change: `package.json` (dependencies, scripts), `package-lock.json` and `vercel.json` (crons). The upgrade merges them.

Everything else is core. Each release replaces it. In an install, a guard hook (`.claude/hooks/guard-core.mjs`) blocks edits to core files, and `npm run check:core` fails on any that slip through.

## Build a custom feature

Load the skill `pm-add-custom-feature`. Full reference: `src/custom/README.md`.

| Need | Where |
|---|---|
| A page (`/x/<slug>`) and its sidebar entry | `pages` and `navItems` in `src/custom/index.ts` |
| A tab on every project | `projectTabs` in `src/custom/index.ts` |
| A Dashboard card | `dashboardWidgets` in `src/custom/index.ts` |
| A Settings page (Owners only by default) | `settingsSections` in `src/custom/index.ts` |
| An API endpoint, webhook receiver or cron target (`/api/x/<path>`) | `src/custom/api.ts` |
| A page open without signing in | `src/custom/middleware.ts` |
| An agent template (rules, key scopes and a brief to start an agent from) | `src/custom/agent-templates.ts` |
| An agent profile (which MCP tools an agent sees) | `src/custom/agent-profiles.ts` |
| Name, tagline, brand colors, logos, favicon | Not code: an Owner sets them in Settings > Workspace > Brand (stored in the database) |
| Fonts and surface CSS variables | `src/custom/theme.css` |
| Redirects, image hosts | `src/custom/next.config.ts` |
| A cron | `vercel.json`, pointing at an `/api/x/...` route |
| A table | `supabase/migrations/custom/` (skill `pm-add-custom-table`) |
| An environment variable | Document it in `src/custom/env.example`; set it in `.env.local` and the host |

```ts
// src/custom/index.ts (runs in the browser)
export default defineExtensions({
  navItems: [{ href: '/x/reports', label: 'Reports', icon: BarChart3, after: '/projects' }],
  pages: [{ slug: 'reports', title: 'Reports', component: ReportsPage, module: 'billing' }],
});
```

```ts
// src/custom/api.ts (server only)
export default defineApiRoutes([
  { path: 'reports/weekly', method: 'GET', permission: 'projects.read_all', handler: async ({ session }) => success(await weekly(session.client)) },
]);
```

Rules for custom code:

- Put components in subfolders of `src/custom/` (`src/custom/pages/Reports.tsx`). They render in the browser: fetch through your own `/api/x` routes, never with server secrets.
- **Modules**: set `module: '<id>'` on any item to show it only while that module is on. On an API route, a switched-off module answers `403 MODULE_OFF`. Module ids are in `src/lib/modules/registry.ts`.
- **API route auth**: left out, `auth` is `'session'` (a signed-in member; add `permission` to narrow it). `'api-key'` needs a `permission`. `'public'` lets anyone in, so only write it for webhooks and crons, and check the signature or `Authorization: Bearer ${process.env.CRON_SECRET}` in the handler.
- Throw `ApiError` (`@/lib/api/errors`) for errors; answer with `success()` (`@/lib/api/response`).
- A duplicate slug or key stops the build and names it.

## When core must change

Don't patch it. Load the skill `pm-propose-core-change` and write a proposal for Valiance Media. The best proposals ask for a new setting, module or plug-in point, so this install and every other one can use it without editing core. Until the release ships, build what you can in `src/custom`.

## Upgrading

Load the skill `pm-upgrade`. In short, from a clean working tree:

```bash
npm run upgrade            # merges the newest release, then installs, type-checks, runs check:core and test:core
```

The newest release can be several versions ahead. Read every `CHANGELOG.md` section between the installed version and the target, and do all their `### Breaking` and `### Database` items.

| Exit | Meaning | Do |
|---|---|---|
| 0 | Updated, or already up to date | Run `npm run db:migrate` if it lists new migrations. Review, then push. |
| 1 | Error (uncommitted changes, wrong `upstream` remote, a merge in progress) | Fix what the message says and run it again. |
| 2 | Conflict: this install changed a core file the release also changed. The merge was aborted; nothing changed. | Move each listed change into `src/custom`, restore the file, commit, run the upgrade again. |
| 3 | No shared history with the public repo | Follow the steps it prints. |
| 4 | Merged, but a check failed | The merge commit stays. Fix the failure on this branch before pushing. |

Resolve conflicted core files by hand only inside a merge (`git merge vX.Y.Z` with a conflict open), and only when the change cannot move into `src/custom`. The guard allows core edits while a merge is in progress.

After a release with a `### Database` section in `CHANGELOG.md`, apply its migrations: `npm run db:migrate` (`--status` to list, `--dry-run` to preview). Production deploys on Vercel apply them on their own when the host has `SUPABASE_DB_URL`, unless an Owner turned it off in Settings > Updates (or the host sets `MIGRATE_ON_DEPLOY=false`); that page also lists any change that has not landed.

## Checks before committing

| Command | Covers |
|---|---|
| `npx tsc --noEmit` | Types across the app, `src/custom` and `scripts` |
| `npx eslint src/custom` | ESLint with the Next.js rules, on this install's own code |
| `npm run check:core` | No core file changed; custom migrations stay in schema `pm_custom` (files dated before 2.0: `custom`). In the source monorepo it says there is nothing to check. |
| `npm run test:core` | Core's test suite on an in-memory database: permissions, modules, plug-in points, upgrade, migrations, the agent guard. No network or database needed. |

## Release rules (source monorepo only)

- **The app lives in schema `pm`** (2.0): every table, view, function and policy is `pm.<name>`, and nothing of the app is created in `public`, so the app can share a Supabase project with other apps. Supabase-global names carry a prefix: storage buckets `pm-<name>`, storage policies `pm: <name>`, cron jobs `pm-<name>`, Vault entries `pm_<name>`. Members are added by the server (`pm.add_team_member`), never by a trigger on `auth.users`. `npm run test:pm-schema` checks a fresh install against an upgraded one and against a database that already holds another app.
- **Functions are locked down** (2.0.8): no `pm` function is callable by `anon`, and `authenticated` only gets the ones row policies, column defaults, checks or signed-in screens need. A new function must `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon` and grant only what it needs; one members call from the browser goes on the list in `scripts/verify-function-grants.ts`. `npm run test:function-grants` fails otherwise.
- **Migrations** go in `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`. Each is additive, safe to run twice, and works with the previous release's code: installs apply it before or after deploying the new code. Never edit a migration that has shipped; add a new one.
- **`supabase/schema.sql`** is updated in place in the same commit, so a fresh install gets the same database.
- **A new permission** gets its module in `PERMISSION_MODULE` (`src/lib/modules/registry.ts`) and its `permission_modules` row in the migration.
- **A new module** goes in `MODULE_IDS` and `MODULES`, with its `workspace_modules` row in the same migration. `npm run test:modules` fails until the registry and the database agree.
- **Client-owned paths** change in `scripts/lib/core-paths.ts` and `.claude/hooks/guard-core.mjs` together. `npm run test:agent-guard` fails when they differ.
- **Scripts and tests read git paths relative to the app folder** (`git show REF:./supabase/schema.sql`), never `app/...`: the public repo and every install have the app at their root, so a monorepo path fails their Core checks.
- **Tests never read git history by a commit SHA**: the public repo's history differs from this one, so a SHA that exists here is missing there. Use `schemaBeforeMigration` or a release tag.
- **Never change a shipped starter file** (the monorepo's `release/app-custom-stubs/`, which installs receive as their `src/custom/` and other client-owned folders): installs own those files. A new plug-in point must work when an install leaves it empty.
- **To publish a release**: bump `version` in `package.json` and add its section to `CHANGELOG.md` (`## X.Y.Z (YYYY-MM-DD)` with `### Added`, `### Changed`, `### Database`, `### Breaking`; leave out empty ones). `### Breaking` says exactly what an install must do. When the change reaches `main`, the sync workflow tags the release on the public repo and publishes that section as its notes. No section, no release.

## This install's own facts

See `src/custom/AGENTS.md`.
