-- What an accounting tool reads to recognize revenue as it is earned
-- (GET /api/v1/billing/earned-work), and the invoice totals the invoice
-- listing reports (GET /api/v1/invoices).
--
-- billing_earned_work(p_from, p_to), per project:
--   time       approved client time by workspace day: the same sessions
--              invoice_unbilled_slices counts (approved, not internal, a rate
--              above 0, worked hours from time_entry_worked_hours), billed or
--              not. Only projects that bill time by the hour: on an
--              "included" project the time is covered by its retainer or
--              fixed fee, so counting it would double the revenue.
--   scheduled  retainer periods that have started (period_start on or before
--              the workspace's today) and are not on a sent, overdue or paid
--              invoice yet: no invoice, or a draft. Active retainers only;
--              skipped periods are not owed.
-- Amounts are dollars with two decimals; a day's time is rounded once.
--
-- Read only. Apply BEFORE the app deploy, AFTER 20261018205406_invoice_payments.
-- Safe to run twice.

CREATE OR REPLACE FUNCTION public.billing_earned_work(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text := public.workspace_timezone();
  today date := public.workspace_today();
  result jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed to read earned work' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'EARNED_WORK_RANGE: from and to are required, and from must not be after to';
  END IF;
  IF p_to - p_from > 1830 THEN
    RAISE EXCEPTION 'EARNED_WORK_RANGE: at most five years at a time';
  END IF;

  WITH sessions AS (
    SELECT entry.project_id,
           (entry.start_time AT TIME ZONE zone)::date AS day,
           public.time_entry_worked_hours(entry.segments, entry.start_time, entry.end_time) AS hours,
           entry.hourly_rate AS rate
    FROM public.project_time_entries entry
    JOIN public.projects project ON project.id = entry.project_id
    WHERE project.client_time_billing = 'hourly'
      AND entry.end_time IS NOT NULL
      AND entry.work_type <> 'internal'
      AND entry.approval_status = 'approved'
      AND entry.hourly_rate > 0
      AND (entry.start_time AT TIME ZONE zone)::date BETWEEN p_from AND p_to
  ),
  time_rows AS (
    SELECT jsonb_build_object(
      'project_id', project_id,
      'kind', 'time',
      'earned_from', day,
      'earned_to', day,
      'hours', ROUND(sum(hours), 4),
      'amount', ROUND(sum(hours * rate), 2)
    ) AS row, project_id, day AS sort_day
    FROM sessions
    GROUP BY project_id, day
    HAVING ROUND(sum(hours * rate), 2) > 0
  ),
  scheduled_rows AS (
    SELECT jsonb_build_object(
      'project_id', retainer.project_id,
      'kind', 'scheduled',
      'earned_from', period.period_start,
      'earned_to', period.period_end,
      'amount', period.amount,
      'retainer_id', retainer.id,
      'retainer_name', retainer.name,
      'billing_timing', retainer.billing_timing,
      'draft_invoice_id', invoice.id
    ) AS row, retainer.project_id, period.period_start AS sort_day
    FROM public.project_retainers retainer
    CROSS JOIN LATERAL public.retainer_periods(retainer.id, p_from, LEAST(p_to, today)) period
    LEFT JOIN public.project_retainer_periods handled
      ON handled.retainer_id = retainer.id AND handled.period_start = period.period_start
    LEFT JOIN public.project_invoices invoice ON invoice.id = handled.invoice_id
    WHERE retainer.status = 'active'
      AND period.period_start <= today
      AND period.period_end >= p_from
      AND period.amount > 0
      AND (handled.id IS NULL OR (handled.status = 'invoiced' AND invoice.status = 'draft'))
  )
  SELECT COALESCE(jsonb_agg(row ORDER BY project_id, sort_day, row->>'kind'), '[]'::jsonb)
  INTO result
  FROM (SELECT * FROM time_rows UNION ALL SELECT * FROM scheduled_rows) earned;

  RETURN result;
END;
$$;

-- Total owed (invoice_total) and paid so far, for a page of invoices
-- (p_invoice_ids: a JSON array of ids).
CREATE OR REPLACE FUNCTION public.invoice_payment_totals(p_invoice_ids jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_object_agg(invoice.id, jsonb_build_object(
    'total', public.invoice_total(invoice),
    'paid_total', COALESCE((SELECT sum(payment.amount) FROM public.invoice_payments payment WHERE payment.invoice_id = invoice.id), 0)
  )), '{}'::jsonb)
  FROM public.project_invoices invoice
  WHERE invoice.id::text IN (SELECT jsonb_array_elements_text(p_invoice_ids))
$$;

REVOKE ALL ON FUNCTION public.billing_earned_work(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_payment_totals(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_earned_work(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_payment_totals(jsonb) TO service_role;
