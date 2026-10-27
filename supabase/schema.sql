-- Valiance Media Full Schema
-- Run this in your Supabase SQL Editor

-- ============================================================
-- 1. TEAM MEMBERS (auto-created on auth signup, or manually added)
-- ============================================================
create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id) on delete set null,
  name text not null,
  email text not null,
  avatar text not null default '',
  role text not null default 'member' check (role in ('admin', 'member', 'guest', 'agent')),
  -- Display title shown wherever the member appears as an actor (e.g. the
  -- agent command center): "Auditor", "Developer". Data, not config.
  title text,
  timezone text not null default 'UTC',
  notification_prefs jsonb not null default '{}',
  email_notifications_enabled boolean not null default false,
  email_notification_prefs jsonb not null default '{}',
  theme_preference text check (theme_preference in ('light', 'dark')),
  -- Live floor viewer settings, keyed by device class:
  --   { "desktop": { "fov": 32, ... }, "mobile": { "fov": 78, ... } }
  -- Two profiles because the right values genuinely differ — a phone needs a
  -- much wider field of view and a thumb wants less look sensitivity than a
  -- mouse. Opaque to the server, which only stores and returns it.
  scene_preferences jsonb not null default '{}',
  -- Billing multiplier dial, snapshotted onto each time entry at session
  -- start. Agent sessions are converted at approval to one continuous slot
  -- of worked time times this. 1.00 = parity; humans are never converted.
  billing_multiplier numeric(4,2) not null default 1.00 check (billing_multiplier > 0),
  -- Which MCP tools an agent sees; the owner sets it in Team. It only narrows
  -- what the agent's key could do. See src/lib/mcp/profiles.ts.
  agent_profile text not null default 'generic'
    check (agent_profile in ('generic', 'coordinator', 'builder', 'auditor', 'reviewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 3. CONTACTS (replaces clients)
-- ============================================================
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null default '',
  phone text not null default '',
  company text not null default '',
  notes text not null default '',
  color text not null default '#6366F1',
  avatar_url text not null default '',
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 4. PROJECTS
-- ============================================================
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  color text not null default '#6366F1',
  status text not null default 'active' check (status in ('active', 'completed', 'archived')),
  start_date text,
  due_date text,
  hourly_tracking boolean not null default false,
  hourly_rate numeric(10,2) default null,
  budget_type text check (budget_type in ('hours', 'amount')),
  budget_value numeric(12,2),
  billing_address text,
  billing_email text,
  tax_rate numeric(5,2),
  invoice_pdf_options jsonb not null default '{
    "showLogo": true,
    "showTopAccent": true,
    "showStatusStamp": true,
    "showSenderName": true,
    "showLineCaptions": true,
    "showPortalLink": true,
    "showNotes": true,
    "showPaymentInstructions": true,
    "showFooter": true,
    "showTimeLogs": false
  }'::jsonb,
  autonomous_enabled boolean not null default false,
  -- Autonomy levers, all read by the agents (semantics in the 20260805204126
  -- migration): may the merge gate merge here; where the dev agent integrates;
  -- which branch ships to users (the gate refuses it, and equal branches make
  -- auto-merge structurally impossible); review-queue backpressure; and the
  -- minimum gap between audit cycles.
  auto_merge_enabled boolean not null default false,
  integration_branch text not null default 'dev' check (length(trim(integration_branch)) > 0),
  production_branch text not null default 'main' check (length(trim(production_branch)) > 0),
  suggestions_per_cycle integer not null default 3 check (suggestions_per_cycle <= suggestion_queue_cap),
  suggestion_queue_cap integer not null default 10 check (suggestion_queue_cap > 0),
  audit_interval_hours integer not null default 4 check (audit_interval_hours > 0),
  -- Case-insensitive regex over changed file paths: matches are never
  -- auto-merged (the gate holds them for a human), and the app forecasts
  -- task autonomy from the same pattern. One value, both consumers.
  sensitive_paths text not null default '(^|/)(migrations?|supabase/migrations)/|\.sql$|auth|permission|role|access|middleware|session|credential|secret|token|rls|billing|payment|invoice|stripe|payout|revenue|pdf|docx|document-generation|(^|/)email/|mailer|smtp|resend|sendgrid|twilio|sms|outbound|webhook',
  repo_path text,
  created_by uuid references public.team_members(id) on delete set null,
  archived_at timestamptz default null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 4b. PROJECT BUDGET HISTORY (append-only audit trail of budget changes)
-- ============================================================
create table public.project_budget_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  old_type text check (old_type in ('hours', 'amount')),
  new_type text check (new_type in ('hours', 'amount')),
  old_value numeric(12,2),
  new_value numeric(12,2),
  changed_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_project_budget_history_project
  on public.project_budget_history(project_id, created_at desc);

-- ============================================================
-- 5. PROJECT MEMBERS (junction: project <-> team_member)
-- ============================================================
create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  member_id uuid not null references public.team_members(id) on delete cascade,
  primary key (project_id, member_id)
);

-- ============================================================
-- 5b. PROJECT CONTACTS (junction: project <-> contact with roles)
-- ============================================================
create table public.project_contacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  role text not null default 'Stakeholder',
  custom_role text,
  is_primary_client boolean not null default false,
  created_at timestamptz not null default now(),
  unique (project_id, contact_id)
);

-- Only 1 primary client per project:
create unique index idx_project_contacts_primary_client
  on public.project_contacts (project_id) where is_primary_client = true;

-- ============================================================
-- 6. TASKS
-- ============================================================
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('backlog', 'todo', 'in_progress', 'in_review', 'done')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  due_date text,
  tags text[] not null default '{}',
  sort_order int not null default 0,
  created_by uuid references public.team_members(id) on delete set null,
  completed_at timestamptz,
  -- Who does the work. null or 'human_only': a person (most tasks).
  -- 'needs_spec': meant for the dev agent, spec not written yet.
  -- 'ai_ready': specced; the dev agent may claim it (the only claimable value).
  ai_readiness text check (ai_readiness in ('ai_ready', 'needs_spec', 'human_only') or ai_readiness is null),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null,
  -- The task this is a subtask of (null for a top-level task). One level
  -- deep, same project as the parent: see Subtasks are tasks.
  parent_task_id uuid references public.tasks(id) on delete cascade,
  -- Where it came from, stamped on insert and never changed (see Task source
  -- and seen): app, api, mcp, system, or unknown for tasks from before.
  created_via text not null default 'unknown',
  -- references api_keys, added with the Task source section (api_keys is defined later)
  created_by_key_id uuid,
  created_note text,
  constraint tasks_created_via_check check (created_via in ('app', 'api', 'mcp', 'system', 'unknown')),
  constraint tasks_created_note_length check (created_note is null or length(created_note) between 1 and 200),
  constraint tasks_parent_not_self check (parent_task_id is distinct from id)
);

-- ============================================================
-- 7. TASK ASSIGNEES (junction: task <-> team_member)
-- ============================================================
create table public.task_assignees (
  task_id uuid not null references public.tasks(id) on delete cascade,
  member_id uuid not null references public.team_members(id) on delete cascade,
  primary key (task_id, member_id)
);

-- ============================================================
-- 8. SUBTASKS
-- ============================================================
create table public.task_subtasks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  title text not null,
  completed boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 8b. TASK ACCEPTANCE CRITERIA (addressable spec checklist)
-- ============================================================
create table public.task_acceptance_criteria (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  criterion text not null,
  satisfied boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_task_acceptance_criteria_task_id
  on public.task_acceptance_criteria(task_id);

-- ============================================================
-- 8c. TASK DEPENDENCIES (blocked-by junction)
-- ============================================================
create table public.task_dependencies (
  task_id uuid not null references public.tasks(id) on delete cascade,
  blocked_by_task_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, blocked_by_task_id),
  check (task_id <> blocked_by_task_id)
);

create index idx_task_dependencies_blocked_by
  on public.task_dependencies(blocked_by_task_id);

-- ============================================================
-- 8d. TASK REVIEWS (independent PR review verdicts)
-- ============================================================
-- One row per review round; the latest row is the task's current verdict.
-- head_sha pins the verdict to the exact PR head reviewed so automerge can
-- refuse commits pushed after approval. Written only via the v1 agent API
-- (service client); authenticated users read.
create table public.task_reviews (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  round int not null default 1,
  verdict text not null check (verdict in ('approved', 'changes_requested')),
  summary text,
  pr_url text,
  head_sha text,
  reviewer_member_id uuid references public.team_members(id),
  created_at timestamptz not null default now()
);

create index idx_task_reviews_task_created
  on public.task_reviews(task_id, created_at desc);

-- One verdict per commit. Overlapping reviewer turns once filed opposite
-- conclusions about identical bytes, and each contradiction minted a new round
-- that sent the developer back to rebuild approved work.
create unique index idx_task_reviews_commit_identity
  on public.task_reviews(task_id, pr_url, head_sha);

-- Agent infrastructure heartbeats: one row per agent, upserted in place by a
-- VPS cron every minute (container state + execution ledger). Current state,
-- not history; agent_activities remains the narrative log. A stale
-- reported_at means the publisher itself is silent, which readers surface as
-- an outage. Written only via the v1 agent API (service client);
-- authenticated users read.
create table public.agent_health (
  member_id uuid primary key references public.team_members(id) on delete cascade,
  container text not null,
  container_running boolean not null default false,
  turn_running boolean not null default false,
  turn_started_at timestamptz,
  reported_at timestamptz not null default now()
);

-- Availability needs history, and the table above has none by design: it is
-- upserted in place, so an outage is invisible the moment it ends. A trigger
-- records CONTAINER transitions here, which is enough to measure uptime without
-- storing a row per minute. Turn starts and stops are deliberately not recorded:
-- they are already tracked, in full and reconciled, as turn.completed events.
create table public.agent_health_history (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  container_running boolean not null,
  turn_running boolean not null,
  -- The publisher's clock, not the database's: a delayed write must not shift
  -- when the state actually changed.
  changed_at timestamptz not null
);

create index idx_agent_health_history_member
  on public.agent_health_history (member_id, changed_at desc);

create or replace function public.log_agent_health_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     or new.container_running is distinct from old.container_running then
    insert into public.agent_health_history (member_id, container_running, turn_running, changed_at)
    values (new.member_id, new.container_running, new.turn_running, new.reported_at);
  end if;
  return new;
end;
$$;

create trigger agent_health_history_trigger
  after insert or update on public.agent_health
  for each row execute function public.log_agent_health_change();

-- ============================================================
-- 9. COMMENTS
-- ============================================================
create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references public.team_members(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 10. ACTIVITIES (audit log)
-- ============================================================
-- The team activity log: what people on the team did (agents keep their own
-- log in agent_activities). Written only by triggers; see "Team activity log".
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  entity_id text not null,
  entity_type text not null,
  user_id uuid references public.team_members(id) on delete set null,
  description text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  project_id uuid references public.projects(id) on delete set null,
  source text not null default 'app',
  updated_at timestamptz not null default now(),
  constraint activities_entity_type_check check (entity_type in (
    'task', 'subtask', 'comment', 'project', 'member', 'time_entry', 'invoice', 'payment', 'file',
    'portal_update', 'portal_update_attachment', 'credential', 'reminder', 'contact', 'lead',
    'lead_interaction', 'lead_proposal', 'lead_field', 'communication', 'hourly_rate', 'retainer',
    'retainer_amount'
  )),
  constraint activities_source_check check (source in ('app', 'api', 'mcp', 'backfill'))
);

-- ============================================================
-- 11. LEADS
-- ============================================================
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null default '',
  phone text not null default '',
  company text not null default '',
  source text not null default 'other' check (source in ('referral', 'website', 'social', 'cold_outreach', 'event', 'network', 'other')),
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost')),
  notes text not null default '',
  assigned_to uuid references public.team_members(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  created_by uuid references public.team_members(id) on delete set null,
  archived_at timestamptz default null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 12. LEAD INTERACTIONS
-- ============================================================
create table public.lead_interactions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  type text not null default 'note' check (type in ('call', 'email', 'meeting', 'note', 'follow_up')),
  title text not null,
  description text not null default '',
  occurred_at timestamptz not null default now(),
  scheduled_at timestamptz,
  completed boolean not null default false,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 13. LEAD PROPOSALS
-- ============================================================
create table public.lead_proposals (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  title text not null,
  description text not null default '',
  estimated_value numeric(12,2),
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected')),
  sent_at timestamptz,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 14. LEAD FIELDS (dynamic key-value fields for leads)
-- ============================================================
create table public.lead_fields (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  field_key text not null,
  value text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- Among live fields: a field in Trash does not block setting it again.
CREATE UNIQUE INDEX lead_fields_live_key
  ON public.lead_fields (lead_id, field_key) WHERE deleted_at IS NULL;

-- ============================================================
-- 15. LEAD MEMBERS (junction: lead <-> team_member)
-- ============================================================
create table public.lead_members (
  lead_id uuid not null references public.leads(id) on delete cascade,
  member_id uuid not null references public.team_members(id) on delete cascade,
  primary key (lead_id, member_id)
);

-- Backfill: create lead_members entries for existing leads that have assigned_to
insert into public.lead_members (lead_id, member_id)
select id, assigned_to
from public.leads
where assigned_to is not null;

-- ============================================================
-- 16. LEAD CONTACTS (junction: lead <-> contact with roles)
-- ============================================================
create table public.lead_contacts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  role text not null default 'Stakeholder',
  custom_role text,
  is_primary_client boolean not null default false,
  created_at timestamptz not null default now(),
  unique (lead_id, contact_id)
);

-- Only 1 primary client per lead:
create unique index idx_lead_contacts_primary_client
  on public.lead_contacts (lead_id) where is_primary_client = true;

-- Backfill: create lead_contacts entries for existing leads that have a contact_id
insert into public.lead_contacts (lead_id, contact_id, role, is_primary_client)
select id, contact_id, 'Client', true
from public.leads
where contact_id is not null;

-- ============================================================
-- 17. PORTAL SETTINGS (one per project, client-facing portal config)
-- ============================================================
create table public.portal_settings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  enabled boolean not null default false,
  token text not null,
  pin text default null,
  welcome_message text not null default '',
  logo_url text not null default '',
  accent_color text not null default '#6366F1',
  show_progress boolean not null default true,
  show_files boolean not null default true,
  show_hours boolean not null default true,
  show_updates boolean not null default true,
  show_credentials boolean not null default false,
  show_invoices boolean not null default false,
  section_order text[] not null default '{show_progress,show_hours,show_updates,show_files,show_credentials,show_invoices}',
  notification_thresholds integer[] not null default '{50,75,90,100}',
  alert_mode text not null default 'percentage' check (alert_mode in ('percentage','dollar_interval','none')),
  dollar_interval numeric(12,2),
  require_alert_approval boolean not null default true,
  rearm_thresholds_on_budget_change boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id),
  unique(token)
);

-- ============================================================
-- 18a. CLIENT COMMUNICATIONS (audit log + pending approval queue)
-- ============================================================
create table public.client_communications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  notification_type text not null check (notification_type in (
    'portal_welcome',
    'project_summary',
    'invoice',
    'budget_threshold',
    'dollar_interval',
    'budget_extended'
  )),
  status text not null default 'sent' check (status in ('pending','sent','failed','dismissed')),
  subject text,
  rendered_html text,
  rendered_text text,
  slot_overrides jsonb not null default '{}',
  metadata jsonb default '{}',
  recipients jsonb not null default '{"to":[],"cc":[],"bcc":[]}',
  triggered_by uuid references public.team_members(id) on delete set null,
  sent_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 19. ENTITY FILES (polymorphic attachments for leads, projects, contacts)
-- ============================================================
create table public.entity_files (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('lead', 'project', 'contact')),
  entity_id uuid not null,
  name text not null,
  file_url text not null,
  file_size bigint not null default 0,
  mime_type text not null default 'application/octet-stream',
  visibility text not null default 'internal' check (visibility in ('internal', 'external')),
  uploaded_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 20. API KEYS (database-managed API key system)
-- ============================================================
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_prefix text not null,
  key_hash text not null,
  created_by uuid references public.team_members(id) on delete set null,
  permissions text not null default 'full' check (permissions in ('full', 'read_only')),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 20b. WEBHOOKS (generic outbound webhook platform)
-- ============================================================
-- Transactional outbox: a trigger on project_invoices records an event
-- and fans out one delivery per subscribed endpoint; a TypeScript
-- dispatcher signs (HMAC) and delivers each, retrying with backoff up to
-- 8 attempts under a lease (claim_webhook_deliveries); pg_cron asks the
-- app to send due retries (webhook_retry_kick). Secret is stored
-- retrievably because it is needed to sign at delivery time.
create sequence if not exists public.webhook_event_seq;

create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  secret text not null,
  events text[] not null default '{}',
  is_active boolean not null default true,
  description text not null default '',
  -- Which amounts this endpoint receives: what was billed, or what is left
  -- after revenue splits. Applied per delivery in claim_webhook_deliveries.
  amount_basis text not null default 'gross' check (amount_basis in ('gross', 'net')),
  created_by uuid references public.team_members(id) on delete set null,
  last_delivery_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  sequence bigint not null unique,
  event_type text not null,
  resource_type text not null default 'invoice',
  resource_id uuid,
  payload jsonb not null,
  -- Net-of-splits snapshot, kept out of payload so a gross endpoint never sees it:
  -- { "amount": n, "totals_by_type": {..}, "line_items": { "<line id>": n } }
  net_amounts jsonb,
  created_at timestamptz not null default now()
);
create index idx_webhook_events_resource
  on public.webhook_events (resource_type, resource_id);

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  webhook_event_id uuid not null references public.webhook_events(id) on delete cascade,
  endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'delivering', 'succeeded', 'failed')),
  attempts int not null default 0,
  last_attempt_at timestamptz,
  last_status_code int,
  last_error text,
  last_response text,
  delivered_at timestamptz,
  -- When a pending delivery may next be tried (pushed out after each failure).
  next_attempt_at timestamptz not null default now(),
  -- The claim held by one dispatcher run: its token, and when another run may
  -- take the delivery back if that run never reports.
  attempt_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_webhook_deliveries_due
  on public.webhook_deliveries (next_attempt_at)
  where status in ('pending', 'delivering');
create index idx_webhook_deliveries_endpoint
  on public.webhook_deliveries (endpoint_id);
create index idx_webhook_deliveries_event
  on public.webhook_deliveries (webhook_event_id);

-- ============================================================
-- 20. NOTIFICATIONS
-- ============================================================
create table public.team_member_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.team_members(id) on delete cascade,
  title text not null,
  message text,
  link text,
  is_read boolean not null default false,
  entity_type text check (entity_type in ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question', 'invoice', 'reminder')),
  entity_id text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 21. TIME ENTRIES (start/stop timer + manual entry)
-- ============================================================
create table public.project_time_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  member_id uuid not null references public.team_members(id) on delete cascade,
  start_time timestamptz not null default now(),
  end_time timestamptz,
  -- Segments array: [{start: ISO, end: ISO | null}, ...].
  -- Last segment's end is null only when the timer is actively running.
  -- Paused: end_time IS NULL and all segments have a non-null end.
  -- Running: end_time IS NULL and last segment has end: null.
  -- Stopped: end_time IS NOT NULL and all segments have a non-null end.
  segments jsonb not null default '[]'::jsonb,
  -- Immutable billing-rate snapshot selected from the session start time.
  hourly_rate numeric(10,2) not null default 0 check (hourly_rate >= 0),
  description text not null default '',
  -- Snapshot of the member's billing multiplier at session start. Agent
  -- sessions finalize raw and are converted at APPROVAL: worked time times
  -- this, collapsed to one continuous segment anchored at the real start.
  billing_multiplier numeric(4,2) not null default 1.00 check (billing_multiplier > 0),
  -- Stamped when the agent billing conversion runs; conversion is single-shot.
  billing_converted_at timestamptz,
  -- Immutable raw clock data captured immediately before billing conversion.
  raw_time_snapshot jsonb check (raw_time_snapshot is null or jsonb_typeof(raw_time_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- One work session can span multiple tasks (billing traceability for
-- humans and agents alike). Junction mirrors task_assignees.
create table public.time_entry_tasks (
  time_entry_id uuid not null references public.project_time_entries(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (time_entry_id, task_id)
);

create index idx_time_entry_tasks_task
  on public.time_entry_tasks(task_id);

-- ============================================================
-- 21b. PROJECT HOURLY RATE SCHEDULE
-- ============================================================
create table public.project_hourly_rates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  hourly_rate numeric(10,2) not null check (hourly_rate >= 0),
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- Among live rows: a row in Trash does not block a new one.
CREATE UNIQUE INDEX project_hourly_rates_live_effective_key
  ON public.project_hourly_rates (project_id, effective_at) WHERE deleted_at IS NULL;

-- Only one running timer per (project, member) at a time — each teammate can
-- track their own live session on the same project simultaneously.
create unique index idx_project_time_entries_running
  on public.project_time_entries (project_id, member_id) where end_time is null and deleted_at is null;

-- ============================================================
-- 22. PORTAL UPDATES (team-posted timeline updates for client portal)
-- ============================================================
create table public.portal_updates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  content text not null default '',
  update_type text not null default 'general' check (update_type in ('general', 'milestone', 'deliverable', 'note')),
  author_id uuid references public.team_members(id) on delete set null,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 22b. PORTAL UPDATE ATTACHMENTS (files attached to portal updates)
-- ============================================================
create table public.portal_update_attachments (
  id          uuid primary key default gen_random_uuid(),
  update_id   uuid not null references public.portal_updates(id) on delete cascade,
  name        text not null,
  file_url    text not null,
  file_size   bigint not null default 0,
  mime_type   text not null default 'application/octet-stream',
  uploaded_by uuid references public.team_members(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 22c. PORTAL EVENTS (per-event analytics log + session rollup view)
-- ============================================================
create table public.portal_events (
  id                  uuid primary key default gen_random_uuid(),
  portal_settings_id  uuid not null references public.portal_settings(id) on delete cascade,
  project_id          uuid not null references public.projects(id) on delete cascade,
  session_id          uuid not null,
  event_type          text not null check (event_type in (
    'portal_view', 'pin_attempt', 'section_view',
    'file_preview', 'file_download',
    'invoice_view', 'invoice_pdf_download',
    'credential_submit', 'heartbeat'
  )),
  ip_address          inet,
  ip_hash             text,
  user_agent          text,
  referrer            text,
  device_type         text,
  browser             text,
  os                  text,
  accept_language     text,
  timezone            text,
  language            text,
  screen_width        integer,
  screen_height       integer,
  viewport_width      integer,
  viewport_height     integer,
  connection_type     text,
  color_scheme        text,
  reduced_motion      boolean,
  metadata            jsonb not null default '{}',
  created_at          timestamptz not null default now()
);

-- ============================================================
-- 23. PROJECT CREDENTIALS (encrypted client credentials)
-- ============================================================
create table public.project_credentials (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  label text not null,
  category text not null default 'login'
    check (category in ('login', 'api_key', 'ssh_key', 'database', 'credit_card', 'ach')),
  encrypted_data text not null,
  iv text not null,
  submitted_by_client boolean not null default false,
  submitted_by_name text not null default '',
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- ============================================================
-- 24b. PROJECT INVOICES (invoice tracking per project)
-- ============================================================
create table public.project_invoices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  invoice_number text not null,
  amount numeric(12,2) not null default 0,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  invoice_type text not null default 'hourly'
    check (invoice_type in ('hourly', 'fixed', 'recurring')),
  -- Per-line breakdown so a single invoice can mix hourly, fixed, recurring,
  -- and reimbursement rows. Service rows can carry period info used for
  -- revenue amortization on the chart.
  -- Empty array => app synthesizes a single line item from invoice_type+amount.
  line_items jsonb not null default '[]'::jsonb,
  date text not null,
  due_date text,
  description text not null default '',
  paid_date text,
  file_url text,
  file_name text,
  file_size bigint,
  mime_type text,
  -- True for drafts created by the retainer job, so the list can mark them.
  auto_generated boolean not null default false,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- Exact time-session portions represented by generated hourly line items.
-- line_item_id refers to the stable id stored in project_invoices.line_items.
create table public.invoice_time_entry_allocations (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.project_invoices(id) on delete cascade,
  line_item_id text not null,
  time_entry_id uuid not null references public.project_time_entries(id) on delete restrict,
  start_offset_hours numeric(14,6) not null default 0 check (start_offset_hours >= 0),
  allocated_hours numeric(14,6) not null check (allocated_hours > 0),
  allocated_amount numeric(12,2) not null check (allocated_amount >= 0),
  created_at timestamptz not null default now(),
  unique (invoice_id, line_item_id, time_entry_id)
);

-- ============================================================
-- 25. SMTP ACCOUNTS (encrypted SMTP credentials)
-- ============================================================
create table public.smtp_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  host text not null,
  port integer not null default 465,
  secure boolean not null default true,
  username text not null,
  encrypted_password text not null,
  from_name text not null,
  from_email text not null,
  reply_to text not null default '',
  is_default boolean not null default false,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_smtp_accounts_is_default on public.smtp_accounts(is_default) where is_default = true;

alter table public.smtp_accounts enable row level security;

-- SMTP credentials are admin-only (see 20260714_smtp_admin_only_rls.sql)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where auth_user_id = auth.uid() and role = 'admin'
  );
$$;

create policy "smtp_accounts_admin_only" on public.smtp_accounts
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- 25b. BUSINESS SETTINGS (singleton — workspace's own "From" identity for invoice PDFs)
-- ============================================================
-- Hostname check used by inbound email settings (business_settings and
-- inboxes); defined here because business_settings uses it.
create or replace function public.email_is_hostname(p_value text)
returns boolean
language sql
immutable
as $$
  select p_value is not null
    and length(p_value) between 3 and 253
    and p_value ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'
$$;

create table public.business_settings (
  id uuid primary key default gen_random_uuid(),
  business_name text not null default '',
  business_address text not null default '',
  business_email text not null default '',
  business_phone text not null default '',
  payment_terms text not null default 'Upon Receipt',
  payment_instructions text not null default '',
  default_invoice_notes text not null default '',
  -- Admin-managed IP exclusion list for portal analytics: { ip, label }[].
  -- The dashboard filters these out by default so internal/test traffic
  -- doesn't get counted as real client engagement.
  excluded_ips jsonb not null default '[]'::jsonb,
  -- Human sessions finalize straight to approved when true (the default:
  -- a hand-picked team is trusted); agent sessions always queue for review.
  auto_approve_human_hours boolean not null default true,
  -- Default relay domain for new email inboxes (each inbox keeps its own
  -- routing_domain): the domain whose MX points at the receiving provider.
  inbound_email_domain text not null default 'relay.valiancemedia.com'
    check (inbound_email_domain = lower(btrim(inbound_email_domain)) and public.email_is_hostname(inbound_email_domain)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enforce singleton: only one row may ever exist in this table.
create unique index business_settings_singleton on public.business_settings ((true));

alter table public.business_settings enable row level security;

create policy "business_settings_all" on public.business_settings
  for all to authenticated using (true) with check (true);

-- Seed a single empty row so the app always has a settings row to read/update.
insert into public.business_settings default values;

-- ============================================================
-- 26. PROJECT CONTEXT (AI orchestrator context entries per project)
-- ============================================================
create table public.project_context (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  category text not null check (category in ('business_context', 'existing_work', 'technical_decision', 'constraint', 'lesson_learned')),
  content text not null,
  source text not null default 'human' check (source in ('human', 'agent', 'scan')),
  file_path text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
create unique index idx_team_members_auth_user_id on public.team_members(auth_user_id) where auth_user_id is not null;
create index idx_contacts_created_by on public.contacts(created_by);
create index idx_projects_status on public.projects(status);
create index idx_projects_created_by on public.projects(created_by);
create index idx_project_members_member_id on public.project_members(member_id);
create index idx_project_contacts_contact_id on public.project_contacts(contact_id);
create index idx_tasks_project_id on public.tasks(project_id);
create index idx_tasks_status on public.tasks(status);
create index idx_tasks_sort_order on public.tasks(project_id, status, sort_order);
create index idx_tasks_created_by on public.tasks(created_by);
create index idx_tasks_parent_task_id on public.tasks(parent_task_id) where parent_task_id is not null;
create index idx_task_assignees_member_id on public.task_assignees(member_id);
create index idx_task_subtasks_task_id on public.task_subtasks(task_id);
create index idx_task_comments_task_id on public.task_comments(task_id);
create index idx_task_comments_user_id on public.task_comments(user_id);
create index idx_activities_entity_id on public.activities(entity_id);
create index idx_activities_user_id on public.activities(user_id);
create index idx_activities_project_created on public.activities (project_id, created_at desc);
create index idx_activities_user_created on public.activities (user_id, created_at desc);
create index idx_leads_status on public.leads(status);
create index idx_leads_assigned_to on public.leads(assigned_to);
create index idx_leads_contact_id on public.leads(contact_id);
create index idx_leads_created_by on public.leads(created_by);
create index idx_lead_interactions_lead_id on public.lead_interactions(lead_id);
create index idx_lead_interactions_type on public.lead_interactions(type);
create index idx_lead_interactions_scheduled_at on public.lead_interactions(scheduled_at) where scheduled_at is not null;
create index idx_lead_proposals_lead_id on public.lead_proposals(lead_id);
create index idx_lead_proposals_status on public.lead_proposals(status);
create index idx_lead_fields_lead_id on public.lead_fields(lead_id);
create index idx_lead_fields_field_key on public.lead_fields(field_key);
create index idx_lead_members_member_id on public.lead_members(member_id);
create index idx_lead_contacts_lead_id on public.lead_contacts(lead_id);
create index idx_lead_contacts_contact_id on public.lead_contacts(contact_id);
create index idx_portal_settings_project_id on public.portal_settings(project_id);
create index idx_portal_settings_token on public.portal_settings(token);
create index idx_client_communications_project on public.client_communications(project_id);
create index idx_client_communications_type on public.client_communications(project_id, notification_type);
create index idx_client_communications_status on public.client_communications(project_id, status);

-- Dedup unique indexes for automated comm types. See migration
-- 20260415_client_comm_dedup.sql for rationale.
create unique index if not exists ux_client_comm_threshold_dedup
  on public.client_communications (
    project_id,
    ((metadata->>'threshold')::int),
    coalesce((metadata->>'fired_under_budget_type'), ''),
    coalesce((metadata->>'fired_under_history_id'), '')
  )
  where notification_type = 'budget_threshold'
    and status <> 'failed'
    and metadata ? 'threshold';

create unique index if not exists ux_client_comm_dollar_interval_dedup
  on public.client_communications (
    project_id,
    ((metadata->>'milestone')::numeric)
  )
  where notification_type = 'dollar_interval'
    and status <> 'failed'
    and metadata ? 'milestone';
create index idx_portal_updates_project_id on public.portal_updates(project_id);
create index idx_portal_updates_created_at on public.portal_updates(created_at desc);

create index idx_portal_update_attachments_update_id on public.portal_update_attachments(update_id);

create index idx_portal_events_settings_created on public.portal_events(portal_settings_id, created_at desc);
create index idx_portal_events_project_created on public.portal_events(project_id, created_at desc);
create index idx_portal_events_session on public.portal_events(session_id);
create index idx_portal_events_type on public.portal_events(portal_settings_id, event_type, created_at desc);
create index idx_portal_events_ip_hash on public.portal_events(portal_settings_id, ip_hash);

create index idx_entity_files_entity on public.entity_files(entity_type, entity_id);
create index idx_entity_files_external_project on public.entity_files(entity_id) where entity_type = 'project' and visibility = 'external';

create index idx_api_keys_key_hash on public.api_keys(key_hash);
create index idx_api_keys_revoked_at on public.api_keys(revoked_at) where revoked_at is null;

create index idx_project_credentials_project on public.project_credentials(project_id);
create index idx_project_context_project_id on public.project_context(project_id);
create index idx_project_context_category on public.project_context(project_id, category);
create index idx_project_context_active on public.project_context(project_id, is_active);
create unique index idx_project_context_file_path on public.project_context(project_id, file_path) where file_path is not null and is_active = true;
create index idx_project_invoices_project on public.project_invoices(project_id);
-- One number per invoice on a project.
CREATE UNIQUE INDEX project_invoices_project_number_key ON public.project_invoices (project_id, invoice_number);
create index idx_project_invoices_status on public.project_invoices(status);
create index idx_project_invoices_date on public.project_invoices(date desc);
create index idx_projects_archived_at on public.projects(archived_at) where archived_at is null;
create index idx_leads_archived_at on public.leads(archived_at) where archived_at is null;

create index idx_project_time_entries_project on public.project_time_entries(project_id);
create index idx_project_time_entries_member on public.project_time_entries(member_id);
create index idx_project_time_entries_start_time on public.project_time_entries(start_time desc);
create index idx_project_hourly_rates_lookup on public.project_hourly_rates(project_id, effective_at desc);
create index idx_invoice_time_allocations_invoice on public.invoice_time_entry_allocations(invoice_id);
create index idx_invoice_time_allocations_entry on public.invoice_time_entry_allocations(time_entry_id);

create index idx_team_member_notifications_user_id on public.team_member_notifications(user_id);
create index idx_team_member_notifications_unread on public.team_member_notifications(user_id, is_read) where is_read = false;
create index idx_team_member_notifications_created_at on public.team_member_notifications(created_at desc);

-- Dedup index for upsert_notification: one unread notification per user+entity
create unique index idx_team_member_notifications_dedup
  on public.team_member_notifications (user_id, entity_type, entity_id) where is_read = false;

-- ============================================================
-- UPSERT NOTIFICATION (SECURITY DEFINER, bypasses RLS for the dedup check).
-- Server-side callers only: the service role and other definer functions.
-- ============================================================
create or replace function public.upsert_notification(
  p_user_id uuid,
  p_title text,
  p_message text,
  p_link text,
  p_entity_type text,
  p_entity_id text
) returns void as $$
begin
  update public.team_member_notifications
  set title = p_title, message = p_message, link = p_link, created_at = now()
  where user_id = p_user_id
    and entity_type = p_entity_type
    and entity_id = p_entity_id
    and is_read = false;

  if not found then
    insert into public.team_member_notifications (user_id, title, message, link, entity_type, entity_id)
    values (p_user_id, p_title, p_message, p_link, p_entity_type, p_entity_id);
  end if;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function public.upsert_notification(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.upsert_notification(uuid, text, text, text, text, text) to service_role;

-- ============================================================
-- SAVE TASK: a task row and its assignees, criteria and blockers in one
-- transaction. SECURITY INVOKER, so every RLS policy still applies. p_task is
-- a column patch; a NULL list is left unchanged, an empty list clears it.
-- ============================================================
CREATE OR REPLACE FUNCTION public.save_task(
  p_task_id uuid,
  p_task jsonb,
  p_assignee_ids uuid[] DEFAULT NULL,
  p_criteria text[] DEFAULT NULL,
  p_blocked_by uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_task_id uuid := p_task_id;
  v_payload jsonb := COALESCE(p_task, '{}'::jsonb);
  v_unknown text;
  v_cols text[];
  v_rows integer;
  v_task public.tasks;
BEGIN
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'save_task: p_task must be a JSON object' USING ERRCODE = '22023';
  END IF;

  -- Same contract as a PostgREST update: an unknown column is an error, not
  -- a silently dropped field.
  SELECT key INTO v_unknown
  FROM jsonb_object_keys(v_payload) AS key
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.tasks'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname = key
  )
  LIMIT 1;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'save_task: unknown task column "%"', v_unknown USING ERRCODE = '42703';
  END IF;

  SELECT array_agg(key ORDER BY key) INTO v_cols
  FROM jsonb_object_keys(v_payload) AS key
  WHERE key NOT IN ('id', 'created_at');

  IF v_task_id IS NULL THEN
    IF v_cols IS NULL THEN
      RAISE EXCEPTION 'save_task: a new task needs its columns' USING ERRCODE = '22023';
    END IF;
    EXECUTE format(
      'INSERT INTO public.tasks (%s) SELECT %s FROM jsonb_populate_record(NULL::public.tasks, $1) r RETURNING id',
      (SELECT string_agg(format('%I', c), ', ') FROM unnest(v_cols) c),
      (SELECT string_agg(format('r.%I', c), ', ') FROM unnest(v_cols) c)
    ) INTO v_task_id USING v_payload;
  ELSIF v_cols IS NOT NULL THEN
    EXECUTE format(
      'UPDATE public.tasks t SET %s FROM jsonb_populate_record(NULL::public.tasks, $1) r WHERE t.id = $2',
      (SELECT string_agg(format('%I = r.%I', c, c), ', ') FROM unnest(v_cols) c)
    ) USING v_payload, v_task_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    -- RLS turns a denied update into zero rows; that is a failure, not a save.
    IF v_rows = 0 THEN
      RAISE EXCEPTION 'save_task: task % not found or not permitted', v_task_id USING ERRCODE = 'P0002';
    END IF;
  ELSE
    PERFORM 1 FROM public.tasks WHERE id = v_task_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'save_task: task % not found or not permitted', v_task_id USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF p_assignee_ids IS NOT NULL THEN
    DELETE FROM public.task_assignees
    WHERE task_id = v_task_id AND NOT (member_id = ANY (p_assignee_ids));
    INSERT INTO public.task_assignees (task_id, member_id)
    SELECT DISTINCT v_task_id, member_id FROM unnest(p_assignee_ids) AS member_id
    ON CONFLICT (task_id, member_id) DO NOTHING;
  END IF;

  IF p_criteria IS NOT NULL THEN
    DELETE FROM public.task_acceptance_criteria WHERE task_id = v_task_id;
    INSERT INTO public.task_acceptance_criteria (task_id, criterion, sort_order)
    SELECT v_task_id, c.criterion, (c.ordinality - 1)::int
    FROM unnest(p_criteria) WITH ORDINALITY AS c(criterion, ordinality);
  END IF;

  IF p_blocked_by IS NOT NULL THEN
    DELETE FROM public.task_dependencies WHERE task_id = v_task_id;
    INSERT INTO public.task_dependencies (task_id, blocked_by_task_id)
    SELECT DISTINCT v_task_id, blocked_by FROM unnest(p_blocked_by) AS blocked_by;
  END IF;

  SELECT * INTO v_task FROM public.tasks WHERE id = v_task_id;
  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'criteria', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.sort_order)
      FROM public.task_acceptance_criteria c
      WHERE c.task_id = v_task_id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_task(uuid, jsonb, uuid[], text[], uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_task(uuid, jsonb, uuid[], text[], uuid[]) TO authenticated, service_role;

-- ============================================================
-- CONVERT LEAD (atomic conversion with double-convert guard)
-- ============================================================
create or replace function public.convert_lead(
  p_lead_id uuid,
  p_project_name text,
  p_project_color text,
  p_project_description text,
  p_created_by uuid
) returns jsonb
language plpgsql
as $$
declare
  v_lead public.leads%rowtype;
  v_contact_id uuid;
  v_project_id uuid;
begin
  select * into v_lead from public.leads where id = p_lead_id and deleted_at is null for update;
  if not found then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  if v_lead.status = 'won' then
    -- Custom errcode so the API can map this to 409 without colliding with
    -- P0001, the default code every unqualified `raise exception` uses
    raise exception 'Lead has already been converted' using errcode = 'LC409';
  end if;

  -- Reuse the lead's contact unless it is in Trash, otherwise create one
  select c.id into v_contact_id from public.contacts c
  where c.id = v_lead.contact_id and c.deleted_at is null;
  if v_contact_id is null then
    insert into public.contacts (name, email, phone, company, color, created_by)
    values (v_lead.name, v_lead.email, v_lead.phone, v_lead.company, p_project_color, p_created_by)
    returning id into v_contact_id;
  end if;

  insert into public.projects (name, description, color, status, created_by)
  values (p_project_name, p_project_description, p_project_color, 'active', p_created_by)
  returning id into v_project_id;

  -- Primary client
  insert into public.project_contacts (project_id, contact_id, role, is_primary_client)
  values (v_project_id, v_contact_id, 'Client', true);

  -- Copy additional (non-primary) lead contacts
  insert into public.project_contacts (project_id, contact_id, role, custom_role, is_primary_client)
  select v_project_id, lc.contact_id, lc.role, lc.custom_role, false
  from public.lead_contacts lc
  join public.contacts c on c.id = lc.contact_id and c.deleted_at is null
  where lc.lead_id = p_lead_id and lc.is_primary_client = false
  on conflict (project_id, contact_id) do nothing;

  -- Copy lead members to project members
  insert into public.project_members (project_id, member_id)
  select v_project_id, lm.member_id
  from public.lead_members lm
  where lm.lead_id = p_lead_id
  on conflict (project_id, member_id) do nothing;

  update public.leads set status = 'won', contact_id = v_contact_id where id = p_lead_id;

  return jsonb_build_object('project_id', v_project_id, 'contact_id', v_contact_id);
end;
$$;

-- The function runs with the caller's privileges (RLS applies), but keep the
-- PostgREST /rpc surface closed to anonymous callers regardless.
revoke execute on function public.convert_lead(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.convert_lead(uuid, text, text, text, uuid) to authenticated, service_role;

-- ============================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_team_members_updated_at
  before update on public.team_members
  for each row execute function public.handle_updated_at();

create trigger set_contacts_updated_at
  before update on public.contacts
  for each row execute function public.handle_updated_at();

create trigger set_projects_updated_at
  before update on public.projects
  for each row execute function public.handle_updated_at();

-- Tasks get a dedicated handler: it maintains completed_at on status
-- transitions and skips the updated_at bump for reorder-only writes
-- (sort_order changes are cosmetic and must not look like activity).
create or replace function public.handle_task_before_update()
returns trigger as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    new.completed_at = now();
  elsif new.status is distinct from 'done' then
    new.completed_at = null;
  end if;

  if (to_jsonb(new) - 'sort_order' - 'updated_at') is distinct from (to_jsonb(old) - 'sort_order' - 'updated_at') then
    new.updated_at = now();
  else
    new.updated_at = old.updated_at;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function public.handle_task_before_insert()
returns trigger as $$
begin
  if new.status = 'done' and new.completed_at is null then
    new.completed_at = now();
  end if;
  return new;
end;
$$ language plpgsql;

create trigger tasks_before_update
  before update on public.tasks
  for each row execute function public.handle_task_before_update();

create trigger tasks_before_insert
  before insert on public.tasks
  for each row execute function public.handle_task_before_insert();

-- A task a signed-in member moves to done while their own timer is running on that
-- project joins that session, so work finished mid-session is tied to its time with
-- no one linking it by hand. Only the web app's signed-in writes carry auth.uid():
-- API writes (agents, the recap skill, scripts) never fire this, and a task dragged
-- to done later, with no timer running, is left for the recap to link by evidence.
create or replace function public.link_done_task_to_running_timer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member uuid;
begin
  if auth.uid() is null then
    return null;
  end if;

  select id into v_member
  from public.team_members
  where auth_user_id = auth.uid()
  limit 1;
  if v_member is null then
    return null;
  end if;

  -- Running, not paused: the session is open and its last segment has no end.
  insert into public.time_entry_tasks (time_entry_id, task_id)
  select te.id, new.id
  from public.project_time_entries te
  where te.project_id = new.project_id
    and te.member_id = v_member
    and te.end_time is null
    and te.deleted_at is null
    and jsonb_array_length(te.segments) > 0
    and te.segments -> -1 ->> 'end' is null
  on conflict do nothing;

  return null;
end;
$$;

revoke all on function public.link_done_task_to_running_timer() from public, anon, authenticated;

create trigger tasks_link_done_to_running_timer
  after update of status on public.tasks
  for each row
  when (new.status = 'done' and old.status is distinct from 'done')
  execute function public.link_done_task_to_running_timer();

create trigger set_task_subtasks_updated_at
  before update on public.task_subtasks
  for each row execute function public.handle_updated_at();

create trigger set_task_acceptance_criteria_updated_at
  before update on public.task_acceptance_criteria
  for each row execute function public.handle_updated_at();

create trigger set_leads_updated_at
  before update on public.leads
  for each row execute function public.handle_updated_at();

create trigger set_lead_interactions_updated_at
  before update on public.lead_interactions
  for each row execute function public.handle_updated_at();

create trigger set_lead_proposals_updated_at
  before update on public.lead_proposals
  for each row execute function public.handle_updated_at();

create trigger set_lead_fields_updated_at
  before update on public.lead_fields
  for each row execute function public.handle_updated_at();

create trigger set_portal_settings_updated_at
  before update on public.portal_settings
  for each row execute function public.handle_updated_at();

create trigger set_entity_files_updated_at
  before update on public.entity_files
  for each row execute function public.handle_updated_at();

create trigger set_api_keys_updated_at
  before update on public.api_keys
  for each row execute function public.handle_updated_at();

-- A revoke is final, the secret and creation time never change, and a key
-- never moves to another member. team_member_id and created_by may still
-- become NULL: their foreign keys are ON DELETE SET NULL, which runs as an
-- UPDATE and fires this trigger. scopes, name, disabled_at (reversible, unlike
-- a revoke) and last_used_at stay writable by the server.
CREATE OR REPLACE FUNCTION public.api_keys_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'API key % is revoked; a revoke cannot be changed', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.key_hash IS DISTINCT FROM OLD.key_hash
    OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'API key % secret and creation time cannot change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF (NEW.team_member_id IS DISTINCT FROM OLD.team_member_id AND NEW.team_member_id IS NOT NULL)
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'API key % cannot move to another member', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.api_keys_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER api_keys_guard
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_keys_guard();

create trigger set_project_credentials_updated_at
  before update on public.project_credentials
  for each row execute function public.handle_updated_at();

create trigger set_project_time_entries_updated_at
  before update on public.project_time_entries
  for each row execute function public.handle_updated_at();

create trigger set_project_hourly_rates_updated_at
  before update on public.project_hourly_rates
  for each row execute function public.handle_updated_at();

create or replace function public.protect_invoiced_time_entry()
returns trigger as $$
begin
  if exists (
    select 1 from public.invoice_time_entry_allocations allocation
    where allocation.time_entry_id = old.id
  ) and (
    new.start_time is distinct from old.start_time or
    new.end_time is distinct from old.end_time or
    new.segments is distinct from old.segments or
    new.hourly_rate is distinct from old.hourly_rate
  ) then
    raise exception 'Invoiced time entry billing details are locked';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger protect_invoiced_time_entry
  before update on public.project_time_entries
  for each row execute function public.protect_invoiced_time_entry();

-- Hours on a draft or sent invoice are billed (20261018172146): unbilled time is
-- approved client time beyond the FIFO pool of paid hourly dollars, minus the
-- slices draft, sent or overdue invoices hold. invoice_hours_draft builds the
-- hourly line exactly as lib/invoice-utils.ts does, for the scheduled drafter
-- and the form alike. validate_invoice_time_allocations refuses held,
-- unapproved or internal time.
CREATE OR REPLACE FUNCTION public.workspace_timezone()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text;
BEGIN
  FOR zone IN
    SELECT member.timezone
    FROM public.team_members member
    WHERE member.role = 'owner'
      AND member.timezone ~ '^[A-Za-z][A-Za-z0-9_-]*(/[A-Za-z0-9_+-]+)*$'
    ORDER BY member.created_at
  LOOP
    BEGIN
      PERFORM now() AT TIME ZONE zone;
      RETURN zone;
    EXCEPTION WHEN invalid_parameter_value THEN
      NULL;
    END;
  END LOOP;
  RETURN 'UTC';
END;
$$;

CREATE OR REPLACE FUNCTION public.time_entry_worked_hours(p_segments jsonb, p_start timestamptz, p_end timestamptz)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_array_length(COALESCE(p_segments, '[]'::jsonb)) > 0 THEN COALESCE((
      SELECT sum(extract(epoch from ((segment->>'end')::timestamptz - (segment->>'start')::timestamptz)) / 3600)
      FROM jsonb_array_elements(p_segments) segment
      WHERE segment->>'end' IS NOT NULL
    ), 0)
    ELSE COALESCE(extract(epoch from (p_end - p_start)) / 3600, 0)
  END
$$;

CREATE OR REPLACE FUNCTION public.invoice_paid_hourly_pool(p_project_id uuid, p_exclude_invoice_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(sum(CASE
    WHEN jsonb_array_length(COALESCE(invoice.line_items, '[]'::jsonb)) = 0 THEN
      CASE WHEN invoice.invoice_type = 'hourly' THEN invoice.amount ELSE 0 END
    ELSE (
      SELECT COALESCE(sum(COALESCE(NULLIF(line->>'amount', '')::numeric, 0)), 0)
      FROM jsonb_array_elements(invoice.line_items) line
      WHERE line->>'item_type' = 'hourly'
    )
  END), 0)
  FROM public.project_invoices invoice
  WHERE invoice.project_id = p_project_id
    AND invoice.status = 'paid'
    AND invoice.deleted_at IS NULL
    AND invoice.id IS DISTINCT FROM p_exclude_invoice_id
$$;

-- Paid hourly dollars, plus hourly lines on draft, sent or overdue invoices
-- that no session allocation backs.
CREATE OR REPLACE FUNCTION public.invoice_billed_hourly_pool(p_project_id uuid, p_exclude_invoice_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.invoice_paid_hourly_pool(p_project_id, p_exclude_invoice_id) + COALESCE((
    SELECT sum(CASE
      WHEN jsonb_array_length(COALESCE(invoice.line_items, '[]'::jsonb)) = 0 THEN
        CASE WHEN invoice.invoice_type = 'hourly'
              AND NOT EXISTS (SELECT 1 FROM public.invoice_time_entry_allocations a WHERE a.invoice_id = invoice.id)
             THEN invoice.amount ELSE 0 END
      ELSE (
        SELECT COALESCE(sum(COALESCE(NULLIF(line->>'amount', '')::numeric, 0)), 0)
        FROM jsonb_array_elements(invoice.line_items) line
        WHERE line->>'item_type' = 'hourly'
          AND NOT EXISTS (
            SELECT 1 FROM public.invoice_time_entry_allocations a
            WHERE a.invoice_id = invoice.id AND a.line_item_id = line->>'id'
          )
      )
    END)
    FROM public.project_invoices invoice
    WHERE invoice.project_id = p_project_id
      AND invoice.status IN ('draft', 'sent', 'overdue')
      AND invoice.deleted_at IS NULL
      AND invoice.id IS DISTINCT FROM p_exclude_invoice_id
  ), 0)
$$;

CREATE OR REPLACE FUNCTION public.invoice_unbilled_slices(p_project_id uuid, p_exclude_invoice_id uuid DEFAULT NULL)
RETURNS TABLE (
  time_entry_id uuid,
  start_time timestamptz,
  end_time timestamptz,
  rate numeric,
  start_offset_hours numeric,
  hours numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  money_eps CONSTANT numeric := 0.005000001;
  hours_eps CONSTANT numeric := 0.000050001;
  pool numeric := public.invoice_billed_hourly_pool(p_project_id, p_exclude_invoice_id);
  entry record;
  worked numeric;
  cost numeric;
  portion_start numeric;
  free nummultirange;
  piece numrange;
BEGIN
  FOR entry IN
    SELECT e.id, e.start_time, e.end_time, e.hourly_rate, e.segments
    FROM public.project_time_entries e
    WHERE e.project_id = p_project_id
      AND e.end_time IS NOT NULL
      AND e.work_type <> 'internal'
      AND e.approval_status = 'approved'
      AND e.deleted_at IS NULL
    ORDER BY e.start_time, e.id
  LOOP
    IF entry.hourly_rate IS NULL OR entry.hourly_rate <= 0 THEN CONTINUE; END IF;
    worked := public.time_entry_worked_hours(entry.segments, entry.start_time, entry.end_time);
    cost := worked * entry.hourly_rate;
    IF cost <= money_eps THEN CONTINUE; END IF;

    IF pool + money_eps >= cost THEN
      pool := CASE WHEN pool - cost > money_eps THEN pool - cost ELSE 0 END;
      CONTINUE;
    END IF;
    IF pool > money_eps THEN
      IF cost - pool <= money_eps THEN pool := 0; CONTINUE; END IF;
      portion_start := pool / entry.hourly_rate;
      pool := 0;
    ELSE
      portion_start := 0;
    END IF;

    free := nummultirange(numrange(portion_start, worked, '[)')) - COALESCE((
      SELECT range_agg(numrange(a.start_offset_hours, a.start_offset_hours + a.allocated_hours, '[)'))
      FROM public.invoice_time_entry_allocations a
      JOIN public.project_invoices i ON i.id = a.invoice_id
      WHERE a.time_entry_id = entry.id
        AND i.status IN ('draft', 'sent', 'overdue')
        AND i.deleted_at IS NULL
        AND i.id IS DISTINCT FROM p_exclude_invoice_id
    ), '{}'::nummultirange);

    -- An invoice line holds one allocation per session, so a session split
    -- by a held piece in its middle offers its first free piece now and the
    -- rest to the next invoice (the browser walk does the same).
    FOR piece IN SELECT p FROM unnest(free) p ORDER BY lower(p) LOOP
      IF upper(piece) - lower(piece) > hours_eps THEN
        time_entry_id := entry.id;
        start_time := entry.start_time;
        end_time := entry.end_time;
        rate := entry.hourly_rate;
        start_offset_hours := lower(piece);
        hours := upper(piece) - lower(piece);
        RETURN NEXT;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoice_hours_draft_internal(
  p_project_id uuid,
  p_mode text DEFAULT 'all',
  p_target numeric DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_through timestamptz DEFAULT NULL,
  p_exclude_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  money_eps CONSTANT numeric := 0.005000001;
  hours_eps CONSTANT numeric := 0.000050001;
  slice record;
  used_hours numeric;
  used_amount numeric;
  total_hours numeric := 0;
  total_amount numeric := 0;
  remaining numeric;
  first_start timestamptz;
  last_end timestamptz;
  ids uuid[] := '{}';
  offsets numeric[] := '{}';
  hours_list numeric[] := '{}';
  cents bigint[] := '{}';
  target_cents bigint;
  difference bigint;
  direction int;
  cursor_at int := 0;
  idx int;
  zone text := public.workspace_timezone();
  allocations jsonb := '[]'::jsonb;
  hours_text text;
BEGIN
  IF p_mode NOT IN ('all', 'hours', 'amount') THEN
    RAISE EXCEPTION 'invoice_hours_draft: mode must be all, hours or amount' USING ERRCODE = '22023';
  END IF;
  IF p_mode <> 'all' AND (p_target IS NULL OR p_target <= 0) THEN RETURN NULL; END IF;
  remaining := p_target;

  FOR slice IN
    SELECT * FROM public.invoice_unbilled_slices(p_project_id, p_exclude_invoice_id) s
    WHERE (p_from IS NULL OR s.start_time >= p_from)
      AND (p_through IS NULL OR s.start_time < p_through)
  LOOP
    IF p_mode = 'hours' THEN
      IF p_target - total_hours <= hours_eps THEN EXIT; END IF;
      used_hours := LEAST(slice.hours, p_target - total_hours);
      IF used_hours <= hours_eps THEN CONTINUE; END IF;
      used_amount := used_hours * slice.rate;
    ELSIF p_mode = 'amount' THEN
      IF remaining <= money_eps THEN EXIT; END IF;
      used_amount := LEAST(slice.hours * slice.rate, remaining);
      used_hours := used_amount / slice.rate;
      remaining := remaining - used_amount;
    ELSE
      used_hours := slice.hours;
      used_amount := slice.hours * slice.rate;
    END IF;

    total_hours := total_hours + used_hours;
    total_amount := total_amount + used_amount;
    first_start := COALESCE(first_start, slice.start_time);
    last_end := CASE WHEN p_mode = 'all' THEN GREATEST(COALESCE(last_end, slice.end_time), slice.end_time) ELSE slice.end_time END;
    ids := ids || slice.time_entry_id;
    offsets := offsets || slice.start_offset_hours;
    hours_list := hours_list || used_hours;
    cents := cents || round(round(used_amount, 2) * 100)::bigint;
  END LOOP;

  IF total_hours <= 0 OR first_start IS NULL THEN RETURN NULL; END IF;

  target_cents := round(total_amount * 100)::bigint;
  difference := target_cents - (SELECT COALESCE(sum(c), 0) FROM unnest(cents) c);
  direction := CASE WHEN difference > 0 THEN 1 ELSE -1 END;
  WHILE difference <> 0 LOOP
    idx := (cursor_at % array_length(cents, 1)) + 1;
    IF direction > 0 OR cents[idx] > 0 THEN
      cents[idx] := cents[idx] + direction;
      difference := difference - direction;
    END IF;
    cursor_at := cursor_at + 1;
  END LOOP;

  FOR idx IN 1 .. array_length(ids, 1) LOOP
    allocations := allocations || jsonb_build_object(
      'time_entry_id', ids[idx],
      'start_offset_hours', offsets[idx],
      'allocated_hours', hours_list[idx],
      'allocated_amount', cents[idx]::numeric / 100
    );
  END LOOP;

  hours_text := rtrim(rtrim(to_char(round(total_hours, 4), 'FM999999990.0000'), '0'), '.');
  RETURN jsonb_build_object(
    'hours', total_hours,
    'amount', round(total_amount, 2),
    'start_time', first_start,
    'end_time', last_end,
    'description', hours_text || ' hours worked between '
      || to_char(first_start AT TIME ZONE zone, 'MM/DD/YYYY') || ' and '
      || to_char(last_end AT TIME ZONE zone, 'MM/DD/YYYY'),
    'allocations', allocations
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.invoice_hours_draft(
  p_project_id uuid,
  p_mode text DEFAULT 'all',
  p_target numeric DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_through timestamptz DEFAULT NULL,
  p_exclude_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'Not allowed to draft invoices on this project' USING ERRCODE = '42501';
  END IF;
  RETURN public.invoice_hours_draft_internal(p_project_id, p_mode, p_target, p_from, p_through, p_exclude_invoice_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_invoice_time_allocations(target_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  clash record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_invoices invoice ON invoice.id = allocation.invoice_id
    LEFT JOIN LATERAL jsonb_array_elements(invoice.line_items) line_item
      ON line_item->>'id' = allocation.line_item_id
    WHERE allocation.invoice_id = target_invoice_id
      AND (line_item IS NULL OR line_item->>'item_type' IS DISTINCT FROM 'hourly')
  ) THEN
    RAISE EXCEPTION 'Invoice allocation points to a missing or non-hourly line item';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_invoices invoice ON invoice.id = allocation.invoice_id
    LEFT JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND (
        entry.id IS NULL
        OR entry.project_id IS DISTINCT FROM invoice.project_id
        OR entry.end_time IS NULL
        OR entry.hourly_rate <= 0
        OR entry.deleted_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Invoice allocation points to an invalid time session';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND (entry.approval_status IS DISTINCT FROM 'approved' OR entry.work_type = 'internal')
  ) THEN
    RAISE EXCEPTION 'Only approved client time can be invoiced';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND allocation.start_offset_hours + allocation.allocated_hours
        > public.time_entry_worked_hours(entry.segments, entry.start_time, entry.end_time) + 0.0000011
  ) THEN
    RAISE EXCEPTION 'Invoice allocation extends beyond its tracked session';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND abs(round(allocation.allocated_hours * entry.hourly_rate, 2) - allocation.allocated_amount) > 0.01
  ) THEN
    RAISE EXCEPTION 'Invoice allocation amount disagrees with its session rate';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations left_allocation
    JOIN public.invoice_time_entry_allocations right_allocation
      ON right_allocation.invoice_id = left_allocation.invoice_id
      AND right_allocation.time_entry_id = left_allocation.time_entry_id
      AND right_allocation.id > left_allocation.id
    WHERE left_allocation.invoice_id = target_invoice_id
      AND numrange(left_allocation.start_offset_hours, left_allocation.start_offset_hours + left_allocation.allocated_hours, '[)')
       && numrange(right_allocation.start_offset_hours, right_allocation.start_offset_hours + right_allocation.allocated_hours, '[)')
  ) THEN
    RAISE EXCEPTION 'A time session is billed more than once on the same invoice';
  END IF;

  -- A cancelled or trashed invoice holds nothing; a live one must not share a slice
  -- with another live invoice (a margin under a millionth of an hour is
  -- rounding, not a clash).
  SELECT other.invoice_number INTO clash
  FROM public.invoice_time_entry_allocations mine
  JOIN public.project_invoices me ON me.id = mine.invoice_id
  JOIN public.invoice_time_entry_allocations theirs
    ON theirs.time_entry_id = mine.time_entry_id AND theirs.invoice_id <> mine.invoice_id
  JOIN public.project_invoices other ON other.id = theirs.invoice_id
  WHERE mine.invoice_id = target_invoice_id
    AND me.status <> 'cancelled'
    AND other.status <> 'cancelled'
    AND other.deleted_at IS NULL
    AND mine.start_offset_hours < theirs.start_offset_hours + theirs.allocated_hours - 0.000001
    AND theirs.start_offset_hours < mine.start_offset_hours + mine.allocated_hours - 0.000001
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Some of these hours are already on invoice %', clash.invoice_number USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.project_invoices invoice
    CROSS JOIN LATERAL jsonb_array_elements(invoice.line_items) line_item
    JOIN (
      SELECT line_item_id, sum(allocated_amount) AS allocated_amount
      FROM public.invoice_time_entry_allocations
      WHERE invoice_id = target_invoice_id
      GROUP BY line_item_id
    ) totals ON totals.line_item_id = line_item->>'id'
    WHERE invoice.id = target_invoice_id
      AND totals.allocated_amount IS DISTINCT FROM round((line_item->>'amount')::numeric, 2)
  ) THEN
    RAISE EXCEPTION 'Hourly allocation totals do not match the invoice line amount';
  END IF;
END;
$$;

create or replace function public.save_project_invoice_with_allocations(
  p_invoice_id uuid,
  p_invoice jsonb,
  p_allocations jsonb
)
returns public.project_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_invoice public.project_invoices;
  saved public.project_invoices;
  target_project_id uuid;
begin
  p_invoice := coalesce(p_invoice, '{}'::jsonb);

  if coalesce(auth.role(), '') <> 'service_role' then
    if not public.has_permission('invoices.manage', 'app') then
      raise exception 'Missing permission to manage invoices';
    end if;
  end if;

  if p_invoice_id is null then
    target_project_id := (p_invoice->>'project_id')::uuid;
    if target_project_id is null then
      raise exception 'Invoice project is required';
    end if;
    if not public.project_is_live(target_project_id) then
      raise exception 'Project not found';
    end if;
    if coalesce(auth.role(), '') <> 'service_role'
      and not public.can_access_project(target_project_id) then
      raise exception 'Project access denied';
    end if;

    insert into public.project_invoices (
      project_id, invoice_number, amount, status, invoice_type, line_items,
      date, due_date, paid_date, description, file_url, file_name, file_size,
      mime_type, created_by
    ) values (
      target_project_id,
      p_invoice->>'invoice_number',
      coalesce((p_invoice->>'amount')::numeric, 0),
      coalesce(p_invoice->>'status', 'draft'),
      coalesce(p_invoice->>'invoice_type', 'hourly'),
      coalesce(nullif(p_invoice->'line_items', 'null'::jsonb), '[]'::jsonb),
      p_invoice->>'date',
      p_invoice->>'due_date',
      p_invoice->>'paid_date',
      coalesce(p_invoice->>'description', ''),
      p_invoice->>'file_url',
      p_invoice->>'file_name',
      (p_invoice->>'file_size')::bigint,
      p_invoice->>'mime_type',
      (p_invoice->>'created_by')::uuid
    )
    returning * into saved;
  else
    select * into existing_invoice
    from public.project_invoices
    where id = p_invoice_id
      and deleted_at is null;

    if not found then
      raise exception 'Invoice not found';
    end if;

    target_project_id := case
      when p_invoice ? 'project_id' then (p_invoice->>'project_id')::uuid
      else existing_invoice.project_id
    end;
    if target_project_id is null then
      raise exception 'Invoice project is required';
    end if;
    if not public.project_is_live(target_project_id) then
      raise exception 'Project not found';
    end if;
    if coalesce(auth.role(), '') <> 'service_role'
      and (
        not public.can_access_project(existing_invoice.project_id)
        or not public.can_access_project(target_project_id)
      ) then
      raise exception 'Project access denied';
    end if;

    update public.project_invoices invoice
    set
      project_id = case when p_invoice ? 'project_id' then target_project_id else invoice.project_id end,
      invoice_number = case when p_invoice ? 'invoice_number' then p_invoice->>'invoice_number' else invoice.invoice_number end,
      amount = case when p_invoice ? 'amount' then (p_invoice->>'amount')::numeric else invoice.amount end,
      status = case when p_invoice ? 'status' then p_invoice->>'status' else invoice.status end,
      invoice_type = case when p_invoice ? 'invoice_type' then p_invoice->>'invoice_type' else invoice.invoice_type end,
      line_items = case when p_invoice ? 'line_items' then coalesce(nullif(p_invoice->'line_items', 'null'::jsonb), '[]'::jsonb) else invoice.line_items end,
      date = case when p_invoice ? 'date' then p_invoice->>'date' else invoice.date end,
      due_date = case when p_invoice ? 'due_date' then p_invoice->>'due_date' else invoice.due_date end,
      paid_date = case when p_invoice ? 'paid_date' then p_invoice->>'paid_date' else invoice.paid_date end,
      description = case when p_invoice ? 'description' then coalesce(p_invoice->>'description', '') else invoice.description end,
      file_url = case when p_invoice ? 'file_url' then p_invoice->>'file_url' else invoice.file_url end,
      file_name = case when p_invoice ? 'file_name' then p_invoice->>'file_name' else invoice.file_name end,
      file_size = case when p_invoice ? 'file_size' then (p_invoice->>'file_size')::bigint else invoice.file_size end,
      mime_type = case when p_invoice ? 'mime_type' then p_invoice->>'mime_type' else invoice.mime_type end,
      created_by = case when p_invoice ? 'created_by' then (p_invoice->>'created_by')::uuid else invoice.created_by end
    where invoice.id = p_invoice_id
    returning * into saved;

    if not found then
      raise exception 'Invoice not found';
    end if;
  end if;

  if p_allocations is not null then
    delete from public.invoice_time_entry_allocations
    where invoice_id = saved.id;

    insert into public.invoice_time_entry_allocations (
      invoice_id, line_item_id, time_entry_id, start_offset_hours,
      allocated_hours, allocated_amount
    )
    select
      saved.id,
      allocation.line_item_id,
      allocation.time_entry_id,
      allocation.start_offset_hours,
      allocation.allocated_hours,
      allocation.allocated_amount
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb)) as allocation(
      line_item_id text,
      time_entry_id uuid,
      start_offset_hours numeric,
      allocated_hours numeric,
      allocated_amount numeric
    );
  end if;

  perform public.validate_invoice_time_allocations(saved.id);
  return saved;
end;
$$;

REVOKE ALL ON FUNCTION public.workspace_timezone() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_paid_hourly_pool(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_billed_hourly_pool(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_billed_hourly_pool(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.invoice_unbilled_slices(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_hours_draft_internal(uuid, text, numeric, timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_hours_draft(uuid, text, numeric, timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_hours_draft(uuid, text, numeric, timestamptz, timestamptz, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workspace_timezone() TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_unbilled_slices(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_hours_draft_internal(uuid, text, numeric, timestamptz, timestamptz, uuid) TO service_role;
revoke all on function public.validate_invoice_time_allocations(uuid) from public;
revoke all on function public.save_project_invoice_with_allocations(uuid, jsonb, jsonb) from public;
grant execute on function public.save_project_invoice_with_allocations(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.save_project_invoice_with_allocations(uuid, jsonb, jsonb) to service_role;

create trigger set_portal_updates_updated_at
  before update on public.portal_updates
  for each row execute function public.handle_updated_at();

create trigger set_portal_update_attachments_updated_at
  before update on public.portal_update_attachments
  for each row execute function public.handle_updated_at();

create trigger set_project_invoices_updated_at
  before update on public.project_invoices
  for each row execute function public.handle_updated_at();

create trigger set_webhook_endpoints_updated_at
  before update on public.webhook_endpoints
  for each row execute function public.handle_updated_at();

create trigger set_webhook_deliveries_updated_at
  before update on public.webhook_deliveries
  for each row execute function public.handle_updated_at();

-- Emits invoice.paid / invoice.updated / invoice.deleted events for
-- paid-relevant invoices and fans out deliveries. See migration
-- 20260725154128_create_webhooks.sql for the annotated version.
-- What the company keeps of an invoice after revenue splits. Only fixed and
-- recurring lines can carry a split; every other line is its full amount.
create or replace function public.invoice_net_amounts(p_invoice public.project_invoices)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lines jsonb := coalesce(nullif(p_invoice.line_items, 'null'::jsonb), '[]'::jsonb);
  v_result jsonb;
begin
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) = 0 then
    return jsonb_build_object(
      'amount', p_invoice.amount,
      'totals_by_type', jsonb_build_object(p_invoice.invoice_type, p_invoice.amount),
      'line_items', '{}'::jsonb
    );
  end if;

  with net_lines as (
    select
      li->>'id' as line_id,
      li->>'item_type' as item_type,
      round(
        (li->>'amount')::numeric * (1 - least(100, coalesce((
          select sum(share.percent)
          from public.invoice_line_shares share
          where share.invoice_id = p_invoice.id
            and share.line_item_id = li->>'id'
            and li->>'item_type' in ('fixed', 'recurring')
        ), 0)) / 100),
        2
      ) as net_amount
    from jsonb_array_elements(v_lines) li
  )
  select jsonb_build_object(
    'amount', coalesce(sum(net_amount), 0),
    'totals_by_type', coalesce((
      select jsonb_object_agg(t.item_type, t.subtotal)
      from (
        select item_type, sum(net_amount) as subtotal
        from net_lines where item_type is not null group by item_type
      ) t
    ), '{}'::jsonb),
    'line_items', coalesce(jsonb_object_agg(line_id, net_amount) filter (where line_id is not null), '{}'::jsonb)
  )
  into v_result
  from net_lines;

  return v_result;
end;
$$;

-- The event writer, split out of the trigger so a split change on a paid
-- invoice can announce itself too (see emit_invoice_webhook_for_shares).
-- p_data is merged into the payload's data (the payment events use it).
create or replace function public.emit_invoice_webhook_event(
  p_row public.project_invoices,
  p_event_type text,
  p_data jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_paid boolean := (p_event_type <> 'invoice.deleted' and p_row.status = 'paid');
  v_project_name text;
  v_totals jsonb;
  v_public_id text;
  v_seq bigint;
  v_event_uuid uuid;
  v_payload jsonb;
begin
  if not exists (
    select 1 from public.webhook_endpoints e
    where e.is_active and p_event_type = any(e.events)
  ) then
    return;
  end if;

  select name into v_project_name
  from public.projects where id = p_row.project_id;

  select coalesce(jsonb_object_agg(t.item_type, t.subtotal), '{}'::jsonb)
    into v_totals
  from (
    select li->>'item_type' as item_type, sum((li->>'amount')::numeric) as subtotal
    from jsonb_array_elements(
           coalesce(nullif(p_row.line_items, 'null'::jsonb), '[]'::jsonb)
         ) li
    where li ? 'item_type'
    group by li->>'item_type'
  ) t;

  if v_totals = '{}'::jsonb then
    v_totals := jsonb_build_object(p_row.invoice_type, p_row.amount);
  end if;

  v_seq := nextval('public.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  v_payload := jsonb_build_object(
    'id', v_public_id,
    'type', p_event_type,
    'sequence', v_seq,
    'created_at', now(),
    'data', jsonb_build_object(
      'invoice', jsonb_build_object(
        'id', p_row.id,
        'invoice_number', p_row.invoice_number,
        'project_id', p_row.project_id,
        'status', p_row.status,
        'paid', v_is_paid,
        'invoice_type', p_row.invoice_type,
        'amount', p_row.amount,
        'date', p_row.date,
        'due_date', p_row.due_date,
        'paid_date', p_row.paid_date,
        'description', p_row.description,
        'updated_at', p_row.updated_at
      ),
      'project', jsonb_build_object(
        'id', p_row.project_id,
        'name', coalesce(v_project_name, '')
      ),
      'line_items', coalesce(nullif(p_row.line_items, 'null'::jsonb), '[]'::jsonb),
      'totals_by_type', v_totals
    ) || coalesce(p_data, '{}'::jsonb)
  );

  insert into public.webhook_events (
    event_id, sequence, event_type, resource_type, resource_id, payload, net_amounts
  )
  values (
    v_public_id, v_seq, p_event_type, 'invoice', p_row.id, v_payload,
    public.invoice_net_amounts(p_row)
  )
  returning id into v_event_uuid;

  insert into public.webhook_deliveries (webhook_event_id, endpoint_id)
  select v_event_uuid, e.id
  from public.webhook_endpoints e
  where e.is_active and p_event_type = any(e.events);
end;
$$;

-- Same rules as before for when an invoice change is worth an event.
create or replace function public.emit_invoice_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op text := TG_OP;
  v_was_paid boolean;
  v_is_paid boolean;
begin
  v_was_paid := (v_op <> 'INSERT' and OLD.status = 'paid');
  v_is_paid  := (v_op <> 'DELETE' and NEW.status = 'paid');

  if v_op = 'DELETE' then
    if v_was_paid then
      perform public.emit_invoice_webhook_event(OLD, 'invoice.deleted');
    end if;
    return OLD;
  end if;

  -- Moved to Trash: what a delete used to send. Restored: what creating it
  -- would send. Edits while it is in Trash send nothing.
  if v_op = 'UPDATE' and NEW.deleted_at is not null then
    if OLD.deleted_at is null and v_was_paid then
      perform public.emit_invoice_webhook_event(OLD, 'invoice.deleted');
    end if;
    return NEW;
  end if;
  if v_op = 'UPDATE' and OLD.deleted_at is not null then
    if v_is_paid then
      perform public.emit_invoice_webhook_event(NEW, 'invoice.paid');
    end if;
    return NEW;
  end if;

  if v_op = 'INSERT' then
    if v_is_paid then
      perform public.emit_invoice_webhook_event(NEW, 'invoice.paid');
    end if;
    return NEW;
  end if;

  if not (v_is_paid or v_was_paid) then
    return NEW;
  end if;

  if v_is_paid and not v_was_paid then
    perform public.emit_invoice_webhook_event(NEW, 'invoice.paid');
    return NEW;
  end if;

  if v_is_paid and v_was_paid
     and NEW.status is not distinct from OLD.status
     and NEW.paid_date is not distinct from OLD.paid_date
     and NEW.amount is not distinct from OLD.amount
     and NEW.line_items is not distinct from OLD.line_items
     and NEW.invoice_number is not distinct from OLD.invoice_number
     and NEW.invoice_type is not distinct from OLD.invoice_type
     and NEW.project_id is not distinct from OLD.project_id then
    return NEW;
  end if;

  perform public.emit_invoice_webhook_event(NEW, 'invoice.updated');
  return NEW;
end;
$$;

create trigger emit_invoice_webhook
  after insert or update or delete on public.project_invoices
  for each row execute function public.emit_invoice_webhook();

-- The body one endpoint receives. amount_basis is always stated. For a net
-- endpoint the invoice amount, each line amount and totals_by_type are the
-- company's part; the gross figures are not sent alongside, so a receiver
-- cannot mix the two.
create or replace function public.webhook_payload_for_endpoint(
  p_payload jsonb,
  p_net jsonb,
  p_basis text
)
returns jsonb
language sql
immutable
as $$
  select case
    when p_basis = 'net' and p_net is not null and p_payload ? 'data' then
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(p_payload, '{data,amount_basis}', '"net"'::jsonb),
            '{data,invoice,amount}', p_net->'amount'
          ),
          '{data,totals_by_type}', p_net->'totals_by_type'
        ),
        '{data,line_items}',
        coalesce((
          select jsonb_agg(
            case when (p_net->'line_items') ? (li.value->>'id')
              then li.value || jsonb_build_object('amount', p_net->'line_items'->(li.value->>'id'))
              else li.value end
            order by li.ordinality
          )
          from jsonb_array_elements(p_payload->'data'->'line_items') with ordinality as li(value, ordinality)
        ), '[]'::jsonb)
      )
    when p_payload ? 'data' then
      jsonb_set(p_payload, '{data,amount_basis}', '"gross"'::jsonb)
    else p_payload
  end
$$;

-- Lease-based claim for the dispatcher: due deliveries, head of the line per
-- invoice and endpoint, in sequence order. complete_webhook_delivery records
-- each attempt and schedules the retry. See migration
-- 20261018220437_webhook_delivery_retries.sql.
CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(p_limit int DEFAULT 20)
RETURNS TABLE (
  delivery_id uuid,
  attempt_token uuid,
  attempts int,
  endpoint_id uuid,
  endpoint_url text,
  endpoint_secret text,
  event_public_id text,
  event_type text,
  event_sequence bigint,
  resource_id uuid,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  max_attempts constant int := 8;  -- WEBHOOK_MAX_ATTEMPTS
BEGIN
  -- One claimer at a time, so two runs cannot both pass the ordering check
  -- for the same invoice. Released at commit, before any HTTP happens.
  PERFORM pg_advisory_xact_lock(hashtext('public.claim_webhook_deliveries'));

  -- A lease that ran out on the last attempt has nothing left to retry.
  UPDATE public.webhook_deliveries d
  SET status = 'failed',
      last_error = coalesce(d.last_error, 'Delivery did not finish before its lease expired'),
      attempt_token = NULL,
      lease_expires_at = NULL
  WHERE d.status = 'delivering'
    AND coalesce(d.lease_expires_at, '-infinity') <= now()
    AND d.attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT d.id
    FROM public.webhook_deliveries d
    JOIN public.webhook_events ev ON ev.id = d.webhook_event_id
    JOIN public.webhook_endpoints ep ON ep.id = d.endpoint_id
    WHERE ep.is_active
      AND (
        (d.status = 'pending' AND d.next_attempt_at <= now())
        OR (d.status = 'delivering' AND coalesce(d.lease_expires_at, '-infinity') <= now())
      )
      -- Head of the line: nothing earlier for this invoice and endpoint is
      -- still waiting, and nothing for it is in flight under a live lease.
      AND NOT EXISTS (
        SELECT 1
        FROM public.webhook_deliveries other
        JOIN public.webhook_events other_ev ON other_ev.id = other.webhook_event_id
        WHERE other.endpoint_id = d.endpoint_id
          AND other.id <> d.id
          AND other_ev.resource_type = ev.resource_type
          AND coalesce(other_ev.resource_id, other_ev.id) = coalesce(ev.resource_id, ev.id)
          AND (
            (other.status IN ('pending', 'delivering') AND other_ev.sequence < ev.sequence)
            OR (other.status = 'delivering' AND coalesce(other.lease_expires_at, '-infinity') > now())
          )
      )
    ORDER BY ev.sequence
    LIMIT p_limit
    FOR UPDATE OF d SKIP LOCKED
  )
  UPDATE public.webhook_deliveries d
  SET status = 'delivering',
      attempts = d.attempts + 1,
      last_attempt_at = now(),
      attempt_token = gen_random_uuid(),
      lease_expires_at = now() + interval '2 minutes'
  FROM due, public.webhook_events ev, public.webhook_endpoints e
  WHERE d.id = due.id
    AND ev.id = d.webhook_event_id
    AND e.id = d.endpoint_id
  RETURNING d.id, d.attempt_token, d.attempts,
            e.id, e.url, e.secret,
            ev.event_id, ev.event_type, ev.sequence, ev.resource_id,
            public.webhook_payload_for_endpoint(ev.payload, ev.net_amounts, e.amount_basis);
END;
$$;

-- Records one attempt's outcome for the run that holds the lease. Returns
-- 'succeeded', 'retrying' (back to pending at next_attempt_at), 'failed'
-- (attempts used up) or 'stale' (the lease was taken back by another run,
-- which will deliver it again; nothing is written).
CREATE OR REPLACE FUNCTION public.complete_webhook_delivery(
  p_delivery_id uuid,
  p_attempt_token uuid,
  p_status_code int,
  p_error text,
  p_response text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  max_attempts constant int := 8;  -- WEBHOOK_MAX_ATTEMPTS
  d public.webhook_deliveries;
  outcome text;
BEGIN
  SELECT * INTO d FROM public.webhook_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'delivering' OR p_attempt_token IS NULL
     OR d.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN 'stale';
  END IF;

  outcome := CASE
    WHEN p_status_code BETWEEN 200 AND 299 THEN 'succeeded'
    WHEN d.attempts >= max_attempts THEN 'failed'
    ELSE 'retrying'
  END;

  UPDATE public.webhook_deliveries
  SET status = CASE outcome WHEN 'retrying' THEN 'pending' ELSE outcome END,
      delivered_at = CASE WHEN outcome = 'succeeded' THEN now() ELSE delivered_at END,
      next_attempt_at = CASE
        WHEN outcome = 'retrying'
          THEN now() + least(interval '12 hours', interval '1 minute' * power(3, d.attempts - 1))
        ELSE next_attempt_at
      END,
      last_status_code = p_status_code,
      last_error = CASE WHEN outcome = 'succeeded' THEN NULL ELSE left(p_error, 2000) END,
      last_response = left(nullif(p_response, ''), 2000),
      attempt_token = NULL,
      lease_expires_at = NULL
  WHERE id = d.id;

  IF outcome = 'succeeded' THEN
    UPDATE public.webhook_endpoints SET last_delivery_at = now() WHERE id = d.endpoint_id;
  END IF;
  RETURN outcome;
END;
$$;

-- Settings > Webhooks "Resend": a failed delivery starts over with a fresh
-- attempt budget. Runs as the caller, so the webhooks.manage RLS policy
-- decides who may. Returns false when the row is not failed (or not visible).
CREATE OR REPLACE FUNCTION public.requeue_webhook_delivery(p_delivery_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH requeued AS (
    UPDATE public.webhook_deliveries
    SET status = 'pending',
        attempts = 0,
        next_attempt_at = now(),
        last_error = NULL,
        attempt_token = NULL,
        lease_expires_at = NULL
    WHERE id = p_delivery_id AND status = 'failed'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM requeued)
$$;

-- pg_cron runs this every minute. When a delivery is due (a retry whose
-- backoff has passed, a new one the in-app kick missed, or an expired lease)
-- it asks the app to dispatch: POST /api/internal/webhooks/scheduled with
-- WEBHOOK_SCHEDULER_SECRET, read from Vault (webhook_scheduler_url,
-- webhook_scheduler_secret). Idle minutes make no request. Returns the
-- pg_net request id, or null when nothing was sent.
CREATE OR REPLACE FUNCTION public.webhook_retry_kick()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  app_url text;
  secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.webhook_deliveries d
    JOIN public.webhook_endpoints e ON e.id = d.endpoint_id
    WHERE e.is_active
      AND (
        (d.status = 'pending' AND d.next_attempt_at <= now())
        OR (d.status = 'delivering' AND coalesce(d.lease_expires_at, '-infinity') <= now())
      )
  ) THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO app_url FROM vault.decrypted_secrets WHERE name = 'webhook_scheduler_url';
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name = 'webhook_scheduler_secret';
  IF app_url IS NULL OR secret IS NULL THEN
    RAISE NOTICE 'webhook_scheduler_url or webhook_scheduler_secret is missing from Vault; webhook retries wait for the next in-app dispatch';
    RETURN NULL;
  END IF;

  RETURN net.http_post(
    url := rtrim(app_url, '/') || '/api/internal/webhooks/scheduled',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret),
    body := '{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_webhook_deliveries(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_webhook_delivery(uuid, uuid, int, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requeue_webhook_delivery(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.webhook_retry_kick() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_webhook_deliveries(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_webhook_delivery(uuid, uuid, int, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_webhook_delivery(uuid) TO authenticated;

-- Supabase only: skipped where pg_cron or pg_net is unavailable (PGlite).
-- Re-running cron.schedule updates the job in place.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS pg_net;
    PERFORM cron.schedule('webhook-retries', '* * * * *', $job$SELECT public.webhook_retry_kick();$job$);
  ELSE
    RAISE NOTICE 'pg_cron or pg_net is unavailable here; webhook retries will not be scheduled';
  END IF;
END;
$do$;

revoke all on function public.invoice_net_amounts(public.project_invoices) from public, anon, authenticated;
revoke all on function public.emit_invoice_webhook_event(public.project_invoices, text, jsonb) from public, anon, authenticated;
revoke all on function public.webhook_payload_for_endpoint(jsonb, jsonb, text) from public, anon, authenticated;

create trigger set_smtp_accounts_updated_at
  before update on public.smtp_accounts
  for each row execute function public.handle_updated_at();

create trigger set_business_settings_updated_at
  before update on public.business_settings
  for each row execute function public.handle_updated_at();

create trigger set_project_context_updated_at
  before update on public.project_context
  for each row execute function public.handle_updated_at();

-- ============================================================
-- AUTO-CREATE TEAM MEMBER ON SIGNUP
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.team_members (auth_user_id, name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.email,
    case
      when exists (select 1 from public.team_members) then 'member'
      else 'owner'
    end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- Enable RLS on all tables
alter table public.team_members enable row level security;
alter table public.contacts enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.project_contacts enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignees enable row level security;
alter table public.task_subtasks enable row level security;
alter table public.task_acceptance_criteria enable row level security;
alter table public.task_reviews enable row level security;
alter table public.agent_health enable row level security;
alter table public.agent_health_history enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.task_comments enable row level security;
alter table public.activities enable row level security;
alter table public.leads enable row level security;
alter table public.lead_interactions enable row level security;
alter table public.lead_proposals enable row level security;
alter table public.lead_fields enable row level security;
alter table public.lead_members enable row level security;
alter table public.lead_contacts enable row level security;
alter table public.portal_settings enable row level security;
alter table public.client_communications enable row level security;
alter table public.entity_files enable row level security;
alter table public.api_keys enable row level security;
alter table public.portal_updates enable row level security;
alter table public.portal_update_attachments enable row level security;
alter table public.portal_events enable row level security;
alter table public.project_time_entries enable row level security;
alter table public.time_entry_tasks enable row level security;
alter table public.project_hourly_rates enable row level security;
alter table public.invoice_time_entry_allocations enable row level security;
alter table public.project_credentials enable row level security;
alter table public.project_invoices enable row level security;
alter table public.team_member_notifications enable row level security;
alter table public.project_context enable row level security;
alter table public.project_budget_history enable row level security;

-- All authenticated users get full CRUD on shared data
create policy "team_members_all" on public.team_members
  for all to authenticated using (true) with check (true);

create policy "contacts_all" on public.contacts
  for all to authenticated using (true) with check (true);

create policy "projects_all" on public.projects
  for all to authenticated using (true) with check (true);

create policy "project_members_all" on public.project_members
  for all to authenticated using (true) with check (true);

create policy "project_contacts_all" on public.project_contacts
  for all to authenticated using (true) with check (true);

create policy "tasks_all" on public.tasks
  for all to authenticated using (true) with check (true);

create policy "task_assignees_all" on public.task_assignees
  for all to authenticated using (true) with check (true);

create policy "task_subtasks_all" on public.task_subtasks
  for all to authenticated using (true) with check (true);

create policy "task_comments_all" on public.task_comments
  for all to authenticated using (true) with check (true);

create policy "activities_all" on public.activities
  for all to authenticated using (true) with check (true);

create policy "leads_all" on public.leads
  for all to authenticated using (true) with check (true);

create policy "lead_interactions_all" on public.lead_interactions
  for all to authenticated using (true) with check (true);

create policy "lead_proposals_all" on public.lead_proposals
  for all to authenticated using (true) with check (true);

create policy "lead_fields_all" on public.lead_fields
  for all to authenticated using (true) with check (true);

create policy "lead_members_all" on public.lead_members
  for all to authenticated using (true) with check (true);

create policy "lead_contacts_all" on public.lead_contacts
  for all to authenticated using (true) with check (true);

create policy "portal_settings_all" on public.portal_settings
  for all to authenticated using (true) with check (true);

create policy "client_communications_all" on public.client_communications
  for all to authenticated using (true) with check (true);

create policy "project_budget_history_all" on public.project_budget_history
  for all to authenticated using (true) with check (true);

create policy "entity_files_all" on public.entity_files
  for all to authenticated using (true) with check (true);

create policy "portal_updates_all" on public.portal_updates
  for all to authenticated using (true) with check (true);

create policy "portal_update_attachments_all" on public.portal_update_attachments
  for all to authenticated using (true) with check (true);

create policy "portal_events_all" on public.portal_events
  for all to authenticated using (true) with check (true);

create policy "project_time_entries_all" on public.project_time_entries
  for all to authenticated using (true) with check (true);

create policy "time_entry_tasks_all" on public.time_entry_tasks
  for all to authenticated using (true) with check (true);

create policy "project_hourly_rates_all" on public.project_hourly_rates
  for all to authenticated using (true) with check (true);

create policy "invoice_time_entry_allocations_all" on public.invoice_time_entry_allocations
  for all to authenticated using (true) with check (true);

create policy "api_keys_all" on public.api_keys
  for all to authenticated using (true) with check (true);

create policy "project_credentials_all" on public.project_credentials
  for all to authenticated using (true) with check (true);

create policy "project_invoices_all" on public.project_invoices
  for all to authenticated using (true) with check (true);

create policy "project_context_all" on public.project_context
  for all to authenticated using (true) with check (true);

-- Users can only read/update/delete their own notifications.
-- Any authenticated user can insert (the store creates notifications for other users).
create policy "team_member_notifications_select_own" on public.team_member_notifications
  for select to authenticated
  using (user_id in (select id from public.team_members where auth_user_id = auth.uid()));

create policy "team_member_notifications_update_own" on public.team_member_notifications
  for update to authenticated
  using (user_id in (select id from public.team_members where auth_user_id = auth.uid()));

create policy "team_member_notifications_delete_own" on public.team_member_notifications
  for delete to authenticated
  using (user_id in (select id from public.team_members where auth_user_id = auth.uid()));

create policy "team_member_notifications_insert" on public.team_member_notifications
  for insert to authenticated
  with check (true);

-- ============================================================
-- STORAGE: Avatars Bucket (public, 5MB limit)
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', true, 5242880)
on conflict (id) do nothing;

create policy "Authenticated users can upload avatars"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars');

create policy "Authenticated users can update avatars"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars');

create policy "Authenticated users can delete avatars"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'avatars');

create policy "Public can read avatars"
  on storage.objects for select
  to public
  using (bucket_id = 'avatars');

-- ============================================================
-- STORAGE: Portal Files Bucket (public, 50MB limit) — used by portal update attachments
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('portal-files', 'portal-files', true, 52428800)
on conflict (id) do nothing;

create policy "Authenticated users can upload portal files"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'portal-files');

create policy "Authenticated users can update portal files"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'portal-files');

create policy "Authenticated users can delete portal files"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'portal-files');

create policy "Public can read portal files"
  on storage.objects for select
  to public
  using (bucket_id = 'portal-files');

-- ============================================================
-- STORAGE: Entity Files Bucket (public, 50MB limit)
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('entity-files', 'entity-files', true, 52428800)
on conflict (id) do nothing;

create policy "Authenticated users can upload entity files"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'entity-files');

create policy "Authenticated users can update entity files"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'entity-files');

create policy "Authenticated users can delete entity files"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'entity-files');

-- Object URLs on this public bucket skip policies, so shared links work;
-- listing and API reads need a session.
create policy "Authenticated users can read entity files"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'entity-files');

-- ============================================================
-- CURRENT TEAM ACCESS, COMPENSATION, AND PERMISSION MODEL
-- Kept in sync with the 20260720 and 20260721 migrations.
-- ============================================================
-- Team authorization, scoped API access, time approval, employee compensation,
-- credential sharing, and payout accounting.
--
-- This migration is additive. Legacy billing and API permission columns remain
-- in place so the application can be deployed before the database cutover.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- ---------------------------------------------------------------------------
-- Preflight and role lifecycle
-- ---------------------------------------------------------------------------

-- Fresh schema bootstrap has no legacy rows to validate.
ALTER TABLE public.team_members
  DROP CONSTRAINT IF EXISTS team_members_role_check;

ALTER TABLE public.team_members
  ADD CONSTRAINT team_members_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'guest', 'agent'));

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL;

ALTER TABLE public.team_members
  DROP CONSTRAINT IF EXISTS team_members_status_check;

ALTER TABLE public.team_members
  ADD CONSTRAINT team_members_status_check CHECK (status IN ('active', 'suspended'));

UPDATE public.team_members
SET role = 'owner'
WHERE role = 'admin'
  AND NOT EXISTS (SELECT 1 FROM public.team_members WHERE role = 'owner');

-- ---------------------------------------------------------------------------
-- App and API permissions
-- ---------------------------------------------------------------------------

CREATE TABLE public.role_permissions (
  role text NOT NULL CHECK (role IN ('admin', 'member', 'guest', 'agent')),
  permission_key text NOT NULL,
  access_channel text NOT NULL CHECK (access_channel IN ('app', 'api')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission_key, access_channel)
);

CREATE TABLE public.team_member_permissions (
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  access_channel text NOT NULL CHECK (access_channel IN ('app', 'api')),
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, permission_key, access_channel)
);

CREATE INDEX idx_team_member_permissions_member
  ON public.team_member_permissions(member_id);

CREATE TRIGGER set_role_permissions_updated_at
  BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_team_member_permissions_updated_at
  BEFORE UPDATE ON public.team_member_permissions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

INSERT INTO public.role_permissions (role, permission_key, access_channel)
VALUES
  -- Admin app permissions. Access policy and Owner lifecycle remain Owner-only.
  ('admin','team.read','app'), ('admin','team.manage','app'),
  ('admin','settings.manage','app'), ('admin','smtp.manage','app'),
  ('admin','audit.read','app'), ('admin','projects.read','app'),
  ('admin','projects.read_all','app'), ('admin','projects.manage','app'),
  ('admin','project_members.manage','app'), ('admin','tasks.read','app'),
  ('admin','tasks.create','app'), ('admin','tasks.manage_assigned','app'),
  ('admin','tasks.manage_all','app'), ('admin','time.manage_own','app'),
  ('admin','time.read_all','app'), ('admin','time.manage_all','app'),
  ('admin','time.approve','app'), ('admin','contacts.read','app'),
  ('admin','contacts.read_all','app'), ('admin','contacts.manage','app'),
  ('admin','leads.read','app'), ('admin','leads.read_all','app'),
  ('admin','leads.manage','app'), ('admin','files.read','app'),
  ('admin','files.upload','app'), ('admin','files.manage','app'),
  ('admin','portal.read','app'), ('admin','portal.manage','app'),
  ('admin','communications.read','app'), ('admin','communications.manage','app'),
  ('admin','credentials.reveal_shared','app'), ('admin','credentials.manage','app'),
  ('admin','invoices.read','app'), ('admin','invoices.manage','app'),
  ('admin','webhooks.manage','app'),
  ('admin','billing.manage','app'), ('admin','finance.company.read','app'),
  ('admin','earnings.own.read','app'), ('admin','compensation.manage','app'),
  ('admin','payouts.manage','app'), ('admin','agents.manage','app'),
  ('admin','project_context.read','app'), ('admin','project_context.manage','app'),
  ('admin','goals.read','app'), ('admin','goals.manage','app'),
  ('admin','suggestions.manage','app'),

  -- Admin API defaults intentionally omit finance, credentials, access, and SMTP.
  ('admin','projects.read','api'), ('admin','projects.read_all','api'),
  ('admin','projects.manage','api'), ('admin','project_members.manage','api'),
  ('admin','tasks.read','api'), ('admin','tasks.create','api'),
  ('admin','tasks.manage_assigned','api'), ('admin','tasks.manage_all','api'),
  ('admin','time.manage_own','api'), ('admin','time.read_all','api'),
  ('admin','time.manage_all','api'), ('admin','time.approve','api'),
  ('admin','contacts.read','api'), ('admin','contacts.read_all','api'),
  ('admin','contacts.manage','api'), ('admin','leads.read','api'),
  ('admin','leads.read_all','api'), ('admin','leads.manage','api'),
  ('admin','files.read','api'), ('admin','files.upload','api'),
  ('admin','files.manage','api'), ('admin','portal.read','api'),
  ('admin','portal.manage','api'), ('admin','communications.read','api'),
  ('admin','communications.manage','api'), ('admin','project_context.read','api'),
  ('admin','project_context.manage','api'), ('admin','goals.read','api'),
  ('admin','goals.manage','api'), ('admin','suggestions.manage','api'),
  ('admin','notifications.manage_own','api'), ('admin','reminders.manage_own','api'),

  -- Member defaults.
  ('member','team.read','app'), ('member','projects.read','app'),
  ('member','tasks.read','app'), ('member','tasks.create','app'),
  ('member','tasks.manage_assigned','app'), ('member','time.manage_own','app'),
  ('member','contacts.read','app'), ('member','files.read','app'),
  ('member','files.upload','app'), ('member','credentials.reveal_shared','app'),
  ('member','earnings.own.read','app'),
  ('member','projects.read','api'), ('member','tasks.read','api'),
  ('member','tasks.create','api'), ('member','tasks.manage_assigned','api'),
  ('member','time.manage_own','api'), ('member','files.read','api'),
  ('member','files.upload','api'), ('member','notifications.manage_own','api'),
  ('member','reminders.manage_own','api'),

  -- Guest defaults.
  ('guest','team.read','app'), ('guest','projects.read','app'),
  ('guest','tasks.read','app'), ('guest','files.read','app'),
  ('guest','projects.read','api'), ('guest','tasks.read','api'),
  ('guest','files.read','api'), ('guest','notifications.manage_own','api'),

  -- Agents can use assigned project work in the app and API without client,
  -- credential, billing, finance, or team-management access.
  ('agent','team.read','app'), ('agent','projects.read','app'),
  ('agent','tasks.read','app'), ('agent','tasks.create','app'),
  ('agent','tasks.manage_assigned','app'), ('agent','files.read','app'),
  ('agent','files.upload','app'), ('agent','project_context.read','app'),
  ('agent','project_context.manage','app'), ('agent','goals.read','app'),
  ('agent','goals.manage','app'), ('agent','suggestions.manage','app'),
  ('agent','projects.read','api'), ('agent','tasks.read','api'),
  ('agent','tasks.create','api'), ('agent','tasks.manage_assigned','api'),
  ('agent','project_context.read','api'), ('agent','project_context.manage','api'),
  ('agent','goals.read','api'), ('agent','goals.manage','api'),
  ('agent','suggestions.manage','api'), ('agent','files.read','api'),
  ('agent','notifications.manage_own','api'),
  ('agent','time.manage_own','api'), ('agent','notifications.send','api'),
  ('agent','reminders.manage_own','api')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- API key evolution
-- ---------------------------------------------------------------------------

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_permissions_check;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_permissions_check CHECK (permissions IN ('full', 'read_only', 'scoped'));

CREATE INDEX IF NOT EXISTS idx_api_keys_team_member_id ON public.api_keys(team_member_id);

-- Existing keys are unused and cannot be safely translated from full/read-only.
UPDATE public.api_keys
SET revoked_at = COALESCE(revoked_at, now());

ALTER TABLE public.business_settings
  ADD COLUMN IF NOT EXISTS api_enabled boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- Project time configuration and approval lifecycle
-- ---------------------------------------------------------------------------

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS time_tracking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_time_billing text NOT NULL DEFAULT 'included';

ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_client_time_billing_check;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_client_time_billing_check
  CHECK (client_time_billing IN ('hourly', 'included'));

UPDATE public.projects
SET time_tracking_enabled = hourly_tracking,
    client_time_billing = CASE WHEN hourly_tracking THEN 'hourly' ELSE 'included' END;

ALTER TABLE public.project_time_entries
  ADD COLUMN IF NOT EXISTS work_type text NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS compensation_rate numeric(10,2) NOT NULL DEFAULT 0;

ALTER TABLE public.project_time_entries
  DROP CONSTRAINT IF EXISTS project_time_entries_work_type_check,
  DROP CONSTRAINT IF EXISTS project_time_entries_approval_status_check,
  DROP CONSTRAINT IF EXISTS project_time_entries_compensation_rate_check;

ALTER TABLE public.project_time_entries
  ADD CONSTRAINT project_time_entries_work_type_check CHECK (work_type IN ('client', 'internal')),
  ADD CONSTRAINT project_time_entries_approval_status_check
    CHECK (approval_status IN ('draft', 'pending', 'approved', 'rejected')),
  ADD CONSTRAINT project_time_entries_compensation_rate_check CHECK (compensation_rate >= 0);

DO $$
DECLARE
  owner_id uuid;
BEGIN
  SELECT id INTO owner_id FROM public.team_members WHERE role = 'owner' ORDER BY created_at LIMIT 1;

  IF EXISTS (
    SELECT 1 FROM public.project_time_entries WHERE member_id IS DISTINCT FROM owner_id
  ) THEN
    RAISE EXCEPTION 'Historical time contains a non-Owner member; manual compensation backfill required';
  END IF;

  UPDATE public.project_time_entries
  SET approval_status = CASE WHEN end_time IS NULL THEN 'draft' ELSE 'approved' END,
      submitted_at = CASE WHEN end_time IS NULL THEN NULL ELSE COALESCE(updated_at, created_at) END,
      approved_at = CASE WHEN end_time IS NULL THEN NULL ELSE COALESCE(updated_at, created_at) END,
      approved_by = CASE WHEN end_time IS NULL THEN NULL ELSE owner_id END,
      compensation_rate = 0;
END;
$$;

CREATE TABLE public.team_member_hourly_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  hourly_rate numeric(10,2) NOT NULL CHECK (hourly_rate >= 0),
  effective_at timestamptz NOT NULL,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, effective_at)
);

CREATE TABLE public.team_member_earning_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('bonus', 'deduction')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  effective_date date NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  voided_at timestamptz,
  voided_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Project retainers and revenue splits (20260919050750_create_project_retainers.sql)
-- A retainer produces one recurring invoice line per calendar month. A line can
-- carry a split that a member earns once the invoice is paid. Splits never live
-- in project_invoices.line_items: that JSON reaches the portal, webhooks and API.
-- ---------------------------------------------------------------------------

CREATE TABLE public.project_retainers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- advance: the bill date is the period start and the line covers the coming
  -- month. arrears: the bill date is the day after the period ends.
  billing_timing text NOT NULL DEFAULT 'advance' CHECK (billing_timing IN ('advance', 'arrears')),
  start_date date NOT NULL,
  -- Ending a retainer is setting end_date; the final month prorates to it.
  end_date date CHECK (end_date IS NULL OR end_date >= start_date),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  -- The draft appears this many days before the bill date.
  lead_days integer NOT NULL DEFAULT 1 CHECK (lead_days BETWEEN 0 AND 28),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- Dated amount history, same shape as team_member_hourly_rates. A period bills
-- at the amount effective on its start date.
CREATE TABLE public.project_retainer_amounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retainer_id uuid NOT NULL REFERENCES public.project_retainers(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  effective_date date NOT NULL,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- Among live rows: a row in Trash does not block a new one.
CREATE UNIQUE INDEX project_retainer_amounts_live_effective_key
  ON public.project_retainer_amounts (retainer_id, effective_date) WHERE deleted_at IS NULL;

-- Who shares in a retainer, and from when. A line takes the split effective on
-- its period start.
CREATE TABLE public.project_retainer_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retainer_id uuid NOT NULL REFERENCES public.project_retainers(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  percent numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  effective_from date NOT NULL,
  effective_to date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per period that has been dealt with: on an invoice, or skipped. The
-- unique key is the no-double-billing guard. A period with no row is still due.
CREATE TABLE public.project_retainer_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retainer_id uuid NOT NULL REFERENCES public.project_retainers(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('invoiced', 'skipped')),
  invoice_id uuid REFERENCES public.project_invoices(id) ON DELETE SET NULL,
  line_item_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (retainer_id, period_start),
  CHECK (period_end >= period_start)
);

-- The split frozen onto an invoice line. line_item_id is the stable id stored
-- in project_invoices.line_items, as in invoice_time_entry_allocations.
CREATE TABLE public.invoice_line_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.project_invoices(id) ON DELETE CASCADE,
  line_item_id text NOT NULL,
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  percent numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, line_item_id, member_id)
);

-- What a member earned from a paid line. Snapshots survive the invoice.
-- voided_at: retired before any payout touched it. reversed_at: retired after
-- a payout; the row stays so that payout still validates, and a deduction
-- adjustment carries the clawback.
CREATE TABLE public.team_member_share_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  retainer_id uuid REFERENCES public.project_retainers(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES public.project_invoices(id) ON DELETE SET NULL,
  line_item_id text NOT NULL,
  invoice_number text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  percent numeric(5,2) NOT NULL,
  basis_amount numeric(12,2) NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  earned_date date NOT NULL,
  voided_at timestamptz,
  reversed_at timestamptz,
  reversal_adjustment_id uuid REFERENCES public.team_member_earning_adjustments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.team_member_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  payment_date date NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  payment_method text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  voided_at timestamptz,
  voided_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.team_member_payout_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES public.team_member_payouts(id) ON DELETE CASCADE,
  time_entry_id uuid REFERENCES public.project_time_entries(id) ON DELETE RESTRICT,
  adjustment_id uuid REFERENCES public.team_member_earning_adjustments(id) ON DELETE RESTRICT,
  share_earning_id uuid REFERENCES public.team_member_share_earnings(id) ON DELETE RESTRICT,
  allocated_amount numeric(12,2) NOT NULL CHECK (allocated_amount <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_member_payout_allocations_one_source
    CHECK (num_nonnulls(time_entry_id, adjustment_id, share_earning_id) = 1),
  CONSTRAINT team_member_payout_allocations_source_key
    UNIQUE NULLS NOT DISTINCT (payout_id, time_entry_id, adjustment_id, share_earning_id)
);

CREATE INDEX idx_team_member_hourly_rates_lookup
  ON public.team_member_hourly_rates(member_id, effective_at DESC);
CREATE INDEX idx_team_member_earning_adjustments_member
  ON public.team_member_earning_adjustments(member_id, effective_date DESC);
CREATE INDEX idx_team_member_payouts_member
  ON public.team_member_payouts(member_id, payment_date DESC);
CREATE INDEX idx_team_member_payout_allocations_payout
  ON public.team_member_payout_allocations(payout_id);
CREATE INDEX idx_team_member_payout_allocations_time_entry
  ON public.team_member_payout_allocations(time_entry_id) WHERE time_entry_id IS NOT NULL;
CREATE INDEX idx_team_member_payout_allocations_adjustment
  ON public.team_member_payout_allocations(adjustment_id) WHERE adjustment_id IS NOT NULL;

CREATE TRIGGER set_team_member_hourly_rates_updated_at
  BEFORE UPDATE ON public.team_member_hourly_rates
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_team_member_earning_adjustments_updated_at
  BEFORE UPDATE ON public.team_member_earning_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_team_member_payouts_updated_at
  BEFORE UPDATE ON public.team_member_payouts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE INDEX idx_project_retainers_project
  ON public.project_retainers(project_id);
CREATE INDEX idx_project_retainer_shares_retainer
  ON public.project_retainer_shares(retainer_id, effective_from);
CREATE INDEX idx_project_retainer_periods_invoice
  ON public.project_retainer_periods(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_invoice_line_shares_member
  ON public.invoice_line_shares(member_id);
CREATE INDEX idx_team_member_share_earnings_member
  ON public.team_member_share_earnings(member_id, earned_date DESC);
CREATE INDEX idx_team_member_share_earnings_invoice
  ON public.team_member_share_earnings(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX idx_team_member_share_earnings_active
  ON public.team_member_share_earnings(invoice_id, line_item_id, member_id)
  WHERE voided_at IS NULL AND reversed_at IS NULL;
CREATE INDEX idx_team_member_payout_allocations_share_earning
  ON public.team_member_payout_allocations(share_earning_id) WHERE share_earning_id IS NOT NULL;

CREATE TRIGGER set_project_retainers_updated_at
  BEFORE UPDATE ON public.project_retainers
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_project_retainer_shares_updated_at
  BEFORE UPDATE ON public.project_retainer_shares
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_project_retainer_periods_updated_at
  BEFORE UPDATE ON public.project_retainer_periods
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_team_member_share_earnings_updated_at
  BEFORE UPDATE ON public.team_member_share_earnings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Owner rate is explicit and remains zero unless ownership changes.
INSERT INTO public.team_member_hourly_rates (member_id, hourly_rate, effective_at, created_by)
SELECT id, 0, created_at, id FROM public.team_members WHERE role = 'owner'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Per-credential sharing
-- ---------------------------------------------------------------------------

CREATE TABLE public.project_credential_members (
  credential_id uuid NOT NULL REFERENCES public.project_credentials(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, member_id)
);

CREATE INDEX idx_project_credential_members_member
  ON public.project_credential_members(member_id);

-- ---------------------------------------------------------------------------
-- Access helpers. Each helper has a fixed search path and bypasses recursive RLS.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_team_member_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.team_members
  WHERE auth_user_id = auth.uid()
    AND status = 'active'
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_team_member_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.team_members
  WHERE auth_user_id = auth.uid() AND status = 'active'
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.has_permission(p_permission_key text, p_access_channel text DEFAULT 'app')
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH actor AS (
    SELECT id, role
    FROM public.team_members
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1
  )
  SELECT COALESCE(
    (SELECT role = 'owner' FROM actor), false
  ) OR COALESCE(
    (SELECT effect = 'allow'
     FROM public.team_member_permissions override_permission, actor
     WHERE override_permission.member_id = actor.id
       AND override_permission.permission_key = p_permission_key
       AND override_permission.access_channel = p_access_channel),
    EXISTS (
      SELECT 1
      FROM public.role_permissions role_permission, actor
      WHERE role_permission.role = actor.role
        AND role_permission.permission_key = p_permission_key
        AND role_permission.access_channel = p_access_channel
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_project(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id AND deleted_at IS NULL)
    AND (
      public.has_permission('projects.read_all', 'app')
      OR (
        public.has_permission('projects.read', 'app')
        AND EXISTS (
          SELECT 1 FROM public.project_members
          WHERE project_id = p_project_id
            AND member_id = public.current_team_member_id()
        )
      )
    )
$$;

CREATE OR REPLACE FUNCTION public.can_access_lead(p_lead_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_permission('leads.read_all', 'app')
    OR (
      public.has_permission('leads.read', 'app')
      AND EXISTS (
        SELECT 1 FROM public.lead_members
        WHERE lead_id = p_lead_id
          AND member_id = public.current_team_member_id()
      )
    )
$$;

-- The one task visibility rule, for the tasks table and (through
-- can_access_task) every child table. tasks.read sees every task in the
-- projects the member can open; tasks.read_assigned only the ones assigned
-- to them or created by them.
CREATE OR REPLACE FUNCTION public.can_read_task_row(p_task_id uuid, p_project_id uuid, p_created_by uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.can_access_project(p_project_id) AND (
    public.has_permission('tasks.read')
    OR (
      public.has_permission('tasks.read_assigned')
      AND (
        p_created_by = public.current_team_member_id()
        OR EXISTS (
          SELECT 1 FROM public.task_assignees ta
          WHERE ta.task_id = p_task_id AND ta.member_id = public.current_team_member_id()
        )
        OR EXISTS (
          SELECT 1 FROM public.tasks child
          JOIN public.tasks parent ON parent.id = child.parent_task_id
          WHERE child.id = p_task_id AND (
            parent.created_by = public.current_team_member_id()
            OR EXISTS (
              SELECT 1 FROM public.task_assignees ta
              WHERE ta.task_id = parent.id AND ta.member_id = public.current_team_member_id()
            )
          )
        )
        OR EXISTS (
          SELECT 1 FROM public.tasks child
          WHERE child.parent_task_id = p_task_id AND child.deleted_at IS NULL AND (
            child.created_by = public.current_team_member_id()
            OR EXISTS (
              SELECT 1 FROM public.task_assignees ta
              WHERE ta.task_id = child.id AND ta.member_id = public.current_team_member_id()
            )
          )
        )
      )
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tasks
    WHERE id = p_task_id AND deleted_at IS NULL AND public.can_read_task_row(id, project_id, created_by)
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_credential(p_credential_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_credentials credential
    JOIN public.projects project ON project.id = credential.project_id
    WHERE credential.id = p_credential_id
      AND credential.deleted_at IS NULL
      AND project.deleted_at IS NULL
  )
  AND (
    public.has_permission('credentials.manage', 'app')
    OR (
      public.has_permission('credentials.reveal_shared', 'app')
      AND EXISTS (
        SELECT 1
        FROM public.project_credential_members grant_row
        JOIN public.project_credentials credential ON credential.id = grant_row.credential_id
        WHERE grant_row.credential_id = p_credential_id
          AND grant_row.member_id = public.current_team_member_id()
          AND public.can_access_project(credential.project_id)
      )
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.get_my_access_context()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH actor AS (
    SELECT id, role, status
    FROM public.team_members
    WHERE auth_user_id = auth.uid()
    LIMIT 1
  ), keys AS (
    SELECT permission_key, access_channel
    FROM public.role_permissions, actor
    WHERE role_permissions.role = actor.role
      AND actor.status = 'active'
    UNION
    SELECT permission_key, access_channel
    FROM public.team_member_permissions, actor
    WHERE team_member_permissions.member_id = actor.id
      AND team_member_permissions.effect = 'allow'
      AND actor.status = 'active'
    EXCEPT
    SELECT permission_key, access_channel
    FROM public.team_member_permissions, actor
    WHERE team_member_permissions.member_id = actor.id
      AND team_member_permissions.effect = 'deny'
      AND actor.status = 'active'
  )
  SELECT jsonb_build_object(
    'member_id', actor.id,
    'role', actor.role,
    'status', actor.status,
    'app_permissions', CASE WHEN actor.role = 'owner' THEN jsonb_build_array('*') ELSE
      COALESCE((SELECT jsonb_agg(permission_key ORDER BY permission_key) FROM keys WHERE access_channel = 'app'), '[]'::jsonb) END,
    'api_permissions', CASE WHEN actor.role = 'owner' THEN jsonb_build_array('*') ELSE
      COALESCE((SELECT jsonb_agg(permission_key ORDER BY permission_key) FROM keys WHERE access_channel = 'api'), '[]'::jsonb) END,
    'project_ids', COALESCE((SELECT jsonb_agg(project_id) FROM public.project_members WHERE member_id = actor.id), '[]'::jsonb)
  )
  FROM actor
$$;

CREATE OR REPLACE FUNCTION public.get_team_directory()
RETURNS TABLE (id uuid, name text, avatar text, role text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT member.id, member.name, member.avatar, member.role, member.status
  FROM public.team_members member
  WHERE public.has_permission('team.read', 'app')
     OR member.id = public.current_team_member_id()
  ORDER BY member.name
$$;

CREATE OR REPLACE FUNCTION public.get_accessible_time_entries(p_project_id uuid DEFAULT NULL)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Mask sensitive rate columns independently, mirroring the app-layer rule in
  -- sanitizeTimeEntryForAccess: the client billing rate (hourly_rate) requires
  -- billing.manage; the employee pay rate (compensation_rate) requires
  -- compensation.manage/payouts.manage, or the caller's own entry with
  -- earnings.own.read. Removing the empty key '' is a no-op when access is allowed.
  SELECT (
    (to_jsonb(entry)
      - (CASE WHEN public.has_permission('billing.manage', 'app') THEN '' ELSE 'hourly_rate' END))
      - (CASE
           WHEN public.has_permission('compensation.manage', 'app')
             OR public.has_permission('payouts.manage', 'app')
             OR (entry.member_id = public.current_team_member_id() AND public.has_permission('earnings.own.read', 'app'))
           THEN '' ELSE 'compensation_rate'
         END)
  )
  FROM public.project_time_entries entry
  WHERE (p_project_id IS NULL OR entry.project_id = p_project_id)
    AND entry.deleted_at IS NULL
    AND public.can_access_project(entry.project_id)
    AND (
      public.has_permission('time.read_all', 'app')
      OR entry.member_id = public.current_team_member_id()
    )
  ORDER BY entry.start_time DESC
$$;

CREATE OR REPLACE FUNCTION public.get_accessible_credential_metadata(p_project_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, project_id uuid, label text, category text,
  submitted_by_client boolean, submitted_by_name text,
  created_by uuid, created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT credential.id, credential.project_id, credential.label, credential.category,
         credential.submitted_by_client, credential.submitted_by_name,
         credential.created_by, credential.created_at, credential.updated_at
  FROM public.project_credentials credential
  WHERE (p_project_id IS NULL OR credential.project_id = p_project_id)
    AND public.can_access_credential(credential.id)
  ORDER BY credential.created_at DESC
$$;

CREATE OR REPLACE FUNCTION public.resolve_team_member_hourly_rate(
  p_member_id uuid,
  p_effective_at timestamptz
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN member.role IN ('owner', 'agent') THEN 0 ELSE COALESCE((
    SELECT rate.hourly_rate
    FROM public.team_member_hourly_rates rate
    WHERE rate.member_id = p_member_id AND rate.effective_at <= p_effective_at
    ORDER BY rate.effective_at DESC
    LIMIT 1
  ), 0) END
  FROM public.team_members member
  WHERE member.id = p_member_id
$$;

CREATE OR REPLACE FUNCTION public.protect_project_billing_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' OR public.has_permission('billing.manage', 'app') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.hourly_rate IS NOT NULL OR NEW.budget_type IS NOT NULL OR NEW.budget_value IS NOT NULL
      OR NEW.billing_address IS NOT NULL OR NEW.billing_email IS NOT NULL OR NEW.tax_rate IS NOT NULL
      OR NEW.client_time_billing IS DISTINCT FROM 'included' THEN
      RAISE EXCEPTION 'Billing permission required';
    END IF;
  ELSIF NEW.hourly_rate IS DISTINCT FROM OLD.hourly_rate
    OR NEW.budget_type IS DISTINCT FROM OLD.budget_type
    OR NEW.budget_value IS DISTINCT FROM OLD.budget_value
    OR NEW.billing_address IS DISTINCT FROM OLD.billing_address
    OR NEW.billing_email IS DISTINCT FROM OLD.billing_email
    OR NEW.tax_rate IS DISTINCT FROM OLD.tax_rate
    OR NEW.invoice_pdf_options IS DISTINCT FROM OLD.invoice_pdf_options
    OR NEW.client_time_billing IS DISTINCT FROM OLD.client_time_billing THEN
    RAISE EXCEPTION 'Billing permission required';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_project_billing_fields
  BEFORE INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.protect_project_billing_fields();

CREATE OR REPLACE FUNCTION public.apply_time_entry_compensation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member_role text;
BEGIN
  SELECT role INTO member_role FROM public.team_members WHERE id = NEW.member_id;

  IF TG_OP = 'INSERT' OR NEW.start_time IS DISTINCT FROM OLD.start_time OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    IF TG_OP = 'UPDATE' AND OLD.approval_status = 'approved' THEN
      RAISE EXCEPTION 'Approved time entry compensation is locked';
    END IF;
    NEW.compensation_rate := public.resolve_team_member_hourly_rate(NEW.member_id, NEW.start_time);
  END IF;

  IF NEW.end_time IS NULL THEN
    NEW.approval_status := 'draft';
    NEW.submitted_at := NULL;
    NEW.approved_at := NULL;
    NEW.approved_by := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.end_time IS NULL THEN
    NEW.submitted_at := now();
    IF member_role = 'owner' THEN
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := NEW.member_id;
      NEW.compensation_rate := 0;
    ELSIF member_role <> 'agent'
      AND COALESCE((SELECT auto_approve_human_hours FROM public.business_settings LIMIT 1), true) THEN
      -- Auto-approved by workspace policy; approved_by NULL marks it as
      -- system-approved rather than reviewed by a person.
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := NULL;
    ELSE
      NEW.approval_status := 'pending';
      NEW.approved_at := NULL;
      NEW.approved_by := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.approval_status = 'rejected' AND member_role <> 'owner'
    AND NEW.approval_status = OLD.approval_status THEN
    -- A content edit to a rejected entry resubmits it for review. A review
    -- decision (approval_status changed by review_time_entries) passes
    -- through untouched.
    NEW.approval_status := 'pending';
    NEW.submitted_at := now();
    NEW.approved_at := NULL;
    NEW.approved_by := NULL;
    NEW.rejection_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER apply_time_entry_compensation
  BEFORE INSERT OR UPDATE ON public.project_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.apply_time_entry_compensation();

-- Agent billing conversion: runs at APPROVAL (not timer stop) so the reviewer
-- sees the raw session and edits operate on truth. Collapses the entry into
-- one continuous slot of worked time (pauses excluded, or the reviewer's
-- adjusted minutes) times the snapshotted multiplier, anchored at the real
-- start. Single-shot via billing_converted_at. Called only from the review
-- functions; no direct grants.
CREATE OR REPLACE FUNCTION public.apply_agent_billing_conversion(
  p_entry_id uuid,
  p_adjusted_minutes numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry public.project_time_entries%ROWTYPE;
  v_role text;
  v_raw_worked_ms numeric;
  v_billing_worked_ms numeric;
  v_multiplier numeric;
  v_billed_end timestamptz;
BEGIN
  SELECT * INTO v_entry FROM public.project_time_entries WHERE id = p_entry_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT role INTO v_role FROM public.team_members WHERE id = v_entry.member_id;
  IF v_role IS DISTINCT FROM 'agent' THEN RETURN; END IF;
  IF v_entry.billing_converted_at IS NOT NULL THEN RETURN; END IF;
  IF v_entry.end_time IS NULL OR v_entry.approval_status <> 'approved' THEN RETURN; END IF;

  SELECT COALESCE(SUM(
    GREATEST(0, EXTRACT(EPOCH FROM (
      (segment->>'end')::timestamptz - (segment->>'start')::timestamptz
    )) * 1000)
  ), 0)
  INTO v_raw_worked_ms
  FROM jsonb_array_elements(COALESCE(v_entry.segments, '[]'::jsonb)) AS segment
  WHERE segment->>'end' IS NOT NULL AND segment->>'start' IS NOT NULL;

  IF p_adjusted_minutes IS NOT NULL AND p_adjusted_minutes > 0 THEN
    v_billing_worked_ms := p_adjusted_minutes * 60000;
  ELSE
    v_billing_worked_ms := v_raw_worked_ms;
  END IF;
  IF v_billing_worked_ms <= 0 THEN RETURN; END IF;

  v_multiplier := COALESCE(NULLIF(v_entry.billing_multiplier, 0), 1);
  IF v_multiplier <= 0 THEN v_multiplier := 1; END IF;
  v_billed_end := v_entry.start_time + make_interval(secs => (v_billing_worked_ms * v_multiplier) / 1000.0);

  UPDATE public.project_time_entries
  SET raw_time_snapshot = COALESCE(v_entry.raw_time_snapshot, jsonb_build_object(
        'version', 1,
        'start_time', v_entry.start_time,
        'end_time', v_entry.end_time,
        'segments', COALESCE(v_entry.segments, '[]'::jsonb),
        'worked_ms', v_raw_worked_ms,
        'captured_at', now()
      )),
      segments = jsonb_build_array(jsonb_build_object(
        'start', to_char(v_entry.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'end', to_char(v_billed_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )),
      end_time = v_billed_end,
      billing_converted_at = now(),
      updated_at = now()
  WHERE id = p_entry_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_agent_billing_conversion(uuid, numeric) FROM PUBLIC;

-- The 3-argument overload must not coexist with the 4-argument version or
-- PostgREST calls become ambiguous.
DROP FUNCTION IF EXISTS public.review_time_entries(uuid[], text, text);

CREATE OR REPLACE FUNCTION public.review_time_entries(
  p_entry_ids uuid[],
  p_decision text,
  p_reason text DEFAULT NULL,
  p_adjustments jsonb DEFAULT NULL
)
RETURNS SETOF public.project_time_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.has_permission('time.approve', 'app') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid review decision';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND member_id = public.current_team_member_id()
  ) THEN
    RAISE EXCEPTION 'Time entries cannot be self-approved';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND NOT public.can_access_project(project_id)
  ) THEN
    RAISE EXCEPTION 'Project access denied';
  END IF;

  UPDATE public.project_time_entries entry
  SET approval_status = p_decision,
      approved_at = CASE WHEN p_decision = 'approved' THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_decision = 'approved' THEN public.current_team_member_id() ELSE NULL END,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN COALESCE(p_reason, '') ELSE NULL END,
      updated_at = now()
  WHERE entry.id = ANY(p_entry_ids)
    AND entry.approval_status IN ('pending', 'rejected')
    AND entry.end_time IS NOT NULL;

  IF p_decision = 'approved' THEN
    FOREACH v_id IN ARRAY p_entry_ids LOOP
      PERFORM public.apply_agent_billing_conversion(
        v_id,
        CASE WHEN p_adjustments IS NOT NULL AND p_adjustments ? v_id::text
          THEN (p_adjustments->>v_id::text)::numeric
          ELSE NULL END
      );
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT * FROM public.project_time_entries WHERE id = ANY(p_entry_ids);
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_team_member_payout(p_payout_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payout_row public.team_member_payouts;
  allocation_total numeric;
  allocation_row record;
  source_amount numeric;
  source_allocated numeric;
BEGIN
  SELECT * INTO payout_row FROM public.team_member_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout not found'; END IF;

  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO allocation_total
  FROM public.team_member_payout_allocations
  WHERE payout_id = p_payout_id;

  IF ROUND(allocation_total, 2) IS DISTINCT FROM ROUND(payout_row.amount, 2) THEN
    RAISE EXCEPTION 'Payout allocations do not match payout amount';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.team_member_payout_allocations allocation
    LEFT JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    LEFT JOIN public.team_member_earning_adjustments adjustment ON adjustment.id = allocation.adjustment_id
    LEFT JOIN public.team_member_share_earnings share_earning ON share_earning.id = allocation.share_earning_id
    WHERE allocation.payout_id = p_payout_id
      AND COALESCE(entry.member_id, adjustment.member_id, share_earning.member_id) IS DISTINCT FROM payout_row.member_id
  ) THEN
    RAISE EXCEPTION 'Payout allocation belongs to another member';
  END IF;

  FOR allocation_row IN
    SELECT * FROM public.team_member_payout_allocations WHERE payout_id = p_payout_id
  LOOP
    IF allocation_row.time_entry_id IS NOT NULL THEN
      SELECT
        CASE
          WHEN entry.approval_status = 'approved' AND entry.end_time IS NOT NULL AND entry.deleted_at IS NULL THEN
            ROUND(
              COALESCE((
                SELECT SUM(
                  EXTRACT(EPOCH FROM (
                    (segment.value->>'end')::timestamptz
                    - (segment.value->>'start')::timestamptz
                  )) / 3600
                )
                FROM jsonb_array_elements(COALESCE(entry.segments, '[]'::jsonb)) segment
                WHERE NULLIF(segment.value->>'end', '') IS NOT NULL
              ), 0) * entry.compensation_rate,
              2
            )
          ELSE NULL
        END
      INTO source_amount
      FROM public.project_time_entries entry
      WHERE entry.id = allocation_row.time_entry_id;

      IF source_amount IS NULL THEN
        RAISE EXCEPTION 'Payouts can only allocate approved completed time';
      END IF;
    ELSIF allocation_row.share_earning_id IS NOT NULL THEN
      -- A reversed earning stays valid: its clawback is a separate deduction.
      SELECT CASE WHEN share_earning.voided_at IS NULL THEN share_earning.amount ELSE NULL END
      INTO source_amount
      FROM public.team_member_share_earnings share_earning
      WHERE share_earning.id = allocation_row.share_earning_id;

      IF source_amount IS NULL THEN
        RAISE EXCEPTION 'Payouts cannot allocate a missing or voided share earning';
      END IF;
    ELSE
      SELECT
        CASE
          WHEN adjustment.voided_at IS NULL THEN
            CASE WHEN adjustment.adjustment_type = 'deduction' THEN -adjustment.amount ELSE adjustment.amount END
          ELSE NULL
        END
      INTO source_amount
      FROM public.team_member_earning_adjustments adjustment
      WHERE adjustment.id = allocation_row.adjustment_id;

      IF source_amount IS NULL THEN
        RAISE EXCEPTION 'Payouts cannot allocate a missing or voided adjustment';
      END IF;
    END IF;

    IF source_amount = 0
      OR sign(allocation_row.allocated_amount) IS DISTINCT FROM sign(source_amount) THEN
      RAISE EXCEPTION 'Payout allocation has an invalid direction';
    END IF;

    SELECT COALESCE(SUM(existing.allocated_amount), 0)
    INTO source_allocated
    FROM public.team_member_payout_allocations existing
    JOIN public.team_member_payouts existing_payout ON existing_payout.id = existing.payout_id
    WHERE existing_payout.voided_at IS NULL
      AND (
        (allocation_row.time_entry_id IS NOT NULL AND existing.time_entry_id = allocation_row.time_entry_id)
        OR (allocation_row.adjustment_id IS NOT NULL AND existing.adjustment_id = allocation_row.adjustment_id)
        OR (allocation_row.share_earning_id IS NOT NULL AND existing.share_earning_id = allocation_row.share_earning_id)
      );

    IF (source_amount > 0 AND source_allocated > source_amount + 0.005)
      OR (source_amount < 0 AND source_allocated < source_amount - 0.005) THEN
      RAISE EXCEPTION 'Payout allocation exceeds the remaining source balance';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_team_member_payout(
  p_member_id uuid,
  p_payment_date text,
  p_amount numeric,
  p_payment_method text,
  p_reference text,
  p_notes text,
  p_allocations jsonb
)
RETURNS public.team_member_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payout_row public.team_member_payouts;
  allocation jsonb;
BEGIN
  IF NOT public.has_permission('payouts.manage', 'app') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF p_amount <= 0 OR jsonb_typeof(p_allocations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A positive payout and allocations are required';
  END IF;

  INSERT INTO public.team_member_payouts (
    member_id, payment_date, amount, payment_method, reference, notes, created_by
  ) VALUES (
    p_member_id, p_payment_date::date, p_amount, COALESCE(p_payment_method, ''),
    COALESCE(p_reference, ''), COALESCE(p_notes, ''), public.current_team_member_id()
  ) RETURNING * INTO payout_row;

  FOR allocation IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    INSERT INTO public.team_member_payout_allocations (
      payout_id, time_entry_id, adjustment_id, share_earning_id, allocated_amount
    ) VALUES (
      payout_row.id,
      NULLIF(allocation->>'time_entry_id', '')::uuid,
      NULLIF(allocation->>'adjustment_id', '')::uuid,
      NULLIF(allocation->>'share_earning_id', '')::uuid,
      (allocation->>'allocated_amount')::numeric
    );
  END LOOP;

  PERFORM public.validate_team_member_payout(payout_row.id);
  RETURN payout_row;
END;
$$;

-- Enforce payout accounting invariants at the database layer, not only inside
-- record_team_member_payout. Deferred constraint triggers run once at commit,
-- after the payout row and all of its allocations exist, so any direct DML that
-- bypasses the RPC (a client insert by a payouts.manage holder, a SQL console)
-- is still validated: allocations must sum to the payout amount, belong to the
-- payout's member, match direction, and not over-allocate a source.
CREATE OR REPLACE FUNCTION public.enforce_team_member_payout_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_payout uuid;
BEGIN
  IF TG_TABLE_NAME = 'team_member_payouts' THEN
    target_payout := NEW.id;
  ELSE
    target_payout := NEW.payout_id;
  END IF;
  -- Nothing to validate if the payout no longer exists (e.g. a cascaded delete).
  IF target_payout IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.team_member_payouts WHERE id = target_payout) THEN
    RETURN NULL;
  END IF;
  PERFORM public.validate_team_member_payout(target_payout);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_team_member_payout_integrity ON public.team_member_payouts;
CREATE CONSTRAINT TRIGGER trg_team_member_payout_integrity
  AFTER INSERT OR UPDATE ON public.team_member_payouts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_team_member_payout_integrity();

DROP TRIGGER IF EXISTS trg_team_member_payout_allocation_integrity ON public.team_member_payout_allocations;
CREATE CONSTRAINT TRIGGER trg_team_member_payout_allocation_integrity
  AFTER INSERT OR UPDATE ON public.team_member_payout_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_team_member_payout_integrity();

-- ---------------------------------------------------------------------------
-- Period math
-- ---------------------------------------------------------------------------

-- "Today" for billing is the owner's calendar day, not UTC: the first owner
-- whose time zone Postgres recognizes, else UTC. A rejected name is caught and
-- skipped rather than looked up in pg_timezone_names, which reads the whole
-- time zone database on every call.
CREATE OR REPLACE FUNCTION public.workspace_today()
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text;
BEGIN
  FOR zone IN
    SELECT member.timezone
    FROM public.team_members member
    WHERE member.role = 'owner'
      AND member.timezone ~ '^[A-Za-z][A-Za-z0-9_-]*(/[A-Za-z0-9_+-]+)*$'
    ORDER BY member.created_at
  LOOP
    BEGIN
      RETURN (now() AT TIME ZONE zone)::date;
    EXCEPTION WHEN invalid_parameter_value THEN
      NULL;
    END;
  END LOOP;
  RETURN (now() AT TIME ZONE 'UTC')::date;
END;
$$;

-- The calendar-month periods of one retainer whose month falls in the window,
-- clipped to the retainer's own dates and priced with proration.
CREATE OR REPLACE FUNCTION public.retainer_periods(p_retainer_id uuid, p_from date, p_to date)
RETURNS TABLE (
  period_start date,
  period_end date,
  bill_date date,
  amount numeric,
  full_amount numeric,
  prorated boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH retainer AS (
    SELECT * FROM public.project_retainers WHERE id = p_retainer_id AND deleted_at IS NULL
  ),
  months AS (
    SELECT month_start::date AS month_start,
           (month_start + interval '1 month' - interval '1 day')::date AS month_end
    FROM retainer,
      generate_series(
        date_trunc('month', GREATEST(p_from, retainer.start_date)::timestamp),
        date_trunc('month', LEAST(p_to, COALESCE(retainer.end_date, p_to))::timestamp),
        interval '1 month'
      ) AS month_start
  ),
  bounds AS (
    SELECT months.month_start,
           months.month_end,
           GREATEST(months.month_start, retainer.start_date) AS period_start,
           LEAST(months.month_end, COALESCE(retainer.end_date, months.month_end)) AS period_end,
           retainer.billing_timing
    FROM months, retainer
  ),
  priced AS (
    SELECT bounds.*,
      COALESCE(
        (SELECT history.amount FROM public.project_retainer_amounts history
         WHERE history.retainer_id = p_retainer_id AND history.deleted_at IS NULL
           AND history.effective_date <= bounds.period_start
         ORDER BY history.effective_date DESC LIMIT 1),
        (SELECT history.amount FROM public.project_retainer_amounts history
         WHERE history.retainer_id = p_retainer_id AND history.deleted_at IS NULL
         ORDER BY history.effective_date ASC LIMIT 1),
        0
      ) AS full_amount
    FROM bounds
    WHERE bounds.period_end >= bounds.period_start
  )
  SELECT
    priced.period_start,
    priced.period_end,
    CASE WHEN priced.billing_timing = 'arrears' THEN priced.period_end + 1 ELSE priced.period_start END,
    ROUND(
      priced.full_amount
        * (priced.period_end - priced.period_start + 1)
        / (priced.month_end - priced.month_start + 1),
      2
    ),
    priced.full_amount,
    (priced.period_start <> priced.month_start OR priced.period_end <> priced.month_end)
  FROM priced
  ORDER BY priced.period_start
$$;

-- Periods that should be on an invoice by p_as_of and have no period row yet.
CREATE OR REPLACE FUNCTION public.retainer_due_periods_internal(p_project_id uuid, p_as_of date)
RETURNS TABLE (
  retainer_id uuid,
  project_id uuid,
  retainer_name text,
  retainer_status text,
  billing_timing text,
  period_start date,
  period_end date,
  bill_date date,
  amount numeric,
  full_amount numeric,
  prorated boolean,
  description text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    retainer.id,
    retainer.project_id,
    retainer.name,
    retainer.status,
    retainer.billing_timing,
    period.period_start,
    period.period_end,
    period.bill_date,
    period.amount,
    period.full_amount,
    period.prorated,
    retainer.name || CASE WHEN period.prorated THEN ' (Prorated)' ELSE '' END
  FROM public.project_retainers retainer
  CROSS JOIN LATERAL public.retainer_periods(
    retainer.id,
    retainer.start_date,
    (p_as_of + retainer.lead_days + 31)
  ) period
  WHERE (p_project_id IS NULL OR retainer.project_id = p_project_id)
    AND retainer.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.projects project
        WHERE project.id = retainer.project_id AND project.deleted_at IS NULL)
    AND period.bill_date - retainer.lead_days <= p_as_of
    AND NOT EXISTS (
      SELECT 1 FROM public.project_retainer_periods handled
      WHERE handled.retainer_id = retainer.id
        AND handled.period_start = period.period_start
    )
  ORDER BY retainer.created_at, period.period_start
$$;

-- What the invoice form offers as ready lines: periods that are due, plus
-- skipped ones so a line removed by mistake can be put back.
CREATE OR REPLACE FUNCTION public.retainer_due_periods(p_project_id uuid)
RETURNS TABLE (
  retainer_id uuid,
  retainer_name text,
  billing_timing text,
  period_start date,
  period_end date,
  bill_date date,
  amount numeric,
  full_amount numeric,
  prorated boolean,
  description text,
  skipped boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;

  RETURN QUERY
  SELECT due.retainer_id, due.retainer_name, due.billing_timing, due.period_start, due.period_end,
         due.bill_date, due.amount, due.full_amount, due.prorated, due.description, false
  FROM public.retainer_due_periods_internal(p_project_id, public.workspace_today()) due
  WHERE due.retainer_status = 'active'
  UNION ALL
  SELECT retainer.id, retainer.name, retainer.billing_timing, period.period_start, period.period_end,
         period.bill_date, period.amount, period.full_amount, period.prorated,
         retainer.name || CASE WHEN period.prorated THEN ' (Prorated)' ELSE '' END, true
  FROM public.project_retainer_periods handled
  JOIN public.project_retainers retainer ON retainer.id = handled.retainer_id
  CROSS JOIN LATERAL public.retainer_periods(retainer.id, handled.period_start, handled.period_start) period
  WHERE retainer.project_id = p_project_id
    AND retainer.deleted_at IS NULL
    AND handled.status = 'skipped'
    AND period.period_start = handled.period_start
  ORDER BY 4, 2;
END;
$$;

-- ---------------------------------------------------------------------------
-- Drafting
-- ---------------------------------------------------------------------------

-- Same rule the invoice form uses: per project, highest trailing number + 1.
CREATE OR REPLACE FUNCTION public.next_project_invoice_number(p_project_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'INV-' || lpad((COALESCE(MAX(substring(invoice_number FROM '(\d{1,12})$')::bigint), 0) + 1)::text, 3, '0')
  FROM public.project_invoices
  WHERE project_id = p_project_id
$$;

-- The next free invoice number for the invoice form. A number on an invoice in
-- Trash stays taken (a restore brings the invoice back with it), and the
-- person adding an invoice cannot see those, so the database suggests it.
CREATE OR REPLACE FUNCTION public.suggest_project_invoice_number(p_project_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_permission('invoices.manage') AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'You cannot add invoices to this project' USING ERRCODE = '42501';
  END IF;
  RETURN public.next_project_invoice_number(p_project_id);
END;
$$;

-- Builds one draft from the given lines. The reconcile trigger on
-- project_invoices claims the periods and copies the retainer splits.
CREATE OR REPLACE FUNCTION public.create_retainer_draft_internal(
  p_project_id uuid,
  p_lines jsonb,
  p_invoice_date date,
  p_auto boolean
)
RETURNS public.project_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.project_invoices;
  project_name text;
  terms integer;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('retainer-draft:' || p_project_id::text));
  SELECT COALESCE(payment_terms_days, 0) INTO terms FROM public.project_billing_plans WHERE project_id = p_project_id;

  INSERT INTO public.project_invoices (
    project_id, invoice_number, amount, status, invoice_type, line_items,
    date, due_date, description, auto_generated, created_by
  )
  SELECT
    p_project_id,
    public.next_project_invoice_number(p_project_id),
    (SELECT COALESCE(SUM((line->>'amount')::numeric), 0) FROM jsonb_array_elements(p_lines) line),
    'draft',
    'recurring',
    p_lines,
    to_char(p_invoice_date, 'YYYY-MM-DD'),
    to_char(p_invoice_date + COALESCE(terms, 0), 'YYYY-MM-DD'),
    '',
    p_auto,
    public.current_team_member_id()
  RETURNING * INTO saved;

  IF p_auto THEN
    SELECT name INTO project_name FROM public.projects WHERE id = p_project_id;
    PERFORM public.announce_billing_draft(
      saved.id,
      'Retainer invoice drafted',
      saved.invoice_number || ' for ' || COALESCE(project_name, 'a project') || ' is ready to review and send: $'
        || to_char(saved.amount, 'FM999,999,990.00') || '.'
    );
  END IF;

  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.retainer_line_json(
  p_retainer_id uuid,
  p_position integer,
  p_amount numeric,
  p_description text,
  p_period_start date,
  p_period_end date
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
AS $$
  SELECT jsonb_build_object(
    'id', gen_random_uuid()::text,
    'position', p_position,
    'item_type', 'recurring',
    'amount', p_amount,
    'description', p_description,
    'service_start_date', to_char(p_period_start, 'YYYY-MM-DD'),
    'service_end_date', to_char(p_period_end, 'YYYY-MM-DD'),
    'recurrence_frequency', 'monthly',
    'retainer_id', p_retainer_id::text
  )
$$;

-- The scheduled job. One draft per project holding every due retainer line.
-- A paused retainer's due periods are recorded as skipped, so resuming never
-- back-bills the pause; Generate now can still bring one back.
CREATE OR REPLACE FUNCTION public.generate_retainer_drafts(p_as_of date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  as_of date := COALESCE(p_as_of, public.workspace_today());
  target record;
  lines jsonb;
  invoice_date date;
  created integer := 0;
  draft public.project_invoices;
  recipient uuid;
  project_name text;
BEGIN
  INSERT INTO public.project_retainer_periods (retainer_id, period_start, period_end, status)
  SELECT due.retainer_id, due.period_start, due.period_end, 'skipped'
  FROM public.retainer_due_periods_internal(NULL, as_of) due
  WHERE due.retainer_status = 'paused'
  ON CONFLICT (retainer_id, period_start) DO NOTHING;

  FOR target IN
    SELECT DISTINCT due.project_id
    FROM public.retainer_due_periods_internal(NULL, as_of) due
    WHERE due.retainer_status = 'active'
  LOOP
    BEGIN
      SELECT
        jsonb_agg(
          public.retainer_line_json(
            due.retainer_id, (due.line_position - 1)::integer, due.amount, due.description,
            due.period_start, due.period_end
          ) ORDER BY due.line_position
        ),
        GREATEST(MAX(due.bill_date), as_of)
      INTO lines, invoice_date
      FROM (
        SELECT inner_due.*, row_number() OVER (ORDER BY inner_due.period_start, inner_due.retainer_name) AS line_position
        FROM public.retainer_due_periods_internal(target.project_id, as_of) inner_due
        WHERE inner_due.retainer_status = 'active'
      ) due;

      draft := public.create_retainer_draft_internal(target.project_id, lines, invoice_date, true);
      IF draft.id IS NOT NULL THEN
        created := created + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, detail)
      VALUES (target.project_id, 'retainer-failed:' || to_char(as_of, 'YYYY-MM-DD'), as_of, 'failed',
              left('Retainer draft: ' || SQLERRM, 500))
      ON CONFLICT (project_id, run_key) DO UPDATE SET detail = EXCLUDED.detail, created_at = now();
      SELECT name INTO project_name FROM public.projects WHERE id = target.project_id;
      FOR recipient IN
        SELECT id FROM public.team_members WHERE role IN ('owner', 'admin') AND status = 'active'
      LOOP
        PERFORM public.upsert_notification(
          recipient,
          'Retainer draft failed',
          'The retainer invoice for ' || COALESCE(project_name, 'a project') || ' could not be drafted: '
            || left(SQLERRM, 200) || '. Generate it from Billing, Retainers, once fixed.',
          '/projects/' || target.project_id::text || '?tab=invoices',
          'project',
          target.project_id::text
        );
      END LOOP;
    END;
  END LOOP;

  RETURN created;
END;
$$;

-- Generate now: one period, regardless of lead time or a Skipped mark.
CREATE OR REPLACE FUNCTION public.generate_retainer_period(p_retainer_id uuid, p_period_start date)
RETURNS public.project_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  retainer public.project_retainers;
  period record;
  handled public.project_retainer_periods;
BEGIN
  SELECT * INTO retainer FROM public.project_retainers
  WHERE id = p_retainer_id AND deleted_at IS NULL AND public.project_is_live(project_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(retainer.project_id)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;

  SELECT * INTO period
  FROM public.retainer_periods(p_retainer_id, p_period_start, p_period_start) candidate
  WHERE candidate.period_start = p_period_start;
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not a billing period of this retainer'; END IF;

  SELECT * INTO handled
  FROM public.project_retainer_periods
  WHERE retainer_id = p_retainer_id AND period_start = p_period_start
  FOR UPDATE;
  IF FOUND THEN
    IF handled.status = 'invoiced' AND handled.invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'That period is already on an invoice';
    END IF;
    DELETE FROM public.project_retainer_periods WHERE id = handled.id;
  END IF;

  RETURN public.create_retainer_draft_internal(
    retainer.project_id,
    jsonb_build_array(public.retainer_line_json(
      retainer.id, 0, period.amount,
      retainer.name || CASE WHEN period.prorated THEN ' (Prorated)' ELSE '' END,
      period.period_start, period.period_end
    )),
    GREATEST(period.bill_date, public.workspace_today()),
    false
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Share earnings
-- ---------------------------------------------------------------------------

-- Retire one earning. Untouched by payouts: void it. Already paid out: keep the
-- row (its payout must still validate) and write a deduction for the full
-- amount, which the payout flow clears first. Payout history is never edited.
CREATE OR REPLACE FUNCTION public.retire_share_earning(p_earning_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  earning public.team_member_share_earnings;
  paid_out numeric;
  deduction_id uuid;
BEGIN
  SELECT * INTO earning
  FROM public.team_member_share_earnings
  WHERE id = p_earning_id AND voided_at IS NULL AND reversed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(allocation.allocated_amount), 0)
  INTO paid_out
  FROM public.team_member_payout_allocations allocation
  JOIN public.team_member_payouts payout ON payout.id = allocation.payout_id
  WHERE allocation.share_earning_id = earning.id AND payout.voided_at IS NULL;

  IF paid_out = 0 THEN
    UPDATE public.team_member_share_earnings SET voided_at = now() WHERE id = earning.id;
    RETURN;
  END IF;

  INSERT INTO public.team_member_earning_adjustments (
    member_id, adjustment_type, amount, effective_date, project_id, description, created_by
  ) VALUES (
    earning.member_id,
    'deduction',
    earning.amount,
    public.workspace_today(),
    -- Null while a project delete is cascading through its invoices.
    (SELECT project.id FROM public.projects project WHERE project.id = earning.project_id),
    btrim('Reversal: ' || earning.invoice_number || ' ' || earning.description) || ' (' || p_reason || ')',
    public.current_team_member_id()
  ) RETURNING id INTO deduction_id;

  UPDATE public.team_member_share_earnings
  SET reversed_at = now(), reversal_adjustment_id = deduction_id
  WHERE id = earning.id;
END;
$$;

-- Bring an invoice's share earnings in line with its status, lines and splits.
CREATE OR REPLACE FUNCTION public.sync_invoice_share_earnings(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.project_invoices;
  earning record;
  earned_on date;
  desired jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO invoice FROM public.project_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  earned_on := COALESCE(
    CASE WHEN invoice.paid_date ~ '^\d{4}-\d{2}-\d{2}' THEN substring(invoice.paid_date FROM 1 FOR 10)::date END,
    public.workspace_today()
  );

  -- A trashed invoice earns nothing; restoring it earns again.
  IF invoice.status = 'paid' AND invoice.deleted_at IS NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'line_item_id', line.value->>'id',
      'member_id', share.member_id,
      'percent', share.percent,
      'basis_amount', ROUND((line.value->>'amount')::numeric, 2),
      'amount', ROUND((line.value->>'amount')::numeric * share.percent / 100, 2),
      'description', COALESCE(line.value->>'description', ''),
      'retainer_id', (SELECT retainer.id FROM public.project_retainers retainer
                      WHERE retainer.id::text = line.value->>'retainer_id')
    )), '[]'::jsonb)
    INTO desired
    FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
    JOIN public.invoice_line_shares share
      ON share.invoice_id = invoice.id AND share.line_item_id = line.value->>'id'
    WHERE line.value->>'item_type' IN ('fixed', 'recurring')
      AND ROUND((line.value->>'amount')::numeric * share.percent / 100, 2) > 0;
  END IF;

  FOR earning IN
    SELECT existing.*
    FROM public.team_member_share_earnings existing
    WHERE existing.invoice_id = invoice.id
      AND existing.voided_at IS NULL AND existing.reversed_at IS NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(desired) AS desired(line_item_id text, member_id uuid, percent numeric, basis_amount numeric, amount numeric, description text, retainer_id uuid)
      WHERE desired.line_item_id = earning.line_item_id
        AND desired.member_id = earning.member_id
        AND desired.amount = earning.amount
        AND desired.percent = earning.percent
    ) THEN
      UPDATE public.team_member_share_earnings
      SET earned_date = earned_on, invoice_number = invoice.invoice_number
      WHERE id = earning.id
        AND (earned_date IS DISTINCT FROM earned_on OR invoice_number IS DISTINCT FROM invoice.invoice_number);
    ELSE
      PERFORM public.retire_share_earning(
        earning.id,
        CASE WHEN invoice.deleted_at IS NOT NULL THEN 'invoice deleted'
             WHEN invoice.status = 'paid' THEN 'invoice changed' ELSE 'invoice no longer paid' END
      );
    END IF;
  END LOOP;

  INSERT INTO public.team_member_share_earnings (
    member_id, project_id, retainer_id, invoice_id, line_item_id, invoice_number,
    description, percent, basis_amount, amount, earned_date
  )
  SELECT desired.member_id, invoice.project_id, desired.retainer_id, invoice.id, desired.line_item_id,
         invoice.invoice_number, desired.description, desired.percent, desired.basis_amount,
         desired.amount, earned_on
  FROM jsonb_to_recordset(desired) AS desired(line_item_id text, member_id uuid, percent numeric, basis_amount numeric, amount numeric, description text, retainer_id uuid)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.team_member_share_earnings existing
    WHERE existing.invoice_id = invoice.id
      AND existing.line_item_id = desired.line_item_id
      AND existing.member_id = desired.member_id
      AND existing.voided_at IS NULL AND existing.reversed_at IS NULL
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Invoice triggers: periods follow lines, earnings follow paid
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reconcile_invoice_retainer_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lines jsonb := COALESCE(NULLIF(NEW.line_items, 'null'::jsonb), '[]'::jsonb);
  line jsonb;
  retainer public.project_retainers;
  handled public.project_retainer_periods;
  service_start date;
  service_end date;
  period_key date;
  newly_linked boolean;
BEGIN
  -- Moved to Trash: what deleting it used to do. Its retainer periods are
  -- let go (skipped) and its split earnings retired. Restoring runs the
  -- rest of this function, which links them again, after checking its
  -- hours did not go on another invoice in the meantime.
  IF NEW.deleted_at IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL THEN
      UPDATE public.project_retainer_periods
      SET status = 'skipped', invoice_id = NULL, line_item_id = NULL
      WHERE invoice_id = NEW.id;
      PERFORM public.sync_invoice_share_earnings(NEW.id);
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL THEN
    PERFORM public.validate_invoice_time_allocations(NEW.id);
  END IF;

  -- Let go of periods whose line is gone, or whose invoice was cancelled.
  UPDATE public.project_retainer_periods period
  SET status = 'skipped', invoice_id = NULL, line_item_id = NULL
  WHERE period.invoice_id = NEW.id
    AND (
      NEW.status = 'cancelled'
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(lines) current_line
        WHERE current_line.value->>'id' = period.line_item_id
          AND current_line.value->>'retainer_id' = period.retainer_id::text
      )
    );

  DELETE FROM public.invoice_line_shares share
  WHERE share.invoice_id = NEW.id
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(lines) current_line
      WHERE current_line.value->>'id' = share.line_item_id
        AND current_line.value->>'item_type' IN ('fixed', 'recurring')
    );

  IF NEW.status <> 'cancelled' THEN
    FOR line IN SELECT value FROM jsonb_array_elements(lines)
    LOOP
      CONTINUE WHEN NULLIF(line->>'retainer_id', '') IS NULL;

      SELECT * INTO retainer FROM public.project_retainers
      WHERE id::text = line->>'retainer_id' AND deleted_at IS NULL;
      -- A retainer in Trash leaves a dangling id on old lines; that is fine.
      CONTINUE WHEN NOT FOUND;
      IF retainer.project_id <> NEW.project_id THEN
        RAISE EXCEPTION 'An invoice line points to a retainer on another project';
      END IF;
      IF COALESCE(line->>'service_start_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'A retainer line needs a service start date';
      END IF;

      service_start := (line->>'service_start_date')::date;
      service_end := CASE
        WHEN COALESCE(line->>'service_end_date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN (line->>'service_end_date')::date
        ELSE (date_trunc('month', service_start::timestamp) + interval '1 month' - interval '1 day')::date
      END;
      -- Any line in a month stands for that month's period.
      period_key := GREATEST(date_trunc('month', service_start::timestamp)::date, retainer.start_date);

      SELECT * INTO handled
      FROM public.project_retainer_periods
      WHERE retainer_id = retainer.id AND period_start = period_key
      FOR UPDATE;

      IF FOUND AND handled.status = 'invoiced' AND handled.invoice_id IS NOT NULL AND handled.invoice_id <> NEW.id THEN
        RAISE EXCEPTION 'That retainer period is already on another invoice';
      END IF;

      newly_linked := NOT FOUND
        OR handled.invoice_id IS DISTINCT FROM NEW.id
        OR handled.line_item_id IS DISTINCT FROM (line->>'id');

      INSERT INTO public.project_retainer_periods (
        retainer_id, period_start, period_end, status, invoice_id, line_item_id
      ) VALUES (
        retainer.id, period_key, GREATEST(service_end, period_key), 'invoiced', NEW.id, line->>'id'
      )
      ON CONFLICT (retainer_id, period_start) DO UPDATE
      SET status = 'invoiced', invoice_id = EXCLUDED.invoice_id,
          line_item_id = EXCLUDED.line_item_id, period_end = EXCLUDED.period_end;

      -- A line inherits the retainer's split once, when it is first linked.
      -- After that the line's own rows are the truth, so removing them sticks.
      IF newly_linked AND NOT EXISTS (
        SELECT 1 FROM public.invoice_line_shares
        WHERE invoice_id = NEW.id AND line_item_id = line->>'id'
      ) THEN
        INSERT INTO public.invoice_line_shares (invoice_id, line_item_id, member_id, percent)
        SELECT NEW.id, line->>'id', share.member_id, share.percent
        FROM public.project_retainer_shares share
        WHERE share.retainer_id = retainer.id
          AND share.effective_from <= period_key
          AND (share.effective_to IS NULL OR share.effective_to >= period_key)
        ON CONFLICT (invoice_id, line_item_id, member_id) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  PERFORM public.sync_invoice_share_earnings(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS reconcile_invoice_retainer_lines ON public.project_invoices;
CREATE TRIGGER reconcile_invoice_retainer_lines
  AFTER INSERT OR UPDATE OF line_items, status, paid_date, invoice_number, project_id, deleted_at
  ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.reconcile_invoice_retainer_lines();

CREATE OR REPLACE FUNCTION public.sync_share_earnings_from_line_shares()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_invoice_share_earnings(COALESCE(NEW.invoice_id, OLD.invoice_id));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sync_share_earnings_from_line_shares ON public.invoice_line_shares;
CREATE TRIGGER sync_share_earnings_from_line_shares
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_line_shares
  FOR EACH ROW EXECUTE FUNCTION public.sync_share_earnings_from_line_shares();

-- A split added, changed or removed on a paid invoice changes its net amounts
-- without touching project_invoices, so it has to raise its own event.
-- Statement-level with a transition table: one event per invoice, however many
-- split rows moved.
create or replace function public.emit_invoice_webhook_for_shares()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.project_invoices;
begin
  for v_invoice in
    select invoice.*
    from public.project_invoices invoice
    where invoice.status = 'paid'
      and invoice.deleted_at is null
      and invoice.id in (select distinct invoice_id from changed_rows)
  loop
    perform public.emit_invoice_webhook_event(v_invoice, 'invoice.updated');
  end loop;
  return null;
end;
$$;

create trigger emit_invoice_webhook_shares_insert
  after insert on public.invoice_line_shares
  referencing new table as changed_rows
  for each statement execute function public.emit_invoice_webhook_for_shares();

create trigger emit_invoice_webhook_shares_update
  after update on public.invoice_line_shares
  referencing new table as changed_rows
  for each statement execute function public.emit_invoice_webhook_for_shares();

create trigger emit_invoice_webhook_shares_delete
  after delete on public.invoice_line_shares
  referencing old table as changed_rows
  for each statement execute function public.emit_invoice_webhook_for_shares();
revoke all on function public.emit_invoice_webhook_for_shares() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Split rules
-- ---------------------------------------------------------------------------

-- Owners and agents are never paid out, so they cannot hold a share.
CREATE OR REPLACE FUNCTION public.assert_share_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE id = p_member_id AND role NOT IN ('owner', 'agent')
  ) THEN
    RAISE EXCEPTION 'A split needs a team member who can be paid';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_retainer_share_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_share_member(NEW.member_id);

  IF EXISTS (
    SELECT 1 FROM public.project_retainer_shares other
    WHERE other.retainer_id = NEW.retainer_id
      AND other.member_id = NEW.member_id
      AND other.id <> NEW.id
      AND other.effective_from <= COALESCE(NEW.effective_to, 'infinity'::date)
      AND COALESCE(other.effective_to, 'infinity'::date) >= NEW.effective_from
  ) THEN
    RAISE EXCEPTION 'That member already has a split on this retainer for those dates';
  END IF;

  -- The total can only peak on a day some share starts.
  IF EXISTS (
    SELECT 1
    FROM public.project_retainer_shares boundary
    WHERE boundary.retainer_id = NEW.retainer_id
      AND (
        SELECT SUM(covering.percent)
        FROM public.project_retainer_shares covering
        WHERE covering.retainer_id = NEW.retainer_id
          AND covering.effective_from <= boundary.effective_from
          AND COALESCE(covering.effective_to, 'infinity'::date) >= boundary.effective_from
      ) > 100
  ) THEN
    RAISE EXCEPTION 'Splits on a retainer cannot total more than 100 percent';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_retainer_share_rules ON public.project_retainer_shares;
CREATE CONSTRAINT TRIGGER trg_retainer_share_rules
  AFTER INSERT OR UPDATE ON public.project_retainer_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_retainer_share_rules();

-- ---------------------------------------------------------------------------
-- Write RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_project_retainer(p_retainer_id uuid, p_retainer jsonb)
RETURNS public.project_retainers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.project_retainers;
  target_project uuid;
BEGIN
  IF p_retainer_id IS NULL THEN
    target_project := (p_retainer->>'project_id')::uuid;
  ELSE
    SELECT project_id INTO target_project FROM public.project_retainers WHERE id = p_retainer_id AND deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;
  END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(target_project)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;

  IF p_retainer_id IS NULL THEN
    IF NULLIF(btrim(COALESCE(p_retainer->>'name', '')), '') IS NULL
      OR NULLIF(p_retainer->>'start_date', '') IS NULL
      OR NULLIF(p_retainer->>'amount', '') IS NULL THEN
      RAISE EXCEPTION 'A retainer needs a name, a start date and an amount';
    END IF;

    INSERT INTO public.project_retainers (
      project_id, name, billing_timing, start_date, end_date, status, lead_days, created_by
    ) VALUES (
      target_project,
      btrim(p_retainer->>'name'),
      COALESCE(NULLIF(p_retainer->>'billing_timing', ''), 'advance'),
      (p_retainer->>'start_date')::date,
      NULLIF(p_retainer->>'end_date', '')::date,
      COALESCE(NULLIF(p_retainer->>'status', ''), 'active'),
      COALESCE(NULLIF(p_retainer->>'lead_days', '')::integer, 1),
      public.current_team_member_id()
    ) RETURNING * INTO saved;

    INSERT INTO public.project_retainer_amounts (retainer_id, amount, effective_date, created_by)
    VALUES (saved.id, (p_retainer->>'amount')::numeric, saved.start_date, public.current_team_member_id());

    -- The split goes in before any line is linked, so a linked line inherits it.
    IF jsonb_typeof(p_retainer->'shares') = 'array' AND jsonb_array_length(p_retainer->'shares') > 0 THEN
      IF COALESCE(auth.role(), '') <> 'service_role'
        AND NOT public.has_permission('compensation.manage', 'app') THEN
        RAISE EXCEPTION 'Missing permission to manage compensation';
      END IF;
      INSERT INTO public.project_retainer_shares (retainer_id, member_id, percent, effective_from, created_by)
      SELECT saved.id, (share.value->>'member_id')::uuid, (share.value->>'percent')::numeric,
             saved.start_date, public.current_team_member_id()
      FROM jsonb_array_elements(p_retainer->'shares') share;
    END IF;

    -- Lines that were invoiced by hand before the retainer existed. Linking
    -- them here, in the same transaction, means the job never sees those
    -- periods as due.
    IF jsonb_typeof(p_retainer->'link_lines') = 'array' THEN
      UPDATE public.project_invoices invoice
      SET line_items = (
        SELECT jsonb_agg(
          CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_retainer->'link_lines') link
            WHERE link.value->>'invoice_id' = invoice.id::text
              AND link.value->>'line_item_id' = line.value->>'id'
          )
          THEN line.value || jsonb_build_object('retainer_id', saved.id::text)
          ELSE line.value END
          ORDER BY line.ordinality
        )
        FROM jsonb_array_elements(invoice.line_items) WITH ORDINALITY AS line(value, ordinality)
      )
      WHERE invoice.project_id = saved.project_id
        AND invoice.deleted_at IS NULL
        AND jsonb_typeof(invoice.line_items) = 'array'
        AND jsonb_array_length(invoice.line_items) > 0
        AND invoice.id::text IN (
          SELECT link.value->>'invoice_id' FROM jsonb_array_elements(p_retainer->'link_lines') link
        );
    END IF;
  ELSE
    UPDATE public.project_retainers retainer
    SET
      name = CASE WHEN p_retainer ? 'name' THEN btrim(p_retainer->>'name') ELSE retainer.name END,
      billing_timing = CASE WHEN p_retainer ? 'billing_timing' THEN p_retainer->>'billing_timing' ELSE retainer.billing_timing END,
      start_date = CASE WHEN p_retainer ? 'start_date' THEN (p_retainer->>'start_date')::date ELSE retainer.start_date END,
      end_date = CASE WHEN p_retainer ? 'end_date' THEN NULLIF(p_retainer->>'end_date', '')::date ELSE retainer.end_date END,
      status = CASE WHEN p_retainer ? 'status' THEN p_retainer->>'status' ELSE retainer.status END,
      lead_days = CASE WHEN p_retainer ? 'lead_days' THEN (p_retainer->>'lead_days')::integer ELSE retainer.lead_days END
    WHERE retainer.id = p_retainer_id
    RETURNING * INTO saved;
  END IF;

  RETURN saved;
END;
$$;

-- Same pattern as schedule_team_member_hourly_rate: a dated amount, replacing
-- any amount already set for that date.
CREATE OR REPLACE FUNCTION public.schedule_retainer_amount(
  p_retainer_id uuid,
  p_amount numeric,
  p_effective_date date
)
RETURNS public.project_retainer_amounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.project_retainer_amounts;
  target_project uuid;
BEGIN
  SELECT project_id INTO target_project FROM public.project_retainers WHERE id = p_retainer_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(target_project)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 OR p_effective_date IS NULL THEN
    RAISE EXCEPTION 'An amount and an effective date are required';
  END IF;

  INSERT INTO public.project_retainer_amounts (retainer_id, amount, effective_date, created_by)
  VALUES (p_retainer_id, p_amount, p_effective_date, public.current_team_member_id())
  ON CONFLICT (retainer_id, effective_date) WHERE deleted_at IS NULL DO UPDATE SET amount = EXCLUDED.amount
  RETURNING * INTO saved;

  RETURN saved;
END;
$$;

-- The split from p_effective_from onward. Earlier history is kept; anything
-- scheduled on or after that date is replaced. An empty array ends the split.
CREATE OR REPLACE FUNCTION public.set_retainer_shares(
  p_retainer_id uuid,
  p_shares jsonb,
  p_effective_from date
)
RETURNS SETOF public.project_retainer_shares
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_project uuid;
BEGIN
  SELECT project_id INTO target_project FROM public.project_retainers WHERE id = p_retainer_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('compensation.manage', 'app') AND public.can_access_project(target_project)) THEN
    RAISE EXCEPTION 'Missing permission to manage compensation';
  END IF;
  IF p_effective_from IS NULL OR jsonb_typeof(p_shares) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Splits and an effective date are required';
  END IF;

  DELETE FROM public.project_retainer_shares
  WHERE retainer_id = p_retainer_id AND effective_from >= p_effective_from;

  UPDATE public.project_retainer_shares
  SET effective_to = p_effective_from - 1
  WHERE retainer_id = p_retainer_id
    AND (effective_to IS NULL OR effective_to >= p_effective_from);

  INSERT INTO public.project_retainer_shares (retainer_id, member_id, percent, effective_from, created_by)
  SELECT p_retainer_id, (share.value->>'member_id')::uuid, (share.value->>'percent')::numeric,
         p_effective_from, public.current_team_member_id()
  FROM jsonb_array_elements(p_shares) share;

  RETURN QUERY
  SELECT * FROM public.project_retainer_shares
  WHERE retainer_id = p_retainer_id
  ORDER BY effective_from, created_at;
END;
$$;

-- Replace the split on an invoice's lines. Written as a diff so untouched rows
-- fire no trigger: re-saving the same split must not churn a paid-out earning.
CREATE OR REPLACE FUNCTION public.set_invoice_line_shares(p_invoice_id uuid, p_shares jsonb)
RETURNS SETOF public.invoice_line_shares
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.project_invoices;
  share record;
BEGIN
  SELECT * INTO invoice FROM public.project_invoices WHERE id = p_invoice_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('compensation.manage', 'app') AND public.can_access_project(invoice.project_id)) THEN
    RAISE EXCEPTION 'Missing permission to manage compensation';
  END IF;
  IF jsonb_typeof(p_shares) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Splits must be a list';
  END IF;

  FOR share IN
    SELECT incoming.line_item_id, incoming.member_id, incoming.percent
    FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
  LOOP
    PERFORM public.assert_share_member(share.member_id);
    IF share.percent IS NULL OR share.percent <= 0 OR share.percent > 100 THEN
      RAISE EXCEPTION 'A split percent must be between 0 and 100';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
      WHERE line.value->>'id' = share.line_item_id
        AND line.value->>'item_type' IN ('fixed', 'recurring')
    ) THEN
      RAISE EXCEPTION 'Only fixed and recurring lines can be split';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
    GROUP BY incoming.line_item_id
    HAVING SUM(incoming.percent) > 100 OR COUNT(*) <> COUNT(DISTINCT incoming.member_id)
  ) THEN
    RAISE EXCEPTION 'Splits on a line cannot total more than 100 percent or repeat a member';
  END IF;

  DELETE FROM public.invoice_line_shares existing
  WHERE existing.invoice_id = p_invoice_id
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
      WHERE incoming.line_item_id = existing.line_item_id AND incoming.member_id = existing.member_id
    );

  INSERT INTO public.invoice_line_shares (invoice_id, line_item_id, member_id, percent)
  SELECT p_invoice_id, incoming.line_item_id, incoming.member_id, incoming.percent
  FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
  ON CONFLICT (invoice_id, line_item_id, member_id) DO UPDATE
  SET percent = EXCLUDED.percent
  WHERE public.invoice_line_shares.percent IS DISTINCT FROM EXCLUDED.percent;

  RETURN QUERY
  SELECT * FROM public.invoice_line_shares WHERE invoice_id = p_invoice_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Live accrual
-- ---------------------------------------------------------------------------

-- The Finances counter vests invoice lines by the second. A month with no line
-- yet (arrears billing, or a draft that has not been created) would sit at zero
-- and then land all at once, so the counter reads the period covering today
-- from here instead. A skipped or invoiced month has a period row and is left
-- out. share_percent is compensation: zero unless the caller may see it.
CREATE OR REPLACE FUNCTION public.retainer_accruing_lines()
RETURNS TABLE (
  project_id uuid,
  retainer_id uuid,
  period_start date,
  period_end date,
  amount numeric,
  share_percent numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH clock AS (
    SELECT public.workspace_today() AS today,
           COALESCE(auth.role(), '') = 'service_role' AS is_service
  )
  SELECT
    retainer.project_id,
    retainer.id,
    period.period_start,
    period.period_end,
    period.amount,
    CASE WHEN clock.is_service OR public.has_permission('compensation.manage', 'app') THEN COALESCE((
      SELECT SUM(share.percent)
      FROM public.project_retainer_shares share
      WHERE share.retainer_id = retainer.id
        AND share.effective_from <= period.period_start
        AND (share.effective_to IS NULL OR share.effective_to >= period.period_start)
    ), 0) ELSE 0 END
  FROM clock
  CROSS JOIN public.project_retainers retainer
  CROSS JOIN LATERAL public.retainer_periods(retainer.id, clock.today, clock.today) period
  WHERE retainer.status = 'active'
    AND retainer.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.projects project
        WHERE project.id = retainer.project_id AND project.deleted_at IS NULL)
    AND clock.today BETWEEN period.period_start AND period.period_end
    AND (clock.is_service OR (public.has_permission('invoices.read', 'app') AND public.can_access_project(retainer.project_id)))
    AND NOT EXISTS (
      SELECT 1 FROM public.project_retainer_periods handled
      WHERE handled.retainer_id = retainer.id AND handled.period_start = period.period_start
    )
$$;

CREATE OR REPLACE FUNCTION public.set_credential_members(
  p_credential_id uuid,
  p_member_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  credential_project_id uuid;
BEGIN
  SELECT project_id INTO credential_project_id
  FROM public.project_credentials WHERE id = p_credential_id;
  IF credential_project_id IS NULL
    OR NOT public.has_permission('credentials.manage', 'app')
    OR NOT public.can_access_project(credential_project_id) THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_member_ids, ARRAY[]::uuid[])) requested(member_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.project_members assignment
      WHERE assignment.project_id = credential_project_id
        AND assignment.member_id = requested.member_id
    )
  ) THEN
    RAISE EXCEPTION 'Credentials can only be shared with assigned project members';
  END IF;

  DELETE FROM public.project_credential_members WHERE credential_id = p_credential_id;
  INSERT INTO public.project_credential_members (credential_id, member_id, granted_by)
  SELECT p_credential_id, requested.member_id, public.current_team_member_id()
  FROM unnest(COALESCE(p_member_ids, ARRAY[]::uuid[])) requested(member_id)
  ON CONFLICT DO NOTHING;
END;
$$;

-- ---------------------------------------------------------------------------
-- Restrictive RLS policies
-- ---------------------------------------------------------------------------

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_hourly_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_earning_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_payout_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_retainers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_retainer_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_retainer_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_retainer_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member_share_earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_credential_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
  policy_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'team_members','contacts','projects','project_members','project_contacts','tasks',
    'task_assignees','task_subtasks','task_comments','activities','leads',
    'lead_interactions','lead_proposals','lead_fields','lead_members','lead_contacts',
    'portal_settings','client_communications','entity_files','api_keys','portal_updates',
    'portal_update_attachments','portal_events','project_time_entries',
    'project_hourly_rates','invoice_time_entry_allocations','project_credentials',
    'project_invoices','team_member_notifications','project_context','project_budget_history',
    'business_settings','smtp_accounts','role_permissions','team_member_permissions',
    'team_member_hourly_rates','team_member_earning_adjustments','team_member_payouts',
    'team_member_payout_allocations','project_credential_members',
    'task_acceptance_criteria','task_dependencies','task_reviews'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      FOR policy_name IN
        SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = table_name
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, table_name);
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

CREATE POLICY team_members_self_or_manage_select ON public.team_members FOR SELECT TO authenticated
  USING (id = public.current_team_member_id() OR public.has_permission('team.manage'));
-- Team member writes go through guarded server routes. Direct authenticated
-- writes are Owner-only so a member cannot change their own role or status and
-- an Admin cannot elevate themselves or modify the Owner.
CREATE POLICY team_members_owner_write ON public.team_members FOR ALL TO authenticated
  USING (public.current_team_member_role() = 'owner')
  WITH CHECK (public.current_team_member_role() = 'owner');

CREATE POLICY role_permissions_owner ON public.role_permissions FOR ALL TO authenticated
  USING (public.current_team_member_role() = 'owner')
  WITH CHECK (public.current_team_member_role() = 'owner');
CREATE POLICY member_permissions_owner ON public.team_member_permissions FOR ALL TO authenticated
  USING (public.current_team_member_role() = 'owner')
  WITH CHECK (public.current_team_member_role() = 'owner');

CREATE POLICY contacts_select ON public.contacts FOR SELECT TO authenticated
  USING (public.has_permission('contacts.read_all') OR (
    public.has_permission('contacts.read') AND EXISTS (
      SELECT 1 FROM public.project_contacts pc
      WHERE pc.contact_id = contacts.id AND public.can_access_project(pc.project_id)
    )
  ));
CREATE POLICY contacts_manage ON public.contacts FOR ALL TO authenticated
  USING (public.has_permission('contacts.manage')) WITH CHECK (public.has_permission('contacts.manage'));

CREATE POLICY projects_management_select ON public.projects FOR SELECT TO authenticated
  USING (public.has_permission('projects.read_all') OR (
    public.has_permission('projects.read') AND public.can_access_project(id)
  ));
CREATE POLICY projects_manage ON public.projects FOR ALL TO authenticated
  USING (public.has_permission('projects.manage')) WITH CHECK (public.has_permission('projects.manage'));

CREATE POLICY project_members_select ON public.project_members FOR SELECT TO authenticated
  USING (public.can_access_project(project_id));
CREATE POLICY project_members_manage ON public.project_members FOR ALL TO authenticated
  USING (public.has_permission('project_members.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('project_members.manage') AND public.can_access_project(project_id));

CREATE POLICY project_contacts_select ON public.project_contacts FOR SELECT TO authenticated
  USING (public.can_access_project(project_id) AND public.has_permission('contacts.read'));
CREATE POLICY project_contacts_manage ON public.project_contacts FOR ALL TO authenticated
  USING (public.has_permission('contacts.manage')) WITH CHECK (public.has_permission('contacts.manage'));

CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated
  USING (public.can_read_task_row(id, project_id, created_by));
CREATE POLICY tasks_insert ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (public.has_permission('tasks.create') AND public.can_access_project(project_id)
    AND created_by = public.current_team_member_id());
-- Assigned work includes the subtasks of a task you are on.
CREATE POLICY tasks_update ON public.tasks FOR UPDATE TO authenticated
  USING (public.can_access_project(project_id) AND (public.has_permission('tasks.manage_all') OR (
    public.has_permission('tasks.manage_assigned') AND EXISTS (
      SELECT 1 FROM public.task_assignees ta
      WHERE ta.task_id IN (tasks.id, tasks.parent_task_id) AND ta.member_id = public.current_team_member_id()
    )
  )));
CREATE POLICY tasks_delete ON public.tasks FOR DELETE TO authenticated
  USING (public.has_permission('tasks.manage_all') AND public.can_access_project(project_id));

CREATE POLICY task_assignees_select ON public.task_assignees FOR SELECT TO authenticated
  USING (public.can_access_task(task_id));
CREATE POLICY task_assignees_manage ON public.task_assignees FOR ALL TO authenticated
  USING (public.has_permission('tasks.manage_all')) WITH CHECK (public.has_permission('tasks.manage_all'));
CREATE POLICY task_assignees_creator_self_insert ON public.task_assignees FOR INSERT TO authenticated
  WITH CHECK (member_id = public.current_team_member_id() AND EXISTS (
    SELECT 1 FROM public.tasks task
    WHERE task.id = task_id AND task.created_by = public.current_team_member_id()
  ));

CREATE POLICY task_subtasks_select ON public.task_subtasks FOR SELECT TO authenticated
  USING (public.can_access_task(task_id));
CREATE POLICY task_subtasks_manage ON public.task_subtasks FOR ALL TO authenticated
  USING (public.can_access_task(task_id) AND (
    public.has_permission('tasks.manage_all') OR (
      public.has_permission('tasks.manage_assigned') AND EXISTS (
        SELECT 1 FROM public.task_assignees assignment
        WHERE assignment.task_id = task_subtasks.task_id
          AND assignment.member_id = public.current_team_member_id()
      )
    )
  )) WITH CHECK (public.can_access_task(task_id) AND (
    public.has_permission('tasks.manage_all') OR EXISTS (
      SELECT 1 FROM public.task_assignees assignment
      WHERE assignment.task_id = task_subtasks.task_id
        AND assignment.member_id = public.current_team_member_id()
    )
  ));

CREATE POLICY task_acceptance_criteria_select ON public.task_acceptance_criteria FOR SELECT TO authenticated
  USING (public.can_access_task(task_id));
CREATE POLICY task_acceptance_criteria_manage ON public.task_acceptance_criteria FOR ALL TO authenticated
  USING (public.can_access_task(task_id) AND (
    public.has_permission('tasks.manage_all') OR (
      public.has_permission('tasks.manage_assigned') AND EXISTS (
        SELECT 1 FROM public.task_assignees assignment
        WHERE assignment.task_id = task_acceptance_criteria.task_id
          AND assignment.member_id = public.current_team_member_id()
      )
    )
  )) WITH CHECK (public.can_access_task(task_id) AND (
    public.has_permission('tasks.manage_all') OR EXISTS (
      SELECT 1 FROM public.task_assignees assignment
      WHERE assignment.task_id = task_acceptance_criteria.task_id
        AND assignment.member_id = public.current_team_member_id()
    )
  ));

-- Reviews: read-only for humans; the reviewer agent writes via the service
-- client, so there is intentionally no authenticated write policy.
CREATE POLICY task_reviews_select ON public.task_reviews FOR SELECT TO authenticated
  USING (public.can_access_task(task_id));
CREATE POLICY agent_health_select ON public.agent_health FOR SELECT TO authenticated
  USING (true);
-- Written by the trigger under the service client; signed-in members read.
CREATE POLICY agent_health_history_select ON public.agent_health_history FOR SELECT TO authenticated
  USING (true);

CREATE POLICY task_dependencies_select ON public.task_dependencies FOR SELECT TO authenticated
  USING (public.can_access_task(task_id));
CREATE POLICY task_dependencies_manage ON public.task_dependencies FOR ALL TO authenticated
  USING (public.can_access_task(task_id) AND (
    public.has_permission('tasks.manage_all') OR (
      public.has_permission('tasks.manage_assigned') AND EXISTS (
        SELECT 1 FROM public.task_assignees assignment
        WHERE assignment.task_id = task_dependencies.task_id
          AND assignment.member_id = public.current_team_member_id()
      )
    )
  )) WITH CHECK (public.can_access_task(task_id) AND (
    public.has_permission('tasks.manage_all') OR EXISTS (
      SELECT 1 FROM public.task_assignees assignment
      WHERE assignment.task_id = task_dependencies.task_id
        AND assignment.member_id = public.current_team_member_id()
    )
  ));

CREATE POLICY task_comments_select ON public.task_comments FOR SELECT TO authenticated
  USING (public.can_access_task(task_id));
CREATE POLICY task_comments_insert ON public.task_comments FOR INSERT TO authenticated
  WITH CHECK (public.can_access_task(task_id) AND user_id = public.current_team_member_id());
CREATE POLICY task_comments_update_delete ON public.task_comments FOR ALL TO authenticated
  USING (user_id = public.current_team_member_id() OR public.has_permission('tasks.manage_all'));

CREATE POLICY leads_select ON public.leads FOR SELECT TO authenticated
  USING (public.can_access_lead(id));
CREATE POLICY leads_manage ON public.leads FOR ALL TO authenticated
  USING (public.has_permission('leads.manage')) WITH CHECK (public.has_permission('leads.manage'));
CREATE POLICY lead_members_select ON public.lead_members FOR SELECT TO authenticated
  USING (public.can_access_lead(lead_id));
CREATE POLICY lead_members_manage ON public.lead_members FOR ALL TO authenticated
  USING (public.has_permission('leads.manage')) WITH CHECK (public.has_permission('leads.manage'));
CREATE POLICY lead_interactions_access ON public.lead_interactions FOR ALL TO authenticated
  USING (public.can_access_lead(lead_id)) WITH CHECK (public.can_access_lead(lead_id));
CREATE POLICY lead_proposals_access ON public.lead_proposals FOR ALL TO authenticated
  USING (public.can_access_lead(lead_id)) WITH CHECK (public.can_access_lead(lead_id));
CREATE POLICY lead_fields_access ON public.lead_fields FOR ALL TO authenticated
  USING (public.can_access_lead(lead_id)) WITH CHECK (public.can_access_lead(lead_id));
CREATE POLICY lead_contacts_access ON public.lead_contacts FOR ALL TO authenticated
  USING (public.can_access_lead(lead_id)) WITH CHECK (public.can_access_lead(lead_id));

CREATE POLICY portal_settings_access ON public.portal_settings FOR ALL TO authenticated
  USING (public.has_permission('portal.read') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('portal.manage') AND public.can_access_project(project_id));
CREATE POLICY client_communications_access ON public.client_communications FOR ALL TO authenticated
  USING (public.has_permission('communications.read') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('communications.manage') AND public.can_access_project(project_id));
CREATE POLICY portal_updates_access ON public.portal_updates FOR ALL TO authenticated
  USING (public.has_permission('portal.read') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('portal.manage') AND public.can_access_project(project_id));
CREATE POLICY portal_update_attachments_access ON public.portal_update_attachments FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.portal_updates pu WHERE pu.id = update_id AND public.has_permission('portal.read')))
  WITH CHECK (public.has_permission('portal.manage'));
CREATE POLICY portal_events_access ON public.portal_events FOR SELECT TO authenticated
  USING (public.has_permission('portal.read'));

CREATE POLICY entity_files_select ON public.entity_files FOR SELECT TO authenticated
  USING (public.has_permission('files.read') AND (
    (entity_type = 'project' AND public.can_access_project(entity_id)) OR
    (entity_type = 'task' AND public.can_access_task(entity_id)) OR
    public.has_permission('files.manage')
  ));
CREATE POLICY entity_files_insert ON public.entity_files FOR INSERT TO authenticated
  WITH CHECK (public.has_permission('files.upload') AND uploaded_by = public.current_team_member_id());
CREATE POLICY entity_files_update_delete ON public.entity_files FOR ALL TO authenticated
  USING (public.has_permission('files.manage') OR (
    uploaded_by = public.current_team_member_id() AND visibility = 'internal'
  ));

CREATE POLICY api_keys_select ON public.api_keys FOR SELECT TO authenticated
  USING (team_member_id = public.current_team_member_id()
    OR created_by = public.current_team_member_id()
    OR public.has_permission('api_keys.manage_all'));
-- Keys are created and revoked by server routes (service role) only; members
-- read the keys they own or created, holders of api_keys.manage_all read all.
REVOKE ALL ON public.api_keys FROM anon, authenticated;
GRANT SELECT ON public.api_keys TO authenticated;

CREATE POLICY webhook_endpoints_manage ON public.webhook_endpoints FOR ALL TO authenticated
  USING (public.has_permission('webhooks.manage'))
  WITH CHECK (public.has_permission('webhooks.manage'));
CREATE POLICY webhook_events_select ON public.webhook_events FOR SELECT TO authenticated
  USING (public.has_permission('webhooks.manage'));
CREATE POLICY webhook_deliveries_select ON public.webhook_deliveries FOR SELECT TO authenticated
  USING (public.has_permission('webhooks.manage'));
CREATE POLICY webhook_deliveries_requeue ON public.webhook_deliveries FOR UPDATE TO authenticated
  USING (public.has_permission('webhooks.manage'))
  WITH CHECK (public.has_permission('webhooks.manage'));

CREATE POLICY time_entries_management_select ON public.project_time_entries FOR SELECT TO authenticated
  USING (public.has_permission('time.read_all') AND public.can_access_project(project_id));
CREATE POLICY time_entries_own_select ON public.project_time_entries FOR SELECT TO authenticated
  USING (public.has_permission('time.manage_own')
    AND member_id = public.current_team_member_id()
    AND public.can_access_project(project_id));
CREATE POLICY time_entries_insert ON public.project_time_entries FOR INSERT TO authenticated
  WITH CHECK (public.can_access_project(project_id) AND (
    (public.has_permission('time.manage_own') AND member_id = public.current_team_member_id())
    OR public.has_permission('time.manage_all')
  ));
CREATE POLICY time_entries_update ON public.project_time_entries FOR UPDATE TO authenticated
  USING (public.can_access_project(project_id) AND (
    public.has_permission('time.manage_all') OR (
      public.has_permission('time.manage_own')
      AND member_id = public.current_team_member_id()
      AND approval_status IN ('draft', 'pending', 'rejected')
    )
  ));
CREATE POLICY time_entries_delete ON public.project_time_entries FOR DELETE TO authenticated
  USING (public.has_permission('time.manage_all') OR (
    public.has_permission('time.manage_own')
    AND member_id = public.current_team_member_id()
    AND approval_status IN ('draft', 'pending', 'rejected')
  ));

CREATE POLICY hourly_rates_manage ON public.project_hourly_rates FOR ALL TO authenticated
  USING (public.has_permission('billing.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('billing.manage') AND public.can_access_project(project_id));
CREATE POLICY invoice_allocations_access ON public.invoice_time_entry_allocations FOR ALL TO authenticated
  USING (public.has_permission('invoices.read') AND EXISTS (
    SELECT 1 FROM public.project_invoices invoice WHERE invoice.id = invoice_id AND public.can_access_project(invoice.project_id)
  )) WITH CHECK (public.has_permission('invoices.manage'));
CREATE POLICY invoices_access ON public.project_invoices FOR ALL TO authenticated
  USING (public.has_permission('invoices.read') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('invoices.manage') AND public.can_access_project(project_id));

CREATE POLICY credentials_management ON public.project_credentials FOR ALL TO authenticated
  USING (public.has_permission('credentials.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('credentials.manage') AND public.can_access_project(project_id));
CREATE POLICY credential_members_management ON public.project_credential_members FOR ALL TO authenticated
  USING (public.has_permission('credentials.manage')) WITH CHECK (public.has_permission('credentials.manage'));

CREATE POLICY notifications_own_select ON public.team_member_notifications FOR SELECT TO authenticated
  USING (user_id = public.current_team_member_id());
CREATE POLICY notifications_own_update ON public.team_member_notifications FOR UPDATE TO authenticated
  USING (user_id = public.current_team_member_id());
CREATE POLICY notifications_own_delete ON public.team_member_notifications FOR DELETE TO authenticated
  USING (user_id = public.current_team_member_id());

CREATE POLICY project_context_select ON public.project_context FOR SELECT TO authenticated
  USING (public.has_permission('project_context.read') AND public.can_access_project(project_id));
CREATE POLICY project_context_manage ON public.project_context FOR ALL TO authenticated
  USING (public.has_permission('project_context.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('project_context.manage') AND public.can_access_project(project_id));
CREATE POLICY budget_history_access ON public.project_budget_history FOR SELECT TO authenticated
  USING (public.has_permission('billing.manage'));

CREATE POLICY business_settings_access ON public.business_settings FOR ALL TO authenticated
  USING (public.has_permission('settings.manage')) WITH CHECK (public.has_permission('settings.manage'));
CREATE POLICY smtp_accounts_access ON public.smtp_accounts FOR ALL TO authenticated
  USING (public.has_permission('smtp.manage')) WITH CHECK (public.has_permission('smtp.manage'));

CREATE POLICY member_rates_own_or_manage ON public.team_member_hourly_rates FOR SELECT TO authenticated
  USING (member_id = public.current_team_member_id() OR public.has_permission('compensation.manage'));
CREATE POLICY member_rates_manage ON public.team_member_hourly_rates FOR ALL TO authenticated
  USING (public.has_permission('compensation.manage')) WITH CHECK (public.has_permission('compensation.manage'));
CREATE POLICY adjustments_own_or_manage ON public.team_member_earning_adjustments FOR SELECT TO authenticated
  USING (member_id = public.current_team_member_id() OR public.has_permission('compensation.manage'));
CREATE POLICY adjustments_manage ON public.team_member_earning_adjustments FOR ALL TO authenticated
  USING (public.has_permission('compensation.manage')) WITH CHECK (public.has_permission('compensation.manage'));
CREATE POLICY payouts_own_or_manage ON public.team_member_payouts FOR SELECT TO authenticated
  USING (member_id = public.current_team_member_id() OR public.has_permission('payouts.manage'));
CREATE POLICY payouts_manage ON public.team_member_payouts FOR ALL TO authenticated
  USING (public.has_permission('payouts.manage')) WITH CHECK (public.has_permission('payouts.manage'));
CREATE POLICY payout_allocations_own_or_manage ON public.team_member_payout_allocations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.team_member_payouts payout
    WHERE payout.id = payout_id
      AND (payout.member_id = public.current_team_member_id() OR public.has_permission('payouts.manage'))
  ));
CREATE POLICY payout_allocations_manage ON public.team_member_payout_allocations FOR ALL TO authenticated
  USING (public.has_permission('payouts.manage')) WITH CHECK (public.has_permission('payouts.manage'));

-- Supplemental Agent tables are optional in a fresh non-Agent installation.
DO $$
BEGIN
  IF to_regclass('public.project_goals') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "project_goals_all" ON public.project_goals';
    EXECUTE 'CREATE POLICY project_goals_access ON public.project_goals FOR ALL TO authenticated
      USING (public.has_permission(''goals.read'') AND public.can_access_project(project_id))
      WITH CHECK (public.has_permission(''goals.manage'') AND public.can_access_project(project_id))';
  END IF;
  IF to_regclass('public.task_suggestions') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "task_suggestions_all" ON public.task_suggestions';
    EXECUTE 'CREATE POLICY task_suggestions_access ON public.task_suggestions FOR ALL TO authenticated
      USING (public.has_permission(''suggestions.manage'') AND public.can_access_project(project_id))
      WITH CHECK (public.has_permission(''suggestions.manage'') AND public.can_access_project(project_id))';
  END IF;
  IF to_regclass('public.agent_activities') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "agent_activities_all" ON public.agent_activities';
    EXECUTE 'CREATE POLICY agent_activities_access ON public.agent_activities FOR ALL TO authenticated
      USING (public.has_permission(''agents.manage'') OR agent_id = public.current_team_member_id())
      WITH CHECK (public.has_permission(''agents.manage'') OR agent_id = public.current_team_member_id())';
  END IF;
  IF to_regclass('public.api_audit_log') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "api_audit_log_all" ON public.api_audit_log';
    EXECUTE 'CREATE POLICY api_audit_log_access ON public.api_audit_log FOR SELECT TO authenticated
      USING (public.has_permission(''audit.read''))';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges and final validation
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.current_team_member_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_team_member_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_permission(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_project(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_lead(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_task(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_read_task_row(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_credential(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_access_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_team_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_accessible_time_entries(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_accessible_credential_metadata(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_team_member_hourly_rate(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_time_entries(uuid[], text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_team_member_payout(uuid, text, numeric, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_credential_members(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_project_billing_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_team_member_payout(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.current_team_member_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_team_member_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_permission(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_project(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_lead(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_task(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_read_task_row(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_credential(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_access_context() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_directory() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_accessible_time_entries(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_accessible_credential_metadata(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_team_member_hourly_rate(uuid, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_time_entries(uuid[], text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_team_member_payout(uuid, text, numeric, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_credential_members(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_team_member_payout(uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.team_members WHERE role = 'owner' AND status = 'active') < 1 THEN
    RAISE EXCEPTION 'At least one active Owner is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE approval_status = 'approved' AND compensation_rate <> 0
  ) THEN
    RAISE EXCEPTION 'Historical Owner compensation backfill must remain zero';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    LEFT JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE entry.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Invoice allocation integrity check failed';
  END IF;
END;
$$;

COMMIT;

BEGIN;

-- Owners and AI agents never accrue employee compensation, even if an old or
-- mistakenly-created rate row exists for them.
CREATE OR REPLACE FUNCTION public.resolve_team_member_hourly_rate(
  p_member_id uuid,
  p_effective_at timestamptz
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN member.role IN ('owner', 'agent') THEN 0 ELSE COALESCE((
    SELECT rate.hourly_rate
    FROM public.team_member_hourly_rates rate
    WHERE rate.member_id = p_member_id AND rate.effective_at <= p_effective_at
    ORDER BY rate.effective_at DESC
    LIMIT 1
  ), 0) END
  FROM public.team_members member
  WHERE member.id = p_member_id
$$;

-- Existing deployments already ran the initial access migration. Add the
-- app-facing Agent defaults idempotently so assigned work is usable there too.
INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('agent','team.read','app'), ('agent','projects.read','app'),
  ('agent','tasks.read','app'), ('agent','tasks.create','app'),
  ('agent','tasks.manage_assigned','app'), ('agent','files.read','app'),
  ('agent','files.upload','app'), ('agent','project_context.read','app'),
  ('agent','project_context.manage','app'), ('agent','goals.read','app'),
  ('agent','goals.manage','app'), ('agent','suggestions.manage','app')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('admin','notifications.manage_own','api'),
  ('member','notifications.manage_own','api'),
  ('guest','notifications.manage_own','api'),
  ('agent','notifications.manage_own','api'),
  ('agent','time.manage_own','api'),
  ('agent','notifications.send','api')
ON CONFLICT DO NOTHING;

-- Preserve access for legacy lead assignments that predate lead_members.
INSERT INTO public.lead_members (lead_id, member_id)
SELECT lead.id, lead.assigned_to
FROM public.leads lead
WHERE lead.assigned_to IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.can_access_lead(p_lead_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.leads WHERE id = p_lead_id AND deleted_at IS NULL)
    AND (
      public.has_permission('leads.read_all', 'app')
      OR (
        public.has_permission('leads.read', 'app')
        AND EXISTS (
          SELECT 1 FROM public.leads lead
          WHERE lead.id = p_lead_id
            AND (
              lead.assigned_to = public.current_team_member_id()
              OR EXISTS (
                SELECT 1 FROM public.lead_members assignment
                WHERE assignment.lead_id = lead.id
                  AND assignment.member_id = public.current_team_member_id()
              )
            )
        )
      )
    )
$$;

CREATE OR REPLACE FUNCTION public.can_access_file_entity(p_entity_type text, p_entity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_entity_type
    WHEN 'project' THEN public.can_access_project(p_entity_id)
    WHEN 'lead' THEN public.can_access_lead(p_entity_id)
    WHEN 'contact' THEN
      EXISTS (SELECT 1 FROM public.contacts WHERE id = p_entity_id AND deleted_at IS NULL)
      AND (
        public.has_permission('contacts.read_all', 'app')
        OR (
          public.has_permission('contacts.read', 'app')
          AND EXISTS (
            SELECT 1 FROM public.project_contacts link
            WHERE link.contact_id = p_entity_id
              AND public.can_access_project(link.project_id)
          )
        )
      )
    ELSE false
  END
$$;

-- Editing a rejected completed entry resubmits it for review. Without this,
-- rejected work can be corrected but remains permanently excluded from pay.
CREATE OR REPLACE FUNCTION public.apply_time_entry_compensation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member_role text;
BEGIN
  -- Moving it to Trash or back is not an edit: nothing to resubmit or reprice.
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NEW;
  END IF;
  SELECT role INTO member_role FROM public.team_members WHERE id = NEW.member_id;

  IF TG_OP = 'INSERT' OR NEW.start_time IS DISTINCT FROM OLD.start_time OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    -- The lock guards entries with real compensation behind them. Owner
    -- entries are born approved with rate 0 (no reviewer above the owner, no
    -- hourly pay), so without the role exemption every owner edit was an
    -- edit to an approved entry and the lock fired on the one person it
    -- protects nothing from (20260812_owner_time_entries_stay_editable).
    IF TG_OP = 'UPDATE' AND OLD.approval_status = 'approved' AND member_role <> 'owner' THEN
      RAISE EXCEPTION 'Approved time entry compensation is locked';
    END IF;
    IF member_role = 'owner' THEN
      -- Owners have no hourly compensation to resolve or to lock.
      NEW.compensation_rate := 0;
    ELSE
      NEW.compensation_rate := public.resolve_team_member_hourly_rate(NEW.member_id, NEW.start_time);
    END IF;
  END IF;

  IF NEW.end_time IS NULL THEN
    NEW.approval_status := 'draft';
    NEW.submitted_at := NULL;
    NEW.approved_at := NULL;
    NEW.approved_by := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.end_time IS NULL THEN
    NEW.submitted_at := now();
    IF member_role = 'owner' THEN
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := NEW.member_id;
      NEW.compensation_rate := 0;
    ELSIF member_role <> 'agent'
      AND COALESCE((SELECT auto_approve_human_hours FROM public.business_settings LIMIT 1), true) THEN
      -- Auto-approved by workspace policy; approved_by NULL marks it as
      -- system-approved rather than reviewed by a person.
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := NULL;
    ELSE
      NEW.approval_status := 'pending';
      NEW.approved_at := NULL;
      NEW.approved_by := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.approval_status = 'rejected' AND member_role <> 'owner'
    AND NEW.approval_status = OLD.approval_status THEN
    -- A content edit to a rejected entry resubmits it for review. A review
    -- decision (approval_status changed by review_time_entries) passes
    -- through untouched.
    NEW.approval_status := 'pending';
    NEW.submitted_at := now();
    NEW.approved_at := NULL;
    NEW.approved_by := NULL;
    NEW.rejection_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_time_entries(
  p_entry_ids uuid[],
  p_decision text,
  p_reason text DEFAULT NULL,
  p_adjustments jsonb DEFAULT NULL
)
RETURNS SETOF public.project_time_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.has_permission('time.approve', 'app') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid review decision';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND member_id = public.current_team_member_id()
  ) THEN
    RAISE EXCEPTION 'Time entries cannot be self-approved';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND NOT public.can_access_project(project_id)
  ) THEN
    RAISE EXCEPTION 'Project access denied';
  END IF;
  IF p_decision = 'approved' AND EXISTS (
    SELECT 1
    FROM public.project_time_entries entry
    JOIN public.team_members member ON member.id = entry.member_id
    WHERE entry.id = ANY(p_entry_ids)
      AND entry.approval_status IN ('pending', 'rejected')
      AND member.role NOT IN ('owner', 'agent')
      AND NOT EXISTS (
        SELECT 1 FROM public.team_member_hourly_rates rate
        WHERE rate.member_id = entry.member_id
          AND rate.effective_at <= entry.start_time
      )
  ) THEN
    RAISE EXCEPTION 'Compensation rate missing for one or more time entries';
  END IF;

  UPDATE public.project_time_entries entry
  SET approval_status = p_decision,
      compensation_rate = CASE WHEN p_decision = 'approved'
        THEN public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time)
        ELSE entry.compensation_rate END,
      approved_at = CASE WHEN p_decision = 'approved' THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_decision = 'approved' THEN public.current_team_member_id() ELSE NULL END,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN COALESCE(p_reason, '') ELSE NULL END,
      updated_at = now()
  WHERE entry.id = ANY(p_entry_ids)
    AND entry.approval_status IN ('pending', 'rejected')
    AND entry.end_time IS NOT NULL
    AND entry.deleted_at IS NULL;

  -- Approved agent entries convert to their billed continuous slot here,
  -- optionally with the reviewer's adjusted worked minutes per entry id.
  IF p_decision = 'approved' THEN
    FOREACH v_id IN ARRAY p_entry_ids LOOP
      PERFORM public.apply_agent_billing_conversion(
        v_id,
        CASE WHEN p_adjustments IS NOT NULL AND p_adjustments ? v_id::text
          THEN (p_adjustments->>v_id::text)::numeric
          ELSE NULL END
      );
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT * FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND deleted_at IS NULL;
END;
$$;

-- Adding or backdating a rate repairs every affected unpaid snapshot. Entries
-- with any payout allocation remain immutable so recorded payroll never moves.
CREATE OR REPLACE FUNCTION public.schedule_team_member_hourly_rate(
  p_member_id uuid,
  p_hourly_rate numeric,
  p_effective_at timestamptz,
  p_created_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member_role text;
  inserted_rate public.team_member_hourly_rates%ROWTYPE;
  updated_entries integer;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.has_permission('compensation.manage', 'app') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF p_hourly_rate IS NULL OR p_hourly_rate < 0 OR p_effective_at IS NULL THEN
    RAISE EXCEPTION 'Valid rate and effective date are required';
  END IF;

  SELECT role INTO member_role FROM public.team_members WHERE id = p_member_id;
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Team member not found';
  END IF;
  IF member_role IN ('owner', 'agent') THEN
    RAISE EXCEPTION 'Owners and AI agents cannot receive compensation rates';
  END IF;

  INSERT INTO public.team_member_hourly_rates (
    member_id, hourly_rate, effective_at, created_by
  ) VALUES (
    p_member_id, p_hourly_rate, p_effective_at,
    COALESCE(public.current_team_member_id(), p_created_by)
  )
  RETURNING * INTO inserted_rate;

  UPDATE public.project_time_entries entry
  SET compensation_rate = public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time),
      updated_at = now()
  WHERE entry.member_id = p_member_id
    AND entry.start_time >= p_effective_at
    AND NOT EXISTS (
      SELECT 1 FROM public.team_member_payout_allocations allocation
      WHERE allocation.time_entry_id = entry.id
    )
    AND entry.compensation_rate IS DISTINCT FROM public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time);
  GET DIAGNOSTICS updated_entries = ROW_COUNT;

  RETURN jsonb_build_object(
    'rate', to_jsonb(inserted_rate),
    'updated_entries', updated_entries
  );
END;
$$;

-- Lead readers may read related records, but only lead managers may mutate them.
DROP POLICY IF EXISTS lead_interactions_access ON public.lead_interactions;
DROP POLICY IF EXISTS lead_proposals_access ON public.lead_proposals;
DROP POLICY IF EXISTS lead_fields_access ON public.lead_fields;
DROP POLICY IF EXISTS lead_contacts_access ON public.lead_contacts;
DROP POLICY IF EXISTS lead_interactions_select ON public.lead_interactions;
DROP POLICY IF EXISTS lead_interactions_manage ON public.lead_interactions;
DROP POLICY IF EXISTS lead_proposals_select ON public.lead_proposals;
DROP POLICY IF EXISTS lead_proposals_manage ON public.lead_proposals;
DROP POLICY IF EXISTS lead_fields_select ON public.lead_fields;
DROP POLICY IF EXISTS lead_fields_manage ON public.lead_fields;
DROP POLICY IF EXISTS lead_contacts_select ON public.lead_contacts;
DROP POLICY IF EXISTS lead_contacts_manage ON public.lead_contacts;

CREATE POLICY lead_interactions_select ON public.lead_interactions FOR SELECT TO authenticated
  USING (public.can_access_lead(lead_id));
CREATE POLICY lead_interactions_manage ON public.lead_interactions FOR ALL TO authenticated
  USING (public.has_permission('leads.manage') AND public.can_access_lead(lead_id))
  WITH CHECK (public.has_permission('leads.manage') AND public.can_access_lead(lead_id));
CREATE POLICY lead_proposals_select ON public.lead_proposals FOR SELECT TO authenticated
  USING (public.can_access_lead(lead_id));
CREATE POLICY lead_proposals_manage ON public.lead_proposals FOR ALL TO authenticated
  USING (public.has_permission('leads.manage') AND public.can_access_lead(lead_id))
  WITH CHECK (public.has_permission('leads.manage') AND public.can_access_lead(lead_id));
CREATE POLICY lead_fields_select ON public.lead_fields FOR SELECT TO authenticated
  USING (public.can_access_lead(lead_id));
CREATE POLICY lead_fields_manage ON public.lead_fields FOR ALL TO authenticated
  USING (public.has_permission('leads.manage') AND public.can_access_lead(lead_id))
  WITH CHECK (public.has_permission('leads.manage') AND public.can_access_lead(lead_id));
CREATE POLICY lead_contacts_select ON public.lead_contacts FOR SELECT TO authenticated
  USING (public.can_access_lead(lead_id));
CREATE POLICY lead_contacts_manage ON public.lead_contacts FOR ALL TO authenticated
  USING (public.has_permission('leads.manage') AND public.can_access_lead(lead_id))
  WITH CHECK (public.has_permission('leads.manage') AND public.can_access_lead(lead_id));

-- Split read and write policies so read access never authorizes deletes.
DROP POLICY IF EXISTS portal_settings_access ON public.portal_settings;
DROP POLICY IF EXISTS client_communications_access ON public.client_communications;
DROP POLICY IF EXISTS portal_updates_access ON public.portal_updates;
DROP POLICY IF EXISTS portal_update_attachments_access ON public.portal_update_attachments;
DROP POLICY IF EXISTS portal_events_access ON public.portal_events;
DROP POLICY IF EXISTS portal_settings_select ON public.portal_settings;
DROP POLICY IF EXISTS portal_settings_manage ON public.portal_settings;
DROP POLICY IF EXISTS client_communications_select ON public.client_communications;
DROP POLICY IF EXISTS client_communications_manage ON public.client_communications;
DROP POLICY IF EXISTS portal_updates_select ON public.portal_updates;
DROP POLICY IF EXISTS portal_updates_manage ON public.portal_updates;
DROP POLICY IF EXISTS portal_update_attachments_select ON public.portal_update_attachments;
DROP POLICY IF EXISTS portal_update_attachments_manage ON public.portal_update_attachments;
DROP POLICY IF EXISTS portal_events_select ON public.portal_events;

CREATE POLICY portal_settings_select ON public.portal_settings FOR SELECT TO authenticated
  USING (public.has_permission('portal.read') AND public.can_access_project(project_id));
CREATE POLICY portal_settings_manage ON public.portal_settings FOR ALL TO authenticated
  USING (public.has_permission('portal.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('portal.manage') AND public.can_access_project(project_id));
CREATE POLICY client_communications_select ON public.client_communications FOR SELECT TO authenticated
  USING (public.has_permission('communications.read') AND public.can_access_project(project_id));
CREATE POLICY client_communications_manage ON public.client_communications FOR ALL TO authenticated
  USING (public.has_permission('communications.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('communications.manage') AND public.can_access_project(project_id));
CREATE POLICY portal_updates_select ON public.portal_updates FOR SELECT TO authenticated
  USING (public.has_permission('portal.read') AND public.can_access_project(project_id));
CREATE POLICY portal_updates_manage ON public.portal_updates FOR ALL TO authenticated
  USING (public.has_permission('portal.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('portal.manage') AND public.can_access_project(project_id));
CREATE POLICY portal_update_attachments_select ON public.portal_update_attachments FOR SELECT TO authenticated
  USING (public.has_permission('portal.read') AND EXISTS (
    SELECT 1 FROM public.portal_updates update_row
    WHERE update_row.id = update_id AND public.can_access_project(update_row.project_id)
  ));
CREATE POLICY portal_update_attachments_manage ON public.portal_update_attachments FOR ALL TO authenticated
  USING (public.has_permission('portal.manage') AND EXISTS (
    SELECT 1 FROM public.portal_updates update_row
    WHERE update_row.id = update_id AND public.can_access_project(update_row.project_id)
  ))
  WITH CHECK (public.has_permission('portal.manage') AND EXISTS (
    SELECT 1 FROM public.portal_updates update_row
    WHERE update_row.id = update_id AND public.can_access_project(update_row.project_id)
  ));
CREATE POLICY portal_events_select ON public.portal_events FOR SELECT TO authenticated
  USING (public.has_permission('portal.read') AND public.can_access_project(project_id));

DROP POLICY IF EXISTS entity_files_select ON public.entity_files;
DROP POLICY IF EXISTS entity_files_insert ON public.entity_files;
DROP POLICY IF EXISTS entity_files_update_delete ON public.entity_files;
CREATE POLICY entity_files_select ON public.entity_files FOR SELECT TO authenticated
  USING (public.has_permission('files.read') AND public.can_access_file_entity(entity_type, entity_id));
CREATE POLICY entity_files_insert ON public.entity_files FOR INSERT TO authenticated
  WITH CHECK (
    public.has_permission('files.upload')
    AND uploaded_by = public.current_team_member_id()
    AND public.can_access_file_entity(entity_type, entity_id)
  );
CREATE POLICY entity_files_update_delete ON public.entity_files FOR ALL TO authenticated
  USING (
    public.can_access_file_entity(entity_type, entity_id)
    AND (public.has_permission('files.manage') OR (
      uploaded_by = public.current_team_member_id() AND visibility = 'internal'
    ))
  )
  WITH CHECK (
    public.can_access_file_entity(entity_type, entity_id)
    AND (public.has_permission('files.manage') OR uploaded_by = public.current_team_member_id())
  );

-- A project manager without assignment-management access can still retain
-- access to a project they personally create.
DROP POLICY IF EXISTS project_members_creator_self_insert ON public.project_members;
CREATE POLICY project_members_creator_self_insert ON public.project_members FOR INSERT TO authenticated
  WITH CHECK (
    member_id = public.current_team_member_id()
    AND EXISTS (
      SELECT 1 FROM public.projects project
      WHERE project.id = project_id
        AND project.created_by = public.current_team_member_id()
    )
  );

DROP POLICY IF EXISTS invoice_allocations_access ON public.invoice_time_entry_allocations;
DROP POLICY IF EXISTS invoices_access ON public.project_invoices;
DROP POLICY IF EXISTS invoice_allocations_select ON public.invoice_time_entry_allocations;
DROP POLICY IF EXISTS invoice_allocations_manage ON public.invoice_time_entry_allocations;
DROP POLICY IF EXISTS invoices_select ON public.project_invoices;
DROP POLICY IF EXISTS invoices_manage ON public.project_invoices;
CREATE POLICY invoice_allocations_select ON public.invoice_time_entry_allocations FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND EXISTS (
    SELECT 1 FROM public.project_invoices invoice
    WHERE invoice.id = invoice_id AND public.can_access_project(invoice.project_id)
  ));
CREATE POLICY invoice_allocations_manage ON public.invoice_time_entry_allocations FOR ALL TO authenticated
  USING (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_invoices invoice
    WHERE invoice.id = invoice_id AND public.can_access_project(invoice.project_id)
  ))
  WITH CHECK (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_invoices invoice
    WHERE invoice.id = invoice_id AND public.can_access_project(invoice.project_id)
  ));
CREATE POLICY invoices_select ON public.project_invoices FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND public.can_access_project(project_id));
CREATE POLICY invoices_manage ON public.project_invoices FOR ALL TO authenticated
  USING (public.has_permission('invoices.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('invoices.manage') AND public.can_access_project(project_id));

DROP POLICY IF EXISTS time_entries_delete ON public.project_time_entries;
CREATE POLICY time_entries_delete ON public.project_time_entries FOR DELETE TO authenticated
  USING (public.can_access_project(project_id) AND (
    public.has_permission('time.manage_all') OR (
      public.has_permission('time.manage_own')
      AND member_id = public.current_team_member_id()
      AND approval_status IN ('draft', 'pending', 'rejected')
    )
  ));

-- Personal compensation is visible only when own-earnings access is enabled.
DROP POLICY IF EXISTS member_rates_own_or_manage ON public.team_member_hourly_rates;
DROP POLICY IF EXISTS adjustments_own_or_manage ON public.team_member_earning_adjustments;
DROP POLICY IF EXISTS payouts_own_or_manage ON public.team_member_payouts;
DROP POLICY IF EXISTS payout_allocations_own_or_manage ON public.team_member_payout_allocations;
CREATE POLICY member_rates_own_or_manage ON public.team_member_hourly_rates FOR SELECT TO authenticated
  USING ((member_id = public.current_team_member_id() AND public.has_permission('earnings.own.read'))
    OR public.has_permission('compensation.manage'));
CREATE POLICY adjustments_own_or_manage ON public.team_member_earning_adjustments FOR SELECT TO authenticated
  USING ((member_id = public.current_team_member_id() AND public.has_permission('earnings.own.read'))
    OR public.has_permission('compensation.manage'));
CREATE POLICY payouts_own_or_manage ON public.team_member_payouts FOR SELECT TO authenticated
  USING ((member_id = public.current_team_member_id() AND public.has_permission('earnings.own.read'))
    OR public.has_permission('payouts.manage'));
CREATE POLICY payout_allocations_own_or_manage ON public.team_member_payout_allocations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.team_member_payouts payout
    WHERE payout.id = payout_id AND (
      (payout.member_id = public.current_team_member_id() AND public.has_permission('earnings.own.read'))
      OR public.has_permission('payouts.manage')
    )
  ));

-- Project retainers and revenue splits.
DROP POLICY IF EXISTS retainers_select ON public.project_retainers;
DROP POLICY IF EXISTS retainers_manage ON public.project_retainers;
CREATE POLICY retainers_select ON public.project_retainers FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND public.can_access_project(project_id));
CREATE POLICY retainers_manage ON public.project_retainers FOR ALL TO authenticated
  USING (public.has_permission('invoices.manage') AND public.can_access_project(project_id))
  WITH CHECK (public.has_permission('invoices.manage') AND public.can_access_project(project_id));

DROP POLICY IF EXISTS retainer_amounts_select ON public.project_retainer_amounts;
DROP POLICY IF EXISTS retainer_amounts_manage ON public.project_retainer_amounts;
CREATE POLICY retainer_amounts_select ON public.project_retainer_amounts FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ));
CREATE POLICY retainer_amounts_manage ON public.project_retainer_amounts FOR ALL TO authenticated
  USING (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ))
  WITH CHECK (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ));

DROP POLICY IF EXISTS retainer_periods_select ON public.project_retainer_periods;
DROP POLICY IF EXISTS retainer_periods_manage ON public.project_retainer_periods;
CREATE POLICY retainer_periods_select ON public.project_retainer_periods FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ));
CREATE POLICY retainer_periods_manage ON public.project_retainer_periods FOR ALL TO authenticated
  USING (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ))
  WITH CHECK (public.has_permission('invoices.manage') AND EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    WHERE retainer.id = retainer_id AND public.can_access_project(retainer.project_id)
  ));

-- Splits are compensation. Holding invoices.manage alone does not reveal them.
DROP POLICY IF EXISTS retainer_shares_manage ON public.project_retainer_shares;
CREATE POLICY retainer_shares_manage ON public.project_retainer_shares FOR ALL TO authenticated
  USING (public.has_permission('compensation.manage'))
  WITH CHECK (public.has_permission('compensation.manage'));

DROP POLICY IF EXISTS invoice_line_shares_manage ON public.invoice_line_shares;
CREATE POLICY invoice_line_shares_manage ON public.invoice_line_shares FOR ALL TO authenticated
  USING (public.has_permission('compensation.manage'))
  WITH CHECK (public.has_permission('compensation.manage'));

-- Earnings are written by triggers only; members read their own.
DROP POLICY IF EXISTS share_earnings_own_or_manage ON public.team_member_share_earnings;
CREATE POLICY share_earnings_own_or_manage ON public.team_member_share_earnings FOR SELECT TO authenticated
  USING ((member_id = public.current_team_member_id() AND public.has_permission('earnings.own.read'))
    OR public.has_permission('compensation.manage')
    OR public.has_permission('payouts.manage'));

REVOKE ALL ON FUNCTION public.workspace_today() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retainer_periods(uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retainer_due_periods_internal(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retainer_due_periods(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_project_invoice_number(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_retainer_draft_internal(uuid, jsonb, date, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_retainer_drafts(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_retainer_period(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retire_share_earning(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_invoice_share_earnings(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_share_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_project_retainer(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.schedule_retainer_amount(uuid, numeric, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_retainer_shares(uuid, jsonb, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_invoice_line_shares(uuid, jsonb) FROM PUBLIC;

-- Supabase grants new public functions to anon and authenticated by default.
REVOKE ALL ON FUNCTION public.retainer_periods(uuid, date, date) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.retainer_due_periods_internal(uuid, date) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.next_project_invoice_number(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.suggest_project_invoice_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggest_project_invoice_number(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.create_retainer_draft_internal(uuid, jsonb, date, boolean) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_retainer_drafts(date) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.retire_share_earning(uuid, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_invoice_share_earnings(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_share_member(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.retainer_line_json(uuid, integer, numeric, text, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retainer_due_periods(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.generate_retainer_period(uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.save_project_retainer(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.schedule_retainer_amount(uuid, numeric, date) FROM anon;
REVOKE ALL ON FUNCTION public.set_retainer_shares(uuid, jsonb, date) FROM anon;
REVOKE ALL ON FUNCTION public.set_invoice_line_shares(uuid, jsonb) FROM anon;

GRANT EXECUTE ON FUNCTION public.workspace_today() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retainer_due_periods(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_retainer_period(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_project_retainer(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.schedule_retainer_amount(uuid, numeric, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_retainer_shares(uuid, jsonb, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_invoice_line_shares(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_retainer_drafts(date) TO service_role;
REVOKE ALL ON FUNCTION public.retainer_accruing_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retainer_accruing_lines() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.can_access_file_entity(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_file_entity(text, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.schedule_team_member_hourly_rate(uuid, numeric, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_team_member_hourly_rate(uuid, numeric, timestamptz, uuid) TO authenticated, service_role;

-- Project and time mutations are handled by permission-aware server routes.
-- Keep direct authenticated reads limited to non-financial columns so RLS
-- cannot expose client billing rates or employee compensation rates.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.projects FROM authenticated;
GRANT SELECT (
  id, name, description, color, status, start_date, due_date,
  hourly_tracking, time_tracking_enabled, created_by, created_at, updated_at, archived_at,
  -- Trash, so signed-in reads can leave out what is in it.
  deleted_at, deleted_by,
  -- Agent columns, read by the live floor from the client: a feature flag
  -- and a branch name, neither financial (20260811_grant_agent_project_columns).
  autonomous_enabled, integration_branch
) ON public.projects TO authenticated;

REVOKE SELECT, INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.project_time_entries FROM authenticated;
GRANT SELECT (
  id, project_id, member_id, start_time, end_time, description,
  created_at, updated_at, segments, work_type, approval_status,
  submitted_at, approved_at, approved_by, rejection_reason, deleted_at, deleted_by
) ON public.project_time_entries TO authenticated;
GRANT DELETE ON public.project_time_entries TO authenticated;

COMMIT;
-- API scope integrity follow-up (20260721_api_scope_integrity.sql)
BEGIN;

DELETE FROM public.role_permissions
WHERE role = 'agent'
  AND permission_key = 'suggestions.manage';

INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('agent', 'suggestions.create', 'api'),
  ('agent', 'agent_activity.write', 'api')
ON CONFLICT DO NOTHING;

UPDATE public.api_keys key
SET scopes = ARRAY(
  SELECT DISTINCT scope
  FROM unnest(
    array_remove(COALESCE(key.scopes, '{}'), 'suggestions.manage')
      || ARRAY['suggestions.create', 'agent_activity.write']
  ) AS scope
  ORDER BY scope
)
WHERE EXISTS (
  SELECT 1
  FROM public.team_members member
  WHERE member.id = key.team_member_id
    AND member.role = 'agent'
);

CREATE OR REPLACE FUNCTION public.review_time_entries_api(
  p_project_id uuid,
  p_entry_ids uuid[],
  p_decision text,
  p_reason text,
  p_reviewer_id uuid
)
RETURNS SETOF public.project_time_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF COALESCE(array_length(p_entry_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'Select at least one time entry'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Invalid review decision'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_members WHERE id = p_reviewer_id AND status = 'active') THEN RAISE EXCEPTION 'Active reviewer not found'; END IF;
  IF (SELECT count(*) FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND deleted_at IS NULL) <> cardinality(p_entry_ids) THEN RAISE EXCEPTION 'One or more time entries were not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND project_id IS DISTINCT FROM p_project_id) THEN RAISE EXCEPTION 'Time entry does not belong to the project'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND member_id = p_reviewer_id) THEN RAISE EXCEPTION 'Time entries cannot be self-approved'; END IF;
  IF p_decision = 'approved' AND EXISTS (
    SELECT 1 FROM public.project_time_entries entry
    JOIN public.team_members member ON member.id = entry.member_id
    WHERE entry.id = ANY(p_entry_ids) AND entry.approval_status = 'pending'
      AND member.role NOT IN ('owner', 'agent')
      AND NOT EXISTS (SELECT 1 FROM public.team_member_hourly_rates rate WHERE rate.member_id = entry.member_id AND rate.effective_at <= entry.start_time)
  ) THEN RAISE EXCEPTION 'Compensation rate missing for one or more time entries'; END IF;
  UPDATE public.project_time_entries entry
  SET approval_status = p_decision,
      compensation_rate = CASE WHEN p_decision = 'approved' THEN public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time) ELSE entry.compensation_rate END,
      approved_at = CASE WHEN p_decision = 'approved' THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_decision = 'approved' THEN p_reviewer_id ELSE NULL END,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN COALESCE(p_reason, '') ELSE NULL END,
      updated_at = now()
  WHERE entry.id = ANY(p_entry_ids) AND entry.project_id = p_project_id
    AND entry.approval_status = 'pending' AND entry.end_time IS NOT NULL;
  IF p_decision = 'approved' THEN
    PERFORM public.apply_agent_billing_conversion(entry_id, NULL)
    FROM unnest(p_entry_ids) AS entry_id;
  END IF;
  RETURN QUERY
  SELECT * FROM public.project_time_entries
  WHERE id = ANY(p_entry_ids) AND project_id = p_project_id;
END;
$$;

REVOKE ALL ON FUNCTION public.review_time_entries_api(uuid, uuid[], text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_time_entries_api(uuid, uuid[], text, text, uuid) TO service_role;

CREATE TABLE IF NOT EXISTS public.api_rate_limit_windows (
  api_key_id uuid PRIMARY KEY REFERENCES public.api_keys(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0)
);
ALTER TABLE public.api_rate_limit_windows ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_api_rate_limit(
  p_api_key_id uuid,
  p_limit integer DEFAULT 120,
  p_window_seconds integer DEFAULT 60
)
RETURNS TABLE (allowed boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rate_window public.api_rate_limit_windows%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_limit <= 0 OR p_window_seconds <= 0 THEN RAISE EXCEPTION 'Invalid rate limit'; END IF;
  INSERT INTO public.api_rate_limit_windows (api_key_id, window_start, request_count)
  VALUES (p_api_key_id, v_now, 1)
  ON CONFLICT (api_key_id) DO UPDATE
  SET window_start = CASE WHEN api_rate_limit_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN v_now ELSE api_rate_limit_windows.window_start END,
      request_count = CASE WHEN api_rate_limit_windows.window_start + make_interval(secs => p_window_seconds) <= v_now THEN 1 ELSE api_rate_limit_windows.request_count + 1 END
  RETURNING * INTO rate_window;
  allowed := rate_window.request_count <= p_limit;
  remaining := GREATEST(0, p_limit - rate_window.request_count);
  reset_at := rate_window.window_start + make_interval(secs => p_window_seconds);
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_api_rate_limit(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_api_rate_limit(uuid, integer, integer) TO service_role;

COMMIT;

-- ─────────────────────────────────────────────────────────────
-- Inbound client email (20261006010922_email_inboxes.sql)
-- Inboxes on a relay domain received through Resend, threads and
-- messages (project on the thread), recipients and mapping candidates as
-- rows, attachments in the private inbound-email bucket, agent triage and
-- task links, and contact_emails (several addresses per contact, with
-- contacts.email kept as the primary mirror). A task linked to an email
-- is a normal task (rule 3 was removed in
-- 20261006113522_spec_is_for_agents.sql). The email.triaged activity type is
-- in schema_ai_agent.sql.
-- Per-project email addresses (20261006030328_email_project_addresses.sql):
-- endpoints route a routing address to an inbox and file new
-- threads on the project (project_source 'address'); a routing address
-- belongs to one inbox or one project address (routing_address_guard).
-- A file that keeps failing to download or store is given up on
-- (files_failed, skipped_reason download_failed) so its message still
-- arrives.
-- The communications schema (20261026091944_communications_schema.sql):
-- every inbound table, view and function moved out of public into
-- communications under a channel-neutral name (email_threads became
-- conversations, email_project_addresses endpoints, and so on), with a
-- channel column for the channels to come. A conversation's projects live in
-- conversation_projects; conversations.project_id/project_source/
-- project_address_id are a copy of its strongest one, kept by trigger for
-- older readers until they go. Index, constraint and policy names keep their
-- email_ prefix.
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 1. Helpers
-- ============================================================

CREATE OR REPLACE FUNCTION public.email_is_address(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_value IS NOT NULL
    AND length(p_value) BETWEEN 3 AND 320
    AND p_value ~ '^[^@[:space:]<>(),;:"]+@[^@[:space:]<>(),;:"]+\.[^@[:space:]<>(),;:"]+$'
$$;

-- The obvious public webmail domains. A client domain mapping on one of these
-- would map every stranger on that service to the project. The app keeps the
-- fuller list (src/lib/communications/email/public-domains.ts) and refuses first;
-- this is the backstop.
CREATE OR REPLACE FUNCTION public.email_domain_is_public(p_domain text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(p_domain) IN (
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
      'yahoo.com', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com',
      'aol.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'mail.com',
      'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com',
      'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io'
    )
    OR lower(p_domain) ~ '^(gmx|hotmail|outlook|live|yahoo|ymail|aol|msn|windowslive)\.[a-z]{2,3}(\.[a-z]{2})?$'
$$;

CREATE OR REPLACE FUNCTION public.email_inbox_verification_code()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'VM-' || string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  FROM generate_series(1, 4)
$$;

-- ============================================================
-- 2. Contact email addresses
-- ============================================================
-- One contact, several addresses; one address may belong to several
-- contacts (unique per contact, not globally). Stored lowercased.

CREATE TABLE public.contact_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND public.email_is_address(email)),
  is_primary boolean NOT NULL DEFAULT false,
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contact_emails_contact_email_key
  ON public.contact_emails (contact_id, lower(email));
CREATE UNIQUE INDEX contact_emails_one_primary
  ON public.contact_emails (contact_id) WHERE is_primary;
CREATE INDEX idx_contact_emails_email ON public.contact_emails (email);

-- Lowercase the address; the first address a contact gets is its primary;
-- promoting one demotes the others (before the one-primary index checks).
CREATE OR REPLACE FUNCTION public.contact_emails_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  IF TG_OP = 'INSERT' AND NOT NEW.is_primary AND NOT EXISTS (
    SELECT 1 FROM public.contact_emails WHERE contact_id = NEW.contact_id AND is_primary
  ) THEN
    NEW.is_primary := true;
  END IF;
  IF NEW.is_primary AND (TG_OP = 'INSERT' OR NOT OLD.is_primary OR OLD.contact_id IS DISTINCT FROM NEW.contact_id) THEN
    UPDATE public.contact_emails SET is_primary = false
    WHERE contact_id = NEW.contact_id AND is_primary AND id <> NEW.id;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END;
$$;

-- contacts.email mirrors the primary address. Case differences are left
-- alone so a form keeps the spelling it saved. With no primary, a valid
-- address in contacts.email is cleared; anything that is not an address
-- (legacy free text) is left as it is.
CREATE OR REPLACE FUNCTION public.sync_contact_email_mirror(p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current text;
  v_primary text;
BEGIN
  SELECT email INTO v_current FROM public.contacts WHERE id = p_contact_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT email INTO v_primary FROM public.contact_emails WHERE contact_id = p_contact_id AND is_primary;
  IF v_primary IS NOT NULL THEN
    IF lower(btrim(COALESCE(v_current, ''))) IS DISTINCT FROM v_primary THEN
      UPDATE public.contacts SET email = v_primary WHERE id = p_contact_id;
    END IF;
  ELSIF public.email_is_address(lower(btrim(COALESCE(v_current, '')))) THEN
    UPDATE public.contacts SET email = '' WHERE id = p_contact_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.contact_emails_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM public.sync_contact_email_mirror(OLD.contact_id); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.email IS DISTINCT FROM OLD.email OR NEW.is_primary IS DISTINCT FROM OLD.is_primary) THEN
    PERFORM public.sync_contact_email_mirror(NEW.contact_id);
  END IF;
  RETURN NULL;
END;
$$;

-- Editing contacts.email (every existing form) edits the primary address:
-- an address the contact already has becomes primary, otherwise the primary
-- row takes the new address, otherwise one is added. Clearing it, or saving
-- something that is not an address, removes the primary row. Changes made by
-- the mirror itself (a nested trigger) are not echoed back.
CREATE OR REPLACE FUNCTION public.contacts_sync_primary_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(btrim(COALESCE(NEW.email, '')));
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND lower(btrim(COALESCE(OLD.email, ''))) = v_email THEN RETURN NULL; END IF;
  IF NOT public.email_is_address(v_email) THEN
    DELETE FROM public.contact_emails WHERE contact_id = NEW.id AND is_primary;
  ELSIF EXISTS (SELECT 1 FROM public.contact_emails WHERE contact_id = NEW.id AND email = v_email) THEN
    UPDATE public.contact_emails SET is_primary = true WHERE contact_id = NEW.id AND email = v_email AND NOT is_primary;
  ELSIF EXISTS (SELECT 1 FROM public.contact_emails WHERE contact_id = NEW.id AND is_primary) THEN
    UPDATE public.contact_emails SET email = v_email WHERE contact_id = NEW.id AND is_primary;
  ELSE
    INSERT INTO public.contact_emails (contact_id, email, is_primary) VALUES (NEW.id, v_email, true);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER contact_emails_before_write
  BEFORE INSERT OR UPDATE ON public.contact_emails
  FOR EACH ROW EXECUTE FUNCTION public.contact_emails_before_write();

CREATE TRIGGER contact_emails_after_write
  AFTER INSERT OR UPDATE OR DELETE ON public.contact_emails
  FOR EACH ROW EXECUTE FUNCTION public.contact_emails_after_write();

CREATE TRIGGER contacts_sync_primary_email
  AFTER INSERT OR UPDATE OF email ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_sync_primary_email();

-- ============================================================
-- 3. Inboxes, access, client domains
-- ============================================================

-- As in public: the service role reaches everything, a signed-in person
-- reaches the tables under RLS (their policies decide), anon nothing. Every
-- function that reads or writes is granted to the service role alone, one by
-- one below.
CREATE SCHEMA IF NOT EXISTS communications;
REVOKE ALL ON SCHEMA communications FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA communications TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA communications GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA communications GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

CREATE TABLE communications.inboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- The public address clients write to, e.g. ashley@valiancemedia.com.
  address text NOT NULL CHECK (address = lower(btrim(address)) AND public.email_is_address(address)),
  -- <local>@<domain>, where the forwarder delivers and what ingestion looks
  -- up. The domain defaults to business_settings.inbound_email_domain and the
  -- local part to the address's, when left empty (inboxes_before_write).
  -- Changing either clears verified_at: the forwarder target changed.
  routing_domain text NOT NULL CHECK (routing_domain = lower(btrim(routing_domain)) AND public.email_is_hostname(routing_domain)),
  routing_local_part text NOT NULL CHECK (routing_local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  routing_address text GENERATED ALWAYS AS (routing_local_part || '@' || routing_domain) STORED,
  handler_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  max_attachment_mb integer NOT NULL DEFAULT 25 CHECK (max_attachment_mb BETWEEN 1 AND 50),
  agent_readable_types text[] NOT NULL DEFAULT ARRAY['image', 'pdf', 'text']::text[]
    CHECK (agent_readable_types <@ ARRAY['image', 'pdf', 'text']::text[]),
  summary_interval_minutes integer NOT NULL DEFAULT 30 CHECK (summary_interval_minutes BETWEEN 5 AND 1440),
  filter_auto_mail boolean NOT NULL DEFAULT true,
  verification_code text NOT NULL DEFAULT public.email_inbox_verification_code()
    CHECK (verification_code ~ '^VM-[A-Z0-9]{4}$'),
  verified_at timestamptz,
  last_received_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Addresses that reach the inbox without being its own (a personal address
  -- forwarding here): ours, never a client's, when reading who mail went to.
  aliases text[] NOT NULL DEFAULT '{}' CONSTRAINT inboxes_aliases_check CHECK (cardinality(aliases) <= 20),
  -- The triage this inbox runs: legacy, shadow (both; only legacy's work is
  -- kept) or plans.
  triage_mode text NOT NULL DEFAULT 'legacy'
    CONSTRAINT inboxes_triage_mode_check CHECK (triage_mode IN ('legacy', 'shadow', 'plans')),
  CONSTRAINT email_inboxes_routing_address_key UNIQUE (routing_address),
  CONSTRAINT email_inboxes_verification_code_key UNIQUE (verification_code)
);

CREATE TABLE communications.inbox_access (
  inbox_id uuid NOT NULL REFERENCES communications.inboxes(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inbox_id, member_id)
);
CREATE INDEX idx_email_inbox_access_member ON communications.inbox_access (member_id);

CREATE OR REPLACE FUNCTION communications.inboxes_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_base text;
  v_candidate text;
BEGIN
  NEW.address := lower(btrim(NEW.address));
  IF NEW.routing_domain IS NULL OR btrim(NEW.routing_domain) = '' THEN
    SELECT inbound_email_domain INTO NEW.routing_domain FROM public.business_settings LIMIT 1;
  END IF;
  NEW.routing_domain := lower(btrim(NEW.routing_domain));
  IF NEW.routing_local_part IS NULL OR btrim(NEW.routing_local_part) = '' THEN
    v_base := regexp_replace(regexp_replace(split_part(NEW.address, '@', 1), '[^a-z0-9._-]', '', 'g'), '^[._-]+|[._-]+$', '', 'g');
    IF v_base = '' THEN v_base := 'inbox'; END IF;
    v_base := left(v_base, 50);
    v_candidate := v_base;
    WHILE EXISTS (
      SELECT 1 FROM communications.inboxes
      WHERE routing_local_part = v_candidate AND routing_domain = NEW.routing_domain AND id <> NEW.id
    ) OR EXISTS (
      SELECT 1 FROM communications.endpoints
      WHERE routing_local_part = v_candidate AND routing_domain = NEW.routing_domain
    ) LOOP
      v_candidate := v_base || '-' || substr(md5(random()::text), 1, 4);
    END LOOP;
    NEW.routing_local_part := v_candidate;
  ELSE
    NEW.routing_local_part := lower(btrim(NEW.routing_local_part));
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.routing_domain IS DISTINCT FROM OLD.routing_domain OR NEW.routing_local_part IS DISTINCT FROM OLD.routing_local_part THEN
      -- A new route: verify again, and it waits for its first email again.
      NEW.verified_at := NULL;
      NEW.last_received_at := NULL;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- The handler always reads its own inbox.
CREATE OR REPLACE FUNCTION communications.inboxes_grant_handler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF NEW.handler_member_id IS NOT NULL THEN
    INSERT INTO communications.inbox_access (inbox_id, member_id) VALUES (NEW.id, NEW.handler_member_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER inboxes_before_write
  BEFORE INSERT OR UPDATE ON communications.inboxes
  FOR EACH ROW EXECUTE FUNCTION communications.inboxes_before_write();

CREATE TRIGGER inboxes_grant_handler
  AFTER INSERT OR UPDATE OF handler_member_id ON communications.inboxes
  FOR EACH ROW EXECUTE FUNCTION communications.inboxes_grant_handler();

-- Mail from any address at a client's domain maps to the project. A domain may
-- map to several projects (one client, several companies).
CREATE TABLE communications.client_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL CHECK (
    domain = lower(btrim(domain))
    AND public.email_is_hostname(domain)
    AND NOT public.email_domain_is_public(domain)
  ),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_client_domains_domain_project_key UNIQUE (domain, project_id)
);
CREATE INDEX idx_email_client_domains_project ON communications.client_domains (project_id);

-- Mail from one exact client address maps to the project, without making the
-- person a contact. Public email services are allowed here (a client who
-- writes from bob@gmail.com). An address may map to several projects.
CREATE TABLE communications.client_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address = lower(btrim(address)) AND public.email_is_address(address)),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_client_addresses_project_address_key UNIQUE (project_id, address)
);
CREATE INDEX idx_email_client_addresses_address ON communications.client_addresses (address);

-- A project's own addresses: mail to one lands in its inbox, filed on the
-- project. Several per project, so an address can change without dropping
-- mail from clients still using the old one.
-- Your addresses: every address mail comes in on. With a project, everything
-- sent to it is that project's, through its own relay address. Without one,
-- it is an address of yours or the company's that forwards to the inbox's
-- routing address and has no relay address of its own.
CREATE TABLE communications.endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  -- The inbox that receives the mail; its handler triages it.
  inbox_id uuid NOT NULL REFERENCES communications.inboxes(id) ON DELETE CASCADE,
  -- <local>@<domain>, where the forwarder delivers and what ingestion looks
  -- up, as on inboxes. For a project address the domain defaults to
  -- business_settings.inbound_email_domain and the local part to the public
  -- address's, when left empty (endpoints_before_write).
  routing_domain text CHECK (routing_domain IS NULL OR (routing_domain = lower(btrim(routing_domain)) AND public.email_is_hostname(routing_domain))),
  routing_local_part text CHECK (routing_local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  routing_address text GENERATED ALWAYS AS (routing_local_part || '@' || routing_domain) STORED,
  -- What clients write to, e.g. ciaran@plan4thefuture.com. Mail sent to it
  -- reads as written to us (delivery_of).
  public_address text CHECK (public_address IS NULL OR (public_address = lower(btrim(public_address)) AND public.email_is_address(public_address))),
  enabled boolean NOT NULL DEFAULT true,
  -- When mail last came through this address (email_complete_message).
  last_received_at timestamptz,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Where messages arrive: an email routing address today; a phone number or
  -- a chat workspace on the channels to come.
  channel text NOT NULL DEFAULT 'email' CONSTRAINT endpoints_channel_check CHECK (channel IN ('email')),
  -- Whose address it is: a person, or the company when null. A person's
  -- addresses are theirs as a sender too.
  owner_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  CONSTRAINT email_project_addresses_routing_address_key UNIQUE (routing_address),
  -- A project address needs its own relay address: that is how mail is known
  -- to be the project's. Every address has a relay or a public address.
  CONSTRAINT endpoints_project_needs_routing CHECK (project_id IS NULL OR (routing_local_part IS NOT NULL AND routing_domain IS NOT NULL)),
  CONSTRAINT endpoints_has_address CHECK (routing_local_part IS NOT NULL OR public_address IS NOT NULL),
  CONSTRAINT endpoints_routing_whole CHECK ((routing_local_part IS NULL) = (routing_domain IS NULL))
);
CREATE INDEX idx_email_project_addresses_project ON communications.endpoints (project_id);
CREATE INDEX idx_email_project_addresses_inbox ON communications.endpoints (inbox_id);
CREATE UNIQUE INDEX endpoints_public_address_key ON communications.endpoints (public_address) WHERE public_address IS NOT NULL;
CREATE INDEX idx_endpoints_owner ON communications.endpoints (owner_member_id) WHERE owner_member_id IS NOT NULL;

-- Your domains: a catch-all, so mail written to any address on one reads as
-- written to you, listed or not. A specific address still wins.
CREATE TABLE communications.own_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL CONSTRAINT own_domains_domain_check CHECK (
    domain = lower(btrim(domain)) AND public.email_is_hostname(domain) AND NOT public.email_domain_is_public(domain)
  ),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT own_domains_domain_key UNIQUE (domain)
);

-- Addresses marked as not yours (or removed): never suggested again.
CREATE TABLE communications.ignored_addresses (
  address text PRIMARY KEY CONSTRAINT ignored_addresses_address_check CHECK (address = lower(btrim(address)) AND public.email_is_address(address)),
  ignored_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE communications.own_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.ignored_addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_domains_select ON communications.own_domains FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.read') OR public.has_permission('inbound_email.manage'));
CREATE POLICY ignored_addresses_select ON communications.ignored_addresses FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.manage'));

CREATE OR REPLACE FUNCTION communications.endpoints_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_base text;
BEGIN
  NEW.public_address := NULLIF(lower(btrim(COALESCE(NEW.public_address, ''))), '');
  -- An address with no project and no relay address of its own keeps none:
  -- it arrives through the inbox's routing address.
  IF NEW.project_id IS NULL AND (NEW.routing_local_part IS NULL OR btrim(NEW.routing_local_part) = '') THEN
    NEW.routing_local_part := NULL;
    NEW.routing_domain := NULL;
  ELSE
    IF NEW.routing_domain IS NULL OR btrim(NEW.routing_domain) = '' THEN
      SELECT inbound_email_domain INTO NEW.routing_domain FROM public.business_settings LIMIT 1;
    END IF;
    NEW.routing_domain := lower(btrim(NEW.routing_domain));
    IF (NEW.routing_local_part IS NULL OR btrim(NEW.routing_local_part) = '') AND NEW.public_address IS NOT NULL THEN
      v_base := regexp_replace(regexp_replace(split_part(NEW.public_address, '@', 1), '[^a-z0-9._-]', '', 'g'), '^[._-]+|[._-]+$', '', 'g');
      NEW.routing_local_part := regexp_replace(left(v_base, 64), '[._-]+$', '');
    ELSE
      NEW.routing_local_part := lower(btrim(COALESCE(NEW.routing_local_part, '')));
    END IF;
  END IF;
  -- An edit, not mail arriving (last_received_at). A new route (routing or
  -- public address) waits for its first email again.
  IF TG_OP = 'UPDATE' AND NEW.last_received_at IS NOT DISTINCT FROM OLD.last_received_at THEN
    NEW.updated_at := now();
    IF NEW.routing_local_part IS DISTINCT FROM OLD.routing_local_part OR NEW.routing_domain IS DISTINCT FROM OLD.routing_domain
      OR NEW.public_address IS DISTINCT FROM OLD.public_address THEN
      NEW.last_received_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER endpoints_before_write
  BEFORE INSERT OR UPDATE ON communications.endpoints
  FOR EACH ROW EXECUTE FUNCTION communications.endpoints_before_write();

-- After the row is written, so the generated routing_address is final. The
-- advisory lock takes writers to either table one at a time, so two
-- concurrent writes of the same address cannot both pass.
CREATE OR REPLACE FUNCTION communications.routing_address_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.routing_address IS NOT DISTINCT FROM OLD.routing_address THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.email_routing_address'));
  IF TG_TABLE_NAME = 'inboxes' THEN
    IF EXISTS (SELECT 1 FROM communications.endpoints WHERE routing_address = NEW.routing_address) THEN
      RAISE EXCEPTION 'EMAIL_ROUTING_ADDRESS_TAKEN: % is a project email address', NEW.routing_address
        USING ERRCODE = '23505', CONSTRAINT = 'email_routing_address_guard';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM communications.inboxes WHERE routing_address = NEW.routing_address) THEN
    RAISE EXCEPTION 'EMAIL_ROUTING_ADDRESS_TAKEN: % is an inbox routing address', NEW.routing_address
      USING ERRCODE = '23505', CONSTRAINT = 'email_routing_address_guard';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER email_inboxes_routing_address_guard
  AFTER INSERT OR UPDATE ON communications.inboxes
  FOR EACH ROW EXECUTE FUNCTION communications.routing_address_guard();

CREATE TRIGGER email_project_addresses_routing_address_guard
  AFTER INSERT OR UPDATE ON communications.endpoints
  FOR EACH ROW EXECUTE FUNCTION communications.routing_address_guard();

-- ============================================================
-- 4. Threads and messages
-- ============================================================

CREATE TABLE communications.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES communications.inboxes(id) ON DELETE RESTRICT,
  subject_normalized text NOT NULL DEFAULT '',
  -- A copy of the conversation's strongest project (conversation_projects,
  -- conversation_projects_sync), for older readers until they go. mapped:
  -- from a contact or domain mapping; inferred: chosen by the agent at triage
  -- among the mapping candidates; guessed: chosen by the agent for an email
  -- with no candidates; person: set by a person; address: sent to one of the
  -- project's own addresses (a person's mapping, final like person).
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  project_source text,
  -- The project address that filed the thread, while its source is
  -- 'address'. A deleted address leaves the project in place.
  project_address_id uuid REFERENCES communications.endpoints(id) ON DELETE SET NULL,
  -- One line on where the conversation stands, kept by the agent at triage.
  summary text CONSTRAINT email_threads_summary_check CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 300),
  summary_at timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL DEFAULT 'email' CONSTRAINT conversations_channel_check CHECK (channel IN ('email')),
  -- A person asked to ignore it: no plans for its new messages.
  muted_at timestamptz,
  muted_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  CONSTRAINT email_threads_project_source_check CHECK (project_source IN ('mapped', 'inferred', 'guessed', 'person', 'address')),
  CONSTRAINT email_threads_project_pair_check CHECK ((project_id IS NULL) = (project_source IS NULL)),
  CONSTRAINT email_threads_project_address_check CHECK (project_address_id IS NULL OR project_source = 'address')
);
CREATE INDEX idx_email_threads_inbox_last ON communications.conversations (inbox_id, last_message_at DESC);
CREATE INDEX idx_email_threads_inbox_subject ON communications.conversations (inbox_id, subject_normalized);
CREATE INDEX idx_email_threads_project ON communications.conversations (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_email_threads_project_address ON communications.conversations (project_address_id) WHERE project_address_id IS NOT NULL;

-- A deleted project nulls project_id (ON DELETE SET NULL); its source goes
-- too. Any other source than 'address' drops the address.
CREATE OR REPLACE FUNCTION communications.conversations_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS NULL THEN NEW.project_source := NULL; END IF;
  IF NEW.project_source IS DISTINCT FROM 'address' THEN NEW.project_address_id := NULL; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_before_update
  BEFORE UPDATE ON communications.conversations
  FOR EACH ROW EXECUTE FUNCTION communications.conversations_before_update();

-- Sender rules (20261023194940_inbox_sorting_and_relations.sql): an address
-- or domain, optionally one topic, and what to do with its mail. People and
-- the agent (from patterns) create them; they are switched off, never deleted.
CREATE TABLE communications.sender_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_kind text NOT NULL CHECK (match_kind IN ('address', 'domain')),
  match_value text NOT NULL CHECK (match_value = lower(btrim(match_value)) AND length(match_value) BETWEEN 3 AND 320),
  -- NULL: every topic from this sender.
  topic text CONSTRAINT sender_rules_topic_check CHECK (topic IN ('money', 'account_risk', 'security', 'usage', 'event', 'newsletter', 'promotion', 'update', 'receipt', 'calendar', 'survey', 'code')),
  action text NOT NULL CHECK (action IN ('ignore', 'fyi', 'always')),
  source text NOT NULL CHECK (source IN ('person', 'agent')),
  -- Why the rule exists, in a sentence (the agent always gives one).
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  hit_count integer NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  last_hit_at timestamptz,
  -- Rules are switched off, never deleted, so a filtered email can still
  -- say which rule filtered it.
  disabled_at timestamptz,
  disabled_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_sender_rules_live_key
  ON communications.sender_rules (match_kind, match_value, COALESCE(topic, '')) WHERE disabled_at IS NULL;

CREATE TRIGGER set_email_sender_rules_updated_at
  BEFORE UPDATE ON communications.sender_rules
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TABLE communications.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES communications.inboxes(id) ON DELETE RESTRICT,
  -- Set when the message completes; a receiving row has none yet.
  thread_id uuid REFERENCES communications.conversations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'receiving'
    CONSTRAINT email_messages_status_check CHECK (status IN ('receiving', 'new', 'handled', 'ignored', 'needs_human')),
  -- Where the message came from: the receiving provider and its id for the
  -- message, so a webhook retry finds the same row.
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9_-]{1,40}$'),
  provider_email_id text NOT NULL CHECK (length(provider_email_id) BETWEEN 1 AND 200),
  -- The Message-ID header without angle brackets (synthetic from the
  -- provider's id when the header is missing). Raw header values, not entities.
  internet_message_id text NOT NULL CHECK (length(internet_message_id) BETWEEN 1 AND 998),
  in_reply_to text[] NOT NULL DEFAULT '{}',
  reference_ids text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL DEFAULT '',
  subject_normalized text NOT NULL DEFAULT '',
  sent_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  text_body text,
  html_body text,
  -- Display only: the message with quoted history stripped.
  new_text text,
  is_forward boolean NOT NULL DEFAULT false,
  -- Sender trust: { trust: trusted | untrusted | unknown, source, spf, dkim,
  -- dmarc, reason, raw Authentication-Results/ARC headers when present }.
  -- trusted = DKIM pass aligned with the From domain; untrusted = DKIM failed
  -- or is not aligned; unknown = no result we can rely on.
  auth jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_mail_reason text CHECK (auto_mail_reason IS NULL OR length(auto_mail_reason) <= 200),
  -- {inbox_id}/{message_id}/raw.eml; size and hash are recorded when stored.
  raw_storage_path text,
  raw_size_bytes bigint CHECK (raw_size_bytes IS NULL OR raw_size_bytes >= 0),
  raw_sha256 text CHECK (raw_sha256 IS NULL OR raw_sha256 ~ '^[0-9a-f]{64}$'),
  raw_uploaded_at timestamptz,
  -- Ingestion runs in which a file failed to download or store
  -- (files_failed); enough of them and the files are given up on.
  file_failures integer NOT NULL DEFAULT 0 CHECK (file_failures >= 0),
  -- What decided the project candidates. The visible sender decides, unless
  -- it is a verified teammate (an active person on the team, not an agent,
  -- with sender trust 'trusted'): sender (the From address; the default),
  -- forwarded_original (a teammate forwarded it: the original sender of the
  -- outermost forwarded message, original_from_address and _name), or
  -- team_recipients (a teammate wrote it and copied the inbox: the client
  -- addresses in To and Cc). forwarded_by_member_id: that teammate. auth
  -- stays the verdict on the outer message.
  routing_basis text NOT NULL DEFAULT 'sender'
    CHECK (routing_basis IN ('sender', 'forwarded_original', 'team_recipients')),
  forwarded_by_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  original_from_address text
    CHECK (original_from_address IS NULL OR (original_from_address = lower(btrim(original_from_address)) AND length(original_from_address) BETWEEN 3 AND 320)),
  original_from_name text CHECK (original_from_name IS NULL OR length(original_from_name) <= 300),
  completed_at timestamptz,
  -- A person looked at it in the Inbox and marked it handled. A suggested
  -- reply waits in "Needs reply" until then; sending the message back to
  -- the agent clears it.
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  -- How it was sorted on arrival: what it is (kind), what machine mail is
  -- about (topic), and what sorting did (sort_action: ignore = Filtered and
  -- never triaged, fyi = triaged lightly, always = full triage, triage = the
  -- default), why, and the sender rule that decided it.
  kind text CONSTRAINT email_messages_kind_check CHECK (kind IN ('person', 'team', 'meeting_notes', 'notification', 'marketing')),
  topic text CONSTRAINT email_messages_topic_check CHECK (topic IN ('money', 'account_risk', 'security', 'usage', 'event', 'newsletter', 'promotion', 'update', 'receipt', 'calendar', 'survey', 'code')),
  sort_action text CONSTRAINT email_messages_sort_action_check CHECK (sort_action IN ('ignore', 'fyi', 'always', 'triage')),
  sort_reason text CONSTRAINT email_messages_sort_reason_check CHECK (sort_reason IS NULL OR length(sort_reason) <= 300),
  sender_rule_id uuid REFERENCES communications.sender_rules(id) ON DELETE SET NULL,
  -- A newer alert from the same sender on the same topic.
  superseded_by uuid REFERENCES communications.messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL DEFAULT 'email' CONSTRAINT messages_channel_check CHECK (channel IN ('email')),
  -- The verified teammate behind the message: who wrote it, or who forwarded
  -- or copied it in (email: an active person, not an agent, whose From
  -- address passed DKIM). Null for everyone else.
  sender_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  -- The channel vouches for the sender (email: auth trust 'trusted').
  sender_verified boolean NOT NULL DEFAULT false,
  -- How it reached us (communications.delivery_of): direct, group, cc, bcc,
  -- forwarded or broadcast; null while receiving.
  delivery text CONSTRAINT messages_delivery_check
    CHECK (delivery IN ('direct', 'group', 'cc', 'bcc', 'forwarded', 'broadcast')),
  -- Distinct main and copy recipients.
  audience_size integer CONSTRAINT messages_audience_size_check CHECK (audience_size >= 0),
  CONSTRAINT email_messages_inbox_message_key UNIQUE (inbox_id, internet_message_id),
  CONSTRAINT email_messages_inbox_provider_key UNIQUE (inbox_id, provider, provider_email_id),
  CONSTRAINT email_messages_thread_when_complete CHECK (status = 'receiving' OR thread_id IS NOT NULL),
  CONSTRAINT email_messages_raw_stored_with_hash CHECK (raw_uploaded_at IS NULL OR (raw_storage_path IS NOT NULL AND raw_sha256 IS NOT NULL AND raw_size_bytes IS NOT NULL)),
  -- The original sender belongs to a forward only; the forwarder to anything
  -- but the sender basis (it may be null there once that teammate is deleted).
  CONSTRAINT email_messages_routing_check CHECK (
    (original_from_address IS NOT NULL) = (routing_basis = 'forwarded_original')
    AND (original_from_name IS NULL OR routing_basis = 'forwarded_original')
    AND (forwarded_by_member_id IS NULL OR routing_basis <> 'sender')
  )
);
CREATE INDEX idx_email_messages_sender_rule ON communications.messages (sender_rule_id) WHERE sender_rule_id IS NOT NULL;
CREATE INDEX idx_email_messages_superseded_by ON communications.messages (superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX idx_email_messages_inbox_status ON communications.messages (inbox_id, status, received_at DESC);
CREATE INDEX idx_email_messages_inbox_received ON communications.messages (inbox_id, received_at DESC);
CREATE INDEX idx_email_messages_thread ON communications.messages (thread_id, received_at);
CREATE INDEX idx_email_messages_forwarded_by ON communications.messages (forwarded_by_member_id) WHERE forwarded_by_member_id IS NOT NULL;
CREATE UNIQUE INDEX email_messages_raw_storage_path_key ON communications.messages (raw_storage_path) WHERE raw_storage_path IS NOT NULL;

CREATE TRIGGER set_email_messages_updated_at
  BEFORE UPDATE ON communications.messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Sender and recipients as rows. contact_id is set when exactly one contact
-- has the address.
CREATE TABLE communications.participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('from', 'to', 'cc', 'reply_to')),
  address text NOT NULL CHECK (address = lower(btrim(address)) AND length(address) BETWEEN 3 AND 320),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 300),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  position integer NOT NULL DEFAULT 0,
  CONSTRAINT email_message_recipients_message_kind_address_key UNIQUE (message_id, kind, address)
);
CREATE UNIQUE INDEX email_message_recipients_one_from ON communications.participants (message_id) WHERE kind = 'from';
CREATE INDEX idx_email_message_recipients_address ON communications.participants (address);
CREATE INDEX idx_email_message_recipients_contact ON communications.participants (contact_id) WHERE contact_id IS NOT NULL;

-- Thread participants are derived, never stored.
CREATE OR REPLACE VIEW communications.conversation_participants
WITH (security_invoker = true) AS
SELECT
  m.thread_id,
  r.address,
  max(r.name) AS name,
  (array_agg(r.contact_id) FILTER (WHERE r.contact_id IS NOT NULL))[1] AS contact_id,
  count(*)::integer AS appearances,
  max(m.received_at) AS last_seen_at
FROM communications.participants r
JOIN communications.messages m ON m.id = r.message_id
WHERE m.thread_id IS NOT NULL
GROUP BY m.thread_id, r.address;

-- Projects the sender maps to: through a contact address, a client domain or
-- a client sender address.
CREATE TABLE communications.message_candidates (
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('contact', 'domain', 'sender')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, project_id, reason)
);
CREATE INDEX idx_email_message_candidates_project ON communications.message_candidates (project_id);

-- The projects a conversation is about, any number of them, each with how it
-- got there (the sources of conversations.project_source) and, for address,
-- the endpoint that filed it (20261026093748_conversation_projects_scope.sql:
-- one conversation, several projects, each item filed on its own within the
-- message's scope, communications.scope_source).
CREATE TABLE communications.conversation_projects (
  conversation_id uuid NOT NULL REFERENCES communications.conversations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source text NOT NULL CONSTRAINT conversation_projects_source_check
    CHECK (source IN ('mapped', 'inferred', 'guessed', 'person', 'address')),
  endpoint_id uuid REFERENCES communications.endpoints(id) ON DELETE SET NULL,
  -- The message that brought it, and the person who set it.
  message_id uuid REFERENCES communications.messages(id) ON DELETE SET NULL,
  added_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, project_id),
  CONSTRAINT conversation_projects_endpoint_check CHECK (endpoint_id IS NULL OR source = 'address')
);
CREATE INDEX idx_conversation_projects_project ON communications.conversation_projects (project_id);
CREATE INDEX idx_conversation_projects_message ON communications.conversation_projects (message_id) WHERE message_id IS NOT NULL;

-- How strongly a project is known: a person's word first, a guess last.
CREATE OR REPLACE FUNCTION communications.project_source_rank(p_source text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array_position(ARRAY['person', 'address', 'mapped', 'inferred', 'guessed'], p_source)
$$;

-- Keeps conversations.project_id/project_source/project_address_id a copy of
-- the conversation's strongest project, for older readers.
CREATE OR REPLACE FUNCTION communications.conversation_projects_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_id uuid;
  v_project uuid;
  v_source text;
  v_endpoint uuid;
BEGIN
  FOR v_id IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.conversation_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.conversation_id END
    ]) AS x WHERE x IS NOT NULL
  LOOP
    SELECT p.project_id, p.source, CASE WHEN p.source = 'address' THEN p.endpoint_id END
    INTO v_project, v_source, v_endpoint
    FROM communications.conversation_projects p
    WHERE p.conversation_id = v_id
    ORDER BY communications.project_source_rank(p.source), p.created_at, p.project_id
    LIMIT 1;
    UPDATE communications.conversations
    SET project_id = v_project, project_source = v_source, project_address_id = v_endpoint
    WHERE id = v_id
      AND (project_id, project_source, project_address_id) IS DISTINCT FROM (v_project, v_source, v_endpoint);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER conversation_projects_sync
  AFTER INSERT OR UPDATE OR DELETE ON communications.conversation_projects
  FOR EACH ROW EXECUTE FUNCTION communications.conversation_projects_sync();

CREATE TRIGGER set_conversation_projects_updated_at
  BEFORE UPDATE ON communications.conversation_projects
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Every project endpoint a message arrived through (mail to two project
-- addresses at once came through both).
CREATE TABLE communications.message_endpoints (
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES communications.endpoints(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, endpoint_id)
);
CREATE INDEX idx_message_endpoints_endpoint ON communications.message_endpoints (endpoint_id);

-- Stored email files: one per distinct file per inbox. An attachment points
-- at the copy of its bytes (file_id), so the same signature logo or quoted
-- screenshot across many emails is stored once. Each copy has its own path,
-- {inbox_id}/files/{id}: a copy being deleted (deleting_at) is never reused,
-- a new one takes its place. Server only (service role).
CREATE TABLE communications.files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES communications.inboxes(id) ON DELETE RESTRICT,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_path text NOT NULL UNIQUE,
  -- Set once its bytes are in the bucket.
  stored_at timestamptz,
  -- Set when nothing points at it any more (files_release); its bytes go next.
  deleting_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One live copy of the same bytes per inbox.
CREATE UNIQUE INDEX email_files_live_key ON communications.files (inbox_id, sha256) WHERE deleting_at IS NULL;
CREATE INDEX idx_email_files_deleting ON communications.files (deleting_at) WHERE deleting_at IS NOT NULL;

CREATE TABLE communications.attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  filename text NOT NULL DEFAULT '' CHECK (length(filename) <= 255),
  content_type text NOT NULL DEFAULT 'application/octet-stream' CHECK (length(content_type) BETWEEN 1 AND 255),
  -- The provider's declared size until stored, then the stored size.
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  -- Computed while the file is copied into storage.
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  provider_attachment_id text CHECK (provider_attachment_id IS NULL OR length(provider_attachment_id) <= 200),
  disposition text CHECK (disposition IN ('attachment', 'inline')),
  content_id text CHECK (content_id IS NULL OR length(content_id) <= 998),
  -- Where the bytes are in the inbound-email bucket once stored: the copy's
  -- path ({inbox_id}/files/{file_id}), or {inbox_id}/{message_id}/{attachment_id}
  -- for files stored before copies were shared. NULL while pending, and with
  -- a skipped_reason when the file was never stored: over the size cap, or
  -- given up on after failed downloads (files_failed).
  storage_path text,
  skipped_reason text CHECK (skipped_reason IN ('over_size_cap', 'download_failed')),
  uploaded_at timestamptz,
  page_count integer CHECK (page_count IS NULL OR page_count >= 0),
  -- Display only, for the Inbox UI. Never a substitute for reading the file.
  agent_label text CHECK (agent_label IS NULL OR length(agent_label) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The copy its bytes are stored in (files); null for files stored
  -- the old way (their own path) and for files not stored.
  file_id uuid REFERENCES communications.files(id) ON DELETE RESTRICT,
  CONSTRAINT email_attachments_message_position_key UNIQUE (message_id, position),
  CONSTRAINT email_attachments_uploaded_needs_path CHECK (uploaded_at IS NULL OR (storage_path IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL)),
  CONSTRAINT email_attachments_stored_or_skipped CHECK (storage_path IS NULL OR skipped_reason IS NULL),
  CONSTRAINT email_attachments_file_not_skipped CHECK (file_id IS NULL OR skipped_reason IS NULL)
);
-- Many attachments share a copy's path; a path of its own stays unique.
CREATE UNIQUE INDEX email_attachments_storage_path_key ON communications.attachments (storage_path) WHERE storage_path IS NOT NULL AND file_id IS NULL;
CREATE INDEX idx_email_attachments_file ON communications.attachments (file_id) WHERE file_id IS NOT NULL;

CREATE TRIGGER set_email_attachments_updated_at
  BEFORE UPDATE ON communications.attachments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================
-- 5. Triage and task links
-- ============================================================

-- Every triage is kept; the newest per message wins.
CREATE TABLE communications.triage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  outcome text NOT NULL CONSTRAINT email_triage_outcome_check CHECK (outcome IN ('no_action', 'task', 'needs_reply', 'needs_human')),
  urgent boolean NOT NULL DEFAULT false,
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 4000),
  -- What the agent needs a person to decide (needs_human).
  question_for_human text CONSTRAINT email_triage_question_for_human_check
    CHECK (question_for_human IS NULL OR length(question_for_human) <= 4000),
  -- Copy-only text for a person to send from their own mail. Never sent.
  suggested_reply text CHECK (suggested_reply IS NULL OR length(suggested_reply) <= 20000),
  -- The single project an older triage chose when the thread had none
  -- (project_ids holds every project a triage files on).
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  summarized_at timestamptz,
  -- The caller's retry key (the API takes 8 to 100 characters): the same key
  -- on the same email returns this triage instead of recording another.
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 100),
  -- sha256 of the request that used the key, so a reused key with another
  -- body is refused rather than replayed.
  request_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Every project this triage filed the message on: the ones it named and
  -- those of the tasks it linked.
  project_ids uuid[] NOT NULL DEFAULT '{}',
  -- The plan a plan-based triage recorded (triage_plan_id_fkey, after plans).
  plan_id uuid,
  -- What the agent read the email as: work, fyi (needs nothing from anyone),
  -- or outreach (someone selling to us, filtered unless something guards it).
  category text CONSTRAINT email_triage_category_check CHECK (category IS NULL OR category IN ('work', 'fyi', 'outreach')),
  CONSTRAINT email_triage_key_has_hash CHECK (idempotency_key IS NULL OR request_hash IS NOT NULL)
);
CREATE INDEX idx_email_triage_message ON communications.triage (message_id, created_at DESC);
CREATE INDEX idx_email_triage_unsummarized ON communications.triage (message_id) WHERE summarized_at IS NULL;
CREATE UNIQUE INDEX email_triage_message_idempotency_key ON communications.triage (message_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE communications.task_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  -- related: about the task, asks for no change. A person's link has no triage.
  relation text NOT NULL CONSTRAINT email_task_links_relation_check CHECK (relation IN ('created', 'updated', 'related')),
  triage_id uuid REFERENCES communications.triage(id) ON DELETE SET NULL,
  linked_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_task_links_message_task_relation_key UNIQUE (message_id, task_id, relation)
);
CREATE INDEX idx_email_task_links_task ON communications.task_links (task_id);

-- Reply drafts: a person asks, the agent writes, the person copies it into
-- their own mail. Nothing is ever sent.
CREATE TABLE communications.reply_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES communications.conversations(id) ON DELETE CASCADE,
  -- The email the reply answers (the newest when it was asked for).
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 2000),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'ready', 'failed')),
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 20000),
  drafted_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  failure text CHECK (failure IS NULL OR length(failure) <= 500),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_reply_drafts_ready_has_body CHECK ((status = 'ready') = (body IS NOT NULL)),
  CONSTRAINT email_reply_drafts_done_has_time CHECK ((status = 'requested') = (completed_at IS NULL))
);
CREATE INDEX idx_email_reply_drafts_thread ON communications.reply_drafts (thread_id, created_at DESC);
CREATE INDEX idx_email_reply_drafts_requested ON communications.reply_drafts (created_at) WHERE status = 'requested';

CREATE TRIGGER set_email_reply_drafts_updated_at
  BEFORE UPDATE ON communications.reply_drafts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- An answer a person gave to the agent's question on a triage; the email goes back to the agent.
CREATE TABLE communications.answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  -- The triage whose question this answers.
  triage_id uuid NOT NULL REFERENCES communications.triage(id) ON DELETE CASCADE,
  answer text NOT NULL CHECK (length(answer) BETWEEN 1 AND 2000),
  answered_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_email_question_answers_message ON communications.answers (message_id, created_at DESC);

-- ============================================================
-- 6. Server-side writes (service role only)
-- ============================================================

-- Ingestion step 1: the message row (status receiving), its sender and
-- recipients, and its attachment rows (pending, or skipped when over the
-- size cap), in one transaction, before any file is written. Idempotent on the provider's
-- id and on (inbox, Message-ID): a retried or duplicate delivery returns the
-- existing rows.
CREATE OR REPLACE FUNCTION communications.email_start_message(
  p_inbox_id uuid,
  p_message jsonb,
  p_recipients jsonb,
  p_attachments jsonb,
  p_max_attachment_bytes bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_id uuid;
  v_created boolean := false;
  v_attachment jsonb;
  v_position integer := 0;
  v_attachment_id uuid;
  v_size bigint;
  v_over boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;

  SELECT id INTO v_id FROM communications.messages
  WHERE inbox_id = p_inbox_id AND provider = p_message->>'provider' AND provider_email_id = p_message->>'provider_email_id';

  IF v_id IS NULL THEN
    INSERT INTO communications.messages (
      inbox_id, provider, provider_email_id, internet_message_id, in_reply_to, reference_ids,
      subject, subject_normalized, sent_at, received_at, text_body, html_body, new_text, is_forward,
      auth, auto_mail_reason
    ) VALUES (
      p_inbox_id,
      p_message->>'provider',
      p_message->>'provider_email_id',
      p_message->>'internet_message_id',
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_message->'in_reply_to', '[]'::jsonb))),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_message->'reference_ids', '[]'::jsonb))),
      COALESCE(p_message->>'subject', ''),
      COALESCE(p_message->>'subject_normalized', ''),
      (p_message->>'sent_at')::timestamptz,
      COALESCE((p_message->>'received_at')::timestamptz, now()),
      p_message->>'text_body',
      p_message->>'html_body',
      p_message->>'new_text',
      COALESCE((p_message->>'is_forward')::boolean, false),
      COALESCE(p_message->'auth', '{}'::jsonb),
      p_message->>'auto_mail_reason'
    )
    ON CONFLICT (inbox_id, internet_message_id) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      -- The same message, delivered again under another provider id.
      SELECT id INTO v_id FROM communications.messages
      WHERE inbox_id = p_inbox_id AND internet_message_id = p_message->>'internet_message_id';
    ELSE
      v_created := true;
      UPDATE communications.messages
      SET raw_storage_path = CASE WHEN COALESCE((p_message->>'has_raw')::boolean, false)
                                  THEN p_inbox_id::text || '/' || v_id::text || '/raw.eml' END
      WHERE id = v_id;

      INSERT INTO communications.participants (message_id, kind, address, name, position)
      SELECT v_id, r.value->>'kind', lower(btrim(r.value->>'address')), left(COALESCE(r.value->>'name', ''), 300), (r.ordinality - 1)::integer
      FROM jsonb_array_elements(COALESCE(p_recipients, '[]'::jsonb)) WITH ORDINALITY AS r(value, ordinality)
      ON CONFLICT DO NOTHING;

      FOR v_attachment IN SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb)) LOOP
        v_attachment_id := gen_random_uuid();
        v_size := (v_attachment->>'size_bytes')::bigint;
        v_over := v_size IS NOT NULL AND v_size > p_max_attachment_bytes;
        INSERT INTO communications.attachments (
          id, message_id, position, filename, content_type, size_bytes, disposition, content_id,
          provider_attachment_id, skipped_reason
        ) VALUES (
          v_attachment_id, v_id, v_position,
          left(COALESCE(v_attachment->>'filename', ''), 255),
          left(COALESCE(NULLIF(v_attachment->>'content_type', ''), 'application/octet-stream'), 255),
          v_size,
          v_attachment->>'disposition',
          v_attachment->>'content_id',
          v_attachment->>'provider_attachment_id',
          CASE WHEN v_over THEN 'over_size_cap' END
        );
        v_position := v_position + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'created', v_created,
    'message', (
      SELECT jsonb_build_object('id', m.id, 'inbox_id', m.inbox_id, 'status', m.status,
        'raw_storage_path', m.raw_storage_path, 'raw_uploaded_at', m.raw_uploaded_at)
      FROM communications.messages m WHERE m.id = v_id
    ),
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'position', a.position, 'filename', a.filename,
        'content_type', a.content_type, 'size_bytes', a.size_bytes, 'provider_attachment_id', a.provider_attachment_id,
        'storage_path', a.storage_path, 'skipped_reason', a.skipped_reason, 'uploaded_at', a.uploaded_at,
        'file_id', a.file_id) ORDER BY a.position)
      FROM communications.attachments a WHERE a.message_id = v_id
    ), '[]'::jsonb)
  );
END;
$$;

-- Ingestion step 2, after every planned file is stored: thread, mapping, status.
-- p_decision: { status: new|ignored, thread_id?: uuid (else a new thread),
--   project_id?: uuid (set only on a thread without one),
--   project_source?: mapped (default, a contact or domain) | address (the
--   project's own address, with project_address_id),
--   project_address_id?: uuid,
--   received_via_address_id?: uuid, received_via_address_ids?: [uuid] (the
--   project addresses the email matched, whether or not they set the
--   project: each is recorded on the message and its last_received_at stamped),
--   routing_basis?: sender (default) | forwarded_original | team_recipients,
--   forwarded_by_member_id?: uuid (the verified teammate, when not sender),
--   original_from_address?, original_from_name? (forwarded_original only),
--   candidates: [{project_id, reason}], recipient_contacts: [{address, contact_id}] }
CREATE OR REPLACE FUNCTION communications.email_complete_message(p_message_id uuid, p_decision jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_thread uuid;
  v_status text := p_decision->>'status';
  v_source text := COALESCE(p_decision->>'project_source', 'mapped');
  v_basis text := COALESCE(p_decision->>'routing_basis', 'sender');
  v_rule uuid := (p_decision->>'sender_rule_id')::uuid;
  v_forwarder uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF v_status NOT IN ('new', 'ignored') THEN RAISE EXCEPTION 'email_complete_message: status must be new or ignored' USING ERRCODE = '22023'; END IF;
  IF v_source NOT IN ('mapped', 'address') THEN RAISE EXCEPTION 'email_complete_message: project_source must be mapped or address' USING ERRCODE = '22023'; END IF;
  IF v_basis NOT IN ('sender', 'forwarded_original', 'team_recipients') THEN
    RAISE EXCEPTION 'email_complete_message: routing_basis must be sender, forwarded_original or team_recipients' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002'; END IF;
  IF v_message.status <> 'receiving' THEN
    RETURN jsonb_build_object('already_complete', true, 'status', v_message.status, 'thread_id', v_message.thread_id);
  END IF;
  IF (v_message.raw_storage_path IS NOT NULL AND v_message.raw_uploaded_at IS NULL)
    OR EXISTS (SELECT 1 FROM communications.attachments WHERE message_id = p_message_id AND uploaded_at IS NULL AND skipped_reason IS NULL) THEN
    RAISE EXCEPTION 'EMAIL_FILES_PENDING: message % still has files to store', p_message_id USING ERRCODE = 'P0001';
  END IF;

  IF p_decision->>'thread_id' IS NOT NULL THEN
    SELECT id INTO v_thread FROM communications.conversations
    WHERE id = (p_decision->>'thread_id')::uuid AND inbox_id = v_message.inbox_id
    FOR UPDATE;
    IF v_thread IS NULL THEN RAISE EXCEPTION 'email_complete_message: thread is not in this inbox' USING ERRCODE = '22023'; END IF;
    UPDATE communications.conversations SET last_message_at = GREATEST(last_message_at, v_message.received_at) WHERE id = v_thread;
  ELSE
    INSERT INTO communications.conversations (inbox_id, subject_normalized, last_message_at)
    VALUES (v_message.inbox_id, v_message.subject_normalized, v_message.received_at)
    RETURNING id INTO v_thread;
  END IF;

  -- A conversation keeps its project once set (the conversation row is
  -- locked above or new). An address deleted since it was matched still
  -- files the project, without the address.
  IF p_decision->>'project_id' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM communications.conversation_projects WHERE conversation_id = v_thread) THEN
    INSERT INTO communications.conversation_projects (conversation_id, project_id, source, endpoint_id, message_id)
    VALUES (
      v_thread, (p_decision->>'project_id')::uuid, v_source,
      CASE WHEN v_source = 'address' THEN (
        SELECT a.id FROM communications.endpoints a WHERE a.id = (p_decision->>'project_address_id')::uuid
      ) END,
      p_message_id
    )
    ON CONFLICT DO NOTHING;
  END IF;
  -- Every project endpoint it came through (the scope's endpoint basis).
  INSERT INTO communications.message_endpoints (message_id, endpoint_id)
  SELECT p_message_id, a.id FROM communications.endpoints a
  WHERE a.inbox_id = v_message.inbox_id AND (
    a.id = (p_decision->>'received_via_address_id')::uuid
    OR a.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_decision->'received_via_address_ids', '[]'::jsonb)))
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO communications.message_candidates (message_id, project_id, reason)
  SELECT p_message_id, (c->>'project_id')::uuid, c->>'reason'
  FROM jsonb_array_elements(COALESCE(p_decision->'candidates', '[]'::jsonb)) AS c
  ON CONFLICT DO NOTHING;

  UPDATE communications.participants r
  SET contact_id = (x->>'contact_id')::uuid
  FROM jsonb_array_elements(COALESCE(p_decision->'recipient_contacts', '[]'::jsonb)) AS x
  WHERE r.message_id = p_message_id AND r.address = x->>'address';

  -- A rule switched off since ingestion read it is still the rule that sorted it.
  IF v_rule IS NOT NULL AND NOT EXISTS (SELECT 1 FROM communications.sender_rules WHERE id = v_rule) THEN
    v_rule := NULL;
  END IF;

  -- A teammate deleted since ingestion read them leaves no forwarder. The
  -- teammate is also the message's sender_member_id: the verified teammate
  -- behind it, whatever the channel.
  v_forwarder := CASE WHEN v_basis <> 'sender' THEN (
    SELECT tm.id FROM public.team_members tm WHERE tm.id = (p_decision->>'forwarded_by_member_id')::uuid
  ) END;
  UPDATE communications.messages
  SET thread_id = v_thread,
      status = v_status,
      completed_at = now(),
      routing_basis = v_basis,
      forwarded_by_member_id = v_forwarder,
      sender_member_id = v_forwarder,
      sender_verified = COALESCE(v_message.auth->>'trust', '') = 'trusted',
      original_from_address = CASE WHEN v_basis = 'forwarded_original' THEN lower(btrim(p_decision->>'original_from_address')) END,
      original_from_name = CASE WHEN v_basis = 'forwarded_original'
        THEN NULLIF(left(btrim(COALESCE(p_decision->>'original_from_name', '')), 300), '') END,
      kind = p_decision->>'kind',
      topic = p_decision->>'topic',
      sort_action = p_decision->>'sort_action',
      sort_reason = NULLIF(left(btrim(COALESCE(p_decision->>'sort_reason', '')), 300), ''),
      sender_rule_id = v_rule
  WHERE id = p_message_id;

  IF v_rule IS NOT NULL THEN
    UPDATE communications.sender_rules SET hit_count = hit_count + 1, last_hit_at = now() WHERE id = v_rule;
  END IF;

  UPDATE communications.inboxes SET last_received_at = now() WHERE id = v_message.inbox_id;
  UPDATE communications.endpoints e SET last_received_at = now()
  FROM communications.message_endpoints me
  WHERE me.message_id = p_message_id AND e.id = me.endpoint_id;

  RETURN jsonb_build_object('already_complete', false, 'status', v_status, 'thread_id', v_thread);
END;
$$;

-- Ingestion, when files of a receiving message failed in this run:
-- p_attachment_ids the attachments that failed, p_raw whether the raw .eml
-- did. Counts the failed run. From the p_max_failures-th failed run, or once
-- the message is p_max_age_minutes old, it gives up on those files: each
-- attachment is skipped as download_failed and the raw .eml is dropped (its
-- parsed bodies stand), so the message completes without them instead of
-- staying in receiving until retention deletes it. A copy an attachment had
-- claimed is let go (retention releases it once nothing points at it);
-- anything already stored under a dropped path is an orphan for the weekly sweep.
CREATE OR REPLACE FUNCTION communications.files_failed(
  p_message_id uuid,
  p_attachment_ids jsonb,
  p_raw boolean,
  p_max_failures integer,
  p_max_age_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_give_up boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;

  UPDATE communications.messages SET file_failures = file_failures + 1
  WHERE id = p_message_id AND status = 'receiving'
  RETURNING * INTO v_message;
  IF NOT FOUND THEN RETURN jsonb_build_object('receiving', false, 'gave_up', false, 'failures', 0); END IF;

  v_give_up := v_message.file_failures >= p_max_failures
    OR v_message.created_at < now() - make_interval(mins => p_max_age_minutes);
  IF v_give_up THEN
    UPDATE communications.attachments
    SET storage_path = NULL, file_id = NULL, skipped_reason = 'download_failed'
    WHERE message_id = p_message_id AND uploaded_at IS NULL AND skipped_reason IS NULL
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_attachment_ids, '[]'::jsonb)));
    IF p_raw THEN
      UPDATE communications.messages SET raw_storage_path = NULL WHERE id = p_message_id AND raw_uploaded_at IS NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object('receiving', true, 'gave_up', v_give_up, 'failures', v_message.file_failures);
END;
$$;

-- Ingestion, once an attachment is downloaded and hashed: the inbox's stored
-- copy of those bytes, or a new one to upload. The attachment points at the
-- copy from here on, which keeps it from being released (files_release
-- locks a copy and re-checks before releasing it). A retry keeps the copy it
-- already points at. A copy being deleted is never reused: a new one, at its
-- own path, takes its place.
CREATE OR REPLACE FUNCTION communications.claim_file(p_attachment_id uuid, p_sha256 text, p_size_bytes bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_inbox uuid;
  v_current uuid;
  v_file communications.files;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'claim_file: sha256 must be 64 lowercase hex characters' USING ERRCODE = '22023';
  END IF;
  IF p_size_bytes IS NULL OR p_size_bytes < 0 THEN RAISE EXCEPTION 'claim_file: size_bytes must be 0 or more' USING ERRCODE = '22023'; END IF;

  SELECT m.inbox_id, a.file_id INTO v_inbox, v_current
  FROM communications.attachments a
  JOIN communications.messages m ON m.id = a.message_id
  WHERE a.id = p_attachment_id AND a.uploaded_at IS NULL AND a.skipped_reason IS NULL
  FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_ATTACHMENT_NOT_PENDING: %', p_attachment_id USING ERRCODE = 'P0002'; END IF;

  IF v_current IS NOT NULL THEN
    SELECT * INTO v_file FROM communications.files WHERE id = v_current AND sha256 = p_sha256 FOR UPDATE;
  END IF;
  IF v_file.id IS NULL THEN
    SELECT * INTO v_file FROM communications.files
    WHERE inbox_id = v_inbox AND sha256 = p_sha256 AND deleting_at IS NULL
    FOR UPDATE;
  END IF;
  IF v_file.id IS NULL THEN
    -- Two emails with the same new file: one insert wins, the other waits for it and takes it.
    INSERT INTO communications.files (id, inbox_id, sha256, size_bytes, storage_path)
    SELECT n.id, v_inbox, p_sha256, p_size_bytes, v_inbox::text || '/files/' || n.id::text
    FROM (SELECT gen_random_uuid() AS id) n
    ON CONFLICT (inbox_id, sha256) WHERE deleting_at IS NULL DO NOTHING;
    SELECT * INTO v_file FROM communications.files
    WHERE inbox_id = v_inbox AND sha256 = p_sha256 AND deleting_at IS NULL
    FOR UPDATE;
  END IF;

  UPDATE communications.attachments SET file_id = v_file.id WHERE id = p_attachment_id;
  RETURN jsonb_build_object('file_id', v_file.id, 'storage_path', v_file.storage_path, 'stored', v_file.stored_at IS NOT NULL);
END;
$$;

-- Ingestion, once the copy's bytes are in the bucket (uploaded now, or there
-- already): the copy is stored, and so is the attachment, at the copy's path.
CREATE OR REPLACE FUNCTION communications.file_stored(p_attachment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  UPDATE communications.files f SET stored_at = COALESCE(f.stored_at, now())
  FROM communications.attachments a
  WHERE a.id = p_attachment_id AND f.id = a.file_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_FILE_NOT_CLAIMED: %', p_attachment_id USING ERRCODE = 'P0002'; END IF;
  UPDATE communications.attachments a
  SET storage_path = f.storage_path, sha256 = f.sha256, size_bytes = f.size_bytes, uploaded_at = COALESCE(a.uploaded_at, now())
  FROM communications.files f
  WHERE a.id = p_attachment_id AND f.id = a.file_id;
END;
$$;

-- Retention, after deleting messages: stored copies no attachment points at
-- any more. Each is locked, then re-checked (a fresh look, so an email that
-- just claimed it keeps it), then marked deleting: never reused from then
-- on. Returns those and any left marked by an earlier run, for their bytes
-- to be removed; files_forget drops the rows once they are.
CREATE OR REPLACE FUNCTION communications.files_release(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
  v_id uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  FOR v_id IN
    SELECT f.id FROM communications.files f
    WHERE f.deleting_at IS NULL AND NOT EXISTS (SELECT 1 FROM communications.attachments a WHERE a.file_id = f.id)
    ORDER BY f.created_at, f.id
    LIMIT v_limit
  LOOP
    PERFORM 1 FROM communications.files WHERE id = v_id AND deleting_at IS NULL FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    UPDATE communications.files SET deleting_at = now()
    WHERE id = v_id AND NOT EXISTS (SELECT 1 FROM communications.attachments a WHERE a.file_id = v_id);
  END LOOP;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'path', d.storage_path) ORDER BY d.deleting_at, d.id), '[]'::jsonb)
    FROM (
      SELECT id, storage_path, deleting_at FROM communications.files
      WHERE deleting_at IS NOT NULL ORDER BY deleting_at, id LIMIT v_limit
    ) d
  );
END;
$$;

-- Retention, once released copies' bytes are removed from the bucket: their
-- rows. Never one something points at.
CREATE OR REPLACE FUNCTION communications.files_forget(p_ids jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  DELETE FROM communications.files f
  WHERE f.id IN (SELECT (value)::uuid FROM jsonb_array_elements_text(COALESCE(p_ids, '[]'::jsonb)))
    AND f.deleting_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM communications.attachments a WHERE a.file_id = f.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- One triage on a single project, as callers of the single-project API send
-- it (record_triage with p_project_ids files on several): the triage row, its
-- task links and the message status, and the thread's project when the agent
-- chose one for a thread without it. With an idempotency key already used on
-- this email it changes nothing: the same request hash returns the first
-- triage (replayed), another one is refused.
CREATE OR REPLACE FUNCTION communications.record_triage(
  p_message_id uuid,
  p_member_id uuid,
  p_triage jsonb,
  p_links jsonb,
  p_project_id uuid,
  p_status text,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_triage communications.triage;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('handled', 'needs_human') THEN RAISE EXCEPTION 'record_triage: invalid status' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status = 'receiving' THEN
    RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002';
  END IF;

  -- The message row lock above serializes retries of one key.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_triage FROM communications.triage
    WHERE message_id = p_message_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_triage.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'EMAIL_IDEMPOTENCY_CONFLICT: this idempotency key was used for a different triage of message %', p_message_id USING ERRCODE = 'P0001';
      END IF;
      RETURN jsonb_build_object(
        'triage', to_jsonb(v_triage) - 'request_hash',
        'status', v_message.status,
        'thread', (SELECT jsonb_build_object('id', t.id, 'project_id', t.project_id, 'project_source', t.project_source)
                   FROM communications.conversations t WHERE t.id = v_message.thread_id),
        'replayed', true
      );
    END IF;
  END IF;

  -- person: someone answered the agent's question on this thread, so the
  -- project is the one that answer named; inferred: chosen among the
  -- message's mapping candidates; guessed: the message had none, so nothing
  -- in it matched a project.
  IF p_project_id IS NOT NULL THEN
    PERFORM 1 FROM communications.conversations WHERE id = v_message.thread_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM communications.conversation_projects WHERE conversation_id = v_message.thread_id) THEN
      INSERT INTO communications.conversation_projects (conversation_id, project_id, source, message_id, added_by)
      VALUES (
        v_message.thread_id, p_project_id,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM communications.answers a
            JOIN communications.messages m ON m.id = a.message_id
            WHERE m.thread_id = v_message.thread_id
          ) THEN 'person'
          WHEN EXISTS (SELECT 1 FROM communications.message_candidates c WHERE c.message_id = p_message_id) THEN 'inferred'
          ELSE 'guessed' END,
        p_message_id, p_member_id
      );
    ELSIF NOT EXISTS (
      SELECT 1 FROM communications.conversation_projects WHERE conversation_id = v_message.thread_id AND project_id = p_project_id
    ) THEN
      RAISE EXCEPTION 'EMAIL_THREAD_PROJECT_SET: the thread already belongs to another project' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO communications.triage (
    message_id, member_id, outcome, urgent, summary, question_for_human, suggested_reply, project_id, idempotency_key, request_hash
  )
  VALUES (
    p_message_id, p_member_id, p_triage->>'outcome', COALESCE((p_triage->>'urgent')::boolean, false),
    p_triage->>'summary', p_triage->>'question_for_human', p_triage->>'suggested_reply', p_project_id,
    p_idempotency_key, p_request_hash
  )
  RETURNING * INTO v_triage;

  INSERT INTO communications.task_links (message_id, task_id, relation, triage_id, linked_by)
  SELECT p_message_id, (l->>'task_id')::uuid, l->>'relation', v_triage.id, p_member_id
  FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) AS l
  ON CONFLICT (message_id, task_id, relation) DO NOTHING;

  UPDATE communications.messages SET status = p_status WHERE id = p_message_id;

  IF NULLIF(btrim(COALESCE(p_triage->>'thread_summary', '')), '') IS NOT NULL THEN
    UPDATE communications.conversations
    SET summary = left(btrim(p_triage->>'thread_summary'), 300), summary_at = now()
    WHERE id = v_message.thread_id;
  END IF;

  RETURN jsonb_build_object(
    'triage', to_jsonb(v_triage) - 'request_hash',
    'status', p_status,
    'thread', (SELECT jsonb_build_object('id', t.id, 'project_id', t.project_id, 'project_source', t.project_source)
               FROM communications.conversations t WHERE t.id = v_message.thread_id),
    'replayed', false
  );
END;
$$;

-- For the host dispatcher: is there new mail, and is anything waiting for
-- the batched summary. p_inbox_ids is a JSON array of inbox ids.
CREATE OR REPLACE FUNCTION communications.signal(p_inbox_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb)))
  SELECT jsonb_build_object(
    'new_count', (SELECT count(*) FROM communications.messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'newest_received_at', (SELECT max(m.received_at) FROM communications.messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'unsummarized_count', (
      SELECT count(DISTINCT t.message_id) FROM communications.triage t
      JOIN communications.messages m ON m.id = t.message_id
      WHERE m.inbox_id IN (SELECT id FROM inboxes) AND t.summarized_at IS NULL
    ),
    'drafts_requested', (
      SELECT count(*) FROM communications.reply_drafts d
      JOIN communications.messages m ON m.id = d.message_id
      WHERE m.inbox_id IN (SELECT id FROM inboxes) AND d.status = 'requested'
    )
  ));
END;
$$;

-- Marks triage rows as summarized, with any older unsummarized triage of the
-- same messages (superseded, latest wins). All or nothing: an id outside
-- p_inbox_ids marks nothing and comes back in `missing`.
CREATE OR REPLACE FUNCTION communications.mark_triage_summarized(p_triage_ids jsonb, p_inbox_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_ids uuid[] := ARRAY(SELECT DISTINCT (value)::uuid FROM jsonb_array_elements_text(COALESCE(p_triage_ids, '[]'::jsonb)));
  v_inboxes uuid[] := ARRAY(SELECT (value)::uuid FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb)));
  v_missing jsonb;
  v_marked integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_agg(i), '[]'::jsonb) INTO v_missing
  FROM unnest(v_ids) AS i
  WHERE NOT EXISTS (
    SELECT 1 FROM communications.triage t JOIN communications.messages m ON m.id = t.message_id
    WHERE t.id = i AND m.inbox_id = ANY(v_inboxes)
  );
  IF jsonb_array_length(v_missing) > 0 THEN
    RETURN jsonb_build_object('marked', 0, 'missing', v_missing);
  END IF;

  WITH chosen AS (SELECT id, message_id, created_at FROM communications.triage WHERE id = ANY(v_ids)),
  marked AS (
    UPDATE communications.triage t SET summarized_at = now()
    WHERE t.summarized_at IS NULL AND (
      t.id = ANY(v_ids)
      OR EXISTS (SELECT 1 FROM chosen c WHERE c.message_id = t.message_id AND t.created_at <= c.created_at)
    )
    RETURNING t.id
  )
  SELECT count(*) INTO v_marked FROM marked;
  RETURN jsonb_build_object('marked', v_marked, 'missing', '[]'::jsonb);
END;
$$;

-- A person files a conversation on a project, as their choice, beside the
-- projects it already has (taking one off is remove_conversation_project,
-- with its checks). p_only_if_none files it only when the conversation has no
-- project yet. Returns whether it filed it.
CREATE OR REPLACE FUNCTION communications.set_conversation_project(
  p_conversation_id uuid,
  p_project_id uuid,
  p_member_id uuid,
  p_only_if_none boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM communications.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: conversation %', p_conversation_id USING ERRCODE = 'P0002'; END IF;
  IF p_only_if_none AND EXISTS (SELECT 1 FROM communications.conversation_projects WHERE conversation_id = p_conversation_id) THEN
    RETURN false;
  END IF;
  INSERT INTO communications.conversation_projects (conversation_id, project_id, source, added_by)
  VALUES (p_conversation_id, p_project_id, 'person', p_member_id)
  ON CONFLICT (conversation_id, project_id) DO UPDATE
  SET source = 'person', endpoint_id = NULL, added_by = EXCLUDED.added_by;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION communications.set_conversation_project(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.set_conversation_project(uuid, uuid, uuid, boolean) TO service_role;

-- ── A message's project scope (20261026093748_conversation_projects_scope.sql)
-- Who sent a message decides which projects it may touch; the agent decides,
-- inside that, which project each item belongs on. A message may touch:
-- - conversation: the conversation's projects (a guessed one only for a
--   verified teammate: a client's reply never rides on the agent's guess);
-- - endpoint: the project of each project address it came through (address);
-- - mapped: its sender's mapping candidates (mapped when there is one, else inferred);
-- - team: any project taking mail, when a verified teammate wrote or forwarded it (guessed);
-- - meeting notes: any project taking mail, for verified meeting notes (guessed);
-- - answered: any project taking mail, when a person answered the agent's
--   question on this very email (person: the answer named it).
-- Nothing else: an unmapped stranger touches nothing until a person answers.

-- Open for new mail: live, active and not archived. A project already on a
-- conversation stays reachable from it whatever its state.
CREATE OR REPLACE FUNCTION communications.project_accepts_messages(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = p_project_id AND deleted_at IS NULL AND archived_at IS NULL AND status = 'active'
  )
$$;

-- The stronger of two sources (a person's word first, a guess last).
CREATE OR REPLACE FUNCTION communications.stronger_source(p_a text, p_b text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_a IS NULL THEN p_b
    WHEN p_b IS NULL THEN p_a
    WHEN communications.project_source_rank(p_b) < communications.project_source_rank(p_a) THEN p_b
    ELSE p_a END
$$;

-- Whether a message may touch a project, and as what: the source it files
-- the project with, or null when it may not.
CREATE OR REPLACE FUNCTION communications.scope_source(p_message_id uuid, p_project_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_best text;
  v_existing text;
  v_candidates integer;
BEGIN
  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id;
  IF NOT FOUND OR p_project_id IS NULL OR v_message.thread_id IS NULL THEN RETURN NULL; END IF;

  SELECT source INTO v_existing FROM communications.conversation_projects
  WHERE conversation_id = v_message.thread_id AND project_id = p_project_id;
  IF v_existing IS NOT NULL AND (v_existing <> 'guessed' OR v_message.sender_member_id IS NOT NULL) THEN
    v_best := v_existing;
  END IF;
  IF NOT communications.project_accepts_messages(p_project_id) THEN RETURN v_best; END IF;

  IF EXISTS (
    SELECT 1 FROM communications.message_endpoints me
    JOIN communications.endpoints e ON e.id = me.endpoint_id
    WHERE me.message_id = p_message_id AND e.project_id = p_project_id
  ) THEN
    v_best := communications.stronger_source(v_best, 'address');
  END IF;
  IF EXISTS (SELECT 1 FROM communications.message_candidates WHERE message_id = p_message_id AND project_id = p_project_id) THEN
    SELECT count(DISTINCT project_id) INTO v_candidates FROM communications.message_candidates WHERE message_id = p_message_id;
    v_best := communications.stronger_source(v_best, CASE WHEN v_candidates = 1 THEN 'mapped' ELSE 'inferred' END);
  END IF;
  -- A person answered the agent's question on this very email.
  IF EXISTS (SELECT 1 FROM communications.answers a WHERE a.message_id = p_message_id) THEN
    v_best := communications.stronger_source(v_best, 'person');
  END IF;
  IF v_message.sender_member_id IS NOT NULL OR (v_message.kind = 'meeting_notes' AND v_message.sender_verified) THEN
    v_best := communications.stronger_source(v_best, 'guessed');
  END IF;
  RETURN v_best;
END;
$$;

-- The scope as the agent reads it: the projects the message may touch by
-- name, and whether it may touch any project taking mail (and as what).
-- { bases: [conversation|endpoint|mapped|team|meeting_notes|answered],
--   projects: [{ project_id, source }], any_project: bool, any_source: person|guessed|null }
CREATE OR REPLACE FUNCTION communications.message_scope(p_message_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_bases text[] := '{}';
  v_answered boolean;
  v_team boolean;
  v_notes boolean;
BEGIN
  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id;
  IF NOT FOUND OR v_message.thread_id IS NULL THEN
    RETURN jsonb_build_object('bases', '[]'::jsonb, 'projects', '[]'::jsonb, 'any_project', false, 'any_source', NULL);
  END IF;
  v_answered := EXISTS (SELECT 1 FROM communications.answers a WHERE a.message_id = p_message_id);
  v_team := v_message.sender_member_id IS NOT NULL;
  v_notes := v_message.kind = 'meeting_notes' AND v_message.sender_verified;
  IF EXISTS (
    SELECT 1 FROM communications.conversation_projects
    WHERE conversation_id = v_message.thread_id AND (source <> 'guessed' OR v_team)
  ) THEN v_bases := array_append(v_bases, 'conversation'); END IF;
  IF EXISTS (SELECT 1 FROM communications.message_endpoints WHERE message_id = p_message_id) THEN v_bases := array_append(v_bases, 'endpoint'); END IF;
  IF EXISTS (SELECT 1 FROM communications.message_candidates WHERE message_id = p_message_id) THEN v_bases := array_append(v_bases, 'mapped'); END IF;
  IF v_team THEN v_bases := array_append(v_bases, 'team'); END IF;
  IF v_notes THEN v_bases := array_append(v_bases, 'meeting_notes'); END IF;
  IF v_answered THEN v_bases := array_append(v_bases, 'answered'); END IF;
  RETURN jsonb_build_object(
    'bases', to_jsonb(v_bases),
    'projects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('project_id', x.project_id, 'source', x.source) ORDER BY x.project_id)
      FROM (
        SELECT p.project_id, communications.scope_source(p_message_id, p.project_id) AS source
        FROM (
          SELECT project_id FROM communications.conversation_projects WHERE conversation_id = v_message.thread_id
          UNION SELECT e.project_id FROM communications.message_endpoints me
            JOIN communications.endpoints e ON e.id = me.endpoint_id WHERE me.message_id = p_message_id
          UNION SELECT project_id FROM communications.message_candidates WHERE message_id = p_message_id
        ) p
      ) x
      WHERE x.source IS NOT NULL
    ), '[]'::jsonb),
    'any_project', v_answered OR v_team OR v_notes,
    'any_source', CASE WHEN v_answered THEN 'person' WHEN v_team OR v_notes THEN 'guessed' END
  );
END;
$$;

-- Files a project on the message's conversation as its scope allows (an
-- existing project keeps the stronger source). Raises
-- EMAIL_PROJECT_OUT_OF_SCOPE when the message may not touch it. p_as_person:
-- a person did it, so it is in scope and recorded as person. Locks the
-- conversation, as record_triage does, so filings on one conversation run in
-- turn.
CREATE OR REPLACE FUNCTION communications.file_message_project(
  p_message_id uuid,
  p_project_id uuid,
  p_member_id uuid,
  p_as_person boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_thread uuid;
  v_source text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT thread_id INTO v_thread FROM communications.messages WHERE id = p_message_id AND status <> 'receiving';
  IF v_thread IS NULL THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM communications.conversations WHERE id = v_thread FOR UPDATE;
  v_source := CASE WHEN p_as_person THEN 'person' ELSE communications.scope_source(p_message_id, p_project_id) END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'EMAIL_PROJECT_OUT_OF_SCOPE: this message may not touch project %', p_project_id
      USING ERRCODE = 'P0001', DETAIL = p_project_id::text;
  END IF;
  INSERT INTO communications.conversation_projects AS cp (conversation_id, project_id, source, endpoint_id, message_id, added_by)
  VALUES (
    v_thread, p_project_id, v_source,
    CASE WHEN v_source = 'address' THEN (
      SELECT e.id FROM communications.message_endpoints me JOIN communications.endpoints e ON e.id = me.endpoint_id
      WHERE me.message_id = p_message_id AND e.project_id = p_project_id ORDER BY e.created_at LIMIT 1
    ) END,
    p_message_id, p_member_id
  )
  ON CONFLICT (conversation_id, project_id) DO UPDATE
  SET source = EXCLUDED.source, endpoint_id = EXCLUDED.endpoint_id, message_id = EXCLUDED.message_id, added_by = EXCLUDED.added_by
  WHERE communications.project_source_rank(EXCLUDED.source) < communications.project_source_rank(cp.source);
  RETURN (SELECT source FROM communications.conversation_projects WHERE conversation_id = v_thread AND project_id = p_project_id);
END;
$$;

-- Links a task to a message (a person's link, or an agent's before its
-- triage), filing the task's project on the conversation as the scope allows.
CREATE OR REPLACE FUNCTION communications.link_message_task(
  p_message_id uuid,
  p_task_id uuid,
  p_relation text,
  p_member_id uuid,
  p_as_person boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_project uuid;
  v_source text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_relation NOT IN ('created', 'updated', 'related') THEN RAISE EXCEPTION 'link_message_task: invalid relation' USING ERRCODE = '22023'; END IF;
  SELECT project_id INTO v_project FROM public.tasks WHERE id = p_task_id AND deleted_at IS NULL;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'EMAIL_LINK_TASK_NOT_FOUND: task %', p_task_id USING ERRCODE = 'P0001', DETAIL = p_task_id::text;
  END IF;
  PERFORM 1 FROM communications.messages WHERE id = p_message_id FOR UPDATE;
  v_source := communications.file_message_project(p_message_id, v_project, p_member_id, p_as_person);
  INSERT INTO communications.task_links (message_id, task_id, relation, triage_id, linked_by)
  VALUES (p_message_id, p_task_id, p_relation, NULL, p_member_id)
  ON CONFLICT (message_id, task_id, relation) DO NOTHING;
  RETURN jsonb_build_object('task_id', p_task_id, 'project_id', v_project, 'source', v_source);
END;
$$;

-- One triage, filed on any number of projects: the ones it names
-- (p_project_ids) and those of the tasks it links, each in the message's
-- scope (else EMAIL_PROJECT_OUT_OF_SCOPE, and nothing is written). With an
-- idempotency key already used on this email it changes nothing: the same
-- request hash returns the first triage (replayed), another one is refused.
CREATE OR REPLACE FUNCTION communications.record_triage(
  p_message_id uuid,
  p_member_id uuid,
  p_triage jsonb,
  p_links jsonb,
  p_project_ids uuid[],
  p_status text,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_triage communications.triage;
  v_projects uuid[];
  v_project uuid;
  v_link jsonb;
  v_task_project uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('handled', 'needs_human', 'ignored') THEN RAISE EXCEPTION 'record_triage: invalid status' USING ERRCODE = '22023'; END IF;
  -- A triage filters only what it read as outreach.
  IF p_status = 'ignored' AND p_triage->>'category' IS DISTINCT FROM 'outreach' THEN
    RAISE EXCEPTION 'record_triage: only outreach is filtered' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status = 'receiving' THEN
    RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002';
  END IF;

  -- The message row lock above serializes retries of one key.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_triage FROM communications.triage
    WHERE message_id = p_message_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_triage.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'EMAIL_IDEMPOTENCY_CONFLICT: this idempotency key was used for a different triage of message %', p_message_id USING ERRCODE = 'P0001';
      END IF;
      RETURN jsonb_build_object(
        'triage', to_jsonb(v_triage) - 'request_hash',
        'status', v_message.status,
        'thread', communications.conversation_projects_json(v_message.thread_id),
        'replayed', true
      );
    END IF;
  END IF;

  -- Every project it files on: the named ones, then each linked task's.
  v_projects := COALESCE(p_project_ids, '{}');
  FOR v_link IN SELECT value FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) LOOP
    SELECT project_id INTO v_task_project FROM public.tasks WHERE id = (v_link->>'task_id')::uuid AND deleted_at IS NULL;
    IF v_task_project IS NULL THEN
      RAISE EXCEPTION 'EMAIL_LINK_TASK_NOT_FOUND: task %', v_link->>'task_id' USING ERRCODE = 'P0001', DETAIL = v_link->>'task_id';
    END IF;
    IF NOT v_task_project = ANY(v_projects) THEN v_projects := v_projects || v_task_project; END IF;
  END LOOP;
  v_projects := ARRAY(SELECT DISTINCT x FROM unnest(v_projects) AS x ORDER BY x);

  PERFORM 1 FROM communications.conversations WHERE id = v_message.thread_id FOR UPDATE;
  FOREACH v_project IN ARRAY v_projects LOOP
    PERFORM communications.file_message_project(p_message_id, v_project, p_member_id);
  END LOOP;

  INSERT INTO communications.triage (
    message_id, member_id, outcome, urgent, summary, question_for_human, suggested_reply, project_id, project_ids,
    idempotency_key, request_hash, category
  )
  VALUES (
    p_message_id, p_member_id, p_triage->>'outcome', COALESCE((p_triage->>'urgent')::boolean, false),
    p_triage->>'summary', p_triage->>'question_for_human', p_triage->>'suggested_reply',
    CASE WHEN cardinality(v_projects) = 1 THEN v_projects[1] END, v_projects,
    p_idempotency_key, p_request_hash, p_triage->>'category'
  )
  RETURNING * INTO v_triage;

  INSERT INTO communications.task_links (message_id, task_id, relation, triage_id, linked_by)
  SELECT p_message_id, (l->>'task_id')::uuid, l->>'relation', v_triage.id, p_member_id
  FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) AS l
  ON CONFLICT (message_id, task_id, relation) DO NOTHING;

  UPDATE communications.messages SET status = p_status WHERE id = p_message_id;

  IF NULLIF(btrim(COALESCE(p_triage->>'thread_summary', '')), '') IS NOT NULL THEN
    UPDATE communications.conversations
    SET summary = left(btrim(p_triage->>'thread_summary'), 300), summary_at = now()
    WHERE id = v_message.thread_id;
  END IF;

  RETURN jsonb_build_object(
    'triage', to_jsonb(v_triage) - 'request_hash',
    'status', p_status,
    'thread', communications.conversation_projects_json(v_message.thread_id),
    'replayed', false
  );
END;
$$;

-- A conversation's id with its strongest project (project_id,
-- project_source, as older readers know it) and every project it is filed on.
CREATE OR REPLACE FUNCTION communications.conversation_projects_json(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'project_id', c.project_id, 'project_source', c.project_source,
    'projects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('project_id', p.project_id, 'source', p.source)
        ORDER BY communications.project_source_rank(p.source), p.created_at, p.project_id)
      FROM communications.conversation_projects p WHERE p.conversation_id = c.id
    ), '[]'::jsonb)
  )
  FROM communications.conversations c WHERE c.id = p_conversation_id
$$;

-- A person adds a project to a conversation, or confirms one the agent
-- guessed: it is theirs from here on (person), the others stay.
CREATE OR REPLACE FUNCTION communications.add_conversation_project(p_conversation_id uuid, p_project_id uuid, p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM communications.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: conversation %', p_conversation_id USING ERRCODE = 'P0002'; END IF;
  INSERT INTO communications.conversation_projects (conversation_id, project_id, source, added_by)
  VALUES (p_conversation_id, p_project_id, 'person', p_member_id)
  ON CONFLICT (conversation_id, project_id) DO UPDATE
  SET source = 'person', endpoint_id = NULL, added_by = EXCLUDED.added_by;
END;
$$;

-- A person takes a project off a conversation. Refused
-- (EMAIL_PROJECT_HAS_TASKS) while one of its emails is linked to a task on
-- that project: unlink or move the task first.
CREATE OR REPLACE FUNCTION communications.remove_conversation_project(p_conversation_id uuid, p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM communications.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM communications.task_links k
    JOIN communications.messages m ON m.id = k.message_id
    JOIN public.tasks t ON t.id = k.task_id
    WHERE m.thread_id = p_conversation_id AND t.project_id = p_project_id AND t.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'EMAIL_PROJECT_HAS_TASKS: a task on that project is linked to this conversation' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM communications.conversation_projects WHERE conversation_id = p_conversation_id AND project_id = p_project_id;
  RETURN FOUND;
END;
$$;

-- A message's delivery and audience, from its recipients.
CREATE OR REPLACE FUNCTION communications.delivery_of(p_message_id uuid, p_forwarded boolean)
RETURNS TABLE (delivery text, audience_size integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  WITH ours AS (
    SELECT lower(address) AS address FROM communications.inboxes
    UNION SELECT lower(routing_address) FROM communications.inboxes
    UNION SELECT lower(routing_address) FROM communications.endpoints WHERE routing_address IS NOT NULL
    UNION SELECT lower(public_address) FROM communications.endpoints WHERE public_address IS NOT NULL
    UNION SELECT lower(btrim(email)) FROM public.team_members WHERE email IS NOT NULL AND btrim(email) <> ''
  ),
  recipients AS (
    SELECT p.kind, p.address,
      (p.address IN (SELECT address FROM ours)
        OR split_part(p.address, '@', 2) IN (SELECT domain FROM communications.own_domains)) IS TRUE AS is_ours
    FROM communications.participants p
    WHERE p.message_id = p_message_id AND p.kind IN ('to', 'cc')
  )
  SELECT
    CASE
      WHEN m.auto_mail_reason IS NOT NULL THEN 'broadcast'
      WHEN p_forwarded THEN 'forwarded'
      WHEN EXISTS (SELECT 1 FROM recipients WHERE kind = 'to' AND is_ours) THEN
        CASE WHEN (SELECT count(DISTINCT address) FROM recipients WHERE NOT is_ours) >= 3 THEN 'group' ELSE 'direct' END
      WHEN EXISTS (SELECT 1 FROM recipients WHERE kind = 'cc' AND is_ours) THEN 'cc'
      ELSE 'bcc'
    END,
    (SELECT count(DISTINCT address)::integer FROM recipients)
  FROM communications.messages m
  WHERE m.id = p_message_id
$$;

-- Records a message's delivery (ingest, once its recipients are stored).
CREATE OR REPLACE FUNCTION communications.set_message_delivery(p_message_id uuid, p_forwarded boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v record;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v FROM communications.delivery_of(p_message_id, p_forwarded);
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE communications.messages SET delivery = v.delivery, audience_size = v.audience_size WHERE id = p_message_id;
  RETURN v.delivery;
END;
$$;

REVOKE ALL ON FUNCTION communications.delivery_of(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.set_message_delivery(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.delivery_of(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION communications.set_message_delivery(uuid, boolean) TO service_role;

REVOKE ALL ON FUNCTION communications.add_conversation_project(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.remove_conversation_project(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.add_conversation_project(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.remove_conversation_project(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION communications.project_accepts_messages(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.scope_source(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.message_scope(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.file_message_project(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.link_message_task(uuid, uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.record_triage(uuid, uuid, jsonb, jsonb, uuid[], text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.conversation_projects_json(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.project_accepts_messages(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.scope_source(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.message_scope(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.file_message_project(uuid, uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION communications.link_message_task(uuid, uuid, text, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION communications.record_triage(uuid, uuid, jsonb, jsonb, uuid[], text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION communications.conversation_projects_json(uuid) TO service_role;
REVOKE ALL ON FUNCTION communications.email_start_message(uuid, jsonb, jsonb, jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.email_complete_message(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.files_failed(uuid, jsonb, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.signal(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.mark_triage_summarized(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.email_start_message(uuid, jsonb, jsonb, jsonb, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION communications.email_complete_message(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.files_failed(uuid, jsonb, boolean, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION communications.claim_file(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.file_stored(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.files_release(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.files_forget(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.claim_file(uuid, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION communications.file_stored(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.files_release(integer) TO service_role;
GRANT EXECUTE ON FUNCTION communications.files_forget(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION communications.signal(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.mark_triage_summarized(jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.sync_contact_email_mirror(uuid) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 7. Row level security (people in the app; agents use the service client)
-- ============================================================

-- inbound_email.manage sees every inbox; inbound_email.read sees the inboxes
-- the member was granted.
CREATE OR REPLACE FUNCTION communications.can_read_inbox(p_inbox_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT public.has_permission('inbound_email.manage', 'app')
    OR (
      public.has_permission('inbound_email.read', 'app')
      AND EXISTS (
        SELECT 1 FROM communications.inbox_access a
        WHERE a.inbox_id = p_inbox_id AND a.member_id = public.current_team_member_id()
      )
    )
$$;

CREATE OR REPLACE FUNCTION communications.can_read_message(p_message_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM communications.messages m
    WHERE m.id = p_message_id AND communications.can_read_inbox(m.inbox_id)
  )
$$;

REVOKE ALL ON FUNCTION communications.can_read_inbox(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION communications.can_read_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION communications.can_read_inbox(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION communications.can_read_message(uuid) TO authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA communications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA communications TO authenticated;

ALTER TABLE public.contact_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.inbox_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.client_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.client_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.message_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON communications.files FROM anon, authenticated;
GRANT ALL ON communications.files TO service_role;
ALTER TABLE communications.triage ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.task_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.sender_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.reply_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.conversation_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.message_endpoints ENABLE ROW LEVEL SECURITY;

-- contact_emails mirrors contacts.
CREATE POLICY contact_emails_select ON public.contact_emails FOR SELECT TO authenticated
  USING (public.has_permission('contacts.read_all') OR (
    public.has_permission('contacts.read') AND EXISTS (
      SELECT 1 FROM public.project_contacts pc
      WHERE pc.contact_id = contact_emails.contact_id AND public.can_access_project(pc.project_id)
    )
  ));
CREATE POLICY contact_emails_manage ON public.contact_emails FOR ALL TO authenticated
  USING (public.has_permission('contacts.manage')) WITH CHECK (public.has_permission('contacts.manage'));

CREATE POLICY email_inboxes_select ON communications.inboxes FOR SELECT TO authenticated
  USING (communications.can_read_inbox(id));
CREATE POLICY email_inboxes_manage ON communications.inboxes FOR ALL TO authenticated
  USING (public.has_permission('inbound_email.manage')) WITH CHECK (public.has_permission('inbound_email.manage'));

CREATE POLICY email_inbox_access_select ON communications.inbox_access FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.manage') OR member_id = public.current_team_member_id());
CREATE POLICY email_inbox_access_manage ON communications.inbox_access FOR ALL TO authenticated
  USING (public.has_permission('inbound_email.manage')) WITH CHECK (public.has_permission('inbound_email.manage'));

CREATE POLICY email_client_domains_select ON communications.client_domains FOR SELECT TO authenticated
  USING (public.can_access_project(project_id) AND (
    public.has_permission('contacts.read') OR public.has_permission('inbound_email.read')
  ));
CREATE POLICY email_client_domains_manage ON communications.client_domains FOR ALL TO authenticated
  USING ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id))
  WITH CHECK ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id));

CREATE POLICY email_client_addresses_select ON communications.client_addresses FOR SELECT TO authenticated
  USING (public.can_access_project(project_id) AND (
    public.has_permission('contacts.read') OR public.has_permission('inbound_email.read')
  ));
CREATE POLICY email_client_addresses_manage ON communications.client_addresses FOR ALL TO authenticated
  USING ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id))
  WITH CHECK ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id));

-- An address with no project is the inbox team's to read and manage.
CREATE POLICY email_project_addresses_select ON communications.endpoints FOR SELECT TO authenticated
  USING (
    (project_id IS NULL AND (public.has_permission('inbound_email.read') OR public.has_permission('inbound_email.manage')))
    OR (public.can_access_project(project_id) AND (public.has_permission('contacts.read') OR public.has_permission('inbound_email.read')))
  );
CREATE POLICY email_project_addresses_manage ON communications.endpoints FOR ALL TO authenticated
  USING (
    (project_id IS NULL AND public.has_permission('inbound_email.manage'))
    OR ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id))
  )
  WITH CHECK (
    (project_id IS NULL AND public.has_permission('inbound_email.manage'))
    OR ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id))
  );

CREATE POLICY email_threads_select ON communications.conversations FOR SELECT TO authenticated
  USING (communications.can_read_inbox(inbox_id));
CREATE POLICY email_messages_select ON communications.messages FOR SELECT TO authenticated
  USING (communications.can_read_inbox(inbox_id));
CREATE POLICY email_message_recipients_select ON communications.participants FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_message_candidates_select ON communications.message_candidates FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_attachments_select ON communications.attachments FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_triage_select ON communications.triage FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_task_links_select ON communications.task_links FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_sender_rules_select ON communications.sender_rules FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.read') OR public.has_permission('inbound_email.manage'));
CREATE POLICY email_reply_drafts_select ON communications.reply_drafts FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_question_answers_select ON communications.answers FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY conversation_projects_select ON communications.conversation_projects FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM communications.conversations c
    WHERE c.id = conversation_id AND communications.can_read_inbox(c.inbox_id)
  ));
CREATE POLICY message_endpoints_select ON communications.message_endpoints FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));

-- ============================================================
-- 8. Private storage bucket
-- ============================================================
-- No storage.objects policies on purpose: only the service client touches
-- it (server-side copies from the provider, and short-lived signed reads).
-- 50 MiB per object; larger raw messages and attachments are not stored.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('inbound-email', 'inbound-email', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 9. Permissions and the agent event
-- ============================================================
-- App: inbound_email.read opens the Inbox (granted inboxes), and
-- inbound_email.manage edits inbox settings and sees every inbox. API: read,
-- triage and signal, always narrowed to the key member's granted inboxes.
INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'inbound_email.read', 'app'),
  ('admin', 'inbound_email.manage', 'app'),
  ('agent', 'inbound_email.read', 'api'),
  ('agent', 'inbound_email.triage', 'api'),
  ('agent', 'inbound_email.signal', 'api')
ON CONFLICT DO NOTHING;

-- Fleet host alerts (20261010210652_agent_telemetry.sql): the scope the
-- dispatcher's key carries to post alerts that name no agent. No key gets it
-- automatically.
INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('agent', 'fleet_alerts.write', 'api')
ON CONFLICT DO NOTHING;

-- ============================================================
-- 11. Retention and the orphan sweep
-- ============================================================
-- Two Vercel crons (app/vercel.json) run these through the server, because
-- Supabase lets only the Storage API delete files. Retention lists what is
-- due, deletes its files, then its rows; a message whose files could not be
-- deleted keeps every row and is retried by the next run. Tasks are never
-- touched: an email's task links go with it, the tasks stay.

-- The last run of each job, for the inbox settings status.
CREATE TABLE communications.maintenance_runs (
  kind text PRIMARY KEY CHECK (kind IN ('retention', 'orphan_sweep')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  -- complete: nothing failed and nothing due was left; partial: something
  -- failed or the run stopped at its budget (more_pending); failed: the run
  -- itself broke (last_error).
  outcome text NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed')),
  more_pending boolean NOT NULL DEFAULT false,
  -- Retention: messages past their inbox's retention_days, and messages
  -- stuck in receiving for over 24 hours.
  messages_deleted integer NOT NULL DEFAULT 0 CHECK (messages_deleted >= 0),
  stuck_deleted integer NOT NULL DEFAULT 0 CHECK (stuck_deleted >= 0),
  threads_deleted integer NOT NULL DEFAULT 0 CHECK (threads_deleted >= 0),
  -- Objects removed from the bucket (retention: the messages' files; sweep: orphans).
  files_deleted integer NOT NULL DEFAULT 0 CHECK (files_deleted >= 0),
  -- Sweep: objects listed in the bucket.
  objects_scanned integer NOT NULL DEFAULT 0 CHECK (objects_scanned >= 0),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000)
);

ALTER TABLE communications.maintenance_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_maintenance_runs_select ON communications.maintenance_runs FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.manage'));

-- Tables added to this schema from here on are read-only for signed-in
-- members unless their migration grants more.
ALTER DEFAULT PRIVILEGES IN SCHEMA communications REVOKE INSERT, UPDATE, DELETE ON TABLES FROM authenticated;

-- ---------------------------------------------------------------------------
-- Triage plans (20261026200925_triage_plans.sql): what the agent made of a
-- message, item by item, and what the app did with each (apply, apply unsure,
-- propose, reject). Shadow plans apply nothing. reply_points: what someone is
-- waiting on Ciaran (or the agent) for, kept per conversation.
-- ---------------------------------------------------------------------------
CREATE TABLE communications.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES communications.conversations(id) ON DELETE CASCADE,
  -- The agent that made it.
  member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  mode text NOT NULL CONSTRAINT plans_mode_check CHECK (mode IN ('live', 'shadow')),
  status text NOT NULL DEFAULT 'applying' CONSTRAINT plans_status_check
    CHECK (status IN ('applying', 'applied', 'partial', 'undone')),
  summary text NOT NULL CONSTRAINT plans_summary_check CHECK (length(summary) BETWEEN 1 AND 4000),
  thread_summary text CONSTRAINT plans_thread_summary_check CHECK (thread_summary IS NULL OR length(thread_summary) <= 300),
  urgent boolean NOT NULL DEFAULT false,
  -- Every item proposes: the message looks like an attack or an impostor.
  suspicious boolean NOT NULL DEFAULT false,
  -- What the agent noticed: context_incomplete (it answers something the
  -- agent never saw), content_unreadable (only a link or file it cannot read).
  flags text[] NOT NULL DEFAULT '{}'
    CONSTRAINT plans_flags_check CHECK (flags <@ ARRAY['context_incomplete', 'content_unreadable']::text[]),
  -- The triage row a live plan records (summary feed, questions, answers).
  triage_id uuid REFERENCES communications.triage(id) ON DELETE SET NULL,
  idempotency_key text CONSTRAINT plans_idempotency_key_check CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_key_has_hash CHECK (idempotency_key IS NULL OR request_hash IS NOT NULL)
);
CREATE INDEX idx_plans_message ON communications.plans (message_id, created_at DESC);
CREATE INDEX idx_plans_conversation ON communications.plans (conversation_id, created_at DESC);
CREATE UNIQUE INDEX plans_message_idempotency_key ON communications.plans (message_id, mode, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE communications.plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES communications.plans(id) ON DELETE CASCADE,
  position integer NOT NULL CONSTRAINT plan_items_position_check CHECK (position >= 0),
  -- Copies of the plan's, so per-conversation rules can be indexed.
  conversation_id uuid NOT NULL REFERENCES communications.conversations(id) ON DELETE CASCADE,
  mode text NOT NULL CONSTRAINT plan_items_mode_check CHECK (mode IN ('live', 'shadow')),
  type text NOT NULL CONSTRAINT plan_items_type_check CHECK (type IN (
    'create_task', 'update_task', 'comment', 'attach_file',
    'add_reminder', 'update_reminder', 'complete_reminder',
    'link_task', 'file_project', 'reply_owed', 'revert_item', 'mute_conversation',
    'add_context', 'propose_mapping', 'create_lead', 'log_interaction', 'ask'
  )),
  intent text NOT NULL CONSTRAINT plan_items_intent_check CHECK (intent IN (
    'new_work', 'change', 'handoff', 'waiting_on', 'commitment', 'reply_owed',
    'owner_instruction', 'new_business', 'money', 'account_risk', 'context', 'noise'
  )),
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  -- The task it acts on, or the one it created.
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  -- Who the work is aimed at.
  addressee text NOT NULL DEFAULT 'ciaran'
    CONSTRAINT plan_items_addressee_check CHECK (addressee IN ('ciaran', 'agency', 'teammate', 'client', 'other')),
  addressee_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The words (or the attachment) that justify it.
  evidence text CONSTRAINT plan_items_evidence_check CHECK (evidence IS NULL OR length(evidence) <= 1000),
  confidence text NOT NULL DEFAULT 'sure' CONSTRAINT plan_items_confidence_check CHECK (confidence IN ('sure', 'unsure')),
  decision text NOT NULL CONSTRAINT plan_items_decision_check CHECK (decision IN ('apply', 'apply_unsure', 'propose', 'reject')),
  decision_reason text CONSTRAINT plan_items_decision_reason_check CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  -- applying: being written; done: applied; failed: could not be applied;
  -- pending: a proposal waiting; accepted / dismissed / expired: a proposal
  -- resolved; undone: applied, then undone; skipped: shadow or rejected.
  state text NOT NULL CONSTRAINT plan_items_state_check CHECK (state IN (
    'applying', 'done', 'failed', 'pending', 'accepted', 'dismissed', 'expired', 'undone', 'skipped'
  )),
  -- What applying it did: ids it created, the values it replaced.
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text CONSTRAINT plan_items_error_check CHECK (error IS NULL OR length(error) <= 1000),
  resolved_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_items_plan_position_key UNIQUE (plan_id, position)
);
CREATE INDEX idx_plan_items_conversation ON communications.plan_items (conversation_id, created_at DESC);
CREATE INDEX idx_plan_items_project ON communications.plan_items (project_id, created_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX idx_plan_items_task ON communications.plan_items (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_plan_items_pending ON communications.plan_items (created_at) WHERE state = 'pending';
-- At most one question waiting per conversation.
CREATE UNIQUE INDEX plan_items_one_open_ask ON communications.plan_items (conversation_id)
  WHERE type = 'ask' AND state = 'pending' AND mode = 'live';

CREATE TABLE communications.reply_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES communications.conversations(id) ON DELETE CASCADE,
  -- The message that raised it (or last amended it).
  message_id uuid REFERENCES communications.messages(id) ON DELETE SET NULL,
  plan_item_id uuid REFERENCES communications.plan_items(id) ON DELETE SET NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  -- Who is waiting, and on what.
  who text NOT NULL CONSTRAINT reply_points_who_check CHECK (length(who) BETWEEN 1 AND 200),
  what text NOT NULL CONSTRAINT reply_points_what_check CHECK (length(what) BETWEEN 1 AND 1000),
  kind text NOT NULL CONSTRAINT reply_points_kind_check CHECK (kind IN ('info', 'decision', 'security', 'schedule')),
  -- Owed to the agent instead (a teammate asked it something); its answer, when it found one.
  to_agent boolean NOT NULL DEFAULT false,
  note text CONSTRAINT reply_points_note_check CHECK (note IS NULL OR length(note) <= 2000),
  by_when date,
  urgent boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'open' CONSTRAINT reply_points_state_check CHECK (state IN ('open', 'resolved', 'expired')),
  resolved_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reply_points_conversation ON communications.reply_points (conversation_id, created_at DESC);
CREATE INDEX idx_reply_points_open ON communications.reply_points (by_when NULLS LAST, created_at) WHERE state = 'open';

ALTER TABLE communications.triage ADD CONSTRAINT triage_plan_id_fkey
  FOREIGN KEY (plan_id) REFERENCES communications.plans(id) ON DELETE SET NULL;

CREATE TRIGGER set_plans_updated_at BEFORE UPDATE ON communications.plans
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_plan_items_updated_at BEFORE UPDATE ON communications.plan_items
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_reply_points_updated_at BEFORE UPDATE ON communications.reply_points
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Read under RLS by whoever can read the message; written only by the server.
ALTER TABLE communications.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.reply_points ENABLE ROW LEVEL SECURITY;
CREATE POLICY plans_select ON communications.plans FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY plan_items_select ON communications.plan_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM communications.plans p WHERE p.id = plan_id AND communications.can_read_message(p.message_id)));
CREATE POLICY reply_points_select ON communications.reply_points FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM communications.messages m
    WHERE m.thread_id = conversation_id AND communications.can_read_message(m.id)
  ));
REVOKE ALL ON communications.plans, communications.plan_items, communications.reply_points FROM PUBLIC, anon, authenticated;
GRANT SELECT ON communications.plans, communications.plan_items, communications.reply_points TO authenticated;
GRANT ALL ON communications.plans, communications.plan_items, communications.reply_points TO service_role;
-- Your domains and ignored addresses: written by the app's service role only.
REVOKE ALL ON communications.own_domains, communications.ignored_addresses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON communications.own_domains, communications.ignored_addresses TO authenticated;
GRANT ALL ON communications.own_domains, communications.ignored_addresses TO service_role;

-- The next batch of messages due for deletion, oldest first, with every file
-- path they own: the raw .eml and attachments stored the old way. Shared
-- copies are released after the rows go (files_release). Due: past the inbox's retention_days (any status but
-- receiving), or stuck in receiving for over 24 hours. p_exclude skips
-- messages whose files failed to delete earlier in the same run.
CREATE OR REPLACE FUNCTION communications.retention_due(p_limit integer, p_exclude jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
    WITH excluded AS (
      SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_exclude, '[]'::jsonb))
    ),
    due AS (
      SELECT m.id, m.inbox_id, m.raw_storage_path, m.status, m.received_at, m.created_at
      FROM communications.messages m
      JOIN communications.inboxes i ON i.id = m.inbox_id
      WHERE (
          (m.status <> 'receiving' AND m.received_at < now() - make_interval(days => i.retention_days))
          OR (m.status = 'receiving' AND m.created_at < now() - interval '24 hours')
        )
        AND NOT EXISTS (SELECT 1 FROM excluded x WHERE x.id = m.id)
      ORDER BY LEAST(m.received_at, m.created_at), m.id
      LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500))
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id,
      'inbox_id', d.inbox_id,
      'reason', CASE WHEN d.status = 'receiving' THEN 'stuck_receiving' ELSE 'retention' END,
      'paths', to_jsonb(
        array_remove(ARRAY[d.raw_storage_path], NULL)
        || ARRAY(SELECT a.storage_path FROM communications.attachments a
                 WHERE a.message_id = d.id AND a.storage_path IS NOT NULL AND a.file_id IS NULL ORDER BY a.position)
      )
    ) ORDER BY LEAST(d.received_at, d.created_at), d.id), '[]'::jsonb)
    FROM due d
  );
END;
$$;

-- Deletes the rows of messages whose files are already gone: attachments,
-- task links, triage, recipients, candidates, then the message, then any of
-- their threads left empty. Only messages still due are deleted (the rule of
-- retention_due; a stuck message that completed during this run still
-- goes, since its files are gone). Tasks are never touched.
CREATE OR REPLACE FUNCTION communications.retention_delete(p_message_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_requested uuid[] := ARRAY(SELECT DISTINCT (value)::uuid FROM jsonb_array_elements_text(COALESCE(p_message_ids, '[]'::jsonb)));
  v_ids uuid[];
  v_threads uuid[];
  v_thread uuid;
  v_deleted jsonb;
  v_attachments integer;
  v_threads_deleted integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;

  -- Lock first, so ingestion cannot complete one of them halfway through.
  PERFORM 1 FROM communications.messages WHERE id = ANY(v_requested) ORDER BY id FOR UPDATE;

  SELECT
    COALESCE(array_agg(m.id), '{}'),
    COALESCE(array_agg(DISTINCT m.thread_id) FILTER (WHERE m.thread_id IS NOT NULL), '{}'),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', m.id, 'inbox_id', m.inbox_id,
      'reason', CASE WHEN m.status <> 'receiving' AND m.received_at < now() - make_interval(days => i.retention_days)
                     THEN 'retention' ELSE 'stuck_receiving' END
    )), '[]'::jsonb)
  INTO v_ids, v_threads, v_deleted
  FROM communications.messages m
  JOIN communications.inboxes i ON i.id = m.inbox_id
  WHERE m.id = ANY(v_requested)
    AND (
      (m.status <> 'receiving' AND m.received_at < now() - make_interval(days => i.retention_days))
      OR (m.created_at < now() - interval '24 hours'
          AND (m.status = 'receiving' OR m.completed_at > now() - interval '15 minutes'))
    );

  DELETE FROM communications.attachments WHERE message_id = ANY(v_ids);
  GET DIAGNOSTICS v_attachments = ROW_COUNT;
  DELETE FROM communications.task_links WHERE message_id = ANY(v_ids);
  DELETE FROM communications.triage WHERE message_id = ANY(v_ids);
  DELETE FROM communications.participants WHERE message_id = ANY(v_ids);
  DELETE FROM communications.message_candidates WHERE message_id = ANY(v_ids);
  DELETE FROM communications.messages WHERE id = ANY(v_ids);

  FOREACH v_thread IN ARRAY v_threads LOOP
    BEGIN
      DELETE FROM communications.conversations t
      WHERE t.id = v_thread AND NOT EXISTS (SELECT 1 FROM communications.messages m WHERE m.thread_id = t.id);
      IF FOUND THEN v_threads_deleted := v_threads_deleted + 1; END IF;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL; -- a new message joined the thread meanwhile; it stays
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'skipped', COALESCE((SELECT jsonb_agg(r) FROM unnest(v_requested) AS r WHERE NOT (r = ANY(v_ids))), '[]'::jsonb),
    'attachments_deleted', v_attachments,
    'threads_deleted', v_threads_deleted
  );
END;
$$;

-- Of the given bucket paths, the ones a row still owns: a message's raw .eml,
-- an attachment's file, a stored copy, or anything under a message still being received
-- (created in the last 24 hours). Everything else is an orphan.
CREATE OR REPLACE FUNCTION communications.storage_known_paths(p_paths jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
    WITH given AS (
      SELECT DISTINCT value AS path FROM jsonb_array_elements_text(COALESCE(p_paths, '[]'::jsonb))
    )
    SELECT COALESCE(jsonb_agg(g.path ORDER BY g.path), '[]'::jsonb)
    FROM given g
    WHERE EXISTS (SELECT 1 FROM communications.messages m WHERE m.raw_storage_path = g.path)
      OR EXISTS (SELECT 1 FROM communications.attachments a WHERE a.storage_path = g.path)
      OR EXISTS (SELECT 1 FROM communications.files f WHERE f.storage_path = g.path)
      OR EXISTS (
        SELECT 1 FROM communications.messages m
        WHERE m.status = 'receiving'
          AND m.created_at >= now() - interval '24 hours'
          AND m.inbox_id::text = split_part(g.path, '/', 1)
          AND m.id::text = split_part(g.path, '/', 2)
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION communications.record_maintenance_run(p_kind text, p_run jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  INSERT INTO communications.maintenance_runs AS r (
    kind, started_at, finished_at, outcome, more_pending, messages_deleted, stuck_deleted,
    threads_deleted, files_deleted, objects_scanned, failures, last_error
  ) VALUES (
    p_kind,
    (p_run->>'started_at')::timestamptz,
    COALESCE((p_run->>'finished_at')::timestamptz, now()),
    p_run->>'outcome',
    COALESCE((p_run->>'more_pending')::boolean, false),
    COALESCE((p_run->>'messages_deleted')::integer, 0),
    COALESCE((p_run->>'stuck_deleted')::integer, 0),
    COALESCE((p_run->>'threads_deleted')::integer, 0),
    COALESCE((p_run->>'files_deleted')::integer, 0),
    COALESCE((p_run->>'objects_scanned')::integer, 0),
    COALESCE((p_run->>'failures')::integer, 0),
    left(p_run->>'last_error', 2000)
  )
  ON CONFLICT (kind) DO UPDATE SET
    started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at, outcome = EXCLUDED.outcome,
    more_pending = EXCLUDED.more_pending, messages_deleted = EXCLUDED.messages_deleted,
    stuck_deleted = EXCLUDED.stuck_deleted, threads_deleted = EXCLUDED.threads_deleted,
    files_deleted = EXCLUDED.files_deleted, objects_scanned = EXCLUDED.objects_scanned,
    failures = EXCLUDED.failures, last_error = EXCLUDED.last_error;
END;
$$;

REVOKE ALL ON FUNCTION communications.retention_due(integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.retention_delete(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.storage_known_paths(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.record_maintenance_run(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.retention_due(integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.retention_delete(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.storage_known_paths(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.record_maintenance_run(text, jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- Task reopens (20261010212024_agent_analytics_reviews.sql). A task leaving `done` was not finished after all, and
-- nothing recorded that: completed_at is cleared on the way out, so the
-- history was lost. From this migration on every reopen is one row, written
-- by the database whoever moves the task (the app, the API, an agent).
CREATE TABLE public.task_reopens (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  to_status text not null,
  reopened_by uuid references public.team_members(id) on delete set null,
  reopened_at timestamptz not null default now()
);

CREATE INDEX idx_task_reopens_reopened_at on public.task_reopens (reopened_at desc);

alter table public.task_reopens enable row level security;

create policy task_reopens_read on public.task_reopens for select to authenticated
  using (public.has_permission('agents.manage') and public.can_access_project(project_id));

grant select on public.task_reopens to authenticated;

create or replace function public.record_task_reopen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'done' and new.status is distinct from 'done' then
    insert into public.task_reopens (task_id, project_id, to_status, reopened_by)
    values (new.id, new.project_id, new.status, public.current_team_member_id());
  end if;
  return new;
end;
$$;

revoke all on function public.record_task_reopen() from public;

create trigger record_task_reopen
  after update of status on public.tasks
  for each row execute function public.record_task_reopen();

-- When each recorder began (same migration): a metric recorded from a moment
-- on reads as "not measured" before it, never as zero.
CREATE TABLE public.analytics_tracking_starts (
  metric text primary key,
  started_at timestamptz not null default now()
);

alter table public.analytics_tracking_starts enable row level security;

create policy analytics_tracking_starts_read on public.analytics_tracking_starts for select to authenticated
  using (public.has_permission('agents.manage'));

grant select on public.analytics_tracking_starts to authenticated;

insert into public.analytics_tracking_starts (metric) values ('task_reopens')
on conflict (metric) do nothing;

-- Realtime publication (20260730134850_realtime_publication.sql)
-- Workspace tables published for postgres_changes so the app store can
-- live-sync. Events respect RLS and column-level grants per subscriber.
-- ─────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array[
    'tasks', 'task_subtasks', 'task_assignees', 'task_acceptance_criteria',
    'task_dependencies', 'task_comments', 'task_reviews',
    'projects', 'project_members',
    'team_members',
    'contacts', 'project_contacts',
    'leads', 'lead_members', 'lead_interactions', 'lead_proposals',
    'lead_fields', 'lead_contacts',
    'activities', 'agent_activities', 'agent_health',
    'portal_settings', 'portal_updates', 'portal_update_attachments',
    'entity_files',
    'project_time_entries', 'time_entry_tasks',
    'project_credentials',
    'project_invoices', 'invoice_time_entry_allocations',
    'project_retainers', 'project_retainer_amounts', 'project_retainer_periods',
    'task_suggestions', 'project_goals',
    'team_member_notifications', 'client_communications',
    'contact_emails',
    'reminders'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;

  -- The Inbox's tables (communications schema): invalidation pings.
  foreach t in array array[
    'inboxes', 'inbox_access', 'client_domains', 'client_addresses', 'endpoints',
    'conversations', 'conversation_projects', 'messages', 'participants', 'message_candidates',
    'attachments', 'triage', 'task_links', 'plans', 'plan_items', 'reply_points'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'communications' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table communications.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Retainer drafts schedule (20260919050750_create_project_retainers.sql). Hourly, because "today" is the owner's calendar day and the job is
-- idempotent: a draft appears within the hour after local midnight. Skipped
-- where pg_cron is unavailable (local fixtures).
-- ---------------------------------------------------------------------------

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not available; retainer drafts will not be scheduled here';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS pg_cron;

  PERFORM cron.schedule(
    'retainer-drafts',
    '7 * * * *',
    $job$SELECT public.generate_retainer_drafts();$job$
  );
END;
$do$;

-- ---------------------------------------------------------------------------
-- Billing plans: scheduled hourly drafts, payment terms, forecast
-- (20261018173052_project_billing_plans.sql)
-- ---------------------------------------------------------------------------
-- -- Tables ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.project_billing_plans (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 120),
  hours_trigger text NOT NULL DEFAULT 'manual'
    CHECK (hours_trigger IN ('manual', 'days_of_month', 'every_weeks', 'reaches_amount', 'fixed_blocks')),
  days_of_month integer[] NOT NULL DEFAULT '{1}'
    CHECK (cardinality(days_of_month) BETWEEN 1 AND 4
      AND days_of_month <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31]),
  every_weeks integer NOT NULL DEFAULT 2 CHECK (every_weeks BETWEEN 1 AND 12),
  weeks_anchor date,
  trigger_amount numeric(12,2) CHECK (trigger_amount IS NULL OR trigger_amount > 0),
  cap_mode text NOT NULL DEFAULT 'none' CHECK (cap_mode IN ('none', 'amount', 'hours')),
  cap_value numeric(12,4) CHECK (cap_value IS NULL OR cap_value > 0),
  min_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  combine_with_retainer boolean NOT NULL DEFAULT true,
  paused boolean NOT NULL DEFAULT false,
  -- Nothing is drafted before starts_on (set when drafting is switched on, so
  -- turning it on never back-drafts) or after ends_on.
  starts_on date,
  ends_on date,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_billing_plans_weeks_anchor CHECK (hours_trigger <> 'every_weeks' OR weeks_anchor IS NOT NULL),
  CONSTRAINT project_billing_plans_amount CHECK (hours_trigger NOT IN ('reaches_amount', 'fixed_blocks') OR trigger_amount IS NOT NULL),
  CONSTRAINT project_billing_plans_cap CHECK (cap_mode = 'none' OR cap_value IS NOT NULL),
  CONSTRAINT project_billing_plans_dates CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

DROP TRIGGER IF EXISTS set_project_billing_plans_updated_at ON public.project_billing_plans;
CREATE TRIGGER set_project_billing_plans_updated_at
  BEFORE UPDATE ON public.project_billing_plans
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- One row per scheduled date (run_key 'day:YYYY-MM-DD') or amount draft
-- ('amount:YYYY-MM-DD:n'). The unique key is the no-double-drafting guard.
CREATE TABLE IF NOT EXISTS public.project_billing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  run_key text NOT NULL,
  run_date date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('drafted', 'merged', 'nothing_due', 'below_minimum', 'failed')),
  invoice_id uuid REFERENCES public.project_invoices(id) ON DELETE SET NULL,
  hours numeric(14,6),
  amount numeric(12,2),
  -- Time left out because it was not approved yet at the cutoff.
  pending_hours numeric(14,6) NOT NULL DEFAULT 0,
  pending_amount numeric(12,2) NOT NULL DEFAULT 0,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_billing_runs_project_key UNIQUE (project_id, run_key)
);
CREATE INDEX IF NOT EXISTS idx_project_billing_runs_invoice ON public.project_billing_runs (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_billing_runs_project_date ON public.project_billing_runs (project_id, run_date DESC);

-- Every auto draft (retainer or hours) waiting to be announced by email and
-- by the PM agent. Rows go when the invoice goes.
CREATE TABLE IF NOT EXISTS public.billing_draft_notices (
  invoice_id uuid PRIMARY KEY REFERENCES public.project_invoices(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  summary text NOT NULL DEFAULT '',
  emailed_at timestamptz,
  relayed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_billing_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_draft_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_billing_plans_select ON public.project_billing_plans;
CREATE POLICY project_billing_plans_select ON public.project_billing_plans FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND public.can_access_project(project_id));
DROP POLICY IF EXISTS project_billing_runs_select ON public.project_billing_runs;
CREATE POLICY project_billing_runs_select ON public.project_billing_runs FOR SELECT TO authenticated
  USING (public.has_permission('invoices.read') AND public.can_access_project(project_id));
-- Plans are written through save_project_billing_plan; runs and notices by the job.

-- -- Helpers ---------------------------------------------------------------

-- Approved-later time: stopped client time on the project that is not approved
-- (and not rejected), started before the cutoff. Reported, never drafted.
CREATE OR REPLACE FUNCTION public.billing_pending_time(p_project_id uuid, p_through timestamptz)
RETURNS TABLE (hours numeric, amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(sum(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time)), 0),
    COALESCE(round(sum(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time) * e.hourly_rate), 2), 0)
  FROM public.project_time_entries e
  WHERE e.project_id = p_project_id
    AND e.end_time IS NOT NULL
    AND e.work_type <> 'internal'
    AND e.approval_status NOT IN ('approved', 'rejected')
    AND e.deleted_at IS NULL
    AND (p_through IS NULL OR e.start_time < p_through)
$$;

-- The most recent scheduled date on or before p_as_of, within the plan's dates.
CREATE OR REPLACE FUNCTION public.billing_plan_last_date(p_plan public.project_billing_plans, p_as_of date)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  candidate date;
  month_start date;
  best date;
  d integer;
  weeks integer;
BEGIN
  IF p_plan.hours_trigger = 'days_of_month' THEN
    FOR month_start IN SELECT generate_series(date_trunc('month', p_as_of) - interval '1 month', date_trunc('month', p_as_of), interval '1 month')::date LOOP
      FOREACH d IN ARRAY p_plan.days_of_month LOOP
        candidate := month_start + (LEAST(d, extract(day FROM (month_start + interval '1 month' - interval '1 day'))::integer) - 1);
        IF candidate <= p_as_of AND (best IS NULL OR candidate > best) THEN best := candidate; END IF;
      END LOOP;
    END LOOP;
  ELSIF p_plan.hours_trigger = 'every_weeks' AND p_plan.weeks_anchor IS NOT NULL AND p_plan.weeks_anchor <= p_as_of THEN
    weeks := p_plan.every_weeks * 7;
    best := p_plan.weeks_anchor + ((p_as_of - p_plan.weeks_anchor) / weeks) * weeks;
  END IF;
  IF best IS NULL OR (p_plan.starts_on IS NOT NULL AND best < p_plan.starts_on)
     OR (p_plan.ends_on IS NOT NULL AND best > p_plan.ends_on) THEN
    RETURN NULL;
  END IF;
  RETURN best;
END;
$$;

-- Scheduled dates in [p_from, p_to], in order (for the forecast).
CREATE OR REPLACE FUNCTION public.billing_plan_dates(p_plan public.project_billing_plans, p_from date, p_to date)
RETURNS SETOF date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  month_start date;
  candidate date;
  d integer;
  weeks integer;
  lo date := GREATEST(p_from, COALESCE(p_plan.starts_on, p_from));
  hi date := LEAST(p_to, COALESCE(p_plan.ends_on, p_to));
BEGIN
  IF hi < lo THEN RETURN; END IF;
  IF p_plan.hours_trigger = 'days_of_month' THEN
    FOR month_start IN SELECT generate_series(date_trunc('month', lo), date_trunc('month', hi), interval '1 month')::date LOOP
      FOR candidate IN
        SELECT DISTINCT month_start + (LEAST(x, extract(day FROM (month_start + interval '1 month' - interval '1 day'))::integer) - 1)
        FROM unnest(p_plan.days_of_month) x ORDER BY 1
      LOOP
        IF candidate BETWEEN lo AND hi THEN RETURN NEXT candidate; END IF;
      END LOOP;
    END LOOP;
  ELSIF p_plan.hours_trigger = 'every_weeks' AND p_plan.weeks_anchor IS NOT NULL THEN
    weeks := p_plan.every_weeks * 7;
    candidate := p_plan.weeks_anchor;
    IF candidate < lo THEN candidate := candidate + ((lo - candidate + weeks - 1) / weeks) * weeks; END IF;
    WHILE candidate <= hi LOOP
      RETURN NEXT candidate;
      candidate := candidate + weeks;
    END LOOP;
  END IF;
END;
$$;

-- -- Drafting --------------------------------------------------------------

-- Announce an auto draft: one bell per owner and admin, keyed to the invoice
-- (a project key would overwrite other unread notices about the project),
-- and a notice row for the email digest and the PM agent.
CREATE OR REPLACE FUNCTION public.announce_billing_draft(p_invoice_id uuid, p_title text, p_message text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.project_invoices;
  recipient uuid;
BEGIN
  SELECT * INTO invoice FROM public.project_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  FOR recipient IN
    SELECT id FROM public.team_members WHERE role IN ('owner', 'admin') AND status = 'active'
  LOOP
    PERFORM public.upsert_notification(
      recipient, p_title, p_message,
      '/projects/' || invoice.project_id::text || '?tab=invoices',
      'invoice', invoice.id::text
    );
  END LOOP;
  INSERT INTO public.billing_draft_notices (invoice_id, project_id, summary)
  VALUES (invoice.id, invoice.project_id, p_message)
  ON CONFLICT (invoice_id) DO UPDATE SET summary = EXCLUDED.summary, emailed_at = NULL, relayed_at = NULL;
END;
$$;

-- The retainer drafter, unchanged except: the due date follows the project's
-- payment terms, and the announcement is per invoice (announce_billing_draft).
-- (create_retainer_draft_internal: see the retainer section; due date follows payment terms)

-- Put a drafted hours line (invoice_hours_draft_internal's result) on an
-- invoice dated p_date: onto the project's untouched retainer auto draft of
-- that date when p_combine, else a new draft. Returns (invoice id, merged).
CREATE OR REPLACE FUNCTION public.place_hours_draft(
  p_project_id uuid,
  p_draft jsonb,
  p_date date,
  p_combine boolean,
  OUT invoice_id uuid,
  OUT merged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.project_invoices;
  terms integer;
  project_name text;
  line jsonb;
  line_id text := gen_random_uuid()::text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('retainer-draft:' || p_project_id::text));
  SELECT COALESCE(payment_terms_days, 0) INTO terms FROM public.project_billing_plans WHERE project_id = p_project_id;
  SELECT name INTO project_name FROM public.projects WHERE id = p_project_id;
  merged := false;

  IF p_combine THEN
    SELECT * INTO target FROM public.project_invoices i
    WHERE i.project_id = p_project_id AND i.status = 'draft' AND i.auto_generated AND i.deleted_at IS NULL
      AND i.date = to_char(p_date, 'YYYY-MM-DD')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.line_items) l WHERE l->>'item_type' = 'hourly')
    ORDER BY i.created_at
    LIMIT 1;
    merged := FOUND;
  END IF;

  line := jsonb_build_object(
    'id', line_id,
    'position', CASE WHEN merged THEN jsonb_array_length(target.line_items) ELSE 0 END,
    'item_type', 'hourly',
    'amount', (p_draft->>'amount')::numeric,
    'description', p_draft->>'description',
    'service_start_date', NULL,
    'service_end_date', NULL,
    'recurrence_frequency', NULL
  );

  IF merged THEN
    UPDATE public.project_invoices
    SET line_items = line_items || jsonb_build_array(line),
        amount = amount + (p_draft->>'amount')::numeric
    WHERE id = target.id;
    invoice_id := target.id;
  ELSE
    INSERT INTO public.project_invoices (
      project_id, invoice_number, amount, status, invoice_type, line_items,
      date, due_date, description, auto_generated, created_by
    ) VALUES (
      p_project_id,
      public.next_project_invoice_number(p_project_id),
      (p_draft->>'amount')::numeric,
      'draft',
      'hourly',
      jsonb_build_array(line),
      to_char(p_date, 'YYYY-MM-DD'),
      to_char(p_date + COALESCE(terms, 0), 'YYYY-MM-DD'),
      '',
      true,
      NULL
    )
    RETURNING id INTO invoice_id;
  END IF;

  INSERT INTO public.invoice_time_entry_allocations (invoice_id, line_item_id, time_entry_id, start_offset_hours, allocated_hours, allocated_amount)
  SELECT invoice_id, line_id, (a->>'time_entry_id')::uuid, (a->>'start_offset_hours')::numeric,
         (a->>'allocated_hours')::numeric, (a->>'allocated_amount')::numeric
  FROM jsonb_array_elements(p_draft->'allocations') a;
  PERFORM public.validate_invoice_time_allocations(invoice_id);

  PERFORM public.announce_billing_draft(
    invoice_id,
    CASE WHEN merged THEN 'Hours added to a drafted invoice' ELSE 'Invoice drafted' END,
    (SELECT invoice_number FROM public.project_invoices WHERE id = invoice_id) || ' for ' || COALESCE(project_name, 'a project')
      || CASE WHEN merged THEN ' now includes ' ELSE ' covers ' END
      || rtrim(rtrim(to_char(round((p_draft->>'hours')::numeric, 2), 'FM999999990.00'), '0'), '.') || ' h ($'
      || to_char((p_draft->>'amount')::numeric, 'FM999,999,990.00') || '). Ready to review and send.'
  );
END;
$$;

-- One project's due hours drafting at p_as_of. Called by the job, each
-- project in its own subtransaction.
CREATE OR REPLACE FUNCTION public.run_project_billing(p_plan public.project_billing_plans, p_as_of date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text := public.workspace_timezone();
  run_day date;
  through timestamptz;
  draft jsonb;
  pending record;
  placed record;
  mode text := CASE p_plan.cap_mode WHEN 'amount' THEN 'amount' WHEN 'hours' THEN 'hours' ELSE 'all' END;
  key text;
  n integer := 0;
  drafted integer := 0;
  unbilled jsonb;
BEGIN
  IF p_plan.hours_trigger IN ('days_of_month', 'every_weeks') THEN
    run_day := public.billing_plan_last_date(p_plan, p_as_of);
    IF run_day IS NULL THEN RETURN 0; END IF;
    key := 'day:' || to_char(run_day, 'YYYY-MM-DD');
    IF EXISTS (SELECT 1 FROM public.project_billing_runs WHERE project_id = p_plan.project_id AND run_key = key) THEN RETURN 0; END IF;

    through := (run_day::timestamp) AT TIME ZONE zone;
    draft := public.invoice_hours_draft_internal(p_plan.project_id, mode, CASE WHEN mode = 'all' THEN NULL ELSE p_plan.cap_value END, NULL, through);
    SELECT * INTO pending FROM public.billing_pending_time(p_plan.project_id, through);

    IF draft IS NULL THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, pending_hours, pending_amount)
      VALUES (p_plan.project_id, key, run_day, 'nothing_due', pending.hours, pending.amount);
      RETURN 0;
    END IF;
    IF (draft->>'amount')::numeric < p_plan.min_amount THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, hours, amount, pending_hours, pending_amount, detail)
      VALUES (p_plan.project_id, key, run_day, 'below_minimum', (draft->>'hours')::numeric, (draft->>'amount')::numeric,
              pending.hours, pending.amount, 'Under the $' || to_char(p_plan.min_amount, 'FM999,999,990.00') || ' minimum; the hours wait for the next draft.');
      RETURN 0;
    END IF;

    SELECT * INTO placed FROM public.place_hours_draft(p_plan.project_id, draft, run_day, p_plan.combine_with_retainer);
    INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, invoice_id, hours, amount, pending_hours, pending_amount)
    VALUES (p_plan.project_id, key, run_day, CASE WHEN placed.merged THEN 'merged' ELSE 'drafted' END, placed.invoice_id,
            (draft->>'hours')::numeric, (draft->>'amount')::numeric, pending.hours, pending.amount);
    RETURN 1;
  END IF;

  IF p_plan.hours_trigger IN ('reaches_amount', 'fixed_blocks') THEN
    IF (p_plan.starts_on IS NOT NULL AND p_as_of < p_plan.starts_on) OR (p_plan.ends_on IS NOT NULL AND p_as_of > p_plan.ends_on) THEN
      RETURN 0;
    END IF;
    -- Up to 12 blocks a run, so a long backlog drafts in a few runs, not one burst.
    WHILE n < 12 LOOP
      unbilled := public.invoice_hours_draft_internal(p_plan.project_id, 'all');
      EXIT WHEN unbilled IS NULL OR (unbilled->>'amount')::numeric + 0.005 < p_plan.trigger_amount;
      IF p_plan.hours_trigger = 'fixed_blocks' THEN
        draft := public.invoice_hours_draft_internal(p_plan.project_id, 'amount', p_plan.trigger_amount);
      ELSE
        draft := CASE WHEN mode = 'all' THEN unbilled
                      ELSE public.invoice_hours_draft_internal(p_plan.project_id, mode, p_plan.cap_value) END;
      END IF;
      EXIT WHEN draft IS NULL;
      n := n + 1;
      key := 'amount:' || to_char(p_as_of, 'YYYY-MM-DD') || ':'
        || (SELECT count(*) + 1 FROM public.project_billing_runs WHERE project_id = p_plan.project_id AND run_key LIKE 'amount:' || to_char(p_as_of, 'YYYY-MM-DD') || ':%');
      SELECT * INTO pending FROM public.billing_pending_time(p_plan.project_id, NULL);
      SELECT * INTO placed FROM public.place_hours_draft(p_plan.project_id, draft, p_as_of, false);
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, invoice_id, hours, amount, pending_hours, pending_amount)
      VALUES (p_plan.project_id, key, p_as_of, 'drafted', placed.invoice_id, (draft->>'hours')::numeric, (draft->>'amount')::numeric,
              pending.hours, pending.amount);
      drafted := drafted + 1;
      EXIT WHEN p_plan.hours_trigger = 'reaches_amount';
    END LOOP;
    RETURN drafted;
  END IF;
  RETURN 0;
END;
$$;

-- The job: every active plan, each project isolated (one failure is recorded
-- and the others still run). Returns the number of drafts made or topped up.
CREATE OR REPLACE FUNCTION public.generate_billing_drafts(p_as_of date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  as_of date := COALESCE(p_as_of, public.workspace_today());
  plan public.project_billing_plans;
  total integer := 0;
BEGIN
  FOR plan IN
    SELECT p.* FROM public.project_billing_plans p
    JOIN public.projects project ON project.id = p.project_id
    WHERE p.hours_trigger <> 'manual' AND NOT p.paused
      AND project.archived_at IS NULL AND project.deleted_at IS NULL AND COALESCE(project.status, 'active') NOT IN ('completed', 'archived', 'cancelled')
  LOOP
    BEGIN
      total := total + public.run_project_billing(plan, as_of);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, detail)
      VALUES (plan.project_id, 'failed:' || to_char(as_of, 'YYYY-MM-DD'), as_of, 'failed', left(SQLERRM, 500))
      ON CONFLICT (project_id, run_key) DO UPDATE SET detail = EXCLUDED.detail, created_at = now();
    END;
  END LOOP;
  RETURN total;
END;
$$;

-- Save a project's billing plan (payment terms and hours drafting). Turning
-- drafting on (or changing its trigger) starts it today unless starts_on is
-- given, so it never drafts dates that already passed.
CREATE OR REPLACE FUNCTION public.save_project_billing_plan(p_project_id uuid, p_plan jsonb)
RETURNS public.project_billing_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing public.project_billing_plans;
  saved public.project_billing_plans;
  next_trigger text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'Not allowed to change billing on this project' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM public.project_billing_plans WHERE project_id = p_project_id;
  next_trigger := COALESCE(p_plan->>'hours_trigger', existing.hours_trigger, 'manual');

  INSERT INTO public.project_billing_plans AS plan (
    project_id, payment_terms_days, hours_trigger, days_of_month, every_weeks, weeks_anchor,
    trigger_amount, cap_mode, cap_value, min_amount, combine_with_retainer, paused, starts_on, ends_on, created_by
  ) VALUES (
    p_project_id,
    COALESCE((p_plan->>'payment_terms_days')::integer, existing.payment_terms_days, 0),
    next_trigger,
    CASE WHEN jsonb_typeof(p_plan->'days_of_month') = 'array'
      THEN ARRAY(SELECT DISTINCT x::integer FROM jsonb_array_elements_text(p_plan->'days_of_month') x ORDER BY 1)
      ELSE COALESCE(existing.days_of_month, '{1}') END,
    COALESCE((p_plan->>'every_weeks')::integer, existing.every_weeks, 2),
    CASE WHEN p_plan ? 'weeks_anchor' THEN (p_plan->>'weeks_anchor')::date ELSE existing.weeks_anchor END,
    CASE WHEN p_plan ? 'trigger_amount' THEN (p_plan->>'trigger_amount')::numeric ELSE existing.trigger_amount END,
    COALESCE(p_plan->>'cap_mode', existing.cap_mode, 'none'),
    CASE WHEN p_plan ? 'cap_value' THEN (p_plan->>'cap_value')::numeric ELSE existing.cap_value END,
    COALESCE((p_plan->>'min_amount')::numeric, existing.min_amount, 0),
    COALESCE((p_plan->>'combine_with_retainer')::boolean, existing.combine_with_retainer, true),
    COALESCE((p_plan->>'paused')::boolean, existing.paused, false),
    CASE
      WHEN p_plan ? 'starts_on' THEN (p_plan->>'starts_on')::date
      WHEN next_trigger <> 'manual' AND (existing.project_id IS NULL OR existing.hours_trigger IS DISTINCT FROM next_trigger)
        THEN public.workspace_today()
      ELSE existing.starts_on
    END,
    CASE WHEN p_plan ? 'ends_on' THEN (p_plan->>'ends_on')::date ELSE existing.ends_on END,
    public.current_team_member_id()
  )
  ON CONFLICT (project_id) DO UPDATE SET
    payment_terms_days = EXCLUDED.payment_terms_days,
    hours_trigger = EXCLUDED.hours_trigger,
    days_of_month = EXCLUDED.days_of_month,
    every_weeks = EXCLUDED.every_weeks,
    weeks_anchor = EXCLUDED.weeks_anchor,
    trigger_amount = EXCLUDED.trigger_amount,
    cap_mode = EXCLUDED.cap_mode,
    cap_value = EXCLUDED.cap_value,
    min_amount = EXCLUDED.min_amount,
    combine_with_retainer = EXCLUDED.combine_with_retainer,
    paused = EXCLUDED.paused,
    starts_on = EXCLUDED.starts_on,
    ends_on = EXCLUDED.ends_on
  RETURNING * INTO saved;
  RETURN saved;
END;
$$;

-- -- Forecast --------------------------------------------------------------

-- Every invoice the project's retainers and billing plan will produce from
-- p_from through p_until, oldest first, plus drafts already made for those
-- dates. Fixed amounts are exact; hours are "so far" for the next scheduled
-- draft and an estimate after it (from the last 90 days' pace), and marked so.
-- Computed from the same functions the jobs use, so the preview cannot
-- disagree with what is later drafted.
--   [{ date, kind, status, invoice_id, invoice_number, exact, estimated,
--      lines: [{ kind, label, amount, estimated, note }], notes: [] }]
CREATE OR REPLACE FUNCTION public.billing_forecast_internal(p_project_id uuid, p_from date, p_until date, p_plan jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  plan public.project_billing_plans;
  items jsonb := '[]'::jsonb;
  r record;
  p record;
  handled record;
  inv_id uuid;
  inv_number text;
  inv_status text;
  period_status text;
  d date;
  prev date;
  pace numeric;
  so_far jsonb;
  first_hours boolean := true;
  est numeric;
  next_block date;
  remaining numeric;
  merged jsonb := '[]'::jsonb;
  item jsonb;
  by_date jsonb := '{}'::jsonb;
  k text;
BEGIN
  -- The saved plan, or the one being edited (live preview before Save).
  SELECT * INTO plan FROM public.project_billing_plans WHERE project_id = p_project_id;
  IF p_plan IS NOT NULL THEN
    plan := jsonb_populate_record(COALESCE(plan, ROW(p_project_id, 0, 'manual', '{1}', 2, NULL, NULL, 'none', NULL, 0, true, false, NULL, NULL, NULL, now(), now())::public.project_billing_plans), p_plan);
    IF plan.hours_trigger <> 'manual' AND plan.starts_on IS NULL THEN plan.starts_on := public.workspace_today(); END IF;
  END IF;

  -- Retainers: each period whose bill date falls in the window.
  FOR r IN SELECT * FROM public.project_retainers WHERE project_id = p_project_id AND deleted_at IS NULL ORDER BY start_date LOOP
    FOR p IN SELECT * FROM public.retainer_periods(r.id, p_from - 62, p_until) LOOP
      CONTINUE WHEN p.bill_date < p_from OR p.bill_date > p_until;
      inv_id := NULL; inv_number := NULL; inv_status := NULL; period_status := NULL;
      SELECT rp.status, i.id, i.invoice_number, i.status INTO period_status, inv_id, inv_number, inv_status
      FROM public.project_retainer_periods rp
      LEFT JOIN public.project_invoices i ON i.id = rp.invoice_id AND i.deleted_at IS NULL
      WHERE rp.retainer_id = r.id AND rp.period_start = p.period_start;
      items := items || jsonb_build_object(
        'date', p.bill_date,
        'source', 'retainer',
        'status', CASE
          WHEN inv_id IS NOT NULL THEN inv_status
          WHEN period_status = 'skipped' THEN 'skipped'
          WHEN r.status = 'paused' THEN 'paused'
          ELSE 'upcoming' END,
        'invoice_id', inv_id,
        'invoice_number', inv_number,
        'line', jsonb_build_object(
          'kind', 'retainer',
          'label', r.name || CASE WHEN p.prorated THEN ' (prorated)' ELSE '' END,
          'amount', p.amount,
          'estimated', false,
          'note', CASE WHEN r.end_date IS NOT NULL AND p.period_end = r.end_date THEN 'Last invoice: the retainer ends ' || to_char(r.end_date, 'Mon FMDD, YYYY') END
        )
      );
    END LOOP;
  END LOOP;

  -- Hours: the pace of approved client work over the last 90 days, per day.
  SELECT COALESCE(sum(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time) * e.hourly_rate), 0) / 90
  INTO pace
  FROM public.project_time_entries e
  WHERE e.project_id = p_project_id AND e.end_time IS NOT NULL AND e.work_type <> 'internal'
    AND e.approval_status = 'approved' AND e.deleted_at IS NULL AND e.start_time >= now() - interval '90 days';
  so_far := public.invoice_hours_draft_internal(p_project_id, 'all');

  IF plan.project_id IS NOT NULL AND plan.hours_trigger IN ('days_of_month', 'every_weeks') THEN
    prev := public.workspace_today();
    FOR d IN SELECT * FROM public.billing_plan_dates(plan, p_from, p_until) LOOP
      -- A drafted invoice since moved to Trash reads as if it was deleted.
      SELECT r2.*, i.id AS live_invoice_id, i.status AS live_status, i.invoice_number AS live_number INTO handled
      FROM public.project_billing_runs r2
      LEFT JOIN public.project_invoices i ON i.id = r2.invoice_id AND i.deleted_at IS NULL
      WHERE r2.project_id = p_project_id AND r2.run_key = 'day:' || to_char(d, 'YYYY-MM-DD');
      IF FOUND THEN
        items := items || jsonb_build_object('date', d, 'source', 'hours',
          'status', CASE WHEN handled.live_invoice_id IS NOT NULL THEN handled.live_status ELSE handled.outcome END,
          'invoice_id', handled.live_invoice_id,
          'invoice_number', handled.live_number,
          'line', jsonb_build_object('kind', 'hours', 'label', 'Hours', 'amount', handled.amount, 'estimated', false,
            'note', CASE WHEN handled.pending_hours > 0 THEN round(handled.pending_hours, 2) || ' h awaiting approval left out' END));
        CONTINUE;
      END IF;
      IF first_hours THEN
        est := COALESCE((so_far->>'amount')::numeric, 0);
        items := items || jsonb_build_object('date', d, 'source', 'hours', 'status', CASE WHEN plan.paused THEN 'paused' ELSE 'upcoming' END,
          'line', jsonb_build_object('kind', 'hours', 'label', 'Hours so far', 'amount', est, 'estimated', true,
            'note', round(COALESCE((so_far->>'hours')::numeric, 0), 2) || ' h unbilled now; more may be added before ' || to_char(d, 'Mon FMDD')));
        first_hours := false;
      ELSE
        est := round(pace * (d - prev), 2);
        items := items || jsonb_build_object('date', d, 'source', 'hours', 'status', CASE WHEN plan.paused THEN 'paused' ELSE 'upcoming' END,
          'line', jsonb_build_object('kind', 'hours', 'label', 'Hours (est.)', 'amount', est, 'estimated', true,
            'note', 'At the last 90 days'' pace'));
      END IF;
      IF plan.cap_mode = 'amount' AND plan.cap_value IS NOT NULL THEN
        items := jsonb_set(items, ARRAY[(jsonb_array_length(items) - 1)::text, 'line', 'amount'],
          to_jsonb(LEAST(est, plan.cap_value)));
      END IF;
      prev := d;
    END LOOP;
  ELSIF plan.project_id IS NOT NULL AND plan.hours_trigger IN ('reaches_amount', 'fixed_blocks') AND plan.trigger_amount IS NOT NULL THEN
    remaining := plan.trigger_amount - COALESCE((so_far->>'amount')::numeric, 0);
    IF pace > 0 THEN
      next_block := public.workspace_today() + GREATEST(0, ceil(remaining / pace))::integer;
      WHILE next_block <= p_until LOOP
        IF next_block >= p_from THEN
          items := items || jsonb_build_object('date', next_block, 'source', 'hours', 'status', CASE WHEN plan.paused THEN 'paused' ELSE 'upcoming' END,
            'line', jsonb_build_object('kind', 'hours',
              'label', CASE WHEN plan.hours_trigger = 'fixed_blocks' THEN 'Block of hours (est. date)' ELSE 'Hours (est. date)' END,
              'amount', plan.trigger_amount, 'estimated', true,
              'note', 'When unbilled hours reach $' || to_char(plan.trigger_amount, 'FM999,999,990.00') || ', at the last 90 days'' pace'));
        END IF;
        next_block := next_block + GREATEST(1, ceil(plan.trigger_amount / pace))::integer;
      END LOOP;
    END IF;
  END IF;

  -- One invoice per date: retainer and hours lines on the same date ride
  -- together when the plan combines them.
  -- Retainer lines of one date share an invoice (the retainer job drafts one
  -- per project per date); hours join it when the plan combines them.
  FOR item IN SELECT value FROM jsonb_array_elements(items) ORDER BY (value->>'date')::date, value->>'source' DESC LOOP
    k := CASE WHEN item->>'source' = 'retainer' OR COALESCE(plan.combine_with_retainer, true)
              THEN item->>'date' ELSE (item->>'date') || '#hours' END;
    IF by_date ? k THEN
      by_date := jsonb_set(by_date, ARRAY[k], (by_date->k)
        || jsonb_build_object(
          'sources', CASE WHEN (by_date->k->>'sources') LIKE '%' || (item->>'source') || '%' THEN by_date->k->>'sources'
                          ELSE (by_date->k->>'sources') || ',' || (item->>'source') END,
          'lines', (by_date->k->'lines') || jsonb_build_array(item->'line'),
          'invoice_id', COALESCE(by_date->k->'invoice_id', item->'invoice_id'),
          'invoice_number', COALESCE(by_date->k->'invoice_number', item->'invoice_number')));
    ELSE
      by_date := by_date || jsonb_build_object(k, jsonb_build_object(
        'date', item->>'date', 'sources', item->>'source', 'status', item->>'status',
        'invoice_id', item->'invoice_id', 'invoice_number', item->'invoice_number',
        'lines', jsonb_build_array(item->'line')));
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(
    v || jsonb_build_object(
      'exact', (SELECT COALESCE(sum((l->>'amount')::numeric), 0) FROM jsonb_array_elements(v->'lines') l WHERE NOT (l->>'estimated')::boolean),
      'estimated', (SELECT COALESCE(sum((l->>'amount')::numeric), 0) FROM jsonb_array_elements(v->'lines') l WHERE (l->>'estimated')::boolean)
    ) ORDER BY (v->>'date')::date, v->>'sources'), '[]'::jsonb)
  INTO merged
  FROM jsonb_each(by_date) AS e(key, v);
  RETURN merged;
END;
$$;

-- What a person may read: one project (invoices.read and project access), or
-- every project they can open (the billing calendar). p_plan previews unsaved
-- settings for one project.
CREATE OR REPLACE FUNCTION public.billing_forecast(p_project_id uuid, p_from date DEFAULT NULL, p_until date DEFAULT NULL, p_plan jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  from_day date := COALESCE(p_from, public.workspace_today());
  until_day date := COALESCE(p_until, from_day + 365);
  project record;
  out jsonb := '[]'::jsonb;
BEGIN
  IF until_day > from_day + 800 THEN until_day := from_day + 800; END IF;
  IF p_project_id IS NOT NULL THEN
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND NOT (public.has_permission('invoices.read', 'app') AND public.can_access_project(p_project_id)) THEN
      RAISE EXCEPTION 'Not allowed to read billing on this project' USING ERRCODE = '42501';
    END IF;
    RETURN public.billing_forecast_internal(p_project_id, from_day, until_day, p_plan);
  END IF;
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.has_permission('invoices.read', 'app') THEN
    RAISE EXCEPTION 'Not allowed to read billing' USING ERRCODE = '42501';
  END IF;
  FOR project IN
    SELECT pr.id, pr.name FROM public.projects pr
    WHERE pr.archived_at IS NULL
      AND pr.deleted_at IS NULL
      AND (COALESCE(auth.role(), '') = 'service_role' OR public.can_access_project(pr.id))
      AND (EXISTS (SELECT 1 FROM public.project_retainers rt WHERE rt.project_id = pr.id AND rt.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM public.project_billing_plans bp WHERE bp.project_id = pr.id AND bp.hours_trigger <> 'manual'))
    ORDER BY pr.name
  LOOP
    SELECT out || COALESCE(jsonb_agg(item || jsonb_build_object('project_id', project.id, 'project_name', project.name)), '[]'::jsonb)
    INTO out
    FROM jsonb_array_elements(public.billing_forecast_internal(project.id, from_day, until_day)) item;
  END LOOP;
  RETURN out;
END;
$$;

-- -- Grants and schedule ---------------------------------------------------

REVOKE ALL ON FUNCTION public.billing_pending_time(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_plan_last_date(public.project_billing_plans, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_plan_dates(public.project_billing_plans, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.announce_billing_draft(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_retainer_draft_internal(uuid, jsonb, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_hours_draft(uuid, jsonb, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_project_billing(public.project_billing_plans, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_billing_drafts(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_forecast_internal(uuid, date, date, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_project_billing_plan(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.billing_forecast(uuid, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_project_billing_plan(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.billing_forecast(uuid, date, date, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_billing_drafts(date) TO service_role;
GRANT SELECT ON public.project_billing_plans, public.project_billing_runs TO authenticated;
GRANT ALL ON public.project_billing_plans, public.project_billing_runs, public.billing_draft_notices TO service_role;

-- Hourly at :17, ten minutes after the retainer job (:07), so a retainer
-- draft for the day exists before hours are combined onto it.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not available; billing drafts will not be scheduled here';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('billing-drafts', '17 * * * *', $job$SELECT public.generate_billing_drafts();$job$);
END;
$do$;

-- ---------------------------------------------------------------------------
-- Invoice payments: each payment recorded, status follows payments
-- (20261018205406_invoice_payments.sql). The event writer above takes the
-- payment block as p_data.
-- ---------------------------------------------------------------------------
-- -- Table ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.project_invoices(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  paid_date date NOT NULL,
  method text CHECK (method IN ('ach', 'wire', 'check', 'card', 'cash', 'other')),
  reference text,
  -- The caller's own id for this payment: replaying it returns the same row.
  external_id text,
  recorded_via text NOT NULL DEFAULT 'app' CHECK (recorded_via IN ('app', 'api')),
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);

-- Among live rows: a row in Trash does not block a new one.
CREATE UNIQUE INDEX invoice_payments_live_external_key
  ON public.invoice_payments (invoice_id, external_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_invoice_payments_updated_at ON public.invoice_payments;
CREATE TRIGGER set_invoice_payments_updated_at
  BEFORE UPDATE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Read with the invoice; written only through the functions below.
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_payments_select ON public.invoice_payments;
CREATE POLICY invoice_payments_select ON public.invoice_payments FOR SELECT TO authenticated
  USING ((public.has_permission('invoices.read') OR public.has_permission('invoices.manage')) AND EXISTS (
    SELECT 1 FROM public.project_invoices invoice
    WHERE invoice.id = invoice_id AND public.can_access_project(invoice.project_id)
  ));
REVOKE ALL ON public.invoice_payments FROM anon, authenticated;
GRANT SELECT ON public.invoice_payments TO authenticated;
GRANT ALL ON public.invoice_payments TO service_role;

-- -- Permission -------------------------------------------------------------

-- Owners hold every permission; admins record payments in the app. API keys
-- get it only from an Owner (or an explicit override).
INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'invoices.record_payments', 'app')
ON CONFLICT DO NOTHING;

-- -- Helpers ----------------------------------------------------------------

-- An invoice's TEXT date as a date: the leading YYYY-MM-DD, or null when
-- there is none or it is not a real day.
CREATE OR REPLACE FUNCTION public.invoice_text_date(p_value text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_value IS NULL OR p_value !~ '^\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  RETURN substring(p_value FROM 1 FOR 10)::date;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN NULL;
END;
$$;

-- What the client owes for an invoice, as the PDF totals it
-- (lib/invoice-pdf/buildInvoiceData.ts): the amount, plus tax at the
-- project's current rate on every line except reimbursements. A line-less
-- (legacy) invoice is one line of its invoice_type.
CREATE OR REPLACE FUNCTION public.invoice_total(p_invoice public.project_invoices)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_invoice.amount + COALESCE(ROUND(
    CASE
      WHEN jsonb_typeof(p_invoice.line_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_invoice.line_items) = 0
        THEN p_invoice.amount
      ELSE (
        SELECT COALESCE(sum(COALESCE(NULLIF(line->>'amount', '')::numeric, 0)), 0)
        FROM jsonb_array_elements(p_invoice.line_items) line
        WHERE COALESCE(line->>'item_type', '') <> 'reimbursement'
      )
    END * project.tax_rate / 100, 2), 0)
  FROM (SELECT 1) one
  LEFT JOIN public.projects project ON project.id = p_invoice.project_id
$$;

-- True when a live revenue-split earning on the invoice is already in a
-- payout that was not voided.
CREATE OR REPLACE FUNCTION public.invoice_share_earnings_paid_out(p_invoice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_member_share_earnings earning
    JOIN public.team_member_payout_allocations allocation ON allocation.share_earning_id = earning.id
    JOIN public.team_member_payouts payout ON payout.id = allocation.payout_id
    WHERE earning.invoice_id = p_invoice_id
      AND earning.voided_at IS NULL AND earning.reversed_at IS NULL
      AND payout.voided_at IS NULL
  )
$$;

-- What a payment event adds to the invoice payload. Amounts are what the
-- client paid (gross), whatever basis the endpoint receives.
CREATE OR REPLACE FUNCTION public.invoice_payment_event_data(
  p_payment public.invoice_payments,
  p_invoice public.project_invoices
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'payment', jsonb_build_object(
      'id', p_payment.id,
      'amount', p_payment.amount,
      'paid_date', p_payment.paid_date,
      'method', p_payment.method,
      'reference', p_payment.reference,
      'external_id', p_payment.external_id,
      'recorded_via', p_payment.recorded_via,
      'created_at', p_payment.created_at
    ),
    'total', public.invoice_total(p_invoice),
    'paid_total', paid.total,
    'outstanding', GREATEST(public.invoice_total(p_invoice) - paid.total, 0)
  )
  FROM (
    SELECT COALESCE(sum(amount), 0) AS total
    FROM public.invoice_payments WHERE invoice_id = p_invoice.id AND deleted_at IS NULL
  ) paid
$$;

-- -- Status follows payments ------------------------------------------------

-- After a payment is added, changed or removed. Skipped while the invoice
-- side (or the backfill) is writing payments itself: app.invoice_payment_sync.
CREATE OR REPLACE FUNCTION public.sync_invoice_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice public.project_invoices;
  v_row public.project_invoices;
  v_paid numeric;
  v_last date;
BEGIN
  IF current_setting('app.invoice_payment_sync', true) = 'on' THEN RETURN NULL; END IF;

  SELECT * INTO v_invoice
  FROM public.project_invoices
  WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- A payment edited while it is in Trash changes nothing.
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(amount), 0), max(paid_date) INTO v_paid, v_last
  FROM public.invoice_payments WHERE invoice_id = v_invoice.id AND deleted_at IS NULL;

  v_row := v_invoice;
  IF v_invoice.status IN ('sent', 'overdue', 'paid') AND v_paid > 0 AND v_paid >= public.invoice_total(v_invoice) THEN
    v_row.status := 'paid';
    IF public.invoice_text_date(v_invoice.paid_date) IS DISTINCT FROM v_last THEN
      v_row.paid_date := to_char(v_last, 'YYYY-MM-DD');
    END IF;
  ELSIF v_invoice.status = 'paid' THEN
    IF public.invoice_share_earnings_paid_out(v_invoice.id) THEN
      RAISE EXCEPTION 'PAYMENT_SHARES_PAID_OUT: This invoice''s revenue split is already paid out, so it cannot become unpaid. Void that payout first.';
    END IF;
    v_row.status := CASE
      WHEN public.invoice_text_date(v_invoice.due_date) < public.workspace_today() THEN 'overdue'
      ELSE 'sent'
    END;
    v_row.paid_date := NULL;
  END IF;
  v_row.updated_at := now();

  -- The payment event first, carrying the status it leads to; then at most
  -- one invoice.paid or invoice.updated from the row change below.
  -- Moving a payment to Trash removes it; restoring it records it again.
  IF (TG_OP = 'INSERT' AND NEW.deleted_at IS NULL)
     OR (TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) THEN
    PERFORM public.emit_invoice_webhook_event(v_row, 'invoice.payment_recorded', public.invoice_payment_event_data(NEW, v_row));
  ELSIF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    PERFORM public.emit_invoice_webhook_event(v_row, 'invoice.payment_removed', public.invoice_payment_event_data(NEW, v_row));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.emit_invoice_webhook_event(v_row, 'invoice.payment_removed', public.invoice_payment_event_data(OLD, v_row));
  END IF;

  PERFORM set_config('app.invoice_payment_sync', 'on', true);
  IF v_row.status IS DISTINCT FROM v_invoice.status OR v_row.paid_date IS DISTINCT FROM v_invoice.paid_date THEN
    UPDATE public.project_invoices
    SET status = v_row.status, paid_date = v_row.paid_date
    WHERE id = v_invoice.id;
  ELSE
    -- Outstanding changed: readers that sync by updated_at see it.
    UPDATE public.project_invoices SET updated_at = now() WHERE id = v_invoice.id;
  END IF;
  PERFORM set_config('app.invoice_payment_sync', '', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sync_invoice_payment_status ON public.invoice_payments;
CREATE TRIGGER sync_invoice_payment_status
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.sync_invoice_payment_status();

-- -- Payments follow the status ---------------------------------------------

-- BEFORE UPDATE on the invoice, because people (and the invoices_manage RLS
-- policy, FOR ALL) still write status, amount, lines and paid_date directly.
CREATE OR REPLACE FUNCTION public.sync_invoice_payments_from_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_api integer;
  v_app integer;
  v_paid numeric;
  v_last date;
  v_on date;
  v_total numeric;
  v_payment public.invoice_payments;
  v_follows boolean := false;
BEGIN
  IF current_setting('app.invoice_payment_sync', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.line_items IS NOT DISTINCT FROM OLD.line_items
     AND NEW.paid_date IS NOT DISTINCT FROM OLD.paid_date THEN
    RETURN NEW;
  END IF;
  v_total := public.invoice_total(NEW);

  SELECT count(*) FILTER (WHERE recorded_via = 'api'),
         count(*) FILTER (WHERE recorded_via = 'app'),
         COALESCE(sum(amount), 0), max(paid_date)
  INTO v_api, v_app, v_paid, v_last
  FROM public.invoice_payments WHERE invoice_id = OLD.id AND deleted_at IS NULL;

  IF NEW.status = 'paid' THEN
    v_on := COALESCE(public.invoice_text_date(NEW.paid_date), public.workspace_today());
    -- Still paid, and the only payment is the bare one that stands for
    -- "paid" (as marking it paid, or the backfill, made it): it follows the
    -- invoice. A payment with a method, reference or external_id was recorded
    -- on purpose and is never rewritten.
    IF OLD.status = 'paid' AND v_api = 0 AND v_app = 1 THEN
      SELECT * INTO v_payment FROM public.invoice_payments WHERE invoice_id = OLD.id AND deleted_at IS NULL;
      v_follows := v_payment.method IS NULL AND v_payment.reference IS NULL AND v_payment.external_id IS NULL;
    END IF;
    IF OLD.status = 'paid' AND v_api + v_app > 0 AND NOT v_follows THEN
      -- The payments stay as recorded and decide the status.
      IF v_paid >= v_total THEN
        NEW.paid_date := to_char(v_last, 'YYYY-MM-DD');
      ELSE
        IF public.invoice_share_earnings_paid_out(NEW.id) THEN
          RAISE EXCEPTION 'PAYMENT_SHARES_PAID_OUT: This invoice''s revenue split is already paid out, so it cannot become unpaid. Void that payout first.';
        END IF;
        NEW.status := CASE
          WHEN public.invoice_text_date(NEW.due_date) < public.workspace_today() THEN 'overdue'
          ELSE 'sent'
        END;
        NEW.paid_date := NULL;
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.paid_date IS NULL THEN NEW.paid_date := to_char(v_on, 'YYYY-MM-DD'); END IF;
    PERFORM set_config('app.invoice_payment_sync', 'on', true);
    IF v_follows THEN
      IF v_total > 0 THEN
        UPDATE public.invoice_payments
        SET amount = v_total, paid_date = v_on
        WHERE invoice_id = NEW.id AND deleted_at IS NULL AND (amount <> v_total OR paid_date <> v_on);
      ELSE
        -- Let go payments move to Trash, as removing one by hand does.
        FOR v_payment IN UPDATE public.invoice_payments
          SET deleted_at = now(), deleted_by = public.current_team_member_id()
          WHERE invoice_id = NEW.id AND deleted_at IS NULL RETURNING * LOOP
          PERFORM public.emit_invoice_webhook_event(NEW, 'invoice.payment_removed', public.invoice_payment_event_data(v_payment, NEW));
        END LOOP;
      END IF;
    ELSIF v_paid < v_total THEN
      INSERT INTO public.invoice_payments (invoice_id, amount, paid_date, recorded_via, created_by)
      VALUES (NEW.id, v_total - v_paid, v_on, 'app', public.current_team_member_id())
      RETURNING * INTO v_payment;
      PERFORM public.emit_invoice_webhook_event(NEW, 'invoice.payment_recorded', public.invoice_payment_event_data(v_payment, NEW));
    END IF;
    PERFORM set_config('app.invoice_payment_sync', '', true);
    RETURN NEW;
  END IF;

  IF v_api + v_app = 0 THEN RETURN NEW; END IF;

  IF OLD.status = 'paid' OR NEW.status IN ('draft', 'cancelled') THEN
    IF v_api > 0 THEN
      RAISE EXCEPTION 'PAYMENT_RECORDED_ELSEWHERE: This invoice has payments recorded by an accounting connection. Remove them there first.';
    END IF;
    PERFORM set_config('app.invoice_payment_sync', 'on', true);
    FOR v_payment IN UPDATE public.invoice_payments
      SET deleted_at = now(), deleted_by = public.current_team_member_id()
      WHERE invoice_id = NEW.id AND deleted_at IS NULL RETURNING * LOOP
      PERFORM public.emit_invoice_webhook_event(NEW, 'invoice.payment_removed', public.invoice_payment_event_data(v_payment, NEW));
    END LOOP;
    PERFORM set_config('app.invoice_payment_sync', '', true);
    RETURN NEW;
  END IF;

  -- Sent or overdue with partial payments, and the total came down to them.
  IF v_total > 0 AND v_paid >= v_total THEN
    NEW.status := 'paid';
    NEW.paid_date := to_char(v_last, 'YYYY-MM-DD');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_invoice_payments_from_invoice ON public.project_invoices;
CREATE TRIGGER sync_invoice_payments_from_invoice
  BEFORE UPDATE OF status, amount, line_items, paid_date ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.sync_invoice_payments_from_invoice();

-- An invoice created as paid gets a paid date (BEFORE) and its payment
-- (AFTER). The AFTER trigger sorts before emit_invoice_webhook, so the
-- payment event comes ahead of the invoice event, as on an update.
CREATE OR REPLACE FUNCTION public.record_payment_for_paid_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.invoice_payments;
  v_total numeric;
BEGIN
  IF TG_WHEN = 'BEFORE' THEN
    IF NEW.status = 'paid' AND NEW.paid_date IS NULL THEN
      NEW.paid_date := to_char(public.workspace_today(), 'YYYY-MM-DD');
    END IF;
    RETURN NEW;
  END IF;
  IF current_setting('app.invoice_payment_sync', true) = 'on' THEN RETURN NULL; END IF;
  v_total := public.invoice_total(NEW);
  IF NEW.status <> 'paid' OR v_total <= 0 THEN RETURN NULL; END IF;
  PERFORM set_config('app.invoice_payment_sync', 'on', true);
  INSERT INTO public.invoice_payments (invoice_id, amount, paid_date, recorded_via, created_by)
  VALUES (NEW.id, v_total, COALESCE(public.invoice_text_date(NEW.paid_date), public.workspace_today()), 'app', public.current_team_member_id())
  RETURNING * INTO v_payment;
  PERFORM set_config('app.invoice_payment_sync', '', true);
  PERFORM public.emit_invoice_webhook_event(NEW, 'invoice.payment_recorded', public.invoice_payment_event_data(v_payment, NEW));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS record_payment_for_paid_invoice ON public.project_invoices;
DROP TRIGGER IF EXISTS apply_paid_date_for_paid_invoice ON public.project_invoices;
CREATE TRIGGER apply_paid_date_for_paid_invoice
  BEFORE INSERT ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.record_payment_for_paid_invoice();
DROP TRIGGER IF EXISTS apply_payment_for_paid_invoice ON public.project_invoices;
CREATE TRIGGER apply_payment_for_paid_invoice
  AFTER INSERT ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.record_payment_for_paid_invoice();

-- -- Recording and removing -------------------------------------------------

-- One payment on one invoice. p_payment: amount, paid_date, method,
-- reference, external_id; the service role (the API) also passes
-- recorded_via, api_key_id and created_by. Returns {payment, replayed}.
-- Errors start with a code the API maps: INVOICE_NOT_FOUND,
-- INVOICE_NOT_PAYABLE, PAYMENT_INVALID, PAYMENT_EXCEEDS_OUTSTANDING,
-- PAYMENT_EXTERNAL_ID_CONFLICT, PAYMENT_FORBIDDEN.
CREATE OR REPLACE FUNCTION public.record_invoice_payment(p_invoice_id uuid, p_payment jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service boolean := COALESCE(auth.role(), '') = 'service_role';
  v_invoice public.project_invoices;
  v_existing public.invoice_payments;
  v_saved public.invoice_payments;
  v_amount numeric;
  v_date date;
  v_method text := NULLIF(btrim(p_payment->>'method'), '');
  v_reference text := NULLIF(btrim(p_payment->>'reference'), '');
  v_external text := NULLIF(btrim(p_payment->>'external_id'), '');
  v_via text;
  v_paid numeric;
  v_total numeric;
BEGIN
  IF NOT v_service AND NOT (public.has_permission('invoices.record_payments') OR public.has_permission('invoices.manage')) THEN
    RAISE EXCEPTION 'PAYMENT_FORBIDDEN: Missing permission to record invoice payments';
  END IF;

  SELECT * INTO v_invoice FROM public.project_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR v_invoice.deleted_at IS NOT NULL OR NOT public.project_is_live(v_invoice.project_id)
     OR (NOT v_service AND NOT public.can_access_project(v_invoice.project_id)) THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: Invoice not found';
  END IF;

  BEGIN
    v_amount := (p_payment->>'amount')::numeric;
    v_date := (p_payment->>'paid_date')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: Amount must be a number and paid_date a YYYY-MM-DD date';
  END;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> round(v_amount, 2) THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: Amount must be more than 0 with at most 2 decimals';
  END IF;
  IF v_date IS NULL THEN RAISE EXCEPTION 'PAYMENT_INVALID: paid_date is required'; END IF;
  IF v_method IS NOT NULL AND v_method NOT IN ('ach', 'wire', 'check', 'card', 'cash', 'other') THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: method must be ach, wire, check, card, cash or other';
  END IF;

  v_via := CASE WHEN v_service THEN COALESCE(NULLIF(p_payment->>'recorded_via', ''), 'api') ELSE 'app' END;

  IF v_external IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.invoice_payments
    WHERE invoice_id = p_invoice_id AND external_id = v_external AND deleted_at IS NULL;
    IF FOUND THEN
      IF v_existing.amount = v_amount AND v_existing.paid_date = v_date
         AND v_existing.method IS NOT DISTINCT FROM v_method
         AND v_existing.reference IS NOT DISTINCT FROM v_reference THEN
        RETURN jsonb_build_object('payment', to_jsonb(v_existing), 'replayed', true);
      END IF;
      RAISE EXCEPTION 'PAYMENT_EXTERNAL_ID_CONFLICT: A different payment was already recorded with this external_id';
    END IF;
  END IF;

  IF v_invoice.status NOT IN ('sent', 'overdue', 'paid') THEN
    RAISE EXCEPTION 'INVOICE_NOT_PAYABLE: Only a sent, overdue or paid invoice takes payments (this one is %)', v_invoice.status;
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_paid FROM public.invoice_payments
  WHERE invoice_id = p_invoice_id AND deleted_at IS NULL;
  v_total := public.invoice_total(v_invoice);
  IF v_amount > v_total - v_paid THEN
    RAISE EXCEPTION 'PAYMENT_EXCEEDS_OUTSTANDING: The payment is more than the % outstanding', GREATEST(v_total - v_paid, 0);
  END IF;

  INSERT INTO public.invoice_payments (
    invoice_id, amount, paid_date, method, reference, external_id, recorded_via, api_key_id, created_by
  ) VALUES (
    p_invoice_id, v_amount, v_date, v_method, v_reference, v_external, v_via,
    CASE WHEN v_service THEN NULLIF(p_payment->>'api_key_id', '')::uuid END,
    CASE WHEN v_service THEN NULLIF(p_payment->>'created_by', '')::uuid ELSE public.current_team_member_id() END
  )
  RETURNING * INTO v_saved;
  RETURN jsonb_build_object('payment', to_jsonb(v_saved), 'replayed', false);
END;
$$;

-- Remove one payment. People remove only payments recorded by hand; the API
-- passes p_recorded_via = 'api' so a key removes only what keys recorded.
-- Errors: PAYMENT_NOT_FOUND, PAYMENT_RECORDED_ELSEWHERE, PAYMENT_FORBIDDEN,
-- and PAYMENT_SHARES_PAID_OUT from the status trigger.
CREATE OR REPLACE FUNCTION public.remove_invoice_payment(p_payment_id uuid, p_recorded_via text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service boolean := COALESCE(auth.role(), '') = 'service_role';
  v_payment public.invoice_payments;
  v_project uuid;
  v_only text := CASE WHEN v_service THEN p_recorded_via ELSE 'app' END;
BEGIN
  IF NOT v_service AND NOT (public.has_permission('invoices.record_payments') OR public.has_permission('invoices.manage')) THEN
    RAISE EXCEPTION 'PAYMENT_FORBIDDEN: Missing permission to remove invoice payments';
  END IF;
  SELECT * INTO v_payment FROM public.invoice_payments WHERE id = p_payment_id AND deleted_at IS NULL;
  SELECT project_id INTO v_project FROM public.project_invoices
  WHERE id = v_payment.invoice_id AND deleted_at IS NULL AND public.project_is_live(project_id)
  FOR UPDATE;
  IF v_project IS NULL OR (NOT v_service AND NOT public.can_access_project(v_project)) THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: Payment not found';
  END IF;
  IF v_only IS NOT NULL AND v_payment.recorded_via <> v_only THEN
    RAISE EXCEPTION 'PAYMENT_RECORDED_ELSEWHERE: %', CASE WHEN v_payment.recorded_via = 'api'
      THEN 'This payment was recorded by an accounting connection. Remove it there.'
      ELSE 'This payment was recorded by hand in the app. Remove it there.' END;
  END IF;
  -- Removed means moved to Trash; the status trigger sends payment_removed.
  UPDATE public.invoice_payments
  SET deleted_at = now(), deleted_by = public.current_team_member_id()
  WHERE id = p_payment_id
  RETURNING * INTO v_payment;
  RETURN to_jsonb(v_payment);
END;
$$;

-- A project's payments with the name of the key that recorded each (keys are
-- not readable by most members).
CREATE OR REPLACE FUNCTION public.project_invoice_payments(p_project_id uuid)
RETURNS TABLE (
  id uuid,
  invoice_id uuid,
  amount numeric,
  paid_date date,
  method text,
  reference text,
  external_id text,
  recorded_via text,
  api_key_id uuid,
  api_key_name text,
  created_by uuid,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT ((public.has_permission('invoices.read') OR public.has_permission('invoices.manage'))
              AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'Not allowed to read payments on this project' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT payment.id, payment.invoice_id, payment.amount, payment.paid_date, payment.method,
         payment.reference, payment.external_id, payment.recorded_via, payment.api_key_id,
         key.name, payment.created_by, payment.created_at, payment.updated_at
  FROM public.invoice_payments payment
  JOIN public.project_invoices invoice ON invoice.id = payment.invoice_id
  LEFT JOIN public.api_keys key ON key.id = payment.api_key_id
  WHERE invoice.project_id = p_project_id
    AND invoice.deleted_at IS NULL
    AND payment.deleted_at IS NULL
  ORDER BY payment.paid_date, payment.created_at;
END;
$$;

-- -- Grants -----------------------------------------------------------------

REVOKE ALL ON FUNCTION public.invoice_text_date(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.invoice_total(public.project_invoices) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_share_earnings_paid_out(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_payment_event_data(public.invoice_payments, public.project_invoices) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_invoice_payment_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_invoice_payments_from_invoice() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_payment_for_paid_invoice() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_invoice_payment(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.project_invoice_payments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_text_date(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_total(public.project_invoices) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_invoice_payment(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.project_invoice_payments(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Earned work and invoice totals for accounting tools
-- (20261018210624_billing_earned_work.sql): time is approved client time by
-- workspace day on hourly projects (the sessions invoice_unbilled_slices
-- counts); scheduled is started retainer periods with no issued invoice.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.billing_earned_work(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text := public.workspace_timezone();
  today date := public.workspace_today();
  result jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed to read earned work' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'EARNED_WORK_RANGE: from and to are required, and from must not be after to';
  END IF;
  IF p_to - p_from > 1830 THEN
    RAISE EXCEPTION 'EARNED_WORK_RANGE: at most five years at a time';
  END IF;

  WITH sessions AS (
    SELECT entry.project_id,
           (entry.start_time AT TIME ZONE zone)::date AS day,
           public.time_entry_worked_hours(entry.segments, entry.start_time, entry.end_time) AS hours,
           entry.hourly_rate AS rate
    FROM public.project_time_entries entry
    JOIN public.projects project ON project.id = entry.project_id
    WHERE project.client_time_billing = 'hourly'
      AND project.deleted_at IS NULL
      AND entry.deleted_at IS NULL
      AND entry.end_time IS NOT NULL
      AND entry.work_type <> 'internal'
      AND entry.approval_status = 'approved'
      AND entry.hourly_rate > 0
      AND (entry.start_time AT TIME ZONE zone)::date BETWEEN p_from AND p_to
  ),
  time_rows AS (
    SELECT jsonb_build_object(
      'project_id', project_id,
      'kind', 'time',
      'earned_from', day,
      'earned_to', day,
      'hours', ROUND(sum(hours), 4),
      'amount', ROUND(sum(hours * rate), 2)
    ) AS row, project_id, day AS sort_day
    FROM sessions
    GROUP BY project_id, day
    HAVING ROUND(sum(hours * rate), 2) > 0
  ),
  scheduled_rows AS (
    SELECT jsonb_build_object(
      'project_id', retainer.project_id,
      'kind', 'scheduled',
      'earned_from', period.period_start,
      'earned_to', period.period_end,
      'amount', period.amount,
      'retainer_id', retainer.id,
      'retainer_name', retainer.name,
      'billing_timing', retainer.billing_timing,
      'draft_invoice_id', invoice.id
    ) AS row, retainer.project_id, period.period_start AS sort_day
    FROM public.project_retainers retainer
    CROSS JOIN LATERAL public.retainer_periods(retainer.id, p_from, LEAST(p_to, today)) period
    LEFT JOIN public.project_retainer_periods handled
      ON handled.retainer_id = retainer.id AND handled.period_start = period.period_start
    LEFT JOIN public.project_invoices invoice ON invoice.id = handled.invoice_id
    WHERE retainer.status = 'active'
      AND retainer.deleted_at IS NULL
      AND public.project_is_live(retainer.project_id)
      AND period.period_start <= today
      AND period.period_end >= p_from
      AND period.amount > 0
      AND (handled.id IS NULL OR (handled.status = 'invoiced' AND invoice.status = 'draft'))
  )
  SELECT COALESCE(jsonb_agg(row ORDER BY project_id, sort_day, row->>'kind'), '[]'::jsonb)
  INTO result
  FROM (SELECT * FROM time_rows UNION ALL SELECT * FROM scheduled_rows) earned;

  RETURN result;
END;
$$;

-- Total owed (invoice_total) and paid so far, for a page of invoices
-- (p_invoice_ids: a JSON array of ids).
CREATE OR REPLACE FUNCTION public.invoice_payment_totals(p_invoice_ids jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_object_agg(invoice.id, jsonb_build_object(
    'total', public.invoice_total(invoice),
    'paid_total', COALESCE((SELECT sum(payment.amount) FROM public.invoice_payments payment WHERE payment.invoice_id = invoice.id AND payment.deleted_at IS NULL), 0)
  )), '{}'::jsonb)
  FROM public.project_invoices invoice
  WHERE invoice.id::text IN (SELECT jsonb_array_elements_text(p_invoice_ids))
$$;

REVOKE ALL ON FUNCTION public.billing_earned_work(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_payment_totals(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_earned_work(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_payment_totals(jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Reminders (20261021215512_create_reminders.sql)
-- ---------------------------------------------------------------------------
-- ============================================================
-- Reminders: the next steps that must not be forgotten. A task often
-- stalls not because work is missing but because its next step (ask the
-- client three questions, follow up on Friday) lived only in someone's
-- head. A reminder holds that step on a task, on a project, or on its own.
--
-- Visibility: a reminder on a task or project is seen by anyone who can see
-- that task or project; a standalone reminder is private to its owner.
-- Dates and times are optional: a dated reminder with no time is due at
-- 8 am workspace time, and the owner gets a bell when it comes due.
-- A task moved to done closes its open reminders; those reopen if the task
-- moves back out of done.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  remind_on date,
  remind_at time,
  -- Whose reminder it is: the person the bell goes to.
  owner_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  -- A task reminder always carries its task's project (set by the trigger).
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_at timestamptz,
  completed_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  -- Closed because its task moved to done; reopened if the task moves back.
  closed_by_task boolean NOT NULL DEFAULT false,
  -- When the due bell went out; cleared when the date or time changes.
  notified_at timestamptz,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'email')),
  -- The email it came from, when it came from one.
  source_message_id uuid REFERENCES communications.messages(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminders_time_needs_date CHECK (remind_at IS NULL OR remind_on IS NOT NULL),
  CONSTRAINT reminders_done_has_completed_at CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT reminders_closed_by_task_is_done CHECK (NOT closed_by_task OR status = 'done'),
  -- Trash: when it was deleted and by whom (null = live). Rows are never
  -- removed; see the Soft delete section.
  deleted_at timestamptz,
  deleted_by uuid references public.team_members(id) on delete set null
);
CREATE INDEX IF NOT EXISTS idx_reminders_source_message ON public.reminders (source_message_id) WHERE source_message_id IS NOT NULL;

-- Defined after reminders, which it reads (the reminders an email set).
-- The newest unsummarized triage per message, oldest message first, with
-- what the batched summary needs (no bodies).
CREATE OR REPLACE FUNCTION communications.unsummarized_triage(p_inbox_ids jsonb, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb))),
  latest AS (
    SELECT DISTINCT ON (t.message_id) t.*
    FROM communications.triage t
    JOIN communications.messages m ON m.id = t.message_id
    WHERE m.inbox_id IN (SELECT id FROM inboxes)
      AND EXISTS (SELECT 1 FROM communications.triage u WHERE u.message_id = t.message_id AND u.summarized_at IS NULL)
    ORDER BY t.message_id, t.created_at DESC, t.id DESC
  )
  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'created_at')), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'triage_id', l.id,
      'created_at', l.created_at,
      'outcome', l.outcome,
      'category', l.category,
      'urgent', l.urgent,
      'summary', l.summary,
      'question_for_human', l.question_for_human,
      'has_suggested_reply', l.suggested_reply IS NOT NULL,
      'project_id', l.project_id,
      'superseded_triage_ids', COALESCE((
        SELECT jsonb_agg(o.id) FROM communications.triage o
        WHERE o.message_id = l.message_id AND o.id <> l.id AND o.summarized_at IS NULL
      ), '[]'::jsonb),
      'message', jsonb_build_object(
        'id', m.id, 'inbox_id', m.inbox_id, 'thread_id', m.thread_id, 'status', m.status,
        'subject', m.subject, 'received_at', m.received_at,
        'kind', m.kind, 'topic', m.topic, 'sort_action', m.sort_action,
        'from', (SELECT jsonb_build_object('address', r.address, 'name', r.name)
                 FROM communications.participants r WHERE r.message_id = m.id AND r.kind = 'from'),
        'routing_basis', m.routing_basis,
        'forwarded_by', CASE WHEN m.routing_basis <> 'sender' AND m.forwarded_by_member_id IS NOT NULL THEN jsonb_build_object(
          'member_id', m.forwarded_by_member_id,
          'name', (SELECT tm.name FROM public.team_members tm WHERE tm.id = m.forwarded_by_member_id)) END,
        'original_sender', CASE WHEN m.routing_basis = 'forwarded_original' THEN jsonb_build_object(
          'address', m.original_from_address, 'name', COALESCE(m.original_from_name, '')) END
      ),
      'project', CASE WHEN th.project_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', th.project_id, 'name', p.name, 'source', th.project_source) END,
      'project_ids', to_jsonb(l.project_ids),
      'projects', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', cp.project_id, 'name', cpp.name, 'source', cp.source)
          ORDER BY communications.project_source_rank(cp.source), cp.created_at, cp.project_id)
        FROM communications.conversation_projects cp JOIN public.projects cpp ON cpp.id = cp.project_id
        WHERE cp.conversation_id = th.id
      ), '[]'::jsonb),
      'thread_summary', th.summary,
      'links', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('task_id', k.task_id, 'relation', k.relation, 'title', tk.title, 'status', tk.status,
          'project_id', tk.project_id, 'project_name', tkp.name) ORDER BY k.created_at)
        FROM communications.task_links k JOIN public.tasks tk ON tk.id = k.task_id
        JOIN public.projects tkp ON tkp.id = tk.project_id
        WHERE k.message_id = m.id AND tk.deleted_at IS NULL
      ), '[]'::jsonb),
      'reminders', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', rm.id, 'title', rm.title, 'remind_on', rm.remind_on, 'task_id', rm.task_id) ORDER BY rm.created_at)
        FROM public.reminders rm
        WHERE rm.source_message_id = m.id AND rm.deleted_at IS NULL AND rm.status = 'open'
      ), '[]'::jsonb)
    ) AS item
    FROM latest l
    JOIN communications.messages m ON m.id = l.message_id
    LEFT JOIN communications.conversations th ON th.id = m.thread_id
    LEFT JOIN public.projects p ON p.id = th.project_id
    ORDER BY l.created_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
  ) items);
END;
$$;
REVOKE ALL ON FUNCTION communications.unsummarized_triage(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.unsummarized_triage(jsonb, integer) TO service_role;

CREATE INDEX IF NOT EXISTS idx_reminders_owner_status ON public.reminders (owner_id, status);
CREATE INDEX IF NOT EXISTS idx_reminders_task ON public.reminders (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_project ON public.reminders (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_due ON public.reminders (remind_on)
  WHERE status = 'open' AND notified_at IS NULL AND remind_on IS NOT NULL;

-- ------------------------------------------------------------
-- Normalise every write: the task's project, completion stamps, the due
-- bell reset, and the fields a later edit may not change.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_reminder_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  task_project uuid;
BEGIN
  NEW.title := btrim(NEW.title);

  IF NEW.task_id IS NOT NULL THEN
    SELECT project_id INTO task_project FROM public.tasks WHERE id = NEW.task_id;
    IF task_project IS NOT NULL THEN
      NEW.project_id := task_project;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, public.current_team_member_id());
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.source := OLD.source;
    NEW.created_at := OLD.created_at;
    IF NEW.remind_on IS DISTINCT FROM OLD.remind_on OR NEW.remind_at IS DISTINCT FROM OLD.remind_at THEN
      NEW.notified_at := NULL;
    END IF;
  END IF;

  IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status <> 'done') THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
    NEW.completed_by := COALESCE(NEW.completed_by, public.current_team_member_id());
  ELSIF NEW.status = 'open' THEN
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
    NEW.closed_by_task := false;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reminders_before_write ON public.reminders;
CREATE TRIGGER reminders_before_write
  BEFORE INSERT OR UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.handle_reminder_before_write();

-- ------------------------------------------------------------
-- A task moved to done is finished, and so are its open reminders: most
-- people never tick every step off. Reminders closed that way reopen if the
-- task moves back out of done; ones a person closed stay closed. A task
-- moved to another project takes its reminders along.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_task_reminders_with_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    UPDATE public.reminders SET project_id = NEW.project_id WHERE task_id = NEW.id;
  END IF;
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    UPDATE public.reminders
    SET status = 'done', closed_by_task = true
    WHERE task_id = NEW.id AND status = 'open';
  ELSIF OLD.status = 'done' AND NEW.status IS DISTINCT FROM 'done' THEN
    UPDATE public.reminders
    SET status = 'open'
    WHERE task_id = NEW.id AND status = 'done' AND closed_by_task;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_task_reminders_with_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_sync_reminders_with_status ON public.tasks;
CREATE TRIGGER tasks_sync_reminders_with_status
  AFTER UPDATE OF status, project_id ON public.tasks
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.project_id IS DISTINCT FROM OLD.project_id)
  EXECUTE FUNCTION public.sync_task_reminders_with_status();

-- ------------------------------------------------------------
-- Row level security
-- ------------------------------------------------------------
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

-- One rule for "can see this reminder", shared by every policy.
CREATE OR REPLACE FUNCTION public.can_see_reminder(p_owner_id uuid, p_project_id uuid, p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (p_task_id IS NULL OR EXISTS (SELECT 1 FROM public.tasks WHERE id = p_task_id AND deleted_at IS NULL))
    AND (p_project_id IS NULL OR EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id AND deleted_at IS NULL))
    AND (
      p_owner_id = public.current_team_member_id()
      OR (p_task_id IS NOT NULL AND public.can_access_task(p_task_id))
      OR (p_task_id IS NULL AND p_project_id IS NOT NULL AND public.can_access_project(p_project_id))
    )
$$;

REVOKE ALL ON FUNCTION public.can_see_reminder(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_see_reminder(uuid, uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS reminders_select ON public.reminders;
CREATE POLICY reminders_select ON public.reminders FOR SELECT TO authenticated
  USING (public.can_see_reminder(owner_id, project_id, task_id));

-- Anyone may write their own standalone reminder. A shared one needs access to
-- its task or project, and only a shared one may belong to someone else.
DROP POLICY IF EXISTS reminders_insert ON public.reminders;
CREATE POLICY reminders_insert ON public.reminders FOR INSERT TO authenticated
  WITH CHECK (
    created_by = public.current_team_member_id()
    AND (task_id IS NULL OR public.can_access_task(task_id))
    AND (project_id IS NULL OR public.can_access_project(project_id))
    AND (owner_id = public.current_team_member_id() OR project_id IS NOT NULL)
  );

-- Anyone who can see a shared reminder can tick it off or move it; a
-- standalone one only its owner.
DROP POLICY IF EXISTS reminders_update ON public.reminders;
CREATE POLICY reminders_update ON public.reminders FOR UPDATE TO authenticated
  USING (public.can_see_reminder(owner_id, project_id, task_id))
  WITH CHECK (
    (task_id IS NULL OR public.can_access_task(task_id))
    AND (project_id IS NULL OR public.can_access_project(project_id))
    AND (owner_id = public.current_team_member_id() OR project_id IS NOT NULL)
  );

DROP POLICY IF EXISTS reminders_delete ON public.reminders;
CREATE POLICY reminders_delete ON public.reminders FOR DELETE TO authenticated
  USING (
    public.can_see_reminder(owner_id, project_id, task_id)
    AND (owner_id = public.current_team_member_id()
      OR created_by = public.current_team_member_id()
      OR public.has_permission('tasks.manage_all'))
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminders TO authenticated;
GRANT ALL ON public.reminders TO service_role;

-- ------------------------------------------------------------
-- Due bells. Every five minutes, each open reminder whose moment has come
-- (its date at its time, or 8 am, in the workspace time zone) rings its
-- owner's bell once.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_due_reminders(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text := public.workspace_timezone();
  due record;
  sent integer := 0;
BEGIN
  FOR due IN
    SELECT r.id, r.owner_id, r.title, r.project_id, r.task_id,
           t.title AS task_title, p.name AS project_name
    FROM public.reminders r
    LEFT JOIN public.tasks t ON t.id = r.task_id
    LEFT JOIN public.projects p ON p.id = r.project_id
    WHERE r.status = 'open'
      AND r.deleted_at IS NULL
      AND (r.task_id IS NULL OR t.deleted_at IS NULL)
      AND (r.project_id IS NULL OR p.deleted_at IS NULL)
      AND r.notified_at IS NULL
      AND r.remind_on IS NOT NULL
      AND (r.remind_on + COALESCE(r.remind_at, time '08:00')) AT TIME ZONE zone <= p_now
    ORDER BY r.remind_on, r.remind_at NULLS FIRST
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    PERFORM public.upsert_notification(
      due.owner_id,
      'Reminder',
      due.title || CASE
        WHEN due.task_title IS NOT NULL THEN ' (' || due.task_title || ')'
        WHEN due.project_name IS NOT NULL THEN ' (' || due.project_name || ')'
        ELSE ''
      END,
      CASE
        WHEN due.task_id IS NOT NULL THEN '/projects/' || due.project_id::text || '?task=' || due.task_id::text
        ELSE '/reminders'
      END,
      'reminder',
      due.id::text
    );
    UPDATE public.reminders SET notified_at = p_now WHERE id = due.id;
    sent := sent + 1;
  END LOOP;
  RETURN sent;
END;
$$;

REVOKE ALL ON FUNCTION public.send_due_reminders(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_due_reminders(timestamptz) TO service_role;

-- Schedule the due bells. Skipped where pg_cron is unavailable (local fixtures).
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('reminders-due', '*/5 * * * *', $job$SELECT public.send_due_reminders();$job$);
END;
$do$;

-- ---------------------------------------------------------------------------
-- Soft delete (migration 20261022035227_soft_delete_records.sql)
-- ---------------------------------------------------------------------------
-- Records are never permanently deleted. "Delete" moves a record to Trash
-- (deleted_at / deleted_by) and Restore brings it back. DELETE and TRUNCATE
-- are refused on these tables for every role. A deleted project, task, lead
-- or contact puts everything under it out of reach (the access helpers and
-- the *_parent_live policies) without touching the children, so a restore
-- brings everything back exactly as it was. Team members are deactivated
-- (status), never deleted.

-- Trash lists deleted rows newest first; live reads never use these.
CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON public.projects (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON public.tasks (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_subtasks_deleted_at ON public.task_subtasks (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_comments_deleted_at ON public.task_comments (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_deleted_at ON public.reminders (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_credentials_deleted_at ON public.project_credentials (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_files_deleted_at ON public.entity_files (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_updates_deleted_at ON public.portal_updates (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_update_attachments_deleted_at ON public.portal_update_attachments (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_deleted_at ON public.contacts (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_deleted_at ON public.leads (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_interactions_deleted_at ON public.lead_interactions (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_proposals_deleted_at ON public.lead_proposals (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_fields_deleted_at ON public.lead_fields (deleted_at DESC) WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.forbid_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % are never permanently deleted. Move them to Trash instead.', TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'Use soft_delete_record(), or deactivate a team member.';
END;
$$;

CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.projects
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.tasks
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.task_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.task_subtasks
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.task_comments
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.reminders
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.project_credentials
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.project_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.entity_files
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.entity_files
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.portal_updates
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.portal_updates
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.portal_update_attachments
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.portal_update_attachments
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.contacts
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.leads
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.lead_interactions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.lead_interactions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.lead_proposals
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.lead_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.lead_fields
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.lead_fields
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.team_members
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.client_communications
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.client_communications
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();

-- Signed-in members never see or change a deleted row. RESTRICTIVE, so it
-- narrows every policy above, including the FOR ALL manage policies.
CREATE POLICY projects_not_deleted ON public.projects AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY tasks_not_deleted ON public.tasks AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY task_subtasks_not_deleted ON public.task_subtasks AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY task_comments_not_deleted ON public.task_comments AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY reminders_not_deleted ON public.reminders AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY project_credentials_not_deleted ON public.project_credentials AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY entity_files_not_deleted ON public.entity_files AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY portal_updates_not_deleted ON public.portal_updates AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY portal_update_attachments_not_deleted ON public.portal_update_attachments AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY contacts_not_deleted ON public.contacts AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY leads_not_deleted ON public.leads AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY lead_interactions_not_deleted ON public.lead_interactions AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY lead_proposals_not_deleted ON public.lead_proposals AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY lead_fields_not_deleted ON public.lead_fields AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);

-- Children of a deleted parent are out of reach, whatever else allows them.
-- Not covered on purpose: team member earnings (pay survives a deleted
-- project), email threads, triage and recipients (the inbox's own record),
-- and a lead whose linked contact was deleted.
CREATE OR REPLACE FUNCTION public.project_is_live(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id AND deleted_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION public.task_is_live(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tasks task
    JOIN public.projects project ON project.id = task.project_id
    LEFT JOIN public.tasks parent ON parent.id = task.parent_task_id
    WHERE task.id = p_task_id AND task.deleted_at IS NULL AND project.deleted_at IS NULL
      AND (task.parent_task_id IS NULL OR parent.deleted_at IS NULL)
  )
$$;

CREATE OR REPLACE FUNCTION public.lead_is_live(p_lead_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.leads WHERE id = p_lead_id AND deleted_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION public.contact_is_live(p_contact_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.contacts WHERE id = p_contact_id AND deleted_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION public.credential_is_live(p_credential_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_credentials credential
    JOIN public.projects project ON project.id = credential.project_id
    WHERE credential.id = p_credential_id AND credential.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.portal_update_is_live(p_update_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.portal_updates update_row
    JOIN public.projects project ON project.id = update_row.project_id
    WHERE update_row.id = p_update_id AND update_row.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.file_entity_is_live(p_entity_type text, p_entity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_entity_type
    WHEN 'project' THEN public.project_is_live(p_entity_id)
    WHEN 'lead' THEN public.lead_is_live(p_entity_id)
    WHEN 'contact' THEN public.contact_is_live(p_entity_id)
    ELSE true
  END
$$;

CREATE POLICY tasks_parent_live ON public.tasks AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY tasks_parent_task_live ON public.tasks AS RESTRICTIVE FOR ALL TO authenticated
  USING (parent_task_id IS NULL OR public.task_is_live(parent_task_id));
CREATE POLICY project_time_entries_parent_live ON public.project_time_entries AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_invoices_parent_live ON public.project_invoices AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_members_parent_live ON public.project_members AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_credentials_parent_live ON public.project_credentials AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY portal_settings_parent_live ON public.portal_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY portal_updates_parent_live ON public.portal_updates AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY portal_events_parent_live ON public.portal_events AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY client_communications_parent_live ON public.client_communications AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_hourly_rates_parent_live ON public.project_hourly_rates AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_retainers_parent_live ON public.project_retainers AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_billing_plans_parent_live ON public.project_billing_plans AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_billing_runs_parent_live ON public.project_billing_runs AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_budget_history_parent_live ON public.project_budget_history AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_context_parent_live ON public.project_context AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY email_client_addresses_parent_live ON communications.client_addresses AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY email_client_domains_parent_live ON communications.client_domains AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY email_project_addresses_parent_live ON communications.endpoints AS RESTRICTIVE FOR ALL TO authenticated
  USING (project_id IS NULL OR public.project_is_live(project_id));
CREATE POLICY email_message_candidates_parent_live ON communications.message_candidates AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY conversation_projects_parent_live ON communications.conversation_projects AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));
CREATE POLICY project_contacts_parent_live ON public.project_contacts AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id) AND public.contact_is_live(contact_id));
CREATE POLICY task_subtasks_parent_live ON public.task_subtasks AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id));
CREATE POLICY task_comments_parent_live ON public.task_comments AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id));
CREATE POLICY task_acceptance_criteria_parent_live ON public.task_acceptance_criteria AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id));
CREATE POLICY task_assignees_parent_live ON public.task_assignees AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id));
CREATE POLICY task_dependencies_parent_live ON public.task_dependencies AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id) AND public.task_is_live(blocked_by_task_id));
CREATE POLICY task_reviews_parent_live ON public.task_reviews AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id));
CREATE POLICY task_reopens_parent_live ON public.task_reopens AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id));
CREATE POLICY email_task_links_parent_live ON communications.task_links AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id));
CREATE POLICY reminders_parent_live ON public.reminders AS RESTRICTIVE FOR ALL TO authenticated
  USING ((task_id IS NULL OR public.task_is_live(task_id)) AND (project_id IS NULL OR public.project_is_live(project_id)));
CREATE POLICY lead_interactions_parent_live ON public.lead_interactions AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.lead_is_live(lead_id));
CREATE POLICY lead_proposals_parent_live ON public.lead_proposals AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.lead_is_live(lead_id));
CREATE POLICY lead_fields_parent_live ON public.lead_fields AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.lead_is_live(lead_id));
CREATE POLICY lead_members_parent_live ON public.lead_members AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.lead_is_live(lead_id));
CREATE POLICY lead_contacts_parent_live ON public.lead_contacts AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.lead_is_live(lead_id) AND public.contact_is_live(contact_id));
CREATE POLICY contact_emails_parent_live ON public.contact_emails AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.contact_is_live(contact_id));
CREATE POLICY project_credential_members_parent_live ON public.project_credential_members AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.credential_is_live(credential_id));
CREATE POLICY portal_update_attachments_parent_live ON public.portal_update_attachments AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.portal_update_is_live(update_id));
CREATE POLICY entity_files_parent_live ON public.entity_files AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.file_entity_is_live(entity_type, entity_id));

-- Move to Trash and Restore. Signed-in members need the record's delete
-- permission (the same people the old DELETE policies allowed); server
-- routes (service role) check permissions themselves and pass the actor.
CREATE OR REPLACE FUNCTION public.trash_record_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'projects', 'tasks', 'task_comments', 'reminders', 'project_credentials',
    'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads',
    'lead_interactions', 'lead_proposals', 'lead_fields',
    'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates',
    'project_retainers', 'project_retainer_amounts', 'task_files'
  ]
$$;

CREATE OR REPLACE FUNCTION public.can_trash_record(p_table text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := public.current_team_member_id();
  allowed boolean := false;
BEGIN
  IF me IS NULL THEN
    RETURN false;
  END IF;
  CASE p_table
    WHEN 'projects' THEN
      SELECT public.has_permission('projects.manage') AND (
        public.has_permission('projects.read_all')
        OR EXISTS (SELECT 1 FROM public.project_members WHERE project_id = p_id AND member_id = me)
      ) INTO allowed;
    WHEN 'tasks' THEN
      -- A subtask can also go by whoever manages its parent as an assignee.
      SELECT public.can_access_project(project_id) AND (
        public.has_permission('tasks.manage_all') OR (
          parent_task_id IS NOT NULL AND public.has_permission('tasks.manage_assigned') AND EXISTS (
            SELECT 1 FROM public.task_assignees assignment
            WHERE assignment.task_id = tasks.parent_task_id AND assignment.member_id = me
          )
        )
      ) INTO allowed FROM public.tasks WHERE id = p_id;
    WHEN 'task_comments' THEN
      SELECT public.can_access_task(task_id) AND (user_id = me OR public.has_permission('tasks.manage_all'))
      INTO allowed FROM public.task_comments WHERE id = p_id;
    WHEN 'task_files' THEN
      SELECT public.can_access_task(task_id) AND (added_by = me OR public.has_permission('files.manage'))
      INTO allowed FROM public.task_files WHERE id = p_id;
    WHEN 'reminders' THEN
      SELECT public.can_see_reminder(owner_id, project_id, task_id)
        AND (owner_id = me OR created_by = me OR public.has_permission('tasks.manage_all'))
      INTO allowed FROM public.reminders WHERE id = p_id;
    WHEN 'project_credentials' THEN
      SELECT public.has_permission('credentials.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_credentials WHERE id = p_id;
    WHEN 'entity_files' THEN
      SELECT public.can_access_file_entity(entity_type, entity_id) AND (
        public.has_permission('files.manage') OR (uploaded_by = me AND visibility = 'internal')
      ) INTO allowed FROM public.entity_files WHERE id = p_id;
    WHEN 'portal_updates' THEN
      SELECT public.has_permission('portal.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.portal_updates WHERE id = p_id;
    WHEN 'portal_update_attachments' THEN
      SELECT public.has_permission('portal.manage') AND public.can_access_project(update_row.project_id)
      INTO allowed
      FROM public.portal_update_attachments attachment
      JOIN public.portal_updates update_row ON update_row.id = attachment.update_id
      WHERE attachment.id = p_id AND update_row.deleted_at IS NULL;
    WHEN 'contacts' THEN
      SELECT public.has_permission('contacts.manage') INTO allowed;
    WHEN 'leads' THEN
      SELECT public.has_permission('leads.manage') INTO allowed;
    WHEN 'lead_interactions' THEN
      SELECT public.has_permission('leads.manage') AND public.can_access_lead(lead_id)
      INTO allowed FROM public.lead_interactions WHERE id = p_id;
    WHEN 'lead_proposals' THEN
      SELECT public.has_permission('leads.manage') AND public.can_access_lead(lead_id)
      INTO allowed FROM public.lead_proposals WHERE id = p_id;
    WHEN 'lead_fields' THEN
      SELECT public.has_permission('leads.manage') AND public.can_access_lead(lead_id)
      INTO allowed FROM public.lead_fields WHERE id = p_id;
    WHEN 'project_time_entries' THEN
      SELECT public.can_access_project(project_id) AND (
        public.has_permission('time.manage_all') OR (
          public.has_permission('time.manage_own')
          AND member_id = me
          AND approval_status IN ('draft', 'pending', 'rejected')
        )
      ) INTO allowed FROM public.project_time_entries WHERE id = p_id;
    WHEN 'project_invoices' THEN
      SELECT public.has_permission('invoices.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_invoices WHERE id = p_id;
    WHEN 'invoice_payments' THEN
      -- People remove only payments recorded by hand, as remove_invoice_payment.
      SELECT (public.has_permission('invoices.record_payments') OR public.has_permission('invoices.manage'))
        AND public.can_access_project(invoice.project_id)
        AND invoice.deleted_at IS NULL
        AND payment.recorded_via = 'app'
      INTO allowed
      FROM public.invoice_payments payment
      JOIN public.project_invoices invoice ON invoice.id = payment.invoice_id
      WHERE payment.id = p_id;
    WHEN 'project_hourly_rates' THEN
      SELECT public.has_permission('billing.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_hourly_rates WHERE id = p_id;
    WHEN 'project_retainers' THEN
      SELECT public.has_permission('invoices.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_retainers WHERE id = p_id;
    WHEN 'project_retainer_amounts' THEN
      SELECT public.has_permission('invoices.manage') AND public.can_access_project(retainer.project_id)
        AND retainer.deleted_at IS NULL
      INTO allowed
      FROM public.project_retainer_amounts amount
      JOIN public.project_retainers retainer ON retainer.id = amount.retainer_id
      WHERE amount.id = p_id;
    ELSE
      allowed := false;
  END CASE;
  RETURN coalesce(allowed, false);
END;
$$;

-- What must still exist before a record can come back from Trash, or what it
-- would clash with that was added while it was away, as a sentence for the
-- person restoring it; null when nothing blocks it.
CREATE OR REPLACE FUNCTION public.trash_restore_blocker(p_table text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  project_gone boolean := false;
  task_gone boolean := false;
  lead_gone boolean := false;
  parent_gone boolean := false;
  payment public.invoice_payments;
  invoice public.project_invoices;
  v_number text;
BEGIN
  CASE p_table
    WHEN 'tasks' THEN
      -- A subtask comes back after its parent.
      SELECT p.deleted_at IS NOT NULL, coalesce(parent.deleted_at IS NOT NULL, false) INTO project_gone, task_gone
      FROM public.tasks t JOIN public.projects p ON p.id = t.project_id
      LEFT JOIN public.tasks parent ON parent.id = t.parent_task_id
      WHERE t.id = p_id;
    WHEN 'task_comments', 'task_files' THEN
      EXECUTE format('SELECT t.deleted_at IS NOT NULL OR coalesce(parent.deleted_at IS NOT NULL, false), p.deleted_at IS NOT NULL
        FROM public.%I c JOIN public.tasks t ON t.id = c.task_id JOIN public.projects p ON p.id = t.project_id
        LEFT JOIN public.tasks parent ON parent.id = t.parent_task_id
        WHERE c.id = $1', p_table)
      INTO task_gone, project_gone USING p_id;
    WHEN 'reminders' THEN
      SELECT coalesce(t.deleted_at IS NOT NULL OR parent.deleted_at IS NOT NULL, false), coalesce(p.deleted_at IS NOT NULL, false)
      INTO task_gone, project_gone
      FROM public.reminders r
      LEFT JOIN public.tasks t ON t.id = r.task_id
      LEFT JOIN public.tasks parent ON parent.id = t.parent_task_id
      LEFT JOIN public.projects p ON p.id = r.project_id
      WHERE r.id = p_id;
    WHEN 'project_credentials', 'portal_updates', 'project_time_entries', 'project_invoices',
         'project_hourly_rates', 'project_retainers' THEN
      EXECUTE format('SELECT p.deleted_at IS NOT NULL FROM public.%I c
        JOIN public.projects p ON p.id = c.project_id WHERE c.id = $1', p_table)
      INTO project_gone USING p_id;
    WHEN 'portal_update_attachments' THEN
      SELECT u.deleted_at IS NOT NULL INTO parent_gone
      FROM public.portal_update_attachments a JOIN public.portal_updates u ON u.id = a.update_id WHERE a.id = p_id;
      IF parent_gone THEN
        RETURN 'Restore the portal update it belongs to first.';
      END IF;
    WHEN 'invoice_payments' THEN
      SELECT p.deleted_at IS NOT NULL, i.deleted_at IS NOT NULL INTO project_gone, parent_gone
      FROM public.invoice_payments pay
      JOIN public.project_invoices i ON i.id = pay.invoice_id
      JOIN public.projects p ON p.id = i.project_id
      WHERE pay.id = p_id;
      IF parent_gone AND NOT project_gone THEN
        RETURN 'Restore the invoice it belongs to first.';
      END IF;
    WHEN 'project_retainer_amounts' THEN
      SELECT p.deleted_at IS NOT NULL, r.deleted_at IS NOT NULL INTO project_gone, parent_gone
      FROM public.project_retainer_amounts a
      JOIN public.project_retainers r ON r.id = a.retainer_id
      JOIN public.projects p ON p.id = r.project_id
      WHERE a.id = p_id;
      IF parent_gone AND NOT project_gone THEN
        RETURN 'Restore the retainer it belongs to first.';
      END IF;
    WHEN 'entity_files' THEN
      SELECT CASE f.entity_type
          WHEN 'project' THEN EXISTS (SELECT 1 FROM public.projects WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          WHEN 'lead' THEN EXISTS (SELECT 1 FROM public.leads WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          WHEN 'contact' THEN EXISTS (SELECT 1 FROM public.contacts WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          ELSE false
        END
      INTO parent_gone
      FROM public.entity_files f WHERE f.id = p_id;
      IF parent_gone THEN
        RETURN 'Restore the project, lead or contact this file belongs to first.';
      END IF;
    WHEN 'lead_interactions', 'lead_proposals', 'lead_fields' THEN
      EXECUTE format('SELECT l.deleted_at IS NOT NULL FROM public.%I c
        JOIN public.leads l ON l.id = c.lead_id WHERE c.id = $1', p_table)
      INTO lead_gone USING p_id;
    ELSE
      NULL;
  END CASE;
  IF coalesce(project_gone, false) THEN
    RETURN 'Restore the project it belongs to first.';
  ELSIF coalesce(task_gone, false) THEN
    RETURN 'Restore the task it belongs to first.';
  ELSIF coalesce(lead_gone, false) THEN
    RETURN 'Restore the lead it belongs to first.';
  END IF;

  -- Clashes with what was added while it was in Trash.
  CASE p_table
    WHEN 'project_time_entries' THEN
      IF EXISTS (
        SELECT 1 FROM public.project_time_entries entry
        JOIN public.project_time_entries other
          ON other.project_id = entry.project_id AND other.member_id = entry.member_id AND other.id <> entry.id
        WHERE entry.id = p_id AND entry.end_time IS NULL
          AND other.end_time IS NULL AND other.deleted_at IS NULL
      ) THEN
        RETURN 'This timer is still running and a newer one is running on the same project. Stop that one first.';
      END IF;
    WHEN 'project_invoices' THEN
      SELECT * INTO invoice FROM public.project_invoices WHERE id = p_id;
      IF invoice.status <> 'cancelled' THEN
        SELECT other.invoice_number INTO v_number
        FROM public.invoice_time_entry_allocations mine
        JOIN public.invoice_time_entry_allocations theirs
          ON theirs.time_entry_id = mine.time_entry_id AND theirs.invoice_id <> mine.invoice_id
        JOIN public.project_invoices other ON other.id = theirs.invoice_id
        WHERE mine.invoice_id = p_id AND other.status <> 'cancelled' AND other.deleted_at IS NULL
          AND mine.start_offset_hours < theirs.start_offset_hours + theirs.allocated_hours - 0.000001
          AND theirs.start_offset_hours < mine.start_offset_hours + mine.allocated_hours - 0.000001
        LIMIT 1;
        IF FOUND THEN
          RETURN 'Some of its hours are on invoice ' || v_number || ' now. Take them off that invoice first.';
        END IF;
        IF EXISTS (
          SELECT 1 FROM public.invoice_time_entry_allocations allocation
          JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
          WHERE allocation.invoice_id = p_id AND entry.deleted_at IS NOT NULL
        ) THEN
          RETURN 'Some of its time is in Trash. Restore that time first.';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
          JOIN public.project_retainers retainer ON retainer.id::text = line.value->>'retainer_id' AND retainer.deleted_at IS NULL
          JOIN public.project_retainer_periods handled
            ON handled.retainer_id = retainer.id
           AND handled.period_start = GREATEST(date_trunc('month', (line.value->>'service_start_date')::date)::date, retainer.start_date)
          WHERE COALESCE(line.value->>'service_start_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
            AND handled.status = 'invoiced' AND handled.invoice_id IS NOT NULL AND handled.invoice_id <> p_id
        ) THEN
          RETURN 'Its retainer period is on another invoice now.';
        END IF;
      END IF;
      -- Paid hours that are not linked to time entries cannot be checked
      -- against what was billed since; counting them again would under-bill.
      IF invoice.status = 'paid'
         AND (
           (jsonb_array_length(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) = 0 AND invoice.invoice_type = 'hourly'
            AND NOT EXISTS (SELECT 1 FROM public.invoice_time_entry_allocations a WHERE a.invoice_id = p_id))
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
             WHERE line.value->>'item_type' = 'hourly'
               AND NOT EXISTS (SELECT 1 FROM public.invoice_time_entry_allocations a
                               WHERE a.invoice_id = p_id AND a.line_item_id = line.value->>'id')
           )
         )
         AND EXISTS (
           SELECT 1 FROM public.project_invoices other
           WHERE other.project_id = invoice.project_id AND other.id <> p_id AND other.deleted_at IS NULL
             AND other.status <> 'cancelled' AND other.created_at > invoice.deleted_at
             AND (other.invoice_type = 'hourly' OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(other.line_items, 'null'::jsonb), '[]'::jsonb)) line
               WHERE line.value->>'item_type' = 'hourly'))
         ) THEN
        RETURN 'Hours were invoiced after this invoice went to Trash, and its own hours are not linked to time entries, so restoring it could count hours twice. Check the hourly invoices first.';
      END IF;
    WHEN 'project_hourly_rates' THEN
      IF EXISTS (
        SELECT 1 FROM public.project_hourly_rates rate
        JOIN public.project_hourly_rates other
          ON other.project_id = rate.project_id AND other.effective_at = rate.effective_at AND other.id <> rate.id
        WHERE rate.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'Another rate now starts at the same time. Change or delete that one first.';
      END IF;
    WHEN 'lead_fields' THEN
      IF EXISTS (
        SELECT 1 FROM public.lead_fields field
        JOIN public.lead_fields other
          ON other.lead_id = field.lead_id AND other.field_key = field.field_key AND other.id <> field.id
        WHERE field.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'This field has been set again since. Change or delete that one first.';
      END IF;
    WHEN 'project_retainer_amounts' THEN
      IF EXISTS (
        SELECT 1 FROM public.project_retainer_amounts amount
        JOIN public.project_retainer_amounts other
          ON other.retainer_id = amount.retainer_id AND other.effective_date = amount.effective_date AND other.id <> amount.id
        WHERE amount.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'Another amount now starts on the same date. Change or delete that one first.';
      END IF;
    WHEN 'invoice_payments' THEN
      SELECT * INTO payment FROM public.invoice_payments WHERE id = p_id;
      SELECT * INTO invoice FROM public.project_invoices WHERE id = payment.invoice_id;
      IF invoice.status NOT IN ('sent', 'overdue', 'paid') THEN
        RETURN 'Its invoice is ' || invoice.status || ' now, so it cannot take a payment.';
      END IF;
      IF payment.amount > public.invoice_total(invoice) - COALESCE((
        SELECT sum(other.amount) FROM public.invoice_payments other
        WHERE other.invoice_id = invoice.id AND other.deleted_at IS NULL
      ), 0) + 0.005 THEN
        RETURN 'Its invoice no longer has enough outstanding for this payment.';
      END IF;
      IF payment.external_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.invoice_payments other
        WHERE other.invoice_id = payment.invoice_id AND other.external_id = payment.external_id
          AND other.deleted_at IS NULL AND other.id <> payment.id
      ) THEN
        RETURN 'This payment was recorded again after it was removed.';
      END IF;
    ELSE
      NULL;
  END CASE;
  RETURN NULL;
END;
$$;

-- The audit log's name for a record type (the same names the API logs).
CREATE OR REPLACE FUNCTION public.trash_entity_type(p_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'projects' THEN 'project'
    WHEN 'tasks' THEN 'task'
    WHEN 'task_subtasks' THEN 'subtask'
    WHEN 'task_comments' THEN 'comment'
    WHEN 'task_files' THEN 'task_file'
    WHEN 'reminders' THEN 'reminder'
    WHEN 'project_credentials' THEN 'credential'
    WHEN 'entity_files' THEN 'entity_file'
    WHEN 'portal_updates' THEN 'portal_update'
    WHEN 'portal_update_attachments' THEN 'portal_update_attachment'
    WHEN 'contacts' THEN 'contact'
    WHEN 'leads' THEN 'lead'
    WHEN 'lead_interactions' THEN 'lead_interaction'
    WHEN 'lead_proposals' THEN 'lead_proposal'
    WHEN 'lead_fields' THEN 'lead_field'
    WHEN 'project_time_entries' THEN 'time_entry'
    WHEN 'project_invoices' THEN 'invoice'
    WHEN 'invoice_payments' THEN 'invoice_payment'
    WHEN 'project_hourly_rates' THEN 'project_hourly_rate'
    WHEN 'project_retainers' THEN 'retainer'
    WHEN 'project_retainer_amounts' THEN 'retainer_amount'
    ELSE p_table
  END
$$;

-- One audit row for a Trash move or restore by a signed-in member (the app).
-- Server routes on the service role log their own, with the API key.
CREATE OR REPLACE FUNCTION public.audit_trash_change(
  p_table text, p_id uuid, p_restore boolean, p_before jsonb, p_after jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  hidden text[] := ARRAY['encrypted_data', 'iv', 'hourly_rate', 'compensation_rate', 'billing_multiplier',
    'budget_type', 'budget_value', 'billing_address', 'billing_email', 'tax_rate', 'invoice_pdf_options'];
BEGIN
  INSERT INTO public.api_audit_log (
    method, endpoint, entity_type, entity_id, team_member_id, before_snapshot, after_snapshot, status_code, via
  ) VALUES (
    CASE WHEN p_restore THEN 'POST' ELSE 'DELETE' END,
    '/app/trash/' || p_table || '/' || p_id::text || CASE WHEN p_restore THEN '/restore' ELSE '' END,
    public.trash_entity_type(p_table), p_id, public.current_team_member_id(),
    -- Not the credential secrets, client rates or pay rates: audit readers
    -- are not necessarily allowed to see those.
    p_before - hidden, p_after - hidden, 200, 'app'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.soft_delete_record(p_table text, p_id uuid, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
  actor uuid;
  changed integer;
  found_row boolean;
  before jsonb;
  after jsonb;
BEGIN
  IF NOT p_table = ANY (public.trash_record_types()) THEN
    RAISE EXCEPTION 'Trash does not handle %', p_table USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1)', p_table) INTO found_row USING p_id;
  IF NOT found_row THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  IF is_service THEN
    actor := p_actor;
  ELSE
    IF NOT public.can_trash_record(p_table, p_id) THEN
      RAISE EXCEPTION 'You do not have permission to delete this' USING ERRCODE = '42501';
    END IF;
    actor := public.current_team_member_id();
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id = $1', p_table) INTO before USING p_id;
  EXECUTE format('UPDATE public.%I t SET deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING to_jsonb(t)', p_table)
    INTO after USING actor, p_id;
  changed := CASE WHEN after IS NULL THEN 0 ELSE 1 END;
  IF changed > 0 AND NOT is_service THEN
    PERFORM public.audit_trash_change(p_table, p_id, false, before, after);
  END IF;
  RETURN changed > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_record(p_table text, p_id uuid, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
  blocker text;
  changed integer;
  found_row boolean;
  before jsonb;
  after jsonb;
BEGIN
  IF NOT p_table = ANY (public.trash_record_types()) THEN
    RAISE EXCEPTION 'Trash does not handle %', p_table USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1)', p_table) INTO found_row USING p_id;
  IF NOT found_row THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  blocker := public.trash_restore_blocker(p_table, p_id);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', blocker USING ERRCODE = '55000';
  END IF;
  IF NOT is_service AND NOT public.can_trash_record(p_table, p_id) THEN
    RAISE EXCEPTION 'You do not have permission to restore this' USING ERRCODE = '42501';
  END IF;
  -- Restoring re-runs the record's own rules (an invoice links its hours
  -- and retainer period again); a clash with what happened meanwhile
  -- refuses it, saying why.
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id = $1', p_table) INTO before USING p_id;
  BEGIN
    EXECUTE format('UPDATE public.%I t SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING to_jsonb(t)', p_table)
      INTO after USING p_id;
    changed := CASE WHEN after IS NULL THEN 0 ELSE 1 END;
  EXCEPTION WHEN raise_exception THEN
    RAISE EXCEPTION 'It cannot come back as it was: %', SQLERRM USING ERRCODE = '55000';
  END;
  IF changed > 0 AND NOT is_service THEN
    PERFORM public.audit_trash_change(p_table, p_id, true, before, after);
  END IF;
  -- Retainer months that came due while it (or its project) was in Trash
  -- are skipped, as a pause skips them: restoring never back-bills.
  IF changed > 0 AND p_table IN ('projects', 'project_retainers') THEN
    INSERT INTO public.project_retainer_periods (retainer_id, period_start, period_end, status)
    SELECT due.retainer_id, due.period_start, due.period_end, 'skipped'
    FROM public.retainer_due_periods_internal(
      CASE WHEN p_table = 'projects' THEN p_id ELSE (after->>'project_id')::uuid END,
      public.workspace_today()) due
    WHERE (p_table = 'projects' OR due.retainer_id = p_id)
      AND due.bill_date >= ((before->>'deleted_at')::timestamptz AT TIME ZONE public.workspace_timezone())::date
    ON CONFLICT (retainer_id, period_start) DO NOTHING;
  END IF;
  RETURN changed > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.project_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.task_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lead_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.contact_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.credential_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_update_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.file_entity_is_live(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.task_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lead_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.contact_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.credential_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.portal_update_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.file_entity_is_live(text, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.forbid_hard_delete() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trash_record_types() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_trash_record(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trash_restore_blocker(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.soft_delete_record(text, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_record(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trash_record_types() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_trash_record(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trash_restore_blocker(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_record(text, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.restore_record(text, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Soft delete, billing (migration 20261022041249_soft_delete_billing.sql)
-- ---------------------------------------------------------------------------
-- Time entries, invoices, payments, project hourly rates, retainers and
-- retainer amounts go to Trash the same way. An invoice in Trash lets go of
-- its hours and retainer period and retires its split earnings (see
-- reconcile_invoice_retainer_lines); restoring links them again. Time on an
-- invoice or in a payout, and an invoice with payments recorded by an
-- accounting connection, cannot go to Trash (guard_trash).

CREATE INDEX IF NOT EXISTS idx_project_time_entries_deleted_at ON public.project_time_entries (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_invoices_deleted_at ON public.project_invoices (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_payments_deleted_at ON public.invoice_payments (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_hourly_rates_deleted_at ON public.project_hourly_rates (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_retainers_deleted_at ON public.project_retainers (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_retainer_amounts_deleted_at ON public.project_retainer_amounts (deleted_at DESC) WHERE deleted_at IS NOT NULL;

CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.project_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.project_time_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.project_invoices
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.invoice_payments
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.project_hourly_rates
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.project_hourly_rates
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.project_retainers
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.project_retainers
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.project_retainer_amounts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.project_retainer_amounts
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();

CREATE POLICY project_time_entries_not_deleted ON public.project_time_entries AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY project_invoices_not_deleted ON public.project_invoices AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY invoice_payments_not_deleted ON public.invoice_payments AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY project_hourly_rates_not_deleted ON public.project_hourly_rates AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY project_retainers_not_deleted ON public.project_retainers AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY project_retainer_amounts_not_deleted ON public.project_retainer_amounts AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);

CREATE OR REPLACE FUNCTION public.invoice_is_live(p_invoice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_invoices invoice
    JOIN public.projects project ON project.id = invoice.project_id
    WHERE invoice.id = p_invoice_id AND invoice.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.time_entry_is_live(p_entry_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_time_entries entry
    JOIN public.projects project ON project.id = entry.project_id
    WHERE entry.id = p_entry_id AND entry.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.retainer_is_live(p_retainer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    JOIN public.projects project ON project.id = retainer.project_id
    WHERE retainer.id = p_retainer_id AND retainer.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE POLICY invoice_payments_parent_live ON public.invoice_payments AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.invoice_is_live(invoice_id));
CREATE POLICY invoice_time_entry_allocations_parent_live ON public.invoice_time_entry_allocations AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.invoice_is_live(invoice_id));
CREATE POLICY invoice_line_shares_parent_live ON public.invoice_line_shares AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.invoice_is_live(invoice_id));
CREATE POLICY billing_draft_notices_parent_live ON public.billing_draft_notices AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id) AND public.invoice_is_live(invoice_id));
CREATE POLICY project_retainer_amounts_parent_live ON public.project_retainer_amounts AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.retainer_is_live(retainer_id));
CREATE POLICY project_retainer_shares_parent_live ON public.project_retainer_shares AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.retainer_is_live(retainer_id));
CREATE POLICY project_retainer_periods_parent_live ON public.project_retainer_periods AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.retainer_is_live(retainer_id));
CREATE POLICY time_entry_tasks_parent_live ON public.time_entry_tasks AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id) AND public.time_entry_is_live(time_entry_id));

-- Why a record cannot go to Trash, as a sentence for the person deleting
-- it; null when nothing stops it. The rules the foreign keys and DELETE
-- triggers used to enforce.
CREATE OR REPLACE FUNCTION public.trash_delete_blocker(p_table text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_number text;
BEGIN
  CASE p_table
    WHEN 'project_time_entries' THEN
      SELECT invoice.invoice_number INTO v_number
      FROM public.invoice_time_entry_allocations allocation
      JOIN public.project_invoices invoice ON invoice.id = allocation.invoice_id
      WHERE allocation.time_entry_id = p_id AND invoice.deleted_at IS NULL
      ORDER BY invoice.created_at
      LIMIT 1;
      IF FOUND THEN
        RETURN 'This time is on invoice ' || v_number || '. Take it off the invoice first.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.team_member_payout_allocations allocation
        JOIN public.team_member_payouts payout ON payout.id = allocation.payout_id
        WHERE allocation.time_entry_id = p_id AND payout.voided_at IS NULL
      ) THEN
        RETURN 'This time is in a team member payout. Void the payout first.';
      END IF;
    WHEN 'project_invoices' THEN
      IF EXISTS (
        SELECT 1 FROM public.invoice_payments
        WHERE invoice_id = p_id AND recorded_via = 'api' AND deleted_at IS NULL
      ) THEN
        RETURN 'PAYMENT_RECORDED_ELSEWHERE: This invoice has payments recorded by an accounting connection. Remove them there first.';
      END IF;
    ELSE
      NULL;
  END CASE;
  RETURN NULL;
END;
$$;

-- Every way into Trash (the RPC, a server route, a trigger) meets the same
-- rules, so time on an invoice or an invoice pinned by an accounting
-- connection cannot slip in through a direct update.
CREATE OR REPLACE FUNCTION public.guard_trash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  blocker text;
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    blocker := public.trash_delete_blocker(TG_TABLE_NAME, OLD.id);
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION '%', blocker USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_trash BEFORE UPDATE OF deleted_at ON public.project_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_trash();
CREATE TRIGGER guard_trash BEFORE UPDATE OF deleted_at ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_trash();

REVOKE ALL ON FUNCTION public.invoice_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.time_entry_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.retainer_is_live(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.time_entry_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retainer_is_live(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.trash_delete_blocker(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guard_trash() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trash_delete_blocker(text, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.trash_entity_type(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.audit_trash_change(text, uuid, boolean, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trash_entity_type(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The Trash list (migration 20261022053626_list_trash.sql): what the caller
-- may restore, with where it lived, who deleted it and what blocks a restore.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_trash(p_types text[] DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS TABLE (
  record_type text,
  id uuid,
  label text,
  context text,
  project_id uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_name text,
  blocker text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  spec record;
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
BEGIN
  IF NOT is_service AND public.current_team_member_id() IS NULL THEN
    RETURN;
  END IF;
  FOR spec IN
    SELECT * FROM (VALUES
      ('projects', 'r.name', 'NULL', 'r.id', ''),
      ('tasks', 'r.title', 'CASE WHEN parent.id IS NULL THEN p.name ELSE ''Subtask of '' || parent.title END', 'r.project_id',
        'LEFT JOIN public.projects p ON p.id = r.project_id LEFT JOIN public.tasks parent ON parent.id = r.parent_task_id'),
      ('task_comments', 'left(r.text, 120)', 't.title', 't.project_id', 'LEFT JOIN public.tasks t ON t.id = r.task_id'),
      ('task_files', 'r.name', 't.title', 't.project_id', 'LEFT JOIN public.tasks t ON t.id = r.task_id'),
      ('reminders', 'r.title', 'coalesce(t.title, p.name)', 'r.project_id',
        'LEFT JOIN public.tasks t ON t.id = r.task_id LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_credentials', 'r.label', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('entity_files', 'r.name',
        'CASE r.entity_type WHEN ''project'' THEN (SELECT name FROM public.projects WHERE id = r.entity_id)
           WHEN ''lead'' THEN (SELECT name FROM public.leads WHERE id = r.entity_id)
           WHEN ''contact'' THEN (SELECT name FROM public.contacts WHERE id = r.entity_id) END',
        'CASE WHEN r.entity_type = ''project'' THEN r.entity_id END', ''),
      ('portal_updates', 'r.title', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('portal_update_attachments', 'r.name', 'u.title', 'u.project_id', 'LEFT JOIN public.portal_updates u ON u.id = r.update_id'),
      ('contacts', 'r.name', 'NULL', 'NULL', ''),
      ('leads', 'r.name', 'NULL', 'NULL', ''),
      ('lead_interactions', 'r.title', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('lead_proposals', 'r.title', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('lead_fields', 'r.field_key || '': '' || left(r.value, 80)', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('project_time_entries',
        'coalesce(nullif(btrim(r.description), ''''), ''Time entry'') || '' ('' || to_char(r.start_time AT TIME ZONE public.workspace_timezone(), ''Mon FMDD, YYYY'') || '')''',
        'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_invoices', 'r.invoice_number || '' ($'' || to_char(r.amount, ''FM999,999,990.00'') || '')''', 'p.name', 'r.project_id',
        'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('invoice_payments', '''Payment of $'' || to_char(r.amount, ''FM999,999,990.00'') || '' on '' || i.invoice_number', 'p.name', 'i.project_id',
        'LEFT JOIN public.project_invoices i ON i.id = r.invoice_id LEFT JOIN public.projects p ON p.id = i.project_id'),
      ('project_hourly_rates', '''$'' || to_char(r.hourly_rate, ''FM999,990.00'') || ''/hr from '' || to_char(r.effective_at AT TIME ZONE public.workspace_timezone(), ''Mon FMDD, YYYY'')',
        'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_retainers', 'r.name', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_retainer_amounts', 'rt.name || '': $'' || to_char(r.amount, ''FM999,999,990.00'') || '' from '' || to_char(r.effective_date, ''Mon FMDD, YYYY'')',
        'p.name', 'rt.project_id',
        'LEFT JOIN public.project_retainers rt ON rt.id = r.retainer_id LEFT JOIN public.projects p ON p.id = rt.project_id')
    ) AS specs(record_type, label_sql, context_sql, project_sql, join_sql)
  LOOP
    CONTINUE WHEN p_types IS NOT NULL AND NOT spec.record_type = ANY (p_types);
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, r.id, (%s)::text, (%s)::text, (%s)::uuid, r.deleted_at, r.deleted_by, m.name::text,
              public.trash_restore_blocker(%L, r.id)
       FROM public.%I r %s
       LEFT JOIN public.team_members m ON m.id = r.deleted_by
       WHERE r.deleted_at IS NOT NULL AND ($1 OR public.can_trash_record(%L, r.id))
       ORDER BY r.deleted_at DESC
       LIMIT %s',
      spec.record_type, spec.label_sql, spec.context_sql, spec.project_sql, spec.record_type,
      spec.record_type, spec.join_sql, spec.record_type, greatest(1, least(coalesce(p_limit, 500), 2000)))
    USING is_service;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.list_trash(text[], integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_trash(text[], integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Soft delete review fixes (migration 20261022063149_soft_delete_review_fixes.sql)
-- ---------------------------------------------------------------------------
-- A contact in Trash keeps its project and lead links (so a restore brings
-- them back), but it must not hold the one primary client slot: setting a
-- new primary client lets go of a trashed one, which the person setting it
-- cannot see.
CREATE OR REPLACE FUNCTION public.release_trashed_primary_client()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_primary_client THEN
    IF TG_TABLE_NAME = 'project_contacts' THEN
      UPDATE public.project_contacts link
      SET is_primary_client = false
      FROM public.contacts contact
      WHERE link.project_id = NEW.project_id AND link.id <> NEW.id AND link.is_primary_client
        AND contact.id = link.contact_id AND contact.deleted_at IS NOT NULL;
    ELSE
      UPDATE public.lead_contacts link
      SET is_primary_client = false
      FROM public.contacts contact
      WHERE link.lead_id = NEW.lead_id AND link.id <> NEW.id AND link.is_primary_client
        AND contact.id = link.contact_id AND contact.deleted_at IS NOT NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER release_trashed_primary_client
  BEFORE INSERT OR UPDATE OF is_primary_client ON public.project_contacts
  FOR EACH ROW EXECUTE FUNCTION public.release_trashed_primary_client();
CREATE TRIGGER release_trashed_primary_client
  BEFORE INSERT OR UPDATE OF is_primary_client ON public.lead_contacts
  FOR EACH ROW EXECUTE FUNCTION public.release_trashed_primary_client();

-- Trash moves and restores, as pings for live sync. A soft delete is an
-- UPDATE that the viewer can no longer see, so it never reaches other open
-- screens through the table itself; this row does. Only the table and id.
CREATE TABLE IF NOT EXISTS public.trash_events (
  id bigserial PRIMARY KEY,
  table_name text NOT NULL,
  record_id uuid NOT NULL,
  restored boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trash_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trash_events_select ON public.trash_events;
CREATE POLICY trash_events_select ON public.trash_events FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.trash_events FROM anon, authenticated;
GRANT SELECT ON public.trash_events TO authenticated;
GRANT ALL ON public.trash_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_trash_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.trash_events (table_name, record_id, restored)
  VALUES (TG_TABLE_NAME, NEW.id, NEW.deleted_at IS NULL);
  RETURN NULL;
END;
$$;

CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.projects
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.tasks
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.task_subtasks
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.task_comments
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.reminders
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.project_credentials
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.entity_files
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.portal_updates
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.portal_update_attachments
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.contacts
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.leads
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.lead_interactions
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.lead_proposals
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.lead_fields
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.project_time_entries
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.project_invoices
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.invoice_payments
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.project_hourly_rates
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.project_retainers
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.project_retainer_amounts
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'trash_events') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trash_events;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.release_trashed_primary_client() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_trash_event() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Team activity log (migration 20261022074722_team_activity_log.sql)
-- ---------------------------------------------------------------------------
-- What people on the team do is logged in public.activities, apart from the
-- agents' own typed log (agent_activities). Triggers write it, so every path
-- is covered: the browser, the session routes, the v1 API and MCP. Each row
-- carries a sentence composed when it happened (names as they were then) and
-- a metadata payload for links. Nothing is ever deleted from it.
--
-- Who did it: the signed-in member, or for service-role writes the
-- x-actor-member-id request header the server sends (honoured only for the
-- service role, so a browser cannot claim to be someone else). Agents, cron
-- jobs and anything without a person behind it are not logged here.

-- ---------------------------------------------------------------------------
-- Who and how
-- ---------------------------------------------------------------------------
-- The person behind the current write, or NULL when it is an agent, a cron
-- job or anything else without a person behind it.
CREATE OR REPLACE FUNCTION public.activity_actor()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member uuid;
  v_header text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_member := public.current_team_member_id();
  ELSIF coalesce(auth.role(), '') = 'service_role' THEN
    BEGIN
      v_header := nullif(current_setting('request.headers', true), '')::json ->> 'x-actor-member-id';
      IF v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_member := v_header::uuid;
      END IF;
    EXCEPTION WHEN others THEN
      v_member := NULL;
    END;
  END IF;
  IF v_member IS NULL THEN
    RETURN NULL;
  END IF;
  -- Agents keep their own typed log; only people land here.
  IF NOT EXISTS (SELECT 1 FROM public.team_members WHERE id = v_member AND role <> 'agent') THEN
    RETURN NULL;
  END IF;
  RETURN v_member;
END;
$$;

-- Where the write came from: the app for a signed-in member, otherwise what
-- the server said (api or mcp).
CREATE OR REPLACE FUNCTION public.activity_source()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_via text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN 'app';
  END IF;
  BEGIN
    v_via := nullif(current_setting('request.headers', true), '')::json ->> 'x-actor-via';
  EXCEPTION WHEN others THEN
    v_via := NULL;
  END;
  RETURN CASE WHEN v_via IN ('app', 'api', 'mcp') THEN v_via ELSE 'api' END;
END;
$$;

-- ---------------------------------------------------------------------------
-- Small formatting helpers for the sentences
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activity_hours_label(p_hours numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN coalesce(round(p_hours * 60), 0) <= 0 THEN '0m'
    WHEN round(p_hours * 60)::int / 60 = 0 THEN (round(p_hours * 60)::int % 60) || 'm'
    WHEN round(p_hours * 60)::int % 60 = 0 THEN (round(p_hours * 60)::int / 60) || 'h'
    ELSE (round(p_hours * 60)::int / 60) || 'h ' || (round(p_hours * 60)::int % 60) || 'm'
  END
$$;

CREATE OR REPLACE FUNCTION public.activity_money_label(p_amount numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '$' || trim(to_char(coalesce(p_amount, 0), 'FM999,999,999,990.00'))
$$;

CREATE OR REPLACE FUNCTION public.activity_status_label(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'todo' THEN 'To do'
    ELSE upper(left(p_status, 1)) || replace(substr(p_status, 2), '_', ' ')
  END
$$;

CREATE OR REPLACE FUNCTION public.activity_member_name(p_member_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((SELECT name FROM public.team_members WHERE id = p_member_id), 'someone')
$$;

-- Columns whose values differ between two versions of a row, leaving out the
-- ones that change on their own (timestamps, ordering) or are logged apart.
CREATE OR REPLACE FUNCTION public.activity_changed_fields(p_new jsonb, p_old jsonb, p_ignore text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(array_agg(key ORDER BY key), ARRAY[]::text[])
  FROM jsonb_each(p_new) AS n(key, value)
  WHERE NOT (key = ANY (p_ignore))
    AND n.value IS DISTINCT FROM p_old -> key
$$;

-- The activity entity name for a Trash table.
CREATE OR REPLACE FUNCTION public.activity_entity_type(p_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'entity_files' THEN 'file'
    WHEN 'task_files' THEN 'file'
    WHEN 'invoice_payments' THEN 'payment'
    WHEN 'project_hourly_rates' THEN 'hourly_rate'
    ELSE public.trash_entity_type(p_table)
  END
$$;

CREATE OR REPLACE FUNCTION public.activity_entity_noun(p_entity_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_entity_type
    WHEN 'time_entry' THEN 'time entry'
    WHEN 'portal_update' THEN 'portal update'
    WHEN 'portal_update_attachment' THEN 'portal attachment'
    WHEN 'lead_interaction' THEN 'lead interaction'
    WHEN 'lead_proposal' THEN 'proposal'
    WHEN 'lead_field' THEN 'lead field'
    WHEN 'hourly_rate' THEN 'hourly rate'
    WHEN 'retainer_amount' THEN 'retainer amount'
    ELSE p_entity_type
  END
$$;

-- ---------------------------------------------------------------------------
-- Writing a row
-- ---------------------------------------------------------------------------
-- Logs one thing a person did. Repeated edits ("*.updated") by the same
-- person on the same record within 15 minutes fold into one row, moved up to
-- the latest edit, so typing in a description does not flood the feed.
CREATE OR REPLACE FUNCTION public.log_team_activity(
  p_type text,
  p_entity_type text,
  p_entity_id text,
  p_project_id uuid,
  p_description text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := public.activity_actor();
  v_existing uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN;
  END IF;

  IF p_type LIKE '%.updated' THEN
    SELECT id INTO v_existing
    FROM public.activities
    WHERE user_id = v_actor AND type = p_type AND entity_id = p_entity_id
      AND updated_at > now() - interval '15 minutes'
    ORDER BY updated_at DESC
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      UPDATE public.activities
      SET description = p_description,
          metadata = metadata || coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('fields', (
            SELECT coalesce(jsonb_agg(DISTINCT field ORDER BY field), '[]'::jsonb)
            FROM jsonb_array_elements_text(coalesce(metadata -> 'fields', '[]'::jsonb) || coalesce(p_metadata -> 'fields', '[]'::jsonb)) AS field
          )),
          created_at = now(),
          updated_at = now()
      WHERE id = v_existing;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, source)
  VALUES (p_type, p_entity_type, p_entity_id, p_project_id, v_actor, p_description, coalesce(p_metadata, '{}'::jsonb), public.activity_source());
END;
$$;

-- ---------------------------------------------------------------------------
-- Who may read a row
-- ---------------------------------------------------------------------------
-- Anyone who can open the project sees its team activity, except money, time
-- and credential events, which need the permission that shows those things.
-- A project in Trash hides its activity; standalone reminders stay private.
CREATE OR REPLACE FUNCTION public.can_read_activity(
  p_entity_type text,
  p_entity_id text,
  p_project_id uuid,
  p_actor uuid,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_project_id IS NOT NULL AND NOT public.project_is_live(p_project_id) THEN false
    WHEN p_actor = public.current_team_member_id() THEN true
    WHEN p_entity_type = 'reminder' AND p_project_id IS NULL THEN false
    WHEN public.has_permission('audit.read') THEN true
    WHEN p_project_id IS NULL THEN CASE
      WHEN p_entity_type = 'contact' THEN public.has_permission('contacts.read_all')
      WHEN p_metadata ? 'lead_id' THEN public.can_access_lead((p_metadata ->> 'lead_id')::uuid)
      ELSE false
    END
    WHEN NOT (public.has_permission('projects.read_all')
      OR (public.has_permission('projects.read') AND public.can_access_project(p_project_id))) THEN false
    ELSE CASE
      WHEN p_entity_type IN ('task', 'subtask', 'comment') THEN
        public.has_permission('tasks.read')
        OR coalesce(public.can_access_task((p_metadata ->> 'task_id')::uuid), false)
      WHEN p_entity_type = 'time_entry' THEN public.has_permission('time.read_all')
      WHEN p_entity_type IN ('invoice', 'payment', 'hourly_rate', 'retainer', 'retainer_amount') THEN public.has_permission('invoices.read')
      WHEN p_entity_type = 'credential' THEN public.has_permission('credentials.manage')
      WHEN p_entity_type = 'file' THEN public.has_permission('files.read')
      WHEN p_entity_type IN ('portal_update', 'portal_update_attachment') THEN public.has_permission('portal.read')
      WHEN p_entity_type = 'communication' THEN public.has_permission('communications.read')
      WHEN p_entity_type = 'contact' THEN public.has_permission('contacts.read') OR public.has_permission('contacts.read_all')
      ELSE true
    END
  END
$$;

CREATE POLICY activities_select ON public.activities FOR SELECT TO authenticated
  USING (public.can_read_activity(entity_type, entity_id, project_id, user_id, metadata));

-- ---------------------------------------------------------------------------
-- What gets logged
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_task_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('task_id', NEW.id, 'task_title', NEW.title);
  v_fields text[];
  v_ignore text[] := ARRAY['status', 'sort_order', 'completed_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by', 'parent_task_id'];
  v_parent record;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT id, title INTO v_parent FROM public.tasks WHERE id = NEW.parent_task_id;
    v_meta := v_meta || jsonb_build_object('parent_task_id', v_parent.id, 'parent_task_title', v_parent.title);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_task_id IS NOT NULL THEN
      PERFORM public.log_team_activity('subtask.added', 'task', NEW.id::text, NEW.project_id,
        format('Added subtask "%s" to "%s"', NEW.title, v_parent.title), v_meta);
    ELSE
      PERFORM public.log_team_activity('task.created', 'task', NEW.id::text, NEW.project_id,
        format('Created task "%s"', NEW.title), v_meta);
    END IF;
    RETURN NULL;
  END IF;
  -- The Trash trigger logs moves to Trash and restores.
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'done' THEN
      PERFORM public.log_team_activity('task.completed', 'task', NEW.id::text, NEW.project_id,
        format('Completed task "%s"', NEW.title), v_meta);
    ELSIF OLD.status = 'done' THEN
      PERFORM public.log_team_activity('task.reopened', 'task', NEW.id::text, NEW.project_id,
        format('Reopened task "%s"', NEW.title), v_meta);
    ELSE
      PERFORM public.log_team_activity('task.moved', 'task', NEW.id::text, NEW.project_id,
        format('Moved task "%s" to %s', NEW.title, public.activity_status_label(NEW.status)),
        v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
    END IF;
  END IF;

  IF NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id THEN
    IF NEW.parent_task_id IS NOT NULL THEN
      PERFORM public.log_team_activity('task.nested', 'task', NEW.id::text, NEW.project_id,
        format('Moved "%s" under "%s"', NEW.title, v_parent.title), v_meta);
    ELSE
      PERFORM public.log_team_activity('task.promoted', 'task', NEW.id::text, NEW.project_id,
        format('Made "%s" a top-level task', NEW.title), v_meta || jsonb_build_object('from_parent_task_id', OLD.parent_task_id));
    END IF;
  END IF;

  -- A subtask's project follows its parent: the parent's move (or the
  -- nesting above) already says so.
  IF NEW.parent_task_id IS NOT NULL THEN
    v_ignore := v_ignore || ARRAY['project_id', 'project_goal_id'];
  END IF;
  v_fields := public.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD), v_ignore);
  IF cardinality(v_fields) > 0 THEN
    PERFORM public.log_team_activity('task.updated', 'task', NEW.id::text, NEW.project_id,
      format('Edited task "%s"', NEW.title), v_meta || jsonb_build_object('fields', to_jsonb(v_fields)));
  END IF;
  RETURN NULL;
END;
$$;

-- Assignments. A task's own creation already says "Created task", so the
-- assignees saved with it are not logged again.
CREATE OR REPLACE FUNCTION public.log_task_assignee_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task_id uuid;
  v_member uuid;
  v_task record;
  v_self boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_task_id := NEW.task_id;
    v_member := NEW.member_id;
  ELSE
    v_task_id := OLD.task_id;
    v_member := OLD.member_id;
  END IF;
  SELECT id, title, project_id, created_at, deleted_at INTO v_task FROM public.tasks WHERE id = v_task_id;
  IF v_task.id IS NULL OR v_task.deleted_at IS NOT NULL OR v_task.created_at >= now() THEN
    RETURN NULL;
  END IF;
  v_self := v_member = public.activity_actor();
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('task.assigned', 'task', v_task.id::text, v_task.project_id,
      CASE WHEN v_self THEN format('Took on task "%s"', v_task.title)
        ELSE format('Assigned %s to task "%s"', public.activity_member_name(v_member), v_task.title) END,
      jsonb_build_object('task_id', v_task.id, 'task_title', v_task.title, 'member_id', v_member));
  ELSE
    PERFORM public.log_team_activity('task.unassigned', 'task', v_task.id::text, v_task.project_id,
      CASE WHEN v_self THEN format('Stepped off task "%s"', v_task.title)
        ELSE format('Unassigned %s from task "%s"', public.activity_member_name(v_member), v_task.title) END,
      jsonb_build_object('task_id', v_task.id, 'task_title', v_task.title, 'member_id', v_member));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_subtask_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task record;
  v_meta jsonb;
BEGIN
  SELECT id, title, project_id, created_at INTO v_task FROM public.tasks WHERE id = NEW.task_id;
  IF v_task.id IS NULL THEN
    RETURN NULL;
  END IF;
  v_meta := jsonb_build_object('task_id', v_task.id, 'task_title', v_task.title, 'subtask_title', NEW.title);
  IF TG_OP = 'INSERT' THEN
    IF v_task.created_at < now() THEN
      PERFORM public.log_team_activity('subtask.added', 'subtask', NEW.id::text, v_task.project_id,
        format('Added subtask "%s" to "%s"', NEW.title, v_task.title), v_meta);
    END IF;
  ELSIF NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at AND NEW.completed AND NOT OLD.completed THEN
    PERFORM public.log_team_activity('subtask.completed', 'subtask', NEW.id::text, v_task.project_id,
      format('Checked off "%s" on "%s"', NEW.title, v_task.title), v_meta);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_comment_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task record;
BEGIN
  SELECT id, title, project_id INTO v_task FROM public.tasks WHERE id = NEW.task_id;
  IF v_task.id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM public.log_team_activity('comment.added', 'comment', NEW.id::text, v_task.project_id,
    format('Commented on "%s"', v_task.title),
    jsonb_build_object('task_id', v_task.id, 'task_title', v_task.title, 'preview', left(NEW.text, 140)));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_project_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('project_name', NEW.name);
  v_fields text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('project.created', 'project', NEW.id::text, NEW.id,
      format('Created project "%s"', NEW.name), v_meta);
    RETURN NULL;
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.log_team_activity('project.status', 'project', NEW.id::text, NEW.id,
      CASE NEW.status
        WHEN 'completed' THEN format('Marked project "%s" completed', NEW.name)
        WHEN 'archived' THEN format('Archived project "%s"', NEW.name)
        ELSE format('Set project "%s" back to active', NEW.name)
      END,
      v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;

  v_fields := public.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD),
    ARRAY['status', 'archived_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by']);
  IF cardinality(v_fields) > 0 THEN
    PERFORM public.log_team_activity('project.updated', 'project', NEW.id::text, NEW.id,
      format('Edited project "%s"', NEW.name), v_meta || jsonb_build_object('fields', to_jsonb(v_fields)));
  END IF;
  RETURN NULL;
END;
$$;

-- Members and linked contacts. The ones saved with a new project come with
-- "Created project", so the first two minutes of a project are not logged.
CREATE OR REPLACE FUNCTION public.log_project_member_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_member uuid;
  v_project record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_project_id := NEW.project_id;
    v_member := NEW.member_id;
  ELSE
    v_project_id := OLD.project_id;
    v_member := OLD.member_id;
  END IF;
  SELECT id, name, created_at, deleted_at INTO v_project FROM public.projects WHERE id = v_project_id;
  IF v_project.id IS NULL OR v_project.deleted_at IS NOT NULL OR v_project.created_at > now() - interval '2 minutes' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('member.added', 'member', v_member::text, v_project.id,
      format('Added %s to project "%s"', public.activity_member_name(v_member), v_project.name),
      jsonb_build_object('member_id', v_member, 'project_name', v_project.name));
  ELSE
    PERFORM public.log_team_activity('member.removed', 'member', v_member::text, v_project.id,
      format('Removed %s from project "%s"', public.activity_member_name(v_member), v_project.name),
      jsonb_build_object('member_id', v_member, 'project_name', v_project.name));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_project_contact_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project record;
  v_contact_name text;
BEGIN
  SELECT id, name, created_at, deleted_at INTO v_project FROM public.projects WHERE id = NEW.project_id;
  IF v_project.id IS NULL OR v_project.deleted_at IS NOT NULL OR v_project.created_at > now() - interval '2 minutes' THEN
    RETURN NULL;
  END IF;
  SELECT name INTO v_contact_name FROM public.contacts WHERE id = NEW.contact_id;
  PERFORM public.log_team_activity('contact.linked', 'contact', NEW.contact_id::text, v_project.id,
    format('Linked %s to project "%s"', coalesce(v_contact_name, 'a contact'), v_project.name),
    jsonb_build_object('contact_id', NEW.contact_id, 'project_name', v_project.name));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_time_entry_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hours numeric;
  v_project_name text;
  v_meta jsonb;
  v_for text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  v_hours := public.time_entry_worked_hours(NEW.segments, NEW.start_time, NEW.end_time);
  SELECT name INTO v_project_name FROM public.projects WHERE id = NEW.project_id;
  v_meta := jsonb_build_object('time_entry_id', NEW.id, 'member_id', NEW.member_id, 'hours', round(v_hours, 2),
    'note', left(coalesce(NEW.description, ''), 140), 'project_name', v_project_name);
  v_for := CASE WHEN NEW.member_id = public.activity_actor() THEN ''
    ELSE ' for ' || public.activity_member_name(NEW.member_id) END;

  -- Time is "logged" when it has an end: entered whole, or a timer stopped.
  IF NEW.end_time IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.end_time IS NULL) THEN
    PERFORM public.log_team_activity('time.logged', 'time_entry', NEW.id::text, NEW.project_id,
      format('Logged %s%s', public.activity_hours_label(v_hours), v_for), v_meta);
  END IF;

  -- A review decision on finished time. The approval the workspace grants by
  -- itself as time is logged (owners, auto-approve) is not a person's review.
  IF TG_OP = 'UPDATE' AND OLD.end_time IS NOT NULL AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    IF NEW.approval_status = 'approved' THEN
      PERFORM public.log_team_activity('time.approved', 'time_entry', NEW.id::text, NEW.project_id,
        format('Approved %s from %s', public.activity_hours_label(v_hours), public.activity_member_name(NEW.member_id)), v_meta);
    ELSIF NEW.approval_status = 'rejected' THEN
      PERFORM public.log_team_activity('time.rejected', 'time_entry', NEW.id::text, NEW.project_id,
        format('Sent back %s from %s', public.activity_hours_label(v_hours), public.activity_member_name(NEW.member_id)),
        v_meta || jsonb_build_object('reason', left(coalesce(NEW.rejection_reason, ''), 200)));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_invoice_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('invoice_id', NEW.id, 'invoice_number', NEW.invoice_number, 'amount', NEW.amount);
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('invoice.created', 'invoice', NEW.id::text, NEW.project_id,
      format('Created invoice %s', NEW.invoice_number), v_meta);
    RETURN NULL;
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  PERFORM public.log_team_activity('invoice.' || NEW.status, 'invoice', NEW.id::text, NEW.project_id,
    CASE NEW.status
      WHEN 'sent' THEN format('Sent invoice %s', NEW.invoice_number)
      WHEN 'paid' THEN format('Marked invoice %s paid', NEW.invoice_number)
      WHEN 'cancelled' THEN format('Cancelled invoice %s', NEW.invoice_number)
      WHEN 'overdue' THEN format('Marked invoice %s overdue', NEW.invoice_number)
      ELSE format('Moved invoice %s back to draft', NEW.invoice_number)
    END,
    v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_payment_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice record;
BEGIN
  SELECT id, project_id, invoice_number INTO v_invoice FROM public.project_invoices WHERE id = NEW.invoice_id;
  IF v_invoice.id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM public.log_team_activity('payment.recorded', 'payment', NEW.id::text, v_invoice.project_id,
    format('Recorded a %s payment on invoice %s', public.activity_money_label(NEW.amount), v_invoice.invoice_number),
    jsonb_build_object('invoice_id', v_invoice.id, 'invoice_number', v_invoice.invoice_number, 'amount', NEW.amount));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_file_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_task_id uuid;
  v_task_title text;
  v_meta jsonb := jsonb_build_object('file_name', NEW.name, 'entity_type', NEW.entity_type, 'entity_id', NEW.entity_id);
BEGIN
  IF NEW.entity_type = 'project' THEN
    v_project_id := NEW.entity_id;
  ELSIF NEW.entity_type = 'task' THEN
    SELECT id, title, project_id INTO v_task_id, v_task_title, v_project_id FROM public.tasks WHERE id = NEW.entity_id;
    v_meta := v_meta || jsonb_build_object('task_id', v_task_id, 'task_title', v_task_title);
  ELSIF NEW.entity_type = 'lead' THEN
    v_meta := v_meta || jsonb_build_object('lead_id', NEW.entity_id);
  END IF;
  PERFORM public.log_team_activity('file.uploaded', 'file', NEW.id::text, v_project_id,
    CASE WHEN v_task_id IS NOT NULL THEN format('Uploaded "%s" to task "%s"', NEW.name, v_task_title)
      ELSE format('Uploaded "%s"', NEW.name) END,
    v_meta);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_portal_update_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_team_activity('portal_update.posted', 'portal_update', NEW.id::text, NEW.project_id,
    format('Posted portal update "%s"', NEW.title), jsonb_build_object('portal_update_id', NEW.id));
  RETURN NULL;
END;
$$;

-- Only the label: never anything from the secret itself.
CREATE OR REPLACE FUNCTION public.log_credential_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_team_activity('credential.added', 'credential', NEW.id::text, NEW.project_id,
    format('Added credential "%s"', NEW.label), jsonb_build_object('credential_id', NEW.id));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_reminder_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid := NEW.project_id;
  v_meta jsonb := jsonb_build_object('reminder_id', NEW.id);
BEGIN
  IF NEW.task_id IS NOT NULL THEN
    SELECT coalesce(v_project_id, project_id) INTO v_project_id FROM public.tasks WHERE id = NEW.task_id;
    v_meta := v_meta || jsonb_build_object('task_id', NEW.task_id);
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('reminder.created', 'reminder', NEW.id::text, v_project_id,
      format('Added reminder "%s"', NEW.title), v_meta);
  ELSIF NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
    AND NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' AND NOT coalesce(NEW.closed_by_task, false) THEN
    -- A reminder closed by its task finishing is covered by "Completed task".
    PERFORM public.log_team_activity('reminder.completed', 'reminder', NEW.id::text, v_project_id,
      format('Completed reminder "%s"', NEW.title), v_meta);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_communication_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'sent' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'sent') THEN
    PERFORM public.log_team_activity('communication.sent', 'communication', NEW.id::text, NEW.project_id,
      format('Sent "%s" to the client', coalesce(nullif(NEW.subject, ''), 'an email')),
      jsonb_build_object('communication_id', NEW.id, 'notification_type', NEW.notification_type));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_contact_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_team_activity('contact.created', 'contact', NEW.id::text, NULL,
    format('Added contact "%s"', NEW.name), jsonb_build_object('contact_id', NEW.id));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_lead_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('lead_id', NEW.id, 'lead_name', NEW.name);
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_team_activity('lead.created', 'lead', NEW.id::text, NULL,
      format('Added lead "%s"', NEW.name), v_meta);
  ELSIF NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.log_team_activity('lead.status', 'lead', NEW.id::text, NULL,
      format('Moved lead "%s" to %s', NEW.name, public.activity_status_label(NEW.status)),
      v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  RETURN NULL;
END;
$$;

-- Moves to Trash and restores, for every Trash table. The project a record
-- belongs to comes from the record or its parent, so a project's feed shows
-- it.
CREATE OR REPLACE FUNCTION public.log_trash_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec jsonb := to_jsonb(NEW);
  v_entity text := public.activity_entity_type(TG_TABLE_NAME);
  v_project uuid;
  v_label text;
  v_meta jsonb := jsonb_build_object('record_type', TG_TABLE_NAME);
  v_restored boolean := NEW.deleted_at IS NULL;
BEGIN
  v_label := coalesce(
    nullif(rec ->> 'title', ''), nullif(rec ->> 'name', ''), nullif(rec ->> 'label', ''),
    nullif(rec ->> 'invoice_number', ''), nullif(rec ->> 'field_key', ''),
    nullif(left(rec ->> 'text', 80), ''), nullif(left(rec ->> 'description', 80), ''));

  IF TG_TABLE_NAME = 'projects' THEN
    v_project := NEW.id;
  ELSIF rec ? 'project_id' THEN
    v_project := nullif(rec ->> 'project_id', '')::uuid;
  END IF;

  IF rec ? 'task_id' THEN
    v_meta := v_meta || jsonb_build_object('task_id', rec ->> 'task_id');
    IF v_project IS NULL THEN
      SELECT project_id INTO v_project FROM public.tasks WHERE id = (rec ->> 'task_id')::uuid;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'tasks' THEN
    v_meta := v_meta || jsonb_build_object('task_id', NEW.id);
  END IF;
  IF rec ? 'invoice_id' AND v_project IS NULL THEN
    SELECT project_id, invoice_number INTO v_project, v_label
    FROM public.project_invoices WHERE id = (rec ->> 'invoice_id')::uuid;
    v_label := public.activity_money_label((rec ->> 'amount')::numeric) || ' on ' || coalesce(v_label, 'an invoice');
  END IF;
  IF rec ? 'update_id' AND v_project IS NULL THEN
    SELECT project_id INTO v_project FROM public.portal_updates WHERE id = (rec ->> 'update_id')::uuid;
  END IF;
  IF rec ? 'retainer_id' AND v_project IS NULL THEN
    SELECT project_id INTO v_project FROM public.project_retainers WHERE id = (rec ->> 'retainer_id')::uuid;
  END IF;
  IF TG_TABLE_NAME = 'entity_files' THEN
    IF rec ->> 'entity_type' = 'project' THEN
      v_project := (rec ->> 'entity_id')::uuid;
    ELSIF rec ->> 'entity_type' = 'task' THEN
      SELECT project_id INTO v_project FROM public.tasks WHERE id = (rec ->> 'entity_id')::uuid;
      v_meta := v_meta || jsonb_build_object('task_id', rec ->> 'entity_id');
    ELSIF rec ->> 'entity_type' = 'lead' THEN
      v_meta := v_meta || jsonb_build_object('lead_id', rec ->> 'entity_id');
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'leads' THEN
    v_meta := v_meta || jsonb_build_object('lead_id', NEW.id);
  ELSIF rec ? 'lead_id' THEN
    v_meta := v_meta || jsonb_build_object('lead_id', rec ->> 'lead_id');
  END IF;
  IF TG_TABLE_NAME = 'project_time_entries' THEN
    v_label := public.activity_hours_label(public.time_entry_worked_hours(NEW.segments, NEW.start_time, NEW.end_time))
      || ' from ' || public.activity_member_name(NEW.member_id);
  END IF;

  PERFORM public.log_team_activity(
    CASE WHEN v_restored THEN 'record.restored' ELSE 'record.trashed' END,
    v_entity, NEW.id::text, v_project,
    format('%s %s%s%s',
      CASE WHEN v_restored THEN 'Restored' ELSE 'Moved' END,
      public.activity_entity_noun(v_entity),
      CASE WHEN v_label IS NULL THEN '' ELSE format(' "%s"', v_label) END,
      CASE WHEN v_restored THEN '' ELSE ' to Trash' END),
    v_meta);
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS log_task_activity ON public.tasks;
CREATE TRIGGER log_task_activity AFTER INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.log_task_activity();
DROP TRIGGER IF EXISTS log_task_assignee_activity ON public.task_assignees;
CREATE TRIGGER log_task_assignee_activity AFTER INSERT OR DELETE ON public.task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.log_task_assignee_activity();
DROP TRIGGER IF EXISTS log_subtask_activity ON public.task_subtasks;
CREATE TRIGGER log_subtask_activity AFTER INSERT OR UPDATE ON public.task_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.log_subtask_activity();
DROP TRIGGER IF EXISTS log_comment_activity ON public.task_comments;
CREATE TRIGGER log_comment_activity AFTER INSERT ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.log_comment_activity();
DROP TRIGGER IF EXISTS log_project_activity ON public.projects;
CREATE TRIGGER log_project_activity AFTER INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.log_project_activity();
DROP TRIGGER IF EXISTS log_project_member_activity ON public.project_members;
CREATE TRIGGER log_project_member_activity AFTER INSERT OR DELETE ON public.project_members
  FOR EACH ROW EXECUTE FUNCTION public.log_project_member_activity();
DROP TRIGGER IF EXISTS log_project_contact_activity ON public.project_contacts;
CREATE TRIGGER log_project_contact_activity AFTER INSERT ON public.project_contacts
  FOR EACH ROW EXECUTE FUNCTION public.log_project_contact_activity();
DROP TRIGGER IF EXISTS log_time_entry_activity ON public.project_time_entries;
CREATE TRIGGER log_time_entry_activity AFTER INSERT OR UPDATE ON public.project_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.log_time_entry_activity();
DROP TRIGGER IF EXISTS log_invoice_activity ON public.project_invoices;
CREATE TRIGGER log_invoice_activity AFTER INSERT OR UPDATE ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.log_invoice_activity();
DROP TRIGGER IF EXISTS log_payment_activity ON public.invoice_payments;
CREATE TRIGGER log_payment_activity AFTER INSERT ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.log_payment_activity();
DROP TRIGGER IF EXISTS log_file_activity ON public.entity_files;
CREATE TRIGGER log_file_activity AFTER INSERT ON public.entity_files
  FOR EACH ROW EXECUTE FUNCTION public.log_file_activity();
DROP TRIGGER IF EXISTS log_portal_update_activity ON public.portal_updates;
CREATE TRIGGER log_portal_update_activity AFTER INSERT ON public.portal_updates
  FOR EACH ROW EXECUTE FUNCTION public.log_portal_update_activity();
DROP TRIGGER IF EXISTS log_credential_activity ON public.project_credentials;
CREATE TRIGGER log_credential_activity AFTER INSERT ON public.project_credentials
  FOR EACH ROW EXECUTE FUNCTION public.log_credential_activity();
DROP TRIGGER IF EXISTS log_reminder_activity ON public.reminders;
CREATE TRIGGER log_reminder_activity AFTER INSERT OR UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.log_reminder_activity();
DROP TRIGGER IF EXISTS log_communication_activity ON public.client_communications;
CREATE TRIGGER log_communication_activity AFTER INSERT OR UPDATE ON public.client_communications
  FOR EACH ROW EXECUTE FUNCTION public.log_communication_activity();
DROP TRIGGER IF EXISTS log_contact_activity ON public.contacts;
CREATE TRIGGER log_contact_activity AFTER INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.log_contact_activity();
DROP TRIGGER IF EXISTS log_lead_activity ON public.leads;
CREATE TRIGGER log_lead_activity AFTER INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.log_lead_activity();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'tasks', 'task_subtasks', 'task_comments', 'reminders', 'project_credentials', 'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads', 'lead_interactions', 'lead_proposals', 'lead_fields', 'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates', 'project_retainers', 'project_retainer_amounts'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS log_trash_activity ON public.%I', t);
    EXECUTE format('CREATE TRIGGER log_trash_activity AFTER UPDATE OF deleted_at ON public.%I
      FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
      EXECUTE FUNCTION public.log_trash_activity()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.activity_actor() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.log_team_activity(text, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_read_activity(text, text, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activity_actor() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_read_activity(text, text, uuid, uuid, jsonb) TO authenticated, service_role;
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'log_task_activity', 'log_task_assignee_activity', 'log_subtask_activity', 'log_comment_activity',
    'log_project_activity', 'log_project_member_activity', 'log_project_contact_activity',
    'log_time_entry_activity', 'log_invoice_activity', 'log_payment_activity', 'log_file_activity',
    'log_portal_update_activity', 'log_credential_activity', 'log_reminder_activity',
    'log_communication_activity', 'log_contact_activity', 'log_lead_activity', 'log_trash_activity'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Task source and seen
-- ---------------------------------------------------------------------------
-- How each task was made (app, api, mcp, system; unknown before tracking), the
-- API key behind it, and each member's last look at it. The server names the
-- key in x-actor-key-id (service role only, like x-actor-member-id).
ALTER TABLE public.tasks ADD CONSTRAINT tasks_created_by_key_id_fkey
  FOREIGN KEY (created_by_key_id) REFERENCES public.api_keys(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_created_by_key ON public.tasks (created_by_key_id) WHERE created_by_key_id IS NOT NULL;

-- How the current insert was made. Never trusts the row: a caller cannot
-- claim to be the app or another key by setting the columns itself.
CREATE OR REPLACE FUNCTION public.stamp_task_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_headers json;
  v_via text;
  v_key text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Where a task came from is history: it stays as it was stamped.
    NEW.created_via := OLD.created_via;
    NEW.created_by_key_id := OLD.created_by_key_id;
    NEW.created_note := OLD.created_note;
    RETURN NEW;
  END IF;

  NEW.created_by_key_id := NULL;
  NEW.created_note := nullif(left(btrim(coalesce(NEW.created_note, '')), 200), '');
  IF auth.uid() IS NOT NULL THEN
    NEW.created_via := 'app';
    NEW.created_note := NULL;
    RETURN NEW;
  END IF;
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    NEW.created_via := 'system';
    RETURN NEW;
  END IF;

  BEGIN
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN others THEN
    v_headers := NULL;
  END;
  v_via := v_headers ->> 'x-actor-via';
  v_key := v_headers ->> 'x-actor-key-id';
  NEW.created_via := CASE WHEN v_via IN ('app', 'api', 'mcp') THEN v_via ELSE 'system' END;
  IF NEW.created_via IN ('api', 'mcp')
     AND v_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.api_keys WHERE id = v_key::uuid) THEN
    NEW.created_by_key_id := v_key::uuid;
  END IF;
  IF NEW.created_via = 'app' THEN
    NEW.created_note := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_task_source
  BEFORE INSERT OR UPDATE OF created_via, created_by_key_id, created_note ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.stamp_task_source();

REVOKE ALL ON FUNCTION public.stamp_task_source() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seen
-- ---------------------------------------------------------------------------
CREATE TABLE public.task_views (
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, member_id)
);
CREATE INDEX idx_task_views_member ON public.task_views (member_id);

ALTER TABLE public.task_views ENABLE ROW LEVEL SECURITY;

-- Each member reads and writes only their own views, and only of tasks they can open.
CREATE POLICY task_views_select ON public.task_views FOR SELECT TO authenticated
  USING (member_id = public.current_team_member_id());
CREATE POLICY task_views_insert ON public.task_views FOR INSERT TO authenticated
  WITH CHECK (member_id = public.current_team_member_id()
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id));
CREATE POLICY task_views_update ON public.task_views FOR UPDATE TO authenticated
  USING (member_id = public.current_team_member_id())
  WITH CHECK (member_id = public.current_team_member_id());

-- Opening a task marks it seen for the signed-in member (once, then the time moves).
CREATE OR REPLACE FUNCTION public.mark_task_seen(p_task_id uuid)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO public.task_views (task_id, member_id)
  VALUES (p_task_id, public.current_team_member_id())
  ON CONFLICT (task_id, member_id) DO UPDATE SET seen_at = now();
$$;

REVOKE ALL ON FUNCTION public.mark_task_seen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_task_seen(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Task files
-- ---------------------------------------------------------------------------
-- A task's own uploads (private task-files bucket, stored once per project by
-- content) and links to email attachments and project files, never copies.
CREATE TABLE public.task_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  -- upload: the task's own file. email_attachment, project_file: a link to a
  -- file that already exists, never a copy.
  kind text NOT NULL CHECK (kind IN ('upload', 'email_attachment', 'project_file')),
  -- upload only: the object in the private task-files bucket, stored by
  -- content ({project_id}/{sha256}) so the same bytes are kept once per project.
  storage_path text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  -- A linked email attachment or project file. RESTRICT: neither may vanish
  -- under a task (email retention moves a linked attachment to the task first).
  email_attachment_id uuid REFERENCES communications.attachments(id) ON DELETE RESTRICT,
  entity_file_id uuid REFERENCES public.entity_files(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  file_size bigint NOT NULL DEFAULT 0 CHECK (file_size >= 0),
  -- Why it is on the task, in a few words ("the screenshot Ciaran sent").
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  added_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never removed.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  CONSTRAINT task_files_one_source CHECK (
    (kind = 'upload' AND storage_path IS NOT NULL AND sha256 IS NOT NULL AND email_attachment_id IS NULL AND entity_file_id IS NULL)
    OR (kind = 'email_attachment' AND email_attachment_id IS NOT NULL AND storage_path IS NULL AND sha256 IS NULL AND entity_file_id IS NULL)
    OR (kind = 'project_file' AND entity_file_id IS NOT NULL AND storage_path IS NULL AND sha256 IS NULL AND email_attachment_id IS NULL)
  )
);
CREATE INDEX idx_task_files_task ON public.task_files (task_id);
CREATE INDEX idx_task_files_deleted_at ON public.task_files (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_task_files_storage_path ON public.task_files (storage_path) WHERE storage_path IS NOT NULL;
CREATE INDEX idx_task_files_email_attachment ON public.task_files (email_attachment_id) WHERE email_attachment_id IS NOT NULL;
CREATE INDEX idx_task_files_entity_file ON public.task_files (entity_file_id) WHERE entity_file_id IS NOT NULL;
-- One live entry per file per task: adding the same file twice adds nothing.
CREATE UNIQUE INDEX task_files_live_upload ON public.task_files (task_id, sha256) WHERE kind = 'upload' AND deleted_at IS NULL;
CREATE UNIQUE INDEX task_files_live_email_attachment ON public.task_files (task_id, email_attachment_id) WHERE kind = 'email_attachment' AND deleted_at IS NULL;
CREATE UNIQUE INDEX task_files_live_project_file ON public.task_files (task_id, entity_file_id) WHERE kind = 'project_file' AND deleted_at IS NULL;

-- Private, like inbound-email: only the server reads and writes it, and hands
-- out short signed links. No storage.objects policies on purpose.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('task-files', 'task-files', false, 52428800)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.task_files ENABLE ROW LEVEL SECURITY;

-- Read with the task and the file permission; written only by the server
-- (20261024074521_task_files_server_writes.sql), which checks what the
-- database cannot: a linked attachment's inbox is readable by the person, a
-- project file is the task's project's, an upload's path is the hash of its
-- bytes in the task's project. Trash and restore go through
-- soft_delete_record and restore_record (can_trash_record: your own, or any
-- with files.manage).
CREATE POLICY task_files_select ON public.task_files FOR SELECT TO authenticated
  USING (public.has_permission('files.read') AND public.can_access_task(task_id));
CREATE POLICY task_files_not_deleted ON public.task_files AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
CREATE POLICY task_files_parent_live ON public.task_files AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.task_is_live(task_id));
REVOKE ALL ON public.task_files FROM anon, authenticated;
GRANT SELECT ON public.task_files TO authenticated;
GRANT ALL ON public.task_files TO service_role;

CREATE OR REPLACE FUNCTION public.log_task_file_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title text;
  v_project_id uuid;
BEGIN
  SELECT title, project_id INTO v_title, v_project_id FROM public.tasks WHERE id = NEW.task_id;
  PERFORM public.log_team_activity(
    CASE WHEN NEW.kind = 'upload' THEN 'file.uploaded' ELSE 'file.attached' END,
    'file', NEW.id::text, v_project_id,
    format(CASE WHEN NEW.kind = 'upload' THEN 'Uploaded "%s" to task "%s"' ELSE 'Attached "%s" to task "%s"' END, NEW.name, v_title),
    jsonb_build_object('file_name', NEW.name, 'kind', NEW.kind, 'task_id', NEW.task_id, 'task_title', v_title));
  RETURN NULL;
END;
$$;

CREATE TRIGGER set_task_files_updated_at BEFORE UPDATE ON public.task_files
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.task_files
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.task_files
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete();
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON public.task_files
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.record_trash_event();
CREATE TRIGGER log_trash_activity AFTER UPDATE OF deleted_at ON public.task_files
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.log_trash_activity();
CREATE TRIGGER log_task_file_activity AFTER INSERT ON public.task_files
  FOR EACH ROW EXECUTE FUNCTION public.log_task_file_activity();

REVOKE ALL ON FUNCTION public.log_task_file_activity() FROM PUBLIC, anon, authenticated;

-- Live sync: a task's files reach open screens as they change.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'task_files') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.task_files;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Unread tasks
-- ---------------------------------------------------------------------------
-- task_events records each change worth knowing about on a task (edits,
-- status, comments, linked emails, files, subtasks, assignees, reviews), who
-- made it and how (app, api, mcp, system, resolved like the task source
-- stamp). Kept apart from tasks so it never moves updated_at, the team log or
-- a webhook. A task is updated for a member when it has an event after their
-- last look that is not their own (made in the app as them).
CREATE TABLE public.task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  -- The person or agent behind it, when known; null for a key with no
  -- member, the email pipeline, or SQL run directly.
  member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  via text NOT NULL CONSTRAINT task_events_via_check CHECK (via IN ('app', 'api', 'mcp', 'system')),
  kind text NOT NULL CONSTRAINT task_events_kind_check
    CHECK (kind IN ('edit', 'status', 'comment', 'email', 'file', 'subtask', 'assignee', 'review'))
);
CREATE INDEX idx_task_events_task_at ON public.task_events (task_id, at DESC);

ALTER TABLE public.task_events ENABLE ROW LEVEL SECURITY;

-- Readable with the task; only the triggers below write.
CREATE POLICY task_events_select ON public.task_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id));

REVOKE ALL ON public.task_events FROM anon, authenticated;
GRANT SELECT ON public.task_events TO authenticated;
GRANT ALL ON public.task_events TO service_role;

-- Records one change on a task. A task's own creation is not a change (its
-- assignees, subtasks and email saved with it included), nor is anything on a
-- task in Trash. One event per kind per actor per transaction: a save that
-- rewrites five criteria is one edit.
CREATE OR REPLACE FUNCTION public.record_task_event(p_task_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_headers json;
  v_member uuid;
  v_via text;
  v_header text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tasks
    WHERE id = p_task_id AND deleted_at IS NULL AND created_at < now()
  ) THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_member := public.current_team_member_id();
    v_via := 'app';
  ELSIF coalesce(auth.role(), '') = 'service_role' THEN
    BEGIN
      v_headers := nullif(current_setting('request.headers', true), '')::json;
    EXCEPTION WHEN others THEN
      v_headers := NULL;
    END;
    v_via := v_headers ->> 'x-actor-via';
    v_via := CASE WHEN v_via IN ('app', 'api', 'mcp') THEN v_via ELSE 'system' END;
    v_header := v_headers ->> 'x-actor-member-id';
    IF v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT id INTO v_member FROM public.team_members WHERE id = v_header::uuid;
    END IF;
    -- The app's routes always act for a person; without one it is the server.
    IF v_via = 'app' AND v_member IS NULL THEN
      v_via := 'system';
    END IF;
  ELSE
    v_via := 'system';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.task_events
    WHERE task_id = p_task_id AND at = now() AND kind = p_kind
      AND via = v_via AND member_id IS NOT DISTINCT FROM v_member
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.task_events (task_id, member_id, via, kind)
  VALUES (p_task_id, v_member, v_via, p_kind);
END;
$$;

-- The task's own fields. Reordering, the completion stamp, Trash and the
-- source stamp are not changes anyone needs to read.
CREATE OR REPLACE FUNCTION public.record_task_row_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ignore text[] := ARRAY['sort_order', 'completed_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by',
    'created_via', 'created_by_key_id', 'created_note'];
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  -- A subtask moving with its parent is the parent's change, not its own.
  IF NEW.parent_task_id IS NOT NULL AND NEW.parent_task_id IS NOT DISTINCT FROM OLD.parent_task_id THEN
    v_ignore := v_ignore || ARRAY['project_id', 'project_goal_id'];
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.record_task_event(NEW.id, 'status');
  ELSIF cardinality(public.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD), v_ignore)) > 0 THEN
    PERFORM public.record_task_event(NEW.id, 'edit');
  END IF;
  RETURN NULL;
END;
$$;

-- Everything kept beside the task. TG_ARGV[0] is the kind.
CREATE OR REPLACE FUNCTION public.record_task_child_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.record_task_event(OLD.task_id, TG_ARGV[0]);
  ELSE
    PERFORM public.record_task_event(NEW.task_id, TG_ARGV[0]);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER record_task_event AFTER UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.record_task_row_event();

CREATE TRIGGER record_task_event AFTER INSERT ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('comment');

CREATE TRIGGER record_task_event AFTER INSERT ON communications.task_links
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('email');

CREATE TRIGGER record_task_event AFTER INSERT ON public.task_files
  FOR EACH ROW WHEN (NEW.deleted_at IS NULL)
  EXECUTE FUNCTION public.record_task_child_event('file');

CREATE TRIGGER record_task_event AFTER INSERT OR UPDATE OF title, completed ON public.task_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('subtask');

CREATE TRIGGER record_task_event AFTER INSERT OR DELETE ON public.task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('assignee');

CREATE TRIGGER record_task_event AFTER INSERT OR DELETE ON public.task_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('edit');

CREATE TRIGGER record_task_event AFTER INSERT OR DELETE OR UPDATE OF criterion, satisfied ON public.task_acceptance_criteria
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('edit');

CREATE TRIGGER record_task_event AFTER INSERT ON public.task_reviews
  FOR EACH ROW EXECUTE FUNCTION public.record_task_child_event('review');

REVOKE ALL ON FUNCTION public.record_task_event(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_task_row_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_task_child_event() FROM PUBLIC, anon, authenticated;

-- Every live task the signed-in member can see with changes they have not
-- seen: when they last looked (null if never), how many changes of each
-- kind, and the latest one.
CREATE OR REPLACE FUNCTION public.my_task_updates()
RETURNS TABLE (
  task_id uuid,
  seen_at timestamptz,
  total integer,
  kinds jsonb,
  last_at timestamptz,
  last_member_id uuid,
  last_via text,
  last_kind text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.current_team_member_id() AS id
  ), unseen AS (
    SELECT e.id, e.task_id, e.at, e.member_id, e.via, e.kind, v.seen_at
    FROM public.task_events e
    JOIN public.tasks t ON t.id = e.task_id AND t.deleted_at IS NULL
    CROSS JOIN me
    LEFT JOIN public.task_views v ON v.task_id = e.task_id AND v.member_id = me.id
    WHERE me.id IS NOT NULL
      AND e.at > coalesce(v.seen_at, '-infinity'::timestamptz)
      AND NOT (e.via = 'app' AND e.member_id IS NOT DISTINCT FROM me.id)
  ), per_kind AS (
    SELECT u.task_id, jsonb_object_agg(u.kind, u.n) AS kinds, sum(u.n)::integer AS total
    FROM (SELECT task_id, kind, count(*) AS n FROM unseen GROUP BY task_id, kind) u
    GROUP BY u.task_id
  ), latest AS (
    SELECT DISTINCT ON (task_id) task_id, seen_at, at, member_id, via, kind
    FROM unseen
    ORDER BY task_id, at DESC, id DESC
  )
  SELECT l.task_id, l.seen_at, p.total, p.kinds, l.at, l.member_id, l.via, l.kind
  FROM latest l
  JOIN per_kind p ON p.task_id = l.task_id
$$;

REVOKE ALL ON FUNCTION public.my_task_updates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_task_updates() TO authenticated;

-- Mark all read: many tasks seen at once. Tasks the member cannot see are
-- skipped, never an error.
CREATE OR REPLACE FUNCTION public.mark_tasks_seen(p_task_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF cardinality(p_task_ids) > 1000 THEN
    RAISE EXCEPTION 'Mark at most 1000 tasks at once' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.task_views (task_id, member_id)
  SELECT t.id, public.current_team_member_id()
  FROM public.tasks t
  WHERE t.id = ANY (coalesce(p_task_ids, ARRAY[]::uuid[]))
  ON CONFLICT (task_id, member_id) DO UPDATE SET seen_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_tasks_seen(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_tasks_seen(uuid[]) TO authenticated;

-- Live: a change shows on the cards as it happens, and a look on one device
-- clears it on the others.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['task_events', 'task_views'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Subtasks are tasks (migration 20261026212748_subtasks_are_tasks.sql)
-- ---------------------------------------------------------------------------
-- A subtask is a task with parent_task_id set. One level deep; always in its
-- parent's project (moving the parent moves its subtasks, which take its
-- goal); adding one needs the right to manage the parent. set_task_parent()
-- nests a task or makes it top-level. Access follows the parent (see
-- can_read_task_row, tasks_update, task_is_live); a parent in Trash hides its
-- subtasks and a subtask comes back after its parent. Completion is
-- independent: finishing every subtask does not finish the parent.

-- task_subtasks (the old text subtasks, copied into tasks) is read-only; the
-- app and API write tasks. A later migration drops it.
CREATE OR REPLACE FUNCTION public.forbid_text_subtask_writes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Subtasks are tasks now: refresh the app, or create a task with parent_task_id.'
    USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION public.forbid_text_subtask_writes() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER forbid_text_subtask_writes BEFORE INSERT OR UPDATE ON public.task_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.forbid_text_subtask_writes();

-- ---------------------------------------------------------------------------
-- Who may manage a task
-- ---------------------------------------------------------------------------
-- The signed-in member may change it: manage all tasks, or manage assigned
-- ones and be on it or on its parent.
CREATE OR REPLACE FUNCTION public.can_manage_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.can_access_task(p_task_id) AND (
    public.has_permission('tasks.manage_all') OR (
      public.has_permission('tasks.manage_assigned') AND EXISTS (
        SELECT 1 FROM public.tasks task
        JOIN public.task_assignees assignment
          ON assignment.task_id IN (task.id, task.parent_task_id)
        WHERE task.id = p_task_id AND assignment.member_id = public.current_team_member_id()
      )
    )
  )
$$;
REVOKE ALL ON FUNCTION public.can_manage_task(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_task(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The rules, for every writer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_task_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent public.tasks;
  v_children integer;
  v_parent_changed boolean := TG_OP = 'INSERT' OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id;
BEGIN
  IF NEW.parent_task_id IS NULL OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT v_parent_changed AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
     AND OLD.deleted_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Locked so a parent cannot become a subtask while a subtask joins it.
  SELECT * INTO v_parent FROM public.tasks WHERE id = NEW.parent_task_id FOR SHARE;
  IF v_parent.id IS NULL OR v_parent.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'The parent task is not there or is in Trash.' USING ERRCODE = 'P0002';
  END IF;
  IF v_parent.parent_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'Subtasks go one level deep: "%" is itself a subtask.', v_parent.title USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT count(*) INTO v_children FROM public.tasks WHERE parent_task_id = NEW.id AND deleted_at IS NULL;
    IF v_children > 0 THEN
      RAISE EXCEPTION 'It has % subtask%. Make them top-level or move them first.',
        v_children, CASE WHEN v_children = 1 THEN '' ELSE 's' END USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.project_id IS DISTINCT FROM v_parent.project_id THEN
    RAISE EXCEPTION 'A subtask stays in its parent task''s project. Move the parent, or make it top-level first.'
      USING ERRCODE = '23514';
  END IF;
  -- A signed-in member needs to be able to manage the parent; the server
  -- routes check a key's rights themselves.
  IF v_parent_changed AND auth.uid() IS NOT NULL AND NOT public.can_manage_task(v_parent.id) THEN
    RAISE EXCEPTION 'You cannot add subtasks to "%".', v_parent.title USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_task_parent() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER enforce_task_parent
  BEFORE INSERT OR UPDATE OF parent_task_id, project_id, deleted_at ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_task_parent();

-- A parent's subtasks follow it to another project (those in Trash too, so a
-- restore lands them beside it) and take its goal, since the old project's
-- goals do not apply there.
CREATE OR REPLACE FUNCTION public.move_subtasks_with_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.tasks
  SET project_id = NEW.project_id, project_goal_id = NEW.project_goal_id
  WHERE parent_task_id = NEW.id AND project_id IS DISTINCT FROM NEW.project_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.move_subtasks_with_parent() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER move_subtasks_with_parent
  AFTER UPDATE OF project_id ON public.tasks
  FOR EACH ROW WHEN (NEW.project_id IS DISTINCT FROM OLD.project_id AND NEW.parent_task_id IS NULL)
  EXECUTE FUNCTION public.move_subtasks_with_parent();

-- Nest a task under a parent (p_parent_id) or make it top-level (null). It
-- goes last among its new siblings. Under a parent in another project it
-- moves there and takes the parent's goal; that needs tasks.manage_all for a
-- signed-in member, and no blocker links (they must stay inside one project).
-- Runs as the caller, so the task's own update rules still apply.
CREATE OR REPLACE FUNCTION public.set_task_parent(p_task_id uuid, p_parent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_task public.tasks;
  v_parent public.tasks;
  v_goal uuid;
  v_order integer;
BEGIN
  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id AND deleted_at IS NULL FOR UPDATE;
  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_parent_id IS NOT DISTINCT FROM v_task.parent_task_id THEN
    RETURN to_jsonb(v_task);
  END IF;

  IF p_parent_id IS NULL THEN
    SELECT coalesce(max(sort_order) + 1, 0) INTO v_order FROM public.tasks
    WHERE project_id = v_task.project_id AND parent_task_id IS NULL AND status = v_task.status AND deleted_at IS NULL;
    UPDATE public.tasks SET parent_task_id = NULL, sort_order = v_order
    WHERE id = p_task_id RETURNING * INTO v_task;
  ELSE
    IF p_parent_id = p_task_id THEN
      RAISE EXCEPTION 'A task cannot be its own subtask.' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_parent FROM public.tasks WHERE id = p_parent_id AND deleted_at IS NULL;
    IF v_parent.id IS NULL THEN
      RAISE EXCEPTION 'The parent task is not there or is in Trash.' USING ERRCODE = 'P0002';
    END IF;
    v_goal := v_task.project_goal_id;
    IF v_parent.project_id <> v_task.project_id THEN
      IF auth.uid() IS NOT NULL AND NOT public.has_permission('tasks.manage_all') THEN
        RAISE EXCEPTION 'Moving a task to another project needs permission to manage all tasks.' USING ERRCODE = '42501';
      END IF;
      IF EXISTS (SELECT 1 FROM public.task_dependencies WHERE task_id = p_task_id OR blocked_by_task_id = p_task_id) THEN
        RAISE EXCEPTION 'It is blocked by, or blocks, tasks in its own project. Remove those links before moving it to another project.'
          USING ERRCODE = '23514';
      END IF;
      v_goal := v_parent.project_goal_id;
    END IF;
    SELECT coalesce(max(sort_order) + 1, 0) INTO v_order FROM public.tasks
    WHERE parent_task_id = p_parent_id AND deleted_at IS NULL;
    UPDATE public.tasks
    SET parent_task_id = p_parent_id, project_id = v_parent.project_id, project_goal_id = v_goal, sort_order = v_order
    WHERE id = p_task_id RETURNING * INTO v_task;
  END IF;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'Task % not found or not permitted', p_task_id USING ERRCODE = 'P0002';
  END IF;
  RETURN to_jsonb(v_task);
END;
$$;
REVOKE ALL ON FUNCTION public.set_task_parent(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_task_parent(uuid, uuid) TO authenticated, service_role;

-- A subtask added, finished or reopened, renamed, sent to Trash or back, or
-- moved in or out is news on its parent too (as "subtask"), besides being
-- the subtask's own change.
CREATE OR REPLACE FUNCTION public.record_subtask_parent_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_task_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
      PERFORM public.record_task_event(NEW.parent_task_id, 'subtask');
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id THEN
    IF OLD.parent_task_id IS NOT NULL THEN
      PERFORM public.record_task_event(OLD.parent_task_id, 'subtask');
    END IF;
    IF NEW.parent_task_id IS NOT NULL THEN
      PERFORM public.record_task_event(NEW.parent_task_id, 'subtask');
    END IF;
  ELSIF NEW.parent_task_id IS NOT NULL AND (
    (NEW.status = 'done') IS DISTINCT FROM (OLD.status = 'done')
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.title IS DISTINCT FROM OLD.title
  ) THEN
    PERFORM public.record_task_event(NEW.parent_task_id, 'subtask');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.record_subtask_parent_event() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER record_subtask_parent_event
  AFTER INSERT OR UPDATE OF parent_task_id, status, deleted_at, title ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.record_subtask_parent_event();
