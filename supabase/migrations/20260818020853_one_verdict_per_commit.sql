-- The same bytes cannot be both approved and rejected.
--
-- Reviewer turns overlap, and when two of them reached opposite conclusions
-- about one commit, both verdicts were recorded and each minted a review round.
-- One PR reached eleven rounds that way, including an approval undone twelve
-- minutes later by a review of the identical SHA, which sent the developer back
-- to rebuild approved work on the client's bill.
--
-- The API now returns the first verdict for a commit instead of filing a second.
-- This index is the backstop for the case the API cannot win: two concurrent
-- inserts that both pass the pre-check. One commits, the other fails.

-- Existing contradictions are collapsed to the FIRST verdict per commit, which
-- is the rule going forward. Later rows lose; created_at breaks ties by id so a
-- pair written in the same instant still resolves to exactly one survivor.
delete from public.task_reviews later
using public.task_reviews keep
where later.task_id = keep.task_id
  and later.pr_url is not distinct from keep.pr_url
  and later.head_sha = keep.head_sha
  and (later.created_at, later.id) > (keep.created_at, keep.id);

create unique index if not exists idx_task_reviews_commit_identity
  on public.task_reviews (task_id, pr_url, head_sha);
