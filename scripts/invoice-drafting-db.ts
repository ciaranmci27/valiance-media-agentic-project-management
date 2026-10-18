/**
 * A real Postgres (PGlite) with what invoice drafting touches: team members,
 * projects, time entries, invoices and their time allocations (from
 * schema.sql), the retainer migration, the invoice save and validation
 * functions, then the drafting migrations under test, each applied twice.
 * auth.role() reads the test.role setting (service_role unless set).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export const RETAINER_MIGRATION = '../supabase/migrations/20260919050750_create_project_retainers.sql';
export const HELD_HOURS_MIGRATION = '../supabase/migrations/20261018172146_invoice_hours_held_by_drafts.sql';
export const UNALLOCATED_HOURS_MIGRATION = '../supabase/migrations/20261018175359_invoice_unallocated_hours_billed.sql';

async function read(path: string) {
  return (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}
export const readSql = read;

export async function createDraftingDatabase(extraMigrations: string[] = []): Promise<PGlite> {
  const db = new PGlite();
  const canonical = await read('../supabase/schema.sql');
  const table = (name: string) => {
    const sql = canonical.match(new RegExp('create table public\\.' + name + ' \\([\\s\\S]*?^\\);', 'mi'))?.[0];
    assert.ok(sql, `table ${name} in schema.sql`);
    return sql;
  };
  const fn = (name: string) => {
    const sql = canonical.match(new RegExp('create or replace function public\\.' + name + '\\([\\s\\S]*?^\\$\\$;', 'mi'))?.[0];
    assert.ok(sql, `function ${name} in schema.sql`);
    return sql;
  };

  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql
      AS $$ SELECT COALESCE(NULLIF(current_setting('test.role', true), ''), 'service_role') $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.team_members (
      id uuid PRIMARY KEY, name text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', role text NOT NULL,
      status text NOT NULL DEFAULT 'active', timezone text NOT NULL DEFAULT 'UTC',
      email_notifications_enabled boolean NOT NULL DEFAULT false,
      email_notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.projects (
      id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active', archived_at timestamptz
    );
    CREATE TABLE public.project_time_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
      member_id uuid, start_time timestamptz NOT NULL, end_time timestamptz,
      segments jsonb NOT NULL DEFAULT '[]'::jsonb, hourly_rate numeric(10,2) NOT NULL DEFAULT 0,
      work_type text NOT NULL DEFAULT 'client', approval_status text NOT NULL DEFAULT 'approved',
      compensation_rate numeric
    );
    CREATE TABLE public.notifications_log (user_id uuid, title text, message text, link text, entity_type text, entity_id text);
    CREATE FUNCTION public.upsert_notification(uuid, text, text, text, text, text) RETURNS void LANGUAGE sql
      AS $$ INSERT INTO public.notifications_log VALUES ($1, $2, $3, $4, $5, $6) $$;
    CREATE FUNCTION public.handle_updated_at() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    CREATE FUNCTION public.current_team_member_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION public.has_permission(text, text DEFAULT 'app') RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION public.can_access_project(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  `);
  for (const name of ['project_invoices', 'invoice_time_entry_allocations', 'team_member_earning_adjustments', 'team_member_payouts']) {
    await db.exec(table(name));
  }
  await db.exec(`
    CREATE TABLE public.team_member_payout_allocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payout_id uuid NOT NULL REFERENCES public.team_member_payouts(id) ON DELETE CASCADE,
      time_entry_id uuid REFERENCES public.project_time_entries(id) ON DELETE RESTRICT,
      adjustment_id uuid REFERENCES public.team_member_earning_adjustments(id) ON DELETE RESTRICT,
      allocated_amount numeric(12,2) NOT NULL CHECK (allocated_amount <> 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (num_nonnulls(time_entry_id, adjustment_id) = 1),
      UNIQUE NULLS NOT DISTINCT (payout_id, time_entry_id, adjustment_id)
    );
  `);
  await db.exec(await read(RETAINER_MIGRATION));
  // The invoice save path as production has it (validate is replaced below).
  await db.exec(fn('validate_invoice_time_allocations'));
  await db.exec(fn('save_project_invoice_with_allocations'));
  for (const path of [HELD_HOURS_MIGRATION, UNALLOCATED_HOURS_MIGRATION, ...extraMigrations]) {
    const sql = await read(path);
    await db.exec(sql);
    await db.exec(sql); // safe to re-run
  }
  // What fake-postgrest's service-role requests need (Supabase grants these).
  await db.exec(`
    GRANT USAGE ON SCHEMA public, auth TO service_role, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth TO service_role;
  `);
  return db;
}
