-- A project a person set on an email thread is project_source 'person', not
-- 'ciaran': the inbox is for every member who reads it, so nothing stored
-- names one person (as needs_human did for triage).
--
-- Apply just BEFORE the app deploy. Until it lands, the running build still
-- writes 'ciaran' when someone sets a thread's project in the Inbox, which
-- this check refuses: that one action fails for the minute or two in between.

ALTER TABLE public.email_threads DROP CONSTRAINT IF EXISTS email_threads_project_source_check;

-- The update trigger would stamp updated_at; a rename is not activity.
ALTER TABLE public.email_threads DISABLE TRIGGER email_threads_before_update;
UPDATE public.email_threads SET project_source = 'person' WHERE project_source = 'ciaran';
ALTER TABLE public.email_threads ENABLE TRIGGER email_threads_before_update;

ALTER TABLE public.email_threads ADD CONSTRAINT email_threads_project_source_check
  CHECK (project_source IN ('mapped', 'inferred', 'guessed', 'person', 'address'));
