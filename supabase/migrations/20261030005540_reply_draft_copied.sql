-- A reply draft records when a person copied it. Copying it and then marking
-- the thread handled is how the app knows the draft was (roughly) what they
-- sent, with no extra step: the draft folds away and the agent reads it as
-- the reply that went out. Only a ready draft can be copied.
-- Safe to run more than once.

ALTER TABLE communications.reply_drafts ADD COLUMN IF NOT EXISTS copied_at timestamptz;
ALTER TABLE communications.reply_drafts DROP CONSTRAINT IF EXISTS email_reply_drafts_copied_is_ready;
ALTER TABLE communications.reply_drafts ADD CONSTRAINT email_reply_drafts_copied_is_ready
  CHECK (copied_at IS NULL OR status = 'ready');
