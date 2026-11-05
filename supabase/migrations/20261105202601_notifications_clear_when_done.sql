-- A notification about something finished is noise, so it clears when the
-- thing it is about does: a reminder closed, an invoice no longer a draft, a
-- retainer draft that worked this time, a review queue emptied. Whoever
-- finished it, a person or an agent. Clearing hides the row and changes
-- nothing else about it, so one that comes back is as it was.
--
-- Apply before the app deploys: the app filters on cleared_at.

ALTER TABLE public.team_member_notifications ADD COLUMN IF NOT EXISTS cleared_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_team_member_notifications_entity
  ON public.team_member_notifications (entity_type, entity_id);

-- Raising a notification again brings back one cleared while still unread.
CREATE OR REPLACE FUNCTION public.upsert_notification(
  p_user_id uuid,
  p_title text,
  p_message text,
  p_link text,
  p_entity_type text,
  p_entity_id text
) RETURNS void AS $$
BEGIN
  UPDATE public.team_member_notifications
  SET title = p_title, message = p_message, link = p_link, created_at = now(), cleared_at = NULL
  WHERE user_id = p_user_id
    AND entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND is_read = false;

  IF NOT FOUND THEN
    INSERT INTO public.team_member_notifications (user_id, title, message, link, entity_type, entity_id)
    VALUES (p_user_id, p_title, p_message, p_link, p_entity_type, p_entity_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.upsert_notification(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_notification(uuid, text, text, text, text, text) TO service_role;

-- Clears, or brings back, everyone's notifications about one thing. p_title
-- narrows it where the entity is shared: a project has many kinds of notice.
CREATE OR REPLACE FUNCTION public.set_notifications_cleared(p_entity_type text, p_entity_id text, p_cleared boolean, p_title text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.team_member_notifications
  SET cleared_at = CASE WHEN p_cleared THEN now() END
  WHERE entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND (p_title IS NULL OR title = p_title)
    AND (cleared_at IS NULL) = p_cleared;
$$;

REVOKE ALL ON FUNCTION public.set_notifications_cleared(text, text, boolean, text) FROM PUBLIC, anon, authenticated;

-- A reminder's bell goes when it closes, is deleted or moves to a later time
-- (the new time rings again). Reopened or restored, its bell comes back.
CREATE OR REPLACE FUNCTION public.sync_reminder_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'open' OR NEW.deleted_at IS NOT NULL OR NEW.notified_at IS NULL THEN
    PERFORM public.set_notifications_cleared('reminder', NEW.id::text, true);
  ELSIF OLD.status <> 'open' OR OLD.deleted_at IS NOT NULL THEN
    PERFORM public.set_notifications_cleared('reminder', NEW.id::text, false);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_reminder_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_reminder_notification ON public.reminders;
CREATE TRIGGER sync_reminder_notification
  AFTER UPDATE ON public.reminders
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.notified_at IS DISTINCT FROM OLD.notified_at)
  EXECUTE FUNCTION public.sync_reminder_notification();

-- "Ready to review and send" holds only while the invoice is a draft. A new
-- retainer draft answers the last "Retainer draft failed" on its project.
CREATE OR REPLACE FUNCTION public.sync_invoice_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.auto_generated THEN
      PERFORM public.set_notifications_cleared('project', NEW.project_id::text, true, 'Retainer draft failed');
    END IF;
  ELSE
    PERFORM public.set_notifications_cleared('invoice', NEW.id::text, NEW.status <> 'draft' OR NEW.deleted_at IS NOT NULL);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_invoice_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_invoice_notification ON public.project_invoices;
CREATE TRIGGER sync_invoice_notification
  AFTER INSERT ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.sync_invoice_notification();
DROP TRIGGER IF EXISTS sync_invoice_notification_update ON public.project_invoices;
CREATE TRIGGER sync_invoice_notification_update
  AFTER UPDATE ON public.project_invoices
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  EXECUTE FUNCTION public.sync_invoice_notification();

-- Greg's nudge says a project's findings wait on a review. It goes once none do.
CREATE OR REPLACE FUNCTION public.sync_findings_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.task_suggestions
    WHERE project_id = NEW.project_id AND status IN ('pending', 'needs_info')
  ) THEN
    PERFORM public.set_notifications_cleared('project', NEW.project_id::text, true, 'Greg''s findings are waiting on you');
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_findings_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_findings_notification ON public.task_suggestions;
CREATE TRIGGER sync_findings_notification
  AFTER UPDATE OF status ON public.task_suggestions
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.sync_findings_notification();

-- What already finished before this ran.
UPDATE public.team_member_notifications n
SET cleared_at = now()
FROM public.reminders r
WHERE n.cleared_at IS NULL AND n.entity_type = 'reminder' AND n.entity_id = r.id::text
  AND (r.status <> 'open' OR r.deleted_at IS NOT NULL OR r.notified_at IS NULL);

UPDATE public.team_member_notifications n
SET cleared_at = now()
FROM public.project_invoices i
WHERE n.cleared_at IS NULL AND n.entity_type = 'invoice' AND n.entity_id = i.id::text
  AND (i.status <> 'draft' OR i.deleted_at IS NOT NULL);

UPDATE public.team_member_notifications n
SET cleared_at = now()
WHERE n.cleared_at IS NULL AND n.entity_type = 'project' AND n.title = 'Greg''s findings are waiting on you'
  AND NOT EXISTS (
    SELECT 1 FROM public.task_suggestions s
    WHERE s.project_id::text = n.entity_id AND s.status IN ('pending', 'needs_info')
  );
