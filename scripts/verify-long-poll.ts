/**
 * Long-poll and the event feed (20261127001100_event_feed.sql,
 * lib/api/long-poll.ts, GET /api/v1/events, GET /api/v1/chat/messages?wait=,
 * MCP get_events and list_chat_messages wait), through the real v1 routes
 * (withApi, supabase-js, a fake PostgREST over PGlite) with short waits and a
 * 50 ms probe so it runs in seconds:
 * - The migration: schema.sql mirrors it word for word, it runs twice on the
 *   schema before it and matches a fresh install, and rows the previous
 *   release's code writes still go in.
 * - Cost and limits: the cap stays below every waiting route's maxDuration;
 *   a wait longer than the cap is cut to it; open waits share one probe.
 * - A wait answers as soon as a matching event is written during it, and
 *   empty (with next_cursor) at its end.
 * - The cursor: pages resume with nothing missed and nothing repeated; a
 *   replay from an older cursor gives the same ids (at least once); a row
 *   in a transaction still open waits until it commits.
 * - Retention: a cursor older than what was pruned is 410 RESYNC_REQUIRED
 *   with the cursor to continue from, never a silent gap.
 * - At most 2 open waits per key: a third is 429 with Retry-After, and the
 *   slot comes back when a wait ends.
 * - A wait ends early and empty when the caller aborts, and on shutdown.
 * - Permissions: chat, questions and runs only the caller's own; agent
 *   events only on projects it reads; a type it may not read is 403.
 * - Chat wait, handled twice, and REST and MCP agree.
 *
 *   npm run -s test:long-poll
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { FEED_HOST_PERMISSION, FEED_PERMISSIONS, FEED_TYPE_PERMISSIONS, LONG_POLL } from '../src/lib/event-feed-contract';

const MIGRATION = '20261127001100_event_feed.sql';
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = `\n-- ============================================================\n-- EVENT FEED (${MIGRATION})\n-- ============================================================\n`;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; headers: Headers; ms: number };

const AGENT_SCOPES = ['tasks.read', 'agent_activity.write', 'projects.read', 'audit.read', 'notifications.manage_own'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n-- ', at + BANNER.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && SCHEMA_SQL.slice(at + BANNER.length, next < 0 ? undefined : next) === MIGRATION_SQL);
  check('migration: no em or en dash', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)));
  const later = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f > MIGRATION);
  check('migration: every later migration has its own section after this one', later.every((f) => SCHEMA_SQL.indexOf(`(${f})`, at + BANNER.length) > 0), later);

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await old.exec('RESET ROLE');
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const agent = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old agent', 'old-agent@example.com', 'agent') RETURNING id"))[0].id;
  const owner = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old owner', 'old-owner@example.com', 'owner') RETURNING id"))[0].id;
  await q('INSERT INTO pm.agent_runs (agent_id, title) VALUES ($1, $2)', [agent, 'Before']);
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql (fresh equals upgraded)', diff.length === 0, diff.slice(0, 10));
  check('upgrade: nothing is backfilled (the feed starts empty)', Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM pm.event_feed'))[0].n) === 0);

  // The previous release's writes, unchanged, on the updated database.
  const connection = (await q<{ id: string }>("INSERT INTO pm.chat_connections (provider, external_workspace_id, display_name, credentials) VALUES ('slack', 'TOLD', 'Old', 'pm1:x') RETURNING id"))[0].id;
  const wrote = await Promise.all([
    old.query("INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, agent_id, member_id, text) VALUES ($1, 'inbound', 'pending', 'D1', $2, $3, 'hi')", [connection, agent, owner]),
    old.query('INSERT INTO pm.agent_runs (agent_id, title) VALUES ($1, $2)', [agent, 'After']),
    old.query("INSERT INTO pm.agent_activities (agent_id, activity_type, title, metadata) VALUES ($1, 'work.done', 'Finished: x', '{\"task_title\":\"x\"}')", [agent]),
  ].map((p) => p.then(() => 'ok', (e: Error) => e.message)));
  const qid = (await q<{ id: string }>("INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Ship it?') RETURNING id", [agent, owner]))[0].id;
  await q("UPDATE pm.questions SET status = 'answered', answer_text = 'Yes', answered_by = $2, answered_at = now() WHERE id = $1", [qid, owner]);
  const types = (await q<{ event_type: string }>('SELECT event_type FROM pm.event_feed ORDER BY seq')).map((r) => r.event_type);
  check('compatibility: the previous release\'s writes still go in, and feed the events', wrote.every((w) => w === 'ok')
    && JSON.stringify(types) === JSON.stringify(['chat.message', 'run.updated', 'agent_event.created', 'question.answered']), { wrote, types });
  await old.close();
  await fresh.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string) => {
    const user = randomUUID();
    await q("INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, jsonb_build_object('display_name', $3::text))", [user, `${name.toLowerCase()}@example.com`, name]);
    return (await q<{ id: string }>('UPDATE pm.team_members SET role = $2 WHERE auth_user_id = $1 RETURNING id', [user, role]))[0].id;
  };
  const owner = await member('Olivia', 'owner');
  const builder = await member('Builder', 'agent');
  const planner = await member('Planner', 'agent');
  const morgan = await member('Morgan', 'member');
  const apex = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  const zenith = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Zenith') RETURNING id"))[0].id;
  for (const m of [builder, planner, morgan]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [apex, m]);
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [zenith, planner]);
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions) VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`,
      [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  const keys = {
    builder: await key(builder, AGENT_SCOPES),
    builder2: await key(builder, AGENT_SCOPES),
    planner: await key(planner, AGENT_SCOPES),
    owner: await key(owner, ['tasks.read', 'tasks.manage_all', 'projects.read', 'projects.read_all']),
    // An agent key that may only work its runs: no chat, no agent events.
    runner: await key(planner, ['agent_activity.write']),
  };
  const connection = (await q<{ id: string }>("INSERT INTO pm.chat_connections (provider, external_workspace_id, display_name, credentials) VALUES ('slack', 'T1', 'Slack', 'pm1:x') RETURNING id"))[0].id;
  const chat = async (agentId: string, text: string) => (await q<{ id: string }>(
    "INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, agent_id, member_id, text) VALUES ($1, 'inbound', 'pending', 'D1', $2, $3, $4) RETURNING id",
    [connection, agentId, owner, text]))[0].id;
  const activity = async (agentId: string, projectId: string | null, title: string) => (await q<{ id: string }>(
    "INSERT INTO pm.agent_activities (agent_id, project_id, activity_type, title, metadata) VALUES ($1, $2, 'work.done', $3, jsonb_build_object('task_title', $3::text)) RETURNING id",
    [agentId, projectId, `Finished: ${title}`]))[0].id;
  const ask = async (askedBy: string) => (await q<{ id: string }>("INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Ship it?') RETURNING id", [askedBy, owner]))[0].id;
  const answer = async (questionId: string) => q("UPDATE pm.questions SET status = 'answered', answer_text = 'Yes', answered_by = $2, answered_at = now() WHERE id = $1", [questionId, owner]);
  return { q, owner, builder, planner, morgan, apex, zenith, keys, connection, chat, activity, ask, answer };
}

/** The app caches its service client on the first URL it sees: one address forwards to the current database. */
let proxyTarget = '';
async function startProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  const proxy = createServer((req, res) => {
    const target = new URL(proxyTarget);
    const forward = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    forward.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(forward);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, close: () => new Promise((resolve) => proxy.close(() => resolve())) };
}

async function main() {
  const proxy = await startProxy();
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: proxy.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  await migrationChecks();

  // Short and fast: a 50 ms shared probe, so waits of a second or two prove the timing.
  LONG_POLL.checkIntervalMs = 50;
  LONG_POLL.fallbackIntervalMs = 100;

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  proxyTarget = server.url;
  try {
    const eventsRoute = await import('../src/app/api/v1/events/route');
    const chatRoute = await import('../src/app/api/v1/chat/messages/route');
    const handledRoute = await import('../src/app/api/v1/chat/messages/[id]/handled/route');
    const runsRoute = await import('../src/app/api/v1/agents/runs/route');
    const mcpRoute = await import('../src/app/api/mcp/route');
    const longPoll = await import('../src/lib/api/long-poll');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, apiKey: string,
      options: { body?: unknown; params?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Answer> => {
      const started = Date.now();
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      }), { params: Promise.resolve(options.params ?? {}) } as never);
      return { status: response.status, body: await response.json(), headers: response.headers, ms: Date.now() - started };
    };
    const events = (apiKey: string, query = '', signal?: AbortSignal) => call(eventsRoute.GET, 'GET', `/api/v1/events${query}`, apiKey, { signal });
    const ids = (answer: Answer) => (answer.body?.data ?? []).map((e: Loose) => e.id as string);
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const tool = PM_TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return outcomeResult(await tool.run(tool.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), tool.write).structuredContent as Loose;
    };

    // --- Cost: the cap fits every route that waits ---------------------------------------------
    const durations = [eventsRoute.maxDuration, chatRoute.maxDuration, mcpRoute.maxDuration];
    check('cost: every route that waits declares maxDuration, and the cap plus the lease grace stays inside it',
      durations.every((d) => d === LONG_POLL.routeMaxDurationSeconds) && LONG_POLL.maxWaitSeconds + LONG_POLL.leaseGraceSeconds <= LONG_POLL.routeMaxDurationSeconds
      && LONG_POLL.maxWaitSeconds === 25 && LONG_POLL.maxConcurrentWaitsPerKey === 2, { durations, LONG_POLL });
    // Plus agents.host: a host key reads its agents' feed (20261127002000).
    const union = [...new Set([...Object.values(FEED_TYPE_PERMISSIONS).flat(), FEED_HOST_PERMISSION])].sort();
    check('permissions: the route opens on exactly the permissions of its types, plus the host key permission', JSON.stringify([...FEED_PERMISSIONS].sort()) === JSON.stringify(union), { FEED_PERMISSIONS, union });
    check('cost: a wait longer than the cap is cut to it', longPoll.parseWait(new URLSearchParams('wait=600')) === LONG_POLL.maxWaitSeconds);
    const badWait = await events(s.keys.builder, '?wait=-1');
    check('cost: a negative or fractional wait is 400 invalid_wait', badWait.status === 400 && reason(badWait) === 'invalid_wait', badWait.body);

    // --- From now, and an empty wait at its end ------------------------------------------------
    await s.chat(s.builder, 'before the harness started');
    const start = await events(s.keys.builder);
    check('feed: with no since it starts from now (nothing older), answers at once with next_cursor', start.status === 200 && start.body.data.length === 0
      && /^f1\.\d+\.\d+$/.test(start.body.meta.next_cursor) && start.body.meta.wait.ended === 'no_wait' && start.ms < 1000, start.body);
    check('feed: default types are what the key may read, agent events left out', JSON.stringify(start.body.meta.types) === JSON.stringify(['chat.message', 'question.answered', 'question.cancelled', 'question.expired', 'run.updated']), start.body.meta.types);
    let cursor = start.body.meta.next_cursor as string;

    const idle = await events(s.keys.builder, `?since=${cursor}&wait=1`);
    check('wait: nothing arrives, it answers empty at the end of the wait with a cursor', idle.status === 200 && idle.body.data.length === 0 && idle.ms >= 900 && idle.ms < 2500
      && idle.body.meta.wait.ended === 'timeout' && !!idle.body.meta.next_cursor, { ms: idle.ms, meta: idle.body.meta });
    cursor = idle.body.meta.next_cursor;

    // --- A wait answers as soon as something is written during it ------------------------------
    const pending = events(s.keys.builder, `?since=${cursor}&wait=5`);
    await sleep(300);
    const message = await s.chat(s.builder, 'are you there?');
    const woke = await pending;
    check('wait: a chat message written during the wait answers it at once, not at the end', woke.status === 200 && woke.body.data.length === 1
      && woke.body.data[0].type === 'chat.message' && woke.body.data[0].subject.id === message && woke.ms < 1500 && woke.body.meta.wait.ended === 'event', { ms: woke.ms, body: woke.body });
    const event = woke.body.data?.[0] ?? { data: {} };
    check('feed: an event has a stable id, its own cursor, ids and where to read, reply and mark it handled (no chat text)',
      /^fev_\d+$/.test(event.id) && /^f1\./.test(event.cursor) && event.read?.path === `/api/v1/chat/messages/${message}`
      && event.data.reply?.path === `/api/v1/chat/messages/${message}/reply` && event.data.message?.status === 'pending' && !JSON.stringify(event).includes('are you there'), event);
    // Carry on from the start cursor when the wait missed it, so the checks below still run.
    cursor = woke.body.data?.length ? woke.body.meta.next_cursor : (await events(s.keys.builder, `?since=${cursor}`)).body.meta.next_cursor;

    // --- The cursor: resume with nothing missed, nothing repeated --------------------------------
    const madeRun = await call(runsRoute.POST, 'POST', '/api/v1/agents/runs', s.keys.builder, { body: { title: 'Fix the build' } });
    const runId = madeRun.body?.data?.id as string;
    await s.q("UPDATE pm.agent_runs SET status = 'cancelled', finished_at = now() WHERE id = $1", [runId]);
    const question = await s.ask(s.builder);
    await s.answer(question);
    const second = await s.chat(s.builder, 'one more');
    const expected = 4; // run started, run cancelled, question answered, chat
    const seen: string[] = [];
    let page = cursor;
    for (let i = 0; i < 10; i++) {
      const answer = await events(s.keys.builder, `?since=${page}&limit=2`);
      seen.push(...ids(answer));
      page = answer.body.meta.next_cursor;
      if (!answer.body.meta.has_more) break;
    }
    const types = (await events(s.keys.builder, `?since=${cursor}`)).body.data.map((e: Loose) => e.type);
    check('cursor: pages of 2 resume with every event once', madeRun.status === 201 && seen.length === expected && new Set(seen).size === expected, { seen, run: madeRun.body });
    check('cursor: the events in commit order (run started, run cancelled, question answered, chat)',
      JSON.stringify(types) === JSON.stringify(['run.updated', 'run.updated', 'question.answered', 'chat.message']), types);
    const after = await events(s.keys.builder, `?since=${page}`);
    check('cursor: from the last cursor nothing comes again', after.body.data.length === 0, after.body.data);
    const replay = await events(s.keys.builder, `?since=${cursor}`);
    check('at least once: a replay from an older cursor gives the same events with the same ids', JSON.stringify(ids(replay)) === JSON.stringify(seen), { replay: ids(replay), seen });
    const fromEvent = await events(s.keys.builder, `?since=${replay.body.data?.[1]?.cursor ?? cursor}`);
    check('at least once: an event\'s own cursor resumes just after it', JSON.stringify(ids(fromEvent)) === JSON.stringify(seen.slice(2)), ids(fromEvent));
    const runEvent = replay.body.data.find((e: Loose) => e.type === 'run.updated' && e.data.run.status === 'cancelled');
    check('run.updated: carries status, previous_status, actor_id and where to read the run', runEvent?.data.run.previous_status === 'running'
      && 'actor_id' in runEvent.data && runEvent.read?.path === `/api/v1/agents/runs/${runId}`, runEvent);
    const questionEvent = replay.body.data.find((e: Loose) => e.type === 'question.answered');
    check('question.answered: names the question and where to read the answer', questionEvent?.subject.id === question && questionEvent.read?.path === `/api/v1/questions/${question}`, questionEvent);

    // Duplicates are harmless: marking handled twice is the same answer.
    const handledOnce = await call(handledRoute.POST, 'POST', `/api/v1/chat/messages/${second}/handled`, s.keys.builder, { params: { id: second } });
    const handledTwice = await call(handledRoute.POST, 'POST', `/api/v1/chat/messages/${second}/handled`, s.keys.builder, { params: { id: second } });
    const afterHandled = await events(s.keys.builder, `?since=${page}`);
    check('duplicates: marking handled twice is safe and adds no event', handledOnce.status === 200 && handledTwice.status === 200 && afterHandled.body.data.length === 0,
      [handledOnce.body, handledTwice.body, afterHandled.body.data]);

    // --- Late commits: a row in a transaction still open waits ---------------------------------
    const [, txid, seqAt] = /^f1\.(\d+)\.(\d+)$/.exec(page) as RegExpExecArray;
    const readSql = `SELECT pm.event_feed_read($1, $2, 100, $3, '{chat.message}', false) AS r`;
    await db.exec('BEGIN');
    const open = (await s.q<{ id: string }>("INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, agent_id, text) VALUES ($1, 'inbound', 'pending', 'D9', $2, 'open') RETURNING id", [s.connection, s.builder]))[0].id;
    const during = (await s.q<{ r: Loose }>(readSql, [txid, seqAt, s.builder]))[0].r;
    await db.exec('COMMIT');
    const afterCommit = (await s.q<{ r: Loose }>(readSql, [txid, seqAt, s.builder]))[0].r;
    check('order: a row in a transaction still open is held back (and the cursor does not pass it), then comes once it commits',
      !during.events.some((e: Loose) => e.subject_id === open) && afterCommit.events.some((e: Loose) => e.subject_id === open)
      && BigInt(during.cursor[0]) <= BigInt(afterCommit.events.find((e: Loose) => e.subject_id === open)?.txid ?? -1), { during, afterCommit });
    page = (await events(s.keys.builder, `?since=${page}`)).body.meta.next_cursor;

    // --- Permissions ---------------------------------------------------------------------------
    const plannerStart = (await events(s.keys.planner)).body.meta.next_cursor;
    const builderStart = page;
    await s.chat(s.builder, 'for builder only');
    const plannerQuestion = await s.ask(s.planner);
    await s.answer(plannerQuestion);
    await s.q('INSERT INTO pm.agent_runs (agent_id, title) VALUES ($1, $2)', [s.planner, 'Planner run']);
    const onApex = await s.activity(s.planner, s.apex, 'apex');
    const onZenith = await s.activity(s.planner, s.zenith, 'zenith');
    const plannerView = await events(s.keys.planner, `?since=${plannerStart}`);
    check('permissions: another agent\'s chat never reaches this one; its own question and run do',
      plannerView.body.data.every((e: Loose) => e.type !== 'chat.message')
      && plannerView.body.data.some((e: Loose) => e.type === 'question.answered' && e.subject.id === plannerQuestion)
      && plannerView.body.data.some((e: Loose) => e.type === 'run.updated'), plannerView.body.data.map((e: Loose) => e.type));
    const builderView = await events(s.keys.builder, `?since=${builderStart}`);
    check('permissions: questions and runs of another member never reach this key',
      builderView.body.data.every((e: Loose) => e.type === 'chat.message'), builderView.body.data.map((e: Loose) => e.type));
    const builderAgentEvents = await events(s.keys.builder, `?since=${builderStart}&types=agent_event.created`);
    const subjects = builderAgentEvents.body.data.map((e: Loose) => e.subject.id);
    check('permissions: agent events only on projects the key reads (Apex yes, Zenith no), in the export\'s row shape',
      builderAgentEvents.status === 200 && subjects.includes(onApex) && !subjects.includes(onZenith)
      && builderAgentEvents.body.data.find((e: Loose) => e.subject.id === onApex)?.data.event?.type === 'work.done', builderAgentEvents.body);
    const plannerAgentEvents = await events(s.keys.planner, `?since=${plannerStart}&types=agent_event.created&agent_event_types=work.done`);
    check('permissions: a member of both projects reads both', [onApex, onZenith].every((id) => plannerAgentEvents.body.data.some((e: Loose) => e.subject.id === id)), plannerAgentEvents.body);
    // Agent events wake a wait only for projects it reads: Zenith's never wakes Builder (Apex only).
    const agentCursor = builderAgentEvents.body.meta.next_cursor;
    const wakesBefore = longPoll.probeStats.wakes;
    const quiet = events(s.keys.builder, `?since=${agentCursor}&types=agent_event.created&wait=1`);
    await sleep(200);
    await s.activity(s.planner, s.zenith, 'zenith again');
    const quietDone = await quiet;
    const wakesAfter = longPoll.probeStats.wakes;
    check('db load: an agent event on a project the wait cannot read never wakes it', quietDone.status === 200 && quietDone.body.data.length === 0
      && quietDone.body.meta.wait.ended === 'timeout' && wakesAfter === wakesBefore, { wakes: wakesAfter - wakesBefore, meta: quietDone.body.meta });
    const loud = events(s.keys.builder, `?since=${quietDone.body.meta.next_cursor}&types=agent_event.created&wait=5`);
    await sleep(200);
    const onApexAgain = await s.activity(s.planner, s.apex, 'apex again');
    const loudDone = await loud;
    check('wait: an agent event on a project it reads wakes it at once', loudDone.ms < 1500 && loudDone.body.data.some((e: Loose) => e.subject.id === onApexAgain), { ms: loudDone.ms, data: loudDone.body.data });
    const runner = await events(s.keys.runner, `?since=${plannerStart}`);
    check('permissions: a key that may only work runs gets run.updated by default, nothing else', runner.status === 200
      && JSON.stringify(runner.body.meta.types) === JSON.stringify(['run.updated']) && runner.body.data.every((e: Loose) => e.type === 'run.updated'), runner.body);
    const refused = await events(s.keys.runner, '?types=chat.message,agent_event.created');
    check('permissions: a type the key may not read is 403 type_not_allowed, naming what it needs', refused.status === 403 && reason(refused) === 'type_not_allowed'
      && JSON.stringify(refused.body.error.details.types) === JSON.stringify(['chat.message', 'agent_event.created']), refused.body);
    const noKey = await events(s.keys.owner, '?types=nope');
    check('permissions: an unknown type is 400', noKey.status === 400 && reason(noKey) === 'invalid_types', noKey.body);

    // --- REST and MCP agree --------------------------------------------------------------------
    const restPage = await events(s.keys.builder, `?since=${cursor}&limit=50`);
    const mcpPage = await runTool(s.keys.builder, s.builder, 'get_events', { since: cursor, limit: 50 });
    check('mcp: get_events gives exactly what REST gives from the same cursor', mcpPage.ok === true
      && JSON.stringify(mcpPage.data) === JSON.stringify(restPage.body.data) && /^f1\./.test(mcpPage.meta.next_cursor),
      { mcp: mcpPage.data?.map((e: Loose) => e.id), mcpCursor: mcpPage.meta?.next_cursor, rest: ids(restPage), restCursor: restPage.body.meta.next_cursor });
    const mcpWaitCursor = restPage.body.meta.next_cursor;
    const mcpWaiting = runTool(s.keys.builder, s.builder, 'get_events', { since: mcpWaitCursor, wait: 5 });
    await sleep(250);
    const mcpMessage = await s.chat(s.builder, 'over mcp');
    const mcpWoke = await mcpWaiting;
    check('mcp: get_events with wait answers when the event is written', mcpWoke.ok === true && (mcpWoke.data ?? []).some((e: Loose) => e.subject.id === mcpMessage) && mcpWoke.meta.wait.ended === 'event', mcpWoke);
    const mcpTypes = await runTool(s.keys.builder, s.builder, 'get_events', { since: mcpWaitCursor, types: ['chat.message', 'run.updated'] });
    check('mcp: types go through as a list', mcpTypes.ok === true && mcpTypes.meta?.types?.join() === 'chat.message,run.updated', mcpTypes);

    // --- Chat wait -----------------------------------------------------------------------------
    await s.q("UPDATE pm.chat_messages SET status = 'handled', handled_at = now() WHERE agent_id = $1", [s.builder]);
    const chatWaiting = call(chatRoute.GET, 'GET', '/api/v1/chat/messages?wait=5', s.keys.builder);
    await sleep(300);
    const chatMessage = await s.chat(s.builder, 'wake the poll');
    const chatWoke = await chatWaiting;
    check('chat wait: GET /chat/messages?wait answers with the message as soon as it arrives', chatWoke.status === 200 && chatWoke.ms < 1500
      && chatWoke.body.data.messages.length === 1 && chatWoke.body.data.messages[0]?.id === chatMessage && chatWoke.body.data.messages[0]?.text === 'wake the poll'
      && chatWoke.body.meta.wait.ended === 'event', { ms: chatWoke.ms, body: chatWoke.body });
    const chatNoWait = await call(chatRoute.GET, 'GET', '/api/v1/chat/messages', s.keys.builder);
    check('chat wait: without wait the answer is exactly as before (no meta)', chatNoWait.status === 200 && !('meta' in chatNoWait.body) && chatNoWait.body.data.messages.length === 1, chatNoWait.body);
    const chatIdle = await call(chatRoute.GET, 'GET', '/api/v1/chat/messages?wait=1&status=context', s.keys.builder);
    check('chat wait: nothing for the asked status, empty at the end of the wait', chatIdle.status === 200 && chatIdle.body.data.messages.length === 0 && chatIdle.ms >= 900 && chatIdle.body.meta.wait.ended === 'timeout', { ms: chatIdle.ms, body: chatIdle.body });
    const mcpChat = runTool(s.keys.builder, s.builder, 'list_chat_messages', { status: 'context', wait: 1 });
    check('mcp: list_chat_messages takes wait', (await mcpChat).ok === true);

    // --- At most 2 open waits per key ----------------------------------------------------------
    const latest = (await events(s.keys.builder)).body.meta.next_cursor;
    const first = new AbortController();
    const secondWait = new AbortController();
    const one = events(s.keys.builder, `?since=${latest}&wait=5`, first.signal);
    const two = call(chatRoute.GET, 'GET', '/api/v1/chat/messages?wait=5&status=context', s.keys.builder, { signal: secondWait.signal });
    await sleep(300);
    const third = await events(s.keys.builder, `?since=${latest}&wait=5`);
    check('limit: a third open wait on one key (events and chat count together) is 429 too_many_waits with Retry-After', third.status === 429
      && reason(third) === 'too_many_waits' && Number(third.headers.get('retry-after')) >= 1 && third.ms < 1000, { status: third.status, body: third.body, retry: third.headers.get('retry-after') });
    const noWaitStillFine = await events(s.keys.builder, `?since=${latest}`);
    check('limit: a read without wait is never refused', noWaitStillFine.status === 200);
    const otherKey = await events(s.keys.builder2, `?since=${latest}&wait=1`);
    check('limit: it is per key (another key of the same agent may wait)', otherKey.status === 200, otherKey.body);

    // --- Abort ends a wait early, and frees its slot -------------------------------------------
    first.abort();
    secondWait.abort();
    const [aborted, abortedChat] = await Promise.all([one, two]);
    check('abort: a caller that goes away ends the wait at once, empty, ended aborted', aborted.status === 200 && aborted.body.data.length === 0
      && aborted.ms < 1500 && aborted.body.meta.wait.ended === 'aborted' && abortedChat.body.meta?.wait?.ended === 'aborted', { a: aborted.body.meta, c: abortedChat.body.meta, ms: aborted.ms });
    const leases = Number((await s.q<{ n: number }>('SELECT count(*)::int AS n FROM pm.event_feed_waits'))[0].n);
    const freed = await events(s.keys.builder, `?since=${latest}&wait=1`);
    check('limit: an ended wait gives its slot back (no lease left behind)', freed.status === 200 && leases === 0, { leases, status: freed.status });
    // A server that died mid-wait: its lease ends by itself.
    const keyId = (await s.q<{ id: string }>("SELECT id FROM pm.api_keys WHERE key_hash = $1", [createHash('sha256').update(s.keys.builder).digest('hex')]))[0].id;
    await s.q("INSERT INTO pm.event_feed_waits (id, api_key_id, expires_at) VALUES (gen_random_uuid(), $1, now() - interval '1 second'), (gen_random_uuid(), $1, now() - interval '1 second')", [keyId]);
    const afterCrash = await events(s.keys.builder, `?since=${latest}&wait=1`);
    check('limit: leases a dead server left behind expire on their own', afterCrash.status === 200, afterCrash.body);

    // --- Shutdown ends waits early ---------------------------------------------------------------
    const stopping = events(s.keys.builder, `?since=${latest}&wait=5`);
    await sleep(300);
    longPoll.endWaitsForShutdown();
    const stopped = await stopping;
    const refusedWhileStopping = await events(s.keys.builder, `?since=${latest}&wait=5`);
    longPoll.resetLongPollForTests();
    check('shutdown: SIGTERM ends open waits at once, empty, with next_cursor; new waits answer at once', stopped.status === 200 && stopped.ms < 1500
      && stopped.body.meta.wait.ended === 'shutdown' && !!stopped.body.meta.next_cursor && refusedWhileStopping.ms < 1000 && refusedWhileStopping.body.meta.wait.ended === 'shutdown', { s: stopped.body.meta, r: refusedWhileStopping.body.meta });

    // --- One probe serves every open wait ----------------------------------------------------------
    const before = longPoll.probeStats.probes;
    const plannerNow = (await events(s.keys.planner)).body.meta.next_cursor;
    await Promise.all([events(s.keys.builder, `?since=${latest}&wait=1`), events(s.keys.planner, `?since=${plannerNow}&wait=1`), events(s.keys.builder2, `?since=${latest}&wait=1`)]);
    const probes = longPoll.probeStats.probes - before;
    const perWait = 1000 / LONG_POLL.checkIntervalMs;
    check('db load: three open waits share one probe per interval (not one each)', probes > 0 && probes <= perWait * 1.6, { probes, perWait });

    // --- Retention: a too-old cursor resyncs -------------------------------------------------------
    const oldCursor = 'f1.0.0';
    const beforePrune = await events(s.keys.builder, `?since=${oldCursor}`);
    await s.q("UPDATE pm.event_feed SET created_at = now() - interval '8 days' WHERE seq <= (SELECT max(seq) - 3 FROM pm.event_feed)");
    const pruned = Number((await s.q<{ n: number }>('SELECT pm.prune_event_feed() AS n'))[0].n);
    const resync = await events(s.keys.builder, `?since=${oldCursor}`);
    check('retention: before pruning the oldest cursor still reads', beforePrune.status === 200 && beforePrune.body.data.length > 0);
    check('retention: a cursor older than what was pruned is 410 RESYNC_REQUIRED with the cursor to continue from', pruned > 0 && resync.status === 410
      && resync.body.error?.code === 'RESYNC_REQUIRED' && reason(resync) === 'resync' && /^f1\./.test(resync.body.error?.details?.cursor) && resync.body.error?.details?.retention_days === 7, { pruned, body: resync.body });
    const resumed = await events(s.keys.builder, `?since=${resync.body.error?.details?.cursor ?? 'now'}`);
    check('retention: the resync cursor reads on', resumed.status === 200, resumed.body);
    const mcpResync = await runTool(s.keys.builder, s.builder, 'get_events', { since: oldCursor });
    check('mcp: a too-old cursor is the same 410 resync', mcpResync.ok === false && mcpResync.status === 410 && mcpResync.error?.reason === 'resync', mcpResync);
    const prunedAgain = Number((await s.q<{ n: number }>('SELECT pm.prune_event_feed() AS n'))[0].n);
    check('retention: pruning again with nothing old deletes nothing', prunedAgain === 0, prunedAgain);
    const bad = await events(s.keys.builder, '?since=c1.1.2');
    check('feed: a cursor it did not give out is 400 invalid_cursor', bad.status === 400 && reason(bad) === 'invalid_cursor', bad.body);
    const huge = await Promise.all(['f1.9999999999999999999.0', 'f1.1.9223372036854775808'].map((c) => events(s.keys.builder, `?since=${c}`)));
    const edge = await events(s.keys.builder, '?since=f1.9223372036854775807.9223372036854775807');
    check('feed: a cursor past the largest bigint is 400 invalid_cursor, not 500; the largest itself reads', huge.every((a) => a.status === 400 && reason(a) === 'invalid_cursor')
      && edge.status === 200, [...huge.map((a) => [a.status, reason(a)]), edge.status]);
  } finally {
    await server.close?.();
    await proxy.close();
    await db.close();
  }

  console.log(`long poll: ${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
