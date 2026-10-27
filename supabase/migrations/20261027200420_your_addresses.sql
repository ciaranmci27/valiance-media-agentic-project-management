-- Your addresses: one list of every address mail comes in on.
--
-- Project addresses (communications.endpoints) and an inbox's aliases were two
-- halves of one idea. An endpoint now also covers an address with no project
-- and no relay address of its own (a forwarder that delivers to the inbox's
-- routing address, like ciaran@valiancemedia.com), and says whose it is: a
-- person (owner_member_id) or the company (null). delivery_of already counts
-- every endpoint's public address as ours, so mail to these reads as written
-- to us. Re-runnable.

ALTER TABLE communications.endpoints ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE communications.endpoints ALTER COLUMN routing_domain DROP NOT NULL;
ALTER TABLE communications.endpoints ALTER COLUMN routing_local_part DROP NOT NULL;
-- email_is_hostname(NULL) is false, not unknown: the domain check allows none.
ALTER TABLE communications.endpoints DROP CONSTRAINT IF EXISTS email_project_addresses_routing_domain_check;
ALTER TABLE communications.endpoints DROP CONSTRAINT IF EXISTS endpoints_routing_domain_check;
ALTER TABLE communications.endpoints ADD CONSTRAINT endpoints_routing_domain_check
  CHECK (routing_domain IS NULL OR (routing_domain = lower(btrim(routing_domain)) AND public.email_is_hostname(routing_domain)));

-- Whose address it is: a person, or the company when null. A person's
-- addresses are theirs as a sender too (ingest matches them like their email).
ALTER TABLE communications.endpoints
  ADD COLUMN IF NOT EXISTS owner_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL;

-- An address for a project needs its own relay address: that is how mail is
-- known to be the project's. Every address has a relay or a public address.
ALTER TABLE communications.endpoints DROP CONSTRAINT IF EXISTS endpoints_project_needs_routing;
ALTER TABLE communications.endpoints ADD CONSTRAINT endpoints_project_needs_routing
  CHECK (project_id IS NULL OR (routing_local_part IS NOT NULL AND routing_domain IS NOT NULL));
ALTER TABLE communications.endpoints DROP CONSTRAINT IF EXISTS endpoints_has_address;
ALTER TABLE communications.endpoints ADD CONSTRAINT endpoints_has_address
  CHECK (routing_local_part IS NOT NULL OR public_address IS NOT NULL);
ALTER TABLE communications.endpoints DROP CONSTRAINT IF EXISTS endpoints_routing_whole;
ALTER TABLE communications.endpoints ADD CONSTRAINT endpoints_routing_whole
  CHECK ((routing_local_part IS NULL) = (routing_domain IS NULL));

-- One row per public address.
CREATE UNIQUE INDEX IF NOT EXISTS endpoints_public_address_key
  ON communications.endpoints (public_address) WHERE public_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_endpoints_owner ON communications.endpoints (owner_member_id) WHERE owner_member_id IS NOT NULL;

-- A project address takes its relay address from its public address when
-- left empty, as before. An address with no project and no relay address of
-- its own keeps none: it arrives through the inbox's routing address.
CREATE OR REPLACE FUNCTION communications.endpoints_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_base text;
BEGIN
  NEW.public_address := NULLIF(lower(btrim(COALESCE(NEW.public_address, ''))), '');
  -- An address with no project and no relay address of its own keeps none:
  -- it arrives through the inbox's routing address.
  IF NEW.project_id IS NULL AND (NEW.routing_local_part IS NULL OR btrim(NEW.routing_local_part) = '') THEN
    NEW.routing_local_part := NULL;
    NEW.routing_domain := NULL;
  ELSE
    IF NEW.routing_domain IS NULL OR btrim(NEW.routing_domain) = '' THEN
      SELECT inbound_email_domain INTO NEW.routing_domain FROM public.business_settings LIMIT 1;
    END IF;
    NEW.routing_domain := lower(btrim(NEW.routing_domain));
    IF (NEW.routing_local_part IS NULL OR btrim(NEW.routing_local_part) = '') AND NEW.public_address IS NOT NULL THEN
      v_base := regexp_replace(regexp_replace(split_part(NEW.public_address, '@', 1), '[^a-z0-9._-]', '', 'g'), '^[._-]+|[._-]+$', '', 'g');
      NEW.routing_local_part := regexp_replace(left(v_base, 64), '[._-]+$', '');
    ELSE
      NEW.routing_local_part := lower(btrim(COALESCE(NEW.routing_local_part, '')));
    END IF;
  END IF;
  -- An edit, not mail arriving (last_received_at). A new route (routing or
  -- public address) waits for its first email again.
  IF TG_OP = 'UPDATE' AND NEW.last_received_at IS NOT DISTINCT FROM OLD.last_received_at THEN
    NEW.updated_at := now();
    IF NEW.routing_local_part IS DISTINCT FROM OLD.routing_local_part OR NEW.routing_domain IS DISTINCT FROM OLD.routing_domain
      OR NEW.public_address IS DISTINCT FROM OLD.public_address THEN
      NEW.last_received_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- An address with no project is the inbox team's to read and manage.
DROP POLICY IF EXISTS email_project_addresses_select ON communications.endpoints;
CREATE POLICY email_project_addresses_select ON communications.endpoints FOR SELECT TO authenticated
  USING (
    (project_id IS NULL AND (public.has_permission('inbound_email.read') OR public.has_permission('inbound_email.manage')))
    OR (public.can_access_project(project_id) AND (public.has_permission('contacts.read') OR public.has_permission('inbound_email.read')))
  );
DROP POLICY IF EXISTS email_project_addresses_manage ON communications.endpoints;
CREATE POLICY email_project_addresses_manage ON communications.endpoints FOR ALL TO authenticated
  USING (
    (project_id IS NULL AND public.has_permission('inbound_email.manage'))
    OR ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id))
  )
  WITH CHECK (
    (project_id IS NULL AND public.has_permission('inbound_email.manage'))
    OR ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id))
  );
DROP POLICY IF EXISTS email_project_addresses_parent_live ON communications.endpoints;
CREATE POLICY email_project_addresses_parent_live ON communications.endpoints AS RESTRICTIVE FOR ALL TO authenticated
  USING (project_id IS NULL OR public.project_is_live(project_id));

-- Every alias an inbox had becomes an address of the company's on it. The
-- aliases column stays until the contract migration; nothing reads it now.
INSERT INTO communications.endpoints (inbox_id, public_address)
SELECT DISTINCT ON (lower(btrim(alias))) i.id, lower(btrim(alias))
FROM communications.inboxes i, unnest(i.aliases) AS alias
WHERE btrim(alias) <> ''
  AND NOT EXISTS (SELECT 1 FROM communications.endpoints e WHERE e.public_address = lower(btrim(alias)))
ORDER BY lower(btrim(alias)), i.created_at;
