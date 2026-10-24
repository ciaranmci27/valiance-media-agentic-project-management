-- Inbox: sorting, sender rules, relations, thread summaries and reply drafts.
--
-- 1. Every email is sorted as it arrives: a kind (person, team, meeting
--    notes, notification, marketing), a topic for machine mail (money,
--    account risk, security, usage, event, newsletter, promotion, update),
--    and what sorting did with it (sort_action): ignore (Filtered, never
--    triaged), fyi (triaged lightly, never "needs you"), always (full
--    triage), triage (the default). A newer alert from the same sender on
--    the same topic supersedes the older one (superseded_by).
-- 2. Sender rules: an address or domain, optionally one topic, and an
--    action. People and the agent (from patterns) create them; they are
--    switched off, never deleted.
-- 3. Relations: a task link can be 'related' (about the task, asks for no
--    change), and people can link tasks too (linked_by, no triage). A
--    reminder remembers the email it came from (source_message_id).
-- 4. A thread carries a one-line summary of where it stands.
-- 5. Reply drafts: a person asks for one, the agent writes it, the person
--    copies it. Nothing is ever sent.

-- ============================================================
-- 1. Sorting columns
-- ============================================================
CREATE TABLE IF NOT EXISTS public.email_sender_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_kind text NOT NULL CHECK (match_kind IN ('address', 'domain')),
  match_value text NOT NULL CHECK (match_value = lower(btrim(match_value)) AND length(match_value) BETWEEN 3 AND 320),
  -- NULL: every topic from this sender.
  topic text CHECK (topic IN ('money', 'account_risk', 'security', 'usage', 'event', 'newsletter', 'promotion', 'update')),
  action text NOT NULL CHECK (action IN ('ignore', 'fyi', 'always')),
  source text NOT NULL CHECK (source IN ('person', 'agent')),
  -- Why the rule exists, in a sentence (the agent always gives one).
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  hit_count integer NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  last_hit_at timestamptz,
  -- Rules are switched off, never deleted, so a filtered email can still
  -- say which rule filtered it.
  disabled_at timestamptz,
  disabled_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_sender_rules_live_key
  ON public.email_sender_rules (match_kind, match_value, COALESCE(topic, '')) WHERE disabled_at IS NULL;

DROP TRIGGER IF EXISTS set_email_sender_rules_updated_at ON public.email_sender_rules;
CREATE TRIGGER set_email_sender_rules_updated_at
  BEFORE UPDATE ON public.email_sender_rules
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS kind text
    CONSTRAINT email_messages_kind_check CHECK (kind IN ('person', 'team', 'meeting_notes', 'notification', 'marketing')),
  ADD COLUMN IF NOT EXISTS topic text
    CONSTRAINT email_messages_topic_check CHECK (topic IN ('money', 'account_risk', 'security', 'usage', 'event', 'newsletter', 'promotion', 'update')),
  ADD COLUMN IF NOT EXISTS sort_action text
    CONSTRAINT email_messages_sort_action_check CHECK (sort_action IN ('ignore', 'fyi', 'always', 'triage')),
  ADD COLUMN IF NOT EXISTS sort_reason text
    CONSTRAINT email_messages_sort_reason_check CHECK (sort_reason IS NULL OR length(sort_reason) <= 300),
  ADD COLUMN IF NOT EXISTS sender_rule_id uuid REFERENCES public.email_sender_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES public.email_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_messages_sender_rule ON public.email_messages (sender_rule_id) WHERE sender_rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_messages_superseded_by ON public.email_messages (superseded_by) WHERE superseded_by IS NOT NULL;

-- ============================================================
-- 2. Relations
-- ============================================================
ALTER TABLE public.email_task_links DROP CONSTRAINT IF EXISTS email_task_links_relation_check;
ALTER TABLE public.email_task_links ADD CONSTRAINT email_task_links_relation_check
  CHECK (relation IN ('created', 'updated', 'related'));

ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS source_message_id uuid REFERENCES public.email_messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_source_message ON public.reminders (source_message_id) WHERE source_message_id IS NOT NULL;

-- ============================================================
-- 3. Thread summary
-- ============================================================
ALTER TABLE public.email_threads
  ADD COLUMN IF NOT EXISTS summary text CONSTRAINT email_threads_summary_check CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 300),
  ADD COLUMN IF NOT EXISTS summary_at timestamptz;

-- ============================================================
-- 4. Reply drafts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.email_reply_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.email_threads(id) ON DELETE CASCADE,
  -- The email the reply answers (the newest when it was asked for).
  message_id uuid NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 2000),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'ready', 'failed')),
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 20000),
  drafted_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  failure text CHECK (failure IS NULL OR length(failure) <= 500),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_reply_drafts_ready_has_body CHECK ((status = 'ready') = (body IS NOT NULL)),
  CONSTRAINT email_reply_drafts_done_has_time CHECK ((status = 'requested') = (completed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_email_reply_drafts_thread ON public.email_reply_drafts (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_reply_drafts_requested ON public.email_reply_drafts (created_at) WHERE status = 'requested';

DROP TRIGGER IF EXISTS set_email_reply_drafts_updated_at ON public.email_reply_drafts;
CREATE TRIGGER set_email_reply_drafts_updated_at
  BEFORE UPDATE ON public.email_reply_drafts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================
-- 5. Row level security (writes go through the service role)
-- ============================================================
ALTER TABLE public.email_sender_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_reply_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_sender_rules_select ON public.email_sender_rules;
CREATE POLICY email_sender_rules_select ON public.email_sender_rules FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.read') OR public.has_permission('inbound_email.manage'));
DROP POLICY IF EXISTS email_reply_drafts_select ON public.email_reply_drafts;
CREATE POLICY email_reply_drafts_select ON public.email_reply_drafts FOR SELECT TO authenticated
  USING (public.can_read_email_message(message_id));

-- ============================================================
-- 6. Server-side writes
-- ============================================================
-- Completion also records how the message was sorted and counts the rule
-- that decided it.
CREATE OR REPLACE FUNCTION public.email_complete_message(p_message_id uuid, p_decision jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message public.email_messages;
  v_thread uuid;
  v_status text := p_decision->>'status';
  v_source text := COALESCE(p_decision->>'project_source', 'mapped');
  v_basis text := COALESCE(p_decision->>'routing_basis', 'sender');
  v_rule uuid := (p_decision->>'sender_rule_id')::uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF v_status NOT IN ('new', 'ignored') THEN RAISE EXCEPTION 'email_complete_message: status must be new or ignored' USING ERRCODE = '22023'; END IF;
  IF v_source NOT IN ('mapped', 'address') THEN RAISE EXCEPTION 'email_complete_message: project_source must be mapped or address' USING ERRCODE = '22023'; END IF;
  IF v_basis NOT IN ('sender', 'forwarded_original', 'team_recipients') THEN
    RAISE EXCEPTION 'email_complete_message: routing_basis must be sender, forwarded_original or team_recipients' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_message FROM public.email_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002'; END IF;
  IF v_message.status <> 'receiving' THEN
    RETURN jsonb_build_object('already_complete', true, 'status', v_message.status, 'thread_id', v_message.thread_id);
  END IF;
  IF (v_message.raw_storage_path IS NOT NULL AND v_message.raw_uploaded_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.email_attachments WHERE message_id = p_message_id AND storage_path IS NOT NULL AND uploaded_at IS NULL) THEN
    RAISE EXCEPTION 'EMAIL_FILES_PENDING: message % still has files to store', p_message_id USING ERRCODE = 'P0001';
  END IF;

  IF p_decision->>'thread_id' IS NOT NULL THEN
    SELECT id INTO v_thread FROM public.email_threads
    WHERE id = (p_decision->>'thread_id')::uuid AND inbox_id = v_message.inbox_id
    FOR UPDATE;
    IF v_thread IS NULL THEN RAISE EXCEPTION 'email_complete_message: thread is not in this inbox' USING ERRCODE = '22023'; END IF;
    UPDATE public.email_threads SET last_message_at = GREATEST(last_message_at, v_message.received_at) WHERE id = v_thread;
  ELSE
    INSERT INTO public.email_threads (inbox_id, subject_normalized, last_message_at)
    VALUES (v_message.inbox_id, v_message.subject_normalized, v_message.received_at)
    RETURNING id INTO v_thread;
  END IF;

  -- A thread keeps its project once set. An address deleted since it was
  -- matched still files the project, without the address.
  IF p_decision->>'project_id' IS NOT NULL THEN
    UPDATE public.email_threads
    SET project_id = (p_decision->>'project_id')::uuid,
        project_source = v_source,
        project_address_id = CASE WHEN v_source = 'address' THEN (
          SELECT a.id FROM public.email_project_addresses a WHERE a.id = (p_decision->>'project_address_id')::uuid
        ) END
    WHERE id = v_thread AND project_id IS NULL;
  END IF;

  INSERT INTO public.email_message_candidates (message_id, project_id, reason)
  SELECT p_message_id, (c->>'project_id')::uuid, c->>'reason'
  FROM jsonb_array_elements(COALESCE(p_decision->'candidates', '[]'::jsonb)) AS c
  ON CONFLICT DO NOTHING;

  UPDATE public.email_message_recipients r
  SET contact_id = (x->>'contact_id')::uuid
  FROM jsonb_array_elements(COALESCE(p_decision->'recipient_contacts', '[]'::jsonb)) AS x
  WHERE r.message_id = p_message_id AND r.address = x->>'address';

  -- A rule switched off since ingestion read it is still the rule that sorted it.
  IF v_rule IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.email_sender_rules WHERE id = v_rule) THEN
    v_rule := NULL;
  END IF;

  -- A teammate deleted since ingestion read them leaves no forwarder.
  UPDATE public.email_messages
  SET thread_id = v_thread,
      status = v_status,
      completed_at = now(),
      routing_basis = v_basis,
      forwarded_by_member_id = CASE WHEN v_basis <> 'sender' THEN (
        SELECT tm.id FROM public.team_members tm WHERE tm.id = (p_decision->>'forwarded_by_member_id')::uuid
      ) END,
      original_from_address = CASE WHEN v_basis = 'forwarded_original' THEN lower(btrim(p_decision->>'original_from_address')) END,
      original_from_name = CASE WHEN v_basis = 'forwarded_original'
        THEN NULLIF(left(btrim(COALESCE(p_decision->>'original_from_name', '')), 300), '') END,
      kind = p_decision->>'kind',
      topic = p_decision->>'topic',
      sort_action = p_decision->>'sort_action',
      sort_reason = NULLIF(left(btrim(COALESCE(p_decision->>'sort_reason', '')), 300), ''),
      sender_rule_id = v_rule
  WHERE id = p_message_id;

  IF v_rule IS NOT NULL THEN
    UPDATE public.email_sender_rules SET hit_count = hit_count + 1, last_hit_at = now() WHERE id = v_rule;
  END IF;

  UPDATE public.email_inboxes SET last_received_at = now() WHERE id = v_message.inbox_id;
  IF p_decision->>'received_via_address_id' IS NOT NULL THEN
    UPDATE public.email_project_addresses SET last_received_at = now()
    WHERE id = (p_decision->>'received_via_address_id')::uuid AND inbox_id = v_message.inbox_id;
  END IF;

  RETURN jsonb_build_object('already_complete', false, 'status', v_status, 'thread_id', v_thread);
END;
$$;

-- A triage may also set the thread's one-line summary (p_triage.thread_summary).
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

-- The dispatcher also wakes the agent for reply drafts people asked for.
CREATE OR REPLACE FUNCTION public.email_signal(p_inbox_ids jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb)))
  SELECT jsonb_build_object(
    'new_count', (SELECT count(*) FROM public.email_messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'newest_received_at', (SELECT max(m.received_at) FROM public.email_messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'unsummarized_count', (
      SELECT count(DISTINCT t.message_id) FROM public.email_triage t
      JOIN public.email_messages m ON m.id = t.message_id
      WHERE m.inbox_id IN (SELECT id FROM inboxes) AND t.summarized_at IS NULL
    ),
    'drafts_requested', (
      SELECT count(*) FROM public.email_reply_drafts d
      JOIN public.email_messages m ON m.id = d.message_id
      WHERE m.inbox_id IN (SELECT id FROM inboxes) AND d.status = 'requested'
    )
  )
$$;

-- The batched summary also sees how each email was sorted and the thread's line.
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
        'kind', m.kind, 'topic', m.topic, 'sort_action', m.sort_action,
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
      'thread_summary', th.summary,
      'links', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('task_id', k.task_id, 'relation', k.relation, 'title', tk.title, 'status', tk.status) ORDER BY k.created_at)
        FROM public.email_task_links k JOIN public.tasks tk ON tk.id = k.task_id
        WHERE k.message_id = m.id AND tk.deleted_at IS NULL
      ), '[]'::jsonb),
      'reminders', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', rm.id, 'title', rm.title, 'remind_on', rm.remind_on, 'task_id', rm.task_id) ORDER BY rm.created_at)
        FROM public.reminders rm
        WHERE rm.source_message_id = m.id AND rm.deleted_at IS NULL AND rm.status = 'open'
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

REVOKE ALL ON FUNCTION public.email_complete_message(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_signal(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_unsummarized_triage(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_complete_message(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_signal(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_unsummarized_triage(jsonb, integer) TO service_role;
