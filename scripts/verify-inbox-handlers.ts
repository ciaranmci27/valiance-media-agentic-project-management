/**
 * Inbox handlers, per-inbox defaults and sender rules for one inbox, on the
 * full schema through the real routes (v1 routes with keys, the settings
 * service as an Owner, ingestion with a crafted email, a fake PostgREST over
 * PGlite):
 * - The migration (20261124001000_inbox_handlers.sql), run twice on the
 *   schema before it, matches schema.sql; every inbox's handler becomes its
 *   primary row; the previous release's writes (handler_member_id on an
 *   inbox, a sender rule without a scope) still work and keep the rows in
 *   step; the constraints hold.
 * - handler_member_id and the primary row stay in step both ways; a group
 *   handler's members get no copied grant, nor does someone who joins later
 *   (they read it through the group: verify-followups.ts).
 * - Defaults apply only when a request leaves the field out: a plan's new
 *   task and reminder go to the inbox's default (a member, or a group's
 *   leads), a reminder with no project takes the default project; with no
 *   defaults set a plan answers byte for byte as on a database without the
 *   migration.
 * - Any agent handler counts as the inbox's agent for being addressed; the
 *   decision member gets no speaker trust (that stays the Owner role's).
 * - Sender rules: the old five-field POST is 201 and the workspace's, as in
 *   2.0.21; scope and inbox_id are checked; an agent's inbox rule and its own
 *   workspace rule replace each other; a person's rule always wins (a
 *   person's workspace rule switches off the agents' rules in every inbox,
 *   and sorting ranks it first); a workspace rule answers exactly as before;
 *   GET and senders filter by inbox; ingestion applies a rule only to its
 *   inbox.
 * - handled=me on queue, reply drafts and signal, directly and through a
 *   group; without it the answer is unchanged.
 * - POST /notifications audience owner about one inbox goes to its decision
 *   recipient (a member, or a group's members); otherwise to the Owner. A
 *   value that is not a uuid, or an inbox the key cannot read, is ignored.
 * - Settings: handlers and defaults saved and shown; saving who reads the
 *   inbox never takes a handler's access away; only the Owner role chooses
 *   who gets decisions; before the migration a save without handlers or
 *   defaults still works.
 *
 *   npm run -s test:inbox-handlers
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { matchRule } from '../src/lib/communications/sorting';
import { presentRule, ruleAppliesTo, scopesOverlap, type SenderRuleRow } from '../src/lib/communications/sender-rules';

const MIGRATION = '20261124001000_inbox_handlers.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- INBOX HANDLERS, DEFAULTS AND RULE SCOPE (20261124001000_inbox_handlers.sql)';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Row = Record<string, unknown>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  owner: id(1), mia: id(2), nina: id(3), scout: id(4), atlas: id(5), gale: id(6), adam: id(7),
  acme: id(10), birch: id(11),
  inboxA: id(20), inboxB: id(21), inboxC: id(22),
  support: id(30), bots: id(31),
};
let next = 1000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

// ── Pure ─────────────────────────────────────────────────────────────────

function pureChecks() {
  const base = { id: 'r', match_kind: 'address', match_value: 'a@tool.example', topic: null, action: 'ignore', source: 'agent', recipient: null, reason: '', created_by: null, hit_count: 0, last_hit_at: null, disabled_at: null, created_at: 't' } as SenderRuleRow;
  const workspace = presentRule({ ...base, scope: 'workspace', inbox_id: null });
  check('present: a workspace rule has exactly the fields it had before', JSON.stringify(Object.keys(workspace)) === JSON.stringify(Object.keys(base)), Object.keys(workspace));
  const own = presentRule({ ...base, scope: 'inbox', inbox_id: 'x' });
  check('present: an inbox rule adds scope and inbox_id', own.scope === 'inbox' && own.inbox_id === 'x');
  check('applies: a workspace rule everywhere, an inbox rule only there', ruleAppliesTo({ inbox_id: null }, 'x') && ruleAppliesTo({ inbox_id: 'x' }, 'x') && !ruleAppliesTo({ inbox_id: 'y' }, 'x')
    && ruleAppliesTo({}, 'x'));
  check('overlap: scopes meet unless two different inboxes', scopesOverlap({ inbox_id: null }, { inbox_id: 'x' }) && scopesOverlap({ inbox_id: 'x' }, { inbox_id: 'x' }) && !scopesOverlap({ inbox_id: 'x' }, { inbox_id: 'y' }));
  const ws = { id: 'ws', match_kind: 'address' as const, match_value: 'a@tool.example', topic: null, action: 'fyi' as const, recipient: null, inbox_id: null };
  const inboxRule = { ...ws, id: 'ib', action: 'ignore' as const, inbox_id: 'x', match_kind: 'domain' as const, match_value: 'tool.example' };
  check('match: the inbox\'s own rule wins over a workspace rule', matchRule([ws, inboxRule], 'a@tool.example', null)?.id === 'ib');
  check('match: without inbox rules nothing changes', matchRule([ws], 'a@tool.example', null)?.id === 'ws');
  const agentInbox = { ...inboxRule, id: 'agent', source: 'agent' as const, match_kind: 'address' as const, match_value: 'a@tool.example' };
  const personWorkspace = { ...ws, id: 'person', source: 'person' as const, match_kind: 'domain' as const, match_value: 'tool.example' };
  check('match: a person\'s rule always outranks an agent\'s, however specific', matchRule([agentInbox, personWorkspace], 'a@tool.example', null)?.id === 'person'
    && matchRule([personWorkspace, agentInbox], 'a@tool.example', null)?.id === 'person');
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the inbox handlers section is there, last', at > 0 && banner > 0 && SCHEMA_SQL.indexOf('-- IDENTITY, GROUPS AND ON BEHALF OF') < at);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Inbox handlers')).trim();
  check('schema.sql: the section mirrors the migration body', SCHEMA_SQL.slice(at).includes(body));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const fail = (db: PGlite, sql: string, params: unknown[] = []) => db.query(sql, params).then(() => null, (e: Error) => e.message);
  await q("UPDATE pm.business_settings SET inbound_email_domain = 'relay.example.test'");
  const bot = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Bot', 'bot@example.com', 'agent') RETURNING id"))[0].id;
  const other = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Other', 'other@example.com', 'agent') RETURNING id"))[0].id;
  const person = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Pat', 'pat@example.com', 'member') RETURNING id"))[0].id;
  const handled = (await q<{ id: string }>("INSERT INTO pm.inboxes (name, address, handler_member_id) VALUES ('Bot', 'bot@agency.example', $1) RETURNING id", [bot]))[0].id;
  const unhandled = (await q<{ id: string }>("INSERT INTO pm.inboxes (name, address) VALUES ('Nobody', 'nobody@agency.example') RETURNING id"))[0].id;
  const oldRule = (await q<{ id: string }>("INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, reason) VALUES ('domain', 'tool.example', 'usage', 'ignore', 'agent', 'Before') RETURNING id"))[0].id;

  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await fresh.close();

  const rows = await q('SELECT inbox_id, handler_member_id, handler_group_id, is_primary FROM pm.inbox_handlers ORDER BY created_at');
  check('backfill: the handled inbox has one primary row for its handler, run twice', rows.length === 1 && rows[0].inbox_id === handled && rows[0].handler_member_id === bot && rows[0].is_primary === true, rows);
  check('backfill: an inbox without a handler gets none', !rows.some((r: Loose) => r.inbox_id === unhandled));
  const kept = (await q('SELECT scope, inbox_id FROM pm.sender_rules WHERE id = $1', [oldRule]))[0];
  check('upgrade: an existing rule is the workspace\'s', kept.scope === 'workspace' && kept.inbox_id === null, kept);

  // What 2.0.21 writes: handler_member_id on an inbox, sender rules without a scope.
  await q('UPDATE pm.inboxes SET handler_member_id = $1 WHERE id = $2', [other, handled]);
  const moved = await q('SELECT handler_member_id, is_primary FROM pm.inbox_handlers WHERE inbox_id = $1', [handled]);
  check('sync: writing the column replaces the primary row', moved.length === 1 && moved[0].handler_member_id === other && moved[0].is_primary, moved);
  check('sync: the new handler reads the inbox', (await q('SELECT 1 FROM pm.inbox_access WHERE inbox_id = $1 AND member_id = $2', [handled, other])).length === 1);
  await q('UPDATE pm.inboxes SET handler_member_id = NULL WHERE id = $1', [handled]);
  check('sync: clearing the column removes the primary', (await q('SELECT 1 FROM pm.inbox_handlers WHERE inbox_id = $1', [handled])).length === 0);
  const created = (await q<{ id: string }>("INSERT INTO pm.inboxes (name, address, handler_member_id) VALUES ('New', 'new@agency.example', $1) RETURNING id", [bot]))[0].id;
  check('sync: a new inbox with a handler gets its primary row', (await q('SELECT 1 FROM pm.inbox_handlers WHERE inbox_id = $1 AND is_primary AND handler_member_id = $2', [created, bot])).length === 1);
  const ruled = (await q("INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, reason) VALUES ('address', 'a@tool.example', NULL, 'fyi', 'person', '') RETURNING scope, inbox_id"))[0];
  check('upgrade: a 2.0.21-shaped rule insert is the workspace\'s', ruled.scope === 'workspace' && ruled.inbox_id === null, ruled);

  // The rows drive the column.
  await q('INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id) VALUES ($1, $2)', [created, other]);
  check('sync: a second handler leaves the column on the primary', (await q('SELECT handler_member_id FROM pm.inboxes WHERE id = $1', [created]))[0].handler_member_id === bot);
  await q('UPDATE pm.inbox_handlers SET is_primary = false WHERE inbox_id = $1 AND is_primary', [created]);
  check('sync: no primary row, no column', (await q('SELECT handler_member_id FROM pm.inboxes WHERE id = $1', [created]))[0].handler_member_id === null);
  await q('UPDATE pm.inbox_handlers SET is_primary = true WHERE inbox_id = $1 AND handler_member_id = $2', [created, other]);
  check('sync: promoting a row sets the column', (await q('SELECT handler_member_id FROM pm.inboxes WHERE id = $1', [created]))[0].handler_member_id === other);
  await q('UPDATE pm.inboxes SET handler_member_id = $1 WHERE id = $2', [bot, created]);
  const swapped = await q('SELECT handler_member_id, is_primary FROM pm.inbox_handlers WHERE inbox_id = $1 ORDER BY handler_member_id', [created]);
  check('sync: writing the column to an existing handler promotes it and drops the old primary', swapped.length === 1 && swapped[0].handler_member_id === bot && swapped[0].is_primary, swapped);

  // Constraints.
  const group = (await q<{ id: string }>("INSERT INTO pm.groups (name, slug) VALUES ('Support', 'support') RETURNING id"))[0].id;
  check('database: only a member is the primary', /inbox_handlers_primary_is_member/.test(await fail(old, 'INSERT INTO pm.inbox_handlers (inbox_id, handler_group_id, is_primary) VALUES ($1, $2, true)', [unhandled, group]) ?? ''));
  check('database: a handler is a member or a group, not both', /inbox_handlers_one_handler/.test(await fail(old, 'INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id, handler_group_id) VALUES ($1, $2, $3)', [unhandled, person, group]) ?? ''));
  check('database: each handler once per inbox', /inbox_handlers_member_key/.test(await fail(old, 'INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id) VALUES ($1, $2)', [created, bot]) ?? ''));
  await q('INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id, is_primary) VALUES ($1, $2, true)', [unhandled, person]);
  check('database: one primary per inbox', /inbox_handlers_one_primary/.test(await fail(old, 'INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id, is_primary) VALUES ($1, $2, true)', [unhandled, bot]) ?? ''));
  check('database: at most one default assignee', /inboxes_default_assignee_one/.test(await fail(old, 'UPDATE pm.inboxes SET default_assignee_member_id = $1, default_assignee_group_id = $2 WHERE id = $3', [person, group, unhandled]) ?? ''));
  check('database: at most one decision recipient', /inboxes_decision_recipient_one/.test(await fail(old, 'UPDATE pm.inboxes SET decision_member_id = $1, decision_group_id = $2 WHERE id = $3', [person, group, unhandled]) ?? ''));
  check('database: an inbox rule names its inbox', /sender_rules_scope_inbox/.test(await fail(old, "INSERT INTO pm.sender_rules (match_kind, match_value, action, source, scope) VALUES ('address', 'b@tool.example', 'ignore', 'person', 'inbox')") ?? ''));
  check('database: a workspace rule and one inbox\'s rule for the same sender live side by side',
    (await fail(old, "INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, scope, inbox_id) VALUES ('domain', 'tool.example', 'usage', 'fyi', 'agent', 'inbox', $1)", [created])) === null
    && /sender_rules_live_key/.test(await fail(old, "INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source) VALUES ('domain', 'tool.example', 'usage', 'fyi', 'agent')") ?? ''));

  // A group handler: its members read the inbox through the group, and so
  // does whoever joins later, with no copied grant (since
  // 20261125000200_followups.sql: pm.can_read_inbox; verify-followups.ts).
  await q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [group, person]);
  await q('INSERT INTO pm.inbox_handlers (inbox_id, handler_group_id) VALUES ($1, $2)', [handled, group]);
  check('access: a group handler copies no grant to its members', (await q('SELECT 1 FROM pm.inbox_access WHERE inbox_id = $1 AND member_id = $2', [handled, person])).length === 0);
  const joiner = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Jo', 'jo@example.com', 'member') RETURNING id"))[0].id;
  await q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [group, joiner]);
  check('access: nor does joining the group later', (await q('SELECT 1 FROM pm.inbox_access WHERE inbox_id = $1 AND member_id = $2', [handled, joiner])).length === 0);
  check('sync: a group handler never touches the column', (await q('SELECT handler_member_id FROM pm.inboxes WHERE id = $1', [handled]))[0].handler_member_id === null);
  await old.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

const PERMISSIONS = ['inbound_email.read', 'inbound_email.triage', 'inbound_email.signal', 'tasks.read', 'tasks.create', 'tasks.manage_all',
  'projects.read', 'projects.read_all', 'reminders.manage_own', 'files.read', 'files.upload', 'project_context.manage', 'notifications.send'];

async function seed(db: PGlite) {
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  await db.exec(`
    INSERT INTO pm.team_members (id, name, email, role) VALUES
      ('${ids.owner}', 'Olivia Park', 'owner@agency.example', 'owner'),
      ('${ids.mia}', 'Mia Chen', 'mia@agency.example', 'member'),
      ('${ids.nina}', 'Nina Ross', 'nina@agency.example', 'member'),
      ('${ids.scout}', 'Scout', 'scout-bot@agency.example', 'agent'),
      ('${ids.atlas}', 'Atlas', 'atlas-bot@agency.example', 'agent'),
      ('${ids.gale}', 'Gale', 'gale-bot@agency.example', 'agent'),
      ('${ids.adam}', 'Adam Admin', 'adam@agency.example', 'admin');
    INSERT INTO pm.projects (id, name, status) VALUES ('${ids.acme}', 'Acme', 'active'), ('${ids.birch}', 'Birch', 'active');
    INSERT INTO pm.project_members (project_id, member_id) VALUES
      ('${ids.acme}', '${ids.mia}'), ('${ids.acme}', '${ids.nina}'), ('${ids.birch}', '${ids.mia}');
    INSERT INTO pm.groups (id, name, slug) VALUES ('${ids.support}', 'Support', 'support'), ('${ids.bots}', 'Bots', 'bots');
    INSERT INTO pm.group_members (group_id, member_id, role) VALUES
      ('${ids.support}', '${ids.mia}', 'member'), ('${ids.support}', '${ids.nina}', 'lead'), ('${ids.bots}', '${ids.gale}', 'member');
    UPDATE pm.business_settings SET inbound_email_domain = 'relay.example.test';
    INSERT INTO pm.inboxes (id, name, address, handler_member_id, triage_mode) VALUES
      ('${ids.inboxA}', 'Scout', 'scout@agency.example', '${ids.scout}', 'plans'),
      ('${ids.inboxB}', 'Atlas', 'atlas@agency.example', '${ids.atlas}', 'plans'),
      ('${ids.inboxC}', 'Spare', 'spare@agency.example', NULL, 'plans');
  `);
  for (const member of [ids.mia, ids.nina]) {
    await db.query("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'projects.read_all', 'api', 'deny'), ($1, 'projects.read_all', 'app', 'deny') ON CONFLICT DO NOTHING", [member]);
  }
  const keys: Record<string, string> = {};
  for (const [name, member] of [['scout', ids.scout], ['atlas', ids.atlas], ['gale', ids.gale]] as const) {
    await db.query(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [member, PERMISSIONS]);
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await db.query(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ($1, 'pk_live', $2, $3, $4, 'scoped')`, [name, sha(secret), member, PERMISSIONS]);
    keys[name] = secret;
  }
  // Atlas also reads Scout's inbox; Gale reads both (the Bots group handles none yet).
  await db.query('INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES ($1, $2), ($3, $4), ($5, $4) ON CONFLICT DO NOTHING', [ids.inboxA, ids.atlas, ids.inboxA, ids.gale, ids.inboxB]);
  return keys;
}

/** A conversation with one message; returns both ids. */
async function message(db: PGlite, inbox: string, fields: { from?: string; to?: string[]; text?: string; teammate?: string; subject?: string; minutesAgo?: number } = {}) {
  const conversation = id(next++);
  const received = new Date(Date.now() - (fields.minutesAgo ?? 30) * 60_000).toISOString();
  await db.query('INSERT INTO pm.conversations (id, inbox_id, last_message_at) VALUES ($1, $2, $3)', [conversation, inbox, received]);
  const messageId = id(next++);
  const text = fields.text ?? 'Hi, please swap the hero image.';
  await db.query(`INSERT INTO pm.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id,
      received_at, subject, kind, auth, sender_member_id, sender_verified, delivery, text_body, new_text)
    VALUES ($1, $2, $3, 'new', 'test', $8, $8, $4, $5, 'person', '{"trust":"trusted"}', $6, true, 'direct', $7, $7)`, [
    messageId, inbox, conversation, received, fields.subject ?? 'Hero image', fields.teammate ?? null, text, `m-${messageId}`,
  ]);
  await db.query("INSERT INTO pm.participants (message_id, kind, address) VALUES ($1, 'from', $2)", [messageId, fields.from ?? 'dana@acme.example']);
  for (const to of fields.to ?? []) await db.query("INSERT INTO pm.participants (message_id, kind, address) VALUES ($1, 'to', $2)", [messageId, to]);
  await db.query("INSERT INTO pm.message_candidates (message_id, project_id, reason) VALUES ($1, $2, 'sender')", [messageId, ids.acme]);
  return { conversation, message: messageId };
}

/** Ids, times and per-run words out, so two runs of one plan compare. */
function normalized(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, 'TIME');
}

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  const keys = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_APP_URL: 'https://pm.example.com' });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };

  try {
    const planRoute = await import('../src/app/api/v1/inbox/messages/[id]/plan/route');
    const contextRoute = await import('../src/app/api/v1/inbox/messages/[id]/context/route');
    const queueRoute = await import('../src/app/api/v1/inbox/queue/route');
    const signalRoute = await import('../src/app/api/v1/inbox/signal/route');
    const draftsRoute = await import('../src/app/api/v1/inbox/reply-drafts/route');
    const rulesRoute = await import('../src/app/api/v1/inbox/sender-rules/route');
    const oldRulesRoute = await import('../src/app/api/v1/inbound-emails/sender-rules/route');
    const sendersRoute = await import('../src/app/api/v1/inbox/senders/route');
    const notificationsRoute = await import('../src/app/api/v1/notifications/route');
    const remindersRoute = await import('../src/app/api/v1/reminders/route');
    const settings = await import('../src/lib/communications/inbox-settings-service');
    const { ingestInbound } = await import('../src/lib/communications/email/ingest');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
    const service = getServiceClient();

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, key: string, params: Record<string, string> = {}, body?: unknown) => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      const text = await response.text();
      let parsed: Loose = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      return { status: response.status, body: parsed, text };
    };
    const reason = (answer: { body: Loose }) => answer.body?.error?.details?.reason;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
    const planBody = (title: string) => ({
      summary: 'Dana wants a size chart and a nudge next week.',
      items: [
        { type: 'create_task', intent: 'new_work', project_id: ids.acme, title, evidence: 'add a size chart' },
        { type: 'add_reminder', intent: 'waiting_on', title: `Chase Dana: ${title}`, remind_on: '2026-12-03' },
      ],
    });
    const runPlan = async (key: string, inbox: string, title: string) => {
      const msg = await message(db, inbox);
      const answer = await call(planRoute.POST, 'POST', `/api/v1/inbox/messages/${msg.message}/plan`, key, { id: msg.message }, planBody(title));
      const items = (answer.body?.data?.items ?? []) as Row[];
      const taskId = items.find((i) => i.type === 'create_task')?.task_id as string | undefined;
      const assignees = taskId ? (await q<{ member_id: string }>('SELECT member_id FROM pm.task_assignees WHERE task_id = $1 ORDER BY member_id', [taskId])).map((r) => r.member_id) : [];
      const reminder = (await q('SELECT owner_id, project_id FROM pm.reminders WHERE title = $1', [`Chase Dana: ${title}`]))[0] ?? null;
      return { answer, items, assignees, reminder, message: msg };
    };

    // ── Defaults: none set, exactly as before ─────────────────────────────
    const plain = await runPlan(keys.atlas, ids.inboxB, 'Size chart');
    check('defaults: none set, the plan applies as before', plain.answer.status === 201 && plain.items.every((i) => i.state === 'done'), plain.answer.body);
    // What 2.0.21 answers for this plan, written out.
    check('parity: the 2.0.21 plan status and items, exactly', plain.answer.body?.data?.plan?.status === 'applied'
      && JSON.stringify(plain.items.map((i) => [i.type, i.decision, i.reason ?? null, i.state, i.error ?? null]))
        === JSON.stringify([['create_task', 'apply', null, 'done', null], ['add_reminder', 'apply', null, 'done', null]]),
      [plain.answer.body?.data?.plan?.status, plain.items.map((i) => [i.type, i.decision, i.reason, i.state, i.error])]);
    check('parity: the 2.0.21 assignee and reminder owner, exactly (the Owner, no project)', JSON.stringify(plain.assignees) === JSON.stringify(['00000000-0000-4000-8000-000000000001'])
      && JSON.stringify(plain.reminder) === JSON.stringify({ owner_id: '00000000-0000-4000-8000-000000000001', project_id: null }), [plain.assignees, plain.reminder]);
    check('defaults: none set, the task is the Owner\'s and so is the reminder', JSON.stringify(plain.assignees) === JSON.stringify([ids.owner])
      && plain.reminder?.owner_id === ids.owner && plain.reminder.project_id === null, [plain.assignees, plain.reminder]);

    // ── Defaults set on Scout's inbox ──────────────────────────────────────
    await q('UPDATE pm.inboxes SET default_assignee_member_id = $1, default_project_id = $2 WHERE id = $3', [ids.mia, ids.acme, ids.inboxA]);
    const withDefault = await runPlan(keys.scout, ids.inboxA, 'Size chart A');
    check('defaults: a new task goes to the inbox\'s default assignee', withDefault.answer.status === 201 && JSON.stringify(withDefault.assignees) === JSON.stringify([ids.mia]), [withDefault.assignees, withDefault.answer.body]);
    check('defaults: a reminder that names no one is the default\'s, on the default project', withDefault.reminder?.owner_id === ids.mia && withDefault.reminder.project_id === ids.acme, [withDefault.reminder, withDefault.items.map((i) => [i.type, i.state, i.error, i.decision, i.reason])]);
    const sameShape = normalized(withDefault.answer.body.data.items.map((i: Row) => [i.type, i.decision, i.reason, i.state]))
      === normalized(plain.answer.body.data.items.map((i: Row) => [i.type, i.decision, i.reason, i.state]));
    check('defaults: decisions and states are the same as without defaults', sameShape);
    // A reminder that names its project keeps it; an explicit owner_id on POST /reminders is never overridden.
    const named = await message(db, ids.inboxA);
    const namedPlan = await call(planRoute.POST, 'POST', `/api/v1/inbox/messages/${named.message}/plan`, keys.scout, { id: named.message }, {
      summary: 'A reminder on Acme.', items: [{ type: 'add_reminder', intent: 'waiting_on', title: 'Acme follow-up', remind_on: '2026-12-04', project_id: ids.acme }],
    });
    const namedReminder = (await q('SELECT project_id FROM pm.reminders WHERE title = $1', ['Acme follow-up']))[0];
    check('defaults: a reminder that names a project keeps it', namedPlan.status === 201 && namedReminder?.project_id === ids.acme, [namedPlan.body, namedReminder]);
    const explicit = await call(remindersRoute.POST, 'POST', '/api/v1/reminders', keys.scout, {}, { title: 'Explicit owner', owner_id: ids.nina, remind_on: '2026-12-05' });
    check('defaults: POST /reminders keeps the owner it names', explicit.status === 201 && explicit.body.data.owner_id === ids.nina, explicit.body);

    // A default project the email may not touch is left out: the reminder has no project, as before.
    await q('UPDATE pm.inboxes SET default_project_id = $1 WHERE id = $2', [ids.birch, ids.inboxA]);
    const outOfScope = await runPlan(keys.scout, ids.inboxA, 'Size chart S');
    check('defaults: a default project outside the scope of the email is left out, never failing the item', outOfScope.items.every((i) => i.state === 'done')
      && outOfScope.reminder?.project_id === null && outOfScope.reminder.owner_id === ids.mia, [outOfScope.reminder, outOfScope.items.map((i) => [i.type, i.state, i.error])]);

    // A group default: its leads (Nina), when they can open the project.
    await q('UPDATE pm.inboxes SET default_assignee_member_id = NULL, default_assignee_group_id = $1 WHERE id = $2', [ids.support, ids.inboxA]);
    const toGroup = await runPlan(keys.scout, ids.inboxA, 'Size chart G');
    check('defaults: a group default goes to its leads', JSON.stringify(toGroup.assignees) === JSON.stringify([ids.nina]) && toGroup.reminder?.owner_id === ids.nina, [toGroup.assignees, toGroup.reminder]);
    // A default who cannot open the project falls back to the Owner, never failing the item.
    await q('UPDATE pm.inboxes SET default_assignee_group_id = NULL, default_assignee_member_id = $1 WHERE id = $2', [ids.nina, ids.inboxA]);
    const birchMsg = await message(db, ids.inboxA);
    await q("INSERT INTO pm.message_candidates (message_id, project_id, reason) VALUES ($1, $2, 'sender')", [birchMsg.message, ids.birch]);
    const birchPlan = await call(planRoute.POST, 'POST', `/api/v1/inbox/messages/${birchMsg.message}/plan`, keys.scout, { id: birchMsg.message }, {
      summary: 'Birch work.', items: [{ type: 'create_task', intent: 'new_work', project_id: ids.birch, title: 'Birch banner' }],
    });
    const birchTask = (birchPlan.body?.data?.items ?? [])[0]?.task_id;
    const birchAssignees = birchTask ? (await q<{ member_id: string }>('SELECT member_id FROM pm.task_assignees WHERE task_id = $1', [birchTask])).map((r) => r.member_id) : [];
    check('defaults: a default who cannot open the project leaves the Owner, as before', birchPlan.status === 201 && JSON.stringify(birchAssignees) === JSON.stringify([ids.owner]), [birchPlan.body, birchAssignees]);
    await q('UPDATE pm.inboxes SET default_assignee_member_id = NULL, default_project_id = NULL WHERE id = $1', [ids.inboxA]);

    // ── Addressed and speaking ────────────────────────────────────────────
    const context = async (key: string, messageId: string) => (await call(contextRoute.GET, 'GET', `/api/v1/inbox/messages/${messageId}/context`, key, { id: messageId })).body?.data;
    const toAtlas = await message(db, ids.inboxA, { to: ['dana@acme.example'], text: 'Hi Atlas, can you look at the footer?' });
    const toScout = await message(db, ids.inboxA, { to: ['dana@acme.example'], text: 'Hi Scout, can you look at the footer?' });
    check('addressed: the primary handler by name, as before', (await context(keys.scout, toScout.message))?.addressed_to_agent === true);
    check('addressed: another agent is not this inbox\'s until it handles it', (await context(keys.scout, toAtlas.message))?.addressed_to_agent === false);
    await q('INSERT INTO pm.inbox_handlers (inbox_id, handler_member_id) VALUES ($1, $2)', [ids.inboxA, ids.atlas]);
    check('addressed: any agent that handles the inbox counts', (await context(keys.scout, toAtlas.message))?.addressed_to_agent === true);
    check('addressed: the column still names the primary', (await q('SELECT handler_member_id FROM pm.inboxes WHERE id = $1', [ids.inboxA]))[0].handler_member_id === ids.scout);
    const fromMia = await message(db, ids.inboxA, { teammate: ids.mia, from: 'mia@agency.example', to: ['scout@agency.example'] });
    check('speaker: a teammate is a teammate', (await context(keys.scout, fromMia.message))?.speaker === 'teammate');
    await q('UPDATE pm.inboxes SET decision_member_id = $1 WHERE id = $2', [ids.mia, ids.inboxA]);
    check('speaker: the inbox\'s decision member gets no owner trust: still a teammate', (await context(keys.scout, fromMia.message))?.speaker === 'teammate');
    const fromMiaB = await message(db, ids.inboxB, { teammate: ids.mia, from: 'mia@agency.example', to: ['atlas@agency.example'] });
    check('speaker: and a teammate in another inbox', (await context(keys.atlas, fromMiaB.message))?.speaker === 'teammate');

    // ── Notifications: audience owner about one inbox ──────────────────────
    const notify = (key: string, body: Row) => call(notificationsRoute.POST, 'POST', '/api/v1/notifications', key, {}, { title: 'Decide', message: 'Please decide.', ...body });
    const [E_N_PLAIN, E_N_MESSAGE, E_N_CONV, E_N_B, E_N_ADMINS, E_N_GROUP, E_N_DENIED, E_N_GHOST, E_N_JUNK, E_N_CONVGHOST] = Array.from({ length: 10 }, () => randomUUID());
    const bells = async (entity: string) => (await q<{ user_id: string }>('SELECT user_id FROM pm.team_member_notifications WHERE entity_id = $1 ORDER BY user_id', [entity])).map((r) => r.user_id);
    const plainBell = await notify(keys.scout, { entity_id: E_N_PLAIN });
    check('notify: without an inbox, the Owner as before', plainBell.status === 201 && JSON.stringify(await bells(E_N_PLAIN)) === JSON.stringify([ids.owner]), plainBell.body);
    const aboutMessage = await notify(keys.scout, { entity_id: E_N_MESSAGE, message_id: fromMia.message });
    check('notify: about a message, its inbox\'s decision member', aboutMessage.status === 201 && JSON.stringify(await bells(E_N_MESSAGE)) === JSON.stringify([ids.mia]), [aboutMessage.body, await bells(E_N_MESSAGE)]);
    const aboutConversation = await notify(keys.scout, { entity_id: E_N_CONV, conversation_id: fromMia.conversation });
    check('notify: about a conversation, the same', aboutConversation.status === 201 && JSON.stringify(await bells(E_N_CONV)) === JSON.stringify([ids.mia]));
    const aboutB = await notify(keys.atlas, { entity_id: E_N_B, inbox_id: ids.inboxB });
    check('notify: an inbox with no decision recipient, the Owner', aboutB.status === 201 && JSON.stringify(await bells(E_N_B)) === JSON.stringify([ids.owner]));
    const admins = await notify(keys.scout, { entity_id: E_N_ADMINS, inbox_id: ids.inboxA, audience: 'owner_and_admins' });
    check('notify: owner_and_admins keeps its roles (Owners and Admins, never the decision recipient)', admins.status === 201 && JSON.stringify(await bells(E_N_ADMINS)) === JSON.stringify([ids.owner, ids.adam].sort()), await bells(E_N_ADMINS));
    await q('UPDATE pm.inboxes SET decision_member_id = NULL, decision_group_id = $1 WHERE id = $2', [ids.support, ids.inboxA]);
    const toSupport = await notify(keys.scout, { entity_id: E_N_GROUP, inbox_id: ids.inboxA });
    check('notify: a decision group, every active member', toSupport.status === 201 && JSON.stringify(await bells(E_N_GROUP)) === JSON.stringify([ids.mia, ids.nina].sort()), await bells(E_N_GROUP));
    const notMine = await notify(keys.scout, { entity_id: E_N_DENIED, inbox_id: ids.inboxB });
    check('notify: an inbox the key cannot read is ignored: the Owner, as in 2.0.21', notMine.status === 201 && JSON.stringify(await bells(E_N_DENIED)) === JSON.stringify([ids.owner]), [notMine.body, await bells(E_N_DENIED)]);
    const ghost = await notify(keys.scout, { entity_id: E_N_GHOST, message_id: randomUUID() });
    check('notify: a message the key cannot read is ignored: the Owner', ghost.status === 201 && JSON.stringify(await bells(E_N_GHOST)) === JSON.stringify([ids.owner]), ghost.body);
    const junk = await notify(keys.scout, { entity_id: E_N_JUNK, inbox_id: 'scout-inbox', message_id: 42, conversation_id: { id: ids.inboxA } });
    check('notify: values that are not uuids are ignored, never 400: the Owner', junk.status === 201 && JSON.stringify(await bells(E_N_JUNK)) === JSON.stringify([ids.owner]), junk.body);
    const convGhost = await notify(keys.scout, { entity_id: E_N_CONVGHOST, conversation_id: fromMiaB.conversation });
    check('notify: a conversation in an inbox the key cannot read is ignored: the Owner', convGhost.status === 201 && JSON.stringify(await bells(E_N_CONVGHOST)) === JSON.stringify([ids.owner]), convGhost.body);
    await q('UPDATE pm.inboxes SET decision_group_id = NULL WHERE id = $1', [ids.inboxA]);

    // ── Sender rules ───────────────────────────────────────────────────────
    const ruleBody = { match_kind: 'domain', match_value: 'tool.example', topic: 'usage', action: 'ignore', reason: 'Four usage alerts this month, none acted on.' };
    const scoutRule = await call(oldRulesRoute.POST, 'POST', '/api/v1/inbound-emails/sender-rules', keys.scout, {}, ruleBody);
    check('rules: the old five-field POST is 201', scoutRule.status === 201, scoutRule.body);
    check('rules: an unscoped POST is the workspace\'s, as in 2.0.21, though the agent handles one inbox', !!scoutRule.body?.data?.rule && !('scope' in scoutRule.body.data.rule)
      && !('inbox_id' in scoutRule.body.data.rule) && scoutRule.body.data.replaced_rule_id === null
      && (await q('SELECT scope, inbox_id FROM pm.sender_rules WHERE id = $1', [scoutRule.body?.data?.rule?.id]))[0]?.scope === 'workspace', scoutRule.body?.data);
    // Atlas handles B and (since above) A: several, so the workspace.
    const atlasRule = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.atlas, {}, { ...ruleBody, match_value: 'alerts.example' });
    const atlasKeys = Object.keys(atlasRule.body?.data?.rule ?? {});
    check('rules: an unscoped rule from an agent that handles several inboxes is the workspace\'s too', atlasRule.status === 201 && !atlasKeys.includes('scope') && !atlasKeys.includes('inbox_id'), atlasRule.body);
    const explicitWorkspace = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.scout, {}, { ...ruleBody, match_value: 'news.example', scope: 'workspace' });
    check('rules: scope workspace is the workspace\'s', explicitWorkspace.status === 201 && explicitWorkspace.body.data.rule.scope === undefined, explicitWorkspace.body);
    const forB = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.scout, {}, { ...ruleBody, match_value: 'promo.example', scope: 'inbox', inbox_id: ids.inboxB });
    check('rules: a rule for an inbox the key does not triage is refused', forB.status === 403 && reason(forB) === 'inbox_scope', forB.body);
    const mixed = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.scout, {}, { ...ruleBody, scope: 'workspace', inbox_id: ids.inboxA });
    check('rules: scope workspace with an inbox is refused', mixed.status === 422, mixed.body);
    const noInbox = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.scout, {}, { ...ruleBody, scope: 'inbox' });
    check('rules: scope inbox names its inbox', noInbox.status === 422, noInbox.body);
    const replaced = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.scout, {}, { ...ruleBody, action: 'fyi', inbox_id: ids.inboxA });
    check('rules: an agent\'s inbox rule over its own workspace rule replaces it and reports it', replaced.status === 201 && replaced.body.data.rule.inbox_id === ids.inboxA
      && replaced.body.data.replaced_rule_id === scoutRule.body.data.rule.id
      && !!(await q('SELECT disabled_at FROM pm.sender_rules WHERE id = $1', [scoutRule.body.data.rule.id]))[0]?.disabled_at, replaced.body);
    const backToWorkspace = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.scout, {}, { ...ruleBody, action: 'always' });
    check('rules: and its workspace rule over its own inbox rule replaces that one', backToWorkspace.status === 201 && !('inbox_id' in backToWorkspace.body.data.rule)
      && backToWorkspace.body.data.replaced_rule_id === replaced.body.data.rule.id
      && !!(await q('SELECT disabled_at FROM pm.sender_rules WHERE id = $1', [replaced.body.data.rule.id]))[0]?.disabled_at, backToWorkspace.body);
    const otherAgentsRule = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.atlas, {}, { ...ruleBody, action: 'fyi', inbox_id: ids.inboxB });
    check('rules: another agent\'s inbox rule leaves this agent\'s workspace rule alone', otherAgentsRule.status === 201 && otherAgentsRule.body.data.replaced_rule_id === null
      && !(await q('SELECT disabled_at FROM pm.sender_rules WHERE id = $1', [backToWorkspace.body.data.rule.id]))[0]?.disabled_at, otherAgentsRule.body);
    // A person's rule for inbox B blocks an agent's rule for B, never one for A.
    await q("INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, reason, scope, inbox_id) VALUES ('domain', 'person.example', NULL, 'always', 'person', '', 'inbox', $1)", [ids.inboxB]);
    const besidePerson = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.scout, {}, { ...ruleBody, match_value: 'person.example', scope: 'inbox', inbox_id: ids.inboxA });
    check('rules: a person\'s rule for another inbox does not block this one', besidePerson.status === 201 && besidePerson.body.data.rule.inbox_id === ids.inboxA, besidePerson.body);
    const overPerson = await call(rulesRoute.POST, 'POST', '/api/v1/inbox/sender-rules', keys.atlas, {}, { ...ruleBody, match_value: 'person.example', inbox_id: ids.inboxB });
    check('rules: a person\'s rule for that inbox blocks it (409 person_rule)', overPerson.status === 409 && reason(overPerson) === 'person_rule' && overPerson.body.error.details.rule.scope === 'inbox', overPerson.body);

    const listed = await call(rulesRoute.GET, 'GET', '/api/v1/inbox/sender-rules', keys.atlas);
    const everyRule = (await q<{ n: number }>('SELECT count(*)::int AS n FROM pm.sender_rules WHERE disabled_at IS NULL'))[0].n;
    check('rules: GET without inbox_id lists every live rule', listed.status === 200 && listed.body.data.length === everyRule, [listed.body.data?.length, everyRule]);
    check('rules: workspace rules answer without scope fields', listed.body.data.filter((r: Loose) => !r.inbox_id).every((r: Loose) => !('scope' in r) && !('inbox_id' in r)));
    const forInboxB = await call(rulesRoute.GET, 'GET', `/api/v1/inbox/sender-rules?inbox_id=${ids.inboxB}`, keys.atlas);
    check('rules: GET with inbox_id lists the workspace\'s and that inbox\'s', forInboxB.status === 200 && forInboxB.body.data.every((r: Loose) => !r.inbox_id || r.inbox_id === ids.inboxB)
      && forInboxB.body.data.some((r: Loose) => r.inbox_id === ids.inboxB) && forInboxB.body.data.length < listed.body.data.length, forInboxB.body.data?.map((r: Loose) => [r.match_value, r.inbox_id]));
    const deniedList = await call(rulesRoute.GET, 'GET', `/api/v1/inbox/sender-rules?inbox_id=${ids.inboxB}`, keys.scout);
    check('rules: GET for an inbox the key cannot read is refused', deniedList.status === 403, deniedList.body);

    // Ingestion: a rule for one inbox sorts only that inbox's mail.
    await q("INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, reason, scope, inbox_id) VALUES ('address', 'pitch@vendor.example', NULL, 'ignore', 'person', 'Pitches.', 'inbox', $1)", [ids.inboxA]);
    const [routes] = await q('SELECT (SELECT routing_address FROM pm.inboxes WHERE id = $1) AS a, (SELECT routing_address FROM pm.inboxes WHERE id = $2) AS b', [ids.inboxA, ids.inboxB]);
    const deliverTo = async (to: string, n: number) => ingestInbound(service, {
      provider: 'test', provider_email_id: `pitch-${n}`, received_at: new Date().toISOString(), delivered_to: [to], message_id: `<pitch-${n}@vendor.example>`,
      in_reply_to: [], references: [], subject: 'Grow your sales 10x', date: new Date().toISOString(),
      from: { address: 'pitch@vendor.example', name: 'Vendor' }, to: [{ address: to, name: '' }], cc: [], reply_to: [], headers: [],
      text: 'Hello, we help agencies grow. Book a call?', html: null, provider_auth: null, raw: null, attachments: [],
    });
    await deliverTo(routes.a, 1);
    await deliverTo(routes.b, 2);
    const sorted = await q<{ inbox_id: string; status: string; sender_rule_id: string | null }>("SELECT inbox_id, status, sender_rule_id FROM pm.messages WHERE internet_message_id IN ('<pitch-1@vendor.example>', 'pitch-1@vendor.example', '<pitch-2@vendor.example>', 'pitch-2@vendor.example')");
    const inA = sorted.find((r) => r.inbox_id === ids.inboxA);
    const inB = sorted.find((r) => r.inbox_id === ids.inboxB);
    check('ingest: the inbox\'s own rule filters its mail', inA?.status === 'ignored' && !!inA.sender_rule_id, sorted);
    check('ingest: the same mail to another inbox is not touched by it', !!inB && inB.status !== 'ignored' && inB.sender_rule_id === null, sorted);

    // A person's workspace rule made after an agent's inbox rule wins: the agent's is switched off, and ingestion uses the person's.
    const ownerCtx = { service, access: (await resolveMemberAccess(service, ids.owner))!, memberId: ids.owner };
    // The agent's rule covers every topic (as a rule from before agent rules named one may), so the match never hangs on how the mail is sorted.
    const agentDealId = (await q<{ id: string }>("INSERT INTO pm.sender_rules (match_kind, match_value, topic, action, source, reason, created_by, scope, inbox_id) VALUES ('address', 'deal@vendor.example', NULL, 'always', 'agent', 'Deals are read in full.', $1, 'inbox', $2) RETURNING id", [ids.scout, ids.inboxA]))[0].id;
    const agentDeal = { status: 201, body: { data: { rule: { id: agentDealId } } } };
    const { createSenderRule } = await import('../src/lib/communications/inbox-rules');
    const personDeal = await createSenderRule(ownerCtx, { match_kind: 'address', match_value: 'deal@vendor.example', topic: null, action: 'ignore', reason: '', thread_id: null });
    check('person wins: a person\'s workspace rule switches off the agent\'s rule for that inbox', agentDeal.status === 201
      && !!(await q('SELECT disabled_at FROM pm.sender_rules WHERE id = $1', [agentDeal.body.data.rule.id]))[0]?.disabled_at && personDeal.rule.scope === 'workspace', [agentDeal.body, personDeal.rule]);
    // Even with the agent's inbox rule live again (as older data may have it), sorting ranks the person's first.
    await q('UPDATE pm.sender_rules SET disabled_at = NULL, disabled_by = NULL WHERE id = $1', [agentDeal.body.data.rule.id]);
    await ingestInbound(service, {
      provider: 'test', provider_email_id: 'deal-1', received_at: new Date().toISOString(), delivered_to: [routes.a], message_id: '<deal-1@vendor.example>',
      in_reply_to: [], references: [], subject: '50% off this week only', date: new Date().toISOString(),
      from: { address: 'deal@vendor.example', name: 'Vendor' }, to: [{ address: routes.a, name: '' }], cc: [], reply_to: [], headers: [],
      text: 'Big sale: 50% off everything this week. Unsubscribe here.', html: null, provider_auth: null, raw: null, attachments: [],
    });
    const deal = (await q<{ status: string; sender_rule_id: string | null; topic: string | null }>("SELECT status, sender_rule_id, topic FROM pm.messages WHERE internet_message_id IN ('<deal-1@vendor.example>', 'deal-1@vendor.example')"))[0];
    check('person wins: through ingestion the person\'s rule sorts the mail, not the agent\'s', deal?.sender_rule_id === personDeal.rule.id && deal.status === 'ignored', [deal, personDeal.rule.id, agentDeal.body?.data?.rule?.id]);
    await q('UPDATE pm.sender_rules SET disabled_at = now() WHERE id = $1', [agentDeal.body.data.rule.id]);

    // Senders: per inbox, only the rules that sort its mail.
    const sendersA = await call(sendersRoute.GET, 'GET', `/api/v1/inbox/senders?days=30&inbox_id=${ids.inboxA}`, keys.atlas);
    const sendersB = await call(sendersRoute.GET, 'GET', `/api/v1/inbox/senders?days=30&inbox_id=${ids.inboxB}`, keys.atlas);
    const pitchA = (sendersA.body?.data?.senders ?? []).find((s: Loose) => s.address === 'pitch@vendor.example');
    const pitchB = (sendersB.body?.data?.senders ?? []).find((s: Loose) => s.address === 'pitch@vendor.example');
    check('senders: inbox_id shows that inbox\'s mail and the rules that sort it', pitchA?.count === 1 && pitchA.rules.length === 1 && pitchB?.count === 1 && pitchB.rules.length === 0, [pitchA, pitchB]);

    // ── handled=me ─────────────────────────────────────────────────────────
    await q("UPDATE pm.messages SET received_at = now() - interval '1 hour' WHERE inbox_id IN ($1, $2)", [ids.inboxA, ids.inboxB]);
    await q("UPDATE pm.conversations SET last_message_at = now() - interval '1 hour' WHERE inbox_id IN ($1, $2)", [ids.inboxA, ids.inboxB]);
    const queueAll = await call(queueRoute.GET, 'GET', '/api/v1/inbox/queue?limit=100', keys.gale);
    const queueMine = await call(queueRoute.GET, 'GET', '/api/v1/inbox/queue?limit=100&handled=me', keys.gale);
    check('handled: without it, the queue covers every readable inbox', queueAll.status === 200 && queueAll.body.data.messages.some((m: Loose) => m.inbox_id === ids.inboxA) && queueAll.body.data.messages.some((m: Loose) => m.inbox_id === ids.inboxB), queueAll.body);
    check('handled: an agent that handles nothing sees an empty queue', queueMine.status === 200 && queueMine.body.data.messages.length === 0, queueMine.body);
    await q('INSERT INTO pm.inbox_handlers (inbox_id, handler_group_id) VALUES ($1, $2)', [ids.inboxB, ids.bots]);
    const queueGroup = await call(queueRoute.GET, 'GET', '/api/v1/inbox/queue?limit=100&handled=me', keys.gale);
    check('handled: through a group, only that inbox', queueGroup.body.data.messages.length > 0 && queueGroup.body.data.messages.every((m: Loose) => m.inbox_id === ids.inboxB), queueGroup.body);
    const signalAll = await call(signalRoute.GET, 'GET', '/api/v1/inbox/signal', keys.gale);
    const signalMine = await call(signalRoute.GET, 'GET', '/api/v1/inbox/signal?handled=me', keys.gale);
    check('handled: the signal counts only handled inboxes', signalAll.status === 200 && signalMine.status === 200 && signalMine.body.data.plans_new_count < signalAll.body.data.plans_new_count
      && JSON.stringify(Object.keys(signalMine.body.data)) === JSON.stringify(Object.keys(signalAll.body.data)), [signalAll.body.data, signalMine.body.data]);
    await q("INSERT INTO pm.reply_drafts (thread_id, message_id, instructions) VALUES ($1, $2, 'Say yes'), ($3, $4, 'Say no')", [toScout.conversation, toScout.message, fromMiaB.conversation, fromMiaB.message]);
    const draftsAll = await call(draftsRoute.GET, 'GET', '/api/v1/inbox/reply-drafts', keys.gale);
    const draftsMine = await call(draftsRoute.GET, 'GET', '/api/v1/inbox/reply-drafts?handled=me', keys.gale);
    check('handled: reply drafts only from handled inboxes', draftsAll.body.data.length === 2 && draftsMine.body.data.length === 1 && draftsMine.body.data[0].message_id === fromMiaB.message, [draftsAll.body.data, draftsMine.body.data]);
    const badHandled = await call(queueRoute.GET, 'GET', '/api/v1/inbox/queue?handled=everyone', keys.gale);
    check('handled: another value is refused', badHandled.status === 400, badHandled.body);

    // ── MCP: the optional params reach the routes ──────────────────────────
    const tool = async (key: string, memberId: string, name: string, args: Record<string, unknown>) => {
      const t = PM_TOOLS.find((candidate) => candidate.name === name)!;
      return outcomeResult(await t.run(t.input.parse(args) as Record<string, unknown>, routeCaller({ key, origin: 'http://localhost' }), { memberId }), t.write).structuredContent as Loose;
    };
    const mcpQueue = await tool(keys.gale, ids.gale, 'get_triage_queue', { handled: 'me', limit: 100 });
    check('mcp: get_triage_queue takes handled', mcpQueue.ok === true && mcpQueue.data.messages.every((m: Loose) => m.inbox_id === ids.inboxB), mcpQueue);
    const mcpRules = await tool(keys.atlas, ids.atlas, 'list_sender_rules', { inbox_id: ids.inboxB });
    const restRulesB = await call(rulesRoute.GET, 'GET', `/api/v1/inbox/sender-rules?inbox_id=${ids.inboxB}`, keys.atlas);
    check('mcp: list_sender_rules takes inbox_id', mcpRules.ok === true && normalized(mcpRules.data) === normalized(restRulesB.body.data), mcpRules);
    const mcpRule = await tool(keys.scout, ids.scout, 'add_sender_rule', { ...ruleBody, match_value: 'mcp.example', scope: 'workspace' });
    check('mcp: add_sender_rule takes scope', mcpRule.ok === true && mcpRule.data.rule.scope === undefined, mcpRule);
    for (const name of ['list_reply_drafts', 'get_inbox_signal']) {
      check(`mcp: ${name} takes handled`, PM_TOOLS.find((t) => t.name === name)!.input.safeParse({ handled: 'me' }).success);
    }
    check('mcp: notify_owner takes an inbox', PM_TOOLS.find((t) => t.name === 'notify_owner')!.input.safeParse({ title: 'x', message: 'y', message_id: randomUUID() }).success);

    // ── Settings: handlers and defaults ────────────────────────────────────
    const owner = { service, access: (await resolveMemberAccess(service, ids.owner))!, memberId: ids.owner };
    const before = (await settings.listInboxSettings(owner)).inboxes.find((i) => i.id === ids.inboxC)!;
    check('settings: an inbox with no handler shows none and no defaults', before.handlers.length === 0 && before.default_assignee_member_id === null && before.decision_group_id === null, before);
    // The full input for an inbox as saved (what the settings form sends), without the new optional fields.
    const inboxInput = (inbox: typeof before) => ({
      name: inbox.name, address: inbox.address, routing_local_part: inbox.routing_local_part, routing_domain: inbox.routing_domain,
      handler_member_id: inbox.handler_member_id, enabled: inbox.enabled, retention_days: inbox.retention_days, max_attachment_mb: inbox.max_attachment_mb,
      agent_readable_types: inbox.agent_readable_types, summary_interval_minutes: inbox.summary_interval_minutes, filter_auto_mail: inbox.filter_auto_mail,
      triage_mode: inbox.triage_mode, access_member_ids: inbox.access_member_ids,
    });
    const saved = await settings.updateInbox(owner, ids.inboxC, {
      ...inboxInput(before), handler_member_id: ids.gale, access_member_ids: [ids.gale],
      handlers: [{ member_id: ids.atlas }, { group_id: ids.support }],
      default_assignee_group_id: ids.support, default_project_id: ids.acme, decision_member_id: ids.mia,
    });
    const handlerKey = (h: { member_id: string | null; group_id: string | null; is_primary: boolean }) => `${h.is_primary ? 'P' : 'o'}:${h.member_id ?? ''}:${h.group_id ?? ''}`;
    check('settings: the primary first, then the other handlers', saved.handler_member_id === ids.gale && saved.handlers[0]?.is_primary === true
      && JSON.stringify(saved.handlers.map(handlerKey).sort()) === JSON.stringify([`P:${ids.gale}:`, `o:${ids.atlas}:`, `o::${ids.support}`].sort()), saved.handlers);
    check('settings: defaults are saved', saved.default_assignee_group_id === ids.support && saved.default_assignee_member_id === null && saved.default_project_id === ids.acme && saved.decision_member_id === ids.mia, saved);
    check('settings: member handlers read it, though not listed; the group\'s members read it through the group, with no grant', [ids.gale, ids.atlas].every((m) => saved.access_member_ids.includes(m))
      && ![ids.mia, ids.nina].some((m) => saved.access_member_ids.includes(m)), saved.access_member_ids);
    const resaved = await settings.updateInbox(owner, ids.inboxC, { ...inboxInput(saved), access_member_ids: [] });
    check('settings: a save that leaves handlers and defaults out keeps them', resaved.handlers.length === 3 && resaved.default_project_id === ids.acme && resaved.decision_member_id === ids.mia, resaved);
    check('settings: saving who reads it never takes a member handler\'s access away', [ids.gale, ids.atlas].every((m) => resaved.access_member_ids.includes(m)), resaved.access_member_ids);
    const swapped = await settings.updateInbox(owner, ids.inboxC, { ...inboxInput(resaved), handler_member_id: ids.atlas, handlers: [{ member_id: ids.gale }], default_assignee_group_id: null, decision_member_id: null, decision_group_id: ids.support });
    check('settings: a new primary and a new list', swapped.handler_member_id === ids.atlas
      && JSON.stringify(swapped.handlers.map((h) => [h.member_id, h.is_primary])) === JSON.stringify([[ids.atlas, true], [ids.gale, false]]), swapped.handlers);
    check('settings: picking a group clears the member, and clearing works', swapped.decision_group_id === ids.support && swapped.decision_member_id === null && swapped.default_assignee_group_id === null, swapped);
    const both = await settings.updateInbox(owner, ids.inboxC, { ...inboxInput(swapped), decision_member_id: ids.mia, decision_group_id: ids.support }).then(() => null, (e: { status?: number }) => e.status);
    check('settings: a member and a group at once is refused', both === 422, both);
    const ghostGroup = await settings.updateInbox(owner, ids.inboxC, { ...inboxInput(swapped), handlers: [{ group_id: randomUUID() }] }).then(() => null, (e: { status?: number }) => e.status);
    check('settings: a handler group that does not exist is refused', ghostGroup === 422, ghostGroup);
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'inbound_email.manage', 'app', 'allow') ON CONFLICT DO NOTHING", [ids.adam]);
    const admin = { service, access: (await resolveMemberAccess(service, ids.adam))!, memberId: ids.adam };
    const current = (await settings.listInboxSettings(admin)).inboxes.find((i) => i.id === ids.inboxC)!;
    const adminChanges = await settings.updateInbox(admin, ids.inboxC, { ...inboxInput(current), decision_group_id: null, decision_member_id: ids.mia }).then(() => null, (e: { status?: number }) => e.status);
    check('settings: only an Owner chooses who gets decisions (403 for an Admin)', adminChanges === 403
      && (await q('SELECT decision_group_id, decision_member_id FROM pm.inboxes WHERE id = $1', [ids.inboxC]))[0].decision_group_id === ids.support, adminChanges);
    const adminSame = await settings.updateInbox(admin, ids.inboxC, { ...inboxInput(current), decision_member_id: null, decision_group_id: ids.support, default_project_id: ids.birch });
    check('settings: an Admin sending them unchanged, or leaving them out, still saves the rest', adminSame.default_project_id === ids.birch && adminSame.decision_group_id === ids.support, adminSame);
    const adminOmits = await settings.updateInbox(admin, ids.inboxC, { ...inboxInput(adminSame), default_project_id: null });
    check('settings: and leaving them out keeps them', adminOmits.default_project_id === null && adminOmits.decision_group_id === ids.support, adminOmits);

    // ── No defaults: byte for byte as on a database without the migration ──
    await settle();
    await db.exec(`
      DROP TRIGGER IF EXISTS inboxes_sync_primary_handler ON pm.inboxes;
      DROP TRIGGER IF EXISTS group_members_grant_handled_inboxes ON pm.group_members;
      DROP TABLE pm.inbox_handlers CASCADE;
      ALTER TABLE pm.inboxes DROP COLUMN default_assignee_member_id, DROP COLUMN default_assignee_group_id, DROP COLUMN default_project_id,
        DROP COLUMN decision_member_id, DROP COLUMN decision_group_id;
      DROP INDEX IF EXISTS pm.sender_rules_live_key;
      ALTER TABLE pm.sender_rules DROP COLUMN scope, DROP COLUMN inbox_id;
    `);
    const unmigrated = await runPlan(keys.atlas, ids.inboxB, 'Size chart');
    check('baseline: without the migration the plan applies', unmigrated.answer.status === 201, unmigrated.answer.body);
    check('baseline: with no defaults set, the plan answers byte for byte as without the migration', normalized(plain.answer.body) === normalized(unmigrated.answer.body),
      { withMigration: normalized(plain.answer.body).slice(0, 400), without: normalized(unmigrated.answer.body).slice(0, 400) });
    check('baseline: and assigns and owns exactly the same', JSON.stringify(plain.assignees) === JSON.stringify(unmigrated.assignees)
      && JSON.stringify(plain.reminder) === JSON.stringify(unmigrated.reminder), [plain.assignees, unmigrated.assignees, plain.reminder, unmigrated.reminder]);
    const unmigratedRule = await call(oldRulesRoute.POST, 'POST', '/api/v1/inbound-emails/sender-rules', keys.atlas, {}, { ...ruleBody, match_value: 'later.example' });
    check('baseline: without the migration an agent rule is the workspace\'s and answers as before', unmigratedRule.status === 201
      && JSON.stringify(Object.keys(unmigratedRule.body.data.rule)) === JSON.stringify(atlasKeys), unmigratedRule.body);
    const ownerAfter = { service, access: (await resolveMemberAccess(service, ids.owner))!, memberId: ids.owner };
    const plainInbox = (await settings.listInboxSettings(ownerAfter)).inboxes.find((i) => i.id === ids.inboxB)!;
    const strippedSave = await settings.updateInbox(ownerAfter, ids.inboxB, {
      ...inboxInput(plainInbox), name: 'Atlas desk', handlers: [],
      default_assignee_member_id: null, default_assignee_group_id: null, default_project_id: null, decision_member_id: null, decision_group_id: null,
    }).then((saved) => saved, (e: { status?: number; message?: string }) => ({ failed: e.status ?? e.message }));
    check('baseline: before the migration, a save with no handlers and no defaults (what the form sends) still works', 'name' in strippedSave && strippedSave.name === 'Atlas desk'
      && strippedSave.handlers.length === 1 && strippedSave.handlers[0].member_id === ids.atlas, strippedSave);
    const strippedDefault = await settings.updateInbox(ownerAfter, ids.inboxB, { ...inboxInput(plainInbox), default_project_id: ids.acme }).then(() => null, () => 'refused');
    check('baseline: setting a default before the migration is refused, never silently dropped', strippedDefault === 'refused', strippedDefault);
    const unmigratedQueue = await call(queueRoute.GET, 'GET', '/api/v1/inbox/queue?limit=100&handled=me', keys.atlas);
    check('baseline: without the migration handled=me falls back to the inbox\'s handler', unmigratedQueue.status === 200 && unmigratedQueue.body.data.messages.every((m: Loose) => m.inbox_id === ids.inboxB), unmigratedQueue.body);
  } finally {
    await server.close();
    await db.close();
  }

  console.log(`inbox handlers: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
