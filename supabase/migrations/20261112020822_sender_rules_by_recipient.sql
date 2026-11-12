-- A sender rule can apply only to mail sent to one address. The meeting
-- script in Ciaran's Valiance Google account sends each meeting to Ashley
-- once (the full transcript, or Gemini's notes when there is none), so
-- Gemini's own notes email to that account is filtered. Notes to his other
-- accounts, which have no script, still reach her.

ALTER TABLE communications.sender_rules ADD COLUMN IF NOT EXISTS recipient text;

ALTER TABLE communications.sender_rules DROP CONSTRAINT IF EXISTS sender_rules_recipient_check;
ALTER TABLE communications.sender_rules ADD CONSTRAINT sender_rules_recipient_check
  CHECK (recipient IS NULL OR (recipient = lower(btrim(recipient)) AND length(recipient) BETWEEN 3 AND 320 AND position('@' in recipient) > 1));

-- One live rule per sender, topic and recipient.
DROP INDEX IF EXISTS communications.email_sender_rules_live_key;
CREATE UNIQUE INDEX email_sender_rules_live_key
  ON communications.sender_rules (match_kind, match_value, COALESCE(topic, ''), COALESCE(recipient, '')) WHERE disabled_at IS NULL;

INSERT INTO communications.sender_rules (match_kind, match_value, topic, action, source, reason, recipient)
SELECT 'address', 'gemini-notes@google.com', NULL, 'ignore', 'person',
  'The meeting script sends each Valiance meeting once: the full transcript, or the notes when there is none.',
  'ciaran@valiancemedia.com'
WHERE NOT EXISTS (
  SELECT 1 FROM communications.sender_rules
  WHERE match_kind = 'address' AND match_value = 'gemini-notes@google.com' AND topic IS NULL
    AND recipient = 'ciaran@valiancemedia.com' AND disabled_at IS NULL
);
