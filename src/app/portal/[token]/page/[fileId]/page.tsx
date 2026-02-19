'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, AlertCircle, Lock } from 'lucide-react';
import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';

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
      // Try to get PIN from sessionStorage if not provided
      const effectivePin = pinValue ?? sessionStorage.getItem(`portal-pin-${token}`) ?? undefined;
      const isDemo = localStorage.getItem('projectem-demo-mode') === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
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

      // Store PIN on success
      if (effectivePin) {
        sessionStorage.setItem(`portal-pin-${token}`, effectivePin);
      }

      // Fetch HTML content for inline rendering
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

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-zinc-200 border-t-zinc-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-zinc-500">Loading file...</p>
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
          <h1 className="text-lg font-semibold text-zinc-900 mb-2">File Unavailable</h1>
          <p className="text-sm text-zinc-500 mb-4">{error}</p>
          <Link
            href={`/portal/${token}`}
            className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-700"
          >
            <ArrowLeft size={14} />
            Back to portal
          </Link>
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
            {branding?.logo_url ? (
              <img
                src={branding.logo_url}
                alt="Logo"
                className="w-14 h-14 mx-auto mb-4 rounded-xl object-contain"
              />
            ) : (
              <div
                className="w-14 h-14 mx-auto mb-4 rounded-xl flex items-center justify-center text-white text-lg font-bold"
                style={{ backgroundColor: pinAccent }}
              >
                {branding?.project_name?.charAt(0) || <Lock size={24} />}
              </div>
            )}
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

  if (!file) return null;

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-4 sm:px-6 py-3 flex items-center gap-3">
        <Link
          href={`/portal/${token}`}
          className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors"
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
      <footer className="border-t border-zinc-200 bg-white">
        <div className="px-4 sm:px-6 py-3 flex items-center justify-center gap-1.5">
          <span className="text-xs text-zinc-400">Powered by</span>
          <Logo className="h-3.5 w-auto opacity-40" />
        </div>
      </footer>
    </div>
  );
}
