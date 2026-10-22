-- Soft delete, part 1: records are never permanently deleted.
--
-- Deleting a project, task, comment, reminder, credential, file, portal
-- update, contact or lead now moves it to Trash (deleted_at / deleted_by)
-- and Restore brings it back. The database itself refuses DELETE and
-- TRUNCATE on these tables for every role, so a missed code path fails
-- loudly instead of losing client data.
--
-- A deleted parent hides its children without touching them: the access
-- helpers treat a deleted project, task, lead or contact as out of reach,
-- so restoring the parent brings everything back exactly as it was.
--
-- Team members and client communications get the guard only: members are
-- deactivated (status), never deleted; communications were never deletable.
--
-- Billing records (time entries, invoices, payments, retainers, rates) follow
-- in part 2, with the billing functions and cron jobs that read them.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Who deleted what, and when
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'tasks', 'task_subtasks', 'task_comments', 'reminders', 'project_credentials',
    'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads',
    'lead_interactions', 'lead_proposals', 'lead_fields'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_at timestamptz', t);
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL', t);
    -- Trash lists deleted rows newest first; live reads never use this index.
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (deleted_at DESC) WHERE deleted_at IS NOT NULL',
      'idx_' || t || '_deleted_at', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The guard: DELETE and TRUNCATE are refused, service role included
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.forbid_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % are never permanently deleted. Move them to Trash instead.', TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'Use soft_delete_record(), or deactivate a team member.';
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'tasks', 'task_subtasks', 'task_comments', 'reminders', 'project_credentials',
    'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads',
    'lead_interactions', 'lead_proposals', 'lead_fields', 'team_members', 'client_communications'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_hard_delete ON public.%I', t);
    EXECUTE format('CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Signed-in members never see or change a deleted row
-- ---------------------------------------------------------------------------
-- RESTRICTIVE, so it narrows every existing policy (including the FOR ALL
-- manage policies that also grant SELECT). Moving to Trash and restoring go
-- through the definer functions below, which check the delete permission.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'tasks', 'task_subtasks', 'task_comments', 'reminders', 'project_credentials',
    'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads',
    'lead_interactions', 'lead_proposals', 'lead_fields'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_not_deleted', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
      USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL)', t || '_not_deleted', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. A deleted parent puts everything under it out of reach
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_project(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id AND deleted_at IS NULL)
    AND (
      public.has_permission('projects.read_all', 'app')
      OR (
        public.has_permission('projects.read', 'app')
        AND EXISTS (
          SELECT 1 FROM public.project_members
          WHERE project_id = p_project_id
            AND member_id = public.current_team_member_id()
        )
      )
    )
$$;

CREATE OR REPLACE FUNCTION public.can_access_lead(p_lead_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.leads WHERE id = p_lead_id AND deleted_at IS NULL)
    AND (
      public.has_permission('leads.read_all', 'app')
      OR (
        public.has_permission('leads.read', 'app')
        AND EXISTS (
          SELECT 1 FROM public.leads lead
          WHERE lead.id = p_lead_id
            AND (
              lead.assigned_to = public.current_team_member_id()
              OR EXISTS (
                SELECT 1 FROM public.lead_members assignment
                WHERE assignment.lead_id = lead.id
                  AND assignment.member_id = public.current_team_member_id()
              )
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
    WHERE id = p_task_id AND deleted_at IS NULL AND public.can_read_task_row(id, project_id, created_by)
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_credential(p_credential_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_credentials credential
    JOIN public.projects project ON project.id = credential.project_id
    WHERE credential.id = p_credential_id
      AND credential.deleted_at IS NULL
      AND project.deleted_at IS NULL
  )
  AND (
    public.has_permission('credentials.manage', 'app')
    OR (
      public.has_permission('credentials.reveal_shared', 'app')
      AND EXISTS (
        SELECT 1
        FROM public.project_credential_members grant_row
        JOIN public.project_credentials credential ON credential.id = grant_row.credential_id
        WHERE grant_row.credential_id = p_credential_id
          AND grant_row.member_id = public.current_team_member_id()
          AND public.can_access_project(credential.project_id)
      )
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_file_entity(p_entity_type text, p_entity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_entity_type
    WHEN 'project' THEN public.can_access_project(p_entity_id)
    WHEN 'lead' THEN public.can_access_lead(p_entity_id)
    WHEN 'contact' THEN
      EXISTS (SELECT 1 FROM public.contacts WHERE id = p_entity_id AND deleted_at IS NULL)
      AND (
        public.has_permission('contacts.read_all', 'app')
        OR (
          public.has_permission('contacts.read', 'app')
          AND EXISTS (
            SELECT 1 FROM public.project_contacts link
            WHERE link.contact_id = p_entity_id
              AND public.can_access_project(link.project_id)
          )
        )
      )
    ELSE false
  END
$$;

-- A reminder on a deleted task or project is gone with it, even for its owner.
CREATE OR REPLACE FUNCTION public.can_see_reminder(p_owner_id uuid, p_project_id uuid, p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (p_task_id IS NULL OR EXISTS (SELECT 1 FROM public.tasks WHERE id = p_task_id AND deleted_at IS NULL))
    AND (p_project_id IS NULL OR EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id AND deleted_at IS NULL))
    AND (
      p_owner_id = public.current_team_member_id()
      OR (p_task_id IS NOT NULL AND public.can_access_task(p_task_id))
      OR (p_task_id IS NULL AND p_project_id IS NOT NULL AND public.can_access_project(p_project_id))
    )
$$;

-- ---------------------------------------------------------------------------
-- 5. Children of a deleted parent are out of reach, whatever else allows them
-- ---------------------------------------------------------------------------
-- The helpers above cover policies that go through them; a few permissive
-- policies do not (a comment's author sees their own comment, for one). One
-- RESTRICTIVE "parent is live" policy per child table closes every such path.
-- Not covered on purpose: team member earnings (pay survives a deleted
-- project), email threads, triage and recipients (the inbox's own record),
-- and a lead whose linked contact was deleted.
CREATE OR REPLACE FUNCTION public.project_is_live(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id AND deleted_at IS NULL)
$$;

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
    WHERE task.id = p_task_id AND task.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.lead_is_live(p_lead_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.leads WHERE id = p_lead_id AND deleted_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION public.contact_is_live(p_contact_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.contacts WHERE id = p_contact_id AND deleted_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION public.credential_is_live(p_credential_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_credentials credential
    JOIN public.projects project ON project.id = credential.project_id
    WHERE credential.id = p_credential_id AND credential.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.portal_update_is_live(p_update_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.portal_updates update_row
    JOIN public.projects project ON project.id = update_row.project_id
    WHERE update_row.id = p_update_id AND update_row.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.file_entity_is_live(p_entity_type text, p_entity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_entity_type
    WHEN 'project' THEN public.project_is_live(p_entity_id)
    WHEN 'lead' THEN public.lead_is_live(p_entity_id)
    WHEN 'contact' THEN public.contact_is_live(p_entity_id)
    ELSE true
  END
$$;

DO $$
DECLARE
  rule record;
BEGIN
  FOR rule IN
    SELECT * FROM (VALUES
      ('tasks', 'public.project_is_live(project_id)'),
      ('project_time_entries', 'public.project_is_live(project_id)'),
      ('project_invoices', 'public.project_is_live(project_id)'),
      ('project_members', 'public.project_is_live(project_id)'),
      ('project_credentials', 'public.project_is_live(project_id)'),
      ('portal_settings', 'public.project_is_live(project_id)'),
      ('portal_updates', 'public.project_is_live(project_id)'),
      ('portal_events', 'public.project_is_live(project_id)'),
      ('client_communications', 'public.project_is_live(project_id)'),
      ('project_hourly_rates', 'public.project_is_live(project_id)'),
      ('project_retainers', 'public.project_is_live(project_id)'),
      ('project_billing_plans', 'public.project_is_live(project_id)'),
      ('project_billing_runs', 'public.project_is_live(project_id)'),
      ('project_budget_history', 'public.project_is_live(project_id)'),
      ('billing_draft_notices', 'public.project_is_live(project_id)'),
      ('project_context', 'public.project_is_live(project_id)'),
      ('project_goals', 'public.project_is_live(project_id)'),
      ('task_suggestions', 'public.project_is_live(project_id)'),
      ('email_client_addresses', 'public.project_is_live(project_id)'),
      ('email_client_domains', 'public.project_is_live(project_id)'),
      ('email_project_addresses', 'public.project_is_live(project_id)'),
      ('email_message_candidates', 'public.project_is_live(project_id)'),
      ('agent_activities', 'project_id IS NULL OR public.project_is_live(project_id)'),
      ('project_contacts', 'public.project_is_live(project_id) AND public.contact_is_live(contact_id)'),
      ('task_subtasks', 'public.task_is_live(task_id)'),
      ('task_comments', 'public.task_is_live(task_id)'),
      ('task_acceptance_criteria', 'public.task_is_live(task_id)'),
      ('task_assignees', 'public.task_is_live(task_id)'),
      ('task_dependencies', 'public.task_is_live(task_id)'),
      ('task_reviews', 'public.task_is_live(task_id)'),
      ('task_reopens', 'public.task_is_live(task_id)'),
      ('time_entry_tasks', 'public.task_is_live(task_id)'),
      ('email_task_links', 'public.task_is_live(task_id)'),
      ('reminders', '(task_id IS NULL OR public.task_is_live(task_id)) AND (project_id IS NULL OR public.project_is_live(project_id))'),
      ('lead_interactions', 'public.lead_is_live(lead_id)'),
      ('lead_proposals', 'public.lead_is_live(lead_id)'),
      ('lead_fields', 'public.lead_is_live(lead_id)'),
      ('lead_members', 'public.lead_is_live(lead_id)'),
      ('lead_contacts', 'public.lead_is_live(lead_id) AND public.contact_is_live(contact_id)'),
      ('contact_emails', 'public.contact_is_live(contact_id)'),
      ('project_credential_members', 'public.credential_is_live(credential_id)'),
      ('portal_update_attachments', 'public.portal_update_is_live(update_id)'),
      ('entity_files', 'public.file_entity_is_live(entity_type, entity_id)')
    ) AS rules(table_name, live_check)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', rule.table_name || '_parent_live', rule.table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (%s)',
      rule.table_name || '_parent_live', rule.table_name, rule.live_check);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Move to Trash and Restore
-- ---------------------------------------------------------------------------
-- The record types Trash handles, each with its parent (the row that must
-- still exist for it to be restored).
CREATE OR REPLACE FUNCTION public.trash_record_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'projects', 'tasks', 'task_subtasks', 'task_comments', 'reminders', 'project_credentials',
    'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads',
    'lead_interactions', 'lead_proposals', 'lead_fields'
  ]
$$;

-- Who may move a record to Trash (and restore it): the same people the old
-- DELETE policies let delete it. Reads the row whatever its deleted_at, and
-- checks project and lead membership directly, so a deleted parent does not
-- hide the answer for the parent itself.
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
    ELSE
      allowed := false;
  END CASE;
  RETURN coalesce(allowed, false);
END;
$$;

-- What must still exist before a record can come back from Trash, as a
-- sentence for the person restoring it; null when nothing blocks it.
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
BEGIN
  CASE p_table
    WHEN 'tasks' THEN
      SELECT p.deleted_at IS NOT NULL INTO project_gone
      FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE t.id = p_id;
    WHEN 'task_subtasks', 'task_comments' THEN
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
    WHEN 'project_credentials', 'portal_updates' THEN
      EXECUTE format('SELECT p.deleted_at IS NOT NULL FROM public.%I c
        JOIN public.projects p ON p.id = c.project_id WHERE c.id = $1', p_table)
      INTO project_gone USING p_id;
    WHEN 'portal_update_attachments' THEN
      SELECT u.deleted_at IS NOT NULL INTO parent_gone
      FROM public.portal_update_attachments a JOIN public.portal_updates u ON u.id = a.update_id WHERE a.id = p_id;
      IF parent_gone THEN
        RETURN 'Restore the portal update it belongs to first.';
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
  RETURN NULL;
END;
$$;

-- Move a record to Trash. Signed-in members need the record's delete
-- permission; server routes (service role) check permissions themselves and
-- pass the acting member. Returns false when the record is already in Trash.
CREATE OR REPLACE FUNCTION public.soft_delete_record(p_table text, p_id uuid, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
  actor uuid;
  changed integer;
  found_row boolean;
BEGIN
  IF NOT p_table = ANY (public.trash_record_types()) THEN
    RAISE EXCEPTION 'Trash does not handle %', p_table USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1)', p_table) INTO found_row USING p_id;
  IF NOT found_row THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  IF is_service THEN
    actor := p_actor;
  ELSE
    IF NOT public.can_trash_record(p_table, p_id) THEN
      RAISE EXCEPTION 'You do not have permission to delete this' USING ERRCODE = '42501';
    END IF;
    actor := public.current_team_member_id();
  END IF;
  EXECUTE format('UPDATE public.%I SET deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL', p_table)
    USING actor, p_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END;
$$;

-- Bring a record back from Trash, exactly as it was. Refuses while the row it
-- belongs to is still in Trash, saying which to restore first.
CREATE OR REPLACE FUNCTION public.restore_record(p_table text, p_id uuid, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
  blocker text;
  changed integer;
  found_row boolean;
BEGIN
  IF NOT p_table = ANY (public.trash_record_types()) THEN
    RAISE EXCEPTION 'Trash does not handle %', p_table USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1)', p_table) INTO found_row USING p_id;
  IF NOT found_row THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  blocker := public.trash_restore_blocker(p_table, p_id);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', blocker USING ERRCODE = '55000';
  END IF;
  IF NOT is_service AND NOT public.can_trash_record(p_table, p_id) THEN
    RAISE EXCEPTION 'You do not have permission to restore this' USING ERRCODE = '42501';
  END IF;
  EXECUTE format('UPDATE public.%I SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL', p_table)
    USING p_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.project_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.task_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lead_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.contact_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.credential_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_update_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.file_entity_is_live(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.task_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lead_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.contact_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.credential_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.portal_update_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.file_entity_is_live(text, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.forbid_hard_delete() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trash_record_types() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_trash_record(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trash_restore_blocker(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.soft_delete_record(text, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_record(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trash_record_types() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_trash_record(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trash_restore_blocker(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_record(text, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.restore_record(text, uuid, uuid) TO authenticated, service_role;
