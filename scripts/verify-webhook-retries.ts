/**
 * Webhook delivery retries: backoff, the attempt cap, stuck-lease recovery,
 * per-invoice ordering, manual resend and the pg_cron kick. The real dispatcher
 * (lib/webhooks/dispatch.ts) runs with the real supabase-js client against
 * PGlite behind fake-postgrest, and POSTs to a local receiver that checks the
 * signature the way WEBHOOKS.md tells receivers to.
 *
 * The database starts at the webhook schema as it was before the retry
 * migration (with a delivery stuck in 'delivering'), then the migration is
 * applied twice.
 *
 *   npm run -s test:webhook-retries
 */
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { startFakePostgrest } from './fake-postgrest';

const CREATE_MIGRATION = '../supabase/migrations/20260725154128_create_webhooks.sql';
const AMOUNT_BASIS_MIGRATION = '../supabase/migrations/20260919213826_webhook_amount_basis.sql';
const RETRY_MIGRATION = '../supabase/migrations/20261018220437_webhook_delivery_retries.sql';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 1500)}`);
}

async function read(path: string) {
  return (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}
function fn(sql: string, name: string) {
  const found = sql.match(new RegExp('create or replace function public\\.' + name + '\\([\\s\\S]*?^\\$\\$;', 'mi'))?.[0];
  assert.ok(found, `function ${name}`);
  return found;
}

// The receiver-side check from WEBHOOKS.md, verbatim in behaviour.
function verifySignature(secret: string, header: string, rawBody: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map(kv => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface Received {
  path: string;
  sequence: number;
  invoiceId: string;
  type: string;
  eventIdHeader: string;
  typeHeader: string;
  signed: boolean;
  amountBasis: string | undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}

async function createDatabase() {
  const db = new PGlite();
  const create = await read(CREATE_MIGRATION);
  const basis = await read(AMOUNT_BASIS_MIGRATION);
  const canonical = await read('../supabase/schema.sql');
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role' $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.team_members (id uuid PRIMARY KEY);
    CREATE FUNCTION public.handle_updated_at() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    -- Stand-ins for Supabase Vault and pg_net: webhook_retry_kick reads the one and calls the other.
    CREATE SCHEMA vault;
    CREATE TABLE vault.decrypted_secrets (name text PRIMARY KEY, decrypted_secret text);
    CREATE SCHEMA net;
    CREATE TABLE net.requests (id bigserial PRIMARY KEY, url text, headers jsonb, body jsonb, timeout_milliseconds int);
    CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                                  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
      RETURNS bigint LANGUAGE sql
      AS $$ INSERT INTO net.requests (url, headers, body, timeout_milliseconds) VALUES (url, headers, body, timeout_milliseconds) RETURNING id $$;
  `);
  // The webhook tables exactly as the first migration made them, then the amount_basis columns.
  const tables = create.slice(create.indexOf('CREATE SEQUENCE IF NOT EXISTS public.webhook_event_seq'), create.indexOf('-- updated_at bumps'));
  await db.exec(tables);
  await db.exec(`
    CREATE TRIGGER set_webhook_deliveries_updated_at BEFORE UPDATE ON public.webhook_deliveries
      FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
    ALTER TABLE public.webhook_endpoints ADD COLUMN IF NOT EXISTS amount_basis text NOT NULL DEFAULT 'gross';
    ALTER TABLE public.webhook_events ADD COLUMN IF NOT EXISTS net_amounts jsonb;
    GRANT ALL ON public.webhook_endpoints, public.webhook_events, public.webhook_deliveries TO service_role;
  `);
  await db.exec(fn(canonical, 'webhook_payload_for_endpoint'));
  await db.exec(fn(basis, 'claim_webhook_deliveries'));
  return { db, canonical };
}

async function main() {
  const { db, canonical } = await createDatabase();
  const q = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

  // -- Receiver ---------------------------------------------------------------
  const secret = 'whsec_' + crypto.randomBytes(32).toString('hex');
  const received: Received[] = [];
  // Status per path; a function lets a test fail some events and not others.
  let respond: (path: string, sequence: number) => number = () => 200;
  const receiver = createServer(async (request, response) => {
    const raw = await readBody(request);
    const payload = JSON.parse(raw) as { sequence: number; type: string; data: { invoice: { id: string }; amount_basis?: string } };
    const path = request.url ?? '/';
    received.push({
      path,
      sequence: Number(payload.sequence),
      invoiceId: payload.data.invoice.id,
      type: payload.type,
      eventIdHeader: String(request.headers['x-vm-event-id'] ?? ''),
      typeHeader: String(request.headers['x-vm-event-type'] ?? ''),
      signed: verifySignature(secret, String(request.headers['x-vm-signature'] ?? ''), raw),
      amountBasis: payload.data.amount_basis,
    });
    const status = respond(path, Number(payload.sequence));
    response.writeHead(status, { 'Content-Type': 'text/plain' });
    response.end(status === 200 ? 'ok' : 'nope');
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  const endpoint = async (path: string, active = true) => {
    const id = randomUUID();
    await q(
      `INSERT INTO webhook_endpoints (id, name, url, secret, events, is_active)
       VALUES ($1, $2, $3, $4, ARRAY['invoice.paid','invoice.updated','invoice.deleted'], $5)`,
      [id, path, base + path, secret, active]);
    return id;
  };
  // One event for an invoice, delivered to the given endpoints. Returns its sequence.
  const emit = async (invoiceId: string, type: string, endpointIds: string[]) => {
    const seq = Number((await q<{ s: string }>("SELECT nextval('public.webhook_event_seq') s"))[0].s);
    const eventId = 'evt_' + randomUUID().replace(/-/g, '');
    const payload = {
      id: eventId, type, sequence: seq, created_at: new Date().toISOString(),
      data: { invoice: { id: invoiceId, status: 'paid', paid: true, amount: 100 }, project: { id: randomUUID(), name: 'P' }, line_items: [], totals_by_type: { fixed: 100 } },
    };
    const [{ id }] = await q<{ id: string }>(
      `INSERT INTO webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
       VALUES ($1, $2, $3, 'invoice', $4, $5::jsonb) RETURNING id`,
      [eventId, seq, type, invoiceId, JSON.stringify(payload)]);
    for (const endpointId of endpointIds) {
      await q('INSERT INTO webhook_deliveries (webhook_event_id, endpoint_id) VALUES ($1, $2)', [id, endpointId]);
    }
    return seq;
  };
  interface Row { status: string; attempts: number; next_in: number | null; lease_in: number | null; token: string | null; last_status_code: number | null; last_error: string | null; delivered: boolean }
  const delivery = async (endpointId: string, seq: number) => (await q<Row>(
    `SELECT d.status, d.attempts,
            extract(epoch FROM d.next_attempt_at - now())::float8 AS next_in,
            extract(epoch FROM d.lease_expires_at - now())::float8 AS lease_in,
            d.attempt_token AS token, d.last_status_code, d.last_error, d.delivered_at IS NOT NULL AS delivered
     FROM webhook_deliveries d JOIN webhook_events ev ON ev.id = d.webhook_event_id
     WHERE d.endpoint_id = $1 AND ev.sequence = $2`, [endpointId, seq]))[0];
  // Moves the clock forward for the queue instead of waiting: due retries and expired leases.
  const makeDue = () => q("UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'");
  const expireLeases = () => q("UPDATE webhook_deliveries SET lease_expires_at = now() - interval '1 second' WHERE status = 'delivering'");
  const sent = (path: string) => received.filter((r) => r.path === path);

  // -- Before the migration: a run died mid-delivery ---------------------------
  const stuckEndpoint = await endpoint('/stuck');
  const stuckInvoice = randomUUID();
  const stuckSeq = await emit(stuckInvoice, 'invoice.paid', [stuckEndpoint]);
  await q("UPDATE webhook_deliveries SET status = 'delivering', attempts = 1, last_attempt_at = now() - interval '1 hour' WHERE endpoint_id = $1", [stuckEndpoint]);

  const migration = await read(RETRY_MIGRATION);
  await db.exec(migration);
  await db.exec(migration);
  check('migration is safe to re-run', true);
  const indexes = (await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'webhook_deliveries'")).map((r) => r.indexname);
  check('due index replaces the pending index', indexes.includes('idx_webhook_deliveries_due') && !indexes.includes('idx_webhook_deliveries_pending'), indexes);
  const stuckBefore = await delivery(stuckEndpoint, stuckSeq);
  check('a delivery stuck before the migration has an expired lease', stuckBefore.status === 'delivering' && stuckBefore.lease_in !== null && stuckBefore.lease_in <= 0, stuckBefore);

  // The schema snapshot carries the same functions as the migration.
  for (const name of ['claim_webhook_deliveries', 'complete_webhook_delivery', 'requeue_webhook_delivery', 'webhook_retry_kick']) {
    check(`schema.sql ${name} matches the migration`, fn(canonical, name) === fn(migration, name));
  }
  for (const column of ['next_attempt_at timestamptz not null default now()', 'attempt_token uuid', 'lease_expires_at timestamptz']) {
    check(`schema.sql webhook_deliveries has ${column}`, canonical.includes(`  ${column},`));
  }

  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const { runDispatch } = await import('../src/lib/webhooks/dispatch');

  try {
    // -- Stuck-lease recovery -------------------------------------------------
    let summary = await runDispatch();
    const stuckAfter = await delivery(stuckEndpoint, stuckSeq);
    check('the next run takes back the stuck delivery and sends it', stuckAfter.status === 'succeeded' && stuckAfter.attempts === 2 && sent('/stuck').length === 1, { stuckAfter, summary });
    check('the summary counts it delivered', summary.delivered === 1 && summary.claimed === 1, summary);

    // -- Payload contract -----------------------------------------------------
    const first = sent('/stuck')[0];
    check('signature verifies with the WEBHOOKS.md recipe', first?.signed === true, first);
    check('event id and type headers are sent', first?.eventIdHeader.startsWith('evt_') && first.typeHeader === 'invoice.paid', first);
    check('amount_basis is stated in the body', first?.amountBasis === 'gross', first);

    // -- Retry with backoff up to the cap -------------------------------------
    const flaky = await endpoint('/flaky');
    const flakyInvoice = randomUUID();
    respond = (path) => (path === '/flaky' ? 500 : 200);
    const flakySeq = await emit(flakyInvoice, 'invoice.paid', [flaky]);
    const expectedMinutes = [1, 3, 9, 27, 81, 243, 720];
    for (let attempt = 1; attempt <= 8; attempt++) {
      summary = await runDispatch();
      const row = await delivery(flaky, flakySeq);
      if (attempt < 8) {
        const want = expectedMinutes[attempt - 1] * 60;
        check(`attempt ${attempt} fails and is retried`, row.status === 'pending' && row.attempts === attempt && summary.retrying === 1, { row, summary });
        check(`attempt ${attempt} waits ${expectedMinutes[attempt - 1]} minutes`, row.next_in !== null && row.next_in > want - 5 && row.next_in <= want, row);
        check(`attempt ${attempt} records the error and clears the lease`, row.last_status_code === 500 && row.last_error === 'HTTP 500' && row.token === null && row.lease_in === null, row);
        const early = await runDispatch();
        check(`attempt ${attempt}: nothing is sent before the backoff passes`, early.claimed === 0 && sent('/flaky').length === attempt, early);
        await makeDue();
      } else {
        check('the 8th failure stays failed', row.status === 'failed' && row.attempts === 8 && summary.failed === 1, { row, summary });
      }
    }
    await makeDue();
    summary = await runDispatch();
    check('a failed delivery is not tried again on its own', summary.claimed === 0 && sent('/flaky').length === 8, summary);

    // -- Manual resend --------------------------------------------------------
    const requeue = async (endpointId: string, seq: number) => (await q<{ ok: boolean }>(
      `SELECT requeue_webhook_delivery(d.id) ok FROM webhook_deliveries d JOIN webhook_events ev ON ev.id = d.webhook_event_id
       WHERE d.endpoint_id = $1 AND ev.sequence = $2`, [endpointId, seq]))[0].ok;
    check('resend of a succeeded delivery is refused', (await requeue(stuckEndpoint, stuckSeq)) === false);
    check('resend of a failed delivery is accepted', (await requeue(flaky, flakySeq)) === true);
    const requeued = await delivery(flaky, flakySeq);
    check('resend restarts the attempt budget and is due now', requeued.status === 'pending' && requeued.attempts === 0 && requeued.last_error === null && (requeued.next_in ?? 1) <= 0, requeued);
    respond = () => 200;
    summary = await runDispatch();
    check('the resent delivery goes out', (await delivery(flaky, flakySeq)).status === 'succeeded' && summary.delivered === 1, summary);

    // -- Ordering: a failing event holds back later ones for the same invoice --
    const ordered = await endpoint('/ordered');
    const other = await endpoint('/other');
    const invoiceA = randomUUID();
    const invoiceB = randomUUID();
    const failSeq = new Set<number>();
    respond = (path, seq) => (path === '/ordered' && failSeq.has(seq) ? 503 : 200);
    const a1 = await emit(invoiceA, 'invoice.paid', [ordered, other]);
    const a2 = await emit(invoiceA, 'invoice.updated', [ordered, other]);
    const b1 = await emit(invoiceB, 'invoice.paid', [ordered]);
    const a3 = await emit(invoiceA, 'invoice.updated', [ordered, other]);
    failSeq.add(a1);
    summary = await runDispatch();
    const orderedSeqs = () => sent('/ordered').map((r) => r.sequence);
    check('later events for the invoice wait while the first is retrying', !orderedSeqs().includes(a2) && !orderedSeqs().includes(a3) && (await delivery(ordered, a2)).attempts === 0, orderedSeqs());
    check('another invoice on the same endpoint is not held back', orderedSeqs().includes(b1), orderedSeqs());
    check('the same invoice on another endpoint is not held back, and arrives in order', JSON.stringify(sent('/other').map((r) => r.sequence)) === JSON.stringify([a1, a2, a3]), sent('/other').map((r) => r.sequence));
    failSeq.clear();
    await makeDue();
    summary = await runDispatch();
    const afterA = sent('/ordered').filter((r) => r.invoiceId === invoiceA).map((r) => r.sequence);
    check('once the first succeeds the rest follow in one run, in sequence order', JSON.stringify(afterA) === JSON.stringify([a1, a1, a2, a3]), afterA);

    // An event that has used up its attempts stops holding the line.
    const invoiceC = randomUUID();
    const c1 = await emit(invoiceC, 'invoice.paid', [ordered]);
    const c2 = await emit(invoiceC, 'invoice.updated', [ordered]);
    await q("UPDATE webhook_deliveries d SET status = 'failed', attempts = 8 FROM webhook_events ev WHERE ev.id = d.webhook_event_id AND ev.sequence = $1", [c1]);
    summary = await runDispatch();
    check('an exhausted event does not block the next one', (await delivery(ordered, c2)).status === 'succeeded', await delivery(ordered, c2));

    // -- Leases: a run that never reports --------------------------------------
    const leased = await endpoint('/leased');
    const invoiceD = randomUUID();
    const d1 = await emit(invoiceD, 'invoice.paid', [leased]);
    const d2 = await emit(invoiceD, 'invoice.updated', [leased]);
    type Claimed = { delivery_id: string; attempt_token: string; event_sequence: number };
    const claimDirect = () => q<Claimed>('SELECT delivery_id, attempt_token, event_sequence FROM claim_webhook_deliveries(20)');
    const crashed = await claimDirect();
    check('a claim takes only the head of the line', crashed.length === 1 && Number(crashed[0].event_sequence) === d1, crashed);
    const held = await delivery(leased, d1);
    check('a claim holds a 2-minute lease with a token', held.status === 'delivering' && held.token === crashed[0].attempt_token && held.lease_in !== null && held.lease_in > 110 && held.lease_in <= 120, held);
    check('while the lease is live nothing else for the invoice is claimed', (await claimDirect()).length === 0);
    await expireLeases();
    summary = await runDispatch();
    check('after the lease expires the next run takes it back and sends both, in order',
      (await delivery(leased, d1)).status === 'succeeded' && (await delivery(leased, d1)).attempts === 2 && (await delivery(leased, d2)).status === 'succeeded'
        && JSON.stringify(sent('/leased').map((r) => r.sequence)) === JSON.stringify([d1, d2]), sent('/leased').map((r) => r.sequence));
    const late = (await q<{ r: string }>("SELECT complete_webhook_delivery($1, $2, 500, 'late', null) r", [crashed[0].delivery_id, crashed[0].attempt_token]))[0].r;
    check('the crashed run reporting late is ignored', late === 'stale' && (await delivery(leased, d1)).status === 'succeeded', late);

    // A lease that runs out on the last attempt ends failed, not retried.
    const invoiceE = randomUUID();
    const e1 = await emit(invoiceE, 'invoice.paid', [leased]);
    await q(`UPDATE webhook_deliveries d SET status = 'delivering', attempts = 8, attempt_token = gen_random_uuid(),
             lease_expires_at = now() - interval '1 second' FROM webhook_events ev WHERE ev.id = d.webhook_event_id AND ev.sequence = $1`, [e1]);
    const before = sent('/leased').length;
    summary = await runDispatch();
    const exhausted = await delivery(leased, e1);
    check('an expired lease on the last attempt is marked failed', exhausted.status === 'failed' && exhausted.token === null && sent('/leased').length === before, exhausted);

    // -- Inactive endpoints wait ----------------------------------------------
    const paused = await endpoint('/paused', false);
    const p1 = await emit(randomUUID(), 'invoice.paid', [paused]);
    summary = await runDispatch();
    check('an inactive endpoint is not sent to', (await delivery(paused, p1)).status === 'pending' && sent('/paused').length === 0);

    // -- pg_cron kick ------------------------------------------------------------
    const kick = async () => (await q<{ id: string | null }>('SELECT webhook_retry_kick() id'))[0].id;
    const requests = () => q<{ url: string; headers: Record<string, string>; timeout_milliseconds: number }>('SELECT url, headers, timeout_milliseconds FROM net.requests ORDER BY id');
    await q("UPDATE webhook_endpoints SET is_active = false WHERE url <> $1", [base + '/kick']);
    check('nothing due: the kick sends nothing', (await kick()) === null && (await requests()).length === 0);
    const kickEndpoint = await endpoint('/kick');
    respond = () => 500;
    const k1 = await emit(randomUUID(), 'invoice.paid', [kickEndpoint]);
    check('due but no Vault secrets: the kick sends nothing', (await kick()) === null && (await requests()).length === 0);
    await q("INSERT INTO vault.decrypted_secrets VALUES ('webhook_scheduler_url', 'https://app.example.test/'), ('webhook_scheduler_secret', $1)", ['s'.repeat(40)]);
    check('a new delivery the in-app kick missed is due: the kick posts', (await kick()) !== null);
    const [request] = await requests();
    check('the kick posts to the scheduled route with the bearer secret',
      request?.url === 'https://app.example.test/api/internal/webhooks/scheduled' && request.headers.Authorization === 'Bearer ' + 's'.repeat(40)
        && request.headers['Content-Type'] === 'application/json' && request.timeout_milliseconds === 60000, request);
    await runDispatch();
    check('waiting out a backoff: the kick sends nothing', (await delivery(kickEndpoint, k1)).status === 'pending' && (await kick()) === null && (await requests()).length === 1);
    await makeDue();
    check('a retry whose backoff passed: the kick posts', (await kick()) !== null && (await requests()).length === 2);
    await claimDirect();
    check('a live lease: the kick sends nothing', (await kick()) === null);
    await expireLeases();
    check('an expired lease: the kick posts', (await kick()) !== null && (await requests()).length === 3);
    await q('UPDATE webhook_endpoints SET is_active = false WHERE id = $1', [kickEndpoint]);
    check('an inactive endpoint: the kick sends nothing', (await kick()) === null);

    // -- Every delivery was signed ----------------------------------------------
    check('every request carried a valid signature', received.every((r) => r.signed), received.filter((r) => !r.signed));

    // -- Scheduled route auth ----------------------------------------------------
    const route = await import('../src/app/api/internal/webhooks/scheduled/route');
    const saved = { ...process.env };
    try {
      const post = (authorization: string) =>
        route.POST(new Request('http://x/api/internal/webhooks/scheduled', { method: 'POST', headers: { authorization } }));
      delete process.env.WEBHOOK_SCHEDULER_ENABLED;
      process.env.WEBHOOK_SCHEDULER_SECRET = 's'.repeat(40);
      check('scheduler POST is off unless enabled', (await post('Bearer ' + 's'.repeat(40))).status === 404);
      process.env.WEBHOOK_SCHEDULER_ENABLED = 'true';
      check('scheduler POST needs the bearer', (await post('Bearer wrong')).status === 401);
      const ok = await post('Bearer ' + 's'.repeat(40));
      const body = await ok.json() as { claimed?: number };
      check('scheduler POST with the secret runs the dispatcher', ok.status === 200 && typeof body.claimed === 'number', body);
    } finally {
      process.env = saved;
    }
  } finally {
    receiver.close();
    await server.close();
  }

  // Hobby allows only daily Vercel crons; the retry run must not be one.
  const vercel = JSON.parse(await read('../vercel.json')) as { crons: Array<{ path: string; schedule: string }> };
  check('vercel.json has no webhook cron', !vercel.crons.some((c) => c.path.includes('/webhooks/')), vercel.crons);

  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
