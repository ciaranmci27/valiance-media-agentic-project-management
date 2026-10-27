-- Subtasks are tasks. A subtask used to be one line of text in task_subtasks;
-- now it is a whole task (assignee, due date, status, description, comments,
-- files, reminders) that sits under a parent task through
-- tasks.parent_task_id.
--
-- The rules live here so the app, the v1 API, MCP and the email pipeline all
-- get the same answer:
-- - one level: a subtask has no subtasks, and a task with subtasks cannot
--   become one;
-- - a subtask is always in its parent's project; moving the parent moves its
--   subtasks (and they take the parent's goal);
-- - adding a subtask, or moving a task under a parent, needs the right to
--   manage the parent (a signed-in member; server routes check for keys);
-- - set_task_parent() nests a task under a parent or makes it top-level, in
--   one transaction, moving it to the parent's project when that differs.
--
-- Access follows the parent: who can read or manage a task can read or
-- manage its subtasks, and being on a subtask lets you read its parent for
-- context. A parent in Trash takes its subtasks with it (they are hidden, not
-- marked deleted, like a project's tasks) and restoring it brings them back.
--
-- The text subtasks are copied in as subtasks (same ids, done -> done, order
-- kept, no one assigned; those in Trash arrive in Trash). The copy logs
-- nothing and marks nothing unread. task_subtasks is then frozen and leaves
-- Trash; a later migration drops it.

BEGIN;

-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS parent_task_id uuid
  REFERENCES public.tasks(id) ON DELETE CASCADE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_parent_not_self') THEN
    ALTER TABLE public.tasks ADD CONSTRAINT tasks_parent_not_self CHECK (parent_task_id IS DISTINCT FROM id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON public.tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Copy the text subtasks in (before the rules below exist, so nothing logs)
-- ---------------------------------------------------------------------------
-- created_via 'unknown' like every task from before tracking; the source stamp
-- and the team log stay out of it for this one statement.
ALTER TABLE public.tasks DISABLE TRIGGER stamp_task_source;
ALTER TABLE public.tasks DISABLE TRIGGER log_task_activity;
INSERT INTO public.tasks (
  id, project_id, parent_task_id, title, description, status, priority, tags, sort_order,
  created_by, completed_at, created_at, updated_at, deleted_at, deleted_by, created_via
)
SELECT s.id, t.project_id, t.id, s.title, '',
  CASE WHEN s.completed THEN 'done' ELSE 'todo' END, 'medium', '{}', s.sort_order,
  t.created_by, CASE WHEN s.completed THEN s.updated_at END, s.created_at, s.updated_at,
  s.deleted_at, s.deleted_by, 'unknown'
FROM public.task_subtasks s
JOIN public.tasks t ON t.id = s.task_id
WHERE t.parent_task_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.tasks existing WHERE existing.id = s.id);
ALTER TABLE public.tasks ENABLE TRIGGER log_task_activity;
ALTER TABLE public.tasks ENABLE TRIGGER stamp_task_source;

-- task_subtasks is read-only from here; the app and API now write tasks.
CREATE OR REPLACE FUNCTION public.forbid_text_subtask_writes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Subtasks are tasks now: refresh the app, or create a task with parent_task_id.'
    USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION public.forbid_text_subtask_writes() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS forbid_text_subtask_writes ON public.task_subtasks;
CREATE TRIGGER forbid_text_subtask_writes BEFORE INSERT OR UPDATE ON public.task_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.forbid_text_subtask_writes();

-- ---------------------------------------------------------------------------
-- Who may manage a task
-- ---------------------------------------------------------------------------
-- The signed-in member may change it: manage all tasks, or manage assigned
-- ones and be on it or on its parent.
CREATE OR REPLACE FUNCTION public.can_manage_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.can_access_task(p_task_id) AND (
    public.has_permission('tasks.manage_all') OR (
      public.has_permission('tasks.manage_assigned') AND EXISTS (
        SELECT 1 FROM public.tasks task
        JOIN public.task_assignees assignment
          ON assignment.task_id IN (task.id, task.parent_task_id)
        WHERE task.id = p_task_id AND assignment.member_id = public.current_team_member_id()
      )
    )
  )
$$;
REVOKE ALL ON FUNCTION public.can_manage_task(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_task(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The rules, for every writer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_task_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent public.tasks;
  v_children integer;
  v_parent_changed boolean := TG_OP = 'INSERT' OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id;
BEGIN
  IF NEW.parent_task_id IS NULL OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT v_parent_changed AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
     AND OLD.deleted_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Locked so a parent cannot become a subtask while a subtask joins it.
  SELECT * INTO v_parent FROM public.tasks WHERE id = NEW.parent_task_id FOR SHARE;
  IF v_parent.id IS NULL OR v_parent.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'The parent task is not there or is in Trash.' USING ERRCODE = 'P0002';
  END IF;
  IF v_parent.parent_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'Subtasks go one level deep: "%" is itself a subtask.', v_parent.title USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT count(*) INTO v_children FROM public.tasks WHERE parent_task_id = NEW.id AND deleted_at IS NULL;
    IF v_children > 0 THEN
      RAISE EXCEPTION 'It has % subtask%. Make them top-level or move them first.',
        v_children, CASE WHEN v_children = 1 THEN '' ELSE 's' END USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.project_id IS DISTINCT FROM v_parent.project_id THEN
    RAISE EXCEPTION 'A subtask stays in its parent task''s project. Move the parent, or make it top-level first.'
      USING ERRCODE = '23514';
  END IF;
  -- A signed-in member needs to be able to manage the parent; the server
  -- routes check a key's rights themselves.
  IF v_parent_changed AND auth.uid() IS NOT NULL AND NOT public.can_manage_task(v_parent.id) THEN
    RAISE EXCEPTION 'You cannot add subtasks to "%".', v_parent.title USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_task_parent() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enforce_task_parent ON public.tasks;
CREATE TRIGGER enforce_task_parent
  BEFORE INSERT OR UPDATE OF parent_task_id, project_id, deleted_at ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_task_parent();

-- A parent's subtasks follow it to another project (those in Trash too, so a
-- restore lands them beside it) and take its goal, since the old project's
-- goals do not apply there.
CREATE OR REPLACE FUNCTION public.move_subtasks_with_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.tasks
  SET project_id = NEW.project_id, project_goal_id = NEW.project_goal_id
  WHERE parent_task_id = NEW.id AND project_id IS DISTINCT FROM NEW.project_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.move_subtasks_with_parent() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS move_subtasks_with_parent ON public.tasks;
CREATE TRIGGER move_subtasks_with_parent
  AFTER UPDATE OF project_id ON public.tasks
  FOR EACH ROW WHEN (NEW.project_id IS DISTINCT FROM OLD.project_id AND NEW.parent_task_id IS NULL)
  EXECUTE FUNCTION public.move_subtasks_with_parent();

-- Nest a task under a parent (p_parent_id) or make it top-level (null). It
-- goes last among its new siblings. Under a parent in another project it
-- moves there and takes the parent's goal; that needs tasks.manage_all for a
-- signed-in member, and no blocker links (they must stay inside one project).
-- Runs as the caller, so the task's own update rules still apply.
CREATE OR REPLACE FUNCTION public.set_task_parent(p_task_id uuid, p_parent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_task public.tasks;
  v_parent public.tasks;
  v_goal uuid;
  v_order integer;
BEGIN
  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id AND deleted_at IS NULL FOR UPDATE;
  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_parent_id IS NOT DISTINCT FROM v_task.parent_task_id THEN
    RETURN to_jsonb(v_task);
  END IF;

  IF p_parent_id IS NULL THEN
    SELECT coalesce(max(sort_order) + 1, 0) INTO v_order FROM public.tasks
    WHERE project_id = v_task.project_id AND parent_task_id IS NULL AND status = v_task.status AND deleted_at IS NULL;
    UPDATE public.tasks SET parent_task_id = NULL, sort_order = v_order
    WHERE id = p_task_id RETURNING * INTO v_task;
  ELSE
    IF p_parent_id = p_task_id THEN
      RAISE EXCEPTION 'A task cannot be its own subtask.' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_parent FROM public.tasks WHERE id = p_parent_id AND deleted_at IS NULL;
    IF v_parent.id IS NULL THEN
      RAISE EXCEPTION 'The parent task is not there or is in Trash.' USING ERRCODE = 'P0002';
    END IF;
    v_goal := v_task.project_goal_id;
    IF v_parent.project_id <> v_task.project_id THEN
      IF auth.uid() IS NOT NULL AND NOT public.has_permission('tasks.manage_all') THEN
        RAISE EXCEPTION 'Moving a task to another project needs permission to manage all tasks.' USING ERRCODE = '42501';
      END IF;
      IF EXISTS (SELECT 1 FROM public.task_dependencies WHERE task_id = p_task_id OR blocked_by_task_id = p_task_id) THEN
        RAISE EXCEPTION 'It is blocked by, or blocks, tasks in its own project. Remove those links before moving it to another project.'
          USING ERRCODE = '23514';
      END IF;
      v_goal := v_parent.project_goal_id;
    END IF;
    SELECT coalesce(max(sort_order) + 1, 0) INTO v_order FROM public.tasks
    WHERE parent_task_id = p_parent_id AND deleted_at IS NULL;
    UPDATE public.tasks
    SET parent_task_id = p_parent_id, project_id = v_parent.project_id, project_goal_id = v_goal, sort_order = v_order
    WHERE id = p_task_id RETURNING * INTO v_task;
  END IF;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'Task % not found or not permitted', p_task_id USING ERRCODE = 'P0002';
  END IF;
  RETURN to_jsonb(v_task);
END;
$$;
REVOKE ALL ON FUNCTION public.set_task_parent(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_task_parent(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Access follows the parent
-- ---------------------------------------------------------------------------
-- A member who reads only their own tasks also reads the subtasks of their
-- tasks, and the parent of a subtask that is theirs (for context; not its
-- other subtasks, which are not theirs).
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
        OR EXISTS (
          SELECT 1 FROM public.tasks child
          JOIN public.tasks parent ON parent.id = child.parent_task_id
          WHERE child.id = p_task_id AND (
            parent.created_by = public.current_team_member_id()
            OR EXISTS (
              SELECT 1 FROM public.task_assignees ta
              WHERE ta.task_id = parent.id AND ta.member_id = public.current_team_member_id()
            )
          )
        )
        OR EXISTS (
          SELECT 1 FROM public.tasks child
          WHERE child.parent_task_id = p_task_id AND child.deleted_at IS NULL AND (
            child.created_by = public.current_team_member_id()
            OR EXISTS (
              SELECT 1 FROM public.task_assignees ta
              WHERE ta.task_id = child.id AND ta.member_id = public.current_team_member_id()
            )
          )
        )
      )
    )
  )
$$;

DROP POLICY IF EXISTS tasks_update ON public.tasks;
CREATE POLICY tasks_update ON public.tasks FOR UPDATE TO authenticated
  USING (public.can_access_project(project_id) AND (public.has_permission('tasks.manage_all') OR (
    public.has_permission('tasks.manage_assigned') AND EXISTS (
      SELECT 1 FROM public.task_assignees ta
      WHERE ta.task_id IN (tasks.id, tasks.parent_task_id) AND ta.member_id = public.current_team_member_id()
    )
  )));

-- A task is live when it, its parent (if any) and its project are not in Trash.
CREATE OR REPLACE FUNCTION public.task_is_live(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tasks task
    JOIN public.projects project ON project.id = task.project_id
    LEFT JOIN public.tasks parent ON parent.id = task.parent_task_id
    WHERE task.id = p_task_id AND task.deleted_at IS NULL AND project.deleted_at IS NULL
      AND (task.parent_task_id IS NULL OR parent.deleted_at IS NULL)
  )
$$;

DROP POLICY IF EXISTS tasks_parent_task_live ON public.tasks;
CREATE POLICY tasks_parent_task_live ON public.tasks AS RESTRICTIVE FOR ALL TO authenticated
  USING (parent_task_id IS NULL OR public.task_is_live(parent_task_id));

-- ---------------------------------------------------------------------------
-- Trash: subtasks are tasks; a subtask comes back after its parent
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trash_record_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'projects', 'tasks', 'task_comments', 'reminders', 'project_credentials',
    'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads',
    'lead_interactions', 'lead_proposals', 'lead_fields',
    'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates',
    'project_retainers', 'project_retainer_amounts', 'task_files'
  ]
$$;

CREATE OR REPLACE FUNCTION public.can_trash_record(p_table text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := public.current_team_member_id();
  allowed boolean := false;
BEGIN
  IF me IS NULL THEN
    RETURN false;
  END IF;
  CASE p_table
    WHEN 'projects' THEN
      SELECT public.has_permission('projects.manage') AND (
        public.has_permission('projects.read_all')
        OR EXISTS (SELECT 1 FROM public.project_members WHERE project_id = p_id AND member_id = me)
      ) INTO allowed;
    WHEN 'tasks' THEN
      -- A subtask can also go by whoever manages its parent as an assignee.
      SELECT public.can_access_project(project_id) AND (
        public.has_permission('tasks.manage_all') OR (
          parent_task_id IS NOT NULL AND public.has_permission('tasks.manage_assigned') AND EXISTS (
            SELECT 1 FROM public.task_assignees assignment
            WHERE assignment.task_id = tasks.parent_task_id AND assignment.member_id = me
          )
        )
      ) INTO allowed FROM public.tasks WHERE id = p_id;
    WHEN 'task_comments' THEN
      SELECT public.can_access_task(task_id) AND (user_id = me OR public.has_permission('tasks.manage_all'))
      INTO allowed FROM public.task_comments WHERE id = p_id;
    WHEN 'task_files' THEN
      SELECT public.can_access_task(task_id) AND (added_by = me OR public.has_permission('files.manage'))
      INTO allowed FROM public.task_files WHERE id = p_id;
    WHEN 'reminders' THEN
      SELECT public.can_see_reminder(owner_id, project_id, task_id)
        AND (owner_id = me OR created_by = me OR public.has_permission('tasks.manage_all'))
      INTO allowed FROM public.reminders WHERE id = p_id;
    WHEN 'project_credentials' THEN
      SELECT public.has_permission('credentials.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_credentials WHERE id = p_id;
    WHEN 'entity_files' THEN
      SELECT public.can_access_file_entity(entity_type, entity_id) AND (
        public.has_permission('files.manage') OR (uploaded_by = me AND visibility = 'internal')
      ) INTO allowed FROM public.entity_files WHERE id = p_id;
    WHEN 'portal_updates' THEN
      SELECT public.has_permission('portal.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.portal_updates WHERE id = p_id;
    WHEN 'portal_update_attachments' THEN
      SELECT public.has_permission('portal.manage') AND public.can_access_project(update_row.project_id)
      INTO allowed
      FROM public.portal_update_attachments attachment
      JOIN public.portal_updates update_row ON update_row.id = attachment.update_id
      WHERE attachment.id = p_id AND update_row.deleted_at IS NULL;
    WHEN 'contacts' THEN
      SELECT public.has_permission('contacts.manage') INTO allowed;
    WHEN 'leads' THEN
      SELECT public.has_permission('leads.manage') INTO allowed;
    WHEN 'lead_interactions' THEN
      SELECT public.has_permission('leads.manage') AND public.can_access_lead(lead_id)
      INTO allowed FROM public.lead_interactions WHERE id = p_id;
    WHEN 'lead_proposals' THEN
      SELECT public.has_permission('leads.manage') AND public.can_access_lead(lead_id)
      INTO allowed FROM public.lead_proposals WHERE id = p_id;
    WHEN 'lead_fields' THEN
      SELECT public.has_permission('leads.manage') AND public.can_access_lead(lead_id)
      INTO allowed FROM public.lead_fields WHERE id = p_id;
    WHEN 'project_time_entries' THEN
      SELECT public.can_access_project(project_id) AND (
        public.has_permission('time.manage_all') OR (
          public.has_permission('time.manage_own')
          AND member_id = me
          AND approval_status IN ('draft', 'pending', 'rejected')
        )
      ) INTO allowed FROM public.project_time_entries WHERE id = p_id;
    WHEN 'project_invoices' THEN
      SELECT public.has_permission('invoices.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_invoices WHERE id = p_id;
    WHEN 'invoice_payments' THEN
      -- People remove only payments recorded by hand, as remove_invoice_payment.
      SELECT (public.has_permission('invoices.record_payments') OR public.has_permission('invoices.manage'))
        AND public.can_access_project(invoice.project_id)
        AND invoice.deleted_at IS NULL
        AND payment.recorded_via = 'app'
      INTO allowed
      FROM public.invoice_payments payment
      JOIN public.project_invoices invoice ON invoice.id = payment.invoice_id
      WHERE payment.id = p_id;
    WHEN 'project_hourly_rates' THEN
      SELECT public.has_permission('billing.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_hourly_rates WHERE id = p_id;
    WHEN 'project_retainers' THEN
      SELECT public.has_permission('invoices.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_retainers WHERE id = p_id;
    WHEN 'project_retainer_amounts' THEN
      SELECT public.has_permission('invoices.manage') AND public.can_access_project(retainer.project_id)
        AND retainer.deleted_at IS NULL
      INTO allowed
      FROM public.project_retainer_amounts amount
      JOIN public.project_retainers retainer ON retainer.id = amount.retainer_id
      WHERE amount.id = p_id;
    ELSE
      allowed := false;
  END CASE;
  RETURN coalesce(allowed, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.trash_restore_blocker(p_table text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  project_gone boolean := false;
  task_gone boolean := false;
  lead_gone boolean := false;
  parent_gone boolean := false;
  payment public.invoice_payments;
  invoice public.project_invoices;
  v_number text;
BEGIN
  CASE p_table
    WHEN 'tasks' THEN
      -- A subtask comes back after its parent.
      SELECT p.deleted_at IS NOT NULL, coalesce(parent.deleted_at IS NOT NULL, false) INTO project_gone, task_gone
      FROM public.tasks t JOIN public.projects p ON p.id = t.project_id
      LEFT JOIN public.tasks parent ON parent.id = t.parent_task_id
      WHERE t.id = p_id;
    WHEN 'task_comments', 'task_files' THEN
      EXECUTE format('SELECT t.deleted_at IS NOT NULL OR coalesce(parent.deleted_at IS NOT NULL, false), p.deleted_at IS NOT NULL
        FROM public.%I c JOIN public.tasks t ON t.id = c.task_id JOIN public.projects p ON p.id = t.project_id
        LEFT JOIN public.tasks parent ON parent.id = t.parent_task_id
        WHERE c.id = $1', p_table)
      INTO task_gone, project_gone USING p_id;
    WHEN 'reminders' THEN
      SELECT coalesce(t.deleted_at IS NOT NULL OR parent.deleted_at IS NOT NULL, false), coalesce(p.deleted_at IS NOT NULL, false)
      INTO task_gone, project_gone
      FROM public.reminders r
      LEFT JOIN public.tasks t ON t.id = r.task_id
      LEFT JOIN public.tasks parent ON parent.id = t.parent_task_id
      LEFT JOIN public.projects p ON p.id = r.project_id
      WHERE r.id = p_id;
    WHEN 'project_credentials', 'portal_updates', 'project_time_entries', 'project_invoices',
         'project_hourly_rates', 'project_retainers' THEN
      EXECUTE format('SELECT p.deleted_at IS NOT NULL FROM public.%I c
        JOIN public.projects p ON p.id = c.project_id WHERE c.id = $1', p_table)
      INTO project_gone USING p_id;
    WHEN 'portal_update_attachments' THEN
      SELECT u.deleted_at IS NOT NULL INTO parent_gone
      FROM public.portal_update_attachments a JOIN public.portal_updates u ON u.id = a.update_id WHERE a.id = p_id;
      IF parent_gone THEN
        RETURN 'Restore the portal update it belongs to first.';
      END IF;
    WHEN 'invoice_payments' THEN
      SELECT p.deleted_at IS NOT NULL, i.deleted_at IS NOT NULL INTO project_gone, parent_gone
      FROM public.invoice_payments pay
      JOIN public.project_invoices i ON i.id = pay.invoice_id
      JOIN public.projects p ON p.id = i.project_id
      WHERE pay.id = p_id;
      IF parent_gone AND NOT project_gone THEN
        RETURN 'Restore the invoice it belongs to first.';
      END IF;
    WHEN 'project_retainer_amounts' THEN
      SELECT p.deleted_at IS NOT NULL, r.deleted_at IS NOT NULL INTO project_gone, parent_gone
      FROM public.project_retainer_amounts a
      JOIN public.project_retainers r ON r.id = a.retainer_id
      JOIN public.projects p ON p.id = r.project_id
      WHERE a.id = p_id;
      IF parent_gone AND NOT project_gone THEN
        RETURN 'Restore the retainer it belongs to first.';
      END IF;
    WHEN 'entity_files' THEN
      SELECT CASE f.entity_type
          WHEN 'project' THEN EXISTS (SELECT 1 FROM public.projects WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          WHEN 'lead' THEN EXISTS (SELECT 1 FROM public.leads WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          WHEN 'contact' THEN EXISTS (SELECT 1 FROM public.contacts WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          ELSE false
        END
      INTO parent_gone
      FROM public.entity_files f WHERE f.id = p_id;
      IF parent_gone THEN
        RETURN 'Restore the project, lead or contact this file belongs to first.';
      END IF;
    WHEN 'lead_interactions', 'lead_proposals', 'lead_fields' THEN
      EXECUTE format('SELECT l.deleted_at IS NOT NULL FROM public.%I c
        JOIN public.leads l ON l.id = c.lead_id WHERE c.id = $1', p_table)
      INTO lead_gone USING p_id;
    ELSE
      NULL;
  END CASE;
  IF coalesce(project_gone, false) THEN
    RETURN 'Restore the project it belongs to first.';
  ELSIF coalesce(task_gone, false) THEN
    RETURN 'Restore the task it belongs to first.';
  ELSIF coalesce(lead_gone, false) THEN
    RETURN 'Restore the lead it belongs to first.';
  END IF;

  -- Clashes with what was added while it was in Trash.
  CASE p_table
    WHEN 'project_time_entries' THEN
      IF EXISTS (
        SELECT 1 FROM public.project_time_entries entry
        JOIN public.project_time_entries other
          ON other.project_id = entry.project_id AND other.member_id = entry.member_id AND other.id <> entry.id
        WHERE entry.id = p_id AND entry.end_time IS NULL
          AND other.end_time IS NULL AND other.deleted_at IS NULL
      ) THEN
        RETURN 'This timer is still running and a newer one is running on the same project. Stop that one first.';
      END IF;
    WHEN 'project_invoices' THEN
      SELECT * INTO invoice FROM public.project_invoices WHERE id = p_id;
      IF invoice.status <> 'cancelled' THEN
        SELECT other.invoice_number INTO v_number
        FROM public.invoice_time_entry_allocations mine
        JOIN public.invoice_time_entry_allocations theirs
          ON theirs.time_entry_id = mine.time_entry_id AND theirs.invoice_id <> mine.invoice_id
        JOIN public.project_invoices other ON other.id = theirs.invoice_id
        WHERE mine.invoice_id = p_id AND other.status <> 'cancelled' AND other.deleted_at IS NULL
          AND mine.start_offset_hours < theirs.start_offset_hours + theirs.allocated_hours - 0.000001
          AND theirs.start_offset_hours < mine.start_offset_hours + mine.allocated_hours - 0.000001
        LIMIT 1;
        IF FOUND THEN
          RETURN 'Some of its hours are on invoice ' || v_number || ' now. Take them off that invoice first.';
        END IF;
        IF EXISTS (
          SELECT 1 FROM public.invoice_time_entry_allocations allocation
          JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
          WHERE allocation.invoice_id = p_id AND entry.deleted_at IS NOT NULL
        ) THEN
          RETURN 'Some of its time is in Trash. Restore that time first.';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
          JOIN public.project_retainers retainer ON retainer.id::text = line.value->>'retainer_id' AND retainer.deleted_at IS NULL
          JOIN public.project_retainer_periods handled
            ON handled.retainer_id = retainer.id
           AND handled.period_start = GREATEST(date_trunc('month', (line.value->>'service_start_date')::date)::date, retainer.start_date)
          WHERE COALESCE(line.value->>'service_start_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
            AND handled.status = 'invoiced' AND handled.invoice_id IS NOT NULL AND handled.invoice_id <> p_id
        ) THEN
          RETURN 'Its retainer period is on another invoice now.';
        END IF;
      END IF;
      -- Paid hours that are not linked to time entries cannot be checked
      -- against what was billed since; counting them again would under-bill.
      IF invoice.status = 'paid'
         AND (
           (jsonb_array_length(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) = 0 AND invoice.invoice_type = 'hourly'
            AND NOT EXISTS (SELECT 1 FROM public.invoice_time_entry_allocations a WHERE a.invoice_id = p_id))
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
             WHERE line.value->>'item_type' = 'hourly'
               AND NOT EXISTS (SELECT 1 FROM public.invoice_time_entry_allocations a
                               WHERE a.invoice_id = p_id AND a.line_item_id = line.value->>'id')
           )
         )
         AND EXISTS (
           SELECT 1 FROM public.project_invoices other
           WHERE other.project_id = invoice.project_id AND other.id <> p_id AND other.deleted_at IS NULL
             AND other.status <> 'cancelled' AND other.created_at > invoice.deleted_at
             AND (other.invoice_type = 'hourly' OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(other.line_items, 'null'::jsonb), '[]'::jsonb)) line
               WHERE line.value->>'item_type' = 'hourly'))
         ) THEN
        RETURN 'Hours were invoiced after this invoice went to Trash, and its own hours are not linked to time entries, so restoring it could count hours twice. Check the hourly invoices first.';
      END IF;
    WHEN 'project_hourly_rates' THEN
      IF EXISTS (
        SELECT 1 FROM public.project_hourly_rates rate
        JOIN public.project_hourly_rates other
          ON other.project_id = rate.project_id AND other.effective_at = rate.effective_at AND other.id <> rate.id
        WHERE rate.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'Another rate now starts at the same time. Change or delete that one first.';
      END IF;
    WHEN 'lead_fields' THEN
      IF EXISTS (
        SELECT 1 FROM public.lead_fields field
        JOIN public.lead_fields other
          ON other.lead_id = field.lead_id AND other.field_key = field.field_key AND other.id <> field.id
        WHERE field.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'This field has been set again since. Change or delete that one first.';
      END IF;
    WHEN 'project_retainer_amounts' THEN
      IF EXISTS (
        SELECT 1 FROM public.project_retainer_amounts amount
        JOIN public.project_retainer_amounts other
          ON other.retainer_id = amount.retainer_id AND other.effective_date = amount.effective_date AND other.id <> amount.id
        WHERE amount.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'Another amount now starts on the same date. Change or delete that one first.';
      END IF;
    WHEN 'invoice_payments' THEN
      SELECT * INTO payment FROM public.invoice_payments WHERE id = p_id;
      SELECT * INTO invoice FROM public.project_invoices WHERE id = payment.invoice_id;
      IF invoice.status NOT IN ('sent', 'overdue', 'paid') THEN
        RETURN 'Its invoice is ' || invoice.status || ' now, so it cannot take a payment.';
      END IF;
      IF payment.amount > public.invoice_total(invoice) - COALESCE((
        SELECT sum(other.amount) FROM public.invoice_payments other
        WHERE other.invoice_id = invoice.id AND other.deleted_at IS NULL
      ), 0) + 0.005 THEN
        RETURN 'Its invoice no longer has enough outstanding for this payment.';
      END IF;
      IF payment.external_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.invoice_payments other
        WHERE other.invoice_id = payment.invoice_id AND other.external_id = payment.external_id
          AND other.deleted_at IS NULL AND other.id <> payment.id
      ) THEN
        RETURN 'This payment was recorded again after it was removed.';
      END IF;
    ELSE
      NULL;
  END CASE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_trash(p_types text[] DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS TABLE (
  record_type text,
  id uuid,
  label text,
  context text,
  project_id uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_name text,
  blocker text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  spec record;
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
BEGIN
  IF NOT is_service AND public.current_team_member_id() IS NULL THEN
    RETURN;
  END IF;
  FOR spec IN
    SELECT * FROM (VALUES
      ('projects', 'r.name', 'NULL', 'r.id', ''),
      ('tasks', 'r.title', 'CASE WHEN parent.id IS NULL THEN p.name ELSE ''Subtask of '' || parent.title END', 'r.project_id',
        'LEFT JOIN public.projects p ON p.id = r.project_id LEFT JOIN public.tasks parent ON parent.id = r.parent_task_id'),
      ('task_comments', 'left(r.text, 120)', 't.title', 't.project_id', 'LEFT JOIN public.tasks t ON t.id = r.task_id'),
      ('task_files', 'r.name', 't.title', 't.project_id', 'LEFT JOIN public.tasks t ON t.id = r.task_id'),
      ('reminders', 'r.title', 'coalesce(t.title, p.name)', 'r.project_id',
        'LEFT JOIN public.tasks t ON t.id = r.task_id LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_credentials', 'r.label', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('entity_files', 'r.name',
        'CASE r.entity_type WHEN ''project'' THEN (SELECT name FROM public.projects WHERE id = r.entity_id)
           WHEN ''lead'' THEN (SELECT name FROM public.leads WHERE id = r.entity_id)
           WHEN ''contact'' THEN (SELECT name FROM public.contacts WHERE id = r.entity_id) END',
        'CASE WHEN r.entity_type = ''project'' THEN r.entity_id END', ''),
      ('portal_updates', 'r.title', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('portal_update_attachments', 'r.name', 'u.title', 'u.project_id', 'LEFT JOIN public.portal_updates u ON u.id = r.update_id'),
      ('contacts', 'r.name', 'NULL', 'NULL', ''),
      ('leads', 'r.name', 'NULL', 'NULL', ''),
      ('lead_interactions', 'r.title', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('lead_proposals', 'r.title', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('lead_fields', 'r.field_key || '': '' || left(r.value, 80)', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('project_time_entries',
        'coalesce(nullif(btrim(r.description), ''''), ''Time entry'') || '' ('' || to_char(r.start_time AT TIME ZONE public.workspace_timezone(), ''Mon FMDD, YYYY'') || '')''',
        'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_invoices', 'r.invoice_number || '' ($'' || to_char(r.amount, ''FM999,999,990.00'') || '')''', 'p.name', 'r.project_id',
        'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('invoice_payments', '''Payment of $'' || to_char(r.amount, ''FM999,999,990.00'') || '' on '' || i.invoice_number', 'p.name', 'i.project_id',
        'LEFT JOIN public.project_invoices i ON i.id = r.invoice_id LEFT JOIN public.projects p ON p.id = i.project_id'),
      ('project_hourly_rates', '''$'' || to_char(r.hourly_rate, ''FM999,990.00'') || ''/hr from '' || to_char(r.effective_at AT TIME ZONE public.workspace_timezone(), ''Mon FMDD, YYYY'')',
        'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_retainers', 'r.name', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_retainer_amounts', 'rt.name || '': $'' || to_char(r.amount, ''FM999,999,990.00'') || '' from '' || to_char(r.effective_date, ''Mon FMDD, YYYY'')',
        'p.name', 'rt.project_id',
        'LEFT JOIN public.project_retainers rt ON rt.id = r.retainer_id LEFT JOIN public.projects p ON p.id = rt.project_id')
    ) AS specs(record_type, label_sql, context_sql, project_sql, join_sql)
  LOOP
    CONTINUE WHEN p_types IS NOT NULL AND NOT spec.record_type = ANY (p_types);
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, r.id, (%s)::text, (%s)::text, (%s)::uuid, r.deleted_at, r.deleted_by, m.name::text,
              public.trash_restore_blocker(%L, r.id)
       FROM public.%I r %s
       LEFT JOIN public.team_members m ON m.id = r.deleted_by
       WHERE r.deleted_at IS NOT NULL AND ($1 OR public.can_trash_record(%L, r.id))
       ORDER BY r.deleted_at DESC
       LIMIT %s',
      spec.record_type, spec.label_sql, spec.context_sql, spec.project_sql, spec.record_type,
      spec.record_type, spec.join_sql, spec.record_type, greatest(1, least(coalesce(p_limit, 500), 2000)))
    USING is_service;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Team activity: "Added subtask", "Moved under", "Made top-level"
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_task_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('task_id', NEW.id, 'task_title', NEW.title);
  v_fields text[];
  v_ignore text[] := ARRAY['status', 'sort_order', 'completed_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by', 'parent_task_id'];
  v_parent record;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT id, title INTO v_parent FROM public.tasks WHERE id = NEW.parent_task_id;
    v_meta := v_meta || jsonb_build_object('parent_task_id', v_parent.id, 'parent_task_title', v_parent.title);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_task_id IS NOT NULL THEN
      PERFORM public.log_team_activity('subtask.added', 'task', NEW.id::text, NEW.project_id,
        format('Added subtask "%s" to "%s"', NEW.title, v_parent.title), v_meta);
    ELSE
      PERFORM public.log_team_activity('task.created', 'task', NEW.id::text, NEW.project_id,
        format('Created task "%s"', NEW.title), v_meta);
    END IF;
    RETURN NULL;
  END IF;
  -- The Trash trigger logs moves to Trash and restores.
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'done' THEN
      PERFORM public.log_team_activity('task.completed', 'task', NEW.id::text, NEW.project_id,
        format('Completed task "%s"', NEW.title), v_meta);
    ELSIF OLD.status = 'done' THEN
      PERFORM public.log_team_activity('task.reopened', 'task', NEW.id::text, NEW.project_id,
        format('Reopened task "%s"', NEW.title), v_meta);
    ELSE
      PERFORM public.log_team_activity('task.moved', 'task', NEW.id::text, NEW.project_id,
        format('Moved task "%s" to %s', NEW.title, public.activity_status_label(NEW.status)),
        v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
    END IF;
  END IF;

  IF NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id THEN
    IF NEW.parent_task_id IS NOT NULL THEN
      PERFORM public.log_team_activity('task.nested', 'task', NEW.id::text, NEW.project_id,
        format('Moved "%s" under "%s"', NEW.title, v_parent.title), v_meta);
    ELSE
      PERFORM public.log_team_activity('task.promoted', 'task', NEW.id::text, NEW.project_id,
        format('Made "%s" a top-level task', NEW.title), v_meta || jsonb_build_object('from_parent_task_id', OLD.parent_task_id));
    END IF;
  END IF;

  -- A subtask's project follows its parent: the parent's move (or the
  -- nesting above) already says so.
  IF NEW.parent_task_id IS NOT NULL THEN
    v_ignore := v_ignore || ARRAY['project_id', 'project_goal_id'];
  END IF;
  v_fields := public.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD), v_ignore);
  IF cardinality(v_fields) > 0 THEN
    PERFORM public.log_team_activity('task.updated', 'task', NEW.id::text, NEW.project_id,
      format('Edited task "%s"', NEW.title), v_meta || jsonb_build_object('fields', to_jsonb(v_fields)));
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Unread tasks
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_task_row_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ignore text[] := ARRAY['sort_order', 'completed_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by',
    'created_via', 'created_by_key_id', 'created_note'];
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  -- A subtask moving with its parent is the parent's change, not its own.
  IF NEW.parent_task_id IS NOT NULL AND NEW.parent_task_id IS NOT DISTINCT FROM OLD.parent_task_id THEN
    v_ignore := v_ignore || ARRAY['project_id', 'project_goal_id'];
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.record_task_event(NEW.id, 'status');
  ELSIF cardinality(public.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD), v_ignore)) > 0 THEN
    PERFORM public.record_task_event(NEW.id, 'edit');
  END IF;
  RETURN NULL;
END;
$$;

-- A subtask added, finished or reopened, renamed, sent to Trash or back, or
-- moved in or out is news on its parent too (as "subtask"), besides being
-- the subtask's own change.
CREATE OR REPLACE FUNCTION public.record_subtask_parent_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_task_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
      PERFORM public.record_task_event(NEW.parent_task_id, 'subtask');
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id THEN
    IF OLD.parent_task_id IS NOT NULL THEN
      PERFORM public.record_task_event(OLD.parent_task_id, 'subtask');
    END IF;
    IF NEW.parent_task_id IS NOT NULL THEN
      PERFORM public.record_task_event(NEW.parent_task_id, 'subtask');
    END IF;
  ELSIF NEW.parent_task_id IS NOT NULL AND (
    (NEW.status = 'done') IS DISTINCT FROM (OLD.status = 'done')
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.title IS DISTINCT FROM OLD.title
  ) THEN
    PERFORM public.record_task_event(NEW.parent_task_id, 'subtask');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.record_subtask_parent_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS record_subtask_parent_event ON public.tasks;
CREATE TRIGGER record_subtask_parent_event
  AFTER INSERT OR UPDATE OF parent_task_id, status, deleted_at, title ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.record_subtask_parent_event();

COMMIT;
