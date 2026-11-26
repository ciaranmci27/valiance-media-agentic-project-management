-- Project agent fixes: losing access ends the setup, and pinning keeps freshness.
--
-- - pm.project_agents follows pm.project_members: when an agent's
--   membership of a project is removed (Edit project, Take off, a member
--   change over the API), its setup there (settings, instructions, a pause)
--   goes with it, so the Agents tab never lists an agent as set up on a
--   project it cannot open. Setups already left without access are not
--   touched here: the Agents tab marks them "No access".
-- - pm.project_context keeps updated_at when only pinned changes: pinning
--   or unpinning an old entry no longer reads as "Updated just now", and the
--   list keeps its order. Every other change stamps it as before.
--
-- Additive and safe to run twice: CREATE OR REPLACE FUNCTION and
-- DROP TRIGGER IF EXISTS before each CREATE TRIGGER. Works with the previous
-- release's code (it never relied on either behaviour).

CREATE OR REPLACE FUNCTION pm.end_project_agent_on_member_removed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM pm.project_agents
  WHERE project_id = OLD.project_id AND agent_id = OLD.member_id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION pm.end_project_agent_on_member_removed() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION pm.end_project_agent_on_member_removed() IS
  'Removes an agent''s setup on a project (pm.project_agents) when its project membership goes: no access, no setup.';

DROP TRIGGER IF EXISTS end_project_agent_on_member_removed ON pm.project_members;
CREATE TRIGGER end_project_agent_on_member_removed
  AFTER DELETE ON pm.project_members
  FOR EACH ROW EXECUTE FUNCTION pm.end_project_agent_on_member_removed();

CREATE OR REPLACE FUNCTION pm.handle_project_context_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pinned' - 'updated_at') = (to_jsonb(OLD) - 'pinned' - 'updated_at') THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_project_context_updated_at() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION pm.handle_project_context_updated_at() IS
  'A context entry''s updated_at: stamped on every change except pinning or unpinning alone, so freshness reads what was written.';

DROP TRIGGER IF EXISTS set_project_context_updated_at ON pm.project_context;
CREATE TRIGGER set_project_context_updated_at
  BEFORE UPDATE ON pm.project_context
  FOR EACH ROW EXECUTE FUNCTION pm.handle_project_context_updated_at();
