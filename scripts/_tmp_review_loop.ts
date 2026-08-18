import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const s = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

(async () => {
  const { data: reviews } = await s
    .from('task_reviews')
    .select('task_id, round, verdict, pr_url, head_sha, created_at, reviewer_id')
    .order('created_at', { ascending: false })
    .limit(60);

  const byTask = new Map<string, typeof reviews>();
  for (const r of reviews ?? []) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, [] as never);
    byTask.get(r.task_id)!.push(r);
  }

  for (const [taskId, rows] of byTask) {
    const maxRound = Math.max(...rows!.map(r => r.round));
    if (maxRound < 3) continue;
    const { data: task } = await s.from('tasks').select('title, status, project_id, created_at').eq('id', taskId).maybeSingle();
    console.log(`\n=== TASK ${task?.title ?? taskId} [${task?.status}] created ${task?.created_at?.slice(0, 16)}`);
    console.log(`    rounds recorded: ${rows!.length}, max round ${maxRound}`);
    const shas = new Set(rows!.map(r => r.head_sha));
    console.log(`    distinct head SHAs: ${shas.size}`);
    for (const r of rows!.slice().sort((a, b) => a.round - b.round)) {
      console.log(`      r${r.round} ${r.verdict.padEnd(18)} ${r.created_at.slice(5, 16)} sha ${String(r.head_sha).slice(0, 8)}`);
    }
    // What has this task cost so far?
    const { data: entries } = await s
      .from('project_time_entries')
      .select('member_id, start_time, end_time, segments, hourly_rate, billing_multiplier, approval_status, task_ids')
      .contains('task_ids', [taskId]);
    let ms = 0;
    for (const e of entries ?? []) {
      const segs = Array.isArray(e.segments) && e.segments.length ? e.segments as { start: string; end: string | null }[] : [{ start: e.start_time, end: e.end_time }];
      for (const seg of segs) if (seg.end) ms += Date.parse(seg.end) - Date.parse(seg.start);
    }
    const rate = Number(entries?.[0]?.hourly_rate ?? 0);
    console.log(`    billing sessions: ${entries?.length ?? 0}, ${(ms / 3_600_000).toFixed(2)}h, rate ${rate}/h => $${((ms / 3_600_000) * rate).toFixed(2)}`);
    for (const e of entries ?? []) {
      console.log(`      ${e.start_time.slice(5, 16)} -> ${e.end_time?.slice(5, 16) ?? 'RUNNING'} ${e.approval_status} x${e.billing_multiplier}`);
    }
  }
})();
