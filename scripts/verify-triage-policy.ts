/**
 * The triage policy as a table: for each case from the triage catalog (who
 * is speaking, how the message arrived, what the item is), the decision the
 * app must make.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-triage-policy.ts
 */
import { decideItem, type Decision, type PolicyItem, type PolicyMessage } from '../src/lib/communications/triage-policy';

let passed = 0;
const failures: string[] = [];

const client: PolicyMessage = { speaker: 'client', trust: 'trusted', delivery: 'direct', addressedToAshley: true, suspicious: false };
const item = (fields: Partial<PolicyItem> = {}): PolicyItem => ({
  type: 'create_task', intent: 'new_work', addressee: 'ciaran', confidence: 'sure',
  hasProject: true, projectSource: 'mapped', projectStatus: 'active', ...fields,
});

const cases: [string, PolicyMessage, PolicyItem, Decision][] = [
  // The everyday path.
  ['a mapped client asks for work: the task applies', client, item(), 'apply'],
  ['a comment on a tracked task applies', client, item({ type: 'comment', intent: 'change' }), 'apply'],
  ['a reply owed applies', client, item({ type: 'reply_owed', intent: 'reply_owed' }), 'apply'],
  ['a filing question applies', client, item({ type: 'ask', intent: 'new_work', projectSource: null }), 'apply'],
  ['the agent is unsure: applied as unsure', client, item({ confidence: 'unsure' }), 'apply_unsure'],
  ['work aimed at a teammate: applied as unsure', client, item({ addressee: 'teammate' }), 'apply_unsure'],
  ['a cc on its own changes nothing', { ...client, delivery: 'cc' }, item(), 'apply'],
  ['a group thread on its own changes nothing', { ...client, delivery: 'group' }, item(), 'apply'],
  ['noise produces nothing', client, item({ intent: 'noise' }), 'reject'],

  // Scope and projects.
  ['a project outside the message\'s scope is proposed, never refused', client, item({ projectSource: null }), 'propose'],
  ['a finished project takes no new task', client, item({ projectStatus: 'completed' }), 'reject'],
  ['an archived project takes no new task', client, item({ projectStatus: 'archived' }), 'reject'],
  ['a reply owed on an out-of-scope project still applies', client, item({ type: 'reply_owed', intent: 'reply_owed', projectSource: null }), 'apply'],

  // Trust.
  ['an untrusted sender only proposes', { ...client, trust: 'untrusted' }, item(), 'propose'],
  ['a suspicious message only proposes', { ...client, suspicious: true }, item(), 'propose'],
  ['an unknown sender\'s money matter waits for Ciaran', { ...client, trust: 'unknown' }, item({ type: 'add_reminder', intent: 'money' }), 'propose'],
  ['an unknown sender\'s plain request applies', { ...client, trust: 'unknown' }, item(), 'apply'],
  ['account-risk machine mail sets its reminder', { ...client, speaker: 'machine', trust: 'unknown', delivery: 'broadcast' },
    item({ type: 'add_reminder', intent: 'account_risk', hasProject: false, projectSource: null }), 'apply'],

  // Delivery.
  ['a blind copy creates nothing', { ...client, delivery: 'bcc' }, item(), 'reject'],
  ['a blind copy is still filed', { ...client, delivery: 'bcc' }, item({ type: 'file_project', intent: 'context' }), 'apply'],
  ['bulk mail creates no task', { ...client, delivery: 'broadcast' }, item(), 'reject'],
  ['bulk mail can add a fact (proposed)', { ...client, delivery: 'broadcast' }, item({ type: 'add_context', intent: 'context' }), 'propose'],

  // Speakers.
  ['a stranger reaches no client work', { ...client, speaker: 'stranger' }, item({ projectSource: null }), 'propose'],
  ['a stranger may be proposed as a mapping', { ...client, speaker: 'stranger' }, item({ type: 'propose_mapping', intent: 'context', projectSource: null }), 'propose'],
  ['a prospect\'s task is proposed', { ...client, speaker: 'prospect' }, item({ projectSource: null }), 'propose'],
  ['a prospect\'s lead interaction applies', { ...client, speaker: 'prospect' },
    item({ type: 'log_interaction', intent: 'new_business', hasProject: false, projectSource: null }), 'apply'],
  ['a new lead is proposed', client, item({ type: 'create_lead', intent: 'new_business', hasProject: false, projectSource: null }), 'propose'],
  ['a context entry is proposed', client, item({ type: 'add_context', intent: 'context' }), 'propose'],

  // Ciaran.
  ['Ciaran asks Ashley for a task: applied', { ...client, speaker: 'owner' }, item({ intent: 'owner_instruction', projectSource: null }), 'apply'],
  ['Ciaran asks Ashley for a lead: applied', { ...client, speaker: 'owner' }, item({ type: 'create_lead', intent: 'owner_instruction', hasProject: false, projectSource: null }), 'apply'],
  ['Ciaran mutes a conversation', { ...client, speaker: 'owner' }, item({ type: 'mute_conversation', intent: 'owner_instruction', hasProject: false }), 'apply'],
  ['Ciaran undoes an item', { ...client, speaker: 'owner' }, item({ type: 'revert_item', intent: 'owner_instruction', hasProject: false }), 'apply'],
  ['Ciaran\'s copied promise sets a due date', { ...client, speaker: 'owner', addressedToAshley: false },
    item({ type: 'update_task', intent: 'commitment', changes: ['due_date'] }), 'apply'],
  ['Ciaran\'s copied mail to a client makes no task from his brainstorm', { ...client, speaker: 'owner', addressedToAshley: false }, item(), 'reject'],
  ['Ciaran\'s forward with no note is context only', { ...client, speaker: 'owner', ownerForwardWithoutNote: true }, item({ type: 'add_reminder', intent: 'commitment' }), 'reject'],
  ['Ciaran\'s forward with no note may add context', { ...client, speaker: 'owner', ownerForwardWithoutNote: true }, item({ type: 'add_context', intent: 'context' }), 'apply'],
  ['Ciaran asks for a task on a finished project: proposed', { ...client, speaker: 'owner' }, item({ intent: 'owner_instruction', projectStatus: 'completed' }), 'propose'],

  // Undo and mute need the right speaker.
  ['a client cannot undo anything', client, item({ type: 'revert_item', intent: 'change', hasProject: false }), 'reject'],
  ['a client cannot mute', client, item({ type: 'mute_conversation', intent: 'context', hasProject: false }), 'reject'],
  ['a teammate corrects the agent\'s untouched item', { ...client, speaker: 'teammate' }, item({ type: 'revert_item', intent: 'change', targetUntouched: true }), 'apply'],
  ['a teammate\'s revert of worked-on items is proposed', { ...client, speaker: 'teammate' }, item({ type: 'revert_item', intent: 'change', targetUntouched: false }), 'propose'],

  // Field changes.
  ['a due date the agent set moves as unsure', client, item({ type: 'update_task', intent: 'change', changes: ['due_date'], changesPersonSet: false }), 'apply_unsure'],
  ['a due date a person set waits for them', client, item({ type: 'update_task', intent: 'change', changes: ['due_date'], changesPersonSet: true }), 'propose'],
  ['assignment from a client waits for Ciaran', client, item({ type: 'update_task', intent: 'change', changes: ['assignee_ids'] }), 'propose'],
  ['status from a client waits for Ciaran', client, item({ type: 'update_task', intent: 'change', changes: ['status'] }), 'propose'],
  ['a teammate puts their own task in review', { ...client, speaker: 'teammate' }, item({ type: 'update_task', intent: 'handoff', changes: ['status'], teammateOwnReview: true }), 'apply_unsure'],
  ['an untouched draft takes the new copy', client, item({ type: 'update_task', intent: 'handoff', changes: ['description'], targetUntouched: true }), 'apply_unsure'],
  ['a worked-on task keeps its description', client, item({ type: 'update_task', intent: 'handoff', changes: ['description'], targetUntouched: false }), 'reject'],
];

for (const [label, message, planned, expected] of cases) {
  const got = decideItem(message, planned);
  if (got.decision === expected && got.reason.length > 0) passed++;
  else failures.push(`${label}: expected ${expected}, got ${got.decision} (${got.reason})`);
}

if (failures.length) {
  console.error(`triage policy: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
  process.exitCode = 1;
} else {
  console.log(`triage policy: ${passed} checks passed.`);
}
