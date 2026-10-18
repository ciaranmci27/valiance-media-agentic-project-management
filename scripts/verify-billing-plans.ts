/**
 * Billing plans: scheduled hourly drafts on top of retainer drafts, against a
 * real Postgres (PGlite) with the real migrations.
 *
 *   npm run -s test:billing-plans
 */
import { randomUUID } from 'node:crypto';
import { createDraftingDatabase } from './invoice-drafting-db';

const PLANS_MIGRATION = '../supabase/migrations/20261018173052_project_billing_plans.sql';
const RETAINER_ISOLATION_MIGRATION = '../supabase/migrations/20261018175826_retainer_drafts_isolated.sql';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 1500)}`);
}


interface Invoice {
  id: string; invoice_number: string; amount: string; status: string; invoice_type: string;
  date: string; due_date: string; auto_generated: boolean; line_items: Array<{ item_type: string; amount: number; description: string }>;
}
interface Run { run_key: string; outcome: string; invoice_id: string | null; hours: string | null; amount: string | null; pending_hours: string; detail: string | null }
interface ForecastLine { kind: string; label: string; amount: number | string; estimated: boolean; note: string | null }
interface ForecastItem { date: string; sources: string; status: string; invoice_number: string | null; exact: number | string; estimated: number | string; lines: ForecastLine[] }

async function main() {
  const db = await createDraftingDatabase([PLANS_MIGRATION, RETAINER_ISOLATION_MIGRATION]);
  const q = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const owner = randomUUID();
  await db.query("INSERT INTO team_members(id, name, role, timezone) VALUES ($1, 'Owner', 'owner', 'UTC')", [owner]);

  const project = async (name: string) => {
    const id = randomUUID();
    await db.query('INSERT INTO projects(id, name) VALUES ($1, $2)', [id, name]);
    return id;
  };
  // A session of `hours` at `rate`, starting at an ISO time, approved unless said otherwise.
  const work = async (projectId: string, startIso: string, hours: number, rate = 100, approval = 'approved') => {
    const start = new Date(startIso).getTime();
    const end = new Date(start + hours * 3600_000).toISOString();
    await db.query(
      `INSERT INTO project_time_entries(project_id, member_id, start_time, end_time, segments, hourly_rate, approval_status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [projectId, owner, startIso, end, JSON.stringify([{ start: startIso, end }]), rate, approval]);
  };
  const plan = (projectId: string, settings: Record<string, unknown>) =>
    q('SELECT save_project_billing_plan($1, $2::jsonb)', [projectId, JSON.stringify(settings)]);
  const runJobs = async (asOf: string) => {
    await q('SELECT generate_retainer_drafts($1::date)', [asOf]);
    return Number((await q<{ n: number }>('SELECT generate_billing_drafts($1::date) n', [asOf]))[0].n);
  };
  const invoices = (projectId: string) => q<Invoice>('SELECT * FROM project_invoices WHERE project_id = $1 ORDER BY invoice_number', [projectId]);
  const runs = (projectId: string) => q<Run>('SELECT * FROM project_billing_runs WHERE project_id = $1 ORDER BY created_at, run_key', [projectId]);
  const unbilled = async (projectId: string) =>
    Number((await q<{ h: string | null }>("SELECT invoice_hours_draft_internal($1)->>'hours' h", [projectId]))[0].h ?? 0);

  // -- Plan4TheFuture: retainer + hours on the 1st and 16th, combined -------
  const p4 = await project('Plan4TheFuture');
  await q(`SELECT save_project_retainer(NULL, $1::jsonb)`, [JSON.stringify({
    project_id: p4, name: 'Monthly Marketing Retainer', billing_timing: 'advance', start_date: '2026-10-01', amount: 2000,
  })]);
  await plan(p4, { hours_trigger: 'days_of_month', days_of_month: [1, 16], payment_terms_days: 0, starts_on: '2026-10-20' });
  await work(p4, '2026-10-20T15:00:00Z', 10);       // $1,000
  await work(p4, '2026-10-28T15:00:00Z', 5);        // $500
  await work(p4, '2026-10-30T15:00:00Z', 2, 100, 'pending'); // awaiting approval
  await work(p4, '2026-10-31T23:00:00Z', 2);        // starts before the Nov 1 cutoff

  check('nothing before the plan starts (the Oct 16 date is before starts_on)', await runJobs('2026-10-19') === 0);
  await runJobs('2026-10-31'); // the retainer drafts its Nov invoice a day early
  let list = await invoices(p4);
  check('retainer drafts Nov a day early, alone', list.length === 2 && list[1].date === '2026-11-01' && list[1].line_items.length === 1, list);
  const merged = await runJobs('2026-11-01');
  list = await invoices(p4);
  const nov = list.find((i) => i.date === '2026-11-01')!;
  check('Nov 1: the hours ride on the retainer invoice (one invoice, two lines)',
    merged === 1 && nov.line_items.length === 2 && Number(nov.amount) === 2000 + 1700
    && nov.line_items[1].item_type === 'hourly' && nov.line_items[1].description.startsWith('17 hours worked between 10/20/2026'), nov);
  let r = await runs(p4);
  check('the run records it as merged, with the time awaiting approval left out',
    r.length === 1 && r[0].outcome === 'merged' && r[0].run_key === 'day:2026-11-01' && Number(r[0].pending_hours) === 2, r);
  const allocations = await q<{ n: number; sum: string }>('SELECT count(*)::int n, sum(allocated_amount) sum FROM invoice_time_entry_allocations WHERE invoice_id = $1', [nov.id]);
  check('the merged hours are allocated (held) and add up to the line', allocations[0].n === 3 && Number(allocations[0].sum) === 1700, allocations);
  check('a rerun the same day drafts nothing', await runJobs('2026-11-01') === 0 && (await runs(p4)).length === 1);
  const notices = await q<{ summary: string }>('SELECT summary FROM billing_draft_notices WHERE invoice_id = $1', [nov.id]);
  check('the announcement says the invoice now includes the hours', /now includes 17 h \(\$1,700\.00\)/.test(notices[0]?.summary ?? ''), notices);
  const bells = await q<{ title: string; entity_type: string; entity_id: string }>("SELECT title, entity_type, entity_id FROM notifications_log WHERE entity_id = $1", [nov.id]);
  check('bells are keyed to the invoice (not the project)', bells.length >= 2 && bells.every((b) => b.entity_type === 'invoice'), bells);

  await work(p4, '2026-11-03T15:00:00Z', 4);
  await work(p4, '2026-11-16T15:00:00Z', 1); // after the Nov 16 cutoff: next time
  await runJobs('2026-11-16');
  list = await invoices(p4);
  const mid = list.find((i) => i.date === '2026-11-16')!;
  check('Nov 16: hours only, on their own draft, through Nov 15',
    !!mid && mid.invoice_type === 'hourly' && Number(mid.amount) === 400 && mid.auto_generated && mid.status === 'draft', mid);
  check('hours worked on the draft day wait for the next draft', await unbilled(p4) === 1);

  // -- Separate invoices, payment terms -----------------------------------
  const happy = await project('Happy Innovations');
  await q(`SELECT save_project_retainer(NULL, $1::jsonb)`, [JSON.stringify({
    project_id: happy, name: 'Monthly Retainer', billing_timing: 'advance', start_date: '2026-11-01', amount: 2500,
  })]);
  await plan(happy, { hours_trigger: 'days_of_month', days_of_month: [1], combine_with_retainer: false, payment_terms_days: 14, starts_on: '2026-10-20' });
  await work(happy, '2026-10-21T15:00:00Z', 3);
  await runJobs('2026-10-31');
  await runJobs('2026-11-01');
  list = await invoices(happy);
  check('combine off: retainer and hours are two drafts the same day',
    list.length === 2 && list.every((i) => i.date === '2026-11-01') && list.some((i) => i.invoice_type === 'hourly' && Number(i.amount) === 300)
    && list.some((i) => i.invoice_type === 'recurring' && Number(i.amount) === 2500), list);
  check('payment terms: Net 14 on both the retainer and the hours draft', list.every((i) => i.due_date === '2026-11-15'), list.map((i) => i.due_date));

  // -- Cap and minimum ----------------------------------------------------
  const capped = await project('Capped');
  await plan(capped, { hours_trigger: 'days_of_month', days_of_month: [1], cap_mode: 'amount', cap_value: 500, starts_on: '2026-10-20' });
  await work(capped, '2026-10-21T15:00:00Z', 8); // $800
  await runJobs('2026-11-01');
  list = await invoices(capped);
  check('cap: the draft stops at $500 and the rest waits', list.length === 1 && Number(list[0].amount) === 500 && await unbilled(capped) === 3, list);
  await runJobs('2026-12-01');
  check('cap: the rest goes on the next scheduled draft', (await invoices(capped)).length === 2 && await unbilled(capped) === 0);

  const tiny = await project('Tiny');
  await plan(tiny, { hours_trigger: 'days_of_month', days_of_month: [1], min_amount: 100, starts_on: '2026-10-20' });
  await work(tiny, '2026-10-21T15:00:00Z', 0.5); // $50
  await runJobs('2026-11-01');
  r = await runs(tiny);
  check('minimum: under $100 nothing is drafted, the run says why, the hours wait',
    (await invoices(tiny)).length === 0 && r[0]?.outcome === 'below_minimum' && /minimum/.test(r[0]?.detail ?? '') && await unbilled(tiny) === 0.5, r);

  // -- Fixed blocks (rolling balance) and reaches-amount -------------------
  const blocks = await project('Blocks');
  await plan(blocks, { hours_trigger: 'fixed_blocks', trigger_amount: 3000, starts_on: '2026-10-20' });
  await work(blocks, '2026-10-21T15:00:00Z', 40);
  await work(blocks, '2026-10-23T15:00:00Z', 30); // $7,000 in all
  await runJobs('2026-10-25');
  list = await invoices(blocks);
  check('fixed blocks: $7,000 accrued drafts two $3,000 invoices; $1,000 rolls on',
    list.length === 2 && list.every((i) => Number(i.amount) === 3000) && Math.abs(await unbilled(blocks) - 10) < 1e-9, list);
  check('fixed blocks: the second block starts inside the session where the first ended',
    (await q<{ n: number }>("SELECT count(*)::int n FROM invoice_time_entry_allocations a JOIN project_invoices i ON i.id = a.invoice_id WHERE i.project_id = $1 AND a.start_offset_hours > 0", [blocks]))[0].n === 1);
  check('fixed blocks: nothing more until another $3,000 accrues', await runJobs('2026-10-26') === 0);
  await work(blocks, '2026-10-27T15:00:00Z', 20);
  check('fixed blocks: the next block drafts once it does', await runJobs('2026-10-27') === 1 && Math.abs(await unbilled(blocks) - 0) < 1e-9);

  const reaches = await project('Reaches');
  await plan(reaches, { hours_trigger: 'reaches_amount', trigger_amount: 3000, starts_on: '2026-10-20' });
  await work(reaches, '2026-10-21T15:00:00Z', 29);
  check('reaches: $2,900 waits', await runJobs('2026-10-22') === 0);
  await work(reaches, '2026-10-22T15:00:00Z', 3);
  await runJobs('2026-10-23');
  list = await invoices(reaches);
  check('reaches: at $3,200 it drafts ALL of it', list.length === 1 && Number(list[0].amount) === 3200, list);

  // -- Every N weeks ------------------------------------------------------
  const weekly = await project('Weekly');
  await plan(weekly, { hours_trigger: 'every_weeks', every_weeks: 2, weeks_anchor: '2026-11-06', starts_on: '2026-10-20' });
  await work(weekly, '2026-11-02T15:00:00Z', 1);
  check('every 2 weeks: nothing before the anchor', await runJobs('2026-11-05') === 0);
  check('every 2 weeks: drafts on the anchor', await runJobs('2026-11-06') === 1);
  await work(weekly, '2026-11-10T15:00:00Z', 1);
  check('every 2 weeks: not a week later', await runJobs('2026-11-13') === 0);
  check('every 2 weeks: two weeks later', await runJobs('2026-11-20') === 1);

  // -- Manual, paused, isolation ------------------------------------------
  const manual = await project('Manual');
  await plan(manual, { hours_trigger: 'manual' });
  await work(manual, '2026-10-21T15:00:00Z', 2);
  await runJobs('2026-11-01');
  check('manual: nothing is drafted, nothing recorded', (await invoices(manual)).length === 0 && (await runs(manual)).length === 0);

  const paused = await project('Paused');
  await plan(paused, { hours_trigger: 'days_of_month', days_of_month: [1], starts_on: '2026-10-20', paused: true });
  await work(paused, '2026-10-21T15:00:00Z', 2);
  await runJobs('2026-11-01');
  check('paused: nothing is drafted', (await invoices(paused)).length === 0);

  const broken = await project('Broken');
  const healthy = await project('Healthy');
  for (const id of [broken, healthy]) {
    await plan(id, { hours_trigger: 'days_of_month', days_of_month: [1], starts_on: '2026-10-20' });
    await work(id, '2026-10-21T15:00:00Z', 1);
    await q(`SELECT save_project_retainer(NULL, $1::jsonb)`, [JSON.stringify({
      project_id: id, name: 'Retainer', billing_timing: 'advance', start_date: '2026-11-01', amount: 1000, lead_days: 0,
    })]);
  }
  await db.exec(`CREATE FUNCTION test_break() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disk on fire'; END $$;
    CREATE TRIGGER test_break BEFORE INSERT ON project_invoices FOR EACH ROW WHEN (NEW.project_id = '${broken}') EXECUTE FUNCTION test_break();`);
  await runJobs('2026-11-01');
  r = await runs(broken);
  check('isolation: a failing project is recorded as failed, retainer and hours, with the reason',
    r.length === 2 && r.every((run) => run.outcome === 'failed' && /disk on fire/.test(run.detail ?? ''))
    && r.some((run) => run.run_key === 'retainer-failed:2026-11-01'), r);
  const healthyInvoices = await invoices(healthy);
  check('isolation: the other projects still draft their retainer and hours (one combined invoice)',
    healthyInvoices.length === 1 && Number(healthyInvoices[0].amount) === 1100 && healthyInvoices[0].line_items.length === 2, healthyInvoices);
  const failedBell = await q<{ title: string }>("SELECT title FROM notifications_log WHERE entity_id = $1", [broken]);
  check('isolation: a failed retainer draft rings the bell', failedBell.some((b) => b.title === 'Retainer draft failed'), failedBell);
  check('isolation: the failure rolled back that project only (nothing half-drafted)', (await invoices(broken)).length === 0 && await unbilled(broken) === 1);

  // -- Forecast -----------------------------------------------------------
  const ending = await project('Ending');
  await q(`SELECT save_project_retainer(NULL, $1::jsonb)`, [JSON.stringify({
    project_id: ending, name: 'Retainer', billing_timing: 'advance', start_date: '2026-12-01', end_date: '2027-02-10', amount: 3100,
  })]);
  await plan(ending, { hours_trigger: 'days_of_month', days_of_month: [1, 16], starts_on: '2026-11-20' });
  await work(ending, '2026-11-21T15:00:00Z', 4);
  const forecast = (await q<{ f: ForecastItem[] }>("SELECT billing_forecast($1, '2026-11-20', '2027-04-30') f", [ending]))[0].f;
  const byDate = new Map(forecast.map((item) => [item.date, item]));
  const dec1 = byDate.get('2026-12-01');
  check('forecast: Dec 1 is one invoice with the retainer and the hours so far',
    !!dec1 && dec1.lines.length === 2 && Number(dec1.exact) === 3100 && Number(dec1.estimated) === 400
    && dec1.lines.some((l) => l.label === 'Hours so far' && l.estimated), dec1);
  const feb1 = byDate.get('2027-02-01');
  check('forecast: the last retainer invoice is prorated and says it is the last',
    !!feb1 && feb1.lines.some((l) => l.kind === 'retainer' && Number(l.amount) === 1107.14 && /Last invoice/.test(l.note ?? '')), feb1);
  check('forecast: no retainer after it ends; hours keep their dates',
    !forecast.some((i) => i.date >= '2027-03-01' && i.lines.some((l) => l.kind === 'retainer'))
    && byDate.has('2027-03-01') && byDate.has('2027-03-16'), forecast.map((i) => `${i.date}:${i.sources}`));
  check('forecast: hours after the next draft are estimates, marked so',
    forecast.filter((i) => i.date > '2026-12-01').flatMap((i) => i.lines).filter((l) => l.kind === 'hours').every((l) => l.estimated));
  const preview = (await q<{ f: ForecastItem[] }>(
    "SELECT billing_forecast($1, '2026-11-20', '2027-01-31', $2::jsonb) f", [ending, JSON.stringify({ combine_with_retainer: false })]))[0].f;
  check('forecast: an unsaved change previews live (separate invoices on Dec 1)',
    preview.filter((i) => i.date === '2026-12-01').length === 2);
  const all = (await q<{ f: Array<ForecastItem & { project_name: string }> }>("SELECT billing_forecast(NULL, '2026-11-20', '2026-12-31') f"))[0].f;
  check('calendar: every project with a retainer or a plan, named',
    new Set(all.map((i) => i.project_name)).has('Ending') && new Set(all.map((i) => i.project_name)).has('Plan4TheFuture') && !all.some((i) => i.project_name === 'Manual'));
  const doneForecast = (await q<{ f: ForecastItem[] }>("SELECT billing_forecast($1, '2026-11-01', '2026-11-30') f", [p4]))[0].f;
  check('forecast: a date already drafted shows its invoice and status',
    doneForecast.some((i) => i.date === '2026-11-01' && i.invoice_number && i.status === 'draft'), doneForecast);

  // -- Switching drafting on starts it today ------------------------------
  const fresh = await project('Fresh');
  await plan(fresh, { hours_trigger: 'days_of_month', days_of_month: [1] });
  const started = (await q<{ starts_on: string; today: string }>(
    'SELECT starts_on::text, workspace_today()::text AS today FROM project_billing_plans WHERE project_id = $1', [fresh]))[0];
  check('switching drafting on with no start date starts it today (never a date already passed)', started.starts_on === started.today, started);
  await plan(fresh, { min_amount: 50 });
  const kept = (await q<{ starts_on: string }>('SELECT starts_on::text FROM project_billing_plans WHERE project_id = $1', [fresh]))[0];
  check('editing another setting keeps the start date', kept.starts_on === started.starts_on, kept);

  // -- Access and validation ----------------------------------------------
  let refused = '';
  try { await plan(manual, { hours_trigger: 'days_of_month', days_of_month: [0] }); } catch (e) { refused = (e as Error).message; }
  check('validation: day 0 is refused', /violates check constraint/.test(refused), refused);
  refused = '';
  try { await plan(manual, { hours_trigger: 'fixed_blocks' }); } catch (e) { refused = (e as Error).message; }
  check('validation: a block size is required for fixed blocks', /project_billing_plans_amount/.test(refused), refused);
  await db.query("SET test.role = 'authenticated'");
  await db.exec(`CREATE OR REPLACE FUNCTION public.has_permission(text, text DEFAULT 'app') RETURNS boolean LANGUAGE sql AS $$ SELECT false $$`);
  refused = '';
  try { await plan(manual, { payment_terms_days: 30 }); } catch (e) { refused = (e as Error).message; }
  check('access: only invoices.manage changes a plan', /Not allowed/.test(refused), refused);
  refused = '';
  try { await q('SELECT billing_forecast($1)', [manual]); } catch (e) { refused = (e as Error).message; }
  check('access: only invoices.read reads a forecast', /Not allowed/.test(refused), refused);
  await db.query('RESET test.role');

  await db.close();
  if (failures.length) {
    console.error(`billing plans: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`billing plans: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
