-- Agent event pipeline: every agent event labelled, exportable to a data
-- system in order, and analytics that stay right across providers and at
-- scale.
--
-- - Labels: agent_activities.labels, up to 20 per event, each lowercase
--   letters, numbers and . _ : - (starting with a letter or number), at most
--   64 characters. The agent or its harness sets them; the app never guesses
--   one. pm.edit_agent_activity_labels adds and removes them after the fact
--   in one locked step. A GIN index serves label filters.
-- - Change order: agent_activities and agent_runs carry seq (one shared
--   sequence, a new number on every insert and update) and change_txid (the
--   writing transaction). pm.agent_event_export pages both tables in
--   (change_txid, seq) order and only past transactions that have finished,
--   so a resumed export never skips a row that committed late and never
--   repeats one that did not change. Rows written before this migration are
--   numbered in creation order, in batches, with change_txid 0.
-- - agent_runs.provider: the provider a run used, when the harness says.
-- - Webhook agent_event.created: opt-in per endpoint, with the endpoint's
--   member filter as the agent filter and agent_event_types as the type
--   filter (null: every type). One look at webhook_endpoints per event while
--   no endpoint subscribes; nothing is written for an event no endpoint
--   matches.
-- - pm.agent_analytics_window_v2: the window with usage summed per agent,
--   project, hour, model, provider and labels, priced and unpriced usage
--   kept apart, turns carrying run_id and their own tokens, and events
--   carrying labels. pm.agent_analytics_window stays exactly as it was for
--   the previous release's screens.
-- - pm.agent_run_stats: runs per agent, project, model, provider and day,
--   with success, failure and busy time (the union of each agent's spans),
--   read as the caller. pm.agent_question_stats: questions per agent,
--   project and day with their answer times, over the projects the caller
--   can open, plus questions on no project only for an Owner or
--   agents.manage, and the caller's own.
-- - pm.provider_plans: what a provider's subscription costs a month, set by
--   an Owner, so analytics can show an estimate beside measured cost.
-- - Permission agent_events.export (AI agents module): GET
--   /api/v1/agent-events/export. No role holds it by default.
--
-- Additive and safe to run twice. The previous release's code never reads
-- the new columns, functions or table; its inserts and updates are numbered
-- by the trigger, its window calls answer as before, and endpoints keep the
-- events they had (agent_event.created is never added for them).

-- ---------------------------------------------------------------------------
-- Labels
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_activities
  ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT '{}';

ALTER TABLE pm.agent_activities DROP CONSTRAINT IF EXISTS agent_activities_labels_shape;
ALTER TABLE pm.agent_activities
  ADD CONSTRAINT agent_activities_labels_shape CHECK (
    cardinality(labels) <= 20
    AND array_position(labels, NULL) IS NULL
    AND (cardinality(labels) = 0
      OR array_to_string(labels, ',') ~ '^[a-z0-9][a-z0-9._:-]{0,63}(,[a-z0-9][a-z0-9._:-]{0,63})*$')
  );

COMMENT ON COLUMN pm.agent_activities.labels IS
  'Labels the agent or its harness set: up to 20, each ^[a-z0-9][a-z0-9._:-]{0,63}$. Never set by the app.';

CREATE INDEX IF NOT EXISTS idx_agent_activities_labels ON pm.agent_activities USING gin (labels);

-- Adds and removes labels on one event under its row lock, so two edits at
-- once both land. Duplicates collapse, the first place kept. Answers the
-- labels, or null when there is no such event. Server only: the API decides
-- who may edit.
CREATE OR REPLACE FUNCTION pm.edit_agent_activity_labels(p_activity_id uuid, p_add text[], p_remove text[])
RETURNS text[]
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_old text[];
  v_new text[];
BEGIN
  SELECT labels INTO v_old FROM pm.agent_activities WHERE id = p_activity_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(array_agg(l ORDER BY first_at), '{}') INTO v_new
  FROM (
    SELECT l, min(ord) AS first_at
    FROM unnest(v_old || coalesce(p_add, '{}')) WITH ORDINALITY AS u(l, ord)
    WHERE NOT (l = ANY (coalesce(p_remove, '{}')))
    GROUP BY l
  ) kept;
  IF v_new IS DISTINCT FROM v_old THEN
    UPDATE pm.agent_activities SET labels = v_new WHERE id = p_activity_id;
  END IF;
  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION pm.edit_agent_activity_labels(uuid, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.edit_agent_activity_labels(uuid, text[], text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Change order for the export
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS pm.agent_event_seq;
REVOKE ALL ON SEQUENCE pm.agent_event_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE pm.agent_event_seq TO service_role;

ALTER TABLE pm.agent_activities
  ADD COLUMN IF NOT EXISTS seq bigint,
  ADD COLUMN IF NOT EXISTS change_txid bigint;
ALTER TABLE pm.agent_runs
  ADD COLUMN IF NOT EXISTS seq bigint,
  ADD COLUMN IF NOT EXISTS change_txid bigint;

COMMENT ON COLUMN pm.agent_activities.seq IS
  'A new number from pm.agent_event_seq on every insert and update (shared with agent_runs).';
COMMENT ON COLUMN pm.agent_activities.change_txid IS
  'The transaction that last wrote the row (0: before 20261124001200). The export orders by (change_txid, seq).';
COMMENT ON COLUMN pm.agent_runs.seq IS
  'A new number from pm.agent_event_seq on every insert and update (shared with agent_activities).';
COMMENT ON COLUMN pm.agent_runs.change_txid IS
  'The transaction that last wrote the row (0: before 20261124001200). The export orders by (change_txid, seq).';

-- Rows written before: numbered in creation order, 5000 at a time, so no
-- one statement holds the whole table in memory. Only rows without a
-- number, so a second run touches nothing. A run's updated_at must not move
-- (it decides when a run reads timed_out), so its touch trigger is off for
-- the backfill.
DO $$
DECLARE
  v_count integer;
BEGIN
  LOOP
    UPDATE pm.agent_activities a
    SET seq = b.seq, change_txid = 0
    FROM (
      SELECT id, nextval('pm.agent_event_seq') AS seq
      FROM (SELECT id FROM pm.agent_activities WHERE seq IS NULL ORDER BY created_at, id LIMIT 5000) ordered
    ) b
    WHERE a.id = b.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    EXIT WHEN v_count = 0;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pm.agent_runs WHERE seq IS NULL) THEN
    ALTER TABLE pm.agent_runs DISABLE TRIGGER set_agent_runs_updated_at;
    LOOP
      UPDATE pm.agent_runs r
      SET seq = b.seq, change_txid = 0
      FROM (
        SELECT id, nextval('pm.agent_event_seq') AS seq
        FROM (SELECT id FROM pm.agent_runs WHERE seq IS NULL ORDER BY created_at, id LIMIT 5000) ordered
      ) b
      WHERE r.id = b.id;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      EXIT WHEN v_count = 0;
    END LOOP;
    ALTER TABLE pm.agent_runs ENABLE TRIGGER set_agent_runs_updated_at;
  END IF;
END $$;

-- Every later insert and update takes the next number and its transaction.
-- Security definer: the sequence is the server's, whoever writes the row.
CREATE OR REPLACE FUNCTION pm.stamp_agent_event_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  NEW.seq := nextval('pm.agent_event_seq');
  NEW.change_txid := pg_current_xact_id()::text::bigint;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.stamp_agent_event_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stamp_agent_event_change ON pm.agent_activities;
CREATE TRIGGER stamp_agent_event_change
  BEFORE INSERT OR UPDATE ON pm.agent_activities
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_agent_event_change();
DROP TRIGGER IF EXISTS stamp_agent_event_change ON pm.agent_runs;
CREATE TRIGGER stamp_agent_event_change
  BEFORE INSERT OR UPDATE ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_agent_event_change();

CREATE INDEX IF NOT EXISTS idx_agent_activities_change ON pm.agent_activities (change_txid, seq);
CREATE INDEX IF NOT EXISTS idx_agent_runs_change ON pm.agent_runs (change_txid, seq);

-- ---------------------------------------------------------------------------
-- Provider on runs
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_runs ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_provider_length;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_provider_length CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 100);

COMMENT ON COLUMN pm.agent_runs.provider IS
  'The provider the run used (anthropic, openai, ...), as the harness sent it; null when it did not say.';

-- pm.agent_run_feed keeps its columns: a view's columns cannot change
-- without breaking a second run of the migration that made it. Readers that
-- need a run's provider join agent_runs (pm.agent_run_stats does).

-- ---------------------------------------------------------------------------
-- One shape for an exported event: the export and the webhook both send it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.agent_event_row(p_row pm.agent_activities)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pm
AS $$
  SELECT jsonb_build_object(
    'id', p_row.id,
    'seq', p_row.seq,
    'source', 'activity',
    'occurred_at', p_row.created_at,
    'agent_id', p_row.agent_id,
    'type', p_row.activity_type,
    'labels', to_jsonb(coalesce(p_row.labels, '{}')),
    'title', p_row.title,
    'payload', p_row.metadata,
    'project_id', p_row.project_id,
    'task_id', CASE WHEN p_row.reference_type = 'task' THEN p_row.reference_id END,
    'run_id', CASE WHEN p_row.metadata->>'run_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN p_row.metadata->>'run_id' END,
    'principal_id', p_row.principal_id
  )
$$;

REVOKE ALL ON FUNCTION pm.agent_event_row(pm.agent_activities) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_event_row(pm.agent_activities) TO service_role;

CREATE OR REPLACE FUNCTION pm.agent_run_event_row(p_row pm.agent_runs)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pm
AS $$
  SELECT jsonb_build_object(
    'id', p_row.id,
    'seq', p_row.seq,
    'source', 'run',
    'occurred_at', p_row.started_at,
    'agent_id', p_row.agent_id,
    'type', 'run',
    'labels', '[]'::jsonb,
    'title', p_row.title,
    'payload', jsonb_build_object(
      'status', p_row.status,
      'summary', p_row.summary,
      'model', p_row.model,
      'provider', p_row.provider,
      'trigger', p_row.trigger,
      'tokens_in', p_row.tokens_in,
      'tokens_out', p_row.tokens_out,
      'cost_usd', p_row.cost_usd,
      'external_id', p_row.external_id,
      'external_url', p_row.external_url,
      'plan', p_row.plan,
      'notes', p_row.notes,
      'metadata', p_row.metadata,
      'started_at', p_row.started_at,
      'finished_at', p_row.finished_at,
      'updated_at', p_row.updated_at
    ),
    'project_id', p_row.project_id,
    'task_id', p_row.task_id,
    'run_id', p_row.id,
    'principal_id', p_row.principal_id
  )
$$;

REVOKE ALL ON FUNCTION pm.agent_run_event_row(pm.agent_runs) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_run_event_row(pm.agent_runs) TO service_role;

-- ---------------------------------------------------------------------------
-- The export: both tables after a cursor, in (change_txid, seq) order, only
-- from transactions that have finished. A transaction still open holds its
-- rows (and every later one) back until it ends, so nothing commits behind a
-- cursor. Server only: the API checks the key's scope and projects.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.agent_event_export(
  p_after_txid bigint,
  p_after_seq bigint,
  p_limit integer,
  p_types text[] DEFAULT NULL,
  p_agents uuid[] DEFAULT NULL,
  p_project_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (change_txid bigint, seq bigint, event jsonb)
LANGUAGE sql
STABLE
SET search_path = pm
AS $$
  WITH horizon AS (
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint AS xmin
  )
  SELECT x.change_txid, x.seq, x.event
  FROM (
    (
      SELECT a.change_txid, a.seq, pm.agent_event_row(a) AS event
      FROM pm.agent_activities a, horizon h
      WHERE (a.change_txid, a.seq) > (p_after_txid, p_after_seq)
        AND a.change_txid < h.xmin
        AND (p_types IS NULL OR a.activity_type = ANY (p_types))
        AND (p_agents IS NULL OR a.agent_id = ANY (p_agents))
        AND (p_project_ids IS NULL OR a.project_id = ANY (p_project_ids))
      ORDER BY a.change_txid, a.seq
      LIMIT greatest(p_limit, 0)
    )
    UNION ALL
    (
      SELECT r.change_txid, r.seq, pm.agent_run_event_row(r) AS event
      FROM pm.agent_runs r, horizon h
      WHERE (r.change_txid, r.seq) > (p_after_txid, p_after_seq)
        AND r.change_txid < h.xmin
        AND (p_types IS NULL OR 'run' = ANY (p_types))
        AND (p_agents IS NULL OR r.agent_id = ANY (p_agents))
        AND (p_project_ids IS NULL OR r.project_id = ANY (p_project_ids))
      ORDER BY r.change_txid, r.seq
      LIMIT greatest(p_limit, 0)
    )
  ) x
  ORDER BY x.change_txid, x.seq
  LIMIT greatest(p_limit, 0)
$$;

REVOKE ALL ON FUNCTION pm.agent_event_export(bigint, bigint, integer, text[], uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_event_export(bigint, bigint, integer, text[], uuid[], uuid[]) TO service_role;

INSERT INTO pm.permission_modules (permission_key, module_id) VALUES
  ('agent_events.export', 'agents')
ON CONFLICT (permission_key) DO UPDATE SET module_id = EXCLUDED.module_id;

-- ---------------------------------------------------------------------------
-- Webhook agent_event.created
-- ---------------------------------------------------------------------------
ALTER TABLE pm.webhook_endpoints ADD COLUMN IF NOT EXISTS agent_event_types text[];
ALTER TABLE pm.webhook_endpoints DROP CONSTRAINT IF EXISTS webhook_endpoints_agent_event_types_shape;
ALTER TABLE pm.webhook_endpoints
  ADD CONSTRAINT webhook_endpoints_agent_event_types_shape CHECK (
    agent_event_types IS NULL OR (
      cardinality(agent_event_types) BETWEEN 1 AND 100
      AND array_position(agent_event_types, NULL) IS NULL
      AND array_to_string(agent_event_types, ',') ~ '^[a-z][a-z0-9_.]{0,99}(,[a-z][a-z0-9_.]{0,99})*$'
    )
  );

COMMENT ON COLUMN pm.webhook_endpoints.agent_event_types IS
  'Only these agent event types for agent_event.created (null: every type). The member filter picks the agent.';

-- One event per new agent_activities row, to the endpoints subscribed to
-- agent_event.created whose filters match: project, member (the agent) and
-- type. Each event is its own line (resource agent_event), so a slow
-- endpoint never holds the others back; the export carries the order.
CREATE OR REPLACE FUNCTION pm.emit_agent_event_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_members uuid[] := CASE WHEN NEW.agent_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[NEW.agent_id] END;
  v_task uuid := CASE WHEN NEW.reference_type = 'task' THEN NEW.reference_id END;
  v_endpoints uuid[];
  v_seq bigint;
  v_public_id text;
  v_event_uuid uuid;
BEGIN
  SELECT array_agg(e.id) INTO v_endpoints
  FROM pm.webhook_endpoints e
  WHERE e.is_active
    AND 'agent_event.created' = ANY (e.events)
    AND pm.webhook_endpoint_matches(e, 'agent_event.created', ARRAY[NEW.project_id], v_members)
    AND (e.agent_event_types IS NULL OR NEW.activity_type = ANY (e.agent_event_types));
  IF v_endpoints IS NULL THEN
    RETURN NULL;
  END IF;

  v_seq := nextval('pm.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
  VALUES (
    v_public_id, v_seq, 'agent_event.created', 'agent_event', NEW.id,
    jsonb_build_object(
      'id', v_public_id,
      'type', 'agent_event.created',
      'sequence', v_seq,
      'created_at', now(),
      'data', jsonb_build_object(
        'agent_event', pm.agent_event_row(NEW),
        'project_id', NEW.project_id,
        'task_id', v_task,
        'member_ids', to_jsonb(v_members)
      )
    )
  )
  RETURNING id INTO v_event_uuid;

  INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id)
  SELECT v_event_uuid, unnest(v_endpoints);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_agent_event_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_agent_event_webhook ON pm.agent_activities;
CREATE TRIGGER emit_agent_event_webhook
  AFTER INSERT ON pm.agent_activities
  FOR EACH ROW EXECUTE FUNCTION pm.emit_agent_event_webhook();

-- ---------------------------------------------------------------------------
-- Analytics window, version 2. Same range rules as agent_analytics_window,
-- which stays as it was. Changes:
-- - usage_hours: summed per agent, project, hour, model, provider, labels and
--   priced (a record with a cost above 0) or not, so a priced hour and an
--   unpriced hour never merge and every row knows its model.
--   [agent, project, hour, input, output, cached, cost_usd, deltas, model,
--    provider, priced, labels]
-- - turns: the first fifteen fields as before, then run_id, and the turn's
--   own input and output tokens (tokens_scope turn, null otherwise).
-- - events: the seven fields as before, then labels.
-- Security invoker, like the first version.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.agent_analytics_window_v2(p_from timestamptz, p_to timestamptz, p_late_to timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pm
AS $$
  with turns as (
    select a.id, a.agent_id, a.created_at, a.metadata as m
    from agent_activities a
    where a.activity_type = 'turn.completed'
      and a.created_at >= p_from and a.created_at <= p_late_to
  ),
  usage_rows as (
    select a.agent_id, a.project_id, a.metadata as m, a.labels,
           coalesce(agent_analytics_ts(a.metadata->>'recorded_at'), a.created_at) as at
    from agent_activities a
    where a.activity_type = 'usage.recorded'
      and a.created_at >= p_from and a.created_at <= p_late_to
  ),
  directed_sessions as (
    select distinct agent_id, m->>'session_id' as session_id
    from turns
    where m->>'origin' = 'directed' and m->>'session_id' is not null
  )
  select jsonb_build_object(
    'version', 2,
    'turns', coalesce((
      select jsonb_agg(jsonb_build_array(
        t.id, t.agent_id, t.created_at, t.m->>'source_turn_id', t.m->>'origin',
        agent_analytics_int(t.m->>'duration_ms'), t.m->>'started_at', t.m->>'outcome',
        t.m->>'outcome_source', t.m->>'job_name', t.m->>'trigger',
        case when t.m->>'origin' = 'directed' then t.m->>'session_id' end,
        t.m->>'model', t.m->>'tokens_scope',
        case when t.m ? 'tokens' then
          agent_analytics_int(t.m->'tokens'->>'input') + agent_analytics_int(t.m->'tokens'->>'output')
          + agent_analytics_int(t.m->'tokens'->>'cache_read') + agent_analytics_int(t.m->'tokens'->>'cache_write')
        end,
        t.m->>'run_id',
        case when t.m->>'tokens_scope' = 'turn' and t.m->'tokens' ? 'input' then agent_analytics_int(t.m->'tokens'->>'input') end,
        case when t.m->>'tokens_scope' = 'turn' and t.m->'tokens' ? 'output' then agent_analytics_int(t.m->'tokens'->>'output') end
      ))
      from turns t
    ), '[]'::jsonb),
    'usage_hours', coalesce((
      select jsonb_agg(jsonb_build_array(h.agent_id, h.project_id, h.hour, h.input, h.output, h.cached, h.cost, h.deltas,
        h.model, h.provider, h.priced, to_jsonb(h.labels)))
      from (
        select agent_id, project_id, date_trunc('hour', at) as hour,
               m->>'model' as model, m->>'provider' as provider,
               agent_analytics_num(m->>'cost_usd') > 0 as priced, labels,
               sum(agent_analytics_int(m->>'input_tokens')) as input,
               sum(agent_analytics_int(m->>'output_tokens')) as output,
               sum(agent_analytics_int(m->>'cached_tokens')) as cached,
               sum(agent_analytics_num(m->>'cost_usd')) as cost,
               count(*) as deltas
        from usage_rows
        where at >= p_from and at <= p_to
        group by agent_id, project_id, date_trunc('hour', at), m->>'model', m->>'provider',
                 agent_analytics_num(m->>'cost_usd') > 0, labels
      ) h
    ), '[]'::jsonb),
    'session_usage', coalesce((
      select jsonb_agg(jsonb_build_array(u.agent_id, u.m->>'session_id', u.at,
        agent_analytics_int(u.m->>'input_tokens') + agent_analytics_int(u.m->>'output_tokens')
        + agent_analytics_int(u.m->>'cached_tokens')))
      from usage_rows u
      join directed_sessions d on d.agent_id = u.agent_id and d.session_id = u.m->>'session_id'
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_array(e.id, e.agent_id, e.project_id, e.activity_type, e.reference_id, e.created_at, e.metadata,
        to_jsonb(e.labels)))
      from agent_activities e
      where e.activity_type not in ('turn.completed', 'usage.recorded')
        and e.created_at >= p_from
        and (e.created_at <= p_to or (
          e.created_at <= p_late_to
          and e.activity_type in ('turn.outcome', 'turn.failed', 'agent.restarted', 'attention.message',
                                  'dispatch.wake', 'billing.gap', 'eval.result')
        ))
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION pm.agent_analytics_window_v2(timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pm.agent_analytics_window_v2(timestamptz, timestamptz, timestamptz) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Run aggregates for Analytics: the run feed summed per agent, project,
-- model, provider and day (p_tz's calendar days from p_start to p_end), read
-- as the caller. The same rules as the screen's read model
-- (src/lib/agent-analytics-model.ts), so the two always agree:
-- - Runs are read where sort_at falls within a day either side of the range,
--   then placed on the day they started.
-- - Success and failure as the run pill reads them; a running run is
--   neither.
-- - Busy time: each run keeps the part of its span no earlier run of the
--   same agent covers, so the parts add up to the union. With
--   p_project_ids, only those projects' runs clip against each other.
-- - A stored run that reports no tokens takes its attached turns' own
--   tokens. runs_no_tokens counts the stored runs still without any.
-- - Cost: a run's cost above 0, else its tokens are unpriced.
-- failures lists every failed run read (for incidents, which collapse
-- repeats across days).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.agent_run_stats(
  p_start date,
  p_end date,
  p_tz text,
  p_project_ids uuid[] DEFAULT NULL,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pm
AS $$
  with feed as (
    select f.id, f.source, f.agent_id, f.project_id, f.status, f.outcome, f.title, f.model, r.provider,
           f.started_at, f.finished_at, f.duration_ms, f.tokens_in, f.tokens_out, f.cost_usd
    from agent_run_feed f
    left join agent_runs r on f.source = 'run' and r.id = f.id
    where f.sort_at >= (p_start::timestamp - interval '1 day') at time zone 'UTC'
      and f.sort_at <= (p_end::timestamp + interval '2 days' - interval '1 millisecond') at time zone 'UTC'
  ),
  attached as (
    select a.metadata->>'run_id' as run_id,
           sum(agent_analytics_int(a.metadata->'tokens'->>'input')) filter (where a.metadata->'tokens' ? 'input') as tokens_in,
           sum(agent_analytics_int(a.metadata->'tokens'->>'output')) filter (where a.metadata->'tokens' ? 'output') as tokens_out
    from agent_activities a
    where a.activity_type = 'turn.completed'
      and a.metadata->>'run_id' in (select id::text from feed where source = 'run' and tokens_in is null and tokens_out is null)
      and a.metadata->>'tokens_scope' = 'turn'
    group by a.metadata->>'run_id'
  ),
  runs as (
    select f.*,
      (f.started_at at time zone p_tz)::date as day,
      case
        when f.status = 'running' then 'running'
        when f.source = 'run' then case f.status when 'succeeded' then 'success' when 'failed' then 'failure'
          when 'timed_out' then 'failure' else 'neutral' end
        when lower(coalesce(f.outcome, '')) = 'blocked' then 'neutral'
        when lower(coalesce(f.outcome, '')) in ('failed', 'error') then 'failure'
        when lower(coalesce(f.outcome, '')) in ('idle', 'skipped', 'waiting', 'no_work', 'nothing', 'nothing_to_do') then 'neutral'
        when coalesce(f.outcome, '') = '' or lower(f.outcome) in ('work', 'worked', 'ok', 'done', 'shipped', 'succeeded') then 'success'
        else 'neutral'
      end as verdict,
      case when f.source = 'run' and f.tokens_in is null and f.tokens_out is null then t.tokens_in else f.tokens_in end as tin,
      case when f.source = 'run' and f.tokens_in is null and f.tokens_out is null then t.tokens_out else f.tokens_out end as tout,
      case
        when f.duration_ms is not null then greatest(f.duration_ms, 0)
        when f.finished_at is not null then greatest(floor(extract(epoch from f.finished_at) * 1000) - floor(extract(epoch from f.started_at) * 1000), 0)::bigint
        when f.status = 'running' then greatest(floor(extract(epoch from p_now) * 1000) - floor(extract(epoch from f.started_at) * 1000), 0)::bigint
      end as span_ms
    from feed f
    left join attached t on t.run_id = f.id::text
  ),
  placed as (
    select * from runs where day >= p_start and day <= p_end
  ),
  spans as (
    select p.id, p.agent_id, p.project_id, p.model, p.provider, p.day,
           floor(extract(epoch from p.started_at) * 1000)::bigint as s,
           floor(extract(epoch from p.started_at) * 1000)::bigint + p.span_ms as e
    from placed p
    where p.span_ms > 0
      and (p_project_ids is null or p.project_id = any (p_project_ids))
  ),
  clipped as (
    select sp.*,
      max(sp.e) over (partition by sp.agent_id order by sp.s, sp.e, sp.id rows between unbounded preceding and 1 preceding) as covered
    from spans sp
  ),
  busy as (
    select agent_id, project_id, model, provider, day,
           sum(greatest(0, e - greatest(s, coalesce(covered, s)))) as busy_ms
    from clipped
    group by agent_id, project_id, model, provider, day
  ),
  counts as (
    select agent_id, project_id, model, provider, day,
      count(*) as runs,
      count(*) filter (where verdict = 'success') as succeeded,
      count(*) filter (where verdict = 'failure') as failed,
      coalesce(sum(tin), 0) as tokens_in,
      coalesce(sum(tout), 0) as tokens_out,
      coalesce(sum(cost_usd) filter (where cost_usd > 0), 0) as cost_usd,
      coalesce(sum(coalesce(tin, 0) + coalesce(tout, 0)) filter (where not (coalesce(cost_usd, 0) > 0)), 0) as unpriced_tokens,
      count(*) filter (where source = 'run' and tin is null and tout is null) as runs_no_tokens
    from placed
    group by agent_id, project_id, model, provider, day
  ),
  grouped as (
    select coalesce(c.agent_id, b.agent_id) as agent_id, coalesce(c.project_id, b.project_id) as project_id,
           coalesce(c.model, b.model) as model, coalesce(c.provider, b.provider) as provider, coalesce(c.day, b.day) as day,
           coalesce(c.runs, 0) as runs, coalesce(c.succeeded, 0) as succeeded, coalesce(c.failed, 0) as failed,
           coalesce(b.busy_ms, 0) as busy_ms, coalesce(c.tokens_in, 0) as tokens_in, coalesce(c.tokens_out, 0) as tokens_out,
           coalesce(c.cost_usd, 0) as cost_usd, coalesce(c.unpriced_tokens, 0) as unpriced_tokens,
           coalesce(c.runs_no_tokens, 0) as runs_no_tokens
    from counts c
    full join busy b on b.agent_id = c.agent_id and b.project_id is not distinct from c.project_id
      and b.model is not distinct from c.model and b.provider is not distinct from c.provider and b.day = c.day
  )
  select jsonb_build_object(
    'groups', coalesce((
      select jsonb_agg(jsonb_build_array(g.agent_id, g.project_id, g.model, g.provider, to_char(g.day, 'YYYY-MM-DD'),
        g.runs, g.succeeded, g.failed, g.busy_ms, g.tokens_in, g.tokens_out, g.cost_usd, g.unpriced_tokens, g.runs_no_tokens))
      from grouped g
    ), '[]'::jsonb),
    'failures', coalesce((
      select jsonb_agg(jsonb_build_array(r.agent_id, r.project_id, r.model, r.provider, r.started_at, r.title, r.status)
        order by r.started_at)
      from runs r
      where r.verdict = 'failure'
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION pm.agent_run_stats(date, date, text, uuid[], timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pm.agent_run_stats(date, date, text, uuid[], timestamptz) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Question aggregates for Analytics: questions and approvals per asker,
-- project and day (p_tz's calendar days), with each answer time and the
-- median, for the questions the caller may count:
-- - on a project the caller can open (pm.can_access_project), whoever was
--   asked: counts and times only, never a question's words;
-- - on no project, only for an Owner or a holder of agents.manage, who
--   oversee every agent's questions;
-- - and any question the caller asked or was asked (directly or through a
--   group), as their own row access already shows them.
-- Security definer so an Owner's figures are whole: the row policy hides
-- questions between other people. scope says which rule applied.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.agent_question_stats(p_start date, p_end date, p_tz text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  with me as (
    select pm.current_team_member_id() as id,
           coalesce(pm.current_team_member_role() = 'owner' or pm.has_permission('agents.manage'), false) as oversees
  ),
  counted as (
    select q.asked_by, q.project_id, q.kind, q.created_at, q.answered_at,
           (q.created_at at time zone p_tz)::date as day
    from pm.questions q, me
    where me.id is not null
      and (select pm.module_enabled('agents'))
      and q.deleted_at is null
      and q.created_at >= (p_start::timestamp - interval '1 day') at time zone 'UTC'
      and q.created_at <= (p_end::timestamp + interval '2 days' - interval '1 millisecond') at time zone 'UTC'
      and (q.task_id is null or pm.task_is_live(q.task_id))
      and (q.project_id is null or pm.project_is_live(q.project_id))
      and (
        (q.project_id is not null and pm.can_access_project(q.project_id))
        or (q.project_id is null and me.oversees)
        or q.asked_by = me.id
        or q.asked_to = me.id
        or (q.asked_to_group is not null and exists (
          select 1 from pm.group_members gm where gm.group_id = q.asked_to_group and gm.member_id = me.id))
      )
  ),
  placed as (
    select c.*,
      case when c.answered_at is not null and c.answered_at >= c.created_at
        then (floor(extract(epoch from c.answered_at) * 1000) - floor(extract(epoch from c.created_at) * 1000))::bigint end as answer_ms
    from counted c
    where c.day >= p_start and c.day <= p_end
  ),
  grouped as (
    select asked_by, project_id, day,
           count(*) filter (where kind is distinct from 'approval') as questions,
           count(*) filter (where kind = 'approval') as approvals,
           coalesce(array_agg(answer_ms order by answer_ms) filter (where answer_ms is not null), '{}') as answers,
           round(percentile_cont(0.5) within group (order by answer_ms))::bigint as median_answer_ms
    from placed
    group by asked_by, project_id, day
  )
  select jsonb_build_object(
    'scope', case when (select oversees from me) then 'all' else 'projects' end,
    'groups', coalesce((
      select jsonb_agg(jsonb_build_array(g.asked_by, g.project_id, to_char(g.day, 'YYYY-MM-DD'), g.questions, g.approvals,
        to_jsonb(g.answers), g.median_answer_ms))
      from grouped g
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION pm.agent_question_stats(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pm.agent_question_stats(date, date, text) TO authenticated, service_role;

-- The question sums read live questions by when they were asked.
CREATE INDEX IF NOT EXISTS idx_questions_created_live ON pm.questions (created_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Provider plans: a subscription's monthly cost per seat, set by an Owner.
-- Analytics shows it as an estimate, allocated by token share, never inside
-- measured cost. Members read it (it explains a figure on their screen);
-- only an Owner writes; both while the AI agents module is on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.provider_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  monthly_cost_usd numeric(12, 2) NOT NULL,
  seats integer NOT NULL DEFAULT 1,
  notes text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.provider_plans DROP CONSTRAINT IF EXISTS provider_plans_provider_shape;
ALTER TABLE pm.provider_plans
  ADD CONSTRAINT provider_plans_provider_shape CHECK (length(btrim(provider)) BETWEEN 1 AND 100 AND provider = btrim(provider));
ALTER TABLE pm.provider_plans DROP CONSTRAINT IF EXISTS provider_plans_cost_shape;
ALTER TABLE pm.provider_plans
  ADD CONSTRAINT provider_plans_cost_shape CHECK (monthly_cost_usd >= 0 AND monthly_cost_usd <= 1000000);
ALTER TABLE pm.provider_plans DROP CONSTRAINT IF EXISTS provider_plans_seats_shape;
ALTER TABLE pm.provider_plans
  ADD CONSTRAINT provider_plans_seats_shape CHECK (seats BETWEEN 1 AND 10000);
ALTER TABLE pm.provider_plans DROP CONSTRAINT IF EXISTS provider_plans_notes_length;
ALTER TABLE pm.provider_plans
  ADD CONSTRAINT provider_plans_notes_length CHECK (length(notes) <= 500);

COMMENT ON TABLE pm.provider_plans IS
  'A provider subscription''s monthly cost per seat (Owner-managed). Analytics shows it as an estimate, never as measured cost.';

CREATE UNIQUE INDEX IF NOT EXISTS provider_plans_provider_key ON pm.provider_plans (lower(provider));

DROP TRIGGER IF EXISTS set_provider_plans_updated_at ON pm.provider_plans;
CREATE TRIGGER set_provider_plans_updated_at
  BEFORE UPDATE ON pm.provider_plans
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

ALTER TABLE pm.provider_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provider_plans_select ON pm.provider_plans;
CREATE POLICY provider_plans_select ON pm.provider_plans FOR SELECT TO authenticated
  USING (coalesce(pm.current_team_member_role() <> 'guest', false));

DROP POLICY IF EXISTS provider_plans_module_on ON pm.provider_plans;
CREATE POLICY provider_plans_module_on ON pm.provider_plans AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select pm.module_enabled('agents')));

DROP POLICY IF EXISTS provider_plans_owner_write ON pm.provider_plans;
CREATE POLICY provider_plans_owner_write ON pm.provider_plans FOR ALL TO authenticated
  USING (pm.current_team_member_role() = 'owner')
  WITH CHECK (pm.current_team_member_role() = 'owner');

REVOKE ALL ON pm.provider_plans FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm.provider_plans TO authenticated;
GRANT ALL ON pm.provider_plans TO service_role;

-- Live sync: open screens see a plan change.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'provider_plans') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.provider_plans;
    END IF;
  END IF;
END $$;
