-- API keys you can manage: a key can be paused and resumed.
--
-- - pm.api_keys.paused_at: when the key was paused (null: not paused). A
--   paused key keeps its secret, name and scopes, and is refused at sign-in
--   (401 api_key_paused) until someone who manages it resumes it, which
--   clears both columns. A revoke still ends it for good.
-- - pm.api_keys.paused_by: who paused it (null once that member is gone).
--   Pausing an agent's key never touches the agent's own pause.
-- - pm.rotate_api_key refuses a paused key under its row lock (HINT
--   key_paused), so a pause that lands while a rotation is checked never
--   leaves a working successor. Same signature and grants as before. (A
--   replaced key still in its overlap is refused at sign-in while its
--   successor is paused: the server checks that, no schema change.)
--
-- Additive and safe to run twice. The previous release's code never reads
-- either column and keeps working: no key is paused until this release's
-- code pauses one.

ALTER TABLE pm.api_keys
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL;

COMMENT ON COLUMN pm.api_keys.paused_at IS
  'When the key was paused (null: not paused). A paused key keeps its secret and is refused at sign-in until resumed.';
COMMENT ON COLUMN pm.api_keys.paused_by IS
  'The member who paused the key (null when not paused, or once that member is gone).';

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
  IF v_old.permissions = 'connection' THEN
    RAISE EXCEPTION 'API key % belongs to a connected app and cannot be rotated', p_key_id USING ERRCODE = '55000';
  END IF;
  IF v_old.revoked_at IS NOT NULL OR (v_old.expires_at IS NOT NULL AND v_old.expires_at <= now())
    OR EXISTS (SELECT 1 FROM pm.api_keys s WHERE s.rotated_from = p_key_id) THEN
    RAISE EXCEPTION 'API key % cannot be rotated: it is revoked, expired or already replaced', p_key_id USING ERRCODE = '55000';
  END IF;
  -- A paused key is not rotated: a working successor would undo the pause.
  IF v_old.paused_at IS NOT NULL THEN
    RAISE EXCEPTION 'API key % is paused: resume it before rotating it', p_key_id
      USING ERRCODE = '55000', HINT = 'key_paused';
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
