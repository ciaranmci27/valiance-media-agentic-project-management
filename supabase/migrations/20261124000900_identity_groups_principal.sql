-- Identity, groups and on behalf of: groups of people and agents, the chat
-- identities each person has proven are theirs, and a shared agent acting for
-- the person who asked it, within that person's access.
--
-- - pm.groups: a named group (Finance, Support). name (1 to 100
--   characters), slug (lowercase words joined by dashes, unique among live
--   groups), description (up to 2000), external_id (for a directory sync
--   later; unique among live groups when set), created_by. Moved to Trash
--   (deleted_at, deleted_by), never permanently deleted. Members who may read
--   the team (team.read or team.manage) read every live group; anyone reads
--   the groups they are in. Only the server writes.
-- - pm.group_members: who is in a group, a person or an agent, with role
--   member or lead. Removed outright, as a project member is. A member
--   reads their own memberships; whoever may read the team reads all.
--   pm.group_member_counts counts each group's members and leads.
-- - Questions and approvals can be asked to a group: asked_to_group.
--   asked_to becomes nullable, and exactly one of the two is set
--   (questions_one_addressee). The previous release always sets asked_to, so
--   its inserts pass. Every active member of the group (but the asker) has
--   their bell rung; any member may answer (answered_by records who);
--   answering, cancelling, expiring or Trash clears every bell. Group
--   members are parties: they read the question, and the question.* webhook
--   events name them in member_ids. A question's payload adds
--   asked_to_group and principal_id only when they are set, so a plain
--   question's payload is unchanged.
-- - team_members.agent_escalate_to_group: an agent may escalate to a group.
--   agent_escalate_to (a person) comes first when both are set.
-- - pm.agent_owner_groups: an agent may be owned by groups, beside its
--   people (pm.agent_owners, unchanged). Any active person in an owner group
--   manages the agent as an owner does; an agent in the group never does.
-- - pm.member_identities: the chat and other identities each member has
--   (provider slack, teams, telegram, discord, github, email or custom.<name>;
--   external_id; workspace_id for providers with workspaces; handle). One
--   per (provider, workspace_id, external_id). verified_at and
--   verified_method (link: the person confirmed it signed in; admin: an
--   Owner or team manager linked it; directory: a directory sync, later) are
--   set together; only verified identities resolve. A member reads their
--   own; team.manage reads all. Removed outright when unlinked.
-- - pm.identity_link_requests: one-time links a harness asks for so a person
--   can prove an identity is theirs. Only the token's hash is stored; each
--   expires and is used once. Service role only.
-- - pm.delegation_tokens: short-lived tokens that let one agent act for one
--   person (sent as X-Act-For). Only the hash is stored, so a token can be
--   revoked. Service role only.
-- - principal_id on agent_runs, questions, tasks, agent_activities,
--   task_comments and api_audit_log: the person an agent acted for. Stamped
--   by pm.stamp_principal from the server's x-actor-principal-id header
--   (service role only, like x-actor-member-id), never from the row, and
--   fixed once written.
-- - New permission agents.act_for (AI agents module). groups.manage,
--   identities.link and identities.read are core. Owners hold all four; no
--   role is granted any by default. groups.manage is a power permission: a
--   group can own agents and decide approvals.
--
-- Row policies name the outer table on every column inside a subquery
-- (agent_owner_groups.group_id, not group_id), so none binds to the
-- subquery's own table by mistake.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the new tables or columns: it always sets asked_to (so the new check
-- passes), never sets asked_to_group, and its inserts get a null
-- principal_id.

-- ---------------------------------------------------------------------------
-- Groups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  external_id text,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Trash: when it was deleted and by whom (null = live). Rows are never removed.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL
);

ALTER TABLE pm.groups DROP CONSTRAINT IF EXISTS groups_name_length;
ALTER TABLE pm.groups
  ADD CONSTRAINT groups_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 100);
ALTER TABLE pm.groups DROP CONSTRAINT IF EXISTS groups_slug_shape;
ALTER TABLE pm.groups
  ADD CONSTRAINT groups_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$');
ALTER TABLE pm.groups DROP CONSTRAINT IF EXISTS groups_description_length;
ALTER TABLE pm.groups
  ADD CONSTRAINT groups_description_length CHECK (length(description) <= 2000);
ALTER TABLE pm.groups DROP CONSTRAINT IF EXISTS groups_external_id_length;
ALTER TABLE pm.groups
  ADD CONSTRAINT groups_external_id_length CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 255);

COMMENT ON TABLE pm.groups IS
  'A named group of people and agents: a target for questions, approvals, escalation and agent ownership. Written by the server only.';
COMMENT ON COLUMN pm.groups.external_id IS
  'The group''s id in a directory (SCIM, Google, Entra), for a sync later. Unique among live groups.';

-- One live group per slug and per directory id; the list by name.
CREATE UNIQUE INDEX IF NOT EXISTS groups_slug_live ON pm.groups (slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS groups_external_id_live ON pm.groups (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_groups_name ON pm.groups (lower(name), id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_groups_deleted_at ON pm.groups (deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- Who made it, and when, never change.
CREATE OR REPLACE FUNCTION pm.handle_group_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  IF TG_OP = 'UPDATE' THEN
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_group_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS groups_before_write ON pm.groups;
CREATE TRIGGER groups_before_write
  BEFORE INSERT OR UPDATE ON pm.groups
  FOR EACH ROW EXECUTE FUNCTION pm.handle_group_before_write();

DROP TRIGGER IF EXISTS set_groups_updated_at ON pm.groups;
CREATE TRIGGER set_groups_updated_at
  BEFORE UPDATE ON pm.groups
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

-- Never permanently deleted.
DROP TRIGGER IF EXISTS forbid_hard_delete ON pm.groups;
CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON pm.groups
  FOR EACH ROW EXECUTE FUNCTION pm.forbid_hard_delete();
DROP TRIGGER IF EXISTS forbid_truncate ON pm.groups;
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pm.groups
  FOR EACH STATEMENT EXECUTE FUNCTION pm.forbid_hard_delete();

CREATE TABLE IF NOT EXISTS pm.group_members (
  group_id uuid NOT NULL REFERENCES pm.groups(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, member_id)
);

ALTER TABLE pm.group_members DROP CONSTRAINT IF EXISTS group_members_role_check;
ALTER TABLE pm.group_members
  ADD CONSTRAINT group_members_role_check CHECK (role IN ('member', 'lead'));

COMMENT ON TABLE pm.group_members IS
  'Who is in a group (a person or an agent), as member or lead. Removed outright. Written by the server only.';

-- The groups a member is in; a group's leads.
CREATE INDEX IF NOT EXISTS idx_group_members_member ON pm.group_members (member_id);
CREATE INDEX IF NOT EXISTS idx_group_members_role ON pm.group_members (group_id, role, created_at);

ALTER TABLE pm.groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS groups_select ON pm.groups;
CREATE POLICY groups_select ON pm.groups FOR SELECT TO authenticated
  USING (pm.has_permission('team.read') OR pm.has_permission('team.manage') OR EXISTS (SELECT 1 FROM pm.group_members gm WHERE gm.group_id = groups.id AND gm.member_id = pm.current_team_member_id()));

DROP POLICY IF EXISTS groups_not_deleted ON pm.groups;
CREATE POLICY groups_not_deleted ON pm.groups AS RESTRICTIVE FOR ALL TO authenticated
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);

REVOKE ALL ON pm.groups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.groups TO authenticated;
GRANT ALL ON pm.groups TO service_role;

ALTER TABLE pm.group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS group_members_select ON pm.group_members;
CREATE POLICY group_members_select ON pm.group_members FOR SELECT TO authenticated
  USING (pm.has_permission('team.read') OR pm.has_permission('team.manage') OR member_id = pm.current_team_member_id());

REVOKE ALL ON pm.group_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.group_members TO authenticated;
GRANT ALL ON pm.group_members TO service_role;

-- Each group's members and leads counted, so a list of groups reads them in one query.
CREATE OR REPLACE VIEW pm.group_member_counts WITH (security_invoker = true) AS
  SELECT
    group_id,
    count(*)::integer AS members,
    (count(*) FILTER (WHERE role = 'lead'))::integer AS leads
  FROM pm.group_members
  GROUP BY group_id;

REVOKE ALL ON pm.group_member_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.group_member_counts TO authenticated;
GRANT SELECT ON pm.group_member_counts TO service_role;

-- ---------------------------------------------------------------------------
-- Questions and approvals asked to a group
-- ---------------------------------------------------------------------------
ALTER TABLE pm.questions
  ADD COLUMN IF NOT EXISTS asked_to_group uuid REFERENCES pm.groups(id),
  ADD COLUMN IF NOT EXISTS principal_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL;

ALTER TABLE pm.questions ALTER COLUMN asked_to DROP NOT NULL;
ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_one_addressee;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_one_addressee CHECK (num_nonnulls(asked_to, asked_to_group) = 1);

COMMENT ON COLUMN pm.questions.asked_to_group IS
  'Asked to a group instead of one member: any member answers (answered_by says who). Exactly one of asked_to and asked_to_group is set.';
COMMENT ON COLUMN pm.questions.principal_id IS
  'The person an agent asked this for (X-Act-For). Stamped by the server, never from the row.';

CREATE INDEX IF NOT EXISTS idx_questions_asked_to_group_open
  ON pm.questions (asked_to_group, created_at) WHERE asked_to_group IS NOT NULL AND status = 'open' AND deleted_at IS NULL;

-- The bell: the member asked, or every active member of the group asked
-- (never the asker). An approval says so; a plain question reads as before.
CREATE OR REPLACE FUNCTION pm.notify_question_asked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  asker text;
  title text;
  group_name text;
  recipient uuid;
BEGIN
  IF NEW.status <> 'open' OR NEW.deleted_at IS NOT NULL OR NEW.asked_to = NEW.asked_by THEN
    RETURN NULL;
  END IF;
  SELECT name INTO asker FROM pm.team_members WHERE id = NEW.asked_by;
  title := CASE WHEN NEW.kind = 'approval' THEN 'Approval request from ' ELSE 'Question from ' END
    || COALESCE(NULLIF(btrim(asker), ''), 'a teammate');
  IF NEW.asked_to IS NOT NULL THEN
    PERFORM pm.upsert_notification(
      NEW.asked_to,
      title,
      left(NEW.question, 500),
      -- My Tasks, where the asked member answers it: they may not be able to
      -- open the task or project it is on.
      '/my-tasks',
      'question',
      NEW.id::text
    );
    RETURN NULL;
  END IF;
  SELECT g.name INTO group_name FROM pm.groups g WHERE g.id = NEW.asked_to_group;
  title := title || ' to ' || COALESCE(NULLIF(btrim(group_name), ''), 'your group');
  FOR recipient IN
    SELECT gm.member_id
    FROM pm.group_members gm
    JOIN pm.team_members m ON m.id = gm.member_id
    WHERE gm.group_id = NEW.asked_to_group
      AND gm.member_id <> NEW.asked_by
      AND coalesce(m.status, 'active') = 'active'
  LOOP
    PERFORM pm.upsert_notification(recipient, title, left(NEW.question, 500), '/my-tasks', 'question', NEW.id::text);
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.notify_question_asked() FROM PUBLIC, anon, authenticated;

-- Who a question event concerns adds the group's members and the person an
-- agent acted for.
CREATE OR REPLACE FUNCTION pm.webhook_event_members(p_subject_type text, p_subject_id uuid, p_also uuid[] DEFAULT '{}')
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT coalesce(array_agg(DISTINCT m ORDER BY m) FILTER (WHERE m IS NOT NULL), '{}')
  FROM (
    SELECT a.member_id AS m FROM pm.task_assignees a
    WHERE p_subject_type = 'task' AND a.task_id = p_subject_id
    UNION ALL
    SELECT t.claimed_by FROM pm.tasks t
    WHERE p_subject_type = 'task' AND t.id = p_subject_id
      AND (t.claim_expires_at IS NULL OR t.claim_expires_at > now())
    UNION ALL
    SELECT unnest(ARRAY[q.asked_to, q.asked_by, q.principal_id]) FROM pm.questions q
    WHERE p_subject_type = 'question' AND q.id = p_subject_id
    UNION ALL
    SELECT gm.member_id FROM pm.questions q
    JOIN pm.group_members gm ON gm.group_id = q.asked_to_group
    WHERE p_subject_type = 'question' AND q.id = p_subject_id
    UNION ALL
    SELECT unnest(ARRAY[s.proposed_by, s.assigned_to]) FROM pm.task_suggestions s
    WHERE p_subject_type = 'suggestion' AND s.id = p_subject_id
    UNION ALL
    SELECT unnest(coalesce(p_also, '{}'))
  ) members
$$;

REVOKE ALL ON FUNCTION pm.webhook_event_members(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;

-- Webhooks: asked_to_group and principal_id join the question object when
-- set. A plain question's payload is byte for byte what it was.
CREATE OR REPLACE FUNCTION pm.emit_question_webhook()
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
    WHERE e.is_active AND e.events && ARRAY['question.asked', 'question.answered', 'question.cancelled']
  ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'open' AND NEW.deleted_at IS NULL THEN
      v_type := 'question.asked';
    END IF;
  ELSIF NEW.deleted_at IS NOT NULL THEN
    IF OLD.deleted_at IS NULL AND OLD.status = 'open' THEN
      v_type := 'question.cancelled';
    END IF;
  ELSIF OLD.deleted_at IS NOT NULL THEN
    IF NEW.status = 'open' THEN
      v_type := 'question.asked';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    v_type := CASE NEW.status
      WHEN 'open' THEN 'question.asked'
      WHEN 'answered' THEN 'question.answered'
      WHEN 'cancelled' THEN 'question.cancelled'
    END;
  END IF;
  IF v_type IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pm.emit_webhook_event(
    v_type,
    'question',
    NEW.id,
    ARRAY[NEW.project_id],
    pm.webhook_event_members('question', NEW.id),
    jsonb_build_object(
      'question', jsonb_build_object(
        'id', NEW.id,
        'project_id', NEW.project_id,
        'task_id', NEW.task_id,
        'asked_by', NEW.asked_by,
        'asked_to', NEW.asked_to,
        'question', NEW.question,
        'choices', NEW.choices,
        'allow_other', NEW.allow_other,
        'status', NEW.status,
        'answer_choice', NEW.answer_choice,
        'answer_text', NEW.answer_text,
        'answered_by', NEW.answered_by,
        'answered_at', NEW.answered_at,
        'cancelled_by', NEW.cancelled_by,
        'cancelled_at', NEW.cancelled_at,
        'expires_at', NEW.expires_at,
        'created_at', NEW.created_at,
        'updated_at', NEW.updated_at,
        'deleted_at', NEW.deleted_at
      ) || CASE WHEN NEW.kind = 'approval' THEN jsonb_build_object(
        'kind', NEW.kind,
        'action', NEW.action,
        'decision', CASE NEW.answer_choice WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' END,
        'decided_by', CASE WHEN NEW.status = 'answered' THEN NEW.answered_by END
      ) ELSE '{}'::jsonb END
        || CASE WHEN NEW.asked_to_group IS NOT NULL THEN jsonb_build_object('asked_to_group', NEW.asked_to_group) ELSE '{}'::jsonb END
        || CASE WHEN NEW.principal_id IS NOT NULL THEN jsonb_build_object('principal_id', NEW.principal_id) ELSE '{}'::jsonb END,
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

REVOKE ALL ON FUNCTION pm.emit_question_webhook() FROM PUBLIC, anon, authenticated;

-- A member of the group asked is a party to the question.
DROP POLICY IF EXISTS questions_select ON pm.questions;
CREATE POLICY questions_select ON pm.questions FOR SELECT TO authenticated
  USING (
    asked_by = pm.current_team_member_id()
    OR asked_to = pm.current_team_member_id()
    OR (asked_to_group IS NOT NULL AND EXISTS (SELECT 1 FROM pm.group_members gm WHERE gm.group_id = questions.asked_to_group AND gm.member_id = pm.current_team_member_id()))
    OR (task_id IS NOT NULL AND pm.can_access_task(task_id))
    OR (task_id IS NULL AND project_id IS NOT NULL AND pm.can_access_project(project_id))
  );

-- ---------------------------------------------------------------------------
-- Escalation to a group, and groups that own agents
-- ---------------------------------------------------------------------------
ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS agent_escalate_to_group uuid REFERENCES pm.groups(id) ON DELETE SET NULL;

COMMENT ON COLUMN pm.team_members.agent_escalate_to_group IS
  'An agent''s escalation group: any member answers its questions. agent_escalate_to (a person) comes first when both are set.';

CREATE TABLE IF NOT EXISTS pm.agent_owner_groups (
  agent_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES pm.groups(id) ON DELETE CASCADE,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, group_id)
);

COMMENT ON TABLE pm.agent_owner_groups IS
  'Groups responsible for an agent, beside its people (pm.agent_owners): any member manages it as an owner. Written by the server only.';

-- The agents a group owns.
CREATE INDEX IF NOT EXISTS idx_agent_owner_groups_group ON pm.agent_owner_groups (group_id);

CREATE OR REPLACE FUNCTION pm.handle_agent_owner_group_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pm.team_members m WHERE m.id = NEW.agent_id AND m.role = 'agent') THEN
    RAISE EXCEPTION 'Only an agent has owners' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.handle_agent_owner_group_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS agent_owner_groups_before_write ON pm.agent_owner_groups;
CREATE TRIGGER agent_owner_groups_before_write
  BEFORE INSERT OR UPDATE ON pm.agent_owner_groups
  FOR EACH ROW EXECUTE FUNCTION pm.handle_agent_owner_group_before_write();

ALTER TABLE pm.agent_owner_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_owner_groups_select ON pm.agent_owner_groups;
CREATE POLICY agent_owner_groups_select ON pm.agent_owner_groups FOR SELECT TO authenticated
  USING (pm.has_permission('team.read') OR agent_id = pm.current_team_member_id() OR EXISTS (SELECT 1 FROM pm.group_members gm WHERE gm.group_id = agent_owner_groups.group_id AND gm.member_id = pm.current_team_member_id()));

DROP POLICY IF EXISTS agent_owner_groups_module_on ON pm.agent_owner_groups;
CREATE POLICY agent_owner_groups_module_on ON pm.agent_owner_groups AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select pm.module_enabled('agents')));

REVOKE ALL ON pm.agent_owner_groups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.agent_owner_groups TO authenticated;
GRANT ALL ON pm.agent_owner_groups TO service_role;

-- ---------------------------------------------------------------------------
-- Linked identities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.member_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_id text NOT NULL,
  workspace_id text,
  handle text,
  verified_at timestamptz,
  verified_method text,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.member_identities DROP CONSTRAINT IF EXISTS member_identities_provider_shape;
ALTER TABLE pm.member_identities
  ADD CONSTRAINT member_identities_provider_shape CHECK (provider ~ '^(slack|teams|telegram|discord|github|email|custom\.[a-z0-9][a-z0-9_-]{0,39})$');
ALTER TABLE pm.member_identities DROP CONSTRAINT IF EXISTS member_identities_external_id_shape;
ALTER TABLE pm.member_identities
  ADD CONSTRAINT member_identities_external_id_shape CHECK (length(external_id) BETWEEN 1 AND 255 AND external_id = btrim(external_id));
ALTER TABLE pm.member_identities DROP CONSTRAINT IF EXISTS member_identities_workspace_id_length;
ALTER TABLE pm.member_identities
  ADD CONSTRAINT member_identities_workspace_id_length CHECK (workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 255);
ALTER TABLE pm.member_identities DROP CONSTRAINT IF EXISTS member_identities_handle_length;
ALTER TABLE pm.member_identities
  ADD CONSTRAINT member_identities_handle_length CHECK (handle IS NULL OR length(handle) BETWEEN 1 AND 255);
ALTER TABLE pm.member_identities DROP CONSTRAINT IF EXISTS member_identities_verified_method_check;
ALTER TABLE pm.member_identities
  ADD CONSTRAINT member_identities_verified_method_check CHECK (verified_method IS NULL OR verified_method IN ('link', 'admin', 'directory'));
ALTER TABLE pm.member_identities DROP CONSTRAINT IF EXISTS member_identities_verified_together;
ALTER TABLE pm.member_identities
  ADD CONSTRAINT member_identities_verified_together CHECK ((verified_at IS NULL) = (verified_method IS NULL));

COMMENT ON TABLE pm.member_identities IS
  'A member''s identities in other systems (Slack, Teams, Telegram, email, ...). Only verified ones resolve. Written by the server only.';
COMMENT ON COLUMN pm.member_identities.verified_method IS
  'How it was proven: link (the person confirmed it signed in), admin (an Owner or team manager linked it) or directory (a sync).';

-- One owner per identity (a null workspace counts as one workspace); a member's identities by provider.
CREATE UNIQUE INDEX IF NOT EXISTS member_identities_key
  ON pm.member_identities (provider, coalesce(workspace_id, ''), external_id);
CREATE INDEX IF NOT EXISTS idx_member_identities_member ON pm.member_identities (member_id, provider);

DROP TRIGGER IF EXISTS set_member_identities_updated_at ON pm.member_identities;
CREATE TRIGGER set_member_identities_updated_at
  BEFORE UPDATE ON pm.member_identities
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

ALTER TABLE pm.member_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_identities_select ON pm.member_identities;
CREATE POLICY member_identities_select ON pm.member_identities FOR SELECT TO authenticated
  USING (member_id = pm.current_team_member_id() OR pm.has_permission('team.manage'));

REVOKE ALL ON pm.member_identities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pm.member_identities TO authenticated;
GRANT ALL ON pm.member_identities TO service_role;

CREATE TABLE IF NOT EXISTS pm.identity_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  provider text NOT NULL,
  external_id text NOT NULL,
  workspace_id text,
  handle text,
  -- When set, only this member may confirm it.
  expected_member_id uuid REFERENCES pm.team_members(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES pm.team_members(id) ON DELETE CASCADE,
  requested_by_key_id uuid REFERENCES pm.api_keys(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.identity_link_requests DROP CONSTRAINT IF EXISTS identity_link_requests_token_hash_key;
ALTER TABLE pm.identity_link_requests
  ADD CONSTRAINT identity_link_requests_token_hash_key UNIQUE (token_hash);
ALTER TABLE pm.identity_link_requests DROP CONSTRAINT IF EXISTS identity_link_requests_provider_shape;
ALTER TABLE pm.identity_link_requests
  ADD CONSTRAINT identity_link_requests_provider_shape CHECK (provider ~ '^(slack|teams|telegram|discord|github|email|custom\.[a-z0-9][a-z0-9_-]{0,39})$');
ALTER TABLE pm.identity_link_requests DROP CONSTRAINT IF EXISTS identity_link_requests_external_id_length;
ALTER TABLE pm.identity_link_requests
  ADD CONSTRAINT identity_link_requests_external_id_length CHECK (length(external_id) BETWEEN 1 AND 255);

COMMENT ON TABLE pm.identity_link_requests IS
  'One-time links a harness asks for so a person proves an identity is theirs. Only the token''s hash is stored. Service role only.';

ALTER TABLE pm.identity_link_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.identity_link_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.identity_link_requests TO service_role;

-- ---------------------------------------------------------------------------
-- Delegation tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.delegation_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  agent_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  -- The identity it was minted for; unlinking it revokes the token.
  identity_id uuid REFERENCES pm.member_identities(id) ON DELETE CASCADE,
  minted_via text NOT NULL,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_by_key_id uuid REFERENCES pm.api_keys(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.delegation_tokens DROP CONSTRAINT IF EXISTS delegation_tokens_token_hash_key;
ALTER TABLE pm.delegation_tokens
  ADD CONSTRAINT delegation_tokens_token_hash_key UNIQUE (token_hash);
ALTER TABLE pm.delegation_tokens DROP CONSTRAINT IF EXISTS delegation_tokens_minted_via_check;
ALTER TABLE pm.delegation_tokens
  ADD CONSTRAINT delegation_tokens_minted_via_check CHECK (minted_via IN ('identity', 'session'));
ALTER TABLE pm.delegation_tokens DROP CONSTRAINT IF EXISTS delegation_tokens_not_self;
ALTER TABLE pm.delegation_tokens
  ADD CONSTRAINT delegation_tokens_not_self CHECK (agent_id <> principal_id);

COMMENT ON TABLE pm.delegation_tokens IS
  'Short-lived tokens that let one agent act for one person (X-Act-For). Only the hash is stored, so each can be revoked. Service role only.';

CREATE INDEX IF NOT EXISTS idx_delegation_tokens_agent ON pm.delegation_tokens (agent_id, principal_id);
CREATE INDEX IF NOT EXISTS idx_delegation_tokens_principal ON pm.delegation_tokens (principal_id);

ALTER TABLE pm.delegation_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.delegation_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.delegation_tokens TO service_role;

-- ---------------------------------------------------------------------------
-- On behalf of: principal_id on what an agent makes for someone
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_runs ADD COLUMN IF NOT EXISTS principal_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL;
ALTER TABLE pm.tasks ADD COLUMN IF NOT EXISTS principal_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL;
ALTER TABLE pm.agent_activities ADD COLUMN IF NOT EXISTS principal_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL;
ALTER TABLE pm.task_comments ADD COLUMN IF NOT EXISTS principal_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL;
ALTER TABLE pm.api_audit_log ADD COLUMN IF NOT EXISTS principal_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL;

COMMENT ON COLUMN pm.agent_runs.principal_id IS 'The person the agent acted for (X-Act-For); null when it acted as itself.';
COMMENT ON COLUMN pm.tasks.principal_id IS 'The person the agent that created it acted for (X-Act-For); null otherwise.';
COMMENT ON COLUMN pm.agent_activities.principal_id IS 'The person the agent acted for (X-Act-For); null when it acted as itself.';
COMMENT ON COLUMN pm.task_comments.principal_id IS 'The person the agent that wrote it acted for (X-Act-For); null otherwise.';
COMMENT ON COLUMN pm.api_audit_log.principal_id IS 'The person the API key''s agent acted for (X-Act-For); null when it acted as itself.';

-- What an agent did for one person.
CREATE INDEX IF NOT EXISTS idx_agent_runs_principal ON pm.agent_runs (principal_id, started_at DESC) WHERE principal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_audit_log_principal ON pm.api_audit_log (principal_id) WHERE principal_id IS NOT NULL;

-- The person the current write acts for: the x-actor-principal-id header the
-- server sends with an agent's write (service role only), else what the
-- server set on the row. A signed-in member's own write acts for no one.
-- Fixed once written.
CREATE OR REPLACE FUNCTION pm.stamp_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_header text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.principal_id := OLD.principal_id;
    RETURN NEW;
  END IF;
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    NEW.principal_id := NULL;
    RETURN NEW;
  END IF;
  BEGIN
    v_header := nullif(current_setting('request.headers', true), '')::json ->> 'x-actor-principal-id';
  EXCEPTION WHEN others THEN
    v_header := NULL;
  END;
  IF v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM pm.team_members m WHERE m.id = v_header::uuid) THEN
    NEW.principal_id := v_header::uuid;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.stamp_principal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stamp_principal ON pm.agent_runs;
CREATE TRIGGER stamp_principal BEFORE INSERT OR UPDATE OF principal_id ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_principal();
DROP TRIGGER IF EXISTS stamp_principal ON pm.questions;
CREATE TRIGGER stamp_principal BEFORE INSERT OR UPDATE OF principal_id ON pm.questions
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_principal();
DROP TRIGGER IF EXISTS stamp_principal ON pm.tasks;
CREATE TRIGGER stamp_principal BEFORE INSERT OR UPDATE OF principal_id ON pm.tasks
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_principal();
DROP TRIGGER IF EXISTS stamp_principal ON pm.agent_activities;
CREATE TRIGGER stamp_principal BEFORE INSERT OR UPDATE OF principal_id ON pm.agent_activities
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_principal();
DROP TRIGGER IF EXISTS stamp_principal ON pm.task_comments;
CREATE TRIGGER stamp_principal BEFORE INSERT OR UPDATE OF principal_id ON pm.task_comments
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_principal();
DROP TRIGGER IF EXISTS stamp_principal ON pm.api_audit_log;
CREATE TRIGGER stamp_principal BEFORE INSERT OR UPDATE OF principal_id ON pm.api_audit_log
  FOR EACH ROW EXECUTE FUNCTION pm.stamp_principal();

-- ---------------------------------------------------------------------------
-- Permissions: acting for someone belongs to AI agents; the rest are core
-- ---------------------------------------------------------------------------
INSERT INTO pm.permission_modules (permission_key, module_id) VALUES
  ('agents.act_for', 'agents')
ON CONFLICT (permission_key) DO UPDATE SET module_id = EXCLUDED.module_id;

-- ---------------------------------------------------------------------------
-- Live sync: open screens see groups, members and linked accounts change.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'groups') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.groups;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'group_members') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.group_members;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'pm' AND tablename = 'member_identities') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE pm.member_identities;
    END IF;
  END IF;
END $$;
