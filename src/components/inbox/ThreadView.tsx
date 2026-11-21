'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadRead, peekRead, setReadData } from '@/lib/query-cache';
import { inboxThreadRead } from '@/lib/reads';
import Link from 'next/link';
import {
  AlertTriangle, ArrowDown, ArrowLeft, AlignLeft, Bell, Bot, Check, CheckCircle2, ChevronDown, Copy, Download, ExternalLink, Eye, FileText, Filter, Flame, Forward, Hash, HelpCircle, Image as ImageIcon, Inbox,
  CircleSlash, Link2, ListChecks, Loader2, MessageSquare, MessageSquareReply, Paperclip, PenLine, Plus, RefreshCw, RotateCcw, ShieldOff, Sparkles, Square, SquareCheck, SquarePlus, Tag, Trash2, Undo2, Unlink, Video, X,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { Popover } from '@/components/ui/Popover';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { copyText } from '@/lib/task-copy';
import { toast } from '@/components/ui/Toast';
import { announceInboxChange, inboxClient } from '@/lib/communications/inbox-client';
import { MEETING_PACKAGE_LABELS, skippedReasonLabel, type AgentWorkUndo, type InboxAnswer, type MeetingDismissUndo, type InboxAttachment, type InboxLinkedTask, type InboxMessage, type InboxPlanItem, type InboxReminder, type InboxReplyPoint, type InboxThreadDetail, type InboxTriage, type ThreadProject, type TriageOutcome } from '@/lib/communications/inbox-types';
import { hasQuotedHtml, inlineImageIds, linkParts, opensAsHtml } from '@/lib/communications/email/display';
import { FilePreviewModal } from '@/components/ui/FilePreviewModal';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { outreachReason } from '@/lib/communications/outreach';
import { EmailBodyFrame } from './EmailBodyFrame';
import { ProjectChips, ThreadStateDot, TrustBadge, TrustNote, formatBytes, formatFullTime, formatListTime } from './inbox-badges';
import { ThreadProjectDialog } from './ThreadProjectDialog';
import { LinkTaskDialog } from './LinkTaskDialog';
import { SenderRuleDialog } from './SenderRuleDialog';
import { DraftRequestDialog, ReplyDraftCard } from './ReplyDraft';
import { MeetingDetails, meetingNoteLines, SuggestionRow, TranscriptReader, type MeetingSuggestion, type SuggestionEdits, type SuggestionsOutcome } from './MeetingParts';
import { DecisionCard } from './DecisionCard';
import { ThreadAttachmentsDialog, threadAttachments } from './ThreadAttachmentsDialog';
import { useInboxUpdates } from './use-inbox-updates';

interface ThreadViewProps {
  threadId: string;
  focusMessageId?: string | null;
  /** The thread is gone or out of reach. */
  onMissing?: () => void;
  /** Back to the list on narrow screens, where the list and the thread take turns. */
  onBack?: () => void;
}

const OUTCOME: Record<TriageOutcome, { label: string; icon: typeof Bot; className: string }> = {
  no_action: { label: 'No action needed', icon: CheckCircle2, className: 'text-zinc-300' },
  task: { label: 'Tasks drafted or updated', icon: SquareCheck, className: 'text-emerald-300' },
  needs_reply: { label: 'Reply suggested', icon: MessageSquareReply, className: 'text-amber-300' },
  needs_human: { label: 'Needs you', icon: HelpCircle, className: 'text-red-300' },
};

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' }).format(date);
}

/**
 * The selected thread: oldest message first, each with what the agent made of
 * it. Never sends email. Viewing is read only: the actions (project, mark
 * handled, send back) show only to members who can triage.
 */
/**
 * "Not a task" on a task the agent created from an email: it goes to Trash
 * (restorable), and the receipt stays with an Undo until the thread is left,
 * though the thread itself no longer lists a trashed task.
 */
interface TaskUndo {
  /** Trashed from this thread, by task id, with the email it was linked from. */
  trashed: Record<string, { messageId: string; task: InboxLinkedTask }>;
  /** Absent for members who cannot change tasks. */
  notATask?: (messageId: string, task: InboxLinkedTask) => Promise<void>;
  undo: (taskId: string) => Promise<void>;
  /** The same for a reminder the agent set: "Not needed" to Trash, Undo back. */
  trashedReminders: Record<string, { messageId: string; reminder: InboxReminder }>;
  /** Null when this member cannot move that reminder to Trash, or an agent did not set it. */
  notNeeded: (reminder: InboxReminder) => ((messageId: string) => Promise<void>) | null;
  undoReminder: (reminderId: string) => Promise<void>;
  /** A link the agent made to existing work, taken off here, by linkKey, with what ties it again. */
  unlinked: Record<string, { messageId: string; task: InboxLinkedTask; link: AgentWorkUndo['links'][number] }>;
  /** Absent for members who cannot triage. */
  unlink?: (messageId: string, task: InboxLinkedTask) => Promise<void>;
  relink: (key: string) => Promise<void>;
  pending: string | null;
}
const TaskUndoContext = createContext<TaskUndo>({
  trashed: {}, undo: async () => {}, trashedReminders: {}, notNeeded: () => null, undoReminder: async () => {},
  unlinked: {}, relink: async () => {}, pending: null,
});
/** One link of an email to a task, as a key: the same task can be linked more than one way. */
function linkKey(messageId: string, task: { task_id: string; relation: string }): string {
  return `${messageId}:${task.task_id}:${task.relation}`;
}
/** True when the thread is filed on several projects: each linked task then names its own. */
const ProjectLabelsContext = createContext(false);

/**
 * What a person does with the agent's plan from the thread: accept or dismiss
 * a proposal, undo one item or the whole plan, mark a reply owed as done.
 * Absent (undefined) for members who only view the inbox.
 */
type PlanAction = 'accept' | 'dismiss' | 'undo' | 'undo_plan' | 'resolve';
interface PlanActions {
  act?: (action: PlanAction, id: string) => Promise<void>;
  /** A suggestion added (as it is, or changed first) or skipped, and an undo or a skip taken back. */
  add?: (item: InboxPlanItem, edits?: SuggestionEdits) => Promise<boolean>;
  skip?: (item: InboxPlanItem) => Promise<void>;
  restore?: (item: InboxPlanItem) => Promise<void>;
  /** A card's waiting suggestions added at once. */
  addAll?: (cardKey: string, items: InboxPlanItem[]) => Promise<void>;
  /** Everything the agent did in a card taken back (Undo all), and put back (Restore all). */
  undoAll?: (cardKey: string, messageIds: string[] | null) => Promise<void>;
  restoreAll?: (cardKey: string) => Promise<void>;
  /** What each card's Undo all took back, while this thread stays open. */
  undone: Record<string, AgentWorkUndo>;
  /** An item id, or a card's bulk action ("undo-all:<card>"), while it runs. */
  pending: string | null;
  /** A meeting's Add all or Nothing to do, while it runs. */
  bulk: 'add_all' | 'nothing' | null;
}
const PlanActionsContext = createContext<PlanActions>({ pending: null, undone: {}, bulk: null });
/** Item types an undo can be taken back for: their records return from Trash (mirrors RESTORABLE in plans.ts). */
const RESTORABLE = new Set(['create_task', 'comment', 'attach_file', 'add_reminder', 'link_task', 'create_lead', 'log_interaction']);
/** Item types whose effect can be put back. */
const UNDOABLE = new Set(['create_task', 'update_task', 'comment', 'attach_file', 'add_reminder', 'update_reminder', 'complete_reminder',
  'link_task', 'reply_owed', 'mute_conversation', 'add_context', 'create_lead', 'log_interaction']);

export function ThreadView({ threadId, focusMessageId, onMissing, onBack }: ThreadViewProps) {
  const { isDemoMode } = useDemo();
  const { projects, team, deleteTask, deleteReminder, restoreRecord } = useApp();
  const { access, teamMemberId } = useAuth();
  const canTriage = hasPermission(access, 'inbound_email.triage') || hasPermission(access, 'inbound_email.manage');
  const canManageRules = hasPermission(access, 'inbound_email.manage') && !isDemoMode;
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  // A thread seen or warmed before (pointing at it in the list) paints at
  // once from the cache; the load below refreshes it behind itself.
  const [detail, setDetail] = useState<InboxThreadDetail | null>(() => peekRead(inboxThreadRead(threadId, isDemoMode)) ?? null);
  useEffect(() => {
    if (detail) setReadData(inboxThreadRead(detail.id, isDemoMode), () => detail);
  }, [detail, isDemoMode]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'handled' | 'send_back' | null>(null);
  const [projectDialog, setProjectDialog] = useState(false);
  const [linkDialog, setLinkDialog] = useState(false);
  const [ruleFor, setRuleFor] = useState<InboxMessage | null>(null);
  const [draftDialog, setDraftDialog] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [preview, setPreview] = useState<InboxAttachment | null>(null);
  // Kept per thread: switching threads starts with nothing to undo.
  const [trashedIn, setTrashedIn] = useState<{ threadId: string; tasks: TaskUndo['trashed']; reminders: TaskUndo['trashedReminders']; links: TaskUndo['unlinked'] }>(
    { threadId, tasks: {}, reminders: {}, links: {} });
  // What each card's Undo all took back, for its Restore all, while this thread stays open.
  const [undoneIn, setUndoneIn] = useState<{ threadId: string; cards: Record<string, AgentWorkUndo> }>({ threadId, cards: {} });
  const [taskPending, setTaskPending] = useState<string | null>(null);
  // A meeting's suggestions settled at once: the line it leaves, with its Undo, while this meeting stays open.
  const [bulk, setBulk] = useState<'add_all' | 'nothing' | null>(null);
  const [outcome, setOutcome] = useState<
    { threadId: string; text: string; added?: string[]; dismissed?: MeetingDismissUndo } | null
  >(null);
  const [undoingOutcome, setUndoingOutcome] = useState(false);
  const canTrashTasks = canTriage && (hasPermission(access, 'tasks.manage_all') || hasPermission(access, 'tasks.manage_assigned'));
  // Stable while open: the preview refetches whenever its file object changes.
  const previewFile = useMemo(
    () => (preview ? { name: preview.filename, file_url: attachmentViewUrl(preview.id), mime_type: previewType(preview) } : null),
    [preview],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // The decision card, and whether it shows in the thread's scroll area (else a pill brings it back).
  const decisionNode = useRef<HTMLElement | null>(null);
  const [decisionInView, setDecisionInView] = useState(true);
  const decisionRef = useCallback((node: HTMLElement | null) => {
    decisionNode.current = node;
    if (!node) return;
    // The thread's own scroll area (its ref may not be set yet when this first runs).
    const root = node.closest<HTMLElement>('[data-thread-scroll]');
    const observer = new IntersectionObserver(([entry]) => setDecisionInView(entry.isIntersecting), { root, threshold: 0.1 });
    observer.observe(node);
    return () => {
      observer.disconnect();
      setDecisionInView(true);
    };
  }, []);
  const scrolledFor = useRef<string | null>(null);
  // Only the newest request may write: a slow answer never overwrites a newer one.
  const requestRef = useRef(0);
  // Held in a ref so a parent's new callback never refetches the thread.
  const onMissingRef = useRef(onMissing);
  useEffect(() => {
    onMissingRef.current = onMissing;
  }, [onMissing]);

  const load = useCallback(async (silent = false) => {
    const requestId = ++requestRef.current;
    if (!silent) setError('');
    try {
      // Through the cache: opening joins the warm the list started on hover
      // (or uses its answer); a quiet refresh always reads again.
      const next = await loadRead(inboxThreadRead(threadId, isDemoMode), { force: silent });
      if (requestRef.current === requestId) setDetail(next);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      const message = err instanceof Error ? err.message : 'Could not load this thread';
      if (/not found/i.test(message) && onMissingRef.current) {
        toast('info', 'That thread is no longer available');
        onMissingRef.current();
        return;
      }
      if (!silent) setError(message);
    }
  }, [threadId, isDemoMode]);

  useEffect(() => {
    const requests = requestRef;
    void load();
    // Answers that land after unmount or a thread switch are dropped.
    return () => { requests.current++; };
  }, [load]);
  // This view already reloaded for its own changes; anything else refetches.
  useInboxUpdates((change) => {
    if (change?.threadId !== threadId) void load(true);
  });

  // An answer to the agent's question sends the email back to it with the answer.
  const answerQuestion = useCallback(async (messageId: string, text: string): Promise<boolean> => {
    try {
      await client.answerQuestion(threadId, messageId, text);
      toast('success', 'Answer sent. It goes back to the agent to act on.');
      announceInboxChange({ threadId });
      await load(true);
      return true;
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not send the answer');
      return false;
    }
  }, [client, threadId, load]);

  // This thread's session state, starting clean on another thread.
  const ownTrash = useCallback((prev: typeof trashedIn) => (prev.threadId === threadId ? prev : { threadId, tasks: {}, reminders: {}, links: {} }), [threadId]);
  /**
   * Keeps what an Undo all or an Unlink took back on screen (struck, with
   * Restore), though the thread no longer lists it: the task, reminder or
   * link as the thread showed it before.
   */
  const keepTaken = useCallback((undo: AgentWorkUndo) => {
    if (!detail) return;
    setTrashedIn((prev) => {
      const next = ownTrash(prev);
      const tasks = { ...next.tasks };
      const reminders = { ...next.reminders };
      const links = { ...next.links };
      for (const message of detail.messages) {
        for (const task of message.linked_tasks) {
          if (undo.tasks.includes(task.task_id) && task.relation === 'created') tasks[task.task_id] = { messageId: message.id, task };
        }
        for (const reminder of message.reminders) {
          if (undo.reminders.includes(reminder.id)) reminders[reminder.id] = { messageId: message.id, reminder };
        }
      }
      for (const link of undo.links) {
        const task = detail.messages.find((m) => m.id === link.message_id)?.linked_tasks.find((t) => t.task_id === link.task_id && t.relation === link.relation);
        if (task) links[linkKey(link.message_id, task)] = { messageId: link.message_id, task, link };
      }
      return { ...next, tasks, reminders, links };
    });
  }, [detail, ownTrash]);
  /** Forgets what is back on the thread again. */
  const dropTaken = useCallback((undo: Pick<AgentWorkUndo, 'tasks' | 'reminders' | 'links'>) => {
    setTrashedIn((prev) => {
      const next = ownTrash(prev);
      const tasks = { ...next.tasks };
      const reminders = { ...next.reminders };
      const links = { ...next.links };
      for (const id of undo.tasks) delete tasks[id];
      for (const id of undo.reminders) delete reminders[id];
      for (const link of undo.links) delete links[linkKey(link.message_id, link)];
      return { ...next, tasks, reminders, links };
    });
  }, [ownTrash]);

  const taskUndo = useMemo((): TaskUndo => {
    const own: Pick<typeof trashedIn, 'tasks' | 'reminders' | 'links'> = trashedIn.threadId === threadId ? trashedIn : { tasks: {}, reminders: {}, links: {} };
    const agentIds = new Set(team.filter((member) => member.role === 'agent').map((member) => member.id));
    return {
      trashed: own.tasks,
      trashedReminders: own.reminders,
      unlinked: own.links,
      pending: taskPending,
      // Who may bin a reminder, as the database decides it: its owner, its writer, or a manager of every task.
      notNeeded: (reminder) => !canTriage || reminder.status !== 'open' || !reminder.created_by || !agentIds.has(reminder.created_by)
        || !(reminder.mine || hasPermission(access, 'tasks.manage_all')) ? null : async (messageId) => {
        setTaskPending(reminder.id);
        try {
          if (!(await deleteReminder(reminder.id))) return;
          setTrashedIn((prev) => {
            const next = ownTrash(prev);
            return { ...next, reminders: { ...next.reminders, [reminder.id]: { messageId, reminder } } };
          });
          toast('success', `Moved "${reminder.title}" to Trash`);
          announceInboxChange({ threadId });
          void load(true);
        } finally {
          setTaskPending(null);
        }
      },
      undoReminder: async (reminderId) => {
        setTaskPending(reminderId);
        try {
          if (!(await restoreRecord('reminders', reminderId))) return;
          toast('success', 'Reminder restored');
          announceInboxChange({ threadId });
          // The struck line stays until the thread lists the reminder again, so it never blinks out.
          await load(true);
          dropTaken({ tasks: [], reminders: [reminderId], links: [] });
        } finally {
          setTaskPending(null);
        }
      },
      notATask: canTrashTasks ? async (messageId, task) => {
        setTaskPending(task.task_id);
        try {
          if (!(await deleteTask(task.task_id))) return;
          setTrashedIn((prev) => {
            const next = ownTrash(prev);
            return { ...next, tasks: { ...next.tasks, [task.task_id]: { messageId, task } } };
          });
          toast('success', `Moved "${task.title ?? 'the task'}" to Trash`);
          announceInboxChange({ threadId });
          void load(true);
        } finally {
          setTaskPending(null);
        }
      } : undefined,
      undo: async (taskId) => {
        setTaskPending(taskId);
        try {
          if (!(await restoreRecord('tasks', taskId))) return;
          toast('success', 'Task restored');
          announceInboxChange({ threadId });
          await load(true);
          dropTaken({ tasks: [taskId], reminders: [], links: [] });
        } finally {
          setTaskPending(null);
        }
      },
      unlink: canTriage && !isDemoMode ? async (messageId, task) => {
        setTaskPending(linkKey(messageId, task));
        try {
          const undo = await client.undoAgentWork(threadId, { message_ids: [messageId], task_id: task.task_id });
          keepTaken(undo);
          toast('success', `Unlinked "${task.title ?? 'the task'}"`);
          announceInboxChange({ threadId });
          void load(true);
        } catch (err) {
          toast('error', err instanceof Error ? err.message : 'Could not unlink the task');
        } finally {
          setTaskPending(null);
        }
      } : undefined,
      relink: async (key) => {
        const entry = own.links[key];
        if (!entry) return;
        setTaskPending(key);
        try {
          await client.restoreAgentWork(threadId, { plan_items: [], tasks: [], reminders: [], links: [entry.link], kept: [] });
          toast('success', `Linked "${entry.task.title ?? 'the task'}" again`);
          announceInboxChange({ threadId });
          await load(true);
          dropTaken({ tasks: [], reminders: [], links: [entry.link] });
        } catch (err) {
          toast('error', err instanceof Error ? err.message : 'Could not link it again');
        } finally {
          setTaskPending(null);
        }
      },
    };
  }, [trashedIn, threadId, taskPending, canTrashTasks, canTriage, isDemoMode, access, team, client, deleteTask, deleteReminder, restoreRecord, load, ownTrash, keepTaken, dropTaken]);

  const [planPending, setPlanPending] = useState<string | null>(null);
  const act = useCallback(async (action: PlanAction, id: string) => {
      setPlanPending(id);
      try {
        if (action === 'accept') {
          await client.acceptPlanItem(id);
          toast('success', 'Approved');
        } else if (action === 'dismiss') {
          await client.dismissPlanItem(id);
          toast('success', 'Dismissed');
        } else if (action === 'undo') {
          const result = await client.undoPlanItem(id);
          toast(result.changed_since ? 'info' : 'success', result.changed_since ? 'Someone changed it since, so it was left as it is' : result.skipped ? 'That one cannot be undone here' : 'Undone');
        } else if (action === 'undo_plan') {
          await client.undoPlan(id);
          toast('success', 'Undid what was done with this email');
        } else {
          await client.resolveReplyPoint(id);
          toast('success', 'Marked as replied');
        }
        announceInboxChange({ threadId });
        await load(true);
      } catch (err) {
        toast('error', err instanceof Error ? err.message : 'That did not go through');
      } finally {
        setPlanPending(null);
      }
  }, [client, load, threadId]);

  // Add all: every waiting suggestion, as yours; one Undo takes the set back, newest first.
  const addAll = useCallback(async () => {
    setBulk('add_all');
    try {
      const result = await client.addAllSuggestions(threadId);
      const added = result.added.length;
      const failed = result.failed.length;
      if (failed) {
        toast('error', added
          ? `${failed} did not go through: ${result.failed.map((f) => f.label).join(', ')}. ${result.failed[0].error}`
          : `None were added. ${result.failed[0].error}`);
      }
      // The line says what was added; with nothing added there is nothing to say or undo.
      if (added) setOutcome({ threadId, text: `Added ${added} ${added === 1 ? 'suggestion' : 'suggestions'}`, added: result.added });
      announceInboxChange({ threadId });
      await load(true);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That did not go through');
    } finally {
      setBulk(null);
    }
  }, [client, threadId, load]);
  // Nothing to do: every suggestion skipped, the meeting handled and marked.
  const nothingToDo = useCallback(async () => {
    setBulk('nothing');
    try {
      const result = await client.nothingToDo(threadId);
      setOutcome({ threadId, text: 'Marked nothing to do', dismissed: { skipped: result.skipped, handled: result.handled } });
      announceInboxChange({ threadId });
      await load(true);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That did not go through');
    } finally {
      setBulk(null);
    }
  }, [client, threadId, load]);
  const undoOutcome = useCallback(async () => {
    if (!outcome || outcome.threadId !== threadId) return;
    setUndoingOutcome(true);
    try {
      if (outcome.added) {
        // Through the usual per-item undo: one a person changed since stays as it is.
        let kept = 0;
        const remaining = [...outcome.added];
        while (remaining.length) {
          const result = await client.undoPlanItem(remaining[remaining.length - 1]);
          if (result.changed_since) kept++;
          remaining.pop();
          setOutcome({ ...outcome, added: [...remaining] });
        }
        toast(kept ? 'info' : 'success', kept ? `Undone. ${kept} changed since, so ${kept === 1 ? 'it stays' : 'they stay'}.` : 'Undone');
      } else if (outcome.dismissed) {
        await client.undoNothingToDo(threadId, outcome.dismissed);
        toast('success', 'Undone');
      }
      setOutcome(null);
      announceInboxChange({ threadId });
      await load(true);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not undo');
    } finally {
      setUndoingOutcome(false);
    }
  }, [outcome, threadId, client, load]);
  // One suggestion, added (as it is, or changed first) or skipped.
  const addSuggestion = useCallback(async (item: MeetingSuggestion, edits: SuggestionEdits = {}): Promise<boolean> => {
    setPlanPending(item.id);
    try {
      await client.acceptPlanItem(item.id, edits);
      toast('success', 'Added');
      announceInboxChange({ threadId });
      await load(true);
      return true;
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That did not go through');
      return false;
    } finally {
      setPlanPending(null);
    }
  }, [client, threadId, load]);
  const skipSuggestion = useCallback(async (item: MeetingSuggestion) => {
    setPlanPending(item.id);
    try {
      await client.dismissPlanItem(item.id);
      toast('success', 'Skipped');
      announceInboxChange({ threadId });
      await load(true);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That did not go through');
    } finally {
      setPlanPending(null);
    }
  }, [client, threadId, load]);
  // An undo or a skip taken back: the work returns, or the suggestion waits again.
  const restoreItem = useCallback(async (item: InboxPlanItem) => {
    setPlanPending(item.id);
    try {
      await client.restorePlanItem(item.id);
      toast('success', item.state === 'dismissed' ? 'Waiting for your OK again' : 'Restored');
      announceInboxChange({ threadId });
      await load(true);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not restore it');
    } finally {
      setPlanPending(null);
    }
  }, [client, threadId, load]);
  const isMeetingThread = detail?.channel === 'meeting';
  // A meeting adds all through its own call (one Undo line); an email adds its waiting suggestions one by one.
  const addAllIn = useCallback(async (cardKey: string, items: InboxPlanItem[]) => {
    if (isMeetingThread) return addAll();
    setPlanPending(`add-all:${cardKey}`);
    let added = 0;
    const failed: string[] = [];
    try {
      for (const item of items) {
        try {
          await client.acceptPlanItem(item.id);
          added++;
        } catch (err) {
          failed.push(`${item.title || item.label}: ${err instanceof Error ? err.message : 'it did not go through'}`);
        }
      }
      if (failed.length) toast('error', `${added ? `Added ${added}. ` : ''}${failed.length} did not go through. ${failed[0]}`);
      else toast('success', added === 1 ? 'Added' : `Added ${added}`);
      announceInboxChange({ threadId });
      await load(true);
    } finally {
      setPlanPending(null);
    }
  }, [isMeetingThread, addAll, client, threadId, load]);
  const undoAll = useCallback(async (cardKey: string, messageIds: string[] | null) => {
    setPlanPending(`undo-all:${cardKey}`);
    try {
      const undo = await client.undoAgentWork(threadId, { message_ids: messageIds });
      keepTaken(undo);
      // A second Undo all adds to the first, so Restore all still puts back both.
      setUndoneIn((prev) => {
        const cards = prev.threadId === threadId ? prev.cards : {};
        const before = cards[cardKey];
        const merged: AgentWorkUndo = before ? {
          plan_items: [...new Set([...before.plan_items, ...undo.plan_items])],
          tasks: [...new Set([...before.tasks, ...undo.tasks])],
          reminders: [...new Set([...before.reminders, ...undo.reminders])],
          links: [...before.links, ...undo.links.filter((l) => !before.links.some((b) => linkKey(b.message_id, b) === linkKey(l.message_id, l)))],
          kept: undo.kept,
        } : undo;
        return { threadId, cards: { ...cards, [cardKey]: merged } };
      });
      const count = undo.plan_items.length + undo.tasks.length + undo.reminders.length + undo.links.length;
      toast(count ? 'success' : 'info', count ? `Took back ${count} ${count === 1 ? 'thing' : 'things'}. Restore all puts them back.` : 'Nothing here could be taken back');
      announceInboxChange({ threadId });
      await load(true);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not undo it');
    } finally {
      setPlanPending(null);
    }
  }, [client, threadId, keepTaken, load]);
  const restoreAll = useCallback(async (cardKey: string) => {
    const undo = undoneIn.threadId === threadId ? undoneIn.cards[cardKey] : undefined;
    if (!undo) return;
    setPlanPending(`restore-all:${cardKey}`);
    try {
      const result = await client.restoreAgentWork(threadId, undo);
      toast(result.kept.length ? 'info' : 'success', result.kept.length
        ? `Restored ${result.restored}. ${result.kept.length} could not be put back: ${result.kept.map((k) => k.label).join(', ')}.`
        : 'Restored');
      announceInboxChange({ threadId });
      await load(true);
      dropTaken(undo);
      setUndoneIn((prev) => {
        const cards = { ...prev.cards };
        delete cards[cardKey];
        return { ...prev, cards };
      });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not restore it');
    } finally {
      setPlanPending(null);
    }
  }, [client, threadId, undoneIn, dropTaken, load]);
  const planActions = useMemo((): PlanActions => ({
    pending: planPending,
    bulk,
    undone: undoneIn.threadId === threadId ? undoneIn.cards : {},
    ...(canTriage && !isDemoMode ? {
      act, add: addSuggestion, skip: skipSuggestion, restore: restoreItem, addAll: addAllIn, undoAll, restoreAll,
    } : canTriage ? { act } : {}),
  }), [planPending, bulk, undoneIn, threadId, canTriage, isDemoMode, act, addSuggestion, skipSuggestion, restoreItem, addAllIn, undoAll, restoreAll]);

  // While the agent writes a requested draft, look again every few seconds,
  // for ten minutes at most; the request closes itself after half an hour.
  const drafting = detail?.reply_draft?.status === 'requested';
  const draftAskedAt = drafting ? detail?.reply_draft?.created_at ?? null : null;
  useEffect(() => {
    if (!draftAskedAt) return;
    const timer = window.setInterval(() => {
      if (Date.now() - Date.parse(draftAskedAt) > 10 * 60_000) {
        window.clearInterval(timer);
        return;
      }
      void load(true);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [draftAskedAt, load]);

  // Land on the newest message (or the linked one) once per thread. A
  // meeting opens at the top, its details and words first, with its
  // suggestions under them, unless a link names one of its packages.
  useEffect(() => {
    if (!detail || scrolledFor.current === detail.id) return;
    scrolledFor.current = detail.id;
    const target = focusMessageId ?? (detail.channel === 'meeting' ? null : detail.messages[detail.messages.length - 1]?.id);
    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      const node = target ? document.getElementById(`email-${target}`) : null;
      scrollRef.current.scrollTop = node ? Math.max(0, node.offsetTop - 12) : 0;
    });
  }, [detail, focusMessageId]);

  const agentName = detail?.inbox.handler?.name ?? 'the agent';
  // Done with the thread: the toast says which reply reminders it closed with it.
  const markHandled = async () => {
    setBusy('handled');
    try {
      const closed = (await client.markHandled(threadId)).closed_reminders ?? [];
      const short = (title: string) => (title.length > 60 ? `${title.slice(0, 57)}...` : title);
      toast('success', closed.length === 1 ? `Marked handled, and "${short(closed[0])}" is done`
        : closed.length > 1 ? `Marked handled, and ${closed.length} reply reminders are done` : 'Marked handled');
      await load(true);
      announceInboxChange({ threadId });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };
  const after = async (action: () => Promise<unknown>, success: string, kind: 'handled' | 'send_back') => {
    setBusy(kind);
    try {
      await action();
      toast('success', success);
      await load(true);
      // The list and the sidebar badge refresh from this; this view already has.
      announceInboxChange({ threadId });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  const backButton = onBack && (
    <button
      type="button"
      onClick={onBack}
      className="-ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:hidden"
    >
      <ArrowLeft size={16} aria-hidden="true" />
      All email
    </button>
  );
  const backBar = backButton && <div className="border-b border-white/[0.06] px-4 py-2 lg:hidden">{backButton}</div>;

  if (error && !detail) {
    return (
      <>
      {backBar}
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle size={28} className="text-red-400" aria-hidden="true" />
        <p className="text-sm text-zinc-300">{error}</p>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => void load()}>Try again</Button>
      </div>
      </>
    );
  }
  if (!detail) {
    return (
      <>
      {backBar}
      <div className="space-y-4 p-5" aria-busy="true" aria-label="Loading thread">
        <div className="h-5 w-2/3 animate-pulse rounded bg-white/[0.08] motion-reduce:animate-none" />
        {[0, 1].map((i) => (
          <div key={i} className="space-y-2 rounded-xl border border-white/[0.06] p-4">
            <div className="h-3.5 w-40 animate-pulse rounded bg-white/[0.08] motion-reduce:animate-none" />
            <div className="h-3 w-full animate-pulse rounded bg-white/[0.05] motion-reduce:animate-none" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-white/[0.05] motion-reduce:animate-none" />
          </div>
        ))}
      </div>
      </>
    );
  }

  const latest = detail.messages[detail.messages.length - 1];
  const canHandle = detail.state === 'needs_you' || detail.state === 'new' || detail.state === 'needs_reply';
  const canSendBack = !!latest && latest.status !== 'new';
  const projectColor = (projectId: string) => projects.find((p) => p.id === projectId)?.color;
  const confirmProject = async (project: ThreadProject) => {
    try {
      await client.addProject(detail.id, { project_id: project.id });
      toast('success', `Confirmed ${project.name}`);
      await refresh();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not confirm the project');
    }
  };
  const removeProject = async (project: ThreadProject) => {
    try {
      await client.removeProject(detail.id, project.id);
      toast('success', `Removed ${project.name}`);
      await refresh();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not remove the project');
    }
  };
  const multiDay = new Set(detail.messages.map((message) => dayLabel(message.received_at))).size > 1;
  const agentAvatar = team.find((member) => member.id === detail.inbox.handler?.id)?.avatar || undefined;
  const refresh = async () => {
    await load(true);
    announceInboxChange({ threadId });
  };
  const fileCount = threadAttachments(detail.messages).length;
  const downloadAttachment = async (attachment: InboxAttachment) => {
    try {
      const link = await client.attachmentUrl(attachment.id);
      const anchor = document.createElement('a');
      anchor.href = link.url;
      anchor.rel = 'noopener noreferrer';
      anchor.download = link.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not download the file');
    }
  };
  // Drafts need an agent on the inbox, and the real app (not demo mode).
  const canDraft = canTriage && !!detail.inbox.handler && !isDemoMode;
  // The draft folds once it was used (copied, then the thread handled) or a newer email came in.
  const draft = detail.reply_draft;
  const draftFolded: 'used' | 'outdated' | null = draft?.status === 'ready' && draft.completed_at
    ? draft.copied_at && detail.messages.some((m) => !!m.reviewed_at && Date.parse(m.reviewed_at) >= Date.parse(draft.copied_at!)) ? 'used'
      : detail.messages.some((m) => Date.parse(m.received_at) > Date.parse(draft.completed_at!)) ? 'outdated' : null
    : null;
  const ownReplyReminder = detail.messages.some((m) => m.reminders.some((r) => r.mine && r.status === 'open' && /^reply to /i.test(r.title)));
  // The newest email whose question still waits: answered in the card at the end of the thread.
  const asking = canTriage && !isDemoMode && detail.state === 'needs_you'
    ? [...detail.messages].reverse().find((m) => m.status === 'needs_human' && !!m.triage?.question_for_human && !m.answer && !m.reviewed_at) ?? null
    : null;
  // An answered decision stays as one line at the end until the thread is done.
  const answered = !asking && canHandle
    ? [...detail.messages].reverse().find((m) => !!m.triage?.question_for_human && !!m.answer) ?? null
    : null;
  // A meeting: no sender to filter or trust, no mail to reply to; a recap email to the attendees instead.
  const meeting = detail.channel === 'meeting' ? detail.meeting : null;
  const isMeeting = detail.channel === 'meeting';
  // A meeting's card: every package's plan items in one place, said by its newest triage.
  const meetingItems = isMeeting ? detail.messages.flatMap((m) => m.plan?.items ?? []) : [];
  const meetingTriaged = isMeeting ? [...detail.messages].reverse().find((m) => !!m.triage) ?? null : null;
  const meetingWaiting = meetingItems.some((item) => item.state === 'pending' && item.type !== 'ask');
  // A dismissal stands until a newer package arrives.
  const dismissedCurrent = !!meeting?.dismissed && !detail.messages.some((m) => Date.parse(m.received_at) > Date.parse(meeting.dismissed!.at));
  const canSettle = isMeeting && canTriage && !isDemoMode;
  const shownOutcome = outcome?.threadId === threadId ? outcome : null;
  const menu: RowAction[] = [
    ...(canDraft && !drafting ? [{ label: isMeeting ? 'Draft a follow-up email' : 'Draft a reply', icon: <PenLine size={14} aria-hidden="true" />, onClick: () => setDraftDialog(true) }] : []),
    ...(fileCount > 0 ? [{ label: `Attachments (${fileCount})`, icon: <Paperclip size={14} aria-hidden="true" />, onClick: () => setAttachmentsOpen(true) }] : []),
    ...(canManageRules && !isMeeting ? [{ label: 'Filter mail like this', icon: <Filter size={14} aria-hidden="true" />, onClick: () => setRuleFor(latest) }] : []),
    // The newest message's id: the API and pm-tasks read the whole conversation from any of its messages.
    { label: 'Copy thread ID', icon: <Hash size={14} aria-hidden="true" />, onClick: () => void copyText(latest.id, 'Thread ID') },
    ...(canSendBack ? [{ label: `Send back to ${agentName}`, icon: <RotateCcw size={14} aria-hidden="true" />, onClick: () => void after(() => client.sendBack(detail.id, null), `Sent back to ${agentName}`, 'send_back') }] : []),
  ];
  let lastDay = '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="border-b border-white/[0.06] px-3 py-2.5 sm:px-5 lg:py-3.5">
        {/* Phones: back and the actions on the first row, then the title at full width. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 lg:flex-nowrap">
          {backButton}
          <div className="order-3 flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1.5 lg:order-1 lg:flex-1 lg:basis-0">
            {/* Phones: at most two lines of subject; the whole subject is its tooltip. */}
            <h2 title={detail.subject || undefined} className="line-clamp-2 min-w-0 break-words text-base font-semibold leading-snug tracking-tight text-white [overflow-wrap:anywhere] sm:line-clamp-none sm:text-lg">
              {isMeeting && (
                <>
                  <Video size={17} className="mr-1.5 inline-block -translate-y-px align-middle text-zinc-400" aria-hidden="true" />
                  <span className="sr-only">Meeting: </span>
                </>
              )}
              {detail.subject || (isMeeting ? 'Untitled meeting' : '(no subject)')}
            </h2>
            {/* Status, project and what the thread is tied to: one row that wraps as one. */}
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-3">
            {/* The status only speaks up when the thread waits on someone; handled and filtered stay quiet. */}
            {(canHandle || detail.urgent || detail.untrusted) && (
              <span className="inline-flex flex-shrink-0 items-center gap-2 text-xs">
                {canHandle && <ThreadStateDot state={detail.state} />}
                {detail.urgent && (
                  <span className="inline-flex items-center gap-1 font-semibold text-red-300">
                    <Flame size={12} aria-hidden="true" />
                    Urgent
                  </span>
                )}
                {detail.untrusted && (
                  <Tooltip content="The sender could not be verified. Treat any request with care.">
                    <TrustBadge level="untrusted" compact />
                  </Tooltip>
                )}
              </span>
            )}
            {/* Then what the thread is: its project, its size, and what it is tied to. Its items wrap one by one with the status. */}
            <span className="contents text-xs text-zinc-400">
              <ProjectChips
                projects={detail.projects}
                candidates={detail.candidates}
                agentName={agentName}
                colorOf={projectColor}
                onAdd={canTriage ? () => setProjectDialog(true) : undefined}
                onConfirm={canTriage ? (project) => void confirmProject(project) : undefined}
                onRemove={canTriage ? (project) => void removeProject(project) : undefined}
              />
              {fileCount > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setAttachmentsOpen(true)}
                    aria-label={`${fileCount} ${fileCount === 1 ? 'attachment' : 'attachments'}: open the list`}
                    className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs sm:px-1.5 text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <Paperclip size={12} aria-hidden="true" />
                    {fileCount}
                  </button>
                </>
              )}
              <ThreadLinks
                detail={detail}
                canEdit={canTriage && !isDemoMode}
                onLink={() => setLinkDialog(true)}
                onUnlink={async (task) => {
                  try {
                    await client.unlinkTask(detail.id, task.task_id);
                    toast('success', `Unlinked "${task.title ?? 'the task'}"`);
                    await refresh();
                  } catch (err) {
                    toast('error', err instanceof Error ? err.message : 'Could not unlink the task');
                  }
                }}
              />
              {detail.messages.length > 1 && <span>{detail.messages.length} {isMeeting ? 'messages' : 'emails'}</span>}
            </span>
            </span>
          </div>
          {canTriage ? (
            <div className="order-2 ml-auto flex flex-shrink-0 items-center gap-0.5 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
              {drafting && (
                <Tooltip content={`${agentName} is writing a draft`}>
                  <span className="inline-flex px-1.5 text-zinc-400">
                    <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    <span className="sr-only">{agentName} is writing a draft</span>
                  </span>
                </Tooltip>
              )}
              <RowActionsMenu actions={menu} label="More thread actions" triggerClassName="!rounded-md" />
              {busy === 'send_back' && <Loader2 size={14} className="mx-1 animate-spin text-zinc-400 motion-reduce:animate-none" aria-label={`Sending back to ${agentName}`} />}
              {/* Only offered when there is something to clear. */}
              {canHandle && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="!rounded-md !py-1 text-zinc-100"
                  icon={busy === 'handled' ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                  disabled={busy !== null}
                  onClick={() => void markHandled()}
                >
                  Mark handled
                </Button>
              )}
            </div>
          ) : (
            <span className="order-2 ml-auto inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-zinc-300">
              <Eye size={11} aria-hidden="true" />
              View only
            </span>
          )}
        </div>

        {meeting && <MeetingDetails meeting={meeting} />}

        {detail.summary && (
          <p className="mt-2.5 flex items-start gap-2 text-[13px] leading-snug text-zinc-300">
            <Avatar name={agentName} src={agentAvatar} size="xs" className="mt-px flex-shrink-0" />
            <span><span className="sr-only">Where it stands, by {agentName}: </span>{detail.summary}</span>
          </p>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} data-thread-scroll className="relative min-h-0 flex-1 overflow-y-auto px-2 py-3 sm:px-5 sm:py-4">
        <TaskUndoContext.Provider value={taskUndo}>
        <PlanActionsContext.Provider value={planActions}>
        <ProjectLabelsContext.Provider value={detail.projects.length > 1}>
        <ol className="space-y-3">
          {detail.messages.map((message) => {
            const day = dayLabel(message.received_at);
            // Day dividers only help once a thread spans more than one day.
            const showDay = day !== lastDay && multiDay;
            lastDay = day;
            return (
              <li key={message.id}>
                {showDay && (
                  <div className="my-3 flex items-center gap-3" aria-hidden="true">
                    <div className="h-px flex-1 bg-white/[0.06]" />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">{day}</span>
                    <div className="h-px flex-1 bg-white/[0.06]" />
                  </div>
                )}
                <MessageCard
                  message={message}
                  agentName={agentName}
                  focused={message.id === focusMessageId}
                  viewUrl={isDemoMode ? null : attachmentViewUrl}
                  onPreview={isDemoMode ? undefined : setPreview}
                  onSendToAgent={canTriage ? () => void after(() => client.sendBack(detail.id, message.id), `Sent to ${agentName}`, 'send_back') : undefined}
                  onMoveToInbox={canTriage ? () => void after(() => client.moveToInbox(detail.id, message.id), `Moved to the Inbox. ${agentName} will read it in full.`, 'send_back') : undefined}
                  onAlwaysFilter={canManageRules ? (address) => void after(() => client.createSenderRule({
                    match_kind: 'address', match_value: address, topic: null, action: 'ignore', reason: 'Pitched more than once.',
                  }), `Mail from ${address} goes straight to Filtered from now on.`, 'send_back') : undefined}
                  onRule={canManageRules && message.channel !== 'meeting' ? () => setRuleFor(message) : undefined}
                  onAnswer={canTriage && !isDemoMode ? (text) => answerQuestion(message.id, text) : undefined}
                  questionInPanel={asking?.id === message.id}
                  inMeetingCard={isMeeting}
                  busy={busy !== null}
                  onDownload={(attachment) => void downloadAttachment(attachment)}
                />
              </li>
            );
          })}
        </ol>
        {/* A meeting reads first (its notes or transcript), then what the agent took from it. */}
        {isMeeting && (
          <AgentCard
            cardKey="meeting"
            scope={null}
            triage={meetingTriaged?.triage ?? null}
            agentName={agentName}
            items={meetingItems}
            tasks={[]}
            reminders={[]}
            points={detail.messages.flatMap((m) => m.reply_points ?? [])}
            handled={!!meetingTriaged?.reviewed_at}
            answer={meetingTriaged?.answer ?? null}
            waiting={meetingTriaged?.status === 'new'}
            onAnswer={canTriage && !isDemoMode && meetingTriaged ? (text) => answerQuestion(meetingTriaged.id, text) : undefined}
            questionInPanel={!!meetingTriaged && asking?.id === meetingTriaged.id}
            meeting={{
              onNothingToDo: canSettle && !dismissedCurrent && (meetingWaiting || canHandle) ? () => void nothingToDo() : undefined,
              outcome: shownOutcome ? {
                text: shownOutcome.text,
                onUndo: canSettle && (shownOutcome.added?.length || shownOutcome.dismissed) ? () => void undoOutcome() : undefined,
                undoing: undoingOutcome,
              } : null,
            }}
          />
        )}
        </ProjectLabelsContext.Provider>
        </PlanActionsContext.Provider>
        </TaskUndoContext.Provider>
        {/* The end of the thread reads, then acts: the draft to use, and last the decision that waits. */}
        {draft && (
          <div className="mt-4">
            <ReplyDraftCard
              key={draft.id}
              draft={draft}
              agentName={agentName}
              folded={draftFolded}
              onAskAgain={canTriage ? () => setDraftDialog(true) : undefined}
              onCopied={canTriage && !draft.copied_at ? () => void client.markDraftCopied(detail.id, draft.id).then(() => load(true)).catch(() => undefined) : undefined}
              onMarkHandled={canTriage && canHandle ? () => { if (busy === null) void markHandled(); } : undefined}
              closesReminder={ownReplyReminder}
              busy={busy !== null}
              purpose={isMeeting ? 'follow_up' : 'reply'}
            />
          </div>
        )}
        {asking?.triage && (
          <div className="mt-4">
            <DecisionCard
              key={asking.triage.id}
              sectionRef={decisionRef}
              triage={asking.triage}
              agentName={agentName}
              canDraft={canDraft && !drafting}
              onSend={async (answer, draft) => {
                // The draft is asked for first, so the answer never says one was asked for when it was not.
                if (draft) {
                  try {
                    await client.requestDraft(detail.id, draft.instructions);
                  } catch (err) {
                    toast('error', err instanceof Error ? err.message : 'Could not ask for a draft, so nothing was sent');
                    return false;
                  }
                }
                return answerQuestion(asking.id, answer);
              }}
              onNothing={markHandled}
            />
          </div>
        )}
        {answered?.answer && (
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-xs">
            <HelpCircle size={13} className="text-zinc-400" aria-hidden="true" />
            <span className="font-medium text-zinc-200">{answered.answer.by && answered.answer.by.id !== teamMemberId ? `${answered.answer.by.name} answered` : 'You answered'}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-300" title={answered.answer.text}>{answered.answer.text.split(/\r?\n/)[0]}</span>
            <span className="text-[11px] text-zinc-400">{formatFullTime(answered.answer.at)}</span>
            {answered.status === 'new' && (
              <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400" role="status">
                <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                With {agentName}
              </span>
            )}
          </div>
        )}
        {/* While the decision card is out of view, a pill brings it back. */}
        {asking && !decisionInView && (
          <div className="pointer-events-none sticky bottom-2 z-10 mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => decisionNode.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })}
              // The Needs you badge's tint over the theme's own solid surface, so the email under it never shows through.
              className="group/pill pointer-events-auto relative isolate overflow-hidden rounded-full bg-surface-overlay text-xs font-medium text-amber-300/90 shadow-lg shadow-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <span aria-hidden="true" className="absolute inset-0 -z-10 bg-amber-500/[0.14] transition-colors group-hover/pill:bg-amber-500/[0.22]" />
              <span className="inline-flex items-center gap-1 px-2.5 py-1">
                <HelpCircle size={11} aria-hidden="true" />
                {agentName} needs a decision
                <ArrowDown size={11} aria-hidden="true" />
              </span>
            </button>
          </div>
        )}
        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-[11px] text-zinc-400">
          <ShieldOff size={11} aria-hidden="true" />
          {isMeeting ? `Read only. ${agentName} never sends email.` : `Read only. Reply from your own mail; ${agentName} never sends email.`}
        </p>
      </div>

      <ThreadAttachmentsDialog
        isOpen={attachmentsOpen}
        onClose={() => setAttachmentsOpen(false)}
        messages={detail.messages}
        viewUrl={isDemoMode ? null : attachmentViewUrl}
        onPreview={isDemoMode ? undefined : setPreview}
        onDownload={(attachment) => void downloadAttachment(attachment)}
      />

      <FilePreviewModal
        isOpen={!!preview}
        onClose={() => setPreview(null)}
        file={previewFile}
      />

      {canTriage && (
        <>
          <LinkTaskDialog
            isOpen={linkDialog}
            onClose={() => setLinkDialog(false)}
            detail={detail}
            onLinked={async () => {
              setLinkDialog(false);
              await refresh();
            }}
          />
          {ruleFor && (
            <SenderRuleDialog
              isOpen
              onClose={() => setRuleFor(null)}
              threadId={detail.id}
              message={ruleFor}
              agentName={agentName}
              onSaved={async () => {
                setRuleFor(null);
                await refresh();
              }}
            />
          )}
          <DraftRequestDialog
            isOpen={draftDialog}
            onClose={() => setDraftDialog(false)}
            agentName={agentName}
            purpose={isMeeting ? 'follow_up' : 'reply'}
            onAsk={async (instructions) => {
              try {
                await client.requestDraft(detail.id, instructions);
                setDraftDialog(false);
                toast('success', `Asked ${agentName} for a draft`);
                await load(true);
              } catch (err) {
                toast('error', err instanceof Error ? err.message : 'Could not ask for a draft');
              }
            }}
          />
        </>
      )}

      {canTriage && (
        <ThreadProjectDialog
          isOpen={projectDialog}
          onClose={() => setProjectDialog(false)}
          detail={detail}
          onSaved={async () => {
            setProjectDialog(false);
            await load(true);
            announceInboxChange({ threadId });
          }}
        />
      )}
    </div>
  );
}

const RELATION_LABELS: Record<InboxLinkedTask['relation'], string> = {
  created: 'Created',
  updated: 'Updated',
  related: 'About',
};

function shortDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day));
}

/**
 * What the thread is tied to, in one strip: every task its emails link to
 * (once each, however many emails link it) and the reminders that came from
 * it. People link another task here or untie one.
 */
function ThreadLinks({ detail, canEdit, onLink, onUnlink }: {
  detail: InboxThreadDetail;
  canEdit: boolean;
  onLink: () => void;
  onUnlink: (task: InboxLinkedTask) => Promise<void>;
}) {
  const tasks = [...new Map(detail.messages.flatMap((message) => message.linked_tasks).map((task) => [task.task_id, task])).values()];
  const reminders: InboxReminder[] = detail.messages.flatMap((message) => message.reminders).filter((reminder) => reminder.status === 'open');
  if (tasks.length === 0 && reminders.length === 0 && !canEdit) return null;
  return (
    <>
      {(tasks.length > 0 || canEdit) && (
        <NotePill label={`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`} icon={<SquareCheck size={11} className={tasks.length ? 'text-emerald-300' : ''} aria-hidden="true" />} width={420}>
          {tasks.length === 0 && <p className="text-xs text-zinc-400">No tasks are tied to this thread yet.</p>}
          <ul className="space-y-1" aria-label="Linked tasks">
            {tasks.map((task) => (
              <li key={task.task_id} className="flex min-w-0 items-center gap-2 text-xs">
                <SquareCheck size={12} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
                <span className="w-[3.75rem] flex-shrink-0 text-zinc-400">{RELATION_LABELS[task.relation]}</span>
                {task.project_id && task.title !== null ? (
                  <Link
                    href={`/projects/${task.project_id}?task=${task.task_id}`}
                    className="min-w-0 flex-1 truncate rounded font-medium text-zinc-100 hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {task.title}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-zinc-300">A task in another project</span>
                )}
                {detail.projects.length > 1 && <TaskProjectLabel task={task} />}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => void onUnlink(task)}
                    aria-label={`Unlink ${task.title ?? 'this task'}`}
                    className="flex-shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            // A last quiet row, lined up with the tasks above it.
            <button
              type="button"
              onClick={onLink}
              className={`flex items-center gap-2 rounded text-xs text-zinc-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${tasks.length ? 'mt-2' : 'mt-1.5'}`}
            >
              <Plus size={12} className="flex-shrink-0" aria-hidden="true" />
              Link a task
            </button>
          )}
        </NotePill>
      )}
      {reminders.length > 0 && (
        <>
          <NotePill label={`${reminders.length} ${reminders.length === 1 ? 'reminder' : 'reminders'}`} icon={<Bell size={11} className="text-amber-300" aria-hidden="true" />} width={380}>
            <ul className="space-y-1.5" aria-label="Open reminders">
              {reminders.map((reminder) => (
                <li key={reminder.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                  <Bell size={12} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium text-zinc-100">{reminder.title}</span>
                  {reminder.remind_on && <span className="flex-shrink-0 text-zinc-400">{shortDate(reminder.remind_on)}</span>}
                </li>
              ))}
            </ul>
          </NotePill>
        </>
      )}
    </>
  );
}

/** Opens a stored attachment in the browser (a redirect to a fresh signed link). */
function attachmentViewUrl(attachmentId: string): string {
  return `/api/workspace/inbox/attachments/${attachmentId}/view`;
}

/** What the preview renders an attachment as: its kind decides, never the declared type alone. */
function previewType(attachment: InboxAttachment): string {
  if (attachment.kind === 'pdf') return 'application/pdf';
  if (attachment.kind === 'text') return attachment.content_type.startsWith('text/') ? attachment.content_type.split(';')[0] : 'text/plain';
  return attachment.content_type;
}

/** Plain email text with each web link cut down to its site name, so tracking URLs never spill across the card. */
function EmailText({ text }: { text: string }) {
  const parts = useMemo(() => linkParts(text), [text]);
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200 [overflow-wrap:anywhere]">
      {parts.map((part, index) => 'url' in part ? (
        <a
          key={index}
          href={part.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={part.url}
          className="inline-flex items-baseline gap-0.5 rounded text-brand-300 underline decoration-brand-300/30 underline-offset-2 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {part.label}
          <ExternalLink size={10} className="flex-shrink-0 self-center" aria-hidden="true" />
        </a>
      ) : <span key={index}>{part.text}</span>)}
    </p>
  );
}

function MessageCard({ message, agentName, focused, busy, viewUrl, onSendToAgent, onMoveToInbox, onAlwaysFilter, onRule, onAnswer, questionInPanel, inMeetingCard, onDownload, onPreview }: {
  message: InboxMessage;
  agentName: string;
  focused: boolean;
  busy: boolean;
  /** Where a stored attachment opens in the browser; null in demo mode. */
  viewUrl: ((attachmentId: string) => string) | null;
  /** Absent for members who can only view the inbox. */
  onSendToAgent?: () => void;
  /** A pitch the agent filtered goes back to the Inbox, its sender read in full from now on. */
  onMoveToInbox?: () => void;
  /** A sender who keeps pitching: a rule filters their mail from now on. */
  onAlwaysFilter?: (address: string) => void;
  /** Make or change the sender rule for this email's sender. */
  onRule?: () => void;
  /** Answer the agent's question; absent for members who only view. */
  onAnswer?: (text: string) => Promise<boolean>;
  /** Its question is open in the decision card, so the note leaves it out. */
  questionInPanel?: boolean;
  /** A meeting's package: the meeting's one card, after its words, holds what the agent made of it. */
  inMeetingCard?: boolean;
  onDownload: (attachment: InboxAttachment) => void;
  onPreview?: (attachment: InboxAttachment) => void;
}) {
  const hasNewText = !!message.new_text?.trim();
  const fullDiffers = !!message.html_body || (!!message.text_body && message.text_body.trim() !== (message.new_text ?? '').trim());
  const asHtml = opensAsHtml(message);
  // Newsletters, notifications and forwards open as the whole email; a reply opens on what is new.
  const [full, setFull] = useState(asHtml || !hasNewText);
  // A reply whose HTML marks its quoted history shows as designed, minus that history.
  const trimmed = !asHtml && hasNewText && hasQuotedHtml(message.html_body);
  const showingHtml = !!message.html_body && (full || trimmed);
  const inlineImages = useMemo(() => {
    const map: Record<string, string> = {};
    if (!viewUrl) return map;
    for (const attachment of message.attachments) {
      if (attachment.content_id && attachment.available && attachment.kind === 'image') map[attachment.content_id] = viewUrl(attachment.id);
    }
    return map;
  }, [message.attachments, viewUrl]);
  // The agent's note covers what the agent did; people's links live in the thread's strip.
  const { trashed, trashedReminders, unlinked } = useContext(TaskUndoContext);
  // A task trashed or unlinked here stays on its email (with Restore) after the thread stops listing it.
  const agentLinks = useMemo(() => {
    const live = message.linked_tasks.filter((task) => task.by === 'agent');
    const has = (task: InboxLinkedTask) => live.some((t) => t.task_id === task.task_id && t.relation === task.relation);
    const gone = [...Object.values(trashed), ...Object.values(unlinked)]
      .filter((entry) => entry.messageId === message.id && !has(entry.task))
      .map((entry) => entry.task);
    return [...live, ...gone];
  }, [message.linked_tasks, message.id, trashed, unlinked]);
  // So does a reminder.
  const reminders = useMemo(() => [
    ...message.reminders,
    ...Object.values(trashedReminders)
      .filter((entry) => entry.messageId === message.id && !message.reminders.some((reminder) => reminder.id === entry.reminder.id))
      .map((entry) => entry.reminder),
  ], [message.reminders, message.id, trashedReminders]);
  // Images the HTML already shows in place are not listed again under it.
  const referenced = useMemo(() => inlineImageIds(message.html_body), [message.html_body]);
  const listed = showingHtml
    ? message.attachments.filter((attachment) => !(attachment.content_id && referenced.has(attachment.content_id) && inlineImages[attachment.content_id]))
    : message.attachments;
  // A teammate's forward shows the original sender; the teammate gets their own line.
  const shownFrom = message.original_sender ?? message.from;
  // A meeting message is its package; its from is the teammate who sent it in.
  const meetingPackage = message.channel === 'meeting' ? message.meeting_package ?? 'transcript' : null;
  const sender = meetingPackage
    ? MEETING_PACKAGE_LABELS[meetingPackage]
    : shownFrom?.name || shownFrom?.address || 'Unknown sender';
  const sentInBy = meetingPackage ? message.from?.name || message.from?.address || null : null;
  const packageFile = meetingPackage ? message.attachments.find((attachment) => attachment.kind === 'text') ?? null : null;
  const packageNotes = meetingPackage ? meetingNoteLines(message.text_body ?? message.new_text) : [];
  // A pitch the agent filtered (not a rule or bulk mail): it can go back to the Inbox.
  const pitch = message.triage?.category === 'outreach';
  const teammate = message.forwarded_by?.name || message.from?.name || message.from?.address || 'a teammate';
  const forwardedByTeam = message.routing_basis === 'forwarded_original';
  const routedNote = meetingPackage ? null : forwardedByTeam
    ? `Forwarded by ${teammate}`
    : message.routing_basis === 'team_recipients' ? `Sent by ${teammate}, CC'd to the inbox` : null;
  const recipients = meetingPackage ? '' : [
    message.to.length ? `To ${message.to.map((p) => p.name || p.address).join(', ')}` : '',
    message.cc.length ? `Cc ${message.cc.map((p) => p.name || p.address).join(', ')}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <>
    <article
      id={`email-${message.id}`}
      aria-label={meetingPackage === 'notes' ? "Meeting notes by Gemini" : meetingPackage ? 'Meeting transcript' : `Email from ${sender}`}
      className={`rounded-xl border bg-white/[0.02] ${focused ? 'border-brand-400/50 ring-1 ring-brand-400/30' : 'border-white/[0.07]'}`}
    >
      <header className="flex items-start gap-3 px-3 pt-3 sm:px-4 sm:pt-3.5">
        {meetingPackage ? (
          // The package, not a person: a soft tile with what it is.
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-zinc-300" aria-hidden="true">
            {meetingPackage === 'notes' ? <Sparkles size={15} /> : <FileText size={15} />}
          </span>
        ) : <Avatar name={sender} size="sm" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-words text-sm font-semibold text-white [overflow-wrap:anywhere]">{sender}</span>
            {/* Phones: the time rides on the name line instead of taking a column. */}
            <time dateTime={message.received_at} className="ml-auto text-xs tabular-nums text-zinc-400 sm:hidden">{formatListTime(message.received_at)}</time>
            {sentInBy && <span className="min-w-0 max-w-full basis-full truncate text-xs text-zinc-400 sm:basis-auto">Sent in by {sentInBy}</span>}
            {!meetingPackage && shownFrom?.name && <span className="min-w-0 max-w-full basis-full truncate text-xs text-zinc-400 sm:basis-auto">{shownFrom.address}</span>}
            {/* Trust is the verdict on the outer sender, so a teammate's forward shows it on their line. */}
            {!forwardedByTeam && !meetingPackage && <TrustBadge level={message.trust.level} />}
            {message.is_forward && !forwardedByTeam && !meetingPackage && (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-zinc-300">
                <Forward size={11} aria-hidden="true" />
                Forwarded
              </span>
            )}
          </div>
          {routedNote && (
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-300">
              <Forward size={12} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
              <span>{routedNote}</span>
              {forwardedByTeam && <TrustBadge level={message.trust.level} />}
            </p>
          )}
          {recipients && <p className="mt-0.5 truncate text-[11px] text-zinc-400 sm:whitespace-normal sm:break-words">{recipients}</p>}
          {!meetingPackage && <TrustNote level={message.trust.level} reason={message.trust.reason} />}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <time dateTime={message.received_at} className="hidden text-xs tabular-nums text-zinc-400 sm:block">{formatFullTime(message.received_at)}</time>
          <Tooltip content={meetingPackage ? 'Copy meeting ID' : 'Copy email ID'}>
            <button
              type="button"
              onClick={() => void copyText(message.id, meetingPackage ? 'Meeting ID' : 'Email ID')}
              aria-label={meetingPackage ? "Copy this meeting's ID" : "Copy this email's ID"}
              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Hash size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </header>

      {message.status === 'ignored' && (
        <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">
          <span>{pitch ? outreachReason(agentName) : message.sorting?.reason ?? `Filtered as automatic mail${message.auto_mail_reason ? `: ${message.auto_mail_reason}` : ''}.`}</span>
          <span className="ml-auto flex items-center gap-1">
            {onRule && (
              <Button size="sm" variant="ghost" onClick={onRule} icon={<Filter size={12} aria-hidden="true" />}>
                {message.sorting?.rule_id ? 'Change rule' : 'Make a rule'}
              </Button>
            )}
            {pitch && message.repeat_pitch && onAlwaysFilter && shownFrom?.address && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAlwaysFilter(shownFrom.address)} icon={<Filter size={12} aria-hidden="true" />}>
                Always filter this sender
              </Button>
            )}
            {pitch && onMoveToInbox ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onMoveToInbox} icon={<Inbox size={12} aria-hidden="true" />}>
                Move to Inbox
              </Button>
            ) : onSendToAgent && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onSendToAgent} icon={<RotateCcw size={12} aria-hidden="true" />}>
                Send to {agentName}
              </Button>
            )}
          </span>
        </div>
      )}

      {meetingPackage ? (
        <div className="min-w-0 space-y-2.5 px-2 py-3 sm:px-4">
          {packageNotes.length > 0 && (
            <div className="space-y-1 text-xs leading-relaxed text-zinc-300">
              {packageNotes.map((line, index) => <p key={index} className="break-words [overflow-wrap:anywhere]">{line}</p>)}
            </div>
          )}
          {packageFile && <TranscriptReader attachment={packageFile} kind={meetingPackage} />}
        </div>
      ) : (
      <div className="min-w-0 px-2 py-3 sm:px-4">
        {showingHtml ? (
          <EmailBodyFrame html={message.html_body!} inlineImages={inlineImages} hideQuoted={!full} title={`Email from ${sender}: ${message.subject || 'no subject'}`} />
        ) : (
          <EmailText text={(full ? message.text_body || message.new_text : message.new_text) || 'This email has no text.'} />
        )}
        {/* Only a reply has history to hide; a whole email has nothing to toggle. */}
        {hasNewText && fullDiffers && (message.is_forward || !asHtml) && (
          <button
            type="button"
            onClick={() => setFull((value) => !value)}
            aria-expanded={full}
            className="mt-2 inline-flex items-center gap-1 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ChevronDown size={13} className={`transition-transform motion-reduce:transition-none ${full ? 'rotate-180' : ''}`} aria-hidden="true" />
            {full ? (message.is_forward ? 'Show the note only' : 'Hide earlier emails') : 'Show full email'}
          </button>
        )}
      </div>
      )}

      {listed.length > 0 && <AttachmentList attachments={listed} agentName={agentName} viewUrl={viewUrl} onDownload={onDownload} onPreview={onPreview} />}

      {message.sorting?.superseded_by && (
        <p className="mx-4 mb-3 text-[11px] text-zinc-400">Replaced by a newer alert from the same sender, so it no longer waits on anyone.</p>
      )}
      {!message.triage && message.status === 'new' && (
        <p className="mx-4 mb-3 flex items-center gap-1.5 text-xs text-zinc-400">
          <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Waiting for {agentName} to triage
        </p>
      )}
    </article>
    {message.triage && !inMeetingCard && (
      <AgentCard
        cardKey={message.id}
        scope={[message.id]}
        triage={message.triage}
        agentName={agentName}
        items={message.plan?.items ?? []}
        // An email with a plan is its plan's; an older triage shows what it linked and set.
        tasks={message.plan ? [] : agentLinks.map((task) => ({ messageId: message.id, task }))}
        reminders={message.plan ? [] : reminders.map((reminder) => ({ messageId: message.id, reminder }))}
        points={message.reply_points ?? []}
        handled={!!message.reviewed_at}
        answer={message.answer ?? null}
        waiting={message.status === 'new'}
        onAnswer={onAnswer}
        questionInPanel={!!questionInPanel}
      />
    )}
    </>
  );
}

function AttachmentList({ attachments, agentName, viewUrl, onDownload, onPreview }: {
  attachments: InboxAttachment[];
  agentName: string;
  viewUrl: ((attachmentId: string) => string) | null;
  onDownload: (a: InboxAttachment) => void;
  onPreview?: (a: InboxAttachment) => void;
}) {
  return (
    <div className="border-t border-white/[0.05] px-4 py-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
        <Paperclip size={12} aria-hidden="true" />
        {attachments.length} {attachments.length === 1 ? 'attachment' : 'attachments'}
      </p>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {attachments.map((attachment) => {
          const Icon = attachment.kind === 'image' ? ImageIcon : FileText;
          const previewable = !!onPreview && attachment.available && attachment.kind !== 'other';
          const thumbnail = attachment.kind === 'image' && attachment.available && viewUrl;
          return (
            <li key={attachment.id} className="flex min-w-0 items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
              {thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element -- a signed storage link, not a static asset
                <img src={viewUrl(attachment.id)} alt="" loading="lazy" className="h-9 w-9 flex-shrink-0 rounded-md border border-white/[0.08] object-cover" />
              ) : (
                <Icon size={16} className="mt-0.5 flex-shrink-0 text-zinc-400" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                {previewable ? (
                  <button
                    type="button"
                    onClick={() => onPreview!(attachment)}
                    aria-label={`Preview ${attachment.filename}`}
                    title={attachment.filename}
                    className="block max-w-full truncate rounded text-left text-xs font-medium text-zinc-100 underline decoration-white/20 underline-offset-2 hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {attachment.filename}
                  </button>
                ) : (
                  <p className="truncate text-xs font-medium text-zinc-200" title={attachment.filename}>{attachment.filename}</p>
                )}
                <p className="text-[11px] text-zinc-400">
                  {attachment.available ? formatBytes(attachment.size_bytes) : skippedReasonLabel(attachment.skipped_reason)}
                </p>
                {attachment.agent_label && (
                  <p className="mt-1 flex items-start gap-1 text-[11px] text-zinc-300">
                    <Tag size={10} className="mt-[3px] flex-shrink-0 text-brand-300" aria-hidden="true" />
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]"><span className="sr-only">{agentName}&apos;s label: </span>{attachment.agent_label}</span>
                  </p>
                )}
              </div>
              {attachment.available && (
                <Tooltip content="Download">
                  <button
                    type="button"
                    onClick={() => onDownload(attachment)}
                    aria-label={`Download ${attachment.filename}`}
                    className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <Download size={14} aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The agent who triaged: its name and its photo from the team directory. */
function useTriager(triage: InboxTriage | null, agentName: string): { name: string; avatar?: string } {
  const { team } = useApp();
  const name = triage?.member?.name ?? agentName;
  const member = triage?.member ? team.find((m) => m.id === triage.member!.id) : team.find((m) => m.name === agentName);
  return { name, avatar: member?.avatar || undefined };
}

/**
 * A small pill that opens a card anchored to it: the summary or the
 * suggested reply reads at paragraph width, over the thread, without
 * pushing the emails around.
 */
function NotePill({ label, icon, align = 'start', width = 360, className = '', children }: {
  label: ReactNode;
  icon?: ReactNode;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
          open ? 'bg-white/[0.10] text-white' : 'bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] hover:text-white'
        } ${className}`}
      >
        {icon}
        {label}
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        align={align}
        width={width}
        className="rounded-xl border border-white/[0.08] bg-surface-raised p-3.5 shadow-2xl"
      >
        <div role="dialog" aria-label={typeof label === 'string' ? label : undefined}>{children}</div>
      </Popover>
    </>
  );
}

/** Which project a linked task sits in, beside it, for a thread filed on several. */
function TaskProjectLabel({ task }: { task: InboxLinkedTask }) {
  if (!task.project_name) return null;
  return <span className="max-w-[8rem] flex-shrink-0 truncate text-[11px] text-zinc-400" title={task.project_name}>{task.project_name}</span>;
}

/** Who triaged and when, at the top of a note card. */
function NoteCardHeader({ name, avatar, at }: { name: string; avatar?: string; at: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Avatar name={name} src={avatar} size="xs" />
      <span className="text-xs font-semibold text-zinc-100">{name}</span>
      <time dateTime={at} className="ml-auto text-[11px] text-zinc-400">{formatFullTime(at)}</time>
    </div>
  );
}

/**
 * Under the agent's question: the answer someone gave, or a box to give one.
 * "Go with your default" takes the default the question proposes. Either way
 * the email goes back to the agent, which acts on the answer.
 */
function QuestionAnswer({ agentName, answer, waiting, onAnswer }: {
  agentName: string;
  answer: InboxAnswer | null;
  waiting: boolean;
  onAnswer?: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState<'default' | 'answer' | null>(null);
  if (answer) {
    return (
      <div className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2.5">
        <p className="mb-1 text-[11px] font-semibold text-zinc-400">
          {answer.by?.name ?? 'Someone'} answered, {formatFullTime(answer.at)}
        </p>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-100">{answer.text}</p>
        {waiting && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
            <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            With {agentName} to act on
          </p>
        )}
      </div>
    );
  }
  if (!onAnswer) return null;
  const send = async (kind: 'default' | 'answer', value: string) => {
    setSending(kind);
    try {
      if (await onAnswer(value)) setText('');
    } finally {
      setSending(null);
    }
  };
  return (
    <div className="mt-3 space-y-2">
      <Textarea
        label="Your answer"
        value={text}
        onChange={setText}
        size="sm"
        rows={2}
        autoResize
        maxHeight={160}
        maxLength={2000}
        placeholder={`Tell ${agentName} what to do`}
        disabled={sending !== null}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={sending !== null} onClick={() => void send('default', 'Go with your proposed default.')}
          icon={sending === 'default' ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}>
          Go with your default
        </Button>
        <Button size="sm" disabled={sending !== null || !text.trim()} onClick={() => void send('answer', text.trim())}
          icon={sending === 'answer' ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Forward size={12} aria-hidden="true" />}>
          Send answer
        </Button>
      </div>
    </div>
  );
}

type CardGroup = 'task' | 'reminder' | 'comment' | 'existing' | 'other';

/** The card in the order a person settles it: new work, follow-ups, notes on work that exists, then the rest. */
const CARD_GROUPS: { key: CardGroup; one: string; many: string; icon: ReactNode }[] = [
  { key: 'task', one: 'New task', many: 'New tasks', icon: <SquarePlus size={12} aria-hidden="true" /> },
  { key: 'reminder', one: 'Reminder', many: 'Reminders', icon: <Bell size={12} aria-hidden="true" /> },
  { key: 'comment', one: 'Comment on a task', many: 'Comments on tasks', icon: <MessageSquare size={12} aria-hidden="true" /> },
  { key: 'existing', one: 'Existing task', many: 'Existing tasks', icon: <Link2 size={12} aria-hidden="true" /> },
  { key: 'other', one: 'Other change', many: 'Other changes', icon: <ListChecks size={12} aria-hidden="true" /> },
];

/** What waits, said as nouns: "2 new tasks and 1 reminder". */
const GROUP_NOUN: Record<CardGroup, [string, string]> = {
  task: ['new task', 'new tasks'], reminder: ['reminder', 'reminders'], comment: ['comment', 'comments'],
  existing: ['link to an existing task', 'links to existing tasks'], other: ['other change', 'other changes'],
};
/** What was done, said as verbs: "created 3 tasks and set 3 reminders". */
const GROUP_DONE: Record<CardGroup, [string, string]> = {
  task: ['created 1 task', 'created # tasks'], reminder: ['set 1 reminder', 'set # reminders'], comment: ['commented on 1 task', 'commented on # tasks'],
  existing: ['linked 1 existing task', 'linked # existing tasks'], other: ['made 1 other change', 'made # other changes'],
};

function itemGroup(item: InboxPlanItem): CardGroup {
  switch (item.type) {
    case 'create_task': return 'task';
    case 'add_reminder': case 'update_reminder': case 'complete_reminder': return 'reminder';
    case 'comment': return 'comment';
    case 'link_task': case 'update_task': case 'attach_file': return 'existing';
    default: return 'other';
  }
}

/** A row's title under its group: the task or reminder itself, without the "Link " or "New task: " the group already says. */
function rowTitle(item: InboxPlanItem): string {
  return item.title || item.label.replace(/^(Link|New task:|Reminder:|Comment on)\s+/, '');
}

function joinWords(parts: string[]): string {
  return parts.length <= 1 ? parts[0] ?? '' : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function countPhrase(groups: CardGroup[], words: Record<CardGroup, [string, string]>, withCount: boolean): string {
  const counts = new Map<CardGroup, number>();
  for (const group of groups) counts.set(group, (counts.get(group) ?? 0) + 1);
  return joinWords(CARD_GROUPS.filter((g) => counts.has(g.key)).map((g) => {
    const n = counts.get(g.key)!;
    const [one, many] = words[g.key];
    return withCount ? `${n} ${n === 1 ? one : many}` : (n === 1 ? one : many.replace('#', String(n)));
  }));
}

/** One row of the card: a plan item, or what an older triage left (a linked task, a reminder). */
type CardRow =
  | { kind: 'item'; key: string; group: CardGroup; item: InboxPlanItem }
  | { kind: 'task'; key: string; group: CardGroup; messageId: string; task: InboxLinkedTask }
  | { kind: 'reminder'; key: string; group: CardGroup; messageId: string; reminder: InboxReminder };

/** The card's body and footer line up with the name, as an email's text lines up with its sender. */
const CARD_INSET = 'px-3 sm:pl-[3.25rem] sm:pr-4';

/** A summary longer than this folds to three lines with "Show more". */
const SUMMARY_FOLD = 240;

function CardSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > SUMMARY_FOLD;
  return (
    <div>
      <p className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200 [overflow-wrap:anywhere] ${long && !open ? 'line-clamp-3' : ''}`}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
          className="mt-1 inline-flex items-center gap-1 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          <ChevronDown size={13} className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** The agent's mark beside its name, so its reply never reads as a person's. */
function AgentTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-brand-200">
      <Sparkles size={11} aria-hidden="true" />
      Agent
    </span>
  );
}

/** The card's chrome: the agent's reply to the message above it, a step in. A meeting's stands on its own. */
function cardChrome(meeting: boolean): string {
  return `${meeting ? 'mt-4' : 'ml-3 mt-2 sm:ml-8'} min-w-0 rounded-xl border border-brand-400/[0.14] bg-brand-500/[0.025]`;
}

/**
 * The agent's reply to an email (under it) or a meeting (after its words):
 * who, what it suggests or did ("Created 3 tasks and set 3 reminders"), its
 * summary, then each thing grouped by kind with its own action (Add, Change,
 * Skip; Undo, Not a task, Not needed, Unlink). What was taken back folds at
 * the bottom with Restore. The footer holds its question, suggested reply and
 * replies owed, and the actions for the lot: Undo all, Add all. An email it
 * left alone gets one quiet line.
 */
function AgentCard({ cardKey, scope, triage, agentName, items, tasks, reminders, points, handled, answer, waiting, onAnswer, questionInPanel, meeting }: {
  /** The email's id, or "meeting": what Undo all and Add all are kept under. */
  cardKey: string;
  /** The emails Undo all covers; the whole thread when null. */
  scope: string[] | null;
  triage: InboxTriage | null;
  agentName: string;
  /** Plan items in any state (the question and replies owed show apart). */
  items: InboxPlanItem[];
  /** What an older triage linked (with any this view took back). */
  tasks: { messageId: string; task: InboxLinkedTask }[];
  reminders: { messageId: string; reminder: InboxReminder }[];
  points: InboxReplyPoint[];
  handled: boolean;
  answer: InboxAnswer | null;
  waiting: boolean;
  onAnswer?: (text: string) => Promise<boolean>;
  questionInPanel: boolean;
  /** A meeting's card: Nothing to do, and the line Add all or Nothing to do leaves. */
  meeting?: { onNothingToDo?: () => void; outcome: SuggestionsOutcome | null };
}) {
  const { trashed, trashedReminders, unlinked, notNeeded } = useContext(TaskUndoContext);
  const { pending, add, skip, addAll, undoAll, restoreAll, undone, bulk } = useContext(PlanActionsContext);
  const projectLabels = useContext(ProjectLabelsContext);
  const { name: who, avatar } = useTriager(triage, agentName);
  const [settledOpen, setSettledOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Only what waits, what was done and what a person took back: a suggestion the policy
  // rejected, one that expired unanswered, or one still applying is not the agent's work to show.
  const shown = items.filter((item) => item.type !== 'ask' && item.type !== 'reply_owed'
    && ['pending', 'accepting', 'done', 'accepted', 'failed', 'undone', 'dismissed'].includes(item.state));
  const waitingItems = shown.filter((item) => item.state === 'pending' || item.state === 'accepting');
  const rows: CardRow[] = [];
  const settled: CardRow[] = [];
  for (const item of shown) {
    if (item.state === 'pending' || item.state === 'accepting') continue;
    (item.state === 'undone' || item.state === 'dismissed' ? settled : rows).push({ kind: 'item', key: item.id, group: itemGroup(item), item });
  }
  for (const { messageId, task } of tasks) {
    const key = linkKey(messageId, task);
    const row: CardRow = { kind: 'task', key, group: task.relation === 'created' ? 'task' : 'existing', messageId, task };
    (trashed[task.task_id] || unlinked[key] ? settled : rows).push(row);
  }
  for (const { messageId, reminder } of reminders) {
    (trashedReminders[reminder.id] ? settled : rows).push({ kind: 'reminder', key: reminder.id, group: 'reminder', messageId, reminder });
  }
  const owed = points.filter((point) => point.state === 'open');
  const question = triage?.question_for_human && !questionInPanel ? triage.question_for_human : null;

  const busy = pending !== null || bulk !== null;
  const undoableCount = rows.filter((row) => row.kind === 'item'
    ? (row.item.state === 'done' || row.item.state === 'accepted') && UNDOABLE.has(row.item.type)
    : row.kind === 'task'
      ? row.task.by === 'agent' && row.task.title !== null && !(row.task.relation === 'created' && row.task.status === 'done')
      : !!notNeeded(row.reminder)).length;
  // One thing is undone from its own row; Undo all is for the lot.
  const undoable = undoableCount >= 2;
  const addable = waitingItems.filter((item) => item.state === 'pending');
  const tookBack = undone[cardKey];
  const tookBackCount = tookBack ? tookBack.plan_items.length + tookBack.tasks.length + tookBack.reminders.length + tookBack.links.length : 0;
  const mixedProjects = new Set(waitingItems.map((item) => item.project_id)).size > 1;
  const spinner13 = <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  const at = triage?.created_at ?? null;

  const copyReply = async () => {
    if (!triage?.suggested_reply) return;
    try {
      await navigator.clipboard.writeText(triage.suggested_reply);
      setCopied(true);
      toast('success', 'Reply copied. Paste it into your own mail.');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('error', 'Could not copy to the clipboard');
    }
  };
  const replyPill = triage?.suggested_reply && (
    <NotePill label="Suggested reply" icon={<MessageSquareReply size={11} aria-hidden="true" />} width={440}>
      <NoteCardHeader name={who} avatar={avatar} at={triage.created_at} />
      <blockquote className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm leading-relaxed text-zinc-200">
        {triage.suggested_reply}
      </blockquote>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <p className="text-[11px] text-zinc-400">Nothing is sent from here.</p>
        <Button size="sm" variant="secondary" onClick={() => void copyReply()} icon={copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </NotePill>
  );

  // Nothing done, nothing waiting, nothing to answer: one quiet line, the summary a click away.
  const quiet = !meeting && !!triage && triage.outcome === 'no_action' && !triage.urgent && !triage.question_for_human
    && !waitingItems.length && !rows.length && !settled.length && !owed.length && !tookBack;
  if (quiet && triage) {
    return (
      <section aria-label={`${who}: no action needed`}
        className="ml-3 mt-2 flex min-w-0 flex-nowrap items-center gap-x-2.5 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2 sm:ml-8 sm:px-4">
        <Avatar name={who} src={avatar} size="xs" />
        <span className="hidden text-xs font-semibold text-zinc-200 sm:inline">{who}</span>
        <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-zinc-400">
          <CheckCircle2 size={12} className="flex-shrink-0" aria-hidden="true" />
          No action needed
        </span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-1.5">
          <NotePill label="Summary" icon={<AlignLeft size={11} aria-hidden="true" />} align="end">
            <NoteCardHeader name={who} avatar={avatar} at={triage.created_at} />
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{triage.summary}</p>
          </NotePill>
          {replyPill}
        </span>
      </section>
    );
  }
  if (meeting && !triage && !shown.length && !meeting.outcome && !meeting.onNothingToDo) return null;

  // What it is doing here, in one line under its name.
  const activeRows = rows.filter((row) => !(row.kind === 'item' && row.item.state === 'failed'));
  const status = [
    waitingItems.length ? `Suggests ${countPhrase(waitingItems.map(itemGroup), GROUP_NOUN, true)}` : '',
    activeRows.length ? countPhrase(activeRows.map((row) => row.group), GROUP_DONE, false).replace(/^./, (c) => c.toUpperCase()) : '',
  ].filter(Boolean).join(' · ')
    || (settled.length || tookBack ? 'Everything here was taken back or skipped' : triage ? OUTCOME[triage.outcome].label : 'Nothing to add');
  const heading = `${who}: ${status}`;
  const renderRow = (row: CardRow) => row.kind === 'item'
    ? (row.item.state === 'undone' || row.item.state === 'dismissed' ? <SettledItemRow key={row.key} item={row.item} /> : <PlanItemRow key={row.key} item={row.item} />)
    : row.kind === 'task'
      ? <TaskReceipt key={row.key} task={row.task} messageId={row.messageId} />
      : <ReminderReceipt key={row.key} reminder={row.reminder} messageId={row.messageId} />;
  const canUndoAll = !!undoAll && undoable;
  const otherFooter = (!!addAll && addable.length > 0) || !!meeting?.onNothingToDo || !!question || !!replyPill || owed.length > 0;
  // Alone, Undo all sits beside the line that says what it undoes; with other actions, in the footer.
  const undoInHeader = canUndoAll && !otherFooter;
  const hasActions = (canUndoAll && !undoInHeader) || (!!addAll && addable.length > 0) || !!meeting?.onNothingToDo;
  const hasFooter = hasActions || !!question || !!replyPill || owed.length > 0;
  const undoAllButton = canUndoAll && (
    <Tooltip content={`Takes back everything ${who} did here. Restore all puts it back.`}>
      <Button size="sm" variant="ghost" className={undoInHeader ? '!-my-1 !px-2 !py-1' : ''} disabled={busy} onClick={() => void undoAll!(cardKey, scope)}
        icon={pending === `undo-all:${cardKey}` ? spinner13 : <Undo2 size={13} aria-hidden="true" />}>
        Undo all {undoableCount}
      </Button>
    </Tooltip>
  );
  const listClass = 'divide-y divide-white/[0.05] overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]';

  return (
    <section aria-label={heading} className={cardChrome(!!meeting)}>
      <header className="flex items-start gap-3 px-3 pt-3 sm:px-4 sm:pt-3.5">
        <Avatar name={who} src={avatar} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-white">{who}</span>
            <AgentTag />
            {triage?.urgent && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-300">
                <Flame size={11} aria-hidden="true" />
                Urgent
              </span>
            )}
            {at && (
              <time dateTime={at} className="ml-auto text-xs tabular-nums text-zinc-400">
                <span className="sm:hidden">{formatListTime(at)}</span>
                <span className="hidden sm:inline">{formatFullTime(at)}</span>
              </time>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 flex-1 text-xs text-zinc-300">{status}</p>
            {undoInHeader && undoAllButton}
          </div>
        </div>
      </header>

      <div className={`${CARD_INSET} ${hasFooter ? '' : 'pb-3'} mt-2.5 space-y-3`}>
        {triage?.summary && <CardSummary text={triage.summary} />}

        {tookBack && (
          <div className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-zinc-200" role="status">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Undo2 size={13} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words">
                {tookBackCount ? `Took back ${tookBackCount} ${tookBackCount === 1 ? 'thing' : 'things'} ${who} did here` : 'Nothing here could be taken back'}
              </span>
              {restoreAll && tookBackCount > 0 && (
                <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5" disabled={busy} onClick={() => void restoreAll(cardKey)}
                  icon={pending === `restore-all:${cardKey}` ? spinner : <RotateCcw size={12} aria-hidden="true" />}>
                  Restore all
                </Button>
              )}
            </div>
            {tookBack.kept.length > 0 && (
              <ul className="mt-1 space-y-0.5 pl-5 text-[11px] text-zinc-400" aria-label="Left as they were">
                {tookBack.kept.map((kept, index) => (
                  <li key={index} className="break-words [overflow-wrap:anywhere]"><span className="text-zinc-300">{kept.label}</span>: {kept.reason}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {meeting?.outcome && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-zinc-200" role="status">
            <Check size={13} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
            <span className="min-w-0 flex-1 break-words">{meeting.outcome.text}</span>
            {meeting.outcome.onUndo && (
              <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5" disabled={meeting.outcome.undoing || busy} onClick={meeting.outcome.onUndo}
                icon={meeting.outcome.undoing ? spinner : <Undo2 size={12} aria-hidden="true" />}>
                Undo
              </Button>
            )}
          </p>
        )}

        {CARD_GROUPS.map((group) => {
          const waitingIn = waitingItems.filter((item) => itemGroup(item) === group.key);
          const doneIn = rows.filter((row) => row.group === group.key);
          const count = waitingIn.length + doneIn.length;
          if (!count) return null;
          return (
            <div key={group.key} className="min-w-0">
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
                {group.icon}
                {count === 1 ? group.one : group.many}
                <span className="tabular-nums text-zinc-500">{count}</span>
              </h4>
              <ul className={listClass} aria-label={count === 1 ? group.one : group.many}>
                {waitingIn.map((item) => (
                  <SuggestionRow key={item.id} item={item} onAdd={add} onSkip={skip} pending={pending === item.id} busy={busy}
                    showProject={mixedProjects || projectLabels} showReason={!meeting} className="px-3 py-2.5" />
                ))}
                {doneIn.map(renderRow)}
              </ul>
            </div>
          );
        })}
        {!waitingItems.length && !rows.length && !settled.length && meeting && !meeting.outcome && (
          <p className="text-xs text-zinc-400">No suggestions are waiting.</p>
        )}

        {settled.length > 0 && (
          <div className="min-w-0">
            <button type="button" onClick={() => setSettledOpen((value) => !value)} aria-expanded={settledOpen}
              className="inline-flex items-center gap-1 rounded text-[11px] font-medium text-zinc-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
              <ChevronDown size={12} className={`transition-transform motion-reduce:transition-none ${settledOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              Taken back or skipped
              <span className="tabular-nums text-zinc-500">{settled.length}</span>
            </button>
            {settledOpen && <ul className={`mt-1.5 ${listClass}`} aria-label="Taken back or skipped">{settled.map(renderRow)}</ul>}
          </div>
        )}
      </div>

      {hasFooter && (
        <div className={`mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] py-2.5 ${CARD_INSET}`}>
          {question && triage && (
            // Amber until the thread is handled or answered: a decision waits on you.
            <NotePill
              label={handled ? 'Question' : answer ? 'Answered' : 'Question for you'}
              icon={<HelpCircle size={11} aria-hidden="true" />}
              width={420}
              className={handled || answer ? '' : '!bg-amber-500/[0.14] !text-amber-200 hover:!bg-amber-500/[0.22]'}
            >
              <NoteCardHeader name={who} avatar={avatar} at={triage.created_at} />
              <p className={`mb-1 text-[11px] font-semibold uppercase tracking-wider ${handled ? 'text-zinc-400' : 'text-amber-300'}`}>
                {handled ? 'Question (handled)' : 'Question for you'}
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-100">{question}</p>
              <QuestionAnswer agentName={who} answer={answer} waiting={waiting} onAnswer={handled || waiting ? undefined : onAnswer} />
            </NotePill>
          )}
          {replyPill}
          {owed.length > 0 && <RepliesOwedPill points={owed} who={who} avatar={avatar} at={at ?? new Date().toISOString()} />}
          {hasActions && (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              {!undoInHeader && undoAllButton}
              {meeting?.onNothingToDo && (
                <Tooltip content={addable.length ? 'Skips every suggestion and marks the meeting handled. Undo puts them back.' : 'Marks the meeting handled, with no new work from it.'}>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={meeting.onNothingToDo}
                    icon={bulk === 'nothing' ? spinner13 : <CircleSlash size={13} aria-hidden="true" />}>
                    Nothing to do
                  </Button>
                </Tooltip>
              )}
              {addAll && addable.length > 0 && (
                <Button size="sm" disabled={busy} onClick={() => void addAll(cardKey, addable)}
                  icon={pending === `add-all:${cardKey}` || (meeting && bulk === 'add_all') ? spinner13 : <Plus size={13} aria-hidden="true" />}>
                  {addable.length === 1 ? 'Add it' : `Add all ${addable.length}`}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const spinner = <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />;

/**
 * One row of the card's lists: what it is (linked where it opens), one quiet
 * line of detail, a status tag, and its action. Taken-back rows are struck.
 */
function CardRowShell({ icon, struck = false, title, meta, tag, action }: {
  icon: ReactNode;
  struck?: boolean;
  title: ReactNode;
  meta?: ReactNode;
  tag?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex min-h-10 min-w-0 items-center gap-2.5 px-3 py-2">
      <span className="flex w-4 flex-shrink-0 justify-center" aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className={`line-clamp-2 break-words text-[13px] font-medium leading-snug [overflow-wrap:anywhere] ${struck ? 'text-zinc-400 line-through' : 'text-zinc-100'}`}>{title}</div>
        {meta && <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">{meta}</p>}
      </div>
      {tag}
      {action}
    </li>
  );
}

/** A task's title, opening the task where it lives. */
function TaskLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <Link href={href} className="rounded underline decoration-white/20 underline-offset-2 hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
      {children}
    </Link>
  );
}

function DoneTag() {
  return <span className="flex-shrink-0 rounded-full bg-emerald-500/[0.12] px-2 py-0.5 text-[11px] font-semibold text-emerald-300">Done</span>;
}

/** A row's own action: a quiet button, its spinner while it runs. */
function RowButton({ label, icon, aria, running, disabled, onClick, tooltip }: {
  label: string;
  icon: ReactNode;
  aria: string;
  running: boolean;
  disabled: boolean;
  onClick: () => void;
  tooltip?: string;
}) {
  const button = (
    <Button size="sm" variant="ghost" className="!rounded-md !p-3 flex-shrink-0 sm:!px-2 sm:!py-1" disabled={disabled} onClick={onClick} aria-label={aria}
      icon={running ? spinner : icon}>
      {/* Phones: the icon alone, so the title keeps the room; the label stays for screen readers. */}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
  return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
}

/**
 * A task an older triage linked: created by the agent (Not a task sends it to
 * Trash) or existing work it tied the email to (Unlink takes the email off).
 * Taken back, it stays struck with Restore.
 */
function TaskReceipt({ task, messageId }: { task: InboxMessage['linked_tasks'][number]; messageId: string }) {
  const { trashed, notATask, undo, unlinked, unlink, relink, pending } = useContext(TaskUndoContext);
  const projectLabels = useContext(ProjectLabelsContext);
  const title = task.title ?? 'A task in another project';
  const key = linkKey(messageId, task);
  const running = pending === task.task_id || pending === key;
  const href = task.project_id && task.title !== null ? `/projects/${task.project_id}?task=${task.task_id}` : null;
  const project = projectLabels && task.project_name ? task.project_name : null;
  if (trashed[task.task_id] || unlinked[key]) {
    const binned = !!trashed[task.task_id];
    return (
      <CardRowShell
        icon={binned ? <Trash2 size={13} className="text-zinc-500" /> : <Unlink size={13} className="text-zinc-500" />}
        struck
        title={title}
        meta={binned ? 'Moved to Trash' : 'Unlinked from this email'}
        action={<RowButton label="Restore" icon={<RotateCcw size={13} aria-hidden="true" />} aria={`Restore: ${title}`} running={running}
          disabled={pending !== null} onClick={() => void (binned ? undo(task.task_id) : relink(key))} />}
      />
    );
  }
  const created = task.relation === 'created';
  const done = task.status === 'done';
  const dismissable = !!notATask && created && task.by === 'agent' && task.title !== null && !done;
  // A link the agent made to existing work comes off; the task itself stays.
  const unlinkable = !!unlink && !created && task.by === 'agent' && task.title !== null;
  const meta = [created ? null : task.relation === 'updated' ? 'Updated from this email' : 'Linked to this email', project].filter(Boolean).join(' · ');
  return (
    <CardRowShell
      icon={created ? (done ? <SquareCheck size={13} className="text-emerald-300" /> : <Square size={13} className="text-zinc-400" />) : <Link2 size={13} className="text-zinc-400" />}
      title={<TaskLink href={href}>{title}</TaskLink>}
      meta={meta || undefined}
      tag={done ? <DoneTag /> : undefined}
      action={dismissable ? (
        <RowButton label="Not a task" icon={<Trash2 size={13} aria-hidden="true" />} aria={`Not a task: move "${title}" to Trash`} running={running}
          disabled={pending !== null} onClick={() => void notATask(messageId, task)} tooltip="Moves it to Trash. Restore brings it back." />
      ) : unlinkable ? (
        <RowButton label="Unlink" icon={<Unlink size={13} aria-hidden="true" />} aria={`Unlink "${title}"`} running={running}
          disabled={pending !== null} onClick={() => void unlink!(messageId, task)}
          tooltip={task.relation === 'updated' ? 'Takes this email off the task. Changes already made to the task stay.' : 'Takes this email off the task. The task stays.'} />
      ) : undefined}
    />
  );
}

/** A reminder the agent set: Not needed sends it to Trash, Restore brings it back. One already done says so. */
function ReminderReceipt({ reminder, messageId }: { reminder: InboxReminder; messageId: string }) {
  const { trashedReminders, notNeeded, undoReminder, pending } = useContext(TaskUndoContext);
  const running = pending === reminder.id;
  if (trashedReminders[reminder.id]) {
    return (
      <CardRowShell
        icon={<Trash2 size={13} className="text-zinc-500" />}
        struck
        title={reminder.title}
        meta="Moved to Trash"
        action={<RowButton label="Restore" icon={<RotateCcw size={13} aria-hidden="true" />} aria={`Restore: ${reminder.title}`} running={running}
          disabled={pending !== null} onClick={() => void undoReminder(reminder.id)} />}
      />
    );
  }
  const done = reminder.status === 'done';
  const dismiss = notNeeded(reminder);
  return (
    <CardRowShell
      icon={<Bell size={13} className={done ? 'text-zinc-500' : 'text-amber-300'} />}
      title={reminder.title}
      meta={reminder.remind_on ? `On ${shortDate(reminder.remind_on)}` : undefined}
      tag={done ? <DoneTag /> : undefined}
      action={dismiss ? (
        <RowButton label="Not needed" icon={<Trash2 size={13} aria-hidden="true" />} aria={`Not needed: move "${reminder.title}" to Trash`} running={running}
          disabled={pending !== null} onClick={() => void dismiss(messageId)} tooltip="Moves it to Trash. Restore brings it back." />
      ) : undefined}
    />
  );
}

const ITEM_ICON: Record<CardGroup, (className: string) => ReactNode> = {
  task: (className) => <Square size={13} className={className || 'text-zinc-400'} />,
  reminder: (className) => <Bell size={13} className={className || 'text-amber-300'} />,
  comment: (className) => <MessageSquare size={13} className={className || 'text-zinc-400'} />,
  existing: (className) => <Link2 size={13} className={className || 'text-zinc-400'} />,
  other: (className) => <ListChecks size={13} className={className || 'text-zinc-400'} />,
};

/** One thing a plan did: what, where, unsure or approved, and Undo. */
function PlanItemRow({ item }: { item: InboxPlanItem }) {
  const { act, pending } = useContext(PlanActionsContext);
  const projectLabels = useContext(ProjectLabelsContext);
  const failed = item.state === 'failed';
  const title = rowTitle(item);
  const href = !!item.task_id && !!item.project_id && ['create_task', 'update_task', 'comment', 'attach_file', 'link_task'].includes(item.type)
    ? `/projects/${item.project_id}?task=${item.task_id}` : null;
  const unsure = item.decision === 'apply_unsure' && !failed;
  const finished = !!item.target_done;
  const meta = [
    failed ? `Did not go through: ${item.error ?? 'unknown error'}` : null,
    item.type === 'add_reminder' && item.remind_on ? `On ${shortDate(item.remind_on)}` : null,
    item.type === 'create_task' && item.due_date ? `Due ${shortDate(item.due_date)}` : null,
    item.state === 'accepted' ? 'You approved' : null,
    projectLabels ? item.project_name : null,
    unsure ? item.decision_reason ?? 'Applied without being sure: check it, or undo it.' : null,
  ].filter(Boolean).join(' · ');
  // The same words as an older email's rows: what undoing it does to this kind of thing.
  const undoAction = item.type === 'create_task' ? { label: 'Not a task', icon: <Trash2 size={13} aria-hidden="true" />, tip: 'Moves it to Trash. Restore brings it back.' }
    : item.type === 'add_reminder' ? { label: 'Not needed', icon: <Trash2 size={13} aria-hidden="true" />, tip: 'Moves it to Trash. Restore brings it back.' }
      : item.type === 'link_task' ? { label: 'Unlink', icon: <Unlink size={13} aria-hidden="true" />, tip: 'Takes this email off the task. The task stays.' }
        : { label: 'Undo', icon: <Undo2 size={13} aria-hidden="true" />, tip: undefined };
  return (
    <CardRowShell
      icon={failed ? <AlertTriangle size={13} className="text-red-300" />
        : finished && item.type === 'create_task' ? <SquareCheck size={13} className="text-emerald-300" />
          : ITEM_ICON[itemGroup(item)](finished ? 'text-zinc-500' : '')}
      title={<TaskLink href={href}>{title}</TaskLink>}
      meta={meta || undefined}
      tag={finished ? <DoneTag /> : unsure ? <span className="flex-shrink-0 rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-semibold text-amber-200">Unsure</span> : undefined}
      action={act && !finished && (item.state === 'done' || item.state === 'accepted') && UNDOABLE.has(item.type) ? (
        <RowButton label={undoAction.label} icon={undoAction.icon} aria={`${undoAction.label}: ${title}`} running={pending === item.id}
          disabled={pending !== null} onClick={() => void act('undo', item.id)} tooltip={undoAction.tip} />
      ) : undefined}
    />
  );
}

/** Something taken back (undone) or waved off (skipped), struck, with Restore where it can come back. */
function SettledItemRow({ item }: { item: InboxPlanItem }) {
  const { restore, pending } = useContext(PlanActionsContext);
  const skipped = item.state === 'dismissed';
  const restorable = skipped || RESTORABLE.has(item.type);
  const title = rowTitle(item);
  return (
    <CardRowShell
      icon={skipped ? <X size={13} className="text-zinc-500" /> : <Undo2 size={13} className="text-zinc-500" />}
      struck
      title={title}
      meta={skipped ? 'Skipped' : restorable ? 'Undone' : 'Undone. This kind of change cannot be put back from here.'}
      action={restore && restorable ? (
        <RowButton label="Restore" icon={<RotateCcw size={13} aria-hidden="true" />} aria={`Restore: ${title}`} running={pending === item.id}
          disabled={pending !== null} onClick={() => void restore(item)} />
      ) : undefined}
    />
  );
}

/** The replies this message says you owe, each marked Done once sent. */
function RepliesOwedPill({ points, who, avatar, at }: { points: InboxReplyPoint[]; who: string; avatar?: string; at: string }) {
  const { act, pending } = useContext(PlanActionsContext);
  return (
    <NotePill
      label={`${points.length} ${points.length === 1 ? 'reply' : 'replies'} owed`}
      icon={<MessageSquareReply size={11} className="text-sky-300" aria-hidden="true" />}
      width={440}
    >
      <NoteCardHeader name={who} avatar={avatar} at={at} />
      <ul className="space-y-2.5">
        {points.map((point) => (
          <li key={point.id} className="flex items-start gap-2 text-xs">
            <MessageSquareReply size={12} className="mt-0.5 flex-shrink-0 text-sky-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-100">
                <span className="font-semibold">{point.to_agent ? `${who} owes ${point.who}` : point.who}</span>: {point.what}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-400">
                {REPLY_KIND[point.kind]}{point.by_when ? ` · by ${shortDate(point.by_when)}` : ''}{point.urgent ? ' · urgent' : ''}
              </p>
              {point.note && <p className="mt-1 text-xs text-zinc-300">{point.note}</p>}
            </div>
            {act && (
              <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5 flex-shrink-0" disabled={pending !== null}
                onClick={() => void act('resolve', point.id)} aria-label={`Mark as replied: ${point.what}`}
                icon={pending === point.id ? spinner : <Check size={12} aria-hidden="true" />}>
                Done
              </Button>
            )}
          </li>
        ))}
      </ul>
    </NotePill>
  );
}

const REPLY_KIND: Record<InboxReplyPoint['kind'], string> = {
  info: 'They want an answer',
  decision: 'Your decision',
  security: 'Access or security',
  schedule: 'Scheduling',
};
