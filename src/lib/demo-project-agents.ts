import type { AgentListItem, ProjectAgentAssignment, SettingsField, SettingsValues } from '@/lib/agent-workspace';
import { CORE_AGENT_TEMPLATES } from '@/lib/agent-templates';
import { demoAgentDetail } from '@/lib/demo-agent-profile';
import { demoProjects, demoTeam, DEMO_ADMIN_TEAM_MEMBER_ID } from '@/lib/demo-data';
import { BRIEF_SECTIONS, type BriefEntry, type BriefSection, type BriefSectionKey, type ProjectBrief } from '@/lib/project-brief';
import type { ScopedBrief, ScopeRef } from '@/lib/context-scopes';
import type { GroupMemberView, GroupRole, GroupUsage, GroupView } from '@/lib/groups';
import type { Read } from '@/lib/query-cache';

/**
 * Demo data for a project's Agents tab, its Brief, company and group
 * knowledge, groups and project setup. Writes change this module's copy
 * only: they show at once and last until a reload, never reaching a
 * database. Reads come from here through the same Read shape the real
 * screens use, so invalidateTables refreshes them as it does real ones.
 */

const now = () => new Date().toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const ATLAS = 'a1a1a1a1-0006-4000-8000-000000000006';
const SCOUT = 'a1a1a1a1-0007-4000-8000-000000000007';
const MARCUS = 'a1a1a1a1-0002-4000-8000-000000000002';
const EMILY = 'a1a1a1a1-0003-4000-8000-000000000003';
const JAKE = 'a1a1a1a1-0004-4000-8000-000000000004';
const CREST = 'c3c3c3c3-0001-4000-8000-000000000001';
const BLOOMWELL = 'c3c3c3c3-0002-4000-8000-000000000002';
const NEOFORGE = 'c3c3c3c3-0003-4000-8000-000000000003';
const SOLSTICE = 'c3c3c3c3-0004-4000-8000-000000000004';
const DESIGN_GROUP = 'e5e5e5e5-0001-4000-8000-000000000001';
const ENGINEERING_GROUP = 'e5e5e5e5-0002-4000-8000-000000000002';

const AGENT_IDS = demoTeam.filter((m) => m.role === 'agent').map((m) => m.id);

interface DemoState {
  assignments: ProjectAgentAssignment[];
  /** Agents with access to a project beyond its people (project_members rows for agents). */
  access: Map<string, Set<string>>;
  entries: (BriefEntry & { scope_type: ScopeRef['scope_type']; scope_id: string | null; is_active: boolean })[];
  groups: (GroupView & { members: { member_id: string; role: GroupRole; added_at: string }[] })[];
  /** Projects the demo setup flow made: their names, for the tab and the done step. */
  madeProjects: Map<string, string>;
}

let state: DemoState | null = null;

function seed(): DemoState {
  const assignments: ProjectAgentAssignment[] = [];
  const access = new Map<string, Set<string>>();
  // The demo's setups follow core templates, so "Set up as" and its settings agree.
  const templateFor = (agentId: string, projectName: string): Pick<ProjectAgentAssignment, 'template_key' | 'settings' | 'settings_schema'> => {
    const key = agentId === ATLAS ? 'builder' : 'weekly-reporter';
    const schema = CORE_AGENT_TEMPLATES.find((t) => t.key === key)?.settings ?? [];
    const slug = projectName.toLowerCase().split(' ')[0];
    const settings: SettingsValues = agentId === ATLAS
      ? { repository_url: `https://github.com/${slug}/app`, working_branch: 'dev', protected_branch: 'main', merge_on_green: false }
      : { report_day: 'friday', recipients_note: 'The client lead and the project owner.' };
    return { template_key: key, settings_schema: schema as SettingsField[], settings };
  };
  for (const id of AGENT_IDS) {
    const detail = demoAgentDetail(id);
    if (!detail) continue;
    assignments.push(...detail.projects.map((a) => ({ ...a, ...templateFor(id, a.project_name ?? '') })));
    for (const project of detail.project_access?.projects ?? []) {
      access.set(project.id, (access.get(project.id) ?? new Set()).add(id));
    }
  }
  const entry = (scope_type: ScopeRef['scope_type'], scope_id: string | null, section: BriefSectionKey, content: string, opts: { pinned?: boolean; agent?: boolean; age?: number } = {}) => ({
    id: nextId('demo-entry'),
    section,
    category: 'business_context' as const,
    content,
    pinned: opts.pinned ?? false,
    source: opts.agent ? 'agent' : 'human',
    file_path: null,
    created_at: daysAgo((opts.age ?? 3) + 1),
    updated_at: daysAgo(opts.age ?? 3),
    scope_type,
    scope_id,
    is_active: true,
  });
  const entries: DemoState['entries'] = [
    entry('project', BLOOMWELL, 'overview', 'A patient portal for Bloomwell Health: book appointments, message a care team, see results. Patients first, then clinic staff.', { pinned: true, age: 12 }),
    entry('project', BLOOMWELL, 'rules', 'Never log patient names, dates of birth or results. HIPAA applies to every screen and every log line.', { pinned: true, age: 10 }),
    entry('project', BLOOMWELL, 'rules', 'Every release goes to the staging app for a clinic review before the stores.', { pinned: true, age: 9 }),
    entry('project', BLOOMWELL, 'rules', 'Sign-in uses the clinic\'s single sign-on; no passwords stored in the app.', { pinned: true, age: 8 }),
    entry('project', BLOOMWELL, 'decisions', 'React Native with Expo. Native modules only where Expo has none (decided with Jake, January).', { pinned: true, age: 30 }),
    entry('project', BLOOMWELL, 'decisions', 'Appointments read from the clinic\'s scheduling API every five minutes; no writes until phase two.', { pinned: true, age: 6, agent: true }),
    entry('project', BLOOMWELL, 'links', 'Repository: github.com/bloomwell/app\nDesigns: figma.com/file/bloomwell-portal'),
    entry('project', BLOOMWELL, 'glossary', 'Care team: the doctor, nurse and coordinator assigned to one patient.', { age: 120 }),
    entry('project', BLOOMWELL, 'history', 'The first build used a web view for messaging; it failed accessibility review and was rebuilt natively.', { agent: true, age: 2 }),
    entry('project', CREST, 'overview', 'A full rebrand for Crest Financial: logo, guidelines, collateral and the website. Calm, trustworthy, modern.', { pinned: true, age: 20 }),
    entry('project', CREST, 'rules', 'Brand colors come only from the approved palette in the guidelines file.', { pinned: true, age: 18 }),
    entry('project', NEOFORGE, 'overview', 'The marketing site for NeoForge\'s Series B: fast, animated, edited by their team in the CMS.', { pinned: true, age: 25 }),
    entry('workspace', null, 'overview', 'We are a small studio building brands, sites and apps for growing companies. Clear work, on time, no surprises.', { pinned: true, age: 40 }),
    entry('workspace', null, 'rules', 'Client data stays in the client\'s own accounts. Never copy it into another client\'s project.', { pinned: true, age: 40 }),
    entry('workspace', null, 'glossary', 'Retainer: a monthly block of hours a client pays for in advance.', { age: 60 }),
    entry('group', DESIGN_GROUP, 'overview', 'Design reviews happen on Tuesdays and Thursdays. Bring the Figma link and the one decision you need.', { pinned: true, age: 14 }),
    entry('group', ENGINEERING_GROUP, 'rules', 'Every pull request gets a review from someone who did not write it.', { pinned: true, age: 21 }),
  ];
  const groups: DemoState['groups'] = [
    {
      id: DESIGN_GROUP, name: 'Design', slug: 'design', description: 'Brand, product and web design. Ask here for reviews, assets and design calls.',
      external_id: null, member_count: 0, lead_count: 0, is_member: true, created_by: DEMO_ADMIN_TEAM_MEMBER_ID, created_at: daysAgo(60), updated_at: daysAgo(10),
      members: [
        { member_id: EMILY, role: 'lead', added_at: daysAgo(60) },
        { member_id: DEMO_ADMIN_TEAM_MEMBER_ID, role: 'member', added_at: daysAgo(60) },
        { member_id: MARCUS, role: 'member', added_at: daysAgo(30) },
      ],
    },
    {
      id: ENGINEERING_GROUP, name: 'Engineering', slug: 'engineering', description: 'Builds and ships the apps and sites. Owns the build and review agents.',
      external_id: null, member_count: 0, lead_count: 0, is_member: false, created_by: DEMO_ADMIN_TEAM_MEMBER_ID, created_at: daysAgo(55), updated_at: daysAgo(4),
      members: [
        { member_id: JAKE, role: 'lead', added_at: daysAgo(55) },
        { member_id: MARCUS, role: 'member', added_at: daysAgo(40) },
        { member_id: ATLAS, role: 'member', added_at: daysAgo(20) },
      ],
    },
  ];
  return { assignments, access, entries, groups, madeProjects: new Map() };
}

function s(): DemoState {
  state ??= seed();
  return state;
}

const fakeLoad = <T>(make: () => T): (() => Promise<T>) => async () => structuredClone(make());

// ── Agents on projects ──────────────────────────────────────────────────

/** The agents a demo project's members include (its people come from the demo store). */
export function demoProjectAgentAccess(projectId: string): string[] {
  return [...(s().access.get(projectId) ?? [])];
}

export function demoProjectAgentsRead(projectId: string): Read<ProjectAgentAssignment[]> {
  return {
    key: `project-agents:demo:${projectId}`,
    tables: ['project_agents', 'project_members', 'team_members'],
    load: fakeLoad(() => s().assignments.filter((a) => a.project_id === projectId)),
  };
}

/** The demo roster as the agents list read gives it: owners, owner groups, role, status. */
export function demoAgentsListRead(): Read<AgentListItem[]> {
  return {
    key: 'agents-list:demo-projects',
    tables: ['team_members', 'agent_owners', 'project_agents', 'project_members'],
    load: fakeLoad(() => AGENT_IDS.map((id): AgentListItem => {
      const detail = demoAgentDetail(id);
      const member = demoTeam.find((m) => m.id === id);
      return {
        id,
        name: member?.name ?? 'Agent',
        title: detail?.agent.title ?? null,
        avatar_url: member?.avatar || null,
        status: member?.status === 'suspended' ? 'suspended' : 'active',
        agent_role: detail?.agent.agent_role ?? null,
        template_key: id === ATLAS ? 'builder' : 'weekly-reporter',
        owners: detail?.owners ?? [],
        owner_groups: id === ATLAS ? [{ id: ENGINEERING_GROUP, name: 'Engineering' }] : [],
      };
    })),
  };
}

export function demoPutAssignment(projectId: string, agentId: string, body: {
  status?: 'active' | 'paused';
  template_key?: string | null;
  settings?: SettingsValues;
  instructions?: string;
}, schemaOf: (templateKey: string | null) => SettingsField[]): void {
  const st = s();
  const current = st.assignments.find((a) => a.project_id === projectId && a.agent_id === agentId);
  if (current) {
    if (body.status !== undefined) current.status = body.status;
    if (body.instructions !== undefined) current.instructions = body.instructions;
    if (body.template_key !== undefined && body.template_key !== current.template_key) {
      current.template_key = body.template_key;
      current.settings_schema = schemaOf(body.template_key);
      current.settings = body.settings ?? {};
    } else if (body.settings !== undefined) {
      current.settings = body.settings;
    }
    current.updated_at = now();
    return;
  }
  const member = demoTeam.find((m) => m.id === agentId);
  const detail = demoAgentDetail(agentId);
  st.assignments.push({
    agent_id: agentId,
    agent_name: member?.name ?? 'Agent',
    avatar_url: member?.avatar || null,
    agent_role: detail?.agent.agent_role ?? null,
    status: body.status ?? 'active',
    template_key: body.template_key ?? null,
    settings: body.settings ?? {},
    instructions: body.instructions ?? '',
    settings_schema: schemaOf(body.template_key ?? null),
    created_at: now(),
    updated_at: now(),
    project_id: projectId,
    project_name: demoProjects.find((p) => p.id === projectId)?.name ?? st.madeProjects.get(projectId),
  });
  st.access.set(projectId, (st.access.get(projectId) ?? new Set()).add(agentId));
}

export function demoRemoveAssignment(projectId: string, agentId: string): void {
  const st = s();
  st.assignments = st.assignments.filter((a) => !(a.project_id === projectId && a.agent_id === agentId));
}

/** Takes an agent off a demo project: its access goes, and its setup with it (as the database trigger does). */
export function demoTakeOff(projectId: string, agentId: string): void {
  s().access.get(projectId)?.delete(agentId);
  demoRemoveAssignment(projectId, agentId);
}

// ── Briefs and knowledge ────────────────────────────────────────────────

const inScope = (ref: ScopeRef) => (e: DemoState['entries'][number]) => e.is_active && e.scope_type === ref.scope_type && (e.scope_id ?? null) === (ref.scope_id ?? null);

function sectionsOf(list: DemoState['entries']): BriefSection[] {
  return BRIEF_SECTIONS.map((section) => {
    const entries = list.filter((e) => e.section === section.key)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updated_at) - Date.parse(a.updated_at));
    return { key: section.key, label: section.label, entries, total: entries.length };
  });
}

export function demoProjectBriefRead(projectId: string): Read<ProjectBrief> {
  return {
    key: `project-brief:demo:${projectId}`,
    tables: ['project_context', 'project_goals'],
    load: fakeLoad(() => {
      const list = s().entries.filter(inScope({ scope_type: 'project', scope_id: projectId }));
      return {
        sections: sectionsOf(list),
        goals: [],
        omitted: [],
        pinned_total: list.filter((e) => e.pinned).length,
        agent_total: list.filter((e) => e.source === 'agent').length,
      };
    }),
  };
}

export function demoScopedBriefRead(ref: ScopeRef): Read<ScopedBrief> {
  return {
    key: `scoped-brief:demo:${ref.scope_type}:${ref.scope_id ?? ''}`,
    tables: ['project_context'],
    load: fakeLoad(() => {
      const list = s().entries.filter(inScope(ref));
      const group = ref.scope_type === 'group' ? s().groups.find((g) => g.id === ref.scope_id) : null;
      return { scope: ref, name: group?.name ?? null, sections: sectionsOf(list), can_edit: true, pinned_total: list.filter((e) => e.pinned).length };
    }),
  };
}

export function demoSearchEntries(ref: ScopeRef, q: string): BriefEntry[] {
  const needle = q.toLowerCase();
  return s().entries.filter(inScope(ref)).filter((e) => e.content.toLowerCase().includes(needle));
}

export function demoAddEntry(ref: ScopeRef, input: { section: BriefSectionKey; content: string; pinned: boolean }): void {
  s().entries.push({
    id: nextId('demo-entry'), section: input.section, category: 'business_context', content: input.content, pinned: input.pinned, source: 'human',
    file_path: null, created_at: now(), updated_at: now(), scope_type: ref.scope_type, scope_id: ref.scope_id ?? null, is_active: true,
  });
}

/** As the server: pinning alone keeps updated_at; a person's edit or check takes the entry over. */
export function demoPatchEntry(id: string, patch: { content?: string; pinned?: boolean; section?: BriefSectionKey; checked?: boolean; is_active?: boolean }): void {
  const entry = s().entries.find((e) => e.id === id);
  if (!entry) return;
  if (patch.pinned !== undefined) entry.pinned = patch.pinned;
  if (patch.is_active !== undefined) entry.is_active = patch.is_active;
  const touched = patch.content !== undefined || patch.section !== undefined || patch.checked === true;
  if (patch.content !== undefined) entry.content = patch.content;
  if (patch.section !== undefined) entry.section = patch.section;
  if (patch.content !== undefined || patch.checked) entry.source = 'human';
  if (touched) entry.updated_at = now();
}

// ── Groups ──────────────────────────────────────────────────────────────

function groupView(g: DemoState['groups'][number]): GroupView {
  const { members, ...rest } = g;
  return { ...rest, member_count: members.length, lead_count: members.filter((m) => m.role === 'lead').length, is_member: members.some((m) => m.member_id === DEMO_ADMIN_TEAM_MEMBER_ID) };
}

export function demoGroupsPage(search: string): { rows: GroupView[]; total: number } {
  const needle = search.toLowerCase();
  const rows = s().groups.filter((g) => !needle || g.name.toLowerCase().includes(needle)).map(groupView);
  return { rows, total: rows.length };
}

export function demoGroupRead(groupId: string): Read<GroupView> {
  return {
    key: `group:demo:${groupId}`,
    tables: ['groups', 'group_members'],
    load: async () => {
      const group = s().groups.find((g) => g.id === groupId);
      if (!group) throw new Error('No such group');
      return groupView(group);
    },
  };
}

export function demoGroupMembers(groupId: string, search: string): { rows: GroupMemberView[]; total: number } {
  const group = s().groups.find((g) => g.id === groupId);
  const needle = search.toLowerCase();
  const rows = (group?.members ?? []).map((m): GroupMemberView => {
    const member = demoTeam.find((t) => t.id === m.member_id);
    return {
      member_id: m.member_id, name: member?.name ?? 'Member', avatar_url: member?.avatar || null, title: null,
      team_role: member?.role ?? 'member', status: member?.status === 'suspended' ? 'suspended' : 'active', role: m.role, added_at: m.added_at,
    };
  }).filter((m) => !needle || m.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.role === 'lead') - Number(a.role === 'lead') || a.added_at.localeCompare(b.added_at));
  return { rows, total: rows.length };
}

export function demoGroupUsageRead(groupId: string): Read<GroupUsage> {
  return {
    key: `group-usage:demo:${groupId}`,
    tables: ['groups', 'agent_owner_groups'],
    load: async () => {
      const none = { total: 0, names: [] };
      if (groupId === ENGINEERING_GROUP) {
        return { owns_agents: { total: 1, names: ['Atlas'] }, escalations: { total: 1, names: ['Scout'] }, inboxes: { total: 1, names: ['Support'] }, initiatives: none, assistant_setups: none };
      }
      return { owns_agents: none, escalations: none, inboxes: none, initiatives: { total: 1, names: ['Brand guidelines v2'] }, assistant_setups: { total: 1, names: [] } };
    },
  };
}

export function demoAddGroupMembers(groupId: string, ids: string[], role: GroupRole, onlyNew: boolean): { added: string[]; updated: string[] } {
  const group = s().groups.find((g) => g.id === groupId);
  if (!group) return { added: [], updated: [] };
  const added: string[] = [];
  const updated: string[] = [];
  for (const id of ids) {
    const existing = group.members.find((m) => m.member_id === id);
    if (!existing) { group.members.push({ member_id: id, role, added_at: now() }); added.push(id); }
    else if (!onlyNew && existing.role !== role) { existing.role = role; updated.push(id); }
  }
  return { added, updated };
}

export function demoSetGroupRole(groupId: string, memberId: string, role: GroupRole): void {
  const member = s().groups.find((g) => g.id === groupId)?.members.find((m) => m.member_id === memberId);
  if (member) member.role = role;
}

export function demoRemoveGroupMember(groupId: string, memberId: string): void {
  const group = s().groups.find((g) => g.id === groupId);
  if (group) group.members = group.members.filter((m) => m.member_id !== memberId);
}

export function demoUpdateGroup(groupId: string, patch: { name?: string; slug?: string; description?: string }): void {
  const group = s().groups.find((g) => g.id === groupId);
  if (group) Object.assign(group, patch, { updated_at: now() });
}

export function demoCreateGroup(input: { name: string; slug: string; description: string }): GroupView {
  const group = { id: nextId('demo-group'), ...input, external_id: null, member_count: 0, lead_count: 0, is_member: false, created_by: DEMO_ADMIN_TEAM_MEMBER_ID, created_at: now(), updated_at: now(), members: [] };
  s().groups.push(group);
  return groupView(group);
}

const demoTrashedGroups = new Map<string, ReturnType<typeof s>['groups'][number]>();

export function demoTrashGroup(groupId: string): void {
  const group = s().groups.find((g) => g.id === groupId);
  if (group) demoTrashedGroups.set(groupId, group);
  s().groups = s().groups.filter((g) => g.id !== groupId);
}

/** Undo for a demo group just moved to Trash; false when it is not there. */
export function demoRestoreGroup(groupId: string): boolean {
  const group = demoTrashedGroups.get(groupId);
  if (!group) return false;
  demoTrashedGroups.delete(groupId);
  s().groups = [...s().groups, group];
  return true;
}

// ── Project setup ───────────────────────────────────────────────────────

/** What the demo setup made, recorded so its project's Agents tab and Brief show it. */
export function demoRecordSetup(projectId: string, projectName: string, input: {
  brief: { section: BriefSectionKey; content: string; pinned: boolean }[];
  agents: { agent_id: string; template_key: string | null; settings: SettingsValues; instructions: string }[];
}, schemaOf: (templateKey: string | null) => SettingsField[]): void {
  s().madeProjects.set(projectId, projectName);
  for (const entry of input.brief) demoAddEntry({ scope_type: 'project', scope_id: projectId }, entry);
  for (const agent of input.agents) demoPutAssignment(projectId, agent.agent_id, { status: 'active', ...agent }, schemaOf);
}

export const DEMO_IDS = { ATLAS, SCOUT, CREST, BLOOMWELL, NEOFORGE, SOLSTICE, DESIGN_GROUP, ENGINEERING_GROUP } as const;
