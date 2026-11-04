-- Tightens what the batched email summary counts as news: a related task link
-- is not an outcome, and only the last 14 days of triage are read, since quiet
-- triage is never marked summarized and would otherwise pile up in this read.

CREATE OR REPLACE FUNCTION communications.triage_is_news(p_triage_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM communications.triage t
    JOIN communications.messages m ON m.id = t.message_id
    WHERE t.id = p_triage_id
      AND (
        m.status = 'needs_human'
        OR (t.outcome = 'needs_reply' AND m.reviewed_at IS NULL AND m.status NOT IN ('new', 'ignored'))
        OR t.outcome = 'task'
        OR EXISTS (SELECT 1 FROM communications.task_links k WHERE k.triage_id = t.id AND k.relation <> 'related')
        OR EXISTS (
          SELECT 1 FROM public.reminders rm
          WHERE rm.source_message_id = m.id AND rm.created_by = t.member_id
            AND rm.deleted_at IS NULL AND rm.status = 'open'
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION communications.signal(p_inbox_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb)))
  SELECT jsonb_build_object(
    'new_count', (SELECT count(*) FROM communications.messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'newest_received_at', (SELECT max(m.received_at) FROM communications.messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'unsummarized_count', (
      SELECT count(*) FROM (
        SELECT DISTINCT ON (t.message_id) t.id
        FROM communications.triage t
        JOIN communications.messages m ON m.id = t.message_id
        WHERE m.inbox_id IN (SELECT id FROM inboxes)
          AND EXISTS (SELECT 1 FROM communications.triage u WHERE u.message_id = t.message_id AND u.summarized_at IS NULL AND u.created_at > now() - interval '14 days')
        ORDER BY t.message_id, t.created_at DESC, t.id DESC
      ) latest
      WHERE communications.triage_is_news(latest.id)
    ),
    'waiting_count', (
      SELECT count(*) FROM communications.messages m
      WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'needs_human'
        AND (SELECT t.question_for_human FROM communications.triage t
             WHERE t.message_id = m.id ORDER BY t.created_at DESC, t.id DESC LIMIT 1) IS NOT NULL
    ),
    'drafts_requested', (
      SELECT count(*) FROM communications.reply_drafts d
      JOIN communications.messages m ON m.id = d.message_id
      WHERE m.inbox_id IN (SELECT id FROM inboxes) AND d.status = 'requested'
    )
  ));
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
      -- Quiet triage is never marked summarized, so the look-back keeps this read small.
      AND EXISTS (SELECT 1 FROM communications.triage u WHERE u.message_id = t.message_id AND u.summarized_at IS NULL AND u.created_at > now() - interval '14 days')
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
    WHERE communications.triage_is_news(l.id)
    ORDER BY l.created_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
  ) items);
END;
$$;
