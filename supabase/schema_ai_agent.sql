-- ============================================================
-- AGENTIC WORKFLOW SYSTEM MIGRATION
-- Run after schema.sql
-- ============================================================

-- 1a. Add 'agent' role to team_members
ALTER TABLE public.team_members
  DROP CONSTRAINT IF EXISTS team_members_role_check,
  ADD CONSTRAINT team_members_role_check CHECK (role IN ('admin', 'member', 'guest', 'agent'));

-- 1b. Add team_member_id to api_keys (links API key to an agent member)
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_team_member_id ON public.api_keys(team_member_id);

-- 1c. Add 'suggestion', 'goal', and 'question' to team_member_notifications entity_type
ALTER TABLE public.team_member_notifications
  DROP CONSTRAINT IF EXISTS team_member_notifications_entity_type_check;
ALTER TABLE public.team_member_notifications
  ADD CONSTRAINT team_member_notifications_entity_type_check
    CHECK (entity_type IN ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question'));

-- ============================================================
-- 2. PROJECT GOALS
-- ============================================================
CREATE TABLE public.project_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  target_date text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'paused', 'abandoned')),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_goals_project_id ON public.project_goals(project_id);
CREATE INDEX idx_project_goals_status ON public.project_goals(status);
CREATE INDEX idx_project_goals_archived_at ON public.project_goals(archived_at) WHERE archived_at IS NULL;

ALTER TABLE public.project_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_goals_all" ON public.project_goals FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER set_project_goals_updated_at BEFORE UPDATE ON public.project_goals FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================
-- 3. TASK SUGGESTIONS
-- ============================================================
CREATE TABLE public.task_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL REFERENCES public.project_goals(id) ON DELETE CASCADE,
  proposed_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  assigned_to uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text NOT NULL,
  reasoning text NOT NULL,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  effort_estimate text CHECK (effort_estimate IN ('small', 'medium', 'large') OR effort_estimate IS NULL),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'needs_info', 'approved', 'rejected', 'declined')),
  reviewed_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  rejection_reason text,
  info_request text,
  converted_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_suggestions_project_id ON public.task_suggestions(project_id);
CREATE INDEX idx_task_suggestions_goal_id ON public.task_suggestions(goal_id);
CREATE INDEX idx_task_suggestions_proposed_by ON public.task_suggestions(proposed_by);
CREATE INDEX idx_task_suggestions_status ON public.task_suggestions(status);
CREATE INDEX idx_task_suggestions_converted_task_id ON public.task_suggestions(converted_task_id) WHERE converted_task_id IS NOT NULL;

ALTER TABLE public.task_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "task_suggestions_all" ON public.task_suggestions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER set_task_suggestions_updated_at BEFORE UPDATE ON public.task_suggestions FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================
-- 4. Add goal_id and source_task_suggestion_id to tasks
-- ============================================================
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS project_goal_id uuid REFERENCES public.project_goals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_task_suggestion_id uuid REFERENCES public.task_suggestions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_project_goal_id ON public.tasks(project_goal_id) WHERE project_goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_source_task_suggestion_id ON public.tasks(source_task_suggestion_id) WHERE source_task_suggestion_id IS NOT NULL;

-- ============================================================
-- 5. AGENT ACTIVITY
-- ============================================================
CREATE TABLE public.agent_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  -- Legacy values are grandfathered; the typed vocabulary is owned by
  -- src/lib/agent-events.ts (payload schemas + server-generated titles).
  activity_type text NOT NULL CHECK (activity_type IN (
    'suggestion_created', 'task_started', 'task_completed', 'task_failed',
    'research_started', 'research_completed', 'suggestion_reviewed',
    'comment_added', 'status_changed',
    'agent_spawned', 'agent_completed', 'agent_failed',
    'heartbeat', 'system_check',
    'custom',
    'work.claimed', 'work.milestone', 'work.handoff', 'work.done',
    'review.started', 'review.verdict',
    'audit.finding', 'audit.no_work', 'spec.completed',
    'queue.empty', 'blocked',
    'billing.started', 'billing.paused', 'billing.resumed', 'billing.stopped'
  )),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  reference_type text,
  reference_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_activities_agent_id ON public.agent_activities(agent_id);
CREATE INDEX idx_agent_activities_project_id ON public.agent_activities(project_id);
CREATE INDEX idx_agent_activities_activity_type ON public.agent_activities(activity_type);
CREATE INDEX idx_agent_activities_created_at ON public.agent_activities(created_at DESC);

ALTER TABLE public.agent_activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_activities_all" ON public.agent_activities FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 6. API AUDIT LOG (NOT gated behind ENABLE_AGENTS)
-- ============================================================
CREATE TABLE public.api_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  endpoint text NOT NULL,
  entity_type text,
  entity_id uuid,
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  request_body jsonb,
  before_snapshot jsonb,
  after_snapshot jsonb,
  status_code integer NOT NULL,
  error text
);

CREATE INDEX idx_api_audit_log_timestamp ON public.api_audit_log(timestamp DESC);
CREATE INDEX idx_api_audit_log_entity ON public.api_audit_log(entity_type, entity_id);
CREATE INDEX idx_api_audit_log_team_member ON public.api_audit_log(team_member_id);
CREATE INDEX idx_api_audit_log_api_key ON public.api_audit_log(api_key_id);

ALTER TABLE public.api_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_audit_log_all" ON public.api_audit_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 7. AUTONOMOUS MODE FOR PROJECTS
-- ============================================================
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS autonomous_enabled boolean NOT NULL DEFAULT false;

-- ============================================================
-- 8. TASK TYPE FOR TASKS AND SUGGESTIONS
-- ============================================================
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS task_type text
    CHECK (task_type IN ('engineering','research','audit','marketing','copywriting','operations','general') OR task_type IS NULL);

ALTER TABLE public.task_suggestions
  ADD COLUMN IF NOT EXISTS task_type text
    CHECK (task_type IN ('engineering','research','audit','marketing','copywriting','operations','general') OR task_type IS NULL);

-- ============================================================
-- 9. (RETIRED 2026-08-04) AI MANAGED FLAG FOR TASKS
-- ============================================================
-- ai_managed was superseded by tasks.ai_readiness ('ai_ready' | 'human_only')
-- and the column was dropped. Kept as a numbered section so later sections'
-- numbering stays stable in diffs.

-- ============================================================
-- 10. DEPLOYMENT POLICY FOR PROJECTS
-- ============================================================
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS deployment_policy text NOT NULL DEFAULT 'production'
    CHECK (deployment_policy IN ('playground', 'production'));
