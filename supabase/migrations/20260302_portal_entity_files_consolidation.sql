-- Migration: Portal & Entity Files Consolidation
-- Consolidates portal_files into entity_files with visibility,
-- updates portal_settings columns, and switches tokens to app-generated slugs.

-- ============================================================
-- 1. portal_settings: drop show_proposals, add show_invoices + section_order,
--    remove DB-side token default (app now generates slug tokens)
-- ============================================================

alter table public.portal_settings
  drop column if exists show_proposals;

alter table public.portal_settings
  add column if not exists show_invoices boolean not null default false;

alter table public.portal_settings
  add column if not exists section_order text[] not null default '{show_progress,show_hours,show_updates,show_files,show_credentials,show_invoices}';

alter table public.portal_settings
  alter column token drop default;

-- ============================================================
-- 2. entity_files: add visibility column with check constraint + partial index
-- ============================================================

alter table public.entity_files
  add column if not exists visibility text not null default 'internal';

alter table public.entity_files
  add constraint entity_files_visibility_check check (visibility in ('internal', 'external'));

create index if not exists idx_entity_files_external_project
  on public.entity_files(entity_id)
  where entity_type = 'project' and visibility = 'external';

-- ============================================================
-- 3. Drop portal_files table and all its dependencies
-- ============================================================

drop trigger if exists set_portal_files_updated_at on public.portal_files;
drop policy if exists "portal_files_all" on public.portal_files;
drop index if exists idx_portal_files_project_id;
drop table if exists public.portal_files;
