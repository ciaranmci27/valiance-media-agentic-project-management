-- Atomic task save (audit batch 2).
--
-- A task and its assignees, acceptance criteria and blockers used to be saved
-- as separate requests with no rollback: a failure after the task row landed
-- left a task without its assignees (and a retry made a duplicate), and a
-- failed re-insert after a delete wiped a task's assignees or blockers.
-- save_task does the whole write in one transaction.
--
-- SECURITY INVOKER: browser sessions keep every RLS policy on every table it
-- touches; the v1 API's service role bypasses RLS as it already did.
--
-- p_task holds task columns only (a patch: absent keys stay as they are).
-- A NULL list means "leave it unchanged"; an empty list clears it. Replacing
-- criteria resets their satisfied flags, as the full replace always has.
--
-- Apply BEFORE deploying the app build that calls it: that build saves every
-- task through this function. It is additive, so the running app is unaffected.

CREATE OR REPLACE FUNCTION public.save_task(
  p_task_id uuid,
  p_task jsonb,
  p_assignee_ids uuid[] DEFAULT NULL,
  p_criteria text[] DEFAULT NULL,
  p_blocked_by uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_task_id uuid := p_task_id;
  v_payload jsonb := COALESCE(p_task, '{}'::jsonb);
  v_unknown text;
  v_cols text[];
  v_rows integer;
  v_task public.tasks;
BEGIN
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'save_task: p_task must be a JSON object' USING ERRCODE = '22023';
  END IF;

  -- Same contract as a PostgREST update: an unknown column is an error, not
  -- a silently dropped field.
  SELECT key INTO v_unknown
  FROM jsonb_object_keys(v_payload) AS key
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.tasks'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname = key
  )
  LIMIT 1;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'save_task: unknown task column "%"', v_unknown USING ERRCODE = '42703';
  END IF;

  SELECT array_agg(key ORDER BY key) INTO v_cols
  FROM jsonb_object_keys(v_payload) AS key
  WHERE key NOT IN ('id', 'created_at');

  IF v_task_id IS NULL THEN
    IF v_cols IS NULL THEN
      RAISE EXCEPTION 'save_task: a new task needs its columns' USING ERRCODE = '22023';
    END IF;
    EXECUTE format(
      'INSERT INTO public.tasks (%s) SELECT %s FROM jsonb_populate_record(NULL::public.tasks, $1) r RETURNING id',
      (SELECT string_agg(format('%I', c), ', ') FROM unnest(v_cols) c),
      (SELECT string_agg(format('r.%I', c), ', ') FROM unnest(v_cols) c)
    ) INTO v_task_id USING v_payload;
  ELSIF v_cols IS NOT NULL THEN
    EXECUTE format(
      'UPDATE public.tasks t SET %s FROM jsonb_populate_record(NULL::public.tasks, $1) r WHERE t.id = $2',
      (SELECT string_agg(format('%I = r.%I', c, c), ', ') FROM unnest(v_cols) c)
    ) USING v_payload, v_task_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    -- RLS turns a denied update into zero rows; that is a failure, not a save.
    IF v_rows = 0 THEN
      RAISE EXCEPTION 'save_task: task % not found or not permitted', v_task_id USING ERRCODE = 'P0002';
    END IF;
  ELSE
    PERFORM 1 FROM public.tasks WHERE id = v_task_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'save_task: task % not found or not permitted', v_task_id USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF p_assignee_ids IS NOT NULL THEN
    DELETE FROM public.task_assignees WHERE task_id = v_task_id;
    INSERT INTO public.task_assignees (task_id, member_id)
    SELECT DISTINCT v_task_id, member_id FROM unnest(p_assignee_ids) AS member_id;
  END IF;

  IF p_criteria IS NOT NULL THEN
    DELETE FROM public.task_acceptance_criteria WHERE task_id = v_task_id;
    INSERT INTO public.task_acceptance_criteria (task_id, criterion, sort_order)
    SELECT v_task_id, c.criterion, (c.ordinality - 1)::int
    FROM unnest(p_criteria) WITH ORDINALITY AS c(criterion, ordinality);
  END IF;

  IF p_blocked_by IS NOT NULL THEN
    DELETE FROM public.task_dependencies WHERE task_id = v_task_id;
    INSERT INTO public.task_dependencies (task_id, blocked_by_task_id)
    SELECT DISTINCT v_task_id, blocked_by FROM unnest(p_blocked_by) AS blocked_by;
  END IF;

  SELECT * INTO v_task FROM public.tasks WHERE id = v_task_id;
  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'criteria', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.sort_order)
      FROM public.task_acceptance_criteria c
      WHERE c.task_id = v_task_id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_task(uuid, jsonb, uuid[], text[], uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_task(uuid, jsonb, uuid[], text[], uuid[]) TO authenticated, service_role;
