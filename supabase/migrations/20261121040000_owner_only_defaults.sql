-- Owners only, by default: company money and the workspace's own setup.
--
-- 1. The Admin role no longer starts with these permissions. Admins run the
--    team and the projects; the business details, email setup, webhooks and
--    every money view (revenue, invoices, payroll, pay rates, payouts) are the
--    Owners'. An Owner can still grant any of them to a person in Access
--    control. Owners hold every permission and are unchanged.
-- 2. Invoice draft emails and bells go to Owners and to people granted
--    invoices.read or invoices.manage, not to every Admin.
-- 3. A workspace always keeps at least one active Owner: demoting, suspending
--    or deleting the last one is refused, so nobody is ever locked out of
--    Features, Brand, Updates and Access control.
--
-- Safe to re-run.

DELETE FROM public.role_permissions
WHERE role = 'admin'
  AND permission_key IN (
    'settings.manage', 'smtp.manage', 'webhooks.manage', 'inbound_email.manage',
    'billing.manage', 'finance.company.read', 'invoices.read', 'invoices.manage',
    'invoices.record_payments', 'compensation.manage', 'payouts.manage'
  );

CREATE OR REPLACE FUNCTION public.keep_an_active_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role IS DISTINCT FROM 'owner' OR NEW.status IS DISTINCT FROM 'active') THEN
    -- Lock the Owners' rows first, so two Owners leaving at once cannot both pass.
    PERFORM 1 FROM public.team_members WHERE role = 'owner' FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM public.team_members
      WHERE role = 'owner' AND status = 'active' AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'At least one active Owner is required. Make someone else an Owner first.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.keep_an_active_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS keep_an_active_owner ON public.team_members;
CREATE TRIGGER keep_an_active_owner
  BEFORE UPDATE OF role, status OR DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.keep_an_active_owner();

-- Invoice drafts reach the people who may see invoices: Owners, and anyone
-- an Owner granted invoices.read or invoices.manage (no longer every Admin).
-- One member's effective permission (role default, per-person override,
-- module switch), for server-side code that picks people rather than acting
-- as them: who gets an invoice draft email or bell, for instance.
CREATE OR REPLACE FUNCTION public.member_has_permission(p_member_id uuid, p_permission_key text, p_access_channel text DEFAULT 'app')
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH member AS (
    SELECT id, role FROM public.team_members WHERE id = p_member_id AND status = 'active'
  )
  SELECT COALESCE(
    (SELECT module.enabled
     FROM public.permission_modules permission_module
     JOIN public.workspace_modules module ON module.module_id = permission_module.module_id
     WHERE permission_module.permission_key = p_permission_key),
    true
  ) AND (
    COALESCE((SELECT role = 'owner' FROM member), false)
    OR COALESCE(
      (SELECT effect = 'allow'
       FROM public.team_member_permissions override_permission, member
       WHERE override_permission.member_id = member.id
         AND override_permission.permission_key = p_permission_key
         AND override_permission.access_channel = p_access_channel),
      EXISTS (
        SELECT 1 FROM public.role_permissions role_permission, member
        WHERE role_permission.role = member.role
          AND role_permission.permission_key = p_permission_key
          AND role_permission.access_channel = p_access_channel
      )
    )
  )
$$;

REVOKE ALL ON FUNCTION public.member_has_permission(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_has_permission(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.generate_retainer_drafts(p_as_of date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  as_of date := COALESCE(p_as_of, public.workspace_today());
  target record;
  lines jsonb;
  invoice_date date;
  created integer := 0;
  draft public.project_invoices;
  recipient uuid;
  project_name text;
BEGIN
  INSERT INTO public.project_retainer_periods (retainer_id, period_start, period_end, status)
  SELECT due.retainer_id, due.period_start, due.period_end, 'skipped'
  FROM public.retainer_due_periods_internal(NULL, as_of) due
  WHERE due.retainer_status = 'paused'
  ON CONFLICT (retainer_id, period_start) DO NOTHING;

  FOR target IN
    SELECT DISTINCT due.project_id
    FROM public.retainer_due_periods_internal(NULL, as_of) due
    WHERE due.retainer_status = 'active'
  LOOP
    BEGIN
      SELECT
        jsonb_agg(
          public.retainer_line_json(
            due.retainer_id, (due.line_position - 1)::integer, due.amount, due.description,
            due.period_start, due.period_end
          ) ORDER BY due.line_position
        ),
        GREATEST(MAX(due.bill_date), as_of)
      INTO lines, invoice_date
      FROM (
        SELECT inner_due.*, row_number() OVER (ORDER BY inner_due.period_start, inner_due.retainer_name) AS line_position
        FROM public.retainer_due_periods_internal(target.project_id, as_of) inner_due
        WHERE inner_due.retainer_status = 'active'
      ) due;

      draft := public.create_retainer_draft_internal(target.project_id, lines, invoice_date, true);
      IF draft.id IS NOT NULL THEN
        created := created + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, detail)
      VALUES (target.project_id, 'retainer-failed:' || to_char(as_of, 'YYYY-MM-DD'), as_of, 'failed',
              left('Retainer draft: ' || SQLERRM, 500))
      ON CONFLICT (project_id, run_key) DO UPDATE SET detail = EXCLUDED.detail, created_at = now();
      SELECT name INTO project_name FROM public.projects WHERE id = target.project_id;
      FOR recipient IN
        SELECT id FROM public.team_members WHERE status = 'active'
          AND (public.member_has_permission(id, 'invoices.read') OR public.member_has_permission(id, 'invoices.manage'))
      LOOP
        PERFORM public.upsert_notification(
          recipient,
          'Retainer draft failed',
          'The retainer invoice for ' || COALESCE(project_name, 'a project') || ' could not be drafted: '
            || left(SQLERRM, 200) || '. Generate it from Billing, Retainers, once fixed.',
          '/projects/' || target.project_id::text || '?tab=invoices',
          'project',
          target.project_id::text
        );
      END LOOP;
    END;
  END LOOP;

  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION public.announce_billing_draft(p_invoice_id uuid, p_title text, p_message text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.project_invoices;
  recipient uuid;
BEGIN
  SELECT * INTO invoice FROM public.project_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  FOR recipient IN
    SELECT id FROM public.team_members WHERE status = 'active'
          AND (public.member_has_permission(id, 'invoices.read') OR public.member_has_permission(id, 'invoices.manage'))
  LOOP
    PERFORM public.upsert_notification(
      recipient, p_title, p_message,
      '/projects/' || invoice.project_id::text || '?tab=invoices',
      'invoice', invoice.id::text
    );
  END LOOP;
  INSERT INTO public.billing_draft_notices (invoice_id, project_id, summary)
  VALUES (invoice.id, invoice.project_id, p_message)
  ON CONFLICT (invoice_id) DO UPDATE SET summary = EXCLUDED.summary, emailed_at = NULL, relayed_at = NULL;
END;
$$;
