import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const s = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

(async () => {
  const { data: tasks } = await s.from('tasks').select('id, title, status, created_at, updated_at, project_id');
  const task = tasks?.find(t => t.id.startsWith('015882fc'))!;
  const { data: team } = await s.from('team_members').select('id, name');
  const nameOf = (id: string | null) => team?.find(m => m.id === id)?.name ?? String(id).slice(0, 8);
  console.log(`TASK ${task.title} [${task.status}]`);

  const rev = await s.from('task_reviews').select('*').eq('task_id', task.id).order('round');
  if (rev.error) console.log('reviews error:', rev.error.message);
  const reviews = rev.data ?? [];
  console.log(`\nREVIEWS (${reviews.length}):`);
  for (const r of reviews) {
    console.log(`  r${String(r.round).padEnd(2)} ${String(r.verdict).padEnd(18)} ${String(r.created_at).slice(5,16)} sha ${String(r.head_sha).slice(0,8)} by ${nameOf(r.reviewer_id)}`);
  }
  const bySha = new Map<string, string[]>();
  for (const r of reviews) bySha.set(String(r.head_sha), [...(bySha.get(String(r.head_sha)) ?? []), `r${r.round}:${r.verdict}`]);
  console.log('\nPER COMMIT:');
  for (const [sha, v] of bySha) {
    const flip = new Set(v.map(x => x.split(':')[1])).size > 1;
    console.log(`  ${sha.slice(0,8)} ${v.join('  ')}${flip ? '   <-- CONTRADICTORY' : ''}`);
  }

  // task_ids lives in a join table, not on the entry row.
  const links = await s.from('time_entry_tasks').select('time_entry_id, task_id').eq('task_id', task.id);
  if (links.error) console.log('links error:', links.error.message);
  const ids = (links.data ?? []).map(l => l.time_entry_id);
  console.log(`\nlinked time entries: ${ids.length}`);
  if (ids.length) {
    const { data: entries } = await s.from('project_time_entries').select('*').in('id', ids);
    let ms = 0;
    for (const e of entries ?? []) {
      const segs = Array.isArray(e.segments) && e.segments.length ? e.segments as {start:string;end:string|null}[] : [{ start: e.start_time, end: e.end_time }];
      let em = 0;
      for (const seg of segs) if (seg.end) em += Date.parse(seg.end) - Date.parse(seg.start);
      ms += em;
      console.log(`  ${nameOf(e.member_id)} ${String(e.start_time).slice(5,16)} -> ${e.end_time ? String(e.end_time).slice(5,16) : 'RUNNING'} ${(em/3.6e6).toFixed(2)}h x${e.billing_multiplier} ${e.approval_status} rate ${e.hourly_rate}`);
    }
    const rate = Number((entries ?? [])[0]?.hourly_rate ?? 0);
    console.log(`  TOTAL ${(ms/3.6e6).toFixed(2)}h => $${((ms/3.6e6)*rate).toFixed(2)}`);
  }
})();
