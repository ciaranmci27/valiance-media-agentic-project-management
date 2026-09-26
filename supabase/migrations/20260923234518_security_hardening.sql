-- Security hardening (audit batch 1).
--
-- Apply AFTER deploying the app build that ships /api/notifications: that
-- build stops calling upsert_notification from the browser, and this file
-- takes the browser's access to it away.

-- ============================================================
-- 1. entity-files: nobody lists the bucket through the storage API
-- ============================================================
-- The "to public" SELECT policy let anyone holding the anon key (it ships in
-- every page bundle) list and fetch every object. Public object URLs on this
-- still-public bucket skip policies entirely, so the links the app and the
-- portal already hand out keep working; only API reads now need a session.
DROP POLICY IF EXISTS "Public can read entity files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read entity files" ON storage.objects;
CREATE POLICY "Authenticated users can read entity files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'entity-files');

-- ============================================================
-- 2. upsert_notification: server-side callers only
-- ============================================================
-- SECURITY DEFINER with no caller check, executable by every role, so any
-- session could plant a notification (with any link) in anyone's inbox.
-- Its callers are now the service role (the app's /api/notifications route,
-- the v1 API, client-communication approvals) and SECURITY DEFINER functions
-- (retainer drafts), none of which need the grants revoked here.
ALTER FUNCTION public.upsert_notification(uuid, text, text, text, text, text)
  SET search_path = public;
REVOKE ALL ON FUNCTION public.upsert_notification(uuid, text, text, text, text, text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_notification(uuid, text, text, text, text, text)
  TO service_role;
