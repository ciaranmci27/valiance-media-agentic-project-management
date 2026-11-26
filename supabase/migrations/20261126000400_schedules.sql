-- Schedules: one scheduler for recurring templates and repeating tasks.
--
-- - pm.schedules: kind template (runs a template on every date of its
--   recurrence, with its own project, role map, fill-in values, key date
--   offsets, create_initiative and skip_if_open) or kind task (makes the
--   next copy of a task: task_id is the newest copy in the series; mode
--   schedule makes it when the current copy falls due, after_done when the
--   current copy is completed). recurrence is jsonb ({ freq, interval,
--   weekdays, month_day, month_week, month_weekday }), worked out by the
--   app; timezone is an IANA zone. next_on is the next date (a template's
--   run date, or the due date of a task's next copy) and next_run_at the
--   instant it is due to run. run_as is whose rights each run uses. Never
--   removed (deleted_at). Server only.
-- - pm.schedule_occurrences: one row per date a schedule ran for, unique
--   on (schedule_id, scheduled_for) so an occurrence is never made twice,
--   with its outcome (created, skipped with a reason, failed with an
--   error) and attempts (a failure is retried once). Server only.
-- - pm.claim_schedule_occurrence: claims an occurrence by moving next_on
--   and next_run_at on only if they are still what the caller read, and
--   records it, in one transaction. Server only.
-- - pm.schedule_after_done: completing a task that an after_done repeat
--   follows marks the repeat due now.
-- - pm.schedules_kick, pg_cron pm-schedules-due every 5 minutes: while a
--   schedule is due, calls /api/internal/schedules/run with the app's
--   scheduler address and secret from Vault (the ones webhook retries use).
-- - Notifications may be about a schedule (entity_type schedule).
--
-- Additive and safe to run twice. The previous release's code never reads
-- or writes the new tables; the trigger touches only pm.schedules.

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  template_id uuid REFERENCES pm.task_templates(id),
  task_id uuid REFERENCES pm.tasks(id),
  project_id uuid NOT NULL REFERENCES pm.projects(id),
  recurrence jsonb NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  start_date date NOT NULL,
  end_date date,
  mode text NOT NULL DEFAULT 'schedule',
  role_members jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  key_date_offsets jsonb NOT NULL DEFAULT '{}'::jsonb,
  create_initiative boolean NOT NULL DEFAULT false,
  skip_if_open boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  paused_reason text,
  next_on date,
  next_run_at timestamptz,
  -- after_done: the day (in the schedule's zone) the current copy was completed.
  done_on date,
  last_run_at timestamptz,
  last_outcome text,
  last_reason text,
  run_as uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL
);

ALTER TABLE pm.schedules DROP CONSTRAINT IF EXISTS schedules_kind_check;
ALTER TABLE pm.schedules
  ADD CONSTRAINT schedules_kind_check CHECK (
    (kind = 'template' AND template_id IS NOT NULL AND task_id IS NULL AND mode = 'schedule')
    OR (kind = 'task' AND task_id IS NOT NULL AND template_id IS NULL)
  );
ALTER TABLE pm.schedules DROP CONSTRAINT IF EXISTS schedules_values_check;
ALTER TABLE pm.schedules
  ADD CONSTRAINT schedules_values_check CHECK (
    mode IN ('schedule', 'after_done')
    AND status IN ('active', 'paused', 'ended')
    AND (last_outcome IS NULL OR last_outcome IN ('created', 'skipped', 'failed'))
    AND jsonb_typeof(recurrence) = 'object'
    AND jsonb_typeof(role_members) = 'object'
    AND jsonb_typeof(field_values) = 'object'
    AND jsonb_typeof(key_date_offsets) = 'object'
    AND length(timezone) BETWEEN 1 AND 64
    AND (end_date IS NULL OR end_date >= start_date)
  );

COMMENT ON TABLE pm.schedules IS
  'Recurring work, one scheduler for two kinds: a template run on every date of a recurrence (kind template), or the next copy of a task (kind task: task_id is the newest copy; mode schedule makes it when the current copy falls due, after_done when it is completed). Worked out and run by the app (/api/internal/schedules/run, kicked by pg_cron pm-schedules-due). Never removed (deleted_at). Server only.';
COMMENT ON COLUMN pm.schedules.recurrence IS
  'How often: { "freq": daily|weekly|monthly, "interval", "weekdays" (weekly, 0 Sunday to 6 Saturday), "month_day" (monthly, 1 to 31, clamped to the month''s last day) or "month_week" (1 to 4, -1 last) with "month_weekday" }.';
COMMENT ON COLUMN pm.schedules.next_on IS
  'The next date: a template schedule''s next run date, or the due date of a task''s next copy. Null while waiting for a task to be completed (after_done) or once ended.';
COMMENT ON COLUMN pm.schedules.next_run_at IS
  'When the next occurrence is due to run (the start of a day in the schedule''s time zone, or now for a completed after_done task). A run claims it by moving it on (pm.claim_schedule_occurrence).';
COMMENT ON COLUMN pm.schedules.run_as IS
  'Whose rights each run uses, checked at run time: whoever set the schedule up or last changed what it makes. Losing them pauses the schedule.';
COMMENT ON COLUMN pm.schedules.key_date_offsets IS
  'Template schedules: days from the run date to each key date by key (default 0, the run date).';

-- What is due; a template's and a task's schedules; one live repeat per task.
CREATE INDEX IF NOT EXISTS idx_schedules_due ON pm.schedules (next_run_at) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_schedules_template ON pm.schedules (template_id) WHERE template_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_schedules_project ON pm.schedules (project_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_one_repeat_per_task ON pm.schedules (task_id) WHERE kind = 'task' AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.schedules;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.schedules
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.schedules;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.schedules
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

ALTER TABLE pm.schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.schedules FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.schedules TO service_role;

-- ---------------------------------------------------------------------------
-- Occurrences: each date a schedule ran for, once
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.schedule_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES pm.schedules(id),
  scheduled_for date NOT NULL,
  status text NOT NULL DEFAULT 'running',
  reason text,
  error text,
  attempts integer NOT NULL DEFAULT 1,
  -- The run a template schedule made, or the copy a task repeat made.
  run_id uuid REFERENCES pm.task_template_runs(id),
  task_id uuid REFERENCES pm.tasks(id),
  -- The copy a task repeat made it from.
  source_task_id uuid REFERENCES pm.tasks(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.schedule_occurrences DROP CONSTRAINT IF EXISTS schedule_occurrences_values_check;
ALTER TABLE pm.schedule_occurrences
  ADD CONSTRAINT schedule_occurrences_values_check CHECK (
    status IN ('running', 'created', 'skipped', 'failed')
    AND attempts BETWEEN 1 AND 10
    AND (reason IS NULL OR length(reason) <= 80)
    AND (error IS NULL OR length(error) <= 2000)
  );

COMMENT ON TABLE pm.schedule_occurrences IS
  'One row per date a schedule ran for, never two (unique schedule_id, scheduled_for): created (run_id or task_id), skipped (reason) or failed (error; retried once, then the schedule pauses). Never removed. Server only.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_occurrences_once ON pm.schedule_occurrences (schedule_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_schedule_occurrences_recent ON pm.schedule_occurrences (schedule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_occurrences_retry ON pm.schedule_occurrences (status) WHERE status IN ('failed', 'running');

DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.schedule_occurrences;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.schedule_occurrences
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.schedule_occurrences;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.schedule_occurrences
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

ALTER TABLE pm.schedule_occurrences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.schedule_occurrences FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.schedule_occurrences TO service_role;

-- ---------------------------------------------------------------------------
-- Claiming an occurrence
-- ---------------------------------------------------------------------------
-- Moves the schedule on to (p_next_on, p_next_run_at, p_status) only while
-- it is active and next_run_at is still p_expected_run_at, then records the
-- occurrence for p_scheduled_for. Answers its id, or null when another run
-- claimed it first (nothing changes) or the date already has an
-- occurrence (the schedule still moves on; nothing is made twice).
CREATE OR REPLACE FUNCTION pm.claim_schedule_occurrence(
  p_schedule_id uuid,
  p_expected_run_at timestamptz,
  p_scheduled_for date,
  p_next_on date,
  p_next_run_at timestamptz,
  p_status text DEFAULT 'active',
  p_source_task_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE pm.schedules
  SET next_on = p_next_on,
      next_run_at = p_next_run_at,
      status = coalesce(p_status, 'active'),
      done_on = NULL,
      updated_at = now()
  WHERE id = p_schedule_id
    AND status = 'active'
    AND deleted_at IS NULL
    AND next_run_at IS NOT DISTINCT FROM p_expected_run_at;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO pm.schedule_occurrences (schedule_id, scheduled_for, source_task_id)
  VALUES (p_schedule_id, p_scheduled_for, p_source_task_id)
  ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION pm.claim_schedule_occurrence(uuid, timestamptz, date, date, timestamptz, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.claim_schedule_occurrence(uuid, timestamptz, date, date, timestamptz, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- After done: completing the followed task makes its repeat due now
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.schedule_after_done()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  UPDATE pm.schedules s
  SET next_run_at = now(),
      done_on = (now() AT TIME ZONE s.timezone)::date,
      updated_at = now()
  WHERE s.kind = 'task'
    AND s.task_id = NEW.id
    AND s.mode = 'after_done'
    AND s.status = 'active'
    AND s.deleted_at IS NULL
    AND s.next_run_at IS NULL;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.schedule_after_done() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS schedule_after_done ON pm.tasks;
CREATE TRIGGER schedule_after_done
  AFTER UPDATE OF status ON pm.tasks
  FOR EACH ROW
  WHEN (NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done')
  EXECUTE FUNCTION pm.schedule_after_done();

-- ---------------------------------------------------------------------------
-- The kick: pg_cron wakes the app while a schedule is due
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.schedules_kick()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  app_url text;
  secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.schedules s
    WHERE s.status = 'active' AND s.deleted_at IS NULL AND s.next_run_at <= now()
  ) AND NOT EXISTS (
    SELECT 1 FROM pm.schedule_occurrences o
    JOIN pm.schedules s ON s.id = o.schedule_id
    WHERE s.status IN ('active', 'ended') AND s.deleted_at IS NULL
      AND ((o.status = 'failed' AND o.attempts < 2) OR (o.status = 'running' AND o.started_at < now() - interval '15 minutes'))
  ) THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO app_url FROM vault.decrypted_secrets WHERE name = 'pm_webhook_scheduler_url';
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name = 'pm_webhook_scheduler_secret';
  IF app_url IS NULL OR secret IS NULL THEN
    RAISE NOTICE 'webhook_scheduler_url or webhook_scheduler_secret is missing from Vault; schedules wait until the app sets up its scheduler';
    RETURN NULL;
  END IF;

  RETURN net.http_post(
    url := rtrim(app_url, '/') || '/api/internal/schedules/run',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret),
    body := '{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;

REVOKE ALL ON FUNCTION pm.schedules_kick() FROM PUBLIC, anon, authenticated, service_role;

-- Supabase only: skipped where pg_cron or pg_net is unavailable (PGlite).
-- Re-running cron.schedule updates the job in place.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS pg_net;
    PERFORM cron.schedule('pm-schedules-due', '*/5 * * * *', $job$SELECT pm.schedules_kick();$job$);
  ELSE
    RAISE NOTICE 'pg_cron or pg_net is unavailable here; schedules will not be kicked';
  END IF;
END;
$do$;

-- ---------------------------------------------------------------------------
-- Notifications about a schedule
-- ---------------------------------------------------------------------------
ALTER TABLE pm.team_member_notifications
  DROP CONSTRAINT IF EXISTS team_member_notifications_entity_type_check;
ALTER TABLE pm.team_member_notifications
  ADD CONSTRAINT team_member_notifications_entity_type_check
    CHECK (entity_type IN ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question', 'invoice', 'reminder', 'webhook', 'schedule'));
