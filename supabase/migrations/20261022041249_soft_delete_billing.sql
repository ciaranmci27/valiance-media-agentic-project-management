-- Soft delete, part 2: billing records go to Trash too.
--
-- Time entries, invoices, payments, project hourly rates, retainers and
-- retainer amounts are never permanently deleted any more: deleting one
-- moves it to Trash and Restore brings it back exactly as it was.
--
-- Beyond the columns and the guard:
-- - Every billing function and cron job skips trashed rows, and rows whose
--   project is in Trash: hours pools, unbilled hours, forecast, earned work,
--   retainer and hours drafting, payouts, payments and due reminders.
-- - An invoice moved to Trash does what deleting it used to: its hours and
--   retainer period are free to bill again, its revenue split earnings are
--   retired, and a paid invoice sends invoice.deleted (admin's income ledger
--   drops it). Restoring links all of that again and a paid invoice sends
--   invoice.paid; it refuses if its hours or period went on another invoice
--   in the meantime. Payments recorded by an accounting connection still
--   pin an invoice.
-- - Removing a payment moves it to Trash (same payment events as before).
-- - Time on an invoice or in a payout still cannot be deleted: the foreign
--   keys used to refuse that, now a trigger does.
-- - Moving a project to Trash leaves its invoices alone, so money already
--   received stays in admin's income ledger.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Who deleted what, and when
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates',
    'project_retainers', 'project_retainer_amounts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_at timestamptz', t);
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL', t);
    -- Trash lists deleted rows newest first; live reads never use this index.
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (deleted_at DESC) WHERE deleted_at IS NOT NULL',
      'idx_' || t || '_deleted_at', t);
  END LOOP;
END $$;

-- A row in Trash must not block a new one, so these keys hold among live rows
-- only. Invoice numbers stay unique across Trash too: a number is never reused.
ALTER TABLE public.project_hourly_rates DROP CONSTRAINT IF EXISTS project_hourly_rates_project_id_effective_at_key;
CREATE UNIQUE INDEX IF NOT EXISTS project_hourly_rates_live_effective_key
  ON public.project_hourly_rates (project_id, effective_at) WHERE deleted_at IS NULL;
ALTER TABLE public.project_retainer_amounts DROP CONSTRAINT IF EXISTS project_retainer_amounts_retainer_id_effective_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS project_retainer_amounts_live_effective_key
  ON public.project_retainer_amounts (retainer_id, effective_date) WHERE deleted_at IS NULL;
ALTER TABLE public.invoice_payments DROP CONSTRAINT IF EXISTS invoice_payments_invoice_id_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_live_external_key
  ON public.invoice_payments (invoice_id, external_id) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS public.idx_project_time_entries_running;
CREATE UNIQUE INDEX idx_project_time_entries_running
  ON public.project_time_entries (project_id, member_id) WHERE end_time IS NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The guard: DELETE and TRUNCATE are refused, service role included
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates',
    'project_retainers', 'project_retainer_amounts'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_hard_delete ON public.%I', t);
    EXECUTE format('CREATE TRIGGER forbid_hard_delete BEFORE DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS forbid_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_hard_delete()', t);
  END LOOP;
END $$;

-- These ran only on DELETE, which can no longer happen; their work moved to
-- the Trash triggers below.
DROP TRIGGER IF EXISTS release_invoice_retainer_links ON public.project_invoices;
DROP FUNCTION IF EXISTS public.release_invoice_retainer_links();
DROP TRIGGER IF EXISTS guard_invoice_payments_on_delete ON public.project_invoices;
DROP FUNCTION IF EXISTS public.guard_invoice_payments_on_delete();

-- ---------------------------------------------------------------------------
-- 3. Signed-in members never see or change a deleted row
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates',
    'project_retainers', 'project_retainer_amounts'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_not_deleted', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
      USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL)', t || '_not_deleted', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Everything under a trashed invoice, time entry or retainer is out of reach
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoice_is_live(p_invoice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_invoices invoice
    JOIN public.projects project ON project.id = invoice.project_id
    WHERE invoice.id = p_invoice_id AND invoice.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.time_entry_is_live(p_entry_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_time_entries entry
    JOIN public.projects project ON project.id = entry.project_id
    WHERE entry.id = p_entry_id AND entry.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.retainer_is_live(p_retainer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_retainers retainer
    JOIN public.projects project ON project.id = retainer.project_id
    WHERE retainer.id = p_retainer_id AND retainer.deleted_at IS NULL AND project.deleted_at IS NULL
  )
$$;

DO $$
DECLARE
  rule record;
BEGIN
  FOR rule IN
    SELECT * FROM (VALUES
      ('invoice_payments', 'public.invoice_is_live(invoice_id)'),
      ('invoice_time_entry_allocations', 'public.invoice_is_live(invoice_id)'),
      ('invoice_line_shares', 'public.invoice_is_live(invoice_id)'),
      ('billing_draft_notices', 'public.project_is_live(project_id) AND public.invoice_is_live(invoice_id)'),
      ('project_retainer_amounts', 'public.retainer_is_live(retainer_id)'),
      ('project_retainer_shares', 'public.retainer_is_live(retainer_id)'),
      ('project_retainer_periods', 'public.retainer_is_live(retainer_id)'),
      ('time_entry_tasks', 'public.task_is_live(task_id) AND public.time_entry_is_live(time_entry_id)')
    ) AS rules(table_name, live_check)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', rule.table_name || '_parent_live', rule.table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (%s)',
      rule.table_name || '_parent_live', rule.table_name, rule.live_check);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. An invoice in Trash: what deleting it used to do, and undoing that
-- ---------------------------------------------------------------------------
create or replace function public.emit_invoice_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op text := TG_OP;
  v_was_paid boolean;
  v_is_paid boolean;
begin
  v_was_paid := (v_op <> 'INSERT' and OLD.status = 'paid');
  v_is_paid  := (v_op <> 'DELETE' and NEW.status = 'paid');

  if v_op = 'DELETE' then
    if v_was_paid then
      perform public.emit_invoice_webhook_event(OLD, 'invoice.deleted');
    end if;
    return OLD;
  end if;

  -- Moved to Trash: what a delete used to send. Restored: what creating it
  -- would send. Edits while it is in Trash send nothing.
  if v_op = 'UPDATE' and NEW.deleted_at is not null then
    if OLD.deleted_at is null and v_was_paid then
      perform public.emit_invoice_webhook_event(OLD, 'invoice.deleted');
    end if;
    return NEW;
  end if;
  if v_op = 'UPDATE' and OLD.deleted_at is not null then
    if v_is_paid then
      perform public.emit_invoice_webhook_event(NEW, 'invoice.paid');
    end if;
    return NEW;
  end if;

  if v_op = 'INSERT' then
    if v_is_paid then
      perform public.emit_invoice_webhook_event(NEW, 'invoice.paid');
    end if;
    return NEW;
  end if;

  if not (v_is_paid or v_was_paid) then
    return NEW;
  end if;

  if v_is_paid and not v_was_paid then
    perform public.emit_invoice_webhook_event(NEW, 'invoice.paid');
    return NEW;
  end if;

  if v_is_paid and v_was_paid
     and NEW.status is not distinct from OLD.status
     and NEW.paid_date is not distinct from OLD.paid_date
     and NEW.amount is not distinct from OLD.amount
     and NEW.line_items is not distinct from OLD.line_items
     and NEW.invoice_number is not distinct from OLD.invoice_number
     and NEW.invoice_type is not distinct from OLD.invoice_type
     and NEW.project_id is not distinct from OLD.project_id then
    return NEW;
  end if;

  perform public.emit_invoice_webhook_event(NEW, 'invoice.updated');
  return NEW;
end;
$$;

create or replace function public.emit_invoice_webhook_for_shares()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.project_invoices;
begin
  for v_invoice in
    select invoice.*
    from public.project_invoices invoice
    where invoice.status = 'paid'
      and invoice.deleted_at is null
      and invoice.id in (select distinct invoice_id from changed_rows)
  loop
    perform public.emit_invoice_webhook_event(v_invoice, 'invoice.updated');
  end loop;
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION public.sync_invoice_share_earnings(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.project_invoices;
  earning record;
  earned_on date;
  desired jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO invoice FROM public.project_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  earned_on := COALESCE(
    CASE WHEN invoice.paid_date ~ '^\d{4}-\d{2}-\d{2}' THEN substring(invoice.paid_date FROM 1 FOR 10)::date END,
    public.workspace_today()
  );

  -- A trashed invoice earns nothing; restoring it earns again.
  IF invoice.status = 'paid' AND invoice.deleted_at IS NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'line_item_id', line.value->>'id',
      'member_id', share.member_id,
      'percent', share.percent,
      'basis_amount', ROUND((line.value->>'amount')::numeric, 2),
      'amount', ROUND((line.value->>'amount')::numeric * share.percent / 100, 2),
      'description', COALESCE(line.value->>'description', ''),
      'retainer_id', (SELECT retainer.id FROM public.project_retainers retainer
                      WHERE retainer.id::text = line.value->>'retainer_id')
    )), '[]'::jsonb)
    INTO desired
    FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
    JOIN public.invoice_line_shares share
      ON share.invoice_id = invoice.id AND share.line_item_id = line.value->>'id'
    WHERE line.value->>'item_type' IN ('fixed', 'recurring')
      AND ROUND((line.value->>'amount')::numeric * share.percent / 100, 2) > 0;
  END IF;

  FOR earning IN
    SELECT existing.*
    FROM public.team_member_share_earnings existing
    WHERE existing.invoice_id = invoice.id
      AND existing.voided_at IS NULL AND existing.reversed_at IS NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(desired) AS desired(line_item_id text, member_id uuid, percent numeric, basis_amount numeric, amount numeric, description text, retainer_id uuid)
      WHERE desired.line_item_id = earning.line_item_id
        AND desired.member_id = earning.member_id
        AND desired.amount = earning.amount
        AND desired.percent = earning.percent
    ) THEN
      UPDATE public.team_member_share_earnings
      SET earned_date = earned_on, invoice_number = invoice.invoice_number
      WHERE id = earning.id
        AND (earned_date IS DISTINCT FROM earned_on OR invoice_number IS DISTINCT FROM invoice.invoice_number);
    ELSE
      PERFORM public.retire_share_earning(
        earning.id,
        CASE WHEN invoice.deleted_at IS NOT NULL THEN 'invoice deleted'
             WHEN invoice.status = 'paid' THEN 'invoice changed' ELSE 'invoice no longer paid' END
      );
    END IF;
  END LOOP;

  INSERT INTO public.team_member_share_earnings (
    member_id, project_id, retainer_id, invoice_id, line_item_id, invoice_number,
    description, percent, basis_amount, amount, earned_date
  )
  SELECT desired.member_id, invoice.project_id, desired.retainer_id, invoice.id, desired.line_item_id,
         invoice.invoice_number, desired.description, desired.percent, desired.basis_amount,
         desired.amount, earned_on
  FROM jsonb_to_recordset(desired) AS desired(line_item_id text, member_id uuid, percent numeric, basis_amount numeric, amount numeric, description text, retainer_id uuid)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.team_member_share_earnings existing
    WHERE existing.invoice_id = invoice.id
      AND existing.line_item_id = desired.line_item_id
      AND existing.member_id = desired.member_id
      AND existing.voided_at IS NULL AND existing.reversed_at IS NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_invoice_retainer_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lines jsonb := COALESCE(NULLIF(NEW.line_items, 'null'::jsonb), '[]'::jsonb);
  line jsonb;
  retainer public.project_retainers;
  handled public.project_retainer_periods;
  service_start date;
  service_end date;
  period_key date;
  newly_linked boolean;
BEGIN
  -- Moved to Trash: what deleting it used to do. Its retainer periods are
  -- let go (skipped) and its split earnings retired. Restoring runs the
  -- rest of this function, which links them again, after checking its
  -- hours did not go on another invoice in the meantime.
  IF NEW.deleted_at IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL THEN
      UPDATE public.project_retainer_periods
      SET status = 'skipped', invoice_id = NULL, line_item_id = NULL
      WHERE invoice_id = NEW.id;
      PERFORM public.sync_invoice_share_earnings(NEW.id);
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL THEN
    PERFORM public.validate_invoice_time_allocations(NEW.id);
  END IF;

  -- Let go of periods whose line is gone, or whose invoice was cancelled.
  UPDATE public.project_retainer_periods period
  SET status = 'skipped', invoice_id = NULL, line_item_id = NULL
  WHERE period.invoice_id = NEW.id
    AND (
      NEW.status = 'cancelled'
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(lines) current_line
        WHERE current_line.value->>'id' = period.line_item_id
          AND current_line.value->>'retainer_id' = period.retainer_id::text
      )
    );

  DELETE FROM public.invoice_line_shares share
  WHERE share.invoice_id = NEW.id
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(lines) current_line
      WHERE current_line.value->>'id' = share.line_item_id
        AND current_line.value->>'item_type' IN ('fixed', 'recurring')
    );

  IF NEW.status <> 'cancelled' THEN
    FOR line IN SELECT value FROM jsonb_array_elements(lines)
    LOOP
      CONTINUE WHEN NULLIF(line->>'retainer_id', '') IS NULL;

      SELECT * INTO retainer FROM public.project_retainers
      WHERE id::text = line->>'retainer_id' AND deleted_at IS NULL;
      -- A retainer in Trash leaves a dangling id on old lines; that is fine.
      CONTINUE WHEN NOT FOUND;
      IF retainer.project_id <> NEW.project_id THEN
        RAISE EXCEPTION 'An invoice line points to a retainer on another project';
      END IF;
      IF COALESCE(line->>'service_start_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'A retainer line needs a service start date';
      END IF;

      service_start := (line->>'service_start_date')::date;
      service_end := CASE
        WHEN COALESCE(line->>'service_end_date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN (line->>'service_end_date')::date
        ELSE (date_trunc('month', service_start::timestamp) + interval '1 month' - interval '1 day')::date
      END;
      -- Any line in a month stands for that month's period.
      period_key := GREATEST(date_trunc('month', service_start::timestamp)::date, retainer.start_date);

      SELECT * INTO handled
      FROM public.project_retainer_periods
      WHERE retainer_id = retainer.id AND period_start = period_key
      FOR UPDATE;

      IF FOUND AND handled.status = 'invoiced' AND handled.invoice_id IS NOT NULL AND handled.invoice_id <> NEW.id THEN
        RAISE EXCEPTION 'That retainer period is already on another invoice';
      END IF;

      newly_linked := NOT FOUND
        OR handled.invoice_id IS DISTINCT FROM NEW.id
        OR handled.line_item_id IS DISTINCT FROM (line->>'id');

      INSERT INTO public.project_retainer_periods (
        retainer_id, period_start, period_end, status, invoice_id, line_item_id
      ) VALUES (
        retainer.id, period_key, GREATEST(service_end, period_key), 'invoiced', NEW.id, line->>'id'
      )
      ON CONFLICT (retainer_id, period_start) DO UPDATE
      SET status = 'invoiced', invoice_id = EXCLUDED.invoice_id,
          line_item_id = EXCLUDED.line_item_id, period_end = EXCLUDED.period_end;

      -- A line inherits the retainer's split once, when it is first linked.
      -- After that the line's own rows are the truth, so removing them sticks.
      IF newly_linked AND NOT EXISTS (
        SELECT 1 FROM public.invoice_line_shares
        WHERE invoice_id = NEW.id AND line_item_id = line->>'id'
      ) THEN
        INSERT INTO public.invoice_line_shares (invoice_id, line_item_id, member_id, percent)
        SELECT NEW.id, line->>'id', share.member_id, share.percent
        FROM public.project_retainer_shares share
        WHERE share.retainer_id = retainer.id
          AND share.effective_from <= period_key
          AND (share.effective_to IS NULL OR share.effective_to >= period_key)
        ON CONFLICT (invoice_id, line_item_id, member_id) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  PERFORM public.sync_invoice_share_earnings(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS reconcile_invoice_retainer_lines ON public.project_invoices;
CREATE TRIGGER reconcile_invoice_retainer_lines
  AFTER INSERT OR UPDATE OF line_items, status, paid_date, invoice_number, project_id, deleted_at
  ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.reconcile_invoice_retainer_lines();

-- Why a record cannot go to Trash, as a sentence for the person deleting
-- it; null when nothing stops it. The rules the foreign keys and DELETE
-- triggers used to enforce.
CREATE OR REPLACE FUNCTION public.trash_delete_blocker(p_table text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_number text;
BEGIN
  CASE p_table
    WHEN 'project_time_entries' THEN
      SELECT invoice.invoice_number INTO v_number
      FROM public.invoice_time_entry_allocations allocation
      JOIN public.project_invoices invoice ON invoice.id = allocation.invoice_id
      WHERE allocation.time_entry_id = p_id AND invoice.deleted_at IS NULL
      ORDER BY invoice.created_at
      LIMIT 1;
      IF FOUND THEN
        RETURN 'This time is on invoice ' || v_number || '. Take it off the invoice first.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.team_member_payout_allocations allocation
        JOIN public.team_member_payouts payout ON payout.id = allocation.payout_id
        WHERE allocation.time_entry_id = p_id AND payout.voided_at IS NULL
      ) THEN
        RETURN 'This time is in a team member payout. Void the payout first.';
      END IF;
    WHEN 'project_invoices' THEN
      IF EXISTS (
        SELECT 1 FROM public.invoice_payments
        WHERE invoice_id = p_id AND recorded_via = 'api' AND deleted_at IS NULL
      ) THEN
        RETURN 'PAYMENT_RECORDED_ELSEWHERE: This invoice has payments recorded by an accounting connection. Remove them there first.';
      END IF;
    ELSE
      NULL;
  END CASE;
  RETURN NULL;
END;
$$;

-- Every way into Trash (the RPC, a server route, a trigger) meets the same
-- rules, so time on an invoice or an invoice pinned by an accounting
-- connection cannot slip in through a direct update.
CREATE OR REPLACE FUNCTION public.guard_trash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  blocker text;
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    blocker := public.trash_delete_blocker(TG_TABLE_NAME, OLD.id);
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION '%', blocker USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_trash ON public.project_time_entries;
CREATE TRIGGER guard_trash BEFORE UPDATE OF deleted_at ON public.project_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_trash();
DROP TRIGGER IF EXISTS guard_trash ON public.project_invoices;
CREATE TRIGGER guard_trash BEFORE UPDATE OF deleted_at ON public.project_invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_trash();

-- ---------------------------------------------------------------------------
-- 6. Payments: removing one moves it to Trash
-- ---------------------------------------------------------------------------
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
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- A payment edited while it is in Trash changes nothing.
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(amount), 0), max(paid_date) INTO v_paid, v_last
  FROM public.invoice_payments WHERE invoice_id = v_invoice.id AND deleted_at IS NULL;

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
  -- Moving a payment to Trash removes it; restoring it records it again.
  IF (TG_OP = 'INSERT' AND NEW.deleted_at IS NULL)
     OR (TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) THEN
    PERFORM public.emit_invoice_webhook_event(v_row, 'invoice.payment_recorded', public.invoice_payment_event_data(NEW, v_row));
  ELSIF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    PERFORM public.emit_invoice_webhook_event(v_row, 'invoice.payment_removed', public.invoice_payment_event_data(NEW, v_row));
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
  FROM public.invoice_payments WHERE invoice_id = OLD.id AND deleted_at IS NULL;

  IF NEW.status = 'paid' THEN
    v_on := COALESCE(public.invoice_text_date(NEW.paid_date), public.workspace_today());
    -- Still paid, and the only payment is the bare one that stands for
    -- "paid" (as marking it paid, or the backfill, made it): it follows the
    -- invoice. A payment with a method, reference or external_id was recorded
    -- on purpose and is never rewritten.
    IF OLD.status = 'paid' AND v_api = 0 AND v_app = 1 THEN
      SELECT * INTO v_payment FROM public.invoice_payments WHERE invoice_id = OLD.id AND deleted_at IS NULL;
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
        WHERE invoice_id = NEW.id AND deleted_at IS NULL AND (amount <> v_total OR paid_date <> v_on);
      ELSE
        -- Let go payments move to Trash, as removing one by hand does.
        FOR v_payment IN UPDATE public.invoice_payments
          SET deleted_at = now(), deleted_by = public.current_team_member_id()
          WHERE invoice_id = NEW.id AND deleted_at IS NULL RETURNING * LOOP
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
    FOR v_payment IN UPDATE public.invoice_payments
      SET deleted_at = now(), deleted_by = public.current_team_member_id()
      WHERE invoice_id = NEW.id AND deleted_at IS NULL RETURNING * LOOP
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
    FROM public.invoice_payments WHERE invoice_id = p_invoice.id AND deleted_at IS NULL
  ) paid
$$;

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
  IF NOT FOUND OR v_invoice.deleted_at IS NOT NULL OR NOT public.project_is_live(v_invoice.project_id)
     OR (NOT v_service AND NOT public.can_access_project(v_invoice.project_id)) THEN
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
    WHERE invoice_id = p_invoice_id AND external_id = v_external AND deleted_at IS NULL;
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
  SELECT COALESCE(sum(amount), 0) INTO v_paid FROM public.invoice_payments
  WHERE invoice_id = p_invoice_id AND deleted_at IS NULL;
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
  SELECT * INTO v_payment FROM public.invoice_payments WHERE id = p_payment_id AND deleted_at IS NULL;
  SELECT project_id INTO v_project FROM public.project_invoices
  WHERE id = v_payment.invoice_id AND deleted_at IS NULL AND public.project_is_live(project_id)
  FOR UPDATE;
  IF v_project IS NULL OR (NOT v_service AND NOT public.can_access_project(v_project)) THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: Payment not found';
  END IF;
  IF v_only IS NOT NULL AND v_payment.recorded_via <> v_only THEN
    RAISE EXCEPTION 'PAYMENT_RECORDED_ELSEWHERE: %', CASE WHEN v_payment.recorded_via = 'api'
      THEN 'This payment was recorded by an accounting connection. Remove it there.'
      ELSE 'This payment was recorded by hand in the app. Remove it there.' END;
  END IF;
  -- Removed means moved to Trash; the status trigger sends payment_removed.
  UPDATE public.invoice_payments
  SET deleted_at = now(), deleted_by = public.current_team_member_id()
  WHERE id = p_payment_id
  RETURNING * INTO v_payment;
  RETURN to_jsonb(v_payment);
END;
$$;

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
    AND invoice.deleted_at IS NULL
    AND payment.deleted_at IS NULL
  ORDER BY payment.paid_date, payment.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoice_payment_totals(p_invoice_ids jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_object_agg(invoice.id, jsonb_build_object(
    'total', public.invoice_total(invoice),
    'paid_total', COALESCE((SELECT sum(payment.amount) FROM public.invoice_payments payment WHERE payment.invoice_id = invoice.id AND payment.deleted_at IS NULL), 0)
  )), '{}'::jsonb)
  FROM public.project_invoices invoice
  WHERE invoice.id::text IN (SELECT jsonb_array_elements_text(p_invoice_ids))
$$;


-- ---------------------------------------------------------------------------
-- 7. Hours and time skip what is in Trash
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoice_paid_hourly_pool(p_project_id uuid, p_exclude_invoice_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(sum(CASE
    WHEN jsonb_array_length(COALESCE(invoice.line_items, '[]'::jsonb)) = 0 THEN
      CASE WHEN invoice.invoice_type = 'hourly' THEN invoice.amount ELSE 0 END
    ELSE (
      SELECT COALESCE(sum(COALESCE(NULLIF(line->>'amount', '')::numeric, 0)), 0)
      FROM jsonb_array_elements(invoice.line_items) line
      WHERE line->>'item_type' = 'hourly'
    )
  END), 0)
  FROM public.project_invoices invoice
  WHERE invoice.project_id = p_project_id
    AND invoice.status = 'paid'
    AND invoice.deleted_at IS NULL
    AND invoice.id IS DISTINCT FROM p_exclude_invoice_id
$$;

CREATE OR REPLACE FUNCTION public.invoice_billed_hourly_pool(p_project_id uuid, p_exclude_invoice_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.invoice_paid_hourly_pool(p_project_id, p_exclude_invoice_id) + COALESCE((
    SELECT sum(CASE
      WHEN jsonb_array_length(COALESCE(invoice.line_items, '[]'::jsonb)) = 0 THEN
        CASE WHEN invoice.invoice_type = 'hourly'
              AND NOT EXISTS (SELECT 1 FROM public.invoice_time_entry_allocations a WHERE a.invoice_id = invoice.id)
             THEN invoice.amount ELSE 0 END
      ELSE (
        SELECT COALESCE(sum(COALESCE(NULLIF(line->>'amount', '')::numeric, 0)), 0)
        FROM jsonb_array_elements(invoice.line_items) line
        WHERE line->>'item_type' = 'hourly'
          AND NOT EXISTS (
            SELECT 1 FROM public.invoice_time_entry_allocations a
            WHERE a.invoice_id = invoice.id AND a.line_item_id = line->>'id'
          )
      )
    END)
    FROM public.project_invoices invoice
    WHERE invoice.project_id = p_project_id
      AND invoice.status IN ('draft', 'sent', 'overdue')
      AND invoice.deleted_at IS NULL
      AND invoice.id IS DISTINCT FROM p_exclude_invoice_id
  ), 0)
$$;

CREATE OR REPLACE FUNCTION public.invoice_unbilled_slices(p_project_id uuid, p_exclude_invoice_id uuid DEFAULT NULL)
RETURNS TABLE (
  time_entry_id uuid,
  start_time timestamptz,
  end_time timestamptz,
  rate numeric,
  start_offset_hours numeric,
  hours numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  money_eps CONSTANT numeric := 0.005000001;
  hours_eps CONSTANT numeric := 0.000050001;
  pool numeric := public.invoice_billed_hourly_pool(p_project_id, p_exclude_invoice_id);
  entry record;
  worked numeric;
  cost numeric;
  portion_start numeric;
  free nummultirange;
  piece numrange;
BEGIN
  FOR entry IN
    SELECT e.id, e.start_time, e.end_time, e.hourly_rate, e.segments
    FROM public.project_time_entries e
    WHERE e.project_id = p_project_id
      AND e.end_time IS NOT NULL
      AND e.work_type <> 'internal'
      AND e.approval_status = 'approved'
      AND e.deleted_at IS NULL
    ORDER BY e.start_time, e.id
  LOOP
    IF entry.hourly_rate IS NULL OR entry.hourly_rate <= 0 THEN CONTINUE; END IF;
    worked := public.time_entry_worked_hours(entry.segments, entry.start_time, entry.end_time);
    cost := worked * entry.hourly_rate;
    IF cost <= money_eps THEN CONTINUE; END IF;

    IF pool + money_eps >= cost THEN
      pool := CASE WHEN pool - cost > money_eps THEN pool - cost ELSE 0 END;
      CONTINUE;
    END IF;
    IF pool > money_eps THEN
      IF cost - pool <= money_eps THEN pool := 0; CONTINUE; END IF;
      portion_start := pool / entry.hourly_rate;
      pool := 0;
    ELSE
      portion_start := 0;
    END IF;

    free := nummultirange(numrange(portion_start, worked, '[)')) - COALESCE((
      SELECT range_agg(numrange(a.start_offset_hours, a.start_offset_hours + a.allocated_hours, '[)'))
      FROM public.invoice_time_entry_allocations a
      JOIN public.project_invoices i ON i.id = a.invoice_id
      WHERE a.time_entry_id = entry.id
        AND i.status IN ('draft', 'sent', 'overdue')
        AND i.deleted_at IS NULL
        AND i.id IS DISTINCT FROM p_exclude_invoice_id
    ), '{}'::nummultirange);

    -- An invoice line holds one allocation per session, so a session split
    -- by a held piece in its middle offers its first free piece now and the
    -- rest to the next invoice (the browser walk does the same).
    FOR piece IN SELECT p FROM unnest(free) p ORDER BY lower(p) LOOP
      IF upper(piece) - lower(piece) > hours_eps THEN
        time_entry_id := entry.id;
        start_time := entry.start_time;
        end_time := entry.end_time;
        rate := entry.hourly_rate;
        start_offset_hours := lower(piece);
        hours := upper(piece) - lower(piece);
        RETURN NEXT;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_invoice_time_allocations(target_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  clash record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_invoices invoice ON invoice.id = allocation.invoice_id
    LEFT JOIN LATERAL jsonb_array_elements(invoice.line_items) line_item
      ON line_item->>'id' = allocation.line_item_id
    WHERE allocation.invoice_id = target_invoice_id
      AND (line_item IS NULL OR line_item->>'item_type' IS DISTINCT FROM 'hourly')
  ) THEN
    RAISE EXCEPTION 'Invoice allocation points to a missing or non-hourly line item';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_invoices invoice ON invoice.id = allocation.invoice_id
    LEFT JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND (
        entry.id IS NULL
        OR entry.project_id IS DISTINCT FROM invoice.project_id
        OR entry.end_time IS NULL
        OR entry.hourly_rate <= 0
        OR entry.deleted_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Invoice allocation points to an invalid time session';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND (entry.approval_status IS DISTINCT FROM 'approved' OR entry.work_type = 'internal')
  ) THEN
    RAISE EXCEPTION 'Only approved client time can be invoiced';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND allocation.start_offset_hours + allocation.allocated_hours
        > public.time_entry_worked_hours(entry.segments, entry.start_time, entry.end_time) + 0.0000011
  ) THEN
    RAISE EXCEPTION 'Invoice allocation extends beyond its tracked session';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations allocation
    JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    WHERE allocation.invoice_id = target_invoice_id
      AND abs(round(allocation.allocated_hours * entry.hourly_rate, 2) - allocation.allocated_amount) > 0.01
  ) THEN
    RAISE EXCEPTION 'Invoice allocation amount disagrees with its session rate';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_time_entry_allocations left_allocation
    JOIN public.invoice_time_entry_allocations right_allocation
      ON right_allocation.invoice_id = left_allocation.invoice_id
      AND right_allocation.time_entry_id = left_allocation.time_entry_id
      AND right_allocation.id > left_allocation.id
    WHERE left_allocation.invoice_id = target_invoice_id
      AND numrange(left_allocation.start_offset_hours, left_allocation.start_offset_hours + left_allocation.allocated_hours, '[)')
       && numrange(right_allocation.start_offset_hours, right_allocation.start_offset_hours + right_allocation.allocated_hours, '[)')
  ) THEN
    RAISE EXCEPTION 'A time session is billed more than once on the same invoice';
  END IF;

  -- A cancelled or trashed invoice holds nothing; a live one must not share a slice
  -- with another live invoice (a margin under a millionth of an hour is
  -- rounding, not a clash).
  SELECT other.invoice_number INTO clash
  FROM public.invoice_time_entry_allocations mine
  JOIN public.project_invoices me ON me.id = mine.invoice_id
  JOIN public.invoice_time_entry_allocations theirs
    ON theirs.time_entry_id = mine.time_entry_id AND theirs.invoice_id <> mine.invoice_id
  JOIN public.project_invoices other ON other.id = theirs.invoice_id
  WHERE mine.invoice_id = target_invoice_id
    AND me.status <> 'cancelled'
    AND other.status <> 'cancelled'
    AND other.deleted_at IS NULL
    AND mine.start_offset_hours < theirs.start_offset_hours + theirs.allocated_hours - 0.000001
    AND theirs.start_offset_hours < mine.start_offset_hours + mine.allocated_hours - 0.000001
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Some of these hours are already on invoice %', clash.invoice_number USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.project_invoices invoice
    CROSS JOIN LATERAL jsonb_array_elements(invoice.line_items) line_item
    JOIN (
      SELECT line_item_id, sum(allocated_amount) AS allocated_amount
      FROM public.invoice_time_entry_allocations
      WHERE invoice_id = target_invoice_id
      GROUP BY line_item_id
    ) totals ON totals.line_item_id = line_item->>'id'
    WHERE invoice.id = target_invoice_id
      AND totals.allocated_amount IS DISTINCT FROM round((line_item->>'amount')::numeric, 2)
  ) THEN
    RAISE EXCEPTION 'Hourly allocation totals do not match the invoice line amount';
  END IF;
END;
$$;

create or replace function public.save_project_invoice_with_allocations(
  p_invoice_id uuid,
  p_invoice jsonb,
  p_allocations jsonb
)
returns public.project_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_invoice public.project_invoices;
  saved public.project_invoices;
  target_project_id uuid;
begin
  p_invoice := coalesce(p_invoice, '{}'::jsonb);

  if coalesce(auth.role(), '') <> 'service_role' then
    if not public.has_permission('invoices.manage', 'app') then
      raise exception 'Missing permission to manage invoices';
    end if;
  end if;

  if p_invoice_id is null then
    target_project_id := (p_invoice->>'project_id')::uuid;
    if target_project_id is null then
      raise exception 'Invoice project is required';
    end if;
    if not public.project_is_live(target_project_id) then
      raise exception 'Project not found';
    end if;
    if coalesce(auth.role(), '') <> 'service_role'
      and not public.can_access_project(target_project_id) then
      raise exception 'Project access denied';
    end if;

    insert into public.project_invoices (
      project_id, invoice_number, amount, status, invoice_type, line_items,
      date, due_date, paid_date, description, file_url, file_name, file_size,
      mime_type, created_by
    ) values (
      target_project_id,
      p_invoice->>'invoice_number',
      coalesce((p_invoice->>'amount')::numeric, 0),
      coalesce(p_invoice->>'status', 'draft'),
      coalesce(p_invoice->>'invoice_type', 'hourly'),
      coalesce(nullif(p_invoice->'line_items', 'null'::jsonb), '[]'::jsonb),
      p_invoice->>'date',
      p_invoice->>'due_date',
      p_invoice->>'paid_date',
      coalesce(p_invoice->>'description', ''),
      p_invoice->>'file_url',
      p_invoice->>'file_name',
      (p_invoice->>'file_size')::bigint,
      p_invoice->>'mime_type',
      (p_invoice->>'created_by')::uuid
    )
    returning * into saved;
  else
    select * into existing_invoice
    from public.project_invoices
    where id = p_invoice_id
      and deleted_at is null;

    if not found then
      raise exception 'Invoice not found';
    end if;

    target_project_id := case
      when p_invoice ? 'project_id' then (p_invoice->>'project_id')::uuid
      else existing_invoice.project_id
    end;
    if target_project_id is null then
      raise exception 'Invoice project is required';
    end if;
    if not public.project_is_live(target_project_id) then
      raise exception 'Project not found';
    end if;
    if coalesce(auth.role(), '') <> 'service_role'
      and (
        not public.can_access_project(existing_invoice.project_id)
        or not public.can_access_project(target_project_id)
      ) then
      raise exception 'Project access denied';
    end if;

    update public.project_invoices invoice
    set
      project_id = case when p_invoice ? 'project_id' then target_project_id else invoice.project_id end,
      invoice_number = case when p_invoice ? 'invoice_number' then p_invoice->>'invoice_number' else invoice.invoice_number end,
      amount = case when p_invoice ? 'amount' then (p_invoice->>'amount')::numeric else invoice.amount end,
      status = case when p_invoice ? 'status' then p_invoice->>'status' else invoice.status end,
      invoice_type = case when p_invoice ? 'invoice_type' then p_invoice->>'invoice_type' else invoice.invoice_type end,
      line_items = case when p_invoice ? 'line_items' then coalesce(nullif(p_invoice->'line_items', 'null'::jsonb), '[]'::jsonb) else invoice.line_items end,
      date = case when p_invoice ? 'date' then p_invoice->>'date' else invoice.date end,
      due_date = case when p_invoice ? 'due_date' then p_invoice->>'due_date' else invoice.due_date end,
      paid_date = case when p_invoice ? 'paid_date' then p_invoice->>'paid_date' else invoice.paid_date end,
      description = case when p_invoice ? 'description' then coalesce(p_invoice->>'description', '') else invoice.description end,
      file_url = case when p_invoice ? 'file_url' then p_invoice->>'file_url' else invoice.file_url end,
      file_name = case when p_invoice ? 'file_name' then p_invoice->>'file_name' else invoice.file_name end,
      file_size = case when p_invoice ? 'file_size' then (p_invoice->>'file_size')::bigint else invoice.file_size end,
      mime_type = case when p_invoice ? 'mime_type' then p_invoice->>'mime_type' else invoice.mime_type end,
      created_by = case when p_invoice ? 'created_by' then (p_invoice->>'created_by')::uuid else invoice.created_by end
    where invoice.id = p_invoice_id
    returning * into saved;

    if not found then
      raise exception 'Invoice not found';
    end if;
  end if;

  if p_allocations is not null then
    delete from public.invoice_time_entry_allocations
    where invoice_id = saved.id;

    insert into public.invoice_time_entry_allocations (
      invoice_id, line_item_id, time_entry_id, start_offset_hours,
      allocated_hours, allocated_amount
    )
    select
      saved.id,
      allocation.line_item_id,
      allocation.time_entry_id,
      allocation.start_offset_hours,
      allocation.allocated_hours,
      allocation.allocated_amount
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb)) as allocation(
      line_item_id text,
      time_entry_id uuid,
      start_offset_hours numeric,
      allocated_hours numeric,
      allocated_amount numeric
    );
  end if;

  perform public.validate_invoice_time_allocations(saved.id);
  return saved;
end;
$$;

CREATE OR REPLACE FUNCTION public.set_invoice_line_shares(p_invoice_id uuid, p_shares jsonb)
RETURNS SETOF public.invoice_line_shares
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.project_invoices;
  share record;
BEGIN
  SELECT * INTO invoice FROM public.project_invoices WHERE id = p_invoice_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('compensation.manage', 'app') AND public.can_access_project(invoice.project_id)) THEN
    RAISE EXCEPTION 'Missing permission to manage compensation';
  END IF;
  IF jsonb_typeof(p_shares) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Splits must be a list';
  END IF;

  FOR share IN
    SELECT incoming.line_item_id, incoming.member_id, incoming.percent
    FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
  LOOP
    PERFORM public.assert_share_member(share.member_id);
    IF share.percent IS NULL OR share.percent <= 0 OR share.percent > 100 THEN
      RAISE EXCEPTION 'A split percent must be between 0 and 100';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(NULLIF(invoice.line_items, 'null'::jsonb), '[]'::jsonb)) line
      WHERE line.value->>'id' = share.line_item_id
        AND line.value->>'item_type' IN ('fixed', 'recurring')
    ) THEN
      RAISE EXCEPTION 'Only fixed and recurring lines can be split';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
    GROUP BY incoming.line_item_id
    HAVING SUM(incoming.percent) > 100 OR COUNT(*) <> COUNT(DISTINCT incoming.member_id)
  ) THEN
    RAISE EXCEPTION 'Splits on a line cannot total more than 100 percent or repeat a member';
  END IF;

  DELETE FROM public.invoice_line_shares existing
  WHERE existing.invoice_id = p_invoice_id
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
      WHERE incoming.line_item_id = existing.line_item_id AND incoming.member_id = existing.member_id
    );

  INSERT INTO public.invoice_line_shares (invoice_id, line_item_id, member_id, percent)
  SELECT p_invoice_id, incoming.line_item_id, incoming.member_id, incoming.percent
  FROM jsonb_to_recordset(p_shares) AS incoming(line_item_id text, member_id uuid, percent numeric)
  ON CONFLICT (invoice_id, line_item_id, member_id) DO UPDATE
  SET percent = EXCLUDED.percent
  WHERE public.invoice_line_shares.percent IS DISTINCT FROM EXCLUDED.percent;

  RETURN QUERY
  SELECT * FROM public.invoice_line_shares WHERE invoice_id = p_invoice_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_accessible_time_entries(p_project_id uuid DEFAULT NULL)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Mask sensitive rate columns independently, mirroring the app-layer rule in
  -- sanitizeTimeEntryForAccess: the client billing rate (hourly_rate) requires
  -- billing.manage; the employee pay rate (compensation_rate) requires
  -- compensation.manage/payouts.manage, or the caller's own entry with
  -- earnings.own.read. Removing the empty key '' is a no-op when access is allowed.
  SELECT (
    (to_jsonb(entry)
      - (CASE WHEN public.has_permission('billing.manage', 'app') THEN '' ELSE 'hourly_rate' END))
      - (CASE
           WHEN public.has_permission('compensation.manage', 'app')
             OR public.has_permission('payouts.manage', 'app')
             OR (entry.member_id = public.current_team_member_id() AND public.has_permission('earnings.own.read', 'app'))
           THEN '' ELSE 'compensation_rate'
         END)
  )
  FROM public.project_time_entries entry
  WHERE (p_project_id IS NULL OR entry.project_id = p_project_id)
    AND entry.deleted_at IS NULL
    AND public.can_access_project(entry.project_id)
    AND (
      public.has_permission('time.read_all', 'app')
      OR entry.member_id = public.current_team_member_id()
    )
  ORDER BY entry.start_time DESC
$$;

CREATE OR REPLACE FUNCTION public.validate_team_member_payout(p_payout_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payout_row public.team_member_payouts;
  allocation_total numeric;
  allocation_row record;
  source_amount numeric;
  source_allocated numeric;
BEGIN
  SELECT * INTO payout_row FROM public.team_member_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout not found'; END IF;

  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO allocation_total
  FROM public.team_member_payout_allocations
  WHERE payout_id = p_payout_id;

  IF ROUND(allocation_total, 2) IS DISTINCT FROM ROUND(payout_row.amount, 2) THEN
    RAISE EXCEPTION 'Payout allocations do not match payout amount';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.team_member_payout_allocations allocation
    LEFT JOIN public.project_time_entries entry ON entry.id = allocation.time_entry_id
    LEFT JOIN public.team_member_earning_adjustments adjustment ON adjustment.id = allocation.adjustment_id
    LEFT JOIN public.team_member_share_earnings share_earning ON share_earning.id = allocation.share_earning_id
    WHERE allocation.payout_id = p_payout_id
      AND COALESCE(entry.member_id, adjustment.member_id, share_earning.member_id) IS DISTINCT FROM payout_row.member_id
  ) THEN
    RAISE EXCEPTION 'Payout allocation belongs to another member';
  END IF;

  FOR allocation_row IN
    SELECT * FROM public.team_member_payout_allocations WHERE payout_id = p_payout_id
  LOOP
    IF allocation_row.time_entry_id IS NOT NULL THEN
      SELECT
        CASE
          WHEN entry.approval_status = 'approved' AND entry.end_time IS NOT NULL AND entry.deleted_at IS NULL THEN
            ROUND(
              COALESCE((
                SELECT SUM(
                  EXTRACT(EPOCH FROM (
                    (segment.value->>'end')::timestamptz
                    - (segment.value->>'start')::timestamptz
                  )) / 3600
                )
                FROM jsonb_array_elements(COALESCE(entry.segments, '[]'::jsonb)) segment
                WHERE NULLIF(segment.value->>'end', '') IS NOT NULL
              ), 0) * entry.compensation_rate,
              2
            )
          ELSE NULL
        END
      INTO source_amount
      FROM public.project_time_entries entry
      WHERE entry.id = allocation_row.time_entry_id;

      IF source_amount IS NULL THEN
        RAISE EXCEPTION 'Payouts can only allocate approved completed time';
      END IF;
    ELSIF allocation_row.share_earning_id IS NOT NULL THEN
      -- A reversed earning stays valid: its clawback is a separate deduction.
      SELECT CASE WHEN share_earning.voided_at IS NULL THEN share_earning.amount ELSE NULL END
      INTO source_amount
      FROM public.team_member_share_earnings share_earning
      WHERE share_earning.id = allocation_row.share_earning_id;

      IF source_amount IS NULL THEN
        RAISE EXCEPTION 'Payouts cannot allocate a missing or voided share earning';
      END IF;
    ELSE
      SELECT
        CASE
          WHEN adjustment.voided_at IS NULL THEN
            CASE WHEN adjustment.adjustment_type = 'deduction' THEN -adjustment.amount ELSE adjustment.amount END
          ELSE NULL
        END
      INTO source_amount
      FROM public.team_member_earning_adjustments adjustment
      WHERE adjustment.id = allocation_row.adjustment_id;

      IF source_amount IS NULL THEN
        RAISE EXCEPTION 'Payouts cannot allocate a missing or voided adjustment';
      END IF;
    END IF;

    IF source_amount = 0
      OR sign(allocation_row.allocated_amount) IS DISTINCT FROM sign(source_amount) THEN
      RAISE EXCEPTION 'Payout allocation has an invalid direction';
    END IF;

    SELECT COALESCE(SUM(existing.allocated_amount), 0)
    INTO source_allocated
    FROM public.team_member_payout_allocations existing
    JOIN public.team_member_payouts existing_payout ON existing_payout.id = existing.payout_id
    WHERE existing_payout.voided_at IS NULL
      AND (
        (allocation_row.time_entry_id IS NOT NULL AND existing.time_entry_id = allocation_row.time_entry_id)
        OR (allocation_row.adjustment_id IS NOT NULL AND existing.adjustment_id = allocation_row.adjustment_id)
        OR (allocation_row.share_earning_id IS NOT NULL AND existing.share_earning_id = allocation_row.share_earning_id)
      );

    IF (source_amount > 0 AND source_allocated > source_amount + 0.005)
      OR (source_amount < 0 AND source_allocated < source_amount - 0.005) THEN
      RAISE EXCEPTION 'Payout allocation exceeds the remaining source balance';
    END IF;
  END LOOP;
END;
$$;

create or replace function public.link_done_task_to_running_timer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member uuid;
begin
  if auth.uid() is null then
    return null;
  end if;

  select id into v_member
  from public.team_members
  where auth_user_id = auth.uid()
  limit 1;
  if v_member is null then
    return null;
  end if;

  -- Running, not paused: the session is open and its last segment has no end.
  insert into public.time_entry_tasks (time_entry_id, task_id)
  select te.id, new.id
  from public.project_time_entries te
  where te.project_id = new.project_id
    and te.member_id = v_member
    and te.end_time is null
    and te.deleted_at is null
    and jsonb_array_length(te.segments) > 0
    and te.segments -> -1 ->> 'end' is null
  on conflict do nothing;

  return null;
end;
$$;

CREATE OR REPLACE FUNCTION public.review_time_entries(
  p_entry_ids uuid[],
  p_decision text,
  p_reason text DEFAULT NULL,
  p_adjustments jsonb DEFAULT NULL
)
RETURNS SETOF public.project_time_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.has_permission('time.approve', 'app') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid review decision';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND member_id = public.current_team_member_id()
  ) THEN
    RAISE EXCEPTION 'Time entries cannot be self-approved';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_time_entries
    WHERE id = ANY(p_entry_ids)
      AND NOT public.can_access_project(project_id)
  ) THEN
    RAISE EXCEPTION 'Project access denied';
  END IF;
  IF p_decision = 'approved' AND EXISTS (
    SELECT 1
    FROM public.project_time_entries entry
    JOIN public.team_members member ON member.id = entry.member_id
    WHERE entry.id = ANY(p_entry_ids)
      AND entry.approval_status IN ('pending', 'rejected')
      AND member.role NOT IN ('owner', 'agent')
      AND NOT EXISTS (
        SELECT 1 FROM public.team_member_hourly_rates rate
        WHERE rate.member_id = entry.member_id
          AND rate.effective_at <= entry.start_time
      )
  ) THEN
    RAISE EXCEPTION 'Compensation rate missing for one or more time entries';
  END IF;

  UPDATE public.project_time_entries entry
  SET approval_status = p_decision,
      compensation_rate = CASE WHEN p_decision = 'approved'
        THEN public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time)
        ELSE entry.compensation_rate END,
      approved_at = CASE WHEN p_decision = 'approved' THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_decision = 'approved' THEN public.current_team_member_id() ELSE NULL END,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN COALESCE(p_reason, '') ELSE NULL END,
      updated_at = now()
  WHERE entry.id = ANY(p_entry_ids)
    AND entry.approval_status IN ('pending', 'rejected')
    AND entry.end_time IS NOT NULL
    AND entry.deleted_at IS NULL;

  -- Approved agent entries convert to their billed continuous slot here,
  -- optionally with the reviewer's adjusted worked minutes per entry id.
  IF p_decision = 'approved' THEN
    FOREACH v_id IN ARRAY p_entry_ids LOOP
      PERFORM public.apply_agent_billing_conversion(
        v_id,
        CASE WHEN p_adjustments IS NOT NULL AND p_adjustments ? v_id::text
          THEN (p_adjustments->>v_id::text)::numeric
          ELSE NULL END
      );
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT * FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND deleted_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_time_entries_api(
  p_project_id uuid,
  p_entry_ids uuid[],
  p_decision text,
  p_reason text,
  p_reviewer_id uuid
)
RETURNS SETOF public.project_time_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF COALESCE(array_length(p_entry_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'Select at least one time entry'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Invalid review decision'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_members WHERE id = p_reviewer_id AND status = 'active') THEN RAISE EXCEPTION 'Active reviewer not found'; END IF;
  IF (SELECT count(*) FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND deleted_at IS NULL) <> cardinality(p_entry_ids) THEN RAISE EXCEPTION 'One or more time entries were not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND project_id IS DISTINCT FROM p_project_id) THEN RAISE EXCEPTION 'Time entry does not belong to the project'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_time_entries WHERE id = ANY(p_entry_ids) AND member_id = p_reviewer_id) THEN RAISE EXCEPTION 'Time entries cannot be self-approved'; END IF;
  IF p_decision = 'approved' AND EXISTS (
    SELECT 1 FROM public.project_time_entries entry
    JOIN public.team_members member ON member.id = entry.member_id
    WHERE entry.id = ANY(p_entry_ids) AND entry.approval_status = 'pending'
      AND member.role NOT IN ('owner', 'agent')
      AND NOT EXISTS (SELECT 1 FROM public.team_member_hourly_rates rate WHERE rate.member_id = entry.member_id AND rate.effective_at <= entry.start_time)
  ) THEN RAISE EXCEPTION 'Compensation rate missing for one or more time entries'; END IF;
  UPDATE public.project_time_entries entry
  SET approval_status = p_decision,
      compensation_rate = CASE WHEN p_decision = 'approved' THEN public.resolve_team_member_hourly_rate(entry.member_id, entry.start_time) ELSE entry.compensation_rate END,
      approved_at = CASE WHEN p_decision = 'approved' THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_decision = 'approved' THEN p_reviewer_id ELSE NULL END,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN COALESCE(p_reason, '') ELSE NULL END,
      updated_at = now()
  WHERE entry.id = ANY(p_entry_ids) AND entry.project_id = p_project_id
    AND entry.approval_status = 'pending' AND entry.end_time IS NOT NULL;
  IF p_decision = 'approved' THEN
    PERFORM public.apply_agent_billing_conversion(entry_id, NULL)
    FROM unnest(p_entry_ids) AS entry_id;
  END IF;
  RETURN QUERY
  SELECT * FROM public.project_time_entries
  WHERE id = ANY(p_entry_ids) AND project_id = p_project_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_agent_billing_conversion(
  p_entry_id uuid,
  p_adjusted_minutes numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry public.project_time_entries%ROWTYPE;
  v_role text;
  v_raw_worked_ms numeric;
  v_billing_worked_ms numeric;
  v_multiplier numeric;
  v_billed_end timestamptz;
BEGIN
  SELECT * INTO v_entry FROM public.project_time_entries WHERE id = p_entry_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT role INTO v_role FROM public.team_members WHERE id = v_entry.member_id;
  IF v_role IS DISTINCT FROM 'agent' THEN RETURN; END IF;
  IF v_entry.billing_converted_at IS NOT NULL THEN RETURN; END IF;
  IF v_entry.end_time IS NULL OR v_entry.approval_status <> 'approved' THEN RETURN; END IF;

  SELECT COALESCE(SUM(
    GREATEST(0, EXTRACT(EPOCH FROM (
      (segment->>'end')::timestamptz - (segment->>'start')::timestamptz
    )) * 1000)
  ), 0)
  INTO v_raw_worked_ms
  FROM jsonb_array_elements(COALESCE(v_entry.segments, '[]'::jsonb)) AS segment
  WHERE segment->>'end' IS NOT NULL AND segment->>'start' IS NOT NULL;

  IF p_adjusted_minutes IS NOT NULL AND p_adjusted_minutes > 0 THEN
    v_billing_worked_ms := p_adjusted_minutes * 60000;
  ELSE
    v_billing_worked_ms := v_raw_worked_ms;
  END IF;
  IF v_billing_worked_ms <= 0 THEN RETURN; END IF;

  v_multiplier := COALESCE(NULLIF(v_entry.billing_multiplier, 0), 1);
  IF v_multiplier <= 0 THEN v_multiplier := 1; END IF;
  v_billed_end := v_entry.start_time + make_interval(secs => (v_billing_worked_ms * v_multiplier) / 1000.0);

  UPDATE public.project_time_entries
  SET raw_time_snapshot = COALESCE(v_entry.raw_time_snapshot, jsonb_build_object(
        'version', 1,
        'start_time', v_entry.start_time,
        'end_time', v_entry.end_time,
        'segments', COALESCE(v_entry.segments, '[]'::jsonb),
        'worked_ms', v_raw_worked_ms,
        'captured_at', now()
      )),
      segments = jsonb_build_array(jsonb_build_object(
        'start', to_char(v_entry.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'end', to_char(v_billed_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )),
      end_time = v_billed_end,
      billing_converted_at = now(),
      updated_at = now()
  WHERE id = p_entry_id;
END;
$$;


-- ---------------------------------------------------------------------------
-- 8. Drafting, forecast and earned work skip what is in Trash
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_pending_time(p_project_id uuid, p_through timestamptz)
RETURNS TABLE (hours numeric, amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(sum(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time)), 0),
    COALESCE(round(sum(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time) * e.hourly_rate), 2), 0)
  FROM public.project_time_entries e
  WHERE e.project_id = p_project_id
    AND e.end_time IS NOT NULL
    AND e.work_type <> 'internal'
    AND e.approval_status NOT IN ('approved', 'rejected')
    AND e.deleted_at IS NULL
    AND (p_through IS NULL OR e.start_time < p_through)
$$;

CREATE OR REPLACE FUNCTION public.billing_forecast_internal(p_project_id uuid, p_from date, p_until date, p_plan jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  plan public.project_billing_plans;
  items jsonb := '[]'::jsonb;
  r record;
  p record;
  handled record;
  inv_id uuid;
  inv_number text;
  inv_status text;
  period_status text;
  d date;
  prev date;
  pace numeric;
  so_far jsonb;
  first_hours boolean := true;
  est numeric;
  next_block date;
  remaining numeric;
  merged jsonb := '[]'::jsonb;
  item jsonb;
  by_date jsonb := '{}'::jsonb;
  k text;
BEGIN
  -- The saved plan, or the one being edited (live preview before Save).
  SELECT * INTO plan FROM public.project_billing_plans WHERE project_id = p_project_id;
  IF p_plan IS NOT NULL THEN
    plan := jsonb_populate_record(COALESCE(plan, ROW(p_project_id, 0, 'manual', '{1}', 2, NULL, NULL, 'none', NULL, 0, true, false, NULL, NULL, NULL, now(), now())::public.project_billing_plans), p_plan);
    IF plan.hours_trigger <> 'manual' AND plan.starts_on IS NULL THEN plan.starts_on := public.workspace_today(); END IF;
  END IF;

  -- Retainers: each period whose bill date falls in the window.
  FOR r IN SELECT * FROM public.project_retainers WHERE project_id = p_project_id AND deleted_at IS NULL ORDER BY start_date LOOP
    FOR p IN SELECT * FROM public.retainer_periods(r.id, p_from - 62, p_until) LOOP
      CONTINUE WHEN p.bill_date < p_from OR p.bill_date > p_until;
      inv_id := NULL; inv_number := NULL; inv_status := NULL; period_status := NULL;
      SELECT rp.status, i.id, i.invoice_number, i.status INTO period_status, inv_id, inv_number, inv_status
      FROM public.project_retainer_periods rp
      LEFT JOIN public.project_invoices i ON i.id = rp.invoice_id AND i.deleted_at IS NULL
      WHERE rp.retainer_id = r.id AND rp.period_start = p.period_start;
      items := items || jsonb_build_object(
        'date', p.bill_date,
        'source', 'retainer',
        'status', CASE
          WHEN inv_id IS NOT NULL THEN inv_status
          WHEN period_status = 'skipped' THEN 'skipped'
          WHEN r.status = 'paused' THEN 'paused'
          ELSE 'upcoming' END,
        'invoice_id', inv_id,
        'invoice_number', inv_number,
        'line', jsonb_build_object(
          'kind', 'retainer',
          'label', r.name || CASE WHEN p.prorated THEN ' (prorated)' ELSE '' END,
          'amount', p.amount,
          'estimated', false,
          'note', CASE WHEN r.end_date IS NOT NULL AND p.period_end = r.end_date THEN 'Last invoice: the retainer ends ' || to_char(r.end_date, 'Mon FMDD, YYYY') END
        )
      );
    END LOOP;
  END LOOP;

  -- Hours: the pace of approved client work over the last 90 days, per day.
  SELECT COALESCE(sum(public.time_entry_worked_hours(e.segments, e.start_time, e.end_time) * e.hourly_rate), 0) / 90
  INTO pace
  FROM public.project_time_entries e
  WHERE e.project_id = p_project_id AND e.end_time IS NOT NULL AND e.work_type <> 'internal'
    AND e.approval_status = 'approved' AND e.deleted_at IS NULL AND e.start_time >= now() - interval '90 days';
  so_far := public.invoice_hours_draft_internal(p_project_id, 'all');

  IF plan.project_id IS NOT NULL AND plan.hours_trigger IN ('days_of_month', 'every_weeks') THEN
    prev := public.workspace_today();
    FOR d IN SELECT * FROM public.billing_plan_dates(plan, p_from, p_until) LOOP
      -- A drafted invoice since moved to Trash reads as if it was deleted.
      SELECT r2.*, i.id AS live_invoice_id, i.status AS live_status, i.invoice_number AS live_number INTO handled
      FROM public.project_billing_runs r2
      LEFT JOIN public.project_invoices i ON i.id = r2.invoice_id AND i.deleted_at IS NULL
      WHERE r2.project_id = p_project_id AND r2.run_key = 'day:' || to_char(d, 'YYYY-MM-DD');
      IF FOUND THEN
        items := items || jsonb_build_object('date', d, 'source', 'hours',
          'status', CASE WHEN handled.live_invoice_id IS NOT NULL THEN handled.live_status ELSE handled.outcome END,
          'invoice_id', handled.live_invoice_id,
          'invoice_number', handled.live_number,
          'line', jsonb_build_object('kind', 'hours', 'label', 'Hours', 'amount', handled.amount, 'estimated', false,
            'note', CASE WHEN handled.pending_hours > 0 THEN round(handled.pending_hours, 2) || ' h awaiting approval left out' END));
        CONTINUE;
      END IF;
      IF first_hours THEN
        est := COALESCE((so_far->>'amount')::numeric, 0);
        items := items || jsonb_build_object('date', d, 'source', 'hours', 'status', CASE WHEN plan.paused THEN 'paused' ELSE 'upcoming' END,
          'line', jsonb_build_object('kind', 'hours', 'label', 'Hours so far', 'amount', est, 'estimated', true,
            'note', round(COALESCE((so_far->>'hours')::numeric, 0), 2) || ' h unbilled now; more may be added before ' || to_char(d, 'Mon FMDD')));
        first_hours := false;
      ELSE
        est := round(pace * (d - prev), 2);
        items := items || jsonb_build_object('date', d, 'source', 'hours', 'status', CASE WHEN plan.paused THEN 'paused' ELSE 'upcoming' END,
          'line', jsonb_build_object('kind', 'hours', 'label', 'Hours (est.)', 'amount', est, 'estimated', true,
            'note', 'At the last 90 days'' pace'));
      END IF;
      IF plan.cap_mode = 'amount' AND plan.cap_value IS NOT NULL THEN
        items := jsonb_set(items, ARRAY[(jsonb_array_length(items) - 1)::text, 'line', 'amount'],
          to_jsonb(LEAST(est, plan.cap_value)));
      END IF;
      prev := d;
    END LOOP;
  ELSIF plan.project_id IS NOT NULL AND plan.hours_trigger IN ('reaches_amount', 'fixed_blocks') AND plan.trigger_amount IS NOT NULL THEN
    remaining := plan.trigger_amount - COALESCE((so_far->>'amount')::numeric, 0);
    IF pace > 0 THEN
      next_block := public.workspace_today() + GREATEST(0, ceil(remaining / pace))::integer;
      WHILE next_block <= p_until LOOP
        IF next_block >= p_from THEN
          items := items || jsonb_build_object('date', next_block, 'source', 'hours', 'status', CASE WHEN plan.paused THEN 'paused' ELSE 'upcoming' END,
            'line', jsonb_build_object('kind', 'hours',
              'label', CASE WHEN plan.hours_trigger = 'fixed_blocks' THEN 'Block of hours (est. date)' ELSE 'Hours (est. date)' END,
              'amount', plan.trigger_amount, 'estimated', true,
              'note', 'When unbilled hours reach $' || to_char(plan.trigger_amount, 'FM999,999,990.00') || ', at the last 90 days'' pace'));
        END IF;
        next_block := next_block + GREATEST(1, ceil(plan.trigger_amount / pace))::integer;
      END LOOP;
    END IF;
  END IF;

  -- One invoice per date: retainer and hours lines on the same date ride
  -- together when the plan combines them.
  -- Retainer lines of one date share an invoice (the retainer job drafts one
  -- per project per date); hours join it when the plan combines them.
  FOR item IN SELECT value FROM jsonb_array_elements(items) ORDER BY (value->>'date')::date, value->>'source' DESC LOOP
    k := CASE WHEN item->>'source' = 'retainer' OR COALESCE(plan.combine_with_retainer, true)
              THEN item->>'date' ELSE (item->>'date') || '#hours' END;
    IF by_date ? k THEN
      by_date := jsonb_set(by_date, ARRAY[k], (by_date->k)
        || jsonb_build_object(
          'sources', CASE WHEN (by_date->k->>'sources') LIKE '%' || (item->>'source') || '%' THEN by_date->k->>'sources'
                          ELSE (by_date->k->>'sources') || ',' || (item->>'source') END,
          'lines', (by_date->k->'lines') || jsonb_build_array(item->'line'),
          'invoice_id', COALESCE(by_date->k->'invoice_id', item->'invoice_id'),
          'invoice_number', COALESCE(by_date->k->'invoice_number', item->'invoice_number')));
    ELSE
      by_date := by_date || jsonb_build_object(k, jsonb_build_object(
        'date', item->>'date', 'sources', item->>'source', 'status', item->>'status',
        'invoice_id', item->'invoice_id', 'invoice_number', item->'invoice_number',
        'lines', jsonb_build_array(item->'line')));
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(
    v || jsonb_build_object(
      'exact', (SELECT COALESCE(sum((l->>'amount')::numeric), 0) FROM jsonb_array_elements(v->'lines') l WHERE NOT (l->>'estimated')::boolean),
      'estimated', (SELECT COALESCE(sum((l->>'amount')::numeric), 0) FROM jsonb_array_elements(v->'lines') l WHERE (l->>'estimated')::boolean)
    ) ORDER BY (v->>'date')::date, v->>'sources'), '[]'::jsonb)
  INTO merged
  FROM jsonb_each(by_date) AS e(key, v);
  RETURN merged;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_forecast(p_project_id uuid, p_from date DEFAULT NULL, p_until date DEFAULT NULL, p_plan jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  from_day date := COALESCE(p_from, public.workspace_today());
  until_day date := COALESCE(p_until, from_day + 365);
  project record;
  out jsonb := '[]'::jsonb;
BEGIN
  IF until_day > from_day + 800 THEN until_day := from_day + 800; END IF;
  IF p_project_id IS NOT NULL THEN
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND NOT (public.has_permission('invoices.read', 'app') AND public.can_access_project(p_project_id)) THEN
      RAISE EXCEPTION 'Not allowed to read billing on this project' USING ERRCODE = '42501';
    END IF;
    RETURN public.billing_forecast_internal(p_project_id, from_day, until_day, p_plan);
  END IF;
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.has_permission('invoices.read', 'app') THEN
    RAISE EXCEPTION 'Not allowed to read billing' USING ERRCODE = '42501';
  END IF;
  FOR project IN
    SELECT pr.id, pr.name FROM public.projects pr
    WHERE pr.archived_at IS NULL
      AND pr.deleted_at IS NULL
      AND (COALESCE(auth.role(), '') = 'service_role' OR public.can_access_project(pr.id))
      AND (EXISTS (SELECT 1 FROM public.project_retainers rt WHERE rt.project_id = pr.id AND rt.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM public.project_billing_plans bp WHERE bp.project_id = pr.id AND bp.hours_trigger <> 'manual'))
    ORDER BY pr.name
  LOOP
    SELECT out || COALESCE(jsonb_agg(item || jsonb_build_object('project_id', project.id, 'project_name', project.name)), '[]'::jsonb)
    INTO out
    FROM jsonb_array_elements(public.billing_forecast_internal(project.id, from_day, until_day)) item;
  END LOOP;
  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_billing_drafts(p_as_of date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  as_of date := COALESCE(p_as_of, public.workspace_today());
  plan public.project_billing_plans;
  total integer := 0;
BEGIN
  FOR plan IN
    SELECT p.* FROM public.project_billing_plans p
    JOIN public.projects project ON project.id = p.project_id
    WHERE p.hours_trigger <> 'manual' AND NOT p.paused
      AND project.archived_at IS NULL AND project.deleted_at IS NULL AND COALESCE(project.status, 'active') NOT IN ('completed', 'archived', 'cancelled')
  LOOP
    BEGIN
      total := total + public.run_project_billing(plan, as_of);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, detail)
      VALUES (plan.project_id, 'failed:' || to_char(as_of, 'YYYY-MM-DD'), as_of, 'failed', left(SQLERRM, 500))
      ON CONFLICT (project_id, run_key) DO UPDATE SET detail = EXCLUDED.detail, created_at = now();
    END;
  END LOOP;
  RETURN total;
END;
$$;

CREATE OR REPLACE FUNCTION public.place_hours_draft(
  p_project_id uuid,
  p_draft jsonb,
  p_date date,
  p_combine boolean,
  OUT invoice_id uuid,
  OUT merged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.project_invoices;
  terms integer;
  project_name text;
  line jsonb;
  line_id text := gen_random_uuid()::text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('retainer-draft:' || p_project_id::text));
  SELECT COALESCE(payment_terms_days, 0) INTO terms FROM public.project_billing_plans WHERE project_id = p_project_id;
  SELECT name INTO project_name FROM public.projects WHERE id = p_project_id;
  merged := false;

  IF p_combine THEN
    SELECT * INTO target FROM public.project_invoices i
    WHERE i.project_id = p_project_id AND i.status = 'draft' AND i.auto_generated AND i.deleted_at IS NULL
      AND i.date = to_char(p_date, 'YYYY-MM-DD')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.line_items) l WHERE l->>'item_type' = 'hourly')
    ORDER BY i.created_at
    LIMIT 1;
    merged := FOUND;
  END IF;

  line := jsonb_build_object(
    'id', line_id,
    'position', CASE WHEN merged THEN jsonb_array_length(target.line_items) ELSE 0 END,
    'item_type', 'hourly',
    'amount', (p_draft->>'amount')::numeric,
    'description', p_draft->>'description',
    'service_start_date', NULL,
    'service_end_date', NULL,
    'recurrence_frequency', NULL
  );

  IF merged THEN
    UPDATE public.project_invoices
    SET line_items = line_items || jsonb_build_array(line),
        amount = amount + (p_draft->>'amount')::numeric
    WHERE id = target.id;
    invoice_id := target.id;
  ELSE
    INSERT INTO public.project_invoices (
      project_id, invoice_number, amount, status, invoice_type, line_items,
      date, due_date, description, auto_generated, created_by
    ) VALUES (
      p_project_id,
      public.next_project_invoice_number(p_project_id),
      (p_draft->>'amount')::numeric,
      'draft',
      'hourly',
      jsonb_build_array(line),
      to_char(p_date, 'YYYY-MM-DD'),
      to_char(p_date + COALESCE(terms, 0), 'YYYY-MM-DD'),
      '',
      true,
      NULL
    )
    RETURNING id INTO invoice_id;
  END IF;

  INSERT INTO public.invoice_time_entry_allocations (invoice_id, line_item_id, time_entry_id, start_offset_hours, allocated_hours, allocated_amount)
  SELECT invoice_id, line_id, (a->>'time_entry_id')::uuid, (a->>'start_offset_hours')::numeric,
         (a->>'allocated_hours')::numeric, (a->>'allocated_amount')::numeric
  FROM jsonb_array_elements(p_draft->'allocations') a;
  PERFORM public.validate_invoice_time_allocations(invoice_id);

  PERFORM public.announce_billing_draft(
    invoice_id,
    CASE WHEN merged THEN 'Hours added to a drafted invoice' ELSE 'Invoice drafted' END,
    (SELECT invoice_number FROM public.project_invoices WHERE id = invoice_id) || ' for ' || COALESCE(project_name, 'a project')
      || CASE WHEN merged THEN ' now includes ' ELSE ' covers ' END
      || rtrim(rtrim(to_char(round((p_draft->>'hours')::numeric, 2), 'FM999999990.00'), '0'), '.') || ' h ($'
      || to_char((p_draft->>'amount')::numeric, 'FM999,999,990.00') || '). Ready to review and send.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_earned_work(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text := public.workspace_timezone();
  today date := public.workspace_today();
  result jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed to read earned work' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'EARNED_WORK_RANGE: from and to are required, and from must not be after to';
  END IF;
  IF p_to - p_from > 1830 THEN
    RAISE EXCEPTION 'EARNED_WORK_RANGE: at most five years at a time';
  END IF;

  WITH sessions AS (
    SELECT entry.project_id,
           (entry.start_time AT TIME ZONE zone)::date AS day,
           public.time_entry_worked_hours(entry.segments, entry.start_time, entry.end_time) AS hours,
           entry.hourly_rate AS rate
    FROM public.project_time_entries entry
    JOIN public.projects project ON project.id = entry.project_id
    WHERE project.client_time_billing = 'hourly'
      AND project.deleted_at IS NULL
      AND entry.deleted_at IS NULL
      AND entry.end_time IS NOT NULL
      AND entry.work_type <> 'internal'
      AND entry.approval_status = 'approved'
      AND entry.hourly_rate > 0
      AND (entry.start_time AT TIME ZONE zone)::date BETWEEN p_from AND p_to
  ),
  time_rows AS (
    SELECT jsonb_build_object(
      'project_id', project_id,
      'kind', 'time',
      'earned_from', day,
      'earned_to', day,
      'hours', ROUND(sum(hours), 4),
      'amount', ROUND(sum(hours * rate), 2)
    ) AS row, project_id, day AS sort_day
    FROM sessions
    GROUP BY project_id, day
    HAVING ROUND(sum(hours * rate), 2) > 0
  ),
  scheduled_rows AS (
    SELECT jsonb_build_object(
      'project_id', retainer.project_id,
      'kind', 'scheduled',
      'earned_from', period.period_start,
      'earned_to', period.period_end,
      'amount', period.amount,
      'retainer_id', retainer.id,
      'retainer_name', retainer.name,
      'billing_timing', retainer.billing_timing,
      'draft_invoice_id', invoice.id
    ) AS row, retainer.project_id, period.period_start AS sort_day
    FROM public.project_retainers retainer
    CROSS JOIN LATERAL public.retainer_periods(retainer.id, p_from, LEAST(p_to, today)) period
    LEFT JOIN public.project_retainer_periods handled
      ON handled.retainer_id = retainer.id AND handled.period_start = period.period_start
    LEFT JOIN public.project_invoices invoice ON invoice.id = handled.invoice_id
    WHERE retainer.status = 'active'
      AND retainer.deleted_at IS NULL
      AND public.project_is_live(retainer.project_id)
      AND period.period_start <= today
      AND period.period_end >= p_from
      AND period.amount > 0
      AND (handled.id IS NULL OR (handled.status = 'invoiced' AND invoice.status = 'draft'))
  )
  SELECT COALESCE(jsonb_agg(row ORDER BY project_id, sort_day, row->>'kind'), '[]'::jsonb)
  INTO result
  FROM (SELECT * FROM time_rows UNION ALL SELECT * FROM scheduled_rows) earned;

  RETURN result;
END;
$$;


-- ---------------------------------------------------------------------------
-- 9. Retainers in Trash stop billing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retainer_periods(p_retainer_id uuid, p_from date, p_to date)
RETURNS TABLE (
  period_start date,
  period_end date,
  bill_date date,
  amount numeric,
  full_amount numeric,
  prorated boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH retainer AS (
    SELECT * FROM public.project_retainers WHERE id = p_retainer_id AND deleted_at IS NULL
  ),
  months AS (
    SELECT month_start::date AS month_start,
           (month_start + interval '1 month' - interval '1 day')::date AS month_end
    FROM retainer,
      generate_series(
        date_trunc('month', GREATEST(p_from, retainer.start_date)::timestamp),
        date_trunc('month', LEAST(p_to, COALESCE(retainer.end_date, p_to))::timestamp),
        interval '1 month'
      ) AS month_start
  ),
  bounds AS (
    SELECT months.month_start,
           months.month_end,
           GREATEST(months.month_start, retainer.start_date) AS period_start,
           LEAST(months.month_end, COALESCE(retainer.end_date, months.month_end)) AS period_end,
           retainer.billing_timing
    FROM months, retainer
  ),
  priced AS (
    SELECT bounds.*,
      COALESCE(
        (SELECT history.amount FROM public.project_retainer_amounts history
         WHERE history.retainer_id = p_retainer_id AND history.deleted_at IS NULL
           AND history.effective_date <= bounds.period_start
         ORDER BY history.effective_date DESC LIMIT 1),
        (SELECT history.amount FROM public.project_retainer_amounts history
         WHERE history.retainer_id = p_retainer_id AND history.deleted_at IS NULL
         ORDER BY history.effective_date ASC LIMIT 1),
        0
      ) AS full_amount
    FROM bounds
    WHERE bounds.period_end >= bounds.period_start
  )
  SELECT
    priced.period_start,
    priced.period_end,
    CASE WHEN priced.billing_timing = 'arrears' THEN priced.period_end + 1 ELSE priced.period_start END,
    ROUND(
      priced.full_amount
        * (priced.period_end - priced.period_start + 1)
        / (priced.month_end - priced.month_start + 1),
      2
    ),
    priced.full_amount,
    (priced.period_start <> priced.month_start OR priced.period_end <> priced.month_end)
  FROM priced
  ORDER BY priced.period_start
$$;

CREATE OR REPLACE FUNCTION public.retainer_due_periods_internal(p_project_id uuid, p_as_of date)
RETURNS TABLE (
  retainer_id uuid,
  project_id uuid,
  retainer_name text,
  retainer_status text,
  billing_timing text,
  period_start date,
  period_end date,
  bill_date date,
  amount numeric,
  full_amount numeric,
  prorated boolean,
  description text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    retainer.id,
    retainer.project_id,
    retainer.name,
    retainer.status,
    retainer.billing_timing,
    period.period_start,
    period.period_end,
    period.bill_date,
    period.amount,
    period.full_amount,
    period.prorated,
    retainer.name || CASE WHEN period.prorated THEN ' (Prorated)' ELSE '' END
  FROM public.project_retainers retainer
  CROSS JOIN LATERAL public.retainer_periods(
    retainer.id,
    retainer.start_date,
    (p_as_of + retainer.lead_days + 31)
  ) period
  WHERE (p_project_id IS NULL OR retainer.project_id = p_project_id)
    AND retainer.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.projects project
        WHERE project.id = retainer.project_id AND project.deleted_at IS NULL)
    AND period.bill_date - retainer.lead_days <= p_as_of
    AND NOT EXISTS (
      SELECT 1 FROM public.project_retainer_periods handled
      WHERE handled.retainer_id = retainer.id
        AND handled.period_start = period.period_start
    )
  ORDER BY retainer.created_at, period.period_start
$$;

CREATE OR REPLACE FUNCTION public.retainer_due_periods(p_project_id uuid)
RETURNS TABLE (
  retainer_id uuid,
  retainer_name text,
  billing_timing text,
  period_start date,
  period_end date,
  bill_date date,
  amount numeric,
  full_amount numeric,
  prorated boolean,
  description text,
  skipped boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(p_project_id)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;

  RETURN QUERY
  SELECT due.retainer_id, due.retainer_name, due.billing_timing, due.period_start, due.period_end,
         due.bill_date, due.amount, due.full_amount, due.prorated, due.description, false
  FROM public.retainer_due_periods_internal(p_project_id, public.workspace_today()) due
  WHERE due.retainer_status = 'active'
  UNION ALL
  SELECT retainer.id, retainer.name, retainer.billing_timing, period.period_start, period.period_end,
         period.bill_date, period.amount, period.full_amount, period.prorated,
         retainer.name || CASE WHEN period.prorated THEN ' (Prorated)' ELSE '' END, true
  FROM public.project_retainer_periods handled
  JOIN public.project_retainers retainer ON retainer.id = handled.retainer_id
  CROSS JOIN LATERAL public.retainer_periods(retainer.id, handled.period_start, handled.period_start) period
  WHERE retainer.project_id = p_project_id
    AND retainer.deleted_at IS NULL
    AND handled.status = 'skipped'
    AND period.period_start = handled.period_start
  ORDER BY 4, 2;
END;
$$;

CREATE OR REPLACE FUNCTION public.retainer_accruing_lines()
RETURNS TABLE (
  project_id uuid,
  retainer_id uuid,
  period_start date,
  period_end date,
  amount numeric,
  share_percent numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH clock AS (
    SELECT public.workspace_today() AS today,
           COALESCE(auth.role(), '') = 'service_role' AS is_service
  )
  SELECT
    retainer.project_id,
    retainer.id,
    period.period_start,
    period.period_end,
    period.amount,
    CASE WHEN clock.is_service OR public.has_permission('compensation.manage', 'app') THEN COALESCE((
      SELECT SUM(share.percent)
      FROM public.project_retainer_shares share
      WHERE share.retainer_id = retainer.id
        AND share.effective_from <= period.period_start
        AND (share.effective_to IS NULL OR share.effective_to >= period.period_start)
    ), 0) ELSE 0 END
  FROM clock
  CROSS JOIN public.project_retainers retainer
  CROSS JOIN LATERAL public.retainer_periods(retainer.id, clock.today, clock.today) period
  WHERE retainer.status = 'active'
    AND retainer.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.projects project
        WHERE project.id = retainer.project_id AND project.deleted_at IS NULL)
    AND clock.today BETWEEN period.period_start AND period.period_end
    AND (clock.is_service OR (public.has_permission('invoices.read', 'app') AND public.can_access_project(retainer.project_id)))
    AND NOT EXISTS (
      SELECT 1 FROM public.project_retainer_periods handled
      WHERE handled.retainer_id = retainer.id AND handled.period_start = period.period_start
    )
$$;

CREATE OR REPLACE FUNCTION public.generate_retainer_period(p_retainer_id uuid, p_period_start date)
RETURNS public.project_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  retainer public.project_retainers;
  period record;
  handled public.project_retainer_periods;
BEGIN
  SELECT * INTO retainer FROM public.project_retainers
  WHERE id = p_retainer_id AND deleted_at IS NULL AND public.project_is_live(project_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(retainer.project_id)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;

  SELECT * INTO period
  FROM public.retainer_periods(p_retainer_id, p_period_start, p_period_start) candidate
  WHERE candidate.period_start = p_period_start;
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not a billing period of this retainer'; END IF;

  SELECT * INTO handled
  FROM public.project_retainer_periods
  WHERE retainer_id = p_retainer_id AND period_start = p_period_start
  FOR UPDATE;
  IF FOUND THEN
    IF handled.status = 'invoiced' AND handled.invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'That period is already on an invoice';
    END IF;
    DELETE FROM public.project_retainer_periods WHERE id = handled.id;
  END IF;

  RETURN public.create_retainer_draft_internal(
    retainer.project_id,
    jsonb_build_array(public.retainer_line_json(
      retainer.id, 0, period.amount,
      retainer.name || CASE WHEN period.prorated THEN ' (Prorated)' ELSE '' END,
      period.period_start, period.period_end
    )),
    GREATEST(period.bill_date, public.workspace_today()),
    false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_project_retainer(p_retainer_id uuid, p_retainer jsonb)
RETURNS public.project_retainers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.project_retainers;
  target_project uuid;
BEGIN
  IF p_retainer_id IS NULL THEN
    target_project := (p_retainer->>'project_id')::uuid;
  ELSE
    SELECT project_id INTO target_project FROM public.project_retainers WHERE id = p_retainer_id AND deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;
  END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(target_project)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;

  IF p_retainer_id IS NULL THEN
    IF NULLIF(btrim(COALESCE(p_retainer->>'name', '')), '') IS NULL
      OR NULLIF(p_retainer->>'start_date', '') IS NULL
      OR NULLIF(p_retainer->>'amount', '') IS NULL THEN
      RAISE EXCEPTION 'A retainer needs a name, a start date and an amount';
    END IF;

    INSERT INTO public.project_retainers (
      project_id, name, billing_timing, start_date, end_date, status, lead_days, created_by
    ) VALUES (
      target_project,
      btrim(p_retainer->>'name'),
      COALESCE(NULLIF(p_retainer->>'billing_timing', ''), 'advance'),
      (p_retainer->>'start_date')::date,
      NULLIF(p_retainer->>'end_date', '')::date,
      COALESCE(NULLIF(p_retainer->>'status', ''), 'active'),
      COALESCE(NULLIF(p_retainer->>'lead_days', '')::integer, 1),
      public.current_team_member_id()
    ) RETURNING * INTO saved;

    INSERT INTO public.project_retainer_amounts (retainer_id, amount, effective_date, created_by)
    VALUES (saved.id, (p_retainer->>'amount')::numeric, saved.start_date, public.current_team_member_id());

    -- The split goes in before any line is linked, so a linked line inherits it.
    IF jsonb_typeof(p_retainer->'shares') = 'array' AND jsonb_array_length(p_retainer->'shares') > 0 THEN
      IF COALESCE(auth.role(), '') <> 'service_role'
        AND NOT public.has_permission('compensation.manage', 'app') THEN
        RAISE EXCEPTION 'Missing permission to manage compensation';
      END IF;
      INSERT INTO public.project_retainer_shares (retainer_id, member_id, percent, effective_from, created_by)
      SELECT saved.id, (share.value->>'member_id')::uuid, (share.value->>'percent')::numeric,
             saved.start_date, public.current_team_member_id()
      FROM jsonb_array_elements(p_retainer->'shares') share;
    END IF;

    -- Lines that were invoiced by hand before the retainer existed. Linking
    -- them here, in the same transaction, means the job never sees those
    -- periods as due.
    IF jsonb_typeof(p_retainer->'link_lines') = 'array' THEN
      UPDATE public.project_invoices invoice
      SET line_items = (
        SELECT jsonb_agg(
          CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_retainer->'link_lines') link
            WHERE link.value->>'invoice_id' = invoice.id::text
              AND link.value->>'line_item_id' = line.value->>'id'
          )
          THEN line.value || jsonb_build_object('retainer_id', saved.id::text)
          ELSE line.value END
          ORDER BY line.ordinality
        )
        FROM jsonb_array_elements(invoice.line_items) WITH ORDINALITY AS line(value, ordinality)
      )
      WHERE invoice.project_id = saved.project_id
        AND invoice.deleted_at IS NULL
        AND jsonb_typeof(invoice.line_items) = 'array'
        AND jsonb_array_length(invoice.line_items) > 0
        AND invoice.id::text IN (
          SELECT link.value->>'invoice_id' FROM jsonb_array_elements(p_retainer->'link_lines') link
        );
    END IF;
  ELSE
    UPDATE public.project_retainers retainer
    SET
      name = CASE WHEN p_retainer ? 'name' THEN btrim(p_retainer->>'name') ELSE retainer.name END,
      billing_timing = CASE WHEN p_retainer ? 'billing_timing' THEN p_retainer->>'billing_timing' ELSE retainer.billing_timing END,
      start_date = CASE WHEN p_retainer ? 'start_date' THEN (p_retainer->>'start_date')::date ELSE retainer.start_date END,
      end_date = CASE WHEN p_retainer ? 'end_date' THEN NULLIF(p_retainer->>'end_date', '')::date ELSE retainer.end_date END,
      status = CASE WHEN p_retainer ? 'status' THEN p_retainer->>'status' ELSE retainer.status END,
      lead_days = CASE WHEN p_retainer ? 'lead_days' THEN (p_retainer->>'lead_days')::integer ELSE retainer.lead_days END
    WHERE retainer.id = p_retainer_id
    RETURNING * INTO saved;
  END IF;

  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.schedule_retainer_amount(
  p_retainer_id uuid,
  p_amount numeric,
  p_effective_date date
)
RETURNS public.project_retainer_amounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.project_retainer_amounts;
  target_project uuid;
BEGIN
  SELECT project_id INTO target_project FROM public.project_retainers WHERE id = p_retainer_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('invoices.manage', 'app') AND public.can_access_project(target_project)) THEN
    RAISE EXCEPTION 'Missing permission to manage invoices';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 OR p_effective_date IS NULL THEN
    RAISE EXCEPTION 'An amount and an effective date are required';
  END IF;

  INSERT INTO public.project_retainer_amounts (retainer_id, amount, effective_date, created_by)
  VALUES (p_retainer_id, p_amount, p_effective_date, public.current_team_member_id())
  ON CONFLICT (retainer_id, effective_date) WHERE deleted_at IS NULL DO UPDATE SET amount = EXCLUDED.amount
  RETURNING * INTO saved;

  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_retainer_shares(
  p_retainer_id uuid,
  p_shares jsonb,
  p_effective_from date
)
RETURNS SETOF public.project_retainer_shares
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_project uuid;
BEGIN
  SELECT project_id INTO target_project FROM public.project_retainers WHERE id = p_retainer_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retainer not found'; END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT (public.has_permission('compensation.manage', 'app') AND public.can_access_project(target_project)) THEN
    RAISE EXCEPTION 'Missing permission to manage compensation';
  END IF;
  IF p_effective_from IS NULL OR jsonb_typeof(p_shares) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Splits and an effective date are required';
  END IF;

  DELETE FROM public.project_retainer_shares
  WHERE retainer_id = p_retainer_id AND effective_from >= p_effective_from;

  UPDATE public.project_retainer_shares
  SET effective_to = p_effective_from - 1
  WHERE retainer_id = p_retainer_id
    AND (effective_to IS NULL OR effective_to >= p_effective_from);

  INSERT INTO public.project_retainer_shares (retainer_id, member_id, percent, effective_from, created_by)
  SELECT p_retainer_id, (share.value->>'member_id')::uuid, (share.value->>'percent')::numeric,
         p_effective_from, public.current_team_member_id()
  FROM jsonb_array_elements(p_shares) share;

  RETURN QUERY
  SELECT * FROM public.project_retainer_shares
  WHERE retainer_id = p_retainer_id
  ORDER BY effective_from, created_at;
END;
$$;


-- ---------------------------------------------------------------------------
-- 10. Due reminders skip what is in Trash
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_due_reminders(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text := public.workspace_timezone();
  due record;
  sent integer := 0;
BEGIN
  FOR due IN
    SELECT r.id, r.owner_id, r.title, r.project_id, r.task_id,
           t.title AS task_title, p.name AS project_name
    FROM public.reminders r
    LEFT JOIN public.tasks t ON t.id = r.task_id
    LEFT JOIN public.projects p ON p.id = r.project_id
    WHERE r.status = 'open'
      AND r.deleted_at IS NULL
      AND (r.task_id IS NULL OR t.deleted_at IS NULL)
      AND (r.project_id IS NULL OR p.deleted_at IS NULL)
      AND r.notified_at IS NULL
      AND r.remind_on IS NOT NULL
      AND (r.remind_on + COALESCE(r.remind_at, time '08:00')) AT TIME ZONE zone <= p_now
    ORDER BY r.remind_on, r.remind_at NULLS FIRST
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    PERFORM public.upsert_notification(
      due.owner_id,
      'Reminder',
      due.title || CASE
        WHEN due.task_title IS NOT NULL THEN ' (' || due.task_title || ')'
        WHEN due.project_name IS NOT NULL THEN ' (' || due.project_name || ')'
        ELSE ''
      END,
      CASE
        WHEN due.task_id IS NOT NULL THEN '/projects/' || due.project_id::text || '?task=' || due.task_id::text
        ELSE '/reminders'
      END,
      'reminder',
      due.id::text
    );
    UPDATE public.reminders SET notified_at = p_now WHERE id = due.id;
    sent := sent + 1;
  END LOOP;
  RETURN sent;
END;
$$;


-- ---------------------------------------------------------------------------
-- 11. Trash handles the billing records
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trash_record_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'projects', 'tasks', 'task_subtasks', 'task_comments', 'reminders', 'project_credentials',
    'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads',
    'lead_interactions', 'lead_proposals', 'lead_fields',
    'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates',
    'project_retainers', 'project_retainer_amounts'
  ]
$$;

CREATE OR REPLACE FUNCTION public.can_trash_record(p_table text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := public.current_team_member_id();
  allowed boolean := false;
BEGIN
  IF me IS NULL THEN
    RETURN false;
  END IF;
  CASE p_table
    WHEN 'projects' THEN
      SELECT public.has_permission('projects.manage') AND (
        public.has_permission('projects.read_all')
        OR EXISTS (SELECT 1 FROM public.project_members WHERE project_id = p_id AND member_id = me)
      ) INTO allowed;
    WHEN 'tasks' THEN
      SELECT public.has_permission('tasks.manage_all') AND public.can_access_project(project_id)
      INTO allowed FROM public.tasks WHERE id = p_id;
    WHEN 'task_subtasks' THEN
      SELECT public.can_access_task(task_id) AND (
        public.has_permission('tasks.manage_all') OR (
          public.has_permission('tasks.manage_assigned') AND EXISTS (
            SELECT 1 FROM public.task_assignees assignment
            WHERE assignment.task_id = task_subtasks.task_id AND assignment.member_id = me
          )
        )
      ) INTO allowed FROM public.task_subtasks WHERE id = p_id;
    WHEN 'task_comments' THEN
      SELECT public.can_access_task(task_id) AND (user_id = me OR public.has_permission('tasks.manage_all'))
      INTO allowed FROM public.task_comments WHERE id = p_id;
    WHEN 'reminders' THEN
      SELECT public.can_see_reminder(owner_id, project_id, task_id)
        AND (owner_id = me OR created_by = me OR public.has_permission('tasks.manage_all'))
      INTO allowed FROM public.reminders WHERE id = p_id;
    WHEN 'project_credentials' THEN
      SELECT public.has_permission('credentials.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_credentials WHERE id = p_id;
    WHEN 'entity_files' THEN
      SELECT public.can_access_file_entity(entity_type, entity_id) AND (
        public.has_permission('files.manage') OR (uploaded_by = me AND visibility = 'internal')
      ) INTO allowed FROM public.entity_files WHERE id = p_id;
    WHEN 'portal_updates' THEN
      SELECT public.has_permission('portal.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.portal_updates WHERE id = p_id;
    WHEN 'portal_update_attachments' THEN
      SELECT public.has_permission('portal.manage') AND public.can_access_project(update_row.project_id)
      INTO allowed
      FROM public.portal_update_attachments attachment
      JOIN public.portal_updates update_row ON update_row.id = attachment.update_id
      WHERE attachment.id = p_id AND update_row.deleted_at IS NULL;
    WHEN 'contacts' THEN
      SELECT public.has_permission('contacts.manage') INTO allowed;
    WHEN 'leads' THEN
      SELECT public.has_permission('leads.manage') INTO allowed;
    WHEN 'lead_interactions' THEN
      SELECT public.has_permission('leads.manage') AND public.can_access_lead(lead_id)
      INTO allowed FROM public.lead_interactions WHERE id = p_id;
    WHEN 'lead_proposals' THEN
      SELECT public.has_permission('leads.manage') AND public.can_access_lead(lead_id)
      INTO allowed FROM public.lead_proposals WHERE id = p_id;
    WHEN 'lead_fields' THEN
      SELECT public.has_permission('leads.manage') AND public.can_access_lead(lead_id)
      INTO allowed FROM public.lead_fields WHERE id = p_id;
    WHEN 'project_time_entries' THEN
      SELECT public.can_access_project(project_id) AND (
        public.has_permission('time.manage_all') OR (
          public.has_permission('time.manage_own')
          AND member_id = me
          AND approval_status IN ('draft', 'pending', 'rejected')
        )
      ) INTO allowed FROM public.project_time_entries WHERE id = p_id;
    WHEN 'project_invoices' THEN
      SELECT public.has_permission('invoices.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_invoices WHERE id = p_id;
    WHEN 'invoice_payments' THEN
      -- People remove only payments recorded by hand, as remove_invoice_payment.
      SELECT (public.has_permission('invoices.record_payments') OR public.has_permission('invoices.manage'))
        AND public.can_access_project(invoice.project_id)
        AND invoice.deleted_at IS NULL
        AND payment.recorded_via = 'app'
      INTO allowed
      FROM public.invoice_payments payment
      JOIN public.project_invoices invoice ON invoice.id = payment.invoice_id
      WHERE payment.id = p_id;
    WHEN 'project_hourly_rates' THEN
      SELECT public.has_permission('billing.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_hourly_rates WHERE id = p_id;
    WHEN 'project_retainers' THEN
      SELECT public.has_permission('invoices.manage') AND public.can_access_project(project_id)
      INTO allowed FROM public.project_retainers WHERE id = p_id;
    WHEN 'project_retainer_amounts' THEN
      SELECT public.has_permission('invoices.manage') AND public.can_access_project(retainer.project_id)
        AND retainer.deleted_at IS NULL
      INTO allowed
      FROM public.project_retainer_amounts amount
      JOIN public.project_retainers retainer ON retainer.id = amount.retainer_id
      WHERE amount.id = p_id;
    ELSE
      allowed := false;
  END CASE;
  RETURN coalesce(allowed, false);
END;
$$;

-- What must still exist before a record can come back from Trash, or what it
-- would clash with that was added while it was away, as a sentence for the
-- person restoring it; null when nothing blocks it.
CREATE OR REPLACE FUNCTION public.trash_restore_blocker(p_table text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  project_gone boolean := false;
  task_gone boolean := false;
  lead_gone boolean := false;
  parent_gone boolean := false;
  payment public.invoice_payments;
  invoice public.project_invoices;
BEGIN
  CASE p_table
    WHEN 'tasks' THEN
      SELECT p.deleted_at IS NOT NULL INTO project_gone
      FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE t.id = p_id;
    WHEN 'task_subtasks', 'task_comments' THEN
      EXECUTE format('SELECT t.deleted_at IS NOT NULL, p.deleted_at IS NOT NULL
        FROM public.%I c JOIN public.tasks t ON t.id = c.task_id JOIN public.projects p ON p.id = t.project_id
        WHERE c.id = $1', p_table)
      INTO task_gone, project_gone USING p_id;
    WHEN 'reminders' THEN
      SELECT coalesce(t.deleted_at IS NOT NULL, false), coalesce(p.deleted_at IS NOT NULL, false)
      INTO task_gone, project_gone
      FROM public.reminders r
      LEFT JOIN public.tasks t ON t.id = r.task_id
      LEFT JOIN public.projects p ON p.id = r.project_id
      WHERE r.id = p_id;
    WHEN 'project_credentials', 'portal_updates', 'project_time_entries', 'project_invoices',
         'project_hourly_rates', 'project_retainers' THEN
      EXECUTE format('SELECT p.deleted_at IS NOT NULL FROM public.%I c
        JOIN public.projects p ON p.id = c.project_id WHERE c.id = $1', p_table)
      INTO project_gone USING p_id;
    WHEN 'portal_update_attachments' THEN
      SELECT u.deleted_at IS NOT NULL INTO parent_gone
      FROM public.portal_update_attachments a JOIN public.portal_updates u ON u.id = a.update_id WHERE a.id = p_id;
      IF parent_gone THEN
        RETURN 'Restore the portal update it belongs to first.';
      END IF;
    WHEN 'invoice_payments' THEN
      SELECT p.deleted_at IS NOT NULL, i.deleted_at IS NOT NULL INTO project_gone, parent_gone
      FROM public.invoice_payments pay
      JOIN public.project_invoices i ON i.id = pay.invoice_id
      JOIN public.projects p ON p.id = i.project_id
      WHERE pay.id = p_id;
      IF parent_gone AND NOT project_gone THEN
        RETURN 'Restore the invoice it belongs to first.';
      END IF;
    WHEN 'project_retainer_amounts' THEN
      SELECT p.deleted_at IS NOT NULL, r.deleted_at IS NOT NULL INTO project_gone, parent_gone
      FROM public.project_retainer_amounts a
      JOIN public.project_retainers r ON r.id = a.retainer_id
      JOIN public.projects p ON p.id = r.project_id
      WHERE a.id = p_id;
      IF parent_gone AND NOT project_gone THEN
        RETURN 'Restore the retainer it belongs to first.';
      END IF;
    WHEN 'entity_files' THEN
      SELECT CASE f.entity_type
          WHEN 'project' THEN EXISTS (SELECT 1 FROM public.projects WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          WHEN 'lead' THEN EXISTS (SELECT 1 FROM public.leads WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          WHEN 'contact' THEN EXISTS (SELECT 1 FROM public.contacts WHERE id = f.entity_id AND deleted_at IS NOT NULL)
          ELSE false
        END
      INTO parent_gone
      FROM public.entity_files f WHERE f.id = p_id;
      IF parent_gone THEN
        RETURN 'Restore the project, lead or contact this file belongs to first.';
      END IF;
    WHEN 'lead_interactions', 'lead_proposals', 'lead_fields' THEN
      EXECUTE format('SELECT l.deleted_at IS NOT NULL FROM public.%I c
        JOIN public.leads l ON l.id = c.lead_id WHERE c.id = $1', p_table)
      INTO lead_gone USING p_id;
    ELSE
      NULL;
  END CASE;
  IF coalesce(project_gone, false) THEN
    RETURN 'Restore the project it belongs to first.';
  ELSIF coalesce(task_gone, false) THEN
    RETURN 'Restore the task it belongs to first.';
  ELSIF coalesce(lead_gone, false) THEN
    RETURN 'Restore the lead it belongs to first.';
  END IF;

  -- Clashes with what was added while it was in Trash.
  CASE p_table
    WHEN 'project_time_entries' THEN
      IF EXISTS (
        SELECT 1 FROM public.project_time_entries entry
        JOIN public.project_time_entries other
          ON other.project_id = entry.project_id AND other.member_id = entry.member_id AND other.id <> entry.id
        WHERE entry.id = p_id AND entry.end_time IS NULL
          AND other.end_time IS NULL AND other.deleted_at IS NULL
      ) THEN
        RETURN 'This timer is still running and a newer one is running on the same project. Stop that one first.';
      END IF;
    WHEN 'project_hourly_rates' THEN
      IF EXISTS (
        SELECT 1 FROM public.project_hourly_rates rate
        JOIN public.project_hourly_rates other
          ON other.project_id = rate.project_id AND other.effective_at = rate.effective_at AND other.id <> rate.id
        WHERE rate.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'Another rate now starts at the same time. Change or delete that one first.';
      END IF;
    WHEN 'project_retainer_amounts' THEN
      IF EXISTS (
        SELECT 1 FROM public.project_retainer_amounts amount
        JOIN public.project_retainer_amounts other
          ON other.retainer_id = amount.retainer_id AND other.effective_date = amount.effective_date AND other.id <> amount.id
        WHERE amount.id = p_id AND other.deleted_at IS NULL
      ) THEN
        RETURN 'Another amount now starts on the same date. Change or delete that one first.';
      END IF;
    WHEN 'invoice_payments' THEN
      SELECT * INTO payment FROM public.invoice_payments WHERE id = p_id;
      SELECT * INTO invoice FROM public.project_invoices WHERE id = payment.invoice_id;
      IF invoice.status NOT IN ('sent', 'overdue', 'paid') THEN
        RETURN 'Its invoice is ' || invoice.status || ' now, so it cannot take a payment.';
      END IF;
      IF payment.amount > public.invoice_total(invoice) - COALESCE((
        SELECT sum(other.amount) FROM public.invoice_payments other
        WHERE other.invoice_id = invoice.id AND other.deleted_at IS NULL
      ), 0) + 0.005 THEN
        RETURN 'Its invoice no longer has enough outstanding for this payment.';
      END IF;
      IF payment.external_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.invoice_payments other
        WHERE other.invoice_id = payment.invoice_id AND other.external_id = payment.external_id
          AND other.deleted_at IS NULL AND other.id <> payment.id
      ) THEN
        RETURN 'This payment was recorded again after it was removed.';
      END IF;
    ELSE
      NULL;
  END CASE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_record(p_table text, p_id uuid, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
  blocker text;
  changed integer;
  found_row boolean;
BEGIN
  IF NOT p_table = ANY (public.trash_record_types()) THEN
    RAISE EXCEPTION 'Trash does not handle %', p_table USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1)', p_table) INTO found_row USING p_id;
  IF NOT found_row THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  blocker := public.trash_restore_blocker(p_table, p_id);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', blocker USING ERRCODE = '55000';
  END IF;
  IF NOT is_service AND NOT public.can_trash_record(p_table, p_id) THEN
    RAISE EXCEPTION 'You do not have permission to restore this' USING ERRCODE = '42501';
  END IF;
  -- Restoring re-runs the record's own rules (an invoice links its hours
  -- and retainer period again); a clash with what happened meanwhile
  -- refuses it, saying why.
  BEGIN
    EXECUTE format('UPDATE public.%I SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL', p_table)
      USING p_id;
    GET DIAGNOSTICS changed = ROW_COUNT;
  EXCEPTION WHEN raise_exception THEN
    RAISE EXCEPTION 'It cannot come back as it was: %', SQLERRM USING ERRCODE = '55000';
  END;
  RETURN changed > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.invoice_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.time_entry_is_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.retainer_is_live(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.time_entry_is_live(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retainer_is_live(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.trash_delete_blocker(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guard_trash() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trash_delete_blocker(text, uuid) TO authenticated, service_role;
