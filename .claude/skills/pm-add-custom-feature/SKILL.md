---
name: pm-add-custom-feature
description: Build an install's own feature without touching core. Load before adding a page, sidebar entry, project tab, Dashboard card, Settings page, API endpoint, webhook, cron, public page, theme or Next.js setting to this install, or whenever a request would otherwise mean editing a core file.
---

# Add a custom feature

Everything goes in `src/custom/` (code), `public/custom/` (files) and `supabase/migrations/custom/` (tables). Never edit a core file. The name, tagline, brand colors, logos and favicon are not code: an Owner sets them in Settings > Workspace > Brand. Reference: `src/custom/README.md`, types in `src/lib/extensions/types.ts`.

## Steps

1. **Pick the plug-in point.**

| Need | File | Key |
|---|---|---|
| Page at `/x/<slug>` | `src/custom/index.ts` | `pages` |
| Sidebar entry | `src/custom/index.ts` | `navItems` (`after: '/projects'` to place it) |
| Project tab (`?tab=x-<key>`, gets `{ project }`) | `src/custom/index.ts` | `projectTabs` |
| Badge beside a project's name on project lists and cards (gets `{ project }`, returns null when it does not apply) | `src/custom/index.ts` | `projectBadges` |
| Dashboard card | `src/custom/index.ts` | `dashboardWidgets` (`placement`, `size`) |
| Agent analytics card | `src/custom/index.ts` | `agentAnalyticsCards` (`size`; gets range, filters, the analytics model and events) |
| Settings page at `/settings/custom/<key>` | `src/custom/index.ts` | `settingsSections` (Owners only by default) |
| Endpoint at `/api/x/<path>` | `src/custom/api.ts` | `defineApiRoutes([...])` |
| Page open without sign-in | `src/custom/middleware.ts` | `definePublicPaths([...])` |
| Fonts, surface CSS variables | `src/custom/theme.css` | `:root { ... }` |
| Redirects, image hosts | `src/custom/next.config.ts` | Next.js config, merged over core's |

2. **Write the component** in a subfolder, such as `src/custom/pages/ReportsPage.tsx`. It renders in the browser inside the app shell. Load data from your own `/api/x` route, never with server secrets. Wrap heavy components in `next/dynamic`.

3. **Register it.**
   ```ts
   pages: [{ slug: 'reports', title: 'Reports', component: ReportsPage, permission: 'projects.read_all' }],
   navItems: [{ href: '/x/reports', label: 'Reports', icon: BarChart3, after: '/projects' }],
   ```

4. **Gate it.** Every item takes `module` (shown only while that module is on), `permission` and `roles`. If the feature belongs to a module (`time`, `billing`, `contacts`, `sales`, `portal`, `inbox`, `agents`, `credentials`, `webhooks`), set `module` on its page, nav item, tab and API routes.

5. **API routes.** `auth` defaults to `'session'` (a signed-in member). Use `'api-key'` with a `permission` for machine callers. Use `'public'` only for webhooks and crons, and verify the request in the handler:
   ```ts
   { path: 'crm/hook', method: 'POST', auth: 'public', handler: async ({ request }) => { await verifySignature(request); return success({ ok: true }); } },
   ```
   Errors: `throw new ApiError(...)` from `@/lib/api/errors`. Answers: `success(data)` from `@/lib/api/response`. A route with `module` set answers `403 MODULE_OFF` while that module is off.

6. **Crons.** Add the schedule to `vercel.json` pointing at an `/api/x/...` route with `auth: 'public'`, and check `Authorization: Bearer ${process.env.CRON_SECRET}` first.

7. **Env vars.** Add each new variable to `src/custom/env.example` with a one-line purpose, where to get it, and required or optional. Real values go in `.env.local` and the host, never in git.

8. **Tables.** Load `pm-add-custom-table`.

9. **Record it.** Add one line under `## Our customizations` in `src/custom/AGENTS.md`.

## Check

```bash
npx tsc --noEmit
npx eslint src/custom
npm run check:core
npm run test:core
```

Then open the page in the browser, signed in, with its module on and off.

## If no plug-in point fits

Don't edit core. Load `pm-propose-core-change` and ask for the missing plug-in point, setting or module.
