-- UI fixes (2.0.50): guests see only the questions addressed to them, and
-- the other database pieces the UI fixes need. Additive and safe to run
-- twice; works with the previous release's code.

-- ---------------------------------------------------------------------------
-- Questions: a guest sees only what is addressed to them
-- ---------------------------------------------------------------------------
-- A guest (a client let into some projects) saw the team's own questions and
-- approvals on the tasks they can open. A guest now reads a question only as a
-- party: asked by them, asked of them, or asked of a group they are in.
-- Everyone else reads as before. The app's read (lib/api/questions.ts,
-- isGuestReader) applies the same rule.
DROP POLICY IF EXISTS questions_select ON pm.questions;
CREATE POLICY questions_select ON pm.questions FOR SELECT TO authenticated
  USING (
    asked_by = pm.current_team_member_id()
    OR asked_to = pm.current_team_member_id()
    OR (asked_to_group IS NOT NULL AND EXISTS (SELECT 1 FROM pm.group_members gm WHERE gm.group_id = questions.asked_to_group AND gm.member_id = pm.current_team_member_id()))
    OR (
      pm.current_team_member_role() IS DISTINCT FROM 'guest'
      AND (
        (task_id IS NOT NULL AND pm.can_access_task(task_id))
        OR (task_id IS NULL AND project_id IS NOT NULL AND pm.can_access_project(project_id))
      )
    )
  );


-- ---------------------------------------------------------------------------
-- Agents and keys
-- ---------------------------------------------------------------------------
-- One hire per attempt: the Hire screen (and any API caller) sends a
-- request_id once per attempt; the first call claims it here in one insert,
-- so a double click makes one agent and one key. Read and written by the
-- server only.
CREATE TABLE IF NOT EXISTS pm.agent_hire_requests (
  request_id uuid PRIMARY KEY,
  hired_by uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  -- Set once the hire went through; null while it runs.
  agent_id uuid REFERENCES pm.team_members(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pm.agent_hire_requests IS
  'One row per hire attempt (request_id from POST /api/workspace/agents or /api/v1/agents/hire): a second call with the same id hires nothing more.';

ALTER TABLE pm.agent_hire_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.agent_hire_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.agent_hire_requests TO service_role;

-- ---------------------------------------------------------------------------
-- Agent analytics: runs still going are counted apart (a 15th group value)
-- ---------------------------------------------------------------------------
-- Agents > Analytics read "15 runs, 100% succeeded" with 14 still running:
-- each group now also carries how many of its runs are running or waiting,
-- appended as the last value, so a previous release's code reads it as before.
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
        when f.status in ('running', 'waiting') then f.status
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
      count(*) filter (where verdict in ('running', 'waiting')) as running,
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
           coalesce(c.runs_no_tokens, 0) as runs_no_tokens,
           coalesce(c.running, 0) as running
    from counts c
    full join busy b on b.agent_id = c.agent_id and b.project_id is not distinct from c.project_id
      and b.model is not distinct from c.model and b.provider is not distinct from c.provider and b.day = c.day
  ),
  spend as (
    select f.agent_id, f.project_id, f.model, f.provider, (f.at at time zone p_tz)::date as day, f.labels, f.principal_id,
           sum(f.tokens_in) as tokens_in, sum(f.tokens_out) as tokens_out, sum(f.tokens_cached) as tokens_cached,
           coalesce(sum(f.cost_usd), 0) as cost_usd,
           coalesce(sum(f.tokens_in + f.tokens_out + f.tokens_cached) filter (where f.cost_usd is null), 0) as unpriced_tokens
    from agent_spend_facts(p_start::timestamp at time zone p_tz, (p_end + 1)::timestamp at time zone p_tz, null) f
    group by f.agent_id, f.project_id, f.model, f.provider, (f.at at time zone p_tz)::date, f.labels, f.principal_id
  )
  select jsonb_build_object(
    'groups', coalesce((
      select jsonb_agg(jsonb_build_array(g.agent_id, g.project_id, g.model, g.provider, to_char(g.day, 'YYYY-MM-DD'),
        g.runs, g.succeeded, g.failed, g.busy_ms, g.tokens_in, g.tokens_out, g.cost_usd, g.unpriced_tokens, g.runs_no_tokens, g.running))
      from grouped g
    ), '[]'::jsonb),
    'failures', coalesce((
      select jsonb_agg(jsonb_build_array(r.agent_id, r.project_id, r.model, r.provider, r.started_at, r.title, r.status)
        order by r.started_at)
      from runs r
      where r.verdict = 'failure'
    ), '[]'::jsonb),
    'spend', coalesce((
      select jsonb_agg(jsonb_build_array(sp.agent_id, sp.project_id, sp.model, sp.provider, to_char(sp.day, 'YYYY-MM-DD'),
        to_jsonb(sp.labels), sp.tokens_in, sp.tokens_out, sp.tokens_cached, sp.cost_usd, sp.unpriced_tokens, sp.principal_id))
      from spend sp
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION pm.agent_run_stats(date, date, text, uuid[], timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pm.agent_run_stats(date, date, text, uuid[], timestamptz) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Time zones: a person's profile zone is the one the app uses
-- ---------------------------------------------------------------------------
-- Every profile started as UTC, so a stored UTC could not tell "chosen" from
-- "never set". timezone_set says the person chose it (or their first sign-in
-- took it from the browser); until then the app uses the browser's zone and
-- the first sign-in saves it. A zone other than UTC was chosen by someone.
ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS timezone_set boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pm.team_members.timezone_set IS
  'The time zone was chosen (in Settings, or from the browser on first sign-in); false while it is the default.';

UPDATE pm.team_members SET timezone_set = true WHERE NOT timezone_set AND timezone IS DISTINCT FROM 'UTC';

-- A change to the zone from any path (the app, the API) makes it chosen.
CREATE OR REPLACE FUNCTION pm.team_members_mark_timezone_set()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.timezone_set := NEW.timezone_set OR NEW.timezone IS DISTINCT FROM 'UTC';
  ELSIF NEW.timezone IS DISTINCT FROM OLD.timezone THEN
    NEW.timezone_set := true;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.team_members_mark_timezone_set() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS team_members_mark_timezone_set ON pm.team_members;
CREATE TRIGGER team_members_mark_timezone_set
  BEFORE INSERT OR UPDATE OF timezone ON pm.team_members
  FOR EACH ROW EXECUTE FUNCTION pm.team_members_mark_timezone_set();
