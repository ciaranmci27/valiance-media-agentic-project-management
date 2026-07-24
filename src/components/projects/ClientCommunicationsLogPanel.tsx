'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  History, Loader2, Eye, CheckCircle2, Clock, XCircle, X as XIcon,
} from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { useApp } from '@/lib/store';
import { demoClientCommunications } from '@/lib/demo-data';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import ClientEmailPreviewModal from './ClientEmailPreviewModal';
import type {
  ClientCommunication,
  ClientCommType,
  ClientCommStatus,
} from '@/lib/types';

interface ClientCommunicationsLogPanelProps {
  projectId: string;
  /** Increment to force a refetch (after a send/approve from the actions panel). */
  refreshSignal?: number;
  /** Fires when the log refetches after a pending review action. */
  onChanged?: () => void;
}

const TYPE_LABELS: Record<ClientCommType, string> = {
  portal_welcome: 'Portal Welcome',
  project_summary: 'Project Summary',
  invoice: 'Invoice',
  budget_threshold: 'Budget Threshold',
  dollar_interval: 'Dollar Interval',
  budget_extended: 'Budget Updated',
};

const STATUS_FILTERS: { value: 'all' | ClientCommStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'sent', label: 'Sent' },
  { value: 'dismissed', label: 'Dismissed' },
];

export function ClientCommunicationsLogPanel({
  projectId,
  refreshSignal = 0,
  onChanged,
}: ClientCommunicationsLogPanelProps) {
  const { isDemoMode } = useDemo();
  const { commsRefreshSignal } = useApp();

  const [comms, setComms] = useState<ClientCommunication[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | ClientCommStatus>('all');
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

  const filteredComms = useMemo(() => {
    if (statusFilter === 'all') return comms;
    return comms.filter(c => c.status === statusFilter);
  }, [comms, statusFilter]);

  const handleReviewCompleted = () => {
    loadComms();
    onChanged?.();
  };

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col">
      <div className="px-5 py-4 border-b border-zinc-100 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <History size={18} className="text-zinc-500 flex-shrink-0" />
          <h2 className="font-semibold text-zinc-900 truncate">Communication History</h2>
        </div>
        {comms.length > 0 && (
          <div className="hidden sm:block ml-auto w-36">
            <Select
              size="sm"
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as 'all' | ClientCommStatus)}
              options={STATUS_FILTERS.map(f => {
                const count = f.value === 'all'
                  ? comms.length
                  : comms.filter(c => c.status === f.value).length;
                return { value: f.value, label: `${f.label} (${count})` };
              })}
            />
          </div>
        )}
      </div>

      <div className="p-5 flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col min-h-0">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
              <Loader2 size={14} className="animate-spin mr-2" />
              Loading...
            </div>
          ) : filteredComms.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                <History size={18} className="text-zinc-400" />
              </div>
              <p className="text-sm font-medium text-zinc-500">
                {statusFilter === 'all' ? 'No emails sent yet' : `No ${statusFilter} emails`}
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                {statusFilter === 'all'
                  ? 'Every client email you send will appear here'
                  : 'Try switching to another filter above'}
              </p>
            </div>
          ) : (
            <ul className="space-y-2 pr-1.5 sm:pr-0 sm:space-y-0 sm:divide-y sm:divide-zinc-100 sm:border sm:border-zinc-200 sm:rounded-lg overflow-y-auto max-h-[400px]">
              {filteredComms.map(c => (
                <CommRow
                  key={c.id}
                  comm={c}
                  onReview={setPendingModal}
                  onPreview={setReadonlyModal}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {pendingModal && (
        <ClientEmailPreviewModal
          open={!!pendingModal}
          onClose={() => setPendingModal(null)}
          projectId={projectId}
          pending={pendingModal}
          onCompleted={handleReviewCompleted}
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
    </div>
  );
}

function CommRow({
  comm,
  onReview,
  onPreview,
}: {
  comm: ClientCommunication;
  onReview: (c: ClientCommunication) => void;
  onPreview: (c: ClientCommunication) => void;
}) {
  const statusIcon =
    comm.status === 'sent' ? <CheckCircle2 size={12} className="text-emerald-600" /> :
    comm.status === 'pending' ? <Clock size={12} className="text-amber-600" /> :
    comm.status === 'failed' ? <XCircle size={12} className="text-red-600" /> :
    <XIcon size={12} className="text-zinc-400" />;

  const statusBadge =
    comm.status === 'sent' ? <Badge variant="success">Sent</Badge> :
    comm.status === 'pending' ? <Badge variant="warning">Pending</Badge> :
    comm.status === 'failed' ? <Badge variant="danger">Failed</Badge> :
    <Badge variant="default">Dismissed</Badge>;

  const timestamp = comm.sent_at ?? comm.dismissed_at ?? comm.created_at;
  const relTime = formatRelative(timestamp);

  return (
    <li className="rounded-lg border border-zinc-200 sm:rounded-none sm:border-0 p-3 sm:px-3 sm:py-2.5 bg-white flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 hover:bg-zinc-50 transition-colors">
      <div className="flex items-start gap-3 sm:items-center min-w-0 flex-1">
        <div className="flex-shrink-0 mt-0.5 sm:mt-0">{statusIcon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
            <span className="text-sm font-medium text-zinc-800 truncate">
              {comm.subject || TYPE_LABELS[comm.notification_type]}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="info" className="text-[10px]">
                {TYPE_LABELS[comm.notification_type]}
              </Badge>
              {statusBadge}
            </div>
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-2 min-w-0">
            <span className="truncate">{comm.contact?.email || 'unknown recipient'}</span>
            <span className="text-zinc-300 flex-shrink-0">·</span>
            <span className="flex-shrink-0 whitespace-nowrap">{relTime}</span>
          </div>
        </div>
      </div>
      {comm.status === 'pending' ? (
        <button
          type="button"
          onClick={() => onReview(comm)}
          className="flex-shrink-0 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors w-full sm:w-auto sm:py-1"
        >
          <Eye size={12} />
          Review
        </button>
      ) : comm.rendered_html ? (
        <button
          type="button"
          onClick={() => onPreview(comm)}
          className="flex-shrink-0 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900 transition-colors w-full sm:w-auto sm:py-1"
        >
          <Eye size={12} />
          Preview
        </button>
      ) : null}
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
