-- Inbound email moves out of public into its own schema, communications,
-- under channel-neutral names, ready for SMS and chat beside it:
--   email_inboxes -> inboxes, email_inbox_access -> inbox_access,
--   email_client_domains -> client_domains, email_client_addresses -> client_addresses,
--   email_project_addresses -> endpoints, email_threads -> conversations,
--   email_sender_rules -> sender_rules, email_messages -> messages,
--   email_message_recipients -> participants, email_message_candidates -> message_candidates,
--   email_files -> files, email_attachments -> attachments, email_triage -> triage,
--   email_task_links -> task_links, email_reply_drafts -> reply_drafts,
--   email_question_answers -> answers, email_maintenance_runs -> maintenance_runs,
--   email_thread_participants -> conversation_participants (view).
-- Tables move in place (ALTER TABLE ... SET SCHEMA): every row, id, index,
-- constraint, foreign key in (reminders.source_message_id,
-- task_files.email_attachment_id) and realtime membership goes with them.
-- Functions are recreated in communications under new names and the public
-- ones dropped. New: a channel column on endpoints, conversations and
-- messages; messages.sender_member_id and sender_verified; the projects of a
-- conversation in conversation_projects (one per conversation for now, with
-- conversations.project_* kept as a copy by trigger); message_endpoints; and
-- set_conversation_project for a person filing a conversation.
-- A snapshot of every table, as it was, stays in communications_legacy.
--
-- Apply before the code that reads communications deploys, then add
-- communications to the API's exposed schemas (Settings > Data API).
-- Safe to re-run: every step checks what is already there.

BEGIN;

-- ── Schemas ──────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS communications;
REVOKE ALL ON SCHEMA communications FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA communications TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA communications GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA communications GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

CREATE SCHEMA IF NOT EXISTS communications_legacy;
REVOKE ALL ON SCHEMA communications_legacy FROM PUBLIC, anon, authenticated;

-- ── Snapshot, then move ──────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  IF to_regclass('public.email_messages') IS NOT NULL THEN
    PERFORM set_config('communications.moved_now', 'yes', true);
  END IF;
  FOREACH t IN ARRAY ARRAY['email_inboxes', 'email_inbox_access', 'email_client_domains', 'email_client_addresses', 'email_project_addresses', 'email_threads', 'email_sender_rules', 'email_messages', 'email_message_recipients', 'email_message_candidates', 'email_files', 'email_attachments', 'email_triage', 'email_task_links', 'email_reply_drafts', 'email_question_answers', 'email_maintenance_runs'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND to_regclass('communications_legacy.' || t) IS NULL THEN
      EXECUTE format('CREATE TABLE communications_legacy.%I AS TABLE public.%I', t, t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA communications_legacy FROM PUBLIC, anon, authenticated;

ALTER TABLE IF EXISTS public.email_inboxes SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_inboxes RENAME TO inboxes;
ALTER TABLE IF EXISTS public.email_inbox_access SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_inbox_access RENAME TO inbox_access;
ALTER TABLE IF EXISTS public.email_client_domains SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_client_domains RENAME TO client_domains;
ALTER TABLE IF EXISTS public.email_client_addresses SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_client_addresses RENAME TO client_addresses;
ALTER TABLE IF EXISTS public.email_project_addresses SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_project_addresses RENAME TO endpoints;
ALTER TABLE IF EXISTS public.email_threads SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_threads RENAME TO conversations;
ALTER TABLE IF EXISTS public.email_sender_rules SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_sender_rules RENAME TO sender_rules;
ALTER TABLE IF EXISTS public.email_messages SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_messages RENAME TO messages;
ALTER TABLE IF EXISTS public.email_message_recipients SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_message_recipients RENAME TO participants;
ALTER TABLE IF EXISTS public.email_message_candidates SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_message_candidates RENAME TO message_candidates;
ALTER TABLE IF EXISTS public.email_files SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_files RENAME TO files;
ALTER TABLE IF EXISTS public.email_attachments SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_attachments RENAME TO attachments;
ALTER TABLE IF EXISTS public.email_triage SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_triage RENAME TO triage;
ALTER TABLE IF EXISTS public.email_task_links SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_task_links RENAME TO task_links;
ALTER TABLE IF EXISTS public.email_reply_drafts SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_reply_drafts RENAME TO reply_drafts;
ALTER TABLE IF EXISTS public.email_question_answers SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_question_answers RENAME TO answers;
ALTER TABLE IF EXISTS public.email_maintenance_runs SET SCHEMA communications;
ALTER TABLE IF EXISTS communications.email_maintenance_runs RENAME TO maintenance_runs;
ALTER VIEW IF EXISTS public.email_thread_participants SET SCHEMA communications;
ALTER VIEW IF EXISTS communications.email_thread_participants RENAME TO conversation_participants;

-- Constraints Postgres named after the table (unnamed in CREATE TABLE) take
-- the new table's name, as a fresh schema.sql would give them; the ones
-- schema.sql names itself keep their names.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS rel, x.was, x.now
    FROM pg_constraint c
    JOIN (VALUES ('email_inboxes', 'inboxes'), ('email_inbox_access', 'inbox_access'), ('email_client_domains', 'client_domains'), ('email_client_addresses', 'client_addresses'), ('email_project_addresses', 'endpoints'), ('email_threads', 'conversations'), ('email_sender_rules', 'sender_rules'), ('email_messages', 'messages'), ('email_message_recipients', 'participants'), ('email_message_candidates', 'message_candidates'), ('email_files', 'files'), ('email_attachments', 'attachments'), ('email_triage', 'triage'), ('email_task_links', 'task_links'), ('email_reply_drafts', 'reply_drafts'), ('email_question_answers', 'answers'), ('email_maintenance_runs', 'maintenance_runs')) AS x(was, now)
      ON c.conrelid = to_regclass('communications.' || x.now)
    WHERE starts_with(c.conname, x.was || '_')
      AND c.conname <> ALL (ARRAY['team_members_role_check', 'team_members_status_check', 'api_keys_permissions_check', 'projects_client_time_billing_check', 'project_time_entries_work_type_check', 'project_time_entries_approval_status_check', 'project_time_entries_compensation_rate_check', 'team_member_payout_allocations_one_source', 'team_member_payout_allocations_source_key', 'email_inboxes_routing_address_key', 'email_inboxes_verification_code_key', 'email_client_domains_domain_project_key', 'email_client_addresses_project_address_key', 'endpoints_channel_check', 'email_project_addresses_routing_address_key', 'email_threads_summary_check', 'conversations_channel_check', 'email_threads_project_source_check', 'email_threads_project_pair_check', 'email_threads_project_address_check', 'email_messages_status_check', 'email_messages_kind_check', 'email_messages_topic_check', 'email_messages_sort_action_check', 'email_messages_sort_reason_check', 'messages_channel_check', 'email_messages_inbox_message_key', 'email_messages_inbox_provider_key', 'email_messages_thread_when_complete', 'email_messages_raw_stored_with_hash', 'email_messages_routing_check', 'email_message_recipients_message_kind_address_key', 'conversation_projects_source_check', 'conversation_projects_endpoint_check', 'email_attachments_message_position_key', 'email_attachments_uploaded_needs_path', 'email_attachments_stored_or_skipped', 'email_attachments_file_not_skipped', 'email_triage_outcome_check', 'email_triage_question_for_human_check', 'email_triage_key_has_hash', 'email_task_links_relation_check', 'email_task_links_message_task_relation_key', 'email_reply_drafts_ready_has_body', 'email_reply_drafts_done_has_time', 'project_billing_plans_weeks_anchor', 'project_billing_plans_amount', 'project_billing_plans_cap', 'project_billing_plans_dates', 'project_billing_runs_project_key', 'reminders_time_needs_date', 'reminders_done_has_completed_at', 'reminders_closed_by_task_is_done', 'tasks_created_by_key_id_fkey', 'task_files_one_source', 'task_events_via_check', 'task_events_kind_check'])
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.rel, r.conname, r.now || substr(r.conname, length(r.was) + 1));
  END LOOP;
END $$;

-- ── New columns and tables ───────────────────────────────────
ALTER TABLE communications.endpoints
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email' CONSTRAINT endpoints_channel_check CHECK (channel IN ('email'));
ALTER TABLE communications.conversations
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email' CONSTRAINT conversations_channel_check CHECK (channel IN ('email'));
ALTER TABLE communications.messages
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email' CONSTRAINT messages_channel_check CHECK (channel IN ('email'));
ALTER TABLE communications.messages
  ADD COLUMN IF NOT EXISTS sender_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL;
ALTER TABLE communications.messages
  ADD COLUMN IF NOT EXISTS sender_verified boolean NOT NULL DEFAULT false;

-- The projects a conversation is about, each with how it got there (the
-- sources of conversations.project_source) and, for address, the endpoint
-- that filed it. A conversation holds one project until the rules for
-- several land (conversation_projects_one_per_conversation).
CREATE TABLE IF NOT EXISTS communications.conversation_projects (
  conversation_id uuid NOT NULL REFERENCES communications.conversations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source text NOT NULL CONSTRAINT conversation_projects_source_check
    CHECK (source IN ('mapped', 'inferred', 'guessed', 'person', 'address')),
  endpoint_id uuid REFERENCES communications.endpoints(id) ON DELETE SET NULL,
  -- The message that brought it, and the person who set it.
  message_id uuid REFERENCES communications.messages(id) ON DELETE SET NULL,
  added_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, project_id),
  CONSTRAINT conversation_projects_endpoint_check CHECK (endpoint_id IS NULL OR source = 'address')
);
CREATE INDEX IF NOT EXISTS idx_conversation_projects_project ON communications.conversation_projects (project_id);
CREATE INDEX IF NOT EXISTS idx_conversation_projects_message ON communications.conversation_projects (message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_projects_one_per_conversation ON communications.conversation_projects (conversation_id);


-- Every project endpoint a message arrived through (mail to two project
-- addresses at once came through both).
CREATE TABLE IF NOT EXISTS communications.message_endpoints (
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES communications.endpoints(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, endpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_message_endpoints_endpoint ON communications.message_endpoints (endpoint_id);


-- ── Old triggers, helper policies and functions ──────────────
DROP TRIGGER IF EXISTS email_inboxes_before_write ON communications.inboxes;
DROP TRIGGER IF EXISTS email_inboxes_grant_handler ON communications.inboxes;
DROP TRIGGER IF EXISTS email_inboxes_routing_address_guard ON communications.inboxes;
DROP TRIGGER IF EXISTS email_project_addresses_before_write ON communications.endpoints;
DROP TRIGGER IF EXISTS email_project_addresses_routing_address_guard ON communications.endpoints;
DROP TRIGGER IF EXISTS email_threads_before_update ON communications.conversations;
DROP POLICY IF EXISTS email_inboxes_select ON communications.inboxes;
DROP POLICY IF EXISTS email_threads_select ON communications.conversations;
DROP POLICY IF EXISTS email_messages_select ON communications.messages;
DROP POLICY IF EXISTS email_message_recipients_select ON communications.participants;
DROP POLICY IF EXISTS email_message_candidates_select ON communications.message_candidates;
DROP POLICY IF EXISTS email_attachments_select ON communications.attachments;
DROP POLICY IF EXISTS email_triage_select ON communications.triage;
DROP POLICY IF EXISTS email_task_links_select ON communications.task_links;
DROP POLICY IF EXISTS email_reply_drafts_select ON communications.reply_drafts;
DROP POLICY IF EXISTS email_question_answers_select ON communications.answers;
DROP FUNCTION IF EXISTS public.email_inboxes_before_write();
DROP FUNCTION IF EXISTS public.email_inboxes_grant_handler();
DROP FUNCTION IF EXISTS public.email_project_addresses_before_write();
DROP FUNCTION IF EXISTS public.email_routing_address_guard();
DROP FUNCTION IF EXISTS public.email_threads_before_update();
DROP FUNCTION IF EXISTS public.email_start_message(uuid, jsonb, jsonb, jsonb, bigint);
DROP FUNCTION IF EXISTS public.email_complete_message(uuid, jsonb);
DROP FUNCTION IF EXISTS public.email_files_failed(uuid, jsonb, boolean, integer, integer);
DROP FUNCTION IF EXISTS public.email_claim_file(uuid, text, bigint);
DROP FUNCTION IF EXISTS public.email_file_stored(uuid);
DROP FUNCTION IF EXISTS public.email_files_release(integer);
DROP FUNCTION IF EXISTS public.email_files_forget(jsonb);
DROP FUNCTION IF EXISTS public.email_record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.email_signal(jsonb);
DROP FUNCTION IF EXISTS public.email_mark_triage_summarized(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.email_retention_due(integer, jsonb);
DROP FUNCTION IF EXISTS public.email_retention_delete(jsonb);
DROP FUNCTION IF EXISTS public.email_storage_known_paths(jsonb);
DROP FUNCTION IF EXISTS public.email_record_maintenance_run(text, jsonb);
DROP FUNCTION IF EXISTS public.email_unsummarized_triage(jsonb, integer);
DROP FUNCTION IF EXISTS public.can_read_email_message(uuid);
DROP FUNCTION IF EXISTS public.can_read_email_inbox(uuid);

-- ── Functions (as in schema.sql) ─────────────────────────────
CREATE OR REPLACE FUNCTION communications.inboxes_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
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
      SELECT 1 FROM communications.inboxes
      WHERE routing_local_part = v_candidate AND routing_domain = NEW.routing_domain AND id <> NEW.id
    ) OR EXISTS (
      SELECT 1 FROM communications.endpoints
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

-- The handler always reads its own inbox.
CREATE OR REPLACE FUNCTION communications.inboxes_grant_handler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF NEW.handler_member_id IS NOT NULL THEN
    INSERT INTO communications.inbox_access (inbox_id, member_id) VALUES (NEW.id, NEW.handler_member_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

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

-- After the row is written, so the generated routing_address is final. The
-- advisory lock takes writers to either table one at a time, so two
-- concurrent writes of the same address cannot both pass.
CREATE OR REPLACE FUNCTION communications.routing_address_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.routing_address IS NOT DISTINCT FROM OLD.routing_address THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.email_routing_address'));
  IF TG_TABLE_NAME = 'inboxes' THEN
    IF EXISTS (SELECT 1 FROM communications.endpoints WHERE routing_address = NEW.routing_address) THEN
      RAISE EXCEPTION 'EMAIL_ROUTING_ADDRESS_TAKEN: % is a project email address', NEW.routing_address
        USING ERRCODE = '23505', CONSTRAINT = 'email_routing_address_guard';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM communications.inboxes WHERE routing_address = NEW.routing_address) THEN
    RAISE EXCEPTION 'EMAIL_ROUTING_ADDRESS_TAKEN: % is an inbox routing address', NEW.routing_address
      USING ERRCODE = '23505', CONSTRAINT = 'email_routing_address_guard';
  END IF;
  RETURN NULL;
END;
$$;

-- A deleted project nulls project_id (ON DELETE SET NULL); its source goes
-- too. Any other source than 'address' drops the address.
CREATE OR REPLACE FUNCTION communications.conversations_before_update()
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

-- How strongly a project is known: a person's word first, a guess last.
CREATE OR REPLACE FUNCTION communications.project_source_rank(p_source text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array_position(ARRAY['person', 'address', 'mapped', 'inferred', 'guessed'], p_source)
$$;

-- Keeps conversations.project_id/project_source/project_address_id a copy of
-- the conversation's strongest project, for older readers.
CREATE OR REPLACE FUNCTION communications.conversation_projects_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_id uuid;
  v_project uuid;
  v_source text;
  v_endpoint uuid;
BEGIN
  FOR v_id IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.conversation_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.conversation_id END
    ]) AS x WHERE x IS NOT NULL
  LOOP
    SELECT p.project_id, p.source, CASE WHEN p.source = 'address' THEN p.endpoint_id END
    INTO v_project, v_source, v_endpoint
    FROM communications.conversation_projects p
    WHERE p.conversation_id = v_id
    ORDER BY communications.project_source_rank(p.source), p.created_at, p.project_id
    LIMIT 1;
    UPDATE communications.conversations
    SET project_id = v_project, project_source = v_source, project_address_id = v_endpoint
    WHERE id = v_id
      AND (project_id, project_source, project_address_id) IS DISTINCT FROM (v_project, v_source, v_endpoint);
  END LOOP;
  RETURN NULL;
END;
$$;

-- Ingestion step 1: the message row (status receiving), its sender and
-- recipients, and its attachment rows (pending, or skipped when over the
-- size cap), in one transaction, before any file is written. Idempotent on the provider's
-- id and on (inbox, Message-ID): a retried or duplicate delivery returns the
-- existing rows.
CREATE OR REPLACE FUNCTION communications.email_start_message(
  p_inbox_id uuid,
  p_message jsonb,
  p_recipients jsonb,
  p_attachments jsonb,
  p_max_attachment_bytes bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
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

  SELECT id INTO v_id FROM communications.messages
  WHERE inbox_id = p_inbox_id AND provider = p_message->>'provider' AND provider_email_id = p_message->>'provider_email_id';

  IF v_id IS NULL THEN
    INSERT INTO communications.messages (
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
      SELECT id INTO v_id FROM communications.messages
      WHERE inbox_id = p_inbox_id AND internet_message_id = p_message->>'internet_message_id';
    ELSE
      v_created := true;
      UPDATE communications.messages
      SET raw_storage_path = CASE WHEN COALESCE((p_message->>'has_raw')::boolean, false)
                                  THEN p_inbox_id::text || '/' || v_id::text || '/raw.eml' END
      WHERE id = v_id;

      INSERT INTO communications.participants (message_id, kind, address, name, position)
      SELECT v_id, r.value->>'kind', lower(btrim(r.value->>'address')), left(COALESCE(r.value->>'name', ''), 300), (r.ordinality - 1)::integer
      FROM jsonb_array_elements(COALESCE(p_recipients, '[]'::jsonb)) WITH ORDINALITY AS r(value, ordinality)
      ON CONFLICT DO NOTHING;

      FOR v_attachment IN SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb)) LOOP
        v_attachment_id := gen_random_uuid();
        v_size := (v_attachment->>'size_bytes')::bigint;
        v_over := v_size IS NOT NULL AND v_size > p_max_attachment_bytes;
        INSERT INTO communications.attachments (
          id, message_id, position, filename, content_type, size_bytes, disposition, content_id,
          provider_attachment_id, skipped_reason
        ) VALUES (
          v_attachment_id, v_id, v_position,
          left(COALESCE(v_attachment->>'filename', ''), 255),
          left(COALESCE(NULLIF(v_attachment->>'content_type', ''), 'application/octet-stream'), 255),
          v_size,
          v_attachment->>'disposition',
          v_attachment->>'content_id',
          v_attachment->>'provider_attachment_id',
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
      FROM communications.messages m WHERE m.id = v_id
    ),
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'position', a.position, 'filename', a.filename,
        'content_type', a.content_type, 'size_bytes', a.size_bytes, 'provider_attachment_id', a.provider_attachment_id,
        'storage_path', a.storage_path, 'skipped_reason', a.skipped_reason, 'uploaded_at', a.uploaded_at,
        'file_id', a.file_id) ORDER BY a.position)
      FROM communications.attachments a WHERE a.message_id = v_id
    ), '[]'::jsonb)
  );
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
CREATE OR REPLACE FUNCTION communications.email_complete_message(p_message_id uuid, p_decision jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_thread uuid;
  v_status text := p_decision->>'status';
  v_source text := COALESCE(p_decision->>'project_source', 'mapped');
  v_basis text := COALESCE(p_decision->>'routing_basis', 'sender');
  v_rule uuid := (p_decision->>'sender_rule_id')::uuid;
  v_forwarder uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF v_status NOT IN ('new', 'ignored') THEN RAISE EXCEPTION 'email_complete_message: status must be new or ignored' USING ERRCODE = '22023'; END IF;
  IF v_source NOT IN ('mapped', 'address') THEN RAISE EXCEPTION 'email_complete_message: project_source must be mapped or address' USING ERRCODE = '22023'; END IF;
  IF v_basis NOT IN ('sender', 'forwarded_original', 'team_recipients') THEN
    RAISE EXCEPTION 'email_complete_message: routing_basis must be sender, forwarded_original or team_recipients' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002'; END IF;
  IF v_message.status <> 'receiving' THEN
    RETURN jsonb_build_object('already_complete', true, 'status', v_message.status, 'thread_id', v_message.thread_id);
  END IF;
  IF (v_message.raw_storage_path IS NOT NULL AND v_message.raw_uploaded_at IS NULL)
    OR EXISTS (SELECT 1 FROM communications.attachments WHERE message_id = p_message_id AND uploaded_at IS NULL AND skipped_reason IS NULL) THEN
    RAISE EXCEPTION 'EMAIL_FILES_PENDING: message % still has files to store', p_message_id USING ERRCODE = 'P0001';
  END IF;

  IF p_decision->>'thread_id' IS NOT NULL THEN
    SELECT id INTO v_thread FROM communications.conversations
    WHERE id = (p_decision->>'thread_id')::uuid AND inbox_id = v_message.inbox_id
    FOR UPDATE;
    IF v_thread IS NULL THEN RAISE EXCEPTION 'email_complete_message: thread is not in this inbox' USING ERRCODE = '22023'; END IF;
    UPDATE communications.conversations SET last_message_at = GREATEST(last_message_at, v_message.received_at) WHERE id = v_thread;
  ELSE
    INSERT INTO communications.conversations (inbox_id, subject_normalized, last_message_at)
    VALUES (v_message.inbox_id, v_message.subject_normalized, v_message.received_at)
    RETURNING id INTO v_thread;
  END IF;

  -- A conversation keeps its project once set (the conversation row is
  -- locked above or new). An address deleted since it was matched still
  -- files the project, without the address.
  IF p_decision->>'project_id' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM communications.conversation_projects WHERE conversation_id = v_thread) THEN
    INSERT INTO communications.conversation_projects (conversation_id, project_id, source, endpoint_id, message_id)
    VALUES (
      v_thread, (p_decision->>'project_id')::uuid, v_source,
      CASE WHEN v_source = 'address' THEN (
        SELECT a.id FROM communications.endpoints a WHERE a.id = (p_decision->>'project_address_id')::uuid
      ) END,
      p_message_id
    )
    ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO communications.message_endpoints (message_id, endpoint_id)
  SELECT p_message_id, a.id FROM communications.endpoints a
  WHERE a.id = (p_decision->>'received_via_address_id')::uuid AND a.inbox_id = v_message.inbox_id
  ON CONFLICT DO NOTHING;

  INSERT INTO communications.message_candidates (message_id, project_id, reason)
  SELECT p_message_id, (c->>'project_id')::uuid, c->>'reason'
  FROM jsonb_array_elements(COALESCE(p_decision->'candidates', '[]'::jsonb)) AS c
  ON CONFLICT DO NOTHING;

  UPDATE communications.participants r
  SET contact_id = (x->>'contact_id')::uuid
  FROM jsonb_array_elements(COALESCE(p_decision->'recipient_contacts', '[]'::jsonb)) AS x
  WHERE r.message_id = p_message_id AND r.address = x->>'address';

  -- A rule switched off since ingestion read it is still the rule that sorted it.
  IF v_rule IS NOT NULL AND NOT EXISTS (SELECT 1 FROM communications.sender_rules WHERE id = v_rule) THEN
    v_rule := NULL;
  END IF;

  -- A teammate deleted since ingestion read them leaves no forwarder. The
  -- teammate is also the message's sender_member_id: the verified teammate
  -- behind it, whatever the channel.
  v_forwarder := CASE WHEN v_basis <> 'sender' THEN (
    SELECT tm.id FROM public.team_members tm WHERE tm.id = (p_decision->>'forwarded_by_member_id')::uuid
  ) END;
  UPDATE communications.messages
  SET thread_id = v_thread,
      status = v_status,
      completed_at = now(),
      routing_basis = v_basis,
      forwarded_by_member_id = v_forwarder,
      sender_member_id = v_forwarder,
      sender_verified = COALESCE(v_message.auth->>'trust', '') = 'trusted',
      original_from_address = CASE WHEN v_basis = 'forwarded_original' THEN lower(btrim(p_decision->>'original_from_address')) END,
      original_from_name = CASE WHEN v_basis = 'forwarded_original'
        THEN NULLIF(left(btrim(COALESCE(p_decision->>'original_from_name', '')), 300), '') END,
      kind = p_decision->>'kind',
      topic = p_decision->>'topic',
      sort_action = p_decision->>'sort_action',
      sort_reason = NULLIF(left(btrim(COALESCE(p_decision->>'sort_reason', '')), 300), ''),
      sender_rule_id = v_rule
  WHERE id = p_message_id;

  IF v_rule IS NOT NULL THEN
    UPDATE communications.sender_rules SET hit_count = hit_count + 1, last_hit_at = now() WHERE id = v_rule;
  END IF;

  UPDATE communications.inboxes SET last_received_at = now() WHERE id = v_message.inbox_id;
  IF p_decision->>'received_via_address_id' IS NOT NULL THEN
    UPDATE communications.endpoints SET last_received_at = now()
    WHERE id = (p_decision->>'received_via_address_id')::uuid AND inbox_id = v_message.inbox_id;
  END IF;

  RETURN jsonb_build_object('already_complete', false, 'status', v_status, 'thread_id', v_thread);
END;
$$;

-- Ingestion, when files of a receiving message failed in this run:
-- p_attachment_ids the attachments that failed, p_raw whether the raw .eml
-- did. Counts the failed run. From the p_max_failures-th failed run, or once
-- the message is p_max_age_minutes old, it gives up on those files: each
-- attachment is skipped as download_failed and the raw .eml is dropped (its
-- parsed bodies stand), so the message completes without them instead of
-- staying in receiving until retention deletes it. A copy an attachment had
-- claimed is let go (retention releases it once nothing points at it);
-- anything already stored under a dropped path is an orphan for the weekly sweep.
CREATE OR REPLACE FUNCTION communications.files_failed(
  p_message_id uuid,
  p_attachment_ids jsonb,
  p_raw boolean,
  p_max_failures integer,
  p_max_age_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_give_up boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;

  UPDATE communications.messages SET file_failures = file_failures + 1
  WHERE id = p_message_id AND status = 'receiving'
  RETURNING * INTO v_message;
  IF NOT FOUND THEN RETURN jsonb_build_object('receiving', false, 'gave_up', false, 'failures', 0); END IF;

  v_give_up := v_message.file_failures >= p_max_failures
    OR v_message.created_at < now() - make_interval(mins => p_max_age_minutes);
  IF v_give_up THEN
    UPDATE communications.attachments
    SET storage_path = NULL, file_id = NULL, skipped_reason = 'download_failed'
    WHERE message_id = p_message_id AND uploaded_at IS NULL AND skipped_reason IS NULL
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_attachment_ids, '[]'::jsonb)));
    IF p_raw THEN
      UPDATE communications.messages SET raw_storage_path = NULL WHERE id = p_message_id AND raw_uploaded_at IS NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object('receiving', true, 'gave_up', v_give_up, 'failures', v_message.file_failures);
END;
$$;

-- Ingestion, once an attachment is downloaded and hashed: the inbox's stored
-- copy of those bytes, or a new one to upload. The attachment points at the
-- copy from here on, which keeps it from being released (files_release
-- locks a copy and re-checks before releasing it). A retry keeps the copy it
-- already points at. A copy being deleted is never reused: a new one, at its
-- own path, takes its place.
CREATE OR REPLACE FUNCTION communications.claim_file(p_attachment_id uuid, p_sha256 text, p_size_bytes bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_inbox uuid;
  v_current uuid;
  v_file communications.files;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'claim_file: sha256 must be 64 lowercase hex characters' USING ERRCODE = '22023';
  END IF;
  IF p_size_bytes IS NULL OR p_size_bytes < 0 THEN RAISE EXCEPTION 'claim_file: size_bytes must be 0 or more' USING ERRCODE = '22023'; END IF;

  SELECT m.inbox_id, a.file_id INTO v_inbox, v_current
  FROM communications.attachments a
  JOIN communications.messages m ON m.id = a.message_id
  WHERE a.id = p_attachment_id AND a.uploaded_at IS NULL AND a.skipped_reason IS NULL
  FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_ATTACHMENT_NOT_PENDING: %', p_attachment_id USING ERRCODE = 'P0002'; END IF;

  IF v_current IS NOT NULL THEN
    SELECT * INTO v_file FROM communications.files WHERE id = v_current AND sha256 = p_sha256 FOR UPDATE;
  END IF;
  IF v_file.id IS NULL THEN
    SELECT * INTO v_file FROM communications.files
    WHERE inbox_id = v_inbox AND sha256 = p_sha256 AND deleting_at IS NULL
    FOR UPDATE;
  END IF;
  IF v_file.id IS NULL THEN
    -- Two emails with the same new file: one insert wins, the other waits for it and takes it.
    INSERT INTO communications.files (id, inbox_id, sha256, size_bytes, storage_path)
    SELECT n.id, v_inbox, p_sha256, p_size_bytes, v_inbox::text || '/files/' || n.id::text
    FROM (SELECT gen_random_uuid() AS id) n
    ON CONFLICT (inbox_id, sha256) WHERE deleting_at IS NULL DO NOTHING;
    SELECT * INTO v_file FROM communications.files
    WHERE inbox_id = v_inbox AND sha256 = p_sha256 AND deleting_at IS NULL
    FOR UPDATE;
  END IF;

  UPDATE communications.attachments SET file_id = v_file.id WHERE id = p_attachment_id;
  RETURN jsonb_build_object('file_id', v_file.id, 'storage_path', v_file.storage_path, 'stored', v_file.stored_at IS NOT NULL);
END;
$$;

-- Ingestion, once the copy's bytes are in the bucket (uploaded now, or there
-- already): the copy is stored, and so is the attachment, at the copy's path.
CREATE OR REPLACE FUNCTION communications.file_stored(p_attachment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  UPDATE communications.files f SET stored_at = COALESCE(f.stored_at, now())
  FROM communications.attachments a
  WHERE a.id = p_attachment_id AND f.id = a.file_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_FILE_NOT_CLAIMED: %', p_attachment_id USING ERRCODE = 'P0002'; END IF;
  UPDATE communications.attachments a
  SET storage_path = f.storage_path, sha256 = f.sha256, size_bytes = f.size_bytes, uploaded_at = COALESCE(a.uploaded_at, now())
  FROM communications.files f
  WHERE a.id = p_attachment_id AND f.id = a.file_id;
END;
$$;

-- Retention, after deleting messages: stored copies no attachment points at
-- any more. Each is locked, then re-checked (a fresh look, so an email that
-- just claimed it keeps it), then marked deleting: never reused from then
-- on. Returns those and any left marked by an earlier run, for their bytes
-- to be removed; files_forget drops the rows once they are.
CREATE OR REPLACE FUNCTION communications.files_release(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
  v_id uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  FOR v_id IN
    SELECT f.id FROM communications.files f
    WHERE f.deleting_at IS NULL AND NOT EXISTS (SELECT 1 FROM communications.attachments a WHERE a.file_id = f.id)
    ORDER BY f.created_at, f.id
    LIMIT v_limit
  LOOP
    PERFORM 1 FROM communications.files WHERE id = v_id AND deleting_at IS NULL FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    UPDATE communications.files SET deleting_at = now()
    WHERE id = v_id AND NOT EXISTS (SELECT 1 FROM communications.attachments a WHERE a.file_id = v_id);
  END LOOP;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'path', d.storage_path) ORDER BY d.deleting_at, d.id), '[]'::jsonb)
    FROM (
      SELECT id, storage_path, deleting_at FROM communications.files
      WHERE deleting_at IS NOT NULL ORDER BY deleting_at, id LIMIT v_limit
    ) d
  );
END;
$$;

-- Retention, once released copies' bytes are removed from the bucket: their
-- rows. Never one something points at.
CREATE OR REPLACE FUNCTION communications.files_forget(p_ids jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  DELETE FROM communications.files f
  WHERE f.id IN (SELECT (value)::uuid FROM jsonb_array_elements_text(COALESCE(p_ids, '[]'::jsonb)))
    AND f.deleting_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM communications.attachments a WHERE a.file_id = f.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- One triage: the triage row, its task links and the message status, and the
-- thread's project when the agent chose one for a thread without it. With an
-- idempotency key already used on this email it changes nothing: the same
-- request hash returns the first triage (replayed), another one is refused.
CREATE OR REPLACE FUNCTION communications.record_triage(
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
SET search_path = communications, public
AS $$
DECLARE
  v_message communications.messages;
  v_triage communications.triage;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('handled', 'needs_human') THEN RAISE EXCEPTION 'record_triage: invalid status' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_message FROM communications.messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status = 'receiving' THEN
    RAISE EXCEPTION 'EMAIL_NOT_FOUND: message %', p_message_id USING ERRCODE = 'P0002';
  END IF;

  -- The message row lock above serializes retries of one key.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_triage FROM communications.triage
    WHERE message_id = p_message_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_triage.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'EMAIL_IDEMPOTENCY_CONFLICT: this idempotency key was used for a different triage of message %', p_message_id USING ERRCODE = 'P0001';
      END IF;
      RETURN jsonb_build_object(
        'triage', to_jsonb(v_triage) - 'request_hash',
        'status', v_message.status,
        'thread', (SELECT jsonb_build_object('id', t.id, 'project_id', t.project_id, 'project_source', t.project_source)
                   FROM communications.conversations t WHERE t.id = v_message.thread_id),
        'replayed', true
      );
    END IF;
  END IF;

  -- person: someone answered the agent's question on this thread, so the
  -- project is the one that answer named; inferred: chosen among the
  -- message's mapping candidates; guessed: the message had none, so nothing
  -- in it matched a project.
  IF p_project_id IS NOT NULL THEN
    PERFORM 1 FROM communications.conversations WHERE id = v_message.thread_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM communications.conversation_projects WHERE conversation_id = v_message.thread_id) THEN
      INSERT INTO communications.conversation_projects (conversation_id, project_id, source, message_id, added_by)
      VALUES (
        v_message.thread_id, p_project_id,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM communications.answers a
            JOIN communications.messages m ON m.id = a.message_id
            WHERE m.thread_id = v_message.thread_id
          ) THEN 'person'
          WHEN EXISTS (SELECT 1 FROM communications.message_candidates c WHERE c.message_id = p_message_id) THEN 'inferred'
          ELSE 'guessed' END,
        p_message_id, p_member_id
      );
    ELSIF NOT EXISTS (
      SELECT 1 FROM communications.conversation_projects WHERE conversation_id = v_message.thread_id AND project_id = p_project_id
    ) THEN
      RAISE EXCEPTION 'EMAIL_THREAD_PROJECT_SET: the thread already belongs to another project' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO communications.triage (
    message_id, member_id, outcome, urgent, summary, question_for_human, suggested_reply, project_id, idempotency_key, request_hash
  )
  VALUES (
    p_message_id, p_member_id, p_triage->>'outcome', COALESCE((p_triage->>'urgent')::boolean, false),
    p_triage->>'summary', p_triage->>'question_for_human', p_triage->>'suggested_reply', p_project_id,
    p_idempotency_key, p_request_hash
  )
  RETURNING * INTO v_triage;

  INSERT INTO communications.task_links (message_id, task_id, relation, triage_id, linked_by)
  SELECT p_message_id, (l->>'task_id')::uuid, l->>'relation', v_triage.id, p_member_id
  FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) AS l
  ON CONFLICT (message_id, task_id, relation) DO NOTHING;

  UPDATE communications.messages SET status = p_status WHERE id = p_message_id;

  IF NULLIF(btrim(COALESCE(p_triage->>'thread_summary', '')), '') IS NOT NULL THEN
    UPDATE communications.conversations
    SET summary = left(btrim(p_triage->>'thread_summary'), 300), summary_at = now()
    WHERE id = v_message.thread_id;
  END IF;

  RETURN jsonb_build_object(
    'triage', to_jsonb(v_triage) - 'request_hash',
    'status', p_status,
    'thread', (SELECT jsonb_build_object('id', t.id, 'project_id', t.project_id, 'project_source', t.project_source)
               FROM communications.conversations t WHERE t.id = v_message.thread_id),
    'replayed', false
  );
END;
$$;

-- For the host dispatcher: is there new mail, and is anything waiting for
-- the batched summary. p_inbox_ids is a JSON array of inbox ids.
CREATE OR REPLACE FUNCTION communications.signal(p_inbox_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb)))
  SELECT jsonb_build_object(
    'new_count', (SELECT count(*) FROM communications.messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'newest_received_at', (SELECT max(m.received_at) FROM communications.messages m WHERE m.inbox_id IN (SELECT id FROM inboxes) AND m.status = 'new'),
    'unsummarized_count', (
      SELECT count(DISTINCT t.message_id) FROM communications.triage t
      JOIN communications.messages m ON m.id = t.message_id
      WHERE m.inbox_id IN (SELECT id FROM inboxes) AND t.summarized_at IS NULL
    ),
    'drafts_requested', (
      SELECT count(*) FROM communications.reply_drafts d
      JOIN communications.messages m ON m.id = d.message_id
      WHERE m.inbox_id IN (SELECT id FROM inboxes) AND d.status = 'requested'
    )
  ));
END;
$$;

-- Marks triage rows as summarized, with any older unsummarized triage of the
-- same messages (superseded, latest wins). All or nothing: an id outside
-- p_inbox_ids marks nothing and comes back in `missing`.
CREATE OR REPLACE FUNCTION communications.mark_triage_summarized(p_triage_ids jsonb, p_inbox_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
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
    SELECT 1 FROM communications.triage t JOIN communications.messages m ON m.id = t.message_id
    WHERE t.id = i AND m.inbox_id = ANY(v_inboxes)
  );
  IF jsonb_array_length(v_missing) > 0 THEN
    RETURN jsonb_build_object('marked', 0, 'missing', v_missing);
  END IF;

  WITH chosen AS (SELECT id, message_id, created_at FROM communications.triage WHERE id = ANY(v_ids)),
  marked AS (
    UPDATE communications.triage t SET summarized_at = now()
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

-- A person files a conversation on a project: it replaces the project the
-- conversation had (a person's word is final). p_only_if_none files it only
-- when the conversation has no project yet (linking a task to an unfiled
-- conversation). Returns whether it filed it.
CREATE OR REPLACE FUNCTION communications.set_conversation_project(
  p_conversation_id uuid,
  p_project_id uuid,
  p_member_id uuid,
  p_only_if_none boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM communications.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_NOT_FOUND: conversation %', p_conversation_id USING ERRCODE = 'P0002'; END IF;
  IF p_only_if_none AND EXISTS (SELECT 1 FROM communications.conversation_projects WHERE conversation_id = p_conversation_id) THEN
    RETURN false;
  END IF;
  DELETE FROM communications.conversation_projects WHERE conversation_id = p_conversation_id AND project_id <> p_project_id;
  INSERT INTO communications.conversation_projects (conversation_id, project_id, source, added_by)
  VALUES (p_conversation_id, p_project_id, 'person', p_member_id)
  ON CONFLICT (conversation_id, project_id) DO UPDATE
  SET source = 'person', endpoint_id = NULL, added_by = EXCLUDED.added_by;
  RETURN true;
END;
$$;

-- inbound_email.manage sees every inbox; inbound_email.read sees the inboxes
-- the member was granted.
CREATE OR REPLACE FUNCTION communications.can_read_inbox(p_inbox_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT public.has_permission('inbound_email.manage', 'app')
    OR (
      public.has_permission('inbound_email.read', 'app')
      AND EXISTS (
        SELECT 1 FROM communications.inbox_access a
        WHERE a.inbox_id = p_inbox_id AND a.member_id = public.current_team_member_id()
      )
    )
$$;

CREATE OR REPLACE FUNCTION communications.can_read_message(p_message_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM communications.messages m
    WHERE m.id = p_message_id AND communications.can_read_inbox(m.inbox_id)
  )
$$;

-- The next batch of messages due for deletion, oldest first, with every file
-- path they own: the raw .eml and attachments stored the old way. Shared
-- copies are released after the rows go (files_release). Due: past the inbox's retention_days (any status but
-- receiving), or stuck in receiving for over 24 hours. p_exclude skips
-- messages whose files failed to delete earlier in the same run.
CREATE OR REPLACE FUNCTION communications.retention_due(p_limit integer, p_exclude jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
    WITH excluded AS (
      SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_exclude, '[]'::jsonb))
    ),
    due AS (
      SELECT m.id, m.inbox_id, m.raw_storage_path, m.status, m.received_at, m.created_at
      FROM communications.messages m
      JOIN communications.inboxes i ON i.id = m.inbox_id
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
        || ARRAY(SELECT a.storage_path FROM communications.attachments a
                 WHERE a.message_id = d.id AND a.storage_path IS NOT NULL AND a.file_id IS NULL ORDER BY a.position)
      )
    ) ORDER BY LEAST(d.received_at, d.created_at), d.id), '[]'::jsonb)
    FROM due d
  );
END;
$$;

-- Deletes the rows of messages whose files are already gone: attachments,
-- task links, triage, recipients, candidates, then the message, then any of
-- their threads left empty. Only messages still due are deleted (the rule of
-- retention_due; a stuck message that completed during this run still
-- goes, since its files are gone). Tasks are never touched.
CREATE OR REPLACE FUNCTION communications.retention_delete(p_message_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
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
  PERFORM 1 FROM communications.messages WHERE id = ANY(v_requested) ORDER BY id FOR UPDATE;

  SELECT
    COALESCE(array_agg(m.id), '{}'),
    COALESCE(array_agg(DISTINCT m.thread_id) FILTER (WHERE m.thread_id IS NOT NULL), '{}'),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', m.id, 'inbox_id', m.inbox_id,
      'reason', CASE WHEN m.status <> 'receiving' AND m.received_at < now() - make_interval(days => i.retention_days)
                     THEN 'retention' ELSE 'stuck_receiving' END
    )), '[]'::jsonb)
  INTO v_ids, v_threads, v_deleted
  FROM communications.messages m
  JOIN communications.inboxes i ON i.id = m.inbox_id
  WHERE m.id = ANY(v_requested)
    AND (
      (m.status <> 'receiving' AND m.received_at < now() - make_interval(days => i.retention_days))
      OR (m.created_at < now() - interval '24 hours'
          AND (m.status = 'receiving' OR m.completed_at > now() - interval '15 minutes'))
    );

  DELETE FROM communications.attachments WHERE message_id = ANY(v_ids);
  GET DIAGNOSTICS v_attachments = ROW_COUNT;
  DELETE FROM communications.task_links WHERE message_id = ANY(v_ids);
  DELETE FROM communications.triage WHERE message_id = ANY(v_ids);
  DELETE FROM communications.participants WHERE message_id = ANY(v_ids);
  DELETE FROM communications.message_candidates WHERE message_id = ANY(v_ids);
  DELETE FROM communications.messages WHERE id = ANY(v_ids);

  FOREACH v_thread IN ARRAY v_threads LOOP
    BEGIN
      DELETE FROM communications.conversations t
      WHERE t.id = v_thread AND NOT EXISTS (SELECT 1 FROM communications.messages m WHERE m.thread_id = t.id);
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
-- an attachment's file, a stored copy, or anything under a message still being received
-- (created in the last 24 hours). Everything else is an orphan.
CREATE OR REPLACE FUNCTION communications.storage_known_paths(p_paths jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
    WITH given AS (
      SELECT DISTINCT value AS path FROM jsonb_array_elements_text(COALESCE(p_paths, '[]'::jsonb))
    )
    SELECT COALESCE(jsonb_agg(g.path ORDER BY g.path), '[]'::jsonb)
    FROM given g
    WHERE EXISTS (SELECT 1 FROM communications.messages m WHERE m.raw_storage_path = g.path)
      OR EXISTS (SELECT 1 FROM communications.attachments a WHERE a.storage_path = g.path)
      OR EXISTS (SELECT 1 FROM communications.files f WHERE f.storage_path = g.path)
      OR EXISTS (
        SELECT 1 FROM communications.messages m
        WHERE m.status = 'receiving'
          AND m.created_at >= now() - interval '24 hours'
          AND m.inbox_id::text = split_part(g.path, '/', 1)
          AND m.id::text = split_part(g.path, '/', 2)
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION communications.record_maintenance_run(p_kind text, p_run jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  INSERT INTO communications.maintenance_runs AS r (
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

-- Defined after reminders, which it reads (the reminders an email set).
-- The newest unsummarized triage per message, oldest message first, with
-- what the batched summary needs (no bodies).
CREATE OR REPLACE FUNCTION communications.unsummarized_triage(p_inbox_ids jsonb, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = communications, public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  RETURN (
  WITH inboxes AS (SELECT (value)::uuid AS id FROM jsonb_array_elements_text(COALESCE(p_inbox_ids, '[]'::jsonb))),
  latest AS (
    SELECT DISTINCT ON (t.message_id) t.*
    FROM communications.triage t
    JOIN communications.messages m ON m.id = t.message_id
    WHERE m.inbox_id IN (SELECT id FROM inboxes)
      AND EXISTS (SELECT 1 FROM communications.triage u WHERE u.message_id = t.message_id AND u.summarized_at IS NULL)
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
      'question_for_human', l.question_for_human,
      'has_suggested_reply', l.suggested_reply IS NOT NULL,
      'project_id', l.project_id,
      'superseded_triage_ids', COALESCE((
        SELECT jsonb_agg(o.id) FROM communications.triage o
        WHERE o.message_id = l.message_id AND o.id <> l.id AND o.summarized_at IS NULL
      ), '[]'::jsonb),
      'message', jsonb_build_object(
        'id', m.id, 'inbox_id', m.inbox_id, 'thread_id', m.thread_id, 'status', m.status,
        'subject', m.subject, 'received_at', m.received_at,
        'kind', m.kind, 'topic', m.topic, 'sort_action', m.sort_action,
        'from', (SELECT jsonb_build_object('address', r.address, 'name', r.name)
                 FROM communications.participants r WHERE r.message_id = m.id AND r.kind = 'from'),
        'routing_basis', m.routing_basis,
        'forwarded_by', CASE WHEN m.routing_basis <> 'sender' AND m.forwarded_by_member_id IS NOT NULL THEN jsonb_build_object(
          'member_id', m.forwarded_by_member_id,
          'name', (SELECT tm.name FROM public.team_members tm WHERE tm.id = m.forwarded_by_member_id)) END,
        'original_sender', CASE WHEN m.routing_basis = 'forwarded_original' THEN jsonb_build_object(
          'address', m.original_from_address, 'name', COALESCE(m.original_from_name, '')) END
      ),
      'project', CASE WHEN th.project_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', th.project_id, 'name', p.name, 'source', th.project_source) END,
      'thread_summary', th.summary,
      'links', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('task_id', k.task_id, 'relation', k.relation, 'title', tk.title, 'status', tk.status) ORDER BY k.created_at)
        FROM communications.task_links k JOIN public.tasks tk ON tk.id = k.task_id
        WHERE k.message_id = m.id AND tk.deleted_at IS NULL
      ), '[]'::jsonb),
      'reminders', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', rm.id, 'title', rm.title, 'remind_on', rm.remind_on, 'task_id', rm.task_id) ORDER BY rm.created_at)
        FROM public.reminders rm
        WHERE rm.source_message_id = m.id AND rm.deleted_at IS NULL AND rm.status = 'open'
      ), '[]'::jsonb)
    ) AS item
    FROM latest l
    JOIN communications.messages m ON m.id = l.message_id
    LEFT JOIN communications.conversations th ON th.id = m.thread_id
    LEFT JOIN public.projects p ON p.id = th.project_id
    ORDER BY l.created_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
  ) items);
END;
$$;

-- ── Triggers ─────────────────────────────────────────────────
DROP TRIGGER IF EXISTS inboxes_before_write ON communications.inboxes;
CREATE TRIGGER inboxes_before_write
  BEFORE INSERT OR UPDATE ON communications.inboxes
  FOR EACH ROW EXECUTE FUNCTION communications.inboxes_before_write();
DROP TRIGGER IF EXISTS inboxes_grant_handler ON communications.inboxes;
CREATE TRIGGER inboxes_grant_handler
  AFTER INSERT OR UPDATE OF handler_member_id ON communications.inboxes
  FOR EACH ROW EXECUTE FUNCTION communications.inboxes_grant_handler();
CREATE TRIGGER email_inboxes_routing_address_guard
  AFTER INSERT OR UPDATE ON communications.inboxes
  FOR EACH ROW EXECUTE FUNCTION communications.routing_address_guard();
DROP TRIGGER IF EXISTS endpoints_before_write ON communications.endpoints;
CREATE TRIGGER endpoints_before_write
  BEFORE INSERT OR UPDATE ON communications.endpoints
  FOR EACH ROW EXECUTE FUNCTION communications.endpoints_before_write();
CREATE TRIGGER email_project_addresses_routing_address_guard
  AFTER INSERT OR UPDATE ON communications.endpoints
  FOR EACH ROW EXECUTE FUNCTION communications.routing_address_guard();
DROP TRIGGER IF EXISTS conversations_before_update ON communications.conversations;
CREATE TRIGGER conversations_before_update
  BEFORE UPDATE ON communications.conversations
  FOR EACH ROW EXECUTE FUNCTION communications.conversations_before_update();
DROP TRIGGER IF EXISTS conversation_projects_sync ON communications.conversation_projects;
CREATE TRIGGER conversation_projects_sync
  AFTER INSERT OR UPDATE OR DELETE ON communications.conversation_projects
  FOR EACH ROW EXECUTE FUNCTION communications.conversation_projects_sync();
DROP TRIGGER IF EXISTS set_conversation_projects_updated_at ON communications.conversation_projects;
CREATE TRIGGER set_conversation_projects_updated_at
  BEFORE UPDATE ON communications.conversation_projects
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Thread participants are derived, never stored.
CREATE OR REPLACE VIEW communications.conversation_participants
WITH (security_invoker = true) AS
SELECT
  m.thread_id,
  r.address,
  max(r.name) AS name,
  (array_agg(r.contact_id) FILTER (WHERE r.contact_id IS NOT NULL))[1] AS contact_id,
  count(*)::integer AS appearances,
  max(m.received_at) AS last_seen_at
FROM communications.participants r
JOIN communications.messages m ON m.id = r.message_id
WHERE m.thread_id IS NOT NULL
GROUP BY m.thread_id, r.address;

-- ── Backfill (updated_at left as it was) ─────────────────────
ALTER TABLE communications.messages DISABLE TRIGGER set_email_messages_updated_at;
UPDATE communications.messages
SET sender_member_id = forwarded_by_member_id
WHERE sender_member_id IS NULL AND forwarded_by_member_id IS NOT NULL;
UPDATE communications.messages
SET sender_verified = true
WHERE NOT sender_verified AND auth->>'trust' = 'trusted';
ALTER TABLE communications.messages ENABLE TRIGGER set_email_messages_updated_at;

INSERT INTO communications.conversation_projects (conversation_id, project_id, source, endpoint_id, created_at, updated_at)
SELECT c.id, c.project_id, c.project_source, CASE WHEN c.project_source = 'address' THEN c.project_address_id END, c.created_at, c.created_at
FROM communications.conversations c
WHERE c.project_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO communications.message_endpoints (message_id, endpoint_id)
SELECT m.id, c.project_address_id
FROM communications.messages m
JOIN communications.conversations c ON c.id = m.thread_id
WHERE c.project_source = 'address' AND c.project_address_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── Row level security ───────────────────────────────────────
ALTER TABLE communications.conversation_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.message_endpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_inboxes_select ON communications.inboxes FOR SELECT TO authenticated
  USING (communications.can_read_inbox(id));
CREATE POLICY email_threads_select ON communications.conversations FOR SELECT TO authenticated
  USING (communications.can_read_inbox(inbox_id));
CREATE POLICY email_messages_select ON communications.messages FOR SELECT TO authenticated
  USING (communications.can_read_inbox(inbox_id));
CREATE POLICY email_message_recipients_select ON communications.participants FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_message_candidates_select ON communications.message_candidates FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_attachments_select ON communications.attachments FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_triage_select ON communications.triage FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_task_links_select ON communications.task_links FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_reply_drafts_select ON communications.reply_drafts FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
CREATE POLICY email_question_answers_select ON communications.answers FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
DROP POLICY IF EXISTS conversation_projects_select ON communications.conversation_projects;
CREATE POLICY conversation_projects_select ON communications.conversation_projects FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM communications.conversations c
    WHERE c.id = conversation_id AND communications.can_read_inbox(c.inbox_id)
  ));
DROP POLICY IF EXISTS message_endpoints_select ON communications.message_endpoints;
CREATE POLICY message_endpoints_select ON communications.message_endpoints FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
DROP POLICY IF EXISTS conversation_projects_parent_live ON communications.conversation_projects;
CREATE POLICY conversation_projects_parent_live ON communications.conversation_projects AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.project_is_live(project_id));

-- ── Grants ───────────────────────────────────────────────────
-- As in public, minus anon: a person reaches the tables under RLS.
REVOKE ALL ON ALL TABLES IN SCHEMA communications FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA communications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA communications TO authenticated;
REVOKE ALL ON communications.files FROM anon, authenticated;
REVOKE ALL ON FUNCTION communications.set_conversation_project(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.set_conversation_project(uuid, uuid, uuid, boolean) TO service_role;
REVOKE ALL ON FUNCTION communications.email_start_message(uuid, jsonb, jsonb, jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.email_complete_message(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.files_failed(uuid, jsonb, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.signal(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.mark_triage_summarized(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.email_start_message(uuid, jsonb, jsonb, jsonb, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION communications.email_complete_message(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.files_failed(uuid, jsonb, boolean, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION communications.claim_file(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.file_stored(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.files_release(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.files_forget(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.claim_file(uuid, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION communications.file_stored(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION communications.files_release(integer) TO service_role;
GRANT EXECUTE ON FUNCTION communications.files_forget(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.record_triage(uuid, uuid, jsonb, jsonb, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION communications.signal(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.mark_triage_summarized(jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION communications.can_read_inbox(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION communications.can_read_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION communications.can_read_inbox(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION communications.can_read_message(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION communications.retention_due(integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.retention_delete(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.storage_known_paths(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION communications.record_maintenance_run(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.retention_due(integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.retention_delete(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.storage_known_paths(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION communications.record_maintenance_run(text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION communications.unsummarized_triage(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.unsummarized_triage(jsonb, integer) TO service_role;

-- ── Realtime ─────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'communications' AND tablename = 'conversation_projects'
    ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE communications.conversation_projects;
  END IF;
END $$;

-- ── Checks ───────────────────────────────────────────────────
DO $$
DECLARE
  t record;
  v_live bigint;
  v_was bigint;
BEGIN
  IF current_setting('communications.moved_now', true) = 'yes' THEN
    FOR t IN SELECT * FROM (VALUES ('email_inboxes', 'inboxes'), ('email_inbox_access', 'inbox_access'), ('email_client_domains', 'client_domains'), ('email_client_addresses', 'client_addresses'), ('email_project_addresses', 'endpoints'), ('email_threads', 'conversations'), ('email_sender_rules', 'sender_rules'), ('email_messages', 'messages'), ('email_message_recipients', 'participants'), ('email_message_candidates', 'message_candidates'), ('email_files', 'files'), ('email_attachments', 'attachments'), ('email_triage', 'triage'), ('email_task_links', 'task_links'), ('email_reply_drafts', 'reply_drafts'), ('email_question_answers', 'answers'), ('email_maintenance_runs', 'maintenance_runs')) AS x(was, now) LOOP
      EXECUTE format('SELECT count(*) FROM communications.%I', t.now) INTO v_live;
      EXECUTE format('SELECT count(*) FROM communications_legacy.%I', t.was) INTO v_was;
      IF v_live <> v_was THEN
        RAISE EXCEPTION 'communications move: % has % rows, % had %', t.now, v_live, t.was, v_was;
      END IF;
    END LOOP;
  END IF;
  IF (SELECT count(*) FROM communications.conversations WHERE project_id IS NOT NULL)
     <> (SELECT count(*) FROM communications.conversation_projects) THEN
    RAISE EXCEPTION 'communications move: conversation_projects does not match the conversations'' projects';
  END IF;
  IF to_regclass('public.email_messages') IS NOT NULL OR EXISTS (
    SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('email_inboxes_before_write', 'email_inboxes_grant_handler', 'email_project_addresses_before_write', 'email_routing_address_guard', 'email_threads_before_update', 'email_start_message', 'email_complete_message', 'email_files_failed', 'email_claim_file', 'email_file_stored', 'email_files_release', 'email_files_forget', 'email_record_triage', 'email_signal', 'email_mark_triage_summarized', 'email_retention_due', 'email_retention_delete', 'email_storage_known_paths', 'email_record_maintenance_run', 'email_unsummarized_triage', 'can_read_email_message', 'can_read_email_inbox')
  ) THEN
    RAISE EXCEPTION 'communications move: something is still in public';
  END IF;
END $$;

COMMIT;
