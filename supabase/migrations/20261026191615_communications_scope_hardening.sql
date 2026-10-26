-- Three holes the review of the multi-project work found, closed:
-- 1. A person's answer opens any project only to the email it answers. Before,
--    an answer anywhere on a conversation opened every earlier email to every
--    project, filed as the person's choice.
-- 2. set_conversation_project only adds. It replaced a conversation's projects
--    with one, skipping the checks remove_conversation_project makes (linked
--    tasks, the member's reach); an old browser tab could still call it.
-- 3. file_message_project (and so link_message_task) locks the conversation
--    before filing, as record_triage does, so two links on one conversation
--    run one after the other and the conversation's strongest project stays
--    right.
-- Tables created in this schema later are read-only for signed-in members
-- unless a migration grants more.
--
-- Apply after 20261026093748_conversation_projects_scope.sql. Safe to re-run.

BEGIN;

ALTER DEFAULT PRIVILEGES IN SCHEMA communications REVOKE INSERT, UPDATE, DELETE ON TABLES FROM authenticated;

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
  -- A person answered the agent's question on this very email.
  IF EXISTS (SELECT 1 FROM communications.answers a WHERE a.message_id = p_message_id) THEN
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
  v_answered := EXISTS (SELECT 1 FROM communications.answers a WHERE a.message_id = p_message_id);
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
-- a person did it, so it is in scope and recorded as person. Locks the
-- conversation, as record_triage does, so filings on one conversation run in
-- turn.
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
  PERFORM 1 FROM communications.conversations WHERE id = v_thread FOR UPDATE;
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

-- A person files a conversation on a project, as their choice, beside the
-- projects it already has (taking one off is remove_conversation_project,
-- with its checks). p_only_if_none files it only when the conversation has no
-- project yet. Returns whether it filed it.
CREATE OR REPLACE FUNCTION communications.set_conversation_project(
  p_conversation_id uuid,
  p_project_id uuid,
  p_member_id uuid,
  p_only_if_none boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM communications.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: conversation %', p_conversation_id USING ERRCODE = 'P0002'; END IF;
  IF p_only_if_none AND EXISTS (SELECT 1 FROM communications.conversation_projects WHERE conversation_id = p_conversation_id) THEN
    RETURN false;
  END IF;
  INSERT INTO communications.conversation_projects (conversation_id, project_id, source, added_by)
  VALUES (p_conversation_id, p_project_id, 'person', p_member_id)
  ON CONFLICT (conversation_id, project_id) DO UPDATE
  SET source = 'person', endpoint_id = NULL, added_by = EXCLUDED.added_by;
  RETURN true;
END;
$$;

COMMIT;
