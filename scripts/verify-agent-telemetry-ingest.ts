/**
 * Host telemetry through POST /api/v1/agent-activities (docs/12-telemetry.md
 * in the agents repo), end to end: real withApi requests with real keys,
 * against a pglite database that starts in the pre-telemetry shape and has
 * the telemetry migration applied twice (it must re-run).
 *
 * Covers: every new type is accepted with the agent's own key and composed a
 * title; turn.completed with and without the new label fields; unknown fields
 * are tolerated; every type is idempotent on resend; turn.outcome merges onto
 * its turn (no runtime of its own, live labels win, resends write nothing)
 * and waits as its own row when the turn has not arrived; source_ref keeps
 * identical messages apart; the dispatcher key posts fleet host alerts with
 * no agent and nothing else; the database refuses an agentless row of any
 * other kind; and telemetry stays out of the narrative feed.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-agent-telemetry-ingest.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 600)}`);
}

const MIGRATION = new URL('../supabase/migrations/20261010210652_agent_telemetry.sql', import.meta.url);
const JEFF = randomUUID();
const JOHN = randomUUID();
const OWNER = randomUUID();
const TASK = randomUUID();
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

async function seed(db: PGlite) {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO service_role;
    CREATE TABLE public.team_members (id uuid PRIMARY KEY, name text NOT NULL, role text NOT NULL, status text NOT NULL DEFAULT 'active');
    CREATE TABLE public.projects (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT 'key', key_hash text NOT NULL,
      permissions text NOT NULL DEFAULT 'scoped', team_member_id uuid, scopes text[] NOT NULL DEFAULT '{}',
      expires_at timestamptz, disabled_at timestamptz, revoked_at timestamptz, last_used_at timestamptz);
    CREATE TABLE public.business_settings (id serial PRIMARY KEY, api_enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE public.role_permissions (role text, permission_key text, access_channel text, PRIMARY KEY (role, permission_key, access_channel));
    CREATE TABLE public.team_member_permissions (member_id uuid, permission_key text, access_channel text, effect text);
    CREATE TABLE public.project_members (member_id uuid, project_id uuid);
    CREATE TABLE public.api_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), method text, endpoint text, entity_type text,
      entity_id uuid, api_key_id uuid, team_member_id uuid, request_body jsonb, before_snapshot jsonb, after_snapshot jsonb,
      status_code integer, error text, via text NOT NULL DEFAULT 'rest');
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'reset_at', now() + make_interval(secs => p_window_seconds)) $$;

    -- agent_activities as production has it before the telemetry migration.
    CREATE TABLE public.agent_activities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
      project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
      activity_type text NOT NULL,
      title text NOT NULL,
      description text NOT NULL DEFAULT '',
      reference_type text,
      reference_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT agent_activities_activity_type_check CHECK (activity_type IN (
        'custom', 'work.claimed', 'work.milestone', 'work.handoff', 'work.done', 'pr.merged', 'usage.recorded',
        'turn.completed', 'review.started', 'review.verdict', 'audit.finding', 'audit.no_work', 'spec.completed',
        'queue.empty', 'blocked', 'billing.started', 'billing.paused', 'billing.resumed', 'billing.stopped', 'email.triaged'))
    );
    CREATE UNIQUE INDEX idx_agent_activities_turn_identity ON public.agent_activities(agent_id, (metadata->>'source_turn_id'))
      WHERE activity_type = 'turn.completed' AND metadata->>'source_turn_id' IS NOT NULL;
    CREATE UNIQUE INDEX idx_agent_activities_usage_identity ON public.agent_activities(agent_id, (metadata->>'source_usage_id'))
      WHERE activity_type = 'usage.recorded' AND metadata->>'source_usage_id' IS NOT NULL;
    INSERT INTO public.business_settings DEFAULT VALUES;
  `);
  const migration = await readFile(MIGRATION, 'utf8');
  await db.exec(migration);
  await db.exec(migration); // safe to re-run
  await db.exec(`
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
  `);
  await db.query(`INSERT INTO team_members(id, name, role) VALUES ($1, 'Jeff', 'agent'), ($2, 'John', 'agent'), ($3, 'Ciaran', 'owner')`, [JEFF, JOHN, OWNER]);
  for (const key of ['tasks.read', 'projects.read', 'agent_activity.write'])
    await db.query("INSERT INTO role_permissions VALUES ('agent', $1, 'api') ON CONFLICT DO NOTHING", [key]);
}

async function insertKey(db: PGlite, member: string, scopes: string[], permissions = 'scoped') {
  const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
  await db.query('INSERT INTO api_keys(key_hash, team_member_id, scopes, permissions) VALUES ($1, $2, $3, $4)', [hash(secret), member, scopes, permissions]);
  return secret;
}

async function main() {
  const db = new PGlite();
  await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url,
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key',
    NEXT_PUBLIC_ENABLE_AGENTS: 'true',
  });

  // Rows are read loosely on purpose: each check names the fields it asserts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
  const count = async (type: string) => (await rows('SELECT count(*)::int AS n FROM agent_activities WHERE activity_type = $1', [type]))[0].n as number;

  try {
    const route = await import('../src/app/api/v1/agent-activities/route');
    const { fetchAgentActivity } = await import('../src/lib/supabase/queries');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');

    const jeffKey = await insertKey(db, JEFF, ['tasks.read', 'projects.read', 'agent_activity.write']);
    // The dispatcher's key: linked to John, read scopes plus the fleet scope.
    const dispatcherKey = await insertKey(db, JOHN, ['tasks.read', 'projects.read', 'fleet_alerts.write']);
    const readOnlyDispatcher = await insertKey(db, JOHN, ['tasks.read', 'projects.read']);

    const post = async (key: string, activity_type: string, payload: Record<string, unknown>, project_id: string | null = null, extra: Record<string, unknown> = {}) => {
      const response = await route.POST(new NextRequest('http://localhost/api/v1/agent-activities', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ activity_type, project_id, payload, ...extra }),
      }));
      const json = await response.json().catch(() => null);
      return { status: response.status, body: json, data: json?.data };
    };

    // -- every new type, with the agent's own key ----------------------------
    const t0 = '2026-10-09T10:00:00.000000+00:00';
    const t1 = '2026-10-09T10:04:00.123456+00:00';
    const samples: [string, Record<string, unknown>][] = [
      ['turn.failed', { source_turn_id: 'cron:f1', failure: 'dead', started_at: t0, finished_at: t1, duration_ms: 240000, error: 'x'.repeat(900), job_name: 'Work', trigger: 'schedule' }],
      ['agent.restarted', { kind: 'container', started_at: t0, deploy_commit: 'abc1234', source_ref: 'restart:container:jeff:t0' }],
      ['attention.message', { kind: 'blocking_question', at: t1, solicited: false, session_id: 's1', task_id: TASK, source_ref: 'attention:jeff:blocking_question:s1:c1' }],
      ['dispatch.wake', { kind: 'state_change', at: t1, waited_seconds: 42, source_ref: 'wake:jeff:t1:state_change' }],
      ['billing.gap', { start: t0, end: t1, minutes: 4.0, phase: 'mid_turn', origin: 'scheduled', source_turn_id: 'cron:w1', task_id: TASK }],
      ['eval.result', { suite: 'alex', score: 18, total: 20, passed: 18, failed: 2, errors: 0, skipped: 0, failed_cases: ['c3', null], cases_selected: 20, cases_in_suite: 20, complete: true, model: 'gpt-5.5-codex', started_at: '20261010T190000Z', finished_at: t1, duration_seconds: 300 }],
    ];
    for (const [type, payload] of samples) {
      const first = await post(jeffKey, type, payload);
      check(`${type} accepted`, first.status === 201 && first.data?.agent_id === JEFF, first);
      check(`${type} gets a server title`, typeof first.data?.title === 'string' && first.data.title.length > 0, first.data?.title);
      check(`${type} gets a source_key`, typeof first.data?.source_key === 'string', first.data);
      const again = await post(jeffKey, type, payload);
      check(`${type} resend returns the same row`, again.status === 201 && again.data?.id === first.data?.id, again);
      check(`${type} stored once`, (await count(type)) === 1);
    }
    const failed = (await rows("SELECT metadata FROM agent_activities WHERE activity_type = 'turn.failed'"))[0].metadata;
    check('turn.failed error is cut to 300 characters', failed.error.length === 300, failed.error.length);
    check('turn.failed has_completed_turn defaults to false', failed.has_completed_turn === false, failed);
    const attention = (await rows("SELECT reference_id, metadata FROM agent_activities WHERE activity_type = 'attention.message'"))[0];
    check('attention task_id becomes the task reference', attention.reference_id === TASK, attention);

    // A host record whose task_id is not a uuid is kept, not refused (one bad
    // row would stall the agent's whole publisher), and makes no reference.
    const loose = await post(jeffKey, 'attention.message', { kind: 'pm_notify', at: t0, solicited: false, task_id: 'not-a-uuid', source_ref: 'attention:jeff:pm_notify:s1:c9' });
    check('attention with a non-uuid task_id accepted', loose.status === 201 && loose.data?.reference_id === null, loose);

    // A narration names its task beside the payload (Ashley's plugin does);
    // without a task_id inside, that reference stands. An unknown kind is
    // ignored, never a refused event.
    const narrated = await post(jeffKey, 'work.milestone', { kind: 'note', detail: 'attached a file to the task' }, null,
      { reference_type: 'task', reference_id: TASK });
    check('a typed event keeps the task it names beside its payload',
      narrated.status === 201 && narrated.data?.reference_type === 'task' && narrated.data?.reference_id === TASK, narrated);
    const odd = await post(jeffKey, 'work.milestone', { kind: 'note', detail: 'filed the email' }, null,
      { reference_type: 'email', reference_id: TASK });
    check('an unknown reference kind is dropped, the event kept',
      odd.status === 201 && odd.data?.reference_id === null, odd);

    // -- source_ref keeps identical messages apart ---------------------------
    const twin = { kind: 'pm_notify', at: t1, solicited: false, session_id: 's2', task_id: TASK };
    const a = await post(jeffKey, 'attention.message', { ...twin, source_ref: 'attention:jeff:pm_notify:s2:call_a' });
    const b = await post(jeffKey, 'attention.message', { ...twin, source_ref: 'attention:jeff:pm_notify:s2:call_b' });
    check('two pm_notify calls with distinct source_ref are two rows', a.status === 201 && b.status === 201 && a.data?.id !== b.data?.id, [a, b]);
    const c = await post(jeffKey, 'attention.message', { ...twin, session_id: 's3' });
    const d = await post(jeffKey, 'attention.message', { ...twin, session_id: 's3' });
    check('without source_ref an identical payload is one row', c.data?.id === d.data?.id, [c, d]);

    // -- turn.completed: new fields, old shape, unknown fields ---------------
    const labelled = await post(jeffKey, 'turn.completed', {
      source_turn_id: 'cron:w1', origin: 'scheduled', duration_ms: 240000, started_at: t0, finished_at: t1,
      outcome: 'work', final_marker: 'PICKUP_IDLE', job_name: 'Work', trigger: 'direct', session_id: 'cron_w1',
      model: 'gpt-5.5-codex', tokens: { input: 23000, output: 900, cache_read: 41000, cache_write: 0, reasoning: 300 },
      tokens_scope: 'turn', some_future_field: 'ignored',
    });
    check('turn.completed with labels accepted', labelled.status === 201 && labelled.data?.metadata?.outcome === 'work'
      && labelled.data?.metadata?.tokens?.cache_read === 41000 && labelled.data?.metadata?.trigger === 'direct', labelled);
    check('unknown fields are tolerated and not stored', labelled.data?.metadata?.some_future_field === undefined, labelled.data?.metadata);
    const old = await post(jeffKey, 'turn.completed', { source_turn_id: 'cron:old1', origin: 'scheduled', duration_ms: 60000, started_at: t0, finished_at: t1 });
    check('turn.completed without labels still accepted', old.status === 201 && old.data?.metadata?.outcome === undefined, old);
    const badOutcome = await post(jeffKey, 'turn.completed', { source_turn_id: 'cron:bad', origin: 'scheduled', duration_ms: 1, started_at: t0, finished_at: t1, outcome: 'busy' });
    check('an outcome outside the contract is refused', badOutcome.status >= 400 && badOutcome.status < 500, badOutcome);

    // -- turn.outcome merges onto its turn -----------------------------------
    const label = { source_turn_id: 'cron:old1', outcome: 'idle', final_marker: 'PICKUP_IDLE', job_name: 'Work', trigger: 'schedule', session_id: 'cron_old1', model: 'gpt-5.5-codex', tokens: { input: 23000, cache_read: 41000 }, tokens_scope: 'turn' };
    const merged = await post(jeffKey, 'turn.outcome', label);
    check('turn.outcome answers with the merged turn', merged.status === 201 && merged.data?.id === old.data?.id && merged.data?.activity_type === 'turn.completed', merged);
    const oldRow = (await rows('SELECT metadata FROM agent_activities WHERE id = $1', [old.data.id]))[0].metadata;
    check('the turn now carries the outcome', oldRow.outcome === 'idle' && oldRow.final_marker === 'PICKUP_IDLE' && oldRow.tokens_scope === 'turn', oldRow);
    check('a backfilled label is marked as such', oldRow.outcome_source === 'backfill', oldRow);
    check('the merge adds no runtime', oldRow.duration_ms === 60000 && oldRow.started_at === t0, oldRow);
    check('a merged turn.outcome stores no row of its own', (await count('turn.outcome')) === 0);
    // Audit writes run after the response, so let them land before counting.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    const merges = async () => (await rows('SELECT count(*)::int AS n FROM api_audit_log WHERE entity_id = $1 AND before_snapshot IS NOT NULL', [old.data.id]))[0].n as number;
    await settle();
    check('the merge is audited with its before and after', (await merges()) === 1);
    const remerge = await post(jeffKey, 'turn.outcome', label);
    check('turn.outcome resend is a no-op', remerge.status === 201 && remerge.data?.id === old.data?.id, remerge);
    await settle();
    check('turn.outcome resend writes no audit row', (await merges()) === 1);
    check('still one turn for that id', (await rows("SELECT count(*)::int AS n FROM agent_activities WHERE metadata->>'source_turn_id' = 'cron:old1'"))[0].n === 1);

    const overwrite = await post(jeffKey, 'turn.outcome', { source_turn_id: 'cron:w1', outcome: 'idle' });
    const liveRow = (await rows('SELECT metadata FROM agent_activities WHERE id = $1', [labelled.data.id]))[0].metadata;
    check('a live label is never overwritten by a backfill', overwrite.status === 201 && liveRow.outcome === 'work' && liveRow.outcome_source === undefined, liveRow);

    // The label can arrive first (the turn row was lost and is re-sent later).
    const early = await post(jeffKey, 'turn.outcome', { source_turn_id: 'cron:late1', outcome: 'waiting', final_marker: 'HEARTBEAT_OK' });
    check('a label for a missing turn is kept as its own row', early.status === 201 && early.data?.activity_type === 'turn.outcome', early);
    const earlyAgain = await post(jeffKey, 'turn.outcome', { source_turn_id: 'cron:late1', outcome: 'waiting', final_marker: 'HEARTBEAT_OK' });
    check('that label is stored once', earlyAgain.data?.id === early.data?.id && (await count('turn.outcome')) === 1, earlyAgain);
    const late = await post(jeffKey, 'turn.completed', { source_turn_id: 'cron:late1', origin: 'scheduled', duration_ms: 30000, started_at: t0, finished_at: t1 });
    check('the late turn absorbs its waiting label', late.status === 201 && late.data?.metadata?.outcome === 'waiting'
      && late.data?.metadata?.outcome_source === 'backfill' && late.data?.metadata?.duration_ms === 30000, late);

    // Labels are per agent: John's turn with the same id is untouched.
    await post(jeffKey, 'turn.completed', { source_turn_id: 'cron:shared', origin: 'scheduled', duration_ms: 1000, started_at: t0, finished_at: t1 });
    const johnKey = await insertKey(db, JOHN, ['agent_activity.write']);
    await post(johnKey, 'turn.completed', { source_turn_id: 'cron:shared', origin: 'scheduled', duration_ms: 2000, started_at: t0, finished_at: t1 });
    await post(jeffKey, 'turn.outcome', { source_turn_id: 'cron:shared', outcome: 'work' });
    const shared = await rows("SELECT agent_id, metadata->>'outcome' AS outcome FROM agent_activities WHERE metadata->>'source_turn_id' = 'cron:shared' AND activity_type = 'turn.completed' ORDER BY agent_id = $1 DESC", [JEFF]);
    check('a label merges only onto the posting agent\'s turn', shared[0]?.outcome === 'work' && shared[1]?.outcome === null, shared);

    // -- the dispatcher key: fleet host alerts only, attributed to no agent ---
    const alert = { kind: 'host_alert', at: t1, solicited: false, script: 'watchdog', alert_key: 'api-down', source_ref: 'attention:host:t1:watchdog:api-down' };
    const fleet = await post(dispatcherKey, 'attention.message', alert);
    check('dispatcher key posts a fleet host alert', fleet.status === 201, fleet);
    check('the fleet alert carries no agent', fleet.data?.agent_id === null, fleet.data);
    const fleetAgain = await post(dispatcherKey, 'attention.message', alert);
    check('fleet alert resend returns the same row', fleetAgain.data?.id === fleet.data?.id, fleetAgain);
    check('fleet alert stored once', (await rows("SELECT count(*)::int AS n FROM agent_activities WHERE agent_id IS NULL"))[0].n === 1);
    const jeffAlert = await post(jeffKey, 'attention.message', { ...alert, alert_key: 'blocked-jeff' });
    check('an agent-named host alert keeps its agent', jeffAlert.status === 201 && jeffAlert.data?.agent_id === JEFF, jeffAlert);
    const sameRefOtherOwner = await post(jeffKey, 'attention.message', alert);
    check('fleet and agent identities are separate spaces', sameRefOtherOwner.status === 201 && sameRefOtherOwner.data?.id !== fleet.data?.id && sameRefOtherOwner.data?.agent_id === JEFF, sameRefOtherOwner);
    const fleetTurn = await post(dispatcherKey, 'turn.completed', { source_turn_id: 'cron:x', origin: 'scheduled', duration_ms: 1, started_at: t0, finished_at: t1 });
    check('dispatcher key may not post anything else', fleetTurn.status === 403 && fleetTurn.body?.error?.details?.reason === 'fleet_key_scope', fleetTurn);
    const fleetNotify = await post(dispatcherKey, 'attention.message', { kind: 'pm_notify', at: t1, solicited: false, source_ref: 'r1' });
    check('dispatcher key may not post a non-host attention message', fleetNotify.status === 403, fleetNotify);
    const unscoped = await post(readOnlyDispatcher, 'attention.message', { ...alert, source_ref: 'r2' });
    check('a dispatcher key without the fleet scope is refused', unscoped.status === 403, unscoped);

    // The database itself refuses an agentless row of any other kind.
    let refused = false;
    try {
      await db.query("INSERT INTO agent_activities(agent_id, activity_type, title, metadata) VALUES (NULL, 'attention.message', 't', '{\"kind\":\"pm_notify\"}')");
    } catch (error) {
      refused = (error as { code?: string }).code === '23514';
    }
    check('the database refuses an agentless non-fleet row', refused);

    // -- what python publishers really send ---------------------------------
    // None becomes null in JSON: a gap with no task, a fire with no start.
    const nullGap = await post(jeffKey, 'billing.gap', { start: t0, end: t1, minutes: 3, phase: 'unbilled_turn', origin: 'scheduled', source_turn_id: 'cron:ng', task_id: null });
    check('a gap with a null task_id is accepted', nullGap.status === 201 && nullGap.data?.metadata?.task_id === undefined, nullGap);
    const nullFail = await post(jeffKey, 'turn.failed', { source_turn_id: 'cron:nf', failure: 'unknown', has_completed_turn: false, started_at: null, finished_at: null, duration_ms: null, error: null, job_name: 'Work', trigger: 'schedule' });
    check('a failure with null times is accepted', nullFail.status === 201 && nullFail.data?.metadata?.started_at === undefined, nullFail);
    const nullTokens = await post(jeffKey, 'turn.completed', { source_turn_id: 'cron:nt', origin: 'scheduled', duration_ms: 1000, started_at: t0, finished_at: t1, outcome: 'idle', model: null, tokens: { input: 5, output: null } });
    check('nulls inside tokens are dropped, not refused', nullTokens.status === 201 && nullTokens.data?.metadata?.tokens?.input === 5 && !('output' in (nullTokens.data?.metadata?.tokens ?? {})), nullTokens);
    const longMarker = await post(jeffKey, 'turn.completed', { source_turn_id: 'cron:lm', origin: 'scheduled', duration_ms: 1000, started_at: t0, finished_at: t1, outcome: 'idle', final_marker: 'X'.repeat(150), job_name: 'J'.repeat(400) });
    check('over-long labels are trimmed, not refused', longMarker.status === 201 && longMarker.data?.metadata?.final_marker?.length === 60 && longMarker.data?.metadata?.job_name?.length === 200, longMarker);

    // A live `unknown` (session unreadable) gives way to a later real reading.
    await post(jeffKey, 'turn.completed', { source_turn_id: 'cron:unk', origin: 'scheduled', duration_ms: 1000, started_at: t0, finished_at: t1, outcome: 'unknown' });
    const relabel = await post(jeffKey, 'turn.outcome', { source_turn_id: 'cron:unk', outcome: 'work', final_marker: 'SWEEP_CLEAN' });
    check('a backfill replaces a live unknown', relabel.data?.metadata?.outcome === 'work' && relabel.data?.metadata?.outcome_source === 'backfill', relabel.data?.metadata);

    // An agent's own key that also carries the fleet scope stays an agent key.
    const mixedKey = await insertKey(db, JEFF, ['agent_activity.write', 'fleet_alerts.write']);
    const mixed = await post(mixedKey, 'turn.completed', { source_turn_id: 'cron:mx', origin: 'scheduled', duration_ms: 1000, started_at: t0, finished_at: t1, outcome: 'idle' });
    check('a stray fleet scope on an agent key changes nothing', mixed.status === 201 && mixed.data?.agent_id === JEFF, mixed);

    // -- the plain GET feed leaves host records out unless asked -------------
    const list = async (query: string) => {
      const response = await route.GET(new NextRequest(`http://localhost/api/v1/agent-activities?${query}`, { headers: { 'x-api-key': ownerKey } }));
      return ((await response.json()).data ?? []) as { activity_type: string }[];
    };
    const ownerKey = await insertKey(db, OWNER, ['audit.read']);
    const plain = await list(`agent_id=${JEFF}&limit=100`);
    check('the plain feed has no host records', plain.length > 0 && plain.every((row) => !['turn.failed', 'agent.restarted', 'attention.message', 'dispatch.wake', 'billing.gap', 'eval.result', 'turn.outcome'].includes(row.activity_type)), plain.map((row) => row.activity_type));
    check('the plain feed still has turns (the dispatcher counts directed ones)', plain.some((row) => row.activity_type === 'turn.completed'));
    const asked = await list(`agent_id=${JEFF}&activity_type=billing.gap&limit=100`);
    check('host records come back when asked for by type', asked.length >= 1 && asked.every((row) => row.activity_type === 'billing.gap'), asked);

    // -- telemetry never reaches the narrative feed -------------------------
    await post(jeffKey, 'work.claimed', { task_id: TASK, task_title: 'Real work' });
    const feed = await fetchAgentActivity(getServiceClient());
    check('the narrative feed shows real events', feed.some((row) => row.activity_type === 'work.claimed'), feed.map((row) => row.activity_type));
    // Only the narrative events this test posts (claims and milestones).
    check('the narrative feed shows no telemetry', feed.every((row) => ['work.claimed', 'work.milestone'].includes(row.activity_type)), feed.map((row) => row.activity_type));

    // Older types keep their metadata identity (no source_key needed).
    const usage = { source_usage_id: 'u1', model: 'm', input_tokens: 10, output_tokens: 2, cost_usd: 0.01 };
    const u1 = await post(jeffKey, 'usage.recorded', usage);
    const u2 = await post(jeffKey, 'usage.recorded', usage);
    check('usage.recorded stays idempotent with no source_key', u1.data?.id === u2.data?.id && u1.data?.source_key === null, [u1, u2]);
  } finally {
    await server.close();
  }

  console.log(`${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
