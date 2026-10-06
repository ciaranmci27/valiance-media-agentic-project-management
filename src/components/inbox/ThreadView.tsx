'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, Bot, Check, CheckCircle2, ChevronDown, Copy, Download, FileText, Flame, Forward, HelpCircle, Image as ImageIcon,
  Loader2, MessageSquareReply, Paperclip, RefreshCw, RotateCcw, ShieldOff, Sparkles, SquareCheck, Tag, UserCheck,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { announceInboxChange, inboxClient } from '@/lib/inbound-email/inbox-client';
import type { InboxAttachment, InboxMessage, InboxThreadDetail, InboxTriage, TriageOutcome } from '@/lib/inbound-email/inbox-types';
import { EmailBodyFrame, hasRemoteImages } from './EmailBodyFrame';
import { ProjectSourceBadge, ThreadStateBadge, TrustBadge, formatBytes, formatFullTime } from './inbox-badges';
import { ThreadProjectDialog } from './ThreadProjectDialog';

interface ThreadViewProps {
  threadId: string;
  focusMessageId?: string | null;
  onChanged?: () => void;
  onMissing?: () => void;
}

const OUTCOME: Record<TriageOutcome, { label: string; icon: typeof Bot; className: string }> = {
  no_action: { label: 'No action needed', icon: CheckCircle2, className: 'text-zinc-300' },
  task: { label: 'Tasks drafted or updated', icon: SquareCheck, className: 'text-emerald-300' },
  needs_reply: { label: 'Reply suggested', icon: MessageSquareReply, className: 'text-amber-300' },
  needs_ciaran: { label: 'Needs you', icon: HelpCircle, className: 'text-red-300' },
};

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' }).format(date);
}

/** The selected thread: oldest message first, each with what the agent made of it. Read only. */
export function ThreadView({ threadId, focusMessageId, onChanged, onMissing }: ThreadViewProps) {
  const { isDemoMode } = useDemo();
  const { projects, emailsRefreshSignal } = useApp();
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const [detail, setDetail] = useState<InboxThreadDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'handled' | 'send_back' | null>(null);
  const [projectDialog, setProjectDialog] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError('');
    try {
      setDetail(await client.threadDetail(threadId));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load this thread';
      if (/not found/i.test(message) && onMissing) {
        toast('info', 'That thread is no longer available');
        onMissing();
        return;
      }
      if (!silent) setError(message);
    }
  }, [client, threadId, onMissing]);

  useEffect(() => { void load(); }, [load]);
  const firstSignal = useRef(emailsRefreshSignal);
  useEffect(() => {
    if (emailsRefreshSignal !== firstSignal.current) void load(true);
  }, [emailsRefreshSignal, load]);

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
  const after = async (action: () => Promise<unknown>, success: string, kind: 'handled' | 'send_back') => {
    setBusy(kind);
    try {
      await action();
      toast('success', success);
      await load(true);
      onChanged?.();
      announceInboxChange();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  if (error && !detail) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle size={28} className="text-red-400" aria-hidden="true" />
        <p className="text-sm text-zinc-300">{error}</p>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => void load()}>Try again</Button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="space-y-4 p-5" aria-busy="true" aria-label="Loading thread">
        <div className="h-5 w-2/3 animate-pulse rounded bg-white/[0.08] motion-reduce:animate-none" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" />
        {[0, 1].map((i) => (
          <div key={i} className="space-y-2 rounded-xl border border-white/[0.06] p-4">
            <div className="h-3.5 w-40 animate-pulse rounded bg-white/[0.08] motion-reduce:animate-none" />
            <div className="h-3 w-full animate-pulse rounded bg-white/[0.05] motion-reduce:animate-none" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-white/[0.05] motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    );
  }

  const latest = detail.messages[detail.messages.length - 1];
  const canHandle = detail.state === 'needs_you' || detail.state === 'new' || detail.state === 'needs_reply';
  const canSendBack = !!latest && latest.status !== 'new';
  const projectColor = detail.project ? projects.find((p) => p.id === detail.project!.id)?.color : undefined;
  let lastDay = '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="space-y-3 border-b border-white/[0.06] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[min(100%,240px)] flex-1">
            <h2 className="break-words text-base font-semibold leading-snug text-white">{detail.subject || '(no subject)'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <ThreadStateBadge state={detail.state} />
              {detail.urgent && (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                  <Flame size={11} aria-hidden="true" />
                  Urgent
                </span>
              )}
              {detail.untrusted && <TrustBadge level="untrusted" />}
              <span>
                {detail.inbox.name} inbox, {detail.messages.length} {detail.messages.length === 1 ? 'message' : 'messages'}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<RotateCcw size={13} aria-hidden="true" />}
              disabled={!canSendBack || busy !== null}
              onClick={() => void after(() => client.sendBack(detail.id, null), `Sent back to ${agentName}`, 'send_back')}
              title={canSendBack ? `${agentName} triages the newest message again` : `Already waiting for ${agentName}`}
            >
              {busy === 'send_back' ? 'Sending back...' : `Send back to ${agentName}`}
            </Button>
            <Button
              size="sm"
              icon={busy === 'handled' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}
              disabled={!canHandle || busy !== null}
              onClick={() => void after(() => client.markHandled(detail.id), 'Marked handled', 'handled')}
            >
              Mark handled
            </Button>
          </div>
        </div>

        {/* Project */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2">
          <span className="text-xs font-medium text-zinc-400">Project</span>
          {detail.project ? (
            <ProjectSourceBadge project={detail.project} agentName={agentName} color={projectColor} />
          ) : (
            <span className="text-xs text-zinc-300">
              {detail.candidates.length > 1
                ? `Not set. Mapping matched ${detail.candidates.length} projects: ${detail.candidates.map((c) => c.name ?? 'Project').join(', ')}`
                : 'Not set'}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {detail.project?.source === 'inferred' && (
              <Button size="sm" variant="secondary" icon={<UserCheck size={13} aria-hidden="true" />} onClick={() => setProjectDialog(true)}>
                Confirm
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setProjectDialog(true)}>
              {detail.project ? 'Change' : 'Set project'}
            </Button>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        <ol className="space-y-3">
          {detail.messages.map((message) => {
            const day = dayLabel(message.received_at);
            const showDay = day !== lastDay;
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
                  onSendToAgent={() => void after(() => client.sendBack(detail.id, message.id), `Sent to ${agentName}`, 'send_back')}
                  busy={busy !== null}
                  onDownload={async (attachment) => {
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
                  }}
                />
              </li>
            );
          })}
        </ol>
        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-[11px] text-zinc-400">
          <ShieldOff size={11} aria-hidden="true" />
          Read only. Reply from your own mail; {agentName} never sends email.
        </p>
      </div>

      <ThreadProjectDialog
        isOpen={projectDialog}
        onClose={() => setProjectDialog(false)}
        detail={detail}
        onSaved={async () => {
          setProjectDialog(false);
          await load(true);
          onChanged?.();
          announceInboxChange();
        }}
      />
    </div>
  );
}

function MessageCard({ message, agentName, focused, busy, onSendToAgent, onDownload }: {
  message: InboxMessage;
  agentName: string;
  focused: boolean;
  busy: boolean;
  onSendToAgent: () => void;
  onDownload: (attachment: InboxAttachment) => void;
}) {
  const hasNewText = !!message.new_text?.trim();
  const fullDiffers = !!message.html_body || (!!message.text_body && message.text_body.trim() !== (message.new_text ?? '').trim());
  // Forwards carry their substance below the marker, so they open in full.
  const [full, setFull] = useState(message.is_forward || !hasNewText);
  const sender = message.from?.name || message.from?.address || 'Unknown sender';
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
      <header className="flex flex-wrap items-start gap-3 px-4 pt-3.5">
        <Avatar name={sender} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-white">{sender}</span>
            {message.from?.name && <span className="truncate text-xs text-zinc-400">{message.from.address}</span>}
            <TrustBadge level={message.trust.level} reason={message.trust.reason} />
            {message.is_forward && (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-zinc-300">
                <Forward size={11} aria-hidden="true" />
                Forwarded
              </span>
            )}
          </div>
          {recipients && <p className="mt-0.5 break-words text-[11px] text-zinc-400">{recipients}</p>}
        </div>
        <time dateTime={message.received_at} className="flex-shrink-0 text-xs tabular-nums text-zinc-400">{formatFullTime(message.received_at)}</time>
      </header>

      {message.status === 'ignored' && (
        <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">
          <span>Ignored as automatic mail{message.auto_mail_reason ? `: ${message.auto_mail_reason}` : ''}.</span>
          <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={onSendToAgent} icon={<RotateCcw size={12} aria-hidden="true" />}>
            Send to {agentName}
          </Button>
        </div>
      )}

      <div className="px-4 py-3">
        {full && message.html_body ? (
          <div className="space-y-1.5">
            {hasRemoteImages(message.html_body) && (
              <p className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                <ImageIcon size={11} aria-hidden="true" />
                Remote images are blocked so the sender cannot track when this was read.
              </p>
            )}
            <EmailBodyFrame html={message.html_body} title={`Email from ${sender}: ${message.subject || 'no subject'}`} />
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200 [overflow-wrap:anywhere]">
            {(full ? message.text_body || message.new_text : message.new_text) || 'This email has no text.'}
          </p>
        )}
        {hasNewText && fullDiffers && (
          <button
            type="button"
            onClick={() => setFull((value) => !value)}
            aria-expanded={full}
            className="mt-2 inline-flex items-center gap-1 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ChevronDown size={13} className={`transition-transform motion-reduce:transition-none ${full ? 'rotate-180' : ''}`} aria-hidden="true" />
            {full ? 'Show the new text only' : 'Show full email'}
          </button>
        )}
      </div>

      {message.attachments.length > 0 && <AttachmentList attachments={message.attachments} agentName={agentName} onDownload={onDownload} />}

      {message.triage && <TriageCard triage={message.triage} agentName={agentName} linkedTasks={message.linked_tasks} />}
      {!message.triage && message.status === 'new' && (
        <p className="mx-4 mb-3 flex items-center gap-1.5 text-xs text-zinc-400">
          <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Waiting for {agentName} to triage
        </p>
      )}
      {message.reviewed_at && (
        <p className="mx-4 mb-3 flex items-center gap-1.5 text-[11px] text-zinc-400">
          <Check size={11} aria-hidden="true" />
          Marked handled by {message.reviewed_by?.name ?? 'someone'}, {formatFullTime(message.reviewed_at)}
        </p>
      )}
    </article>
  );
}

function AttachmentList({ attachments, agentName, onDownload }: { attachments: InboxAttachment[]; agentName: string; onDownload: (a: InboxAttachment) => void }) {
  return (
    <div className="border-t border-white/[0.05] px-4 py-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
        <Paperclip size={12} aria-hidden="true" />
        {attachments.length} {attachments.length === 1 ? 'attachment' : 'attachments'}
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {attachments.map((attachment) => {
          const Icon = attachment.kind === 'image' ? ImageIcon : FileText;
          return (
            <li key={attachment.id} className="flex items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
              <Icon size={16} className="mt-0.5 flex-shrink-0 text-zinc-400" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-zinc-200" title={attachment.filename}>{attachment.filename}</p>
                <p className="text-[11px] text-zinc-400">
                  {attachment.available ? formatBytes(attachment.size_bytes) : 'Not stored: it was over the size limit'}
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

function TriageCard({ triage, agentName, linkedTasks }: { triage: InboxTriage; agentName: string; linkedTasks: InboxMessage['linked_tasks'] }) {
  const [copied, setCopied] = useState(false);
  const outcome = OUTCOME[triage.outcome];
  const OutcomeIcon = outcome.icon;
  const who = triage.member?.name ?? agentName;

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
    <section aria-label={`${who}'s triage`} className="mx-3 mb-3 rounded-lg border border-brand-500/20 bg-brand-500/[0.06] px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-200">
          <Sparkles size={13} aria-hidden="true" />
          {who}
        </span>
        <span className={`inline-flex items-center gap-1 text-xs font-medium ${outcome.className}`}>
          <OutcomeIcon size={12} aria-hidden="true" />
          {outcome.label}
        </span>
        {triage.urgent && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white">
            <Flame size={11} aria-hidden="true" />
            Urgent
          </span>
        )}
        <time dateTime={triage.created_at} className="ml-auto text-[11px] text-zinc-400">{formatFullTime(triage.created_at)}</time>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{triage.summary}</p>

      {triage.question_for_ciaran && (
        <div className="mt-2.5 rounded-md border border-amber-400/25 bg-amber-500/[0.08] px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">Question for you</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-amber-100">{triage.question_for_ciaran}</p>
        </div>
      )}

      {linkedTasks.length > 0 && (
        <div className="mt-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Linked tasks</p>
          <ul className="mt-1 space-y-1">
            {linkedTasks.map((task) => (
              <li key={`${task.task_id}-${task.relation}`} className="flex flex-wrap items-center gap-2 text-sm">
                <SquareCheck size={13} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
                {task.project_id ? (
                  <Link
                    href={`/projects/${task.project_id}?task=${task.task_id}`}
                    className="min-w-0 truncate rounded text-zinc-100 underline decoration-white/20 underline-offset-2 hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {task.title ?? 'Task'}
                  </Link>
                ) : (
                  <span className="text-zinc-300">{task.title ?? 'Task'}</span>
                )}
                <span className="text-[11px] text-zinc-400">{task.relation === 'created' ? 'Created' : 'Updated'}</span>
                {task.status && <StatusBadge status={task.status} tooltip={false} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {triage.suggested_reply && (
        <div className="mt-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Suggested reply</p>
            <Button size="sm" variant="secondary" onClick={() => void copyReply()} icon={copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <blockquote className="mt-1.5 whitespace-pre-wrap rounded-md border-l-2 border-brand-400/40 bg-white/[0.03] px-3 py-2 text-sm leading-relaxed text-zinc-200">
            {triage.suggested_reply}
          </blockquote>
          <p className="mt-1 text-[11px] text-zinc-400">Copy it into your own mail. Nothing is sent from here.</p>
        </div>
      )}
    </section>
  );
}
