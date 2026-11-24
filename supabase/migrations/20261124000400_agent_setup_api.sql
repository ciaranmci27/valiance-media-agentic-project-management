-- API key lineage, for setting up agents over the API: a key made by another
-- key (POST /api/v1/api-keys) records which one, so revoking a leaked key
-- also revokes every key it made, and every key those made.
--
-- - api_keys.created_by_key_id: the key that made this one over the API.
--   Null for a key made in Settings (by a signed-in person) and for every key
--   made before this release. Keys are revoked (revoked_at), never deleted,
--   so the reference has no cascade: a key with descendants cannot be
--   deleted out from under them.
-- - The lineage never changes once set (pm.api_keys_guard).
-- - pm.revoke_api_key_tree(key) revokes the key and its live descendants in
--   one statement and answers each key it revoked, with its depth (0 is the
--   key itself). Already revoked keys are walked through, not revoked again.
--   Service role only.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the column (it is nullable) and never calls the function; its
-- revoke still revokes the one key, as before.

ALTER TABLE pm.api_keys
  ADD COLUMN IF NOT EXISTS created_by_key_id uuid REFERENCES pm.api_keys(id);

COMMENT ON COLUMN pm.api_keys.created_by_key_id IS
  'The key that made this one over the API (null: made in Settings, or before 2.0.16). Revoking a key revokes its descendants.';

CREATE INDEX IF NOT EXISTS idx_api_keys_created_by_key ON pm.api_keys (created_by_key_id)
  WHERE created_by_key_id IS NOT NULL;

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
  IF NEW.created_by_key_id IS DISTINCT FROM OLD.created_by_key_id THEN
    RAISE EXCEPTION 'API key % lineage cannot change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.api_keys_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION pm.revoke_api_key_tree(p_key_id uuid)
RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql
SET search_path = ''
AS $$
  WITH RECURSIVE tree AS (
    SELECT k.id, 0 AS depth, ARRAY[k.id] AS path FROM pm.api_keys k WHERE k.id = p_key_id
    UNION ALL
    SELECT c.id, t.depth + 1, t.path || c.id FROM pm.api_keys c JOIN tree t ON c.created_by_key_id = t.id
    -- No depth cap: every descendant is revoked however deep the chain. The
    -- path only guards a key that names itself as its parent.
    WHERE NOT c.id = ANY(t.path)
  )
  UPDATE pm.api_keys k SET revoked_at = now()
  FROM tree
  WHERE k.id = tree.id AND k.revoked_at IS NULL
  RETURNING k.id, tree.depth;
$$;

REVOKE ALL ON FUNCTION pm.revoke_api_key_tree(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.revoke_api_key_tree(uuid) TO service_role;
