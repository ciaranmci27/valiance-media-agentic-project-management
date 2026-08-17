/**
 * Runtime is elapsed time, so concurrent turns must not be added together.
 * Measured live, 19.8% of Jeff's summed turn time was wall-clock counted twice.
 * These cases pin the merge.
 *
 * Run: npx tsx scripts/verify-runtime-merge.ts
 */
import { computeAgentAnalytics } from '@/lib/agent-analytics';
import type { AgentActivity, Project, TeamMember, TimeEntry } from '@/lib/types';

const AGENT = '11111111-1111-4111-8111-111111111111';
const team = [{ id: AGENT, name: 'Test Agent', role: 'agent' } as TeamMember];
const day = '2026-08-14';

const turn = (id: string, startIso: string, minutes: number): AgentActivity => ({
  id,
  agent_id: AGENT,
  project_id: null,
  activity_type: 'turn.completed',
  title: '',
  description: '',
  reference_type: null,
  reference_id: null,
  metadata: {
    source_turn_id: id,
    origin: 'scheduled',
    duration_ms: minutes * 60_000,
    started_at: startIso,
    finished_at: new Date(Date.parse(startIso) + minutes * 60_000).toISOString(),
  },
  created_at: startIso,
});

const run = (activities: AgentActivity[]) => computeAgentAnalytics({
  activities,
  timeEntries: [] as TimeEntry[],
  team,
  projects: [] as Project[],
  range: { startKey: day, endKey: day },
  now: Date.parse(`${day}T23:59:00.000Z`),
  timezone: 'UTC',
}).agents[0];

let failures = 0;
const check = (label: string, actualMs: number | null, expectedMinutes: number) => {
  const actual = Math.round((actualMs ?? -1) / 60_000);
  const ok = actual === expectedMinutes;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${actual} min (expected ${expectedMinutes})`);
};

// Two turns overlapping by 30 of their 60 minutes: 90 minutes elapsed, not 120.
check('overlapping turns count once', run([
  turn('a', `${day}T10:00:00.000Z`, 60),
  turn('b', `${day}T10:30:00.000Z`, 60),
]).runtimeMs.value, 90);

// One turn fully inside another contributes nothing extra.
check('nested turn adds nothing', run([
  turn('a', `${day}T10:00:00.000Z`, 120),
  turn('b', `${day}T10:30:00.000Z`, 10),
]).runtimeMs.value, 120);

// Turns that do not touch still add up normally.
check('separate turns still sum', run([
  turn('a', `${day}T10:00:00.000Z`, 20),
  turn('b', `${day}T12:00:00.000Z`, 25),
]).runtimeMs.value, 45);

// Back to back turns are one continuous stretch, not a double count.
check('adjacent turns join cleanly', run([
  turn('a', `${day}T10:00:00.000Z`, 30),
  turn('b', `${day}T10:30:00.000Z`, 30),
]).runtimeMs.value, 60);

// The same turn republished (retry, or a reset backfill) counts once.
const duplicate = turn('a', `${day}T10:00:00.000Z`, 45);
check('a republished turn counts once', run([
  duplicate,
  { ...duplicate, id: 'different-row-id' },
]).runtimeMs.value, 45);

console.log(failures === 0 ? '\nRuntime merge verified.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
