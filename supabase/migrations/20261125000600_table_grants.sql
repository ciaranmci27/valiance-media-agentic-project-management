-- Table grants: the public anon key reads nothing in pm but the workspace
-- brand, and a signed-in member (authenticated) holds only the table
-- privileges a row policy can let through.
--
-- Why: tables made before 2.0 kept Supabase's default grants (ALL to anon and
-- authenticated), so the anon key that ships to every browser held INSERT,
-- UPDATE, DELETE and even TRUNCATE on most pm tables. Row security is what
-- stops it today: every pm table has it on, and no policy but the workspace
-- brand's names anon. This makes the grants a second wall, so a missing or
-- wrong policy cannot become a hole, and TRUNCATE (which row security does
-- not check) is gone.
--
-- What changes, per relation in pm (tables and views):
-- - anon: every privilege goes, except SELECT on pm.workspace_brand (its row
--   policy is the one that names anon: the sign-in page shows the brand).
-- - authenticated: TRUNCATE, REFERENCES, TRIGGER and MAINTAIN go everywhere.
--   SELECT, INSERT, UPDATE and DELETE stay only where a permissive row policy
--   for authenticated allows that command (so nothing that works today stops
--   working), less DELETE on the tables whose forbid_hard_delete trigger
--   refuses every delete (they go to Trash through pm.soft_delete_record).
--   Views keep SELECT only: they run as the caller, and no view's base table
--   lets a member write through it.
-- - Column grants (pm.projects, pm.project_time_entries) are left as they are:
--   only privileges held on the whole table are revoked.
-- - Sequences: anon loses all; authenticated keeps USAGE and SELECT, not
--   UPDATE (setval).
-- - The pm-2.0 bridge views (installs moved from 1.x) keep no more than
--   their pm table, as they always matched it.
-- - service_role, and other apps' objects in a shared database, are not
--   touched.
--
-- New tables: default privileges in pm no longer grant anything to anon, nor
-- TRUNCATE, REFERENCES, TRIGGER or MAINTAIN to authenticated, nor UPDATE on
-- new sequences. A new table still gets SELECT, INSERT, UPDATE and DELETE for
-- authenticated by default (row security decides), and test:table-grants
-- fails until it is on that test's list or revokes what it does not need.
--
-- Additive in spirit and safe to run twice: it only revokes, never grants, and
-- revokes only what is held, so a second run changes nothing. The previous
-- release's code keeps working: everything it reads or writes as a member
-- goes through a row policy, and every privilege such a policy allows stays.
--
-- Also here (one migration per release branch): audit retention drops the
-- template exception it kept for 2.0.29 (see the section at the end).

DO $grants$
DECLARE
  -- What authenticated keeps, per relation: 'name:PRIVILEGES'. A relation not
  -- listed keeps nothing. Never grants: only privileges already held stay.
  member_keeps text[] := ARRAY[
    -- Read only: the row policy is SELECT, writes go through the server.
    'activities:SELECT', 'agent_health:SELECT', 'agent_health_history:SELECT',
    'agent_owner_groups:SELECT', 'agent_owners:SELECT', 'agent_runs:SELECT',
    'analytics_tracking_starts:SELECT', 'answers:SELECT', 'api_audit_log:SELECT',
    'api_keys:SELECT', 'attachments:SELECT', 'conversation_projects:SELECT',
    'conversations:SELECT', 'group_members:SELECT', 'groups:SELECT',
    'ignored_addresses:SELECT', 'inbox_handlers:SELECT', 'invoice_payments:SELECT',
    'maintenance_runs:SELECT', 'meetings:SELECT', 'member_identities:SELECT',
    'message_candidates:SELECT', 'message_endpoints:SELECT', 'messages:SELECT',
    'own_domains:SELECT', 'participants:SELECT', 'permission_modules:SELECT',
    'plan_items:SELECT', 'plans:SELECT', 'portal_events:SELECT',
    'project_agents:SELECT', 'project_billing_plans:SELECT',
    'project_billing_runs:SELECT', 'project_budget_history:SELECT',
    'questions:SELECT', 'reply_drafts:SELECT', 'reply_points:SELECT',
    'sender_rules:SELECT', 'task_events:SELECT', 'task_files:SELECT',
    'task_links:SELECT', 'task_reopens:SELECT', 'task_reviews:SELECT',
    'task_template_runs:SELECT', 'task_templates:SELECT',
    'team_member_share_earnings:SELECT', 'trash_events:SELECT', 'triage:SELECT',
    'webhook_events:SELECT', 'workspace_brand:SELECT', 'workspace_modules:SELECT',
    -- Views (security_invoker): read only.
    'agent_run_feed:SELECT', 'conversation_participants:SELECT',
    'group_member_counts:SELECT', 'project_agent_counts:SELECT',
    'task_template_run_stats:SELECT',
    -- Full row policy (ALL or all four commands), no delete guard.
    'agent_activities:SELECT,INSERT,UPDATE,DELETE',
    'agent_billing_gap_reviews:SELECT,INSERT,UPDATE,DELETE',
    'business_settings:SELECT,INSERT,UPDATE,DELETE',
    'client_addresses:SELECT,INSERT,UPDATE,DELETE',
    'client_domains:SELECT,INSERT,UPDATE,DELETE',
    'contact_emails:SELECT,INSERT,UPDATE,DELETE',
    'endpoints:SELECT,INSERT,UPDATE,DELETE',
    'inbox_access:SELECT,INSERT,UPDATE,DELETE',
    'inboxes:SELECT,INSERT,UPDATE,DELETE',
    'invoice_line_shares:SELECT,INSERT,UPDATE,DELETE',
    'invoice_time_entry_allocations:SELECT,INSERT,UPDATE,DELETE',
    'lead_contacts:SELECT,INSERT,UPDATE,DELETE',
    'lead_members:SELECT,INSERT,UPDATE,DELETE',
    'portal_settings:SELECT,INSERT,UPDATE,DELETE',
    'project_contacts:SELECT,INSERT,UPDATE,DELETE',
    'project_context:SELECT,INSERT,UPDATE,DELETE',
    'project_credential_members:SELECT,INSERT,UPDATE,DELETE',
    'project_goals:SELECT,INSERT,UPDATE,DELETE',
    'project_members:SELECT,INSERT,UPDATE,DELETE',
    'project_retainer_periods:SELECT,INSERT,UPDATE,DELETE',
    'project_retainer_shares:SELECT,INSERT,UPDATE,DELETE',
    'provider_plans:SELECT,INSERT,UPDATE,DELETE',
    'role_permissions:SELECT,INSERT,UPDATE,DELETE',
    'smtp_accounts:SELECT,INSERT,UPDATE,DELETE',
    'task_acceptance_criteria:SELECT,INSERT,UPDATE,DELETE',
    'task_assignees:SELECT,INSERT,UPDATE,DELETE',
    'task_dependencies:SELECT,INSERT,UPDATE,DELETE',
    'task_suggestions:SELECT,INSERT,UPDATE,DELETE',
    'team_member_earning_adjustments:SELECT,INSERT,UPDATE,DELETE',
    'team_member_hourly_rates:SELECT,INSERT,UPDATE,DELETE',
    'team_member_payout_allocations:SELECT,INSERT,UPDATE,DELETE',
    'team_member_payouts:SELECT,INSERT,UPDATE,DELETE',
    'team_member_permissions:SELECT,INSERT,UPDATE,DELETE',
    'time_entry_tasks:SELECT,INSERT,UPDATE,DELETE',
    'webhook_endpoints:SELECT,INSERT,UPDATE,DELETE',
    -- Full row policy, but forbid_hard_delete refuses every DELETE (Trash).
    'client_communications:SELECT,INSERT,UPDATE', 'contacts:SELECT,INSERT,UPDATE',
    'entity_files:SELECT,INSERT,UPDATE', 'lead_fields:SELECT,INSERT,UPDATE',
    'lead_interactions:SELECT,INSERT,UPDATE', 'lead_proposals:SELECT,INSERT,UPDATE',
    'leads:SELECT,INSERT,UPDATE', 'portal_update_attachments:SELECT,INSERT,UPDATE',
    'portal_updates:SELECT,INSERT,UPDATE', 'project_credentials:SELECT,INSERT,UPDATE',
    'project_hourly_rates:SELECT,INSERT,UPDATE', 'project_invoices:SELECT,INSERT,UPDATE',
    'project_retainer_amounts:SELECT,INSERT,UPDATE', 'project_retainers:SELECT,INSERT,UPDATE',
    'reminders:SELECT,INSERT,UPDATE', 'task_comments:SELECT,INSERT,UPDATE',
    'task_subtasks:SELECT,INSERT,UPDATE', 'tasks:SELECT,INSERT,UPDATE',
    'team_members:SELECT,INSERT,UPDATE',
    -- Partial row policies.
    'task_views:SELECT,INSERT,UPDATE',               -- pm.mark_task_seen(s) upsert
    'team_member_notifications:SELECT,UPDATE,DELETE', -- read, mark read, dismiss
    'webhook_deliveries:SELECT,UPDATE',              -- pm.requeue_webhook_delivery
    'workspace_region:SELECT,INSERT,UPDATE'          -- Owner sets the region
    -- Not listed, so nothing at table level: api_rate_limit_windows and
    -- billing_draft_notices (no member policy), projects and
    -- project_time_entries (column grants only, left as they are).
  ];
  anon_keeps text[] := ARRAY['workspace_brand:SELECT'];
  rel record;
  bridge record;
  role_name text;
  keeps text[];
  keep text[];
  priv text;
BEGIN
  FOR rel IN
    SELECT c.oid, c.relname, c.relkind, c.relacl
    FROM pg_class c
    WHERE c.relnamespace = 'pm'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
  LOOP
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF rel.relkind = 'S' THEN
        keep := CASE WHEN role_name = 'authenticated' THEN ARRAY['USAGE', 'SELECT'] ELSE ARRAY[]::text[] END;
      ELSE
        keeps := CASE WHEN role_name = 'anon' THEN anon_keeps ELSE member_keeps END;
        SELECT coalesce(string_to_array(split_part(k, ':', 2), ','), ARRAY[]::text[]) INTO keep
        FROM unnest(keeps) k WHERE split_part(k, ':', 1) = rel.relname;
        keep := coalesce(keep, ARRAY[]::text[]);
      END IF;
      -- Privileges held on the whole relation (column grants are not in relacl).
      FOR priv IN
        SELECT a.privilege_type FROM aclexplode(rel.relacl) a
        WHERE a.grantee = role_name::regrole
      LOOP
        IF NOT priv = ANY (keep) THEN
          EXECUTE format('REVOKE %s ON %s %s FROM %I',
            priv, CASE WHEN rel.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, rel.oid::regclass, role_name);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- The pm-2.0 bridge views (public and communications names, on installs
  -- moved from 1.x, removed in 2.1) run as the caller, so a grant beyond
  -- their pm table reaches nothing: each keeps no more than its table holds.
  FOR bridge IN
    SELECT v.oid, v.relacl, t.relacl AS table_acl
    FROM pg_class v
    JOIN pg_namespace n ON n.oid = v.relnamespace AND n.nspname IN ('public', 'communications')
    JOIN pg_class t ON t.relname = v.relname AND t.relnamespace = 'pm'::regnamespace
    WHERE v.relkind = 'v' AND obj_description(v.oid, 'pg_class') = 'pm-2.0 bridge'
  LOOP
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOR priv IN
        SELECT a.privilege_type FROM aclexplode(bridge.relacl) a
        WHERE a.grantee = role_name::regrole
          AND NOT EXISTS (
            SELECT 1 FROM aclexplode(bridge.table_acl) ta
            WHERE ta.grantee = a.grantee AND ta.privilege_type = a.privilege_type
          )
      LOOP
        EXECUTE format('REVOKE %s ON TABLE %s FROM %I', priv, bridge.oid::regclass, role_name);
      END LOOP;
    END LOOP;
  END LOOP;

  -- New tables and sequences in pm (the defaults of the role that runs the
  -- migrations, as schema.sql set them).
  ALTER DEFAULT PRIVILEGES IN SCHEMA pm REVOKE ALL ON TABLES FROM anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pm REVOKE ALL ON SEQUENCES FROM anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pm REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pm REVOKE UPDATE ON SEQUENCES FROM authenticated;
  -- MAINTAIN exists from Postgres 17.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA pm REVOKE MAINTAIN ON TABLES FROM authenticated';
  END IF;
END
$grants$;

-- ---------------------------------------------------------------------------
-- Audit retention: the template exception goes.
-- pm.purge_audit_log kept every audit row naming the template an agent was
-- set up from, because 2.0.29 read the template there. Since 2.0.30 it lives
-- on the agent (team_members.agent_template_key, set from the audit row by
-- record_agent_template_key as it is written), and the previous release reads
-- the audit log only on a database without that column. Retention now keeps
-- only the deprovision rows reactivation reads.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.purge_audit_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_days integer;
  v_count integer := 0;
BEGIN
  SELECT audit_retention_days INTO v_days FROM pm.business_settings LIMIT 1;
  IF v_days IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM set_config('pm.audit_retention', 'on', true);
  DELETE FROM pm.api_audit_log l
  WHERE l.timestamp < now() - make_interval(days => v_days)
    -- The agents a deprovision took ownership of (read on reactivation).
    AND NOT coalesce(l.endpoint LIKE '/app/team-members/%/deprovision' AND l.request_body->>'step' = 'owner_removed', false);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('pm.audit_retention', 'off', true);
  IF v_count > 0 THEN
    INSERT INTO pm.api_audit_log (method, endpoint, entity_type, request_body, status_code, via)
    VALUES ('DELETE', '/app/audit/retention', 'api_audit_log',
      jsonb_build_object('deleted', v_count, 'retention_days', v_days), 200, 'app');
  END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION pm.purge_audit_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.purge_audit_log() TO service_role;
