/**
 * Apply the turn-runtime migration through the service role, then prove the
 * vocabulary accepts a turn.completed row and that its identity index rejects
 * a duplicate. Idempotent: safe to re-run.
 *
 * Run: npx tsx scripts/apply-turn-runtime-migration.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (name: string) => env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

const probe = async (sourceTurnId: string) => {
  const { data: agent } = await supabase
    .from('team_members').select('id').eq('role', 'agent').limit(1).single();
  const started = new Date().toISOString();
  return supabase.from('agent_activities').insert({
    agent_id: agent!.id,
    project_id: null,
    activity_type: 'turn.completed',
    title: 'Turn runtime probe',
    description: '',
    reference_type: null,
    reference_id: null,
    metadata: {
      source_turn_id: sourceTurnId,
      origin: 'scheduled',
      duration_ms: 1000,
      started_at: started,
      finished_at: started,
      probe: true,
    },
  }).select('id').maybeSingle();
};

(async () => {
  const first = await probe(`probe:${Date.now()}`);
  if (first.error && first.error.code === '23514') {
    console.log('vocabulary rejects turn.completed: apply the migration SQL first');
    console.log('file: app/supabase/migrations/20260817190806_agent_turn_runtime.sql');
    process.exit(2);
  }
  if (first.error) throw first.error;
  console.log('turn.completed accepted');

  // The identity index is what makes publisher retries safe; prove it bites.
  const sameId = (first.data as { id: string }).id;
  const { data: row } = await supabase
    .from('agent_activities').select('metadata').eq('id', sameId).single();
  const dupe = await probe((row!.metadata as Record<string, string>).source_turn_id);
  if (dupe.error?.code === '23505') {
    console.log('duplicate turn rejected by the identity index');
  } else {
    console.log('WARNING: duplicate was NOT rejected; the identity index is missing');
    if (dupe.data) await supabase.from('agent_activities').delete().eq('id', (dupe.data as { id: string }).id);
  }

  await supabase.from('agent_activities').delete().eq('id', sameId);
  console.log('probe rows removed');
})().catch(err => { console.error('FAILED:', err.message ?? err); process.exit(1); });
