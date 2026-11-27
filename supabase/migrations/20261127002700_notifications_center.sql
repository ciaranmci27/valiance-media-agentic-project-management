-- Notifications center: an agent's blocked comment is a Needs you item, and
-- Updates know how many they hold.
--
-- - pm.task_comments gains blocked (an agent says it is stuck on the task)
--   and blocked_task_status (the task's status when it said so). Only an
--   agent's comment is ever blocked: an agent sends blocked: true on the
--   comment, or starts it with "[BLOCKED]", the older convention. A person's
--   comment never is, whatever it says.
-- - pm.my_blocked_comments: the blocked comments that wait on the signed-in
--   member (the agents they manage, the tasks they are assigned to or made),
--   while the AI agents module is on. One stays until it is answered (a
--   later comment from a person, or the agent writes again) or the task
--   moves (its status changes, it is done or goes to Trash).
-- - pm.notification_view_count: how many Updates a member's view holds
--   (updates, unread or done), for "Show 24 more of 76". Server only.
--
-- Additive and safe to run twice. The previous release's code writes
-- comments as before (blocked fills itself from the "[BLOCKED]" prefix) and
-- never reads the new columns.

ALTER TABLE pm.task_comments
  ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_task_status text;

COMMENT ON COLUMN pm.task_comments.blocked IS
  'An agent says it is stuck on this task: a Needs you item for the task''s people and the agent''s managers until answered or the task moves. Only ever true on an agent''s comment.';
COMMENT ON COLUMN pm.task_comments.blocked_task_status IS
  'The task''s status when the agent said it was blocked; once the task moves on, the block is over.';

-- Blocked only from an agent: the prefix counts as the flag, a person's
-- comment is never blocked, and the task's status is kept with the block.
CREATE OR REPLACE FUNCTION pm.task_comment_blocked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.text ~* '^\s*\[blocked\]' THEN
    NEW.blocked := true;
  END IF;
  IF NEW.blocked AND NOT EXISTS (SELECT 1 FROM pm.team_members m WHERE m.id = NEW.user_id AND m.role = 'agent') THEN
    NEW.blocked := false;
  END IF;
  IF NOT NEW.blocked THEN
    NEW.blocked_task_status := NULL;
  ELSIF TG_OP = 'INSERT' OR NOT OLD.blocked THEN
    NEW.blocked_task_status := (SELECT t.status FROM pm.tasks t WHERE t.id = NEW.task_id);
  ELSE
    NEW.blocked_task_status := OLD.blocked_task_status;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.task_comment_blocked() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS task_comment_blocked ON pm.task_comments;
CREATE TRIGGER task_comment_blocked
  BEFORE INSERT OR UPDATE OF blocked, blocked_task_status ON pm.task_comments
  FOR EACH ROW EXECUTE FUNCTION pm.task_comment_blocked();

-- Agents' "[BLOCKED]" comments from before, on tasks still open: blocked, as
-- of the task's status now. Only rows not yet marked.
UPDATE pm.task_comments c
SET blocked = true
FROM pm.tasks t, pm.team_members m
WHERE c.blocked = false
  AND c.deleted_at IS NULL
  AND c.text ~* '^\s*\[blocked\]'
  AND t.id = c.task_id AND t.deleted_at IS NULL AND t.status <> 'done'
  AND m.id = c.user_id AND m.role = 'agent';

CREATE INDEX IF NOT EXISTS idx_task_comments_blocked
  ON pm.task_comments (created_at DESC)
  WHERE blocked AND deleted_at IS NULL;

-- Blocked comments that wait on the signed-in member, newest first, at most
-- 100. Same audience as pm.my_blocked_runs, plus whoever made the task.
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
  SELECT c.id, c.task_id, t.title, t.project_id, c.user_id, a.name, c.text, c.created_at
  FROM pm.task_comments c
  JOIN pm.tasks t ON t.id = c.task_id
  JOIN pm.team_members a ON a.id = c.user_id AND a.role = 'agent'
  WHERE c.blocked AND c.deleted_at IS NULL
    AND t.deleted_at IS NULL AND t.status <> 'done'
    AND t.status IS NOT DISTINCT FROM c.blocked_task_status
    AND pm.module_enabled('agents')
    AND pm.current_team_member_id() IS NOT NULL
    AND EXISTS (SELECT 1 FROM pm.projects p WHERE p.id = t.project_id AND p.deleted_at IS NULL)
    -- Answered (a person wrote after it) or the agent wrote again: over.
    AND NOT EXISTS (
      SELECT 1 FROM pm.task_comments l
      JOIN pm.team_members w ON w.id = l.user_id
      WHERE l.task_id = c.task_id AND l.deleted_at IS NULL
        AND (l.created_at, l.id) > (c.created_at, c.id)
        AND (w.role <> 'agent' OR l.user_id = c.user_id))
    AND (pm.member_manages_agent(c.user_id, pm.current_team_member_id())
      OR t.created_by = pm.current_team_member_id()
      OR EXISTS (SELECT 1 FROM pm.task_assignees ta WHERE ta.task_id = c.task_id AND ta.member_id = pm.current_team_member_id()))
  ORDER BY c.created_at DESC
  LIMIT 100
$$;

REVOKE ALL ON FUNCTION pm.my_blocked_comments() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.my_blocked_comments() TO authenticated, service_role;

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
