-- When time passes, something happens: a watchdog, and data that does not
-- pile up forever.
--
-- The watchdog (pm.run_watchdog, pg_cron pm-agent-watchdog, every 5 minutes)
-- turns what readers used to work out on their own into one stored change,
-- made once, with its webhook event and its bell:
-- - An agent whose heartbeat is older than its staleness rule (two missed
--   beats plus a minute, as status views read it) has stopped responding:
--   its owners (or, with none, the Owners) are told once, agent.offline goes
--   out, and agent.online with a short "is back" when it reports again (the
--   bell only when the first one rang). Paused agents are skipped, and so
--   are personal assistants, which tell their admins on their own path.
-- - A run with no update for two hours is stored as timed_out, so
--   run.finished goes out once (the rule readers already used). A run
--   waiting on a person (status waiting) is skipped while a question or
--   approval naming it is open; waiting with none, it gets seven days.
-- - An open question past expires_at is stored as expired, and
--   question.expired goes out (from the question trigger, so a read that
--   stores it first sends it too). Whoever asked hears once; for an agent,
--   its owners.
-- - A webhook endpoint failing 5 attempts in a row, or for 24 hours, tells
--   the Owners and whoever manages webhooks once. A success resets it and
--   clears that bell. Nothing is sent to the endpoint itself.
-- Markers live in pm.watchdog_marks (server only), so nothing repeats.
--
-- Webhook retries are on by default: the app turns them on once their
-- prerequisites are there, unless an Owner turned them off
-- (business_settings.webhook_retries_off, read by pm.webhook_retry_kick).
--
-- Retention (pm.apply_data_retention, pg_cron pm-retention, daily), from
-- settings on the business row, each nullable (null keeps forever):
-- webhook_retention_days (default 30: finished deliveries, then events no
-- delivery needs), agent_health_history_days (default 90, the newest row
-- per agent always stays), agent_activity_retention_days,
-- agent_run_retention_days and chat_retention_days (chat text is blanked;
-- the row, its dedupe key and thread stay). Nothing a pending delivery, an
-- unfinished run or an open delegation needs is touched. In batches.
--
-- A run can wait on a person: status waiting, neither finished nor
-- running. A question or approval naming the run (questions.run_id, the
-- asking agent's own unfinished run) makes it wait while it is open; when
-- the last one is answered, cancelled or expires, the run is running again
-- and its two hours start over. An agent may also set waiting itself.
-- run.updated goes out when an unfinished run changes status.
--
-- Additive and safe to run twice. 2.0.40 code reads and writes nothing new;
-- a run or question it would have read as timed out or expired now reads
-- the same from the stored row.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
ALTER TABLE pm.business_settings
  ADD COLUMN IF NOT EXISTS webhook_retention_days integer DEFAULT 30,
  ADD COLUMN IF NOT EXISTS agent_health_history_days integer DEFAULT 90,
  ADD COLUMN IF NOT EXISTS agent_activity_retention_days integer,
  ADD COLUMN IF NOT EXISTS agent_run_retention_days integer,
  ADD COLUMN IF NOT EXISTS chat_retention_days integer,
  ADD COLUMN IF NOT EXISTS webhook_retries_off boolean NOT NULL DEFAULT false;

ALTER TABLE pm.business_settings DROP CONSTRAINT IF EXISTS business_settings_retention_days_check;
ALTER TABLE pm.business_settings
  ADD CONSTRAINT business_settings_retention_days_check CHECK (
    (webhook_retention_days IS NULL OR webhook_retention_days BETWEEN 7 AND 3650)
    AND (agent_health_history_days IS NULL OR agent_health_history_days BETWEEN 7 AND 3650)
    AND (agent_activity_retention_days IS NULL OR agent_activity_retention_days BETWEEN 30 AND 3650)
    AND (agent_run_retention_days IS NULL OR agent_run_retention_days BETWEEN 30 AND 3650)
    AND (chat_retention_days IS NULL OR chat_retention_days BETWEEN 7 AND 3650)
  );

COMMENT ON COLUMN pm.business_settings.webhook_retention_days IS
  'How long delivered or failed webhook deliveries are kept (7 to 3650 days, default 30), and their events once no delivery needs them; null keeps them forever. pm.apply_data_retention, daily.';
COMMENT ON COLUMN pm.business_settings.agent_health_history_days IS
  'How long agent uptime history is kept (7 to 3650 days, default 90); the newest row per agent always stays. Null keeps it forever.';
COMMENT ON COLUMN pm.business_settings.agent_activity_retention_days IS
  'How long agent events are kept (30 to 3650 days); billing events always stay. Null (the default) keeps them forever.';
COMMENT ON COLUMN pm.business_settings.agent_run_retention_days IS
  'How long finished agent runs are kept (30 to 3650 days); a run a running run or an open delegation needs stays. Null (the default) keeps them forever.';
COMMENT ON COLUMN pm.business_settings.chat_retention_days IS
  'How long chat message text is kept (7 to 3650 days); after that the text is blanked and the row (dedupe key, thread) stays. Messages still waiting for their assistant keep it. Null (the default) keeps it forever.';
COMMENT ON COLUMN pm.business_settings.webhook_retries_off IS
  'An Owner turned webhook retries off: the app no longer turns them on by itself and pm.webhook_retry_kick sends nothing.';

-- Owner-only settings on the business row, now with retention and retries.
CREATE OR REPLACE FUNCTION pm.business_settings_owner_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND (NEW.auto_migrate IS DISTINCT FROM true OR NEW.owners_read_personal_inboxes IS DISTINCT FROM false
       OR NEW.agents_paused_at IS NOT NULL OR NEW.audit_retention_days IS NOT NULL OR NEW.audit_redact_keys <> '{}'
       OR NEW.connect_ai_enabled IS DISTINCT FROM true OR NEW.personal_key_lifetime_days IS NOT NULL
       OR NEW.sign_in_methods IS DISTINCT FROM 'both'
       OR NEW.webhook_retention_days IS DISTINCT FROM 30 OR NEW.agent_health_history_days IS DISTINCT FROM 90
       OR NEW.agent_activity_retention_days IS NOT NULL OR NEW.agent_run_retention_days IS NOT NULL
       OR NEW.chat_retention_days IS NOT NULL OR NEW.webhook_retries_off IS DISTINCT FROM false))
     OR (TG_OP = 'UPDATE' AND (NEW.auto_migrate IS DISTINCT FROM OLD.auto_migrate
       OR NEW.owners_read_personal_inboxes IS DISTINCT FROM OLD.owners_read_personal_inboxes
       OR NEW.agents_paused_at IS DISTINCT FROM OLD.agents_paused_at
       OR NEW.agents_paused_by IS DISTINCT FROM OLD.agents_paused_by
       OR NEW.audit_retention_days IS DISTINCT FROM OLD.audit_retention_days
       OR NEW.audit_redact_keys IS DISTINCT FROM OLD.audit_redact_keys
       OR NEW.connect_ai_enabled IS DISTINCT FROM OLD.connect_ai_enabled
       OR NEW.personal_key_lifetime_days IS DISTINCT FROM OLD.personal_key_lifetime_days
       OR NEW.sign_in_methods IS DISTINCT FROM OLD.sign_in_methods
       OR NEW.webhook_retention_days IS DISTINCT FROM OLD.webhook_retention_days
       OR NEW.agent_health_history_days IS DISTINCT FROM OLD.agent_health_history_days
       OR NEW.agent_activity_retention_days IS DISTINCT FROM OLD.agent_activity_retention_days
       OR NEW.agent_run_retention_days IS DISTINCT FROM OLD.agent_run_retention_days
       OR NEW.chat_retention_days IS DISTINCT FROM OLD.chat_retention_days
       OR NEW.webhook_retries_off IS DISTINCT FROM OLD.webhook_retries_off)) THEN
    IF COALESCE(pm.current_team_member_role(), '') <> 'owner' THEN
      RAISE EXCEPTION 'Only an Owner can change this setting' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.business_settings_owner_columns() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Notifications about a webhook endpoint
-- ---------------------------------------------------------------------------
ALTER TABLE pm.team_member_notifications
  DROP CONSTRAINT IF EXISTS team_member_notifications_entity_type_check;
ALTER TABLE pm.team_member_notifications
  ADD CONSTRAINT team_member_notifications_entity_type_check
    CHECK (entity_type IN ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question', 'invoice', 'reminder', 'webhook'));

-- ---------------------------------------------------------------------------
-- Markers: what the watchdog already did (server only)
-- ---------------------------------------------------------------------------
-- agent_offline: the agent is offline since `since` (its last report);
--   notified_at says its people were told, so "is back" rings too.
-- question_expired: whoever asked was told (kept two days, past the window).
-- webhook_failing: failed attempts in a row (`failures`) since `since`, the
--   last error in detail; notified_at once its people were told. A success
--   removes it.
CREATE TABLE IF NOT EXISTS pm.watchdog_marks (
  kind text NOT NULL,
  subject_id uuid NOT NULL,
  since timestamptz NOT NULL DEFAULT now(),
  failures integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  notified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, subject_id)
);

ALTER TABLE pm.watchdog_marks DROP CONSTRAINT IF EXISTS watchdog_marks_kind_check;
ALTER TABLE pm.watchdog_marks
  ADD CONSTRAINT watchdog_marks_kind_check CHECK (kind IN ('agent_offline', 'question_expired', 'webhook_failing'));

COMMENT ON TABLE pm.watchdog_marks IS
  'What pm.run_watchdog already did, so each change is made and told once: agents offline, expired questions told, failing webhook endpoints. Server only.';

ALTER TABLE pm.watchdog_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.watchdog_marks FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.watchdog_marks TO service_role;

-- What the jobs scan.
CREATE INDEX IF NOT EXISTS idx_questions_expired
  ON pm.questions (expires_at) WHERE status = 'expired';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_finished
  ON pm.webhook_deliveries (created_at) WHERE status IN ('succeeded', 'failed');
CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at
  ON pm.webhook_events (created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_finished
  ON pm.agent_runs (finished_at) WHERE status <> 'running';
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_text
  ON pm.chat_messages (created_at) WHERE text <> '';

-- ---------------------------------------------------------------------------
-- Small rules the watchdog shares
-- ---------------------------------------------------------------------------
-- Seconds without a report before an agent reads as offline: two missed
-- beats plus a minute, a minute when it never said (heartbeatStaleAfterSeconds).
CREATE OR REPLACE FUNCTION pm.heartbeat_stale_after_seconds(p_interval_seconds integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 2 * CASE WHEN p_interval_seconds > 0 THEN p_interval_seconds ELSE 60 END + 60
$$;

REVOKE ALL ON FUNCTION pm.heartbeat_stale_after_seconds(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.heartbeat_stale_after_seconds(integer) TO service_role;

-- "12 minutes", "3 hours", "2 days": how long ago, for a bell.
CREATE OR REPLACE FUNCTION pm.watchdog_ago(p_since timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN m < 2 THEN '1 minute'
    WHEN m < 120 THEN m || ' minutes'
    WHEN m < 2880 THEN (m / 60) || ' hours'
    ELSE (m / 1440) || ' days'
  END
  FROM (SELECT greatest(0, floor(extract(epoch FROM (now() - p_since)) / 60))::bigint AS m) elapsed
$$;

REVOKE ALL ON FUNCTION pm.watchdog_ago(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.watchdog_ago(timestamptz) TO service_role;

-- Who hears about an agent: its people owners and owner groups' people (and
-- a personal agent's person), else the active Owners.
CREATE OR REPLACE FUNCTION pm.agent_people_to_tell(p_agent_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  WITH named AS (
    SELECT o.member_id AS id FROM pm.agent_owners o WHERE o.agent_id = p_agent_id
    UNION
    SELECT gm.member_id FROM pm.agent_owner_groups g
    JOIN pm.group_members gm ON gm.group_id = g.group_id
    WHERE g.agent_id = p_agent_id
    UNION
    SELECT a.delegate_of FROM pm.team_members a WHERE a.id = p_agent_id AND a.delegate_of IS NOT NULL
  ), people AS (
    SELECT m.id FROM named JOIN pm.team_members m ON m.id = named.id
    WHERE m.role <> 'agent' AND coalesce(m.status, 'active') = 'active'
  )
  SELECT coalesce(
    (SELECT array_agg(id ORDER BY id) FROM people),
    (SELECT array_agg(m.id ORDER BY m.id) FROM pm.team_members m WHERE m.role = 'owner' AND coalesce(m.status, 'active') = 'active'),
    '{}'
  )
$$;

REVOKE ALL ON FUNCTION pm.agent_people_to_tell(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_people_to_tell(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- A run waiting on a person
-- ---------------------------------------------------------------------------
-- waiting: not finished (no finished_at), not running. Set by the agent
-- (PATCH status waiting), or by a question or approval naming the run while
-- it is open. Any later update from the agent brings it back to running (the
-- API); a finish from waiting is a finish. The watchdog skips it while a
-- question naming it is open; waiting with none, it times out after seven
-- days without an update.
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_status_check CHECK (status IN ('running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out'));
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_finished_when_done;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_finished_when_done CHECK ((status IN ('running', 'waiting')) = (finished_at IS NULL));

COMMENT ON COLUMN pm.agent_runs.status IS
  'running, waiting (on a person), succeeded, failed, cancelled or timed_out. The watchdog stores timed_out for a run running two hours past updated_at, or waiting seven days with no open question naming it; readers read it so until then.';

-- What the watchdog scans for waiting runs.
CREATE INDEX IF NOT EXISTS idx_agent_runs_waiting ON pm.agent_runs (updated_at) WHERE status = 'waiting';

-- The run a question or approval holds: the asking agent's own run. While it
-- is open the run waits on a person. Cleared only when the run is gone.
ALTER TABLE pm.questions ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES pm.agent_runs(id) ON DELETE SET NULL;
COMMENT ON COLUMN pm.questions.run_id IS
  'The run this question or approval holds (the asking agent''s own): while it is open, the run waits on a person. Fixed once asked.';
CREATE INDEX IF NOT EXISTS idx_questions_run_open ON pm.questions (run_id)
  WHERE run_id IS NOT NULL AND status = 'open' AND deleted_at IS NULL;

-- Whether an open question or approval (not past expires_at, not in Trash)
-- names the run. The watchdog and the run feed read it the same way. Only
-- while the AI agents module is on: with it off, no agent waits on anyone.
CREATE OR REPLACE FUNCTION pm.agent_run_has_open_question(p_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT pm.module_enabled('agents') AND EXISTS (
    SELECT 1 FROM pm.questions q
    WHERE q.run_id = p_run_id AND q.status = 'open' AND q.deleted_at IS NULL
      AND (q.expires_at IS NULL OR q.expires_at > now())
  );
$$;

REVOKE ALL ON FUNCTION pm.agent_run_has_open_question(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pm.agent_run_has_open_question(uuid) TO authenticated, service_role;

-- A question names only its asker's own run, and keeps it: a later write
-- may clear it (the run is gone) but never point it elsewhere.
CREATE OR REPLACE FUNCTION pm.guard_question_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id THEN
      NEW.run_id := OLD.run_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.run_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pm.agent_runs r WHERE r.id = NEW.run_id AND r.agent_id = NEW.asked_by) THEN
    RAISE EXCEPTION 'A question names only its asker''s own run'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'questions_run_is_askers';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.guard_question_run() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_question_run ON pm.questions;
CREATE TRIGGER guard_question_run
  BEFORE INSERT OR UPDATE OF run_id ON pm.questions
  FOR EACH ROW EXECUTE FUNCTION pm.guard_question_run();

-- Asked (or back from Trash) open, its run waits on a person. Answered,
-- cancelled, expired or moved to Trash, its run is running again once no
-- other open question names it; the write restarts its two hours.
CREATE OR REPLACE FUNCTION pm.sync_question_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_open_now boolean;
  v_open_before boolean;
BEGIN
  IF NEW.run_id IS NULL THEN
    RETURN NULL;
  END IF;
  v_open_now := NEW.status = 'open' AND NEW.deleted_at IS NULL;
  v_open_before := TG_OP = 'UPDATE' AND OLD.status = 'open' AND OLD.deleted_at IS NULL;
  IF v_open_now AND NOT v_open_before THEN
    UPDATE pm.agent_runs SET status = 'waiting'
    WHERE id = NEW.run_id AND status IN ('running', 'waiting');
  ELSIF v_open_before AND NOT v_open_now THEN
    UPDATE pm.agent_runs SET status = 'running'
    WHERE id = NEW.run_id AND status = 'waiting' AND NOT pm.agent_run_has_open_question(NEW.run_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.sync_question_run() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_question_run ON pm.questions;
CREATE TRIGGER sync_question_run
  AFTER INSERT OR UPDATE OF status, deleted_at ON pm.questions
  FOR EACH ROW EXECUTE FUNCTION pm.sync_question_run();

-- Every run write, as before, with waiting as unfinished: a finished run
-- stays as it finished; one that finishes gets its finish time.
CREATE OR REPLACE FUNCTION pm.handle_agent_run_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  task_project uuid;
BEGIN
  IF NEW.task_id IS NOT NULL THEN
    SELECT project_id INTO task_project FROM pm.tasks WHERE id = NEW.task_id;
    IF task_project IS NOT NULL THEN
      NEW.project_id := task_project;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.agent_id := OLD.agent_id;
    NEW.created_at := OLD.created_at;
    NEW.external_id := coalesce(OLD.external_id, NEW.external_id);
    -- A finished run stays as it finished, whoever writes: two finishes at
    -- once cannot both land. Its other details may still change.
    IF OLD.status NOT IN ('running', 'waiting') THEN
      NEW.status := OLD.status;
      NEW.finished_at := OLD.finished_at;
    END IF;
  END IF;
  IF NEW.status NOT IN ('running', 'waiting') AND NEW.finished_at IS NULL THEN
    NEW.finished_at := greatest(now(), NEW.started_at);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_agent_run_before_write() FROM PUBLIC, anon, authenticated;

-- Run webhooks: run.started, run.finished, and run.updated when an
-- unfinished run changes status (running to waiting, or back). The chain
-- rides along as before.
CREATE OR REPLACE FUNCTION pm.emit_agent_run_webhook()
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
    WHERE e.is_active AND e.events && ARRAY['run.started', 'run.updated', 'run.finished']
  ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_type := CASE WHEN NEW.status IN ('running', 'waiting') THEN 'run.started' ELSE 'run.finished' END;
  ELSIF OLD.status IN ('running', 'waiting') AND NEW.status NOT IN ('running', 'waiting') THEN
    v_type := 'run.finished';
  ELSIF OLD.status IN ('running', 'waiting') AND NEW.status IS DISTINCT FROM OLD.status THEN
    v_type := 'run.updated';
  END IF;
  IF v_type IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pm.emit_webhook_event(
    v_type,
    'run',
    NEW.id,
    ARRAY[NEW.project_id],
    ARRAY[NEW.agent_id],
    jsonb_build_object(
      'run', jsonb_build_object(
        'id', NEW.id,
        'agent_id', NEW.agent_id,
        'task_id', NEW.task_id,
        'project_id', NEW.project_id,
        'status', NEW.status,
        'title', NEW.title,
        'summary', NEW.summary,
        'model', NEW.model,
        'trigger', NEW.trigger,
        'tokens_in', NEW.tokens_in,
        'tokens_out', NEW.tokens_out,
        'cost_usd', NEW.cost_usd,
        'external_id', NEW.external_id,
        'external_url', NEW.external_url,
        'started_at', NEW.started_at,
        'finished_at', NEW.finished_at,
        'updated_at', NEW.updated_at
      ) || CASE WHEN NEW.parent_run_id IS NOT NULL
        THEN jsonb_build_object('parent_run_id', NEW.parent_run_id, 'root_run_id', NEW.root_run_id)
        ELSE '{}'::jsonb END,
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

REVOKE ALL ON FUNCTION pm.emit_agent_run_webhook() FROM PUBLIC, anon, authenticated;

-- The run feed, as before, reading timed_out by the watchdog's rule until
-- it stores it: running two hours past its last update, or waiting seven
-- days with no open question naming it.
CREATE OR REPLACE VIEW pm.agent_run_feed
WITH (security_invoker = true) AS
SELECT
  r.id,
  'run'::text AS source,
  r.agent_id,
  r.task_id,
  r.project_id,
  CASE
    WHEN r.status = 'running' AND r.updated_at < now() - interval '2 hours' THEN 'timed_out'
    WHEN r.status = 'waiting' AND r.updated_at < now() - interval '7 days' AND NOT pm.agent_run_has_open_question(r.id) THEN 'timed_out'
    ELSE r.status
  END AS status,
  NULL::text AS outcome,
  r.title,
  r.summary,
  r.model,
  r.trigger,
  r.started_at,
  r.finished_at,
  CASE WHEN r.finished_at IS NOT NULL THEN (extract(epoch FROM r.finished_at - r.started_at) * 1000)::bigint END AS duration_ms,
  r.tokens_in,
  r.tokens_out,
  r.cost_usd,
  r.external_id,
  r.external_url,
  r.started_at AS sort_at,
  r.updated_at
FROM pm.agent_runs r
UNION ALL
SELECT
  a.id,
  'turn'::text AS source,
  a.agent_id,
  NULL::uuid AS task_id,
  a.project_id,
  'succeeded'::text AS status,
  a.metadata->>'outcome' AS outcome,
  a.title,
  NULL::text AS summary,
  a.metadata->>'model' AS model,
  CASE WHEN a.metadata->>'origin' = 'directed' THEN 'chat' ELSE 'scheduled' END AS trigger,
  coalesce(pm.agent_analytics_ts(a.metadata->>'started_at'), a.created_at) AS started_at,
  coalesce(pm.agent_analytics_ts(a.metadata->>'finished_at'), a.created_at) AS finished_at,
  pm.agent_analytics_int(a.metadata->>'duration_ms') AS duration_ms,
  CASE WHEN a.metadata->>'tokens_scope' = 'turn' AND a.metadata->'tokens' ? 'input'
    THEN pm.agent_analytics_int(a.metadata->'tokens'->>'input') END AS tokens_in,
  CASE WHEN a.metadata->>'tokens_scope' = 'turn' AND a.metadata->'tokens' ? 'output'
    THEN pm.agent_analytics_int(a.metadata->'tokens'->>'output') END AS tokens_out,
  NULL::numeric AS cost_usd,
  a.metadata->>'source_turn_id' AS external_id,
  NULL::text AS external_url,
  a.created_at AS sort_at,
  a.created_at AS updated_at
FROM pm.agent_activities a
WHERE a.activity_type = 'turn.completed'
  AND a.agent_id IS NOT NULL
  AND a.metadata->>'run_id' IS NULL
  AND NOT (a.metadata->>'origin' = 'scheduled' AND coalesce(a.metadata->>'outcome', '') IN ('idle', 'skipped', 'waiting'));

-- ---------------------------------------------------------------------------
-- Webhook endpoint health: every attempt's outcome, counted
-- ---------------------------------------------------------------------------
-- After pm.complete_webhook_delivery (or a lease that ran out on the last
-- attempt) records an attempt: a success removes the endpoint's mark and
-- clears its "keeps failing" bell; a failure counts one more in a row.
CREATE OR REPLACE FUNCTION pm.track_webhook_endpoint_health()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF NEW.status = 'succeeded' THEN
    DELETE FROM pm.watchdog_marks WHERE kind = 'webhook_failing' AND subject_id = NEW.endpoint_id;
    IF FOUND THEN
      PERFORM pm.set_notifications_cleared('webhook', NEW.endpoint_id::text, true);
    END IF;
  ELSE
    INSERT INTO pm.watchdog_marks AS w (kind, subject_id, since, failures, detail, updated_at)
    VALUES ('webhook_failing', NEW.endpoint_id, now(), 1,
      jsonb_build_object('last_error', left(coalesce(NEW.last_error, 'HTTP ' || NEW.last_status_code, 'No response'), 300),
        'last_status_code', NEW.last_status_code), now())
    ON CONFLICT (kind, subject_id) DO UPDATE
      SET failures = w.failures + 1, detail = EXCLUDED.detail, updated_at = now();
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.track_webhook_endpoint_health() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS track_webhook_endpoint_health ON pm.webhook_deliveries;
CREATE TRIGGER track_webhook_endpoint_health
  AFTER UPDATE OF status ON pm.webhook_deliveries
  FOR EACH ROW
  WHEN (OLD.status = 'delivering' AND NEW.status IN ('pending', 'succeeded', 'failed'))
  EXECUTE FUNCTION pm.track_webhook_endpoint_health();

-- ---------------------------------------------------------------------------
-- question.expired: from the question trigger, so whoever stores the expiry
-- (the watchdog, or a read that gets there first) sends it once. A question
-- that holds a run carries its run_id.
-- ---------------------------------------------------------------------------
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
    WHERE e.is_active AND e.events && ARRAY['question.asked', 'question.answered', 'question.cancelled', 'question.expired']
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
      WHEN 'expired' THEN 'question.expired'
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
        || CASE WHEN NEW.principal_id IS NOT NULL THEN jsonb_build_object('principal_id', NEW.principal_id) ELSE '{}'::jsonb END
        || CASE WHEN NEW.run_id IS NOT NULL THEN jsonb_build_object('run_id', NEW.run_id) ELSE '{}'::jsonb END,
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
-- The watchdog
-- ---------------------------------------------------------------------------
-- Every 5 minutes. Each change is made once (a stored status, or a marker),
-- so a second run in a row does nothing. Answers what it did.
CREATE OR REPLACE FUNCTION pm.run_watchdog()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  r record;
  v_person uuid;
  v_people uuid[];
  v_claims uuid[];
  v_stale integer;
  v_tell boolean;
  v_text text;
  v_title text;
  v_link text;
  v_workspace_paused boolean;
  v_offline integer := 0;
  v_online integer := 0;
  v_runs integer := 0;
  v_questions integer := 0;
  v_told integer := 0;
  v_webhooks integer := 0;
BEGIN
  -- One watchdog at a time; a run that overlaps the last one waits for the next.
  IF NOT pg_try_advisory_xact_lock(hashtext('pm.run_watchdog')) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;

  -- Agents that stopped responding, and agents that came back.
  IF pm.module_enabled('agents') THEN
    SELECT coalesce(bool_or(s.agents_paused_at IS NOT NULL), false) INTO v_workspace_paused FROM pm.business_settings s;

    FOR r IN
      SELECT a.id, a.name, h.reported_at, h.expected_interval_seconds AS interval_seconds
      FROM pm.agent_health h
      JOIN pm.team_members a ON a.id = h.member_id
      WHERE a.role = 'agent'
        AND a.delegate_of IS NULL
        AND coalesce(a.status, 'active') = 'active'
        AND a.agent_paused_at IS NULL
        AND NOT v_workspace_paused
        AND h.reported_at < now() - make_interval(secs => pm.heartbeat_stale_after_seconds(h.expected_interval_seconds))
        AND NOT EXISTS (SELECT 1 FROM pm.watchdog_marks w WHERE w.kind = 'agent_offline' AND w.subject_id = a.id)
      ORDER BY h.reported_at
    LOOP
      v_stale := pm.heartbeat_stale_after_seconds(r.interval_seconds);
      -- Claims that ran out while it was silent: those tasks are free again.
      SELECT coalesce(array_agg(t.id ORDER BY t.id), '{}') INTO v_claims
      FROM pm.tasks t
      WHERE t.claimed_by = r.id AND t.claim_expires_at <= now() AND t.claim_expires_at > r.reported_at
        AND t.status <> 'done' AND t.deleted_at IS NULL;
      -- An agent silent long before the watchdog first saw it is marked
      -- without a bell: nobody needs news that old.
      v_tell := now() - r.reported_at <= make_interval(secs => v_stale) + interval '1 day';
      v_people := CASE WHEN v_tell THEN pm.agent_people_to_tell(r.id) ELSE '{}'::uuid[] END;

      INSERT INTO pm.watchdog_marks (kind, subject_id, since, detail, notified_at)
      VALUES ('agent_offline', r.id, r.reported_at, jsonb_build_object('released_task_ids', to_jsonb(v_claims)),
        CASE WHEN cardinality(v_people) > 0 THEN now() END);

      PERFORM pm.emit_webhook_event('agent.offline', 'agent', r.id, '{}'::uuid[], ARRAY[r.id], jsonb_build_object(
        'agent', jsonb_build_object('id', r.id, 'name', r.name, 'reported_at', r.reported_at,
          'expected_interval_seconds', r.interval_seconds, 'stale_after_seconds', v_stale),
        'offline_since', r.reported_at,
        'released_task_ids', to_jsonb(v_claims),
        'project', NULL, 'project_id', NULL, 'task_id', NULL, 'actor_id', NULL));

      v_text := r.name || ' stopped responding ' || pm.watchdog_ago(r.reported_at) || ' ago'
        || CASE cardinality(v_claims)
             WHEN 0 THEN '.'
             WHEN 1 THEN ', its claimed task went back to the queue.'
             ELSE ', its ' || cardinality(v_claims) || ' claimed tasks went back to the queue.'
           END;
      FOREACH v_person IN ARRAY v_people LOOP
        PERFORM pm.upsert_notification(v_person, r.name || ' stopped responding', v_text, '/agent/' || r.id, 'member', r.id::text);
      END LOOP;
      v_offline := v_offline + 1;
    END LOOP;

    FOR r IN
      SELECT w.subject_id AS id, w.since, w.notified_at, a.name, h.reported_at, h.expected_interval_seconds AS interval_seconds
      FROM pm.watchdog_marks w
      JOIN pm.team_members a ON a.id = w.subject_id
      JOIN pm.agent_health h ON h.member_id = w.subject_id
      WHERE w.kind = 'agent_offline'
        AND h.reported_at >= now() - make_interval(secs => pm.heartbeat_stale_after_seconds(h.expected_interval_seconds))
    LOOP
      DELETE FROM pm.watchdog_marks WHERE kind = 'agent_offline' AND subject_id = r.id;
      PERFORM pm.emit_webhook_event('agent.online', 'agent', r.id, '{}'::uuid[], ARRAY[r.id], jsonb_build_object(
        'agent', jsonb_build_object('id', r.id, 'name', r.name, 'reported_at', r.reported_at,
          'expected_interval_seconds', r.interval_seconds, 'stale_after_seconds', pm.heartbeat_stale_after_seconds(r.interval_seconds)),
        'offline_since', r.since,
        'project', NULL, 'project_id', NULL, 'task_id', NULL, 'actor_id', NULL));
      IF r.notified_at IS NOT NULL THEN
        FOREACH v_person IN ARRAY pm.agent_people_to_tell(r.id) LOOP
          PERFORM pm.upsert_notification(v_person, r.name || ' is back', r.name || ' is responding again.', '/agent/' || r.id, 'member', r.id::text);
        END LOOP;
      END IF;
      v_online := v_online + 1;
    END LOOP;

    -- An agent removed, or no longer reporting at all, has nothing to come back from.
    DELETE FROM pm.watchdog_marks w
    WHERE w.kind = 'agent_offline'
      AND NOT EXISTS (
        SELECT 1 FROM pm.team_members a JOIN pm.agent_health h ON h.member_id = a.id
        WHERE a.id = w.subject_id AND a.role = 'agent' AND coalesce(a.status, 'active') = 'active'
      );
  END IF;

  -- Open questions past their time: stored as expired (the same update a
  -- read makes), which sends question.expired and clears the asked bells.
  -- A run one of them held is running again, its clock restarted.
  UPDATE pm.questions SET status = 'expired'
  WHERE status = 'open' AND expires_at <= now();
  GET DIAGNOSTICS v_questions = ROW_COUNT;

  -- Runs with no update for two hours: stored as timed_out, which sends
  -- run.finished. The run ends at its last update. A run waiting on a
  -- person is skipped while a question naming it is open; waiting with
  -- none, it gets seven days.
  UPDATE pm.agent_runs run
  SET status = 'timed_out', finished_at = greatest(run.started_at, run.updated_at)
  WHERE (run.status = 'running' AND run.updated_at < now() - interval '2 hours')
     OR (run.status = 'waiting' AND run.updated_at < now() - interval '7 days'
         AND NOT pm.agent_run_has_open_question(run.id));
  GET DIAGNOSTICS v_runs = ROW_COUNT;

  -- Whoever asked hears once, however the expiry was stored, within a day.
  FOR r IN
    SELECT q.id, q.kind, q.question, q.asked_by, q.asked_to, q.project_id, q.task_id,
      asker.name AS asker_name, asker.role AS asker_role, coalesce(target.name, g.name) AS target_name
    FROM pm.questions q
    JOIN pm.team_members asker ON asker.id = q.asked_by
    LEFT JOIN pm.team_members target ON target.id = q.asked_to
    LEFT JOIN pm.groups g ON g.id = q.asked_to_group
    WHERE q.status = 'expired' AND q.deleted_at IS NULL AND q.expires_at > now() - interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM pm.watchdog_marks w WHERE w.kind = 'question_expired' AND w.subject_id = q.id)
    ORDER BY q.expires_at
  LOOP
    INSERT INTO pm.watchdog_marks (kind, subject_id, notified_at) VALUES ('question_expired', r.id, now());
    IF r.asker_role = 'agent' THEN
      v_people := pm.agent_people_to_tell(r.asked_by);
      v_title := r.asker_name || '''s ';
      v_link := '/agent/' || r.asked_by;
    ELSE
      SELECT coalesce(array_agg(m.id), '{}') INTO v_people FROM pm.team_members m
      WHERE m.id = r.asked_by AND coalesce(m.status, 'active') = 'active';
      v_title := 'Your ';
      v_link := '/my-tasks';
    END IF;
    IF r.task_id IS NOT NULL AND r.project_id IS NOT NULL THEN
      v_link := '/projects/' || r.project_id || '?task=' || r.task_id;
    END IF;
    v_title := v_title || CASE WHEN r.kind = 'approval' THEN 'approval request to ' ELSE 'question to ' END
      || coalesce(nullif(btrim(r.target_name), ''), 'a teammate')
      || CASE WHEN r.kind = 'approval' THEN ' expired without a decision' ELSE ' expired without an answer' END;
    FOREACH v_person IN ARRAY v_people LOOP
      -- Whoever was asked already knows.
      CONTINUE WHEN v_person IS NOT DISTINCT FROM r.asked_to;
      PERFORM pm.upsert_notification(v_person, v_title, left(r.question, 500), v_link, 'question', r.id::text);
      v_told := v_told + 1;
    END LOOP;
  END LOOP;
  DELETE FROM pm.watchdog_marks WHERE kind = 'question_expired' AND since < now() - interval '2 days';

  -- Webhook endpoints that keep failing: 5 attempts in a row, or failing for
  -- a day. Told once; a success resets it (track_webhook_endpoint_health).
  IF pm.module_enabled('webhooks') THEN
    FOR r IN
      SELECT w.subject_id AS id, w.detail, e.name
      FROM pm.watchdog_marks w
      JOIN pm.webhook_endpoints e ON e.id = w.subject_id
      WHERE w.kind = 'webhook_failing' AND w.notified_at IS NULL AND e.is_active
        AND (w.failures >= 5 OR w.since <= now() - interval '24 hours')
    LOOP
      UPDATE pm.watchdog_marks SET notified_at = now(), updated_at = now()
      WHERE kind = 'webhook_failing' AND subject_id = r.id;
      FOR v_person IN
        SELECT m.id FROM pm.team_members m
        WHERE m.role <> 'agent' AND coalesce(m.status, 'active') = 'active'
          AND (m.role = 'owner' OR pm.member_has_permission(m.id, 'webhooks.manage', 'app'))
        ORDER BY m.id
      LOOP
        PERFORM pm.upsert_notification(v_person, 'Webhook ' || r.name || ' keeps failing',
          'Last error: ' || coalesce(r.detail ->> 'last_error', 'unknown'), '/settings/developers#webhooks', 'webhook', r.id::text);
      END LOOP;
      v_webhooks := v_webhooks + 1;
    END LOOP;
  END IF;
  DELETE FROM pm.watchdog_marks w
  WHERE w.kind = 'webhook_failing'
    AND NOT EXISTS (SELECT 1 FROM pm.webhook_endpoints e WHERE e.id = w.subject_id);

  RETURN jsonb_build_object(
    'agents_offline', v_offline,
    'agents_online', v_online,
    'runs_timed_out', v_runs,
    'questions_expired', v_questions,
    'askers_told', v_told,
    'webhooks_failing', v_webhooks
  );
END;
$$;

REVOKE ALL ON FUNCTION pm.run_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.run_watchdog() TO service_role;

-- ---------------------------------------------------------------------------
-- Webhook retries: an Owner may turn them off
-- ---------------------------------------------------------------------------
-- As before, plus: nothing is sent while an Owner has retries turned off.
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
  IF EXISTS (SELECT 1 FROM pm.business_settings s WHERE s.webhook_retries_off) THEN
    RETURN NULL;
  END IF;
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

REVOKE ALL ON FUNCTION pm.webhook_retry_kick() FROM PUBLIC, anon, authenticated, service_role;

-- Turning retries on writes the scheduler secret twice: sealed in
-- pm.app_secrets for the app, and in Vault for pm.webhook_retry_kick. Both
-- writes happen here, in one transaction and one set-up at a time, so two
-- app servers turning retries on at once never leave the app and Vault with
-- different secrets (every kick would be refused). With p_replace false
-- (the app turning them on by itself) a secret saved first stands: nothing
-- changes and false comes back. pm.store_webhook_scheduler, made only where
-- Supabase Vault is, checks the address and the secret. Server only.
CREATE OR REPLACE FUNCTION pm.set_up_webhook_scheduler(p_url text, p_secret text, p_sealed text, p_member_id uuid DEFAULT NULL, p_replace boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pm.set_up_webhook_scheduler'));
  IF NOT coalesce(p_replace, true) AND EXISTS (SELECT 1 FROM pm.app_secrets WHERE name = 'webhook_scheduler_secret') THEN
    RETURN false;
  END IF;
  INSERT INTO pm.app_secrets (name, value, updated_at, updated_by)
  VALUES ('webhook_scheduler_secret', p_sealed, now(), p_member_id)
  ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  PERFORM pm.store_webhook_scheduler(p_url, p_secret);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION pm.set_up_webhook_scheduler(text, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.set_up_webhook_scheduler(text, text, text, uuid, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
-- Runs are never deleted by hand; only the retention job removes old ones.
CREATE OR REPLACE FUNCTION pm.agent_runs_forbid_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF coalesce(current_setting('pm.data_retention', true), '') = 'on' AND current_user NOT IN ('anon', 'authenticated') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Rows in % are never permanently deleted. Move them to Trash instead.', TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'Old runs go only through the retention job (agent_run_retention_days).';
END;
$$;

REVOKE ALL ON FUNCTION pm.agent_runs_forbid_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.agent_runs;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.agent_runs_forbid_delete();

-- The lineage guard (pm.stamp_run_lineage, 20261125000100) keeps a run's
-- parent and root as they were made, with one exception: a link cleared
-- because the run it named is gone. Retention deleting an old parent or
-- root clears the link on its newer children (ON DELETE SET NULL); before,
-- the guard put the old id back, the foreign key failed and the whole
-- retention run rolled back.
CREATE OR REPLACE FUNCTION pm.stamp_run_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_parent record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (NEW.parent_run_id IS NULL AND OLD.parent_run_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM pm.agent_runs r WHERE r.id = OLD.parent_run_id)) THEN
      NEW.parent_run_id := OLD.parent_run_id;
    END IF;
    IF NOT (NEW.root_run_id IS NULL AND OLD.root_run_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM pm.agent_runs r WHERE r.id = OLD.root_run_id)) THEN
      NEW.root_run_id := OLD.root_run_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_run_id IS NULL THEN
    NEW.root_run_id := NULL;
    RETURN NEW;
  END IF;
  SELECT r.id, r.root_run_id, r.principal_id INTO v_parent FROM pm.agent_runs r WHERE r.id = NEW.parent_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The parent run does not exist' USING ERRCODE = '23503';
  END IF;
  NEW.root_run_id := coalesce(v_parent.root_run_id, v_parent.id);
  IF NEW.principal_id IS NULL THEN
    NEW.principal_id := v_parent.principal_id;
  ELSIF NEW.principal_id IS DISTINCT FROM v_parent.principal_id THEN
    RAISE EXCEPTION 'new row for relation "agent_runs" violates check constraint "agent_runs_principal_carried"'
      USING ERRCODE = '23514', DETAIL = 'A child run acts for the same person as its parent.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.stamp_run_lineage() FROM PUBLIC, anon, authenticated;

-- Daily. Up to 20 batches of 5,000 rows per kind per run, so a large
-- backlog is worked down over a few days without a long transaction. Answers
-- how many rows went (chat: how many texts were blanked).
CREATE OR REPLACE FUNCTION pm.apply_data_retention()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  batch constant integer := 5000;
  max_rounds constant integer := 20;
  s record;
  v_cutoff timestamptz;
  v_n integer;
  v_round integer;
  v_deliveries integer := 0;
  v_events integer := 0;
  v_health integer := 0;
  v_activities integer := 0;
  v_runs integer := 0;
  v_chat integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('pm.apply_data_retention')) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;
  SELECT webhook_retention_days, agent_health_history_days, agent_activity_retention_days,
    agent_run_retention_days, chat_retention_days
  INTO s FROM pm.business_settings LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;

  -- Webhooks: finished deliveries, then events no delivery needs any more.
  IF s.webhook_retention_days IS NOT NULL THEN
    v_cutoff := now() - make_interval(days => s.webhook_retention_days);
    v_round := 0;
    LOOP
      DELETE FROM pm.webhook_deliveries WHERE id IN (
        SELECT d.id FROM pm.webhook_deliveries d
        WHERE d.status IN ('succeeded', 'failed') AND d.created_at < v_cutoff
        LIMIT batch);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_deliveries := v_deliveries + v_n;
      v_round := v_round + 1;
      EXIT WHEN v_n < batch OR v_round >= max_rounds;
    END LOOP;
    v_round := 0;
    LOOP
      DELETE FROM pm.webhook_events WHERE id IN (
        SELECT ev.id FROM pm.webhook_events ev
        WHERE ev.created_at < v_cutoff
          AND NOT EXISTS (SELECT 1 FROM pm.webhook_deliveries d WHERE d.webhook_event_id = ev.id)
        LIMIT batch);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_events := v_events + v_n;
      v_round := v_round + 1;
      EXIT WHEN v_n < batch OR v_round >= max_rounds;
    END LOOP;
  END IF;

  -- Uptime history: the newest row per agent stays, so its state is known.
  IF s.agent_health_history_days IS NOT NULL THEN
    v_cutoff := now() - make_interval(days => s.agent_health_history_days);
    v_round := 0;
    LOOP
      DELETE FROM pm.agent_health_history WHERE id IN (
        SELECT h.id FROM pm.agent_health_history h
        WHERE h.changed_at < v_cutoff
          AND EXISTS (SELECT 1 FROM pm.agent_health_history newer
                      WHERE newer.member_id = h.member_id AND newer.changed_at > h.changed_at)
        LIMIT batch);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_health := v_health + v_n;
      v_round := v_round + 1;
      EXIT WHEN v_n < batch OR v_round >= max_rounds;
    END LOOP;
  END IF;

  -- Agent events: billing events (what agent time was billed from) stay.
  IF s.agent_activity_retention_days IS NOT NULL THEN
    v_cutoff := now() - make_interval(days => s.agent_activity_retention_days);
    v_round := 0;
    LOOP
      DELETE FROM pm.agent_activities WHERE id IN (
        SELECT a.id FROM pm.agent_activities a
        WHERE a.created_at < v_cutoff AND a.activity_type NOT LIKE 'billing.%'
        LIMIT batch);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_activities := v_activities + v_n;
      v_round := v_round + 1;
      EXIT WHEN v_n < batch OR v_round >= max_rounds;
    END LOOP;
  END IF;

  -- Finished runs, unless an unfinished run, an open delegation or a pending
  -- delivery still needs them.
  IF s.agent_run_retention_days IS NOT NULL THEN
    v_cutoff := now() - make_interval(days => s.agent_run_retention_days);
    PERFORM set_config('pm.data_retention', 'on', true);
    v_round := 0;
    LOOP
      DELETE FROM pm.agent_runs WHERE id IN (
        SELECT r.id FROM pm.agent_runs r
        WHERE r.status <> 'running' AND r.finished_at < v_cutoff
          AND NOT EXISTS (SELECT 1 FROM pm.agent_runs c
                          WHERE (c.parent_run_id = r.id OR c.root_run_id = r.id) AND c.status IN ('running', 'waiting'))
          AND NOT EXISTS (SELECT 1 FROM pm.task_delegations dl JOIN pm.tasks t ON t.id = dl.task_id
                          WHERE dl.run_id = r.id AND t.status <> 'done' AND t.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM pm.webhook_events ev JOIN pm.webhook_deliveries d ON d.webhook_event_id = ev.id
                          WHERE ev.resource_type = 'run' AND ev.resource_id = r.id AND d.status IN ('pending', 'delivering'))
        LIMIT batch);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_runs := v_runs + v_n;
      v_round := v_round + 1;
      EXIT WHEN v_n < batch OR v_round >= max_rounds;
    END LOOP;
    PERFORM set_config('pm.data_retention', 'off', true);
  END IF;

  -- Chat text is blanked, the row stays: its dedupe key (a provider retry,
  -- the one on-hold notice) and its place in the thread still count. A
  -- message still waiting for its assistant, or for a delivery, keeps it.
  IF s.chat_retention_days IS NOT NULL THEN
    v_cutoff := now() - make_interval(days => s.chat_retention_days);
    v_round := 0;
    LOOP
      UPDATE pm.chat_messages SET text = '' WHERE id IN (
        SELECT m.id FROM pm.chat_messages m
        WHERE m.text <> '' AND m.created_at < v_cutoff
          AND NOT (m.direction = 'inbound' AND m.status IN ('pending', 'notified'))
          AND NOT EXISTS (SELECT 1 FROM pm.webhook_events ev JOIN pm.webhook_deliveries d ON d.webhook_event_id = ev.id
                          WHERE ev.resource_type = 'chat_message' AND ev.resource_id = m.id AND d.status IN ('pending', 'delivering'))
        LIMIT batch);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_chat := v_chat + v_n;
      v_round := v_round + 1;
      EXIT WHEN v_n < batch OR v_round >= max_rounds;
    END LOOP;
  END IF;

  IF v_deliveries + v_events + v_health + v_activities + v_runs + v_chat > 0 THEN
    INSERT INTO pm.api_audit_log (method, endpoint, entity_type, request_body, status_code, via)
    VALUES ('DELETE', '/app/data/retention', 'business_settings', jsonb_build_object(
      'webhook_deliveries', v_deliveries, 'webhook_events', v_events, 'agent_health_history', v_health,
      'agent_activities', v_activities, 'agent_runs', v_runs, 'chat_texts', v_chat), 200, 'app');
  END IF;
  RETURN jsonb_build_object(
    'webhook_deliveries', v_deliveries,
    'webhook_events', v_events,
    'agent_health_history', v_health,
    'agent_activities', v_activities,
    'agent_runs', v_runs,
    'chat_texts', v_chat
  );
END;
$$;

REVOKE ALL ON FUNCTION pm.apply_data_retention() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.apply_data_retention() TO service_role;

-- ---------------------------------------------------------------------------
-- Schedules. Skipped where pg_cron is unavailable (PGlite). Re-running
-- cron.schedule updates a job in place.
-- ---------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is unavailable here; run SELECT pm.run_watchdog() every 5 minutes and SELECT pm.apply_data_retention() daily';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('pm-agent-watchdog', '*/5 * * * *', $job$SELECT pm.run_watchdog();$job$);
  PERFORM cron.schedule('pm-retention', '47 3 * * *', $job$SELECT pm.apply_data_retention();$job$);
END;
$do$;
