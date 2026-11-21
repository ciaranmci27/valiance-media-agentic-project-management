# Custom migrations

This install's own database changes. `npm run db:migrate` runs every `*.sql` file here after core's migrations, in file name order, each in its own transaction, and records it so it runs once.

## The rule

Everything a custom migration creates, alters or drops lives in the `custom` schema. Core's tables stay exactly as each release expects, so core migrations never collide with yours. `npm run check:core` fails on any statement that reaches outside `custom`.

Allowed: `custom.<name>` tables, views, functions and types; indexes, policies and triggers on custom tables; grants on the schema or its objects; foreign keys that reference `public` tables. Not allowed: altering, dropping or adding policies to anything in `public`.

Name files with a timestamp so they sort in order: `20261201120000_project_scores.sql`.

## Example

A score per project, readable by members who can open the project (`public.can_access_project` is core's own check):

```sql
create schema if not exists custom;

create table custom.project_scores (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  score integer not null check (score between 0 and 100),
  note text,
  created_at timestamptz not null default now()
);

create index project_scores_project_id_idx on custom.project_scores (project_id);

alter table custom.project_scores enable row level security;

create policy "Project members read scores"
  on custom.project_scores for select
  to authenticated
  using (public.can_access_project(project_id));

grant usage on schema custom to authenticated, service_role;
grant select on custom.project_scores to authenticated;
grant all on custom.project_scores to service_role;
```

To read it through the Supabase client, add `custom` to the exposed schemas (Supabase dashboard, API settings), then `supabase.schema('custom').from('project_scores')`.
