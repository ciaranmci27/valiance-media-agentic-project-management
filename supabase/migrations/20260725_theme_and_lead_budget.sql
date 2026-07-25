-- Schema changes bundled with the app UI/UX redesign.

-- 1) Per-user light/dark theme preference.
-- NULL means the user has not explicitly chosen a theme yet, so the app follows the
-- OS preference (and localStorage) on their devices. A non-null value is an explicit
-- choice that syncs across devices.
alter table public.team_members
  add column if not exists theme_preference text
  check (theme_preference in ('light', 'dark'));

-- 2) Leads no longer track a numeric deal value or equity stake; the qualitative
-- "Budget Range" lead field (in lead_fields) replaces them.
alter table public.leads drop column if exists value;
alter table public.leads drop column if exists equity;
