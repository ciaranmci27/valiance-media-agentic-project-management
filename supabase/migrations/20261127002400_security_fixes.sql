-- Security fixes (deep security review of 2.0.50). Additive and safe to run
-- twice; works with the previous release's code.

-- ---------------------------------------------------------------------------
-- Portal PIN: one atomic check per guess
-- ---------------------------------------------------------------------------
-- The PIN check read the recent misses, compared, then wrote the miss, in
-- three requests with no lock: thousands of parallel guesses all read "under
-- the limit" before any miss landed, and a miss from an address the inet
-- column refused (X-Forwarded-For: x) was never counted at all. Now one
-- function locks the portal's settings row, applies the limits, compares and
-- records the miss in one transaction. The limits match src/lib/portal-pin.ts:
-- 5 misses per visitor (address) in 15 minutes, 20 per portal in an hour and
-- 100 per portal in a day, whatever the address. A text that is not an
-- address is stored as null (one shared bucket), never refused.
CREATE TABLE IF NOT EXISTS pm.portal_pin_misses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portal_settings_id uuid NOT NULL REFERENCES pm.portal_settings(id) ON DELETE CASCADE,
  ip inet,
  missed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pm.portal_pin_misses IS
  'Wrong portal PIN guesses, for the limiter in pm.check_portal_pin only. Rows older than a day are dropped as the portal is checked.';

CREATE INDEX IF NOT EXISTS portal_pin_misses_portal_at ON pm.portal_pin_misses (portal_settings_id, missed_at DESC);

ALTER TABLE pm.portal_pin_misses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.portal_pin_misses FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.portal_pin_misses TO service_role;

-- Answers {"result": "ok" | "required" | "invalid" | "locked" | "not_found"},
-- with retry_after_seconds when locked. Checked before the comparison, so a
-- locked visitor learns nothing even with the right PIN.
CREATE OR REPLACE FUNCTION pm.check_portal_pin(p_portal_settings_id uuid, p_pin text, p_ip text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pin text;
  v_ip inet;
  v_now timestamptz := clock_timestamp();
  v_at timestamptz;
  v_retry integer := 0;
BEGIN
  -- One guess at a time per portal: the row lock holds until the miss is written.
  SELECT s.pin INTO v_pin FROM pm.portal_settings s WHERE s.id = p_portal_settings_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF coalesce(v_pin, '') = '' THEN
    RETURN jsonb_build_object('result', 'ok');
  END IF;
  IF coalesce(p_pin, '') = '' THEN
    RETURN jsonb_build_object('result', 'required');
  END IF;
  BEGIN
    v_ip := nullif(btrim(p_ip), '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  DELETE FROM pm.portal_pin_misses m
  WHERE m.portal_settings_id = p_portal_settings_id AND m.missed_at < v_now - interval '1 day';

  -- The lock lifts when the limit-th newest miss in the window ages out.
  SELECT m.missed_at INTO v_at FROM pm.portal_pin_misses m
  WHERE m.portal_settings_id = p_portal_settings_id AND m.ip IS NOT DISTINCT FROM v_ip
    AND m.missed_at > v_now - interval '15 minutes'
  ORDER BY m.missed_at DESC OFFSET 4 LIMIT 1;
  IF FOUND THEN
    v_retry := greatest(v_retry, ceil(extract(epoch FROM (v_at + interval '15 minutes' - v_now)))::integer);
  END IF;
  SELECT m.missed_at INTO v_at FROM pm.portal_pin_misses m
  WHERE m.portal_settings_id = p_portal_settings_id AND m.missed_at > v_now - interval '1 hour'
  ORDER BY m.missed_at DESC OFFSET 19 LIMIT 1;
  IF FOUND THEN
    v_retry := greatest(v_retry, ceil(extract(epoch FROM (v_at + interval '1 hour' - v_now)))::integer);
  END IF;
  SELECT m.missed_at INTO v_at FROM pm.portal_pin_misses m
  WHERE m.portal_settings_id = p_portal_settings_id AND m.missed_at > v_now - interval '1 day'
  ORDER BY m.missed_at DESC OFFSET 99 LIMIT 1;
  IF FOUND THEN
    v_retry := greatest(v_retry, ceil(extract(epoch FROM (v_at + interval '1 day' - v_now)))::integer);
  END IF;
  IF v_retry > 0 THEN
    RETURN jsonb_build_object('result', 'locked', 'retry_after_seconds', greatest(1, v_retry));
  END IF;

  IF p_pin = v_pin THEN
    RETURN jsonb_build_object('result', 'ok');
  END IF;
  INSERT INTO pm.portal_pin_misses (portal_settings_id, ip, missed_at) VALUES (p_portal_settings_id, v_ip, v_now);
  RETURN jsonb_build_object('result', 'invalid');
END;
$$;

REVOKE ALL ON FUNCTION pm.check_portal_pin(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.check_portal_pin(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Chat account links: a code from the chat for links a stranger started
-- ---------------------------------------------------------------------------
-- A link the bot sends to someone it does not know names nobody, so it could
-- be forwarded to another person ("connect your Telegram") and bind the
-- sender's chat account to whoever clicked it. Such a link now carries a
-- short code shown only in that chat (stored hashed with the link's token);
-- the confirm page asks for it, and a few wrong codes use the link up. Links
-- made before this, and links a harness asks for, have no code and confirm
-- as before.
ALTER TABLE pm.identity_link_requests
  ADD COLUMN IF NOT EXISTS confirm_code_hash text,
  ADD COLUMN IF NOT EXISTS code_misses integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN pm.identity_link_requests.confirm_code_hash IS
  'For a link a stranger started in a chat: sha256 of the token and the code the bot showed there. Confirming needs the code.';
