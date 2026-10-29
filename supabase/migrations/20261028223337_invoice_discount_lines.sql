-- Discount lines: a fixed or recurring line may be negative (a discount the
-- client sees on the invoice). A discount never carries a split, so it comes
-- out of the company's share and a split member still earns their percent of
-- the full line it discounts. sync_invoice_share_earnings already ignores
-- non-positive lines; the net amounts webhooks send now match it.

-- What the company keeps of an invoice after revenue splits. Only positive
-- fixed and recurring lines can carry a split; every other line, discounts
-- included, is its full amount.
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
            and (li->>'amount')::numeric > 0
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

revoke all on function public.invoice_net_amounts(public.project_invoices) from public, anon, authenticated;
