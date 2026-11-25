-- Connect AI: a person connects an AI tool (Claude, ChatGPT, Cursor, Claude
-- Code, Codex) to their own work by signing in, over OAuth 2.1 on the MCP
-- server.
--
-- - pm.oauth_clients: tools registered by dynamic client registration
--   (RFC 7591). Public clients (token_endpoint_auth_method none) prove the
--   flow with PKCE alone; a client that asked for a secret has its hash.
-- - pm.oauth_codes: an authorization code, hashed, single-use, about 60
--   seconds, bound to its client, person, redirect_uri and PKCE challenge.
--   A second use revokes what the first one issued.
-- - pm.oauth_grants: one connection (a token family): a client, a person,
--   the scopes they allowed, and the API key behind it. The key
--   (api_keys.permissions 'connection') is never shown and has no secret
--   anyone holds (its key_hash is not a SHA-256 digest, so no key matches
--   it): it lets every OAuth call run exactly as an API key call does
--   (scopes, rate limit, audit, idempotency) with the connect scopes only.
--   Revoking the grant revokes the key.
-- - pm.oauth_tokens: access tokens (about an hour) and refresh tokens
--   (rotated on every use), hashed. A refresh token used twice revokes the
--   whole family.
-- - pm.oauth_sweep (hourly, pm-oauth-sweep): prunes spent codes, ended
--   tokens, old rate windows and registered tools nobody connected in a day.
-- - business_settings.connect_ai_enabled: "Let people connect AI tools", on
--   by default, Owner only.
-- - api_audit_log.via 'mcp_oauth': what a connection does.
-- - pm.handle_member_status_change: suspending a person revokes their
--   connections too.
--
-- Additive and safe to run twice. The previous release's code never reads
-- the new tables, column or functions, writes none of the new values, and
-- keeps working: no connection exists until this release's code makes one.

-- ---------------------------------------------------------------------------
-- API keys: a connection's key
-- ---------------------------------------------------------------------------
ALTER TABLE pm.api_keys DROP CONSTRAINT IF EXISTS api_keys_permissions_check;
ALTER TABLE pm.api_keys
  ADD CONSTRAINT api_keys_permissions_check CHECK (permissions IN ('full', 'read_only', 'scoped', 'connection'));

COMMENT ON COLUMN pm.api_keys.permissions IS
  'scoped or read_only (full: before 2.0, all revoked). connection: the key behind a Connect AI connection (pm.oauth_grants), never shown as a key and never edited or rotated.';

-- A connection's key keeps the scopes and mode it was made with.
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
  IF (OLD.permissions = 'connection' OR NEW.permissions = 'connection')
    AND (NEW.permissions IS DISTINCT FROM OLD.permissions OR NEW.scopes IS DISTINCT FROM OLD.scopes) THEN
    RAISE EXCEPTION 'API key % belongs to a connected app: its access cannot change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.api_keys_guard() FROM PUBLIC, anon, authenticated;

-- A connection's key is never rotated (a rotation hands out a usable secret).
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

-- ---------------------------------------------------------------------------
-- Audit log: what a connection does
-- ---------------------------------------------------------------------------
-- NOT VALID, then validated: validating does not block writes to the log.
ALTER TABLE pm.api_audit_log DROP CONSTRAINT IF EXISTS api_audit_log_via_check;
ALTER TABLE pm.api_audit_log
  ADD CONSTRAINT api_audit_log_via_check CHECK (via IN ('rest', 'mcp', 'app', 'mcp_oauth')) NOT VALID;
ALTER TABLE pm.api_audit_log VALIDATE CONSTRAINT api_audit_log_via_check;

-- ---------------------------------------------------------------------------
-- OAuth clients, codes, connections and tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  client_name text NOT NULL,
  client_uri text,
  redirect_uris text[] NOT NULL,
  grant_types text[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  client_secret_hash text,
  software_id text,
  software_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_clients_shape CHECK (
    cardinality(redirect_uris) BETWEEN 1 AND 10
    AND char_length(client_name) BETWEEN 1 AND 100
    AND token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')
    AND ((token_endpoint_auth_method = 'none') = (client_secret_hash IS NULL))
  )
);

COMMENT ON TABLE pm.oauth_clients IS
  'AI tools registered for Connect AI (dynamic client registration). Anyone may register one; it does nothing until a signed-in person allows it.';

CREATE TABLE IF NOT EXISTS pm.oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES pm.oauth_clients(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  api_key_id uuid NOT NULL UNIQUE REFERENCES pm.api_keys(id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  resource text,
  -- The redirect address the code was issued with: where this tool signs in from.
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT oauth_grants_revoked_reason_check CHECK (
    revoked_reason IS NULL OR revoked_reason IN ('disconnected', 'refresh_reused', 'code_reused', 'member_suspended')
  )
);

COMMENT ON TABLE pm.oauth_grants IS
  'Connected apps: one per sign-in (a token family). Revoked by Disconnect, by a reused refresh token or code, or when the person is suspended; its API key is revoked with it.';

CREATE INDEX IF NOT EXISTS idx_oauth_grants_member ON pm.oauth_grants (member_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS pm.oauth_codes (
  code_hash text PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES pm.oauth_clients(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scopes text[] NOT NULL,
  resource text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  reused_at timestamptz,
  grant_id uuid REFERENCES pm.oauth_grants(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pm.oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES pm.oauth_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON pm.oauth_tokens (grant_id);

CREATE TABLE IF NOT EXISTS pm.oauth_rate_limit_windows (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0)
);

-- Server only: nothing here is read or written by a browser.
ALTER TABLE pm.oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.oauth_rate_limit_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.oauth_clients, pm.oauth_grants, pm.oauth_codes, pm.oauth_tokens, pm.oauth_rate_limit_windows FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.oauth_clients, pm.oauth_grants, pm.oauth_codes, pm.oauth_tokens, pm.oauth_rate_limit_windows TO service_role;

-- ---------------------------------------------------------------------------
-- OAuth functions (server only)
-- ---------------------------------------------------------------------------
-- The sweep: rate windows past the longest window (an hour), spent codes
-- after an hour, tokens past their end, and registered tools nobody
-- connected within a day (registration is open, so these would pile up).
-- Runs hourly (pm-oauth-sweep) and now and then from the rate limiter.
-- Answers how many of each went.
CREATE OR REPLACE FUNCTION pm.oauth_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_windows integer;
  v_codes integer;
  v_tokens integer;
  v_clients integer;
BEGIN
  DELETE FROM pm.oauth_rate_limit_windows WHERE window_start < clock_timestamp() - interval '1 hour';
  GET DIAGNOSTICS v_windows = ROW_COUNT;
  DELETE FROM pm.oauth_codes WHERE expires_at < now() - interval '1 hour';
  GET DIAGNOSTICS v_codes = ROW_COUNT;
  DELETE FROM pm.oauth_tokens WHERE expires_at < now();
  GET DIAGNOSTICS v_tokens = ROW_COUNT;
  DELETE FROM pm.oauth_clients c
  WHERE c.created_at < now() - interval '24 hours'
    AND NOT EXISTS (SELECT 1 FROM pm.oauth_grants g WHERE g.client_id = c.id)
    -- A consent in progress keeps its client until its code expires.
    AND NOT EXISTS (SELECT 1 FROM pm.oauth_codes k WHERE k.client_id = c.id AND k.used_at IS NULL AND k.expires_at > now());
  GET DIAGNOSTICS v_clients = ROW_COUNT;
  RETURN jsonb_build_object('rate_windows', v_windows, 'codes', v_codes, 'tokens', v_tokens, 'clients', v_clients);
END;
$$;

REVOKE ALL ON FUNCTION pm.oauth_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.oauth_sweep() TO service_role;

-- Hourly. Skipped where pg_cron is unavailable (PGlite). Re-running
-- cron.schedule updates the job in place.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is unavailable here; run SELECT pm.oauth_sweep() hourly to prune Connect AI rows';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('pm-oauth-sweep', '29 * * * *', $job$SELECT pm.oauth_sweep();$job$);
END;
$do$;

-- A fixed window per bucket ('register:<ip>', 'token:<client>'). Answers
-- { allowed, remaining, reset_at }. Now and then it runs the sweep too.
CREATE OR REPLACE FUNCTION pm.oauth_rate_limit(p_bucket text, p_limit integer, p_window_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_window pm.oauth_rate_limit_windows%ROWTYPE;
BEGIN
  IF p_limit <= 0 OR p_window_seconds <= 0 THEN RAISE EXCEPTION 'Invalid rate limit'; END IF;
  IF random() < 0.01 THEN
    PERFORM pm.oauth_sweep();
  END IF;
  INSERT INTO pm.oauth_rate_limit_windows (bucket, window_start, request_count)
  VALUES (p_bucket, v_now, 1)
  ON CONFLICT (bucket) DO UPDATE
  SET window_start = CASE WHEN oauth_rate_limit_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN v_now ELSE oauth_rate_limit_windows.window_start END,
      request_count = CASE WHEN oauth_rate_limit_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN 1 ELSE oauth_rate_limit_windows.request_count + 1 END
  RETURNING * INTO v_window;
  RETURN jsonb_build_object(
    'allowed', v_window.request_count <= p_limit,
    'remaining', GREATEST(0, p_limit - v_window.request_count),
    'reset_at', v_window.window_start + make_interval(secs => p_window_seconds));
END;
$$;

REVOKE ALL ON FUNCTION pm.oauth_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.oauth_rate_limit(text, integer, integer) TO service_role;

-- Ends a connection: the grant and its API key. Answers whether it was live.
CREATE OR REPLACE FUNCTION pm.oauth_revoke_grant(p_grant_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_key uuid;
BEGIN
  UPDATE pm.oauth_grants SET revoked_at = now(), revoked_reason = p_reason
  WHERE id = p_grant_id AND revoked_at IS NULL
  RETURNING api_key_id INTO v_key;
  IF v_key IS NULL THEN
    RETURN false;
  END IF;
  UPDATE pm.api_keys SET revoked_at = now() WHERE id = v_key AND revoked_at IS NULL;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION pm.oauth_revoke_grant(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.oauth_revoke_grant(uuid, text) TO service_role;

-- Takes an authorization code once. Answers { status }:
-- - ok, with what the code was issued for (the server then checks the
--   redirect_uri and PKCE verifier; the code is spent either way);
-- - reused: it was taken before, so whatever it issued is revoked;
-- - invalid: unknown, expired, or another client's (spent all the same).
CREATE OR REPLACE FUNCTION pm.oauth_claim_code(p_code_hash text, p_client_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_code pm.oauth_codes%ROWTYPE;
BEGIN
  SELECT * INTO v_code FROM pm.oauth_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF v_code.code_hash IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  IF v_code.used_at IS NOT NULL THEN
    UPDATE pm.oauth_codes SET reused_at = coalesce(reused_at, now()) WHERE code_hash = p_code_hash;
    IF v_code.grant_id IS NOT NULL THEN
      PERFORM pm.oauth_revoke_grant(v_code.grant_id, 'code_reused');
    END IF;
    RETURN jsonb_build_object('status', 'reused', 'grant_id', v_code.grant_id, 'member_id', v_code.member_id);
  END IF;
  UPDATE pm.oauth_codes SET used_at = now() WHERE code_hash = p_code_hash;
  IF v_code.client_id <> p_client_id OR v_code.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  RETURN jsonb_build_object(
    'status', 'ok',
    'member_id', v_code.member_id,
    'redirect_uri', v_code.redirect_uri,
    'code_challenge', v_code.code_challenge,
    'scopes', to_jsonb(v_code.scopes),
    'resource', v_code.resource);
END;
$$;

REVOKE ALL ON FUNCTION pm.oauth_claim_code(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.oauth_claim_code(text, uuid) TO service_role;

-- Makes the connection for a code taken by pm.oauth_claim_code: its API key
-- (no secret anyone holds), the grant, and the first access and refresh
-- tokens (hashed by the server). Refused (status invalid) when the code was
-- reused meanwhile, already made a grant, or the person is no longer an
-- active member. Answers { status, grant_id, api_key_id, member_id, scopes }.
CREATE OR REPLACE FUNCTION pm.oauth_create_grant(
  p_code_hash text, p_access_hash text, p_refresh_hash text, p_access_expires timestamptz, p_refresh_expires timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_code pm.oauth_codes%ROWTYPE;
  v_client pm.oauth_clients%ROWTYPE;
  v_grant uuid := gen_random_uuid();
  v_key uuid;
BEGIN
  SELECT * INTO v_code FROM pm.oauth_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF v_code.code_hash IS NULL OR v_code.used_at IS NULL OR v_code.reused_at IS NOT NULL OR v_code.grant_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pm.team_members m
    WHERE m.id = v_code.member_id AND coalesce(m.status, 'active') = 'active' AND m.role <> 'agent'
  ) THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  SELECT * INTO v_client FROM pm.oauth_clients WHERE id = v_code.client_id;
  INSERT INTO pm.api_keys (name, key_prefix, key_hash, created_by, team_member_id, permissions, scopes)
  VALUES (v_client.client_name, 'connection', 'connection:' || v_grant::text, v_code.member_id, v_code.member_id, 'connection', v_code.scopes)
  RETURNING id INTO v_key;
  INSERT INTO pm.oauth_grants (id, client_id, member_id, api_key_id, scopes, resource, redirect_uri, last_used_at)
  VALUES (v_grant, v_code.client_id, v_code.member_id, v_key, v_code.scopes, v_code.resource, v_code.redirect_uri, now());
  INSERT INTO pm.oauth_tokens (grant_id, kind, token_hash, expires_at)
  VALUES (v_grant, 'access', p_access_hash, p_access_expires), (v_grant, 'refresh', p_refresh_hash, p_refresh_expires);
  UPDATE pm.oauth_codes SET grant_id = v_grant WHERE code_hash = p_code_hash;
  -- Spent codes are kept an hour, to catch a second use; then they go.
  DELETE FROM pm.oauth_codes WHERE expires_at < now() - interval '1 hour';
  RETURN jsonb_build_object('status', 'ok', 'grant_id', v_grant, 'api_key_id', v_key, 'member_id', v_code.member_id,
    'client_name', v_client.client_name, 'scopes', to_jsonb(v_code.scopes));
END;
$$;

REVOKE ALL ON FUNCTION pm.oauth_create_grant(text, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.oauth_create_grant(text, text, text, timestamptz, timestamptz) TO service_role;

-- Swaps a refresh token for a new access and refresh token, under a row
-- lock so two uses race to one winner. Answers { status }:
-- - ok, with the grant;
-- - reused: the token was already swapped, so the whole family is revoked;
-- - invalid: unknown, expired, another client's, or the connection, its key
--   or its person is no longer live.
CREATE OR REPLACE FUNCTION pm.oauth_rotate_refresh(
  p_refresh_hash text, p_client_id uuid, p_access_hash text, p_new_refresh_hash text,
  p_access_expires timestamptz, p_refresh_expires timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_token pm.oauth_tokens%ROWTYPE;
  v_grant pm.oauth_grants%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM pm.oauth_tokens WHERE token_hash = p_refresh_hash AND kind = 'refresh' FOR UPDATE;
  IF v_token.id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  SELECT * INTO v_grant FROM pm.oauth_grants WHERE id = v_token.grant_id FOR UPDATE;
  IF v_grant.client_id <> p_client_id THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  IF v_token.rotated_at IS NOT NULL THEN
    PERFORM pm.oauth_revoke_grant(v_grant.id, 'refresh_reused');
    RETURN jsonb_build_object('status', 'reused', 'grant_id', v_grant.id, 'member_id', v_grant.member_id, 'api_key_id', v_grant.api_key_id);
  END IF;
  IF v_grant.revoked_at IS NOT NULL OR v_token.expires_at <= now()
    OR NOT EXISTS (SELECT 1 FROM pm.api_keys k WHERE k.id = v_grant.api_key_id AND k.revoked_at IS NULL)
    OR NOT EXISTS (
      SELECT 1 FROM pm.team_members m
      WHERE m.id = v_grant.member_id AND coalesce(m.status, 'active') = 'active'
    ) THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  UPDATE pm.oauth_tokens SET rotated_at = now() WHERE id = v_token.id;
  INSERT INTO pm.oauth_tokens (grant_id, kind, token_hash, expires_at)
  VALUES (v_grant.id, 'access', p_access_hash, p_access_expires), (v_grant.id, 'refresh', p_new_refresh_hash, p_refresh_expires);
  -- Tokens past their end are gone for good; a swapped refresh token is kept
  -- until then, to catch a second use.
  DELETE FROM pm.oauth_tokens WHERE grant_id = v_grant.id AND expires_at < now();
  RETURN jsonb_build_object('status', 'ok', 'grant_id', v_grant.id, 'member_id', v_grant.member_id,
    'api_key_id', v_grant.api_key_id, 'scopes', to_jsonb(v_grant.scopes));
END;
$$;

REVOKE ALL ON FUNCTION pm.oauth_rotate_refresh(text, uuid, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.oauth_rotate_refresh(text, uuid, text, text, timestamptz, timestamptz) TO service_role;

-- Who a live access token acts as: its grant, person, client and API key,
-- or null (unknown, expired, revoked, or its key revoked or disabled).
-- Stamps the connection's last use at most once a minute.
CREATE OR REPLACE FUNCTION pm.oauth_resolve_access(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  SELECT g.id AS grant_id, g.member_id, g.api_key_id, g.scopes, g.resource, g.last_used_at, c.client_name, c.client_id AS public_client_id
    INTO v_row
  FROM pm.oauth_tokens t
  JOIN pm.oauth_grants g ON g.id = t.grant_id
  JOIN pm.oauth_clients c ON c.id = g.client_id
  JOIN pm.api_keys k ON k.id = g.api_key_id
  WHERE t.token_hash = p_token_hash AND t.kind = 'access' AND t.expires_at > now()
    AND g.revoked_at IS NULL AND k.revoked_at IS NULL AND k.disabled_at IS NULL;
  IF v_row.grant_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_row.last_used_at IS NULL OR v_row.last_used_at < now() - interval '1 minute' THEN
    UPDATE pm.oauth_grants SET last_used_at = now() WHERE id = v_row.grant_id;
  END IF;
  RETURN jsonb_build_object('grant_id', v_row.grant_id, 'member_id', v_row.member_id, 'api_key_id', v_row.api_key_id,
    'scopes', to_jsonb(v_row.scopes), 'resource', v_row.resource, 'client_name', v_row.client_name, 'client_id', v_row.public_client_id);
END;
$$;

REVOKE ALL ON FUNCTION pm.oauth_resolve_access(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.oauth_resolve_access(text) TO service_role;

-- ---------------------------------------------------------------------------
-- Deprovision cascade: a suspended person's connections end
-- ---------------------------------------------------------------------------
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

    -- 6. Their connected AI tools (Connect AI): every live connection and its key.
    WITH ended AS (
      UPDATE pm.oauth_grants g SET revoked_at = now(), revoked_reason = 'member_suspended'
      WHERE g.member_id = NEW.id AND g.revoked_at IS NULL
      RETURNING g.id, g.api_key_id
    ), keys AS (
      UPDATE pm.api_keys k SET revoked_at = now()
      FROM ended e
      WHERE k.id = e.api_key_id AND k.revoked_at IS NULL
      RETURNING k.id
    )
    SELECT array_agg(id ORDER BY id) INTO v_ids FROM ended;
    IF v_ids IS NOT NULL THEN
      PERFORM pm.audit_member_cascade(NEW.id, 'deprovision', 'oauth_grant', NULL,
        jsonb_build_object('step', 'connections_revoked', 'grant_ids', to_jsonb(v_ids)));
    END IF;
  ELSIF NEW.status = 'active' AND OLD.status = 'suspended' THEN
    -- Un-pause only what the cascade paused, and give back the ownership it
    -- took (their personal agents, and the agents its last run removed them
    -- from). Revoked keys and connections stay revoked.
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

-- ---------------------------------------------------------------------------
-- The workspace switch: "Let people connect AI tools"
-- ---------------------------------------------------------------------------
-- Last: these lock business_settings, briefly.
ALTER TABLE pm.business_settings
  ADD COLUMN IF NOT EXISTS connect_ai_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN pm.business_settings.connect_ai_enabled IS
  'Let people connect AI tools (Connect AI): while false, sign-in for AI tools is refused and connected tools get 403 until it is on again. An Owner sets it.';

-- Owner-only settings on the business row: the switches before, the kill
-- switch, the audit settings and Connect AI. Admins manage the rest (settings.manage).
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
       OR NEW.agents_paused_at IS NOT NULL OR NEW.audit_retention_days IS NOT NULL OR NEW.audit_redact_keys <> '{}'
       OR NEW.connect_ai_enabled IS DISTINCT FROM true))
     OR (TG_OP = 'UPDATE' AND (NEW.auto_migrate IS DISTINCT FROM OLD.auto_migrate
       OR NEW.owners_read_personal_inboxes IS DISTINCT FROM OLD.owners_read_personal_inboxes
       OR NEW.agents_paused_at IS DISTINCT FROM OLD.agents_paused_at
       OR NEW.agents_paused_by IS DISTINCT FROM OLD.agents_paused_by
       OR NEW.audit_retention_days IS DISTINCT FROM OLD.audit_retention_days
       OR NEW.audit_redact_keys IS DISTINCT FROM OLD.audit_redact_keys
       OR NEW.connect_ai_enabled IS DISTINCT FROM OLD.connect_ai_enabled)) THEN
    IF COALESCE(pm.current_team_member_role(), '') <> 'owner' THEN
      RAISE EXCEPTION 'Only an Owner can change this setting' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.business_settings_owner_columns() FROM PUBLIC, anon, authenticated;
