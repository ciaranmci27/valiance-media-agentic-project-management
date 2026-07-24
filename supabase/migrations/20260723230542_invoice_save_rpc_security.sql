BEGIN;

CREATE OR REPLACE FUNCTION public.save_project_invoice_with_allocations(
  p_invoice_id uuid,
  p_invoice jsonb,
  p_allocations jsonb
)
RETURNS public.project_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_invoice public.project_invoices;
  saved public.project_invoices;
  target_project_id uuid;
BEGIN
  p_invoice := COALESCE(p_invoice, '{}'::jsonb);

  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    IF NOT public.has_permission('invoices.manage', 'app') THEN
      RAISE EXCEPTION 'Missing permission to manage invoices';
    END IF;
  END IF;

  IF p_invoice_id IS NULL THEN
    target_project_id := (p_invoice->>'project_id')::uuid;
    IF target_project_id IS NULL THEN
      RAISE EXCEPTION 'Invoice project is required';
    END IF;
    IF COALESCE(auth.role(), '') <> 'service_role'
      AND NOT public.can_access_project(target_project_id) THEN
      RAISE EXCEPTION 'Project access denied';
    END IF;

    INSERT INTO public.project_invoices (
      project_id, invoice_number, amount, status, invoice_type, line_items,
      date, due_date, paid_date, description, file_url, file_name, file_size,
      mime_type, created_by
    ) VALUES (
      target_project_id,
      p_invoice->>'invoice_number',
      COALESCE((p_invoice->>'amount')::numeric, 0),
      COALESCE(p_invoice->>'status', 'draft'),
      COALESCE(p_invoice->>'invoice_type', 'hourly'),
      COALESCE(NULLIF(p_invoice->'line_items', 'null'::jsonb), '[]'::jsonb),
      p_invoice->>'date',
      p_invoice->>'due_date',
      p_invoice->>'paid_date',
      COALESCE(p_invoice->>'description', ''),
      p_invoice->>'file_url',
      p_invoice->>'file_name',
      (p_invoice->>'file_size')::bigint,
      p_invoice->>'mime_type',
      (p_invoice->>'created_by')::uuid
    )
    RETURNING * INTO saved;
  ELSE
    SELECT * INTO existing_invoice
    FROM public.project_invoices
    WHERE id = p_invoice_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice not found';
    END IF;

    target_project_id := CASE
      WHEN p_invoice ? 'project_id' THEN (p_invoice->>'project_id')::uuid
      ELSE existing_invoice.project_id
    END;
    IF target_project_id IS NULL THEN
      RAISE EXCEPTION 'Invoice project is required';
    END IF;
    IF COALESCE(auth.role(), '') <> 'service_role'
      AND (
        NOT public.can_access_project(existing_invoice.project_id)
        OR NOT public.can_access_project(target_project_id)
      ) THEN
      RAISE EXCEPTION 'Project access denied';
    END IF;

    UPDATE public.project_invoices invoice
    SET
      project_id = CASE WHEN p_invoice ? 'project_id' THEN target_project_id ELSE invoice.project_id END,
      invoice_number = CASE WHEN p_invoice ? 'invoice_number' THEN p_invoice->>'invoice_number' ELSE invoice.invoice_number END,
      amount = CASE WHEN p_invoice ? 'amount' THEN (p_invoice->>'amount')::numeric ELSE invoice.amount END,
      status = CASE WHEN p_invoice ? 'status' THEN p_invoice->>'status' ELSE invoice.status END,
      invoice_type = CASE WHEN p_invoice ? 'invoice_type' THEN p_invoice->>'invoice_type' ELSE invoice.invoice_type END,
      line_items = CASE WHEN p_invoice ? 'line_items' THEN COALESCE(NULLIF(p_invoice->'line_items', 'null'::jsonb), '[]'::jsonb) ELSE invoice.line_items END,
      date = CASE WHEN p_invoice ? 'date' THEN p_invoice->>'date' ELSE invoice.date END,
      due_date = CASE WHEN p_invoice ? 'due_date' THEN p_invoice->>'due_date' ELSE invoice.due_date END,
      paid_date = CASE WHEN p_invoice ? 'paid_date' THEN p_invoice->>'paid_date' ELSE invoice.paid_date END,
      description = CASE WHEN p_invoice ? 'description' THEN COALESCE(p_invoice->>'description', '') ELSE invoice.description END,
      file_url = CASE WHEN p_invoice ? 'file_url' THEN p_invoice->>'file_url' ELSE invoice.file_url END,
      file_name = CASE WHEN p_invoice ? 'file_name' THEN p_invoice->>'file_name' ELSE invoice.file_name END,
      file_size = CASE WHEN p_invoice ? 'file_size' THEN (p_invoice->>'file_size')::bigint ELSE invoice.file_size END,
      mime_type = CASE WHEN p_invoice ? 'mime_type' THEN p_invoice->>'mime_type' ELSE invoice.mime_type END,
      created_by = CASE WHEN p_invoice ? 'created_by' THEN (p_invoice->>'created_by')::uuid ELSE invoice.created_by END
    WHERE invoice.id = p_invoice_id
    RETURNING * INTO saved;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice not found';
    END IF;
  END IF;

  IF p_allocations IS NOT NULL THEN
    DELETE FROM public.invoice_time_entry_allocations
    WHERE invoice_id = saved.id;

    INSERT INTO public.invoice_time_entry_allocations (
      invoice_id, line_item_id, time_entry_id, start_offset_hours,
      allocated_hours, allocated_amount
    )
    SELECT
      saved.id,
      allocation.line_item_id,
      allocation.time_entry_id,
      allocation.start_offset_hours,
      allocation.allocated_hours,
      allocation.allocated_amount
    FROM jsonb_to_recordset(COALESCE(p_allocations, '[]'::jsonb)) AS allocation(
      line_item_id text,
      time_entry_id uuid,
      start_offset_hours numeric,
      allocated_hours numeric,
      allocated_amount numeric
    );
  END IF;

  PERFORM public.validate_invoice_time_allocations(saved.id);
  RETURN saved;
END;
$$;

REVOKE ALL ON FUNCTION public.save_project_invoice_with_allocations(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_project_invoice_with_allocations(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_project_invoice_with_allocations(uuid, jsonb, jsonb) TO service_role;

ALTER TABLE public.client_communications
  DROP CONSTRAINT IF EXISTS client_communications_notification_type_check;

ALTER TABLE public.client_communications
  ADD CONSTRAINT client_communications_notification_type_check
  CHECK (notification_type IN (
    'portal_welcome',
    'project_summary',
    'invoice',
    'budget_threshold',
    'dollar_interval',
    'budget_extended'
  ));

COMMIT;
