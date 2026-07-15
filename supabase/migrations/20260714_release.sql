-- ============================================================
-- 2026-07-14 release: security + credentials rework
-- Combines three migrations so prod can apply them in one shot:
--   1. SMTP accounts RLS restricted to admins (new is_admin() helper)
--   2. Atomic lead conversion RPC (convert_lead) with double-convert guard
--   3. Credential category consolidation + credit_card / ach types
-- Safe to re-run: every statement is guarded or create-or-replace.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Restrict smtp_accounts to admins only.
--    Previously any authenticated user could read/write SMTP credentials.
-- ────────────────────────────────────────────────────────────

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where auth_user_id = auth.uid() and role = 'admin'
  );
$$;

drop policy if exists "smtp_accounts_all" on public.smtp_accounts;
drop policy if exists "smtp_accounts_admin_only" on public.smtp_accounts;

create policy "smtp_accounts_admin_only" on public.smtp_accounts
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ────────────────────────────────────────────────────────────
-- 2. Atomic lead conversion.
--    Previously conversion was six sequential client-side writes with no
--    transaction and no guard against converting an already-won lead, which
--    could produce duplicate projects/contacts on retry. This RPC does the
--    whole conversion in one transaction, locks the lead row, and rejects
--    double conversion.
-- ────────────────────────────────────────────────────────────

create or replace function public.convert_lead(
  p_lead_id uuid,
  p_project_name text,
  p_project_color text,
  p_project_description text,
  p_created_by uuid
) returns jsonb
language plpgsql
as $$
declare
  v_lead public.leads%rowtype;
  v_contact_id uuid;
  v_project_id uuid;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  if v_lead.status = 'won' then
    -- Custom errcode so the API can map this to 409 without colliding with
    -- P0001, the default code every unqualified `raise exception` uses
    raise exception 'Lead has already been converted' using errcode = 'LC409';
  end if;

  -- Reuse existing contact if the lead has one, otherwise create one
  v_contact_id := v_lead.contact_id;
  if v_contact_id is null then
    insert into public.contacts (name, email, phone, company, color, created_by)
    values (v_lead.name, v_lead.email, v_lead.phone, v_lead.company, p_project_color, p_created_by)
    returning id into v_contact_id;
  end if;

  insert into public.projects (name, description, color, status, created_by)
  values (p_project_name, p_project_description, p_project_color, 'active', p_created_by)
  returning id into v_project_id;

  -- Primary client
  insert into public.project_contacts (project_id, contact_id, role, is_primary_client)
  values (v_project_id, v_contact_id, 'Client', true);

  -- Copy additional (non-primary) lead contacts
  insert into public.project_contacts (project_id, contact_id, role, custom_role, is_primary_client)
  select v_project_id, lc.contact_id, lc.role, lc.custom_role, false
  from public.lead_contacts lc
  where lc.lead_id = p_lead_id and lc.is_primary_client = false
  on conflict (project_id, contact_id) do nothing;

  -- Copy lead members to project members
  insert into public.project_members (project_id, member_id)
  select v_project_id, lm.member_id
  from public.lead_members lm
  where lm.lead_id = p_lead_id
  on conflict (project_id, member_id) do nothing;

  update public.leads set status = 'won', contact_id = v_contact_id where id = p_lead_id;

  return jsonb_build_object('project_id', v_project_id, 'contact_id', v_contact_id);
end;
$$;

-- The function runs with the caller's privileges (RLS applies), but keep the
-- PostgREST /rpc surface closed to anonymous callers regardless.
revoke execute on function public.convert_lead(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.convert_lead(uuid, text, text, text, uuid) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 3. Consolidate credential categories and add payment types.
--    Every category now has its own input fields (see lib/credential-fields.ts).
--    hosting/cms/ftp/dns/email/other were all just username+password+url, so
--    they collapse into 'login'; credit_card and ach are new.
-- ────────────────────────────────────────────────────────────

-- Drop existing category check constraints by lookup rather than by name, in
-- case the live table's auto-generated constraint name differs. Loops so a
-- stray second category check can't survive and reject the new values.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname
    from pg_constraint
    where conrelid = 'public.project_credentials'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%category%'
  loop
    execute format('alter table public.project_credentials drop constraint %I', v_name);
  end loop;
end $$;

update public.project_credentials
  set category = 'login'
  where category in ('hosting', 'cms', 'ftp', 'dns', 'email', 'other');

alter table public.project_credentials
  add constraint project_credentials_category_check
  check (category in ('login', 'api_key', 'ssh_key', 'database', 'credit_card', 'ach'));
