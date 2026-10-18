-- Hours on a draft or sent invoice are billed, not free (autonomous invoice
-- drafting, foundation).
--
-- Until now "unbilled" meant approved client time beyond the FIFO pool of
-- dollars on PAID hourly lines, worked out only in the browser: a draft or
-- sent invoice did not hold its hours, so the next "Add tracked time" (and
-- any scheduled draft) offered the same hours again. Now:
-- - unbilled = time beyond the paid pool MINUS the slices that draft, sent or
--   overdue invoices hold (their allocation rows). Paid figures are unchanged.
-- - invoice_hours_draft() builds the hourly line on the server, with the same
--   walk, rounding and description as the browser (lib/invoice-utils.ts), so
--   the scheduled job and the invoice form cannot disagree.
-- - saving an invoice refuses hours another live invoice holds, and time that
--   is not approved client time.
-- - invoice numbers are unique per project.
--
-- Apply BEFORE the app deploy that ships the same rule in the browser.

-- -- Helpers --------------------------------------------------------------

-- The workspace's time zone (the first owner's), as workspace_today() reads it.
CREATE OR REPLACE FUNCTION public.workspace_timezone()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text;
BEGIN
  FOR zone IN
    SELECT member.timezone
    FROM public.team_members member
    WHERE member.role = 'owner'
      AND member.timezone ~ '^[A-Za-z][A-Za-z0-9_-]*(/[A-Za-z0-9_+-]+)*$'
    ORDER BY member.created_at
  LOOP
    BEGIN
      PERFORM now() AT TIME ZONE zone;
      RETURN zone;
    EXCEPTION WHEN invalid_parameter_value THEN
      NULL;
    END;
  END LOOP;
  RETURN 'UTC';
END;
$$;

-- Worked hours of a session: its segments (pauses excluded), else its span.
-- The same sum validate_invoice_time_allocations uses.
CREATE OR REPLACE FUNCTION public.time_entry_worked_hours(p_segments jsonb, p_start timestamptz, p_end timestamptz)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_array_length(COALESCE(p_segments, '[]'::jsonb)) > 0 THEN COALESCE((
      SELECT sum(extract(epoch from ((segment->>'end')::timestamptz - (segment->>'start')::timestamptz)) / 3600)
      FROM jsonb_array_elements(p_segments) segment
      WHERE segment->>'end' IS NOT NULL
    ), 0)
    ELSE COALESCE(extract(epoch from (p_end - p_start)) / 3600, 0)
  END
$$;

-- Dollars of hourly lines on paid invoices (the FIFO pool). An invoice with no
-- line items counts as one line of its invoice_type, as ensureLineItems does.
CREATE OR REPLACE FUNCTION public.invoice_paid_hourly_pool(p_project_id uuid, p_exclude_invoice_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(sum(CASE
    WHEN jsonb_array_length(COALESCE(invoice.line_items, '[]'::jsonb)) = 0 THEN
      CASE WHEN invoice.invoice_type = 'hourly' THEN invoice.amount ELSE 0 END
    ELSE (
      SELECT COALESCE(sum(COALESCE(NULLIF(line->>'amount', '')::numeric, 0)), 0)
      FROM jsonb_array_elements(invoice.line_items) line
      WHERE line->>'item_type' = 'hourly'
    )
  END), 0)
  FROM public.project_invoices invoice
  WHERE invoice.project_id = p_project_id
    AND invoice.status = 'paid'
    AND invoice.id IS DISTINCT FROM p_exclude_invoice_id
$$;

-- -- Unbilled time --------------------------------------------------------

-- The unbilled slices of a project's approved client time, oldest first:
-- each session's part beyond the paid pool (FIFO by dollars, the browser's
-- tolerances), minus what draft, sent or overdue invoices hold. p_exclude_invoice_id: the invoice being edited
-- (its own hours are free to it, and its dollars leave the pool).
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
  pool numeric := public.invoice_paid_hourly_pool(p_project_id, p_exclude_invoice_id);
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

-- The hourly line for a project, as the invoice form builds it:
--   p_mode 'all'    everything unbilled
--          'hours'  up to p_target hours
--          'amount' up to p_target dollars
-- p_from / p_through limit by session start.
-- Returns NULL when nothing is unbilled, else
--   { hours, amount, start_time, end_time, description, allocations[] }
-- with allocations rounded to cents and reconciled one cent at a time so they
-- sum to the line, exactly like reconcileAllocationCents.
CREATE OR REPLACE FUNCTION public.invoice_hours_draft_internal(
  p_project_id uuid,
  p_mode text DEFAULT 'all',
  p_target numeric DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_through timestamptz DEFAULT NULL,
  p_exclude_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  money_eps CONSTANT numeric := 0.005000001;
  hours_eps CONSTANT numeric := 0.000050001;
  slice record;
  used_hours numeric;
  used_amount numeric;
  total_hours numeric := 0;
  total_amount numeric := 0;
  remaining numeric;
  first_start timestamptz;
  last_end timestamptz;
  ids uuid[] := '{}';
  offsets numeric[] := '{}';
  hours_list numeric[] := '{}';
  cents bigint[] := '{}';
  target_cents bigint;
  difference bigint;
  direction int;
  cursor_at int := 0;
  idx int;
  zone text := public.workspace_timezone();
  allocations jsonb := '[]'::jsonb;
  hours_text text;
BEGIN
  IF p_mode NOT IN ('all', 'hours', 'amount') THEN
    RAISE EXCEPTION 'invoice_hours_draft: mode must be all, hours or amount' USING ERRCODE = '22023';
  END IF;
  IF p_mode <> 'all' AND (p_target IS NULL OR p_target <= 0) THEN RETURN NULL; END IF;
  remaining := p_target;

  FOR slice IN
    SELECT * FROM public.invoice_unbilled_slices(p_project_id, p_exclude_invoice_id) s
    WHERE (p_from IS NULL OR s.start_time >= p_from)
      AND (p_through IS NULL OR s.start_time < p_through)
  LOOP
    IF p_mode = 'hours' THEN
      IF p_target - total_hours <= hours_eps THEN EXIT; END IF;
      used_hours := LEAST(slice.hours, p_target - total_hours);
      IF used_hours <= hours_eps THEN CONTINUE; END IF;
      used_amount := used_hours * slice.rate;
    ELSIF p_mode = 'amount' THEN
      IF remaining <= money_eps THEN EXIT; END IF;
      used_amount := LEAST(slice.hours * slice.rate, remaining);
      used_hours := used_amount / slice.rate;
      remaining := remaining - used_amount;
    ELSE
      used_hours := slice.hours;
      used_amount := slice.hours * slice.rate;
    END IF;

    total_hours := total_hours + used_hours;
    total_amount := total_amount + used_amount;
    first_start := COALESCE(first_start, slice.start_time);
    last_end := CASE WHEN p_mode = 'all' THEN GREATEST(COALESCE(last_end, slice.end_time), slice.end_time) ELSE slice.end_time END;
    ids := ids || slice.time_entry_id;
    offsets := offsets || slice.start_offset_hours;
    hours_list := hours_list || used_hours;
    cents := cents || round(round(used_amount, 2) * 100)::bigint;
  END LOOP;

  IF total_hours <= 0 OR first_start IS NULL THEN RETURN NULL; END IF;

  target_cents := round(total_amount * 100)::bigint;
  difference := target_cents - (SELECT COALESCE(sum(c), 0) FROM unnest(cents) c);
  direction := CASE WHEN difference > 0 THEN 1 ELSE -1 END;
  WHILE difference <> 0 LOOP
    idx := (cursor_at % array_length(cents, 1)) + 1;
    IF direction > 0 OR cents[idx] > 0 THEN
      cents[idx] := cents[idx] + direction;
      difference := difference - direction;
    END IF;
    cursor_at := cursor_at + 1;
  END LOOP;

  FOR idx IN 1 .. array_length(ids, 1) LOOP
    allocations := allocations || jsonb_build_object(
      'time_entry_id', ids[idx],
      'start_offset_hours', offsets[idx],
      'allocated_hours', hours_list[idx],
      'allocated_amount', cents[idx]::numeric / 100
    );
  END LOOP;

  hours_text := rtrim(rtrim(to_char(round(total_hours, 4), 'FM999999990.0000'), '0'), '.');
  RETURN jsonb_build_object(
    'hours', total_hours,
    'amount', round(total_amount, 2),
    'start_time', first_start,
    'end_time', last_end,
    'description', hours_text || ' hours worked between '
      || to_char(first_start AT TIME ZONE zone, 'MM/DD/YYYY') || ' and '
      || to_char(last_end AT TIME ZONE zone, 'MM/DD/YYYY'),
    'allocations', allocations
  );
END;
$$;

-- What a person may call: the same, behind invoices.manage and project access.
CREATE OR REPLACE FUNCTION public.invoice_hours_draft(
  p_project_id uuid,
  p_mode text DEFAULT 'all',
  p_target numeric DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_through timestamptz DEFAULT NULL,
  p_exclude_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'Not allowed to draft invoices on this project' USING ERRCODE = '42501';
  END IF;
  RETURN public.invoice_hours_draft_internal(p_project_id, p_mode, p_target, p_from, p_through, p_exclude_invoice_id);
END;
$$;

-- -- Guards on save -------------------------------------------------------

-- validate_invoice_time_allocations gains two checks, run on every save:
-- the invoice's hours must be approved client time, and no other live
-- (not cancelled) invoice may hold the same slice of a session.
CREATE OR REPLACE FUNCTION public.validate_invoice_time_allocations(target_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  clash record;
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
    WHERE allocation.invoice_id = target_invoice_id
      AND (entry.approval_status IS DISTINCT FROM 'approved' OR entry.work_type = 'internal')
  ) THEN
    RAISE EXCEPTION 'Only approved client time can be invoiced';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND allocation.start_offset_hours + allocation.allocated_hours
        > public.time_entry_worked_hours(entry.segments, entry.start_time, entry.end_time) + 0.0000011
  ) THEN
    RAISE EXCEPTION 'Invoice allocation extends beyond its tracked session';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND abs(round(allocation.allocated_hours * entry.hourly_rate, 2) - allocation.allocated_amount) > 0.01
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
      AND numrange(left_allocation.start_offset_hours, left_allocation.start_offset_hours + left_allocation.allocated_hours, '[)')
       && numrange(right_allocation.start_offset_hours, right_allocation.start_offset_hours + right_allocation.allocated_hours, '[)')
  ) THEN
    RAISE EXCEPTION 'A time session is billed more than once on the same invoice';
  END IF;

  -- A cancelled invoice holds nothing; a live one must not share a slice
  -- with another live invoice (a margin under a millionth of an hour is
  -- rounding, not a clash).
  SELECT other.invoice_number INTO clash
  FROM public.invoice_time_entry_allocations mine
  JOIN public.project_invoices me ON me.id = mine.invoice_id
  JOIN public.invoice_time_entry_allocations theirs
    ON theirs.time_entry_id = mine.time_entry_id AND theirs.invoice_id <> mine.invoice_id
  JOIN public.project_invoices other ON other.id = theirs.invoice_id
  WHERE mine.invoice_id = target_invoice_id
    AND me.status <> 'cancelled'
    AND other.status <> 'cancelled'
    AND mine.start_offset_hours < theirs.start_offset_hours + theirs.allocated_hours - 0.000001
    AND theirs.start_offset_hours < mine.start_offset_hours + mine.allocated_hours - 0.000001
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Some of these hours are already on invoice %', clash.invoice_number USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.project_invoices invoice
    CROSS JOIN LATERAL jsonb_array_elements(invoice.line_items) line_item
    JOIN (
      SELECT line_item_id, sum(allocated_amount) AS allocated_amount
      FROM public.invoice_time_entry_allocations
      WHERE invoice_id = target_invoice_id
      GROUP BY line_item_id
    ) totals ON totals.line_item_id = line_item->>'id'
    WHERE invoice.id = target_invoice_id
      AND totals.allocated_amount IS DISTINCT FROM round((line_item->>'amount')::numeric, 2)
  ) THEN
    RAISE EXCEPTION 'Hourly allocation totals do not match the invoice line amount';
  END IF;
END;
$$;

-- One number per invoice on a project (the form, the retainer job and the
-- hourly job all take the next number; a race now fails instead of doubling).
CREATE UNIQUE INDEX IF NOT EXISTS project_invoices_project_number_key
  ON public.project_invoices (project_id, invoice_number);

REVOKE ALL ON FUNCTION public.workspace_timezone() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_paid_hourly_pool(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_unbilled_slices(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_hours_draft_internal(uuid, text, numeric, timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_hours_draft(uuid, text, numeric, timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_hours_draft(uuid, text, numeric, timestamptz, timestamptz, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workspace_timezone() TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_unbilled_slices(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_hours_draft_internal(uuid, text, numeric, timestamptz, timestamptz, uuid) TO service_role;
