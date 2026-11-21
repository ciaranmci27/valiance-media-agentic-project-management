-- Installs built from supabase/schema.sql before 1.2.0 ran the agent tables'
-- file after schema.sql, so its access policies were skipped and four tables
-- kept open policies (any signed-in member could read and write them): the
-- API audit log, project goals, task suggestions and the agent activity log.
-- This puts the intended policies in place, and adds the agent tables and
-- reminders to Realtime, which those installs also skipped. A database built by migrations
-- already has them, and nothing changes there. Safe to re-run.
DO $$
BEGIN
  IF to_regclass('public.project_goals') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "project_goals_all" ON public.project_goals';
    EXECUTE 'DROP POLICY IF EXISTS project_goals_access ON public.project_goals';
    EXECUTE 'CREATE POLICY project_goals_access ON public.project_goals FOR ALL TO authenticated
      USING (public.has_permission(''goals.read'') AND public.can_access_project(project_id))
      WITH CHECK (public.has_permission(''goals.manage'') AND public.can_access_project(project_id))';
  END IF;
  IF to_regclass('public.task_suggestions') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "task_suggestions_all" ON public.task_suggestions';
    EXECUTE 'DROP POLICY IF EXISTS task_suggestions_access ON public.task_suggestions';
    EXECUTE 'CREATE POLICY task_suggestions_access ON public.task_suggestions FOR ALL TO authenticated
      USING (public.has_permission(''suggestions.manage'') AND public.can_access_project(project_id))
      WITH CHECK (public.has_permission(''suggestions.manage'') AND public.can_access_project(project_id))';
  END IF;
  IF to_regclass('public.agent_activities') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "agent_activities_all" ON public.agent_activities';
    EXECUTE 'DROP POLICY IF EXISTS agent_activities_access ON public.agent_activities';
    EXECUTE 'CREATE POLICY agent_activities_access ON public.agent_activities FOR ALL TO authenticated
      USING (public.has_permission(''agents.manage'') OR agent_id = public.current_team_member_id())
      WITH CHECK (public.has_permission(''agents.manage'') OR agent_id = public.current_team_member_id())';
  END IF;
  IF to_regclass('public.api_audit_log') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "api_audit_log_all" ON public.api_audit_log';
    EXECUTE 'DROP POLICY IF EXISTS api_audit_log_access ON public.api_audit_log';
    EXECUTE 'CREATE POLICY api_audit_log_access ON public.api_audit_log FOR SELECT TO authenticated
      USING (public.has_permission(''audit.read''))';
  END IF;
END;
$$;

-- Realtime for the agent tables and reminders, which those installs skipped.
DO $$
DECLARE
  agent_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOREACH agent_table IN ARRAY ARRAY['agent_activities', 'task_suggestions', 'project_goals', 'reminders'] LOOP
    IF to_regclass('public.' || agent_table) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = agent_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', agent_table);
    END IF;
  END LOOP;
END;
$$;
