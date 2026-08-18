/**
 * What does requiring approval change? Runs the finance engine over live data
 * and reports earned versus pending, so the shift is a measured number rather
 * than a claim.
 *
 * Run: npx tsx scripts/verify-approval-gating.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { computeFinanceData } from '@/lib/finance/summary';
import { computeAgentAnalytics } from '@/lib/agent-analytics';

const env = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const s = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

const money = (n: number) => `$${n.toFixed(2)}`;

(async () => {
  const [{ data: projects }, { data: team }, { data: timeEntries }, { data: invoices }] = await Promise.all([
    s.from('projects').select('*'),
    s.from('team_members').select('*'),
    s.from('project_time_entries').select('*'),
    s.from('project_invoices').select('*'),
  ]);

  const rateByProject = new Map<string, number>();
  for (const p of projects ?? []) rateByProject.set(p.id, p.hourly_tracking && p.hourly_rate ? p.hourly_rate : 0);

  const range = { startKey: '2000-01-01', endKey: '2100-01-01' };
  const finance = computeFinanceData({
    projects: (projects ?? []) as never,
    invoices: (invoices ?? []) as never,
    timeEntries: (timeEntries ?? []) as never,
    team: (team ?? []) as never,
    rateByProject,
    now: Date.now(),
    range,
  });
  console.log('FINANCES (all time)');
  console.log(`  earned (owner live + approved): ${money(finance.earned)}`);
  console.log(`  awaiting approval:              ${money(finance.pendingEarned)}`);

  const analytics = computeAgentAnalytics({
    activities: [],
    timeEntries: (timeEntries ?? []) as never,
    team: (team ?? []) as never,
    projects: (projects ?? []) as never,
    range,
  });
  console.log('\nAGENT ANALYTICS');
  for (const a of analytics.agents) {
    if (a.revenue === 0 && a.pendingRevenue === 0) continue;
    console.log(`  ${a.agentName}: revenue ${money(a.revenue)} (${a.hours.toFixed(2)}h approved), pending ${money(a.pendingRevenue)} (${a.pendingHours.toFixed(2)}h)`);
  }
})().catch(err => { console.error('FAILED:', err.message ?? err); process.exit(1); });
