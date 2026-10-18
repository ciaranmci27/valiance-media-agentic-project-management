-- Invoices keep a record of each payment.
--
-- invoice_payments holds every amount received against an invoice: by hand in
-- the app ("app"), or by an accounting tool through the API ("api"). What is
-- owed is the invoice total the PDF shows: amount plus tax at the project's
-- rate on every line but reimbursements (invoice_total). The invoice's status
-- follows its payments:
--   payments reach the total             -> paid, paid_date = latest payment
--   payments drop below while paid       -> overdue if past due, else sent
--   less than the total (partial)        -> status stays sent or overdue
-- and the status still works the old way by hand. Setting an invoice to paid
-- records an "app" payment for what is outstanding; moving it off paid
-- removes its "app" payments. Payments recorded by an accounting connection
-- ("api") pin the invoice: it cannot be moved off paid, set to draft,
-- cancelled or deleted until they are removed through the API.
--
-- Removing a payment that un-pays an invoice whose revenue-split earnings were
-- already paid out is refused, so a payout is never reversed quietly. Moving
-- such an invoice off paid by hand keeps today's behavior (a deduction).
--
-- New webhook events invoice.payment_recorded and invoice.payment_removed.
-- invoice.paid, invoice.updated and invoice.deleted keep their meaning, and a
-- change still raises exactly one of them.
--
-- Backfill: one "app" payment per paid invoice, with no invoice row changed
-- and no webhook raised.
--
-- Apply BEFORE the app deploy. Safe to run twice.

-- -- Table ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.project_invoices(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  paid_date date NOT NULL,
  method text CHECK (method IN ('ach', 'wire', 'check', 'card', 'cash', 'other')),
  reference text,
  -- The caller's own id for this payment: replaying it returns the same row.
  external_id text,
  recorded_via text NOT NULL DEFAULT 'app' CHECK (recorded_via IN ('app', 'api')),
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, external_id)
);

DROP TRIGGER IF EXISTS set_invoice_payments_updated_at ON public.invoice_payments;
CREATE TRIGGER set_invoice_payments_updated_at
  BEFORE UPDATE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Read with the invoice; written only through the functions below.
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_payments_select ON public.invoice_payments;
CREATE POLICY invoice_payments_select ON public.invoice_payments FOR SELECT TO authenticated
  USING ((public.has_permission('invoices.read') OR public.has_permission('invoices.manage')) AND EXISTS (
    SELECT 1 FROM public.project_invoices invoice
    WHERE invoice.id = invoice_id AND public.can_access_project(invoice.project_id)
  ));
REVOKE ALL ON public.invoice_payments FROM anon, authenticated;
GRANT SELECT ON public.invoice_payments TO authenticated;
GRANT ALL ON public.invoice_payments TO service_role;

-- -- Permission -------------------------------------------------------------

-- Owners hold every permission; admins record payments in the app. API keys
-- get it only from an Owner (or an explicit override).
INSERT INTO public.role_permissions (role, permission_key, access_channel) VALUES
  ('admin', 'invoices.record_payments', 'app')
ON CONFLICT DO NOTHING;

-- -- Helpers ----------------------------------------------------------------

-- An invoice's TEXT date as a date: the leading YYYY-MM-DD, or null when
-- there is none or it is not a real day.
CREATE OR REPLACE FUNCTION public.invoice_text_date(p_value text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_value IS NULL OR p_value !~ '^\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  RETURN substring(p_value FROM 1 FOR 10)::date;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN NULL;
END;
$$;

-- What the client owes for an invoice, as the PDF totals it
-- (lib/invoice-pdf/buildInvoiceData.ts): the amount, plus tax at the
-- project's current rate on every line except reimbursements. A line-less
-- (legacy) invoice is one line of its invoice_type.
CREATE OR REPLACE FUNCTION public.invoice_total(p_invoice public.project_invoices)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_invoice.amount + COALESCE(ROUND(
    CASE
      WHEN jsonb_typeof(p_invoice.line_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_invoice.line_items) = 0
        THEN p_invoice.amount
      ELSE (
        SELECT COALESCE(sum(COALESCE(NULLIF(line->>'amount', '')::numeric, 0)), 0)
        FROM jsonb_array_elements(p_invoice.line_items) line
        WHERE COALESCE(line->>'item_type', '') <> 'reimbursement'
      )
    END * project.tax_rate / 100, 2), 0)
  FROM (SELECT 1) one
  LEFT JOIN public.projects project ON project.id = p_invoice.project_id
$$;

-- True when a live revenue-split earning on the invoice is already in a
-- payout that was not voided.
CREATE OR REPLACE FUNCTION public.invoice_share_earnings_paid_out(p_invoice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_member_share_earnings earning
    JOIN public.team_member_payout_allocations allocation ON allocation.share_earning_id = earning.id
    JOIN public.team_member_payouts payout ON payout.id = allocation.payout_id
    WHERE earning.invoice_id = p_invoice_id
      AND earning.voided_at IS NULL AND earning.reversed_at IS NULL
      AND payout.voided_at IS NULL
  )
$$;

-- What a payment event adds to the invoice payload. Amounts are what the
-- client paid (gross), whatever basis the endpoint receives.
CREATE OR REPLACE FUNCTION public.invoice_payment_event_data(
  p_payment public.invoice_payments,
  p_invoice public.project_invoices
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'payment', jsonb_build_object(
      'id', p_payment.id,
      'amount', p_payment.amount,
      'paid_date', p_payment.paid_date,
      'method', p_payment.method,
      'reference', p_payment.reference,
      'external_id', p_payment.external_id,
      'recorded_via', p_payment.recorded_via,
      'created_at', p_payment.created_at
    ),
    'total', public.invoice_total(p_invoice),
    'paid_total', paid.total,
    'outstanding', GREATEST(public.invoice_total(p_invoice) - paid.total, 0)
  )
  FROM (
    SELECT COALESCE(sum(amount), 0) AS total
    FROM public.invoice_payments WHERE invoice_id = p_invoice.id
  ) paid
$$;

-- -- Webhook event writer ---------------------------------------------------

-- Same writer as before, with an optional p_data merged into the payload's
-- data (the payment events use it). Two-argument callers are unchanged.
DROP FUNCTION IF EXISTS public.emit_invoice_webhook_event(public.project_invoices, text);
CREATE OR REPLACE FUNCTION public.emit_invoice_webhook_event(
  p_row public.project_invoices,
  p_event_type text,
  p_data jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_paid boolean := (p_event_type <> 'invoice.deleted' AND p_row.status = 'paid');
  v_project_name text;
  v_totals jsonb;
  v_public_id text;
  v_seq bigint;
  v_event_uuid uuid;
  v_payload jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.webhook_endpoints e
    WHERE e.is_active AND p_event_type = any(e.events)
  ) THEN
    RETURN;
  END IF;

  SELECT name INTO v_project_name
  FROM public.projects WHERE id = p_row.project_id;

  SELECT COALESCE(jsonb_object_agg(t.item_type, t.subtotal), '{}'::jsonb)
    INTO v_totals
  FROM (
    SELECT li->>'item_type' AS item_type, sum((li->>'amount')::numeric) AS subtotal
    FROM jsonb_array_elements(
           COALESCE(NULLIF(p_row.line_items, 'null'::jsonb), '[]'::jsonb)
         ) li
    WHERE li ? 'item_type'
    GROUP BY li->>'item_type'
  ) t;

  IF v_totals = '{}'::jsonb THEN
    v_totals := jsonb_build_object(p_row.invoice_type, p_row.amount);
  END IF;

  v_seq := nextval('public.webhook_event_seq');
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
        'name', COALESCE(v_project_name, '')
      ),
      'line_items', COALESCE(NULLIF(p_row.line_items, 'null'::jsonb), '[]'::jsonb),
      'totals_by_type', v_totals
    ) || COALESCE(p_data, '{}'::jsonb)
  );

  INSERT INTO public.webhook_events (
    event_id, sequence, event_type, resource_type, resource_id, payload, net_amounts
  )
  VALUES (
    v_public_id, v_seq, p_event_type, 'invoice', p_row.id, v_payload,
    public.invoice_net_amounts(p_row)
  )
  RETURNING id INTO v_event_uuid;

  INSERT INTO public.webhook_deliveries (webhook_event_id, endpoint_id)
  SELECT v_event_uuid, e.id
  FROM public.webhook_endpoints e
  WHERE e.is_active AND p_event_type = any(e.events);
END;
$$;

-- -- Status follows payments ------------------------------------------------

-- After a payment is added, changed or removed. Skipped while the invoice
-- side (or the backfill) is writing payments itself: app.invoice_payment_sync.
CREATE OR REPLACE FUNCTION public.sync_invoice_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice public.project_invoices;
  v_row public.project_invoices;
  v_paid numeric;
  v_last date;
BEGIN
  IF current_setting('app.invoice_payment_sync', true) = 'on' THEN RETURN NULL; END IF;

  SELECT * INTO v_invoice
  FROM public.project_invoices
  WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END
  FOR UPDATE;
  -- Gone: the invoice delete is cascading to its payments.
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(amount), 0), max(paid_date) INTO v_paid, v_last
  FROM public.invoice_payments WHERE invoice_id = v_invoice.id;

  v_row := v_invoice;
  IF v_invoice.status IN ('sent', 'overdue', 'paid') AND v_paid > 0 AND v_paid >= public.invoice_total(v_invoice) THEN
    v_row.status := 'paid';
    IF public.invoice_text_date(v_invoice.paid_date) IS DISTINCT FROM v_last THEN
      v_row.paid_date := to_char(v_last, 'YYYY-MM-DD');
    END IF;
  ELSIF v_invoice.status = 'paid' THEN
    IF public.invoice_share_earnings_paid_out(v_invoice.id) THEN
      RAISE EXCEPTION 'PAYMENT_SHARES_PAID_OUT: This invoice''s revenue split is already paid out, so it cannot become unpaid. Void that payout first.';
    END IF;
    v_row.status := CASE
      WHEN public.invoice_text_date(v_invoice.due_date) < public.workspace_today() THEN 'overdue'
      ELSE 'sent'
    END;
    v_row.paid_date := NULL;
  END IF;
  v_row.updated_at := now();

  -- The payment event first, carrying the status it leads to; then at most
  -- one invoice.paid or invoice.updated from the row change below.
  IF TG_OP = 'INSERT' THEN
    PERFORM public.emit_invoice_webhook_event(v_row, 'invoice.payment_recorded', public.invoice_payment_event_data(NEW, v_row));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.emit_invoice_webhook_event(v_row, 'invoice.payment_removed', public.invoice_payment_event_data(OLD, v_row));
  END IF;

  PERFORM set_config('app.invoice_payment_sync', 'on', true);
  IF v_row.status IS DISTINCT FROM v_invoice.status OR v_row.paid_date IS DISTINCT FROM v_invoice.paid_date THEN
    UPDATE public.project_invoices
    SET status = v_row.status, paid_date = v_row.paid_date
    WHERE id = v_invoice.id;
  ELSE
    -- Outstanding changed: readers that sync by updated_at see it.
    UPDATE public.project_invoices SET updated_at = now() WHERE id = v_invoice.id;
  END IF;
  PERFORM set_config('app.invoice_payment_sync', '', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sync_invoice_payment_status ON public.invoice_payments;
CREATE TRIGGER sync_invoice_payment_status
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.sync_invoice_payment_status();

-- -- Payments follow the status ---------------------------------------------

-- BEFORE UPDATE on the invoice, because people (and the invoices_manage RLS
-- policy, FOR ALL) still write status, amount, lines and paid_date directly.
CREATE OR REPLACE FUNCTION public.sync_invoice_payments_from_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_api integer;
  v_app integer;
  v_paid numeric;
  v_last date;
  v_on date;
  v_total numeric;
  v_payment public.invoice_payments;
  v_follows boolean := false;
BEGIN
  IF current_setting('app.invoice_payment_sync', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.line_items IS NOT DISTINCT FROM OLD.line_items
     AND NEW.paid_date IS NOT DISTINCT FROM OLD.paid_date THEN
    RETURN NEW;
  END IF;
  v_total := public.invoice_total(NEW);

  SELECT count(*) FILTER (WHERE recorded_via = 'api'),
         count(*) FILTER (WHERE recorded_via = 'app'),
         COALESCE(sum(amount), 0), max(paid_date)
  INTO v_api, v_app, v_paid, v_last
  FROM public.invoice_payments WHERE invoice_id = OLD.id;

  IF NEW.status = 'paid' THEN
    v_on := COALESCE(public.invoice_text_date(NEW.paid_date), public.workspace_today());
    -- Still paid, and the only payment is the bare one that stands for
    -- "paid" (as marking it paid, or the backfill, made it): it follows the
    -- invoice. A payment with a method, reference or external_id was recorded
    -- on purpose and is never rewritten.
    IF OLD.status = 'paid' AND v_api = 0 AND v_app = 1 THEN
      SELECT * INTO v_payment FROM public.invoice_payments WHERE invoice_id = OLD.id;
      v_follows := v_payment.method IS NULL AND v_payment.reference IS NULL AND v_payment.external_id IS NULL;
    END IF;
    IF OLD.status = 'paid' AND v_api + v_app > 0 AND NOT v_follows THEN
      -- The payments stay as recorded and decide the status.
      IF v_paid >= v_total THEN
        NEW.paid_date := to_char(v_last, 'YYYY-MM-DD');
      ELSE
        IF public.invoice_share_earnings_paid_out(NEW.id) THEN
          RAISE EXCEPTION 'PAYMENT_SHARES_PAID_OUT: This invoice''s revenue split is already paid out, so it cannot become unpaid. Void that payout first.';
        END IF;
        NEW.status := CASE
          WHEN public.invoice_text_date(NEW.due_date) < public.workspace_today() THEN 'overdue'
          ELSE 'sent'
        END;
        NEW.paid_date := NULL;
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.paid_date IS NULL THEN NEW.paid_date := to_char(v_on, 'YYYY-MM-DD'); END IF;
    PERFORM set_config('app.invoice_payment_sync', 'on', true);
    IF v_follows THEN
      IF v_total > 0 THEN
        UPDATE public.invoice_payments
        SET amount = v_total, paid_date = v_on
        WHERE invoice_id = NEW.id AND (amount <> v_total OR paid_date <> v_on);
      ELSE
        FOR v_payment IN DELETE FROM public.invoice_payments WHERE invoice_id = NEW.id RETURNING * LOOP
          PERFORM public.emit_invoice_webhook_event(NEW, 'invoice.payment_removed', public.invoice_payment_event_data(v_payment, NEW));
        END LOOP;
      END IF;
    ELSIF v_paid < v_total THEN
      INSERT INTO public.invoice_payments (invoice_id, amount, paid_date, recorded_via, created_by)
      VALUES (NEW.id, v_total - v_paid, v_on, 'app', public.current_team_member_id())
      RETURNING * INTO v_payment;
      PERFORM public.emit_invoice_webhook_event(NEW, 'invoice.payment_recorded', public.invoice_payment_event_data(v_payment, NEW));
    END IF;
    PERFORM set_config('app.invoice_payment_sync', '', true);
    RETURN NEW;
  END IF;

  IF v_api + v_app = 0 THEN RETURN NEW; END IF;

  IF OLD.status = 'paid' OR NEW.status IN ('draft', 'cancelled') THEN
    IF v_api > 0 THEN
      RAISE EXCEPTION 'PAYMENT_RECORDED_ELSEWHERE: This invoice has payments recorded by an accounting connection. Remove them there first.';
    END IF;
    PERFORM set_config('app.invoice_payment_sync', 'on', true);
    FOR v_payment IN DELETE FROM public.invoice_payments WHERE invoice_id = NEW.id RETURNING * LOOP
      PERFORM public.emit_invoice_webhook_event(NEW, 'invoice.payment_removed', public.invoice_payment_event_data(v_payment, NEW));
    END LOOP;
    PERFORM set_config('app.invoice_payment_sync', '', true);
    RETURN NEW;
  END IF;

  -- Sent or overdue with partial payments, and the total came down to them.
  IF v_total > 0 AND v_paid >= v_total THEN
    NEW.status := 'paid';
    NEW.paid_date := to_char(v_last, 'YYYY-MM-DD');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_invoice_payments_from_invoice ON public.project_invoices;
CREATE TRIGGER sync_invoice_payments_from_invoice
  BEFORE UPDATE OF status, amount, line_items, paid_date ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.sync_invoice_payments_from_invoice();

-- An invoice created as paid gets a paid date (BEFORE) and its payment
-- (AFTER). The AFTER trigger sorts before emit_invoice_webhook, so the
-- payment event comes ahead of the invoice event, as on an update.
CREATE OR REPLACE FUNCTION public.record_payment_for_paid_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.invoice_payments;
  v_total numeric;
BEGIN
  IF TG_WHEN = 'BEFORE' THEN
    IF NEW.status = 'paid' AND NEW.paid_date IS NULL THEN
      NEW.paid_date := to_char(public.workspace_today(), 'YYYY-MM-DD');
    END IF;
    RETURN NEW;
  END IF;
  IF current_setting('app.invoice_payment_sync', true) = 'on' THEN RETURN NULL; END IF;
  v_total := public.invoice_total(NEW);
  IF NEW.status <> 'paid' OR v_total <= 0 THEN RETURN NULL; END IF;
  PERFORM set_config('app.invoice_payment_sync', 'on', true);
  INSERT INTO public.invoice_payments (invoice_id, amount, paid_date, recorded_via, created_by)
  VALUES (NEW.id, v_total, COALESCE(public.invoice_text_date(NEW.paid_date), public.workspace_today()), 'app', public.current_team_member_id())
  RETURNING * INTO v_payment;
  PERFORM set_config('app.invoice_payment_sync', '', true);
  PERFORM public.emit_invoice_webhook_event(NEW, 'invoice.payment_recorded', public.invoice_payment_event_data(v_payment, NEW));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS record_payment_for_paid_invoice ON public.project_invoices;
DROP TRIGGER IF EXISTS apply_paid_date_for_paid_invoice ON public.project_invoices;
CREATE TRIGGER apply_paid_date_for_paid_invoice
  BEFORE INSERT ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.record_payment_for_paid_invoice();
DROP TRIGGER IF EXISTS apply_payment_for_paid_invoice ON public.project_invoices;
CREATE TRIGGER apply_payment_for_paid_invoice
  AFTER INSERT ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.record_payment_for_paid_invoice();

-- Payments recorded by an accounting connection pin the invoice. A project
-- delete cascading through its invoices is let through (the project row is
-- already gone), as retire_share_earning allows.
CREATE OR REPLACE FUNCTION public.guard_invoice_payments_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.projects WHERE id = OLD.project_id)
     AND EXISTS (SELECT 1 FROM public.invoice_payments WHERE invoice_id = OLD.id AND recorded_via = 'api') THEN
    RAISE EXCEPTION 'PAYMENT_RECORDED_ELSEWHERE: This invoice has payments recorded by an accounting connection. Remove them there first.';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_invoice_payments_on_delete ON public.project_invoices;
CREATE TRIGGER guard_invoice_payments_on_delete
  BEFORE DELETE ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_payments_on_delete();

-- -- Recording and removing -------------------------------------------------

-- One payment on one invoice. p_payment: amount, paid_date, method,
-- reference, external_id; the service role (the API) also passes
-- recorded_via, api_key_id and created_by. Returns {payment, replayed}.
-- Errors start with a code the API maps: INVOICE_NOT_FOUND,
-- INVOICE_NOT_PAYABLE, PAYMENT_INVALID, PAYMENT_EXCEEDS_OUTSTANDING,
-- PAYMENT_EXTERNAL_ID_CONFLICT, PAYMENT_FORBIDDEN.
CREATE OR REPLACE FUNCTION public.record_invoice_payment(p_invoice_id uuid, p_payment jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service boolean := COALESCE(auth.role(), '') = 'service_role';
  v_invoice public.project_invoices;
  v_existing public.invoice_payments;
  v_saved public.invoice_payments;
  v_amount numeric;
  v_date date;
  v_method text := NULLIF(btrim(p_payment->>'method'), '');
  v_reference text := NULLIF(btrim(p_payment->>'reference'), '');
  v_external text := NULLIF(btrim(p_payment->>'external_id'), '');
  v_via text;
  v_paid numeric;
  v_total numeric;
BEGIN
  IF NOT v_service AND NOT (public.has_permission('invoices.record_payments') OR public.has_permission('invoices.manage')) THEN
    RAISE EXCEPTION 'PAYMENT_FORBIDDEN: Missing permission to record invoice payments';
  END IF;

  SELECT * INTO v_invoice FROM public.project_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR (NOT v_service AND NOT public.can_access_project(v_invoice.project_id)) THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: Invoice not found';
  END IF;

  BEGIN
    v_amount := (p_payment->>'amount')::numeric;
    v_date := (p_payment->>'paid_date')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: Amount must be a number and paid_date a YYYY-MM-DD date';
  END;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> round(v_amount, 2) THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: Amount must be more than 0 with at most 2 decimals';
  END IF;
  IF v_date IS NULL THEN RAISE EXCEPTION 'PAYMENT_INVALID: paid_date is required'; END IF;
  IF v_method IS NOT NULL AND v_method NOT IN ('ach', 'wire', 'check', 'card', 'cash', 'other') THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: method must be ach, wire, check, card, cash or other';
  END IF;

  v_via := CASE WHEN v_service THEN COALESCE(NULLIF(p_payment->>'recorded_via', ''), 'api') ELSE 'app' END;

  IF v_external IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.invoice_payments
    WHERE invoice_id = p_invoice_id AND external_id = v_external;
    IF FOUND THEN
      IF v_existing.amount = v_amount AND v_existing.paid_date = v_date
         AND v_existing.method IS NOT DISTINCT FROM v_method
         AND v_existing.reference IS NOT DISTINCT FROM v_reference THEN
        RETURN jsonb_build_object('payment', to_jsonb(v_existing), 'replayed', true);
      END IF;
      RAISE EXCEPTION 'PAYMENT_EXTERNAL_ID_CONFLICT: A different payment was already recorded with this external_id';
    END IF;
  END IF;

  IF v_invoice.status NOT IN ('sent', 'overdue', 'paid') THEN
    RAISE EXCEPTION 'INVOICE_NOT_PAYABLE: Only a sent, overdue or paid invoice takes payments (this one is %)', v_invoice.status;
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_paid FROM public.invoice_payments WHERE invoice_id = p_invoice_id;
  v_total := public.invoice_total(v_invoice);
  IF v_amount > v_total - v_paid THEN
    RAISE EXCEPTION 'PAYMENT_EXCEEDS_OUTSTANDING: The payment is more than the % outstanding', GREATEST(v_total - v_paid, 0);
  END IF;

  INSERT INTO public.invoice_payments (
    invoice_id, amount, paid_date, method, reference, external_id, recorded_via, api_key_id, created_by
  ) VALUES (
    p_invoice_id, v_amount, v_date, v_method, v_reference, v_external, v_via,
    CASE WHEN v_service THEN NULLIF(p_payment->>'api_key_id', '')::uuid END,
    CASE WHEN v_service THEN NULLIF(p_payment->>'created_by', '')::uuid ELSE public.current_team_member_id() END
  )
  RETURNING * INTO v_saved;
  RETURN jsonb_build_object('payment', to_jsonb(v_saved), 'replayed', false);
END;
$$;

-- Remove one payment. People remove only payments recorded by hand; the API
-- passes p_recorded_via = 'api' so a key removes only what keys recorded.
-- Errors: PAYMENT_NOT_FOUND, PAYMENT_RECORDED_ELSEWHERE, PAYMENT_FORBIDDEN,
-- and PAYMENT_SHARES_PAID_OUT from the status trigger.
CREATE OR REPLACE FUNCTION public.remove_invoice_payment(p_payment_id uuid, p_recorded_via text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service boolean := COALESCE(auth.role(), '') = 'service_role';
  v_payment public.invoice_payments;
  v_project uuid;
  v_only text := CASE WHEN v_service THEN p_recorded_via ELSE 'app' END;
BEGIN
  IF NOT v_service AND NOT (public.has_permission('invoices.record_payments') OR public.has_permission('invoices.manage')) THEN
    RAISE EXCEPTION 'PAYMENT_FORBIDDEN: Missing permission to remove invoice payments';
  END IF;
  SELECT * INTO v_payment FROM public.invoice_payments WHERE id = p_payment_id;
  SELECT project_id INTO v_project FROM public.project_invoices WHERE id = v_payment.invoice_id FOR UPDATE;
  IF v_project IS NULL OR (NOT v_service AND NOT public.can_access_project(v_project)) THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: Payment not found';
  END IF;
  IF v_only IS NOT NULL AND v_payment.recorded_via <> v_only THEN
    RAISE EXCEPTION 'PAYMENT_RECORDED_ELSEWHERE: %', CASE WHEN v_payment.recorded_via = 'api'
      THEN 'This payment was recorded by an accounting connection. Remove it there.'
      ELSE 'This payment was recorded by hand in the app. Remove it there.' END;
  END IF;
  DELETE FROM public.invoice_payments WHERE id = p_payment_id;
  RETURN to_jsonb(v_payment);
END;
$$;

-- A project's payments with the name of the key that recorded each (keys are
-- not readable by most members).
CREATE OR REPLACE FUNCTION public.project_invoice_payments(p_project_id uuid)
RETURNS TABLE (
  id uuid,
  invoice_id uuid,
  amount numeric,
  paid_date date,
  method text,
  reference text,
  external_id text,
  recorded_via text,
  api_key_id uuid,
  api_key_name text,
  created_by uuid,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT ((public.has_permission('invoices.read') OR public.has_permission('invoices.manage'))
              AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'Not allowed to read payments on this project' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT payment.id, payment.invoice_id, payment.amount, payment.paid_date, payment.method,
         payment.reference, payment.external_id, payment.recorded_via, payment.api_key_id,
         key.name, payment.created_by, payment.created_at, payment.updated_at
  FROM public.invoice_payments payment
  JOIN public.project_invoices invoice ON invoice.id = payment.invoice_id
  LEFT JOIN public.api_keys key ON key.id = payment.api_key_id
  WHERE invoice.project_id = p_project_id
  ORDER BY payment.paid_date, payment.created_at;
END;
$$;

-- -- Backfill ---------------------------------------------------------------

-- One hand payment per paid invoice for its total, dated its paid date (else
-- its date).
-- Under the sync flag: no invoice row changes and no webhook is raised.
DO $backfill$
BEGIN
  PERFORM set_config('app.invoice_payment_sync', 'on', true);
  INSERT INTO public.invoice_payments (invoice_id, amount, paid_date, recorded_via)
  SELECT invoice.id, public.invoice_total(invoice),
         COALESCE(public.invoice_text_date(invoice.paid_date), public.invoice_text_date(invoice.date), invoice.created_at::date),
         'app'
  FROM public.project_invoices invoice
  WHERE invoice.status = 'paid' AND public.invoice_total(invoice) > 0
    AND NOT EXISTS (SELECT 1 FROM public.invoice_payments payment WHERE payment.invoice_id = invoice.id);
  PERFORM set_config('app.invoice_payment_sync', '', true);
END;
$backfill$;

-- -- Grants -----------------------------------------------------------------

REVOKE ALL ON FUNCTION public.invoice_text_date(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.invoice_total(public.project_invoices) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_share_earnings_paid_out(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_payment_event_data(public.invoice_payments, public.project_invoices) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.emit_invoice_webhook_event(public.project_invoices, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_invoice_payment_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_invoice_payments_from_invoice() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_payment_for_paid_invoice() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_invoice_payments_on_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_invoice_payment(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.project_invoice_payments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_text_date(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_total(public.project_invoices) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_invoice_payment(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.project_invoice_payments(uuid) TO authenticated, service_role;
