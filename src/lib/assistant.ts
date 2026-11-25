import { z } from 'zod';

/**
 * The personal Assistant as people see it: one plain page per person (My
 * Assistant), separate from the technical Agents area and from inbox
 * routing. Behind it is the person's personal agent (lib/personal-agents.ts);
 * nothing here names keys, scopes, templates or rules.
 *
 * The four switches and what each one does (the server enforces each, and
 * the agent's context pack says it in words):
 * - sort_inbox (default off): the assistant handles the person's own inbox.
 *   On, it becomes a handler of each of their personal inboxes and is given
 *   access to them, exactly as if they had shared the inbox with a helper; it
 *   then reads and sorts only those inboxes. Off removes both.
 * - create_tasks (default on): off, the server refuses every task the
 *   assistant tries to create, and its context says to suggest work to the
 *   person instead. Approval mode would not do: people without
 *   suggestions.manage could never approve what it proposed.
 * - draft_replies (default on): off, the server refuses the assistant's
 *   reply drafts.
 * - remind_me (default on): off, the server refuses reminders the assistant
 *   writes.
 *
 * Client-safe: no server code here.
 */

/** What the sidebar and the page call an assistant when the workspace names none. */
export const ASSISTANT_DEFAULT_LABEL = 'Assistant';
export const ASSISTANT_LABEL_MAX = 40;

export const assistantLabel = (label: string | null | undefined): string => label?.trim() || ASSISTANT_DEFAULT_LABEL;

export const ASSISTANT_SWITCHES = ['sort_inbox', 'create_tasks', 'draft_replies', 'remind_me'] as const;
export type AssistantSwitch = (typeof ASSISTANT_SWITCHES)[number];
export type AssistantSwitches = Record<AssistantSwitch, boolean>;

export const DEFAULT_SWITCHES: AssistantSwitches = {
  sort_inbox: false,
  create_tasks: true,
  draft_replies: true,
  remind_me: true,
};

/** Each switch for people: its label and one line on what it does. */
export const SWITCH_WORDS: Record<AssistantSwitch, { label: string; help: string }> = {
  sort_inbox: { label: 'Sort my inbox', help: 'Reads your own inbox and files what arrives.' },
  create_tasks: { label: 'Create tasks for me', help: 'Turns what you ask for into tasks.' },
  draft_replies: { label: 'Draft replies', help: 'Writes replies for you to check and send.' },
  remind_me: { label: 'Remind me', help: 'Sets reminders so nothing slips.' },
};

export const ASSISTANT_TONES = ['warm', 'brief', 'formal'] as const;
export type AssistantTone = (typeof ASSISTANT_TONES)[number];

export const TONE_WORDS: Record<AssistantTone, { label: string; says: string }> = {
  warm: { label: 'Warm', says: 'Write warmly and plainly, like a helpful colleague.' },
  brief: { label: 'Brief', says: 'Keep every message short: the answer first, no small talk.' },
  formal: { label: 'Formal', says: 'Write in a polite, professional register.' },
};

export const PERSONALITY_MAX = 1000;
export const AVATAR_TONES = 8;

/** Stored switches as they read: anything missing or not a boolean is the default. */
export function readSwitches(stored: unknown): AssistantSwitches {
  const value = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const out = { ...DEFAULT_SWITCHES };
  for (const key of ASSISTANT_SWITCHES) if (typeof value[key] === 'boolean') out[key] = value[key] as boolean;
  return out;
}

export function readTone(stored: unknown): AssistantTone {
  return (ASSISTANT_TONES as readonly string[]).includes(stored as string) ? (stored as AssistantTone) : 'warm';
}

export interface AssistantPreferences {
  tone: AssistantTone;
  personality: string | null;
  avatar_tone: number | null;
  switches: AssistantSwitches;
}

export const DEFAULT_PREFERENCES: AssistantPreferences = { tone: 'warm', personality: null, avatar_tone: null, switches: DEFAULT_SWITCHES };

/**
 * What a person's settings tell their assistant, in plain words, for its
 * context pack. One line per setting; each switch that is off says what the
 * server will refuse, so the agent never tries.
 */
export function preferencesToContext(prefs: AssistantPreferences, personName: string): string[] {
  const lines = [TONE_WORDS[prefs.tone].says];
  if (prefs.personality?.trim()) lines.push(`${personName} says about how they like to work: ${prefs.personality.replace(/\s+/g, ' ').trim()}`);
  lines.push(prefs.switches.sort_inbox
    ? `Sort my inbox is on: you handle ${personName}'s own inbox. Read it and file what arrives; only their personal inboxes, nothing shared.`
    : `Sort my inbox is off: leave ${personName}'s inbox alone.`);
  lines.push(prefs.switches.create_tasks
    ? `Create tasks for me is on: turn what ${personName} asks for into tasks.`
    : `Create tasks for me is off: never create tasks (the app refuses them). Suggest the work to ${personName} instead.`);
  lines.push(prefs.switches.draft_replies
    ? 'Draft replies is on: write reply drafts when asked.'
    : 'Draft replies is off: do not write reply drafts (the app refuses them).');
  lines.push(prefs.switches.remind_me
    ? `Remind me is on: set reminders for ${personName} so nothing slips.`
    : `Remind me is off: do not set reminders (the app refuses them).`);
  return lines;
}

/** PATCH /api/workspace/assistant: what a person changes about their own assistant. */
export const updateMyAssistantSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(60, 'At most 60 characters').optional(),
  tone: z.enum(ASSISTANT_TONES).optional(),
  personality: z.string().trim().max(PERSONALITY_MAX, `At most ${PERSONALITY_MAX} characters`).nullable().optional(),
  avatar_tone: z.number().int().min(1).max(AVATAR_TONES).nullable().optional(),
  switches: z.object(Object.fromEntries(ASSISTANT_SWITCHES.map((key) => [key, z.boolean().optional()])) as Record<AssistantSwitch, z.ZodOptional<z.ZodBoolean>>).strict().optional(),
  paused: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send something to change');
export type UpdateMyAssistant = z.infer<typeof updateMyAssistantSchema>;

/** PATCH /api/workspace/assistants/settings: the workspace switch and name (Owner). */
export const assistantSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().max(ASSISTANT_LABEL_MAX, `At most ${ASSISTANT_LABEL_MAX} characters`).regex(/^[^\r\n]*$/, 'One line').nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send enabled or label');

/** POST /api/workspace/assistant/undo: one thing the assistant did, taken back. */
export const assistantUndoSchema = z.object({
  kind: z.enum(['task_created', 'task_completed', 'inbox_sorted']),
  id: z.uuid('id must be an id'),
}).strict();
export type AssistantUndo = z.infer<typeof assistantUndoSchema>;

// ── State ─────────────────────────────────────────────────────────────────

/**
 * How the assistant is, in one word for the page:
 * - working: running.
 * - paused: its person paused it (they can resume it).
 * - getting_ready: just made, its harness has not collected its key yet.
 * - broken: paused by an admin, no key after the grace period, or its host
 *   stopped reporting well past its interval. The page says it is paused and
 *   that the admin was told; the admin is.
 */
export type AssistantState = 'working' | 'paused' | 'getting_ready' | 'broken';
export type BrokenReason = 'paused_by_admin' | 'no_key' | 'offline';

/** A new assistant has this long to get its key before it reads as broken. */
export const KEY_GRACE_MS = 15 * 60_000;
/** Offline: the host's last report is older than this many expected intervals. */
export const OFFLINE_INTERVALS = 3;

export function assistantState(input: {
  status: string | null;
  suspendedBy: string | null;
  personId: string;
  liveKeys: number;
  createdAt: string;
  health: { reportedAt: string; intervalSeconds: number } | null;
  now?: number;
}): { state: AssistantState; reason: BrokenReason | null } {
  const now = input.now ?? Date.now();
  if (input.status === 'suspended') {
    return input.suspendedBy === input.personId ? { state: 'paused', reason: null } : { state: 'broken', reason: 'paused_by_admin' };
  }
  if (input.liveKeys === 0) {
    return now - new Date(input.createdAt).getTime() < KEY_GRACE_MS ? { state: 'getting_ready', reason: null } : { state: 'broken', reason: 'no_key' };
  }
  if (input.health && now - new Date(input.health.reportedAt).getTime() > OFFLINE_INTERVALS * input.health.intervalSeconds * 1000) {
    return { state: 'broken', reason: 'offline' };
  }
  return { state: 'working', reason: null };
}

export const BROKEN_WORDS: Record<BrokenReason, string> = {
  paused_by_admin: 'An admin paused it.',
  no_key: 'It was never connected to the service that runs it.',
  offline: 'The service that runs it stopped reporting.',
};

// ── What the page reads ───────────────────────────────────────────────────

export interface ChatConnectionCard {
  id: string;
  provider: string;
  provider_label: string;
  display_name: string;
  bot_handle: string | null;
  /** A link that opens a chat with the bot, when the provider has one. */
  open_url: string | null;
}

export interface MyAssistantView {
  enabled: boolean;
  label: string;
  /** The AI agents module: assistants run on it. */
  agents_on: boolean;
  assistant: null | {
    id: string;
    name: string;
    avatar_tone: number | null;
    state: AssistantState;
    reason: BrokenReason | null;
    preferences: AssistantPreferences;
    /** Whether the person has a personal inbox for "Sort my inbox" to handle. */
    has_personal_inbox: boolean;
  };
  connections: ChatConnectionCard[];
}

export type ActivityKind = 'task_created' | 'task_completed' | 'inbox_sorted' | 'run' | 'event';

export interface AssistantActivityItem {
  id: string;
  kind: ActivityKind;
  at: string;
  /** One plain line: "Created a task: Call the bank". */
  text: string;
  /** Where it opens, when somewhere does. */
  href: string | null;
  /** The undo for it, or null when nothing can be taken back. */
  undo: AssistantUndo | null;
  /** Already undone (a task back out of Trash, a sort undone). */
  undone?: boolean;
}

export interface AssistantDraft {
  id: string;
  thread_id: string;
  subject: string | null;
  completed_at: string | null;
}

export interface AssistantActivity {
  items: AssistantActivityItem[];
  drafts: AssistantDraft[];
}

/** Owner's status list: one row per personal agent. */
export interface AssistantStatusRow {
  id: string;
  name: string;
  person: { id: string; name: string };
  state: AssistantState;
  reason: BrokenReason | null;
  created_at: string;
}

/** An assistant setup as Settings > Assistants reads it (GET /api/workspace/assistants/setups). */
export interface AssistantSetupView {
  id: string;
  match_role: string | null;
  match_group_id: string | null;
  match_group_name: string | null;
  template_key: string;
  template_label: string | null;
  enabled: boolean;
  created_at: string;
}

/** POST /api/workspace/assistants/provision's answer, as the preview reads it. */
export interface ProvisionPreview {
  dry_run: boolean;
  agents: { person: { id: string; name: string }; agent_id: string | null }[];
  total_missing: number;
  remaining: number;
  next_after: string | null;
  skipped_setups: { setup_id: string; template_key: string; reason: string }[];
}
