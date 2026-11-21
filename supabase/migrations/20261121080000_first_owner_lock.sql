-- The first account on a fresh install becomes its Owner (the setup wizard's
-- "Create your account" step). Two sign-ups landing at the same moment could
-- both see an empty team and both become Owner, so the signup trigger now
-- takes a transaction lock before it looks: the second waits for the first
-- to commit, then sees it.
-- The wizard marks its account (user_metadata first_owner, which is in the
-- row this trigger sees; app_metadata is written after it): such an account
-- is refused outright once anyone is on the team, so the whole sign-up rolls
-- back and nothing is left behind. Anyone can set the mark, harmlessly: it
-- can only get an account refused, never promoted.
-- Same rule as before otherwise. Safe to run twice; works with 1.7 code.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  team_exists boolean;
BEGIN
  -- One sign-up at a time decides who is first (key: 'handle_new_user').
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.handle_new_user'));
  team_exists := EXISTS (SELECT 1 FROM public.team_members);
  IF team_exists AND COALESCE(NEW.raw_user_meta_data->>'first_owner', '') = 'true' THEN
    RAISE EXCEPTION 'This workspace already has an Owner' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.team_members (auth_user_id, name, email, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    NEW.email,
    CASE WHEN team_exists THEN 'member' ELSE 'owner' END
  );
  RETURN NEW;
END;
$$;
