-- Inbox handlers, per-inbox defaults and sender rules for one inbox: an inbox
-- can be handled by several agents, people or groups, says who new work goes
-- to when a request leaves it out, and keeps rules of its own.
--
-- - pm.inbox_handlers: who handles an inbox, a member (handler_member_id) or
--   a group (handler_group_id), exactly one of the two. One handler is the
--   primary (is_primary), and only a member can be: the primary is the
--   handler drafts and the older code know. One primary per inbox, each
--   handler once per inbox. Backfilled with one primary row from every
--   inbox's handler_member_id. Read by whoever reads or manages the inbox;
--   only the server writes.
-- - inboxes.handler_member_id keeps working, kept in step with the primary
--   row both ways by two triggers: writing the column makes that member the
--   primary (replacing the old primary; null removes it), and changing the
--   rows sets the column to the primary member (null when there is none).
--   A transaction-local flag (pm.inbox_handler_sync) stops each trigger
--   reacting to the other's write.
-- - A handler always reads its inbox, as inboxes_grant_handler does for the
--   column: a member handler is granted inbox_access, a group handler grants
--   every member of the group, and someone who joins the group later is
--   granted then. Access is granted, never taken back, as before.
-- - inboxes: default_assignee_member_id or default_assignee_group_id (who new
--   work goes to), default_project_id, and decision_member_id or
--   decision_group_id (who gets decisions). At most one of each pair. The app
--   uses them only when a request leaves that field out; all null, it does
--   exactly what it did before.
-- - sender_rules: scope (workspace, the default, or inbox) and inbox_id, set
--   together (sender_rules_scope_inbox). A rule for one inbox sorts only that
--   inbox's mail. The live-rule key adds inbox_id, so a sender can have a
--   workspace rule and a rule for one inbox at once.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the new table or columns: it writes handler_member_id (the triggers
-- keep the primary row in step), its sender rule inserts take the workspace
-- scope by default, and it only ever finds workspace rules because nothing it
-- does makes an inbox rule. The new functions are trigger functions only.

-- ---------------------------------------------------------------------------
-- Inbox handlers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.inbox_handlers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES pm.inboxes(id) ON DELETE CASCADE,
  handler_member_id uuid REFERENCES pm.team_members(id) ON DELETE CASCADE,
  handler_group_id uuid REFERENCES pm.groups(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.inbox_handlers DROP CONSTRAINT IF EXISTS inbox_handlers_one_handler;
ALTER TABLE pm.inbox_handlers
  ADD CONSTRAINT inbox_handlers_one_handler CHECK (num_nonnulls(handler_member_id, handler_group_id) = 1);
ALTER TABLE pm.inbox_handlers DROP CONSTRAINT IF EXISTS inbox_handlers_primary_is_member;
ALTER TABLE pm.inbox_handlers
  ADD CONSTRAINT inbox_handlers_primary_is_member CHECK (NOT is_primary OR handler_member_id IS NOT NULL);

COMMENT ON TABLE pm.inbox_handlers IS
  'Who handles an inbox: members or groups, one member the primary (mirrored in inboxes.handler_member_id). Written by the server only.';
COMMENT ON COLUMN pm.inbox_handlers.is_primary IS
  'The primary handler: always a member, one per inbox, kept equal to inboxes.handler_member_id both ways.';

-- One primary per inbox; each member or group once per inbox; what a member or group handles.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_handlers_one_primary ON pm.inbox_handlers (inbox_id) WHERE is_primary;
CREATE UNIQUE INDEX IF NOT EXISTS inbox_handlers_member_key ON pm.inbox_handlers (inbox_id, handler_member_id) WHERE handler_member_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inbox_handlers_group_key ON pm.inbox_handlers (inbox_id, handler_group_id) WHERE handler_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_handlers_member ON pm.inbox_handlers (handler_member_id) WHERE handler_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_handlers_group ON pm.inbox_handlers (handler_group_id) WHERE handler_group_id IS NOT NULL;

-- Every inbox's handler becomes its primary row (an inbox that has one keeps it).
INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id, is_primary)
SELECT i.id, i.handler_member_id, true
FROM pm.inboxes i
WHERE i.handler_member_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pm.inbox_handlers h WHERE h.inbox_id = i.id AND h.is_primary)
ON CONFLICT DO NOTHING;

-- Writing the column: that member becomes the primary (an existing handler
-- row is promoted), the old primary row goes; null removes the primary.
CREATE OR REPLACE FUNCTION pm.inboxes_sync_primary_handler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_primary uuid;
BEGIN
  IF coalesce(current_setting('pm.inbox_handler_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.handler_member_id IS NOT DISTINCT FROM OLD.handler_member_id THEN
    RETURN NULL;
  END IF;
  SELECT h.handler_member_id INTO v_primary FROM pm.inbox_handlers h WHERE h.inbox_id = NEW.id AND h.is_primary;
  IF v_primary IS NOT DISTINCT FROM NEW.handler_member_id THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('pm.inbox_handler_sync', 'on', true);
  DELETE FROM pm.inbox_handlers WHERE inbox_id = NEW.id AND is_primary;
  IF NEW.handler_member_id IS NOT NULL THEN
    UPDATE pm.inbox_handlers SET is_primary = true
    WHERE inbox_id = NEW.id AND handler_member_id = NEW.handler_member_id;
    IF NOT FOUND THEN
      INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id, is_primary)
      VALUES (NEW.id, NEW.handler_member_id, true);
    END IF;
  END IF;
  PERFORM set_config('pm.inbox_handler_sync', '', true);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.inboxes_sync_primary_handler() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inboxes_sync_primary_handler ON pm.inboxes;
CREATE TRIGGER inboxes_sync_primary_handler
  AFTER INSERT OR UPDATE OF handler_member_id ON pm.inboxes
  FOR EACH ROW EXECUTE FUNCTION pm.inboxes_sync_primary_handler();

-- Changing the rows: a handler reads its inbox (a group's members too), and
-- the column follows the primary member.
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
  IF TG_OP <> 'DELETE' THEN
    IF NEW.handler_member_id IS NOT NULL THEN
      INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES (NEW.inbox_id, NEW.handler_member_id)
      ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO pm.inbox_access (inbox_id, member_id)
      SELECT NEW.inbox_id, gm.member_id FROM pm.group_members gm WHERE gm.group_id = NEW.handler_group_id
      ON CONFLICT DO NOTHING;
    END IF;
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

DROP TRIGGER IF EXISTS inbox_handlers_after_write ON pm.inbox_handlers;
CREATE TRIGGER inbox_handlers_after_write
  AFTER INSERT OR UPDATE OR DELETE ON pm.inbox_handlers
  FOR EACH ROW EXECUTE FUNCTION pm.inbox_handlers_after_write();

-- Someone who joins a group reads the inboxes it handles.
CREATE OR REPLACE FUNCTION pm.group_members_grant_handled_inboxes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  INSERT INTO pm.inbox_access (inbox_id, member_id)
  SELECT h.inbox_id, NEW.member_id FROM pm.inbox_handlers h WHERE h.handler_group_id = NEW.group_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.group_members_grant_handled_inboxes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS group_members_grant_handled_inboxes ON pm.group_members;
CREATE TRIGGER group_members_grant_handled_inboxes
  AFTER INSERT ON pm.group_members
  FOR EACH ROW EXECUTE FUNCTION pm.group_members_grant_handled_inboxes();

ALTER TABLE pm.inbox_handlers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_handlers_select ON pm.inbox_handlers;
CREATE POLICY inbox_handlers_select ON pm.inbox_handlers FOR SELECT TO authenticated
  USING (pm.can_read_inbox(inbox_handlers.inbox_id) OR pm.can_manage_inbox(inbox_handlers.inbox_id));

DROP POLICY IF EXISTS inbox_handlers_module_on ON pm.inbox_handlers;
CREATE POLICY inbox_handlers_module_on ON pm.inbox_handlers AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select pm.module_enabled('inbox')));

REVOKE ALL ON pm.inbox_handlers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.inbox_handlers TO authenticated;
GRANT ALL ON pm.inbox_handlers TO service_role;

-- ---------------------------------------------------------------------------
-- Per-inbox defaults: used only when a request leaves the field out
-- ---------------------------------------------------------------------------
ALTER TABLE pm.inboxes
  ADD COLUMN IF NOT EXISTS default_assignee_member_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_assignee_group_id uuid REFERENCES pm.groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_project_id uuid REFERENCES pm.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decision_member_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decision_group_id uuid REFERENCES pm.groups(id) ON DELETE SET NULL;

ALTER TABLE pm.inboxes DROP CONSTRAINT IF EXISTS inboxes_default_assignee_one;
ALTER TABLE pm.inboxes
  ADD CONSTRAINT inboxes_default_assignee_one CHECK (num_nonnulls(default_assignee_member_id, default_assignee_group_id) <= 1);
ALTER TABLE pm.inboxes DROP CONSTRAINT IF EXISTS inboxes_decision_recipient_one;
ALTER TABLE pm.inboxes
  ADD CONSTRAINT inboxes_decision_recipient_one CHECK (num_nonnulls(decision_member_id, decision_group_id) <= 1);

COMMENT ON COLUMN pm.inboxes.default_assignee_member_id IS
  'Who new work from this inbox goes to when a request names no one (else the workspace Owner). At most one of this and default_assignee_group_id.';
COMMENT ON COLUMN pm.inboxes.default_assignee_group_id IS
  'A group new work goes to when a request names no one: its leads. At most one of this and default_assignee_member_id.';
COMMENT ON COLUMN pm.inboxes.default_project_id IS
  'The project used when a request from this inbox leaves the project out and may have none.';
COMMENT ON COLUMN pm.inboxes.decision_member_id IS
  'Who gets this inbox''s decisions (an agent''s notification to the owner about it). At most one of this and decision_group_id.';
COMMENT ON COLUMN pm.inboxes.decision_group_id IS
  'A group that gets this inbox''s decisions: every active member. At most one of this and decision_member_id.';

-- ---------------------------------------------------------------------------
-- Sender rules for one inbox
-- ---------------------------------------------------------------------------
ALTER TABLE pm.sender_rules
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS inbox_id uuid REFERENCES pm.inboxes(id) ON DELETE CASCADE;

ALTER TABLE pm.sender_rules DROP CONSTRAINT IF EXISTS sender_rules_scope_check;
ALTER TABLE pm.sender_rules
  ADD CONSTRAINT sender_rules_scope_check CHECK (scope IN ('workspace', 'inbox'));
ALTER TABLE pm.sender_rules DROP CONSTRAINT IF EXISTS sender_rules_scope_inbox;
ALTER TABLE pm.sender_rules
  ADD CONSTRAINT sender_rules_scope_inbox CHECK ((scope = 'inbox') = (inbox_id IS NOT NULL));

COMMENT ON COLUMN pm.sender_rules.scope IS
  'workspace (every inbox, the default) or inbox (only inbox_id''s mail).';

-- One live rule per sender, topic, recipient and inbox (none: the workspace).
DROP INDEX IF EXISTS pm.email_sender_rules_live_key;
CREATE UNIQUE INDEX IF NOT EXISTS sender_rules_live_key
  ON pm.sender_rules (match_kind, match_value, COALESCE(topic, ''), COALESCE(recipient, ''), COALESCE(inbox_id::text, '')) WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sender_rules_inbox ON pm.sender_rules (inbox_id) WHERE inbox_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Live sync: open screens see an inbox's handlers change.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'inbox_handlers') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.inbox_handlers;
    END IF;
  END IF;
END $$;
