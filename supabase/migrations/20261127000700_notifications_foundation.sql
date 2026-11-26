-- Notifications foundation: what a notification is, done apart from read,
-- snoozes, and one feed the app and the API read.
--
-- - pm.team_member_notifications gains category (what kind of notice it is:
--   question_asked, invoice_drafts, task_comments and so on), project_id and
--   actor_id (where it hangs and who caused it, when known) and done_at
--   (finished with: hidden from Updates; done implies read, and marking it
--   unread again undoes done). is_read stays as it was.
-- - pm.notification_category: the category of a notice from its entity type,
--   entity id and title, for every producer that does not name one. A
--   trigger fills category, and project_id and actor_id where the entity
--   says, on insert, so code from the previous release that inserts rows or
--   calls the 6 argument upsert gets them too.
-- - pm.notification_is_receipt: notices that announce something waiting on
--   a person (a question or approval asked, an agent's findings nudge, an
--   inbox decision). That thing is listed in Needs you; its notice is only a
--   delivery receipt, never shown in Updates or counted as unread. A receipt
--   never comes from free text: question_asked and approval_requested only
--   for a notice about a real pm.questions row of that kind (as
--   notify_question_asked raises them), findings_nudge only for the project
--   nudge whose title sync_findings_notification clears by, inbox_decision
--   only when its producer names it.
-- - pm.upsert_notification gains an overload with category, project_id and
--   actor_id; the 6 argument form delegates to it. Raising a notice again
--   refreshes the person's unread one about the same thing only when both are
--   receipts or both are not, so a receipt never swallows an update (the
--   unread dedup index gains that split); it brings back one marked done
--   (unread, done_at cleared) rather than adding a second row.
-- - pm.member_snoozes (member_id, item_kind, item_id, until): a member hides
--   a question, task, suggestion or notification until a time. Read at read
--   time, so nothing runs when it wakes. A member reads and writes only
--   their own rows.
-- - pm.notification_feed, pm.notification_groups and
--   pm.notification_unread_count: a member's Updates (receipts, done,
--   cleared and snoozed left out), newest first and keyset paged; the same
--   grouped by what they are about (the latest row per entity with a
--   count); the unread count. Server only: the app passes the signed-in
--   member.
--
-- Additive and safe to run twice. The previous release's code reads and
-- writes notifications as before; the new columns fill themselves.

ALTER TABLE pm.team_member_notifications
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES pm.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS done_at timestamptz;

ALTER TABLE pm.team_member_notifications
  DROP CONSTRAINT IF EXISTS team_member_notifications_category_check;
ALTER TABLE pm.team_member_notifications
  ADD CONSTRAINT team_member_notifications_category_check
    CHECK (category IS NULL OR category ~ '^[a-z][a-z0-9_]{0,59}$');

COMMENT ON COLUMN pm.team_member_notifications.category IS
  'What kind of notice this is (question_asked, invoice_drafts, task_comments...). Filled from entity_type, entity_id and title when the producer names none.';
COMMENT ON COLUMN pm.team_member_notifications.done_at IS
  'Finished with: hidden from Updates. Done implies read; marking it unread clears it; raising the notice again clears it.';

-- A member's open Updates, newest first.
CREATE INDEX IF NOT EXISTS idx_team_member_notifications_open
  ON pm.team_member_notifications (user_id, created_at DESC)
  WHERE cleared_at IS NULL AND done_at IS NULL;

-- The category of a notice from what it is about, for producers that name
-- none. A receipt is never read from free text alone: question_asked and
-- approval_requested need a pm.questions row of that kind behind the notice;
-- inbox_decision is never worked out here. Mirrored by
-- notificationCategoryOf in src/lib/notifications.ts.
CREATE OR REPLACE FUNCTION pm.notification_category(p_entity_type text, p_entity_id text, p_title text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pm
AS $$
DECLARE
  v_kind text;
BEGIN
  IF p_entity_type = 'question' AND p_entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT q.kind INTO v_kind FROM pm.questions q WHERE q.id = p_entity_id::uuid;
  END IF;
  RETURN CASE
    WHEN p_entity_type = 'question' AND p_title LIKE '%expired without %' THEN 'question_expired'
    WHEN p_entity_type = 'question' AND v_kind = 'approval' AND p_title LIKE 'Approval request from %' THEN 'approval_requested'
    WHEN p_entity_type = 'question' AND v_kind = 'question' AND p_title LIKE 'Question from %' THEN 'question_asked'
    WHEN p_entity_type = 'question' AND p_title LIKE 'Reply draft ready%' THEN 'reply_draft'
    WHEN p_entity_type = 'project' AND p_title LIKE '%findings are waiting on you' THEN 'findings_nudge'
    WHEN p_entity_type = 'project' AND p_title = 'Retainer draft failed' THEN 'retainer_failed'
    WHEN p_entity_type = 'project' AND p_title LIKE '% ready for review' THEN 'client_comm_review'
    WHEN p_entity_type = 'member' AND p_title LIKE '% stopped responding' THEN 'agent_offline'
    WHEN p_entity_type = 'member' AND p_title LIKE '% is back' THEN 'agent_back'
    WHEN p_entity_type = 'member' AND p_title LIKE '% spent its budget' THEN 'agent_budget'
    WHEN p_entity_type = 'member' AND p_title LIKE '%assistant is %' THEN 'assistant_alert'
    WHEN p_entity_type = 'invoice' THEN 'invoice_drafts'
    WHEN p_entity_type = 'reminder' THEN 'reminder'
    WHEN p_entity_type = 'schedule' THEN 'schedule_paused'
    WHEN p_entity_type = 'webhook' THEN 'webhook_failing'
    WHEN p_entity_type IS NULL THEN 'general'
    ELSE p_entity_type
  END;
END;
$$;

REVOKE ALL ON FUNCTION pm.notification_category(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_category(text, text, text) TO service_role;

-- Notices that announce a Needs you item: delivery receipts. Mirrored by
-- RECEIPT_CATEGORIES in src/lib/notifications.ts. Members execute it: the
-- unread dedup index is on it, so marking their own notification read
-- evaluates it as them.
CREATE OR REPLACE FUNCTION pm.notification_is_receipt(p_category text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pm
AS $$
  SELECT coalesce(p_category IN ('question_asked', 'approval_requested', 'findings_nudge', 'inbox_decision'), false)
$$;

REVOKE ALL ON FUNCTION pm.notification_is_receipt(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_is_receipt(text) TO authenticated, service_role;

-- Fills category, project_id and actor_id on insert, and keeps done and
-- read consistent: done marks it read, unread clears done.
CREATE OR REPLACE FUNCTION pm.notification_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_entity uuid;
BEGIN
  IF NEW.category IS NULL THEN
    NEW.category := pm.notification_category(NEW.entity_type, NEW.entity_id, NEW.title);
  END IF;
  IF TG_OP = 'INSERT' AND NEW.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_entity := NEW.entity_id::uuid;
    IF NEW.project_id IS NULL THEN
      NEW.project_id := CASE NEW.entity_type
        WHEN 'project' THEN (SELECT p.id FROM pm.projects p WHERE p.id = v_entity)
        WHEN 'task' THEN (SELECT t.project_id FROM pm.tasks t WHERE t.id = v_entity)
        WHEN 'invoice' THEN (SELECT i.project_id FROM pm.project_invoices i WHERE i.id = v_entity)
        WHEN 'reminder' THEN (SELECT r.project_id FROM pm.reminders r WHERE r.id = v_entity)
        WHEN 'suggestion' THEN (SELECT s.project_id FROM pm.task_suggestions s WHERE s.id = v_entity)
        WHEN 'question' THEN (SELECT q.project_id FROM pm.questions q WHERE q.id = v_entity)
        WHEN 'schedule' THEN (SELECT s.project_id FROM pm.schedules s WHERE s.id = v_entity)
      END;
    END IF;
    IF NEW.actor_id IS NULL AND NEW.entity_type = 'question' THEN
      NEW.actor_id := (SELECT q.asked_by FROM pm.questions q WHERE q.id = v_entity);
    END IF;
  END IF;
  IF NEW.done_at IS NOT NULL AND NOT NEW.is_read THEN
    IF TG_OP = 'UPDATE' AND OLD.done_at IS NOT DISTINCT FROM NEW.done_at THEN
      NEW.done_at := NULL;
    ELSE
      NEW.is_read := true;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.notification_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS notification_before_write ON pm.team_member_notifications;
CREATE TRIGGER notification_before_write
  BEFORE INSERT OR UPDATE ON pm.team_member_notifications
  FOR EACH ROW EXECUTE FUNCTION pm.notification_before_write();

-- Rows from before: their category from what they say. Only rows without one.
UPDATE pm.team_member_notifications
SET category = pm.notification_category(entity_type, entity_id, title)
WHERE category IS NULL;

-- One unread notice per person and thing, a receipt apart from an update:
-- a question asked about a task never takes the place of an unread update
-- about it.
DROP INDEX IF EXISTS pm.idx_team_member_notifications_dedup;
CREATE UNIQUE INDEX idx_team_member_notifications_dedup
  ON pm.team_member_notifications (user_id, entity_type, entity_id, pm.notification_is_receipt(category))
  WHERE is_read = false;

-- Raises a notice: refreshes the person's unread one about the same thing
-- (a receipt only a receipt, an update only an update), else brings back the latest one of its kind they marked done, else adds
-- one. A null category is worked out from the entity type and title.
CREATE OR REPLACE FUNCTION pm.upsert_notification(
  p_user_id uuid,
  p_title text,
  p_message text,
  p_link text,
  p_entity_type text,
  p_entity_id text,
  p_category text,
  p_project_id uuid DEFAULT NULL,
  p_actor_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_category text := coalesce(nullif(btrim(p_category), ''), pm.notification_category(p_entity_type, p_entity_id, p_title));
  v_done uuid;
BEGIN
  UPDATE pm.team_member_notifications
  SET title = p_title, message = p_message, link = p_link, created_at = now(), cleared_at = NULL, done_at = NULL,
      category = v_category, project_id = coalesce(p_project_id, project_id), actor_id = coalesce(p_actor_id, actor_id)
  WHERE user_id = p_user_id
    AND entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND is_read = false
    AND pm.notification_is_receipt(category) = pm.notification_is_receipt(v_category);
  IF FOUND THEN
    RETURN;
  END IF;

  SELECT id INTO v_done
  FROM pm.team_member_notifications
  WHERE user_id = p_user_id
    AND entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND category IS NOT DISTINCT FROM v_category
    AND done_at IS NOT NULL
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF v_done IS NOT NULL THEN
    UPDATE pm.team_member_notifications
    SET title = p_title, message = p_message, link = p_link, created_at = now(), cleared_at = NULL, done_at = NULL,
        is_read = false, project_id = coalesce(p_project_id, project_id), actor_id = coalesce(p_actor_id, actor_id)
    WHERE id = v_done;
    RETURN;
  END IF;

  INSERT INTO pm.team_member_notifications (user_id, title, message, link, entity_type, entity_id, category, project_id, actor_id)
  VALUES (p_user_id, p_title, p_message, p_link, p_entity_type, p_entity_id, v_category, p_project_id, p_actor_id);
END;
$$;

REVOKE ALL ON FUNCTION pm.upsert_notification(uuid, text, text, text, text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.upsert_notification(uuid, text, text, text, text, text, text, uuid, uuid) TO service_role;

-- The 6 argument form, as every producer before this release calls it.
CREATE OR REPLACE FUNCTION pm.upsert_notification(
  p_user_id uuid,
  p_title text,
  p_message text,
  p_link text,
  p_entity_type text,
  p_entity_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  PERFORM pm.upsert_notification(p_user_id, p_title, p_message, p_link, p_entity_type, p_entity_id, NULL::text, NULL::uuid, NULL::uuid);
END;
$$;

REVOKE ALL ON FUNCTION pm.upsert_notification(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.upsert_notification(uuid, text, text, text, text, text) TO service_role;

-- Snoozes: a member hides one item until a time.
CREATE TABLE IF NOT EXISTS pm.member_snoozes (
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('question', 'task', 'suggestion', 'notification')),
  item_id uuid NOT NULL,
  until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, item_kind, item_id)
);

COMMENT ON TABLE pm.member_snoozes IS
  'A member hides a question, task, suggestion or notification until a time. Applied when read; a passed until is ignored.';

ALTER TABLE pm.member_snoozes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_snoozes_own ON pm.member_snoozes;
CREATE POLICY member_snoozes_own ON pm.member_snoozes FOR ALL TO authenticated
  USING (member_id = pm.current_team_member_id())
  WITH CHECK (member_id = pm.current_team_member_id());

REVOKE ALL ON pm.member_snoozes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm.member_snoozes TO authenticated;
GRANT ALL ON pm.member_snoozes TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'member_snoozes') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.member_snoozes;
    END IF;
  END IF;
END;
$$;

-- A member's Updates: view updates (not done), unread, or done (newest
-- done first). Receipts, cleared and snoozed rows never show. Keyset paged
-- on (created_at, id), or (done_at, id) for done.
CREATE OR REPLACE FUNCTION pm.notification_feed(
  p_member_id uuid,
  p_view text DEFAULT 'updates',
  p_limit integer DEFAULT 30,
  p_before_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
) RETURNS SETOF pm.team_member_notifications
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT n.*
  FROM pm.team_member_notifications n
  WHERE n.user_id = p_member_id
    AND n.cleared_at IS NULL
    AND NOT pm.notification_is_receipt(n.category)
    AND CASE p_view
      WHEN 'done' THEN n.done_at IS NOT NULL
      WHEN 'unread' THEN n.done_at IS NULL AND NOT n.is_read
      ELSE n.done_at IS NULL
    END
    AND NOT EXISTS (
      SELECT 1 FROM pm.member_snoozes s
      WHERE s.member_id = p_member_id AND s.item_kind = 'notification' AND s.item_id = n.id AND s.until > now()
    )
    AND (
      p_before_at IS NULL
      OR (CASE WHEN p_view = 'done' THEN n.done_at ELSE n.created_at END, n.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    )
  ORDER BY CASE WHEN p_view = 'done' THEN n.done_at ELSE n.created_at END DESC, n.id DESC
  LIMIT least(greatest(coalesce(p_limit, 30), 1), 100)
$$;

REVOKE ALL ON FUNCTION pm.notification_feed(uuid, text, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_feed(uuid, text, integer, timestamptz, uuid) TO service_role;

-- The same Updates grouped by what they are about (entity type and id; a
-- notice about nothing is its own group): the latest row of each group, how
-- many it holds and how many are unread, newest group first, keyset paged
-- on the latest row's (created_at, id).
CREATE OR REPLACE FUNCTION pm.notification_groups(
  p_member_id uuid,
  p_limit integer DEFAULT 30,
  p_before_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  title text,
  message text,
  link text,
  is_read boolean,
  entity_type text,
  entity_id text,
  category text,
  project_id uuid,
  actor_id uuid,
  created_at timestamptz,
  group_key text,
  group_count integer,
  unread_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  WITH open_rows AS (
    SELECT n.*,
      CASE WHEN n.entity_type IS NOT NULL AND n.entity_id IS NOT NULL
        THEN n.entity_type || ':' || n.entity_id ELSE 'notification:' || n.id::text END AS gkey
    FROM pm.team_member_notifications n
    WHERE n.user_id = p_member_id
      AND n.cleared_at IS NULL
      AND n.done_at IS NULL
      AND NOT pm.notification_is_receipt(n.category)
      AND NOT EXISTS (
        SELECT 1 FROM pm.member_snoozes s
        WHERE s.member_id = p_member_id AND s.item_kind = 'notification' AND s.item_id = n.id AND s.until > now()
      )
  ), ranked AS (
    SELECT o.*,
      row_number() OVER (PARTITION BY o.gkey ORDER BY o.created_at DESC, o.id DESC) AS rn,
      count(*) OVER (PARTITION BY o.gkey) AS cnt,
      count(*) FILTER (WHERE NOT o.is_read) OVER (PARTITION BY o.gkey) AS unread
    FROM open_rows o
  )
  SELECT r.id, r.title, r.message, r.link, r.is_read, r.entity_type, r.entity_id, r.category, r.project_id, r.actor_id,
    r.created_at, r.gkey, r.cnt::integer, r.unread::integer
  FROM ranked r
  WHERE r.rn = 1
    AND (p_before_at IS NULL OR (r.created_at, r.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT least(greatest(coalesce(p_limit, 30), 1), 100)
$$;

REVOKE ALL ON FUNCTION pm.notification_groups(uuid, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_groups(uuid, integer, timestamptz, uuid) TO service_role;

-- How many of a member's Updates are unread: the Notifications count.
CREATE OR REPLACE FUNCTION pm.notification_unread_count(p_member_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT count(*)::integer
  FROM pm.team_member_notifications n
  WHERE n.user_id = p_member_id
    AND n.cleared_at IS NULL
    AND n.done_at IS NULL
    AND NOT n.is_read
    AND NOT pm.notification_is_receipt(n.category)
    AND NOT EXISTS (
      SELECT 1 FROM pm.member_snoozes s
      WHERE s.member_id = p_member_id AND s.item_kind = 'notification' AND s.item_id = n.id AND s.until > now()
    )
$$;

REVOKE ALL ON FUNCTION pm.notification_unread_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_unread_count(uuid) TO service_role;
