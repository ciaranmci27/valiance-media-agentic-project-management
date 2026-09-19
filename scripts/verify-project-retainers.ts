// Exercises the project retainers migration against a real Postgres (PGlite):
// period math, drafting, skip and regenerate, split earnings, reversals and
// payout allocation. Run: node --experimental-strip-types scripts/verify-project-retainers.ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = '../supabase/migrations/20260919050750_create_project_retainers.sql';

async function main() {
  const db = new PGlite();
  let checks = 0;
  const check = (actual: unknown, expected: unknown, label: string) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  const rejects = async (promise: Promise<unknown>, pattern: RegExp, label: string) => {
    await assert.rejects(promise, pattern, label);
    checks++;
  };
  const rows = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T,>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0];

  const canonical = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const table = (name: string) => {
    const sql = canonical.match(new RegExp('create table public\\.' + name + ' \\([\\s\\S]*?^\\);', 'mi'))?.[0];
    assert.ok(sql, name);
    return sql;
  };

  const owner = randomUUID();
  const partner = randomUUID();
  const project = randomUUID();
  const otherProject = randomUUID();

  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role' $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
      CREATE TABLE public.team_members (
        id uuid PRIMARY KEY, name text NOT NULL DEFAULT '', role text NOT NULL, status text NOT NULL DEFAULT 'active',
        timezone text NOT NULL DEFAULT 'UTC', created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.projects (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE public.project_time_entries (
        id uuid PRIMARY KEY, member_id uuid, approval_status text, end_time timestamptz,
        segments jsonb, compensation_rate numeric
      );
      CREATE TABLE public.notifications_log (user_id uuid, title text, message text, link text);
      CREATE FUNCTION public.upsert_notification(uuid, text, text, text, text, text) RETURNS void LANGUAGE sql
        AS $$ INSERT INTO public.notifications_log VALUES ($1, $2, $3, $4) $$;
      CREATE FUNCTION public.handle_updated_at() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
      CREATE FUNCTION public.current_team_member_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
      CREATE FUNCTION public.has_permission(text, text DEFAULT 'app') RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.can_access_project(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    `);
    for (const name of ['project_invoices', 'team_member_earning_adjustments', 'team_member_payouts']) await db.exec(table(name));
    // The allocations table as it stood before this migration: the snapshot
    // already carries the third source, and the migration has to get there itself.
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

    await db.query("INSERT INTO team_members(id, name, role) VALUES ($1, 'Owner', 'owner'), ($2, 'Partner', 'member')", [owner, partner]);
    await db.query("INSERT INTO projects(id, name) VALUES ($1, 'Marketing client'), ($2, 'Other client')", [project, otherProject]);

    const migration = await readFile(new URL(MIGRATION, import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration); // safe to re-run

    // -- The month 1 invoice exists before the retainer does (the backfill case).
    const monthOne = randomUUID();
    await db.query(
      `INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, invoice_type, date, paid_date, line_items)
       VALUES ($1, $2, 'INV-017', 1450, 'paid', 'recurring', '2026-09-16', '2026-09-17', $3::jsonb)`,
      [monthOne, project, JSON.stringify([
        { id: 'hours', position: 0, item_type: 'hourly', amount: 450, description: 'Hours' },
        { id: 'li2', position: 1, item_type: 'recurring', amount: 1000, description: 'Monthly Marketing Retainer - Tier 1 (Prorated)',
          service_start_date: '2026-09-16', service_end_date: '2026-09-30', recurrence_frequency: 'monthly' },
      ])],
    );

    const retainer = (await one<{ r: { id: string } }>(
      'SELECT to_jsonb(save_project_retainer(NULL, $1::jsonb)) r',
      [JSON.stringify({
        project_id: project, name: 'Monthly Marketing Retainer - Tier 1', billing_timing: 'advance',
        start_date: '2026-09-16', amount: 2000,
        shares: [{ member_id: partner, percent: 50 }],
        link_lines: [{ invoice_id: monthOne, line_item_id: 'li2' }],
      })],
    )).r.id;

    // -- Period math.
    const periods = await rows<{ period_start: string; period_end: string; bill_date: string; amount: string; prorated: boolean }>(
      `SELECT period_start::text, period_end::text, bill_date::text, amount::text, prorated
       FROM retainer_periods($1, '2026-09-01', '2026-11-30')`, [retainer]);
    check(periods.length, 3, 'three periods');
    check(periods[0], { period_start: '2026-09-16', period_end: '2026-09-30', bill_date: '2026-09-16', amount: '1000.00', prorated: true }, 'prorated first month');
    check(periods[1], { period_start: '2026-10-01', period_end: '2026-10-31', bill_date: '2026-10-01', amount: '2000.00', prorated: false }, 'full month');

    // -- Backfill: linked in the create transaction, split inherited, earning dated to the paid date.
    check((await one<{ status: string; invoice_id: string }>(
      "SELECT status, invoice_id FROM project_retainer_periods WHERE retainer_id = $1 AND period_start = '2026-09-16'", [retainer])),
      { status: 'invoiced', invoice_id: monthOne }, 'month 1 claimed');
    const earnings = () => rows<{ amount: string; earned_date: string; voided: boolean; reversed: boolean; invoice_number: string }>(
      `SELECT amount::text, earned_date::text, voided_at IS NOT NULL voided, reversed_at IS NOT NULL reversed, invoice_number
       FROM team_member_share_earnings e WHERE member_id = $1 ORDER BY e.created_at, e.amount`, [partner]);
    check(await earnings(), [{ amount: '500.00', earned_date: '2026-09-17', voided: false, reversed: false, invoice_number: 'INV-017' }], 'backfilled earning');
    check((await one<{ n: number }>("SELECT count(*)::int n FROM invoice_line_shares WHERE line_item_id = 'hours'")).n, 0, 'hourly never split');

    // -- The job: nothing due mid September, October drafts the day before the 1st.
    check((await one<{ n: number }>("SELECT generate_retainer_drafts('2026-09-20') n")).n, 0, 'nothing due');
    check((await one<{ n: number }>("SELECT generate_retainer_drafts('2026-09-29') n")).n, 0, 'lead time not reached');
    check((await one<{ n: number }>("SELECT generate_retainer_drafts('2026-09-30') n")).n, 1, 'october drafted');
    check((await one<{ n: number }>("SELECT generate_retainer_drafts('2026-09-30') n")).n, 0, 'idempotent');
    const october = await one<{ id: string; invoice_number: string; amount: string; status: string; date: string; auto_generated: boolean; line: any }>(
      `SELECT id, invoice_number, amount::text, status, date, auto_generated, line_items->0 line
       FROM project_invoices WHERE project_id = $1 AND status = 'draft'`, [project]);
    check([october.invoice_number, october.amount, october.date, october.auto_generated], ['INV-018', '2000.00', '2026-10-01', true], 'draft header');
    check([october.line.item_type, october.line.retainer_id, october.line.service_start_date, october.line.service_end_date, october.line.amount],
      ['recurring', retainer, '2026-10-01', '2026-10-31', 2000], 'draft line');
    check((await one<{ n: number }>('SELECT count(*)::int n FROM notifications_log')).n, 1, 'owner notified');
    check((await earnings()).length, 1, 'a draft earns nothing');

    // -- The line JSON never carries the split.
    check(JSON.stringify(october.line).includes('percent'), false, 'no split in line json');

    // -- Paid, then unpaid with no payout: the earning is voided, not reversed.
    await db.query("UPDATE project_invoices SET status = 'paid', paid_date = '2026-10-03' WHERE id = $1", [october.id]);
    check((await earnings()).map(e => e.amount), ['500.00', '1000.00'], 'october earned');
    await db.query("UPDATE project_invoices SET status = 'sent', paid_date = NULL WHERE id = $1", [october.id]);
    check((await earnings()).filter(e => e.voided).length, 1, 'voided on unpaid');
    check((await one<{ n: number }>('SELECT count(*)::int n FROM team_member_earning_adjustments')).n, 0, 'no deduction without a payout');
    await db.query("UPDATE project_invoices SET status = 'paid', paid_date = '2026-10-05' WHERE id = $1", [october.id]);

    // -- Pay him out, then the invoice is un-paid: earning stays, deduction carries the clawback.
    const live = await rows<{ id: string; amount: string }>(
      'SELECT id, amount::text FROM team_member_share_earnings e WHERE member_id = $1 AND voided_at IS NULL ORDER BY e.amount', [partner]);
    check(live.map(e => e.amount), ['500.00', '1000.00'], 'two live earnings');
    await db.exec("CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'authenticated' $$");
    await db.query('SELECT record_team_member_payout($1, $2, 1500, $3, $4, $5, $6::jsonb)', [
      partner, '2026-10-06', 'ach', '', '',
      JSON.stringify(live.map(e => ({ share_earning_id: e.id, allocated_amount: Number(e.amount) }))),
    ]);
    await rejects(db.query('SELECT record_team_member_payout($1, $2, 1, $3, $4, $5, $6::jsonb)', [
      partner, '2026-10-06', 'ach', '', '', JSON.stringify([{ share_earning_id: live[0].id, allocated_amount: 1 }]),
    ]), /exceeds the remaining source balance/, 'cannot over-allocate a share earning');
    await db.exec("CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role' $$");

    await db.query("UPDATE project_invoices SET status = 'sent', paid_date = NULL WHERE id = $1", [october.id]);
    const afterClawback = await earnings();
    check(afterClawback.filter(e => e.reversed).map(e => e.amount), ['1000.00'], 'paid-out earning reversed, not voided');
    check(await rows("SELECT adjustment_type, amount::text FROM team_member_earning_adjustments"),
      [{ adjustment_type: 'deduction', amount: '1000.00' }], 'deduction written');
    // Net position: earned 500 + 1000 - 1000 = 500, paid 1500, so he owes 1000 back.
    const net = await one<{ n: string }>(
      `SELECT ((SELECT COALESCE(SUM(amount), 0) FROM team_member_share_earnings WHERE voided_at IS NULL)
             - (SELECT COALESCE(SUM(amount), 0) FROM team_member_earning_adjustments WHERE adjustment_type = 'deduction')
             - (SELECT COALESCE(SUM(amount), 0) FROM team_member_payouts))::text n`);
    check(net.n, '-1000.00', 'negative balance carried');

    // -- Re-saving an identical split must not churn a paid-out earning.
    const before = (await earnings()).length;
    await db.query('SELECT set_invoice_line_shares($1, $2::jsonb)', [monthOne, JSON.stringify([{ line_item_id: 'li2', member_id: partner, percent: 50 }])]);
    check((await earnings()).length, before, 'identical split is a no-op');
    await rejects(db.query('SELECT set_invoice_line_shares($1, $2::jsonb)', [monthOne, JSON.stringify([{ line_item_id: 'hours', member_id: partner, percent: 50 }])]),
      /Only fixed and recurring/, 'hourly line cannot be split');
    await rejects(db.query('SELECT set_invoice_line_shares($1, $2::jsonb)', [monthOne, JSON.stringify([{ line_item_id: 'li2', member_id: owner, percent: 50 }])]),
      /can be paid/, 'owner cannot hold a split');

    // -- Deleting a draft skips the period; the job leaves it alone; Generate now brings it back.
    await db.query('DELETE FROM project_invoices WHERE id = $1', [october.id]);
    check((await one<{ status: string }>("SELECT status FROM project_retainer_periods WHERE retainer_id = $1 AND period_start = '2026-10-01'", [retainer])).status, 'skipped', 'deleted draft skips');
    check((await one<{ n: number }>("SELECT generate_retainer_drafts('2026-10-02') n")).n, 0, 'skipped stays skipped');
    const regenerated = await one<{ r: { id: string; invoice_number: string; auto_generated: boolean } }>(
      "SELECT to_jsonb(generate_retainer_period($1, '2026-10-01')) r", [retainer]);
    check(regenerated.r.auto_generated, false, 'generate now is not an auto draft');
    await rejects(db.query("SELECT generate_retainer_period($1, '2026-10-01')", [retainer]), /already on an invoice/, 'no double billing');
    await rejects(db.query(
      `INSERT INTO project_invoices(project_id, invoice_number, amount, status, date, line_items)
       VALUES ($1, 'INV-DUP', 2000, 'draft', '2026-10-01', $2::jsonb)`,
      [project, JSON.stringify([{ id: 'dup', item_type: 'recurring', amount: 2000, service_start_date: '2026-10-10', retainer_id: retainer }])]),
      /already on another invoice/, 'a second line for the same month is refused');
    await rejects(db.query(
      `INSERT INTO project_invoices(project_id, invoice_number, amount, status, date, line_items)
       VALUES ($1, 'INV-X', 2000, 'draft', '2026-11-01', $2::jsonb)`,
      [otherProject, JSON.stringify([{ id: 'x', item_type: 'recurring', amount: 2000, service_start_date: '2026-11-01', retainer_id: retainer }])]),
      /another project/, 'cross-project link refused');

    // -- Removing the line from a draft skips it; cancelling does too.
    await db.query("UPDATE project_invoices SET line_items = '[]'::jsonb, amount = 0 WHERE id = $1", [regenerated.r.id]);
    check((await one<{ status: string }>("SELECT status FROM project_retainer_periods WHERE retainer_id = $1 AND period_start = '2026-10-01'", [retainer])).status, 'skipped', 'removed line skips');
    const offered = await rows<{ period_start: string; skipped: boolean }>('SELECT period_start::text, skipped FROM retainer_due_periods($1)', [project]);
    check(offered.some(o => o.period_start === '2026-10-01' && o.skipped), true, 'form offers the skipped period');

    // -- Tier change and a split change, both dated.
    await db.query("SELECT schedule_retainer_amount($1, 3000, '2026-12-01')", [retainer]);
    await db.query("SELECT set_retainer_shares($1, $2::jsonb, '2026-12-01')", [retainer, JSON.stringify([{ member_id: partner, percent: 40 }])]);
    const priced = await rows<{ period_start: string; amount: string }>(
      "SELECT period_start::text, amount::text FROM retainer_periods($1, '2026-11-01', '2026-12-31')", [retainer]);
    check(priced, [{ period_start: '2026-11-01', amount: '2000.00' }, { period_start: '2026-12-01', amount: '3000.00' }], 'dated amount history');
    await db.query("SELECT generate_retainer_drafts('2026-11-30')", []);
    const split = await rows<{ start: string; percent: string }>(
      `SELECT line.value->>'service_start_date' AS start, share.percent::text
       FROM project_invoices invoice, jsonb_array_elements(invoice.line_items) line
       JOIN invoice_line_shares share ON share.line_item_id = line.value->>'id'
       WHERE invoice.project_id = $1 AND share.invoice_id = invoice.id AND invoice.status = 'draft'
       ORDER BY 1`, [project]);
    check(split, [{ start: '2026-11-01', percent: '50.00' }, { start: '2026-12-01', percent: '40.00' }], 'split resolved on the period start');
    await rejects(db.query("SELECT set_retainer_shares($1, $2::jsonb, '2027-01-01')", [retainer,
      JSON.stringify([{ member_id: partner, percent: 60 }, { member_id: partner, percent: 50 }])]), /already has a split|more than 100/, 'split rules enforced');

    // -- Arrears bills the month that just ended; a paused retainer records skips instead of drafts.
    const arrears = (await one<{ r: { id: string } }>('SELECT to_jsonb(save_project_retainer(NULL, $1::jsonb)) r', [JSON.stringify({
      project_id: otherProject, name: 'SEO', billing_timing: 'arrears', start_date: '2026-10-01', amount: 900, lead_days: 0,
    })])).r.id;
    check((await one<{ n: number }>("SELECT generate_retainer_drafts('2026-10-31') n")).n, 0, 'arrears not due during the month');
    check((await one<{ n: number }>("SELECT generate_retainer_drafts('2026-11-01') n")).n, 1, 'arrears due the day after');
    const arrearsLine = await one<{ line: any; date: string }>(
      "SELECT line_items->0 line, date FROM project_invoices WHERE project_id = $1", [otherProject]);
    check([arrearsLine.date, arrearsLine.line.service_start_date, arrearsLine.line.service_end_date], ['2026-11-01', '2026-10-01', '2026-10-31'], 'arrears covers the past month');
    await db.query("SELECT save_project_retainer($1, '{\"status\":\"paused\"}'::jsonb)", [arrears]);
    check((await one<{ n: number }>("SELECT generate_retainer_drafts('2026-12-01') n")).n, 0, 'paused drafts nothing');
    check((await one<{ status: string }>("SELECT status FROM project_retainer_periods WHERE retainer_id = $1 AND period_start = '2026-11-01'", [arrears])).status, 'skipped', 'pause records a skip');

    // -- Live accrual: the month covering today, only while it has no line and is not skipped.
    const monthStart = new Date().toISOString().slice(0, 8) + '01';
    const liveRetainer = (await one<{ r: { id: string } }>('SELECT to_jsonb(save_project_retainer(NULL, $1::jsonb)) r', [JSON.stringify({
      project_id: otherProject, name: 'Live', billing_timing: 'arrears', start_date: monthStart, amount: 3000,
      shares: [{ member_id: partner, percent: 25 }],
    })])).r.id;
    check(await rows('SELECT amount::text, share_percent::text FROM retainer_accruing_lines() WHERE retainer_id = $1', [liveRetainer]),
      [{ amount: '3000.00', share_percent: '25.00' }], 'current month accrues from the retainer');
    await db.query('SELECT generate_retainer_period($1, $2)', [liveRetainer, monthStart]);
    check((await rows('SELECT 1 FROM retainer_accruing_lines() WHERE retainer_id = $1', [liveRetainer])).length, 0, 'a real line takes over');

    // -- Ending mid month prorates the last line.
    await db.query("SELECT save_project_retainer($1, '{\"end_date\":\"2027-01-10\"}'::jsonb)", [retainer]);
    const last = await rows<{ period_end: string; amount: string }>(
      "SELECT period_end::text, amount::text FROM retainer_periods($1, '2027-01-01', '2027-03-31')", [retainer]);
    check(last, [{ period_end: '2027-01-10', amount: '967.74' }], 'final month prorated, nothing after');

    // -- Deleting a paid invoice that was paid out also reverses.
    await db.query('DELETE FROM project_invoices WHERE id = $1', [monthOne]);
    check((await earnings()).filter(e => e.reversed).length, 2, 'delete reverses a paid-out earning');

    // -- A project delete cascades cleanly through all of it.
    await db.query('DELETE FROM projects WHERE id = $1', [project]);
    check((await one<{ n: number }>('SELECT count(*)::int n FROM project_retainers WHERE project_id = $1', [project])).n, 0, 'project cascade');

    console.log(`Project retainers: periods, drafting, splits, reversals and payouts: ${checks} assertions passed.`);
  } finally {
    await db.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
