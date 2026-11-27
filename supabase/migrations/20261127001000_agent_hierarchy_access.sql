-- Orchestrators and who can use an agent: company agents as an org chart,
-- with access managed at every level.
--
-- - pm.team_members.orchestrator_id: the agent a company agent works under
--   (its orchestrator). Only an agent has one, it is always another company
--   agent, never itself, never a loop, and a chart is at most 4 levels deep
--   (a top orchestrator and three levels under it). Personal agents
--   (delegate_of) are never in a chart. Null for every agent today: nothing
--   changes until someone sets one. Orchestrator changes take one lock, so
--   two at once never make a loop or too deep a chart. An agent that gets an
--   orchestrator has "pick up unassigned work" (agent_self_assign) turned
--   off; a manager can turn it on again.
-- - pm.team_members.reachable_directly (default true): people may use the
--   agent directly (give it a task, talk to it in chat). False: only through
--   its orchestrator. Only matters while it has an orchestrator.
-- - pm.team_members.ask_first (default false): work someone gives it waits
--   for one of its managers to approve (an approval asked to them), unless
--   that someone manages it.
-- - pm.agent_audience (agent_id, kind, ref, effect): who can use an agent.
--   kind everyone (no ref), role (owner, admin, member or guest), group (a
--   group id) or member (a person's id); effect include or exclude. An agent
--   with no include rows admits everyone who may otherwise give it work, as
--   today; an exclude row always wins. Written by the server only; members
--   with team.read (and the agent itself) read it.
-- - pm.member_may_use_agent(agent, member): the agent's own audience AND
--   every orchestrator's above it. A personal agent admits only its own person.
--   Server only.
-- - pm.agent_audience_members(agent): the active people who may use it, for
--   the "N people can use it" preview. Server only.
-- - pm.member_manages_agent(agent, member): a workspace Owner, a member with
--   team.manage, or one of the agent's owners (in person or through a
--   group). Server only.
-- - pm.replace_agent_audience(agent, rows, created_by): replaces an agent's
--   audience in one transaction, so a failure leaves the old rows. Server
--   only.
-- - A signed-in member who assigns a company agent to a task (the browser
--   and pm.save_task, a new row or a row changed to point at the agent) is
--   checked by the database: refused when the agent is only reachable
--   through its orchestrator, when they are not in its audience, or when it asks
--   first and none of its managers approved that task for them. Personal
--   agents keep today's behaviour. Server routes (the API, MCP, chat) check
--   the same rules in code, where they know the person a chain of agents
--   works for.
-- - One open ask-first approval per agent, asker and piece of work: a
--   unique index on pm.questions.
-- - pm.agent_status also answers assistants_off for a personal agent while
--   assistants are switched off for the workspace (get_my_status).
--
-- Additive and safe to run twice. The previous release's code reads and
-- writes agents as before: no orchestrator, no audience rows, reachable, never asks.

ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS orchestrator_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reachable_directly boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ask_first boolean NOT NULL DEFAULT false;

ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_orchestrator_not_self;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_orchestrator_not_self CHECK (orchestrator_id IS NULL OR orchestrator_id <> id);

COMMENT ON COLUMN pm.team_members.orchestrator_id IS
  'The company agent this agent works under (its orchestrator). Agents only; no loops; at most 4 levels. Work reaches it only from its orchestrator.';
COMMENT ON COLUMN pm.team_members.reachable_directly IS
  'People may use the agent directly. False: only through its orchestrator (matters only while it has one).';
COMMENT ON COLUMN pm.team_members.ask_first IS
  'Work given to the agent waits for one of its managers to approve, unless the giver manages it.';

-- The agents under an orchestrator.
CREATE INDEX IF NOT EXISTS idx_team_members_orchestrator ON pm.team_members (orchestrator_id) WHERE orchestrator_id IS NOT NULL;

-- An orchestrator is a company agent; the chart has no loops and at most 4 levels.
CREATE OR REPLACE FUNCTION pm.team_members_orchestrator_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_at uuid;
  v_above integer := 0;
  v_below integer := 0;
BEGIN
  -- One orchestrator change at a time: two moves at once never make a loop or too deep a chart.
  PERFORM pg_advisory_xact_lock(hashtext('pm.team_members.orchestrator_id'));
  IF NEW.orchestrator_id IS NULL THEN
    -- A personal agent is never an orchestrator.
    IF NEW.delegate_of IS NOT NULL AND EXISTS (SELECT 1 FROM pm.team_members r WHERE r.orchestrator_id = NEW.id) THEN
      RAISE EXCEPTION 'agent_orchestrator_personal: a personal agent is never an orchestrator of other agents' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.role IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'agent_orchestrator_agents_only: only an agent works under an orchestrator' USING ERRCODE = '23514';
  END IF;
  IF NEW.delegate_of IS NOT NULL THEN
    RAISE EXCEPTION 'agent_orchestrator_personal: a personal agent never works under an orchestrator' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pm.team_members l WHERE l.id = NEW.orchestrator_id AND l.role = 'agent' AND l.delegate_of IS NULL) THEN
    RAISE EXCEPTION 'agent_orchestrator_not_agent: an orchestrator is a company agent' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.orchestrator_id IS NOT DISTINCT FROM OLD.orchestrator_id
    AND NEW.role IS NOT DISTINCT FROM OLD.role AND NEW.delegate_of IS NOT DISTINCT FROM OLD.delegate_of THEN
    RETURN NEW;
  END IF;
  -- Up from the orchestrator: never back to this agent.
  v_at := NEW.orchestrator_id;
  WHILE v_at IS NOT NULL LOOP
    IF v_at = NEW.id THEN
      RAISE EXCEPTION 'agent_orchestrator_loop: that orchestrator already works under this agent' USING ERRCODE = '23514';
    END IF;
    v_above := v_above + 1;
    IF v_above > 4 THEN
      RAISE EXCEPTION 'agent_orchestrator_too_deep: a chart of agents is at most 4 levels deep' USING ERRCODE = '23514';
    END IF;
    SELECT l.orchestrator_id INTO v_at FROM pm.team_members l WHERE l.id = v_at;
  END LOOP;
  -- Down from this agent: the levels it brings with it.
  WITH RECURSIVE below AS (
    SELECT r.id, 1 AS depth FROM pm.team_members r WHERE r.orchestrator_id = NEW.id
    UNION ALL
    SELECT r.id, b.depth + 1 FROM pm.team_members r JOIN below b ON r.orchestrator_id = b.id WHERE b.depth < 5
  )
  SELECT coalesce(max(depth), 0) INTO v_below FROM below;
  IF v_above + 1 + v_below > 4 THEN
    RAISE EXCEPTION 'agent_orchestrator_too_deep: a chart of agents is at most 4 levels deep' USING ERRCODE = '23514';
  END IF;
  -- A sub-agent goes through its orchestrator: getting an orchestrator turns
  -- off picking up unassigned work; one of its managers can turn it back on
  -- afterwards.
  IF TG_OP = 'INSERT' OR OLD.orchestrator_id IS NULL THEN
    NEW.agent_self_assign := false;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.team_members_orchestrator_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS team_members_orchestrator_guard ON pm.team_members;
CREATE TRIGGER team_members_orchestrator_guard
  BEFORE INSERT OR UPDATE OF orchestrator_id, role, delegate_of ON pm.team_members
  FOR EACH ROW EXECUTE FUNCTION pm.team_members_orchestrator_guard();

-- ---------------------------------------------------------------------------
-- Who can use an agent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.agent_audience (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  kind text NOT NULL,
  ref text,
  effect text NOT NULL DEFAULT 'include',
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.agent_audience DROP CONSTRAINT IF EXISTS agent_audience_kind_check;
ALTER TABLE pm.agent_audience
  ADD CONSTRAINT agent_audience_kind_check CHECK (kind IN ('everyone', 'role', 'group', 'member'));
ALTER TABLE pm.agent_audience DROP CONSTRAINT IF EXISTS agent_audience_effect_check;
ALTER TABLE pm.agent_audience
  ADD CONSTRAINT agent_audience_effect_check CHECK (effect IN ('include', 'exclude'));
ALTER TABLE pm.agent_audience DROP CONSTRAINT IF EXISTS agent_audience_ref_check;
ALTER TABLE pm.agent_audience
  ADD CONSTRAINT agent_audience_ref_check CHECK (
    (kind = 'everyone' AND ref IS NULL)
    OR (kind = 'role' AND ref IN ('owner', 'admin', 'member', 'guest'))
    OR (kind IN ('group', 'member') AND ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );

COMMENT ON TABLE pm.agent_audience IS
  'Who can use an agent: everyone, a role, a group or a person, included or excluded. No include rows: everyone who may otherwise give it work. Exclude wins. Effective audience is this AND every orchestrator''s above it. Written by the server only.';

-- One row per subject on an agent.
CREATE UNIQUE INDEX IF NOT EXISTS agent_audience_subject ON pm.agent_audience (agent_id, kind, coalesce(ref, ''));

-- Only an agent has an audience, and a personal agent never has one (it is its person's).
CREATE OR REPLACE FUNCTION pm.handle_agent_audience_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pm.team_members m WHERE m.id = NEW.agent_id AND m.role = 'agent' AND m.delegate_of IS NULL) THEN
    RAISE EXCEPTION 'agent_audience_agents_only: only a company agent has an audience' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_agent_audience_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS agent_audience_before_write ON pm.agent_audience;
CREATE TRIGGER agent_audience_before_write
  BEFORE INSERT OR UPDATE ON pm.agent_audience
  FOR EACH ROW EXECUTE FUNCTION pm.handle_agent_audience_before_write();

ALTER TABLE pm.agent_audience ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_audience_select ON pm.agent_audience;
CREATE POLICY agent_audience_select ON pm.agent_audience FOR SELECT TO authenticated
  USING (pm.has_permission('team.read') OR agent_id = pm.current_team_member_id());

DROP POLICY IF EXISTS agent_audience_module_on ON pm.agent_audience;
CREATE POLICY agent_audience_module_on ON pm.agent_audience AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select pm.module_enabled('agents')));

REVOKE ALL ON pm.agent_audience FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.agent_audience TO authenticated;
GRANT ALL ON pm.agent_audience TO service_role;

-- Replaces an agent's audience with exactly these rows ([{ kind, ref,
-- effect }]), in one transaction: a row the table refuses leaves the old
-- audience as it was. Kept in the order given.
CREATE OR REPLACE FUNCTION pm.replace_agent_audience(p_agent uuid, p_rows jsonb, p_created_by uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'replace_agent_audience: rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  DELETE FROM pm.agent_audience WHERE agent_id = p_agent;
  INSERT INTO pm.agent_audience (agent_id, kind, ref, effect, created_by, created_at)
  SELECT p_agent, r.value->>'kind', r.value->>'ref', coalesce(r.value->>'effect', 'include'), p_created_by,
    now() + ((r.ordinality - 1) * interval '1 millisecond')
  FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) WITH ORDINALITY AS r(value, ordinality);
END;
$$;

REVOKE ALL ON FUNCTION pm.replace_agent_audience(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.replace_agent_audience(uuid, jsonb, uuid) TO service_role;

-- Whether a member may use an agent: its own audience and every orchestrator's above it.
CREATE OR REPLACE FUNCTION pm.member_may_use_agent(p_agent uuid, p_member uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_role text;
  v_delegate uuid;
  v_member_role text;
  v_member_status text;
  v_at uuid;
  v_seen uuid[] := '{}';
BEGIN
  SELECT role, delegate_of INTO v_role, v_delegate FROM pm.team_members WHERE id = p_agent;
  IF NOT FOUND OR v_role IS DISTINCT FROM 'agent' THEN
    RETURN false;
  END IF;
  -- A personal agent works for its own person only.
  IF v_delegate IS NOT NULL THEN
    RETURN p_member IS NOT DISTINCT FROM v_delegate;
  END IF;
  SELECT role, coalesce(status, 'active') INTO v_member_role, v_member_status FROM pm.team_members WHERE id = p_member;
  IF NOT FOUND OR v_member_status <> 'active' THEN
    RETURN false;
  END IF;
  v_at := p_agent;
  WHILE v_at IS NOT NULL AND NOT (v_at = ANY (v_seen)) AND cardinality(v_seen) < 8 LOOP
    -- Include rows narrow it to who they name; none admits everyone.
    IF EXISTS (SELECT 1 FROM pm.agent_audience a WHERE a.agent_id = v_at AND a.effect = 'include')
      AND NOT EXISTS (
        SELECT 1 FROM pm.agent_audience a
        WHERE a.agent_id = v_at AND a.effect = 'include'
          AND (a.kind = 'everyone'
            OR (a.kind = 'role' AND a.ref = v_member_role)
            OR (a.kind = 'member' AND a.ref = p_member::text)
            OR (a.kind = 'group' AND EXISTS (
              SELECT 1 FROM pm.group_members gm JOIN pm.groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
              WHERE gm.group_id::text = a.ref AND gm.member_id = p_member)))
      ) THEN
      RETURN false;
    END IF;
    -- An exclude row always wins.
    IF EXISTS (
      SELECT 1 FROM pm.agent_audience a
      WHERE a.agent_id = v_at AND a.effect = 'exclude'
        AND (a.kind = 'everyone'
          OR (a.kind = 'role' AND a.ref = v_member_role)
          OR (a.kind = 'member' AND a.ref = p_member::text)
          OR (a.kind = 'group' AND EXISTS (
            SELECT 1 FROM pm.group_members gm JOIN pm.groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
            WHERE gm.group_id::text = a.ref AND gm.member_id = p_member)))
    ) THEN
      RETURN false;
    END IF;
    v_seen := v_seen || v_at;
    SELECT orchestrator_id INTO v_at FROM pm.team_members WHERE id = v_at;
  END LOOP;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION pm.member_may_use_agent(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.member_may_use_agent(uuid, uuid) TO service_role;

-- The active people who may use an agent (agents and suspended members left out).
CREATE OR REPLACE FUNCTION pm.agent_audience_members(p_agent uuid)
RETURNS TABLE (member_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT m.id FROM pm.team_members m
  WHERE m.role <> 'agent' AND coalesce(m.status, 'active') = 'active' AND pm.member_may_use_agent(p_agent, m.id)
  ORDER BY m.name, m.id
$$;

REVOKE ALL ON FUNCTION pm.agent_audience_members(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_audience_members(uuid) TO service_role;

-- Whether a member manages an agent: a workspace Owner, team.manage, or one of its owners.
CREATE OR REPLACE FUNCTION pm.member_manages_agent(p_agent uuid, p_member uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT p_agent IS DISTINCT FROM p_member AND EXISTS (
    SELECT 1 FROM pm.team_members m
    WHERE m.id = p_member AND coalesce(m.status, 'active') = 'active' AND m.role <> 'agent'
      AND (m.role = 'owner'
        OR EXISTS (SELECT 1 FROM pm.team_member_permissions p
          WHERE p.member_id = m.id AND p.permission_key = 'team.manage' AND p.access_channel = 'app' AND p.effect = 'allow')
        OR (EXISTS (SELECT 1 FROM pm.role_permissions r
          WHERE r.role = m.role AND r.permission_key = 'team.manage' AND r.access_channel = 'app')
          AND NOT EXISTS (SELECT 1 FROM pm.team_member_permissions p
            WHERE p.member_id = m.id AND p.permission_key = 'team.manage' AND p.access_channel = 'app' AND p.effect = 'deny'))
        OR EXISTS (SELECT 1 FROM pm.agent_owners o WHERE o.agent_id = p_agent AND o.member_id = m.id)
        OR EXISTS (SELECT 1 FROM pm.agent_owner_groups og
          JOIN pm.groups g ON g.id = og.group_id AND g.deleted_at IS NULL
          JOIN pm.group_members gm ON gm.group_id = og.group_id AND gm.member_id = m.id
          WHERE og.agent_id = p_agent))
  )
$$;

REVOKE ALL ON FUNCTION pm.member_manages_agent(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.member_manages_agent(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- A signed-in member assigning an agent
-- ---------------------------------------------------------------------------
-- The browser and pm.save_task write task_assignees as the member. A
-- company agent newly on a task (a new row, or a row changed to another
-- agent or task) is refused when it is only reachable through its orchestrator,
-- when the member is not in its audience, or when it asks first and none of
-- its managers approved this task for this member (the approval answered by
-- someone who manages it). An assignment already there (a save that keeps
-- it), personal agents (today's behaviour) and server writes (no signed-in
-- member: the server checks in code) pass.
CREATE OR REPLACE FUNCTION pm.guard_agent_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_actor uuid := pm.current_team_member_id();
  v_role text;
  v_delegate uuid;
  v_orchestrator uuid;
  v_reachable boolean;
  v_ask boolean;
BEGIN
  IF v_actor IS NULL OR v_actor = NEW.member_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.member_id = OLD.member_id AND NEW.task_id = OLD.task_id THEN
    RETURN NEW;
  END IF;
  SELECT role, delegate_of, orchestrator_id, reachable_directly, ask_first INTO v_role, v_delegate, v_orchestrator, v_reachable, v_ask
  FROM pm.team_members WHERE id = NEW.member_id;
  IF NOT FOUND OR v_role IS DISTINCT FROM 'agent' OR v_delegate IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM pm.task_assignees a WHERE a.task_id = NEW.task_id AND a.member_id = NEW.member_id) THEN
    RETURN NEW;
  END IF;
  IF v_orchestrator IS NOT NULL AND NOT v_reachable THEN
    RAISE EXCEPTION 'agent_not_available: this agent takes work only through its orchestrator'
      USING ERRCODE = '42501', HINT = 'Give the task to its orchestrator instead.';
  END IF;
  IF NOT pm.member_may_use_agent(NEW.member_id, v_actor) THEN
    RAISE EXCEPTION 'agent_not_available: you cannot give this agent work'
      USING ERRCODE = '42501', HINT = 'Ask one of its managers to add you to who can use it.';
  END IF;
  IF v_ask AND NOT pm.member_manages_agent(NEW.member_id, v_actor) AND NOT EXISTS (
    SELECT 1 FROM pm.questions q
    WHERE q.kind = 'approval' AND q.deleted_at IS NULL AND q.status = 'answered' AND q.answer_choice = 'approve'
      AND q.action->>'type' = 'agent.use'
      AND q.action->'details'->>'key' = NEW.member_id::text || ':' || v_actor::text || ':task:' || NEW.task_id::text
      AND pm.member_manages_agent(NEW.member_id, q.answered_by)
  ) THEN
    RAISE EXCEPTION 'agent_ask_first: this agent asks its managers before it takes work'
      USING ERRCODE = '42501', HINT = 'Ask its managers to approve this task for you first.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.guard_agent_assignment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_agent_assignment ON pm.task_assignees;
CREATE TRIGGER guard_agent_assignment
  BEFORE INSERT OR UPDATE OF member_id, task_id ON pm.task_assignees
  FOR EACH ROW EXECUTE FUNCTION pm.guard_agent_assignment();

-- When an ask-first approval for a new task was used (it makes one task).
-- Null for every other question.
ALTER TABLE pm.questions ADD COLUMN IF NOT EXISTS used_at timestamptz;

COMMENT ON COLUMN pm.questions.used_at IS
  'An ask-first approval (action type agent.use) for a new task: when the one task it allows was made. Set by the server only.';

-- One open ask-first approval per agent, asker and piece of work: two
-- requests at once make one approval (the second reads the first).
CREATE UNIQUE INDEX IF NOT EXISTS questions_open_agent_use ON pm.questions ((action->'details'->>'key'))
  WHERE kind = 'approval' AND status = 'open' AND deleted_at IS NULL AND action->>'type' = 'agent.use';

-- ---------------------------------------------------------------------------
-- What an agent checks before each turn: assistants switched off
-- ---------------------------------------------------------------------------
-- As before, plus assistants_off: true for a personal agent while assistants
-- are switched off for the workspace (it is on hold, as pm.api_request_gate
-- says on every write).
CREATE OR REPLACE FUNCTION pm.agent_status(p_member_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_role text;
  v_delegate_of uuid;
  v_agent_paused timestamptz;
  v_workspace_paused timestamptz;
  v_assistants_on boolean;
  v_state jsonb;
  v_period text;
BEGIN
  SELECT role, agent_paused_at, delegate_of INTO v_role, v_agent_paused, v_delegate_of FROM pm.team_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_role IS DISTINCT FROM 'agent' THEN
    RETURN jsonb_build_object('agent', false, 'workspace_paused_at', NULL, 'agent_paused_at', NULL, 'assistants_off', false, 'state', NULL);
  END IF;
  SELECT s.agents_paused_at INTO v_workspace_paused FROM pm.business_settings s ORDER BY s.agents_paused_at NULLS LAST LIMIT 1;
  SELECT s.assistants_enabled INTO v_assistants_on FROM pm.business_settings s LIMIT 1;
  v_state := pm.agent_limit_state(p_member_id, true);
  v_period := coalesce(v_state->'limits'->>'budget_period', 'month');
  RETURN jsonb_build_object(
    'agent', true,
    'workspace_paused_at', v_workspace_paused,
    'agent_paused_at', v_agent_paused,
    'assistants_off', v_delegate_of IS NOT NULL AND v_assistants_on IS NOT TRUE,
    'budget_period', v_period,
    'period_end', (date_trunc(v_period, now() AT TIME ZONE 'UTC') + ('1 ' || v_period)::interval) AT TIME ZONE 'UTC',
    'state', v_state);
END;
$$;

REVOKE ALL ON FUNCTION pm.agent_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_status(uuid) TO service_role;
