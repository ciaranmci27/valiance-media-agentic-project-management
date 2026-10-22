-- Team activity log.
--
-- What people on the team do is logged in public.activities, apart from the
-- agents' own typed log (agent_activities). Triggers write it, so every path
-- is covered: the browser, the session routes, the v1 API and MCP. Each row
-- carries a sentence composed when it happened (names as they were then) and
-- a metadata payload for links. Nothing is ever deleted from it.
--
-- Who did it: the signed-in member, or for service-role writes the
-- x-actor-member-id request header the server sends (honoured only for the
-- service role, so a browser cannot claim to be someone else). Agents, cron
-- jobs and anything without a person behind it are not logged here.

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'app',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.activities DROP CONSTRAINT IF EXISTS activities_entity_type_check;
ALTER TABLE public.activities ADD CONSTRAINT activities_entity_type_check CHECK (entity_type IN (
  'task', 'subtask', 'comment', 'project', 'member', 'time_entry', 'invoice', 'payment', 'file',
  'portal_update', 'portal_update_attachment', 'credential', 'reminder', 'contact', 'lead',
  'lead_interaction', 'lead_proposal', 'lead_field', 'communication', 'hourly_rate', 'retainer',
  'retainer_amount'
));
ALTER TABLE public.activities DROP CONSTRAINT IF EXISTS activities_source_check;
ALTER TABLE public.activities ADD CONSTRAINT activities_source_check CHECK (source IN ('app', 'api', 'mcp', 'backfill'));

CREATE INDEX IF NOT EXISTS idx_activities_project_created ON public.activities (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_user_created ON public.activities (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Who and how
-- ---------------------------------------------------------------------------
-- The person behind the current write, or NULL when it is an agent, a cron
-- job or anything else without a person behind it.
CREATE OR REPLACE FUNCTION public.activity_actor()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member uuid;
  v_header text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_member := public.current_team_member_id();
  ELSIF coalesce(auth.role(), '') = 'service_role' THEN
    BEGIN
      v_header := nullif(current_setting('request.headers', true), '')::json ->> 'x-actor-member-id';
      IF v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_member := v_header::uuid;
      END IF;
    EXCEPTION WHEN others THEN
      v_member := NULL;
    END;
  END IF;
  IF v_member IS NULL THEN
    RETURN NULL;
  END IF;
  -- Agents keep their own typed log; only people land here.
  IF NOT EXISTS (SELECT 1 FROM public.team_members WHERE id = v_member AND role <> 'agent') THEN
    RETURN NULL;
  END IF;
  RETURN v_member;
END;
$$;

-- Where the write came from: the app for a signed-in member, otherwise what
-- the server said (api or mcp).
CREATE OR REPLACE FUNCTION public.activity_source()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_via text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN 'app';
  END IF;
  BEGIN
    v_via := nullif(current_setting('request.headers', true), '')::json ->> 'x-actor-via';
  EXCEPTION WHEN others THEN
    v_via := NULL;
  END;
  RETURN CASE WHEN v_via IN ('app', 'api', 'mcp') THEN v_via ELSE 'api' END;
END;
$$;

-- ---------------------------------------------------------------------------
-- Small formatting helpers for the sentences
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activity_hours_label(p_hours numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN coalesce(round(p_hours * 60), 0) <= 0 THEN '0m'
    WHEN round(p_hours * 60)::int / 60 = 0 THEN (round(p_hours * 60)::int % 60) || 'm'
    WHEN round(p_hours * 60)::int % 60 = 0 THEN (round(p_hours * 60)::int / 60) || 'h'
    ELSE (round(p_hours * 60)::int / 60) || 'h ' || (round(p_hours * 60)::int % 60) || 'm'
  END
$$;

CREATE OR REPLACE FUNCTION public.activity_money_label(p_amount numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '$' || trim(to_char(coalesce(p_amount, 0), 'FM999,999,999,990.00'))
$$;

CREATE OR REPLACE FUNCTION public.activity_status_label(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'todo' THEN 'To do'
    ELSE upper(left(p_status, 1)) || replace(substr(p_status, 2), '_', ' ')
  END
$$;

CREATE OR REPLACE FUNCTION public.activity_member_name(p_member_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((SELECT name FROM public.team_members WHERE id = p_member_id), 'someone')
$$;

-- Columns whose values differ between two versions of a row, leaving out the
-- ones that change on their own (timestamps, ordering) or are logged apart.
CREATE OR REPLACE FUNCTION public.activity_changed_fields(p_new jsonb, p_old jsonb, p_ignore text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(array_agg(key ORDER BY key), ARRAY[]::text[])
  FROM jsonb_each(p_new) AS n(key, value)
  WHERE NOT (key = ANY (p_ignore))
    AND n.value IS DISTINCT FROM p_old -> key
$$;

-- The activity entity name for a Trash table.
CREATE OR REPLACE FUNCTION public.activity_entity_type(p_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'entity_files' THEN 'file'
    WHEN 'invoice_payments' THEN 'payment'
    WHEN 'project_hourly_rates' THEN 'hourly_rate'
    ELSE public.trash_entity_type(p_table)
  END
$$;

CREATE OR REPLACE FUNCTION public.activity_entity_noun(p_entity_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_entity_type
    WHEN 'time_entry' THEN 'time entry'
    WHEN 'portal_update' THEN 'portal update'
    WHEN 'portal_update_attachment' THEN 'portal attachment'
    WHEN 'lead_interaction' THEN 'lead interaction'
    WHEN 'lead_proposal' THEN 'proposal'
    WHEN 'lead_field' THEN 'lead field'
    WHEN 'hourly_rate' THEN 'hourly rate'
    WHEN 'retainer_amount' THEN 'retainer amount'
    ELSE p_entity_type
  END
$$;

-- ---------------------------------------------------------------------------
-- Writing a row
-- ---------------------------------------------------------------------------
-- Logs one thing a person did. Repeated edits ("*.updated") by the same
-- person on the same record within 15 minutes fold into one row, moved up to
-- the latest edit, so typing in a description does not flood the feed.
CREATE OR REPLACE FUNCTION public.log_team_activity(
  p_type text,
  p_entity_type text,
  p_entity_id text,
  p_project_id uuid,
  p_description text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := public.activity_actor();
  v_existing uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN;
  END IF;

  IF p_type LIKE '%.updated' THEN
    SELECT id INTO v_existing
    FROM public.activities
    WHERE user_id = v_actor AND type = p_type AND entity_id = p_entity_id
      AND updated_at > now() - interval '15 minutes'
    ORDER BY updated_at DESC
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      UPDATE public.activities
      SET description = p_description,
          metadata = metadata || coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('fields', (
            SELECT coalesce(jsonb_agg(DISTINCT field ORDER BY field), '[]'::jsonb)
            FROM jsonb_array_elements_text(coalesce(metadata -> 'fields', '[]'::jsonb) || coalesce(p_metadata -> 'fields', '[]'::jsonb)) AS field
          )),
          created_at = now(),
          updated_at = now()
      WHERE id = v_existing;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source)
  VALUES (p_type, p_entity_type, p_entity_id, p_project_id, v_actor, p_description, coalesce(p_metadata, '{}'::jsonb), public.activity_source());
END;
$$;

-- ---------------------------------------------------------------------------
-- Who may read a row
-- ---------------------------------------------------------------------------
-- Anyone who can open the project sees its team activity, except money, time
-- and credential events, which need the permission that shows those things.
-- A project in Trash hides its activity; standalone reminders stay private.
CREATE OR REPLACE FUNCTION public.can_read_activity(
  p_entity_type text,
  p_entity_id text,
  p_project_id uuid,
  p_actor uuid,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_project_id IS NOT NULL AND NOT public.project_is_live(p_project_id) THEN false
    WHEN p_actor = public.current_team_member_id() THEN true
    WHEN p_entity_type = 'reminder' AND p_project_id IS NULL THEN false
    WHEN public.has_permission('audit.read') THEN true
    WHEN p_project_id IS NULL THEN CASE
      WHEN p_entity_type = 'contact' THEN public.has_permission('contacts.read_all')
      WHEN p_metadata ? 'lead_id' THEN public.can_access_lead((p_metadata ->> 'lead_id')::uuid)
      ELSE false
    END
    WHEN NOT (public.has_permission('projects.read_all')
      OR (public.has_permission('projects.read') AND public.can_access_project(p_project_id))) THEN false
    ELSE CASE
      WHEN p_entity_type IN ('task', 'subtask', 'comment') THEN
        public.has_permission('tasks.read')
        OR coalesce(public.can_access_task((p_metadata ->> 'task_id')::uuid), false)
      WHEN p_entity_type = 'time_entry' THEN public.has_permission('time.read_all')
      WHEN p_entity_type IN ('invoice', 'payment', 'hourly_rate', 'retainer', 'retainer_amount') THEN public.has_permission('invoices.read')
      WHEN p_entity_type = 'credential' THEN public.has_permission('credentials.manage')
      WHEN p_entity_type = 'file' THEN public.has_permission('files.read')
      WHEN p_entity_type IN ('portal_update', 'portal_update_attachment') THEN public.has_permission('portal.read')
      WHEN p_entity_type = 'communication' THEN public.has_permission('communications.read')
      WHEN p_entity_type = 'contact' THEN public.has_permission('contacts.read') OR public.has_permission('contacts.read_all')
      ELSE true
    END
  END
$$;

DROP POLICY IF EXISTS activities_select ON public.activities;
DROP POLICY IF EXISTS activities_insert ON public.activities;
CREATE POLICY activities_select ON public.activities FOR SELECT TO authenticated
  USING (public.can_read_activity(entity_type, entity_id, project_id, user_id, metadata));

-- ---------------------------------------------------------------------------
-- What gets logged
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
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('task.created', 'task', NEW.id::text, NEW.project_id,
      format('Created task "%s"', NEW.title), v_meta);
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

  v_fields := public.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD),
    ARRAY['status', 'sort_order', 'completed_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by']);
  IF cardinality(v_fields) > 0 THEN
    PERFORM public.log_team_activity('task.updated', 'task', NEW.id::text, NEW.project_id,
      format('Edited task "%s"', NEW.title), v_meta || jsonb_build_object('fields', to_jsonb(v_fields)));
  END IF;
  RETURN NULL;
END;
$$;

-- Assignments. A task's own creation already says "Created task", so the
-- assignees saved with it are not logged again.
CREATE OR REPLACE FUNCTION public.log_task_assignee_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task_id uuid;
  v_member uuid;
  v_task record;
  v_self boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_task_id := NEW.task_id;
    v_member := NEW.member_id;
  ELSE
    v_task_id := OLD.task_id;
    v_member := OLD.member_id;
  END IF;
  SELECT id, title, project_id, created_at, deleted_at INTO v_task FROM public.tasks WHERE id = v_task_id;
  IF v_task.id IS NULL OR v_task.deleted_at IS NOT NULL OR v_task.created_at >= now() THEN
    RETURN NULL;
  END IF;
  v_self := v_member = public.activity_actor();
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('task.assigned', 'task', v_task.id::text, v_task.project_id,
      CASE WHEN v_self THEN format('Took on task "%s"', v_task.title)
        ELSE format('Assigned %s to task "%s"', public.activity_member_name(v_member), v_task.title) END,
      jsonb_build_object('task_id', v_task.id, 'task_title', v_task.title, 'member_id', v_member));
  ELSE
    PERFORM public.log_team_activity('task.unassigned', 'task', v_task.id::text, v_task.project_id,
      CASE WHEN v_self THEN format('Stepped off task "%s"', v_task.title)
        ELSE format('Unassigned %s from task "%s"', public.activity_member_name(v_member), v_task.title) END,
      jsonb_build_object('task_id', v_task.id, 'task_title', v_task.title, 'member_id', v_member));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_subtask_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task record;
  v_meta jsonb;
BEGIN
  SELECT id, title, project_id, created_at INTO v_task FROM public.tasks WHERE id = NEW.task_id;
  IF v_task.id IS NULL THEN
    RETURN NULL;
  END IF;
  v_meta := jsonb_build_object('task_id', v_task.id, 'task_title', v_task.title, 'subtask_title', NEW.title);
  IF TG_OP = 'INSERT' THEN
    IF v_task.created_at < now() THEN
      PERFORM public.log_team_activity('subtask.added', 'subtask', NEW.id::text, v_task.project_id,
        format('Added subtask "%s" to "%s"', NEW.title, v_task.title), v_meta);
    END IF;
  ELSIF NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at AND NEW.completed AND NOT OLD.completed THEN
    PERFORM public.log_team_activity('subtask.completed', 'subtask', NEW.id::text, v_task.project_id,
      format('Checked off "%s" on "%s"', NEW.title, v_task.title), v_meta);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_comment_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task record;
BEGIN
  SELECT id, title, project_id INTO v_task FROM public.tasks WHERE id = NEW.task_id;
  IF v_task.id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM public.log_team_activity('comment.added', 'comment', NEW.id::text, v_task.project_id,
    format('Commented on "%s"', v_task.title),
    jsonb_build_object('task_id', v_task.id, 'task_title', v_task.title, 'preview', left(NEW.text, 140)));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_project_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('project_name', NEW.name);
  v_fields text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('project.created', 'project', NEW.id::text, NEW.id,
      format('Created project "%s"', NEW.name), v_meta);
    RETURN NULL;
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.log_team_activity('project.status', 'project', NEW.id::text, NEW.id,
      CASE NEW.status
        WHEN 'completed' THEN format('Marked project "%s" completed', NEW.name)
        WHEN 'archived' THEN format('Archived project "%s"', NEW.name)
        ELSE format('Set project "%s" back to active', NEW.name)
      END,
      v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;

  v_fields := public.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD),
    ARRAY['status', 'archived_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by']);
  IF cardinality(v_fields) > 0 THEN
    PERFORM public.log_team_activity('project.updated', 'project', NEW.id::text, NEW.id,
      format('Edited project "%s"', NEW.name), v_meta || jsonb_build_object('fields', to_jsonb(v_fields)));
  END IF;
  RETURN NULL;
END;
$$;

-- Members and linked contacts. The ones saved with a new project come with
-- "Created project", so the first two minutes of a project are not logged.
CREATE OR REPLACE FUNCTION public.log_project_member_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_member uuid;
  v_project record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_project_id := NEW.project_id;
    v_member := NEW.member_id;
  ELSE
    v_project_id := OLD.project_id;
    v_member := OLD.member_id;
  END IF;
  SELECT id, name, created_at, deleted_at INTO v_project FROM public.projects WHERE id = v_project_id;
  IF v_project.id IS NULL OR v_project.deleted_at IS NOT NULL OR v_project.created_at > now() - interval '2 minutes' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('member.added', 'member', v_member::text, v_project.id,
      format('Added %s to project "%s"', public.activity_member_name(v_member), v_project.name),
      jsonb_build_object('member_id', v_member, 'project_name', v_project.name));
  ELSE
    PERFORM public.log_team_activity('member.removed', 'member', v_member::text, v_project.id,
      format('Removed %s from project "%s"', public.activity_member_name(v_member), v_project.name),
      jsonb_build_object('member_id', v_member, 'project_name', v_project.name));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_project_contact_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project record;
  v_contact_name text;
BEGIN
  SELECT id, name, created_at, deleted_at INTO v_project FROM public.projects WHERE id = NEW.project_id;
  IF v_project.id IS NULL OR v_project.deleted_at IS NOT NULL OR v_project.created_at > now() - interval '2 minutes' THEN
    RETURN NULL;
  END IF;
  SELECT name INTO v_contact_name FROM public.contacts WHERE id = NEW.contact_id;
  PERFORM public.log_team_activity('contact.linked', 'contact', NEW.contact_id::text, v_project.id,
    format('Linked %s to project "%s"', coalesce(v_contact_name, 'a contact'), v_project.name),
    jsonb_build_object('contact_id', NEW.contact_id, 'project_name', v_project.name));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_time_entry_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hours numeric;
  v_project_name text;
  v_meta jsonb;
  v_for text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  v_hours := public.time_entry_worked_hours(NEW.segments, NEW.start_time, NEW.end_time);
  SELECT name INTO v_project_name FROM public.projects WHERE id = NEW.project_id;
  v_meta := jsonb_build_object('time_entry_id', NEW.id, 'member_id', NEW.member_id, 'hours', round(v_hours, 2),
    'note', left(coalesce(NEW.description, ''), 140), 'project_name', v_project_name);
  v_for := CASE WHEN NEW.member_id = public.activity_actor() THEN ''
    ELSE ' for ' || public.activity_member_name(NEW.member_id) END;

  -- Time is "logged" when it has an end: entered whole, or a timer stopped.
  IF NEW.end_time IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.end_time IS NULL) THEN
    PERFORM public.log_team_activity('time.logged', 'time_entry', NEW.id::text, NEW.project_id,
      format('Logged %s%s', public.activity_hours_label(v_hours), v_for), v_meta);
  END IF;

  -- A review decision on finished time. The approval the workspace grants by
  -- itself as time is logged (owners, auto-approve) is not a person's review.
  IF TG_OP = 'UPDATE' AND OLD.end_time IS NOT NULL AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    IF NEW.approval_status = 'approved' THEN
      PERFORM public.log_team_activity('time.approved', 'time_entry', NEW.id::text, NEW.project_id,
        format('Approved %s from %s', public.activity_hours_label(v_hours), public.activity_member_name(NEW.member_id)), v_meta);
    ELSIF NEW.approval_status = 'rejected' THEN
      PERFORM public.log_team_activity('time.rejected', 'time_entry', NEW.id::text, NEW.project_id,
        format('Sent back %s from %s', public.activity_hours_label(v_hours), public.activity_member_name(NEW.member_id)),
        v_meta || jsonb_build_object('reason', left(coalesce(NEW.rejection_reason, ''), 200)));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_invoice_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('invoice_id', NEW.id, 'invoice_number', NEW.invoice_number, 'amount', NEW.amount);
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('invoice.created', 'invoice', NEW.id::text, NEW.project_id,
      format('Created invoice %s', NEW.invoice_number), v_meta);
    RETURN NULL;
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  PERFORM public.log_team_activity('invoice.' || NEW.status, 'invoice', NEW.id::text, NEW.project_id,
    CASE NEW.status
      WHEN 'sent' THEN format('Sent invoice %s', NEW.invoice_number)
      WHEN 'paid' THEN format('Marked invoice %s paid', NEW.invoice_number)
      WHEN 'cancelled' THEN format('Cancelled invoice %s', NEW.invoice_number)
      WHEN 'overdue' THEN format('Marked invoice %s overdue', NEW.invoice_number)
      ELSE format('Moved invoice %s back to draft', NEW.invoice_number)
    END,
    v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_payment_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice record;
BEGIN
  SELECT id, project_id, invoice_number INTO v_invoice FROM public.project_invoices WHERE id = NEW.invoice_id;
  IF v_invoice.id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM public.log_team_activity('payment.recorded', 'payment', NEW.id::text, v_invoice.project_id,
    format('Recorded a %s payment on invoice %s', public.activity_money_label(NEW.amount), v_invoice.invoice_number),
    jsonb_build_object('invoice_id', v_invoice.id, 'invoice_number', v_invoice.invoice_number, 'amount', NEW.amount));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_file_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_task record;
  v_meta jsonb := jsonb_build_object('file_name', NEW.name, 'entity_type', NEW.entity_type, 'entity_id', NEW.entity_id);
BEGIN
  IF NEW.entity_type = 'project' THEN
    v_project_id := NEW.entity_id;
  ELSIF NEW.entity_type = 'task' THEN
    SELECT id, title, project_id INTO v_task FROM public.tasks WHERE id = NEW.entity_id;
    v_project_id := v_task.project_id;
    v_meta := v_meta || jsonb_build_object('task_id', v_task.id, 'task_title', v_task.title);
  ELSIF NEW.entity_type = 'lead' THEN
    v_meta := v_meta || jsonb_build_object('lead_id', NEW.entity_id);
  END IF;
  PERFORM public.log_team_activity('file.uploaded', 'file', NEW.id::text, v_project_id,
    CASE WHEN v_task.id IS NOT NULL THEN format('Uploaded "%s" to task "%s"', NEW.name, v_task.title)
      ELSE format('Uploaded "%s"', NEW.name) END,
    v_meta);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_portal_update_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_team_activity('portal_update.posted', 'portal_update', NEW.id::text, NEW.project_id,
    format('Posted portal update "%s"', NEW.title), jsonb_build_object('portal_update_id', NEW.id));
  RETURN NULL;
END;
$$;

-- Only the label: never anything from the secret itself.
CREATE OR REPLACE FUNCTION public.log_credential_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_team_activity('credential.added', 'credential', NEW.id::text, NEW.project_id,
    format('Added credential "%s"', NEW.label), jsonb_build_object('credential_id', NEW.id));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_reminder_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid := NEW.project_id;
  v_meta jsonb := jsonb_build_object('reminder_id', NEW.id);
BEGIN
  IF NEW.task_id IS NOT NULL THEN
    SELECT coalesce(v_project_id, project_id) INTO v_project_id FROM public.tasks WHERE id = NEW.task_id;
    v_meta := v_meta || jsonb_build_object('task_id', NEW.task_id);
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('reminder.created', 'reminder', NEW.id::text, v_project_id,
      format('Added reminder "%s"', NEW.title), v_meta);
  ELSIF NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
    AND NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' AND NOT coalesce(NEW.closed_by_task, false) THEN
    -- A reminder closed by its task finishing is covered by "Completed task".
    PERFORM public.log_team_activity('reminder.completed', 'reminder', NEW.id::text, v_project_id,
      format('Completed reminder "%s"', NEW.title), v_meta);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_communication_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'sent' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'sent') THEN
    PERFORM public.log_team_activity('communication.sent', 'communication', NEW.id::text, NEW.project_id,
      format('Sent "%s" to the client', coalesce(nullif(NEW.subject, ''), 'an email')),
      jsonb_build_object('communication_id', NEW.id, 'notification_type', NEW.notification_type));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_contact_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_team_activity('contact.created', 'contact', NEW.id::text, NULL,
    format('Added contact "%s"', NEW.name), jsonb_build_object('contact_id', NEW.id));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_lead_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('lead_id', NEW.id, 'lead_name', NEW.name);
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('lead.created', 'lead', NEW.id::text, NULL,
      format('Added lead "%s"', NEW.name), v_meta);
  ELSIF NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.log_team_activity('lead.status', 'lead', NEW.id::text, NULL,
      format('Moved lead "%s" to %s', NEW.name, public.activity_status_label(NEW.status)),
      v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  RETURN NULL;
END;
$$;

-- Moves to Trash and restores, for every Trash table. The project a record
-- belongs to comes from the record or its parent, so a project's feed shows
-- it.
CREATE OR REPLACE FUNCTION public.log_trash_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec jsonb := to_jsonb(NEW);
  v_entity text := public.activity_entity_type(TG_TABLE_NAME);
  v_project uuid;
  v_label text;
  v_meta jsonb := jsonb_build_object('record_type', TG_TABLE_NAME);
  v_restored boolean := NEW.deleted_at IS NULL;
BEGIN
  v_label := coalesce(
    nullif(rec ->> 'title', ''), nullif(rec ->> 'name', ''), nullif(rec ->> 'label', ''),
    nullif(rec ->> 'invoice_number', ''), nullif(rec ->> 'field_key', ''),
    nullif(left(rec ->> 'text', 80), ''), nullif(left(rec ->> 'description', 80), ''));

  IF TG_TABLE_NAME = 'projects' THEN
    v_project := NEW.id;
  ELSIF rec ? 'project_id' THEN
    v_project := nullif(rec ->> 'project_id', '')::uuid;
  END IF;

  IF rec ? 'task_id' THEN
    v_meta := v_meta || jsonb_build_object('task_id', rec ->> 'task_id');
    IF v_project IS NULL THEN
      SELECT project_id INTO v_project FROM public.tasks WHERE id = (rec ->> 'task_id')::uuid;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'tasks' THEN
    v_meta := v_meta || jsonb_build_object('task_id', NEW.id);
  END IF;
  IF rec ? 'invoice_id' AND v_project IS NULL THEN
    SELECT project_id, invoice_number INTO v_project, v_label
    FROM public.project_invoices WHERE id = (rec ->> 'invoice_id')::uuid;
    v_label := public.activity_money_label((rec ->> 'amount')::numeric) || ' on ' || coalesce(v_label, 'an invoice');
  END IF;
  IF rec ? 'update_id' AND v_project IS NULL THEN
    SELECT project_id INTO v_project FROM public.portal_updates WHERE id = (rec ->> 'update_id')::uuid;
  END IF;
  IF rec ? 'retainer_id' AND v_project IS NULL THEN
    SELECT project_id INTO v_project FROM public.project_retainers WHERE id = (rec ->> 'retainer_id')::uuid;
  END IF;
  IF TG_TABLE_NAME = 'entity_files' THEN
    IF rec ->> 'entity_type' = 'project' THEN
      v_project := (rec ->> 'entity_id')::uuid;
    ELSIF rec ->> 'entity_type' = 'task' THEN
      SELECT project_id INTO v_project FROM public.tasks WHERE id = (rec ->> 'entity_id')::uuid;
      v_meta := v_meta || jsonb_build_object('task_id', rec ->> 'entity_id');
    ELSIF rec ->> 'entity_type' = 'lead' THEN
      v_meta := v_meta || jsonb_build_object('lead_id', rec ->> 'entity_id');
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'leads' THEN
    v_meta := v_meta || jsonb_build_object('lead_id', NEW.id);
  ELSIF rec ? 'lead_id' THEN
    v_meta := v_meta || jsonb_build_object('lead_id', rec ->> 'lead_id');
  END IF;
  IF TG_TABLE_NAME = 'project_time_entries' THEN
    v_label := public.activity_hours_label(public.time_entry_worked_hours(NEW.segments, NEW.start_time, NEW.end_time))
      || ' from ' || public.activity_member_name(NEW.member_id);
  END IF;

  PERFORM public.log_team_activity(
    CASE WHEN v_restored THEN 'record.restored' ELSE 'record.trashed' END,
    v_entity, NEW.id::text, v_project,
    format('%s %s%s%s',
      CASE WHEN v_restored THEN 'Restored' ELSE 'Moved' END,
      public.activity_entity_noun(v_entity),
      CASE WHEN v_label IS NULL THEN '' ELSE format(' "%s"', v_label) END,
      CASE WHEN v_restored THEN '' ELSE ' to Trash' END),
    v_meta);
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS log_task_activity ON public.tasks;
CREATE TRIGGER log_task_activity AFTER INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.log_task_activity();
DROP TRIGGER IF EXISTS log_task_assignee_activity ON public.task_assignees;
CREATE TRIGGER log_task_assignee_activity AFTER INSERT OR DELETE ON public.task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.log_task_assignee_activity();
DROP TRIGGER IF EXISTS log_subtask_activity ON public.task_subtasks;
CREATE TRIGGER log_subtask_activity AFTER INSERT OR UPDATE ON public.task_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.log_subtask_activity();
DROP TRIGGER IF EXISTS log_comment_activity ON public.task_comments;
CREATE TRIGGER log_comment_activity AFTER INSERT ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.log_comment_activity();
DROP TRIGGER IF EXISTS log_project_activity ON public.projects;
CREATE TRIGGER log_project_activity AFTER INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.log_project_activity();
DROP TRIGGER IF EXISTS log_project_member_activity ON public.project_members;
CREATE TRIGGER log_project_member_activity AFTER INSERT OR DELETE ON public.project_members
  FOR EACH ROW EXECUTE FUNCTION public.log_project_member_activity();
DROP TRIGGER IF EXISTS log_project_contact_activity ON public.project_contacts;
CREATE TRIGGER log_project_contact_activity AFTER INSERT ON public.project_contacts
  FOR EACH ROW EXECUTE FUNCTION public.log_project_contact_activity();
DROP TRIGGER IF EXISTS log_time_entry_activity ON public.project_time_entries;
CREATE TRIGGER log_time_entry_activity AFTER INSERT OR UPDATE ON public.project_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.log_time_entry_activity();
DROP TRIGGER IF EXISTS log_invoice_activity ON public.project_invoices;
CREATE TRIGGER log_invoice_activity AFTER INSERT OR UPDATE ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.log_invoice_activity();
DROP TRIGGER IF EXISTS log_payment_activity ON public.invoice_payments;
CREATE TRIGGER log_payment_activity AFTER INSERT ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.log_payment_activity();
DROP TRIGGER IF EXISTS log_file_activity ON public.entity_files;
CREATE TRIGGER log_file_activity AFTER INSERT ON public.entity_files
  FOR EACH ROW EXECUTE FUNCTION public.log_file_activity();
DROP TRIGGER IF EXISTS log_portal_update_activity ON public.portal_updates;
CREATE TRIGGER log_portal_update_activity AFTER INSERT ON public.portal_updates
  FOR EACH ROW EXECUTE FUNCTION public.log_portal_update_activity();
DROP TRIGGER IF EXISTS log_credential_activity ON public.project_credentials;
CREATE TRIGGER log_credential_activity AFTER INSERT ON public.project_credentials
  FOR EACH ROW EXECUTE FUNCTION public.log_credential_activity();
DROP TRIGGER IF EXISTS log_reminder_activity ON public.reminders;
CREATE TRIGGER log_reminder_activity AFTER INSERT OR UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.log_reminder_activity();
DROP TRIGGER IF EXISTS log_communication_activity ON public.client_communications;
CREATE TRIGGER log_communication_activity AFTER INSERT OR UPDATE ON public.client_communications
  FOR EACH ROW EXECUTE FUNCTION public.log_communication_activity();
DROP TRIGGER IF EXISTS log_contact_activity ON public.contacts;
CREATE TRIGGER log_contact_activity AFTER INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.log_contact_activity();
DROP TRIGGER IF EXISTS log_lead_activity ON public.leads;
CREATE TRIGGER log_lead_activity AFTER INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.log_lead_activity();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'tasks', 'task_subtasks', 'task_comments', 'reminders', 'project_credentials', 'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads', 'lead_interactions', 'lead_proposals', 'lead_fields', 'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates', 'project_retainers', 'project_retainer_amounts'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS log_trash_activity ON public.%I', t);
    EXECUTE format('CREATE TRIGGER log_trash_activity AFTER UPDATE OF deleted_at ON public.%I
      FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
      EXECUTE FUNCTION public.log_trash_activity()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- save_task replaces only the assignees that changed, so re-saving a task
-- does not look like everyone was unassigned and assigned again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_task(
  p_task_id uuid,
  p_task jsonb,
  p_assignee_ids uuid[] DEFAULT NULL,
  p_criteria text[] DEFAULT NULL,
  p_blocked_by uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_task_id uuid := p_task_id;
  v_payload jsonb := COALESCE(p_task, '{}'::jsonb);
  v_unknown text;
  v_cols text[];
  v_rows integer;
  v_task public.tasks;
BEGIN
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'save_task: p_task must be a JSON object' USING ERRCODE = '22023';
  END IF;

  -- Same contract as a PostgREST update: an unknown column is an error, not
  -- a silently dropped field.
  SELECT key INTO v_unknown
  FROM jsonb_object_keys(v_payload) AS key
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.tasks'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname = key
  )
  LIMIT 1;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'save_task: unknown task column "%"', v_unknown USING ERRCODE = '42703';
  END IF;

  SELECT array_agg(key ORDER BY key) INTO v_cols
  FROM jsonb_object_keys(v_payload) AS key
  WHERE key NOT IN ('id', 'created_at');

  IF v_task_id IS NULL THEN
    IF v_cols IS NULL THEN
      RAISE EXCEPTION 'save_task: a new task needs its columns' USING ERRCODE = '22023';
    END IF;
    EXECUTE format(
      'INSERT INTO public.tasks (%s) SELECT %s FROM jsonb_populate_record(NULL::public.tasks, $1) r RETURNING id',
      (SELECT string_agg(format('%I', c), ', ') FROM unnest(v_cols) c),
      (SELECT string_agg(format('r.%I', c), ', ') FROM unnest(v_cols) c)
    ) INTO v_task_id USING v_payload;
  ELSIF v_cols IS NOT NULL THEN
    EXECUTE format(
      'UPDATE public.tasks t SET %s FROM jsonb_populate_record(NULL::public.tasks, $1) r WHERE t.id = $2',
      (SELECT string_agg(format('%I = r.%I', c, c), ', ') FROM unnest(v_cols) c)
    ) USING v_payload, v_task_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    -- RLS turns a denied update into zero rows; that is a failure, not a save.
    IF v_rows = 0 THEN
      RAISE EXCEPTION 'save_task: task % not found or not permitted', v_task_id USING ERRCODE = 'P0002';
    END IF;
  ELSE
    PERFORM 1 FROM public.tasks WHERE id = v_task_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'save_task: task % not found or not permitted', v_task_id USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF p_assignee_ids IS NOT NULL THEN
    DELETE FROM public.task_assignees
    WHERE task_id = v_task_id AND NOT (member_id = ANY (p_assignee_ids));
    INSERT INTO public.task_assignees (task_id, member_id)
    SELECT DISTINCT v_task_id, member_id FROM unnest(p_assignee_ids) AS member_id
    ON CONFLICT (task_id, member_id) DO NOTHING;
  END IF;

  IF p_criteria IS NOT NULL THEN
    DELETE FROM public.task_acceptance_criteria WHERE task_id = v_task_id;
    INSERT INTO public.task_acceptance_criteria (task_id, criterion, sort_order)
    SELECT v_task_id, c.criterion, (c.ordinality - 1)::int
    FROM unnest(p_criteria) WITH ORDINALITY AS c(criterion, ordinality);
  END IF;

  IF p_blocked_by IS NOT NULL THEN
    DELETE FROM public.task_dependencies WHERE task_id = v_task_id;
    INSERT INTO public.task_dependencies (task_id, blocked_by_task_id)
    SELECT DISTINCT v_task_id, blocked_by FROM unnest(p_blocked_by) AS blocked_by;
  END IF;

  SELECT * INTO v_task FROM public.tasks WHERE id = v_task_id;
  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'criteria', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.sort_order)
      FROM public.task_acceptance_criteria c
      WHERE c.task_id = v_task_id
    ), '[]'::jsonb)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Backfill from records that name their author (people only, live records,
-- original timestamps). Safe to run again: each record is logged once.
-- ---------------------------------------------------------------------------
INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'project.created', 'project', p.id::text, p.id, p.created_by, format('Created project "%s"', p.name),
  jsonb_build_object('project_name', p.name), 'backfill', p.created_at, p.created_at
FROM public.projects p
JOIN public.team_members m ON m.id = p.created_by AND m.role <> 'agent'
WHERE p.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'project.created' AND a.entity_id = p.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'task.created', 'task', t.id::text, t.project_id, t.created_by, format('Created task "%s"', t.title),
  jsonb_build_object('task_id', t.id, 'task_title', t.title), 'backfill', t.created_at, t.created_at
FROM public.tasks t
JOIN public.team_members m ON m.id = t.created_by AND m.role <> 'agent'
WHERE t.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'task.created' AND a.entity_id = t.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'comment.added', 'comment', c.id::text, t.project_id, c.user_id, format('Commented on "%s"', t.title),
  jsonb_build_object('task_id', t.id, 'task_title', t.title, 'preview', left(c.text, 140)), 'backfill', c.created_at, c.created_at
FROM public.task_comments c
JOIN public.tasks t ON t.id = c.task_id AND t.deleted_at IS NULL
JOIN public.team_members m ON m.id = c.user_id AND m.role <> 'agent'
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'comment.added' AND a.entity_id = c.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'time.logged', 'time_entry', e.id::text, e.project_id, e.member_id,
  format('Logged %s', public.activity_hours_label(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time))),
  jsonb_build_object('time_entry_id', e.id, 'member_id', e.member_id,
    'hours', round(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time), 2),
    'note', left(coalesce(e.description, ''), 140), 'project_name', p.name),
  'backfill', e.end_time, e.end_time
FROM public.project_time_entries e
JOIN public.projects p ON p.id = e.project_id
JOIN public.team_members m ON m.id = e.member_id AND m.role <> 'agent'
WHERE e.deleted_at IS NULL AND e.end_time IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'time.logged' AND a.entity_id = e.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'file.uploaded', 'file', f.id::text,
  CASE WHEN f.entity_type = 'project' THEN f.entity_id WHEN f.entity_type = 'task' THEN t.project_id END,
  f.uploaded_by,
  CASE WHEN t.id IS NOT NULL THEN format('Uploaded "%s" to task "%s"', f.name, t.title) ELSE format('Uploaded "%s"', f.name) END,
  jsonb_build_object('file_name', f.name, 'entity_type', f.entity_type, 'entity_id', f.entity_id)
    || CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('task_id', t.id, 'task_title', t.title) ELSE '{}'::jsonb END
    || CASE WHEN f.entity_type = 'lead' THEN jsonb_build_object('lead_id', f.entity_id) ELSE '{}'::jsonb END,
  'backfill', f.created_at, f.created_at
FROM public.entity_files f
LEFT JOIN public.tasks t ON f.entity_type = 'task' AND t.id = f.entity_id
JOIN public.team_members m ON m.id = f.uploaded_by AND m.role <> 'agent'
WHERE f.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'file.uploaded' AND a.entity_id = f.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'portal_update.posted', 'portal_update', u.id::text, u.project_id, u.author_id, format('Posted portal update "%s"', u.title),
  jsonb_build_object('portal_update_id', u.id), 'backfill', u.created_at, u.created_at
FROM public.portal_updates u
JOIN public.team_members m ON m.id = u.author_id AND m.role <> 'agent'
WHERE u.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'portal_update.posted' AND a.entity_id = u.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'credential.added', 'credential', c.id::text, c.project_id, c.created_by, format('Added credential "%s"', c.label),
  jsonb_build_object('credential_id', c.id), 'backfill', c.created_at, c.created_at
FROM public.project_credentials c
JOIN public.team_members m ON m.id = c.created_by AND m.role <> 'agent'
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'credential.added' AND a.entity_id = c.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'invoice.created', 'invoice', i.id::text, i.project_id, i.created_by, format('Created invoice %s', i.invoice_number),
  jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'amount', i.amount), 'backfill', i.created_at, i.created_at
FROM public.project_invoices i
JOIN public.team_members m ON m.id = i.created_by AND m.role <> 'agent'
WHERE i.deleted_at IS NULL AND NOT coalesce(i.auto_generated, false)
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'invoice.created' AND a.entity_id = i.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'payment.recorded', 'payment', pay.id::text, i.project_id, pay.created_by,
  format('Recorded a %s payment on invoice %s', public.activity_money_label(pay.amount), i.invoice_number),
  jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'amount', pay.amount), 'backfill', pay.created_at, pay.created_at
FROM public.invoice_payments pay
JOIN public.project_invoices i ON i.id = pay.invoice_id AND i.deleted_at IS NULL
JOIN public.team_members m ON m.id = pay.created_by AND m.role <> 'agent'
WHERE pay.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'payment.recorded' AND a.entity_id = pay.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'reminder.created', 'reminder', r.id::text, coalesce(r.project_id, t.project_id), r.created_by, format('Added reminder "%s"', r.title),
  jsonb_build_object('reminder_id', r.id) || CASE WHEN r.task_id IS NOT NULL THEN jsonb_build_object('task_id', r.task_id) ELSE '{}'::jsonb END,
  'backfill', r.created_at, r.created_at
FROM public.reminders r
LEFT JOIN public.tasks t ON t.id = r.task_id
JOIN public.team_members m ON m.id = r.created_by AND m.role <> 'agent'
WHERE r.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'reminder.created' AND a.entity_id = r.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'reminder.completed', 'reminder', r.id::text, coalesce(r.project_id, t.project_id), r.completed_by, format('Completed reminder "%s"', r.title),
  jsonb_build_object('reminder_id', r.id) || CASE WHEN r.task_id IS NOT NULL THEN jsonb_build_object('task_id', r.task_id) ELSE '{}'::jsonb END,
  'backfill', r.completed_at, r.completed_at
FROM public.reminders r
LEFT JOIN public.tasks t ON t.id = r.task_id
JOIN public.team_members m ON m.id = r.completed_by AND m.role <> 'agent'
WHERE r.deleted_at IS NULL AND r.status = 'done' AND r.completed_at IS NOT NULL AND NOT coalesce(r.closed_by_task, false)
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'reminder.completed' AND a.entity_id = r.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'contact.created', 'contact', c.id::text, NULL, c.created_by, format('Added contact "%s"', c.name),
  jsonb_build_object('contact_id', c.id), 'backfill', c.created_at, c.created_at
FROM public.contacts c
JOIN public.team_members m ON m.id = c.created_by AND m.role <> 'agent'
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'contact.created' AND a.entity_id = c.id::text);

INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at)
SELECT 'lead.created', 'lead', l.id::text, NULL, l.created_by, format('Added lead "%s"', l.name),
  jsonb_build_object('lead_id', l.id, 'lead_name', l.name), 'backfill', l.created_at, l.created_at
FROM public.leads l
JOIN public.team_members m ON m.id = l.created_by AND m.role <> 'agent'
WHERE l.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities a WHERE a.type = 'lead.created' AND a.entity_id = l.id::text);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.activity_actor() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.log_team_activity(text, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_read_activity(text, text, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activity_actor() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_read_activity(text, text, uuid, uuid, jsonb) TO authenticated, service_role;
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'log_task_activity', 'log_task_assignee_activity', 'log_subtask_activity', 'log_comment_activity',
    'log_project_activity', 'log_project_member_activity', 'log_project_contact_activity',
    'log_time_entry_activity', 'log_invoice_activity', 'log_payment_activity', 'log_file_activity',
    'log_portal_update_activity', 'log_credential_activity', 'log_reminder_activity',
    'log_communication_activity', 'log_contact_activity', 'log_lead_activity', 'log_trash_activity'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END $$;
