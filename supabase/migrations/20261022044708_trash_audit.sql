-- Soft delete audit: who moved what to Trash, and who brought it back.
--
-- A Trash move or restore by a signed-in member (the app) now writes an
-- audit row itself, with the record as it was before and after, marked
-- via 'app'. Server routes on the service role (the API, MCP) log their own
-- rows with the API key, as before. A restore clears deleted_by, so this row
-- is what keeps who deleted it. Also: a blocker in Trash blocks nothing.
--
-- Safe to re-run.

ALTER TABLE public.api_audit_log DROP CONSTRAINT IF EXISTS api_audit_log_via_check;
ALTER TABLE public.api_audit_log ADD CONSTRAINT api_audit_log_via_check CHECK (via IN ('rest', 'mcp', 'app'));

-- The audit log's name for a record type (the same names the API logs).
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

-- One audit row for a Trash move or restore by a signed-in member (the app).
-- Server routes on the service role log their own, with the API key.
CREATE OR REPLACE FUNCTION public.audit_trash_change(
  p_table text, p_id uuid, p_restore boolean, p_before jsonb, p_after jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.api_audit_log (
    method, endpoint, entity_type, entity_id, team_member_id, before_snapshot, after_snapshot, status_code, via
  ) VALUES (
    CASE WHEN p_restore THEN 'POST' ELSE 'DELETE' END,
    '/app/trash/' || p_table || '/' || p_id::text || CASE WHEN p_restore THEN '/restore' ELSE '' END,
    public.trash_entity_type(p_table), p_id, public.current_team_member_id(), p_before, p_after, 200, 'app'
  );
END;
$$;

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
  before jsonb;
  after jsonb;
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
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id = $1', p_table) INTO before USING p_id;
  EXECUTE format('UPDATE public.%I t SET deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING to_jsonb(t)', p_table)
    INTO after USING actor, p_id;
  changed := CASE WHEN after IS NULL THEN 0 ELSE 1 END;
  IF changed > 0 AND NOT is_service THEN
    PERFORM public.audit_trash_change(p_table, p_id, false, before, after);
  END IF;
  RETURN changed > 0;
END;
$$;

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
  before jsonb;
  after jsonb;
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
  -- Restoring re-runs the record's own rules (an invoice links its hours
  -- and retainer period again); a clash with what happened meanwhile
  -- refuses it, saying why.
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id = $1', p_table) INTO before USING p_id;
  BEGIN
    EXECUTE format('UPDATE public.%I t SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING to_jsonb(t)', p_table)
      INTO after USING p_id;
    changed := CASE WHEN after IS NULL THEN 0 ELSE 1 END;
  EXCEPTION WHEN raise_exception THEN
    RAISE EXCEPTION 'It cannot come back as it was: %', SQLERRM USING ERRCODE = '55000';
  END;
  IF changed > 0 AND NOT is_service THEN
    PERFORM public.audit_trash_change(p_table, p_id, true, before, after);
  END IF;
  RETURN changed > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.trash_entity_type(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.audit_trash_change(text, uuid, boolean, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trash_entity_type(text) TO authenticated, service_role;

-- A blocker in Trash blocks nothing, as deleting it used to remove the
-- dependency (restoring it blocks again).
DROP POLICY IF EXISTS task_dependencies_parent_live ON public.task_dependencies;
CREATE POLICY task_dependencies_parent_live ON public.task_dependencies AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id) AND public.task_is_live(blocked_by_task_id));
