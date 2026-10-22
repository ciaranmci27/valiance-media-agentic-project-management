-- Soft delete: a lead's field keys are unique among live fields only.
--
-- The unique key on (lead_id, field_key) counted fields in Trash, so setting
-- a field again after moving it to Trash collided with the trashed row, which
-- a signed-in member cannot see or change. Like the billing keys, it now holds
-- among live fields: setting the field again makes a new one, and the
-- trashed one can only come back while no live field has its key.
--
-- Safe to re-run.

DO $$
DECLARE
  key_name text;
BEGIN
  SELECT conname INTO key_name FROM pg_constraint
  WHERE conrelid = 'public.lead_fields'::regclass AND contype = 'u'
    AND (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute
         WHERE attrelid = conrelid AND attnum = ANY (conkey)) = ARRAY['field_key', 'lead_id'];
  IF key_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.lead_fields DROP CONSTRAINT %I', key_name);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS lead_fields_live_key
  ON public.lead_fields (lead_id, field_key) WHERE deleted_at IS NULL;

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
