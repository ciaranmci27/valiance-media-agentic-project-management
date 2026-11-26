/**
 * Project agent fixes (the agents-in-projects audit), each check able to fail:
 * - The migration (20261127000400_project_agent_fixes.sql), run twice on
 *   the full schema, is mirrored at the end of schema.sql. Removing an
 *   agent's project membership removes its setup there; a person's
 *   membership or another project's setup is untouched. Pinning alone keeps
 *   an entry's updated_at; editing it stamps it.
 * - Who may change a setup on a project's Agents tab is the server's rule:
 *   Owners, project_members.manage and team.manage edit every row; an
 *   agent's owners (in person or through a group) edit theirs; nobody else.
 * - A setup is checked before its PUT: a required setting left empty answers
 *   errors and nothing is sent.
 * - "Written by an agent" clears when a person edits an entry or marks it
 *   checked (the rule, and updateBriefEntry over a fake PostgREST); an
 *   agent's own edit leaves it.
 * - Project setup keeps the creator: the screen keeps them on, and the
 *   server refuses a signed-in person without projects.read_all who leaves
 *   themselves out.
 * - Pinned reach: the screens' limits are the server's caps; the newest 5
 *   pinned reach agents and the rest are named.
 * - Settings errors under a field no longer repeat its label.
 * - Group usage reads what a group controls; adding with only_new keeps a
 *   lead a lead.
 *
 *   npm run -s test:project-agent-fixes
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import type { AccessContext } from '../src/lib/access-control';
import {
  briefEntryChanges, canEditAssignment, editsEveryAssignment, ownsAgent, pinnedReach, pinnedReachLine, PINNED_REACH, setupMembers, submitAssignment,
  type AssignmentBody,
} from '../src/lib/project-agents-ui';
import { settingsErrorFields, validateTemplateSettings, type SettingsField } from '../src/lib/project-agents';
import { groupUsagePhrases } from '../src/lib/groups';

const MIGRATION = '20261127000400_project_agent_fixes.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 800)}`);
}

const access = (role: AccessContext['role'], permissions: string[], memberId = 'm-1'): AccessContext => ({
  member_id: memberId, role, status: 'active', app_permissions: permissions as AccessContext['app_permissions'], api_permissions: permissions as AccessContext['api_permissions'], project_ids: [],
});

async function pureChecks() {
  // --- Who edits a setup ------------------------------------------------------------------
  const plain = { isOwner: false, manageMembers: false, manageTeam: false, memberId: 'me' };
  const agentOwnedByGroup = { owners: [{ id: 'someone-else' }], owner_groups: [{ id: 'g-finance' }] };
  const agentOwnedByMe = { owners: [{ id: 'me' }], owner_groups: [] };
  const agentOfOthers = { owners: [{ id: 'someone-else' }], owner_groups: [{ id: 'g-other' }] };
  check('edit: a member of an owning group edits that agent\'s rows', canEditAssignment(plain, agentOwnedByGroup, ['g-finance']));
  check('edit: an owner in person edits their agent\'s rows', canEditAssignment(plain, agentOwnedByMe, []));
  check('edit: team.manage edits every row', canEditAssignment({ ...plain, manageTeam: true }, agentOfOthers, []) && editsEveryAssignment({ ...plain, manageTeam: true }));
  check('edit: project_members.manage edits every row', canEditAssignment({ ...plain, manageMembers: true }, agentOfOthers, []));
  check('edit: an Owner edits every row', canEditAssignment({ ...plain, isOwner: true }, undefined, []));
  check('edit: anyone else edits nothing', !canEditAssignment(plain, agentOfOthers, ['g-finance']) && !canEditAssignment(plain, undefined, ['g-finance']));
  check('edit: a group the viewer left owns nothing for them', !ownsAgent(plain, agentOwnedByGroup, []));

  // --- Required settings before the PUT ---------------------------------------------------
  const schema: SettingsField[] = [
    { key: 'repo', label: 'Repository', type: 'text', required: true },
    { key: 'branch', label: 'Branch', type: 'text', default: 'dev' },
  ];
  const sent: AssignmentBody[] = [];
  const save = async (body: AssignmentBody) => { sent.push(body); };
  const missing = await submitAssignment({ templateKey: 'builder', schema, settings: { branch: 'dev' }, instructions: '' }, save);
  check('setup: a required setting left empty is refused before anything is sent', !!missing.repo && sent.length === 0, { missing, sent });
  check('setup: the error reads under its field, without the label', missing.repo === 'Fill this in.', missing);
  const ok = await submitAssignment({ templateKey: 'builder', schema, settings: { repo: 'acme/site', branch: '' }, instructions: ' Ask first. ', status: 'paused' }, save);
  check('setup: a filled draft is sent once, cleaned and with its status', Object.keys(ok).length === 0 && sent.length === 1
    && sent[0].template_key === 'builder' && sent[0].settings.repo === 'acme/site' && !('branch' in sent[0].settings) && sent[0].instructions === 'Ask first.' && sent[0].status === 'paused', sent);

  // --- Settings errors keep their label out of a field -------------------------------------
  const typed = validateTemplateSettings([{ key: 'cap', label: 'Daily cap', type: 'number', min: 1 }], { cap: 0 });
  const fields = typed.ok ? {} : settingsErrorFields(typed.errors);
  check('settings: a field error does not repeat the label', !!fields.cap && !fields.cap.includes('Daily cap') && /^Must be at least 1/.test(fields.cap), fields);
  check('settings: the whole message still names the field', !typed.ok && typed.errors[0].message.startsWith('Daily cap:'));

  // --- "Written by an agent" clears ---------------------------------------------------------
  const agentEntry = { section: 'rules', category: 'constraint', source: 'agent' };
  check('brief: a person editing an agent\'s entry takes it over', briefEntryChanges(agentEntry, { content: 'Fixed' }, false).source === 'human');
  check('brief: a person marking it checked takes it over', briefEntryChanges(agentEntry, { checked: true }, false).source === 'human');
  check('brief: an agent editing its own entry leaves it marked', !('source' in briefEntryChanges(agentEntry, { content: 'Again' }, true)));
  check('brief: pinning alone leaves who wrote it', !('source' in briefEntryChanges(agentEntry, { pinned: true }, false)));

  // --- Setup keeps the creator ---------------------------------------------------------------
  const kept = setupMembers(['p-2'], 'me', false);
  check('setup: without seeing every project, the creator stays on it', kept.locked && kept.memberIds.includes('me') && kept.memberIds.includes('p-2'), kept);
  const warned = setupMembers(['p-2'], 'me', true);
  check('setup: who sees every project may leave, and is warned', !warned.locked && !warned.memberIds.includes('me') && !!warned.warning, warned);
  const { refuseCreatorLockout } = await import('../src/lib/api/project-setup');
  const member = { memberId: 'me', access: access('member', ['project_members.manage', 'projects.manage'], 'me'), scopes: null };
  let refused: unknown = null;
  try { refuseCreatorLockout(member, { member_ids: ['p-2'] }, []); } catch (error) { refused = error; }
  check('setup: the server refuses a creator who leaves themselves out', (refused as { statusCode?: number; details?: { reason?: string } })?.statusCode === 422
    && (refused as { details?: { reason?: string } }).details?.reason === 'creator_not_member', refused);
  let passedSelf = true;
  try {
    refuseCreatorLockout(member, { member_ids: ['p-2', 'me'] }, []);
    refuseCreatorLockout({ ...member, access: access('member', ['project_members.manage', 'projects.read_all'], 'me') }, { member_ids: ['p-2'] }, []);
    refuseCreatorLockout({ ...member, scopes: ['projects.manage', 'project_members.manage'] }, { member_ids: ['p-2'] }, []);
  } catch { passedSelf = false; }
  check('setup: on it, seeing every project, or over the API, it goes through', passedSelf);

  // --- Pinned reach ---------------------------------------------------------------------------
  const { PACK_LIMITS } = await import('../src/lib/api/agent-context');
  const { SCOPED_PINNED_LIMITS } = await import('../src/lib/api/context-scopes');
  check('reach: the screens\' limits are the server\'s caps', PACK_LIMITS.pinnedPerProject === PINNED_REACH.perScope && PACK_LIMITS.pinnedEntry === PINNED_REACH.entry
    && SCOPED_PINNED_LIMITS.perScope === PINNED_REACH.perScope && SCOPED_PINNED_LIMITS.entry === PINNED_REACH.entry);
  const day = (n: number) => new Date(Date.UTC(2026, 10, n)).toISOString();
  const pins = Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, pinned: true, updated_at: day(i + 1), content: i === 6 ? 'x'.repeat(600) : 'short' }));
  const reach = pinnedReach([...pins, { id: 'loose', pinned: false, updated_at: day(20), content: 'not pinned' }]);
  check('reach: the newest 5 pinned reach agents, the 2 oldest are named as past it', reach.reaching.size === 5 && reach.beyond.size === 2
    && reach.beyond.has('e0') && reach.beyond.has('e1') && !reach.reaching.has('loose'), { reaching: [...reach.reaching], beyond: [...reach.beyond] });
  check('reach: a long reaching entry is named as cut', reach.cut.has('e6') && reach.cut.size === 1);
  check('reach: the header says 5 of 7', pinnedReachLine(7) === `5 of 7 pinned reach agents; they find the rest by search` && pinnedReachLine(3)?.startsWith('3 pinned') === true);

  // --- Group usage in words -----------------------------------------------------------------
  const none = { total: 0, names: [] };
  const phrases = groupUsagePhrases({ owns_agents: { total: 2, names: ['Atlas', 'Scout'] }, escalations: none, inboxes: { total: 4, names: ['A', 'B', 'C', 'D'] }, initiatives: none, assistant_setups: none });
  check('groups: what members do through a group, in words', phrases.join('|') === 'manage the agents Atlas and Scout|handle 4 inboxes', phrases);
}

async function databaseChecks() {
  const banner = SCHEMA_SQL.indexOf(`-- PROJECT AGENT FIXES (${MIGRATION})`);
  check('schema.sql: the migration is mirrored at its end', banner > 0 && SCHEMA_SQL.slice(banner).includes(MIGRATION_SQL.trim()));

  const db = await createFullSchemaDatabase();
  await db.exec(MIGRATION_SQL);
  await db.exec(MIGRATION_SQL);
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params))[0].id;

  const person = await one("INSERT INTO pm.team_members (name, email, role) VALUES ('Morgan', 'morgan@example.com', 'member') RETURNING id");
  const agent = await one("INSERT INTO pm.team_members (name, email, role) VALUES ('Atlas', 'atlas@agent.local', 'agent') RETURNING id");
  const acme = await one("INSERT INTO pm.projects (name) VALUES ('Acme') RETURNING id");
  const other = await one("INSERT INTO pm.projects (name) VALUES ('Other') RETURNING id");
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2), ($1, $3), ($4, $3)', [acme, person, agent, other]);
  await q("INSERT INTO pm.project_agents (project_id, agent_id, status) VALUES ($1, $2, 'paused'), ($3, $2, 'active')", [acme, agent, other]);
  const setups = async (project: string) => (await q<{ n: number }>('SELECT count(*)::int AS n FROM pm.project_agents WHERE project_id = $1 AND agent_id = $2', [project, agent]))[0].n;

  await q('DELETE FROM pm.project_members WHERE project_id = $1 AND member_id = $2', [acme, person]);
  check('trigger: a person leaving touches no setup', (await setups(acme)) === 1);
  await q('DELETE FROM pm.project_members WHERE project_id = $1 AND member_id = $2', [acme, agent]);
  check('trigger: the agent taken off the project loses its setup there (pause and all)', (await setups(acme)) === 0);
  check('trigger: its setup on another project stays', (await setups(other)) === 1);

  const callable = (await q<{ allowed: boolean }>("SELECT has_function_privilege('authenticated', 'pm.end_project_agent_on_member_removed()', 'EXECUTE') AS allowed"))[0].allowed;
  check('trigger: its function is not callable by signed-in people', callable === false);

  const entry = await one(`INSERT INTO pm.project_context (project_id, category, section, content, source)
    VALUES ($1, 'constraint', 'rules', 'Never deploy on Fridays', 'agent') RETURNING id`, [other]);
  // An old date, set with the trigger off (it would stamp the update itself).
  await q('ALTER TABLE pm.project_context DISABLE TRIGGER set_project_context_updated_at');
  await q("UPDATE pm.project_context SET updated_at = '2024-01-01T00:00:00Z' WHERE id = $1", [entry]);
  await q('ALTER TABLE pm.project_context ENABLE TRIGGER set_project_context_updated_at');
  const stamp = async () => (await q<{ at: string }>("SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS at FROM pm.project_context WHERE id = $1", [entry]))[0].at;
  await q('UPDATE pm.project_context SET pinned = true WHERE id = $1', [entry]);
  check('freshness: pinning an old entry keeps its date', (await stamp()) === '2024-01-01', await stamp());
  await q('UPDATE pm.project_context SET pinned = false WHERE id = $1', [entry]);
  check('freshness: unpinning keeps it too', (await stamp()) === '2024-01-01');
  await q("UPDATE pm.project_context SET content = 'Never deploy on Fridays or holidays' WHERE id = $1", [entry]);
  check('freshness: editing the words stamps it', (await stamp()) !== '2024-01-01');

  // --- The server, over a fake PostgREST --------------------------------------------------
  const server = await startFakePostgrest(db);
  try {
    const { createPmClient } = await import('../src/lib/supabase/pm-client');
    const service = createPmClient(server.url, 'fake-service-key');
    const { updateBriefEntry, readBrief } = await import('../src/lib/api/project-brief');
    const owner = await one("INSERT INTO pm.team_members (name, email, role) VALUES ('Olivia', 'olivia@example.com', 'owner') RETURNING id");
    const ownerCaller = { memberId: owner, access: access('owner', ['*'], owner), scopes: null };
    const agentCaller = { memberId: agent, access: { ...access('agent', ['projects.read', 'project_context.read', 'project_context.manage'], agent), project_ids: [other] }, scopes: ['projects.read', 'project_context.read', 'project_context.manage'] };

    const byAgent = await updateBriefEntry(service, agentCaller, other, entry, { content: 'Never deploy on Fridays, or on holidays' });
    check('server: an agent\'s own edit keeps "Written by an agent"', byAgent.entry.source === 'agent', byAgent.entry);
    const brief = await readBrief(service, ownerCaller, other);
    check('server: the brief counts agent-written entries across the whole brief', brief.agent_total === 1 && brief.pinned_total === 0, { agent: brief.agent_total, pinned: brief.pinned_total });
    const checked = await updateBriefEntry(service, ownerCaller, other, entry, { checked: true });
    check('server: a person marking it checked clears the flag', checked.entry.source === 'human', checked.entry);
    await q("UPDATE pm.project_context SET source = 'agent' WHERE id = $1", [entry]);
    const edited = await updateBriefEntry(service, ownerCaller, other, entry, { content: 'No deploys on Fridays.' });
    check('server: a person editing it clears the flag', edited.entry.source === 'human', edited.entry);

    // Groups: usage, and adding without demoting a lead.
    const { addGroupMembers, groupUsage } = await import('../src/lib/api/groups');
    const group = await one("INSERT INTO pm.groups (name, slug) VALUES ('Engineering', 'engineering') RETURNING id");
    await q("INSERT INTO pm.group_members (group_id, member_id, role) VALUES ($1, $2, 'lead')", [group, person]);
    await q('INSERT INTO pm.agent_owner_groups (agent_id, group_id) VALUES ($1, $2)', [agent, group]);
    const usage = await groupUsage(service, ownerCaller, group);
    check('groups: usage names the agents a group owns', usage.owns_agents.total === 1 && usage.owns_agents.names[0] === 'Atlas', usage);
    const kept = await addGroupMembers(service, ownerCaller, group, { member_ids: [person], role: 'member', only_new: true });
    const role = (await q<{ role: string }>('SELECT role FROM pm.group_members WHERE group_id = $1 AND member_id = $2', [group, person]))[0].role;
    check('groups: only_new keeps a lead a lead', kept.updated.length === 0 && role === 'lead', { kept, role });
    await addGroupMembers(service, ownerCaller, group, { member_ids: [person], role: 'member' });
    const changed = (await q<{ role: string }>('SELECT role FROM pm.group_members WHERE group_id = $1 AND member_id = $2', [group, person]))[0].role;
    check('groups: without only_new the role sent applies, as before', changed === 'member');
  } finally {
    await server.close();
    await db.close();
  }
}

async function main() {
  await pureChecks();
  await databaseChecks();
  if (failures.length) {
    console.error(`project agent fixes: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`project agent fixes: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
