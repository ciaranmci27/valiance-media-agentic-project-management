-- Backlog: a task status before To Do for ideas and someday work. To Do means
-- committed; backlog means kept but not promised. Only the allowed values
-- change: nothing else in the database treats a status other than done
-- specially, and activity_status_label already renders it as "Backlog".
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done'));
