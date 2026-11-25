-- Sign in with Google, beside email and password.
--
-- - business_settings.sign_in_methods: the ways the sign-in page offers.
--   'both' (email and password, or Google: the default), 'password' (email
--   and password only) or 'google' (Google only). The sign-in page shows
--   Google only while the Google provider is really on in Supabase, so the
--   default changes nothing for an install without it. An Owner sets it in
--   Settings > Workspace. Membership stays the gate either way: a Google
--   sign-in gets in only with an active team_members row.
-- - pm.login_has_password(uuid): whether a login has a password, so a member
--   is never left without a way in when they unlink Google. Service role only.
-- - pm.other_logins_exist(uuid): whether the project has logins besides this
--   one. Claiming the first Owner with Google then needs the host's setup
--   code, exactly like the password path. Service role only.
-- - pm.member_sign_in_reach(): for each active person on the team who has
--   signed in, whether they have a password and whether Google is linked, so
--   an Owner changing the methods sees who would be left with no way in.
--   Service role only.
--
-- Additive and safe to run twice. The previous release's code never reads the
-- new column or calls the new functions.

-- ---------------------------------------------------------------------------
-- The workspace setting: which ways people sign in
-- ---------------------------------------------------------------------------
-- Last of the table changes: these lock business_settings, briefly.
ALTER TABLE pm.business_settings
  ADD COLUMN IF NOT EXISTS sign_in_methods text NOT NULL DEFAULT 'both';
ALTER TABLE pm.business_settings ALTER COLUMN sign_in_methods SET DEFAULT 'both';

ALTER TABLE pm.business_settings DROP CONSTRAINT IF EXISTS business_settings_sign_in_methods_check;
ALTER TABLE pm.business_settings
  ADD CONSTRAINT business_settings_sign_in_methods_check CHECK (sign_in_methods IN ('password', 'google', 'both'));

COMMENT ON COLUMN pm.business_settings.sign_in_methods IS
  'How people sign in: both (email and password, or Google: the default), password (email and password only) or google (Google only). The sign-in page shows Google only while the provider is on in Supabase. Only an active team member gets in either way. An Owner sets it.';

-- Owner-only settings on the business row, now with the sign-in methods.
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
       OR NEW.connect_ai_enabled IS DISTINCT FROM true OR NEW.personal_key_lifetime_days IS NOT NULL
       OR NEW.sign_in_methods IS DISTINCT FROM 'both'))
     OR (TG_OP = 'UPDATE' AND (NEW.auto_migrate IS DISTINCT FROM OLD.auto_migrate
       OR NEW.owners_read_personal_inboxes IS DISTINCT FROM OLD.owners_read_personal_inboxes
       OR NEW.agents_paused_at IS DISTINCT FROM OLD.agents_paused_at
       OR NEW.agents_paused_by IS DISTINCT FROM OLD.agents_paused_by
       OR NEW.audit_retention_days IS DISTINCT FROM OLD.audit_retention_days
       OR NEW.audit_redact_keys IS DISTINCT FROM OLD.audit_redact_keys
       OR NEW.connect_ai_enabled IS DISTINCT FROM OLD.connect_ai_enabled
       OR NEW.personal_key_lifetime_days IS DISTINCT FROM OLD.personal_key_lifetime_days
       OR NEW.sign_in_methods IS DISTINCT FROM OLD.sign_in_methods)) THEN
    IF COALESCE(pm.current_team_member_role(), '') <> 'owner' THEN
      RAISE EXCEPTION 'Only an Owner can change this setting' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.business_settings_owner_columns() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What the server needs to know about a login (service role only)
-- ---------------------------------------------------------------------------
-- Whether a login has a password: an invited person who joined with Google
-- has none, so unlinking Google would leave them no way in.
CREATE OR REPLACE FUNCTION pm.login_has_password(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user AND coalesce(u.encrypted_password, '') <> '')
$$;

REVOKE ALL ON FUNCTION pm.login_has_password(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.login_has_password(uuid) TO service_role;

-- Whether the project has logins besides this one (another app's users).
-- Signing in with Google makes a login before the first Owner is claimed, so
-- the claim asks about the others, not about any login at all.
CREATE OR REPLACE FUNCTION pm.other_logins_exist(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM auth.users u WHERE u.id IS DISTINCT FROM p_user)
$$;

REVOKE ALL ON FUNCTION pm.other_logins_exist(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.other_logins_exist(uuid) TO service_role;

-- Who could sign in each way, for an Owner changing the sign-in methods:
-- every active person on the team (agents work through keys) whose login has
-- signed in at least once (an invite still waiting can be accepted either
-- way), with whether it has a password and whether Google is linked.
CREATE OR REPLACE FUNCTION pm.member_sign_in_reach()
RETURNS TABLE (member_id uuid, name text, has_password boolean, has_google boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.id, m.name,
         coalesce(u.encrypted_password, '') <> '',
         EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'google')
  FROM pm.team_members m
  JOIN auth.users u ON u.id = m.auth_user_id
  WHERE m.status = 'active' AND m.role <> 'agent' AND u.last_sign_in_at IS NOT NULL
  ORDER BY m.name, m.id
$$;

REVOKE ALL ON FUNCTION pm.member_sign_in_reach() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.member_sign_in_reach() TO service_role;
