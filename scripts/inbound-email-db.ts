/**
 * A PGlite database for the inbound email tests: the tables and access
 * helpers the email migration builds on (the real definitions from
 * schema.sql where they matter, small stand-ins elsewhere), then the real
 * migrations, each applied twice to prove it re-runs. auth.uid() and auth.role()
 * read the same request.jwt settings Supabase uses, so a test can act as the
 * service role (what fake-postgrest does) or as a signed-in person.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export const EMAIL_MIGRATION = '../supabase/migrations/20261006010922_email_inboxes.sql';
export const PROJECT_ADDRESS_MIGRATION = '../supabase/migrations/20261006030328_email_project_addresses.sql';
const TASK_SAVE_MIGRATION = '../supabase/migrations/20260923235152_atomic_task_save.sql';

async function read(path: string) {
  return (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}

/**
 * source 'migration' applies the migration (twice); 'schema' instead loads
 * the inbound email section of schema.sql, to prove the snapshot stands on
 * its own.
 */
export async function createEmailDatabase(source: 'migration' | 'schema' = 'migration'): Promise<PGlite> {
  const canonical = await read('../supabase/schema.sql');
  const agentSchema = await read('../supabase/schema_ai_agent.sql');
  const table = (sql: string, name: string) => {
    const found = sql.match(new RegExp('create table public\\.' + name + ' \\([\\s\\S]*?^\\);', 'mi'))?.[0];
    assert.ok(found, `table ${name} in schema`);
    return found;
  };
  const fn = (name: string) => {
    const found = canonical.match(new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\([\\s\\S]*?^\\$\\$;', 'm'))?.[0];
    assert.ok(found, `function ${name} in schema.sql`);
    return found;
  };

  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
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
    CREATE FUNCTION public.handle_updated_at() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

    CREATE TABLE public.team_members (id uuid PRIMARY KEY, auth_user_id uuid, name text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '', role text NOT NULL, status text NOT NULL DEFAULT 'active',
      agent_profile text NOT NULL DEFAULT 'generic');
    CREATE TABLE public.projects (id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active',
      archived_at timestamptz, created_by uuid);
    CREATE TABLE public.project_members (project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
      member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE, PRIMARY KEY (project_id, member_id));
    CREATE TABLE public.business_settings (id serial PRIMARY KEY, api_enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE public.api_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT 'key',
      key_hash text NOT NULL, permissions text NOT NULL DEFAULT 'scoped', team_member_id uuid, scopes text[] NOT NULL DEFAULT '{}',
      expires_at timestamptz, disabled_at timestamptz, revoked_at timestamptz, last_used_at timestamptz);
    CREATE TABLE public.api_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), method text, endpoint text, entity_type text,
      entity_id uuid, api_key_id uuid, team_member_id uuid, request_body jsonb, before_snapshot jsonb, after_snapshot jsonb,
      status_code integer, error text, via text NOT NULL DEFAULT 'rest');
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'reset_at', now() + make_interval(secs => p_window_seconds)) $$;
    CREATE TABLE public.project_goals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, title text NOT NULL DEFAULT 'Goal');
    CREATE TABLE public.task_suggestions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, goal_id uuid,
      proposed_by uuid, assigned_to uuid, title text NOT NULL, description text NOT NULL DEFAULT '', reasoning text NOT NULL DEFAULT '',
      priority text NOT NULL DEFAULT 'medium', effort_estimate text, status text NOT NULL DEFAULT 'pending', reviewed_by uuid,
      reviewed_at timestamptz, rejection_reason text, info_request text, converted_task_id uuid, metadata jsonb NOT NULL DEFAULT '{}',
      task_type text, bundle_key uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  `);
  for (const name of ['contacts', 'project_contacts', 'tasks', 'task_assignees', 'task_acceptance_criteria', 'task_dependencies']) {
    await db.exec(table(canonical, name));
  }
  await db.exec(`
    ALTER TABLE public.tasks ADD COLUMN project_goal_id uuid, ADD COLUMN source_task_suggestion_id uuid, ADD COLUMN task_type text;
  `);
  await db.exec(table(agentSchema, 'agent_activities').replace('CREATE TABLE', 'create table'));
  const roleTables = canonical.match(/CREATE TABLE public\.role_permissions \([\s\S]*?\n\);\n\nCREATE TABLE public\.team_member_permissions \([\s\S]*?\n\);/)?.[0];
  assert.ok(roleTables, 'permission tables in schema.sql');
  await db.exec(roleTables);
  for (const name of ['current_team_member_id', 'has_permission', 'can_access_project']) {
    await db.exec(fn(name));
  }

  await db.exec(await read(TASK_SAVE_MIGRATION));
  if (source === 'migration') {
    const migration = await read(EMAIL_MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // safe to re-run
    const addresses = await read(PROJECT_ADDRESS_MIGRATION);
    await db.exec(addresses);
    await db.exec(addresses); // safe to re-run
  } else {
    const hostname = canonical.match(/create or replace function public\.email_is_hostname\([\s\S]*?^\$\$;/m)?.[0];
    const settingsColumn = canonical.match(/^  inbound_email_domain text[\s\S]*?\),\n/m)?.[0];
    const start = canonical.indexOf('-- Inbound client email (20261006010922_email_inboxes.sql)');
    const end = canonical.indexOf('-- Realtime publication (20260730134850_realtime_publication.sql)');
    assert.ok(hostname && settingsColumn && start > 0 && end > start, 'inbound email section in schema.sql');
    await db.exec(hostname);
    await db.exec(`ALTER TABLE public.business_settings ADD COLUMN ${settingsColumn.trim().replace(/,$/, '')};`);
    await db.exec(canonical.slice(start, end));
  }
  await db.exec(`
    GRANT USAGE ON SCHEMA public, auth, storage TO service_role, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role, authenticated;
    INSERT INTO public.business_settings DEFAULT VALUES;
  `);
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
