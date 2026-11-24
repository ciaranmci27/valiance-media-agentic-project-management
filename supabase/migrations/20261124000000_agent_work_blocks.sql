-- Agent work blocks: three building blocks so any company's agents (or
-- scripts) can find, take and finish work safely.
--
-- 1. Claims (work leases) on tasks: claimed_by, claimed_at, claim_expires_at.
--    pm.claim_task takes a task atomically (only when it is free, its claim
--    has run out, or the same member already holds it), pm.extend_task_claim
--    renews it and pm.release_task_claim clears it. A claim that has run out
--    frees the task by itself: readers treat claim_expires_at <= now() as
--    free, so no job is needed. Finishing a task (done) clears its claim.
--    claim_assigned says the claim itself assigned the holder (it picked up
--    unassigned work): releasing that claim unassigns the holder, and once it
--    runs out the task is back in the pool, so another member's claim moves
--    the assignment to them. Any later change to the holder's assignment (a
--    person or a PATCH) makes it a person's, which a claim never undoes.
--    pm.next_task_for_member picks the best task for a member.
-- 2. Incident keys on tasks: dedupe_key, occurrences, last_occurred_at. One
--    open task per (project, dedupe_key); pm.record_task_occurrence counts a
--    repeat on it. A repeat after the task is done makes a new task. A task
--    that is open again (reopened, restored from Trash, moved to another
--    project) gives up its key when another open task there holds it now.
-- 3. Per-agent rules on team_members (meaningful for agents, ignored for
--    people): agent_self_assign, agent_close_policy, agent_create_policy,
--    agent_escalate_to. The defaults reproduce the behaviour before them.
--
-- A task suggestion may now have no goal: an agent whose new tasks need
-- approval sends a suggestion, and a task need not belong to a goal.
--
-- Claims and occurrence counts are bookkeeping, not edits: they do not move a
-- task's updated_at (a claim does not; a repeat does, since it is news), mark
-- it unread, or write "Edited task" to the team activity log.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the new columns, and the functions are new (service role only).

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE pm.tasks
  ADD COLUMN IF NOT EXISTS claimed_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS occurrences integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_assigned boolean NOT NULL DEFAULT false;

ALTER TABLE pm.tasks DROP CONSTRAINT IF EXISTS tasks_dedupe_key_length;
ALTER TABLE pm.tasks
  ADD CONSTRAINT tasks_dedupe_key_length CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200);
ALTER TABLE pm.tasks DROP CONSTRAINT IF EXISTS tasks_occurrences_positive;
ALTER TABLE pm.tasks
  ADD CONSTRAINT tasks_occurrences_positive CHECK (occurrences >= 1);

COMMENT ON COLUMN pm.tasks.claimed_by IS
  'The member working on this task right now (a work lease). Free again once claim_expires_at has passed.';
COMMENT ON COLUMN pm.tasks.claim_expires_at IS
  'When the claim runs out unless the holder extends it. A past time means the task is free.';
COMMENT ON COLUMN pm.tasks.claim_assigned IS
  'The claim assigned its holder (it picked up unassigned work): releasing it unassigns the holder, and once it runs out another member may claim the task, which moves the assignment.';
COMMENT ON COLUMN pm.tasks.dedupe_key IS
  'An incident key: while this task is open, creating a task with the same key in the project counts a repeat here instead.';
COMMENT ON COLUMN pm.tasks.occurrences IS
  'How many times the incident behind this task happened (1 for a task without repeats).';

-- One open task per incident key in a project; a done or trashed task frees the key.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_open_dedupe_key
  ON pm.tasks (project_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status <> 'done' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by
  ON pm.tasks (claimed_by) WHERE claimed_by IS NOT NULL;

ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS agent_self_assign boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS agent_close_policy text NOT NULL DEFAULT 'close',
  ADD COLUMN IF NOT EXISTS agent_create_policy text NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS agent_escalate_to uuid REFERENCES pm.team_members(id) ON DELETE SET NULL;

ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_agent_close_policy_check;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_agent_close_policy_check CHECK (agent_close_policy IN ('close', 'review'));
ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_agent_create_policy_check;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_agent_create_policy_check CHECK (agent_create_policy IN ('live', 'approval'));
ALTER TABLE pm.team_members DROP CONSTRAINT IF EXISTS team_members_agent_escalate_not_self;
ALTER TABLE pm.team_members
  ADD CONSTRAINT team_members_agent_escalate_not_self CHECK (agent_escalate_to IS DISTINCT FROM id);

COMMENT ON COLUMN pm.team_members.agent_self_assign IS
  'Agents only: may pick up (claim) unassigned work, which assigns it to them.';
COMMENT ON COLUMN pm.team_members.agent_close_policy IS
  'Agents only: close (setting done finishes the task) or review (done moves the task to in_review instead).';
COMMENT ON COLUMN pm.team_members.agent_create_policy IS
  'Agents only: live (new tasks go live) or approval (a new task becomes a task suggestion to approve).';
COMMENT ON COLUMN pm.team_members.agent_escalate_to IS
  'Agents only: who this agent escalates to. Unset: the Owner.';

ALTER TABLE pm.task_suggestions ALTER COLUMN goal_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- Claims and repeats are bookkeeping, not edits
-- ---------------------------------------------------------------------------

-- Finishing a task also ends its claim (its assignment stays). Claims never
-- move updated_at. A task that is open again (reopened, restored from Trash,
-- moved to another project) gives up its incident key when another open task
-- in its project holds it now: that one keeps counting the repeats. Security
-- definer so it sees that task whoever makes the change.
CREATE OR REPLACE FUNCTION pm.handle_task_before_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF new.status = 'done' AND old.status IS DISTINCT FROM 'done' THEN
    new.completed_at = now();
    new.claimed_by = NULL;
    new.claimed_at = NULL;
    new.claim_expires_at = NULL;
    new.claim_assigned = false;
  ELSIF new.status IS DISTINCT FROM 'done' THEN
    new.completed_at = NULL;
  END IF;

  IF new.dedupe_key IS NOT NULL AND new.status <> 'done' AND new.deleted_at IS NULL
     AND (old.status = 'done' OR old.deleted_at IS NOT NULL OR new.project_id IS DISTINCT FROM old.project_id)
     AND EXISTS (
       SELECT 1 FROM pm.tasks t
       WHERE t.project_id = new.project_id AND t.dedupe_key = new.dedupe_key
         AND t.status <> 'done' AND t.deleted_at IS NULL AND t.id <> new.id
     ) THEN
    new.dedupe_key = NULL;
  END IF;

  IF (to_jsonb(new) - ARRAY['sort_order', 'updated_at', 'claimed_by', 'claimed_at', 'claim_expires_at', 'claim_assigned'])
     IS DISTINCT FROM (to_jsonb(old) - ARRAY['sort_order', 'updated_at', 'claimed_by', 'claimed_at', 'claim_expires_at', 'claim_assigned']) THEN
    new.updated_at = now();
  ELSE
    new.updated_at = old.updated_at;
  END IF;

  RETURN new;
END;
$$;

-- Any change to the claim holder's own assignment (a person or a PATCH
-- removing or adding them) makes it a person's: claim_assigned clears, so no
-- claim undoes it. The claim functions set it again after their own changes.
CREATE OR REPLACE FUNCTION pm.forget_claim_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE pm.tasks SET claim_assigned = false
    WHERE id = OLD.task_id AND claim_assigned AND claimed_by = OLD.member_id;
  ELSE
    UPDATE pm.tasks SET claim_assigned = false
    WHERE id = NEW.task_id AND claim_assigned AND claimed_by = NEW.member_id;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.forget_claim_assignment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS forget_claim_assignment ON pm.task_assignees;
CREATE TRIGGER forget_claim_assignment
  AFTER INSERT OR DELETE ON pm.task_assignees
  FOR EACH ROW EXECUTE FUNCTION pm.forget_claim_assignment();

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
    v_ignore := v_ignore || ARRAY['project_id', 'project_goal_id'];
  END IF;
  v_fields := pm.activity_changed_fields(to_jsonb(NEW), to_jsonb(OLD), v_ignore);
  IF cardinality(v_fields) > 0 THEN
    PERFORM pm.log_team_activity('task.updated', 'task', NEW.id::text, NEW.project_id,
      format('Edited task "%s"', NEW.title), v_meta || jsonb_build_object('fields', to_jsonb(v_fields)));
  END IF;
  RETURN NULL;
END;
$$;

-- The task's own fields. Reordering, the completion stamp, Trash, the source
-- stamp, claims and repeat counts are not changes anyone needs to read.
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
    v_ignore := v_ignore || ARRAY['project_id', 'project_goal_id'];
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
-- Claims
-- ---------------------------------------------------------------------------

-- Who holds a task's claim, for a refusal that says who and until when.
CREATE OR REPLACE FUNCTION pm.task_claim_holder(p_task pm.tasks)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'member_id', p_task.claimed_by,
    'member_name', (SELECT m.name FROM pm.team_members m WHERE m.id = p_task.claimed_by),
    'claimed_at', p_task.claimed_at,
    'expires_at', p_task.claim_expires_at
  )
$$;

REVOKE ALL ON FUNCTION pm.task_claim_holder(pm.tasks) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.task_claim_holder(pm.tasks) TO service_role;

-- Takes a task for p_member_id for p_lease_minutes (1 to 240), atomically:
-- only when nobody holds a live claim on it, or the same member already does
-- (then it renews and keeps claimed_at). A previous holder's claim that ran
-- out takes the assignment it made with it. p_assign also assigns the task to
-- the member (claim_assigned), only while nobody else is assigned. Who may
-- claim is decided by the caller (the API) before this runs. Outcomes:
-- claimed, renewed, held (someone else holds it: holder says who and until
-- when), assigned_elsewhere, not_found.
CREATE OR REPLACE FUNCTION pm.claim_task(
  p_task_id uuid,
  p_member_id uuid,
  p_lease_minutes integer DEFAULT 30,
  p_assign boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task pm.tasks;
  v_renew boolean;
  v_same boolean;
  v_drop_previous boolean;
BEGIN
  IF p_member_id IS NULL THEN
    RAISE EXCEPTION 'A claim needs a member' USING ERRCODE = '22023';
  END IF;
  IF p_lease_minutes IS NULL OR p_lease_minutes < 1 OR p_lease_minutes > 240 THEN
    RAISE EXCEPTION 'A claim lasts 1 to 240 minutes' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task FROM pm.tasks WHERE id = p_task_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_task.claimed_by IS NOT NULL AND v_task.claimed_by <> p_member_id AND v_task.claim_expires_at > now() THEN
    RETURN jsonb_build_object('outcome', 'held', 'holder', pm.task_claim_holder(v_task));
  END IF;
  v_same := v_task.claimed_by IS NOT DISTINCT FROM p_member_id;
  v_renew := v_same AND v_task.claim_expires_at > now();
  -- Someone else's claim is over here; an assignment it made goes with it.
  v_drop_previous := v_task.claimed_by IS NOT NULL AND NOT v_same AND v_task.claim_assigned;
  IF p_assign AND EXISTS (
    SELECT 1 FROM pm.task_assignees
    WHERE task_id = p_task_id AND member_id <> p_member_id
      AND NOT (v_drop_previous AND member_id = v_task.claimed_by)
  ) THEN
    RETURN jsonb_build_object('outcome', 'assigned_elsewhere');
  END IF;
  IF v_drop_previous THEN
    DELETE FROM pm.task_assignees WHERE task_id = p_task_id AND member_id = v_task.claimed_by;
  END IF;
  IF p_assign THEN
    INSERT INTO pm.task_assignees (task_id, member_id) VALUES (p_task_id, p_member_id)
    ON CONFLICT (task_id, member_id) DO NOTHING;
  END IF;
  UPDATE pm.tasks SET
    claimed_by = p_member_id,
    claimed_at = CASE WHEN v_renew THEN v_task.claimed_at ELSE now() END,
    claim_expires_at = now() + make_interval(mins => p_lease_minutes),
    claim_assigned = CASE WHEN v_same THEN v_task.claim_assigned OR p_assign ELSE p_assign END
  WHERE id = p_task_id
  RETURNING * INTO v_task;
  RETURN jsonb_build_object('outcome', CASE WHEN v_renew THEN 'renewed' ELSE 'claimed' END, 'task', to_jsonb(v_task));
END;
$$;

REVOKE ALL ON FUNCTION pm.claim_task(uuid, uuid, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.claim_task(uuid, uuid, integer, boolean) TO service_role;

-- The holder renews its claim for p_lease_minutes from now (a heartbeat).
-- Outcomes: extended, held (someone else holds it now), not_held (nobody
-- does: claim it again), not_found.
CREATE OR REPLACE FUNCTION pm.extend_task_claim(
  p_task_id uuid,
  p_member_id uuid,
  p_lease_minutes integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task pm.tasks;
BEGIN
  IF p_lease_minutes IS NULL OR p_lease_minutes < 1 OR p_lease_minutes > 240 THEN
    RAISE EXCEPTION 'A claim lasts 1 to 240 minutes' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task FROM pm.tasks WHERE id = p_task_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_task.claimed_by IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_held');
  END IF;
  IF v_task.claimed_by <> p_member_id THEN
    IF v_task.claim_expires_at > now() THEN
      RETURN jsonb_build_object('outcome', 'held', 'holder', pm.task_claim_holder(v_task));
    END IF;
    RETURN jsonb_build_object('outcome', 'not_held');
  END IF;
  -- Still theirs (nobody took it since it ran out, if it did): renew it.
  UPDATE pm.tasks SET claim_expires_at = now() + make_interval(mins => p_lease_minutes)
  WHERE id = p_task_id
  RETURNING * INTO v_task;
  RETURN jsonb_build_object('outcome', 'extended', 'task', to_jsonb(v_task));
END;
$$;

REVOKE ALL ON FUNCTION pm.extend_task_claim(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.extend_task_claim(uuid, uuid, integer) TO service_role;

-- Ends a claim. The holder may; p_force lets a manager end anyone's. An
-- assignment the claim made (claim_assigned) is removed with it, so the task
-- goes back unassigned; a person's assignment stays. Outcomes: released
-- (holder says whose it was), not_claimed (no live claim, though one that ran
-- out is cleared the same way for its holder or a manager), held (someone
-- else's live claim and no p_force), not_found. unassigned says whether the
-- holder's assignment went.
CREATE OR REPLACE FUNCTION pm.release_task_claim(
  p_task_id uuid,
  p_member_id uuid,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task pm.tasks;
  v_holder jsonb;
  v_live boolean;
  v_unassigned boolean := false;
BEGIN
  SELECT * INTO v_task FROM pm.tasks WHERE id = p_task_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_task.claimed_by IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_claimed', 'unassigned', false, 'task', to_jsonb(v_task));
  END IF;
  v_live := v_task.claim_expires_at > now();
  IF v_task.claimed_by <> p_member_id AND NOT coalesce(p_force, false) THEN
    IF v_live THEN
      RETURN jsonb_build_object('outcome', 'held', 'holder', pm.task_claim_holder(v_task));
    END IF;
    -- Someone else's claim that ran out: left for them, a manager or the next claim.
    RETURN jsonb_build_object('outcome', 'not_claimed', 'unassigned', false, 'task', to_jsonb(v_task));
  END IF;
  v_holder := pm.task_claim_holder(v_task);
  IF v_task.claim_assigned THEN
    DELETE FROM pm.task_assignees WHERE task_id = p_task_id AND member_id = v_task.claimed_by;
    v_unassigned := true;
  END IF;
  UPDATE pm.tasks SET claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, claim_assigned = false
  WHERE id = p_task_id
  RETURNING * INTO v_task;
  RETURN jsonb_build_object('outcome', CASE WHEN v_live THEN 'released' ELSE 'not_claimed' END,
    'holder', v_holder, 'unassigned', v_unassigned, 'task', to_jsonb(v_task));
END;
$$;

REVOKE ALL ON FUNCTION pm.release_task_claim(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.release_task_claim(uuid, uuid, boolean) TO service_role;

-- The best task for a member to work on next, or no row. Tasks assigned to
-- them first; then, with p_include_unassigned, unassigned tasks meant for them
-- (an agent: ai_readiness ai_ready only; a person: not meant for an agent).
-- A task whose only assignee came from someone else's claim that ran out
-- counts as unassigned: it is back in the pool.
-- Left out: backlog, in review and done; Trash (the task, its parent, its
-- project); projects that are not active; unmet blockers (a blocker that is
-- not done and not in Trash); a live claim by someone else. Then by priority,
-- due date (none last) and age. p_project_ids is the projects the member may
-- open (NULL: every project); p_project_id narrows it to one.
CREATE OR REPLACE FUNCTION pm.next_task_for_member(
  p_member_id uuid,
  p_project_ids uuid[] DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_include_unassigned boolean DEFAULT false,
  p_as_agent boolean DEFAULT true
)
RETURNS TABLE (task_id uuid, assigned boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.id, mine.assigned
  FROM pm.tasks t
  JOIN pm.projects p ON p.id = t.project_id
  CROSS JOIN LATERAL (
    SELECT EXISTS (SELECT 1 FROM pm.task_assignees a WHERE a.task_id = t.id AND a.member_id = p_member_id) AS assigned,
           EXISTS (SELECT 1 FROM pm.task_assignees a WHERE a.task_id = t.id) AS anyone
  ) mine
  WHERE t.deleted_at IS NULL
    AND t.status IN ('todo', 'in_progress')
    AND p.deleted_at IS NULL
    AND p.status = 'active'
    AND p.archived_at IS NULL
    AND (p_project_ids IS NULL OR t.project_id = ANY (p_project_ids))
    AND (p_project_id IS NULL OR t.project_id = p_project_id)
    AND (t.parent_task_id IS NULL OR EXISTS (
      SELECT 1 FROM pm.tasks parent WHERE parent.id = t.parent_task_id AND parent.deleted_at IS NULL))
    AND NOT EXISTS (
      SELECT 1 FROM pm.task_dependencies d JOIN pm.tasks b ON b.id = d.blocked_by_task_id
      WHERE d.task_id = t.id AND b.deleted_at IS NULL AND b.status <> 'done')
    AND (t.claimed_by IS NULL OR t.claimed_by = p_member_id OR t.claim_expires_at IS NULL OR t.claim_expires_at <= now())
    AND (
      mine.assigned
      OR (p_include_unassigned AND (NOT mine.anyone OR (
            t.claim_assigned AND t.claimed_by <> p_member_id AND t.claim_expires_at <= now()
            AND NOT EXISTS (SELECT 1 FROM pm.task_assignees a WHERE a.task_id = t.id AND a.member_id <> t.claimed_by)
          )) AND CASE
            WHEN p_as_agent THEN t.ai_readiness IS NOT DISTINCT FROM 'ai_ready'
            ELSE t.ai_readiness IS NULL OR t.ai_readiness = 'human_only'
          END)
    )
  ORDER BY mine.assigned DESC,
    CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
    t.due_date ASC NULLS LAST,
    t.created_at ASC,
    t.id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION pm.next_task_for_member(uuid, uuid[], uuid, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.next_task_for_member(uuid, uuid[], uuid, boolean, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Incident keys
-- ---------------------------------------------------------------------------

-- Counts a repeat on the open task holding p_dedupe_key in the project and
-- returns it, or NULL when no open task holds the key.
CREATE OR REPLACE FUNCTION pm.record_task_occurrence(p_project_id uuid, p_dedupe_key text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH repeated AS (
    UPDATE pm.tasks
    SET occurrences = occurrences + 1, last_occurred_at = now()
    WHERE project_id = p_project_id
      AND dedupe_key = p_dedupe_key
      AND status <> 'done'
      AND deleted_at IS NULL
    RETURNING *
  )
  SELECT to_jsonb(repeated) FROM repeated
$$;

REVOKE ALL ON FUNCTION pm.record_task_occurrence(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.record_task_occurrence(uuid, text) TO service_role;
