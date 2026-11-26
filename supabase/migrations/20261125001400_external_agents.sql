-- ============================================================
-- EXTERNAL AGENTS (20261125001400_external_agents.sql)
-- The app as the control plane for agents that work in other systems (a
-- bookkeeper in an accounting app): pause and budget reach work done
-- outside, a person can be asked without a project, and the harness hears
-- about pauses and a spent budget.
--
-- - pm.agent_status(member): what an agent checks before each turn, in one
--   call: the workspace pause, its own pause, its limits and its spend this
--   budget period (pm.agent_limit_state, the shared spend rule). Server
--   only: GET /api/v1/agents/me/status reads it for the calling key.
-- - agent.paused and agent.resumed, once per change of whether an agent may
--   start work: its own pause (team_members.agent_paused_at) or the
--   workspace pause (business_settings.agents_paused_at). One event per
--   agent, filtered to it. An agent's own pause while the workspace is
--   paused changes nothing it can do, so it sends nothing; neither does the
--   workspace pause for an agent already paused on its own.
-- - budget.exceeded, once a budget period: when the period whose overrun
--   the owners are told about moves on (agent_limits.budget_alerted_period,
--   claimed once by the server), with the spend at that moment.
-- - questions.ask: an agent may ask a question or request an approval that
--   names no task or project, without tasks.read. Core (no module, so no
--   permission_modules row). Agents hold it on the API, so a key for an
--   agent can carry it. Admins and members hold it on the API too (Owners
--   hold every permission), as with approvals.decide: a key hands on only
--   scopes its own member holds, so whoever hires an agent can give its key
--   this scope and apply the External agent template. No key carries it
--   until someone adds it; people ask with tasks.read as before.
--
-- Additive and safe to run twice. The previous release's code never calls
-- pm.agent_status, and the new events go only to endpoints subscribed to
-- them, which that code cannot make.
-- ============================================================

INSERT INTO pm.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'questions.ask', 'api'),
  ('member', 'questions.ask', 'api'),
  ('agent', 'questions.ask', 'api')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- What an agent checks before each turn
-- ---------------------------------------------------------------------------
-- One call: the member's role, its own pause and the workspace pause (for
-- an agent; people are never paused), its limits and spend this budget
-- period (UTC), and when the period ends. Null for a member that does not
-- exist. Server only.
CREATE OR REPLACE FUNCTION pm.agent_status(p_member_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_role text;
  v_agent_paused timestamptz;
  v_workspace_paused timestamptz;
  v_state jsonb;
  v_period text;
BEGIN
  SELECT role, agent_paused_at INTO v_role, v_agent_paused FROM pm.team_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_role IS DISTINCT FROM 'agent' THEN
    RETURN jsonb_build_object('agent', false, 'workspace_paused_at', NULL, 'agent_paused_at', NULL, 'state', NULL);
  END IF;
  SELECT s.agents_paused_at INTO v_workspace_paused FROM pm.business_settings s ORDER BY s.agents_paused_at NULLS LAST LIMIT 1;
  v_state := pm.agent_limit_state(p_member_id, true);
  v_period := coalesce(v_state->'limits'->>'budget_period', 'month');
  RETURN jsonb_build_object(
    'agent', true,
    'workspace_paused_at', v_workspace_paused,
    'agent_paused_at', v_agent_paused,
    'budget_period', v_period,
    'period_end', (date_trunc(v_period, now() AT TIME ZONE 'UTC') + ('1 ' || v_period)::interval) AT TIME ZONE 'UTC',
    'state', v_state);
END;
$$;

REVOKE ALL ON FUNCTION pm.agent_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_status(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- agent.paused and agent.resumed
-- ---------------------------------------------------------------------------
-- One event for one agent. reason names the switch: agent_paused (its own)
-- or agents_paused (the workspace); on agent.resumed, the one turned off.
CREATE OR REPLACE FUNCTION pm.emit_agent_pause_event(
  p_agent_id uuid,
  p_paused boolean,
  p_reason text,
  p_agent_paused_at timestamptz,
  p_workspace_paused_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  PERFORM pm.emit_webhook_event(
    CASE WHEN p_paused THEN 'agent.paused' ELSE 'agent.resumed' END,
    'agent',
    p_agent_id,
    '{}'::uuid[],
    ARRAY[p_agent_id],
    jsonb_build_object(
      'agent', jsonb_build_object('id', p_agent_id, 'name', coalesce((SELECT a.name FROM pm.team_members a WHERE a.id = p_agent_id), '')),
      'paused', p_paused,
      'reason', p_reason,
      'agent_paused_at', p_agent_paused_at,
      'workspace_paused_at', p_workspace_paused_at,
      'project', NULL,
      'project_id', NULL,
      'task_id', NULL,
      'actor_id', pm.webhook_actor_id()
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_agent_pause_event(uuid, boolean, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- An agent's own pause: sent only while the workspace is not paused (paused
-- there, the agent could not start work either way).
CREATE OR REPLACE FUNCTION pm.emit_agent_pause_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM 'agent' OR (OLD.agent_paused_at IS NULL) = (NEW.agent_paused_at IS NULL) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['agent.paused', 'agent.resumed']
  ) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM pm.business_settings s WHERE s.agents_paused_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  PERFORM pm.emit_agent_pause_event(NEW.id, NEW.agent_paused_at IS NOT NULL, 'agent_paused', NEW.agent_paused_at, NULL);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_agent_pause_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_agent_pause_webhook ON pm.team_members;
CREATE TRIGGER emit_agent_pause_webhook
  AFTER UPDATE OF agent_paused_at ON pm.team_members
  FOR EACH ROW
  WHEN (OLD.agent_paused_at IS DISTINCT FROM NEW.agent_paused_at)
  EXECUTE FUNCTION pm.emit_agent_pause_webhook();

-- The workspace pause: one event for each active agent not paused on its own.
CREATE OR REPLACE FUNCTION pm.emit_workspace_pause_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  r record;
BEGIN
  IF (OLD.agents_paused_at IS NULL) = (NEW.agents_paused_at IS NULL) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['agent.paused', 'agent.resumed']
  ) THEN
    RETURN NULL;
  END IF;
  FOR r IN
    SELECT a.id FROM pm.team_members a
    WHERE a.role = 'agent' AND coalesce(a.status, 'active') = 'active' AND a.agent_paused_at IS NULL
    ORDER BY a.id
  LOOP
    PERFORM pm.emit_agent_pause_event(r.id, NEW.agents_paused_at IS NOT NULL, 'agents_paused', NULL, NEW.agents_paused_at);
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_workspace_pause_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_workspace_pause_webhook ON pm.business_settings;
CREATE TRIGGER emit_workspace_pause_webhook
  AFTER UPDATE OF agents_paused_at ON pm.business_settings
  FOR EACH ROW
  WHEN (OLD.agents_paused_at IS DISTINCT FROM NEW.agents_paused_at)
  EXECUTE FUNCTION pm.emit_workspace_pause_webhook();

-- ---------------------------------------------------------------------------
-- budget.exceeded
-- ---------------------------------------------------------------------------
-- The server claims a period once (compare and swap on
-- budget_alerted_period) when it first sees the budget spent: after usage,
-- at a refused run start, or when the agent reads its status. That claim
-- sends the event, with the spend at that moment.
CREATE OR REPLACE FUNCTION pm.emit_budget_exceeded_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_state jsonb;
BEGIN
  IF NEW.budget_alerted_period IS NULL OR NEW.budget_alerted_period IS NOT DISTINCT FROM OLD.budget_alerted_period THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['budget.exceeded']
  ) THEN
    RETURN NULL;
  END IF;
  v_state := pm.agent_limit_state(NEW.agent_id, true);
  PERFORM pm.emit_webhook_event(
    'budget.exceeded',
    'agent',
    NEW.agent_id,
    '{}'::uuid[],
    ARRAY[NEW.agent_id],
    jsonb_build_object(
      'agent', jsonb_build_object('id', NEW.agent_id, 'name', coalesce((SELECT a.name FROM pm.team_members a WHERE a.id = NEW.agent_id), '')),
      'budget', jsonb_build_object(
        'period', NEW.budget_period,
        'period_start', NEW.budget_alerted_period,
        'budget_usd', NEW.budget_usd,
        'budget_tokens', NEW.budget_tokens,
        'spent_usd', v_state->'spent_usd',
        'spent_tokens', v_state->'spent_tokens'
      ),
      'project', NULL,
      'project_id', NULL,
      'task_id', NULL,
      'actor_id', pm.webhook_actor_id()
    )
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_budget_exceeded_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_budget_exceeded_webhook ON pm.agent_limits;
CREATE TRIGGER emit_budget_exceeded_webhook
  AFTER UPDATE OF budget_alerted_period ON pm.agent_limits
  FOR EACH ROW
  WHEN (NEW.budget_alerted_period IS DISTINCT FROM OLD.budget_alerted_period)
  EXECUTE FUNCTION pm.emit_budget_exceeded_webhook();
