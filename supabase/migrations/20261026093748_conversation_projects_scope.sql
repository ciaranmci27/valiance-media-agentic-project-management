-- One conversation, several projects. A message's sender decides which
-- projects it may touch (communications.scope_source: the conversation's own,
-- its project addresses, its sender's mappings, and any project taking mail
-- once a verified teammate, verified meeting notes or a person's answer is
-- behind it); the agent files each item on its own project inside that.
-- Enforced here, in the database: record_triage with p_project_ids files a
-- triage on every project it names and every linked task's project, each in
-- scope or nothing is written; link_message_task and file_message_project do
-- the same for a single link or project. The one-project-per-conversation
-- index goes; triage rows record every project they filed on (project_ids).
-- The single-project record_triage stays for older callers until the
-- contract migration. Ingest records every project address a message came
-- through, and the summary feed lists every project.
--
-- Apply after 20261026091944_communications_schema.sql. Safe to re-run.

BEGIN;

DROP INDEX IF EXISTS communications.conversation_projects_one_per_conversation;

ALTER TABLE communications.triage ADD COLUMN IF NOT EXISTS project_ids uuid[] NOT NULL DEFAULT '{}';
-- Older triage rows filed on their single project.
UPDATE communications.triage SET project_ids = ARRAY[project_id]
WHERE project_id IS NOT NULL AND project_ids = '{}';

-- Open for new mail: live, active and not archived. A project already on a
-- conversation stays reachable from it whatever its state.
CREATE OR REPLACE FUNCTION communications.project_accepts_messages(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = p_project_id AND deleted_at IS NULL AND archived_at IS NULL AND status = 'active'
  )
$$;

-- The stronger of two sources (a person's word first, a guess last).
CREATE OR REPLACE FUNCTION communications.stronger_source(p_a text, p_b text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_a IS NULL THEN p_b
    WHEN p_b IS NULL THEN p_a
    WHEN communications.project_source_rank(p_b) < communications.project_source_rank(p_a) THEN p_b
    ELSE p_a END
$$;

-- Whether a message may touch a project, and as what: the source it files
-- the project with, or null when it may not.
CREATE OR REPLACE FUNCTION communications.scope_source(p_message_id uuid, p_project_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_best text;
  v_existing text;
  v_candidates integer;
BEGIN
  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id;
  IF NOT FOUND OR p_project_id IS NULL OR v_message.thread_id IS NULL THEN RETURN NULL; END IF;

  SELECT source INTO v_existing FROM communications.conversation_projects
  WHERE conversation_id = v_message.thread_id AND project_id = p_project_id;
  IF v_existing IS NOT NULL AND (v_existing <> 'guessed' OR v_message.sender_member_id IS NOT NULL) THEN
    v_best := v_existing;
  END IF;
  IF NOT communications.project_accepts_messages(p_project_id) THEN RETURN v_best; END IF;

  IF EXISTS (
    SELECT 1 FROM communications.message_endpoints me
    JOIN communications.endpoints e ON e.id = me.endpoint_id
    WHERE me.message_id = p_message_id AND e.project_id = p_project_id
  ) THEN
    v_best := communications.stronger_source(v_best, 'address');
  END IF;
  IF EXISTS (SELECT 1 FROM communications.message_candidates WHERE message_id = p_message_id AND project_id = p_project_id) THEN
    SELECT count(DISTINCT project_id) INTO v_candidates FROM communications.message_candidates WHERE message_id = p_message_id;
    v_best := communications.stronger_source(v_best, CASE WHEN v_candidates = 1 THEN 'mapped' ELSE 'inferred' END);
  END IF;
  IF EXISTS (
    SELECT 1 FROM communications.answers a
    JOIN communications.messages m ON m.id = a.message_id
    WHERE m.thread_id = v_message.thread_id AND a.created_at >= v_message.received_at
  ) THEN
    v_best := communications.stronger_source(v_best, 'person');
  END IF;
  IF v_message.sender_member_id IS NOT NULL OR (v_message.kind = 'meeting_notes' AND v_message.sender_verified) THEN
    v_best := communications.stronger_source(v_best, 'guessed');
  END IF;
  RETURN v_best;
END;
$$;

-- The scope as the agent reads it: the projects the message may touch by
-- name, and whether it may touch any project taking mail (and as what).
-- { bases: [conversation|endpoint|mapped|team|meeting_notes|answered],
--   projects: [{ project_id, source }], any_project: bool, any_source: person|guessed|null }
CREATE OR REPLACE FUNCTION communications.message_scope(p_message_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_bases text[] := '{}';
  v_answered boolean;
  v_team boolean;
  v_notes boolean;
BEGIN
  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id;
  IF NOT FOUND OR v_message.thread_id IS NULL THEN
    RETURN jsonb_build_object('bases', '[]'::jsonb, 'projects', '[]'::jsonb, 'any_project', false, 'any_source', NULL);
  END IF;
  v_answered := EXISTS (
    SELECT 1 FROM communications.answers a
    JOIN communications.messages m ON m.id = a.message_id
    WHERE m.thread_id = v_message.thread_id AND a.created_at >= v_message.received_at
  );
  v_team := v_message.sender_member_id IS NOT NULL;
  v_notes := v_message.kind = 'meeting_notes' AND v_message.sender_verified;
  IF EXISTS (
    SELECT 1 FROM communications.conversation_projects
    WHERE conversation_id = v_message.thread_id AND (source <> 'guessed' OR v_team)
  ) THEN v_bases := array_append(v_bases, 'conversation'); END IF;
  IF EXISTS (SELECT 1 FROM communications.message_endpoints WHERE message_id = p_message_id) THEN v_bases := array_append(v_bases, 'endpoint'); END IF;
  IF EXISTS (SELECT 1 FROM communications.message_candidates WHERE message_id = p_message_id) THEN v_bases := array_append(v_bases, 'mapped'); END IF;
  IF v_team THEN v_bases := array_append(v_bases, 'team'); END IF;
  IF v_notes THEN v_bases := array_append(v_bases, 'meeting_notes'); END IF;
  IF v_answered THEN v_bases := array_append(v_bases, 'answered'); END IF;
  RETURN jsonb_build_object(
    'bases', to_jsonb(v_bases),
    'projects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('project_id', x.project_id, 'source', x.source) ORDER BY x.project_id)
      FROM (
        SELECT p.project_id, communications.scope_source(p_message_id, p.project_id) AS source
        FROM (
          SELECT project_id FROM communications.conversation_projects WHERE conversation_id = v_message.thread_id
          UNION SELECT e.project_id FROM communications.message_endpoints me
            JOIN communications.endpoints e ON e.id = me.endpoint_id WHERE me.message_id = p_message_id
          UNION SELECT project_id FROM communications.message_candidates WHERE message_id = p_message_id
        ) p
      ) x
      WHERE x.source IS NOT NULL
    ), '[]'::jsonb),
    'any_project', v_answered OR v_team OR v_notes,
    'any_source', CASE WHEN v_answered THEN 'person' WHEN v_team OR v_notes THEN 'guessed' END
  );
END;
$$;

-- Files a project on the message's conversation as its scope allows (an
-- existing project keeps the stronger source). Raises
-- EMAIL_PROJECT_OUT_OF_SCOPE when the message may not touch it. p_as_person:
-- a person did it, so it is in scope and recorded as person.
CREATE OR REPLACE FUNCTION communications.file_message_project(
  p_message_id uuid,
  p_project_id uuid,
  p_member_id uuid,
  p_as_person boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_thread uuid;
  v_source text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT thread_id INTO v_thread FROM communications.messages WHERE id = p_message_id AND status <> 'receiving';
  IF v_thread IS NULL THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002'; END IF;
  v_source := CASE WHEN p_as_person THEN 'person' ELSE communications.scope_source(p_message_id, p_project_id) END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'EMAIL_PROJECT_OUT_OF_SCOPE: this message may not touch project %', p_project_id
      USING ERRCODE = 'P0001', DETAIL = p_project_id::text;
  END IF;
  INSERT INTO communications.conversation_projects AS cp (conversation_id, project_id, source, endpoint_id, message_id, added_by)
  VALUES (
    v_thread, p_project_id, v_source,
    CASE WHEN v_source = 'address' THEN (
      SELECT e.id FROM communications.message_endpoints me JOIN communications.endpoints e ON e.id = me.endpoint_id
      WHERE me.message_id = p_message_id AND e.project_id = p_project_id ORDER BY e.created_at LIMIT 1
    ) END,
    p_message_id, p_member_id
  )
  ON CONFLICT (conversation_id, project_id) DO UPDATE
  SET source = EXCLUDED.source, endpoint_id = EXCLUDED.endpoint_id, message_id = EXCLUDED.message_id, added_by = EXCLUDED.added_by
  WHERE communications.project_source_rank(EXCLUDED.source) < communications.project_source_rank(cp.source);
  RETURN (SELECT source FROM communications.conversation_projects WHERE conversation_id = v_thread AND project_id = p_project_id);
END;
$$;

-- Links a task to a message (a person's link, or an agent's before its
-- triage), filing the task's project on the conversation as the scope allows.
CREATE OR REPLACE FUNCTION communications.link_message_task(
  p_message_id uuid,
  p_task_id uuid,
  p_relation text,
  p_member_id uuid,
  p_as_person boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_project uuid;
  v_source text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_relation NOT IN ('created', 'updated', 'related') THEN RAISE EXCEPTION 'link_message_task: invalid relation' USING ERRCODE = '22023'; END IF;
  SELECT project_id INTO v_project FROM public.tasks WHERE id = p_task_id AND deleted_at IS NULL;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'EMAIL_LINK_TASK_NOT_FOUND: task %', p_task_id USING ERRCODE = 'P0001', DETAIL = p_task_id::text;
  END IF;
  PERFORM 1 FROM communications.messages WHERE id = p_message_id FOR UPDATE;
  v_source := communications.file_message_project(p_message_id, v_project, p_member_id, p_as_person);
  INSERT INTO communications.task_links (message_id, task_id, relation, triage_id, linked_by)
  VALUES (p_message_id, p_task_id, p_relation, NULL, p_member_id)
  ON CONFLICT (message_id, task_id, relation) DO NOTHING;
  RETURN jsonb_build_object('task_id', p_task_id, 'project_id', v_project, 'source', v_source);
END;
$$;

-- A conversation's id with its strongest project (project_id,
-- project_source, as older readers know it) and every project it is filed on.
CREATE OR REPLACE FUNCTION communications.conversation_projects_json(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'project_id', c.project_id, 'project_source', c.project_source,
    'projects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('project_id', p.project_id, 'source', p.source)
        ORDER BY communications.project_source_rank(p.source), p.created_at, p.project_id)
      FROM communications.conversation_projects p WHERE p.conversation_id = c.id
    ), '[]'::jsonb)
  )
  FROM communications.conversations c WHERE c.id = p_conversation_id
$$;

-- A person adds a project to a conversation, or confirms one the agent
-- guessed: it is theirs from here on (person), the others stay.
CREATE OR REPLACE FUNCTION communications.add_conversation_project(p_conversation_id uuid, p_project_id uuid, p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM communications.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: conversation %', p_conversation_id USING ERRCODE = 'P0002'; END IF;
  INSERT INTO communications.conversation_projects (conversation_id, project_id, source, added_by)
  VALUES (p_conversation_id, p_project_id, 'person', p_member_id)
  ON CONFLICT (conversation_id, project_id) DO UPDATE
  SET source = 'person', endpoint_id = NULL, added_by = EXCLUDED.added_by;
END;
$$;

-- A person takes a project off a conversation. Refused
-- (EMAIL_PROJECT_HAS_TASKS) while one of its emails is linked to a task on
-- that project: unlink or move the task first.
CREATE OR REPLACE FUNCTION communications.remove_conversation_project(p_conversation_id uuid, p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM communications.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM communications.task_links k
    JOIN communications.messages m ON m.id = k.message_id
    JOIN public.tasks t ON t.id = k.task_id
    WHERE m.thread_id = p_conversation_id AND t.project_id = p_project_id AND t.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'EMAIL_PROJECT_HAS_TASKS: a task on that project is linked to this conversation' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM communications.conversation_projects WHERE conversation_id = p_conversation_id AND project_id = p_project_id;
  RETURN FOUND;
END;
$$;

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
  IF p_status NOT IN ('handled', 'needs_human') THEN RAISE EXCEPTION 'record_triage: invalid status' USING ERRCODE = '22023'; END IF;

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
    idempotency_key, request_hash
  )
  VALUES (
    p_message_id, p_member_id, p_triage->>'outcome', COALESCE((p_triage->>'urgent')::boolean, false),
    p_triage->>'summary', p_triage->>'question_for_human', p_triage->>'suggested_reply',
    CASE WHEN cardinality(v_projects) = 1 THEN v_projects[1] END, v_projects,
    p_idempotency_key, p_request_hash
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

-- Ingestion step 2, after every planned file is stored: thread, mapping, status.
-- p_decision: { status: new|ignored, thread_id?: uuid (else a new thread),
--   project_id?: uuid (set only on a thread without one),
--   project_source?: mapped (default, a contact or domain) | address (the
--   project's own address, with project_address_id),
--   project_address_id?: uuid,
--   received_via_address_id?: uuid, received_via_address_ids?: [uuid] (the
--   project addresses the email matched, whether or not they set the
--   project: each is recorded on the message and its last_received_at stamped),
--   routing_basis?: sender (default) | forwarded_original | team_recipients,
--   forwarded_by_member_id?: uuid (the verified teammate, when not sender),
--   original_from_address?, original_from_name? (forwarded_original only),
--   candidates: [{project_id, reason}], recipient_contacts: [{address, contact_id}] }
CREATE OR REPLACE FUNCTION communications.email_complete_message(p_message_id uuid, p_decision jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_thread uuid;
  v_status text := p_decision->>'status';
  v_source text := COALESCE(p_decision->>'project_source', 'mapped');
  v_basis text := COALESCE(p_decision->>'routing_basis', 'sender');
  v_rule uuid := (p_decision->>'sender_rule_id')::uuid;
  v_forwarder uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF v_status NOT IN ('new', 'ignored') THEN RAISE EXCEPTION 'email_complete_message: status must be new or ignored' USING ERRCODE = '22023'; END IF;
  IF v_source NOT IN ('mapped', 'address') THEN RAISE EXCEPTION 'email_complete_message: project_source must be mapped or address' USING ERRCODE = '22023'; END IF;
  IF v_basis NOT IN ('sender', 'forwarded_original', 'team_recipients') THEN
    RAISE EXCEPTION 'email_complete_message: routing_basis must be sender, forwarded_original or team_recipients' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002'; END IF;
  IF v_message.status <> 'receiving' THEN
    RETURN jsonb_build_object('already_complete', true, 'status', v_message.status, 'thread_id', v_message.thread_id);
  END IF;
  IF (v_message.raw_storage_path IS NOT NULL AND v_message.raw_uploaded_at IS NULL)
    OR EXISTS (SELECT 1 FROM communications.attachments WHERE message_id = p_message_id AND uploaded_at IS NULL AND skipped_reason IS NULL) THEN
    RAISE EXCEPTION 'EMAIL_FILES_PENDING: message % still has files to store', p_message_id USING ERRCODE = 'P0001';
  END IF;

  IF p_decision->>'thread_id' IS NOT NULL THEN
    SELECT id INTO v_thread FROM communications.conversations
    WHERE id = (p_decision->>'thread_id')::uuid AND inbox_id = v_message.inbox_id
    FOR UPDATE;
    IF v_thread IS NULL THEN RAISE EXCEPTION 'email_complete_message: thread is not in this inbox' USING ERRCODE = '22023'; END IF;
    UPDATE communications.conversations SET last_message_at = GREATEST(last_message_at, v_message.received_at) WHERE id = v_thread;
  ELSE
    INSERT INTO communications.conversations (inbox_id, subject_normalized, last_message_at)
    VALUES (v_message.inbox_id, v_message.subject_normalized, v_message.received_at)
    RETURNING id INTO v_thread;
  END IF;

  -- A conversation keeps its project once set (the conversation row is
  -- locked above or new). An address deleted since it was matched still
  -- files the project, without the address.
  IF p_decision->>'project_id' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM communications.conversation_projects WHERE conversation_id = v_thread) THEN
    INSERT INTO communications.conversation_projects (conversation_id, project_id, source, endpoint_id, message_id)
    VALUES (
      v_thread, (p_decision->>'project_id')::uuid, v_source,
      CASE WHEN v_source = 'address' THEN (
        SELECT a.id FROM communications.endpoints a WHERE a.id = (p_decision->>'project_address_id')::uuid
      ) END,
      p_message_id
    )
    ON CONFLICT DO NOTHING;
  END IF;
  -- Every project endpoint it came through (the scope's endpoint basis).
  INSERT INTO communications.message_endpoints (message_id, endpoint_id)
  SELECT p_message_id, a.id FROM communications.endpoints a
  WHERE a.inbox_id = v_message.inbox_id AND (
    a.id = (p_decision->>'received_via_address_id')::uuid
    OR a.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_decision->'received_via_address_ids', '[]'::jsonb)))
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO communications.message_candidates (message_id, project_id, reason)
  SELECT p_message_id, (c->>'project_id')::uuid, c->>'reason'
  FROM jsonb_array_elements(COALESCE(p_decision->'candidates', '[]'::jsonb)) AS c
  ON CONFLICT DO NOTHING;

  UPDATE communications.participants r
  SET contact_id = (x->>'contact_id')::uuid
  FROM jsonb_array_elements(COALESCE(p_decision->'recipient_contacts', '[]'::jsonb)) AS x
  WHERE r.message_id = p_message_id AND r.address = x->>'address';

  -- A rule switched off since ingestion read it is still the rule that sorted it.
  IF v_rule IS NOT NULL AND NOT EXISTS (SELECT 1 FROM communications.sender_rules WHERE id = v_rule) THEN
    v_rule := NULL;
  END IF;

  -- A teammate deleted since ingestion read them leaves no forwarder. The
  -- teammate is also the message's sender_member_id: the verified teammate
  -- behind it, whatever the channel.
  v_forwarder := CASE WHEN v_basis <> 'sender' THEN (
    SELECT tm.id FROM public.team_members tm WHERE tm.id = (p_decision->>'forwarded_by_member_id')::uuid
  ) END;
  UPDATE communications.messages
  SET thread_id = v_thread,
      status = v_status,
      completed_at = now(),
      routing_basis = v_basis,
      forwarded_by_member_id = v_forwarder,
      sender_member_id = v_forwarder,
      sender_verified = COALESCE(v_message.auth->>'trust', '') = 'trusted',
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
    UPDATE communications.sender_rules SET hit_count = hit_count + 1, last_hit_at = now() WHERE id = v_rule;
  END IF;

  UPDATE communications.inboxes SET last_received_at = now() WHERE id = v_message.inbox_id;
  UPDATE communications.endpoints e SET last_received_at = now()
  FROM communications.message_endpoints me
  WHERE me.message_id = p_message_id AND e.id = me.endpoint_id;

  RETURN jsonb_build_object('already_complete', false, 'status', v_status, 'thread_id', v_thread);
END;
$$;

-- Defined after reminders, which it reads (the reminders an email set).
-- The newest unsummarized triage per message, oldest message first, with
-- what the batched summary needs (no bodies).
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

REVOKE ALL ON FUNCTION communications.project_accepts_messages(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.scope_source(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.message_scope(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.file_message_project(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.link_message_task(uuid, uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.record_triage(uuid, uuid, jsonb, jsonb, uuid[], text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.conversation_projects_json(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.project_accepts_messages(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.scope_source(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.message_scope(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.file_message_project(uuid, uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION communications.link_message_task(uuid, uuid, text, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION communications.record_triage(uuid, uuid, jsonb, jsonb, uuid[], text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION communications.conversation_projects_json(uuid) TO service_role;
REVOKE ALL ON FUNCTION communications.add_conversation_project(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.remove_conversation_project(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.add_conversation_project(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.remove_conversation_project(uuid, uuid) TO service_role;

COMMIT;
