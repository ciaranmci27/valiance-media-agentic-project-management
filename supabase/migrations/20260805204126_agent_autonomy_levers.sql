-- Per-project autonomy levers, replacing config that lived in agent
-- containers, in hardcoded prompts, or nowhere at all.
--
-- The failure this fixes, observed live on 2026-08-05: suggestions_per_cycle
-- was visible in the UI but read by no code, while Greg's real cap was a
-- container env var. He saw the number 3, inferred it was his queue cap, and
-- skipped three consecutive audit cycles with six unused questions. A visible
-- lever wired to nothing is worse than no lever.
--
-- Semantics (the agents obey these verbatim):
--   auto_merge_enabled    may jeff-automerge merge on this project at all.
--                         Off by default: every client starts with human
--                         merges and earns automation per project.
--   integration_branch    where the dev agent clones from, branches from,
--                         and PRs into; the ONLY branch the merge gate may
--                         merge into.
--   production_branch     a declaration, not a workflow: this branch ships
--                         to users. The gate refuses it unconditionally.
--                         When it equals integration_branch (single-branch
--                         repo), auto-merge is structurally impossible.
--   suggestion_queue_cap  how many suggestions may sit awaiting review
--                         (pending + needs_info) before the auditor stops
--                         proposing on this project. The backpressure dial.
--   audit_interval_hours  minimum gap between audit cycles on this project.
--                         The auditor's cron keeps firing globally; a project
--                         is eligible only when its last cycle is older than
--                         this. Replaces the hardcoded 12-hour freshness rule.
alter table public.projects
  add column if not exists auto_merge_enabled boolean not null default false,
  add column if not exists integration_branch text not null default 'dev',
  add column if not exists production_branch text not null default 'main',
  add column if not exists suggestion_queue_cap integer not null default 10,
  add column if not exists audit_interval_hours integer not null default 4;

alter table public.projects
  add constraint projects_suggestion_queue_cap_check
    check (suggestion_queue_cap > 0),
  add constraint projects_audit_interval_hours_check
    check (audit_interval_hours > 0),
  add constraint projects_integration_branch_check
    check (length(trim(integration_branch)) > 0),
  add constraint projects_production_branch_check
    check (length(trim(production_branch)) > 0);

-- Remove the two fields that existed only to mislead. deployment_policy
-- offered a "Playground: commits to main directly" mode no agent honors (the
-- dev agent's pre-push hook structurally forbids it); its only real effect was
-- a badge. max_concurrent_tasks was read by nothing: the dev agent is serial
-- across all projects by design. Same principle as dropping ai_managed:
-- config nothing reads must not exist where it can mislead again.
alter table public.projects
  drop column if exists deployment_policy,
  drop column if exists max_concurrent_tasks;
