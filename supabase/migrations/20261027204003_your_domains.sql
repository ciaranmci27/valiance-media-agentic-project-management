-- Your domains, and addresses that are not yours.
--
-- A domain of yours (valiancemedia.com) is a catch-all: mail written to any
-- address on it reads as written to you, listed or not. A specific address
-- still wins (its project, whose it is). Addresses marked as not yours are
-- never suggested again, and an address you remove goes there too.
-- Also fixes delivery_of: an address with no relay address of its own put a
-- null into "ours", which made "not ours" unknown and hid group mail.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS communications.own_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL CONSTRAINT own_domains_domain_check CHECK (
    domain = lower(btrim(domain)) AND public.email_is_hostname(domain) AND NOT public.email_domain_is_public(domain)
  ),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT own_domains_domain_key UNIQUE (domain)
);

CREATE TABLE IF NOT EXISTS communications.ignored_addresses (
  address text PRIMARY KEY CONSTRAINT ignored_addresses_address_check CHECK (address = lower(btrim(address)) AND public.email_is_address(address)),
  ignored_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE communications.own_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.ignored_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS own_domains_select ON communications.own_domains;
CREATE POLICY own_domains_select ON communications.own_domains FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.read') OR public.has_permission('inbound_email.manage'));
DROP POLICY IF EXISTS ignored_addresses_select ON communications.ignored_addresses;
CREATE POLICY ignored_addresses_select ON communications.ignored_addresses FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.manage'));

-- Written by the app's service role only.
REVOKE ALL ON communications.own_domains, communications.ignored_addresses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON communications.own_domains, communications.ignored_addresses TO authenticated;
GRANT ALL ON communications.own_domains, communications.ignored_addresses TO service_role;

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
    UNION SELECT lower(routing_address) FROM communications.endpoints WHERE routing_address IS NOT NULL
    UNION SELECT lower(public_address) FROM communications.endpoints WHERE public_address IS NOT NULL
    UNION SELECT lower(btrim(email)) FROM public.team_members WHERE email IS NOT NULL AND btrim(email) <> ''
  ),
  recipients AS (
    SELECT p.kind, p.address,
      (p.address IN (SELECT address FROM ours)
        OR split_part(p.address, '@', 2) IN (SELECT domain FROM communications.own_domains)) IS TRUE AS is_ours
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

-- Every stored message reads its delivery again: the addresses and domains
-- just listed as yours, and group mail the null hid.
ALTER TABLE communications.messages DISABLE TRIGGER set_email_messages_updated_at;
UPDATE communications.messages m
SET delivery = d.delivery, audience_size = d.audience_size
FROM communications.messages x
CROSS JOIN LATERAL communications.delivery_of(x.id, x.routing_basis = 'forwarded_original') d
WHERE m.id = x.id AND m.status <> 'receiving'
  AND (m.delivery IS DISTINCT FROM d.delivery OR m.audience_size IS DISTINCT FROM d.audience_size);
ALTER TABLE communications.messages ENABLE TRIGGER set_email_messages_updated_at;
