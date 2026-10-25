-- Unread tasks: what changed on a task since each member last opened it.
--
-- task_events is an append-only record of the changes worth knowing about:
-- an edit, a status move, a comment, a linked email, a file, a subtask, an
-- assignment, a review. Triggers write it, whatever path made the change (the
-- browser, the app's routes, the v1 API, MCP, the email pipeline). It is kept
-- apart from tasks so recording a change never moves the task's updated_at,
-- the team activity log or a webhook.
--
-- Each event keeps who made it and how, resolved exactly like the task source
-- stamp: app for a signed-in person or the app's routes acting for them, api
-- or mcp for an API key, system otherwise. A member's own changes are the
-- ones made in the app as them; an agent or one of their own keys is someone
-- else, so its changes still show.
--
-- A task is updated for a member when it has an event after their last look
-- (task_views.seen_at; never opened means every event) that is not their own.
-- my_task_updates() answers that for every task the member can see, with
-- counts by kind; mark_tasks_seen() marks many at once (Mark all read).
-- Events start now: nothing before this migration reads as updated.

CREATE TABLE IF NOT EXISTS public.task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  -- The person or agent behind it, when known; null for a key with no
  -- member, the email pipeline, or SQL run directly.
  member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  via text NOT NULL CONSTRAINT task_events_via_check CHECK (via IN ('app', 'api', 'mcp', 'system')),
  kind text NOT NULL CONSTRAINT task_events_kind_check
    CHECK (kind IN ('edit', 'status', 'comment', 'email', 'file', 'subtask', 'assignee', 'review'))
);
CREATE INDEX IF NOT EXISTS idx_task_events_task_at ON public.task_events (task_id, at DESC);

ALTER TABLE public.task_events ENABLE ROW LEVEL SECURITY;

-- Readable with the task; only the triggers below write.
DROP POLICY IF EXISTS task_events_select ON public.task_events;
CREATE POLICY task_events_select ON public.task_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id));

REVOKE ALL ON public.task_events FROM anon, authenticated;
GRANT SELECT ON public.task_events TO authenticated;
GRANT ALL ON public.task_events TO service_role;

-- Records one change on a task. A task's own creation is not a change (its
-- assignees, subtasks and email saved with it included), nor is anything on a
-- task in Trash. One event per kind per actor per transaction: a save that
-- rewrites five criteria is one edit.
CREATE OR REPLACE FUNCTION public.record_task_event(p_task_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_headers json;
  v_member uuid;
  v_via text;
  v_header text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tasks
    WHERE id = p_task_id AND deleted_at IS NULL AND created_at < now()
  ) THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_member := public.current_team_member_id();
    v_via := 'app';
  ELSIF coalesce(auth.role(), '') = 'service_role' THEN
    BEGIN
      v_headers := nullif(current_setting('request.headers', true), '')::json;
    EXCEPTION WHEN others THEN
      v_headers := NULL;
    END;
    v_via := v_headers ->> 'x-actor-via';
    v_via := CASE WHEN v_via IN ('app', 'api', 'mcp') THEN v_via ELSE 'system' END;
    v_header := v_headers ->> 'x-actor-member-id';
    IF v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT id INTO v_member FROM public.team_members WHERE id = v_header::uuid;
    END IF;
    -- The app's routes always act for a person; without one it is the server.
    IF v_via = 'app' AND v_member IS NULL THEN
      v_via := 'system';
    END IF;
  ELSE
    v_via := 'system';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.task_events
    WHERE task_id = p_task_id AND at = now() AND kind = p_kind
      AND via = v_via AND member_id IS NOT DISTINCT FROM v_member
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.task_events (task_id, member_id, via, kind)
  VALUES (p_task_id, v_member, v_via, p_kind);
END;
$$;

-- The task's own fields. Reordering, the completion stamp, Trash and the
-- source stamp are not changes anyone needs to read.
CREATE OR REPLACE FUNCTION public.record_task_row_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.record_task_event(NEW.id, 'status');
  ELSIF cardinality(public.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD),
    ARRAY['sort_order', 'completed_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by',
          'created_via', 'created_by_key_id', 'created_note'])) > 0 THEN
    PERFORM public.record_task_event(NEW.id, 'edit');
  END IF;
  RETURN NULL;
END;
$$;

-- Everything kept beside the task. TG_ARGV[0] is the kind.
CREATE OR REPLACE FUNCTION public.record_task_child_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.record_task_event(OLD.task_id, TG_ARGV[0]);
  ELSE
    PERFORM public.record_task_event(NEW.task_id, TG_ARGV[0]);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS record_task_event ON public.tasks;
CREATE TRIGGER record_task_event AFTER UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.record_task_row_event();

DROP TRIGGER IF EXISTS record_task_event ON public.task_comments;
CREATE TRIGGER record_task_event AFTER INSERT ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('comment');

DROP TRIGGER IF EXISTS record_task_event ON public.email_task_links;
CREATE TRIGGER record_task_event AFTER INSERT ON public.email_task_links
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('email');

DROP TRIGGER IF EXISTS record_task_event ON public.task_files;
CREATE TRIGGER record_task_event AFTER INSERT ON public.task_files
  FOR EACH ROW WHEN (NEW.deleted_at IS NULL)
  EXECUTE FUNCTION public.record_task_child_event('file');

DROP TRIGGER IF EXISTS record_task_event ON public.task_subtasks;
CREATE TRIGGER record_task_event AFTER INSERT OR UPDATE OF title, completed ON public.task_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('subtask');

DROP TRIGGER IF EXISTS record_task_event ON public.task_assignees;
CREATE TRIGGER record_task_event AFTER INSERT OR DELETE ON public.task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('assignee');

DROP TRIGGER IF EXISTS record_task_event ON public.task_dependencies;
CREATE TRIGGER record_task_event AFTER INSERT OR DELETE ON public.task_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('edit');

DROP TRIGGER IF EXISTS record_task_event ON public.task_acceptance_criteria;
CREATE TRIGGER record_task_event AFTER INSERT OR DELETE OR UPDATE OF criterion, satisfied ON public.task_acceptance_criteria
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('edit');

DROP TRIGGER IF EXISTS record_task_event ON public.task_reviews;
CREATE TRIGGER record_task_event AFTER INSERT ON public.task_reviews
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('review');

REVOKE ALL ON FUNCTION public.record_task_event(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_task_row_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_task_child_event() FROM PUBLIC, anon, authenticated;

-- Every live task the signed-in member can see with changes they have not
-- seen: when they last looked (null if never), how many changes of each
-- kind, and the latest one.
CREATE OR REPLACE FUNCTION public.my_task_updates()
RETURNS TABLE (
  task_id uuid,
  seen_at timestamptz,
  total integer,
  kinds jsonb,
  last_at timestamptz,
  last_member_id uuid,
  last_via text,
  last_kind text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.current_team_member_id() AS id
  ), unseen AS (
    SELECT e.id, e.task_id, e.at, e.member_id, e.via, e.kind, v.seen_at
    FROM public.task_events e
    JOIN public.tasks t ON t.id = e.task_id AND t.deleted_at IS NULL
    CROSS JOIN me
    LEFT JOIN public.task_views v ON v.task_id = e.task_id AND v.member_id = me.id
    WHERE me.id IS NOT NULL
      AND e.at > coalesce(v.seen_at, '-infinity'::timestamptz)
      AND NOT (e.via = 'app' AND e.member_id IS NOT DISTINCT FROM me.id)
  ), per_kind AS (
    SELECT u.task_id, jsonb_object_agg(u.kind, u.n) AS kinds, sum(u.n)::integer AS total
    FROM (SELECT task_id, kind, count(*) AS n FROM unseen GROUP BY task_id, kind) u
    GROUP BY u.task_id
  ), latest AS (
    SELECT DISTINCT ON (task_id) task_id, seen_at, at, member_id, via, kind
    FROM unseen
    ORDER BY task_id, at DESC, id DESC
  )
  SELECT l.task_id, l.seen_at, p.total, p.kinds, l.at, l.member_id, l.via, l.kind
  FROM latest l
  JOIN per_kind p ON p.task_id = l.task_id
$$;

REVOKE ALL ON FUNCTION public.my_task_updates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_task_updates() TO authenticated;

-- Mark all read: many tasks seen at once. Tasks the member cannot see are
-- skipped, never an error.
CREATE OR REPLACE FUNCTION public.mark_tasks_seen(p_task_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF cardinality(p_task_ids) > 1000 THEN
    RAISE EXCEPTION 'Mark at most 1000 tasks at once' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.task_views (task_id, member_id)
  SELECT t.id, public.current_team_member_id()
  FROM public.tasks t
  WHERE t.id = ANY (coalesce(p_task_ids, ARRAY[]::uuid[]))
  ON CONFLICT (task_id, member_id) DO UPDATE SET seen_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_tasks_seen(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_tasks_seen(uuid[]) TO authenticated;

-- Live: a change shows on the cards as it happens, and a look on one device
-- clears it on the others.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['task_events', 'task_views'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;
