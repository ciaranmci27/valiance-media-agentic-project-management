-- Task templates: one task or a playbook of tasks, set up once and used again
-- and again, by hand, over the API and MCP. Schedules come later and point at
-- a template; every use is recorded as a run.
--
-- - pm.task_templates: the workspace's library. A template holds an ordered
--   list of tasks (items), each with optional subtasks one level deep, and
--   the fill-in fields its titles and descriptions use ({product}). A
--   template locked to a project (project_id) shows only there and always
--   creates there. version goes up by one whenever what it makes changes
--   (name, description, project, fields, items), so a run can say which
--   version it used. There are no personal templates: the creator is
--   recorded, and editing follows templates.manage. In Trash (deleted_at)
--   it reads as missing; rows are never removed. Written by the server only.
-- - pm.task_template_runs: one row per use: the template, its version and
--   a snapshot of what it held, who ran it (run_by) and how (via app, api,
--   mcp or schedule), the project, the start date, the fill-in values and
--   the ids of every task it made (subtasks included). schedule_id is left
--   for the schedules that come later, which add their own table and point
--   here, so they can skip a run while the last run's tasks are still open.
--   Rows are never changed or removed. Written by the server only.
-- - pm.task_template_run_stats: how many runs each template has and when the
--   last one was, so the library reads in one query.
-- - New permission templates.manage (core, no module): create, edit and
--   Trash templates. Owners hold every permission; Admins hold it by default
--   on the app and the API. Using a template needs what creating tasks in
--   its project needs.
-- - Webhooks: template.run when a template is used, concerning who ran it
--   and everyone its tasks were assigned to. Each task it makes still sends
--   its own task.created.
-- - Live sync: open screens see the library and its runs change.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the new tables or the new permission.

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.task_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Locked to one project: shown only there, and it always creates there.
  project_id uuid REFERENCES pm.projects(id),
  -- [{ "key": "product", "label": "Product" }]
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ "title", "description", "priority", "tags", "assignee", "due_in_days", "subtasks": [...] }]
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never removed.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL
);

ALTER TABLE pm.task_templates DROP CONSTRAINT IF EXISTS task_templates_name_length;
ALTER TABLE pm.task_templates
  ADD CONSTRAINT task_templates_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 120);
ALTER TABLE pm.task_templates DROP CONSTRAINT IF EXISTS task_templates_description_length;
ALTER TABLE pm.task_templates
  ADD CONSTRAINT task_templates_description_length CHECK (length(description) <= 2000);
ALTER TABLE pm.task_templates DROP CONSTRAINT IF EXISTS task_templates_fields_shape;
ALTER TABLE pm.task_templates
  ADD CONSTRAINT task_templates_fields_shape CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) <= 10);
ALTER TABLE pm.task_templates DROP CONSTRAINT IF EXISTS task_templates_items_shape;
ALTER TABLE pm.task_templates
  ADD CONSTRAINT task_templates_items_shape CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 50);
ALTER TABLE pm.task_templates DROP CONSTRAINT IF EXISTS task_templates_version_positive;
ALTER TABLE pm.task_templates
  ADD CONSTRAINT task_templates_version_positive CHECK (version >= 1);

COMMENT ON TABLE pm.task_templates IS
  'Task templates: one task or a playbook of tasks with subtasks, fill-in fields and due dates counted from a start date. Written by the server only.';
COMMENT ON COLUMN pm.task_templates.project_id IS
  'Locked to this project: the template shows only there and always creates there. Null: any project.';
COMMENT ON COLUMN pm.task_templates.version IS
  'Goes up by one whenever what the template makes changes (name, description, project, fields, items).';

-- The library by name; a project's templates; Trash.
CREATE INDEX IF NOT EXISTS idx_task_templates_name ON pm.task_templates (lower(name), id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_task_templates_project ON pm.task_templates (project_id) WHERE deleted_at IS NULL AND project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_templates_deleted_at ON pm.task_templates (deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- Who made it, and when, never change; the version follows what it makes.
CREATE OR REPLACE FUNCTION pm.handle_task_template_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    IF (NEW.name, NEW.description, NEW.project_id, NEW.fields, NEW.items)
       IS DISTINCT FROM (OLD.name, OLD.description, OLD.project_id, OLD.fields, OLD.items) THEN
      NEW.version := OLD.version + 1;
    ELSE
      NEW.version := OLD.version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_task_template_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS task_templates_before_write ON pm.task_templates;
CREATE TRIGGER task_templates_before_write
  BEFORE INSERT OR UPDATE ON pm.task_templates
  FOR EACH ROW EXECUTE FUNCTION pm.handle_task_template_before_write();

DROP TRIGGER IF EXISTS set_task_templates_updated_at ON pm.task_templates;
CREATE TRIGGER set_task_templates_updated_at
  BEFORE UPDATE ON pm.task_templates
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

-- Never permanently deleted.
DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.task_templates;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.task_templates
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.task_templates;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.task_templates
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

ALTER TABLE pm.task_templates ENABLE ROW LEVEL SECURITY;

-- Whoever may create tasks or manage templates reads the library; a template
-- locked to a project only while they can open that project.
DROP POLICY IF EXISTS task_templates_select ON pm.task_templates;
CREATE POLICY task_templates_select ON pm.task_templates FOR SELECT TO authenticated
  USING (
    (pm.has_permission('templates.manage') OR pm.has_permission('tasks.create'))
    AND (task_templates.project_id IS NULL OR pm.can_access_project(task_templates.project_id))
  );

DROP POLICY IF EXISTS task_templates_not_deleted ON pm.task_templates;
CREATE POLICY task_templates_not_deleted ON pm.task_templates AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);

REVOKE ALL ON pm.task_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.task_templates TO authenticated;
GRANT ALL ON pm.task_templates TO service_role;

-- ---------------------------------------------------------------------------
-- Runs: every use of a template
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.task_template_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES pm.task_templates(id),
  template_version integer NOT NULL,
  -- What the template held when it ran: { name, fields, items }.
  snapshot jsonb NOT NULL,
  project_id uuid NOT NULL REFERENCES pm.projects(id),
  run_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  via text NOT NULL DEFAULT 'app',
  -- The schedule that ran it (schedules come later and add the reference).
  schedule_id uuid,
  start_date date NOT NULL,
  field_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Every task it made, subtasks included, in the order they were made.
  task_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.task_template_runs DROP CONSTRAINT IF EXISTS task_template_runs_via_check;
ALTER TABLE pm.task_template_runs
  ADD CONSTRAINT task_template_runs_via_check CHECK (via IN ('app', 'api', 'mcp', 'schedule'));
ALTER TABLE pm.task_template_runs DROP CONSTRAINT IF EXISTS task_template_runs_snapshot_shape;
ALTER TABLE pm.task_template_runs
  ADD CONSTRAINT task_template_runs_snapshot_shape CHECK (jsonb_typeof(snapshot) = 'object' AND jsonb_typeof(field_values) = 'object');

COMMENT ON TABLE pm.task_template_runs IS
  'One row per use of a task template: its version and snapshot, who ran it and how, the project, start date, fill-in values and the tasks it made. Never changed or removed. Written by the server only.';
COMMENT ON COLUMN pm.task_template_runs.schedule_id IS
  'The schedule that ran it, once schedules exist. Null for a run made by hand, over the API or MCP.';

-- A template's runs, newest first; a schedule's last run.
CREATE INDEX IF NOT EXISTS idx_task_template_runs_template ON pm.task_template_runs (template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_template_runs_schedule ON pm.task_template_runs (schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_template_runs_project ON pm.task_template_runs (project_id, created_at DESC);

-- Never permanently deleted.
DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.task_template_runs;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.task_template_runs
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.task_template_runs;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.task_template_runs
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

ALTER TABLE pm.task_template_runs ENABLE ROW LEVEL SECURITY;

-- Your own runs, and the runs on projects you can open while you may use templates.
DROP POLICY IF EXISTS task_template_runs_select ON pm.task_template_runs;
CREATE POLICY task_template_runs_select ON pm.task_template_runs FOR SELECT TO authenticated
  USING (
    task_template_runs.run_by = pm.current_team_member_id()
    OR (
      (pm.has_permission('templates.manage') OR pm.has_permission('tasks.create'))
      AND pm.can_access_project(task_template_runs.project_id)
    )
  );

REVOKE ALL ON pm.task_template_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.task_template_runs TO authenticated;
GRANT ALL ON pm.task_template_runs TO service_role;

-- Each template's runs counted, and its last, so the library reads them in one query.
CREATE OR REPLACE VIEW pm.task_template_run_stats WITH (security_invoker = true) AS
  SELECT
    template_id,
    count(*)::integer AS runs,
    max(created_at) AS last_run_at
  FROM pm.task_template_runs
  GROUP BY template_id;

REVOKE ALL ON pm.task_template_run_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.task_template_run_stats TO authenticated;
GRANT SELECT ON pm.task_template_run_stats TO service_role;

-- ---------------------------------------------------------------------------
-- Webhooks: template.run, concerning who ran it and everyone its tasks are
-- assigned to. One look at webhook_endpoints when nobody subscribes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.emit_task_template_run_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_members uuid[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['template.run']
  ) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(array_agg(DISTINCT m ORDER BY m) FILTER (WHERE m IS NOT NULL), '{}') INTO v_members
  FROM (
    SELECT NEW.run_by AS m
    UNION ALL
    SELECT a.member_id FROM pm.task_assignees a WHERE a.task_id = ANY (NEW.task_ids)
  ) members;

  PERFORM pm.emit_webhook_event(
    'template.run',
    'template_run',
    NEW.id,
    ARRAY[NEW.project_id],
    v_members,
    jsonb_build_object(
      'run', jsonb_build_object(
        'id', NEW.id,
        'template_id', NEW.template_id,
        'template_version', NEW.template_version,
        'template_name', coalesce(NEW.snapshot ->> 'name', ''),
        'project_id', NEW.project_id,
        'run_by', NEW.run_by,
        'via', NEW.via,
        'schedule_id', NEW.schedule_id,
        'start_date', NEW.start_date,
        'field_values', NEW.field_values,
        'task_ids', to_jsonb(NEW.task_ids),
        'created_at', NEW.created_at
      ),
      'project', jsonb_build_object(
        'id', NEW.project_id,
        'name', coalesce((SELECT p.name FROM pm.projects p WHERE p.id = NEW.project_id), '')
      ),
      'project_id', NEW.project_id,
      'actor_id', pm.webhook_actor_id()
    )
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_task_template_run_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS emit_task_template_run_webhook ON pm.task_template_runs;
CREATE TRIGGER emit_task_template_run_webhook
  AFTER INSERT ON pm.task_template_runs
  FOR EACH ROW EXECUTE FUNCTION pm.emit_task_template_run_webhook();

-- ---------------------------------------------------------------------------
-- Permissions: managing templates is core; Admins hold it by default
-- ---------------------------------------------------------------------------
-- templates.manage is core (no module), so it has no permission_modules row.
INSERT INTO pm.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'templates.manage', 'app'),
  ('admin', 'templates.manage', 'api')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Live sync: open screens see the library and its runs change.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'task_templates') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.task_templates;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'task_template_runs') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.task_template_runs;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Trash: templates join Settings > Trash like every other record
-- ---------------------------------------------------------------------------
-- Moved to Trash through soft_delete_record (the API and the screens), listed
-- by list_trash, restored by restore_record with the same rules: whoever may
-- manage templates (and open a locked template's project); a locked template
-- comes back only after its project. Every move pings live sync.
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
    'project_retainers', 'project_retainer_amounts', 'task_files', 'task_templates'
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
         'project_hourly_rates', 'project_retainers', 'task_templates' THEN
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

DROP TRIGGER IF EXISTS record_trash_event ON pm.task_templates;
CREATE TRIGGER record_trash_event AFTER UPDATE OF deleted_at ON pm.task_templates
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION pm.record_trash_event();
