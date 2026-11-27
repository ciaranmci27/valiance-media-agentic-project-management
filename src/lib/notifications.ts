import type { NeedsYouItem } from '@/lib/autonomy';
import type { AgentNeedsYou } from '@/lib/agents-tab';
import type { Notification } from '@/lib/types';

/**
 * Notifications and Needs you, the pure parts both the browser and the
 * server use (20261127000700_notifications_foundation.sql).
 *
 * - A notification's category says what kind of notice it is. Producers
 *   that name none get one from their entity type and title
 *   (notificationCategoryOf, the mirror of pm.notification_category).
 * - Receipts: notices that announce something listed in Needs you (a
 *   question or approval asked, an agent's findings nudge, an inbox
 *   decision). Needs you is the one place that thing is counted and acted
 *   on, so its notice never shows in Updates and never counts as unread.
 * - Snoozes hide a Needs you item or a notification until a time; they are
 *   applied when read, and a passed one is ignored.
 */

/** Notices that announce a Needs you item. Mirrors pm.notification_is_receipt. */
export const RECEIPT_CATEGORIES = ['question_asked', 'approval_requested', 'findings_nudge', 'inbox_decision'] as const;

const RECEIPTS: ReadonlySet<string> = new Set(RECEIPT_CATEGORIES);

export function isReceiptCategory(category: string | null | undefined): boolean {
  return !!category && RECEIPTS.has(category);
}

/**
 * The category of a notice its producer did not name. Mirrors
 * pm.notification_category. A receipt never comes from free text:
 * question_asked and approval_requested need `questionKind`, the kind of the
 * real question the notice's entity id names (null when it names none, or
 * when nobody looked it up); inbox_decision is only ever named by its
 * producer.
 */
export function notificationCategoryOf(entityType: string | null | undefined, title: string, questionKind: string | null = null): string {
  switch (entityType) {
    case 'question':
      if (title.includes('expired without ')) return 'question_expired';
      if (questionKind === 'approval' && title.startsWith('Approval request from ')) return 'approval_requested';
      if (questionKind === 'question' && title.startsWith('Question from ')) return 'question_asked';
      if (title.startsWith('Reply draft ready')) return 'reply_draft';
      return 'question';
    case 'project':
      if (title.endsWith('findings are waiting on you')) return 'findings_nudge';
      if (title === 'Retainer draft failed') return 'retainer_failed';
      if (title.endsWith(' ready for review')) return 'client_comm_review';
      return 'project';
    case 'member':
      if (title.endsWith(' stopped responding')) return 'agent_offline';
      if (title.endsWith(' is back')) return 'agent_back';
      if (title.endsWith(' spent its budget')) return 'agent_budget';
      if (title.includes('assistant is ')) return 'assistant_alert';
      return 'member';
    case 'invoice': return 'invoice_drafts';
    case 'reminder': return 'reminder';
    case 'schedule': return 'schedule_paused';
    case 'webhook': return 'webhook_failing';
    case null: case undefined: return 'general';
    default: return entityType;
  }
}

/**
 * The category of a notice an agent sends through POST /api/v1/notifications
 * (free text): always an update the person reads, never a receipt, except
 * the findings nudge on a project, whose title is the convention
 * sync_findings_notification clears it by.
 */
export function agentNoticeCategory(entityType: string | null | undefined, title: string): 'findings_nudge' | 'agent_message' {
  return entityType === 'project' && title.endsWith('findings are waiting on you') ? 'findings_nudge' : 'agent_message';
}

/** Who sent a notification, as the Notifications page shows them. */
export interface NotificationActor {
  id: string;
  name: string;
  avatar: string | null;
  /** owner, admin, member, guest or agent. */
  role: string;
}

/** A notification as the app reads it: its category always set, and its sender when the server named one. */
export type NotificationView = Notification & { category: string; actor?: NotificationActor | null };

/** The longest link a notification keeps. */
export const NOTIFICATION_LINK_MAX = 500;

/**
 * A notification's link as the app may follow it: a path in this app
 * ("/projects/abc?tab=tasks"), never a URL to another site. A full URL,
 * a protocol-relative "//host", a backslash, a control character or
 * anything over NOTIFICATION_LINK_MAX is no link (null). The server keeps
 * only links this allows, and the page follows only links this allows.
 */
export function safeNotificationLink(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  const trimmed = link.trim();
  if (!trimmed || trimmed.length > NOTIFICATION_LINK_MAX) return null;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/** Who a notification says it is from: a person, an agent, or the app itself. */
export type NotificationSender =
  | { kind: 'person' | 'agent'; id: string; name: string; avatar: string | null; guest: boolean }
  | { kind: 'system' };

/**
 * The sender line of a notification: the member who caused it (from the
 * server's actor, else the team list by actor_id), or the app itself when
 * nobody did. An actor the reader cannot see reads as "Someone", never as
 * the app, so a member's notice never passes for a system message.
 */
export function notificationSender(
  row: Pick<NotificationView, 'actor_id' | 'actor'>,
  team: readonly { id: string; name: string; avatar?: string | null; role: string }[] = [],
): NotificationSender {
  const actorId = row.actor?.id ?? row.actor_id ?? null;
  if (!actorId) return { kind: 'system' };
  const known = row.actor ?? team.find((member) => member.id === actorId) ?? null;
  const role = known?.role ?? 'member';
  return {
    kind: role === 'agent' ? 'agent' : 'person',
    id: actorId,
    name: known?.name?.trim() || 'Someone',
    avatar: known?.avatar ?? null,
    guest: role === 'guest',
  };
}

/** The sender in words: "From Casey Brooks (guest)", "From Atlas (agent)", "From you", "From the app". */
export function notificationSenderLabel(sender: NotificationSender, viewerId: string | null = null): string {
  if (sender.kind === 'system') return 'From the app';
  if (viewerId && sender.id === viewerId) return 'From you';
  return `From ${sender.name}${sender.guest ? ' (guest)' : sender.kind === 'agent' ? ' (agent)' : ''}`;
}

/**
 * A row's category, worked out when it has none (a database before the
 * migration, the demo). No question is looked up here, so a question's
 * notice is never taken for a receipt.
 */
export function withCategory(row: Notification): NotificationView {
  return { ...row, category: row.category ?? notificationCategoryOf(row.entity_type, row.title) };
}

/** The Notifications page's views: Needs you, Updates, Done. */
export type NotificationsView = 'needs' | 'updates' | 'done';

/** The view a ?view= asks for; anything else is Needs you. */
export function notificationsView(value: string | null | undefined): NotificationsView {
  return value === 'updates' || value === 'done' ? value : 'needs';
}

/** The page's one line: "3 need you, 2 unread", "You are all caught up". */
export function notificationsSummary(needs: number, unread: number): string {
  const parts = [
    ...(needs > 0 ? [`${needs} ${needs === 1 ? 'needs' : 'need'} you`] : []),
    ...(unread > 0 ? [`${unread} unread`] : []),
  ];
  return parts.length ? parts.join(', ') : 'You are all caught up';
}

/** The bell's count in words: one number, each thing once. */
export function bellCountLabel(needs: number, unread: number): string {
  const total = needs + unread;
  if (total === 0) return 'Nothing new';
  return notificationsSummary(needs, unread);
}

/** Which Updates list: open ones, unread ones, or the ones marked done. */
export type NotificationFeedView = 'updates' | 'unread' | 'done';

export const NOTIFICATION_FEED_VIEWS: readonly NotificationFeedView[] = ['updates', 'unread', 'done'];

/** One page of Updates and the unread count, as GET /api/workspace/notifications answers. */
export interface NotificationPage {
  items: NotificationView[];
  unread: number;
  /** How many the view holds in all ("Show 24 more of 76"); null when the database cannot say yet. */
  total?: number | null;
  /** Pass back as `before` for the next page; null on the last one. */
  next_cursor: string | null;
}

/** Updates grouped by what they are about: the latest row of each group, with its counts. */
export interface NotificationGroup {
  latest: NotificationView;
  group_key: string;
  group_count: number;
  unread_count: number;
}

export interface NotificationGroupPage {
  groups: NotificationGroup[];
  next_cursor: string | null;
}

/** A keyset cursor: the last row's sort time and id. */
export function encodeCursor(at: string, id: string): string {
  return `${at}|${id}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split('|');
  if (!at || !id || !UUID.test(id) || Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}

// ── Snoozes ─────────────────────────────────────────────────────────────

export const SNOOZE_KINDS = ['question', 'task', 'suggestion', 'notification'] as const;
export type SnoozeKind = (typeof SNOOZE_KINDS)[number];

export interface Snooze {
  item_kind: SnoozeKind;
  item_id: string;
  until: string;
}

/** The longest a snooze may last. */
export const SNOOZE_MAX_DAYS = 90;

/** The snoozes still in force at `now`, by `kind:id`. */
export function activeSnoozes(snoozes: readonly Snooze[], now: number): Set<string> {
  return new Set(snoozes.filter((s) => Date.parse(s.until) > now).map((s) => `${s.item_kind}:${s.item_id}`));
}

/** When the next snooze in force ends (ms since epoch), or null: the moment a hidden item comes back. */
export function nextSnoozeWake(snoozes: readonly Snooze[], now: number): number | null {
  let next: number | null = null;
  for (const s of snoozes) {
    const at = Date.parse(s.until);
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * Needs you without what the person snoozed: a question by its id, a task's
 * rows (blocked, merge, review, due) by the task, a block that names a
 * snoozed question with it.
 */
export function needsYouWithoutSnoozed(items: NeedsYouItem[], hidden: ReadonlySet<string>): NeedsYouItem[] {
  if (hidden.size === 0) return items;
  return items.filter((item) => {
    if (item.openQuestion && hidden.has(`question:${item.openQuestion.id}`)) return false;
    if (item.questionId && hidden.has(`question:${item.questionId}`)) return false;
    if (item.task && hidden.has(`task:${item.task.id}`)) return false;
    return true;
  });
}

/** An agent's slice of Needs you without what the person snoozed, its counts recomputed. */
export function agentNeedsYouWithoutSnoozed(needs: AgentNeedsYou, hidden: ReadonlySet<string>): AgentNeedsYou {
  if (hidden.size === 0) return needs;
  const questions = needs.questions.filter((q) => !hidden.has(`question:${q.id}`));
  const blocked = needs.blocked.filter((b) => !hidden.has(`task:${b.task.id}`) && !(b.questionId && hidden.has(`question:${b.questionId}`)));
  const inReview = needs.inReview.filter((r) => !hidden.has(`task:${r.task.id}`));
  const pendingSuggestions = needs.pendingSuggestions.filter((s) => !hidden.has(`suggestion:${s.id}`));
  return {
    questions,
    blocked,
    inReview,
    suggestions: pendingSuggestions.length,
    pendingSuggestions,
    total: questions.length + blocked.length + inReview.length + pendingSuggestions.length,
  };
}
