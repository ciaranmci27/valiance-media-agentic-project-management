/**
 * A PGlite database for the inbound email tests: the tables and access
 * helpers the email migration builds on (the real definitions from
 * schema.sql where they matter, small stand-ins elsewhere), then the real
 * migrations, each applied twice to prove it re-runs, then the 2.0 move into
 * pm. auth.uid() and auth.role() read the same request.jwt settings Supabase
 * uses, so a test can act as the service role (what fake-postgrest does) or
 * as a signed-in person.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { schemaAt, schemaBeforeMigration } from './full-schema-db';

export const EMAIL_MIGRATION = '../supabase/migrations/20261006010922_email_inboxes.sql';
export const PROJECT_ADDRESS_MIGRATION = '../supabase/migrations/20261006030328_email_project_addresses.sql';
export const SPEC_MIGRATION = '../supabase/migrations/20261006113522_spec_is_for_agents.sql';
export const NEEDS_HUMAN_MIGRATION = '../supabase/migrations/20261018161658_email_needs_human.sql';
export const NEEDS_HUMAN_CLEANUP_MIGRATION = '../supabase/migrations/20261018164310_email_needs_human_cleanup.sql';
export const PROJECT_SOURCE_PERSON_MIGRATION = '../supabase/migrations/20261018165051_email_project_source_person.sql';
export const SORTING_MIGRATION = '../supabase/migrations/20261023194940_inbox_sorting_and_relations.sql';
export const ANSWERS_MIGRATION = '../supabase/migrations/20261024044106_email_question_answers.sql';
export const SHARED_FILES_MIGRATION = '../supabase/migrations/20261024185705_email_files_stored_once.sql';
export const ANSWERED_PERSON_MIGRATION = '../supabase/migrations/20261026043050_email_answered_project_is_person.sql';
export const COMMUNICATIONS_MIGRATION = '../supabase/migrations/20261026091944_communications_schema.sql';
export const CONVERSATION_SCOPE_MIGRATION = '../supabase/migrations/20261026093748_conversation_projects_scope.sql';
export const SCOPE_HARDENING_MIGRATION = '../supabase/migrations/20261026191615_communications_scope_hardening.sql';
export const DELIVERY_MIGRATION = '../supabase/migrations/20261026192302_message_delivery.sql';
export const PLANS_MIGRATION = '../supabase/migrations/20261026200925_triage_plans.sql';
export const YOUR_ADDRESSES_MIGRATION = '../supabase/migrations/20261027200420_your_addresses.sql';
export const YOUR_DOMAINS_MIGRATION = '../supabase/migrations/20261027204003_your_domains.sql';
export const OUTREACH_MIGRATION = '../supabase/migrations/20261027221258_outreach_filtered.sql';
export const SORTING_TOPICS_MIGRATION = '../supabase/migrations/20261027224912_sorting_codes_and_updates.sql';
export const TRIAGE_QUESTIONS_MIGRATION = '../supabase/migrations/20261029230751_triage_questions.sql';
export const REPLY_DRAFT_COPIED_MIGRATION = '../supabase/migrations/20261030005540_reply_draft_copied.sql';
export const SUMMARY_OUTCOMES_MIGRATION = '../supabase/migrations/20261104202330_summary_tells_outcomes_only.sql';
export const SUMMARY_NEWS_MIGRATION = '../supabase/migrations/20261104232042_summary_news_is_stricter.sql';
export const RULE_RECIPIENT_MIGRATION = '../supabase/migrations/20261112020822_sender_rules_by_recipient.sql';
export const MEETINGS_MIGRATION = '../supabase/migrations/20261112042424_meetings_channel.sql';
export const MEETING_DISMISSAL_MIGRATION = '../supabase/migrations/20261117161849_meeting_nothing_to_do.sql';
export const PERSONAL_INBOXES_MIGRATION = '../supabase/migrations/20261121060000_personal_inboxes.sql';
const TASK_SAVE_MIGRATION = '../supabase/migrations/20260923235152_atomic_task_save.sql';
/** 2.0: every app object moves from public and communications into pm. */
export const MOVE_TO_PM_MIGRATION = '../supabase/migrations/20261123000000_move_to_pm.sql';

async function read(path: string) {
  return (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}

/** A migration file's SQL, for a test that re-runs one. */
export const readMigration = read;

/**
 * The last 1.x schema.sql (public + communications): the copy just before
 * the 2.0 move was committed, or HEAD while that move is still uncommitted.
 */
function schemaBefore20(): string {
  try {
    return schemaBeforeMigration('20261123000000_move_to_pm.sql');
  } catch {
    return schemaAt('HEAD');
  }
}

/**
 * source 'migration' builds an install the way production grew: the pieces
 * it needs from the last 1.x schema.sql (in public), every email migration
 * (each applied twice, to prove it re-runs), then the 2.0 move into pm (also
 * twice). 'schema' instead loads the inbound email section of the current
 * schema.sql (in pm), to prove the snapshot stands on its own.
 * before20 stops the migration path before the move, so the database stays a
 * 1.x one (public + communications) for a test of an older migration.
 * stopBeforeNeedsHuman leaves out the needs_human rename (both steps) and
 * everything after it, so a test can write rows under the old names and then
 * apply it.
 */
export async function createEmailDatabase(
  source: 'migration' | 'schema' = 'migration',
  { stopBeforeNeedsHuman = false, before20 = false }: { stopBeforeNeedsHuman?: boolean; before20?: boolean } = {},
): Promise<PGlite> {
  const fromMigrations = source === 'migration';
  // Where the copied pieces and stand-ins are built: a 1.x install had them
  // in public; the 2.0 schema has them in pm.
  const s = fromMigrations ? 'public' : 'pm';
  const moved = fromMigrations && !before20 && !stopBeforeNeedsHuman;
  // Where they end up.
  const target = fromMigrations && !moved ? 'public' : 'pm';
  const canonical = fromMigrations ? schemaBefore20().replace(/\r\n/g, '\n') : await read('../supabase/schema.sql');
  const table = (sql: string, name: string) => {
    const found = sql.match(new RegExp('create table ' + s + '\\.' + name + ' \\([\\s\\S]*?^\\);', 'mi'))?.[0];
    assert.ok(found, `table ${name} in schema`);
    return found;
  };
  const fn = (name: string) => {
    const found = canonical.match(new RegExp('CREATE OR REPLACE FUNCTION ' + s + '\\.' + name + '\\([\\s\\S]*?^\\$\\$;', 'm'))?.[0];
    assert.ok(found, `function ${name} in schema.sql`);
    return found;
  };

  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA IF NOT EXISTS ${s};
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'sub'), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'role') $$;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[]);
    CREATE FUNCTION ${s}.handle_updated_at() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

    CREATE TABLE ${s}.team_members (id uuid PRIMARY KEY, auth_user_id uuid, name text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '', role text NOT NULL, status text NOT NULL DEFAULT 'active',
      agent_profile text NOT NULL DEFAULT 'generic');
    CREATE TABLE ${s}.projects (id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active',
      archived_at timestamptz, created_by uuid, deleted_at timestamptz, deleted_by uuid);
    CREATE TABLE ${s}.project_members (project_id uuid NOT NULL REFERENCES ${s}.projects(id) ON DELETE CASCADE,
      member_id uuid NOT NULL REFERENCES ${s}.team_members(id) ON DELETE CASCADE, PRIMARY KEY (project_id, member_id));
    CREATE TABLE ${s}.business_settings (id serial PRIMARY KEY, api_enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE ${s}.api_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT 'key',
      key_hash text NOT NULL, permissions text NOT NULL DEFAULT 'scoped', team_member_id uuid, scopes text[] NOT NULL DEFAULT '{}',
      expires_at timestamptz, disabled_at timestamptz, revoked_at timestamptz, last_used_at timestamptz);
    CREATE TABLE ${s}.api_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), method text, endpoint text, entity_type text,
      entity_id uuid, api_key_id uuid, team_member_id uuid, request_body jsonb, before_snapshot jsonb, after_snapshot jsonb,
      status_code integer, error text, via text NOT NULL DEFAULT 'rest');
    CREATE FUNCTION ${s}.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'reset_at', now() + make_interval(secs => p_window_seconds)) $$;
    CREATE TABLE ${s}.project_goals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, title text NOT NULL DEFAULT 'Goal');
    CREATE TABLE ${s}.task_suggestions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, goal_id uuid,
      proposed_by uuid, assigned_to uuid, title text NOT NULL, description text NOT NULL DEFAULT '', reasoning text NOT NULL DEFAULT '',
      priority text NOT NULL DEFAULT 'medium', effort_estimate text, status text NOT NULL DEFAULT 'pending', reviewed_by uuid,
      reviewed_at timestamptz, rejection_reason text, info_request text, converted_task_id uuid, metadata jsonb NOT NULL DEFAULT '{}',
      task_type text, bundle_key uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  `);
  for (const name of ['contacts', 'project_contacts', 'tasks', 'task_assignees', 'task_acceptance_criteria', 'task_dependencies']) {
    await db.exec(table(canonical, name));
  }
  await db.exec(`
    ALTER TABLE ${s}.tasks ADD COLUMN project_goal_id uuid, ADD COLUMN source_task_suggestion_id uuid, ADD COLUMN task_type text;
    -- Only what the Inbox list reads: open reminders on a thread's tasks.
    CREATE TABLE ${s}.reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL DEFAULT '', remind_on date, project_id uuid,
      task_id uuid REFERENCES ${s}.tasks(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'open', source_message_id uuid,
      owner_id uuid, created_by uuid, completed_at timestamptz, completed_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
  `);
  await db.exec(table(canonical, 'agent_activities').replace('CREATE TABLE', 'create table'));
  const roleTables = canonical.match(new RegExp(`CREATE TABLE ${s}\\.role_permissions \\([\\s\\S]*?\\n\\);\\n\\nCREATE TABLE ${s}\\.team_member_permissions \\([\\s\\S]*?\\n\\);`))?.[0];
  assert.ok(roleTables, 'permission tables in schema.sql');
  await db.exec(roleTables);
  // has_permission() reads which modules are on; every module is on here.
  await db.exec(`
    CREATE TABLE ${s}.workspace_modules (module_id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE ${s}.permission_modules (permission_key text PRIMARY KEY, module_id text NOT NULL REFERENCES ${s}.workspace_modules(module_id));
    INSERT INTO ${s}.workspace_modules (module_id) VALUES ('inbox');
  `);
  for (const name of ['current_team_member_id', 'module_enabled', 'has_permission', 'can_access_project', 'project_is_live']) {
    await db.exec(fn(name));
  }

  if (fromMigrations) {
    await db.exec(await read(TASK_SAVE_MIGRATION));
    const migration = await read(EMAIL_MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // safe to re-run
    const addresses = await read(PROJECT_ADDRESS_MIGRATION);
    await db.exec(addresses);
    await db.exec(addresses); // safe to re-run
    const spec = await read(SPEC_MIGRATION);
    await db.exec(spec);
    await db.exec(spec); // safe to re-run
    if (!stopBeforeNeedsHuman) {
      for (const path of [NEEDS_HUMAN_MIGRATION, NEEDS_HUMAN_CLEANUP_MIGRATION, PROJECT_SOURCE_PERSON_MIGRATION, SORTING_MIGRATION, ANSWERS_MIGRATION, SHARED_FILES_MIGRATION, ANSWERED_PERSON_MIGRATION, COMMUNICATIONS_MIGRATION, CONVERSATION_SCOPE_MIGRATION, SCOPE_HARDENING_MIGRATION, DELIVERY_MIGRATION, PLANS_MIGRATION, YOUR_ADDRESSES_MIGRATION, YOUR_DOMAINS_MIGRATION, OUTREACH_MIGRATION, SORTING_TOPICS_MIGRATION, TRIAGE_QUESTIONS_MIGRATION, REPLY_DRAFT_COPIED_MIGRATION, SUMMARY_OUTCOMES_MIGRATION, SUMMARY_NEWS_MIGRATION, RULE_RECIPIENT_MIGRATION, MEETINGS_MIGRATION, MEETING_DISMISSAL_MIGRATION, PERSONAL_INBOXES_MIGRATION]) {
        const sql = await read(path);
        await db.exec(sql);
        await db.exec(sql); // safe to re-run
      }
    }
  } else {
    await db.exec(fn('save_task'));
    const hostname = canonical.match(/create or replace function pm\.email_is_hostname\([\s\S]*?^\$\$;/m)?.[0];
    const settingsColumn = canonical.match(/^  inbound_email_domain text[\s\S]*?\),\n/m)?.[0];
    const start = canonical.indexOf('-- Inbound client email (20261006010922_email_inboxes.sql)');
    // The section runs up to the retainer drafts schedule that follows it.
    const end = canonical.indexOf('-- Retainer drafts schedule (20260919050750_create_project_retainers.sql)', start);
    assert.ok(hostname && settingsColumn && start > 0 && end > start, 'inbound email section in schema.sql');
    await db.exec(hostname);
    await db.exec(`ALTER TABLE pm.business_settings ADD COLUMN ${settingsColumn.trim().replace(/,$/, '')};`);
    // Personal inboxes read this switch (can_read_inbox).
    await db.exec('ALTER TABLE pm.business_settings ADD COLUMN owners_read_personal_inboxes boolean NOT NULL DEFAULT false;');
    await db.exec(canonical.slice(start, end));
  }
  // Retention asks which task files link an attachment (keepLinkedTaskFiles;
  // verify-task-files-api.ts covers that on the full schema). A stand-in with
  // the columns it reads and the same hold on the attachment.
  const attachments = !fromMigrations ? 'pm.attachments' : stopBeforeNeedsHuman ? 'public.email_attachments' : 'communications.attachments';
  await db.exec(`
    CREATE TABLE ${s}.task_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id uuid NOT NULL REFERENCES ${s}.tasks(id),
      kind text NOT NULL,
      storage_path text,
      sha256 text,
      email_attachment_id uuid REFERENCES ${attachments}(id) ON DELETE RESTRICT,
      deleted_at timestamptz
    );
  `);
  // Outreach guardrails ask whether the sender is a live lead (speaker.ts).
  await db.exec(`
    CREATE TABLE ${s}.leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT '', email text,
      deleted_at timestamptz, archived_at timestamptz);
  `);
  // Triage plans notify the people who can act (syncWaitingNotification).
  await db.exec(`
    CREATE TABLE ${s}.team_member_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL,
      message text, link text, is_read boolean NOT NULL DEFAULT false, entity_type text, entity_id text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION ${s}.upsert_notification(p_user_id uuid, p_title text, p_message text, p_link text, p_entity_type text, p_entity_id text)
      RETURNS void LANGUAGE sql AS $$
      INSERT INTO ${s}.team_member_notifications (user_id, title, message, link, entity_type, entity_id)
      VALUES (p_user_id, p_title, p_message, p_link, p_entity_type, p_entity_id) $$;
  `);
  if (moved) {
    // The 2.0 upgrade, as an existing install takes it. The stand-ins get
    // their grants below, after the move, so its bridge views in the old
    // places grant nothing: anything still reading public or communications
    // fails loudly instead of passing through them.
    const move = await read(MOVE_TO_PM_MIGRATION);
    await db.exec(move);
    await db.exec(move); // safe to re-run
  }
  await db.exec(`
    GRANT USAGE ON SCHEMA ${target}, auth, storage TO service_role, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA ${target} TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${target} TO authenticated;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA ${target} TO service_role, authenticated;
    INSERT INTO ${target}.business_settings DEFAULT VALUES;
  `);
  // Unqualified names in a test mean the app's tables, as schema.sql's own
  // SET search_path does for the full-schema harness.
  if (target === 'pm') await db.exec('SET search_path = pm, public;');
  return db;
}

/** Runs work as a signed-in person (authenticated role, their auth uid), then resets. */
export async function asPerson<T>(db: PGlite, authUserId: string, work: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN; SET LOCAL ROLE authenticated;');
  await db.query("SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
    JSON.stringify({ role: 'authenticated', sub: authUserId }),
    authUserId,
  ]);
  try {
    const result = await work();
    await db.exec('COMMIT;');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK;');
    throw error;
  }
}

/** Runs work as the service role with no user, the way an API key's requests reach the database. */
export async function asService<T>(db: PGlite, work: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN; SET LOCAL ROLE service_role;');
  await db.query("SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true)", [
    JSON.stringify({ role: 'service_role' }),
  ]);
  try {
    const result = await work();
    await db.exec('COMMIT;');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK;');
    throw error;
  }
}
