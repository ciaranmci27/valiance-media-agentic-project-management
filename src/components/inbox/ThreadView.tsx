'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadRead, peekRead, setReadData } from '@/lib/query-cache';
import { inboxThreadRead } from '@/lib/reads';
import Link from 'next/link';
import {
  AlertTriangle, ArrowDown, ArrowLeft, AlignLeft, Bell, Bot, Check, CheckCircle2, ChevronDown, Copy, Download, ExternalLink, Eye, FileText, Filter, Flame, Forward, HelpCircle, Image as ImageIcon, Inbox,
  Loader2, MessageSquareReply, Paperclip, PenLine, Plus, RefreshCw, RotateCcw, ShieldOff, SquareCheck, Tag, Trash2, Undo2, X,
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
import { toast } from '@/components/ui/Toast';
import { announceInboxChange, inboxClient } from '@/lib/communications/inbox-client';
import { skippedReasonLabel, type InboxAnswer, type InboxAttachment, type InboxLinkedTask, type InboxMessage, type InboxPlan, type InboxPlanItem, type InboxReminder, type InboxReplyPoint, type InboxThreadDetail, type InboxTriage, type ThreadProject, type TriageOutcome } from '@/lib/communications/inbox-types';
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
  pending: string | null;
}
const TaskUndoContext = createContext<TaskUndo>({ trashed: {}, undo: async () => {}, pending: null });
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
  pending: string | null;
}
const PlanActionsContext = createContext<PlanActions>({ pending: null });
/** Item types whose effect can be put back. */
const UNDOABLE = new Set(['create_task', 'update_task', 'comment', 'attach_file', 'add_reminder', 'update_reminder', 'complete_reminder',
  'link_task', 'reply_owed', 'mute_conversation', 'add_context', 'create_lead', 'log_interaction']);

export function ThreadView({ threadId, focusMessageId, onMissing, onBack }: ThreadViewProps) {
  const { isDemoMode } = useDemo();
  const { projects, team, deleteTask, restoreRecord } = useApp();
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
  const [trashedIn, setTrashedIn] = useState<{ threadId: string; tasks: TaskUndo['trashed'] }>({ threadId, tasks: {} });
  const [taskPending, setTaskPending] = useState<string | null>(null);
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

  const taskUndo = useMemo((): TaskUndo => {
    const trashed = trashedIn.threadId === threadId ? trashedIn.tasks : {};
    return {
      trashed,
      pending: taskPending,
      notATask: canTrashTasks ? async (messageId, task) => {
        setTaskPending(task.task_id);
        try {
          if (!(await deleteTask(task.task_id))) return;
          setTrashedIn({ threadId, tasks: { ...trashed, [task.task_id]: { messageId, task } } });
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
          const rest = { ...trashed };
          delete rest[taskId];
          setTrashedIn({ threadId, tasks: rest });
          toast('success', 'Task restored');
          announceInboxChange({ threadId });
          void load(true);
        } finally {
          setTaskPending(null);
        }
      },
    };
  }, [trashedIn, threadId, taskPending, canTrashTasks, deleteTask, restoreRecord, load]);

  const [planPending, setPlanPending] = useState<string | null>(null);
  const planActions = useMemo((): PlanActions => ({
    pending: planPending,
    act: canTriage ? async (action, id) => {
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
    } : undefined,
  }), [canTriage, client, load, planPending, threadId]);

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

  // Land on the newest message (or the linked one) once per thread.
  useEffect(() => {
    if (!detail || scrolledFor.current === detail.id) return;
    scrolledFor.current = detail.id;
    const target = focusMessageId ?? detail.messages[detail.messages.length - 1]?.id;
    requestAnimationFrame(() => {
      const node = target ? document.getElementById(`email-${target}`) : null;
      if (node && scrollRef.current) scrollRef.current.scrollTop = Math.max(0, node.offsetTop - 12);
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
  const menu: RowAction[] = [
    ...(canDraft && !drafting ? [{ label: 'Draft a reply', icon: <PenLine size={14} aria-hidden="true" />, onClick: () => setDraftDialog(true) }] : []),
    ...(fileCount > 0 ? [{ label: `Attachments (${fileCount})`, icon: <Paperclip size={14} aria-hidden="true" />, onClick: () => setAttachmentsOpen(true) }] : []),
    ...(canManageRules ? [{ label: 'Filter mail like this', icon: <Filter size={14} aria-hidden="true" />, onClick: () => setRuleFor(latest) }] : []),
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
            <h2 title={detail.subject || undefined} className="line-clamp-2 min-w-0 break-words text-base font-semibold leading-snug tracking-tight text-white sm:line-clamp-none sm:text-lg">{detail.subject || '(no subject)'}</h2>
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
              {detail.messages.length > 1 && <span>{detail.messages.length} emails</span>}
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
                  onRule={canManageRules ? () => setRuleFor(message) : undefined}
                  onAnswer={canTriage && !isDemoMode ? (text) => answerQuestion(message.id, text) : undefined}
                  questionInPanel={asking?.id === message.id}
                  busy={busy !== null}
                  onDownload={(attachment) => void downloadAttachment(attachment)}
                />
              </li>
            );
          })}
        </ol>
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
          Read only. Reply from your own mail; {agentName} never sends email.
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

function MessageCard({ message, agentName, focused, busy, viewUrl, onSendToAgent, onMoveToInbox, onAlwaysFilter, onRule, onAnswer, questionInPanel, onDownload, onPreview }: {
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
  const { trashed } = useContext(TaskUndoContext);
  // A task trashed here stays on its email (with Undo) after the thread stops listing it.
  const agentLinks = useMemo(() => {
    const live = message.linked_tasks.filter((task) => task.by === 'agent');
    const gone = Object.values(trashed)
      .filter((entry) => entry.messageId === message.id && !live.some((task) => task.task_id === entry.task.task_id))
      .map((entry) => entry.task);
    return [...live, ...gone];
  }, [message.linked_tasks, message.id, trashed]);
  const noteMode = message.triage ? agentNoteMode(message.triage, agentLinks, message.reminders, message.plan ?? null, message.reply_points ?? []) : null;
  // Images the HTML already shows in place are not listed again under it.
  const referenced = useMemo(() => inlineImageIds(message.html_body), [message.html_body]);
  const listed = showingHtml
    ? message.attachments.filter((attachment) => !(attachment.content_id && referenced.has(attachment.content_id) && inlineImages[attachment.content_id]))
    : message.attachments;
  // A teammate's forward shows the original sender; the teammate gets their own line.
  const shownFrom = message.original_sender ?? message.from;
  const sender = shownFrom?.name || shownFrom?.address || 'Unknown sender';
  // A pitch the agent filtered (not a rule or bulk mail): it can go back to the Inbox.
  const pitch = message.triage?.category === 'outreach';
  const teammate = message.forwarded_by?.name || message.from?.name || message.from?.address || 'a teammate';
  const forwardedByTeam = message.routing_basis === 'forwarded_original';
  const routedNote = forwardedByTeam
    ? `Forwarded by ${teammate}`
    : message.routing_basis === 'team_recipients' ? `Sent by ${teammate}, CC'd to the inbox` : null;
  const recipients = [
    message.to.length ? `To ${message.to.map((p) => p.name || p.address).join(', ')}` : '',
    message.cc.length ? `Cc ${message.cc.map((p) => p.name || p.address).join(', ')}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <article
      id={`email-${message.id}`}
      aria-label={`Email from ${sender}`}
      className={`rounded-xl border bg-white/[0.02] ${focused ? 'border-brand-400/50 ring-1 ring-brand-400/30' : 'border-white/[0.07]'}`}
    >
      <header className="flex items-start gap-3 px-3 pt-3 sm:px-4 sm:pt-3.5">
        <Avatar name={sender} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-white">{sender}</span>
            {/* Phones: the time rides on the name line instead of taking a column. */}
            <time dateTime={message.received_at} className="ml-auto text-xs tabular-nums text-zinc-400 sm:hidden">{formatListTime(message.received_at)}</time>
            {shownFrom?.name && <span className="min-w-0 max-w-full basis-full truncate text-xs text-zinc-400 sm:basis-auto">{shownFrom.address}</span>}
            {/* Trust is the verdict on the outer sender, so a teammate's forward shows it on their line. */}
            {!forwardedByTeam && <TrustBadge level={message.trust.level} />}
            {message.is_forward && !forwardedByTeam && (
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
          <TrustNote level={message.trust.level} reason={message.trust.reason} />
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1">
          <time dateTime={message.received_at} className="hidden text-xs tabular-nums text-zinc-400 sm:block">{formatFullTime(message.received_at)}</time>
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

      <div className="px-2 py-3 sm:px-4">
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

      {listed.length > 0 && <AttachmentList attachments={listed} agentName={agentName} viewUrl={viewUrl} onDownload={onDownload} onPreview={onPreview} />}

      {message.triage && noteMode && (
        <AgentNote messageId={message.id} triage={message.triage} agentName={agentName} linkedTasks={agentLinks} reminders={message.reminders} collapsed={noteMode === 'summary'} handled={!!message.reviewed_at}
          answer={message.answer ?? null} waiting={message.status === 'new'} onAnswer={onAnswer} questionInPanel={!!questionInPanel} plan={message.plan ?? null} points={message.reply_points ?? []} />
      )}
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
      <ul className="grid gap-2 sm:grid-cols-2">
        {attachments.map((attachment) => {
          const Icon = attachment.kind === 'image' ? ImageIcon : FileText;
          const previewable = !!onPreview && attachment.available && attachment.kind !== 'other';
          const thumbnail = attachment.kind === 'image' && attachment.available && viewUrl;
          return (
            <li key={attachment.id} className="flex items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
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
                    <span><span className="sr-only">{agentName}&apos;s label: </span>{attachment.agent_label}</span>
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

/**
 * How much of the agent's triage an email shows, always in the same place
 * under it: an action receipt when it did something or needs you
 * ("actions"), else one quiet "No action" row with the summary a click away.
 */
function agentNoteMode(triage: InboxTriage, linkedTasks: InboxMessage['linked_tasks'], reminders: InboxReminder[], plan: InboxPlan | null, points: InboxReplyPoint[]): 'actions' | 'summary' {
  if (triage.outcome !== 'no_action' || triage.urgent || triage.question_for_human || linkedTasks.length > 0 || reminders.length > 0) return 'actions';
  if ((plan?.items.some((item) => item.state !== 'skipped') ?? false) || points.length > 0) return 'actions';
  return 'summary';
}

/** The agent who triaged: its name and its photo from the team directory. */
function useTriager(triage: InboxTriage, agentName: string): { name: string; avatar?: string } {
  const { team } = useApp();
  const name = triage.member?.name ?? agentName;
  const member = triage.member ? team.find((m) => m.id === triage.member!.id) : team.find((m) => m.name === agentName);
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
 * One linked task as a receipt item: what happened to it, then the task. A
 * task the agent created can be waved off as "Not a task" (to Trash), and
 * brought back with Undo.
 */
function TaskReceipt({ task, messageId }: { task: InboxMessage['linked_tasks'][number]; messageId: string }) {
  const { trashed, notATask, undo, pending } = useContext(TaskUndoContext);
  const projectLabels = useContext(ProjectLabelsContext);
  const verb = task.relation === 'created' ? 'Created' : task.relation === 'updated' ? 'Updated' : 'About';
  const title = task.title ?? 'Task';
  const busy = pending === task.task_id;
  if (trashed[task.task_id]) {
    return (
      <li className="flex min-w-0 items-center gap-2 text-xs">
        <Trash2 size={12} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-zinc-400"><span className="line-through">{title}</span> moved to Trash</span>
        <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5" disabled={busy} onClick={() => void undo(task.task_id)}
          icon={busy ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Undo2 size={12} aria-hidden="true" />}>
          Undo
        </Button>
      </li>
    );
  }
  const dismissable = !!notATask && task.relation === 'created' && task.by === 'agent' && task.title !== null && task.status !== 'done';
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs">
      <SquareCheck size={12} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
      <span className="w-[3.75rem] flex-shrink-0 text-zinc-400">{verb}</span>
      {task.project_id && task.title === null ? (
        // In a project this member cannot open: no title, no link.
        <span className="min-w-0 flex-1 truncate text-zinc-300">a task in another project</span>
      ) : task.project_id ? (
        <Link
          href={`/projects/${task.project_id}?task=${task.task_id}`}
          title={title}
          className="min-w-0 flex-1 truncate rounded font-medium text-zinc-100 underline decoration-white/20 underline-offset-2 hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {title}
        </Link>
      ) : (
        <span className="min-w-0 flex-1 truncate text-zinc-300">{title}</span>
      )}
      {projectLabels && <TaskProjectLabel task={task} />}
      {dismissable && (
        <Tooltip content="Moves it to Trash. Undo brings it back.">
          <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5 flex-shrink-0" disabled={busy}
            onClick={() => void notATask(messageId, task)} aria-label={`Not a task: move "${title}" to Trash`}
            icon={busy ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <X size={12} aria-hidden="true" />}>
            Not a task
          </Button>
        </Tooltip>
      )}
    </li>
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

/**
 * What the agent did with an email, under it, as one line of pills that
 * each open a card: its summary, the tasks it touched, the reminders it
 * set, a question for you (amber until the thread is handled) and an old
 * suggested reply. Nothing repeats the email or spreads across the page.
 */
function AgentNote({ messageId, triage, agentName, linkedTasks, reminders, collapsed, handled, answer, waiting, onAnswer, questionInPanel, plan, points }: {
  messageId: string;
  /** The plan behind this triage, when the agent planned it: its pills replace the task and reminder ones. */
  plan: InboxPlan | null;
  /** Replies owed this email raised. */
  points: InboxReplyPoint[];
  /** A person's answer to this triage's question. */
  answer: InboxAnswer | null;
  /** The email is back with the agent (after an answer, say). */
  waiting: boolean;
  onAnswer?: (text: string) => Promise<boolean>;
  /** The question is open in the decision card at the end of the thread. */
  questionInPanel: boolean;
  triage: InboxTriage;
  agentName: string;
  linkedTasks: InboxMessage['linked_tasks'];
  /** Reminders the agent set from this email. */
  reminders: InboxReminder[];
  /** Someone marked the email handled: its question is settled and stops calling for attention. */
  handled: boolean;
  /** Only a summary to show: say "No action" rather than the outcome. */
  collapsed: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const { name: who, avatar } = useTriager(triage, agentName);
  const outcome = OUTCOME[triage.outcome];
  const OutcomeIcon = outcome.icon;

  const copyReply = async () => {
    if (!triage.suggested_reply) return;
    try {
      await navigator.clipboard.writeText(triage.suggested_reply);
      setCopied(true);
      toast('success', 'Reply copied. Paste it into your own mail.');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('error', 'Could not copy to the clipboard');
    }
  };

  return (
    <section aria-label={`What ${who} did`} className="mx-4 mb-3 border-t border-white/[0.06] pt-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-zinc-200">
          <Avatar name={who} src={avatar} size="xs" />
          {who}
        </span>
        {triage.urgent && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-300">
            <Flame size={11} aria-hidden="true" />
            Urgent
          </span>
        )}
        {linkedTasks.length === 0 && reminders.length === 0 && !triage.question_for_human && !plan && (
          <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${outcome.className}`}>
            <OutcomeIcon size={11} aria-hidden="true" />
            {collapsed ? 'No action' : outcome.label}
          </span>
        )}
        <NotePill label="Summary" icon={<AlignLeft size={11} aria-hidden="true" />}>
          <NoteCardHeader name={who} avatar={avatar} at={triage.created_at} />
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{triage.summary}</p>
        </NotePill>
        {plan && <PlanPills plan={plan} points={points} who={who} avatar={avatar} at={triage.created_at} />}
        {!plan && linkedTasks.length > 0 && (
          <NotePill
            label={`${linkedTasks.length} ${linkedTasks.length === 1 ? 'task' : 'tasks'}`}
            icon={<SquareCheck size={11} className="text-emerald-300" aria-hidden="true" />}
            width={440}
          >
            <NoteCardHeader name={who} avatar={avatar} at={triage.created_at} />
            <ul className="space-y-1.5">
              {linkedTasks.map((task) => <TaskReceipt key={`${task.task_id}-${task.relation}`} task={task} messageId={messageId} />)}
            </ul>
          </NotePill>
        )}
        {!plan && reminders.length > 0 && (
          <NotePill
            label={`${reminders.length} ${reminders.length === 1 ? 'reminder' : 'reminders'}`}
            icon={<Bell size={11} className="text-amber-300" aria-hidden="true" />}
            width={400}
          >
            <NoteCardHeader name={who} avatar={avatar} at={triage.created_at} />
            <ul className="space-y-1.5">
              {reminders.map((reminder) => (
                <li key={reminder.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                  <Bell size={12} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
                  <span className={`min-w-0 truncate font-medium ${reminder.status === 'done' ? 'text-zinc-400 line-through' : 'text-zinc-100'}`}>{reminder.title}</span>
                  {reminder.remind_on && <span className="flex-shrink-0 text-zinc-400">{shortDate(reminder.remind_on)}</span>}
                  {reminder.status === 'done' && <span className="sr-only">(done)</span>}
                </li>
              ))}
            </ul>
          </NotePill>
        )}
        {triage.question_for_human && !questionInPanel && (
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
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-100">{triage.question_for_human}</p>
            <QuestionAnswer agentName={who} answer={answer} waiting={waiting} onAnswer={handled || waiting ? undefined : onAnswer} />
          </NotePill>
        )}
        {triage.suggested_reply && (
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
        )}
      </div>
    </section>
  );
}

const spinner = <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />;

/**
 * A plan's items as pills beside the summary: what the agent did (each with
 * an "Unsure" mark when it applied it without being sure, and Undo), what
 * waits for your OK (Accept or Dismiss, with the reason it waits), and the
 * replies you owe (Done).
 */
function PlanPills({ plan, points, who, avatar, at }: { plan: InboxPlan; points: InboxReplyPoint[]; who: string; avatar?: string; at: string }) {
  const { act, pending } = useContext(PlanActionsContext);
  const done = plan.items.filter((item) => ['done', 'accepted', 'undone', 'failed'].includes(item.state) && item.type !== 'reply_owed');
  const proposals = plan.items.filter((item) => item.state === 'pending');
  const owed = points.filter((point) => point.state === 'open');
  const unsure = done.filter((item) => item.decision === 'apply_unsure' && item.state === 'done').length;
  const undoable = done.some((item) => (item.state === 'done' || item.state === 'accepted') && UNDOABLE.has(item.type));
  return (
    <>
      {done.length > 0 && (
        <NotePill
          label={unsure ? `${done.length} done · ${unsure} unsure` : `${done.length} done`}
          icon={<SquareCheck size={11} className="text-emerald-300" aria-hidden="true" />}
          width={460}
        >
          <NoteCardHeader name={who} avatar={avatar} at={at} />
          <ul className="space-y-2">
            {done.map((item) => <PlanItemRow key={item.id} item={item} />)}
          </ul>
          {act && undoable && plan.status !== 'undone' && (
            <div className="mt-3 flex justify-end border-t border-white/[0.06] pt-2.5">
              <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => void act('undo_plan', plan.id)}
                icon={pending === plan.id ? spinner : <Undo2 size={12} aria-hidden="true" />}>
                Undo all of it
              </Button>
            </div>
          )}
        </NotePill>
      )}
      {proposals.length > 0 && (
        <NotePill
          label={`${proposals.length} to approve`}
          icon={<HelpCircle size={11} aria-hidden="true" />}
          width={460}
          className="!bg-amber-500/[0.14] !text-amber-200 hover:!bg-amber-500/[0.22]"
        >
          <NoteCardHeader name={who} avatar={avatar} at={at} />
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-300">Waiting for your OK</p>
          <ul className="space-y-3">
            {proposals.map((item) => (
              <li key={item.id} className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <p className="text-sm font-medium text-zinc-100">{item.label}</p>
                {item.project_name && <p className="mt-0.5 text-[11px] text-zinc-400">{item.project_name}</p>}
                {item.decision_reason && <p className="mt-1 text-xs text-zinc-300">{item.decision_reason}</p>}
                {item.evidence && <p className="mt-1 text-xs italic text-zinc-400">&ldquo;{item.evidence}&rdquo;</p>}
                {act && (
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => void act('dismiss', item.id)}
                      aria-label={`Dismiss: ${item.label}`} icon={<X size={12} aria-hidden="true" />}>
                      Dismiss
                    </Button>
                    <Button size="sm" disabled={pending !== null} onClick={() => void act('accept', item.id)}
                      aria-label={`Accept: ${item.label}`} icon={pending === item.id ? spinner : <Check size={12} aria-hidden="true" />}>
                      Accept
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </NotePill>
      )}
      {owed.length > 0 && (
        <NotePill
          label={`${owed.length} ${owed.length === 1 ? 'reply' : 'replies'} owed`}
          icon={<MessageSquareReply size={11} className="text-sky-300" aria-hidden="true" />}
          width={440}
        >
          <NoteCardHeader name={who} avatar={avatar} at={at} />
          <ul className="space-y-2.5">
            {owed.map((point) => (
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
      )}
    </>
  );
}

const REPLY_KIND: Record<InboxReplyPoint['kind'], string> = {
  info: 'They want an answer',
  decision: 'Your decision',
  security: 'Access or security',
  schedule: 'Scheduling',
};

/** One thing the agent did: what, where, unsure or undone, and Undo. */
function PlanItemRow({ item }: { item: InboxPlanItem }) {
  const { act, pending } = useContext(PlanActionsContext);
  const undone = item.state === 'undone';
  const failed = item.state === 'failed';
  const linkable = !!item.task_id && !!item.project_id && !undone && ['create_task', 'update_task', 'comment', 'attach_file', 'link_task'].includes(item.type);
  return (
    <li className="flex min-w-0 items-start gap-2 text-xs">
      {failed
        ? <AlertTriangle size={12} className="mt-0.5 flex-shrink-0 text-red-300" aria-hidden="true" />
        : <SquareCheck size={12} className={`mt-0.5 flex-shrink-0 ${undone ? 'text-zinc-500' : 'text-emerald-300'}`} aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        {linkable ? (
          <Link href={`/projects/${item.project_id}?task=${item.task_id}`}
            className="rounded font-medium text-zinc-100 underline decoration-white/20 underline-offset-2 hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            {item.label}
          </Link>
        ) : (
          <span className={`font-medium ${undone ? 'text-zinc-400 line-through' : 'text-zinc-100'}`}>{item.label}</span>
        )}
        <span className="ml-1.5 inline-flex flex-wrap items-center gap-1 align-middle">
          {item.decision === 'apply_unsure' && !undone && (
            <Tooltip content={item.decision_reason ?? 'Applied without being sure: check it, or undo it.'}>
              <span className="rounded-full bg-amber-500/[0.14] px-1.5 py-px text-[10px] font-semibold text-amber-200">Unsure</span>
            </Tooltip>
          )}
          {item.state === 'accepted' && <span className="rounded-full bg-white/[0.06] px-1.5 py-px text-[10px] text-zinc-300">You approved</span>}
          {undone && <span className="text-[11px] text-zinc-400">Undone</span>}
        </span>
        {item.project_name && !undone && <p className="mt-0.5 text-[11px] text-zinc-400">{item.project_name}</p>}
        {failed && <p className="mt-0.5 text-[11px] text-red-300">Did not go through: {item.error ?? 'unknown error'}</p>}
      </div>
      {act && (item.state === 'done' || item.state === 'accepted') && UNDOABLE.has(item.type) && (
        <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5 flex-shrink-0" disabled={pending !== null}
          onClick={() => void act('undo', item.id)} aria-label={`Undo: ${item.label}`}
          icon={pending === item.id ? spinner : <Undo2 size={12} aria-hidden="true" />}>
          Undo
        </Button>
      )}
    </li>
  );
}
