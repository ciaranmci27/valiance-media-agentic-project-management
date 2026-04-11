-- Relax the "one running timer per project" unique index to "one running
-- timer per (project, member)" so multiple teammates can live-track the same
-- project at once. The old index was rejecting concurrent starts with a
-- unique-constraint 409 even when the members were different.

DROP INDEX IF EXISTS public.idx_project_time_entries_running;

CREATE UNIQUE INDEX idx_project_time_entries_running
  ON public.project_time_entries (project_id, member_id)
  WHERE end_time IS NULL;
