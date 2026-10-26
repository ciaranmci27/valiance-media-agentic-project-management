/**
 * The whole app schema (supabase/schema.sql) on PGlite: real tables, real
 * policies, real functions and triggers, with small stand-ins only for what
 * Supabase provides around it (auth, storage, vault, pg_cron, pg_net).
 * Nothing touches a live database.
 *
 * `createFullSchemaDatabase()` loads the canonical schema. Pass `schemaSql`
 * to load another copy (for example the schema before a migration, from git),
 * then apply the migration on top and compare.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

export const SCHEMA_PATH = join(__dirname, '..', 'supabase', 'schema.sql');
/** Applied after schema.sql, as its header says. */
export const AGENT_SCHEMA_PATH = join(__dirname, '..', 'supabase', 'schema_ai_agent.sql');

/** What Supabase provides that schema.sql leans on, reduced to the shape it uses. */
const SUPABASE_STANDINS = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  -- Supabase's default grants on public, which schema.sql then narrows with REVOKEs.
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now());
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user::text) $$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
    AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint,
    allowed_mime_types text[]);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text,
    owner uuid, metadata jsonb);
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE
    AS $$ SELECT string_to_array(name, '/') $$;
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE SCHEMA vault;
  CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
  CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
  CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql
    AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_schedule, p_command)
          ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule, command = excluded.command
          RETURNING jobid $$;
  CREATE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql
    AS $$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true $$;
  CREATE SCHEMA net;
  CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
    headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql
    AS $$ SELECT 1::bigint $$;
`;

/** Extensions PGlite does not ship are provided by the stand-ins above. */
function withoutHostedExtensions(sql: string): string {
  return sql.replace(/CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net)( WITH SCHEMA \w+)?;/gi, '-- (stand-in) extension $1');
}

const NEWLINE = '\n';

/** DO blocks in schema.sql that check production data, which a fresh database does not have. */
const DATA_ASSERTIONS = ['At least one active Owner is required'];

/**
 * Top-level statements of a SQL file, split on semicolons outside quotes,
 * dollar-quoted bodies and comments.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  const stripComments = (text: string) => text.replace(/--[^\n]*/g, '').trim();
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf(NEWLINE, i);
      i = end < 0 ? sql.length : end + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (ch === "'") {
      // A quoted literal; '' inside it is an escaped quote.
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
    } else if (ch === '$') {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
      } else i++;
    } else if (ch === ';') {
      const statement = sql.slice(start, i + 1).trim();
      if (stripComments(statement) !== ';') out.push(statement);
      start = i + 1;
      i++;
    } else i++;
  }
  if (stripComments(sql.slice(start))) out.push(sql.slice(start).trim());
  return out;
}

/**
 * schema.sql is replayed statement by statement. It keeps a few historical
 * GRANT/REVOKE lines for function signatures a later section replaced; on a
 * fresh database those name nothing, so permission statements may fail and
 * are reported. Anything else failing is a real error.
 */
export async function applySchema(db: PGlite, sql: string): Promise<{ skipped: string[] }> {
  const skipped: string[] = [];
  // Working copies may carry CRLF (git autocrlf); function bodies must compare equal either way.
  for (const statement of splitSqlStatements(withoutHostedExtensions(sql.replace(/\r\n/g, NEWLINE)))) {
    const body = statement.replace(/^(\s*--[^\n]*\n)+/, '').trimStart();
    // Sections wrapped in BEGIN/COMMIT run statement by statement here, so a
    // tolerated failure cannot abort the rest of the block.
    if (/^(BEGIN|COMMIT|START TRANSACTION)\s*;$/i.test(body)) continue;
    try {
      await db.exec(statement);
    } catch (error) {
      const message = (error as Error).message;
      const dataAssertion = /^DO\s/i.test(body) && DATA_ASSERTIONS.some((text) => message.includes(text));
      // Supabase Realtime is hosted infrastructure; its publication is not part of what tests read.
      const realtime = body.includes('supabase_realtime');
      if (/^(GRANT|REVOKE)\s/i.test(body) || dataAssertion || realtime) {
        skipped.push(`${body.split(NEWLINE)[0]} (${message})`);
        continue;
      }
      throw new Error(`${(error as Error).message}${NEWLINE}--- in statement:${NEWLINE}${body.slice(0, 600)}`);
    }
  }
  return { skipped };
}

export async function createFullSchemaDatabase(options: { schemaSql?: string; agentSchemaSql?: string } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STANDINS);
  await applySchema(db, options.schemaSql ?? readFileSync(SCHEMA_PATH, 'utf8'));
  await applySchema(db, options.agentSchemaSql ?? readFileSync(AGENT_SCHEMA_PATH, 'utf8'));
  // schema_ai_agent.sql predates the owner role and re-adds the role check
  // without it; production carries schema.sql's later check, which has it.
  await db.exec(`ALTER TABLE public.team_members DROP CONSTRAINT IF EXISTS team_members_role_check,
    ADD CONSTRAINT team_members_role_check CHECK (role IN ('owner', 'admin', 'member', 'guest', 'agent'))`);
  return db;
}

/** schema.sql as it was just before a migration was committed (its parent commit's copy). */
export function schemaBeforeMigration(migration: string): string {
  const git = (args: string[]) => execFileSync('git', args, { cwd: join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const added = git(['log', '--diff-filter=A', '--format=%H', '--', `supabase/migrations/${migration}`]).trim().split('\n').pop();
  if (!added) throw new Error(`${migration} is not committed`);
  return git(['show', `${added}^:app/supabase/schema.sql`]);
}

/**
 * Every migration from `first` on, in order, each applied twice in a row (they
 * re-run safely): a database from schemaBeforeMigration(first) then reaches
 * today's schema, comparable with schema.sql.
 */
export async function applyMigrationsFrom(db: PGlite, first: string): Promise<void> {
  const dir = join(__dirname, '..', 'supabase', 'migrations');
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql') && file >= first).sort()) {
    const sql = readFileSync(join(dir, name), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
  }
}

/** Run as a signed-in member (RLS applies), or as the service role with `null`. */
export async function actAs(db: PGlite, authUserId: string | null): Promise<void> {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [authUserId ?? '']);
  // What auth.role() reads, as PostgREST sets it from the JWT.
  await db.query("SELECT set_config('request.jwt.claim.role', $1, false)", [authUserId ? 'authenticated' : 'service_role']);
  await db.exec(authUserId ? 'SET ROLE authenticated' : 'SET ROLE service_role');
}
