'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import {
  Lock, Loader2, FileText, Image, Archive, File, Download, ExternalLink, Globe,
  CheckCircle2, Clock, AlertCircle, Send, FolderOpen,
} from 'lucide-react';
import Link from 'next/link';
import type { PortalData } from '@/lib/types';
import { Logo } from '@/components/ui/Logo';

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

/* ── Gradient overlay for accent surfaces ────────── */
const ACCENT_DEPTH_GRADIENT = [
  'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 50%, rgba(0,0,0,0.08) 100%)',
  'radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.12), transparent 60%)',
].join(', ');

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
  const [branding, setBranding] = useState<{ logo_url: string; accent_color: string; project_name: string } | null>(null);

  const fetchPortal = async (pinValue?: string) => {
    setLoading(true);
    setError(null);
    setPinError(false);

    try {
      const isDemo = localStorage.getItem('projectem-demo-mode') === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
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

  const accentColor = data?.settings.accent_color || '#6366F1';

  /* ────────────────────────────────────────────────── */
  /*  LOADING                                          */
  /* ────────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <Loader2 className="animate-spin text-indigo-600" size={32} />
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
  /*  PIN ENTRY — accent color owns the entire page    */
  /* ────────────────────────────────────────────────── */
  if (pinRequired) {
    const pinAccent = branding?.accent_color || '#6366F1';
    return (
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ backgroundColor: pinAccent }}
      >
        {/* Depth overlay */}
        <div
          className="fixed inset-0 pointer-events-none"
          style={{ background: ACCENT_DEPTH_GRADIENT }}
        />

        <div className="w-full max-w-sm relative" style={{ animation: 'portalFadeUp 0.5s ease both' }}>
          <div
            className="bg-white rounded-2xl shadow-2xl shadow-black/15 p-8 sm:p-10 text-center"
            style={pinError ? { animation: 'portalShake 0.5s ease' } : undefined}
          >
            {/* Brand lockup */}
            <div className="flex items-center justify-center gap-3 mb-6">
              {branding?.logo_url ? (
                <img
                  src={branding.logo_url}
                  alt="Logo"
                  className="w-12 h-12 rounded-xl object-contain"
                />
              ) : (
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center text-white text-lg font-bold"
                  style={{ backgroundColor: pinAccent }}
                >
                  {branding?.project_name?.charAt(0) || <Lock size={22} />}
                </div>
              )}
              <span className="text-zinc-200 text-xs">&times;</span>
              <Logo className="h-10 w-auto" />
            </div>

            <h1 className="text-xl font-bold text-zinc-900 mb-1">
              {branding?.project_name || 'Enter PIN'}
            </h1>
            <p className="text-sm text-zinc-500 mb-6">
              This portal is protected. Enter the PIN to continue.
            </p>

            <form onSubmit={handlePinSubmit} className="space-y-4">
              <input
                type="password"
                value={pin}
                onChange={e => { setPin(e.target.value); setPinError(false); }}
                placeholder="&bull; &bull; &bull; &bull; &bull; &bull;"
                autoFocus
                className={`w-full px-4 py-3.5 text-center text-lg tracking-[0.3em] bg-zinc-50 border-2 rounded-xl outline-none transition-all font-medium ${
                  pinError
                    ? 'border-red-300 bg-red-50/50 focus:border-red-400 focus:ring-4 focus:ring-red-100'
                    : 'border-zinc-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 focus:bg-white'
                }`}
              />
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
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const hasSections =
    (data.settings.show_progress && data.progress.total_tasks > 0) ||
    (data.settings.show_proposals && data.proposals.length > 0) ||
    (data.settings.show_files && data.files.length > 0);

  /* ────────────────────────────────────────────────── */
  /*  MAIN PORTAL                                      */
  /* ────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col" style={{ animation: 'fadeIn 0.3s ease both' }}>

      {/* ── Accent hero header ────────────────────── */}
      <header className="relative overflow-hidden" style={{ backgroundColor: accentColor }}>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: ACCENT_DEPTH_GRADIENT }}
        />
        <div className="relative max-w-3xl mx-auto px-5 sm:px-8 py-8">
          <div className="flex items-start gap-5">
            <div className="flex-shrink-0">
              {data.settings.logo_url ? (
                <img
                  src={data.settings.logo_url}
                  alt="Logo"
                  className="w-14 h-14 rounded-xl object-contain bg-white/15 backdrop-blur-sm p-0.5 ring-1 ring-white/10"
                />
              ) : (
                <div className="w-14 h-14 rounded-xl bg-white/15 backdrop-blur-sm flex items-center justify-center text-white text-xl font-bold border border-white/10">
                  {data.project.name.charAt(0)}
                </div>
              )}
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
                {data.project.name}
              </h1>
              {data.settings.welcome_message && (
                <p className="text-sm sm:text-base text-white/65 max-w-lg leading-relaxed">
                  {data.settings.welcome_message}
                </p>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Content ───────────────────────────────── */}
      <main className="max-w-3xl mx-auto px-5 sm:px-8 py-8 flex-1 w-full">
        {hasSections ? (
          <div className="stagger space-y-5">

            {/* ── Progress ──────────────────────── */}
            {data.settings.show_progress && data.progress.total_tasks > 0 && (
              <section className="bg-white rounded-2xl border border-zinc-200/80 p-6 sm:p-8">
                <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-400 mb-3">
                  Project Progress
                </p>
                <div className="flex items-baseline gap-1.5 mb-6">
                  <span
                    className="text-6xl sm:text-7xl font-bold tabular-nums tracking-tighter leading-none"
                    style={{ color: accentColor }}
                  >
                    {data.progress.percent}
                  </span>
                  <span className="text-2xl font-semibold text-zinc-200">%</span>
                </div>
                <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden mb-3">
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
                <p className="text-sm text-zinc-400">
                  <span className="font-semibold text-zinc-700">{data.progress.done_tasks}</span> of {data.progress.total_tasks} tasks complete
                </p>
              </section>
            )}

            {/* ── Proposals ─────────────────────── */}
            {data.settings.show_proposals && data.proposals.length > 0 && (
              <section className="bg-white rounded-2xl border border-zinc-200/80 p-6 sm:p-8">
                <div className="flex items-center gap-2.5 mb-5">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accentColor }} />
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-400">Proposals</h2>
                  <span className="text-[11px] text-zinc-300 font-medium">({data.proposals.length})</span>
                </div>
                <div className="space-y-3">
                  {data.proposals.map(proposal => {
                    const StatusIcon = getProposalStatusIcon(proposal.status);
                    return (
                      <div
                        key={proposal.id}
                        className="border-l-[3px] rounded-r-xl bg-zinc-50/80 hover:bg-zinc-50 transition-colors p-4 sm:p-5"
                        style={{ borderLeftColor: accentColor }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
                              <h3 className="text-sm font-semibold text-zinc-900">{proposal.title}</h3>
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold border rounded-full ${getProposalStatusColor(proposal.status)}`}>
                                <StatusIcon size={10} />
                                {proposal.status.charAt(0).toUpperCase() + proposal.status.slice(1)}
                              </span>
                            </div>
                            {proposal.description && (
                              <p className="text-sm text-zinc-500 leading-relaxed">{proposal.description}</p>
                            )}
                          </div>
                          {proposal.estimated_value != null && (
                            <span
                              className="text-sm font-bold flex-shrink-0 tabular-nums"
                              style={{ color: accentColor }}
                            >
                              {formatCurrency(proposal.estimated_value)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Files ─────────────────────────── */}
            {data.settings.show_files && data.files.length > 0 && (
              <section className="bg-white rounded-2xl border border-zinc-200/80 p-6 sm:p-8">
                <div className="flex items-center gap-2.5 mb-5">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accentColor }} />
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-400">Shared Files</h2>
                  <span className="text-[11px] text-zinc-300 font-medium">({data.files.length})</span>
                </div>
                <div className="space-y-1">
                  {data.files.map(file => {
                    const FileIcon = getFileIcon(file.mime_type);
                    const isHtml = file.mime_type === 'text/html';
                    return (
                      <div
                        key={file.id}
                        className="flex items-center gap-3.5 px-4 py-3.5 rounded-xl hover:bg-zinc-50 transition-all duration-150 group"
                      >
                        <div
                          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ backgroundColor: `${accentColor}10` }}
                        >
                          <FileIcon size={16} style={{ color: accentColor }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-zinc-900 truncate">{file.name}</p>
                          <p className="text-xs text-zinc-400">{formatFileSize(file.file_size)}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {isHtml ? (
                            <Link
                              href={`/portal/${token}/page/${file.id}`}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all hover:shadow-sm active:scale-[0.97]"
                              style={{ backgroundColor: `${accentColor}12`, color: accentColor }}
                            >
                              <ExternalLink size={12} />
                              View
                            </Link>
                          ) : (
                            <a
                              href={file.file_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-2 text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 rounded-lg transition-all"
                              title="Download"
                            >
                              <Download size={16} />
                            </a>
                          )}
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
      <footer className="mt-auto">
        <div className="max-w-3xl mx-auto px-5 sm:px-8">
          <div
            className="h-px w-full"
            style={{ background: `linear-gradient(to right, transparent, ${accentColor}15, transparent)` }}
          />
        </div>
        <div className="max-w-3xl mx-auto px-5 sm:px-8 py-8 flex items-center justify-center gap-2">
          <span className="text-xs text-zinc-300 font-medium">Powered by</span>
          <Logo className="h-4 w-auto opacity-25" />
        </div>
      </footer>
    </div>
  );
}
