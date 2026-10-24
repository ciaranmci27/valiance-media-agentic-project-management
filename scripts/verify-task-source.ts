/**
 * Task source and seen: every new task is stamped with how it was made (the
 * app for a signed-in person, api or mcp for an API key with the key itself,
 * system otherwise), whatever path inserts it; nobody can forge or change the
 * stamp; tasks from before stay unknown. Each member's views are their own.
 * The migration applies to the schema as it was and runs twice.
 *
 * Runs on PGlite (real Postgres) over the whole real schema; nothing touches
 * a live database.
 *
 *   npm run -s test:task-source
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';

const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261024065232_task_source_and_seen.sql');
const OWNER_USER = '00000000-0000-0000-0000-0000000000c1';
const MEMBER_USER = '00000000-0000-0000-0000-0000000000c2';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function attempt(db: PGlite, sql: string, params: unknown[] = []) {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

type Source = { created_via: string; created_by_key_id: string | null; created_note: string | null; created_by: string | null };

/**
 * The schema before this migration, as production has it: schema.sql without
 * the task source columns and section, so the migration is tested on top of it.
 */
function schemaBeforeMigration(): string {
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  const section = sql.indexOf('\n-- ---------------------------------------------------------------------------\n-- Task source and seen');
  const columns = sql.indexOf('  -- Where it came from, stamped on insert');
  const columnsEnd = sql.indexOf(');', columns);
  if (section < 0 || columns < 0) throw new Error('schema.sql no longer has the task source pieces this test removes');
  return sql.slice(0, columns).replace(/,\s*$/, '\n') + sql.slice(columnsEnd, section);
}

async function run(db: PGlite, label: string) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const superuser = async () => {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false), set_config('request.headers', '', false)");
  };
  const asServer = async (headers: Record<string, string> | null) => {
    await actAs(db, null);
    await db.query("SELECT set_config('request.headers', $1, false)", [headers ? JSON.stringify(headers) : '']);
  };
  const source = async (id: string) => {
    await superuser();
    return (await q<Source>('SELECT created_via, created_by_key_id, created_note, created_by FROM public.tasks WHERE id = $1', [id]))[0];
  };

  // --- Seed -------------------------------------------------------------------
  await superuser();
  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${OWNER_USER}', 'owner@example.com'), ('${MEMBER_USER}', 'member@example.com')`);
  const people = await q<{ id: string; auth_user_id: string }>('SELECT id, auth_user_id FROM public.team_members');
  const owner = people.find((m) => m.auth_user_id === OWNER_USER)!.id;
  const member = people.find((m) => m.auth_user_id === MEMBER_USER)!.id;
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'app', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read']) AS key`, [member]);
  const ashley = (await q<{ id: string }>("INSERT INTO public.team_members (name, email, role) VALUES ('Ashley', 'ashley@example.com', 'agent') RETURNING id"))[0].id;
  const project = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Happy Innovations') RETURNING id"))[0].id;
  await db.query('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [project, member]);
  const ashleyKey = (await q<{ id: string }>(
    "INSERT INTO public.api_keys (name, key_prefix, key_hash, team_member_id, created_by) VALUES ('Ashley', 'vm_a', 'h1', $1, $2) RETURNING id", [ashley, owner]))[0].id;
  const recapKey = (await q<{ id: string }>(
    "INSERT INTO public.api_keys (name, key_prefix, key_hash, team_member_id, created_by) VALUES ('Time recap', 'vm_r', 'h2', $1, $1) RETURNING id", [owner]))[0].id;

  // --- Source -----------------------------------------------------------------
  await actAs(db, OWNER_USER);
  const typed = (await q<{ id: string }>(
    "INSERT INTO public.tasks (project_id, title, created_by, created_via, created_by_key_id, created_note) VALUES ($1, 'Typed in the app', $2, 'api', $3, 'pretend') RETURNING id",
    [project, owner, recapKey]))[0].id;
  let s = await source(typed);
  check(`${label}: a signed-in person's task is app, whatever the row claims`,
    s.created_via === 'app' && s.created_by_key_id === null && s.created_note === null && s.created_by === owner, s);

  await asServer({ 'x-actor-member-id': owner, 'x-actor-via': 'app' });
  const routed = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'From a session route', $2) RETURNING id", [project, owner]))[0].id;
  s = await source(routed);
  check(`${label}: the app's own routes acting for a person are app`, s.created_via === 'app' && s.created_by_key_id === null, s);

  await asServer({ 'x-actor-member-id': ashley, 'x-actor-via': 'api', 'x-actor-key-id': ashleyKey });
  const fromAshley = (await q<{ id: string }>(
    "INSERT INTO public.tasks (project_id, title, created_by, created_note) VALUES ($1, 'Holiday banner', $2, '  from Brennan''s email  ') RETURNING id", [project, ashley]))[0].id;
  s = await source(fromAshley);
  check(`${label}: an agent's key is api, with the key and its trimmed note`,
    s.created_via === 'api' && s.created_by_key_id === ashleyKey && s.created_note === "from Brennan's email" && s.created_by === ashley, s);

  await asServer({ 'x-actor-member-id': owner, 'x-actor-via': 'mcp', 'x-actor-key-id': recapKey });
  const fromRecap = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'Logged from the recap', $2) RETURNING id", [project, owner]))[0].id;
  s = await source(fromRecap);
  check(`${label}: a person's own key never reads as the person: mcp with that key`,
    s.created_via === 'mcp' && s.created_by_key_id === recapKey && s.created_by === owner, s);

  await asServer({ 'x-actor-via': 'api', 'x-actor-key-id': '00000000-0000-4000-8000-000000000999' });
  const unknownKey = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Unknown key') RETURNING id", [project]))[0].id;
  s = await source(unknownKey);
  check(`${label}: a key id that is not a key is dropped`, s.created_via === 'api' && s.created_by_key_id === null, s);

  await asServer(null);
  const bare = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, created_via) VALUES ($1, 'Server, no headers', 'app') RETURNING id", [project]))[0].id;
  s = await source(bare);
  check(`${label}: the server with no person or key is system, never app`, s.created_via === 'system', s);

  await superuser();
  const direct = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'SQL run directly') RETURNING id", [project]))[0].id;
  check(`${label}: SQL run directly is system`, (await source(direct)).created_via === 'system');

  await asServer({ 'x-actor-member-id': ashley, 'x-actor-via': 'api', 'x-actor-key-id': ashleyKey });
  check(`${label}: a note over 200 characters is cut to 200`,
    (await attempt(db, "INSERT INTO public.tasks (project_id, title, created_note) VALUES ($1, 'Long note', $2)", [project, 'x'.repeat(300)])) === null
      && (await q<{ n: number }>("SELECT length(created_note) AS n FROM public.tasks WHERE title = 'Long note'"))[0]?.n === 200);

  await actAs(db, OWNER_USER);
  await db.query("UPDATE public.tasks SET created_via = 'app', created_by_key_id = NULL, created_note = 'rewritten', title = 'Holiday banner v2' WHERE id = $1", [fromAshley]);
  s = await source(fromAshley);
  check(`${label}: where a task came from never changes after the insert`,
    s.created_via === 'api' && s.created_by_key_id === ashleyKey && s.created_note === "from Brennan's email", s);
  await superuser();
  check(`${label}: other edits still apply`, (await q<{ title: string }>('SELECT title FROM public.tasks WHERE id = $1', [fromAshley]))[0].title === 'Holiday banner v2');

  // --- Seen -------------------------------------------------------------------
  await actAs(db, MEMBER_USER);
  check(`${label}: a member marks a task seen`, (await attempt(db, 'SELECT public.mark_task_seen($1)', [fromAshley])) === null);
  const first = (await q<{ seen_at: string }>('SELECT seen_at FROM public.task_views WHERE task_id = $1', [fromAshley]))[0]?.seen_at;
  check(`${label}: opening it again keeps one row`, (await attempt(db, 'SELECT public.mark_task_seen($1)', [fromAshley])) === null
    && (await q('SELECT 1 FROM public.task_views WHERE task_id = $1', [fromAshley])).length === 1 && !!first);

  await actAs(db, OWNER_USER);
  check(`${label}: one member's views are not another's`, (await q('SELECT 1 FROM public.task_views')).length === 0);
  check(`${label}: nobody writes a view for someone else`,
    (await attempt(db, 'INSERT INTO public.task_views (task_id, member_id) VALUES ($1, $2)', [fromAshley, member])) !== null);

  await superuser();
  const elsewhere = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  const hidden = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Not theirs') RETURNING id", [elsewhere]))[0].id;
  await actAs(db, MEMBER_USER);
  check(`${label}: a member cannot mark a task they cannot open`, (await attempt(db, 'SELECT public.mark_task_seen($1)', [hidden])) !== null);
}

async function main() {
  // On the schema as committed (production's shape): migration twice, then every check.
  {
    const db = await createFullSchemaDatabase({ schemaSql: schemaBeforeMigration() });
    await db.exec('RESET ROLE');
    const old = (await db.query<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Old') RETURNING id")).rows[0].id;
    const legacy = (await db.query<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'From before') RETURNING id", [old])).rows[0].id;
    await db.exec(readFileSync(MIGRATION, 'utf8'));
    await db.exec(readFileSync(MIGRATION, 'utf8'));
    const was = (await db.query<{ created_via: string }>('SELECT created_via FROM public.tasks WHERE id = $1', [legacy])).rows[0];
    check('migration: tasks from before are unknown', was?.created_via === 'unknown', was);
    await run(db, 'migrated');
    await db.close();
  }
  // On schema.sql, which must describe the same final state.
  const fresh = await createFullSchemaDatabase();
  await run(fresh, 'schema.sql');
  await fresh.close();

  if (failures.length) {
    console.error(`task source: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`task source: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
