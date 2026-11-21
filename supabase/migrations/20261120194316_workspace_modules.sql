-- Workspace modules: parts of the app a workspace switches on or off.
--
-- One rule enforces a module everywhere: a permission whose module is off is
-- held by nobody, owners included. has_permission() applies it, so every RLS
-- policy, RPC and API check that already asks for a permission follows the
-- switch with no other change. Switching a module off hides it; no data is
-- deleted, and switching it back on restores everything.
--
-- Existing installs keep every module on and are marked as set up, so nothing
-- changes until an owner switches something. Safe to re-run.

-- 1. Which modules are on. Core is always on and has no row.
CREATE TABLE IF NOT EXISTS public.workspace_modules (
  module_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_workspace_modules_updated_at ON public.workspace_modules;
CREATE TRIGGER set_workspace_modules_updated_at
  BEFORE UPDATE ON public.workspace_modules
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

INSERT INTO public.workspace_modules (module_id) VALUES
  ('time'), ('billing'), ('contacts'), ('sales'), ('portal'),
  ('inbox'), ('agents'), ('credentials'), ('webhooks')
ON CONFLICT (module_id) DO NOTHING;

-- 2. The module each permission belongs to. A permission with no row is core.
-- Mirrors PERMISSION_MODULE in src/lib/modules/registry.ts (test:modules
-- checks they agree).
CREATE TABLE IF NOT EXISTS public.permission_modules (
  permission_key text PRIMARY KEY,
  module_id text NOT NULL REFERENCES public.workspace_modules(module_id)
);

INSERT INTO public.permission_modules (permission_key, module_id) VALUES
  ('time.manage_own', 'time'), ('time.read_all', 'time'), ('time.manage_all', 'time'), ('time.approve', 'time'),
  ('contacts.read', 'contacts'), ('contacts.read_all', 'contacts'), ('contacts.manage', 'contacts'),
  ('leads.read', 'sales'), ('leads.read_all', 'sales'), ('leads.manage', 'sales'),
  ('portal.read', 'portal'), ('portal.manage', 'portal'),
  ('communications.read', 'inbox'), ('communications.manage', 'inbox'),
  ('inbound_email.read', 'inbox'), ('inbound_email.triage', 'inbox'), ('inbound_email.signal', 'inbox'),
  ('inbound_email.manage', 'inbox'), ('meetings.write', 'inbox'),
  ('credentials.reveal_shared', 'credentials'), ('credentials.manage', 'credentials'),
  ('invoices.read', 'billing'), ('invoices.manage', 'billing'), ('invoices.record_payments', 'billing'),
  ('billing.manage', 'billing'), ('finance.company.read', 'billing'), ('earnings.own.read', 'billing'),
  ('compensation.manage', 'billing'), ('payouts.manage', 'billing'),
  ('webhooks.manage', 'webhooks'),
  ('agents.manage', 'agents'),
  ('goals.read', 'agents'), ('goals.manage', 'agents'), ('suggestions.create', 'agents'),
  ('suggestions.manage', 'agents'), ('agent_activity.write', 'agents'), ('fleet_alerts.write', 'agents')
ON CONFLICT (permission_key) DO UPDATE SET module_id = EXCLUDED.module_id;

-- 3. Everyone signed in may read both (the app shows what is on). Nobody
-- writes through the API: the Owner switches modules in Settings, whose one
-- server route keeps dependencies whole and records the change.
ALTER TABLE public.workspace_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_modules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_modules_read ON public.workspace_modules;
CREATE POLICY workspace_modules_read ON public.workspace_modules FOR SELECT TO authenticated
  USING (true);
DROP POLICY IF EXISTS permission_modules_read ON public.permission_modules;
CREATE POLICY permission_modules_read ON public.permission_modules FOR SELECT TO authenticated
  USING (true);

REVOKE ALL ON public.workspace_modules FROM anon;
REVOKE ALL ON public.permission_modules FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.workspace_modules FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.permission_modules FROM authenticated;

-- 4. First-run setup: existing installs are already set up.
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS setup_completed_at timestamptz;
UPDATE public.business_settings SET setup_completed_at = now() WHERE setup_completed_at IS NULL;

-- 5. module_enabled(): for cron jobs and service-role code paths that skip RLS.
CREATE OR REPLACE FUNCTION public.module_enabled(p_module_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT enabled FROM public.workspace_modules WHERE module_id = p_module_id), true)
$$;

REVOKE ALL ON FUNCTION public.module_enabled(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.module_enabled(text) TO authenticated, service_role;

-- 6. has_permission(): unchanged, except a permission of a switched-off module
-- is false for everyone, owners included. One primary-key read per call.
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
    (SELECT module.enabled
     FROM public.permission_modules permission_module
     JOIN public.workspace_modules module ON module.module_id = permission_module.module_id
     WHERE permission_module.permission_key = p_permission_key),
    true
  ) AND (
    COALESCE(
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
  )
$$;

-- 7. get_my_access_context(): drops keys of switched-off modules and says
-- which modules are on. Owners keep '*'; the app reads `modules` for them.
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
  ), off_keys AS (
    SELECT permission_module.permission_key
    FROM public.permission_modules permission_module
    JOIN public.workspace_modules module ON module.module_id = permission_module.module_id
    WHERE NOT module.enabled
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
      COALESCE((SELECT jsonb_agg(permission_key ORDER BY permission_key) FROM keys
        WHERE access_channel = 'app' AND permission_key NOT IN (SELECT permission_key FROM off_keys)), '[]'::jsonb) END,
    'api_permissions', CASE WHEN actor.role = 'owner' THEN jsonb_build_array('*') ELSE
      COALESCE((SELECT jsonb_agg(permission_key ORDER BY permission_key) FROM keys
        WHERE access_channel = 'api' AND permission_key NOT IN (SELECT permission_key FROM off_keys)), '[]'::jsonb) END,
    'project_ids', COALESCE((SELECT jsonb_agg(project_id) FROM public.project_members WHERE member_id = actor.id), '[]'::jsonb),
    'modules', COALESCE((SELECT jsonb_agg(module_id ORDER BY module_id) FROM public.workspace_modules WHERE enabled), '[]'::jsonb)
  )
  FROM actor
$$;

-- 8. Every open tab learns of a switch at once.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'workspace_modules'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_modules;
  END IF;
END $$;
