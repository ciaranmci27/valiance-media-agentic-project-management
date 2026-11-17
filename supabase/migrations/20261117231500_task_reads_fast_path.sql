-- Reading tasks as someone who sees every project's tasks (the owner, an
-- admin) ran the full access check on every task and again on every comment,
-- assignee, checklist item, review and blocker: three or four permission
-- lookups a row, about 4 seconds for the task list, so the list timed out
-- (8 seconds) when the app loaded everything at sign-in. Such a reader now
-- passes on one permission check the statement runs once, plus one indexed
-- lookup a row (its project, or its task, still live: the soft-delete
-- helpers project_is_live and task_is_live, unchanged).
--
-- Who sees what is unchanged: for a reader with tasks.read and
-- projects.read_all, the fast path is exactly what the full check returns
-- (can_access_project is then "the project is live"); everyone else takes the
-- full check, as before.

CREATE OR REPLACE FUNCTION public.can_read_all_tasks()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_permission('tasks.read') AND public.has_permission('projects.read_all', 'app')
$$;

REVOKE ALL ON FUNCTION public.can_read_all_tasks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_all_tasks() TO authenticated, service_role;

-- (SELECT ...) makes Postgres run the permission check once per statement.
DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated
  USING (((SELECT public.can_read_all_tasks()) AND public.project_is_live(project_id))
    OR public.can_read_task_row(id, project_id, created_by));

DROP POLICY IF EXISTS task_assignees_select ON public.task_assignees;
CREATE POLICY task_assignees_select ON public.task_assignees FOR SELECT TO authenticated
  USING (((SELECT public.can_read_all_tasks()) AND public.task_is_live(task_id)) OR public.can_access_task(task_id));

DROP POLICY IF EXISTS task_acceptance_criteria_select ON public.task_acceptance_criteria;
CREATE POLICY task_acceptance_criteria_select ON public.task_acceptance_criteria FOR SELECT TO authenticated
  USING (((SELECT public.can_read_all_tasks()) AND public.task_is_live(task_id)) OR public.can_access_task(task_id));

DROP POLICY IF EXISTS task_reviews_select ON public.task_reviews;
CREATE POLICY task_reviews_select ON public.task_reviews FOR SELECT TO authenticated
  USING (((SELECT public.can_read_all_tasks()) AND public.task_is_live(task_id)) OR public.can_access_task(task_id));

DROP POLICY IF EXISTS task_dependencies_select ON public.task_dependencies;
CREATE POLICY task_dependencies_select ON public.task_dependencies FOR SELECT TO authenticated
  USING (((SELECT public.can_read_all_tasks()) AND public.task_is_live(task_id)) OR public.can_access_task(task_id));

DROP POLICY IF EXISTS task_comments_select ON public.task_comments;
CREATE POLICY task_comments_select ON public.task_comments FOR SELECT TO authenticated
  USING (((SELECT public.can_read_all_tasks()) AND public.task_is_live(task_id)) OR public.can_access_task(task_id));
