-- The public contract, cleaned up for outside harnesses.
--
-- - New inboxes run triage plans: pm.inboxes.triage_mode defaults to 'plans'
--   (was 'legacy'). Only the column default changes: every existing inbox
--   keeps the mode it has, and a write that names a mode still gets it.
-- - Every webhook envelope carries api_version, the contract's version
--   (src/lib/api/version.ts), beside id, type, sequence, created_at and data.
--   It is stamped as the event is stored, by one BEFORE INSERT trigger on
--   pm.webhook_events, so every event writer (pm.emit_webhook_event,
--   pm.emit_invoice_webhook_event, pm.emit_agent_event_webhook,
--   pm.emit_assistant_message, and any later one) gets it while their bodies
--   stay exactly as they are. An envelope that already names api_version
--   keeps its own. Events stored before this migration have none; nothing is
--   rewritten. The value is written once, here.
--
-- Additive and safe to run twice. 2.0.40 code never reads the new key, and
-- an inbox it creates without naming a mode takes plans.

ALTER TABLE pm.inboxes ALTER COLUMN triage_mode SET DEFAULT 'plans';

CREATE OR REPLACE FUNCTION pm.webhook_envelope_api_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF jsonb_typeof(NEW.payload) = 'object' AND NOT NEW.payload ? 'api_version' THEN
    NEW.payload := NEW.payload || jsonb_build_object('api_version', '2026-11-25');
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.webhook_envelope_api_version() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_events_api_version ON pm.webhook_events;
CREATE TRIGGER webhook_events_api_version
  BEFORE INSERT ON pm.webhook_events
  FOR EACH ROW EXECUTE FUNCTION pm.webhook_envelope_api_version();
