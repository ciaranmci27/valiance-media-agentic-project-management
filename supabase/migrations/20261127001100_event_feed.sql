-- The event feed: what an agent harness with no public address long-polls
-- (GET /api/v1/events?since=&wait=, MCP get_events), and the wake signal
-- behind GET /api/v1/chat/messages?wait=.
--
-- - pm.event_feed: one row per event a harness may hear, written by AFTER
--   triggers, so every writer (REST, MCP, the app, the watchdog, provider
--   webhooks) feeds it:
--   chat.message (an inbound chat message routed to an agent: inserted
--   routed, re-routed, or released after it was held), question.answered,
--   question.cancelled and question.expired (to the member who asked),
--   run.updated (an agent's run started or changed status, with who changed
--   it) and agent_event.created (any agent event; the API reads these by
--   project, as GET /api/v1/agent-activities does). Rows carry ids and
--   status only: the API composes what each caller may read.
-- - Order: (change_txid, seq), as the agent event export. A row is served
--   only once every transaction below its own has ended, so a cursor never
--   passes a row that commits late. A write transaction left open holds the
--   feed back until it ends.
-- - Retention: pm.prune_event_feed deletes rows older than 7 days (pg_cron
--   pm-event-feed-prune, hourly), in batches, and records the position it
--   pruned through in pm.event_feed_state, in the same transaction. A
--   cursor below that position answers 410 resync, never a silent gap.
-- - pm.event_feed_waits: the long-poll waits open per API key, each a lease
--   that ends by itself if its server dies. pm.event_feed_wait_begin
--   refuses a wait beyond the API's limit (2 per key) and says when the
--   earliest open one ends.
-- - pm.event_feed_read (a page after a cursor, for one caller's filters)
--   and pm.event_feed_heads (the newest visible position per waiting member
--   and per project a wait reads agent events on, one cheap indexed probe a
--   server shares across all its open waits).
--
-- Server only. Additive and safe to run twice. 2.0.49 code never reads the
-- new tables; the triggers only add rows beside what they did before.

-- ---------------------------------------------------------------------------
-- The feed
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS pm.event_feed_seq;
REVOKE ALL ON SEQUENCE pm.event_feed_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE pm.event_feed_seq TO service_role;

CREATE TABLE IF NOT EXISTS pm.event_feed (
  seq bigint PRIMARY KEY DEFAULT nextval('pm.event_feed_seq'),
  -- The transaction that wrote the row: the feed orders by (change_txid, seq).
  change_txid bigint NOT NULL DEFAULT (pg_current_xact_id()::text::bigint),
  event_type text NOT NULL,
  -- Who it is routed to (chat.message, question.*, run.updated); null for
  -- agent_event.created, which is read by project.
  member_id uuid,
  -- The agent it is about.
  agent_id uuid,
  project_id uuid,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  -- agent_event.created: the agent event's own type (work.done, ...).
  agent_event_type text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pm.event_feed IS
  'Events a harness long-polls (GET /api/v1/events): ids and status only, ordered by (change_txid, seq), kept 7 days (pm.prune_event_feed). Server only.';

CREATE INDEX IF NOT EXISTS idx_event_feed_member
  ON pm.event_feed (member_id, change_txid, seq) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_feed_agent_events
  ON pm.event_feed (change_txid, seq) WHERE event_type = 'agent_event.created';
CREATE INDEX IF NOT EXISTS idx_event_feed_agent_events_project
  ON pm.event_feed (project_id, change_txid, seq) WHERE event_type = 'agent_event.created';
CREATE INDEX IF NOT EXISTS idx_event_feed_position
  ON pm.event_feed (change_txid, seq);
CREATE INDEX IF NOT EXISTS idx_event_feed_created_at
  ON pm.event_feed (created_at);

ALTER TABLE pm.event_feed ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.event_feed FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.event_feed TO service_role;

-- One row: the position retention pruned through.
CREATE TABLE IF NOT EXISTS pm.event_feed_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  pruned_txid bigint NOT NULL DEFAULT 0,
  pruned_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pm.event_feed_state IS
  'The (change_txid, seq) pm.prune_event_feed deleted through; a cursor below it must resync. Server only.';

ALTER TABLE pm.event_feed_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.event_feed_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.event_feed_state TO service_role;

-- Open long-poll waits, one lease each.
CREATE TABLE IF NOT EXISTS pm.event_feed_waits (
  id uuid PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES pm.api_keys(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pm.event_feed_waits IS
  'Long-poll waits open per API key; a lease past expires_at is over (its server died). Server only.';

CREATE INDEX IF NOT EXISTS idx_event_feed_waits_key
  ON pm.event_feed_waits (api_key_id, expires_at);

ALTER TABLE pm.event_feed_waits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.event_feed_waits FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.event_feed_waits TO service_role;

-- ---------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------
-- A chat message routed to an agent: inserted routed, given to another
-- agent, or released from unrouted (held while the agent was paused). Moving
-- between pending, notified and context is the same message, not a new one.
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
      'created_at', NEW.created_at
    )
  ));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.feed_chat_message() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS feed_chat_message ON pm.chat_messages;
CREATE TRIGGER feed_chat_message
  AFTER INSERT OR UPDATE OF agent_id, status ON pm.chat_messages
  FOR EACH ROW EXECUTE FUNCTION pm.feed_chat_message();

-- A question or approval the member asked is answered, cancelled or expires.
CREATE OR REPLACE FUNCTION pm.feed_question_closed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF OLD.status <> 'open' OR NEW.status NOT IN ('answered', 'cancelled', 'expired') THEN
    RETURN NULL;
  END IF;
  INSERT INTO pm.event_feed (event_type, member_id, agent_id, project_id, subject_type, subject_id, data)
  VALUES ('question.' || NEW.status, NEW.asked_by, NEW.asked_by, NEW.project_id, 'question', NEW.id, jsonb_build_object(
    'question', jsonb_build_object(
      'id', NEW.id,
      'kind', NEW.kind,
      'status', NEW.status,
      'task_id', NEW.task_id,
      'project_id', NEW.project_id,
      'run_id', NEW.run_id
    ),
    'actor_id', pm.webhook_actor_id()
  ));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.feed_question_closed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS feed_question_closed ON pm.questions;
CREATE TRIGGER feed_question_closed
  AFTER UPDATE OF status ON pm.questions
  FOR EACH ROW EXECUTE FUNCTION pm.feed_question_closed();

-- An agent's run starts or changes status (waiting, running again, finished,
-- timed out by the watchdog, cancelled by a person). actor_id says who did
-- it, so a harness skips what it did itself.
CREATE OR REPLACE FUNCTION pm.feed_agent_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
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
      'parent_run_id', NEW.parent_run_id
    ),
    'actor_id', pm.webhook_actor_id()
  ));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.feed_agent_run() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS feed_agent_run ON pm.agent_runs;
CREATE TRIGGER feed_agent_run
  AFTER INSERT OR UPDATE OF status ON pm.agent_runs
  FOR EACH ROW EXECUTE FUNCTION pm.feed_agent_run();

-- Any agent event. The row is the pointer; the API reads the event itself
-- (the export's row shape) when it serves it.
CREATE OR REPLACE FUNCTION pm.feed_agent_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
BEGIN
  INSERT INTO pm.event_feed (event_type, agent_id, project_id, subject_type, subject_id, agent_event_type)
  VALUES ('agent_event.created', NEW.agent_id, NEW.project_id, 'agent_activity', NEW.id, NEW.activity_type);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.feed_agent_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS feed_agent_event ON pm.agent_activities;
CREATE TRIGGER feed_agent_event
  AFTER INSERT ON pm.agent_activities
  FOR EACH ROW EXECUTE FUNCTION pm.feed_agent_event();

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------
-- One page for one caller after a cursor, in (change_txid, seq) order, only
-- from finished transactions. p_after_txid null starts from now. Member
-- events (p_member_types) are the caller's own; agent events are filtered
-- by project (null: every project), agent and type. Answers
-- { resync: true, cursor } when the cursor is below what retention pruned,
-- else { resync: false, events, has_more, cursor }: cursor is the last
-- event's position when the page is full, else the horizon (the oldest
-- transaction still open, seq 0), so an idle feed moves forward and a later
-- read starts past everything already decided. Positions are text, as
-- bigint does not fit a JSON number.
CREATE OR REPLACE FUNCTION pm.event_feed_read(
  p_after_txid bigint,
  p_after_seq bigint,
  p_limit integer,
  p_member_id uuid,
  p_member_types text[],
  p_agent_events boolean,
  p_agent_event_types text[] DEFAULT NULL,
  p_agents uuid[] DEFAULT NULL,
  p_project_ids uuid[] DEFAULT NULL
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
      WHERE p_member_id IS NOT NULL
        AND f.member_id = p_member_id
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
        AND (f.change_txid, f.seq) > (v_txid, v_seq)
        AND f.change_txid < v_xmin
        AND (p_project_ids IS NULL OR f.project_id = ANY (p_project_ids))
        AND (p_agents IS NULL OR f.agent_id = ANY (p_agents))
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

REVOKE ALL ON FUNCTION pm.event_feed_read(bigint, bigint, integer, uuid, text[], boolean, text[], uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.event_feed_read(bigint, bigint, integer, uuid, text[], boolean, text[], uuid[], uuid[]) TO service_role;

-- The newest visible position routed to each member, of any agent event
-- (p_agent_events, for waits that read every project) and of agent events on
-- each of p_projects (for waits that read only some): one probe a server
-- makes every few seconds for all its open waits. Each is a single backward
-- step on an index.
CREATE OR REPLACE FUNCTION pm.event_feed_heads(p_members uuid[], p_agent_events boolean DEFAULT false, p_projects uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pm
AS $$
DECLARE
  v_xmin bigint := pg_snapshot_xmin(pg_current_snapshot())::text::bigint;
  v_members jsonb;
  v_agent_events jsonb;
  v_projects jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(p.id, (
    SELECT jsonb_build_array(f.change_txid::text, f.seq::text)
    FROM pm.event_feed f
    WHERE f.event_type = 'agent_event.created' AND f.project_id = p.id AND f.change_txid < v_xmin
    ORDER BY f.change_txid DESC, f.seq DESC
    LIMIT 1
  )), '{}'::jsonb)
  INTO v_projects
  FROM (SELECT DISTINCT unnest(coalesce(p_projects, '{}')) AS id) p;

  SELECT coalesce(jsonb_object_agg(m.id, (
    SELECT jsonb_build_array(f.change_txid::text, f.seq::text)
    FROM pm.event_feed f
    WHERE f.member_id = m.id AND f.change_txid < v_xmin
    ORDER BY f.change_txid DESC, f.seq DESC
    LIMIT 1
  )), '{}'::jsonb)
  INTO v_members
  FROM (SELECT DISTINCT unnest(coalesce(p_members, '{}')) AS id) m;

  IF coalesce(p_agent_events, false) THEN
    SELECT jsonb_build_array(f.change_txid::text, f.seq::text) INTO v_agent_events
    FROM pm.event_feed f
    WHERE f.event_type = 'agent_event.created' AND f.change_txid < v_xmin
    ORDER BY f.change_txid DESC, f.seq DESC
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object('members', v_members, 'agent_events', v_agent_events, 'projects', v_projects);
END;
$$;

REVOKE ALL ON FUNCTION pm.event_feed_heads(uuid[], boolean, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.event_feed_heads(uuid[], boolean, uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Waits: at most p_max open per key
-- ---------------------------------------------------------------------------
-- Takes a lease for p_seconds, or answers { ok: false, retry_after } (the
-- seconds until the earliest open wait on the key ends). Leases past their
-- time are over: a server that died mid-wait frees its slot by itself.
CREATE OR REPLACE FUNCTION pm.event_feed_wait_begin(p_api_key_id uuid, p_wait_id uuid, p_seconds integer, p_max integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_open integer;
  v_next timestamptz;
BEGIN
  -- One key's waits are counted one at a time, so two at once never both slip in.
  PERFORM pg_advisory_xact_lock(hashtextextended('pm.event_feed_waits:' || p_api_key_id::text, 0));
  DELETE FROM pm.event_feed_waits WHERE api_key_id = p_api_key_id AND expires_at <= now();
  SELECT count(*), min(expires_at) INTO v_open, v_next FROM pm.event_feed_waits WHERE api_key_id = p_api_key_id;
  IF v_open >= greatest(p_max, 1) THEN
    RETURN jsonb_build_object('ok', false, 'open', v_open,
      'retry_after', greatest(1, ceil(extract(epoch FROM v_next - now()))::integer));
  END IF;
  INSERT INTO pm.event_feed_waits (id, api_key_id, expires_at)
  VALUES (p_wait_id, p_api_key_id, now() + make_interval(secs => least(greatest(p_seconds, 1), 600)))
  ON CONFLICT (id) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'open', v_open + 1);
END;
$$;

REVOKE ALL ON FUNCTION pm.event_feed_wait_begin(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.event_feed_wait_begin(uuid, uuid, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION pm.event_feed_wait_end(p_wait_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = pm
AS $$
  DELETE FROM pm.event_feed_waits WHERE id = p_wait_id;
$$;

REVOKE ALL ON FUNCTION pm.event_feed_wait_end(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.event_feed_wait_end(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
-- Rows older than p_keep go, through the newest such position whose
-- transaction and every one below it have ended (so nothing still to commit
-- lies behind it). The position is recorded in the same transaction as the
-- delete: a reader sees both or neither. In batches of 5000. Answers how
-- many rows went. Expired wait leases go too.
CREATE OR REPLACE FUNCTION pm.prune_event_feed(p_keep interval DEFAULT interval '7 days')
RETURNS integer
LANGUAGE plpgsql
SET search_path = pm
AS $$
DECLARE
  v_xmin bigint := pg_snapshot_xmin(pg_current_snapshot())::text::bigint;
  v_txid bigint;
  v_seq bigint;
  v_count integer;
  v_total integer := 0;
BEGIN
  DELETE FROM pm.event_feed_waits WHERE expires_at <= now();

  SELECT f.change_txid, f.seq INTO v_txid, v_seq
  FROM pm.event_feed f
  WHERE f.created_at < now() - p_keep AND f.change_txid < v_xmin
  ORDER BY f.change_txid DESC, f.seq DESC
  LIMIT 1;
  IF v_txid IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO pm.event_feed_state AS s (id, pruned_txid, pruned_seq, updated_at)
  VALUES (true, v_txid, v_seq, now())
  ON CONFLICT (id) DO UPDATE
    SET pruned_txid = EXCLUDED.pruned_txid, pruned_seq = EXCLUDED.pruned_seq, updated_at = now()
    WHERE (s.pruned_txid, s.pruned_seq) < (EXCLUDED.pruned_txid, EXCLUDED.pruned_seq);

  LOOP
    DELETE FROM pm.event_feed WHERE seq IN (
      SELECT f.seq FROM pm.event_feed f
      WHERE (f.change_txid, f.seq) <= (v_txid, v_seq)
      ORDER BY f.change_txid, f.seq
      LIMIT 5000
    );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_total := v_total + v_count;
    EXIT WHEN v_count = 0;
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION pm.prune_event_feed(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.prune_event_feed(interval) TO service_role;

-- Hourly. Skipped where pg_cron is unavailable (PGlite).
-- Re-running cron.schedule updates the job in place.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is unavailable here; the event feed will not be pruned on a schedule';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('pm-event-feed-prune', '29 * * * *', $job$SELECT pm.prune_event_feed();$job$);
END;
$do$;
