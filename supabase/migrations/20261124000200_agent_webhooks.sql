-- Agent webhooks: outbound webhooks become the way an external agent harness
-- hears about work, beside the invoice events they carried before.
--
-- - New event types on the same outbox, signing, retries, leases and manual
--   re-send: task.created, task.updated, task.deleted, comment.created,
--   question.asked, question.answered, question.cancelled,
--   suggestion.created, suggestion.decided and review.submitted. Each payload
--   is its subject's current state plus the ids a harness needs: project_id,
--   task_id, member_ids (who the event concerns) and actor_id (who made the
--   change, when known, so an agent can skip its own).
-- - The subject orders delivery: webhook_events.resource_type and
--   resource_id. Events for one subject reach an endpoint one at a time, in
--   sequence order. A task's comments and reviews share the task's line.
--   Invoices keep their per-invoice line, and their payloads are unchanged.
-- - Endpoint filters, null meaning everything: project_ids (a list of
--   projects) and member_id (only events that concern that member, as
--   pm.webhook_event_members defines it). An invoice event concerns no
--   member, so an endpoint with a member filter never receives one.
-- - Only invoice events need Client invoicing. The claim, the retry kick and
--   the pm-webhook-retries job need only Webhooks for everything else; an
--   invoice event waits in order while Client invoicing is off, as before.
-- - Fan-out stays in the triggers (the transactional outbox). When no active
--   endpoint is subscribed to a trigger's event types the trigger does one
--   look at webhook_endpoints and nothing else, and no row is written for an
--   event no endpoint matches.
-- - One task.created or task.updated per task per transaction: a later
--   change in the same transaction refreshes it, so a save that rewrites the
--   assignees is one event, and a task created with its assignees is one
--   task.created that names them.
--
-- Additive and safe to run twice. The previous release's code reads
-- endpoints by named columns and never writes the new ones (null: no
-- filter); existing endpoints are subscribed only to invoice events, so they
-- receive exactly what they did.

-- ---------------------------------------------------------------------------
-- Endpoint filters
-- ---------------------------------------------------------------------------
ALTER TABLE pm.webhook_endpoints
  ADD COLUMN IF NOT EXISTS project_ids uuid[],
  ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES pm.team_members(id) ON DELETE CASCADE;

ALTER TABLE pm.webhook_endpoints DROP CONSTRAINT IF EXISTS webhook_endpoints_project_ids_not_empty;
ALTER TABLE pm.webhook_endpoints
  ADD CONSTRAINT webhook_endpoints_project_ids_not_empty CHECK (project_ids IS NULL OR cardinality(project_ids) > 0);

COMMENT ON COLUMN pm.webhook_endpoints.project_ids IS
  'Only events on these projects (null: every project). An event with no project never matches a list.';
COMMENT ON COLUMN pm.webhook_endpoints.member_id IS
  'Only events that concern this member, as pm.webhook_event_members defines it (null: everyone). Goes with the member.';

-- ---------------------------------------------------------------------------
-- Who and whom
-- ---------------------------------------------------------------------------
-- The member behind the current write, person or agent: the signed-in
-- member, or for service-role writes the x-actor-member-id header the server
-- sends. NULL for SQL run directly, cron jobs and keys with no member.
CREATE OR REPLACE FUNCTION pm.webhook_actor_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_header text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN pm.current_team_member_id();
  END IF;
  IF coalesce(auth.role(), '') = 'service_role' THEN
    BEGIN
      v_header := nullif(current_setting('request.headers', true), '')::json ->> 'x-actor-member-id';
    EXCEPTION WHEN others THEN
      v_header := NULL;
    END;
    IF v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN (SELECT m.id FROM pm.team_members m WHERE m.id = v_header::uuid);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.webhook_actor_id() FROM PUBLIC, anon, authenticated;

-- Who an event concerns: the one definition behind an endpoint's member
-- filter and every payload's member_ids.
-- - A task (task.*, and comment.created and review.submitted, whose subject
--   is the task): its assignees and the holder of a live claim on it.
-- - A question: the member asked (asked_to) and the asker (asked_by).
-- - A suggestion: who proposed it and who it would be assigned to.
-- p_also adds the members a change took off the subject (an assignee who was
-- removed), so they hear about it too.
CREATE OR REPLACE FUNCTION pm.webhook_event_members(p_subject_type text, p_subject_id uuid, p_also uuid[] DEFAULT '{}')
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT coalesce(array_agg(DISTINCT m ORDER BY m) FILTER (WHERE m IS NOT NULL), '{}')
  FROM (
    SELECT a.member_id AS m FROM pm.task_assignees a
    WHERE p_subject_type = 'task' AND a.task_id = p_subject_id
    UNION ALL
    SELECT t.claimed_by FROM pm.tasks t
    WHERE p_subject_type = 'task' AND t.id = p_subject_id
      AND (t.claim_expires_at IS NULL OR t.claim_expires_at > now())
    UNION ALL
    SELECT unnest(ARRAY[q.asked_to, q.asked_by]) FROM pm.questions q
    WHERE p_subject_type = 'question' AND q.id = p_subject_id
    UNION ALL
    SELECT unnest(ARRAY[s.proposed_by, s.assigned_to]) FROM pm.task_suggestions s
    WHERE p_subject_type = 'suggestion' AND s.id = p_subject_id
    UNION ALL
    SELECT unnest(coalesce(p_also, '{}'))
  ) members
$$;

REVOKE ALL ON FUNCTION pm.webhook_event_members(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;

-- Whether an endpoint receives an event: active, subscribed to its type, and
-- inside its filters. p_project_ids holds every project the event touches (a
-- task moved between projects touches both); p_member_ids is who it
-- concerns.
CREATE OR REPLACE FUNCTION pm.webhook_endpoint_matches(
  p_endpoint pm.webhook_endpoints,
  p_event_type text,
  p_project_ids uuid[],
  p_member_ids uuid[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pm
AS $$
  SELECT p_endpoint.is_active
    AND p_event_type = ANY (p_endpoint.events)
    AND (p_endpoint.project_ids IS NULL OR p_endpoint.project_ids && coalesce(p_project_ids, '{}'))
    AND (p_endpoint.member_id IS NULL OR p_endpoint.member_id = ANY (coalesce(p_member_ids, '{}')))
$$;

REVOKE ALL ON FUNCTION pm.webhook_endpoint_matches(pm.webhook_endpoints, text, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The event writer for everything but invoices
-- ---------------------------------------------------------------------------
-- Records one event and fans out one delivery per matching endpoint; writes
-- nothing when no endpoint matches. p_data becomes the payload's data, with
-- member_ids added.
--
-- p_folds_into: when the subject's latest event in this transaction is one of
-- these types (and nothing has been tried yet), it is refreshed instead: its
-- data becomes p_data, member_ids and changes become the union of both, and
-- endpoints that match now get a delivery too. Nothing else sees an event
-- before its transaction commits, so a refresh is never a change to
-- something sent.
CREATE OR REPLACE FUNCTION pm.emit_webhook_event(
  p_event_type text,
  p_subject_type text,
  p_subject_id uuid,
  p_project_ids uuid[],
  p_member_ids uuid[],
  p_data jsonb,
  p_folds_into text[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_latest pm.webhook_events;
  v_members uuid[] := coalesce(p_member_ids, '{}');
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_changes jsonb;
  v_seq bigint;
  v_public_id text;
  v_event_uuid uuid;
BEGIN
  IF p_folds_into IS NOT NULL THEN
    SELECT * INTO v_latest
    FROM pm.webhook_events ev
    WHERE ev.resource_type = p_subject_type AND ev.resource_id = p_subject_id AND ev.created_at = now()
    ORDER BY ev.sequence DESC
    LIMIT 1;
    IF FOUND AND v_latest.event_type = ANY (p_folds_into) AND NOT EXISTS (
      SELECT 1 FROM pm.webhook_deliveries d
      WHERE d.webhook_event_id = v_latest.id AND (d.status <> 'pending' OR d.attempts > 0)
    ) THEN
      SELECT coalesce(array_agg(DISTINCT m ORDER BY m), '{}') INTO v_members
      FROM (
        SELECT unnest(v_members) AS m
        UNION ALL
        SELECT value::uuid FROM jsonb_array_elements_text(coalesce(v_latest.payload -> 'data' -> 'member_ids', '[]'::jsonb))
      ) folded;
      IF (v_latest.payload -> 'data') ? 'changes' THEN
        SELECT coalesce(jsonb_agg(DISTINCT c ORDER BY c), '[]'::jsonb) INTO v_changes
        FROM (
          SELECT jsonb_array_elements_text(v_latest.payload -> 'data' -> 'changes') AS c
          UNION ALL
          SELECT jsonb_array_elements_text(coalesce(v_data -> 'changes', '[]'::jsonb))
        ) folded;
        v_data := v_data || jsonb_build_object('changes', v_changes);
      ELSE
        v_data := v_data - 'changes';
      END IF;

      UPDATE pm.webhook_events
      SET payload = jsonb_set(payload, '{data}', v_data || jsonb_build_object('member_ids', to_jsonb(v_members)))
      WHERE id = v_latest.id;

      INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id)
      SELECT v_latest.id, e.id
      FROM pm.webhook_endpoints e
      WHERE pm.webhook_endpoint_matches(e, v_latest.event_type, p_project_ids, v_members)
        AND NOT EXISTS (
          SELECT 1 FROM pm.webhook_deliveries d WHERE d.webhook_event_id = v_latest.id AND d.endpoint_id = e.id
        );
      RETURN;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE pm.webhook_endpoint_matches(e, p_event_type, p_project_ids, v_members)
  ) THEN
    RETURN;
  END IF;

  v_seq := nextval('pm.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
  VALUES (
    v_public_id, v_seq, p_event_type, p_subject_type, p_subject_id,
    jsonb_build_object(
      'id', v_public_id,
      'type', p_event_type,
      'sequence', v_seq,
      'created_at', now(),
      'data', v_data || jsonb_build_object('member_ids', to_jsonb(v_members))
    )
  )
  RETURNING id INTO v_event_uuid;

  INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id)
  SELECT v_event_uuid, e.id
  FROM pm.webhook_endpoints e
  WHERE pm.webhook_endpoint_matches(e, p_event_type, p_project_ids, v_members);
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_webhook_event(text, text, uuid, uuid[], uuid[], jsonb, text[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Payload pieces
-- ---------------------------------------------------------------------------
-- What every event about a task carries: the task as it is now (assignees
-- and a live claim included), its project, and the ids a harness keys on.
CREATE OR REPLACE FUNCTION pm.webhook_task_data(p_task pm.tasks)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT jsonb_build_object(
    'task', jsonb_build_object(
      'id', p_task.id,
      'project_id', p_task.project_id,
      'parent_task_id', p_task.parent_task_id,
      'title', p_task.title,
      'description', p_task.description,
      'status', p_task.status,
      'priority', p_task.priority,
      'due_date', p_task.due_date,
      'tags', to_jsonb(p_task.tags),
      'ai_readiness', p_task.ai_readiness,
      'assignee_ids', coalesce((
        SELECT jsonb_agg(a.member_id ORDER BY a.member_id) FROM pm.task_assignees a WHERE a.task_id = p_task.id
      ), '[]'::jsonb),
      'claimed_by', CASE WHEN p_task.claim_expires_at IS NULL OR p_task.claim_expires_at > now() THEN p_task.claimed_by END,
      'claim_expires_at', CASE WHEN p_task.claimed_by IS NOT NULL AND p_task.claim_expires_at > now() THEN p_task.claim_expires_at END,
      'created_by', p_task.created_by,
      'created_via', p_task.created_via,
      'source_task_suggestion_id', p_task.source_task_suggestion_id,
      'completed_at', p_task.completed_at,
      'created_at', p_task.created_at,
      'updated_at', p_task.updated_at,
      'deleted_at', p_task.deleted_at
    ),
    'project', jsonb_build_object('id', p_task.project_id, 'name', coalesce((SELECT p.name FROM pm.projects p WHERE p.id = p_task.project_id), '')),
    'project_id', p_task.project_id,
    'task_id', p_task.id,
    'actor_id', pm.webhook_actor_id()
  )
$$;

REVOKE ALL ON FUNCTION pm.webhook_task_data(pm.tasks) FROM PUBLIC, anon, authenticated;

-- A task event. Any change in the transaction that created the task is part
-- of its creation: it refreshes that task.created (or sends it, when it is
-- the change that brings an endpoint in, such as the assignee a member
-- filter waits for). task.updated carries the names of the changed fields.
CREATE OR REPLACE FUNCTION pm.emit_task_event(
  p_task pm.tasks,
  p_event_type text,
  p_changes text[] DEFAULT '{}',
  p_also_members uuid[] DEFAULT '{}',
  p_also_projects uuid[] DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_type text := p_event_type;
  v_data jsonb := pm.webhook_task_data(p_task);
BEGIN
  IF v_type = 'task.updated' AND p_task.created_at = now() THEN
    v_type := 'task.created';
  END IF;
  IF v_type = 'task.updated' THEN
    v_data := v_data || jsonb_build_object('changes', to_jsonb(coalesce(p_changes, '{}')));
  END IF;
  PERFORM pm.emit_webhook_event(
    v_type,
    'task',
    p_task.id,
    ARRAY[p_task.project_id] || coalesce(p_also_projects, '{}'),
    pm.webhook_event_members('task', p_task.id, p_also_members),
    v_data,
    CASE
      WHEN v_type = 'task.updated' THEN ARRAY['task.updated']
      WHEN v_type = 'task.created' AND p_event_type = 'task.updated' THEN ARRAY['task.created']
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_task_event(pm.tasks, text, text[], uuid[], uuid[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
-- Tasks: created, the fields people act on changed (status, title,
-- description, priority, due date, project, who may work it), moved to Trash
-- (task.deleted) or restored (task.created again, as creating it would
-- send). Reordering, claims and edits in Trash send nothing.
CREATE OR REPLACE FUNCTION pm.emit_task_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_changes text[] := '{}';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['task.created', 'task.updated', 'task.deleted']
  ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NULL THEN
      PERFORM pm.emit_task_event(NEW, 'task.created');
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    IF OLD.deleted_at IS NULL THEN
      PERFORM pm.emit_task_event(NEW, 'task.deleted');
    END IF;
    RETURN NULL;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    PERFORM pm.emit_task_event(NEW, 'task.created');
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN v_changes := v_changes || 'status'::text; END IF;
  IF NEW.title IS DISTINCT FROM OLD.title THEN v_changes := v_changes || 'title'::text; END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN v_changes := v_changes || 'description'::text; END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN v_changes := v_changes || 'priority'::text; END IF;
  IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN v_changes := v_changes || 'due_date'::text; END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN v_changes := v_changes || 'project_id'::text; END IF;
  IF NEW.ai_readiness IS DISTINCT FROM OLD.ai_readiness THEN v_changes := v_changes || 'ai_readiness'::text; END IF;
  IF cardinality(v_changes) = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM pm.emit_task_event(NEW, 'task.updated', v_changes, '{}', ARRAY[OLD.project_id]);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_task_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_task_webhook_insert ON pm.tasks;
CREATE TRIGGER emit_task_webhook_insert
  AFTER INSERT ON pm.tasks
  FOR EACH ROW EXECUTE FUNCTION pm.emit_task_webhook();

DROP TRIGGER IF EXISTS emit_task_webhook_update ON pm.tasks;
CREATE TRIGGER emit_task_webhook_update
  AFTER UPDATE ON pm.tasks
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.due_date IS DISTINCT FROM OLD.due_date
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.ai_readiness IS DISTINCT FROM OLD.ai_readiness
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  EXECUTE FUNCTION pm.emit_task_webhook();

-- Assignees: a task.updated with changes ["assignee_ids"]. A removed
-- assignee is among the members it concerns, so they hear they are off it.
CREATE OR REPLACE FUNCTION pm.emit_task_assignee_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_task pm.tasks;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['task.created', 'task.updated']
  ) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_task FROM pm.tasks
  WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.task_id ELSE NEW.task_id END;
  IF NOT FOUND OR v_task.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pm.emit_task_event(
    v_task,
    'task.updated',
    ARRAY['assignee_ids'],
    CASE WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.member_id] ELSE '{}'::uuid[] END
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_task_assignee_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_task_assignee_webhook ON pm.task_assignees;
CREATE TRIGGER emit_task_assignee_webhook
  AFTER INSERT OR DELETE ON pm.task_assignees
  FOR EACH ROW EXECUTE FUNCTION pm.emit_task_assignee_webhook();

-- Comments on a live task: comment.created, in the task's line.
CREATE OR REPLACE FUNCTION pm.emit_comment_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_task pm.tasks;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e WHERE e.is_active AND 'comment.created' = ANY (e.events)
  ) THEN
    RETURN NULL;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_task FROM pm.tasks WHERE id = NEW.task_id;
  IF NOT FOUND OR v_task.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pm.emit_webhook_event(
    'comment.created',
    'task',
    v_task.id,
    ARRAY[v_task.project_id],
    pm.webhook_event_members('task', v_task.id),
    pm.webhook_task_data(v_task) || jsonb_build_object('comment', jsonb_build_object(
      'id', NEW.id,
      'task_id', NEW.task_id,
      'author_id', NEW.user_id,
      'text', NEW.text,
      'created_at', NEW.created_at
    ))
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_comment_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_comment_webhook ON pm.task_comments;
CREATE TRIGGER emit_comment_webhook
  AFTER INSERT ON pm.task_comments
  FOR EACH ROW EXECUTE FUNCTION pm.emit_comment_webhook();

-- Reviews on a live task: review.submitted, in the task's line.
CREATE OR REPLACE FUNCTION pm.emit_review_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_task pm.tasks;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e WHERE e.is_active AND 'review.submitted' = ANY (e.events)
  ) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_task FROM pm.tasks WHERE id = NEW.task_id;
  IF NOT FOUND OR v_task.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pm.emit_webhook_event(
    'review.submitted',
    'task',
    v_task.id,
    ARRAY[v_task.project_id],
    pm.webhook_event_members('task', v_task.id),
    pm.webhook_task_data(v_task) || jsonb_build_object('review', jsonb_build_object(
      'id', NEW.id,
      'task_id', NEW.task_id,
      'round', NEW.round,
      'verdict', NEW.verdict,
      'summary', NEW.summary,
      'pr_url', NEW.pr_url,
      'head_sha', NEW.head_sha,
      'reviewer_id', NEW.reviewer_member_id,
      'created_at', NEW.created_at
    ))
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_review_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_review_webhook ON pm.task_reviews;
CREATE TRIGGER emit_review_webhook
  AFTER INSERT ON pm.task_reviews
  FOR EACH ROW EXECUTE FUNCTION pm.emit_review_webhook();

-- Questions: asked (also when one opens again or comes back from Trash
-- open), answered, cancelled (also when an open one goes to Trash). Expiry
-- sends nothing: an open question past expires_at reads as expired.
CREATE OR REPLACE FUNCTION pm.emit_question_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_type text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['question.asked', 'question.answered', 'question.cancelled']
  ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'open' AND NEW.deleted_at IS NULL THEN
      v_type := 'question.asked';
    END IF;
  ELSIF NEW.deleted_at IS NOT NULL THEN
    IF OLD.deleted_at IS NULL AND OLD.status = 'open' THEN
      v_type := 'question.cancelled';
    END IF;
  ELSIF OLD.deleted_at IS NOT NULL THEN
    IF NEW.status = 'open' THEN
      v_type := 'question.asked';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    v_type := CASE NEW.status
      WHEN 'open' THEN 'question.asked'
      WHEN 'answered' THEN 'question.answered'
      WHEN 'cancelled' THEN 'question.cancelled'
    END;
  END IF;
  IF v_type IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pm.emit_webhook_event(
    v_type,
    'question',
    NEW.id,
    ARRAY[NEW.project_id],
    pm.webhook_event_members('question', NEW.id),
    jsonb_build_object(
      'question', jsonb_build_object(
        'id', NEW.id,
        'project_id', NEW.project_id,
        'task_id', NEW.task_id,
        'asked_by', NEW.asked_by,
        'asked_to', NEW.asked_to,
        'question', NEW.question,
        'choices', NEW.choices,
        'allow_other', NEW.allow_other,
        'status', NEW.status,
        'answer_choice', NEW.answer_choice,
        'answer_text', NEW.answer_text,
        'answered_by', NEW.answered_by,
        'answered_at', NEW.answered_at,
        'cancelled_by', NEW.cancelled_by,
        'cancelled_at', NEW.cancelled_at,
        'expires_at', NEW.expires_at,
        'created_at', NEW.created_at,
        'updated_at', NEW.updated_at,
        'deleted_at', NEW.deleted_at
      ),
      'project', CASE WHEN NEW.project_id IS NOT NULL THEN jsonb_build_object(
        'id', NEW.project_id,
        'name', coalesce((SELECT p.name FROM pm.projects p WHERE p.id = NEW.project_id), '')
      ) END,
      'project_id', NEW.project_id,
      'task_id', NEW.task_id,
      'actor_id', pm.webhook_actor_id()
    )
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_question_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_question_webhook_insert ON pm.questions;
CREATE TRIGGER emit_question_webhook_insert
  AFTER INSERT ON pm.questions
  FOR EACH ROW EXECUTE FUNCTION pm.emit_question_webhook();

DROP TRIGGER IF EXISTS emit_question_webhook_update ON pm.questions;
CREATE TRIGGER emit_question_webhook_update
  AFTER UPDATE ON pm.questions
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  EXECUTE FUNCTION pm.emit_question_webhook();

-- Suggestions: created, and decided (approved, rejected or declined). The
-- task an approval makes arrives as its own task.created, which names the
-- suggestion in source_task_suggestion_id.
CREATE OR REPLACE FUNCTION pm.emit_suggestion_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_type text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['suggestion.created', 'suggestion.decided']
  ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_type := 'suggestion.created';
  ELSIF NEW.status IN ('approved', 'rejected', 'declined') AND OLD.status NOT IN ('approved', 'rejected', 'declined') THEN
    v_type := 'suggestion.decided';
  ELSE
    RETURN NULL;
  END IF;

  PERFORM pm.emit_webhook_event(
    v_type,
    'suggestion',
    NEW.id,
    ARRAY[NEW.project_id],
    pm.webhook_event_members('suggestion', NEW.id),
    jsonb_build_object(
      'suggestion', jsonb_build_object(
        'id', NEW.id,
        'project_id', NEW.project_id,
        'goal_id', NEW.goal_id,
        'proposed_by', NEW.proposed_by,
        'assigned_to', NEW.assigned_to,
        'title', NEW.title,
        'description', NEW.description,
        'reasoning', NEW.reasoning,
        'priority', NEW.priority,
        'effort_estimate', NEW.effort_estimate,
        'status', NEW.status,
        'reviewed_by', NEW.reviewed_by,
        'reviewed_at', NEW.reviewed_at,
        'rejection_reason', NEW.rejection_reason,
        'info_request', NEW.info_request,
        'converted_task_id', NEW.converted_task_id,
        'bundle_key', NEW.bundle_key,
        'created_at', NEW.created_at,
        'updated_at', NEW.updated_at
      ),
      'project', jsonb_build_object(
        'id', NEW.project_id,
        'name', coalesce((SELECT p.name FROM pm.projects p WHERE p.id = NEW.project_id), '')
      ),
      'project_id', NEW.project_id,
      'task_id', NEW.converted_task_id,
      'actor_id', pm.webhook_actor_id()
    )
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_suggestion_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_suggestion_webhook_insert ON pm.task_suggestions;
CREATE TRIGGER emit_suggestion_webhook_insert
  AFTER INSERT ON pm.task_suggestions
  FOR EACH ROW EXECUTE FUNCTION pm.emit_suggestion_webhook();

DROP TRIGGER IF EXISTS emit_suggestion_webhook_update ON pm.task_suggestions;
CREATE TRIGGER emit_suggestion_webhook_update
  AFTER UPDATE OF status ON pm.task_suggestions
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION pm.emit_suggestion_webhook();

-- ---------------------------------------------------------------------------
-- The outbox's own functions, now for every subject
-- ---------------------------------------------------------------------------
-- Invoice events honour the endpoint filters; their payloads are unchanged.
create or replace function pm.emit_invoice_webhook_event(
  p_row pm.project_invoices,
  p_event_type text,
  p_data jsonb default null
)
returns void
language plpgsql
security definer
set search_path = pm
as $$
declare
  v_is_paid boolean := (p_event_type <> 'invoice.deleted' and p_row.status = 'paid');
  v_project_name text;
  v_totals jsonb;
  v_public_id text;
  v_seq bigint;
  v_event_uuid uuid;
  v_payload jsonb;
begin
  -- An invoice concerns no member: an endpoint with a member filter never gets one.
  if not exists (
    select 1 from pm.webhook_endpoints e
    where pm.webhook_endpoint_matches(e, p_event_type, array[p_row.project_id], '{}')
  ) then
    return;
  end if;

  select name into v_project_name
  from pm.projects where id = p_row.project_id;

  select coalesce(jsonb_object_agg(t.item_type, t.subtotal), '{}'::jsonb)
    into v_totals
  from (
    select li->>'item_type' as item_type, sum((li->>'amount')::numeric) as subtotal
    from jsonb_array_elements(
           coalesce(nullif(p_row.line_items, 'null'::jsonb), '[]'::jsonb)
         ) li
    where li ? 'item_type'
    group by li->>'item_type'
  ) t;

  if v_totals = '{}'::jsonb then
    v_totals := jsonb_build_object(p_row.invoice_type, p_row.amount);
  end if;

  v_seq := nextval('pm.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  v_payload := jsonb_build_object(
    'id', v_public_id,
    'type', p_event_type,
    'sequence', v_seq,
    'created_at', now(),
    'data', jsonb_build_object(
      'invoice', jsonb_build_object(
        'id', p_row.id,
        'invoice_number', p_row.invoice_number,
        'project_id', p_row.project_id,
        'status', p_row.status,
        'paid', v_is_paid,
        'invoice_type', p_row.invoice_type,
        'amount', p_row.amount,
        'date', p_row.date,
        'due_date', p_row.due_date,
        'paid_date', p_row.paid_date,
        'description', p_row.description,
        'updated_at', p_row.updated_at
      ),
      'project', jsonb_build_object(
        'id', p_row.project_id,
        'name', coalesce(v_project_name, '')
      ),
      'line_items', coalesce(nullif(p_row.line_items, 'null'::jsonb), '[]'::jsonb),
      'totals_by_type', v_totals
    ) || coalesce(p_data, '{}'::jsonb)
  );

  insert into pm.webhook_events (
    event_id, sequence, event_type, resource_type, resource_id, payload, net_amounts
  )
  values (
    v_public_id, v_seq, p_event_type, 'invoice', p_row.id, v_payload,
    pm.invoice_net_amounts(p_row)
  )
  returning id into v_event_uuid;

  insert into pm.webhook_deliveries (webhook_event_id, endpoint_id)
  select v_event_uuid, e.id
  from pm.webhook_endpoints e
  where pm.webhook_endpoint_matches(e, p_event_type, array[p_row.project_id], '{}');
end;
$$;

revoke all on function pm.emit_invoice_webhook_event(pm.project_invoices, text, jsonb) from public, anon, authenticated;

-- The claim: Webhooks on is enough, except for invoice events, which also
-- need Client invoicing. Head of the line per subject and endpoint. Amount
-- basis applies to invoice events only.
CREATE OR REPLACE FUNCTION pm.claim_webhook_deliveries(p_limit int DEFAULT 20)
RETURNS TABLE (
  delivery_id uuid,
  attempt_token uuid,
  attempts int,
  endpoint_id uuid,
  endpoint_url text,
  endpoint_secret text,
  event_public_id text,
  event_type text,
  event_sequence bigint,
  resource_id uuid,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  max_attempts constant int := 8;  -- WEBHOOK_MAX_ATTEMPTS
  billing_on boolean;
BEGIN
  -- Nothing goes out while Webhooks is switched off, and no invoice event
  -- while Client invoicing is: those deliveries wait in order, their attempts
  -- untouched, and go out once the module is back on.
  IF NOT pm.module_enabled('webhooks') THEN
    RETURN;
  END IF;
  billing_on := pm.module_enabled('billing');

  -- One claimer at a time, so two runs cannot both pass the ordering check
  -- for the same subject. Released at commit, before any HTTP happens.
  PERFORM pg_advisory_xact_lock(hashtext('pm.claim_webhook_deliveries'));

  -- A lease that ran out on the last attempt has nothing left to retry.
  UPDATE pm.webhook_deliveries d
  SET status = 'failed',
      last_error = coalesce(d.last_error, 'Delivery did not finish before its lease expired'),
      attempt_token = NULL,
      lease_expires_at = NULL
  WHERE d.status = 'delivering'
    AND coalesce(d.lease_expires_at, '-infinity') <= now()
    AND d.attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT d.id
    FROM pm.webhook_deliveries d
    JOIN pm.webhook_events ev ON ev.id = d.webhook_event_id
    JOIN pm.webhook_endpoints ep ON ep.id = d.endpoint_id
    WHERE ep.is_active
      AND (billing_on OR ev.resource_type <> 'invoice')
      AND (
        (d.status = 'pending' AND d.next_attempt_at <= now())
        OR (d.status = 'delivering' AND coalesce(d.lease_expires_at, '-infinity') <= now())
      )
      -- Head of the line: nothing earlier for this subject (resource_type and
      -- resource_id: one invoice, one task, one question) and endpoint is
      -- still waiting, and nothing for it is in flight under a live lease.
      AND NOT EXISTS (
        SELECT 1
        FROM pm.webhook_deliveries other
        JOIN pm.webhook_events other_ev ON other_ev.id = other.webhook_event_id
        WHERE other.endpoint_id = d.endpoint_id
          AND other.id <> d.id
          AND other_ev.resource_type = ev.resource_type
          AND coalesce(other_ev.resource_id, other_ev.id) = coalesce(ev.resource_id, ev.id)
          AND (
            (other.status IN ('pending', 'delivering') AND other_ev.sequence < ev.sequence)
            OR (other.status = 'delivering' AND coalesce(other.lease_expires_at, '-infinity') > now())
          )
      )
    ORDER BY ev.sequence
    LIMIT p_limit
    FOR UPDATE OF d SKIP LOCKED
  )
  UPDATE pm.webhook_deliveries d
  SET status = 'delivering',
      attempts = d.attempts + 1,
      last_attempt_at = now(),
      attempt_token = gen_random_uuid(),
      lease_expires_at = now() + interval '2 minutes'
  FROM due, pm.webhook_events ev, pm.webhook_endpoints e
  WHERE d.id = due.id
    AND ev.id = d.webhook_event_id
    AND e.id = d.endpoint_id
  RETURNING d.id, d.attempt_token, d.attempts,
            e.id, e.url, e.secret,
            ev.event_id, ev.event_type, ev.sequence, ev.resource_id,
            -- Amount basis is an invoice matter; other events go out as recorded.
            CASE WHEN ev.resource_type = 'invoice'
              THEN pm.webhook_payload_for_endpoint(ev.payload, ev.net_amounts, e.amount_basis)
              ELSE ev.payload
            END;
END;
$$;

-- The retry kick: an invoice delivery is not due while Client invoicing is off.
CREATE OR REPLACE FUNCTION pm.webhook_retry_kick()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  app_url text;
  secret text;
BEGIN
  -- An invoice delivery waits while Client invoicing is off; it is not due.
  IF NOT EXISTS (
    SELECT 1
    FROM pm.webhook_deliveries d
    JOIN pm.webhook_endpoints e ON e.id = d.endpoint_id
    JOIN pm.webhook_events ev ON ev.id = d.webhook_event_id
    WHERE e.is_active
      AND (ev.resource_type <> 'invoice' OR pm.module_enabled('billing'))
      AND (
        (d.status = 'pending' AND d.next_attempt_at <= now())
        OR (d.status = 'delivering' AND coalesce(d.lease_expires_at, '-infinity') <= now())
      )
  ) THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO app_url FROM vault.decrypted_secrets WHERE name = 'pm_webhook_scheduler_url';
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name = 'pm_webhook_scheduler_secret';
  IF app_url IS NULL OR secret IS NULL THEN
    RAISE NOTICE 'webhook_scheduler_url or webhook_scheduler_secret is missing from Vault; webhook retries wait for the next in-app dispatch';
    RETURN NULL;
  END IF;

  RETURN net.http_post(
    url := rtrim(app_url, '/') || '/api/internal/webhooks/scheduled',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret),
    body := '{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;

REVOKE ALL ON FUNCTION pm.claim_webhook_deliveries(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pm.webhook_retry_kick() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION pm.claim_webhook_deliveries(int) TO service_role;

-- The retry job runs while Webhooks is on, Client invoicing or not.
-- Supabase only: skipped where pg_cron or pg_net is unavailable (PGlite).
-- Re-running cron.schedule updates the job in place.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS pg_net;
    PERFORM cron.schedule('pm-webhook-retries', '* * * * *', $job$SELECT pm.webhook_retry_kick() WHERE pm.module_enabled('webhooks');$job$);
  ELSE
    RAISE NOTICE 'pg_cron or pg_net is unavailable here; webhook retries will not be scheduled';
  END IF;
END;
$do$;
