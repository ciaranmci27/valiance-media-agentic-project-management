-- Initiatives: a named body of work inside a project, with a description,
-- an owner, a status and its own board and log, that people and agents both
-- use. A goal (pm.project_goals) is an outcome; an initiative is the work.
--
-- - pm.initiatives: one per body of work, in one project (fixed once made).
--   status planned | active | paused | done; health on_track | at_risk |
--   blocked while active (cleared otherwise). One owner at most: a member or
--   a group (a deactivated member or a group in Trash reads as no owner).
--   Dates are calendar dates. In Trash (deleted_at) it reads as missing;
--   rows are never removed. Written by the server only.
-- - pm.initiative_entries: the initiative's log, the dated record: kind
--   update | decision | issue | note, a title and body, an optional task in
--   the same project, and for an issue a status (open | resolved, with who
--   resolved it and when). project_id is copied from the initiative.
--   Written by the server only.
-- - pm.tasks.initiative_id: a task belongs to at most one initiative, in its
--   own project. Subtasks always take their parent's (those in Trash too);
--   moving a task to another project clears it, unless the move names an
--   initiative there. A task whose initiative is in Trash keeps the link and
--   reads as having none; restoring the initiative brings it back.
-- - pm.initiative_progress: done and total top-level tasks per initiative
--   (subtasks excluded), one grouped count. Server only.
-- - Context scope 'initiative': an initiative's brief is project_context
--   rows with scope_type 'initiative' and scope_id the initiative, read and
--   written through the server as every scope beyond projects.
-- - Who may: whoever can open the project reads its initiatives; entries
--   also need tasks.read (the right to comment on a task) and are never a
--   guest's. Creating and changing an initiative needs tasks.create in the
--   project; Trash needs projects.manage or being its creator. No new
--   permission.
-- - Team activity, Trash and restore, live sync, and webhooks
--   initiative.created, initiative.updated, initiative.deleted,
--   initiative_entry.created and initiative_entry.updated (opt in).
--   task.* payloads gain initiative_id.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the new tables; its task writes keep working (a project move clears
-- the new column on its own).

-- ---------------------------------------------------------------------------
-- Initiatives
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.initiatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES pm.projects(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_member_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  owner_group_id uuid REFERENCES pm.groups(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'planned',
  health text,
  start_date date,
  target_date date,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  -- The person the agent that made it acted for (X-Act-For); null otherwise.
  principal_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never removed.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL
);

ALTER TABLE pm.initiatives DROP CONSTRAINT IF EXISTS initiatives_name_length;
ALTER TABLE pm.initiatives
  ADD CONSTRAINT initiatives_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 120);
ALTER TABLE pm.initiatives DROP CONSTRAINT IF EXISTS initiatives_description_length;
ALTER TABLE pm.initiatives
  ADD CONSTRAINT initiatives_description_length CHECK (length(description) <= 5000);
ALTER TABLE pm.initiatives DROP CONSTRAINT IF EXISTS initiatives_status_check;
ALTER TABLE pm.initiatives
  ADD CONSTRAINT initiatives_status_check CHECK (status IN ('planned', 'active', 'paused', 'done'));
ALTER TABLE pm.initiatives DROP CONSTRAINT IF EXISTS initiatives_health_check;
ALTER TABLE pm.initiatives
  ADD CONSTRAINT initiatives_health_check CHECK (
    health IS NULL OR (status = 'active' AND health IN ('on_track', 'at_risk', 'blocked')));
ALTER TABLE pm.initiatives DROP CONSTRAINT IF EXISTS initiatives_one_owner;
ALTER TABLE pm.initiatives
  ADD CONSTRAINT initiatives_one_owner CHECK (num_nonnulls(owner_member_id, owner_group_id) <= 1);
ALTER TABLE pm.initiatives DROP CONSTRAINT IF EXISTS initiatives_dates_order;
ALTER TABLE pm.initiatives
  ADD CONSTRAINT initiatives_dates_order CHECK (start_date IS NULL OR target_date IS NULL OR target_date >= start_date);

COMMENT ON TABLE pm.initiatives IS
  'Initiatives: a named body of work inside a project, with its own board and log. A goal is an outcome; an initiative is the work. Written by the server only.';
COMMENT ON COLUMN pm.initiatives.description IS
  'What the initiative is for, in the owner''s words (the screens may label it Goal).';
COMMENT ON COLUMN pm.initiatives.health IS
  'on_track, at_risk or blocked while the initiative is active; null otherwise.';
COMMENT ON COLUMN pm.initiatives.principal_id IS
  'The person the agent that created it acted for (X-Act-For); null otherwise.';

-- A project's initiatives in order; Trash.
CREATE INDEX IF NOT EXISTS idx_initiatives_project ON pm.initiatives (project_id, sort_order, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_initiatives_deleted_at ON pm.initiatives (deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- The name is trimmed; the project, who made it and when never change; health
-- belongs to an active initiative only.
CREATE OR REPLACE FUNCTION pm.handle_initiative_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  IF TG_OP = 'UPDATE' THEN
    NEW.project_id := OLD.project_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  IF NEW.status <> 'active' THEN
    NEW.health := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_initiative_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS initiatives_before_write ON pm.initiatives;
CREATE TRIGGER initiatives_before_write
  BEFORE INSERT OR UPDATE ON pm.initiatives
  FOR EACH ROW EXECUTE FUNCTION pm.handle_initiative_before_write();

DROP TRIGGER IF EXISTS set_initiatives_updated_at ON pm.initiatives;
CREATE TRIGGER set_initiatives_updated_at
  BEFORE UPDATE ON pm.initiatives
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

DROP TRIGGER IF EXISTS stamp_principal ON pm.initiatives;
CREATE TRIGGER stamp_principal BEFORE INSERT OR UPDATE OF principal_id ON pm.initiatives
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_principal();

-- Never permanently deleted.
DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.initiatives;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.initiatives
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.initiatives;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.initiatives
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

ALTER TABLE pm.initiatives ENABLE ROW LEVEL SECURITY;

-- Whoever can open the project reads its initiatives (guests included).
DROP POLICY IF EXISTS initiatives_select ON pm.initiatives;
CREATE POLICY initiatives_select ON pm.initiatives FOR SELECT TO authenticated
  USING (pm.can_access_project(initiatives.project_id));

DROP POLICY IF EXISTS initiatives_not_deleted ON pm.initiatives;
CREATE POLICY initiatives_not_deleted ON pm.initiatives AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);

REVOKE ALL ON pm.initiatives FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.initiatives TO authenticated;
GRANT ALL ON pm.initiatives TO service_role;

-- ---------------------------------------------------------------------------
-- The log: dated entries on an initiative
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.initiative_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id uuid NOT NULL REFERENCES pm.initiatives(id),
  -- The initiative's project, copied on insert (row security reads it).
  project_id uuid NOT NULL REFERENCES pm.projects(id),
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  -- A task in the same project the entry is about.
  task_id uuid REFERENCES pm.tasks(id) ON DELETE SET NULL,
  -- Issues only: open or resolved.
  status text,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  principal_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL
);

ALTER TABLE pm.initiative_entries DROP CONSTRAINT IF EXISTS initiative_entries_kind_check;
ALTER TABLE pm.initiative_entries
  ADD CONSTRAINT initiative_entries_kind_check CHECK (kind IN ('update', 'decision', 'issue', 'note'));
ALTER TABLE pm.initiative_entries DROP CONSTRAINT IF EXISTS initiative_entries_status_check;
ALTER TABLE pm.initiative_entries
  ADD CONSTRAINT initiative_entries_status_check CHECK (
    CASE WHEN kind = 'issue' THEN status IN ('open', 'resolved') ELSE status IS NULL END);
ALTER TABLE pm.initiative_entries DROP CONSTRAINT IF EXISTS initiative_entries_title_length;
ALTER TABLE pm.initiative_entries
  ADD CONSTRAINT initiative_entries_title_length CHECK (length(btrim(title)) BETWEEN 1 AND 200);
ALTER TABLE pm.initiative_entries DROP CONSTRAINT IF EXISTS initiative_entries_body_length;
ALTER TABLE pm.initiative_entries
  ADD CONSTRAINT initiative_entries_body_length CHECK (length(body) <= 20000);

COMMENT ON TABLE pm.initiative_entries IS
  'An initiative''s log, the dated record: updates, decisions, issues (open or resolved) and notes. Standing knowledge belongs in its brief (project_context, scope initiative). Written by the server only.';
COMMENT ON COLUMN pm.initiative_entries.status IS
  'Issues only: open or resolved. Null for every other kind.';

-- An initiative's log, newest first; its open issues; Trash.
CREATE INDEX IF NOT EXISTS idx_initiative_entries_initiative ON pm.initiative_entries (initiative_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_initiative_entries_open_issues ON pm.initiative_entries (initiative_id, created_at DESC)
  WHERE deleted_at IS NULL AND kind = 'issue' AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_initiative_entries_deleted_at ON pm.initiative_entries (deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- The project comes from the initiative; the initiative, kind, author and
-- time never change; an issue starts open and its resolution is stamped; a
-- task must be in the same project.
CREATE OR REPLACE FUNCTION pm.handle_initiative_entry_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_task_project uuid;
BEGIN
  NEW.title := btrim(NEW.title);
  IF TG_OP = 'INSERT' THEN
    SELECT project_id INTO NEW.project_id FROM pm.initiatives WHERE id = NEW.initiative_id;
    IF NEW.kind = 'issue' THEN
      NEW.status := coalesce(NEW.status, 'open');
    ELSE
      NEW.status := NULL;
    END IF;
  ELSE
    NEW.initiative_id := OLD.initiative_id;
    NEW.project_id := OLD.project_id;
    NEW.kind := OLD.kind;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  IF NEW.kind <> 'issue' OR NEW.status = 'open' THEN
    NEW.resolved_at := NULL;
    NEW.resolved_by := NULL;
  ELSIF NEW.status = 'resolved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'resolved') THEN
    NEW.resolved_at := now();
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.resolved_at := OLD.resolved_at;
    NEW.resolved_by := OLD.resolved_by;
  END IF;
  IF NEW.task_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.task_id IS DISTINCT FROM OLD.task_id) THEN
    SELECT project_id INTO v_task_project FROM pm.tasks WHERE id = NEW.task_id AND deleted_at IS NULL;
    IF v_task_project IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'A log entry''s task must be a live task in the initiative''s project.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_initiative_entry_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS initiative_entries_before_write ON pm.initiative_entries;
CREATE TRIGGER initiative_entries_before_write
  BEFORE INSERT OR UPDATE ON pm.initiative_entries
  FOR EACH ROW EXECUTE FUNCTION pm.handle_initiative_entry_before_write();

DROP TRIGGER IF EXISTS set_initiative_entries_updated_at ON pm.initiative_entries;
CREATE TRIGGER set_initiative_entries_updated_at
  BEFORE UPDATE ON pm.initiative_entries
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

DROP TRIGGER IF EXISTS stamp_principal ON pm.initiative_entries;
CREATE TRIGGER stamp_principal BEFORE INSERT OR UPDATE OF principal_id ON pm.initiative_entries
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_principal();

DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.initiative_entries;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.initiative_entries
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.initiative_entries;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.initiative_entries
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

ALTER TABLE pm.initiative_entries ENABLE ROW LEVEL SECURITY;

-- Project members who may comment on its tasks read the log while the
-- initiative is live; never a guest.
DROP POLICY IF EXISTS initiative_entries_select ON pm.initiative_entries;
CREATE POLICY initiative_entries_select ON pm.initiative_entries FOR SELECT TO authenticated
  USING (
    pm.can_access_project(initiative_entries.project_id)
    AND pm.has_permission('tasks.read')
    AND coalesce(pm.current_team_member_role(), '') <> 'guest'
    AND EXISTS (
      SELECT 1 FROM pm.initiatives i
      WHERE i.id = initiative_entries.initiative_id AND i.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS initiative_entries_not_deleted ON pm.initiative_entries;
CREATE POLICY initiative_entries_not_deleted ON pm.initiative_entries AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);

REVOKE ALL ON pm.initiative_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.initiative_entries TO authenticated;
GRANT ALL ON pm.initiative_entries TO service_role;

-- ---------------------------------------------------------------------------
-- Tasks in an initiative
-- ---------------------------------------------------------------------------
ALTER TABLE pm.tasks ADD COLUMN IF NOT EXISTS initiative_id uuid REFERENCES pm.initiatives(id) ON DELETE SET NULL;

COMMENT ON COLUMN pm.tasks.initiative_id IS
  'The initiative the task belongs to, in its own project; a subtask always has its parent''s. Cleared when the task moves to another project.';

CREATE INDEX IF NOT EXISTS idx_tasks_initiative ON pm.tasks (initiative_id)
  WHERE initiative_id IS NOT NULL AND deleted_at IS NULL;

-- A subtask takes its parent's initiative. A move to another project clears
-- it unless the same write names an initiative there. A newly named
-- initiative must be live and in the task's project.
CREATE OR REPLACE FUNCTION pm.enforce_task_initiative()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_initiative pm.initiatives;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT initiative_id INTO NEW.initiative_id FROM pm.tasks WHERE id = NEW.parent_task_id;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id
     AND NEW.initiative_id IS NOT DISTINCT FROM OLD.initiative_id THEN
    NEW.initiative_id := NULL;
  END IF;
  IF NEW.initiative_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.initiative_id IS DISTINCT FROM OLD.initiative_id) THEN
    SELECT * INTO v_initiative FROM pm.initiatives WHERE id = NEW.initiative_id;
    IF v_initiative.id IS NULL OR v_initiative.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'That initiative is not there or is in Trash.' USING ERRCODE = '23514';
    END IF;
    IF v_initiative.project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'A task''s initiative must be in the task''s own project.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.enforce_task_initiative() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_task_initiative ON pm.tasks;
CREATE TRIGGER enforce_task_initiative
  BEFORE INSERT OR UPDATE OF initiative_id, parent_task_id, project_id ON pm.tasks
  FOR EACH ROW EXECUTE FUNCTION pm.enforce_task_initiative();

-- A parent's subtasks follow its initiative, those in Trash too (as they
-- follow it to another project), so a restore lands them beside it.
CREATE OR REPLACE FUNCTION pm.subtasks_follow_initiative()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  UPDATE pm.tasks
  SET initiative_id = NEW.initiative_id
  WHERE parent_task_id = NEW.id AND initiative_id IS DISTINCT FROM NEW.initiative_id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.subtasks_follow_initiative() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subtasks_follow_initiative ON pm.tasks;
CREATE TRIGGER subtasks_follow_initiative
  AFTER UPDATE ON pm.tasks
  FOR EACH ROW WHEN (NEW.initiative_id IS DISTINCT FROM OLD.initiative_id AND NEW.parent_task_id IS NULL)
  EXECUTE FUNCTION pm.subtasks_follow_initiative();

-- Done and total top-level tasks per initiative (subtasks excluded): one
-- grouped count for an overview. Server only: it counts every task, so the
-- server narrows it to what the reader may see.
CREATE OR REPLACE VIEW pm.initiative_progress WITH (security_invoker = true) AS
  SELECT
    initiative_id,
    count(*)::integer AS total,
    (count(*) FILTER (WHERE status = 'done'))::integer AS done
  FROM pm.tasks
  WHERE initiative_id IS NOT NULL AND parent_task_id IS NULL AND deleted_at IS NULL
  GROUP BY initiative_id;

REVOKE ALL ON pm.initiative_progress FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.initiative_progress TO service_role;

-- Open issues and the newest entry per initiative's log, for an overview in
-- one query. Server only.
CREATE OR REPLACE VIEW pm.initiative_log_stats WITH (security_invoker = true) AS
  SELECT
    initiative_id,
    (count(*) FILTER (WHERE kind = 'issue' AND status = 'open'))::integer AS open_issues,
    max(created_at) AS last_entry_at
  FROM pm.initiative_entries
  WHERE deleted_at IS NULL
  GROUP BY initiative_id;

REVOKE ALL ON pm.initiative_log_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.initiative_log_stats TO service_role;

-- ---------------------------------------------------------------------------
-- The brief: context scope 'initiative'
-- ---------------------------------------------------------------------------
ALTER TABLE pm.project_context DROP CONSTRAINT IF EXISTS project_context_scope_type_check;
ALTER TABLE pm.project_context
  ADD CONSTRAINT project_context_scope_type_check CHECK (scope_type IN ('workspace', 'group', 'project', 'agent', 'member', 'initiative'));

COMMENT ON COLUMN pm.project_context.scope_type IS
  'Where the entry belongs: workspace (every member), group (its members), project (as always), agent (that agent and who manages it), member (one person''s memory: them and their own agent only) or initiative (its brief, for whoever reads the project''s context).';

-- ---------------------------------------------------------------------------
-- Team activity
-- ---------------------------------------------------------------------------
ALTER TABLE pm.activities DROP CONSTRAINT IF EXISTS activities_entity_type_check;
ALTER TABLE pm.activities ADD CONSTRAINT activities_entity_type_check CHECK (entity_type IN (
  'task', 'subtask', 'comment', 'project', 'member', 'time_entry', 'invoice', 'payment', 'file',
  'portal_update', 'portal_update_attachment', 'credential', 'reminder', 'contact', 'lead',
  'lead_interaction', 'lead_proposal', 'lead_field', 'communication', 'hourly_rate', 'retainer',
  'retainer_amount', 'initiative', 'initiative_entry'
));

CREATE OR REPLACE FUNCTION pm.log_initiative_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('initiative_id', NEW.id, 'initiative_name', NEW.name);
  v_fields text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pm.log_team_activity('initiative.created', 'initiative', NEW.id::text, NEW.project_id,
      format('Created initiative "%s"', NEW.name), v_meta);
    RETURN NULL;
  END IF;
  -- The Trash trigger logs moves to Trash and restores.
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM pm.log_team_activity('initiative.status', 'initiative', NEW.id::text, NEW.project_id,
      format('Set initiative "%s" to %s', NEW.name, CASE NEW.status
        WHEN 'planned' THEN 'Planned' WHEN 'active' THEN 'Active' WHEN 'paused' THEN 'Paused' ELSE 'Done' END),
      v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  v_fields := pm.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD),
    ARRAY['status', 'sort_order', 'created_at', 'updated_at', 'deleted_at', 'deleted_by']);
  IF cardinality(v_fields) > 0 THEN
    PERFORM pm.log_team_activity('initiative.updated', 'initiative', NEW.id::text, NEW.project_id,
      format('Edited initiative "%s"', NEW.name), v_meta || jsonb_build_object('fields', to_jsonb(v_fields)));
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.log_initiative_activity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS log_initiative_activity ON pm.initiatives;
CREATE TRIGGER log_initiative_activity AFTER INSERT OR UPDATE ON pm.initiatives
  FOR EACH ROW EXECUTE FUNCTION pm.log_initiative_activity();

-- A log entry added, and an issue resolved or reopened.
CREATE OR REPLACE FUNCTION pm.log_initiative_entry_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_name text;
  v_meta jsonb;
BEGIN
  SELECT name INTO v_name FROM pm.initiatives WHERE id = NEW.initiative_id;
  v_meta := jsonb_build_object('initiative_id', NEW.initiative_id, 'initiative_name', v_name,
    'kind', NEW.kind, 'title', NEW.title, 'task_id', NEW.task_id);
  IF TG_OP = 'INSERT' THEN
    PERFORM pm.log_team_activity('initiative_entry.added', 'initiative_entry', NEW.id::text, NEW.project_id,
      format('Logged %s "%s" on "%s"', CASE NEW.kind
        WHEN 'update' THEN 'an update' WHEN 'decision' THEN 'a decision' WHEN 'issue' THEN 'an issue' ELSE 'a note' END,
        NEW.title, v_name), v_meta);
    RETURN NULL;
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM pm.log_team_activity(
      CASE WHEN NEW.status = 'resolved' THEN 'initiative_entry.resolved' ELSE 'initiative_entry.reopened' END,
      'initiative_entry', NEW.id::text, NEW.project_id,
      format('%s issue "%s" on "%s"', CASE WHEN NEW.status = 'resolved' THEN 'Resolved' ELSE 'Reopened' END, NEW.title, v_name),
      v_meta);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.log_initiative_entry_activity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS log_initiative_entry_activity ON pm.initiative_entries;
CREATE TRIGGER log_initiative_entry_activity AFTER INSERT OR UPDATE ON pm.initiative_entries
  FOR EACH ROW EXECUTE FUNCTION pm.log_initiative_entry_activity();

-- The log's activity reads like the log: never a guest's.
CREATE OR REPLACE FUNCTION pm.can_read_activity(
  p_entity_type text,
  p_entity_id text,
  p_project_id uuid,
  p_actor uuid,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT CASE
    WHEN p_project_id IS NOT NULL AND NOT pm.project_is_live(p_project_id) THEN false
    WHEN p_actor = pm.current_team_member_id() THEN true
    WHEN p_entity_type = 'reminder' AND p_project_id IS NULL THEN false
    WHEN pm.has_permission('audit.read') THEN true
    WHEN p_project_id IS NULL THEN CASE
      WHEN p_entity_type = 'contact' THEN pm.has_permission('contacts.read_all')
      WHEN p_metadata ? 'lead_id' THEN pm.can_access_lead((p_metadata ->> 'lead_id')::uuid)
      ELSE false
    END
    WHEN NOT (pm.has_permission('projects.read_all')
      OR (pm.has_permission('projects.read') AND pm.can_access_project(p_project_id))) THEN false
    ELSE CASE
      WHEN p_entity_type IN ('task', 'subtask', 'comment') THEN
        pm.has_permission('tasks.read')
        OR coalesce(pm.can_access_task((p_metadata ->> 'task_id')::uuid), false)
      WHEN p_entity_type = 'time_entry' THEN pm.has_permission('time.read_all')
      WHEN p_entity_type IN ('invoice', 'payment', 'hourly_rate', 'retainer', 'retainer_amount') THEN pm.has_permission('invoices.read')
      WHEN p_entity_type = 'credential' THEN pm.has_permission('credentials.manage')
      WHEN p_entity_type = 'file' THEN pm.has_permission('files.read')
      WHEN p_entity_type IN ('portal_update', 'portal_update_attachment') THEN pm.has_permission('portal.read')
      WHEN p_entity_type = 'communication' THEN pm.has_permission('communications.read')
      WHEN p_entity_type = 'contact' THEN pm.has_permission('contacts.read') OR pm.has_permission('contacts.read_all')
      WHEN p_entity_type = 'initiative_entry' THEN
        pm.has_permission('tasks.read') AND coalesce(pm.current_team_member_role(), '') <> 'guest'
      ELSE true
    END
  END
$$;

CREATE OR REPLACE FUNCTION pm.activity_entity_noun(p_entity_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_entity_type
    WHEN 'time_entry' THEN 'time entry'
    WHEN 'portal_update' THEN 'portal update'
    WHEN 'portal_update_attachment' THEN 'portal attachment'
    WHEN 'lead_interaction' THEN 'lead interaction'
    WHEN 'lead_proposal' THEN 'proposal'
    WHEN 'lead_field' THEN 'lead field'
    WHEN 'hourly_rate' THEN 'hourly rate'
    WHEN 'retainer_amount' THEN 'retainer amount'
    WHEN 'initiative_entry' THEN 'log entry'
    ELSE p_entity_type
  END
$$;

-- A subtask's initiative follows its parent: the parent's change already says so.
CREATE OR REPLACE FUNCTION pm.log_task_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_meta jsonb := jsonb_build_object('task_id', NEW.id, 'task_title', NEW.title);
  v_fields text[];
  v_ignore text[] := ARRAY['status', 'sort_order', 'completed_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by', 'parent_task_id',
    'claimed_by', 'claimed_at', 'claim_expires_at', 'claim_assigned', 'occurrences', 'last_occurred_at'];
  v_parent record;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT id, title INTO v_parent FROM pm.tasks WHERE id = NEW.parent_task_id;
    v_meta := v_meta || jsonb_build_object('parent_task_id', v_parent.id, 'parent_task_title', v_parent.title);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_task_id IS NOT NULL THEN
      PERFORM pm.log_team_activity('subtask.added', 'task', NEW.id::text, NEW.project_id,
        format('Added subtask "%s" to "%s"', NEW.title, v_parent.title), v_meta);
    ELSE
      PERFORM pm.log_team_activity('task.created', 'task', NEW.id::text, NEW.project_id,
        format('Created task "%s"', NEW.title), v_meta);
    END IF;
    RETURN NULL;
  END IF;
  -- The Trash trigger logs moves to Trash and restores.
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'done' THEN
      PERFORM pm.log_team_activity('task.completed', 'task', NEW.id::text, NEW.project_id,
        format('Completed task "%s"', NEW.title), v_meta);
    ELSIF OLD.status = 'done' THEN
      PERFORM pm.log_team_activity('task.reopened', 'task', NEW.id::text, NEW.project_id,
        format('Reopened task "%s"', NEW.title), v_meta);
    ELSE
      PERFORM pm.log_team_activity('task.moved', 'task', NEW.id::text, NEW.project_id,
        format('Moved task "%s" to %s', NEW.title, pm.activity_status_label(NEW.status)),
        v_meta || jsonb_build_object('from', OLD.status, 'to', NEW.status));
    END IF;
  END IF;

  IF NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id THEN
    IF NEW.parent_task_id IS NOT NULL THEN
      PERFORM pm.log_team_activity('task.nested', 'task', NEW.id::text, NEW.project_id,
        format('Moved "%s" under "%s"', NEW.title, v_parent.title), v_meta);
    ELSE
      PERFORM pm.log_team_activity('task.promoted', 'task', NEW.id::text, NEW.project_id,
        format('Made "%s" a top-level task', NEW.title), v_meta || jsonb_build_object('from_parent_task_id', OLD.parent_task_id));
    END IF;
  END IF;

  -- A subtask's project follows its parent: the parent's move (or the
  -- nesting above) already says so.
  IF NEW.parent_task_id IS NOT NULL THEN
    v_ignore := v_ignore || ARRAY['project_id', 'project_goal_id', 'initiative_id'];
  END IF;
  v_fields := pm.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD), v_ignore);
  IF cardinality(v_fields) > 0 THEN
    PERFORM pm.log_team_activity('task.updated', 'task', NEW.id::text, NEW.project_id,
      format('Edited task "%s"', NEW.title), v_meta || jsonb_build_object('fields', to_jsonb(v_fields)));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pm.record_task_row_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_ignore text[] := ARRAY['sort_order', 'completed_at', 'created_at', 'updated_at', 'deleted_at', 'deleted_by',
    'created_via', 'created_by_key_id', 'created_note',
    'claimed_by', 'claimed_at', 'claim_expires_at', 'claim_assigned', 'occurrences', 'last_occurred_at'];
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  -- A subtask moving with its parent is the parent's change, not its own.
  IF NEW.parent_task_id IS NOT NULL AND NEW.parent_task_id IS NOT DISTINCT FROM OLD.parent_task_id THEN
    v_ignore := v_ignore || ARRAY['project_id', 'project_goal_id', 'initiative_id'];
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM pm.record_task_event(NEW.id, 'status');
  ELSIF cardinality(pm.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD), v_ignore)) > 0 THEN
    PERFORM pm.record_task_event(NEW.id, 'edit');
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------
-- task.* payloads carry the task's initiative_id.
CREATE OR REPLACE FUNCTION pm.webhook_task_data(p_task pm.tasks)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT jsonb_build_object(
    'task', jsonb_build_object(
      'id', p_task.id,
      'project_id', p_task.project_id,
      'parent_task_id', p_task.parent_task_id,
      'initiative_id', p_task.initiative_id,
      'title', p_task.title,
      'description', p_task.description,
      'status', p_task.status,
      'priority', p_task.priority,
      'due_date', p_task.due_date,
      'tags', to_jsonb(p_task.tags),
      'ai_readiness', p_task.ai_readiness,
      'assignee_ids', coalesce((
        SELECT jsonb_agg(a.member_id ORDER BY a.member_id) FROM pm.task_assignees a WHERE a.task_id = p_task.id
      ), '[]'::jsonb),
      'claimed_by', CASE WHEN p_task.claim_expires_at IS NULL OR p_task.claim_expires_at > now() THEN p_task.claimed_by END,
      'claim_expires_at', CASE WHEN p_task.claimed_by IS NOT NULL AND p_task.claim_expires_at > now() THEN p_task.claim_expires_at END,
      'created_by', p_task.created_by,
      'created_via', p_task.created_via,
      'source_task_suggestion_id', p_task.source_task_suggestion_id,
      'completed_at', p_task.completed_at,
      'created_at', p_task.created_at,
      'updated_at', p_task.updated_at,
      'deleted_at', p_task.deleted_at
    ),
    'project', jsonb_build_object('id', p_task.project_id, 'name', coalesce((SELECT p.name FROM pm.projects p WHERE p.id = p_task.project_id), '')),
    'project_id', p_task.project_id,
    'task_id', p_task.id,
    'actor_id', pm.webhook_actor_id()
  )
$$;

-- An initiative as an event carries it: the row as it is now.
CREATE OR REPLACE FUNCTION pm.webhook_initiative_data(p_initiative pm.initiatives)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT jsonb_build_object(
    'initiative', jsonb_build_object(
      'id', p_initiative.id,
      'project_id', p_initiative.project_id,
      'name', p_initiative.name,
      'description', p_initiative.description,
      'owner_member_id', p_initiative.owner_member_id,
      'owner_group_id', p_initiative.owner_group_id,
      'status', p_initiative.status,
      'health', p_initiative.health,
      'start_date', p_initiative.start_date,
      'target_date', p_initiative.target_date,
      'created_by', p_initiative.created_by,
      'created_at', p_initiative.created_at,
      'updated_at', p_initiative.updated_at,
      'deleted_at', p_initiative.deleted_at
    ),
    'project', jsonb_build_object('id', p_initiative.project_id, 'name', coalesce((SELECT p.name FROM pm.projects p WHERE p.id = p_initiative.project_id), '')),
    'project_id', p_initiative.project_id,
    'initiative_id', p_initiative.id,
    'actor_id', pm.webhook_actor_id()
  )
$$;

REVOKE ALL ON FUNCTION pm.webhook_initiative_data(pm.initiatives) FROM PUBLIC, anon, authenticated;

-- Who an initiative's events concern: its owner (a member, or the members of
-- its owner group) and whoever made it.
CREATE OR REPLACE FUNCTION pm.initiative_webhook_members(p_initiative pm.initiatives, p_also uuid[] DEFAULT '{}')
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT coalesce(array_agg(DISTINCT m ORDER BY m) FILTER (WHERE m IS NOT NULL), '{}')
  FROM (
    SELECT p_initiative.owner_member_id AS m
    UNION ALL SELECT p_initiative.created_by
    UNION ALL SELECT gm.member_id FROM pm.group_members gm WHERE gm.group_id = p_initiative.owner_group_id
    UNION ALL SELECT unnest(coalesce(p_also, '{}'))
  ) members
$$;

REVOKE ALL ON FUNCTION pm.initiative_webhook_members(pm.initiatives, uuid[]) FROM PUBLIC, anon, authenticated;

-- initiative.created (made, or restored from Trash), initiative.updated with
-- the changed fields, initiative.deleted (moved to Trash). Reordering sends
-- nothing. One look at webhook_endpoints when nobody subscribes.
CREATE OR REPLACE FUNCTION pm.emit_initiative_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_type text;
  v_changes text[] := '{}';
  v_data jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['initiative.created', 'initiative.updated', 'initiative.deleted']
  ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    v_type := 'initiative.created';
  ELSIF NEW.deleted_at IS NOT NULL THEN
    IF OLD.deleted_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    v_type := 'initiative.deleted';
  ELSIF OLD.deleted_at IS NOT NULL THEN
    v_type := 'initiative.created';
  ELSE
    IF NEW.name IS DISTINCT FROM OLD.name THEN v_changes := v_changes || 'name'::text; END IF;
    IF NEW.description IS DISTINCT FROM OLD.description THEN v_changes := v_changes || 'description'::text; END IF;
    IF NEW.owner_member_id IS DISTINCT FROM OLD.owner_member_id THEN v_changes := v_changes || 'owner_member_id'::text; END IF;
    IF NEW.owner_group_id IS DISTINCT FROM OLD.owner_group_id THEN v_changes := v_changes || 'owner_group_id'::text; END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN v_changes := v_changes || 'status'::text; END IF;
    IF NEW.health IS DISTINCT FROM OLD.health THEN v_changes := v_changes || 'health'::text; END IF;
    IF NEW.start_date IS DISTINCT FROM OLD.start_date THEN v_changes := v_changes || 'start_date'::text; END IF;
    IF NEW.target_date IS DISTINCT FROM OLD.target_date THEN v_changes := v_changes || 'target_date'::text; END IF;
    IF cardinality(v_changes) = 0 THEN
      RETURN NULL;
    END IF;
    v_type := 'initiative.updated';
  END IF;

  v_data := pm.webhook_initiative_data(NEW);
  IF v_type = 'initiative.updated' THEN
    v_data := v_data || jsonb_build_object('changes', to_jsonb(v_changes));
  END IF;
  PERFORM pm.emit_webhook_event(
    v_type,
    'initiative',
    NEW.id,
    ARRAY[NEW.project_id],
    pm.initiative_webhook_members(NEW, CASE WHEN TG_OP = 'UPDATE' THEN ARRAY[OLD.owner_member_id] ELSE '{}'::uuid[] END),
    v_data,
    CASE WHEN v_type = 'initiative.updated' THEN ARRAY['initiative.updated', 'initiative.created'] END
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_initiative_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_initiative_webhook ON pm.initiatives;
CREATE TRIGGER emit_initiative_webhook
  AFTER INSERT OR UPDATE ON pm.initiatives
  FOR EACH ROW EXECUTE FUNCTION pm.emit_initiative_webhook();

-- initiative_entry.created when an entry is logged; initiative_entry.updated
-- (with the changed fields) when it is edited or an issue is resolved or
-- reopened. Concerns its author and the initiative's owner.
CREATE OR REPLACE FUNCTION pm.emit_initiative_entry_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_type text;
  v_changes text[] := '{}';
  v_initiative pm.initiatives;
  v_data jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['initiative_entry.created', 'initiative_entry.updated']
  ) THEN
    RETURN NULL;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_type := 'initiative_entry.created';
  ELSE
    IF OLD.deleted_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    IF NEW.title IS DISTINCT FROM OLD.title THEN v_changes := v_changes || 'title'::text; END IF;
    IF NEW.body IS DISTINCT FROM OLD.body THEN v_changes := v_changes || 'body'::text; END IF;
    IF NEW.task_id IS DISTINCT FROM OLD.task_id THEN v_changes := v_changes || 'task_id'::text; END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN v_changes := v_changes || 'status'::text; END IF;
    IF cardinality(v_changes) = 0 THEN
      RETURN NULL;
    END IF;
    v_type := 'initiative_entry.updated';
  END IF;

  SELECT * INTO v_initiative FROM pm.initiatives WHERE id = NEW.initiative_id;
  v_data := jsonb_build_object(
    'entry', jsonb_build_object(
      'id', NEW.id,
      'initiative_id', NEW.initiative_id,
      'project_id', NEW.project_id,
      'kind', NEW.kind,
      'title', NEW.title,
      'body', NEW.body,
      'task_id', NEW.task_id,
      'status', NEW.status,
      'resolved_at', NEW.resolved_at,
      'resolved_by', NEW.resolved_by,
      'created_by', NEW.created_by,
      'created_at', NEW.created_at,
      'updated_at', NEW.updated_at
    ),
    'initiative', jsonb_build_object('id', v_initiative.id, 'name', v_initiative.name),
    'project', jsonb_build_object('id', NEW.project_id, 'name', coalesce((SELECT p.name FROM pm.projects p WHERE p.id = NEW.project_id), '')),
    'project_id', NEW.project_id,
    'initiative_id', NEW.initiative_id,
    'actor_id', pm.webhook_actor_id()
  );
  IF v_type = 'initiative_entry.updated' THEN
    v_data := v_data || jsonb_build_object('changes', to_jsonb(v_changes));
  END IF;
  PERFORM pm.emit_webhook_event(
    v_type,
    'initiative_entry',
    NEW.id,
    ARRAY[NEW.project_id],
    (SELECT coalesce(array_agg(DISTINCT m ORDER BY m) FILTER (WHERE m IS NOT NULL), '{}')
       FROM unnest(ARRAY[NEW.created_by, NEW.resolved_by, v_initiative.owner_member_id]) AS m),
    v_data,
    CASE WHEN v_type = 'initiative_entry.updated' THEN ARRAY['initiative_entry.updated', 'initiative_entry.created'] END
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_initiative_entry_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_initiative_entry_webhook ON pm.initiative_entries;
CREATE TRIGGER emit_initiative_entry_webhook
  AFTER INSERT OR UPDATE ON pm.initiative_entries
  FOR EACH ROW EXECUTE FUNCTION pm.emit_initiative_entry_webhook();

-- ---------------------------------------------------------------------------
-- Live sync: open screens see initiatives and their logs change.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'initiatives') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.initiatives;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'initiative_entries') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.initiative_entries;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Trash: initiatives and log entries join Settings > Trash
-- ---------------------------------------------------------------------------
-- Moved to Trash through soft_delete_record, listed by list_trash, restored
-- by restore_record: whoever can open the project and manages projects, or
-- made it (an entry: its author, or whoever manages projects). An initiative
-- comes back only after its project, an entry only after its initiative.
-- Trash never touches tasks: they keep initiative_id and read as having
-- none until it is restored.
CREATE OR REPLACE FUNCTION pm.trash_record_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'projects', 'tasks', 'task_comments', 'reminders', 'project_credentials',
    'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads',
    'lead_interactions', 'lead_proposals', 'lead_fields',
    'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates',
    'project_retainers', 'project_retainer_amounts', 'task_files', 'task_templates',
    'initiatives', 'initiative_entries'
  ]
$$;

CREATE OR REPLACE FUNCTION pm.can_trash_record(p_table text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  me uuid := pm.current_team_member_id();
  allowed boolean := false;
BEGIN
  IF me IS NULL THEN
    RETURN false;
  END IF;
  CASE p_table
    WHEN 'projects' THEN
      SELECT pm.has_permission('projects.manage') AND (
        pm.has_permission('projects.read_all')
        OR EXISTS (SELECT 1 FROM pm.project_members WHERE project_id = p_id AND member_id = me)
      ) INTO allowed;
    WHEN 'tasks' THEN
      -- A subtask can also go by whoever manages its parent as an assignee.
      SELECT pm.can_access_project(project_id) AND (
        pm.has_permission('tasks.manage_all') OR (
          parent_task_id IS NOT NULL AND pm.has_permission('tasks.manage_assigned') AND EXISTS (
            SELECT 1 FROM pm.task_assignees assignment
            WHERE assignment.task_id = tasks.parent_task_id AND assignment.member_id = me
          )
        )
      ) INTO allowed FROM pm.tasks WHERE id = p_id;
    WHEN 'task_comments' THEN
      SELECT pm.can_access_task(task_id) AND (user_id = me OR pm.has_permission('tasks.manage_all'))
      INTO allowed FROM pm.task_comments WHERE id = p_id;
    WHEN 'task_files' THEN
      SELECT pm.can_access_task(task_id) AND (added_by = me OR pm.has_permission('files.manage'))
      INTO allowed FROM pm.task_files WHERE id = p_id;
    WHEN 'reminders' THEN
      SELECT pm.can_see_reminder(owner_id, project_id, task_id)
        AND (owner_id = me OR created_by = me OR pm.has_permission('tasks.manage_all'))
      INTO allowed FROM pm.reminders WHERE id = p_id;
    WHEN 'project_credentials' THEN
      SELECT pm.has_permission('credentials.manage') AND pm.can_access_project(project_id)
      INTO allowed FROM pm.project_credentials WHERE id = p_id;
    WHEN 'entity_files' THEN
      SELECT pm.can_access_file_entity(entity_type, entity_id) AND (
        pm.has_permission('files.manage') OR (uploaded_by = me AND visibility = 'internal')
      ) INTO allowed FROM pm.entity_files WHERE id = p_id;
    WHEN 'portal_updates' THEN
      SELECT pm.has_permission('portal.manage') AND pm.can_access_project(project_id)
      INTO allowed FROM pm.portal_updates WHERE id = p_id;
    WHEN 'portal_update_attachments' THEN
      SELECT pm.has_permission('portal.manage') AND pm.can_access_project(update_row.project_id)
      INTO allowed
      FROM pm.portal_update_attachments attachment
      JOIN pm.portal_updates update_row ON update_row.id = attachment.update_id
      WHERE attachment.id = p_id AND update_row.deleted_at IS NULL;
    WHEN 'contacts' THEN
      SELECT pm.has_permission('contacts.manage') INTO allowed;
    WHEN 'leads' THEN
      SELECT pm.has_permission('leads.manage') INTO allowed;
    WHEN 'lead_interactions' THEN
      SELECT pm.has_permission('leads.manage') AND pm.can_access_lead(lead_id)
      INTO allowed FROM pm.lead_interactions WHERE id = p_id;
    WHEN 'lead_proposals' THEN
      SELECT pm.has_permission('leads.manage') AND pm.can_access_lead(lead_id)
      INTO allowed FROM pm.lead_proposals WHERE id = p_id;
    WHEN 'lead_fields' THEN
      SELECT pm.has_permission('leads.manage') AND pm.can_access_lead(lead_id)
      INTO allowed FROM pm.lead_fields WHERE id = p_id;
    WHEN 'project_time_entries' THEN
      SELECT pm.can_access_project(project_id) AND (
        pm.has_permission('time.manage_all') OR (
          pm.has_permission('time.manage_own')
          AND member_id = me
          AND approval_status IN ('draft', 'pending', 'rejected')
        )
      ) INTO allowed FROM pm.project_time_entries WHERE id = p_id;
    WHEN 'project_invoices' THEN
      SELECT pm.has_permission('invoices.manage') AND pm.can_access_project(project_id)
      INTO allowed FROM pm.project_invoices WHERE id = p_id;
    WHEN 'invoice_payments' THEN
      -- People remove only payments recorded by hand, as remove_invoice_payment.
      SELECT (pm.has_permission('invoices.record_payments') OR pm.has_permission('invoices.manage'))
        AND pm.can_access_project(invoice.project_id)
        AND invoice.deleted_at IS NULL
        AND payment.recorded_via = 'app'
      INTO allowed
      FROM pm.invoice_payments payment
      JOIN pm.project_invoices invoice ON invoice.id = payment.invoice_id
      WHERE payment.id = p_id;
    WHEN 'project_hourly_rates' THEN
      SELECT pm.has_permission('billing.manage') AND pm.can_access_project(project_id)
      INTO allowed FROM pm.project_hourly_rates WHERE id = p_id;
    WHEN 'project_retainers' THEN
      SELECT pm.has_permission('invoices.manage') AND pm.can_access_project(project_id)
      INTO allowed FROM pm.project_retainers WHERE id = p_id;
    WHEN 'project_retainer_amounts' THEN
      SELECT pm.has_permission('invoices.manage') AND pm.can_access_project(retainer.project_id)
        AND retainer.deleted_at IS NULL
      INTO allowed
      FROM pm.project_retainer_amounts amount
      JOIN pm.project_retainers retainer ON retainer.id = amount.retainer_id
      WHERE amount.id = p_id;
    WHEN 'task_templates' THEN
      -- The library is managed with templates.manage; a locked template also needs its project.
      SELECT pm.has_permission('templates.manage')
        AND (task_templates.project_id IS NULL OR pm.can_access_project(task_templates.project_id))
      INTO allowed FROM pm.task_templates WHERE id = p_id;
    WHEN 'initiatives' THEN
      -- Whoever manages projects, or whoever made it, on a project they can open.
      SELECT pm.can_access_project(project_id) AND (pm.has_permission('projects.manage') OR created_by = me)
      INTO allowed FROM pm.initiatives WHERE id = p_id;
    WHEN 'initiative_entries' THEN
      -- Its author, or whoever manages projects, while they may read the log.
      SELECT pm.can_access_project(project_id) AND pm.has_permission('tasks.read')
        AND coalesce(pm.current_team_member_role(), '') <> 'guest'
        AND (created_by = me OR pm.has_permission('projects.manage'))
      INTO allowed FROM pm.initiative_entries WHERE id = p_id;
    ELSE
      allowed := false;
  END CASE;
  RETURN coalesce(allowed, false);
END;
$$;

CREATE OR REPLACE FUNCTION pm.trash_restore_blocker(p_table text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  project_gone boolean := false;
  task_gone boolean := false;
  lead_gone boolean := false;
  parent_gone boolean := false;
  payment pm.invoice_payments;
  invoice pm.project_invoices;
  v_number text;
BEGIN
  CASE p_table
    WHEN 'tasks' THEN
      -- A subtask comes back after its parent.
      SELECT p.deleted_at IS NOT NULL, coalesce(parent.deleted_at IS NOT NULL, false) INTO project_gone, task_gone
      FROM pm.tasks t JOIN pm.projects p ON p.id = t.project_id
      LEFT JOIN pm.tasks parent ON parent.id = t.parent_task_id
      WHERE t.id = p_id;
    WHEN 'task_comments', 'task_files' THEN
      EXECUTE format('SELECT t.deleted_at IS NOT NULL OR coalesce(parent.deleted_at IS NOT NULL, false), p.deleted_at IS NOT NULL
        FROM pm.%I c JOIN pm.tasks t ON t.id = c.task_id JOIN pm.projects p ON p.id = t.project_id
        LEFT JOIN pm.tasks parent ON parent.id = t.parent_task_id
        WHERE c.id = $1', p_table)
      INTO task_gone, project_gone USING p_id;
    WHEN 'reminders' THEN
      SELECT coalesce(t.deleted_at IS NOT NULL OR parent.deleted_at IS NOT NULL, false), coalesce(p.deleted_at IS NOT NULL, false)
      INTO task_gone, project_gone
      FROM pm.reminders r
      LEFT JOIN pm.tasks t ON t.id = r.task_id
      LEFT JOIN pm.tasks parent ON parent.id = t.parent_task_id
      LEFT JOIN pm.projects p ON p.id = r.project_id
      WHERE r.id = p_id;
    WHEN 'project_credentials', 'portal_updates', 'project_time_entries', 'project_invoices',
         'project_hourly_rates', 'project_retainers', 'task_templates', 'initiatives' THEN
      EXECUTE format('SELECT p.deleted_at IS NOT NULL FROM pm.%I c
        JOIN pm.projects p ON p.id = c.project_id WHERE c.id = $1', p_table)
      INTO project_gone USING p_id;
    WHEN 'portal_update_attachments' THEN
      SELECT u.deleted_at IS NOT NULL INTO parent_gone
      FROM pm.portal_update_attachments a JOIN pm.portal_updates u ON u.id = a.update_id WHERE a.id = p_id;
      IF parent_gone THEN
        RETURN 'Restore the portal update it belongs to first.';
      END IF;
    WHEN 'invoice_payments' THEN
      SELECT p.deleted_at IS NOT NULL, i.deleted_at IS NOT NULL INTO project_gone, parent_gone
      FROM pm.invoice_payments pay
      JOIN pm.project_invoices i ON i.id = pay.invoice_id
      JOIN pm.projects p ON p.id = i.project_id
      WHERE pay.id = p_id;
      IF parent_gone AND NOT project_gone THEN
        RETURN 'Restore the invoice it belongs to first.';
      END IF;
    WHEN 'project_retainer_amounts' THEN
      SELECT p.deleted_at IS NOT NULL, r.deleted_at IS NOT NULL INTO project_gone, parent_gone
      FROM pm.project_retainer_amounts a
      JOIN pm.project_retainers r ON r.id = a.retainer_id
      JOIN pm.projects p ON p.id = r.project_id
      WHERE a.id = p_id;
      IF parent_gone AND NOT project_gone THEN
        RETURN 'Restore the retainer it belongs to first.';
      END IF;
    WHEN 'initiative_entries' THEN
      SELECT p.deleted_at IS NOT NULL, i.deleted_at IS NOT NULL INTO project_gone, parent_gone
      FROM pm.initiative_entries e
      JOIN pm.initiatives i ON i.id = e.initiative_id
      JOIN pm.projects p ON p.id = e.project_id
      WHERE e.id = p_id;
      IF parent_gone AND NOT project_gone THEN
        RETURN 'Restore the initiative it belongs to first.';
      END IF;
    WHEN 'entity_files' THEN
      SELECT CASE f.entity_type
          WHEN 'project' THEN EXISTS (SELECT 1 FROM pm.projects WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          WHEN 'lead' THEN EXISTS (SELECT 1 FROM pm.leads WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          WHEN 'contact' THEN EXISTS (SELECT 1 FROM pm.contacts WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          ELSE false
        END
      INTO parent_gone
      FROM pm.entity_files f WHERE f.id = p_id;
      IF parent_gone THEN
        RETURN 'Restore the project, lead or contact this file belongs to first.';
      END IF;
    WHEN 'lead_interactions', 'lead_proposals', 'lead_fields' THEN
      EXECUTE format('SELECT l.deleted_at IS NOT NULL FROM pm.%I c
        JOIN pm.leads l ON l.id = c.lead_id WHERE c.id = $1', p_table)
      INTO lead_gone USING p_id;
    ELSE
      NULL;
  END CASE;
  IF coalesce(project_gone, false) THEN
    RETURN 'Restore the project it belongs to first.';
  ELSIF coalesce(task_gone, false) THEN
    RETURN 'Restore the task it belongs to first.';
  ELSIF coalesce(lead_gone, false) THEN
    RETURN 'Restore the lead it belongs to first.';
  END IF;

  -- Clashes with what was added while it was in Trash.
  CASE p_table
    WHEN 'project_time_entries' THEN
      IF EXISTS (
        SELECT 1 FROM pm.project_time_entries entry
        JOIN pm.project_time_entries other
          ON other.project_id = entry.project_id AND other.member_id = entry.member_id AND other.id <> entry.id
        WHERE entry.id = p_id AND entry.end_time IS NULL
          AND other.end_time IS NULL AND other.deleted_at IS NULL
      ) THEN
        RETURN 'This timer is still running and a newer one is running on the same project. Stop that one first.';
      END IF;
    WHEN 'project_invoices' THEN
      SELECT * INTO invoice FROM pm.project_invoices WHERE id = p_id;
      IF invoice.status <> 'cancelled' THEN
        SELECT other.invoice_number INTO v_number
        FROM pm.invoice_time_entry_allocations mine
        JOIN pm.invoice_time_entry_allocations theirs
          ON theirs.time_entry_id = mine.time_entry_id AND theirs.invoice_id <> mine.invoice_id
        JOIN pm.project_invoices other ON other.id = theirs.invoice_id
        WHERE mine.invoice_id = p_id AND other.status <> 'cancelled' AND other.deleted_at IS NULL
          AND mine.start_offset_hours < theirs.start_offset_hours + theirs.allocated_hours - 0.000001
          AND theirs.start_offset_hours < mine.start_offset_hours + mine.allocated_hours - 0.000001
        LIMIT 1;
        IF FOUND THEN
          RETURN 'Some of its hours are on invoice ' || v_number || ' now. Take them off that invoice first.';
        END IF;
        IF EXISTS (
          SELECT 1 FROM pm.invoice_time_entry_allocations allocation
          JOIN pm.project_time_entries entry ON entry.id = allocation.time_entry_id
          WHERE allocation.invoice_id = p_id AND entry.deleted_at IS NOT NULL
        ) THEN
          RETURN 'Some of its time is in Trash. Restore that time first.';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
          JOIN pm.project_retainers retainer ON retainer.id::text = line.value->>'retainer_id' AND retainer.deleted_at IS NULL
          JOIN pm.project_retainer_periods handled
            ON handled.retainer_id = retainer.id
           AND handled.period_start = GREATEST(date_trunc('month', (line.value->>'service_start_date')::date)::date, retainer.start_date)
          WHERE COALESCE(line.value->>'service_start_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
            AND handled.status = 'invoiced' AND handled.invoice_id IS NOT NULL AND handled.invoice_id <> p_id
        ) THEN
          RETURN 'Its retainer period is on another invoice now.';
        END IF;
      END IF;
      -- Paid hours that are not linked to time entries cannot be checked
      -- against what was billed since; counting them again would under-bill.
      IF invoice.status = 'paid'
         AND (
           (jsonb_array_length(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) = 0 AND invoice.invoice_type = 'hourly'
            AND NOT EXISTS (SELECT 1 FROM pm.invoice_time_entry_allocations a WHERE a.invoice_id = p_id))
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
             WHERE line.value->>'item_type' = 'hourly'
               AND NOT EXISTS (SELECT 1 FROM pm.invoice_time_entry_allocations a
                               WHERE a.invoice_id = p_id AND a.line_item_id = line.value->>'id')
           )
         )
         AND EXISTS (
           SELECT 1 FROM pm.project_invoices other
           WHERE other.project_id = invoice.project_id AND other.id <> p_id AND other.deleted_at IS NULL
             AND other.status <> 'cancelled' AND other.created_at > invoice.deleted_at
             AND (other.invoice_type = 'hourly' OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(other.line_items, 'null'::jsonb), '[]'::jsonb)) line
               WHERE line.value->>'item_type' = 'hourly'))
         ) THEN
        RETURN 'Hours were invoiced after this invoice went to Trash, and its own hours are not linked to time entries, so restoring it could count hours twice. Check the hourly invoices first.';
      END IF;
    WHEN 'project_hourly_rates' THEN
      IF EXISTS (
        SELECT 1 FROM pm.project_hourly_rates rate
        JOIN pm.project_hourly_rates other
          ON other.project_id = rate.project_id AND other.effective_at = rate.effective_at AND other.id <> rate.id
        WHERE rate.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'Another rate now starts at the same time. Change or delete that one first.';
      END IF;
    WHEN 'lead_fields' THEN
      IF EXISTS (
        SELECT 1 FROM pm.lead_fields field
        JOIN pm.lead_fields other
          ON other.lead_id = field.lead_id AND other.field_key = field.field_key AND other.id <> field.id
        WHERE field.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'This field has been set again since. Change or delete that one first.';
      END IF;
    WHEN 'project_retainer_amounts' THEN
      IF EXISTS (
        SELECT 1 FROM pm.project_retainer_amounts amount
        JOIN pm.project_retainer_amounts other
          ON other.retainer_id = amount.retainer_id AND other.effective_date = amount.effective_date AND other.id <> amount.id
        WHERE amount.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'Another amount now starts on the same date. Change or delete that one first.';
      END IF;
    WHEN 'invoice_payments' THEN
      SELECT * INTO payment FROM pm.invoice_payments WHERE id = p_id;
      SELECT * INTO invoice FROM pm.project_invoices WHERE id = payment.invoice_id;
      IF invoice.status NOT IN ('sent', 'overdue', 'paid') THEN
        RETURN 'Its invoice is ' || invoice.status || ' now, so it cannot take a payment.';
      END IF;
      IF payment.amount > pm.invoice_total(invoice) - COALESCE((
        SELECT sum(other.amount) FROM pm.invoice_payments other
        WHERE other.invoice_id = invoice.id AND other.deleted_at IS NULL
      ), 0) + 0.005 THEN
        RETURN 'Its invoice no longer has enough outstanding for this payment.';
      END IF;
      IF payment.external_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM pm.invoice_payments other
        WHERE other.invoice_id = payment.invoice_id AND other.external_id = payment.external_id
          AND other.deleted_at IS NULL AND other.id <> payment.id
      ) THEN
        RETURN 'This payment was recorded again after it was removed.';
      END IF;
    ELSE
      NULL;
  END CASE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pm.trash_entity_type(p_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'projects' THEN 'project'
    WHEN 'tasks' THEN 'task'
    WHEN 'task_subtasks' THEN 'subtask'
    WHEN 'task_comments' THEN 'comment'
    WHEN 'task_files' THEN 'task_file'
    WHEN 'reminders' THEN 'reminder'
    WHEN 'project_credentials' THEN 'credential'
    WHEN 'entity_files' THEN 'entity_file'
    WHEN 'portal_updates' THEN 'portal_update'
    WHEN 'portal_update_attachments' THEN 'portal_update_attachment'
    WHEN 'contacts' THEN 'contact'
    WHEN 'leads' THEN 'lead'
    WHEN 'lead_interactions' THEN 'lead_interaction'
    WHEN 'lead_proposals' THEN 'lead_proposal'
    WHEN 'lead_fields' THEN 'lead_field'
    WHEN 'project_time_entries' THEN 'time_entry'
    WHEN 'project_invoices' THEN 'invoice'
    WHEN 'invoice_payments' THEN 'invoice_payment'
    WHEN 'project_hourly_rates' THEN 'project_hourly_rate'
    WHEN 'project_retainers' THEN 'retainer'
    WHEN 'project_retainer_amounts' THEN 'retainer_amount'
    WHEN 'task_templates' THEN 'task_template'
    WHEN 'initiatives' THEN 'initiative'
    WHEN 'initiative_entries' THEN 'initiative_entry'
    ELSE p_table
  END
$$;

CREATE OR REPLACE FUNCTION pm.list_trash(p_types text[] DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS TABLE (
  record_type text,
  id uuid,
  label text,
  context text,
  project_id uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_name text,
  blocker text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  spec record;
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
BEGIN
  IF NOT is_service AND pm.current_team_member_id() IS NULL THEN
    RETURN;
  END IF;
  FOR spec IN
    SELECT * FROM (VALUES
      ('projects', 'r.name', 'NULL', 'r.id', ''),
      ('tasks', 'r.title', 'CASE WHEN parent.id IS NULL THEN p.name ELSE ''Subtask of '' || parent.title END', 'r.project_id',
        'LEFT JOIN pm.projects p ON p.id = r.project_id LEFT JOIN pm.tasks parent ON parent.id = r.parent_task_id'),
      ('task_comments', 'left(r.text, 120)', 't.title', 't.project_id', 'LEFT JOIN pm.tasks t ON t.id = r.task_id'),
      ('task_files', 'r.name', 't.title', 't.project_id', 'LEFT JOIN pm.tasks t ON t.id = r.task_id'),
      ('task_templates', 'r.name', 'coalesce(p.name, ''Task templates'')', 'r.project_id', 'LEFT JOIN pm.projects p ON p.id = r.project_id'),
      ('initiatives', 'r.name', 'p.name', 'r.project_id', 'LEFT JOIN pm.projects p ON p.id = r.project_id'),
      ('initiative_entries', 'r.title', 'i.name', 'r.project_id', 'LEFT JOIN pm.initiatives i ON i.id = r.initiative_id'),
      ('reminders', 'r.title', 'coalesce(t.title, p.name)', 'r.project_id',
        'LEFT JOIN pm.tasks t ON t.id = r.task_id LEFT JOIN pm.projects p ON p.id = r.project_id'),
      ('project_credentials', 'r.label', 'p.name', 'r.project_id', 'LEFT JOIN pm.projects p ON p.id = r.project_id'),
      ('entity_files', 'r.name',
        'CASE r.entity_type WHEN ''project'' THEN (SELECT name FROM pm.projects WHERE id = r.entity_id)
           WHEN ''lead'' THEN (SELECT name FROM pm.leads WHERE id = r.entity_id)
           WHEN ''contact'' THEN (SELECT name FROM pm.contacts WHERE id = r.entity_id) END',
        'CASE WHEN r.entity_type = ''project'' THEN r.entity_id END', ''),
      ('portal_updates', 'r.title', 'p.name', 'r.project_id', 'LEFT JOIN pm.projects p ON p.id = r.project_id'),
      ('portal_update_attachments', 'r.name', 'u.title', 'u.project_id', 'LEFT JOIN pm.portal_updates u ON u.id = r.update_id'),
      ('contacts', 'r.name', 'NULL', 'NULL', ''),
      ('leads', 'r.name', 'NULL', 'NULL', ''),
      ('lead_interactions', 'r.title', 'l.name', 'NULL', 'LEFT JOIN pm.leads l ON l.id = r.lead_id'),
      ('lead_proposals', 'r.title', 'l.name', 'NULL', 'LEFT JOIN pm.leads l ON l.id = r.lead_id'),
      ('lead_fields', 'r.field_key || '': '' || left(r.value, 80)', 'l.name', 'NULL', 'LEFT JOIN pm.leads l ON l.id = r.lead_id'),
      ('project_time_entries',
        'coalesce(nullif(btrim(r.description), ''''), ''Time entry'') || '' ('' || to_char(r.start_time AT TIME ZONE pm.workspace_timezone(), ''Mon FMDD, YYYY'') || '')''',
        'p.name', 'r.project_id', 'LEFT JOIN pm.projects p ON p.id = r.project_id'),
      ('project_invoices', 'r.invoice_number || '' ('' || pm.format_money(r.amount, r.currency, true) || '')''', 'p.name', 'r.project_id',
        'LEFT JOIN pm.projects p ON p.id = r.project_id'),
      ('invoice_payments', '''Payment of '' || pm.format_money(r.amount, i.currency, true) || '' on '' || i.invoice_number', 'p.name', 'i.project_id',
        'LEFT JOIN pm.project_invoices i ON i.id = r.invoice_id LEFT JOIN pm.projects p ON p.id = i.project_id'),
      ('project_hourly_rates', 'pm.format_money(r.hourly_rate, NULL, true) || ''/hr from '' || to_char(r.effective_at AT TIME ZONE pm.workspace_timezone(), ''Mon FMDD, YYYY'')',
        'p.name', 'r.project_id', 'LEFT JOIN pm.projects p ON p.id = r.project_id'),
      ('project_retainers', 'r.name', 'p.name', 'r.project_id', 'LEFT JOIN pm.projects p ON p.id = r.project_id'),
      ('project_retainer_amounts', 'rt.name || '': '' || pm.format_money(r.amount, rt.currency, true) || '' from '' || to_char(r.effective_date, ''Mon FMDD, YYYY'')',
        'p.name', 'rt.project_id',
        'LEFT JOIN pm.project_retainers rt ON rt.id = r.retainer_id LEFT JOIN pm.projects p ON p.id = rt.project_id')
    ) AS specs(record_type, label_sql, context_sql, project_sql, join_sql)
  LOOP
    CONTINUE WHEN p_types IS NOT NULL AND NOT spec.record_type = ANY (p_types);
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, r.id, (%s)::text, (%s)::text, (%s)::uuid, r.deleted_at, r.deleted_by, m.name::text,
              pm.trash_restore_blocker(%L, r.id)
       FROM pm.%I r %s
       LEFT JOIN pm.team_members m ON m.id = r.deleted_by
       WHERE r.deleted_at IS NOT NULL AND ($1 OR pm.can_trash_record(%L, r.id))
       ORDER BY r.deleted_at DESC
       LIMIT %s',
      spec.record_type, spec.label_sql, spec.context_sql, spec.project_sql, spec.record_type,
      spec.record_type, spec.join_sql, spec.record_type, greatest(1, least(coalesce(p_limit, 500), 2000)))
    USING is_service;
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS record_trash_event ON pm.initiatives;
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON pm.initiatives
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION pm.record_trash_event();
DROP TRIGGER IF EXISTS record_trash_event ON pm.initiative_entries;
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON pm.initiative_entries
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION pm.record_trash_event();
DROP TRIGGER IF EXISTS log_trash_activity ON pm.initiatives;
CREATE TRIGGER log_trash_activity AFTER UPDATE OF deleted_at ON pm.initiatives
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION pm.log_trash_activity();
DROP TRIGGER IF EXISTS log_trash_activity ON pm.initiative_entries;
CREATE TRIGGER log_trash_activity AFTER UPDATE OF deleted_at ON pm.initiative_entries
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION pm.log_trash_activity();
