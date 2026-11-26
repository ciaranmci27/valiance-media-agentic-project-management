/**
 * Notifications foundation (20261127000700_notifications_foundation.sql),
 * over the real schema on PGlite, the real routes and the real supabase-js
 * client (a fake PostgREST), and the app's one action layer:
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   code from the previous release (the 6 argument upsert, a plain insert,
 *   marking read) still works and its rows get a category.
 * - Categories: the database and the app work them out the same way. A
 *   receipt never comes from free text: an agent's notice titled "Question
 *   from X" or "X needs you on Y" (POST /api/v1/notifications), or a
 *   historic one with no question behind it, stays an update.
 * - A receipt and an unread update about the same thing are two rows; one
 *   never takes the other's place.
 * - Receipts (a question or approval asked, a findings nudge, an inbox
 *   decision) are never listed in Updates nor counted unread; one count
 *   everywhere (the badge, the page, the API; Needs you from one hook).
 * - Done: leaves Updates, implies read, unread undoes it; raising the same
 *   notice again brings it back.
 * - Snooze: hides until its time, then it is back; a member cannot read or
 *   write another member's snoozes.
 * - The action layer: a decision someone else made first (409) says who
 *   ("Already answered by Mia.") and takes the item away; a refused write
 *   puts it back.
 * - Grouping in SQL: the latest row per entity with its counts, keyset paged.
 * - The demo keeps working with its sample data.
 *
 *   npm run -s test:notifications-foundation
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import {
  activeSnoozes, agentNeedsYouWithoutSnoozed, isReceiptCategory, needsYouWithoutSnoozed, nextSnoozeWake, notificationCategoryOf,
  RECEIPT_CATEGORIES, type Snooze,
} from '../src/lib/notifications';
import type { NeedsYouItem } from '../src/lib/autonomy';
import type { AgentNeedsYou } from '../src/lib/agents-tab';

const MIGRATION = '20261127000700_notifications_foundation.sql';
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- NOTIFICATIONS FOUNDATION (20261127000700_notifications_foundation.sql)\n-- ============================================================\n';
const SRC = join(__dirname, '..', 'src');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LOGIN = { id: id(7101), email: 'olivia@studio.example' };
const MIA_LOGIN = { id: id(7102), email: 'mia@studio.example' };

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
  // Rows the previous release made, before the update.
  const member = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old', 'old@example.com', 'owner') RETURNING id"))[0].id;
  const asker = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Bob', 'bob@example.com', 'agent') RETURNING id"))[0].id;
  // A real question rings its bell (notify_question_asked); a free-text notice with the same words has none behind it.
  await q("INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Ship it?')", [asker, member]);
  await q("SELECT pm.upsert_notification($1, 'Question from Bob: can I deploy?', 'm', NULL, 'question', $2)", [member, randomUUID()]);
  await q("SELECT pm.upsert_notification($1, 'Bob needs you on \"Renewal\"', 'm', NULL, 'question', $2)", [member, randomUUID()]);
  await q("SELECT pm.upsert_notification($1, 'Reminder', 'm', '/reminders', 'reminder', $2)", [member, randomUUID()]);
  await applyMigrationsFrom(old, MIGRATION);
  const backfilled = await q<{ title: string; category: string }>('SELECT title, category FROM pm.team_member_notifications ORDER BY title');
  check('backfill: rows from before get their category; only the notice of a real question is a receipt, free text never is', backfilled.length === 4
    && backfilled.map((row) => row.category).join() === 'question,question_asked,question,reminder', backfilled);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql (fresh equals upgraded)', diff.length === 0, diff.slice(0, 10));

  // The previous release's code, unchanged, on the updated database.
  await q("SELECT pm.upsert_notification($1, 'Webhook Billing keeps failing', 'Last error: 500', '/settings/developers', 'webhook', $2)", [member, randomUUID()]);
  await q("INSERT INTO pm.team_member_notifications (user_id, title, message, link, entity_type, entity_id) VALUES ($1, 'Scout spent its budget', 'x', '/agent/x', 'member', $2)", [member, randomUUID()]);
  const compat = await q<{ title: string; category: string }>("SELECT title, category FROM pm.team_member_notifications WHERE title IN ('Webhook Billing keeps failing', 'Scout spent its budget') ORDER BY title");
  check('compatibility: the 6 argument upsert and a plain insert still work, and their rows get a category', compat.length === 2
    && compat[0].category === 'agent_budget' && compat[1].category === 'webhook_failing', compat);
  const marked = await old.query('UPDATE pm.team_member_notifications SET is_read = true WHERE user_id = $1', [member]).then(() => true, (e: Error) => e.message);
  check('compatibility: marking read works as before', marked === true, marked);
  await old.close();

  const fq = async <T = Loose>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;
  const fns = (await fq<{ f: string; anon: boolean; member: boolean; service: boolean }>(`
    SELECT p.oid::regprocedure::text AS f, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS member, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace
      AND p.proname IN ('notification_category', 'notification_is_receipt', 'notification_feed', 'notification_groups', 'notification_unread_count', 'upsert_notification')`));
  const serverOnly = fns.filter((f) => !f.f.startsWith('pm.notification_is_receipt'));
  const receiptFn = fns.find((f) => f.f.startsWith('pm.notification_is_receipt'));
  check('database: the new functions are server only (no anon, no members), the service runs them; members run only the receipt test the dedup index needs',
    serverOnly.length === 6 && serverOnly.every((f) => !f.anon && !f.member && f.service)
      && !!receiptFn && !receiptFn.anon && receiptFn.member && receiptFn.service, fns);
  const tableGrants = (await fq<{ grantee: string; p: string }>(`SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
    FROM information_schema.role_table_grants WHERE table_schema = 'pm' AND table_name = 'member_snoozes' AND grantee IN ('anon', 'authenticated') GROUP BY grantee`));
  check('database: members read and write snoozes (row security keeps them to their own); anon holds nothing', tableGrants.length === 1
    && tableGrants[0].grantee === 'authenticated' && tableGrants[0].p === 'DELETE,INSERT,SELECT,UPDATE', tableGrants);

  // Categories: the database and the app agree. The app is told the kind of
  // the question an entity id names; the database looks it up.
  const who = (await fq<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Quinn', 'quinn@example.com', 'owner') RETURNING id"))[0].id;
  const agent = (await fq<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Builder', 'builder@example.com', 'agent') RETURNING id"))[0].id;
  const realQuestion = (await fq<{ id: string }>("INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Up?') RETURNING id", [agent, who]))[0].id;
  const realApproval = (await fq<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question, kind, action, choices, allow_other)
    VALUES ($1, $2, 'Send?', 'approval', '{"type":"other","summary":"Send it"}', '["approve", "reject"]', false) RETURNING id`, [agent, who]))[0].id;
  const none = randomUUID();
  const samples: [string | null, string | null, string, string | null][] = [
    ['question', realQuestion, 'Question from Builder', 'question'], ['question', realApproval, 'Approval request from Scout to Finance', 'approval'],
    ['question', none, 'Question from Jeff: can I deploy?', null], ['question', none, 'Approval request from Jeff', null],
    ['question', realApproval, 'Question from Builder', 'approval'], ['question', 'not-a-uuid', 'Question from Builder', null],
    ['question', realQuestion, 'Your question to Mia expired without an answer', 'question'], ['question', none, 'Reply draft ready: "Invoice"', null],
    ['question', none, 'Ashley needs you on "Renewal"', null], ['question', none, 'Something else', null],
    ['project', none, "Scout's findings are waiting on you", null], ['project', none, 'Retainer draft failed', null], ['project', none, 'Invoice email ready for review', null],
    ['project', none, '"Site" was updated', null], ['member', none, 'Scout stopped responding', null], ['member', none, 'Scout is back', null],
    ['member', none, 'Scout spent its budget', null], ['member', none, "Mia's assistant is not working", null], ['member', none, 'Priya joined', null],
    ['invoice', none, 'Ready to review and send', null], ['reminder', none, 'Reminder', null], ['schedule', none, 'A schedule paused', null],
    ['webhook', none, 'Webhook X keeps failing', null], ['task', none, 'New comment on "X"', null], [null, null, 'Hello', null],
  ];
  const sql = await fq<{ c: string }>(`SELECT pm.notification_category(e, i, t) AS c FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS s(e, i, t, n) ORDER BY n`,
    [samples.map(([e]) => e), samples.map(([, i]) => i), samples.map(([, , t]) => t)]);
  const mismatched = samples.map(([e, i, t, kind], n) => ({ e, i, t, sql: sql[n]?.c, app: notificationCategoryOf(e, t, kind) })).filter((row) => row.sql !== row.app);
  check('categories: pm.notification_category and notificationCategoryOf agree on every kind of notice', mismatched.length === 0, mismatched);
  const receiptsFound = samples.map(([, , t], n) => ({ t, c: sql[n]?.c })).filter((row) => isReceiptCategory(row.c));
  check('categories: only a real question or approval (and the findings nudge) is a receipt; free text naming a question, an approval or an inbox decision is not',
    receiptsFound.map((row) => row.c).join() === 'question_asked,approval_requested,findings_nudge', receiptsFound);
  const receipts = await fq<{ c: string; r: boolean }>(`SELECT c, pm.notification_is_receipt(c) AS r FROM unnest($1::text[]) AS c`,
    [[...RECEIPT_CATEGORIES, 'reminder', 'task_comments', 'question_expired']]);
  check('receipts: the database and the app name the same ones', receipts.every((row) => row.r === isReceiptCategory(row.c))
    && receipts.filter((row) => row.r).length === RECEIPT_CATEGORIES.length, receipts);
  return fresh;
}

// ── Pure: snoozes and one Needs you ──────────────────────────────────────

function pureChecks() {
  const now = Date.parse('2026-12-01T12:00:00Z');
  const snoozes: Snooze[] = [
    { item_kind: 'question', item_id: 'q1', until: '2026-12-01T13:00:00Z' },
    { item_kind: 'task', item_id: 't1', until: '2026-12-02T09:00:00Z' },
    { item_kind: 'suggestion', item_id: 's1', until: '2026-12-01T11:00:00Z' },
  ];
  const hidden = activeSnoozes(snoozes, now);
  check('snooze: only ones still in force hide, and the next wake is the soonest of those', hidden.size === 2 && !hidden.has('suggestion:s1')
    && nextSnoozeWake(snoozes, now) === Date.parse('2026-12-01T13:00:00Z') && nextSnoozeWake(snoozes, Date.parse('2026-12-03T00:00:00Z')) === null);
  const task = (taskId: string) => ({ id: taskId, updated_at: '2026-12-01T00:00:00Z' }) as Loose;
  const question = (qid: string) => ({ id: qid, created_at: '2026-12-01T00:00:00Z' }) as Loose;
  const items: NeedsYouItem[] = [
    { kind: 'question', openQuestion: question('q1') }, { kind: 'question', openQuestion: question('q2') },
    { kind: 'blocked', task: task('t2'), questionId: 'q1' }, { kind: 'merge', task: task('t1') }, { kind: 'due', task: task('t3') },
  ];
  const shown = needsYouWithoutSnoozed(items, hidden);
  check('snooze: Needs you leaves out a snoozed question, the block that names it, and a snoozed task\'s rows', shown.length === 2
    && shown[0].openQuestion?.id === 'q2' && shown[1].task?.id === 't3', shown.map((i) => i.kind));
  const later = needsYouWithoutSnoozed(items, activeSnoozes(snoozes, Date.parse('2026-12-03T00:00:00Z')));
  check('snooze: once its time passes, everything is back', later.length === items.length);
  const agents: AgentNeedsYou = {
    questions: [question('q1'), question('q2')], blocked: [{ task: task('t2'), question: 'x', agentId: 'a', questionId: 'q1' }],
    inReview: [{ task: task('t1'), agentId: 'a' }], suggestions: 2, pendingSuggestions: [{ id: 's1' } as Loose, { id: 's2' } as Loose], total: 6,
  };
  const slice = agentNeedsYouWithoutSnoozed(agents, activeSnoozes([...snoozes, { item_kind: 'suggestion', item_id: 's2', until: '2026-12-05T00:00:00Z' }], now));
  check('snooze: the agents\' slice drops the same items and its total still adds up', slice.questions.length === 1 && slice.blocked.length === 0
    && slice.inReview.length === 0 && slice.pendingSuggestions.length === 1 && slice.suggestions === 1 && slice.total === 2, slice);

  // One definition: every surface reads useNeedsYou; nothing else computes Needs you.
  const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
  const computing = ['components/layout/Sidebar.tsx', 'app/(protected)/my-tasks/page.tsx', 'components/agent/NeedsYouView.tsx']
    .filter((file) => read(file).includes('computeNeedsYou(') || !read(file).includes('useNeedsYou'));
  check('one count: the sidebar, My Tasks and the Agents home read useNeedsYou, none computes its own', computing.length === 0, computing);
  const hook = read('lib/use-needs-you.ts');
  check('one count: useNeedsYou reads computeNeedsYou, the one definition', hook.includes('computeNeedsYou(') && hook.includes('needsYouWithoutSnoozed'));
  const events = ['lib/store.tsx', 'components/layout/Sidebar.tsx', 'app/(protected)/notifications/page.tsx'].filter((file) => read(file).includes('notifications-updated'));
  check('reads: the notifications-updated window event is gone; live sync and the action layer mark the reads stale', events.length === 0, events);
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    const memberId = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id',
      [name, login?.email ?? `${name.toLowerCase()}@studio.example`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, memberId]);
    }
    return memberId;
  };
  const olivia = await member('Olivia', 'owner', LOGIN);
  const mia = await member('Mia', 'admin', MIA_LOGIN);
  const scout = await member('Scout', 'agent');
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Website relaunch') RETURNING id"))[0].id;
  const task = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Hero copy') RETURNING id", [project]))[0].id;
  const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
  await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
    VALUES ('Key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), olivia, ['notifications.manage_own']]);
  await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    VALUES ($1, 'notifications.manage_own', 'api', 'allow') ON CONFLICT DO NOTHING`, [olivia]);
  const agentSecret = `pk_live_${randomUUID().replace(/-/g, '')}`;
  await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
    VALUES ('Agent key', 'pk_live', $1, $2, $3, $4, 'scoped')`, [createHash('sha256').update(agentSecret).digest('hex'), scout, olivia, ['notifications.send']]);
  await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    VALUES ($1, 'notifications.send', 'api', 'allow') ON CONFLICT DO NOTHING`, [scout]);
  return { q, olivia, mia, scout, project, task, key: secret, agentKey: agentSecret };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  pureChecks();
  const migrated = await migrationChecks();
  await migrated.close();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const authStandIn = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: LOGIN.id, aud: 'authenticated', role: 'authenticated', email: LOGIN.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-26T00:00:00Z' }));
      return true;
    }
    return false;
  };
  const server = await startFakePostgrest(db, { handle: authStandIn });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  // A signed-in Olivia for the session routes.
  const cookie = `sb-${new URL(server.url).hostname.split('.')[0]}-auth-token`;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sessionValue = `base64-${Buffer.from(JSON.stringify({
    access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: LOGIN.id, email: LOGIN.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`,
    refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: exp,
    user: { id: LOGIN.id, email: LOGIN.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-26T00:00:00Z' },
  })).toString('base64url')}`;
  const store = { getAll: () => [{ name: cookie, value: sessionValue }], get: (k: string) => (k === cookie ? { name: cookie, value: sessionValue } : undefined), set: () => undefined };
  (createRequire(__filename)('next/headers') as { cookies: () => Promise<typeof store> }).cookies = async () => store;

  try {
    const feedRoute = await import('../src/app/api/workspace/notifications/route');
    const groupsRoute = await import('../src/app/api/workspace/notifications/groups/route');
    const doneRoute = await import('../src/app/api/workspace/notifications/done/route');
    const snoozeRoute = await import('../src/app/api/workspace/notifications/snoozes/route');
    const answerRoute = await import('../src/app/api/workspace/questions/[id]/answer/route');
    const cancelRoute = await import('../src/app/api/workspace/questions/[id]/cancel/route');
    const v1List = await import('../src/app/api/v1/notifications/route');
    const read = async (response: Response) => ({ status: response.status, body: await response.json().catch(() => null) as Loose });
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
      read(await handler(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
        { params: Promise.resolve(params) } as never));
    const v1 = async (path: string) => read(await v1List.GET(new NextRequest(`http://localhost${path}`, { headers: { 'x-api-key': s.key } }), { params: Promise.resolve({}) } as never));
    const one = async <T = Loose>(sql: string, params: unknown[] = []) => (await s.q<T>(sql, params))[0];
    const feed = async (view = 'updates') => (await session(feedRoute.GET, 'GET', `/api/workspace/notifications?view=${view}`)).body.data;
    const count = async () => (await session(feedRoute.GET, 'GET', '/api/workspace/notifications?count=1')).body.data.unread as number;
    const titles = (page: Loose) => (page.items as { title: string }[]).map((n) => n.title);

    // ── Receipts and one count ─────────────────────────────────────────
    const asked = (await one<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question, project_id, task_id) VALUES ($1, $2, 'Round up or down?', $3, $4) RETURNING id`,
      [s.scout, s.olivia, s.project, s.task])).id;
    const approval = (await one<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question, kind, action, choices, allow_other) VALUES ($1, $2, 'Send the invoice?', 'approval', '{"type":"other","summary":"Send INV-7"}', '["approve", "reject"]', false) RETURNING id`,
      [s.scout, s.olivia])).id;
    await s.q("SELECT pm.upsert_notification($1, 'Scout''s findings are waiting on you', 'Three ideas', '/agent', 'project', $2)", [s.olivia, s.project]);
    await s.q(`SELECT pm.upsert_notification($1, 'Scout needs you on "Renewal"', 'One proposal to approve', '/inbox', 'question', $2, 'inbox_decision')`, [s.olivia, randomUUID()]);
    await s.q("SELECT pm.upsert_notification($1, 'New comment on \"Hero copy\"', 'Mia: looks good', '/projects/x', 'task', $2, 'task_comments', NULL, $3)", [s.olivia, s.task, s.mia]);
    await s.q("SELECT pm.upsert_notification($1, 'Reminder', 'Call David', '/reminders', 'reminder', $2)", [s.olivia, randomUUID()]);
    const bell = await s.q<{ title: string; category: string; project_id: string | null; actor_id: string | null }>(
      "SELECT title, category, project_id, actor_id FROM pm.team_member_notifications WHERE user_id = $1 AND entity_type = 'question' AND entity_id = $2", [s.olivia, asked]);
    check('a question asked rings a receipt: category question_asked, with its project and asker filled in', bell.length === 1
      && bell[0].category === 'question_asked' && bell[0].project_id === s.project && bell[0].actor_id === s.scout, bell);
    const comment = await one("SELECT category, actor_id, project_id FROM pm.team_member_notifications WHERE entity_type = 'task' AND entity_id = $1", [s.task]);
    check('the 9 argument upsert keeps the category and actor it is given and finds the project', comment.category === 'task_comments' && comment.actor_id === s.mia && comment.project_id === s.project, comment);

    const updates = await feed();
    check('receipts: a question, an approval, a findings nudge and an inbox decision are not in Updates', updates.items.length === 2
      // Rows made in the same instant are ordered by id, so compare them as a set.
      && [...titles(updates)].sort().join('|') === 'New comment on "Hero copy"|Reminder', titles(updates));
    const unread = await count();
    const v1Unread = await v1('/api/v1/notifications?view=updates&is_read=false');
    const allRows = await v1('/api/v1/notifications');
    check('one count: the badge, the page and the API agree, receipts not counted', unread === 2 && updates.unread === 2
      && v1Unread.status === 200 && v1Unread.body.meta?.total === 2, { unread, page: updates.unread, v1: v1Unread.body?.meta });
    check('API: without view every notification is listed as before, now with category and done_at', allRows.status === 200 && allRows.body.meta?.total === 6
      && allRows.body.data.every((n: Loose) => typeof n.category === 'string' && 'done_at' in n), allRows.body?.meta);
    // An agent's escalation through the API is free text: an update the person reads, whatever it says.
    const send = async (body: unknown) => read(await v1List.POST(new NextRequest('http://localhost/api/v1/notifications', {
      method: 'POST', headers: { 'x-api-key': s.agentKey, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({}) } as never));
    const sentQuestion = await send({ title: 'Question from Jeff: can I deploy?', message: 'Staging is green.' });
    const sentDecision = await send({ title: 'Jeff needs you on "Renewal"', message: 'Two replies owed.' });
    const sentNudge = await send({ title: "Scout's findings are waiting on you", message: 'Three ideas', entity_type: 'project', entity_id: s.project });
    const afterSend = await feed();
    const sentRows = await s.q<{ title: string; category: string; actor_id: string }>(
      "SELECT title, category, actor_id FROM pm.team_member_notifications WHERE user_id = $1 AND category IN ('agent_message', 'findings_nudge') ORDER BY title", [s.olivia]);
    check('API: an agent notice titled "Question from X" or "X needs you on Y" stays in Updates and the count (category agent_message, from the agent)',
      sentQuestion.status === 201 && sentDecision.status === 201 && titles(afterSend).includes('Question from Jeff: can I deploy?')
        && titles(afterSend).includes('Jeff needs you on "Renewal"') && afterSend.unread === 4 && (await count()) === 4
        && sentRows.filter((row) => row.category === 'agent_message').every((row) => row.actor_id === s.scout),
    { status: [sentQuestion.status, sentDecision.status], feed: titles(afterSend), unread: afterSend.unread, sentRows });
    check('API: the findings nudge convention is the one agent notice that is a receipt', sentNudge.status === 201
      && !titles(afterSend).includes("Scout's findings are waiting on you") && sentRows.some((row) => row.category === 'findings_nudge'), sentRows);
    // Out of the way of the checks below.
    await s.q("DELETE FROM pm.team_member_notifications WHERE user_id = $1 AND category = 'agent_message'", [s.olivia]);

    // A receipt and an unread update about the same thing: two rows, neither takes the other's place.
    const swallowed = (await one<{ id: string }>("INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Hero or carousel?') RETURNING id", [s.scout, s.olivia])).id;
    await s.q("SELECT pm.upsert_notification($1, 'Scout added context', 'See the brief', NULL, 'question', $2, 'question_context')", [s.olivia, swallowed]);
    await s.q("SELECT pm.upsert_notification($1, 'Question from Scout', 'Hero or carousel? (again)', '/my-tasks', 'question', $2)", [s.olivia, swallowed]);
    const both = await s.q<{ title: string; category: string; is_read: boolean }>(
      "SELECT title, category, is_read FROM pm.team_member_notifications WHERE user_id = $1 AND entity_id = $2 ORDER BY title", [s.olivia, swallowed]);
    check('receipts: a receipt never takes the place of an unread update about the same thing (two rows, the update still listed)', both.length === 2
      && both.every((row) => !row.is_read) && both.map((row) => row.category).sort().join() === 'question_asked,question_context'
      && titles(await feed()).includes('Scout added context'), both);
    await s.q("DELETE FROM pm.team_member_notifications WHERE user_id = $1 AND category = 'question_context'", [s.olivia]);
    await s.q("UPDATE pm.questions SET status = 'cancelled' WHERE id = $1", [swallowed]);

    const v1Bad = await v1('/api/v1/notifications?view=everything');
    check('API: an unknown view is refused', v1Bad.status === 400, v1Bad.status);
    void approval;

    // ── Done ───────────────────────────────────────────────────────────
    const reminder = updates.items.find((n: Loose) => n.title === 'Reminder');
    const done = await session(doneRoute.POST, 'POST', '/api/workspace/notifications/done', { ids: [reminder.id] });
    const afterDone = await feed();
    const doneView = await feed('done');
    const doneRow = await one('SELECT is_read, done_at FROM pm.team_member_notifications WHERE id = $1', [reminder.id]);
    check('done: leaves Updates and the count, shows under done, and is read', done.status === 200 && done.body.data.updated === 1
      && !titles(afterDone).includes('Reminder') && afterDone.unread === 1 && titles(doneView).join() === 'Reminder' && doneRow.is_read === true && doneRow.done_at !== null,
    { done: done.body, after: titles(afterDone), doneView: titles(doneView), doneRow });
    await s.q("SELECT pm.upsert_notification($1, 'Reminder', 'Call David again', '/reminders', 'reminder', $2)", [s.olivia, reminder.entity_id]);
    const back = await s.q<{ id: string; is_read: boolean; done_at: string | null; message: string }>(
      "SELECT id, is_read, done_at, message FROM pm.team_member_notifications WHERE entity_type = 'reminder' AND entity_id = $1", [reminder.entity_id]);
    check('done: raising the same notice again brings that row back, unread, not a second row', back.length === 1 && back[0].id === reminder.id
      && back[0].is_read === false && back[0].done_at === null && back[0].message === 'Call David again' && titles(await feed()).includes('Reminder'), back);
    await session(doneRoute.POST, 'POST', '/api/workspace/notifications/done', { ids: [reminder.id] });
    await s.q('UPDATE pm.team_member_notifications SET is_read = false WHERE id = $1', [reminder.id]);
    const undone = await one('SELECT is_read, done_at FROM pm.team_member_notifications WHERE id = $1', [reminder.id]);
    check('done: marking it unread again undoes done', undone.is_read === false && undone.done_at === null, undone);
    const allDone = await session(doneRoute.POST, 'POST', '/api/workspace/notifications/done', { all: true });
    const receiptsAfter = await one<{ n: number }>("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE user_id = $1 AND done_at IS NOT NULL AND pm.notification_is_receipt(category)", [s.olivia]);
    check('done: all marks every open Update done and leaves receipts to Needs you', allDone.status === 200 && allDone.body.data.updated === 2
      && (await feed()).items.length === 0 && receiptsAfter.n === 0, { allDone: allDone.body, receipts: receiptsAfter });
    const notMine = await s.q("SELECT pm.upsert_notification($1, 'Reminder', 'Mia''s own', '/reminders', 'reminder', $2)", [s.mia, randomUUID()]);
    void notMine;
    const miaRow = await one<{ id: string }>("SELECT id FROM pm.team_member_notifications WHERE user_id = $1", [s.mia]);
    const foreign = await session(doneRoute.POST, 'POST', '/api/workspace/notifications/done', { ids: [miaRow.id] });
    check('done: another member\'s notification is never touched', foreign.status === 200 && foreign.body.data.updated === 0
      && (await one('SELECT done_at FROM pm.team_member_notifications WHERE id = $1', [miaRow.id])).done_at === null, foreign.body);
    await session(doneRoute.POST, 'POST', '/api/workspace/notifications/done', { ids: [reminder.id], done: false });
    check('done: done false brings it back to Updates', titles(await feed()).includes('Reminder'));

    // ── Snooze ─────────────────────────────────────────────────────────
    const inAnHour = new Date(Date.now() + 3600_000).toISOString();
    await s.q('UPDATE pm.team_member_notifications SET is_read = false WHERE id = $1', [reminder.id]);
    const beforeSnooze = await count();
    const snoozed = await session(snoozeRoute.POST, 'POST', '/api/workspace/notifications/snoozes', { item_kind: 'notification', item_id: reminder.id, until: inAnHour });
    const hiddenFeed = await feed();
    check('snooze: a snoozed notification leaves Updates and the count until its time', snoozed.status === 200 && !titles(hiddenFeed).includes('Reminder')
      && beforeSnooze === 1 && hiddenFeed.unread === 0, { beforeSnooze, snoozed: snoozed.body, feed: titles(hiddenFeed), unread: hiddenFeed.unread });
    const listed = await session(snoozeRoute.GET, 'GET', '/api/workspace/notifications/snoozes');
    check('snooze: the member\'s snoozes list it', listed.status === 200 && listed.body.data.length === 1 && listed.body.data[0].item_id === reminder.id, listed.body);
    await s.q("UPDATE pm.member_snoozes SET until = now() - interval '1 second' WHERE item_id = $1", [reminder.id]);
    check('snooze: once its time passes it is back, with nothing to run', titles(await feed()).includes('Reminder') && (await count()) === 1
      && (await session(snoozeRoute.GET, 'GET', '/api/workspace/notifications/snoozes')).body.data.length === 0);
    const past = await session(snoozeRoute.POST, 'POST', '/api/workspace/notifications/snoozes', { item_kind: 'question', item_id: asked, until: new Date(Date.now() - 1000).toISOString() });
    const tooFar = await session(snoozeRoute.POST, 'POST', '/api/workspace/notifications/snoozes', { item_kind: 'question', item_id: asked, until: new Date(Date.now() + 200 * 86_400_000).toISOString() });
    const badKind = await session(snoozeRoute.POST, 'POST', '/api/workspace/notifications/snoozes', { item_kind: 'project', item_id: asked, until: inAnHour });
    check('snooze: a time in the past, more than 90 days away or an unknown kind is refused', past.status === 422 && tooFar.status === 422 && badKind.status === 422,
      [past.status, tooFar.status, badKind.status]);
    await session(snoozeRoute.POST, 'POST', '/api/workspace/notifications/snoozes', { item_kind: 'question', item_id: asked, until: inAnHour });
    const removed = await session(snoozeRoute.DELETE, 'DELETE', '/api/workspace/notifications/snoozes', { item_kind: 'question', item_id: asked });
    check('snooze: unsnooze brings it back now', removed.status === 200 && removed.body.data.removed === true
      && (await one<{ n: number }>('SELECT count(*)::int AS n FROM pm.member_snoozes WHERE item_id = $1', [asked])).n === 0);

    // Row security: a member reads and writes only their own snoozes.
    await s.q("INSERT INTO pm.member_snoozes (member_id, item_kind, item_id, until) VALUES ($1, 'task', $2, now() + interval '1 day')", [s.mia, s.task]);
    await actAs(db, LOGIN.id);
    const seen = (await db.query<{ member_id: string }>('SELECT member_id FROM pm.member_snoozes')).rows;
    const write = await db.query("INSERT INTO pm.member_snoozes (member_id, item_kind, item_id, until) VALUES ($1, 'task', $2, now() + interval '1 day')", [s.mia, randomUUID()]).then(() => 'written', (e: Error) => e.message);
    const changed = (await db.query("UPDATE pm.member_snoozes SET until = now() WHERE member_id = $1", [s.mia])).affectedRows;
    const deleted = (await db.query('DELETE FROM pm.member_snoozes WHERE member_id = $1', [s.mia])).affectedRows;
    const own = await db.query("INSERT INTO pm.member_snoozes (member_id, item_kind, item_id, until) VALUES ($1, 'task', $2, now() + interval '1 day')", [s.olivia, s.task]).then(() => 'written', (e: Error) => e.message);
    await db.exec('RESET ROLE');
    check('row security: a member cannot see, add, change or remove another member\'s snoozes, and can add their own',
      seen.every((row) => row.member_id === s.olivia) && /row-level security|policy/i.test(write) && changed === 0 && deleted === 0 && own === 'written',
    { seen, write, changed, deleted, own });
    const miaStill = await one<{ n: number }>('SELECT count(*)::int AS n FROM pm.member_snoozes WHERE member_id = $1', [s.mia]);
    check('row security: Mia\'s snooze is still there', miaStill.n === 1, miaStill);

    // ── Grouping in SQL ────────────────────────────────────────────────
    const other = (await one<{ id: string }>("INSERT INTO pm.tasks (project_id, title) VALUES ($1, 'Footer') RETURNING id", [s.project])).id;
    // The comment notice (marked done above) back in Updates, read.
    await s.q("UPDATE pm.team_member_notifications SET done_at = NULL, is_read = true WHERE user_id = $1 AND entity_type = 'task' AND entity_id = $2", [s.olivia, s.task]);
    await s.q("SELECT pm.upsert_notification($1, 'Hero copy moved to Review', 'x', NULL, 'task', $2, 'task_status')", [s.olivia, s.task]);
    await s.q("SELECT pm.upsert_notification($1, 'New task: Footer', 'x', NULL, 'task', $2, 'task_created')", [s.olivia, other]);
    await s.q("UPDATE pm.team_member_notifications SET created_at = now() + interval '1 second' WHERE entity_id = $1", [other]);
    const groups = await session(groupsRoute.GET, 'GET', '/api/workspace/notifications/groups?limit=2');
    const g = groups.body?.data;
    const hero = g?.groups?.find((x: Loose) => x.group_key === `task:${s.task}`);
    check('groups: the latest row per thing, with how many it holds and how many are unread, newest first', groups.status === 200
      && g.groups.length === 2 && g.groups[0].latest.title === 'New task: Footer' && hero?.group_count === 2 && hero?.unread_count === 1
      && hero?.latest.title === 'Hero copy moved to Review' && typeof g.next_cursor === 'string', g);
    const page2 = await session(groupsRoute.GET, 'GET', `/api/workspace/notifications/groups?limit=2&before=${encodeURIComponent(g.next_cursor)}`);
    const keys2 = (page2.body.data.groups as Loose[]).map((x) => x.group_key);
    check('groups: the next page carries on after the cursor with no repeats', page2.status === 200 && keys2.length >= 1
      && keys2.every((k) => !g.groups.some((x: Loose) => x.group_key === k)), keys2);

    // ── The action layer ───────────────────────────────────────────────
    const routes: [RegExp, Loose, string][] = [
      [/^\/api\/workspace\/questions\/([^/]+)\/answer$/, answerRoute.POST, 'POST'],
      [/^\/api\/workspace\/questions\/([^/]+)\/cancel$/, cancelRoute.POST, 'POST'],
      [/^\/api\/workspace\/notifications\/snoozes$/, snoozeRoute, 'ANY'],
      [/^\/api\/workspace\/notifications\/done$/, doneRoute.POST, 'POST'],
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(server.url)) return realFetch(input, init);
      if (!url.startsWith('/')) return new Response(null, { status: 204 });
      for (const [pattern, handler, method] of routes) {
        const match = pattern.exec(url);
        if (!match) continue;
        const fn = method === 'ANY' ? handler[init?.method ?? 'GET'] : handler;
        return fn(new Request(`http://localhost${url}`, init), { params: Promise.resolve({ id: match[1] }) });
      }
      return new Response(JSON.stringify({ error: `no route for ${url}` }), { status: 404 });
    }) as typeof fetch;
    try {
      const { createNeedsYouActions } = await import('../src/lib/needs-you-actions');
      const { setReadData, peekRead } = await import('../src/lib/query-cache');
      const { openQuestionsRead, mySnoozesRead } = await import('../src/lib/reads');
      const actions = createNeedsYouActions({
        isDemoMode: false, teamMemberId: s.olivia,
        approveSuggestion: async () => true, declineSuggestion: async () => true, rejectSuggestion: async () => true,
      });
      const view = (qid: string, extra: Loose = {}) => ({ id: qid, kind: 'question', status: 'open', choices: null, allow_other: true, created_at: new Date().toISOString(), ...extra });
      const openIds = () => (peekRead(openQuestionsRead(false)) ?? []).map((q: Loose) => q.id);

      // Mia answered it a moment ago; Olivia's screen still shows it.
      const raced = (await one<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Ship Friday?') RETURNING id`, [s.scout, s.olivia])).id;
      await s.q("UPDATE pm.questions SET status = 'answered', answer_text = 'Yes', answered_by = $1, answered_at = now() WHERE id = $2", [s.mia, raced]);
      setReadData(openQuestionsRead(false), () => [view(raced), view(asked)] as Loose);
      const handled = await actions.answer(view(raced) as Loose, { text: 'No' });
      check('actions: answered meanwhile by someone else is "Already answered by Mia." and the item leaves (409)', handled.status === 'handled'
        && (handled as Loose).message === 'Already answered by Mia.' && !openIds().includes(raced) && openIds().includes(asked), { handled, open: openIds() });

      // A refused write (a choice the question does not have) puts the item back where it was.
      const choosy = (await one<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question, choices, allow_other) VALUES ($1, $2, 'Up or down?', '["Up", "Down"]', false) RETURNING id`, [s.scout, s.olivia])).id;
      setReadData(openQuestionsRead(false), () => [view(asked), view(choosy)] as Loose);
      const refused = await actions.answer(view(choosy) as Loose, { choice: 'Sideways' });
      check('actions: a refused answer reports the server\'s words and puts the item back in place', refused.status === 'failed'
        && openIds().join() === [asked, choosy].join(), { refused, open: openIds() });

      // Answered here: gone at once, and stays gone.
      setReadData(openQuestionsRead(false), () => [view(asked), view(choosy)] as Loose);
      const answered = await actions.answer(view(asked) as Loose, { text: 'Up' });
      const stored = await one('SELECT status, answered_by FROM pm.questions WHERE id = $1', [asked]);
      check('actions: an answer takes the item off at once and is stored as the person\'s', answered.status === 'done' && !openIds().includes(asked)
        && stored.status === 'answered' && stored.answered_by === s.olivia, { answered: answered.status, stored, open: openIds() });

      // The approval decided by Mia: the 409 names the decision.
      await s.q("UPDATE pm.questions SET status = 'answered', answer_choice = 'reject', answered_by = $1, answered_at = now() WHERE id = $2", [s.mia, approval]);
      const rejected = await actions.decide(view(approval, { kind: 'approval' }) as Loose, 'approve');
      check('actions: an approval rejected meanwhile says "Already rejected by Mia."', rejected.status === 'handled' && (rejected as Loose).message === 'Already rejected by Mia.', rejected);

      // Not optimistic (a card that shows its own line first): stays listed until the server answers, then leaves on refresh.
      const quiet = (await one<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question) VALUES ($1, $2, 'Logo size?') RETURNING id`, [s.scout, s.olivia])).id;
      setReadData(openQuestionsRead(false), () => [view(quiet)] as Loose);
      const cancelled = await actions.cancel(view(quiet) as Loose, { optimistic: false });
      check('actions: optimistic false leaves the list alone and the server decides (Olivia, the Owner, may withdraw it)', cancelled.status === 'done'
        && openIds().includes(quiet) && (await one('SELECT status FROM pm.questions WHERE id = $1', [quiet])).status === 'cancelled', cancelled);

      // Snooze through the layer: shown in the cache at once, stored for the member.
      setReadData(mySnoozesRead(false), () => []);
      const snoozedTask = await actions.snooze('task', s.task, new Date(Date.now() + 86_400_000));
      const cached = peekRead(mySnoozesRead(false)) ?? [];
      check('actions: a snooze shows at once and is stored for the member', snoozedTask.status === 'done' && cached.some((x: Snooze) => x.item_id === s.task)
        && (await one<{ n: number }>('SELECT count(*)::int AS n FROM pm.member_snoozes WHERE member_id = $1 AND item_id = $2', [s.olivia, s.task])).n === 1);
      const badSnooze = await actions.snooze('task', s.task, new Date(Date.now() - 60_000));
      check('actions: a refused snooze puts the cached list back', badSnooze.status === 'failed' && (peekRead(mySnoozesRead(false)) ?? []).length === cached.length, badSnooze);
    } finally {
      globalThis.fetch = realFetch;
    }

    // ── The demo ───────────────────────────────────────────────────────
    const demo = await import('../src/lib/demo-notifications');
    const demoPage = demo.demoNotificationPage('updates');
    const firstUnread = demoPage.items.find((n) => !n.is_read)!;
    demo.demoMarkDone([firstUnread.id], true);
    const afterDemo = demo.demoNotificationPage('updates');
    check('demo: sample notifications list with categories; done leaves Updates and the count', demoPage.items.length > 0 && demoPage.items.every((n) => !!n.category)
      && demoPage.unread === 2 && afterDemo.unread === 1 && !afterDemo.items.some((n) => n.id === firstUnread.id)
      && demo.demoNotificationPage('done').items.some((n) => n.id === firstUnread.id), { before: demoPage.unread, after: afterDemo.unread });
    demo.demoSnooze({ item_kind: 'notification', item_id: afterDemo.items[0].id, until: new Date(Date.now() + 60_000).toISOString() });
    check('demo: a snoozed sample leaves Updates', !demo.demoNotificationPage('updates').items.some((n) => n.id === afterDemo.items[0].id) && demo.demoSnoozes().length === 1);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`notifications foundation: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`notifications foundation: ${passed} checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
