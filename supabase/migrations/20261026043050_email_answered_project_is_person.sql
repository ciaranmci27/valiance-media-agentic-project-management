-- A project the agent sets on a thread after someone answered its question
-- there is that person's choice, so it is recorded as person, not guessed:
-- no "(guessed)" label, and the agent does not ask to confirm it again.

-- One triage: the triage row, its task links and the message status, and the
-- thread's project when the agent chose one for a thread without it. With an
-- idempotency key already used on this email it changes nothing: the same
-- request hash returns the first triage (replayed), another one is refused.
CREATE OR REPLACE FUNCTION public.email_record_triage(
  p_message_id uuid,
  p_member_id uuid,
  p_triage jsonb,
  p_links jsonb,
  p_project_id uuid,
  p_status text,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message public.email_messages;
  v_triage public.email_triage;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('handled', 'needs_human') THEN RAISE EXCEPTION 'email_record_triage: invalid status' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_message FROM public.email_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status = 'receiving' THEN
    RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002';
  END IF;

  -- The message row lock above serializes retries of one key.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_triage FROM public.email_triage
    WHERE message_id = p_message_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_triage.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'EMAIL_IDEMPOTENCY_CONFLICT: this idempotency key was used for a different triage of message %', p_message_id USING ERRCODE = 'P0001';
      END IF;
      RETURN jsonb_build_object(
        'triage', to_jsonb(v_triage) - 'request_hash',
        'status', v_message.status,
        'thread', (SELECT jsonb_build_object('id', t.id, 'project_id', t.project_id, 'project_source', t.project_source)
                   FROM public.email_threads t WHERE t.id = v_message.thread_id),
        'replayed', true
      );
    END IF;
  END IF;

  -- person: someone answered the agent's question on this thread, so the
  -- project is the one that answer named; inferred: chosen among the
  -- message's mapping candidates; guessed: the message had none, so nothing
  -- in it matched a project.
  IF p_project_id IS NOT NULL THEN
    UPDATE public.email_threads
    SET project_id = p_project_id,
        project_source = CASE
          WHEN EXISTS (
            SELECT 1 FROM public.email_question_answers a
            JOIN public.email_messages m ON m.id = a.message_id
            WHERE m.thread_id = v_message.thread_id
          ) THEN 'person'
          WHEN EXISTS (SELECT 1 FROM public.email_message_candidates c WHERE c.message_id = p_message_id) THEN 'inferred'
          ELSE 'guessed' END
    WHERE id = v_message.thread_id AND project_id IS NULL;
    IF NOT FOUND AND NOT EXISTS (
      SELECT 1 FROM public.email_threads WHERE id = v_message.thread_id AND project_id = p_project_id
    ) THEN
      RAISE EXCEPTION 'EMAIL_THREAD_PROJECT_SET: the thread already belongs to another project' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.email_triage (
    message_id, member_id, outcome, urgent, summary, question_for_human, suggested_reply, project_id, idempotency_key, request_hash
  )
  VALUES (
    p_message_id, p_member_id, p_triage->>'outcome', COALESCE((p_triage->>'urgent')::boolean, false),
    p_triage->>'summary', p_triage->>'question_for_human', p_triage->>'suggested_reply', p_project_id,
    p_idempotency_key, p_request_hash
  )
  RETURNING * INTO v_triage;

  INSERT INTO public.email_task_links (message_id, task_id, relation, triage_id, linked_by)
  SELECT p_message_id, (l->>'task_id')::uuid, l->>'relation', v_triage.id, p_member_id
  FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) AS l
  ON CONFLICT (message_id, task_id, relation) DO NOTHING;

  UPDATE public.email_messages SET status = p_status WHERE id = p_message_id;

  IF NULLIF(btrim(COALESCE(p_triage->>'thread_summary', '')), '') IS NOT NULL THEN
    UPDATE public.email_threads
    SET summary = left(btrim(p_triage->>'thread_summary'), 300), summary_at = now()
    WHERE id = v_message.thread_id;
  END IF;

  RETURN jsonb_build_object(
    'triage', to_jsonb(v_triage) - 'request_hash',
    'status', p_status,
    'thread', (SELECT jsonb_build_object('id', t.id, 'project_id', t.project_id, 'project_source', t.project_source)
               FROM public.email_threads t WHERE t.id = v_message.thread_id),
    'replayed', false
  );
END;
$$;
