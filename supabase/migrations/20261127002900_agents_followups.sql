-- Follow-ups for agents (2.0.54): an announce comment counts as a send, and
-- the watchdog's alarm speaks plainly and reaches whoever a question was
-- asked of. Additive and safe to run twice; the previous release's code
-- works with it.

-- ---------------------------------------------------------------------------
-- One send from an agent, counted on its own
-- ---------------------------------------------------------------------------
-- A write that also reaches people (a task comment posted with notify) was
-- counted as a write by pm.agent_write_gate already; this counts it in the
-- send bucket too (send_rate_per_minute), across all the agent's keys.
-- Answers {"refused": null}, or send_rate_limited with its limit and
-- reset_at. An agent without a send rate answers at once. Server only.
CREATE OR REPLACE FUNCTION pm.agent_send_gate(p_agent_id uuid, p_window_seconds integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_limit integer;
  v_now timestamptz := clock_timestamp();
  v_window pm.agent_write_windows%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_window_seconds <= 0 THEN RAISE EXCEPTION 'Invalid window'; END IF;
  SELECT l.send_rate_per_minute INTO v_limit FROM pm.agent_limits l WHERE l.agent_id = p_agent_id;
  IF v_limit IS NULL THEN RETURN jsonb_build_object('refused', null); END IF;
  INSERT INTO pm.agent_write_windows (agent_id, bucket, window_start, request_count)
  VALUES (p_agent_id, 'send', v_now, 1)
  ON CONFLICT (agent_id, bucket) DO UPDATE
  SET window_start = CASE WHEN agent_write_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN v_now ELSE agent_write_windows.window_start END,
      request_count = CASE WHEN agent_write_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN 1 ELSE agent_write_windows.request_count + 1 END
  RETURNING * INTO v_window;
  IF v_window.request_count > v_limit THEN
    RETURN jsonb_build_object(
      'refused', 'send_rate_limited',
      'limit', v_limit,
      'reset_at', v_window.window_start + make_interval(secs => p_window_seconds));
  END IF;
  RETURN jsonb_build_object('refused', null);
END;
$$;

REVOKE ALL ON FUNCTION pm.agent_send_gate(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_send_gate(uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- The watchdog: plain words, and an expired ask reaches whoever was asked
-- ---------------------------------------------------------------------------
-- As before (every 5 minutes, each change made once), with three changes:
-- "<Agent> stopped responding. Its last check-in was 2 hours ago."; when it
-- comes back, a stopped-responding notice already read moves to done; and an
-- expired question or approval also tells the person it was asked of (or
-- the people of the group), once, as "<Asker>'s question to you expired
-- without an answer". Answers asked_told beside the rest.
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
  v_asked integer := 0;
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

      v_text := r.name || ' stopped responding. Its last check-in was ' || pm.watchdog_ago(r.reported_at) || ' ago.'
        || CASE cardinality(v_claims)
             WHEN 0 THEN ''
             WHEN 1 THEN ' Its claimed task went back to the queue.'
             ELSE ' Its ' || cardinality(v_claims) || ' claimed tasks went back to the queue.'
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
        -- The alarm is settled: one already read moves to done, so only "is back" stays.
        UPDATE pm.team_member_notifications SET done_at = now()
        WHERE entity_type = 'member' AND entity_id = r.id::text AND category = 'agent_offline'
          AND done_at IS NULL AND cleared_at IS NULL;
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
    SELECT q.id, q.kind, q.question, q.asked_by, q.asked_to, q.asked_to_group, q.project_id, q.task_id,
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
    -- Whoever it was asked of (a person, or a group's people) hears once
    -- too: the ask left their list when it expired.
    v_title := coalesce(nullif(btrim(r.asker_name), ''), 'A teammate') || '''s '
      || CASE WHEN r.kind = 'approval' THEN 'approval request to you expired without a decision' ELSE 'question to you expired without an answer' END;
    FOR v_person IN
      SELECT m.id FROM pm.team_members m
      WHERE m.role <> 'agent' AND coalesce(m.status, 'active') = 'active' AND m.id <> r.asked_by
        AND (m.id = r.asked_to
          OR (r.asked_to_group IS NOT NULL AND m.id IN (SELECT gm.member_id FROM pm.group_members gm WHERE gm.group_id = r.asked_to_group)))
      ORDER BY m.id
    LOOP
      PERFORM pm.upsert_notification(v_person, v_title, left(r.question, 500), v_link, 'question', r.id::text, 'question_expired', r.project_id, r.asked_by);
      v_asked := v_asked + 1;
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
    'asked_told', v_asked,
    'webhooks_failing', v_webhooks
  );
END;
$$;

REVOKE ALL ON FUNCTION pm.run_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.run_watchdog() TO service_role;
