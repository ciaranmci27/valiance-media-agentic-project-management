-- Agent workspaces: agents on projects with their own settings and
-- instructions, the people who own each agent, a role label for people to
-- find agents by, and a project's context entries read as a brief.
--
-- - pm.project_agents: one agent on one project. status is active or
--   paused; template_key is the template it was set up from (checked against
--   the registry in code); settings holds values for that template's
--   declared fields (checked in code; the database keeps a size backstop);
--   instructions (up to 8000 characters) say what this agent should know or
--   do on this project only. One row per agent and project. An assignment is
--   removed outright, as a project member is. Members who can open the
--   project read it, and an agent reads its own; only the server writes.
-- - pm.agent_owners: the people responsible for an agent, one or more. An
--   owner is a person, never an agent, and an agent never owns itself. When
--   an agent names no escalation target, its questions go to its first
--   active owner before the workspace Owner. Existing agents start with no
--   owner, which reads as the workspace Owners. Only the server writes.
-- - team_members.agent_role: a free-form label for people (builder,
--   code-reviewer), lowercase words joined by dashes, 1 to 40 characters.
--   It drives no behaviour. team_members.description: what the agent is
--   for, up to 2000 characters. Both start empty.
-- - pm.project_context gains section (overview, rules, decisions, links,
--   glossary or history) and pinned. Existing rows get the section their
--   category maps to (business_context to overview, constraint to rules,
--   technical_decision to decisions, existing_work and lesson_learned to
--   history), without touching updated_at; a row written with only a
--   category gets its section the same way. category keeps its five values,
--   so every reader of it works as before. Pinned entries go into every
--   agent's context for the project; pm.search_project_context(project,
--   query, limit) finds the rest by full text over an index (service role
--   only).
-- - pm.project_agent_counts: each agent's assignments counted, with up to
--   50 of its project ids, so a list of agents reads them in one query.
-- - Both new tables join live sync (the supabase_realtime publication).
--
-- Additive and safe to run twice. The previous release's code never reads
-- or writes the new tables or columns: its project context writes name only
-- a category (the section follows), and its reads take every column.

-- ---------------------------------------------------------------------------
-- Role label and description
-- ---------------------------------------------------------------------------
ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS agent_role text,
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_agent_role_check;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_agent_role_check CHECK (agent_role IS NULL OR agent_role ~ '^[a-z][a-z0-9-]{0,39}$');
ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_description_length;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_description_length CHECK (description IS NULL OR length(description) <= 2000);

COMMENT ON COLUMN pm.team_members.agent_role IS
  'An agent''s role label for people (builder, code-reviewer): finding, grouping, routing at a glance. Drives no behaviour.';
COMMENT ON COLUMN pm.team_members.description IS
  'What this member (usually an agent) is for, in plain words.';

-- The distinct roles in use, and agents by role.
CREATE INDEX IF NOT EXISTS idx_team_members_agent_role ON pm.team_members (agent_role) WHERE agent_role IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Agents on projects
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.project_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  template_key text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  instructions text NOT NULL DEFAULT '',
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.project_agents DROP CONSTRAINT IF EXISTS project_agents_project_agent_key;
ALTER TABLE pm.project_agents
  ADD CONSTRAINT project_agents_project_agent_key UNIQUE (project_id, agent_id);
ALTER TABLE pm.project_agents DROP CONSTRAINT IF EXISTS project_agents_status_check;
ALTER TABLE pm.project_agents
  ADD CONSTRAINT project_agents_status_check CHECK (status IN ('active', 'paused'));
ALTER TABLE pm.project_agents DROP CONSTRAINT IF EXISTS project_agents_template_key_shape;
ALTER TABLE pm.project_agents
  ADD CONSTRAINT project_agents_template_key_shape CHECK (template_key IS NULL OR template_key ~ '^[a-z0-9][a-z0-9-]{0,99}$');
ALTER TABLE pm.project_agents DROP CONSTRAINT IF EXISTS project_agents_settings_shape;
ALTER TABLE pm.project_agents
  ADD CONSTRAINT project_agents_settings_shape CHECK (jsonb_typeof(settings) = 'object' AND length(settings::text) <= 16000);
ALTER TABLE pm.project_agents DROP CONSTRAINT IF EXISTS project_agents_instructions_length;
ALTER TABLE pm.project_agents
  ADD CONSTRAINT project_agents_instructions_length CHECK (length(instructions) <= 8000);

COMMENT ON TABLE pm.project_agents IS
  'One agent on one project: active or paused, its template, settings for that template''s fields and instructions for this project. Written by the server only.';
COMMENT ON COLUMN pm.project_agents.settings IS
  'Values for the fields its template declares; checked in code against the template (src/lib/project-agents.ts).';

-- An agent's assignments; a template's agents. A project's come from the unique key.
CREATE INDEX IF NOT EXISTS idx_project_agents_agent ON pm.project_agents (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_project_agents_template ON pm.project_agents (template_key) WHERE template_key IS NOT NULL;

-- Only an agent is assigned; who and where never change after the row is written.
CREATE OR REPLACE FUNCTION pm.handle_project_agent_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.project_id := OLD.project_id;
    NEW.agent_id := OLD.agent_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  ELSIF NOT EXISTS (SELECT 1 FROM pm.team_members m WHERE m.id = NEW.agent_id AND m.role = 'agent') THEN
    RAISE EXCEPTION 'Only an agent member is assigned to a project as an agent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_project_agent_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS project_agents_before_write ON pm.project_agents;
CREATE TRIGGER project_agents_before_write
  BEFORE INSERT OR UPDATE ON pm.project_agents
  FOR EACH ROW EXECUTE FUNCTION pm.handle_project_agent_before_write();

DROP TRIGGER IF EXISTS set_project_agents_updated_at ON pm.project_agents;
CREATE TRIGGER set_project_agents_updated_at
  BEFORE UPDATE ON pm.project_agents
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

ALTER TABLE pm.project_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_agents_select ON pm.project_agents;
CREATE POLICY project_agents_select ON pm.project_agents FOR SELECT TO authenticated
  USING (pm.can_access_project(project_id) OR agent_id = pm.current_team_member_id());

DROP POLICY IF EXISTS project_agents_module_on ON pm.project_agents;
CREATE POLICY project_agents_module_on ON pm.project_agents AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select pm.module_enabled('agents')));

DROP POLICY IF EXISTS project_agents_parent_live ON pm.project_agents;
CREATE POLICY project_agents_parent_live ON pm.project_agents AS RESTRICTIVE FOR ALL TO authenticated
  USING (pm.project_is_live(project_id));

REVOKE ALL ON pm.project_agents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.project_agents TO authenticated;
GRANT ALL ON pm.project_agents TO service_role;

-- Each agent's assignments counted, with up to 50 project ids, in one row.
CREATE OR REPLACE VIEW pm.project_agent_counts WITH (security_invoker = true) AS
  SELECT
    agent_id,
    (count(*) FILTER (WHERE status = 'active'))::integer AS active,
    count(*)::integer AS total,
    (array_agg(project_id ORDER BY created_at))[1:50] AS project_ids
  FROM pm.project_agents
  GROUP BY agent_id;

REVOKE ALL ON pm.project_agent_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.project_agent_counts TO authenticated;
GRANT SELECT ON pm.project_agent_counts TO service_role;

-- ---------------------------------------------------------------------------
-- Agent owners
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.agent_owners (
  agent_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, member_id)
);

COMMENT ON TABLE pm.agent_owners IS
  'The people responsible for an agent. No row: the workspace Owners. Written by the server only.';

-- The agents a person owns.
CREATE INDEX IF NOT EXISTS idx_agent_owners_member ON pm.agent_owners (member_id);

-- An agent is owned by people: never by itself or another agent.
CREATE OR REPLACE FUNCTION pm.handle_agent_owner_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF NEW.agent_id = NEW.member_id THEN
    RAISE EXCEPTION 'An agent cannot own itself' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pm.team_members m WHERE m.id = NEW.agent_id AND m.role = 'agent') THEN
    RAISE EXCEPTION 'Only an agent has owners' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM pm.team_members m WHERE m.id = NEW.member_id AND m.role = 'agent') THEN
    RAISE EXCEPTION 'An agent is owned by people, never by another agent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_agent_owner_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS agent_owners_before_write ON pm.agent_owners;
CREATE TRIGGER agent_owners_before_write
  BEFORE INSERT OR UPDATE ON pm.agent_owners
  FOR EACH ROW EXECUTE FUNCTION pm.handle_agent_owner_before_write();

ALTER TABLE pm.agent_owners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_owners_select ON pm.agent_owners;
CREATE POLICY agent_owners_select ON pm.agent_owners FOR SELECT TO authenticated
  USING (pm.has_permission('team.read') OR member_id = pm.current_team_member_id() OR agent_id = pm.current_team_member_id());

DROP POLICY IF EXISTS agent_owners_module_on ON pm.agent_owners;
CREATE POLICY agent_owners_module_on ON pm.agent_owners AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select pm.module_enabled('agents')));

REVOKE ALL ON pm.agent_owners FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.agent_owners TO authenticated;
GRANT ALL ON pm.agent_owners TO service_role;

-- ---------------------------------------------------------------------------
-- Project brief: sections, pins and search over project context
-- ---------------------------------------------------------------------------
ALTER TABLE pm.project_context
  ADD COLUMN IF NOT EXISTS section text,
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;

-- A row written with only a category (or whose category changes while its
-- section does not) gets the section its category maps to.
CREATE OR REPLACE FUNCTION pm.handle_project_context_section()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF NEW.section IS NULL
    OR (TG_OP = 'UPDATE' AND NEW.category IS DISTINCT FROM OLD.category AND NEW.section IS NOT DISTINCT FROM OLD.section) THEN
    NEW.section := CASE NEW.category
      WHEN 'business_context' THEN 'overview'
      WHEN 'constraint' THEN 'rules'
      WHEN 'technical_decision' THEN 'decisions'
      ELSE 'history'
    END;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_project_context_section() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS project_context_section ON pm.project_context;
CREATE TRIGGER project_context_section
  BEFORE INSERT OR UPDATE ON pm.project_context
  FOR EACH ROW EXECUTE FUNCTION pm.handle_project_context_section();

-- Existing rows, once: their freshness (updated_at) stays as it was.
ALTER TABLE pm.project_context DISABLE TRIGGER set_project_context_updated_at;
UPDATE pm.project_context
SET section = CASE category
  WHEN 'business_context' THEN 'overview'
  WHEN 'constraint' THEN 'rules'
  WHEN 'technical_decision' THEN 'decisions'
  ELSE 'history'
END
WHERE section IS NULL;
ALTER TABLE pm.project_context ENABLE TRIGGER set_project_context_updated_at;

ALTER TABLE pm.project_context ALTER COLUMN section SET NOT NULL;
ALTER TABLE pm.project_context DROP CONSTRAINT IF EXISTS project_context_section_check;
ALTER TABLE pm.project_context
  ADD CONSTRAINT project_context_section_check CHECK (section IN ('overview', 'rules', 'decisions', 'links', 'glossary', 'history'));

COMMENT ON COLUMN pm.project_context.section IS
  'Where the entry reads in the project brief. Set from category when a write names none.';
COMMENT ON COLUMN pm.project_context.pinned IS
  'Pinned entries go into every agent''s context for the project; the rest are found by search.';

-- A brief's sections, pinned first then newest; the pinned entries; full-text search.
CREATE INDEX IF NOT EXISTS idx_project_context_brief ON pm.project_context (project_id, section, pinned DESC, updated_at DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_project_context_pinned ON pm.project_context (project_id, updated_at DESC) WHERE pinned AND is_active;
CREATE INDEX IF NOT EXISTS idx_project_context_search ON pm.project_context USING gin (to_tsvector('english', content)) WHERE is_active;

-- A project's active entries matching a query, best first (web search
-- syntax: words, "phrases", -not). At most 50.
CREATE OR REPLACE FUNCTION pm.search_project_context(p_project_id uuid, p_query text, p_limit integer DEFAULT 20)
RETURNS TABLE (
  id uuid,
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
  SELECT c.id, c.project_id, c.category, c.section, c.content, c.source, c.file_path, c.pinned, c.is_active,
    c.created_at, c.updated_at, ts_rank(to_tsvector('english'::regconfig, c.content), q.query)
  FROM pm.project_context c
  CROSS JOIN websearch_to_tsquery('english'::regconfig, coalesce(p_query, '')) AS q(query)
  WHERE c.project_id = p_project_id
    AND c.is_active
    AND to_tsvector('english'::regconfig, c.content) @@ q.query
  ORDER BY ts_rank(to_tsvector('english'::regconfig, c.content), q.query) DESC, c.pinned DESC, c.updated_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

REVOKE ALL ON FUNCTION pm.search_project_context(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.search_project_context(uuid, text, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Live sync: open screens see assignments and owners change as it happens.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'project_agents') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.project_agents;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'agent_owners') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.agent_owners;
    END IF;
  END IF;
END $$;
