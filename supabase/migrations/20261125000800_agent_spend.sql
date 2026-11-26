-- ============================================================
-- SPEND, COUNTED ONCE (20261125000800_agent_spend.sql)
-- What an agent spent, counted once and the same way everywhere: the
-- budget (pm.agent_limit_state) and Analytics (pm.agent_run_stats) both
-- read pm.agent_spend_facts. Work under a run counts as the run's own
-- totals; usage.recorded and turn.completed rows that name a run are
-- never added again; usage and turns that name no run add on top.
-- ============================================================

-- ---------------------------------------------------------------------------
-- Usage by run and by agent and time
-- ---------------------------------------------------------------------------
-- A run's usage: usage.recorded rows the server attached to it (run_id).
CREATE INDEX IF NOT EXISTS idx_agent_activities_usage_run ON pm.agent_activities ((metadata->>'run_id'))
  WHERE activity_type = 'usage.recorded' AND metadata->>'run_id' IS NOT NULL;
-- The budget reads one agent's usage over its period.
CREATE INDEX IF NOT EXISTS idx_agent_activities_usage_created ON pm.agent_activities (agent_id, created_at DESC)
  WHERE activity_type = 'usage.recorded';

-- ---------------------------------------------------------------------------
-- Spend facts: one row per thing that counts, in a window [p_from, p_to)
-- ---------------------------------------------------------------------------
-- The only place the counting rule lives:
-- - A stored run counts where it started (started_at). Its cost is its own
--   cost_usd when above 0, else the cost of the usage rows attached to it.
--   Its tokens are its own tokens_in and tokens_out when they add up to
--   more than 0, else its attached usage's tokens, else (for an agent
--   without a usage ledger in the window) its attached turns' own tokens.
--   A run stored with 0 never hides what is attached to it.
-- - usage.recorded that names a run (metadata.run_id, kept by the server
--   only when it names one of the agent's runs) is part of that run and
--   never adds again. Usage that names no run adds on its own, at
--   recorded_at (else created_at). Rows written before usage could name a
--   run carry none, so they add on their own.
-- - turn.completed that names a run is part of that run. A turn that names
--   no run adds its own tokens (tokens_scope turn), at its started_at, only
--   for an agent with no usage.recorded in the window: the host publisher
--   reports the same turns as usage, and the ledger is the measure.
-- - Cost above 0 is priced; cost 0 or none is unpriced (cost_usd null),
--   never a real zero spend.
-- - principal_id is the person the work was for: a run's own, a usage or
--   turn row's own (X-Act-For); null when the agent worked as itself.
-- Security invoker: Analytics reads it as the caller (row policies apply);
-- the budget reads it inside pm.agent_limit_state.
CREATE OR REPLACE FUNCTION pm.agent_spend_facts(p_from timestamptz, p_to timestamptz, p_agent_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  source text,
  source_id text,
  agent_id uuid,
  project_id uuid,
  model text,
  provider text,
  labels text[],
  at timestamptz,
  tokens_in bigint,
  tokens_out bigint,
  tokens_cached bigint,
  cost_usd numeric,
  principal_id uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pm
AS $$
  with usage_in as (
    select a.id, a.agent_id, a.project_id, a.labels, a.metadata as m, a.principal_id,
           coalesce(agent_analytics_ts(a.metadata->>'recorded_at'), a.created_at) as at
    from agent_activities a
    where a.activity_type = 'usage.recorded'
      and a.agent_id is not null
      and a.created_at >= p_from - interval '1 day'
      and (p_agent_ids is null or a.agent_id = any (p_agent_ids))
      and coalesce(agent_analytics_ts(a.metadata->>'recorded_at'), a.created_at) >= p_from
      and coalesce(agent_analytics_ts(a.metadata->>'recorded_at'), a.created_at) < p_to
  ),
  ledger as (
    select distinct u.agent_id from usage_in u
  ),
  runs as (
    select r.id, r.agent_id, r.project_id, r.model, r.provider, r.started_at, r.tokens_in, r.tokens_out, r.cost_usd, r.principal_id
    from agent_runs r
    where r.started_at >= p_from and r.started_at < p_to
      and (p_agent_ids is null or r.agent_id = any (p_agent_ids))
  ),
  run_usage as (
    select r.id,
           sum(agent_analytics_int(a.metadata->>'input_tokens')) as tin,
           sum(agent_analytics_int(a.metadata->>'output_tokens')) as tout,
           sum(agent_analytics_int(a.metadata->>'cached_tokens')) as tcached,
           sum(agent_analytics_num(a.metadata->>'cost_usd')) filter (where agent_analytics_num(a.metadata->>'cost_usd') > 0) as cost
    from runs r
    join agent_activities a on a.metadata->>'run_id' = r.id::text and a.agent_id = r.agent_id
    where a.activity_type = 'usage.recorded'
    group by r.id
  ),
  run_turns as (
    select r.id,
           sum(agent_analytics_int(a.metadata->'tokens'->>'input')) filter (where a.metadata->'tokens' ? 'input') as tin,
           sum(agent_analytics_int(a.metadata->'tokens'->>'output')) filter (where a.metadata->'tokens' ? 'output') as tout
    from runs r
    join agent_activities a on a.metadata->>'run_id' = r.id::text and a.agent_id = r.agent_id
    where a.activity_type = 'turn.completed'
      and a.metadata->>'tokens_scope' = 'turn'
      and coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0) = 0
    group by r.id
  )
  select 'run'::text, r.id::text, r.agent_id, r.project_id, r.model, r.provider, '{}'::text[], r.started_at,
    (case when coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0) > 0 then coalesce(r.tokens_in, 0)
          when u.id is not null then coalesce(u.tin, 0)
          when l.agent_id is null then coalesce(t.tin, 0)
          else 0 end)::bigint,
    (case when coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0) > 0 then coalesce(r.tokens_out, 0)
          when u.id is not null then coalesce(u.tout, 0)
          when l.agent_id is null then coalesce(t.tout, 0)
          else 0 end)::bigint,
    (case when coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0) > 0 then 0
          when u.id is not null then coalesce(u.tcached, 0)
          else 0 end)::bigint,
    case when r.cost_usd > 0 then r.cost_usd else u.cost end,
    r.principal_id
  from runs r
  left join run_usage u on u.id = r.id
  left join run_turns t on t.id = r.id
  left join ledger l on l.agent_id = r.agent_id
  union all
  select 'usage'::text, u.id::text, u.agent_id, u.project_id, u.m->>'model', u.m->>'provider', coalesce(u.labels, '{}'::text[]), u.at,
    agent_analytics_int(u.m->>'input_tokens')::bigint,
    agent_analytics_int(u.m->>'output_tokens')::bigint,
    agent_analytics_int(u.m->>'cached_tokens')::bigint,
    case when agent_analytics_num(u.m->>'cost_usd') > 0 then agent_analytics_num(u.m->>'cost_usd') end,
    u.principal_id
  from usage_in u
  where u.m->>'run_id' is null
  union all
  select 'turn'::text, a.id::text, a.agent_id, a.project_id, a.metadata->>'model', null::text, '{}'::text[],
    coalesce(agent_analytics_ts(a.metadata->>'started_at'), a.created_at),
    (case when a.metadata->'tokens' ? 'input' then agent_analytics_int(a.metadata->'tokens'->>'input') else 0 end)::bigint,
    (case when a.metadata->'tokens' ? 'output' then agent_analytics_int(a.metadata->'tokens'->>'output') else 0 end)::bigint,
    0::bigint,
    null::numeric,
    a.principal_id
  from agent_activities a
  where a.activity_type = 'turn.completed'
    and a.agent_id is not null
    and a.metadata->>'tokens_scope' = 'turn'
    and (a.metadata->'tokens' ? 'input' or a.metadata->'tokens' ? 'output')
    and a.metadata->>'run_id' is null
    and a.created_at >= p_from - interval '1 day'
    and (p_agent_ids is null or a.agent_id = any (p_agent_ids))
    and coalesce(agent_analytics_ts(a.metadata->>'started_at'), a.created_at) >= p_from
    and coalesce(agent_analytics_ts(a.metadata->>'started_at'), a.created_at) < p_to
    and not exists (select 1 from ledger l where l.agent_id = a.agent_id)
$$;

REVOKE ALL ON FUNCTION pm.agent_spend_facts(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pm.agent_spend_facts(timestamptz, timestamptz, uuid[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Spend per agent in a window: the facts summed. spent_tokens is input plus
-- output (what budget_tokens caps); unpriced_tokens are the tokens of facts
-- with no cost above 0. Server only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.agent_spend(p_from timestamptz, p_to timestamptz, p_agent_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  agent_id uuid,
  spent_usd numeric,
  spent_tokens bigint,
  tokens_in bigint,
  tokens_out bigint,
  tokens_cached bigint,
  unpriced_tokens bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pm
AS $$
  select f.agent_id,
         coalesce(sum(f.cost_usd), 0),
         coalesce(sum(f.tokens_in + f.tokens_out), 0)::bigint,
         coalesce(sum(f.tokens_in), 0)::bigint,
         coalesce(sum(f.tokens_out), 0)::bigint,
         coalesce(sum(f.tokens_cached), 0)::bigint,
         coalesce(sum(f.tokens_in + f.tokens_out + f.tokens_cached) filter (where f.cost_usd is null), 0)::bigint
  from agent_spend_facts(p_from, p_to, p_agent_ids) f
  group by f.agent_id
$$;

REVOKE ALL ON FUNCTION pm.agent_spend(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_spend(timestamptz, timestamptz, uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- The budget: spend this period from pm.agent_spend (replaces the largest of
-- usage, runs and turns, which missed work reported one way beside other
-- work reported another).
-- ---------------------------------------------------------------------------
-- An agent's limits with what counts against them now: running runs and
-- live claims, and spend this budget period (UTC), counted by
-- pm.agent_spend. Without p_with_usage, only what the agent's limits need is
-- counted (nothing for an agent without limits), so the run and claim
-- checks stay cheap. Server only.
CREATE OR REPLACE FUNCTION pm.agent_limit_state(p_agent_id uuid, p_with_usage boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_limits pm.agent_limits%ROWTYPE;
  v_period text;
  v_from timestamptz;
  v_to timestamptz;
  v_spent_usd numeric := 0;
  v_spent_tokens bigint := 0;
  v_running integer := 0;
  v_claims integer := 0;
BEGIN
  SELECT * INTO v_limits FROM pm.agent_limits WHERE agent_id = p_agent_id;
  v_period := coalesce(v_limits.budget_period, 'month');
  v_from := date_trunc(v_period, now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_to := (date_trunc(v_period, now() AT TIME ZONE 'UTC') + ('1 ' || v_period)::interval) AT TIME ZONE 'UTC';
  IF p_with_usage OR v_limits.budget_usd IS NOT NULL OR v_limits.budget_tokens IS NOT NULL THEN
  SELECT coalesce(sum(s.spent_usd), 0), coalesce(sum(s.spent_tokens), 0)
    INTO v_spent_usd, v_spent_tokens
  FROM pm.agent_spend(v_from, v_to, ARRAY[p_agent_id]) s;
  END IF;
  IF p_with_usage OR v_limits.max_concurrent_runs IS NOT NULL THEN
  SELECT count(*) INTO v_running FROM pm.agent_runs r
  WHERE r.agent_id = p_agent_id AND r.status = 'running' AND r.updated_at > now() - interval '2 hours';
  SELECT count(*) INTO v_claims FROM pm.tasks t
  WHERE t.claimed_by = p_agent_id AND t.claim_expires_at > now() AND t.deleted_at IS NULL;
  END IF;
  RETURN jsonb_build_object(
    'limits', CASE WHEN v_limits.agent_id IS NULL THEN NULL ELSE jsonb_build_object(
      'max_concurrent_runs', v_limits.max_concurrent_runs,
      'rate_per_minute', v_limits.rate_per_minute,
      'budget_usd', v_limits.budget_usd,
      'budget_tokens', v_limits.budget_tokens,
      'budget_period', v_limits.budget_period,
      'budget_alerted_period', v_limits.budget_alerted_period) END,
    'period_start', v_from,
    'spent_usd', round(v_spent_usd, 4),
    'spent_tokens', v_spent_tokens,
    'running_runs', v_running,
    'live_claims', v_claims);
END;
$$;

REVOKE ALL ON FUNCTION pm.agent_limit_state(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.agent_limit_state(uuid, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Run aggregates for Analytics, now with spend: the run feed summed per
-- agent, project, model, provider and day (p_tz's calendar days from p_start
-- to p_end), read as the caller. The same rules as the screen's read model
-- (src/lib/agent-analytics-model.ts), so the two always agree:
-- - Runs are read where sort_at falls within a day either side of the range,
--   then placed on the day they started.
-- - Success and failure as the run pill reads them; a running run, or one
--   waiting on a person, is neither until it finishes.
-- - Busy time: each run keeps the part of its span no earlier run of the
--   same agent covers, so the parts add up to the union. With
--   p_project_ids, only those projects' runs clip against each other.
-- - A stored run that reports no tokens takes its attached turns' own
--   tokens. runs_no_tokens counts the stored runs still without any.
-- - Cost: a run's cost above 0, else its tokens are unpriced.
-- failures lists every failed run read (for incidents, which collapse
-- repeats across days).
-- spend is pm.agent_spend_facts over the range's days, summed per agent,
-- project, model, provider, day, labels and person: [agent, project, model,
-- provider, day, labels, tokens_in, tokens_out, tokens_cached, cost_usd,
-- unpriced_tokens, principal]. principal is who the work was for (null:
-- the agent worked as itself), so spend reads by person too. Analytics
-- takes tokens and cost from it alone, so its totals are the budget's
-- numbers whatever the range holds. groups keep their run-only tokens and
-- cost for the previous release's screens.
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
        g.runs, g.succeeded, g.failed, g.busy_ms, g.tokens_in, g.tokens_out, g.cost_usd, g.unpriced_tokens, g.runs_no_tokens))
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
