/**
 * Effective runtime (outcome work minus rework), with every other line itemized.
 *
 * A smaller number you cannot audit is worse than a larger one you can, so this
 * prints what was removed and why, per agent, against live data.
 *
 * Run: npx tsx scripts/verify-effective-runtime.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { computeTelemetryAnalytics } from '@/lib/agent-telemetry-analytics';

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
  const { data: team } = await s.from('team_members').select('*');

  const data = computeTelemetryAnalytics({
    activities,
    team: (team ?? []) as never,
    range: { startKey: '2000-01-01', endKey: '2100-01-01' },
    timezone: 'UTC',
  });

  console.log('agent        active   effective    rework     idle  waiting  unlabelled   turns');
  for (const { agentName, accounting: a } of data.perAgent) {
    console.log(
      `${agentName.padEnd(11)} ${hrs(a.activeMs)}  ${hrs(a.effectiveMs)}  ${hrs(a.lines.rework)}  ` +
      `${hrs(a.lines.idle)}  ${hrs(a.lines.waiting)}  ${hrs(a.lines.unlabelled)}  ${String(a.turns).padStart(5)}`,
    );
  }
  const f = data.fleet;
  console.log(`${'FLEET'.padEnd(11)} ${hrs(f.activeMs)}  ${hrs(f.effectiveMs)}  ${hrs(f.lines.rework)}`);
  const pct = f.activeMs > 0 ? (f.effectiveMs / f.activeMs) * 100 : 0;
  console.log(`
effective: ${hrs(f.effectiveMs)} of ${hrs(f.activeMs)} (${pct.toFixed(1)}%)`);
})().catch(err => { console.error('FAILED:', err.message ?? err); process.exit(1); });
