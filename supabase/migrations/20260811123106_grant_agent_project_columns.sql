-- The live floor reads one autonomous project's branch straight from the
-- client, for the branch name on Jeff's status bar:
--
--   from('projects').select('id, name, integration_branch')
--     .eq('autonomous_enabled', true)
--
-- `projects` carries COLUMN-level SELECT grants for authenticated (the
-- api_scope_integrity pass restricted direct reads to non-financial columns
-- so RLS cannot expose billing rates), and that grant list predates the
-- agent columns — so PostgREST answers 403 for the two it names, and the
-- scene silently loses the branch. Neither column is financial: one is a
-- feature flag, the other a git branch name. Row visibility stays governed
-- by the projects RLS policies either way.
--
-- Column grants are additive, so this extends the existing grant rather
-- than restating it, and re-running it is harmless.
GRANT SELECT (autonomous_enabled, integration_branch) ON public.projects TO authenticated;

-- ---------------------------------------------------------------------------
-- Agent infrastructure heartbeats.
--
-- Everything the app knew about agent state came from prose in
-- agent_activities, so "working" was an inference from milestone wording and
-- "the VPS is down" was unknowable: an agent that says nothing and an agent
-- whose host is off look identical from here. This table carries the
-- authoritative facts instead, published every minute by a cron on the VPS
-- reading each agent's container state and execution ledger (the same
-- sources the deploy tooling trusts).
--
-- One row per agent, upserted in place: this is current state, not history
-- (agent_activities remains the narrative log). The reader's contract:
--   - reported_at fresh + turn_running     -> the agent is mid-turn, working.
--   - reported_at fresh + no turn          -> idle, whatever prose said.
--   - container not running                -> offline (red).
--   - reported_at stale (publisher silent) -> offline (red): the publisher
--     promises a beat every minute, so a missing beat IS evidence of an
--     outage, unlike agent silence, which is normal.
--
-- Writes go through the v1 agent API with the service client; authenticated
-- users only read (deliberately no insert/update policy).
create table if not exists public.agent_health (
  member_id uuid primary key references public.team_members(id) on delete cascade,
  container text not null,
  container_running boolean not null default false,
  turn_running boolean not null default false,
  -- When the in-flight turn began, for truthful "working for Xm" timers.
  turn_started_at timestamptz,
  reported_at timestamptz not null default now()
);

alter table public.agent_health enable row level security;

drop policy if exists agent_health_select on public.agent_health;
create policy agent_health_select on public.agent_health for select to authenticated
  using (true);

-- The scene and the fleet strip both react to these rows live; a heartbeat
-- that only lands on refetch would defeat its purpose.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'agent_health'
     )
  then
    alter publication supabase_realtime add table public.agent_health;
  end if;
end $$;
