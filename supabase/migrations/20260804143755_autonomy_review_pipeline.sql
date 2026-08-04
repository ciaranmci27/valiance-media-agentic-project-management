-- Autonomy review pipeline, part 1 of 2 (part 2 drops tasks.ai_managed once the
-- code that references it is deployed; dropping now would break live clients).
--
-- 1. Suggestion review gains a third outcome. "declined" means "we do not want
--    this, no comment": unlike "rejected" it writes no lesson_learned entry and
--    is excluded from per-question approval-rate tallies, so housekeeping (for
--    example declining four sibling instances of a pattern after approving the
--    class-level fix) cannot teach the auditing agent that the finding class
--    was unwanted.
--
-- 2. Task readiness becomes binary. "hybrid" was never a valid state for a
--    task, only a decomposition signal meaning "split me into an ai_ready task
--    and a human_only task"; it survives on suggestions (jsonb metadata,
--    unconstrained) and in Ashley's vocabulary. Zero tasks carried 'hybrid' at
--    the time of this migration (verified in production before tightening).

ALTER TABLE public.task_suggestions
  DROP CONSTRAINT IF EXISTS task_suggestions_status_check;
ALTER TABLE public.task_suggestions
  ADD CONSTRAINT task_suggestions_status_check
  CHECK (status IN ('pending', 'needs_info', 'approved', 'rejected', 'declined'));

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_ai_readiness_check;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_ai_readiness_check
  CHECK (ai_readiness IN ('ai_ready', 'human_only') OR ai_readiness IS NULL);

-- 3. ai_managed is retired entirely; ai_readiness is the one classification.
--    ORDERING: execute this statement only AFTER the app code that stopped
--    referencing ai_managed is deployed. The previously deployed client sends
--    ai_managed on task inserts, so dropping the column first would break task
--    creation in production until the deploy lands.
ALTER TABLE public.tasks DROP COLUMN IF EXISTS ai_managed;
