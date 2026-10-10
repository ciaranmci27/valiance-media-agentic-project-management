-- Honest Agent Analytics: the two things the page needs that no telemetry row
-- carries. Safe to re-run.

-- 1. Billing gap reviews. The billing audit posts each stretch of Jeff's work
-- that no time entry segment covers (agent_activities, billing.gap). Ciaran
-- marks each one reconciled (he logged the time) or dismissed (it was not
-- billable), with a note. A review never creates or changes a time entry, and
-- the gap row itself stays immutable telemetry.
create table if not exists public.agent_billing_gap_reviews (
  activity_id uuid primary key references public.agent_activities(id) on delete cascade,
  status text not null check (status in ('reconciled', 'dismissed')),
  note text not null default '' check (char_length(note) <= 1000),
  reviewed_by uuid references public.team_members(id) on delete set null,
  reviewed_at timestamptz not null default now()
);

alter table public.agent_billing_gap_reviews enable row level security;

drop policy if exists agent_billing_gap_reviews_access on public.agent_billing_gap_reviews;
create policy agent_billing_gap_reviews_access on public.agent_billing_gap_reviews for all to authenticated
  using (public.has_permission('agents.manage'))
  with check (public.has_permission('agents.manage'));

grant select, insert, update, delete on public.agent_billing_gap_reviews to authenticated;

-- Who reviewed and when is the database's to say, not the client's.
create or replace function public.stamp_billing_gap_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.reviewed_by := public.current_team_member_id();
  new.reviewed_at := now();
  return new;
end;
$$;

revoke all on function public.stamp_billing_gap_review() from public;

drop trigger if exists stamp_billing_gap_review on public.agent_billing_gap_reviews;
create trigger stamp_billing_gap_review
  before insert or update on public.agent_billing_gap_reviews
  for each row execute function public.stamp_billing_gap_review();

-- 2. Task reopens. A task leaving `done` was not finished after all, and
-- nothing recorded that: completed_at is cleared on the way out, so the
-- history was lost. From this migration on every reopen is one row, written
-- by the database whoever moves the task (the app, the API, an agent).
create table if not exists public.task_reopens (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  to_status text not null,
  reopened_by uuid references public.team_members(id) on delete set null,
  reopened_at timestamptz not null default now()
);

create index if not exists idx_task_reopens_reopened_at on public.task_reopens (reopened_at desc);

alter table public.task_reopens enable row level security;

drop policy if exists task_reopens_read on public.task_reopens;
create policy task_reopens_read on public.task_reopens for select to authenticated
  using (public.has_permission('agents.manage') and public.can_access_project(project_id));

grant select on public.task_reopens to authenticated;

create or replace function public.record_task_reopen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'done' and new.status is distinct from 'done' then
    insert into public.task_reopens (task_id, project_id, to_status, reopened_by)
    values (new.id, new.project_id, new.status, public.current_team_member_id());
  end if;
  return new;
end;
$$;

revoke all on function public.record_task_reopen() from public;

drop trigger if exists record_task_reopen on public.tasks;
create trigger record_task_reopen
  after update of status on public.tasks
  for each row execute function public.record_task_reopen();

-- 3. When each recorder began. A metric recorded from a moment on (reopens)
-- reads as "not measured" before that moment, never as zero, so the page
-- needs the real start, which is when this migration ran.
create table if not exists public.analytics_tracking_starts (
  metric text primary key,
  started_at timestamptz not null default now()
);

alter table public.analytics_tracking_starts enable row level security;

drop policy if exists analytics_tracking_starts_read on public.analytics_tracking_starts;
create policy analytics_tracking_starts_read on public.analytics_tracking_starts for select to authenticated
  using (public.has_permission('agents.manage'));

grant select on public.analytics_tracking_starts to authenticated;

insert into public.analytics_tracking_starts (metric) values ('task_reopens')
on conflict (metric) do nothing;
