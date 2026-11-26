/**
 * npm run local:seed: realistic data in the local test stack, made through the
 * app's own code wherever it has a function for it (the setup wizard's first
 * Owner, invites, hiring agents, assistant setups, groups, initiatives,
 * templates, schedules, inbox, questions and approvals), so every trigger and
 * rule runs as it does in the app.
 *
 * Idempotent: each thing is looked up by its name or email first and made only
 * when missing. Generated passwords and agent keys go into
 * scripts/local/.env.test.local (gitignored) and are printed once here.
 *
 * Only ever talks to the stack in scripts/local/.env.test.local, and refuses
 * anything that is not 127.0.0.1. Never reads .env.local.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { ENV_FILE, assertLocal, readEnvFile } from './stack';

type Row = Record<string, unknown>;
interface TaskSpec {
  title: string;
  status: string;
  priority: string;
  /** Days from today; null: no due date. */
  due: number | null;
  assignees: string[];
  initiative?: boolean;
  repeat?: boolean;
  subtasks?: { title: string; status: string }[];
}
type Caller = { memberId: string; access: NonNullable<Awaited<ReturnType<typeof import('../../src/lib/api/access').resolveMemberAccess>>>; scopes: string[] | null };

if (!existsSync(ENV_FILE)) {
  console.error('No scripts/local/.env.test.local yet. Run npm run local:up first.');
  process.exit(1);
}
const fileEnv = readEnvFile();
assertLocal(fileEnv.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL');
// The app's libraries read these from process.env: only the local stack's.
for (const [key, value] of Object.entries(fileEnv)) if (!key.startsWith('LOCAL_')) process.env[key] = value;
for (const key of ['RESEND_API_KEY', 'RESEND_INBOUND_WEBHOOK_SECRET', 'PM_GITHUB_TOKEN', 'SMTP_ENCRYPTION_KEY', 'PROJECT_CREDENTIALS_ENCRYPTION_KEY']) delete process.env[key];

const APP_URL = fileEnv.NEXT_PUBLIC_APP_URL || 'http://localhost:3010';
const DOMAIN = 'acme.test';
const RELAY = 'inbox.acme.test';

const secrets: Record<string, string> = Object.fromEntries(Object.entries(fileEnv).filter(([key]) => key.startsWith('LOCAL_')));
const newSecrets: string[] = [];
function password(key: string): string {
  if (!secrets[key]) {
    // Letters and digits only, so it pastes cleanly anywhere.
    secrets[key] = `Pm-${randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14)}9`;
    newSecrets.push(key);
  }
  return secrets[key];
}

function saveSecrets() {
  const text = readFileSync(ENV_FILE, 'utf8');
  const kept = text.split(/\r?\n/).filter((line) => !/^LOCAL_[A-Z0-9_]+=/.test(line) && line !== '# Seeded logins (npm run local:seed). Not passed to the dev server.');
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const lines = [...kept, '', '# Seeded logins (npm run local:seed). Not passed to the dev server.',
    ...Object.keys(secrets).sort().map((key) => `${key}=${secrets[key]}`), ''];
  writeFileSync(ENV_FILE, lines.join('\n'));
}

const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const { createPmClient } = await import('../../src/lib/supabase/pm-client');
  const { resolveMemberAccess } = await import('../../src/lib/api/access');
  const { createFirstOwner } = await import('../../src/lib/setup/first-owner');
  const { inviteMember } = await import('../../src/lib/team/invite');
  const { hireAgent, sessionCaller } = await import('../../src/lib/api/agent-workspace');
  const { hireAgentSchema } = await import('../../src/lib/schemas/agent-workspaces');
  const { createGroup } = await import('../../src/lib/api/groups');
  const { createGroupSchema } = await import('../../src/lib/groups');
  const { createAssistantSetup, provisionAssistants } = await import('../../src/lib/api/personal-agents');
  const { createAssistantSetupSchema, provisionAssistantsSchema } = await import('../../src/lib/personal-agents');
  const { createInitiative, addEntry } = await import('../../src/lib/api/initiatives');
  const { createInitiativeSchema, createInitiativeEntrySchema } = await import('../../src/lib/initiatives');
  const { createTemplate } = await import('../../src/lib/api/task-templates');
  const { createTemplateSchedule, setTaskRepeat } = await import('../../src/lib/api/schedules');
  const { templateScheduleSchema, taskRepeatSchema } = await import('../../src/lib/schedules');
  const { askQuestion, requestApproval } = await import('../../src/lib/api/questions');
  const { askQuestionSchema, requestApprovalSchema } = await import('../../src/lib/questions');
  const { createInbox, setRelayDomain, addProjectAddress } = await import('../../src/lib/communications/inbox-settings-service');
  const { inboxSettingsSchema, projectAddressSchema } = await import('../../src/lib/communications/schemas');
  const { ingestInbound } = await import('../../src/lib/communications/email/ingest');

  const service: SupabaseClient = createPmClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const must = <T>(result: { data: T | null; error: { message: string } | null }, what: string): T => {
    if (result.error) throw new Error(`${what}: ${result.error.message}`);
    return result.data as T;
  };
  const one = async (table: string, column: string, value: string, select = 'id'): Promise<Row | null> =>
    must(await service.from(table).select(select).eq(column, value).limit(1).maybeSingle(), `read ${table}`) as Row | null;
  const callerFor = async (memberId: string, scopes: string[] | null = null): Promise<Caller> => {
    const access = await resolveMemberAccess(service, memberId);
    if (!access) throw new Error(`No access context for ${memberId}`);
    return { memberId, access, scopes };
  };
  const done = (line: string) => console.log(`  ${line}`);

  // ── 1. The Owner, as the setup wizard makes them ──────────────────────
  console.log('People');
  const ownerEmail = `owner@${DOMAIN}`;
  let owner = await one('team_members', 'email', ownerEmail);
  if (!owner) {
    await createFirstOwner(service, { name: 'Morgan Hale', email: ownerEmail, password: password('LOCAL_OWNER_PASSWORD') });
    owner = await one('team_members', 'email', ownerEmail);
    done('Owner Morgan Hale made (setup wizard path)');
  } else done('Owner exists');
  const ownerId = owner!.id as string;
  secrets.LOCAL_OWNER_EMAIL = ownerEmail;

  // The rest of the wizard: name, brand, and setup marked finished.
  const settings = must(await service.from('business_settings').select('id, setup_completed_at').limit(1).single(), 'business settings') as Row;
  if (!settings.setup_completed_at) {
    must(await service.from('business_settings').update({ business_name: 'Acme Studio', setup_completed_at: new Date().toISOString() }).eq('id', settings.id as string), 'finish setup');
    must(await service.from('workspace_brand').update({ name: 'Acme Studio' }).not('id', 'is', null), 'brand name');
    done('Workspace "Acme Studio", setup finished');
  }

  let ownerCaller = await callerFor(ownerId);

  // ── 2. The team (invited with a password, as Team > Invite does) ──────
  const people = [
    { key: 'ADMIN', name: 'Priya Shah', role: 'admin' as const, title: 'Operations lead' },
    { key: 'MEMBER', name: 'Sam Rivera', role: 'member' as const, title: 'Designer' },
    { key: 'ASSIGNED', name: 'Jordan Lee', role: 'member' as const, title: 'Contract developer' },
    { key: 'GUEST', name: 'Casey Brooks', role: 'guest' as const, title: 'Client (Brightside Co.)' },
  ];
  const ids: Record<string, string> = { OWNER: ownerId };
  for (const person of people) {
    const email = `${person.key.toLowerCase()}@${DOMAIN}`;
    secrets[`LOCAL_${person.key}_EMAIL`] = email;
    let row = await one('team_members', 'email', email);
    if (!row) {
      const result = await inviteMember({
        service, appUrl: APP_URL, inviterName: 'Morgan Hale', access: ownerCaller.access,
        input: { name: person.name, email, role: person.role, password: password(`LOCAL_${person.key}_PASSWORD`) },
      });
      row = result.member;
      must(await service.from('team_members').update({ title: person.title }).eq('id', row.id as string), 'title');
      done(`${person.role} ${person.name} invited`);
    }
    ids[person.key] = row.id as string;
  }

  // Jordan reads only the tasks assigned to them (or that they made).
  const assignedPerms = [
    { member_id: ids.ASSIGNED, permission_key: 'tasks.read', access_channel: 'app', effect: 'deny', created_by: ownerId },
    { member_id: ids.ASSIGNED, permission_key: 'tasks.read', access_channel: 'api', effect: 'deny', created_by: ownerId },
    { member_id: ids.ASSIGNED, permission_key: 'tasks.read_assigned', access_channel: 'app', effect: 'allow', created_by: ownerId },
  ];
  must(await service.from('team_member_permissions').upsert(assignedPerms, { onConflict: 'member_id,permission_key,access_channel' }), 'assigned-only permissions');

  // ── 3. Groups ────────────────────────────────────────────────────────
  console.log('Groups');
  const groupIds: Record<string, string> = {};
  for (const group of [
    { slug: 'design', name: 'Design', description: 'Brand, UI and content design.', member_ids: [ids.MEMBER], lead_ids: [ids.ADMIN] },
    { slug: 'client-services', name: 'Client services', description: 'Answers clients and keeps projects on track.', member_ids: [ids.ASSIGNED], lead_ids: [ownerId] },
  ]) {
    const existing = await one('groups', 'slug', group.slug);
    if (existing) {
      groupIds[group.slug] = existing.id as string;
      continue;
    }
    const made = await createGroup(service, ownerCaller, createGroupSchema.parse(group));
    groupIds[group.slug] = made.id;
    done(`${group.name} made`);
  }

  // ── 4. Projects, tasks, subtasks and initiatives ──────────────────────
  console.log('Projects');
  const projectSpecs = [
    {
      name: 'Website relaunch', color: '#5B8A8A', description: 'New marketing site for Brightside Co.: content, design system and launch.',
      members: [ids.ADMIN, ids.MEMBER, ids.ASSIGNED, ids.GUEST],
      initiative: { name: 'Launch the new site', description: 'Everything needed to go live by the end of the month.', status: 'active' as const, health: 'on_track' as const },
      tasks: [
        { title: 'Agree the sitemap with Brightside', status: 'done', priority: 'high', due: -6, assignees: ['ADMIN'], initiative: true },
        { title: 'Homepage design', status: 'in_review', priority: 'high', due: 2, assignees: ['MEMBER'], initiative: true,
          subtasks: [{ title: 'Hero section variants', status: 'done' }, { title: 'Mobile layout', status: 'in_progress' }, { title: 'Accessibility pass', status: 'todo' }] },
        { title: 'Build the CMS content model', status: 'in_progress', priority: 'medium', due: 5, assignees: ['ASSIGNED'], initiative: true,
          subtasks: [{ title: 'Page and post types', status: 'done' }, { title: 'Migration script for old posts', status: 'todo' }] },
        { title: 'Write launch announcement', status: 'todo', priority: 'medium', due: 9, assignees: ['MEMBER'] },
        { title: 'Set up redirects from the old URLs', status: 'todo', priority: 'urgent', due: 3, assignees: ['ASSIGNED'] },
        { title: 'Client review of staging site', status: 'backlog', priority: 'low', due: 12, assignees: ['GUEST'] },
      ],
    },
    {
      name: 'Mobile app MVP', color: '#C5A68F', description: 'iOS and Android app for booking appointments.',
      members: [ids.ADMIN, ids.MEMBER],
      initiative: { name: 'Beta release', description: 'TestFlight and Play internal testing with ten customers.', status: 'planned' as const },
      tasks: [
        { title: 'Booking flow wireframes', status: 'done', priority: 'high', due: -10, assignees: ['MEMBER'], initiative: true },
        { title: 'Push notification service', status: 'in_progress', priority: 'high', due: 4, assignees: ['ADMIN'], initiative: true,
          subtasks: [{ title: 'APNs certificates', status: 'done' }, { title: 'FCM setup', status: 'todo' }] },
        { title: 'Crash reporting', status: 'todo', priority: 'medium', due: 8, assignees: ['ADMIN'] },
        { title: 'App store screenshots', status: 'backlog', priority: 'low', due: null, assignees: [] },
      ],
    },
    {
      name: 'Q1 marketing campaign', color: '#7A6FB0', description: 'Paid social and email campaign for the spring launch.',
      members: [ids.MEMBER, ids.ASSIGNED],
      initiative: { name: 'Spring launch campaign', description: 'Creative, audiences and the email sequence.', status: 'active' as const, health: 'at_risk' as const },
      tasks: [
        { title: 'Campaign brief', status: 'done', priority: 'medium', due: -3, assignees: ['MEMBER'], initiative: true },
        { title: 'Ad creative: three concepts', status: 'in_progress', priority: 'high', due: 1, assignees: ['MEMBER'], initiative: true },
        { title: 'Email sequence copy', status: 'todo', priority: 'medium', due: 6, assignees: ['ASSIGNED'], initiative: true },
        { title: 'Weekly performance report', status: 'todo', priority: 'medium', due: 4, assignees: ['ASSIGNED'], repeat: true },
      ],
    },
  ];

  const projectIds: Record<string, string> = {};
  const taskIds: Record<string, string> = {};
  for (const spec of projectSpecs) {
    const existing = await one('projects', 'name', spec.name);
    if (existing) {
      projectIds[spec.name] = existing.id as string;
      for (const task of must(await service.from('tasks').select('id, title').eq('project_id', existing.id as string), 'tasks') as Row[]) taskIds[task.title as string] = task.id as string;
      continue;
    }
    const project = must(await service.from('projects').insert({
      name: spec.name, description: spec.description, color: spec.color, status: 'active', start_date: isoDay(-14), due_date: isoDay(30), created_by: ownerId,
    }).select('id').single(), 'project') as Row;
    const projectId = project.id as string;
    projectIds[spec.name] = projectId;
    must(await service.from('project_members').insert([ownerId, ...spec.members].map((member_id) => ({ project_id: projectId, member_id }))), 'project members');

    const initiative = await createInitiative(service, ownerCaller, projectId, createInitiativeSchema.parse({
      ...spec.initiative, owner_member_id: ownerId, start_date: isoDay(-14), target_date: isoDay(21),
    }));

    let order = 0;
    for (const task of spec.tasks as TaskSpec[]) {
      const row = must(await service.from('tasks').insert({
        project_id: projectId, title: task.title, status: task.status, priority: task.priority,
        due_date: task.due === null ? null : isoDay(task.due), sort_order: order++, created_by: ownerId, created_via: 'app',
        description: `${task.title} for ${spec.name}.`,
        ...(task.initiative ? { initiative_id: initiative.id } : {}),
      }).select('id').single(), 'task') as Row;
      const taskId = row.id as string;
      taskIds[task.title] = taskId;
      if (task.assignees.length) {
        must(await service.from('task_assignees').insert(task.assignees.map((key) => ({ task_id: taskId, member_id: ids[key] }))), 'assignees');
      }
      let subOrder = 0;
      for (const sub of task.subtasks ?? []) {
        const subRow = must(await service.from('tasks').insert({
          project_id: projectId, parent_task_id: taskId, title: sub.title, status: sub.status, priority: 'medium',
          sort_order: subOrder++, created_by: ownerId, created_via: 'app', ...(task.initiative ? { initiative_id: initiative.id } : {}),
        }).select('id').single(), 'subtask') as Row;
        if (task.assignees.length) must(await service.from('task_assignees').insert({ task_id: subRow.id, member_id: ids[task.assignees[0]] }), 'subtask assignee');
      }
    }

    await addEntry(service, ownerCaller, projectId, initiative.id, createInitiativeEntrySchema.parse({
      kind: 'update', title: 'Kickoff done', body: 'Scope agreed and the first tasks are underway.',
    }));
    await addEntry(service, ownerCaller, projectId, initiative.id, createInitiativeEntrySchema.parse({
      kind: 'issue', title: 'Waiting on final copy from the client',
    }));
    done(`${spec.name}: ${spec.tasks.length} tasks, subtasks, initiative "${spec.initiative.name}"`);
  }

  // A repeating task (Repeat on a task).
  const repeatTask = taskIds['Weekly performance report'];
  if (repeatTask && !(await one('schedules', 'task_id', repeatTask))) {
    await setTaskRepeat(service, ownerCaller, repeatTask, taskRepeatSchema.parse({ recurrence: { freq: 'weekly', interval: 1, weekdays: [1] } }));
    done('Weekly performance report repeats every Monday');
  }

  // ── 5. Agents ─────────────────────────────────────────────────────────
  console.log('Agents');
  ownerCaller = await callerFor(ownerId);
  const { granter } = sessionCaller(ownerId, ownerCaller.access);
  const agentSpecs = [
    {
      key: 'COMPANY', name: 'Atlas', title: 'Operations agent', agent_role: 'coordinator',
      description: 'The company agent: sorts the inbox, follows up on tasks and acts for whoever asks it.',
      scopes: ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'project_context.read', 'questions.ask', 'approvals.decide',
        'agents.act_for', 'notifications.send', 'inbound_email.read', 'inbound_email.triage', 'agent_activity.write'],
      projects: Object.values(projectIds),
    },
    {
      key: 'BUILDER', name: 'Forge', title: 'Builder', template_key: 'builder',
      description: 'Builds website tasks and sends finished work to review.',
      // The builder template's scopes, plus asking people (approvals before a deploy).
      scopes: ['tasks.read', 'tasks.manage_assigned', 'tasks.create', 'projects.read', 'project_context.read', 'files.read', 'time.manage_own', 'agent_activity.write', 'questions.ask'],
      projects: [projectIds['Website relaunch'], projectIds['Mobile app MVP']].filter(Boolean),
    },
    {
      key: 'REVIEWER', name: 'Lens', title: 'Reviewer', agent_role: 'reviewer',
      description: 'Reviews work in In Review and asks a person before anything ships.',
      scopes: ['tasks.read', 'tasks.manage_assigned', 'projects.read', 'project_context.read', 'questions.ask', 'agent_activity.write'],
      projects: [projectIds['Website relaunch']].filter(Boolean),
    },
  ];
  for (const spec of agentSpecs) {
    const email = `${spec.name.toLowerCase()}@agents.${DOMAIN}`;
    const existing = await one('team_members', 'email', email);
    if (existing) {
      ids[spec.key] = existing.id as string;
      continue;
    }
    const hired = await hireAgent(service, ownerCaller, granter, hireAgentSchema.parse({
      name: spec.name, title: spec.title, description: spec.description, email,
      ...(spec.template_key ? { template_key: spec.template_key } : { agent_role: spec.agent_role }),
      owner_ids: [ownerId], project_ids: spec.projects, create_key: true,
      ...(spec.scopes ? { scopes: spec.scopes } : {}),
    }), APP_URL);
    ids[spec.key] = hired.agent.id as string;
    if (hired.key?.secret) {
      secrets[`LOCAL_AGENT_${spec.key}_API_KEY`] = hired.key.secret;
      newSecrets.push(`LOCAL_AGENT_${spec.key}_API_KEY`);
    }
    done(`${spec.name} hired (${spec.template_key ?? spec.agent_role}), key scopes: ${hired.key?.scopes.join(', ') ?? 'none'}`);
  }
  // A builder task for Forge and one in review for Lens.
  for (const [title, agent] of [['Set up redirects from the old URLs', 'BUILDER'], ['Homepage design', 'REVIEWER']] as const) {
    if (taskIds[title] && ids[agent]) {
      must(await service.from('task_assignees').upsert({ task_id: taskIds[title], member_id: ids[agent] }, { onConflict: 'task_id,member_id', ignoreDuplicates: true }), 'agent assignee');
    }
  }

  // ── 6. Personal assistants ────────────────────────────────────────────
  console.log('Personal assistants');
  const setups = must(await service.from('assistant_setups').select('id, match_role'), 'assistant setups') as Row[];
  for (const role of ['owner', 'member'] as const) {
    if (setups.some((setup) => setup.match_role === role)) continue;
    await createAssistantSetup(service, ownerCaller, createAssistantSetupSchema.parse({ match_role: role }));
    done(`Assistant setup for every ${role}`);
  }
  const provisioned = await provisionAssistants(service, ownerCaller, provisionAssistantsSchema.parse({}));
  if (provisioned.agents.length) done(`Personal agents made: ${provisioned.agents.map((agent) => agent.person.name).join(', ')}`);

  // ── 7. Templates and a schedule ───────────────────────────────────────
  console.log('Templates');
  let onboarding = await one('task_templates', 'name', 'Client onboarding');
  if (!onboarding) {
    const made = await createTemplate(service, ownerCaller, {
      name: 'Client onboarding',
      description: 'Everything a new client project needs in its first two weeks.',
      guidance: 'Fill in the client name and pick the account lead. Key dates count from the kickoff.',
      key_dates: [{ key: 'kickoff', label: 'Kickoff', main: true }, { key: 'golive', label: 'Go-live' }],
      roles: [{ key: 'lead', label: 'Account lead', required: true }, { key: 'designer', label: 'Designer', default_member_id: ids.MEMBER }],
      fields: [{ key: 'client', label: 'Client name' }],
      items: [
        { key: 'welcome', title: 'Send {client} the welcome pack', role: 'lead', due_in_days: 0 },
        { key: 'access', title: 'Collect logins and brand assets from {client}', role: 'lead', due_in_days: 3,
          subtasks: [{ title: 'Domain and hosting access' }, { title: 'Brand guidelines' }] },
        { key: 'moodboard', title: 'Moodboard for {client}', role: 'designer', due_in_days: 7, depends_on: ['access'] },
        { key: 'launch', title: 'Go-live checklist for {client}', role: 'lead', anchor: 'golive', due_in_days: 0, depends_on: ['moodboard'] },
      ],
    });
    onboarding = { id: made.id };
    done('Client onboarding (company-wide)');
  }
  let report = await one('task_templates', 'name', 'Weekly campaign report');
  if (!report) {
    const made = await createTemplate(service, ownerCaller, {
      name: 'Weekly campaign report',
      project_id: projectIds['Q1 marketing campaign'],
      fields: [{ key: 'week', label: 'Week' }],
      roles: [{ key: 'analyst', label: 'Analyst', default_member_id: ids.ASSIGNED }],
      items: [
        { key: 'pull', title: 'Pull ad and email numbers for {week}', role: 'analyst', due_in_days: 0 },
        { key: 'write', title: 'Write the {week} summary', role: 'analyst', due_in_days: 1, depends_on: ['pull'] },
      ],
    });
    report = { id: made.id };
    done('Weekly campaign report (Q1 marketing campaign)');
  }
  if (!(await one('schedules', 'template_id', report.id as string))) {
    await createTemplateSchedule(service, ownerCaller, report.id as string, templateScheduleSchema.parse({
      recurrence: { freq: 'weekly', interval: 1, weekdays: [5] }, values: { week: 'this week' }, roles: { analyst: ids.ASSIGNED },
    }));
    done('Weekly campaign report runs every Friday');
  }

  // ── 8. Inbox ──────────────────────────────────────────────────────────
  console.log('Inbox');
  const inboxCtx = { service, access: ownerCaller.access, memberId: ownerId };
  await setRelayDomain(inboxCtx, RELAY);
  let inbox = await one('inboxes', 'address', `hello@${DOMAIN}`, 'id, routing_address');
  if (!inbox) {
    await createInbox(inboxCtx, inboxSettingsSchema.parse({
      name: 'Hello', address: `hello@${DOMAIN}`, routing_local_part: 'hello', routing_domain: RELAY,
      handler_member_id: ids.COMPANY ?? null, enabled: true, retention_days: 365, max_attachment_mb: 10,
      agent_readable_types: ['image', 'pdf', 'text'], summary_interval_minutes: 60, filter_auto_mail: true,
      access_member_ids: [ownerId, ids.ADMIN],
    }));
    inbox = await one('inboxes', 'address', `hello@${DOMAIN}`, 'id, routing_address');
    done(`Inbox hello@${DOMAIN} (routes from ${inbox?.routing_address as string}), handled by Atlas`);
  }
  const websiteId = projectIds['Website relaunch'];
  const projectAddress = await one('endpoints', 'routing_local_part', 'brightside', 'id, routing_address');
  if (!projectAddress && websiteId) {
    await addProjectAddress(inboxCtx, websiteId, projectAddressSchema.parse({ inbox_id: inbox!.id, routing_local_part: 'brightside', public_address: null, enabled: true }));
    done(`Project address brightside@${RELAY} files mail to Website relaunch`);
  }
  const route = inbox!.routing_address as string;
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const emails = [
    { id: 'seed-email-1', to: `brightside@${RELAY}`, from: { name: 'Casey Brooks', address: 'casey@brightside.example' }, subject: 'Homepage feedback',
      text: 'Hi Morgan,\n\nThe new homepage looks great. Could the hero headline be shorter, and can we see a version with the green palette?\n\nThanks,\nCasey', minutes: 300 },
    { id: 'seed-email-2', to: route, from: { name: 'Dana Ortiz', address: 'dana@northwind.example' }, subject: 'Quote for a new booking app',
      text: 'Hello,\n\nWe are looking for a team to build a booking app for our three clinics. Could you send a rough quote and timeline?\n\nBest,\nDana Ortiz\nNorthwind Clinics', minutes: 180 },
    { id: 'seed-email-3', to: route, from: { name: 'Stripe', address: 'receipts@stripe.example' }, subject: 'Your receipt from Acme Hosting',
      text: 'Receipt #1043. Amount paid: $49.00. Thank you for your business.', minutes: 90 },
    { id: 'seed-email-4', to: `brightside@${RELAY}`, from: { name: 'Casey Brooks', address: 'casey@brightside.example' }, subject: 'Re: Homepage feedback',
      text: 'One more thing: please keep the old blog URLs working after launch.\n\nCasey', minutes: 30, replyTo: 'seed-email-1' },
  ];
  let ingested = 0;
  for (const email of emails) {
    const messageId = `<${email.id}@seed.${DOMAIN}>`;
    if (await one('messages', 'provider_email_id', email.id)) continue;
    const parent = email.replyTo ? [`<${email.replyTo}@seed.${DOMAIN}>`] : [];
    await ingestInbound(service, {
      provider: 'seed', provider_email_id: email.id, received_at: at(email.minutes), delivered_to: [email.to],
      message_id: messageId, in_reply_to: parent, references: parent, subject: email.subject, date: at(email.minutes),
      from: { name: email.from.name, address: email.from.address }, to: [{ name: null, address: email.to }], cc: [], reply_to: [],
      headers: [], text: email.text, html: null, provider_auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, raw: null, attachments: [],
    } as unknown as Parameters<typeof ingestInbound>[1]);
    ingested++;
  }
  if (ingested) done(`${ingested} emails received (one thread with a reply, one lead, one receipt)`);

  // ── 9. Questions and approvals ───────────────────────────────────────
  console.log('Questions and approvals');
  const asked = must(await service.from('questions').select('question'), 'questions') as Row[];
  const has = (text: string) => asked.some((row) => row.question === text);
  // Each agent's key carries these (see the hires above).
  const READ_ASK = ['tasks.read', 'projects.read', 'questions.ask'];
  const agentCtx = async (key: string, scopes: string[]) => ({ db: service, access: (await callerFor(ids[key])).access, memberId: ids[key], channel: 'api' as const, scopes });
  if (ids.COMPANY && !has('Should the Northwind quote use the standard mobile app rate card?')) {
    await askQuestion(await agentCtx('COMPANY', READ_ASK), askQuestionSchema.parse({
      question: 'Should the Northwind quote use the standard mobile app rate card?', project_id: projectIds['Mobile app MVP'],
      asked_to: ownerId, choices: ['Yes, standard rates', 'No, discount 10%', 'Ask me on a call'],
    }));
    done('Atlas asks Morgan about the Northwind quote');
  }
  if (ids.BUILDER && taskIds['Set up redirects from the old URLs'] && !has('Deploy the redirect rules to production?')) {
    await requestApproval(await agentCtx('BUILDER', READ_ASK), requestApprovalSchema.parse({
      question: 'Deploy the redirect rules to production?', task_id: taskIds['Set up redirects from the old URLs'], asked_to: ownerId,
      action: { type: 'deploy', summary: 'Deploy 214 redirect rules to production', details: { environment: 'production', rules: 214 } },
    }));
    done('Forge asks Morgan to approve a deploy');
  }
  if (ids.REVIEWER && taskIds['Homepage design'] && groupIds.design && !has('Is the green palette approved for the homepage hero?')) {
    await askQuestion(await agentCtx('REVIEWER', READ_ASK), askQuestionSchema.parse({
      question: 'Is the green palette approved for the homepage hero?', task_id: taskIds['Homepage design'], asked_to_group: groupIds.design,
      choices: ['Approved', 'Not yet'],
    }));
    done('Lens asks the Design group about the palette');
  }

  // ── 10. The database's scheduler reaches the dev server ──────────────
  // pg_cron and pg_net run inside the database container, where localhost is
  // the container itself: point the scheduler (schedules, webhook retries) at
  // the host instead. The secret stays the one the app saved.
  console.log('Scheduler');
  const { ensureSchedulerSecret } = await import('../../src/lib/webhooks/retries');
  await ensureSchedulerSecret(service);
  assertLocal(process.env.DATABASE_URL, 'DATABASE_URL');
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    const port = new URL(APP_URL).port || '80';
    await db.query(`SELECT pm.store_webhook_scheduler($1, (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pm_webhook_scheduler_secret'))`,
      [`http://host.docker.internal:${port}`]);
    done(`pg_cron jobs call the app at http://host.docker.internal:${port}`);
  } finally {
    await db.end().catch(() => {});
  }

  saveSecrets();
  console.log(`
Seeded. Sign in at ${APP_URL}/login with:`);
  for (const key of ['OWNER', 'ADMIN', 'MEMBER', 'ASSIGNED', 'GUEST']) {
    const label = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member', ASSIGNED: 'Member (assigned tasks only)', GUEST: 'Guest' }[key];
    const shown = newSecrets.includes(`LOCAL_${key}_PASSWORD`) ? secrets[`LOCAL_${key}_PASSWORD`] : '(unchanged, see the env file)';
    console.log(`  ${label!.padEnd(30)} ${secrets[`LOCAL_${key}_EMAIL`]}  ${shown}`);
  }
  console.log('Passwords and agent API keys: scripts/local/.env.test.local (LOCAL_*).');
}

main().catch((error) => {
  // Whatever was made so far is kept; save its passwords so a rerun can finish.
  try {
    saveSecrets();
  } catch {
    // nothing to save
  }
  console.error(error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error));
  process.exit(1);
});
