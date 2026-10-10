-- Honest agent telemetry (docs/12-telemetry.md in the agents repo).
--
-- Host publishers now label every turn with its outcome and report failures,
-- restarts, messages that reached Ciaran, dispatcher wakes, billing gaps and
-- eval runs. They post through POST /api/v1/agent-activities with each
-- agent's own key; fleet-wide host alerts post with the dispatcher's key and
-- belong to no agent. Safe to re-run.

-- 1. The vocabulary (src/lib/agent-events.ts owns payloads and titles).
alter table public.agent_activities
  drop constraint if exists agent_activities_activity_type_check;

alter table public.agent_activities
  add constraint agent_activities_activity_type_check check (activity_type in (
    -- legacy vocabulary, grandfathered
    'suggestion_created', 'task_started', 'task_completed', 'task_failed',
    'research_started', 'research_completed', 'suggestion_reviewed',
    'comment_added', 'status_changed',
    'agent_spawned', 'agent_completed', 'agent_failed',
    'heartbeat', 'system_check',
    'custom',
    -- typed vocabulary
    'work.claimed', 'work.milestone', 'work.handoff', 'work.done',
    'pr.merged', 'usage.recorded', 'turn.completed',
    'review.started', 'review.verdict',
    'audit.finding', 'audit.no_work', 'spec.completed',
    'queue.empty', 'blocked',
    'billing.started', 'billing.paused', 'billing.resumed', 'billing.stopped',
    'email.triaged',
    -- host telemetry
    'turn.outcome', 'turn.failed', 'agent.restarted', 'attention.message',
    'dispatch.wake', 'billing.gap', 'eval.result'
  ));

-- 2. Fleet host alerts (PM API down, the watchdog digest) name no agent.
-- Attributing them to the member the dispatcher key is linked to would be a
-- lie, so they are the one row kind allowed to carry no agent.
alter table public.agent_activities
  alter column agent_id drop not null;

alter table public.agent_activities
  drop constraint if exists agent_activities_agent_or_fleet_alert;

alter table public.agent_activities
  add constraint agent_activities_agent_or_fleet_alert check (
    agent_id is not null
    or (activity_type = 'attention.message' and metadata->>'kind' = 'host_alert')
  );

-- 3. One retry-safe identity for host records, so a resend after an
-- ambiguous network failure can never store an event twice and a new record
-- type never needs its own index. Fleet rows (no agent) share one identity
-- space through the zero uuid.
alter table public.agent_activities
  add column if not exists source_key text;

create unique index if not exists idx_agent_activities_source_identity
  on public.agent_activities (
    coalesce(agent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    activity_type,
    source_key
  )
  where source_key is not null;

-- 4. The scope a host key needs to post fleet alerts. Granted to the agent
-- role on the api channel so it can be put on the dispatcher's key (linked
-- to an agent member); no key receives it automatically.
insert into public.role_permissions (role, permission_key, access_channel) values
  ('agent', 'fleet_alerts.write', 'api')
on conflict do nothing;
