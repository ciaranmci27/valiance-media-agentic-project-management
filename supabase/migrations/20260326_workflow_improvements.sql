-- ============================================================
-- Migration: Workflow Improvements
-- Description: Project context table, task sort order, project
--   velocity settings, and email notification preferences
-- ============================================================

-- 1. Project context table
CREATE TABLE IF NOT EXISTS project_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('business_context', 'existing_work', 'technical_decision', 'constraint', 'lesson_learned')),
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human', 'agent', 'scan')),
  file_path TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_context_project_id ON project_context(project_id);
CREATE INDEX IF NOT EXISTS idx_project_context_category ON project_context(project_id, category);
CREATE INDEX IF NOT EXISTS idx_project_context_active ON project_context(project_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_context_file_path
  ON project_context(project_id, file_path)
  WHERE file_path IS NOT NULL AND is_active = true;

CREATE TRIGGER set_project_context_updated_at
  BEFORE UPDATE ON project_context
  FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

ALTER TABLE project_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read project context"
  ON project_context FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert project context"
  ON project_context FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update project context"
  ON project_context FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete project context"
  ON project_context FOR DELETE TO authenticated USING (true);

-- 2. Task sort order for kanban reordering
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(project_id, status, sort_order);

-- 3. Project velocity settings for AI pacing
ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_concurrent_tasks INTEGER NOT NULL DEFAULT 2;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS suggestions_per_cycle INTEGER NOT NULL DEFAULT 3;

-- 4. Email notification preferences
ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_notification_prefs JSONB NOT NULL DEFAULT '{}';
