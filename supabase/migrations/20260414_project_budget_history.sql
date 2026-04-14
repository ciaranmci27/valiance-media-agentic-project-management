-- Append-only audit log for every change to a project's budget.
-- Captures ALL transitions: first-time set (null -> value), clears (value -> null),
-- numeric changes, and type-only changes (hours <-> amount at same value).
-- The projects.budget_type / budget_value columns remain the fast-path "current"
-- cache; this table is the source of truth for history.

CREATE TABLE public.project_budget_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  old_type text CHECK (old_type IN ('hours', 'amount')),
  new_type text CHECK (new_type IN ('hours', 'amount')),
  old_value numeric(12,2),
  new_value numeric(12,2),
  changed_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_budget_history_project
  ON public.project_budget_history(project_id, created_at DESC);

ALTER TABLE public.project_budget_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_budget_history_all" ON public.project_budget_history
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Backfill: seed a row for every project that already has a budget set,
-- so history is complete from the moment this table exists. The seed row
-- uses the project's created_at so the timeline matches the project's birth.
INSERT INTO public.project_budget_history
  (project_id, old_type, new_type, old_value, new_value, changed_by, created_at)
SELECT
  p.id,
  NULL,
  p.budget_type,
  NULL,
  p.budget_value,
  p.created_by,
  p.created_at
FROM public.projects p
WHERE p.budget_type IS NOT NULL OR p.budget_value IS NOT NULL;
