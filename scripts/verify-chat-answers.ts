/**
 * Answering from chat (20261127004100_chat_answers.sql), over the real
 * schema on PGlite, supabase-js through a fake PostgREST, and every Telegram
 * and Slack call mocked:
 * - The migration, run twice on the schema before it, matches schema.sql;
 *   the token table is closed to members; decided_via takes chat.
 * - A question or approval delivered to a person's chat carries buttons
 *   (Approve and Reject, or its choices); a Telegram connection from before
 *   buttons asks for presses first; an approval with more detail than a
 *   message shows, a draft to review or a written answer gets none.
 * - A press is answered only when: the provider's check passes (Telegram's
 *   secret token, Slack's signature within five minutes), the token exists
 *   on this connection, the presser is the person's own verified account,
 *   and the batch is unused and unexpired. Then it is answered as the person
 *   with their own access (decided_via chat), the message is edited to say
 *   what happened and the press acknowledged.
 * - Replayed, already decided elsewhere ("Already answered by ..."),
 *   permission lost, expired, wrong person: each says so and decides nothing.
 *
 *   npm run -s test:chat-answers
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { chatHttp } from '../src/lib/chat/providers/adapter';

const MIGRATION = '20261127004100_chat_answers.sql';
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const BANNER = '\n-- ============================================================\n-- CHAT ANSWERS (20261127004100_chat_answers.sql)\n-- ============================================================\n';
const APP_KEY = 'd'.repeat(64);
const TELEGRAM_TOKEN = '777000444:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDansw';
const TELEGRAM_SECRET = 's'.repeat(40);
const SLACK_TOKEN = 'xoxb-1-answers';
const SLACK_SECRET = 'f'.repeat(32);

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(BANNER);
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n-- ', at + BANNER.length);
  check('schema.sql: its section is the migration, word for word', at > 0 && SCHEMA_SQL.slice(at + BANNER.length, next < 0 ? undefined : next) === MIGRATION_SQL);
  check('migration: no em or en dash, no job', !MIGRATION_SQL.includes(String.fromCharCode(0x2013)) && !MIGRATION_SQL.includes(String.fromCharCode(0x2014)) && !MIGRATION_SQL.includes('cron.schedule'));
  const later = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f > MIGRATION);
  check('migration: every later migration has its own section after this one', later.every((f) => SCHEMA_SQL.indexOf(`(${f})`, at + BANNER.length) > 0), later);
  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, at) });
  await old.exec('RESET ROLE');
  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql (fresh equals upgraded)', diff.length === 0, diff.slice(0, 10));
  await old.close();
  const grants = (await fresh.query<{ grantee: string }>(`SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'pm' AND table_name = 'chat_answer_tokens' AND grantee IN ('anon', 'authenticated')`)).rows;
  check('database: members and anon hold nothing on answer tokens', grants.length === 0, grants);
  await fresh.close();
}

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await q("INSERT INTO pm.business_settings (business_name) SELECT 'Studio' WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)");
  const member = async (name: string, role: string) => (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id',
    [name, `${name.toLowerCase()}@studio.example`, role]))[0].id;
  const olivia = await member('Olivia', 'owner');
  const pat = await member('Pat', 'member');
  const mia = await member('Mia', 'admin');
  const quill = await member('Quill', 'agent');
  const sam = await member('Sam', 'member');
  await q('UPDATE pm.team_members SET chat_notifications_enabled = true WHERE id = ANY($1)', [[pat, sam]]);
  const { sealCredentials } = await import('../src/lib/chat/connections');
  const connection = async (provider: string, workspace: string | null, credentials: Record<string, string>) => {
    const id = (await q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials, kind, enabled, external_workspace_id) VALUES ($1, 'Studio bot', 'pm1:pending', 'company', true, $2) RETURNING id", [provider, workspace]))[0].id;
    await q('UPDATE pm.chat_connections SET credentials = $1 WHERE id = $2', [sealCredentials(id, credentials as never), id]);
    return id;
  };
  // A Telegram connection from before buttons (no buttons flag), and a Slack one.
  const telegram = await connection('telegram', null, { bot_token: TELEGRAM_TOKEN, secret_token: TELEGRAM_SECRET });
  const slack = await connection('slack', 'T1', { bot_token: SLACK_TOKEN, signing_secret: SLACK_SECRET });
  await q(`INSERT INTO pm.member_identities (member_id, provider, external_id, verified_at, verified_method) VALUES ($1, 'telegram', '5550001', now(), 'link')`, [pat]);
  await q(`INSERT INTO pm.member_identities (member_id, provider, external_id, workspace_id, verified_at, verified_method) VALUES ($1, 'slack', 'U_PAT', 'T1', now(), 'admin')`, [pat]);
  await q(`INSERT INTO pm.member_identities (member_id, provider, external_id, workspace_id, verified_at, verified_method) VALUES ($1, 'slack', 'U_SAM', 'T1', now(), 'admin')`, [sam]);
  // Pat wrote the Telegram bot before: notices go there first.
  await q(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, external_user_id, member_id, text)
    VALUES ($1, 'inbound', 'handled', '5550001', '5550001', $2, 'hi')`, [telegram, pat]);
  return { q, olivia, pat, mia, quill, sam, telegram, slack };
}

async function main() {
  await migrationChecks();
  const db = await createFullSchemaDatabase();
  const server = await startFakePostgrest(db);
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com', APP_ENCRYPTION_KEY: APP_KEY,
  });
  const calls: { url: string; body: Loose }[] = [];
  chatHttp.fetch = async (input, init) => {
    const url = String(input);
    const raw = String(init?.body ?? '{}');
    let body: Loose;
    try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    calls.push({ url, body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/getWebhookInfo')) return json({ ok: true, result: { url: 'https://pm.example.com/api/chat/inbound/x' } });
    if (url.includes('api.telegram.org')) return json({ ok: true, result: { message_id: 100 + calls.length } });
    if (url.endsWith('/chat.postMessage')) return json({ ok: true, ts: `1800000000.${calls.length}` });
    if (url.endsWith('/conversations.open')) return json({ ok: true, channel: { id: `D_${String(body.users)}` } });
    return json({ ok: true });
  };
  try {
    const s = await seed(db);
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { deliverDueNotifications } = await import('../src/lib/notification-delivery');
    const { handleChatInbound, handleChatAction } = await import('../src/lib/chat/inbound');
    const { answerButtonsFor, recordAnswerMessage } = await import('../src/lib/chat/answers');
    const service = getServiceClient();

    const buttonsOf = (call: Loose) => (call?.body?.reply_markup?.inline_keyboard ?? []).flat().filter((b: Loose) => b.callback_data);
    const ask = async (fields: { kind?: string; question?: string; action?: unknown; choices?: string[]; askedTo?: string }) =>
      (await s.q<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, question, kind, action, choices, allow_other)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [s.quill, fields.askedTo ?? s.pat, fields.question ?? 'Ship it?', fields.kind ?? 'question',
        fields.action ? JSON.stringify(fields.action) : null, fields.choices ? JSON.stringify(fields.choices) : (fields.kind === 'approval' ? '["approve", "reject"]' : null),
        fields.kind === 'approval' ? false : true]))[0].id;
    const sentWithButtons = () => calls.filter((c) => c.url.endsWith('/sendMessage') && c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data);
    const press = (token: string, fromId = 5550001, secret = TELEGRAM_SECRET, updateId = Math.floor(Math.random() * 1e9)) => handleChatInbound(service, s.telegram, {
      headers: new Headers({ 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }),
      body: JSON.stringify({ update_id: updateId, callback_query: { id: `cb${updateId}`, from: { id: fromId, is_bot: false }, message: { chat: { id: 5550001 }, message_id: 1 }, data: token } }),
    }, 'https://pm.example.com');
    const question = async (id: string) => (await s.q<Loose>('SELECT status, answer_choice, decided_via, answered_by FROM pm.questions WHERE id = $1', [id]))[0];

    // ── Delivered with buttons ──────────────────────────────────────────
    const approval = await ask({ kind: 'approval', question: 'May I deploy the redirects?', action: { type: 'deploy', summary: 'Deploy 214 redirect rules', details: { site: 'crest.example.com', rules: '214 (from the old WordPress URLs)' } } });
    const run = await deliverDueNotifications(service, { mailer: async () => ({ success: true }) });
    const first = sentWithButtons()[0];
    const keyboard = first?.body?.reply_markup?.inline_keyboard ?? [];
    const enabled = calls.some((c) => c.url.endsWith('/setWebhook') && JSON.stringify(c.body.allowed_updates) === '["message","callback_query"]' && c.body.secret_token === TELEGRAM_SECRET);
    check('delivery: an approval reaches the person\'s chat with Approve and Reject, then a link back; a connection from before buttons asks Telegram for presses first, keeping its secret',
      run.sent.chat === 1 && keyboard[0]?.map((b: Loose) => b.text).join() === 'Approve,Reject' && !!keyboard[1]?.[0]?.url && enabled, { run, keyboard, calls: calls.map((c) => c.url) });
    check('approval text: the message under Approve says what is approved, the summary and every detail row whole', /Deploy 214 redirect rules/.test(first?.body?.text ?? '')
      && first.body.text.includes('site: crest.example.com') && first.body.text.includes('rules: 214 (from the old WordPress URLs)'), first?.body?.text);
    const [approveToken, rejectToken] = keyboard[0].map((b: Loose) => b.callback_data as string);
    const stored = await s.q<Loose>('SELECT token_hash, choice, external_message_id, conversation_id FROM pm.chat_answer_tokens WHERE question_id = $1 ORDER BY choice', [approval]);
    check('tokens: stored hashed, never the token itself, bound to the message they are on', stored.length === 2 && stored.every((t: Loose) => !t.token_hash.includes(approveToken) && /^[0-9a-f]{64}$/.test(t.token_hash) && t.external_message_id && t.conversation_id === '5550001'), stored);

    // ── Refused before anything is read ─────────────────────────────────
    const badSecret = await press(approveToken, 5550001, 'x'.repeat(40));
    check('signature: a press without the connection\'s Telegram secret is refused (401) and decides nothing', badSecret.status === 401 && (await question(approval)).status === 'open', badSecret);
    const wrongPerson = await press(approveToken, 9990001);
    check('identity: a press from someone else\'s account is refused and leaves the buttons working', wrongPerson.body?.status === 'wrong_person' && (await question(approval)).status === 'open'
      && (await s.q('SELECT 1 FROM pm.chat_answer_tokens WHERE question_id = $1 AND used_at IS NOT NULL', [approval])).length === 0, wrongPerson.body);

    // ── Answered as the person ──────────────────────────────────────────
    const editsBefore = calls.filter((c) => c.url.endsWith('/editMessageText')).length;
    const approved = await press(approveToken);
    const decided = await question(approval);
    const edit = calls.filter((c) => c.url.endsWith('/editMessageText')).at(-1);
    const ack = calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).at(-1);
    check('answer: Approve decides it as the person, recorded decided_via chat; the message now says "Approved: Deploy 214 redirect rules" and the press is acknowledged',
      approved.body?.status === 'answered' && decided.status === 'answered' && decided.answer_choice === 'approve' && decided.decided_via === 'chat' && decided.answered_by === s.pat
        && calls.filter((c) => c.url.endsWith('/editMessageText')).length === editsBefore + 1 && edit?.body?.text === 'Approved: Deploy 214 redirect rules'
        && JSON.stringify(edit?.body?.reply_markup) === '{"inline_keyboard":[]}' && ack?.body?.text === 'Approved: Deploy 214 redirect rules', { approved: approved.body, decided, edit: edit?.body });
    const replay = await press(approveToken);
    const sibling = await press(rejectToken);
    check('single use: a replayed press, or the other button on the same message, does nothing', replay.body?.status === 'used' && sibling.body?.status === 'used'
      && (await question(approval)).answer_choice === 'approve', [replay.body, sibling.body]);

    // ── Decided elsewhere first ─────────────────────────────────────────
    const raced = await ask({ kind: 'approval', question: 'Send the invoice?', action: { type: 'send', summary: 'Send INV-7' } });
    await deliverDueNotifications(service, {});
    const racedToken = sentWithButtons().at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data as string;
    await s.q("UPDATE pm.questions SET status = 'answered', answer_choice = 'reject', answered_by = $1, answered_at = now(), decided_via = 'app' WHERE id = $2", [s.olivia, raced]);
    const late = await press(racedToken);
    const lateEdit = calls.filter((c) => c.url.endsWith('/editMessageText')).at(-1);
    check('already handled: someone got there first; the message says who, nothing changes', late.body?.status === 'already_handled' && /Olivia/.test(lateEdit?.body?.text ?? '')
      && (await question(raced)).answer_choice === 'reject' && (await question(raced)).answered_by === s.olivia, { late: late.body, edit: lateEdit?.body });

    // ── Permission lost ─────────────────────────────────────────────────
    const moved = await ask({ kind: 'approval', question: 'Pay the contractor?', action: { type: 'pay', summary: 'Pay $400' } });
    await deliverDueNotifications(service, {});
    const movedToken = sentWithButtons().at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data as string;
    await s.q('UPDATE pm.questions SET asked_to = $1 WHERE id = $2', [s.mia, moved]);
    const lost = await press(movedToken);
    check('permission: re-checked with the person\'s own access when pressed; no longer theirs, nothing is decided', lost.body?.status === 'not_allowed' && (await question(moved)).status === 'open', lost.body);

    // ── Suspended ───────────────────────────────────────────────────────
    // Asked of a group Pat is in: suspending Pat leaves it open for the others, so only the guard stops Pat's press.
    const group = (await s.q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Buyers', 'buyers') RETURNING id"))[0].id;
    await s.q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2), ($1, $3)', [group, s.pat, s.mia]);
    const paused = (await s.q<{ id: string }>(`INSERT INTO pm.questions (asked_by, asked_to, asked_to_group, question, kind, action, choices, allow_other)
      VALUES ($1, NULL, $2, 'Order the new laptops?', 'approval', '{"type":"buy","summary":"Order 3 laptops"}', '["approve", "reject"]', false) RETURNING id`, [s.quill, group]))[0].id;
    await deliverDueNotifications(service, {});
    const pausedToken = buttonsOf(sentWithButtons().at(-1))[0].callback_data as string;
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.pat]);
    const suspended = await press(pausedToken);
    await s.q("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [s.pat]);
    const afterSuspend = await question(paused);
    check('suspended: a suspended person\'s press decides nothing', suspended.body?.status === 'not_allowed' && afterSuspend.status !== 'answered' && afterSuspend.answer_choice === null, { press: suspended.body, afterSuspend });

    // ── Expired ─────────────────────────────────────────────────────────
    const old = await ask({ question: 'Which font?', choices: ['Inter', 'Lora', 'Source Serif'] });
    await deliverDueNotifications(service, {});
    const oldCall = sentWithButtons().at(-1)!;
    const oldButtons = buttonsOf(oldCall);
    const rows = oldCall.body.reply_markup.inline_keyboard as Loose[][];
    check('choices: a question with choices gets one button each, each on its own row (readable on a phone), the link last', oldButtons.map((b: Loose) => b.text).join() === 'Inter,Lora,Source Serif'
      && rows.length === 4 && rows.slice(0, 3).every((row) => row.length === 1) && !!rows[3][0].url, rows);
    await s.q("UPDATE pm.chat_answer_tokens SET expires_at = now() - interval '1 minute' WHERE question_id = $1", [old]);
    const expired = await press(oldButtons[0].callback_data);
    check('expiry: a button past its time decides nothing', expired.body?.status === 'expired' && (await question(old)).status === 'open', expired.body);

    // ── No buttons ──────────────────────────────────────────────────────
    const details = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`line_${i}`, `${'x'.repeat(180)} ${i}`]));
    const sentBefore = calls.filter((c) => c.url.endsWith('/sendMessage')).length;
    const long = await ask({ kind: 'approval', question: 'Pay these?', action: { type: 'pay', summary: 'Pay 30 bills', details } });
    await deliverDueNotifications(service, {});
    const longCall = calls.filter((c) => c.url.endsWith('/sendMessage')).at(-1);
    check('no buttons: an approval whose summary and detail rows do not fit one message goes with its link only, no buttons and no tokens',
      calls.filter((c) => c.url.endsWith('/sendMessage')).length === sentBefore + 1 && buttonsOf(longCall).length === 0 && !!longCall?.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.url
        && (await s.q('SELECT 1 FROM pm.chat_answer_tokens WHERE question_id = $1', [long])).length === 0, longCall?.body);
    const written = await ask({ question: 'What should the headline say?' });
    check('no buttons: a written answer gets none (answered in the app)', (await answerButtonsFor(service, { questionId: written, memberId: s.pat, connectionId: s.telegram, room: 4000 })) === null);

    // ── Slack ───────────────────────────────────────────────────────────
    const slackQuestion = await ask({ question: 'Ship Friday?', choices: ['Yes', 'No'] });
    const buttons = (await answerButtonsFor(service, { questionId: slackQuestion, memberId: s.pat, connectionId: s.slack, room: 2900 }))!;
    await recordAnswerMessage(service, buttons.batch, 'D_PAT', '1800000000.1');
    const form = (token: string, user = 'U_PAT') => `payload=${encodeURIComponent(JSON.stringify({
      type: 'block_actions', trigger_id: randomUUID(), team: { id: 'T1' }, user: { id: user }, container: { channel_id: 'D_PAT', message_ts: '1800000000.1' },
      actions: [{ action_id: 'pm_answer_0', value: token, action_ts: '1' }],
    }))}`;
    const signed = (body: string, secret = SLACK_SECRET, at = Math.floor(Date.now() / 1000)) => new Headers({
      'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(at),
      'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${at}:${body}`).digest('hex')}`,
    });
    const yes = form(buttons.buttons[0].token);
    const forged = await handleChatAction(service, s.slack, { headers: signed(yes, 'e'.repeat(32)), body: yes });
    const stale = await handleChatAction(service, s.slack, { headers: signed(yes, SLACK_SECRET, Math.floor(Date.now() / 1000) - 600), body: yes });
    check('signature: a Slack press with the wrong signing secret, or older than five minutes, is refused (401) and decides nothing',
      forged.status === 401 && stale.status === 401 && (await question(slackQuestion)).status === 'open', [forged, stale]);
    const someoneElse = form(buttons.buttons[0].token, 'U_OTHER');
    const otherPress = await handleChatAction(service, s.slack, { headers: signed(someoneElse), body: someoneElse });
    const answered = await handleChatAction(service, s.slack, { headers: signed(yes), body: yes });
    const update = calls.filter((c) => c.url.endsWith('/chat.update')).at(-1);
    check('Slack: only the person\'s own account in that workspace answers; the message is updated and its buttons go',
      otherPress.body?.status === 'wrong_person' && answered.body?.status === 'answered' && (await question(slackQuestion)).answer_choice === 'Yes'
        && update?.body?.ts === '1800000000.1' && JSON.stringify(update?.body?.blocks) === '[]' && /Answered "Yes"/.test(update?.body?.text ?? ''), { otherPress: otherPress.body, answered: answered.body, update: update?.body });
    const telegramOnSlack = await press(buttons.buttons[1].token);
    check('connection: a token only works on the connection it was sent on', telegramOnSlack.body?.status === 'unknown', telegramOnSlack.body);

    // Slack buttons only once the Owner says Interactivity is set up.
    const toSam = async (summary: string) => {
      await ask({ kind: 'approval', question: `${summary}?`, action: { type: 'other', summary }, askedTo: s.sam });
      await deliverDueNotifications(service, {});
      return calls.filter((c) => c.url.endsWith('/chat.postMessage')).at(-1);
    };
    const plain = await toSam('Renew the domain');
    check('Slack: by default the message goes with its link only, no buttons (Interactivity may not be set up)', !!plain && !plain.body.blocks && /Renew the domain/.test(plain.body.text), plain?.body);
    const { updateChatConnection } = await import('../src/lib/chat/connections');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const ownerAccess = (await resolveMemberAccess(service, s.olivia))!;
    const turned = await updateChatConnection(service, ownerAccess, s.olivia, s.slack, { answer_buttons: true }, 'https://pm.example.com');
    const withButtons = await toSam('Renew the certificate');
    const actions = (withButtons?.body?.blocks ?? []).find((b: Loose) => b.type === 'actions');
    check('Slack: once the Owner turns answer buttons on, Approve and Reject go with the message', turned.answer_buttons === true
      && actions?.elements?.map((e: Loose) => e.text.text).join() === 'Approve,Reject', { turned: turned.answer_buttons, blocks: withButtons?.body?.blocks });
    let refusedForTelegram = '';
    try { await updateChatConnection(service, ownerAccess, s.olivia, s.telegram, { answer_buttons: false }, 'https://pm.example.com'); } catch (error) { refusedForTelegram = (error as Loose).details?.reason ?? ''; }
    check('Slack only: Telegram\'s buttons need no switch (422 answer_buttons_slack_only)', refusedForTelegram === 'answer_buttons_slack_only', refusedForTelegram);

    // Sources: a person-only action, said where it is enforced.
    const answers = readFileSync(join(__dirname, '..', 'src', 'lib', 'chat', 'answers.ts'), 'utf8');
    check('parity: no REST route or MCP tool, said where it is enforced', answers.includes('This is a person-only action: there is no REST route or MCP tool for it'));
  } finally {
    await server.close();
    await db.close();
  }
}

main().then(() => {
  if (failures.length) {
    console.error(`chat-answers: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  console.log(`chat-answers: all ${passed} checks passed`);
}, (error) => {
  console.error(error);
  process.exit(1);
});
