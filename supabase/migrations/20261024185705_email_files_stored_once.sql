-- Email files stored once per inbox.
--
-- Until now every email's attachments were stored under that email
-- ({inbox}/{message}/{attachment}), so a sender's signature logo, or a
-- screenshot a reply quotes again, was stored once per email. From here on an
-- attachment points at a stored copy of its bytes (email_files), one per
-- distinct file per inbox:
--   - intake downloads and hashes each attachment, claims the inbox's copy of
--     those bytes (email_claim_file) and uploads only when there is none yet,
--     then records it stored (email_file_stored). An attachment's file is no
--     longer planned when the email arrives: pending is "not uploaded and not
--     skipped";
--   - retention deletes messages as before; their attachments' own files go
--     first only for attachments stored the old way (file_id null). Copies
--     nothing points at any more are released afterwards
--     (email_files_release, email_files_forget);
--   - a copy is locked and re-checked before it is released, and a released
--     copy is never reused, so a new email can never lose its file to a
--     cleanup running at the same moment.
-- Files stored before this keep their paths and are deleted the old way.

-- Stored email files: one per distinct file per inbox. An attachment points
-- at the copy of its bytes (file_id), so the same signature logo or quoted
-- screenshot across many emails is stored once. Each copy has its own path,
-- {inbox_id}/files/{id}: a copy being deleted (deleting_at) is never reused,
-- a new one takes its place. Server only (service role).
CREATE TABLE IF NOT EXISTS public.email_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES public.email_inboxes(id) ON DELETE RESTRICT,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_path text NOT NULL UNIQUE,
  -- Set once its bytes are in the bucket.
  stored_at timestamptz,
  -- Set when nothing points at it any more (email_files_release); its bytes go next.
  deleting_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One live copy of the same bytes per inbox.
CREATE UNIQUE INDEX IF NOT EXISTS email_files_live_key ON public.email_files (inbox_id, sha256) WHERE deleting_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_files_deleting ON public.email_files (deleting_at) WHERE deleting_at IS NOT NULL;
ALTER TABLE public.email_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_files FROM anon, authenticated;
GRANT ALL ON public.email_files TO service_role;

-- The copy an attachment's bytes are stored in; null for files stored the
-- old way (their own path) and for files not stored.
ALTER TABLE public.email_attachments ADD COLUMN IF NOT EXISTS file_id uuid REFERENCES public.email_files(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_email_attachments_file ON public.email_attachments (file_id) WHERE file_id IS NOT NULL;

-- A pending attachment has neither a path nor a skip reason now.
ALTER TABLE public.email_attachments DROP CONSTRAINT IF EXISTS email_attachments_stored_or_skipped;
ALTER TABLE public.email_attachments ADD CONSTRAINT email_attachments_stored_or_skipped CHECK (storage_path IS NULL OR skipped_reason IS NULL);
ALTER TABLE public.email_attachments DROP CONSTRAINT IF EXISTS email_attachments_file_not_skipped;
ALTER TABLE public.email_attachments ADD CONSTRAINT email_attachments_file_not_skipped CHECK (file_id IS NULL OR skipped_reason IS NULL);
-- Many attachments share a copy's path; a path of its own stays unique.
DROP INDEX IF EXISTS public.email_attachments_storage_path_key;
CREATE UNIQUE INDEX email_attachments_storage_path_key ON public.email_attachments (storage_path) WHERE storage_path IS NOT NULL AND file_id IS NULL;

-- Ingestion step 1 no longer plans attachment paths, and says which copy each points at.
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
      FROM public.email_messages m WHERE m.id = v_id
    ),
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'position', a.position, 'filename', a.filename,
        'content_type', a.content_type, 'size_bytes', a.size_bytes, 'provider_attachment_id', a.provider_attachment_id,
        'storage_path', a.storage_path, 'skipped_reason', a.skipped_reason, 'uploaded_at', a.uploaded_at,
        'file_id', a.file_id) ORDER BY a.position)
      FROM public.email_attachments a WHERE a.message_id = v_id
    ), '[]'::jsonb)
  );
END;
$$;

-- Ingestion step 2: a file is pending until it is uploaded or skipped.
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
  v_rule uuid := (p_decision->>'sender_rule_id')::uuid;
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
    OR EXISTS (SELECT 1 FROM public.email_attachments WHERE message_id = p_message_id AND uploaded_at IS NULL AND skipped_reason IS NULL) THEN
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

  -- A rule switched off since ingestion read it is still the rule that sorted it.
  IF v_rule IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.email_sender_rules WHERE id = v_rule) THEN
    v_rule := NULL;
  END IF;

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
        THEN NULLIF(left(btrim(COALESCE(p_decision->>'original_from_name', '')), 300), '') END,
      kind = p_decision->>'kind',
      topic = p_decision->>'topic',
      sort_action = p_decision->>'sort_action',
      sort_reason = NULLIF(left(btrim(COALESCE(p_decision->>'sort_reason', '')), 300), ''),
      sender_rule_id = v_rule
  WHERE id = p_message_id;

  IF v_rule IS NOT NULL THEN
    UPDATE public.email_sender_rules SET hit_count = hit_count + 1, last_hit_at = now() WHERE id = v_rule;
  END IF;

  UPDATE public.email_inboxes SET last_received_at = now() WHERE id = v_message.inbox_id;
  IF p_decision->>'received_via_address_id' IS NOT NULL THEN
    UPDATE public.email_project_addresses SET last_received_at = now()
    WHERE id = (p_decision->>'received_via_address_id')::uuid AND inbox_id = v_message.inbox_id;
  END IF;

  RETURN jsonb_build_object('already_complete', false, 'status', v_status, 'thread_id', v_thread);
END;
$$;

-- Giving up on files also lets go of any copy they had claimed.
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
    SET storage_path = NULL, file_id = NULL, skipped_reason = 'download_failed'
    WHERE message_id = p_message_id AND uploaded_at IS NULL AND skipped_reason IS NULL
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_attachment_ids, '[]'::jsonb)));
    IF p_raw THEN
      UPDATE public.email_messages SET raw_storage_path = NULL WHERE id = p_message_id AND raw_uploaded_at IS NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object('receiving', true, 'gave_up', v_give_up, 'failures', v_message.file_failures);
END;
$$;

-- Ingestion, once an attachment is downloaded and hashed: the inbox's stored
-- copy of those bytes, or a new one to upload. The attachment points at the
-- copy from here on, which keeps it from being released (email_files_release
-- locks a copy and re-checks before releasing it). A retry keeps the copy it
-- already points at. A copy being deleted is never reused: a new one, at its
-- own path, takes its place.
CREATE OR REPLACE FUNCTION public.email_claim_file(p_attachment_id uuid, p_sha256 text, p_size_bytes bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inbox uuid;
  v_current uuid;
  v_file public.email_files;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'email_claim_file: sha256 must be 64 lowercase hex characters' USING ERRCODE = '22023';
  END IF;
  IF p_size_bytes IS NULL OR p_size_bytes < 0 THEN RAISE EXCEPTION 'email_claim_file: size_bytes must be 0 or more' USING ERRCODE = '22023'; END IF;

  SELECT m.inbox_id, a.file_id INTO v_inbox, v_current
  FROM public.email_attachments a
  JOIN public.email_messages m ON m.id = a.message_id
  WHERE a.id = p_attachment_id AND a.uploaded_at IS NULL AND a.skipped_reason IS NULL
  FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_ATTACHMENT_NOT_PENDING: %', p_attachment_id USING ERRCODE = 'P0002'; END IF;

  IF v_current IS NOT NULL THEN
    SELECT * INTO v_file FROM public.email_files WHERE id = v_current AND sha256 = p_sha256 FOR UPDATE;
  END IF;
  IF v_file.id IS NULL THEN
    SELECT * INTO v_file FROM public.email_files
    WHERE inbox_id = v_inbox AND sha256 = p_sha256 AND deleting_at IS NULL
    FOR UPDATE;
  END IF;
  IF v_file.id IS NULL THEN
    -- Two emails with the same new file: one insert wins, the other waits for it and takes it.
    INSERT INTO public.email_files (id, inbox_id, sha256, size_bytes, storage_path)
    SELECT n.id, v_inbox, p_sha256, p_size_bytes, v_inbox::text || '/files/' || n.id::text
    FROM (SELECT gen_random_uuid() AS id) n
    ON CONFLICT (inbox_id, sha256) WHERE deleting_at IS NULL DO NOTHING;
    SELECT * INTO v_file FROM public.email_files
    WHERE inbox_id = v_inbox AND sha256 = p_sha256 AND deleting_at IS NULL
    FOR UPDATE;
  END IF;

  UPDATE public.email_attachments SET file_id = v_file.id WHERE id = p_attachment_id;
  RETURN jsonb_build_object('file_id', v_file.id, 'storage_path', v_file.storage_path, 'stored', v_file.stored_at IS NOT NULL);
END;
$$;

-- Ingestion, once the copy's bytes are in the bucket (uploaded now, or there
-- already): the copy is stored, and so is the attachment, at the copy's path.
CREATE OR REPLACE FUNCTION public.email_file_stored(p_attachment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  UPDATE public.email_files f SET stored_at = COALESCE(f.stored_at, now())
  FROM public.email_attachments a
  WHERE a.id = p_attachment_id AND f.id = a.file_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_FILE_NOT_CLAIMED: %', p_attachment_id USING ERRCODE = 'P0002'; END IF;
  UPDATE public.email_attachments a
  SET storage_path = f.storage_path, sha256 = f.sha256, size_bytes = f.size_bytes, uploaded_at = COALESCE(a.uploaded_at, now())
  FROM public.email_files f
  WHERE a.id = p_attachment_id AND f.id = a.file_id;
END;
$$;

-- Retention, after deleting messages: stored copies no attachment points at
-- any more. Each is locked, then re-checked (a fresh look, so an email that
-- just claimed it keeps it), then marked deleting: never reused from then
-- on. Returns those and any left marked by an earlier run, for their bytes
-- to be removed; email_files_forget drops the rows once they are.
CREATE OR REPLACE FUNCTION public.email_files_release(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
  v_id uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  FOR v_id IN
    SELECT f.id FROM public.email_files f
    WHERE f.deleting_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.email_attachments a WHERE a.file_id = f.id)
    ORDER BY f.created_at, f.id
    LIMIT v_limit
  LOOP
    PERFORM 1 FROM public.email_files WHERE id = v_id AND deleting_at IS NULL FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    UPDATE public.email_files SET deleting_at = now()
    WHERE id = v_id AND NOT EXISTS (SELECT 1 FROM public.email_attachments a WHERE a.file_id = v_id);
  END LOOP;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'path', d.storage_path) ORDER BY d.deleting_at, d.id), '[]'::jsonb)
    FROM (
      SELECT id, storage_path, deleting_at FROM public.email_files
      WHERE deleting_at IS NOT NULL ORDER BY deleting_at, id LIMIT v_limit
    ) d
  );
END;
$$;

-- Retention, once released copies' bytes are removed from the bucket: their
-- rows. Never one something points at.
CREATE OR REPLACE FUNCTION public.email_files_forget(p_ids jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.email_files f
  WHERE f.id IN (SELECT (value)::uuid FROM jsonb_array_elements_text(COALESCE(p_ids, '[]'::jsonb)))
    AND f.deleting_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.email_attachments a WHERE a.file_id = f.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Retention removes only files stored the old way with their messages; copies are released after.
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
                 WHERE a.message_id = d.id AND a.storage_path IS NOT NULL AND a.file_id IS NULL ORDER BY a.position)
      )
    ) ORDER BY LEAST(d.received_at, d.created_at), d.id), '[]'::jsonb)
    FROM due d
  );
END;
$$;

-- The sweep knows stored copies' paths too.
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
      OR EXISTS (SELECT 1 FROM public.email_files f WHERE f.storage_path = g.path)
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

REVOKE ALL ON FUNCTION public.email_claim_file(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_file_stored(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_files_release(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_files_forget(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_claim_file(uuid, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_file_stored(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_files_release(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_files_forget(jsonb) TO service_role;
