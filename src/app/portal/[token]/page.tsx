'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import {
  Lock, Loader2, FileText, Image, Archive, File, Download, ExternalLink, Globe,
  CheckCircle2, Clock, AlertCircle, Send, FolderOpen, Timer,
} from 'lucide-react';
import Link from 'next/link';
import type { PortalData } from '@/lib/types';
import { Logo } from '@/components/ui/Logo';
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
    (data.settings.show_hours && data.hours.entries.length > 0);

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
            {data.settings.show_updates && updates.length > 0 && (
              <section className="bg-white rounded-xl border border-zinc-200 p-5 sm:p-6">
                <SectionHeader
                  icon={Clock}
                  iconBg="#EFF6FF"
                  title="Updates"
                  right={<span className="text-xs text-zinc-400">{updates.length}</span>}
                />
                <div className="relative">
                  {/* Connecting line */}
                  <div className="absolute left-[5px] top-3 bottom-3 w-px bg-zinc-200" />
                  <div className="space-y-0">
                    {updates.map((update) => {
                      const dotColor =
                        update.update_type === 'milestone' ? '#10B981' :
                        update.update_type === 'deliverable' ? '#3B82F6' :
                        update.update_type === 'note' ? '#F59E0B' :
                        '#A1A1AA';
                      const typeBadge =
                        update.update_type === 'milestone' ? { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' } :
                        update.update_type === 'deliverable' ? { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' } :
                        update.update_type === 'note' ? { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' } :
                        null;

                      return (
                        <div key={update.id} className="relative flex gap-4 pb-6 last:pb-0">
                          {/* Dot */}
                          <div className="relative z-10 flex-shrink-0 mt-1">
                            <div
                              className="w-[11px] h-[11px] rounded-full ring-[3px] ring-white"
                              style={{ backgroundColor: dotColor }}
                            />
                          </div>
                          {/* Content */}
                          <div className="flex-1 min-w-0 pt-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <h3 className="text-sm font-semibold text-zinc-900">{update.title}</h3>
                              {typeBadge && (
                                <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold border rounded-full ${typeBadge.bg} ${typeBadge.text} ${typeBadge.border}`}>
                                  {update.update_type.charAt(0).toUpperCase() + update.update_type.slice(1)}
                                </span>
                              )}
                            </div>
                            {update.content && (
                              <p className="text-sm text-zinc-500 leading-relaxed mb-1.5">{update.content}</p>
                            )}
                            <p className="text-xs text-zinc-400">
                              {update.author_name} &middot; {new Date(update.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            )}

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
                            {isHtml ? (
                              <Link
                                href={`/portal/${token}/page/${file.id}`}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
                              >
                                <ExternalLink size={12} />
                                View
                              </Link>
                            ) : (
                              <a
                                href={file.file_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
                              >
                                <Download size={12} />
                                Download
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
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
