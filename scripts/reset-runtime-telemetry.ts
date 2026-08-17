/**
 * Delete every turn.completed row so the publisher can re-backfill from source.
 *
 * Safe by construction: runtime events are derived telemetry, reproducible in
 * full from each container's scheduler ledger and message history. Nothing else
 * references them, and they never touched billing.
 *
 * ORDER MATTERS, learned the hard way. Pause the publisher's crontab line
 * FIRST, then delete, then clear ~/.agent-turns/checkpoint.json, then restore
 * cron. Deleting while it runs lets it checkpoint turns whose rows are being
 * removed, and a checkpointed turn is never re-sent: the totals then sit
 * permanently short with nothing in any log to say so.
 *
 * Run: npx tsx scripts/reset-runtime-telemetry.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (name: string) => env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

(async () => {
  const { count: before } = await supabase
    .from('agent_activities')
    .select('id', { count: 'exact', head: true })
    .eq('activity_type', 'turn.completed');
  console.log(`turn.completed rows before: ${before}`);

  // Deleting by a column that is always present, in pages, so a large backfill
  // does not hit a statement limit.
  for (;;) {
    const { data, error } = await supabase
      .from('agent_activities')
      .select('id')
      .eq('activity_type', 'turn.completed')
      .limit(500);
    if (error) throw error;
    if (!data?.length) break;
    const { error: delError } = await supabase
      .from('agent_activities')
      .delete()
      .in('id', data.map(r => r.id));
    if (delError) throw delError;
    process.stdout.write(`deleted ${data.length}\n`);
  }

  const { count: after } = await supabase
    .from('agent_activities')
    .select('id', { count: 'exact', head: true })
    .eq('activity_type', 'turn.completed');
  console.log(`turn.completed rows after: ${after}`);
})().catch(err => { console.error('FAILED:', err.message ?? err); process.exit(1); });
