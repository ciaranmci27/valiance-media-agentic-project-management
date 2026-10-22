/**
 * The invoice drafting database (invoice-drafting-db.ts) plus what invoice
 * payments touch: the webhook outbox and its invoice triggers, API keys and
 * the invoice RLS policies from schema.sql. `beforePayments` runs before the
 * payments migration, so a test can seed invoices the backfill must find.
 * The payments migration is applied twice (it must be safe to re-run).
 */
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createDraftingDatabase, readSql } from './invoice-drafting-db';

export const PAYMENTS_MIGRATION = '../supabase/migrations/20261018205406_invoice_payments.sql';

export async function createPaymentsDatabase(options: {
  beforePayments?: (db: PGlite) => Promise<void>;
  extraMigrations?: string[];
  /** Apply the Invoice payments section of schema.sql instead of the migration. */
  fromSchema?: boolean;
  /**
   * Also the Trash pieces an invoice DELETE runs through (soft_delete_record
   * and the guard that refuses an invoice pinned by connection payments),
   * from schema.sql. Needs fromSchema, so the payments are the current ones.
   */
  softDelete?: boolean;
} = {}): Promise<PGlite> {
  const db = await createDraftingDatabase();
  const canonical = await readSql('../supabase/schema.sql');
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
    ALTER TABLE public.projects ADD COLUMN billing_email text,
      ADD COLUMN client_time_billing text NOT NULL DEFAULT 'hourly', ADD COLUMN tax_rate numeric(5,2);
    CREATE SEQUENCE IF NOT EXISTS public.webhook_event_seq;
  `);
  for (const name of ['contacts', 'project_contacts', 'api_keys', 'webhook_endpoints', 'webhook_events', 'webhook_deliveries']) {
    await db.exec(table(name));
  }
  // The API reads these columns of a key; schema.sql adds them by ALTER.
  await db.exec(`ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS team_member_id uuid,
    ADD COLUMN IF NOT EXISTS scopes text[], ADD COLUMN IF NOT EXISTS expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
    DROP CONSTRAINT IF EXISTS api_keys_permissions_check,
    ADD CONSTRAINT api_keys_permissions_check CHECK (permissions IN ('full', 'read_only', 'scoped'))`);
  for (const name of ['invoice_net_amounts', 'emit_invoice_webhook_event', 'emit_invoice_webhook', 'emit_invoice_webhook_for_shares', 'webhook_payload_for_endpoint', 'claim_webhook_deliveries']) {
    await db.exec(fn(name));
  }
  await db.exec(`
    CREATE TRIGGER emit_invoice_webhook AFTER INSERT OR UPDATE OR DELETE ON public.project_invoices
      FOR EACH ROW EXECUTE FUNCTION public.emit_invoice_webhook();
    CREATE TRIGGER emit_invoice_webhook_shares_insert AFTER INSERT ON public.invoice_line_shares
      REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.emit_invoice_webhook_for_shares();
    CREATE TRIGGER emit_invoice_webhook_shares_delete AFTER DELETE ON public.invoice_line_shares
      REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.emit_invoice_webhook_for_shares();
    CREATE TRIGGER set_project_invoices_updated_at BEFORE UPDATE ON public.project_invoices
      FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
    CREATE TABLE IF NOT EXISTS public.role_permissions (
      role text NOT NULL, permission_key text NOT NULL, access_channel text NOT NULL,
      PRIMARY KEY (role, permission_key, access_channel)
    );
    -- The invoice policies production has (has_permission and project access are stubbed true).
    ALTER TABLE public.project_invoices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY invoices_select ON public.project_invoices FOR SELECT TO authenticated
      USING (public.has_permission('invoices.read') AND public.can_access_project(project_id));
    CREATE POLICY invoices_manage ON public.project_invoices FOR ALL TO authenticated
      USING (public.has_permission('invoices.manage') AND public.can_access_project(project_id))
      WITH CHECK (public.has_permission('invoices.manage') AND public.can_access_project(project_id));
    GRANT ALL ON public.project_invoices, public.invoice_line_shares TO authenticated;
    GRANT SELECT ON public.team_member_share_earnings, public.projects TO authenticated;
  `);

  if (options.beforePayments) await options.beforePayments(db);
  if (options.fromSchema) {
    // From its header to the next section header (or the end of the file).
    const start = canonical.indexOf('-- Invoice payments: each payment recorded');
    assert.ok(start > 0, 'Invoice payments section in schema.sql');
    const next = canonical.indexOf('\n-- ---------------------------------------------------------------------------\n-- ', start + 400);
    await db.exec(canonical.slice(start, next < 0 ? undefined : next));
  }
  for (const path of [...(options.fromSchema ? [] : [PAYMENTS_MIGRATION]), ...(options.extraMigrations ?? [])]) {
    const sql = await readSql(path);
    await db.exec(sql);
    await db.exec(sql); // safe to re-run
  }
  if (options.softDelete) {
    assert.ok(options.fromSchema, 'softDelete needs fromSchema');
    // After the extra migrations: an older one may bring back a pre-Trash
    // invoice_payment_totals, which would count payments in Trash.
    for (const name of ['trash_record_types', 'trash_delete_blocker', 'guard_trash', 'soft_delete_record', 'invoice_payment_totals']) {
      await db.exec(fn(name));
    }
    await db.exec(`CREATE TRIGGER guard_trash BEFORE UPDATE OF deleted_at ON public.project_invoices
      FOR EACH ROW EXECUTE FUNCTION public.guard_trash();`);
  }
  await db.exec(`
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth TO service_role;
  `);
  return db;
}

/** Runs work as a signed-in member (authenticated role, RLS on). */
export async function asMember<T>(db: PGlite, work: () => Promise<T>): Promise<T> {
  await db.exec("SET ROLE authenticated; SET test.role = 'authenticated';");
  try {
    return await work();
  } finally {
    await db.exec("RESET ROLE; SET test.role = '';");
  }
}
