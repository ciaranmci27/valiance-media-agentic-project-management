-- A task can hold links beside its files: a Loom, a Claude artifact, a Figma
-- file, a shared doc. A link is a fourth kind of task file, so it has the
-- note, Trash, live sync and activity log every file has. Nothing is stored
-- but the address, and nothing fetches it. The server cleans the address
-- before it gets here (task-files/service.ts): out of redirect wrappers,
-- without tracking tags.

ALTER TABLE public.task_files ADD COLUMN IF NOT EXISTS url text;

ALTER TABLE public.task_files DROP CONSTRAINT IF EXISTS task_files_url_check;
ALTER TABLE public.task_files ADD CONSTRAINT task_files_url_check
  CHECK (url IS NULL OR (url ~ '^https?://' AND length(url) <= 2048));

ALTER TABLE public.task_files DROP CONSTRAINT IF EXISTS task_files_kind_check;
ALTER TABLE public.task_files ADD CONSTRAINT task_files_kind_check
  CHECK (kind IN ('upload', 'email_attachment', 'project_file', 'link'));

ALTER TABLE public.task_files DROP CONSTRAINT IF EXISTS task_files_one_source;
ALTER TABLE public.task_files ADD CONSTRAINT task_files_one_source CHECK (
  (kind = 'upload' AND storage_path IS NOT NULL AND sha256 IS NOT NULL AND email_attachment_id IS NULL AND entity_file_id IS NULL AND url IS NULL)
  OR (kind = 'email_attachment' AND email_attachment_id IS NOT NULL AND storage_path IS NULL AND sha256 IS NULL AND entity_file_id IS NULL AND url IS NULL)
  OR (kind = 'project_file' AND entity_file_id IS NOT NULL AND storage_path IS NULL AND sha256 IS NULL AND email_attachment_id IS NULL AND url IS NULL)
  OR (kind = 'link' AND url IS NOT NULL AND storage_path IS NULL AND sha256 IS NULL AND email_attachment_id IS NULL AND entity_file_id IS NULL)
);

-- One live entry per address per task, as for every other kind.
CREATE UNIQUE INDEX IF NOT EXISTS task_files_live_link ON public.task_files (task_id, url) WHERE kind = 'link' AND deleted_at IS NULL;

-- The team log says a link was added, not attached.
CREATE OR REPLACE FUNCTION public.log_task_file_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title text;
  v_project_id uuid;
BEGIN
  SELECT title, project_id INTO v_title, v_project_id FROM public.tasks WHERE id = NEW.task_id;
  PERFORM public.log_team_activity(
    CASE WHEN NEW.kind = 'upload' THEN 'file.uploaded' ELSE 'file.attached' END,
    'file', NEW.id::text, v_project_id,
    format(CASE NEW.kind
      WHEN 'upload' THEN 'Uploaded "%s" to task "%s"'
      WHEN 'link' THEN 'Added link "%s" to task "%s"'
      ELSE 'Attached "%s" to task "%s"'
    END, NEW.name, v_title),
    jsonb_build_object('file_name', NEW.name, 'kind', NEW.kind, 'task_id', NEW.task_id, 'task_title', v_title));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.log_task_file_activity() FROM PUBLIC, anon, authenticated;
