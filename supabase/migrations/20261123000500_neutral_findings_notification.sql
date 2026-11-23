-- An agent's nudge that a project's findings wait on a review is cleared once
-- none do. It used to match one agent's exact notification title; it now
-- matches any "<agent>'s findings are waiting on you", so any install's
-- auditing agent gets the same behaviour (the old title still matches).
--
-- Safe to run twice. The previous release's code is unaffected: only the
-- trigger function changes.

CREATE OR REPLACE FUNCTION pm.sync_findings_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.task_suggestions
    WHERE project_id = NEW.project_id AND status IN ('pending', 'needs_info')
  ) THEN
    UPDATE pm.team_member_notifications
    SET cleared_at = now()
    WHERE entity_type = 'project'
      AND entity_id = NEW.project_id::text
      AND cleared_at IS NULL
      AND title LIKE '%findings are waiting on you';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.sync_findings_notification() FROM PUBLIC, anon, authenticated;
