/**
 * Groups in Trash (20261127003700_cleanup_projects.sql), on PGlite with the
 * full schema, signed-in members (row security on) and the server's own
 * functions over a fake PostgREST:
 * - A group moves to Trash through the one Trash function, by an Owner or
 *   someone with groups.manage only, and Settings > Trash lists it for them.
 * - While it is there it grants nothing: no agent audience, no managing the
 *   agents it owns, no being told about them, no initiative webhook reach.
 * - Restore brings it back exactly as it was (members, leads, owned agents,
 *   audiences), and every grant with it; a restore is refused while another
 *   live group uses its short name.
 * - Over the API: trashGroup goes through Trash, GET /api/v1/trash lists it
 *   for a manager only, the restore route brings it back, and MCP has
 *   trash_group and restore_from_trash for groups, with the same permission.
 * - The migration, run twice on the schema before it, matches schema.sql.
 *
 *   npm run -s test:group-trash
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH, schemaBeforeMigration } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';

const MIGRATION = '20261127003700_cleanup_projects.sql';
const BANNER = '-- CLEANUP PROJECTS: GROUPS IN TRASH (20261127003700_cleanup_projects.sql)';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

const LOGINS = {
  owner: { id: '00000000-0000-4000-8000-0000000c1001', email: 'morgan@example.com' },
  manager: { id: '00000000-0000-4000-8000-0000000c1002', email: 'gale@example.com' },
  member: { id: '00000000-0000-4000-8000-0000000c1003', email: 'sam@example.com' },
};

async function seed(db: PGlite) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec('RESET ROLE');
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      const made = (await q<{ id: string }>('SELECT id FROM pm.team_members WHERE auth_user_id = $1', [login.id]))[0]?.id;
      if (made) {
        await q('UPDATE pm.team_members SET name = $1, role = $2 WHERE id = $3', [name, role, made]);
        return made;
      }
    }
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id',
      [name, login?.email ?? `${name.toLowerCase().replace(/\W/g, '')}@example.com`, role]))[0].id;
    if (login) await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    return id;
  };
  const owner = await member('Morgan Hale', 'owner', LOGINS.owner);
  const manager = await member('Gale Ortiz', 'member', LOGINS.manager);
  const sam = await member('Sam Lee', 'member', LOGINS.member);
  const nina = await member('Nina Park', 'member');
  const agent = await member('Ledger', 'agent');
  for (const channel of ['app', 'api']) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'groups.manage', $2, 'allow')", [manager, channel]);
  }
  const finance = (await q<{ id: string }>("INSERT INTO pm.groups (name, slug, description) VALUES ('Finance', 'finance', 'Money questions') RETURNING id"))[0].id;
  await q("INSERT INTO pm.group_members (group_id, member_id, role) VALUES ($1, $2, 'lead'), ($1, $3, 'member')", [finance, nina, sam]);
  // Finance owns the bookkeeper and is the only audience that may use it.
  await q('INSERT INTO pm.agent_owner_groups (agent_id, group_id) VALUES ($1, $2)', [agent, finance]);
  await q("INSERT INTO pm.agent_audience (agent_id, kind, ref, effect) VALUES ($1, 'group', $2, 'include')", [agent, finance]);
  return { owner, manager, sam, nina, agent, finance };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function grants(db: PGlite, s: Seeded) {
  await actAs(db, null);
  const row = (await db.query<{ uses: boolean; manages: boolean; told: string[] }>(
    'SELECT pm.member_may_use_agent($1, $2) AS uses, pm.member_manages_agent($1, $2) AS manages, pm.agent_people_to_tell($1)::text[] AS told',
    [s.agent, s.nina])).rows[0];
  await db.exec('RESET ROLE');
  return { uses: row.uses, manages: row.manages, told: row.told.includes(s.nina) };
}

async function rpc(db: PGlite, login: { id: string } | null, sql: string, params: unknown[]): Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }> {
  await actAs(db, login?.id ?? null);
  try {
    const value = (await db.query<{ v: unknown }>(sql, params)).rows[0]?.v;
    return { ok: true, value };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code, message: e.message };
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function databaseChecks(db: PGlite, s: Seeded) {
  const types = (await db.query<{ t: string[] }>('SELECT pm.trash_record_types() AS t')).rows[0].t;
  check('database: groups is a Trash record type', types.includes('groups'), types);

  const before = await grants(db, s);
  check('grants: a live group gives its members the agent, its management and its notices', before.uses && before.manages && before.told, before);

  const bySam = await rpc(db, LOGINS.member, "SELECT pm.soft_delete_record('groups', $1) AS v", [s.finance]);
  check('trash: a member without groups.manage cannot move a group to Trash', !bySam.ok && bySam.code === '42501', bySam);

  const byOwner = await rpc(db, LOGINS.owner, "SELECT pm.soft_delete_record('groups', $1) AS v", [s.finance]);
  check('trash: an Owner moves a group to Trash', byOwner.ok && byOwner.value === true, byOwner);
  const events = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pm.trash_events WHERE table_name = 'groups' AND record_id = $1 AND NOT restored", [s.finance])).rows[0].n;
  check('trash: the move is a Trash event, so open Trash pages refresh', events === 1, events);

  const during = await grants(db, s);
  check('grants: a group in Trash gives no agent audience', !during.uses, during);
  check('grants: a group in Trash gives no management of the agents it owns', !during.manages, during);
  check('grants: a group in Trash is not told about the agents it owned', !during.told, during);

  const listed = await rpc(db, LOGINS.owner, "SELECT coalesce(json_agg(t), '[]'::json) AS v FROM pm.list_trash(ARRAY['groups']) t", []);
  const listedRows = (listed.value ?? []) as { id: string; label: string; context: string; record_type: string }[];
  check('trash list: an Owner sees the group, by name', listedRows.some((r) => r.id === s.finance && r.label === 'Finance' && r.record_type === 'groups'), listed);
  const listedSam = await rpc(db, LOGINS.member, "SELECT coalesce(json_agg(t), '[]'::json) AS v FROM pm.list_trash(ARRAY['groups']) t", []);
  check('trash list: a member without groups.manage does not', ((listedSam.value ?? []) as unknown[]).length === 0, listedSam);

  // A new live group took its short name meanwhile (only possible once it is in Trash).
  const inTrash = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.groups WHERE id = $1 AND deleted_at IS NOT NULL', [s.finance])).rows[0].n === 1;
  if (inTrash) await db.query("INSERT INTO pm.groups (name, slug) VALUES ('Finance team', 'finance')");
  const clash = await rpc(db, LOGINS.owner, "SELECT pm.restore_record('groups', $1) AS v", [s.finance]);
  check('restore: refused, saying why, while another live group uses its short name', inTrash && !clash.ok && clash.code === '55000' && /short name/.test(clash.message ?? ''), clash);
  if (inTrash) await db.query("UPDATE pm.groups SET slug = 'finance-team' WHERE slug = 'finance' AND deleted_at IS NULL");

  const bySamRestore = await rpc(db, LOGINS.member, "SELECT pm.restore_record('groups', $1) AS v", [s.finance]);
  check('restore: a member without groups.manage cannot restore it', !bySamRestore.ok && bySamRestore.code === '42501', bySamRestore);
  const restored = await rpc(db, LOGINS.manager, "SELECT pm.restore_record('groups', $1) AS v", [s.finance]);
  check('restore: someone with groups.manage brings it back', restored.ok && restored.value === true, restored);

  const kept = (await db.query<{ members: number; leads: number; owns: number; audience: number }>(`
    SELECT (SELECT count(*)::int FROM pm.group_members WHERE group_id = $1) AS members,
           (SELECT count(*)::int FROM pm.group_members WHERE group_id = $1 AND role = 'lead') AS leads,
           (SELECT count(*)::int FROM pm.agent_owner_groups WHERE group_id = $1) AS owns,
           (SELECT count(*)::int FROM pm.agent_audience WHERE kind = 'group' AND ref = $1::text) AS audience`, [s.finance])).rows[0];
  check('restore: it comes back intact (members, leads, owned agent, audience)', kept.members === 2 && kept.leads === 1 && kept.owns === 1 && kept.audience === 1, kept);
  const after = await grants(db, s);
  check('grants: every grant comes back with it', after.uses && after.manages && after.told, after);
}

async function apiChecks(db: PGlite, s: Seeded) {
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { trashGroup } = await import('../src/lib/api/groups');
    const { listTrashForApi, restoreForApi } = await import('../src/lib/api/trash-api');
    const service = getServiceClient();
    const ownerAccess = (await resolveMemberAccess(service, s.owner))!;
    const samAccess = (await resolveMemberAccess(service, s.sam))!;
    const owner = { service, access: ownerAccess, scopes: [] as string[], memberId: s.owner };
    const sam = { service, access: samAccess, scopes: [] as string[], memberId: s.sam };

    const moved = await trashGroup(service, { memberId: s.owner, access: ownerAccess, scopes: [] }, s.finance).then(() => true, (error: Error) => error.message);
    check('api: trashGroup moves a group to Trash', moved === true, moved);
    const events = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pm.trash_events WHERE table_name = 'groups' AND record_id = $1", [s.finance])).rows[0].n;
    check('api: DELETE a group goes through Trash (a Trash event is recorded)', events === 3, events);
    const ownerList = await listTrashForApi(owner, ['groups'], 100);
    check('api: GET /api/v1/trash lists the group for an Owner', ownerList.some((item) => item.id === s.finance), ownerList);
    const samList = await listTrashForApi(sam, ['groups'], 100);
    check('api: and not for a member without groups.manage', samList.length === 0, samList);
    const samRestore = await restoreForApi(sam, 'groups', s.finance).then(() => 'restored', (error: { statusCode?: number }) => error.statusCode);
    check('api: a member without groups.manage gets 404 restoring it', samRestore === 404, samRestore);
    const ownerRestore = await restoreForApi(owner, 'groups', s.finance).catch((error: Error) => ({ restored: false, error: error.message }));
    const live = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.groups WHERE id = $1 AND deleted_at IS NULL', [s.finance])).rows[0].n;
    check('api: POST /api/v1/trash/groups/:id/restore brings it back', ownerRestore.restored === true && live === 1, { ownerRestore, live });
  } finally {
    await server.close();
  }

  const { PM_TOOLS } = await import('../src/lib/mcp/tools');
  const trashTool = PM_TOOLS.find((tool) => tool.name === 'trash_group');
  const route = trashTool?.routes?.[0];
  check('mcp: trash_group moves a group to Trash with groups.manage, over the same route', !!trashTool && trashTool.permission === 'groups.manage'
    && route?.method === 'DELETE' && route?.path === '/api/v1/groups/{id}', trashTool && { permission: trashTool.permission, route });
  const restoreTool = PM_TOOLS.find((tool) => tool.name === 'restore_from_trash');
  const restoreSchema = JSON.stringify(restoreTool ? (await import('../src/lib/mcp/core')).toolDefinition(restoreTool).inputSchema : null);
  check('mcp: restore_from_trash takes groups', restoreSchema.includes('"groups"'), restoreSchema.slice(0, 300));
}

async function migrationChecks() {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const migration = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
  // Found by its banner: later migrations append their own sections after it.
  const at = schema.indexOf(BANNER);
  // The body starts after the banner's closing rule; the next section starts at the next title line.
  const bodyAt = at < 0 ? -1 : schema.indexOf('\n', schema.indexOf('\n', at) + 1) + 1;
  const nextTitle = bodyAt < 0 ? -1 : schema.slice(bodyAt).search(/\n-- =+\n-- [A-Z][^\n]*\(\d{14}_[a-z0-9_]+\.sql\)\n/);
  const section = bodyAt < 0 ? '' : schema.slice(bodyAt, nextTitle < 0 ? schema.length : bodyAt + nextTitle);
  check('schema.sql: the migration is appended under its banner', at > 0 && section.trim() === migration.trim());
  // The schema before it is read from git; a migration committed after it on this branch
  // but numbered before it is missing there too, so every missing one runs, in order.
  const beforeSql = schemaBeforeMigration(MIGRATION);
  const before = await createFullSchemaDatabase({ schemaSql: beforeSql });
  const dir = join(__dirname, '..', 'supabase', 'migrations');
  const missing = readdirSync(dir).filter((file) => file.endsWith('.sql') && file < MIGRATION && file > '20261127000000' && !beforeSql.includes(`(${file})`)).sort();
  for (const file of missing) {
    const sql = readFileSync(join(dir, file), 'utf8');
    await before.exec(sql);
    await before.exec(sql);
  }
  await applyMigrationsFrom(before, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(before));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await before.close();
  await fresh.close();
}

async function main() {
  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  await databaseChecks(db, s);
  await apiChecks(db, s);
  await db.close();
  await migrationChecks().catch((error: Error) => check('upgrade: the migration check ran', false, error.message));

  if (failures.length) {
    console.error(`group trash: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`group trash: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
