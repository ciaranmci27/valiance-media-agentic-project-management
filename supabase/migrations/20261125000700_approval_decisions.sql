-- Approval decisions: whoever an approval names decides it, and how it was
-- decided is kept.
--
-- - pm.questions.decided_via: the door an approval was decided through.
--   app (signed in to the app), api_key (a person's own key that carries
--   approvals.decide), agent (an agent asked by name, with its own key) or
--   act_for (an agent acting for the person, with approvals.decide on its
--   key and held by the person too). Null on a plain question, on an
--   approval still open, and on one decided before this was recorded.
--   Written by the server only (members read questions, never write them).
-- - question.answered (and every question.* event) on an approval also
--   carries decided_via; a plain question's payload is unchanged.
-- - The permission approvals.decide is core (no module), so it has no
--   permission_modules row. Admins and members hold it on the API (Owners
--   hold every permission), so each person can add it to their own key on
--   purpose; no key carries it by default and no agent holds it. A connected
--   AI tool never decides an approval, whatever its scopes.
--
-- Additive and safe to run twice. The previous release's code never reads
-- or writes decided_via (its decisions leave it null) and reads the webhook
-- payloads it always did.

ALTER TABLE pm.questions ADD COLUMN IF NOT EXISTS decided_via text;

ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_decided_via_check;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_decided_via_check CHECK (
    decided_via IS NULL OR (decided_via IN ('app', 'api_key', 'agent', 'act_for') AND kind = 'approval')
  );

COMMENT ON COLUMN pm.questions.decided_via IS
  'How an approval was decided: app (signed in), api_key (the person''s own key with approvals.decide), agent (the agent asked, with its own key) or act_for (an agent acting for the person, with approvals.decide on its key and held by the person). Null on a plain question, an open approval, or one decided before this was recorded.';

-- approvals.decide: people hold it on the API (Owners hold every
-- permission), so each can add it to their own key on purpose. No agent
-- holds it by default, and no key carries it until its person adds it.
INSERT INTO pm.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'approvals.decide', 'api'),
  ('member', 'approvals.decide', 'api')
ON CONFLICT DO NOTHING;

-- The question.* events carry decided_via on an approval.
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
      ) || CASE WHEN NEW.kind = 'approval' THEN jsonb_build_object(
        'kind', NEW.kind,
        'action', NEW.action,
        'decision', CASE NEW.answer_choice WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' END,
        'decided_by', CASE WHEN NEW.status = 'answered' THEN NEW.answered_by END,
        'decided_via', CASE WHEN NEW.status = 'answered' THEN NEW.decided_via END
      ) ELSE '{}'::jsonb END
        || CASE WHEN NEW.asked_to_group IS NOT NULL THEN jsonb_build_object('asked_to_group', NEW.asked_to_group) ELSE '{}'::jsonb END
        || CASE WHEN NEW.principal_id IS NOT NULL THEN jsonb_build_object('principal_id', NEW.principal_id) ELSE '{}'::jsonb END,
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
