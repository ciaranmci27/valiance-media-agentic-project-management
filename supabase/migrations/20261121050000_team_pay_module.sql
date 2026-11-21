-- Team pay: Billing splits into two modules.
--
-- "Client invoicing" keeps the module id billing (invoices, retainers,
-- billing plans, payments, company revenue), so existing switches and data
-- are untouched. "Team pay" (team_pay) takes pay rates, payroll, payouts and
-- own earnings: compensation.manage, payouts.manage and earnings.own.read.
--
-- 1. The team_pay switch, set as Billing is: a workspace with everything on
--    keeps everything on, and one that had Billing off (so no pay) keeps pay
--    off and approves time without a rate, as it did.
-- 2. The three pay permissions follow Team pay.
-- 3. Finished time is approved as it is logged, for every role, while both
--    money modules are off: no money rides on it, so nothing to review.
-- 4. Approving time asks for a pay rate, and snapshots it, only while Team
--    pay is on. Agent billed-time conversion stays with Client invoicing.
--
-- Works with the 1.4.0 code: with every module on, every grant and every
-- approval is what it was. Nothing is deleted. Safe to re-run.

-- 1. The switch. A row already there (a re-run, or an Owner's choice) is kept.
INSERT INTO public.workspace_modules (module_id, enabled)
SELECT 'team_pay', COALESCE((SELECT enabled FROM public.workspace_modules WHERE module_id = 'billing'), true)
ON CONFLICT (module_id) DO NOTHING;

-- 2. The pay permissions.
INSERT INTO public.permission_modules (permission_key, module_id) VALUES
  ('earnings.own.read', 'team_pay'), ('compensation.manage', 'team_pay'), ('payouts.manage', 'team_pay')
ON CONFLICT (permission_key) DO UPDATE SET module_id = EXCLUDED.module_id;

-- 3. Submitting finished time.
CREATE OR REPLACE FUNCTION public.apply_time_entry_compensation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member_role text;
BEGIN
  -- Moving it to Trash or back is not an edit: nothing to resubmit or reprice.
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NEW;
  END IF;
  SELECT role INTO member_role FROM public.team_members WHERE id = NEW.member_id;

  IF TG_OP = 'INSERT' OR NEW.start_time IS DISTINCT FROM OLD.start_time OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    -- The lock guards entries with real compensation behind them. Owner
    -- entries are born approved with rate 0 (no reviewer above the owner, no
    -- hourly pay), so without the role exemption every owner edit was an
    -- edit to an approved entry and the lock fired on the one person it
    -- protects nothing from (20260812_owner_time_entries_stay_editable).
    -- An approved entry stays fixed while money depends on it: it is billed
    -- to a client (Client invoicing on) or paid (Team pay on). With neither,
    -- its owner can still correct it. (Invoiced time has its own lock in
    -- protect_invoiced_time_entry.)
    IF TG_OP = 'UPDATE' AND OLD.approval_status = 'approved' AND member_role <> 'owner'
      AND (public.module_enabled('billing') OR public.module_enabled('team_pay')) THEN
      RAISE EXCEPTION 'Approved time entry compensation is locked';
    END IF;
    IF member_role = 'owner' THEN
      -- Owners have no hourly compensation to resolve or to lock.
      NEW.compensation_rate := 0;
    ELSE
      NEW.compensation_rate := public.resolve_team_member_hourly_rate(NEW.member_id, NEW.start_time);
    END IF;
  END IF;

  IF NEW.end_time IS NULL THEN
    NEW.approval_status := 'draft';
    NEW.submitted_at := NULL;
    NEW.approved_at := NULL;
    NEW.approved_by := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.end_time IS NULL THEN
    NEW.submitted_at := now();
    IF NOT public.module_enabled('billing') AND NOT public.module_enabled('team_pay') THEN
      -- With Client invoicing and Team pay both off no money rides on the
      -- hours, so there is nothing to review: finished time from every role,
      -- agents included, is approved as it is logged. approved_by NULL marks
      -- it as system-approved.
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := NULL;
    ELSIF member_role = 'owner' THEN
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := NEW.member_id;
      NEW.compensation_rate := 0;
    ELSIF member_role <> 'agent'
      AND COALESCE((SELECT auto_approve_human_hours FROM public.business_settings LIMIT 1), true) THEN
      -- Auto-approved by workspace policy; approved_by NULL marks it as
      -- system-approved rather than reviewed by a person.
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := NULL;
    ELSE
      NEW.approval_status := 'pending';
      NEW.approved_at := NULL;
      NEW.approved_by := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.approval_status = 'rejected' AND member_role <> 'owner'
    AND NEW.approval_status = OLD.approval_status THEN
    -- A content edit to a rejected entry resubmits it for review. A review
    -- decision (approval_status changed by review_time_entries) passes
    -- through untouched.
    NEW.approval_status := 'pending';
    NEW.submitted_at := now();
    NEW.approved_at := NULL;
    NEW.approved_by := NULL;
    NEW.rejection_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;

-- 4. Reviewing time, in the app and over the API.
CREATE OR REPLACE FUNCTION public.review_time_entries(
  p_entry_ids uuid[],
  p_decision text,
  p_reason text DEFAULT NULL,
  p_adjustments jsonb DEFAULT NULL
)
RETURNS SETOF public.project_time_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.has_permission('time.approve', 'app') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid review decision';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND member_id = public.current_team_member_id()
  ) THEN
    RAISE EXCEPTION 'Time entries cannot be self-approved';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND NOT public.can_access_project(project_id)
  ) THEN
    RAISE EXCEPTION 'Project access denied';
  END IF;
  -- Pay is Team pay's: with it off, approving time needs no compensation
  -- rate and sets none.
  IF p_decision = 'approved' AND public.module_enabled('team_pay') AND EXISTS (
    SELECT 1
    FROM public.project_time_entries entry
    JOIN public.team_members member ON member.id = entry.member_id
    WHERE entry.id = ANY(p_entry_ids)
      AND entry.approval_status IN ('pending', 'rejected')
      AND member.role NOT IN ('owner', 'agent')
      AND NOT EXISTS (
        SELECT 1 FROM public.team_member_hourly_rates rate
        WHERE rate.member_id = entry.member_id
          AND rate.effective_at <= entry.start_time
      )
  ) THEN
    RAISE EXCEPTION 'Compensation rate missing for one or more time entries';
  END IF;

  UPDATE public.project_time_entries entry
  SET approval_status = p_decision,
      compensation_rate = CASE WHEN p_decision = 'approved' AND public.module_enabled('team_pay')
        THEN public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time)
        ELSE entry.compensation_rate END,
      approved_at = CASE WHEN p_decision = 'approved' THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_decision = 'approved' THEN public.current_team_member_id() ELSE NULL END,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN COALESCE(p_reason, '') ELSE NULL END,
      updated_at = now()
  WHERE entry.id = ANY(p_entry_ids)
    AND entry.approval_status IN ('pending', 'rejected')
    AND entry.end_time IS NOT NULL
    AND entry.deleted_at IS NULL;

  -- Approved agent entries convert to their billed continuous slot here,
  -- optionally with the reviewer's adjusted worked minutes per entry id
  -- (Client invoicing only).
  IF p_decision = 'approved' AND public.module_enabled('billing') THEN
    FOREACH v_id IN ARRAY p_entry_ids LOOP
      PERFORM public.apply_agent_billing_conversion(
        v_id,
        CASE WHEN p_adjustments IS NOT NULL AND p_adjustments ? v_id::text
          THEN (p_adjustments->>v_id::text)::numeric
          ELSE NULL END
      );
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT * FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND deleted_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_time_entries_api(
  p_project_id uuid,
  p_entry_ids uuid[],
  p_decision text,
  p_reason text,
  p_reviewer_id uuid
)
RETURNS SETOF public.project_time_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF COALESCE(array_length(p_entry_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'Select at least one time entry'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Invalid review decision'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_members WHERE id = p_reviewer_id AND status = 'active') THEN RAISE EXCEPTION 'Active reviewer not found'; END IF;
  IF (SELECT count(*) FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND deleted_at IS NULL) <> cardinality(p_entry_ids) THEN RAISE EXCEPTION 'One or more time entries were not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND project_id IS DISTINCT FROM p_project_id) THEN RAISE EXCEPTION 'Time entry does not belong to the project'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND member_id = p_reviewer_id) THEN RAISE EXCEPTION 'Time entries cannot be self-approved'; END IF;
  -- With Team pay off, approval needs no rate and sets none.
  IF p_decision = 'approved' AND public.module_enabled('team_pay') AND EXISTS (
    SELECT 1 FROM public.project_time_entries entry
    JOIN public.team_members member ON member.id = entry.member_id
    WHERE entry.id = ANY(p_entry_ids) AND entry.approval_status = 'pending'
      AND member.role NOT IN ('owner', 'agent')
      AND NOT EXISTS (SELECT 1 FROM public.team_member_hourly_rates rate WHERE rate.member_id = entry.member_id AND rate.effective_at <= entry.start_time)
  ) THEN RAISE EXCEPTION 'Compensation rate missing for one or more time entries'; END IF;
  UPDATE public.project_time_entries entry
  SET approval_status = p_decision,
      compensation_rate = CASE WHEN p_decision = 'approved' AND public.module_enabled('team_pay') THEN public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time) ELSE entry.compensation_rate END,
      approved_at = CASE WHEN p_decision = 'approved' THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_decision = 'approved' THEN p_reviewer_id ELSE NULL END,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN COALESCE(p_reason, '') ELSE NULL END,
      updated_at = now()
  WHERE entry.id = ANY(p_entry_ids) AND entry.project_id = p_project_id
    AND entry.approval_status = 'pending' AND entry.end_time IS NOT NULL;
  -- Agent billed-time conversion is Client invoicing's.
  IF p_decision = 'approved' AND public.module_enabled('billing') THEN
    PERFORM public.apply_agent_billing_conversion(entry_id, NULL)
    FROM unnest(p_entry_ids) AS entry_id;
  END IF;
  RETURN QUERY
  SELECT * FROM public.project_time_entries
  WHERE id = ANY(p_entry_ids) AND project_id = p_project_id;
END;
$$;