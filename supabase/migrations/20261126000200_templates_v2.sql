-- Templates v2: playbooks planned around key dates, assigned by role, with
-- dependencies, that a run turns into an initiative with its tasks.
--
-- - pm.task_templates gains key_dates (named anchors: [{ key, label, main }],
--   "start" by default, so a 2.0.34 template's due_in_days keeps meaning
--   start + N), roles ([{ key, label, default_member_id, required }]) and
--   guidance (one note for whoever, person or agent, fills it in). Each item
--   in items may now carry key (stable, the server assigns one when missing),
--   anchor, role and depends_on (top-level items only); due_in_days may be
--   negative (before its key date). The scope is project_id: set, the
--   template belongs to that project; null, it is company-wide.
-- - Who may write: whoever manages the project (projects.manage on a project
--   they can open) or templates.manage for a project's templates;
--   templates.manage alone for company-wide ones. can_trash_record follows.
-- - The version follows the new columns too.
-- - pm.task_template_runs gains key_dates ({ key: date }), role_members
--   ({ role: member id }) and initiative_id (the initiative the run made).
-- - pm.task_template_run_tasks: one row per task a run made, with the item
--   key it came from and the due date it was planned for, so a later change
--   of key dates can tell planned dates from hand-changed ones. Server only.
-- - pm.record_task_template_run: the run row and its task links in one
--   transaction. Server only.
-- - Webhooks: template.run gains run.key_dates and run.initiative_id.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the new columns or table, and its runs still record (the new
-- columns default to empty).

-- ---------------------------------------------------------------------------
-- Templates: key dates, roles and guidance
-- ---------------------------------------------------------------------------
ALTER TABLE pm.task_templates ADD COLUMN IF NOT EXISTS key_dates jsonb NOT NULL DEFAULT '[{"key": "start", "label": "Start date"}]'::jsonb;
ALTER TABLE pm.task_templates ADD COLUMN IF NOT EXISTS roles jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pm.task_templates ADD COLUMN IF NOT EXISTS guidance text NOT NULL DEFAULT '';

ALTER TABLE pm.task_templates DROP CONSTRAINT IF EXISTS task_templates_key_dates_shape;
ALTER TABLE pm.task_templates
  ADD CONSTRAINT task_templates_key_dates_shape CHECK (jsonb_typeof(key_dates) = 'array' AND jsonb_array_length(key_dates) BETWEEN 1 AND 10);
ALTER TABLE pm.task_templates DROP CONSTRAINT IF EXISTS task_templates_roles_shape;
ALTER TABLE pm.task_templates
  ADD CONSTRAINT task_templates_roles_shape CHECK (jsonb_typeof(roles) = 'array' AND jsonb_array_length(roles) <= 20);
ALTER TABLE pm.task_templates DROP CONSTRAINT IF EXISTS task_templates_guidance_length;
ALTER TABLE pm.task_templates
  ADD CONSTRAINT task_templates_guidance_length CHECK (length(guidance) <= 10000);

COMMENT ON COLUMN pm.task_templates.project_id IS
  'The project the template belongs to: it shows only there, always creates there, and whoever manages the project may change it. Null: company-wide, usable in any project, changed with templates.manage.';
COMMENT ON COLUMN pm.task_templates.key_dates IS
  'Named key dates each task''s due_in_days counts from: [{ "key", "label", "main" }]. The main one (or the first) is the target date of a run''s initiative.';
COMMENT ON COLUMN pm.task_templates.roles IS
  'Roles tasks are assigned by: [{ "key", "label", "default_member_id", "required" }]. A run maps each to one member, a person or an agent.';
COMMENT ON COLUMN pm.task_templates.guidance IS
  'How to fill the template in and what to look at first, for a person or an agent drafting a run.';
COMMENT ON COLUMN pm.task_templates.version IS
  'Goes up by one whenever what the template makes changes (name, description, project, fields, items, key dates, roles, guidance).';

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
    IF (NEW.name, NEW.description, NEW.project_id, NEW.fields, NEW.items, NEW.key_dates, NEW.roles, NEW.guidance)
       IS DISTINCT FROM (OLD.name, OLD.description, OLD.project_id, OLD.fields, OLD.items, OLD.key_dates, OLD.roles, OLD.guidance) THEN
      NEW.version := OLD.version + 1;
    ELSE
      NEW.version := OLD.version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_task_template_before_write() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Runs: key dates, the role map and the initiative a run made
-- ---------------------------------------------------------------------------
ALTER TABLE pm.task_template_runs ADD COLUMN IF NOT EXISTS key_dates jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pm.task_template_runs ADD COLUMN IF NOT EXISTS role_members jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pm.task_template_runs ADD COLUMN IF NOT EXISTS initiative_id uuid REFERENCES pm.initiatives(id);

ALTER TABLE pm.task_template_runs DROP CONSTRAINT IF EXISTS task_template_runs_plan_shape;
ALTER TABLE pm.task_template_runs
  ADD CONSTRAINT task_template_runs_plan_shape CHECK (jsonb_typeof(key_dates) = 'object' AND jsonb_typeof(role_members) = 'object');

COMMENT ON COLUMN pm.task_template_runs.key_dates IS
  'The date each key date was set to: { "start": "2026-12-01", "launch": "2027-01-15" }. Empty for a run recorded before key dates existed (start_date is its start).';
COMMENT ON COLUMN pm.task_template_runs.role_members IS
  'The member each role was assigned to: { "designer": "<member id>" }.';
COMMENT ON COLUMN pm.task_template_runs.initiative_id IS
  'The initiative the run made, its tasks inside it. Null when the run made none.';

CREATE INDEX IF NOT EXISTS idx_task_template_runs_initiative ON pm.task_template_runs (initiative_id) WHERE initiative_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Run tasks: which item each task came from, and its planned due date
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.task_template_run_tasks (
  run_id uuid NOT NULL REFERENCES pm.task_template_runs(id),
  task_id uuid NOT NULL REFERENCES pm.tasks(id),
  item_key text NOT NULL,
  -- The due date the run planned (key date + offset); null for no due date.
  planned_due_date date,
  PRIMARY KEY (run_id, task_id)
);

ALTER TABLE pm.task_template_run_tasks DROP CONSTRAINT IF EXISTS task_template_run_tasks_item_key_length;
ALTER TABLE pm.task_template_run_tasks
  ADD CONSTRAINT task_template_run_tasks_item_key_length CHECK (length(item_key) BETWEEN 1 AND 80);

COMMENT ON TABLE pm.task_template_run_tasks IS
  'One row per task a template run made: the template item it came from (item_key) and the due date it was planned for. Never removed. Written by the server only.';

-- A task's run; one item per run.
CREATE INDEX IF NOT EXISTS idx_task_template_run_tasks_task ON pm.task_template_run_tasks (task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_template_run_tasks_item ON pm.task_template_run_tasks (run_id, item_key);

-- Never permanently deleted.
DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.task_template_run_tasks;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.task_template_run_tasks
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.task_template_run_tasks;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.task_template_run_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

-- Server only: no member policy, no member grant.
ALTER TABLE pm.task_template_run_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.task_template_run_tasks FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.task_template_run_tasks TO service_role;

-- The run and its task links in one transaction: nothing half recorded.
-- p_run carries the run's columns; p_tasks is [{ task_id, item_key, planned_due_date }].
CREATE OR REPLACE FUNCTION pm.record_task_template_run(p_run jsonb, p_tasks jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO pm.task_template_runs (
    template_id, template_version, snapshot, project_id, run_by, via, schedule_id, start_date,
    field_values, task_ids, key_dates, role_members, initiative_id
  ) VALUES (
    (p_run ->> 'template_id')::uuid,
    (p_run ->> 'template_version')::integer,
    p_run -> 'snapshot',
    (p_run ->> 'project_id')::uuid,
    nullif(p_run ->> 'run_by', '')::uuid,
    coalesce(p_run ->> 'via', 'app'),
    nullif(p_run ->> 'schedule_id', '')::uuid,
    (p_run ->> 'start_date')::date,
    coalesce(p_run -> 'field_values', '{}'::jsonb),
    coalesce(ARRAY(
      SELECT t.value::uuid FROM jsonb_array_elements_text(coalesce(p_run -> 'task_ids', '[]'::jsonb)) WITH ORDINALITY AS t(value, n) ORDER BY t.n
    ), '{}'),
    coalesce(p_run -> 'key_dates', '{}'::jsonb),
    coalesce(p_run -> 'role_members', '{}'::jsonb),
    nullif(p_run ->> 'initiative_id', '')::uuid
  )
  RETURNING id INTO v_id;

  INSERT INTO pm.task_template_run_tasks (run_id, task_id, item_key, planned_due_date)
  SELECT v_id, (link ->> 'task_id')::uuid, link ->> 'item_key', nullif(link ->> 'planned_due_date', '')::date
  FROM jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) AS link;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION pm.record_task_template_run(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.record_task_template_run(jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Webhooks: template.run gains the key dates and the initiative
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
        'created_at', NEW.created_at,
        'key_dates', NEW.key_dates,
        'initiative_id', NEW.initiative_id
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

-- ---------------------------------------------------------------------------
-- Trash: a project's templates go by whoever manages the project
-- ---------------------------------------------------------------------------
-- Moved to Trash, listed and restored with the rule the server applies to
-- writing them: a company-wide template needs templates.manage; a project's
-- template needs the project and projects.manage or templates.manage.
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
      -- Company-wide: templates.manage. A project's: whoever manages the
      -- project (projects.manage) or templates.manage, on a project they can open.
      SELECT CASE
          WHEN task_templates.project_id IS NULL THEN pm.has_permission('templates.manage')
          ELSE pm.can_access_project(task_templates.project_id)
            AND (pm.has_permission('templates.manage') OR pm.has_permission('projects.manage'))
        END
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
