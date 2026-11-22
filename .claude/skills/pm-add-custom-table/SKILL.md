---
name: pm-add-custom-table
description: Add or change an install's own database tables, views, functions or policies. Load before writing any SQL for this install, or when a custom feature needs to store data.
---

# Add a custom table

Install SQL lives only in `supabase/migrations/custom/` and only in the database schema `pm_custom`. Core tables stay exactly as each release expects. Reference: `supabase/migrations/custom/README.md`.

## Allowed and not

- Allowed: `pm_custom.<name>` tables, views, functions and types; indexes, policies and triggers on custom tables; grants on schema `pm_custom`; foreign keys that reference `public` tables.
- Not allowed: creating, altering or dropping anything in `public` (or any schema but `custom`), including policies on core tables. `npm run check:core` fails on it.
- Need a column on a core table? Don't add it. Make a `custom` table keyed by the core row's id, or load `pm-propose-core-change`.

## Steps

1. **Name the file** with a timestamp so it sorts last: `supabase/migrations/custom/20261201120000_project_scores.sql`. One change per file. Never edit a file that has already run; add a new one.

2. **Write it** so it is safe to read and safe to run:
   ```sql
   create schema if not exists pm_custom;

   create table pm_custom.project_scores (
     id uuid primary key default gen_random_uuid(),
     project_id uuid not null references pm.projects (id) on delete cascade,
     score integer not null check (score between 0 and 100),
     created_at timestamptz not null default now()
   );
   create index project_scores_project_id_idx on pm_custom.project_scores (project_id);

   alter table pm_custom.project_scores enable row level security;
   create policy "Project members read scores" on pm_custom.project_scores
     for select to authenticated using (pm.can_access_project(project_id));

   grant usage on schema pm_custom to authenticated, service_role;
   grant select on pm_custom.project_scores to authenticated;
   grant all on pm_custom.project_scores to service_role;
   ```
   Always enable row level security. Reuse core's checks (`pm.can_access_project`, `pm.has_permission`) in policies instead of writing your own.

3. **Check the rule:** `npm run check:core`.

4. **Preview, then apply** (needs `SUPABASE_DB_URL` in `.env.local`: the session or direct connection, not the port 6543 pooler):
   ```bash
   npm run db:migrate -- --dry-run
   npm run db:migrate
   npm run db:migrate -- --status
   ```
   Each file runs once, in its own transaction, after core's migrations. A file edited after it ran is reported, never re-run.

5. **Read it from code.** Server routes in `src/custom/api.ts`: `session.client.schema('custom').from('project_scores')`. For the browser client, add `custom` to the exposed schemas in Supabase (API settings) first.

6. **Record it** under `## Our customizations` in `src/custom/AGENTS.md`.

## Check

```bash
npm run check:core
npx tsc --noEmit
npm run test:core
```
