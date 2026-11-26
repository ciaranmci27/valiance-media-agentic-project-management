-- ============================================================
-- DELEGATION CHAIN (20261125001600_delegation_chain.sql)
-- Delegation at any depth: a person asks their personal agent, it hands
-- the work to a company agent, which hands pieces to specialists, all in
-- one run tree for that person. Subtasks stay one level deep: a whole
-- task can be handed over instead.
--
-- - pm.task_delegations.mode: how the task was handed over. subtask (as
--   before: a new subtask made for the receiver) or assign (an existing
--   task, top-level or not, handed to the receiver as it is). Existing
--   rows are subtasks.
-- - pm.task_delegations.from_task_id: the task the delegating run worked
--   on (for a subtask, its parent), so a task records the run and the task
--   it came from. Still one row per task: handing a task on again replaces
--   its row, and the runs keep the whole chain.
-- - pm.guard_run_chain, before a child run is stored: it sits at most 8
--   hand-offs below its root (agent_runs_chain_depth), and never under a
--   chain that loops (agent_runs_no_cycle). Runs already stored are
--   untouched. pm.stamp_run_lineage (root and person) is unchanged.
--
-- Additive and safe to run twice. The previous release's code writes
-- delegations without the new columns (they read as a subtask with no
-- source task); a child run past the depth limit is refused, which that
-- code reports as a failed run check (422).
-- ============================================================

-- ---------------------------------------------------------------------------
-- How a task was handed over, and where from
-- ---------------------------------------------------------------------------
ALTER TABLE pm.task_delegations ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'subtask';
ALTER TABLE pm.task_delegations ADD COLUMN IF NOT EXISTS from_task_id uuid REFERENCES pm.tasks(id) ON DELETE SET NULL;

ALTER TABLE pm.task_delegations DROP CONSTRAINT IF EXISTS task_delegations_mode_check;
ALTER TABLE pm.task_delegations
  ADD CONSTRAINT task_delegations_mode_check CHECK (mode IN ('subtask', 'assign'));

CREATE INDEX IF NOT EXISTS idx_task_delegations_from_task ON pm.task_delegations (from_task_id) WHERE from_task_id IS NOT NULL;

-- A subtask delegated before came from its parent.
UPDATE pm.task_delegations dl
SET from_task_id = t.parent_task_id
FROM pm.tasks t
WHERE t.id = dl.task_id AND dl.mode = 'subtask' AND dl.from_task_id IS NULL AND t.parent_task_id IS NOT NULL;

COMMENT ON TABLE pm.task_delegations IS
  'A task an agent handed to another agent (delegate_task), and the run that handed it over: a new subtask (mode subtask) or the task itself (mode assign). One row per task, replaced when it is handed on again. Written by the server only.';
COMMENT ON COLUMN pm.task_delegations.mode IS
  'subtask: a subtask made for the receiver. assign: an existing task handed to the receiver as it is.';
COMMENT ON COLUMN pm.task_delegations.from_task_id IS
  'The task the delegating run worked on (a subtask''s parent); null when the run had none.';

-- ---------------------------------------------------------------------------
-- Run chains: at most 8 hand-offs deep, never a loop
-- ---------------------------------------------------------------------------
-- A child run's parent is fixed once written (pm.stamp_run_lineage), so
-- only a new child can deepen a chain: walking up from its parent finds
-- how far below the root it would sit, and any loop links written around
-- the guards left behind.
CREATE OR REPLACE FUNCTION pm.guard_run_chain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_at uuid;
  v_depth integer := 1;
  v_seen uuid[];
BEGIN
  IF NEW.parent_run_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_seen := ARRAY[NEW.id, NEW.parent_run_id];
  SELECT r.parent_run_id INTO v_at FROM pm.agent_runs r WHERE r.id = NEW.parent_run_id;
  WHILE v_at IS NOT NULL LOOP
    IF v_at = ANY (v_seen) THEN
      RAISE EXCEPTION 'new row for relation "agent_runs" violates check constraint "agent_runs_no_cycle"'
        USING ERRCODE = '23514', DETAIL = 'A run cannot be its own ancestor.';
    END IF;
    v_depth := v_depth + 1;
    IF v_depth > 8 THEN
      RAISE EXCEPTION 'new row for relation "agent_runs" violates check constraint "agent_runs_chain_depth"'
        USING ERRCODE = '23514', DETAIL = 'A chain of runs goes at most 8 hand-offs below its root.';
    END IF;
    v_seen := v_seen || v_at;
    SELECT r.parent_run_id INTO v_at FROM pm.agent_runs r WHERE r.id = v_at;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.guard_run_chain() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_run_chain ON pm.agent_runs;
CREATE TRIGGER guard_run_chain BEFORE INSERT ON pm.agent_runs
  FOR EACH ROW WHEN (NEW.parent_run_id IS NOT NULL) EXECUTE FUNCTION pm.guard_run_chain();
