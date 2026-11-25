-- Follow-ups: a wake signal for re-queued mail, a default lifetime for
-- personal API keys, and group handlers' inbox access derived when it is read.
--
-- - messages.requeued_at: when a message last went back to New for the agent
--   after it had left New (a person sent it back, answered its question,
--   moved it out of Filtered, or undid a meeting's "Nothing to do"). A
--   trigger stamps it on every such change, whichever code makes it, so the
--   previous release's code stamps it too; nothing else can write it.
--   GET /api/v1/inbox/signal adds plans_newest_queued_at (the greatest of
--   received_at and requeued_at over what is ready to plan), so an agent
--   harness that wakes on a newer time sees a re-queued message whose
--   received_at is old.
-- - business_settings.personal_key_lifetime_days: how long a person's new
--   key lasts unless they choose otherwise, and for anyone but an Owner the
--   longest they may choose (null: until revoked, no limit, the default).
--   Only an Owner changes it.
-- - Group handlers: a member of a group that handles an inbox reads it while
--   they are in the group, the group is live and it still handles the inbox
--   (pm.can_read_inbox), instead of being copied into inbox_access and never
--   taken off. The copying stops. The rows it made are removed where they
--   can be told apart: no creator (every grant a person makes names one),
--   made no earlier than the group became a handler, for someone still in
--   that group who is not a member handler or the owner of the inbox. Every
--   other grant stays, including the rows of people who already left a
--   handler group (they cannot be told apart from a member handler's grant
--   made in the same statement): an Owner removes those in the inbox's access.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the new columns; its status writes are stamped by the trigger. One
-- difference while it runs on this database: its server reads of who reads
-- an inbox look at inbox_access only, so someone who reads an inbox only
-- through a handler group does not see it there until the new code deploys
-- (row security already lets them).

-- ---------------------------------------------------------------------------
-- Re-queued mail: messages.requeued_at
-- ---------------------------------------------------------------------------
ALTER TABLE pm.messages
  ADD COLUMN IF NOT EXISTS requeued_at timestamptz;

COMMENT ON COLUMN pm.messages.requeued_at IS
  'When the message last went back to New for the agent after leaving it (sent back, answered, moved out of Filtered). Stamped by a trigger; null until then.';

CREATE OR REPLACE FUNCTION pm.messages_stamp_requeued()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.requeued_at := NULL;
  ELSIF NEW.status = 'new' AND OLD.status NOT IN ('new', 'receiving') THEN
    NEW.requeued_at := now();
  ELSE
    NEW.requeued_at := OLD.requeued_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.messages_stamp_requeued() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_stamp_requeued ON pm.messages;
CREATE TRIGGER messages_stamp_requeued
  BEFORE INSERT OR UPDATE ON pm.messages
  FOR EACH ROW EXECUTE FUNCTION pm.messages_stamp_requeued();

-- ---------------------------------------------------------------------------
-- A default lifetime for personal API keys
-- ---------------------------------------------------------------------------
ALTER TABLE pm.business_settings
  ADD COLUMN IF NOT EXISTS personal_key_lifetime_days integer;

ALTER TABLE pm.business_settings DROP CONSTRAINT IF EXISTS business_settings_personal_key_lifetime_days_check;
ALTER TABLE pm.business_settings
  ADD CONSTRAINT business_settings_personal_key_lifetime_days_check CHECK (personal_key_lifetime_days IS NULL OR personal_key_lifetime_days BETWEEN 1 AND 3650);

COMMENT ON COLUMN pm.business_settings.personal_key_lifetime_days IS
  'How many days a person''s new key lasts unless they choose otherwise, and the longest anyone but an Owner may choose (null: until revoked, no limit). Keys made before keep their own expiry. An Owner sets it.';

-- Owner-only settings on the business row, now with the personal key lifetime.
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
       OR NEW.connect_ai_enabled IS DISTINCT FROM true OR NEW.personal_key_lifetime_days IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (NEW.auto_migrate IS DISTINCT FROM OLD.auto_migrate
       OR NEW.owners_read_personal_inboxes IS DISTINCT FROM OLD.owners_read_personal_inboxes
       OR NEW.agents_paused_at IS DISTINCT FROM OLD.agents_paused_at
       OR NEW.agents_paused_by IS DISTINCT FROM OLD.agents_paused_by
       OR NEW.audit_retention_days IS DISTINCT FROM OLD.audit_retention_days
       OR NEW.audit_redact_keys IS DISTINCT FROM OLD.audit_redact_keys
       OR NEW.connect_ai_enabled IS DISTINCT FROM OLD.connect_ai_enabled
       OR NEW.personal_key_lifetime_days IS DISTINCT FROM OLD.personal_key_lifetime_days)) THEN
    IF COALESCE(pm.current_team_member_role(), '') <> 'owner' THEN
      RAISE EXCEPTION 'Only an Owner can change this setting' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.business_settings_owner_columns() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Group handlers: inbox access derived when it is read
-- ---------------------------------------------------------------------------
-- Who reads an inbox, as before, plus the members of a live group that
-- handles it, for as long as all three hold.
CREATE OR REPLACE FUNCTION pm.can_read_inbox(p_inbox_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pm.inboxes i
    WHERE i.id = p_inbox_id
      AND CASE
        -- Shared: inbound_email.manage reads every one; inbound_email.read the granted ones.
        WHEN i.owner_member_id IS NULL THEN
          pm.has_permission('inbound_email.manage', 'app')
          OR (
            pm.has_permission('inbound_email.read', 'app')
            AND (
              EXISTS (
                SELECT 1 FROM pm.inbox_access a
                WHERE a.inbox_id = i.id AND a.member_id = pm.current_team_member_id()
              )
              OR EXISTS (
                SELECT 1 FROM pm.inbox_handlers h
                JOIN pm.group_members gm ON gm.group_id = h.handler_group_id
                JOIN pm.groups g ON g.id = h.handler_group_id AND g.deleted_at IS NULL
                WHERE h.inbox_id = i.id AND gm.member_id = pm.current_team_member_id()
              )
            )
          )
        -- Personal: its owner and the people it was shared with, while the
        -- Inbox is on; managing inboxes only while the workspace allows it.
        ELSE
          (
            pm.module_enabled('inbox')
            AND (
              i.owner_member_id = pm.current_team_member_id()
              OR EXISTS (
                SELECT 1 FROM pm.inbox_access a
                WHERE a.inbox_id = i.id AND a.member_id = pm.current_team_member_id()
              )
              OR EXISTS (
                SELECT 1 FROM pm.inbox_handlers h
                JOIN pm.group_members gm ON gm.group_id = h.handler_group_id
                JOIN pm.groups g ON g.id = h.handler_group_id AND g.deleted_at IS NULL
                WHERE h.inbox_id = i.id AND gm.member_id = pm.current_team_member_id()
              )
            )
          )
          OR (
            pm.has_permission('inbound_email.manage', 'app')
            AND COALESCE((SELECT s.owners_read_personal_inboxes FROM pm.business_settings s LIMIT 1), false)
          )
      END
  )
$$;

REVOKE ALL ON FUNCTION pm.can_read_inbox(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pm.can_read_inbox(uuid) TO authenticated, service_role;

-- Changing the rows: a member handler reads its inbox (a group's members read
-- it through the group, above), and the column follows the primary member.
CREATE OR REPLACE FUNCTION pm.inbox_handlers_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_inbox uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.inbox_id ELSE NEW.inbox_id END;
  v_primary uuid;
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.handler_member_id IS NOT NULL THEN
    INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES (NEW.inbox_id, NEW.handler_member_id)
    ON CONFLICT DO NOTHING;
  END IF;
  IF coalesce(current_setting('pm.inbox_handler_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  SELECT h.handler_member_id INTO v_primary FROM pm.inbox_handlers h WHERE h.inbox_id = v_inbox AND h.is_primary;
  PERFORM set_config('pm.inbox_handler_sync', 'on', true);
  UPDATE pm.inboxes SET handler_member_id = v_primary
  WHERE id = v_inbox AND handler_member_id IS DISTINCT FROM v_primary;
  PERFORM set_config('pm.inbox_handler_sync', '', true);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.inbox_handlers_after_write() FROM PUBLIC, anon, authenticated;

-- Joining a group no longer copies its inboxes' access.
DROP TRIGGER IF EXISTS group_members_grant_handled_inboxes ON pm.group_members;
DROP FUNCTION IF EXISTS pm.group_members_grant_handled_inboxes();

-- The rows the copying made, where they can be told apart (see the header).
DELETE FROM pm.inbox_access a
USING pm.inbox_handlers h, pm.group_members gm, pm.inboxes i
WHERE h.inbox_id = a.inbox_id
  AND h.handler_group_id IS NOT NULL
  AND gm.group_id = h.handler_group_id
  AND gm.member_id = a.member_id
  AND i.id = a.inbox_id
  AND a.created_by IS NULL
  AND a.created_at >= h.created_at
  AND a.member_id IS DISTINCT FROM i.owner_member_id
  AND a.member_id IS DISTINCT FROM i.handler_member_id
  AND NOT EXISTS (
    SELECT 1 FROM pm.inbox_handlers mh
    WHERE mh.inbox_id = a.inbox_id AND mh.handler_member_id = a.member_id
  );
