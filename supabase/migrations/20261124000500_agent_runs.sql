-- Agent runs: one run of an agent, the object every harness has (a Claude
-- Code session, an OpenAI Agents run, a LangGraph thread, a custom loop):
-- its status, plan, progress notes, tokens and cost, linked to a task, with
-- the harness's own trace link.
--
-- - status: running, succeeded, failed, cancelled or timed_out. A run still
--   running two hours after its last update reads as timed_out with no job:
--   readers treat it so (pm.agent_run_feed, the API), and the stored row
--   stays running, so a late update or finish from the agent still lands.
--   Any update, and a turn.completed attached to it, counts as an update.
-- - A finished run's status and finish time never change again: the
--   trigger keeps them, so two finishes at once cannot both land. Its other
--   details (a summary, final tokens, a trace link) may still change.
-- - plan: up to 50 steps, each { title, status }. notes: the newest 50
--   progress notes, each { at, text }. metadata: an object, held to 8000
--   characters of compact JSON by the API; the database keeps a looser 16000
--   (as Postgres prints it, with spaces) as a backstop. tokens_in, tokens_out
--   and cost_usd (US dollars, the unit usage.recorded uses) are the run's
--   own totals so far, as the harness reports them; null means not
--   reported, never zero.
-- - external_id (the harness's own run id) is unique per agent, so a harness
--   starts a run idempotently. external_url is its trace link.
-- - On a task, project_id is always the task's project (set here, and kept
--   when the task moves to another project).
-- - Webhooks: run.started when a run is recorded running, run.finished when
--   it leaves running. Both concern the run's agent and are ordered per run
--   (resource_type 'run'). Timing out sends nothing.
-- - pm.agent_run_feed (a view, security invoker) is the one read model: every
--   stored run, plus each turn.completed that names no run, read as a
--   finished run, so an agent that never starts runs still shows its work.
--   Nothing about a turn is copied: the turn stays the only record of its
--   runtime and tokens, so analytics, which reads turns and usage, keeps
--   every number. A turn's tokens show only when they are its own
--   (tokens_scope turn); its cost is never shown (cost lives in usage). A
--   turn that names a run (payload run_id, resolved by the server) belongs to
--   that run and is not a row of its own. Scheduled turns that did no work
--   (outcome idle, skipped or waiting) are not runs.
-- - Rows are never permanently deleted. Only the server writes them; a
--   signed-in member reads their own runs, or every run with agents.manage,
--   as for agent_activities, while the AI agents module is on.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the table or the view, the new functions are trigger functions
-- only, and the new index on agent_activities changes no behaviour.

CREATE TABLE IF NOT EXISTS pm.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  -- A task's run always carries its task's project (set by the trigger).
  task_id uuid REFERENCES pm.tasks(id) ON DELETE SET NULL,
  project_id uuid REFERENCES pm.projects(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running',
  title text,
  summary text,
  plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens_in bigint,
  tokens_out bigint,
  cost_usd numeric(14, 6),
  model text,
  trigger text,
  external_id text,
  external_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_status_check CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'timed_out'));
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_finished_when_done;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_finished_when_done CHECK ((status = 'running') = (finished_at IS NULL));
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_finished_after_start;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_finished_after_start CHECK (finished_at IS NULL OR finished_at >= started_at);
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_title_length;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_title_length CHECK (title IS NULL OR length(title) BETWEEN 1 AND 300);
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_summary_length;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_summary_length CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 4000);
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_plan_shape;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_plan_shape CHECK (jsonb_typeof(plan) = 'array' AND jsonb_array_length(plan) <= 50);
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_notes_shape;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_notes_shape CHECK (jsonb_typeof(notes) = 'array' AND jsonb_array_length(notes) <= 50);
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_metadata_shape;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_metadata_shape CHECK (jsonb_typeof(metadata) = 'object' AND length(metadata::text) <= 16000);
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_amounts_not_negative;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_amounts_not_negative CHECK (
    (tokens_in IS NULL OR tokens_in >= 0) AND (tokens_out IS NULL OR tokens_out >= 0) AND (cost_usd IS NULL OR cost_usd >= 0));
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_model_length;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_model_length CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200);
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_trigger_shape;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_trigger_shape CHECK (trigger IS NULL OR trigger ~ '^[a-z][a-z0-9_.-]{0,39}$');
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_external_id_length;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_external_id_length CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 300);
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_external_url_shape;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_external_url_shape CHECK (external_url IS NULL OR (length(external_url) <= 2000 AND external_url ~* '^https?://'));
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_task_has_project;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_task_has_project CHECK (task_id IS NULL OR project_id IS NOT NULL);
-- One run per harness run id, per agent (nulls never collide).
ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_agent_external_id_key;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_agent_external_id_key UNIQUE (agent_id, external_id);

COMMENT ON TABLE pm.agent_runs IS
  'One run of an agent: status, plan, notes, tokens and cost, on a task or not, with the harness''s trace link. Written by the server only.';
COMMENT ON COLUMN pm.agent_runs.status IS
  'running, succeeded, failed, cancelled or timed_out. A run running two hours past updated_at reads as timed_out; the row stays running.';
COMMENT ON COLUMN pm.agent_runs.cost_usd IS
  'The run''s own cost so far in US dollars, as the harness reports it (null: not reported). Never summed with usage.recorded.';
COMMENT ON COLUMN pm.agent_runs.external_id IS
  'The harness''s own run id, unique per agent: starting a run with it again returns the same run.';

-- An agent's runs, newest first; a task's latest run; the still running.
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started ON pm.agent_runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task_started ON pm.agent_runs (task_id, started_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON pm.agent_runs (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON pm.agent_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_running ON pm.agent_runs (updated_at) WHERE status = 'running';

-- A run's turns: turn.completed rows the server attached to it.
CREATE INDEX IF NOT EXISTS idx_agent_activities_turn_run ON pm.agent_activities ((metadata->>'run_id'))
  WHERE activity_type = 'turn.completed' AND metadata->>'run_id' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Normalise every write: the task's project, the finish time, and the fields
-- a later write may not change (a finished run's status and finish time
-- among them).
-- ---------------------------------------------------------------------------
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
    IF OLD.status <> 'running' THEN
      NEW.status := OLD.status;
      NEW.finished_at := OLD.finished_at;
    END IF;
  END IF;
  IF NEW.status <> 'running' AND NEW.finished_at IS NULL THEN
    NEW.finished_at := greatest(now(), NEW.started_at);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_agent_run_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS agent_runs_before_write ON pm.agent_runs;
CREATE TRIGGER agent_runs_before_write
  BEFORE INSERT OR UPDATE ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.handle_agent_run_before_write();

DROP TRIGGER IF EXISTS set_agent_runs_updated_at ON pm.agent_runs;
CREATE TRIGGER set_agent_runs_updated_at
  BEFORE UPDATE ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

-- A task moved to another project takes its runs along.
CREATE OR REPLACE FUNCTION pm.sync_task_agent_runs_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  UPDATE pm.agent_runs SET project_id = NEW.project_id WHERE task_id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.sync_task_agent_runs_project() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_sync_agent_runs_project ON pm.tasks;
CREATE TRIGGER tasks_sync_agent_runs_project
  AFTER UPDATE OF project_id ON pm.tasks
  FOR EACH ROW
  WHEN (NEW.project_id IS DISTINCT FROM OLD.project_id)
  EXECUTE FUNCTION pm.sync_task_agent_runs_project();

-- Never permanently deleted.
DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.agent_runs;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.agent_runs;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.agent_runs
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

-- ---------------------------------------------------------------------------
-- Webhooks: run.started and run.finished, concerning the run's agent, in the
-- run's own line. One look at webhook_endpoints when nobody subscribes.
-- ---------------------------------------------------------------------------
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
    WHERE e.is_active AND e.events && ARRAY['run.started', 'run.finished']
  ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_type := CASE WHEN NEW.status = 'running' THEN 'run.started' ELSE 'run.finished' END;
  ELSIF OLD.status = 'running' AND NEW.status <> 'running' THEN
    v_type := 'run.finished';
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
      ),
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

DROP TRIGGER IF EXISTS emit_agent_run_webhook_insert ON pm.agent_runs;
CREATE TRIGGER emit_agent_run_webhook_insert
  AFTER INSERT ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.emit_agent_run_webhook();

DROP TRIGGER IF EXISTS emit_agent_run_webhook_update ON pm.agent_runs;
CREATE TRIGGER emit_agent_run_webhook_update
  AFTER UPDATE ON pm.agent_runs
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION pm.emit_agent_run_webhook();

-- ---------------------------------------------------------------------------
-- Row level security: a member reads their own runs, or every run with
-- agents.manage (as agent_activities), while the AI agents module is on.
-- Only the server writes.
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_runs_select ON pm.agent_runs;
CREATE POLICY agent_runs_select ON pm.agent_runs FOR SELECT TO authenticated
  USING (pm.has_permission('agents.manage') OR agent_id = pm.current_team_member_id());

DROP POLICY IF EXISTS agent_runs_module_on ON pm.agent_runs;
CREATE POLICY agent_runs_module_on ON pm.agent_runs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select pm.module_enabled('agents')));

DROP POLICY IF EXISTS agent_runs_parent_live ON pm.agent_runs;
CREATE POLICY agent_runs_parent_live ON pm.agent_runs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((task_id IS NULL OR pm.task_is_live(task_id)) AND (project_id IS NULL OR pm.project_is_live(project_id)));

REVOKE ALL ON pm.agent_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.agent_runs TO authenticated;
GRANT ALL ON pm.agent_runs TO service_role;

-- ---------------------------------------------------------------------------
-- The read model: stored runs, plus each turn.completed that names no run.
-- Security invoker, so a member reads it through both tables' row security.
-- sort_at orders it: a run's start, a turn's arrival.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW pm.agent_run_feed
WITH (security_invoker = true) AS
SELECT
  r.id,
  'run'::text AS source,
  r.agent_id,
  r.task_id,
  r.project_id,
  CASE WHEN r.status = 'running' AND r.updated_at < now() - interval '2 hours' THEN 'timed_out' ELSE r.status END AS status,
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

COMMENT ON VIEW pm.agent_run_feed IS
  'Every run: stored runs, plus each turn.completed that names no run read as a finished run. Copies nothing; turns stay the record of runtime and tokens.';

REVOKE ALL ON pm.agent_run_feed FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.agent_run_feed TO authenticated;
GRANT SELECT ON pm.agent_run_feed TO service_role;

-- Live sync: open screens see runs start, move and finish as it happens.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'agent_runs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pm.agent_runs;
  END IF;
END $$;
