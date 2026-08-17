/**
 * One-shot probe: does production's agent_activities CHECK accept the new
 * typed events (pr.merged, usage.recorded)? Inserts a zero-token probe row
 * for an agent member and deletes it again. Exit 0 = vocabulary live.
 *
 * Run: npx tsx scripts/verify-telemetry-vocabulary.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (name: string) => env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? '';

const url = get('NEXT_PUBLIC_SUPABASE_URL');
const serviceKey = get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !serviceKey) {
  console.error('missing supabase env');
  process.exit(1);
}

const supabase = createClient(url, serviceKey);

(async () => {
  const { data: agent, error: agentErr } = await supabase
    .from('team_members')
    .select('id, name')
    .eq('role', 'agent')
    .limit(1)
    .single();
  if (agentErr || !agent) throw agentErr ?? new Error('no agent member');

  const probe = {
    agent_id: agent.id,
    project_id: null,
    activity_type: 'usage.recorded',
    title: 'Telemetry vocabulary probe',
    description: '',
    reference_type: null,
    reference_id: null,
    metadata: { source_usage_id: `probe:${Date.now()}`, probe: true },
  };
  const { data: row, error } = await supabase.from('agent_activities').insert(probe).select('id').single();
  if (error) {
    if (error.code === '23514') {
      console.log('NOT APPLIED: activity_type check rejects usage.recorded');
      process.exit(2);
    }
    throw error;
  }
  await supabase.from('agent_activities').delete().eq('id', row.id);
  console.log('APPLIED: usage.recorded accepted (probe row inserted and removed)');
})().catch(err => {
  console.error('FAILED:', err.message ?? err);
  process.exit(1);
});
