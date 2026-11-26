-- Templates v2, live runs: changing a run's key dates (reflow) and runs an
-- agent drafts for a person to approve.
--
-- - pm.task_template_runs.key_dates becomes changeable: a reflow moves the
--   run's key dates, the due dates of its tasks nobody changed by hand, and
--   its initiative's target date, in one transaction
--   (pm.reflow_task_template_run, server only). Each change of key dates is
--   logged in the team activity log, as whoever made it, on the run's
--   initiative.
-- - pm.task_template_run_drafts: a run an agent (or anyone) proposes, with
--   the template as it was then (snapshot), what it proposes (key dates,
--   roles, values, the initiative, steps added and removed) and the approval
--   (pm.questions, kind approval) a person decides it with. The run itself
--   is recorded only when a person approves, through the one run path.
--   Server only.
-- - A draft expires when its approval expires or is withdrawn (a trigger on
--   pm.questions, so the watchdog's expiry counts too).
--
-- Additive and safe to run twice. The previous release's code never reads
-- the new table, never calls the new function, and its runs record as
-- before.

-- ---------------------------------------------------------------------------
-- Runs: key dates change with a reflow
-- ---------------------------------------------------------------------------
COMMENT ON TABLE pm.task_template_runs IS
  'One row per use of a task template: its version and snapshot, who ran it and how, the project, start date, fill-in values and the tasks it made. Never removed. Written by the server only; key_dates and start_date change only through a reflow (pm.reflow_task_template_run).';
COMMENT ON COLUMN pm.task_template_runs.key_dates IS
  'The date each key date is set to: { "start": "2026-12-01", "launch": "2027-01-15" }. A reflow changes it (logged in the team activity log). Empty for a run recorded before key dates existed (start_date is its start).';

-- ---------------------------------------------------------------------------
-- Drafts: a proposed run waiting for a person
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.task_template_run_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES pm.task_templates(id),
  -- The template as the draft saw it: { name, description, fields, items, key_dates, roles, guidance }.
  template_version integer NOT NULL,
  snapshot jsonb NOT NULL,
  project_id uuid NOT NULL REFERENCES pm.projects(id),
  -- What it proposes: { key_dates, roles, values, create_initiative, initiative, extra_steps, removed_steps }.
  proposal jsonb NOT NULL,
  -- Why, in the proposer's words.
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  proposed_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  -- The person the proposing agent acted for (X-Act-For, a personal agent's person).
  principal_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  -- The approval a person decides it with.
  question_id uuid REFERENCES pm.questions(id),
  decided_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  decided_at timestamptz,
  -- The run an approval made.
  run_id uuid REFERENCES pm.task_template_runs(id),
  -- The proposer's own key for this proposal: the same key again answers the same draft.
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL
);

ALTER TABLE pm.task_template_run_drafts DROP CONSTRAINT IF EXISTS task_template_run_drafts_status_check;
ALTER TABLE pm.task_template_run_drafts
  ADD CONSTRAINT task_template_run_drafts_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'expired'));
ALTER TABLE pm.task_template_run_drafts DROP CONSTRAINT IF EXISTS task_template_run_drafts_shape;
ALTER TABLE pm.task_template_run_drafts
  ADD CONSTRAINT task_template_run_drafts_shape CHECK (jsonb_typeof(snapshot) = 'object' AND jsonb_typeof(proposal) = 'object');
ALTER TABLE pm.task_template_run_drafts DROP CONSTRAINT IF EXISTS task_template_run_drafts_note_length;
ALTER TABLE pm.task_template_run_drafts
  ADD CONSTRAINT task_template_run_drafts_note_length CHECK (length(note) <= 2000);
ALTER TABLE pm.task_template_run_drafts DROP CONSTRAINT IF EXISTS task_template_run_drafts_idempotency_length;
ALTER TABLE pm.task_template_run_drafts
  ADD CONSTRAINT task_template_run_drafts_idempotency_length CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255);

COMMENT ON TABLE pm.task_template_run_drafts IS
  'A template run proposed for a person to approve: the template as it was (snapshot), what it proposes, and the approval (question_id) it is decided with. Approved, the run is made as whoever approved it (run_id). Expires with its approval. Written by the server only.';
COMMENT ON COLUMN pm.task_template_run_drafts.status IS
  'pending (waiting for a person), approved (run_id is the run it made), rejected, or expired (its approval expired or was withdrawn).';

-- A project's drafts by status, newest first; a draft by its approval; a proposer's key.
CREATE INDEX IF NOT EXISTS idx_task_template_run_drafts_project ON pm.task_template_run_drafts (project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_template_run_drafts_template ON pm.task_template_run_drafts (template_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_template_run_drafts_question ON pm.task_template_run_drafts (question_id) WHERE question_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_template_run_drafts_idempotency ON pm.task_template_run_drafts (proposed_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

DROP TRIGGER IF EXISTS set_task_template_run_drafts_updated_at ON pm.task_template_run_drafts;
CREATE TRIGGER set_task_template_run_drafts_updated_at
  BEFORE UPDATE ON pm.task_template_run_drafts
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

-- Never permanently deleted.
DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.task_template_run_drafts;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.task_template_run_drafts
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.task_template_run_drafts;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.task_template_run_drafts
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

-- Server only: no member policy, no member grant.
ALTER TABLE pm.task_template_run_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.task_template_run_drafts FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.task_template_run_drafts TO service_role;

-- A draft expires with its approval: expired (the watchdog, or a read that
-- stores it) or withdrawn (cancelled).
CREATE OR REPLACE FUNCTION pm.expire_task_template_run_drafts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  UPDATE pm.task_template_run_drafts
  SET status = 'expired', decided_at = now()
  WHERE question_id = NEW.id AND status = 'pending';
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.expire_task_template_run_drafts() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS expire_task_template_run_drafts ON pm.questions;
CREATE TRIGGER expire_task_template_run_drafts
  AFTER UPDATE OF status ON pm.questions
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND NEW.status IN ('expired', 'cancelled'))
  EXECUTE FUNCTION pm.expire_task_template_run_drafts();

-- ---------------------------------------------------------------------------
-- Reflow: new key dates, and the due dates that follow them
-- ---------------------------------------------------------------------------
-- In one transaction: the run's key dates (refused when they changed since
-- the caller read them: run_changed), each task in p_moves that is still
-- not done, not in Trash, and still due on its planned date (or forced: a
-- hand-changed task the caller opted in), its planned date with it, and the
-- initiative's target date when it still is the old main key date.
-- p_moves is [{ task_id, due_date, force }]; p_initiative is
-- { id, from, to } or null. Logs the change in the team activity log as
-- whoever made it (a person; agents keep their own log). Answers
-- { moved: [task ids], initiative_moved: boolean }.
CREATE OR REPLACE FUNCTION pm.reflow_task_template_run(
  p_run_id uuid,
  p_expected jsonb,
  p_key_dates jsonb,
  p_start_date date,
  p_moves jsonb,
  p_initiative jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_run pm.task_template_runs%ROWTYPE;
  v_moved uuid[];
  v_initiative_moved boolean := false;
  v_initiative pm.initiatives%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM pm.task_template_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.key_dates IS DISTINCT FROM coalesce(p_expected, '{}'::jsonb) THEN
    RAISE EXCEPTION 'run_changed' USING ERRCODE = 'P0001';
  END IF;

  WITH wanted AS (
    SELECT (m ->> 'task_id')::uuid AS task_id, (m ->> 'due_date')::date AS due_date, coalesce((m ->> 'force')::boolean, false) AS force
    FROM jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) AS m
  ),
  moved AS (
    UPDATE pm.tasks t
    SET due_date = to_char(w.due_date, 'YYYY-MM-DD')
    FROM wanted w, pm.task_template_run_tasks l
    WHERE t.id = w.task_id
      AND l.run_id = p_run_id AND l.task_id = t.id
      AND t.deleted_at IS NULL
      AND t.status <> 'done'
      AND (w.force OR left(t.due_date, 10) IS NOT DISTINCT FROM to_char(l.planned_due_date, 'YYYY-MM-DD'))
    RETURNING t.id, w.due_date
  ),
  planned AS (
    UPDATE pm.task_template_run_tasks l
    SET planned_due_date = moved.due_date
    FROM moved
    WHERE l.run_id = p_run_id AND l.task_id = moved.id
    RETURNING l.task_id
  )
  SELECT coalesce(array_agg(task_id), '{}') INTO v_moved FROM planned;

  UPDATE pm.task_template_runs
  SET key_dates = coalesce(p_key_dates, '{}'::jsonb), start_date = coalesce(p_start_date, start_date)
  WHERE id = p_run_id;

  IF p_initiative IS NOT NULL AND p_initiative ? 'id' THEN
    UPDATE pm.initiatives
    SET target_date = nullif(p_initiative ->> 'to', '')::date
    WHERE id = (p_initiative ->> 'id')::uuid
      AND deleted_at IS NULL
      AND target_date IS NOT DISTINCT FROM nullif(p_initiative ->> 'from', '')::date;
    v_initiative_moved := FOUND;
  END IF;

  IF v_run.key_dates IS DISTINCT FROM coalesce(p_key_dates, '{}'::jsonb) AND v_run.initiative_id IS NOT NULL THEN
    SELECT * INTO v_initiative FROM pm.initiatives WHERE id = v_run.initiative_id;
    IF FOUND THEN
      PERFORM pm.log_team_activity(
        'initiative.key_dates',
        'initiative',
        v_initiative.id::text,
        v_run.project_id,
        format('Changed the key dates of "%s"', v_initiative.name),
        jsonb_build_object(
          'initiative_id', v_initiative.id,
          'initiative_name', v_initiative.name,
          'run_id', v_run.id,
          'template_id', v_run.template_id,
          'from', v_run.key_dates,
          'to', coalesce(p_key_dates, '{}'::jsonb),
          'moved', coalesce(array_length(v_moved, 1), 0)
        )
      );
    END IF;
  END IF;

  RETURN jsonb_build_object('moved', to_jsonb(v_moved), 'initiative_moved', v_initiative_moved);
END;
$$;

REVOKE ALL ON FUNCTION pm.reflow_task_template_run(uuid, jsonb, jsonb, date, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.reflow_task_template_run(uuid, jsonb, jsonb, date, jsonb, jsonb) TO service_role;
