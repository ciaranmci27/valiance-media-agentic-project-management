/**
 * Hours on a draft or sent invoice are held (autonomous invoice drafting,
 * foundation): the SQL walk (invoice_hours_draft_internal) and the browser
 * builders (lib/invoice-utils.ts) must produce the SAME line, cent for cent,
 * on random scenarios; and saving refuses held, unapproved or internal time.
 *
 *   npm run -s test:invoice-hours
 */
import { randomUUID } from 'node:crypto';
import {
  buildPartialUnpaidHoursLineItem,
  buildPartialUnpaidHoursLineItemByAmount,
  billedHourlyPool,
  buildUnpaidHoursLineItem,
  heldRangesFromInvoices,
  type UnpaidHoursLineItemDraft,
} from '../src/lib/invoice-utils';
import type { ProjectInvoice } from '../src/lib/types';
import { createDraftingDatabase } from './invoice-drafting-db';

process.env.TZ = 'UTC'; // the browser formats dates in local time; the workspace here is UTC

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 3000)}`);
}

// A small deterministic random source, so a failure can be replayed by seed.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Db = Awaited<ReturnType<typeof createDraftingDatabase>>;
const rows = async <T,>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

/** What invoice_hours_draft returns (numbers may come back as strings). */
interface SqlDraft {
  hours: number | string;
  amount: number | string;
  description: string;
  allocations: Array<{ time_entry_id: string; start_offset_hours: number | string; allocated_hours: number | string; allocated_amount: number | string }>;
}

interface Entry {
  id: string; start_time: string; end_time: string; hours: number; hourly_rate: number;
}

async function main() {
  const db = await createDraftingDatabase();
  const owner = randomUUID();
  await db.query("INSERT INTO team_members(id, name, role, timezone) VALUES ($1, 'Owner', 'owner', 'UTC')", [owner]);

  const sameLine = (label: string, ts: UnpaidHoursLineItemDraft | null, sql: SqlDraft | null) => {
    if (!ts || !sql) {
      check(`${label}: both empty or both drafted`, !ts && !sql, { ts: ts?.amount, sql: sql?.amount });
      return;
    }
    const tsAlloc = ts.allocations;
    const sqlAlloc = sql.allocations;
    const sameAllocations = tsAlloc.length === sqlAlloc.length && tsAlloc.every((a, i) =>
      a.time_entry_id === sqlAlloc[i].time_entry_id
      && Math.abs(a.start_offset_hours - Number(sqlAlloc[i].start_offset_hours)) < 1e-6
      && Math.abs(a.allocated_hours - Number(sqlAlloc[i].allocated_hours)) < 1e-6
      && Math.round(a.allocated_amount * 100) === Math.round(Number(sqlAlloc[i].allocated_amount) * 100));
    check(`${label}: same amount, hours, sessions, cents and description`,
      Math.round(ts.amount * 100) === Math.round(Number(sql.amount) * 100)
      && Math.abs(ts.hours - Number(sql.hours)) < 1e-6
      && sameAllocations
      && ts.description === sql.description,
      { ts: { amount: ts.amount, hours: ts.hours, d: ts.description, a: tsAlloc }, sql });
  };

  // -- Parity on random scenarios -----------------------------------------
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed);
    const project = randomUUID();
    await db.query("INSERT INTO projects(id, name) VALUES ($1, $2)", [project, `P${seed}`]);
    const entries: Entry[] = [];
    let cursor = Date.UTC(2026, 6, 1, 14, 0);
    const count = 6 + Math.floor(rand() * 10);
    for (let i = 0; i < count; i++) {
      cursor += (2 + Math.floor(rand() * 30)) * 3600_000;
      const start = cursor;
      const first = (0.25 + rand() * 3) * 3600_000;
      const pause = rand() < 0.4 ? (0.2 + rand()) * 3600_000 : 0;
      const second = pause ? (0.1 + rand() * 2) * 3600_000 : 0;
      const segments = pause
        ? [{ start: new Date(start).toISOString(), end: new Date(start + first).toISOString() },
           { start: new Date(start + first + pause).toISOString(), end: new Date(start + first + pause + second).toISOString() }]
        : [{ start: new Date(start).toISOString(), end: new Date(start + first).toISOString() }];
      const end = start + first + pause + second;
      const rate = rand() < 0.7 ? 80 : 95.5;
      const internal = rand() < 0.08;
      const pending = rand() < 0.08;
      const id = randomUUID();
      await db.query(
        `INSERT INTO project_time_entries(id, project_id, member_id, start_time, end_time, segments, hourly_rate, work_type, approval_status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [id, project, owner, new Date(start).toISOString(), new Date(end).toISOString(), JSON.stringify(segments), rate,
         internal ? 'internal' : 'client', pending ? 'pending' : 'approved']);
      if (!internal && !pending) {
        const [{ h }] = await rows<{ h: string }>(db, 'SELECT time_entry_worked_hours(segments, start_time, end_time) h FROM project_time_entries WHERE id=$1', [id]);
        entries.push({ id, start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), hours: Number(h), hourly_rate: rate });
      }
      cursor = end;
    }
    const totalValue = entries.reduce((s, e) => s + e.hours * e.hourly_rate, 0);

    // A paid invoice covering a random prefix of dollars (the legacy pool).
    const paidDollars = Math.round(totalValue * rand() * 0.5 * 100) / 100;
    if (paidDollars > 0) {
      await db.query(
        `INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, invoice_type, date, line_items)
         VALUES ($1, $2, 'INV-001', $3, 'paid', 'hourly', '2026-07-01', $4::jsonb)`,
        [randomUUID(), project, paidDollars, JSON.stringify([{ id: 'h', position: 0, item_type: 'hourly', amount: paidDollars, description: 'Hours' }])]);
    }

    // A held draft: the browser's by-amount line, saved through the real RPC.
    const invoices: ProjectInvoice[] = [];
    const heldTarget = Math.round(totalValue * rand() * 0.3 * 100) / 100;
    const heldDraft = heldTarget > 1 ? buildPartialUnpaidHoursLineItemByAmount(entries, paidDollars, 0, heldTarget) : null;
    if (heldDraft) {
      const saved = await rows<{ id: string }>(db,
        `SELECT (save_project_invoice_with_allocations(NULL, $1::jsonb, $2::jsonb)).id`,
        [JSON.stringify({ project_id: project, invoice_number: 'INV-002', amount: heldDraft.amount, status: 'draft', invoice_type: 'hourly',
          date: '2026-08-01', line_items: [{ id: 'held', position: 0, item_type: 'hourly', amount: heldDraft.amount, description: heldDraft.description }] }),
         JSON.stringify(heldDraft.allocations.map((a) => ({ ...a, line_item_id: 'held' })))]);
      // As the app has them: read back from the database (hours stored to 6 places).
      const stored = await rows<{ time_entry_id: string; start_offset_hours: string; allocated_hours: string }>(db,
        'SELECT time_entry_id, start_offset_hours, allocated_hours FROM invoice_time_entry_allocations WHERE invoice_id = $1', [saved[0].id]);
      invoices.push({ id: saved[0].id, status: 'draft', time_allocations: stored.map((a) => ({
        time_entry_id: a.time_entry_id, start_offset_hours: Number(a.start_offset_hours), allocated_hours: Number(a.allocated_hours),
      })) } as unknown as ProjectInvoice);
    }
    const held = heldRangesFromInvoices(invoices);

    const sqlDraft = async (mode: string, target: number | null, from: string | null = null, through: string | null = null) =>
      (await rows<{ r: SqlDraft | null }>(db, 'SELECT invoice_hours_draft_internal($1, $2, $3, $4, $5) r', [project, mode, target, from, through]))[0].r;

    sameLine(`seed ${seed} all`, buildUnpaidHoursLineItem(entries, paidDollars, 0, undefined, held), await sqlDraft('all', null));
    const hoursTarget = Math.round((0.5 + rand() * 12) * 100) / 100;
    sameLine(`seed ${seed} hours ${hoursTarget}`, buildPartialUnpaidHoursLineItem(entries, paidDollars, 0, hoursTarget, undefined, held), await sqlDraft('hours', hoursTarget));
    const amountTarget = Math.round((50 + rand() * 900) * 100) / 100;
    sameLine(`seed ${seed} amount ${amountTarget}`, buildPartialUnpaidHoursLineItemByAmount(entries, paidDollars, 0, amountTarget, undefined, held), await sqlDraft('amount', amountTarget));
    // A window by session start, as "Custom dates" and the job's cutoff use.
    const mid = entries[Math.floor(entries.length / 2)];
    if (mid) {
      const eligible = new Set(entries.filter((e) => e.start_time < mid.start_time).map((e) => e.id));
      sameLine(`seed ${seed} through`, buildUnpaidHoursLineItem(entries, paidDollars, 0, eligible, held), await sqlDraft('all', null, null, mid.start_time));
    }
  }

  // -- Held hours and the save guards ------------------------------------
  const project = randomUUID();
  await db.query("INSERT INTO projects(id, name) VALUES ($1, 'Guards')", [project]);
  const entry = randomUUID();
  await db.query(
    `INSERT INTO project_time_entries(id, project_id, start_time, end_time, segments, hourly_rate)
     VALUES ($1, $2, '2026-09-01T15:00:00Z', '2026-09-01T19:00:00Z', '[{"start":"2026-09-01T15:00:00Z","end":"2026-09-01T19:00:00Z"}]', 100)`,
    [entry, project]);
  const draftNow = async () => (await rows<{ r: SqlDraft }>(db, 'SELECT invoice_hours_draft_internal($1) r', [project]))[0].r;
  const save = (number: string, status: string, allocation: { start: number; hours: number }, id: string | null = null) =>
    db.query<{ id: string }>(`SELECT (save_project_invoice_with_allocations($1, $2::jsonb, $3::jsonb)).id`, [id,
      JSON.stringify({ project_id: project, invoice_number: number, amount: allocation.hours * 100, status, invoice_type: 'hourly', date: '2026-09-02',
        line_items: [{ id: 'h', position: 0, item_type: 'hourly', amount: allocation.hours * 100, description: 'Hours' }] }),
      JSON.stringify([{ line_item_id: 'h', time_entry_id: entry, start_offset_hours: allocation.start, allocated_hours: allocation.hours, allocated_amount: allocation.hours * 100 }])]);

  check('held: 4 unbilled hours to start', Number((await draftNow()).hours) === 4);
  const first = (await save('INV-101', 'draft', { start: 0, hours: 3 })).rows[0];
  const afterDraft = await draftNow();
  check('held: a draft holds its 3 hours; 1 is left, from offset 3',
    Math.abs(Number(afterDraft.hours) - 1) < 1e-9 && Number(afterDraft.allocations[0].start_offset_hours) === 3, afterDraft);
  let refused = '';
  try { await save('INV-102', 'draft', { start: 2, hours: 2 }); } catch (e) { refused = (e as Error).message; }
  check('guard: hours another live invoice holds are refused, naming it', /already on invoice INV-101/.test(refused), refused);
  await db.query("UPDATE project_invoices SET status = 'sent' WHERE id = $1", [first.id]);
  check('held: a sent invoice still holds', Math.abs(Number((await draftNow()).hours) - 1) < 1e-9);
  await db.query("UPDATE project_invoices SET status = 'cancelled' WHERE id = $1", [first.id]);
  check('held: cancelling frees the hours', Number((await draftNow()).hours) === 4);
  // A line typed over by hand on a draft has no sessions: its dollars count as
  // billed (FIFO), so the job cannot bill those hours again.
  const typedOver = randomUUID();
  await db.query(
    `INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, invoice_type, date, line_items)
     VALUES ($1, $2, 'INV-104', 150, 'draft', 'hourly', '2026-09-05', $3::jsonb)`,
    [typedOver, project, JSON.stringify([{ id: 'typed', position: 0, item_type: 'hourly', amount: 150, description: 'Hours (typed)' }])]);
  const afterTypedOver = await draftNow();
  check('typed over: a live hourly line with no sessions counts as billed (1.5 of the 4 free hours are taken)',
    Math.abs(Number(afterTypedOver.hours) - 2.5) < 1e-9 && Number(afterTypedOver.allocations[0].start_offset_hours) === 1.5, afterTypedOver);
  const tsInvoices = [
    { id: typedOver, status: 'draft', invoice_type: 'hourly', amount: 150, line_items: [{ id: 'typed', item_type: 'hourly', amount: 150 }], time_allocations: [] },
    { id: 'allocated', status: 'sent', invoice_type: 'hourly', amount: 400, line_items: [{ id: 'h', item_type: 'hourly', amount: 400 }],
      time_allocations: [{ line_item_id: 'h', time_entry_id: entry, start_offset_hours: 0, allocated_hours: 4 }] },
  ] as unknown as ProjectInvoice[];
  check('typed over: the browser pool counts it too (and not the allocated line)', billedHourlyPool(tsInvoices) === 150, billedHourlyPool(tsInvoices));
  await db.query("DELETE FROM project_invoices WHERE id = $1", [typedOver]);
  const second = (await save('INV-102', 'draft', { start: 0, hours: 4 })).rows[0];
  check('guard: a cancelled invoice holds nothing, so the same hours can be billed again', Boolean(second.id));
  refused = '';
  try { await db.query("SELECT save_project_invoice_with_allocations($1, '{\"status\":\"draft\"}'::jsonb, NULL)", [first.id]); } catch (e) { refused = (e as Error).message; }
  check('guard: reviving the cancelled invoice is refused while its hours are on another', /already on invoice INV-102/.test(refused), refused);

  const editing = (await rows<{ r: SqlDraft }>(db, 'SELECT invoice_hours_draft_internal($1, $2, NULL, NULL, NULL, $3) r', [project, 'all', second.id]))[0].r;
  check('held: the invoice being edited sees its own hours as free', Number(editing.hours) === 4, editing);

  const pending = randomUUID();
  await db.query(
    `INSERT INTO project_time_entries(id, project_id, start_time, end_time, segments, hourly_rate, approval_status)
     VALUES ($1, $2, '2026-09-03T15:00:00Z', '2026-09-03T16:00:00Z', '[{"start":"2026-09-03T15:00:00Z","end":"2026-09-03T16:00:00Z"}]', 100, 'pending')`,
    [pending, project]);
  refused = '';
  try {
    await db.query(`SELECT save_project_invoice_with_allocations(NULL, $1::jsonb, $2::jsonb)`, [
      JSON.stringify({ project_id: project, invoice_number: 'INV-103', amount: 100, status: 'draft', invoice_type: 'hourly', date: '2026-09-04',
        line_items: [{ id: 'h', position: 0, item_type: 'hourly', amount: 100, description: 'Hours' }] }),
      JSON.stringify([{ line_item_id: 'h', time_entry_id: pending, start_offset_hours: 0, allocated_hours: 1, allocated_amount: 100 }])]);
  } catch (e) { refused = (e as Error).message; }
  check('guard: time awaiting approval cannot be invoiced', /Only approved client time/.test(refused), refused);
  check('unbilled: time awaiting approval is not offered', Number((await draftNow())?.hours ?? 0) === 0);

  refused = '';
  try {
    await db.query(`INSERT INTO project_invoices(project_id, invoice_number, amount, date) VALUES ($1, 'INV-102', 0, '2026-09-05')`, [project]);
  } catch (e) { refused = (e as Error).message; }
  check('numbers: an invoice number is unique within a project', /duplicate key/.test(refused), refused);

  await db.query("SET test.role = 'authenticated'");
  await db.exec(`CREATE OR REPLACE FUNCTION public.has_permission(text, text DEFAULT 'app') RETURNS boolean LANGUAGE sql AS $$ SELECT false $$`);
  refused = '';
  try { await db.query('SELECT invoice_hours_draft($1)', [project]); } catch (e) { refused = (e as Error).message; }
  check('access: a member without invoices.manage cannot draft', /Not allowed/.test(refused), refused);
  await db.query("RESET test.role");

  await db.close();
  if (failures.length) {
    console.error(`invoice hours: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`invoice hours: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
