-- Scheduled project rates, immutable per-session rate snapshots, and a
-- lightweight relational record of the time represented by hourly invoice
-- line items. Payments remain represented by the existing invoice status.

-- Run atomically. A lock or validation failure rolls back every statement.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE public.project_hourly_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  hourly_rate numeric(10,2) NOT NULL CHECK (hourly_rate >= 0),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, effective_at)
);

-- Seed the current project rate as the initial schedule entry. Project creation
-- predates every legitimate time session for that project.
INSERT INTO public.project_hourly_rates (project_id, hourly_rate, effective_at)
SELECT id, hourly_rate, created_at
FROM public.projects
WHERE hourly_tracking = true AND hourly_rate IS NOT NULL;

ALTER TABLE public.project_time_entries
  ADD COLUMN hourly_rate numeric(10,2) NOT NULL DEFAULT 0
    CHECK (hourly_rate >= 0);

UPDATE public.project_time_entries AS entry
SET hourly_rate = COALESCE(project.hourly_rate, 0)
FROM public.projects AS project
WHERE project.id = entry.project_id;

CREATE TABLE public.invoice_time_entry_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.project_invoices(id) ON DELETE CASCADE,
  line_item_id text NOT NULL,
  time_entry_id uuid NOT NULL REFERENCES public.project_time_entries(id) ON DELETE RESTRICT,
  start_offset_hours numeric(14,6) NOT NULL DEFAULT 0 CHECK (start_offset_hours >= 0),
  allocated_hours numeric(14,6) NOT NULL CHECK (allocated_hours > 0),
  allocated_amount numeric(12,2) NOT NULL CHECK (allocated_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, line_item_id, time_entry_id)
);

CREATE INDEX idx_project_hourly_rates_lookup
  ON public.project_hourly_rates (project_id, effective_at DESC);
CREATE INDEX idx_invoice_time_allocations_invoice
  ON public.invoice_time_entry_allocations (invoice_id);
CREATE INDEX idx_invoice_time_allocations_entry
  ON public.invoice_time_entry_allocations (time_entry_id);

CREATE TRIGGER set_project_hourly_rates_updated_at
  BEFORE UPDATE ON public.project_hourly_rates
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.project_hourly_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_time_entry_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_hourly_rates_all" ON public.project_hourly_rates
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "invoice_time_entry_allocations_all" ON public.invoice_time_entry_allocations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Once time is represented on an invoice, its billing facts must not silently
-- change underneath that invoice. Description/member edits remain allowed.
CREATE OR REPLACE FUNCTION public.protect_invoiced_time_entry()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.invoice_time_entry_allocations allocation
    WHERE allocation.time_entry_id = OLD.id
  ) AND (
    NEW.start_time IS DISTINCT FROM OLD.start_time OR
    NEW.end_time IS DISTINCT FROM OLD.end_time OR
    NEW.segments IS DISTINCT FROM OLD.segments OR
    NEW.hourly_rate IS DISTINCT FROM OLD.hourly_rate
  ) THEN
    RAISE EXCEPTION 'Invoiced time entry billing details are locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_invoiced_time_entry
  BEFORE UPDATE ON public.project_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.protect_invoiced_time_entry();

-- Validate that invoice allocations reference real hourly lines and finalized
-- sessions, remain within the tracked hours, and reconcile exactly to cents.
CREATE OR REPLACE FUNCTION public.validate_invoice_time_allocations(target_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_invoices invoice ON invoice.id = allocation.invoice_id
    LEFT JOIN LATERAL jsonb_array_elements(invoice.line_items) line_item
      ON line_item->>'id' = allocation.line_item_id
    WHERE allocation.invoice_id = target_invoice_id
      AND (line_item IS NULL OR line_item->>'item_type' IS DISTINCT FROM 'hourly')
  ) THEN
    RAISE EXCEPTION 'Invoice allocation points to a missing or non-hourly line item';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_invoices invoice ON invoice.id = allocation.invoice_id
    LEFT JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND (
        entry.id IS NULL
        OR entry.project_id IS DISTINCT FROM invoice.project_id
        OR entry.end_time IS NULL
        OR entry.hourly_rate <= 0
      )
  ) THEN
    RAISE EXCEPTION 'Invoice allocation points to an invalid time session';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN jsonb_array_length(COALESCE(entry.segments, '[]'::jsonb)) > 0 THEN
          COALESCE(SUM(
            EXTRACT(EPOCH FROM ((segment->>'end')::timestamptz - (segment->>'start')::timestamptz)) / 3600
          ) FILTER (WHERE segment->>'end' IS NOT NULL), 0)
        ELSE EXTRACT(EPOCH FROM (entry.end_time - entry.start_time)) / 3600
      END AS worked_hours
      FROM jsonb_array_elements(COALESCE(entry.segments, '[]'::jsonb)) segment
    ) worked
    WHERE allocation.invoice_id = target_invoice_id
      AND allocation.start_offset_hours + allocation.allocated_hours > worked.worked_hours + 0.0000011
  ) THEN
    RAISE EXCEPTION 'Invoice allocation extends beyond its tracked session';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND ABS(
        ROUND(allocation.allocated_hours * entry.hourly_rate, 2)
        - allocation.allocated_amount
      ) > 0.01
  ) THEN
    RAISE EXCEPTION 'Invoice allocation amount disagrees with its session rate';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations left_allocation
    JOIN public.invoice_time_entry_allocations right_allocation
      ON right_allocation.invoice_id = left_allocation.invoice_id
      AND right_allocation.time_entry_id = left_allocation.time_entry_id
      AND right_allocation.id > left_allocation.id
    WHERE left_allocation.invoice_id = target_invoice_id
      AND numrange(
        left_allocation.start_offset_hours,
        left_allocation.start_offset_hours + left_allocation.allocated_hours,
        '[)'
      ) && numrange(
        right_allocation.start_offset_hours,
        right_allocation.start_offset_hours + right_allocation.allocated_hours,
        '[)'
      )
  ) THEN
    RAISE EXCEPTION 'A time session is billed more than once on the same invoice';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.project_invoices invoice
    CROSS JOIN LATERAL jsonb_array_elements(invoice.line_items) line_item
    JOIN (
      SELECT line_item_id, SUM(allocated_amount) AS allocated_amount
      FROM public.invoice_time_entry_allocations
      WHERE invoice_id = target_invoice_id
      GROUP BY line_item_id
    ) totals ON totals.line_item_id = line_item->>'id'
    WHERE invoice.id = target_invoice_id
      AND totals.allocated_amount IS DISTINCT FROM ROUND((line_item->>'amount')::numeric, 2)
  ) THEN
    RAISE EXCEPTION 'Hourly allocation totals do not match the invoice line amount';
  END IF;
END;
$$;

-- Save an invoice and its exact time-session allocations in one transaction.
-- Passing NULL allocations preserves existing mappings for status-only edits.
CREATE OR REPLACE FUNCTION public.save_project_invoice_with_allocations(
  p_invoice_id uuid,
  p_invoice jsonb,
  p_allocations jsonb
)
RETURNS public.project_invoices
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  saved public.project_invoices;
BEGIN
  IF p_invoice_id IS NULL THEN
    INSERT INTO public.project_invoices (
      project_id, invoice_number, amount, status, invoice_type, line_items,
      date, due_date, paid_date, description, file_url, file_name, file_size,
      mime_type, created_by
    ) VALUES (
      (p_invoice->>'project_id')::uuid,
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
    UPDATE public.project_invoices invoice
    SET
      project_id = CASE WHEN p_invoice ? 'project_id' THEN (p_invoice->>'project_id')::uuid ELSE invoice.project_id END,
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

REVOKE ALL ON FUNCTION public.validate_invoice_time_allocations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_project_invoice_with_allocations(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_project_invoice_with_allocations(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_project_invoice_with_allocations(uuid, jsonb, jsonb) TO service_role;

-- Abort and roll back if the legacy-rate backfill did not preserve the exact
-- project-rate behavior used before this migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.project_time_entries entry
    JOIN public.projects project ON project.id = entry.project_id
    WHERE entry.hourly_rate IS DISTINCT FROM COALESCE(project.hourly_rate, 0)
  ) THEN
    RAISE EXCEPTION 'Time-entry hourly-rate backfill validation failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.projects project
    WHERE project.hourly_tracking = true
      AND project.hourly_rate IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.project_hourly_rates rate
        WHERE rate.project_id = project.id
      )
  ) THEN
    RAISE EXCEPTION 'Project hourly-rate schedule backfill validation failed';
  END IF;
END;
$$;

COMMIT;
