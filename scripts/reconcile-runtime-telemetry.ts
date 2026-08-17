/**
 * Reconcile recorded runtime against the containers' own records.
 *
 * Telemetry you cannot reconcile is telemetry you cannot trust: this compares
 * the PM database, agent by agent, against the source totals the containers
 * report, and names every turn present in one side and not the other. A number
 * that merely looks plausible is not evidence.
 *
 * Feed it the JSON emitted on the VPS by source_totals.py:
 *   npx tsx scripts/reconcile-runtime-telemetry.ts <path-to-source.json>
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (name: string) => env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

interface SourceAgent { turns: number; ms: number; ids: string[] }

// Container name to the team member who owns it.
const CONTAINER_TO_NAME: Record<string, string> = {
  greg: 'Greg', ashley: 'Ashley', jeff: 'Jeff', john: 'John',
};

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(2)}h`;

(async () => {
  const sourcePath = process.argv[2];
  if (!sourcePath) throw new Error('pass the path to source_totals.json');
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, SourceAgent>;

  const { data: members } = await supabase.from('team_members').select('id, name').eq('role', 'agent');

  const rows: { agent_id: string; metadata: Record<string, unknown> }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('agent_activities')
      .select('agent_id, metadata')
      .eq('activity_type', 'turn.completed')
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data ?? []) as typeof rows);
    if (!data || data.length < 1000) break;
  }

  let allMatch = true;
  for (const [container, src] of Object.entries(source)) {
    const member = members?.find(m => m.name.toLowerCase().startsWith(CONTAINER_TO_NAME[container].toLowerCase()));
    const mine = rows.filter(r => r.agent_id === member?.id);
    const dbIds = new Set(mine.map(r => String((r.metadata ?? {}).source_turn_id)));
    const dbMs = mine.reduce((sum, r) => sum + (Number((r.metadata ?? {}).duration_ms) || 0), 0);

    const missing = src.ids.filter(id => !dbIds.has(id));
    const extra = [...dbIds].filter(id => !src.ids.includes(id));
    const ok = missing.length === 0 && extra.length === 0 && dbMs === src.ms;
    if (!ok) allMatch = false;

    console.log(`${ok ? 'MATCH' : 'DIFF '} ${container.padEnd(7)} source ${String(src.turns).padStart(4)} turns / ${hours(src.ms).padStart(7)}  |  db ${String(mine.length).padStart(4)} turns / ${hours(dbMs).padStart(7)}`);
    if (missing.length) console.log(`        missing from db: ${missing.length} (e.g. ${missing.slice(0, 2).join(', ')})`);
    if (extra.length) console.log(`        in db but not source: ${extra.length} (e.g. ${extra.slice(0, 2).join(', ')})`);
  }

  const srcTotal = Object.values(source).reduce((s, a) => s + a.ms, 0);
  const dbTotal = rows.reduce((s, r) => s + (Number((r.metadata ?? {}).duration_ms) || 0), 0);
  console.log(`\nfleet: source ${hours(srcTotal)} | db ${hours(dbTotal)}`);
  console.log(allMatch ? 'RECONCILED: every turn matches, both directions.' : 'NOT RECONCILED (see rows above).');
  process.exit(allMatch ? 0 : 1);
})().catch(err => { console.error('FAILED:', err.message ?? err); process.exit(2); });
