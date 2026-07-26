-- ============================================================
-- Outbound webhook platform (generic) + invoice.paid emitter
-- ------------------------------------------------------------
-- Transactional outbox: a trigger on project_invoices records a
-- point-in-time event and fans out one delivery row per subscribed
-- endpoint. A TypeScript dispatcher signs and delivers each once
-- (fire-and-forget); a failed delivery can be re-sent manually from the UI.
-- No pg_net: the trigger only writes rows.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Permission: manage webhook endpoints (app channel, owner/admin).
-- ------------------------------------------------------------
INSERT INTO public.role_permissions (role, permission_key, access_channel)
VALUES ('admin', 'webhooks.manage', 'app')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Monotonic per-event sequence. Globally increasing => per-invoice
-- strictly increasing, which lets consumers drop out-of-order deliveries.
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.webhook_event_seq;

-- ------------------------------------------------------------
-- Endpoints (subscriptions). Secret is stored retrievably because it
-- is needed to compute the HMAC at delivery time (it is a signing
-- secret, not a third-party credential).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  secret text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  last_delivery_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Append-only event log (the "outbox" source of truth).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL UNIQUE,
  sequence bigint NOT NULL UNIQUE,
  event_type text NOT NULL,
  resource_type text NOT NULL DEFAULT 'invoice',
  resource_id uuid,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_resource
  ON public.webhook_events (resource_type, resource_id);

-- ------------------------------------------------------------
-- Per-(event x endpoint) delivery attempts.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id uuid NOT NULL REFERENCES public.webhook_events(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_status_code int,
  last_error text,
  last_response text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
  ON public.webhook_deliveries (created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
  ON public.webhook_deliveries (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event
  ON public.webhook_deliveries (webhook_event_id);

-- updated_at bumps (reuse existing helper).
CREATE OR REPLACE TRIGGER set_webhook_endpoints_updated_at
  BEFORE UPDATE ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE OR REPLACE TRIGGER set_webhook_deliveries_updated_at
  BEFORE UPDATE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ------------------------------------------------------------
-- Emitter: records an invoice event and fans out deliveries.
-- Fires only for paid-relevant invoices (currently paid, or leaving
-- paid), so editing drafts stays silent. Full current-state payload
-- lets any consumer reconcile.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.emit_invoice_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op text := TG_OP;
  v_row public.project_invoices;
  v_was_paid boolean;
  v_is_paid boolean;
  v_event_type text;
  v_project_name text;
  v_totals jsonb;
  v_public_id text;
  v_seq bigint;
  v_event_uuid uuid;
  v_payload jsonb;
BEGIN
  IF v_op = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  v_was_paid := (v_op <> 'INSERT' AND OLD.status = 'paid');
  v_is_paid  := (v_op <> 'DELETE' AND NEW.status = 'paid');

  -- Decide event type / whether to emit at all.
  IF v_op = 'DELETE' THEN
    IF NOT v_was_paid THEN
      RETURN OLD;  -- deleting a never-paid invoice: nothing downstream cares
    END IF;
    v_event_type := 'invoice.deleted';
  ELSIF v_op = 'INSERT' THEN
    IF NOT v_is_paid THEN
      RETURN NEW;
    END IF;
    v_event_type := 'invoice.paid';
  ELSE  -- UPDATE
    IF NOT (v_is_paid OR v_was_paid) THEN
      RETURN NEW;  -- draft/other edits on non-paid invoices: ignore
    END IF;
    IF v_is_paid AND NOT v_was_paid THEN
      v_event_type := 'invoice.paid';
    ELSE
      -- Still paid (edit) or transitioned out of paid (un-pay/cancel).
      -- Skip no-op updates that touch no webhook-relevant field.
      IF v_is_paid AND v_was_paid
         AND NEW.status IS NOT DISTINCT FROM OLD.status
         AND NEW.paid_date IS NOT DISTINCT FROM OLD.paid_date
         AND NEW.amount IS NOT DISTINCT FROM OLD.amount
         AND NEW.line_items IS NOT DISTINCT FROM OLD.line_items
         AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
         AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
         AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
        RETURN NEW;
      END IF;
      v_event_type := 'invoice.updated';
    END IF;
  END IF;

  -- Nothing subscribed => don't bother building a payload.
  IF NOT EXISTS (
    SELECT 1 FROM public.webhook_endpoints e
    WHERE e.is_active AND v_event_type = ANY(e.events)
  ) THEN
    RETURN CASE WHEN v_op = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT name INTO v_project_name
  FROM public.projects WHERE id = v_row.project_id;

  -- Subtotal per line-item type; fall back to {invoice_type: amount}
  -- when the invoice has no explicit line items.
  SELECT COALESCE(jsonb_object_agg(t.item_type, t.subtotal), '{}'::jsonb)
    INTO v_totals
  FROM (
    SELECT li->>'item_type' AS item_type, SUM((li->>'amount')::numeric) AS subtotal
    FROM jsonb_array_elements(
           COALESCE(NULLIF(v_row.line_items, 'null'::jsonb), '[]'::jsonb)
         ) li
    WHERE li ? 'item_type'
    GROUP BY li->>'item_type'
  ) t;

  IF v_totals = '{}'::jsonb THEN
    v_totals := jsonb_build_object(v_row.invoice_type, v_row.amount);
  END IF;

  v_seq := nextval('public.webhook_event_seq');
  v_public_id := 'evt_' || replace(gen_random_uuid()::text, '-', '');

  v_payload := jsonb_build_object(
    'id', v_public_id,
    'type', v_event_type,
    'sequence', v_seq,
    'created_at', now(),
    'data', jsonb_build_object(
      'invoice', jsonb_build_object(
        'id', v_row.id,
        'invoice_number', v_row.invoice_number,
        'project_id', v_row.project_id,
        'status', v_row.status,
        'paid', v_is_paid,
        'invoice_type', v_row.invoice_type,
        'amount', v_row.amount,
        'date', v_row.date,
        'due_date', v_row.due_date,
        'paid_date', v_row.paid_date,
        'description', v_row.description,
        'updated_at', v_row.updated_at
      ),
      'project', jsonb_build_object(
        'id', v_row.project_id,
        'name', COALESCE(v_project_name, '')
      ),
      'line_items', COALESCE(NULLIF(v_row.line_items, 'null'::jsonb), '[]'::jsonb),
      'totals_by_type', v_totals
    )
  );

  INSERT INTO public.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
  VALUES (v_public_id, v_seq, v_event_type, 'invoice', v_row.id, v_payload)
  RETURNING id INTO v_event_uuid;

  INSERT INTO public.webhook_deliveries (webhook_event_id, endpoint_id)
  SELECT v_event_uuid, e.id
  FROM public.webhook_endpoints e
  WHERE e.is_active AND v_event_type = ANY(e.events);

  RETURN CASE WHEN v_op = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE TRIGGER emit_invoice_webhook
  AFTER INSERT OR UPDATE OR DELETE ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.emit_invoice_webhook();

-- ------------------------------------------------------------
-- RLS. App-side access is gated on webhooks.manage; the dispatcher
-- and emitter use the service role / definer and bypass these.
-- ------------------------------------------------------------
ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_endpoints_manage ON public.webhook_endpoints;
CREATE POLICY webhook_endpoints_manage ON public.webhook_endpoints FOR ALL TO authenticated
  USING (public.has_permission('webhooks.manage'))
  WITH CHECK (public.has_permission('webhooks.manage'));

DROP POLICY IF EXISTS webhook_events_select ON public.webhook_events;
CREATE POLICY webhook_events_select ON public.webhook_events FOR SELECT TO authenticated
  USING (public.has_permission('webhooks.manage'));

DROP POLICY IF EXISTS webhook_deliveries_select ON public.webhook_deliveries;
CREATE POLICY webhook_deliveries_select ON public.webhook_deliveries FOR SELECT TO authenticated
  USING (public.has_permission('webhooks.manage'));

-- Manual re-send of a failed delivery from the UI.
DROP POLICY IF EXISTS webhook_deliveries_requeue ON public.webhook_deliveries;
CREATE POLICY webhook_deliveries_requeue ON public.webhook_deliveries FOR UPDATE TO authenticated
  USING (public.has_permission('webhooks.manage'))
  WITH CHECK (public.has_permission('webhooks.manage'));

-- ------------------------------------------------------------
-- Atomic claim for the dispatcher. FOR UPDATE SKIP LOCKED lets concurrent
-- in-app kicks run without ever double-sending the same delivery. Marks rows
-- 'delivering' and counts attempts as it hands them out.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(p_limit int DEFAULT 20)
RETURNS TABLE (
  delivery_id uuid,
  attempts int,
  endpoint_id uuid,
  endpoint_url text,
  endpoint_secret text,
  event_public_id text,
  event_type text,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT d2.id
    FROM public.webhook_deliveries d2
    JOIN public.webhook_endpoints e2 ON e2.id = d2.endpoint_id
    WHERE d2.status = 'pending'
      AND e2.is_active
    ORDER BY d2.created_at
    FOR UPDATE OF d2 SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.webhook_deliveries d
  SET status = 'delivering',
      attempts = d.attempts + 1,
      last_attempt_at = now()
  FROM claimed, public.webhook_events ev, public.webhook_endpoints e
  WHERE d.id = claimed.id
    AND ev.id = d.webhook_event_id
    AND e.id = d.endpoint_id
  RETURNING d.id, d.attempts,
            e.id, e.url, e.secret,
            ev.event_id, ev.event_type, ev.payload;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_webhook_deliveries(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_webhook_deliveries(int) TO service_role;

COMMIT;
