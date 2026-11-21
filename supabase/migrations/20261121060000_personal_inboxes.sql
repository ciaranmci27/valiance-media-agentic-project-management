-- Personal inboxes: every teammate can connect their own email.
--
-- 1. An inbox may belong to one person (owner_member_id). NULL is a shared
--    inbox, as every inbox was until now, and keeps today's access exactly.
-- 2. A personal inbox is read by its owner, by the people and agents its
--    owner grants (inbox_access), and by those who manage inboxes only while
--    the workspace allows Owners to read personal inboxes
--    (business_settings.owners_read_personal_inboxes, off by default). Without
--    it, managing inboxes sees that a personal inbox exists and how it is
--    doing, never its mail, and may only turn it off or on (offboarding).
-- 3. inbound_email.personal ("Connect your own inbox", module inbox): create,
--    change and remove your own personal inboxes and choose who reads them.
--    Owners, Admins and Members start with it.
--    Acting on a personal inbox's mail (triage) is checked by the server per
--    inbox: its owner, or someone it was shared with who holds
--    inbound_email.triage; reading under the workspace switch is read only.
--    No policy lets a person write triage, so there is nothing to change here.
-- 4. can_read_inbox() is the one definition every policy uses (messages,
--    threads, files, triage, task links, through can_read_message), so each
--    of them follows the new rule. can_manage_inbox() decides who changes an
--    inbox and who sees its grants.
-- 5. A personal inbox never becomes shared: its owner's member row cannot be
--    deleted while it exists (ON DELETE RESTRICT; members are deactivated,
--    never deleted).
--
-- Works with the 1.5.0 code: that code never sets owner_member_id, so every
-- inbox stays shared and reads as before. Nothing is deleted. Safe to re-run.

-- 1. Whose inbox it is.
ALTER TABLE communications.inboxes
  ADD COLUMN IF NOT EXISTS owner_member_id uuid REFERENCES public.team_members(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_inboxes_owner_member
  ON communications.inboxes (owner_member_id) WHERE owner_member_id IS NOT NULL;

-- 2. The workspace switch.
ALTER TABLE public.business_settings
  ADD COLUMN IF NOT EXISTS owners_read_personal_inboxes boolean NOT NULL DEFAULT false;

-- 3. The permission and its defaults (Owners hold every permission).
INSERT INTO public.permission_modules (permission_key, module_id) VALUES ('inbound_email.personal', 'inbox')
ON CONFLICT (permission_key) DO UPDATE SET module_id = EXCLUDED.module_id;

INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'inbound_email.personal', 'app'),
  ('member', 'inbound_email.personal', 'app')
ON CONFLICT DO NOTHING;

-- 4. Who reads an inbox, and who changes it.
CREATE OR REPLACE FUNCTION communications.can_read_inbox(p_inbox_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM communications.inboxes i
    WHERE i.id = p_inbox_id
      AND CASE
        -- Shared: inbound_email.manage reads every one; inbound_email.read the granted ones.
        WHEN i.owner_member_id IS NULL THEN
          public.has_permission('inbound_email.manage', 'app')
          OR (
            public.has_permission('inbound_email.read', 'app')
            AND EXISTS (
              SELECT 1 FROM communications.inbox_access a
              WHERE a.inbox_id = i.id AND a.member_id = public.current_team_member_id()
            )
          )
        -- Personal: its owner and the people it was shared with, while the
        -- Inbox is on; managing inboxes only while the workspace allows it.
        ELSE
          (
            public.module_enabled('inbox')
            AND (
              i.owner_member_id = public.current_team_member_id()
              OR EXISTS (
                SELECT 1 FROM communications.inbox_access a
                WHERE a.inbox_id = i.id AND a.member_id = public.current_team_member_id()
              )
            )
          )
          OR (
            public.has_permission('inbound_email.manage', 'app')
            AND COALESCE((SELECT s.owners_read_personal_inboxes FROM public.business_settings s LIMIT 1), false)
          )
      END
  )
$$;

CREATE OR REPLACE FUNCTION communications.can_manage_inbox(p_inbox_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM communications.inboxes i
    WHERE i.id = p_inbox_id
      AND CASE
        WHEN i.owner_member_id IS NULL THEN public.has_permission('inbound_email.manage', 'app')
        ELSE i.owner_member_id = public.current_team_member_id() AND public.has_permission('inbound_email.personal', 'app')
      END
  )
$$;

REVOKE ALL ON FUNCTION communications.can_manage_inbox(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION communications.can_manage_inbox(uuid) TO authenticated, service_role;

-- An inbox never changes hands: a shared one stays shared, a personal one
-- its owner's (whose member row cannot be deleted while it exists: ON DELETE
-- RESTRICT). Someone else's personal inbox is only switched off or on, never
-- edited: managing inboxes may turn it off when its owner leaves. Server code
-- (the service role, no member) checks for itself.
CREATE OR REPLACE FUNCTION communications.inboxes_guard_personal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_actor uuid := public.current_team_member_id();
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.owner_member_id IS DISTINCT FROM OLD.owner_member_id THEN
    RAISE EXCEPTION 'An inbox never changes hands: a shared inbox stays shared, a personal one stays its owner''s.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.owner_member_id IS NULL OR OLD.owner_member_id = v_actor THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'enabled' - 'updated_at' - 'routing_address')
     IS DISTINCT FROM (to_jsonb(OLD) - 'enabled' - 'updated_at' - 'routing_address') THEN
    RAISE EXCEPTION 'Only its owner changes a personal inbox. Others may turn it off or on.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION communications.inboxes_guard_personal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inboxes_guard_personal ON communications.inboxes;
CREATE TRIGGER inboxes_guard_personal
  BEFORE UPDATE ON communications.inboxes
  FOR EACH ROW EXECUTE FUNCTION communications.inboxes_guard_personal();

-- 5. Policies. Managing inboxes still sees every inbox row (a personal one's
--    name, address and health), but its mail follows can_read_inbox().
DROP POLICY IF EXISTS email_inboxes_select ON communications.inboxes;
CREATE POLICY email_inboxes_select ON communications.inboxes FOR SELECT TO authenticated
  USING (communications.can_read_inbox(id) OR public.has_permission('inbound_email.manage'));

DROP POLICY IF EXISTS email_inboxes_manage ON communications.inboxes;
CREATE POLICY email_inboxes_manage ON communications.inboxes FOR ALL TO authenticated
  USING (owner_member_id IS NULL AND public.has_permission('inbound_email.manage'))
  WITH CHECK (owner_member_id IS NULL AND public.has_permission('inbound_email.manage'));

-- A person creates personal inboxes only for themselves, and changes only their own.
DROP POLICY IF EXISTS email_inboxes_personal ON communications.inboxes;
CREATE POLICY email_inboxes_personal ON communications.inboxes FOR ALL TO authenticated
  USING (owner_member_id = public.current_team_member_id() AND public.has_permission('inbound_email.personal'))
  WITH CHECK (owner_member_id = public.current_team_member_id() AND public.has_permission('inbound_email.personal'));

-- Offboarding: turning someone's personal inbox off or on (inboxes_guard_personal allows nothing else).
DROP POLICY IF EXISTS email_inboxes_switch_personal ON communications.inboxes;
CREATE POLICY email_inboxes_switch_personal ON communications.inboxes FOR UPDATE TO authenticated
  USING (owner_member_id IS NOT NULL AND public.has_permission('inbound_email.manage'))
  WITH CHECK (owner_member_id IS NOT NULL AND public.has_permission('inbound_email.manage'));

DROP POLICY IF EXISTS email_inbox_access_select ON communications.inbox_access;
CREATE POLICY email_inbox_access_select ON communications.inbox_access FOR SELECT TO authenticated
  USING (member_id = public.current_team_member_id() OR communications.can_manage_inbox(inbox_id));

DROP POLICY IF EXISTS email_inbox_access_manage ON communications.inbox_access;
CREATE POLICY email_inbox_access_manage ON communications.inbox_access FOR ALL TO authenticated
  USING (communications.can_manage_inbox(inbox_id))
  WITH CHECK (communications.can_manage_inbox(inbox_id));
