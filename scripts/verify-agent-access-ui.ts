/**
 * The agent page's Access tab, its keys and key hygiene (AI home H2):
 *
 * - What it may do is ONE list (lib/api/agent-powers.ts): its live keys'
 *   scopes and the powers given to it on its own, merged; saving puts the
 *   list on every live key and takes away an own power left out, so a key
 *   never lacks what the agent was given and the agent never keeps a power
 *   no key shows. An Owner adds a power the role lacks (given to the agent
 *   first); a non-owner key manager cannot, nor take away what an Owner gave.
 *   Personal assistants, suspended agents and agents with no key are refused.
 *   Over v1 too, with minting's rules.
 * - Revoke unused keys (lib/api/key-hygiene.ts): the preview lists keys
 *   never used (made over a day ago) or unused for 90 days among keys you
 *   manage; the revoke takes only ids from the preview that are still
 *   unused (a key used since is skipped). Never the calling key.
 * - Pure rules: the merge and its plan, unused keys, "already has a key",
 *   the audience picker lists, orchestrator choices (no loops), the hire
 *   branches and the gentle orchestrator suggestion, the orchestrator template.
 * - A confirm asks once (ConfirmDialog has no second step, A24).
 *
 *   npm run -s test:agent-access-ui
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import {
  audienceFromLists, audienceLists, COMPANY_HIRE_STEPS, hireStepsFor, isLivePowerKey, liveKeyOf, mergedPowers, orchestratorChoices, orchestratorSuggestion,
  keyTabOf, personalHireState, pickIncludes, powersCountWords, powersOutOfStep, powersPlan, REPLACE_OVERLAP_HOURS, unusedKeys, unusedReason, worksForWords,
} from '../src/lib/agent-access-ui';
import { CORE_AGENT_TEMPLATES } from '../src/lib/agent-templates';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;

const NOW = Date.parse('2026-11-27T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ── Pure rules ──────────────────────────────────────────────────────────

function pureChecks() {
  const keyA = { id: 'a', scopes: ['tasks.read', 'projects.read'] };
  const keyB = { id: 'b', scopes: ['tasks.read'], expires_at: iso(NOW + DAY) };
  const ended = { id: 'c', scopes: ['files.manage'], expires_at: iso(NOW - 1) };
  const revoked = { id: 'd', scopes: ['team.manage'], revoked_at: iso(NOW - DAY) };
  const setup = { id: 'e', scopes: ['agents.manage'], key_prefix: 'pk_setup_abc' };

  check('merge: live keys and own powers make one list', mergedPowers([keyA, keyB], ['agents.act_for'], NOW).join() === 'agents.act_for,projects.read,tasks.read');
  check('merge: ended, revoked and AI setup keys add nothing', mergedPowers([ended, revoked, setup], [], NOW).length === 0, mergedPowers([ended, revoked, setup], [], NOW));
  check('merge: a power given in Team but on no key shows in the list', mergedPowers([keyA], ['agents.act_for'], NOW).includes('agents.act_for'));
  check('out of step: a key lacking an own power', powersOutOfStep([keyA], ['agents.act_for'], NOW));
  check('out of step: two keys that differ', powersOutOfStep([keyA, keyB], [], NOW));
  check('in step: one key, nothing else given', !powersOutOfStep([keyA], ['tasks.read'], NOW));
  const plan = powersPlan([keyA, keyB, ended], ['agents.act_for', 'tasks.read'], ['tasks.read', 'projects.read', 'tasks.read'], NOW);
  check('plan: the list deduplicated and sorted', plan.scopes.join() === 'projects.read,tasks.read', plan);
  check('plan: only live keys that differ change', plan.keysToChange.join() === 'b', plan);
  check('plan: an own power left out is taken away', plan.ownToRemove.join() === 'agents.act_for', plan);
  check('live key: paused counts, ended does not', isLivePowerKey({ id: 'p', scopes: [], paused_at: iso(NOW) } as Loose, NOW) && !isLivePowerKey(ended, NOW));
  check('words: plain count', powersCountWords(0) === 'Can do nothing yet' && powersCountWords(1) === 'Can do 1 thing' && powersCountWords(7) === 'Can do 7 things');

  check('developers tabs: active, paused, and revoked or ended', keyTabOf({ revoked_at: null }, NOW) === 'active' && keyTabOf({ revoked_at: null, paused_at: iso(NOW) }, NOW) === 'paused'
    && keyTabOf({ revoked_at: iso(NOW) }, NOW) === 'revoked' && keyTabOf({ revoked_at: null, expires_at: iso(NOW - 1), paused_at: iso(NOW) }, NOW) === 'revoked');

  // Already has a key: Replace instead.
  check('already has a key: the live one is found', liveKeyOf([ended, revoked, keyA], NOW)?.id === 'a');
  check('already has a key: none when every key ended', liveKeyOf([ended, revoked, setup], NOW) === null);
  check('replace: a short overlap', REPLACE_OVERLAP_HOURS >= 1 && REPLACE_OVERLAP_HOURS <= 2);

  // Unused keys.
  const k = (fields: Loose) => ({ id: randomUUID(), created_at: iso(NOW - 200 * DAY), ...fields });
  const neverOld = k({ last_used_at: null });
  const neverNew = k({ created_at: iso(NOW - 3_600_000), last_used_at: null });
  const stale = k({ last_used_at: iso(NOW - 91 * DAY) });
  const recent = k({ last_used_at: iso(NOW - 89 * DAY) });
  const connection = k({ last_used_at: null, permissions: 'connection' });
  const setupKey = k({ last_used_at: null, key_prefix: 'pk_setup_x' });
  const revokedOld = k({ last_used_at: null, revoked_at: iso(NOW - DAY) });
  const pausedStale = k({ last_used_at: iso(NOW - 120 * DAY), paused_at: iso(NOW - DAY) });
  check('unused: never used, made long ago', unusedReason(neverOld, NOW) === 'never_used');
  check('unused: a key made an hour ago is not caught', unusedReason(neverNew, NOW) === null);
  check('unused: 91 days since its last use', unusedReason(stale, NOW) === 'stale');
  check('unused: 89 days is still in use', unusedReason(recent, NOW) === null);
  check('unused: never a connection, setup or revoked key', [connection, setupKey, revokedOld].every((key) => unusedReason(key, NOW) === null));
  check('unused: a paused key counts', unusedReason(pausedStale, NOW) === 'stale');
  const list = unusedKeys([recent, neverOld, stale, connection, pausedStale], NOW);
  check('unused: the list, oldest use first', list.map((key) => key.id).join() === [neverOld.id, pausedStale.id, stale.id].join(), list.map((key) => key.unused));

  // Audience lists.
  check('audience: nothing picked is no rows (today\'s behaviour)', audienceFromLists([], []).length === 0);
  check('audience: Everyone beside a group is everyone', audienceFromLists(['everyone', 'group:g1'], []).length === 0);
  const entries = audienceFromLists(['role:admin', 'group:g1'], ['member:m1', 'everyone']);
  check('audience: includes and an Except list, never "except everyone"', JSON.stringify(entries) === JSON.stringify([
    { kind: 'role', ref: 'admin', effect: 'include' }, { kind: 'group', ref: 'g1', effect: 'include' }, { kind: 'member', ref: 'm1', effect: 'exclude' },
  ]), entries);
  check('audience: one in both lists stays only in Except', JSON.stringify(audienceFromLists(['member:m1', 'group:g1'], ['member:m1'])) === JSON.stringify([
    { kind: 'group', ref: 'g1', effect: 'include' }, { kind: 'member', ref: 'm1', effect: 'exclude' },
  ]));
  check('audience picker: picking a group takes Everyone away', pickIncludes([], ['everyone', 'group:g1']).join() === 'group:g1');
  check('audience picker: picking Everyone clears the rest', pickIncludes(['group:g1'], ['group:g1', 'everyone']).length === 0);
  check('audience picker: removing the last one means everyone', pickIncludes(['group:g1'], []).length === 0);
  const lists = audienceLists(entries);
  check('audience: lists round trip', lists.include.join() === 'role:admin,group:g1' && lists.exclude.join() === 'member:m1', lists);

  // Orchestrator choices: never itself or one under it.
  const agents = [
    { id: 'alexa', orchestrator_id: null }, { id: 'dev', orchestrator_id: 'alexa' }, { id: 'junior', orchestrator_id: 'dev' },
    { id: 'free', orchestrator_id: null }, { id: 'pip', orchestrator_id: null, personal: true },
  ];
  check('works for: Dev may not work for itself or Junior (a loop), nor a personal assistant', orchestratorChoices(agents, 'dev').map((a) => a.id).join() === 'alexa,free');
  check('works for: Alexa may work for no one under her', orchestratorChoices(agents, 'alexa').map((a) => a.id).join() === 'free');
  check('works for: the line names no skipping levels', /No skipping levels/.test(worksForWords('Junior', 'Dev', 0)) && /at the top/.test(worksForWords('Alexa', null, 2)));

  // Hire branches.
  check('hire: company path is template, works for, who can use it, what it may do, connect, try it',
    ['template', 'team', 'audience', 'powers', 'connect', 'done'].every((key) => COMPANY_HIRE_STEPS.some((s) => s.key === key)) && COMPANY_HIRE_STEPS.at(-1)?.key === 'done');
  check('hire: personal path is for whom, connect chat, try it', hireStepsFor('personal').map((s) => s.key).join() === 'person,chat,done');
  check('hire: second company agent and nobody under an orchestrator: suggest one', !!orchestratorSuggestion([{ orchestrator_id: null }], 'builder'));
  check('hire: no suggestion for the first agent', orchestratorSuggestion([], 'builder') === null);
  check('hire: no suggestion once a team exists', orchestratorSuggestion([{ orchestrator_id: null, report_count: 1 }, { orchestrator_id: 'x' }], 'builder') === null);
  check('hire: no suggestion while hiring the orchestrator', orchestratorSuggestion([{ orchestrator_id: null }], 'orchestrator') === null);
  check('hire: personal, already has one', personalHireState('p1', 'Ana', [{ delegate_of: 'p1', name: "Ana's Assistant", id: 'x' }]).existing?.id === 'x');
  check('hire: personal, ready', personalHireState('p2', 'Ben', [{ delegate_of: 'p1', name: "Ana's Assistant", id: 'x' }]).ready);

  // The orchestrator template.
  const orchestrator = CORE_AGENT_TEMPLATES.find((t) => t.key === 'orchestrator');
  check('template: an Orchestrator template exists', !!orchestrator);
  check('template: it routes work and asks people one short question', !!orchestrator && /route|hand/i.test(orchestrator.context ?? '') && /one short question/i.test(orchestrator.context ?? ''));
  check('template: it does not pick up unassigned work on its own and can delegate and ask', !!orchestrator && orchestrator.rules?.agent_self_assign === false
    && ['tasks.create', 'team.read', 'questions.ask'].every((scope) => (orchestrator.scopes as readonly string[]).includes(scope)));
}

// ── One confirm (A24) ───────────────────────────────────────────────────

async function confirmChecks() {
  const source = readFileSync(join(__dirname, '..', 'src', 'components', 'ui', 'ConfirmDialog.tsx'), 'utf8');
  check('confirm: no second "Are you absolutely sure?" step', !/absolutely sure/i.test(source) && !/setStep\(2\)/.test(source));
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ConfirmDialog } = await import('../src/components/ui/ConfirmDialog');
  const html = renderToStaticMarkup(createElement(ConfirmDialog, { isOpen: true, onClose: () => {}, onConfirm: () => {}, title: 'Revoke this key?', message: 'It stops at once.', confirmLabel: 'Revoke', variant: 'danger' }));
  check('confirm: a danger confirm shows its own question and action', html.includes('Revoke this key?') && html.includes('>Revoke<'), html.slice(0, 400));
}

// ── Chat setup (C10) ────────────────────────────────────────────────────

async function chatChecks() {
  const { telegramLink, connectionStatus } = await import('../src/components/settings/assistants/ChatConnectionsSection');
  check('chat: the waiting step opens the bot in Telegram', telegramLink('@acme_bot') === 'https://t.me/acme_bot' && telegramLink('acme_bot') === 'https://t.me/acme_bot');
  check('chat: no button for a handle that is not a Telegram username', telegramLink(null) === null && telegramLink('@a b') === null && telegramLink('javascript:x') === null);
  const waiting = connectionStatus({ provider: 'telegram', kind: 'personal', enabled: true, last_inbound_at: null, last_verified_at: null, auth_failed_at: null, agents: [] } as Loose);
  check('chat: a waiting Telegram bot reads as the next step, never "Nothing yet"', waiting.label === 'One step left' && !/nothing yet|waiting for first/i.test(waiting.label), waiting);
}

// ── The server ──────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await q("INSERT INTO pm.business_settings (business_name) SELECT 'Acme' WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)");
  await q('UPDATE pm.workspace_modules SET enabled = true');
  const member = async (name: string, role: string, extra: Record<string, string | null> = {}) => {
    const cols = Object.keys(extra);
    return (await q<{ id: string }>(`INSERT INTO pm.team_members (name, email, role${cols.map((c) => `, ${c}`).join('')}) VALUES ($1, $2, $3${cols.map((_, i) => `, $${i + 4}`).join('')}) RETURNING id`,
      [name, `${name.toLowerCase()}@example.com`, role, ...Object.values(extra)]))[0].id;
  };
  const owner = await member('Olivia', 'owner');
  const admin = await member('Ada', 'admin');
  const ana = await member('Ana', 'member');
  const alexa = await member('Alexa', 'agent');
  const nokey = await member('Quiet', 'agent');
  const gone = await member('Gone', 'agent', { status: 'suspended' });
  const pip = await member('Pip', 'agent', { delegate_of: ana, assistant_template: 'personal-assistant' });
  const grant = async (memberId: string, permission: string, channel = 'api', withKey = false) =>
    q('INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect, given_with_key) VALUES ($1, $2, $3, \'allow\', $4) ON CONFLICT DO NOTHING', [memberId, permission, channel, withKey]);
  // Ada manages every key but is not an Owner.
  await grant(admin, 'api_keys.manage_all', 'app');
  await grant(admin, 'api_keys.manage_all', 'api');
  const key = async (memberId: string, scopes: string[], fields: { name?: string; createdBy?: string; lastUsed?: string | null; created?: string; madeByKey?: string } = {}) => {
    const value = `pk_live_${randomUUID().replace(/-/g, '')}`;
    const id = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions, last_used_at, created_at, created_by_key_id)
      VALUES ($1, 'pk_live', $2, $3, $4, $5, 'scoped', $6, COALESCE($7::timestamptz, now()), $8) RETURNING id`,
    [fields.name ?? 'Key', createHash('sha256').update(value).digest('hex'), memberId, fields.createdBy ?? owner, scopes, fields.lastUsed ?? null, fields.created ?? null, fields.madeByKey ?? null]))[0].id;
    return { id, value };
  };
  return { q, owner, admin, ana, alexa, nokey, gone, pip, grant, key };
}

async function serverChecks() {
  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });
  try {
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getAgentPowers, setAgentPowers } = await import('../src/lib/api/agent-powers');
    const { revokeUnusedKeys } = await import('../src/lib/api/key-hygiene');
    const v1Powers = await import('../src/app/api/v1/agents/[id]/powers/route');
    const v1Unused = await import('../src/app/api/v1/api-keys/revoke-unused/route');
    const service = getServiceClient();
    const caller = async (memberId: string) => {
      const access = await resolveMemberAccess(service, memberId);
      if (!access) throw new Error(`no access for ${memberId}`);
      return { memberId, access, scopes: null };
    };
    const refusal = async (run: () => Promise<unknown>) => {
      try { await run(); return null; } catch (error) { return error as Loose; }
    };
    const keyScopes = async (id: string) => (await s.q<{ scopes: string[] }>('SELECT scopes FROM pm.api_keys WHERE id = $1', [id]))[0].scopes.slice().sort();
    const allows = async (memberId: string) => (await s.q<{ permission_key: string }>("SELECT permission_key FROM pm.team_member_permissions WHERE member_id = $1 AND access_channel = 'api' AND effect = 'allow' ORDER BY permission_key", [memberId])).map((r) => r.permission_key);

    // Alexa: two live keys that differ, and Act for a person given in Team (by an Owner, not with a key).
    const alexaKey1 = await s.key(s.alexa, ['tasks.read', 'projects.read']);
    const alexaKey2 = await s.key(s.alexa, ['tasks.read']);
    await s.grant(s.alexa, 'agents.act_for');
    const ownerCaller = await caller(s.owner);
    const before = await getAgentPowers(service, ownerCaller, s.alexa);
    check('powers: one list merges both keys and the Team grant', before.scopes.join() === 'agents.act_for,projects.read,tasks.read', before.scopes);
    check('powers: out of step is reported', before.out_of_step === true && before.can_edit === true && before.can_give_beyond_role === true, before);

    // Saving lines every key up with the list: no key lacks what the agent was given.
    const saved = await setAgentPowers(service, ownerCaller, s.alexa, { scopes: ['tasks.read', 'projects.read', 'agents.act_for'] });
    check('save: every live key carries the whole list', (await keyScopes(alexaKey1.id)).join() === 'agents.act_for,projects.read,tasks.read'
      && (await keyScopes(alexaKey2.id)).join() === 'agents.act_for,projects.read,tasks.read', [await keyScopes(alexaKey1.id), await keyScopes(alexaKey2.id)]);
    check('save: now in step', saved.out_of_step === false, saved);

    // Taking a power off the list takes it from the keys and from the agent: no power without a key showing it.
    await setAgentPowers(service, ownerCaller, s.alexa, { scopes: ['tasks.read', 'projects.read'] });
    check('save: a power left out leaves every key', (await keyScopes(alexaKey1.id)).join() === 'projects.read,tasks.read' && (await keyScopes(alexaKey2.id)).join() === 'projects.read,tasks.read');
    check('save: and the agent loses the Team grant too', !(await allows(s.alexa)).includes('agents.act_for'), await allows(s.alexa));

    // An Owner adds a power the agent's role lacks: given to the agent and put on its keys.
    await setAgentPowers(service, ownerCaller, s.alexa, { scopes: ['tasks.read', 'projects.read', 'files.manage'] });
    check('save: an Owner gives a power beyond the role, on the agent and on its keys', (await allows(s.alexa)).includes('files.manage') && (await keyScopes(alexaKey2.id)).includes('files.manage'));

    // Ada manages every key but is no Owner: she may remove a key's grant, never add beyond the role or take away an Owner's.
    const adaCaller = await caller(s.admin);
    const adaAdds = await refusal(() => setAgentPowers(service, adaCaller, s.alexa, { scopes: ['tasks.read', 'projects.read', 'files.manage', 'agents.act_for'] }));
    check('save: a non-owner cannot give a power beyond the role', adaAdds?.statusCode === 403 || adaAdds?.statusCode === 422, adaAdds?.message);
    check('save: a refused save changed no key', (await keyScopes(alexaKey1.id)).join() === 'files.manage,projects.read,tasks.read', await keyScopes(alexaKey1.id));
    await s.grant(s.alexa, 'contacts.read');
    const adaTakes = await refusal(() => setAgentPowers(service, adaCaller, s.alexa, { scopes: ['tasks.read', 'projects.read', 'files.manage'] }));
    check('save: a non-owner cannot take away what an Owner gave', adaTakes?.statusCode === 403 && adaTakes?.details?.reason === 'scope_needs_owner', adaTakes?.details);
    const adaRemoves = await setAgentPowers(service, adaCaller, s.alexa, { scopes: ['tasks.read', 'projects.read', 'contacts.read'] });
    check('save: a non-owner key manager removes a key\'s grant', !(await allows(s.alexa)).includes('files.manage') && adaRemoves.scopes.join() === 'contacts.read,projects.read,tasks.read', [await allows(s.alexa), adaRemoves.scopes]);

    // Who may not.
    const anaCaller = await caller(s.ana);
    check('read: a member without key management is refused', (await refusal(() => getAgentPowers(service, anaCaller, s.alexa)))?.statusCode === 403);
    check('save: a personal assistant is its person\'s', (await refusal(() => setAgentPowers(service, ownerCaller, s.pip, { scopes: ['tasks.read'] })))?.details?.reason === 'personal_agent');
    await s.key(s.gone, ['tasks.read']);
    check('save: a suspended agent is refused', (await refusal(() => setAgentPowers(service, ownerCaller, s.gone, { scopes: ['tasks.read'] })))?.details?.reason === 'member_suspended');
    check('save: no live key is a 409', (await refusal(() => setAgentPowers(service, ownerCaller, s.nokey, { scopes: ['tasks.read'] })))?.details?.reason === 'no_live_key');

    // Over v1, with the Owner's key.
    const ownerKey = await s.key(s.owner, ['api_keys.manage_all', 'tasks.read', 'projects.read', 'contacts.read', 'team.read']);
    const APP = 'https://pm.example.com';
    const call = async (handler: Loose, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown) => {
      const response = await handler(new NextRequest(`${APP}${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) });
      return { status: response.status, body: await response.json().catch(() => null) as Loose };
    };
    const got = await call(v1Powers.GET, 'GET', `/api/v1/agents/${s.alexa}/powers`, { id: s.alexa }, ownerKey.value);
    check('v1: GET answers the one list', got.status === 200 && got.body?.data?.scopes?.join() === 'contacts.read,projects.read,tasks.read', got);
    const put = await call(v1Powers.PUT, 'PUT', `/api/v1/agents/${s.alexa}/powers`, { id: s.alexa }, ownerKey.value, { scopes: ['tasks.read'] });
    check('v1: PUT lines the keys up', put.status === 200 && (await keyScopes(alexaKey1.id)).join() === 'tasks.read' && !(await allows(s.alexa)).includes('contacts.read'), put.body);
    const escalate = await call(v1Powers.PUT, 'PUT', `/api/v1/agents/${s.alexa}/powers`, { id: s.alexa }, ownerKey.value, { scopes: ['tasks.read', 'files.manage'] });
    check('v1: never beyond what the calling key carries', escalate.status === 403 || escalate.status === 422, escalate.body);
    const empty = await call(v1Powers.PUT, 'PUT', `/api/v1/agents/${s.alexa}/powers`, { id: s.alexa }, ownerKey.value, { scopes: [] });
    check('v1: an empty list is refused', empty.status === 422 || empty.status === 400, empty.body);

    // Hire's personal path: one assistant per person, an Owner only, with assistants on.
    const { hirePersonalAssistant } = await import('../src/lib/api/personal-hire');
    await s.q('UPDATE pm.business_settings SET assistants_enabled = false');
    check('personal hire: refused while assistants are off', (await refusal(() => hirePersonalAssistant(service, ownerCaller, { person_id: s.admin })))?.details?.reason === 'assistants_off');
    await s.q('UPDATE pm.business_settings SET assistants_enabled = true');
    check('personal hire: an Admin is not an Owner', (await refusal(() => hirePersonalAssistant(service, adaCaller, { person_id: s.admin })))?.details?.reason === 'owner_only');
    check('personal hire: never for an agent', (await refusal(() => hirePersonalAssistant(service, ownerCaller, { person_id: s.alexa })))?.details?.reason === 'not_a_person');
    const forAda = await hirePersonalAssistant(service, ownerCaller, { person_id: s.admin });
    const adaRow = (await s.q('SELECT delegate_of, assistant_template, role FROM pm.team_members WHERE id = $1', [forAda.agent.id]))[0];
    check('personal hire: makes her assistant, named for her', forAda.created && forAda.agent.name === "Ada's Assistant" && adaRow?.delegate_of === s.admin && adaRow?.assistant_template === 'personal-assistant' && adaRow?.role === 'agent', [forAda, adaRow]);
    const again = await hirePersonalAssistant(service, ownerCaller, { person_id: s.admin });
    check('personal hire: a second time answers the same one', !again.created && again.agent.id === forAda.agent.id);
    const forAna = await hirePersonalAssistant(service, ownerCaller, { person_id: s.ana });
    check('personal hire: someone who has one already keeps it', !forAna.created && forAna.agent.id === s.pip);

    // Revoke unused keys.
    const oldNever = await s.key(s.ana, ['tasks.read'], { name: 'Old never', createdBy: s.ana, created: iso(Date.now() - 30 * DAY) });
    const freshNever = await s.key(s.ana, ['tasks.read'], { name: 'Fresh', createdBy: s.ana });
    const stale = await s.key(s.ana, ['tasks.read'], { name: 'Stale', createdBy: s.ana, lastUsed: iso(Date.now() - 100 * DAY) });
    const inUse = await s.key(s.ana, ['tasks.read'], { name: 'In use', createdBy: s.ana, lastUsed: iso(Date.now() - DAY) });
    const othersStale = await s.key(s.admin, ['tasks.read'], { name: 'Ada stale', createdBy: s.admin, lastUsed: iso(Date.now() - 100 * DAY) });
    const actor = (memberId: string, access: Loose) => ({ memberId, access, apiKeyId: null, endpoint: '/api/workspace/api-keys/revoke-unused', via: 'app' as const });
    const preview = await revokeUnusedKeys(service, actor(s.ana, anaCaller.access), { dry_run: true });
    const ids = preview.keys.map((key) => key.id);
    check('unused: the preview lists never-used and stale keys you manage', ids.includes(oldNever.id) && ids.includes(stale.id), preview.keys.map((key) => key.name));
    check('unused: never a fresh key, one in use, or someone else\'s', !ids.includes(freshNever.id) && !ids.includes(inUse.id) && !ids.includes(othersStale.id), preview.keys.map((key) => key.name));
    check('unused: a preview revokes nothing', (await s.q('SELECT 1 FROM pm.api_keys WHERE revoked_at IS NOT NULL AND id = ANY($1)', [ids])).length === 0);
    // The stale key is used between the preview and the revoke: it is skipped.
    await s.q('UPDATE pm.api_keys SET last_used_at = now() WHERE id = $1', [stale.id]);
    const done = await revokeUnusedKeys(service, actor(s.ana, anaCaller.access), { dry_run: false, key_ids: [...ids, inUse.id] });
    check('unused: revokes what is still unused', done.revoked_ids.includes(oldNever.id), done);
    check('unused: a key used since the preview, or never in it, is skipped', done.skipped_ids.includes(stale.id) && done.skipped_ids.includes(inUse.id) && !done.revoked_ids.includes(stale.id), done);
    const audit = await s.q("SELECT 1 FROM pm.api_audit_log WHERE entity_id = $1 AND endpoint = '/api/workspace/api-keys/revoke-unused'", [oldNever.id]);
    check('unused: each revoke is audited', audit.length === 1);

    // Review of wave 3, finding 3: a revoke takes the keys a key made with it, so a tree with a key in use is kept.
    const staleParent = await s.key(s.ana, ['tasks.read'], { name: 'Stale parent', createdBy: s.ana, lastUsed: iso(Date.now() - 100 * DAY) });
    const liveChild = await s.key(s.ana, ['tasks.read'], { name: 'Live child', createdBy: s.ana, lastUsed: iso(Date.now() - DAY), madeByKey: staleParent.id });
    const staleMaker = await s.key(s.ana, ['tasks.read'], { name: 'Stale maker', createdBy: s.ana, lastUsed: iso(Date.now() - 100 * DAY) });
    const staleKid = await s.key(s.ana, ['tasks.read'], { name: 'Stale kid', createdBy: s.ana, lastUsed: iso(Date.now() - 120 * DAY), madeByKey: staleMaker.id });
    const treePreview = await revokeUnusedKeys(service, actor(s.ana, anaCaller.access), { dry_run: true });
    const kept = treePreview.kept_keys.find((key) => key.id === staleParent.id);
    check('unused: a stale key that made a key in use is kept out of the preview, saying why',
      !treePreview.keys.some((key) => key.id === staleParent.id) && kept?.kept === 'holds_live_key' && /Live child/.test(kept?.why ?? ''), { keys: treePreview.keys.map((k) => k.name), kept });
    const maker = treePreview.keys.find((key) => key.id === staleMaker.id);
    check('unused: the preview names the other keys a revoke takes down', maker?.takes_down.map((key) => key.id).join() === staleKid.id, maker);
    const treeDone = await revokeUnusedKeys(service, actor(s.ana, anaCaller.access), { dry_run: false, key_ids: [staleParent.id, staleMaker.id] });
    const revokedNow = async (id: string) => (await s.q<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM pm.api_keys WHERE id = $1', [id]))[0].revoked;
    check('unused: confirming never revokes a tree with a key in use (even sent by id)', treeDone.skipped_ids.includes(staleParent.id)
      && !(await revokedNow(staleParent.id)) && !(await revokedNow(liveChild.id)), treeDone);
    check('unused: ... and a stale tree goes with its maker', await revokedNow(staleMaker.id) && await revokedNow(staleKid.id), treeDone);
    // The calling key made by a stale key: never revoked through its maker, even when it looks unused itself.
    const staleGrand = await s.key(s.owner, ['tasks.read'], { name: 'Stale grand', createdBy: s.owner, lastUsed: iso(Date.now() - 200 * DAY) });
    const callingKey = await s.key(s.owner, ['api_keys.manage_all'], { name: 'Calling key', createdBy: s.owner, created: iso(Date.now() - 30 * DAY), madeByKey: staleGrand.id });
    const viaKey = { ...actor(s.owner, ownerCaller.access), apiKeyId: callingKey.id, endpoint: '/api/v1/api-keys/revoke-unused', via: 'rest' as const };
    const callerPreview = await revokeUnusedKeys(service, viaKey, { dry_run: true });
    check('unused: a key whose tree holds the calling key is kept, saying why', !callerPreview.keys.some((key) => key.id === staleGrand.id || key.id === callingKey.id)
      && callerPreview.kept_keys.find((key) => key.id === staleGrand.id)?.kept === 'holds_calling_key', callerPreview.kept_keys);
    const callerDone = await revokeUnusedKeys(service, viaKey, { dry_run: false, key_ids: [staleGrand.id] });
    check('unused: ... and is never revoked', callerDone.skipped_ids.includes(staleGrand.id) && !(await revokedNow(staleGrand.id)) && !(await revokedNow(callingKey.id)), callerDone);

    // v1: never the calling key, even when it looks unused.
    const lonely = await s.key(s.owner, ['api_keys.manage_all'], { created: iso(Date.now() - 30 * DAY) });
    const v1Preview = await call(v1Unused.POST, 'POST', '/api/v1/api-keys/revoke-unused', {}, lonely.value, {});
    check('v1: preview never lists the calling key', v1Preview.status === 200 && !v1Preview.body?.data?.keys?.some((key: Loose) => key.id === lonely.id), v1Preview.body);
    check('v1: a key manager sees other people\'s unused keys', v1Preview.body?.data?.keys?.some((key: Loose) => key.id === othersStale.id), v1Preview.body?.data?.keys?.map((key: Loose) => key.name));
    const noIds = await call(v1Unused.POST, 'POST', '/api/v1/api-keys/revoke-unused', {}, lonely.value, { dry_run: false });
    check('v1: a revoke without ids is refused', noIds.status === 422 || noIds.status === 400, noIds.body);
  } finally {
    await server.close();
    await db.close();
  }
}

async function main() {
  pureChecks();
  await confirmChecks();
  await chatChecks();
  await serverChecks();
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
