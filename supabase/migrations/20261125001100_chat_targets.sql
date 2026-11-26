-- Two bots: the personal bot and the company bot, and chat names that no
-- longer say "assistant".
--
-- - chat_connections.kind: personal (DMs only, each person's message goes to
--   their own personal assistant, as before) or company (channels and DMs,
--   routed to company agents). Every connection made before is personal.
--   chat_connections.external_bot_id: the bot's own id with the provider
--   (Slack's bot user, Telegram's bot), so one bot is one connection and a
--   Slack mention of the bot is recognised. One connection per provider
--   workspace and kind (a personal app and a company app may share a Slack
--   workspace). Telegram connections made before take their bot id from
--   external_workspace_id, which already held it.
-- - pm.chat_connection_agents: the company agents a company connection
--   reaches, one of them the default (a DM to the bot, or a mention of the
--   bot in a channel with no mapping). Server only.
-- - pm.chat_channel_routes: a channel of a company connection mapped to one
--   of its agents, with listen 'mentions' (the default: only a mention is
--   recorded) or 'all' (every message is recorded as context for that
--   agent, never a request to answer). An agent removed from the connection
--   takes its channel mappings with it. Server only.
-- - chat_messages.is_request (false: context, recorded only so the agent
--   knows what was said; status context), is_direct (a one-to-one chat with
--   the bot; null for messages before) and route (how it reached its agent:
--   direct, mention, channel or default; null for personal ones).
-- - The chat.message webhook event: ids only, like assistant.message, for
--   personal and company messages alike. pm.emit_chat_message queues it to
--   the active endpoints subscribed to it that are filtered to exactly the
--   agent, or scoped to the assistant setup that made it. An endpoint lists
--   chat.message only when filtered to an agent or scoped to a setup
--   (pm.webhook_endpoints_assistant_guard); assistant.message keeps its own
--   rule. Service role only.
--
-- - chat_connections.provider also takes 'discord': a Discord bot whose
--   relay (app/relay/discord) holds the Gateway and posts each message to
--   the inbound route, signed with the connection's relay secret.
--
-- Additive and safe to run twice. The previous release's code never reads
-- the new columns or tables: its connections read as personal, its messages
-- as requests, and nothing it writes trips a new check.

-- ---------------------------------------------------------------------------
-- Connections: kind and the bot's own id
-- ---------------------------------------------------------------------------
ALTER TABLE pm.chat_connections
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS external_bot_id text;

ALTER TABLE pm.chat_connections DROP CONSTRAINT IF EXISTS chat_connections_kind_check;
ALTER TABLE pm.chat_connections
  ADD CONSTRAINT chat_connections_kind_check CHECK (kind IN ('personal', 'company'));
ALTER TABLE pm.chat_connections DROP CONSTRAINT IF EXISTS chat_connections_bot_id_length;
ALTER TABLE pm.chat_connections
  ADD CONSTRAINT chat_connections_bot_id_length CHECK (external_bot_id IS NULL OR length(external_bot_id) <= 255);

COMMENT ON COLUMN pm.chat_connections.kind IS
  'personal: DMs only, each person''s message goes to their own personal assistant. company: channels and DMs, routed to the company agents in chat_connection_agents.';
COMMENT ON COLUMN pm.chat_connections.external_bot_id IS
  'The bot''s own id with the provider (Slack bot user, Telegram bot): one connection per bot, and how a Slack mention of the bot is recognised.';

-- Telegram's workspace id was always its bot's id.
UPDATE pm.chat_connections SET external_bot_id = external_workspace_id
WHERE provider = 'telegram' AND external_bot_id IS NULL AND external_workspace_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS chat_connections_provider_bot
  ON pm.chat_connections (provider, external_bot_id) WHERE external_bot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_connections_provider_workspace_kind
  ON pm.chat_connections (provider, external_workspace_id, kind) WHERE external_workspace_id IS NOT NULL;
DROP INDEX IF EXISTS pm.chat_connections_provider_workspace;

-- Discord joins Slack and Telegram (its relay posts to the same inbound route).
ALTER TABLE pm.chat_connections DROP CONSTRAINT IF EXISTS chat_connections_provider_check;
ALTER TABLE pm.chat_connections
  ADD CONSTRAINT chat_connections_provider_check CHECK (provider IN ('slack', 'telegram', 'discord', 'teams', 'custom'));

-- ---------------------------------------------------------------------------
-- The company agents a company connection reaches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.chat_connection_agents (
  connection_id uuid NOT NULL REFERENCES pm.chat_connections(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, agent_id)
);

COMMENT ON TABLE pm.chat_connection_agents IS
  'The company agents a company chat connection reaches; is_default marks the one a DM, or a mention of the bot in an unmapped channel, goes to. Server only.';

CREATE UNIQUE INDEX IF NOT EXISTS chat_connection_agents_one_default
  ON pm.chat_connection_agents (connection_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_chat_connection_agents_agent
  ON pm.chat_connection_agents (agent_id);

ALTER TABLE pm.chat_connection_agents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pm.chat_connection_agents FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.chat_connection_agents TO service_role;

-- ---------------------------------------------------------------------------
-- Channel mappings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.chat_channel_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  channel_id text NOT NULL,
  channel_name text,
  agent_id uuid NOT NULL,
  listen text NOT NULL DEFAULT 'mentions',
  created_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Only an agent the connection reaches; removing it removes its channels.
  CONSTRAINT chat_channel_routes_agent_fkey FOREIGN KEY (connection_id, agent_id)
    REFERENCES pm.chat_connection_agents (connection_id, agent_id) ON DELETE CASCADE
);

ALTER TABLE pm.chat_channel_routes DROP CONSTRAINT IF EXISTS chat_channel_routes_listen_check;
ALTER TABLE pm.chat_channel_routes
  ADD CONSTRAINT chat_channel_routes_listen_check CHECK (listen IN ('all', 'mentions'));
ALTER TABLE pm.chat_channel_routes DROP CONSTRAINT IF EXISTS chat_channel_routes_text_lengths;
ALTER TABLE pm.chat_channel_routes
  ADD CONSTRAINT chat_channel_routes_text_lengths CHECK (
    length(channel_id) BETWEEN 1 AND 255
    AND (channel_name IS NULL OR length(channel_name) <= 255)
  );

COMMENT ON TABLE pm.chat_channel_routes IS
  'A channel of a company chat connection mapped to one of its agents. listen mentions: only a mention is recorded (as a request). listen all: every message is recorded as context for the agent, never a request. Server only.';

CREATE UNIQUE INDEX IF NOT EXISTS chat_channel_routes_channel
  ON pm.chat_channel_routes (connection_id, channel_id);

DROP TRIGGER IF EXISTS set_chat_channel_routes_updated_at ON pm.chat_channel_routes;
CREATE TRIGGER set_chat_channel_routes_updated_at
  BEFORE UPDATE ON pm.chat_channel_routes
  FOR EACH ROW EXECUTE FUNCTION pm.handle_updated_at();

ALTER TABLE pm.chat_channel_routes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pm.chat_channel_routes FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.chat_channel_routes TO service_role;

-- ---------------------------------------------------------------------------
-- Messages: requests and context
-- ---------------------------------------------------------------------------
ALTER TABLE pm.chat_messages
  ADD COLUMN IF NOT EXISTS is_request boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_direct boolean,
  ADD COLUMN IF NOT EXISTS route text;

ALTER TABLE pm.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_direction_status;
ALTER TABLE pm.chat_messages
  ADD CONSTRAINT chat_messages_direction_status CHECK (
    (direction = 'inbound' AND status IN ('pending', 'notified', 'replied', 'handled', 'unrouted', 'context'))
    OR (direction = 'outbound' AND status IN ('sent', 'failed'))
  );
ALTER TABLE pm.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_context_check;
ALTER TABLE pm.chat_messages
  ADD CONSTRAINT chat_messages_context_check CHECK ((status = 'context') = (direction = 'inbound' AND NOT is_request));
ALTER TABLE pm.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_route_check;
ALTER TABLE pm.chat_messages
  ADD CONSTRAINT chat_messages_route_check CHECK (route IS NULL OR route IN ('direct', 'mention', 'channel', 'default'));

COMMENT ON COLUMN pm.chat_messages.is_request IS
  'false: context (status context), a channel message recorded so its agent knows what was said; never a request to answer.';
COMMENT ON COLUMN pm.chat_messages.is_direct IS
  'Sent in a one-to-one chat with the bot (null: recorded before 20261125001100).';
COMMENT ON COLUMN pm.chat_messages.route IS
  'How a company message reached its agent: direct (a DM, to the default agent), mention (the agent named), channel (the channel mapping), default (the bot mentioned in an unmapped channel). Null for personal messages.';

-- One provider message is recorded once. Slack sends a channel mention of
-- the company bot twice (app_mention and message, each with its own event
-- id, so the dedupe key differs), and two deliveries can arrive at once.
-- Twins recorded before keep their rows and text: only the newer ones give
-- up the provider message id, so the oldest stays that message.
UPDATE pm.chat_messages m SET external_message_id = NULL
WHERE m.direction = 'inbound' AND m.external_message_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pm.chat_messages o
    WHERE o.direction = 'inbound' AND o.connection_id = m.connection_id
      AND o.conversation_id = m.conversation_id AND o.external_message_id = m.external_message_id
      AND (o.created_at, o.id) < (m.created_at, m.id)
  );
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_inbound_external
  ON pm.chat_messages (connection_id, conversation_id, external_message_id)
  WHERE direction = 'inbound' AND external_message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Webhook chat.message
-- ---------------------------------------------------------------------------
-- assistant.message: only an endpoint filtered to a personal agent, or
-- scoped to an assistant setup, as before. chat.message: only an endpoint
-- filtered to an agent (personal or company), or scoped to a setup. Chat is
-- private: no workspace-wide endpoint ever lists either.
CREATE OR REPLACE FUNCTION pm.webhook_endpoints_assistant_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.assistant_setup_id IS NOT NULL AND auth.uid() IS NOT NULL AND coalesce(auth.role(), '') <> 'service_role' THEN
    IF TG_OP = 'INSERT' OR NEW.assistant_setup_id IS DISTINCT FROM OLD.assistant_setup_id THEN
      IF coalesce(pm.current_team_member_role(), '') <> 'owner' THEN
        RAISE EXCEPTION 'Only an Owner scopes an endpoint to an assistant setup' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF 'assistant.message' = ANY (NEW.events) AND NEW.assistant_setup_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM pm.team_members a WHERE a.id = NEW.member_id AND a.role = 'agent' AND a.delegate_of IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'assistant.message goes only to an endpoint filtered to a personal agent (member_id) or scoped to an assistant setup (assistant_setup_id)' USING ERRCODE = '23514';
  END IF;
  IF 'chat.message' = ANY (NEW.events) AND NEW.assistant_setup_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM pm.team_members a WHERE a.id = NEW.member_id AND a.role = 'agent'
  ) THEN
    RAISE EXCEPTION 'chat.message goes only to an endpoint filtered to an agent (member_id) or scoped to an assistant setup (assistant_setup_id)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.webhook_endpoints_assistant_guard() FROM PUBLIC, anon, authenticated;

-- Queues one chat.message event (resource chat_message) to every active
-- endpoint subscribed to it whose member filter is exactly the agent, or
-- whose setup made the agent. Never to an endpoint with neither. Answers
-- whether any endpoint got it; nothing is written when none does.
CREATE OR REPLACE FUNCTION pm.emit_chat_message(p_message_id uuid, p_agent_id uuid, p_data jsonb)
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
  WHERE e.is_active AND e.events @> ARRAY['chat.message']
    AND (e.member_id = p_agent_id OR (e.member_id IS NULL AND e.assistant_setup_id IS NOT NULL))
    AND pm.webhook_endpoint_matches(e, 'chat.message', '{}'::uuid[], ARRAY[p_agent_id]);
  IF v_endpoints IS NULL THEN
    RETURN false;
  END IF;

  v_seq := nextval('pm.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
  VALUES (
    v_public_id, v_seq, 'chat.message', 'chat_message', p_message_id,
    jsonb_build_object(
      'id', v_public_id,
      'type', 'chat.message',
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

REVOKE ALL ON FUNCTION pm.emit_chat_message(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.emit_chat_message(uuid, uuid, jsonb) TO service_role;
