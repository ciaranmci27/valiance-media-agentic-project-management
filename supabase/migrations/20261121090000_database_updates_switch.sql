-- Settings > Updates: whether production deploys apply a release's database
-- updates on their own (scripts/build.ts reads it before migrating). On by
-- default, so a deploy with the connection string keeps the database in step
-- with the code; an Owner turns it off to apply them by hand.
-- Additive and safe to run twice; 1.8 code never reads it.

ALTER TABLE public.business_settings
  ADD COLUMN IF NOT EXISTS auto_migrate boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.business_settings.auto_migrate IS
  'Production deploys apply pending migrations first (Settings > Updates). Owners only.';

-- Owner-only settings on the business row. Admins manage the rest of it
-- (settings.manage), so a column check guards the two only an Owner may
-- change: this switch, and whether Owners read personal inboxes (1.6).
-- The app's own server (service role) and direct database sessions pass.
CREATE OR REPLACE FUNCTION public.business_settings_owner_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND (NEW.auto_migrate IS DISTINCT FROM true OR NEW.owners_read_personal_inboxes IS DISTINCT FROM false))
     OR (TG_OP = 'UPDATE' AND (NEW.auto_migrate IS DISTINCT FROM OLD.auto_migrate
       OR NEW.owners_read_personal_inboxes IS DISTINCT FROM OLD.owners_read_personal_inboxes)) THEN
    IF COALESCE(public.current_team_member_role(), '') <> 'owner' THEN
      RAISE EXCEPTION 'Only an Owner can change this setting' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.business_settings_owner_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS business_settings_owner_columns ON public.business_settings;
CREATE TRIGGER business_settings_owner_columns
  BEFORE INSERT OR UPDATE ON public.business_settings
  FOR EACH ROW EXECUTE FUNCTION public.business_settings_owner_columns();
