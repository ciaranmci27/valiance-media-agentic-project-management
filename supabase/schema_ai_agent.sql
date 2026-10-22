-- ============================================================
-- AGENTIC WORKFLOW SYSTEM MIGRATION
-- Run after schema.sql
-- ============================================================

-- 1a. Add 'agent' role to team_members
ALTER TABLE public.team_members
  DROP CONSTRAINT IF EXISTS team_members_role_check,
  ADD CONSTRAINT team_members_role_check CHECK (role IN ('admin', 'member', 'guest', 'agent'));

-- 1b. Add team_member_id to api_keys (links API key to an agent member)
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_team_member_id ON public.api_keys(team_member_id);

-- 1c. Add 'suggestion', 'goal', and 'question' to team_member_notifications entity_type
-- (the full current list, same as schema.sql: 'invoice' and 'reminder' came later).
ALTER TABLE public.team_member_notifications
  DROP CONSTRAINT IF EXISTS team_member_notifications_entity_type_check;
ALTER TABLE public.team_member_notifications
  ADD CONSTRAINT team_member_notifications_entity_type_check
    CHECK (entity_type IN ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question', 'invoice', 'reminder'));

-- ============================================================
-- 2. PROJECT GOALS
-- ============================================================
CREATE TABLE public.project_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  target_date text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'paused', 'abandoned')),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_goals_project_id ON public.project_goals(project_id);
CREATE INDEX idx_project_goals_status ON public.project_goals(status);
CREATE INDEX idx_project_goals_archived_at ON public.project_goals(archived_at) WHERE archived_at IS NULL;

ALTER TABLE public.project_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_goals_all" ON public.project_goals FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER set_project_goals_updated_at BEFORE UPDATE ON public.project_goals FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================
-- 3. TASK SUGGESTIONS
-- ============================================================
CREATE TABLE public.task_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL REFERENCES public.project_goals(id) ON DELETE CASCADE,
  proposed_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  assigned_to uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text NOT NULL,
  reasoning text NOT NULL,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  effort_estimate text CHECK (effort_estimate IN ('small', 'medium', 'large') OR effort_estimate IS NULL),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'needs_info', 'approved', 'rejected', 'declined')),
  reviewed_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  rejection_reason text,
  info_request text,
  converted_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
,
  -- Bundle membership: a shared key, nothing more. Members stay atomic;
  -- approving a subset composes ONE task. NULL means unbundled.
  bundle_key uuid);

CREATE INDEX idx_task_suggestions_project_id ON public.task_suggestions(project_id);
CREATE INDEX idx_task_suggestions_bundle ON public.task_suggestions(bundle_key) WHERE bundle_key IS NOT NULL;
CREATE INDEX idx_task_suggestions_goal_id ON public.task_suggestions(goal_id);
CREATE INDEX idx_task_suggestions_proposed_by ON public.task_suggestions(proposed_by);
CREATE INDEX idx_task_suggestions_status ON public.task_suggestions(status);
CREATE INDEX idx_task_suggestions_converted_task_id ON public.task_suggestions(converted_task_id) WHERE converted_task_id IS NOT NULL;

ALTER TABLE public.task_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "task_suggestions_all" ON public.task_suggestions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER set_task_suggestions_updated_at BEFORE UPDATE ON public.task_suggestions FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================
-- 4. Add goal_id and source_task_suggestion_id to tasks
-- ============================================================
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS project_goal_id uuid REFERENCES public.project_goals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_task_suggestion_id uuid REFERENCES public.task_suggestions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_project_goal_id ON public.tasks(project_goal_id) WHERE project_goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_source_task_suggestion_id ON public.tasks(source_task_suggestion_id) WHERE source_task_suggestion_id IS NOT NULL;

-- ============================================================
-- 5. AGENT ACTIVITY
-- ============================================================
CREATE TABLE public.agent_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null only for a fleet host alert, which names no agent (see the check below).
  agent_id uuid REFERENCES public.team_members(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  -- Legacy values are grandfathered; the typed vocabulary is owned by
  -- src/lib/agent-events.ts (payload schemas + server-generated titles).
  activity_type text NOT NULL CHECK (activity_type IN (
    'suggestion_created', 'task_started', 'task_completed', 'task_failed',
    'research_started', 'research_completed', 'suggestion_reviewed',
    'comment_added', 'status_changed',
    'agent_spawned', 'agent_completed', 'agent_failed',
    'heartbeat', 'system_check',
    'custom',
    'work.claimed', 'work.milestone', 'work.handoff', 'work.done',
    'pr.merged', 'usage.recorded', 'turn.completed',
    'review.started', 'review.verdict',
    'audit.finding', 'audit.no_work', 'spec.completed',
    'queue.empty', 'blocked',
    'billing.started', 'billing.paused', 'billing.resumed', 'billing.stopped',
    -- composed by the server at inbox triage (20261006010922_email_inboxes)
    'email.triaged',
    -- host telemetry (20261010210652_agent_telemetry)
    'turn.outcome', 'turn.failed', 'agent.restarted', 'attention.message',
    'dispatch.wake', 'billing.gap', 'eval.result'
  )),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  reference_type text,
  reference_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  -- Retry-safe identity of a host telemetry record (src/lib/agent-telemetry-ingest.ts).
  source_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_activities_agent_or_fleet_alert CHECK (
    agent_id IS NOT NULL
    OR (activity_type = 'attention.message' AND metadata->>'kind' = 'host_alert')
  )
);

CREATE INDEX idx_agent_activities_agent_id ON public.agent_activities(agent_id);
CREATE INDEX idx_agent_activities_project_id ON public.agent_activities(project_id);
CREATE INDEX idx_agent_activities_activity_type ON public.agent_activities(activity_type);
CREATE INDEX idx_agent_activities_created_at ON public.agent_activities(created_at DESC);
-- Retry-safe identity for events whose source can resend after an ambiguous
-- network failure. Exact-string pr_url uniqueness is intentional; syntactic
-- variants are deduplicated downstream by the analytics read model.
CREATE UNIQUE INDEX idx_agent_activities_usage_identity ON public.agent_activities(agent_id, (metadata->>'source_usage_id'))
  WHERE activity_type = 'usage.recorded' AND metadata->>'source_usage_id' IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_activities_merged_pr_identity ON public.agent_activities(agent_id, (metadata->>'pr_url'))
  WHERE activity_type = 'pr.merged' AND metadata->>'pr_url' IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_activities_turn_identity ON public.agent_activities(agent_id, (metadata->>'source_turn_id'))
  WHERE activity_type = 'turn.completed' AND metadata->>'source_turn_id' IS NOT NULL;
-- One identity space for host records; fleet rows share the zero uuid.
CREATE UNIQUE INDEX idx_agent_activities_source_identity ON public.agent_activities(
  COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), activity_type, source_key)
  WHERE source_key IS NOT NULL;
-- Runtime rollups read one agent's turns over a date window.
CREATE INDEX idx_agent_activities_turn_created ON public.agent_activities(agent_id, created_at DESC)
  WHERE activity_type = 'turn.completed';

ALTER TABLE public.agent_activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_activities_all" ON public.agent_activities FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Agent Analytics in one round trip (20261011033458_agent_analytics_window.sql).
-- Range reads by type: every branch below filters activity_type then created_at.
CREATE INDEX idx_agent_activities_type_created
  on public.agent_activities (activity_type, created_at desc);

-- Resend lookups for host records match agent, type and source_key exactly.
CREATE INDEX idx_agent_activities_agent_source_key
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

-- Billing gap reviews (20261010212024_agent_analytics_reviews.sql). The billing audit posts each stretch of Jeff's work
-- that no time entry segment covers (agent_activities, billing.gap). Ciaran
-- marks each one reconciled (he logged the time) or dismissed (it was not
-- billable), with a note. A review never creates or changes a time entry, and
-- the gap row itself stays immutable telemetry.
CREATE TABLE public.agent_billing_gap_reviews (
  activity_id uuid primary key references public.agent_activities(id) on delete cascade,
  status text not null check (status in ('reconciled', 'dismissed')),
  note text not null default '' check (char_length(note) <= 1000),
  reviewed_by uuid references public.team_members(id) on delete set null,
  reviewed_at timestamptz not null default now()
);

alter table public.agent_billing_gap_reviews enable row level security;

create policy agent_billing_gap_reviews_access on public.agent_billing_gap_reviews for all to authenticated
  using (public.has_permission('agents.manage'))
  with check (public.has_permission('agents.manage'));

grant select, insert, update, delete on public.agent_billing_gap_reviews to authenticated;

-- Who reviewed and when is the database's to say, not the client's.
create or replace function public.stamp_billing_gap_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.reviewed_by := public.current_team_member_id();
  new.reviewed_at := now();
  return new;
end;
$$;

revoke all on function public.stamp_billing_gap_review() from public;

create trigger stamp_billing_gap_review
  before insert or update on public.agent_billing_gap_reviews
  for each row execute function public.stamp_billing_gap_review();

-- ============================================================
-- 6. API AUDIT LOG (NOT gated behind ENABLE_AGENTS)
-- ============================================================
CREATE TABLE public.api_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  endpoint text NOT NULL,
  entity_type text,
  entity_id uuid,
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  request_body jsonb,
  before_snapshot jsonb,
  after_snapshot jsonb,
  status_code integer NOT NULL,
  error text,
  -- app: a Trash move or restore in the app, written by the database.
  via text NOT NULL DEFAULT 'rest' CHECK (via IN ('rest', 'mcp', 'app'))
);

CREATE INDEX idx_api_audit_log_timestamp ON public.api_audit_log(timestamp DESC);
CREATE INDEX idx_api_audit_log_entity ON public.api_audit_log(entity_type, entity_id);
CREATE INDEX idx_api_audit_log_team_member ON public.api_audit_log(team_member_id);
CREATE INDEX idx_api_audit_log_api_key ON public.api_audit_log(api_key_id);

ALTER TABLE public.api_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_audit_log_all" ON public.api_audit_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 7. AUTONOMOUS MODE FOR PROJECTS
-- ============================================================
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS autonomous_enabled boolean NOT NULL DEFAULT false;

-- ============================================================
-- 8. TASK TYPE FOR TASKS AND SUGGESTIONS
-- ============================================================
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS task_type text
    CHECK (task_type IN ('engineering','research','audit','marketing','copywriting','operations','general') OR task_type IS NULL);

ALTER TABLE public.task_suggestions
  ADD COLUMN IF NOT EXISTS task_type text
    CHECK (task_type IN ('engineering','research','audit','marketing','copywriting','operations','general') OR task_type IS NULL);

-- ============================================================
-- 9. (RETIRED 2026-08-04) AI MANAGED FLAG FOR TASKS
-- ============================================================
-- ai_managed was superseded by tasks.ai_readiness (see schema.sql)
-- and the column was dropped. Kept as a numbered section so later sections'
-- numbering stays stable in diffs.

-- ============================================================
-- 10. DEPLOYMENT POLICY FOR PROJECTS
-- ============================================================
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS deployment_policy text NOT NULL DEFAULT 'production'
    CHECK (deployment_policy IN ('playground', 'production'));

-- ------------------------------------------------------------
-- Soft delete (migration 20261022035227_soft_delete_records.sql):
-- what belongs to a project in Trash is out of reach with it.
-- project_is_live() is defined in schema.sql.
-- ------------------------------------------------------------
CREATE POLICY project_goals_parent_live ON public.project_goals AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY task_suggestions_parent_live ON public.task_suggestions AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY agent_activities_parent_live ON public.agent_activities AS RESTRICTIVE FOR ALL TO authenticated
  USING (project_id IS NULL OR public.project_is_live(project_id));
