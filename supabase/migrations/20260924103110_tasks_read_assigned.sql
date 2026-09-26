-- Assigned-only task visibility (audit batch 4).
--
-- tasks.read_assigned lets a member see, inside the projects they can open,
-- only the tasks assigned to them (and tasks they created, so creating one
-- works before its assignee row exists). tasks.read keeps meaning every task
-- in those projects, so no existing role changes: every role that has
-- tasks.read today still has it.
--
-- One rule, can_read_task_row, now decides task visibility for the tasks
-- table and, through can_access_task, for every child table (subtasks,
-- comments, assignees, criteria, dependencies, reviews, task files).
-- can_access_task used to check project access only; it now also needs a
-- task read permission, the same as the task row itself.
--
-- App-only permission: the v1 API runs with the service role and still
-- requires tasks.read for task reads, so it fails closed.
-- Safe to apply before or after the app deploy.

CREATE OR REPLACE FUNCTION public.can_read_task_row(p_task_id uuid, p_project_id uuid, p_created_by uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.can_access_project(p_project_id) AND (
    public.has_permission('tasks.read')
    OR (
      public.has_permission('tasks.read_assigned')
      AND (
        p_created_by = public.current_team_member_id()
        OR EXISTS (
          SELECT 1 FROM public.task_assignees ta
          WHERE ta.task_id = p_task_id AND ta.member_id = public.current_team_member_id()
        )
      )
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tasks
    WHERE id = p_task_id AND public.can_read_task_row(id, project_id, created_by)
  )
$$;

DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated
  USING (public.can_read_task_row(id, project_id, created_by));

REVOKE ALL ON FUNCTION public.can_read_task_row(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_task_row(uuid, uuid, uuid) TO authenticated, service_role;
