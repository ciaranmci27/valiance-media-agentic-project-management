/**
 * Notifications center (20261127002700_notifications_center.sql), over the
 * real schema on PGlite, the real routes and supabase-js (a fake PostgREST):
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   agents' "[BLOCKED]" comments from before become blocked, a person's
 *   never do.
 * - Blocked is an agent's alone: the flag or the prefix, kept with the
 *   task's status; a person's comment is never blocked, whatever it says.
 * - pm.my_blocked_comments: the agent's managers and the task's people see
 *   it; nobody else. It leaves once a person replies or the agent writes
 *   again (another agent writing does not answer it), once the task moves,
 *   is done or goes to Trash, and while AI agents are off.
 * - The browser's mirror (blockedCommentSignals, for the demo) agrees with
 *   the database on the same comments, and computeNeedsYou lists each as one
 *   blocked item on its task, waiting since the comment.
 * - REST and MCP: an agent sends blocked: true on a comment; a person's key
 *   is refused (422 blocked_agents_only). GET /api/v1/notifications pages by
 *   keyset (before = meta.next_cursor) with view updates, unread or done.
 * - pm.notification_view_count is the number of Updates the page pages over.
 * - An approval with a long list of details: Approve waits until every row
 *   has been on screen (security review, finding 4).
 * - One Needs you: the bell, the page and the AI home read useAiHub, built
 *   on useNeedsYou; nothing computes its own.
 *
 *   npm run -s test:notifications-center
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { computeNeedsYou, type BlockedCommentSignal } from '../src/lib/autonomy';
import { blockedCommentSignals, waitedWords } from '../src/lib/ai-home';
import { approvalDetailRows, approvalReady, APPROVAL_DETAIL_ROWS_MAX } from '../src/lib/questions';
import { bellCountLabel, notificationsSummary, notificationsView } from '../src/lib/notifications';
import { PM_TOOLS as tools } from '../src/lib/mcp/tools';
import type { Comment, Task, TeamMember } from '../src/lib/types';

const MIGRATION = '20261127002700_notifications_center.sql';
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- NOTIFICATIONS CENTER (20261127002700_notifications_center.sql)\n-- ============================================================\n';
const SRC = join(__dirname, '..', 'src');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
  const person = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Olivia', 'o@example.com', 'owner') RETURNING id"))[0].id;
  const agent = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Quill', 'q@example.com', 'agent') RETURNING id"))[0].id;
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Site') RETURNING id"))[0].id;
  const open = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status) VALUES ($1, 'Copy', 'in_progress') RETURNING id", [project]))[0].id;
  const done = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status) VALUES ($1, 'Old', 'done') RETURNING id", [project]))[0].id;
  await q("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, '[BLOCKED] Which date?')", [open, agent]);
  await q("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, '[blocked] me too')", [open, person]);
  await q("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, '[BLOCKED] long ago')", [done, agent]);
  await applyMigrationsFrom(old, MIGRATION);
  const rows = await q<{ text: string; blocked: boolean; blocked_task_status: string | null }>('SELECT text, blocked, blocked_task_status FROM pm.task_comments ORDER BY text');
  check('backfill: an agent\'s "[BLOCKED]" comment on an open task is blocked as of its status; a person\'s and one on done work are not',
    rows.map((r) => `${r.text}=${r.blocked}:${r.blocked_task_status}`).join('|') === '[BLOCKED] Which date?=true:in_progress|[BLOCKED] long ago=false:null|[blocked] me too=false:null', rows);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql (fresh equals upgraded)', diff.length === 0, diff.slice(0, 10));
  // The previous release's code: a plain insert and an edit still work.
  const edited = await old.query('UPDATE pm.task_comments SET text = text || \'!\' WHERE user_id = $1', [agent]).then(() => true, (e: Error) => e.message);
  check('compatibility: the previous release inserts and edits comments as before', edited === true, edited);
  await old.close();

  const fq = async <T = Loose>(sql: string, params: unknown[] = []) => (await fresh.query<T>(sql, params)).rows;
  const fns = await fq<{ f: string; anon: boolean; member: boolean; service: boolean }>(`
    SELECT p.oid::regprocedure::text AS f, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS member, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('my_blocked_comments', 'notification_view_count')`);
  const mine = fns.find((f) => f.f.startsWith('pm.my_blocked_comments'));
  const count = fns.find((f) => f.f.startsWith('pm.notification_view_count'));
  check('database: members run my_blocked_comments (it answers only their own); the view count is server only; anon runs neither',
    !!mine && !mine.anon && mine.member && mine.service && !!count && !count.anon && !count.member && count.service, fns);
  await fresh.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

const LOGINS = { olivia: uid(9101), pat: uid(9102), sam: uid(9103), mia: uid(9104) };

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
  const member = async (name: string, role: string, login?: string) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@studio.example`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login, `${name.toLowerCase()}@studio.example`]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login, id]);
    }
    return id;
  };
  const olivia = await member('Olivia', 'owner', LOGINS.olivia);
  const pat = await member('Pat', 'member', LOGINS.pat);
  const sam = await member('Sam', 'member', LOGINS.sam);
  const mia = await member('Mia', 'member', LOGINS.mia);
  const quill = await member('Quill', 'agent');
  const scout = await member('Scout', 'agent');
  // Mia owns Quill: she manages it without being an Owner.
  await q('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2)', [quill, mia]);
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Website relaunch') RETURNING id"))[0].id;
  for (const m of [pat, sam, quill, scout]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [project, m]);
  const task = async (title: string, assignees: string[], createdBy: string | null = null) => {
    const id = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, created_by) VALUES ($1, $2, 'in_progress', $3) RETURNING id", [project, title, createdBy]))[0].id;
    for (const m of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, k, 'api', 'allow' FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  return {
    q, olivia, pat, sam, mia, quill, scout, project, task,
    keys: { quill: await key(quill, ['tasks.read']), pat: await key(pat, ['tasks.read']), olivia: await key(olivia, ['notifications.manage_own']) },
  };
}

// ── Pure ─────────────────────────────────────────────────────────────────

function pureChecks() {
  // Approve waits until every detail row has been on screen.
  const short = { details: { amount: '$1,200', to: 'Crest Financial' } };
  const many = { details: Object.fromEntries(Array.from({ length: APPROVAL_DETAIL_ROWS_MAX + 4 }, (_, i) => [`line_${i + 1}`, `$${(i + 1) * 10}`])) };
  const long = { details: { body: 'x'.repeat(5000) } };
  check('approval: a short list is ready to approve at once', approvalReady(short, false) && !approvalDetailRows(short).truncated);
  check(`approval: ${APPROVAL_DETAIL_ROWS_MAX + 4} rows are cut to ${APPROVAL_DETAIL_ROWS_MAX} on the card, and Approve waits until Show all`,
    approvalDetailRows(many).hidden === 4 && !approvalReady(many, false) && approvalReady(many, true));
  check('approval: one shortened value also waits until it is read whole', !approvalReady(long, false) && approvalReady(long, true));
  check('approval: Show all lists every row whole', approvalDetailRows(many, { all: true }).rows.length === APPROVAL_DETAIL_ROWS_MAX + 4
    && approvalDetailRows(long, { all: true }).rows[0].value.length === 5000);
  const card = readFileSync(join(SRC, 'components/questions/QuestionCard.tsx'), 'utf8');
  const approves = card.match(/answer\('approve'\)\}[^>]*>/g) ?? [];
  check('approval: the card never says "N more not shown" under a live Approve, and every Approve is gated on seeing every row',
    !card.includes('more not shown') && approves.length >= 2 && card.includes("if (decide === 'approve' && !readyToApprove) return;")
      && card.includes('disabled={!!busy || offFor(\'approve\') || !readyToApprove}') && card.includes('Read all {detailCount} and approve'), approves);

  // Words.
  const now = Date.parse('2026-11-27T12:00:00Z');
  check('wait: "Waiting on you 6 h"', waitedWords('2026-11-27T06:00:00Z', now) === 'Waiting on you 6 h' && waitedWords('2026-11-27T11:59:30Z', now) === 'Waiting on you now', waitedWords('2026-11-27T06:00:00Z', now));
  check('page: one line, each count once', notificationsSummary(3, 2) === '3 need you, 2 unread' && notificationsSummary(1, 0) === '1 needs you' && notificationsSummary(0, 0) === 'You are all caught up'
    && bellCountLabel(0, 0) === 'Nothing new' && notificationsView('updates') === 'updates' && notificationsView('x') === 'needs');

  // One Needs you: every surface reads useAiHub (on useNeedsYou); the bell counts it plus unread Updates.
  const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
  const page = read('app/(protected)/notifications/page.tsx');
  const bell = read('components/notifications/BellPopover.tsx');
  const sidebar = read('components/layout/Sidebar.tsx');
  check('one Needs you: the page and the bell list the AI hub\'s items with the one NeedsYouView, none computes its own',
    page.includes('useAiHub()') && page.includes('items={hub.all}') && bell.includes('items={needs}') && sidebar.includes('hub={aiHub}')
      && ![page, bell, sidebar].some((src) => src.includes('computeNeedsYou(')));
  check('one count: the bell is what needs you plus unread Updates, once each', sidebar.includes('const bellCount = aiHub.all.length + unreadNotifications;'));
  check('one Needs you: blocked comments come from the database (or the demo\'s mirror) into computeNeedsYou, not a second list',
    read('lib/use-needs-you.ts').includes('blockedComments,') && !read('lib/use-ai-hub.ts').includes('blockedComments('));
  check('MCP: add_task_comment takes blocked, and list_notifications takes before and view unread', (() => {
    const comment = tools.find((t) => t.name === 'add_task_comment');
    const list = tools.find((t) => t.name === 'list_notifications');
    return !!comment?.input.safeParse({ task_id: uid(1), text: 'x', blocked: true }).success
      && !!list?.input.safeParse({ view: 'unread', before: '2026-11-27T00:00:00Z|' + uid(2) }).success;
  })());
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const comment = async (taskId: string, by: string, text: string, extra: { blocked?: boolean; at?: string } = {}) =>
    (await s.q<{ id: string; blocked: boolean }>(`INSERT INTO pm.task_comments (task_id, user_id, text, blocked, created_at) VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now())) RETURNING id, blocked`,
      [taskId, by, text, extra.blocked ?? false, extra.at ?? null]))[0];
  const seen = async (login: string | null) => {
    await actAs(db, login);
    const rows = (await db.query<{ comment_id: string; task_id: string }>('SELECT comment_id, task_id FROM pm.my_blocked_comments()')).rows;
    await db.exec('RESET ROLE');
    return rows.map((r) => r.comment_id);
  };

  // Blocked is an agent's alone.
  const t1 = await s.task('Hero copy', [s.pat], s.sam);
  const flagged = await comment(t1, s.quill, 'Which launch date: May 12 or May 19?', { blocked: true, at: '2026-11-27T06:00:00Z' });
  const personTry = await comment(t1, s.pat, '[BLOCKED] I cannot either', { blocked: true, at: '2026-11-27T05:00:00Z' });
  const t2 = await s.task('Pricing table', []);
  const prefixed = await comment(t2, s.quill, '[BLOCKED] Need the staging password', { at: '2026-11-27T07:00:00Z' });
  const stamped = await s.q<{ blocked: boolean; blocked_task_status: string }>('SELECT blocked, blocked_task_status FROM pm.task_comments WHERE id = $1', [flagged.id]);
  check('blocked: an agent\'s flag holds, with the task\'s status kept', flagged.blocked && stamped[0]?.blocked_task_status === 'in_progress', stamped);
  check('blocked: a person\'s comment is never blocked, flag or prefix', !personTry.blocked);
  check('blocked: an agent\'s "[BLOCKED]" start counts as the flag', prefixed.blocked);
  await actAs(db, LOGINS.pat);
  const forged = await db.query('UPDATE pm.task_comments SET blocked = true WHERE id = $1 RETURNING blocked', [personTry.id]).then((r) => (r.rows[0] as Loose)?.blocked, (e: Error) => e.message);
  await db.exec('RESET ROLE');
  check('blocked: a person cannot mark their own comment blocked afterwards', forged === false, forged);

  // Who sees it.
  check('audience: the Owner (manages every agent) sees both', (await seen(LOGINS.olivia)).sort().join() === [flagged.id, prefixed.id].sort().join());
  check('audience: the agent\'s owner sees both', (await seen(LOGINS.mia)).length === 2);
  check('audience: the task\'s assignee sees the one on their task', (await seen(LOGINS.pat)).join() === flagged.id);
  check('audience: whoever made the task sees it; someone on neither task sees nothing', (await seen(LOGINS.sam)).join() === flagged.id);
  await s.q('DELETE FROM pm.task_assignees WHERE task_id = $1', [t1]);
  check('audience: off the task, the assignee no longer sees it', (await seen(LOGINS.pat)).length === 0);
  await s.q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [t1, s.pat]);
  check('nobody signed in: nothing', (await seen(null)).length === 0);

  // The browser's mirror agrees with the database on the same comments.
  const asTasks = async (): Promise<Task[]> => {
    const tasks = await s.q<Loose>('SELECT id, title, status, project_id FROM pm.tasks WHERE deleted_at IS NULL');
    const comments = await s.q<Loose>('SELECT id, task_id, user_id, text, blocked, blocked_task_status, created_at FROM pm.task_comments WHERE deleted_at IS NULL');
    return tasks.map((t: Loose) => ({ ...t, assignee_ids: [], comments: comments.filter((c: Loose) => c.task_id === t.id).map((c: Loose) => ({ ...c, created_at: new Date(c.created_at).toISOString() }) as Comment) }) as Task);
  };
  const team = [{ id: s.olivia, role: 'owner', name: 'Olivia' }, { id: s.pat, role: 'member', name: 'Pat' }, { id: s.sam, role: 'member', name: 'Sam' }, { id: s.mia, role: 'member', name: 'Mia' }, { id: s.quill, role: 'agent', name: 'Quill' }, { id: s.scout, role: 'agent', name: 'Scout' }] as Pick<TeamMember, 'id' | 'role' | 'name'>[];
  const agree = async (label: string) => {
    const mirror = blockedCommentSignals(await asTasks(), team).map((b) => b.comment_id).sort().join();
    const database = (await seen(LOGINS.olivia)).sort().join();
    check(`mirror: the demo's blocked comments match the database's (${label})`, mirror === database, { mirror, database });
  };
  await agree('two blocked');

  // Needs you lists it as one blocked row on its task, waiting since the comment.
  const signals = (await (async () => { await actAs(db, LOGINS.olivia); const r = (await db.query<BlockedCommentSignal>('SELECT * FROM pm.my_blocked_comments()')).rows; await db.exec('RESET ROLE'); return r; })())
    .map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
  const tasks = (await asTasks()).map((t) => ({ ...t, assignee_ids: [], subtasks: [], tags: [] }) as unknown as Task);
  const items = computeNeedsYou({ tasks, suggestions: [], projects: [], teamMemberId: s.olivia, includeSuggestions: false, oversight: true, blockedComments: signals });
  const row = items.find((i) => i.commentId === flagged.id);
  check('Needs you: each blocked comment is one blocked row on its task, from its agent, waiting since the comment', items.filter((i) => i.kind === 'blocked').length === 2
    && row?.task?.id === t1 && row.agentId === s.quill && row.since === '2026-11-27T06:00:00.000Z' && row.question === 'Which launch date: May 12 or May 19?', items);
  const twice = computeNeedsYou({ tasks, suggestions: [], projects: [], teamMemberId: s.olivia, includeSuggestions: false, oversight: true, blockedComments: [...signals, { ...signals[0], comment_id: randomUUID() }] });
  check('Needs you: two blocked comments on one task are one row', twice.filter((i) => i.kind === 'blocked').length === 2);

  // When it leaves.
  await comment(t1, s.scout, 'I can draft the rest meanwhile.', { at: '2026-11-27T06:30:00Z' });
  check('clears: another agent writing does not answer it', (await seen(LOGINS.olivia)).includes(flagged.id));
  await comment(t1, s.pat, 'May 19, as the client said.', { at: '2026-11-27T07:30:00Z' });
  check('clears: a person replying answers it', !(await seen(LOGINS.olivia)).includes(flagged.id));
  await agree('one answered');
  const again = await comment(t1, s.quill, '[BLOCKED] And the hero image?', { at: '2026-11-27T08:00:00Z' });
  check('a new block after the reply is its own item', (await seen(LOGINS.olivia)).includes(again.id));
  await comment(t1, s.quill, 'Found it in the brand folder.', { at: '2026-11-27T08:10:00Z' });
  check('clears: the agent writing again ends its block', !(await seen(LOGINS.olivia)).includes(again.id));
  await s.q("UPDATE pm.tasks SET status = 'in_review' WHERE id = $1", [t2]);
  check('clears: the task moving on ends it', !(await seen(LOGINS.olivia)).includes(prefixed.id));
  await agree('moved');
  await s.q("UPDATE pm.tasks SET status = 'in_progress' WHERE id = $1", [t2]);
  check('back in the status it had: still waiting (nothing answered it)', (await seen(LOGINS.olivia)).includes(prefixed.id));
  await s.q("INSERT INTO pm.workspace_modules (module_id, enabled) VALUES ('agents', false) ON CONFLICT (module_id) DO UPDATE SET enabled = false");
  check('AI agents off: nothing', (await seen(LOGINS.olivia)).length === 0);
  await s.q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'agents'");
  await s.q('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [t2]);
  check('clears: the task in Trash ends it', !(await seen(LOGINS.olivia)).includes(prefixed.id));

  // Updates: the count the page pages over.
  for (let i = 0; i < 5; i++) await s.q("SELECT pm.upsert_notification($1, $2, 'm', NULL, 'task', $3, 'task_comments')", [s.olivia, `Update ${i}`, randomUUID()]);
  await s.q("SELECT pm.upsert_notification($1, 'Question from Quill', 'm', NULL, 'question', $2, 'question_asked')", [s.olivia, randomUUID()]);
  const ids = (await s.q<{ id: string }>("SELECT id FROM pm.team_member_notifications WHERE user_id = $1 AND category = 'task_comments' ORDER BY title", [s.olivia])).map((r) => r.id);
  await s.q('UPDATE pm.team_member_notifications SET done_at = now() WHERE id = $1', [ids[0]]);
  await s.q('UPDATE pm.team_member_notifications SET is_read = true WHERE id = $1', [ids[1]]);
  await s.q("INSERT INTO pm.member_snoozes (member_id, item_kind, item_id, until) VALUES ($1, 'notification', $2, now() + interval '1 day')", [s.olivia, ids[2]]);
  const counts = await s.q<{ v: string; n: number }>("SELECT v, pm.notification_view_count($1, v) AS n FROM unnest(ARRAY['updates', 'unread', 'done']) AS v", [s.olivia]);
  const feed = await s.q<{ v: string; n: number }>("SELECT v, (SELECT count(*)::int FROM pm.notification_feed($1, v, 100)) AS n FROM unnest(ARRAY['updates', 'unread', 'done']) AS v", [s.olivia]);
  check('count: each view\'s count is the rows its feed lists (receipts, done and snoozed apart)', JSON.stringify(counts) === JSON.stringify(feed)
    && counts.map((c) => c.n).join() === '3,2,1', { counts, feed });

  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const commentsRoute = await import('../src/app/api/v1/tasks/[id]/comments/route');
    const listRoute = await import('../src/app/api/v1/notifications/route');
    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json().catch(() => null) as Loose };
    };
    const t3 = await s.task('Footer links', [s.pat, s.quill]);
    const byAgent = await call(commentsRoute.POST, 'POST', `/api/v1/tasks/${t3}/comments`, { id: t3 }, s.keys.quill, { user_id: s.quill, text: 'Need the footer copy from the client', blocked: true });
    check('REST: an agent\'s comment with blocked: true is blocked, and lands in Needs you', byAgent.status === 201 && byAgent.body?.data?.blocked === true
      && (await seen(LOGINS.pat)).includes(byAgent.body?.data?.id), byAgent);
    const byPerson = await call(commentsRoute.POST, 'POST', `/api/v1/tasks/${t3}/comments`, { id: t3 }, s.keys.pat, { user_id: s.pat, text: 'Me too', blocked: true });
    check('REST: a person\'s key asking for blocked is refused (422 blocked_agents_only), nothing written', byPerson.status === 422 && byPerson.body?.error?.details?.reason === 'blocked_agents_only'
      && (await s.q('SELECT 1 FROM pm.task_comments WHERE task_id = $1 AND user_id = $2', [t3, s.pat])).length === 0, byPerson);
    const plain = await call(commentsRoute.POST, 'POST', `/api/v1/tasks/${t3}/comments`, { id: t3 }, s.keys.pat, { user_id: s.pat, text: 'Sending it today' });
    check('REST: a person\'s plain reply answers the block', plain.status === 201 && plain.body?.data?.blocked === false && !(await seen(LOGINS.pat)).includes(byAgent.body?.data?.id), plain);

    // Keyset paging: two at a time over the 3 open Updates, then the cursor ends.
    const first = await call(listRoute.GET, 'GET', '/api/v1/notifications?view=updates&limit=2', {}, s.keys.olivia);
    const cursor = first.body?.meta?.next_cursor;
    const second = cursor ? await call(listRoute.GET, 'GET', `/api/v1/notifications?view=updates&limit=2&before=${encodeURIComponent(cursor)}`, {}, s.keys.olivia) : null;
    const seenIds = [...(first.body?.data ?? []), ...(second?.body?.data ?? [])].map((n: Loose) => n.id);
    check('REST: view=updates pages on by meta.next_cursor (before), each row once, snoozed and done left out, then no cursor',
      first.status === 200 && !!cursor && second?.status === 200 && seenIds.length === 3 && new Set(seenIds).size === 3
        && !seenIds.includes(ids[0]) && !seenIds.includes(ids[2]) && second.body.meta.next_cursor === null, { first: first.body, second: second?.body });
    const unread = await call(listRoute.GET, 'GET', '/api/v1/notifications?view=unread', {}, s.keys.olivia);
    check('REST: view=unread lists open Updates not read (receipts left out)', unread.status === 200 && unread.body?.data?.every((n: Loose) => !n.is_read && !n.done_at && n.category !== 'question_asked')
      && unread.body?.meta?.total === 3, unread.body?.meta);
    const mixed = await call(listRoute.GET, 'GET', `/api/v1/notifications?view=updates&category=task_comments&before=${encodeURIComponent(cursor ?? 'x')}`, {}, s.keys.olivia);
    const noView = await call(listRoute.GET, 'GET', `/api/v1/notifications?before=${encodeURIComponent(cursor ?? 'x')}`, {}, s.keys.olivia);
    const junk = await call(listRoute.GET, 'GET', '/api/v1/notifications?view=done&before=nonsense', {}, s.keys.olivia);
    check('REST: before with a filter, without a view, or not a cursor is a plain 400', mixed.status === 400 && noView.status === 400 && junk.status === 400, [mixed.status, noView.status, junk.status]);
    const all = await call(listRoute.GET, 'GET', '/api/v1/notifications', {}, s.keys.olivia);
    check('REST: without a view the list answers as before (page meta, no cursor)', all.status === 200 && all.body?.meta?.total === 6 && !('next_cursor' in all.body.meta), all.body?.meta);
  } finally {
    await server.close();
    await db.close();
  }
}

main().then(() => {
  if (failures.length) {
    console.error(`notifications-center: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  console.log(`notifications-center: all ${passed} checks passed`);
}, (error) => {
  console.error(error);
  process.exit(1);
});
