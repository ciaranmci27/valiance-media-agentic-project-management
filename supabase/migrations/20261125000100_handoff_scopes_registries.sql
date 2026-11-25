-- Handoff, context at every level, and the agent registries as rows.
--
-- - Handoff: pm.agent_runs.parent_run_id and root_run_id. A child run names
--   its parent; its root is derived (the parent's root, or the parent), and
--   both are fixed once written. A child acts for the same person as its
--   parent: principal_id is carried down, and a child that would act for
--   someone else is refused. pm.task_delegations links a subtask handed to
--   a specialist to the run that delegated it. run.started and run.finished
--   carry parent_run_id and root_run_id when a run has a parent.
-- - Context scopes: pm.project_context generalised. scope_type (workspace,
--   group, project, agent, member), default project, and scope_id (the
--   group, project, agent or person; null for the workspace). Existing rows
--   stay project rows, with scope_id copied from project_id. Signed-in
--   members still read and write only project rows directly; every other
--   scope goes through the server, which decides who sees it (personal
--   memory: only that person and their own agent, never an Owner).
--   pm.search_scoped_context searches several scopes at once.
-- - Registries: pm.mcp_profile_rows and pm.agent_template_rows, an Owner's
--   own agent profiles and templates, beside the ones in code. The four
--   fleet profiles (coordinator, builder, auditor, reviewer) leave core:
--   where a member still uses one, it becomes a row with the same tool set
--   (every tool its keys allow), so its stored value keeps resolving.
-- - team_members.agent_template_key: the template an agent was set up from,
--   backfilled from the audit log, and kept by a trigger on the audit log
--   while older code still records it only there. Audit retention keeps
--   those rows one release more (2.0.29 reads them).
-- - Personal memory: the permission context.memory ("Read and write my
--   personal memory") that a person's own keys and connected AI tools need
--   for it, held by admins and members on the API by default; and a re-bound
--   personal agent's assistant settings reset (pm.sync_delegate_owner), so
--   "Remember things for me" never carries over to someone else.
--
-- Additive and safe to run twice. The previous release's code never reads
-- the new columns, tables or function, writes project rows exactly as
-- before (the defaults make them project rows), and keeps reading the
-- template from the audit log.

-- ---------------------------------------------------------------------------
-- Handoff: parent and root runs
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES pm.agent_runs(id) ON DELETE SET NULL;
ALTER TABLE pm.agent_runs ADD COLUMN IF NOT EXISTS root_run_id uuid REFERENCES pm.agent_runs(id) ON DELETE SET NULL;

ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_not_own_parent;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_not_own_parent CHECK (parent_run_id IS NULL OR parent_run_id <> id);

COMMENT ON COLUMN pm.agent_runs.parent_run_id IS
  'The run that handed this one its work (an orchestrator''s run); null for a run of its own. Fixed once written.';
COMMENT ON COLUMN pm.agent_runs.root_run_id IS
  'The first run of the chain this run belongs to (derived from the parent); null for a run with no parent. Fixed once written.';

CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON pm.agent_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_runs_root ON pm.agent_runs (root_run_id, started_at) WHERE root_run_id IS NOT NULL;

-- After stamp_principal (triggers fire by name): the root comes from the
-- parent, and the person the parent acted for is carried down. A child the
-- request makes for someone else is refused.
CREATE OR REPLACE FUNCTION pm.stamp_run_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_parent record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.parent_run_id := OLD.parent_run_id;
    NEW.root_run_id := OLD.root_run_id;
    RETURN NEW;
  END IF;
  IF NEW.parent_run_id IS NULL THEN
    NEW.root_run_id := NULL;
    RETURN NEW;
  END IF;
  SELECT r.id, r.root_run_id, r.principal_id INTO v_parent FROM pm.agent_runs r WHERE r.id = NEW.parent_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The parent run does not exist' USING ERRCODE = '23503';
  END IF;
  NEW.root_run_id := coalesce(v_parent.root_run_id, v_parent.id);
  IF NEW.principal_id IS NULL THEN
    NEW.principal_id := v_parent.principal_id;
  ELSIF NEW.principal_id IS DISTINCT FROM v_parent.principal_id THEN
    RAISE EXCEPTION 'new row for relation "agent_runs" violates check constraint "agent_runs_principal_carried"'
      USING ERRCODE = '23514', DETAIL = 'A child run acts for the same person as its parent.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.stamp_run_lineage() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stamp_run_lineage ON pm.agent_runs;
CREATE TRIGGER stamp_run_lineage BEFORE INSERT OR UPDATE OF parent_run_id, root_run_id ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_run_lineage();

-- ---------------------------------------------------------------------------
-- Handoff: a subtask delegated by a run
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.task_delegations (
  task_id uuid PRIMARY KEY REFERENCES pm.tasks(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES pm.agent_runs(id) ON DELETE CASCADE,
  delegated_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  delegated_to uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pm.task_delegations IS
  'A subtask an agent handed to another agent (delegate_task), and the run that handed it over. Written by the server only.';

CREATE INDEX IF NOT EXISTS idx_task_delegations_run ON pm.task_delegations (run_id);
CREATE INDEX IF NOT EXISTS idx_task_delegations_to ON pm.task_delegations (delegated_to) WHERE delegated_to IS NOT NULL;

ALTER TABLE pm.task_delegations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.task_delegations FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.task_delegations TO service_role;

-- ---------------------------------------------------------------------------
-- Handoff: run webhooks carry the chain
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.emit_agent_run_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_type text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pm.webhook_endpoints e
    WHERE e.is_active AND e.events && ARRAY['run.started', 'run.finished']
  ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_type := CASE WHEN NEW.status = 'running' THEN 'run.started' ELSE 'run.finished' END;
  ELSIF OLD.status = 'running' AND NEW.status <> 'running' THEN
    v_type := 'run.finished';
  END IF;
  IF v_type IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pm.emit_webhook_event(
    v_type,
    'run',
    NEW.id,
    ARRAY[NEW.project_id],
    ARRAY[NEW.agent_id],
    jsonb_build_object(
      'run', jsonb_build_object(
        'id', NEW.id,
        'agent_id', NEW.agent_id,
        'task_id', NEW.task_id,
        'project_id', NEW.project_id,
        'status', NEW.status,
        'title', NEW.title,
        'summary', NEW.summary,
        'model', NEW.model,
        'trigger', NEW.trigger,
        'tokens_in', NEW.tokens_in,
        'tokens_out', NEW.tokens_out,
        'cost_usd', NEW.cost_usd,
        'external_id', NEW.external_id,
        'external_url', NEW.external_url,
        'started_at', NEW.started_at,
        'finished_at', NEW.finished_at,
        'updated_at', NEW.updated_at
      ) || CASE WHEN NEW.parent_run_id IS NOT NULL
        THEN jsonb_build_object('parent_run_id', NEW.parent_run_id, 'root_run_id', NEW.root_run_id)
        ELSE '{}'::jsonb END,
      'project', CASE WHEN NEW.project_id IS NOT NULL THEN jsonb_build_object(
        'id', NEW.project_id,
        'name', coalesce((SELECT p.name FROM pm.projects p WHERE p.id = NEW.project_id), '')
      ) END,
      'project_id', NEW.project_id,
      'task_id', NEW.task_id,
      'actor_id', pm.webhook_actor_id()
    )
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_agent_run_webhook() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Context scopes: project_context at every level
-- ---------------------------------------------------------------------------
ALTER TABLE pm.project_context ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'project';
ALTER TABLE pm.project_context ADD COLUMN IF NOT EXISTS scope_id uuid;
ALTER TABLE pm.project_context ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE pm.project_context DROP CONSTRAINT IF EXISTS project_context_scope_type_check;
ALTER TABLE pm.project_context
  ADD CONSTRAINT project_context_scope_type_check CHECK (scope_type IN ('workspace', 'group', 'project', 'agent', 'member'));
-- A project row has its project; the workspace has no id; the rest name their group, agent or person.
ALTER TABLE pm.project_context DROP CONSTRAINT IF EXISTS project_context_scope_shape;
ALTER TABLE pm.project_context
  ADD CONSTRAINT project_context_scope_shape CHECK (CASE scope_type
    WHEN 'project' THEN project_id IS NOT NULL
    WHEN 'workspace' THEN project_id IS NULL AND scope_id IS NULL
    ELSE project_id IS NULL AND scope_id IS NOT NULL
  END);

COMMENT ON COLUMN pm.project_context.scope_type IS
  'Where the entry belongs: workspace (every member), group (its members), project (as always), agent (that agent and who manages it) or member (one person''s memory: them and their own agent only).';
COMMENT ON COLUMN pm.project_context.scope_id IS
  'The group, project, agent or person the entry belongs to; null for the workspace. A project row''s is its project_id.';

-- A project row's scope_id is its project; an entry never changes scope.
CREATE OR REPLACE FUNCTION pm.handle_project_context_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.scope_type := OLD.scope_type;
    IF OLD.scope_type <> 'project' THEN
      NEW.scope_id := OLD.scope_id;
      NEW.project_id := OLD.project_id;
    END IF;
  END IF;
  IF NEW.scope_type = 'project' THEN
    NEW.scope_id := NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_project_context_scope() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS project_context_scope ON pm.project_context;
CREATE TRIGGER project_context_scope
  BEFORE INSERT OR UPDATE ON pm.project_context
  FOR EACH ROW EXECUTE FUNCTION pm.handle_project_context_scope();

-- Existing rows, once: their freshness (updated_at) stays as it was.
ALTER TABLE pm.project_context DISABLE TRIGGER set_project_context_updated_at;
UPDATE pm.project_context SET scope_id = project_id
WHERE scope_type = 'project' AND scope_id IS DISTINCT FROM project_id;
ALTER TABLE pm.project_context ENABLE TRIGGER set_project_context_updated_at;

-- A scope's brief, its pinned entries.
CREATE INDEX IF NOT EXISTS idx_project_context_scope_brief ON pm.project_context (scope_type, scope_id, section, pinned DESC, updated_at DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_project_context_scope_pinned ON pm.project_context (scope_type, scope_id, updated_at DESC) WHERE pinned AND is_active;

-- Signed-in members read and write project rows only; the server decides who sees the other scopes.
DROP POLICY IF EXISTS project_context_project_scope ON pm.project_context;
CREATE POLICY project_context_project_scope ON pm.project_context AS RESTRICTIVE FOR ALL TO authenticated
  USING (scope_type = 'project')
  WITH CHECK (scope_type = 'project');

-- Active entries of several scopes matching a query, best first (web search
-- syntax). The scopes come in pairs, p_scope_types[i] with p_scope_ids[i]
-- (null for the workspace). At most 50. Server only: the API decides which
-- scopes the caller sees.
CREATE OR REPLACE FUNCTION pm.search_scoped_context(p_scope_types text[], p_scope_ids uuid[], p_query text, p_limit integer DEFAULT 20)
RETURNS TABLE (
  id uuid,
  scope_type text,
  scope_id uuid,
  project_id uuid,
  category text,
  section text,
  content text,
  source text,
  file_path text,
  pinned boolean,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz,
  rank real
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.id, c.scope_type, c.scope_id, c.project_id, c.category, c.section, c.content, c.source, c.file_path, c.pinned, c.is_active,
    c.created_at, c.updated_at, ts_rank(to_tsvector('english'::regconfig, c.content), q.query)
  FROM pm.project_context c
  JOIN (SELECT DISTINCT s.scope_type, s.scope_id FROM unnest(p_scope_types, p_scope_ids) AS s(scope_type, scope_id)) AS s
    ON c.scope_type = s.scope_type AND c.scope_id IS NOT DISTINCT FROM s.scope_id
  CROSS JOIN websearch_to_tsquery('english'::regconfig, coalesce(p_query, '')) AS q(query)
  WHERE c.is_active
    AND to_tsvector('english'::regconfig, c.content) @@ q.query
  ORDER BY ts_rank(to_tsvector('english'::regconfig, c.content), q.query) DESC, c.pinned DESC, c.updated_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

REVOKE ALL ON FUNCTION pm.search_scoped_context(text[], uuid[], text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.search_scoped_context(text[], uuid[], text, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Personal memory: its own permission, and settings that never outlive a rebind
-- ---------------------------------------------------------------------------
-- context.memory is core (no module), so it has no permission_modules row.
-- People hold it on the API by default (Owners hold every permission); no
-- agent does: a personal agent reaches its person's memory only while they
-- allow it.
INSERT INTO pm.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'context.memory', 'api'),
  ('member', 'context.memory', 'api')
ON CONFLICT DO NOTHING;

-- The person owns their personal agent; changing who it works for moves it.
-- Re-binding or unbinding it also ends everything the old person's agent
-- held: every live key with its descendants and every live delegation token,
-- each with an audit row, and that person's settings for it, so nothing made
-- for one person reads another's.
CREATE OR REPLACE FUNCTION pm.sync_delegate_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key record;
  v_revoked record;
  v_ids uuid[];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.delegate_of IS NOT NULL AND OLD.delegate_of IS DISTINCT FROM NEW.delegate_of THEN
    DELETE FROM pm.agent_owners WHERE agent_id = NEW.id AND member_id = OLD.delegate_of;
    FOR v_key IN
      SELECT k.id FROM pm.api_keys k WHERE k.team_member_id = NEW.id AND k.revoked_at IS NULL ORDER BY k.created_at, k.id
    LOOP
      FOR v_revoked IN SELECT * FROM pm.revoke_api_key_tree(v_key.id) LOOP
        PERFORM pm.audit_member_cascade(NEW.id, 'rebind', 'api_key', v_revoked.id,
          jsonb_build_object('step', 'key_revoked', 'cascaded_from', v_key.id, 'depth', v_revoked.depth,
            'previous_person', OLD.delegate_of, 'person', NEW.delegate_of));
      END LOOP;
    END LOOP;
    WITH revoked AS (
      UPDATE pm.delegation_tokens t SET revoked_at = now()
      WHERE t.agent_id = NEW.id AND t.revoked_at IS NULL AND t.expires_at > now()
      RETURNING t.id
    )
    SELECT array_agg(id ORDER BY id) INTO v_ids FROM revoked;
    IF v_ids IS NOT NULL THEN
      PERFORM pm.audit_member_cascade(NEW.id, 'rebind', 'delegation_token', NULL,
        jsonb_build_object('step', 'delegations_revoked', 'token_ids', to_jsonb(v_ids), 'previous_person', OLD.delegate_of, 'person', NEW.delegate_of));
    END IF;
  END IF;
  -- Whatever its last person set (tone, switches, "Remember things for me")
  -- was theirs: a re-bound or unbound agent starts from the defaults.
  IF TG_OP = 'UPDATE' AND OLD.delegate_of IS DISTINCT FROM NEW.delegate_of THEN
    DELETE FROM pm.assistant_preferences WHERE agent_id = NEW.id;
  END IF;
  IF NEW.delegate_of IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.delegate_of IS DISTINCT FROM NEW.delegate_of) THEN
    INSERT INTO pm.agent_owners (agent_id, member_id, created_by)
    SELECT NEW.id, p.id, p.id FROM pm.team_members p
    WHERE p.id = NEW.delegate_of AND coalesce(p.status, 'active') = 'active'
    ON CONFLICT (agent_id, member_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.sync_delegate_owner() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Registries: agent profiles and templates as rows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.mcp_profile_rows (
  value text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL,
  -- The MCP tools it sees (pm_guide always); null for every tool its keys allow.
  tools text[],
  archived_at timestamptz,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.mcp_profile_rows DROP CONSTRAINT IF EXISTS mcp_profile_rows_value_check;
ALTER TABLE pm.mcp_profile_rows
  ADD CONSTRAINT mcp_profile_rows_value_check CHECK (value ~ '^[a-z][a-z0-9-]{0,39}$');
ALTER TABLE pm.mcp_profile_rows DROP CONSTRAINT IF EXISTS mcp_profile_rows_text_check;
ALTER TABLE pm.mcp_profile_rows
  ADD CONSTRAINT mcp_profile_rows_text_check CHECK (length(label) BETWEEN 1 AND 80 AND length(description) BETWEEN 1 AND 500);
ALTER TABLE pm.mcp_profile_rows DROP CONSTRAINT IF EXISTS mcp_profile_rows_tools_check;
ALTER TABLE pm.mcp_profile_rows
  ADD CONSTRAINT mcp_profile_rows_tools_check CHECK (tools IS NULL OR cardinality(tools) BETWEEN 1 AND 300);

COMMENT ON TABLE pm.mcp_profile_rows IS
  'An Owner''s own agent profiles (which MCP tools an agent sees), beside the ones in code. A value never repeats a code profile''s. Archived, never deleted.';

CREATE TABLE IF NOT EXISTS pm.agent_template_rows (
  key text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL,
  -- rules, scopes, context, webhook_events, module, settings, role, profile, limits (lib/extensions/agent-templates.ts).
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.agent_template_rows DROP CONSTRAINT IF EXISTS agent_template_rows_key_check;
ALTER TABLE pm.agent_template_rows
  ADD CONSTRAINT agent_template_rows_key_check CHECK (key ~ '^[a-z0-9][a-z0-9-]*$' AND length(key) <= 100);
ALTER TABLE pm.agent_template_rows DROP CONSTRAINT IF EXISTS agent_template_rows_text_check;
ALTER TABLE pm.agent_template_rows
  ADD CONSTRAINT agent_template_rows_text_check CHECK (length(label) BETWEEN 1 AND 80 AND length(description) BETWEEN 1 AND 500);
ALTER TABLE pm.agent_template_rows DROP CONSTRAINT IF EXISTS agent_template_rows_spec_check;
ALTER TABLE pm.agent_template_rows
  ADD CONSTRAINT agent_template_rows_spec_check CHECK (jsonb_typeof(spec) = 'object' AND length(spec::text) <= 20000);

COMMENT ON TABLE pm.agent_template_rows IS
  'An Owner''s own agent templates, beside the ones in code. A key never repeats a code template''s. Archived, never deleted.';

DROP TRIGGER IF EXISTS set_mcp_profile_rows_updated_at ON pm.mcp_profile_rows;
CREATE TRIGGER set_mcp_profile_rows_updated_at
  BEFORE UPDATE ON pm.mcp_profile_rows
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();
DROP TRIGGER IF EXISTS set_agent_template_rows_updated_at ON pm.agent_template_rows;
CREATE TRIGGER set_agent_template_rows_updated_at
  BEFORE UPDATE ON pm.agent_template_rows
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.mcp_profile_rows;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.mcp_profile_rows
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.mcp_profile_rows;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.mcp_profile_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.agent_template_rows;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.agent_template_rows
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.agent_template_rows;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.agent_template_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

ALTER TABLE pm.mcp_profile_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.agent_template_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.mcp_profile_rows FROM PUBLIC, anon, authenticated;
REVOKE ALL ON pm.agent_template_rows FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.mcp_profile_rows TO service_role;
GRANT ALL ON pm.agent_template_rows TO service_role;

-- The four fleet profiles leave core. Only where a member still uses one does
-- it become a row, with the tool set it had (every tool its keys allow): an
-- install that never used them gets nothing.
INSERT INTO pm.mcp_profile_rows (value, label, description, tools)
SELECT v.value, v.label, v.description, NULL
FROM (VALUES
  ('coordinator', 'Coordinator', 'Plans and assigns work, keeps projects and leads current'),
  ('builder', 'Builder', 'Works assigned tasks, tracks time and raises blockers'),
  ('auditor', 'Auditor', 'Audits projects against their goals and proposes tasks'),
  ('reviewer', 'Reviewer', 'Reviews finished work and records verdicts')
) AS v(value, label, description)
WHERE EXISTS (SELECT 1 FROM pm.team_members m WHERE m.agent_profile = v.value)
ON CONFLICT (value) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The template an agent was set up from, on the agent
-- ---------------------------------------------------------------------------
ALTER TABLE pm.team_members ADD COLUMN IF NOT EXISTS agent_template_key text;
ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_agent_template_key_check;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_agent_template_key_check CHECK (agent_template_key IS NULL OR length(agent_template_key) BETWEEN 1 AND 100);

COMMENT ON COLUMN pm.team_members.agent_template_key IS
  'The template an agent was last set up from (hire, apply or import); null when none was. Kept on the agent, so audit retention cannot lose it.';

-- Once: the newest successful hire, apply or import that named a template.
UPDATE pm.team_members m
SET agent_template_key = t.template_key
FROM (
  SELECT DISTINCT ON (l.entity_id) l.entity_id, l.request_body->>'template' AS template_key
  FROM pm.api_audit_log l
  WHERE l.entity_type = 'team_member'
    AND l.status_code < 300
    AND jsonb_typeof(l.request_body->'template') = 'string'
    AND (l.endpoint IN ('/api/v1/agents/import', '/api/workspace/agents') OR l.endpoint = '/api/v1/agents/' || l.entity_id::text || '/template')
  ORDER BY l.entity_id, l.timestamp DESC, l.id DESC
) t
WHERE m.id = t.entity_id
  AND m.role = 'agent'
  AND m.agent_template_key IS NULL
  AND length(t.template_key) BETWEEN 1 AND 100;

-- Older code records the template only in the audit log: each such row sets it on the agent too,
-- unless a newer one already named another.
CREATE OR REPLACE FUNCTION pm.record_agent_template_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF NEW.endpoint IN ('/api/v1/agents/import', '/api/workspace/agents') OR NEW.endpoint = '/api/v1/agents/' || NEW.entity_id::text || '/template' THEN
    UPDATE pm.team_members
    SET agent_template_key = NEW.request_body->>'template'
    WHERE id = NEW.entity_id
      AND role = 'agent'
      AND length(NEW.request_body->>'template') BETWEEN 1 AND 100
      AND agent_template_key IS DISTINCT FROM NEW.request_body->>'template'
      AND NOT EXISTS (
        SELECT 1 FROM pm.api_audit_log l
        WHERE l.entity_type = 'team_member'
          AND l.entity_id = NEW.entity_id
          AND l.id <> NEW.id
          AND l.status_code < 300
          AND l.timestamp > NEW.timestamp
          AND jsonb_typeof(l.request_body->'template') = 'string'
          AND (l.endpoint IN ('/api/v1/agents/import', '/api/workspace/agents') OR l.endpoint = '/api/v1/agents/' || l.entity_id::text || '/template')
      );
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.record_agent_template_key() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS record_agent_template_key ON pm.api_audit_log;
CREATE TRIGGER record_agent_template_key AFTER INSERT ON pm.api_audit_log
  FOR EACH ROW
  WHEN (NEW.entity_type = 'team_member' AND NEW.status_code < 300 AND jsonb_typeof(NEW.request_body->'template') = 'string')
  EXECUTE FUNCTION pm.record_agent_template_key();

-- Retention keeps what the app still reads from the log: the agents a
-- deprovision took ownership of and, for one more release, the template an
-- agent was set up from (2.0.29 reads it there; it now lives on the agent).
-- The next release drops the template exception.
CREATE OR REPLACE FUNCTION pm.purge_audit_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_days integer;
  v_count integer := 0;
BEGIN
  SELECT audit_retention_days INTO v_days FROM pm.business_settings LIMIT 1;
  IF v_days IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM set_config('pm.audit_retention', 'on', true);
  DELETE FROM pm.api_audit_log l
  WHERE l.timestamp < now() - make_interval(days => v_days)
    -- The template an agent was set up from (2.0.29 reads it here). Dropped next release.
    AND NOT coalesce(l.entity_type = 'team_member' AND l.request_body ? 'template', false)
    -- The agents a deprovision took ownership of (read on reactivation).
    AND NOT coalesce(l.endpoint LIKE '/app/team-members/%/deprovision' AND l.request_body->>'step' = 'owner_removed', false);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('pm.audit_retention', 'off', true);
  IF v_count > 0 THEN
    INSERT INTO pm.api_audit_log (method, endpoint, entity_type, request_body, status_code, via)
    VALUES ('DELETE', '/app/audit/retention', 'api_audit_log',
      jsonb_build_object('deleted', v_count, 'retention_days', v_days), 200, 'app');
  END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION pm.purge_audit_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.purge_audit_log() TO service_role;
