/**
 * Invoice payments (20261018205406_invoice_payments.sql) on a real Postgres
 * (PGlite): partial, full and over-limit payments, external_id replays,
 * status derivation both ways, the direct status write path (RLS, as a
 * member), payments that pin an invoice, one invoice webhook per change, the
 * backfill, and the paid-out revenue split refusal.
 *
 *   npm run -s test:invoice-payments
 */
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { invoiceTotal } from '../src/lib/invoice-payments';
import { asMember, createPaymentsDatabase } from './invoice-payments-db';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 1500)}`);
}
async function rejects(label: string, work: Promise<unknown>, pattern: RegExp) {
  try {
    await work;
    check(label, false, 'did not fail');
  } catch (error) {
    check(label, pattern.test((error as Error).message), (error as Error).message);
  }
}

const today = new Date().toISOString().slice(0, 10);
const project = randomUUID();

async function main() {
  // Invoices that exist before the migration, for the backfill.
  const legacy = {
    plain: randomUUID(), stamped: randomUUID(), undated: randomUUID(), badDate: randomUUID(), zero: randomUUID(), sent: randomUUID(),
  };
  let before: unknown[] = [];
  let eventsBefore = 0;
  const db: PGlite = await createPaymentsDatabase({
    beforePayments: async (db) => {
      await db.query("INSERT INTO projects(id, name) VALUES ($1, 'Payments project')", [project]);
      await db.query("INSERT INTO webhook_endpoints(name, url, secret, events) VALUES ('All', 'https://example.test/hook', 'whsec_x', ARRAY['invoice.paid','invoice.updated','invoice.deleted','invoice.payment_recorded','invoice.payment_removed'])");
      const add = (id: string, number: string, amount: number, status: string, date: string, paid: string | null) =>
        db.query("INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, date, paid_date) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [id, project, number, amount, status, date, paid]);
      await add(legacy.plain, 'L-1', 1200, 'paid', '2026-02-01', '2026-03-05');
      await add(legacy.stamped, 'L-2', 300.5, 'paid', '2026-02-01', '2026-03-07T18:00:00.000Z');
      await add(legacy.undated, 'L-3', 99, 'paid', '2026-02-11', null);
      await add(legacy.badDate, 'L-4', 50, 'paid', '2026-02-12', 'on delivery');
      await add(legacy.zero, 'L-5', 0, 'paid', '2026-02-13', '2026-02-13');
      await add(legacy.sent, 'L-6', 400, 'sent', '2026-02-14', null);
      before = (await db.query('SELECT to_jsonb(i) j FROM project_invoices i ORDER BY id')).rows;
      eventsBefore = Number((await db.query<{ n: number }>('SELECT count(*)::int n FROM webhook_events')).rows[0].n);
    },
  });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];

  try {
    // -- Backfill -----------------------------------------------------------
    const after = await q('SELECT to_jsonb(i) j FROM project_invoices i ORDER BY id');
    check('backfill changes no invoice row', JSON.stringify(after) === JSON.stringify(before));
    check('backfill raises no webhook', Number((await one<{ n: number }>('SELECT count(*)::int n FROM webhook_events')).n) === eventsBefore);
    const filled = await q<{ invoice_id: string; amount: string; paid_date: string; recorded_via: string }>(
      "SELECT invoice_id, amount::text, paid_date::text, recorded_via FROM invoice_payments");
    const by = new Map(filled.map((row) => [row.invoice_id, row]));
    check('one hand payment per paid invoice with an amount (not $0, not unpaid), even after two runs',
      filled.length === 4 && !by.has(legacy.zero) && !by.has(legacy.sent) && filled.every((row) => row.recorded_via === 'app'), filled);
    check('dated by paid_date, its leading date, else the invoice date',
      by.get(legacy.plain)?.paid_date === '2026-03-05' && by.get(legacy.stamped)?.paid_date === '2026-03-07'
      && by.get(legacy.undated)?.paid_date === '2026-02-11' && by.get(legacy.badDate)?.paid_date === '2026-02-12', filled);
    check('backfilled amount is the invoice amount', by.get(legacy.stamped)?.amount === '300.50');

    const events = async (invoice: string) =>
      (await q<{ event_type: string; payload: Record<string, any> }>(
        'SELECT event_type, payload FROM webhook_events WHERE resource_id = $1 ORDER BY sequence', [invoice]));
    const invoice = (id: string) => one<{ status: string; paid_date: string | null; updated_at: string; amount: string }>(
      'SELECT status, paid_date, updated_at::text, amount::text FROM project_invoices WHERE id = $1', [id]);
    const record = (id: string, payment: Record<string, unknown>) =>
      one<{ r: { payment: Record<string, any>; replayed: boolean } }>('SELECT record_invoice_payment($1, $2::jsonb) r', [id, JSON.stringify(payment)]).then((row) => row.r);
    const newInvoice = async (amount: number, status = 'sent', due: string | null = '2999-01-01') => {
      const id = randomUUID();
      await q("INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, date, due_date) VALUES ($1,$2,$3,$4,$5,'2026-06-01',$6)",
        [id, project, 'N-' + id.slice(0, 6), amount, status, due]);
      return id;
    };

    // -- Partial, full, over the limit, replay ------------------------------
    const a = await newInvoice(1000);
    const stamp0 = (await invoice(a)).updated_at;
    const first = await record(a, { amount: 400, paid_date: '2026-06-10', method: 'ach', external_id: 'bank:1', recorded_via: 'api' });
    check('a partial payment is recorded and the invoice stays sent', !first.replayed && (await invoice(a)).status === 'sent');
    check('a partial payment bumps updated_at', (await invoice(a)).updated_at !== stamp0);
    check('a partial payment raises payment_recorded and no invoice event',
      JSON.stringify((await events(a)).map((e) => e.event_type)) === JSON.stringify(['invoice.payment_recorded']), await events(a));
    const replay = await record(a, { amount: 400, paid_date: '2026-06-10', method: 'ach', external_id: 'bank:1', recorded_via: 'api' });
    check('the same external_id and payload replays the same row', replay.replayed && replay.payment.id === first.payment.id);
    check('a replay records nothing new', Number((await one<{ n: number }>('SELECT count(*)::int n FROM invoice_payments WHERE invoice_id=$1', [a])).n) === 1);
    await rejects('the same external_id with another amount is a conflict',
      record(a, { amount: 401, paid_date: '2026-06-10', method: 'ach', external_id: 'bank:1' }), /^PAYMENT_EXTERNAL_ID_CONFLICT/);
    await rejects('more than outstanding is refused', record(a, { amount: 600.01, paid_date: '2026-06-11' }), /^PAYMENT_EXCEEDS_OUTSTANDING/);
    await rejects('three decimals are refused', record(a, { amount: 1.005, paid_date: '2026-06-11' }), /^PAYMENT_INVALID/);
    await rejects('an unknown method is refused', record(a, { amount: 1, paid_date: '2026-06-11', method: 'crypto' }), /^PAYMENT_INVALID/);
    await rejects('a bad date is refused', record(a, { amount: 1, paid_date: '2026-02-30' }), /^PAYMENT_INVALID/);
    const rest = await record(a, { amount: 600, paid_date: '2026-06-20', external_id: 'bank:2', recorded_via: 'api' });
    let state = await invoice(a);
    check('paying the rest marks the invoice paid on the latest payment date', state.status === 'paid' && state.paid_date === '2026-06-20', state);
    let types = (await events(a)).map((e) => e.event_type);
    check('payment_recorded comes first, then exactly one invoice.paid',
      JSON.stringify(types) === JSON.stringify(['invoice.payment_recorded', 'invoice.payment_recorded', 'invoice.paid']), types);
    const recorded = (await events(a))[1].payload.data;
    check('the payment event carries the payment, the derived status and what is outstanding',
      recorded.payment.amount === 600 && recorded.payment.external_id === 'bank:2' && recorded.invoice.status === 'paid'
      && recorded.paid_total === 1000 && recorded.outstanding === 0, recorded);
    await rejects('a paid invoice takes nothing more', record(a, { amount: 1, paid_date: '2026-06-21' }), /^PAYMENT_EXCEEDS_OUTSTANDING/);

    // -- Removing a payment un-pays: sent, or overdue when past due ----------
    await q("SELECT remove_invoice_payment($1, 'api')", [rest.payment.id]);
    state = await invoice(a);
    check('removing a payment below the amount reverts paid to sent (not yet due) and clears paid_date', state.status === 'sent' && state.paid_date === null, state);
    types = (await events(a)).map((e) => e.event_type).slice(3);
    check('removal raises payment_removed then exactly one invoice.updated',
      JSON.stringify(types) === JSON.stringify(['invoice.payment_removed', 'invoice.updated']), types);
    const late = await newInvoice(200, 'overdue', '2026-01-31');
    const latePay = await record(late, { amount: 200, paid_date: '2026-06-02', recorded_via: 'api' });
    check('an overdue invoice paid in full becomes paid', (await invoice(late)).status === 'paid');
    await q("SELECT remove_invoice_payment($1, 'api')", [latePay.payment.id]);
    check('removed again past its due date it is overdue', (await invoice(late)).status === 'overdue');
    await rejects('a draft takes no payment', record(await newInvoice(100, 'draft'), { amount: 10, paid_date: today }), /^INVOICE_NOT_PAYABLE/);
    await rejects('a cancelled invoice takes no payment', record(await newInvoice(100, 'cancelled'), { amount: 10, paid_date: today }), /^INVOICE_NOT_PAYABLE/);
    await rejects('an unknown invoice', record(randomUUID(), { amount: 10, paid_date: today }), /^INVOICE_NOT_FOUND/);

    // -- The status dropdown, written straight to the table as a member ----
    const b = await newInvoice(500);
    await asMember(db, () => q("UPDATE project_invoices SET status = 'paid', paid_date = '2026-06-20' WHERE id = $1", [b]));
    let payments = await q<{ amount: string; paid_date: string; recorded_via: string }>(
      'SELECT amount::text, paid_date::text, recorded_via FROM invoice_payments WHERE invoice_id = $1', [b]);
    check('marking paid by hand records one hand payment for the whole amount on paid_date',
      payments.length === 1 && payments[0].amount === '500.00' && payments[0].paid_date === '2026-06-20' && payments[0].recorded_via === 'app', payments);
    types = (await events(b)).map((e) => e.event_type);
    check('marking paid raises payment_recorded and exactly one invoice.paid',
      JSON.stringify(types) === JSON.stringify(['invoice.payment_recorded', 'invoice.paid']), types);
    await asMember(db, () => q("UPDATE project_invoices SET paid_date = '2026-06-25' WHERE id = $1", [b]));
    payments = await q('SELECT amount::text, paid_date::text, recorded_via FROM invoice_payments WHERE invoice_id = $1', [b]);
    check('editing paid_date moves the one hand payment', payments.length === 1 && payments[0].paid_date === '2026-06-25', payments);
    await asMember(db, () => q('UPDATE project_invoices SET amount = 450 WHERE id = $1', [b]));
    payments = await q('SELECT amount::text, paid_date::text, recorded_via FROM invoice_payments WHERE invoice_id = $1', [b]);
    check('editing the amount of a paid invoice moves its one hand payment', payments.length === 1 && payments[0].amount === '450.00', payments);
    types = (await events(b)).map((e) => e.event_type).slice(2);
    check('each edit of a paid invoice raises exactly one invoice.updated',
      JSON.stringify(types) === JSON.stringify(['invoice.updated', 'invoice.updated']), types);
    await asMember(db, () => q("UPDATE project_invoices SET description = 'Renamed' WHERE id = $1", [b]));
    check('an edit that does not touch payments raises nothing new', (await events(b)).length === 4);
    await asMember(db, () => q("UPDATE project_invoices SET status = 'sent', paid_date = NULL WHERE id = $1", [b]));
    check('moving off paid by hand removes its hand payments',
      Number((await one<{ n: number }>('SELECT count(*)::int n FROM invoice_payments WHERE invoice_id=$1', [b])).n) === 0);
    types = (await events(b)).map((e) => e.event_type).slice(4);
    check('moving off paid raises payment_removed and exactly one invoice.updated',
      JSON.stringify(types) === JSON.stringify(['invoice.payment_removed', 'invoice.updated']), types);
    await rejects('a member cannot write payments directly',
      asMember(db, () => q("INSERT INTO invoice_payments(invoice_id, amount, paid_date) VALUES ($1, 1, '2026-06-01')", [b])), /permission denied/);
    await rejects('a member cannot delete payments directly',
      asMember(db, () => q('DELETE FROM invoice_payments WHERE invoice_id = $1', [a])), /permission denied/);
    check('a member reads payments through RLS',
      (await asMember(db, () => q('SELECT id FROM invoice_payments WHERE invoice_id = $1', [a]))).length === 1);

    // The save RPC (the invoice form and the API) goes through the same trigger.
    const viaRpc = await newInvoice(80);
    await q("SELECT save_project_invoice_with_allocations($1, $2::jsonb, NULL)", [viaRpc, JSON.stringify({ status: 'paid', paid_date: '2026-07-01' })]);
    check('saving as paid through the invoice RPC records the payment',
      (await one<{ s: string }>("SELECT sum(amount)::text s FROM invoice_payments WHERE invoice_id = $1", [viaRpc])).s === '80.00');
    check('...with exactly one invoice.paid', (await events(viaRpc)).filter((e) => e.event_type === 'invoice.paid').length === 1);
    const createdPaid = randomUUID();
    await q("INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, date) VALUES ($1,$2,'P-NEW',75,'paid','2026-07-02')", [createdPaid, project]);
    const createdPayment = await one<{ amount: string; paid_date: string }>('SELECT amount::text, paid_date::text FROM invoice_payments WHERE invoice_id = $1', [createdPaid]);
    check('an invoice created as paid records its payment, dated today without a paid_date',
      createdPayment?.amount === '75.00' && createdPayment.paid_date === today, createdPayment);
    check('...and gets that paid date itself', (await invoice(createdPaid)).paid_date === today);
    types = (await events(createdPaid)).map((e) => e.event_type);
    check('...its payment event comes before the invoice event',
      types[0] === 'invoice.payment_recorded' && types.length === 2, types);

    // -- A hand partial payment, then the dropdown --------------------------
    const c = await newInvoice(1000);
    const handPartial = await asMember(db, () => record(c, { amount: 300, paid_date: '2026-06-05', method: 'check', recorded_via: 'api' }));
    check('a member records a payment by hand (recorded_via is app whatever is sent)', handPartial.payment.recorded_via === 'app');
    await asMember(db, () => q("UPDATE project_invoices SET status = 'paid', paid_date = '2026-06-30' WHERE id = $1", [c]));
    const topUp = await q<{ amount: string }>("SELECT amount::text FROM invoice_payments WHERE invoice_id = $1 ORDER BY amount", [c]);
    check('marking a partly paid invoice paid records only the rest', JSON.stringify(topUp.map((p) => p.amount)) === JSON.stringify(['300.00', '700.00']), topUp);
    check('...with exactly one invoice.paid', (await events(c)).filter((e) => e.event_type === 'invoice.paid').length === 1);

    // A partly paid invoice whose amount comes down to what was paid is paid.
    const d = await newInvoice(500);
    await record(d, { amount: 200, paid_date: '2026-06-03' });
    await asMember(db, () => q('UPDATE project_invoices SET amount = 200 WHERE id = $1', [d]));
    state = await invoice(d);
    check('lowering the amount to what was paid marks it paid', state.status === 'paid' && state.paid_date === '2026-06-03', state);

    // -- Editing a paid invoice never rewrites recorded payments ------------
    const amounts = async (id: string) =>
      (await q<{ amount: string; paid_date: string }>('SELECT amount::text, paid_date::text FROM invoice_payments WHERE invoice_id = $1 ORDER BY amount', [id]))
        .map((p) => `${p.amount}@${p.paid_date}`);
    const checkThenWire = await newInvoice(1000);
    await asMember(db, () => record(checkThenWire, { amount: 300, paid_date: '2026-06-05', method: 'check' }));
    await asMember(db, () => q("UPDATE project_invoices SET status = 'paid', paid_date = '2026-06-30' WHERE id = $1", [checkThenWire]));
    const checkThenWireEvents = (await events(checkThenWire)).length;
    await asMember(db, () => q('UPDATE project_invoices SET amount = 1200 WHERE id = $1', [checkThenWire]));
    state = await invoice(checkThenWire);
    check('raising a paid invoice above its payments makes it unpaid again', state.status === 'sent' && state.paid_date === null, state);
    check('...with its payments as recorded and none invented',
      JSON.stringify(await amounts(checkThenWire)) === JSON.stringify(['300.00@2026-06-05', '700.00@2026-06-30']), await amounts(checkThenWire));
    types = (await events(checkThenWire)).slice(checkThenWireEvents).map((e) => e.event_type);
    check('...raising exactly one invoice.updated', JSON.stringify(types) === JSON.stringify(['invoice.updated']), types);
    const wired = await newInvoice(400);
    await record(wired, { amount: 400, paid_date: '2026-06-08', method: 'wire', reference: 'W-1' });
    await asMember(db, () => q("UPDATE project_invoices SET paid_date = '2026-06-28' WHERE id = $1", [wired]));
    state = await invoice(wired);
    check('a paid date edit keeps a recorded payment, and the paid date stays the payment date',
      state.status === 'paid' && state.paid_date === '2026-06-08' && JSON.stringify(await amounts(wired)) === JSON.stringify(['400.00@2026-06-08']),
      { state, payments: await amounts(wired) });
    await asMember(db, () => q('UPDATE project_invoices SET amount = 350 WHERE id = $1', [wired]));
    check('lowering a paid invoice keeps its recorded payment and stays paid',
      (await invoice(wired)).status === 'paid' && JSON.stringify(await amounts(wired)) === JSON.stringify(['400.00@2026-06-08']), await amounts(wired));

    // -- Payments from an accounting connection pin the invoice ------------
    const e = await newInvoice(250);
    const api = await record(e, { amount: 250, paid_date: '2026-06-15', external_id: 'books:1', recorded_via: 'api', api_key_id: null });
    await rejects('moving an invoice with connection payments off paid is refused',
      asMember(db, () => q("UPDATE project_invoices SET status = 'sent' WHERE id = $1", [e])), /^PAYMENT_RECORDED_ELSEWHERE/);
    await rejects('cancelling it is refused', asMember(db, () => q("UPDATE project_invoices SET status = 'cancelled' WHERE id = $1", [e])), /^PAYMENT_RECORDED_ELSEWHERE/);
    await rejects('deleting it is refused', asMember(db, () => q('DELETE FROM project_invoices WHERE id = $1', [e])), /^PAYMENT_RECORDED_ELSEWHERE/);
    await rejects('a member cannot remove a connection payment', asMember(db, () => q('SELECT remove_invoice_payment($1)', [api.payment.id])), /^PAYMENT_RECORDED_ELSEWHERE/);
    await rejects('a key cannot remove a hand payment',
      q("SELECT remove_invoice_payment($1, 'api')", [handPartial.payment.id]), /^PAYMENT_RECORDED_ELSEWHERE/);
    const sentWithPartial = await newInvoice(900);
    await record(sentWithPartial, { amount: 100, paid_date: '2026-06-01', recorded_via: 'api' });
    await rejects('setting a partly paid (by a connection) invoice to draft is refused',
      asMember(db, () => q("UPDATE project_invoices SET status = 'draft' WHERE id = $1", [sentWithPartial])), /^PAYMENT_RECORDED_ELSEWHERE/);
    const handOnly = await newInvoice(900);
    await asMember(db, () => record(handOnly, { amount: 100, paid_date: '2026-06-01' }));
    await asMember(db, () => q("UPDATE project_invoices SET status = 'cancelled' WHERE id = $1", [handOnly]));
    check('cancelling an invoice with only hand payments removes them',
      Number((await one<{ n: number }>('SELECT count(*)::int n FROM invoice_payments WHERE invoice_id=$1', [handOnly])).n) === 0);
    const deletable = await newInvoice(60);
    await asMember(db, () => q("UPDATE project_invoices SET status = 'paid' WHERE id = $1", [deletable]));
    await asMember(db, () => q('DELETE FROM project_invoices WHERE id = $1', [deletable]));
    check('a paid invoice with only its hand payment can still be deleted, raising one invoice.deleted',
      (await events(deletable)).filter((e) => e.event_type === 'invoice.deleted').length === 1
      && Number((await one<{ n: number }>('SELECT count(*)::int n FROM invoice_payments WHERE invoice_id=$1', [deletable])).n) === 0);
    const removedApi = await q("SELECT remove_invoice_payment($1, 'api') r", [api.payment.id]);
    check('the key removes its own payment', removedApi.length === 1 && (await invoice(e)).status === 'sent');

    // A project delete cascades through invoices even with connection payments.
    const other = randomUUID();
    await q("INSERT INTO projects(id, name) VALUES ($1, 'Doomed')", [other]);
    const doomed = randomUUID();
    await q("INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, date) VALUES ($1,$2,'D-1',40,'sent','2026-06-01')", [doomed, other]);
    await record(doomed, { amount: 40, paid_date: '2026-06-02', recorded_via: 'api' });
    await q('DELETE FROM projects WHERE id = $1', [other]);
    check('deleting a project removes its invoices and their payments',
      Number((await one<{ n: number }>('SELECT count(*)::int n FROM invoice_payments WHERE invoice_id=$1', [doomed])).n) === 0);

    // -- Revenue split already paid out -------------------------------------
    const member = randomUUID();
    await q("INSERT INTO team_members(id, name, role) VALUES ($1, 'Partner', 'member')", [member]);
    const split = randomUUID();
    await q(`INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, date, due_date, line_items)
             VALUES ($1,$2,'S-1',1000,'sent','2026-06-01','2999-01-01',$3::jsonb)`,
      [split, project, JSON.stringify([{ id: 'retainer', item_type: 'fixed', amount: 1000, description: 'Retainer', position: 0 }])]);
    await q("INSERT INTO invoice_line_shares(invoice_id, line_item_id, member_id, percent) VALUES ($1, 'retainer', $2, 20)", [split, member]);
    const splitPayment = await record(split, { amount: 1000, paid_date: '2026-06-20', recorded_via: 'api' });
    const earning = await one<{ id: string; amount: string }>('SELECT id, amount::text FROM team_member_share_earnings WHERE invoice_id = $1 AND voided_at IS NULL', [split]);
    check('the paid split line earns its share', earning?.amount === '200.00', earning);
    const payout = randomUUID();
    await q("INSERT INTO team_member_payouts(id, member_id, payment_date, amount) VALUES ($1, $2, '2026-06-30', 200)", [payout, member]);
    await q('INSERT INTO team_member_payout_allocations(payout_id, share_earning_id, allocated_amount) VALUES ($1, $2, 200)', [payout, earning.id]);
    await rejects('removing a payment that un-pays a paid-out split is refused',
      q("SELECT remove_invoice_payment($1, 'api')", [splitPayment.payment.id]), /^PAYMENT_SHARES_PAID_OUT/);
    check('...and the invoice stays paid with its earning intact',
      (await invoice(split)).status === 'paid'
      && (await one<{ n: number }>('SELECT count(*)::int n FROM team_member_share_earnings WHERE id = $1 AND voided_at IS NULL AND reversed_at IS NULL', [earning.id])).n === 1);
    await q('UPDATE team_member_payouts SET voided_at = now() WHERE id = $1', [payout]);
    await q("SELECT remove_invoice_payment($1, 'api')", [splitPayment.payment.id]);
    check('once the payout is voided the payment can go, and the earning is voided',
      (await invoice(split)).status === 'sent'
      && (await one<{ v: boolean }>('SELECT voided_at IS NOT NULL v FROM team_member_share_earnings WHERE id = $1', [earning.id])).v === true);

    // -- Tax: what is owed is the PDF total ---------------------------------
    const taxed = randomUUID();
    await q("INSERT INTO projects(id, name, tax_rate) VALUES ($1, 'Taxed', 10)", [taxed]);
    const taxedInvoice = async (status: string) => {
      const id = randomUUID();
      await q(`INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, date, due_date, line_items)
               VALUES ($1,$2,$3,150,$4,'2026-06-01','2999-01-01',$5::jsonb)`,
        [id, taxed, 'T-' + id.slice(0, 6), status, JSON.stringify([
          { id: 'work', item_type: 'fixed', amount: 100, description: 'Work', position: 0 },
          { id: 'cost', item_type: 'reimbursement', amount: 50, description: 'Cost', position: 1 },
        ])]);
      return id;
    };
    const t1 = await taxedInvoice('sent');
    check('the total is the amount plus tax on all but reimbursements',
      (await one<{ t: string }>('SELECT invoice_total(i)::text t FROM project_invoices i WHERE id = $1', [t1])).t === '160.00');
    await record(t1, { amount: 150, paid_date: '2026-06-10' });
    check('paying the pre-tax amount leaves it partly paid', (await invoice(t1)).status === 'sent');
    await rejects('the tax is the most that is still outstanding', record(t1, { amount: 10.01, paid_date: '2026-06-11' }), /^PAYMENT_EXCEEDS_OUTSTANDING/);
    await record(t1, { amount: 10, paid_date: '2026-06-11' });
    check('paying the tax too marks it paid', (await invoice(t1)).status === 'paid');
    const t2 = await taxedInvoice('sent');
    await asMember(db, () => q("UPDATE project_invoices SET status = 'paid', paid_date = '2026-06-12' WHERE id = $1", [t2]));
    check('marking a taxed invoice paid records the total',
      (await one<{ s: string }>('SELECT sum(amount)::text s FROM invoice_payments WHERE invoice_id = $1', [t2])).s === '160.00');
    // Tax that lands on a half cent rounds the same in SQL and in the app
    // (2.10 at 7.5% is 0.1575; floating point alone gives 0.15).
    const halfCent = randomUUID();
    const halfCentProject = randomUUID();
    await q("INSERT INTO projects(id, name, tax_rate) VALUES ($1, 'Half cent', 7.5)", [halfCentProject]);
    const halfCentLines = [{ id: 'w', item_type: 'fixed', amount: 2.1, description: 'Work', position: 0 }];
    await q(`INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, date, line_items)
             VALUES ($1,$2,'H-1',2.10,'sent','2026-06-01',$3::jsonb)`, [halfCent, halfCentProject, JSON.stringify(halfCentLines)]);
    const sqlTotal = (await one<{ t: string }>('SELECT invoice_total(i)::text t FROM project_invoices i WHERE id = $1', [halfCent])).t;
    const appTotal = invoiceTotal({ id: halfCent, amount: 2.1, invoice_type: 'fixed', line_items: halfCentLines as never }, 7.5);
    check('the app totals tax to the cent as SQL does', sqlTotal === '2.26' && appTotal === 2.26, { sqlTotal, appTotal });

    // -- Webhook payload basics ---------------------------------------------
    const removedEvent = (await events(a)).find((e) => e.event_type === 'invoice.payment_removed')!.payload;
    check('payment_removed names the removed payment and the status it led to',
      removedEvent.data.payment.id === rest.payment.id && removedEvent.data.invoice.status === 'sent' && removedEvent.data.outstanding === 600, removedEvent.data);
    check('two-argument event writers still work (invoice.paid has no payment block)',
      !('payment' in ((await events(a)).find((e) => e.event_type === 'invoice.paid')!.payload.data)));
  } finally {
    await db.close();
  }

  // schema.sql's own copy builds the same behavior.
  const snapshot = await createPaymentsDatabase({ fromSchema: true });
  try {
    const id = randomUUID();
    await snapshot.query("INSERT INTO projects(id, name) VALUES ($1, 'Snapshot')", [project]);
    await snapshot.query("INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, date) VALUES ($1,$2,'S-1',100,'sent','2026-06-01')", [id, project]);
    await snapshot.query("SELECT record_invoice_payment($1, '{\"amount\": 100, \"paid_date\": \"2026-06-09\"}'::jsonb)", [id]);
    const row = (await snapshot.query<{ status: string; paid_date: string }>('SELECT status, paid_date FROM project_invoices WHERE id = $1', [id])).rows[0];
    check('the schema.sql snapshot applies and derives status the same way', row.status === 'paid' && row.paid_date === '2026-06-09', row);
  } finally {
    await snapshot.close();
  }

  if (failures.length) {
    console.error(`invoice payments: ${passed} passed, ${failures.length} failed`);
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`invoice payments: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
