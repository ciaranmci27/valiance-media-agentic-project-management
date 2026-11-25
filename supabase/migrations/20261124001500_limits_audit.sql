-- Limits, pause switches and a compliance-grade audit log.
--
-- Limits (pm.agent_limits): optional per-agent settings, one row per agent
-- that has any. No row, or a null field, is no limit: nothing changes for
-- an agent until an Owner sets one (a template may suggest them at hire).
-- - max_concurrent_runs: at most this many running runs (starting another is
--   409 limit_concurrent_runs) and this many live claims (claiming another
--   task is 409 limit_concurrent_claims).
-- - rate_per_minute: API requests a minute across all the agent's keys, in
--   place of 120 a minute per key (pm.agent_rate_limit_windows).
-- - budget_usd, budget_tokens per budget_period (day, week or month, UTC):
--   once spent, new runs are refused (402 budget_exceeded) and the agent's
--   owners are told once a period (budget_alerted_period). Usage is always
--   recorded. Spend is read by pm.agent_limit_state.
-- Pause switches:
-- - team_members.agent_paused_at: one agent paused (distinct from suspended,
--   which refuses its keys outright). Its keys still read, beat and report
--   telemetry; other writes are 423 agent_paused.
-- - business_settings.agents_paused_at: every agent paused (the kill
--   switch), 423 agents_paused. An Owner sets it.
-- - project_agents.status paused: the agent cannot write to that project
--   (423 project_paused).
-- - pm.api_request_gate: one call per API request that counts it against
--   the right limit and says what is paused, so pause and limits cost no
--   extra round trip.
-- Audit log (pm.api_audit_log):
-- - Signed-in members and the public key read it only through its row
--   policy and can never write it (anon loses everything; authenticated
--   keeps SELECT). pm.activities gets the same.
-- - Append-only: a row never changes, apart from a deleted member or key
--   leaving a null behind (only through the foreign key), and is removed only by pm.purge_audit_log (the
--   retention job, with the pm.audit_retention transaction flag).
-- - business_settings.audit_retention_days (null: keep forever, the
--   default) and the pm-audit-retention job, daily. Rows the app still reads
--   as state (the template an agent was set up from, the agents a deprovision
--   took ownership of) are kept.
-- - business_settings.audit_redact_keys: more field names to redact, beside
--   the built-in list (secrets, tokens, passwords, keys, authorization).
-- - pm.audit_app_change: signed-in changes to members, keys, agents,
--   settings, permissions and modules write an audit row (via app), whether
--   the browser or a session route made them. API and MCP writes keep
--   logging themselves.
-- - seq and change_txid: the order the export (GET /api/v1/audit/export,
--   permission audit.export, Owners) pages in.
--
-- Order: the audit log's backfill and everything on it come first; what
-- locks team_members and business_settings (new columns, tables that
-- reference team_members, triggers) comes last, so those busy tables are
-- held only for the last moments of the migration.
--
-- Additive and safe to run twice. The previous release's code never reads
-- the new columns, tables or functions: its rate limit call is untouched,
-- its audit writes run as the service role (which keeps every privilege),
-- and nothing is paused or limited until an Owner says so.

-- ---------------------------------------------------------------------------
-- Audit log: order for the export
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS pm.api_audit_log_seq;
REVOKE ALL ON SEQUENCE pm.api_audit_log_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE pm.api_audit_log_seq TO service_role;

ALTER TABLE pm.api_audit_log
  ADD COLUMN IF NOT EXISTS seq bigint,
  ADD COLUMN IF NOT EXISTS change_txid bigint;

COMMENT ON COLUMN pm.api_audit_log.seq IS
  'A number from pm.api_audit_log_seq, given on insert.';
COMMENT ON COLUMN pm.api_audit_log.change_txid IS
  'The transaction that wrote the row (0: before 20261124001500). The export orders by (change_txid, seq).';

-- Rows written before: numbered in time order in one pass, with change_txid
-- 0, and the sequence moved past them. Only rows without a number, so a
-- second run touches nothing (and the append-only trigger below never sees
-- this update).
DO $$
DECLARE
  v_base bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pm.api_audit_log WHERE seq IS NULL) THEN
    SELECT coalesce(max(seq), 0) INTO v_base FROM pm.api_audit_log;
    UPDATE pm.api_audit_log l
    SET seq = v_base + s.rn, change_txid = 0
    FROM (SELECT id, row_number() OVER (ORDER BY timestamp, id) AS rn FROM pm.api_audit_log WHERE seq IS NULL) s
    WHERE l.id = s.id;
    PERFORM setval('pm.api_audit_log_seq', greatest((SELECT max(seq) FROM pm.api_audit_log), 1));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pm.stamp_audit_log_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  NEW.seq := nextval('pm.api_audit_log_seq');
  NEW.change_txid := pg_current_xact_id()::text::bigint;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.stamp_audit_log_order() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stamp_audit_log_order ON pm.api_audit_log;
CREATE TRIGGER stamp_audit_log_order
  BEFORE INSERT ON pm.api_audit_log
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_audit_log_order();

CREATE INDEX IF NOT EXISTS idx_api_audit_log_change ON pm.api_audit_log (change_txid, seq);

-- ---------------------------------------------------------------------------
-- Audit log: who may write it
-- ---------------------------------------------------------------------------
REVOKE ALL ON pm.api_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.api_audit_log TO authenticated;
GRANT ALL ON pm.api_audit_log TO service_role;
REVOKE ALL ON pm.activities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.activities TO authenticated;
GRANT ALL ON pm.activities TO service_role;
-- The 2.0 bridge views (public.<name>, until 2.1) on an upgraded install
-- carry their table's grants exactly.
DO $$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['api_audit_log', 'activities'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.' || v_name) AND relkind = 'v') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_name);
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_name);
      EXECUTE format('GRANT ALL ON public.%I TO service_role', v_name);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Audit log: append-only
-- ---------------------------------------------------------------------------
-- A row never changes. The one exception is a member or key it names being
-- deleted: the foreign key's ON DELETE SET NULL, which runs inside the
-- referential trigger (pg_trigger_depth() > 1), may null that reference. A
-- direct update that nulls one is refused like any other. Rows go only
-- through the retention job, which sets pm.audit_retention for its own
-- transaction.
CREATE OR REPLACE FUNCTION pm.api_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_refs text[] := ARRAY['api_key_id', 'team_member_id', 'principal_id'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'The audit log is append-only: it cannot be truncated' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('pm.audit_retention', true), '') = 'on' AND current_user NOT IN ('anon', 'authenticated') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'The audit log is append-only: rows go only through its retention job' USING ERRCODE = '42501';
  END IF;
  IF pg_trigger_depth() > 1
     AND (to_jsonb(NEW) - v_refs) = (to_jsonb(OLD) - v_refs)
     AND (NEW.api_key_id IS NULL OR NEW.api_key_id IS NOT DISTINCT FROM OLD.api_key_id)
     AND (NEW.team_member_id IS NULL OR NEW.team_member_id IS NOT DISTINCT FROM OLD.team_member_id)
     AND (NEW.principal_id IS NULL OR NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The audit log is append-only: its rows never change' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION pm.api_audit_log_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS api_audit_log_append_only ON pm.api_audit_log;
CREATE TRIGGER api_audit_log_append_only
  BEFORE UPDATE OR DELETE ON pm.api_audit_log
  FOR EACH ROW EXECUTE FUNCTION pm.api_audit_log_append_only();
DROP TRIGGER IF EXISTS api_audit_log_no_truncate ON pm.api_audit_log;
CREATE TRIGGER api_audit_log_no_truncate
  BEFORE TRUNCATE ON pm.api_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION pm.api_audit_log_append_only();

-- ---------------------------------------------------------------------------
-- Audit log: retention
-- ---------------------------------------------------------------------------
-- Removes rows older than business_settings.audit_retention_days (nothing
-- while it is null), keeping the rows the app reads as state, and records
-- how many went. Answers that count. Server and cron only.
CREATE OR REPLACE FUNCTION pm.purge_audit_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_days integer;
  v_count integer := 0;
BEGIN
  SELECT audit_retention_days INTO v_days FROM pm.business_settings LIMIT 1;
  IF v_days IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM set_config('pm.audit_retention', 'on', true);
  DELETE FROM pm.api_audit_log l
  WHERE l.timestamp < now() - make_interval(days => v_days)
    -- The template an agent was set up from (read by its context pack).
    AND NOT coalesce(l.entity_type = 'team_member' AND l.request_body ? 'template', false)
    -- The agents a deprovision took ownership of (read on reactivation).
    AND NOT coalesce(l.endpoint LIKE '/app/team-members/%/deprovision' AND l.request_body->>'step' = 'owner_removed', false);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('pm.audit_retention', 'off', true);
  IF v_count > 0 THEN
    INSERT INTO pm.api_audit_log (method, endpoint, entity_type, request_body, status_code, via)
    VALUES ('DELETE', '/app/audit/retention', 'api_audit_log',
      jsonb_build_object('deleted', v_count, 'retention_days', v_days), 200, 'app');
  END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION pm.purge_audit_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.purge_audit_log() TO service_role;

-- Daily. Skipped where pg_cron is unavailable (PGlite). Re-running
-- cron.schedule updates the job in place.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is unavailable here; run SELECT pm.purge_audit_log() on a schedule to apply audit retention';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('pm-audit-retention', '23 3 * * *', $job$SELECT pm.purge_audit_log();$job$);
END;
$do$;

-- ---------------------------------------------------------------------------
-- Audit log: redaction
-- ---------------------------------------------------------------------------
-- Whether a field name holds a secret: a word such as secret, password or
-- token (never a count or id of one: tokens_in, token_id), an API, private,
-- signing or similar key, or a name in the extra list. The server applies
-- the same rule (src/lib/api/audit-redact.ts).
CREATE OR REPLACE FUNCTION pm.audit_sensitive_key(p_key text, p_extra text[] DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pm
AS $$
DECLARE
  v_name text := lower(coalesce(p_key, ''));
  v_words text[] := array_remove(regexp_split_to_array(lower(coalesce(p_key, '')), '[^a-z0-9]+'), '');
  v_last text;
  v_before text;
BEGIN
  IF p_extra IS NOT NULL AND v_name = ANY (SELECT lower(e) FROM unnest(p_extra) e) THEN
    RETURN true;
  END IF;
  IF cardinality(v_words) = 0 THEN
    RETURN false;
  END IF;
  v_last := v_words[cardinality(v_words)];
  v_before := CASE WHEN cardinality(v_words) > 1 THEN v_words[cardinality(v_words) - 1] END;
  IF v_name IN ('key', 'key_hash', 'x-api-key', 'apikey') THEN
    RETURN true;
  END IF;
  IF v_last IN ('id', 'ids', 'count', 'prefix', 'at', 'type', 'scope', 'scopes', 'status', 'name', 'length', 'expires', 'version') THEN
    RETURN false;
  END IF;
  IF v_words && ARRAY['secret', 'secrets', 'password', 'passwd', 'pwd', 'token', 'authorization', 'cookie', 'apikey', 'credential', 'credentials'] THEN
    RETURN true;
  END IF;
  RETURN v_last = 'key' AND v_before IN ('api', 'private', 'signing', 'encryption', 'secret', 'access', 'app', 'master', 'license', 'bot', 'service', 'webhook');
END;
$$;

REVOKE ALL ON FUNCTION pm.audit_sensitive_key(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.audit_sensitive_key(text, text[]) TO service_role;

-- A value as the audit log stores it: secrets at any depth as [redacted]
-- (null stays null), and any string over 2000 characters cut short.
CREATE OR REPLACE FUNCTION pm.audit_redact(p_value jsonb, p_extra text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pm
AS $$
DECLARE
  v_out jsonb;
  v_key text;
  v_item jsonb;
  v_text text;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      v_out := '{}'::jsonb;
      FOR v_key, v_item IN SELECT key, value FROM jsonb_each(p_value) LOOP
        IF v_item <> 'null'::jsonb AND pm.audit_sensitive_key(v_key, p_extra) THEN
          v_out := v_out || jsonb_build_object(v_key, '[redacted]');
        ELSE
          v_out := v_out || jsonb_build_object(v_key, pm.audit_redact(v_item, p_extra));
        END IF;
      END LOOP;
      RETURN v_out;
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(pm.audit_redact(e, p_extra) ORDER BY o), '[]'::jsonb) INTO v_out
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS a(e, o);
      RETURN v_out;
    WHEN 'string' THEN
      v_text := p_value #>> '{}';
      IF length(v_text) > 2000 THEN
        RETURN to_jsonb(left(v_text, 2000) || '... [truncated, ' || length(v_text) || ' characters]');
      END IF;
      RETURN p_value;
    ELSE
      RETURN p_value;
  END CASE;
END;
$$;

REVOKE ALL ON FUNCTION pm.audit_redact(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.audit_redact(jsonb, text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Audit log: signed-in changes that matter
-- ---------------------------------------------------------------------------
-- One audit row (via app) for a change a signed-in member made: from the
-- browser (auth.uid()) or through a session route that names them
-- (x-actor-via app with x-actor-member-id, honoured only for the service
-- role). API and MCP writes log themselves, so they are skipped here, as are
-- jobs with no person behind them. TG_ARGV[0] is the entity type, TG_ARGV[1]
-- the columns whose change counts on an update ('*' for any). Values are
-- redacted, a webhook endpoint's url keeps only scheme://host, and an
-- update records only the columns that changed.
CREATE OR REPLACE FUNCTION pm.audit_app_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_actor uuid;
  v_headers json;
  v_watch text[] := CASE WHEN TG_NARGS > 1 AND TG_ARGV[1] <> '*' THEN string_to_array(TG_ARGV[1], ',') END;
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_row jsonb;
  v_changed text[];
  v_before jsonb;
  v_after jsonb;
  v_id uuid;
  v_extra text[];
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_actor := pm.current_team_member_id();
  ELSIF coalesce(auth.role(), '') = 'service_role' THEN
    BEGIN
      v_headers := nullif(current_setting('request.headers', true), '')::json;
    EXCEPTION WHEN others THEN
      v_headers := NULL;
    END;
    IF v_headers->>'x-actor-via' = 'app' AND v_headers->>'x-actor-member-id' ~* v_uuid THEN
      v_actor := (v_headers->>'x-actor-member-id')::uuid;
    END IF;
  END IF;
  IF v_actor IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(v_new) n
    WHERE (v_watch IS NULL OR n.key = ANY (v_watch)) AND n.value IS DISTINCT FROM v_old->n.key;
    IF v_changed IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT jsonb_object_agg(k, v_old->k), jsonb_object_agg(k, v_new->k) INTO v_before, v_after FROM unnest(v_changed) k;
  ELSE
    v_before := v_old;
    v_after := v_new;
  END IF;

  -- A webhook endpoint's address keeps only scheme://host: Slack, Discord
  -- and Zapier-style addresses carry their token in the path.
  IF TG_TABLE_NAME = 'webhook_endpoints' THEN
    IF jsonb_typeof(v_before->'url') = 'string' THEN
      v_before := jsonb_set(v_before, '{url}', to_jsonb(coalesce((substring(v_before->>'url' FROM '^([A-Za-z][A-Za-z0-9+.-]*://)') || substring(v_before->>'url' FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#]*@)?([^/?#@]*)')), '[redacted]')));
    END IF;
    IF jsonb_typeof(v_after->'url') = 'string' THEN
      v_after := jsonb_set(v_after, '{url}', to_jsonb(coalesce((substring(v_after->>'url' FROM '^([A-Za-z][A-Za-z0-9+.-]*://)') || substring(v_after->>'url' FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#]*@)?([^/?#@]*)')), '[redacted]')));
    END IF;
  END IF;

  v_row := coalesce(v_new, v_old);
  v_id := CASE
    WHEN v_row->>'id' ~* v_uuid THEN (v_row->>'id')::uuid
    WHEN v_row->>'agent_id' ~* v_uuid THEN (v_row->>'agent_id')::uuid
    WHEN v_row->>'member_id' ~* v_uuid THEN (v_row->>'member_id')::uuid
  END;
  SELECT audit_redact_keys INTO v_extra FROM pm.business_settings LIMIT 1;

  INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, team_member_id, request_body, before_snapshot, after_snapshot, status_code, via)
  VALUES (
    CASE TG_OP WHEN 'INSERT' THEN 'POST' WHEN 'UPDATE' THEN 'PATCH' ELSE 'DELETE' END,
    '/app/' || TG_TABLE_NAME || coalesce('/' || v_id::text, ''),
    TG_ARGV[0], v_id, v_actor,
    CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('changed', to_jsonb(v_changed)) END,
    pm.audit_redact(v_before, v_extra), pm.audit_redact(v_after, v_extra), 200, 'app');
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.audit_app_change() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Audit log: the export
-- ---------------------------------------------------------------------------
-- Audit rows after a position, in (change_txid, seq) order, only from
-- transactions that have finished (as pm.agent_event_export), optionally
-- from a time on. Server only: the API checks audit.export.
CREATE OR REPLACE FUNCTION pm.audit_log_export(
  p_after_txid bigint,
  p_after_seq bigint,
  p_limit integer,
  p_since timestamptz DEFAULT NULL
)
RETURNS TABLE (change_txid bigint, seq bigint, entry jsonb)
LANGUAGE sql
STABLE
SET search_path = pm
AS $$
  WITH horizon AS (
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint AS xmin
  )
  SELECT l.change_txid, l.seq, to_jsonb(l) - 'change_txid' AS entry
  FROM pm.api_audit_log l, horizon h
  WHERE (l.change_txid, l.seq) > (p_after_txid, p_after_seq)
    AND l.change_txid < h.xmin
    AND (p_since IS NULL OR l.timestamp >= p_since)
  ORDER BY l.change_txid, l.seq
  LIMIT greatest(p_limit, 0);
$$;

REVOKE ALL ON FUNCTION pm.audit_log_export(bigint, bigint, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.audit_log_export(bigint, bigint, integer, timestamptz) TO service_role;

-- Permission audit.export is core (no module), so it has no
-- permission_modules row: Owners hold it, no other role does by default.

-- ---------------------------------------------------------------------------
-- Agent limits
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.agent_limits (
  agent_id uuid PRIMARY KEY REFERENCES pm.team_members(id) ON DELETE CASCADE,
  max_concurrent_runs integer,
  rate_per_minute integer,
  budget_usd numeric(12,2),
  budget_tokens bigint,
  budget_period text NOT NULL DEFAULT 'month',
  budget_alerted_period text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL
);

ALTER TABLE pm.agent_limits DROP CONSTRAINT IF EXISTS agent_limits_shape;
ALTER TABLE pm.agent_limits
  ADD CONSTRAINT agent_limits_shape CHECK (
    (max_concurrent_runs IS NULL OR max_concurrent_runs BETWEEN 1 AND 1000)
    AND (rate_per_minute IS NULL OR rate_per_minute BETWEEN 1 AND 10000)
    AND (budget_usd IS NULL OR budget_usd > 0)
    AND (budget_tokens IS NULL OR budget_tokens > 0)
    AND budget_period IN ('day', 'week', 'month')
  );

COMMENT ON TABLE pm.agent_limits IS
  'Optional limits per agent; no row or a null field is no limit. Written and read by the server only.';
COMMENT ON COLUMN pm.agent_limits.budget_alerted_period IS
  'The budget period (its start, as text) whose overrun the agent''s owners were told about, so they hear once a period.';

ALTER TABLE pm.agent_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.agent_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.agent_limits TO service_role;

CREATE TABLE IF NOT EXISTS pm.agent_rate_limit_windows (
  agent_id uuid PRIMARY KEY REFERENCES pm.team_members(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0)
);
ALTER TABLE pm.agent_rate_limit_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.agent_rate_limit_windows FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.agent_rate_limit_windows TO service_role;

-- ---------------------------------------------------------------------------
-- One gate per API request: the rate limit and what is paused
-- ---------------------------------------------------------------------------
-- Counts the request against the agent's own rate_per_minute when it has
-- one (all its keys together), else against the key's default limit
-- (pm.consume_api_rate_limit, as before). For an agent it also answers the
-- kill switch, its own pause and the projects it is paused on. Server only.
CREATE OR REPLACE FUNCTION pm.api_request_gate(
  p_api_key_id uuid,
  p_member_id uuid,
  p_default_limit integer DEFAULT 120,
  p_window_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_role text;
  v_agent_paused timestamptz;
  v_rate integer;
  v_window pm.agent_rate_limit_windows%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
  v_workspace_paused timestamptz;
  v_projects uuid[];
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_default_limit <= 0 OR p_window_seconds <= 0 THEN RAISE EXCEPTION 'Invalid rate limit'; END IF;
  SELECT role, agent_paused_at INTO v_role, v_agent_paused FROM pm.team_members WHERE id = p_member_id;
  IF v_role = 'agent' THEN
    SELECT rate_per_minute INTO v_rate FROM pm.agent_limits WHERE agent_id = p_member_id;
  END IF;
  IF v_rate IS NOT NULL THEN
    INSERT INTO pm.agent_rate_limit_windows (agent_id, window_start, request_count)
    VALUES (p_member_id, v_now, 1)
    ON CONFLICT (agent_id) DO UPDATE
    SET window_start = CASE WHEN agent_rate_limit_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN v_now ELSE agent_rate_limit_windows.window_start END,
        request_count = CASE WHEN agent_rate_limit_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN 1 ELSE agent_rate_limit_windows.request_count + 1 END
    RETURNING * INTO v_window;
    v_result := jsonb_build_object(
      'allowed', v_window.request_count <= v_rate,
      'remaining', GREATEST(0, v_rate - v_window.request_count),
      'reset_at', v_window.window_start + make_interval(secs => p_window_seconds),
      'limit', v_rate,
      'scope', 'agent');
  ELSE
    SELECT to_jsonb(r) INTO v_result FROM pm.consume_api_rate_limit(p_api_key_id, p_default_limit, p_window_seconds) r;
    v_result := v_result || jsonb_build_object('limit', p_default_limit, 'scope', 'key');
  END IF;
  IF v_role = 'agent' THEN
    SELECT agents_paused_at INTO v_workspace_paused FROM pm.business_settings LIMIT 1;
    SELECT array_agg(project_id ORDER BY project_id) INTO v_projects
    FROM pm.project_agents WHERE agent_id = p_member_id AND status = 'paused';
  END IF;
  RETURN v_result || jsonb_build_object(
    'agent', v_role = 'agent',
    'workspace_paused_at', v_workspace_paused,
    'agent_paused_at', CASE WHEN v_role = 'agent' THEN v_agent_paused END,
    'paused_project_ids', to_jsonb(coalesce(v_projects, '{}'::uuid[])));
END;
$$;

REVOKE ALL ON FUNCTION pm.api_request_gate(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.api_request_gate(uuid, uuid, integer, integer) TO service_role;

-- An agent's limits with what counts against them now: running runs and
-- live claims, and spend this budget period (UTC). Spend per measure is the
-- largest of what usage.recorded events, runs and turns report, so the same
-- work reported two ways is not counted twice. Without p_with_usage, only
-- what the agent's limits need is counted (nothing for an agent without
-- limits), so the run and claim checks stay cheap. Server only.
CREATE OR REPLACE FUNCTION pm.agent_limit_state(p_agent_id uuid, p_with_usage boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_limits pm.agent_limits%ROWTYPE;
  v_from timestamptz;
  v_usage_cost numeric := 0;
  v_usage_tokens bigint := 0;
  v_run_cost numeric := 0;
  v_run_tokens bigint := 0;
  v_turn_tokens bigint := 0;
  v_running integer := 0;
  v_claims integer := 0;
BEGIN
  SELECT * INTO v_limits FROM pm.agent_limits WHERE agent_id = p_agent_id;
  v_from := date_trunc(coalesce(v_limits.budget_period, 'month'), now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF p_with_usage OR v_limits.budget_usd IS NOT NULL OR v_limits.budget_tokens IS NOT NULL THEN
  SELECT coalesce(sum(pm.agent_analytics_num(a.metadata->>'cost_usd')), 0),
         coalesce(sum(pm.agent_analytics_int(a.metadata->>'input_tokens') + pm.agent_analytics_int(a.metadata->>'output_tokens')), 0)
    INTO v_usage_cost, v_usage_tokens
  FROM pm.agent_activities a
  WHERE a.agent_id = p_agent_id AND a.activity_type = 'usage.recorded' AND a.created_at >= v_from;
  SELECT coalesce(sum(r.cost_usd), 0), coalesce(sum(coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0)), 0)
    INTO v_run_cost, v_run_tokens
  FROM pm.agent_runs r
  WHERE r.agent_id = p_agent_id AND r.started_at >= v_from;
  SELECT coalesce(sum(pm.agent_analytics_int(a.metadata->'tokens'->>'input') + pm.agent_analytics_int(a.metadata->'tokens'->>'output')), 0)
    INTO v_turn_tokens
  FROM pm.agent_activities a
  WHERE a.agent_id = p_agent_id AND a.activity_type = 'turn.completed' AND a.metadata->>'tokens_scope' = 'turn' AND a.created_at >= v_from;
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
      'budget_alerted_period', v_limits.budget_alerted_period) END,
    'period_start', v_from,
    'spent_usd', round(GREATEST(v_usage_cost, v_run_cost), 4),
    'spent_tokens', GREATEST(v_usage_tokens, v_run_tokens, v_turn_tokens),
    'running_runs', v_running,
    'live_claims', v_claims);
END;
$$;

REVOKE ALL ON FUNCTION pm.agent_limit_state(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_limit_state(uuid, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Pause switches
-- ---------------------------------------------------------------------------
-- Last: these lock team_members and business_settings, briefly.
ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS agent_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_paused_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL;

COMMENT ON COLUMN pm.team_members.agent_paused_at IS
  'When this agent was paused: its keys read, beat and report telemetry, every other write is refused (423 agent_paused). Null: not paused. Only agents.';

ALTER TABLE pm.business_settings
  ADD COLUMN IF NOT EXISTS agents_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS agents_paused_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS audit_retention_days integer,
  ADD COLUMN IF NOT EXISTS audit_redact_keys text[] NOT NULL DEFAULT '{}';

ALTER TABLE pm.business_settings DROP CONSTRAINT IF EXISTS business_settings_audit_retention_days_check;
ALTER TABLE pm.business_settings
  ADD CONSTRAINT business_settings_audit_retention_days_check CHECK (audit_retention_days IS NULL OR audit_retention_days BETWEEN 30 AND 3650);
ALTER TABLE pm.business_settings DROP CONSTRAINT IF EXISTS business_settings_audit_redact_keys_check;
ALTER TABLE pm.business_settings
  ADD CONSTRAINT business_settings_audit_redact_keys_check CHECK (cardinality(audit_redact_keys) <= 100);

COMMENT ON COLUMN pm.business_settings.agents_paused_at IS
  'The kill switch: while set, every agent''s writes are refused (423 agents_paused); reads, heartbeats and telemetry still work. An Owner sets it.';
COMMENT ON COLUMN pm.business_settings.audit_retention_days IS
  'How long audit rows are kept (30 to 3650 days); null keeps them forever. pm.purge_audit_log removes older ones daily.';
COMMENT ON COLUMN pm.business_settings.audit_redact_keys IS
  'More field names whose values the audit log stores as [redacted], beside the built-in list.';

-- Owner-only settings on the business row: the switches before, the kill
-- switch and the audit settings. Admins manage the rest (settings.manage).
CREATE OR REPLACE FUNCTION pm.business_settings_owner_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND (NEW.auto_migrate IS DISTINCT FROM true OR NEW.owners_read_personal_inboxes IS DISTINCT FROM false
       OR NEW.agents_paused_at IS NOT NULL OR NEW.audit_retention_days IS NOT NULL OR NEW.audit_redact_keys <> '{}'))
     OR (TG_OP = 'UPDATE' AND (NEW.auto_migrate IS DISTINCT FROM OLD.auto_migrate
       OR NEW.owners_read_personal_inboxes IS DISTINCT FROM OLD.owners_read_personal_inboxes
       OR NEW.agents_paused_at IS DISTINCT FROM OLD.agents_paused_at
       OR NEW.agents_paused_by IS DISTINCT FROM OLD.agents_paused_by
       OR NEW.audit_retention_days IS DISTINCT FROM OLD.audit_retention_days
       OR NEW.audit_redact_keys IS DISTINCT FROM OLD.audit_redact_keys)) THEN
    IF COALESCE(pm.current_team_member_role(), '') <> 'owner' THEN
      RAISE EXCEPTION 'Only an Owner can change this setting' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.business_settings_owner_columns() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Audit log: where signed-in changes are recorded
-- ---------------------------------------------------------------------------
-- Last, with the other changes to busy tables: each takes a short lock.
DROP TRIGGER IF EXISTS audit_app_change ON pm.team_members;
CREATE TRIGGER audit_app_change AFTER INSERT OR UPDATE OR DELETE ON pm.team_members
  FOR EACH ROW EXECUTE FUNCTION pm.audit_app_change('team_member',
    'role,status,email,auth_user_id,delegate_of,agent_self_assign,agent_close_policy,agent_create_policy,agent_escalate_to,agent_escalate_to_group,agent_profile,agent_paused_at,deleted_at');
DROP TRIGGER IF EXISTS audit_app_change ON pm.team_member_permissions;
CREATE TRIGGER audit_app_change AFTER INSERT OR UPDATE OR DELETE ON pm.team_member_permissions
  FOR EACH ROW EXECUTE FUNCTION pm.audit_app_change('member_permission', '*');
DROP TRIGGER IF EXISTS audit_app_change ON pm.role_permissions;
CREATE TRIGGER audit_app_change AFTER INSERT OR UPDATE OR DELETE ON pm.role_permissions
  FOR EACH ROW EXECUTE FUNCTION pm.audit_app_change('role_permission', '*');
DROP TRIGGER IF EXISTS audit_app_change ON pm.api_keys;
CREATE TRIGGER audit_app_change AFTER INSERT OR UPDATE OR DELETE ON pm.api_keys
  FOR EACH ROW EXECUTE FUNCTION pm.audit_app_change('api_key',
    'name,scopes,permissions,team_member_id,expires_at,disabled_at,revoked_at');
DROP TRIGGER IF EXISTS audit_app_change ON pm.workspace_modules;
CREATE TRIGGER audit_app_change AFTER INSERT OR UPDATE OR DELETE ON pm.workspace_modules
  FOR EACH ROW EXECUTE FUNCTION pm.audit_app_change('workspace_module', 'enabled');
DROP TRIGGER IF EXISTS audit_app_change ON pm.business_settings;
CREATE TRIGGER audit_app_change AFTER INSERT OR UPDATE OR DELETE ON pm.business_settings
  FOR EACH ROW EXECUTE FUNCTION pm.audit_app_change('business_settings', '*');
DROP TRIGGER IF EXISTS audit_app_change ON pm.webhook_endpoints;
CREATE TRIGGER audit_app_change AFTER INSERT OR UPDATE OR DELETE ON pm.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION pm.audit_app_change('webhook_endpoint', '*');
DROP TRIGGER IF EXISTS audit_app_change ON pm.agent_owners;
CREATE TRIGGER audit_app_change AFTER INSERT OR UPDATE OR DELETE ON pm.agent_owners
  FOR EACH ROW EXECUTE FUNCTION pm.audit_app_change('agent_owner', '*');
DROP TRIGGER IF EXISTS audit_app_change ON pm.agent_limits;
CREATE TRIGGER audit_app_change AFTER INSERT OR UPDATE OR DELETE ON pm.agent_limits
  FOR EACH ROW EXECUTE FUNCTION pm.audit_app_change('agent_limits',
    'max_concurrent_runs,rate_per_minute,budget_usd,budget_tokens,budget_period');
