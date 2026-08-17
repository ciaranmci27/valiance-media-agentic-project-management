/**
 * Read-only: runtime landed per agent, split by how the turn began.
 *
 * Run: npx tsx scripts/check-runtime-telemetry.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (name: string) => env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)}h`;

(async () => {
  const { data: agents } = await supabase.from('team_members').select('id, name').eq('role', 'agent');
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

  const byAgent = new Map<string, { turns: number; ms: number; scheduled: number; directed: number; directedMs: number }>();
  for (const row of rows) {
    const m = row.metadata ?? {};
    const entry = byAgent.get(row.agent_id) ?? { turns: 0, ms: 0, scheduled: 0, directed: 0, directedMs: 0 };
    entry.turns += 1;
    entry.ms += Number(m.duration_ms) || 0;
    if (m.origin === 'directed') { entry.directed += 1; entry.directedMs += Number(m.duration_ms) || 0; }
    else entry.scheduled += 1;
    byAgent.set(row.agent_id, entry);
  }

  let total = 0;
  for (const [id, s] of [...byAgent.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
    const name = agents?.find(a => a.id === id)?.name ?? id;
    total += s.ms;
    console.log(`${name}: ${hours(s.ms)} over ${s.turns} turns (scheduled ${s.scheduled}, directed ${s.directed} / ${hours(s.directedMs)})`);
  }
  console.log(`FLEET RUNTIME: ${hours(total)} across ${rows.length} turns`);
})().catch(err => { console.error('FAILED:', err.message ?? err); process.exit(1); });
