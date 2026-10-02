-- API keys are created and revoked only by the server.
--
-- api_keys_update_own let a key's member update any column through
-- PostgREST: clear revoked_at (the v1 middleware only looks for
-- revoked_at IS NULL, so an admin's revoke did not stick), rewrite key_hash
-- or scopes, and, with api_keys.manage_all, point a key at the Owner so it
-- resolved the Owner's api access. Keys were also generated and hashed in the
-- browser and inserted through RLS with no server check on scopes.
--
-- After this migration members can only read the keys they could see before.
-- POST /api/workspace/api-keys creates a key (scopes checked against the
-- member's api permissions) and POST /api/workspace/api-keys/[id]/revoke
-- revokes one, both with the service role. The guard below holds for every
-- role, service_role included, so a server bug cannot undo a revoke either.

DROP POLICY IF EXISTS api_keys_insert_own ON public.api_keys;
DROP POLICY IF EXISTS api_keys_update_own ON public.api_keys;

REVOKE ALL ON public.api_keys FROM anon, authenticated;
GRANT SELECT ON public.api_keys TO authenticated;

-- A revoke is final, the secret and creation time never change, and a key
-- never moves to another member. team_member_id and created_by may still
-- become NULL: their foreign keys are ON DELETE SET NULL, which runs as an
-- UPDATE and fires this trigger. scopes, name, disabled_at (reversible, unlike
-- a revoke) and last_used_at stay writable by the server.
CREATE OR REPLACE FUNCTION public.api_keys_guard()
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
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.api_keys_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER api_keys_guard
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_keys_guard();
