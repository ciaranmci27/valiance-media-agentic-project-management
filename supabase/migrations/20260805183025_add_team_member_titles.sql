-- Team members get a human-editable title ("Auditor", "Developer", "Spec & PM").
--
-- The agent command center was shipping with role captions hardcoded to three
-- first names in the UI, so a fourth agent, or renaming one, would silently
-- render wrong. The title is data about the member, so it lives on the member
-- row and the UI only ever displays it.
alter table public.team_members
  add column if not exists title text;
