-- Notifications delivery: email and the person's own chat, from one server
-- delivery point, as each person chose in Settings > Notifications.
--
-- - pm.team_members gains chat_notifications_enabled and
--   chat_notification_prefs: the chat switch and its choice per kind, beside
--   the email ones. "needs_you" is the kind for what waits on the person (a
--   question or approval asked, an agent's findings, an inbox decision): on
--   by default for email and chat once the person turns that channel on.
--   In the app every notice always shows.
-- - pm.notification_pref_key: the kind a notice is chosen by (its category,
--   or needs_you for a notice that announces a Needs you item; null for a
--   kind nobody chooses, which goes nowhere but the app). Mirrored by
--   deliveryKeyOf in src/lib/notification-defaults.ts.
-- - pm.notification_deliveries: the queue. A notice raised for a person
--   (inserted, or raised again unread) adds one pending row per channel they
--   asked for (never for invoice drafts by email: the morning summary sends
--   those). pm.claim_notification_deliveries leases due rows,
--   pm.complete_notification_delivery records the outcome (sent, skipped
--   with why, or failed after three tries, a minute apart and growing).
--   Server only.
-- - pm.notification_delivery_kick: pg_cron asks the app to deliver every
--   minute while something is due (POST /api/internal/notifications/deliver,
--   the scheduler secret in Vault, as webhook retries and schedules do).
-- - pm.notification_updates_list: the Updates list the API pages by offset
--   (view updates, unread or done, with its filters and total), with the
--   same rows the app lists: receipts, snoozed and a blocked comment's
--   notice left out. pm.blocked_comments_for and
--   pm.notification_announces_block are defined here as in
--   20261127003300_notifications_groups.sql (the same text), so this file
--   stands on its own.
--
-- Additive and safe to run twice. The previous release's code never reads
-- the new columns or table; it keeps emailing app notices as before until
-- the new code delivers them through the queue.

ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS chat_notifications_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chat_notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN pm.team_members.chat_notifications_enabled IS
  'Send notifications to the person''s own chat (a DM from a bot they linked an account on). Off until they turn it on.';
COMMENT ON COLUMN pm.team_members.chat_notification_prefs IS
  'Chat on or off per kind ({"task_comments": true}); needs_you is on unless set false. Only read while chat_notifications_enabled.';

-- The kind a notice is chosen by. Mirrors deliveryKeyOf.
CREATE OR REPLACE FUNCTION pm.notification_pref_key(p_category text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pm
AS $$
  SELECT CASE
    WHEN p_category IN ('question_asked', 'approval_requested', 'findings_nudge', 'inbox_decision') THEN 'needs_you'
    WHEN p_category IN (
      'task_created', 'task_deleted', 'task_status', 'task_assignments', 'task_updates', 'task_subtasks', 'task_comments',
      'project_created', 'project_deleted', 'project_updates', 'project_contacts', 'portal_settings', 'portal_updates',
      'time_entries', 'invoice_drafts', 'entity_files', 'contact_created', 'contact_deleted', 'contact_updates',
      'team_members', 'api_keys', 'lead_created', 'lead_deleted', 'lead_status', 'lead_updates', 'lead_interactions',
      'lead_proposals', 'lead_contacts', 'lead_conversions', 'agent_suggestions', 'agent_goals', 'agent_autonomous', 'agent_activity'
    ) THEN p_category
    ELSE NULL
  END
$$;

REVOKE ALL ON FUNCTION pm.notification_pref_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_pref_key(text) TO service_role;

CREATE TABLE IF NOT EXISTS pm.notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES pm.team_member_notifications(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'chat')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

COMMENT ON TABLE pm.notification_deliveries IS
  'Email and chat deliveries of notifications, one row per notice raised and channel; the app sends them (POST /api/internal/notifications/deliver).';

-- One open delivery per notice and channel: raising it again while one waits adds nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_open
  ON pm.notification_deliveries (notification_id, channel)
  WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
  ON pm.notification_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_member
  ON pm.notification_deliveries (member_id, created_at DESC);

ALTER TABLE pm.notification_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.notification_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.notification_deliveries TO service_role;

-- A notice raised for a person: one pending delivery per channel they asked for.
CREATE OR REPLACE FUNCTION pm.enqueue_notification_deliveries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_key text := pm.notification_pref_key(NEW.category);
  v_member record;
BEGIN
  IF v_key IS NULL OR NEW.is_read OR NEW.done_at IS NOT NULL OR NEW.cleared_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at THEN
    RETURN NULL;
  END IF;
  SELECT m.role, m.status, m.email_notifications_enabled, m.email_notification_prefs,
         m.chat_notifications_enabled, m.chat_notification_prefs
    INTO v_member
  FROM pm.team_members m WHERE m.id = NEW.user_id;
  IF NOT FOUND OR v_member.role = 'agent' OR coalesce(v_member.status, 'active') <> 'active' THEN
    RETURN NULL;
  END IF;
  -- Invoice drafts by email are the morning summary's (pm.billing_draft_notices).
  IF v_member.email_notifications_enabled AND v_key <> 'invoice_drafts'
     AND (v_member.email_notification_prefs -> v_key = 'true'::jsonb OR (jsonb_typeof(v_member.email_notification_prefs -> v_key) IS DISTINCT FROM 'boolean' AND v_key = 'needs_you')) THEN
    INSERT INTO pm.notification_deliveries (notification_id, member_id, channel)
    VALUES (NEW.id, NEW.user_id, 'email')
    ON CONFLICT (notification_id, channel) WHERE status IN ('pending', 'sending') DO NOTHING;
  END IF;
  IF v_member.chat_notifications_enabled
     AND (v_member.chat_notification_prefs -> v_key = 'true'::jsonb OR (jsonb_typeof(v_member.chat_notification_prefs -> v_key) IS DISTINCT FROM 'boolean' AND v_key = 'needs_you')) THEN
    INSERT INTO pm.notification_deliveries (notification_id, member_id, channel)
    VALUES (NEW.id, NEW.user_id, 'chat')
    ON CONFLICT (notification_id, channel) WHERE status IN ('pending', 'sending') DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.enqueue_notification_deliveries() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enqueue_notification_deliveries ON pm.team_member_notifications;
CREATE TRIGGER enqueue_notification_deliveries
  AFTER INSERT OR UPDATE OF created_at ON pm.team_member_notifications
  FOR EACH ROW EXECUTE FUNCTION pm.enqueue_notification_deliveries();

-- Leases due deliveries to one sender, oldest first: their notice and
-- person with them. A notice read, done or cleared meanwhile is skipped,
-- not sent. Answers what to send.
CREATE OR REPLACE FUNCTION pm.claim_notification_deliveries(p_limit integer DEFAULT 25, p_member_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  delivery_id uuid, channel text, attempts integer, member_id uuid, member_email text, member_name text,
  notification_id uuid, title text, message text, link text, category text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  -- Seen in the app before it went out: nothing to tell.
  UPDATE pm.notification_deliveries d
  SET status = 'skipped', last_error = 'Read in the app first', finished_at = now(), lease_expires_at = NULL
  FROM pm.team_member_notifications n
  WHERE d.notification_id = n.id AND d.status IN ('pending', 'sending')
    AND (n.is_read OR n.done_at IS NOT NULL OR n.cleared_at IS NOT NULL);

  RETURN QUERY
  WITH due AS (
    SELECT d.id
    FROM pm.notification_deliveries d
    WHERE ((d.status = 'pending' AND d.next_attempt_at <= now())
        OR (d.status = 'sending' AND coalesce(d.lease_expires_at, '-infinity') <= now()))
      AND (p_member_ids IS NULL OR d.member_id = ANY (p_member_ids))
    ORDER BY d.next_attempt_at, d.created_at
    LIMIT least(greatest(coalesce(p_limit, 25), 1), 100)
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE pm.notification_deliveries d
    SET status = 'sending', attempts = d.attempts + 1, lease_expires_at = now() + interval '2 minutes'
    FROM due WHERE d.id = due.id
    RETURNING d.id, d.channel, d.attempts, d.member_id, d.notification_id
  )
  SELECT l.id, l.channel, l.attempts, l.member_id, m.email, m.name, n.id, n.title, n.message, n.link, n.category
  FROM leased l
  JOIN pm.team_members m ON m.id = l.member_id
  JOIN pm.team_member_notifications n ON n.id = l.notification_id;
END;
$$;

REVOKE ALL ON FUNCTION pm.claim_notification_deliveries(integer, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.claim_notification_deliveries(integer, uuid[]) TO service_role;

-- Records how one went: sent, skipped (and why: no email set up, no linked
-- chat), or failed, tried again after 1, then 5 minutes, failed for good
-- after the third try.
CREATE OR REPLACE FUNCTION pm.complete_notification_delivery(p_delivery_id uuid, p_outcome text, p_error text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_attempts integer;
  v_status text;
BEGIN
  IF p_outcome NOT IN ('sent', 'skipped', 'failed') THEN
    RAISE EXCEPTION 'outcome must be sent, skipped or failed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT attempts INTO v_attempts FROM pm.notification_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_status := CASE WHEN p_outcome = 'failed' AND v_attempts < 3 THEN 'pending' ELSE p_outcome END;
  UPDATE pm.notification_deliveries
  SET status = v_status,
      last_error = CASE WHEN p_outcome = 'sent' THEN NULL ELSE left(p_error, 500) END,
      lease_expires_at = NULL,
      next_attempt_at = CASE WHEN v_status = 'pending' THEN now() + make_interval(mins => CASE WHEN v_attempts <= 1 THEN 1 ELSE 5 END) ELSE next_attempt_at END,
      finished_at = CASE WHEN v_status = 'pending' THEN NULL ELSE now() END
  WHERE id = p_delivery_id;
  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION pm.complete_notification_delivery(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.complete_notification_delivery(uuid, text, text) TO service_role;

-- pg_cron, every minute: asks the app to deliver while something is due.
-- Idle minutes make no request. Returns the pg_net request id, or null.
CREATE OR REPLACE FUNCTION pm.notification_delivery_kick()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  app_url text;
  secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.notification_deliveries d
    WHERE (d.status = 'pending' AND d.next_attempt_at <= now())
       OR (d.status = 'sending' AND coalesce(d.lease_expires_at, '-infinity') <= now())
  ) THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO app_url FROM vault.decrypted_secrets WHERE name = 'pm_webhook_scheduler_url';
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name = 'pm_webhook_scheduler_secret';
  IF app_url IS NULL OR secret IS NULL THEN
    RAISE NOTICE 'webhook_scheduler_url or webhook_scheduler_secret is missing from Vault; notification emails and chats wait for the app';
    RETURN NULL;
  END IF;

  RETURN net.http_post(
    url := rtrim(app_url, '/') || '/api/internal/notifications/deliver',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret),
    body := '{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;

REVOKE ALL ON FUNCTION pm.notification_delivery_kick() FROM PUBLIC, anon, authenticated, service_role;

-- Supabase only: skipped where pg_cron or pg_net is unavailable (PGlite).
-- Re-running cron.schedule updates the job in place.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS pg_net;
    PERFORM cron.schedule('pm-notification-deliveries', '* * * * *', $job$SELECT pm.notification_delivery_kick();$job$);
  ELSE
    RAISE NOTICE 'pg_cron or pg_net is unavailable here; notification deliveries will not be kicked';
  END IF;
END;
$do$;

-- Blocked comments that wait on a member, newest first, at most 100. Same
-- audience as pm.my_blocked_runs, plus whoever made the task. Server only:
-- members read their own through pm.my_blocked_comments.
CREATE OR REPLACE FUNCTION pm.blocked_comments_for(p_member_id uuid)
RETURNS TABLE (
  comment_id uuid, task_id uuid, task_title text, project_id uuid,
  agent_id uuid, agent_name text, text text, created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT c.id, c.task_id, t.title, t.project_id, c.user_id, a.name, c.text, c.created_at
  FROM pm.task_comments c
  JOIN pm.tasks t ON t.id = c.task_id
  JOIN pm.team_members a ON a.id = c.user_id AND a.role = 'agent'
  WHERE c.blocked AND c.deleted_at IS NULL
    AND t.deleted_at IS NULL AND t.status <> 'done'
    AND t.status IS NOT DISTINCT FROM c.blocked_task_status
    AND pm.module_enabled('agents')
    AND p_member_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM pm.projects p WHERE p.id = t.project_id AND p.deleted_at IS NULL)
    -- Answered (a person wrote after it) or the agent wrote again: over.
    AND NOT EXISTS (
      SELECT 1 FROM pm.task_comments l
      JOIN pm.team_members w ON w.id = l.user_id
      WHERE l.task_id = c.task_id AND l.deleted_at IS NULL
        AND (l.created_at, l.id) > (c.created_at, c.id)
        AND (w.role <> 'agent' OR l.user_id = c.user_id))
    AND (pm.member_manages_agent(c.user_id, p_member_id)
      OR t.created_by = p_member_id
      OR EXISTS (SELECT 1 FROM pm.task_assignees ta WHERE ta.task_id = c.task_id AND ta.member_id = p_member_id))
  ORDER BY c.created_at DESC
  LIMIT 100
$$;

REVOKE ALL ON FUNCTION pm.blocked_comments_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.blocked_comments_for(uuid) TO service_role;

-- A notice that announces a blocked comment waiting on its reader: the
-- comment notice (or the agent's own message) about that task, while the
-- block is open. Needs you lists the block, so the notice is a receipt for
-- as long: never shown in Updates, never counted. Once answered it is an
-- update like any other.
CREATE OR REPLACE FUNCTION pm.notification_announces_block(
  p_member_id uuid, p_entity_type text, p_entity_id text, p_category text, p_actor_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  -- Looks at the one task the notice is about (the partial index below), with
  -- the same rules as pm.blocked_comments_for, so a feed pays one indexed
  -- probe per comment notice, never a scan of every comment.
  SELECT CASE
    WHEN p_entity_type IS DISTINCT FROM 'task' OR p_category NOT IN ('task_comments', 'agent_message') THEN false
    WHEN p_member_id IS NULL OR p_entity_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN false
    WHEN NOT pm.module_enabled('agents') THEN false
    ELSE EXISTS (
      SELECT 1
      FROM pm.task_comments c
      JOIN pm.tasks t ON t.id = c.task_id
      JOIN pm.team_members a ON a.id = c.user_id AND a.role = 'agent'
      WHERE c.task_id = p_entity_id::uuid
        AND c.blocked AND c.deleted_at IS NULL
        AND (p_actor_id IS NULL OR p_actor_id = c.user_id)
        AND t.deleted_at IS NULL AND t.status <> 'done'
        AND t.status IS NOT DISTINCT FROM c.blocked_task_status
        AND EXISTS (SELECT 1 FROM pm.projects p WHERE p.id = t.project_id AND p.deleted_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM pm.task_comments l
          JOIN pm.team_members w ON w.id = l.user_id
          WHERE l.task_id = c.task_id AND l.deleted_at IS NULL
            AND (l.created_at, l.id) > (c.created_at, c.id)
            AND (w.role <> 'agent' OR l.user_id = c.user_id))
        AND (pm.member_manages_agent(c.user_id, p_member_id)
          OR t.created_by = p_member_id
          OR EXISTS (SELECT 1 FROM pm.task_assignees ta WHERE ta.task_id = c.task_id AND ta.member_id = p_member_id)))
  END
$$;

-- Open blocked comments by task: what the receipt check and Needs you read.
CREATE INDEX IF NOT EXISTS idx_task_comments_blocked_open ON pm.task_comments (task_id) WHERE blocked AND deleted_at IS NULL;

REVOKE ALL ON FUNCTION pm.notification_announces_block(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_announces_block(uuid, text, text, text, uuid) TO service_role;

-- The Updates list the API pages by offset: the rows the app lists for a
-- view (updates, unread or done), narrowed by category, entity type or
-- read, newest first, with how many match in all (total, on every row).
CREATE OR REPLACE FUNCTION pm.notification_updates_list(
  p_member_id uuid,
  p_view text,
  p_category text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_is_read boolean DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
) RETURNS TABLE (item jsonb, total integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  WITH listed AS (
    SELECT n.*
    FROM pm.team_member_notifications n
    WHERE n.user_id = p_member_id
      AND n.cleared_at IS NULL
      AND NOT pm.notification_is_receipt(n.category)
      AND NOT pm.notification_announces_block(n.user_id, n.entity_type, n.entity_id, n.category, n.actor_id)
      AND CASE p_view
        WHEN 'done' THEN n.done_at IS NOT NULL
        WHEN 'unread' THEN n.done_at IS NULL AND NOT n.is_read
        ELSE n.done_at IS NULL
      END
      AND (p_category IS NULL OR n.category = p_category)
      AND (p_entity_type IS NULL OR n.entity_type = p_entity_type)
      AND (p_is_read IS NULL OR n.is_read = p_is_read)
      AND NOT EXISTS (
        SELECT 1 FROM pm.member_snoozes s
        WHERE s.member_id = p_member_id AND s.item_kind = 'notification' AND s.item_id = n.id AND s.until > now()
      )
  )
  SELECT to_jsonb(l), (count(*) OVER ())::integer
  FROM listed l
  ORDER BY CASE WHEN p_view = 'done' THEN l.done_at ELSE l.created_at END DESC, l.id DESC
  LIMIT least(greatest(coalesce(p_limit, 25), 1), 100)
  OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

REVOKE ALL ON FUNCTION pm.notification_updates_list(uuid, text, text, text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_updates_list(uuid, text, text, text, boolean, integer, integer) TO service_role;
