'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, AlertCircle, Lock, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';
import { siteConfig } from '@/site-config';

const ACCENT_DEPTH_GRADIENT = [
  'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 50%, rgba(0,0,0,0.08) 100%)',
  'radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.12), transparent 60%)',
].join(', ');

interface FileInfo {
  file_url: string;
  name: string;
  mime_type: string;
}

export default function PortalFilePage() {
  const params = useParams();
  const token = params.token as string;
  const fileId = params.fileId as string;

  const [file, setFile] = useState<FileInfo | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [branding, setBranding] = useState<{ logo_url: string; accent_color: string; project_name: string } | null>(null);

  const fetchFile = async (pinValue?: string) => {
    setLoading(true);
    setError(null);
    setPinError(false);

    try {
      const effectivePin = pinValue ?? sessionStorage.getItem(`portal-pin-${token}`) ?? undefined;
      const isDemo = localStorage.getItem('valiance-demo-mode') === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
      const params = new URLSearchParams();
      if (effectivePin) params.set('pin', effectivePin);
      if (isDemo) params.set('demo', 'true');
      const qs = params.toString();
      const url = `/api/portal/${token}/file/${fileId}${qs ? `?${qs}` : ''}`;

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
        setError('File not found.');
        setLoading(false);
        return;
      }

      if (!res.ok) {
        setError('Something went wrong. Please try again later.');
        setLoading(false);
        return;
      }

      const data: FileInfo = await res.json();
      setFile(data);
      setPinRequired(false);

      if (effectivePin) {
        sessionStorage.setItem(`portal-pin-${token}`, effectivePin);
      }

      if (data.mime_type === 'text/html' && data.file_url && data.file_url !== '#') {
        try {
          const htmlRes = await fetch(data.file_url);
          if (htmlRes.ok) {
            const text = await htmlRes.text();
            setHtmlContent(text);
          }
        } catch {
          // Fall back to iframe src
        }
      }
    } catch {
      setError('Failed to load file. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFile();
  }, [token, fileId]);

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;
    fetchFile(pin);
  };

  /* ── Loading ───────────────────────────────────── */
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <Loader2 className="animate-spin text-brand-600" size={32} />
      </div>
    );
  }

  /* ── Error ─────────────────────────────────────── */
  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm" style={{ animation: 'portalFadeUp 0.5s ease both' }}>
          <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-zinc-100 flex items-center justify-center">
            <AlertCircle size={28} className="text-zinc-400" />
          </div>
          <h1 className="text-xl font-bold text-zinc-900 mb-2">File Unavailable</h1>
          <p className="text-sm text-zinc-500 leading-relaxed mb-5">{error}</p>
          <Link
            href={`/portal/${token}`}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700 transition-colors"
          >
            <ArrowLeft size={14} />
            Back to portal
          </Link>
        </div>
      </div>
    );
  }

  /* ── PIN ────────────────────────────────────────── */
  if (pinRequired) {
    const pinAccent = branding?.accent_color || siteConfig.colors.brand[500];
    return (
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ backgroundColor: pinAccent }}
      >
        <div
          className="fixed inset-0 pointer-events-none"
          style={{ background: ACCENT_DEPTH_GRADIENT }}
        />

        <div className="w-full max-w-sm relative" style={{ animation: 'portalFadeUp 0.5s ease both' }}>
          <div
            className="bg-white rounded-2xl shadow-2xl shadow-black/15 p-8 sm:p-10 text-center"
            style={pinError ? { animation: 'portalShake 0.5s ease' } : undefined}
          >
            {branding?.logo_url ? (
              <img
                src={branding.logo_url}
                alt="Logo"
                className="w-14 h-14 mx-auto mb-5 rounded-xl object-contain"
              />
            ) : (
              <div
                className="w-14 h-14 mx-auto mb-5 rounded-xl flex items-center justify-center text-white text-lg font-bold"
                style={{ backgroundColor: pinAccent }}
              >
                {branding?.project_name?.charAt(0) || <Lock size={22} />}
              </div>
            )}

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
                    : 'border-zinc-200 focus:border-brand-500 focus:ring-4 focus:ring-brand-100 focus:bg-white'
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

  if (!file) return null;

  /* ── File viewer ───────────────────────────────── */
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col" style={{ animation: 'fadeIn 0.3s ease both' }}>
      {/* Header */}
      <header className="bg-white border-b border-zinc-200/80 px-5 sm:px-6 py-3.5 flex items-center gap-3">
        <Link
          href={`/portal/${token}`}
          className="p-1.5 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-all"
        >
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-sm font-semibold text-zinc-900 truncate">{file.name}</h1>
      </header>

      {/* Iframe */}
      <main className="flex-1 flex flex-col">
        {htmlContent ? (
          <iframe
            srcDoc={htmlContent}
            sandbox="allow-scripts allow-same-origin"
            className="flex-1 w-full border-0"
            title={file.name}
          />
        ) : (
          <iframe
            src={file.file_url}
            sandbox="allow-scripts allow-same-origin"
            className="flex-1 w-full border-0"
            title={file.name}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-100 bg-white">
        <div className="px-5 sm:px-6 py-3.5 flex items-center justify-center gap-2">
          <span className="text-xs text-zinc-300 font-medium">Powered by</span>
          <Logo className="h-3.5 w-auto" />
        </div>
      </footer>
    </div>
  );
}
