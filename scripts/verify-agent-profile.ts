/**
 * The agent profile's rules, on their own: which keys still work and what
 * they grant, what owners Change opens on and offers (a suspended owner
 * stays visible and removable, and the server lets one stay), who an agent
 * escalates to by default, what holds it back, and how the Rules and powers
 * form follows a trimmed save and saves made elsewhere. Pure, apart from
 * checkOwnerIds over a stand-in for its one read.
 *
 *   npm run -s test:agent-profile
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  activeKeys, agentHolds, dropsViewer, endedKeys, escalateDefaultLabel, heldKeyScopes, keyState, newKeyPresetScopes, startingKeyScopes,
  ownerPickerOptions, ownersEditorStart, ownersSaveBody, profileFormOf, sameProfileForm, savedProfileForm, startProfileForm, syncProfileForm,
  trimmedProfileForm, type ProfileForm, agentSubtitle, instancesLine, profileTabOf, PROFILE_TABS,
} from '@/lib/agent-profile';
import { statusSentence } from '@/lib/agent-status';
import { DEFAULT_AGENT_RULES, type AgentRulesDraft } from '@/lib/agent-rules';
import { checkOwnerIds } from '@/lib/api/agent-owners';
import { applyAgentSample, demoAgentDetail } from '@/lib/demo-agent-profile';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const NOW = Date.parse('2026-11-26T12:00:00Z');
const hoursFrom = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

// ── Keys ──────────────────────────────────────────────────────────────
{
  const live = { id: 'a', scopes: ['tasks.read', 'tasks.create'], revoked_at: null, expires_at: hoursFrom(24 * 30), disabled_at: null };
  const forever = { id: 'b', scopes: ['projects.read'], revoked_at: null, expires_at: null, disabled_at: null };
  const expired = { id: 'c', scopes: ['team.manage'], revoked_at: null, expires_at: hoursFrom(-1), disabled_at: null };
  const off = { id: 'd', scopes: ['webhooks.manage'], revoked_at: null, expires_at: null, disabled_at: hoursFrom(-48) };
  const endsNow = { id: 'e', scopes: ['files.read'], revoked_at: null, expires_at: new Date(NOW).toISOString(), disabled_at: null };
  check('a key past its expiry is expired, not active', keyState(expired, NOW) === 'expired');
  check('a key ending this instant has ended', keyState(endsNow, NOW) === 'expired');
  check('a switched-off key is not active', keyState(off, NOW) === 'disabled');
  check('a key with time left, or no end, is active', keyState(live, NOW) === 'active' && keyState(forever, NOW) === 'active');
  const keys = [live, expired, forever, off, endsNow];
  check('active keys leave out every ended one', activeKeys(keys, NOW).map((k) => k.id).join() === 'a,b', activeKeys(keys, NOW));
  check('ended keys are listed apart, to clean up', endedKeys(keys, NOW).map((k) => k.id).join() === 'c,d,e');
  check('an agent whose only key expired holds no powers', heldKeyScopes([expired], NOW).length === 0);
  check('powers come from working keys only, sorted', heldKeyScopes(keys, NOW).join() === 'projects.read,tasks.create,tasks.read', heldKeyScopes(keys, NOW));
  check('a new key starts on its working keys', newKeyPresetScopes(['tasks.read'], ['goals.read']).join() === 'tasks.read');
  check('with no working key, a new key starts on its template', newKeyPresetScopes([], ['tasks.read', 'files.upload']).join() === 'tasks.read,files.upload');
  const preset = ['tasks.read', 'files.upload', 'team.manage'];
  check('new key: an Owner starts with a power the agent lacks ticked (the key gives it)', startingKeyScopes(preset, ['tasks.read', 'files.upload'], ['tasks.read'], true).join() === 'tasks.read,files.upload');
  check('new key: anyone else starts with only what the agent holds', startingKeyScopes(preset, ['tasks.read', 'files.upload'], ['tasks.read'], false).join() === 'tasks.read');
  check('new key: never a scope you cannot give', !startingKeyScopes(preset, ['tasks.read'], null, true).includes('team.manage'));
}

// ── Owners ────────────────────────────────────────────────────────────
const people = [
  { id: 'p-ana', name: 'Ana', role: 'member', status: 'active' },
  { id: 'p-ben', name: 'Ben', role: 'member', status: 'suspended' },
  { id: 'p-cy', name: 'Cy', role: 'owner', status: 'active' },
  { id: 'p-gone', name: 'Gone', role: 'member', status: 'suspended' },
  { id: 'a-bot', name: 'Bot', role: 'agent', status: 'active' },
];
{
  const owners = [{ id: 'p-ana', name: 'Ana', avatar_url: null }, { id: 'p-ben', name: 'Ben', avatar_url: null }];
  const groups = [{ id: 'g-design', name: 'Design' }];
  // Change opens on what is saved, whatever an earlier draft or a cold roster held.
  const staleDraft: string[] = [];
  const opened = ownersEditorStart(owners, groups);
  check('Change opens on the saved owners and groups, never a stale draft', opened.join() === 'p-ana,p-ben,group:g-design' && opened !== staleDraft, opened);
  check('saving what Change opened keeps the owner groups', JSON.stringify(ownersSaveBody(opened, 1)) === JSON.stringify({ owner_ids: ['p-ana', 'p-ben'], owner_group_ids: ['g-design'] }));
  check('with no groups saved or picked, groups are not sent', JSON.stringify(ownersSaveBody(['p-ana'], 0)) === JSON.stringify({ owner_ids: ['p-ana'] }));
  check('dropping the last group sends an empty list', JSON.stringify(ownersSaveBody(['p-ana'], 1)) === JSON.stringify({ owner_ids: ['p-ana'], owner_group_ids: [] }));

  const options = ownerPickerOptions(people, groups, owners);
  const ben = options.find((o) => o.value === 'p-ben');
  check('a suspended owner stays in the picker, marked, so it can be removed', ben?.label === 'Ben (suspended)', options);
  check('a suspended person who is not an owner is not offered', !options.some((o) => o.value === 'p-gone'));
  check('agents are never offered as owners', !options.some((o) => o.value === 'a-bot'));
  check('groups are offered by their prefix', options.some((o) => o.value === 'group:g-design'));

  const mine = new Set(['g-design']);
  check('removing yourself is noticed', dropsViewer(['p-ana', 'p-cy'], ['p-cy'], 'p-ana', new Set()));
  check('removing your only owner group is noticed', dropsViewer(['group:g-design'], [], 'p-ana', mine));
  check('keeping a group of yours is not leaving', !dropsViewer(['p-ana', 'group:g-design'], ['group:g-design'], 'p-ana', mine));
  check('someone who was not an owner is not leaving', !dropsViewer(['p-cy'], [], 'p-ana', new Set()));
}

// The server: an owner it already has may stay while suspended; a new suspended one is refused.
async function serverOwners() {
  const rows = people.map(({ id, role, status }) => ({ id, role, status }));
  const service = { from: () => ({ select: () => ({ in: async (_: string, ids: string[]) => ({ data: rows.filter((r) => ids.includes(r.id)), error: null }) }) }) } as unknown as SupabaseClient;
  const kept = await checkOwnerIds(service, 'agent-1', ['p-ana', 'p-ben'], ['p-ana', 'p-ben']).then((ids) => ids, (error: Error) => error);
  check('server: a suspended owner it already has may stay while the rest change', Array.isArray(kept) && kept.join() === 'p-ana,p-ben', kept instanceof Error ? kept.message : kept);
  const added = await checkOwnerIds(service, 'agent-1', ['p-ana', 'p-ben'], ['p-ana']).then(() => null, (error: { details?: { reason?: string; owner_ids?: string[] } }) => error.details);
  check('server: a suspended person is never added as a new owner', added?.reason === 'owner_not_active' && added.owner_ids?.join() === 'p-ben', added);
  const removed = await checkOwnerIds(service, 'agent-1', ['p-ana'], ['p-ana', 'p-ben']).then((ids) => ids, (error: Error) => error);
  check('server: removing the suspended owner is accepted', Array.isArray(removed) && removed.join() === 'p-ana');
}

// ── Escalation and holds ──────────────────────────────────────────────
{
  const owners = [{ id: 'p-ben', name: 'Ben' }, { id: 'p-ana', name: 'Ana' }];
  check('the default names its first active owner', escalateDefaultLabel(owners, [], new Set(['p-ben'])) === 'Its owners (first: Ana)');
  check('then its first owner group', escalateDefaultLabel([], [{ name: 'Design' }], new Set()) === 'Its owners (first: Design (any member))');
  check('with no owners, a workspace Owner', escalateDefaultLabel([], [], new Set()) === 'Its owners (none yet: a workspace Owner)');

  const base = { suspended: false, workspacePausedAt: null, person: null, pausedAt: null, budgetSpent: false, budgetPeriod: 'month' as const };
  check('nothing holds a working agent', agentHolds(base).length === 0);
  check('suspended shows only that', agentHolds({ ...base, suspended: true, pausedAt: hoursFrom(-1), budgetSpent: true }).map((h) => h.kind).join() === 'suspended');
  check('every hold shows, the widest first', agentHolds({
    ...base, workspacePausedAt: hoursFrom(-2), person: { name: 'Ana', paused_at: hoursFrom(-1) }, pausedAt: hoursFrom(-3), budgetSpent: true,
  }).map((h) => h.kind).join() === 'workspace_paused,person_paused,paused,budget');
}

// ── A personal agent's profile ────────────────────────────────────────
{
  const shared = demoAgentDetail('a1a1a1a1-0007-4000-8000-000000000007');
  const personal = shared && applyAgentSample(shared, 'personal');
  check('demo: a shared agent works for nobody', !!shared && shared.agent.delegate_of === null && shared.person === null);
  check('demo: a personal agent names its person and their pause, with no key powers to offer', !!personal && personal.agent.delegate_of === personal.person?.id
    && !!personal.person?.name && !!personal.person.paused_at && personal.key_scopes_available === undefined);
}

// ── The Rules and powers form ─────────────────────────────────────────
{
  const rules: AgentRulesDraft = { ...DEFAULT_AGENT_RULES, agent_escalate_to_group: null };
  const saved = profileFormOf({
    agent: { id: 'a', name: 'Scout', title: null, description: null, avatar_url: null, status: 'active', agent_role: 'reviewer' },
    rules,
  }, (r) => ({ ...DEFAULT_AGENT_RULES, ...r, agent_escalate_to_group: r.agent_escalate_to_group ?? null }));
  let state = startProfileForm(saved);
  check('the form starts on the saved values, clean', sameProfileForm(state.draft, saved) && !state.conflict);

  // Type "Scouty " and save: the server stores "Scouty".
  state = { ...state, draft: { ...state.draft, name: 'Scouty ' } };
  check('a typed change is dirty', !sameProfileForm(state.draft, saved));
  const submitted = trimmedProfileForm(state.draft);
  check('what is sent is trimmed', submitted.name === 'Scouty');
  state = savedProfileForm(state, submitted);
  check('after the save the draft holds the trimmed value', state.draft.name === 'Scouty' && !state.conflict);
  const after: ProfileForm = { ...saved, name: 'Scouty' };
  const resynced = syncProfileForm(state, after);
  check('the saved read arriving changes nothing: Save and Discard go quiet', resynced === state && sameProfileForm(resynced.draft, after));
  check('a trailing space alone is not a change', sameProfileForm({ ...after, name: 'Scouty  ' }, after));

  // Someone else saves while the form is untouched: it takes their values.
  const theirs: ProfileForm = { ...after, title: 'Lead reviewer' };
  const followed = syncProfileForm(resynced, theirs);
  check('untouched, the form takes a save made elsewhere', followed.draft.title === 'Lead reviewer' && !followed.conflict);

  // Someone else saves while the form has edits: the edits stay, and it says so.
  const editing = { ...followed, draft: { ...followed.draft, description: 'Checks every PR' } };
  const clash = syncProfileForm(editing, { ...theirs, title: 'Head reviewer' });
  check('with edits, a save elsewhere keeps them and flags it', clash.conflict && clash.draft.description === 'Checks every PR' && clash.base.title === 'Head reviewer');
  check('the role is compared as it is stored', sameProfileForm({ ...after, role: 'Reviewer ' }, after));
}

// ── Header words and tabs ─────────────────────────────────────────────
{
  check('title, template and role saying the same show once', agentSubtitle({ title: 'Builder', templateLabel: 'Builder', role: 'Builder' }) === 'Builder', agentSubtitle({ title: 'Builder', templateLabel: 'Builder', role: 'Builder' }));
  check('the role shows only when it differs from the title', agentSubtitle({ title: 'Head reviewer', templateLabel: null, role: 'Reviewer' }) === 'Head reviewer · Reviewer');
  check('case and spaces do not make a second word', agentSubtitle({ title: 'builder ', templateLabel: 'Builder', role: null }) === 'builder');
  check('nothing set says so', agentSubtitle({ title: null, templateLabel: null, role: null }) === 'No role yet');
  check('one worker or none says nothing', instancesLine({ count: 1, working: 1 }) === null && instancesLine({ count: 0, working: 0 }) === null && instancesLine(null) === null);
  check('three working is "3 working now"', instancesLine({ count: 3, working: 3 }) === '3 working now', instancesLine({ count: 3, working: 3 }));
  check('some idle are counted apart', instancesLine({ count: 3, working: 1 }) === '3 running, 1 working now', instancesLine({ count: 3, working: 1 }));
  check('five tabs at most', PROFILE_TABS.length === 5, PROFILE_TABS);
  check('an old Activity link lands on Overview', profileTabOf('activity').tab === 'overview' && profileTabOf('activity').anchor === 'ov-activity');
  check('an old Agent notes link lands on Rules', profileTabOf('notes').tab === 'rules' && profileTabOf('notes').anchor === 'rp-notes');
  check('an old Connect link lands on Access', profileTabOf('connect').tab === 'access' && profileTabOf('connect').anchor === 'cn-host');
  check('a current tab stays', profileTabOf('runs').tab === 'runs' && profileTabOf('runs').anchor === null);
  check('anything else is Overview', profileTabOf('nope').tab === 'overview' && profileTabOf(null).tab === 'overview');
  const idleNow = statusSentence({ mood: 'idle', since: NOW - 5_000, sinceMeans: 'idle', telemetry: 'live' } as never, NOW);
  check('a fresh idle never says a clock reading', !/under a minute|0s/.test(idleNow) && idleNow === 'Idle, active just now', idleNow);
  const working = statusSentence({ mood: 'working', since: NOW - 16 * 60_000, sinceMeans: 'working', telemetry: 'live' } as never, NOW);
  check('working keeps how long', working === 'Working for 16 min', working);
}

serverOwners().then(() => {
  if (failures.length) {
    console.error(`agent-profile: ${failures.length} failed, ${passed} passed`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log(`agent-profile: ${passed} checks passed`);
});
