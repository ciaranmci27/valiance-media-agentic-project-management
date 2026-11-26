-- Agents home fixes: the run list says what each row shows.
--
-- - pm.agent_run_rows (a new view, security invoker, over pm.agent_run_feed):
--   every run feed row plus display_status, what the row's pill says and what
--   the Runs status filter matches. A stored run's status (already read as
--   timed_out by the watchdog's rule); a turn (always "succeeded" as a
--   process) by its outcome: blocked, failed, no_work, succeeded, or other
--   for a word outside these. runDisplayStatus in src/lib/agent-runs.ts is the
--   same rule for the browser. A new view, because pm.agent_run_feed keeps
--   its columns (a second run of the migrations that made it must still work).
-- - pm.agent_run_feed, same columns: a turn row carries its task (the
--   activity's own task reference, else a task_id in its metadata; it read
--   NULL before).
--
-- Additive and safe to run twice: CREATE OR REPLACE VIEW only.

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
  coalesce(
    CASE WHEN a.reference_type = 'task' THEN a.reference_id END,
    CASE WHEN a.metadata->>'task_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (a.metadata->>'task_id')::uuid END
  ) AS task_id,
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

CREATE OR REPLACE VIEW pm.agent_run_rows
WITH (security_invoker = true) AS
SELECT
  f.id,
  f.source,
  f.agent_id,
  f.task_id,
  f.project_id,
  f.status,
  f.outcome,
  f.title,
  f.summary,
  f.model,
  f.trigger,
  f.started_at,
  f.finished_at,
  f.duration_ms,
  f.tokens_in,
  f.tokens_out,
  f.cost_usd,
  f.external_id,
  f.external_url,
  f.sort_at,
  f.updated_at,
  CASE
    WHEN f.source = 'run' OR f.status = 'running' THEN f.status
    WHEN lower(coalesce(f.outcome, '')) = 'blocked' THEN 'blocked'
    WHEN lower(coalesce(f.outcome, '')) IN ('failed', 'error') THEN 'failed'
    WHEN lower(coalesce(f.outcome, '')) IN ('idle', 'skipped', 'waiting', 'no_work', 'nothing', 'nothing_to_do') THEN 'no_work'
    WHEN lower(coalesce(f.outcome, '')) IN ('', 'work', 'worked', 'ok', 'done', 'shipped', 'succeeded') THEN 'succeeded'
    ELSE 'other'
  END AS display_status
FROM pm.agent_run_feed f;

COMMENT ON VIEW pm.agent_run_rows IS
  'The run feed (pm.agent_run_feed) with display_status: what a row shows and the Runs status filter matches (a run''s status, a turn''s outcome).';

REVOKE ALL ON pm.agent_run_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.agent_run_rows TO authenticated;
GRANT SELECT ON pm.agent_run_rows TO service_role;
