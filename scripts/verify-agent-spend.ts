/**
 * Agent spend, counted once and the same way everywhere
 * (20261125000800_agent_spend.sql): pm.agent_spend_facts is the only rule,
 * pm.agent_spend sums it for the budget (pm.agent_limit_state), and
 * pm.agent_run_stats sums it for Analytics.
 * - The migration, run twice on the schema without it, matches schema.sql;
 *   on that upgraded database the same rows read $60 before (the largest of
 *   usage, runs and turns) and $110 after (run totals plus unattached usage).
 * - The rule: a run's own totals for work under a run; usage and turns that
 *   name a run never add again (they stand in only where the run reports no
 *   cost or tokens above 0); usage that names no run adds on top; turns that name no
 *   run add only for an agent with no usage ledger. A mutated rule that
 *   adds attached usage again fails these checks.
 * - The budget over the real routes: a run reporting $60 plus $50 of usage
 *   with no run refuses a new run at a $100 cap (402 budget_exceeded,
 *   spent_usd 110); usage that names the run is kept attached and is not
 *   added again; usage naming a run that is not the agent's is kept with no
 *   run_id.
 * - Analytics: the read model's totals and its agent, project and model
 *   rows equal the SQL facts, with no event rows at all, and 12,000 usage
 *   records (past the 10,000 row cap) still give exact totals.
 * - By person: the facts carry principal_id (who the work was for), and
 *   Analytics' spend splits by it, adding up to the agent's total.
 * - Grants: the facts run as the caller (members, for Analytics); the sums
 *   are the server's only.
 *
 *   npm run -s test:agent-spend
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { breakdown, buildAgentAnalytics, type AgentAnalyticsInput, type BreakdownLabels } from '../src/lib/agent-analytics-model';
import { runStatsFromAnswer } from '../src/lib/agent-analytics-window';
import { ANALYTICS_ROW_CAP } from '../src/lib/agent-analytics-reads';

const MIGRATION = '20261125000800_agent_spend.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
// Not "-- AGENT ...": test:agent-plumbing keeps its section the last of those.
const BANNER = '-- SPEND, COUNTED ONCE (20261125000800_agent_spend.sql)';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

const OWNER = { id: '00000000-0000-4000-8000-00000000e001', email: 'olivia@example.com' };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** schema.sql with this migration's section cut out (sections after it stay). */
function schemaWithoutSection(): string {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const start = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  const next = /\n-- =+\n-- [^\n]*\(\d{14}_[a-z0-9_]+\.sql\)/g;
  next.lastIndex = at + BANNER.length;
  const after = next.exec(SCHEMA_SQL);
  // A later section that replaces pm.agent_run_stats reads agent_spend_facts,
  // which only this section makes: it is held back and run after the
  // migration (laterRunStats), as an install upgrading in order would.
  const tail = after ? SCHEMA_SQL.slice(after.index).replace(LATER_RUN_STATS, '\n') : '\n';
  return SCHEMA_SQL.slice(0, start) + tail;
}

const LATER_RUN_STATS = /\nCREATE OR REPLACE FUNCTION pm\.agent_run_stats\([\s\S]*?\nGRANT EXECUTE ON FUNCTION pm\.agent_run_stats\([^\n]*\n/g;

/** The later sections' replacements of pm.agent_run_stats that schemaWithoutSection held back. */
function laterRunStats(): string {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const next = /\n-- =+\n-- [^\n]*\(\d{14}_[a-z0-9_]+\.sql\)/g;
  next.lastIndex = at + BANNER.length;
  const after = next.exec(SCHEMA_SQL);
  return after ? (SCHEMA_SQL.slice(after.index).match(LATER_RUN_STATS) ?? []).join('\n') : '';
}

/** The current UTC month, as the budget reads it, and the days so far. */
function monthWindow() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const today = now.toISOString().slice(0, 10);
  return { from: from.toISOString(), to: to.toISOString(), startKey: from.toISOString().slice(0, 10), endKey: today };
}

const q = (db: PGlite) => async <T = Loose>(sql: string, params: unknown[] = []) => {
  await db.exec('RESET ROLE');
  return (await db.query<T>(sql, params)).rows;
};

async function addAgent(db: PGlite, name: string): Promise<string> {
  return (await q(db)<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, 'agent') RETURNING id",
    [name, `${name.toLowerCase()}@example.com`]))[0].id;
}

async function addRun(db: PGlite, agentId: string, fields: { cost?: number | null; tin?: number | null; tout?: number | null; model?: string; projectId?: string | null }): Promise<string> {
  return (await q(db)<{ id: string }>(`INSERT INTO pm.agent_runs (agent_id, project_id, title, status, model, provider, tokens_in, tokens_out, cost_usd, started_at, finished_at)
    VALUES ($1, $2, 'Run', 'succeeded', $3, 'anthropic', $4, $5, $6, now() - interval '1 minute', now()) RETURNING id`,
  [agentId, fields.projectId ?? null, fields.model ?? 'claude-opus', fields.tin ?? null, fields.tout ?? null, fields.cost ?? null]))[0].id;
}

async function addUsage(db: PGlite, agentId: string, fields: { cost: number; tin: number; tout: number; cached?: number; runId?: string; projectId?: string | null; model?: string }) {
  const metadata = {
    source_usage_id: `u-${randomUUID()}`, model: fields.model ?? 'claude-opus', provider: 'anthropic',
    input_tokens: fields.tin, output_tokens: fields.tout, cached_tokens: fields.cached ?? 0, cost_usd: fields.cost,
    recorded_at: new Date().toISOString(), ...(fields.runId ? { run_id: fields.runId } : {}),
  };
  await q(db)("INSERT INTO pm.agent_activities (agent_id, project_id, activity_type, title, metadata) VALUES ($1, $2, 'usage.recorded', 'Usage', $3)",
    [agentId, fields.projectId ?? null, metadata]);
}

async function addTurn(db: PGlite, agentId: string, fields: { tin: number; tout: number; runId?: string }) {
  const finished = new Date();
  const metadata = {
    source_turn_id: `t-${randomUUID()}`, origin: 'scheduled', duration_ms: 1000, outcome: 'work', model: 'claude-opus',
    started_at: new Date(finished.getTime() - 1000).toISOString(), finished_at: finished.toISOString(),
    tokens_scope: 'turn', tokens: { input: fields.tin, output: fields.tout, cache_read: 5000 },
    ...(fields.runId ? { run_id: fields.runId } : {}),
  };
  await q(db)("INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata) VALUES ($1, 'turn.completed', 'Turn', $2)", [agentId, metadata]);
}

async function spendOf(db: PGlite, agentId: string, window = monthWindow()): Promise<{ usd: number; tokens: number; unpriced: number }> {
  const row = (await q(db)<Loose>('SELECT spent_usd::float8 AS usd, spent_tokens::float8 AS tokens, unpriced_tokens::float8 AS unpriced FROM pm.agent_spend($1, $2, $3)',
    [window.from, window.to, [agentId]]))[0];
  return { usd: row?.usd ?? 0, tokens: row?.tokens ?? 0, unpriced: row?.unpriced ?? 0 };
}

async function limitSpent(db: PGlite, agentId: string): Promise<{ usd: number; tokens: number }> {
  await actAs(db, null);
  const state = (await db.query<{ s: Loose }>('SELECT pm.agent_limit_state($1, true) AS s', [agentId])).rows[0].s;
  await db.exec('RESET ROLE');
  return { usd: Number(state.spent_usd), tokens: Number(state.spent_tokens) };
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  check('schema.sql: the agent spend section is there', SCHEMA_SQL.includes(BANNER));
  check('schema.sql: the section mirrors the migration', SCHEMA_SQL.includes(MIGRATION_SQL.trim()));
  check('migration: replaces, never drops', !/\bDROP\s+(FUNCTION|TABLE|INDEX|VIEW)\b/i.test(MIGRATION_SQL) && !/GREATEST\(v_usage_cost/.test(MIGRATION_SQL));

  const old = await createFullSchemaDatabase({ schemaSql: schemaWithoutSection() });
  const legacy = await addAgent(old, 'Legacy');
  await addRun(old, legacy, { cost: 60, tin: 1000, tout: 100 });
  await addUsage(old, legacy, { cost: 50, tin: 500, tout: 50 });
  const before = await limitSpent(old, legacy);
  await old.exec(MIGRATION_SQL);
  await old.exec(MIGRATION_SQL);
  const later = laterRunStats();
  if (later) await old.exec(later);
  const after = await limitSpent(old, legacy);
  console.log(`  before (2.0.40 rule, largest of the three): spent_usd ${before.usd}, spent_tokens ${before.tokens}`);
  console.log(`  after (run totals + unattached usage):       spent_usd ${after.usd}, spent_tokens ${after.tokens}`);
  check('upgrade: before, a $60 run beside $50 of usage with no run read as $60 (the bug: a $100 cap never trips)', before.usd === 60, before);
  check('upgrade: after, the same rows read $110 and 1,650 tokens', after.usd === 110 && after.tokens === 1650, after);

  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema without it, matches schema.sql', diff.length === 0, diff.slice(0, 10));

  await fresh.exec('RESET ROLE');
  const grants = (await fresh.query<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('agent_spend_facts', 'agent_spend', 'agent_limit_state', 'agent_run_stats')`)).rows;
  const g = Object.fromEntries(grants.map((r: Loose) => [r.name, r]));
  check('grants: anon runs none of them', grants.length === 4 && grants.every((r: Loose) => !r.anon), grants);
  check('grants: the facts and the run sums run as the caller (members); the spend sums and the limit state are the server\'s',
    g.agent_spend_facts?.auth && g.agent_run_stats?.auth && !g.agent_spend?.auth && !g.agent_limit_state?.auth
      && grants.every((r: Loose) => r.svc), grants);
  await fresh.close();
  await old.close();
}

// ── The rule, in SQL ─────────────────────────────────────────────────────

interface RuleFixture { runner: string; harness: string; turner: string; hermes: string; zero: string; run1: string }

async function seedRule(db: PGlite): Promise<RuleFixture> {
  const runner = await addAgent(db, 'Runner');
  const harness = await addAgent(db, 'Harness');
  const turner = await addAgent(db, 'Turner');
  const hermes = await addAgent(db, 'Hermes');
  // Runner: a run reporting $60 and 1,100 tokens; $50 of usage with no run;
  // $40 of usage that names the run (part of the run, not added again).
  const run1 = await addRun(db, runner, { cost: 60, tin: 1000, tout: 100 });
  await addUsage(db, runner, { cost: 50, tin: 500, tout: 50 });
  await addUsage(db, runner, { cost: 40, tin: 400, tout: 40, runId: run1 });
  // Harness: a run reporting nothing of its own; its attached usage stands in
  // ($7, 770 tokens), and its attached turn does not add (a usage ledger).
  const run2 = await addRun(db, harness, {});
  await addUsage(db, harness, { cost: 7, tin: 700, tout: 70, cached: 10, runId: run2 });
  await addTurn(db, harness, { tin: 9000, tout: 900, runId: run2 });
  // Turner: no usage ledger. A turn with no run adds 330; a run reporting no
  // tokens takes its attached turn's 220. Nothing priced.
  await addTurn(db, turner, { tin: 300, tout: 30 });
  const run3 = await addRun(db, turner, {});
  await addTurn(db, turner, { tin: 200, tout: 20, runId: run3 });
  // Hermes: a usage ledger ($2, 220) and turns with no run (the same work).
  await addUsage(db, hermes, { cost: 2, tin: 200, tout: 20 });
  await addTurn(db, hermes, { tin: 999, tout: 99 });
  // Zero: a run stored with cost 0 and 0 tokens; its attached usage ($5,
  // 550 tokens) stands in, as for a run reporting nothing.
  const zero = await addAgent(db, 'Zero');
  const run4 = await addRun(db, zero, { cost: 0, tin: 0, tout: 0 });
  await addUsage(db, zero, { cost: 5, tin: 500, tout: 50, runId: run4 });
  return { runner, harness, turner, hermes, zero, run1 };
}

/** Each rule as a check; answers what failed, so a mutated rule can be shown to fail. */
async function ruleFailures(db: PGlite, f: RuleFixture): Promise<string[]> {
  const out: string[] = [];
  const expect = async (label: string, agentId: string, usd: number, tokens: number) => {
    const s = await spendOf(db, agentId);
    if (!close(s.usd, usd) || s.tokens !== tokens) out.push(`${label}: ${JSON.stringify(s)}`);
  };
  await expect('a run\'s own totals plus usage with no run ($110, 1,650 tokens); the $40 that names the run is not added again', f.runner, 110, 1650);
  await expect('a run with no cost or tokens of its own takes its attached usage ($7, 770); its attached turn does not add', f.harness, 7, 770);
  await expect('no ledger: a turn with no run adds, a run with no tokens takes its turns (550 tokens, nothing priced)', f.turner, 0, 550);
  await expect('a ledger agent\'s turns with no run are its usage, never added beside it ($2, 220)', f.hermes, 2, 220);
  await expect('a run stored with cost 0 and 0 tokens takes its attached usage ($5, 550)', f.zero, 5, 550);
  const limit = await limitSpent(db, f.runner);
  if (limit.usd !== 110 || limit.tokens !== 1650) out.push(`the budget reads pm.agent_spend: ${JSON.stringify(limit)}`);
  return out;
}

async function ruleChecks(db: PGlite, f: RuleFixture) {
  const good = await ruleFailures(db, f);
  check('rule: run totals + unattached usage, attached rows never twice, turns only without a ledger', good.length === 0, good);
  const turner = await spendOf(db, f.turner);
  check('rule: tokens with no cost above 0 are unpriced, never a real zero spend', turner.unpriced === 550 && turner.usd === 0, turner);

  // A mutated rule that adds usage naming a run again must fail the checks.
  const start = MIGRATION_SQL.indexOf('CREATE OR REPLACE FUNCTION pm.agent_spend_facts');
  const factsFn = MIGRATION_SQL.slice(start, MIGRATION_SQL.indexOf('$$;', start) + 3);
  const mutant = factsFn.replace("  from usage_in u\n  where u.m->>'run_id' is null\n", '  from usage_in u\n');
  check('rule: the mutation applies (the attached-usage filter is where the test expects it)', mutant !== factsFn);
  await q(db)(mutant);
  const bad = await ruleFailures(db, f);
  await q(db)(factsFn);
  check('rule: a rule that adds attached usage again fails ($150, not $110), so these checks can fail', bad.some((line) => /\$110/.test(line)) && bad.some((line) => /budget/.test(line)), bad);
  check('rule: restored, every check passes again', (await ruleFailures(db, f)).length === 0);
}

// ── Spend by who it was for ──────────────────────────────────────────────

/**
 * A personal assistant works for Mia and for itself: its run for Mia ($30),
 * usage for Mia with no run ($12), usage naming that run ($9, part of the
 * run), and usage for nobody ($5). The facts and Analytics' spend split it
 * by person: Mia $42, the agent itself $5, adding up to the agent's $47.
 */
async function principalChecks(db: PGlite) {
  const agent = await addAgent(db, 'Assistant');
  const mia = (await q(db)<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Mia', 'mia@example.com', 'member') RETURNING id"))[0].id;
  const run = await addRun(db, agent, { cost: 30, tin: 300, tout: 30 });
  await addUsage(db, agent, { cost: 12, tin: 120, tout: 12 });
  await addUsage(db, agent, { cost: 9, tin: 90, tout: 9, runId: run });
  await addUsage(db, agent, { cost: 5, tin: 50, tout: 5 });
  // The person is stamped from the request (X-Act-For) at write time; set it by hand here.
  await q(db)('ALTER TABLE pm.agent_runs DISABLE TRIGGER stamp_principal');
  await q(db)('ALTER TABLE pm.agent_activities DISABLE TRIGGER stamp_principal');
  await q(db)('UPDATE pm.agent_runs SET principal_id = $2 WHERE id = $1', [run, mia]);
  await q(db)("UPDATE pm.agent_activities SET principal_id = $2 WHERE agent_id = $1 AND (metadata->>'cost_usd')::numeric IN (12, 9)", [agent, mia]);
  await q(db)('ALTER TABLE pm.agent_runs ENABLE TRIGGER stamp_principal');
  await q(db)('ALTER TABLE pm.agent_activities ENABLE TRIGGER stamp_principal');

  const window = monthWindow();
  const facts = await q(db)<Loose>(`SELECT principal_id, sum(cost_usd)::float8 AS usd, sum(tokens_in + tokens_out)::float8 AS tokens
    FROM pm.agent_spend_facts($1, $2, $3) GROUP BY principal_id`, [window.from, window.to, [agent]]);
  const forMia = facts.find((r) => r.principal_id === mia);
  const forNobody = facts.find((r) => r.principal_id === null);
  check('by person: the facts carry who the work was for (Mia $42 and 462 tokens: her run and her usage, not the usage naming the run again)',
    facts.length === 2 && close(forMia?.usd, 42) && forMia?.tokens === 462, facts);
  check('by person: work the agent did as itself has no person ($5)', close(forNobody?.usd, 5) && forNobody?.tokens === 55, forNobody);
  check('by person: the split adds up to the agent\'s spend ($47)', close((await spendOf(db, agent)).usd, 47), await spendOf(db, agent));

  const answer = (await db.query<{ r: Loose }>('SELECT pm.agent_run_stats($1, $2, $3) AS r', [window.startKey, window.endKey, 'UTC'])).rows[0].r;
  const stats = runStatsFromAnswer(answer);
  const byPerson = new Map<string | null, number>();
  for (const g of stats.spend ?? []) if (g.agentId === agent) byPerson.set(g.principalId ?? null, (byPerson.get(g.principalId ?? null) ?? 0) + g.costUsd);
  check('by person: Analytics\' spend splits by person (Mia $42, none $5)', byPerson.size === 2 && close(byPerson.get(mia) ?? 0, 42) && close(byPerson.get(null) ?? 0, 5),
    Object.fromEntries(byPerson));
  const raw = (answer.spend as Loose[]).find((row) => row[0] === agent && row[11] === mia);
  check('by person: the person rides as the twelfth field, after the eleven the previous screens read', !!raw && raw.length === 12, raw);
}

// ── Analytics ────────────────────────────────────────────────────────────

async function analyticsChecks(db: PGlite, f: RuleFixture) {
  const window = monthWindow();
  await q(db)('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await q(db)('UPDATE pm.workspace_modules SET enabled = true');
  await q(db)('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [OWNER.id, OWNER.email]);
  await q(db)("INSERT INTO pm.team_members (name, email, role, auth_user_id) VALUES ('Olivia', $1, 'owner', $2)", [OWNER.email, OWNER.id]);
  const project = (await q(db)<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Site') RETURNING id"))[0].id;
  // Past the row cap: 12,000 usage records of a cent each, half on a project.
  const fleet = await addAgent(db, 'Fleet');
  const RECORDS = 12_000;
  await q(db)(`INSERT INTO pm.agent_activities (agent_id, project_id, activity_type, title, metadata)
    SELECT $1, CASE WHEN i % 2 = 0 THEN $2::uuid END, 'usage.recorded', 'Usage',
      jsonb_build_object('source_usage_id', 'bulk-' || i, 'model', CASE WHEN i % 3 = 0 THEN 'gpt-5' ELSE 'claude-opus' END,
        'input_tokens', 100, 'output_tokens', 10, 'cached_tokens', 0, 'cost_usd', 0.01, 'recorded_at', now() - make_interval(secs => i))
    FROM generate_series(1, $3::int) i`, [fleet, project, RECORDS]);

  const agents = [f.runner, f.harness, f.turner, f.hermes, f.zero, fleet];
  const sql = (await q(db)<Loose>('SELECT agent_id, spent_usd::float8 AS usd, tokens_in::float8 AS tin, tokens_out::float8 AS tout, tokens_cached::float8 AS cached FROM pm.agent_spend($1, $2)',
    [window.from, new Date(Date.parse(`${window.endKey}T00:00:00Z`) + 86_400_000).toISOString()]));
  const byAgent = new Map(sql.map((r: Loose) => [r.agent_id as string, r]));
  const fleetSql = byAgent.get(fleet);
  check(`analytics: ${RECORDS.toLocaleString('en-US')} records (past the ${ANALYTICS_ROW_CAP.toLocaleString('en-US')} row cap) sum exactly in SQL ($120, 1,320,000 tokens)`,
    RECORDS > ANALYTICS_ROW_CAP && close(fleetSql?.usd, 120) && fleetSql?.tin + fleetSql?.tout === 1_320_000, fleetSql);

  await actAs(db, OWNER.id);
  const answer = (await db.query<{ r: Loose }>('SELECT pm.agent_run_stats($1, $2, $3) AS r', [window.startKey, window.endKey, 'UTC'])).rows[0].r;
  await actAs(db, null);
  await db.exec('RESET ROLE');
  const stats = runStatsFromAnswer(answer);
  check('analytics: the run sums carry spend, summed (a few groups, never the records)', Array.isArray(stats.spend) && stats.spend.length > 0 && stats.spend.length < 50, stats.spend?.length);

  const input = (over: Partial<AgentAnalyticsInput> = {}): AgentAnalyticsInput => ({
    range: { startKey: window.startKey, endKey: window.endKey }, timezone: 'UTC', now: Date.now(),
    agents: agents.map((id, i) => ({ id, name: `Agent ${i}`, role: null })),
    projects: [], runs: [], activities: [], questions: [], tasks: [], reopens: [], timeEntries: [],
    billingModuleOn: false, canReadRevenue: false, runStats: stats, ...over,
  });
  // No event rows at all: the numbers cannot depend on what a capped list holds.
  const model = buildAgentAnalytics(input());
  const totalUsd = sql.reduce((n: number, r: Loose) => n + r.usd, 0);
  const totalTokens = sql.reduce((n: number, r: Loose) => n + r.tin + r.tout, 0);
  const t = model.totals.sums;
  console.log(`  analytics: model cost ${t.costUsd.toFixed(2)} / SQL ${totalUsd.toFixed(2)}; model tokens ${t.tokensIn + t.tokensOut} / SQL ${totalTokens}`);
  check('analytics: totals equal pm.agent_spend (cost and tokens), with no event rows read', close(t.costUsd, totalUsd) && t.tokensIn + t.tokensOut === totalTokens
    && t.tokensCached === sql.reduce((n: number, r: Loose) => n + r.cached, 0), { model: [t.costUsd, t.tokensIn + t.tokensOut, t.tokensCached], sql: [totalUsd, totalTokens] });
  check('analytics: the agent with 12,000 records reads exactly $120', close(model.facts.filter((x) => x.agentId === fleet && x.kind === 'costUsd').reduce((n, x) => n + x.value, 0), 120));

  const labels: BreakdownLabels = { agentName: (id) => id, projectName: (id) => id, roleOf: () => null };
  const agentRows = breakdown(model.facts, 'agent', labels);
  const agentBad = agents.filter((id) => {
    const row = agentRows.find((r) => r.key === id);
    const s = byAgent.get(id);
    return !close(row?.group.sums.costUsd ?? 0, s?.usd ?? 0) || (row ? row.group.sums.tokensIn + row.group.sums.tokensOut : 0) !== (s ? s.tin + s.tout : 0);
  });
  check('analytics: every agent row equals pm.agent_spend for that agent', agentBad.length === 0, agentBad);

  const facts = (await q(db)<Loose>(`SELECT coalesce(project_id::text, '') AS project, coalesce(model, '') AS model, sum(coalesce(cost_usd, 0))::float8 AS usd, sum(tokens_in + tokens_out)::float8 AS tokens
    FROM pm.agent_spend_facts($1, $2) GROUP BY GROUPING SETS ((project_id), (model))`, [window.from, new Date(Date.parse(`${window.endKey}T00:00:00Z`) + 86_400_000).toISOString()]));
  const projectRows = breakdown(model.facts, 'project', labels);
  const siteSql = facts.find((r: Loose) => r.project === project);
  const siteRow = projectRows.find((r) => r.key === project);
  check('analytics: the project row equals the facts on that project ($60, half the records)', !!siteSql && close(siteSql.usd, 60) && close(siteRow?.group.sums.costUsd ?? -1, siteSql.usd)
    && siteRow!.group.sums.tokensIn + siteRow!.group.sums.tokensOut === siteSql.tokens, { siteSql, row: siteRow?.group.sums });
  const gptSql = facts.find((r: Loose) => r.model === 'gpt-5');
  const modelRows = breakdown(model.facts, 'model', labels);
  const gptRow = modelRows.find((r) => r.key.includes('gpt-5'));
  check('analytics: the model row equals the facts for that model ($40, a third of the records)', !!gptSql && close(gptSql.usd, 40) && close(gptRow?.group.sums.costUsd ?? -1, gptSql.usd)
    && gptRow!.group.sums.tokensIn + gptRow!.group.sums.tokensOut === gptSql.tokens, { gptSql, row: gptRow?.group.sums, keys: modelRows.map((r) => r.key) });

  // Can fail: without the server's spend, the same screen reads nothing.
  const without = buildAgentAnalytics(input({ runStats: { ...stats, spend: undefined } }));
  check('analytics: without spend and without rows the totals are short (the check above can fail)', without.totals.sums.costUsd < totalUsd, without.totals.sums.costUsd);
}

// ── The budget over the real routes ──────────────────────────────────────

async function budgetRouteChecks() {
  const db = await createFullSchemaDatabase();
  const run = q(db);
  await run('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await run('UPDATE pm.workspace_modules SET enabled = true');
  const owner = (await run<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Olivia', 'olivia@example.com', 'owner') RETURNING id"))[0].id;
  const bolt = await addAgent(db, 'Bolt');
  const other = await addAgent(db, 'Other');
  await run('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [bolt, owner]);
  const key = async (memberId: string) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await run(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, ['tasks.read', 'projects.read', 'agent_activity.write']]);
    return secret;
  };
  const boltKey = await key(bolt);
  const otherKey = await key(other);
  await run("INSERT INTO pm.agent_limits (agent_id, budget_usd, budget_period) VALUES ($1, 100, 'month')", [bolt]);

  const server = await startFakePostgrest(db, { handle: async (_req: IncomingMessage, _res: ServerResponse) => false });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  try {
    const v1Runs = await import('../src/app/api/v1/agents/runs/route');
    const v1Finish = await import('../src/app/api/v1/agents/runs/[id]/finish/route');
    const v1Activities = await import('../src/app/api/v1/agent-activities/route');
    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, path: string, params: Record<string, string>, apiKey: string, body: unknown) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), { params: Promise.resolve(params) } as never);
      const text = await response.text();
      let parsed: Loose = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      return { status: response.status, body: parsed };
    };
    const startRun = (apiKey: string, body: Loose) => call(v1Runs.POST, '/api/v1/agents/runs', {}, apiKey, body);
    const finishRun = (apiKey: string, id: string, body: Loose = {}) => call(v1Finish.POST, `/api/v1/agents/runs/${id}/finish`, { id }, apiKey, body);
    const usage = (apiKey: string, cost: number, extra: Loose = {}) => call(v1Activities.POST, '/api/v1/agent-activities', {}, apiKey, {
      activity_type: 'usage.recorded',
      payload: { source_usage_id: `u-${randomUUID()}`, model: 'claude-opus', input_tokens: 1000, output_tokens: 0, cost_usd: cost, recorded_at: new Date().toISOString(), ...extra },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    const stored = async (runId: string | null) => (await run<Loose>("SELECT metadata FROM pm.agent_activities WHERE agent_id = $1 AND activity_type = 'usage.recorded' ORDER BY created_at DESC LIMIT 1", [bolt]))[0]?.metadata?.run_id ?? runId;

    const first = await startRun(boltKey, { title: 'Reported run', cost_usd: 60 });
    check('budget route: under the cap, the run starts', first.status === 201, first.body);
    const firstId = first.body?.data?.id as string;
    await finishRun(boltKey, firstId, { cost_usd: 60 });
    const attached = await usage(boltKey, 40, { run_id: firstId });
    await settle();
    const attachedRunId = await stored(null);
    check('budget route: usage naming the agent\'s own run keeps run_id', attached.status === 201 && attachedRunId === firstId, [attached.status, attachedRunId]);
    const second = await startRun(boltKey, { title: 'Still under' });
    check('budget route: $60 of run plus $40 of usage under that run is $60, so runs still start (not $100)', second.status === 201, second.body);
    await finishRun(boltKey, second.body?.data?.id);

    const otherRun = await startRun(otherKey, { title: 'Not Bolt\'s' });
    const unattached = await usage(boltKey, 50, { run_id: otherRun.body?.data?.id });
    await settle();
    const droppedRunId = (await run<Loose>("SELECT metadata FROM pm.agent_activities WHERE agent_id = $1 AND activity_type = 'usage.recorded' ORDER BY created_at DESC LIMIT 1", [bolt]))[0]?.metadata;
    check('budget route: usage naming another agent\'s run is kept with no run_id (it adds on its own)', unattached.status === 201 && droppedRunId && !('run_id' in droppedRunId), droppedRunId);

    const refused = await startRun(boltKey, { title: 'Over budget' });
    const details = refused.body?.error?.details;
    console.log(`  budget route: run $60 + unattached usage $50, cap $100 -> ${refused.status} ${details?.reason ?? ''}, spent_usd ${details?.spent_usd}`);
    check('budget route: $60 of run plus $50 of usage with no run is $110: a new run is refused (402 budget_exceeded)', refused.status === 402 && details?.reason === 'budget_exceeded'
      && details?.spent_usd === 110, refused.body);
    const old = (await run<Loose>(`SELECT greatest(
        (SELECT coalesce(sum((metadata->>'cost_usd')::numeric), 0) FROM pm.agent_activities WHERE agent_id = $1 AND activity_type = 'usage.recorded'),
        (SELECT coalesce(sum(cost_usd), 0) FROM pm.agent_runs WHERE agent_id = $1))::float8 AS usd`, [bolt]))[0].usd;
    check('budget route: the 2.0.40 rule on the same rows reads $90, under the cap (the check can fail)', old === 90, old);
  } finally {
    await server.close();
    await db.close();
  }
}

async function main() {
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const fixture = await seedRule(db);
  await ruleChecks(db, fixture);
  await analyticsChecks(db, fixture);
  await principalChecks(db);
  await db.close();

  await budgetRouteChecks();

  if (failures.length) {
    console.error(`agent spend: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`agent spend: ${passed} checks passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
