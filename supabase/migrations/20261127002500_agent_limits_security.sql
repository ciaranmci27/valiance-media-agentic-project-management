-- Agent limits and setup security (deep security review of 2.0.50, findings
-- 3, 8 and 9). Additive and safe to run twice; works with the previous
-- release's code, which never reads the new columns, table or functions.
--
-- - Spend only goes up for a run: pm.agent_runs keeps the larger cost_usd,
--   tokens_in and tokens_out when an update would lower them (the server
--   refuses such an update first, 409 spend_decrease; this is the backstop).
-- - A run's spend is the larger of what it reports itself and the usage
--   attached to it (pm.agent_spend_facts), so a small cost on the run never
--   hides the usage reported under it.
-- - Two more per-agent limits on pm.agent_limits: write_rate_per_minute
--   (writes a minute across all the agent's keys) and send_rate_per_minute
--   (chat out, notifications, questions and approvals). Null is no limit, as
--   for every limit; agents made before keep none.
-- - pm.agent_write_gate: one call per write from an agent. It refuses the
--   write while the agent's budget is spent or one of its unfinished runs is
--   past max_run_spend_cents, and counts the write (and a send) in windows
--   of their own. Server only.
-- - pm.api_keys.ai_setup_session_id: the AI setup session that made a key,
--   so the setup screen lists every key a session made, with Revoke.
-- - pm.ai_setup_confirms: what an AI setup session asked for that waits on
--   the Owner's yes in the app (powers beyond the agent's template that
--   touch money, people, settings, acting for someone, keys or webhooks,
--   and a webhook to an address no live webhook uses yet).

-- ---------------------------------------------------------------------------
-- Spend only goes up for a run
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.agent_runs_spend_only_up()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF OLD.cost_usd IS NOT NULL AND (NEW.cost_usd IS NULL OR NEW.cost_usd < OLD.cost_usd) THEN
    NEW.cost_usd := OLD.cost_usd;
  END IF;
  IF OLD.tokens_in IS NOT NULL AND (NEW.tokens_in IS NULL OR NEW.tokens_in < OLD.tokens_in) THEN
    NEW.tokens_in := OLD.tokens_in;
  END IF;
  IF OLD.tokens_out IS NOT NULL AND (NEW.tokens_out IS NULL OR NEW.tokens_out < OLD.tokens_out) THEN
    NEW.tokens_out := OLD.tokens_out;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.agent_runs_spend_only_up() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS agent_runs_spend_only_up ON pm.agent_runs;
CREATE TRIGGER agent_runs_spend_only_up
  BEFORE UPDATE OF cost_usd, tokens_in, tokens_out ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.agent_runs_spend_only_up();

-- ---------------------------------------------------------------------------
-- Spend facts: a run counts the larger of its own report and its usage
-- ---------------------------------------------------------------------------
-- The same rule as before (20261125000800_agent_spend.sql), except for a run
-- with usage attached: its cost and tokens are the larger of the run's own
-- and the usage's, never the smaller, so neither report can hide the other.
CREATE OR REPLACE FUNCTION pm.agent_spend_facts(p_from timestamptz, p_to timestamptz, p_agent_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  source text,
  source_id text,
  agent_id uuid,
  project_id uuid,
  model text,
  provider text,
  labels text[],
  at timestamptz,
  tokens_in bigint,
  tokens_out bigint,
  tokens_cached bigint,
  cost_usd numeric,
  principal_id uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pm
AS $$
  with usage_in as (
    select a.id, a.agent_id, a.project_id, a.labels, a.metadata as m, a.principal_id,
           coalesce(agent_analytics_ts(a.metadata->>'recorded_at'), a.created_at) as at
    from agent_activities a
    where a.activity_type = 'usage.recorded'
      and a.agent_id is not null
      and a.created_at >= p_from - interval '1 day'
      and (p_agent_ids is null or a.agent_id = any (p_agent_ids))
      and coalesce(agent_analytics_ts(a.metadata->>'recorded_at'), a.created_at) >= p_from
      and coalesce(agent_analytics_ts(a.metadata->>'recorded_at'), a.created_at) < p_to
  ),
  ledger as (
    select distinct u.agent_id from usage_in u
  ),
  runs as (
    select r.id, r.agent_id, r.project_id, r.model, r.provider, r.started_at, r.tokens_in, r.tokens_out, r.cost_usd, r.principal_id
    from agent_runs r
    where r.started_at >= p_from and r.started_at < p_to
      and (p_agent_ids is null or r.agent_id = any (p_agent_ids))
  ),
  run_usage as (
    select r.id,
           sum(agent_analytics_int(a.metadata->>'input_tokens')) as tin,
           sum(agent_analytics_int(a.metadata->>'output_tokens')) as tout,
           sum(agent_analytics_int(a.metadata->>'cached_tokens')) as tcached,
           sum(agent_analytics_num(a.metadata->>'cost_usd')) filter (where agent_analytics_num(a.metadata->>'cost_usd') > 0) as cost
    from runs r
    join agent_activities a on a.metadata->>'run_id' = r.id::text and a.agent_id = r.agent_id
    where a.activity_type = 'usage.recorded'
    group by r.id
  ),
  run_turns as (
    select r.id,
           sum(agent_analytics_int(a.metadata->'tokens'->>'input')) filter (where a.metadata->'tokens' ? 'input') as tin,
           sum(agent_analytics_int(a.metadata->'tokens'->>'output')) filter (where a.metadata->'tokens' ? 'output') as tout
    from runs r
    join agent_activities a on a.metadata->>'run_id' = r.id::text and a.agent_id = r.agent_id
    where a.activity_type = 'turn.completed'
      and a.metadata->>'tokens_scope' = 'turn'
      and coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0) = 0
    group by r.id
  )
  select 'run'::text, r.id::text, r.agent_id, r.project_id, r.model, r.provider, '{}'::text[], r.started_at,
    (case when u.id is not null then greatest(coalesce(r.tokens_in, 0), coalesce(u.tin, 0))
          when coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0) > 0 then coalesce(r.tokens_in, 0)
          when l.agent_id is null then coalesce(t.tin, 0)
          else 0 end)::bigint,
    (case when u.id is not null then greatest(coalesce(r.tokens_out, 0), coalesce(u.tout, 0))
          when coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0) > 0 then coalesce(r.tokens_out, 0)
          when l.agent_id is null then coalesce(t.tout, 0)
          else 0 end)::bigint,
    (case when coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0) > 0 then 0
          when u.id is not null then coalesce(u.tcached, 0)
          else 0 end)::bigint,
    nullif(greatest(coalesce(r.cost_usd, 0), coalesce(u.cost, 0)), 0),
    r.principal_id
  from runs r
  left join run_usage u on u.id = r.id
  left join run_turns t on t.id = r.id
  left join ledger l on l.agent_id = r.agent_id
  union all
  select 'usage'::text, u.id::text, u.agent_id, u.project_id, u.m->>'model', u.m->>'provider', coalesce(u.labels, '{}'::text[]), u.at,
    agent_analytics_int(u.m->>'input_tokens')::bigint,
    agent_analytics_int(u.m->>'output_tokens')::bigint,
    agent_analytics_int(u.m->>'cached_tokens')::bigint,
    case when agent_analytics_num(u.m->>'cost_usd') > 0 then agent_analytics_num(u.m->>'cost_usd') end,
    u.principal_id
  from usage_in u
  where u.m->>'run_id' is null
  union all
  select 'turn'::text, a.id::text, a.agent_id, a.project_id, a.metadata->>'model', null::text, '{}'::text[],
    coalesce(agent_analytics_ts(a.metadata->>'started_at'), a.created_at),
    (case when a.metadata->'tokens' ? 'input' then agent_analytics_int(a.metadata->'tokens'->>'input') else 0 end)::bigint,
    (case when a.metadata->'tokens' ? 'output' then agent_analytics_int(a.metadata->'tokens'->>'output') else 0 end)::bigint,
    0::bigint,
    null::numeric,
    a.principal_id
  from agent_activities a
  where a.activity_type = 'turn.completed'
    and a.agent_id is not null
    and a.metadata->>'tokens_scope' = 'turn'
    and (a.metadata->'tokens' ? 'input' or a.metadata->'tokens' ? 'output')
    and a.metadata->>'run_id' is null
    and a.created_at >= p_from - interval '1 day'
    and (p_agent_ids is null or a.agent_id = any (p_agent_ids))
    and coalesce(agent_analytics_ts(a.metadata->>'started_at'), a.created_at) >= p_from
    and coalesce(agent_analytics_ts(a.metadata->>'started_at'), a.created_at) < p_to
    and not exists (select 1 from ledger l where l.agent_id = a.agent_id)
$$;

REVOKE ALL ON FUNCTION pm.agent_spend_facts(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pm.agent_spend_facts(timestamptz, timestamptz, uuid[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Limits: writes and sends a minute, per agent
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_limits
  ADD COLUMN IF NOT EXISTS write_rate_per_minute integer,
  ADD COLUMN IF NOT EXISTS send_rate_per_minute integer;

ALTER TABLE pm.agent_limits DROP CONSTRAINT IF EXISTS agent_limits_write_rates;
ALTER TABLE pm.agent_limits
  ADD CONSTRAINT agent_limits_write_rates CHECK (
    (write_rate_per_minute IS NULL OR write_rate_per_minute BETWEEN 1 AND 10000)
    AND (send_rate_per_minute IS NULL OR send_rate_per_minute BETWEEN 1 AND 10000)
  );

COMMENT ON COLUMN pm.agent_limits.write_rate_per_minute IS
  'Writes a minute the agent may make across all its keys (429 write_rate_limited after that). Null: no limit of its own.';
COMMENT ON COLUMN pm.agent_limits.send_rate_per_minute IS
  'Chat messages out, notifications, questions and approvals a minute (429 send_rate_limited after that). Null: no limit of its own.';

-- An agent's limits with what counts against them now (as 20261125000800),
-- now with every limit: max_run_spend_cents and the write and send rates.
CREATE OR REPLACE FUNCTION pm.agent_limit_state(p_agent_id uuid, p_with_usage boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_limits pm.agent_limits%ROWTYPE;
  v_period text;
  v_from timestamptz;
  v_to timestamptz;
  v_spent_usd numeric := 0;
  v_spent_tokens bigint := 0;
  v_running integer := 0;
  v_claims integer := 0;
BEGIN
  SELECT * INTO v_limits FROM pm.agent_limits WHERE agent_id = p_agent_id;
  v_period := coalesce(v_limits.budget_period, 'month');
  v_from := date_trunc(v_period, now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_to := (date_trunc(v_period, now() AT TIME ZONE 'UTC') + ('1 ' || v_period)::interval) AT TIME ZONE 'UTC';
  IF p_with_usage OR v_limits.budget_usd IS NOT NULL OR v_limits.budget_tokens IS NOT NULL THEN
  SELECT coalesce(sum(s.spent_usd), 0), coalesce(sum(s.spent_tokens), 0)
    INTO v_spent_usd, v_spent_tokens
  FROM pm.agent_spend(v_from, v_to, ARRAY[p_agent_id]) s;
  END IF;
  IF p_with_usage OR v_limits.max_concurrent_runs IS NOT NULL THEN
  SELECT count(*) INTO v_running FROM pm.agent_runs r
  WHERE r.agent_id = p_agent_id AND r.status = 'running' AND r.updated_at > now() - interval '2 hours';
  SELECT count(*) INTO v_claims FROM pm.tasks t
  WHERE t.claimed_by = p_agent_id AND t.claim_expires_at > now() AND t.deleted_at IS NULL;
  END IF;
  RETURN jsonb_build_object(
    'limits', CASE WHEN v_limits.agent_id IS NULL THEN NULL ELSE jsonb_build_object(
      'max_concurrent_runs', v_limits.max_concurrent_runs,
      'rate_per_minute', v_limits.rate_per_minute,
      'budget_usd', v_limits.budget_usd,
      'budget_tokens', v_limits.budget_tokens,
      'budget_period', v_limits.budget_period,
      'budget_alerted_period', v_limits.budget_alerted_period,
      'max_run_spend_cents', v_limits.max_run_spend_cents,
      'write_rate_per_minute', v_limits.write_rate_per_minute,
      'send_rate_per_minute', v_limits.send_rate_per_minute) END,
    'period_start', v_from,
    'spent_usd', round(v_spent_usd, 4),
    'spent_tokens', v_spent_tokens,
    'running_runs', v_running,
    'live_claims', v_claims);
END;
$$;

REVOKE ALL ON FUNCTION pm.agent_limit_state(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_limit_state(uuid, boolean) TO service_role;

CREATE TABLE IF NOT EXISTS pm.agent_write_windows (
  agent_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL,
  PRIMARY KEY (agent_id, bucket),
  CONSTRAINT agent_write_windows_bucket_check CHECK (bucket IN ('write', 'send')),
  CONSTRAINT agent_write_windows_count_check CHECK (request_count > 0)
);

COMMENT ON TABLE pm.agent_write_windows IS
  'The current minute of writes and sends per agent, for pm.agent_write_gate only. Server only.';

ALTER TABLE pm.agent_write_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.agent_write_windows FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.agent_write_windows TO service_role;

-- ---------------------------------------------------------------------------
-- One gate per write from an agent
-- ---------------------------------------------------------------------------
-- Answers {"refused": null} when the write may go on, else the reason and
-- its numbers: budget_exceeded (the budget this period is spent),
-- run_spend_exceeded (an unfinished run of the agent is past
-- max_run_spend_cents), write_rate_limited or send_rate_limited (with
-- reset_at). The budget and run checks come first and count nothing; the
-- windows count the write, and the send when p_send. An agent without limits
-- answers at once. Server only.
CREATE OR REPLACE FUNCTION pm.agent_write_gate(p_agent_id uuid, p_send boolean DEFAULT false, p_window_seconds integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_limits pm.agent_limits%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_period text;
  v_from timestamptz;
  v_to timestamptz;
  v_spent_usd numeric := 0;
  v_spent_tokens bigint := 0;
  v_run_id uuid;
  v_run_spent numeric;
  v_window pm.agent_write_windows%ROWTYPE;
  v_bucket text;
  v_limit integer;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_window_seconds <= 0 THEN RAISE EXCEPTION 'Invalid window'; END IF;
  SELECT * INTO v_limits FROM pm.agent_limits WHERE agent_id = p_agent_id;
  IF v_limits.agent_id IS NULL THEN RETURN jsonb_build_object('refused', null); END IF;

  IF v_limits.budget_usd IS NOT NULL OR v_limits.budget_tokens IS NOT NULL THEN
    v_period := coalesce(v_limits.budget_period, 'month');
    v_from := date_trunc(v_period, now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_to := (date_trunc(v_period, now() AT TIME ZONE 'UTC') + ('1 ' || v_period)::interval) AT TIME ZONE 'UTC';
    SELECT coalesce(sum(s.spent_usd), 0), coalesce(sum(s.spent_tokens), 0)
      INTO v_spent_usd, v_spent_tokens
    FROM pm.agent_spend(v_from, v_to, ARRAY[p_agent_id]) s;
    IF (v_limits.budget_usd IS NOT NULL AND v_spent_usd >= v_limits.budget_usd)
       OR (v_limits.budget_tokens IS NOT NULL AND v_spent_tokens >= v_limits.budget_tokens) THEN
      RETURN jsonb_build_object(
        'refused', 'budget_exceeded',
        'budget_usd', v_limits.budget_usd,
        'budget_tokens', v_limits.budget_tokens,
        'budget_period', v_period,
        'period_start', v_from,
        'spent_usd', round(v_spent_usd, 4),
        'spent_tokens', v_spent_tokens);
    END IF;
  END IF;

  IF v_limits.max_run_spend_cents IS NOT NULL THEN
    SELECT r.id, greatest(coalesce(r.cost_usd, 0), coalesce(u.cost, 0))
      INTO v_run_id, v_run_spent
    FROM pm.agent_runs r
    LEFT JOIN LATERAL (
      SELECT sum(agent_analytics_num(a.metadata->>'cost_usd')) FILTER (WHERE agent_analytics_num(a.metadata->>'cost_usd') > 0) AS cost
      FROM pm.agent_activities a
      WHERE a.activity_type = 'usage.recorded' AND a.agent_id = r.agent_id AND a.metadata->>'run_id' = r.id::text
    ) u ON true
    WHERE r.agent_id = p_agent_id AND r.status IN ('running', 'waiting')
      AND greatest(coalesce(r.cost_usd, 0), coalesce(u.cost, 0)) * 100 > v_limits.max_run_spend_cents
    ORDER BY r.started_at
    LIMIT 1;
    IF v_run_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'refused', 'run_spend_exceeded',
        'run_id', v_run_id,
        'spent_usd', round(v_run_spent, 4),
        'max_run_spend_cents', v_limits.max_run_spend_cents);
    END IF;
  END IF;

  FOREACH v_bucket IN ARRAY ARRAY['write', 'send'] LOOP
    v_limit := CASE v_bucket WHEN 'write' THEN v_limits.write_rate_per_minute ELSE v_limits.send_rate_per_minute END;
    CONTINUE WHEN v_limit IS NULL OR (v_bucket = 'send' AND NOT coalesce(p_send, false));
    INSERT INTO pm.agent_write_windows (agent_id, bucket, window_start, request_count)
    VALUES (p_agent_id, v_bucket, v_now, 1)
    ON CONFLICT (agent_id, bucket) DO UPDATE
    SET window_start = CASE WHEN agent_write_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN v_now ELSE agent_write_windows.window_start END,
        request_count = CASE WHEN agent_write_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN 1 ELSE agent_write_windows.request_count + 1 END
    RETURNING * INTO v_window;
    IF v_window.request_count > v_limit THEN
      RETURN jsonb_build_object(
        'refused', v_bucket || '_rate_limited',
        'limit', v_limit,
        'reset_at', v_window.window_start + make_interval(secs => p_window_seconds));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('refused', null);
END;
$$;

REVOKE ALL ON FUNCTION pm.agent_write_gate(uuid, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_write_gate(uuid, boolean, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- AI setup: the keys a session made, and what waits on the Owner
-- ---------------------------------------------------------------------------
ALTER TABLE pm.api_keys
  ADD COLUMN IF NOT EXISTS ai_setup_session_id uuid REFERENCES pm.ai_setup_sessions(id) ON DELETE SET NULL;

COMMENT ON COLUMN pm.api_keys.ai_setup_session_id IS
  'The AI setup session that made this key, so the setup screen lists it with Revoke. Null for every other key.';

CREATE INDEX IF NOT EXISTS idx_api_keys_ai_setup_session ON pm.api_keys (ai_setup_session_id) WHERE ai_setup_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pm.ai_setup_confirms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES pm.ai_setup_sessions(id) ON DELETE CASCADE,
  -- The Owner whose session it is: the only one who may say yes.
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES pm.team_members(id) ON DELETE CASCADE,
  kind text NOT NULL,
  api_key_id uuid REFERENCES pm.api_keys(id) ON DELETE CASCADE,
  webhook_endpoint_id uuid REFERENCES pm.webhook_endpoints(id) ON DELETE CASCADE,
  scopes text[] NOT NULL DEFAULT '{}',
  host text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  CONSTRAINT ai_setup_confirms_kind_check CHECK (kind IN ('key_scopes', 'webhook')),
  CONSTRAINT ai_setup_confirms_status_check CHECK (status IN ('pending', 'allowed', 'declined')),
  CONSTRAINT ai_setup_confirms_shape_check CHECK (
    (kind = 'key_scopes' AND api_key_id IS NOT NULL AND cardinality(scopes) > 0)
    OR (kind = 'webhook' AND webhook_endpoint_id IS NOT NULL)
  ),
  CONSTRAINT ai_setup_confirms_host_length CHECK (host IS NULL OR length(host) <= 255)
);

COMMENT ON TABLE pm.ai_setup_confirms IS
  'What an AI setup session asked for that waits on its Owner''s yes in the app: sensitive powers for a key, or a webhook to a new address (made switched off). Server only.';

CREATE INDEX IF NOT EXISTS idx_ai_setup_confirms_session ON pm.ai_setup_confirms (session_id, created_at);

ALTER TABLE pm.ai_setup_confirms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.ai_setup_confirms FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.ai_setup_confirms TO service_role;
