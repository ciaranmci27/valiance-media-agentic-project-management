-- Questions: one generic way for any member (an agent or a person) to ask
-- another a question and get the answer back, on a task, on a project, or on
-- nothing at all.
--
-- - A question has a text (1 to 2000 characters), optional choices (1 to 10
--   short strings) and allow_other (free text allowed beside the choices).
-- - status: open, answered, cancelled or expired. An open question past its
--   expires_at reads as expired with no job: readers treat it so, and the
--   server stores 'expired' the next time it reads questions.
-- - On a task, project_id is always the task's project (set here, and kept
--   when the task moves to another project).
-- - Asking rings asked_to's bell (a 'question' notification linking to My
--   Tasks, where they answer it, since they may not be able to open its task);
--   answering, cancelling, expiring or moving the question to Trash clears
--   it, and reopening brings it back.
-- - Rows are never permanently deleted (deleted_at, deleted_by). Only the
--   server writes them; a signed-in member reads the questions they asked,
--   were asked, or that sit on a task or project they can open.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the table, and the new functions are trigger functions only.

CREATE TABLE IF NOT EXISTS pm.questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A task's question always carries its task's project (set by the trigger).
  project_id uuid REFERENCES pm.projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES pm.tasks(id) ON DELETE CASCADE,
  asked_by uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  asked_to uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  question text NOT NULL,
  choices jsonb,
  allow_other boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'open',
  answer_choice text,
  answer_text text,
  answered_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  answered_at timestamptz,
  cancelled_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never removed.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL
);

ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_question_length;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_question_length CHECK (length(btrim(question)) BETWEEN 1 AND 2000);
ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_status_check;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_status_check CHECK (status IN ('open', 'answered', 'cancelled', 'expired'));
ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_choices_shape;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_choices_shape CHECK (
    choices IS NULL OR (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) BETWEEN 1 AND 10));
ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_answer_choice_listed;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_answer_choice_listed CHECK (
    answer_choice IS NULL OR (choices IS NOT NULL AND choices ? answer_choice));
ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_answer_text_length;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_answer_text_length CHECK (answer_text IS NULL OR length(answer_text) BETWEEN 1 AND 5000);
ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_answered_has_answer;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_answered_has_answer CHECK (
    status <> 'answered' OR (answered_at IS NOT NULL AND (answer_choice IS NOT NULL OR answer_text IS NOT NULL)));
ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_task_has_project;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_task_has_project CHECK (task_id IS NULL OR project_id IS NOT NULL);

COMMENT ON TABLE pm.questions IS
  'A question one member asks another, on a task, a project or nothing, with optional choices. Written by the server only.';
COMMENT ON COLUMN pm.questions.allow_other IS
  'With choices: whether a free-text answer is allowed beside them. Without choices the answer is free text.';
COMMENT ON COLUMN pm.questions.expires_at IS
  'An open question past this time reads as expired; the server stores expired when it next reads questions.';

-- "Open questions to member X", and a task's or project's questions.
CREATE INDEX IF NOT EXISTS idx_questions_asked_to_open
  ON pm.questions (asked_to, created_at) WHERE status = 'open' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_questions_asked_by ON pm.questions (asked_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_task ON pm.questions (task_id, created_at) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_questions_project ON pm.questions (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_questions_expiring
  ON pm.questions (expires_at) WHERE status = 'open' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_questions_deleted_at ON pm.questions (deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Normalise every write: the task's project, and the fields a later write may
-- not change.
-- ---------------------------------------------------------------------------
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
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_question_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS questions_before_write ON pm.questions;
CREATE TRIGGER questions_before_write
  BEFORE INSERT OR UPDATE ON pm.questions
  FOR EACH ROW EXECUTE FUNCTION pm.handle_question_before_write();

DROP TRIGGER IF EXISTS set_questions_updated_at ON pm.questions;
CREATE TRIGGER set_questions_updated_at
  BEFORE UPDATE ON pm.questions
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

-- ---------------------------------------------------------------------------
-- Signals: asking rings asked_to's bell; a question that is no longer open
-- (answered, cancelled, expired, in Trash) takes its bell away, and one that
-- opens again brings it back.
-- ---------------------------------------------------------------------------
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
    'Question from ' || COALESCE(NULLIF(btrim(asker), ''), 'a teammate'),
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

DROP TRIGGER IF EXISTS notify_question_asked ON pm.questions;
CREATE TRIGGER notify_question_asked
  AFTER INSERT ON pm.questions
  FOR EACH ROW EXECUTE FUNCTION pm.notify_question_asked();

CREATE OR REPLACE FUNCTION pm.sync_question_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF NEW.status <> 'open' OR NEW.deleted_at IS NOT NULL THEN
    PERFORM pm.set_notifications_cleared('question', NEW.id::text, true);
  ELSIF OLD.status <> 'open' OR OLD.deleted_at IS NOT NULL THEN
    PERFORM pm.set_notifications_cleared('question', NEW.id::text, false);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.sync_question_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_question_notification ON pm.questions;
CREATE TRIGGER sync_question_notification
  AFTER UPDATE ON pm.questions
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  EXECUTE FUNCTION pm.sync_question_notification();

-- A task moved to another project takes its questions along.
CREATE OR REPLACE FUNCTION pm.sync_task_questions_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  UPDATE pm.questions SET project_id = NEW.project_id WHERE task_id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.sync_task_questions_project() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_sync_questions_project ON pm.tasks;
CREATE TRIGGER tasks_sync_questions_project
  AFTER UPDATE OF project_id ON pm.tasks
  FOR EACH ROW
  WHEN (NEW.project_id IS DISTINCT FROM OLD.project_id)
  EXECUTE FUNCTION pm.sync_task_questions_project();

-- Never permanently deleted.
DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.questions;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.questions
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.questions;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.questions
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

-- ---------------------------------------------------------------------------
-- Row level security: members read; only the server writes.
-- ---------------------------------------------------------------------------
ALTER TABLE pm.questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS questions_select ON pm.questions;
CREATE POLICY questions_select ON pm.questions FOR SELECT TO authenticated
  USING (
    asked_by = pm.current_team_member_id()
    OR asked_to = pm.current_team_member_id()
    OR (task_id IS NOT NULL AND pm.can_access_task(task_id))
    OR (task_id IS NULL AND project_id IS NOT NULL AND pm.can_access_project(project_id))
  );

DROP POLICY IF EXISTS questions_not_deleted ON pm.questions;
CREATE POLICY questions_not_deleted ON pm.questions AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);

DROP POLICY IF EXISTS questions_parent_live ON pm.questions;
CREATE POLICY questions_parent_live ON pm.questions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((task_id IS NULL OR pm.task_is_live(task_id)) AND (project_id IS NULL OR pm.project_is_live(project_id)));

REVOKE ALL ON pm.questions FROM anon, authenticated;
GRANT SELECT ON pm.questions TO authenticated;
GRANT ALL ON pm.questions TO service_role;

-- Live sync: open screens see questions asked and answered as it happens.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'questions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pm.questions;
  END IF;
END $$;
