'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import {
  Lock, FileText, Image, Archive, File, Download, ExternalLink, Globe,
  CheckCircle2, Clock, AlertCircle, Send,
} from 'lucide-react';
import Link from 'next/link';
import type { PortalData } from '@/lib/types';
import { Logo } from '@/components/ui/Logo';

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
    case 'accepted': return 'bg-green-50 text-green-700 border-green-200';
    case 'sent': return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'rejected': return 'bg-red-50 text-red-700 border-red-200';
    default: return 'bg-zinc-50 text-zinc-600 border-zinc-200';
  }
}

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

      // Store PIN in sessionStorage so sub-pages can use it
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

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-zinc-200 border-t-zinc-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-zinc-500">Loading portal...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-100 flex items-center justify-center">
            <AlertCircle size={32} className="text-zinc-400" />
          </div>
          <h1 className="text-lg font-semibold text-zinc-900 mb-2">Portal Unavailable</h1>
          <p className="text-sm text-zinc-500">{error}</p>
        </div>
      </div>
    );
  }

  // PIN entry
  if (pinRequired) {
    const pinAccent = branding?.accent_color || '#6366F1';
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 text-center">
            <div className="flex items-center justify-center gap-3 mb-4">
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
                  {branding?.project_name?.charAt(0) || <Lock size={24} />}
                </div>
              )}
              <span className="text-xs font-medium text-zinc-300">&times;</span>
              <Logo className="h-10 w-auto" />
            </div>
            <h1 className="text-lg font-semibold text-zinc-900 mb-1">
              {branding?.project_name || 'Enter PIN'}
            </h1>
            <p className="text-sm text-zinc-500 mb-6">This portal is protected. Enter the PIN to continue.</p>
            <form onSubmit={handlePinSubmit} className="space-y-4">
              <input
                type="password"
                value={pin}
                onChange={e => { setPin(e.target.value); setPinError(false); }}
                placeholder="Enter PIN"
                autoFocus
                className={`w-full px-4 py-3 text-center text-lg tracking-widest bg-white border rounded-xl outline-none transition-all ${
                  pinError
                    ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100'
                    : 'border-zinc-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100'
                }`}
              />
              {pinError && (
                <p className="text-sm text-red-500">Incorrect PIN. Please try again.</p>
              )}
              <button
                type="submit"
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-xl transition-colors"
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

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-zinc-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0">
              {data.settings.logo_url ? (
                <img
                  src={data.settings.logo_url}
                  alt="Logo"
                  className="w-12 h-12 rounded-xl object-contain"
                />
              ) : (
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center text-white text-lg font-bold"
                  style={{ backgroundColor: accentColor }}
                >
                  {data.project.name.charAt(0)}
                </div>
              )}
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-zinc-900">
                {data.project.name}
              </h1>
              {data.settings.welcome_message && (
                <p className="text-sm text-zinc-500 max-w-lg">
                  {data.settings.welcome_message}
                </p>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6 flex-1 w-full">

        {/* Progress */}
        {data.settings.show_progress && data.progress.total_tasks > 0 && (
          <section className="bg-white rounded-xl border border-zinc-200 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-900 mb-3">Project Progress</h2>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-zinc-500">
                {data.progress.done_tasks} of {data.progress.total_tasks} tasks complete
              </span>
              <span className="text-sm font-semibold" style={{ color: accentColor }}>
                {data.progress.percent}%
              </span>
            </div>
            <div className="w-full h-3 bg-zinc-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{ width: `${data.progress.percent}%`, backgroundColor: accentColor }}
              />
            </div>
          </section>
        )}

        {/* Proposals */}
        {data.settings.show_proposals && data.proposals.length > 0 && (
          <section className="bg-white rounded-xl border border-zinc-200 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-900 mb-4">Proposals</h2>
            <div className="space-y-3">
              {data.proposals.map(proposal => {
                const StatusIcon = getProposalStatusIcon(proposal.status);
                return (
                  <div
                    key={proposal.id}
                    className="flex items-start gap-3 p-4 bg-zinc-50 rounded-lg"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-medium text-zinc-900">{proposal.title}</h3>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded-full ${getProposalStatusColor(proposal.status)}`}>
                          <StatusIcon size={11} />
                          {proposal.status.charAt(0).toUpperCase() + proposal.status.slice(1)}
                        </span>
                      </div>
                      {proposal.description && (
                        <p className="text-sm text-zinc-500 mb-1">{proposal.description}</p>
                      )}
                      {proposal.estimated_value != null && (
                        <p className="text-sm font-medium" style={{ color: accentColor }}>
                          {formatCurrency(proposal.estimated_value)}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Files */}
        {data.settings.show_files && data.files.length > 0 && (
          <section className="bg-white rounded-xl border border-zinc-200 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-900 mb-4">Shared Files</h2>
            <div className="space-y-2">
              {data.files.map(file => {
                const FileIcon = getFileIcon(file.mime_type);
                const isHtml = file.mime_type === 'text/html';
                return (
                  <div
                    key={file.id}
                    className="flex items-center gap-3 px-4 py-3 bg-zinc-50 rounded-lg group"
                  >
                    <FileIcon size={18} className="text-zinc-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-700 truncate">
                        {file.name}
                      </p>
                      <p className="text-xs text-zinc-400">{formatFileSize(file.file_size)}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {isHtml && (
                        <Link
                          href={`/portal/${token}/page/${file.id}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors"
                          style={{ backgroundColor: `${accentColor}10`, color: accentColor }}
                        >
                          <ExternalLink size={12} />
                          View
                        </Link>
                      )}
                      {!isHtml && (
                        <a
                          href={file.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 text-zinc-300 hover:text-zinc-500 transition-colors"
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

        {/* Empty state when everything is hidden or empty */}
        {!data.settings.show_progress && !data.settings.show_proposals && !data.settings.show_files && (
          <div className="text-center py-12">
            <p className="text-sm text-zinc-400">No content to display at this time.</p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-200 mt-12">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 flex items-center justify-center gap-1.5">
          <span className="text-xs text-zinc-400">Powered by</span>
          <Logo className="h-4 w-auto opacity-40" />
        </div>
      </footer>
    </div>
  );
}
