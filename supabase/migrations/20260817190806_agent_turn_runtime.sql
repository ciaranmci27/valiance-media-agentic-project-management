-- Agent runtime is an internal capacity metric: how long the fleet actually ran.
-- It never bills a client and never creates a time entry; only Jeff bills, and
-- only through project_time_entries tied to real client work. This is telemetry
-- the analytics read model aggregates, nothing more.
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
    -- typed vocabulary (src/lib/agent-events.ts owns payloads and titles)
    'work.claimed', 'work.milestone', 'work.handoff', 'work.done',
    'pr.merged', 'usage.recorded', 'turn.completed',
    'review.started', 'review.verdict',
    'audit.finding', 'audit.no_work', 'spec.completed',
    'queue.empty', 'blocked',
    'billing.started', 'billing.paused', 'billing.resumed', 'billing.stopped'
  ));

-- The publisher retries after ambiguous network failures and replays its whole
-- ledger on a lost checkpoint. Uniqueness on the source turn identity makes a
-- duplicate physically impossible, so runtime totals cannot drift upward from
-- retries the way a select-then-insert pre-check alone would allow.
create unique index if not exists idx_agent_activities_turn_identity
  on public.agent_activities (agent_id, (metadata->>'source_turn_id'))
  where activity_type = 'turn.completed' and metadata->>'source_turn_id' is not null;

-- Analytics reads runtime by agent over a date window; without this the daily
-- rollup degrades to a sequential scan as turn history accumulates.
create index if not exists idx_agent_activities_turn_created
  on public.agent_activities (agent_id, created_at desc)
  where activity_type = 'turn.completed';
