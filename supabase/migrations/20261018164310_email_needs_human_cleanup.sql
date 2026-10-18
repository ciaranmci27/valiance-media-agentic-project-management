-- needs_ciaran becomes needs_human, step 2 of 2: the bridge comes out. Step 1
-- (20261018161658) kept question_for_ciaran and read the old names while the
-- app and Ashley switched over; both now send only the new names.
--
-- Apply AFTER the app deploy: the step-1 build still selects
-- question_for_ciaran until it is replaced.

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

  -- inferred: chosen among the message's mapping candidates; guessed: the
  -- message had none, so nothing in it matched a project.
  IF p_project_id IS NOT NULL THEN
    UPDATE public.email_threads
    SET project_id = p_project_id,
        project_source = CASE WHEN EXISTS (SELECT 1 FROM public.email_message_candidates c WHERE c.message_id = p_message_id)
          THEN 'inferred' ELSE 'guessed' END
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

  RETURN jsonb_build_object(
    'triage', to_jsonb(v_triage) - 'request_hash',
    'status', p_status,
    'thread', (SELECT jsonb_build_object('id', t.id, 'project_id', t.project_id, 'project_source', t.project_source)
               FROM public.email_threads t WHERE t.id = v_message.thread_id),
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.email_unsummarized_triage(p_inbox_ids jsonb, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb))),
  latest AS (
    SELECT DISTINCT ON (t.message_id) t.*
    FROM public.email_triage t
    JOIN public.email_messages m ON m.id = t.message_id
    WHERE m.inbox_id IN (SELECT id FROM inboxes)
      AND EXISTS (SELECT 1 FROM public.email_triage u WHERE u.message_id = t.message_id AND u.summarized_at IS NULL)
    ORDER BY t.message_id, t.created_at DESC, t.id DESC
  )
  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'created_at')), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'triage_id', l.id,
      'created_at', l.created_at,
      'outcome', l.outcome,
      'urgent', l.urgent,
      'summary', l.summary,
      'question_for_human', l.question_for_human,
      'has_suggested_reply', l.suggested_reply IS NOT NULL,
      'project_id', l.project_id,
      'superseded_triage_ids', COALESCE((
        SELECT jsonb_agg(o.id) FROM public.email_triage o
        WHERE o.message_id = l.message_id AND o.id <> l.id AND o.summarized_at IS NULL
      ), '[]'::jsonb),
      'message', jsonb_build_object(
        'id', m.id, 'inbox_id', m.inbox_id, 'thread_id', m.thread_id, 'status', m.status,
        'subject', m.subject, 'received_at', m.received_at,
        'from', (SELECT jsonb_build_object('address', r.address, 'name', r.name)
                 FROM public.email_message_recipients r WHERE r.message_id = m.id AND r.kind = 'from'),
        'routing_basis', m.routing_basis,
        'forwarded_by', CASE WHEN m.routing_basis <> 'sender' AND m.forwarded_by_member_id IS NOT NULL THEN jsonb_build_object(
          'member_id', m.forwarded_by_member_id,
          'name', (SELECT tm.name FROM public.team_members tm WHERE tm.id = m.forwarded_by_member_id)) END,
        'original_sender', CASE WHEN m.routing_basis = 'forwarded_original' THEN jsonb_build_object(
          'address', m.original_from_address, 'name', COALESCE(m.original_from_name, '')) END
      ),
      'project', CASE WHEN th.project_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', th.project_id, 'name', p.name, 'source', th.project_source) END,
      'links', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('task_id', k.task_id, 'relation', k.relation, 'title', tk.title, 'status', tk.status) ORDER BY k.created_at)
        FROM public.email_task_links k JOIN public.tasks tk ON tk.id = k.task_id
        WHERE k.message_id = m.id
      ), '[]'::jsonb)
    ) AS item
    FROM latest l
    JOIN public.email_messages m ON m.id = l.message_id
    LEFT JOIN public.email_threads th ON th.id = m.thread_id
    LEFT JOIN public.projects p ON p.id = th.project_id
    ORDER BY l.created_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
  ) items
$$;

-- Last, once nothing above refers to it.
ALTER TABLE public.email_triage DROP COLUMN IF EXISTS question_for_ciaran;
