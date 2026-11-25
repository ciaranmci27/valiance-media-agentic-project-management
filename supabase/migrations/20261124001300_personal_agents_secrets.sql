-- Personal agents and secrets at scale: every person can have an agent bound
-- to them that never sees more than they do, made for them automatically and
-- removed cleanly with them; agent keys that expire and rotate with overlap.
--
-- - team_members.delegate_of: the person an agent works for (a personal
--   agent). Only an agent has one, and it names a person, never an agent or
--   the agent itself. Set when the agent is made; after that it changes only
--   through pm.set_agent_delegate (the server, for an Owner) or a signed-in
--   Owner. The server reads a personal agent's access as its own and its
--   person's together, on every request. A person with personal agents
--   never becomes an agent.
-- - team_members.assistant_template: the template a personal agent was made
--   from. One personal agent per person per template
--   (team_members_one_assistant_per_template), so provisioning twice makes
--   nothing new.
-- - The person is their personal agent's owner (pm.sync_delegate_owner).
--   Re-binding or unbinding it (pm.set_agent_delegate) revokes its live
--   keys with their descendants and its live delegation tokens, audited.
-- - Deprovision cascade (pm.handle_member_status_change): when a person is
--   suspended, their active personal agents are paused (suspended, with
--   delegate_paused_at), every live key of every personal agent of theirs is
--   revoked with its descendants (pm.revoke_api_key_tree), live delegation
--   tokens naming them or one of those agents are revoked, their unused
--   identity link requests expire, and they stop owning any agent. Each
--   step writes an audit row. Reactivating them un-pauses only the agents
--   the cascade paused and gives back the ownership it took (their personal
--   agents, and the agents its last run removed them from);
--   revoked keys stay revoked. Agents are never cascaded from.
-- - pm.provision_personal_agents: makes personal agents in bulk, one
--   statement per page, skipping a person who already has one from that
--   template or is not an active person, with the audit row that records
--   the template. Service role only.
-- - pm.assistant_setups: which template a role or a group gets for its
--   personal agents, with default settings, on or off. Written and read by
--   the server only (Owners manage it).
-- - business_settings.agent_key_lifetime_days: how long a new agent key
--   lasts (null: never, the default, so nothing changes until an Owner sets
--   it). Keys made before keep expires_at null.
-- - api_keys.rotated_from: the key a rotated key replaced, once per key
--   (api_keys_rotated_from_key). pm.rotate_api_key makes the successor and
--   ends the old key's life after the overlap, in one step; the successor
--   keeps the old key's place in the lineage (created_by_key_id), so
--   revoking the key that made the old one revokes it too.
--   pm.revoke_api_key_tree also walks back through rotated_from to the keys
--   a key replaced and the keys those made, so revoking a rotated key still
--   reaches everything its predecessors made.
--   pm.revoke_rotated_api_keys revokes old keys whose overlap has ended,
--   hourly (pm-api-key-rotations) and on every rotation.
-- - Permission assistants.provision (AI agents module): a harness key that
--   lists personal agents and collects each one's key once. No role holds
--   it by default.
-- - webhook_endpoints.secret: sealed with APP_ENCRYPTION_KEY by the server
--   when the host has it (the key is not in the database, so existing
--   secrets move only in Settings > Workspace > Encryption). Only the
--   comment changes here.
--
-- Additive and safe to run twice. The previous release's code never reads
-- or writes the new columns, table or functions: its members and keys get
-- null in each, its member status changes cascade only to personal agents
-- (none exist until this release makes them), and its keys keep working.

-- ---------------------------------------------------------------------------
-- Personal agents
-- ---------------------------------------------------------------------------
ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS delegate_of uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assistant_template text,
  ADD COLUMN IF NOT EXISTS delegate_paused_at timestamptz;

ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_delegate_not_self;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_delegate_not_self CHECK (delegate_of IS NULL OR delegate_of <> id);
ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_assistant_template_shape;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_assistant_template_shape CHECK (assistant_template IS NULL OR assistant_template ~ '^[a-z0-9][a-z0-9-]{0,63}$');

COMMENT ON COLUMN pm.team_members.delegate_of IS
  'The person this agent works for (a personal agent). Its access is always its own and that person''s together. Changes only through pm.set_agent_delegate or a signed-in Owner.';
COMMENT ON COLUMN pm.team_members.assistant_template IS
  'The template a personal agent was made from. One personal agent per person per template.';
COMMENT ON COLUMN pm.team_members.delegate_paused_at IS
  'Set when the agent was paused because its person was suspended; reactivating the person un-pauses it.';

-- A person's personal agents, and one per template.
CREATE INDEX IF NOT EXISTS idx_team_members_delegate_of ON pm.team_members (delegate_of) WHERE delegate_of IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS team_members_one_assistant_per_template
  ON pm.team_members (delegate_of, assistant_template)
  WHERE delegate_of IS NOT NULL AND assistant_template IS NOT NULL;

-- Only an agent works for someone, and only for a person. Once set, who it
-- works for (and its template) changes only through pm.set_agent_delegate
-- or a signed-in Owner; a person who has personal agents never becomes an
-- agent.
CREATE OR REPLACE FUNCTION pm.team_members_delegate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.delegate_of IS NOT NULL THEN
    IF NEW.role <> 'agent' THEN
      RAISE EXCEPTION 'Only an agent works for someone' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pm.team_members p WHERE p.id = NEW.delegate_of AND p.role <> 'agent') THEN
      RAISE EXCEPTION 'A personal agent works for a person, never for an agent' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
    AND (NEW.delegate_of IS DISTINCT FROM OLD.delegate_of OR NEW.assistant_template IS DISTINCT FROM OLD.assistant_template)
    AND coalesce(current_setting('pm.delegate_change', true), '') <> 'on'
    AND NOT (auth.uid() IS NOT NULL AND coalesce(pm.current_team_member_role() = 'owner', false))
    -- The person's row going away (ON DELETE SET NULL) clears it.
    AND NOT (NEW.delegate_of IS NULL AND NOT EXISTS (SELECT 1 FROM pm.team_members p WHERE p.id = OLD.delegate_of)) THEN
    RAISE EXCEPTION 'Who agent % works for changes only by an Owner', OLD.id USING ERRCODE = '42501';
  END IF;
  IF NEW.role = 'agent' AND (TG_OP = 'INSERT' OR OLD.role IS DISTINCT FROM 'agent')
    AND EXISTS (SELECT 1 FROM pm.team_members a WHERE a.delegate_of = NEW.id) THEN
    RAISE EXCEPTION 'A person with personal agents cannot become an agent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.team_members_delegate_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS team_members_delegate_guard ON pm.team_members;
CREATE TRIGGER team_members_delegate_guard
  BEFORE INSERT OR UPDATE ON pm.team_members
  FOR EACH ROW EXECUTE FUNCTION pm.team_members_delegate_guard();

-- The person owns their personal agent; changing who it works for moves it.
-- Re-binding or unbinding it also ends everything the old person's agent
-- held: every live key with its descendants and every live delegation token,
-- each with an audit row, so nothing made for one person reads another's.
CREATE OR REPLACE FUNCTION pm.sync_delegate_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key record;
  v_revoked record;
  v_ids uuid[];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.delegate_of IS NOT NULL AND OLD.delegate_of IS DISTINCT FROM NEW.delegate_of THEN
    DELETE FROM pm.agent_owners WHERE agent_id = NEW.id AND member_id = OLD.delegate_of;
    FOR v_key IN
      SELECT k.id FROM pm.api_keys k WHERE k.team_member_id = NEW.id AND k.revoked_at IS NULL ORDER BY k.created_at, k.id
    LOOP
      FOR v_revoked IN SELECT * FROM pm.revoke_api_key_tree(v_key.id) LOOP
        PERFORM pm.audit_member_cascade(NEW.id, 'rebind', 'api_key', v_revoked.id,
          jsonb_build_object('step', 'key_revoked', 'cascaded_from', v_key.id, 'depth', v_revoked.depth,
            'previous_person', OLD.delegate_of, 'person', NEW.delegate_of));
      END LOOP;
    END LOOP;
    WITH revoked AS (
      UPDATE pm.delegation_tokens t SET revoked_at = now()
      WHERE t.agent_id = NEW.id AND t.revoked_at IS NULL AND t.expires_at > now()
      RETURNING t.id
    )
    SELECT array_agg(id ORDER BY id) INTO v_ids FROM revoked;
    IF v_ids IS NOT NULL THEN
      PERFORM pm.audit_member_cascade(NEW.id, 'rebind', 'delegation_token', NULL,
        jsonb_build_object('step', 'delegations_revoked', 'token_ids', to_jsonb(v_ids), 'previous_person', OLD.delegate_of, 'person', NEW.delegate_of));
    END IF;
  END IF;
  IF NEW.delegate_of IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.delegate_of IS DISTINCT FROM NEW.delegate_of) THEN
    INSERT INTO pm.agent_owners (agent_id, member_id, created_by)
    SELECT NEW.id, p.id, p.id FROM pm.team_members p
    WHERE p.id = NEW.delegate_of AND coalesce(p.status, 'active') = 'active'
    ON CONFLICT (agent_id, member_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.sync_delegate_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_delegate_owner ON pm.team_members;
CREATE TRIGGER sync_delegate_owner
  AFTER INSERT OR UPDATE OF delegate_of ON pm.team_members
  FOR EACH ROW EXECUTE FUNCTION pm.sync_delegate_owner();

-- Changes who an agent works for (null: nobody). The server calls it for an
-- Owner only. Answers the agent, or nothing when it is not an agent.
CREATE OR REPLACE FUNCTION pm.set_agent_delegate(p_agent_id uuid, p_person_id uuid)
RETURNS SETOF pm.team_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM set_config('pm.delegate_change', 'on', true);
  RETURN QUERY
    UPDATE pm.team_members SET delegate_of = p_person_id
    WHERE id = p_agent_id AND role = 'agent'
    RETURNING *;
  PERFORM set_config('pm.delegate_change', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION pm.set_agent_delegate(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.set_agent_delegate(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Deprovision cascade
-- ---------------------------------------------------------------------------
-- One audit row per step, written by the database (via app), naming the
-- person behind the change when there is one.
CREATE OR REPLACE FUNCTION pm.audit_member_cascade(
  p_member uuid, p_step text, p_entity_type text, p_entity_id uuid, p_detail jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, team_member_id, request_body, status_code, via)
  VALUES ('POST', '/app/team-members/' || p_member::text || '/' || p_step, p_entity_type, p_entity_id, pm.activity_actor(),
    jsonb_build_object('member_id', p_member) || coalesce(p_detail, '{}'::jsonb), 200, 'app');
$$;

REVOKE ALL ON FUNCTION pm.audit_member_cascade(uuid, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION pm.handle_member_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_agent record;
  v_key record;
  v_revoked record;
  v_ids uuid[];
BEGIN
  -- Agents are never cascaded from; only a person's status moves their agents.
  IF NEW.role = 'agent' THEN
    RETURN NULL;
  END IF;

  IF NEW.status = 'suspended' THEN
    -- 1. Pause their active personal agents.
    FOR v_agent IN
      UPDATE pm.team_members SET status = 'suspended', suspended_at = now(), suspended_by = NEW.suspended_by, delegate_paused_at = now()
      WHERE delegate_of = NEW.id AND coalesce(status, 'active') = 'active'
      RETURNING id
    LOOP
      PERFORM pm.audit_member_cascade(NEW.id, 'deprovision', 'team_member', v_agent.id, jsonb_build_object('step', 'agent_paused'));
    END LOOP;

    -- 2. Revoke every live key of every personal agent of theirs, with its descendants.
    FOR v_key IN
      SELECT k.id FROM pm.api_keys k JOIN pm.team_members a ON a.id = k.team_member_id
      WHERE a.delegate_of = NEW.id AND k.revoked_at IS NULL
      ORDER BY k.created_at, k.id
    LOOP
      FOR v_revoked IN SELECT * FROM pm.revoke_api_key_tree(v_key.id) LOOP
        PERFORM pm.audit_member_cascade(NEW.id, 'deprovision', 'api_key', v_revoked.id,
          jsonb_build_object('step', 'key_revoked', 'cascaded_from', v_key.id, 'depth', v_revoked.depth));
      END LOOP;
    END LOOP;

    -- 3. Live delegation tokens naming them, or held by one of their personal agents.
    WITH revoked AS (
      UPDATE pm.delegation_tokens t SET revoked_at = now()
      WHERE t.revoked_at IS NULL AND t.expires_at > now()
        AND (t.principal_id = NEW.id OR t.agent_id IN (SELECT a.id FROM pm.team_members a WHERE a.delegate_of = NEW.id))
      RETURNING t.id
    )
    SELECT array_agg(id ORDER BY id) INTO v_ids FROM revoked;
    IF v_ids IS NOT NULL THEN
      PERFORM pm.audit_member_cascade(NEW.id, 'deprovision', 'delegation_token', NULL,
        jsonb_build_object('step', 'delegations_revoked', 'token_ids', to_jsonb(v_ids)));
    END IF;

    -- 4. Their unused identity link requests stop working.
    WITH expired AS (
      UPDATE pm.identity_link_requests r SET expires_at = now()
      WHERE r.expected_member_id = NEW.id AND r.consumed_at IS NULL AND r.expires_at > now()
      RETURNING r.id
    )
    SELECT array_agg(id ORDER BY id) INTO v_ids FROM expired;
    IF v_ids IS NOT NULL THEN
      PERFORM pm.audit_member_cascade(NEW.id, 'deprovision', 'identity_link_request', NULL,
        jsonb_build_object('step', 'identity_links_expired', 'request_ids', to_jsonb(v_ids)));
    END IF;

    -- 5. They stop owning agents; each falls back along its escalation chain.
    WITH removed AS (
      DELETE FROM pm.agent_owners o WHERE o.member_id = NEW.id RETURNING o.agent_id
    )
    SELECT array_agg(agent_id ORDER BY agent_id) INTO v_ids FROM removed;
    IF v_ids IS NOT NULL THEN
      PERFORM pm.audit_member_cascade(NEW.id, 'deprovision', 'agent_owner', NULL,
        jsonb_build_object('step', 'owner_removed', 'agent_ids', to_jsonb(v_ids)));
    END IF;
  ELSIF NEW.status = 'active' AND OLD.status = 'suspended' THEN
    -- Un-pause only what the cascade paused, and give back the ownership it
    -- took (their personal agents, and the agents its last run removed them
    -- from). Revoked keys stay revoked.
    FOR v_agent IN
      UPDATE pm.team_members SET status = 'active', suspended_at = NULL, suspended_by = NULL, delegate_paused_at = NULL
      WHERE delegate_of = NEW.id AND delegate_paused_at IS NOT NULL
      RETURNING id
    LOOP
      PERFORM pm.audit_member_cascade(NEW.id, 'reactivate', 'team_member', v_agent.id, jsonb_build_object('step', 'agent_resumed'));
    END LOOP;
    WITH added AS (
      INSERT INTO pm.agent_owners (agent_id, member_id, created_by)
      SELECT a.id, NEW.id, NEW.id FROM pm.team_members a
      WHERE a.role = 'agent' AND (a.delegate_of = NEW.id OR a.id IN (
        SELECT (jsonb_array_elements_text(l.request_body->'agent_ids'))::uuid
        FROM pm.api_audit_log l
        WHERE l.endpoint = '/app/team-members/' || NEW.id::text || '/deprovision'
          AND l.request_body->>'step' = 'owner_removed'
          AND l.timestamp = (SELECT max(m.timestamp) FROM pm.api_audit_log m
            WHERE m.endpoint = '/app/team-members/' || NEW.id::text || '/deprovision' AND m.request_body->>'step' = 'owner_removed')
      ))
      ON CONFLICT (agent_id, member_id) DO NOTHING
      RETURNING agent_id
    )
    SELECT array_agg(agent_id ORDER BY agent_id) INTO v_ids FROM added;
    IF v_ids IS NOT NULL THEN
      PERFORM pm.audit_member_cascade(NEW.id, 'reactivate', 'agent_owner', NULL,
        jsonb_build_object('step', 'owner_restored', 'agent_ids', to_jsonb(v_ids)));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_member_status_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS handle_member_status_change ON pm.team_members;
CREATE TRIGGER handle_member_status_change
  AFTER UPDATE OF status ON pm.team_members
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION pm.handle_member_status_change();

-- ---------------------------------------------------------------------------
-- Provisioning
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.assistant_setups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_role text,
  match_group_id uuid REFERENCES pm.groups(id) ON DELETE CASCADE,
  template_key text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.assistant_setups DROP CONSTRAINT IF EXISTS assistant_setups_one_match;
ALTER TABLE pm.assistant_setups
  ADD CONSTRAINT assistant_setups_one_match CHECK (num_nonnulls(match_role, match_group_id) = 1);
ALTER TABLE pm.assistant_setups DROP CONSTRAINT IF EXISTS assistant_setups_role_check;
ALTER TABLE pm.assistant_setups
  ADD CONSTRAINT assistant_setups_role_check CHECK (match_role IS NULL OR match_role IN ('owner', 'admin', 'member', 'guest'));
ALTER TABLE pm.assistant_setups DROP CONSTRAINT IF EXISTS assistant_setups_template_shape;
ALTER TABLE pm.assistant_setups
  ADD CONSTRAINT assistant_setups_template_shape CHECK (template_key ~ '^[a-z0-9][a-z0-9-]{0,63}$');
ALTER TABLE pm.assistant_setups DROP CONSTRAINT IF EXISTS assistant_setups_settings_object;
ALTER TABLE pm.assistant_setups
  ADD CONSTRAINT assistant_setups_settings_object CHECK (jsonb_typeof(settings) = 'object');

COMMENT ON TABLE pm.assistant_setups IS
  'Personal agents by role or group: the template a match gets, default settings, on or off. Owners manage it through the server; service role only.';

-- One setup per role or group per template.
CREATE UNIQUE INDEX IF NOT EXISTS assistant_setups_role_template ON pm.assistant_setups (match_role, template_key) WHERE match_role IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assistant_setups_group_template ON pm.assistant_setups (match_group_id, template_key) WHERE match_group_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_assistant_setups_updated_at ON pm.assistant_setups;
CREATE TRIGGER set_assistant_setups_updated_at
  BEFORE UPDATE ON pm.assistant_setups
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

ALTER TABLE pm.assistant_setups ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pm.assistant_setups FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.assistant_setups TO service_role;

-- Makes personal agents in bulk: one row per element of p_agents (name,
-- email, delegate_of, assistant_template, title, agent_role, agent_profile,
-- description, and the four rules). A person who already has a personal
-- agent from that template, or who is not an active person, is skipped.
-- Each one made gets the audit row that records its template. Answers what
-- was made.
CREATE OR REPLACE FUNCTION pm.provision_personal_agents(p_agents jsonb, p_actor uuid)
RETURNS TABLE (id uuid, delegate_of uuid, assistant_template text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH made AS (
    INSERT INTO pm.team_members AS m (
      name, email, role, title, agent_role, agent_profile, description, delegate_of, assistant_template,
      agent_self_assign, agent_close_policy, agent_create_policy, agent_escalate_to
    )
    SELECT x.name, x.email, 'agent', x.title, x.agent_role, coalesce(x.agent_profile, 'generic'), x.description,
      x.delegate_of, x.assistant_template,
      coalesce(x.agent_self_assign, false), coalesce(x.agent_close_policy, 'close'), coalesce(x.agent_create_policy, 'live'),
      coalesce(x.agent_escalate_to, x.delegate_of)
    FROM jsonb_to_recordset(p_agents) AS x(
      name text, email text, title text, agent_role text, agent_profile text, description text,
      delegate_of uuid, assistant_template text,
      agent_self_assign boolean, agent_close_policy text, agent_create_policy text, agent_escalate_to uuid
    )
    JOIN pm.team_members p ON p.id = x.delegate_of AND p.role <> 'agent' AND coalesce(p.status, 'active') = 'active'
    ON CONFLICT (delegate_of, assistant_template) WHERE delegate_of IS NOT NULL AND assistant_template IS NOT NULL DO NOTHING
    RETURNING m.id, m.delegate_of, m.assistant_template, m.name, m.agent_role
  ), audited AS (
    INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, team_member_id, request_body, after_snapshot, status_code, via)
    SELECT 'POST', '/api/workspace/agents', 'team_member', made.id, p_actor,
      jsonb_build_object('template', made.assistant_template, 'personal_of', made.delegate_of, 'provisioned', true),
      jsonb_build_object('agent', jsonb_build_object('id', made.id, 'name', made.name, 'agent_role', made.agent_role, 'delegate_of', made.delegate_of)),
      201, 'app'
    FROM made
  )
  SELECT made.id, made.delegate_of, made.assistant_template FROM made;
END;
$$;

REVOKE ALL ON FUNCTION pm.provision_personal_agents(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.provision_personal_agents(jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Key lifetime and rotation
-- ---------------------------------------------------------------------------
ALTER TABLE pm.business_settings
  ADD COLUMN IF NOT EXISTS agent_key_lifetime_days integer;

ALTER TABLE pm.business_settings DROP CONSTRAINT IF EXISTS business_settings_agent_key_lifetime_days_check;
ALTER TABLE pm.business_settings
  ADD CONSTRAINT business_settings_agent_key_lifetime_days_check CHECK (agent_key_lifetime_days IS NULL OR agent_key_lifetime_days BETWEEN 1 AND 3650);

COMMENT ON COLUMN pm.business_settings.agent_key_lifetime_days IS
  'How many days a new agent key lasts (null: until revoked). Keys made before keep their own expiry.';

ALTER TABLE pm.api_keys
  ADD COLUMN IF NOT EXISTS rotated_from uuid REFERENCES pm.api_keys(id);

COMMENT ON COLUMN pm.api_keys.rotated_from IS
  'The key this one replaced (pm.rotate_api_key). A key is replaced once; the old key ends after the overlap.';

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_rotated_from_key ON pm.api_keys (rotated_from) WHERE rotated_from IS NOT NULL;

CREATE OR REPLACE FUNCTION pm.api_keys_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'API key % is revoked; a revoke cannot be changed', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.key_hash IS DISTINCT FROM OLD.key_hash
    OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'API key % secret and creation time cannot change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF (NEW.team_member_id IS DISTINCT FROM OLD.team_member_id AND NEW.team_member_id IS NOT NULL)
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'API key % cannot move to another member', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.created_by_key_id IS DISTINCT FROM OLD.created_by_key_id
    OR NEW.rotated_from IS DISTINCT FROM OLD.rotated_from THEN
    RAISE EXCEPTION 'API key % lineage cannot change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.api_keys_guard() FROM PUBLIC, anon, authenticated;

-- Revokes a key with every live key in its lineage: the keys it made, and
-- through rotation the keys it replaced (rotated_from) and the keys those
-- made, all the way down, so revoking a rotated harness key still reaches
-- every key its predecessor collected. A key it was replaced by is not
-- reached: ending an old key early leaves its successor working. The path
-- guards against cycles.
CREATE OR REPLACE FUNCTION pm.revoke_api_key_tree(p_key_id uuid)
RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql
SET search_path = ''
AS $$
  WITH RECURSIVE tree AS (
    SELECT k.id, k.rotated_from, 0 AS depth, ARRAY[k.id] AS path FROM pm.api_keys k WHERE k.id = p_key_id
    UNION ALL
    SELECT c.id, c.rotated_from, t.depth + 1, t.path || c.id
    FROM tree t JOIN pm.api_keys c ON c.created_by_key_id = t.id OR c.id = t.rotated_from
    -- No depth cap: every key in the lineage is revoked however deep it goes.
    WHERE NOT c.id = ANY(t.path)
  ), nearest AS (
    SELECT tree.id, min(tree.depth) AS depth FROM tree GROUP BY tree.id
  )
  UPDATE pm.api_keys k SET revoked_at = now()
  FROM nearest
  WHERE k.id = nearest.id AND k.revoked_at IS NULL
  RETURNING k.id, nearest.depth;
$$;

REVOKE ALL ON FUNCTION pm.revoke_api_key_tree(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.revoke_api_key_tree(uuid) TO service_role;

-- Replaces a live key: the successor (hashed by the server) gets the old
-- key's member, scopes, permissions, name and place in the lineage, and the
-- old key now ends within p_overlap_seconds. A key is replaced once.
-- Answers the successor's id; raises 55000 when the key is revoked, expired
-- or already replaced.
CREATE OR REPLACE FUNCTION pm.rotate_api_key(
  p_key_id uuid, p_key_prefix text, p_key_hash text, p_created_by uuid, p_expires_at timestamptz, p_overlap_seconds integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old pm.api_keys;
  v_new uuid;
BEGIN
  IF p_overlap_seconds IS NULL OR p_overlap_seconds < 0 OR p_overlap_seconds > 7 * 86400 THEN
    RAISE EXCEPTION 'The overlap is 0 to 7 days' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_old FROM pm.api_keys WHERE id = p_key_id FOR UPDATE;
  IF v_old.id IS NULL THEN
    RAISE EXCEPTION 'API key % does not exist', p_key_id USING ERRCODE = 'P0002';
  END IF;
  IF v_old.revoked_at IS NOT NULL OR (v_old.expires_at IS NOT NULL AND v_old.expires_at <= now())
    OR EXISTS (SELECT 1 FROM pm.api_keys s WHERE s.rotated_from = p_key_id) THEN
    RAISE EXCEPTION 'API key % cannot be rotated: it is revoked, expired or already replaced', p_key_id USING ERRCODE = '55000';
  END IF;
  INSERT INTO pm.api_keys (name, key_prefix, key_hash, created_by, team_member_id, permissions, scopes, created_by_key_id, rotated_from, expires_at)
  VALUES (v_old.name, p_key_prefix, p_key_hash, p_created_by, v_old.team_member_id, v_old.permissions, v_old.scopes,
    v_old.created_by_key_id, v_old.id, p_expires_at)
  RETURNING id INTO v_new;
  UPDATE pm.api_keys SET expires_at = least(coalesce(expires_at, 'infinity'::timestamptz), now() + make_interval(secs => p_overlap_seconds))
  WHERE id = p_key_id;
  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION pm.rotate_api_key(uuid, text, text, uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.rotate_api_key(uuid, text, text, uuid, timestamptz, integer) TO service_role;

-- Revokes replaced keys whose overlap has ended (the key alone: its
-- successor and the keys it made stay), one audit row each. Answers how many.
CREATE OR REPLACE FUNCTION pm.revoke_rotated_api_keys()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH ended AS (
    UPDATE pm.api_keys k SET revoked_at = now()
    WHERE k.revoked_at IS NULL AND k.expires_at IS NOT NULL AND k.expires_at <= now()
      AND EXISTS (SELECT 1 FROM pm.api_keys s WHERE s.rotated_from = k.id)
    RETURNING k.id
  ), audited AS (
    INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, request_body, status_code, via)
    SELECT 'POST', '/app/api-keys/' || ended.id::text || '/rotation-ended', 'api_key', ended.id,
      jsonb_build_object('reason', 'rotation_overlap_ended'), 200, 'app'
    FROM ended
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM audited;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION pm.revoke_rotated_api_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.revoke_rotated_api_keys() TO service_role;

-- Replaced keys go hourly. Skipped where pg_cron is unavailable (PGlite).
-- Re-running cron.schedule updates the job in place.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is unavailable here; replaced keys are revoked when the next key is rotated';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('pm-api-key-rotations', '41 * * * *', $job$SELECT pm.revoke_rotated_api_keys();$job$);
END;
$do$;

-- ---------------------------------------------------------------------------
-- Permission and webhook secrets
-- ---------------------------------------------------------------------------
INSERT INTO pm.permission_modules (permission_key, module_id) VALUES
  ('assistants.provision', 'agents')
ON CONFLICT (permission_key) DO UPDATE SET module_id = EXCLUDED.module_id;

COMMENT ON COLUMN pm.webhook_endpoints.secret IS
  'The signing secret. Sealed with APP_ENCRYPTION_KEY (pm1:) when the host has it; plaintext from before, or without the key, until Settings > Workspace > Encryption moves it.';
