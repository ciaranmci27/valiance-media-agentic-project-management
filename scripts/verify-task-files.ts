/**
 * Task files: a task's own uploads and links to email attachments and project
 * files. One live entry per file per task; exactly one source per row; a
 * linked attachment cannot be deleted from under a task; members see only
 * their tasks' files, write none directly (the server does), and trash only
 * their own (or any with files.manage);
 * files move to Trash and back like comments, blocked while their task is in
 * Trash; the activity log says what happened, project uploads included (the
 * migration also fixes their log trigger). The migrations apply to the
 * schema from before them and run twice; schema.sql describes the same end state.
 *
 * Runs on PGlite (real Postgres) over the whole real schema; nothing touches
 * a live database.
 *
 *   npm run -s test:task-files
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, schemaBeforeMigration } from './full-schema-db';

const FIRST_MIGRATION = '20261024072858_task_files.sql';
const OWNER_USER = '00000000-0000-0000-0000-0000000000d1';
const MEMBER_USER = '00000000-0000-0000-0000-0000000000d2';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function attempt(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

async function run(db: PGlite, label: string) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const superuser = async () => {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false), set_config('request.jwt.claims', '', false), set_config('request.headers', '', false)");
  };
  const asOwner = () => actAs(db, OWNER_USER);
  const asMember = () => actAs(db, MEMBER_USER);
  const t = (name: string) => `${label}: ${name}`;

  // --- Seed -------------------------------------------------------------------
  await superuser();
  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${OWNER_USER}', 'owner@example.com'), ('${MEMBER_USER}', 'member@example.com')`);
  const people = await q<{ id: string; auth_user_id: string }>('SELECT id, auth_user_id FROM public.team_members');
  const owner = people.find((m) => m.auth_user_id === OWNER_USER)!.id;
  const member = people.find((m) => m.auth_user_id === MEMBER_USER)!.id;
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'app', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read', 'tasks.create', 'files.read', 'files.upload']) AS key`, [member]);
  const project = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Happy Innovations') RETURNING id"))[0].id;
  const elsewhere = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  await db.query('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [project, member]);
  const task = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Holiday banner') RETURNING id", [project]))[0].id;
  const hiddenTask = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Not theirs') RETURNING id", [elsewhere]))[0].id;
  // Uploaded by a signed-in person: the path log_file_activity broke (fixed here).
  await asOwner();
  const projectFile = (await q<{ id: string }>(`INSERT INTO public.entity_files (entity_type, entity_id, name, file_url, uploaded_by)
    VALUES ('project', $1, 'brand-guide.pdf', 'https://example.com/brand-guide.pdf', $2) RETURNING id`, [project, owner]))[0].id;
  await superuser();
  await db.exec(`
    INSERT INTO communications.inboxes (id, name, address, routing_domain, routing_local_part)
      VALUES ('00000000-0000-4000-8000-0000000000f1', 'Ops', 'ops@example.com', 'relay.example.com', 'ops');
    INSERT INTO communications.conversations (id, inbox_id) VALUES ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000f1');
    INSERT INTO communications.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id)
      VALUES ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f2',
              'handled', 'resend', 'tf-1', 'tf-1@example.com');
    INSERT INTO communications.attachments (id, message_id, position, filename, content_type, storage_path, sha256, size_bytes, uploaded_at)
      VALUES ('00000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-0000000000f3', 0, 'screenshot.png', 'image/png',
              'inbox/msg/att', '${SHA_B}', 1200, now());
  `);
  const attachment = '00000000-0000-4000-8000-0000000000f4';

  // --- Adding files: the server writes, members only read ---------------------------
  await asMember();
  check(t('a member cannot add a task file directly, even to their own task as themselves'),
    /permission denied/.test((await attempt(db, "INSERT INTO public.task_files (task_id, kind, storage_path, sha256, name, added_by) VALUES ($1, 'upload', $2, $3, 'x.png', $4)", [task, `${project}/${'c'.repeat(64)}`, 'c'.repeat(64), member])) ?? ''));

  // The server: the service role, naming the member it acts for (getActorClient).
  await db.exec('RESET ROLE; SET ROLE service_role');
  await db.query("SELECT set_config('request.jwt.claims', $1, false), set_config('request.jwt.claim.role', 'service_role', false), set_config('request.headers', $2, false)",
    [JSON.stringify({ role: 'service_role' }), JSON.stringify({ 'x-actor-member-id': member, 'x-actor-via': 'app' })]);
  const insertUpload = (sha: string, name = 'banner.png') => attempt(db,
    `INSERT INTO public.task_files (task_id, kind, storage_path, sha256, name, mime_type, file_size, added_by)
     VALUES ($1, 'upload', $2, $3, $4, 'image/png', 2048, $5)`, [task, `${project}/${sha}`, sha, name, member]);
  check(t('the server adds an upload for a member'), (await insertUpload(SHA_A)) === null);
  check(t('the same bytes twice on one task add nothing (one live entry)'), /task_files_live_upload|duplicate key/.test((await insertUpload(SHA_A, 'banner copy.png')) ?? ''));
  check(t('it links a project file and an email attachment, no copies'),
    (await attempt(db, "INSERT INTO public.task_files (task_id, kind, entity_file_id, name, added_by) VALUES ($1, 'project_file', $2, 'brand-guide.pdf', $3)", [task, projectFile, member])) === null
      && (await attempt(db, "INSERT INTO public.task_files (task_id, kind, email_attachment_id, name, mime_type, added_by) VALUES ($1, 'email_attachment', $2, 'screenshot.png', 'image/png', $3)", [task, attachment, member])) === null);
  check(t('a row has exactly one source'),
    /task_files_one_source/.test((await attempt(db, "INSERT INTO public.task_files (task_id, kind, name, added_by) VALUES ($1, 'upload', 'no bytes', $2)", [task, member])) ?? '')
      && /task_files_one_source/.test((await attempt(db, "INSERT INTO public.task_files (task_id, kind, email_attachment_id, entity_file_id, name, added_by) VALUES ($1, 'email_attachment', $2, $3, 'both', $4)", [task, attachment, projectFile, member])) ?? ''));
  await db.query("INSERT INTO public.task_files (task_id, kind, storage_path, sha256, name, added_by) VALUES ($1, 'upload', $2, $3, 'secret.png', $4)",
    [hiddenTask, `${elsewhere}/${SHA_A}`, SHA_A, owner]);
  const ownersFile = (await q<{ id: string }>("INSERT INTO public.task_files (task_id, kind, storage_path, sha256, name, added_by) VALUES ($1, 'upload', $2, $3, 'owners.png', $4) RETURNING id",
    [task, `${project}/${'e'.repeat(64)}`, 'e'.repeat(64), owner]))[0].id;

  await asMember();
  const visible = await q<{ name: string }>('SELECT name FROM public.task_files ORDER BY name');
  check(t("a member sees their task's files and none of another project's"),
    visible.map((r) => r.name).join(',') === 'banner.png,brand-guide.pdf,owners.png,screenshot.png', visible);
  check(t('a member cannot rename or repoint a file directly'),
    /permission denied/.test((await attempt(db, "UPDATE public.task_files SET storage_path = $1 WHERE name = 'banner.png'", [`${elsewhere}/${SHA_A}`])) ?? '')
      && /permission denied/.test((await attempt(db, "UPDATE public.task_files SET name = 'renamed.png' WHERE name = 'banner.png'")) ?? ''));

  // --- A link holds its source -------------------------------------------------------
  await superuser();
  check(t('a linked email attachment cannot be deleted from under the task'),
    /violates foreign key|task_files/.test((await attempt(db, 'DELETE FROM communications.attachments WHERE id = $1', [attachment])) ?? ''));
  check(t('rows are never hard-deleted'), (await attempt(db, 'DELETE FROM public.task_files WHERE task_id = $1', [task])) !== null);

  // --- Trash, like comments ------------------------------------------------------------
  const banner = (await q<{ id: string }>("SELECT id FROM public.task_files WHERE name = 'banner.png'"))[0].id;
  await asMember();
  check(t("a member cannot trash someone else's file without files.manage"),
    (await attempt(db, "SELECT public.soft_delete_record('task_files', $1)", [ownersFile])) !== null);
  check(t('a member moves their own file to Trash'), (await attempt(db, "SELECT public.soft_delete_record('task_files', $1)", [banner])) === null
    && (await q("SELECT 1 FROM public.task_files WHERE id = $1", [banner])).length === 0);
  check(t('it is listed in Trash with its task'),
    (await q<{ record_type: string; context: string | null }>('SELECT record_type, context FROM public.list_trash() WHERE id = $1', [banner]))[0]?.context === 'Holiday banner');
  await superuser();
  check(t('trashing frees its place: the same bytes can be added again'), (await insertUpload(SHA_A, 'banner again.png')) === null);
  await db.query("UPDATE public.task_files SET deleted_at = now() WHERE name = 'banner again.png'");
  await asMember();
  check(t('and it comes back from Trash'), (await attempt(db, "SELECT public.restore_record('task_files', $1)", [banner])) === null
    && (await q('SELECT 1 FROM public.task_files WHERE id = $1', [banner])).length === 1);

  await asOwner();
  await db.query("SELECT public.soft_delete_record('task_files', $1)", [banner]);
  await db.query("SELECT public.soft_delete_record('tasks', $1)", [task]);
  const blocked = await attempt(db, "SELECT public.restore_record('task_files', $1)", [banner]);
  check(t('a file whose task is in Trash waits for the task'), /task/i.test(blocked ?? ''), blocked);
  await db.query("SELECT public.restore_record('tasks', $1)", [task]);

  // --- The activity log ------------------------------------------------------------------
  await superuser();
  const activity = await q<{ type: string; entity_type: string; description: string }>(
    "SELECT type, entity_type, description FROM public.activities WHERE entity_type = 'file' ORDER BY created_at, updated_at");
  check(t('the log says who added what (a project upload too) to which task, and when it went to Trash'),
    activity.some((a) => a.type === 'file.uploaded' && a.description === 'Uploaded "brand-guide.pdf"')
      && activity.some((a) => a.type === 'file.uploaded' && a.description === 'Uploaded "banner.png" to task "Holiday banner"')
      && activity.some((a) => a.type === 'file.attached' && a.description === 'Attached "brand-guide.pdf" to task "Holiday banner"')
      && activity.some((a) => a.type === 'record.trashed' && /Moved .*"banner.png" to Trash/.test(a.description)), activity);
}

async function main() {
  const migrated = await createFullSchemaDatabase({ schemaSql: schemaBeforeMigration(FIRST_MIGRATION) });
  await migrated.exec('RESET ROLE');
  // The task files migrations and everything after them, to today's schema.
  await applyMigrationsFrom(migrated, FIRST_MIGRATION);
  await run(migrated, 'migrated');
  await migrated.close();

  const fresh = await createFullSchemaDatabase();
  await run(fresh, 'schema.sql');
  await fresh.close();

  if (failures.length) {
    console.error(`task files: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`task files: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
