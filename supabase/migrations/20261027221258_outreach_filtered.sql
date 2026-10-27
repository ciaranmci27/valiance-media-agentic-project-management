-- Outreach goes to Filtered.
--
-- The agent says what it read an email as: work, fyi, or outreach (someone
-- selling to us). The app filters outreach unless something guards it (a
-- client, teammate or lead, a conversation we are in, money or security),
-- so cold pitches stop showing up as things that need a person.
--
-- 1. triage.category.
-- 2. record_triage keeps the category and may set the email to ignored
--    (Filtered), only when it was read as outreach.
-- 3. unsummarized_triage returns the category, so the daily summary can
--    leave filtered pitches out.
-- Safe to run more than once.

ALTER TABLE communications.triage ADD COLUMN IF NOT EXISTS category text;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_triage_category_check') THEN
    ALTER TABLE communications.triage ADD CONSTRAINT email_triage_category_check
      CHECK (category IS NULL OR category IN ('work', 'fyi', 'outreach'));
  END IF;
END
$do$;

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
    idempotency_key, request_hash, category
  )
  VALUES (
    p_message_id, p_member_id, p_triage->>'outcome', COALESCE((p_triage->>'urgent')::boolean, false),
    p_triage->>'summary', p_triage->>'question_for_human', p_triage->>'suggested_reply',
    CASE WHEN cardinality(v_projects) = 1 THEN v_projects[1] END, v_projects,
    p_idempotency_key, p_request_hash, p_triage->>'category'
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

CREATE OR REPLACE FUNCTION communications.unsummarized_triage(p_inbox_ids jsonb, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb))),
  latest AS (
    SELECT DISTINCT ON (t.message_id) t.*
    FROM communications.triage t
    JOIN communications.messages m ON m.id = t.message_id
    WHERE m.inbox_id IN (SELECT id FROM inboxes)
      AND EXISTS (SELECT 1 FROM communications.triage u WHERE u.message_id = t.message_id AND u.summarized_at IS NULL)
    ORDER BY t.message_id, t.created_at DESC, t.id DESC
  )
  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'created_at')), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'triage_id', l.id,
      'created_at', l.created_at,
      'outcome', l.outcome,
      'category', l.category,
      'urgent', l.urgent,
      'summary', l.summary,
      'question_for_human', l.question_for_human,
      'has_suggested_reply', l.suggested_reply IS NOT NULL,
      'project_id', l.project_id,
      'superseded_triage_ids', COALESCE((
        SELECT jsonb_agg(o.id) FROM communications.triage o
        WHERE o.message_id = l.message_id AND o.id <> l.id AND o.summarized_at IS NULL
      ), '[]'::jsonb),
      'message', jsonb_build_object(
        'id', m.id, 'inbox_id', m.inbox_id, 'thread_id', m.thread_id, 'status', m.status,
        'subject', m.subject, 'received_at', m.received_at,
        'kind', m.kind, 'topic', m.topic, 'sort_action', m.sort_action,
        'from', (SELECT jsonb_build_object('address', r.address, 'name', r.name)
                 FROM communications.participants r WHERE r.message_id = m.id AND r.kind = 'from'),
        'routing_basis', m.routing_basis,
        'forwarded_by', CASE WHEN m.routing_basis <> 'sender' AND m.forwarded_by_member_id IS NOT NULL THEN jsonb_build_object(
          'member_id', m.forwarded_by_member_id,
          'name', (SELECT tm.name FROM public.team_members tm WHERE tm.id = m.forwarded_by_member_id)) END,
        'original_sender', CASE WHEN m.routing_basis = 'forwarded_original' THEN jsonb_build_object(
          'address', m.original_from_address, 'name', COALESCE(m.original_from_name, '')) END
      ),
      'project', CASE WHEN th.project_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', th.project_id, 'name', p.name, 'source', th.project_source) END,
      'project_ids', to_jsonb(l.project_ids),
      'projects', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', cp.project_id, 'name', cpp.name, 'source', cp.source)
          ORDER BY communications.project_source_rank(cp.source), cp.created_at, cp.project_id)
        FROM communications.conversation_projects cp JOIN public.projects cpp ON cpp.id = cp.project_id
        WHERE cp.conversation_id = th.id
      ), '[]'::jsonb),
      'thread_summary', th.summary,
      'links', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('task_id', k.task_id, 'relation', k.relation, 'title', tk.title, 'status', tk.status,
          'project_id', tk.project_id, 'project_name', tkp.name) ORDER BY k.created_at)
        FROM communications.task_links k JOIN public.tasks tk ON tk.id = k.task_id
        JOIN public.projects tkp ON tkp.id = tk.project_id
        WHERE k.message_id = m.id AND tk.deleted_at IS NULL
      ), '[]'::jsonb),
      'reminders', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', rm.id, 'title', rm.title, 'remind_on', rm.remind_on, 'task_id', rm.task_id) ORDER BY rm.created_at)
        FROM public.reminders rm
        WHERE rm.source_message_id = m.id AND rm.deleted_at IS NULL AND rm.status = 'open'
      ), '[]'::jsonb)
    ) AS item
    FROM latest l
    JOIN communications.messages m ON m.id = l.message_id
    LEFT JOIN communications.conversations th ON th.id = m.thread_id
    LEFT JOIN public.projects p ON p.id = th.project_id
    ORDER BY l.created_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
  ) items);
END;
$$;
