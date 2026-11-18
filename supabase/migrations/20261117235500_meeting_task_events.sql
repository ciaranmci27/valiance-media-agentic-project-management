-- A meeting linked to a task read as "Ashley linked an email" on the task's
-- card: meetings and emails link through the same communications.task_links,
-- and its trigger logged every link as an email. The event now says meeting
-- when the linked message is a meeting, and earlier meeting links are
-- relabelled (their event was written in the link's own transaction, so it
-- carries the link's created_at).

ALTER TABLE public.task_events DROP CONSTRAINT IF EXISTS task_events_kind_check;
ALTER TABLE public.task_events ADD CONSTRAINT task_events_kind_check
  CHECK (kind IN ('edit', 'status', 'comment', 'email', 'meeting', 'file', 'subtask', 'assignee', 'review'));

CREATE OR REPLACE FUNCTION public.record_task_link_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.record_task_event(NEW.task_id, CASE
    WHEN EXISTS (SELECT 1 FROM communications.messages m WHERE m.id = NEW.message_id AND m.channel = 'meeting') THEN 'meeting'
    ELSE 'email'
  END);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.record_task_link_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS record_task_event ON communications.task_links;
CREATE TRIGGER record_task_event AFTER INSERT ON communications.task_links
  FOR EACH ROW EXECUTE FUNCTION public.record_task_link_event();

UPDATE public.task_events e SET kind = 'meeting'
FROM communications.task_links l
JOIN communications.messages m ON m.id = l.message_id
WHERE e.kind = 'email' AND m.channel = 'meeting' AND e.task_id = l.task_id AND e.at = l.created_at;
