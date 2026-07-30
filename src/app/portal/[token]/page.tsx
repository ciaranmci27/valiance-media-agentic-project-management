'use client';

import { useState, useEffect, useRef, useCallback, Fragment, Suspense } from 'react';
import { useParams, useRouter, useSearchParams, usePathname } from 'next/navigation';
import { InvoicePreviewModalView } from '@/components/invoice-pdf/InvoicePreviewModalView';
import {
  Lock, Loader2, FileText, Image, Archive, File, Download, Globe,
  CheckCircle2, Clock, AlertCircle, FolderOpen, Timer, Upload,
  Flag, Package, MessageCircle, Pin, ChevronDown, KeyRound, Eye, EyeOff, Plus, Pencil, ShieldCheck,
  Receipt, FileDown, CircleDollarSign, Code, Terminal, Database, CreditCard, Landmark,
} from 'lucide-react';
import type { PortalData, PortalSectionKey, CredentialCategory } from '@/lib/types';
import { DEFAULT_SECTION_ORDER } from '@/lib/types';
import { CREDENTIAL_FIELDS, type CredentialFieldDef } from '@/lib/credential-fields';
import { Logo } from '@/components/ui/Logo';
import { Select } from '@/components/ui/Select';
import { PinInput, type PinInputRef } from '@/components/ui/PinInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { FilePreviewModal } from '@/components/ui/FilePreviewModal';
import { siteConfig } from '@/site-config';

/* ── Helpers ─────────────────────────────────────── */

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(value);
}

function getFileIcon(mimeType: string) {
  if (mimeType === 'text/html') return Globe;
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType === 'application/pdf') return FileText;
  if (mimeType.includes('zip') || mimeType.includes('archive')) return Archive;
  return File;
}

function getFileIconColor(mimeType: string): string {
  if (mimeType === 'application/pdf') return '#EF4444';
  if (mimeType.startsWith('image/')) return '#8B5CF6';
  if (mimeType.includes('zip') || mimeType.includes('archive')) return '#F59E0B';
  if (mimeType === 'text/html') return '#3B82F6';
  return '#71717A';
}

function getFileIconBg(mimeType: string): string {
  if (mimeType === 'application/pdf') return '#FEF2F2';
  if (mimeType.startsWith('image/')) return '#F5F3FF';
  if (mimeType.includes('zip') || mimeType.includes('archive')) return '#FFFBEB';
  if (mimeType === 'text/html') return '#EFF6FF';
  return '#F4F4F5';
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (weeks < 5) return `${weeks}w ago`;
  if (months < 12) return `${months}mo ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatBreakDuration(seconds: number): string {
  if (seconds < 60) return '< 1m';
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Format a fractional-hours value (e.g. 1.458) as "1h 27m". More precise than
// the old "1.5h" display because the client can reconcile the label against
// the visible start/end range.
function formatHoursMinutes(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes === 0) return '0m';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function getUpdateIcon(type: string) {
  switch (type) {
    case 'milestone': return Flag;
    case 'deliverable': return Package;
    case 'note': return MessageCircle;
    default: return Clock;
  }
}


/* ── Member bar colors ───────────────────────────── */
const MEMBER_COLORS = ['#5B8A8A', '#C5A68F', '#6366F1', '#F59E0B', '#EC4899', '#14B8A6'];

/* ── Hours Section ──────────────────────────────── */
const HOURS_INITIAL = 5;

function HoursSection({ entries, totalHours, memberHours, accentColor }: {
  entries: PortalData['hours']['entries'];
  totalHours: number;
  memberHours: { name: string; hours: number; color: string }[];
  accentColor: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? entries : entries.slice(0, HOURS_INITIAL);
  const hiddenCount = entries.length - HOURS_INITIAL;

  return (
    <section>
      <SectionHeader
        icon={Timer}
        title="Hours Logged"
        accentColor={accentColor}
        right={
          <span className="text-lg font-semibold text-zinc-800 tabular-nums tracking-tight">
            {formatHoursMinutes(totalHours)}
          </span>
        }
      />
      {memberHours.length > 1 && (
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 p-4 sm:p-5 mb-4">
          <div className="flex h-2.5 rounded-full overflow-hidden bg-zinc-100">
            {memberHours.map((m) => (
              <div
                key={m.name}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${(m.hours / totalHours) * 100}%`,
                  backgroundColor: m.color,
                }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-3 mt-2.5">
            {memberHours.map((m) => (
              <div key={m.name} className="flex items-center gap-1.5 text-xs text-zinc-500">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }} />
                <span>{m.name}</span>
                <span className="text-zinc-400">{formatHoursMinutes(m.hours)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-3">
        {visible.map(entry => {
          const hasMultipleSegments = entry.segments && entry.segments.length > 1;
          return (
            <div
              key={entry.id}
              className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 px-4 sm:px-5 py-3.5 hover:shadow-[0_1px_3px_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.06)] transition-shadow duration-300"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-800 truncate">
                    {entry.description || 'Work logged'}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1 text-xs text-zinc-400 flex-wrap">
                    {memberHours.length > 1 && (
                      <>
                        <span>{entry.member_name}</span>
                        <span className="text-zinc-200">/</span>
                      </>
                    )}
                    <span>{new Date(entry.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    <span className="text-zinc-200">/</span>
                    <span>{new Date(entry.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} – {new Date(entry.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                    {/* Single-segment entries never pause, so the summary only appears
                        on rows that don't get the expanded session breakdown below. */}
                    {!hasMultipleSegments && entry.paused_seconds > 0 && (
                      <>
                        <span className="text-zinc-200">/</span>
                        <span className="italic">paused {formatBreakDuration(entry.paused_seconds)}</span>
                      </>
                    )}
                    {(() => {
                      if (!entry.payment_status) return null;
                      const cfg = entry.payment_status === 'paid'
                        ? { color: 'text-emerald-500', tip: 'Paid' }
                        : entry.payment_status === 'partial'
                        ? { color: 'text-amber-500', tip: 'Partially paid' }
                        : { color: 'text-zinc-300', tip: 'Unpaid' };
                      return (
                        <Tooltip content={cfg.tip}>
                          <CircleDollarSign size={12} className={`flex-shrink-0 ${cfg.color}`} />
                        </Tooltip>
                      );
                    })()}
                  </div>
                </div>
                <span className="text-sm font-bold text-zinc-900 tabular-nums flex-shrink-0">
                  {formatHoursMinutes(entry.hours)}
                </span>
              </div>
              {hasMultipleSegments && (
                <ul className="mt-2.5 rounded-xl bg-zinc-50/70 border border-zinc-100 px-3 py-2 space-y-1.5">
                  {entry.segments.map((seg, i) => {
                    const segStart = new Date(seg.start);
                    const segEnd = new Date(seg.end);
                    const segDurationSec = Math.round((segEnd.getTime() - segStart.getTime()) / 1000);
                    const nextSeg = entry.segments[i + 1];
                    const gapSec = nextSeg
                      ? Math.round((new Date(nextSeg.start).getTime() - segEnd.getTime()) / 1000)
                      : 0;
                    return (
                      <Fragment key={i}>
                        <li className="flex items-center gap-2">
                          <span
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: accentColor }}
                          />
                          <span className="text-[11px] font-medium text-zinc-600 tabular-nums">
                            {segStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                            {' – '}
                            {segEnd.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          </span>
                          <span className="text-[10px] text-zinc-400 tabular-nums">
                            {formatBreakDuration(segDurationSec)}
                          </span>
                        </li>
                        {gapSec > 0 && (
                          <li className="flex items-center gap-1.5 pl-[3px] select-none">
                            <span className="w-px h-2.5 bg-zinc-200 ml-[2px]" />
                            <span className="text-[10px] italic text-zinc-400">
                              Paused for {formatBreakDuration(gapSec)}
                            </span>
                          </li>
                        )}
                      </Fragment>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {entries.length > HOURS_INITIAL && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="mt-4 w-full flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-zinc-400 hover:text-zinc-600 bg-white/60 hover:bg-white/80 backdrop-blur-sm rounded-xl border border-white/60 transition-all duration-200"
        >
          <ChevronDown size={14} className={`transition-transform ${showAll ? 'rotate-180' : ''}`} />
          {showAll ? 'Show less' : `Show ${hiddenCount} more entr${hiddenCount === 1 ? 'y' : 'ies'}`}
        </button>
      )}
    </section>
  );
}

/* ── Section header component ────────────────────── */
function SectionHeader({ icon: Icon, title, accentColor, right }: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  title: string;
  accentColor: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: accentColor + '12' }}
        >
          <Icon size={16} style={{ color: accentColor }} />
        </div>
        <h2 className="text-[15px] font-semibold text-zinc-800 tracking-[-0.01em]">{title}</h2>
      </div>
      {right}
    </div>
  );
}

/* ── Progress Ring ───────────────────────────────── */
function ProgressRing({ percent, color }: { percent: number; color: string }) {
  const r = 34;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percent / 100) * circumference;

  return (
    <svg width="80" height="80" viewBox="0 0 80 80" className="flex-shrink-0">
      <circle cx="40" cy="40" r={r} fill="none" stroke="#F4F4F5" strokeWidth="6" />
      <circle
        cx="40" cy="40" r={r} fill="none"
        stroke={color} strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 40 40)"
        style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(0.16,1,0.3,1)' }}
      />
      <text x="40" y="40" textAnchor="middle" dominantBaseline="central" className="text-lg font-bold" fill="#18181B" fontSize="18" fontWeight="700">
        {percent}%
      </text>
    </svg>
  );
}

/* ── Expandable Update Content ────────────────────── */
const CONTENT_TRUNCATE_LENGTH = 180;

function UpdateContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = content.length > CONTENT_TRUNCATE_LENGTH;

  if (!needsTruncation || expanded) {
    return (
      <div>
        <p className="text-sm text-zinc-500 leading-relaxed mb-1.5">{content}</p>
        {needsTruncation && (
          <button
            onClick={() => setExpanded(false)}
            className="text-xs font-medium text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            Show less
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-zinc-500 leading-relaxed mb-1.5">
        {content.slice(0, CONTENT_TRUNCATE_LENGTH).trimEnd()}&hellip;
      </p>
      <button
        onClick={() => setExpanded(true)}
        className="text-xs font-medium text-zinc-400 hover:text-zinc-600 transition-colors"
      >
        Read more
      </button>
    </div>
  );
}

/* ── Updates Timeline Component ──────────────────── */
const UPDATES_INITIAL_COUNT = 5;

function UpdatesTimeline({ updates, accentColor, onPreview, onDownload }: {
  updates: PortalData['updates'];
  accentColor: string;
  onPreview: (file: { id?: string; name: string; file_url: string; mime_type: string }) => void;
  /** Fires when the client clicks the download button on an update
   *  attachment. The portal page uses this to emit a file_download event. */
  onDownload?: (file: { id: string; name: string }) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? updates : updates.slice(0, UPDATES_INITIAL_COUNT);
  const hiddenCount = updates.length - UPDATES_INITIAL_COUNT;

  return (
    <section>
      <SectionHeader
        icon={Clock}
        title="Updates"
        accentColor={accentColor}
        right={<span className="text-xs text-zinc-400">{updates.length}</span>}
      />
      <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 p-5 sm:p-6">
      <div className="relative">
        <div className="space-y-1">
          {visible.map((update, updateIndex) => {
            const isLast = updateIndex === visible.length - 1;
            const isMilestone = update.update_type === 'milestone';
            const iconColor =
              isMilestone ? '#10B981' :
              update.update_type === 'deliverable' ? '#3B82F6' :
              update.update_type === 'note' ? '#F59E0B' :
              '#A1A1AA';
            const iconBg =
              isMilestone ? '#ECFDF5' :
              update.update_type === 'deliverable' ? '#EFF6FF' :
              update.update_type === 'note' ? '#FFFBEB' :
              '#F4F4F5';
            const typeBadge =
              update.update_type === 'milestone' ? { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' } :
              update.update_type === 'deliverable' ? { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' } :
              update.update_type === 'note' ? { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' } :
              null;
            const UpdateIcon = getUpdateIcon(update.update_type);
            const fullDate = new Date(update.created_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

            return (
              <div
                key={update.id}
                className="relative flex gap-4 py-3"
              >
                {/* Connecting line (skip last item) */}
                {!isLast && (
                  <div className="absolute left-[13px] top-[27px] bottom-0 w-px bg-zinc-100" />
                )}
                {/* Icon */}
                <div className="relative z-10 flex-shrink-0 mt-0.5">
                  <div
                    className="w-[27px] h-[27px] rounded-full flex items-center justify-center ring-[3px] ring-white"
                    style={{ backgroundColor: iconBg }}
                  >
                    <UpdateIcon size={13} style={{ color: iconColor }} />
                  </div>
                </div>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    {update.pinned && (
                      <Pin size={11} className="text-amber-500 fill-amber-500 flex-shrink-0" />
                    )}
                    <h3 className={`text-sm font-semibold ${isMilestone ? 'text-emerald-900' : 'text-zinc-900'}`}>
                      {update.title}
                    </h3>
                    {typeBadge && (
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold border rounded-full ${typeBadge.bg} ${typeBadge.text} ${typeBadge.border}`}>
                        {update.update_type.charAt(0).toUpperCase() + update.update_type.slice(1)}
                      </span>
                    )}
                  </div>
                  {update.content && <UpdateContent content={update.content} />}
                  {/* Attachments */}
                  {update.attachments && update.attachments.length > 0 && (() => {
                    const images = update.attachments.filter(a => a.mime_type.startsWith('image/'));
                    const files = update.attachments.filter(a => !a.mime_type.startsWith('image/'));
                    return (
                      <div className="mt-2 space-y-2">
                        {images.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {images.map(a => (
                              <div key={a.id} className="group/img relative">
                                <img
                                  src={a.file_url}
                                  alt={a.name}
                                  className="max-w-[200px] max-h-[120px] rounded-lg border border-zinc-200 object-cover"
                                />
                                <div className="absolute inset-0 rounded-lg flex items-center justify-center gap-1.5 transition-colors sm:bg-black/0 sm:group-hover/img:bg-black/40 sm:opacity-0 sm:group-hover/img:opacity-100 sm:focus-within:opacity-100">
                                  <Tooltip content="Preview">
                                    <button
                                      onClick={() => onPreview({ id: a.id, name: a.name, file_url: a.file_url, mime_type: a.mime_type })}
                                      className="p-1.5 bg-white/90 rounded-md text-zinc-700 hover:bg-white transition-colors"
                                    >
                                      <Eye size={13} />
                                    </button>
                                  </Tooltip>
                                  <Tooltip content="Download">
                                    <button
                                      onClick={async () => {
                                        onDownload?.({ id: a.id, name: a.name });
                                        try {
                                          const res = await fetch(a.file_url);
                                          const blob = await res.blob();
                                          const url = URL.createObjectURL(blob);
                                          const el = document.createElement('a');
                                          el.href = url;
                                          el.download = a.name;
                                          document.body.appendChild(el);
                                          el.click();
                                          el.remove();
                                          URL.revokeObjectURL(url);
                                        } catch { /* silent */ }
                                      }}
                                      className="p-1.5 bg-white/90 rounded-md text-zinc-700 hover:bg-white transition-colors"
                                    >
                                      <Download size={13} />
                                    </button>
                                  </Tooltip>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {files.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {files.map(a => {
                              const isHtml = a.mime_type === 'text/html';
                              const FileIcon = isHtml ? Globe : a.mime_type === 'application/pdf' ? FileText : File;
                              return (
                                <span key={a.id} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-600 rounded-lg">
                                  <FileIcon size={12} className="text-zinc-400 flex-shrink-0" />
                                  <span className="max-w-[140px] truncate">{a.name}</span>
                                  <span className="text-zinc-400">{formatFileSize(a.file_size)}</span>
                                  <Tooltip content="Preview">
                                    <button
                                      onClick={() => onPreview({ id: a.id, name: a.name, file_url: a.file_url, mime_type: a.mime_type })}
                                      className="p-0.5 text-zinc-400 hover:text-zinc-700 transition-colors"
                                    >
                                      <Eye size={12} />
                                    </button>
                                  </Tooltip>
                                  {!isHtml && (
                                    <Tooltip content="Download">
                                      <button
                                        onClick={async () => {
                                          onDownload?.({ id: a.id, name: a.name });
                                          try {
                                            const res = await fetch(a.file_url);
                                            const blob = await res.blob();
                                            const url = URL.createObjectURL(blob);
                                            const el = document.createElement('a');
                                            el.href = url;
                                            el.download = a.name;
                                            document.body.appendChild(el);
                                            el.click();
                                            el.remove();
                                            URL.revokeObjectURL(url);
                                          } catch { /* silent */ }
                                        }}
                                        className="p-0.5 text-zinc-400 hover:text-zinc-700 transition-colors"
                                      >
                                        <Download size={12} />
                                      </button>
                                    </Tooltip>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <Tooltip content={fullDate}>
                    <p className="text-xs text-zinc-400">
                      {update.author_name} &middot; {relativeTime(update.created_at)}
                    </p>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Show more / Show less */}
      {updates.length > UPDATES_INITIAL_COUNT && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="mt-4 w-full flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-zinc-400 hover:text-zinc-600 bg-zinc-50/70 hover:bg-zinc-100/60 rounded-xl transition-all duration-200"
        >
          <ChevronDown size={14} className={`transition-transform ${showAll ? 'rotate-180' : ''}`} />
          {showAll ? 'Show less' : `Show ${hiddenCount} more update${hiddenCount === 1 ? '' : 's'}`}
        </button>
      )}
      </div>
    </section>
  );
}

/* ── Portal Credential Form ─────────────────────── */

// Each credential type collects its own fields (see lib/credential-fields.ts)
const CREDENTIAL_CATEGORIES: { value: string; label: string; icon: typeof KeyRound }[] = [
  { value: 'login', label: 'Login', icon: KeyRound },
  { value: 'api_key', label: 'API Key', icon: Code },
  { value: 'ssh_key', label: 'SSH Key', icon: Terminal },
  { value: 'database', label: 'Database', icon: Database },
  { value: 'credit_card', label: 'Credit Card', icon: CreditCard },
  { value: 'ach', label: 'ACH / Bank', icon: Landmark },
];

const CATEGORY_STYLE: Record<string, { bg: string; iconColor: string }> = {
  login:       { bg: '#F5F3FF', iconColor: '#8B5CF6' },
  api_key:     { bg: '#EFF6FF', iconColor: '#3B82F6' },
  ssh_key:     { bg: '#ECFDF5', iconColor: '#10B981' },
  database:    { bg: '#FFFBEB', iconColor: '#F59E0B' },
  credit_card: { bg: '#FEF2F2', iconColor: '#EF4444' },
  ach:         { bg: '#F0FDFA', iconColor: '#14B8A6' },
  // Fallback for rows created before the category consolidation
  other:       { bg: '#F4F4F5', iconColor: '#71717A' },
};

type SubmittedCredential = PortalData['credentials_submitted'][number];

/* Credential form — shown as its own view, not mixed with the list */
function CredentialFormView({ token, pin, accentColor, editingCredential, onDone, onCancel }: {
  token: string;
  pin?: string;
  accentColor: string;
  editingCredential: SubmittedCredential | null;
  onDone: (cred: SubmittedCredential, mode: 'add' | 'edit') => void;
  onCancel: () => void;
}) {
  const isEditing = editingCredential !== null;
  const [label, setLabel] = useState(editingCredential?.label ?? '');
  const [category, setCategory] = useState<string>(editingCredential?.category ?? 'login');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [loadingFields, setLoadingFields] = useState(isEditing);
  // Whether the edit prefill actually loaded; if it failed we must not send
  // blank values for fields the client never saw
  const [prefillLoaded, setPrefillLoaded] = useState(!isEditing);

  const fieldDefs: CredentialFieldDef[] =
    CREDENTIAL_FIELDS[category as CredentialCategory] ?? CREDENTIAL_FIELDS.login;

  const setField = (key: string, value: string) =>
    setFields(prev => ({ ...prev, [key]: value }));

  const toggleSecret = (key: string) =>
    setVisibleSecrets(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const pinHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {};
    if (pin) h['x-portal-pin'] = pin;
    return h;
  };

  // Fetch existing field values when editing (sensitive fields are never
  // returned; leaving them blank keeps the stored values)
  useEffect(() => {
    if (!isEditing) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/${token}/credentials/${editingCredential.id}`, { headers: pinHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (cancelled) return;
        setFields(data.fields || {});
        setPrefillLoaded(true);
      } catch {
        // If fetch fails, fields stay empty; they can still re-enter values
      } finally {
        if (!cancelled) setLoadingFields(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Only submit values for the active category (plus notes). In edit mode,
  // blank sensitive fields are omitted so the stored secrets are preserved,
  // and if the prefill failed, blank fields are omitted entirely so values
  // the client never saw are not wiped.
  const collectFields = (): Record<string, string> => {
    const collected: Record<string, string> = {};
    for (const def of fieldDefs) {
      const value = (fields[def.key] ?? '').trim();
      if (isEditing && !value && (def.sensitive || !prefillLoaded)) continue;
      collected[def.key] = value;
    }
    const notes = (fields.notes ?? '').trim();
    if (!isEditing || notes || prefillLoaded) collected.notes = notes;
    return collected;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setSubmitting(true);

    try {
      if (isEditing) {
        // Rows still on a pre-migration category keep it unless the client
        // picks one of the current types
        const categoryIsCurrent = CREDENTIAL_CATEGORIES.some(c => c.value === category);
        const res = await fetch(`/api/portal/${token}/credentials/${editingCredential.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...pinHeaders() },
          body: JSON.stringify({
            label: label.trim(),
            ...(categoryIsCurrent ? { category } : {}),
            fields: collectFields(),
          }),
        });
        if (!res.ok) throw new Error();
        const json = await res.json();
        onDone({ ...editingCredential, ...json.data }, 'edit');
      } else {
        const res = await fetch(`/api/portal/${token}/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...pinHeaders() },
          body: JSON.stringify({
            label: label.trim(),
            category,
            fields: collectFields(),
            submitted_by_name: '',
          }),
        });
        if (!res.ok) throw new Error();
        const json = await res.json();
        onDone({
          id: json.data.id,
          label: json.data.label ?? label.trim(),
          category: (json.data.category ?? category) as SubmittedCredential['category'],
          created_at: json.data.created_at ?? new Date().toISOString(),
          updated_at: json.data.updated_at ?? new Date().toISOString(),
        }, 'add');
      }
    } catch {
      // silent fail on portal
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'px-3 py-2.5 text-sm bg-zinc-50 border border-zinc-200 rounded-lg outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 transition-all placeholder:text-zinc-400';

  const renderField = (def: CredentialFieldDef) => {
    const value = fields[def.key] ?? '';
    if (def.options) {
      return (
        <Select
          value={value}
          onChange={v => setField(def.key, v)}
          options={def.options.map(o => ({ value: o, label: o }))}
          placeholder={def.placeholder}
        />
      );
    }
    if (def.multiline) {
      return (
        <textarea
          value={value}
          onChange={e => setField(def.key, e.target.value)}
          placeholder={def.placeholder}
          rows={4}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          className={`w-full resize-none font-mono text-xs ${inputClass}`}
        />
      );
    }
    if (def.sensitive) {
      const visible = visibleSecrets.has(def.key);
      return (
        <div className="relative">
          <input
            type="text"
            value={value}
            onChange={e => setField(def.key, e.target.value)}
            placeholder={isEditing ? `${def.label} (leave blank to keep current)` : def.placeholder}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            style={visible ? undefined : { WebkitTextSecurity: 'disc' } as React.CSSProperties}
            className={`w-full pr-10 ${inputClass}`}
          />
          <button
            type="button"
            onClick={() => toggleSecret(def.key)}
            aria-label={visible ? `Hide ${def.label}` : `Show ${def.label}`}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
          >
            {visible ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      );
    }
    return (
      <input
        type="text"
        value={value}
        onChange={e => setField(def.key, e.target.value)}
        placeholder={def.placeholder}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        className={`w-full ${inputClass}`}
      />
    );
  };

  return (
    <div style={{ animation: 'portalFadeUp 0.2s ease both' }}>
      <div className="flex items-center gap-3 mb-4">
        <button
          type="button"
          onClick={onCancel}
          className="p-1.5 -ml-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <h3 className="text-sm font-semibold text-zinc-900">
          {isEditing ? 'Update Credential' : 'New Credential'}
        </h3>
      </div>

      {loadingFields ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={20} className="animate-spin text-zinc-300" />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Type selector; each type collects its own fields */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {CREDENTIAL_CATEGORIES.map(cat => {
              const TypeIcon = cat.icon;
              const selected = category === cat.value;
              return (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => setCategory(cat.value)}
                  aria-pressed={selected}
                  className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs font-medium transition-all ${
                    selected ? 'text-zinc-900 bg-white shadow-sm' : 'border-zinc-200 bg-zinc-50/50 text-zinc-500 hover:text-zinc-700 hover:border-zinc-300'
                  }`}
                  style={selected ? { borderColor: accentColor, boxShadow: `0 0 0 1px ${accentColor}66, 0 1px 2px rgba(0,0,0,0.05)` } : undefined}
                >
                  <TypeIcon size={13} style={selected ? { color: accentColor } : undefined} className={selected ? undefined : 'text-zinc-400'} />
                  <span className="truncate">{cat.label}</span>
                </button>
              );
            })}
          </div>

          <input autoFocus={!isEditing} type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="Name (e.g. Email Login)" required className={`w-full ${inputClass}`} />

          {/* Type-specific fields; half-width fields pair up */}
          <div className="grid grid-cols-2 gap-3">
            {fieldDefs.map(def => (
              <div key={def.key} className={def.half ? 'col-span-1' : 'col-span-2'}>
                {renderField(def)}
              </div>
            ))}
          </div>
          {isEditing && fieldDefs.some(d => d.sensitive) && (
            <p className="text-[11px] text-zinc-400 ml-0.5">
              Secret fields are hidden for your security. Leave them blank to keep the current values.
            </p>
          )}

          <textarea value={fields.notes ?? ''} onChange={e => setField('notes', e.target.value)} placeholder="Notes (optional)" rows={2} className={`w-full resize-none ${inputClass}`} />
          <div className="flex items-center gap-2 justify-end pt-1">
            <button type="button" onClick={onCancel} className="px-4 py-2.5 text-sm font-medium text-zinc-500 hover:text-zinc-700 transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!label.trim() || submitting}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: accentColor }}
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              {isEditing ? 'Update' : 'Submit'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* Main credentials section — two distinct views: list vs form */
function PortalCredentialForm({ token, pin, accentColor, credentialsSubmitted }: {
  token: string;
  pin?: string;
  accentColor: string;
  credentialsSubmitted: SubmittedCredential[];
}) {
  const [localCredentials, setLocalCredentials] = useState<SubmittedCredential[]>(credentialsSubmitted);
  const [view, setView] = useState<'list' | 'add' | 'edit'>('list');
  const [editTarget, setEditTarget] = useState<SubmittedCredential | null>(null);

  const handleDone = (cred: SubmittedCredential, mode: 'add' | 'edit') => {
    if (mode === 'add') {
      setLocalCredentials(prev => [cred, ...prev]);
      toast('success', 'Credentials submitted securely');
    } else {
      setLocalCredentials(prev => prev.map(c => c.id === cred.id ? cred : c));
      toast('success', 'Credential updated');
    }
    setView('list');
    setEditTarget(null);
  };

  const handleCancel = () => {
    setView('list');
    setEditTarget(null);
  };

  return (
    <section>
      {/* ── List view ──────────────────────────── */}
      {view === 'list' && (
        <>
          <SectionHeader
            icon={ShieldCheck}
            title="Credentials"
            accentColor={accentColor}
            right={
              <button
                onClick={() => setView('add')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white rounded-xl transition-all duration-200 hover:brightness-[0.92] shadow-sm"
                style={{ backgroundColor: accentColor }}
              >
                <Plus size={13} />
                Add
              </button>
            }
          />

          {localCredentials.length > 0 ? (
            <div className="space-y-3">
              {localCredentials.map(cred => {
                const catStyle = CATEGORY_STYLE[cred.category] || CATEGORY_STYLE.other;
                const catMeta = CREDENTIAL_CATEGORIES.find(c => c.value === cred.category);
                const catLabel = catMeta?.label || cred.category;
                const CatIcon = catMeta?.icon || KeyRound;
                return (
                  <div
                    key={cred.id}
                    className="group bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 px-4 sm:px-5 py-3.5 hover:shadow-[0_1px_3px_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.06)] transition-shadow duration-300"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: catStyle.bg }}
                      >
                        <CatIcon size={15} style={{ color: catStyle.iconColor }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-800 truncate">{cred.label}</p>
                        <div className="flex items-center gap-1.5 mt-0.5 text-xs text-zinc-400">
                          <span>{catLabel}</span>
                          <span className="text-zinc-200">/</span>
                          <span>{relativeTime(cred.updated_at || cred.created_at)}</span>
                        </div>
                      </div>
                      <Tooltip content="Edit">
                        <button
                          onClick={() => { setEditTarget(cred); setView('edit'); }}
                          className="flex-shrink-0 p-1.5 text-zinc-300 group-hover:text-zinc-500 hover:!text-zinc-700 hover:bg-zinc-50 rounded-lg transition-all"
                        >
                          <Pencil size={14} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 p-8 text-center">
              <ShieldCheck size={24} className="mx-auto mb-2 text-zinc-300" />
              <p className="text-sm text-zinc-500">No credentials yet. Use the Add button to share access securely.</p>
            </div>
          )}
        </>
      )}

      {/* ── Add / Edit form view ──────────────── */}
      {(view === 'add' || view === 'edit') && (
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 p-5 sm:p-6">
          <CredentialFormView
            key={view === 'edit' ? editTarget?.id : 'add'}
            token={token}
            pin={pin}
            accentColor={accentColor}
            editingCredential={view === 'edit' ? editTarget : null}
            onDone={handleDone}
            onCancel={handleCancel}
          />
        </div>
      )}
    </section>
  );
}

/* ── Page ─────────────────────────────────────────── */

// Outer wrapper exists solely to provide a Suspense boundary so the inner
// component can use Next's useSearchParams() without tripping the
// "missing-suspense-with-csr-bailout" build error. The inner component
// holds all the actual page logic.
export default function PortalPage() {
  return (
    <Suspense fallback={null}>
      <PortalPageInner />
    </Suspense>
  );
}

/* ── Analytics helpers (client) ───────────────────── */

/** One session id per portal-token per tab. Regenerated each new tab so the
 *  admin dashboard can tell separate visits apart even from the same client. */
function getOrCreateClientSessionId(token: string): string {
  const key = `portal-session-${token}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    // sessionStorage can throw in privacy modes; fall back to in-memory.
    return crypto.randomUUID();
  }
}

/** Snapshot of client-reported context. Sent with every event the portal
 *  page emits so the dashboard can break sessions down by device/timezone. */
function getClientContext() {
  if (typeof window === 'undefined') return undefined;
  const conn = (navigator as unknown as { connection?: { effectiveType?: string } }).connection;
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    screen_width: window.screen?.width ?? null,
    screen_height: window.screen?.height ?? null,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    connection_type: conn?.effectiveType ?? null,
    color_scheme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    reduced_motion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  };
}

function PortalPageInner() {
  const params = useParams();
  const token = (params.token as string).toLowerCase();

  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const pinRef = useRef<PinInputRef>(null);
  const [branding, setBranding] = useState<{ logo_url: string; accent_color: string; project_name: string; welcome_message: string } | null>(null);

  // Stable session id for the lifetime of this tab. Sent on every portal API
  // call so the server can group events into one "visit" in the analytics view.
  const sessionId = useRef<string>('');
  if (typeof window !== 'undefined' && !sessionId.current) {
    sessionId.current = getOrCreateClientSessionId(token);
  }

  /** Fire-and-forget event emitter. Uses keepalive so events sent during page
   *  unload (e.g. final heartbeat) still flush. Swallows errors so analytics
   *  can never break the UI. Skips events that have no session id yet
   *  (SSR / pre-hydrate). */
  const track = useCallback((eventType: string, metadata: Record<string, unknown> = {}) => {
    if (!sessionId.current) return;
    try {
      const isDemo = localStorage.getItem('valiance-demo-mode') === 'true'
        || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
      const params = new URLSearchParams();
      if (isDemo) params.set('demo', 'true');
      const qs = params.toString();
      const storedPin = sessionStorage.getItem(`portal-pin-${token}`) || '';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-portal-session-id': sessionId.current,
      };
      if (storedPin) headers['x-portal-pin'] = storedPin;
      fetch(`/api/portal/${token}/track${qs ? `?${qs}` : ''}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event_type: eventType,
          session_id: sessionId.current,
          metadata,
          client: getClientContext(),
        }),
        keepalive: true,
      }).catch(() => { /* silent */ });
    } catch {
      /* silent */
    }
  }, [token]);

  // File upload state
  const [localFiles, setLocalFiles] = useState<PortalData['files']>([]);
  const [fileUploading, setFileUploading] = useState(false);

  // File preview state
  const [previewFile, setPreviewFile] = useState<{ id?: string; name: string; file_url: string; mime_type: string } | null>(null);

  // Emit file_preview the moment the preview modal opens. Using an effect
  // keeps the tracking centralized so every call-site (project files,
  // update attachments) gets it for free.
  useEffect(() => {
    if (!previewFile || !data || pinRequired) return;
    track('file_preview', previewFile.id ? { file_id: previewFile.id } : {});
  }, [previewFile, data, pinRequired, track]);

  // Invoice preview deep-linking via ?invoice=INV-001 search param so clients
  // can share a link to a specific invoice. Resolves to actual invoice data
  // when the portal payload is loaded.
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const activeInvoiceNumber = searchParams.get('invoice');
  const activeInvoice = activeInvoiceNumber && data
    ? data.invoices.find(i => i.invoice_number === activeInvoiceNumber) ?? null
    : null;
  const activePdfData = activeInvoice && data ? data.invoice_pdfs?.[activeInvoice.id] ?? null : null;
  const activePdfError = activeInvoice && data ? data.invoice_pdf_errors?.[activeInvoice.id] ?? null : null;

  // Opening pushes a new history entry so the browser back button closes the
  // modal — matches conventional deep-linkable modal behavior (Twitter, etc).
  const openInvoice = useCallback((invoiceNumber: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('invoice', invoiceNumber);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, searchParams, pathname]);

  // Fires once each time an invoice opens. The ref is cleared whenever the
  // modal closes (activeInvoice → null) so closing and reopening the same
  // invoice in one session counts as a fresh view; only back-to-back state
  // changes that resolve to the same id (e.g., a deep-link refresh that
  // keeps the invoice open) are deduped.
  const lastInvoiceTrackedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data || pinRequired) return;
    if (!activeInvoice) {
      lastInvoiceTrackedRef.current = null;
      return;
    }
    if (lastInvoiceTrackedRef.current === activeInvoice.id) return;
    lastInvoiceTrackedRef.current = activeInvoice.id;
    track('invoice_view', { invoice_id: activeInvoice.id, invoice_number: activeInvoice.invoice_number });
  }, [activeInvoice, data, pinRequired, track]);

  // Closing replaces (no extra history entry) so users don't end up with a
  // pile of modal-open/close states cluttering their back stack.
  const closeInvoice = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('invoice');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, searchParams, pathname]);

  const fetchPortal = async (pinValue?: string) => {
    if (pinValue) setPinSubmitting(true);
    else setLoading(true);
    setError(null);
    setPinError(false);

    // Reuse a previously validated PIN so a reload doesn't force re-entry
    const effectivePin = pinValue || sessionStorage.getItem(`portal-pin-${token}`) || undefined;

    try {
      const isDemo = localStorage.getItem('valiance-demo-mode') === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
      const params = new URLSearchParams();
      if (isDemo) params.set('demo', 'true');
      const qs = params.toString();
      const url = `/api/portal/${token}${qs ? `?${qs}` : ''}`;

      const headers: Record<string, string> = {};
      if (effectivePin) headers['x-portal-pin'] = effectivePin;
      if (sessionId.current) headers['x-portal-session-id'] = sessionId.current;
      const res = await fetch(url, { headers });

      if (res.status === 401) {
        const body = await res.json();
        if (body.pin_required) {
          // A stored PIN that no longer works is stale; drop it silently
          if (!pinValue && effectivePin) sessionStorage.removeItem(`portal-pin-${token}`);
          setPinRequired(true);
          if (body.branding) setBranding(body.branding);
          if (pinValue) {
            setPinError(true);
            setPin('');
            setTimeout(() => pinRef.current?.focus(), 300);
          }
          setLoading(false);
          setPinSubmitting(false);
          return;
        }
      }

      if (res.status === 404) {
        setError('This portal is not available.');
        setLoading(false);
        setPinSubmitting(false);
        return;
      }

      if (!res.ok) {
        setError('Something went wrong. Please try again later.');
        setLoading(false);
        setPinSubmitting(false);
        return;
      }

      const portalData: PortalData = await res.json();
      setData(portalData);
      setPinRequired(false);

      if (effectivePin) {
        sessionStorage.setItem(`portal-pin-${token}`, effectivePin);
      }
    } catch {
      setError('Failed to load portal. Please check your connection.');
    } finally {
      setLoading(false);
      setPinSubmitting(false);
    }
  };

  useEffect(() => {
    fetchPortal();
  }, [token]);

  // Sync localFiles when portal data loads
  useEffect(() => {
    if (data?.files) setLocalFiles(data.files);
  }, [data?.files]);

  // Heartbeat: ping while the tab is focused so the dashboard can show
  // "spent 4 minutes here" rather than just "opened it". Skipped on the PIN
  // screen because there's no session to attribute the ping to yet.
  useEffect(() => {
    if (!data || pinRequired) return;
    const HEARTBEAT_MS = 30_000;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer != null) return;
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') track('heartbeat');
      }, HEARTBEAT_MS);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    if (document.visibilityState === 'visible') start();
    const onVis = () => (document.visibilityState === 'visible' ? start() : stop());
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, [data, pinRequired, track]);

  // section_view: observe each top-level <section data-portal-section="..."> on
  // the page and fire once per section per session. The set lives in a ref so
  // re-renders don't re-fire events.
  const firedSectionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!data || pinRequired) return;
    const els = document.querySelectorAll<HTMLElement>('[data-portal-section]');
    if (els.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const key = entry.target.getAttribute('data-portal-section');
        if (!key || firedSectionsRef.current.has(key)) continue;
        firedSectionsRef.current.add(key);
        track('section_view', { section: key });
      }
    }, { threshold: 0.4 });
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [data, pinRequired, track]);

  const handlePinComplete = (value: string) => {
    if (pinSubmitting) return;
    fetchPortal(value);
  };

  const handleFileUpload = async (file: File) => {
    setFileUploading(true);
    try {
      const storedPin = sessionStorage.getItem(`portal-pin-${token}`) || '';
      const body = new FormData();
      body.append('file', file);
      const headers: Record<string, string> = {};
      if (storedPin) headers['x-portal-pin'] = storedPin;
      const res = await fetch(`/api/portal/${token}/files`, { method: 'POST', body, headers });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: 'Upload failed' }));
        toast('error', json.error || 'Upload failed');
        return;
      }
      const newFile = await res.json();
      setLocalFiles(prev => [newFile, ...prev]);
      toast('success', `"${file.name}" uploaded successfully`);
    } catch {
      toast('error', 'Upload failed. Please check your connection.');
    } finally {
      setFileUploading(false);
    }
  };

  const accentColor = data?.settings.accent_color || siteConfig.colors.brand[500];

  /* ────────────────────────────────────────────────── */
  /*  LOADING                                          */
  /* ────────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <Loader2 className="animate-spin text-zinc-400" size={32} />
      </div>
    );
  }

  /* ────────────────────────────────────────────────── */
  /*  ERROR                                            */
  /* ────────────────────────────────────────────────── */
  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm" style={{ animation: 'portalFadeUp 0.5s ease both' }}>
          <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-zinc-100 flex items-center justify-center">
            <AlertCircle size={28} className="text-zinc-400" />
          </div>
          <h1 className="text-xl font-bold text-zinc-900 mb-2">Portal Unavailable</h1>
          <p className="text-sm text-zinc-500 leading-relaxed">{error}</p>
        </div>
      </div>
    );
  }

  /* ────────────────────────────────────────────────── */
  /*  PIN ENTRY — split-panel layout                   */
  /* ────────────────────────────────────────────────── */
  if (pinRequired) {
    const pinAccent = branding?.accent_color || siteConfig.colors.brand[500];
    return (
      <div className="min-h-screen flex flex-col md:flex-row" style={{ animation: 'fadeIn 0.3s ease both' }}>
        {/* Left branded panel — desktop only */}
        <div
          className="hidden md:flex md:w-[42%] relative flex-col items-center justify-center p-12"
          style={{ backgroundColor: pinAccent }}
        >
          {/* Dot grid overlay */}
          <div
            className="absolute inset-0 pointer-events-none opacity-[0.07]"
            style={{
              backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          />
          <div className="relative text-center">
            {branding?.logo_url ? (
              <img
                src={branding.logo_url}
                alt="Logo"
                className="w-16 h-16 rounded-xl object-contain mx-auto mb-6 bg-white/10 backdrop-blur-sm"
              />
            ) : (
              <div
                className="w-16 h-16 rounded-xl mx-auto mb-6 flex items-center justify-center text-white text-2xl font-bold bg-white/15"
              >
                {branding?.project_name?.charAt(0) || 'P'}
              </div>
            )}
            <h1 className="text-2xl font-bold text-white tracking-tight mb-1">
              {branding?.project_name || 'Client Portal'}
            </h1>
            <p className="text-sm text-white/50 leading-relaxed max-w-xs">
              {branding?.welcome_message || `Welcome to your project portal. Here you'll find the latest updates, files, and progress.`}
            </p>
          </div>
        </div>

        {/* Mobile branded header — matches portal header */}
        <div className="md:hidden">
          <div className="h-1" style={{ backgroundColor: pinAccent }} />
          <div className="bg-white border-b border-zinc-200 px-5 py-6">
            <div className="flex items-center gap-4">
              <div className="flex-shrink-0">
                {branding?.logo_url ? (
                  <img
                    src={branding.logo_url}
                    alt="Logo"
                    className="w-14 h-14 rounded-xl object-contain border border-zinc-100"
                  />
                ) : (
                  <div
                    className="w-14 h-14 rounded-xl flex items-center justify-center text-white text-xl font-bold"
                    style={{ backgroundColor: pinAccent }}
                  >
                    {branding?.project_name?.charAt(0) || 'P'}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-zinc-900 tracking-tight">
                  {branding?.project_name || 'Client Portal'}
                </h1>
                <p className="text-sm text-zinc-500 leading-relaxed mt-0.5">
                  {branding?.welcome_message || `Welcome to your project portal. Here you'll find the latest updates, files, and progress.`}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right form panel */}
        <div className="flex-1 flex items-center justify-center px-6 py-16 md:py-0 bg-white">
          <div className="w-full max-w-[248px]" style={{ animation: 'portalFadeUp 0.5s ease both' }}>
            <div
              style={pinError ? { animation: 'portalShake 0.5s ease' } : undefined}
            >
              {/* Lock icon */}
              <div className="w-12 h-12 rounded-lg bg-zinc-100 flex items-center justify-center mb-6">
                <Lock size={20} className="text-zinc-500" />
              </div>

              <h2 className="text-xl font-bold text-zinc-900 mb-1">Enter PIN</h2>
              <p className="text-sm text-zinc-500 mb-4">
                This portal is protected. Enter your 4-digit PIN to continue.
              </p>

              <div className="space-y-4">
                <div>
                  <PinInput
                    ref={pinRef}
                    value={pin}
                    onChange={(v) => { setPin(v); setPinError(false); }}
                    onComplete={handlePinComplete}
                    size="lg"
                    error={pinError}
                    accentColor={pinAccent}
                    autoFocus
                    disabled={pinSubmitting}
                    className="justify-between"
                  />
                </div>
                {pinError && (
                  <p className="text-sm text-red-500 font-medium text-center">Incorrect PIN. Please try again.</p>
                )}
                {pinSubmitting && (
                  <div className="flex items-center justify-center gap-2 py-1">
                    <Loader2 size={16} className="animate-spin text-zinc-400" />
                    <span className="text-sm text-zinc-400">Verifying...</span>
                  </div>
                )}
              </div>

              <p className="text-xs text-zinc-400 text-center mt-4">
                Secured with end-to-end encryption
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const updates = data.updates || [];
  const hasSections =
    (data.settings.show_progress && (data.project.status === 'completed' || (data.project.start_date && data.project.due_date))) ||
    (data.settings.show_updates && updates.length > 0) ||
    (data.settings.show_files) ||
    (data.settings.show_hours && data.hours.entries.length > 0) ||
    (data.settings.show_invoices && data.invoices.length > 0) ||
    (data.settings.show_credentials);

  /* ── Hours: member aggregation ───────────────── */
  const memberHours: { name: string; hours: number; color: string }[] = [];
  if (data.hours.entries.length > 0) {
    const byMember: Record<string, number> = {};
    for (const entry of data.hours.entries) {
      byMember[entry.member_name] = (byMember[entry.member_name] || 0) + entry.hours;
    }
    Object.entries(byMember).forEach(([name, hours], i) => {
      memberHours.push({ name, hours, color: MEMBER_COLORS[i % MEMBER_COLORS.length] });
    });
  }

  /* ────────────────────────────────────────────────── */
  /*  MAIN PORTAL                                      */
  /* ────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen flex flex-col" style={{ animation: 'fadeIn 0.3s ease both', backgroundColor: '#F5F3EE' }}>
      {/* Subtle noise texture overlay */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.03] z-0" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")` }} />

      {/* ── Ambient header glow ──────────────────── */}
      <div
        className="absolute top-0 left-0 right-0 h-[320px] pointer-events-none z-0"
        style={{
          background: `radial-gradient(ellipse 80% 70% at 50% 0%, ${accentColor}18 0%, ${accentColor}08 40%, transparent 70%)`,
        }}
      />

      {/* ── Header ──────────────────────────────── */}
      <header className="relative z-10">
        <div className="max-w-3xl mx-auto px-6 sm:px-10 pt-8 sm:pt-10 pb-6">
          <div className="flex items-center gap-4">
            <div className="flex-shrink-0">
              {data.settings.logo_url ? (
                <img
                  src={data.settings.logo_url}
                  alt="Logo"
                  className="w-14 h-14 rounded-2xl object-contain shadow-sm ring-1 ring-black/[0.04]"
                />
              ) : (
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-bold text-white shadow-sm"
                  style={{ backgroundColor: accentColor }}
                >
                  {data.project.name.charAt(0)}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg sm:text-xl font-bold text-zinc-900 tracking-[-0.02em]">
                {data.project.name}
              </h1>
              <p className="text-[13px] text-zinc-400 leading-relaxed">
                {data.settings.welcome_message || 'Client Portal'}
              </p>
            </div>
          </div>
        </div>
        {/* Subtle divider */}
        <div className="max-w-3xl mx-auto px-6 sm:px-10">
          <div className="h-px" style={{ background: `linear-gradient(90deg, ${accentColor}20, ${accentColor}08, transparent)` }} />
        </div>
      </header>

      {/* ── Content ───────────────────────────── */}
      <main className="relative z-10 max-w-3xl mx-auto px-6 sm:px-10 py-8 sm:py-10 flex-1 w-full">
        {hasSections ? (
          <div className="stagger space-y-12">
            {(data.settings.section_order ?? DEFAULT_SECTION_ORDER).map((sectionKey) => {
              switch (sectionKey) {
                case 'show_progress':
                  return data.settings.show_progress && (data.project.status === 'completed' || (data.project.start_date && data.project.due_date)) ? (
                    <section key={sectionKey} data-portal-section={sectionKey}>
                      <SectionHeader icon={CheckCircle2} title="Project Progress" accentColor={accentColor} />
                      <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 p-5 sm:p-6">
                        <div className="flex items-center gap-5 mb-4">
                          <ProgressRing percent={data.progress.percent} color={accentColor} />
                          <div>
                            {data.project.status === 'completed' ? (
                              <p className="text-sm font-semibold text-emerald-600 flex items-center gap-1.5">
                                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                                Completed
                              </p>
                            ) : data.progress.is_overdue ? (
                              <p className="text-sm font-semibold text-red-600 flex items-center gap-1.5">
                                <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                                {Math.abs(data.progress.days_remaining!)} {Math.abs(data.progress.days_remaining!) === 1 ? 'day' : 'days'} overdue
                              </p>
                            ) : (
                              <p className="text-sm font-semibold text-zinc-700 flex items-center gap-1.5">
                                <span className="inline-block w-2 h-2 rounded-full bg-zinc-400" />
                                {data.progress.days_remaining} {data.progress.days_remaining === 1 ? 'day' : 'days'} remaining
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="w-full h-2.5 bg-zinc-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${data.progress.percent}%`,
                              backgroundColor: data.progress.is_overdue ? '#EF4444' : accentColor,
                              transformOrigin: 'left',
                              animation: 'portalBarFill 1.2s cubic-bezier(0.16,1,0.3,1) 0.3s both',
                            }}
                          />
                        </div>
                        {data.project.start_date && data.project.due_date && (
                          <div className="flex justify-between mt-2">
                            <span className="text-xs text-zinc-400">
                              {new Date(data.project.start_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </span>
                            <span className="text-xs text-zinc-400">
                              {new Date(data.project.due_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </span>
                          </div>
                        )}
                      </div>
                    </section>
                  ) : null;

                case 'show_updates':
                  if (!data.settings.show_updates || updates.length === 0) return null;
                  const sorted = [...updates].sort((a, b) => {
                    if (a.pinned && !b.pinned) return -1;
                    if (!a.pinned && b.pinned) return 1;
                    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
                  });
                  return (
                    <div key={sectionKey} data-portal-section={sectionKey}>
                      <UpdatesTimeline
                        updates={sorted}
                        accentColor={accentColor}
                        onPreview={setPreviewFile}
                        onDownload={(file) => track('file_download', { file_id: file.id })}
                      />
                    </div>
                  );

                case 'show_hours':
                  if (!data.settings.show_hours || data.hours.entries.length === 0) return null;
                  return (
                    <div key={sectionKey} data-portal-section={sectionKey}>
                      <HoursSection
                        entries={data.hours.entries}
                        totalHours={data.hours.total_hours}
                        memberHours={memberHours}
                        accentColor={accentColor}
                      />
                    </div>
                  );

                case 'show_files':
                  return data.settings.show_files ? (
                    <section key={sectionKey} data-portal-section={sectionKey}>
                      <SectionHeader
                        icon={FolderOpen}
                        title="Shared Files"
                        accentColor={accentColor}
                        right={
                          <label
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white rounded-xl transition-all duration-200 hover:brightness-[0.92] shadow-sm cursor-pointer"
                            style={{ backgroundColor: accentColor, opacity: fileUploading ? 0.6 : 1 }}
                          >
                            {fileUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                            {fileUploading ? 'Uploading...' : 'Upload'}
                            <input
                              type="file"
                              className="hidden"
                              disabled={fileUploading}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleFileUpload(file);
                                e.target.value = '';
                              }}
                            />
                          </label>
                        }
                      />

                      {localFiles.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {localFiles.map(file => {
                            const FileIcon = getFileIcon(file.mime_type);
                            const iconColor = getFileIconColor(file.mime_type);
                            const iconBg = getFileIconBg(file.mime_type);
                            return (
                              <div key={file.id} className="group bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 p-4 hover:shadow-[0_1px_3px_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.06)] transition-shadow duration-300">
                                <div className="flex items-start gap-3">
                                  <div
                                    className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                                    style={{ backgroundColor: iconBg }}
                                  >
                                    <FileIcon size={18} style={{ color: iconColor }} />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold text-zinc-800 truncate">{file.name}</p>
                                    <p className="text-xs text-zinc-400 mb-3">{formatFileSize(file.file_size)}</p>
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => setPreviewFile({ id: file.id, name: file.name, file_url: file.file_url, mime_type: file.mime_type })}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-50 text-zinc-600 hover:bg-zinc-100 transition-colors border border-zinc-100"
                                      >
                                        <Eye size={12} />
                                        Preview
                                      </button>
                                      <button
                                        onClick={async () => {
                                          track('file_download', { file_id: file.id });
                                          try {
                                            const res = await fetch(file.file_url);
                                            const blob = await res.blob();
                                            const url = URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = url;
                                            a.download = file.name;
                                            document.body.appendChild(a);
                                            a.click();
                                            a.remove();
                                            URL.revokeObjectURL(url);
                                          } catch {
                                            // silent fail
                                          }
                                        }}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-50 text-zinc-600 hover:bg-zinc-100 transition-colors border border-zinc-100"
                                      >
                                        <Download size={12} />
                                        Download
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 p-8 text-center">
                          <FolderOpen size={24} className="mx-auto mb-2 text-zinc-300" />
                          <p className="text-sm text-zinc-500">No shared files yet. Use the upload button to share files.</p>
                        </div>
                      )}
                    </section>
                  ) : null;

                case 'show_invoices': {
                  const portalActive = data.invoices.filter(i => i.status !== 'draft' && i.status !== 'cancelled');
                  const portalInvoiced = portalActive.reduce((s, i) => s + i.amount, 0);
                  const portalPaid = data.invoices.filter(i => i.status === 'paid').reduce((s, i) => s + i.amount, 0);
                  // Break down by line-item type so mixed invoices are counted correctly.
                  // Falls back to flat invoice_type when line_items is empty (legacy rows).
                  let portalHourlyInvoiced = 0;
                  let portalNonHourlyOwed = 0;
                  for (const inv of portalActive) {
                    const items = Array.isArray(inv.line_items) && inv.line_items.length > 0
                      ? inv.line_items
                      : [{ item_type: inv.invoice_type, amount: inv.amount }];
                    for (const li of items) {
                      if (li.item_type === 'hourly') portalHourlyInvoiced += Number(li.amount) || 0;
                      else portalNonHourlyOwed += Number(li.amount) || 0;
                    }
                  }
                  const billing = data.billing;
                  // Billable = hourly work plus service and reimbursement lines owed.
                  const portalBillableTotal = billing
                    ? Math.max(billing.billable_total, portalHourlyInvoiced) + portalNonHourlyOwed
                    : portalInvoiced;
                  const balanceDue = billing
                    ? Math.max(0, portalBillableTotal - portalPaid)
                    : Math.max(0, portalInvoiced - portalPaid);
                  const fmtPortalCurrency = (v: number) => v % 1 === 0 ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                  return data.settings.show_invoices && data.invoices.length > 0 ? (
                    <section key={sectionKey} data-portal-section={sectionKey}>
                      <SectionHeader icon={Receipt} title="Invoices" accentColor={accentColor} />
                      <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 mb-5 overflow-hidden">
                        <div className="grid grid-cols-3 [&>*]:border-l [&>*]:border-zinc-100 [&>*:nth-child(3n+1)]:border-l-0 [&>*:nth-child(n+4)]:border-t">
                          {billing && (
                            <>
                              <div className="px-4 sm:px-5 py-4">
                                <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">Billable</p>
                                <p className="text-base sm:text-lg font-semibold text-zinc-900 tabular-nums">${fmtPortalCurrency(portalBillableTotal)}</p>
                              </div>
                              <div className="px-4 sm:px-5 py-4">
                                <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">Hours</p>
                                <p className="text-base sm:text-lg font-semibold text-zinc-900 tabular-nums">{billing.total_hours.toFixed(1)}</p>
                              </div>
                              <div className="px-4 sm:px-5 py-4">
                                <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">Rate</p>
                                <p className="text-base sm:text-lg font-semibold text-zinc-900 tabular-nums">${Math.round(billing.hourly_rate)}</p>
                              </div>
                            </>
                          )}
                          <div className="px-4 sm:px-5 py-4">
                            <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">Invoiced</p>
                            <p className="text-base sm:text-lg font-semibold text-zinc-900 tabular-nums">${fmtPortalCurrency(portalInvoiced)}</p>
                          </div>
                          <div className="px-4 sm:px-5 py-4">
                            <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">Paid</p>
                            <p className="text-base sm:text-lg font-semibold text-emerald-600 tabular-nums">${fmtPortalCurrency(portalPaid)}</p>
                          </div>
                          <div className="px-4 sm:px-5 py-4">
                            <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">Balance</p>
                            <p className={`text-base sm:text-lg font-semibold tabular-nums ${balanceDue > 0 ? 'text-amber-600' : 'text-zinc-400'}`}>${fmtPortalCurrency(balanceDue)}</p>
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {data.invoices.map((invoice) => {
                          const statusConfig: Record<string, { bg: string; text: string; dot: string }> = {
                            sent: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-400' },
                            paid: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-400' },
                            overdue: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-400' },
                            cancelled: { bg: 'bg-zinc-100', text: 'text-zinc-400', dot: 'bg-zinc-300' },
                          };
                          const sc = statusConfig[invoice.status] || { bg: 'bg-zinc-100', text: 'text-zinc-600', dot: 'bg-zinc-400' };
                          return (
                            <div
                              key={invoice.id}
                              role="button"
                              tabIndex={0}
                              aria-label={`Preview invoice ${invoice.invoice_number}`}
                              onClick={() => openInvoice(invoice.invoice_number)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  openInvoice(invoice.invoice_number);
                                }
                              }}
                              className="group bg-white/80 backdrop-blur-sm rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.03)] border border-white/60 p-4 hover:shadow-[0_1px_3px_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.06)] cursor-pointer focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 transition-shadow duration-300"
                              style={{ outlineColor: accentColor }}
                            >
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full ${sc.bg} ${sc.text}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                                    {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                                  </span>
                                  <span className="text-sm font-semibold text-zinc-900">{invoice.invoice_number}</span>
                                </div>
                                <span className="text-sm font-bold text-zinc-900 tabular-nums">
                                  ${invoice.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 text-xs text-zinc-400">
                                <span>{new Date(invoice.date + 'T00:00:00').toLocaleDateString()}</span>
                                {invoice.due_date && <span>Due: {new Date(invoice.due_date + 'T00:00:00').toLocaleDateString()}</span>}
                                {invoice.paid_date && <span className="text-emerald-600">Paid: {new Date(invoice.paid_date + 'T00:00:00').toLocaleDateString()}</span>}
                              </div>
                              {invoice.description && (
                                <p className="mt-2 text-sm text-zinc-500 leading-relaxed line-clamp-2">{invoice.description}</p>
                              )}
                              {invoice.file_url && (
                                <a
                                  href={invoice.file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-1.5 mt-3 text-xs font-semibold rounded-lg px-3 py-1.5 transition-colors"
                                  style={{ color: accentColor, backgroundColor: accentColor + '10' }}
                                >
                                  <FileDown size={13} />
                                  {invoice.file_name || 'Download'}
                                </a>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ) : null;
                }

                case 'show_credentials':
                  return data.settings.show_credentials ? (
                    <div key={sectionKey} data-portal-section={sectionKey}>
                      <PortalCredentialForm token={token} pin={typeof window !== 'undefined' ? sessionStorage.getItem(`portal-pin-${token}`) || undefined : undefined} accentColor={accentColor} credentialsSubmitted={data.credentials_submitted} />
                    </div>
                  ) : null;

                default:
                  return null;
              }
            })}
          </div>
        ) : (
          /* Empty state */
          <div className="text-center py-20" style={{ animation: 'portalFadeUp 0.5s ease both' }}>
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-zinc-100 flex items-center justify-center">
              <FolderOpen size={22} className="text-zinc-300" />
            </div>
            <p className="text-sm font-medium text-zinc-400">No content to display yet.</p>
            <p className="text-xs text-zinc-300 mt-1">Check back later for updates.</p>
          </div>
        )}
      </main>

      {/* ── Footer ────────────────────────────────── */}
      <footer className="relative z-10 mt-auto border-t border-zinc-200/40">
        <div className="max-w-3xl mx-auto px-6 sm:px-10 py-6 flex flex-col items-center gap-2 min-[400px]:flex-row min-[400px]:justify-between">
          <span className="text-xs text-zinc-400">
            {data.project.name} &middot; Client Portal
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-400">Powered by</span>
            <Logo className="h-3.5 w-auto" />
          </div>
        </div>
      </footer>

      <FilePreviewModal
        isOpen={!!previewFile}
        onClose={() => setPreviewFile(null)}
        file={previewFile}
      />

      {/* Invoice preview — opened via ?invoice=INV-001 deep-link or invoice card click.
          The portal is always light, so the modal keeps its literal white chrome. */}
      <InvoicePreviewModalView
        appearance="light"
        isOpen={!!activeInvoice}
        onClose={closeInvoice}
        pdfData={activePdfData}
        integrityError={activePdfError}
        invoiceNumber={activeInvoice?.invoice_number ?? ''}
        clientLabel={activePdfData?.billTo.company || activePdfData?.billTo.name || data?.project.name || 'Client'}
        invoiceDate={activeInvoice?.date ?? ''}
        onDownload={() => activeInvoice && track('invoice_pdf_download', {
          invoice_id: activeInvoice.id,
          invoice_number: activeInvoice.invoice_number,
        })}
      />
    </div>
  );
}
