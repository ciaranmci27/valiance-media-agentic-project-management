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
  timezone text not null default 'UTC',
  notification_prefs jsonb not null default '{}',
  email_notifications_enabled boolean not null default false,
  email_notification_prefs jsonb not null default '{}',
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
  deployment_policy text not null default 'production' check (deployment_policy in ('playground', 'production')),
  max_concurrent_tasks integer not null default 2,
  suggestions_per_cycle integer not null default 3,
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
  value numeric(12,2),
  equity numeric(5,2),
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
-- 20. NOTIFICATIONS
-- ============================================================
create table public.team_member_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.team_members(id) on delete cascade,
  title text not null,
  message text,
  link text,
  is_read boolean not null default false,
  entity_type text check (entity_type in ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal')),
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create trigger set_tasks_updated_at
  before update on public.tasks
  for each row execute function public.handle_updated_at();

create trigger set_task_subtasks_updated_at
  before update on public.task_subtasks
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
security invoker
set search_path = public
as $$
declare
  saved public.project_invoices;
begin
  if p_invoice_id is null then
    insert into public.project_invoices (
      project_id, invoice_number, amount, status, invoice_type, line_items,
      date, due_date, paid_date, description, file_url, file_name, file_size,
      mime_type, created_by
    ) values (
      (p_invoice->>'project_id')::uuid,
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
    update public.project_invoices invoice
    set
      project_id = case when p_invoice ? 'project_id' then (p_invoice->>'project_id')::uuid else invoice.project_id end,
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
returns trigger as $$
begin
  insert into public.team_members (auth_user_id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.email
  );
  return new;
end;
$$ language plpgsql security definer;

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
