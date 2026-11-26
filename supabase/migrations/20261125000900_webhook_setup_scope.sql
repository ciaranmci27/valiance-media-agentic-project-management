-- One webhook endpoint for every assistant an assistant setup made, and one
-- pass over the endpoints per event.
--
-- - team_members.assistant_setup_id: the setup that made a personal agent.
--   pm.provision_personal_agents records it (the setup the server planned
--   it from, else pm.assistant_setup_for works it out the same way), and the
--   personal agents made before are filled in once here. Only the server or
--   a signed-in Owner changes it (pm.team_members_assistant_setup_guard).
--   Deleting a setup clears it.
-- - webhook_endpoints.assistant_setup_id: an endpoint scoped to a setup
--   receives the events that concern any personal agent that setup made,
--   assistant.message included, so an assistant host serving 2,000 people
--   keeps one endpoint and one secret instead of 2,000. Never together with
--   member_id. Only the server (its own checks: an Owner, or a key with
--   assistants.provision) or a signed-in Owner sets it
--   (pm.webhook_endpoints_assistant_guard). A setup with such an endpoint
--   cannot be deleted until the endpoint goes (turn the setup off instead),
--   so its assistants never go quiet by surprise. Keys stay one per
--   assistant: nothing about keys changes.
-- - pm.webhook_endpoint_matches reads the setup scope. The event writers
--   (pm.emit_webhook_event, pm.emit_invoice_webhook_event,
--   pm.emit_assistant_message) find the endpoints that match once, through
--   a GIN index on the active endpoints' events, and fan out from that list:
--   no second scan. Same commit, same lines, same folding as before.
--
-- Additive and safe to run twice. 2.0.40 code never reads or writes the new
-- columns: its endpoints and per-member assistant endpoints work unchanged.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE pm.team_members
  ADD COLUMN IF NOT EXISTS assistant_setup_id uuid REFERENCES pm.assistant_setups(id) ON DELETE SET NULL;

COMMENT ON COLUMN pm.team_members.assistant_setup_id IS
  'The assistant setup that made this personal agent (null: made another way, or its setup was deleted). Webhook endpoints scoped to the setup receive its events.';

CREATE INDEX IF NOT EXISTS idx_team_members_assistant_setup ON pm.team_members (assistant_setup_id) WHERE assistant_setup_id IS NOT NULL;

ALTER TABLE pm.webhook_endpoints
  ADD COLUMN IF NOT EXISTS assistant_setup_id uuid REFERENCES pm.assistant_setups(id) ON DELETE RESTRICT;

ALTER TABLE pm.webhook_endpoints DROP CONSTRAINT IF EXISTS webhook_endpoints_one_scope;
ALTER TABLE pm.webhook_endpoints
  ADD CONSTRAINT webhook_endpoints_one_scope CHECK (member_id IS NULL OR assistant_setup_id IS NULL);

COMMENT ON COLUMN pm.webhook_endpoints.assistant_setup_id IS
  'Only events that concern a personal agent this assistant setup made, assistant.message included (null: no setup scope). Never with member_id.';

-- The event writers look up active endpoints by event type, then by scope.
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_active_events ON pm.webhook_endpoints USING gin (events) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_assistant_setup ON pm.webhook_endpoints (assistant_setup_id) WHERE assistant_setup_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Which setup made a personal agent
-- ---------------------------------------------------------------------------
-- The setup a person's agent from p_template comes from, as provisioning
-- picks it: the oldest setup with that template whose role the person has
-- or whose live group they are in, switched-on setups first.
CREATE OR REPLACE FUNCTION pm.assistant_setup_for(p_person uuid, p_template text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.id
  FROM pm.assistant_setups s
  JOIN pm.team_members p ON p.id = p_person
  WHERE s.template_key = p_template
    AND (s.match_role = p.role OR EXISTS (
      SELECT 1 FROM pm.group_members g JOIN pm.groups gr ON gr.id = g.group_id AND gr.deleted_at IS NULL
      WHERE g.group_id = s.match_group_id AND g.member_id = p.id
    ))
  ORDER BY s.enabled DESC, s.created_at, s.id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION pm.assistant_setup_for(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.assistant_setup_for(uuid, text) TO service_role;

-- Personal agents made before: the setup that matches them now, else the
-- one setup with their template when there is exactly one.
UPDATE pm.team_members a
SET assistant_setup_id = coalesce(
  pm.assistant_setup_for(a.delegate_of, a.assistant_template),
  (SELECT (array_agg(s.id))[1] FROM pm.assistant_setups s WHERE s.template_key = a.assistant_template HAVING count(*) = 1)
)
WHERE a.role = 'agent' AND a.delegate_of IS NOT NULL AND a.assistant_template IS NOT NULL AND a.assistant_setup_id IS NULL;

-- Only the server or a signed-in Owner says which setup made an agent.
CREATE OR REPLACE FUNCTION pm.team_members_assistant_setup_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR coalesce(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.assistant_setup_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.assistant_setup_id IS NOT DISTINCT FROM OLD.assistant_setup_id THEN
    RETURN NEW;
  END IF;
  IF coalesce(pm.current_team_member_role(), '') <> 'owner' THEN
    RAISE EXCEPTION 'Which setup made an agent changes only by an Owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.team_members_assistant_setup_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS team_members_assistant_setup_guard ON pm.team_members;
CREATE TRIGGER team_members_assistant_setup_guard
  BEFORE INSERT OR UPDATE OF assistant_setup_id ON pm.team_members
  FOR EACH ROW EXECUTE FUNCTION pm.team_members_assistant_setup_guard();

-- Makes personal agents in bulk: one row per element of p_agents (name,
-- email, delegate_of, assistant_template, assistant_setup_id, title,
-- agent_role, agent_profile, description, and the four rules). A person who
-- already has a personal agent from that template, or who is not an active
-- person, is skipped. Each one records the setup that made it (the one
-- given, else pm.assistant_setup_for) and gets the audit row that records
-- its template. Answers what was made.
CREATE OR REPLACE FUNCTION pm.provision_personal_agents(p_agents jsonb, p_actor uuid)
RETURNS TABLE (id uuid, delegate_of uuid, assistant_template text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH made AS (
    INSERT INTO pm.team_members AS m (
      name, email, role, title, agent_role, agent_profile, description, delegate_of, assistant_template, assistant_setup_id,
      agent_self_assign, agent_close_policy, agent_create_policy, agent_escalate_to
    )
    SELECT x.name, x.email, 'agent', x.title, x.agent_role, coalesce(x.agent_profile, 'generic'), x.description,
      x.delegate_of, x.assistant_template,
      coalesce(x.assistant_setup_id, pm.assistant_setup_for(x.delegate_of, x.assistant_template)),
      coalesce(x.agent_self_assign, false), coalesce(x.agent_close_policy, 'close'), coalesce(x.agent_create_policy, 'live'),
      coalesce(x.agent_escalate_to, x.delegate_of)
    FROM jsonb_to_recordset(p_agents) AS x(
      name text, email text, title text, agent_role text, agent_profile text, description text,
      delegate_of uuid, assistant_template text, assistant_setup_id uuid,
      agent_self_assign boolean, agent_close_policy text, agent_create_policy text, agent_escalate_to uuid
    )
    JOIN pm.team_members p ON p.id = x.delegate_of AND p.role <> 'agent' AND coalesce(p.status, 'active') = 'active'
    ON CONFLICT (delegate_of, assistant_template) WHERE delegate_of IS NOT NULL AND assistant_template IS NOT NULL DO NOTHING
    RETURNING m.id, m.delegate_of, m.assistant_template, m.name, m.agent_role
  ), audited AS (
    INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, team_member_id, request_body, after_snapshot, status_code, via)
    SELECT 'POST', '/api/workspace/agents', 'team_member', made.id, p_actor,
      jsonb_build_object('template', made.assistant_template, 'personal_of', made.delegate_of, 'provisioned', true),
      jsonb_build_object('agent', jsonb_build_object('id', made.id, 'name', made.name, 'agent_role', made.agent_role, 'delegate_of', made.delegate_of)),
      201, 'app'
    FROM made
  )
  SELECT made.id, made.delegate_of, made.assistant_template FROM made;
END;
$$;

REVOKE ALL ON FUNCTION pm.provision_personal_agents(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.provision_personal_agents(jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Matching
-- ---------------------------------------------------------------------------
-- Whether an endpoint receives an event: active, subscribed to its type, and
-- inside its filters. p_project_ids holds every project the event touches (a
-- task moved between projects touches both); p_member_ids is who it
-- concerns. A setup scope matches when one of them is a personal agent that
-- setup made.
CREATE OR REPLACE FUNCTION pm.webhook_endpoint_matches(
  p_endpoint pm.webhook_endpoints,
  p_event_type text,
  p_project_ids uuid[],
  p_member_ids uuid[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pm
AS $$
  SELECT p_endpoint.is_active
    AND p_event_type = ANY (p_endpoint.events)
    AND (p_endpoint.project_ids IS NULL OR p_endpoint.project_ids && coalesce(p_project_ids, '{}'))
    AND (p_endpoint.member_id IS NULL OR p_endpoint.member_id = ANY (coalesce(p_member_ids, '{}')))
    AND (p_endpoint.assistant_setup_id IS NULL OR EXISTS (
      SELECT 1 FROM pm.team_members a
      WHERE a.id = ANY (coalesce(p_member_ids, '{}'))
        AND a.assistant_setup_id = p_endpoint.assistant_setup_id
        AND a.role = 'agent' AND a.delegate_of IS NOT NULL
    ))
$$;

REVOKE ALL ON FUNCTION pm.webhook_endpoint_matches(pm.webhook_endpoints, text, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The event writer for everything but invoices
-- ---------------------------------------------------------------------------
-- Records one event and fans out one delivery per matching endpoint; writes
-- nothing when no endpoint matches. The matching endpoints are found once
-- (active ones subscribed to the type, through the events index, then the
-- filters) and the deliveries are made from that list. p_data becomes the
-- payload's data, with member_ids added.
--
-- p_folds_into: when the subject's latest event in this transaction is one of
-- these types (and nothing has been tried yet), it is refreshed instead: its
-- data becomes p_data, member_ids and changes become the union of both, and
-- endpoints that match now get a delivery too. Nothing else sees an event
-- before its transaction commits, so a refresh is never a change to
-- something sent.
CREATE OR REPLACE FUNCTION pm.emit_webhook_event(
  p_event_type text,
  p_subject_type text,
  p_subject_id uuid,
  p_project_ids uuid[],
  p_member_ids uuid[],
  p_data jsonb,
  p_folds_into text[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_latest pm.webhook_events;
  v_members uuid[] := coalesce(p_member_ids, '{}');
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_changes jsonb;
  v_endpoints uuid[];
  v_seq bigint;
  v_public_id text;
  v_event_uuid uuid;
BEGIN
  IF p_folds_into IS NOT NULL THEN
    SELECT * INTO v_latest
    FROM pm.webhook_events ev
    WHERE ev.resource_type = p_subject_type AND ev.resource_id = p_subject_id AND ev.created_at = now()
    ORDER BY ev.sequence DESC
    LIMIT 1;
    IF FOUND AND v_latest.event_type = ANY (p_folds_into) AND NOT EXISTS (
      SELECT 1 FROM pm.webhook_deliveries d
      WHERE d.webhook_event_id = v_latest.id AND (d.status <> 'pending' OR d.attempts > 0)
    ) THEN
      SELECT coalesce(array_agg(DISTINCT m ORDER BY m), '{}') INTO v_members
      FROM (
        SELECT unnest(v_members) AS m
        UNION ALL
        SELECT value::uuid FROM jsonb_array_elements_text(coalesce(v_latest.payload -> 'data' -> 'member_ids', '[]'::jsonb))
      ) folded;
      IF (v_latest.payload -> 'data') ? 'changes' THEN
        SELECT coalesce(jsonb_agg(DISTINCT c ORDER BY c), '[]'::jsonb) INTO v_changes
        FROM (
          SELECT jsonb_array_elements_text(v_latest.payload -> 'data' -> 'changes') AS c
          UNION ALL
          SELECT jsonb_array_elements_text(coalesce(v_data -> 'changes', '[]'::jsonb))
        ) folded;
        v_data := v_data || jsonb_build_object('changes', v_changes);
      ELSE
        v_data := v_data - 'changes';
      END IF;

      UPDATE pm.webhook_events
      SET payload = jsonb_set(payload, '{data}', v_data || jsonb_build_object('member_ids', to_jsonb(v_members)))
      WHERE id = v_latest.id;

      INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id)
      SELECT v_latest.id, e.id
      FROM pm.webhook_endpoints e
      WHERE e.is_active AND e.events @> ARRAY[v_latest.event_type]
        AND pm.webhook_endpoint_matches(e, v_latest.event_type, p_project_ids, v_members)
        AND NOT EXISTS (
          SELECT 1 FROM pm.webhook_deliveries d WHERE d.webhook_event_id = v_latest.id AND d.endpoint_id = e.id
        );
      RETURN;
    END IF;
  END IF;

  SELECT array_agg(e.id ORDER BY e.id) INTO v_endpoints
  FROM pm.webhook_endpoints e
  WHERE e.is_active AND e.events @> ARRAY[p_event_type]
    AND pm.webhook_endpoint_matches(e, p_event_type, p_project_ids, v_members);
  IF v_endpoints IS NULL THEN
    RETURN;
  END IF;

  v_seq := nextval('pm.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
  VALUES (
    v_public_id, v_seq, p_event_type, p_subject_type, p_subject_id,
    jsonb_build_object(
      'id', v_public_id,
      'type', p_event_type,
      'sequence', v_seq,
      'created_at', now(),
      'data', v_data || jsonb_build_object('member_ids', to_jsonb(v_members))
    )
  )
  RETURNING id INTO v_event_uuid;

  INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id)
  SELECT v_event_uuid, unnest(v_endpoints);
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_webhook_event(text, text, uuid, uuid[], uuid[], jsonb, text[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The invoice event writer
-- ---------------------------------------------------------------------------
-- Split out of the trigger so a split change on a paid invoice can announce
-- itself too (see emit_invoice_webhook_for_shares). p_data is merged into
-- the payload's data (the payment events use it). The matching endpoints
-- are found once, as for every other event.
CREATE OR REPLACE FUNCTION pm.emit_invoice_webhook_event(
  p_row pm.project_invoices,
  p_event_type text,
  p_data jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_is_paid boolean := (p_event_type <> 'invoice.deleted' AND p_row.status = 'paid');
  v_project_name text;
  v_totals jsonb;
  v_endpoints uuid[];
  v_public_id text;
  v_seq bigint;
  v_event_uuid uuid;
  v_payload jsonb;
BEGIN
  -- An invoice concerns no member: an endpoint with a member or setup filter never gets one.
  SELECT array_agg(e.id ORDER BY e.id) INTO v_endpoints
  FROM pm.webhook_endpoints e
  WHERE e.is_active AND e.events @> ARRAY[p_event_type]
    AND pm.webhook_endpoint_matches(e, p_event_type, ARRAY[p_row.project_id], '{}');
  IF v_endpoints IS NULL THEN
    RETURN;
  END IF;

  SELECT name INTO v_project_name
  FROM pm.projects WHERE id = p_row.project_id;

  SELECT coalesce(jsonb_object_agg(t.item_type, t.subtotal), '{}'::jsonb)
    INTO v_totals
  FROM (
    SELECT li->>'item_type' AS item_type, sum((li->>'amount')::numeric) AS subtotal
    FROM jsonb_array_elements(
           coalesce(nullif(p_row.line_items, 'null'::jsonb), '[]'::jsonb)
         ) li
    WHERE li ? 'item_type'
    GROUP BY li->>'item_type'
  ) t;

  IF v_totals = '{}'::jsonb THEN
    v_totals := jsonb_build_object(p_row.invoice_type, p_row.amount);
  END IF;

  v_seq := nextval('pm.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  v_payload := jsonb_build_object(
    'id', v_public_id,
    'type', p_event_type,
    'sequence', v_seq,
    'created_at', now(),
    'data', jsonb_build_object(
      'invoice', jsonb_build_object(
        'id', p_row.id,
        'invoice_number', p_row.invoice_number,
        'project_id', p_row.project_id,
        'status', p_row.status,
        'paid', v_is_paid,
        'invoice_type', p_row.invoice_type,
        'amount', p_row.amount,
        'date', p_row.date,
        'due_date', p_row.due_date,
        'paid_date', p_row.paid_date,
        'description', p_row.description,
        'updated_at', p_row.updated_at
      ),
      'project', jsonb_build_object(
        'id', p_row.project_id,
        'name', coalesce(v_project_name, '')
      ),
      'line_items', coalesce(nullif(p_row.line_items, 'null'::jsonb), '[]'::jsonb),
      'totals_by_type', v_totals
    ) || coalesce(p_data, '{}'::jsonb)
  );

  INSERT INTO pm.webhook_events (
    event_id, sequence, event_type, resource_type, resource_id, payload, net_amounts
  )
  VALUES (
    v_public_id, v_seq, p_event_type, 'invoice', p_row.id, v_payload,
    pm.invoice_net_amounts(p_row)
  )
  RETURNING id INTO v_event_uuid;

  INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id)
  SELECT v_event_uuid, unnest(v_endpoints);
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_invoice_webhook_event(pm.project_invoices, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.emit_invoice_webhook_event(pm.project_invoices, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- assistant.message
-- ---------------------------------------------------------------------------
-- Only an endpoint filtered to a personal agent (member_id), or scoped to an
-- assistant setup, takes assistant.message: chat is private, so no
-- workspace-wide endpoint ever lists it. Only a signed-in Owner or the
-- server (which checks for an Owner or a key with assistants.provision)
-- scopes an endpoint to a setup.
CREATE OR REPLACE FUNCTION pm.webhook_endpoints_assistant_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.assistant_setup_id IS NOT NULL AND auth.uid() IS NOT NULL AND coalesce(auth.role(), '') <> 'service_role' THEN
    IF TG_OP = 'INSERT' OR NEW.assistant_setup_id IS DISTINCT FROM OLD.assistant_setup_id THEN
      IF coalesce(pm.current_team_member_role(), '') <> 'owner' THEN
        RAISE EXCEPTION 'Only an Owner scopes an endpoint to an assistant setup' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF 'assistant.message' = ANY (NEW.events) AND NEW.assistant_setup_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM pm.team_members a WHERE a.id = NEW.member_id AND a.role = 'agent' AND a.delegate_of IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'assistant.message goes only to an endpoint filtered to a personal agent (member_id) or scoped to an assistant setup (assistant_setup_id)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pm.webhook_endpoints_assistant_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_endpoints_assistant_guard ON pm.webhook_endpoints;
CREATE TRIGGER webhook_endpoints_assistant_guard
  BEFORE INSERT OR UPDATE OF events, member_id, assistant_setup_id ON pm.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION pm.webhook_endpoints_assistant_guard();

-- Queues one assistant.message event (its own line: resource chat_message)
-- to every active endpoint subscribed to it whose member filter is exactly
-- the agent, or whose setup made the agent. Never to an endpoint with
-- neither, nor one filtered to projects (an event has no project). Answers
-- whether any endpoint got it; nothing is written when none does.
CREATE OR REPLACE FUNCTION pm.emit_assistant_message(p_message_id uuid, p_agent_id uuid, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pm
AS $$
DECLARE
  v_endpoints uuid[];
  v_seq bigint;
  v_public_id text;
  v_event_uuid uuid;
BEGIN
  SELECT array_agg(e.id ORDER BY e.id) INTO v_endpoints
  FROM pm.webhook_endpoints e
  WHERE e.is_active AND e.events @> ARRAY['assistant.message']
    AND (e.member_id = p_agent_id OR (e.member_id IS NULL AND e.assistant_setup_id IS NOT NULL))
    AND pm.webhook_endpoint_matches(e, 'assistant.message', '{}'::uuid[], ARRAY[p_agent_id]);
  IF v_endpoints IS NULL THEN
    RETURN false;
  END IF;

  v_seq := nextval('pm.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
  VALUES (
    v_public_id, v_seq, 'assistant.message', 'chat_message', p_message_id,
    jsonb_build_object(
      'id', v_public_id,
      'type', 'assistant.message',
      'sequence', v_seq,
      'created_at', now(),
      'data', coalesce(p_data, '{}'::jsonb) || jsonb_build_object('member_ids', jsonb_build_array(p_agent_id))
    )
  )
  RETURNING id INTO v_event_uuid;

  INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id)
  SELECT v_event_uuid, unnest(v_endpoints);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION pm.emit_assistant_message(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pm.emit_assistant_message(uuid, uuid, jsonb) TO service_role;
