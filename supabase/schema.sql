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
  updated_at timestamptz not null default now()
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
  updated_at timestamptz not null default now()
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
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'in_review', 'done')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  due_date text,
  tags text[] not null default '{}',
  sort_order int not null default 0,
  created_by uuid references public.team_members(id) on delete set null,
  completed_at timestamptz,
  -- Explicit AI-readiness classification; null until someone decides.
  ai_readiness text check (ai_readiness in ('ai_ready', 'human_only') or ai_readiness is null),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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
  updated_at timestamptz not null default now()
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

-- ============================================================
-- 9. COMMENTS
-- ============================================================
create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references public.team_members(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 10. ACTIVITIES (audit log)
-- ============================================================
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  entity_id text not null,
  entity_type text not null check (entity_type in ('task', 'project', 'comment', 'member')),
  user_id uuid references public.team_members(id) on delete set null,
  description text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
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
  updated_at timestamptz not null default now()
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
  updated_at timestamptz not null default now()
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
  updated_at timestamptz not null default now()
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
  unique (lead_id, field_key)
);

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
  updated_at timestamptz not null default now()
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
-- dispatcher signs (HMAC) and delivers each once. Secret is stored
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_webhook_deliveries_pending
  on public.webhook_deliveries (created_at)
  where status = 'pending';
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
  entity_type text check (entity_type in ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question')),
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
  updated_at timestamptz not null default now()
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
  unique (project_id, effective_at)
);

-- Only one running timer per (project, member) at a time — each teammate can
-- track their own live session on the same project simultaneously.
create unique index idx_project_time_entries_running
  on public.project_time_entries (project_id, member_id) where end_time is null;

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
  updated_at timestamptz not null default now()
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
  updated_at  timestamptz not null default now()
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
  updated_at timestamptz not null default now()
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
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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
create index idx_task_assignees_member_id on public.task_assignees(member_id);
create index idx_task_subtasks_task_id on public.task_subtasks(task_id);
create index idx_task_comments_task_id on public.task_comments(task_id);
create index idx_task_comments_user_id on public.task_comments(user_id);
create index idx_activities_entity_id on public.activities(entity_id);
create index idx_activities_user_id on public.activities(user_id);
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
-- UPSERT NOTIFICATION (SECURITY DEFINER — bypasses RLS for dedup check)
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
$$ language plpgsql security definer;

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
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  if v_lead.status = 'won' then
    -- Custom errcode so the API can map this to 409 without colliding with
    -- P0001, the default code every unqualified `raise exception` uses
    raise exception 'Lead has already been converted' using errcode = 'LC409';
  end if;

  -- Reuse existing contact if the lead has one, otherwise create one
  v_contact_id := v_lead.contact_id;
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

create or replace function public.validate_invoice_time_allocations(target_invoice_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.invoice_time_entry_allocations allocation
    join public.project_invoices invoice on invoice.id = allocation.invoice_id
    left join lateral jsonb_array_elements(invoice.line_items) line_item
      on line_item->>'id' = allocation.line_item_id
    where allocation.invoice_id = target_invoice_id
      and (line_item is null or line_item->>'item_type' is distinct from 'hourly')
  ) then
    raise exception 'Invoice allocation points to a missing or non-hourly line item';
  end if;

  if exists (
    select 1
    from public.invoice_time_entry_allocations allocation
    join public.project_invoices invoice on invoice.id = allocation.invoice_id
    left join public.project_time_entries entry on entry.id = allocation.time_entry_id
    where allocation.invoice_id = target_invoice_id
      and (
        entry.id is null
        or entry.project_id is distinct from invoice.project_id
        or entry.end_time is null
        or entry.hourly_rate <= 0
      )
  ) then
    raise exception 'Invoice allocation points to an invalid time session';
  end if;

  if exists (
    select 1
    from public.invoice_time_entry_allocations allocation
    join public.project_time_entries entry on entry.id = allocation.time_entry_id
    cross join lateral (
      select case
        when jsonb_array_length(coalesce(entry.segments, '[]'::jsonb)) > 0 then
          coalesce(sum(
            extract(epoch from ((segment->>'end')::timestamptz - (segment->>'start')::timestamptz)) / 3600
          ) filter (where segment->>'end' is not null), 0)
        else extract(epoch from (entry.end_time - entry.start_time)) / 3600
      end as worked_hours
      from jsonb_array_elements(coalesce(entry.segments, '[]'::jsonb)) segment
    ) worked
    where allocation.invoice_id = target_invoice_id
      and allocation.start_offset_hours + allocation.allocated_hours > worked.worked_hours + 0.0000011
  ) then
    raise exception 'Invoice allocation extends beyond its tracked session';
  end if;

  if exists (
    select 1
    from public.invoice_time_entry_allocations allocation
    join public.project_time_entries entry on entry.id = allocation.time_entry_id
    where allocation.invoice_id = target_invoice_id
      and abs(
        round(allocation.allocated_hours * entry.hourly_rate, 2)
        - allocation.allocated_amount
      ) > 0.01
  ) then
    raise exception 'Invoice allocation amount disagrees with its session rate';
  end if;

  if exists (
    select 1
    from public.invoice_time_entry_allocations left_allocation
    join public.invoice_time_entry_allocations right_allocation
      on right_allocation.invoice_id = left_allocation.invoice_id
      and right_allocation.time_entry_id = left_allocation.time_entry_id
      and right_allocation.id > left_allocation.id
    where left_allocation.invoice_id = target_invoice_id
      and numrange(
        left_allocation.start_offset_hours,
        left_allocation.start_offset_hours + left_allocation.allocated_hours,
        '[)'
      ) && numrange(
        right_allocation.start_offset_hours,
        right_allocation.start_offset_hours + right_allocation.allocated_hours,
        '[)'
      )
  ) then
    raise exception 'A time session is billed more than once on the same invoice';
  end if;

  if exists (
    select 1
    from public.project_invoices invoice
    cross join lateral jsonb_array_elements(invoice.line_items) line_item
    join (
      select line_item_id, sum(allocated_amount) as allocated_amount
      from public.invoice_time_entry_allocations
      where invoice_id = target_invoice_id
      group by line_item_id
    ) totals on totals.line_item_id = line_item->>'id'
    where invoice.id = target_invoice_id
      and totals.allocated_amount is distinct from round((line_item->>'amount')::numeric, 2)
  ) then
    raise exception 'Hourly allocation totals do not match the invoice line amount';
  end if;
end;
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
    where id = p_invoice_id;

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
create or replace function public.emit_invoice_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op text := TG_OP;
  v_row public.project_invoices;
  v_was_paid boolean;
  v_is_paid boolean;
  v_event_type text;
  v_project_name text;
  v_totals jsonb;
  v_public_id text;
  v_seq bigint;
  v_event_uuid uuid;
  v_payload jsonb;
begin
  if v_op = 'DELETE' then
    v_row := OLD;
  else
    v_row := NEW;
  end if;

  v_was_paid := (v_op <> 'INSERT' and OLD.status = 'paid');
  v_is_paid  := (v_op <> 'DELETE' and NEW.status = 'paid');

  if v_op = 'DELETE' then
    if not v_was_paid then
      return OLD;
    end if;
    v_event_type := 'invoice.deleted';
  elsif v_op = 'INSERT' then
    if not v_is_paid then
      return NEW;
    end if;
    v_event_type := 'invoice.paid';
  else
    if not (v_is_paid or v_was_paid) then
      return NEW;
    end if;
    if v_is_paid and not v_was_paid then
      v_event_type := 'invoice.paid';
    else
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
      v_event_type := 'invoice.updated';
    end if;
  end if;

  if not exists (
    select 1 from public.webhook_endpoints e
    where e.is_active and v_event_type = any(e.events)
  ) then
    return case when v_op = 'DELETE' then OLD else NEW end;
  end if;

  select name into v_project_name
  from public.projects where id = v_row.project_id;

  select coalesce(jsonb_object_agg(t.item_type, t.subtotal), '{}'::jsonb)
    into v_totals
  from (
    select li->>'item_type' as item_type, sum((li->>'amount')::numeric) as subtotal
    from jsonb_array_elements(
           coalesce(nullif(v_row.line_items, 'null'::jsonb), '[]'::jsonb)
         ) li
    where li ? 'item_type'
    group by li->>'item_type'
  ) t;

  if v_totals = '{}'::jsonb then
    v_totals := jsonb_build_object(v_row.invoice_type, v_row.amount);
  end if;

  v_seq := nextval('public.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  v_payload := jsonb_build_object(
    'id', v_public_id,
    'type', v_event_type,
    'sequence', v_seq,
    'created_at', now(),
    'data', jsonb_build_object(
      'invoice', jsonb_build_object(
        'id', v_row.id,
        'invoice_number', v_row.invoice_number,
        'project_id', v_row.project_id,
        'status', v_row.status,
        'paid', v_is_paid,
        'invoice_type', v_row.invoice_type,
        'amount', v_row.amount,
        'date', v_row.date,
        'due_date', v_row.due_date,
        'paid_date', v_row.paid_date,
        'description', v_row.description,
        'updated_at', v_row.updated_at
      ),
      'project', jsonb_build_object(
        'id', v_row.project_id,
        'name', coalesce(v_project_name, '')
      ),
      'line_items', coalesce(nullif(v_row.line_items, 'null'::jsonb), '[]'::jsonb),
      'totals_by_type', v_totals
    )
  );

  insert into public.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
  values (v_public_id, v_seq, v_event_type, 'invoice', v_row.id, v_payload)
  returning id into v_event_uuid;

  insert into public.webhook_deliveries (webhook_event_id, endpoint_id)
  select v_event_uuid, e.id
  from public.webhook_endpoints e
  where e.is_active and v_event_type = any(e.events);

  return case when v_op = 'DELETE' then OLD else NEW end;
end;
$$;

create trigger emit_invoice_webhook
  after insert or update or delete on public.project_invoices
  for each row execute function public.emit_invoice_webhook();

-- Atomic claim for the dispatcher (FOR UPDATE SKIP LOCKED). See migration
-- 20260725154128_create_webhooks.sql.
create or replace function public.claim_webhook_deliveries(p_limit int default 20)
returns table (
  delivery_id uuid,
  attempts int,
  endpoint_id uuid,
  endpoint_url text,
  endpoint_secret text,
  event_public_id text,
  event_type text,
  payload jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select d2.id
    from public.webhook_deliveries d2
    join public.webhook_endpoints e2 on e2.id = d2.endpoint_id
    where d2.status = 'pending'
      and e2.is_active
    order by d2.created_at
    for update of d2 skip locked
    limit p_limit
  )
  update public.webhook_deliveries d
  set status = 'delivering',
      attempts = d.attempts + 1,
      last_attempt_at = now()
  from claimed, public.webhook_events ev, public.webhook_endpoints e
  where d.id = claimed.id
    and ev.id = d.webhook_event_id
    and e.id = d.endpoint_id
  returning d.id, d.attempts,
            e.id, e.url, e.secret,
            ev.event_id, ev.event_type, ev.payload;
end;
$$;
revoke all on function public.claim_webhook_deliveries(int) from public;
grant execute on function public.claim_webhook_deliveries(int) to service_role;

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

create policy "Public can read entity files"
  on storage.objects for select
  to public
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
  ('admin','notifications.manage_own','api'),

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
  ('agent','time.manage_own','api'), ('agent','notifications.send','api')
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
  allocated_amount numeric(12,2) NOT NULL CHECK (allocated_amount <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(time_entry_id, adjustment_id) = 1),
  UNIQUE NULLS NOT DISTINCT (payout_id, time_entry_id, adjustment_id)
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
  SELECT public.has_permission('projects.read_all', 'app')
    OR (
      public.has_permission('projects.read', 'app')
      AND EXISTS (
        SELECT 1 FROM public.project_members
        WHERE project_id = p_project_id
          AND member_id = public.current_team_member_id()
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

CREATE OR REPLACE FUNCTION public.can_access_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tasks
    WHERE id = p_task_id AND public.can_access_project(project_id)
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_credential(p_credential_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_permission('credentials.manage', 'app')
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
  SELECT * INTO v_entry FROM public.project_time_entries WHERE id = p_entry_id;
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
    WHERE allocation.payout_id = p_payout_id
      AND COALESCE(entry.member_id, adjustment.member_id) IS DISTINCT FROM payout_row.member_id
  ) THEN
    RAISE EXCEPTION 'Payout allocation belongs to another member';
  END IF;

  FOR allocation_row IN
    SELECT * FROM public.team_member_payout_allocations WHERE payout_id = p_payout_id
  LOOP
    IF allocation_row.time_entry_id IS NOT NULL THEN
      SELECT
        CASE
          WHEN entry.approval_status = 'approved' AND entry.end_time IS NOT NULL THEN
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
      payout_id, time_entry_id, adjustment_id, allocated_amount
    ) VALUES (
      payout_row.id,
      NULLIF(allocation->>'time_entry_id', '')::uuid,
      NULLIF(allocation->>'adjustment_id', '')::uuid,
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
  USING (public.has_permission('tasks.read') AND public.can_access_project(project_id));
CREATE POLICY tasks_insert ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (public.has_permission('tasks.create') AND public.can_access_project(project_id)
    AND created_by = public.current_team_member_id());
CREATE POLICY tasks_update ON public.tasks FOR UPDATE TO authenticated
  USING (public.can_access_project(project_id) AND (public.has_permission('tasks.manage_all') OR (
    public.has_permission('tasks.manage_assigned') AND EXISTS (
      SELECT 1 FROM public.task_assignees ta
      WHERE ta.task_id = tasks.id AND ta.member_id = public.current_team_member_id()
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

CREATE POLICY activities_select ON public.activities FOR SELECT TO authenticated
  USING (user_id = public.current_team_member_id() OR public.has_permission('audit.read'));
CREATE POLICY activities_insert ON public.activities FOR INSERT TO authenticated
  WITH CHECK (user_id = public.current_team_member_id());

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
CREATE POLICY api_keys_insert_own ON public.api_keys FOR INSERT TO authenticated
  WITH CHECK (team_member_id = public.current_team_member_id()
    AND created_by = public.current_team_member_id());
CREATE POLICY api_keys_update_own ON public.api_keys FOR UPDATE TO authenticated
  USING (team_member_id = public.current_team_member_id()
    OR public.has_permission('api_keys.manage_all'));

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
  SELECT public.has_permission('leads.read_all', 'app')
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
      public.has_permission('contacts.read_all', 'app')
      OR (
        public.has_permission('contacts.read', 'app')
        AND EXISTS (
          SELECT 1 FROM public.project_contacts link
          WHERE link.contact_id = p_entity_id
            AND public.can_access_project(link.project_id)
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
    AND entry.end_time IS NOT NULL;

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
  SELECT * FROM public.project_time_entries WHERE id = ANY(p_entry_ids);
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
  -- Agent columns, read by the live floor from the client: a feature flag
  -- and a branch name, neither financial (20260811_grant_agent_project_columns).
  autonomous_enabled, integration_branch
) ON public.projects TO authenticated;

REVOKE SELECT, INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.project_time_entries FROM authenticated;
GRANT SELECT (
  id, project_id, member_id, start_time, end_time, description,
  created_at, updated_at, segments, work_type, approval_status,
  submitted_at, approved_at, approved_by, rejection_reason
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
  IF (SELECT count(*) FROM public.project_time_entries WHERE id = ANY(p_entry_ids)) <> cardinality(p_entry_ids) THEN RAISE EXCEPTION 'One or more time entries were not found'; END IF;
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
    'task_suggestions', 'project_goals',
    'team_member_notifications', 'client_communications'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
