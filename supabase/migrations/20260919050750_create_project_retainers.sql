-- Project retainers, auto-drafted invoices and revenue splits.
--
-- A project has retainers. A retainer produces one recurring invoice line per
-- calendar month (first and last month prorated by days). A line can carry a
-- split: a percent of its gross amount that a team member earns once the
-- invoice is paid.
--
-- Splits are deliberately NOT stored inside project_invoices.line_items. That
-- JSON reaches the client portal, the webhook payload and the v1 API, so the
-- per-line split snapshot lives in invoice_line_shares behind
-- compensation.manage. The line JSON only gains a harmless retainer_id.
--
-- All period math lives here so the hourly job, Generate now and the invoice
-- form's pre-fill cannot disagree.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.project_retainers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- advance: the bill date is the period start and the line covers the coming
  -- month. arrears: the bill date is the day after the period ends.
  billing_timing text NOT NULL DEFAULT 'advance' CHECK (billing_timing IN ('advance', 'arrears')),
  start_date date NOT NULL,
  -- Ending a retainer is setting end_date; the final month prorates to it.
  end_date date CHECK (end_date IS NULL OR end_date >= start_date),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  -- The draft appears this many days before the bill date.
  lead_days integer NOT NULL DEFAULT 1 CHECK (lead_days BETWEEN 0 AND 28),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dated amount history, same shape as team_member_hourly_rates. A period bills
-- at the amount effective on its start date.
CREATE TABLE IF NOT EXISTS public.project_retainer_amounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retainer_id uuid NOT NULL REFERENCES public.project_retainers(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  effective_date date NOT NULL,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (retainer_id, effective_date)
);

-- Who shares in a retainer, and from when. A line takes the split effective on
-- its period start.
CREATE TABLE IF NOT EXISTS public.project_retainer_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retainer_id uuid NOT NULL REFERENCES public.project_retainers(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  percent numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  effective_from date NOT NULL,
  effective_to date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per period that has been dealt with: on an invoice, or skipped. The
-- unique key is the no-double-billing guard. A period with no row is still due.
CREATE TABLE IF NOT EXISTS public.project_retainer_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retainer_id uuid NOT NULL REFERENCES public.project_retainers(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('invoiced', 'skipped')),
  invoice_id uuid REFERENCES public.project_invoices(id) ON DELETE SET NULL,
  line_item_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (retainer_id, period_start),
  CHECK (period_end >= period_start)
);

-- The split frozen onto an invoice line. line_item_id is the stable id stored
-- in project_invoices.line_items, as in invoice_time_entry_allocations.
CREATE TABLE IF NOT EXISTS public.invoice_line_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.project_invoices(id) ON DELETE CASCADE,
  line_item_id text NOT NULL,
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  percent numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, line_item_id, member_id)
);

-- What a member earned from a paid line. Snapshots survive the invoice.
-- voided_at: retired before any payout touched it. reversed_at: retired after
-- a payout; the row stays so that payout still validates, and a deduction
-- adjustment carries the clawback.
CREATE TABLE IF NOT EXISTS public.team_member_share_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  retainer_id uuid REFERENCES public.project_retainers(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES public.project_invoices(id) ON DELETE SET NULL,
  line_item_id text NOT NULL,
  invoice_number text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  percent numeric(5,2) NOT NULL,
  basis_amount numeric(12,2) NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  earned_date date NOT NULL,
  voided_at timestamptz,
  reversed_at timestamptz,
  reversal_adjustment_id uuid REFERENCES public.team_member_earning_adjustments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_invoices
  ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false;

-- Payouts can settle a share earning as well as time or an adjustment.
ALTER TABLE public.team_member_payout_allocations
  ADD COLUMN IF NOT EXISTS share_earning_id uuid REFERENCES public.team_member_share_earnings(id) ON DELETE RESTRICT;

-- The two-source check and unique key were declared inline, so their names are
-- generated. Find them by definition and replace them with named ones.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.team_member_payout_allocations'::regclass
      AND contype IN ('c', 'u')
  LOOP
    IF (c.contype = 'c' AND c.def ILIKE '%num_nonnulls%')
      OR (c.contype = 'u' AND c.def ILIKE '%adjustment_id%') THEN
      EXECUTE format('ALTER TABLE public.team_member_payout_allocations DROP CONSTRAINT %I', c.conname);
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE public.team_member_payout_allocations
  ADD CONSTRAINT team_member_payout_allocations_one_source
    CHECK (num_nonnulls(time_entry_id, adjustment_id, share_earning_id) = 1),
  ADD CONSTRAINT team_member_payout_allocations_source_key
    UNIQUE NULLS NOT DISTINCT (payout_id, time_entry_id, adjustment_id, share_earning_id);

CREATE INDEX IF NOT EXISTS idx_project_retainers_project
  ON public.project_retainers(project_id);
CREATE INDEX IF NOT EXISTS idx_project_retainer_shares_retainer
  ON public.project_retainer_shares(retainer_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_project_retainer_periods_invoice
  ON public.project_retainer_periods(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_line_shares_member
  ON public.invoice_line_shares(member_id);
CREATE INDEX IF NOT EXISTS idx_team_member_share_earnings_member
  ON public.team_member_share_earnings(member_id, earned_date DESC);
CREATE INDEX IF NOT EXISTS idx_team_member_share_earnings_invoice
  ON public.team_member_share_earnings(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_member_share_earnings_active
  ON public.team_member_share_earnings(invoice_id, line_item_id, member_id)
  WHERE voided_at IS NULL AND reversed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_team_member_payout_allocations_share_earning
  ON public.team_member_payout_allocations(share_earning_id) WHERE share_earning_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_project_retainers_updated_at ON public.project_retainers;
CREATE TRIGGER set_project_retainers_updated_at
  BEFORE UPDATE ON public.project_retainers
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
DROP TRIGGER IF EXISTS set_project_retainer_shares_updated_at ON public.project_retainer_shares;
CREATE TRIGGER set_project_retainer_shares_updated_at
  BEFORE UPDATE ON public.project_retainer_shares
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
DROP TRIGGER IF EXISTS set_project_retainer_periods_updated_at ON public.project_retainer_periods;
CREATE TRIGGER set_project_retainer_periods_updated_at
  BEFORE UPDATE ON public.project_retainer_periods
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
DROP TRIGGER IF EXISTS set_team_member_share_earnings_updated_at ON public.team_member_share_earnings;
CREATE TRIGGER set_team_member_share_earnings_updated_at
  BEFORE UPDATE ON public.team_member_share_earnings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- Period math
-- ---------------------------------------------------------------------------

-- "Today" for billing is the owner's calendar day, not UTC.
CREATE OR REPLACE FUNCTION public.workspace_today()
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (now() AT TIME ZONE COALESCE((
    SELECT zone.name
    FROM public.team_members member
    JOIN pg_timezone_names zone ON zone.name = member.timezone
    WHERE member.role = 'owner'
    ORDER BY member.created_at
    LIMIT 1
  ), 'UTC'))::date
$$;

-- The calendar-month periods of one retainer whose month falls in the window,
-- clipped to the retainer's own dates and priced with proration.
CREATE OR REPLACE FUNCTION public.retainer_periods(p_retainer_id uuid, p_from date, p_to date)
RETURNS TABLE (
  period_start date,
  period_end date,
  bill_date date,
  amount numeric,
  full_amount numeric,
  prorated boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH retainer AS (
    SELECT * FROM public.project_retainers WHERE id = p_retainer_id
  ),
  months AS (
    SELECT month_start::date AS month_start,
           (month_start + interval '1 month' - interval '1 day')::date AS month_end
    FROM retainer,
      generate_series(
        date_trunc('month', GREATEST(p_from, retainer.start_date)::timestamp),
        date_trunc('month', LEAST(p_to, COALESCE(retainer.end_date, p_to))::timestamp),
        interval '1 month'
      ) AS month_start
  ),
  bounds AS (
    SELECT months.month_start,
           months.month_end,
           GREATEST(months.month_start, retainer.start_date) AS period_start,
           LEAST(months.month_end, COALESCE(retainer.end_date, months.month_end)) AS period_end,
           retainer.billing_timing
    FROM months, retainer
  ),
  priced AS (
    SELECT bounds.*,
      COALESCE(
        (SELECT history.amount FROM public.project_retainer_amounts history
         WHERE history.retainer_id = p_retainer_id AND history.effective_date <= bounds.period_start
         ORDER BY history.effective_date DESC LIMIT 1),
        (SELECT history.amount FROM public.project_retainer_amounts history
         WHERE history.retainer_id = p_retainer_id
         ORDER BY history.effective_date ASC LIMIT 1),
        0
      ) AS full_amount
    FROM bounds
    WHERE bounds.period_end >= bounds.period_start
  )
  SELECT
    priced.period_start,
    priced.period_end,
    CASE WHEN priced.billing_timing = 'arrears' THEN priced.period_end + 1 ELSE priced.period_start END,
    ROUND(
      priced.full_amount
        * (priced.period_end - priced.period_start + 1)
        / (priced.month_end - priced.month_start + 1),
      2
    ),
    priced.full_amount,
    (priced.period_start <> priced.month_start OR priced.period_end <> priced.month_end)
  FROM priced
  ORDER BY priced.period_start
$$;

-- Periods that should be on an invoice by p_as_of and have no period row yet.
CREATE OR REPLACE FUNCTION public.retainer_due_periods_internal(p_project_id uuid, p_as_of date)
RETURNS TABLE (
  retainer_id uuid,
  project_id uuid,
  retainer_name text,
  retainer_status text,
  billing_timing text,
  period_start date,
  period_end date,
  bill_date date,
  amount numeric,
  full_amount numeric,
  prorated boolean,
  description text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    retainer.id,
    retainer.project_id,
    retainer.name,
    retainer.status,
    retainer.billing_timing,
    period.period_start,
    period.period_end,
    period.bill_date,
    period.amount,
    period.full_amount,
    period.prorated,
    retainer.name || CASE WHEN period.prorated THEN ' (Prorated)' ELSE '' END
  FROM public.project_retainers retainer
  CROSS JOIN LATERAL public.retainer_periods(
    retainer.id,
    retainer.start_date,
    (p_as_of + retainer.lead_days + 31)
  ) period
  WHERE (p_project_id IS NULL OR retainer.project_id = p_project_id)
    AND period.bill_date - retainer.lead_days <= p_as_of
    AND NOT EXISTS (
      SELECT 1 FROM public.project_retainer_periods handled
      WHERE handled.retainer_id = retainer.id
        AND handled.period_start = period.period_start
    )
  ORDER BY retainer.created_at, period.period_start
$$;

-- What the invoice form offers as ready lines: periods that are due, plus
-- skipped ones so a line removed by mistake can be put back.
CREATE OR REPLACE FUNCTION public.retainer_due_periods(p_project_id uuid)
RETURNS TABLE (
  retainer_id uuid,
  retainer_name text,
  billing_timing text,
  period_start date,
  period_end date,
  bill_date date,
  amount numeric,
  full_amount numeric,
  prorated boolean,
  description text,
  skipped boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;

  RETURN QUERY
  SELECT due.retainer_id, due.retainer_name, due.billing_timing, due.period_start, due.period_end,
         due.bill_date, due.amount, due.full_amount, due.prorated, due.description, false
  FROM public.retainer_due_periods_internal(p_project_id, public.workspace_today()) due
  WHERE due.retainer_status = 'active'
  UNION ALL
  SELECT retainer.id, retainer.name, retainer.billing_timing, period.period_start, period.period_end,
         period.bill_date, period.amount, period.full_amount, period.prorated,
         retainer.name || CASE WHEN period.prorated THEN ' (Prorated)' ELSE '' END, true
  FROM public.project_retainer_periods handled
  JOIN public.project_retainers retainer ON retainer.id = handled.retainer_id
  CROSS JOIN LATERAL public.retainer_periods(retainer.id, handled.period_start, handled.period_start) period
  WHERE retainer.project_id = p_project_id
    AND handled.status = 'skipped'
    AND period.period_start = handled.period_start
  ORDER BY 4, 2;
END;
$$;

-- ---------------------------------------------------------------------------
-- Drafting
-- ---------------------------------------------------------------------------

-- Same rule the invoice form uses: per project, highest trailing number + 1.
CREATE OR REPLACE FUNCTION public.next_project_invoice_number(p_project_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'INV-' || lpad((COALESCE(MAX(substring(invoice_number FROM '(\d{1,12})$')::bigint), 0) + 1)::text, 3, '0')
  FROM public.project_invoices
  WHERE project_id = p_project_id
$$;

-- Builds one draft from the given lines. The reconcile trigger on
-- project_invoices claims the periods and copies the retainer splits.
CREATE OR REPLACE FUNCTION public.create_retainer_draft_internal(
  p_project_id uuid,
  p_lines jsonb,
  p_invoice_date date,
  p_auto boolean
)
RETURNS public.project_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.project_invoices;
  project_name text;
  recipient uuid;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('retainer-draft:' || p_project_id::text));

  INSERT INTO public.project_invoices (
    project_id, invoice_number, amount, status, invoice_type, line_items,
    date, due_date, description, auto_generated, created_by
  )
  SELECT
    p_project_id,
    public.next_project_invoice_number(p_project_id),
    (SELECT COALESCE(SUM((line->>'amount')::numeric), 0) FROM jsonb_array_elements(p_lines) line),
    'draft',
    'recurring',
    p_lines,
    to_char(p_invoice_date, 'YYYY-MM-DD'),
    to_char(p_invoice_date, 'YYYY-MM-DD'),
    '',
    p_auto,
    public.current_team_member_id()
  RETURNING * INTO saved;

  IF p_auto THEN
    SELECT name INTO project_name FROM public.projects WHERE id = p_project_id;
    FOR recipient IN
      SELECT id FROM public.team_members
      WHERE role IN ('owner', 'admin') AND status = 'active'
    LOOP
      PERFORM public.upsert_notification(
        recipient,
        'Retainer invoice drafted',
        saved.invoice_number || ' for ' || COALESCE(project_name, 'a project') || ' is ready to review and send.',
        '/projects/' || p_project_id::text || '?tab=invoices',
        'project',
        p_project_id::text
      );
    END LOOP;
  END IF;

  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.retainer_line_json(
  p_retainer_id uuid,
  p_position integer,
  p_amount numeric,
  p_description text,
  p_period_start date,
  p_period_end date
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
AS $$
  SELECT jsonb_build_object(
    'id', gen_random_uuid()::text,
    'position', p_position,
    'item_type', 'recurring',
    'amount', p_amount,
    'description', p_description,
    'service_start_date', to_char(p_period_start, 'YYYY-MM-DD'),
    'service_end_date', to_char(p_period_end, 'YYYY-MM-DD'),
    'recurrence_frequency', 'monthly',
    'retainer_id', p_retainer_id::text
  )
$$;

-- The scheduled job. One draft per project holding every due retainer line.
-- A paused retainer's due periods are recorded as skipped, so resuming never
-- back-bills the pause; Generate now can still bring one back.
CREATE OR REPLACE FUNCTION public.generate_retainer_drafts(p_as_of date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  as_of date := COALESCE(p_as_of, public.workspace_today());
  target record;
  lines jsonb;
  invoice_date date;
  created integer := 0;
  draft public.project_invoices;
BEGIN
  INSERT INTO public.project_retainer_periods (retainer_id, period_start, period_end, status)
  SELECT due.retainer_id, due.period_start, due.period_end, 'skipped'
  FROM public.retainer_due_periods_internal(NULL, as_of) due
  WHERE due.retainer_status = 'paused'
  ON CONFLICT (retainer_id, period_start) DO NOTHING;

  FOR target IN
    SELECT DISTINCT due.project_id
    FROM public.retainer_due_periods_internal(NULL, as_of) due
    WHERE due.retainer_status = 'active'
  LOOP
    SELECT
      jsonb_agg(
        public.retainer_line_json(
          due.retainer_id, (due.line_position - 1)::integer, due.amount, due.description,
          due.period_start, due.period_end
        ) ORDER BY due.line_position
      ),
      GREATEST(MAX(due.bill_date), as_of)
    INTO lines, invoice_date
    FROM (
      SELECT inner_due.*, row_number() OVER (ORDER BY inner_due.period_start, inner_due.retainer_name) AS line_position
      FROM public.retainer_due_periods_internal(target.project_id, as_of) inner_due
      WHERE inner_due.retainer_status = 'active'
    ) due;

    draft := public.create_retainer_draft_internal(target.project_id, lines, invoice_date, true);
    IF draft.id IS NOT NULL THEN
      created := created + 1;
    END IF;
  END LOOP;

  RETURN created;
END;
$$;

-- Generate now: one period, regardless of lead time or a Skipped mark.
CREATE OR REPLACE FUNCTION public.generate_retainer_period(p_retainer_id uuid, p_period_start date)
RETURNS public.project_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  retainer public.project_retainers;
  period record;
  handled public.project_retainer_periods;
BEGIN
  SELECT * INTO retainer FROM public.project_retainers WHERE id = p_retainer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(retainer.project_id)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;

  SELECT * INTO period
  FROM public.retainer_periods(p_retainer_id, p_period_start, p_period_start) candidate
  WHERE candidate.period_start = p_period_start;
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not a billing period of this retainer'; END IF;

  SELECT * INTO handled
  FROM public.project_retainer_periods
  WHERE retainer_id = p_retainer_id AND period_start = p_period_start
  FOR UPDATE;
  IF FOUND THEN
    IF handled.status = 'invoiced' AND handled.invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'That period is already on an invoice';
    END IF;
    DELETE FROM public.project_retainer_periods WHERE id = handled.id;
  END IF;

  RETURN public.create_retainer_draft_internal(
    retainer.project_id,
    jsonb_build_array(public.retainer_line_json(
      retainer.id, 0, period.amount,
      retainer.name || CASE WHEN period.prorated THEN ' (Prorated)' ELSE '' END,
      period.period_start, period.period_end
    )),
    GREATEST(period.bill_date, public.workspace_today()),
    false
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Share earnings
-- ---------------------------------------------------------------------------

-- Retire one earning. Untouched by payouts: void it. Already paid out: keep the
-- row (its payout must still validate) and write a deduction for the full
-- amount, which the payout flow clears first. Payout history is never edited.
CREATE OR REPLACE FUNCTION public.retire_share_earning(p_earning_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  earning public.team_member_share_earnings;
  paid_out numeric;
  deduction_id uuid;
BEGIN
  SELECT * INTO earning
  FROM public.team_member_share_earnings
  WHERE id = p_earning_id AND voided_at IS NULL AND reversed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(allocation.allocated_amount), 0)
  INTO paid_out
  FROM public.team_member_payout_allocations allocation
  JOIN public.team_member_payouts payout ON payout.id = allocation.payout_id
  WHERE allocation.share_earning_id = earning.id AND payout.voided_at IS NULL;

  IF paid_out = 0 THEN
    UPDATE public.team_member_share_earnings SET voided_at = now() WHERE id = earning.id;
    RETURN;
  END IF;

  INSERT INTO public.team_member_earning_adjustments (
    member_id, adjustment_type, amount, effective_date, project_id, description, created_by
  ) VALUES (
    earning.member_id,
    'deduction',
    earning.amount,
    public.workspace_today(),
    -- Null while a project delete is cascading through its invoices.
    (SELECT project.id FROM public.projects project WHERE project.id = earning.project_id),
    btrim('Reversal: ' || earning.invoice_number || ' ' || earning.description) || ' (' || p_reason || ')',
    public.current_team_member_id()
  ) RETURNING id INTO deduction_id;

  UPDATE public.team_member_share_earnings
  SET reversed_at = now(), reversal_adjustment_id = deduction_id
  WHERE id = earning.id;
END;
$$;

-- Bring an invoice's share earnings in line with its status, lines and splits.
CREATE OR REPLACE FUNCTION public.sync_invoice_share_earnings(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.project_invoices;
  earning record;
  earned_on date;
  desired jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO invoice FROM public.project_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  earned_on := COALESCE(
    CASE WHEN invoice.paid_date ~ '^\d{4}-\d{2}-\d{2}' THEN substring(invoice.paid_date FROM 1 FOR 10)::date END,
    public.workspace_today()
  );

  IF invoice.status = 'paid' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'line_item_id', line.value->>'id',
      'member_id', share.member_id,
      'percent', share.percent,
      'basis_amount', ROUND((line.value->>'amount')::numeric, 2),
      'amount', ROUND((line.value->>'amount')::numeric * share.percent / 100, 2),
      'description', COALESCE(line.value->>'description', ''),
      'retainer_id', (SELECT retainer.id FROM public.project_retainers retainer
                      WHERE retainer.id::text = line.value->>'retainer_id')
    )), '[]'::jsonb)
    INTO desired
    FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
    JOIN public.invoice_line_shares share
      ON share.invoice_id = invoice.id AND share.line_item_id = line.value->>'id'
    WHERE line.value->>'item_type' IN ('fixed', 'recurring')
      AND ROUND((line.value->>'amount')::numeric * share.percent / 100, 2) > 0;
  END IF;

  FOR earning IN
    SELECT existing.*
    FROM public.team_member_share_earnings existing
    WHERE existing.invoice_id = invoice.id
      AND existing.voided_at IS NULL AND existing.reversed_at IS NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(desired) AS desired(line_item_id text, member_id uuid, percent numeric, basis_amount numeric, amount numeric, description text, retainer_id uuid)
      WHERE desired.line_item_id = earning.line_item_id
        AND desired.member_id = earning.member_id
        AND desired.amount = earning.amount
        AND desired.percent = earning.percent
    ) THEN
      UPDATE public.team_member_share_earnings
      SET earned_date = earned_on, invoice_number = invoice.invoice_number
      WHERE id = earning.id
        AND (earned_date IS DISTINCT FROM earned_on OR invoice_number IS DISTINCT FROM invoice.invoice_number);
    ELSE
      PERFORM public.retire_share_earning(
        earning.id,
        CASE WHEN invoice.status = 'paid' THEN 'invoice changed' ELSE 'invoice no longer paid' END
      );
    END IF;
  END LOOP;

  INSERT INTO public.team_member_share_earnings (
    member_id, project_id, retainer_id, invoice_id, line_item_id, invoice_number,
    description, percent, basis_amount, amount, earned_date
  )
  SELECT desired.member_id, invoice.project_id, desired.retainer_id, invoice.id, desired.line_item_id,
         invoice.invoice_number, desired.description, desired.percent, desired.basis_amount,
         desired.amount, earned_on
  FROM jsonb_to_recordset(desired) AS desired(line_item_id text, member_id uuid, percent numeric, basis_amount numeric, amount numeric, description text, retainer_id uuid)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.team_member_share_earnings existing
    WHERE existing.invoice_id = invoice.id
      AND existing.line_item_id = desired.line_item_id
      AND existing.member_id = desired.member_id
      AND existing.voided_at IS NULL AND existing.reversed_at IS NULL
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Invoice triggers: periods follow lines, earnings follow paid
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reconcile_invoice_retainer_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lines jsonb := COALESCE(NULLIF(NEW.line_items, 'null'::jsonb), '[]'::jsonb);
  line jsonb;
  retainer public.project_retainers;
  handled public.project_retainer_periods;
  service_start date;
  service_end date;
  period_key date;
  newly_linked boolean;
BEGIN
  -- Let go of periods whose line is gone, or whose invoice was cancelled.
  UPDATE public.project_retainer_periods period
  SET status = 'skipped', invoice_id = NULL, line_item_id = NULL
  WHERE period.invoice_id = NEW.id
    AND (
      NEW.status = 'cancelled'
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(lines) current_line
        WHERE current_line.value->>'id' = period.line_item_id
          AND current_line.value->>'retainer_id' = period.retainer_id::text
      )
    );

  DELETE FROM public.invoice_line_shares share
  WHERE share.invoice_id = NEW.id
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(lines) current_line
      WHERE current_line.value->>'id' = share.line_item_id
        AND current_line.value->>'item_type' IN ('fixed', 'recurring')
    );

  IF NEW.status <> 'cancelled' THEN
    FOR line IN SELECT value FROM jsonb_array_elements(lines)
    LOOP
      CONTINUE WHEN NULLIF(line->>'retainer_id', '') IS NULL;

      SELECT * INTO retainer FROM public.project_retainers WHERE id::text = line->>'retainer_id';
      -- A deleted retainer leaves a dangling id on old lines; that is fine.
      CONTINUE WHEN NOT FOUND;
      IF retainer.project_id <> NEW.project_id THEN
        RAISE EXCEPTION 'An invoice line points to a retainer on another project';
      END IF;
      IF COALESCE(line->>'service_start_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'A retainer line needs a service start date';
      END IF;

      service_start := (line->>'service_start_date')::date;
      service_end := CASE
        WHEN COALESCE(line->>'service_end_date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN (line->>'service_end_date')::date
        ELSE (date_trunc('month', service_start::timestamp) + interval '1 month' - interval '1 day')::date
      END;
      -- Any line in a month stands for that month's period.
      period_key := GREATEST(date_trunc('month', service_start::timestamp)::date, retainer.start_date);

      SELECT * INTO handled
      FROM public.project_retainer_periods
      WHERE retainer_id = retainer.id AND period_start = period_key
      FOR UPDATE;

      IF FOUND AND handled.status = 'invoiced' AND handled.invoice_id IS NOT NULL AND handled.invoice_id <> NEW.id THEN
        RAISE EXCEPTION 'That retainer period is already on another invoice';
      END IF;

      newly_linked := NOT FOUND
        OR handled.invoice_id IS DISTINCT FROM NEW.id
        OR handled.line_item_id IS DISTINCT FROM (line->>'id');

      INSERT INTO public.project_retainer_periods (
        retainer_id, period_start, period_end, status, invoice_id, line_item_id
      ) VALUES (
        retainer.id, period_key, GREATEST(service_end, period_key), 'invoiced', NEW.id, line->>'id'
      )
      ON CONFLICT (retainer_id, period_start) DO UPDATE
      SET status = 'invoiced', invoice_id = EXCLUDED.invoice_id,
          line_item_id = EXCLUDED.line_item_id, period_end = EXCLUDED.period_end;

      -- A line inherits the retainer's split once, when it is first linked.
      -- After that the line's own rows are the truth, so removing them sticks.
      IF newly_linked AND NOT EXISTS (
        SELECT 1 FROM public.invoice_line_shares
        WHERE invoice_id = NEW.id AND line_item_id = line->>'id'
      ) THEN
        INSERT INTO public.invoice_line_shares (invoice_id, line_item_id, member_id, percent)
        SELECT NEW.id, line->>'id', share.member_id, share.percent
        FROM public.project_retainer_shares share
        WHERE share.retainer_id = retainer.id
          AND share.effective_from <= period_key
          AND (share.effective_to IS NULL OR share.effective_to >= period_key)
        ON CONFLICT (invoice_id, line_item_id, member_id) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  PERFORM public.sync_invoice_share_earnings(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS reconcile_invoice_retainer_lines ON public.project_invoices;
CREATE TRIGGER reconcile_invoice_retainer_lines
  AFTER INSERT OR UPDATE OF line_items, status, paid_date, invoice_number, project_id
  ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.reconcile_invoice_retainer_lines();

-- BEFORE, so the earnings and periods still point at the invoice.
CREATE OR REPLACE FUNCTION public.release_invoice_retainer_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  earning_id uuid;
BEGIN
  FOR earning_id IN
    SELECT id FROM public.team_member_share_earnings
    WHERE invoice_id = OLD.id AND voided_at IS NULL AND reversed_at IS NULL
  LOOP
    PERFORM public.retire_share_earning(earning_id, 'invoice deleted');
  END LOOP;

  UPDATE public.project_retainer_periods
  SET status = 'skipped', invoice_id = NULL, line_item_id = NULL
  WHERE invoice_id = OLD.id;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS release_invoice_retainer_links ON public.project_invoices;
CREATE TRIGGER release_invoice_retainer_links
  BEFORE DELETE ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.release_invoice_retainer_links();

CREATE OR REPLACE FUNCTION public.sync_share_earnings_from_line_shares()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_invoice_share_earnings(COALESCE(NEW.invoice_id, OLD.invoice_id));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sync_share_earnings_from_line_shares ON public.invoice_line_shares;
CREATE TRIGGER sync_share_earnings_from_line_shares
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_line_shares
  FOR EACH ROW EXECUTE FUNCTION public.sync_share_earnings_from_line_shares();

-- ---------------------------------------------------------------------------
-- Split rules
-- ---------------------------------------------------------------------------

-- Owners and agents are never paid out, so they cannot hold a share.
CREATE OR REPLACE FUNCTION public.assert_share_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE id = p_member_id AND role NOT IN ('owner', 'agent')
  ) THEN
    RAISE EXCEPTION 'A split needs a team member who can be paid';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_retainer_share_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_share_member(NEW.member_id);

  IF EXISTS (
    SELECT 1 FROM public.project_retainer_shares other
    WHERE other.retainer_id = NEW.retainer_id
      AND other.member_id = NEW.member_id
      AND other.id <> NEW.id
      AND other.effective_from <= COALESCE(NEW.effective_to, 'infinity'::date)
      AND COALESCE(other.effective_to, 'infinity'::date) >= NEW.effective_from
  ) THEN
    RAISE EXCEPTION 'That member already has a split on this retainer for those dates';
  END IF;

  -- The total can only peak on a day some share starts.
  IF EXISTS (
    SELECT 1
    FROM public.project_retainer_shares boundary
    WHERE boundary.retainer_id = NEW.retainer_id
      AND (
        SELECT SUM(covering.percent)
        FROM public.project_retainer_shares covering
        WHERE covering.retainer_id = NEW.retainer_id
          AND covering.effective_from <= boundary.effective_from
          AND COALESCE(covering.effective_to, 'infinity'::date) >= boundary.effective_from
      ) > 100
  ) THEN
    RAISE EXCEPTION 'Splits on a retainer cannot total more than 100 percent';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_retainer_share_rules ON public.project_retainer_shares;
CREATE CONSTRAINT TRIGGER trg_retainer_share_rules
  AFTER INSERT OR UPDATE ON public.project_retainer_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_retainer_share_rules();

-- ---------------------------------------------------------------------------
-- Write RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_project_retainer(p_retainer_id uuid, p_retainer jsonb)
RETURNS public.project_retainers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.project_retainers;
  target_project uuid;
BEGIN
  IF p_retainer_id IS NULL THEN
    target_project := (p_retainer->>'project_id')::uuid;
  ELSE
    SELECT project_id INTO target_project FROM public.project_retainers WHERE id = p_retainer_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;
  END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(target_project)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;

  IF p_retainer_id IS NULL THEN
    IF NULLIF(btrim(COALESCE(p_retainer->>'name', '')), '') IS NULL
      OR NULLIF(p_retainer->>'start_date', '') IS NULL
      OR NULLIF(p_retainer->>'amount', '') IS NULL THEN
      RAISE EXCEPTION 'A retainer needs a name, a start date and an amount';
    END IF;

    INSERT INTO public.project_retainers (
      project_id, name, billing_timing, start_date, end_date, status, lead_days, created_by
    ) VALUES (
      target_project,
      btrim(p_retainer->>'name'),
      COALESCE(NULLIF(p_retainer->>'billing_timing', ''), 'advance'),
      (p_retainer->>'start_date')::date,
      NULLIF(p_retainer->>'end_date', '')::date,
      COALESCE(NULLIF(p_retainer->>'status', ''), 'active'),
      COALESCE(NULLIF(p_retainer->>'lead_days', '')::integer, 1),
      public.current_team_member_id()
    ) RETURNING * INTO saved;

    INSERT INTO public.project_retainer_amounts (retainer_id, amount, effective_date, created_by)
    VALUES (saved.id, (p_retainer->>'amount')::numeric, saved.start_date, public.current_team_member_id());

    -- The split goes in before any line is linked, so a linked line inherits it.
    IF jsonb_typeof(p_retainer->'shares') = 'array' AND jsonb_array_length(p_retainer->'shares') > 0 THEN
      IF COALESCE(auth.role(), '') <> 'service_role'
        AND NOT public.has_permission('compensation.manage', 'app') THEN
        RAISE EXCEPTION 'Missing permission to manage compensation';
      END IF;
      INSERT INTO public.project_retainer_shares (retainer_id, member_id, percent, effective_from, created_by)
      SELECT saved.id, (share.value->>'member_id')::uuid, (share.value->>'percent')::numeric,
             saved.start_date, public.current_team_member_id()
      FROM jsonb_array_elements(p_retainer->'shares') share;
    END IF;

    -- Lines that were invoiced by hand before the retainer existed. Linking
    -- them here, in the same transaction, means the job never sees those
    -- periods as due.
    IF jsonb_typeof(p_retainer->'link_lines') = 'array' THEN
      UPDATE public.project_invoices invoice
      SET line_items = (
        SELECT jsonb_agg(
          CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_retainer->'link_lines') link
            WHERE link.value->>'invoice_id' = invoice.id::text
              AND link.value->>'line_item_id' = line.value->>'id'
          )
          THEN line.value || jsonb_build_object('retainer_id', saved.id::text)
          ELSE line.value END
          ORDER BY line.ordinality
        )
        FROM jsonb_array_elements(invoice.line_items) WITH ORDINALITY AS line(value, ordinality)
      )
      WHERE invoice.project_id = saved.project_id
        AND jsonb_typeof(invoice.line_items) = 'array'
        AND jsonb_array_length(invoice.line_items) > 0
        AND invoice.id::text IN (
          SELECT link.value->>'invoice_id' FROM jsonb_array_elements(p_retainer->'link_lines') link
        );
    END IF;
  ELSE
    UPDATE public.project_retainers retainer
    SET
      name = CASE WHEN p_retainer ? 'name' THEN btrim(p_retainer->>'name') ELSE retainer.name END,
      billing_timing = CASE WHEN p_retainer ? 'billing_timing' THEN p_retainer->>'billing_timing' ELSE retainer.billing_timing END,
      start_date = CASE WHEN p_retainer ? 'start_date' THEN (p_retainer->>'start_date')::date ELSE retainer.start_date END,
      end_date = CASE WHEN p_retainer ? 'end_date' THEN NULLIF(p_retainer->>'end_date', '')::date ELSE retainer.end_date END,
      status = CASE WHEN p_retainer ? 'status' THEN p_retainer->>'status' ELSE retainer.status END,
      lead_days = CASE WHEN p_retainer ? 'lead_days' THEN (p_retainer->>'lead_days')::integer ELSE retainer.lead_days END
    WHERE retainer.id = p_retainer_id
    RETURNING * INTO saved;
  END IF;

  RETURN saved;
END;
$$;

-- Same pattern as schedule_team_member_hourly_rate: a dated amount, replacing
-- any amount already set for that date.
CREATE OR REPLACE FUNCTION public.schedule_retainer_amount(
  p_retainer_id uuid,
  p_amount numeric,
  p_effective_date date
)
RETURNS public.project_retainer_amounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.project_retainer_amounts;
  target_project uuid;
BEGIN
  SELECT project_id INTO target_project FROM public.project_retainers WHERE id = p_retainer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(target_project)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 OR p_effective_date IS NULL THEN
    RAISE EXCEPTION 'An amount and an effective date are required';
  END IF;

  INSERT INTO public.project_retainer_amounts (retainer_id, amount, effective_date, created_by)
  VALUES (p_retainer_id, p_amount, p_effective_date, public.current_team_member_id())
  ON CONFLICT (retainer_id, effective_date) DO UPDATE SET amount = EXCLUDED.amount
  RETURNING * INTO saved;

  RETURN saved;
END;
$$;

-- The split from p_effective_from onward. Earlier history is kept; anything
-- scheduled on or after that date is replaced. An empty array ends the split.
CREATE OR REPLACE FUNCTION public.set_retainer_shares(
  p_retainer_id uuid,
  p_shares jsonb,
  p_effective_from date
)
RETURNS SETOF public.project_retainer_shares
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_project uuid;
BEGIN
  SELECT project_id INTO target_project FROM public.project_retainers WHERE id = p_retainer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('compensation.manage', 'app') AND public.can_access_project(target_project)) THEN
    RAISE EXCEPTION 'Missing permission to manage compensation';
  END IF;
  IF p_effective_from IS NULL OR jsonb_typeof(p_shares) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Splits and an effective date are required';
  END IF;

  DELETE FROM public.project_retainer_shares
  WHERE retainer_id = p_retainer_id AND effective_from >= p_effective_from;

  UPDATE public.project_retainer_shares
  SET effective_to = p_effective_from - 1
  WHERE retainer_id = p_retainer_id
    AND (effective_to IS NULL OR effective_to >= p_effective_from);

  INSERT INTO public.project_retainer_shares (retainer_id, member_id, percent, effective_from, created_by)
  SELECT p_retainer_id, (share.value->>'member_id')::uuid, (share.value->>'percent')::numeric,
         p_effective_from, public.current_team_member_id()
  FROM jsonb_array_elements(p_shares) share;

  RETURN QUERY
  SELECT * FROM public.project_retainer_shares
  WHERE retainer_id = p_retainer_id
  ORDER BY effective_from, created_at;
END;
$$;

-- Replace the split on an invoice's lines. Written as a diff so untouched rows
-- fire no trigger: re-saving the same split must not churn a paid-out earning.
CREATE OR REPLACE FUNCTION public.set_invoice_line_shares(p_invoice_id uuid, p_shares jsonb)
RETURNS SETOF public.invoice_line_shares
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.project_invoices;
  share record;
BEGIN
  SELECT * INTO invoice FROM public.project_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('compensation.manage', 'app') AND public.can_access_project(invoice.project_id)) THEN
    RAISE EXCEPTION 'Missing permission to manage compensation';
  END IF;
  IF jsonb_typeof(p_shares) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Splits must be a list';
  END IF;

  FOR share IN
    SELECT incoming.line_item_id, incoming.member_id, incoming.percent
    FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
  LOOP
    PERFORM public.assert_share_member(share.member_id);
    IF share.percent IS NULL OR share.percent <= 0 OR share.percent > 100 THEN
      RAISE EXCEPTION 'A split percent must be between 0 and 100';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
      WHERE line.value->>'id' = share.line_item_id
        AND line.value->>'item_type' IN ('fixed', 'recurring')
    ) THEN
      RAISE EXCEPTION 'Only fixed and recurring lines can be split';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
    GROUP BY incoming.line_item_id
    HAVING SUM(incoming.percent) > 100 OR COUNT(*) <> COUNT(DISTINCT incoming.member_id)
  ) THEN
    RAISE EXCEPTION 'Splits on a line cannot total more than 100 percent or repeat a member';
  END IF;

  DELETE FROM public.invoice_line_shares existing
  WHERE existing.invoice_id = p_invoice_id
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
      WHERE incoming.line_item_id = existing.line_item_id AND incoming.member_id = existing.member_id
    );

  INSERT INTO public.invoice_line_shares (invoice_id, line_item_id, member_id, percent)
  SELECT p_invoice_id, incoming.line_item_id, incoming.member_id, incoming.percent
  FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
  ON CONFLICT (invoice_id, line_item_id, member_id) DO UPDATE
  SET percent = EXCLUDED.percent
  WHERE public.invoice_line_shares.percent IS DISTINCT FROM EXCLUDED.percent;

  RETURN QUERY
  SELECT * FROM public.invoice_line_shares WHERE invoice_id = p_invoice_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Live accrual
-- ---------------------------------------------------------------------------

-- The Finances counter vests invoice lines by the second. A month with no line
-- yet (arrears billing, or a draft that has not been created) would sit at zero
-- and then land all at once, so the counter reads the period covering today
-- from here instead. A skipped or invoiced month has a period row and is left
-- out. share_percent is compensation: zero unless the caller may see it.
CREATE OR REPLACE FUNCTION public.retainer_accruing_lines()
RETURNS TABLE (
  project_id uuid,
  retainer_id uuid,
  period_start date,
  period_end date,
  amount numeric,
  share_percent numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH clock AS (
    SELECT public.workspace_today() AS today,
           COALESCE(auth.role(), '') = 'service_role' AS is_service
  )
  SELECT
    retainer.project_id,
    retainer.id,
    period.period_start,
    period.period_end,
    period.amount,
    CASE WHEN clock.is_service OR public.has_permission('compensation.manage', 'app') THEN COALESCE((
      SELECT SUM(share.percent)
      FROM public.project_retainer_shares share
      WHERE share.retainer_id = retainer.id
        AND share.effective_from <= period.period_start
        AND (share.effective_to IS NULL OR share.effective_to >= period.period_start)
    ), 0) ELSE 0 END
  FROM clock
  CROSS JOIN public.project_retainers retainer
  CROSS JOIN LATERAL public.retainer_periods(retainer.id, clock.today, clock.today) period
  WHERE retainer.status = 'active'
    AND clock.today BETWEEN period.period_start AND period.period_end
    AND (clock.is_service OR (public.has_permission('invoices.read', 'app') AND public.can_access_project(retainer.project_id)))
    AND NOT EXISTS (
      SELECT 1 FROM public.project_retainer_periods handled
      WHERE handled.retainer_id = retainer.id AND handled.period_start = period.period_start
    )
$$;

-- ---------------------------------------------------------------------------
-- Payouts: share earnings as a third source
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_team_member_payout(p_payout_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payout_row public.team_member_payouts;
  allocation_total numeric;
  allocation_row record;
  source_amount numeric;
  source_allocated numeric;
BEGIN
  SELECT * INTO payout_row FROM public.team_member_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout not found'; END IF;

  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO allocation_total
  FROM public.team_member_payout_allocations
  WHERE payout_id = p_payout_id;

  IF ROUND(allocation_total, 2) IS DISTINCT FROM ROUND(payout_row.amount, 2) THEN
    RAISE EXCEPTION 'Payout allocations do not match payout amount';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.team_member_payout_allocations allocation
    LEFT JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    LEFT JOIN public.team_member_earning_adjustments adjustment ON adjustment.id = allocation.adjustment_id
    LEFT JOIN public.team_member_share_earnings share_earning ON share_earning.id = allocation.share_earning_id
    WHERE allocation.payout_id = p_payout_id
      AND COALESCE(entry.member_id, adjustment.member_id, share_earning.member_id) IS DISTINCT FROM payout_row.member_id
  ) THEN
    RAISE EXCEPTION 'Payout allocation belongs to another member';
  END IF;

  FOR allocation_row IN
    SELECT * FROM public.team_member_payout_allocations WHERE payout_id = p_payout_id
  LOOP
    IF allocation_row.time_entry_id IS NOT NULL THEN
      SELECT
        CASE
          WHEN entry.approval_status = 'approved' AND entry.end_time IS NOT NULL THEN
            ROUND(
              COALESCE((
                SELECT SUM(
                  EXTRACT(EPOCH FROM (
                    (segment.value->>'end')::timestamptz
                    - (segment.value->>'start')::timestamptz
                  )) / 3600
                )
                FROM jsonb_array_elements(COALESCE(entry.segments, '[]'::jsonb)) segment
                WHERE NULLIF(segment.value->>'end', '') IS NOT NULL
              ), 0) * entry.compensation_rate,
              2
            )
          ELSE NULL
        END
      INTO source_amount
      FROM public.project_time_entries entry
      WHERE entry.id = allocation_row.time_entry_id;

      IF source_amount IS NULL THEN
        RAISE EXCEPTION 'Payouts can only allocate approved completed time';
      END IF;
    ELSIF allocation_row.share_earning_id IS NOT NULL THEN
      -- A reversed earning stays valid: its clawback is a separate deduction.
      SELECT CASE WHEN share_earning.voided_at IS NULL THEN share_earning.amount ELSE NULL END
      INTO source_amount
      FROM public.team_member_share_earnings share_earning
      WHERE share_earning.id = allocation_row.share_earning_id;

      IF source_amount IS NULL THEN
        RAISE EXCEPTION 'Payouts cannot allocate a missing or voided share earning';
      END IF;
    ELSE
      SELECT
        CASE
          WHEN adjustment.voided_at IS NULL THEN
            CASE WHEN adjustment.adjustment_type = 'deduction' THEN -adjustment.amount ELSE adjustment.amount END
          ELSE NULL
        END
      INTO source_amount
      FROM public.team_member_earning_adjustments adjustment
      WHERE adjustment.id = allocation_row.adjustment_id;

      IF source_amount IS NULL THEN
        RAISE EXCEPTION 'Payouts cannot allocate a missing or voided adjustment';
      END IF;
    END IF;

    IF source_amount = 0
      OR sign(allocation_row.allocated_amount) IS DISTINCT FROM sign(source_amount) THEN
      RAISE EXCEPTION 'Payout allocation has an invalid direction';
    END IF;

    SELECT COALESCE(SUM(existing.allocated_amount), 0)
    INTO source_allocated
    FROM public.team_member_payout_allocations existing
    JOIN public.team_member_payouts existing_payout ON existing_payout.id = existing.payout_id
    WHERE existing_payout.voided_at IS NULL
      AND (
        (allocation_row.time_entry_id IS NOT NULL AND existing.time_entry_id = allocation_row.time_entry_id)
        OR (allocation_row.adjustment_id IS NOT NULL AND existing.adjustment_id = allocation_row.adjustment_id)
        OR (allocation_row.share_earning_id IS NOT NULL AND existing.share_earning_id = allocation_row.share_earning_id)
      );

    IF (source_amount > 0 AND source_allocated > source_amount + 0.005)
      OR (source_amount < 0 AND source_allocated < source_amount - 0.005) THEN
      RAISE EXCEPTION 'Payout allocation exceeds the remaining source balance';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_team_member_payout(
  p_member_id uuid,
  p_payment_date text,
  p_amount numeric,
  p_payment_method text,
  p_reference text,
  p_notes text,
  p_allocations jsonb
)
RETURNS public.team_member_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payout_row public.team_member_payouts;
  allocation jsonb;
BEGIN
  IF NOT public.has_permission('payouts.manage', 'app') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF p_amount <= 0 OR jsonb_typeof(p_allocations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A positive payout and allocations are required';
  END IF;

  INSERT INTO public.team_member_payouts (
    member_id, payment_date, amount, payment_method, reference, notes, created_by
  ) VALUES (
    p_member_id, p_payment_date::date, p_amount, COALESCE(p_payment_method, ''),
    COALESCE(p_reference, ''), COALESCE(p_notes, ''), public.current_team_member_id()
  ) RETURNING * INTO payout_row;

  FOR allocation IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    INSERT INTO public.team_member_payout_allocations (
      payout_id, time_entry_id, adjustment_id, share_earning_id, allocated_amount
    ) VALUES (
      payout_row.id,
      NULLIF(allocation->>'time_entry_id', '')::uuid,
      NULLIF(allocation->>'adjustment_id', '')::uuid,
      NULLIF(allocation->>'share_earning_id', '')::uuid,
      (allocation->>'allocated_amount')::numeric
    );
  END LOOP;

  PERFORM public.validate_team_member_payout(payout_row.id);
  RETURN payout_row;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.project_retainers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_retainer_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_retainer_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_retainer_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_share_earnings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS retainers_select ON public.project_retainers;
DROP POLICY IF EXISTS retainers_manage ON public.project_retainers;
CREATE POLICY retainers_select ON public.project_retainers FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND public.can_access_project(project_id));
CREATE POLICY retainers_manage ON public.project_retainers FOR ALL TO authenticated
  USING (public.has_permission('invoices.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('invoices.manage') AND public.can_access_project(project_id));

DROP POLICY IF EXISTS retainer_amounts_select ON public.project_retainer_amounts;
DROP POLICY IF EXISTS retainer_amounts_manage ON public.project_retainer_amounts;
CREATE POLICY retainer_amounts_select ON public.project_retainer_amounts FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ));
CREATE POLICY retainer_amounts_manage ON public.project_retainer_amounts FOR ALL TO authenticated
  USING (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ))
  WITH CHECK (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ));

DROP POLICY IF EXISTS retainer_periods_select ON public.project_retainer_periods;
DROP POLICY IF EXISTS retainer_periods_manage ON public.project_retainer_periods;
CREATE POLICY retainer_periods_select ON public.project_retainer_periods FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ));
CREATE POLICY retainer_periods_manage ON public.project_retainer_periods FOR ALL TO authenticated
  USING (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ))
  WITH CHECK (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ));

-- Splits are compensation. Holding invoices.manage alone does not reveal them.
DROP POLICY IF EXISTS retainer_shares_manage ON public.project_retainer_shares;
CREATE POLICY retainer_shares_manage ON public.project_retainer_shares FOR ALL TO authenticated
  USING (public.has_permission('compensation.manage'))
  WITH CHECK (public.has_permission('compensation.manage'));

DROP POLICY IF EXISTS invoice_line_shares_manage ON public.invoice_line_shares;
CREATE POLICY invoice_line_shares_manage ON public.invoice_line_shares FOR ALL TO authenticated
  USING (public.has_permission('compensation.manage'))
  WITH CHECK (public.has_permission('compensation.manage'));

-- Earnings are written by triggers only; members read their own.
DROP POLICY IF EXISTS share_earnings_own_or_manage ON public.team_member_share_earnings;
CREATE POLICY share_earnings_own_or_manage ON public.team_member_share_earnings FOR SELECT TO authenticated
  USING ((member_id = public.current_team_member_id() AND public.has_permission('earnings.own.read'))
    OR public.has_permission('compensation.manage')
    OR public.has_permission('payouts.manage'));

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.workspace_today() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retainer_periods(uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retainer_due_periods_internal(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retainer_due_periods(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_project_invoice_number(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_retainer_draft_internal(uuid, jsonb, date, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_retainer_drafts(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_retainer_period(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retire_share_earning(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_invoice_share_earnings(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_share_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_project_retainer(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.schedule_retainer_amount(uuid, numeric, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_retainer_shares(uuid, jsonb, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_invoice_line_shares(uuid, jsonb) FROM PUBLIC;

-- Supabase grants new public functions to anon and authenticated by default.
REVOKE ALL ON FUNCTION public.retainer_periods(uuid, date, date) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.retainer_due_periods_internal(uuid, date) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.next_project_invoice_number(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_retainer_draft_internal(uuid, jsonb, date, boolean) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_retainer_drafts(date) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.retire_share_earning(uuid, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_invoice_share_earnings(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_share_member(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.retainer_line_json(uuid, integer, numeric, text, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retainer_due_periods(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.generate_retainer_period(uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.save_project_retainer(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.schedule_retainer_amount(uuid, numeric, date) FROM anon;
REVOKE ALL ON FUNCTION public.set_retainer_shares(uuid, jsonb, date) FROM anon;
REVOKE ALL ON FUNCTION public.set_invoice_line_shares(uuid, jsonb) FROM anon;

GRANT EXECUTE ON FUNCTION public.workspace_today() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retainer_due_periods(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_retainer_period(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_project_retainer(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.schedule_retainer_amount(uuid, numeric, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_retainer_shares(uuid, jsonb, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_invoice_line_shares(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_retainer_drafts(date) TO service_role;
REVOKE ALL ON FUNCTION public.retainer_accruing_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retainer_accruing_lines() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime: the retainer modal live-syncs like invoices do. Splits and
-- earnings stay off the wire.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['project_retainers', 'project_retainer_amounts', 'project_retainer_periods'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Schedule. Hourly, because "today" is the owner's calendar day and the job is
-- idempotent: a draft appears within the hour after local midnight. Skipped
-- where pg_cron is unavailable (local fixtures).
-- ---------------------------------------------------------------------------

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not available; retainer drafts will not be scheduled here';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS pg_cron;

  PERFORM cron.schedule(
    'retainer-drafts',
    '7 * * * *',
    $job$SELECT public.generate_retainer_drafts();$job$
  );
END;
$do$;
