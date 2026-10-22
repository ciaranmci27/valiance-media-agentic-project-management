'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  History, Eye, CheckCircle2, Clock, XCircle, X as XIcon,
} from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { useApp } from '@/lib/store';
import { demoClientCommunications } from '@/lib/demo-data';
import { Button } from '@/components/ui/Button';
import { Bone, EmptyCard, NoMatches, Skeleton } from './TabLayout';
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
  // Until the first answer the list shows its skeleton, never "No emails sent yet".
  const [loaded, setLoaded] = useState(false);
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
      setLoaded(true);
      return;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/client-communications`);
      if (res.ok) {
        const data = await res.json();
        setComms(data.communications || []);
      }
    } finally {
      setLoaded(true);
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
      {!loaded ? (
        <SentSkeleton />
      ) : comms.length === 0 ? (
        <EmptyCard
          icon={<History />}
          title="No emails sent yet"
          description="Invoices, summaries and alerts you send this client will list here."
        />
      ) : (
        <section className="@container glass-card rounded-xl overflow-hidden" aria-label="Sent emails">
          {pending.length > 0 && (
            <div className="flex items-center gap-2 px-5 py-3 bg-amber-500/[0.08] border-b border-amber-500/20 text-sm text-amber-300">
              <Clock size={15} aria-hidden="true" />
              {pending.length === 1 ? '1 alert is' : `${pending.length} alerts are`} waiting for your approval
            </div>
          )}
          <div className={`hidden @2xl:grid ${COLS} gap-3 px-5 py-2.5 border-b border-white/[0.06] text-[11px] font-semibold uppercase tracking-wider text-zinc-400`}>
            <span>Status</span>
            <span>Email</span>
            <span>Sent to</span>
            <span>When</span>
            <span className="sr-only">Actions</span>
          </div>
          {matching.length === 0 && <NoMatches>No emails match.</NoMatches>}
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

/** The Sent table's shape while the first page loads. */
function SentSkeleton() {
  return (
    <Skeleton label="Loading sent emails" className="@container glass-card rounded-xl overflow-hidden">
      <div className={`hidden @2xl:grid ${COLS} gap-3 px-5 py-3 border-b border-white/[0.06]`}>
        {['w-12', 'w-12', 'w-14', 'w-10'].map((w, i) => <Bone key={i} className={`h-2.5 ${w}`} />)}
      </div>
      <ul className="divide-y divide-white/[0.05]">
        {[0, 1, 2, 3, 4].map(i => (
          <li key={i}>
            <div className={`hidden @2xl:grid ${COLS} gap-3 items-center px-5 py-3.5`}>
              <Bone className="h-3 w-14" />
              <div className="space-y-1.5">
                <Bone className={`h-3.5 ${i % 2 ? 'w-3/4' : 'w-2/3'}`} />
                <Bone className="h-2.5 w-20" />
              </div>
              <Bone className="h-3 w-4/5" />
              <Bone className="h-3 w-12" />
            </div>
            <div className="@2xl:hidden px-4 py-3 space-y-2">
              <div className="flex justify-between"><Bone className="h-3 w-14" /><Bone className="h-3 w-10" /></div>
              <Bone className={`h-3.5 ${i % 2 ? 'w-3/4' : 'w-2/3'}`} />
              <Bone className="h-3 w-1/2" />
            </div>
          </li>
        ))}
      </ul>
    </Skeleton>
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
    <Button size="sm" onClick={() => onReview(comm)} icon={<Eye size={13} aria-hidden="true" />}>
      Review
    </Button>
  ) : comm.rendered_html ? (
    <Button variant="ghost" size="sm" onClick={() => onPreview(comm)} icon={<Eye size={13} aria-hidden="true" />}>
      Preview
    </Button>
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
