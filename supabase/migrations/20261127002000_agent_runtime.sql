-- Agent runtime: what a pool of workers behind one agent needs from core.
--
-- - Instances: agent_runs.instance_id (which worker runs it), and
--   pm.agent_instances (one row per worker that beats or reports), so an
--   agent's detail says how many workers are live ("3 working now").
-- - Resume notes and blocked runs: agent_runs.resume_notes (where a worker
--   picking the run up again starts), blocked_at and blocked_reason (a run
--   that cannot go on without a person, surfaced on Needs you for its
--   managers and the task's people through pm.my_blocked_runs until it moves).
-- - A spend limit per run: agent_limits.max_run_spend_cents.
-- - Chat claims: a lease on a chat message (chat_messages.claim_*) or a whole
--   conversation (pm.chat_conversations), held by an agent and, optionally,
--   one of its workers (instance). pm.chat_claim claims, extends and
--   releases; a lapsed lease is no lease. New inbound requests are linked to
--   their conversation (one per DM, per channel thread) by a trigger.
-- - Answers that do the thing: questions.performs (an action from the app's
--   whitelist the answer performs, as whoever answers) and performed (what
--   happened). Orchestrator routing: questions.requested_to and
--   requested_to_group (whom the agent asked, when the question went to its
--   orchestrator first) and team_members.ask_people_directly.
-- - Host keys: permission agents.host (AI agents module) and
--   api_keys.host_agent_ids, the agents a host key serves; the host feed
--   reads those agents' events (pm.event_feed_read_host).
--
-- Additive and safe to run twice. 2.0.50 code never reads the new columns
-- and tables; the replaced feed triggers only add fields to what they wrote.

-- ---------------------------------------------------------------------------
-- Runs: instance, resume notes, blocked
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_runs
  ADD COLUMN IF NOT EXISTS instance_id text,
  ADD COLUMN IF NOT EXISTS resume_notes text,
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_reason text;

ALTER TABLE pm.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_runtime_shape;
ALTER TABLE pm.agent_runs
  ADD CONSTRAINT agent_runs_runtime_shape CHECK (
    (instance_id IS NULL OR instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$')
    AND (resume_notes IS NULL OR length(resume_notes) <= 8000)
    AND (blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND 500)
    AND (blocked_reason IS NULL OR blocked_at IS NOT NULL)
  );

COMMENT ON COLUMN pm.agent_runs.instance_id IS
  'The worker of the agent running it (a harness''s own instance id), when it runs several. Null: the agent itself.';
COMMENT ON COLUMN pm.agent_runs.resume_notes IS
  'Where to pick the run up again (written by the agent, replaced each time, at most 8000 characters).';
COMMENT ON COLUMN pm.agent_runs.blocked_at IS
  'Set while the run cannot go on without a person (with blocked_reason); cleared when it moves.';

CREATE INDEX IF NOT EXISTS idx_agent_runs_live_instances
  ON pm.agent_runs (agent_id, instance_id) WHERE status = 'running' AND instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_runs_blocked
  ON pm.agent_runs (blocked_at) WHERE blocked_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Instances: the workers behind an agent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.agent_instances (
  agent_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  working boolean NOT NULL DEFAULT false,
  turn_started_at timestamptz,
  status_note text,
  expected_interval_seconds integer NOT NULL DEFAULT 60,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, instance_id)
);

ALTER TABLE pm.agent_instances DROP CONSTRAINT IF EXISTS agent_instances_shape;
ALTER TABLE pm.agent_instances
  ADD CONSTRAINT agent_instances_shape CHECK (
    instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
    AND (status_note IS NULL OR length(status_note) <= 280)
    AND expected_interval_seconds BETWEEN 30 AND 86400
  );

COMMENT ON TABLE pm.agent_instances IS
  'One row per worker of an agent that reported (a heartbeat or a fleet report with instance_id). Live while last_seen_at is within two missed beats plus a minute. Server only.';

CREATE INDEX IF NOT EXISTS idx_agent_instances_seen ON pm.agent_instances (agent_id, last_seen_at DESC);

ALTER TABLE pm.agent_instances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.agent_instances FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.agent_instances TO service_role;

-- ---------------------------------------------------------------------------
-- Limits: spend per run
-- ---------------------------------------------------------------------------
ALTER TABLE pm.agent_limits
  ADD COLUMN IF NOT EXISTS max_run_spend_cents integer;

ALTER TABLE pm.agent_limits DROP CONSTRAINT IF EXISTS agent_limits_run_spend;
ALTER TABLE pm.agent_limits
  ADD CONSTRAINT agent_limits_run_spend CHECK (max_run_spend_cents IS NULL OR max_run_spend_cents BETWEEN 1 AND 1000000000);

COMMENT ON COLUMN pm.agent_limits.max_run_spend_cents IS
  'The most one run may spend, in US cents. A run reported past it is stopped (cancelled) and a start past it refused.';

-- ---------------------------------------------------------------------------
-- Chat: conversations and claims
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES pm.chat_connections(id) ON DELETE CASCADE,
  -- The provider's conversation (a DM, a channel) and the thread in it ('' for none).
  conversation_id text NOT NULL,
  thread_key text NOT NULL DEFAULT '',
  -- The lease: an agent and, optionally, one of its workers.
  holder_agent_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  holder_instance text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  -- The running summary its agents keep.
  summary text,
  summary_updated_at timestamptz,
  summary_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_shape;
ALTER TABLE pm.chat_conversations
  ADD CONSTRAINT chat_conversations_shape CHECK (
    length(conversation_id) BETWEEN 1 AND 255
    AND length(thread_key) <= 255
    AND (holder_instance IS NULL OR holder_instance ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$')
    AND (summary IS NULL OR length(summary) <= 4000)
  );

COMMENT ON TABLE pm.chat_conversations IS
  'A chat conversation (a DM, or a thread in a channel) its agents can claim as a whole and keep a running summary of. Server only.';

CREATE UNIQUE INDEX IF NOT EXISTS chat_conversations_key
  ON pm.chat_conversations (connection_id, conversation_id, thread_key);

ALTER TABLE pm.chat_conversations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.chat_conversations FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.chat_conversations TO service_role;

ALTER TABLE pm.chat_messages
  ADD COLUMN IF NOT EXISTS chat_conversation_id uuid REFERENCES pm.chat_conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claim_instance text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

ALTER TABLE pm.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_claim_shape;
ALTER TABLE pm.chat_messages
  ADD CONSTRAINT chat_messages_claim_shape CHECK (claim_instance IS NULL OR claim_instance ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$');

COMMENT ON COLUMN pm.chat_messages.claim_expires_at IS
  'A lease on the message by its agent (and claim_instance, one of its workers) until then; a lapsed lease is no lease.';

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_conversation
  ON pm.chat_messages (chat_conversation_id, created_at) WHERE chat_conversation_id IS NOT NULL;

-- Where a message sits: its thread; a top-level message in a company channel
-- starts its own thread; anything else (a DM, a personal chat) is the whole conversation.
CREATE OR REPLACE FUNCTION pm.chat_thread_key(p_connection uuid, p_thread text, p_external text, p_is_direct boolean)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pm
AS $$
  SELECT CASE
    WHEN p_thread IS NOT NULL AND p_thread <> '' THEN p_thread
    WHEN coalesce(p_is_direct, false) THEN ''
    WHEN p_external IS NOT NULL AND (SELECT c.kind FROM pm.chat_connections c WHERE c.id = p_connection) = 'company' THEN p_external
    ELSE ''
  END
$$;

REVOKE ALL ON FUNCTION pm.chat_thread_key(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.chat_thread_key(uuid, text, text, boolean) TO service_role;

-- The conversation a message belongs to: found, or (create true) made.
CREATE OR REPLACE FUNCTION pm.chat_conversation_of(p_connection uuid, p_conversation text, p_thread_key text, p_create boolean)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT c.id INTO v_id FROM pm.chat_conversations c
  WHERE c.connection_id = p_connection AND c.conversation_id = p_conversation AND c.thread_key = coalesce(p_thread_key, '');
  IF v_id IS NOT NULL OR NOT p_create THEN
    RETURN v_id;
  END IF;
  INSERT INTO pm.chat_conversations (connection_id, conversation_id, thread_key)
  VALUES (p_connection, p_conversation, coalesce(p_thread_key, ''))
  ON CONFLICT (connection_id, conversation_id, thread_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT c.id INTO v_id FROM pm.chat_conversations c
    WHERE c.connection_id = p_connection AND c.conversation_id = p_conversation AND c.thread_key = coalesce(p_thread_key, '');
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION pm.chat_conversation_of(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.chat_conversation_of(uuid, text, text, boolean) TO service_role;

-- A new inbound message routed to an agent joins its conversation: a request
-- makes one if none exists; context joins one only when it is already there.
CREATE OR REPLACE FUNCTION pm.link_chat_conversation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pm
AS $$
BEGIN
  IF NEW.direction <> 'inbound' OR NEW.chat_conversation_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  NEW.chat_conversation_id := pm.chat_conversation_of(
    NEW.connection_id, NEW.conversation_id,
    pm.chat_thread_key(NEW.connection_id, NEW.thread_id, NEW.external_message_id, NEW.is_direct),
    NEW.agent_id IS NOT NULL AND coalesce(NEW.is_request, true));
  IF NEW.chat_conversation_id IS NOT NULL THEN
    UPDATE pm.chat_conversations SET last_message_at = now() WHERE id = NEW.chat_conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.link_chat_conversation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS link_chat_conversation ON pm.chat_messages;
CREATE TRIGGER link_chat_conversation
  BEFORE INSERT ON pm.chat_messages
  FOR EACH ROW EXECUTE FUNCTION pm.link_chat_conversation();

-- A message recorded before this update: its conversation, made on first use.
CREATE OR REPLACE FUNCTION pm.ensure_chat_conversation(p_message_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_row pm.chat_messages%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_row FROM pm.chat_messages WHERE id = p_message_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_row.chat_conversation_id IS NOT NULL THEN
    RETURN v_row.chat_conversation_id;
  END IF;
  v_id := pm.chat_conversation_of(v_row.connection_id, v_row.conversation_id,
    pm.chat_thread_key(v_row.connection_id, v_row.thread_id, v_row.external_message_id, v_row.is_direct), true);
  UPDATE pm.chat_messages SET chat_conversation_id = v_id WHERE id = p_message_id AND chat_conversation_id IS NULL;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION pm.ensure_chat_conversation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.ensure_chat_conversation(uuid) TO service_role;

-- Claims, extends or releases a lease on a chat message (routed to p_agent)
-- or a conversation (one with a message routed to p_agent), as task claims
-- do. The holder is the agent and its worker (p_instance, null for the
-- agent itself); a lease past its time is no lease. Answers { outcome,
-- holder?, expired?, expired_at? }: claimed, renewed, extended, released,
-- held (someone else holds it), not_held, not_claimed, done (a message
-- already replied or handled) or not_found.
CREATE OR REPLACE FUNCTION pm.chat_claim(p_subject text, p_id uuid, p_agent uuid, p_instance text, p_action text, p_lease_minutes integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_lease interval := make_interval(mins => least(greatest(coalesce(p_lease_minutes, 30), 1), 240));
  v_agent uuid;
  v_instance text;
  v_claimed_at timestamptz;
  v_expires timestamptz;
  v_status text;
  v_live boolean;
  v_mine boolean;
  v_holder jsonb;
BEGIN
  IF p_subject NOT IN ('message', 'conversation') OR p_action NOT IN ('claim', 'extend', 'release') THEN
    RAISE EXCEPTION 'chat_claim: unknown subject or action' USING ERRCODE = '22023';
  END IF;
  IF p_subject = 'message' THEN
    SELECT m.agent_id, m.claim_instance, m.claimed_at, m.claim_expires_at, m.status
      INTO v_agent, v_instance, v_claimed_at, v_expires, v_status
    FROM pm.chat_messages m
    WHERE m.id = p_id AND m.direction = 'inbound' AND m.agent_id = p_agent
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'not_found');
    END IF;
  ELSE
    SELECT c.holder_agent_id, c.holder_instance, c.claimed_at, c.claim_expires_at
      INTO v_agent, v_instance, v_claimed_at, v_expires
    FROM pm.chat_conversations c
    WHERE c.id = p_id
      AND EXISTS (SELECT 1 FROM pm.chat_messages m WHERE m.chat_conversation_id = c.id AND m.direction = 'inbound' AND m.agent_id = p_agent)
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'not_found');
    END IF;
  END IF;

  v_live := v_expires IS NOT NULL AND v_expires > v_now AND v_agent IS NOT NULL;
  v_mine := v_live AND v_agent = p_agent AND v_instance IS NOT DISTINCT FROM p_instance;
  v_holder := CASE WHEN v_live THEN jsonb_build_object(
    'agent_id', v_agent,
    'agent_name', (SELECT t.name FROM pm.team_members t WHERE t.id = v_agent),
    'instance_id', v_instance,
    'claimed_at', v_claimed_at,
    'expires_at', v_expires) END;

  IF p_action = 'claim' THEN
    IF p_subject = 'message' AND v_status IN ('replied', 'handled') THEN
      RETURN jsonb_build_object('outcome', 'done', 'status', v_status);
    END IF;
    IF v_live AND NOT v_mine THEN
      RETURN jsonb_build_object('outcome', 'held', 'holder', v_holder);
    END IF;
    IF p_subject = 'message' THEN
      UPDATE pm.chat_messages
        SET claim_instance = p_instance, claimed_at = CASE WHEN v_mine THEN claimed_at ELSE v_now END, claim_expires_at = v_now + v_lease
      WHERE id = p_id;
    ELSE
      UPDATE pm.chat_conversations
        SET holder_agent_id = p_agent, holder_instance = p_instance,
            claimed_at = CASE WHEN v_mine THEN claimed_at ELSE v_now END, claim_expires_at = v_now + v_lease
      WHERE id = p_id;
    END IF;
    RETURN jsonb_build_object('outcome', CASE WHEN v_mine THEN 'renewed' ELSE 'claimed' END,
      'claimed_at', CASE WHEN v_mine THEN v_claimed_at ELSE v_now END, 'expires_at', v_now + v_lease);
  END IF;

  IF p_action = 'extend' THEN
    IF v_mine THEN
      IF p_subject = 'message' THEN
        UPDATE pm.chat_messages SET claim_expires_at = v_now + v_lease WHERE id = p_id;
      ELSE
        UPDATE pm.chat_conversations SET claim_expires_at = v_now + v_lease WHERE id = p_id;
      END IF;
      RETURN jsonb_build_object('outcome', 'extended', 'claimed_at', v_claimed_at, 'expires_at', v_now + v_lease);
    END IF;
    IF v_live THEN
      RETURN jsonb_build_object('outcome', 'held', 'holder', v_holder);
    END IF;
    IF v_expires IS NOT NULL AND v_agent = p_agent AND v_instance IS NOT DISTINCT FROM p_instance THEN
      RETURN jsonb_build_object('outcome', 'not_held', 'expired', true, 'expired_at', v_expires);
    END IF;
    RETURN jsonb_build_object('outcome', 'not_claimed');
  END IF;

  -- release
  IF v_live AND NOT v_mine THEN
    RETURN jsonb_build_object('outcome', 'held', 'holder', v_holder);
  END IF;
  IF p_subject = 'message' THEN
    UPDATE pm.chat_messages SET claim_instance = NULL, claimed_at = NULL, claim_expires_at = NULL WHERE id = p_id;
  ELSE
    UPDATE pm.chat_conversations SET holder_agent_id = NULL, holder_instance = NULL, claimed_at = NULL, claim_expires_at = NULL WHERE id = p_id;
  END IF;
  RETURN jsonb_build_object('outcome', CASE WHEN v_mine THEN 'released' ELSE 'not_claimed' END);
END;
$$;

REVOKE ALL ON FUNCTION pm.chat_claim(text, uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.chat_claim(text, uuid, uuid, text, text, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Questions: answers that do the thing, orchestrator routing
-- ---------------------------------------------------------------------------
ALTER TABLE pm.questions
  ADD COLUMN IF NOT EXISTS performs jsonb,
  ADD COLUMN IF NOT EXISTS performed jsonb,
  ADD COLUMN IF NOT EXISTS requested_to uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requested_to_group uuid REFERENCES pm.groups(id) ON DELETE SET NULL;

ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_performs_shape;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_performs_shape CHECK (
    (performs IS NULL OR coalesce(
      jsonb_typeof(performs) = 'object'
      AND jsonb_typeof(performs->'type') = 'string'
      AND jsonb_typeof(performs->'on_choice') = 'string'
      AND length(performs::text) <= 8000, false))
    AND (performed IS NULL OR (jsonb_typeof(performed) = 'object' AND length(performed::text) <= 8000))
  );

COMMENT ON COLUMN pm.questions.performs IS
  'An action from the app''s whitelist the answer performs, as whoever answers: { type, details, on_choice }.';
COMMENT ON COLUMN pm.questions.performed IS
  'What the performed action did: { type, status done, by, at, result }.';
COMMENT ON COLUMN pm.questions.requested_to IS
  'Whom the asking agent named, when the question went to its orchestrator first (team_members.ask_people_directly off).';

ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS ask_people_directly boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pm.team_members.ask_people_directly IS
  'An agent with an orchestrator: true sends its questions to people directly; false (the default) sends them to its orchestrator first.';

-- ---------------------------------------------------------------------------
-- Host keys
-- ---------------------------------------------------------------------------
ALTER TABLE pm.api_keys
  ADD COLUMN IF NOT EXISTS host_agent_ids uuid[];

COMMENT ON COLUMN pm.api_keys.host_agent_ids IS
  'A host key (scope agents.host, an Owner''s): the agents it serves. It reads their events and holds leases in their names, nothing else.';

INSERT INTO pm.permission_modules (permission_key, module_id) VALUES
  ('agents.host', 'agents')
ON CONFLICT (permission_key) DO UPDATE SET module_id = EXCLUDED.module_id;

-- The host feed: events routed to any of p_member_ids (the agents a host key
-- serves), and, with p_agent_events, agent events of those agents. The same
-- order, horizon and retention as pm.event_feed_read.
CREATE OR REPLACE FUNCTION pm.event_feed_read_host(
  p_after_txid bigint,
  p_after_seq bigint,
  p_limit integer,
  p_member_ids uuid[],
  p_member_types text[],
  p_agent_events boolean DEFAULT false,
  p_agent_event_types text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pm
AS $$
DECLARE
  v_xmin bigint := pg_snapshot_xmin(pg_current_snapshot())::text::bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_txid bigint := coalesce(p_after_txid, v_xmin);
  v_seq bigint := CASE WHEN p_after_txid IS NULL THEN 0 ELSE coalesce(p_after_seq, 0) END;
  v_state pm.event_feed_state;
  v_rows jsonb;
  v_count integer;
  v_last jsonb;
BEGIN
  SELECT * INTO v_state FROM pm.event_feed_state WHERE id;
  IF FOUND AND (v_txid, v_seq) < (v_state.pruned_txid, v_state.pruned_seq) THEN
    RETURN jsonb_build_object('resync', true, 'cursor', jsonb_build_array(v_xmin::text, '0'));
  END IF;

  WITH picked AS (
    (
      SELECT f.*
      FROM pm.event_feed f
      WHERE f.member_id = ANY (coalesce(p_member_ids, '{}'))
        AND f.event_type = ANY (coalesce(p_member_types, '{}'))
        AND (f.change_txid, f.seq) > (v_txid, v_seq)
        AND f.change_txid < v_xmin
      ORDER BY f.change_txid, f.seq
      LIMIT v_limit + 1
    )
    UNION ALL
    (
      SELECT f.*
      FROM pm.event_feed f
      WHERE coalesce(p_agent_events, false)
        AND f.event_type = 'agent_event.created'
        AND f.agent_id = ANY (coalesce(p_member_ids, '{}'))
        AND (f.change_txid, f.seq) > (v_txid, v_seq)
        AND f.change_txid < v_xmin
        AND (p_agent_event_types IS NULL OR f.agent_event_type = ANY (p_agent_event_types))
      ORDER BY f.change_txid, f.seq
      LIMIT v_limit + 1
    )
  ), ordered AS (
    SELECT p.*, row_number() OVER (ORDER BY p.change_txid, p.seq) AS n
    FROM picked p
    ORDER BY p.change_txid, p.seq
    LIMIT v_limit + 1
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'txid', o.change_txid::text,
      'seq', o.seq::text,
      'type', o.event_type,
      'member_id', o.member_id,
      'agent_id', o.agent_id,
      'project_id', o.project_id,
      'subject_type', o.subject_type,
      'subject_id', o.subject_id,
      'created_at', o.created_at,
      'data', o.data,
      'agent_event', CASE WHEN o.event_type = 'agent_event.created'
        THEN (SELECT pm.agent_event_row(a) FROM pm.agent_activities a WHERE a.id = o.subject_id) END
    ) ORDER BY o.change_txid, o.seq) FILTER (WHERE o.n <= v_limit), '[]'::jsonb),
    count(*)
  INTO v_rows, v_count
  FROM ordered o;

  IF v_count > v_limit THEN
    v_last := v_rows -> (v_limit - 1);
    RETURN jsonb_build_object('resync', false, 'events', v_rows, 'has_more', true,
      'cursor', jsonb_build_array(v_last ->> 'txid', v_last ->> 'seq'));
  END IF;
  RETURN jsonb_build_object('resync', false, 'events', v_rows, 'has_more', false,
    'cursor', jsonb_build_array(greatest(v_xmin, v_txid)::text, CASE WHEN v_xmin > v_txid THEN '0' ELSE v_seq::text END));
END;
$$;

REVOKE ALL ON FUNCTION pm.event_feed_read_host(bigint, bigint, integer, uuid[], text[], boolean, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.event_feed_read_host(bigint, bigint, integer, uuid[], text[], boolean, text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Feed: the run's blocked state, the message's conversation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pm.feed_agent_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status
     AND (OLD.blocked_at IS NULL) = (NEW.blocked_at IS NULL) THEN
    RETURN NULL;
  END IF;
  INSERT INTO pm.event_feed (event_type, member_id, agent_id, project_id, subject_type, subject_id, data)
  VALUES ('run.updated', NEW.agent_id, NEW.agent_id, NEW.project_id, 'run', NEW.id, jsonb_build_object(
    'run', jsonb_build_object(
      'id', NEW.id,
      'status', NEW.status,
      'previous_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
      'task_id', NEW.task_id,
      'project_id', NEW.project_id,
      'parent_run_id', NEW.parent_run_id,
      'instance_id', NEW.instance_id,
      'blocked', NEW.blocked_at IS NOT NULL
    ),
    'actor_id', pm.webhook_actor_id()
  ));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.feed_agent_run() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS feed_agent_run ON pm.agent_runs;
CREATE TRIGGER feed_agent_run
  AFTER INSERT OR UPDATE OF status, blocked_at ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.feed_agent_run();

CREATE OR REPLACE FUNCTION pm.feed_chat_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF NEW.direction <> 'inbound' OR NEW.agent_id IS NULL OR NEW.status NOT IN ('pending', 'notified', 'context') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.agent_id IS NOT DISTINCT FROM NEW.agent_id
     AND OLD.status IN ('pending', 'notified', 'context') THEN
    RETURN NULL;
  END IF;
  INSERT INTO pm.event_feed (event_type, member_id, agent_id, subject_type, subject_id, data)
  VALUES ('chat.message', NEW.agent_id, NEW.agent_id, 'chat_message', NEW.id, jsonb_build_object(
    'message', jsonb_build_object(
      'id', NEW.id,
      'status', NEW.status,
      'connection_id', NEW.connection_id,
      'conversation_id', NEW.conversation_id,
      'thread_id', NEW.thread_id,
      'chat_conversation_id', NEW.chat_conversation_id,
      'created_at', NEW.created_at
    )
  ));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.feed_chat_message() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Blocked runs a signed-in member is waited on for (Needs you)
-- ---------------------------------------------------------------------------
-- Runs blocked now (waiting, blocked_at set) whose agent the caller manages
-- (an Owner, team.manage, one of its owners) or whose live task the caller
-- is assigned to, while the AI agents module is on. Newest first, at most 100.
CREATE OR REPLACE FUNCTION pm.my_blocked_runs()
RETURNS TABLE (
  run_id uuid, agent_id uuid, agent_name text, task_id uuid, task_title text, project_id uuid,
  title text, blocked_reason text, blocked_at timestamptz, instance_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pm
AS $$
  SELECT r.id, r.agent_id, a.name, r.task_id, t.title, r.project_id, r.title, r.blocked_reason, r.blocked_at, r.instance_id
  FROM pm.agent_runs r
  JOIN pm.team_members a ON a.id = r.agent_id
  LEFT JOIN pm.tasks t ON t.id = r.task_id
  WHERE r.status = 'waiting' AND r.blocked_at IS NOT NULL
    AND pm.module_enabled('agents')
    AND pm.current_team_member_id() IS NOT NULL
    AND (r.task_id IS NULL OR t.deleted_at IS NULL)
    AND (r.project_id IS NULL OR EXISTS (SELECT 1 FROM pm.projects p WHERE p.id = r.project_id AND p.deleted_at IS NULL))
    AND (pm.member_manages_agent(r.agent_id, pm.current_team_member_id())
      OR (r.task_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM pm.task_assignees ta WHERE ta.task_id = r.task_id AND ta.member_id = pm.current_team_member_id())))
  ORDER BY r.blocked_at DESC
  LIMIT 100
$$;

REVOKE ALL ON FUNCTION pm.my_blocked_runs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.my_blocked_runs() TO authenticated, service_role;
