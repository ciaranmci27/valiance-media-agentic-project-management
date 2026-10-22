'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  History, Loader2, Eye, CheckCircle2, Clock, XCircle, X as XIcon,
} from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { useApp } from '@/lib/store';
import { demoClientCommunications } from '@/lib/demo-data';
import ClientEmailPreviewModal from './ClientEmailPreviewModal';
import type {
  ClientCommunication,
  ClientCommType,
} from '@/lib/types';

interface CommunicationHistoryProps {
  projectId: string;
  /** Increment to force a refetch (after a send from the tab's Send buttons). */
  refreshSignal?: number;
  /** The tab toolbar's search: subject, type or recipient. */
  query?: string;
}

export const COMM_TYPE_LABELS: Record<ClientCommType, string> = {
  portal_welcome: 'Portal welcome',
  project_summary: 'Project summary',
  invoice: 'Invoice',
  budget_threshold: 'Budget threshold',
  dollar_interval: 'Dollar interval',
  budget_extended: 'Budget updated',
};

// Columns for the header and each row, used once the list's own box is wide.
const COLS = '@2xl:grid-cols-[88px_minmax(0,1.6fr)_minmax(0,1fr)_96px_92px]';

/**
 * Every email sent to the client from this project, newest first, with alerts
 * waiting for approval pinned on top: the Communication tab's Sent view.
 */
export function CommunicationHistory({ projectId, refreshSignal = 0, query = '' }: CommunicationHistoryProps) {
  const { isDemoMode } = useDemo();
  const { commsRefreshSignal } = useApp();

  const [comms, setComms] = useState<ClientCommunication[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingModal, setPendingModal] = useState<ClientCommunication | null>(null);
  const [readonlyModal, setReadonlyModal] = useState<ClientCommunication | null>(null);

  const loadComms = useCallback(async () => {
    if (isDemoMode) {
      setComms(
        demoClientCommunications
          .filter(c => c.project_id === projectId)
          .sort((a, b) => {
            const aT = a.sent_at ?? a.dismissed_at ?? a.created_at;
            const bT = b.sent_at ?? b.dismissed_at ?? b.created_at;
            return new Date(bT).getTime() - new Date(aT).getTime();
          }),
      );
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-communications`);
      if (res.ok) {
        const data = await res.json();
        setComms(data.communications || []);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, isDemoMode]);

  useEffect(() => { loadComms(); }, [loadComms, refreshSignal, commsRefreshSignal]);

  const needle = query.trim().toLowerCase();
  const matching = needle
    ? comms.filter(c =>
        (c.subject || '').toLowerCase().includes(needle) ||
        COMM_TYPE_LABELS[c.notification_type].toLowerCase().includes(needle) ||
        [...(c.recipients?.to ?? []), c.contact?.email ?? ''].some(r => r.toLowerCase().includes(needle)))
    : comms;
  const pending = matching.filter(c => c.status === 'pending');
  const rest = matching.filter(c => c.status !== 'pending');

  return (
    <>
      {loading && comms.length === 0 ? (
        <div className="glass-card rounded-xl flex items-center justify-center py-16 text-sm text-zinc-500">
          <Loader2 size={16} className="animate-spin mr-2" aria-hidden="true" />
          Loading sent emails
        </div>
      ) : comms.length === 0 ? (
        <div className="glass-card rounded-xl flex flex-col items-center justify-center px-6 py-16 text-center">
          <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
            <History size={18} className="text-zinc-500" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium text-zinc-300">No emails sent yet</p>
          <p className="text-xs text-zinc-500 mt-1">Invoices, summaries and alerts you send this client will list here.</p>
        </div>
      ) : (
        <section className="@container glass-card rounded-xl overflow-hidden" aria-label="Sent emails">
          {pending.length > 0 && (
            <div className="flex items-center gap-2 px-5 py-3 bg-amber-500/[0.08] border-b border-amber-500/20 text-sm text-amber-300">
              <Clock size={15} aria-hidden="true" />
              {pending.length === 1 ? '1 alert is' : `${pending.length} alerts are`} waiting for your approval
            </div>
          )}
          <div className={`hidden @2xl:grid ${COLS} gap-3 px-5 py-2.5 border-b border-white/[0.06] text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}>
            <span>Status</span>
            <span>Email</span>
            <span>Sent to</span>
            <span>When</span>
            <span className="sr-only">Actions</span>
          </div>
          {matching.length === 0 && <p className="px-5 py-10 text-center text-sm text-zinc-500">No emails match.</p>}
          <ul className="divide-y divide-white/[0.05]">
            {[...pending, ...rest].map(c => (
              <CommRow key={c.id} comm={c} onReview={setPendingModal} onPreview={setReadonlyModal} />
            ))}
          </ul>
        </section>
      )}

      {pendingModal && (
        <ClientEmailPreviewModal
          open={!!pendingModal}
          onClose={() => setPendingModal(null)}
          projectId={projectId}
          pending={pendingModal}
          onCompleted={loadComms}
        />
      )}

      {readonlyModal && (
        <ClientEmailPreviewModal
          open={!!readonlyModal}
          onClose={() => setReadonlyModal(null)}
          projectId={projectId}
          readonlyComm={readonlyModal}
        />
      )}
    </>
  );
}

const STATUS = {
  sent: { label: 'Sent', icon: CheckCircle2, color: 'text-emerald-400' },
  pending: { label: 'Waiting', icon: Clock, color: 'text-amber-400' },
  failed: { label: 'Failed', icon: XCircle, color: 'text-red-400' },
  dismissed: { label: 'Dismissed', icon: XIcon, color: 'text-zinc-500' },
} as const;

function CommRow({
  comm,
  onReview,
  onPreview,
}: {
  comm: ClientCommunication;
  onReview: (c: ClientCommunication) => void;
  onPreview: (c: ClientCommunication) => void;
}) {
  const status = STATUS[comm.status as keyof typeof STATUS] ?? STATUS.dismissed;
  const StatusIcon = status.icon;
  const timestamp = comm.sent_at ?? comm.dismissed_at ?? comm.created_at;
  const relTime = formatRelative(timestamp);
  const fullTime = new Date(timestamp).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  // Show who the email actually went to. The linked contact is only the
  // fallback for rows written before recipients were stored.
  const toList = comm.recipients?.to ?? [];
  const recipientLabel = toList.length ? toList.join(', ') : comm.contact?.email || 'unknown recipient';
  const subject = comm.subject || COMM_TYPE_LABELS[comm.notification_type];

  const action = comm.status === 'pending' ? (
    <button
      type="button"
      onClick={() => onReview(comm)}
      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <Eye size={13} aria-hidden="true" />
      Review
    </button>
  ) : comm.rendered_html ? (
    <button
      type="button"
      onClick={() => onPreview(comm)}
      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <Eye size={13} aria-hidden="true" />
      Preview
    </button>
  ) : null;

  const statusLabel = (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${status.color}`}>
      <StatusIcon size={14} aria-hidden="true" />
      {status.label}
    </span>
  );

  return (
    <li className="hover:bg-white/[0.02] transition-colors">
      <div className={`hidden @2xl:grid ${COLS} gap-3 items-center px-5 py-3`}>
        {statusLabel}
        <div className="min-w-0">
          <p className="text-sm text-zinc-100 truncate" title={subject}>{subject}</p>
          <p className="text-xs text-zinc-500">{COMM_TYPE_LABELS[comm.notification_type]}</p>
        </div>
        <span className="text-sm text-zinc-400 truncate" title={recipientLabel}>{recipientLabel}</span>
        <span className="text-sm text-zinc-400 whitespace-nowrap" title={fullTime}>{relTime}</span>
        <div className="flex justify-end">{action}</div>
      </div>
      <div className="@2xl:hidden px-4 py-3 space-y-1.5">
        <div className="flex items-center gap-2">
          {statusLabel}
          <span className="ml-auto text-xs text-zinc-500 whitespace-nowrap" title={fullTime}>{relTime}</span>
        </div>
        <p className="text-sm text-zinc-100 break-words">{subject}</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 truncate min-w-0" title={recipientLabel}>{recipientLabel}</span>
          <span className="ml-auto flex-shrink-0">{action}</span>
        </div>
      </div>
    </li>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
