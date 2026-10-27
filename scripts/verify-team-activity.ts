/**
 * Team activity log: what people do lands in public.activities, written by
 * triggers whichever way the write arrives (signed-in browser, or the server
 * on the service role naming the person in a header). Agents, cron jobs and
 * forged headers are not logged; repeated edits fold into one row; readers
 * see only what their permissions already show; the backfill runs once; and
 * the real v1 routes name the key's person on their writes.
 *
 * Runs on PGlite (real Postgres) over the whole real schema; nothing touches
 * a live database.
 *
 *   npm run -s test:team-activity
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { startFakePostgrest } from './fake-postgrest';
import { actAs, createFullSchemaDatabase } from './full-schema-db';

const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261022074722_team_activity_log.sql');
const OWNER_USER = '00000000-0000-0000-0000-0000000000b1';
const MEMBER_USER = '00000000-0000-0000-0000-0000000000b2';

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

type Row = { type: string; user_id: string | null; project_id: string | null; description: string; source: string; metadata: Record<string, unknown>; entity_type: string };

async function main() {
  const db = await createFullSchemaDatabase();
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  // The database owner with no one signed in: setup and backfill, never logged.
  const superuser = async () => {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false), set_config('request.headers', '', false)");
  };
  const asOwner = () => actAs(db, OWNER_USER);
  const asMember = () => actAs(db, MEMBER_USER);
  /** The server on the service role, naming the person (or not) in the request headers. */
  const asServer = async (headers: Record<string, string> | null) => {
    await actAs(db, null);
    await db.query("SELECT set_config('request.headers', $1, false)", [headers ? JSON.stringify(headers) : '']);
  };
  const rows = async (where = 'true', params: unknown[] = []) => {
    await superuser();
    return q<Row>(`SELECT type, user_id, project_id, description, source, metadata, entity_type FROM public.activities WHERE ${where} ORDER BY created_at, updated_at`, params);
  };
  const latest = async () => (await rows()).at(-1);
  const total = async () => (await rows()).length;

  // --- Seed: an owner, a member on the project, an agent ---------------------
  await superuser();
  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${OWNER_USER}', 'owner@example.com'), ('${MEMBER_USER}', 'member@example.com')`);
  const people = await q<{ id: string; auth_user_id: string }>('SELECT id, auth_user_id FROM public.team_members');
  const owner = people.find((m) => m.auth_user_id === OWNER_USER)!.id;
  const member = people.find((m) => m.auth_user_id === MEMBER_USER)!.id;
  await db.query("UPDATE public.team_members SET name = 'Maya' WHERE id = $1", [member]);
  const agent = (await q<{ id: string }>("INSERT INTO public.team_members (name, email, role) VALUES ('Jeff', 'jeff@example.com', 'agent') RETURNING id"))[0].id;
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'app', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read', 'portal.read', 'files.read']) AS key`, [member]);
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'app', 'deny' FROM unnest(ARRAY['invoices.read', 'time.read_all', 'credentials.manage', 'audit.read']) AS key`, [member]);
  // Member hours wait for review, so the owner's approval is a decision of its own.
  await db.query('UPDATE public.business_settings SET auto_approve_human_hours = false');
  const project = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Happy Innovations') RETURNING id"))[0].id;
  const otherProject = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Apex Motor Coaches') RETURNING id"))[0].id;
  await db.query('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [project, member]);
  check('writes with no person behind them (setup, cron) are not logged', (await total()) === 0, await rows());

  // --- Tasks ---------------------------------------------------------------
  await asOwner();
  const task = (await q<{ id: string }>(
    "INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'Redesign the homepage', $2) RETURNING id", [project, owner]))[0].id;
  let row = await latest();
  check('creating a task is logged for the person, from the app, on the project',
    row?.type === 'task.created' && row.user_id === owner && row.source === 'app' && row.project_id === project
      && row.description === 'Created task "Redesign the homepage"', row);

  await asOwner();
  await db.query("UPDATE public.tasks SET title = 'Redesign the home page' WHERE id = $1", [task]);
  await db.query("UPDATE public.tasks SET description = 'Hero, pricing, footer' WHERE id = $1", [task]);
  const edits = await rows("type = 'task.updated'");
  check('repeated edits by one person fold into one row naming every field',
    edits.length === 1 && JSON.stringify(edits[0].metadata.fields) === '["description","title"]'
      && edits[0].description === 'Edited task "Redesign the home page"', edits);

  const before = await total();
  await asOwner();
  await db.query('UPDATE public.tasks SET sort_order = 7 WHERE id = $1', [task]);
  check('reordering is not logged', (await total()) === before);

  await asOwner();
  await db.query("UPDATE public.tasks SET status = 'in_review' WHERE id = $1", [task]);
  check('a status move says where it went', (await latest())?.description === 'Moved task "Redesign the home page" to In review', await latest());
  await asOwner();
  await db.query("UPDATE public.tasks SET status = 'done' WHERE id = $1", [task]);
  check('finishing a task is "Completed"', (await latest())?.type === 'task.completed', await latest());
  await asOwner();
  await db.query("UPDATE public.tasks SET status = 'todo' WHERE id = $1", [task]);
  check('moving it back out of done is "Reopened"', (await latest())?.type === 'task.reopened', await latest());

  // --- Assignees -----------------------------------------------------------
  await asOwner();
  await db.exec(`BEGIN;
    INSERT INTO public.tasks (id, project_id, title, created_by) VALUES ('00000000-0000-0000-0000-00000000c001', '${project}', 'Write the case study', '${owner}');
    INSERT INTO public.task_assignees (task_id, member_id) VALUES ('00000000-0000-0000-0000-00000000c001', '${member}');
    COMMIT;`);
  check('assignees saved with a new task are covered by "Created task"', (await rows("type = 'task.assigned'")).length === 0, await rows("type = 'task.assigned'"));

  await asOwner();
  await db.query('SELECT public.save_task($1, $2::jsonb, $3::uuid[])', [task, '{}', [member]]);
  row = await latest();
  check('assigning someone names them', row?.type === 'task.assigned' && row.description === 'Assigned Maya to task "Redesign the home page"', row);
  const afterAssign = await total();
  await asOwner();
  await db.query('SELECT public.save_task($1, $2::jsonb, $3::uuid[])', [task, '{}', [member]]);
  check('re-saving the same assignees logs nothing', (await total()) === afterAssign, (await rows()).slice(afterAssign));
  await asOwner();
  await db.query('SELECT public.save_task($1, $2::jsonb, $3::uuid[])', [task, '{}', [owner]]);
  const swaps = (await rows()).slice(afterAssign).map((r) => r.description);
  check('changing assignees logs only who came and went',
    swaps.includes('Took on task "Redesign the home page"') && swaps.includes('Unassigned Maya from task "Redesign the home page"'), swaps);

  // --- Comments and subtasks -------------------------------------------------
  await asMember();
  await db.query("INSERT INTO public.task_comments (task_id, user_id, text) VALUES ($1, $2, 'Sent the draft to Matthew')", [task, member]);
  row = await latest();
  check('a comment is logged for its author with a preview',
    row?.type === 'comment.added' && row.user_id === member && row.metadata.preview === 'Sent the draft to Matthew'
      && row.description === 'Commented on "Redesign the home page"', row);
  await asOwner();
  const subtask = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, parent_task_id, created_by) VALUES ($1, 'Pick the hero photo', $2, $3) RETURNING id",
    [project, task, owner]))[0].id;
  await db.query("UPDATE public.tasks SET status = 'done' WHERE id = $1", [subtask]);
  check('subtasks log being added and finished',
    (await rows('entity_id = $1', [subtask])).map((r) => r.description).join(' | ')
      === 'Added subtask "Pick the hero photo" to "Redesign the home page" | Completed task "Pick the hero photo"',
    (await rows('entity_id = $1', [subtask])).map((r) => r.description));

  // --- Who did it ------------------------------------------------------------
  let count = await total();
  await asServer(null);
  await db.query("UPDATE public.tasks SET priority = 'high' WHERE id = $1", [task]);
  check('a server write that names nobody is not logged', (await total()) === count);

  await asServer({ 'x-actor-member-id': member, 'x-actor-via': 'mcp' });
  await db.query("UPDATE public.tasks SET status = 'in_progress' WHERE id = $1", [task]);
  row = await latest();
  check('a server write naming a person is logged for them, with where it came from',
    row?.type === 'task.moved' && row.user_id === member && row.source === 'mcp', row);

  await asServer({ 'x-actor-member-id': agent, 'x-actor-via': 'api' });
  count = await total();
  await db.query("UPDATE public.tasks SET status = 'in_review' WHERE id = $1", [task]);
  check('agents keep their own log: their writes are not logged here', (await total()) === count, await latest());

  await asOwner();
  await db.query("SELECT set_config('request.headers', $1, false)", [JSON.stringify({ 'x-actor-member-id': member })]);
  await db.query("UPDATE public.tasks SET status = 'todo' WHERE id = $1", [task]);
  row = await latest();
  check('a signed-in person cannot claim to be someone else through the header', row?.user_id === owner, row);
  await db.query("SELECT set_config('request.headers', '', false)");

  // --- Time, money, credentials ------------------------------------------------
  await asServer({ 'x-actor-member-id': member, 'x-actor-via': 'app' });
  const entry = (await q<{ id: string }>(`INSERT INTO public.project_time_entries (project_id, member_id, start_time, end_time, segments, hourly_rate)
    VALUES ($1, $2, '2026-10-20T15:00:00Z', '2026-10-20T16:30:00Z', '[]'::jsonb, 100) RETURNING id`, [project, member]))[0].id;
  row = await latest();
  check('time entered whole is logged with its length', row?.type === 'time.logged' && row.description === 'Logged 1h 30m' && row.user_id === member, row);
  await asServer({ 'x-actor-member-id': owner, 'x-actor-via': 'app' });
  await db.query("UPDATE public.project_time_entries SET approval_status = 'approved' WHERE id = $1", [entry]);
  check('approving time names whose it was', (await latest())?.description === 'Approved 1h 30m from Maya', await latest());

  await asServer({ 'x-actor-member-id': member, 'x-actor-via': 'app' });
  const timer = (await q<{ id: string }>(`INSERT INTO public.project_time_entries (project_id, member_id, start_time, segments, hourly_rate)
    VALUES ($1, $2, '2026-10-21T15:00:00Z', '[]'::jsonb, 100) RETURNING id`, [project, member]))[0].id;
  check('a running timer is not logged yet', (await rows("type = 'time.logged'")).length === 1);
  await asServer({ 'x-actor-member-id': member, 'x-actor-via': 'app' });
  await db.query("UPDATE public.project_time_entries SET end_time = '2026-10-21T15:45:00Z' WHERE id = $1", [timer]);
  check('stopping the timer logs the time', (await latest())?.description === 'Logged 45m', await latest());
  await superuser();
  await db.query('UPDATE public.business_settings SET auto_approve_human_hours = true');
  await asServer({ 'x-actor-member-id': member, 'x-actor-via': 'app' });
  await db.query(`INSERT INTO public.project_time_entries (project_id, member_id, start_time, end_time, segments, hourly_rate)
    VALUES ($1, $2, '2026-10-21T17:00:00Z', '2026-10-21T18:00:00Z', '[]'::jsonb, 100)`, [project, member]);
  check('time the workspace approves by itself is not logged as an approval', (await rows("type = 'time.approved'")).length === 1);

  await asOwner();
  const invoice = (await q<{ id: string }>(`INSERT INTO public.project_invoices (project_id, invoice_number, amount, status, date, created_by)
    VALUES ($1, 'INV-007', 1500, 'draft', '2026-10-21', $2) RETURNING id`, [project, owner]))[0].id;
  await db.query("UPDATE public.project_invoices SET status = 'sent' WHERE id = $1", [invoice]);
  check('invoices log being created and sent',
    (await rows("entity_type = 'invoice'")).map((r) => r.description).join(' | ') === 'Created invoice INV-007 | Sent invoice INV-007');

  await asOwner();
  await db.query("INSERT INTO public.project_credentials (project_id, label, encrypted_data, iv, created_by) VALUES ($1, 'Hosting', 'cipher', 'nonce', $2)", [project, owner]);
  row = await latest();
  check('a credential logs its label and nothing from the secret',
    row?.description === 'Added credential "Hosting"' && !JSON.stringify(row).includes('cipher') && !JSON.stringify(row).includes('nonce'), row);

  // --- Trash -------------------------------------------------------------------
  await asOwner();
  await db.query("SELECT public.soft_delete_record('tasks', $1)", [subtask]);
  row = await latest();
  check('moving to Trash is logged on the project',
    row?.type === 'record.trashed' && row.description === 'Moved task "Pick the hero photo" to Trash' && row.project_id === project, row);
  await asOwner();
  await db.query("SELECT public.restore_record('tasks', $1)", [subtask]);
  check('restoring is logged too', (await latest())?.description === 'Restored task "Pick the hero photo"', await latest());

  // --- Who can read what ---------------------------------------------------------
  await asOwner();
  await db.query("INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'Quote calculator', $2)", [otherProject, owner]);
  await asMember();
  await db.query("INSERT INTO public.reminders (title, owner_id, created_by) VALUES ('Call the dentist', $1, $1)", [member]);
  await asMember();
  const memberSees = await q<Row>('SELECT type, entity_type, project_id, description FROM public.activities');
  const kinds = new Set(memberSees.map((r) => r.entity_type));
  check('people on the project see its task activity', memberSees.some((r) => r.type === 'task.created' && r.project_id === project));
  check('but not invoices, credentials or other people\'s time without those permissions',
    !kinds.has('invoice') && !kinds.has('credential') && !memberSees.some((r) => r.type === 'time.approved'), [...kinds]);
  check('their own time they do see', memberSees.some((r) => r.type === 'time.logged'));
  check('nor projects they are not on', !memberSees.some((r) => r.project_id === otherProject));
  await asOwner();
  const ownerSees = await q<Row>('SELECT type, entity_type, project_id, description FROM public.activities');
  check('the owner sees invoices, time and credentials',
    ['invoice', 'time_entry', 'credential'].every((kind) => ownerSees.some((r) => r.entity_type === kind)));
  check('a standalone reminder stays with the person who made it',
    !ownerSees.some((r) => r.description === 'Added reminder "Call the dentist"')
      && memberSees.some((r) => r.description === 'Added reminder "Call the dentist"'));

  await asOwner();
  await db.query("SELECT public.soft_delete_record('projects', $1)", [project]);
  await asOwner();
  const whileTrashed = await q<Row>('SELECT project_id FROM public.activities WHERE project_id = $1', [project]);
  check('a project in Trash hides its activity, even from the owner', whileTrashed.length === 0, whileTrashed.length);
  await asOwner();
  await db.query("SELECT public.restore_record('projects', $1)", [project]);
  await asOwner();
  check('and restoring it brings the activity back', (await q('SELECT 1 FROM public.activities WHERE project_id = $1', [project])).length > 0);

  await asOwner();
  const forged = await attempt(db, `INSERT INTO public.activities (type, entity_type, entity_id, user_id, description)
    VALUES ('task.completed', 'task', 'x', $1, 'Completed everything')`, [member]);
  check('nobody can write the log directly', !!forged, forged);

  // --- Backfill ------------------------------------------------------------------
  await superuser();
  const oldTask = (await q<{ id: string }>(
    "INSERT INTO public.tasks (project_id, title, created_by, created_at) VALUES ($1, 'Old task', $2, '2026-01-05T10:00:00Z') RETURNING id", [project, member]))[0].id;
  await db.query("INSERT INTO public.task_comments (task_id, user_id, text, created_at) VALUES ($1, $2, 'Old note', '2026-01-06T10:00:00Z')", [oldTask, member]);
  await db.query("INSERT INTO public.tasks (project_id, title, created_by) VALUES ($1, 'Agent task', $2)", [project, agent]);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  const filled = await rows("source = 'backfill'");
  check('the backfill logs past work by its author at its original time',
    filled.some((r) => r.type === 'task.created' && r.description === 'Created task "Old task"' && r.user_id === member)
      && filled.some((r) => r.type === 'comment.added' && r.user_id === member), filled.map((r) => r.description));
  check('but never for agents', !filled.some((r) => r.description === 'Created task "Agent task"'));
  check('nor twice for what was already logged', !filled.some((r) => r.description === 'Created task "Redesign the homepage"'));
  const once = await total();
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  check('running the migration again adds nothing', (await total()) === once, (await total()) - once);

  // --- Through the real v1 API (withApi, supabase-js, fake PostgREST) -----------
  await superuser();
  await db.exec(`DROP FUNCTION public.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const keyFor = async (memberId: string) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await db.query(`INSERT INTO public.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId,
      ['tasks.read', 'tasks.manage_all', 'projects.read', 'projects.read_all']]);
    return secret;
  };
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'api', 'allow' FROM unnest(ARRAY['tasks.read', 'tasks.manage_all', 'projects.read', 'projects.read_all']) AS key`, [agent]);
  await db.query('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [project, agent]);
  const [ownerKey, agentKey] = [await keyFor(owner), await keyFor(agent)];
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const taskRoute = await import('../src/app/api/v1/tasks/[id]/route');
    const patch = async (key: string, body: unknown) => {
      const response = await taskRoute.PATCH(new NextRequest(`http://localhost/api/v1/tasks/${task}`, {
        method: 'PATCH', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: task }) });
      return response.status;
    };
    const ownerStatus = await patch(ownerKey, { status: 'done' });
    row = await latest();
    check('a v1 API write is logged for the key\'s person, from the API',
      ownerStatus === 200 && row?.type === 'task.completed' && row.user_id === owner && row.source === 'api', { ownerStatus, row });
    const beforeAgent = await total();
    const agentStatus = await patch(agentKey, { status: 'in_progress' });
    check('an agent\'s v1 API write is not logged here', agentStatus === 200 && (await total()) === beforeAgent, { agentStatus, row: await latest() });
  } finally {
    await server.close();
  }

  console.log(`team activity: ${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
