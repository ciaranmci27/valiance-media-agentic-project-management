/**
 * Soft delete: nothing in the record tables can be permanently deleted,
 * Trash hides a record (and everything under a deleted parent) from every
 * signed-in read, and Restore brings it back exactly as it was. Billing
 * records too: an invoice in Trash frees its hours and tells admin it is
 * gone, restoring it links everything again, and the billing functions and
 * cron jobs skip what is in Trash.
 *
 * Runs on PGlite (real Postgres) over the whole real schema; nothing touches
 * a live database. Also proves schema.sql matches "the schema before this
 * change, plus the migrations", object for object.
 *
 *   npm run -s test:soft-delete
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase } from './full-schema-db';

const MIGRATIONS = ['20261022035227_soft_delete_records.sql', '20261022041249_soft_delete_billing.sql', '20261022044708_trash_audit.sql', '20261022052745_lead_field_keys_live.sql', '20261022053626_list_trash.sql', '20261022063149_soft_delete_review_fixes.sql']
  .map((name) => join(__dirname, '..', 'supabase', 'migrations', name));
/** The schema files as they were before this change (the branch point from main). */
const BASE_REF = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim();
const atBase = (path: string) => execFileSync('git', ['show', `${BASE_REF}:app/supabase/${path}`], { encoding: 'utf8' });

const OWNER_USER = '00000000-0000-0000-0000-0000000000a1';
const MEMBER_USER = '00000000-0000-0000-0000-0000000000a2';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function attempt<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []) {
  try {
    return { rows: (await db.query<T>(sql, params)).rows, error: null as string | null };
  } catch (error) {
    return { rows: [] as T[], error: (error as Error).message };
  }
}

/** Every public object that could differ: columns, policies, functions, triggers, indexes. */
async function catalog(db: PGlite): Promise<string[]> {
  await db.exec('RESET ROLE');
  const lines: string[] = [];
  const add = async (sql: string) => {
    for (const row of (await db.query<{ line: string }>(sql)).rows) lines.push(row.line);
  };
  await add(`SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
    || ' default=' || coalesce(column_default, '') AS line
    FROM information_schema.columns WHERE table_schema = 'public'`);
  await add(`SELECT 'policy ' || tablename || '.' || policyname || ' ' || permissive || ' ' || cmd || ' '
    || array_to_string(roles, ',') || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '') AS line
    FROM pg_policies WHERE schemaname = 'public'`);
  await add(`SELECT 'function ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) AS line
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f'`);
  await add(`SELECT 'trigger ' || pg_get_triggerdef(t.oid) AS line
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
  await add(`SELECT 'index ' || indexdef AS line FROM pg_indexes WHERE schemaname = 'public'`);
  return lines.sort();
}

/** Billing records in Trash: invoices, payments, time, rates, retainers, and the jobs that read them. */
async function billing(db: PGlite, people: { owner: string; member: string }) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const asService = () => actAs(db, null);
  const asOwner = () => actAs(db, OWNER_USER);
  const superuser = () => db.exec('RESET ROLE');
  const today = new Date().toISOString().slice(0, 10);

  await superuser();
  await db.query(`INSERT INTO public.webhook_endpoints (name, url, secret, events) VALUES ('Admin income', 'https://example.test/hook',
    'whsec_x', ARRAY['invoice.paid', 'invoice.updated', 'invoice.deleted', 'invoice.payment_recorded', 'invoice.payment_removed'])`);
  const project = (await q<{ id: string }>(
    "INSERT INTO public.projects (name, client_time_billing) VALUES ('Lilly''s Bubble Tea', 'hourly') RETURNING id"))[0].id;
  const entry = async (startIso: string, hours: number | null) => {
    const end = hours === null ? null : new Date(Date.parse(startIso) + hours * 3600_000).toISOString();
    return (await q<{ id: string }>(`INSERT INTO public.project_time_entries
      (project_id, member_id, start_time, end_time, segments, hourly_rate, approval_status, work_type)
      VALUES ($1, $2, $3, $4, $5::jsonb, 100, $6, 'client')
      RETURNING id`, [project, people.owner, startIso, end, JSON.stringify([{ start: startIso, end }]),
      hours === null ? 'draft' : 'approved']))[0].id;
  };
  const billed = await entry('2026-10-01T16:00:00.000Z', 2);
  const unbilled = await entry('2026-10-02T16:00:00.000Z', 1);
  const events = async (invoice: string) =>
    (await q<{ event_type: string }>('SELECT event_type FROM public.webhook_events WHERE resource_id = $1 ORDER BY sequence', [invoice]))
      .map((row) => row.event_type);
  // Internal (no grants): read as the database owner, the way the drafting functions call it.
  const unbilledIds = async () => {
    await superuser();
    return (await q<{ time_entry_id: string }>(
      'SELECT time_entry_id FROM public.invoice_unbilled_slices($1)', [project])).map((row) => row.time_entry_id);
  };
  const saveInvoice = async (number: string, entryId: string) => {
    await asService();
    const line = { id: `line-${number}`, item_type: 'hourly', amount: 200, description: '2 hours' };
    return (await q<{ id: string }>('SELECT (public.save_project_invoice_with_allocations(NULL, $1::jsonb, $2::jsonb)).id', [
      JSON.stringify({ project_id: project, invoice_number: number, amount: 200, status: 'sent', invoice_type: 'hourly',
        line_items: [line], date: '2026-10-05', due_date: '2999-01-01' }),
      JSON.stringify([{ line_item_id: line.id, time_entry_id: entryId, start_offset_hours: 0, allocated_hours: 2, allocated_amount: 200 }]),
    ]))[0].id;
  };
  const invoice = async (id: string) => {
    await superuser();
    return (await q<{ status: string; deleted_at: string | null }>(
      'SELECT status, deleted_at FROM public.project_invoices WHERE id = $1', [id]))[0];
  };

  const first = await saveInvoice('INV-001', billed);
  await asService();
  const paid = (await q<{ r: { payment: { id: string } } }>(
    `SELECT public.record_invoice_payment($1, '{"amount": 200, "paid_date": "2026-10-06", "recorded_via": "app"}'::jsonb) AS r`, [first]))[0].r;
  check('billing seed: the invoice is paid', (await invoice(first)).status === 'paid');
  check('billed hours are not offered again', JSON.stringify(await unbilledIds()) === JSON.stringify([unbilled]), await unbilledIds());

  // --- Time on an invoice stays ---------------------------------------------
  await asOwner();
  const onInvoice = await attempt(db, "SELECT public.soft_delete_record('project_time_entries', $1)", [billed]);
  check('time on an invoice cannot go to Trash', /on invoice INV-001/.test(onInvoice.error ?? ''), onInvoice);
  await asService();
  const directTime = await attempt(db, 'UPDATE public.project_time_entries SET deleted_at = now() WHERE id = $1', [billed]);
  check('not even by a direct update from the server', /on invoice INV-001/.test(directTime.error ?? ''), directTime);

  // --- An invoice in Trash ----------------------------------------------------
  await asOwner();
  await db.query("SELECT public.soft_delete_record('project_invoices', $1)", [first]);
  check('a paid invoice moved to Trash tells admin it is gone', (await events(first)).at(-1) === 'invoice.deleted', await events(first));
  check('its hours can be billed again', (await unbilledIds()).includes(billed), await unbilledIds());
  check('its payments disappear with it',
    (await q<{ n: number }>('SELECT count(*)::int AS n FROM public.project_invoice_payments($1)', [project]))[0].n === 0);
  await superuser();
  check('but they are untouched underneath',
    (await q<{ n: number }>('SELECT count(*)::int AS n FROM public.invoice_payments WHERE invoice_id = $1 AND deleted_at IS NULL', [first]))[0].n === 1);
  check('and the invoice keeps its status', (await invoice(first)).status === 'paid');

  const second = await saveInvoice('INV-002', billed);
  await asOwner();
  const clash = await attempt(db, "SELECT public.restore_record('project_invoices', $1)", [first]);
  check('it cannot come back while its hours are on another invoice',
    /Some of its hours are on invoice INV-002 now/.test(clash.error ?? ''), clash);
  await asOwner();
  const listedClash = (await q<{ id: string; blocker: string | null }>('SELECT id, blocker FROM public.list_trash()')).find((row) => row.id === first);
  check('and the Trash list says so before anyone tries', /Some of its hours are on invoice INV-002 now/.test(listedClash?.blocker ?? ''), listedClash);
  check('and the refused restore changed nothing', !!(await invoice(first)).deleted_at);
  await db.query("SELECT public.soft_delete_record('project_invoices', $1)", [second]);
  await db.query("SELECT public.restore_record('project_invoices', $1)", [first]);
  check('once that one is gone, it comes back paid', (await invoice(first)).status === 'paid' && !(await invoice(first)).deleted_at);
  check('admin hears it is paid again', (await events(first)).at(-1) === 'invoice.paid', await events(first));
  check('its hours are held again', !(await unbilledIds()).includes(billed), await unbilledIds());
  check('and its payment is back',
    (await q<{ n: number }>('SELECT count(*)::int AS n FROM public.project_invoice_payments($1)', [project]))[0].n === 1);
  const noNumberReuse = await attempt(db, "INSERT INTO public.project_invoices (project_id, invoice_number, date) VALUES ($1, 'INV-002', '2026-10-09')", [project]);
  check('a trashed invoice keeps its number', !!noNumberReuse.error, noNumberReuse);
  await asOwner();
  const suggested = (await q<{ n: string }>('SELECT public.suggest_project_invoice_number($1) AS n', [project]))[0].n;
  await superuser();
  const taken = (await q<{ invoice_number: string }>('SELECT invoice_number FROM public.project_invoices WHERE project_id = $1', [project])).map((row) => row.invoice_number);
  check('the suggested invoice number skips numbers held in Trash', suggested === 'INV-003' && !taken.includes(suggested), { suggested, taken });
  await db.exec('SET ROLE anon');
  const anonSuggest = await attempt(db, 'SELECT public.suggest_project_invoice_number($1)', [project]);
  check('nobody signed out gets a suggestion', !!anonSuggest.error, anonSuggest);

  // --- Payments -------------------------------------------------------------
  await asService();
  await db.query("SELECT public.remove_invoice_payment($1, 'app')", [paid.payment.id]);
  await superuser();
  const removed = (await q<{ deleted_at: string | null }>('SELECT deleted_at FROM public.invoice_payments WHERE id = $1', [paid.payment.id]))[0];
  check('removing a payment moves it to Trash', !!removed?.deleted_at, removed);
  check('the invoice is unpaid again', (await invoice(first)).status === 'sent');
  check('admin hears the payment was removed', (await events(first)).includes('invoice.payment_removed'), await events(first));
  await asService();
  await db.query("SELECT public.restore_record('invoice_payments', $1)", [paid.payment.id]);
  check('restoring the payment pays the invoice again', (await invoice(first)).status === 'paid');
  check('and admin hears it was recorded', (await events(first)).at(-2) === 'invoice.payment_recorded', await events(first));

  // Fixed, so its unallocated amount does not soak up unbilled hours.
  const pinned = (await q<{ id: string }>(`INSERT INTO public.project_invoices (project_id, invoice_number, amount, status, invoice_type, date, due_date)
    VALUES ($1, 'INV-003', 100, 'sent', 'fixed', '2026-10-07', '2999-01-01') RETURNING id`, [project]))[0].id;
  const bank = (await q<{ r: { payment: { id: string } } }>(
    `SELECT public.record_invoice_payment($1, '{"amount": 50, "paid_date": "2026-10-08", "external_id": "bank:9"}'::jsonb) AS r`, [pinned]))[0].r;
  await asOwner();
  const pinnedTrash = await attempt(db, "SELECT public.soft_delete_record('project_invoices', $1)", [pinned]);
  check('an invoice with payments from an accounting connection cannot go to Trash',
    /PAYMENT_RECORDED_ELSEWHERE/.test(pinnedTrash.error ?? ''), pinnedTrash);
  await asService();
  await db.query("SELECT public.remove_invoice_payment($1, 'api')", [bank.payment.id]);
  const again = (await q<{ r: { replayed: boolean } }>(
    `SELECT public.record_invoice_payment($1, '{"amount": 50, "paid_date": "2026-10-08", "external_id": "bank:9"}'::jsonb) AS r`, [pinned]))[0].r;
  check('a removed payment does not block recording it again', again.replayed === false, again);
  const twice = await attempt(db, "SELECT public.restore_record('invoice_payments', $1)", [bank.payment.id]);
  check('and then the removed one cannot come back on top of it', /recorded again/.test(twice.error ?? ''), twice);

  // --- Time entries -----------------------------------------------------------
  const visible = async () => {
    await asOwner();
    return (await q<{ id: string }>("SELECT j->>'id' AS id FROM public.get_accessible_time_entries($1) j", [project])).map((row) => row.id);
  };
  await asOwner();
  await db.query("SELECT public.soft_delete_record('project_time_entries', $1)", [unbilled]);
  check('time moved to Trash leaves the time list', !(await visible()).includes(unbilled));
  check('and is not offered for billing', !(await unbilledIds()).includes(unbilled));
  await asOwner();
  await db.query("SELECT public.restore_record('project_time_entries', $1)", [unbilled]);
  check('restored, it is back in both', (await visible()).includes(unbilled) && (await unbilledIds()).includes(unbilled));

  await superuser();
  const running = await entry(new Date().toISOString(), null);
  await asOwner();
  await db.query("SELECT public.soft_delete_record('project_time_entries', $1)", [running]);
  await superuser();
  await entry(new Date().toISOString(), null);
  await asOwner();
  const twoTimers = await attempt(db, "SELECT public.restore_record('project_time_entries', $1)", [running]);
  check('a running timer in Trash does not block a new one, and cannot come back over it',
    /still running/.test(twoTimers.error ?? ''), twoTimers);

  // --- Rates and retainers ------------------------------------------------------
  await superuser();
  const rate = (await q<{ id: string }>(
    "INSERT INTO public.project_hourly_rates (project_id, hourly_rate, effective_at) VALUES ($1, 150, '2026-01-01') RETURNING id", [project]))[0].id;
  await asOwner();
  await db.query("SELECT public.soft_delete_record('project_hourly_rates', $1)", [rate]);
  await superuser();
  await db.query("INSERT INTO public.project_hourly_rates (project_id, hourly_rate, effective_at) VALUES ($1, 175, '2026-01-01')", [project]);
  await asOwner();
  const sameStart = await attempt(db, "SELECT public.restore_record('project_hourly_rates', $1)", [rate]);
  check('a trashed rate makes room for a new one at the same time, and cannot come back over it',
    /Another rate now starts at the same time/.test(sameStart.error ?? ''), sameStart);

  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
  await asService();
  const retainer = (await q<{ id: string }>('SELECT (public.save_project_retainer(NULL, $1::jsonb)).id', [
    JSON.stringify({ project_id: project, name: 'Monthly care', start_date: monthStart, amount: 500 })]))[0].id;
  // What the retainer job drafts (internal: read as the database owner).
  const due = async () => {
    await superuser();
    return (await q<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.retainer_due_periods_internal(NULL, $1::date) WHERE retainer_id = $2', [today, retainer]))[0].n;
  };
  check('a retainer has periods due', await due() > 0);
  await asOwner();
  await db.query("SELECT public.soft_delete_record('project_retainers', $1)", [retainer]);
  check('a retainer in Trash drafts nothing', await due() === 0);
  await db.query("SELECT public.restore_record('project_retainers', $1)", [retainer]);
  check('restored, its periods are due again', await due() > 0);

  const period = async () => {
    await superuser();
    return (await q<{ status: string; invoice_id: string | null }>(
      'SELECT status, invoice_id FROM public.project_retainer_periods WHERE retainer_id = $1 AND period_start = $2', [retainer, monthStart]))[0];
  };
  await asService();
  const retainerDraft = (await q<{ id: string }>('SELECT (public.generate_retainer_period($1, $2::date)).id', [retainer, monthStart]))[0].id;
  check('a retainer draft holds its period', (await period())?.invoice_id === retainerDraft, await period());
  await asOwner();
  await db.query("SELECT public.soft_delete_record('project_invoices', $1)", [retainerDraft]);
  check('in Trash, it lets the period go (skipped, as deleting did)',
    (await period())?.status === 'skipped' && (await period())?.invoice_id === null, await period());
  await asOwner();
  await db.query("SELECT public.restore_record('project_invoices', $1)", [retainerDraft]);
  check('restored, it holds the period again', (await period())?.status === 'invoiced' && (await period())?.invoice_id === retainerDraft, await period());
  await asOwner();
  await db.query("SELECT public.soft_delete_record('project_invoices', $1)", [retainerDraft]);
  await asService();
  await db.query('SELECT public.generate_retainer_period($1, $2::date)', [retainer, monthStart]);
  await asOwner();
  const periodTaken = await attempt(db, "SELECT public.restore_record('project_invoices', $1)", [retainerDraft]);
  check('it cannot come back once the period is billed again',
    /Its retainer period is on another invoice now/.test(periodTaken.error ?? ''), periodTaken);

  // Restoring a retainer skips the months it spent in Trash, as a pause does.
  await asService();
  const lapsed = (await q<{ id: string }>('SELECT (public.save_project_retainer(NULL, $1::jsonb)).id', [
    JSON.stringify({ project_id: project, name: 'Hosting', start_date: monthStart, amount: 100 })]))[0].id;
  await asOwner();
  await db.query("SELECT public.soft_delete_record('project_retainers', $1)", [lapsed]);
  await superuser();
  await db.query("UPDATE public.project_retainers SET deleted_at = $2::date - 75 WHERE id = $1", [lapsed, today]);
  await asOwner();
  await db.query("SELECT public.restore_record('project_retainers', $1)", [lapsed]);
  await superuser();
  const backBilled = (await q<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.retainer_due_periods_internal(NULL, $1::date) WHERE retainer_id = $2', [today, lapsed]))[0].n;
  const skipped = (await q<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.project_retainer_periods WHERE retainer_id = $1 AND status = 'skipped'", [lapsed]))[0].n;
  check('a restored retainer does not back-bill the months it spent in Trash', skipped > 0 && backBilled < 3, { skipped, backBilled });

  // --- A project in Trash stops its jobs ------------------------------------------
  const earned = async () => {
    await asService();
    return (await q<{ n: number }>(`SELECT count(*)::int AS n FROM jsonb_array_elements(public.billing_earned_work('2026-01-01', $1::date)) row
      WHERE row->>'project_id' = $2`, [today, project]))[0].n;
  };
  await superuser();
  const task = (await q<{ id: string }>(
    "INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Fix the menu prices') RETURNING id", [project]))[0].id;
  await db.query(`INSERT INTO public.reminders (title, owner_id, task_id, remind_on, created_by)
    VALUES ('Ask about the new flavours', $1, $2, $3::date - 1, $1)`, [people.owner, task, today]);
  check('the project has earned work', await earned() > 0);
  await superuser();
  const invoiceEvents = (await q<{ n: number }>("SELECT count(*)::int AS n FROM public.webhook_events WHERE resource_type = 'invoice'"))[0].n;
  await asOwner();
  await db.query("SELECT public.soft_delete_record('projects', $1)", [project]);
  check('a trashed project has no earned work', await earned() === 0);
  check('nor retainer periods due', await due() === 0);
  await superuser();
  check('its due reminders stay quiet', (await q<{ n: number }>('SELECT public.send_due_reminders() AS n'))[0].n === 0);
  check('and its paid invoices stay in admin\'s income (no events)',
    (await q<{ n: number }>("SELECT count(*)::int AS n FROM public.webhook_events WHERE resource_type = 'invoice'"))[0].n === invoiceEvents);
  await asOwner();
  await db.query("SELECT public.restore_record('projects', $1)", [project]);
  check('restored, its work counts again', await earned() > 0 && await due() > 0);
  await superuser();
  check('and its reminder comes due', (await q<{ n: number }>('SELECT public.send_due_reminders() AS n'))[0].n === 1);

  // --- The guard covers billing tables (each has rows by now) ------------------
  const billingTables = ['project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates',
    'project_retainers', 'project_retainer_amounts'];
  for (const table of billingTables) {
    await asService();
    const result = await attempt(db, `DELETE FROM public.${table}`);
    check(`DELETE on ${table} is refused for the service role`, /never permanently deleted/.test(result.error ?? ''), result.error);
  }

  // --- The Trash list ---------------------------------------------------------------
  await asService();
  const everything = await attempt<{ record_type: string; label: string; context: string | null; blocker: string | null }>(db,
    'SELECT record_type, label, context, blocker FROM public.list_trash()');
  check('the Trash list reads every record type', !everything.error, everything.error);
  await asOwner();
  const ownerTrash = (await q<{ record_type: string; id: string; label: string; context: string | null; deleted_by_name: string | null; blocker: string | null }>(
    'SELECT record_type, id, label, context, deleted_by_name, blocker FROM public.list_trash()'));
  const trashedRate = ownerTrash.find((row) => row.id === rate);
  check('it lists what the owner moved to Trash, labelled, with where and who',
    trashedRate?.record_type === 'project_hourly_rates' && /\/hr from/.test(trashedRate.label)
    && trashedRate.context === "Lilly's Bubble Tea" && !!trashedRate.deleted_by_name, trashedRate);
  check('and says what blocks a restore', /Another rate now starts/.test(trashedRate?.blocker ?? ''), trashedRate);
  check('a draft in Trash is listed with its number', ownerTrash.some((row) => row.id === retainerDraft && /^INV-/.test(row.label)));
  await actAs(db, MEMBER_USER);
  const memberTrash = await q<{ id: string }>('SELECT id FROM public.list_trash()');
  check('a member only sees what they could restore', !memberTrash.some((row) => row.id === rate || row.id === retainerDraft), memberTrash.length);

  // --- Permissions ---------------------------------------------------------------
  await actAs(db, MEMBER_USER);
  const memberInvoice = await attempt(db, "SELECT public.soft_delete_record('project_invoices', $1)", [first]);
  check('a member without invoices.manage cannot move an invoice to Trash', /permission/.test(memberInvoice.error ?? ''), memberInvoice);
  await superuser();
}

async function main() {
  // --- The migrations on the schema as it was, each twice ------------------
  const migrated = await createFullSchemaDatabase({ schemaSql: atBase('schema.sql'), agentSchemaSql: atBase('schema_ai_agent.sql') });
  await migrated.exec('RESET ROLE');
  for (const path of MIGRATIONS) {
    await migrated.exec(readFileSync(path, 'utf8'));
    await migrated.exec(readFileSync(path, 'utf8'));
  }
  check('the migrations run twice on the schema before them', true);

  // --- schema.sql says the same thing -------------------------------------
  const db = await createFullSchemaDatabase();
  const [before, after] = [await catalog(migrated), await catalog(db)];
  const onlyMigrated = before.filter((line) => !after.includes(line));
  const onlySchema = after.filter((line) => !before.includes(line));
  check('schema.sql matches the schema before plus the migrations', onlyMigrated.length === 0 && onlySchema.length === 0,
    { onlyMigrated: onlyMigrated.slice(0, 8), onlySchema: onlySchema.slice(0, 8) });

  // --- Seed: an owner, a member on one project ---------------------------
  await db.exec('RESET ROLE');
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES ('${OWNER_USER}', 'owner@example.com'), ('${MEMBER_USER}', 'member@example.com');
  `);
  const ids = (await db.query<{ id: string; auth_user_id: string; role: string }>(
    'SELECT id, auth_user_id, role FROM public.team_members')).rows;
  const owner = ids.find((m) => m.auth_user_id === OWNER_USER)!;
  const member = ids.find((m) => m.auth_user_id === MEMBER_USER)!;
  check('the first signup is the owner, the second a member', owner.role === 'owner' && member.role === 'member', ids);
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'app', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read', 'tasks.manage_assigned',
      'portal.read', 'files.read', 'contacts.read']) AS key`, [member.id]);
  const project = (await db.query<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Plan4TheFuture.com') RETURNING id")).rows[0].id;
  await db.query('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [project, member.id]);
  const task = (await db.query<{ id: string }>(
    "INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'Capture plan domicile state', $2) RETURNING id",
    [project, owner.id])).rows[0].id;
  const otherTask = (await db.query<{ id: string }>(
    "INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Update local delivery wording') RETURNING id", [project])).rows[0].id;
  const comment = (await db.query<{ id: string }>(
    "INSERT INTO public.task_comments (task_id, user_id, text) VALUES ($1, $2, 'Asked Stephanie') RETURNING id",
    [task, member.id])).rows[0].id;
  await db.query("INSERT INTO public.reminders (title, owner_id, task_id, created_by) VALUES ('Follow up on domicile', $1, $2, $1)", [member.id, task]);
  await db.query("INSERT INTO public.portal_updates (project_id, title, content) VALUES ($1, 'Print files sent', '')", [project]);

  const count = async (user: string, table: string) => {
    await actAs(db, user);
    return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;
  };

  // --- The guard -----------------------------------------------------------
  for (const table of ['projects', 'tasks', 'task_comments', 'reminders', 'portal_updates', 'team_members']) {
    for (const who of [null, OWNER_USER]) {
      await actAs(db, who);
      const result = await attempt(db, `DELETE FROM public.${table}`);
      // Signed-in members also lack the DELETE grant on some tables (projects); refused either way.
      check(`DELETE on ${table} is refused for ${who ? 'a signed-in owner' : 'the service role'}`,
        !!result.error && /never permanently deleted|permission denied/.test(result.error), result.error);
    }
  }
  await db.exec('RESET ROLE');
  const superuser = await attempt(db, 'DELETE FROM public.projects');
  check('DELETE is refused even for the database superuser', !!superuser.error, superuser.error);
  const truncate = await attempt(db, 'TRUNCATE public.tasks CASCADE');
  check('TRUNCATE is refused', !!truncate.error, truncate.error);
  check('nothing was lost', (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.tasks')).rows[0].n === 2);

  // --- Moving a task to Trash ----------------------------------------------
  check('the member sees both tasks', await count(MEMBER_USER, 'tasks') === 2);
  await actAs(db, MEMBER_USER);
  const memberDelete = await attempt(db, "SELECT public.soft_delete_record('tasks', $1)", [task]);
  check('a member without tasks.manage_all cannot move a task to Trash', /permission/.test(memberDelete.error ?? ''), memberDelete);
  const directUpdate = await attempt(db, 'UPDATE public.tasks SET deleted_at = now() WHERE id = $1 RETURNING id', [task]);
  check('nor by setting deleted_at directly', !!directUpdate.error || directUpdate.rows.length === 0, directUpdate);

  await actAs(db, OWNER_USER);
  const trashed = await db.query<{ ok: boolean }>("SELECT public.soft_delete_record('tasks', $1) AS ok", [task]);
  check('the owner moves the task to Trash', trashed.rows[0].ok === true);
  const again = await db.query<{ ok: boolean }>("SELECT public.soft_delete_record('tasks', $1) AS ok", [task]);
  check('moving it again changes nothing', again.rows[0].ok === false);
  await db.exec('RESET ROLE');
  const stamped = (await db.query<{ deleted_at: string | null; deleted_by: string | null }>(
    'SELECT deleted_at, deleted_by FROM public.tasks WHERE id = $1', [task])).rows[0];
  check('who and when are stamped', !!stamped.deleted_at && stamped.deleted_by === owner.id, stamped);
  check('the member no longer sees it', await count(MEMBER_USER, 'tasks') === 1);
  check('nor the owner', await count(OWNER_USER, 'tasks') === 1);
  check('its comments are gone with it', await count(MEMBER_USER, 'task_comments') === 0);
  check('and its reminder, even for the reminder\'s owner', await count(MEMBER_USER, 'reminders') === 0);
  await actAs(db, MEMBER_USER);
  const editTrashed = await db.query('UPDATE public.tasks SET title = $2 WHERE id = $1', [task, 'renamed']);
  check('a task in Trash cannot be edited', editTrashed.affectedRows === 0);

  await actAs(db, OWNER_USER);
  await db.query("SELECT public.restore_record('tasks', $1)", [task]);
  check('restored, the member sees it again', await count(MEMBER_USER, 'tasks') === 2);
  check('with its comment', await count(MEMBER_USER, 'task_comments') === 1);
  check('and its reminder', await count(MEMBER_USER, 'reminders') === 1);
  await db.exec('RESET ROLE');
  const restoredRow = (await db.query<{ title: string; deleted_by: string | null }>(
    'SELECT title, deleted_by FROM public.tasks WHERE id = $1', [task])).rows[0];
  check('exactly as it was', restoredRow.title === 'Capture plan domicile state' && restoredRow.deleted_by === null, restoredRow);

  // --- Signed-in reads may check the Trash columns ------------------------------
  await actAs(db, OWNER_USER);
  const columnRead = await attempt(db, 'SELECT id FROM public.projects WHERE id = $1 AND deleted_at IS NULL', [project]);
  check('a signed-in member can filter projects by deleted_at (converting a lead, approving suggestions)', !columnRead.error, columnRead.error);
  await db.exec('RESET ROLE');
  const pings = (await db.query<{ table_name: string; restored: boolean }>(
    'SELECT table_name, restored FROM public.trash_events WHERE record_id = $1 ORDER BY id', [task])).rows;
  check('each Trash move and restore leaves a ping for live sync', pings.length === 2 && pings[0].table_name === 'tasks' && !pings[0].restored && pings[1].restored, pings);

  // --- Who did it is audited ------------------------------------------------
  await db.exec('RESET ROLE');
  const audit = (await db.query<{ method: string; endpoint: string; entity_type: string; team_member_id: string; via: string;
    before_deleted: string | null; after_deleted: string | null }>(
    `SELECT method, endpoint, entity_type, team_member_id, via, before_snapshot->>'deleted_at' AS before_deleted,
       after_snapshot->>'deleted_at' AS after_deleted
     FROM public.api_audit_log WHERE entity_id = $1 ORDER BY timestamp, method DESC`, [task])).rows;
  check('moving to Trash and restoring in the app are both audited', audit.length === 2, audit);
  check('the move: who, what, and the record before and after',
    audit[0]?.method === 'DELETE' && audit[0]?.entity_type === 'task' && audit[0]?.team_member_id === owner.id
    && audit[0]?.via === 'app' && audit[0]?.before_deleted === null && !!audit[0]?.after_deleted, audit[0]);
  check('the restore', audit[1]?.method === 'POST' && /\/restore$/.test(audit[1]?.endpoint ?? '') && audit[1]?.after_deleted === null, audit[1]);

  // --- Comments: their author may delete them ------------------------------
  await actAs(db, MEMBER_USER);
  const ownComment = await attempt(db, "SELECT public.soft_delete_record('task_comments', $1)", [comment]);
  check('a member moves their own comment to Trash', !ownComment.error, ownComment);
  check('and it is gone for them', await count(MEMBER_USER, 'task_comments') === 0);

  // --- A whole project -------------------------------------------------------
  await actAs(db, OWNER_USER);
  await db.query("SELECT public.soft_delete_record('projects', $1)", [project]);
  check('a deleted project disappears for the member', await count(MEMBER_USER, 'projects') === 0);
  check('and for the owner', await count(OWNER_USER, 'projects') === 0);
  check('its tasks go with it', await count(MEMBER_USER, 'tasks') === 0 && await count(OWNER_USER, 'tasks') === 0);
  check('its portal updates go with it', await count(OWNER_USER, 'portal_updates') === 0);
  check('its member list goes with it', await count(MEMBER_USER, 'project_members') === 0);
  await db.exec('RESET ROLE');
  const untouched = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.tasks WHERE deleted_at IS NULL')).rows[0].n;
  check('its tasks are hidden, not stamped (restore brings them back as they were)', untouched === 2, untouched);

  await actAs(db, OWNER_USER);
  const intoDeleted = await attempt(db, "INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Sneak') RETURNING id", [project]);
  check('no new task can be added to a deleted project', !!intoDeleted.error, intoDeleted);
  await db.query("SELECT public.soft_delete_record('tasks', $1)", [otherTask]).catch(() => undefined);
  await db.exec('RESET ROLE');
  await db.query("UPDATE public.tasks SET deleted_at = now() WHERE id = $1", [otherTask]);
  await actAs(db, OWNER_USER);
  const blocked = await attempt(db, "SELECT public.restore_record('tasks', $1)", [otherTask]);
  check('a task cannot come back before its project', /Restore the project it belongs to first/.test(blocked.error ?? ''), blocked);

  await db.query("SELECT public.restore_record('projects', $1)", [project]);
  check('restoring the project brings it back', await count(MEMBER_USER, 'projects') === 1);
  check('with the tasks that were not deleted on their own', await count(MEMBER_USER, 'tasks') === 1);
  check('and its portal updates', await count(OWNER_USER, 'portal_updates') === 1);
  await db.query("SELECT public.restore_record('tasks', $1)", [otherTask]);
  check('then the task deleted on its own can come back too', await count(MEMBER_USER, 'tasks') === 2);

  // --- Server routes (service role) pass the acting member ----------------
  await actAs(db, null);
  const viaService = await db.query<{ ok: boolean }>("SELECT public.soft_delete_record('tasks', $1, $2) AS ok", [otherTask, member.id]);
  check('the service role moves a record to Trash for a member', viaService.rows[0].ok === true);
  const stampedByService = (await db.query<{ deleted_by: string }>('SELECT deleted_by FROM public.tasks WHERE id = $1', [otherTask])).rows[0];
  check('stamped with that member', stampedByService.deleted_by === member.id, stampedByService);
  await db.exec('RESET ROLE');
  const serviceAudit = (await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.api_audit_log WHERE entity_id = $1 AND method = 'DELETE'", [otherTask])).rows[0].n;
  check('server routes log their own audit rows (the database writes none for them)', serviceAudit === 0, serviceAudit);
  await actAs(db, null);
  const unknown = await attempt(db, "SELECT public.soft_delete_record('api_keys', $1)", [otherTask]);
  check('Trash only handles record tables', /does not handle/.test(unknown.error ?? ''), unknown);
  const missing = await attempt(db, "SELECT public.soft_delete_record('tasks', gen_random_uuid())");
  check('a missing record says so', /not found/.test(missing.error ?? ''), missing);

  // --- A blocker in Trash blocks nothing ----------------------------------------
  await db.exec('RESET ROLE');
  const [blocker, dependent] = (await db.query<{ id: string }>(
    "INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Get the logo files'), ($1, 'Build the header') RETURNING id", [project])).rows.map((r) => r.id);
  await db.query('INSERT INTO public.task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [dependent, blocker]);
  check('a live blocker is a dependency', await count(OWNER_USER, 'task_dependencies') === 1);
  await actAs(db, OWNER_USER);
  await db.query("SELECT public.soft_delete_record('tasks', $1)", [blocker]);
  check('a blocker in Trash blocks nothing (deleting it used to remove the dependency)', await count(OWNER_USER, 'task_dependencies') === 0);
  await actAs(db, OWNER_USER);
  await db.query("SELECT public.restore_record('tasks', $1)", [blocker]);
  check('restored, it blocks again', await count(OWNER_USER, 'task_dependencies') === 1);

  // --- A lead field in Trash does not block setting it again ----------------------
  await db.exec('RESET ROLE');
  const lead = (await db.query<{ id: string }>("INSERT INTO public.leads (name) VALUES ('Mike''s Bikes') RETURNING id")).rows[0].id;
  // As the app does: change the live field, or add it.
  const setField = async (value: string) => {
    await actAs(db, OWNER_USER);
    const updated = await db.query<{ id: string }>(
      "UPDATE public.lead_fields SET value = $2 WHERE lead_id = $1 AND field_key = 'budget' AND deleted_at IS NULL RETURNING id", [lead, value]);
    if (updated.rows.length) return { id: updated.rows[0].id, error: null as string | null };
    const inserted = await attempt<{ id: string }>(db,
      "INSERT INTO public.lead_fields (lead_id, field_key, value) VALUES ($1, 'budget', $2) RETURNING id", [lead, value]);
    return { id: inserted.rows[0]?.id, error: inserted.error };
  };
  const firstField = await setField('$10k');
  await actAs(db, OWNER_USER);
  await db.query("SELECT public.soft_delete_record('lead_fields', $1)", [firstField.id]);
  const secondField = await setField('$20k');
  check('a field in Trash does not block setting it again', !secondField.error && secondField.id !== firstField.id, secondField);
  await actAs(db, OWNER_USER);
  const fieldClash = await attempt(db, "SELECT public.restore_record('lead_fields', $1)", [firstField.id]);
  check('and the trashed one cannot come back over the new one', /set again since/.test(fieldClash.error ?? ''), fieldClash);

  // --- A rejected time entry stays rejected through Trash -------------------------
  await db.exec('RESET ROLE');
  await db.query("INSERT INTO public.team_member_hourly_rates (member_id, hourly_rate, effective_at) VALUES ($1, 20, '2026-01-01')", [member.id]);
  const rejected = (await db.query<{ id: string }>(`INSERT INTO public.project_time_entries (project_id, member_id, start_time, end_time, segments)
    VALUES ($1, $2, '2026-10-01T16:00:00Z', '2026-10-01T18:00:00Z', '[{"start":"2026-10-01T16:00:00Z","end":"2026-10-01T18:00:00Z"}]') RETURNING id`,
    [project, member.id])).rows[0].id;
  await db.query("UPDATE public.project_time_entries SET approval_status = 'rejected', rejection_reason = 'Wrong project' WHERE id = $1", [rejected]);
  await actAs(db, null);
  await db.query("SELECT public.soft_delete_record('project_time_entries', $1, $2)", [rejected, member.id]);
  await db.query("SELECT public.restore_record('project_time_entries', $1)", [rejected]);
  await db.exec('RESET ROLE');
  const stillRejected = (await db.query<{ approval_status: string; rejection_reason: string | null }>(
    'SELECT approval_status, rejection_reason FROM public.project_time_entries WHERE id = $1', [rejected])).rows[0];
  check('a rejected time entry comes back from Trash still rejected, with its reason',
    stillRejected.approval_status === 'rejected' && stillRejected.rejection_reason === 'Wrong project', stillRejected);

  // --- A primary client in Trash gives up the slot ----------------------------------
  await db.exec('RESET ROLE');
  const [oldClient, newClient] = (await db.query<{ id: string }>(
    "INSERT INTO public.contacts (name, email) VALUES ('Old Client', 'old@client.example'), ('New Client', 'new@client.example') RETURNING id")).rows.map((r) => r.id);
  await db.query("INSERT INTO public.project_contacts (project_id, contact_id, role, is_primary_client) VALUES ($1, $2, 'Client', true)", [project, oldClient]);
  await actAs(db, OWNER_USER);
  await db.query("SELECT public.soft_delete_record('contacts', $1)", [oldClient]);
  const newPrimary = await attempt(db, "INSERT INTO public.project_contacts (project_id, contact_id, role, is_primary_client) VALUES ($1, $2, 'Client', true) RETURNING id", [project, newClient]);
  check('a new primary client can be set while the old one is in Trash', !newPrimary.error, newPrimary.error);

  // --- Converting a lead never makes a contact in Trash the client ------------------
  await db.exec('RESET ROLE');
  const goneContact = (await db.query<{ id: string }>("INSERT INTO public.contacts (name, email) VALUES ('Gone', 'gone@x.example') RETURNING id")).rows[0].id;
  const convertible = (await db.query<{ id: string }>("INSERT INTO public.leads (name, contact_id) VALUES ('Sunrise Dental', $1) RETURNING id", [goneContact])).rows[0].id;
  await actAs(db, null);
  await db.query("SELECT public.soft_delete_record('contacts', $1)", [goneContact]);
  const converted = (await db.query<{ r: { contact_id: string } }>("SELECT public.convert_lead($1, 'Sunrise Dental site', '#000000', '', NULL) AS r", [convertible])).rows[0].r;
  check('converting a lead whose contact is in Trash makes a fresh client contact', converted.contact_id !== goneContact, converted);

  // --- Audit rows leave out secrets ---------------------------------------------------
  await db.exec('RESET ROLE');
  const secret = (await db.query<{ id: string }>("INSERT INTO public.project_credentials (project_id, label, encrypted_data, iv) VALUES ($1, 'Hosting', 'cipher', 'nonce') RETURNING id", [project])).rows[0].id;
  await actAs(db, OWNER_USER);
  await db.query("SELECT public.soft_delete_record('project_credentials', $1)", [secret]);
  await db.exec('RESET ROLE');
  const secretAudit = (await db.query<{ snapshot: Record<string, unknown> }>('SELECT before_snapshot AS snapshot FROM public.api_audit_log WHERE entity_id = $1', [secret])).rows[0];
  check('a Trash audit row leaves out credential secrets', !!secretAudit && !('encrypted_data' in secretAudit.snapshot) && !('iv' in secretAudit.snapshot) && secretAudit.snapshot.label === 'Hosting', secretAudit);

  await billing(db, { owner: owner.id, member: member.id });

  console.log(`soft delete: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.log(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
