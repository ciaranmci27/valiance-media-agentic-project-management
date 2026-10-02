// Exercises the server-only API key migration against a real Postgres
// (PGlite) with RLS on. Before it, a key's member could clear an admin's
// revoke and a manage_all holder could point a key at the Owner. After it,
// members only read keys, and the guard holds for service_role too: a revoke
// is final, the secret never changes, a key never moves to another member,
// and deleting a member still nulls its keys.
// Run: node --experimental-strip-types scripts/verify-api-key-guard.ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = '../supabase/migrations/20261002083507_api_keys_server_only.sql';

async function main() {
  const db = new PGlite();
  let checks = 0;
  const check = (actual: unknown, expected: unknown, label: string) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  const refused = async (sql: string, params: unknown[] = []) => {
    try {
      const result = await db.query(sql, params);
      return (result.affectedRows ?? 0) === 0 ? 'no rows' : 'allowed';
    } catch (error) {
      return (error as Error).message;
    }
  };

  const owner = randomUUID();
  const member = randomUUID();
  const manager = randomUUID();

  // The access helpers as the app defines them, reduced to what the policies
  // read, and api_keys as schema.sql leaves it before this migration.
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.acting (member_id uuid);
    CREATE TABLE public.team_members (id uuid PRIMARY KEY, role text NOT NULL);
    CREATE TABLE public.grants (member_id uuid, permission_key text);
    CREATE FUNCTION public.current_team_member_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT member_id FROM public.acting LIMIT 1 $$;
    CREATE FUNCTION public.has_permission(p_key text, p_channel text DEFAULT 'app') RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.grants WHERE member_id = public.current_team_member_id() AND permission_key = p_key) $$;

    CREATE TABLE public.api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      key_prefix text NOT NULL,
      key_hash text NOT NULL,
      created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
      permissions text NOT NULL DEFAULT 'scoped',
      last_used_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
      scopes text[] NOT NULL DEFAULT '{}',
      expires_at timestamptz,
      disabled_at timestamptz
    );
    ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
    CREATE POLICY api_keys_select ON public.api_keys FOR SELECT TO authenticated
      USING (team_member_id = public.current_team_member_id()
        OR created_by = public.current_team_member_id()
        OR public.has_permission('api_keys.manage_all'));
    CREATE POLICY api_keys_insert_own ON public.api_keys FOR INSERT TO authenticated
      WITH CHECK (team_member_id = public.current_team_member_id()
        AND created_by = public.current_team_member_id());
    CREATE POLICY api_keys_update_own ON public.api_keys FOR UPDATE TO authenticated
      USING (team_member_id = public.current_team_member_id()
        OR public.has_permission('api_keys.manage_all'));
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON public.api_keys TO anon, authenticated, service_role;
    GRANT ALL ON public.team_members TO service_role;
    GRANT SELECT ON public.acting, public.grants TO authenticated;
  `);
  await db.query("INSERT INTO team_members VALUES ($1, 'owner'), ($2, 'member'), ($3, 'admin')", [owner, member, manager]);
  await db.query("INSERT INTO grants VALUES ($1, 'api_keys.manage_all')", [manager]);

  const memberKey = randomUUID();
  const managerKey = randomUUID();
  await db.query(
    `INSERT INTO api_keys (id, name, key_prefix, key_hash, created_by, team_member_id, scopes) VALUES
      ($1, 'Member key', 'pk_live_aaaaaaa', 'hash-member', $3, $3, '{tasks.read}'),
      ($2, 'Manager key', 'pk_live_bbbbbbb', 'hash-manager', $4, $4, '{tasks.read}')`,
    [memberKey, managerKey, member, manager],
  );

  const actAs = async (memberId: string) => {
    await db.exec('RESET ROLE; DELETE FROM public.acting;');
    await db.query('INSERT INTO public.acting VALUES ($1)', [memberId]);
    await db.exec('SET ROLE authenticated;');
  };
  const asService = async () => {
    await db.exec('RESET ROLE; DELETE FROM public.acting; SET ROLE service_role;');
  };
  const revokedAt = async (id: string) => {
    await db.exec('RESET ROLE;');
    return (await db.query<{ revoked_at: string | null }>('SELECT revoked_at FROM api_keys WHERE id = $1', [id])).rows[0].revoked_at;
  };

  // The hole, before the migration: an admin revokes the member's key and the
  // member clears it; the manager points their own key at the Owner.
  await asService();
  await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [memberKey]);
  await actAs(member);
  check(await refused('UPDATE api_keys SET revoked_at = NULL WHERE id = $1', [memberKey]), 'allowed', 'before: member un-revokes their key');
  check(await revokedAt(memberKey), null, 'before: the revoke is gone');
  await actAs(manager);
  check(await refused('UPDATE api_keys SET team_member_id = $1 WHERE id = $2', [owner, managerKey]), 'allowed', 'before: manage_all repoints a key at the Owner');
  await asService();
  await db.query('UPDATE api_keys SET team_member_id = $1 WHERE id = $2', [manager, managerKey]);

  await db.exec('RESET ROLE;');
  const migration = await readFile(new URL(MIGRATION, import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration); // safe to re-run

  // Members read what they could read before, and write nothing.
  await actAs(member);
  check((await db.query('SELECT id FROM api_keys')).rows.length, 1, 'member reads their own key only');
  check(
    /permission denied/.test(await refused("INSERT INTO api_keys (name, key_prefix, key_hash, created_by, team_member_id) VALUES ('x', 'p', 'h', $1, $1)", [member])),
    true,
    'member cannot insert a key',
  );
  check(/permission denied/.test(await refused("UPDATE api_keys SET scopes = '{*}' WHERE id = $1", [memberKey])), true, 'member cannot update a key');
  check(/permission denied/.test(await refused('DELETE FROM api_keys WHERE id = $1', [memberKey])), true, 'member cannot delete a key');
  await actAs(manager);
  check((await db.query('SELECT id FROM api_keys')).rows.length, 2, 'manage_all reads every key');
  check(/permission denied/.test(await refused('UPDATE api_keys SET team_member_id = $1 WHERE id = $2', [owner, managerKey])), true, 'manage_all cannot repoint a key');

  // The server (service_role) revokes; nobody un-revokes, re-dates, rewrites
  // the secret or moves a key.
  await asService();
  check(await refused('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [memberKey]), 'allowed', 'service role revokes');
  check(/revoke cannot be changed/.test(await refused('UPDATE api_keys SET revoked_at = NULL WHERE id = $1', [memberKey])), true, 'service role cannot un-revoke');
  check(/revoke cannot be changed/.test(await refused("UPDATE api_keys SET revoked_at = now() - interval '1 day' WHERE id = $1", [memberKey])), true, 'service role cannot re-date a revoke');
  check(/secret and creation time/.test(await refused("UPDATE api_keys SET key_hash = 'other' WHERE id = $1", [managerKey])), true, 'service role cannot change the hash');
  check(/another member/.test(await refused('UPDATE api_keys SET team_member_id = $1 WHERE id = $2', [owner, managerKey])), true, 'service role cannot repoint a key');
  check(/another member/.test(await refused('UPDATE api_keys SET created_by = $1 WHERE id = $2', [owner, managerKey])), true, 'service role cannot change the creator');
  check(await refused("UPDATE api_keys SET scopes = '{tasks.read,tasks.create}', disabled_at = now(), last_used_at = now() WHERE id = $1", [managerKey]), 'allowed', 'service role still edits scopes, disable and last use');
  check(await refused('UPDATE api_keys SET disabled_at = NULL WHERE id = $1', [managerKey]), 'allowed', 'a disable stays reversible');
  check(await refused('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [memberKey]), 'allowed', 'a revoked key still records last use');

  // Deleting a member nulls their keys through the foreign keys.
  await db.exec('RESET ROLE;');
  await db.query('DELETE FROM team_members WHERE id = $1', [member]);
  const orphan = (await db.query<{ team_member_id: string | null; created_by: string | null }>('SELECT team_member_id, created_by FROM api_keys WHERE id = $1', [memberKey])).rows[0];
  check(orphan, { team_member_id: null, created_by: null }, 'deleting a member nulls the key without tripping the guard');
  check((await revokedAt(memberKey)) !== null, true, 'the orphaned key stays revoked');

  console.log(`api key guard: ${checks} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
