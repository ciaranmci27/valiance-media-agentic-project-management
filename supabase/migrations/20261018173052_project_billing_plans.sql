-- Autonomous invoice drafting: billing plans (hourly work), payment terms,
-- the scheduled job, and the forecast.
--
-- A retainer keeps drafting itself exactly as before. A project's billing
-- plan adds WHEN its unbilled hours get drafted:
--   manual          as today (the default; nothing scheduled)
--   days_of_month   on set days, e.g. {1} or {1,16} (31 = the month's last day)
--   every_weeks     every N weeks from weeks_anchor
--   reaches_amount  once unbilled hours reach trigger_amount, draft ALL of them
--   fixed_blocks    each time trigger_amount accrues, draft exactly that much;
--                   the rest (a split session included) waits for the next block
-- cap_mode/cap_value limit one scheduled draft ("up to $3,000"; the rest
-- waits). min_amount skips a draft too small to send. On a day a retainer
-- draft for the project is still an untouched auto draft, its hours go ON
-- that invoice (combine_with_retainer) instead of a second one. Scheduled
-- drafts take hours worked through the end of the day before the draft date.
-- Payment terms set every auto draft's due date (retainer drafts too).
--
-- Drafts only: nothing is ever sent. project_billing_runs records each run,
-- so a rerun or an outage never drafts twice; held hours (20261018172146)
-- mean an amount trigger can never take the same hours twice either.
--
-- Apply BEFORE the app deploy, AFTER 20261018172146_invoice_hours_held_by_drafts.

-- -- Tables ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.project_billing_plans (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 120),
  hours_trigger text NOT NULL DEFAULT 'manual'
    CHECK (hours_trigger IN ('manual', 'days_of_month', 'every_weeks', 'reaches_amount', 'fixed_blocks')),
  days_of_month integer[] NOT NULL DEFAULT '{1}'
    CHECK (cardinality(days_of_month) BETWEEN 1 AND 4
      AND days_of_month <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31]),
  every_weeks integer NOT NULL DEFAULT 2 CHECK (every_weeks BETWEEN 1 AND 12),
  weeks_anchor date,
  trigger_amount numeric(12,2) CHECK (trigger_amount IS NULL OR trigger_amount > 0),
  cap_mode text NOT NULL DEFAULT 'none' CHECK (cap_mode IN ('none', 'amount', 'hours')),
  cap_value numeric(12,4) CHECK (cap_value IS NULL OR cap_value > 0),
  min_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  combine_with_retainer boolean NOT NULL DEFAULT true,
  paused boolean NOT NULL DEFAULT false,
  -- Nothing is drafted before starts_on (set when drafting is switched on, so
  -- turning it on never back-drafts) or after ends_on.
  starts_on date,
  ends_on date,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_billing_plans_weeks_anchor CHECK (hours_trigger <> 'every_weeks' OR weeks_anchor IS NOT NULL),
  CONSTRAINT project_billing_plans_amount CHECK (hours_trigger NOT IN ('reaches_amount', 'fixed_blocks') OR trigger_amount IS NOT NULL),
  CONSTRAINT project_billing_plans_cap CHECK (cap_mode = 'none' OR cap_value IS NOT NULL),
  CONSTRAINT project_billing_plans_dates CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

DROP TRIGGER IF EXISTS set_project_billing_plans_updated_at ON public.project_billing_plans;
CREATE TRIGGER set_project_billing_plans_updated_at
  BEFORE UPDATE ON public.project_billing_plans
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- One row per scheduled date (run_key 'day:YYYY-MM-DD') or amount draft
-- ('amount:YYYY-MM-DD:n'). The unique key is the no-double-drafting guard.
CREATE TABLE IF NOT EXISTS public.project_billing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  run_key text NOT NULL,
  run_date date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('drafted', 'merged', 'nothing_due', 'below_minimum', 'failed')),
  invoice_id uuid REFERENCES public.project_invoices(id) ON DELETE SET NULL,
  hours numeric(14,6),
  amount numeric(12,2),
  -- Time left out because it was not approved yet at the cutoff.
  pending_hours numeric(14,6) NOT NULL DEFAULT 0,
  pending_amount numeric(12,2) NOT NULL DEFAULT 0,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_billing_runs_project_key UNIQUE (project_id, run_key)
);
CREATE INDEX IF NOT EXISTS idx_project_billing_runs_invoice ON public.project_billing_runs (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_billing_runs_project_date ON public.project_billing_runs (project_id, run_date DESC);

-- Every auto draft (retainer or hours) waiting to be announced by email and
-- by the PM agent. Rows go when the invoice goes.
CREATE TABLE IF NOT EXISTS public.billing_draft_notices (
  invoice_id uuid PRIMARY KEY REFERENCES public.project_invoices(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  summary text NOT NULL DEFAULT '',
  emailed_at timestamptz,
  relayed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_billing_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_draft_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_billing_plans_select ON public.project_billing_plans;
CREATE POLICY project_billing_plans_select ON public.project_billing_plans FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND public.can_access_project(project_id));
DROP POLICY IF EXISTS project_billing_runs_select ON public.project_billing_runs;
CREATE POLICY project_billing_runs_select ON public.project_billing_runs FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND public.can_access_project(project_id));
-- Plans are written through save_project_billing_plan; runs and notices by the job.

-- -- Helpers ---------------------------------------------------------------

-- Approved-later time: stopped client time on the project that is not approved
-- (and not rejected), started before the cutoff. Reported, never drafted.
CREATE OR REPLACE FUNCTION public.billing_pending_time(p_project_id uuid, p_through timestamptz)
RETURNS TABLE (hours numeric, amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(sum(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time)), 0),
    COALESCE(round(sum(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time) * e.hourly_rate), 2), 0)
  FROM public.project_time_entries e
  WHERE e.project_id = p_project_id
    AND e.end_time IS NOT NULL
    AND e.work_type <> 'internal'
    AND e.approval_status NOT IN ('approved', 'rejected')
    AND (p_through IS NULL OR e.start_time < p_through)
$$;

-- The most recent scheduled date on or before p_as_of, within the plan's dates.
CREATE OR REPLACE FUNCTION public.billing_plan_last_date(p_plan public.project_billing_plans, p_as_of date)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  candidate date;
  month_start date;
  best date;
  d integer;
  weeks integer;
BEGIN
  IF p_plan.hours_trigger = 'days_of_month' THEN
    FOR month_start IN SELECT generate_series(date_trunc('month', p_as_of) - interval '1 month', date_trunc('month', p_as_of), interval '1 month')::date LOOP
      FOREACH d IN ARRAY p_plan.days_of_month LOOP
        candidate := month_start + (LEAST(d, extract(day FROM (month_start + interval '1 month' - interval '1 day'))::integer) - 1);
        IF candidate <= p_as_of AND (best IS NULL OR candidate > best) THEN best := candidate; END IF;
      END LOOP;
    END LOOP;
  ELSIF p_plan.hours_trigger = 'every_weeks' AND p_plan.weeks_anchor IS NOT NULL AND p_plan.weeks_anchor <= p_as_of THEN
    weeks := p_plan.every_weeks * 7;
    best := p_plan.weeks_anchor + ((p_as_of - p_plan.weeks_anchor) / weeks) * weeks;
  END IF;
  IF best IS NULL OR (p_plan.starts_on IS NOT NULL AND best < p_plan.starts_on)
     OR (p_plan.ends_on IS NOT NULL AND best > p_plan.ends_on) THEN
    RETURN NULL;
  END IF;
  RETURN best;
END;
$$;

-- Scheduled dates in [p_from, p_to], in order (for the forecast).
CREATE OR REPLACE FUNCTION public.billing_plan_dates(p_plan public.project_billing_plans, p_from date, p_to date)
RETURNS SETOF date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  month_start date;
  candidate date;
  d integer;
  weeks integer;
  lo date := GREATEST(p_from, COALESCE(p_plan.starts_on, p_from));
  hi date := LEAST(p_to, COALESCE(p_plan.ends_on, p_to));
BEGIN
  IF hi < lo THEN RETURN; END IF;
  IF p_plan.hours_trigger = 'days_of_month' THEN
    FOR month_start IN SELECT generate_series(date_trunc('month', lo), date_trunc('month', hi), interval '1 month')::date LOOP
      FOR candidate IN
        SELECT DISTINCT month_start + (LEAST(x, extract(day FROM (month_start + interval '1 month' - interval '1 day'))::integer) - 1)
        FROM unnest(p_plan.days_of_month) x ORDER BY 1
      LOOP
        IF candidate BETWEEN lo AND hi THEN RETURN NEXT candidate; END IF;
      END LOOP;
    END LOOP;
  ELSIF p_plan.hours_trigger = 'every_weeks' AND p_plan.weeks_anchor IS NOT NULL THEN
    weeks := p_plan.every_weeks * 7;
    candidate := p_plan.weeks_anchor;
    IF candidate < lo THEN candidate := candidate + ((lo - candidate + weeks - 1) / weeks) * weeks; END IF;
    WHILE candidate <= hi LOOP
      RETURN NEXT candidate;
      candidate := candidate + weeks;
    END LOOP;
  END IF;
END;
$$;

-- -- Drafting --------------------------------------------------------------

-- Announce an auto draft: one bell per owner and admin, keyed to the invoice
-- (a project key would overwrite other unread notices about the project),
-- and a notice row for the email digest and the PM agent.
CREATE OR REPLACE FUNCTION public.announce_billing_draft(p_invoice_id uuid, p_title text, p_message text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.project_invoices;
  recipient uuid;
BEGIN
  SELECT * INTO invoice FROM public.project_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  FOR recipient IN
    SELECT id FROM public.team_members WHERE role IN ('owner', 'admin') AND status = 'active'
  LOOP
    PERFORM public.upsert_notification(
      recipient, p_title, p_message,
      '/projects/' || invoice.project_id::text || '?tab=invoices',
      'invoice', invoice.id::text
    );
  END LOOP;
  INSERT INTO public.billing_draft_notices (invoice_id, project_id, summary)
  VALUES (invoice.id, invoice.project_id, p_message)
  ON CONFLICT (invoice_id) DO UPDATE SET summary = EXCLUDED.summary, emailed_at = NULL, relayed_at = NULL;
END;
$$;

-- The retainer drafter, unchanged except: the due date follows the project's
-- payment terms, and the announcement is per invoice (announce_billing_draft).
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

  PERFORM pg_advisory_xact_lock(hashtext('retainer-draft:' || p_project_id::text));
  SELECT COALESCE(payment_terms_days, 0) INTO terms FROM public.project_billing_plans WHERE project_id = p_project_id;

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
    to_char(p_invoice_date + COALESCE(terms, 0), 'YYYY-MM-DD'),
    '',
    p_auto,
    public.current_team_member_id()
  RETURNING * INTO saved;

  IF p_auto THEN
    SELECT name INTO project_name FROM public.projects WHERE id = p_project_id;
    PERFORM public.announce_billing_draft(
      saved.id,
      'Retainer invoice drafted',
      saved.invoice_number || ' for ' || COALESCE(project_name, 'a project') || ' is ready to review and send: $'
        || to_char(saved.amount, 'FM999,999,990.00') || '.'
    );
  END IF;

  RETURN saved;
END;
$$;

-- Put a drafted hours line (invoice_hours_draft_internal's result) on an
-- invoice dated p_date: onto the project's untouched retainer auto draft of
-- that date when p_combine, else a new draft. Returns (invoice id, merged).
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
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('retainer-draft:' || p_project_id::text));
  SELECT COALESCE(payment_terms_days, 0) INTO terms FROM public.project_billing_plans WHERE project_id = p_project_id;
  SELECT name INTO project_name FROM public.projects WHERE id = p_project_id;
  merged := false;

  IF p_combine THEN
    SELECT * INTO target FROM public.project_invoices i
    WHERE i.project_id = p_project_id AND i.status = 'draft' AND i.auto_generated
      AND i.date = to_char(p_date, 'YYYY-MM-DD')
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
      date, due_date, description, auto_generated, created_by
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
      NULL
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
      || rtrim(rtrim(to_char(round((p_draft->>'hours')::numeric, 2), 'FM999999990.00'), '0'), '.') || ' h ($'
      || to_char((p_draft->>'amount')::numeric, 'FM999,999,990.00') || '). Ready to review and send.'
  );
END;
$$;

-- One project's due hours drafting at p_as_of. Called by the job, each
-- project in its own subtransaction.
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
              pending.hours, pending.amount, 'Under the $' || to_char(p_plan.min_amount, 'FM999,999,990.00') || ' minimum; the hours wait for the next draft.');
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

-- The job: every active plan, each project isolated (one failure is recorded
-- and the others still run). Returns the number of drafts made or topped up.
CREATE OR REPLACE FUNCTION public.generate_billing_drafts(p_as_of date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  as_of date := COALESCE(p_as_of, public.workspace_today());
  plan public.project_billing_plans;
  total integer := 0;
BEGIN
  FOR plan IN
    SELECT p.* FROM public.project_billing_plans p
    JOIN public.projects project ON project.id = p.project_id
    WHERE p.hours_trigger <> 'manual' AND NOT p.paused
      AND project.archived_at IS NULL AND COALESCE(project.status, 'active') NOT IN ('completed', 'archived', 'cancelled')
  LOOP
    BEGIN
      total := total + public.run_project_billing(plan, as_of);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, detail)
      VALUES (plan.project_id, 'failed:' || to_char(as_of, 'YYYY-MM-DD'), as_of, 'failed', left(SQLERRM, 500))
      ON CONFLICT (project_id, run_key) DO UPDATE SET detail = EXCLUDED.detail, created_at = now();
    END;
  END LOOP;
  RETURN total;
END;
$$;

-- Save a project's billing plan (payment terms and hours drafting). Turning
-- drafting on (or changing its trigger) starts it today unless starts_on is
-- given, so it never drafts dates that already passed.
CREATE OR REPLACE FUNCTION public.save_project_billing_plan(p_project_id uuid, p_plan jsonb)
RETURNS public.project_billing_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing public.project_billing_plans;
  saved public.project_billing_plans;
  next_trigger text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'Not allowed to change billing on this project' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM public.project_billing_plans WHERE project_id = p_project_id;
  next_trigger := COALESCE(p_plan->>'hours_trigger', existing.hours_trigger, 'manual');

  INSERT INTO public.project_billing_plans AS plan (
    project_id, payment_terms_days, hours_trigger, days_of_month, every_weeks, weeks_anchor,
    trigger_amount, cap_mode, cap_value, min_amount, combine_with_retainer, paused, starts_on, ends_on, created_by
  ) VALUES (
    p_project_id,
    COALESCE((p_plan->>'payment_terms_days')::integer, existing.payment_terms_days, 0),
    next_trigger,
    CASE WHEN jsonb_typeof(p_plan->'days_of_month') = 'array'
      THEN ARRAY(SELECT DISTINCT x::integer FROM jsonb_array_elements_text(p_plan->'days_of_month') x ORDER BY 1)
      ELSE COALESCE(existing.days_of_month, '{1}') END,
    COALESCE((p_plan->>'every_weeks')::integer, existing.every_weeks, 2),
    CASE WHEN p_plan ? 'weeks_anchor' THEN (p_plan->>'weeks_anchor')::date ELSE existing.weeks_anchor END,
    CASE WHEN p_plan ? 'trigger_amount' THEN (p_plan->>'trigger_amount')::numeric ELSE existing.trigger_amount END,
    COALESCE(p_plan->>'cap_mode', existing.cap_mode, 'none'),
    CASE WHEN p_plan ? 'cap_value' THEN (p_plan->>'cap_value')::numeric ELSE existing.cap_value END,
    COALESCE((p_plan->>'min_amount')::numeric, existing.min_amount, 0),
    COALESCE((p_plan->>'combine_with_retainer')::boolean, existing.combine_with_retainer, true),
    COALESCE((p_plan->>'paused')::boolean, existing.paused, false),
    CASE
      WHEN p_plan ? 'starts_on' THEN (p_plan->>'starts_on')::date
      WHEN next_trigger <> 'manual' AND (existing.project_id IS NULL OR existing.hours_trigger IS DISTINCT FROM next_trigger)
        THEN public.workspace_today()
      ELSE existing.starts_on
    END,
    CASE WHEN p_plan ? 'ends_on' THEN (p_plan->>'ends_on')::date ELSE existing.ends_on END,
    public.current_team_member_id()
  )
  ON CONFLICT (project_id) DO UPDATE SET
    payment_terms_days = EXCLUDED.payment_terms_days,
    hours_trigger = EXCLUDED.hours_trigger,
    days_of_month = EXCLUDED.days_of_month,
    every_weeks = EXCLUDED.every_weeks,
    weeks_anchor = EXCLUDED.weeks_anchor,
    trigger_amount = EXCLUDED.trigger_amount,
    cap_mode = EXCLUDED.cap_mode,
    cap_value = EXCLUDED.cap_value,
    min_amount = EXCLUDED.min_amount,
    combine_with_retainer = EXCLUDED.combine_with_retainer,
    paused = EXCLUDED.paused,
    starts_on = EXCLUDED.starts_on,
    ends_on = EXCLUDED.ends_on
  RETURNING * INTO saved;
  RETURN saved;
END;
$$;

-- -- Forecast --------------------------------------------------------------

-- Every invoice the project's retainers and billing plan will produce from
-- p_from through p_until, oldest first, plus drafts already made for those
-- dates. Fixed amounts are exact; hours are "so far" for the next scheduled
-- draft and an estimate after it (from the last 90 days' pace), and marked so.
-- Computed from the same functions the jobs use, so the preview cannot
-- disagree with what is later drafted.
--   [{ date, kind, status, invoice_id, invoice_number, exact, estimated,
--      lines: [{ kind, label, amount, estimated, note }], notes: [] }]
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
    plan := jsonb_populate_record(COALESCE(plan, ROW(p_project_id, 0, 'manual', '{1}', 2, NULL, NULL, 'none', NULL, 0, true, false, NULL, NULL, NULL, now(), now())::public.project_billing_plans), p_plan);
    IF plan.hours_trigger <> 'manual' AND plan.starts_on IS NULL THEN plan.starts_on := public.workspace_today(); END IF;
  END IF;

  -- Retainers: each period whose bill date falls in the window.
  FOR r IN SELECT * FROM public.project_retainers WHERE project_id = p_project_id ORDER BY start_date LOOP
    FOR p IN SELECT * FROM public.retainer_periods(r.id, p_from - 62, p_until) LOOP
      CONTINUE WHEN p.bill_date < p_from OR p.bill_date > p_until;
      inv_id := NULL; inv_number := NULL; inv_status := NULL; period_status := NULL;
      SELECT rp.status, i.id, i.invoice_number, i.status INTO period_status, inv_id, inv_number, inv_status
      FROM public.project_retainer_periods rp
      LEFT JOIN public.project_invoices i ON i.id = rp.invoice_id
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
    AND e.approval_status = 'approved' AND e.start_time >= now() - interval '90 days';
  so_far := public.invoice_hours_draft_internal(p_project_id, 'all');

  IF plan.project_id IS NOT NULL AND plan.hours_trigger IN ('days_of_month', 'every_weeks') THEN
    prev := public.workspace_today();
    FOR d IN SELECT * FROM public.billing_plan_dates(plan, p_from, p_until) LOOP
      SELECT r2.* INTO handled FROM public.project_billing_runs r2 WHERE r2.project_id = p_project_id AND r2.run_key = 'day:' || to_char(d, 'YYYY-MM-DD');
      IF FOUND THEN
        items := items || jsonb_build_object('date', d, 'source', 'hours',
          'status', CASE WHEN handled.invoice_id IS NOT NULL THEN COALESCE((SELECT status FROM public.project_invoices WHERE id = handled.invoice_id), 'drafted') ELSE handled.outcome END,
          'invoice_id', handled.invoice_id,
          'invoice_number', (SELECT invoice_number FROM public.project_invoices WHERE id = handled.invoice_id),
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
              'note', 'When unbilled hours reach $' || to_char(plan.trigger_amount, 'FM999,999,990.00') || ', at the last 90 days'' pace'));
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

-- What a person may read: one project (invoices.read and project access), or
-- every project they can open (the billing calendar). p_plan previews unsaved
-- settings for one project.
CREATE OR REPLACE FUNCTION public.billing_forecast(p_project_id uuid, p_from date DEFAULT NULL, p_until date DEFAULT NULL, p_plan jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  from_day date := COALESCE(p_from, public.workspace_today());
  until_day date := COALESCE(p_until, from_day + 365);
  project record;
  out jsonb := '[]'::jsonb;
BEGIN
  IF until_day > from_day + 800 THEN until_day := from_day + 800; END IF;
  IF p_project_id IS NOT NULL THEN
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND NOT (public.has_permission('invoices.read', 'app') AND public.can_access_project(p_project_id)) THEN
      RAISE EXCEPTION 'Not allowed to read billing on this project' USING ERRCODE = '42501';
    END IF;
    RETURN public.billing_forecast_internal(p_project_id, from_day, until_day, p_plan);
  END IF;
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.has_permission('invoices.read', 'app') THEN
    RAISE EXCEPTION 'Not allowed to read billing' USING ERRCODE = '42501';
  END IF;
  FOR project IN
    SELECT pr.id, pr.name FROM public.projects pr
    WHERE pr.archived_at IS NULL
      AND (COALESCE(auth.role(), '') = 'service_role' OR public.can_access_project(pr.id))
      AND (EXISTS (SELECT 1 FROM public.project_retainers rt WHERE rt.project_id = pr.id)
        OR EXISTS (SELECT 1 FROM public.project_billing_plans bp WHERE bp.project_id = pr.id AND bp.hours_trigger <> 'manual'))
    ORDER BY pr.name
  LOOP
    SELECT out || COALESCE(jsonb_agg(item || jsonb_build_object('project_id', project.id, 'project_name', project.name)), '[]'::jsonb)
    INTO out
    FROM jsonb_array_elements(public.billing_forecast_internal(project.id, from_day, until_day)) item;
  END LOOP;
  RETURN out;
END;
$$;

-- -- Grants and schedule ---------------------------------------------------

REVOKE ALL ON FUNCTION public.billing_pending_time(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_plan_last_date(public.project_billing_plans, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_plan_dates(public.project_billing_plans, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.announce_billing_draft(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_retainer_draft_internal(uuid, jsonb, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_hours_draft(uuid, jsonb, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_project_billing(public.project_billing_plans, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_billing_drafts(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_forecast_internal(uuid, date, date, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_project_billing_plan(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.billing_forecast(uuid, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_project_billing_plan(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.billing_forecast(uuid, date, date, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_billing_drafts(date) TO service_role;
GRANT SELECT ON public.project_billing_plans, public.project_billing_runs TO authenticated;
GRANT ALL ON public.project_billing_plans, public.project_billing_runs, public.billing_draft_notices TO service_role;

-- Hourly at :17, ten minutes after the retainer job (:07), so a retainer
-- draft for the day exists before hours are combined onto it.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not available; billing drafts will not be scheduled here';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('billing-drafts', '17 * * * *', $job$SELECT public.generate_billing_drafts();$job$);
END;
$do$;
