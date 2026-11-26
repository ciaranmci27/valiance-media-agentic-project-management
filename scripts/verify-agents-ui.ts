/**
 * The agent screens' logic, on its own: the hire and project setup steps
 * and their checks, which control a template setting renders as, a long
 * roster's search, filters, sort, groups and window, Needs you grouped at
 * scale (your agents first), roles, avatar tones, brief freshness, and the
 * one project payload the Edit form and the guided setup share. Pure; no
 * database, no network.
 *
 *   npm run -s test:agents-ui
 */
import {
  applyTemplate, avatarTone, controlFor, defaultNeedsYouGrouping, defaultOwnerFilter, emptyHireDraft, facetCounts, filterRoster,
  firstInvalidHireStep, freshnessLabel, groupNeedsYou, groupRoster, hireRequestFrom, initialsOf, isStale, normalizeRole,
  orderBriefEntries, presenceOf, roleError, roleLabel, roleSuggestions, scopeGroups, setDraftProjects, settingsDefaults,
  settingsSummary, sortRoster, validateHireStep, validateSettings, windowOf, AVATAR_TONE_COUNT, NEEDS_YOU_GROUP_BY_AGENT_AFTER,
  NO_ROSTER_FILTERS, SELECT_SEARCH_AFTER, type NeedsYouEntry, type RosterFacts,
} from '@/lib/agents-ui';
import { emptyProjectBasics, projectPayload, projectUpdatePayload, validateProjectBasics } from '@/lib/project-form';
import { AGENT_FIELDS } from '@/lib/api/project-create';
import { newKeyFrom, WorkspaceApiError } from '@/lib/agent-workspace';
import { canAddAgentToProject, needsClamp, projectsLine, rosterProjects, showMoreLabel } from '@/lib/agents-ui';
import {
  hireRefusal, hireTemplates, keyExpiryLine, limitsLine, projectFromLink, readsInbox, sameNameMember, scopesBeyondRole, worksOutsideProjects,
  HIRE_HIDDEN_TEMPLATES, HIRE_STEPS, HIRE_STEPS_BEFORE_HIRE,
} from '@/lib/agents-ui';
import { buildConnectInfo, connectSnippetsWithKey } from '@/lib/agent-connect';
import { runPill, runTitle, triggerLabel } from '@/lib/agents-tab';
import type { AgentTemplateView, SettingsField } from '@/lib/agent-workspace';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const ME = 'person-me';
const MATE = 'person-mate';

// ── Paging ────────────────────────────────────────────────────────────
{
  const hundred = Array.from({ length: 100 }, (_, i) => i);
  const first = windowOf(hundred, 1, 24);
  check('a window shows one page and counts the rest', first.shown.length === 24 && first.hidden === 76, first);
  const grown = windowOf(hundred, 4, 24);
  check('growing the window shows more, never past the end', grown.shown.length === 96 && grown.hidden === 4, grown);
  check('the last page shows the remainder', windowOf(hundred, 5, 24).shown.length === 100 && windowOf(hundred, 5, 24).hidden === 0);
  check('a bad page or size falls back to one', windowOf(hundred, 0, 10).shown.length === 10 && windowOf(hundred, 2, 0).shown.length === 2);
  check('an empty list hides nothing', windowOf([], 3, 10).hidden === 0);
}

// ── Settings form ─────────────────────────────────────────────────────
const builderSettings: SettingsField[] = [
  { key: 'repo_url', label: 'Repository', type: 'url', required: true },
  { key: 'working_branch', label: 'Working branch', type: 'text', default: 'dev', max: 200 },
  { key: 'review_paths', label: 'Paths that need review', type: 'regex' },
  { key: 'merge_on_green', label: 'May merge on green', type: 'boolean', default: false },
  { key: 'every_hours', label: 'Check every', type: 'number', min: 1, max: 168, default: 6 },
  { key: 'notes', label: 'Notes', type: 'textarea' },
  { key: 'day', label: 'Day', type: 'select', options: ['mon', 'tue', 'wed'] },
];
{
  const controls = builderSettings.map((f) => controlFor(f));
  check('each field type picks its control', controls.join() === 'url,text,regex,toggle,number,textarea,select', controls);
  const many: SettingsField = { key: 'tz', label: 'Zone', type: 'select', options: Array.from({ length: SELECT_SEARCH_AFTER + 1 }, (_, i) => `z${i}`) };
  check('a long select takes a search', controlFor(many) === 'search-select');
  check('an unknown type from a newer template reads as text', controlFor({ type: 'colour' as SettingsField['type'] }) === 'text');
  const defaults = settingsDefaults(builderSettings);
  check('defaults come from the template, a toggle starts off', defaults.working_branch === 'dev' && defaults.merge_on_green === false && defaults.every_hours === 6 && !('repo_url' in defaults), defaults);

  const missing = validateSettings(builderSettings, defaults);
  check('a required field left empty is named', Object.keys(missing).join() === 'repo_url', missing);
  const bad = validateSettings(builderSettings, { ...defaults, repo_url: 'not a link', review_paths: '([', every_hours: 500, day: 'sun', ghost: 'x' });
  check('a bad link, pattern, number, choice and unknown key are each named',
    ['repo_url', 'review_paths', 'every_hours', 'day', 'ghost'].every((k) => k in bad), bad);
  const good = validateSettings(builderSettings, { ...defaults, repo_url: 'https://github.com/acme/site', review_paths: '^migrations/', day: 'tue', notes: '' });
  check('valid settings pass, and an empty optional value is fine', Object.keys(good).length === 0, good);
  check('a template with no settings refuses any value', 'x' in validateSettings([], { x: 1 }) && Object.keys(validateSettings([], {})).length === 0);
  check('the summary counts what is set', settingsSummary(builderSettings, { repo_url: 'https://a.b', merge_on_green: false }) === '1 of 7 set'
    && settingsSummary([], {}) === 'No settings' && settingsSummary(builderSettings, {}) === 'Default settings');
}

// ── Hire steps ────────────────────────────────────────────────────────
const builder: AgentTemplateView = {
  key: 'builder', label: 'Builder', description: 'Works assigned tasks.', role: 'builder',
  rules: { agent_self_assign: false, agent_close_policy: 'review', agent_create_policy: 'live' },
  scopes: ['tasks.read', 'tasks.manage_assigned', 'api_keys.manage_all'],
  settings: builderSettings,
};
{
  const grantable = ['tasks.read', 'tasks.manage_assigned', 'projects.read'];
  let draft = emptyHireDraft(ME);
  check('a new hire is owned by who hires it', draft.ownerIds.join() === ME);
  check('the template step needs a choice', 'template' in validateHireStep('template', draft, null, grantable));
  draft = setDraftProjects(draft, ['p1'], []);
  draft = applyTemplate(draft, null, builder, grantable);
  check('a template presets role, rules and only the scopes the hirer may grant',
    draft.role === 'builder' && draft.rules.agent_close_policy === 'review' && draft.scopes.join() === 'tasks.read,tasks.manage_assigned', draft);
  check('a template gives picked projects its default settings', draft.projects.p1.settings.working_branch === 'dev', draft.projects);
  check('starting blank clears presets', applyTemplate(draft, builder, null, grantable).scopes.length === 0 && applyTemplate(draft, builder, null, grantable).templateKey === '');

  // Switching templates rebuilds the draft: nothing of the first template survives.
  const fresh = setDraftProjects(emptyHireDraft(ME), ['p1'], []);
  const blank = applyTemplate(fresh, null, null, grantable);
  const backToBlank = applyTemplate(applyTemplate(fresh, null, builder, grantable), builder, null, grantable);
  check('a template then blank leaves nothing of the template', JSON.stringify(backToBlank) === JSON.stringify(blank), backToBlank);
  const other: AgentTemplateView = { key: 'reporter', label: 'Reporter', description: 'Sends a summary.', role: 'reporter', rules: { agent_close_policy: 'close' }, scopes: ['projects.read'] };
  const viaBuilder = applyTemplate(applyTemplate(fresh, null, builder, grantable), builder, other, grantable);
  check('a template then another is the same as the other alone', JSON.stringify(viaBuilder) === JSON.stringify(applyTemplate(fresh, null, other, grantable)), viaBuilder);
  const typed = { ...applyTemplate(fresh, null, builder, grantable), name: 'Nova', title: 'Site builder', role: 'Builder', description: '', projects: { p1: { settings: { working_branch: 'main' }, instructions: 'Only the API' } } };
  const switched = applyTemplate(typed, builder, null, grantable);
  check('a switch keeps what the person typed and drops what the template suggested',
    switched.name === 'Nova' && switched.title === 'Site builder' && switched.role === '' && switched.description === ''
      && switched.projects.p1.instructions === 'Only the API' && Object.keys(switched.projects.p1.settings).length === 0, switched);

  check('identity needs a name', 'name' in validateHireStep('identity', draft, builder, grantable));
  check('a role must be plain words', 'role' in validateHireStep('identity', { ...draft, name: 'Nova', role: 'Builder!!' }, builder, grantable));
  draft = { ...draft, name: 'Nova' };
  check('a named agent passes identity', Object.keys(validateHireStep('identity', draft, builder, grantable)).length === 0);

  const projectErrors = validateHireStep('projects', draft, builder, grantable);
  check('each project\'s settings are checked, keyed by project and field', Object.keys(projectErrors).join() === 'project:p1:repo_url', projectErrors);
  draft = { ...draft, projects: { p1: { ...draft.projects.p1, settings: { ...draft.projects.p1.settings, repo_url: 'https://github.com/acme/site' } } } };
  check('filled settings pass the projects step', Object.keys(validateHireStep('projects', draft, builder, grantable)).length === 0);
  const keeps = setDraftProjects({ ...draft, projects: { p1: { ...draft.projects.p1, instructions: 'Only the API' } } }, ['p1', 'p2'], builderSettings);
  check('adding a project keeps what was typed for the others', keeps.projects.p1.instructions === 'Only the API' && keeps.projects.p2.settings.working_branch === 'dev', keeps.projects);

  check('a key with no powers is refused', 'scopes' in validateHireStep('powers', { ...draft, scopes: [] }, builder, grantable));
  check('no key, no powers needed', Object.keys(validateHireStep('powers', { ...draft, scopes: [], createKey: false }, builder, grantable)).length === 0);
  check('a power the hirer cannot grant is refused', 'scopes' in validateHireStep('powers', { ...draft, scopes: ['api_keys.manage_all'] }, builder, grantable));
  check('the first broken step before connect is found', firstInvalidHireStep({ ...draft, name: '' }, builder, grantable, 'connect') === 'identity');
  check('a complete draft has no broken step', firstInvalidHireStep(draft, builder, grantable, 'connect') === null);

  const body = hireRequestFrom({ ...draft, role: ' Code Reviewer ', projects: { p1: { settings: { ...draft.projects.p1.settings, notes: '' }, instructions: '  ship small  ' } } });
  check('the hire body sends the role as the server stores it, trimmed instructions and no empty settings',
    body.agent_role === 'code-reviewer' && body.project_settings.p1.instructions === 'ship small' && !('notes' in body.project_settings.p1.settings) && body.owner_ids?.join() === ME, body);
  const handed = hireRequestFrom({ ...draft, ownerIds: [MATE] });
  check('owners are sent as picked: taking yourself out leaves only who you named', JSON.stringify(handed.owner_ids) === JSON.stringify([MATE]), handed.owner_ids);
  check('with no owners picked, none are sent (the server makes the hirer its owner)', !('owner_ids' in hireRequestFrom({ ...draft, ownerIds: [] })));
  check('more than 20 people as owners is refused on Identity',
    'owners' in validateHireStep('identity', { ...draft, ownerIds: Array.from({ length: 21 }, (_, i) => `p${i}`) }, builder, grantable)
    && !('owners' in validateHireStep('identity', { ...draft, ownerIds: Array.from({ length: 20 }, (_, i) => `p${i}`) }, builder, grantable)));
}

// ── Hire flow: blank, review, templates offered, refusals, snippets ───
{
  const blankDraft = emptyHireDraft(ME);
  check('a new draft starts careful: works only what it is given, finished work to review',
    blankDraft.rules.agent_self_assign === false && blankDraft.rules.agent_close_policy === 'review', blankDraft.rules);
  const chosenBlank = applyTemplate(applyTemplate(blankDraft, null, builder, ['tasks.read']), builder, null, ['tasks.read']);
  check('picking Start blank (also after a template) keeps the careful rules',
    chosenBlank.templateKey === '' && chosenBlank.rules.agent_self_assign === false && chosenBlank.rules.agent_close_policy === 'review', chosenBlank.rules);
  const watcher: AgentTemplateView = { key: 'w', label: 'W', description: '', rules: { agent_self_assign: true, agent_close_policy: 'close' }, scopes: ['tasks.read'] };
  const fromWatcher = applyTemplate(blankDraft, null, watcher, ['tasks.read']);
  check('a template still sets its own rules', fromWatcher.rules.agent_self_assign === true && fromWatcher.rules.agent_close_policy === 'close', fromWatcher.rules);

  const keys = HIRE_STEPS.map((s) => s.key).join();
  check('Review comes after Powers and before the hire (Connect)', keys === 'template,identity,projects,powers,review,connect,done', keys);
  check('the stepper reaches only the steps before the hire', HIRE_STEPS[HIRE_STEPS_BEFORE_HIRE].key === 'connect' && HIRE_STEPS_BEFORE_HIRE === 5);
  const ready = { ...setDraftProjects(applyTemplate(blankDraft, null, null, []), [], []), name: 'Nova', createKey: false };
  check('Review checks every step before it, so a hire never skips a broken one',
    firstInvalidHireStep({ ...ready, name: '' }, null, [], 'review') === 'identity' && firstInvalidHireStep(ready, null, [], 'review') === null
      && Object.keys(validateHireStep('review', ready, null, [])).length === 0);

  const all = [{ key: 'builder' }, { key: 'personal-assistant' }, { key: 'external-agent' }];
  check('the personal assistant template is not offered for hire', hireTemplates(all).map((t) => t.key).join() === 'builder,external-agent' && HIRE_HIDDEN_TEMPLATES.includes('personal-assistant'));

  const groups = scopeGroups(['tasks.read', 'files.upload', 'agents.act_for'], ['tasks.read']);
  const flat = groups.flatMap((g) => g.scopes);
  check('powers the agent role lacks are offered and marked, the rest plain',
    flat.find((s) => s.key === 'agents.act_for')?.beyondRole === true && flat.find((s) => s.key === 'files.upload')?.beyondRole === true
      && !flat.find((s) => s.key === 'tasks.read')?.beyondRole && flat.length === 3, flat);
  check('without the agent role set nothing is marked', scopeGroups(['tasks.read', 'agents.act_for']).flatMap((g) => g.scopes).every((s) => !s.beyondRole));
  check('never-for-agents scopes are never offered', !scopeGroups(['audit.export', 'tasks.read'], ['tasks.read']).flatMap((g) => g.scopes).some((s) => s.key === 'audit.export'));
  check('Review names what the hire gives beyond the role', scopesBeyondRole(['tasks.read', 'agents.act_for'], ['tasks.read']).join() === 'agents.act_for'
    && scopesBeyondRole(['agents.act_for'], null).length === 0);
  check('a template preset keeps a power beyond the role (an Owner gives it)', applyTemplate(blankDraft, null, { ...watcher, scopes: ['tasks.read', 'agents.act_for'] }, ['tasks.read', 'agents.act_for']).scopes.join() === 'tasks.read,agents.act_for');

  const names = { member: (id: string) => ({ sam: 'Sam' } as Record<string, string>)[id], project: (id: string) => ({ apex: 'Apex' } as Record<string, string>)[id] };
  const owner = hireRefusal({ message: 'Every owner must be an active team member', details: { reason: 'owner_not_active', owner_ids: ['sam'] } }, names);
  check('a refused owner goes back to Identity, by name', owner.step === 'identity' && owner.fields.owners?.includes('Sam') && !owner.message.includes('sam'), owner);
  const trashed = hireRefusal({ message: 'Project not found. It may be in Trash.', details: { reason: 'not_found_or_in_trash', project_ids: ['apex'] } }, names);
  check('a trashed project goes back to Projects, by name', trashed.step === 'projects' && trashed.message.startsWith('Apex'), trashed);
  const scope = hireRefusal({ message: 'x', details: { reason: 'scope_needs_owner', not_held: ['agents.act_for'] } }, names);
  check('a refused power goes back to Powers in plain words', scope.step === 'powers' && scope.message.includes('Act for a person') && !scope.message.includes('agents.act_for'), scope);
  const partway = hireRefusal({ message: 'x', details: { reason: 'hire_incomplete', agent_id: 'a1', remains: ['The agent stays in Team, suspended.'] } }, names);
  check('a hire that stopped partway names the suspended agent it left', partway.step === null && partway.incomplete?.agentId === 'a1' && partway.incomplete.remains.length === 1, partway);

  check('a ?project= link to a project that is not open is dropped', projectFromLink('gone', ['p1']).dropped && projectFromLink('p1', ['p1']).projectId === 'p1' && !projectFromLink(null, []).dropped);
  check('a same-named active member is found, any case; a suspended one is not',
    sameNameMember(' nova ', [{ name: 'Nova', status: 'active' }])?.name === 'Nova' && sameNameMember('Nova', [{ name: 'Nova', status: 'suspended' }]) === null);
  check('an agent that works in another system has no task rules', worksOutsideProjects({ scopes: ['agent_activity.write', 'questions.ask'] }) && !worksOutsideProjects({ scopes: ['tasks.read'] }) && !worksOutsideProjects(null));
  check('inbox powers need an inbox grant', readsInbox(['inbound_email.read']) && !readsInbox(['tasks.read']));
  check('template limits read as one line', limitsLine({ max_concurrent_runs: 2, budget_usd: 50, budget_period: 'month' }) === '2 runs at once · $50 a month' && limitsLine(null) === null && limitsLine({}) === null);
  check('a key with an end says when', /^Expires /.test(keyExpiryLine('2027-03-03T00:00:00Z') ?? '') && keyExpiryLine(null, null) === null && /^Expires /.test(keyExpiryLine(undefined, 30) ?? ''));

  // While a key is on screen the snippets carry it, in a header, never in a URL.
  const info = buildConnectInfo('https://pm.example.com');
  const secret = 'pk_live_abc123secret';
  const filled = connectSnippetsWithKey(info, secret);
  const urls = Object.values(filled).flatMap((text) => text.match(/https?:\/\/\S+/g) ?? []);
  check('snippets with a key carry it in every one', Object.values(filled).every((text) => text.includes(secret)), filled);
  check('the key is never in a URL', urls.length > 0 && urls.every((u) => !u.includes(secret) && !u.includes('?')), urls);
  check('the key goes in a header (x-api-key)', filled.claude_code.includes(`--header "x-api-key: ${secret}"`)
    && JSON.parse(filled.generic_mcp_json).mcpServers.pm.headers['x-api-key'] === secret && filled.codex.includes(`http_headers = { "x-api-key" = "${secret}" }`), filled);
  check('without a key the snippets read it from the environment', JSON.stringify(connectSnippetsWithKey(info, null)) === JSON.stringify(info.snippets)
    && !JSON.stringify(info.snippets).includes(secret));
}

// ── Powers ────────────────────────────────────────────────────────────
{
  const groups = scopeGroups(['tasks.read', 'meetings.write', 'fleet_alerts.write', 'api_keys.manage_all', 'smtp.manage']);
  const keys = groups.flatMap((g) => g.scopes.map((s) => s.key));
  check('powers list only grantable API scopes, never a meeting key', keys.includes('tasks.read') && !keys.includes('meetings.write') && !keys.includes('smtp.manage'), keys);
  // The server that runs the agents often posts its alerts with an agent's own key.
  check('fleet alerts stay grantable to an agent (the host publisher uses an agent key)', keys.includes('fleet_alerts.write'), keys);
  check('a key that makes keys is marked sensitive', groups.flatMap((g) => g.scopes).find((s) => s.key === 'api_keys.manage_all')?.sensitive === true);
  check('empty groups are left out', groups.every((g) => g.scopes.length > 0));
}

// ── Roles ─────────────────────────────────────────────────────────────
{
  check('roles normalize to the server shape', normalizeRole('  Code Reviewer ') === 'code-reviewer' && normalizeRole('builder') === 'builder' && normalizeRole('') === null && normalizeRole('!!') === null);
  check('a role reads as words', roleLabel('code-reviewer') === 'Code reviewer');
  check('an empty role is fine, junk is not', roleError('') === null && roleError('builder') === null && !!roleError('$$$'));
  const suggestions = roleSuggestions('re', ['reviewer', 'researcher', 'builder', 'orchestrator'], 'release-manager');
  check('suggestions match what is typed, prefix first, template role included', suggestions.join() === 'release-manager,researcher,reviewer', suggestions);
  check('nothing typed suggests every role', roleSuggestions('', ['b', 'a'], null).join() === 'a,b');
}

// ── Avatars and presence ──────────────────────────────────────────────
{
  const tones = Array.from({ length: 400 }, (_, i) => avatarTone(`agent-${i}`));
  check('a tone is always one of the tokens', tones.every((t) => t >= 1 && t <= AVATAR_TONE_COUNT));
  check('the same agent always wears the same tone', avatarTone('agent-7') === avatarTone('agent-7'));
  const counts = Array.from({ length: AVATAR_TONE_COUNT }, (_, i) => tones.filter((t) => t === i + 1).length);
  check('with many agents, tones repeat evenly (no tone under a third of its share)', counts.every((c) => c > 400 / AVATAR_TONE_COUNT / 3), counts);
  check('initials read first and last', initialsOf('Ada Lovelace King') === 'AK' && initialsOf('nova') === 'NO' && initialsOf('  ') === '?');
  check('presence follows the mood, suspended wins', presenceOf('working', false) === 'working' && presenceOf('celebrating', false) === 'shipped' && presenceOf('working', true) === 'suspended' && presenceOf(null, false) === 'idle');
}

// ── Roster at scale ───────────────────────────────────────────────────
function agent(i: number, fields: Partial<RosterFacts> = {}): RosterFacts {
  return {
    id: `a${String(i).padStart(3, '0')}`,
    name: `Agent ${String(i).padStart(3, '0')}`,
    title: null,
    role: ['builder', 'reviewer', 'orchestrator', null][i % 4],
    templateKey: i % 2 ? 'builder' : 'inbox-triage',
    ownerIds: i % 10 === 0 ? [] : i % 3 === 0 ? [ME, MATE] : [MATE],
    projectIds: [`p${i % 5}`],
    presence: (['working', 'idle', 'blocked', 'idle', 'suspended'] as const)[i % 5],
    lastSeenAt: 1_000_000 + i,
    currentRunTitle: i === 42 ? 'Fix the checkout' : null,
    ...fields,
  };
}
{
  const roster = Array.from({ length: 120 }, (_, i) => agent(i));
  check('search finds by name, role or current run', filterRoster(roster, { ...NO_ROSTER_FILTERS, q: 'checkout' }, ME).map((e) => e.id).join() === 'a042'
    && filterRoster(roster, { ...NO_ROSTER_FILTERS, q: 'orchestr' }, ME).length === 30);
  check('status filters group presences', filterRoster(roster, { ...NO_ROSTER_FILTERS, presence: 'attention' }, ME).every((e) => e.presence === 'blocked')
    && filterRoster(roster, { ...NO_ROSTER_FILTERS, presence: 'off' }, ME).every((e) => e.presence === 'suspended'));
  const mine = filterRoster(roster, { ...NO_ROSTER_FILTERS, owner: 'me' }, ME);
  check('"me" means the viewer\'s own agents', mine.length > 0 && mine.every((e) => e.ownerIds.includes(ME)), mine.length);
  check('filters combine', filterRoster(roster, { ...NO_ROSTER_FILTERS, role: 'builder', templateKey: 'inbox-triage', projectId: 'p0' }, ME)
    .every((e) => e.role === 'builder' && e.templateKey === 'inbox-triage' && e.projectIds.includes('p0')));
  const byStatus = sortRoster(roster, 'status');
  check('status sort puts blocked first and suspended last', byStatus[0].presence === 'blocked' && byStatus[byStatus.length - 1].presence === 'suspended');
  check('name sort is alphabetical', sortRoster(roster, 'name')[0].name === 'Agent 000');
  check('recent sort is newest first', sortRoster(roster, 'recent')[0].id === 'a119');

  const byRole = groupRoster(roster, 'role');
  check('groups by role, with no role last', byRole[byRole.length - 1].label === 'No role' && byRole.reduce((n, g) => n + g.items.length, 0) === 120, byRole.map((g) => g.label));
  const byOwner = groupRoster(roster, 'owner', { owners: new Map([[ME, 'Me'], [MATE, 'Mate']]) });
  check('an agent with two owners shows under each; none falls to Workspace Owners',
    byOwner.find((g) => g.key === ME)!.items.length === 36 && byOwner[byOwner.length - 1].label === 'Workspace Owners', byOwner.map((g) => `${g.label}:${g.items.length}`));
  check('the roster opens on My agents when the viewer owns any', defaultOwnerFilter(roster, ME) === 'me' && defaultOwnerFilter(roster, 'stranger') === null);
  const facets = facetCounts(roster.map((e) => e.role));
  check('role choices come from the data, most used first', facets.length === 3 && facets[0].count === 30 && !facets.some((f) => f.value === null), facets);
}

// ── Needs you at scale ────────────────────────────────────────────────
{
  const entries: NeedsYouEntry[] = [
    { id: 'q1', kind: 'question', agentId: 'a1', at: '2026-11-20T10:00:00Z' },
    { id: 'ap1', kind: 'approval', agentId: 'a2', at: '2026-11-21T10:00:00Z' },
    { id: 's1', kind: 'suggestion', agentId: 'a1', at: '2026-11-22T10:00:00Z' },
    { id: 'm1', kind: 'merge', agentId: 'a3', at: '2026-11-19T10:00:00Z' },
    { id: 'b1', kind: 'blocked', agentId: null, at: '2026-11-23T10:00:00Z' },
  ];
  const byKind = groupNeedsYou(entries, 'kind');
  check('by kind: approvals, questions, blocked, merges, then suggestions', byKind.map((g) => g.key).join() === 'approval,question,blocked,merge,suggestion', byKind.map((g) => g.key));
  const mineFirst = groupNeedsYou(entries, 'kind', { ownedAgentIds: new Set(['a1']) });
  check('items from your agents lead as "Your agents", newest first, and leave the other groups',
    mineFirst[0].label === 'Your agents' && mineFirst[0].items.map((e) => e.id).join() === 's1,q1' && !mineFirst.some((g) => g.key === 'question'), mineFirst.map((g) => g.key));
  check('counts still add up to every item', mineFirst.reduce((n, g) => n + g.items.length, 0) === entries.length);
  const byAgent = groupNeedsYou(entries, 'agent', { ownedAgentIds: new Set(['a3']), agentNames: new Map([['a1', 'Nova'], ['a2', 'Orion'], ['a3', 'Vega']]) });
  check('by agent: your agents first, then the busiest, unnamed last',
    byAgent[0].label === 'Vega' && byAgent[1].label === 'Nova' && byAgent[byAgent.length - 1].label === 'No agent named', byAgent.map((g) => g.label));
  const many = Array.from({ length: NEEDS_YOU_GROUP_BY_AGENT_AFTER + 1 }, (_, i) => ({ id: `x${i}`, kind: 'question' as const, agentId: `a${i % 6}`, at: '2026-11-20T00:00:00Z' }));
  check('a long inbox from many agents groups by agent; a short one by kind', defaultNeedsYouGrouping(many) === 'agent' && defaultNeedsYouGrouping(entries) === 'kind');
  check('many items from one agent stay by kind', defaultNeedsYouGrouping(many.map((e) => ({ ...e, agentId: 'a1' }))) === 'kind');
}

// ── Brief ─────────────────────────────────────────────────────────────
{
  const now = Date.parse('2026-11-24T12:00:00Z');
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  check('freshness reads in plain words', freshnessLabel(ago(0), now) === 'Updated today' && freshnessLabel(ago(1), now) === 'Updated yesterday'
    && freshnessLabel(ago(3), now) === 'Updated 3 days ago' && freshnessLabel(ago(21), now) === 'Updated 3 weeks ago' && freshnessLabel(ago(120), now) === 'Updated 4 months ago');
  check('an entry over 90 days old may be out of date', isStale(ago(91), now) && !isStale(ago(30), now));
  const ordered = orderBriefEntries([
    { id: 'old', pinned: false, updated_at: ago(10) },
    { id: 'new', pinned: false, updated_at: ago(1) },
    { id: 'pin', pinned: true, updated_at: ago(50) },
  ]);
  check('pinned first, then newest', ordered.map((e) => e.id).join() === 'pin,new,old', ordered.map((e) => e.id));
}

// ── Project basics ────────────────────────────────────────────────────
{
  const rights = { manageBilling: false, manageMembers: true, manageContacts: true, timeOn: true };
  const blank = emptyProjectBasics(ME);
  const errors = validateProjectBasics(blank, { creating: true, rights });
  check('a new project needs a name and, for who manages contacts, a client', 'name' in errors && 'clientId' in errors, errors);
  check('editing does not ask for a client again', !('clientId' in validateProjectBasics({ ...blank, name: 'X' }, { creating: false, rights })));
  check('a due date before the start is refused', 'dueDate' in validateProjectBasics({ ...blank, name: 'X', clientId: 'c', startDate: '2026-12-10', dueDate: '2026-12-01' }, { creating: true, rights }));
  const payload = projectPayload({ ...blank, name: '  Site  ', budgetType: 'hours', budgetValue: '40' }, rights, null, ME);
  check('the payload trims and leaves out billing without the billing right', payload.name === 'Site' && !Object.keys(payload).includes('budget_value') && payload.member_ids.join() === ME, payload);
  const billing = projectPayload({ ...blank, name: 'Site', budgetType: 'hours', budgetValue: '40' }, { ...rights, manageBilling: true }, null, ME);
  check('with the billing right, the budget is a number', billing.budget_value === 40 && billing.budget_type === 'hours');
  const noMembers = projectPayload({ ...blank, name: 'Site', memberIds: [MATE] }, { ...rights, manageMembers: false }, null, ME);
  check('without member rights, a new project holds only its creator', noMembers.member_ids.join() === ME);
  const update = projectUpdatePayload(noMembers, { manageMembers: false, timeOn: false });
  check('an update leaves out members and time without the rights', !Object.keys(update).includes('member_ids') && !Object.keys(update).includes('time_tracking_enabled'));
  // The fleet columns stay in the database for the fleet that reads them; core's forms never write them.
  const everyRight = { manageBilling: true, manageMembers: true, manageContacts: true, timeOn: true };
  const existing = { member_ids: [ME], hourly_rate: 120, autonomous_enabled: true, suggestions_per_cycle: 3, repo_path: 'acme/site' } as never;
  const payloads = [payload, billing, noMembers, update,
    projectPayload({ ...blank, name: 'Site' }, everyRight, existing, ME),
    projectUpdatePayload(projectPayload({ ...blank, name: 'Site' }, everyRight, existing, ME), everyRight)];
  const fleetKeys = payloads.flatMap((p) => Object.keys(p).filter((key) => (AGENT_FIELDS as readonly string[]).includes(key)));
  check('project payloads never carry a fleet column', fleetKeys.length === 0, fleetKeys);
}

// ── Responses ─────────────────────────────────────────────────────────
{
  const key = { id: 'k1', name: 'Nova key', prefix: 'pm_ab', scopes: ['tasks.read'], secret: 'pm_ab_secret' };
  check('a key call’s { key } answer gives the key with its secret', newKeyFrom({ key }).secret === 'pm_ab_secret');
  check('a hire’s bare key reads the same', newKeyFrom(key).id === 'k1');
  let refused = false;
  try { newKeyFrom({ key: { ...key, secret: undefined } }); } catch (error) { refused = error instanceof WorkspaceApiError; }
  check('a key without its secret is refused, never shown as an empty box', refused);
  let refusedEmpty = false;
  try { newKeyFrom({ data: key }); } catch { refusedEmpty = true; }
  check('a still-wrapped answer is refused rather than read wrong', refusedEmpty);
}

// ── Putting an agent on a project ─────────────────────────────────────
{
  const onIt = { member_ids: ['agent-1', ME] };
  const notOnIt = { member_ids: [ME] };
  const plain = { isOwner: false, manageMembers: false };
  check('an Owner may put any agent on any project', canAddAgentToProject({ isOwner: true, manageMembers: false }, notOnIt, 'agent-1'));
  check('a member manager may too', canAddAgentToProject({ isOwner: false, manageMembers: true }, notOnIt, 'agent-1'));
  check('an agent’s owner may only where the agent is already a member',
    canAddAgentToProject(plain, onIt, 'agent-1') && !canAddAgentToProject(plain, notOnIt, 'agent-1'));
  check('a project with no member list grants nothing on its own', !canAddAgentToProject(plain, {}, 'agent-1'));
}

// ── Labels the browser check flagged ──────────────────────────────────
{
  check('show more names the rest when it is all that is left', showMoreLabel(5, 5) === 'Show 5 more' && showMoreLabel(3, 24) === 'Show 3 more');
  check('show more says how many are left past one page', showMoreLabel(76, 24) === 'Show 24 more, 76 left');
  check('show more counts what is still on the server', showMoreLabel(4, 12, 54) === 'Show 4 more, 54 left');

  check('projects read as access, with how many are set up', projectsLine(4, false, 2) === 'On 4 projects, 2 set up'
    && projectsLine(1, false, null) === 'On 1 project' && projectsLine(50, true, 0) === 'On 50+ projects' && projectsLine(0, false, null) === 'No projects');

  const many = Array.from({ length: 50 }, (_, i) => `p${i}`);
  const fromAccess = rosterProjects({ access_project_ids: many, access_total: 73, project_ids: ['p1'] }, ['p9']);
  check('access ids and total win over assignments and the app\u2019s members', fromAccess.count === 73 && !fromAccess.capped && fromAccess.ids.length === 50, fromAccess);
  check('a full access list with no total reads as capped', rosterProjects({ access_project_ids: many }, undefined).capped);
  check('an older server falls back to the members the app holds', rosterProjects({ project_ids: ['a1'] }, ['p1', 'p2']).count === 2);
  check('then to the assignment ids', rosterProjects({ project_ids: ['p1'] }, []).ids.join() === 'p1' && rosterProjects(undefined, undefined).count === 0);
  check('the roster line reads the total and the set-up count', projectsLine(fromAccess.count, fromAccess.capped, 2) === 'On 73 projects, 2 set up');

  const turn = { source: 'turn' as const, title: 'Ran 3m 11s (scheduled)', summary: null, trigger: 'scheduled', outcome: null };
  check('a turn named only by its length reads as its trigger', runTitle(turn) === 'Scheduled check', runTitle(turn));
  check('a turn with an outcome says it', runTitle({ ...turn, outcome: 'idle' }) === 'Scheduled check: nothing to do', runTitle({ ...turn, outcome: 'idle' }));
  check('a turn that wrote a summary reads as its first line', runTitle({ ...turn, summary: 'Merged the checkout fix\nDetails follow' }) === 'Merged the checkout fix');
  check('a generated summary is skipped too', runTitle({ ...turn, summary: 'Ran 2m (assigned)', trigger: 'assigned' }) === 'Assigned work');
  check('a stored run keeps its own title', runTitle({ ...turn, source: 'run', title: 'Ship the brief tab' }) === 'Ship the brief tab'
    && runTitle({ ...turn, source: 'run', title: null }) === 'Untitled run');
  check('an unknown trigger reads in Title Case', triggerLabel('nightly_audit') === 'Nightly Audit' && triggerLabel(null) === 'Agent step');
}

// ── Run pills and brief clamp (round 2) ───────────────────────────────
{
  const turn = (outcome: string | null) => ({ source: 'turn' as const, status: 'succeeded' as const, outcome });
  check('a blocked turn reads Blocked, warning', runPill(turn('blocked')).label === 'Blocked' && runPill(turn('blocked')).tone === 'warning');
  check('a failed or erroring turn reads Failed', runPill(turn('failed')).label === 'Failed' && runPill(turn('error')).tone === 'danger');
  check('an idle, skipped or waiting turn reads No work, neutral',
    ['idle', 'skipped', 'waiting', 'no_work'].every((o) => runPill(turn(o)).label === 'No work' && runPill(turn(o)).tone === 'default'));
  check('a turn that worked reads Succeeded, the label the Succeeded filter shows', runPill(turn('work')).label === 'Succeeded' && runPill(turn('ok')).label === 'Succeeded' && runPill(turn(null)).label === 'Succeeded');
  check('a stored run keeps its real status', runPill({ source: 'run', status: 'failed', outcome: 'work' }).label === 'Failed'
    && runPill({ source: 'run', status: 'timed_out', outcome: null }).tone === 'danger');
  check('anything running reads Running', runPill({ source: 'turn', status: 'running', outcome: 'idle' }).running);

  check('a short entry is not clamped', !needsClamp('One rule.\nAnother rule.'));
  check('more than eight lines is clamped', needsClamp(Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n')));
  check('one long run of text is clamped', needsClamp('x'.repeat(700)));
}

if (failures.length) {
  console.error(`agents-ui: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`agents-ui: ${passed} checks passed`);
