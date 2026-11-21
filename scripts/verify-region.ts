/**
 * The workspace region (Settings > Workspace > Region):
 *
 * - One formatter for money: the workspace currency and locale by default, a
 *   record's own currency when passed, no decimals from 1,000 up, the
 *   currency's decimals below only when there are any, none ever for JPY.
 * - In the database: one row every signed-in member reads and only Owners
 *   write; the migration re-runs safely; invoices, retainers and billing
 *   plans are stamped with the workspace currency when made and keep it
 *   after the workspace changes; existing rows are backfilled to USD.
 * - format_money() in SQL writes what formatMoney writes, so activity lines,
 *   Trash labels and billing notices match the app.
 * - The server read tolerates a database without the table (1.7.0's code
 *   running before its migration) or without newer columns.
 *
 * Runs on PGlite over the whole real schema. Nothing touches a live database.
 *
 *   npm run -s test:region
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, schemaAt, schemaBeforeMigration } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import {
  excludedNote,
  formatHours,
  formatMoney,
  formatMoneyCompact,
  formatMoneyExact,
  moneyAffix,
  moneyFormatPattern,
  sumByCurrency,
  totalInCurrency,
} from '../src/lib/format';
import { setActiveRegion } from '../src/lib/region/active';
import { DEFAULT_REGION, parseRegionInput, rowToRegion, startOfWeek } from '../src/lib/region';

const MIGRATION = '20261121070000_workspace_region.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
const NBSP = ' ';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}
function same(label: string, actual: unknown, expected: unknown) {
  check(label, actual === expected, { actual, expected });
}

function formatter() {
  const usd = { currency: 'USD', locale: 'en-US' };
  same('usd: whole dollars', formatMoney(1500, usd), '$1,500');
  same('usd: cents below 1,000', formatMoney(12.5, usd), '$12.50');
  same('usd: no cents when there are none', formatMoney(12, usd), '$12');
  same('usd: a negative amount', formatMoney(-80, usd), '-$80');
  same('usd: nothing is never minus', formatMoney(-0.001, usd), '$0');
  same('threshold: 999.99 keeps its cents', formatMoney(999.99, usd), '$999.99');
  same('threshold: 1,000 has none', formatMoney(1000, usd), '$1,000');
  same('threshold: 1,000.50 rounds to whole', formatMoney(1000.5, usd), '$1,001');
  same('threshold: 999.996 rounds to 1,000', formatMoney(999.996, usd), '$1,000');
  same('usd: exact keeps cents above 1,000', formatMoneyExact(1234.5, usd), '$1,234.50');
  same('usd: compact for chart axes', formatMoneyCompact(1500, usd), '$1.5K');
  same('usd: compact keeps whole numbers whole', formatMoneyCompact(500, usd), '$500');

  const eur = { currency: 'EUR', locale: 'de-DE' };
  same('eur de-DE: an exact amount', formatMoneyExact(1234.5, eur), `1.234,50${NBSP}€`);
  same('eur de-DE: a total from 1,000 up', formatMoney(1234.5, eur), `1.235${NBSP}€`);
  same('eur de-DE: a total below 1,000', formatMoney(234.5, eur), `234,50${NBSP}€`);
  same('eur de-DE: a negative total', formatMoney(-80, eur), `-80${NBSP}€`);

  const gbp = { currency: 'GBP', locale: 'en-GB' };
  same('gbp: pence below 1,000', formatMoney(999.5, gbp), '£999.50');
  same('gbp: whole from 1,000', formatMoney(1000.4, gbp), '£1,000');

  const jpy = { currency: 'JPY', locale: 'ja-JP' };
  const yen = formatMoney(1, jpy).replace(/1/, '');
  same('jpy: a total never shows decimals', formatMoney(12.4, jpy), `${yen}12`);
  same('jpy: an exact amount never shows decimals', formatMoneyExact(1234.56, jpy), `${yen}1,235`);
  check('jpy: the symbol is a yen sign', /[¥￥]/.test(yen), yen);

  same('another currency in en-US shows its own symbol', formatMoneyExact(10, { currency: 'EUR', locale: 'en-US' }), '€10.00');
  same('an unknown code still shows the amount', formatMoney(12.5, { currency: 'ZZZ', locale: 'en-US' }).endsWith('12.50'), true);

  // Left out, currency and locale come from the workspace region.
  setActiveRegion({ currency: 'EUR', locale: 'de-DE', weekStart: 1 });
  same('default: the workspace currency and locale', formatMoney(5), `5${NBSP}€`);
  same('default: a record\'s own currency wins', formatMoney(5, { currency: 'USD' }), `5${NBSP}$`);
  same('default: hours in the workspace locale', formatHours(2.5), '2,5h');
  same('default: a sliver of an hour', formatHours(0.01), '<0,1h');
  const affix = moneyAffix();
  check('affix: the euro sits after the number in de-DE', affix.symbol === '€' && affix.position === 'suffix', affix);
  setActiveRegion(DEFAULT_REGION);
  const dollar = moneyAffix();
  check('affix: the dollar sits before the number in en-US', dollar.symbol === '$' && dollar.position === 'prefix', dollar);
  same('default: back to dollars', formatMoney(5), '$5');

  const rows = [{ amount: 100, currency: 'USD' }, { amount: 50, currency: 'EUR' }, { amount: 25, currency: null }];
  const total = totalInCurrency(rows, (r) => r.amount, (r) => r.currency, 'USD');
  check('totals: never adds euros to dollars', total.total === 125 && total.excluded === 1, total);
  const sums = sumByCurrency(rows, (r) => r.amount, (r) => r.currency, 'USD');
  check('totals: per currency, no currency counts as the workspace one', sums.get('USD') === 125 && sums.get('EUR') === 50, [...sums]);
  same('totals: says what it left out', excludedNote(2), 'Leaves out 2 invoices in other currencies.');
  same('totals: nothing left out says nothing', excludedNote(0), '');
}

function regionValues() {
  const ok = parseRegionInput({ currency: 'eur', locale: 'de-de', weekStart: 0 });
  check('parse: codes are cleaned', ok.data?.currency === 'EUR' && ok.data?.locale === 'de-DE' && ok.data?.weekStart === 0, ok);
  check('parse: an unknown currency is refused', parseRegionInput({ currency: 'XYZ1', locale: 'en-US', weekStart: 1 }).error !== null);
  check('parse: a made-up code is refused', parseRegionInput({ currency: 'QQQ', locale: 'en-US', weekStart: 1 }).error !== null);
  check('parse: a bad locale is refused', parseRegionInput({ currency: 'USD', locale: 'not a locale', weekStart: 1 }).error !== null);
  check('parse: Wednesday is refused', parseRegionInput({ currency: 'USD', locale: 'en-US', weekStart: 3 }).error !== null);
  check('parse: a body that is not an object is refused', parseRegionInput(null).error !== null && parseRegionInput([]).error !== null);

  same('row: none is the default', JSON.stringify(rowToRegion(null)), JSON.stringify(DEFAULT_REGION));
  const partial = rowToRegion({ currency: 'GBP' });
  check('row: missing columns read as their defaults', partial.currency === 'GBP' && partial.locale === 'en-US' && partial.weekStart === 1, partial);
  const junk = rowToRegion({ currency: 'nope', locale: '!!', week_start: 3 });
  same('row: unreadable values read as the defaults', JSON.stringify(junk), JSON.stringify(DEFAULT_REGION));

  const wednesday = new Date(2026, 10, 18, 15, 0);
  same('week: Monday start', startOfWeek(wednesday, 1).getDate(), 16);
  same('week: Sunday start', startOfWeek(wednesday, 0).getDate(), 15);
  same('week: Saturday start', startOfWeek(wednesday, 6).getDate(), 14);
  same('week: a Sunday in a Monday week belongs to the week before', startOfWeek(new Date(2026, 10, 22), 1).getDate(), 16);
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

const OWNER_AUTH = '00000000-0000-0000-0000-0000000000c1';
const MEMBER_AUTH = '00000000-0000-0000-0000-0000000000c2';

async function people(db: PGlite) {
  await db.exec('RESET ROLE');
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING',
    [OWNER_AUTH, 'owner@region.example', MEMBER_AUTH, 'member@region.example']);
  await db.query("UPDATE public.team_members SET role = 'owner', status = 'active' WHERE auth_user_id = $1", [OWNER_AUTH]);
  await db.query("UPDATE public.team_members SET role = 'member', status = 'active' WHERE auth_user_id = $1", [MEMBER_AUTH]);
}

async function newInvoice(db: PGlite, project: string, number: string): Promise<string> {
  await actAs(db, null);
  const rows = await db.query<{ currency: string }>('SELECT (public.save_project_invoice_with_allocations(NULL, $1::jsonb, $2::jsonb)).currency', [
    JSON.stringify({ project_id: project, invoice_number: number, amount: 100, status: 'draft', invoice_type: 'fixed', line_items: [], date: '2026-11-21' }),
    '[]',
  ]);
  return rows.rows[0].currency;
}

async function database() {
  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  await db.exec(MIGRATION_SQL);
  await db.exec(MIGRATION_SQL);
  await people(db);

  const rows = await db.query<{ n: number; currency: string; locale: string; week_start: number }>(
    'SELECT count(*) OVER ()::int AS n, currency, locale, week_start FROM public.workspace_region');
  check('db: one row, USD, en-US, Monday', rows.rows.length === 1 && rows.rows[0].currency === 'USD' && rows.rows[0].locale === 'en-US' && rows.rows[0].week_start === 1, rows.rows);
  check('db: a second row is refused', !!(await failure(db, 'INSERT INTO public.workspace_region (id) VALUES (false)')));

  await db.exec('SET ROLE anon');
  check('db: anon cannot read it', !!(await failure(db, 'SELECT currency FROM public.workspace_region')));

  await actAs(db, MEMBER_AUTH);
  const read = await db.query('SELECT currency FROM public.workspace_region');
  check('db: a member reads it', read.rows.length === 1);
  await db.query("UPDATE public.workspace_region SET currency = 'EUR'");
  await actAs(db, null);
  same('db: a member\'s update changes nothing', (await db.query<{ c: string }>('SELECT currency AS c FROM public.workspace_region')).rows[0].c, 'USD');
  await actAs(db, MEMBER_AUTH);
  check('db: a member cannot insert', !!(await failure(db, 'INSERT INTO public.workspace_region (id) VALUES (true) ON CONFLICT (id) DO UPDATE SET currency = \'EUR\'')));
  check('db: a member cannot delete', !!(await failure(db, 'DELETE FROM public.workspace_region')));

  await actAs(db, OWNER_AUTH);
  check('db: an Owner can update', (await failure(db, "UPDATE public.workspace_region SET currency = 'EUR', locale = 'de-DE'")) === null);
  await actAs(db, null);
  same('db: the Owner\'s update is stored', (await db.query<{ c: string }>('SELECT currency AS c FROM public.workspace_region')).rows[0].c, 'EUR');
  await actAs(db, OWNER_AUTH);
  check('db: even an Owner cannot delete it', !!(await failure(db, 'DELETE FROM public.workspace_region')));
  check('db: a bad currency is refused', !!(await failure(db, "UPDATE public.workspace_region SET currency = 'euro'")));
  check('db: a bad week start is refused', !!(await failure(db, 'UPDATE public.workspace_region SET week_start = 3')));
  check('db: a bad locale is refused', !!(await failure(db, "UPDATE public.workspace_region SET locale = 'de DE; drop'")));

  // Stamped at creation, kept after a change.
  await db.exec('RESET ROLE');
  const project = (await db.query<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Region test') RETURNING id")).rows[0].id;
  same('invoice: a new invoice takes the workspace currency', await newInvoice(db, project, 'INV-1'), 'EUR');
  await db.exec('RESET ROLE');
  await db.exec("UPDATE public.workspace_region SET currency = 'GBP', locale = 'en-GB'");
  const kept = await db.query<{ currency: string }>("SELECT currency FROM public.project_invoices WHERE invoice_number = 'INV-1'");
  same('invoice: a workspace change never relabels it', kept.rows[0].currency, 'EUR');
  same('invoice: the next one takes the new currency', await newInvoice(db, project, 'INV-2'), 'GBP');
  await db.exec('RESET ROLE');
  const retainer = await db.query<{ currency: string }>(
    "INSERT INTO public.project_retainers (project_id, name, start_date) VALUES ($1, 'Monthly', '2026-11-01') RETURNING currency", [project]);
  same('retainer: stamped with the workspace currency', retainer.rows[0].currency, 'GBP');
  const plan = await db.query<{ currency: string }>(
    'INSERT INTO public.project_billing_plans (project_id) VALUES ($1) RETURNING currency', [project]);
  same('billing plan: stamped with the workspace currency', plan.rows[0].currency, 'GBP');

  // The activity line for a payment is in its invoice's currency.
  await db.exec("UPDATE public.workspace_region SET currency = 'USD', locale = 'en-US', money_format = $1::jsonb".replace('$1', `'${JSON.stringify(moneyFormatPattern('USD', 'en-US'))}'`));
  const invoiceId = (await db.query<{ id: string }>("SELECT id FROM public.project_invoices WHERE invoice_number = 'INV-1'")).rows[0].id;
  // Recorded by the Owner: the activity log needs someone who did it.
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [OWNER_AUTH]);
  await db.query("INSERT INTO public.invoice_payments (invoice_id, amount, paid_date) VALUES ($1, 40, '2026-11-21')", [invoiceId]);
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  const activity = await db.query<{ description: string }>("SELECT description FROM public.activities WHERE type = 'payment.recorded' ORDER BY created_at DESC LIMIT 1");
  same('activity: a euro payment says euros in a dollar workspace', activity.rows[0]?.description, `Recorded a EUR${NBSP}40.00 payment on invoice INV-1`);
  // One amount keeps its cents from 1,000 up, as before this release.
  await newInvoice(db, project, 'INV-3');
  await db.exec('RESET ROLE');
  const usdInvoice = (await db.query<{ id: string }>("SELECT id FROM public.project_invoices WHERE invoice_number = 'INV-3'")).rows[0].id;
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [OWNER_AUTH]);
  await db.query("INSERT INTO public.invoice_payments (invoice_id, amount, paid_date) VALUES ($1, 1234.56, '2026-11-21')", [usdInvoice]);
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  const exactLine = await db.query<{ description: string }>(
    "SELECT description FROM public.activities WHERE type = 'payment.recorded' AND description LIKE '%INV-3' ORDER BY created_at DESC LIMIT 1");
  same('activity: a $1,234.56 payment keeps its cents', exactLine.rows[0]?.description, 'Recorded a $1,234.56 payment on invoice INV-3');

  // SQL writes what the app writes.
  const regions: [string, string][] = [
    ['USD', 'en-US'], ['EUR', 'de-DE'], ['EUR', 'fr-FR'], ['GBP', 'en-GB'], ['JPY', 'ja-JP'], ['EUR', 'es-ES'],
    ['INR', 'en-IN'], ['CHF', 'de-CH'], ['EUR', 'nl-NL'], ['SEK', 'sv-SE'], ['EUR', 'de-CH'],
  ];
  const amounts = [0, 12, 12.5, 999.99, 1234, 1234.5, 12345.67, 1234567.89, -80, -1234.5, -12.25];
  const mismatches: string[] = [];
  const exactMismatches: string[] = [];
  for (const [currency, locale] of regions) {
    await db.query('UPDATE public.workspace_region SET currency = $1, locale = $2, money_format = $3::jsonb',
      [currency, locale, JSON.stringify(moneyFormatPattern(currency, locale))]);
    for (const amount of amounts) {
      const sql = (await db.query<{ t: string }>('SELECT public.format_money($1::numeric) AS t', [amount])).rows[0].t;
      const js = formatMoney(amount, { currency, locale });
      if (sql !== js) mismatches.push(`${currency} ${locale} ${amount}: sql ${JSON.stringify(sql)} js ${JSON.stringify(js)}`);
      const sqlExact = await db.query<{ t: string }>('SELECT public.format_money($1::numeric, NULL, true) AS t', [amount])
        .then((result) => result.rows[0].t, (error: Error) => `error: ${error.message}`);
      const jsExact = formatMoneyExact(amount, { currency, locale });
      if (sqlExact !== jsExact) exactMismatches.push(`${currency} ${locale} ${amount}: sql ${JSON.stringify(sqlExact)} js ${JSON.stringify(jsExact)}`);
    }
  }
  check('sql: format_money matches formatMoney across 11 regions', mismatches.length === 0, mismatches);
  check('sql: exact format_money matches formatMoneyExact across 11 regions', exactMismatches.length === 0, exactMismatches);
  await db.query('UPDATE public.workspace_region SET currency = $1, locale = $2, money_format = $3::jsonb',
    ['EUR', 'de-DE', JSON.stringify(moneyFormatPattern('EUR', 'de-DE'))]);
  same('sql: another currency shows its code where the symbol goes', (await db.query<{ t: string }>("SELECT public.format_money(1234.5, 'USD') AS t")).rows[0].t, `1.235${NBSP}USD`);
  same('sql: and keeps its own decimals below 1,000', (await db.query<{ t: string }>("SELECT public.format_money(12.5, 'JPY') AS t")).rows[0].t, `13${NBSP}JPY`);
  const foreignExact = await db.query<{ t: string }>("SELECT public.format_money(1234.5, 'USD', true) AS t")
    .then((result) => result.rows[0].t, (error: Error) => `error: ${error.message}`);
  same('sql: exact keeps the cents of another currency', foreignExact, `1.234,50${NBSP}USD`);
  await db.close();
}

/** Retainers in two currencies on one project: one draft per currency, never one sum. */
async function retainerDrafts() {
  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  await db.exec(MIGRATION_SQL);
  const project = (await db.query<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Two currencies') RETURNING id")).rows[0].id;
  const retainer = async (name: string, currency: string, amount: number) => {
    const id = (await db.query<{ id: string }>(
      "INSERT INTO public.project_retainers (project_id, name, start_date, currency) VALUES ($1, $2, '2026-11-01', $3) RETURNING id",
      [project, name, currency])).rows[0].id;
    await db.query("INSERT INTO public.project_retainer_amounts (retainer_id, amount, effective_date) VALUES ($1, $2, '2026-11-01')", [id, amount]);
  };
  await retainer('US support', 'USD', 1000);
  await retainer('EU support', 'EUR', 800);
  await db.query("SELECT public.generate_retainer_drafts('2026-11-21')");
  const drafts = await db.query<{ currency: string; amount: string; lines: number }>(
    `SELECT currency, amount::text, jsonb_array_length(line_items)::int AS lines FROM public.project_invoices
     WHERE project_id = $1 AND auto_generated ORDER BY currency`, [project]);
  const shape = drafts.rows.map((r) => `${r.currency} ${Number(r.amount)} x${r.lines}`).join(', ');
  same('retainers: one draft per currency, each its own sum', shape, 'EUR 800 x1, USD 1000 x1');
  const failed = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.project_billing_runs WHERE project_id = $1 AND outcome = 'failed'", [project]);
  same('retainers: neither draft failed', failed.rows[0].n, 0);
  // A hand-built mix is refused rather than labelled with one currency.
  const ids = (await db.query<{ id: string }>('SELECT id FROM public.project_retainers WHERE project_id = $1', [project])).rows.map((r) => r.id);
  const mixed = JSON.stringify(ids.map((id, i) => ({ id: `mix-${i}`, position: i, item_type: 'recurring', amount: 10, description: 'Mix', retainer_id: id })));
  const refused = await failure(db, "SELECT public.create_retainer_draft_internal($1, $2::jsonb, '2026-11-21', false)", [project, mixed]);
  check('retainers: one draft for two currencies is refused', /different currencies/.test(refused ?? ''), refused);
  await db.close();
}

/** schema.sql before this change: the commit that added the migration's parent, or HEAD while it is uncommitted. */
function schemaBefore(): string {
  try {
    return schemaBeforeMigration(MIGRATION);
  } catch {
    return schemaAt('HEAD');
  }
}

async function upgrade() {
  const db = await createFullSchemaDatabase({ schemaSql: schemaBefore() });
  await db.exec('RESET ROLE');
  const project = (await db.query<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Before') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO public.project_invoices (project_id, invoice_number, amount, date) VALUES ($1, 'OLD-1', 900, '2026-10-01')", [project]);
  await db.query("INSERT INTO public.project_retainers (project_id, name, start_date) VALUES ($1, 'Old retainer', '2026-01-01')", [project]);
  await db.query('INSERT INTO public.project_billing_plans (project_id) VALUES ($1)', [project]);

  // A legacy read: 1.7.0's server code on the 1.6.1 database.
  const server = await startFakePostgrest(db, { strictColumns: true });
  const { createClient } = await import('@supabase/supabase-js');
  const service = createClient(server.url, 'fake-service-key', { auth: { persistSession: false } });
  const { readStoredRegion } = await import('../src/lib/region/server');
  try {
    const missing = await readStoredRegion(service);
    check('legacy: no table reads as the default region', !missing.tableReady && JSON.stringify(missing.region) === JSON.stringify(DEFAULT_REGION), missing);
  } catch (error) {
    failures.push(`legacy: the read threw without the table: ${(error as Error).message}`);
  }

  // A table from an older shape (fewer columns): what is there is used, the rest is default.
  await db.exec("CREATE TABLE public.workspace_region (id boolean PRIMARY KEY DEFAULT true, currency text); INSERT INTO public.workspace_region (currency) VALUES ('CAD')");
  try {
    const partial = await readStoredRegion(service);
    check('legacy: missing columns read as their defaults', partial.tableReady && partial.region.currency === 'CAD' && partial.region.locale === 'en-US', partial);
  } catch (error) {
    failures.push(`legacy: the read threw with fewer columns: ${(error as Error).message}`);
  }
  await server.close();
  await db.exec('DROP TABLE public.workspace_region');

  await db.exec(MIGRATION_SQL);
  await db.exec(MIGRATION_SQL);
  const old = await db.query<{ i: string; r: string; p: string }>(`SELECT
    (SELECT currency FROM public.project_invoices WHERE invoice_number = 'OLD-1') AS i,
    (SELECT currency FROM public.project_retainers LIMIT 1) AS r,
    (SELECT currency FROM public.project_billing_plans LIMIT 1) AS p`);
  check('upgrade: existing invoices, retainers and plans are USD', old.rows[0].i === 'USD' && old.rows[0].r === 'USD' && old.rows[0].p === 'USD', old.rows);
  await db.exec("UPDATE public.workspace_region SET currency = 'EUR'");
  await db.exec(MIGRATION_SQL);
  const after = await db.query<{ i: string; n: string }>(`SELECT
    (SELECT currency FROM public.project_invoices WHERE invoice_number = 'OLD-1') AS i,
    (SELECT currency FROM public.workspace_region) AS n`);
  check('upgrade: re-running keeps the region and the history', after.rows[0].i === 'USD' && after.rows[0].n === 'EUR', after.rows);
  // 1.6.1's insert (no currency column named) is stamped with the workspace currency.
  const stamped = await db.query<{ currency: string }>(
    "INSERT INTO public.project_invoices (project_id, invoice_number, amount, date) VALUES ($1, 'NEW-1', 50, '2026-11-21') RETURNING currency", [project]);
  same('upgrade: an insert that names no currency takes the workspace one', stamped.rows[0].currency, 'EUR');
  await db.close();
}

async function main() {
  formatter();
  regionValues();
  await database();
  await retainerDrafts();
  await upgrade();

  console.log(`region: ${passed} checks passed`);
  if (failures.length) {
    console.error(`${failures.length} failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
