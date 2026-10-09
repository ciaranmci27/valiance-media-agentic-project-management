/**
 * Editing an API key's name and scopes in place (PATCH and GET
 * /api/workspace/api-keys/[id], lib/api/key-edit.ts), end to end against a
 * pglite database behind the PostgREST stand-in, with the real api_keys guard
 * migration applied. Editors' and members' access are resolved by the real
 * resolveMemberAccess; the "takes effect" checks run real withApi requests.
 *
 * Covers: a member widens, narrows and renames their own key; a scope the
 * member lacks is refused; a manage_all holder edits an agent's key against
 * the AGENT's permissions, not their own; someone else's key is hidden; a
 * creator who is not the key's member cannot edit; revoked, expired and
 * suspended-member keys are refused; the secret never changes; and the next
 * request with the same key sees the new scopes.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-api-key-edit.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 500)}`);
}

const GUARD_MIGRATION = new URL('../supabase/migrations/20261002083507_api_keys_server_only.sql', import.meta.url);
const OWNER = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const GONE = randomUUID();
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

async function seed(db: PGlite) {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO service_role;
    CREATE TABLE public.team_members (id uuid PRIMARY KEY, name text NOT NULL, role text NOT NULL, status text NOT NULL DEFAULT 'active');
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
    CREATE TABLE public.business_settings (id serial PRIMARY KEY, api_enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE public.role_permissions (role text, permission_key text, access_channel text);
    CREATE TABLE public.team_member_permissions (member_id uuid, permission_key text, access_channel text, effect text);
    CREATE TABLE public.project_members (member_id uuid, project_id uuid);
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'reset_at', now() + make_interval(secs => p_window_seconds)) $$;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    INSERT INTO public.business_settings DEFAULT VALUES;
  `);
  // The real guard: a revoke is final, the secret never changes, a key never moves.
  await db.exec(await readFile(GUARD_MIGRATION, 'utf8'));
  await db.query(
    `INSERT INTO team_members(id, name, role) VALUES
      ($1, 'Owner', 'owner'), ($2, 'Ada', 'admin'), ($3, 'Mia', 'member'), ($4, 'Otto', 'member'), ($5, 'Jeff', 'agent'), ($6, 'Gus', 'member')`,
    [OWNER, ADMIN, MEMBER, OTHER, AGENT, GONE],
  );
  const grants: [string, string, string][] = [
    ['admin', 'api_keys.manage_all', 'app'],
    ['admin', 'tasks.read', 'api'], ['admin', 'tasks.create', 'api'], ['admin', 'projects.read', 'api'], ['admin', 'team.read', 'api'],
    ['member', 'tasks.read', 'api'], ['member', 'projects.read', 'api'],
    ['agent', 'tasks.read', 'api'], ['agent', 'team.read', 'api'], ['agent', 'notifications.send', 'api'],
  ];
  for (const [role, key, channel] of grants)
    await db.query('INSERT INTO role_permissions VALUES ($1, $2, $3)', [role, key, channel]);
  // A per-member deny wins over the role grant, for the editor and the key's member alike.
  await db.query("INSERT INTO team_member_permissions VALUES ($1, 'projects.read', 'api', 'deny')", [OTHER]);
}

async function insertKey(db: PGlite, fields: { member: string | null; createdBy: string | null; scopes: string[]; name?: string; revoked?: boolean; expired?: boolean }) {
  const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO api_keys(name, key_prefix, key_hash, created_by, team_member_id, scopes, revoked_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END, CASE WHEN $8 THEN now() - interval '1 hour' END) RETURNING id`,
    [fields.name ?? 'Key', secret.slice(0, 15), hash(secret), fields.createdBy, fields.member, fields.scopes, !!fields.revoked, !!fields.expired],
  );
  return { id: rows[0].id, secret };
}

async function main() {
  const db = new PGlite();
  await seed(db);
  const server = await startFakePostgrest(db);
  process.env.NEXT_PUBLIC_SUPABASE_URL = server.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';

  try {
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { editApiKey, apiKeyEditOptions } = await import('../src/lib/api/key-edit');
    const { withApi } = await import('../src/lib/api/middleware');
    const { API_KEY_COLUMNS } = await import('../src/lib/supabase/queries');
    const service = getServiceClient();
    const editor = async (memberId: string) => {
      const access = await resolveMemberAccess(service, memberId);
      if (!access) throw new Error(`no access for ${memberId}`);
      return { memberId, access };
    };
    const row = async (id: string) =>
      (await db.query<{ name: string; scopes: string[]; key_hash: string; key_prefix: string }>(
        'SELECT name, scopes, key_hash, key_prefix FROM api_keys WHERE id = $1', [id])).rows[0];
    const errorOf = (result: { body: unknown }) => (result.body as { error?: string }).error ?? '';

    // A team.read endpoint, through the real withApi door.
    const teamRead = withApi(async () => Response.json({ ok: true }), { permission: 'team.read' });
    const callTeam = (secret: string) =>
      teamRead(new NextRequest('http://localhost/api/v1/team', { headers: { 'x-api-key': secret } }));

    const mia = await editor(MEMBER);
    const own = await insertKey(db, { member: MEMBER, createdBy: MEMBER, scopes: ['tasks.read'], name: 'Zapier' });
    const before = await row(own.id);

    // The member's own key: widen, narrow, rename.
    let result = await editApiKey(service, mia, own.id, { scopes: ['tasks.read', 'projects.read', 'tasks.read'] });
    check('own key: widen to a held scope', result.status === 200, result);
    check('own key: scopes deduped and stored', JSON.stringify((await row(own.id)).scopes) === JSON.stringify(['tasks.read', 'projects.read']), await row(own.id));
    result = await editApiKey(service, mia, own.id, { scopes: ['projects.read'] });
    check('own key: narrow', result.status === 200 && JSON.stringify((await row(own.id)).scopes) === '["projects.read"]', result);
    result = await editApiKey(service, mia, own.id, { name: '  Zapier prod  ' });
    check('own key: rename trims and keeps the scopes', result.status === 200 && (await row(own.id)).name === 'Zapier prod' && (await row(own.id)).scopes.join() === 'projects.read', await row(own.id));
    result = await editApiKey(service, mia, own.id, { name: 'Both', scopes: ['tasks.read'] });
    check('own key: name and scopes in one request', result.status === 200 && (await row(own.id)).name === 'Both' && (await row(own.id)).scopes.join() === 'tasks.read', await row(own.id));
    const body = result.status === 200 ? (result.body.data as unknown as Record<string, unknown>) : {};
    check('response: the updated key', body.name === 'Both' && body.key_prefix === before.key_prefix, body);
    // The stand-in returns every column on writes; real PostgREST applies the select, which never names the hash.
    check('response: the columns read back never include the hash', !API_KEY_COLUMNS.split(',').map((c) => c.trim()).includes('key_hash'));
    const after = await row(own.id);
    check('secret: hash and prefix unchanged', after.key_hash === before.key_hash && after.key_prefix === before.key_prefix);

    // Scopes the member does not hold.
    result = await editApiKey(service, mia, own.id, { scopes: ['tasks.read', 'tasks.create'] });
    check('own key: a scope the member lacks is refused', result.status === 422 && /not available to you: tasks\.create/.test(errorOf(result)), result);
    result = await editApiKey(service, mia, own.id, { scopes: ['not.a.scope'] });
    check('own key: an unknown scope is refused', result.status === 422, result);
    check('own key: a refused edit changes nothing', (await row(own.id)).scopes.join() === 'tasks.read');

    // Body rules, same limits as create.
    for (const [label, input] of [
      ['empty body', {}], ['no body', null], ['no scopes', { scopes: [] }], ['blank name', { name: '   ' }], ['long name', { name: 'x'.repeat(101) }],
    ] as const) {
      result = await editApiKey(service, mia, own.id, input);
      check(`body: ${label} is 422`, result.status === 422, result);
    }

    // Someone else's key, and a creator who is not the key's member.
    const otto = await editor(OTHER);
    result = await editApiKey(service, otto, own.id, { scopes: ['tasks.read'] });
    check("another member's key is hidden (404)", result.status === 404, result);
    check("another member's key: options hidden too", (await apiKeyEditOptions(service, otto, own.id)).status === 404);
    const createdForMia = await insertKey(db, { member: MEMBER, createdBy: OTHER, scopes: ['tasks.read'] });
    result = await editApiKey(service, otto, createdForMia.id, { name: 'Mine now' });
    check("creator who is not the key's member cannot edit (403)", result.status === 403, result);
    check('not-a-uuid id is 404', (await editApiKey(service, mia, 'nope', { name: 'x' })).status === 404);

    // manage_all edits an agent's key, checked against the AGENT's permissions.
    const ada = await editor(ADMIN);
    const agentKey = await insertKey(db, { member: AGENT, createdBy: AGENT, scopes: ['tasks.read'], name: 'Hermes' });
    const options = await apiKeyEditOptions(service, ada, agentKey.id);
    const offered = options.status === 200 ? options.body.data.available_scopes : [];
    check("options: the key member's scopes, not the editor's", JSON.stringify(offered) === JSON.stringify(['team.read', 'notifications.send', 'tasks.read']) && !offered.includes('tasks.create'), offered);
    result = await editApiKey(service, ada, agentKey.id, { scopes: ['tasks.read', 'tasks.create'] });
    check("manage_all: a scope the editor holds but the key's member does not is refused", result.status === 422 && /not held by the key's member: tasks\.create/.test(errorOf(result)), result);
    result = await editApiKey(service, mia, agentKey.id, { scopes: ['tasks.read'] });
    check('without manage_all an agent key is hidden', result.status === 404, result);

    // The change applies from the key's next request.
    check('takes effect: before the edit the agent key cannot read the team', (await callTeam(agentKey.secret)).status === 403);
    result = await editApiKey(service, ada, agentKey.id, { scopes: ['tasks.read', 'team.read', 'notifications.send'] });
    check('manage_all: widens the agent key within what the agent holds', result.status === 200, result);
    check('takes effect: the same secret now reads the team', (await callTeam(agentKey.secret)).status === 200);
    result = await editApiKey(service, ada, agentKey.id, { scopes: ['tasks.read'] });
    check('takes effect: narrowing closes it again on the next request', result.status === 200 && (await callTeam(agentKey.secret)).status === 403, result);

    // A per-member deny on the key's member is honored.
    const ottoKey = await insertKey(db, { member: OTHER, createdBy: OTHER, scopes: ['tasks.read'] });
    result = await editApiKey(service, ada, ottoKey.id, { scopes: ['projects.read'] });
    check("manage_all: the member's own deny override is honored", result.status === 422, result);

    // Keys that cannot be edited.
    const revoked = await insertKey(db, { member: MEMBER, createdBy: MEMBER, scopes: ['tasks.read'], revoked: true });
    result = await editApiKey(service, mia, revoked.id, { scopes: ['projects.read'] });
    check('revoked key is refused (409)', result.status === 409 && /revoked/.test(errorOf(result)), result);
    check('revoked key: scopes untouched', (await row(revoked.id)).scopes.join() === 'tasks.read');
    check('revoked key: no edit options', (await apiKeyEditOptions(service, mia, revoked.id)).status === 409);
    const expired = await insertKey(db, { member: MEMBER, createdBy: MEMBER, scopes: ['tasks.read'], expired: true });
    result = await editApiKey(service, mia, expired.id, { name: 'Later' });
    check('expired key is refused (409)', result.status === 409 && /expired/.test(errorOf(result)), result);
    const gusKey = await insertKey(db, { member: GONE, createdBy: GONE, scopes: ['tasks.read'] });
    await db.query("UPDATE team_members SET status = 'suspended' WHERE id = $1", [GONE]);
    result = await editApiKey(service, ada, gusKey.id, { name: 'Renamed' });
    check("suspended member's key is refused (422)", result.status === 422 && /suspended/.test(errorOf(result)), result);

    // The owner holds every API scope.
    const owner = await editor(OWNER);
    const ownerKey = await insertKey(db, { member: OWNER, createdBy: OWNER, scopes: ['tasks.read'] });
    result = await editApiKey(service, owner, ownerKey.id, { scopes: ['tasks.read', 'tasks.manage_all', 'audit.read'] });
    check('owner: any API scope', result.status === 200, result);
    result = await editApiKey(service, owner, ownerKey.id, { scopes: ['api_keys.manage_all'] });
    check('owner: an app-only permission is still not an API scope', result.status === 422, result);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`API key edit: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`API key edit: ${passed} checks passed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
