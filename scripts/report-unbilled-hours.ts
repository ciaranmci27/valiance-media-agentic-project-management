/**
 * Read-only report: per project, unbilled hours the old way (beyond the paid
 * pool only) and the new way (also minus what draft, sent or overdue invoices
 * hold), from production data through the service role. Writes nothing.
 *
 *   npx tsx --tsconfig tsconfig.mcp-test.json scripts/report-unbilled-hours.ts .env.local
 */
import { readFileSync } from 'node:fs';
import {
  buildUnpaidHoursLineItem,
  heldRangesFromInvoices,
  paidHourlyLineItemTotal,
} from '../src/lib/invoice-utils';
import { getWorkedHours, isClientBillable } from '../src/lib/time-entry-utils';
import type { ProjectInvoice, TimeEntry } from '../src/lib/types';

const env = Object.fromEntries(readFileSync(process.argv[2] ?? '.env.local', 'utf8').split(/\r?\n/)
  .filter((line) => /^[A-Z_]+=/.test(line))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, '')]; }));
const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

async function all<T>(path: string): Promise<T[]> {
  let out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, { headers: { ...headers, Range: `${from}-${from + 999}` } });
    const page = (await res.json()) as T[];
    out = out.concat(page);
    if (page.length < 1000) return out;
  }
}

async function main() {
  const projects = await all<{ id: string; name: string; hourly_rate: number | null }>('projects?select=id,name,hourly_rate');
  const invoices = await all<ProjectInvoice & { invoice_time_entry_allocations: ProjectInvoice['time_allocations'] }>(
    'project_invoices?select=*,invoice_time_entry_allocations(*)');
  const entries = await all<TimeEntry>('project_time_entries?select=*');
  for (const project of projects) {
    const mine = invoices.filter((i) => i.project_id === project.id)
      .map((i) => ({ ...i, time_allocations: i.invoice_time_entry_allocations ?? [] }));
    const billable = entries.filter((e) => e.project_id === project.id).filter(isClientBillable)
      .map((e) => ({ id: e.id, start_time: e.start_time, end_time: e.end_time, hours: getWorkedHours(e), hourly_rate: e.hourly_rate }));
    if (billable.length === 0) continue;
    const pool = paidHourlyLineItemTotal(mine);
    const rate = project.hourly_rate ?? 0;
    const before = buildUnpaidHoursLineItem(billable, pool, rate);
    const after = buildUnpaidHoursLineItem(billable, pool, rate, undefined, heldRangesFromInvoices(mine));
    const heldInvoices = mine.filter((i) => ['draft', 'sent', 'overdue'].includes(i.status));
    const heldHours = heldInvoices.reduce((s, i) => s + (i.time_allocations ?? []).reduce((t, a) => t + Number(a.allocated_hours), 0), 0);
    const fmt = (d: typeof before) => (d ? `${d.hours.toFixed(4)} h / $${d.amount.toFixed(2)}` : '0 h / $0.00');
    console.log(`${project.name.padEnd(24)} before ${fmt(before).padEnd(24)} after ${fmt(after).padEnd(24)} `
      + `held by ${heldInvoices.map((i) => `${i.invoice_number} (${i.status})`).join(', ') || 'nothing'} = ${heldHours.toFixed(4)} h`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
