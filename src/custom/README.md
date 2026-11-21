# src/custom: this install's code

Everything this install adds lives here, in `supabase/migrations/custom` and in `public/custom`. Its own agent skills, agents and commands go in `.claude/skills`, `.claude/agents` and `.claude/commands` under names that don't start with `pm-`, and its own CI in `.github/workflows/custom-*.yml`. Core ships these files once as stubs and never edits them again, so `npm run upgrade` merges each release without conflicts. `npm run check:core` fails when a core file was changed instead.

## Files

| File | What it holds | Runs in |
|---|---|---|
| `index.ts` | Sidebar entries, pages, project tabs, Dashboard cards, Settings pages | the browser |
| `api.ts` | API endpoints at `/api/x/...` | the server |
| `middleware.ts` | Extra paths open without signing in | the edge middleware |
| `theme.css` | Fonts, surface CSS variables and rules, loaded after core's | the browser |
| `next.config.ts` | Next.js settings merged over core's | the build |
| `env.example` | This install's own environment variables | |

The name, tagline, brand colors, logos and favicon are not code: an Owner sets them in **Settings > Workspace > Brand**, and they reach the app, the client portal, emails and invoice PDFs from there.

Other public files (images, downloads) go in `public/custom`. Any file there is public at `/custom/<name>`.

## Plug-in points

Every item can take `module` (shown only while that module is on), `permission` and `roles`. A duplicate slug or key stops the build and names it.

```ts
// index.ts
export default defineExtensions({
  navItems: [{ href: '/x/reports', label: 'Reports', icon: BarChart3, after: '/projects' }],
  pages: [{ slug: 'reports', title: 'Reports', component: ReportsPage }],          // /x/reports
  projectTabs: [{ key: 'scorecard', label: 'Scorecard', component: ScorecardTab }], // gets { project }
  dashboardWidgets: [{ key: 'targets', title: 'This month', placement: 'top', component: TargetsCard }],
  settingsSections: [{ key: 'crm', label: 'CRM', icon: Plug, component: CrmSettings }], // Owners only by default
});

// api.ts: protected by default
export default defineApiRoutes([
  { path: 'reports/weekly', method: 'GET', handler: async ({ session }) => success(await weekly(session.client)) },
  { path: 'clients/:id', method: 'GET', auth: 'api-key', permission: 'projects.read', handler: async ({ params, api }) => ... },
  { path: 'crm/hook', method: 'POST', auth: 'public', handler: async ({ request }) => ... }, // check its signature yourself
]);

// middleware.ts
export default definePublicPaths(['/book-a-call']);
```

`auth` is `'session'` when left out (a signed-in member), `'api-key'` (needs `permission`) or `'public'` (only when written out). Pages render inside the normal shell with the page title as the header.

**Crons** are not a plug-in point: add the schedule to `vercel.json` (the upgrade keeps an install's crons) pointing at an `/api/x/...` route with `auth: 'public'`, and have the handler check `Authorization: Bearer ${process.env.CRON_SECRET}`.

## Database

Custom migrations go in `supabase/migrations/custom/*.sql` and touch only the `custom` schema: its tables can reference `public` tables by foreign key, but never alter them. `npm run db:migrate` runs them after core's; `npm run check:core` refuses anything outside `custom`. See `supabase/migrations/custom/README.md`.

## Upgrades

1. Keep every change in the paths above.
2. Run `npm run upgrade` to merge a release; core files take the release's copy.
3. Need a core change? Propose it upstream, or ask for a new plug-in point.
