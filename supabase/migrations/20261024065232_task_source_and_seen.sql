-- Tasks: where each one came from, and who has seen it.
--
-- 1. Source. A trigger stamps every new task with how it was made, whatever
--    path made it (the browser, save_task, the v1 API, MCP):
--      app     a person signed in to the app, or the app's own routes acting
--              for them;
--      api     an API key (an agent such as Ashley, a script, a scheduled job);
--      mcp     an API key through the MCP server;
--      system  the server with no person or key behind it, or SQL run directly;
--      unknown every task from before this migration.
--    For api and mcp the key itself is kept (created_by_key_id), so a task
--    made by one of a person's own keys never reads as made by that person.
--    The server names the key in the x-actor-key-id request header, honoured
--    only for the service role, exactly like x-actor-member-id. created_note
--    is the caller's own short reason ("from Brennan's email"); it is shown
--    as theirs, never as fact. None of these change after the insert.
-- 2. Seen. task_views records when each member last opened a task. A task
--    another person or a key made is new to a member until they open it;
--    tasks from before this (unknown) never are.

-- ---------------------------------------------------------------------------
-- Source
-- ---------------------------------------------------------------------------
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS created_via text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS created_by_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_note text;

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_created_via_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_created_via_check
  CHECK (created_via IN ('app', 'api', 'mcp', 'system', 'unknown'));
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_created_note_length;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_created_note_length
  CHECK (created_note IS NULL OR length(created_note) BETWEEN 1 AND 200);

CREATE INDEX IF NOT EXISTS idx_tasks_created_by_key ON public.tasks (created_by_key_id) WHERE created_by_key_id IS NOT NULL;

-- How the current insert was made. Never trusts the row: a caller cannot
-- claim to be the app or another key by setting the columns itself.
CREATE OR REPLACE FUNCTION public.stamp_task_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_headers json;
  v_via text;
  v_key text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Where a task came from is history: it stays as it was stamped.
    NEW.created_via := OLD.created_via;
    NEW.created_by_key_id := OLD.created_by_key_id;
    NEW.created_note := OLD.created_note;
    RETURN NEW;
  END IF;

  NEW.created_by_key_id := NULL;
  NEW.created_note := nullif(left(btrim(coalesce(NEW.created_note, '')), 200), '');
  IF auth.uid() IS NOT NULL THEN
    NEW.created_via := 'app';
    NEW.created_note := NULL;
    RETURN NEW;
  END IF;
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    NEW.created_via := 'system';
    RETURN NEW;
  END IF;

  BEGIN
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN others THEN
    v_headers := NULL;
  END;
  v_via := v_headers ->> 'x-actor-via';
  v_key := v_headers ->> 'x-actor-key-id';
  NEW.created_via := CASE WHEN v_via IN ('app', 'api', 'mcp') THEN v_via ELSE 'system' END;
  IF NEW.created_via IN ('api', 'mcp')
     AND v_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.api_keys WHERE id = v_key::uuid) THEN
    NEW.created_by_key_id := v_key::uuid;
  END IF;
  IF NEW.created_via = 'app' THEN
    NEW.created_note := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stamp_task_source ON public.tasks;
CREATE TRIGGER stamp_task_source
  BEFORE INSERT OR UPDATE OF created_via, created_by_key_id, created_note ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.stamp_task_source();

REVOKE ALL ON FUNCTION public.stamp_task_source() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seen
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_views (
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_task_views_member ON public.task_views (member_id);

ALTER TABLE public.task_views ENABLE ROW LEVEL SECURITY;

-- Each member reads and writes only their own views, and only of tasks they can open.
DROP POLICY IF EXISTS task_views_select ON public.task_views;
CREATE POLICY task_views_select ON public.task_views FOR SELECT TO authenticated
  USING (member_id = public.current_team_member_id());
DROP POLICY IF EXISTS task_views_insert ON public.task_views;
CREATE POLICY task_views_insert ON public.task_views FOR INSERT TO authenticated
  WITH CHECK (member_id = public.current_team_member_id()
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id));
DROP POLICY IF EXISTS task_views_update ON public.task_views;
CREATE POLICY task_views_update ON public.task_views FOR UPDATE TO authenticated
  USING (member_id = public.current_team_member_id())
  WITH CHECK (member_id = public.current_team_member_id());

-- Opening a task marks it seen for the signed-in member (once, then the time moves).
CREATE OR REPLACE FUNCTION public.mark_task_seen(p_task_id uuid)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO public.task_views (task_id, member_id)
  VALUES (p_task_id, public.current_team_member_id())
  ON CONFLICT (task_id, member_id) DO UPDATE SET seen_at = now();
$$;

REVOKE ALL ON FUNCTION public.mark_task_seen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_task_seen(uuid) TO authenticated;
