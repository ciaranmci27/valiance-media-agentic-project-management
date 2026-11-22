/**
 * Personal inboxes, on the full schema (PGlite), in the database and in the
 * server code that reads with the service client:
 * - the owner reads their personal inbox's mail without inbound_email.read;
 * - an Owner (inbound_email.manage) sees the inbox row and its health but not
 *   its mail while the workspace switch is off, and reads it while it is on;
 * - a teammate the owner granted reads it; nobody else does;
 * - a Member creates personal inboxes only for themselves; someone else's
 *   personal inbox is only turned off or on, never edited;
 * - shared inboxes read exactly as before;
 * - readableInboxIds (the app), memberInboxIds (API keys and agents), the
 *   Settings lists and the people notified follow the same rule;
 * - acting on mail (triage) follows the inbox: the owner acts on their own,
 *   a grantee only with inbound_email.triage, an Owner reading under the
 *   switch never; shared inboxes as before, in the app and through the API;
 * - deleting a member who owns a personal inbox is refused, so it never turns shared;
 * - the audit log (read by Owners and Admins) holds no personal inbox's mail;
 * - a sender rule made from someone's personal thread filters none of it unless the maker may act on it;
 * - the 1.6.0 code reads a 1.5.0 database (before the migration) with every inbox shared.
 * Run with: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-personal-inboxes.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, schemaBeforeMigration } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 600)}`);
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  owner: id(1), mia: id(2), ned: id(3), admin: id(4), scout: id(5), rae: id(6),
  ownerAuth: id(11), miaAuth: id(12), nedAuth: id(13), adminAuth: id(14), raeAuth: id(16),
  shared: id(20), personal: id(21),
  sharedThread: id(30), personalThread: id(31),
  sharedMessage: id(40), personalMessage: id(41),
};
type Who = 'owner' | 'mia' | 'ned' | 'admin' | 'rae';
const AUTH: Record<Who, string> = { owner: ids.ownerAuth, mia: ids.miaAuth, ned: ids.nedAuth, admin: ids.adminAuth, rae: ids.raeAuth };

type Row = Record<string, unknown>;

async function asWho<T>(db: PGlite, who: Who | null, work: () => Promise<T>): Promise<T> {
  await db.exec('RESET ROLE');
  await db.exec('BEGIN');
  try {
    await actAs(db, who ? AUTH[who] : null);
    return await work();
  } finally {
    await db.exec('ROLLBACK');
    await db.exec('RESET ROLE');
  }
}

/** The rows `who` sees, as a signed-in person under RLS. */
const seen = (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  asWho(db, who, async () => (await db.query<Row>(sql, params)).rows);

/** The error a statement raises for `who`, or '' when it succeeds (always rolled back). */
const refusal = (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  asWho(db, who, async () => {
    try {
      const result = await db.query(sql, params);
      return result.affectedRows === 0 ? 'no rows' : '';
    } catch (error) {
      return (error as Error).message;
    }
  });

async function seed(db: PGlite) {
  await db.exec('RESET ROLE');
  // Signing up makes the team member (handle_new_user); each then gets its fixed id and role.
  const people: [Who, string, string, string][] = [
    ['owner', ids.owner, 'Olive', 'owner'], ['mia', ids.mia, 'Mia', 'member'], ['ned', ids.ned, 'Ned', 'member'],
    ['admin', ids.admin, 'Ada', 'admin'], ['rae', ids.rae, 'Rae', 'member'],
  ];
  for (const [who, memberId, name, role] of people) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [AUTH[who], `${who}@agency.example`]);
    await db.query("UPDATE pm.team_members SET id = $2, name = $3, role = $4, status = 'active' WHERE auth_user_id = $1", [AUTH[who], memberId, name, role]);
  }
  await db.query(`INSERT INTO pm.team_members (id, name, email, role, status) VALUES ($1, 'Scout', 'scout@agency.example', 'agent', 'active')`, [ids.scout]);
  await db.query("UPDATE pm.business_settings SET inbound_email_domain = 'relay.example.test'");
  // Rae reads shared inboxes she is granted (inbound_email.read), as an Owner may allow.
  await db.query("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'inbound_email.read', 'app', 'allow')", [ids.rae]);
  await db.query(`INSERT INTO pm.inboxes (id, name, address, handler_member_id) VALUES ($1, 'Scout', 'scout@agency.example', $2)`, [ids.shared, ids.scout]);
  await db.query(`INSERT INTO pm.inboxes (id, name, address, handler_member_id, owner_member_id, created_by)
    VALUES ($1, 'Mia', 'mia@agency.example', $2, $3, $3)`, [ids.personal, ids.scout, ids.mia]);
  // Mia shares her inbox with Ned; Rae and Ada are granted the shared one.
  await db.query('INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES ($1, $2), ($3, $4), ($3, $5), ($3, $6)',
    [ids.personal, ids.ned, ids.shared, ids.rae, ids.admin, ids.mia]);
  for (const [thread, message, inbox] of [[ids.sharedThread, ids.sharedMessage, ids.shared], [ids.personalThread, ids.personalMessage, ids.personal]]) {
    await db.query('INSERT INTO pm.conversations (id, inbox_id) VALUES ($1, $2)', [thread, inbox]);
    await db.query(`INSERT INTO pm.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id, received_at, kind, subject)
      VALUES ($1, $2, $3, 'handled', 'test', $4, $4, '2026-11-20T10:00:00Z', 'person', 'Hello')`, [message, inbox, thread, `m-${message}`]);
  }
}

const setPolicy = async (db: PGlite, on: boolean) => {
  await db.exec('RESET ROLE');
  await db.query('UPDATE pm.business_settings SET owners_read_personal_inboxes = $1', [on]);
};

async function main() {
  const db = await createFullSchemaDatabase();
  await seed(db);

  const messagesOf = async (who: Who) => (await seen(db, who, 'SELECT inbox_id FROM pm.messages ORDER BY inbox_id')).map((r) => r.inbox_id);
  const inboxRows = async (who: Who) => (await seen(db, who, 'SELECT id FROM pm.inboxes ORDER BY id')).map((r) => r.id);

  // ---- Reading, in the database (RLS through can_read_inbox) ---------------
  check('db: the owner reads their personal inbox without inbound_email.read', JSON.stringify(await messagesOf('mia')) === JSON.stringify([ids.personal]),
    await messagesOf('mia'));
  check('db: the owner reads its thread and sees its row', (await seen(db, 'mia', 'SELECT id FROM pm.conversations')).length === 1
    && (await inboxRows('mia')).includes(ids.personal));
  check('db: an Owner sees the personal inbox row (its health) while the switch is off', (await inboxRows('owner')).includes(ids.personal));
  check('db: an Owner does not read its mail while the switch is off', JSON.stringify(await messagesOf('owner')) === JSON.stringify([ids.shared]),
    await messagesOf('owner'));
  check('db: an Owner does not read its thread either', (await seen(db, 'owner', 'SELECT id FROM pm.conversations WHERE id = $1', [ids.personalThread])).length === 0);
  await setPolicy(db, true);
  check('db: with the switch on, an Owner reads personal inboxes', JSON.stringify(await messagesOf('owner')) === JSON.stringify([ids.shared, ids.personal]),
    await messagesOf('owner'));
  check('db: the switch does not open it to an Admin without managing inboxes', !(await messagesOf('admin')).includes(ids.personal));
  await setPolicy(db, false);
  check('db: a teammate the owner shared it with reads it', JSON.stringify(await messagesOf('ned')) === JSON.stringify([ids.personal]), await messagesOf('ned'));
  check('db: someone not granted reads nothing of it', !(await messagesOf('rae')).includes(ids.personal) && !(await inboxRows('rae')).includes(ids.personal));
  check('db: a person granted a personal inbox sees their own grant row only', (await seen(db, 'ned', 'SELECT member_id FROM pm.inbox_access WHERE inbox_id = $1', [ids.personal]))
    .every((r) => r.member_id === ids.ned));
  check('db: the owner sees who reads their inbox; an Owner does not', (await seen(db, 'mia', 'SELECT 1 FROM pm.inbox_access WHERE inbox_id = $1', [ids.personal])).length === 2
    && (await seen(db, 'owner', 'SELECT 1 FROM pm.inbox_access WHERE inbox_id = $1', [ids.personal])).length === 0);

  // Shared inboxes, as before.
  check('db: shared: an Owner reads every shared inbox', (await messagesOf('owner')).includes(ids.shared));
  check('db: shared: a granted reader with inbound_email.read reads it', JSON.stringify(await messagesOf('rae')) === JSON.stringify([ids.shared]), await messagesOf('rae'));
  check('db: shared: a grant without inbound_email.read reads nothing (Mia)', !(await messagesOf('mia')).includes(ids.shared));
  check('db: shared: an Admin granted it reads it', (await messagesOf('admin')).includes(ids.shared));
  check('db: shared: Ned (no grant, no read) reads none of it', !(await messagesOf('ned')).includes(ids.shared));

  // The Inbox switched off: nobody reads a personal inbox.
  await db.exec("RESET ROLE; UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'inbox'");
  check('db: with the Inbox module off, the owner reads nothing', (await messagesOf('mia')).length === 0 && (await messagesOf('ned')).length === 0);
  await db.exec("RESET ROLE; UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'inbox'");

  // ---- Writing, in the database ---------------------------------------------
  const insertPersonal = `INSERT INTO pm.inboxes (name, address, owner_member_id) VALUES ('X', $1, $2)`;
  check('db: a Member creates a personal inbox for themselves', await refusal(db, 'mia', insertPersonal, ['mia.two@agency.example', ids.mia]) === '');
  check('db: a Member cannot create one for someone else', (await refusal(db, 'mia', insertPersonal, ['ned.two@agency.example', ids.ned])).includes('row-level security'));
  check('db: a Member cannot create a shared inbox', (await refusal(db, 'mia', "INSERT INTO pm.inboxes (name, address) VALUES ('X', 'shared.two@agency.example')")).includes('row-level security'));
  check('db: the owner changes their own inbox', await refusal(db, 'mia', "UPDATE pm.inboxes SET address = 'mia.new@agency.example' WHERE id = $1", [ids.personal]) === '');
  check('db: an Owner cannot change someone\'s personal inbox', (await refusal(db, 'owner', "UPDATE pm.inboxes SET address = 'x@agency.example' WHERE id = $1", [ids.personal])).includes('Only its owner'));
  check('db: an Owner cannot hand it to someone else', (await refusal(db, 'owner', 'UPDATE pm.inboxes SET owner_member_id = $2 WHERE id = $1', [ids.personal, ids.owner])).includes('never changes hands'));
  check('db: an Owner may turn it off (offboarding)', await refusal(db, 'owner', 'UPDATE pm.inboxes SET enabled = false WHERE id = $1', [ids.personal]) === '');
  check('db: an Owner cannot grant access to it', (await refusal(db, 'owner', 'INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES ($1, $2)', [ids.personal, ids.owner])).includes('row-level security'));
  check('db: the owner grants access to it', await refusal(db, 'mia', 'INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES ($1, $2)', [ids.personal, ids.rae]) === '');
  check('db: an Owner still manages shared inboxes', await refusal(db, 'owner', "UPDATE pm.inboxes SET name = 'Scout 2' WHERE id = $1", [ids.shared]) === ''
    && await refusal(db, 'owner', 'INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES ($1, $2)', [ids.shared, ids.ned]) === '');
  check('db: an Owner cannot turn a shared inbox into a personal one', (await refusal(db, 'owner', 'UPDATE pm.inboxes SET owner_member_id = $2 WHERE id = $1', [ids.shared, ids.owner])).includes('never changes hands'));
  check('db: the owner cannot hand their inbox to the company (make it shared)', (await refusal(db, 'mia', 'UPDATE pm.inboxes SET owner_member_id = NULL WHERE id = $1', [ids.personal])) !== '');
  // Team members are never hard-deleted (forbid_hard_delete); with that guard
  // lifted, as a future cleanup might, the inbox itself still refuses.
  await db.exec('RESET ROLE');
  await db.exec('BEGIN');
  let deleteOwner = '';
  try {
    await db.exec('ALTER TABLE pm.team_members DISABLE TRIGGER forbid_hard_delete');
    await db.query('DELETE FROM pm.team_members WHERE id = $1', [ids.mia]);
  } catch (error) {
    deleteOwner = (error as Error).message;
  } finally {
    await db.exec('ROLLBACK');
  }
  check('db: deleting a member who owns a personal inbox is refused', deleteOwner.includes('foreign key') && deleteOwner.includes('inboxes'), deleteOwner);
  check('db: the personal inbox stays theirs', (await db.query<Row>('SELECT owner_member_id FROM pm.inboxes WHERE id = $1', [ids.personal])).rows[0]?.owner_member_id === ids.mia);

  // ---- The service-side rule ---------------------------------------------------
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const visibility = await import('../src/lib/communications/inbox-visibility');
    const inbox = await import('../src/lib/communications/inbox-service');
    const agentAccess = await import('../src/lib/communications/agent-access');
    const settings = await import('../src/lib/communications/inbox-settings-service');
    const service = getServiceClient();
    const ctxOf = async (memberId: string) => ({ service, memberId, access: (await resolveMemberAccess(service, memberId))! });
    const status = async (work: () => Promise<unknown>) => {
      try { await work(); return 0; } catch (error) { const value = error as { status?: number; statusCode?: number }; return value.status ?? value.statusCode ?? -1; }
    };
    const sorted = (list: string[]) => JSON.stringify([...list].sort());

    const [owner, mia, ned, rae, scout, admin] = await Promise.all([ctxOf(ids.owner), ctxOf(ids.mia), ctxOf(ids.ned), ctxOf(ids.rae), ctxOf(ids.scout), ctxOf(ids.admin)]);
    check('app: the owner reads their personal inbox', sorted(await inbox.readableInboxIds(mia)) === sorted([ids.personal]), await inbox.readableInboxIds(mia));
    check('app: an Owner reads shared inboxes only, while the switch is off', sorted(await inbox.readableInboxIds(owner)) === sorted([ids.shared]));
    await setPolicy(db, true);
    check('app: with the switch on, an Owner reads personal inboxes too', sorted(await inbox.readableInboxIds(owner)) === sorted([ids.shared, ids.personal]));
    await setPolicy(db, false);
    check('app: a granted teammate reads it', sorted(await inbox.readableInboxIds(ned)) === sorted([ids.personal]));
    check('app: shared: a granted reader reads the shared inbox, not the personal one', sorted(await inbox.readableInboxIds(rae)) === sorted([ids.shared]));
    const thread = await status(() => inbox.threadDetail(owner, ids.personalThread));
    check('app: an Owner opening a personal thread gets 404 while the switch is off', thread === 404, thread);
    const own = await inbox.listThreads(mia, { inboxId: null, projectId: null, tab: 'everything', search: '', limit: 50, offset: 0 });
    check('app: the owner lists their thread, under "Your inbox"', own.threads.some((t) => t.id === ids.personalThread && t.inbox_name === 'Your inbox')
      && own.inboxes.some((i) => i.owner?.id === ids.mia) && own.owners_read_personal === false, own.threads.map((t) => t.inbox_name));
    const shared = await inbox.listThreads(ned, { inboxId: null, projectId: null, tab: 'everything', search: '', limit: 50, offset: 0 });
    check('app: a teammate it was shared with lists it as "<Name>\'s inbox"', shared.threads.length === 1 && shared.threads[0].inbox_name === "Mia's inbox",
      shared.threads.map((t) => t.inbox_name));

    // Acting on mail (triage) follows the inbox.
    const handle = (ctx: typeof mia, threadId: string) => status(() => inbox.markThreadHandled(ctx, threadId));
    check('triage: the owner acts on their own inbox without inbound_email.triage', await handle(mia, ids.personalThread) === 0);
    check('triage: the owner\'s thread says they may act on it', (await inbox.threadDetail(mia, ids.personalThread)).can_triage === true);
    check('triage: a grantee without inbound_email.triage reads but cannot act', await handle(ned, ids.personalThread) === 403
      && (await inbox.threadDetail(ned, ids.personalThread)).can_triage === false);
    await setPolicy(db, true);
    check('triage: an Owner reading under the switch cannot act, even managing inboxes', await handle(owner, ids.personalThread) === 403
      && (await inbox.threadDetail(owner, ids.personalThread)).can_triage === false);
    check('triage: under the switch, the Owners are still not notified', !(await visibility.inboxPeopleIds(service, ids.personal)).includes(ids.owner));
    await setPolicy(db, false);
    await db.exec('RESET ROLE');
    await db.query("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'inbound_email.triage', 'app', 'allow')", [ids.ned]);
    const nedTriage = await ctxOf(ids.ned);
    check('triage: a grantee with inbound_email.triage acts on it', await handle(nedTriage, ids.personalThread) === 0);
    check('triage: shared: an Owner acts, a reader without triage cannot, as before', await handle(owner, ids.sharedThread) === 0
      && await handle(rae, ids.sharedThread) === 403 && (await inbox.threadDetail(rae, ids.sharedThread)).can_triage === false);
    check('triage: shared: holding triage without reading it is still 404', await handle(nedTriage, ids.sharedThread) === 404);
    check('triage: shared: the owner of a personal inbox gains nothing on shared ones', await handle(mia, ids.sharedThread) === 404);
    const triager = { memberId: ids.owner, moduleOn: true, manage: true, triage: true, personal: true, granted: new Set<string>() };
    check('rule: triage on a personal inbox is its owner\'s, or a grantee\'s with triage, never managing as such',
      !visibility.triagesInbox({ id: ids.personal, owner_member_id: ids.mia }, triager)
      && visibility.triagesInbox({ id: ids.personal, owner_member_id: ids.mia }, { ...triager, granted: new Set([ids.personal]) })
      && !visibility.triagesInbox({ id: ids.personal, owner_member_id: ids.mia }, { ...triager, triage: false, granted: new Set([ids.personal]) })
      && visibility.triagesInbox({ id: ids.personal, owner_member_id: ids.owner }, { ...triager, triage: false, manage: false })
      && visibility.triagesInbox({ id: ids.shared, owner_member_id: null }, { ...triager, triage: false }));

    // A sender rule made from a thread filters that thread's open mail now, which acts on it.
    const rules = await import('../src/lib/communications/inbox-rules');
    await db.exec('RESET ROLE');
    await db.query("UPDATE pm.messages SET status = 'new' WHERE id = $1", [ids.personalMessage]);
    await db.query("INSERT INTO pm.participants (message_id, kind, address) VALUES ($1, 'from', 'pitch@vendor.example')", [ids.personalMessage]);
    await setPolicy(db, true);
    const ruleUnderSwitch = await status(() => rules.createSenderRule(owner, {
      match_kind: 'address', match_value: 'pitch@vendor.example', topic: null, action: 'ignore', reason: 'Pitch', thread_id: ids.personalThread,
    }));
    await setPolicy(db, false);
    await db.exec('RESET ROLE');
    const afterRule = (await db.query<Row>('SELECT status FROM pm.messages WHERE id = $1', [ids.personalMessage])).rows[0];
    check('rules: an Owner under the switch cannot filter someone\'s personal thread through a rule', ruleUnderSwitch === 403 && afterRule.status === 'new', { ruleUnderSwitch, afterRule });

    // API keys and agents.
    check('api: a key managing inboxes reads shared inboxes, not personal ones', sorted(await agentAccess.memberInboxIds(service, ids.owner, owner.access)) === sorted([ids.shared]));
    check('api: the handler agent reads the personal inbox it sorts', sorted(await agentAccess.memberInboxIds(service, ids.scout, scout.access)) === sorted([ids.shared, ids.personal]));
    const denied = await status(() => agentAccess.loadAccessibleMessage(service, ids.owner, owner.access, ids.personalMessage));
    check('api: the owner\'s key asking for a personal email by id gets 404', denied === 404, denied);
    await setPolicy(db, true);
    check('api: with the switch on, a key managing inboxes reads them', sorted(await agentAccess.memberInboxIds(service, ids.owner, owner.access)) === sorted([ids.shared, ids.personal]));
    const keyTriage = await status(() => agentAccess.loadTriageableMessage(service, ids.owner, owner.access, ids.personalMessage));
    check('api: but acts on none of them (403 inbox_triage)', keyTriage === 403
      && sorted(await agentAccess.memberTriageInboxIds(service, ids.owner, owner.access)) === sorted([ids.shared]), keyTriage);
    await setPolicy(db, false);
    check('api: the handler agent (triage on api, granted) acts on the personal inbox it sorts',
      (await agentAccess.loadTriageableMessage(service, ids.scout, scout.access, ids.personalMessage)).id === ids.personalMessage
      && sorted(await agentAccess.memberTriageInboxIds(service, ids.scout, scout.access)) === sorted([ids.shared, ids.personal]));

    // The pure rule.
    const reader = { memberId: ids.owner, moduleOn: true, manage: true, sharedGrants: true, ownersReadPersonal: false, granted: new Set<string>() };
    check('rule: managing reads a shared inbox, not a personal one, until the switch is on',
      visibility.readsInbox({ id: ids.shared, owner_member_id: null }, reader) && !visibility.readsInbox({ id: ids.personal, owner_member_id: ids.mia }, reader)
      && visibility.readsInbox({ id: ids.personal, owner_member_id: ids.mia }, { ...reader, ownersReadPersonal: true }));

    // Who is told when something in it waits on a person.
    check('notify: a personal inbox tells its owner and the people granted, not the Owners', sorted(await visibility.inboxPeopleIds(service, ids.personal)) === sorted([ids.mia, ids.ned]),
      await visibility.inboxPeopleIds(service, ids.personal));
    check('notify: a shared inbox tells the Owners and the people granted', sorted(await visibility.inboxPeopleIds(service, ids.shared)) === sorted([ids.owner, ids.rae, ids.admin, ids.mia]));

    // Settings.
    const list = await settings.listInboxSettings(owner);
    const health = list.personal?.find((row) => row.id === ids.personal) as Row | undefined;
    check('settings: Owners get shared inboxes in full and personal ones as health only',
      list.inboxes.every((row) => row.owner_member_id === null) && !!health && (health.owner as Row).name === 'Mia'
      && !('routing_address' in health) && !('access_member_ids' in health) && !('verification_code' in health) && list.owners_read_personal === false, health);
    check('settings: an Owner cannot edit a personal inbox', await status(() => settings.updateInbox(owner, ids.personal, {
      name: 'X', address: 'x@agency.example', routing_local_part: '', routing_domain: '', handler_member_id: null, enabled: true, retention_days: 90,
      max_attachment_mb: 25, agent_readable_types: ['pdf'], summary_interval_minutes: 30, filter_auto_mail: true, access_member_ids: [],
    })) === 403);
    const off = await settings.setPersonalInboxEnabled(owner, ids.personal, false);
    check('settings: an Owner turns a personal inbox off', off.enabled === false);
    await settings.setPersonalInboxEnabled(owner, ids.personal, true);
    const created = await settings.createMyInbox(ned, { address: 'ned@partner.example', handler_member_id: ids.scout, enabled: true, access_member_ids: [] });
    check('settings: a Member connects their own inbox, owned by them, its agent granted', created.owner_member_id === ids.ned && created.access_member_ids.includes(ids.scout));
    check('settings: their list holds only their own', (await settings.listMyInboxes(ned)).inboxes.every((row) => row.owner_member_id === ids.ned));
    check('settings: nobody edits another member\'s inbox through Your inbox', await status(() => settings.updateMyInbox(ned, ids.personal, {
      address: 'x@agency.example', handler_member_id: null, enabled: true, access_member_ids: [],
    })) === 404);
    check('settings: a person agent cannot be the handler', await status(() => settings.createMyInbox(ned, {
      address: 'ned2@partner.example', handler_member_id: ids.mia, enabled: true, access_member_ids: [],
    })) === 422);
    check('settings: an agent cannot connect one', await status(() => settings.createMyInbox(scout, {
      address: 'scout2@partner.example', handler_member_id: null, enabled: true, access_member_ids: [],
    })) === 403);
    check('settings: a Member cannot change the workspace switch', await status(() => settings.setOwnersReadPersonal(mia, true)) === 403);
    // An Admin who does manage business settings (the default for the role in production).
    const settingsAdmin = { ...admin, access: { ...admin.access, app_permissions: [...admin.access.app_permissions, 'settings.manage' as const] } };
    check('settings: nor can an Admin who manages business settings', await status(() => settings.setOwnersReadPersonal(settingsAdmin, true)) === 403);
    check('settings: an Owner changes it', (await settings.setOwnersReadPersonal(owner, true)).owners_read_personal === true
      && (await settings.listMyInboxes(mia)).owners_read_personal === true);
    await settings.removeMyInbox(ned, created.id);
    check('settings: an empty inbox of your own can be removed', !(await settings.listMyInboxes(ned)).inboxes.some((row) => row.id === created.id));
    check('settings: one that holds mail cannot', await status(() => settings.removeMyInbox(mia, ids.personal)) === 409);

    // The audit log: Owners and Admins read it (audit.read), so a personal inbox's triage leaves ids and the outcome only.
    const triageRoute = await import('../src/app/api/v1/inbound-emails/[id]/triage/route');
    const key = 'pk_live_personal_inbox_audit_key';
    await db.exec('RESET ROLE');
    // The rate limit as one row the client reads (as the other API tests stand it in).
    await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
      CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
      RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
        'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
    await db.query(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes) VALUES ('Scout', 'pk_live', $1, $2, $3)`,
      [createHash('sha256').update(key).digest('hex'), ids.scout, ['inbound_email.read', 'inbound_email.triage']]);
    const triageAs = async (messageId: string, summary: string) => {
      const response = await triageRoute.POST(new NextRequest(`http://localhost/api/v1/inbound-emails/${messageId}/triage`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: 'needs_human', urgent: false, summary, question_for_human: `Ask about ${summary}` }),
      }), { params: Promise.resolve({ id: messageId }) as Promise<never> });
      return response.status;
    };
    const auditFor = async (messageId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await db.exec('RESET ROLE');
      return (await db.query<Row>("SELECT request_body, before_snapshot, after_snapshot FROM pm.api_audit_log WHERE endpoint = $1", [`/api/v1/inbound-emails/${messageId}/triage`])).rows;
    };
    const personalStatus = await triageAs(ids.personalMessage, 'SECRET-PERSONAL-SUMMARY');
    const personalAudit = await auditFor(ids.personalMessage);
    check('audit: a personal inbox\'s triage is logged with ids and the outcome, no mail', personalStatus === 201 && personalAudit.length === 1
      && personalAudit[0].request_body === null && personalAudit[0].before_snapshot === null
      && !JSON.stringify(personalAudit[0]).includes('SECRET') && (personalAudit[0].after_snapshot as Row)?.outcome === 'needs_human', { personalStatus, personalAudit });
    const sharedStatus = await triageAs(ids.sharedMessage, 'SECRET-SHARED-SUMMARY');
    const sharedAudit = await auditFor(ids.sharedMessage);
    check('audit: a shared inbox\'s triage is logged in full, as before', sharedStatus === 201 && sharedAudit.length === 1
      && JSON.stringify(sharedAudit[0].request_body).includes('SECRET-SHARED-SUMMARY'), { sharedStatus, sharedAudit });
  } finally {
    await server.close();
  }

  // ---- The 1.6.0 code on a 1.5.0 database (before db:migrate) -------------------
  await legacyDatabase();

  if (failures.length) {
    console.error(`personal inboxes: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`personal inboxes: ${passed} checks passed.`);
  }
}

/**
 * The 1.5.0 schema (the commit before this release), with no owner column and
 * no workspace switch: the Inbox, its settings and the API read every inbox as
 * shared, as 1.5.0 did, instead of failing. Since 2.0 the code reads schema pm
 * only, so the 1.5.0 database is moved into pm first (the 2.0 move on its
 * own, without the personal inbox migration).
 */
async function legacyDatabase() {
  let legacy: PGlite;
  try {
    legacy = await createFullSchemaDatabase({ schemaSql: schemaBeforeMigration('20261121060000_personal_inboxes.sql') });
  } catch (error) {
    failures.push(`legacy: could not build the 1.5.0 schema: ${(error as Error).message}`);
    return;
  }
  await legacy.exec('RESET ROLE');
  await legacy.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ids.ownerAuth, 'owner@agency.example']);
  await legacy.query("UPDATE public.team_members SET id = $2, name = 'Olive', role = 'owner', status = 'active' WHERE auth_user_id = $1", [ids.ownerAuth, ids.owner]);
  await legacy.query(`INSERT INTO public.team_members (id, name, email, role, status) VALUES ($1, 'Scout', 'scout@agency.example', 'agent', 'active')`, [ids.scout]);
  await legacy.query("UPDATE public.business_settings SET inbound_email_domain = 'relay.example.test'");
  await legacy.query(`INSERT INTO communications.inboxes (id, name, address, handler_member_id) VALUES ($1, 'Scout', 'scout@agency.example', $2)`, [ids.shared, ids.scout]);
  await legacy.exec(readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261123000000_move_to_pm.sql'), 'utf8'));
  const server = await startFakePostgrest(legacy, { strictColumns: true });
  const { createPmClient } = await import('../src/lib/supabase/pm-client');
  // Its own client: the service client of the run above points at the other database.
  const service = createPmClient(server.url, 'fake-service-key', { auth: { persistSession: false } });
  try {
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const inbox = await import('../src/lib/communications/inbox-service');
    const agentAccess = await import('../src/lib/communications/agent-access');
    const settings = await import('../src/lib/communications/inbox-settings-service');
    const owner = { service, memberId: ids.owner, access: (await resolveMemberAccess(service, ids.owner))! };
    const scoutAccess = (await resolveMemberAccess(service, ids.scout))!;
    const outcome = async <T,>(work: () => Promise<T>): Promise<T | string> => {
      try { return await work(); } catch (error) { return `failed: ${(error as Error).message}`; }
    };
    const readable = await outcome(() => inbox.readableInboxIds(owner));
    check('legacy: the Inbox reads every inbox as shared', JSON.stringify(readable) === JSON.stringify([ids.shared]), readable);
    const list = await outcome(() => inbox.listThreads(owner, { inboxId: null, projectId: null, tab: 'all', search: '', limit: 50, offset: 0 }));
    check('legacy: the Inbox list loads, with no owners', typeof list !== 'string' && list.inboxes.every((row) => row.owner === null) && list.owners_read_personal === false, list);
    const listed = await outcome(() => settings.listInboxSettings(owner));
    check('legacy: Settings lists the inboxes as shared', typeof listed !== 'string' && listed.inboxes.length === 1 && (listed.personal ?? []).length === 0, listed);
    const agent = await outcome(() => agentAccess.memberInboxIds(service, ids.scout, scoutAccess));
    check('legacy: the API scopes the agent to its inbox', JSON.stringify(agent) === JSON.stringify([ids.shared]), agent);
    const mine = await outcome(() => settings.listMyInboxes(owner));
    check('legacy: Your inbox is empty until the migration', typeof mine !== 'string' && mine.inboxes.length === 0, mine);
  } finally {
    await server.close();
    await legacy.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
