-- Sorting on arrival knows four more kinds of machine mail.
--
-- code: a one-time sign-in or verification code. Filtered at once into the
--   Codes view and never triaged.
-- calendar: a calendar reply (Accepted:, Declined:, Updated invitation:).
-- survey: a feedback survey.
-- receipt: a receipt or payment confirmation (never an invoice).
-- The last three are updates: no one needs to act on them.
--
-- Both topic checks (messages and sender rules) take the new values.
-- Safe to run more than once.

ALTER TABLE communications.messages DROP CONSTRAINT IF EXISTS email_messages_topic_check;
ALTER TABLE communications.messages ADD CONSTRAINT email_messages_topic_check
  CHECK (topic IN ('money', 'account_risk', 'security', 'usage', 'event', 'newsletter', 'promotion', 'update', 'receipt', 'calendar', 'survey', 'code'));

-- The rules' check was unnamed when the table was made; drop whatever it is called.
DO $do$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'communications.sender_rules'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%topic%'
  LOOP
    EXECUTE format('ALTER TABLE communications.sender_rules DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$do$;
ALTER TABLE communications.sender_rules ADD CONSTRAINT sender_rules_topic_check
  CHECK (topic IN ('money', 'account_risk', 'security', 'usage', 'event', 'newsletter', 'promotion', 'update', 'receipt', 'calendar', 'survey', 'code'));
