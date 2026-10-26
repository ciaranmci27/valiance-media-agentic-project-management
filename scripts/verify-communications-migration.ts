/**
 * The communications schema migration, end to end on PGlite:
 * - on the schema as it was before it (schema.sql from git), with old-shape
 *   data in every table it moves (links, files, reminders and task files
 *   pointing at attachments, answers, a thread filed by a project address),
 *   applied twice: every row keeps its id, the foreign keys into the moved
 *   tables follow, the projects land in conversation_projects, the new
 *   columns are filled, nothing is left in public;
 * - the result matches schema.sql loaded on its own: tables and columns,
 *   constraints, indexes, functions (body, security, settings), triggers,
 *   policies, views and the grants of anon, authenticated and service_role;
 * - a signed-in person reaches the tables only through RLS and runs no service function.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-communications-migration.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION = readdirSync(MIGRATIONS).find((name) => name.endsWith('_communications_schema.sql'))!;

/** schema.sql as it was before this migration: the parent of the commit that added it, or HEAD before it is committed. */
function schemaBefore(): string {
  const git = (args: string[]) => execFileSync('git', args, { cwd: join(__dirname, '..'), encoding: 'utf8' }).trim();
  const added = git(['log', '--diff-filter=A', '--format=%H', '--', `supabase/migrations/${MIGRATION}`]).split('\n').filter(Boolean).pop();
  return git(['show', `${added ? `${added}^` : 'HEAD'}:./supabase/schema.sql`]);
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  owner: id(1), ashley: id(2), project: id(3), other: id(4), inbox: id(5), address: id(6), thread: id(7), thread2: id(8),
  message: id(9), message2: id(10), task: id(11), file: id(12), attachment: id(13), triage: id(14), reminder: id(15),
  taskFile: id(16), contact: id(17), rule: id(18), draft: id(19), answer: id(20), forwarded: id(21),
};

async function seedOld(db: PGlite) {
  await db.exec(`
    INSERT INTO public.team_members (id, auth_user_id, name, email, role) VALUES
      ('${ids.owner}', NULL, 'Owner', 'owner@agency.example', 'owner'),
      ('${ids.ashley}', NULL, 'Ashley', 'ashley@agency.example', 'agent');
    INSERT INTO public.projects (id, name) VALUES ('${ids.project}', 'Acme'), ('${ids.other}', 'Birch');
    INSERT INTO public.contacts (id, name, email) VALUES ('${ids.contact}', 'Dana', 'dana@acme.example');
    UPDATE public.business_settings SET inbound_email_domain = 'relay.example.test';
    INSERT INTO public.email_inboxes (id, name, address, handler_member_id) VALUES ('${ids.inbox}', 'Ashley', 'ashley@agency.example', '${ids.ashley}');
    INSERT INTO public.email_project_addresses (id, project_id, inbox_id, public_address) VALUES ('${ids.address}', '${ids.project}', '${ids.inbox}', 'hi@acme.example');
    INSERT INTO public.email_client_domains (domain, project_id) VALUES ('acme.example', '${ids.project}');
    INSERT INTO public.email_client_addresses (project_id, address) VALUES ('${ids.other}', 'bob@gmail.com');
    INSERT INTO public.email_sender_rules (id, match_kind, match_value, action, source) VALUES ('${ids.rule}', 'domain', 'news.example', 'ignore', 'person');
    INSERT INTO public.email_threads (id, inbox_id, subject_normalized, project_id, project_source, project_address_id, summary)
      VALUES ('${ids.thread}', '${ids.inbox}', 'launch', '${ids.project}', 'address', '${ids.address}', 'Launch plan agreed');
    INSERT INTO public.email_threads (id, inbox_id, subject_normalized) VALUES ('${ids.thread2}', '${ids.inbox}', 'hello');
    INSERT INTO public.email_messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id, subject,
      auth, routing_basis, forwarded_by_member_id, original_from_address, updated_at)
      VALUES ('${ids.message}', '${ids.inbox}', '${ids.thread}', 'handled', 'resend', 're_1', 'one@acme.example', 'Launch',
        '{"trust": "trusted"}', 'forwarded_original', '${ids.owner}', 'dana@acme.example', '2026-10-01T10:00:00Z'),
      ('${ids.message2}', '${ids.inbox}', '${ids.thread2}', 'new', 'resend', 're_2', 'two@else.example', 'Hello',
        '{"trust": "unknown"}', 'sender', NULL, NULL, '2026-10-02T10:00:00Z');
    INSERT INTO public.email_message_recipients (message_id, kind, address, name, contact_id) VALUES
      ('${ids.message}', 'from', 'owner@agency.example', 'Owner', NULL), ('${ids.message}', 'to', 'dana@acme.example', 'Dana', '${ids.contact}');
    INSERT INTO public.email_message_candidates (message_id, project_id, reason) VALUES ('${ids.message}', '${ids.project}', 'domain');
    INSERT INTO public.email_files (id, inbox_id, sha256, size_bytes, storage_path, stored_at)
      VALUES ('${ids.file}', '${ids.inbox}', '${'a'.repeat(64)}', 10, '${ids.inbox}/files/${ids.file}', now());
    INSERT INTO public.email_attachments (id, message_id, position, filename, size_bytes, sha256, storage_path, uploaded_at, file_id)
      VALUES ('${ids.attachment}', '${ids.message}', 0, 'plan.pdf', 10, '${'a'.repeat(64)}', '${ids.inbox}/files/${ids.file}', now(), '${ids.file}');
    INSERT INTO public.tasks (id, project_id, title, created_by) VALUES ('${ids.task}', '${ids.project}', 'Ship the launch', '${ids.owner}');
    INSERT INTO public.email_triage (id, message_id, member_id, outcome, summary, question_for_human)
      VALUES ('${ids.triage}', '${ids.message}', '${ids.ashley}', 'task', 'Filed the launch', 'Which date?');
    INSERT INTO public.email_task_links (message_id, task_id, relation, triage_id, linked_by) VALUES ('${ids.message}', '${ids.task}', 'created', '${ids.triage}', '${ids.ashley}');
    INSERT INTO public.email_question_answers (id, message_id, triage_id, answer, answered_by) VALUES ('${ids.answer}', '${ids.message}', '${ids.triage}', 'Friday', '${ids.owner}');
    INSERT INTO public.email_reply_drafts (id, thread_id, message_id, requested_by) VALUES ('${ids.draft}', '${ids.thread}', '${ids.message}', '${ids.owner}');
    INSERT INTO public.email_maintenance_runs (kind, started_at, finished_at, outcome) VALUES ('retention', now(), now(), 'complete');
    INSERT INTO public.reminders (id, title, project_id, task_id, source_message_id, owner_id, created_by)
      VALUES ('${ids.reminder}', 'Chase Dana', '${ids.project}', '${ids.task}', '${ids.message}', '${ids.owner}', '${ids.owner}');
    INSERT INTO public.task_files (id, task_id, kind, email_attachment_id, name, added_by)
      VALUES ('${ids.taskFile}', '${ids.task}', 'email_attachment', '${ids.attachment}', 'plan.pdf', '${ids.owner}');
  `);
}

type Row = Record<string, unknown>;
const rows = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Row>(sql, params)).rows;

/** Everything about the communications schema a reader could tell apart, one sorted line each. */
async function describe(db: PGlite): Promise<string[]> {
  const out: string[] = [];
  const add = (prefix: string, list: Row[]) => list.forEach((row) => out.push(`${prefix} ${JSON.stringify(row)}`));
  add('column', await rows(db, `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default, is_generated, generation_expression
    FROM information_schema.columns WHERE table_schema = 'communications' ORDER BY 1, 3`));
  add('constraint', await rows(db, `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'communications'::regnamespace ORDER BY 1, 2`));
  add('index', await rows(db, `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'communications' ORDER BY 1, 2`));
  add('function', await rows(db, `SELECT proname, pg_get_function_identity_arguments(oid) AS args, prosecdef, provolatile, proconfig,
      md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) AS body, pg_get_function_result(oid) AS result
    FROM pg_proc WHERE pronamespace = 'communications'::regnamespace ORDER BY 1, 2`));
  add('trigger', await rows(db, `SELECT tgrelid::regclass::text AS tbl, tgname, pg_get_triggerdef(oid) AS def
    FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'communications'::regnamespace) ORDER BY 1, 2`));
  add('policy', await rows(db, `SELECT tablename, policyname, permissive, roles::text, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'communications' ORDER BY 1, 2`));
  add('rls', await rows(db, `SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'communications'::regnamespace AND relkind = 'r' ORDER BY 1`));
  add('view', await rows(db, `SELECT viewname, md5(regexp_replace(definition, '\\s+', ' ', 'g')) AS def FROM pg_views WHERE schemaname = 'communications' ORDER BY 1`));
  add('table grant', await rows(db, `SELECT c.relname, r.role,
      has_table_privilege(r.role, c.oid, 'SELECT') AS sel, has_table_privilege(r.role, c.oid, 'INSERT') AS ins,
      has_table_privilege(r.role, c.oid, 'UPDATE') AS upd, has_table_privilege(r.role, c.oid, 'DELETE') AS del
    FROM pg_class c CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
    WHERE c.relnamespace = 'communications'::regnamespace AND c.relkind IN ('r', 'v') ORDER BY 1, 2`));
  add('function grant', await rows(db, `SELECT p.proname, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') AS run
    FROM pg_proc p CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
    WHERE p.pronamespace = 'communications'::regnamespace ORDER BY 1, 2`));
  add('schema grant', await rows(db, `SELECT r.role, has_schema_privilege(r.role, 'communications', 'USAGE') AS usage
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role) ORDER BY 1`));
  return out.sort();
}

async function main() {
  // ---- The migration on the schema before it, with data ---------------
  const before = await createFullSchemaDatabase({ schemaSql: schemaBefore() });
  try {
    await seedOld(before);
    const counts = await rows(before, `SELECT
      (SELECT count(*) FROM public.email_messages)::int AS messages, (SELECT count(*) FROM public.email_attachments)::int AS attachments,
      (SELECT count(*) FROM public.email_task_links)::int AS links`);
    // This migration and every one after it, each twice (safe to re-run).
    await applyMigrationsFrom(before, MIGRATION);

    const [moved] = await rows(before, `SELECT
      (SELECT count(*) FROM communications.messages)::int AS messages, (SELECT count(*) FROM communications.attachments)::int AS attachments,
      (SELECT count(*) FROM communications.task_links)::int AS links`);
    check('move: every row arrives with its id', JSON.stringify(moved) === JSON.stringify(counts[0])
      && (await rows(before, `SELECT 1 FROM communications.messages WHERE id = $1 AND subject = 'Launch'`, [ids.message])).length === 1, { moved, counts });
    const leftover = [
      ...(await rows(before, `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'email\\_%' AND relkind IN ('r', 'v')`)),
      // The address helpers and contact_emails stay in public: contacts use them.
      ...(await rows(before, `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'email\\_%' AND proname NOT IN
          ('email_is_address', 'email_is_hostname', 'email_domain_is_public', 'email_inbox_verification_code')`)),
    ];
    check('move: nothing email_ is left in public', leftover.length === 0, leftover);
    const fks = await rows(before, `SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS refs FROM pg_constraint
      WHERE contype = 'f' AND conrelid IN ('public.reminders'::regclass, 'public.task_files'::regclass) AND confrelid::regclass::text LIKE 'communications.%'`);
    check('move: reminders and task files still point at the message and the attachment',
      fks.some((f) => f.tbl === 'reminders' && f.refs === 'communications.messages') && fks.some((f) => f.tbl === 'task_files' && f.refs === 'communications.attachments'), fks);
    let held = '';
    try { await before.query('DELETE FROM communications.attachments WHERE id = $1', [ids.attachment]); } catch (error) { held = (error as Error).message; }
    check('move: an attachment a task file uses still cannot be deleted', /foreign key/.test(held), held);
    const projects = await rows(before, 'SELECT conversation_id, project_id, source, endpoint_id FROM communications.conversation_projects');
    check('backfill: the thread\'s project is its conversation project, with its endpoint',
      projects.length === 1 && projects[0].conversation_id === ids.thread && projects[0].source === 'address' && projects[0].endpoint_id === ids.address, projects);
    const [message] = await rows(before, 'SELECT sender_member_id, sender_verified, channel, updated_at FROM communications.messages WHERE id = $1', [ids.message]);
    const [other] = await rows(before, 'SELECT sender_member_id, sender_verified FROM communications.messages WHERE id = $1', [ids.message2]);
    check('backfill: the teammate and the trust land on the message, its updated_at untouched',
      message.sender_member_id === ids.owner && message.sender_verified === true && message.channel === 'email'
      && new Date(String(message.updated_at)).toISOString() === '2026-10-01T10:00:00.000Z' && other.sender_member_id === null && other.sender_verified === false, [message, other]);
    check('backfill: messages of an address thread came through its endpoint',
      (await rows(before, 'SELECT 1 FROM communications.message_endpoints WHERE message_id = $1 AND endpoint_id = $2', [ids.message, ids.address])).length === 1);
    check('legacy: a snapshot of every table stays apart',
      (await rows(before, `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'communications_legacy'`))[0].n === 17
      && (await rows(before, 'SELECT count(*)::int AS n FROM communications_legacy.email_messages'))[0].n === 2);

    // The copy on conversations follows conversation_projects.
    await before.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claim.role', 'service_role', false);`);
    await before.query('SELECT communications.set_conversation_project($1, $2, $3)', [ids.thread, ids.other, ids.owner]);
    const [copy] = await rows(before, 'SELECT project_id, project_source, project_address_id FROM communications.conversations WHERE id = $1', [ids.thread]);
    check('set_conversation_project: a person\'s project replaces the old one, and the copy follows',
      copy.project_id === ids.other && copy.project_source === 'person' && copy.project_address_id === null
      && (await rows(before, 'SELECT 1 FROM communications.conversation_projects WHERE conversation_id = $1', [ids.thread])).length === 1, copy);
    check('set_conversation_project: only if none leaves a filed conversation alone',
      (await rows(before, 'SELECT communications.set_conversation_project($1, $2, $3, true) AS done', [ids.thread, ids.project, ids.owner]))[0].done === false
      && (await rows(before, 'SELECT communications.set_conversation_project($1, $2, $3, true) AS done', [ids.thread2, ids.project, ids.owner]))[0].done === true);
    await before.exec('RESET ROLE');

    // ---- Matches schema.sql loaded on its own ---------------------------
    const fresh = await createFullSchemaDatabase({ schemaSql: readFileSync(SCHEMA_PATH, 'utf8') });
    try {
      const migrated = await describe(before);
      const declared = await describe(fresh);
      const missing = declared.filter((line) => !migrated.includes(line));
      const extra = migrated.filter((line) => !declared.includes(line));
      check('snapshot: the migrated schema matches schema.sql', missing.length === 0 && extra.length === 0, { missing: missing.slice(0, 6), extra: extra.slice(0, 6) });

      // ---- A person: RLS reads, no service functions -----------------------
      await fresh.exec(`
        INSERT INTO public.team_members (id, name, email, role) VALUES ('${id(93)}', 'Owner', 'owner@agency.example', 'owner');
        -- Signing up makes Rae a member (handle_new_user).
        INSERT INTO auth.users (id, email) VALUES ('${id(91)}', 'rae@agency.example');
      `);
      await fresh.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${id(91)}', false), set_config('request.jwt.claim.role', 'authenticated', false);`);
      check('person: reads the moved tables under RLS', (await rows(fresh, 'SELECT count(*)::int AS n FROM communications.task_links'))[0].n === 0);
      let denied = '';
      try { await fresh.query(`SELECT communications.signal('[]'::jsonb)`); } catch (error) { denied = (error as Error).message; }
      check('person: cannot run a service function', /permission denied/.test(denied), denied);
      let write = '';
      try { await fresh.query(`INSERT INTO communications.sender_rules (match_kind, match_value, action, source) VALUES ('domain', 'x.example', 'ignore', 'person')`); } catch (error) { write = (error as Error).message; }
      check('person: writes only where a policy lets them (none on sender rules)', /row-level security/.test(write), write);
      await fresh.exec('RESET ROLE');
    } finally {
      await fresh.close();
    }
  } finally {
    await before.close();
  }

  if (failures.length) {
    console.error(`communications migration: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`communications migration: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
