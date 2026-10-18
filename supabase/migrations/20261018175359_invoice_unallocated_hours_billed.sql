-- An hourly line with no session allocations on a live invoice still counts
-- as billed (autonomous invoice drafting, hardening).
--
-- Typing over a tracked hours line's amount detaches it from its sessions (on
-- purpose: the person decided the amount). Since 20261018172146 a draft or
-- sent invoice holds only its ALLOCATED slices, so a detached line held
-- nothing and a scheduled draft could bill the same hours again. Now its
-- dollars join the FIFO pool, exactly as an unallocated line on a paid
-- invoice always did. lib/invoice-utils.ts (billedHourlyPool) does the same.
--
-- Apply after 20261018173052_project_billing_plans, before the app deploy.

-- Paid hourly dollars, plus hourly lines on draft, sent or overdue invoices
-- that no session allocation backs.
CREATE OR REPLACE FUNCTION public.invoice_billed_hourly_pool(p_project_id uuid, p_exclude_invoice_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.invoice_paid_hourly_pool(p_project_id, p_exclude_invoice_id) + COALESCE((
    SELECT sum(CASE
      WHEN jsonb_array_length(COALESCE(invoice.line_items, '[]'::jsonb)) = 0 THEN
        CASE WHEN invoice.invoice_type = 'hourly'
              AND NOT EXISTS (SELECT 1 FROM public.invoice_time_entry_allocations a WHERE a.invoice_id = invoice.id)
             THEN invoice.amount ELSE 0 END
      ELSE (
        SELECT COALESCE(sum(COALESCE(NULLIF(line->>'amount', '')::numeric, 0)), 0)
        FROM jsonb_array_elements(invoice.line_items) line
        WHERE line->>'item_type' = 'hourly'
          AND NOT EXISTS (
            SELECT 1 FROM public.invoice_time_entry_allocations a
            WHERE a.invoice_id = invoice.id AND a.line_item_id = line->>'id'
          )
      )
    END)
    FROM public.project_invoices invoice
    WHERE invoice.project_id = p_project_id
      AND invoice.status IN ('draft', 'sent', 'overdue')
      AND invoice.id IS DISTINCT FROM p_exclude_invoice_id
  ), 0)
$$;

CREATE OR REPLACE FUNCTION public.invoice_unbilled_slices(p_project_id uuid, p_exclude_invoice_id uuid DEFAULT NULL)
RETURNS TABLE (
  time_entry_id uuid,
  start_time timestamptz,
  end_time timestamptz,
  rate numeric,
  start_offset_hours numeric,
  hours numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  money_eps CONSTANT numeric := 0.005000001;
  hours_eps CONSTANT numeric := 0.000050001;
  pool numeric := public.invoice_billed_hourly_pool(p_project_id, p_exclude_invoice_id);
  entry record;
  worked numeric;
  cost numeric;
  portion_start numeric;
  free nummultirange;
  piece numrange;
BEGIN
  FOR entry IN
    SELECT e.id, e.start_time, e.end_time, e.hourly_rate, e.segments
    FROM public.project_time_entries e
    WHERE e.project_id = p_project_id
      AND e.end_time IS NOT NULL
      AND e.work_type <> 'internal'
      AND e.approval_status = 'approved'
    ORDER BY e.start_time, e.id
  LOOP
    IF entry.hourly_rate IS NULL OR entry.hourly_rate <= 0 THEN CONTINUE; END IF;
    worked := public.time_entry_worked_hours(entry.segments, entry.start_time, entry.end_time);
    cost := worked * entry.hourly_rate;
    IF cost <= money_eps THEN CONTINUE; END IF;

    IF pool + money_eps >= cost THEN
      pool := CASE WHEN pool - cost > money_eps THEN pool - cost ELSE 0 END;
      CONTINUE;
    END IF;
    IF pool > money_eps THEN
      IF cost - pool <= money_eps THEN pool := 0; CONTINUE; END IF;
      portion_start := pool / entry.hourly_rate;
      pool := 0;
    ELSE
      portion_start := 0;
    END IF;

    free := nummultirange(numrange(portion_start, worked, '[)')) - COALESCE((
      SELECT range_agg(numrange(a.start_offset_hours, a.start_offset_hours + a.allocated_hours, '[)'))
      FROM public.invoice_time_entry_allocations a
      JOIN public.project_invoices i ON i.id = a.invoice_id
      WHERE a.time_entry_id = entry.id
        AND i.status IN ('draft', 'sent', 'overdue')
        AND i.id IS DISTINCT FROM p_exclude_invoice_id
    ), '{}'::nummultirange);

    -- An invoice line holds one allocation per session, so a session split
    -- by a held piece in its middle offers its first free piece now and the
    -- rest to the next invoice (the browser walk does the same).
    FOR piece IN SELECT p FROM unnest(free) p ORDER BY lower(p) LOOP
      IF upper(piece) - lower(piece) > hours_eps THEN
        time_entry_id := entry.id;
        start_time := entry.start_time;
        end_time := entry.end_time;
        rate := entry.hourly_rate;
        start_offset_hours := lower(piece);
        hours := upper(piece) - lower(piece);
        RETURN NEXT;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.invoice_billed_hourly_pool(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_billed_hourly_pool(uuid, uuid) TO service_role;
