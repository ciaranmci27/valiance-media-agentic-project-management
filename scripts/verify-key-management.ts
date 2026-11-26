/**
 * API keys you can manage (20261127000600_key_management.sql), against the
 * real schema on PGlite behind the PostgREST stand-in, through the real
 * services, withApi and the v1 routes:
 *
 * - Migration: schema.sql carries the section; the migration, run twice on
 *   the schema without it, matches schema.sql; the previous release still
 *   makes and revokes keys.
 * - Pause and Resume: a paused key is refused at sign-in (401
 *   api_key_paused) and keeps its secret; Resume brings it back. Twice is a
 *   no-op with one audit row each way. A one-hour AI setup key (pk_setup_)
 *   is never edited, paused, resumed or rotated (409 setup_key_fixed), only
 *   revoked. A key an AI setup session mints records no parent, so revoking
 *   the setup key leaves it working. Who may: the revoke rule (member,
 *   creator, api_keys.manage_all); others get 404. Revoked and expired keys
 *   are 409. Pausing an agent's key leaves the agent's own pause alone. A
 *   paused key is not rotated, also when the pause lands after the server's
 *   check (the database refuses it under its lock). Pausing a successor
 *   stops the replaced secret in its overlap too. Over v1, audited as REST.
 * - Edit: removing is always allowed (also next to a scope the member no
 *   longer holds); adding needs the member and the editor to hold the scope;
 *   an agent key never gains NEVER_AGENT_SCOPES; over v1, minting's rules
 *   (scope_escalation, owner_only). Every change is audited before and after.
 * - Lists: each key's state; ?state= narrows (the database filter matches
 *   apiKeyState for every filter); counts; a bad state is 400. A database
 *   without the pause columns still signs keys in and lists them.
 * - The permission grid: every permission placed exactly once; scopes round
 *   trip; Manage implies View by PERMISSION_IMPLIED_BY and turning View off
 *   turns Manage off; a column selects only what is grantable; locked cells
 *   say why.
 *
 *   npm run -s test:key-management
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { PERMISSIONS, PERMISSION_IMPLIED_BY, permissionLabel, type PermissionKey } from '../src/lib/access-control';
import { API_KEY_STATE_FILTERS, apiKeyState, keyMatchesState } from '../src/lib/api-key-state';
import {
  GRID_AREAS, GRID_LEVELS, PERMISSION_PLACEMENT, SPECIAL_POWERS, cellKeys, grantableSet, gridToScopes, lockedCells, lockedPowers,
  scopeLock, scopesToGrid, selectColumn, setCell, toggleCell, togglePower,
} from '../src/lib/permission-grid';

const MIGRATION = '20261127000600_key_management.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = `-- KEY MANAGEMENT (${MIGRATION})`;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------
async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the key management section is there', at > 0 && banner > 0);
  // The section runs to the next one (other releases append after it) or the end.
  const next = SCHEMA_SQL.indexOf('\n-- ============================================================\n-- ', at + SECTION.length + 70);
  const end = next > 0 ? next : SCHEMA_SQL.length;
  check('schema.sql: the section mirrors the migration body', SCHEMA_SQL.slice(at, end).includes(MIGRATION_SQL.trim()));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) + SCHEMA_SQL.slice(end) });
  const member = (await old.query<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Old', 'old@example.com', 'agent') RETURNING id")).rows[0].id;
  await old.query("INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions) VALUES ('Old key', 'pk_live', 'h1', $1, '{tasks.read}', 'scoped')", [member]);
  await old.exec(MIGRATION_SQL);
  await old.exec(MIGRATION_SQL);
  const kept = (await old.query<Loose>('SELECT paused_at, paused_by FROM pm.api_keys')).rows;
  check('upgrade: an existing key is not paused', kept.length === 1 && kept[0].paused_at === null && kept[0].paused_by === null, kept);
  // What the previous release does still works: insert without the columns, revoke by update.
  await old.query("INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions) VALUES ('Prev key', 'pk_live', 'h2', $1, '{tasks.read}', 'scoped')", [member]);
  const plain = await old.query("UPDATE pm.api_keys SET revoked_at = now() WHERE key_hash = 'h2' AND revoked_at IS NULL");
  check('upgrade: the previous release still makes and revokes keys', plain.affectedRows === 1);
  // The same copy of schema.sql both sides, read once (other work may be appending to the file).
  const fresh = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL });
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema without it, matches schema.sql', diff.length === 0, diff.slice(0, 10));
  await old.close();
  await fresh.close();
}

// ---------------------------------------------------------------------------
// The permission grid (pure)
// ---------------------------------------------------------------------------
function gridChecks() {
  const placed = new Map<string, number>();
  for (const { id } of GRID_AREAS) for (const level of GRID_LEVELS) for (const key of cellKeys(id, level)) placed.set(key, (placed.get(key) ?? 0) + 1);
  for (const key of SPECIAL_POWERS) placed.set(key, (placed.get(key) ?? 0) + 1);
  const unplaced = PERMISSIONS.filter((key) => !placed.has(key));
  const twice = [...placed].filter(([, n]) => n > 1).map(([key]) => key);
  const unknown = [...placed.keys()].filter((key) => !(PERMISSIONS as readonly string[]).includes(key));
  check('grid: every permission is placed', unplaced.length === 0, unplaced);
  check('grid: no permission is placed twice', twice.length === 0, twice);
  check('grid: nothing but permissions is placed', unknown.length === 0, unknown);
  check('grid: the placement table names exactly the permissions', Object.keys(PERMISSION_PLACEMENT).length === PERMISSIONS.length);
  const ranks = SPECIAL_POWERS.map((key) => (PERMISSION_PLACEMENT[key] as { power: number }).power);
  check('grid: special power ranks are distinct', new Set(ranks).size === ranks.length, ranks);
  check('grid: special powers start with acting for a person and deciding approvals', SPECIAL_POWERS[0] === 'agents.act_for' && SPECIAL_POWERS[1] === 'approvals.decide');
  check('grid: areas are in the asked order', GRID_AREAS.slice(0, 9).map((a) => a.id).join() === 'tasks,projects,contacts,leads,inbox,meetings,team,agents,templates');
  check('grid: every area has at least one cell', GRID_AREAS.every(({ id }) => GRID_LEVELS.some((level) => cellKeys(id, level).length > 0)));

  const empty = scopesToGrid([]);
  const contacts = empty.areas.find((a) => a.id === 'contacts')!;
  check('grid: cell labels are the permission labels', contacts.cells.view_all?.label === permissionLabel('contacts.read_all') && contacts.cells.view?.label === 'View work contacts', contacts.cells);
  check('grid: special powers carry plain descriptions', empty.powers.every((p) => p.description.length > 10 && p.label !== p.key), empty.powers.filter((p) => p.description.length <= 10));

  // Round trips, including scopes this build does not know.
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let roundTrips = 0;
  for (let i = 0; i < 200; i++) {
    const scopes = PERMISSIONS.filter(() => random() < 0.35) as string[];
    if (i % 5 === 0) scopes.push('future.scope');
    const back = gridToScopes(scopesToGrid(scopes));
    if (back.length === scopes.length && back.every((s) => scopes.includes(s))) roundTrips++;
  }
  check('grid: 200 random scope sets round trip through the grid', roundTrips === 200, roundTrips);
  const all = gridToScopes(scopesToGrid(PERMISSIONS));
  check('grid: every permission round trips', all.length === PERMISSIONS.length);
  const tasks = scopesToGrid(['tasks.create', 'tasks.manage_assigned']).areas.find((a) => a.id === 'tasks')!;
  check('grid: a cell with some of its keys is partial', tasks.cells.manage?.state === 'partial' && tasks.cells.view?.state === 'off', tasks.cells.manage);

  // Implications.
  let grid = toggleCell(empty, 'contacts', 'manage');
  let held = gridToScopes(grid);
  check('grid: Manage contacts turns on View work contacts (PERMISSION_IMPLIED_BY)', held.includes('contacts.manage') && held.includes('contacts.read') && !held.includes('contacts.read_all'), held);
  grid = toggleCell(grid, 'contacts', 'view');
  held = gridToScopes(grid);
  check('grid: turning View off turns off what implies it', !held.includes('contacts.read') && !held.includes('contacts.manage'), held);
  grid = setCell(empty, 'tasks', 'manage', true);
  held = gridToScopes(grid);
  check('grid: Manage tasks turns on View tasks (manage_all implies read)', ['tasks.create', 'tasks.manage_assigned', 'tasks.manage_all', 'tasks.read'].every((k) => held.includes(k)) && !held.includes('tasks.read_assigned'), held);
  const everyImplication = Object.entries(PERMISSION_IMPLIED_BY).every(([lower, higher]) =>
    higher!.every((key) => gridToScopes(togglePower(setCellFor(key), key as PermissionKey)).length >= 0 && gridToScopes(setCellFor(key)).includes(lower)));
  check('grid: every implication holds when its broader key is turned on', everyImplication);

  // Grantable sets and locks.
  const agentLimits = { holderIsAgent: true, holderName: 'Scout' };
  const agentGrantable = grantableSet(agentLimits);
  check('locks: an agent never gets NEVER_AGENT_SCOPES', !agentGrantable.has('meetings.write') && scopeLock('meetings.write', agentLimits)?.reason === 'Agents never get this.');
  check('locks: a key never carries an app-only permission', scopeLock('access.manage')?.kind === 'channel' && !agentGrantable.has('access.manage'));
  check('locks: the app never offers a key-only permission', scopeLock('agents.act_for', { channel: 'app' })?.kind === 'channel');
  const editorLimits = { holderHolds: ['tasks.read', 'tasks.create', 'contacts.read'], holderName: 'Mia', editorHolds: ['tasks.read', 'contacts.read', 'contacts.manage'] };
  check('locks: beyond the holder, in plain words naming them', scopeLock('contacts.manage', editorLimits)?.reason === "Mia isn't allowed to do this, so it can't be given here.");
  check('locks: beyond the editor', scopeLock('tasks.create', editorLimits)?.reason === "You don't have this yourself, so you can't give it.");
  const locks = lockedCells(editorLimits);
  const taskManage = locks.find((l) => l.area === 'tasks' && l.level === 'manage');
  check('locks: Tasks > Manage is locked, each key with its reason', taskManage?.locked === 'all' && taskManage.reasons.some((r) => r.key === 'tasks.create' && r.kind === 'editor'), taskManage);
  check('locks: Tasks > View all is open', !locks.some((l) => l.area === 'tasks' && l.level === 'view_all'));
  check('locks: Meetings is locked for an agent', lockedCells(agentLimits).some((l) => l.area === 'meetings' && l.locked === 'all' && l.reasons[0].kind === 'never_for_agents'));
  check('locks: locked special powers say why', lockedPowers(agentLimits).some((p) => p.key === 'assistants.provision' && p.kind === 'never_for_agents'));
  const editorGrantable = grantableSet(editorLimits);
  const viewAll = gridToScopes(selectColumn(empty, 'view', editorGrantable));
  check('grid: selecting a column turns on only what is grantable', viewAll.join() === 'tasks.read,contacts.read' || (viewAll.every((k) => editorGrantable.has(k as PermissionKey)) && viewAll.includes('contacts.read')), viewAll);
  const blocked = toggleCell(empty, 'tasks', 'manage', editorGrantable);
  check('grid: a locked cell does not turn on', gridToScopes(blocked).length === 0, gridToScopes(blocked));
  const removeLocked = toggleCell(scopesToGrid(['tasks.create']), 'tasks', 'manage', editorGrantable);
  check('grid: removing is always allowed, locked or not', gridToScopes(removeLocked).length === 0);
  const cleared = selectColumn(scopesToGrid(PERMISSIONS), 'manage', null, false);
  check('grid: clearing a column removes it everywhere', !gridToScopes(cleared).some((k) => {
    const at = PERMISSION_PLACEMENT[k as PermissionKey];
    return 'area' in at && at.level === 'manage';
  }));
}

/** A grid with only the cell (or power) holding `key` turned on. */
function setCellFor(key: string) {
  const at = PERMISSION_PLACEMENT[key as PermissionKey];
  const empty = scopesToGrid([]);
  return 'area' in at ? setCell(empty, at.area, at.level, true) : togglePower(empty, key as PermissionKey);
}

// ---------------------------------------------------------------------------
// The database-backed checks
// ---------------------------------------------------------------------------
async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role: string) =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const ada = await member('Ada', 'admin');
  const mia = await member('Mia', 'member');
  const otto = await member('Otto', 'member');
  const scout = await member('Scout', 'agent');
  const grant = async (memberId: string, permission: string, channel: 'app' | 'api', effect: 'allow' | 'deny' = 'allow') =>
    q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, $3, $4)
       ON CONFLICT (member_id, permission_key, access_channel) DO UPDATE SET effect = EXCLUDED.effect`, [memberId, permission, channel, effect]);
  // Explicit, so the checks never lean on role defaults.
  await grant(ada, 'api_keys.manage_all', 'app');
  await grant(ada, 'api_keys.manage_all', 'api');
  for (const p of ['tasks.read', 'projects.read', 'team.read']) await grant(ada, p, 'api');
  await grant(ada, 'time.manage_own', 'api', 'deny');
  await grant(otto, 'api_keys.manage_all', 'app', 'deny');
  for (const p of ['tasks.read', 'projects.read', 'time.manage_own']) await grant(mia, p, 'api');
  await grant(mia, 'tasks.create', 'api', 'deny');
  await grant(mia, 'api_keys.manage_all', 'app', 'deny');
  for (const p of ['tasks.read', 'team.read']) await grant(scout, p, 'api');
  const key = async (memberId: string, scopes: string[], fields: { createdBy?: string; name?: string; expired?: boolean; revoked?: boolean; setup?: boolean } = {}) => {
    const secret = `${fields.setup ? 'pk_setup_' : 'pk_live_'}${randomUUID().replace(/-/g, '')}`;
    const rows = await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions, expires_at, revoked_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'scoped', CASE WHEN $7 THEN now() - interval '1 hour' END, CASE WHEN $8 THEN now() END) RETURNING id`,
    [fields.name ?? 'Seed key', secret.slice(0, 15), createHash('sha256').update(secret).digest('hex'), memberId, fields.createdBy ?? memberId, scopes, !!fields.expired, !!fields.revoked]);
    return { id: rows[0].id, secret };
  };
  return { q, owner, ada, mia, otto, scout, key };
}

async function main() {
  gridChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { strictColumns: true });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { withApi } = await import('../src/lib/api/middleware');
    const { setKeyPaused, listVisibleKeys } = await import('../src/lib/api/key-manage');
    const { editApiKey } = await import('../src/lib/api/key-edit');
    const { rotateApiKey } = await import('../src/lib/api/key-rotate');
    const { sessionCaller } = await import('../src/lib/api/agent-workspace');
    const v1List = await import('../src/app/api/v1/api-keys/route');
    const v1Edit = await import('../src/app/api/v1/api-keys/[id]/route');
    const v1Pause = await import('../src/app/api/v1/api-keys/[id]/pause/route');
    const v1Resume = await import('../src/app/api/v1/api-keys/[id]/resume/route');
    const service = getServiceClient();

    const person = async (memberId: string) => {
      const access = await resolveMemberAccess(service, memberId);
      if (!access) throw new Error(`no access for ${memberId}`);
      return { memberId, access };
    };
    const sessionActor = async (memberId: string, id: string, action: string) => ({
      ...(await person(memberId)), apiKeyId: null, endpoint: `/api/workspace/api-keys/${id}/${action}`, via: 'app' as const, checkManage: true,
    });
    const pause = async (memberId: string, id: string, paused: boolean) => {
      try {
        return { ok: true as const, key: await setKeyPaused(service, await sessionActor(memberId, id, paused ? 'pause' : 'resume'), id, paused) };
      } catch (error) {
        const e = error as { statusCode?: number; details?: { reason?: string } };
        return { ok: false as const, status: e.statusCode, reason: e.details?.reason };
      }
    };
    const probe = withApi(async () => Response.json({ ok: true }), { permission: 'tasks.read' });
    const signIn = async (secret: string): Promise<Answer> => {
      const response = await probe(new NextRequest('http://localhost/api/v1/tasks', { headers: { 'x-api-key': secret } }));
      return { status: response.status, body: await response.json() };
    };
    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json() };
    };
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const row = async (id: string) => (await s.q<Loose>('SELECT name, scopes, key_hash, paused_at, paused_by, revoked_at FROM pm.api_keys WHERE id = $1', [id]))[0];
    const audits = async (id: string) => s.q<Loose>("SELECT method, endpoint, request_body, before_snapshot, after_snapshot, via, api_key_id, team_member_id FROM pm.api_audit_log WHERE entity_type = 'api_key' AND entity_id = $1 ORDER BY timestamp, id", [id]);
    const errorOf = (result: { body: unknown }) => (result.body as { error?: string }).error ?? '';

    // --- Pause and Resume ---------------------------------------------------------------------
    const mias = await s.key(s.mia, ['tasks.read'], { name: 'Zapier' });
    check('pause: the key works before', (await signIn(mias.secret)).status === 200);
    const hashBefore = (await row(mias.id)).key_hash;
    let result = await pause(s.mia, mias.id, true);
    check('pause: the member pauses their own key', result.ok && result.key.state === 'paused' && result.key.paused_by === s.mia && !!result.key.paused_at, result);
    const refused = await signIn(mias.secret);
    check('pause: a paused key is refused at sign-in with 401 api_key_paused', refused.status === 401 && reason(refused) === 'api_key_paused', refused);
    check('pause: the secret is kept', (await row(mias.id)).key_hash === hashBefore);
    result = await pause(s.mia, mias.id, true);
    check('pause: pausing again answers the key as it is', result.ok && result.key.state === 'paused');
    result = await pause(s.mia, mias.id, false);
    check('resume: the key is active again', result.ok && result.key.state === 'active' && result.key.paused_at === null && result.key.paused_by === null, result);
    check('resume: the same secret signs in again', (await signIn(mias.secret)).status === 200);
    result = await pause(s.mia, mias.id, false);
    check('resume: resuming again answers the key as it is', result.ok && result.key.state === 'active');
    const trail = await audits(mias.id);
    check('audit: one row for the pause and one for the resume, nothing for the repeats', trail.length === 2
      && trail[0].request_body?.action === 'pause' && trail[1].request_body?.action === 'resume', trail.map((t) => t.request_body));
    check('audit: before and after snapshots', trail[0]?.before_snapshot?.state === 'active' && trail[0]?.after_snapshot?.state === 'paused'
      && trail[0]?.after_snapshot?.paused_by === s.mia && trail[1]?.before_snapshot?.state === 'paused' && trail[1]?.after_snapshot?.state === 'active', trail[0]);
    check('audit: names who did it, from the app, never the hash', trail.every((t) => t.via === 'app' && t.team_member_id === s.mia && t.api_key_id === null)
      && !JSON.stringify(trail).includes(hashBefore), trail.map((t) => [t.via, t.team_member_id]));

    result = await pause(s.otto, mias.id, true);
    check("pause: someone else's key is hidden (404)", !result.ok && result.status === 404, result);
    result = await pause(s.ada, mias.id, true);
    check('pause: api_keys.manage_all pauses anyone\'s key', result.ok && result.key.paused_by === s.ada, result);
    result = await pause(s.mia, mias.id, false);
    check('resume: the member resumes a key someone else paused', result.ok && result.key.state === 'active', result);
    const madeForMia = await s.key(s.mia, ['tasks.read'], { createdBy: s.otto });
    result = await pause(s.otto, madeForMia.id, true);
    check('pause: the creator may, as revoke allows', result.ok, result);
    await pause(s.otto, madeForMia.id, false);

    const revoked = await s.key(s.mia, ['tasks.read'], { revoked: true });
    result = await pause(s.mia, revoked.id, true);
    check('pause: a revoked key is 409 key_revoked', !result.ok && result.status === 409 && result.reason === 'key_revoked', result);
    const expired = await s.key(s.mia, ['tasks.read'], { expired: true });
    result = await pause(s.mia, expired.id, true);
    check('pause: an expired key is 409 key_expired', !result.ok && result.status === 409 && result.reason === 'key_expired', result);
    result = await pause(s.mia, 'not-a-key', true);
    check('pause: not an id is 404', !result.ok && result.status === 404);

    // An agent's key: the agent's own pause is its member's, never touched.
    const scoutKey = await s.key(s.scout, ['tasks.read'], { createdBy: s.owner });
    const agentPause = async () => (await s.q<Loose>('SELECT agent_paused_at, agent_paused_by FROM pm.team_members WHERE id = $1', [s.scout]))[0];
    result = await pause(s.owner, scoutKey.id, true);
    check("agent key: pausing it leaves the agent's own pause alone", result.ok && (await agentPause()).agent_paused_at === null, await agentPause());
    await s.q('UPDATE pm.team_members SET agent_paused_at = now(), agent_paused_by = $1 WHERE id = $2', [s.owner, s.scout]);
    result = await pause(s.owner, scoutKey.id, false);
    check("agent key: resuming it leaves a paused agent paused", result.ok && (await agentPause()).agent_paused_at !== null, await agentPause());
    await s.q('UPDATE pm.team_members SET agent_paused_at = NULL, agent_paused_by = NULL WHERE id = $1', [s.scout]);

    // A paused key is not rotated (a working successor would undo the pause): the database
    // refuses it under its row lock, so no check-then-rotate race, and the service says key_paused.
    await pause(s.mia, mias.id, true);
    const mia = await person(s.mia);
    const { caller, granter } = sessionCaller(s.mia, mia.access);
    const rotated = await rotateApiKey(service, { caller, granter, apiKeyId: null, endpoint: 'test', via: 'app' }, mias.id, {}).then(() => null, (e: Loose) => e.details?.reason);
    check('rotate: a paused key is 409 key_paused', rotated === 'key_paused', rotated);
    await pause(s.mia, mias.id, false);

    // The database refuses a paused key under its row lock, so a pause that lands after the
    // server's check still leaves no working successor; PostgREST surfaces it as key_paused.
    const raced = await s.key(s.mia, ['tasks.read']);
    await s.q('UPDATE pm.api_keys SET paused_at = now(), paused_by = $1 WHERE id = $2', [s.mia, raced.id]);
    const rpc = await service.rpc('rotate_api_key', { p_key_id: raced.id, p_key_prefix: 'pk_live_x', p_key_hash: `race-${randomUUID()}`, p_created_by: s.mia, p_expires_at: null, p_overlap_seconds: 3600 });
    check('rotate (database): a paused key is refused under the lock', rpc.error?.code === '55000' && /is paused/.test(rpc.error?.message ?? ''), rpc.error);
    await db.exec('RESET ROLE');
    const hint = await db.query("SELECT pm.rotate_api_key($1, 'pk_live_y', 'race-hint', NULL, NULL, 60)", [raced.id]).then(() => null, (e: Loose) => e.hint);
    check('rotate (database): the refusal carries HINT key_paused', hint === 'key_paused', hint);
    check('rotate (database): no successor was made', (await s.q('SELECT id FROM pm.api_keys WHERE rotated_from = $1', [raced.id])).length === 0);
    const fnGrants = (await s.q<Loose>(`SELECT has_function_privilege('anon', 'pm.rotate_api_key(uuid, text, text, uuid, timestamptz, integer)', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', 'pm.rotate_api_key(uuid, text, text, uuid, timestamptz, integer)', 'EXECUTE') AS authed,
      has_function_privilege('service_role', 'pm.rotate_api_key(uuid, text, text, uuid, timestamptz, integer)', 'EXECUTE') AS service`))[0];
    check('rotate (database): still service role only', !fnGrants.anon && !fnGrants.authed && fnGrants.service, fnGrants);
    await s.q('UPDATE pm.api_keys SET paused_at = NULL, paused_by = NULL WHERE id = $1', [raced.id]);
    // Pausing a successor stops the replaced secret too, through its overlap; resuming brings both back.
    const rot = await s.key(s.mia, ['tasks.read']);
    const made = await rotateApiKey(service, { caller, granter, apiKeyId: null, endpoint: 'test', via: 'app' }, rot.id, { overlap_hours: 24 });
    check('overlap: the replaced secret works during its overlap', (await signIn(rot.secret)).status === 200 && (await signIn(made.secret)).status === 200);
    result = await pause(s.mia, made.key.id, true);
    const oldRefused = await signIn(rot.secret);
    check('overlap: pausing the successor stops the replaced secret too (401 api_key_paused)', result.ok && oldRefused.status === 401 && reason(oldRefused) === 'api_key_paused', oldRefused);
    check('overlap: and the successor itself', reason(await signIn(made.secret)) === 'api_key_paused');
    result = await pause(s.mia, made.key.id, false);
    check('overlap: resuming the successor brings both secrets back', result.ok && (await signIn(rot.secret)).status === 200 && (await signIn(made.secret)).status === 200);
    // Rotated twice inside the first overlap (A to B to C): pausing C stops A as well.
    const third = await rotateApiKey(service, { caller, granter, apiKeyId: null, endpoint: 'test', via: 'app' }, made.key.id, { overlap_hours: 24 });
    result = await pause(s.mia, third.key.id, true);
    const firstRefused = await signIn(rot.secret);
    check('overlap: pausing the newest of a chain stops the first secret too', result.ok && firstRefused.status === 401 && reason(firstRefused) === 'api_key_paused', firstRefused);
    result = await pause(s.mia, third.key.id, false);

    // Over v1.
    const ownerKey = await s.key(s.owner, ['api_keys.manage_all', 'tasks.read', 'team.read']);
    const adaKey = await s.key(s.ada, ['api_keys.manage_all', 'tasks.read', 'projects.read']);
    const target = await s.key(s.mia, ['tasks.read']);
    let answer = await call(v1Pause.POST, 'POST', `/api/v1/api-keys/${target.id}/pause`, { id: target.id }, ownerKey.secret);
    check('v1 pause: the key, paused, with its state', answer.status === 200 && answer.body.data?.state === 'paused' && answer.body.data?.paused_by === s.owner && !('key_hash' in (answer.body.data ?? {})), answer.body);
    check('v1 pause: it is refused at sign-in', reason(await signIn(target.secret)) === 'api_key_paused');
    const restAudit = (await audits(target.id))[0];
    check('v1 pause: audited as REST with the calling key', restAudit?.via === 'rest' && restAudit?.api_key_id === ownerKey.id && restAudit?.after_snapshot?.state === 'paused', restAudit);
    answer = await call(v1Resume.POST, 'POST', `/api/v1/api-keys/${target.id}/resume`, { id: target.id }, ownerKey.secret);
    check('v1 resume: active again', answer.status === 200 && answer.body.data?.state === 'active' && (await signIn(target.secret)).status === 200, answer.body);
    answer = await call(v1Pause.POST, 'POST', `/api/v1/api-keys/${target.id}/pause`, { id: target.id }, mias.secret);
    check('v1 pause: a key without api_keys.manage_all is refused', answer.status === 403, answer.body);
    answer = await call(v1Pause.POST, 'POST', `/api/v1/api-keys/${revoked.id}/pause`, { id: revoked.id }, ownerKey.secret);
    check('v1 pause: a revoked key is 409 key_revoked', answer.status === 409 && reason(answer) === 'key_revoked', answer.body);

    // --- Edit ---------------------------------------------------------------------------------
    const editKey = await s.key(s.mia, ['tasks.read', 'projects.read'], { name: 'Edit me' });
    let edit = await editApiKey(service, mia, editKey.id, { scopes: ['tasks.read', 'tasks.create'] });
    check('edit: adding a scope the member lacks is refused', edit.status === 422 && /Not available to you: Create tasks \(tasks\.create\)/.test(errorOf(edit)), edit);
    edit = await editApiKey(service, mia, editKey.id, { scopes: ['tasks.read'] });
    check('edit: removing a scope is allowed', edit.status === 200 && (await row(editKey.id)).scopes.join() === 'tasks.read', edit);
    // A key carrying a scope its member no longer holds: removing another scope still works, and it stays.
    const stale = await s.key(s.mia, ['tasks.read', 'tasks.create', 'projects.read']);
    edit = await editApiKey(service, mia, stale.id, { scopes: ['tasks.read', 'tasks.create'] });
    check('edit: removing works next to a scope the member no longer holds, which stays', edit.status === 200 && (await row(stale.id)).scopes.join() === 'tasks.read,tasks.create', edit);
    const ada = await person(s.ada);
    edit = await editApiKey(service, ada, editKey.id, { scopes: ['tasks.read', 'time.manage_own'] });
    check("edit: api_keys.manage_all cannot add what the editor does not hold, though the member does", edit.status === 422 && /Not available to you: .*time\.manage_own/.test(errorOf(edit)), edit);
    edit = await editApiKey(service, ada, editKey.id, { scopes: ['tasks.read', 'projects.read'] });
    check('edit: api_keys.manage_all adds what both hold', edit.status === 200, edit);
    const owner = await person(s.owner);
    edit = await editApiKey(service, owner, scoutKey.id, { scopes: ['tasks.read', 'meetings.write'] });
    check('edit: an agent key never gains a scope agents never carry', edit.status === 422 && /An agent key never carries: .*meetings\.write/.test(errorOf(edit)), edit);
    edit = await editApiKey(service, owner, scoutKey.id, { name: 'Scout harness', scopes: ['tasks.read', 'team.read'] });
    check('edit: an Owner widens an agent key within what the agent holds', edit.status === 200, edit);
    const editTrail = (await audits(scoutKey.id)).filter((t) => t.method === 'PATCH');
    check('audit: an edit has before and after, and what it added', editTrail.length === 1 && editTrail[0].before_snapshot?.scopes?.join() === 'tasks.read'
      && editTrail[0].after_snapshot?.scopes?.join() === 'tasks.read,team.read' && editTrail[0].after_snapshot?.name === 'Scout harness'
      && editTrail[0].request_body?.added?.join() === 'team.read' && editTrail[0].via === 'app', editTrail);
    edit = await editApiKey(service, await person(s.otto), editKey.id, { name: 'Mine' });
    check("edit: someone else's key is hidden (404)", edit.status === 404, edit);
    await pause(s.mia, editKey.id, true);
    edit = await editApiKey(service, mia, editKey.id, { name: 'Paused but renamed' });
    check('edit: a paused key can still be edited, and stays paused', edit.status === 200 && edit.body.data.state === 'paused', edit);
    await pause(s.mia, editKey.id, false);

    // Over v1: minting's rules for what is added.
    answer = await call(v1Edit.PATCH, 'PATCH', `/api/v1/api-keys/${scoutKey.id}`, { id: scoutKey.id }, ownerKey.secret, { scopes: ['tasks.read'] });
    check('v1 edit: removing a scope', answer.status === 200 && answer.body.data?.scopes?.join() === 'tasks.read' && answer.body.data?.state === 'active', answer.body);
    answer = await call(v1Edit.PATCH, 'PATCH', `/api/v1/api-keys/${scoutKey.id}`, { id: scoutKey.id }, adaKey.secret, { scopes: ['tasks.read', 'team.read'] });
    check("v1 edit: only an Owner's key adds to an agent's key", answer.status === 403 && reason(answer) === 'owner_only', answer.body);
    answer = await call(v1Edit.PATCH, 'PATCH', `/api/v1/api-keys/${adaKey.id}`, { id: adaKey.id }, adaKey.secret, { scopes: ['api_keys.manage_all', 'tasks.read', 'projects.read', 'team.read'] });
    check('v1 edit: a scope the calling key does not carry is 403 scope_escalation', answer.status === 403 && reason(answer) === 'scope_escalation', answer.body);
    answer = await call(v1Edit.PATCH, 'PATCH', `/api/v1/api-keys/${scoutKey.id}`, { id: scoutKey.id }, ownerKey.secret, { scopes: ['tasks.read', 'meetings.write'] });
    check('v1 edit: never a scope agents never carry', answer.status === 422 && reason(answer) === 'scope_never_for_agents', answer.body);
    answer = await call(v1Edit.PATCH, 'PATCH', `/api/v1/api-keys/${scoutKey.id}`, { id: scoutKey.id }, ownerKey.secret, { scopes: ['tasks.read', 'team.read'], name: 'Scout v2' });
    check("v1 edit: an Owner's key adds what it carries and the agent holds", answer.status === 200 && answer.body.data?.name === 'Scout v2', answer.body);
    const v1Trail = (await audits(scoutKey.id)).filter((t) => t.method === 'PATCH' && t.via === 'rest');
    check('v1 edit: audited with before and after', v1Trail.length === 2 && v1Trail[1].before_snapshot?.scopes?.join() === 'tasks.read' && v1Trail[1].after_snapshot?.scopes?.join() === 'tasks.read,team.read', v1Trail);
    answer = await call(v1Edit.PATCH, 'PATCH', `/api/v1/api-keys/${revoked.id}`, { id: revoked.id }, ownerKey.secret, { name: 'x' });
    check('v1 edit: a revoked key is 409', answer.status === 409 && reason(answer) === 'key_revoked', answer.body);
    answer = await call(v1Edit.PATCH, 'PATCH', `/api/v1/api-keys/${scoutKey.id}`, { id: scoutKey.id }, ownerKey.secret, {});
    check('v1 edit: an empty body is refused', answer.status >= 400 && answer.status < 500, answer.status);

    // --- A one-hour AI setup key stays as it was made -----------------------------------------
    const setupKey = await s.key(s.owner, ['tasks.read', 'team.read'], { setup: true, name: 'AI setup key' });
    const setupRow = await row(setupKey.id);
    edit = await editApiKey(service, owner, setupKey.id, { scopes: ['tasks.read'] });
    check('setup key: its scopes are not edited (409)', edit.status === 409 && /AI setup key/.test(errorOf(edit)), edit);
    edit = await editApiKey(service, owner, setupKey.id, { name: 'Renamed' });
    check('setup key: nor its name', edit.status === 409, edit);
    answer = await call(v1Edit.PATCH, 'PATCH', `/api/v1/api-keys/${setupKey.id}`, { id: setupKey.id }, ownerKey.secret, { name: 'Renamed' });
    check('setup key: v1 edit is 409 setup_key_fixed', answer.status === 409 && reason(answer) === 'setup_key_fixed', answer.body);
    result = await pause(s.owner, setupKey.id, true);
    check('setup key: not paused (409 setup_key_fixed)', !result.ok && result.status === 409 && result.reason === 'setup_key_fixed', result);
    await s.q('UPDATE pm.api_keys SET paused_at = now(), paused_by = $1 WHERE id = $2', [s.owner, setupKey.id]);
    result = await pause(s.owner, setupKey.id, false);
    check('setup key: not resumed either', !result.ok && result.status === 409 && result.reason === 'setup_key_fixed', result);
    await s.q('UPDATE pm.api_keys SET paused_at = NULL, paused_by = NULL WHERE id = $1', [setupKey.id]);
    const ownerSession = sessionCaller(s.owner, owner.access);
    const setupRotate = await rotateApiKey(service, { caller: ownerSession.caller, granter: ownerSession.granter, apiKeyId: null, endpoint: 'test', via: 'app' }, setupKey.id, {})
      .then(() => null, (e: Loose) => e.details?.reason);
    check('setup key: not rotated (409 setup_key_fixed), so no successor loses its limit', setupRotate === 'setup_key_fixed', setupRotate);
    const setupAfter = await row(setupKey.id);
    check('setup key: unchanged by the refused calls', setupAfter.name === setupRow.name && setupAfter.scopes.join() === setupRow.scopes.join() && setupAfter.key_hash === setupRow.key_hash
      && (await s.q('SELECT id FROM pm.api_keys WHERE rotated_from = $1', [setupKey.id])).length === 0, setupAfter);
    const { revokeKeyTree } = await import('../src/lib/api/key-revoke');
    const setupRevoked = await revokeKeyTree(service, setupKey.id, { memberId: s.owner, apiKeyId: null, endpoint: 'test', via: 'app' });
    check('setup key: revoking it is still allowed', setupRevoked[0] === setupKey.id && !!(await row(setupKey.id)).revoked_at, setupRevoked);

    // A key an AI setup session mints for an agent has no parent: the setup key's revoke never reaches it.
    const sessionKey = await s.key(s.owner, ['api_keys.manage_all', 'tasks.read', 'team.read'], { setup: true, name: 'AI setup key' });
    await s.q(`INSERT INTO pm.ai_setup_sessions (member_id, kind, api_key_id, client_name, scopes, expires_at)
      VALUES ($1, 'key', $2, 'AI setup key', $3, now() + interval '1 hour')`, [s.owner, sessionKey.id, ['api_keys.manage_all', 'tasks.read', 'team.read']]);
    const minted = await call(v1List.POST, 'POST', '/api/v1/api-keys', {}, sessionKey.secret, { member_id: s.scout, name: 'Scout via setup', scopes: ['tasks.read'] });
    const mintedId = minted.body.data?.key?.id as string;
    const lineageOf = async (id: string) => (await s.q<Loose>('SELECT created_by_key_id, revoked_at FROM pm.api_keys WHERE id = $1', [id]))[0];
    check('setup session: it mints a key for an agent', minted.status === 201 && !!mintedId, minted.body);
    check('setup session: the minted key does not hang off the setup key', !!mintedId && (await lineageOf(mintedId))?.created_by_key_id === null, mintedId && await lineageOf(mintedId));
    const plainMint = await call(v1List.POST, 'POST', '/api/v1/api-keys', {}, ownerKey.secret, { member_id: s.scout, name: 'Scout via key', scopes: ['tasks.read'] });
    check('a plain key still records the key that made it', (await lineageOf(plainMint.body.data?.key?.id))?.created_by_key_id === ownerKey.id, plainMint.body);
    await revokeKeyTree(service, sessionKey.id, { memberId: s.owner, apiKeyId: null, endpoint: 'test', via: 'app' });
    check("setup session: revoking the setup key leaves the agent's key working", !!mintedId && (await lineageOf(mintedId))?.revoked_at === null, mintedId && await lineageOf(mintedId));

    // --- Lists --------------------------------------------------------------------------------
    await pause(s.mia, stale.id, true);
    const listed = await listVisibleKeys(service, mia, null);
    const allIds = (await s.q<{ id: string }>("SELECT id FROM pm.api_keys WHERE (team_member_id = $1 OR created_by = $1) AND permissions <> 'connection'", [s.mia])).map((r) => r.id);
    check('list: a member sees their own keys, each with a state', listed.keys.length === allIds.length && listed.keys.every((k) => allIds.includes(k.id) && !!k.state), { got: listed.keys.length, want: allIds.length });
    check('list: counts every visible key by state', listed.counts.paused === 1 && listed.counts.revoked === 1 && listed.counts.expired === 1
      && listed.counts.active + listed.counts.paused + listed.counts.expired + listed.counts.revoked === listed.keys.length, listed.counts);
    const pausedOnly = await listVisibleKeys(service, mia, 'paused');
    check('list: ?state=paused narrows, counts stay whole', pausedOnly.keys.length === 1 && pausedOnly.keys[0].id === stale.id && pausedOnly.counts.paused === 1, pausedOnly.keys.map((k) => k.id));
    const ended = await listVisibleKeys(service, mia, 'ended');
    check('list: ended is expired and revoked', ended.keys.length === 2 && ended.keys.every((k) => k.state === 'expired' || k.state === 'revoked'), ended.keys.map((k) => k.state));
    check('list: Otto sees only his own (none)', (await listVisibleKeys(service, await person(s.otto), null)).keys.every((k) => k.team_member_id === s.otto || k.created_by === s.otto));

    // The database filter (v1) agrees with apiKeyState for every filter.
    const everyKey = (await call(v1List.GET, 'GET', '/api/v1/api-keys?include_revoked=true&limit=100', {}, ownerKey.secret)).body.data as Loose[];
    check('v1 list: every key has its state, matching apiKeyState', everyKey.length > 5 && everyKey.every((k) => k.state === apiKeyState(k)), everyKey.map((k) => k.state));
    for (const filter of API_KEY_STATE_FILTERS) {
      const page = await call(v1List.GET, 'GET', `/api/v1/api-keys?state=${filter}&limit=100`, {}, ownerKey.secret);
      const want = everyKey.filter((k) => keyMatchesState(k, filter)).map((k) => k.id).sort();
      const got = ((page.body.data ?? []) as Loose[]).map((k) => k.id).sort();
      check(`v1 list: ?state=${filter} matches apiKeyState`, page.status === 200 && JSON.stringify(got) === JSON.stringify(want) && page.body.meta?.total === want.length, { filter, got: got.length, want: want.length });
    }
    const memberPaused = await call(v1List.GET, 'GET', `/api/v1/api-keys?state=paused&member_id=${s.mia}`, {}, ownerKey.secret);
    check('v1 list: state and member_id together', memberPaused.body.data?.length === 1 && memberPaused.body.data[0].id === stale.id, memberPaused.body);
    const bad = await call(v1List.GET, 'GET', '/api/v1/api-keys?state=sleeping', {}, ownerKey.secret);
    check('v1 list: an unknown state is 400', bad.status === 400, bad.status);
    const live = await call(v1List.GET, 'GET', '/api/v1/api-keys?limit=100', {}, ownerKey.secret);
    check('v1 list: without state, live keys only as before', (live.body.data as Loose[]).every((k) => !k.revoked_at), live.body.data?.length);

    // --- A database before the migration ------------------------------------------------------
    await s.q('ALTER TABLE pm.api_keys DROP COLUMN paused_at, DROP COLUMN paused_by');
    check('older database: a key still signs in', (await signIn(mias.secret)).status === 200);
    const olderList = await call(v1List.GET, 'GET', '/api/v1/api-keys?state=active&limit=100', {}, ownerKey.secret);
    check('older database: lists still answer, nothing paused', olderList.status === 200 && (olderList.body.data as Loose[]).every((k) => k.state === 'active' && k.paused_at === null), olderList.body);
    const olderPaused = await call(v1List.GET, 'GET', '/api/v1/api-keys?state=paused', {}, ownerKey.secret);
    check('older database: ?state=paused is empty', olderPaused.status === 200 && olderPaused.body.data?.length === 0, olderPaused.body);
    check('older database: the visible list answers', (await listVisibleKeys(service, mia, null)).keys.length === allIds.length);
    result = await pause(s.mia, mias.id, true);
    check('older database: pausing answers 503 migration_pending', !result.ok && result.status === 503 && result.reason === 'migration_pending', result);
    edit = await editApiKey(service, mia, editKey.id, { name: 'Still editable' });
    check('older database: editing still works', edit.status === 200, edit);
    await db.exec(MIGRATION_SQL);
    await db.exec(MIGRATION_SQL);
    result = await pause(s.mia, mias.id, true);
    check('migration applied later: pausing works', result.ok && result.key.state === 'paused', result);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`Key management: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Key management: ${passed} checks passed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
