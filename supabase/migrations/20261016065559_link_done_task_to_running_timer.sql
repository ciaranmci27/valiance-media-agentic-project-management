-- A task a signed-in member moves to done while their own timer is running on that
-- project joins that session, so work finished mid-session is tied to its time with
-- no one linking it by hand. Only the web app's signed-in writes carry auth.uid():
-- API writes (agents, the recap skill, scripts) never fire this, and a task dragged
-- to done later, with no timer running, is left for the recap to link by evidence.

create or replace function public.link_done_task_to_running_timer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member uuid;
begin
  if auth.uid() is null then
    return null;
  end if;

  select id into v_member
  from public.team_members
  where auth_user_id = auth.uid()
  limit 1;
  if v_member is null then
    return null;
  end if;

  -- Running, not paused: the session is open and its last segment has no end.
  insert into public.time_entry_tasks (time_entry_id, task_id)
  select te.id, new.id
  from public.project_time_entries te
  where te.project_id = new.project_id
    and te.member_id = v_member
    and te.end_time is null
    and jsonb_array_length(te.segments) > 0
    and te.segments -> -1 ->> 'end' is null
  on conflict do nothing;

  return null;
end;
$$;

revoke all on function public.link_done_task_to_running_timer() from public, anon, authenticated;

drop trigger if exists tasks_link_done_to_running_timer on public.tasks;
create trigger tasks_link_done_to_running_timer
  after update of status on public.tasks
  for each row
  when (new.status = 'done' and old.status is distinct from 'done')
  execute function public.link_done_task_to_running_timer();
