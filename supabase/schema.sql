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
  fixed_price numeric(12,2) default null,
  created_by uuid references public.team_members(id) on delete set null,
  archived_at timestamptz default null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id),
  unique(token)
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
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one running timer per project at a time
create unique index idx_project_time_entries_running
  on public.project_time_entries (project_id) where end_time is null;

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
-- 23. PROJECT CREDENTIALS (encrypted client credentials)
-- ============================================================
create table public.project_credentials (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  label text not null,
  category text not null default 'login'
    check (category in ('login', 'api_key', 'ssh_key', 'database', 'hosting', 'cms', 'ftp', 'dns', 'email', 'other')),
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

create policy "smtp_accounts_all" on public.smtp_accounts
  for all to authenticated using (true) with check (true);

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
create index idx_portal_updates_project_id on public.portal_updates(project_id);
create index idx_portal_updates_created_at on public.portal_updates(created_at desc);

create index idx_portal_update_attachments_update_id on public.portal_update_attachments(update_id);

create index idx_entity_files_entity on public.entity_files(entity_type, entity_id);
create index idx_entity_files_external_project on public.entity_files(entity_id) where entity_type = 'project' and visibility = 'external';

create index idx_api_keys_key_hash on public.api_keys(key_hash);
create index idx_api_keys_revoked_at on public.api_keys(revoked_at) where revoked_at is null;

create index idx_project_credentials_project on public.project_credentials(project_id);
create index idx_project_invoices_project on public.project_invoices(project_id);
create index idx_project_invoices_status on public.project_invoices(status);
create index idx_project_invoices_date on public.project_invoices(date desc);
create index idx_projects_archived_at on public.projects(archived_at) where archived_at is null;
create index idx_leads_archived_at on public.leads(archived_at) where archived_at is null;

create index idx_project_time_entries_project on public.project_time_entries(project_id);
create index idx_project_time_entries_member on public.project_time_entries(member_id);
create index idx_project_time_entries_start_time on public.project_time_entries(start_time desc);

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
alter table public.entity_files enable row level security;
alter table public.api_keys enable row level security;
alter table public.portal_updates enable row level security;
alter table public.portal_update_attachments enable row level security;
alter table public.project_time_entries enable row level security;
alter table public.project_credentials enable row level security;
alter table public.project_invoices enable row level security;
alter table public.team_member_notifications enable row level security;

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

create policy "entity_files_all" on public.entity_files
  for all to authenticated using (true) with check (true);

create policy "portal_updates_all" on public.portal_updates
  for all to authenticated using (true) with check (true);

create policy "portal_update_attachments_all" on public.portal_update_attachments
  for all to authenticated using (true) with check (true);

create policy "project_time_entries_all" on public.project_time_entries
  for all to authenticated using (true) with check (true);

create policy "api_keys_all" on public.api_keys
  for all to authenticated using (true) with check (true);

create policy "project_credentials_all" on public.project_credentials
  for all to authenticated using (true) with check (true);

create policy "project_invoices_all" on public.project_invoices
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