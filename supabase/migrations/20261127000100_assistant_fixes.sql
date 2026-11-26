-- Assistant fixes: off means on hold, honest chat status, company agents in one step.
--
-- - pm.api_request_gate also answers assistants_off: true for a personal
--   agent (team_members.delegate_of set) while assistants are switched off
--   for the workspace (business_settings.assistants_enabled false). The app
--   refuses its writes with 423, as for any hold; reads, heartbeats and
--   telemetry still work. Everything else it answers is unchanged.
-- - pm.chat_connections.last_refused_at: the last request to a connection's
--   inbound address that failed the provider's check (a wrong Slack signing
--   secret, an old Discord relay secret). Settings > Assistants reads it as
--   "Not receiving" until a verified request arrives after it.
-- - pm.set_chat_connection_agents: the company agents a company connection
--   reaches, and its default, set in one transaction, so removing an agent
--   and the channel mappings that go with it never half happens. Server only.
--
-- Additive and safe to run twice. The previous release's code ignores the
-- new gate field and column and never calls the new function.

-- ---------------------------------------------------------------------------
-- One gate per API request: the rate limit and what is paused
-- ---------------------------------------------------------------------------
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
  v_delegate_of uuid;
  v_rate integer;
  v_window pm.agent_rate_limit_windows%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
  v_workspace_paused timestamptz;
  v_assistants_on boolean;
  v_projects uuid[];
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_default_limit <= 0 OR p_window_seconds <= 0 THEN RAISE EXCEPTION 'Invalid rate limit'; END IF;
  SELECT role, agent_paused_at, delegate_of INTO v_role, v_agent_paused, v_delegate_of FROM pm.team_members WHERE id = p_member_id;
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
    SELECT agents_paused_at, assistants_enabled INTO v_workspace_paused, v_assistants_on FROM pm.business_settings LIMIT 1;
    SELECT array_agg(project_id ORDER BY project_id) INTO v_projects
    FROM pm.project_agents WHERE agent_id = p_member_id AND status = 'paused';
  END IF;
  RETURN v_result || jsonb_build_object(
    'agent', v_role = 'agent',
    'workspace_paused_at', v_workspace_paused,
    'agent_paused_at', CASE WHEN v_role = 'agent' THEN v_agent_paused END,
    'assistants_off', v_role = 'agent' AND v_delegate_of IS NOT NULL AND v_assistants_on IS NOT TRUE,
    'paused_project_ids', to_jsonb(coalesce(v_projects, '{}'::uuid[])));
END;
$$;

REVOKE ALL ON FUNCTION pm.api_request_gate(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.api_request_gate(uuid, uuid, integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- A chat connection's last refused request
-- ---------------------------------------------------------------------------
ALTER TABLE pm.chat_connections ADD COLUMN IF NOT EXISTS last_refused_at timestamptz;

COMMENT ON COLUMN pm.chat_connections.last_refused_at IS
  'The last request to its inbound address that failed the provider''s check (a wrong signing secret, an old relay secret). Not receiving while newer than last_inbound_at.';

-- ---------------------------------------------------------------------------
-- A company connection's agents, in one transaction
-- ---------------------------------------------------------------------------
-- Keeps the agents in p_agent_ids (adding the new ones), removes the rest
-- (their channel mappings go with them, by the foreign key), and marks
-- p_default as the default (none when null). The app checks each agent
-- first (a company agent that may act for people). Server only.
CREATE OR REPLACE FUNCTION pm.set_chat_connection_agents(
  p_connection_id uuid,
  p_agent_ids uuid[],
  p_default uuid,
  p_actor uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF p_default IS NOT NULL AND NOT (p_default = ANY (coalesce(p_agent_ids, '{}'::uuid[]))) THEN
    RAISE EXCEPTION 'The default agent must be one of the agents' USING ERRCODE = '22023';
  END IF;
  DELETE FROM pm.chat_connection_agents
  WHERE connection_id = p_connection_id AND NOT (agent_id = ANY (coalesce(p_agent_ids, '{}'::uuid[])));
  UPDATE pm.chat_connection_agents SET is_default = false WHERE connection_id = p_connection_id AND is_default;
  INSERT INTO pm.chat_connection_agents (connection_id, agent_id, created_by)
  SELECT p_connection_id, a, p_actor FROM unnest(coalesce(p_agent_ids, '{}'::uuid[])) AS a
  ON CONFLICT (connection_id, agent_id) DO NOTHING;
  IF p_default IS NOT NULL THEN
    UPDATE pm.chat_connection_agents SET is_default = true WHERE connection_id = p_connection_id AND agent_id = p_default;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION pm.set_chat_connection_agents(uuid, uuid[], uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.set_chat_connection_agents(uuid, uuid[], uuid, uuid) TO service_role;
