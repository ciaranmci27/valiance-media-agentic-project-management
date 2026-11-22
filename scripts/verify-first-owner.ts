/**
 * A fresh install's first account (lib/setup/first-owner.ts and the
 * 20261121080000_first_owner_lock migration):
 * - the fields are checked as the wizard's account step sends them;
 * - on an empty team the account is made, confirmed, named and is the Owner;
 * - once anyone is on the team it answers 409, and keeps answering it;
 * - if someone else was first, the login just made is deleted (before 2.0,
 *   the sign-up trigger refused it and nothing was made at all);
 * - on a project that already has logins, the host's setup code is needed,
 *   and an existing login may claim with its password (login_owned false);
 * - in the database, pm.add_team_member (service role only) refuses a second
 *   Owner and is idempotent on the login; the signup trigger installs before
 *   2.0 still run makes only the first account Owner, refuses the wizard's
 *   account once a team exists, and an existing database upgrades to it.
 *
 *   npm run -s test:first-owner
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ALREADY_OWNED, FirstOwnerError, checkFirstOwnerInput, createFirstOwner, needsFirstOwner, resetFirstOwnerCache,
} from '../src/lib/setup/first-owner';
import { createFullSchemaDatabase, schemaAt, schemaBeforeMigration } from './full-schema-db';

const MIGRATION = '20261121080000_first_owner_lock.sql';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

function problem(fn: () => unknown): FirstOwnerError | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof FirstOwnerError ? error : null;
  }
}

async function failure(promise: Promise<unknown>): Promise<FirstOwnerError | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof FirstOwnerError ? error : null;
  }
}

// ---- The fields ------------------------------------------------------------
function fields() {
  const ok = checkFirstOwnerInput({ name: '  Ada Lovelace ', email: ' Ada@Example.COM ', password: 'correct horse' });
  check('fields: name trimmed, email trimmed and lower case', ok.name === 'Ada Lovelace' && ok.email === 'ada@example.com', ok);
  check('fields: password kept exactly', ok.password === 'correct horse');
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['no name', { name: ' ', email: 'a@b.co', password: 'longenough' }, 'name'],
    ['name over 100', { name: 'x'.repeat(101), email: 'a@b.co', password: 'longenough' }, 'name'],
    ['bad email', { name: 'A', email: 'not-an-email', password: 'longenough' }, 'email'],
    ['short password', { name: 'A', email: 'a@b.co', password: 'short' }, 'password'],
    ['password over 72', { name: 'A', email: 'a@b.co', password: 'x'.repeat(73) }, 'password'],
    ['not strings', { name: 1, email: null, password: {} }, 'name'],
  ];
  for (const [label, raw, field] of cases) {
    const error = problem(() => checkFirstOwnerInput(raw));
    check(`fields: ${label} is refused on ${field}`, error?.status === 422 && error.field === field, error && { status: error.status, field: error.field });
  }
}

// ---- The server side, against a stand-in Supabase ---------------------------
interface Member { id: string; auth_user_id: string; name: string; email: string; role: string; login_owned: boolean }
interface Login { email: string; confirmed: boolean; name: string; password: string }

/**
 * Just enough of the service client: auth admin, team_members, and the
 * service-only functions (add_team_member, logins_exist, login_for_email).
 * A 2.0 install has no trigger on auth.users: the server adds the member.
 * `legacyTrigger` models an install from before 2.0, whose sign-up trigger
 * adds the member itself (and refuses the wizard's account once a team exists).
 */
function fakeService(options: {
  failCount?: boolean; someoneFirst?: boolean; duplicate?: boolean; legacyTrigger?: boolean;
  logins?: Array<{ id: string; email: string; password: string }>;
} = {}) {
  const members: Member[] = [];
  const users = new Map<string, Login>();
  for (const login of options.logins ?? []) users.set(login.id, { email: login.email, confirmed: true, name: '', password: login.password });
  const deleted: string[] = [];
  const marked: boolean[] = [];
  let next = 1;
  const otherOwner = () => members.push({ id: 'm-other', auth_user_id: 'user-other', name: 'Other', email: 'other@x.co', role: 'owner', login_owned: true });
  const service = {
    auth: {
      admin: {
        async createUser(input: { email: string; password: string; email_confirm: boolean; user_metadata: { display_name: string; first_owner?: boolean } }) {
          if (options.duplicate || [...users.values()].some((u) => u.email === input.email)) {
            return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
          }
          marked.push(input.user_metadata.first_owner === true);
          if (options.legacyTrigger) {
            // Someone else's account landed first: the old trigger refuses the
            // wizard's account, the sign-up rolls back, GoTrue reports a database error.
            if (options.someoneFirst && members.length === 0) otherOwner();
            if (members.length && input.user_metadata.first_owner) {
              return { data: { user: null }, error: { message: 'Database error creating new user' } };
            }
          }
          const id = `user-${next++}`;
          users.set(id, { email: input.email, confirmed: input.email_confirm, name: input.user_metadata.display_name, password: input.password });
          if (options.legacyTrigger) {
            members.push({ id: `m-${id}`, auth_user_id: id, name: input.user_metadata.display_name, email: input.email, role: members.length ? 'member' : 'owner', login_owned: true });
          } else if (options.someoneFirst && members.length === 0) {
            // Someone else became the Owner between this login and adding it.
            otherOwner();
          }
          return { data: { user: { id } }, error: null };
        },
        async deleteUser(id: string) {
          users.delete(id);
          deleted.push(id);
          return { error: null };
        },
      },
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === 'logins_exist') return { data: users.size > 0, error: null };
      if (fn === 'login_for_email') {
        const found = [...users.entries()].find(([, u]) => u.email === String(args.p_email).trim().toLowerCase());
        return { data: found ? found[0] : null, error: null };
      }
      if (fn === 'add_team_member') {
        const authId = String(args.p_auth_user_id);
        if (args.p_first_owner && members.some((m) => m.auth_user_id !== authId)) {
          return { data: null, error: { code: 'P0001', message: 'This workspace already has an Owner' } };
        }
        const role = args.p_first_owner ? 'owner' : String(args.p_role ?? 'member');
        const existing = members.find((m) => m.auth_user_id === authId);
        if (existing) Object.assign(existing, { name: String(args.p_name), role, login_owned: args.p_login_owned !== false });
        else members.push({ id: `m-${authId}`, auth_user_id: authId, name: String(args.p_name), email: String(args.p_email), role, login_owned: args.p_login_owned !== false });
        return { data: members.find((m) => m.auth_user_id === authId), error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    from(table: string) {
      if (table !== 'team_members') throw new Error(`unexpected table ${table}`);
      return {
        select(_columns: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.head) {
            return Promise.resolve(options.failCount ? { count: null, error: { message: 'down' } } : { count: members.length, error: null });
          }
          return {
            eq(_col: string, value: string) {
              return { maybeSingle: async () => ({ data: members.find((m) => m.auth_user_id === value) ?? null, error: null }) };
            },
          };
        },
        update(patch: Partial<Member>) {
          return { eq: async (_col: string, id: string) => { Object.assign(members.find((m) => m.id === id) ?? {}, patch); return { error: null }; } };
        },
        delete() {
          return { eq: async (_col: string, id: string) => { members.splice(members.findIndex((m) => m.id === id), 1); return { error: null }; } };
        },
      };
    },
  };
  return { service: service as unknown as SupabaseClient, members, users, deleted, marked };
}

async function server() {
  const input = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse' };

  resetFirstOwnerCache();
  const fresh = fakeService();
  check('server: an empty team needs its first Owner', (await needsFirstOwner(fresh.service)) === true);
  const made = await createFirstOwner(fresh.service, input);
  check('server: returns the email to sign in with', made.email === 'ada@example.com', made);
  const owner = fresh.members[0];
  check('server: the account is the Owner, with the name given', fresh.members.length === 1 && owner.role === 'owner' && owner.name === 'Ada Lovelace', fresh.members);
  check('server: the app owns the login it made', owner.login_owned === true, owner);
  check('server: the account is confirmed (no email needed)', fresh.users.get(owner.auth_user_id)?.confirmed === true);
  check('server: the account is marked as the setup wizard account', fresh.marked[0] === true, fresh.marked);
  check('server: after that, no first Owner is needed', (await needsFirstOwner(fresh.service)) === false);
  const again = await failure(createFirstOwner(fresh.service, { ...input, email: 'eve@example.com' }));
  check('server: a second try answers 409', again?.status === 409 && again.message === ALREADY_OWNED, again?.message);
  check('server: and makes no account', fresh.members.length === 1 && fresh.users.size === 1);

  resetFirstOwnerCache();
  const raced = fakeService({ someoneFirst: true });
  const lost = await failure(createFirstOwner(raced.service, input));
  check('server: someone else first answers 409', lost?.status === 409 && lost.message === ALREADY_OWNED, lost?.message);
  // 2.0: the login is made, then adding it as Owner is refused; the login just made is deleted.
  check('server: the login just made for the second account is deleted', raced.users.size === 0 && raced.deleted.length === 1, { users: raced.users.size, deleted: raced.deleted });
  check('server: the winner stays the only Owner', raced.members.length === 1 && raced.members[0].role === 'owner' && raced.members[0].id === 'm-other');

  // An install from before 2.0: its sign-up trigger refuses the wizard's account, nothing is made.
  resetFirstOwnerCache();
  const legacy = fakeService({ someoneFirst: true, legacyTrigger: true });
  const legacyLost = await failure(createFirstOwner(legacy.service, input));
  check('server (pre-2.0 trigger): someone else first answers 409', legacyLost?.status === 409 && legacyLost.message === ALREADY_OWNED, legacyLost?.message);
  check('server (pre-2.0 trigger): nothing is made for the second account', legacy.users.size === 0 && legacy.deleted.length === 0, legacy);
  check('server (pre-2.0 trigger): the winner stays the only Owner', legacy.members.length === 1 && legacy.members[0].id === 'm-other');
  resetFirstOwnerCache();
  const legacyFresh = fakeService({ legacyTrigger: true });
  await createFirstOwner(legacyFresh.service, input);
  check('server (pre-2.0 trigger): the row the trigger made is the one Owner, named', legacyFresh.members.length === 1 && legacyFresh.members[0].role === 'owner' && legacyFresh.members[0].name === 'Ada Lovelace', legacyFresh.members);

  // A Supabase project that already has logins (other apps): the host's setup code.
  const CODE = 'a-long-random-setup-code';
  const boss = { id: 'user-boss', email: 'boss@example.com', password: 'boss password' };
  resetFirstOwnerCache();
  const noCode = fakeService({ logins: [boss] });
  const needCode = await failure(createFirstOwner(noCode.service, { ...input, setup_code: 'anything' }, { env: {} }));
  check('setup code: other logins and no PM_SETUP_CODE answers 409 on setup_code', needCode?.status === 409 && needCode.field === 'setup_code', needCode && { status: needCode.status, field: needCode.field });
  check('setup code: and makes nothing', noCode.members.length === 0 && noCode.users.size === 1);

  resetFirstOwnerCache();
  const wrong = fakeService({ logins: [boss] });
  const badCode = await failure(createFirstOwner(wrong.service, { ...input, setup_code: 'not-the-code' }, { env: { PM_SETUP_CODE: CODE } }));
  check('setup code: a wrong code is 403 on setup_code', badCode?.status === 403 && badCode.field === 'setup_code', badCode && { status: badCode.status, field: badCode.field });
  const noGiven = await failure(createFirstOwner(wrong.service, input, { env: { PM_SETUP_CODE: CODE } }));
  check('setup code: no code given is 403 too', noGiven?.status === 403 && noGiven.field === 'setup_code', noGiven?.status);
  check('setup code: and a wrong code makes nothing', wrong.members.length === 0 && wrong.users.size === 1);

  resetFirstOwnerCache();
  const right = fakeService({ logins: [boss] });
  const verified: string[] = [];
  // Signing in as the existing login: only its own password works.
  const verifyPassword = async (email: string, password: string) => {
    verified.push(email);
    return email === boss.email && password === boss.password;
  };
  const rightLogin = fakeService({ logins: [boss] });
  await createFirstOwner(right.service, { ...input, setup_code: ` ${CODE} ` }, { env: { PM_SETUP_CODE: CODE }, verifyPassword });
  const newOwner = right.members[0];
  check('setup code: the right code and a new email make the Owner', right.members.length === 1 && newOwner.role === 'owner' && newOwner.email === 'ada@example.com', right.members);
  check('setup code: on a new login the app owns (login_owned true)', newOwner?.login_owned === true && right.users.size === 2, newOwner);
  check('setup code: no password check for a new email', verified.length === 0, verified);

  resetFirstOwnerCache();
  const claimInput = { name: 'The Boss', email: 'Boss@Example.com', password: boss.password, setup_code: CODE };
  await createFirstOwner(rightLogin.service, claimInput, { env: { PM_SETUP_CODE: CODE }, verifyPassword });
  const claimed = rightLogin.members[0];
  check('existing login: the right password makes that login the Owner', rightLogin.members.length === 1 && claimed.role === 'owner' && claimed.auth_user_id === boss.id, rightLogin.members);
  check('existing login: the login stays the other app\'s (login_owned false)', claimed?.login_owned === false, claimed);
  check('existing login: no new login is made', rightLogin.users.size === 1 && rightLogin.marked.length === 0, { users: rightLogin.users.size, marked: rightLogin.marked });
  check('existing login: the password is checked for that email', verified.includes('boss@example.com'), verified);

  resetFirstOwnerCache();
  const wrongPassword = fakeService({ logins: [boss] });
  const refusedClaim = await failure(createFirstOwner(wrongPassword.service, { ...claimInput, password: 'not the password' }, { env: { PM_SETUP_CODE: CODE }, verifyPassword }));
  check('existing login: a wrong password is 403', refusedClaim?.status === 403 && refusedClaim.field === 'password', refusedClaim && { status: refusedClaim.status, field: refusedClaim.field });
  check('existing login: and nothing changes', wrongPassword.members.length === 0 && wrongPassword.users.size === 1 && wrongPassword.deleted.length === 0 && wrongPassword.marked.length === 0);

  resetFirstOwnerCache();
  const dup = fakeService({ duplicate: true });
  const taken = await failure(createFirstOwner(dup.service, input));
  check('server: an email already registered answers 409 on email', taken?.status === 409 && taken.field === 'email', taken && { status: taken.status, field: taken.field });

  resetFirstOwnerCache();
  const down = fakeService({ failCount: true });
  check('server: an unreadable team reads as unknown', (await needsFirstOwner(down.service)) === null);
  const unreachable = await failure(createFirstOwner(down.service, input));
  check('server: and refuses to create with 503', unreachable?.status === 503 && down.users.size === 0, unreachable?.status);

  resetFirstOwnerCache();
  const bad = fakeService();
  const refused = await failure(createFirstOwner(bad.service, { ...input, password: 'short' }));
  check('server: bad fields are refused before anything is made', refused?.status === 422 && bad.users.size === 0);
}

// ---- The database ----------------------------------------------------------
async function database() {
  // The sign-up trigger as installs from before 2.0 still run it (the harness
  // re-adds it on pm.handle_new_user for seeding).
  const db = await createFullSchemaDatabase();
  const def = (await db.query<{ def: string }>("SELECT pg_get_functiondef('pm.handle_new_user()'::regprocedure) AS def")).rows[0].def;
  check('database: the signup trigger takes a lock first', /pg_advisory_xact_lock/.test(def));
  await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('00000000-0000-0000-0000-000000000001', 'ada@example.com', '{"display_name":"Ada"}')`);
  await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('00000000-0000-0000-0000-000000000002', 'eve@example.com', '{"display_name":"Eve"}')`);
  const rows = (await db.query<{ email: string; role: string; name: string }>('SELECT email, role, name FROM pm.team_members ORDER BY email')).rows;
  check('database: the first account is the Owner', rows.find((r) => r.email === 'ada@example.com')?.role === 'owner', rows);
  check('database: the next is a member', rows.find((r) => r.email === 'eve@example.com')?.role === 'member', rows);
  check('database: the name comes from the account', rows.find((r) => r.email === 'ada@example.com')?.name === 'Ada', rows);
  let refused: string | null = null;
  try {
    await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('00000000-0000-0000-0000-000000000009', 'late@example.com', '{"first_owner":true}')`);
  } catch (error) {
    refused = (error as Error).message;
  }
  check('database: a wizard account is refused once a team exists', /already has an Owner/.test(refused ?? ''), refused);
  const late = (await db.query('SELECT 1 FROM auth.users WHERE email = $1 UNION ALL SELECT 1 FROM pm.team_members WHERE email = $1', ['late@example.com'])).rows;
  check('database: and leaves no account and no team row', late.length === 0, late);
  // GoTrue writes app_metadata after the INSERT, so the trigger must never lean on it:
  // a mark there alone is not seen, and that account is simply a member.
  await db.exec(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES
    ('00000000-0000-0000-0000-000000000011', 'appmeta@example.com', '{"first_owner":true}')`);
  const appMeta = (await db.query<{ role: string }>('SELECT role FROM pm.team_members WHERE email = $1', ['appmeta@example.com'])).rows;
  check('database: the mark is read from user metadata, not app metadata', appMeta[0]?.role === 'member', appMeta);

  // 2.0: the server adds members through pm.add_team_member (service role only).
  const ADD = 'pm.add_team_member(uuid, text, text, text, boolean, boolean)';
  let secondOwner: string | null = null;
  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000021', 'claim@example.com')`);
  try {
    await db.query(`SELECT pm.add_team_member('00000000-0000-0000-0000-000000000021', 'claim@example.com', 'Claim', 'owner', true, true)`);
  } catch (error) {
    secondOwner = (error as Error).message;
  }
  check('add_team_member: refuses a second Owner', /already has an Owner/.test(secondOwner ?? ''), secondOwner);
  const notOwner = (await db.query<{ role: string }>("SELECT role FROM pm.team_members WHERE email = 'claim@example.com'")).rows;
  check('add_team_member: the refused claim leaves that member as it was', notOwner.length === 1 && notOwner[0].role === 'member', notOwner);
  await db.query(`SELECT pm.add_team_member('00000000-0000-0000-0000-000000000021', 'claim@example.com', 'Claimed Name', 'admin', false, false)`);
  await db.query(`SELECT pm.add_team_member('00000000-0000-0000-0000-000000000021', 'claim@example.com', 'Claimed Name', 'admin', false, false)`);
  const same = (await db.query<{ name: string; role: string; login_owned: boolean }>(
    "SELECT name, role, login_owned FROM pm.team_members WHERE auth_user_id = '00000000-0000-0000-0000-000000000021'")).rows;
  check('add_team_member: idempotent on the login, it updates the row the trigger made',
    same.length === 1 && same[0].name === 'Claimed Name' && same[0].role === 'admin' && same[0].login_owned === false, same);
  const grants = (await db.query<{ anon: boolean; authed: boolean; service: boolean }>(
    `SELECT has_function_privilege('anon', '${ADD}', 'EXECUTE') AS anon,
            has_function_privilege('authenticated', '${ADD}', 'EXECUTE') AS authed,
            has_function_privilege('service_role', '${ADD}', 'EXECUTE') AS service`)).rows[0];
  check('add_team_member: not executable by anon or authenticated, only the service role', !grants.anon && !grants.authed && grants.service, grants);
  for (const fn of ['pm.login_for_email(text, boolean)', 'pm.logins_exist()']) {
    const g = (await db.query<{ anon: boolean; authed: boolean }>(
      `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') AS anon, has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS authed`)).rows[0];
    check(`${fn}: not executable by anon or authenticated`, !g.anon && !g.authed, g);
  }
  await db.close();

  const empty = await createFullSchemaDatabase();
  await empty.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('00000000-0000-0000-0000-000000000010', 'first@example.com', '{"display_name":"First","first_owner":true}')`);
  const first = (await empty.query<{ role: string; name: string }>('SELECT role, name FROM pm.team_members')).rows;
  check('database: on an empty team the wizard account is the Owner', first.length === 1 && first[0].role === 'owner' && first[0].name === 'First', first);
  await empty.close();

  // A fresh 2.0 install: no trigger on auth.users, the server adds the first Owner.
  const fresh = await createFullSchemaDatabase();
  await fresh.exec('DROP TRIGGER on_auth_user_created ON auth.users');
  await fresh.exec(`INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000031', 'owner@example.com')`);
  const unseeded = (await fresh.query('SELECT 1 FROM pm.team_members')).rows;
  await fresh.query(`SELECT pm.add_team_member('00000000-0000-0000-0000-000000000031', 'owner@example.com', 'Owner', 'member', true, true)`);
  const firstOwner = (await fresh.query<{ role: string; login_owned: boolean }>('SELECT role, login_owned FROM pm.team_members')).rows;
  check('add_team_member: a first-owner call on an empty team makes the Owner', unseeded.length === 0 && firstOwner.length === 1 && firstOwner[0].role === 'owner' && firstOwner[0].login_owned === true, firstOwner);
  await fresh.close();

  // An existing install: the schema before this change, then the migration (twice: it re-runs safely).
  let before: string;
  try {
    before = schemaBeforeMigration(MIGRATION);
  } catch {
    before = schemaAt('HEAD');
  }
  const old = await createFullSchemaDatabase({ schemaSql: before });
  await old.exec(`INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000003', 'kept@example.com')`);
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
  await old.exec(sql);
  await old.exec(sql);
  const upgraded = (await old.query<{ def: string }>("SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) AS def")).rows[0].def;
  check('upgrade: the trigger takes the lock after the migration', /pg_advisory_xact_lock/.test(upgraded));
  const kept = (await old.query<{ role: string }>("SELECT role FROM public.team_members WHERE email = 'kept@example.com'")).rows;
  check('upgrade: existing people are untouched', kept.length === 1 && kept[0].role === 'owner', kept);
  await old.exec(`INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000004', 'new@example.com')`);
  const later = (await old.query<{ role: string }>("SELECT role FROM public.team_members WHERE email = 'new@example.com'")).rows;
  check('upgrade: a later account is a member, as before', later[0]?.role === 'member', later);
  await old.close();
}

async function main() {
  fields();
  await server();
  await database();
  if (failures.length) {
    console.error(`first owner: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`first owner: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
