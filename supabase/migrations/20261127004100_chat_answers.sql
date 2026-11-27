-- Answering from chat: a question or approval the app delivers to a
-- person's own chat (Telegram, Slack) carries buttons (Approve and Reject,
-- or the question's choices); pressing one answers it as that person.
--
-- - pm.chat_answer_tokens: one row per button. The provider sends back only
--   the token; the row holds its hash, the question, the person, the choice,
--   the connection and the message it is on. Every button of one message
--   shares a batch, and pressing any one uses the whole batch: single use.
--   A token ends with the question or after 7 days (expires_at), checked
--   when pressed (no job runs). Server only.
-- - questions.decided_via gains chat: an approval decided with a button in
--   the person's own chat, checked as it would be in the app.
--
-- Additive and safe to run twice. The previous release's code never sends
-- buttons and never reads the table.

ALTER TABLE pm.questions DROP CONSTRAINT IF EXISTS questions_decided_via_check;
ALTER TABLE pm.questions
  ADD CONSTRAINT questions_decided_via_check CHECK (
    decided_via IS NULL OR (decided_via IN ('app', 'api_key', 'agent', 'act_for', 'chat') AND kind = 'approval')
  );

COMMENT ON COLUMN pm.questions.decided_via IS
  'How an approval was decided: app (signed in), api_key (the person''s own key with approvals.decide), agent (the agent asked, with its own key), act_for (an agent acting for the person, with approvals.decide on its key and held by the person) or chat (the person, with a button on the app''s message in their own linked chat). Null on a plain question, an open approval, or one decided before this was recorded.';

CREATE TABLE IF NOT EXISTS pm.chat_answer_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  batch uuid NOT NULL,
  question_id uuid NOT NULL REFERENCES pm.questions(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES pm.chat_connections(id) ON DELETE CASCADE,
  choice text NOT NULL CHECK (char_length(choice) BETWEEN 1 AND 200),
  conversation_id text,
  external_message_id text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pm.chat_answer_tokens IS
  'Answer buttons on the app''s chat messages: one per button, the token hashed, single use per message (batch), bound to the question, the person, the choice and the connection.';

CREATE INDEX IF NOT EXISTS idx_chat_answer_tokens_batch ON pm.chat_answer_tokens (batch);
CREATE INDEX IF NOT EXISTS idx_chat_answer_tokens_question ON pm.chat_answer_tokens (question_id);

ALTER TABLE pm.chat_answer_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.chat_answer_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON pm.chat_answer_tokens TO service_role;
