/**
 * Notifications delivery (20261127003500_notifications_delivery.sql), over
 * the real schema on PGlite, the real routes and supabase-js (a fake
 * PostgREST), a stub mailer and every Telegram call mocked:
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   its functions are server only; the queue is closed to members.
 * - The kind a notice is chosen by: the database and the app agree
 *   (needs_you for a notice announcing a Needs you item).
 * - Raising a notice queues email and chat as the person chose: nothing
 *   while a channel is off; needs_you on by default once it is on; other
 *   kinds only when chosen; invoice drafts never by email (the morning
 *   summary sends those); never to an agent; raised again while one waits,
 *   still one.
 * - The one delivery point: email through the mailer, chat as a DM from the
 *   workspace bot to the person's own linked account with a link back; a
 *   notice read first is skipped; no email set up or no linked chat is
 *   skipped and says why; a failure is tried again after 1 and 5 minutes,
 *   then left failed. App notices (deliverTeamNotice) go through it too.
 * - Settings > Notifications over REST and MCP: chat and needs_you, 409
 *   chat_not_linked and email_not_set_up.
 * - The API's offset list of Updates lists what the app lists: snoozed
 *   notices and a blocked comment's notice left out, the total to match.
 * - One Needs you look, and a broken assistant is never "Needs you".
 *
 *   npm run -s test:notifications-delivery
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { chatHttp } from '../src/lib/chat/providers/adapter';
import { DELIVERY_KEYS, deliveryKeyOf, NOTIFICATION_CATEGORY_KEYS, updateDelivers } from '../src/lib/notification-defaults';
import { chatLine } from '../src/lib/notification-delivery';
import { RECEIPT_CATEGORIES } from '../src/lib/notifications';
import { PM_TOOLS } from '../src/lib/mcp/tools';

const MIGRATION = '20261127003500_notifications_delivery.sql';
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- NOTIFICATIONS DELIVERY (20261127003500_notifications_delivery.sql)\n-- ============================================================\n';
const SRC = join(__dirname, '..', 'src');
const APP_KEY = 'e'.repeat(64);
const TELEGRAM_TOKEN = '777000333:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDtest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

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
  const member = (await old.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old', 'old@example.com', 'member') RETURNING id")).rows[0].id;
  await applyMigrationsFrom(old, MIGRATION);
  const kept = (await old.query<Loose>('SELECT chat_notifications_enabled, chat_notification_prefs FROM pm.team_members WHERE id = $1', [member])).rows[0];
  check('upgrade: people start with chat off and no chat choices', kept?.chat_notifications_enabled === false && JSON.stringify(kept?.chat_notification_prefs) === '{}', kept);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql (fresh equals upgraded)', diff.length === 0, diff.slice(0, 10));
  await old.close();
  const fns = (await fresh.query<{ f: string; anon: boolean; member: boolean; service: boolean }>(`
    SELECT p.proname AS f, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS member, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname IN ('notification_pref_key', 'claim_notification_deliveries',
      'complete_notification_delivery', 'notification_updates_list', 'blocked_comments_for', 'notification_announces_block', 'notification_delivery_kick')`)).rows;
  const kick = fns.find((f) => f.f === 'notification_delivery_kick');
  check('database: the new functions are server only; the cron kick runs for nobody but its owner', fns.length === 7
    && fns.filter((f) => f.f !== 'notification_delivery_kick').every((f) => !f.anon && !f.member && f.service) && !!kick && !kick.member && !kick.service, fns);
  const grants = (await fresh.query<{ grantee: string }>(`SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'pm' AND table_name = 'notification_deliveries' AND grantee IN ('anon', 'authenticated')`)).rows;
  check('database: members and anon hold nothing on the delivery queue', grants.length === 0, grants);
  const samples = [...NOTIFICATION_CATEGORY_KEYS, ...RECEIPT_CATEGORIES, 'agent_message', 'reminder', 'webhook_failing', 'question_expired', 'general'];
  const sql = (await fresh.query<{ c: string; k: string | null }>('SELECT c, pm.notification_pref_key(c) AS k FROM unnest($1::text[]) AS c', [samples])).rows;
  const mismatched = sql.filter((row) => row.k !== deliveryKeyOf(row.c));
  check('kinds: pm.notification_pref_key and deliveryKeyOf agree; a Needs you notice is needs_you; others go only to the app', mismatched.length === 0
    && deliveryKeyOf('question_asked') === 'needs_you' && deliveryKeyOf('agent_message') === null && DELIVERY_KEYS[0] === 'needs_you', mismatched);
  await fresh.close();
}

// ── Pure and source ──────────────────────────────────────────────────────

function pureChecks() {
  check('chat: one line, the title then what the message adds', chatLine('Question from Quill', 'Which date?\nMore here') === 'Question from Quill: Which date?'
    && chatLine('New comment on "Hero"', null) === 'New comment on "Hero"' && chatLine('x'.repeat(700), null).length === 600);
  const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
  const notice = read('lib/api/team-notice.ts');
  check('one delivery point: app notices queue and are sent by deliverDueNotifications, never mailed on their own', notice.includes('deliverDueNotifications(')
    && !notice.includes('sendTransactional('));
  const outbound = read('lib/chat/outbound.ts');
  check('chat: the system path takes the person from the queue, reuses verified identities and the per-recipient limit; agents still start their own',
    outbound.includes('export async function sendSystemChatNotice') && /sendSystemChatNotice[\s\S]*identityOn\([\s\S]*`out:to:member:\$\{personId\}`, CHAT_SEND_RECIPIENT_LIMIT/.test(outbound)
      && outbound.includes("if (caller.access.role !== 'agent') throw forbidden('Only an agent starts a chat conversation'"));
  check('N2: a broken assistant reads "Not working", never "Needs you"', read('components/settings/assistants/AssistantStatusSection.tsx').includes("broken: { label: 'Not working'"));
  check('N2: My Tasks says "Needs you" and draws questions with the same row as the AI home, the bell and the page',
    read('app/(protected)/my-tasks/page.tsx').includes("title: 'Needs you',") && read('app/(protected)/my-tasks/page.tsx').includes('variant="hub" place onOpenTask={setViewingTaskId}'));
  const myTasks = read('app/(protected)/my-tasks/page.tsx');
  check('N2: My Tasks draws stuck agent work and agent work to review with the one Needs you row, never as a second task row',
    myTasks.includes('<NeedsYouView needs={needsState.agents} items={hubRows}') && myTasks.includes("if (item.kind !== 'due' && hubTaskIds.has(task.id)) return null;"));
  check('N2: every Needs you count in the sidebar takes one tone', !/tone: aiHub\.all\.length > 0 \? 'danger'/.test(read('components/layout/Sidebar.tsx')));
  const update = PM_TOOLS.find((t) => t.name === 'update_notification_preferences')!;
  check('MCP: update_notification_preferences takes chat_enabled, chat and needs_you', update.input.safeParse({ chat_enabled: true, chat: { needs_you: false, task_comments: true } }).success
    && update.input.safeParse({ email: { needs_you: false } }).success && !update.input.safeParse({ in_app: { needs_you: false } }).success);
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string) => (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id',
    [name, `${name.toLowerCase()}@studio.example`, role]))[0].id;
  const olivia = await member('Olivia', 'owner');
  const pat = await member('Pat', 'member');
  const sam = await member('Sam', 'member');
  const quill = await member('Quill', 'agent');
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Website relaunch') RETURNING id"))[0].id;
  const task = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status) VALUES ($1, 'Hero copy', 'in_progress') RETURNING id", [project]))[0].id;
  await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [task, pat]);
  const key = async (memberId: string) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, ['notifications.manage_own']]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      VALUES ($1, 'notifications.manage_own', 'api', 'allow') ON CONFLICT DO NOTHING`, [memberId]);
    return secret;
  };
  return { q, olivia, pat, sam, quill, project, task, keys: { pat: await key(pat), sam: await key(sam) } };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com', APP_ENCRYPTION_KEY: APP_KEY,
  });
  const telegram: { url: string; body: Loose }[] = [];
  chatHttp.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    telegram.push({ url, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { sealCredentials } = await import('../src/lib/chat/connections');
    const { deliverDueNotifications } = await import('../src/lib/notification-delivery');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const prefsRoute = await import('../src/app/api/v1/me/notification-preferences/route');
    const listRoute = await import('../src/app/api/v1/notifications/route');
    const deliverRoute = await import('../src/app/api/internal/notifications/deliver/route');
    const service = getServiceClient();
    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, apiKey: string, body?: unknown) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve({}) } as never);
      return { status: response.status, body: await response.json().catch(() => null) as Loose };
    };
    const raise = (member: string, title: string, entityType: string, entityId: string, category: string) =>
      s.q('SELECT pm.upsert_notification($1, $2, $3, $4, $5, $6, $7)', [member, title, `${title} in full`, '/projects/x', entityType, entityId, category]);
    const queue = async (member: string) => s.q<{ channel: string; status: string; title: string }>(`SELECT d.channel, d.status, n.title FROM pm.notification_deliveries d
      JOIN pm.team_member_notifications n ON n.id = d.notification_id WHERE d.member_id = $1 ORDER BY d.created_at, d.channel`, [member]);
    const mail: { to: string; subject: string; html: string }[] = [];
    let mailAnswer: { success: boolean; error?: string } = { success: true };
    const mailer = async (message: { to: string; subject: string; html: string; text: string }) => {
      mail.push(message);
      return mailAnswer;
    };

    // Preferences: chat needs a linked account; email needs sending set up.
    const before = await call(prefsRoute.GET, 'GET', '/api/v1/me/notification-preferences', s.keys.pat);
    check('preferences: chat and needs_you are listed; chat off and unreachable until a chat account is linked; needs_you on by default for email and chat',
      before.status === 200 && before.body.data.chat_enabled === false && before.body.data.chat_available === false
        && before.body.data.email.needs_you === true && before.body.data.chat.needs_you === true && before.body.data.chat.task_comments === false, before.body);
    const noChat = await call(prefsRoute.PATCH, 'PATCH', '/api/v1/me/notification-preferences', s.keys.pat, { chat_enabled: true });
    check('preferences: turning chat on with no linked account is 409 chat_not_linked', noChat.status === 409 && noChat.body?.error?.details?.reason === 'chat_not_linked', noChat.body);
    const noMail = await call(prefsRoute.PATCH, 'PATCH', '/api/v1/me/notification-preferences', s.keys.pat, { email_enabled: true });
    check('preferences: turning email on with no sending set up is 409 email_not_set_up', noMail.status === 409 && noMail.body?.error?.details?.reason === 'email_not_set_up', noMail.body);

    // Nothing queues while both are off.
    await raise(s.pat, 'Question from Quill', 'question', randomUUID(), 'question_asked');
    check('queue: with email and chat off, nothing is queued (the notice is only in the app)', (await queue(s.pat)).length === 0);

    // Set up email sending and a Telegram bot Pat linked.
    await s.q(`INSERT INTO pm.smtp_accounts (label, host, username, encrypted_password, from_name, from_email, is_default)
      VALUES ('Main', 'smtp.example.com', 'u', 'x', 'Studio', 'hello@studio.example', true)`);
    const connection = (await s.q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials, kind, enabled) VALUES ('telegram', 'Studio bot', 'pm1:pending', 'company', true) RETURNING id"))[0].id;
    await s.q('UPDATE pm.chat_connections SET credentials = $1 WHERE id = $2', [sealCredentials(connection, { bot_token: TELEGRAM_TOKEN } as never), connection]);
    await s.q("INSERT INTO pm.member_identities (member_id, provider, external_id, verified_at, verified_method) VALUES ($1, 'telegram', '5550001', now(), 'link')", [s.pat]);
    const on = await call(prefsRoute.PATCH, 'PATCH', '/api/v1/me/notification-preferences', s.keys.pat, { email_enabled: true, chat_enabled: true });
    check('preferences: with sending set up and a linked account, email and chat turn on', on.status === 200 && on.body.data.email_enabled && on.body.data.chat_enabled
      && on.body.data.chat_available && on.body.data.email_available, on.body);

    // What queues.
    await raise(s.pat, 'Approval request from Quill', 'question', randomUUID(), 'approval_requested');
    await raise(s.pat, 'New comment on "Hero copy"', 'task', s.task, 'task_comments');
    await raise(s.pat, '2 invoices are ready', 'invoice', randomUUID(), 'invoice_drafts');
    await raise(s.quill, 'Question for the agent', 'question', randomUUID(), 'question_asked');
    const queued = await queue(s.pat);
    check('queue: Needs you goes by email and chat by default; a comment only when chosen; never to an agent',
      queued.map((r) => `${r.channel}:${r.title}`).join('|') === 'chat:Approval request from Quill|email:Approval request from Quill'
        && (await queue(s.quill)).length === 0, queued);
    await call(prefsRoute.PATCH, 'PATCH', '/api/v1/me/notification-preferences', s.keys.pat, { email: { task_comments: true, invoice_drafts: true }, chat: { needs_you: false } });
    await raise(s.pat, 'New comment on "Hero copy"', 'task', s.task, 'task_comments');
    await raise(s.pat, '3 invoices are ready', 'invoice', randomUUID(), 'invoice_drafts');
    await raise(s.pat, 'Question from Quill again', 'question', randomUUID(), 'question_asked');
    const chosen = (await queue(s.pat)).slice(2);
    check('queue: a chosen comment goes by email; invoice drafts never by email (the morning summary); needs_you off in chat stays off',
      chosen.map((r) => `${r.channel}:${r.title}`).join('|') === 'email:New comment on "Hero copy"|email:Question from Quill again', chosen);
    await raise(s.pat, 'New comment on "Hero copy"', 'task', s.task, 'task_comments');
    check('queue: raised again while one waits, still one', (await queue(s.pat)).filter((r) => r.title === 'New comment on "Hero copy"').length === 1);

    // Read in the app first: skipped, not sent.
    await s.q("UPDATE pm.team_member_notifications SET is_read = true WHERE user_id = $1 AND title = 'Question from Quill again'", [s.pat]);

    // The delivery point.
    const run = await deliverDueNotifications(service, { mailer });
    const after = await queue(s.pat);
    const chats = await s.q<Loose>("SELECT direction, status, initiated, agent_id, member_id, text FROM pm.chat_messages WHERE connection_id = $1", [connection]);
    const sentMessage = telegram.find((t) => t.url.includes('sendMessage'));
    check('deliver: email through the mailer to the person, chat as a DM to their own linked account, a notice read first skipped',
      run.sent.email === 2 && run.sent.chat === 1 && run.claimed === 3 && mail.map((m) => m.to).every((to) => to === 'pat@studio.example')
        && after.filter((r) => r.status === 'sent').length === 3 && after.find((r) => r.title === 'Question from Quill again')?.status === 'skipped', { run, after, mail: mail.map((m) => m.subject) });
    check('deliver: the chat is one line and a link back to the app, recorded as the app\'s own (no agent)', !!sentMessage && String(sentMessage.body.chat_id) === '5550001'
      && JSON.stringify(sentMessage.body).includes('Approval request from Quill') && JSON.stringify(sentMessage.body).includes('https://pm.example.com/projects/x')
      && chats.length === 1 && chats[0].direction === 'outbound' && chats[0].initiated === true && chats[0].agent_id === null && chats[0].member_id === s.pat, { sentMessage, chats });
    check('deliver: the email carries the title and an absolute link', mail.some((m) => m.subject === 'Approval request from Quill' && m.html.includes('https://pm.example.com/projects/x')));

    // Failures: tried again after a minute, then five, then left failed.
    mailAnswer = { success: false, error: 'SMTP said no' };
    await raise(s.pat, 'Another approval', 'question', randomUUID(), 'approval_requested');
    await deliverDueNotifications(service, { mailer });
    const firstFail = (await s.q<Loose>("SELECT status, attempts, next_attempt_at > now() + interval '50 seconds' AS later FROM pm.notification_deliveries d JOIN pm.team_member_notifications n ON n.id = d.notification_id WHERE n.title = 'Another approval'"))[0];
    await s.q("UPDATE pm.notification_deliveries SET next_attempt_at = now() WHERE status = 'pending'");
    await deliverDueNotifications(service, { mailer });
    await s.q("UPDATE pm.notification_deliveries SET next_attempt_at = now() WHERE status = 'pending'");
    await deliverDueNotifications(service, { mailer });
    const lastFail = (await s.q<Loose>("SELECT status, attempts, last_error FROM pm.notification_deliveries d JOIN pm.team_member_notifications n ON n.id = d.notification_id WHERE n.title = 'Another approval'"))[0];
    check('deliver: a failed email is tried again a minute later, then left failed after the third try, saying why', firstFail?.status === 'pending' && firstFail?.attempts === 1 && firstFail?.later === true
      && lastFail?.status === 'failed' && lastFail?.attempts === 3 && lastFail?.last_error === 'SMTP said no', { firstFail, lastFail });
    mailAnswer = { success: false, error: 'No email accounts configured' };
    await raise(s.pat, 'Third approval', 'question', randomUUID(), 'approval_requested');
    await deliverDueNotifications(service, { mailer });
    const unset = (await s.q<Loose>("SELECT status, last_error FROM pm.notification_deliveries d JOIN pm.team_member_notifications n ON n.id = d.notification_id WHERE n.title = 'Third approval'"))[0];
    check('deliver: with no email account it is skipped and says so, never retried', unset?.status === 'skipped' && unset?.last_error === 'Email sending is not set up', unset);

    // Someone with chat on but no linked account any more.
    await s.q("UPDATE pm.team_members SET chat_notifications_enabled = true, email_notifications_enabled = false WHERE id = $1", [s.sam]);
    await raise(s.sam, 'Question for Sam', 'question', randomUUID(), 'question_asked');
    await deliverDueNotifications(service, { mailer });
    const samRow = (await queue(s.sam))[0];
    const samWhy = (await s.q<Loose>('SELECT last_error FROM pm.notification_deliveries WHERE member_id = $1', [s.sam]))[0];
    check('deliver: no linked chat is skipped and says so', samRow?.status === 'skipped' && samWhy?.last_error === 'No linked chat account', { samRow, samWhy });

    // The cron route needs the scheduler secret.
    const denied = await deliverRoute.POST(new Request('http://localhost/api/internal/notifications/deliver', { method: 'POST' }));
    check('route: the scheduled delivery route refuses a call without the scheduler secret', denied.status === 404 || denied.status === 401 || denied.status === 503, denied.status);

    // The API's offset list agrees with the app: snoozed and a blocked comment's notice left out.
    await s.q("UPDATE pm.team_members SET email_notifications_enabled = false, chat_notifications_enabled = false WHERE id = $1", [s.pat]);
    await s.q('UPDATE pm.team_member_notifications SET done_at = now() WHERE user_id = $1', [s.pat]);
    await raise(s.pat, 'Plain update', 'project', s.project, 'project_updates');
    await raise(s.pat, 'Snoozed update', 'project', randomUUID(), 'project_updates');
    await s.q("INSERT INTO pm.member_snoozes (member_id, item_kind, item_id, until) SELECT $1, 'notification', id, now() + interval '1 day' FROM pm.team_member_notifications WHERE title = 'Snoozed update'", [s.pat]);
    await s.q("INSERT INTO pm.task_comments (task_id, user_id, text, blocked) VALUES ($1, $2, 'Which launch date?', true)", [s.task, s.quill]);
    await s.q("SELECT pm.upsert_notification($1, 'New comment on \"Hero copy\"', 'Quill: Which launch date?', '/projects/x', 'task', $2, 'task_comments', NULL, $3)", [s.pat, s.task, s.quill]);
    const listed = await call(listRoute.GET, 'GET', '/api/v1/notifications?view=updates', s.keys.pat);
    const unread = await call(listRoute.GET, 'GET', '/api/v1/notifications?view=unread&limit=1&page=2', s.keys.pat);
    const titles = (listed.body?.data ?? []).map((n: Loose) => n.title);
    check('API: view=updates by offset lists what the app lists (snoozed and a blocked comment\'s notice left out), the total to match',
      listed.status === 200 && titles.join() === 'Plain update' && listed.body.meta.total === 1, listed.body);
    check('API: past the last page the total still says how many', unread.status === 200 && unread.body.data.length === 0 && unread.body.meta.total === 1, unread.body);
    await s.q("INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'May 19.')", [s.task, s.pat]);
    const answered = await call(listRoute.GET, 'GET', '/api/v1/notifications?view=updates', s.keys.pat);
    check('API: once answered, the comment notice is listed again', answered.body?.meta?.total === 2, answered.body?.meta);
    // A stored choice that is not true or false never breaks the write that raises a notice.
    await s.q(`UPDATE pm.team_members SET email_notifications_enabled = true, email_notification_prefs = '{"task_comments":"yes","needs_you":1}'::jsonb WHERE id = $1`, [s.sam]);
    const oddRaise = await raise(s.sam, 'Odd choice comment', 'task', randomUUID(), 'task_comments').then(() => 'ok', (e: Error) => e.message);
    const oddQuestion = await raise(s.sam, 'Odd choice question', 'question', randomUUID(), 'question_asked').then(() => 'ok', (e: Error) => e.message);
    const oddQueue = (await queue(s.sam)).filter((row) => row.title.startsWith('Odd choice') && row.channel === 'email');
    check('preferences: a stored choice that is not a boolean never fails the notice; it reads as the default (off, Needs you on)',
      oddRaise === 'ok' && oddQuestion === 'ok' && oddQueue.length === 1 && oddQueue[0].title === 'Odd choice question', { oddRaise, oddQuestion, oddQueue });
    check('preferences: a kind off in the app is off by email and chat too',
      !updateDelivers({ inApp: false, channelOn: true, choice: true }) && updateDelivers({ inApp: true, channelOn: true, choice: true }) && !updateDelivers({ inApp: true, channelOn: false, choice: true }));
  } finally {
    await server.close();
    await db.close();
  }
}

main().then(() => {
  if (failures.length) {
    console.error(`notifications-delivery: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  console.log(`notifications-delivery: all ${passed} checks passed`);
}, (error) => {
  console.error(error);
  process.exit(1);
});
