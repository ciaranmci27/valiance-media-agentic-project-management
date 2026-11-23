-- Function grants: the public anon key executes no app function, and a
-- signed-in member (authenticated) executes only the ones the app needs.
--
-- Why: Supabase grants EXECUTE on every new function to PUBLIC, anon and
-- authenticated. Each pm function checks permissions inside, but the anon key
-- ships to every browser, so it should reach nothing. authenticated keeps
-- EXECUTE only where row policies, column defaults, check constraints, the
-- SECURITY INVOKER functions members call, or the app's browser and session
-- RPCs need it. Everything else is called only from SECURITY DEFINER
-- functions, triggers or the service role, which need no grant to members.
-- service_role keeps EXECUTE on every function it could run before.
--
-- Trigger functions and functions owned by extensions are left alone. The
-- pm-2.0 bridge wrappers in public and communications are left alone too:
-- they run as the caller, so they reach only what the caller may execute in pm.
--
-- New functions: default privileges in pm no longer grant EXECUTE to anon or
-- authenticated, and in pm_custom no longer to anon (an install's own
-- functions may need members). Postgres still grants new functions to PUBLIC
-- unless a function revokes it, so every new pm function says who may run it
-- (test:function-grants fails until it does). Other schemas in a shared
-- database are not touched.
--
-- Additive and safe to run twice: it sets the same grants whatever state the
-- database starts in. The previous release's code keeps working: every
-- function it calls as a member is in the list below, and the service role
-- loses nothing.

DO $grants$
DECLARE
  -- Functions a signed-in member may execute.
  member_functions text[] := ARRAY[
    -- Row policies (pm tables and storage) call these as the member.
    'can_access_file_entity', 'can_access_lead', 'can_access_project', 'can_access_task',
    'can_manage_inbox', 'can_read_activity', 'can_read_all_tasks', 'can_read_inbox',
    'can_read_message', 'can_read_task_row', 'can_see_reminder', 'current_team_member_id',
    'current_team_member_role', 'has_permission', 'module_enabled',
    'contact_is_live', 'credential_is_live', 'file_entity_is_live', 'invoice_is_live',
    'lead_is_live', 'portal_update_is_live', 'project_is_live', 'retainer_is_live',
    'task_is_live', 'time_entry_is_live',
    -- Column defaults and check constraints evaluate these on a member's write.
    'workspace_currency', 'email_inbox_verification_code', 'email_is_address',
    'email_is_hostname', 'email_domain_is_public',
    -- RPCs the browser and session clients call.
    'save_task', 'convert_lead', 'requeue_webhook_delivery', 'mark_task_seen',
    'mark_tasks_seen', 'my_task_updates', 'agent_analytics_window',
    'save_project_invoice_with_allocations', 'project_invoice_payments',
    'record_invoice_payment', 'remove_invoice_payment', 'save_project_retainer',
    'schedule_retainer_amount', 'set_retainer_shares', 'generate_retainer_period',
    'retainer_due_periods', 'save_project_billing_plan', 'billing_forecast',
    'set_invoice_line_shares', 'list_trash', 'soft_delete_record', 'restore_record',
    'suggest_project_invoice_number', 'retainer_accruing_lines', 'set_credential_members',
    'review_time_entries', 'record_team_member_payout', 'set_task_parent',
    -- agent_analytics_window runs as the caller and calls these.
    'agent_analytics_int', 'agent_analytics_num', 'agent_analytics_ts',
    -- Read-only and scoped to the caller; kept for installs' own code.
    'is_admin', 'get_team_directory', 'get_my_access_context',
    'get_accessible_time_entries', 'get_accessible_credential_metadata', 'invoice_hours_draft'
  ];
  fn record;
  target text;
BEGIN
  FOR fn IN
    SELECT p.oid, p.proname, p.prokind,
           format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS signature,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_had
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pm'
      AND p.prokind IN ('f', 'p')
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    target := CASE WHEN fn.prokind = 'p' THEN 'PROCEDURE ' ELSE 'FUNCTION ' END || fn.signature;
    EXECUTE 'REVOKE EXECUTE ON ' || target || ' FROM PUBLIC, anon';
    IF fn.proname = ANY (member_functions) THEN
      EXECUTE 'GRANT EXECUTE ON ' || target || ' TO authenticated';
    ELSE
      EXECUTE 'REVOKE EXECUTE ON ' || target || ' FROM authenticated';
    END IF;
    -- Revoking PUBLIC must not take away what the service role ran before.
    IF fn.service_had THEN
      EXECUTE 'GRANT EXECUTE ON ' || target || ' TO service_role';
    END IF;
  END LOOP;
END
$grants$;

ALTER DEFAULT PRIVILEGES IN SCHEMA pm REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA pm_custom REVOKE EXECUTE ON FUNCTIONS FROM anon;
