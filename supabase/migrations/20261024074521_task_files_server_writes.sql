-- Task files are written only by the server. The server checks what the
-- database cannot: that a linked email attachment comes from an inbox the
-- person can read, that a project file belongs to the task's project, and
-- that an upload's path is the hash of its bytes in the task's project. A
-- row written straight from the browser could skip all three and point a
-- task at someone else's file, so signed-in members read task files and
-- nothing else. Trash and restore go through soft_delete_record and
-- restore_record as before (they check can_trash_record themselves).

DROP POLICY IF EXISTS task_files_insert ON public.task_files;
DROP POLICY IF EXISTS task_files_update ON public.task_files;

REVOKE ALL ON public.task_files FROM anon, authenticated;
GRANT SELECT ON public.task_files TO authenticated;
GRANT ALL ON public.task_files TO service_role;
