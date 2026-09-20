-- Webhook endpoints choose which amounts they receive: gross (what the client
-- was billed) or net (what is left after revenue splits).
--
-- The split never enters webhook_events.payload. Each event carries a separate
-- net_amounts snapshot, and claim_webhook_deliveries shapes the body per
-- endpoint at delivery time, so one invoice event can go out gross to one
-- endpoint and net to another. A gross endpoint never sees a net figure.
--
-- Safe to re-run.

alter table public.webhook_endpoints
  add column if not exists amount_basis text not null default 'gross';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.webhook_endpoints'::regclass
      and conname = 'webhook_endpoints_amount_basis_check'
  ) then
    alter table public.webhook_endpoints
      add constraint webhook_endpoints_amount_basis_check check (amount_basis in ('gross', 'net'));
  end if;
end;
$$;

-- { "amount": n, "totals_by_type": {..}, "line_items": { "<line id>": n } }
alter table public.webhook_events
  add column if not exists net_amounts jsonb;

-- What the company keeps of an invoice after revenue splits. Only fixed and
-- recurring lines can carry a split; every other line is its full amount.
create or replace function public.invoice_net_amounts(p_invoice public.project_invoices)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lines jsonb := coalesce(nullif(p_invoice.line_items, 'null'::jsonb), '[]'::jsonb);
  v_result jsonb;
begin
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) = 0 then
    return jsonb_build_object(
      'amount', p_invoice.amount,
      'totals_by_type', jsonb_build_object(p_invoice.invoice_type, p_invoice.amount),
      'line_items', '{}'::jsonb
    );
  end if;

  with net_lines as (
    select
      li->>'id' as line_id,
      li->>'item_type' as item_type,
      round(
        (li->>'amount')::numeric * (1 - least(100, coalesce((
          select sum(share.percent)
          from public.invoice_line_shares share
          where share.invoice_id = p_invoice.id
            and share.line_item_id = li->>'id'
            and li->>'item_type' in ('fixed', 'recurring')
        ), 0)) / 100),
        2
      ) as net_amount
    from jsonb_array_elements(v_lines) li
  )
  select jsonb_build_object(
    'amount', coalesce(sum(net_amount), 0),
    'totals_by_type', coalesce((
      select jsonb_object_agg(t.item_type, t.subtotal)
      from (
        select item_type, sum(net_amount) as subtotal
        from net_lines where item_type is not null group by item_type
      ) t
    ), '{}'::jsonb),
    'line_items', coalesce(jsonb_object_agg(line_id, net_amount) filter (where line_id is not null), '{}'::jsonb)
  )
  into v_result
  from net_lines;

  return v_result;
end;
$$;

-- The event writer, split out of the trigger so a split change on a paid
-- invoice can announce itself too (see emit_invoice_webhook_for_shares).
create or replace function public.emit_invoice_webhook_event(
  p_row public.project_invoices,
  p_event_type text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_paid boolean := (p_event_type <> 'invoice.deleted' and p_row.status = 'paid');
  v_project_name text;
  v_totals jsonb;
  v_public_id text;
  v_seq bigint;
  v_event_uuid uuid;
  v_payload jsonb;
begin
  if not exists (
    select 1 from public.webhook_endpoints e
    where e.is_active and p_event_type = any(e.events)
  ) then
    return;
  end if;

  select name into v_project_name
  from public.projects where id = p_row.project_id;

  select coalesce(jsonb_object_agg(t.item_type, t.subtotal), '{}'::jsonb)
    into v_totals
  from (
    select li->>'item_type' as item_type, sum((li->>'amount')::numeric) as subtotal
    from jsonb_array_elements(
           coalesce(nullif(p_row.line_items, 'null'::jsonb), '[]'::jsonb)
         ) li
    where li ? 'item_type'
    group by li->>'item_type'
  ) t;

  if v_totals = '{}'::jsonb then
    v_totals := jsonb_build_object(p_row.invoice_type, p_row.amount);
  end if;

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
        'name', coalesce(v_project_name, '')
      ),
      'line_items', coalesce(nullif(p_row.line_items, 'null'::jsonb), '[]'::jsonb),
      'totals_by_type', v_totals
    )
  );

  insert into public.webhook_events (
    event_id, sequence, event_type, resource_type, resource_id, payload, net_amounts
  )
  values (
    v_public_id, v_seq, p_event_type, 'invoice', p_row.id, v_payload,
    public.invoice_net_amounts(p_row)
  )
  returning id into v_event_uuid;

  insert into public.webhook_deliveries (webhook_event_id, endpoint_id)
  select v_event_uuid, e.id
  from public.webhook_endpoints e
  where e.is_active and p_event_type = any(e.events);
end;
$$;

-- Same rules as before for when an invoice change is worth an event.
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

-- A split added, changed or removed on a paid invoice changes its net amounts
-- without touching project_invoices, so it has to raise its own event.
-- Statement-level with a transition table: one event per invoice, however many
-- split rows moved.
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
      and invoice.id in (select distinct invoice_id from changed_rows)
  loop
    perform public.emit_invoice_webhook_event(v_invoice, 'invoice.updated');
  end loop;
  return null;
end;
$$;

drop trigger if exists emit_invoice_webhook_shares_insert on public.invoice_line_shares;
create trigger emit_invoice_webhook_shares_insert
  after insert on public.invoice_line_shares
  referencing new table as changed_rows
  for each statement execute function public.emit_invoice_webhook_for_shares();

drop trigger if exists emit_invoice_webhook_shares_update on public.invoice_line_shares;
create trigger emit_invoice_webhook_shares_update
  after update on public.invoice_line_shares
  referencing new table as changed_rows
  for each statement execute function public.emit_invoice_webhook_for_shares();

drop trigger if exists emit_invoice_webhook_shares_delete on public.invoice_line_shares;
create trigger emit_invoice_webhook_shares_delete
  after delete on public.invoice_line_shares
  referencing old table as changed_rows
  for each statement execute function public.emit_invoice_webhook_for_shares();

-- The body one endpoint receives. amount_basis is always stated. For a net
-- endpoint the invoice amount, each line amount and totals_by_type are the
-- company's part; the gross figures are not sent alongside, so a receiver
-- cannot mix the two.
create or replace function public.webhook_payload_for_endpoint(
  p_payload jsonb,
  p_net jsonb,
  p_basis text
)
returns jsonb
language sql
immutable
as $$
  select case
    when p_basis = 'net' and p_net is not null and p_payload ? 'data' then
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(p_payload, '{data,amount_basis}', '"net"'::jsonb),
            '{data,invoice,amount}', p_net->'amount'
          ),
          '{data,totals_by_type}', p_net->'totals_by_type'
        ),
        '{data,line_items}',
        coalesce((
          select jsonb_agg(
            case when (p_net->'line_items') ? (li.value->>'id')
              then li.value || jsonb_build_object('amount', p_net->'line_items'->(li.value->>'id'))
              else li.value end
            order by li.ordinality
          )
          from jsonb_array_elements(p_payload->'data'->'line_items') with ordinality as li(value, ordinality)
        ), '[]'::jsonb)
      )
    when p_payload ? 'data' then
      jsonb_set(p_payload, '{data,amount_basis}', '"gross"'::jsonb)
    else p_payload
  end
$$;

create or replace function public.claim_webhook_deliveries(p_limit int default 20)
returns table (
  delivery_id uuid,
  attempts int,
  endpoint_id uuid,
  endpoint_url text,
  endpoint_secret text,
  event_public_id text,
  event_type text,
  payload jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select d2.id
    from public.webhook_deliveries d2
    join public.webhook_endpoints e2 on e2.id = d2.endpoint_id
    where d2.status = 'pending'
      and e2.is_active
    order by d2.created_at
    for update of d2 skip locked
    limit p_limit
  )
  update public.webhook_deliveries d
  set status = 'delivering',
      attempts = d.attempts + 1,
      last_attempt_at = now()
  from claimed, public.webhook_events ev, public.webhook_endpoints e
  where d.id = claimed.id
    and ev.id = d.webhook_event_id
    and e.id = d.endpoint_id
  returning d.id, d.attempts,
            e.id, e.url, e.secret,
            ev.event_id, ev.event_type,
            public.webhook_payload_for_endpoint(ev.payload, ev.net_amounts, e.amount_basis);
end;
$$;

revoke all on function public.invoice_net_amounts(public.project_invoices) from public, anon, authenticated;
revoke all on function public.emit_invoice_webhook_event(public.project_invoices, text) from public, anon, authenticated;
revoke all on function public.emit_invoice_webhook_for_shares() from public, anon, authenticated;
revoke all on function public.webhook_payload_for_endpoint(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.claim_webhook_deliveries(int) from public;
grant execute on function public.claim_webhook_deliveries(int) to service_role;
