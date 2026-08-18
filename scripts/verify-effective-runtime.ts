/**
 * Effective runtime, with its exclusions itemized rather than summarized.
 *
 * A smaller number you cannot audit is worse than a larger one you can, so this
 * prints what was removed and why, per agent, against live data.
 *
 * Run: npx tsx scripts/verify-effective-runtime.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { computeAgentAnalytics } from '@/lib/agent-analytics';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const s = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

const hrs = (ms: number | null) => ms === null ? '  n/a' : `${(ms / 3_600_000).toFixed(2)}h`;

(async () => {
  const activities: never[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await s.from('agent_activities').select('*').range(off, off + 999);
    if (error) throw error;
    activities.push(...(data ?? []) as never[]);
    if (!data || data.length < 1000) break;
  }
  const [{ data: team }, { data: projects }, { data: timeEntries }] = await Promise.all([
    s.from('team_members').select('*'),
    s.from('projects').select('*'),
    s.from('project_time_entries').select('*'),
  ]);

  const data = computeAgentAnalytics({
    activities,
    timeEntries: (timeEntries ?? []) as never,
    team: (team ?? []) as never,
    projects: (projects ?? []) as never,
    range: { startKey: '2000-01-01', endKey: '2100-01-01' },
    timezone: 'UTC',
  });

  console.log('agent        active   effective    rework  blocked   turns');
  let active = 0, effective = 0, rework = 0;
  for (const a of data.agents) {
    active += a.runtimeMs.value ?? 0;
    effective += a.effectiveRuntimeMs.value ?? 0;
    rework += a.reworkRuntimeMs.value ?? 0;
    console.log(
      `${a.agentName.padEnd(11)} ${hrs(a.runtimeMs.value)}  ${hrs(a.effectiveRuntimeMs.value)}  ` +
      `${hrs(a.reworkRuntimeMs.value)}  ${hrs(a.blockedRuntimeMs.value)}  ${String(a.turns).padStart(5)}`,
    );
  }
  console.log(`${'FLEET'.padEnd(11)} ${hrs(active)}  ${hrs(effective)}  ${hrs(rework)}`);
  const pct = active > 0 ? (rework / active) * 100 : 0;
  console.log(`\nwaste: ${hrs(rework)} of ${hrs(active)} (${pct.toFixed(1)}%)`);
})().catch(err => { console.error('FAILED:', err.message ?? err); process.exit(1); });
