-- 2.0: team members are added by the app's server, never by a sign-up.
-- In a Supabase project the app shares with other apps, their users must not
-- become PM members just by having a login, and a PM problem must never stop
-- their sign-ups. So fresh 2.0 installs have no trigger on auth.users: the
-- server creates the login (the setup wizard's first Owner, an invite) and
-- then calls pm.add_team_member, service role only.
--
-- Upgraded installs keep their sign-up trigger for now (the previous version
-- relies on it during a deploy; 2.1 retires it). pm.add_team_member is safe
-- with it: the row the trigger made is found by its login and updated.
--
-- login_owned: the app made this login. A login it did not make (another
-- app's user invited to PM) is never changed by PM: no email, password or
-- invite link. Every existing member's login was made by the app: true.
--
-- Additive and safe to run twice.

ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS login_owned boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN pm.team_members.login_owned IS
  'The app created this login, so it may change its email or password. False for a login another app made.';

CREATE OR REPLACE FUNCTION pm.add_team_member(
  p_auth_user_id uuid,
  p_email text,
  p_name text,
  p_role text DEFAULT 'member',
  p_login_owned boolean DEFAULT true,
  p_first_owner boolean DEFAULT false
)
RETURNS pm.team_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  others boolean;
  member pm.team_members;
BEGIN
  IF p_auth_user_id IS NULL OR coalesce(btrim(p_email), '') = '' THEN
    RAISE EXCEPTION 'A login and an email are required' USING ERRCODE = '22023';
  END IF;
  -- One at a time decides who is first (the same lock the sign-up trigger takes).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pm.handle_new_user'));
  others := EXISTS (SELECT 1 FROM pm.team_members WHERE auth_user_id IS DISTINCT FROM p_auth_user_id);
  IF p_first_owner AND others THEN
    RAISE EXCEPTION 'This workspace already has an Owner' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO member FROM pm.team_members WHERE auth_user_id = p_auth_user_id;
  IF member.id IS NULL THEN
    INSERT INTO pm.team_members (auth_user_id, name, email, role, login_owned)
    VALUES (
      p_auth_user_id,
      coalesce(nullif(btrim(p_name), ''), split_part(p_email, '@', 1)),
      p_email,
      CASE WHEN p_first_owner THEN 'owner' ELSE coalesce(p_role, 'member') END,
      p_login_owned
    )
    RETURNING * INTO member;
  ELSE
    UPDATE pm.team_members SET
      name = coalesce(nullif(btrim(p_name), ''), name),
      role = CASE WHEN p_first_owner THEN 'owner' ELSE coalesce(p_role, role) END,
      login_owned = p_login_owned
    WHERE id = member.id
    RETURNING * INTO member;
  END IF;
  RETURN member;
END;
$$;

REVOKE ALL ON FUNCTION pm.add_team_member(uuid, text, text, text, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.add_team_member(uuid, text, text, text, boolean, boolean) TO service_role;

-- The login an email already has in this Supabase project, if any (another
-- app's user being invited to PM). An invite passes p_confirmed_only: an
-- unconfirmed login may be someone else's sign-up under that address. Service role only.
CREATE OR REPLACE FUNCTION pm.login_for_email(p_email text, p_confirmed_only boolean DEFAULT false)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id FROM auth.users u
  WHERE lower(u.email) = lower(btrim(p_email))
    AND (NOT p_confirmed_only OR u.email_confirmed_at IS NOT NULL)
  ORDER BY u.created_at LIMIT 1
$$;

REVOKE ALL ON FUNCTION pm.login_for_email(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.login_for_email(text, boolean) TO service_role;

-- Whether this Supabase project already has logins (another app's users):
-- then claiming the first Owner needs the host's setup code. Service role only.
CREATE OR REPLACE FUNCTION pm.logins_exist()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM auth.users)
$$;

REVOKE ALL ON FUNCTION pm.logins_exist() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.logins_exist() TO service_role;
