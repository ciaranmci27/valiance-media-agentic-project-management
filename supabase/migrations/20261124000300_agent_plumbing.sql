-- Agent plumbing: what any agent harness needs to plug in, not only one
-- company's container fleet.
--
-- - Self-reported heartbeats. pm.agent_health.container is optional, and a
--   row carries expected_interval_seconds (how often the agent promises to
--   beat: 30 to 86400, default 60) and status_note (a line on what it is
--   doing, 1 to 280 characters). Readers call a row stale after two missed
--   beats plus a minute: three minutes for the default, as before, and about
--   two hours for an agent that beats hourly from cron, so it does not read
--   as offline between runs.
-- - An agent reports its own row with its own key (the v1 agents heartbeat
--   route and the MCP heartbeat tool). A self-report means the agent is up:
--   it sets container_running true, whether or not the agent has a
--   container; working sets turn_running. It leaves container alone, so a
--   fleet agent that also reports itself keeps its container name, and its
--   expected_interval_seconds stays as last declared when a beat leaves it
--   out. The fleet publisher's body and key (the v1 agents health route,
--   agents.manage) work exactly as before.
-- - agent_health_history keeps recording container_running changes only.
--   The trigger never reads container, so a row without one is recorded the
--   same way. A self-reporter that goes silent shows as offline by
--   staleness, as a silent publisher always has, without a history row.
-- - Idempotency keys. A POST with an Idempotency-Key header runs once per
--   API key, path and key for 24 hours: pm.api_idempotency_keys holds the
--   claim and, for a 2xx answer, the status and body a retry gets back. The
--   same key with another body is refused (422 idempotency_key_reused), and
--   a retry while the first request still runs gets 409. Error answers are
--   not stored, so a retry runs again. A claim still running after 10
--   minutes (a request that died) can be taken over. Service role only; the
--   pm-api-idempotency-cleanup job removes expired rows hourly.
--
-- Additive and safe to run twice. The previous release's code always writes
-- container, never reads the new columns, and never touches the new table
-- or functions; the new columns have defaults.

-- ---------------------------------------------------------------------------
-- Heartbeats
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_health ALTER COLUMN container DROP NOT NULL;
ALTER TABLE pm.agent_health
  ADD COLUMN IF NOT EXISTS expected_interval_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS status_note text;

ALTER TABLE pm.agent_health DROP CONSTRAINT IF EXISTS agent_health_expected_interval_range;
ALTER TABLE pm.agent_health
  ADD CONSTRAINT agent_health_expected_interval_range CHECK (expected_interval_seconds BETWEEN 30 AND 86400);
ALTER TABLE pm.agent_health DROP CONSTRAINT IF EXISTS agent_health_status_note_length;
ALTER TABLE pm.agent_health
  ADD CONSTRAINT agent_health_status_note_length CHECK (status_note IS NULL OR length(status_note) BETWEEN 1 AND 280);

COMMENT ON COLUMN pm.agent_health.container IS
  'The container the fleet publisher watches, when there is one. Null for an agent that reports itself without one.';
COMMENT ON COLUMN pm.agent_health.expected_interval_seconds IS
  'How often this agent promises a beat (30 to 86400 seconds). Readers call the row stale after two missed beats plus a minute.';
COMMENT ON COLUMN pm.agent_health.status_note IS
  'What the agent last said it is doing, from its own heartbeat. Each self-report replaces it.';

-- ---------------------------------------------------------------------------
-- Idempotency keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.api_idempotency_keys (
  api_key_id uuid NOT NULL REFERENCES pm.api_keys(id) ON DELETE CASCADE,
  path text NOT NULL,
  idempotency_key text NOT NULL,
  -- sha256 of the request's query string and body.
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'in_flight',
  response_status integer,
  response_body text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (api_key_id, path, idempotency_key)
);

ALTER TABLE pm.api_idempotency_keys DROP CONSTRAINT IF EXISTS api_idempotency_keys_state_check;
ALTER TABLE pm.api_idempotency_keys
  ADD CONSTRAINT api_idempotency_keys_state_check CHECK (state IN ('in_flight', 'completed'));
ALTER TABLE pm.api_idempotency_keys DROP CONSTRAINT IF EXISTS api_idempotency_keys_key_length;
ALTER TABLE pm.api_idempotency_keys
  ADD CONSTRAINT api_idempotency_keys_key_length CHECK (length(idempotency_key) BETWEEN 1 AND 255);
ALTER TABLE pm.api_idempotency_keys DROP CONSTRAINT IF EXISTS api_idempotency_keys_completed_has_response;
ALTER TABLE pm.api_idempotency_keys
  ADD CONSTRAINT api_idempotency_keys_completed_has_response CHECK (
    state <> 'completed' OR (response_status BETWEEN 200 AND 299 AND response_body IS NOT NULL AND completed_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_api_idempotency_keys_expires ON pm.api_idempotency_keys (expires_at);

COMMENT ON TABLE pm.api_idempotency_keys IS
  'One row per API key, path and Idempotency-Key for 24 hours: the claim, then the 2xx answer a retry gets back. Service role only.';

ALTER TABLE pm.api_idempotency_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.api_idempotency_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.api_idempotency_keys TO service_role;

-- Claims a key for one request. state: claimed (run the handler), replay
-- (answer with status and body), mismatch (another body under this key) or
-- in_flight (the first request is still running). An expired row, or a claim
-- left running for 10 minutes, is taken over as a new claim.
CREATE OR REPLACE FUNCTION pm.claim_api_idempotency_key(
  p_api_key_id uuid,
  p_path text,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_row pm.api_idempotency_keys%ROWTYPE;
BEGIN
  FOR attempt IN 1..3 LOOP
    INSERT INTO pm.api_idempotency_keys (api_key_id, path, idempotency_key, request_hash)
    VALUES (p_api_key_id, p_path, p_idempotency_key, p_request_hash)
    ON CONFLICT (api_key_id, path, idempotency_key) DO NOTHING;
    IF FOUND THEN
      RETURN jsonb_build_object('state', 'claimed');
    END IF;

    SELECT * INTO v_row FROM pm.api_idempotency_keys
    WHERE api_key_id = p_api_key_id AND path = p_path AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    -- Released between the insert and the read: try the insert again.
    CONTINUE WHEN NOT FOUND;

    IF v_row.expires_at <= now()
       OR (v_row.state = 'in_flight' AND v_row.started_at <= now() - interval '10 minutes') THEN
      UPDATE pm.api_idempotency_keys
      SET request_hash = p_request_hash, state = 'in_flight', response_status = NULL, response_body = NULL,
          started_at = now(), completed_at = NULL, expires_at = now() + interval '24 hours'
      WHERE api_key_id = p_api_key_id AND path = p_path AND idempotency_key = p_idempotency_key;
      RETURN jsonb_build_object('state', 'claimed');
    END IF;
    IF v_row.request_hash <> p_request_hash THEN
      RETURN jsonb_build_object('state', 'mismatch');
    END IF;
    IF v_row.state = 'in_flight' THEN
      RETURN jsonb_build_object('state', 'in_flight', 'started_at', v_row.started_at);
    END IF;
    RETURN jsonb_build_object('state', 'replay', 'status', v_row.response_status, 'body', v_row.response_body);
  END LOOP;
  RETURN jsonb_build_object('state', 'in_flight');
END;
$$;

-- Removes expired keys; answers how many.
CREATE OR REPLACE FUNCTION pm.cleanup_api_idempotency_keys()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM pm.api_idempotency_keys WHERE expires_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION pm.claim_api_idempotency_key(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pm.cleanup_api_idempotency_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.claim_api_idempotency_key(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION pm.cleanup_api_idempotency_keys() TO service_role;

-- Expired keys go hourly. Skipped where pg_cron is unavailable (PGlite).
-- Re-running cron.schedule updates the job in place.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is unavailable here; expired idempotency keys will not be cleaned up on a schedule';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('pm-api-idempotency-cleanup', '23 * * * *', $job$SELECT pm.cleanup_api_idempotency_keys();$job$);
END;
$do$;
