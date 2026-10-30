-- A question for you comes with choices. The agent sends one to three
-- questions, each with two to four choices and its pick, so a person answers
-- every decision on an email in one go instead of writing it all out.
-- question_for_human stays the one-line version for summaries and older
-- readers.
--
-- record_triage stores p_triage->'questions'. Safe to run more than once.

ALTER TABLE communications.triage ADD COLUMN IF NOT EXISTS questions jsonb;
ALTER TABLE communications.triage DROP CONSTRAINT IF EXISTS email_triage_questions_check;
ALTER TABLE communications.triage ADD CONSTRAINT email_triage_questions_check
  CHECK (questions IS NULL OR (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 3));

-- One triage, filed on any number of projects: the ones it names
-- (p_project_ids) and those of the tasks it links, each in the message's
-- scope (else EMAIL_PROJECT_OUT_OF_SCOPE, and nothing is written). With an
-- idempotency key already used on this email it changes nothing: the same
-- request hash returns the first triage (replayed), another one is refused.
CREATE OR REPLACE FUNCTION communications.record_triage(
  p_message_id uuid,
  p_member_id uuid,
  p_triage jsonb,
  p_links jsonb,
  p_project_ids uuid[],
  p_status text,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_triage communications.triage;
  v_projects uuid[];
  v_project uuid;
  v_link jsonb;
  v_task_project uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('handled', 'needs_human', 'ignored') THEN RAISE EXCEPTION 'record_triage: invalid status' USING ERRCODE = '22023'; END IF;
  -- A triage filters only what it read as outreach.
  IF p_status = 'ignored' AND p_triage->>'category' IS DISTINCT FROM 'outreach' THEN
    RAISE EXCEPTION 'record_triage: only outreach is filtered' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status = 'receiving' THEN
    RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002';
  END IF;

  -- The message row lock above serializes retries of one key.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_triage FROM communications.triage
    WHERE message_id = p_message_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_triage.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'EMAIL_IDEMPOTENCY_CONFLICT: this idempotency key was used for a different triage of message %', p_message_id USING ERRCODE = 'P0001';
      END IF;
      RETURN jsonb_build_object(
        'triage', to_jsonb(v_triage) - 'request_hash',
        'status', v_message.status,
        'thread', communications.conversation_projects_json(v_message.thread_id),
        'replayed', true
      );
    END IF;
  END IF;

  -- Every project it files on: the named ones, then each linked task's.
  v_projects := COALESCE(p_project_ids, '{}');
  FOR v_link IN SELECT value FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) LOOP
    SELECT project_id INTO v_task_project FROM public.tasks WHERE id = (v_link->>'task_id')::uuid AND deleted_at IS NULL;
    IF v_task_project IS NULL THEN
      RAISE EXCEPTION 'EMAIL_LINK_TASK_NOT_FOUND: task %', v_link->>'task_id' USING ERRCODE = 'P0001', DETAIL = v_link->>'task_id';
    END IF;
    IF NOT v_task_project = ANY(v_projects) THEN v_projects := v_projects || v_task_project; END IF;
  END LOOP;
  v_projects := ARRAY(SELECT DISTINCT x FROM unnest(v_projects) AS x ORDER BY x);

  PERFORM 1 FROM communications.conversations WHERE id = v_message.thread_id FOR UPDATE;
  FOREACH v_project IN ARRAY v_projects LOOP
    PERFORM communications.file_message_project(p_message_id, v_project, p_member_id);
  END LOOP;

  INSERT INTO communications.triage (
    message_id, member_id, outcome, urgent, summary, question_for_human, suggested_reply, project_id, project_ids,
    idempotency_key, request_hash, category, questions
  )
  VALUES (
    p_message_id, p_member_id, p_triage->>'outcome', COALESCE((p_triage->>'urgent')::boolean, false),
    p_triage->>'summary', p_triage->>'question_for_human', p_triage->>'suggested_reply',
    CASE WHEN cardinality(v_projects) = 1 THEN v_projects[1] END, v_projects,
    p_idempotency_key, p_request_hash, p_triage->>'category', NULLIF(p_triage->'questions', 'null'::jsonb)
  )
  RETURNING * INTO v_triage;

  INSERT INTO communications.task_links (message_id, task_id, relation, triage_id, linked_by)
  SELECT p_message_id, (l->>'task_id')::uuid, l->>'relation', v_triage.id, p_member_id
  FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) AS l
  ON CONFLICT (message_id, task_id, relation) DO NOTHING;

  UPDATE communications.messages SET status = p_status WHERE id = p_message_id;

  IF NULLIF(btrim(COALESCE(p_triage->>'thread_summary', '')), '') IS NOT NULL THEN
    UPDATE communications.conversations
    SET summary = left(btrim(p_triage->>'thread_summary'), 300), summary_at = now()
    WHERE id = v_message.thread_id;
  END IF;

  RETURN jsonb_build_object(
    'triage', to_jsonb(v_triage) - 'request_hash',
    'status', p_status,
    'thread', communications.conversation_projects_json(v_message.thread_id),
    'replayed', false
  );
END;
$$;
