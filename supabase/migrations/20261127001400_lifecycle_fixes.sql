-- Lifecycle fixes: schedules, suspended members, the AI agents switch,
-- races, Change dates and data retention.
--
-- - pm.claim_schedule_occurrence: a date that made nothing (skipped, or
--   failed twice) is claimed again when the schedule comes back to it, so
--   resuming a schedule on a day it skipped makes that day's run, as the
--   resume answer says. A date that made its work (created, or still
--   running) is still never made twice.
-- - pm.clear_schedule_paused_notice: the "A schedule paused" notice clears
--   when its schedule is active again, ends or is removed (a later pause
--   raises it again).
-- - pm.schedules_kick: a schedule run by an agent is not due while the AI
--   agents module is off (the app holds it back too, claiming nothing), so
--   it runs when the module is on again.
-- - pm.team_member_permissions.given_with_key: a power an agent was given
--   beyond its role by making or editing its key; the app takes it away
--   again when no live key of the agent carries that scope.
-- - pm.questions.expired_reason, pm.close_asks_of_suspended_member: a
--   member who is suspended stops being asked. Their open questions and
--   approvals expire at once with expired_reason asked_member_suspended
--   (question.expired carries it), the asked bell clears, a run one of them
--   held runs again, and whoever asked is told (an agent's people, as the
--   watchdog tells them).
-- - pm.run_watchdog: while the AI agents module is off, runs do not time
--   out (agents cannot report then).
-- - pm.move_task_to_position: POST /api/v1/tasks/reorder in one
--   transaction, one at a time per sibling list, so positions stay unique.
-- - pm.save_task: one save at a time per task, so two "replace assignees"
--   at once leave one list, never both.
-- - pm.reflow_task_template_run: refuses while the run's initiative is in
--   Trash (initiative_in_trash), and moves the initiative's start date with
--   the earliest key date (p_initiative start_from, start_to), under the
--   same rule as its target: only while it still is the old date.
-- - pm.apply_data_retention: a finished run stays while any run in its tree
--   is unfinished or finished inside the window, so a recent run never
--   loses its lineage.
--
-- Additive and safe to run twice. The previous release's code calls every
-- function here with the same arguments and gets the same answer shape
-- (plus new fields), and never reads expired_reason.

-- ---------------------------------------------------------------------------
-- Claiming an occurrence: a date that made nothing is tried again
-- ---------------------------------------------------------------------------
-- Moves the schedule on to (p_next_on, p_next_run_at, p_status) only while
-- it is active and next_run_at is still p_expected_run_at, then records the
-- occurrence for p_scheduled_for. Answers its id, or null when another run
-- claimed it first (nothing changes) or the date already made its work (the
-- schedule still moves on; nothing is made twice). A date whose occurrence
-- made nothing (skipped, or failed on both tries) is reached again only by
-- resuming or changing the schedule: it is claimed again, from its first try.
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
  ON CONFLICT (schedule_id, scheduled_for) DO UPDATE
    SET status = 'running', reason = NULL, error = NULL, attempts = 1, run_id = NULL, task_id = NULL,
        source_task_id = EXCLUDED.source_task_id, started_at = now(), finished_at = NULL
    WHERE pm.schedule_occurrences.status = 'skipped'
       OR (pm.schedule_occurrences.status = 'failed' AND pm.schedule_occurrences.attempts >= 2)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION pm.claim_schedule_occurrence(uuid, timestamptz, date, date, timestamptz, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.claim_schedule_occurrence(uuid, timestamptz, date, date, timestamptz, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- The "A schedule paused" notice follows its schedule
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.clear_schedule_paused_notice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF NEW.status <> 'paused' OR NEW.deleted_at IS NOT NULL THEN
    PERFORM pm.set_notifications_cleared('schedule', NEW.id::text, true, 'A schedule paused');
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.clear_schedule_paused_notice() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS clear_schedule_paused_notice ON pm.schedules;
CREATE TRIGGER clear_schedule_paused_notice
  AFTER UPDATE OF status, deleted_at ON pm.schedules
  FOR EACH ROW
  WHEN (OLD.status = 'paused' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at))
  EXECUTE FUNCTION pm.clear_schedule_paused_notice();

-- ---------------------------------------------------------------------------
-- The kick: a schedule run by an agent waits while the AI agents module is off
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
  v_agents boolean := pm.module_enabled('agents');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.schedules s
    WHERE s.status = 'active' AND s.deleted_at IS NULL AND s.next_run_at <= now()
      AND (v_agents OR NOT EXISTS (
        SELECT 1 FROM pm.team_members m WHERE m.id = coalesce(s.run_as, s.created_by) AND m.role = 'agent'))
  ) AND NOT EXISTS (
    SELECT 1 FROM pm.schedule_occurrences o
    JOIN pm.schedules s ON s.id = o.schedule_id
    WHERE s.status IN ('active', 'ended') AND s.deleted_at IS NULL
      AND ((o.status = 'failed' AND o.attempts < 2) OR (o.status = 'running' AND o.started_at < now() - interval '15 minutes'))
      AND (v_agents OR NOT EXISTS (
        SELECT 1 FROM pm.team_members m WHERE m.id = coalesce(s.run_as, s.created_by) AND m.role = 'agent'))
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

-- ---------------------------------------------------------------------------
-- A power given to an agent with a key is marked as such
-- ---------------------------------------------------------------------------
-- Set by the server when making or editing an agent's key gives it a power
-- beyond its role. Taking that scope off the last live key carrying it takes
-- the power away again; an allow an Owner set in Team > Roles & permissions
-- (false) is never touched by a key edit.
ALTER TABLE pm.team_member_permissions ADD COLUMN IF NOT EXISTS given_with_key boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pm.team_member_permissions.given_with_key IS
  'True when making or editing an agent''s key gave it this power beyond its role: it goes again when no live key of the agent carries the scope.';

-- ---------------------------------------------------------------------------
-- A suspended member is no longer asked
-- ---------------------------------------------------------------------------
ALTER TABLE pm.questions ADD COLUMN IF NOT EXISTS expired_reason text;
ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_expired_reason_check;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_expired_reason_check CHECK (expired_reason IS NULL OR expired_reason IN ('asked_member_suspended'));

COMMENT ON COLUMN pm.questions.expired_reason IS
  'Why it expired before its time: asked_member_suspended (the member it was asked to was suspended). Null when its time ran out, or it did not expire.';

-- Their open questions and approvals expire now, saying why. Whoever asked
-- is told here, once (the watchdog mark keeps the watchdog from telling
-- them again): an agent's people (its owners, else the Owners), or the
-- person who asked.
CREATE OR REPLACE FUNCTION pm.close_asks_of_suspended_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  r record;
  v_people uuid[];
  v_person uuid;
  v_title text;
  v_link text;
BEGIN
  FOR r IN
    WITH closed AS (
      UPDATE pm.questions q
      SET status = 'expired', expires_at = now(), expired_reason = 'asked_member_suspended'
      WHERE q.asked_to = NEW.id AND q.status = 'open' AND q.deleted_at IS NULL
      RETURNING q.id, q.kind, q.question, q.asked_by, q.project_id, q.task_id
    )
    SELECT c.*, asker.name AS asker_name, asker.role AS asker_role
    FROM closed c JOIN pm.team_members asker ON asker.id = c.asked_by
  LOOP
    INSERT INTO pm.watchdog_marks (kind, subject_id, notified_at) VALUES ('question_expired', r.id, now())
    ON CONFLICT (kind, subject_id) DO NOTHING;
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
      || coalesce(nullif(btrim(NEW.name), ''), 'a teammate')
      || CASE WHEN r.kind = 'approval' THEN ' expired without a decision' ELSE ' expired without an answer' END
      || ': ' || coalesce(nullif(btrim(NEW.name), ''), 'they') || ' was suspended';
    FOREACH v_person IN ARRAY v_people LOOP
      CONTINUE WHEN v_person = NEW.id;
      PERFORM pm.upsert_notification(v_person, left(v_title, 200), left(r.question, 500), v_link, 'question', r.id::text);
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.close_asks_of_suspended_member() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS close_asks_of_suspended_member ON pm.team_members;
CREATE TRIGGER close_asks_of_suspended_member
  AFTER UPDATE OF status ON pm.team_members
  FOR EACH ROW
  WHEN (NEW.status = 'suspended' AND OLD.status IS DISTINCT FROM 'suspended')
  EXECUTE FUNCTION pm.close_asks_of_suspended_member();

-- question.expired says why, when it expired before its time (expired_reason).
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
        || CASE WHEN NEW.run_id IS NOT NULL THEN jsonb_build_object('run_id', NEW.run_id) ELSE '{}'::jsonb END
        || CASE WHEN NEW.expired_reason IS NOT NULL THEN jsonb_build_object('expired_reason', NEW.expired_reason) ELSE '{}'::jsonb END,
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
-- The watchdog: runs do not time out while the AI agents module is off
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
  -- While the AI agents module is off, agents cannot report, so nothing times out.
  IF pm.module_enabled('agents') THEN
    UPDATE pm.agent_runs run
    SET status = 'timed_out', finished_at = greatest(run.started_at, run.updated_at)
    WHERE (run.status = 'running' AND run.updated_at < now() - interval '2 hours')
       OR (run.status = 'waiting' AND run.updated_at < now() - interval '7 days'
           AND NOT pm.agent_run_has_open_question(run.id));
    GET DIAGNOSTICS v_runs = ROW_COUNT;
  END IF;

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
-- Reordering a task, one at a time per sibling list
-- ---------------------------------------------------------------------------
-- Moves a task to p_position among its siblings (a subtask's: its parent's
-- other subtasks; a top-level task's: the top-level tasks in its project and
-- status column), then numbers them 0, 1, 2... in that order, writing only
-- the rows that change. One move at a time per sibling list, so moves sent
-- together never leave two tasks on one position. Answers the task's new
-- position, or null when it is missing or in Trash.
CREATE OR REPLACE FUNCTION pm.move_task_to_position(p_task_id uuid, p_position integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_task pm.tasks%ROWTYPE;
  v_count integer;
  v_at integer;
BEGIN
  SELECT * INTO v_task FROM pm.tasks WHERE id = p_task_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pm.task_order'),
    hashtext(coalesce(v_task.parent_task_id::text, v_task.project_id::text || ':' || coalesce(v_task.status, ''))));
  -- Read again under the lock: another move may have changed it.
  SELECT * INTO v_task FROM pm.tasks WHERE id = p_task_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_count FROM pm.tasks t
  WHERE t.deleted_at IS NULL AND t.id <> p_task_id
    AND CASE WHEN v_task.parent_task_id IS NOT NULL THEN t.parent_task_id = v_task.parent_task_id
             ELSE t.parent_task_id IS NULL AND t.project_id = v_task.project_id AND t.status IS NOT DISTINCT FROM v_task.status END;
  v_at := least(greatest(coalesce(p_position, 0), 0), v_count);

  WITH siblings AS (
    SELECT t.id, (row_number() OVER (ORDER BY t.sort_order, t.created_at, t.id) - 1)::integer AS pos
    FROM pm.tasks t
    WHERE t.deleted_at IS NULL AND t.id <> p_task_id
      AND CASE WHEN v_task.parent_task_id IS NOT NULL THEN t.parent_task_id = v_task.parent_task_id
               ELSE t.parent_task_id IS NULL AND t.project_id = v_task.project_id AND t.status IS NOT DISTINCT FROM v_task.status END
  ), placed AS (
    SELECT s.id, CASE WHEN s.pos < v_at THEN s.pos ELSE s.pos + 1 END AS sort_order FROM siblings s
    UNION ALL
    SELECT p_task_id, v_at
  )
  UPDATE pm.tasks t SET sort_order = p.sort_order
  FROM placed p
  WHERE t.id = p.id AND t.sort_order IS DISTINCT FROM p.sort_order;

  RETURN v_at;
END;
$$;

REVOKE ALL ON FUNCTION pm.move_task_to_position(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.move_task_to_position(uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Saving a task: one save at a time per task
-- ---------------------------------------------------------------------------
-- As before: a task row and its assignees, criteria and blockers in one
-- transaction. SECURITY INVOKER, so every RLS policy still applies. p_task is
-- a column patch; a NULL list is left unchanged, an empty list clears it.
CREATE OR REPLACE FUNCTION pm.save_task(
  p_task_id uuid,
  p_task jsonb,
  p_assignee_ids uuid[] DEFAULT NULL,
  p_criteria text[] DEFAULT NULL,
  p_blocked_by uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pm
AS $$
DECLARE
  v_task_id uuid := p_task_id;
  v_payload jsonb := COALESCE(p_task, '{}'::jsonb);
  v_unknown text;
  v_cols text[];
  v_rows integer;
  v_task pm.tasks;
BEGIN
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'save_task: p_task must be a JSON object' USING ERRCODE = '22023';
  END IF;

  -- Same contract as a PostgREST update: an unknown column is an error, not
  -- a silently dropped field.
  SELECT key INTO v_unknown
  FROM jsonb_object_keys(v_payload) AS key
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'pm.tasks'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname = key
  )
  LIMIT 1;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'save_task: unknown task column "%"', v_unknown USING ERRCODE = '42703';
  END IF;

  -- One save at a time per task: two saves replacing its lists at once
  -- would each keep what the other added (each delete misses the other's
  -- uncommitted rows). Held to the end of the transaction.
  IF v_task_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('pm.save_task'), hashtext(v_task_id::text));
  END IF;

  SELECT array_agg(key ORDER BY key) INTO v_cols
  FROM jsonb_object_keys(v_payload) AS key
  WHERE key NOT IN ('id', 'created_at');

  IF v_task_id IS NULL THEN
    IF v_cols IS NULL THEN
      RAISE EXCEPTION 'save_task: a new task needs its columns' USING ERRCODE = '22023';
    END IF;
    EXECUTE format(
      'INSERT INTO pm.tasks (%s) SELECT %s FROM jsonb_populate_record(NULL::pm.tasks, $1) r RETURNING id',
      (SELECT string_agg(format('%I', c), ', ') FROM unnest(v_cols) c),
      (SELECT string_agg(format('r.%I', c), ', ') FROM unnest(v_cols) c)
    ) INTO v_task_id USING v_payload;
  ELSIF v_cols IS NOT NULL THEN
    EXECUTE format(
      'UPDATE pm.tasks t SET %s FROM jsonb_populate_record(NULL::pm.tasks, $1) r WHERE t.id = $2',
      (SELECT string_agg(format('%I = r.%I', c, c), ', ') FROM unnest(v_cols) c)
    ) USING v_payload, v_task_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    -- RLS turns a denied update into zero rows; that is a failure, not a save.
    IF v_rows = 0 THEN
      RAISE EXCEPTION 'save_task: task % not found or not permitted', v_task_id USING ERRCODE = 'P0002';
    END IF;
  ELSE
    PERFORM 1 FROM pm.tasks WHERE id = v_task_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'save_task: task % not found or not permitted', v_task_id USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF p_assignee_ids IS NOT NULL THEN
    DELETE FROM pm.task_assignees
    WHERE task_id = v_task_id AND NOT (member_id = ANY (p_assignee_ids));
    INSERT INTO pm.task_assignees (task_id, member_id)
    SELECT DISTINCT v_task_id, member_id FROM unnest(p_assignee_ids) AS member_id
    ON CONFLICT (task_id, member_id) DO NOTHING;
  END IF;

  IF p_criteria IS NOT NULL THEN
    DELETE FROM pm.task_acceptance_criteria WHERE task_id = v_task_id;
    INSERT INTO pm.task_acceptance_criteria (task_id, criterion, sort_order)
    SELECT v_task_id, c.criterion, (c.ordinality - 1)::int
    FROM unnest(p_criteria) WITH ORDINALITY AS c(criterion, ordinality);
  END IF;

  IF p_blocked_by IS NOT NULL THEN
    DELETE FROM pm.task_dependencies WHERE task_id = v_task_id;
    INSERT INTO pm.task_dependencies (task_id, blocked_by_task_id)
    SELECT DISTINCT v_task_id, blocked_by FROM unnest(p_blocked_by) AS blocked_by;
  END IF;

  SELECT * INTO v_task FROM pm.tasks WHERE id = v_task_id;
  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'criteria', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.sort_order)
      FROM pm.task_acceptance_criteria c
      WHERE c.task_id = v_task_id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION pm.save_task(uuid, jsonb, uuid[], text[], uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION pm.save_task(uuid, jsonb, uuid[], text[], uuid[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reflow: refused while the initiative is in Trash; its start follows too
-- ---------------------------------------------------------------------------
-- In one transaction: the run's key dates (refused when they changed since
-- the caller read them: run_changed; refused while the run's initiative is
-- in Trash: initiative_in_trash), each task in p_moves that is still not
-- done, not in Trash, and still due on its planned date (or forced: a
-- hand-changed task the caller opted in), its planned date with it, and the
-- initiative's dates: its target when it still is the old main key date,
-- its start when it still is the old earliest key date. p_moves is
-- [{ task_id, due_date, force }]; p_initiative is { id, from, to,
-- start_from, start_to } (each pair only when that date follows) or null.
-- Logs the change in the team activity log as whoever made it (a person;
-- agents keep their own log). Answers { moved: [task ids],
-- initiative_moved: boolean, initiative_start_moved: boolean }.
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
  v_start_moved boolean := false;
  v_initiative pm.initiatives%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM pm.task_template_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.key_dates IS DISTINCT FROM coalesce(p_expected, '{}'::jsonb) THEN
    RAISE EXCEPTION 'run_changed' USING ERRCODE = 'P0001';
  END IF;
  -- The run lives on its initiative: while that is in Trash, nothing moves.
  IF EXISTS (SELECT 1 FROM pm.initiatives i WHERE i.id = v_run.initiative_id AND i.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'initiative_in_trash' USING ERRCODE = 'P0001';
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

  IF p_initiative IS NOT NULL AND p_initiative ? 'id' AND (p_initiative ? 'to' OR NOT p_initiative ? 'start_to') THEN
    UPDATE pm.initiatives
    SET target_date = nullif(p_initiative ->> 'to', '')::date
    WHERE id = (p_initiative ->> 'id')::uuid
      AND deleted_at IS NULL
      AND target_date IS NOT DISTINCT FROM nullif(p_initiative ->> 'from', '')::date;
    v_initiative_moved := FOUND;
  END IF;
  -- Its start follows the earliest key date, under the same rule.
  IF p_initiative IS NOT NULL AND p_initiative ? 'id' AND p_initiative ? 'start_to' THEN
    UPDATE pm.initiatives
    SET start_date = nullif(p_initiative ->> 'start_to', '')::date
    WHERE id = (p_initiative ->> 'id')::uuid
      AND deleted_at IS NULL
      AND start_date IS NOT DISTINCT FROM nullif(p_initiative ->> 'start_from', '')::date;
    v_start_moved := FOUND;
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

  RETURN jsonb_build_object('moved', to_jsonb(v_moved), 'initiative_moved', v_initiative_moved, 'initiative_start_moved', v_start_moved);
END;
$$;

REVOKE ALL ON FUNCTION pm.reflow_task_template_run(uuid, jsonb, jsonb, date, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.reflow_task_template_run(uuid, jsonb, jsonb, date, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Data retention: a run tree goes together
-- ---------------------------------------------------------------------------
-- Daily. Up to 20 batches of 5,000 rows per kind per run, so a large
-- backlog is worked down over a few days without a long transaction. Answers
-- how many rows went (chat: how many texts were blanked). A finished run
-- stays while any run in its tree (its root and every run under it) is
-- unfinished or finished inside the window.
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
          -- The whole tree goes together: none of it while any run in it is
          -- unfinished or finished inside the window.
          AND NOT EXISTS (SELECT 1 FROM pm.agent_runs o
                          WHERE (o.id = coalesce(r.root_run_id, r.id) OR o.root_run_id = coalesce(r.root_run_id, r.id))
                            AND (o.finished_at IS NULL OR o.finished_at >= v_cutoff))
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
