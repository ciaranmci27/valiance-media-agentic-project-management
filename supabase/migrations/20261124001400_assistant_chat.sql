-- The personal Assistant and the chat switchboard: every person's own
-- assistant on one plain page, and the app as the front door for chat.
--
-- - business_settings.assistants_enabled: an Owner turns assistants on for
--   the workspace (off by default, so nothing changes until one does).
--   business_settings.assistant_label: what the workspace calls them (null
--   reads "Assistant").
-- - pm.assistant_preferences: one row per personal agent, set by its person
--   on the My Assistant page: tone, a note on how they like to work, an
--   avatar tone, and four plain switches (sort_inbox, create_tasks,
--   draft_replies, remind_me) as switches jsonb. A missing row or key reads
--   as the default. The server reads them into the agent's context pack and
--   refuses the matching writes when a switch is off. Server only.
-- - pm.chat_connections: a chat workspace or bot an Owner connected (Slack,
--   Telegram; Teams and custom are reserved for adapters to come), its
--   display name, the bot's handle, and its credentials sealed with
--   APP_ENCRYPTION_KEY (purpose chat) by the server. One per provider and
--   external workspace. Server only.
-- - pm.chat_messages: every chat message in and out, beside email rather
--   than inside its conversations: chat goes to one person's assistant and
--   never through inbox routing or triage. Inbound: pending (waiting for the
--   assistant to fetch it), notified (sent to its webhook), replied,
--   handled, or unrouted (the app answered itself: an unknown sender, no
--   assistant, a paused one). Outbound: sent or failed. dedupe_key (the
--   provider's event id) makes a provider's retry a no-op. Server only.
-- - pm.chat_rate_limits and pm.consume_chat_rate_limit: inbound messages
--   per connection and per sender per window. Service role only.
-- - pm.emit_assistant_message: queues the assistant.message webhook event
--   (ids only, never chat text) to the endpoints filtered to exactly that
--   agent, and answers whether any did. Service role only. An endpoint lists
--   assistant.message only with a member filter naming a personal agent
--   (pm.webhook_endpoints_assistant_guard).
-- - pm.assistant_follow_personal_inbox: a personal inbox created for, or
--   given to, a person whose assistant has Sort my inbox on gets it as a
--   handler with access; one taken from them loses it.
--
-- Additive and safe to run twice. The previous release's code never reads or
-- writes the new columns or tables: assistants stay off, and no webhook
-- endpoint lists assistant.message until a release that offers it.

-- ---------------------------------------------------------------------------
-- Workspace switch and name
-- ---------------------------------------------------------------------------
ALTER TABLE pm.business_settings
  ADD COLUMN IF NOT EXISTS assistants_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assistant_label text;

ALTER TABLE pm.business_settings DROP CONSTRAINT IF EXISTS business_settings_assistant_label_check;
ALTER TABLE pm.business_settings
  ADD CONSTRAINT business_settings_assistant_label_check CHECK (
    assistant_label IS NULL OR (length(btrim(assistant_label)) BETWEEN 1 AND 40 AND assistant_label !~ '[\r\n]')
  );

COMMENT ON COLUMN pm.business_settings.assistants_enabled IS
  'Whether people see their personal assistant (My Assistant) and chat reaches it. Off until an Owner turns it on.';
COMMENT ON COLUMN pm.business_settings.assistant_label IS
  'What the workspace calls a personal assistant in the sidebar and on its page (null: Assistant).';

-- ---------------------------------------------------------------------------
-- A person's settings for their assistant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.assistant_preferences (
  agent_id uuid PRIMARY KEY REFERENCES pm.team_members(id) ON DELETE CASCADE,
  tone text NOT NULL DEFAULT 'warm',
  personality text,
  avatar_tone smallint,
  switches jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.assistant_preferences DROP CONSTRAINT IF EXISTS assistant_preferences_tone_check;
ALTER TABLE pm.assistant_preferences
  ADD CONSTRAINT assistant_preferences_tone_check CHECK (tone IN ('warm', 'brief', 'formal'));
ALTER TABLE pm.assistant_preferences DROP CONSTRAINT IF EXISTS assistant_preferences_personality_check;
ALTER TABLE pm.assistant_preferences
  ADD CONSTRAINT assistant_preferences_personality_check CHECK (personality IS NULL OR length(personality) <= 1000);
ALTER TABLE pm.assistant_preferences DROP CONSTRAINT IF EXISTS assistant_preferences_avatar_tone_check;
ALTER TABLE pm.assistant_preferences
  ADD CONSTRAINT assistant_preferences_avatar_tone_check CHECK (avatar_tone IS NULL OR avatar_tone BETWEEN 1 AND 8);
ALTER TABLE pm.assistant_preferences DROP CONSTRAINT IF EXISTS assistant_preferences_switches_check;
ALTER TABLE pm.assistant_preferences
  ADD CONSTRAINT assistant_preferences_switches_check CHECK (jsonb_typeof(switches) = 'object');

COMMENT ON TABLE pm.assistant_preferences IS
  'A personal agent''s settings from its person: tone, a note, avatar tone, and the switches sort_inbox, create_tasks, draft_replies, remind_me (missing reads as the default). Server only.';

DROP TRIGGER IF EXISTS set_assistant_preferences_updated_at ON pm.assistant_preferences;
CREATE TRIGGER set_assistant_preferences_updated_at
  BEFORE UPDATE ON pm.assistant_preferences
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

ALTER TABLE pm.assistant_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pm.assistant_preferences FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.assistant_preferences TO service_role;

-- ---------------------------------------------------------------------------
-- Chat connections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.chat_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_workspace_id text,
  display_name text NOT NULL,
  bot_handle text,
  credentials text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_inbound_at timestamptz,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.chat_connections DROP CONSTRAINT IF EXISTS chat_connections_provider_check;
ALTER TABLE pm.chat_connections
  ADD CONSTRAINT chat_connections_provider_check CHECK (provider IN ('slack', 'telegram', 'teams', 'custom'));
ALTER TABLE pm.chat_connections DROP CONSTRAINT IF EXISTS chat_connections_display_name_check;
ALTER TABLE pm.chat_connections
  ADD CONSTRAINT chat_connections_display_name_check CHECK (length(btrim(display_name)) BETWEEN 1 AND 100);
ALTER TABLE pm.chat_connections DROP CONSTRAINT IF EXISTS chat_connections_text_lengths;
ALTER TABLE pm.chat_connections
  ADD CONSTRAINT chat_connections_text_lengths CHECK (
    (external_workspace_id IS NULL OR length(external_workspace_id) <= 255)
    AND (bot_handle IS NULL OR length(bot_handle) <= 255)
    AND length(credentials) <= 8000
  );
ALTER TABLE pm.chat_connections DROP CONSTRAINT IF EXISTS chat_connections_credentials_sealed;
ALTER TABLE pm.chat_connections
  ADD CONSTRAINT chat_connections_credentials_sealed CHECK (credentials LIKE 'pm1:%');

COMMENT ON TABLE pm.chat_connections IS
  'Chat workspaces and bots an Owner connected: provider, display name, the bot''s handle, credentials sealed with APP_ENCRYPTION_KEY (purpose chat). Server only.';

CREATE UNIQUE INDEX IF NOT EXISTS chat_connections_provider_workspace
  ON pm.chat_connections (provider, external_workspace_id) WHERE external_workspace_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_chat_connections_updated_at ON pm.chat_connections;
CREATE TRIGGER set_chat_connections_updated_at
  BEFORE UPDATE ON pm.chat_connections
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

ALTER TABLE pm.chat_connections ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pm.chat_connections FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.chat_connections TO service_role;

-- ---------------------------------------------------------------------------
-- Chat messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES pm.chat_connections(id) ON DELETE CASCADE,
  direction text NOT NULL,
  status text NOT NULL,
  conversation_id text NOT NULL,
  thread_id text,
  external_message_id text,
  external_user_id text,
  dedupe_key text,
  member_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  -- The verified linked account the sender was known by.
  identity_id uuid REFERENCES pm.member_identities(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  reply_to_id uuid REFERENCES pm.chat_messages(id) ON DELETE SET NULL,
  text text NOT NULL,
  error text,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pm.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_direction_status;
ALTER TABLE pm.chat_messages
  ADD CONSTRAINT chat_messages_direction_status CHECK (
    (direction = 'inbound' AND status IN ('pending', 'notified', 'replied', 'handled', 'unrouted'))
    OR (direction = 'outbound' AND status IN ('sent', 'failed'))
  );
ALTER TABLE pm.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_text_lengths;
ALTER TABLE pm.chat_messages
  ADD CONSTRAINT chat_messages_text_lengths CHECK (
    length(text) <= 40000
    AND length(conversation_id) BETWEEN 1 AND 255
    AND (thread_id IS NULL OR length(thread_id) <= 255)
    AND (external_message_id IS NULL OR length(external_message_id) <= 255)
    AND (external_user_id IS NULL OR length(external_user_id) <= 255)
    AND (dedupe_key IS NULL OR length(dedupe_key) <= 255)
    AND (error IS NULL OR length(error) <= 500)
  );

COMMENT ON TABLE pm.chat_messages IS
  'Chat messages in (pending, notified, replied, handled, unrouted) and out (sent, failed), one person''s assistant per message; a provider retry with the same dedupe_key is a no-op. Server only.';

-- A provider's retry is the same row.
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_dedupe
  ON pm.chat_messages (connection_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- An assistant fetching what waits for it, oldest first.
CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_status
  ON pm.chat_messages (agent_id, status, created_at) WHERE direction = 'inbound';
-- The thread a reply goes to, and its recent context.
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON pm.chat_messages (connection_id, conversation_id, created_at DESC);

ALTER TABLE pm.chat_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pm.chat_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.chat_messages TO service_role;

-- ---------------------------------------------------------------------------
-- Inbound rate limits, per connection and per sender
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.chat_rate_limits (
  connection_id uuid NOT NULL REFERENCES pm.chat_connections(id) ON DELETE CASCADE,
  -- '' for the whole connection, user:<provider id> for one sender.
  subject text NOT NULL DEFAULT '',
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (connection_id, subject)
);

ALTER TABLE pm.chat_rate_limits DROP CONSTRAINT IF EXISTS chat_rate_limits_subject_length;
ALTER TABLE pm.chat_rate_limits
  ADD CONSTRAINT chat_rate_limits_subject_length CHECK (length(subject) <= 300);

ALTER TABLE pm.chat_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pm.chat_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.chat_rate_limits TO service_role;

-- Counts one inbound message against a window: the connection's ('') or one
-- sender's. Answers whether it is allowed.
CREATE OR REPLACE FUNCTION pm.consume_chat_rate_limit(
  p_connection_id uuid,
  p_subject text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE (allowed boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window pm.chat_rate_limits%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_window_seconds IS NULL OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'Invalid rate limit' USING ERRCODE = '22023';
  END IF;
  INSERT INTO pm.chat_rate_limits AS w (connection_id, subject, window_start, request_count)
  VALUES (p_connection_id, coalesce(p_subject, ''), v_now, 1)
  ON CONFLICT (connection_id, subject) DO UPDATE
  SET window_start = CASE WHEN w.window_start + make_interval(secs => p_window_seconds) <= v_now THEN v_now ELSE w.window_start END,
      request_count = CASE WHEN w.window_start + make_interval(secs => p_window_seconds) <= v_now THEN 1 ELSE w.request_count + 1 END
  RETURNING * INTO v_window;
  allowed := v_window.request_count <= p_limit;
  remaining := greatest(0, p_limit - v_window.request_count);
  reset_at := v_window.window_start + make_interval(secs => p_window_seconds);
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION pm.consume_chat_rate_limit(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.consume_chat_rate_limit(uuid, text, integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Webhook assistant.message
-- ---------------------------------------------------------------------------
-- Only an endpoint filtered to a personal agent takes assistant.message: chat
-- is private, so no workspace-wide endpoint ever lists it.
CREATE OR REPLACE FUNCTION pm.webhook_endpoints_assistant_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF 'assistant.message' = ANY (NEW.events) AND NOT EXISTS (
    SELECT 1 FROM pm.team_members a WHERE a.id = NEW.member_id AND a.role = 'agent' AND a.delegate_of IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'assistant.message goes only to an endpoint filtered to a personal agent (member_id)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.webhook_endpoints_assistant_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_endpoints_assistant_guard ON pm.webhook_endpoints;
CREATE TRIGGER webhook_endpoints_assistant_guard
  BEFORE INSERT OR UPDATE OF events, member_id ON pm.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION pm.webhook_endpoints_assistant_guard();

-- Queues one assistant.message event (its own line: resource chat_message)
-- to every active endpoint subscribed to it whose member filter is exactly
-- the agent. Never to an endpoint with no member filter, nor one filtered to
-- projects (an event has no project). Answers whether any endpoint got it;
-- nothing is written when none does.
CREATE OR REPLACE FUNCTION pm.emit_assistant_message(p_message_id uuid, p_agent_id uuid, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_endpoints uuid[];
  v_seq bigint;
  v_public_id text;
  v_event_uuid uuid;
BEGIN
  SELECT array_agg(e.id ORDER BY e.id) INTO v_endpoints
  FROM pm.webhook_endpoints e
  WHERE e.member_id = p_agent_id
    AND pm.webhook_endpoint_matches(e, 'assistant.message', '{}'::uuid[], ARRAY[p_agent_id]);
  IF v_endpoints IS NULL THEN
    RETURN false;
  END IF;

  v_seq := nextval('pm.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
  VALUES (
    v_public_id, v_seq, 'assistant.message', 'chat_message', p_message_id,
    jsonb_build_object(
      'id', v_public_id,
      'type', 'assistant.message',
      'sequence', v_seq,
      'created_at', now(),
      'data', coalesce(p_data, '{}'::jsonb) || jsonb_build_object('member_ids', jsonb_build_array(p_agent_id))
    )
  )
  RETURNING id INTO v_event_uuid;

  INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id)
  SELECT v_event_uuid, unnest(v_endpoints);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_assistant_message(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.emit_assistant_message(uuid, uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- "Sort my inbox" follows the person's inboxes
-- ---------------------------------------------------------------------------
-- When a personal inbox is created for a person, or given to one, their
-- assistants with Sort my inbox on become its handlers (never the primary)
-- with access to it, as the switch does for the inboxes they had. An inbox
-- taken from a person takes those away from their assistants.
CREATE OR REPLACE FUNCTION pm.assistant_follow_personal_inbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.owner_member_id IS NOT NULL AND OLD.owner_member_id IS DISTINCT FROM NEW.owner_member_id THEN
    DELETE FROM pm.inbox_handlers h
    WHERE h.inbox_id = NEW.id AND NOT h.is_primary
      AND h.handler_member_id IN (SELECT a.id FROM pm.team_members a WHERE a.delegate_of = OLD.owner_member_id);
    DELETE FROM pm.inbox_access x
    WHERE x.inbox_id = NEW.id
      AND x.member_id IN (SELECT a.id FROM pm.team_members a WHERE a.delegate_of = OLD.owner_member_id);
  END IF;
  IF NEW.owner_member_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.owner_member_id IS DISTINCT FROM NEW.owner_member_id) THEN
    INSERT INTO pm.inbox_access (inbox_id, member_id, created_by)
    SELECT NEW.id, a.id, NEW.owner_member_id
    FROM pm.team_members a JOIN pm.assistant_preferences p ON p.agent_id = a.id
    WHERE a.delegate_of = NEW.owner_member_id AND a.role = 'agent' AND p.switches ->> 'sort_inbox' = 'true'
    ON CONFLICT DO NOTHING;
    INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id, is_primary)
    SELECT NEW.id, a.id, false
    FROM pm.team_members a JOIN pm.assistant_preferences p ON p.agent_id = a.id
    WHERE a.delegate_of = NEW.owner_member_id AND a.role = 'agent' AND p.switches ->> 'sort_inbox' = 'true'
      AND NOT EXISTS (SELECT 1 FROM pm.inbox_handlers h WHERE h.inbox_id = NEW.id AND h.handler_member_id = a.id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pm.assistant_follow_personal_inbox() FROM PUBLIC, anon, authenticated;

-- Named to fire after inboxes_sync_primary_handler (triggers run in name
-- order): the primary handler row exists before an assistant's is added, so
-- inboxes.handler_member_id is never cleared.
DROP TRIGGER IF EXISTS assistant_follow_personal_inbox ON pm.inboxes;
DROP TRIGGER IF EXISTS inboxes_z_assistant_follow ON pm.inboxes;
CREATE TRIGGER inboxes_z_assistant_follow
  AFTER INSERT OR UPDATE OF owner_member_id ON pm.inboxes
  FOR EACH ROW EXECUTE FUNCTION pm.assistant_follow_personal_inbox();
