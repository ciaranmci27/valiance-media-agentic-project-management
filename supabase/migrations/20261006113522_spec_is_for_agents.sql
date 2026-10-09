-- A spec is for agent work only.
--
-- A spec (description, acceptance criteria, AI-ready, assignee) only matters
-- when the dev agent will do the work on its own. Most tasks are a person's
-- work and need none of it. Until now a task with no readiness was read as
-- "needs spec", so every task created without a label nagged the owner.
--
-- From here:
-- - NULL readiness is a normal task a person does, the same as 'human_only'
--   (which stays valid).
-- - 'needs_spec' is a deliberate state: meant for the dev agent, spec not
--   written yet. It is the only thing the app shows as "Needs spec". The dev
--   agent claims 'ai_ready' tasks only, so a 'needs_spec' task is never
--   claimable.
-- - Rule 3 is gone: a task linked to a client email is a normal task, and it
--   becomes ai_ready the same way any task does (the owner confirms a spec,
--   in the app or in a conversation with the PM agent). The PM agent's email
--   jobs still never change readiness; that rule lives in the agent.

-- 1. The new readiness value.
ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_ai_readiness_check;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_ai_readiness_check
  CHECK (ai_readiness IN ('ai_ready', 'needs_spec', 'human_only') OR ai_readiness IS NULL);

-- 2. The "[Needs spec interview before development]" marker is retired: the
-- approve flow writes 'needs_spec' instead. Tasks that carry it keep their
-- readiness (unlabelled ones stay a person's task; the owner re-marks any
-- that are really for the dev agent) and lose the marker line, on every task
-- whatever its status or readiness. Only the marker and the blank lines it
-- leaves are removed: at the start of the text, the marker and the line
-- breaks after it; anywhere else, the line breaks before it.
UPDATE public.tasks
SET description = regexp_replace(
  regexp_replace(description, '^[ \t]*\[Needs spec interview before development\][ \t]*[\r\n]*', ''),
  '[\r\n]*[ \t]*\[Needs spec interview before development\][ \t]*', '', 'g')
WHERE position('[Needs spec interview before development]' IN description) > 0;

-- 3. Rule 3 removed (from 20261006010922_email_inboxes.sql).
DROP TRIGGER IF EXISTS email_task_ai_ready_guard ON public.tasks;
DROP TRIGGER IF EXISTS email_task_link_guard ON public.email_task_links;
DROP FUNCTION IF EXISTS public.email_task_ai_ready_guard();
DROP FUNCTION IF EXISTS public.email_task_link_guard();
DROP FUNCTION IF EXISTS public.is_human_session();
