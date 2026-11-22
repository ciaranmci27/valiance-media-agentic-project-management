-- Getting ready for 2.0, where the app moves into its own schemas so it can
-- share a database with a company's other apps:
-- 1. The empty schemas `pm` (the app) and `pm_custom` (an install's own),
--    with the same grants Supabase gives `public`, and served by the API:
--    appended to the API's list of schemas, keeping every schema already on
--    it. Where that list is not kept in the database (some self-hosted
--    setups), nothing is changed and Settings says how to add them.
-- 2. Outsiders get nothing: an account with no active membership (another
--    app's user on a shared project, a deactivated member) could read four
--    tables and upload, change or delete files in three storage buckets.
--    Now each needs an active membership. Members see no difference.
-- Additive and safe to run twice; 1.10 code works with it.

-- 1. Schemas
CREATE SCHEMA IF NOT EXISTS pm;
CREATE SCHEMA IF NOT EXISTS pm_custom;
GRANT USAGE ON SCHEMA pm, pm_custom TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm_custom GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm_custom GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm_custom GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
COMMENT ON SCHEMA pm IS 'The PM app (core): changed only by its releases.';
COMMENT ON SCHEMA pm_custom IS 'This install''s own PM app tables and functions: never changed by a release.';

DO $expose$
DECLARE
  current_list text;
  next_list text := '';
  wanted text;
BEGIN
  SELECT substring(setting FROM 'pgrst.db_schemas=(.*)') INTO current_list
  FROM pg_roles r, unnest(r.rolconfig) AS setting
  WHERE r.rolname = 'authenticator' AND setting LIKE 'pgrst.db_schemas=%';
  -- No list in the database: leave it to the host's own settings.
  IF current_list IS NULL OR btrim(current_list) = '' THEN
    RETURN;
  END IF;
  next_list := current_list;
  FOREACH wanted IN ARRAY ARRAY['pm', 'pm_custom'] LOOP
    IF NOT (wanted = ANY (SELECT btrim(s) FROM unnest(string_to_array(current_list, ',')) AS s)) THEN
      next_list := next_list || ', ' || wanted;
    END IF;
  END LOOP;
  IF next_list <> current_list THEN
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', next_list);
    NOTIFY pgrst, 'reload config';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not add pm and pm_custom to the API''s schemas; add them in your Supabase API settings.';
END
$expose$;

-- 2. Outsiders: four tables readable by any signed-in account.
DROP POLICY IF EXISTS agent_health_select ON public.agent_health;
CREATE POLICY agent_health_select ON public.agent_health FOR SELECT TO authenticated
  USING ((select public.current_team_member_id()) IS NOT NULL AND (select public.module_enabled('agents')));
DROP POLICY IF EXISTS agent_health_history_select ON public.agent_health_history;
CREATE POLICY agent_health_history_select ON public.agent_health_history FOR SELECT TO authenticated
  USING ((select public.current_team_member_id()) IS NOT NULL AND (select public.module_enabled('agents')));
DROP POLICY IF EXISTS trash_events_select ON public.trash_events;
CREATE POLICY trash_events_select ON public.trash_events FOR SELECT TO authenticated
  USING ((select public.current_team_member_id()) IS NOT NULL);
DROP POLICY IF EXISTS workspace_region_read ON public.workspace_region;
CREATE POLICY workspace_region_read ON public.workspace_region FOR SELECT TO authenticated
  USING ((select public.current_team_member_id()) IS NOT NULL);

-- Storage: uploads, changes and deletes need an active membership. Public
-- reads of the public buckets are unchanged (their links keep working).
DROP POLICY IF EXISTS "Authenticated users can upload avatars" ON storage.objects;
CREATE POLICY "Authenticated users can upload avatars" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (select public.current_team_member_id()) IS NOT NULL);
DROP POLICY IF EXISTS "Authenticated users can update avatars" ON storage.objects;
CREATE POLICY "Authenticated users can update avatars" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (select public.current_team_member_id()) IS NOT NULL);
DROP POLICY IF EXISTS "Authenticated users can delete avatars" ON storage.objects;
CREATE POLICY "Authenticated users can delete avatars" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (select public.current_team_member_id()) IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can upload portal files" ON storage.objects;
CREATE POLICY "Authenticated users can upload portal files" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'portal-files' AND (select public.current_team_member_id()) IS NOT NULL);
DROP POLICY IF EXISTS "Authenticated users can update portal files" ON storage.objects;
CREATE POLICY "Authenticated users can update portal files" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'portal-files' AND (select public.current_team_member_id()) IS NOT NULL);
DROP POLICY IF EXISTS "Authenticated users can delete portal files" ON storage.objects;
CREATE POLICY "Authenticated users can delete portal files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'portal-files' AND (select public.current_team_member_id()) IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can upload entity files" ON storage.objects;
CREATE POLICY "Authenticated users can upload entity files" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'entity-files' AND (select public.current_team_member_id()) IS NOT NULL);
DROP POLICY IF EXISTS "Authenticated users can update entity files" ON storage.objects;
CREATE POLICY "Authenticated users can update entity files" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'entity-files' AND (select public.current_team_member_id()) IS NOT NULL);
DROP POLICY IF EXISTS "Authenticated users can delete entity files" ON storage.objects;
CREATE POLICY "Authenticated users can delete entity files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'entity-files' AND (select public.current_team_member_id()) IS NOT NULL);
DROP POLICY IF EXISTS "Authenticated users can read entity files" ON storage.objects;
CREATE POLICY "Authenticated users can read entity files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'entity-files' AND (select public.current_team_member_id()) IS NOT NULL);
