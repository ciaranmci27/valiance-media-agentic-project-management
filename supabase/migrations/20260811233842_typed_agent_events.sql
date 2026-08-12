-- Typed agent events: the activity feed's vocabulary becomes a contract.
--
-- The old CHECK allowed 13 broad types plus `custom`, and the fleet's real
-- vocabulary (reviews, verdicts, hand-offs, blocked, no-work reports) fit
-- none of them, so 259 of the last 500 rows were `custom` prose parsed by
-- regexes downstream. The expanded enum admits the typed vocabulary defined
-- in src/lib/agent-events.ts; payload validation and server-side title
-- generation live at the API layer, which is the single writer.
--
-- Legacy values stay valid forever: historical rows are immutable, and the
-- constraint must keep passing them. `custom` also remains at the DB layer
-- (the API stops accepting it from agent keys once the fleet's plugins are
-- updated); dropping it here would fail validation over existing rows for
-- no operational gain.
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
    'review.started', 'review.verdict',
    'audit.finding', 'audit.no_work', 'spec.completed',
    'queue.empty', 'blocked',
    'billing.started', 'billing.paused', 'billing.resumed', 'billing.stopped'
  ));
