-- How a message reached us, so whoever triages it can tell a request made to
-- us from mail we were only copied on. Every channel fills the same values:
--   direct     one of our addresses is a main recipient, with few others
--   group      one of ours is a main recipient among many (3+ others)
--   cc         ours only in copy
--   bcc        none of ours among the recipients (blind copy, or a relay forward)
--   forwarded  a verified teammate forwarded it in
--   broadcast  bulk or automated mail
-- audience_size counts the distinct main and copy recipients.
-- Ours: every inbox's address, routing address and aliases, every endpoint's
-- addresses, and the team's email addresses. Inbox aliases are addresses that
-- reach an inbox without being its own, like a personal address that
-- forwards there.
--
-- Apply after 20261026191615_communications_scope_hardening.sql. Safe to re-run.

BEGIN;

ALTER TABLE communications.messages
  ADD COLUMN IF NOT EXISTS delivery text CONSTRAINT messages_delivery_check
    CHECK (delivery IN ('direct', 'group', 'cc', 'bcc', 'forwarded', 'broadcast'));
ALTER TABLE communications.messages
  ADD COLUMN IF NOT EXISTS audience_size integer CONSTRAINT messages_audience_size_check CHECK (audience_size >= 0);
ALTER TABLE communications.inboxes
  ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}' CONSTRAINT inboxes_aliases_check CHECK (cardinality(aliases) <= 20);

-- A message's delivery and audience, from its recipients.
CREATE OR REPLACE FUNCTION communications.delivery_of(p_message_id uuid, p_forwarded boolean)
RETURNS TABLE (delivery text, audience_size integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  WITH ours AS (
    SELECT lower(address) AS address FROM communications.inboxes
    UNION SELECT lower(routing_address) FROM communications.inboxes
    UNION SELECT lower(btrim(alias)) FROM communications.inboxes, unnest(aliases) AS alias
    UNION SELECT lower(routing_address) FROM communications.endpoints
    UNION SELECT lower(public_address) FROM communications.endpoints WHERE public_address IS NOT NULL
    UNION SELECT lower(btrim(email)) FROM public.team_members WHERE email IS NOT NULL AND btrim(email) <> ''
  ),
  recipients AS (
    SELECT p.kind, p.address, p.address IN (SELECT address FROM ours) AS is_ours
    FROM communications.participants p
    WHERE p.message_id = p_message_id AND p.kind IN ('to', 'cc')
  )
  SELECT
    CASE
      WHEN m.auto_mail_reason IS NOT NULL THEN 'broadcast'
      WHEN p_forwarded THEN 'forwarded'
      WHEN EXISTS (SELECT 1 FROM recipients WHERE kind = 'to' AND is_ours) THEN
        CASE WHEN (SELECT count(DISTINCT address) FROM recipients WHERE NOT is_ours) >= 3 THEN 'group' ELSE 'direct' END
      WHEN EXISTS (SELECT 1 FROM recipients WHERE kind = 'cc' AND is_ours) THEN 'cc'
      ELSE 'bcc'
    END,
    (SELECT count(DISTINCT address)::integer FROM recipients)
  FROM communications.messages m
  WHERE m.id = p_message_id
$$;

-- Records a message's delivery (ingest, once its recipients are stored).
CREATE OR REPLACE FUNCTION communications.set_message_delivery(p_message_id uuid, p_forwarded boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v record;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v FROM communications.delivery_of(p_message_id, p_forwarded);
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE communications.messages SET delivery = v.delivery, audience_size = v.audience_size WHERE id = p_message_id;
  RETURN v.delivery;
END;
$$;

REVOKE ALL ON FUNCTION communications.delivery_of(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.set_message_delivery(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.delivery_of(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION communications.set_message_delivery(uuid, boolean) TO service_role;

-- Messages already received (updated_at left as it was).
ALTER TABLE communications.messages DISABLE TRIGGER set_email_messages_updated_at;
UPDATE communications.messages m
SET delivery = d.delivery, audience_size = d.audience_size
FROM communications.messages x
CROSS JOIN LATERAL communications.delivery_of(x.id, x.routing_basis = 'forwarded_original') d
WHERE m.id = x.id AND m.delivery IS NULL AND m.status <> 'receiving';
ALTER TABLE communications.messages ENABLE TRIGGER set_email_messages_updated_at;

COMMIT;
