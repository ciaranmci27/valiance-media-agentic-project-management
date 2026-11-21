-- Workspace region: the currency, locale and week start every amount and
-- date in the app, the client portal, invoice PDFs and emails follows, set
-- by an Owner in Settings > Workspace > Region.
--
-- Additive and safe to re-run. Works with 1.6.1's code:
-- - One new table with one row: USD, en-US, Monday, which is what the app
--   always showed, so nothing reads differently until an Owner changes it.
-- - project_invoices, project_retainers and project_billing_plans get a
--   currency. Existing rows are USD (the only currency until now); new rows
--   take the workspace currency from the column default, so 1.6.1's inserts
--   are stamped too.
-- - Database functions that wrote "$" (activity lines, Trash labels, billing
--   notices and the forecast note) write amounts with format_money() in the
--   record's own currency. Their signatures do not change.

-- 1. The region, readable by every signed-in member, written by Owners.
-- (A test copy of this file before release had format_money without p_exact:
-- dropped so the one below is the only one.)
DROP FUNCTION IF EXISTS public.format_money(numeric, text);

CREATE TABLE IF NOT EXISTS public.workspace_region (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- ISO 4217: new invoices, retainers and billing plans take it; pay and totals show in it.
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  -- BCP 47: how amounts and dates read.
  locale text NOT NULL DEFAULT 'en-US' CHECK (char_length(locale) <= 35 AND locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  -- The first day of the week: 1 Monday, 0 Sunday, 6 Saturday.
  week_start smallint NOT NULL DEFAULT 1 CHECK (week_start IN (0, 1, 6)),
  -- How the currency reads in the locale, taken from the app's Intl when an
  -- Owner saves (prefix, suffix, separators, decimals), so format_money()
  -- writes amounts in activity lines, Trash and billing notices the way the
  -- app shows them.
  money_format jsonb CHECK (money_format IS NULL OR jsonb_typeof(money_format) = 'object'),
  updated_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_workspace_region_updated_at ON public.workspace_region;
CREATE TRIGGER set_workspace_region_updated_at
  BEFORE UPDATE ON public.workspace_region
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

INSERT INTO public.workspace_region (id, money_format)
VALUES (true, '{"prefix":"$","suffix":"","negative_prefix":"-$","negative_suffix":"","group":",","decimal":".","digits":2,"min_group":1,"secondary_group":3}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Every signed-in member reads it (every screen shows amounts); only Owners
-- write it. The client portal, emails and PDFs read it with the service role.
ALTER TABLE public.workspace_region ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_region_read ON public.workspace_region;
CREATE POLICY workspace_region_read ON public.workspace_region
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS workspace_region_owner_insert ON public.workspace_region;
CREATE POLICY workspace_region_owner_insert ON public.workspace_region
  FOR INSERT TO authenticated WITH CHECK (public.current_team_member_role() = 'owner');
DROP POLICY IF EXISTS workspace_region_owner_update ON public.workspace_region;
CREATE POLICY workspace_region_owner_update ON public.workspace_region
  FOR UPDATE TO authenticated
  USING (public.current_team_member_role() = 'owner')
  WITH CHECK (public.current_team_member_role() = 'owner');
REVOKE ALL ON public.workspace_region FROM anon;
REVOKE DELETE, TRUNCATE ON public.workspace_region FROM authenticated;

-- The currency a new invoice, retainer or billing plan is stamped with.
CREATE OR REPLACE FUNCTION public.workspace_currency()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT currency FROM public.workspace_region LIMIT 1), 'USD')
$$;

-- An amount as the app shows it (src/lib/format.ts). By default a total, as
-- formatMoney: no decimals from 1,000 up, the currency's decimals below only
-- when there are any. With p_exact, one amount (a payment, an invoice, a
-- rate), as formatMoneyExact: always the currency's decimals. The workspace
-- currency follows the saved pattern; another currency (an invoice issued
-- before a change) shows its code where the symbol goes.
CREATE OR REPLACE FUNCTION public.format_money(p_amount numeric, p_currency text DEFAULT NULL, p_exact boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  home text;
  pattern jsonb;
  code text;
  own boolean;
  digits integer;
  amount numeric := COALESCE(p_amount, 0);
  shown numeric;
  whole text;
  head text;
  grouped text;
  fraction text := '';
  separator text;
  secondary integer;
  prefix text;
  suffix text;
  negative_prefix text;
  negative_suffix text;
BEGIN
  SELECT currency, money_format INTO home, pattern FROM public.workspace_region LIMIT 1;
  home := COALESCE(home, 'USD');
  code := upper(COALESCE(NULLIF(btrim(p_currency), ''), home));
  own := code = home AND jsonb_typeof(pattern) = 'object';
  IF jsonb_typeof(pattern) IS DISTINCT FROM 'object' THEN
    pattern := '{"prefix":"$","suffix":"","negative_prefix":"-$","negative_suffix":"","group":",","decimal":".","digits":2,"min_group":1,"secondary_group":3}'::jsonb;
  END IF;

  IF own THEN
    digits := COALESCE((pattern->>'digits')::integer, 2);
    prefix := COALESCE(pattern->>'prefix', '');
    suffix := COALESCE(pattern->>'suffix', '');
    negative_prefix := COALESCE(pattern->>'negative_prefix', '-' || prefix);
    negative_suffix := COALESCE(pattern->>'negative_suffix', suffix);
  ELSE
    digits := CASE WHEN code IN ('JPY', 'KRW', 'VND', 'CLP', 'ISK', 'PYG', 'UGX', 'XAF', 'XOF', 'XPF', 'KMF', 'GNF', 'RWF', 'VUV', 'BIF', 'DJF') THEN 0 ELSE 2 END;
    IF COALESCE(pattern->>'prefix', '') = '' AND COALESCE(pattern->>'suffix', '') <> '' THEN
      prefix := '';
      suffix := chr(160) || code;
    ELSE
      prefix := code || chr(160);
      suffix := '';
    END IF;
    negative_prefix := '-' || prefix;
    negative_suffix := suffix;
  END IF;

  shown := abs(amount);
  IF NOT COALESCE(p_exact, false) AND (shown >= 1000 OR round(shown, digits) = trunc(round(shown, digits))) THEN
    digits := 0;
  END IF;
  shown := round(shown, digits);
  whole := trunc(shown)::text;
  IF digits > 0 THEN
    fraction := COALESCE(pattern->>'decimal', '.')
      || lpad(round((shown - trunc(shown)) * power(10::numeric, digits))::bigint::text, digits, '0');
  END IF;

  separator := COALESCE(pattern->>'group', ',');
  secondary := GREATEST(COALESCE((pattern->>'secondary_group')::integer, 3), 1);
  IF separator <> '' AND length(whole) >= 3 + COALESCE((pattern->>'min_group')::integer, 1) THEN
    grouped := right(whole, 3);
    head := left(whole, length(whole) - 3);
    WHILE length(head) > secondary LOOP
      grouped := right(head, secondary) || separator || grouped;
      head := left(head, length(head) - secondary);
    END LOOP;
    grouped := head || separator || grouped;
  ELSE
    grouped := whole;
  END IF;

  IF amount < 0 AND shown > 0 THEN
    RETURN negative_prefix || grouped || fraction || negative_suffix;
  END IF;
  RETURN prefix || grouped || fraction || suffix;
END;
$$;

REVOKE ALL ON FUNCTION public.workspace_currency() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.format_money(numeric, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_currency() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.format_money(numeric, text, boolean) TO authenticated, service_role;

-- 2. Money for a client keeps the currency it was made in. Added as 'USD'
--    first, so every existing row is backfilled, then defaulted to the
--    workspace currency for new rows.
-- Invoices.
ALTER TABLE public.project_invoices
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE public.project_invoices
  ALTER COLUMN currency SET DEFAULT public.workspace_currency();
-- Retainers.
ALTER TABLE public.project_retainers
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE public.project_retainers
  ALTER COLUMN currency SET DEFAULT public.workspace_currency();
-- Billing plans (last column: billing_forecast_internal builds this row by position).
ALTER TABLE public.project_billing_plans
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE public.project_billing_plans
  ALTER COLUMN currency SET DEFAULT public.workspace_currency();

-- 3. Amounts written by the database, in the record's currency.
CREATE OR REPLACE FUNCTION public.activity_money_label(p_amount numeric)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT public.format_money(p_amount, NULL, true)
$$;

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
  terms integer;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN NULL;
  END IF;
  -- An invoice is in one currency: retainers in different ones never share a draft.
  IF (SELECT count(DISTINCT r.currency) FROM jsonb_array_elements(p_lines) line
      JOIN public.project_retainers r ON r.id::text = line->>'retainer_id') > 1 THEN
    RAISE EXCEPTION 'Retainers in different currencies cannot share an invoice';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('retainer-draft:' || p_project_id::text));
  SELECT COALESCE(payment_terms_days, 0) INTO terms FROM public.project_billing_plans WHERE project_id = p_project_id;

  INSERT INTO public.project_invoices (
    project_id, invoice_number, amount, status, invoice_type, line_items,
    date, due_date, description, auto_generated, created_by, currency
  )
  SELECT
    p_project_id,
    public.next_project_invoice_number(p_project_id),
    (SELECT COALESCE(SUM((line->>'amount')::numeric), 0) FROM jsonb_array_elements(p_lines) line),
    'draft',
    'recurring',
    p_lines,
    to_char(p_invoice_date, 'YYYY-MM-DD'),
    to_char(p_invoice_date + COALESCE(terms, 0), 'YYYY-MM-DD'),
    '',
    p_auto,
    public.current_team_member_id(),
    -- The retainer's own currency, so a later workspace change never relabels its bills.
    COALESCE(
      (SELECT r.currency FROM public.project_retainers r
       WHERE r.id::text = (SELECT line->>'retainer_id' FROM jsonb_array_elements(p_lines) line
                           WHERE line->>'retainer_id' IS NOT NULL LIMIT 1)),
      public.workspace_currency())
  RETURNING * INTO saved;

  IF p_auto THEN
    SELECT name INTO project_name FROM public.projects WHERE id = p_project_id;
    PERFORM public.announce_billing_draft(
      saved.id,
      'Retainer invoice drafted',
      saved.invoice_number || ' for ' || COALESCE(project_name, 'a project') || ' is ready to review and send: '
        || public.format_money(saved.amount, saved.currency, true) || '.'
    );
  END IF;

  RETURN saved;
END;
$$;

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
  recipient uuid;
  project_name text;
BEGIN
  INSERT INTO public.project_retainer_periods (retainer_id, period_start, period_end, status)
  SELECT due.retainer_id, due.period_start, due.period_end, 'skipped'
  FROM public.retainer_due_periods_internal(NULL, as_of) due
  WHERE due.retainer_status = 'paused'
  ON CONFLICT (retainer_id, period_start) DO NOTHING;

  FOR target IN
    SELECT DISTINCT due.project_id, r.currency
    FROM public.retainer_due_periods_internal(NULL, as_of) due
    JOIN public.project_retainers r ON r.id = due.retainer_id
    WHERE due.retainer_status = 'active'
  LOOP
    BEGIN
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
        JOIN public.project_retainers r ON r.id = inner_due.retainer_id
        WHERE inner_due.retainer_status = 'active' AND r.currency = target.currency
      ) due;

      draft := public.create_retainer_draft_internal(target.project_id, lines, invoice_date, true);
      IF draft.id IS NOT NULL THEN
        created := created + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, detail)
      VALUES (target.project_id, 'retainer-failed:' || to_char(as_of, 'YYYY-MM-DD'), as_of, 'failed',
              left('Retainer draft: ' || SQLERRM, 500))
      ON CONFLICT (project_id, run_key) DO UPDATE SET detail = EXCLUDED.detail, created_at = now();
      SELECT name INTO project_name FROM public.projects WHERE id = target.project_id;
      FOR recipient IN
        SELECT id FROM public.team_members WHERE status = 'active'
          AND (public.member_has_permission(id, 'invoices.read') OR public.member_has_permission(id, 'invoices.manage'))
      LOOP
        PERFORM public.upsert_notification(
          recipient,
          'Retainer draft failed',
          'The retainer invoice for ' || COALESCE(project_name, 'a project') || ' could not be drafted: '
            || left(SQLERRM, 200) || '. Generate it from Billing, Retainers, once fixed.',
          '/projects/' || target.project_id::text || '?tab=invoices',
          'project',
          target.project_id::text
        );
      END LOOP;
    END;
  END LOOP;

  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION public.place_hours_draft(
  p_project_id uuid,
  p_draft jsonb,
  p_date date,
  p_combine boolean,
  OUT invoice_id uuid,
  OUT merged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.project_invoices;
  terms integer;
  project_name text;
  line jsonb;
  line_id text := gen_random_uuid()::text;
  draft_currency text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('retainer-draft:' || p_project_id::text));
  SELECT COALESCE(payment_terms_days, 0), currency INTO terms, draft_currency FROM public.project_billing_plans WHERE project_id = p_project_id;
  draft_currency := COALESCE(draft_currency, public.workspace_currency());
  SELECT name INTO project_name FROM public.projects WHERE id = p_project_id;
  merged := false;

  IF p_combine THEN
    SELECT * INTO target FROM public.project_invoices i
    WHERE i.project_id = p_project_id AND i.status = 'draft' AND i.auto_generated AND i.deleted_at IS NULL
      AND i.date = to_char(p_date, 'YYYY-MM-DD')
      AND i.currency = draft_currency
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.line_items) l WHERE l->>'item_type' = 'hourly')
    ORDER BY i.created_at
    LIMIT 1;
    merged := FOUND;
  END IF;

  line := jsonb_build_object(
    'id', line_id,
    'position', CASE WHEN merged THEN jsonb_array_length(target.line_items) ELSE 0 END,
    'item_type', 'hourly',
    'amount', (p_draft->>'amount')::numeric,
    'description', p_draft->>'description',
    'service_start_date', NULL,
    'service_end_date', NULL,
    'recurrence_frequency', NULL
  );

  IF merged THEN
    UPDATE public.project_invoices
    SET line_items = line_items || jsonb_build_array(line),
        amount = amount + (p_draft->>'amount')::numeric
    WHERE id = target.id;
    invoice_id := target.id;
  ELSE
    INSERT INTO public.project_invoices (
      project_id, invoice_number, amount, status, invoice_type, line_items,
      date, due_date, description, auto_generated, created_by, currency
    ) VALUES (
      p_project_id,
      public.next_project_invoice_number(p_project_id),
      (p_draft->>'amount')::numeric,
      'draft',
      'hourly',
      jsonb_build_array(line),
      to_char(p_date, 'YYYY-MM-DD'),
      to_char(p_date + COALESCE(terms, 0), 'YYYY-MM-DD'),
      '',
      true,
      NULL,
      draft_currency
    )
    RETURNING id INTO invoice_id;
  END IF;

  INSERT INTO public.invoice_time_entry_allocations (invoice_id, line_item_id, time_entry_id, start_offset_hours, allocated_hours, allocated_amount)
  SELECT invoice_id, line_id, (a->>'time_entry_id')::uuid, (a->>'start_offset_hours')::numeric,
         (a->>'allocated_hours')::numeric, (a->>'allocated_amount')::numeric
  FROM jsonb_array_elements(p_draft->'allocations') a;
  PERFORM public.validate_invoice_time_allocations(invoice_id);

  PERFORM public.announce_billing_draft(
    invoice_id,
    CASE WHEN merged THEN 'Hours added to a drafted invoice' ELSE 'Invoice drafted' END,
    (SELECT invoice_number FROM public.project_invoices WHERE id = invoice_id) || ' for ' || COALESCE(project_name, 'a project')
      || CASE WHEN merged THEN ' now includes ' ELSE ' covers ' END
      || rtrim(rtrim(to_char(round((p_draft->>'hours')::numeric, 2), 'FM999999990.00'), '0'), '.') || ' h ('
      || public.format_money((p_draft->>'amount')::numeric, draft_currency, true) || '). Ready to review and send.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.run_project_billing(p_plan public.project_billing_plans, p_as_of date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text := public.workspace_timezone();
  run_day date;
  through timestamptz;
  draft jsonb;
  pending record;
  placed record;
  mode text := CASE p_plan.cap_mode WHEN 'amount' THEN 'amount' WHEN 'hours' THEN 'hours' ELSE 'all' END;
  key text;
  n integer := 0;
  drafted integer := 0;
  unbilled jsonb;
BEGIN
  IF p_plan.hours_trigger IN ('days_of_month', 'every_weeks') THEN
    run_day := public.billing_plan_last_date(p_plan, p_as_of);
    IF run_day IS NULL THEN RETURN 0; END IF;
    key := 'day:' || to_char(run_day, 'YYYY-MM-DD');
    IF EXISTS (SELECT 1 FROM public.project_billing_runs WHERE project_id = p_plan.project_id AND run_key = key) THEN RETURN 0; END IF;

    through := (run_day::timestamp) AT TIME ZONE zone;
    draft := public.invoice_hours_draft_internal(p_plan.project_id, mode, CASE WHEN mode = 'all' THEN NULL ELSE p_plan.cap_value END, NULL, through);
    SELECT * INTO pending FROM public.billing_pending_time(p_plan.project_id, through);

    IF draft IS NULL THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, pending_hours, pending_amount)
      VALUES (p_plan.project_id, key, run_day, 'nothing_due', pending.hours, pending.amount);
      RETURN 0;
    END IF;
    IF (draft->>'amount')::numeric < p_plan.min_amount THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, hours, amount, pending_hours, pending_amount, detail)
      VALUES (p_plan.project_id, key, run_day, 'below_minimum', (draft->>'hours')::numeric, (draft->>'amount')::numeric,
              pending.hours, pending.amount, 'Under the ' || public.format_money(p_plan.min_amount, p_plan.currency, true) || ' minimum; the hours wait for the next draft.');
      RETURN 0;
    END IF;

    SELECT * INTO placed FROM public.place_hours_draft(p_plan.project_id, draft, run_day, p_plan.combine_with_retainer);
    INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, invoice_id, hours, amount, pending_hours, pending_amount)
    VALUES (p_plan.project_id, key, run_day, CASE WHEN placed.merged THEN 'merged' ELSE 'drafted' END, placed.invoice_id,
            (draft->>'hours')::numeric, (draft->>'amount')::numeric, pending.hours, pending.amount);
    RETURN 1;
  END IF;

  IF p_plan.hours_trigger IN ('reaches_amount', 'fixed_blocks') THEN
    IF (p_plan.starts_on IS NOT NULL AND p_as_of < p_plan.starts_on) OR (p_plan.ends_on IS NOT NULL AND p_as_of > p_plan.ends_on) THEN
      RETURN 0;
    END IF;
    -- Up to 12 blocks a run, so a long backlog drafts in a few runs, not one burst.
    WHILE n < 12 LOOP
      unbilled := public.invoice_hours_draft_internal(p_plan.project_id, 'all');
      EXIT WHEN unbilled IS NULL OR (unbilled->>'amount')::numeric + 0.005 < p_plan.trigger_amount;
      IF p_plan.hours_trigger = 'fixed_blocks' THEN
        draft := public.invoice_hours_draft_internal(p_plan.project_id, 'amount', p_plan.trigger_amount);
      ELSE
        draft := CASE WHEN mode = 'all' THEN unbilled
                      ELSE public.invoice_hours_draft_internal(p_plan.project_id, mode, p_plan.cap_value) END;
      END IF;
      EXIT WHEN draft IS NULL;
      n := n + 1;
      key := 'amount:' || to_char(p_as_of, 'YYYY-MM-DD') || ':'
        || (SELECT count(*) + 1 FROM public.project_billing_runs WHERE project_id = p_plan.project_id AND run_key LIKE 'amount:' || to_char(p_as_of, 'YYYY-MM-DD') || ':%');
      SELECT * INTO pending FROM public.billing_pending_time(p_plan.project_id, NULL);
      SELECT * INTO placed FROM public.place_hours_draft(p_plan.project_id, draft, p_as_of, false);
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, invoice_id, hours, amount, pending_hours, pending_amount)
      VALUES (p_plan.project_id, key, p_as_of, 'drafted', placed.invoice_id, (draft->>'hours')::numeric, (draft->>'amount')::numeric,
              pending.hours, pending.amount);
      drafted := drafted + 1;
      EXIT WHEN p_plan.hours_trigger = 'reaches_amount';
    END LOOP;
    RETURN drafted;
  END IF;
  RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_forecast_internal(p_project_id uuid, p_from date, p_until date, p_plan jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  plan public.project_billing_plans;
  items jsonb := '[]'::jsonb;
  r record;
  p record;
  handled record;
  inv_id uuid;
  inv_number text;
  inv_status text;
  period_status text;
  d date;
  prev date;
  pace numeric;
  so_far jsonb;
  first_hours boolean := true;
  est numeric;
  next_block date;
  remaining numeric;
  merged jsonb := '[]'::jsonb;
  item jsonb;
  by_date jsonb := '{}'::jsonb;
  k text;
BEGIN
  -- The saved plan, or the one being edited (live preview before Save).
  SELECT * INTO plan FROM public.project_billing_plans WHERE project_id = p_project_id;
  IF p_plan IS NOT NULL THEN
    plan := jsonb_populate_record(COALESCE(plan, ROW(p_project_id, 0, 'manual', '{1}', 2, NULL, NULL, 'none', NULL, 0, true, false, NULL, NULL, NULL, now(), now(), public.workspace_currency())::public.project_billing_plans), p_plan);
    IF plan.hours_trigger <> 'manual' AND plan.starts_on IS NULL THEN plan.starts_on := public.workspace_today(); END IF;
  END IF;

  -- Retainers: each period whose bill date falls in the window.
  FOR r IN SELECT * FROM public.project_retainers WHERE project_id = p_project_id AND deleted_at IS NULL ORDER BY start_date LOOP
    FOR p IN SELECT * FROM public.retainer_periods(r.id, p_from - 62, p_until) LOOP
      CONTINUE WHEN p.bill_date < p_from OR p.bill_date > p_until;
      inv_id := NULL; inv_number := NULL; inv_status := NULL; period_status := NULL;
      SELECT rp.status, i.id, i.invoice_number, i.status INTO period_status, inv_id, inv_number, inv_status
      FROM public.project_retainer_periods rp
      LEFT JOIN public.project_invoices i ON i.id = rp.invoice_id AND i.deleted_at IS NULL
      WHERE rp.retainer_id = r.id AND rp.period_start = p.period_start;
      items := items || jsonb_build_object(
        'date', p.bill_date,
        'source', 'retainer',
        'status', CASE
          WHEN inv_id IS NOT NULL THEN inv_status
          WHEN period_status = 'skipped' THEN 'skipped'
          WHEN r.status = 'paused' THEN 'paused'
          ELSE 'upcoming' END,
        'invoice_id', inv_id,
        'invoice_number', inv_number,
        'line', jsonb_build_object(
          'kind', 'retainer',
          'label', r.name || CASE WHEN p.prorated THEN ' (prorated)' ELSE '' END,
          'amount', p.amount,
          'estimated', false,
          'note', CASE WHEN r.end_date IS NOT NULL AND p.period_end = r.end_date THEN 'Last invoice: the retainer ends ' || to_char(r.end_date, 'Mon FMDD, YYYY') END
        )
      );
    END LOOP;
  END LOOP;

  -- Hours: the pace of approved client work over the last 90 days, per day.
  SELECT COALESCE(sum(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time) * e.hourly_rate), 0) / 90
  INTO pace
  FROM public.project_time_entries e
  WHERE e.project_id = p_project_id AND e.end_time IS NOT NULL AND e.work_type <> 'internal'
    AND e.approval_status = 'approved' AND e.deleted_at IS NULL AND e.start_time >= now() - interval '90 days';
  so_far := public.invoice_hours_draft_internal(p_project_id, 'all');

  IF plan.project_id IS NOT NULL AND plan.hours_trigger IN ('days_of_month', 'every_weeks') THEN
    prev := public.workspace_today();
    FOR d IN SELECT * FROM public.billing_plan_dates(plan, p_from, p_until) LOOP
      -- A drafted invoice since moved to Trash reads as if it was deleted.
      SELECT r2.*, i.id AS live_invoice_id, i.status AS live_status, i.invoice_number AS live_number INTO handled
      FROM public.project_billing_runs r2
      LEFT JOIN public.project_invoices i ON i.id = r2.invoice_id AND i.deleted_at IS NULL
      WHERE r2.project_id = p_project_id AND r2.run_key = 'day:' || to_char(d, 'YYYY-MM-DD');
      IF FOUND THEN
        items := items || jsonb_build_object('date', d, 'source', 'hours',
          'status', CASE WHEN handled.live_invoice_id IS NOT NULL THEN handled.live_status ELSE handled.outcome END,
          'invoice_id', handled.live_invoice_id,
          'invoice_number', handled.live_number,
          'line', jsonb_build_object('kind', 'hours', 'label', 'Hours', 'amount', handled.amount, 'estimated', false,
            'note', CASE WHEN handled.pending_hours > 0 THEN round(handled.pending_hours, 2) || ' h awaiting approval left out' END));
        CONTINUE;
      END IF;
      IF first_hours THEN
        est := COALESCE((so_far->>'amount')::numeric, 0);
        items := items || jsonb_build_object('date', d, 'source', 'hours', 'status', CASE WHEN plan.paused THEN 'paused' ELSE 'upcoming' END,
          'line', jsonb_build_object('kind', 'hours', 'label', 'Hours so far', 'amount', est, 'estimated', true,
            'note', round(COALESCE((so_far->>'hours')::numeric, 0), 2) || ' h unbilled now; more may be added before ' || to_char(d, 'Mon FMDD')));
        first_hours := false;
      ELSE
        est := round(pace * (d - prev), 2);
        items := items || jsonb_build_object('date', d, 'source', 'hours', 'status', CASE WHEN plan.paused THEN 'paused' ELSE 'upcoming' END,
          'line', jsonb_build_object('kind', 'hours', 'label', 'Hours (est.)', 'amount', est, 'estimated', true,
            'note', 'At the last 90 days'' pace'));
      END IF;
      IF plan.cap_mode = 'amount' AND plan.cap_value IS NOT NULL THEN
        items := jsonb_set(items, ARRAY[(jsonb_array_length(items) - 1)::text, 'line', 'amount'],
          to_jsonb(LEAST(est, plan.cap_value)));
      END IF;
      prev := d;
    END LOOP;
  ELSIF plan.project_id IS NOT NULL AND plan.hours_trigger IN ('reaches_amount', 'fixed_blocks') AND plan.trigger_amount IS NOT NULL THEN
    remaining := plan.trigger_amount - COALESCE((so_far->>'amount')::numeric, 0);
    IF pace > 0 THEN
      next_block := public.workspace_today() + GREATEST(0, ceil(remaining / pace))::integer;
      WHILE next_block <= p_until LOOP
        IF next_block >= p_from THEN
          items := items || jsonb_build_object('date', next_block, 'source', 'hours', 'status', CASE WHEN plan.paused THEN 'paused' ELSE 'upcoming' END,
            'line', jsonb_build_object('kind', 'hours',
              'label', CASE WHEN plan.hours_trigger = 'fixed_blocks' THEN 'Block of hours (est. date)' ELSE 'Hours (est. date)' END,
              'amount', plan.trigger_amount, 'estimated', true,
              'note', 'When unbilled hours reach ' || public.format_money(plan.trigger_amount, plan.currency) || ', at the last 90 days'' pace'));
        END IF;
        next_block := next_block + GREATEST(1, ceil(plan.trigger_amount / pace))::integer;
      END LOOP;
    END IF;
  END IF;

  -- One invoice per date: retainer and hours lines on the same date ride
  -- together when the plan combines them.
  -- Retainer lines of one date share an invoice (the retainer job drafts one
  -- per project per date); hours join it when the plan combines them.
  FOR item IN SELECT value FROM jsonb_array_elements(items) ORDER BY (value->>'date')::date, value->>'source' DESC LOOP
    k := CASE WHEN item->>'source' = 'retainer' OR COALESCE(plan.combine_with_retainer, true)
              THEN item->>'date' ELSE (item->>'date') || '#hours' END;
    IF by_date ? k THEN
      by_date := jsonb_set(by_date, ARRAY[k], (by_date->k)
        || jsonb_build_object(
          'sources', CASE WHEN (by_date->k->>'sources') LIKE '%' || (item->>'source') || '%' THEN by_date->k->>'sources'
                          ELSE (by_date->k->>'sources') || ',' || (item->>'source') END,
          'lines', (by_date->k->'lines') || jsonb_build_array(item->'line'),
          'invoice_id', COALESCE(by_date->k->'invoice_id', item->'invoice_id'),
          'invoice_number', COALESCE(by_date->k->'invoice_number', item->'invoice_number')));
    ELSE
      by_date := by_date || jsonb_build_object(k, jsonb_build_object(
        'date', item->>'date', 'sources', item->>'source', 'status', item->>'status',
        'invoice_id', item->'invoice_id', 'invoice_number', item->'invoice_number',
        'lines', jsonb_build_array(item->'line')));
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(
    v || jsonb_build_object(
      'exact', (SELECT COALESCE(sum((l->>'amount')::numeric), 0) FROM jsonb_array_elements(v->'lines') l WHERE NOT (l->>'estimated')::boolean),
      'estimated', (SELECT COALESCE(sum((l->>'amount')::numeric), 0) FROM jsonb_array_elements(v->'lines') l WHERE (l->>'estimated')::boolean)
    ) ORDER BY (v->>'date')::date, v->>'sources'), '[]'::jsonb)
  INTO merged
  FROM jsonb_each(by_date) AS e(key, v);
  RETURN merged;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_trash(p_types text[] DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS TABLE (
  record_type text,
  id uuid,
  label text,
  context text,
  project_id uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_name text,
  blocker text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  spec record;
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
BEGIN
  IF NOT is_service AND public.current_team_member_id() IS NULL THEN
    RETURN;
  END IF;
  FOR spec IN
    SELECT * FROM (VALUES
      ('projects', 'r.name', 'NULL', 'r.id', ''),
      ('tasks', 'r.title', 'CASE WHEN parent.id IS NULL THEN p.name ELSE ''Subtask of '' || parent.title END', 'r.project_id',
        'LEFT JOIN public.projects p ON p.id = r.project_id LEFT JOIN public.tasks parent ON parent.id = r.parent_task_id'),
      ('task_comments', 'left(r.text, 120)', 't.title', 't.project_id', 'LEFT JOIN public.tasks t ON t.id = r.task_id'),
      ('task_files', 'r.name', 't.title', 't.project_id', 'LEFT JOIN public.tasks t ON t.id = r.task_id'),
      ('reminders', 'r.title', 'coalesce(t.title, p.name)', 'r.project_id',
        'LEFT JOIN public.tasks t ON t.id = r.task_id LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_credentials', 'r.label', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('entity_files', 'r.name',
        'CASE r.entity_type WHEN ''project'' THEN (SELECT name FROM public.projects WHERE id = r.entity_id)
           WHEN ''lead'' THEN (SELECT name FROM public.leads WHERE id = r.entity_id)
           WHEN ''contact'' THEN (SELECT name FROM public.contacts WHERE id = r.entity_id) END',
        'CASE WHEN r.entity_type = ''project'' THEN r.entity_id END', ''),
      ('portal_updates', 'r.title', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('portal_update_attachments', 'r.name', 'u.title', 'u.project_id', 'LEFT JOIN public.portal_updates u ON u.id = r.update_id'),
      ('contacts', 'r.name', 'NULL', 'NULL', ''),
      ('leads', 'r.name', 'NULL', 'NULL', ''),
      ('lead_interactions', 'r.title', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('lead_proposals', 'r.title', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('lead_fields', 'r.field_key || '': '' || left(r.value, 80)', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('project_time_entries',
        'coalesce(nullif(btrim(r.description), ''''), ''Time entry'') || '' ('' || to_char(r.start_time AT TIME ZONE public.workspace_timezone(), ''Mon FMDD, YYYY'') || '')''',
        'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_invoices', 'r.invoice_number || '' ('' || public.format_money(r.amount, r.currency, true) || '')''', 'p.name', 'r.project_id',
        'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('invoice_payments', '''Payment of '' || public.format_money(r.amount, i.currency, true) || '' on '' || i.invoice_number', 'p.name', 'i.project_id',
        'LEFT JOIN public.project_invoices i ON i.id = r.invoice_id LEFT JOIN public.projects p ON p.id = i.project_id'),
      ('project_hourly_rates', 'public.format_money(r.hourly_rate, NULL, true) || ''/hr from '' || to_char(r.effective_at AT TIME ZONE public.workspace_timezone(), ''Mon FMDD, YYYY'')',
        'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_retainers', 'r.name', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_retainer_amounts', 'rt.name || '': '' || public.format_money(r.amount, rt.currency, true) || '' from '' || to_char(r.effective_date, ''Mon FMDD, YYYY'')',
        'p.name', 'rt.project_id',
        'LEFT JOIN public.project_retainers rt ON rt.id = r.retainer_id LEFT JOIN public.projects p ON p.id = rt.project_id')
    ) AS specs(record_type, label_sql, context_sql, project_sql, join_sql)
  LOOP
    CONTINUE WHEN p_types IS NOT NULL AND NOT spec.record_type = ANY (p_types);
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, r.id, (%s)::text, (%s)::text, (%s)::uuid, r.deleted_at, r.deleted_by, m.name::text,
              public.trash_restore_blocker(%L, r.id)
       FROM public.%I r %s
       LEFT JOIN public.team_members m ON m.id = r.deleted_by
       WHERE r.deleted_at IS NOT NULL AND ($1 OR public.can_trash_record(%L, r.id))
       ORDER BY r.deleted_at DESC
       LIMIT %s',
      spec.record_type, spec.label_sql, spec.context_sql, spec.project_sql, spec.record_type,
      spec.record_type, spec.join_sql, spec.record_type, greatest(1, least(coalesce(p_limit, 500), 2000)))
    USING is_service;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_payment_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice record;
BEGIN
  SELECT id, project_id, invoice_number, currency INTO v_invoice FROM public.project_invoices WHERE id = NEW.invoice_id;
  IF v_invoice.id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM public.log_team_activity('payment.recorded', 'payment', NEW.id::text, v_invoice.project_id,
    format('Recorded a %s payment on invoice %s', public.format_money(NEW.amount, v_invoice.currency, true), v_invoice.invoice_number),
    jsonb_build_object('invoice_id', v_invoice.id, 'invoice_number', v_invoice.invoice_number, 'amount', NEW.amount));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_trash_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec jsonb := to_jsonb(NEW);
  v_entity text := public.activity_entity_type(TG_TABLE_NAME);
  v_project uuid;
  v_label text;
  v_meta jsonb := jsonb_build_object('record_type', TG_TABLE_NAME);
  v_restored boolean := NEW.deleted_at IS NULL;
  v_currency text;
BEGIN
  v_label := coalesce(
    nullif(rec ->> 'title', ''), nullif(rec ->> 'name', ''), nullif(rec ->> 'label', ''),
    nullif(rec ->> 'invoice_number', ''), nullif(rec ->> 'field_key', ''),
    nullif(left(rec ->> 'text', 80), ''), nullif(left(rec ->> 'description', 80), ''));

  IF TG_TABLE_NAME = 'projects' THEN
    v_project := NEW.id;
  ELSIF rec ? 'project_id' THEN
    v_project := nullif(rec ->> 'project_id', '')::uuid;
  END IF;

  IF rec ? 'task_id' THEN
    v_meta := v_meta || jsonb_build_object('task_id', rec ->> 'task_id');
    IF v_project IS NULL THEN
      SELECT project_id INTO v_project FROM public.tasks WHERE id = (rec ->> 'task_id')::uuid;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'tasks' THEN
    v_meta := v_meta || jsonb_build_object('task_id', NEW.id);
  END IF;
  IF rec ? 'invoice_id' AND v_project IS NULL THEN
    SELECT project_id, invoice_number, currency INTO v_project, v_label, v_currency
    FROM public.project_invoices WHERE id = (rec ->> 'invoice_id')::uuid;
    v_label := public.format_money((rec ->> 'amount')::numeric, v_currency, true) || ' on ' || coalesce(v_label, 'an invoice');
  END IF;
  IF rec ? 'update_id' AND v_project IS NULL THEN
    SELECT project_id INTO v_project FROM public.portal_updates WHERE id = (rec ->> 'update_id')::uuid;
  END IF;
  IF rec ? 'retainer_id' AND v_project IS NULL THEN
    SELECT project_id INTO v_project FROM public.project_retainers WHERE id = (rec ->> 'retainer_id')::uuid;
  END IF;
  IF TG_TABLE_NAME = 'entity_files' THEN
    IF rec ->> 'entity_type' = 'project' THEN
      v_project := (rec ->> 'entity_id')::uuid;
    ELSIF rec ->> 'entity_type' = 'task' THEN
      SELECT project_id INTO v_project FROM public.tasks WHERE id = (rec ->> 'entity_id')::uuid;
      v_meta := v_meta || jsonb_build_object('task_id', rec ->> 'entity_id');
    ELSIF rec ->> 'entity_type' = 'lead' THEN
      v_meta := v_meta || jsonb_build_object('lead_id', rec ->> 'entity_id');
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'leads' THEN
    v_meta := v_meta || jsonb_build_object('lead_id', NEW.id);
  ELSIF rec ? 'lead_id' THEN
    v_meta := v_meta || jsonb_build_object('lead_id', rec ->> 'lead_id');
  END IF;
  IF TG_TABLE_NAME = 'project_time_entries' THEN
    v_label := public.activity_hours_label(public.time_entry_worked_hours(NEW.segments, NEW.start_time, NEW.end_time))
      || ' from ' || public.activity_member_name(NEW.member_id);
  END IF;

  PERFORM public.log_team_activity(
    CASE WHEN v_restored THEN 'record.restored' ELSE 'record.trashed' END,
    v_entity, NEW.id::text, v_project,
    format('%s %s%s%s',
      CASE WHEN v_restored THEN 'Restored' ELSE 'Moved' END,
      public.activity_entity_noun(v_entity),
      CASE WHEN v_label IS NULL THEN '' ELSE format(' "%s"', v_label) END,
      CASE WHEN v_restored THEN '' ELSE ' to Trash' END),
    v_meta);
  RETURN NULL;
END;
$$;
