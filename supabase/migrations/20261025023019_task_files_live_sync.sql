-- Task files in live sync: a file attached by anyone (Ashley through the
-- API, a teammate in the app) reaches open screens as it happens, the same
-- way comments and subtasks do. Realtime checks each subscriber's RLS, so a
-- file's change only reaches people who can see it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'task_files') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.task_files;
  END IF;
END $$;
