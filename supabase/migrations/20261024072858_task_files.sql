-- Task files: a task's own files, and links to files that already exist.
--
-- Each row is one of three kinds:
--   upload            stored once, in the private task-files bucket, by
--                     content ({project_id}/{sha256}): the same bytes added to
--                     several tasks of a project are one object;
--   email_attachment  a link to an email's attachment, never a copy;
--   project_file      a link to a file on the project, never a copy.
-- A link holds its source in place (ON DELETE RESTRICT): email retention moves
-- a linked attachment to the task before deleting its email, so a task never
-- loses a file. Shaped like entity_files (name, mime_type, file_size, Trash),
-- with storage_path and sha256 as email_attachments keeps them. Joins Trash
-- the way task_comments does, and the team activity log as files do.
--
-- Also fixes log_file_activity: since the team activity log (20261022074722)
-- it read v_task before assigning it, so uploading a file to a project, lead
-- or contact failed with "record v_task is not assigned yet".

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  -- upload: the task's own file. email_attachment, project_file: a link to a
  -- file that already exists, never a copy.
  kind text NOT NULL CHECK (kind IN ('upload', 'email_attachment', 'project_file')),
  -- upload only: the object in the private task-files bucket, stored by
  -- content ({project_id}/{sha256}) so the same bytes are kept once per project.
  storage_path text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  -- A linked email attachment or project file. RESTRICT: neither may vanish
  -- under a task (email retention moves a linked attachment to the task first).
  email_attachment_id uuid REFERENCES public.email_attachments(id) ON DELETE RESTRICT,
  entity_file_id uuid REFERENCES public.entity_files(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  file_size bigint NOT NULL DEFAULT 0 CHECK (file_size >= 0),
  -- Why it is on the task, in a few words ("the screenshot Ciaran sent").
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  added_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never removed.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  CONSTRAINT task_files_one_source CHECK (
    (kind = 'upload' AND storage_path IS NOT NULL AND sha256 IS NOT NULL AND email_attachment_id IS NULL AND entity_file_id IS NULL)
    OR (kind = 'email_attachment' AND email_attachment_id IS NOT NULL AND storage_path IS NULL AND sha256 IS NULL AND entity_file_id IS NULL)
    OR (kind = 'project_file' AND entity_file_id IS NOT NULL AND storage_path IS NULL AND sha256 IS NULL AND email_attachment_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_task_files_task ON public.task_files (task_id);
CREATE INDEX IF NOT EXISTS idx_task_files_deleted_at ON public.task_files (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_files_storage_path ON public.task_files (storage_path) WHERE storage_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_files_email_attachment ON public.task_files (email_attachment_id) WHERE email_attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_files_entity_file ON public.task_files (entity_file_id) WHERE entity_file_id IS NOT NULL;
-- One live entry per file per task: adding the same file twice adds nothing.
CREATE UNIQUE INDEX IF NOT EXISTS task_files_live_upload ON public.task_files (task_id, sha256) WHERE kind = 'upload' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS task_files_live_email_attachment ON public.task_files (task_id, email_attachment_id) WHERE kind = 'email_attachment' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS task_files_live_project_file ON public.task_files (task_id, entity_file_id) WHERE kind = 'project_file' AND deleted_at IS NULL;

-- Private, like inbound-email: only the server reads and writes it, and hands
-- out short signed links. No storage.objects policies on purpose.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('task-files', 'task-files', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
ALTER TABLE public.task_files ENABLE ROW LEVEL SECURITY;

-- Read with the task and the file permission; add as yourself; change or
-- trash your own, or any with files.manage. Most writes are server routes.
DROP POLICY IF EXISTS task_files_select ON public.task_files;
CREATE POLICY task_files_select ON public.task_files FOR SELECT TO authenticated
  USING (public.has_permission('files.read') AND public.can_access_task(task_id));
DROP POLICY IF EXISTS task_files_insert ON public.task_files;
CREATE POLICY task_files_insert ON public.task_files FOR INSERT TO authenticated
  WITH CHECK (public.has_permission('files.upload') AND public.can_access_task(task_id)
    AND added_by = public.current_team_member_id());
DROP POLICY IF EXISTS task_files_update ON public.task_files;
CREATE POLICY task_files_update ON public.task_files FOR UPDATE TO authenticated
  USING (public.can_access_task(task_id) AND (public.has_permission('files.manage') OR added_by = public.current_team_member_id()))
  WITH CHECK (public.can_access_task(task_id) AND (public.has_permission('files.manage') OR added_by = public.current_team_member_id()));
DROP POLICY IF EXISTS task_files_not_deleted ON public.task_files;
CREATE POLICY task_files_not_deleted ON public.task_files AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
DROP POLICY IF EXISTS task_files_parent_live ON public.task_files;
CREATE POLICY task_files_parent_live ON public.task_files AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id));

-- ---------------------------------------------------------------------------
-- Trash and the activity log
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trash_record_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'projects', 'tasks', 'task_subtasks', 'task_comments', 'reminders', 'project_credentials',
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
      SELECT public.has_permission('tasks.manage_all') AND public.can_access_project(project_id)
      INTO allowed FROM public.tasks WHERE id = p_id;
    WHEN 'task_subtasks' THEN
      SELECT public.can_access_task(task_id) AND (
        public.has_permission('tasks.manage_all') OR (
          public.has_permission('tasks.manage_assigned') AND EXISTS (
            SELECT 1 FROM public.task_assignees assignment
            WHERE assignment.task_id = task_subtasks.task_id AND assignment.member_id = me
          )
        )
      ) INTO allowed FROM public.task_subtasks WHERE id = p_id;
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
      SELECT p.deleted_at IS NOT NULL INTO project_gone
      FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE t.id = p_id;
    WHEN 'task_subtasks', 'task_comments', 'task_files' THEN
      EXECUTE format('SELECT t.deleted_at IS NOT NULL, p.deleted_at IS NOT NULL
        FROM public.%I c JOIN public.tasks t ON t.id = c.task_id JOIN public.projects p ON p.id = t.project_id
        WHERE c.id = $1', p_table)
      INTO task_gone, project_gone USING p_id;
    WHEN 'reminders' THEN
      SELECT coalesce(t.deleted_at IS NOT NULL, false), coalesce(p.deleted_at IS NOT NULL, false)
      INTO task_gone, project_gone
      FROM public.reminders r
      LEFT JOIN public.tasks t ON t.id = r.task_id
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

CREATE OR REPLACE FUNCTION public.trash_entity_type(p_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'projects' THEN 'project'
    WHEN 'tasks' THEN 'task'
    WHEN 'task_subtasks' THEN 'subtask'
    WHEN 'task_comments' THEN 'comment'
    WHEN 'task_files' THEN 'task_file'
    WHEN 'reminders' THEN 'reminder'
    WHEN 'project_credentials' THEN 'credential'
    WHEN 'entity_files' THEN 'entity_file'
    WHEN 'portal_updates' THEN 'portal_update'
    WHEN 'portal_update_attachments' THEN 'portal_update_attachment'
    WHEN 'contacts' THEN 'contact'
    WHEN 'leads' THEN 'lead'
    WHEN 'lead_interactions' THEN 'lead_interaction'
    WHEN 'lead_proposals' THEN 'lead_proposal'
    WHEN 'lead_fields' THEN 'lead_field'
    WHEN 'project_time_entries' THEN 'time_entry'
    WHEN 'project_invoices' THEN 'invoice'
    WHEN 'invoice_payments' THEN 'invoice_payment'
    WHEN 'project_hourly_rates' THEN 'project_hourly_rate'
    WHEN 'project_retainers' THEN 'retainer'
    WHEN 'project_retainer_amounts' THEN 'retainer_amount'
    ELSE p_table
  END
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
      ('tasks', 'r.title', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('task_subtasks', 'r.title', 't.title', 't.project_id', 'LEFT JOIN public.tasks t ON t.id = r.task_id'),
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

CREATE OR REPLACE FUNCTION public.log_file_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_task_id uuid;
  v_task_title text;
  v_meta jsonb := jsonb_build_object('file_name', NEW.name, 'entity_type', NEW.entity_type, 'entity_id', NEW.entity_id);
BEGIN
  IF NEW.entity_type = 'project' THEN
    v_project_id := NEW.entity_id;
  ELSIF NEW.entity_type = 'task' THEN
    SELECT id, title, project_id INTO v_task_id, v_task_title, v_project_id FROM public.tasks WHERE id = NEW.entity_id;
    v_meta := v_meta || jsonb_build_object('task_id', v_task_id, 'task_title', v_task_title);
  ELSIF NEW.entity_type = 'lead' THEN
    v_meta := v_meta || jsonb_build_object('lead_id', NEW.entity_id);
  END IF;
  PERFORM public.log_team_activity('file.uploaded', 'file', NEW.id::text, v_project_id,
    CASE WHEN v_task_id IS NOT NULL THEN format('Uploaded "%s" to task "%s"', NEW.name, v_task_title)
      ELSE format('Uploaded "%s"', NEW.name) END,
    v_meta);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.activity_entity_type(p_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'entity_files' THEN 'file'
    WHEN 'task_files' THEN 'file'
    WHEN 'invoice_payments' THEN 'payment'
    WHEN 'project_hourly_rates' THEN 'hourly_rate'
    ELSE public.trash_entity_type(p_table)
  END
$$;

CREATE OR REPLACE FUNCTION public.log_task_file_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title text;
  v_project_id uuid;
BEGIN
  SELECT title, project_id INTO v_title, v_project_id FROM public.tasks WHERE id = NEW.task_id;
  PERFORM public.log_team_activity(
    CASE WHEN NEW.kind = 'upload' THEN 'file.uploaded' ELSE 'file.attached' END,
    'file', NEW.id::text, v_project_id,
    format(CASE WHEN NEW.kind = 'upload' THEN 'Uploaded "%s" to task "%s"' ELSE 'Attached "%s" to task "%s"' END, NEW.name, v_title),
    jsonb_build_object('file_name', NEW.name, 'kind', NEW.kind, 'task_id', NEW.task_id, 'task_title', v_title));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS set_task_files_updated_at ON public.task_files;
CREATE TRIGGER set_task_files_updated_at BEFORE UPDATE ON public.task_files
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
DROP TRIGGER IF EXISTS forbid_hard_delete ON public.task_files;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.task_files
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON public.task_files;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.task_files
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
DROP TRIGGER IF EXISTS record_trash_event ON public.task_files;
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.task_files
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
DROP TRIGGER IF EXISTS log_trash_activity ON public.task_files;
CREATE TRIGGER log_trash_activity AFTER UPDATE OF deleted_at ON public.task_files
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.log_trash_activity();
DROP TRIGGER IF EXISTS log_task_file_activity ON public.task_files;
CREATE TRIGGER log_task_file_activity AFTER INSERT ON public.task_files
  FOR EACH ROW EXECUTE FUNCTION public.log_task_file_activity();

REVOKE ALL ON FUNCTION public.log_task_file_activity() FROM PUBLIC, anon, authenticated;
