-- Delivery and usage telemetry are typed agent events. Legacy rows remain
-- valid, while the API owns payload validation and server-composed titles.
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
    'pr.merged', 'usage.recorded',
    'review.started', 'review.verdict',
    'audit.finding', 'audit.no_work', 'spec.completed',
    'queue.empty', 'blocked',
    'billing.started', 'billing.paused', 'billing.resumed', 'billing.stopped'
  ));

-- Publishers retry after ambiguous network failures; the API's
-- select-then-insert pre-check alone leaves a race window between concurrent
-- retries. These make the natural source identities unique at the database,
-- so a lost response can never duplicate history. Exact-string uniqueness on
-- pr_url is intentional: syntactic URL variants are deduplicated downstream
-- by the analytics read model.
create unique index if not exists idx_agent_activities_usage_identity
  on public.agent_activities (agent_id, (metadata->>'source_usage_id'))
  where activity_type = 'usage.recorded' and metadata->>'source_usage_id' is not null;

create unique index if not exists idx_agent_activities_merged_pr_identity
  on public.agent_activities (agent_id, (metadata->>'pr_url'))
  where activity_type = 'pr.merged' and metadata->>'pr_url' is not null;
