-- Availability needs history, and agent_health has none by design: it is one
-- row per agent, upserted in place every minute, so an outage is invisible the
-- moment it ends. Uptime, downtime, and "how often does the fleet fall over"
-- are therefore unanswerable today.
--
-- A trigger records transitions rather than the publisher posting them, so no
-- host script changes and no state change can be missed: whatever the publisher
-- writes, the transition is captured. Only CHANGES are stored, so a minute
-- heartbeat that says the same thing costs nothing.
create table if not exists public.agent_health_history (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  container_running boolean not null,
  turn_running boolean not null,
  -- The publisher's own clock, not the database's: a delayed write must not
  -- shift when the state actually changed.
  changed_at timestamptz not null
);

create index if not exists idx_agent_health_history_member
  on public.agent_health_history (member_id, changed_at desc);

create or replace function public.log_agent_health_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Container transitions only. Turn starts and stops are already recorded, in
  -- full and reconciled, as turn.completed events; triggering on them here
  -- would add thousands of rows a month that availability never reads.
  if tg_op = 'INSERT'
     or new.container_running is distinct from old.container_running then
    insert into public.agent_health_history (member_id, container_running, turn_running, changed_at)
    values (new.member_id, new.container_running, new.turn_running, new.reported_at);
  end if;
  return new;
end;
$$;

drop trigger if exists agent_health_history_trigger on public.agent_health;
create trigger agent_health_history_trigger
  after insert or update on public.agent_health
  for each row execute function public.log_agent_health_change();

alter table public.agent_health_history enable row level security;

-- Same posture as agent_health: written by the service client through the
-- trigger, readable by signed-in members.
drop policy if exists agent_health_history_select on public.agent_health_history;
create policy agent_health_history_select on public.agent_health_history
  for select to authenticated using (true);

-- Seed the current state so availability is measured from this moment rather
-- than from the first transition, which could be days away for a stable fleet.
-- Guarded on the table being empty: transitions have no natural key, so a
-- second run would otherwise duplicate the starting point and inflate uptime.
insert into public.agent_health_history (member_id, container_running, turn_running, changed_at)
select member_id, container_running, turn_running, reported_at
from public.agent_health
where not exists (select 1 from public.agent_health_history);
