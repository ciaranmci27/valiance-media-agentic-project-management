-- Agents start chat conversations, and people send them files.
--
-- - chat_messages.initiated: an outbound message an agent started
--   (POST /api/v1/chat/messages: a digest, an alert, a daily report), not
--   an answer to one. A reply to it (in its thread, quoting it, or the next
--   message in that DM) goes back to the same agent, with route 'reply' on
--   a company connection and reply_to_id naming the started message.
-- - chat_messages.attachments: the files sent with an inbound message
--   (photos, voice notes, audio, video, documents), as a JSON array of
--   { kind, ref, name, mime_type, size, duration_seconds }. ref is the
--   provider's own way back to the file (a Telegram file_id, a Slack
--   files.slack.com address, a Discord CDN address); the app fetches the
--   bytes only when the agent asks, and never shows ref.
-- - pm.apply_chat_attachment_retention: chat retention
--   (business_settings.chat_retention_days) also forgets these file
--   references, daily, with the same exceptions as the text (a message
--   still waiting for its agent or for a delivery keeps them). The text
--   sweep only visits messages with text, and a file needs no text.
-- - Permission chat.notify (AI agents module): a company agent may DM a
--   member who did not ask (an unprompted alert). No role holds it by
--   default; an Owner grants it to the agent and its key both.
--
-- Additive and safe to run twice. The previous release's code never reads
-- the new columns, writes neither, and never writes route 'reply'.

-- ---------------------------------------------------------------------------
-- Messages: started by an agent, and files
-- ---------------------------------------------------------------------------
ALTER TABLE pm.chat_messages
  ADD COLUMN IF NOT EXISTS initiated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attachments jsonb;

ALTER TABLE pm.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_initiated_check;
ALTER TABLE pm.chat_messages
  ADD CONSTRAINT chat_messages_initiated_check CHECK (NOT initiated OR direction = 'outbound');
ALTER TABLE pm.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_attachments_check;
ALTER TABLE pm.chat_messages
  ADD CONSTRAINT chat_messages_attachments_check CHECK (
    attachments IS NULL OR (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) BETWEEN 1 AND 20)
  );
ALTER TABLE pm.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_route_check;
ALTER TABLE pm.chat_messages
  ADD CONSTRAINT chat_messages_route_check CHECK (route IS NULL OR route IN ('direct', 'mention', 'channel', 'default', 'reply'));

COMMENT ON COLUMN pm.chat_messages.initiated IS
  'An outbound message an agent started (POST /api/v1/chat/messages), not an answer. A reply to it goes back to that agent.';
COMMENT ON COLUMN pm.chat_messages.attachments IS
  'Files sent with an inbound message: [{ kind, ref, name, mime_type, size, duration_seconds }]. ref is the provider''s file id or address, never shown to an agent; the bytes are fetched through the app on request. Null when none.';
COMMENT ON COLUMN pm.chat_messages.route IS
  'How a company message reached its agent: direct (a DM, to the default agent), mention (the agent named), channel (the channel mapping), default (the bot mentioned in an unmapped channel), reply (an answer to a message the agent started). Null for personal messages.';

-- A reply finds the message it answers: the provider id of a started message.
CREATE INDEX IF NOT EXISTS idx_chat_messages_initiated
  ON pm.chat_messages (connection_id, conversation_id, external_message_id)
  WHERE direction = 'outbound' AND initiated AND external_message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------
INSERT INTO pm.permission_modules (permission_key, module_id) VALUES
  ('chat.notify', 'agents')
ON CONFLICT (permission_key) DO UPDATE SET module_id = EXCLUDED.module_id;

-- ---------------------------------------------------------------------------
-- Retention of file references
-- ---------------------------------------------------------------------------
-- Forgets the file references of chat messages older than the chat
-- retention, in batches (the rest the next day), never one still waiting
-- for its agent or for a webhook delivery. Answers how many were forgotten.
CREATE OR REPLACE FUNCTION pm.apply_chat_attachment_retention()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  batch constant integer := 5000;
  max_rounds constant integer := 20;
  v_days integer;
  v_cutoff timestamptz;
  v_n integer;
  v_round integer := 0;
  v_total integer := 0;
BEGIN
  SELECT chat_retention_days INTO v_days FROM pm.business_settings LIMIT 1;
  IF v_days IS NULL THEN
    RETURN 0;
  END IF;
  v_cutoff := now() - make_interval(days => v_days);
  LOOP
    UPDATE pm.chat_messages SET attachments = NULL WHERE id IN (
      SELECT m.id FROM pm.chat_messages m
      WHERE m.attachments IS NOT NULL AND m.created_at < v_cutoff
        AND NOT (m.direction = 'inbound' AND m.status IN ('pending', 'notified'))
        AND NOT EXISTS (SELECT 1 FROM pm.webhook_events ev JOIN pm.webhook_deliveries d ON d.webhook_event_id = ev.id
                        WHERE ev.resource_type = 'chat_message' AND ev.resource_id = m.id AND d.status IN ('pending', 'delivering'))
      LIMIT batch);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
    v_round := v_round + 1;
    EXIT WHEN v_n < batch OR v_round >= max_rounds;
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION pm.apply_chat_attachment_retention() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.apply_chat_attachment_retention() TO service_role;

-- Daily, beside pm-retention. Skipped where pg_cron is unavailable (PGlite).
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is unavailable here; run SELECT pm.apply_chat_attachment_retention() daily';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('pm-chat-attachment-retention', '52 3 * * *', $job$SELECT pm.apply_chat_attachment_retention();$job$);
END;
$do$;
