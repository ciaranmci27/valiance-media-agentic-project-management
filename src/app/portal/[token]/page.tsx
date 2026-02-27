'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import {
  Lock, Loader2, FileText, Image, Archive, File, Download, ExternalLink, Globe,
  CheckCircle2, Clock, AlertCircle, Send, FolderOpen, Timer,
  Flag, Package, MessageCircle, Pin, ChevronDown, KeyRound, Eye, EyeOff, Plus, Pencil, ShieldCheck,
  Receipt, FileDown,
} from 'lucide-react';
import Link from 'next/link';
import type { PortalData } from '@/lib/types';
import { Logo } from '@/components/ui/Logo';
import { Select } from '@/components/ui/Select';
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

function getUpdateIcon(type: string) {
  switch (type) {
    case 'milestone': return Flag;
    case 'deliverable': return Package;
    case 'note': return MessageCircle;
    default: return Clock;
  }
}

function getProposalStatusIcon(status: string) {
  switch (status) {
    case 'accepted': return CheckCircle2;
    case 'sent': return Send;
    case 'rejected': return AlertCircle;
    default: return Clock;
  }
}

function getProposalStatusColor(status: string) {
  switch (status) {
    case 'accepted': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'sent': return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'rejected': return 'bg-red-50 text-red-700 border-red-200';
    default: return 'bg-zinc-100 text-zinc-600 border-zinc-200';
  }
}

/* ── Member bar colors ───────────────────────────── */
const MEMBER_COLORS = ['#5B8A8A', '#C5A68F', '#6366F1', '#F59E0B', '#EC4899', '#14B8A6'];

/* ── Section header component ────────────────────── */
function SectionHeader({ icon: Icon, iconBg, title, right }: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  iconBg: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: iconBg }}>
          <Icon size={16} className="text-zinc-600" />
        </div>
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
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

function UpdatesTimeline({ updates, accentColor }: {
  updates: PortalData['updates'];
  accentColor: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? updates : updates.slice(0, UPDATES_INITIAL_COUNT);
  const hiddenCount = updates.length - UPDATES_INITIAL_COUNT;

  return (
    <section className="bg-white rounded-xl border border-zinc-200 p-5 sm:p-6">
      <SectionHeader
        icon={Clock}
        iconBg="#EFF6FF"
        title="Updates"
        right={<span className="text-xs text-zinc-400">{updates.length}</span>}
      />
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
                  <div className="absolute left-[13px] top-[27px] bottom-0 w-px bg-zinc-200" />
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
                                <div className="absolute inset-0 rounded-lg bg-black/0 group-hover/img:bg-black/40 transition-colors flex items-center justify-center gap-1.5 opacity-0 group-hover/img:opacity-100">
                                  <button
                                    onClick={() => window.open(a.file_url, '_blank', 'noopener,noreferrer')}
                                    className="p-1.5 bg-white/90 rounded-md text-zinc-700 hover:bg-white transition-colors"
                                    title="Preview"
                                  >
                                    <Eye size={13} />
                                  </button>
                                  <button
                                    onClick={async () => {
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
                                    title="Download"
                                  >
                                    <Download size={13} />
                                  </button>
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
                                  <button
                                    onClick={() => window.open(a.file_url, '_blank', 'noopener,noreferrer')}
                                    className="p-0.5 text-zinc-400 hover:text-zinc-700 transition-colors"
                                    title="Preview"
                                  >
                                    <Eye size={12} />
                                  </button>
                                  {!isHtml && (
                                    <button
                                      onClick={async () => {
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
                                      title="Download"
                                    >
                                      <Download size={12} />
                                    </button>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <p className="text-xs text-zinc-400" title={fullDate}>
                    {update.author_name} &middot; {relativeTime(update.created_at)}
                  </p>
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
          className="mt-4 w-full flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-zinc-400 hover:text-zinc-600 bg-zinc-50 hover:bg-zinc-100 rounded-lg transition-colors"
        >
          <ChevronDown size={14} className={`transition-transform ${showAll ? 'rotate-180' : ''}`} />
          {showAll ? 'Show less' : `Show ${hiddenCount} more update${hiddenCount === 1 ? '' : 's'}`}
        </button>
      )}
    </section>
  );
}

/* ── Portal Credential Form ─────────────────────── */

const CREDENTIAL_CATEGORIES = [
  { value: 'login', label: 'Login' },
  { value: 'api_key', label: 'API Key' },
  { value: 'ssh_key', label: 'SSH Key' },
  { value: 'database', label: 'Database' },
  { value: 'hosting', label: 'Hosting' },
  { value: 'cms', label: 'CMS' },
  { value: 'ftp', label: 'FTP' },
  { value: 'dns', label: 'DNS' },
  { value: 'email', label: 'Email' },
  { value: 'other', label: 'Other' },
];

const CATEGORY_STYLE: Record<string, { bg: string; iconColor: string }> = {
  login:    { bg: '#F5F3FF', iconColor: '#8B5CF6' },
  api_key:  { bg: '#EFF6FF', iconColor: '#3B82F6' },
  ssh_key:  { bg: '#ECFDF5', iconColor: '#10B981' },
  database: { bg: '#FFFBEB', iconColor: '#F59E0B' },
  hosting:  { bg: '#FEF2F2', iconColor: '#EF4444' },
  cms:      { bg: '#ECFEFF', iconColor: '#06B6D4' },
  ftp:      { bg: '#FFF7ED', iconColor: '#F97316' },
  dns:      { bg: '#EEF2FF', iconColor: '#6366F1' },
  email:    { bg: '#FDF2F8', iconColor: '#EC4899' },
  other:    { bg: '#F4F4F5', iconColor: '#71717A' },
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
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadingFields, setLoadingFields] = useState(isEditing);

  const buildQs = () => {
    const p = new URLSearchParams();
    if (pin) p.set('pin', pin);
    const qs = p.toString();
    return qs ? `?${qs}` : '';
  };

  // Fetch existing field values when editing
  useEffect(() => {
    if (!isEditing) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/${token}/credentials/${editingCredential.id}${buildQs()}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (cancelled) return;
        setUsername(data.username || '');
        setUrl(data.url || '');
        setNotes(data.notes || '');
      } catch {
        // If fetch fails, fields stay empty — they can still re-enter
      } finally {
        if (!cancelled) setLoadingFields(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setSubmitting(true);

    try {
      if (isEditing) {
        // Always send username, url, notes (pre-filled or edited).
        // Only send password if the client typed one — otherwise omit to preserve existing.
        const payload: Record<string, string | undefined> = {
          label: label.trim(),
          category,
          username: username.trim(),
          url: url.trim(),
          notes: notes.trim(),
        };
        if (password) payload.password = password;

        const res = await fetch(`/api/portal/${token}/credentials/${editingCredential.id}${buildQs()}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error();
        const json = await res.json();
        onDone({ ...editingCredential, ...json.data }, 'edit');
      } else {
        const res = await fetch(`/api/portal/${token}/credentials${buildQs()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: label.trim(), category,
            username: username.trim(), password: password.trim(),
            url: url.trim(), notes: notes.trim(),
            submitted_by_name: '',
          }),
        });
        if (!res.ok) throw new Error();
        onDone({
          id: crypto.randomUUID(),
          label: label.trim(),
          category: category as SubmittedCredential['category'],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, 'add');
      }
    } catch {
      // silent fail on portal
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'px-3 py-2.5 text-sm bg-zinc-50 border border-zinc-200 rounded-lg outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 transition-all placeholder:text-zinc-400';

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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input autoFocus type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="Name (e.g. Email Login)" required className={inputClass} />
            <Select value={category} onChange={v => setCategory(v)} options={CREDENTIAL_CATEGORIES} />
          </div>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" autoComplete="off" data-1p-ignore data-lpignore="true" className={`w-full ${inputClass}`} />
          <div>
            <div className="relative">
              <input
                type="text"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={isEditing ? 'Enter new password to replace' : 'Password / Secret'}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                style={showPassword ? undefined : { WebkitTextSecurity: 'disc' } as React.CSSProperties}
                className={`w-full pr-10 ${inputClass}`}
              />
              <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {isEditing && (
              <p className="text-[11px] text-zinc-400 mt-1 ml-0.5">
                {password ? 'This will replace the existing password.' : 'Leave blank to keep your current password.'}
              </p>
            )}
          </div>
          <input type="text" value={url} onChange={e => setUrl(e.target.value)} placeholder="URL (optional)" className={`w-full ${inputClass}`} />
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" rows={2} className={`w-full resize-none ${inputClass}`} />
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
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 4000);
  };

  const handleDone = (cred: SubmittedCredential, mode: 'add' | 'edit') => {
    if (mode === 'add') {
      setLocalCredentials(prev => [cred, ...prev]);
      showSuccess('Credentials submitted securely');
    } else {
      setLocalCredentials(prev => prev.map(c => c.id === cred.id ? cred : c));
      showSuccess('Credential updated');
    }
    setView('list');
    setEditTarget(null);
  };

  const handleCancel = () => {
    setView('list');
    setEditTarget(null);
  };

  return (
    <section className="bg-white rounded-xl border border-zinc-200 p-5 sm:p-6">
      {/* ── List view ──────────────────────────── */}
      {view === 'list' && (
        <>
          <SectionHeader
            icon={ShieldCheck}
            iconBg="#F0FDF4"
            title="Credentials"
            right={
              <button
                onClick={() => setView('add')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white rounded-lg transition-colors hover:brightness-[0.92]"
                style={{ backgroundColor: accentColor }}
              >
                <Plus size={13} />
                Add
              </button>
            }
          />

          {/* Success toast */}
          {successMsg && (
            <div
              className="flex items-center gap-2.5 px-3.5 py-3 mb-4 rounded-lg border"
              style={{ backgroundColor: accentColor + '08', borderColor: accentColor + '20', animation: 'portalFadeUp 0.25s ease both' }}
            >
              <CheckCircle2 size={16} style={{ color: accentColor }} className="flex-shrink-0" />
              <p className="text-sm font-medium text-zinc-700">{successMsg}</p>
            </div>
          )}

          {localCredentials.length > 0 ? (
            <div className="space-y-1.5">
              {localCredentials.map(cred => {
                const catStyle = CATEGORY_STYLE[cred.category] || CATEGORY_STYLE.other;
                const catLabel = CREDENTIAL_CATEGORIES.find(c => c.value === cred.category)?.label || cred.category;
                return (
                  <div
                    key={cred.id}
                    className="group flex items-center gap-3 px-3.5 py-3 rounded-lg bg-zinc-50 hover:bg-zinc-100/80 transition-colors"
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: catStyle.bg }}
                    >
                      <KeyRound size={14} style={{ color: catStyle.iconColor }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-zinc-900 truncate">{cred.label}</p>
                      <p className="text-xs text-zinc-400">
                        {catLabel} &middot; {relativeTime(cred.updated_at || cred.created_at)}
                      </p>
                    </div>
                    <button
                      onClick={() => { setEditTarget(cred); setView('edit'); }}
                      className="flex-shrink-0 p-1.5 text-zinc-300 group-hover:text-zinc-500 hover:!text-zinc-700 hover:bg-white rounded-md transition-all"
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : !successMsg ? (
            <p className="text-sm text-zinc-500">
              Securely share login credentials or access information with the team.
            </p>
          ) : null}
        </>
      )}

      {/* ── Add / Edit form view ──────────────── */}
      {(view === 'add' || view === 'edit') && (
        <CredentialFormView
          key={view === 'edit' ? editTarget?.id : 'add'}
          token={token}
          pin={pin}
          accentColor={accentColor}
          editingCredential={view === 'edit' ? editTarget : null}
          onDone={handleDone}
          onCancel={handleCancel}
        />
      )}
    </section>
  );
}

/* ── Page ─────────────────────────────────────────── */

export default function PortalPage() {
  const params = useParams();
  const token = params.token as string;

  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [branding, setBranding] = useState<{ logo_url: string; accent_color: string; project_name: string; welcome_message: string } | null>(null);

  const fetchPortal = async (pinValue?: string) => {
    setLoading(true);
    setError(null);
    setPinError(false);

    try {
      const isDemo = localStorage.getItem('valiance-demo-mode') === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
      const params = new URLSearchParams();
      if (pinValue) params.set('pin', pinValue);
      if (isDemo) params.set('demo', 'true');
      const qs = params.toString();
      const url = `/api/portal/${token}${qs ? `?${qs}` : ''}`;

      const res = await fetch(url);

      if (res.status === 401) {
        const body = await res.json();
        if (body.pin_required) {
          setPinRequired(true);
          if (body.branding) setBranding(body.branding);
          if (pinValue) setPinError(true);
          setLoading(false);
          return;
        }
      }

      if (res.status === 404) {
        setError('This portal is not available.');
        setLoading(false);
        return;
      }

      if (!res.ok) {
        setError('Something went wrong. Please try again later.');
        setLoading(false);
        return;
      }

      const portalData: PortalData = await res.json();
      setData(portalData);
      setPinRequired(false);

      if (pinValue) {
        sessionStorage.setItem(`portal-pin-${token}`, pinValue);
      }
    } catch {
      setError('Failed to load portal. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPortal();
  }, [token]);

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;
    fetchPortal(pin);
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
          <div className="w-full max-w-sm" style={{ animation: 'portalFadeUp 0.5s ease both' }}>
            <div
              style={pinError ? { animation: 'portalShake 0.5s ease' } : undefined}
            >
              {/* Lock icon */}
              <div className="w-12 h-12 rounded-lg bg-zinc-100 flex items-center justify-center mb-6">
                <Lock size={20} className="text-zinc-500" />
              </div>

              <h2 className="text-xl font-bold text-zinc-900 mb-1">Enter PIN</h2>
              <p className="text-sm text-zinc-500 mb-8">
                This portal is protected. Enter the PIN to continue.
              </p>

              <form onSubmit={handlePinSubmit} className="space-y-4">
                <div>
                  <label htmlFor="portal-pin" className="block text-xs font-medium text-zinc-500 mb-1.5">
                    Access PIN
                  </label>
                  <input
                    id="portal-pin"
                    type="password"
                    value={pin}
                    onChange={e => { setPin(e.target.value); setPinError(false); }}
                    placeholder="&bull; &bull; &bull; &bull; &bull; &bull;"
                    autoFocus
                    className={`w-full px-4 py-3 text-center text-lg tracking-[0.3em] bg-zinc-50 border rounded-xl outline-none transition-all font-medium ${
                      pinError
                        ? 'border-red-300 bg-red-50/50 focus:border-red-400 focus:ring-4 focus:ring-red-100'
                        : 'border-zinc-200 focus:border-zinc-900 focus:ring-4 focus:ring-zinc-100 focus:bg-white'
                    }`}
                  />
                </div>
                {pinError && (
                  <p className="text-sm text-red-500 font-medium">Incorrect PIN. Please try again.</p>
                )}
                <button
                  type="submit"
                  className="w-full py-3 text-white text-sm font-semibold rounded-xl transition-all hover:brightness-[0.92] active:scale-[0.98]"
                  style={{ backgroundColor: pinAccent, boxShadow: `0 4px 14px -2px ${pinAccent}50` }}
                >
                  Continue
                </button>
              </form>

              <p className="text-xs text-zinc-400 text-center mt-6">
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
    (data.settings.show_progress && data.progress.total_tasks > 0) ||
    (data.settings.show_updates && updates.length > 0) ||
    (data.settings.show_proposals && data.proposals.length > 0) ||
    (data.settings.show_files && data.files.length > 0) ||
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
    <div className="min-h-screen bg-zinc-50 flex flex-col" style={{ animation: 'fadeIn 0.3s ease both' }}>

      {/* ── Accent top stripe ──────────────────── */}
      <div className="h-1" style={{ backgroundColor: accentColor }} />

      {/* ── White header ───────────────────────── */}
      <header className="bg-white border-b border-zinc-200">
        <div className="max-w-3xl mx-auto px-5 sm:px-8 py-6">
          <div className="flex items-center gap-4">
            <div className="flex-shrink-0">
              {data.settings.logo_url ? (
                <img
                  src={data.settings.logo_url}
                  alt="Logo"
                  className="w-14 h-14 sm:w-12 sm:h-12 rounded-xl object-contain border border-zinc-100"
                />
              ) : (
                <div
                  className="w-14 h-14 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center text-white text-xl sm:text-lg font-bold"
                  style={{ backgroundColor: accentColor }}
                >
                  {data.project.name.charAt(0)}
                </div>
              )}
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold text-zinc-900 tracking-tight">
                {data.project.name}
              </h1>
              <p className="text-sm text-zinc-500 leading-relaxed">
                {data.settings.welcome_message || `Welcome to your project portal. Here you'll find the latest updates, files, and progress.`}
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* ── Content ───────────────────────────── */}
      <main className="max-w-3xl mx-auto px-5 sm:px-8 py-8 flex-1 w-full">
        {hasSections ? (
          <div className="stagger space-y-6">

            {/* ── Progress ──────────────────────── */}
            {data.settings.show_progress && data.progress.total_tasks > 0 && (
              <section className="bg-white rounded-xl border border-zinc-200 p-5 sm:p-6">
                <SectionHeader
                  icon={CheckCircle2}
                  iconBg={`${accentColor}15`}
                  title="Project Progress"
                />
                <div className="flex items-center gap-5 mb-4">
                  <ProgressRing percent={data.progress.percent} color={accentColor} />
                  <div>
                    <p className="text-sm text-zinc-500">
                      <span className="font-semibold text-zinc-900">{data.progress.done_tasks}</span> of {data.progress.total_tasks} tasks complete
                    </p>
                  </div>
                </div>
                <div className="w-full h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${data.progress.percent}%`,
                      backgroundColor: accentColor,
                      transformOrigin: 'left',
                      animation: 'portalBarFill 1.2s cubic-bezier(0.16,1,0.3,1) 0.3s both',
                    }}
                  />
                </div>
              </section>
            )}

            {/* ── Updates Timeline ──────────────── */}
            {data.settings.show_updates && updates.length > 0 && (() => {
              // Sort: pinned first, then by date descending
              const sorted = [...updates].sort((a, b) => {
                if (a.pinned && !b.pinned) return -1;
                if (!a.pinned && b.pinned) return 1;
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
              });

              return (
                <UpdatesTimeline updates={sorted} accentColor={accentColor} />
              );
            })()}

            {/* ── Hours Logged ──────────────────── */}
            {data.settings.show_hours && data.hours.entries.length > 0 && (
              <section className="bg-white rounded-xl border border-zinc-200 p-5 sm:p-6">
                <SectionHeader
                  icon={Timer}
                  iconBg="#F5F3FF"
                  title="Hours Logged"
                  right={
                    <span className="text-lg font-bold text-zinc-900 tabular-nums">
                      {data.hours.total_hours.toFixed(1)}h
                    </span>
                  }
                />

                {/* Member breakdown bar */}
                {memberHours.length > 0 && (
                  <div className="mb-4">
                    <div className="flex h-2 rounded-full overflow-hidden bg-zinc-100">
                      {memberHours.map((m) => (
                        <div
                          key={m.name}
                          className="h-full first:rounded-l-full last:rounded-r-full"
                          style={{
                            width: `${(m.hours / data.hours.total_hours) * 100}%`,
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
                          <span className="text-zinc-400">{m.hours.toFixed(1)}h</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Entry list */}
                <div className="space-y-0 max-h-[280px] overflow-y-auto">
                  {data.hours.entries.map(entry => (
                    <div
                      key={entry.id}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-50 transition-all duration-150"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-900 truncate">
                          {entry.description || 'Work logged'}
                        </p>
                        <p className="text-xs text-zinc-400">
                          {entry.member_name} &middot; {new Date(entry.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} &middot; {new Date(entry.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} – {new Date(entry.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                        </p>
                      </div>
                      <span className="text-sm font-semibold text-zinc-600 flex-shrink-0 tabular-nums">
                        {entry.hours.toFixed(1)}h
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Proposals ─────────────────────── */}
            {data.settings.show_proposals && data.proposals.length > 0 && (
              <section>
                <SectionHeader
                  icon={FileText}
                  iconBg="#ECFDF5"
                  title="Proposals"
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {data.proposals.map(proposal => {
                    const StatusIcon = getProposalStatusIcon(proposal.status);
                    return (
                      <div
                        key={proposal.id}
                        className="rounded-xl border border-zinc-200 p-4 hover:shadow-md transition-shadow bg-white"
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold border rounded-full ${getProposalStatusColor(proposal.status)}`}>
                            <StatusIcon size={10} />
                            {proposal.status.charAt(0).toUpperCase() + proposal.status.slice(1)}
                          </span>
                        </div>
                        <h3 className="text-sm font-semibold text-zinc-900 mb-1">{proposal.title}</h3>
                        {proposal.description && (
                          <p className="text-xs text-zinc-500 leading-relaxed mb-2 line-clamp-2">{proposal.description}</p>
                        )}
                        {proposal.estimated_value != null && (
                          <p className="text-sm font-bold text-zinc-900 tabular-nums">
                            {formatCurrency(proposal.estimated_value)}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Files ─────────────────────────── */}
            {data.settings.show_files && data.files.length > 0 && (
              <section className="bg-white rounded-xl border border-zinc-200 p-5 sm:p-6">
                <SectionHeader
                  icon={FolderOpen}
                  iconBg="#FFFBEB"
                  title="Shared Files"
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {data.files.map(file => {
                    const FileIcon = getFileIcon(file.mime_type);
                    const iconColor = getFileIconColor(file.mime_type);
                    const iconBg = getFileIconBg(file.mime_type);
                    const isHtml = file.mime_type === 'text/html';
                    return (
                      <div
                        key={file.id}
                        className="rounded-xl border border-zinc-100 bg-zinc-50/50 p-4 hover:bg-zinc-50 transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          <div
                            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                            style={{ backgroundColor: iconBg }}
                          >
                            <FileIcon size={16} style={{ color: iconColor }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-zinc-900 truncate">{file.name}</p>
                            <p className="text-xs text-zinc-400 mb-3">{formatFileSize(file.file_size)}</p>
                            <div className="flex items-center gap-2">
                              {isHtml ? (
                                <Link
                                  href={`/portal/${token}/page/${file.id}`}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
                                >
                                  <ExternalLink size={12} />
                                  View
                                </Link>
                              ) : (
                                <>
                                  <button
                                    onClick={() => window.open(file.file_url, '_blank', 'noopener,noreferrer')}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
                                  >
                                    <Eye size={12} />
                                    Preview
                                  </button>
                                  <button
                                    onClick={async () => {
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
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
                                  >
                                    <Download size={12} />
                                    Download
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Invoices ──────────────────────────── */}
            {data.settings.show_invoices && data.invoices.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <Receipt size={20} style={{ color: accentColor }} />
                  <h2 className="text-lg font-semibold text-zinc-900">Invoices</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {data.invoices.map((invoice) => {
                    const statusStyle: Record<string, string> = {
                      sent: 'bg-blue-50 text-blue-700',
                      paid: 'bg-emerald-50 text-emerald-700',
                      overdue: 'bg-red-50 text-red-700',
                      cancelled: 'bg-zinc-100 text-zinc-400',
                    };
                    return (
                      <div key={invoice.id} className="bg-white rounded-xl border border-zinc-200 p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${statusStyle[invoice.status] || 'bg-zinc-100 text-zinc-600'}`}>
                              {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                            </span>
                            <span className="text-sm font-semibold text-zinc-900">{invoice.invoice_number}</span>
                          </div>
                          <span className="text-sm font-bold text-zinc-900">
                            ${invoice.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-zinc-500">
                          <span>{new Date(invoice.date + 'T00:00:00').toLocaleDateString()}</span>
                          {invoice.due_date && <span>Due: {new Date(invoice.due_date + 'T00:00:00').toLocaleDateString()}</span>}
                          {invoice.paid_date && <span className="text-emerald-600">Paid: {new Date(invoice.paid_date + 'T00:00:00').toLocaleDateString()}</span>}
                        </div>
                        {invoice.description && (
                          <p className="mt-2 text-sm text-zinc-600 line-clamp-2">{invoice.description}</p>
                        )}
                        {invoice.file_url && (
                          <a
                            href={invoice.file_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 mt-3 text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
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
            )}

            {/* ── Submit Credentials ──────────────── */}
            {data.settings.show_credentials && (() => {
              return <PortalCredentialForm token={token} pin={sessionStorage.getItem(`portal-pin-${token}`) || undefined} accentColor={accentColor} credentialsSubmitted={data.credentials_submitted} />;
            })()}
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
      <footer className="mt-auto bg-white border-t border-zinc-200">
        <div className="max-w-3xl mx-auto px-5 sm:px-8 py-6 flex flex-col items-center gap-2 min-[400px]:flex-row min-[400px]:justify-between">
          <span className="text-xs text-zinc-400">
            {data.project.name} &middot; Client Portal
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-400">Powered by</span>
            <Logo className="h-3.5 w-auto" />
          </div>
        </div>
      </footer>
    </div>
  );
}
