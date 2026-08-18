import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const s = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

(async () => {
  const { data, error, count } = await s
    .from('task_reviews')
    .select('task_id, round, verdict, head_sha, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) { console.error('ERROR', error.message); return; }
  console.log('total task_reviews rows:', count);
  for (const r of data ?? []) {
    console.log(`${r.created_at.slice(5, 16)}  r${r.round}  ${r.verdict.padEnd(18)} task ${r.task_id.slice(0, 8)} sha ${String(r.head_sha).slice(0, 8)}`);
  }

  // Anything currently in review, and any running billing session.
  const { data: inReview } = await s.from('tasks').select('id, title, status, updated_at').eq('status', 'in_review');
  console.log('\nin_review tasks:', inReview?.length ?? 0);
  for (const t of inReview ?? []) console.log(`  ${t.title} (updated ${t.updated_at.slice(5, 16)})`);

  const { data: running } = await s
    .from('project_time_entries')
    .select('member_id, start_time, end_time, description, task_ids')
    .is('end_time', null);
  console.log('\nrunning billing sessions:', running?.length ?? 0);
  for (const e of running ?? []) console.log(`  member ${e.member_id.slice(0, 8)} since ${e.start_time.slice(5, 16)} :: ${e.description ?? ''}`);
})();
