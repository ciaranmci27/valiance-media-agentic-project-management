-- Realtime live-sync: publish the workspace tables the app store hydrates from
-- so the browser can subscribe to postgres_changes and refetch changed slices.
-- Events respect RLS, so each user only receives changes for rows they can
-- already read. Idempotent: safe to re-run.

do $$
declare
  t text;
begin
  -- Local/self-hosted safety: hosted Supabase ships this publication built in.
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array[
    -- Tasks and their sub-resources
    'tasks', 'task_subtasks', 'task_assignees', 'task_acceptance_criteria',
    'task_dependencies', 'task_comments',
    -- Projects and membership
    'projects', 'project_members',
    -- Team
    'team_members',
    -- Contacts
    'contacts', 'project_contacts',
    -- Leads
    'leads', 'lead_members', 'lead_interactions', 'lead_proposals',
    'lead_fields', 'lead_contacts',
    -- Activity feeds
    'activities', 'agent_activities',
    -- Portal
    'portal_settings', 'portal_updates', 'portal_update_attachments',
    -- Files
    'entity_files',
    -- Time tracking
    'project_time_entries', 'time_entry_tasks',
    -- Credentials (clients can submit via the portal)
    'project_credentials',
    -- Invoices
    'project_invoices', 'invoice_time_entry_allocations',
    -- Agent workflow
    'task_suggestions', 'project_goals',
    -- Notifications + client communications log
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
