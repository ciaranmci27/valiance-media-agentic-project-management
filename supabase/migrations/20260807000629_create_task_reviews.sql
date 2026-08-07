-- Independent PR review verdicts (the John reviewer agent). One row per
-- review round; the latest row for a task is its current verdict. head_sha
-- records the exact PR head that was reviewed so the automerge gate can
-- refuse to merge commits pushed after approval.
--
-- Writes go through the v1 agent API with the service client; authenticated
-- users only read (there is deliberately no insert/update policy).

create table if not exists public.task_reviews (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  round int not null default 1,
  verdict text not null check (verdict in ('approved', 'changes_requested')),
  summary text,
  pr_url text,
  head_sha text,
  reviewer_member_id uuid references public.team_members(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_task_reviews_task_created
  on public.task_reviews(task_id, created_at desc);

alter table public.task_reviews enable row level security;

drop policy if exists task_reviews_select on public.task_reviews;
create policy task_reviews_select on public.task_reviews for select to authenticated
  using (public.can_access_task(task_id));

-- An approved verdict inserts only a review row (the task row is untouched),
-- so without realtime on this table the "reviewed" badge waits for an
-- unrelated refetch.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'task_reviews'
     ) then
    alter publication supabase_realtime add table public.task_reviews;
  end if;
end $$;
