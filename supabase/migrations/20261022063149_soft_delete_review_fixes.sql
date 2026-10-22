-- Soft delete, review fixes.
--
-- - Signed-in reads may check deleted_at on projects and time entries (the
--   column grants left it out, so converting a lead and approving agent
--   suggestions failed). Already run by hand as a hotfix.
-- - Moving a rejected time entry to Trash no longer resubmits it.
-- - Converting a lead never makes a contact in Trash the client, and a new
--   primary client replaces one whose contact is in Trash.
-- - Trash audit rows leave out credential secrets and money columns.
-- - Restoring a retainer or its project skips the months spent in Trash.
-- - The Trash list says when an invoice cannot come back (hours or retainer
--   period billed again, time in Trash, unlinked paid hours).
-- - trash_events pings live sync, so other open screens see Trash moves.
--
-- Safe to re-run.

GRANT SELECT (deleted_at, deleted_by) ON public.projects, public.project_time_entries TO authenticated;

CREATE OR REPLACE FUNCTION public.apply_time_entry_compensation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member_role text;
BEGIN
  -- Moving it to Trash or back is not an edit: nothing to resubmit or reprice.
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NEW;
  END IF;
  SELECT role INTO member_role FROM public.team_members WHERE id = NEW.member_id;

  IF TG_OP = 'INSERT' OR NEW.start_time IS DISTINCT FROM OLD.start_time OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    -- The lock guards entries with real compensation behind them. Owner
    -- entries are born approved with rate 0 (no reviewer above the owner, no
    -- hourly pay), so without the role exemption every owner edit was an
    -- edit to an approved entry and the lock fired on the one person it
    -- protects nothing from (20260812_owner_time_entries_stay_editable).
    IF TG_OP = 'UPDATE' AND OLD.approval_status = 'approved' AND member_role <> 'owner' THEN
      RAISE EXCEPTION 'Approved time entry compensation is locked';
    END IF;
    IF member_role = 'owner' THEN
      -- Owners have no hourly compensation to resolve or to lock.
      NEW.compensation_rate := 0;
    ELSE
      NEW.compensation_rate := public.resolve_team_member_hourly_rate(NEW.member_id, NEW.start_time);
    END IF;
  END IF;

  IF NEW.end_time IS NULL THEN
    NEW.approval_status := 'draft';
    NEW.submitted_at := NULL;
    NEW.approved_at := NULL;
    NEW.approved_by := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.end_time IS NULL THEN
    NEW.submitted_at := now();
    IF member_role = 'owner' THEN
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := NEW.member_id;
      NEW.compensation_rate := 0;
    ELSIF member_role <> 'agent'
      AND COALESCE((SELECT auto_approve_human_hours FROM public.business_settings LIMIT 1), true) THEN
      -- Auto-approved by workspace policy; approved_by NULL marks it as
      -- system-approved rather than reviewed by a person.
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := NULL;
    ELSE
      NEW.approval_status := 'pending';
      NEW.approved_at := NULL;
      NEW.approved_by := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.approval_status = 'rejected' AND member_role <> 'owner'
    AND NEW.approval_status = OLD.approval_status THEN
    -- A content edit to a rejected entry resubmits it for review. A review
    -- decision (approval_status changed by review_time_entries) passes
    -- through untouched.
    NEW.approval_status := 'pending';
    NEW.submitted_at := now();
    NEW.approved_at := NULL;
    NEW.approved_by := NULL;
    NEW.rejection_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;

create or replace function public.convert_lead(
  p_lead_id uuid,
  p_project_name text,
  p_project_color text,
  p_project_description text,
  p_created_by uuid
) returns jsonb
language plpgsql
as $$
declare
  v_lead public.leads%rowtype;
  v_contact_id uuid;
  v_project_id uuid;
begin
  select * into v_lead from public.leads where id = p_lead_id and deleted_at is null for update;
  if not found then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  if v_lead.status = 'won' then
    -- Custom errcode so the API can map this to 409 without colliding with
    -- P0001, the default code every unqualified `raise exception` uses
    raise exception 'Lead has already been converted' using errcode = 'LC409';
  end if;

  -- Reuse the lead's contact unless it is in Trash, otherwise create one
  select c.id into v_contact_id from public.contacts c
  where c.id = v_lead.contact_id and c.deleted_at is null;
  if v_contact_id is null then
    insert into public.contacts (name, email, phone, company, color, created_by)
    values (v_lead.name, v_lead.email, v_lead.phone, v_lead.company, p_project_color, p_created_by)
    returning id into v_contact_id;
  end if;

  insert into public.projects (name, description, color, status, created_by)
  values (p_project_name, p_project_description, p_project_color, 'active', p_created_by)
  returning id into v_project_id;

  -- Primary client
  insert into public.project_contacts (project_id, contact_id, role, is_primary_client)
  values (v_project_id, v_contact_id, 'Client', true);

  -- Copy additional (non-primary) lead contacts
  insert into public.project_contacts (project_id, contact_id, role, custom_role, is_primary_client)
  select v_project_id, lc.contact_id, lc.role, lc.custom_role, false
  from public.lead_contacts lc
  join public.contacts c on c.id = lc.contact_id and c.deleted_at is null
  where lc.lead_id = p_lead_id and lc.is_primary_client = false
  on conflict (project_id, contact_id) do nothing;

  -- Copy lead members to project members
  insert into public.project_members (project_id, member_id)
  select v_project_id, lm.member_id
  from public.lead_members lm
  where lm.lead_id = p_lead_id
  on conflict (project_id, member_id) do nothing;

  update public.leads set status = 'won', contact_id = v_contact_id where id = p_lead_id;

  return jsonb_build_object('project_id', v_project_id, 'contact_id', v_contact_id);
end;
$$;

-- A contact in Trash keeps its project and lead links (so a restore brings
-- them back), but it must not hold the one primary client slot: setting a
-- new primary client lets go of a trashed one, which the person setting it
-- cannot see.
CREATE OR REPLACE FUNCTION public.release_trashed_primary_client()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_primary_client THEN
    IF TG_TABLE_NAME = 'project_contacts' THEN
      UPDATE public.project_contacts link
      SET is_primary_client = false
      FROM public.contacts contact
      WHERE link.project_id = NEW.project_id AND link.id <> NEW.id AND link.is_primary_client
        AND contact.id = link.contact_id AND contact.deleted_at IS NOT NULL;
    ELSE
      UPDATE public.lead_contacts link
      SET is_primary_client = false
      FROM public.contacts contact
      WHERE link.lead_id = NEW.lead_id AND link.id <> NEW.id AND link.is_primary_client
        AND contact.id = link.contact_id AND contact.deleted_at IS NOT NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS release_trashed_primary_client ON public.project_contacts;
DROP TRIGGER IF EXISTS release_trashed_primary_client ON public.lead_contacts;
CREATE TRIGGER release_trashed_primary_client
  BEFORE INSERT OR UPDATE OF is_primary_client ON public.project_contacts
  FOR EACH ROW EXECUTE FUNCTION public.release_trashed_primary_client();
CREATE TRIGGER release_trashed_primary_client
  BEFORE INSERT OR UPDATE OF is_primary_client ON public.lead_contacts
  FOR EACH ROW EXECUTE FUNCTION public.release_trashed_primary_client();

CREATE OR REPLACE FUNCTION public.audit_trash_change(
  p_table text, p_id uuid, p_restore boolean, p_before jsonb, p_after jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  hidden text[] := ARRAY['encrypted_data', 'iv', 'hourly_rate', 'compensation_rate', 'billing_multiplier',
    'budget_type', 'budget_value', 'billing_address', 'billing_email', 'tax_rate', 'invoice_pdf_options'];
BEGIN
  INSERT INTO public.api_audit_log (
    method, endpoint, entity_type, entity_id, team_member_id, before_snapshot, after_snapshot, status_code, via
  ) VALUES (
    CASE WHEN p_restore THEN 'POST' ELSE 'DELETE' END,
    '/app/trash/' || p_table || '/' || p_id::text || CASE WHEN p_restore THEN '/restore' ELSE '' END,
    public.trash_entity_type(p_table), p_id, public.current_team_member_id(),
    -- Not the credential secrets, client rates or pay rates: audit readers
    -- are not necessarily allowed to see those.
    p_before - hidden, p_after - hidden, 200, 'app'
  );
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
  -- Retainer months that came due while it (or its project) was in Trash
  -- are skipped, as a pause skips them: restoring never back-bills.
  IF changed > 0 AND p_table IN ('projects', 'project_retainers') THEN
    INSERT INTO public.project_retainer_periods (retainer_id, period_start, period_end, status)
    SELECT due.retainer_id, due.period_start, due.period_end, 'skipped'
    FROM public.retainer_due_periods_internal(
      CASE WHEN p_table = 'projects' THEN p_id ELSE (after->>'project_id')::uuid END,
      public.workspace_today()) due
    WHERE (p_table = 'projects' OR due.retainer_id = p_id)
      AND due.bill_date >= ((before->>'deleted_at')::timestamptz AT TIME ZONE public.workspace_timezone())::date
    ON CONFLICT (retainer_id, period_start) DO NOTHING;
  END IF;
  RETURN changed > 0;
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

-- Trash moves and restores, as pings for live sync. A soft delete is an
-- UPDATE that the viewer can no longer see, so it never reaches other open
-- screens through the table itself; this row does. Only the table and id.
CREATE TABLE IF NOT EXISTS public.trash_events (
  id bigserial PRIMARY KEY,
  table_name text NOT NULL,
  record_id uuid NOT NULL,
  restored boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trash_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trash_events_select ON public.trash_events;
CREATE POLICY trash_events_select ON public.trash_events FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.trash_events FROM anon, authenticated;
GRANT SELECT ON public.trash_events TO authenticated;
GRANT ALL ON public.trash_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_trash_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.trash_events (table_name, record_id, restored)
  VALUES (TG_TABLE_NAME, NEW.id, NEW.deleted_at IS NULL);
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'tasks', 'task_subtasks', 'task_comments', 'reminders', 'project_credentials', 'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads', 'lead_interactions', 'lead_proposals', 'lead_fields', 'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates', 'project_retainers', 'project_retainer_amounts'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS record_trash_event ON public.%I', t);
    EXECUTE format('CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.%I
      FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
      EXECUTE FUNCTION public.record_trash_event()', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'trash_events') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trash_events;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.release_trashed_primary_client() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_trash_event() FROM PUBLIC, anon, authenticated;

-- The next free invoice number for the invoice form. A number on an invoice in
-- Trash stays taken (a restore brings the invoice back with it), and the
-- person adding an invoice cannot see those, so the database suggests it.
CREATE OR REPLACE FUNCTION public.suggest_project_invoice_number(p_project_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_permission('invoices.manage') AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'You cannot add invoices to this project' USING ERRCODE = '42501';
  END IF;
  RETURN public.next_project_invoice_number(p_project_id);
END;
$$;

REVOKE ALL ON FUNCTION public.suggest_project_invoice_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggest_project_invoice_number(uuid) TO authenticated;
