-- Task spec layer: AI-readiness classification, acceptance criteria,
-- task dependencies, per-task billable time, agent question notifications.
-- Supports the directed dev-agent workflow: tasks must be explicitly
-- classified and specced before an AI agent may pick them up.

-- ============================================================
-- 1. AI-readiness classification (explicit; NULL = unclassified)
-- ============================================================
alter table public.tasks
  add column if not exists ai_readiness text
    check (ai_readiness in ('ai_ready', 'human_only', 'hybrid') or ai_readiness is null);

-- ============================================================
-- 2. Legacy ai_managed flips away from default-true. The column normally
--    ships via schema_ai_agent.sql, so guard with ADD IF NOT EXISTS first.
-- ============================================================
alter table public.tasks add column if not exists ai_managed boolean not null default false;
alter table public.tasks alter column ai_managed set default false;

-- ============================================================
-- 3. Acceptance criteria (addressable checklist; mirrors task_subtasks)
-- ============================================================
create table if not exists public.task_acceptance_criteria (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  criterion text not null,
  satisfied boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_task_acceptance_criteria_task_id
  on public.task_acceptance_criteria(task_id);

alter table public.task_acceptance_criteria enable row level security;

drop trigger if exists set_task_acceptance_criteria_updated_at on public.task_acceptance_criteria;
create trigger set_task_acceptance_criteria_updated_at
  before update on public.task_acceptance_criteria
  for each row execute function public.handle_updated_at();

drop policy if exists task_acceptance_criteria_select on public.task_acceptance_criteria;
create policy task_acceptance_criteria_select on public.task_acceptance_criteria for select to authenticated
  using (public.can_access_task(task_id));

drop policy if exists task_acceptance_criteria_manage on public.task_acceptance_criteria;
create policy task_acceptance_criteria_manage on public.task_acceptance_criteria for all to authenticated
  using (public.can_access_task(task_id) and (
    public.has_permission('tasks.manage_all') or (
      public.has_permission('tasks.manage_assigned') and exists (
        select 1 from public.task_assignees assignment
        where assignment.task_id = task_acceptance_criteria.task_id
          and assignment.member_id = public.current_team_member_id()
      )
    )
  )) with check (public.can_access_task(task_id) and (
    public.has_permission('tasks.manage_all') or exists (
      select 1 from public.task_assignees assignment
      where assignment.task_id = task_acceptance_criteria.task_id
        and assignment.member_id = public.current_team_member_id()
    )
  ));

-- ============================================================
-- 4. Task dependencies (junction; house style = task_assignees).
--    A task with unmet dependencies is refused by the dev agent.
-- ============================================================
create table if not exists public.task_dependencies (
  task_id uuid not null references public.tasks(id) on delete cascade,
  blocked_by_task_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, blocked_by_task_id),
  check (task_id <> blocked_by_task_id)
);

create index if not exists idx_task_dependencies_blocked_by
  on public.task_dependencies(blocked_by_task_id);

alter table public.task_dependencies enable row level security;

drop policy if exists task_dependencies_select on public.task_dependencies;
create policy task_dependencies_select on public.task_dependencies for select to authenticated
  using (public.can_access_task(task_id));

drop policy if exists task_dependencies_manage on public.task_dependencies;
create policy task_dependencies_manage on public.task_dependencies for all to authenticated
  using (public.can_access_task(task_id) and (
    public.has_permission('tasks.manage_all') or (
      public.has_permission('tasks.manage_assigned') and exists (
        select 1 from public.task_assignees assignment
        where assignment.task_id = task_dependencies.task_id
          and assignment.member_id = public.current_team_member_id()
      )
    )
  )) with check (public.can_access_task(task_id) and (
    public.has_permission('tasks.manage_all') or exists (
      select 1 from public.task_assignees assignment
      where assignment.task_id = task_dependencies.task_id
        and assignment.member_id = public.current_team_member_id()
    )
  ));

-- ============================================================
-- 5. Per-task billable time: one work session can span multiple
--    tasks (junction; house style = task_assignees). Deleting a task
--    or an entry cleans its links without destroying the other side.
-- ============================================================
create table if not exists public.time_entry_tasks (
  time_entry_id uuid not null references public.project_time_entries(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (time_entry_id, task_id)
);

create index if not exists idx_time_entry_tasks_task
  on public.time_entry_tasks(task_id);

alter table public.time_entry_tasks enable row level security;

drop policy if exists "time_entry_tasks_all" on public.time_entry_tasks;
create policy "time_entry_tasks_all" on public.time_entry_tasks
  for all to authenticated using (true) with check (true);

-- An earlier iteration of this migration used a single task_id column on
-- project_time_entries; carry any linked rows into the junction and drop it.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_time_entries'
      and column_name = 'task_id'
  ) then
    insert into public.time_entry_tasks (time_entry_id, task_id)
      select id, task_id from public.project_time_entries where task_id is not null
      on conflict do nothing;
    alter table public.project_time_entries drop column if exists task_id;
  end if;
end;
$$;

-- ============================================================
-- 6. Agent role grants: own-timer tracking + owner notifications
-- ============================================================
insert into public.role_permissions (role, permission_key, access_channel) values
  ('agent', 'time.manage_own', 'api'),
  ('agent', 'notifications.send', 'api')
on conflict do nothing;

-- ============================================================
-- 7. Agent billing multiplier. The member's dial (current value) is
--    snapshotted onto each time entry at session start. When an AGENT
--    member stops a timer, the session is converted into one continuous
--    slot: worked time (pauses excluded) times the snapshotted
--    multiplier, anchored at the real start time. 1.00 = parity;
--    humans are never converted.
-- ============================================================
alter table public.team_members
  add column if not exists billing_multiplier numeric(4,2) not null default 1.00
    check (billing_multiplier > 0);

alter table public.project_time_entries
  add column if not exists billing_multiplier numeric(4,2) not null default 1.00
    check (billing_multiplier > 0);

-- ============================================================
-- 8. Widen notification entity types for agent questions
-- ============================================================
alter table public.team_member_notifications
  drop constraint if exists team_member_notifications_entity_type_check;
alter table public.team_member_notifications
  add constraint team_member_notifications_entity_type_check
  check (entity_type in ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question'));
