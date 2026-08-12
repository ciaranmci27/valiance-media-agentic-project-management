-- The owner could not edit their own stopped timer.
--
-- Two rules collided. Owner entries are born approved: the moment the timer
-- stops, apply_time_entry_compensation() marks them approved with
-- compensation_rate 0, since there is no reviewer above the owner and no
-- hourly pay to compute. And approved entries lock their compensation basis:
-- any change to start_time or member re-raises the historical rate lookup,
-- so the trigger refuses it outright to keep paid hours from being reshaped
-- after the fact.
--
-- Put together, every edit the owner makes is by definition an edit to an
-- approved entry, and the lock fires on the one person it protects nothing
-- from. The UI shows its optimistic success first, then surfaces this
-- exception - which is the "worked, then failed" the owner actually sees.
--
-- Fix: the lock keeps guarding entries whose NEW state carries real
-- compensation, and owner entries pass through with the owner invariants
-- re-asserted (rate 0, no resolve against the rate history). Reassigning an
-- approved entry AWAY from the owner still locks, because then there is a
-- rate to protect.
CREATE OR REPLACE FUNCTION public.apply_time_entry_compensation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member_role text;
BEGIN
  SELECT role INTO member_role FROM public.team_members WHERE id = NEW.member_id;

  IF TG_OP = 'INSERT' OR NEW.start_time IS DISTINCT FROM OLD.start_time OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    IF TG_OP = 'UPDATE' AND OLD.approval_status = 'approved' AND member_role <> 'owner' THEN
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
    IF member_role = 'owner' THEN
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
