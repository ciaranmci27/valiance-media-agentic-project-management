/**
 * Read-only: summarize usage.recorded rows per agent (count, tokens, cost)
 * to confirm the telemetry pipeline end to end.
 *
 * Run: npx tsx scripts/check-usage-telemetry.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (name: string) => env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

(async () => {
  const { data: agents } = await supabase.from('team_members').select('id, name').eq('role', 'agent');
  const { data: rows, error } = await supabase
    .from('agent_activities')
    .select('agent_id, metadata')
    .eq('activity_type', 'usage.recorded')
    .limit(5000);
  if (error) throw error;

  const byAgent = new Map<string, { count: number; input: number; output: number; cost: number }>();
  for (const row of rows ?? []) {
    const m = (row.metadata ?? {}) as Record<string, unknown>;
    const entry = byAgent.get(row.agent_id) ?? { count: 0, input: 0, output: 0, cost: 0 };
    entry.count += 1;
    entry.input += Number(m.input_tokens) || 0;
    entry.output += Number(m.output_tokens) || 0;
    entry.cost += Number(m.cost_usd) || 0;
    byAgent.set(row.agent_id, entry);
  }
  const nameOf = (id: string) => agents?.find(a => a.id === id)?.name ?? id;
  for (const [id, s] of byAgent) {
    console.log(`${nameOf(id)}: ${s.count} events, in ${s.input.toLocaleString()}, out ${s.output.toLocaleString()}, cost $${s.cost.toFixed(2)}`);
  }
  const { count } = await supabase
    .from('agent_activities')
    .select('id', { count: 'exact', head: true })
    .eq('activity_type', 'pr.merged');
  console.log(`pr.merged events: ${count}`);
})().catch(err => { console.error('FAILED:', err.message ?? err); process.exit(1); });
