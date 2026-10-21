-- ============================================================
-- Reminders: the next steps that must not be forgotten. A task often
-- stalls not because work is missing but because its next step (ask the
-- client three questions, follow up on Friday) lived only in someone's
-- head. A reminder holds that step on a task, on a project, or on its own.
--
-- Visibility: a reminder on a task or project is seen by anyone who can see
-- that task or project; a standalone reminder is private to its owner.
-- Dates and times are optional: a dated reminder with no time is due at
-- 8 am workspace time, and the owner gets a bell when it comes due.
-- A task moved to done closes its open reminders; those reopen if the task
-- moves back out of done.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  remind_on date,
  remind_at time,
  -- Whose reminder it is: the person the bell goes to.
  owner_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  -- A task reminder always carries its task's project (set by the trigger).
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_at timestamptz,
  completed_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  -- Closed because its task moved to done; reopened if the task moves back.
  closed_by_task boolean NOT NULL DEFAULT false,
  -- When the due bell went out; cleared when the date or time changes.
  notified_at timestamptz,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'email')),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminders_time_needs_date CHECK (remind_at IS NULL OR remind_on IS NOT NULL),
  CONSTRAINT reminders_done_has_completed_at CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT reminders_closed_by_task_is_done CHECK (NOT closed_by_task OR status = 'done')
);

CREATE INDEX IF NOT EXISTS idx_reminders_owner_status ON public.reminders (owner_id, status);
CREATE INDEX IF NOT EXISTS idx_reminders_task ON public.reminders (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_project ON public.reminders (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_due ON public.reminders (remind_on)
  WHERE status = 'open' AND notified_at IS NULL AND remind_on IS NOT NULL;

-- ------------------------------------------------------------
-- Normalise every write: the task's project, completion stamps, the due
-- bell reset, and the fields a later edit may not change.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_reminder_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  task_project uuid;
BEGIN
  NEW.title := btrim(NEW.title);

  IF NEW.task_id IS NOT NULL THEN
    SELECT project_id INTO task_project FROM public.tasks WHERE id = NEW.task_id;
    IF task_project IS NOT NULL THEN
      NEW.project_id := task_project;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, public.current_team_member_id());
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.source := OLD.source;
    NEW.created_at := OLD.created_at;
    IF NEW.remind_on IS DISTINCT FROM OLD.remind_on OR NEW.remind_at IS DISTINCT FROM OLD.remind_at THEN
      NEW.notified_at := NULL;
    END IF;
  END IF;

  IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status <> 'done') THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
    NEW.completed_by := COALESCE(NEW.completed_by, public.current_team_member_id());
  ELSIF NEW.status = 'open' THEN
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
    NEW.closed_by_task := false;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reminders_before_write ON public.reminders;
CREATE TRIGGER reminders_before_write
  BEFORE INSERT OR UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.handle_reminder_before_write();

-- ------------------------------------------------------------
-- A task moved to done is finished, and so are its open reminders: most
-- people never tick every step off. Reminders closed that way reopen if the
-- task moves back out of done; ones a person closed stay closed. A task
-- moved to another project takes its reminders along.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_task_reminders_with_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    UPDATE public.reminders SET project_id = NEW.project_id WHERE task_id = NEW.id;
  END IF;
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    UPDATE public.reminders
    SET status = 'done', closed_by_task = true
    WHERE task_id = NEW.id AND status = 'open';
  ELSIF OLD.status = 'done' AND NEW.status IS DISTINCT FROM 'done' THEN
    UPDATE public.reminders
    SET status = 'open'
    WHERE task_id = NEW.id AND status = 'done' AND closed_by_task;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_task_reminders_with_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_sync_reminders_with_status ON public.tasks;
CREATE TRIGGER tasks_sync_reminders_with_status
  AFTER UPDATE OF status, project_id ON public.tasks
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.project_id IS DISTINCT FROM OLD.project_id)
  EXECUTE FUNCTION public.sync_task_reminders_with_status();

-- ------------------------------------------------------------
-- Row level security
-- ------------------------------------------------------------
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

-- One rule for "can see this reminder", shared by every policy.
CREATE OR REPLACE FUNCTION public.can_see_reminder(p_owner_id uuid, p_project_id uuid, p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_owner_id = public.current_team_member_id()
    OR (p_task_id IS NOT NULL AND public.can_access_task(p_task_id))
    OR (p_task_id IS NULL AND p_project_id IS NOT NULL AND public.can_access_project(p_project_id))
$$;

REVOKE ALL ON FUNCTION public.can_see_reminder(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_see_reminder(uuid, uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS reminders_select ON public.reminders;
CREATE POLICY reminders_select ON public.reminders FOR SELECT TO authenticated
  USING (public.can_see_reminder(owner_id, project_id, task_id));

-- Anyone may write their own standalone reminder. A shared one needs access to
-- its task or project, and only a shared one may belong to someone else.
DROP POLICY IF EXISTS reminders_insert ON public.reminders;
CREATE POLICY reminders_insert ON public.reminders FOR INSERT TO authenticated
  WITH CHECK (
    created_by = public.current_team_member_id()
    AND (task_id IS NULL OR public.can_access_task(task_id))
    AND (project_id IS NULL OR public.can_access_project(project_id))
    AND (owner_id = public.current_team_member_id() OR project_id IS NOT NULL)
  );

-- Anyone who can see a shared reminder can tick it off or move it; a
-- standalone one only its owner.
DROP POLICY IF EXISTS reminders_update ON public.reminders;
CREATE POLICY reminders_update ON public.reminders FOR UPDATE TO authenticated
  USING (public.can_see_reminder(owner_id, project_id, task_id))
  WITH CHECK (
    (task_id IS NULL OR public.can_access_task(task_id))
    AND (project_id IS NULL OR public.can_access_project(project_id))
    AND (owner_id = public.current_team_member_id() OR project_id IS NOT NULL)
  );

DROP POLICY IF EXISTS reminders_delete ON public.reminders;
CREATE POLICY reminders_delete ON public.reminders FOR DELETE TO authenticated
  USING (
    public.can_see_reminder(owner_id, project_id, task_id)
    AND (owner_id = public.current_team_member_id()
      OR created_by = public.current_team_member_id()
      OR public.has_permission('tasks.manage_all'))
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminders TO authenticated;
GRANT ALL ON public.reminders TO service_role;

-- ------------------------------------------------------------
-- Due bells. Every five minutes, each open reminder whose moment has come
-- (its date at its time, or 8 am, in the workspace time zone) rings its
-- owner's bell once.
-- ------------------------------------------------------------
ALTER TABLE public.team_member_notifications
  DROP CONSTRAINT IF EXISTS team_member_notifications_entity_type_check;
ALTER TABLE public.team_member_notifications
  ADD CONSTRAINT team_member_notifications_entity_type_check
  CHECK (entity_type IN ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question', 'invoice', 'reminder'));

CREATE OR REPLACE FUNCTION public.send_due_reminders(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text := public.workspace_timezone();
  due record;
  sent integer := 0;
BEGIN
  FOR due IN
    SELECT r.id, r.owner_id, r.title, r.project_id, r.task_id,
           t.title AS task_title, p.name AS project_name
    FROM public.reminders r
    LEFT JOIN public.tasks t ON t.id = r.task_id
    LEFT JOIN public.projects p ON p.id = r.project_id
    WHERE r.status = 'open'
      AND r.notified_at IS NULL
      AND r.remind_on IS NOT NULL
      AND (r.remind_on + COALESCE(r.remind_at, time '08:00')) AT TIME ZONE zone <= p_now
    ORDER BY r.remind_on, r.remind_at NULLS FIRST
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    PERFORM public.upsert_notification(
      due.owner_id,
      'Reminder',
      due.title || CASE
        WHEN due.task_title IS NOT NULL THEN ' (' || due.task_title || ')'
        WHEN due.project_name IS NOT NULL THEN ' (' || due.project_name || ')'
        ELSE ''
      END,
      CASE
        WHEN due.task_id IS NOT NULL THEN '/projects/' || due.project_id::text || '?task=' || due.task_id::text
        ELSE '/reminders'
      END,
      'reminder',
      due.id::text
    );
    UPDATE public.reminders SET notified_at = p_now WHERE id = due.id;
    sent := sent + 1;
  END LOOP;
  RETURN sent;
END;
$$;

REVOKE ALL ON FUNCTION public.send_due_reminders(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_due_reminders(timestamptz) TO service_role;

-- Realtime, so a reminder added by an agent or a teammate appears at once.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'reminders'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.reminders;
  END IF;
END;
$$;

-- Schedule the due bells. Skipped where pg_cron is unavailable (local fixtures).
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('reminders-due', '*/5 * * * *', $job$SELECT public.send_due_reminders();$job$);
END;
$do$;
