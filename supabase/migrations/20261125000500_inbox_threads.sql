-- Inbox threads: reply drafts reach live sync.
--
-- The Inbox list now marks a thread whose reply draft is written and not yet
-- copied ("Draft ready"), and keeps it in the Inbox until then. So a draft
-- written or copied (on this device or another) must refresh the list and the
-- open thread like any other Inbox change: pm.reply_drafts joins the Realtime
-- publication beside the other Inbox tables. Members still see only the
-- drafts their row policy lets them read.
--
-- Additive and safe to run twice. The previous release's code ignores the
-- extra change events.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'reply_drafts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pm.reply_drafts;
  END IF;
END $$;
