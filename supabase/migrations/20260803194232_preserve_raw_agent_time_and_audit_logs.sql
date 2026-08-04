-- Preserve each agent session's raw clock data before approval converts its
-- billable duration, and retain API audit records without automatic cleanup.

BEGIN;

ALTER TABLE public.project_time_entries
  ADD COLUMN IF NOT EXISTS raw_time_snapshot jsonb
  CHECK (raw_time_snapshot IS NULL OR jsonb_typeof(raw_time_snapshot) = 'object');

COMMENT ON COLUMN public.project_time_entries.raw_time_snapshot IS
  'Immutable raw clock snapshot captured before agent billing conversion: start/end, pause-resume segments, worked milliseconds, and capture time.';

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
  SELECT * INTO v_entry FROM public.project_time_entries WHERE id = p_entry_id;
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

REVOKE ALL ON FUNCTION public.apply_agent_billing_conversion(uuid, numeric) FROM PUBLIC;

DROP FUNCTION IF EXISTS public.cleanup_api_audit_log();

COMMIT;
