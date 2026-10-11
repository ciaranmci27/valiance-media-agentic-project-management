-- Agent Analytics in one round trip. Safe to re-run.
--
-- The page used to read every raw activity row in its range from the browser,
-- 1,000 at a time in sequence (about 17 requests and 10 MB for 30 days, and
-- growing with every turn). This function returns the same facts compactly in
-- one call: turns projected to the fields the read model uses, usage summed
-- per agent, project and hour (hours keep every whole-hour timezone's days
-- exact), the raw usage deltas only for directed sessions (token attribution
-- needs them), and every other event with its payload. The read model in
-- src/lib/agent-telemetry-analytics.ts still does all the arithmetic, so the
-- rules live in one place; a test pins that both paths give the same numbers.

-- Range reads by type: every branch below filters activity_type then created_at.
create index if not exists idx_agent_activities_type_created
  on public.agent_activities (activity_type, created_at desc);

-- Resend lookups for host records match agent, type and source_key exactly.
create index if not exists idx_agent_activities_agent_source_key
  on public.agent_activities (agent_id, activity_type, source_key)
  where source_key is not null;

-- A timestamp from a payload, or null when it does not parse, so one odd row
-- can never fail the whole report.
create or replace function public.agent_analytics_ts(p_value text)
returns timestamptz
language plpgsql
stable
as $$
begin
  return p_value::timestamptz;
exception when others then
  return null;
end;
$$;

-- A non-negative integer from a payload, or 0.
create or replace function public.agent_analytics_int(p_value text)
returns bigint
language plpgsql
immutable
as $$
begin
  return greatest(coalesce(p_value::numeric, 0), 0)::bigint;
exception when others then
  return 0;
end;
$$;

create or replace function public.agent_analytics_num(p_value text)
returns numeric
language plpgsql
immutable
as $$
begin
  return greatest(coalesce(p_value::numeric, 0), 0);
exception when others then
  return 0;
end;
$$;

-- p_from / p_to bound the range (the caller widens them a day for timezones);
-- p_late_to extends the read for telemetry recorded after the range (backfills
-- post rows weeks after the event they describe). Security invoker: the
-- caller's row-level security applies exactly as it does to a plain select.
create or replace function public.agent_analytics_window(p_from timestamptz, p_to timestamptz, p_late_to timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with turns as (
    select a.id, a.agent_id, a.created_at, a.metadata as m
    from agent_activities a
    where a.activity_type = 'turn.completed'
      and a.created_at >= p_from and a.created_at <= p_late_to
  ),
  usage_rows as (
    select a.agent_id, a.project_id, a.metadata as m,
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
    -- [id, agent, created_at, source_turn_id, origin, duration_ms, started_at,
    --  outcome, outcome_source, job_name, trigger, session_id (directed only),
    --  model, tokens_scope, turn tokens (input + output + cache read + write)]
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
        end
      ))
      from turns t
    ), '[]'::jsonb),
    -- [agent, project, hour, input, output, cached, cost_usd, deltas]
    'usage_hours', coalesce((
      select jsonb_agg(jsonb_build_array(h.agent_id, h.project_id, h.hour, h.input, h.output, h.cached, h.cost, h.deltas))
      from (
        select agent_id, project_id, date_trunc('hour', at) as hour,
               sum(agent_analytics_int(m->>'input_tokens')) as input,
               sum(agent_analytics_int(m->>'output_tokens')) as output,
               sum(agent_analytics_int(m->>'cached_tokens')) as cached,
               sum(agent_analytics_num(m->>'cost_usd')) as cost,
               count(*) as deltas
        from usage_rows
        where at >= p_from and at <= p_to
        group by agent_id, project_id, date_trunc('hour', at)
      ) h
    ), '[]'::jsonb),
    -- [agent, session_id, recorded_at, tokens] for directed sessions only.
    'session_usage', coalesce((
      select jsonb_agg(jsonb_build_array(u.agent_id, u.m->>'session_id', u.at,
        agent_analytics_int(u.m->>'input_tokens') + agent_analytics_int(u.m->>'output_tokens')
        + agent_analytics_int(u.m->>'cached_tokens')))
      from usage_rows u
      join directed_sessions d on d.agent_id = u.agent_id and d.session_id = u.m->>'session_id'
    ), '[]'::jsonb),
    -- Everything else, with its payload: narrative events in the range, and
    -- host records up to p_late_to.
    'events', coalesce((
      select jsonb_agg(jsonb_build_array(e.id, e.agent_id, e.project_id, e.activity_type, e.reference_id, e.created_at, e.metadata))
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

revoke all on function public.agent_analytics_window(timestamptz, timestamptz, timestamptz) from public;
grant execute on function public.agent_analytics_window(timestamptz, timestamptz, timestamptz) to authenticated, service_role;
