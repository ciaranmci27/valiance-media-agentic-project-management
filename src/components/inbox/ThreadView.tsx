'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, AlignLeft, Bot, Check, CheckCircle2, ChevronDown, Copy, Download, ExternalLink, Eye, FileText, Flame, Forward, HelpCircle, Image as ImageIcon,
  Loader2, MessageSquareReply, Paperclip, RefreshCw, RotateCcw, ShieldOff, SquareCheck, Tag,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { Popover } from '@/components/ui/Popover';
import { toast } from '@/components/ui/Toast';
import { announceInboxChange, inboxClient } from '@/lib/inbound-email/inbox-client';
import { skippedReasonLabel, type InboxAttachment, type InboxMessage, type InboxThreadDetail, type InboxTriage, type TriageOutcome } from '@/lib/inbound-email/inbox-types';
import { hasQuotedHtml, inlineImageIds, linkParts, opensAsHtml } from '@/lib/inbound-email/display';
import { FilePreviewModal } from '@/components/ui/FilePreviewModal';
import { EmailBodyFrame } from './EmailBodyFrame';
import { ProjectChip, ThreadStateDot, TrustBadge, TrustNote, formatBytes, formatFullTime } from './inbox-badges';
import { ThreadProjectDialog } from './ThreadProjectDialog';
import { useInboxUpdates } from './use-inbox-updates';

interface ThreadViewProps {
  threadId: string;
  focusMessageId?: string | null;
  /** The thread is gone or out of reach. */
  onMissing?: () => void;
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
export function ThreadView({ threadId, focusMessageId, onMissing }: ThreadViewProps) {
  const { isDemoMode } = useDemo();
  const { projects } = useApp();
  const { access } = useAuth();
  const canTriage = hasPermission(access, 'inbound_email.triage') || hasPermission(access, 'inbound_email.manage');
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const [detail, setDetail] = useState<InboxThreadDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'handled' | 'send_back' | null>(null);
  const [projectDialog, setProjectDialog] = useState(false);
  const [preview, setPreview] = useState<InboxAttachment | null>(null);
  // Stable while open: the preview refetches whenever its file object changes.
  const previewFile = useMemo(
    () => (preview ? { name: preview.filename, file_url: attachmentViewUrl(preview.id), mime_type: previewType(preview) } : null),
    [preview],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
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
      const next = await client.threadDetail(threadId);
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
  }, [client, threadId]);

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
      // The list and the sidebar badge refresh from this; this view already has.
      announceInboxChange({ threadId });
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
  // Who cleared the thread and when: the Handled status says it, not every email.
  const reviewed = [...detail.messages].reverse().find((message) => message.reviewed_at);
  const handledHint = detail.state === 'handled' && reviewed?.reviewed_at
    ? `Marked handled by ${reviewed.reviewed_by?.name ?? 'someone'}, ${formatFullTime(reviewed.reviewed_at)}`
    : undefined;
  const multiDay = new Set(detail.messages.map((message) => dayLabel(message.received_at))).size > 1;
  let lastDay = '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="border-b border-white/[0.06] px-5 pb-3 pt-4">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 break-words text-lg font-semibold leading-snug tracking-tight text-white">{detail.subject || '(no subject)'}</h2>
          {canTriage ? (
            <div className="flex flex-shrink-0 items-center gap-0.5 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
              <Tooltip content={canSendBack ? `Ask ${agentName} to triage the newest email again` : `Already waiting for ${agentName}`}>
                <button
                  type="button"
                  disabled={!canSendBack || busy !== null}
                  onClick={() => void after(() => client.sendBack(detail.id, null), `Sent back to ${agentName}`, 'send_back')}
                  aria-label={`Send back to ${agentName}`}
                  className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  {busy === 'send_back'
                    ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    : <RotateCcw size={14} aria-hidden="true" />}
                </button>
              </Tooltip>
              {/* Only offered when there is something to clear. */}
              {canHandle && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="!rounded-md !py-1 text-zinc-100"
                  icon={busy === 'handled' ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                  disabled={busy !== null}
                  onClick={() => void after(() => client.markHandled(detail.id), 'Marked handled', 'handled')}
                >
                  Mark handled
                </Button>
              )}
            </div>
          ) : (
            <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-zinc-300">
              <Eye size={11} aria-hidden="true" />
              View only
            </span>
          )}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
          <ThreadStateDot state={detail.state} hint={handledHint} />
          {detail.urgent && (
            <span className="inline-flex items-center gap-1 font-semibold text-red-300">
              <Flame size={12} aria-hidden="true" />
              Urgent
            </span>
          )}
          {detail.untrusted && <TrustBadge level="untrusted" compact />}
          <span className="text-zinc-600" aria-hidden="true">·</span>
          <ProjectChip
            project={detail.project}
            candidates={detail.candidates}
            agentName={agentName}
            color={projectColor}
            onEdit={canTriage ? () => setProjectDialog(true) : undefined}
          />
          <span className="text-zinc-600" aria-hidden="true">·</span>
          <span>{detail.messages.length} {detail.messages.length === 1 ? 'email' : 'emails'}</span>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
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

      <FilePreviewModal
        isOpen={!!preview}
        onClose={() => setPreview(null)}
        file={previewFile}
      />

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

function MessageCard({ message, agentName, focused, busy, viewUrl, onSendToAgent, onDownload, onPreview }: {
  message: InboxMessage;
  agentName: string;
  focused: boolean;
  busy: boolean;
  /** Where a stored attachment opens in the browser; null in demo mode. */
  viewUrl: ((attachmentId: string) => string) | null;
  /** Absent for members who can only view the inbox. */
  onSendToAgent?: () => void;
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
  const noteMode = message.triage ? agentNoteMode(message.triage, message.linked_tasks, message.new_text) : null;
  // Images the HTML already shows in place are not listed again under it.
  const referenced = useMemo(() => inlineImageIds(message.html_body), [message.html_body]);
  const listed = showingHtml
    ? message.attachments.filter((attachment) => !(attachment.content_id && referenced.has(attachment.content_id) && inlineImages[attachment.content_id]))
    : message.attachments;
  // A teammate's forward shows the original sender; the teammate gets their own line.
  const shownFrom = message.original_sender ?? message.from;
  const sender = shownFrom?.name || shownFrom?.address || 'Unknown sender';
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
      <header className="flex flex-wrap items-start gap-3 px-4 pt-3.5">
        <Avatar name={sender} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-white">{sender}</span>
            {shownFrom?.name && <span className="truncate text-xs text-zinc-400">{shownFrom.address}</span>}
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
          {recipients && <p className="mt-0.5 break-words text-[11px] text-zinc-400">{recipients}</p>}
          <TrustNote level={message.trust.level} reason={message.trust.reason} />
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1">
          <time dateTime={message.received_at} className="text-xs tabular-nums text-zinc-400">{formatFullTime(message.received_at)}</time>
          {message.triage && noteMode === 'quiet' && <QuietNote triage={message.triage} agentName={agentName} />}
        </div>
      </header>

      {message.status === 'ignored' && (
        <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">
          <span>Ignored as automatic mail{message.auto_mail_reason ? `: ${message.auto_mail_reason}` : ''}.</span>
          {onSendToAgent && (
            <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={onSendToAgent} icon={<RotateCcw size={12} aria-hidden="true" />}>
              Send to {agentName}
            </Button>
          )}
        </div>
      )}

      <div className="px-4 py-3">
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

      {message.triage && noteMode !== 'quiet' && (
        <AgentNote triage={message.triage} agentName={agentName} linkedTasks={message.linked_tasks} collapsed={noteMode === 'summary'} handled={!!message.reviewed_at} />
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

/** Emails longer than this get a collapsed summary even when the agent did nothing. */
const LONG_EMAIL_CHARS = 600;

/**
 * How much of the agent's triage an email shows: an action receipt when it
 * did something or needs you ("actions"), a collapsed summary for a long
 * email it only read ("summary"), and a quiet mark by the time for a short
 * one ("quiet"), whose summary would repeat the email.
 */
function agentNoteMode(triage: InboxTriage, linkedTasks: InboxMessage['linked_tasks'], text: string | null): 'actions' | 'summary' | 'quiet' {
  if (triage.outcome !== 'no_action' || triage.urgent || triage.question_for_human || linkedTasks.length > 0) return 'actions';
  return (text ?? '').trim().length > LONG_EMAIL_CHARS ? 'summary' : 'quiet';
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

/** "No action" by the timestamp; it opens the summary. */
function QuietNote({ triage, agentName }: { triage: InboxTriage; agentName: string }) {
  const { name: who, avatar } = useTriager(triage, agentName);
  return (
    <NotePill
      align="end"
      className="!bg-transparent !px-1 !text-zinc-400 hover:!text-zinc-200"
      icon={<Avatar name={who} src={avatar} size="xs" className="!h-4 !w-4 !text-[8px]" />}
      label={<><span className="sr-only">{who}: </span>No action</>}
    >
      <NoteCardHeader name={who} avatar={avatar} at={triage.created_at} />
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{triage.summary}</p>
    </NotePill>
  );
}

/** One linked task as a receipt item: what happened to it, then the task. */
function TaskReceipt({ task }: { task: InboxMessage['linked_tasks'][number] }) {
  const verb = task.relation === 'created' ? 'Created' : 'Updated';
  const title = task.title ?? 'Task';
  return (
    <li className="flex min-w-0 items-center gap-1.5 text-xs">
      <SquareCheck size={12} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
      <span className="flex-shrink-0 text-zinc-400">{verb}</span>
      {task.project_id && task.title === null ? (
        // In a project this member cannot open: no title, no link.
        <span className="text-zinc-300">a task in another project</span>
      ) : task.project_id ? (
        <Link
          href={`/projects/${task.project_id}?task=${task.task_id}`}
          className="min-w-0 truncate rounded font-medium text-zinc-100 underline decoration-white/20 underline-offset-2 hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {title}
        </Link>
      ) : (
        <span className="truncate text-zinc-300">{title}</span>
      )}
      {task.status && <StatusBadge status={task.status} tooltip={false} />}
    </li>
  );
}

/**
 * What the agent did with an email, under it: a receipt of the tasks it
 * touched, a question waiting on you, a suggested reply to open. Its
 * summary stays one click away instead of repeating the email.
 */
function AgentNote({ triage, agentName, linkedTasks, collapsed, handled }: {
  triage: InboxTriage;
  agentName: string;
  linkedTasks: InboxMessage['linked_tasks'];
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
        {linkedTasks.length === 0 && (
          <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${outcome.className}`}>
            <OutcomeIcon size={11} aria-hidden="true" />
            {collapsed ? 'No action' : outcome.label}
          </span>
        )}
        <NotePill label="Summary" icon={<AlignLeft size={11} aria-hidden="true" />}>
          <NoteCardHeader name={who} avatar={avatar} at={triage.created_at} />
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{triage.summary}</p>
        </NotePill>
        {triage.suggested_reply && (
          <NotePill label="Suggested reply" icon={<MessageSquareReply size={11} aria-hidden="true" />} width={440}>
            <NoteCardHeader name={who} avatar={avatar} at={triage.created_at} />
            <blockquote className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border-l-2 border-brand-400/40 bg-white/[0.03] px-3 py-2 text-sm leading-relaxed text-zinc-200">
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

      {linkedTasks.length > 0 && (
        <ul className="mt-2 space-y-1">
          {linkedTasks.map((task) => <TaskReceipt key={`${task.task_id}-${task.relation}`} task={task} />)}
        </ul>
      )}

      {triage.question_for_human && (
        <div className={`mt-2 rounded-md border px-3 py-2 ${handled ? 'border-white/[0.07] bg-white/[0.02]' : 'border-amber-400/25 bg-amber-500/[0.08]'}`}>
          <p className={`text-[11px] font-semibold uppercase tracking-wider ${handled ? 'text-zinc-400' : 'text-amber-300'}`}>
            {handled ? 'Question (handled)' : 'Question for you'}
          </p>
          <p className={`mt-1 whitespace-pre-wrap text-sm ${handled ? 'text-zinc-300' : 'text-zinc-100'}`}>{triage.question_for_human}</p>
        </div>
      )}

    </section>
  );
}
