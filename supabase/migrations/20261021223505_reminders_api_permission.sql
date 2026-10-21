-- ============================================================
-- reminders.manage_own: read, add, tick off and change reminders through
-- the API (/api/v1/reminders and the PM MCP reminder tools). API channel
-- only: in the app every member already works their reminders under RLS.
-- On by default for admins, members and agents, like notifications; a key
-- still needs the scope added before it can use it.
-- ============================================================
INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'reminders.manage_own', 'api'),
  ('member', 'reminders.manage_own', 'api'),
  ('agent', 'reminders.manage_own', 'api')
ON CONFLICT DO NOTHING;
