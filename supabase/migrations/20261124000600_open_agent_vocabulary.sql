-- Open agent vocabulary: what any agent harness needs to record its own
-- events, ask for approval before acting, and see the tools it was set up
-- for, without a core change.
--
-- - Approvals are questions. pm.questions.kind is 'question' (every row so
--   far, and the default) or 'approval': an agent asks a person to approve
--   an action before it does it. An approval's choices are exactly
--   ["approve","reject"], it takes no free-text answer (answer_text is an
--   optional note beside the choice), and it carries action, a JSON object
--   with type and summary (and optional details). The bell, My Tasks, row
--   security, expiry and the question.* webhooks work as for any question;
--   the bell reads "Approval request from ...", and an approval's webhook
--   payload adds kind, action, decision (approved, rejected or null) and
--   decided_by. A plain question's notification and payload are unchanged.
--   kind and action never change after the row is written.
-- - Agent events: agent_activities.activity_type was a closed list. It is
--   now checked by shape (lowercase words joined by dots, at most three
--   parts), so the generic `note` and namespaced `custom.<namespace>.<name>`
--   events fit. Which types are accepted, and each payload, is checked in
--   code (src/lib/agent-events.ts). Every value stored today still fits.
-- - Agent profiles: team_members.agent_profile was a closed list. It is now
--   checked by shape, and the registry in code (core's profiles plus the
--   install's src/custom/agent-profiles.ts) decides which values are valid.
--   Every value stored today still fits.
--
-- Additive and safe to run twice. The previous release's code never writes
-- kind or action (so its questions read as kind 'question'), and only writes
-- activity types and profiles the new checks accept.

-- ---------------------------------------------------------------------------
-- Approvals
-- ---------------------------------------------------------------------------
ALTER TABLE pm.questions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'question',
  ADD COLUMN IF NOT EXISTS action jsonb;

ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_kind_check;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_kind_check CHECK (kind IN ('question', 'approval'));
ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_approval_shape;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_approval_shape CHECK (
    (kind = 'question' AND action IS NULL)
    OR (
      kind = 'approval'
      -- coalesce: a missing action, type, summary or choices is a refusal, never unknown.
      AND coalesce(
        jsonb_typeof(action) = 'object'
        AND jsonb_typeof(action->'type') = 'string'
        AND jsonb_typeof(action->'summary') = 'string'
        AND length(action::text) <= 8000
        AND choices = '["approve", "reject"]'::jsonb,
        false)
      AND NOT allow_other
    ));

COMMENT ON COLUMN pm.questions.kind IS
  'question, or approval: a person approves or rejects an action before an agent does it (choices approve and reject, answer_text a note).';
COMMENT ON COLUMN pm.questions.action IS
  'An approval''s action: { type, summary, details? }. Null on a plain question.';

-- kind and action are fixed once written, like asked_by.
CREATE OR REPLACE FUNCTION pm.handle_question_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  task_project uuid;
BEGIN
  NEW.question := btrim(NEW.question);
  IF NEW.task_id IS NOT NULL THEN
    SELECT project_id INTO task_project FROM pm.tasks WHERE id = NEW.task_id;
    IF task_project IS NOT NULL THEN
      NEW.project_id := task_project;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.asked_by := OLD.asked_by;
    NEW.created_at := OLD.created_at;
    NEW.kind := OLD.kind;
    NEW.action := OLD.action;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_question_before_write() FROM PUBLIC, anon, authenticated;

-- The bell: an approval says so; a plain question reads as before.
CREATE OR REPLACE FUNCTION pm.notify_question_asked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  asker text;
BEGIN
  IF NEW.status <> 'open' OR NEW.deleted_at IS NOT NULL OR NEW.asked_to = NEW.asked_by THEN
    RETURN NULL;
  END IF;
  SELECT name INTO asker FROM pm.team_members WHERE id = NEW.asked_by;
  PERFORM pm.upsert_notification(
    NEW.asked_to,
    CASE WHEN NEW.kind = 'approval' THEN 'Approval request from ' ELSE 'Question from ' END
      || COALESCE(NULLIF(btrim(asker), ''), 'a teammate'),
    left(NEW.question, 500),
    -- My Tasks, where the asked member answers it: they may not be able to
    -- open the task or project it is on.
    '/my-tasks',
    'question',
    NEW.id::text
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.notify_question_asked() FROM PUBLIC, anon, authenticated;

-- Webhooks: an approval's question also carries kind, action, decision and
-- decided_by. A plain question's payload is byte for byte what it was.
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
        'decided_by', CASE WHEN NEW.status = 'answered' THEN NEW.answered_by END
      ) ELSE '{}'::jsonb END,
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

-- ---------------------------------------------------------------------------
-- Agent events: checked by shape here, by vocabulary in code
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_activities DROP CONSTRAINT IF EXISTS agent_activities_activity_type_check;
ALTER TABLE pm.agent_activities
  ADD CONSTRAINT agent_activities_activity_type_check CHECK (
    activity_type ~ '^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,39}){0,2}$');

COMMENT ON COLUMN pm.agent_activities.activity_type IS
  'A typed event, note, custom.<namespace>.<name>, or a grandfathered legacy type. The vocabulary and each payload are checked in src/lib/agent-events.ts.';

-- ---------------------------------------------------------------------------
-- Agent profiles: checked by shape here, by the registry in code
-- ---------------------------------------------------------------------------
ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_agent_profile_check;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_agent_profile_check CHECK (agent_profile ~ '^[a-z][a-z0-9-]{0,39}$');

COMMENT ON COLUMN pm.team_members.agent_profile IS
  'Which MCP tools an agent sees: a core profile or one of the install''s (src/custom/agent-profiles.ts). Checked in code.';
