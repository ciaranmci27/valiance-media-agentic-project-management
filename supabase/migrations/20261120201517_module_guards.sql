-- Module guards: the paths that skip has_permission() follow the module switch.
--
-- 20261120194316_workspace_modules.sql made has_permission() false for a
-- switched-off module's permissions, so every policy and RPC that asks for a
-- permission already follows the switch. This covers what does not ask:
--   1. scheduled jobs (pg_cron runs as the database owner, past RLS);
--   2. the webhook claim, so nothing is delivered while Webhooks is off;
--   3. policies that read "true" or a member's own id on a module's tables;
--   4. module helpers granted to everyone signed in with no check at all;
--   5. time approval, which with Billing and finance off needs no pay rate
--      and applies no pay or billed-time conversion.
-- Nothing is deleted; switching a module back on restores it. Safe to re-run.

-- 1. Scheduled jobs run only while their module is on. cron.schedule with the
-- same name updates the job in place. Supabase only: skipped where pg_cron is
-- unavailable (PGlite).
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not available; scheduled jobs are not guarded here';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('retainer-drafts', '7 * * * *', $job$SELECT public.generate_retainer_drafts() WHERE public.module_enabled('billing');$job$);
  PERFORM cron.schedule('billing-drafts', '17 * * * *', $job$SELECT public.generate_billing_drafts() WHERE public.module_enabled('billing');$job$);
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_net;
    PERFORM cron.schedule('webhook-retries', '* * * * *', $job$SELECT public.webhook_retry_kick() WHERE public.module_enabled('webhooks') AND public.module_enabled('billing');$job$);
  END IF;
END;
$do$;

-- 2. The dispatcher's claim hands out nothing while Webhooks (or Billing and
-- finance, which it needs) is off: whatever calls it, nothing goes out.
CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(p_limit int DEFAULT 20)
RETURNS TABLE (
  delivery_id uuid,
  attempt_token uuid,
  attempts int,
  endpoint_id uuid,
  endpoint_url text,
  endpoint_secret text,
  event_public_id text,
  event_type text,
  event_sequence bigint,
  resource_id uuid,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  max_attempts constant int := 8;  -- WEBHOOK_MAX_ATTEMPTS
BEGIN
  -- Nothing goes out while Webhooks, or Billing and finance which it needs,
  -- is switched off: deliveries wait in order, their attempts untouched, and
  -- go out once the module is back on.
  IF NOT (public.module_enabled('webhooks') AND public.module_enabled('billing')) THEN
    RETURN;
  END IF;

  -- One claimer at a time, so two runs cannot both pass the ordering check
  -- for the same invoice. Released at commit, before any HTTP happens.
  PERFORM pg_advisory_xact_lock(hashtext('public.claim_webhook_deliveries'));

  -- A lease that ran out on the last attempt has nothing left to retry.
  UPDATE public.webhook_deliveries d
  SET status = 'failed',
      last_error = coalesce(d.last_error, 'Delivery did not finish before its lease expired'),
      attempt_token = NULL,
      lease_expires_at = NULL
  WHERE d.status = 'delivering'
    AND coalesce(d.lease_expires_at, '-infinity') <= now()
    AND d.attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT d.id
    FROM public.webhook_deliveries d
    JOIN public.webhook_events ev ON ev.id = d.webhook_event_id
    JOIN public.webhook_endpoints ep ON ep.id = d.endpoint_id
    WHERE ep.is_active
      AND (
        (d.status = 'pending' AND d.next_attempt_at <= now())
        OR (d.status = 'delivering' AND coalesce(d.lease_expires_at, '-infinity') <= now())
      )
      -- Head of the line: nothing earlier for this invoice and endpoint is
      -- still waiting, and nothing for it is in flight under a live lease.
      AND NOT EXISTS (
        SELECT 1
        FROM public.webhook_deliveries other
        JOIN public.webhook_events other_ev ON other_ev.id = other.webhook_event_id
        WHERE other.endpoint_id = d.endpoint_id
          AND other.id <> d.id
          AND other_ev.resource_type = ev.resource_type
          AND coalesce(other_ev.resource_id, other_ev.id) = coalesce(ev.resource_id, ev.id)
          AND (
            (other.status IN ('pending', 'delivering') AND other_ev.sequence < ev.sequence)
            OR (other.status = 'delivering' AND coalesce(other.lease_expires_at, '-infinity') > now())
          )
      )
    ORDER BY ev.sequence
    LIMIT p_limit
    FOR UPDATE OF d SKIP LOCKED
  )
  UPDATE public.webhook_deliveries d
  SET status = 'delivering',
      attempts = d.attempts + 1,
      last_attempt_at = now(),
      attempt_token = gen_random_uuid(),
      lease_expires_at = now() + interval '2 minutes'
  FROM due, public.webhook_events ev, public.webhook_endpoints e
  WHERE d.id = due.id
    AND ev.id = d.webhook_event_id
    AND e.id = d.endpoint_id
  RETURNING d.id, d.attempt_token, d.attempts,
            e.id, e.url, e.secret,
            ev.event_id, ev.event_type, ev.sequence, ev.resource_id,
            public.webhook_payload_for_endpoint(ev.payload, ev.net_amounts, e.amount_basis);
END;
$$;

-- 3. Policies on module tables that did not go through a module permission.
DROP POLICY IF EXISTS agent_health_select ON public.agent_health;
CREATE POLICY agent_health_select ON public.agent_health FOR SELECT TO authenticated
  USING ((select public.module_enabled('agents')));
DROP POLICY IF EXISTS agent_health_history_select ON public.agent_health_history;
-- Written by the trigger under the service client; signed-in members read.
CREATE POLICY agent_health_history_select ON public.agent_health_history FOR SELECT TO authenticated
  USING ((select public.module_enabled('agents')));

-- The AI agents module's own tables: switched off, nobody reads or writes them.
-- They come from schema_ai_agent.sql and are optional in a fresh install.
DO $$
DECLARE
  agent_table text;
BEGIN
  FOREACH agent_table IN ARRAY ARRAY['project_goals', 'task_suggestions', 'agent_activities'] LOOP
    IF to_regclass('public.' || agent_table) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', agent_table || '_module_on', agent_table);
      EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((select public.module_enabled(%L)))',
        agent_table || '_module_on', agent_table, 'agents');
    END IF;
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS time_entry_tasks_module_on ON public.time_entry_tasks;
-- Which tasks a time entry covers is Time tracking's.
CREATE POLICY time_entry_tasks_module_on ON public.time_entry_tasks AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.module_enabled('time')));

-- 4. Module helpers with no check of their own.
-- Internal helpers of pay and billing, run only by the SECURITY DEFINER
-- functions and triggers that call them. Granted to everyone signed in, they
-- read any member's pay rate, probe payouts, or rewrite an agent's billed
-- time with no permission check and whatever modules are on.
REVOKE ALL ON FUNCTION public.apply_agent_billing_conversion(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_team_member_hourly_rate(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_team_member_payout(uuid) FROM PUBLIC, anon, authenticated;
-- Signed-in members and the service role ask which modules are on; visitors do not.
REVOKE ALL ON FUNCTION public.module_enabled(text) FROM anon;

-- 5. Approving time with Billing and finance off: no rate needed, none set,
-- and an agent's entry keeps its worked time (no billed-slot conversion).
CREATE OR REPLACE FUNCTION public.apply_agent_billing_conversion(
  p_entry_id uuid,
  p_adjusted_minutes numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry public.project_time_entries%ROWTYPE;
  v_role text;
  v_raw_worked_ms numeric;
  v_billing_worked_ms numeric;
  v_multiplier numeric;
  v_billed_end timestamptz;
BEGIN
  -- The billed slot is Billing and finance's: with it off an approved entry
  -- keeps its worked time as recorded.
  IF NOT public.module_enabled('billing') THEN RETURN; END IF;
  SELECT * INTO v_entry FROM public.project_time_entries WHERE id = p_entry_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT role INTO v_role FROM public.team_members WHERE id = v_entry.member_id;
  IF v_role IS DISTINCT FROM 'agent' THEN RETURN; END IF;
  IF v_entry.billing_converted_at IS NOT NULL THEN RETURN; END IF;
  IF v_entry.end_time IS NULL OR v_entry.approval_status <> 'approved' THEN RETURN; END IF;

  SELECT COALESCE(SUM(
    GREATEST(0, EXTRACT(EPOCH FROM (
      (segment->>'end')::timestamptz - (segment->>'start')::timestamptz
    )) * 1000)
  ), 0)
  INTO v_raw_worked_ms
  FROM jsonb_array_elements(COALESCE(v_entry.segments, '[]'::jsonb)) AS segment
  WHERE segment->>'end' IS NOT NULL AND segment->>'start' IS NOT NULL;

  IF p_adjusted_minutes IS NOT NULL AND p_adjusted_minutes > 0 THEN
    v_billing_worked_ms := p_adjusted_minutes * 60000;
  ELSE
    v_billing_worked_ms := v_raw_worked_ms;
  END IF;
  IF v_billing_worked_ms <= 0 THEN RETURN; END IF;

  v_multiplier := COALESCE(NULLIF(v_entry.billing_multiplier, 0), 1);
  IF v_multiplier <= 0 THEN v_multiplier := 1; END IF;
  v_billed_end := v_entry.start_time + make_interval(secs => (v_billing_worked_ms * v_multiplier) / 1000.0);

  UPDATE public.project_time_entries
  SET raw_time_snapshot = COALESCE(v_entry.raw_time_snapshot, jsonb_build_object(
        'version', 1,
        'start_time', v_entry.start_time,
        'end_time', v_entry.end_time,
        'segments', COALESCE(v_entry.segments, '[]'::jsonb),
        'worked_ms', v_raw_worked_ms,
        'captured_at', now()
      )),
      segments = jsonb_build_array(jsonb_build_object(
        'start', to_char(v_entry.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'end', to_char(v_billed_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )),
      end_time = v_billed_end,
      billing_converted_at = now(),
      updated_at = now()
  WHERE id = p_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_time_entries(
  p_entry_ids uuid[],
  p_decision text,
  p_reason text DEFAULT NULL,
  p_adjustments jsonb DEFAULT NULL
)
RETURNS SETOF public.project_time_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.has_permission('time.approve', 'app') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid review decision';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND member_id = public.current_team_member_id()
  ) THEN
    RAISE EXCEPTION 'Time entries cannot be self-approved';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND NOT public.can_access_project(project_id)
  ) THEN
    RAISE EXCEPTION 'Project access denied';
  END IF;
  -- Pay is Billing and finance's: with it off, approving time needs no
  -- compensation rate and sets none.
  IF p_decision = 'approved' AND public.module_enabled('billing') AND EXISTS (
    SELECT 1
    FROM public.project_time_entries entry
    JOIN public.team_members member ON member.id = entry.member_id
    WHERE entry.id = ANY(p_entry_ids)
      AND entry.approval_status IN ('pending', 'rejected')
      AND member.role NOT IN ('owner', 'agent')
      AND NOT EXISTS (
        SELECT 1 FROM public.team_member_hourly_rates rate
        WHERE rate.member_id = entry.member_id
          AND rate.effective_at <= entry.start_time
      )
  ) THEN
    RAISE EXCEPTION 'Compensation rate missing for one or more time entries';
  END IF;

  UPDATE public.project_time_entries entry
  SET approval_status = p_decision,
      compensation_rate = CASE WHEN p_decision = 'approved' AND public.module_enabled('billing')
        THEN public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time)
        ELSE entry.compensation_rate END,
      approved_at = CASE WHEN p_decision = 'approved' THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_decision = 'approved' THEN public.current_team_member_id() ELSE NULL END,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN COALESCE(p_reason, '') ELSE NULL END,
      updated_at = now()
  WHERE entry.id = ANY(p_entry_ids)
    AND entry.approval_status IN ('pending', 'rejected')
    AND entry.end_time IS NOT NULL
    AND entry.deleted_at IS NULL;

  -- Approved agent entries convert to their billed continuous slot here,
  -- optionally with the reviewer's adjusted worked minutes per entry id
  -- (Billing and finance only).
  IF p_decision = 'approved' AND public.module_enabled('billing') THEN
    FOREACH v_id IN ARRAY p_entry_ids LOOP
      PERFORM public.apply_agent_billing_conversion(
        v_id,
        CASE WHEN p_adjustments IS NOT NULL AND p_adjustments ? v_id::text
          THEN (p_adjustments->>v_id::text)::numeric
          ELSE NULL END
      );
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT * FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND deleted_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_time_entries_api(
  p_project_id uuid,
  p_entry_ids uuid[],
  p_decision text,
  p_reason text,
  p_reviewer_id uuid
)
RETURNS SETOF public.project_time_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF COALESCE(array_length(p_entry_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'Select at least one time entry'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Invalid review decision'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_members WHERE id = p_reviewer_id AND status = 'active') THEN RAISE EXCEPTION 'Active reviewer not found'; END IF;
  IF (SELECT count(*) FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND deleted_at IS NULL) <> cardinality(p_entry_ids) THEN RAISE EXCEPTION 'One or more time entries were not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND project_id IS DISTINCT FROM p_project_id) THEN RAISE EXCEPTION 'Time entry does not belong to the project'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND member_id = p_reviewer_id) THEN RAISE EXCEPTION 'Time entries cannot be self-approved'; END IF;
  -- With Billing and finance off, approval needs no rate and sets none.
  IF p_decision = 'approved' AND public.module_enabled('billing') AND EXISTS (
    SELECT 1 FROM public.project_time_entries entry
    JOIN public.team_members member ON member.id = entry.member_id
    WHERE entry.id = ANY(p_entry_ids) AND entry.approval_status = 'pending'
      AND member.role NOT IN ('owner', 'agent')
      AND NOT EXISTS (SELECT 1 FROM public.team_member_hourly_rates rate WHERE rate.member_id = entry.member_id AND rate.effective_at <= entry.start_time)
  ) THEN RAISE EXCEPTION 'Compensation rate missing for one or more time entries'; END IF;
  UPDATE public.project_time_entries entry
  SET approval_status = p_decision,
      compensation_rate = CASE WHEN p_decision = 'approved' AND public.module_enabled('billing') THEN public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time) ELSE entry.compensation_rate END,
      approved_at = CASE WHEN p_decision = 'approved' THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_decision = 'approved' THEN p_reviewer_id ELSE NULL END,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN COALESCE(p_reason, '') ELSE NULL END,
      updated_at = now()
  WHERE entry.id = ANY(p_entry_ids) AND entry.project_id = p_project_id
    AND entry.approval_status = 'pending' AND entry.end_time IS NOT NULL;
  IF p_decision = 'approved' AND public.module_enabled('billing') THEN
    PERFORM public.apply_agent_billing_conversion(entry_id, NULL)
    FROM unnest(p_entry_ids) AS entry_id;
  END IF;
  RETURN QUERY
  SELECT * FROM public.project_time_entries
  WHERE id = ANY(p_entry_ids) AND project_id = p_project_id;
END;
$$;
