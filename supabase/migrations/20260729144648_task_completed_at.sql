-- Task completion timestamps + reorder-safe updated_at
--
-- Problem: the dashboard inferred "completed" from updated_at of done tasks.
-- Dragging a task into a column resequences sort_order for every sibling that
-- shifted, and the generic updated_at trigger bumped all of them, so one
-- completion looked like dozens and every done task showed "1 minute ago".
--
-- Fix:
--  1. Dedicated tasks.completed_at column, maintained by trigger on status
--     transitions (set when entering 'done', cleared when leaving it).
--  2. Task-specific updated_at trigger that skips the bump when the only
--     change is sort_order (cosmetic reorders).

alter table public.tasks add column if not exists completed_at timestamptz;

-- Best-effort backfill: for tasks already done, the last update is the
-- closest thing we have to a completion time.
update public.tasks set completed_at = updated_at
  where status = 'done' and completed_at is null;

create or replace function public.handle_task_before_update()
returns trigger as $$
begin
  -- Maintain completed_at on status transitions
  if new.status = 'done' and old.status is distinct from 'done' then
    new.completed_at = now();
  elsif new.status is distinct from 'done' then
    new.completed_at = null;
  end if;

  -- Reorder-only writes are cosmetic; keep updated_at meaningful
  if (to_jsonb(new) - 'sort_order' - 'updated_at') is distinct from (to_jsonb(old) - 'sort_order' - 'updated_at') then
    new.updated_at = now();
  else
    new.updated_at = old.updated_at;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function public.handle_task_before_insert()
returns trigger as $$
begin
  if new.status = 'done' and new.completed_at is null then
    new.completed_at = now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_tasks_updated_at on public.tasks;

drop trigger if exists tasks_before_update on public.tasks;
create trigger tasks_before_update
  before update on public.tasks
  for each row execute function public.handle_task_before_update();

drop trigger if exists tasks_before_insert on public.tasks;
create trigger tasks_before_insert
  before insert on public.tasks
  for each row execute function public.handle_task_before_insert();
