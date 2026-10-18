/**
 * Dress rehearsal on a COPY of production billing data, in a local PGlite:
 * reads projects, retainers, invoices, allocations and time entries through
 * the service role (read only, nothing is written to production), loads them
 * into the drafting migrations, applies billing plans, and prints the
 * forecast and what the jobs would draft on the given dates.
 *
 *   npx tsx --tsconfig tsconfig.mcp-test.json scripts/rehearse-billing.ts .env.local
 */
import { readFileSync } from 'node:fs';
import { createDraftingDatabase } from './invoice-drafting-db';

const MIGRATIONS = [
  '../supabase/migrations/20261018173052_project_billing_plans.sql',
  '../supabase/migrations/20261018175826_retainer_drafts_isolated.sql',
];
// The owner's billing as he described it (2026-10-18).
const PLANS: Record<string, Record<string, unknown>> = {
  'Plan4TheFuture.com': { hours_trigger: 'days_of_month', days_of_month: [1, 16], combine_with_retainer: true, starts_on: '2026-10-19' },
  'Happy Innovations': { hours_trigger: 'days_of_month', days_of_month: [1], combine_with_retainer: true, starts_on: '2026-10-19' },
};
const RUN_DATES = ['2026-10-31', '2026-11-01', '2026-11-16'];

const env = Object.fromEntries(readFileSync(process.argv[2] ?? '.env.local', 'utf8').split(/\r?\n/)
  .filter((line) => /^[A-Z_]+=/.test(line))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, '')]; }));
const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

async function all<T>(path: string): Promise<T[]> {
  let out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, { headers: { ...headers, Range: `${from}-${from + 999}` } });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as T[];
    out = out.concat(page);
    if (page.length < 1000) return out;
  }
}

type Row = Record<string, unknown>;
const money = (n: unknown) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function main() {
  const [members, projects, retainers, amounts, periods, invoices, allocations, entries] = await Promise.all([
    all<Row>('team_members?select=id,name,role,status,timezone&role=eq.owner'),
    all<Row>('projects?select=id,name,status,archived_at'),
    all<Row>('project_retainers?select=*'),
    all<Row>('project_retainer_amounts?select=*'),
    all<Row>('project_retainer_periods?select=*'),
    all<Row>('project_invoices?select=id,project_id,invoice_number,amount,status,invoice_type,line_items,date,due_date,paid_date,description,auto_generated,created_at'),
    all<Row>('invoice_time_entry_allocations?select=*'),
    all<Row>('project_time_entries?select=id,project_id,member_id,start_time,end_time,segments,hourly_rate,work_type,approval_status'),
  ]);

  const db = await createDraftingDatabase(MIGRATIONS);
  const q = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const insert = async (table: string, rows: Row[]) => {
    for (const row of rows) {
      const cols = Object.keys(row);
      const values = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]));
      await db.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING`, values);
    }
  };
  await insert('team_members', members.map((m) => ({ ...m, name: m.name ?? 'Owner' })));
  await insert('projects', projects);
  await insert('project_time_entries', entries);
  await insert('project_retainers', retainers);
  await insert('project_retainer_amounts', amounts);
  await insert('project_invoices', invoices);
  await insert('invoice_time_entry_allocations', allocations);
  await insert('project_retainer_periods', periods);

  const byName = new Map(projects.map((p) => [p.name as string, p.id as string]));
  for (const [name, settings] of Object.entries(PLANS)) {
    const id = byName.get(name);
    if (!id) { console.log(`(no project named ${name})`); continue; }
    await q('SELECT save_project_billing_plan($1, $2::jsonb)', [id, JSON.stringify(settings)]);
  }

  console.log('UNBILLED NOW (approved, beyond paid, minus held):');
  for (const [name] of Object.entries(PLANS)) {
    const id = byName.get(name);
    const d = (await q<{ d: Row | null }>('SELECT invoice_hours_draft_internal($1) d', [id]))[0].d;
    console.log(`  ${name.padEnd(22)} ${d ? `${Number(d.hours).toFixed(2)} h ${money(d.amount)}` : 'nothing'}`);
  }

  console.log('\nFORECAST (next 2 months):');
  const forecast = (await q<{ f: Array<Row & { lines: Row[] }> }>("SELECT billing_forecast(NULL, '2026-10-19', '2026-12-31') f"))[0].f;
  for (const item of forecast) {
    console.log(`  ${item.date} ${String(item.project_name).padEnd(22)} ${String(item.status).padEnd(9)} ${money(Number(item.exact) + Number(item.estimated))}${Number(item.estimated) > 0 ? ' (incl. est.)' : ''}`);
    for (const line of item.lines) console.log(`      ${line.estimated ? '~' : ' '} ${String(line.label).padEnd(40)} ${money(line.amount)}${line.note ? `   ${line.note}` : ''}`);
  }

  for (const day of RUN_DATES) {
    await q('SELECT generate_retainer_drafts($1::date)', [day]);
    await q('SELECT generate_billing_drafts($1::date)', [day]);
  }
  console.log(`\nWHAT THE JOBS DRAFT ON ${RUN_DATES.join(', ')} (new drafts only; nothing is ever sent):`);
  const drafted = await q<Row & { line_items: Row[] }>(
    "SELECT i.*, p.name AS project_name FROM project_invoices i JOIN projects p ON p.id = i.project_id WHERE i.auto_generated AND i.status = 'draft' ORDER BY i.date, p.name");
  for (const inv of drafted) {
    console.log(`  ${inv.invoice_number} ${String(inv.project_name).padEnd(22)} dated ${inv.date} due ${inv.due_date}  ${money(inv.amount)}`);
    for (const line of inv.line_items) console.log(`      ${String(line.item_type).padEnd(10)} ${String(line.description).slice(0, 70).padEnd(70)} ${money(line.amount)}`);
  }
  const runs = await q<Row>('SELECT r.run_key, r.outcome, r.pending_hours, r.detail, p.name FROM project_billing_runs r JOIN projects p ON p.id = r.project_id ORDER BY r.created_at');
  console.log('\nRUNS:');
  for (const run of runs) console.log(`  ${String(run.name).padEnd(22)} ${run.run_key} ${run.outcome}${Number(run.pending_hours) > 0 ? ` (${Number(run.pending_hours).toFixed(2)} h awaiting approval left out)` : ''}${run.detail ? ` ${run.detail}` : ''}`);
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
