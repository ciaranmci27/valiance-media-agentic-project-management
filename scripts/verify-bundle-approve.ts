/**
 * Live verification of approveTaskSuggestionBundle against the real schema:
 * two throwaway suggestions -> one composed task, union criteria, both
 * members linked; then everything deleted. Run: npx tsx scripts/verify-bundle-approve.ts
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { approveTaskSuggestionBundle } from '../src/lib/supabase/queries';

const env: Record<string, string> = {};
for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const [k, ...v] = t.split('=');
    env[k] = v.join('=').trim();
  }
}
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY);

async function main() {
  const { data: proj } = await supabase.from('projects').select('id').eq('repo_path', 'premierestateplanning/plan4thefuture').single();
  const { data: goal } = await supabase.from('project_goals').select('id').eq('project_id', proj!.id).limit(1).single();
  const { data: greg } = await supabase.from('team_members').select('id').ilike('name', 'Greg%').single();
  const { data: owner } = await supabase.from('team_members').select('id').eq('role', 'owner').single();

  const bundleKey = crypto.randomUUID();
  const base = {
    project_id: proj!.id, goal_id: goal!.id, proposed_by: greg!.id, status: 'pending',
    reasoning: 'verification probe', priority: 'medium', bundle_key: bundleKey,
  };
  const { data: made, error: mkErr } = await supabase.from('task_suggestions').insert([
    { ...base, title: 'PROBE bundle member A', description: 'probe A', metadata: { acceptance_criteria: ['probe criterion A1', 'probe criterion shared'] } },
    { ...base, title: 'PROBE bundle member B', description: 'probe B', metadata: { acceptance_criteria: ['probe criterion B1', 'probe criterion shared'] } },
  ]).select();
  if (mkErr) throw mkErr;
  const ids = made!.map(r => r.id);

  let taskId: string | null = null;
  try {
    const result = await approveTaskSuggestionBundle(supabase, ids, { title: 'PROBE composed task', ai_readiness: 'human_only' }, owner!.id);
    taskId = result.task.id;
    const checks: [string, boolean][] = [
      ['one task created', Boolean(result.task.id)],
      ['composed title', result.task.title === 'PROBE composed task'],
      ['description carries both sections', result.task.description.includes('## PROBE bundle member A') && result.task.description.includes('## PROBE bundle member B')],
      ['criteria are the deduped union (3)', result.task.acceptance_criteria.length === 3],
      ['both members approved + linked', result.suggestions.length === 2 && result.suggestions.every(s => s.status === 'approved' && s.converted_task_id === result.task.id)],
      ['nothing skipped', result.skipped.length === 0],
    ];
    let failed = 0;
    for (const [label, ok] of checks) {
      if (!ok) failed++;
      console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}`);
    }
    if (failed) process.exitCode = 1;
  } finally {
    if (taskId) {
      await supabase.from('task_acceptance_criteria').delete().eq('task_id', taskId);
      await supabase.from('tasks').delete().eq('id', taskId);
    }
    await supabase.from('task_suggestions').delete().in('id', ids);
    console.log('probe rows cleaned up');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
