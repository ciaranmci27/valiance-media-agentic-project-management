-- Client email to agent inboxes (inbound triage), slices 1 and 2.
--
-- Clients email an agent (Ashley first). The mail is forwarded to the inbox's
-- routing address on the relay domain (business_settings.inbound_email_domain
-- by default, relay.valiancemedia.com), which Resend receives. Resend's
-- email.received webhook reaches /api/inbound-email/resend; the app fetches
-- the message from Resend's Receiving API and copies the raw .eml and each
-- attachment server-side into the private `inbound-email` bucket. The app
-- threads it, maps it to projects and filters auto-mail; the agent reads and
-- triages it through /api/v1. The core is provider-agnostic (provider and
-- provider_email_id say where a message came from).
--
-- Settled rules this file enforces in the database:
-- - Nothing here sends email.
-- - A task linked to a source email only BECOMES ai_ready in a human session
--   (email_task_ai_ready_guard), and an agent cannot sidestep that by linking
--   a task that is already ai_ready (email_task_link_guard).
-- - Files are written only after their message row exists, and a message
--   cannot lose its inbox or thread while its row exists (ON DELETE RESTRICT),
--   so retention always deletes files first, then rows.
-- - The project lives on the thread. Messages keep their mapping candidates
--   in email_message_candidates; agents never create mappings.
-- - Contacts get several email addresses (contact_emails). contacts.email
--   stays as the primary mirror, synced both ways, so every existing reader
--   and form keeps working.
--
-- Safe to re-run.

-- ============================================================
-- 1. Helpers
-- ============================================================

CREATE OR REPLACE FUNCTION public.email_is_address(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_value IS NOT NULL
    AND length(p_value) BETWEEN 3 AND 320
    AND p_value ~ '^[^@[:space:]<>(),;:"]+@[^@[:space:]<>(),;:"]+\.[^@[:space:]<>(),;:"]+$'
$$;

-- The obvious public webmail domains. A client domain mapping on one of these
-- would map every stranger on that service to the project. The app keeps the
-- fuller list (src/lib/inbound-email/public-domains.ts) and refuses first;
-- this is the backstop.
CREATE OR REPLACE FUNCTION public.email_domain_is_public(p_domain text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(p_domain) IN (
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
      'yahoo.com', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com',
      'aol.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'mail.com',
      'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com',
      'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io'
    )
    OR lower(p_domain) ~ '^(gmx|hotmail|outlook|live|yahoo|ymail|aol|msn|windowslive)\.[a-z]{2,3}(\.[a-z]{2})?$'
$$;

-- A person signed in to the app: an authenticated session (never the service
-- role) whose user is an active, non-agent team member.
CREATE OR REPLACE FUNCTION public.is_human_session()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(auth.role(), '') <> 'service_role'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.team_members
      WHERE auth_user_id = auth.uid() AND status = 'active' AND role <> 'agent'
    )
$$;

CREATE OR REPLACE FUNCTION public.email_is_hostname(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_value IS NOT NULL
    AND length(p_value) BETWEEN 3 AND 253
    AND p_value ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'
$$;

CREATE OR REPLACE FUNCTION public.email_inbox_verification_code()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'VM-' || string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  FROM generate_series(1, 4)
$$;

-- ============================================================
-- 2. Contact email addresses
-- ============================================================
-- One contact, several addresses; one address may belong to several
-- contacts (unique per contact, not globally). Stored lowercased.

CREATE TABLE IF NOT EXISTS public.contact_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND public.email_is_address(email)),
  is_primary boolean NOT NULL DEFAULT false,
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_emails_contact_email_key
  ON public.contact_emails (contact_id, lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS contact_emails_one_primary
  ON public.contact_emails (contact_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_contact_emails_email ON public.contact_emails (email);

-- Lowercase the address; the first address a contact gets is its primary;
-- promoting one demotes the others (before the one-primary index checks).
CREATE OR REPLACE FUNCTION public.contact_emails_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  IF TG_OP = 'INSERT' AND NOT NEW.is_primary AND NOT EXISTS (
    SELECT 1 FROM public.contact_emails WHERE contact_id = NEW.contact_id AND is_primary
  ) THEN
    NEW.is_primary := true;
  END IF;
  IF NEW.is_primary AND (TG_OP = 'INSERT' OR NOT OLD.is_primary OR OLD.contact_id IS DISTINCT FROM NEW.contact_id) THEN
    UPDATE public.contact_emails SET is_primary = false
    WHERE contact_id = NEW.contact_id AND is_primary AND id <> NEW.id;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END;
$$;

-- contacts.email mirrors the primary address. Case differences are left
-- alone so a form keeps the spelling it saved. With no primary, a valid
-- address in contacts.email is cleared; anything that is not an address
-- (legacy free text) is left as it is.
CREATE OR REPLACE FUNCTION public.sync_contact_email_mirror(p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current text;
  v_primary text;
BEGIN
  SELECT email INTO v_current FROM public.contacts WHERE id = p_contact_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT email INTO v_primary FROM public.contact_emails WHERE contact_id = p_contact_id AND is_primary;
  IF v_primary IS NOT NULL THEN
    IF lower(btrim(COALESCE(v_current, ''))) IS DISTINCT FROM v_primary THEN
      UPDATE public.contacts SET email = v_primary WHERE id = p_contact_id;
    END IF;
  ELSIF public.email_is_address(lower(btrim(COALESCE(v_current, '')))) THEN
    UPDATE public.contacts SET email = '' WHERE id = p_contact_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.contact_emails_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM public.sync_contact_email_mirror(OLD.contact_id); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.email IS DISTINCT FROM OLD.email OR NEW.is_primary IS DISTINCT FROM OLD.is_primary) THEN
    PERFORM public.sync_contact_email_mirror(NEW.contact_id);
  END IF;
  RETURN NULL;
END;
$$;

-- Editing contacts.email (every existing form) edits the primary address:
-- an address the contact already has becomes primary, otherwise the primary
-- row takes the new address, otherwise one is added. Clearing it, or saving
-- something that is not an address, removes the primary row. Changes made by
-- the mirror itself (a nested trigger) are not echoed back.
CREATE OR REPLACE FUNCTION public.contacts_sync_primary_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(btrim(COALESCE(NEW.email, '')));
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND lower(btrim(COALESCE(OLD.email, ''))) = v_email THEN RETURN NULL; END IF;
  IF NOT public.email_is_address(v_email) THEN
    DELETE FROM public.contact_emails WHERE contact_id = NEW.id AND is_primary;
  ELSIF EXISTS (SELECT 1 FROM public.contact_emails WHERE contact_id = NEW.id AND email = v_email) THEN
    UPDATE public.contact_emails SET is_primary = true WHERE contact_id = NEW.id AND email = v_email AND NOT is_primary;
  ELSIF EXISTS (SELECT 1 FROM public.contact_emails WHERE contact_id = NEW.id AND is_primary) THEN
    UPDATE public.contact_emails SET email = v_email WHERE contact_id = NEW.id AND is_primary;
  ELSE
    INSERT INTO public.contact_emails (contact_id, email, is_primary) VALUES (NEW.id, v_email, true);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS contact_emails_before_write ON public.contact_emails;
CREATE TRIGGER contact_emails_before_write
  BEFORE INSERT OR UPDATE ON public.contact_emails
  FOR EACH ROW EXECUTE FUNCTION public.contact_emails_before_write();

DROP TRIGGER IF EXISTS contact_emails_after_write ON public.contact_emails;
CREATE TRIGGER contact_emails_after_write
  AFTER INSERT OR UPDATE OR DELETE ON public.contact_emails
  FOR EACH ROW EXECUTE FUNCTION public.contact_emails_after_write();

DROP TRIGGER IF EXISTS contacts_sync_primary_email ON public.contacts;
CREATE TRIGGER contacts_sync_primary_email
  AFTER INSERT OR UPDATE OF email ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_sync_primary_email();

-- Backfill: every contact with an address gets it as its primary.
INSERT INTO public.contact_emails (contact_id, email, is_primary)
SELECT c.id, lower(btrim(c.email)), true
FROM public.contacts c
WHERE public.email_is_address(lower(btrim(c.email)))
  AND NOT EXISTS (SELECT 1 FROM public.contact_emails ce WHERE ce.contact_id = c.id);

-- ============================================================
-- 3. Inboxes, access, client domains
-- ============================================================

-- The workspace's default relay domain, the one whose MX points at the
-- receiving provider. A new inbox takes it when created; each inbox keeps its own domain
-- after that, so changing this default never moves an existing inbox.
ALTER TABLE public.business_settings
  ADD COLUMN IF NOT EXISTS inbound_email_domain text NOT NULL DEFAULT 'relay.valiancemedia.com'
    CHECK (inbound_email_domain = lower(btrim(inbound_email_domain)) AND public.email_is_hostname(inbound_email_domain));

CREATE TABLE IF NOT EXISTS public.email_inboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- The public address clients write to, e.g. ashley@valiancemedia.com.
  address text NOT NULL CHECK (address = lower(btrim(address)) AND public.email_is_address(address)),
  -- <local>@<domain>, where the forwarder delivers and what ingestion looks
  -- up. The domain defaults to business_settings.inbound_email_domain and the
  -- local part to the address's, when left empty (email_inboxes_before_write).
  -- Changing either clears verified_at: the forwarder target changed.
  routing_domain text NOT NULL CHECK (routing_domain = lower(btrim(routing_domain)) AND public.email_is_hostname(routing_domain)),
  routing_local_part text NOT NULL CHECK (routing_local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  routing_address text GENERATED ALWAYS AS (routing_local_part || '@' || routing_domain) STORED,
  handler_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  max_attachment_mb integer NOT NULL DEFAULT 25 CHECK (max_attachment_mb BETWEEN 1 AND 50),
  agent_readable_types text[] NOT NULL DEFAULT ARRAY['image', 'pdf', 'text']::text[]
    CHECK (agent_readable_types <@ ARRAY['image', 'pdf', 'text']::text[]),
  summary_interval_minutes integer NOT NULL DEFAULT 30 CHECK (summary_interval_minutes BETWEEN 5 AND 1440),
  filter_auto_mail boolean NOT NULL DEFAULT true,
  verification_code text NOT NULL DEFAULT public.email_inbox_verification_code()
    CHECK (verification_code ~ '^VM-[A-Z0-9]{4}$'),
  verified_at timestamptz,
  last_received_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_inboxes_routing_address_key UNIQUE (routing_address),
  CONSTRAINT email_inboxes_verification_code_key UNIQUE (verification_code)
);

CREATE TABLE IF NOT EXISTS public.email_inbox_access (
  inbox_id uuid NOT NULL REFERENCES public.email_inboxes(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inbox_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_email_inbox_access_member ON public.email_inbox_access (member_id);

CREATE OR REPLACE FUNCTION public.email_inboxes_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
  v_candidate text;
BEGIN
  NEW.address := lower(btrim(NEW.address));
  IF NEW.routing_domain IS NULL OR btrim(NEW.routing_domain) = '' THEN
    SELECT inbound_email_domain INTO NEW.routing_domain FROM public.business_settings LIMIT 1;
  END IF;
  NEW.routing_domain := lower(btrim(NEW.routing_domain));
  IF NEW.routing_local_part IS NULL OR btrim(NEW.routing_local_part) = '' THEN
    v_base := regexp_replace(regexp_replace(split_part(NEW.address, '@', 1), '[^a-z0-9._-]', '', 'g'), '^[._-]+|[._-]+$', '', 'g');
    IF v_base = '' THEN v_base := 'inbox'; END IF;
    v_base := left(v_base, 50);
    v_candidate := v_base;
    WHILE EXISTS (
      SELECT 1 FROM public.email_inboxes
      WHERE routing_local_part = v_candidate AND routing_domain = NEW.routing_domain AND id <> NEW.id
    ) LOOP
      v_candidate := v_base || '-' || substr(md5(random()::text), 1, 4);
    END LOOP;
    NEW.routing_local_part := v_candidate;
  ELSE
    NEW.routing_local_part := lower(btrim(NEW.routing_local_part));
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.routing_domain IS DISTINCT FROM OLD.routing_domain OR NEW.routing_local_part IS DISTINCT FROM OLD.routing_local_part THEN
      NEW.verified_at := NULL;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- The handler always reads its own inbox.
CREATE OR REPLACE FUNCTION public.email_inboxes_grant_handler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.handler_member_id IS NOT NULL THEN
    INSERT INTO public.email_inbox_access (inbox_id, member_id) VALUES (NEW.id, NEW.handler_member_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS email_inboxes_before_write ON public.email_inboxes;
CREATE TRIGGER email_inboxes_before_write
  BEFORE INSERT OR UPDATE ON public.email_inboxes
  FOR EACH ROW EXECUTE FUNCTION public.email_inboxes_before_write();

DROP TRIGGER IF EXISTS email_inboxes_grant_handler ON public.email_inboxes;
CREATE TRIGGER email_inboxes_grant_handler
  AFTER INSERT OR UPDATE OF handler_member_id ON public.email_inboxes
  FOR EACH ROW EXECUTE FUNCTION public.email_inboxes_grant_handler();

-- Mail from any address at a client's domain maps to the project. A domain may
-- map to several projects (one client, several companies).
CREATE TABLE IF NOT EXISTS public.email_client_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL CHECK (
    domain = lower(btrim(domain))
    AND public.email_is_hostname(domain)
    AND NOT public.email_domain_is_public(domain)
  ),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_client_domains_domain_project_key UNIQUE (domain, project_id)
);
CREATE INDEX IF NOT EXISTS idx_email_client_domains_project ON public.email_client_domains (project_id);

-- ============================================================
-- 4. Threads and messages
-- ============================================================

CREATE TABLE IF NOT EXISTS public.email_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES public.email_inboxes(id) ON DELETE RESTRICT,
  subject_normalized text NOT NULL DEFAULT '',
  -- The project lives here, on the thread, and nowhere else. mapped: from a
  -- contact or domain mapping; inferred: chosen by the agent at triage;
  -- ciaran: set by a person.
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  project_source text CHECK (project_source IN ('mapped', 'inferred', 'ciaran')),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_threads_project_pair_check CHECK ((project_id IS NULL) = (project_source IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_email_threads_inbox_last ON public.email_threads (inbox_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_threads_inbox_subject ON public.email_threads (inbox_id, subject_normalized);
CREATE INDEX IF NOT EXISTS idx_email_threads_project ON public.email_threads (project_id) WHERE project_id IS NOT NULL;

-- A deleted project nulls project_id (ON DELETE SET NULL); its source goes too.
CREATE OR REPLACE FUNCTION public.email_threads_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS NULL THEN NEW.project_source := NULL; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS email_threads_before_update ON public.email_threads;
CREATE TRIGGER email_threads_before_update
  BEFORE UPDATE ON public.email_threads
  FOR EACH ROW EXECUTE FUNCTION public.email_threads_before_update();

CREATE TABLE IF NOT EXISTS public.email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES public.email_inboxes(id) ON DELETE RESTRICT,
  -- Set when the message completes; a receiving row has none yet.
  thread_id uuid REFERENCES public.email_threads(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'receiving'
    CHECK (status IN ('receiving', 'new', 'handled', 'ignored', 'needs_ciaran')),
  -- Where the message came from: the receiving provider and its id for the
  -- message, so a webhook retry finds the same row.
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9_-]{1,40}$'),
  provider_email_id text NOT NULL CHECK (length(provider_email_id) BETWEEN 1 AND 200),
  -- The Message-ID header without angle brackets (synthetic from the
  -- provider's id when the header is missing). Raw header values, not entities.
  internet_message_id text NOT NULL CHECK (length(internet_message_id) BETWEEN 1 AND 998),
  in_reply_to text[] NOT NULL DEFAULT '{}',
  reference_ids text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL DEFAULT '',
  subject_normalized text NOT NULL DEFAULT '',
  sent_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  text_body text,
  html_body text,
  -- Display only: the message with quoted history stripped.
  new_text text,
  is_forward boolean NOT NULL DEFAULT false,
  -- Sender trust: { trust: trusted | untrusted | unknown, source, spf, dkim,
  -- dmarc, reason, raw Authentication-Results/ARC headers when present }.
  -- trusted = DKIM pass aligned with the From domain; untrusted = DKIM failed
  -- or is not aligned; unknown = no result we can rely on.
  auth jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_mail_reason text CHECK (auto_mail_reason IS NULL OR length(auto_mail_reason) <= 200),
  -- {inbox_id}/{message_id}/raw.eml; size and hash are recorded when stored.
  raw_storage_path text,
  raw_size_bytes bigint CHECK (raw_size_bytes IS NULL OR raw_size_bytes >= 0),
  raw_sha256 text CHECK (raw_sha256 IS NULL OR raw_sha256 ~ '^[0-9a-f]{64}$'),
  raw_uploaded_at timestamptz,
  completed_at timestamptz,
  -- A person looked at it in the Inbox and marked it handled. A suggested
  -- reply waits in "Needs reply" until then; sending the message back to
  -- the agent clears it.
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_messages_inbox_message_key UNIQUE (inbox_id, internet_message_id),
  CONSTRAINT email_messages_inbox_provider_key UNIQUE (inbox_id, provider, provider_email_id),
  CONSTRAINT email_messages_thread_when_complete CHECK (status = 'receiving' OR thread_id IS NOT NULL),
  CONSTRAINT email_messages_raw_stored_with_hash CHECK (raw_uploaded_at IS NULL OR (raw_storage_path IS NOT NULL AND raw_sha256 IS NOT NULL AND raw_size_bytes IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_status ON public.email_messages (inbox_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_received ON public.email_messages (inbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON public.email_messages (thread_id, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_raw_storage_path_key ON public.email_messages (raw_storage_path) WHERE raw_storage_path IS NOT NULL;

DROP TRIGGER IF EXISTS set_email_messages_updated_at ON public.email_messages;
CREATE TRIGGER set_email_messages_updated_at
  BEFORE UPDATE ON public.email_messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Sender and recipients as rows. contact_id is set when exactly one contact
-- has the address.
CREATE TABLE IF NOT EXISTS public.email_message_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('from', 'to', 'cc', 'reply_to')),
  address text NOT NULL CHECK (address = lower(btrim(address)) AND length(address) BETWEEN 3 AND 320),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 300),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  position integer NOT NULL DEFAULT 0,
  CONSTRAINT email_message_recipients_message_kind_address_key UNIQUE (message_id, kind, address)
);
CREATE UNIQUE INDEX IF NOT EXISTS email_message_recipients_one_from ON public.email_message_recipients (message_id) WHERE kind = 'from';
CREATE INDEX IF NOT EXISTS idx_email_message_recipients_address ON public.email_message_recipients (address);
CREATE INDEX IF NOT EXISTS idx_email_message_recipients_contact ON public.email_message_recipients (contact_id) WHERE contact_id IS NOT NULL;

-- Thread participants are derived, never stored.
CREATE OR REPLACE VIEW public.email_thread_participants
WITH (security_invoker = true) AS
SELECT
  m.thread_id,
  r.address,
  max(r.name) AS name,
  (array_agg(r.contact_id) FILTER (WHERE r.contact_id IS NOT NULL))[1] AS contact_id,
  count(*)::integer AS appearances,
  max(m.received_at) AS last_seen_at
FROM public.email_message_recipients r
JOIN public.email_messages m ON m.id = r.message_id
WHERE m.thread_id IS NOT NULL
GROUP BY m.thread_id, r.address;

-- Projects the sender maps to: through a contact address or a client domain.
CREATE TABLE IF NOT EXISTS public.email_message_candidates (
  message_id uuid NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('contact', 'domain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, project_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_email_message_candidates_project ON public.email_message_candidates (project_id);

CREATE TABLE IF NOT EXISTS public.email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  filename text NOT NULL DEFAULT '' CHECK (length(filename) <= 255),
  content_type text NOT NULL DEFAULT 'application/octet-stream' CHECK (length(content_type) BETWEEN 1 AND 255),
  -- The provider's declared size until stored, then the stored size.
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  -- Computed while the file is copied into storage.
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  provider_attachment_id text CHECK (provider_attachment_id IS NULL OR length(provider_attachment_id) <= 200),
  disposition text CHECK (disposition IN ('attachment', 'inline')),
  content_id text CHECK (content_id IS NULL OR length(content_id) <= 998),
  -- {inbox_id}/{message_id}/{attachment_id} in the inbound-email bucket, or
  -- NULL with a skipped_reason when the file was never stored.
  storage_path text,
  skipped_reason text CHECK (skipped_reason IN ('over_size_cap')),
  uploaded_at timestamptz,
  page_count integer CHECK (page_count IS NULL OR page_count >= 0),
  -- Display only, for the Inbox UI. Never a substitute for reading the file.
  agent_label text CHECK (agent_label IS NULL OR length(agent_label) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_attachments_message_position_key UNIQUE (message_id, position),
  CONSTRAINT email_attachments_stored_or_skipped CHECK ((storage_path IS NULL) <> (skipped_reason IS NULL)),
  CONSTRAINT email_attachments_uploaded_needs_path CHECK (uploaded_at IS NULL OR (storage_path IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS email_attachments_storage_path_key ON public.email_attachments (storage_path) WHERE storage_path IS NOT NULL;

DROP TRIGGER IF EXISTS set_email_attachments_updated_at ON public.email_attachments;
CREATE TRIGGER set_email_attachments_updated_at
  BEFORE UPDATE ON public.email_attachments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================
-- 5. Triage and task links
-- ============================================================

-- Every triage is kept; the newest per message wins.
CREATE TABLE IF NOT EXISTS public.email_triage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('no_action', 'task', 'needs_reply', 'needs_ciaran')),
  urgent boolean NOT NULL DEFAULT false,
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 4000),
  question_for_ciaran text CHECK (question_for_ciaran IS NULL OR length(question_for_ciaran) <= 4000),
  -- Copy-only text for a person to send from their own mail. Never sent.
  suggested_reply text CHECK (suggested_reply IS NULL OR length(suggested_reply) <= 20000),
  -- The project this triage chose (inferred) when the thread had none.
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  summarized_at timestamptz,
  -- The caller's retry key (the API takes 8 to 100 characters): the same key
  -- on the same email returns this triage instead of recording another.
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 100),
  -- sha256 of the request that used the key, so a reused key with another
  -- body is refused rather than replayed.
  request_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_triage_key_has_hash CHECK (idempotency_key IS NULL OR request_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_email_triage_message ON public.email_triage (message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_triage_unsummarized ON public.email_triage (message_id) WHERE summarized_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_triage_message_idempotency_key ON public.email_triage (message_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.email_task_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('created', 'updated')),
  triage_id uuid REFERENCES public.email_triage(id) ON DELETE SET NULL,
  linked_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_task_links_message_task_relation_key UNIQUE (message_id, task_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_email_task_links_task ON public.email_task_links (task_id);

-- Rule 3: a task linked to a source email only BECOMES ai_ready when a
-- person signed in to the app says so. Agent keys (service role) and
-- sessions without a user are refused.
CREATE OR REPLACE FUNCTION public.email_task_ai_ready_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ai_readiness = 'ai_ready'
    AND OLD.ai_readiness IS DISTINCT FROM 'ai_ready'
    AND EXISTS (SELECT 1 FROM public.email_task_links WHERE task_id = NEW.id)
    AND NOT public.is_human_session() THEN
    RAISE EXCEPTION 'EMAIL_TASK_HUMAN_ONLY: task % came from a client email; only a person signed in to the app can mark it ai_ready', NEW.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS email_task_ai_ready_guard ON public.tasks;
CREATE TRIGGER email_task_ai_ready_guard
  BEFORE UPDATE OF ai_readiness ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.email_task_ai_ready_guard();

-- The other door to the same rule: outside a human session, a task that is
-- already ai_ready cannot be linked as created from an email, nor linked at
-- all by the member who created it (create ai_ready, then link).
CREATE OR REPLACE FUNCTION public.email_task_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_readiness text;
  v_created_by uuid;
BEGIN
  SELECT ai_readiness, created_by INTO v_readiness, v_created_by FROM public.tasks WHERE id = NEW.task_id;
  IF v_readiness = 'ai_ready' AND NOT public.is_human_session()
    AND (NEW.relation = 'created' OR NEW.linked_by IS NULL OR v_created_by = NEW.linked_by) THEN
    RAISE EXCEPTION 'EMAIL_TASK_HUMAN_ONLY: task % is ai_ready; an email-sourced task can only be marked ai_ready by a person signed in to the app', NEW.task_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS email_task_link_guard ON public.email_task_links;
CREATE TRIGGER email_task_link_guard
  BEFORE INSERT OR UPDATE ON public.email_task_links
  FOR EACH ROW EXECUTE FUNCTION public.email_task_link_guard();

-- ============================================================
-- 6. Server-side writes (service role only)
-- ============================================================

-- Ingestion step 1: the message row (status receiving), its sender and
-- recipients, and its attachment rows (with their planned storage paths), in
-- one transaction, before any file is written. Idempotent on the provider's
-- id and on (inbox, Message-ID): a retried or duplicate delivery returns the
-- existing rows.
CREATE OR REPLACE FUNCTION public.email_start_message(
  p_inbox_id uuid,
  p_message jsonb,
  p_recipients jsonb,
  p_attachments jsonb,
  p_max_attachment_bytes bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_created boolean := false;
  v_attachment jsonb;
  v_position integer := 0;
  v_attachment_id uuid;
  v_size bigint;
  v_over boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;

  SELECT id INTO v_id FROM public.email_messages
  WHERE inbox_id = p_inbox_id AND provider = p_message->>'provider' AND provider_email_id = p_message->>'provider_email_id';

  IF v_id IS NULL THEN
    INSERT INTO public.email_messages (
      inbox_id, provider, provider_email_id, internet_message_id, in_reply_to, reference_ids,
      subject, subject_normalized, sent_at, received_at, text_body, html_body, new_text, is_forward,
      auth, auto_mail_reason
    ) VALUES (
      p_inbox_id,
      p_message->>'provider',
      p_message->>'provider_email_id',
      p_message->>'internet_message_id',
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_message->'in_reply_to', '[]'::jsonb))),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_message->'reference_ids', '[]'::jsonb))),
      COALESCE(p_message->>'subject', ''),
      COALESCE(p_message->>'subject_normalized', ''),
      (p_message->>'sent_at')::timestamptz,
      COALESCE((p_message->>'received_at')::timestamptz, now()),
      p_message->>'text_body',
      p_message->>'html_body',
      p_message->>'new_text',
      COALESCE((p_message->>'is_forward')::boolean, false),
      COALESCE(p_message->'auth', '{}'::jsonb),
      p_message->>'auto_mail_reason'
    )
    ON CONFLICT (inbox_id, internet_message_id) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      -- The same message, delivered again under another provider id.
      SELECT id INTO v_id FROM public.email_messages
      WHERE inbox_id = p_inbox_id AND internet_message_id = p_message->>'internet_message_id';
    ELSE
      v_created := true;
      UPDATE public.email_messages
      SET raw_storage_path = CASE WHEN COALESCE((p_message->>'has_raw')::boolean, false)
                                  THEN p_inbox_id::text || '/' || v_id::text || '/raw.eml' END
      WHERE id = v_id;

      INSERT INTO public.email_message_recipients (message_id, kind, address, name, position)
      SELECT v_id, r.value->>'kind', lower(btrim(r.value->>'address')), left(COALESCE(r.value->>'name', ''), 300), (r.ordinality - 1)::integer
      FROM jsonb_array_elements(COALESCE(p_recipients, '[]'::jsonb)) WITH ORDINALITY AS r(value, ordinality)
      ON CONFLICT DO NOTHING;

      FOR v_attachment IN SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb)) LOOP
        v_attachment_id := gen_random_uuid();
        v_size := (v_attachment->>'size_bytes')::bigint;
        v_over := v_size IS NOT NULL AND v_size > p_max_attachment_bytes;
        INSERT INTO public.email_attachments (
          id, message_id, position, filename, content_type, size_bytes, disposition, content_id,
          provider_attachment_id, storage_path, skipped_reason
        ) VALUES (
          v_attachment_id, v_id, v_position,
          left(COALESCE(v_attachment->>'filename', ''), 255),
          left(COALESCE(NULLIF(v_attachment->>'content_type', ''), 'application/octet-stream'), 255),
          v_size,
          v_attachment->>'disposition',
          v_attachment->>'content_id',
          v_attachment->>'provider_attachment_id',
          CASE WHEN v_over THEN NULL ELSE p_inbox_id::text || '/' || v_id::text || '/' || v_attachment_id::text END,
          CASE WHEN v_over THEN 'over_size_cap' END
        );
        v_position := v_position + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'created', v_created,
    'message', (
      SELECT jsonb_build_object('id', m.id, 'inbox_id', m.inbox_id, 'status', m.status,
        'raw_storage_path', m.raw_storage_path, 'raw_uploaded_at', m.raw_uploaded_at)
      FROM public.email_messages m WHERE m.id = v_id
    ),
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'position', a.position, 'filename', a.filename,
        'content_type', a.content_type, 'size_bytes', a.size_bytes, 'provider_attachment_id', a.provider_attachment_id,
        'storage_path', a.storage_path, 'skipped_reason', a.skipped_reason, 'uploaded_at', a.uploaded_at) ORDER BY a.position)
      FROM public.email_attachments a WHERE a.message_id = v_id
    ), '[]'::jsonb)
  );
END;
$$;

-- Ingestion step 2, after every planned file is stored: thread, mapping, status.
-- p_decision: { status: new|ignored, thread_id?: uuid (else a new thread),
--   project_id?: uuid (the mapped project, set only on a thread without one),
--   candidates: [{project_id, reason}], recipient_contacts: [{address, contact_id}] }
CREATE OR REPLACE FUNCTION public.email_complete_message(p_message_id uuid, p_decision jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message public.email_messages;
  v_thread uuid;
  v_status text := p_decision->>'status';
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF v_status NOT IN ('new', 'ignored') THEN RAISE EXCEPTION 'email_complete_message: status must be new or ignored' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_message FROM public.email_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002'; END IF;
  IF v_message.status <> 'receiving' THEN
    RETURN jsonb_build_object('already_complete', true, 'status', v_message.status, 'thread_id', v_message.thread_id);
  END IF;
  IF (v_message.raw_storage_path IS NOT NULL AND v_message.raw_uploaded_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.email_attachments WHERE message_id = p_message_id AND storage_path IS NOT NULL AND uploaded_at IS NULL) THEN
    RAISE EXCEPTION 'EMAIL_FILES_PENDING: message % still has files to store', p_message_id USING ERRCODE = 'P0001';
  END IF;

  IF p_decision->>'thread_id' IS NOT NULL THEN
    SELECT id INTO v_thread FROM public.email_threads
    WHERE id = (p_decision->>'thread_id')::uuid AND inbox_id = v_message.inbox_id
    FOR UPDATE;
    IF v_thread IS NULL THEN RAISE EXCEPTION 'email_complete_message: thread is not in this inbox' USING ERRCODE = '22023'; END IF;
    UPDATE public.email_threads SET last_message_at = GREATEST(last_message_at, v_message.received_at) WHERE id = v_thread;
  ELSE
    INSERT INTO public.email_threads (inbox_id, subject_normalized, last_message_at)
    VALUES (v_message.inbox_id, v_message.subject_normalized, v_message.received_at)
    RETURNING id INTO v_thread;
  END IF;

  -- A thread keeps its project once set.
  IF p_decision->>'project_id' IS NOT NULL THEN
    UPDATE public.email_threads SET project_id = (p_decision->>'project_id')::uuid, project_source = 'mapped'
    WHERE id = v_thread AND project_id IS NULL;
  END IF;

  INSERT INTO public.email_message_candidates (message_id, project_id, reason)
  SELECT p_message_id, (c->>'project_id')::uuid, c->>'reason'
  FROM jsonb_array_elements(COALESCE(p_decision->'candidates', '[]'::jsonb)) AS c
  ON CONFLICT DO NOTHING;

  UPDATE public.email_message_recipients r
  SET contact_id = (x->>'contact_id')::uuid
  FROM jsonb_array_elements(COALESCE(p_decision->'recipient_contacts', '[]'::jsonb)) AS x
  WHERE r.message_id = p_message_id AND r.address = x->>'address';

  UPDATE public.email_messages
  SET thread_id = v_thread,
      status = v_status,
      completed_at = now()
  WHERE id = p_message_id;

  UPDATE public.email_inboxes SET last_received_at = now() WHERE id = v_message.inbox_id;

  RETURN jsonb_build_object('already_complete', false, 'status', v_status, 'thread_id', v_thread);
END;
$$;

-- One triage: the triage row, its task links and the message status, and the
-- thread's project when the agent chose one for a thread without it. With an
-- idempotency key already used on this email it changes nothing: the same
-- request hash returns the first triage (replayed), another one is refused.
CREATE OR REPLACE FUNCTION public.email_record_triage(
  p_message_id uuid,
  p_member_id uuid,
  p_triage jsonb,
  p_links jsonb,
  p_project_id uuid,
  p_status text,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message public.email_messages;
  v_triage public.email_triage;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('handled', 'needs_ciaran') THEN RAISE EXCEPTION 'email_record_triage: invalid status' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_message FROM public.email_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status = 'receiving' THEN
    RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002';
  END IF;

  -- The message row lock above serializes retries of one key.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_triage FROM public.email_triage
    WHERE message_id = p_message_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_triage.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'EMAIL_IDEMPOTENCY_CONFLICT: this idempotency key was used for a different triage of message %', p_message_id USING ERRCODE = 'P0001';
      END IF;
      RETURN jsonb_build_object(
        'triage', to_jsonb(v_triage) - 'request_hash',
        'status', v_message.status,
        'thread', (SELECT jsonb_build_object('id', t.id, 'project_id', t.project_id, 'project_source', t.project_source)
                   FROM public.email_threads t WHERE t.id = v_message.thread_id),
        'replayed', true
      );
    END IF;
  END IF;

  IF p_project_id IS NOT NULL THEN
    UPDATE public.email_threads SET project_id = p_project_id, project_source = 'inferred'
    WHERE id = v_message.thread_id AND project_id IS NULL;
    IF NOT FOUND AND NOT EXISTS (
      SELECT 1 FROM public.email_threads WHERE id = v_message.thread_id AND project_id = p_project_id
    ) THEN
      RAISE EXCEPTION 'EMAIL_THREAD_PROJECT_SET: the thread already belongs to another project' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.email_triage (
    message_id, member_id, outcome, urgent, summary, question_for_ciaran, suggested_reply, project_id, idempotency_key, request_hash
  )
  VALUES (
    p_message_id, p_member_id, p_triage->>'outcome', COALESCE((p_triage->>'urgent')::boolean, false),
    p_triage->>'summary', p_triage->>'question_for_ciaran', p_triage->>'suggested_reply', p_project_id,
    p_idempotency_key, p_request_hash
  )
  RETURNING * INTO v_triage;

  INSERT INTO public.email_task_links (message_id, task_id, relation, triage_id, linked_by)
  SELECT p_message_id, (l->>'task_id')::uuid, l->>'relation', v_triage.id, p_member_id
  FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) AS l
  ON CONFLICT (message_id, task_id, relation) DO NOTHING;

  UPDATE public.email_messages SET status = p_status WHERE id = p_message_id;

  RETURN jsonb_build_object(
    'triage', to_jsonb(v_triage) - 'request_hash',
    'status', p_status,
    'thread', (SELECT jsonb_build_object('id', t.id, 'project_id', t.project_id, 'project_source', t.project_source)
               FROM public.email_threads t WHERE t.id = v_message.thread_id),
    'replayed', false
  );
END;
$$;

-- For the host dispatcher: is there new mail, and is anything waiting for
-- the batched summary. p_inbox_ids is a JSON array of inbox ids.
CREATE OR REPLACE FUNCTION public.email_signal(p_inbox_ids jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb)))
  SELECT jsonb_build_object(
    'new_count', (SELECT count(*) FROM public.email_messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'newest_received_at', (SELECT max(m.received_at) FROM public.email_messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'unsummarized_count', (
      SELECT count(DISTINCT t.message_id) FROM public.email_triage t
      JOIN public.email_messages m ON m.id = t.message_id
      WHERE m.inbox_id IN (SELECT id FROM inboxes) AND t.summarized_at IS NULL
    )
  )
$$;

-- The newest unsummarized triage per message, oldest message first, with
-- what the batched summary needs (no bodies).
CREATE OR REPLACE FUNCTION public.email_unsummarized_triage(p_inbox_ids jsonb, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb))),
  latest AS (
    SELECT DISTINCT ON (t.message_id) t.*
    FROM public.email_triage t
    JOIN public.email_messages m ON m.id = t.message_id
    WHERE m.inbox_id IN (SELECT id FROM inboxes)
      AND EXISTS (SELECT 1 FROM public.email_triage u WHERE u.message_id = t.message_id AND u.summarized_at IS NULL)
    ORDER BY t.message_id, t.created_at DESC, t.id DESC
  )
  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'created_at')), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'triage_id', l.id,
      'created_at', l.created_at,
      'outcome', l.outcome,
      'urgent', l.urgent,
      'summary', l.summary,
      'question_for_ciaran', l.question_for_ciaran,
      'has_suggested_reply', l.suggested_reply IS NOT NULL,
      'superseded_triage_ids', COALESCE((
        SELECT jsonb_agg(o.id) FROM public.email_triage o
        WHERE o.message_id = l.message_id AND o.id <> l.id AND o.summarized_at IS NULL
      ), '[]'::jsonb),
      'message', jsonb_build_object(
        'id', m.id, 'inbox_id', m.inbox_id, 'thread_id', m.thread_id, 'status', m.status,
        'subject', m.subject, 'received_at', m.received_at,
        'from', (SELECT jsonb_build_object('address', r.address, 'name', r.name)
                 FROM public.email_message_recipients r WHERE r.message_id = m.id AND r.kind = 'from')
      ),
      'project', CASE WHEN th.project_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', th.project_id, 'name', p.name, 'source', th.project_source) END,
      'links', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('task_id', k.task_id, 'relation', k.relation, 'title', tk.title, 'status', tk.status) ORDER BY k.created_at)
        FROM public.email_task_links k JOIN public.tasks tk ON tk.id = k.task_id
        WHERE k.message_id = m.id
      ), '[]'::jsonb)
    ) AS item
    FROM latest l
    JOIN public.email_messages m ON m.id = l.message_id
    LEFT JOIN public.email_threads th ON th.id = m.thread_id
    LEFT JOIN public.projects p ON p.id = th.project_id
    ORDER BY l.created_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
  ) items
$$;

-- Marks triage rows as summarized, with any older unsummarized triage of the
-- same messages (superseded, latest wins). All or nothing: an id outside
-- p_inbox_ids marks nothing and comes back in `missing`.
CREATE OR REPLACE FUNCTION public.email_mark_triage_summarized(p_triage_ids jsonb, p_inbox_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[] := ARRAY(SELECT DISTINCT (value)::uuid FROM jsonb_array_elements_text(COALESCE(p_triage_ids, '[]'::jsonb)));
  v_inboxes uuid[] := ARRAY(SELECT (value)::uuid FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb)));
  v_missing jsonb;
  v_marked integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_agg(i), '[]'::jsonb) INTO v_missing
  FROM unnest(v_ids) AS i
  WHERE NOT EXISTS (
    SELECT 1 FROM public.email_triage t JOIN public.email_messages m ON m.id = t.message_id
    WHERE t.id = i AND m.inbox_id = ANY(v_inboxes)
  );
  IF jsonb_array_length(v_missing) > 0 THEN
    RETURN jsonb_build_object('marked', 0, 'missing', v_missing);
  END IF;

  WITH chosen AS (SELECT id, message_id, created_at FROM public.email_triage WHERE id = ANY(v_ids)),
  marked AS (
    UPDATE public.email_triage t SET summarized_at = now()
    WHERE t.summarized_at IS NULL AND (
      t.id = ANY(v_ids)
      OR EXISTS (SELECT 1 FROM chosen c WHERE c.message_id = t.message_id AND t.created_at <= c.created_at)
    )
    RETURNING t.id
  )
  SELECT count(*) INTO v_marked FROM marked;
  RETURN jsonb_build_object('marked', v_marked, 'missing', '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.email_start_message(uuid, jsonb, jsonb, jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_complete_message(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_signal(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_unsummarized_triage(jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_mark_triage_summarized(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_start_message(uuid, jsonb, jsonb, jsonb, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_complete_message(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_signal(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_unsummarized_triage(jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_mark_triage_summarized(jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.sync_contact_email_mirror(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_human_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_human_session() TO authenticated, service_role;

-- ============================================================
-- 7. Row level security (people in the app; agents use the service client)
-- ============================================================

-- inbound_email.manage sees every inbox; inbound_email.read sees the inboxes
-- the member was granted.
CREATE OR REPLACE FUNCTION public.can_read_email_inbox(p_inbox_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_permission('inbound_email.manage', 'app')
    OR (
      public.has_permission('inbound_email.read', 'app')
      AND EXISTS (
        SELECT 1 FROM public.email_inbox_access a
        WHERE a.inbox_id = p_inbox_id AND a.member_id = public.current_team_member_id()
      )
    )
$$;

CREATE OR REPLACE FUNCTION public.can_read_email_message(p_message_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.email_messages m
    WHERE m.id = p_message_id AND public.can_read_email_inbox(m.inbox_id)
  )
$$;

REVOKE ALL ON FUNCTION public.can_read_email_inbox(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_read_email_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_email_inbox(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_read_email_message(uuid) TO authenticated, service_role;

ALTER TABLE public.contact_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_inbox_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_client_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_message_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_message_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_triage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_task_links ENABLE ROW LEVEL SECURITY;

-- contact_emails mirrors contacts.
DROP POLICY IF EXISTS contact_emails_select ON public.contact_emails;
CREATE POLICY contact_emails_select ON public.contact_emails FOR SELECT TO authenticated
  USING (public.has_permission('contacts.read_all') OR (
    public.has_permission('contacts.read') AND EXISTS (
      SELECT 1 FROM public.project_contacts pc
      WHERE pc.contact_id = contact_emails.contact_id AND public.can_access_project(pc.project_id)
    )
  ));
DROP POLICY IF EXISTS contact_emails_manage ON public.contact_emails;
CREATE POLICY contact_emails_manage ON public.contact_emails FOR ALL TO authenticated
  USING (public.has_permission('contacts.manage')) WITH CHECK (public.has_permission('contacts.manage'));

DROP POLICY IF EXISTS email_inboxes_select ON public.email_inboxes;
CREATE POLICY email_inboxes_select ON public.email_inboxes FOR SELECT TO authenticated
  USING (public.can_read_email_inbox(id));
DROP POLICY IF EXISTS email_inboxes_manage ON public.email_inboxes;
CREATE POLICY email_inboxes_manage ON public.email_inboxes FOR ALL TO authenticated
  USING (public.has_permission('inbound_email.manage')) WITH CHECK (public.has_permission('inbound_email.manage'));

DROP POLICY IF EXISTS email_inbox_access_select ON public.email_inbox_access;
CREATE POLICY email_inbox_access_select ON public.email_inbox_access FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.manage') OR member_id = public.current_team_member_id());
DROP POLICY IF EXISTS email_inbox_access_manage ON public.email_inbox_access;
CREATE POLICY email_inbox_access_manage ON public.email_inbox_access FOR ALL TO authenticated
  USING (public.has_permission('inbound_email.manage')) WITH CHECK (public.has_permission('inbound_email.manage'));

DROP POLICY IF EXISTS email_client_domains_select ON public.email_client_domains;
CREATE POLICY email_client_domains_select ON public.email_client_domains FOR SELECT TO authenticated
  USING (public.can_access_project(project_id) AND (
    public.has_permission('contacts.read') OR public.has_permission('inbound_email.read')
  ));
DROP POLICY IF EXISTS email_client_domains_manage ON public.email_client_domains;
CREATE POLICY email_client_domains_manage ON public.email_client_domains FOR ALL TO authenticated
  USING ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id))
  WITH CHECK ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id));

DROP POLICY IF EXISTS email_threads_select ON public.email_threads;
CREATE POLICY email_threads_select ON public.email_threads FOR SELECT TO authenticated
  USING (public.can_read_email_inbox(inbox_id));
DROP POLICY IF EXISTS email_messages_select ON public.email_messages;
CREATE POLICY email_messages_select ON public.email_messages FOR SELECT TO authenticated
  USING (public.can_read_email_inbox(inbox_id));
DROP POLICY IF EXISTS email_message_recipients_select ON public.email_message_recipients;
CREATE POLICY email_message_recipients_select ON public.email_message_recipients FOR SELECT TO authenticated
  USING (public.can_read_email_message(message_id));
DROP POLICY IF EXISTS email_message_candidates_select ON public.email_message_candidates;
CREATE POLICY email_message_candidates_select ON public.email_message_candidates FOR SELECT TO authenticated
  USING (public.can_read_email_message(message_id));
DROP POLICY IF EXISTS email_attachments_select ON public.email_attachments;
CREATE POLICY email_attachments_select ON public.email_attachments FOR SELECT TO authenticated
  USING (public.can_read_email_message(message_id));
DROP POLICY IF EXISTS email_triage_select ON public.email_triage;
CREATE POLICY email_triage_select ON public.email_triage FOR SELECT TO authenticated
  USING (public.can_read_email_message(message_id));
DROP POLICY IF EXISTS email_task_links_select ON public.email_task_links;
CREATE POLICY email_task_links_select ON public.email_task_links FOR SELECT TO authenticated
  USING (public.can_read_email_message(message_id));

-- ============================================================
-- 8. Private storage bucket
-- ============================================================
-- No storage.objects policies on purpose: only the service client touches
-- it (server-side copies from the provider, and short-lived signed reads).
-- 50 MiB per object; larger raw messages and attachments are not stored.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('inbound-email', 'inbound-email', false, 52428800)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;

-- ============================================================
-- 9. Permissions and the agent event
-- ============================================================
-- App: inbound_email.read opens the Inbox (granted inboxes), and
-- inbound_email.manage edits inbox settings and sees every inbox. API: read,
-- triage and signal, always narrowed to the key member's granted inboxes.
INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'inbound_email.read', 'app'),
  ('admin', 'inbound_email.manage', 'app'),
  ('agent', 'inbound_email.read', 'api'),
  ('agent', 'inbound_email.triage', 'api'),
  ('agent', 'inbound_email.signal', 'api')
ON CONFLICT DO NOTHING;

-- Ashley's existing key gets the email scopes. Keys are server-issued, so the
-- host dispatcher polls the signal with this same key rather than a separate
-- signal-only key. A no-op where Ashley does not exist.
UPDATE public.api_keys key
SET scopes = ARRAY(
  SELECT DISTINCT scope
  FROM unnest(COALESCE(key.scopes, '{}') || ARRAY['inbound_email.read', 'inbound_email.triage', 'inbound_email.signal']) AS scope
  ORDER BY scope
)
WHERE key.team_member_id = '656894b6-5ad3-498c-adad-1845eafe942a'::uuid
  AND key.revoked_at IS NULL
  AND NOT (COALESCE(key.scopes, '{}') @> ARRAY['inbound_email.read', 'inbound_email.triage', 'inbound_email.signal'])
  AND EXISTS (
    SELECT 1 FROM public.team_members member
    WHERE member.id = key.team_member_id AND member.role = 'agent'
  );

-- email.triaged is composed by the server at triage (src/lib/agent-events.ts).
ALTER TABLE public.agent_activities
  DROP CONSTRAINT IF EXISTS agent_activities_activity_type_check;
ALTER TABLE public.agent_activities
  ADD CONSTRAINT agent_activities_activity_type_check CHECK (activity_type IN (
    -- legacy vocabulary, grandfathered
    'suggestion_created', 'task_started', 'task_completed', 'task_failed',
    'research_started', 'research_completed', 'suggestion_reviewed',
    'comment_added', 'status_changed',
    'agent_spawned', 'agent_completed', 'agent_failed',
    'heartbeat', 'system_check',
    'custom',
    -- typed vocabulary (src/lib/agent-events.ts owns payloads and titles)
    'work.claimed', 'work.milestone', 'work.handoff', 'work.done',
    'pr.merged', 'usage.recorded', 'turn.completed',
    'review.started', 'review.verdict',
    'audit.finding', 'audit.no_work', 'spec.completed',
    'queue.empty', 'blocked',
    'billing.started', 'billing.paused', 'billing.resumed', 'billing.stopped',
    'email.triaged'
  ));

-- ============================================================
-- 10. Realtime
-- ============================================================
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'contact_emails', 'email_inboxes', 'email_inbox_access', 'email_client_domains',
    'email_threads', 'email_messages', 'email_message_recipients', 'email_message_candidates',
    'email_attachments', 'email_triage', 'email_task_links'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 11. Retention and the orphan sweep
-- ============================================================
-- Two Vercel crons (app/vercel.json) run these through the server, because
-- Supabase lets only the Storage API delete files. Retention lists what is
-- due, deletes its files, then its rows; a message whose files could not be
-- deleted keeps every row and is retried by the next run. Tasks are never
-- touched: an email's task links go with it, the tasks stay.

-- The last run of each job, for the inbox settings status.
CREATE TABLE IF NOT EXISTS public.email_maintenance_runs (
  kind text PRIMARY KEY CHECK (kind IN ('retention', 'orphan_sweep')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  -- complete: nothing failed and nothing due was left; partial: something
  -- failed or the run stopped at its budget (more_pending); failed: the run
  -- itself broke (last_error).
  outcome text NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed')),
  more_pending boolean NOT NULL DEFAULT false,
  -- Retention: messages past their inbox's retention_days, and messages
  -- stuck in receiving for over 24 hours.
  messages_deleted integer NOT NULL DEFAULT 0 CHECK (messages_deleted >= 0),
  stuck_deleted integer NOT NULL DEFAULT 0 CHECK (stuck_deleted >= 0),
  threads_deleted integer NOT NULL DEFAULT 0 CHECK (threads_deleted >= 0),
  -- Objects removed from the bucket (retention: the messages' files; sweep: orphans).
  files_deleted integer NOT NULL DEFAULT 0 CHECK (files_deleted >= 0),
  -- Sweep: objects listed in the bucket.
  objects_scanned integer NOT NULL DEFAULT 0 CHECK (objects_scanned >= 0),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000)
);

ALTER TABLE public.email_maintenance_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_maintenance_runs_select ON public.email_maintenance_runs;
CREATE POLICY email_maintenance_runs_select ON public.email_maintenance_runs FOR SELECT TO authenticated
  USING (public.has_permission('inbound_email.manage'));

-- The next batch of messages due for deletion, oldest first, with every file
-- path they own. Due: past the inbox's retention_days (any status but
-- receiving), or stuck in receiving for over 24 hours. p_exclude skips
-- messages whose files failed to delete earlier in the same run.
CREATE OR REPLACE FUNCTION public.email_retention_due(p_limit integer, p_exclude jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
    WITH excluded AS (
      SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_exclude, '[]'::jsonb))
    ),
    due AS (
      SELECT m.id, m.inbox_id, m.raw_storage_path, m.status, m.received_at, m.created_at
      FROM public.email_messages m
      JOIN public.email_inboxes i ON i.id = m.inbox_id
      WHERE (
          (m.status <> 'receiving' AND m.received_at < now() - make_interval(days => i.retention_days))
          OR (m.status = 'receiving' AND m.created_at < now() - interval '24 hours')
        )
        AND NOT EXISTS (SELECT 1 FROM excluded x WHERE x.id = m.id)
      ORDER BY LEAST(m.received_at, m.created_at), m.id
      LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500))
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id,
      'inbox_id', d.inbox_id,
      'reason', CASE WHEN d.status = 'receiving' THEN 'stuck_receiving' ELSE 'retention' END,
      'paths', to_jsonb(
        array_remove(ARRAY[d.raw_storage_path], NULL)
        || ARRAY(SELECT a.storage_path FROM public.email_attachments a
                 WHERE a.message_id = d.id AND a.storage_path IS NOT NULL ORDER BY a.position)
      )
    ) ORDER BY LEAST(d.received_at, d.created_at), d.id), '[]'::jsonb)
    FROM due d
  );
END;
$$;

-- Deletes the rows of messages whose files are already gone: attachments,
-- task links, triage, recipients, candidates, then the message, then any of
-- their threads left empty. Only messages still due are deleted (the rule of
-- email_retention_due; a stuck message that completed during this run still
-- goes, since its files are gone). Tasks are never touched.
CREATE OR REPLACE FUNCTION public.email_retention_delete(p_message_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested uuid[] := ARRAY(SELECT DISTINCT (value)::uuid FROM jsonb_array_elements_text(COALESCE(p_message_ids, '[]'::jsonb)));
  v_ids uuid[];
  v_threads uuid[];
  v_thread uuid;
  v_deleted jsonb;
  v_attachments integer;
  v_threads_deleted integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;

  -- Lock first, so ingestion cannot complete one of them halfway through.
  PERFORM 1 FROM public.email_messages WHERE id = ANY(v_requested) ORDER BY id FOR UPDATE;

  SELECT
    COALESCE(array_agg(m.id), '{}'),
    COALESCE(array_agg(DISTINCT m.thread_id) FILTER (WHERE m.thread_id IS NOT NULL), '{}'),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', m.id, 'inbox_id', m.inbox_id,
      'reason', CASE WHEN m.status <> 'receiving' AND m.received_at < now() - make_interval(days => i.retention_days)
                     THEN 'retention' ELSE 'stuck_receiving' END
    )), '[]'::jsonb)
  INTO v_ids, v_threads, v_deleted
  FROM public.email_messages m
  JOIN public.email_inboxes i ON i.id = m.inbox_id
  WHERE m.id = ANY(v_requested)
    AND (
      (m.status <> 'receiving' AND m.received_at < now() - make_interval(days => i.retention_days))
      OR (m.created_at < now() - interval '24 hours'
          AND (m.status = 'receiving' OR m.completed_at > now() - interval '15 minutes'))
    );

  DELETE FROM public.email_attachments WHERE message_id = ANY(v_ids);
  GET DIAGNOSTICS v_attachments = ROW_COUNT;
  DELETE FROM public.email_task_links WHERE message_id = ANY(v_ids);
  DELETE FROM public.email_triage WHERE message_id = ANY(v_ids);
  DELETE FROM public.email_message_recipients WHERE message_id = ANY(v_ids);
  DELETE FROM public.email_message_candidates WHERE message_id = ANY(v_ids);
  DELETE FROM public.email_messages WHERE id = ANY(v_ids);

  FOREACH v_thread IN ARRAY v_threads LOOP
    BEGIN
      DELETE FROM public.email_threads t
      WHERE t.id = v_thread AND NOT EXISTS (SELECT 1 FROM public.email_messages m WHERE m.thread_id = t.id);
      IF FOUND THEN v_threads_deleted := v_threads_deleted + 1; END IF;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL; -- a new message joined the thread meanwhile; it stays
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'skipped', COALESCE((SELECT jsonb_agg(r) FROM unnest(v_requested) AS r WHERE NOT (r = ANY(v_ids))), '[]'::jsonb),
    'attachments_deleted', v_attachments,
    'threads_deleted', v_threads_deleted
  );
END;
$$;

-- Of the given bucket paths, the ones a row still owns: a message's raw .eml,
-- an attachment's file, or anything under a message still being received
-- (created in the last 24 hours). Everything else is an orphan.
CREATE OR REPLACE FUNCTION public.email_storage_known_paths(p_paths jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
    WITH given AS (
      SELECT DISTINCT value AS path FROM jsonb_array_elements_text(COALESCE(p_paths, '[]'::jsonb))
    )
    SELECT COALESCE(jsonb_agg(g.path ORDER BY g.path), '[]'::jsonb)
    FROM given g
    WHERE EXISTS (SELECT 1 FROM public.email_messages m WHERE m.raw_storage_path = g.path)
      OR EXISTS (SELECT 1 FROM public.email_attachments a WHERE a.storage_path = g.path)
      OR EXISTS (
        SELECT 1 FROM public.email_messages m
        WHERE m.status = 'receiving'
          AND m.created_at >= now() - interval '24 hours'
          AND m.inbox_id::text = split_part(g.path, '/', 1)
          AND m.id::text = split_part(g.path, '/', 2)
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.email_record_maintenance_run(p_kind text, p_run jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.email_maintenance_runs AS r (
    kind, started_at, finished_at, outcome, more_pending, messages_deleted, stuck_deleted,
    threads_deleted, files_deleted, objects_scanned, failures, last_error
  ) VALUES (
    p_kind,
    (p_run->>'started_at')::timestamptz,
    COALESCE((p_run->>'finished_at')::timestamptz, now()),
    p_run->>'outcome',
    COALESCE((p_run->>'more_pending')::boolean, false),
    COALESCE((p_run->>'messages_deleted')::integer, 0),
    COALESCE((p_run->>'stuck_deleted')::integer, 0),
    COALESCE((p_run->>'threads_deleted')::integer, 0),
    COALESCE((p_run->>'files_deleted')::integer, 0),
    COALESCE((p_run->>'objects_scanned')::integer, 0),
    COALESCE((p_run->>'failures')::integer, 0),
    left(p_run->>'last_error', 2000)
  )
  ON CONFLICT (kind) DO UPDATE SET
    started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at, outcome = EXCLUDED.outcome,
    more_pending = EXCLUDED.more_pending, messages_deleted = EXCLUDED.messages_deleted,
    stuck_deleted = EXCLUDED.stuck_deleted, threads_deleted = EXCLUDED.threads_deleted,
    files_deleted = EXCLUDED.files_deleted, objects_scanned = EXCLUDED.objects_scanned,
    failures = EXCLUDED.failures, last_error = EXCLUDED.last_error;
END;
$$;

REVOKE ALL ON FUNCTION public.email_retention_due(integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_retention_delete(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_storage_known_paths(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_record_maintenance_run(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_retention_due(integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_retention_delete(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_storage_known_paths(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_record_maintenance_run(text, jsonb) TO service_role;
