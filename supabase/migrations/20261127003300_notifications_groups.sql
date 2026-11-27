-- Notifications grouped and filtered, and one count for a blocked comment.
--
-- - pm.blocked_comments_for(member): the blocked comments that wait on a
--   member (20261127002700's pm.my_blocked_comments, now for any member, on
--   the server); pm.my_blocked_comments reads it for the signed-in one.
-- - pm.notification_announces_block: a task's comment notice (or its
--   agent's message) while a blocked comment on that task waits on the
--   reader is a receipt of that Needs you item, as a question's notice is.
--   pm.notification_feed, pm.notification_groups,
--   pm.notification_unread_count and pm.notification_view_count are
--   redefined to leave it out, so the bell counts the block once; once the
--   block is answered the notice is an update again.
-- - pm.notification_update_groups: a member's open Updates grouped by what
--   they are about (a task, a project; a notice about nothing is its own
--   group), the latest row of each with its counts, keyset paged, narrowed
--   to notices from agents or to some projects. pm.notification_group_total
--   counts those groups; pm.notification_group_rows lists one group's rows,
--   newest first. pm.notification_group_key is the one way a row's group is
--   named; pm.notification_open_updates is the rows they all start from.
--   Server only.
--
-- Additive and safe to run twice: functions only, every one CREATE OR
-- REPLACE with the same arguments and results. The previous release's code
-- reads the same functions with the same answers, less the receipts.

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

-- The signed-in member's own: what Needs you lists.
CREATE OR REPLACE FUNCTION pm.my_blocked_comments()
RETURNS TABLE (
  comment_id uuid, task_id uuid, task_title text, project_id uuid,
  agent_id uuid, agent_name text, text text, created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT * FROM pm.blocked_comments_for(pm.current_team_member_id())
$$;

REVOKE ALL ON FUNCTION pm.my_blocked_comments() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.my_blocked_comments() TO authenticated, service_role;

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

-- How many Updates a member's view holds: the same rows pm.notification_feed
-- lists (receipts, cleared and snoozed left out), without paging.
CREATE OR REPLACE FUNCTION pm.notification_view_count(p_member_id uuid, p_view text DEFAULT 'updates')
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
    AND NOT pm.notification_is_receipt(n.category)
    AND NOT pm.notification_announces_block(n.user_id, n.entity_type, n.entity_id, n.category, n.actor_id)
    AND CASE p_view
      WHEN 'done' THEN n.done_at IS NOT NULL
      WHEN 'unread' THEN n.done_at IS NULL AND NOT n.is_read
      ELSE n.done_at IS NULL
    END
    AND NOT EXISTS (
      SELECT 1 FROM pm.member_snoozes s
      WHERE s.member_id = p_member_id AND s.item_kind = 'notification' AND s.item_id = n.id AND s.until > now()
    )
$$;

REVOKE ALL ON FUNCTION pm.notification_view_count(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_view_count(uuid, text) TO service_role;

-- The group a notice belongs to: what it is about ("task:<id>"), or itself
-- when it is about nothing.
CREATE OR REPLACE FUNCTION pm.notification_group_key(p_entity_type text, p_entity_id text, p_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pm
AS $$
  SELECT CASE WHEN p_entity_type IS NOT NULL AND p_entity_id IS NOT NULL
    THEN p_entity_type || ':' || p_entity_id ELSE 'notification:' || p_id::text END
$$;

REVOKE ALL ON FUNCTION pm.notification_group_key(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_group_key(text, text, uuid) TO service_role;

-- A member's open Updates (not done, receipts, cleared and snoozed left
-- out), narrowed to notices from agents and to some projects when asked.
CREATE OR REPLACE FUNCTION pm.notification_open_updates(
  p_member_id uuid,
  p_from_agents boolean DEFAULT false,
  p_project_ids uuid[] DEFAULT NULL
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
    AND n.done_at IS NULL
    AND NOT pm.notification_is_receipt(n.category)
    AND NOT pm.notification_announces_block(n.user_id, n.entity_type, n.entity_id, n.category, n.actor_id)
    AND NOT EXISTS (
      SELECT 1 FROM pm.member_snoozes s
      WHERE s.member_id = p_member_id AND s.item_kind = 'notification' AND s.item_id = n.id AND s.until > now()
    )
    AND (NOT coalesce(p_from_agents, false)
      OR EXISTS (SELECT 1 FROM pm.team_members a WHERE a.id = n.actor_id AND a.role = 'agent'))
    AND (p_project_ids IS NULL OR cardinality(p_project_ids) = 0 OR n.project_id = ANY (p_project_ids))
$$;

REVOKE ALL ON FUNCTION pm.notification_open_updates(uuid, boolean, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_open_updates(uuid, boolean, uuid[]) TO service_role;

-- Updates grouped: the latest row of each group with how many it holds and
-- how many are unread, newest group first, keyset paged on the latest
-- row's (created_at, id).
CREATE OR REPLACE FUNCTION pm.notification_update_groups(
  p_member_id uuid,
  p_limit integer DEFAULT 30,
  p_before_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_from_agents boolean DEFAULT false,
  p_project_ids uuid[] DEFAULT NULL
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
  WITH ranked AS (
    SELECT o.*,
      pm.notification_group_key(o.entity_type, o.entity_id, o.id) AS gkey,
      row_number() OVER (PARTITION BY pm.notification_group_key(o.entity_type, o.entity_id, o.id) ORDER BY o.created_at DESC, o.id DESC) AS rn,
      count(*) OVER (PARTITION BY pm.notification_group_key(o.entity_type, o.entity_id, o.id)) AS cnt,
      count(*) FILTER (WHERE NOT o.is_read) OVER (PARTITION BY pm.notification_group_key(o.entity_type, o.entity_id, o.id)) AS unread
    FROM pm.notification_open_updates(p_member_id, p_from_agents, p_project_ids) o
  )
  SELECT r.id, r.title, r.message, r.link, r.is_read, r.entity_type, r.entity_id, r.category, r.project_id, r.actor_id,
    r.created_at, r.gkey, r.cnt::integer, r.unread::integer
  FROM ranked r
  WHERE r.rn = 1
    AND (p_before_at IS NULL OR (r.created_at, r.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT least(greatest(coalesce(p_limit, 30), 1), 100)
$$;

REVOKE ALL ON FUNCTION pm.notification_update_groups(uuid, integer, timestamptz, uuid, boolean, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_update_groups(uuid, integer, timestamptz, uuid, boolean, uuid[]) TO service_role;

-- How many groups those Updates make, with the same filters.
CREATE OR REPLACE FUNCTION pm.notification_group_total(
  p_member_id uuid,
  p_from_agents boolean DEFAULT false,
  p_project_ids uuid[] DEFAULT NULL
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT count(DISTINCT pm.notification_group_key(o.entity_type, o.entity_id, o.id))::integer
  FROM pm.notification_open_updates(p_member_id, p_from_agents, p_project_ids) o
$$;

REVOKE ALL ON FUNCTION pm.notification_group_total(uuid, boolean, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_group_total(uuid, boolean, uuid[]) TO service_role;

-- One group's open Updates, newest first, keyset paged on (created_at, id).
CREATE OR REPLACE FUNCTION pm.notification_group_rows(
  p_member_id uuid,
  p_group_key text,
  p_limit integer DEFAULT 30,
  p_before_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
) RETURNS SETOF pm.team_member_notifications
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT o.*
  FROM pm.notification_open_updates(p_member_id, false, NULL) o
  WHERE pm.notification_group_key(o.entity_type, o.entity_id, o.id) = p_group_key
    AND (p_before_at IS NULL OR (o.created_at, o.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT least(greatest(coalesce(p_limit, 30), 1), 100)
$$;

REVOKE ALL ON FUNCTION pm.notification_group_rows(uuid, text, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_group_rows(uuid, text, integer, timestamptz, uuid) TO service_role;

-- The foundation's Updates feed, groups and unread count, as before, with a
-- notice announcing an open blocked comment left out (it is a receipt while
-- the block waits in Needs you).

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
    AND NOT pm.notification_announces_block(n.user_id, n.entity_type, n.entity_id, n.category, n.actor_id)
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
      AND NOT pm.notification_announces_block(n.user_id, n.entity_type, n.entity_id, n.category, n.actor_id)
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
    AND NOT pm.notification_announces_block(n.user_id, n.entity_type, n.entity_id, n.category, n.actor_id)
    AND NOT EXISTS (
      SELECT 1 FROM pm.member_snoozes s
      WHERE s.member_id = p_member_id AND s.item_kind = 'notification' AND s.item_id = n.id AND s.until > now()
    )
$$;

REVOKE ALL ON FUNCTION pm.notification_unread_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.notification_unread_count(uuid) TO service_role;
