/**
 * The sidebar's shape: which entries show at once and which sit under More,
 * and when the sidebar nudges someone to set up AI. Pure, so
 * scripts/verify-navigation.ts checks it alone.
 */

/**
 * Entries people open now and then rather than every day: under More, one
 * extra tap away. Everyday work stays in view: Dashboard, My Tasks, Inbox,
 * Projects, AI and Notifications. Finances is whichever of its names the
 * person sees (Finances, My earnings, Time), so all three paths are listed.
 */
export const NAV_MORE_HREFS: readonly string[] = ['/leads', '/contacts', '/team', '/finances', '/time'];

/** More holds at least this many entries; fewer show in the list itself, since a group of one saves nothing. */
export const NAV_MORE_MIN = 2;

/**
 * Splits the placed entries (core and the install's own, in order) into the
 * ones shown and the ones under More. A core entry goes under More when it
 * is on NAV_MORE_HREFS. An install's entry stays beside the entry it was
 * placed after: under More when that one is, in view otherwise (its own
 * `after`), so an entry placed after Leads sits with Leads.
 */
export function splitNav<T extends { href: string }>(entries: readonly T[], coreHrefs: ReadonlySet<string>, moreHrefs: readonly string[] = NAV_MORE_HREFS): { main: T[]; more: T[] } {
  const main: T[] = [];
  const more: T[] = [];
  let previousInMore = false;
  for (const entry of entries) {
    const inMore: boolean = coreHrefs.has(entry.href) ? moreHrefs.includes(entry.href) : previousInMore;
    (inMore ? more : main).push(entry);
    previousInMore = inMore;
  }
  if (more.length >= NAV_MORE_MIN) return { main, more };
  return { main: [...entries], more: [] };
}

/** Whether a path is this entry's page or below it. */
export const navActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

// ── The AI nudge ─────────────────────────────────────────────────────────

export type AiNudge = 'owner' | 'member';

export interface AiNudgeInput {
  /** The person's role. */
  role: string | null | undefined;
  /** They see AI at all (the agents module is on and they are a person). */
  aiEntry: boolean;
  /** Any agent exists in the workspace: a company agent or anyone's assistant. */
  hasAgents: boolean;
  /** Assistants are on for the workspace. */
  assistantsOn: boolean;
  /** The person has an assistant. */
  hasAssistant: boolean;
  /** Chat apps the workspace connected that are switched on (where the assistant can be reached). */
  chatApps: number;
  /** Of those, how many the person linked their own account to. */
  linkedChats: number | null;
}

/**
 * The one nudge, until AI is set up:
 * - owner: an Owner, and no agent or assistant exists yet. "Set up AI".
 * - member: anyone else whose assistant is waiting on them to connect a
 *   chat account (assistants on, they have one, a chat app is there and
 *   none is linked). "Connect chat". Unknown links (still loading) never nudge.
 * Null otherwise.
 */
export function aiNudge(input: AiNudgeInput): AiNudge | null {
  if (!input.aiEntry) return null;
  if (input.role === 'owner') return input.hasAgents ? null : 'owner';
  if (!input.assistantsOn || !input.hasAssistant || input.chatApps === 0) return null;
  return input.linkedChats === 0 ? 'member' : null;
}

/** What each nudge says and where its one action goes. */
export const AI_NUDGE_COPY: Record<AiNudge, { title: string; line: string; action: string; href: string }> = {
  owner: {
    title: 'Put AI to work',
    line: 'Give your team assistants or hire an agent. It takes a few minutes.',
    action: 'Set up AI',
    href: '/ai?tab=setup',
  },
  member: {
    title: 'Talk to your assistant',
    line: 'Link your chat account so it can answer you there.',
    action: 'Connect chat',
    href: '/ai?tab=assistant#chat-accounts',
  },
};

/** Where a dismissed nudge is remembered, per person and kind (this browser only). */
export const aiNudgeDismissKey = (memberId: string, nudge: AiNudge) => `ai-nudge-dismissed:${memberId}:${nudge}`;
