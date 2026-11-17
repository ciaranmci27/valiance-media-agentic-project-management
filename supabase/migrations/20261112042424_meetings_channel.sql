-- Meetings as a channel. A meeting is one conversation (channel 'meeting')
-- with one message per package the meeting script posts: Gemini's notes, the
-- full transcript, or both. The transcript is the message's text file, the
-- organizer is its 'from' and the guests are 'attendee' participants, so the
-- project mapping, triage, task links and the Inbox work as for email.
--
-- communications.meetings holds what only a meeting has (title, times, the
-- Doc) and its key, so a late transcript joins the meeting it belongs to.
-- Meetings are kept: retention deletes email only.

-- 1. The channel.
ALTER TABLE communications.conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE communications.conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('email', 'meeting'));
ALTER TABLE communications.messages DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE communications.messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('email', 'meeting'));

-- 2. Attendees. The kind check was created unnamed; it gets a name here.
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'communications.participants'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%reply_to%'
  LOOP
    EXECUTE format('ALTER TABLE communications.participants DROP CONSTRAINT %I', v_name);
  END LOOP;
END;
$$;
ALTER TABLE communications.participants ADD CONSTRAINT participants_kind_check
  CHECK (kind IN ('from', 'to', 'cc', 'reply_to', 'attendee'));

-- 3. The meeting.
CREATE TABLE IF NOT EXISTS communications.meetings (
  conversation_id uuid PRIMARY KEY REFERENCES communications.conversations(id) ON DELETE CASCADE,
  inbox_id uuid NOT NULL REFERENCES communications.inboxes(id) ON DELETE RESTRICT,
  -- The script's key for the meeting: its calendar event and start, else
  -- its notes Doc. One meeting per key per inbox.
  meeting_key text NOT NULL CONSTRAINT meetings_key_check CHECK (length(meeting_key) BETWEEN 1 AND 300),
  title text NOT NULL CONSTRAINT meetings_title_check CHECK (length(title) BETWEEN 1 AND 500),
  starts_at timestamptz,
  ends_at timestamptz,
  organizer_address text
    CONSTRAINT meetings_organizer_check CHECK (organizer_address IS NULL OR (organizer_address = lower(btrim(organizer_address)) AND length(organizer_address) BETWEEN 3 AND 320)),
  -- The Google Doc with the notes or the transcript.
  doc_url text CONSTRAINT meetings_doc_url_check CHECK (doc_url IS NULL OR doc_url ~ '^https://docs\.google\.com/'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meetings_times_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT meetings_inbox_key UNIQUE (inbox_id, meeting_key)
);

DROP TRIGGER IF EXISTS set_meetings_updated_at ON communications.meetings;
CREATE TRIGGER set_meetings_updated_at
  BEFORE UPDATE ON communications.meetings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE communications.meetings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON communications.meetings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON communications.meetings TO authenticated;
GRANT ALL ON communications.meetings TO service_role;
DROP POLICY IF EXISTS meetings_select ON communications.meetings;
CREATE POLICY meetings_select ON communications.meetings FOR SELECT TO authenticated
  USING (communications.can_read_inbox(inbox_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'communications' AND tablename = 'meetings') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE communications.meetings;
  END IF;
END;
$$;

-- 4. The meeting's conversation: found by its key, or created with its
-- details. A later package updates the details it knows (a transcript knows
-- the times when the notes did not). Service role only.
CREATE OR REPLACE FUNCTION communications.meeting_conversation(p_inbox_id uuid, p_meeting jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = communications, public
AS $$
DECLARE
  v_key text := btrim(COALESCE(p_meeting->>'meeting_key', ''));
  -- A detail that does not fit is left out, never a reason to refuse the package.
  v_title text := COALESCE(NULLIF(left(btrim(COALESCE(p_meeting->>'title', '')), 500), ''), 'Meeting');
  v_starts timestamptz := (p_meeting->>'starts_at')::timestamptz;
  v_ends timestamptz := (p_meeting->>'ends_at')::timestamptz;
  v_organizer text := NULLIF(lower(btrim(COALESCE(p_meeting->>'organizer_address', ''))), '');
  v_doc text := NULLIF(btrim(COALESCE(p_meeting->>'doc_url', '')), '');
  v_conversation uuid;
BEGIN
  IF v_organizer IS NOT NULL AND (length(v_organizer) NOT BETWEEN 3 AND 320) THEN v_organizer := NULL; END IF;
  IF v_doc IS NOT NULL AND v_doc !~ '^https://docs\.google\.com/' THEN v_doc := NULL; END IF;
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF v_key = '' THEN RAISE EXCEPTION 'meeting_conversation: meeting_key is required' USING ERRCODE = '22023'; END IF;

  -- Two packages of one meeting arriving at once: one creates, one waits.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_inbox_id::text || ':' || v_key, 0));

  SELECT conversation_id INTO v_conversation FROM communications.meetings
  WHERE inbox_id = p_inbox_id AND meeting_key = v_key;

  IF v_conversation IS NULL THEN
    -- No subject: subject threading must never pull an email into a meeting.
    INSERT INTO communications.conversations (inbox_id, subject_normalized, channel, last_message_at)
    VALUES (p_inbox_id, '', 'meeting', COALESCE((p_meeting->>'starts_at')::timestamptz, now()))
    RETURNING id INTO v_conversation;
    INSERT INTO communications.meetings (conversation_id, inbox_id, meeting_key, title, starts_at, ends_at, organizer_address, doc_url)
    VALUES (
      v_conversation, p_inbox_id, v_key, v_title, v_starts,
      CASE WHEN v_ends >= v_starts OR v_starts IS NULL THEN v_ends END,
      v_organizer, v_doc
    );
  ELSE
    UPDATE communications.meetings SET
      starts_at = COALESCE(starts_at, v_starts),
      ends_at = COALESCE(ends_at, CASE WHEN v_ends >= COALESCE(starts_at, v_starts) OR COALESCE(starts_at, v_starts) IS NULL THEN v_ends END),
      organizer_address = COALESCE(organizer_address, v_organizer),
      doc_url = COALESCE(doc_url, v_doc)
    WHERE conversation_id = v_conversation;
  END IF;
  RETURN v_conversation;
END;
$$;
REVOKE ALL ON FUNCTION communications.meeting_conversation(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION communications.meeting_conversation(uuid, jsonb) TO service_role;

-- 5. A message's channel is set when it starts (email by default).
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
      auth, auto_mail_reason, channel
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
      p_message->>'auto_mail_reason',
      COALESCE(p_message->>'channel', 'email')
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

-- 6. Meetings are kept: retention deletes email only (a stuck meeting
-- message that never completed still goes).
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
          (m.status <> 'receiving' AND m.channel = 'email' AND m.received_at < now() - make_interval(days => i.retention_days))
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
      (m.status <> 'receiving' AND m.channel = 'email' AND m.received_at < now() - make_interval(days => i.retention_days))
      OR (m.created_at < now() - interval '24 hours'
          AND (m.status = 'receiving' OR (m.channel = 'email' AND m.completed_at > now() - interval '15 minutes')))
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
      WHERE t.id = v_thread AND t.channel = 'email'
        AND NOT EXISTS (SELECT 1 FROM communications.messages m WHERE m.thread_id = t.id);
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
