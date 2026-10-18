/**
 * The accounting-tool API over invoice payments, run as real route handlers
 * (withApi, real supabase-js) against PGlite behind fake-postgrest:
 *   GET    /api/v1/invoices
 *   GET    /api/v1/projects/:id/invoices/:invoiceId/payments
 *   POST   /api/v1/projects/:id/invoices/:invoiceId/payments
 *   DELETE /api/v1/projects/:id/invoices/:invoiceId/payments/:paymentId
 *   GET    /api/v1/billing/earned-work
 * Earned time is tied to invoice_unbilled_slices and the portal's uninvoiced
 * figure for the same project.
 *
 *   npm run -s test:invoice-payments
 */
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { startFakePostgrest } from './fake-postgrest';
import { createPaymentsDatabase } from './invoice-payments-db';

const EARNED_MIGRATION = '../supabase/migrations/20261018210624_billing_earned_work.sql';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 1500)}`);
}

const OWNER = randomUUID();
const MEMBER = randomUUID();
const P1 = randomUUID(); // hourly, has a primary client
const P2 = randomUUID(); // time included in a fixed fee
const P3 = randomUUID(); // hourly, for the earned-work tie-out
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

async function seedAccess(db: PGlite) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS public.business_settings (id serial PRIMARY KEY, api_enabled boolean NOT NULL DEFAULT true);
    INSERT INTO public.business_settings DEFAULT VALUES;
    CREATE TABLE public.team_member_permissions (member_id uuid, permission_key text, access_channel text, effect text);
    CREATE TABLE public.project_members (member_id uuid, project_id uuid);
    CREATE TABLE public.api_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), method text, endpoint text, entity_type text,
      entity_id uuid, api_key_id uuid, team_member_id uuid, request_body jsonb, before_snapshot jsonb, after_snapshot jsonb,
      status_code integer, error text, via text NOT NULL DEFAULT 'rest', created_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'reset_at', now() + make_interval(secs => p_window_seconds)) $$;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
  `);
  await db.query("INSERT INTO team_members(id, name, role) VALUES ($1, 'Owner', 'owner'), ($2, 'Books bot', 'member')", [OWNER, MEMBER]);
  // A member who sees only P1, allowed the invoice scopes on the API by override.
  for (const key of ['projects.read', 'invoices.read', 'invoices.record_payments']) {
    await db.query("INSERT INTO team_member_permissions VALUES ($1, $2, 'api', 'allow')", [MEMBER, key]);
  }
  await db.query('INSERT INTO project_members VALUES ($1, $2)', [MEMBER, P1]);
}

async function insertKey(db: PGlite, member: string, scopes: string[], name: string) {
  const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
  const id = randomUUID();
  await db.query("INSERT INTO api_keys(id, name, key_prefix, key_hash, team_member_id, scopes, permissions) VALUES ($1, $2, 'pk_live', $3, $4, $5, 'scoped')",
    [id, name, hash(secret), member, scopes]);
  return { secret, id };
}

function monthStart(offset: number) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
}
function monthEnd(offset: number) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0)).toISOString().slice(0, 10);
}

async function main() {
  process.env.TZ = 'UTC';
  const db = await createPaymentsDatabase({ extraMigrations: [EARNED_MIGRATION] });
  await seedAccess(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

  try {
    const list = await import('../src/app/api/v1/invoices/route');
    const payments = await import('../src/app/api/v1/projects/[id]/invoices/[invoiceId]/payments/route');
    const payment = await import('../src/app/api/v1/projects/[id]/invoices/[invoiceId]/payments/[paymentId]/route');
    const invoiceRoute = await import('../src/app/api/v1/projects/[id]/invoices/[invoiceId]/route');
    const earned = await import('../src/app/api/v1/billing/earned-work/route');
    const { summariseInvoices } = await import('../src/components/portal/stats');
    const { totalBillableAmount } = await import('../src/lib/invoice-utils');

    const owner = await insertKey(db, OWNER, ['invoices.read', 'invoices.record_payments'], 'Books');
    const reader = await insertKey(db, OWNER, ['invoices.read'], 'Reader');
    const manager = await insertKey(db, OWNER, ['invoices.manage'], 'Manager');
    const member = await insertKey(db, MEMBER, ['projects.read', 'invoices.read', 'invoices.record_payments'], 'Member books');

    type Json = { success: boolean; data: any; meta?: any; error?: { code: string; message: string } };
    const call = async (handler: (request: NextRequest, context: any) => Promise<Response>, method: string, path: string,
      key: string, params: Record<string, string> = {}, body?: unknown) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), { params: Promise.resolve(params) });
      return { status: response.status, json: (await response.json()) as Json };
    };
    const paymentsPath = (project: string, invoice: string) => `/api/v1/projects/${project}/invoices/${invoice}/payments`;
    const post = (key: string, project: string, invoice: string, body: unknown) =>
      call(payments.POST, 'POST', paymentsPath(project, invoice), key, { id: project, invoiceId: invoice }, body);
    const remove = (key: string, project: string, invoice: string, paymentId: string) =>
      call(payment.DELETE, 'DELETE', `${paymentsPath(project, invoice)}/${paymentId}`, key, { id: project, invoiceId: invoice, paymentId });

    // -- Seed ---------------------------------------------------------------
    await q(`INSERT INTO projects(id, name, billing_email, client_time_billing, tax_rate) VALUES
      ($1, 'Alpha site', 'ap@alpha.test', 'hourly', NULL), ($2, 'Beta retainer', NULL, 'included', NULL), ($3, 'Gamma hours', NULL, 'hourly', NULL)`, [P1, P2, P3]);
    const contact = randomUUID();
    await q("INSERT INTO contacts(id, name, email, company) VALUES ($1, 'Ada Client', 'ada@alpha.test', 'Alpha LLC')", [contact]);
    await q('INSERT INTO project_contacts(project_id, contact_id, is_primary_client) VALUES ($1, $2, true)', [P1, contact]);
    const invoice = async (project: string, number: string, amount: number, status: string, lines: unknown[], createdAt: string) => {
      const id = randomUUID();
      await q(`INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, invoice_type, date, due_date, line_items, created_at)
               VALUES ($1,$2,$3,$4,$5,'hourly','2026-09-01','2999-01-01',$6::jsonb,$7)`, [id, project, number, amount, status, JSON.stringify(lines), createdAt]);
      return id;
    };
    const i1 = await invoice(P1, 'A-1', 1000, 'sent', [
      { id: 'design', position: 0, item_type: 'fixed', amount: 600, description: 'Design', service_start_date: '2026-09-01', service_end_date: '2026-09-30' },
      { id: 'hours', position: 1, item_type: 'hourly', amount: 400, description: 'Hours' },
    ], '2026-09-01T00:00:00Z');
    const i2 = await invoice(P1, 'A-2', 250, 'paid', [], '2026-09-02T00:00:00Z');
    const i3 = await invoice(P1, 'A-3', 100, 'sent', [{ id: 'short', position: 0, item_type: 'fixed', amount: 90, description: 'Short' }], '2026-09-03T00:00:00Z');
    const i4 = await invoice(P2, 'B-1', 300, 'sent', [{ id: 'fee', position: 0, item_type: 'recurring', amount: 300, description: 'Fee' }], '2026-09-04T00:00:00Z');
    const draft = await invoice(P1, 'A-4', 50, 'draft', [{ id: 'd', position: 0, item_type: 'fixed', amount: 50, description: 'Draft' }], '2026-09-05T00:00:00Z');

    // -- GET /api/v1/invoices -----------------------------------------------
    let res = await call(list.GET, 'GET', '/api/v1/invoices?limit=100', owner.secret);
    const all = res.json.data as any[];
    const byId = new Map(all.map((row) => [row.id, row]));
    check('the listing returns every invoice, oldest first', res.status === 200 && res.json.meta.total === 5 && all[0].id === i1, res.json.meta);
    check('a line-less invoice gets its legacy line',
      JSON.stringify(byId.get(i2).lines.map((l: any) => [l.key, l.type, l.amount])) === JSON.stringify([[`legacy:${i2}`, 'hourly', 250]]), byId.get(i2).lines);
    check('lines that do not add up get a balancing fixed line',
      byId.get(i3).lines.length === 2 && byId.get(i3).lines[1].key === `balance:${i3}` && byId.get(i3).lines[1].amount === 10, byId.get(i3).lines);
    check('lines carry service dates', byId.get(i1).lines[0].service_from === '2026-09-01' && byId.get(i1).lines[0].service_to === '2026-09-30');
    check('a paid invoice lists its hand payment and owes nothing',
      byId.get(i2).payments.length === 1 && byId.get(i2).payments[0].recorded_via === 'app' && byId.get(i2).outstanding === 0 && byId.get(i2).total === 250, byId.get(i2));
    check('customer is the primary client with company, plus the billing email',
      JSON.stringify(byId.get(i1).customer) === JSON.stringify({ contact_id: contact, name: 'Ada Client', company: 'Alpha LLC', email: 'ada@alpha.test', billing_email: 'ap@alpha.test' }), byId.get(i1).customer);
    check('a project without a client contact lists a null customer', byId.get(i4).customer.contact_id === null && byId.get(i4).project.name === 'Beta retainer');
    res = await call(list.GET, 'GET', '/api/v1/invoices?limit=2&page=2', owner.secret);
    check('pages are stable', res.json.data.length === 2 && res.json.data[0].id === i3 && res.json.meta.total_pages === 3, res.json);
    res = await call(list.GET, 'GET', '/api/v1/invoices?status=paid,sent', owner.secret);
    check('status filters', res.json.meta.total === 4, res.json.meta);
    res = await call(list.GET, 'GET', '/api/v1/invoices?status=void', owner.secret);
    check('an unknown status is 400', res.status === 400);
    res = await call(list.GET, 'GET', '/api/v1/invoices', member.secret);
    check('a member key sees only its projects', res.json.meta.total === 4 && res.json.data.every((row: any) => row.project.id === P1), res.json.meta);

    // -- POST payments ------------------------------------------------------
    res = await post(reader.secret, P1, i1, { amount: 1, paid_date: '2026-09-10' });
    check('a key without invoices.record_payments is 403', res.status === 403, res.json);
    res = await post(owner.secret, P1, i1, { amount: 400, paid_date: '2026-09-10', method: 'ach', reference: 'DEP 1', external_id: 'books:1' });
    check('a part payment is 201 and leaves the invoice sent',
      res.status === 201 && !res.json.data.replayed && res.json.data.invoice.status === 'sent' && res.json.data.invoice.outstanding === 600
      && res.json.data.payment.recorded_via === 'api' && res.json.data.payment.api_key_id === owner.id, res.json);
    const first = res.json.data.payment.id;
    res = await post(owner.secret, P1, i1, { amount: 400, paid_date: '2026-09-10', method: 'ach', reference: 'DEP 1', external_id: 'books:1' });
    check('a replay is 200 with the same payment', res.status === 200 && res.json.data.replayed && res.json.data.payment.id === first, res.json);
    res = await post(owner.secret, P1, i1, { amount: 401, paid_date: '2026-09-10', method: 'ach', reference: 'DEP 1', external_id: 'books:1' });
    check('the same external_id with a different payload is 409', res.status === 409 && res.json.error?.code === 'PAYMENT_EXTERNAL_ID_CONFLICT', res.json);
    res = await post(owner.secret, P1, i1, { amount: 600.01, paid_date: '2026-09-11' });
    check('more than outstanding is 422', res.status === 422 && res.json.error?.code === 'PAYMENT_EXCEEDS_OUTSTANDING', res.json);
    res = await post(owner.secret, P1, i1, { amount: 1.234, paid_date: '2026-09-11' });
    check('three decimals fail validation (422)', res.status === 422 && res.json.error?.code === 'VALIDATION_ERROR', res.json);
    res = await post(owner.secret, P1, i1, { amount: 5, paid_date: '09/11/2026' });
    check('a non-ISO date fails validation (422)', res.status === 422, res.json);
    res = await post(owner.secret, P1, draft, { amount: 5, paid_date: '2026-09-11' });
    check('a draft is 422 INVOICE_NOT_PAYABLE', res.status === 422 && res.json.error?.code === 'INVOICE_NOT_PAYABLE', res.json);
    res = await post(owner.secret, P2, i1, { amount: 5, paid_date: '2026-09-11' });
    check('an invoice under another project path is 404', res.status === 404, res.json);
    res = await post(member.secret, P2, i4, { amount: 5, paid_date: '2026-09-11' });
    check('a member key outside the project is 403', res.status === 403, res.json);
    res = await post(owner.secret, P1, i1, { amount: 600, paid_date: '2026-09-20', external_id: 'books:2' });
    check('paying the rest is 201 and marks it paid on that date',
      res.status === 201 && res.json.data.invoice.status === 'paid' && res.json.data.invoice.paid_date === '2026-09-20' && res.json.data.invoice.outstanding === 0, res.json);
    const second = res.json.data.payment.id;
    await new Promise((resolve) => setTimeout(resolve, 300)); // audit writes run after the response
    const audit = await q<{ n: number }>("SELECT count(*)::int n FROM api_audit_log WHERE entity_type = 'invoice_payment' AND method = 'POST'");
    check('payments are audited', audit[0].n === 3, audit);

    // -- GET and DELETE -----------------------------------------------------
    res = await call(payments.GET, 'GET', paymentsPath(P1, i1), reader.secret, { id: P1, invoiceId: i1 });
    check('GET lists the payments and the invoice state',
      res.status === 200 && res.json.data.payments.length === 2 && res.json.data.invoice.paid_total === 1000 && res.json.data.payments[0].id === first, res.json);
    const handPayment = (await q<{ id: string }>('SELECT id FROM invoice_payments WHERE invoice_id = $1', [i2]))[0].id;
    res = await remove(owner.secret, P1, i2, handPayment);
    check('a key cannot remove a hand payment (409)', res.status === 409 && res.json.error?.code === 'PAYMENT_RECORDED_ELSEWHERE', res.json);
    res = await remove(reader.secret, P1, i1, second);
    check('removing needs invoices.record_payments', res.status === 403);
    res = await remove(owner.secret, P1, i1, randomUUID());
    check('an unknown payment is 404', res.status === 404);
    res = await call(invoiceRoute.PATCH, 'PATCH', `/api/v1/projects/${P1}/invoices/${i1}`, manager.secret, { id: P1, invoiceId: i1 }, { status: 'cancelled' });
    check('cancelling an invoice with connection payments is 409', res.status === 409 && res.json.error?.code === 'PAYMENT_RECORDED_ELSEWHERE', res.json);
    res = await call(invoiceRoute.DELETE, 'DELETE', `/api/v1/projects/${P1}/invoices/${i1}`, manager.secret, { id: P1, invoiceId: i1 });
    check('deleting it is 409', res.status === 409 && res.json.error?.code === 'PAYMENT_RECORDED_ELSEWHERE', res.json);
    res = await remove(owner.secret, P1, i1, second);
    check('the key removes its payment and the invoice goes back to sent',
      res.status === 200 && res.json.data.deleted && res.json.data.invoice.status === 'sent' && res.json.data.invoice.outstanding === 600, res.json);
    res = await call(list.GET, 'GET', `/api/v1/invoices?updated_since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`, owner.secret);
    check('updated_since finds the invoice a payment changed', res.json.data.some((row: any) => row.id === i1), res.json.meta);

    // -- Earned work --------------------------------------------------------
    const entry = (project: string, start: string, hours: number, rate: number, extra: Record<string, string> = {}) =>
      q(`INSERT INTO project_time_entries(project_id, start_time, end_time, hourly_rate, work_type, approval_status)
         VALUES ($1, $2::timestamptz, $2::timestamptz + make_interval(secs => $3), $4, $5, $6)`,
        [project, start, hours * 3600, rate, extra.work_type ?? 'client', extra.approval_status ?? 'approved']);
    await entry(P1, '2026-09-02T15:00:00Z', 2, 100);
    await entry(P1, '2026-09-02T18:00:00Z', 1, 100);
    await entry(P1, '2026-09-03T15:00:00Z', 1.5, 100);
    await entry(P1, '2026-09-03T19:00:00Z', 4, 100, { work_type: 'internal' });
    await entry(P1, '2026-09-04T15:00:00Z', 4, 100, { approval_status: 'pending' });
    await entry(P1, '2026-09-05T15:00:00Z', 4, 0);
    await entry(P2, '2026-09-02T15:00:00Z', 3, 100); // included: covered by the fee
    await entry(P3, '2026-09-01T15:00:00Z', 3, 120);
    await entry(P3, '2026-09-08T15:00:00Z', 2.5, 120);
    await entry(P3, '2026-09-15T15:00:00Z', 1, 150);

    // A retainer on P1 from two months back: that month on a sent invoice,
    // last month never invoiced, this month on a draft, next month not started.
    const retainer = randomUUID();
    await q("INSERT INTO project_retainers(id, project_id, name, billing_timing, start_date) VALUES ($1, $2, 'Care plan', 'advance', $3)", [retainer, P1, monthStart(-2)]);
    await q('INSERT INTO project_retainer_amounts(retainer_id, amount, effective_date) VALUES ($1, 500, $2)', [retainer, monthStart(-2)]);
    const retainerLine = (offset: number) => [{ id: 'care', position: 0, item_type: 'recurring', amount: 500, description: 'Care plan', retainer_id: retainer, service_start_date: monthStart(offset), service_end_date: monthEnd(offset) }];
    await invoice(P1, 'R-1', 500, 'sent', retainerLine(-2), '2026-09-06T00:00:00Z');
    const retainerDraft = await invoice(P1, 'R-3', 500, 'draft', retainerLine(0), '2026-09-07T00:00:00Z');

    const earnedPath = (from: string, to: string) => `/api/v1/billing/earned-work?from=${from}&to=${to}`;
    res = await call(earned.GET, 'GET', earnedPath('2026-09-01', monthEnd(1)), reader.secret);
    const projects = new Map((res.json.data?.projects ?? []).map((row: any) => [row.project.id, row]));
    const alpha: any = projects.get(P1);
    check('earned work is 200 with the workspace time zone', res.status === 200 && res.json.data.timezone === 'UTC', res.json);
    check('approved client time is totalled by day (not internal, pending or unrated time)',
      JSON.stringify(alpha?.time) === JSON.stringify([{ date: '2026-09-02', hours: 3, amount: 300 }, { date: '2026-09-03', hours: 1.5, amount: 150 }]), alpha?.time);
    check('time on an included project is not earned separately', !projects.has(P2), [...projects.keys()]);
    check('scheduled lists started retainer periods with no issued invoice: one never invoiced, one on a draft',
      JSON.stringify(alpha?.scheduled.map((s: any) => [s.period_start, s.period_end, s.amount, s.draft_invoice_id])) === JSON.stringify([
        [monthStart(-1), monthEnd(-1), 500, null],
        [monthStart(0), monthEnd(0), 500, retainerDraft],
      ]), alpha?.scheduled);
    res = await call(earned.GET, 'GET', earnedPath('2026-09-01', monthEnd(1)), member.secret);
    check('a member key sees only its projects', res.json.data.projects.length === 1 && res.json.data.projects[0].project.id === P1, res.json.data.projects.map((p: any) => p.project.id));
    res = await call(earned.GET, 'GET', earnedPath('2026-09-03', '2026-09-03'), reader.secret);
    check('the range is inclusive and filters by day',
      JSON.stringify(res.json.data.projects.find((p: any) => p.project.id === P1)?.time) === JSON.stringify([{ date: '2026-09-03', hours: 1.5, amount: 150 }]), res.json.data);
    res = await call(earned.GET, 'GET', earnedPath('2026-09-10', '2026-09-01'), reader.secret);
    check('to before from is 422 EARNED_WORK_RANGE', res.status === 422 && res.json.error?.code === 'EARNED_WORK_RANGE', res.json);
    res = await call(earned.GET, 'GET', '/api/v1/billing/earned-work?from=2026-09-01', reader.secret);
    check('a missing bound is 400', res.status === 400);

    // Tie-out on P3: earned time less what is billed equals both the unbilled
    // slices the invoice form offers and the portal's uninvoiced figure.
    await invoice(P3, 'G-1', 360, 'paid', [{ id: 'h', position: 0, item_type: 'hourly', amount: 360, description: 'Hours' }], '2026-09-20T00:00:00Z');
    res = await call(earned.GET, 'GET', earnedPath('2026-01-01', '2026-12-31'), reader.secret);
    const gamma = res.json.data.projects.find((p: any) => p.project.id === P3);
    const earnedTotal = gamma.time.reduce((sum: number, day: any) => sum + day.amount, 0);
    const slices = await q<{ v: string }>('SELECT COALESCE(sum(hours * rate), 0)::numeric(12,2)::text v FROM invoice_unbilled_slices($1)', [P3]);
    const entries = await q<{ id: string; hours: number; hourly_rate: number }>(
      `SELECT id, time_entry_worked_hours(segments, start_time, end_time)::float8 hours, hourly_rate::float8 hourly_rate
       FROM project_time_entries WHERE project_id = $1`, [P3]);
    const portalInvoices = (await q('SELECT * FROM project_invoices WHERE project_id = $1', [P3])).map((row) => ({ ...row, amount: Number(row.amount) }));
    const portal = summariseInvoices(portalInvoices as any, {
      hourly_tracking: true, hourly_rate: 120, total_hours: 0, billable_total: totalBillableAmount(entries, 120),
    } as any);
    check('earned time less billed hourly equals the unbilled slices',
      earnedTotal === 810 && Number(slices[0].v) === earnedTotal - 360, { earnedTotal, slices });
    check('...and the portal uninvoiced figure', Math.round(portal.uninvoiced * 100) === Math.round((earnedTotal - 360) * 100), portal);

    // -- Figures the panel, portal and finances show -------------------------
    const figures = await import('../src/lib/invoice-payments');
    const { computeFinanceData } = await import('../src/lib/finance/summary');
    const { fetchProjectInvoice } = await import('../src/lib/supabase/queries');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const partial = await invoice(P1, 'F-1', 1000, 'sent', [{ id: 'f', position: 0, item_type: 'fixed', amount: 1000, description: 'Build' }], '2026-09-21T00:00:00Z');
    await q("SELECT record_invoice_payment($1, '{\"amount\": 250, \"paid_date\": \"2026-09-22\"}'::jsonb)", [partial]);
    // PGlite hands numeric back as text; PostgREST sends numbers.
    const asApp = (row: any) => row && ({ ...row, amount: Number(row.amount) });
    const loaded = asApp(await fetchProjectInvoice(getServiceClient(), partial));
    check('the app loads an invoice with its payments', loaded?.payments?.length === 1 && loaded.payments[0].amount === 250, loaded?.payments);
    check('a part-paid sent invoice reads as partially paid', !!loaded && figures.isPartiallyPaid(loaded, null) && figures.invoiceOutstanding(loaded, null) === 750);
    check('its paid share is the payment', !!loaded && figures.invoiceAmountPaid(loaded, 10) === 227.27 && figures.invoiceAmountPaid(loaded, null) === 250);
    const fullyPaid = asApp(await fetchProjectInvoice(getServiceClient(), i2));
    check('a paid invoice counts its whole amount', !!fullyPaid && figures.invoiceAmountPaid(fullyPaid, null) === 250 && !figures.isPartiallyPaid(fullyPaid, null));
    check('rule errors read as plain text', figures.parsePaymentRuleError('PAYMENT_RECORDED_ELSEWHERE: Remove them there first.')?.text === 'Remove them there first.');
    const finance = computeFinanceData({
      projects: [{ id: P1, name: 'Alpha site', status: 'active', tax_rate: null } as any],
      invoices: [loaded!, fullyPaid!],
      timeEntries: [], team: [], rateByProject: new Map(), now: Date.parse('2026-09-30T12:00:00Z'),
      range: { startKey: '2026-09-01', endKey: '2026-09-30' },
    });
    // i2 was created as paid with no paid date, so its payment is dated today, outside September.
    check('finances count a part payment as received on its day',
      finance.received === 250 && finance.paymentsByDay.get('2026-09-22') === 250 && finance.paymentsByDay.size === 1, { received: finance.received, byDay: [...finance.paymentsByDay] });
    const portalFigures = summariseInvoices([
      { ...loaded!, paid_amount: figures.invoiceAmountPaid(loaded!, null) },
      { ...fullyPaid!, paid_amount: figures.invoiceAmountPaid(fullyPaid!, null) },
    ] as any, null);
    check('the portal counts the part payment as paid', portalFigures.paid === 500 && portalFigures.balanceDue === 750, portalFigures);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`invoice payments API: ${passed} passed, ${failures.length} failed`);
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`invoice payments API: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
