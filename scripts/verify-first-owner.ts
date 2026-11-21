/**
 * A fresh install's first account (lib/setup/first-owner.ts and the
 * 20261121080000_first_owner_lock migration):
 * - the fields are checked as the wizard's account step sends them;
 * - on an empty team the account is made, confirmed, named and is the Owner;
 * - once anyone is on the team it answers 409, and keeps answering it;
 * - if someone else was first, nothing is made at all;
 * - in the database, the signup trigger makes only the first account Owner,
 *   refuses the wizard's account once a team exists (so the sign-up rolls
 *   back whole), and an existing database upgrades to it.
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
interface Member { id: string; auth_user_id: string; name: string; email: string; role: string }

/** Just enough of the service client: auth admin, and team_members as the signup trigger fills it. */
function fakeService(options: { failCount?: boolean; someoneFirst?: boolean; duplicate?: boolean } = {}) {
  const members: Member[] = [];
  const users = new Map<string, { email: string; confirmed: boolean; name: string }>();
  const deleted: string[] = [];
  const marked: boolean[] = [];
  let next = 1;
  const service = {
    auth: {
      admin: {
        async createUser(input: { email: string; password: string; email_confirm: boolean; user_metadata: { display_name: string; first_owner?: boolean } }) {
          if (options.duplicate) return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
          marked.push(input.user_metadata.first_owner === true);
          // Someone else's account landed first: the trigger refuses the
          // wizard's account, the sign-up rolls back, GoTrue reports a database error.
          if (options.someoneFirst && members.length === 0) {
            members.push({ id: 'm-other', auth_user_id: 'user-other', name: 'Other', email: 'other@x.co', role: 'owner' });
          }
          if (members.length && input.user_metadata.first_owner) {
            return { data: { user: null }, error: { message: 'Database error creating new user' } };
          }
          const id = `user-${next++}`;
          users.set(id, { email: input.email, confirmed: input.email_confirm, name: input.user_metadata.display_name });
          members.push({ id: `m-${id}`, auth_user_id: id, name: input.user_metadata.display_name, email: input.email, role: members.length ? 'member' : 'owner' });
          return { data: { user: { id } }, error: null };
        },
        async deleteUser(id: string) {
          users.delete(id);
          deleted.push(id);
          return { error: null };
        },
      },
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
  check('server: nothing is made for the second account', raced.users.size === 0 && raced.deleted.length === 0, raced);
  check('server: the winner stays the only Owner', raced.members.length === 1 && raced.members[0].role === 'owner' && raced.members[0].id === 'm-other');

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
  const db = await createFullSchemaDatabase();
  const def = (await db.query<{ def: string }>("SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) AS def")).rows[0].def;
  check('database: the signup trigger takes a lock first', /pg_advisory_xact_lock/.test(def));
  await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('00000000-0000-0000-0000-000000000001', 'ada@example.com', '{"display_name":"Ada"}')`);
  await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('00000000-0000-0000-0000-000000000002', 'eve@example.com', '{"display_name":"Eve"}')`);
  const rows = (await db.query<{ email: string; role: string; name: string }>('SELECT email, role, name FROM public.team_members ORDER BY email')).rows;
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
  const late = (await db.query('SELECT 1 FROM auth.users WHERE email = $1 UNION ALL SELECT 1 FROM public.team_members WHERE email = $1', ['late@example.com'])).rows;
  check('database: and leaves no account and no team row', late.length === 0, late);
  // GoTrue writes app_metadata after the INSERT, so the trigger must never lean on it:
  // a mark there alone is not seen, and that account is simply a member.
  await db.exec(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES
    ('00000000-0000-0000-0000-000000000011', 'appmeta@example.com', '{"first_owner":true}')`);
  const appMeta = (await db.query<{ role: string }>('SELECT role FROM public.team_members WHERE email = $1', ['appmeta@example.com'])).rows;
  check('database: the mark is read from user metadata, not app metadata', appMeta[0]?.role === 'member', appMeta);
  await db.close();

  const empty = await createFullSchemaDatabase();
  await empty.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('00000000-0000-0000-0000-000000000010', 'first@example.com', '{"display_name":"First","first_owner":true}')`);
  const first = (await empty.query<{ role: string; name: string }>('SELECT role, name FROM public.team_members')).rows;
  check('database: on an empty team the wizard account is the Owner', first.length === 1 && first[0].role === 'owner' && first[0].name === 'First', first);
  await empty.close();

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
