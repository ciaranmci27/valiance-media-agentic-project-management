-- API hardening (2.0.50): extending a claim that already ran out no longer
-- revives it. The holder of an expired claim gets not_held, as the docs say
-- ("409 when you hold no claim: claim it again"), with expired true and when
-- it ran out, so the API can say which. Safe to run twice; the previous
-- release's code reads not_held as 409 already.

CREATE OR REPLACE FUNCTION pm.extend_task_claim(
  p_task_id uuid,
  p_member_id uuid,
  p_lease_minutes integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task pm.tasks;
BEGIN
  IF p_lease_minutes IS NULL OR p_lease_minutes < 1 OR p_lease_minutes > 240 THEN
    RAISE EXCEPTION 'A claim lasts 1 to 240 minutes' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task FROM pm.tasks WHERE id = p_task_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_task.claimed_by IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_held');
  END IF;
  IF v_task.claimed_by <> p_member_id THEN
    IF v_task.claim_expires_at > now() THEN
      RETURN jsonb_build_object('outcome', 'held', 'holder', pm.task_claim_holder(v_task));
    END IF;
    RETURN jsonb_build_object('outcome', 'not_held');
  END IF;
  -- Theirs, but run out: a lapsed claim is no claim. Claim it again.
  IF v_task.claim_expires_at IS NULL OR v_task.claim_expires_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'not_held', 'expired', true, 'expired_at', v_task.claim_expires_at);
  END IF;
  UPDATE pm.tasks SET claim_expires_at = now() + make_interval(mins => p_lease_minutes)
  WHERE id = p_task_id
  RETURNING * INTO v_task;
  RETURN jsonb_build_object('outcome', 'extended', 'task', to_jsonb(v_task));
END;
$$;

REVOKE ALL ON FUNCTION pm.extend_task_claim(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.extend_task_claim(uuid, uuid, integer) TO service_role;
