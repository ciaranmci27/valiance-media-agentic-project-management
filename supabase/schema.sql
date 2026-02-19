-- ProjectEM Full Schema
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
  role text not null default 'member' check (role in ('admin', 'member', 'guest')),
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
  created_by uuid references public.team_members(id) on delete set null,
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
create table public.subtasks (
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
create table public.comments (
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
  token text not null default encode(gen_random_bytes(24), 'hex'),
  pin text default null,
  welcome_message text not null default '',
  logo_url text not null default '',
  accent_color text not null default '#6366F1',
  show_progress boolean not null default true,
  show_proposals boolean not null default true,
  show_files boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id),
  unique(token)
);

-- ============================================================
-- 18. PORTAL FILES (per-project shared deliverables)
-- ============================================================
create table public.portal_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  file_url text not null,
  file_size bigint not null default 0,
  mime_type text not null default 'application/octet-stream',
  uploaded_by uuid references public.team_members(id) on delete set null,
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
create index idx_tasks_created_by on public.tasks(created_by);
create index idx_task_assignees_member_id on public.task_assignees(member_id);
create index idx_subtasks_task_id on public.subtasks(task_id);
create index idx_comments_task_id on public.comments(task_id);
create index idx_comments_user_id on public.comments(user_id);
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
create index idx_portal_files_project_id on public.portal_files(project_id);

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

create trigger set_subtasks_updated_at
  before update on public.subtasks
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

create trigger set_portal_files_updated_at
  before update on public.portal_files
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
alter table public.subtasks enable row level security;
alter table public.comments enable row level security;
alter table public.activities enable row level security;
alter table public.leads enable row level security;
alter table public.lead_interactions enable row level security;
alter table public.lead_proposals enable row level security;
alter table public.lead_fields enable row level security;
alter table public.lead_members enable row level security;
alter table public.lead_contacts enable row level security;
alter table public.portal_settings enable row level security;
alter table public.portal_files enable row level security;

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

create policy "subtasks_all" on public.subtasks
  for all to authenticated using (true) with check (true);

create policy "comments_all" on public.comments
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

create policy "portal_files_all" on public.portal_files
  for all to authenticated using (true) with check (true);

-- ============================================================
-- STORAGE: Portal Files Bucket (public, 50MB limit)
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
