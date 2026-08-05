-- A cycle's burst may never exceed the review queue's capacity: findings per
-- cycle above the queue cap is incoherent (one run could overflow the queue
-- the cap exists to protect). The UI clamps the pair together; this is the
-- backstop that makes the invariant hold no matter who writes.
alter table public.projects
  add constraint projects_per_cycle_within_queue_cap_check
    check (suggestions_per_cycle <= suggestion_queue_cap);
