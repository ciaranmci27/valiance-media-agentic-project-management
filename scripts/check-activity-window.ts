/**
 * Read-only: what fills the newest 100 agent_activities rows, which is the
 * exact window the browser store loads. Telemetry crowding out real work in
 * that window is what starves the dashboard feed and the analytics read model.
 *
 * Run: npx tsx scripts/check-activity-window.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (name: string) => env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

(async () => {
  const { data, error } = await supabase
    .from('agent_activities')
    .select('activity_type, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const row of data ?? []) counts.set(row.activity_type, (counts.get(row.activity_type) ?? 0) + 1);
  console.log('newest 100 rows (the store window):');
  for (const [type, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${type}: ${n}`);
  console.log('oldest row in window:', data?.[data.length - 1]?.created_at);
})().catch(err => { console.error('FAILED:', err.message ?? err); process.exit(1); });
