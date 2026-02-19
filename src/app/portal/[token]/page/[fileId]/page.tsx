'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, AlertCircle, Lock } from 'lucide-react';
import Link from 'next/link';

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
          <svg viewBox="8.36 17.58 283.3 237.13" xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-auto" aria-label="ProjectEM">
            <g fill="currentColor" className="text-zinc-400">
              <path d="M150 32.58c37.6 0 69.34 24.4 75.83 56.87h-.14v15h18.43l-.55-7.96c-3.05-44.25-44.15-78.91-93.58-78.91S59.46 52.25 56.42 96.49l-.55 7.96h18.42V89.83c0-.14.02-.26.04-.38h-.16C80.66 56.98 112.4 32.58 150 32.58" />
              <path d="M129.73 129.3c-2.63-9.26-7.25-17.38-13.48-23.94-11.08-11.73-27.23-18.62-46.39-18.62-35.77 0-61.5 24.11-61.5 61.76v95.1c0 6.14 4.97 11.11 11.11 11.11s11.11-4.97 11.11-11.11v-32.2c0-8.51 9.2-13.91 16.57-9.67 7.6 4.37 16.66 6.69 26.48 6.69 30.18 0 58.71-21.77 58.71-60.14 0-6.73-.88-13.09-2.6-18.97Zm-59.62 58.52c-23.65 0-39.54-16.83-39.54-40.22s15.89-40.25 39.54-40.25 39.77 16.83 39.77 40.25-15.92 40.22-39.77 40.22" />
              <path d="M291.65 139.99v103.73c0 6.07-4.92 10.99-10.99 10.99h-.24c-6.07 0-10.99-4.92-10.99-10.99V139.99c0-21.54-11.47-31.12-27.62-31.12s-27.39 10.07-27.39 31.12v55.91c0 6.07-4.92 10.99-10.99 10.99h-.24c-6.07 0-10.99-4.92-10.99-10.99v-55.91c0-21.05-11.92-31.12-27.58-31.12-13.19 0-23.2 6.4-26.45 20.44-2.63-9.26-7.25-17.38-13.48-23.94 8.58-11.53 22.06-17.09 37.82-17.09 13.08 0 24.65 4.31 33.01 12.56 4.26 4.2 11.13 4.18 15.38-.03 8.31-8.23 19.77-12.53 33.03-12.53 27.13 0 47.73 16.37 47.73 51.72Z" />
              <path d="M83.67 147.58c0 7.428-6.022 13.45-13.45 13.45s-13.45-6.022-13.45-13.45 6.022-13.45 13.45-13.45 13.45 6.022 13.45 13.45" />
            </g>
          </svg>
        </div>
      </footer>
    </div>
  );
}
