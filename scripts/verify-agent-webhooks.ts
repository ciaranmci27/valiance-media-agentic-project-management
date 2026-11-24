/**
 * Agent webhooks (20261124000200_agent_webhooks.sql) on the real schema:
 * - Each work event fires once with its payload: task.created (with the
 *   assignees saved with it), task.updated (changed fields named), task.deleted
 *   and a restore, comment.created, question.asked/answered/cancelled,
 *   suggestion.created/decided and review.submitted, with project_id, task_id,
 *   member_ids and actor_id.
 * - Reordering, claims and edits in Trash fire nothing; changes in one
 *   transaction fold into one event; a task created with its assignees is one
 *   task.created.
 * - Filters: projects (a moved task reaches its old project's endpoint too)
 *   and member (a member assigned a task, asked a question, a removed
 *   assignee; a comment author is not concerned).
 * - Per-subject ordering in the claim: a task's events (comments included)
 *   wait behind an earlier one for the same task, other tasks do not.
 * - Client invoicing off, Webhooks on: task events are claimed and sent by
 *   the real dispatcher (signed), invoice events wait, the retry kick ignores
 *   them. Webhooks off: nothing goes out.
 * - Invoice payloads are byte for byte what the schema before this migration
 *   sent (gross and net, through the claim), fresh and upgraded; an existing
 *   invoice-only endpoint gets no new events after the upgrade.
 * - No subscribed endpoint: no outbox rows.
 * - An API write sends what it queued right away (the withApi kick).
 *
 *   npm run -s test:agent-webhooks
 */
import crypto, { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, createFullSchemaDatabase, schemaAt, schemaBeforeMigration } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

const MIGRATION = '20261124000200_agent_webhooks.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payloads are untyped JSON read field by field
type Loose = any;
interface EventRow { id: string; sequence: number; event_type: string; resource_type: string; resource_id: string | null; payload: Loose }

const WORK_EVENTS = [
  'task.created', 'task.updated', 'task.deleted', 'comment.created',
  'question.asked', 'question.answered', 'question.cancelled',
  'suggestion.created', 'suggestion.decided', 'review.submitted',
];
const INVOICE_EVENTS = ['invoice.paid', 'invoice.updated', 'invoice.deleted', 'invoice.payment_recorded', 'invoice.payment_removed'];

function q(db: PGlite) {
  return async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
}

async function asOwner(db: PGlite) {
  await actAs(db, null);
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.headers', '', false)");
}

async function setModules(db: PGlite, enabled: Record<string, boolean>) {
  for (const [id, on] of Object.entries(enabled)) {
    await db.query('UPDATE pm.workspace_modules SET enabled = $2 WHERE module_id = $1', [id, on]);
  }
}

// ---------------------------------------------------------------------------
// Invoice payloads: the same scenario on the schema before this migration,
// on that schema upgraded, and on schema.sql.
// ---------------------------------------------------------------------------
const FIXED = {
  project: '00000000-0000-0000-0000-0000000000a1',
  invoice: '00000000-0000-0000-0000-0000000000b1',
  gross: '00000000-0000-0000-0000-0000000000c1',
  net: '00000000-0000-0000-0000-0000000000c2',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A payload with what differs run to run (event id, sequence, times, generated ids) set aside. */
function normalizePayload(payload: Loose): Loose {
  const rest = { ...payload };
  delete rest.id;
  delete rest.sequence;
  return normalize(rest);
}

/** Ids and times that differ run to run become placeholders; everything else stays. */
function normalize(value: Loose): Loose {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  if (typeof value === 'string' && UUID.test(value) && !Object.values(FIXED).includes(value)) return '<uuid>';
  if (typeof value === 'string' && TIMESTAMP.test(value)) return '<time>';
  return value;
}

async function invoiceScenario(db: PGlite): Promise<{ events: string[]; claimed: string[] }> {
  const run = q(db);
  await asOwner(db);
  await setModules(db, { billing: true, webhooks: true, time: true });
  await run(`INSERT INTO pm.webhook_endpoints (id, name, url, secret, events, amount_basis) VALUES
    ($1, 'Books gross', 'https://books.example.test/gross', 'whsec_g', $3, 'gross'),
    ($2, 'Books net', 'https://books.example.test/net', 'whsec_n', $3, 'net')`, [FIXED.gross, FIXED.net, INVOICE_EVENTS]);
  await run("INSERT INTO pm.projects (id, name) VALUES ($1, 'Acme Website')", [FIXED.project]);
  const lines = JSON.stringify([
    { id: 'li_1', item_type: 'recurring', amount: 2000, description: 'Monthly retainer' },
    { id: 'li_2', item_type: 'reimbursement', amount: 500, description: 'Domain renewal' },
  ]);
  await run(`INSERT INTO pm.project_invoices (id, project_id, invoice_number, amount, status, invoice_type, date, due_date, line_items)
    VALUES ($1, $2, 'INV-1043', 2500, 'sent', 'recurring', '2026-07-01', '2999-07-15', $3::jsonb)`, [FIXED.invoice, FIXED.project, lines]);
  await run("UPDATE pm.project_invoices SET status = 'paid', paid_date = '2026-07-25' WHERE id = $1", [FIXED.invoice]);
  await run("UPDATE pm.project_invoices SET description = 'Retainer, July' WHERE id = $1", [FIXED.invoice]);
  await run("UPDATE pm.project_invoices SET invoice_number = 'INV-1043A' WHERE id = $1", [FIXED.invoice]);
  await run(`SELECT pm.emit_invoice_webhook_event(i, 'invoice.payment_recorded', '{"payment": {"amount": 1}}'::jsonb)
    FROM pm.project_invoices i WHERE i.id = $1`, [FIXED.invoice]);
  await run("UPDATE pm.project_invoices SET deleted_at = now() WHERE id = $1", [FIXED.invoice]);
  const events = (await run<{ payload: Loose }>('SELECT payload FROM pm.webhook_events ORDER BY sequence'))
    .map((r) => JSON.stringify(normalizePayload(r.payload)));
  // Every delivery through the claim (head of the line each round), as the dispatcher sees it.
  const claimed: string[] = [];
  for (let round = 0; round < 20; round++) {
    const rows = await run<{ delivery_id: string; attempt_token: string; endpoint_id: string; payload: Loose }>(
      'SELECT delivery_id, attempt_token, endpoint_id, payload FROM pm.claim_webhook_deliveries(50)');
    if (rows.length === 0) break;
    rows.sort((a, b) => (a.endpoint_id + a.payload.sequence).localeCompare(b.endpoint_id + b.payload.sequence));
    for (const row of rows) {
      claimed.push(`${row.endpoint_id} ${JSON.stringify(normalizePayload(row.payload))}`);
      await run('SELECT pm.complete_webhook_delivery($1, $2, 200, NULL, NULL)', [row.delivery_id, row.attempt_token]);
    }
  }
  return { events, claimed: claimed.sort() };
}

async function invoiceChecks() {
  let before: string;
  try {
    before = schemaBeforeMigration(MIGRATION);
  } catch {
    // Not committed yet (while it is being written): the last commit is the schema before it.
    before = schemaAt('HEAD');
  }
  const old = await createFullSchemaDatabase({ schemaSql: before });
  const reference = await invoiceScenario(old);
  await old.close();

  const upgraded = await createFullSchemaDatabase({ schemaSql: before });
  await upgraded.exec(MIGRATION_SQL);
  await upgraded.exec(MIGRATION_SQL);
  const afterUpgrade = await invoiceScenario(upgraded);
  // The existing endpoints are invoice-only: work changes add nothing to the outbox for them.
  const run = q(upgraded);
  const outboxBefore = (await run<{ n: number }>('SELECT count(*)::int AS n FROM pm.webhook_events'))[0].n;
  const member = (await run<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Builder', 'builder@example.com', 'agent') RETURNING id"))[0].id;
  const task = (await run<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Fix the footer') RETURNING id", [FIXED.project]))[0].id;
  await run('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [task, member]);
  await run("UPDATE pm.tasks SET status = 'in_progress' WHERE id = $1", [task]);
  await run("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'On it')", [task, member]);
  const outboxAfter = (await run<{ n: number }>('SELECT count(*)::int AS n FROM pm.webhook_events'))[0].n;
  await upgraded.close();

  const fresh = await createFullSchemaDatabase();
  const fromSchema = await invoiceScenario(fresh);
  await fresh.close();

  check('invoice: the scenario raised invoice events', reference.events.length >= 5 && reference.claimed.length === reference.events.length * 2,
    { events: reference.events.length, claimed: reference.claimed.length });
  check('invoice: payloads after the upgrade are byte for byte the same', JSON.stringify(afterUpgrade.events) === JSON.stringify(reference.events),
    { reference: reference.events, afterUpgrade: afterUpgrade.events });
  check('invoice: payloads on a fresh install are byte for byte the same', JSON.stringify(fromSchema.events) === JSON.stringify(reference.events),
    { reference: reference.events, fromSchema: fromSchema.events });
  check('invoice: what the claim hands out (gross and net) is the same after the upgrade', JSON.stringify(afterUpgrade.claimed) === JSON.stringify(reference.claimed),
    { reference: reference.claimed.slice(0, 2), afterUpgrade: afterUpgrade.claimed.slice(0, 2) });
  check('invoice: what the claim hands out (gross and net) is the same on a fresh install', JSON.stringify(fromSchema.claimed) === JSON.stringify(reference.claimed));
  check('upgrade: an existing invoice-only endpoint gets no new events, and nothing is written for it', outboxAfter === outboxBefore, { outboxBefore, outboxAfter });
}

// ---------------------------------------------------------------------------
// Work events on schema.sql
// ---------------------------------------------------------------------------
async function seed(db: PGlite) {
  const run = q(db);
  await asOwner(db);
  await setModules(db, { billing: true, webhooks: true, time: true, agents: true });
  const member = async (name: string, role = 'agent') =>
    (await run<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const builder = await member('Builder');
  const helper = await member('Helper');
  const morgan = await member('Morgan', 'member');
  const apex = (await run<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  const queue = (await run<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Queue') RETURNING id"))[0].id;
  for (const m of [builder, helper, morgan]) {
    await run('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $3), ($2, $3)', [apex, queue, m]);
  }
  const endpoint = async (name: string, events: string[], filters: { projects?: string[]; member?: string } = {}) =>
    (await run<{ id: string }>(`INSERT INTO pm.webhook_endpoints (name, url, secret, events, project_ids, member_id)
      VALUES ($1, $2, 'whsec_test', $3, $4, $5) RETURNING id`,
    [name, `https://hooks.example.test/${name}`, events, filters.projects ?? null, filters.member ?? null]))[0].id;
  const ep = {
    all: await endpoint('all', WORK_EVENTS),
    apex: await endpoint('apex', WORK_EVENTS, { projects: [apex] }),
    builder: await endpoint('builder', WORK_EVENTS, { member: builder }),
    morgan: await endpoint('morgan', WORK_EVENTS, { member: morgan }),
    invoices: await endpoint('invoices', INVOICE_EVENTS),
  };
  return { run, owner, builder, helper, morgan, apex, queue, ep };
}

async function workChecks() {
  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const { run, ep } = s;
  let mark = 0;
  /** Events since the last call, oldest first, each with the endpoints it went to. */
  const fresh = async () => {
    const rows = await run<EventRow & { endpoints: string[] }>(`SELECT ev.id, ev.sequence::int AS sequence, ev.event_type, ev.resource_type, ev.resource_id, ev.payload,
        coalesce((SELECT array_agg(d.endpoint_id::text ORDER BY d.endpoint_id) FROM pm.webhook_deliveries d WHERE d.webhook_event_id = ev.id), '{}') AS endpoints
      FROM pm.webhook_events ev WHERE ev.sequence > $1 ORDER BY ev.sequence`, [mark]);
    if (rows.length) mark = Math.max(mark, ...rows.map((r) => Number(r.sequence)));
    return rows;
  };
  const went = (row: { endpoints: string[] } | undefined, ...ids: string[]) =>
    !!row && JSON.stringify([...row.endpoints].sort()) === JSON.stringify([...ids].sort());
  const seen = new Map<string, number>();
  const tally = (rows: EventRow[]) => rows.forEach((r) => seen.set(r.event_type, (seen.get(r.event_type) ?? 0) + 1));

  // -- task.created, with the assignee saved in the same transaction ----------
  let task = '';
  await db.transaction(async (tx) => {
    task = (await tx.query<{ id: string }>("INSERT INTO pm.tasks (project_id, title, description, priority) VALUES ($1, 'Fix the checkout total', 'EU rounding', 'high') RETURNING id", [s.apex])).rows[0].id;
    await tx.query('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [task, s.builder]);
  });
  let rows = await fresh();
  tally(rows);
  const created = rows[0];
  check('task.created: a task saved with its assignee is one event', rows.length === 1 && created?.event_type === 'task.created', rows.map((r) => r.event_type));
  check('task.created: the payload is the task as saved, assignee included', created?.payload.type === 'task.created'
    && created.payload.data.task.id === task && created.payload.data.task.title === 'Fix the checkout total'
    && created.payload.data.task.priority === 'high' && created.payload.data.task.status === 'todo'
    && JSON.stringify(created.payload.data.task.assignee_ids) === JSON.stringify([s.builder])
    && created.payload.data.project.name === 'Apex' && created.payload.data.project_id === s.apex && created.payload.data.task_id === task
    && JSON.stringify(created.payload.data.member_ids) === JSON.stringify([s.builder]) && !('changes' in created.payload.data)
    && created.payload.id.startsWith('evt_') && created.payload.sequence === Number(created.sequence), created?.payload);
  check('task.created: the subject is the task', created?.resource_type === 'task' && created.resource_id === task, created);
  check('member filter: a member assigned a task hears of it; the project filter matches its project', went(created, ep.all, ep.apex, ep.builder), created?.endpoints);

  // -- assigned later: task.updated reaches the newly concerned member --------
  const queued = (await run<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Triage the queue') RETURNING id", [s.queue]))[0].id;
  rows = await fresh();
  tally(rows);
  check('task.created in another project: the Apex endpoint and the member endpoints stay out', rows.length === 1 && went(rows[0], ep.all), rows.map((r) => r.endpoints));
  await run('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [queued, s.morgan]);
  rows = await fresh();
  tally(rows);
  check('task.updated: assigning names assignee_ids and reaches the member now concerned', rows.length === 1 && rows[0].event_type === 'task.updated'
    && JSON.stringify(rows[0].payload.data.changes) === '["assignee_ids"]' && went(rows[0], ep.all, ep.morgan), rows.map((r) => [r.event_type, r.payload.data.changes, r.endpoints]));

  // -- nothing for reordering, claims, or a no-op -----------------------------
  await run('UPDATE pm.tasks SET sort_order = sort_order + 5 WHERE id = $1', [task]);
  await run("UPDATE pm.tasks SET claimed_by = $2, claimed_at = now(), claim_expires_at = now() + interval '1 hour' WHERE id = $1", [task, s.helper]);
  await run('UPDATE pm.tasks SET title = title WHERE id = $1', [task]);
  await run("UPDATE pm.tasks SET tags = ARRAY['eu'] WHERE id = $1", [task]);
  rows = await fresh();
  check('sort_order-only writes, claims and fields outside the list fire nothing', rows.length === 0, rows.map((r) => r.event_type));

  // -- one save, several changes: one task.updated -----------------------------
  await db.transaction(async (tx) => {
    await tx.query("UPDATE pm.tasks SET status = 'in_progress', title = 'Fix the EU checkout total' WHERE id = $1", [task]);
    await tx.query('DELETE FROM pm.task_assignees WHERE task_id = $1 AND member_id = $2', [task, s.builder]);
    await tx.query('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [task, s.morgan]);
  });
  rows = await fresh();
  tally(rows);
  const folded = rows[0];
  check('task.updated: changes in one transaction fold into one event', rows.length === 1 && folded?.event_type === 'task.updated', rows.map((r) => r.event_type));
  check('task.updated: changes names every changed field', JSON.stringify(folded?.payload.data.changes) === '["assignee_ids","status","title"]', folded?.payload.data.changes);
  check('task.updated: the payload is the state after the whole save', folded?.payload.data.task.status === 'in_progress'
    && folded.payload.data.task.title === 'Fix the EU checkout total'
    && JSON.stringify(folded.payload.data.task.assignee_ids) === JSON.stringify([s.morgan])
    && folded.payload.data.task.claimed_by === s.helper, folded?.payload.data.task);
  check('member filter: the removed assignee and the claim holder are concerned too',
    JSON.stringify(folded?.payload.data.member_ids) === JSON.stringify([s.builder, s.helper, s.morgan].sort()), folded?.payload.data.member_ids);
  check('member filter: the removed assignee hears they are off it', went(folded, ep.all, ep.apex, ep.builder, ep.morgan), folded?.endpoints);

  // -- project move: the old project's endpoint hears it left ----------------
  await run('UPDATE pm.tasks SET project_id = $2 WHERE id = $1', [task, s.queue]);
  rows = await fresh();
  tally(rows);
  check('project filter: a task moved out of a project reaches that project\'s endpoint', rows.length === 1
    && JSON.stringify(rows[0].payload.data.changes) === '["project_id"]' && rows[0].payload.data.project_id === s.queue
    && rows[0].endpoints.includes(ep.apex), rows.map((r) => [r.payload.data.changes, r.endpoints]));
  await run('UPDATE pm.tasks SET project_id = $2 WHERE id = $1', [task, s.apex]);
  await fresh();

  // -- comment.created: concerns the task's people, not the author -----------
  await actAs(db, null);
  await db.query("SELECT set_config('request.headers', $1, false)", [JSON.stringify({ 'x-actor-member-id': s.builder, 'x-actor-via': 'api' })]);
  const comment = (await run<{ id: string }>("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'Rounding up per EU rules') RETURNING id", [task, s.builder]))[0].id;
  await asOwner(db);
  rows = await fresh();
  tally(rows);
  const commented = rows[0];
  check('comment.created: one event in the task\'s line', rows.length === 1 && commented?.event_type === 'comment.created'
    && commented.resource_type === 'task' && commented.resource_id === task, rows.map((r) => [r.event_type, r.resource_type]));
  check('comment.created: the payload carries the comment, its author and the task', commented?.payload.data.comment.id === comment
    && commented.payload.data.comment.author_id === s.builder && commented.payload.data.comment.text === 'Rounding up per EU rules'
    && commented.payload.data.task.id === task && commented.payload.data.task_id === task && commented.payload.data.project_id === s.apex, commented?.payload.data);
  check('actor_id: the member behind a server write', commented?.payload.data.actor_id === s.builder, commented?.payload.data.actor_id);
  check('member filter: a comment reaches the assignee, not the author for authoring it', went(commented, ep.all, ep.apex, ep.morgan), commented?.endpoints);
  check('actor_id: null for SQL run directly', folded?.payload.data.actor_id === null, folded?.payload.data.actor_id);

  // -- review.submitted -------------------------------------------------------
  await run(`INSERT INTO pm.task_reviews (task_id, round, verdict, summary, pr_url, head_sha, reviewer_member_id)
    VALUES ($1, 1, 'changes_requested', 'Round half up', 'https://example.test/pr/1', $2, $3)`, [task, 'a'.repeat(40), s.helper]);
  rows = await fresh();
  tally(rows);
  check('review.submitted: one event with the verdict, in the task\'s line', rows.length === 1 && rows[0].event_type === 'review.submitted'
    && rows[0].resource_type === 'task' && rows[0].payload.data.review.verdict === 'changes_requested'
    && rows[0].payload.data.review.reviewer_id === s.helper && rows[0].payload.data.review.pr_url === 'https://example.test/pr/1'
    && went(rows[0], ep.all, ep.apex, ep.morgan), rows.map((r) => [r.event_type, r.endpoints]));

  // -- questions --------------------------------------------------------------
  const question = (await run<{ id: string }>(`INSERT INTO pm.questions (task_id, asked_by, asked_to, question, choices)
    VALUES ($1, $2, $3, 'Round the EU total up or down?', '["Up", "Down"]'::jsonb) RETURNING id`, [task, s.builder, s.morgan]))[0].id;
  rows = await fresh();
  tally(rows);
  const asked = rows[0];
  check('question.asked: one event, its own line', rows.length === 1 && asked?.event_type === 'question.asked'
    && asked.resource_type === 'question' && asked.resource_id === question, rows.map((r) => r.event_type));
  check('question.asked: the payload names who asked whom, and where', asked?.payload.data.question.asked_to === s.morgan
    && asked.payload.data.question.asked_by === s.builder && JSON.stringify(asked.payload.data.question.choices) === '["Up","Down"]'
    && asked.payload.data.question.status === 'open' && asked.payload.data.task_id === task && asked.payload.data.project_id === s.apex
    && asked.payload.data.project.name === 'Apex' && JSON.stringify(asked.payload.data.member_ids) === JSON.stringify([s.builder, s.morgan].sort()), asked?.payload.data);
  check('member filter: the member asked and the asker both hear it', went(asked, ep.all, ep.apex, ep.builder, ep.morgan), asked?.endpoints);
  await run(`UPDATE pm.questions SET status = 'answered', answer_choice = 'Up', answered_by = $2, answered_at = now() WHERE id = $1`, [question, s.morgan]);
  rows = await fresh();
  tally(rows);
  check('question.answered: one event with the answer', rows.length === 1 && rows[0].event_type === 'question.answered'
    && rows[0].payload.data.question.answer_choice === 'Up' && rows[0].payload.data.question.answered_by === s.morgan
    && rows[0].payload.data.question.status === 'answered', rows.map((r) => [r.event_type, r.payload.data.question?.status]));
  const loose = (await run<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Can I take Friday off?') RETURNING id`, [s.morgan, s.owner]))[0].id;
  rows = await fresh();
  tally(rows);
  check('question.asked on nothing: no project, so the Apex endpoint stays out; the asker hears it', rows.length === 1
    && rows[0].payload.data.project_id === null && rows[0].payload.data.project === null && went(rows[0], ep.all, ep.morgan), rows.map((r) => r.endpoints));
  await run(`UPDATE pm.questions SET status = 'cancelled', cancelled_by = $2, cancelled_at = now() WHERE id = $1`, [loose, s.morgan]);
  rows = await fresh();
  tally(rows);
  check('question.cancelled: one event', rows.length === 1 && rows[0].event_type === 'question.cancelled' && rows[0].payload.data.question.cancelled_by === s.morgan, rows.map((r) => r.event_type));
  const expiring = (await run<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Still there?') RETURNING id`, [s.helper, s.owner]))[0].id;
  await fresh();
  await run("UPDATE pm.questions SET status = 'expired' WHERE id = $1", [expiring]);
  rows = await fresh();
  check('question expiry sends nothing', rows.length === 0, rows.map((r) => r.event_type));

  // -- suggestions ------------------------------------------------------------
  const suggestion = (await run<{ id: string }>(`INSERT INTO pm.task_suggestions (project_id, proposed_by, assigned_to, title, description, reasoning)
    VALUES ($1, $2, $3, 'Add a sitemap', 'For search', 'Missing') RETURNING id`, [s.apex, s.helper, s.builder]))[0].id;
  rows = await fresh();
  tally(rows);
  check('suggestion.created: one event, its own line, concerning the proposer and the proposed assignee', rows.length === 1
    && rows[0].event_type === 'suggestion.created' && rows[0].resource_type === 'suggestion' && rows[0].resource_id === suggestion
    && rows[0].payload.data.suggestion.title === 'Add a sitemap' && rows[0].payload.data.project_id === s.apex
    && JSON.stringify(rows[0].payload.data.member_ids) === JSON.stringify([s.builder, s.helper].sort())
    && went(rows[0], ep.all, ep.apex, ep.builder), rows.map((r) => [r.event_type, r.endpoints]));
  await run("UPDATE pm.task_suggestions SET status = 'needs_info', info_request = 'Which pages?' WHERE id = $1", [suggestion]);
  rows = await fresh();
  check('suggestion: asking for more information is not a decision', rows.length === 0, rows.map((r) => r.event_type));
  await run("UPDATE pm.task_suggestions SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [suggestion, s.owner]);
  rows = await fresh();
  tally(rows);
  check('suggestion.decided: one event on approval', rows.length === 1 && rows[0].event_type === 'suggestion.decided'
    && rows[0].payload.data.suggestion.status === 'approved' && rows[0].payload.data.suggestion.reviewed_by === s.owner, rows.map((r) => r.event_type));
  const rejected = (await run<{ id: string }>(`INSERT INTO pm.task_suggestions (project_id, proposed_by, title, description, reasoning)
    VALUES ($1, $2, 'Rewrite in Rust', 'Speed', 'Fast') RETURNING id`, [s.queue, s.helper]))[0].id;
  await fresh();
  await run("UPDATE pm.task_suggestions SET status = 'rejected', rejection_reason = 'No' WHERE id = $1", [rejected]);
  rows = await fresh();
  check('suggestion.decided: one event on rejection', rows.length === 1 && rows[0].event_type === 'suggestion.decided'
    && rows[0].payload.data.suggestion.rejection_reason === 'No', rows.map((r) => r.event_type));

  // -- task.deleted, edits in Trash, restore ------------------------------------
  await run('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [queued]);
  rows = await fresh();
  tally(rows);
  check('task.deleted: moving to Trash is one event', rows.length === 1 && rows[0].event_type === 'task.deleted'
    && rows[0].payload.data.task.deleted_at !== null && went(rows[0], ep.all, ep.morgan), rows.map((r) => [r.event_type, r.endpoints]));
  await run("UPDATE pm.tasks SET title = 'Edited in Trash', status = 'done' WHERE id = $1", [queued]);
  await run("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'Too late')", [queued, s.morgan]);
  rows = await fresh();
  check('a task in Trash: edits and comments send nothing', rows.length === 0, rows.map((r) => r.event_type));
  await run('UPDATE pm.tasks SET deleted_at = NULL WHERE id = $1', [queued]);
  rows = await fresh();
  check('restore: sends task.created again, as creating it would', rows.length === 1 && rows[0].event_type === 'task.created'
    && rows[0].payload.data.task.deleted_at === null, rows.map((r) => r.event_type));
  seen.set('task.created', (seen.get('task.created') ?? 0) - 1);

  // -- each type fired, and fired once where it was caused once ---------------
  const expectedOnce = ['task.deleted', 'comment.created', 'review.submitted', 'question.answered', 'question.cancelled', 'suggestion.created'];
  check('every work event type fired', WORK_EVENTS.every((t) => (seen.get(t) ?? 0) > 0), Object.fromEntries(seen));
  check('each event caused once fired once', expectedOnce.every((t) => seen.get(t) === 1), Object.fromEntries(seen));
  check('no invoice endpoint got a work event', (await run<{ n: number }>('SELECT count(*)::int AS n FROM pm.webhook_deliveries WHERE endpoint_id = $1', [ep.invoices]))[0].n === 0);

  // -- no subscribed endpoint, no outbox rows -----------------------------------
  await run('UPDATE pm.webhook_endpoints SET is_active = false WHERE id <> $1', [ep.invoices]);
  const quiet = (await run<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Nobody listens') RETURNING id", [s.apex]))[0].id;
  await run('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [quiet, s.builder]);
  await run("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [quiet]);
  await run("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'Done')", [quiet, s.builder]);
  await run("INSERT INTO pm.questions (task_id, asked_by, asked_to, question) VALUES ($1, $2, $3, 'Ship it?')", [quiet, s.builder, s.owner]);
  await run(`INSERT INTO pm.task_suggestions (project_id, proposed_by, title, description, reasoning) VALUES ($1, $2, 'More', 'More', 'More')`, [s.apex, s.helper]);
  rows = await fresh();
  check('no subscribed endpoint: no outbox rows', rows.length === 0, rows.map((r) => r.event_type));
  // A filter nothing matches writes nothing either.
  await run('UPDATE pm.webhook_endpoints SET is_active = true WHERE id = $1', [ep.morgan]);
  await run("UPDATE pm.tasks SET priority = 'urgent' WHERE id = $1", [quiet]);
  rows = await fresh();
  check('an event no endpoint\'s filter matches: no outbox rows', rows.length === 0, rows.map((r) => r.event_type));
  await run('UPDATE pm.webhook_endpoints SET is_active = true');

  // -- per-subject ordering in the claim -----------------------------------------
  await run("UPDATE pm.webhook_deliveries SET status = 'succeeded'");
  await run('UPDATE pm.webhook_endpoints SET is_active = (id = $1)', [ep.all]);
  const other = (await run<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Other task') RETURNING id", [s.apex]))[0].id;
  await run("UPDATE pm.tasks SET priority = 'low' WHERE id = $1", [task]);
  await run("UPDATE pm.tasks SET priority = 'medium' WHERE id = $1", [task]);
  await run("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'Behind the line')", [task, s.morgan]);
  type Claimed = { delivery_id: string; attempt_token: string; event_type: string; resource_id: string; event_sequence: number };
  const claim = () => run<Claimed>('SELECT delivery_id, attempt_token, event_type, resource_id, event_sequence::int AS event_sequence FROM pm.claim_webhook_deliveries(50)');
  const lineFor = (await run<{ sequence: number; event_type: string }>("SELECT sequence::int AS sequence, event_type FROM pm.webhook_events WHERE resource_type = 'task' AND resource_id = $1 AND sequence > $2 ORDER BY sequence", [task, mark]));
  await fresh();
  let claimed = await claim();
  const forTask = claimed.filter((c) => c.resource_id === task);
  check('ordering: one task\'s events are handed out one at a time, the earliest first', forTask.length === 1 && Number(forTask[0].event_sequence) === lineFor[0]?.sequence, { forTask, lineFor });
  check('ordering: another task is not held back', claimed.some((c) => c.resource_id === other), claimed.map((c) => c.resource_id));
  for (const c of claimed) await run("SELECT pm.complete_webhook_delivery($1, $2, CASE WHEN $3 THEN 503 ELSE 200 END, 'down', NULL)", [c.delivery_id, c.attempt_token, c.resource_id === task]);
  await run("UPDATE pm.webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'");
  claimed = await claim();
  check('ordering: while the first is retrying, the later task.updated and the comment wait', claimed.length === 1
    && Number(claimed[0].event_sequence) === lineFor[0]?.sequence, claimed.map((c) => [c.event_type, c.event_sequence]));
  const order: string[] = [];
  for (let round = 0; round < 5 && claimed.length; round++) {
    for (const c of claimed) {
      order.push(c.event_type);
      await run('SELECT pm.complete_webhook_delivery($1, $2, 200, NULL, NULL)', [c.delivery_id, c.attempt_token]);
    }
    claimed = await claim();
  }
  check('ordering: once it is through, the rest follow in sequence order, the comment in the task\'s line',
    JSON.stringify(order) === JSON.stringify(lineFor.map((e) => e.event_type)) && JSON.stringify(order) === '["task.updated","task.updated","comment.created"]', { order, lineFor });

  // -- Client invoicing off, Webhooks on ------------------------------------------
  await run('UPDATE pm.webhook_endpoints SET is_active = (id IN ($1, $2))', [ep.all, ep.invoices]);
  await run("UPDATE pm.webhook_deliveries SET status = 'succeeded' WHERE status <> 'succeeded'");
  await setModules(db, { billing: false, webhooks: true });
  const invoice = (await run<{ id: string }>(`INSERT INTO pm.project_invoices (project_id, invoice_number, amount, status, invoice_type, date, due_date, paid_date)
    VALUES ($1, 'INV-7', 100, 'paid', 'fixed', '2026-11-01', '2999-01-01', '2026-11-02') RETURNING id`, [s.apex]))[0].id;
  const invoiceDue = (await run<{ n: number }>("SELECT count(*)::int AS n FROM pm.webhook_deliveries d JOIN pm.webhook_events ev ON ev.id = d.webhook_event_id WHERE ev.resource_type = 'invoice' AND ev.resource_id = $1 AND d.status = 'pending'", [invoice]))[0].n;
  check('billing off: the invoice event is still recorded, to wait', invoiceDue > 0, invoiceDue);
  await run("INSERT INTO vault.decrypted_secrets VALUES ('pm_webhook_scheduler_url', 'https://app.example.test'), ('pm_webhook_scheduler_secret', $1)", ['s'.repeat(40)]);
  const kick = async () => (await run<{ id: string | null }>('SELECT pm.webhook_retry_kick()::text AS id'))[0].id;
  check('billing off: an invoice delivery alone does not wake the app', (await kick()) === null);
  await run("UPDATE pm.tasks SET status = 'in_review' WHERE id = $1", [task]);
  check('billing off: a task delivery wakes the app', (await kick()) !== null);
  await fresh();

  // The real dispatcher, through supabase-js, posting to a receiver.
  const received: Array<{ type: string; signed: boolean; body: Loose }> = [];
  const secret = 'whsec_' + crypto.randomBytes(16).toString('hex');
  const receiver = createServer(async (request, response) => {
    const raw = await readBody(request);
    received.push({ type: String(request.headers['x-vm-event-type']), signed: verifySignature(secret, String(request.headers['x-vm-signature'] ?? ''), raw), body: JSON.parse(raw) });
    response.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  await run('UPDATE pm.webhook_endpoints SET url = $1, secret = $2', [base + '/hook', secret]);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const { runDispatch } = await import('../src/lib/webhooks/dispatch');
    await setModules(db, { billing: true, webhooks: false });
    let summary = await runDispatch();
    check('webhooks off: nothing goes out', summary.claimed === 0 && received.length === 0, summary);
    await setModules(db, { billing: false, webhooks: true });
    summary = await runDispatch();
    check('billing off, webhooks on: the task event goes out, signed', received.some((r) => r.type === 'task.updated' && r.signed && r.body.data.task.id === task), received.map((r) => r.type));
    check('billing off, webhooks on: the invoice event waits', !received.some((r) => r.type.startsWith('invoice.')), received.map((r) => r.type));
    check('a work event carries no amount_basis', received.every((r) => !('amount_basis' in r.body.data)), received.map((r) => Object.keys(r.body.data)));
    await setModules(db, { billing: true, webhooks: true });
    await runDispatch();
    check('billing back on: the invoice event goes out', received.some((r) => r.type === 'invoice.paid' && r.body.data.invoice.id === invoice && r.body.data.amount_basis === 'gross'), received.map((r) => r.type));

    // -- An API write sends what it queued right away (the withApi kick) ------
    await apiKickCheck(db, s, received);
  } finally {
    receiver.close();
    await server.close();
  }
  await db.close();
}

async function apiKickCheck(db: PGlite, s: Awaited<ReturnType<typeof seed>>, received: Array<{ type: string; body: Loose }>) {
  const { run } = s;
  await asOwner(db);
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const scopes = ['tasks.read', 'tasks.manage_assigned', 'projects.read'];
  const apiKey = `pk_live_${randomUUID().replace(/-/g, '')}`;
  await run(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
    VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [createHash('sha256').update(apiKey).digest('hex'), s.builder, scopes]);
  await run(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [s.builder, scopes]);
  const mine = (await run<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Builder work') RETURNING id", [s.apex]))[0].id;
  await run('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [mine, s.builder]);
  await run("UPDATE pm.webhook_deliveries SET status = 'succeeded' WHERE status <> 'succeeded'");
  const before = received.length;
  const route = await import('../src/app/api/v1/tasks/[id]/comments/route');
  const response = await route.POST(new NextRequest(`http://localhost/api/v1/tasks/${mine}/comments`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: s.builder, text: 'Picked it up' }),
  }), { params: Promise.resolve({ id: mine }) } as never);
  for (let i = 0; i < 40 && !received.slice(before).some((r) => r.type === 'comment.created'); i++) await new Promise((r) => setTimeout(r, 50));
  const sent = received.slice(before).find((r) => r.type === 'comment.created');
  check('API write: the comment.created it queued is sent at once, naming the agent as actor', response.status === 201
    && sent?.body.data.comment.text === 'Picked it up' && sent.body.data.actor_id === s.builder, { status: response.status, sent: sent?.body.data });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}

// The receiver-side check from WEBHOOKS.md.
function verifySignature(secret: string, header: string, rawBody: string): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

async function main() {
  await workChecks();
  await invoiceChecks();
  if (failures.length) {
    console.error(`agent webhooks: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`agent webhooks: ${passed} checks passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
