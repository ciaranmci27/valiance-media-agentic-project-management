import {
  DEFAULT_PREFERENCES,
  type AssistantActivity, type AssistantServiceView, type AssistantSetupView, type AssistantStatusRow, type MyAssistantView,
} from '@/lib/assistant';
import type { ChatConnectionView } from '@/lib/chat/types';

/**
 * Sample assistants for the demo workspace: Settings > Assistants (the agent
 * service, who gets one, Status, chat apps) and My Assistant, so both
 * render with something real to look at. Changes there are off in the demo
 * (each section says so). Client-safe.
 */

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const daysAgo = (n: number) => minutesAgo(n * 24 * 60);

const SARAH = 'a1a1a1a1-0001-4000-8000-000000000001';
const MARCUS = 'a1a1a1a1-0002-4000-8000-000000000002';
const EMILY = 'a1a1a1a1-0003-4000-8000-000000000003';
const JAKE = 'a1a1a1a1-0004-4000-8000-000000000004';
const ATLAS = 'a1a1a1a1-0006-4000-8000-000000000006';
const SCOUT = 'a1a1a1a1-0007-4000-8000-000000000007';

const SAGE = 'a5a5a5a5-0001-4000-8000-000000000001';

/** What the demo calls them, and whether they are on. */
export const DEMO_ASSISTANT_SETTINGS = { enabled: true, label: 'Assistant', custom_label: null as string | null };

export const DEMO_ASSISTANT_SERVICE: AssistantServiceView = {
  state: 'connected',
  keys: [{ id: 'a5a5a5a5-1001-4000-8000-000000000001', name: 'Agent service', prefix: 'pk_live_8f2c1a', created_at: daysAgo(21), last_used_at: minutesAgo(3) }],
  first_collected_at: daysAgo(21),
  collected: 3,
};

export const DEMO_ASSISTANT_SETUPS: AssistantSetupView[] = [
  { id: 'a5a5a5a5-2001-4000-8000-000000000001', match_role: 'member', match_group_id: null, match_group_name: null, template_key: 'personal-assistant', template_label: 'Personal assistant', enabled: true, created_at: daysAgo(21), skipped_reason: null },
  { id: 'a5a5a5a5-2002-4000-8000-000000000002', match_role: null, match_group_id: 'a5a5a5a5-3001-4000-8000-000000000001', match_group_name: 'Leadership', template_key: 'personal-assistant', template_label: 'Personal assistant', enabled: true, created_at: daysAgo(14), skipped_reason: null },
];

export const DEMO_ASSISTANT_STATUS: AssistantStatusRow[] = [
  { id: 'a5a5a5a5-0004-4000-8000-000000000004', name: 'Juno', person: { id: JAKE, name: 'Jake Thompson' }, state: 'broken', reason: 'key_lapsed', created_at: daysAgo(20) },
  { id: 'a5a5a5a5-0003-4000-8000-000000000003', name: 'Echo', person: { id: EMILY, name: 'Emily Rodriguez' }, state: 'on_hold', reason: 'paused_by_admin', created_at: daysAgo(20) },
  { id: 'a5a5a5a5-0002-4000-8000-000000000002', name: 'Max', person: { id: MARCUS, name: 'Marcus Johnson' }, state: 'working', reason: null, created_at: daysAgo(21) },
  { id: SAGE, name: 'Sage', person: { id: SARAH, name: 'Sarah Chen' }, state: 'working', reason: null, created_at: daysAgo(21) },
];

const base = (id: string, provider: string, label: string): Pick<ChatConnectionView, 'id' | 'provider' | 'provider_label' | 'inbound_url'> => ({
  id, provider, provider_label: label, inbound_url: `https://pm.example.com/api/chat/inbound/${id}`,
});

export const DEMO_CHAT_CONNECTIONS: ChatConnectionView[] = [
  {
    ...base('a5a5a5a5-4001-4000-8000-000000000001', 'slack', 'Slack'), kind: 'personal', display_name: 'Acme Studio', external_workspace_id: 'T0ACME', bot_handle: 'assistant',
    enabled: true, last_inbound_at: minutesAgo(42), last_refused_at: null, created_at: daysAgo(20), agents: [], channels: [],
  },
  {
    ...base('a5a5a5a5-4002-4000-8000-000000000002', 'telegram', 'Telegram'), kind: 'personal', display_name: 'Acme Assistant', external_workspace_id: null, bot_handle: '@acme_assistant_bot',
    enabled: true, last_inbound_at: null, last_refused_at: null, created_at: daysAgo(1), agents: [], channels: [],
  },
  {
    ...base('a5a5a5a5-4003-4000-8000-000000000003', 'discord', 'Discord'), kind: 'company', display_name: 'Acme Ops', external_workspace_id: '1234567890123456', bot_handle: 'Acme Ops',
    enabled: true, last_inbound_at: daysAgo(3), last_refused_at: minutesAgo(18), created_at: daysAgo(12),
    agents: [{ id: ATLAS, name: 'Atlas', is_default: true }, { id: SCOUT, name: 'Scout', is_default: false }],
    channels: [{ id: 'a5a5a5a5-5001-4000-8000-000000000001', channel_id: '1180000000000000001', channel_name: '#ops', agent_id: ATLAS, listen: 'mentions' }],
    candidates: [{ id: ATLAS, name: 'Atlas', can_act_for: true }, { id: SCOUT, name: 'Scout', can_act_for: true }],
    recent_channels: [{ id: '1180000000000000002', name: null, last_at: daysAgo(2) }],
  },
];

/**
 * The demo person's own assistant. Its state is one place, so a screenshot
 * of another state means changing it here alone.
 */
export const DEMO_MY_ASSISTANT: MyAssistantView = {
  enabled: true,
  label: 'Assistant',
  agents_on: true,
  assistant: {
    id: SAGE, name: 'Sage', avatar_tone: 3, state: 'working', reason: null, host_down: false, fixer: 'settings',
    preferences: { ...DEFAULT_PREFERENCES, switches: { ...DEFAULT_PREFERENCES.switches, sort_inbox: true } },
    has_personal_inbox: true,
  },
  connections: [
    { id: 'a5a5a5a5-4001-4000-8000-000000000001', provider: 'slack', provider_label: 'Slack', display_name: 'Acme Studio', bot_handle: 'assistant', workspace_id: 'T0ACME', open_url: null, enabled: true },
    { id: 'a5a5a5a5-4002-4000-8000-000000000002', provider: 'telegram', provider_label: 'Telegram', display_name: 'Acme Assistant', bot_handle: '@acme_assistant_bot', workspace_id: null, open_url: 'https://t.me/acme_assistant_bot', enabled: true },
  ],
};

export const DEMO_MY_ASSISTANT_ACTIVITY: AssistantActivity = {
  items: [
    { id: 'demo:1', kind: 'task_created', at: minutesAgo(35), text: 'Created a task: Send Crest the revised logo options', href: null, undo: null },
    { id: 'demo:2', kind: 'inbox_sorted', at: minutesAgo(80), text: 'Sorted an email: Bloomwell invoice question, filed to Bloomwell Health App', href: null, undo: null },
    { id: 'demo:3', kind: 'task_completed', at: minutesAgo(190), text: 'Finished a task: Book the NeoForge kickoff call', href: null, undo: null },
    { id: 'demo:4', kind: 'event', at: daysAgo(1), text: 'Set a reminder: follow up with Monica on Friday', href: null, undo: null },
  ],
  drafts: [],
};
