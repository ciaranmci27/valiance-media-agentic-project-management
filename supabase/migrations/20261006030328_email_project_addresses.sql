-- Per-project email addresses.
--
-- A project can have its own addresses. A client writes to, say,
-- p4tf@valiancemedia.com; a forwarder set up by hand at the mail host sends
-- it on to p4tf@relay.valiancemedia.com; ingestion matches that routing
-- address like an inbox's, delivers the email to the inbox the address names
-- (so that inbox's handler triages it) and files a new thread on the project.
-- A project may have several addresses, so an address can change without
-- dropping mail from clients still using the old one: add the new one and
-- turn the old one off later (or edit it in place, which retires the old one
-- at once).
--
-- Settled rules this file enforces in the database:
-- - A routing address belongs to one inbox or one project address, never
--   both (email_routing_address_guard on both tables; inbox routing
--   addresses were already unique among inboxes, project addresses are
--   unique among themselves). Addresses are stored lowercased, so this is
--   case-insensitive.
-- - The project an address sets is a person's decision (project_source
--   'address', with project_address_id), final like 'ciaran': mapping and the
--   agent only ever fill a thread that has no project.
-- - A disabled address, or one whose inbox is disabled, is unknown: the app
--   drops its mail, the same as an unknown inbox address.
-- - last_received_at on an address: when mail last came through it (set by
--   email_complete_message for every message that matched it, a reply on a
--   thread already filed included), so the UI can say it is connected. A
--   new routing or public address clears it: the new route waits for its
--   first email again.
--
-- Also in this file, for ingestion of every inbox: a file (attachment or raw
-- .eml) that keeps failing to download or store no longer holds its message
-- in receiving until retention deletes it (section 6, email_files_failed).
--
-- And client sender addresses (section 7): one exact client address, such as
-- bob@gmail.com, maps its mail to a project without making the person a
-- contact (candidate reason 'sender').
--
-- And forwards and copies from the team (section 8): the visible sender
-- decides a message's project, unless it is a verified teammate; then a
-- forward routes by its original sender, and a teammate's own email copied
-- to the inbox by the client addresses in To and Cc (routing_basis).
--
-- And the agent's guess (section 9): a project the agent picks for a thread
-- whose email matched no project is 'guessed', not 'inferred' (chosen among
-- the mapping candidates); the batched summary reads the triage's project
-- and how each email was routed.
--
-- Safe to re-run.

-- ============================================================
-- 1. Project addresses
-- ============================================================

CREATE TABLE IF NOT EXISTS public.email_project_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  -- The inbox that receives the mail; its handler triages it.
  inbox_id uuid NOT NULL REFERENCES public.email_inboxes(id) ON DELETE CASCADE,
  -- <local>@<domain>, where the forwarder delivers and what ingestion looks
  -- up, as on email_inboxes. The domain defaults to
  -- business_settings.inbound_email_domain and the local part to the public
  -- address's, when left empty (email_project_addresses_before_write).
  routing_domain text NOT NULL CHECK (routing_domain = lower(btrim(routing_domain)) AND public.email_is_hostname(routing_domain)),
  routing_local_part text NOT NULL CHECK (routing_local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  routing_address text GENERATED ALWAYS AS (routing_local_part || '@' || routing_domain) STORED,
  -- What clients see, e.g. p4tf@valiancemedia.com: display and the forwarder
  -- instructions only, never matched.
  public_address text CHECK (public_address IS NULL OR (public_address = lower(btrim(public_address)) AND public.email_is_address(public_address))),
  enabled boolean NOT NULL DEFAULT true,
  -- When mail last came through this address (email_complete_message).
  last_received_at timestamptz,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_project_addresses_routing_address_key UNIQUE (routing_address)
);
ALTER TABLE public.email_project_addresses ADD COLUMN IF NOT EXISTS last_received_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_email_project_addresses_project ON public.email_project_addresses (project_id);
CREATE INDEX IF NOT EXISTS idx_email_project_addresses_inbox ON public.email_project_addresses (inbox_id);

CREATE OR REPLACE FUNCTION public.email_project_addresses_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
BEGIN
  NEW.public_address := NULLIF(lower(btrim(COALESCE(NEW.public_address, ''))), '');
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

DROP TRIGGER IF EXISTS email_project_addresses_before_write ON public.email_project_addresses;
CREATE TRIGGER email_project_addresses_before_write
  BEFORE INSERT OR UPDATE ON public.email_project_addresses
  FOR EACH ROW EXECUTE FUNCTION public.email_project_addresses_before_write();

-- ============================================================
-- 2. One routing address, one owner
-- ============================================================

-- After the row is written, so the generated routing_address is final. The
-- advisory lock takes writers to either table one at a time, so two
-- concurrent writes of the same address cannot both pass.
CREATE OR REPLACE FUNCTION public.email_routing_address_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.routing_address IS NOT DISTINCT FROM OLD.routing_address THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.email_routing_address'));
  IF TG_TABLE_NAME = 'email_inboxes' THEN
    IF EXISTS (SELECT 1 FROM public.email_project_addresses WHERE routing_address = NEW.routing_address) THEN
      RAISE EXCEPTION 'EMAIL_ROUTING_ADDRESS_TAKEN: % is a project email address', NEW.routing_address
        USING ERRCODE = '23505', CONSTRAINT = 'email_routing_address_guard';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.email_inboxes WHERE routing_address = NEW.routing_address) THEN
    RAISE EXCEPTION 'EMAIL_ROUTING_ADDRESS_TAKEN: % is an inbox routing address', NEW.routing_address
      USING ERRCODE = '23505', CONSTRAINT = 'email_routing_address_guard';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS email_inboxes_routing_address_guard ON public.email_inboxes;
CREATE TRIGGER email_inboxes_routing_address_guard
  AFTER INSERT OR UPDATE ON public.email_inboxes
  FOR EACH ROW EXECUTE FUNCTION public.email_routing_address_guard();

DROP TRIGGER IF EXISTS email_project_addresses_routing_address_guard ON public.email_project_addresses;
CREATE TRIGGER email_project_addresses_routing_address_guard
  AFTER INSERT OR UPDATE ON public.email_project_addresses
  FOR EACH ROW EXECUTE FUNCTION public.email_routing_address_guard();

-- An inbox's generated local part also steps around project addresses, and
-- a new routing address clears last_received_at as well as verified_at, so
-- the connect status waits for mail on the new route.
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
    ) OR EXISTS (
      SELECT 1 FROM public.email_project_addresses
      WHERE routing_local_part = v_candidate AND routing_domain = NEW.routing_domain
    ) LOOP
      v_candidate := v_base || '-' || substr(md5(random()::text), 1, 4);
    END LOOP;
    NEW.routing_local_part := v_candidate;
  ELSE
    NEW.routing_local_part := lower(btrim(NEW.routing_local_part));
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.routing_domain IS DISTINCT FROM OLD.routing_domain OR NEW.routing_local_part IS DISTINCT FROM OLD.routing_local_part THEN
      -- A new route: verify again, and it waits for its first email again.
      NEW.verified_at := NULL;
      NEW.last_received_at := NULL;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- 3. Threads: the 'address' source
-- ============================================================

-- project_source also takes 'guessed' (section 9): the agent picked the
-- project for an email with no mapping candidates. Like 'inferred' it waits
-- for a person to confirm it ('ciaran').

-- project_address_id: the project address that filed the thread, while its
-- source is 'address'. A deleted address leaves the project in place.
ALTER TABLE public.email_threads
  ADD COLUMN IF NOT EXISTS project_address_id uuid REFERENCES public.email_project_addresses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_email_threads_project_address ON public.email_threads (project_address_id) WHERE project_address_id IS NOT NULL;

ALTER TABLE public.email_threads DROP CONSTRAINT IF EXISTS email_threads_project_source_check;
ALTER TABLE public.email_threads
  ADD CONSTRAINT email_threads_project_source_check CHECK (project_source IN ('mapped', 'inferred', 'guessed', 'ciaran', 'address'));
ALTER TABLE public.email_threads DROP CONSTRAINT IF EXISTS email_threads_project_address_check;
ALTER TABLE public.email_threads
  ADD CONSTRAINT email_threads_project_address_check CHECK (project_address_id IS NULL OR project_source = 'address');

-- A deleted project nulls project_id (ON DELETE SET NULL); its source goes
-- too. Any other source than 'address' drops the address.
CREATE OR REPLACE FUNCTION public.email_threads_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS NULL THEN NEW.project_source := NULL; END IF;
  IF NEW.project_source IS DISTINCT FROM 'address' THEN NEW.project_address_id := NULL; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Ingestion step 2, after every planned file is stored: thread, mapping, status.
-- p_decision: { status: new|ignored, thread_id?: uuid (else a new thread),
--   project_id?: uuid (set only on a thread without one),
--   project_source?: mapped (default, a contact or domain) | address (the
--   project's own address, with project_address_id),
--   project_address_id?: uuid,
--   received_via_address_id?: uuid (the project address the email matched,
--   whether or not it sets the project: its last_received_at is stamped),
--   routing_basis?: sender (default) | forwarded_original | team_recipients,
--   forwarded_by_member_id?: uuid (the verified teammate, when not sender),
--   original_from_address?, original_from_name? (forwarded_original only),
--   candidates: [{project_id, reason}], recipient_contacts: [{address, contact_id}] }
-- The routing columns are added in section 8.
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
  v_source text := COALESCE(p_decision->>'project_source', 'mapped');
  v_basis text := COALESCE(p_decision->>'routing_basis', 'sender');
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF v_status NOT IN ('new', 'ignored') THEN RAISE EXCEPTION 'email_complete_message: status must be new or ignored' USING ERRCODE = '22023'; END IF;
  IF v_source NOT IN ('mapped', 'address') THEN RAISE EXCEPTION 'email_complete_message: project_source must be mapped or address' USING ERRCODE = '22023'; END IF;
  IF v_basis NOT IN ('sender', 'forwarded_original', 'team_recipients') THEN
    RAISE EXCEPTION 'email_complete_message: routing_basis must be sender, forwarded_original or team_recipients' USING ERRCODE = '22023';
  END IF;

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

  -- A thread keeps its project once set. An address deleted since it was
  -- matched still files the project, without the address.
  IF p_decision->>'project_id' IS NOT NULL THEN
    UPDATE public.email_threads
    SET project_id = (p_decision->>'project_id')::uuid,
        project_source = v_source,
        project_address_id = CASE WHEN v_source = 'address' THEN (
          SELECT a.id FROM public.email_project_addresses a WHERE a.id = (p_decision->>'project_address_id')::uuid
        ) END
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

  -- A teammate deleted since ingestion read them leaves no forwarder.
  UPDATE public.email_messages
  SET thread_id = v_thread,
      status = v_status,
      completed_at = now(),
      routing_basis = v_basis,
      forwarded_by_member_id = CASE WHEN v_basis <> 'sender' THEN (
        SELECT tm.id FROM public.team_members tm WHERE tm.id = (p_decision->>'forwarded_by_member_id')::uuid
      ) END,
      original_from_address = CASE WHEN v_basis = 'forwarded_original' THEN lower(btrim(p_decision->>'original_from_address')) END,
      original_from_name = CASE WHEN v_basis = 'forwarded_original'
        THEN NULLIF(left(btrim(COALESCE(p_decision->>'original_from_name', '')), 300), '') END
  WHERE id = p_message_id;

  UPDATE public.email_inboxes SET last_received_at = now() WHERE id = v_message.inbox_id;
  IF p_decision->>'received_via_address_id' IS NOT NULL THEN
    UPDATE public.email_project_addresses SET last_received_at = now()
    WHERE id = (p_decision->>'received_via_address_id')::uuid AND inbox_id = v_message.inbox_id;
  END IF;

  RETURN jsonb_build_object('already_complete', false, 'status', v_status, 'thread_id', v_thread);
END;
$$;

REVOKE ALL ON FUNCTION public.email_complete_message(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_complete_message(uuid, jsonb) TO service_role;

-- ============================================================
-- 4. Row level security (mirrors email_client_domains)
-- ============================================================

ALTER TABLE public.email_project_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_project_addresses_select ON public.email_project_addresses;
CREATE POLICY email_project_addresses_select ON public.email_project_addresses FOR SELECT TO authenticated
  USING (public.can_access_project(project_id) AND (
    public.has_permission('contacts.read') OR public.has_permission('inbound_email.read')
  ));
DROP POLICY IF EXISTS email_project_addresses_manage ON public.email_project_addresses;
CREATE POLICY email_project_addresses_manage ON public.email_project_addresses FOR ALL TO authenticated
  USING ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id))
  WITH CHECK ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id));

-- ============================================================
-- 5. Realtime
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'email_project_addresses'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.email_project_addresses;
  END IF;
END $$;

-- ============================================================
-- 6. Files that keep failing
-- ============================================================

-- file_failures: ingestion runs of a receiving message in which a file
-- failed to download or store. download_failed: the file was given up on,
-- so the email could arrive without it. The skipped_reason check was
-- defined inline in 20261006010922_email_inboxes.sql, so Postgres named it
-- email_attachments_skipped_reason_check; it is replaced by that name.
ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS file_failures integer NOT NULL DEFAULT 0 CHECK (file_failures >= 0);
ALTER TABLE public.email_attachments DROP CONSTRAINT IF EXISTS email_attachments_skipped_reason_check;
ALTER TABLE public.email_attachments
  ADD CONSTRAINT email_attachments_skipped_reason_check CHECK (skipped_reason IN ('over_size_cap', 'download_failed'));

-- Ingestion, when files of a receiving message failed in this run:
-- p_attachment_ids the attachments that failed, p_raw whether the raw .eml
-- did. Counts the failed run. From the p_max_failures-th failed run, or once
-- the message is p_max_age_minutes old, it gives up on those files: each
-- attachment is skipped as download_failed and the raw .eml is dropped (its
-- parsed bodies stand), so the message completes without them instead of
-- staying in receiving until retention deletes it. Anything already stored
-- under a dropped path is an orphan for the weekly sweep.
CREATE OR REPLACE FUNCTION public.email_files_failed(
  p_message_id uuid,
  p_attachment_ids jsonb,
  p_raw boolean,
  p_max_failures integer,
  p_max_age_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message public.email_messages;
  v_give_up boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;

  UPDATE public.email_messages SET file_failures = file_failures + 1
  WHERE id = p_message_id AND status = 'receiving'
  RETURNING * INTO v_message;
  IF NOT FOUND THEN RETURN jsonb_build_object('receiving', false, 'gave_up', false, 'failures', 0); END IF;

  v_give_up := v_message.file_failures >= p_max_failures
    OR v_message.created_at < now() - make_interval(mins => p_max_age_minutes);
  IF v_give_up THEN
    UPDATE public.email_attachments
    SET storage_path = NULL, skipped_reason = 'download_failed'
    WHERE message_id = p_message_id AND storage_path IS NOT NULL AND uploaded_at IS NULL
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_attachment_ids, '[]'::jsonb)));
    IF p_raw THEN
      UPDATE public.email_messages SET raw_storage_path = NULL WHERE id = p_message_id AND raw_uploaded_at IS NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object('receiving', true, 'gave_up', v_give_up, 'failures', v_message.file_failures);
END;
$$;

REVOKE ALL ON FUNCTION public.email_files_failed(uuid, jsonb, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_files_failed(uuid, jsonb, boolean, integer, integer) TO service_role;

-- ============================================================
-- 7. Client sender addresses
-- ============================================================

-- Mail from one exact client address maps to the project, the way a client
-- domain does for everyone at it, without making the person a contact.
-- Public email services are allowed here (that is the point: a client who
-- writes from bob@gmail.com). An address may map to several projects; then
-- the agent chooses among them. Stored lowercased, so matching is
-- case-insensitive.
CREATE TABLE IF NOT EXISTS public.email_client_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address = lower(btrim(address)) AND public.email_is_address(address)),
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_client_addresses_project_address_key UNIQUE (project_id, address)
);
CREATE INDEX IF NOT EXISTS idx_email_client_addresses_address ON public.email_client_addresses (address);

-- A candidate's reason gains 'sender' (a client sender address). The check
-- was defined inline in 20261006010922_email_inboxes.sql, so Postgres named
-- it email_message_candidates_reason_check; it is replaced by that name.
ALTER TABLE public.email_message_candidates DROP CONSTRAINT IF EXISTS email_message_candidates_reason_check;
ALTER TABLE public.email_message_candidates
  ADD CONSTRAINT email_message_candidates_reason_check CHECK (reason IN ('contact', 'domain', 'sender'));

-- Row level security mirrors email_client_domains.
ALTER TABLE public.email_client_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_client_addresses_select ON public.email_client_addresses;
CREATE POLICY email_client_addresses_select ON public.email_client_addresses FOR SELECT TO authenticated
  USING (public.can_access_project(project_id) AND (
    public.has_permission('contacts.read') OR public.has_permission('inbound_email.read')
  ));
DROP POLICY IF EXISTS email_client_addresses_manage ON public.email_client_addresses;
CREATE POLICY email_client_addresses_manage ON public.email_client_addresses FOR ALL TO authenticated
  USING ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id))
  WITH CHECK ((public.has_permission('contacts.manage') OR public.has_permission('inbound_email.manage')) AND public.can_access_project(project_id));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'email_client_addresses'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.email_client_addresses;
  END IF;
END $$;

-- ============================================================
-- 8. Forwards and copies from the team
-- ============================================================

-- The visible sender decides a message's project, unless it is a verified
-- teammate: an active person on the team (not an agent) whose email is the
-- From address, with sender trust 'trusted'. Then ingestion looks one layer
-- deeper (email_complete_message writes these):
-- routing_basis: sender (the From address decided; the default),
--   forwarded_original (a teammate forwarded it: the original sender of the
--   outermost forwarded message decided, original_from_address and _name), or
--   team_recipients (a teammate wrote it and copied the inbox: the client
--   addresses in To and Cc decided).
-- forwarded_by_member_id: that teammate, for both of the latter. auth stays
-- the verdict on the outer message.
ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS routing_basis text NOT NULL DEFAULT 'sender'
    CHECK (routing_basis IN ('sender', 'forwarded_original', 'team_recipients')),
  ADD COLUMN IF NOT EXISTS forwarded_by_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS original_from_address text
    CHECK (original_from_address IS NULL OR (original_from_address = lower(btrim(original_from_address)) AND length(original_from_address) BETWEEN 3 AND 320)),
  ADD COLUMN IF NOT EXISTS original_from_name text CHECK (original_from_name IS NULL OR length(original_from_name) <= 300);

-- The original sender belongs to a forward only; the forwarder to anything
-- but the sender basis (it may be null there once that teammate is deleted).
ALTER TABLE public.email_messages DROP CONSTRAINT IF EXISTS email_messages_routing_check;
ALTER TABLE public.email_messages ADD CONSTRAINT email_messages_routing_check CHECK (
  (original_from_address IS NOT NULL) = (routing_basis = 'forwarded_original')
  AND (original_from_name IS NULL OR routing_basis = 'forwarded_original')
  AND (forwarded_by_member_id IS NULL OR routing_basis <> 'sender')
);
CREATE INDEX IF NOT EXISTS idx_email_messages_forwarded_by ON public.email_messages (forwarded_by_member_id) WHERE forwarded_by_member_id IS NOT NULL;

-- ============================================================
-- 9. The agent's guess, and the batched summary
-- ============================================================

-- A triage's project_id sets the thread's project (only while it has none)
-- as inferred when the email had mapping candidates (the agent chose among
-- them) and as guessed when it had none. Otherwise as in
-- 20261006010922_email_inboxes.sql.
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

  -- inferred: chosen among the message's mapping candidates; guessed: the
  -- message had none, so nothing in it matched a project.
  IF p_project_id IS NOT NULL THEN
    UPDATE public.email_threads
    SET project_id = p_project_id,
        project_source = CASE WHEN EXISTS (SELECT 1 FROM public.email_message_candidates c WHERE c.message_id = p_message_id)
          THEN 'inferred' ELSE 'guessed' END
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

-- The newest unsummarized triage per message, as before, plus the triage's
-- own project_id and how each email was routed (routing_basis,
-- forwarded_by { member_id, name }, original_sender { address, name }, as
-- in the agent API). project.source carries guessed to the summary.
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
      'project_id', l.project_id,
      'superseded_triage_ids', COALESCE((
        SELECT jsonb_agg(o.id) FROM public.email_triage o
        WHERE o.message_id = l.message_id AND o.id <> l.id AND o.summarized_at IS NULL
      ), '[]'::jsonb),
      'message', jsonb_build_object(
        'id', m.id, 'inbox_id', m.inbox_id, 'thread_id', m.thread_id, 'status', m.status,
        'subject', m.subject, 'received_at', m.received_at,
        'from', (SELECT jsonb_build_object('address', r.address, 'name', r.name)
                 FROM public.email_message_recipients r WHERE r.message_id = m.id AND r.kind = 'from'),
        'routing_basis', m.routing_basis,
        'forwarded_by', CASE WHEN m.routing_basis <> 'sender' AND m.forwarded_by_member_id IS NOT NULL THEN jsonb_build_object(
          'member_id', m.forwarded_by_member_id,
          'name', (SELECT tm.name FROM public.team_members tm WHERE tm.id = m.forwarded_by_member_id)) END,
        'original_sender', CASE WHEN m.routing_basis = 'forwarded_original' THEN jsonb_build_object(
          'address', m.original_from_address, 'name', COALESCE(m.original_from_name, '')) END
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

REVOKE ALL ON FUNCTION public.email_record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_unsummarized_triage(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_unsummarized_triage(jsonb, integer) TO service_role;
