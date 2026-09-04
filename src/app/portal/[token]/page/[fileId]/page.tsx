'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import type { PinInputRef } from '@/components/ui/PinInput';
import { PinGate } from '@/components/portal/PinGate';
import { PortalRoot } from '@/components/portal/PortalShell';
import { PortalError, PortalLoading } from '@/components/portal/PortalStates';
import { describeMime } from '@/components/portal/format';
import { useLoaderPhase } from '@/components/portal/useLoaderPhase';
import { getStoredPin, portalDemoQuery } from '@/components/portal/usePortalData';

interface FileInfo {
  file_url: string;
  name: string;
  mime_type: string;
}

interface FileBranding {
  logo_url: string;
  accent_color: string;
  project_name: string;
}

export default function PortalFilePage() {
  const params = useParams();
  // The API lowercases the token too; doing it here keeps the sessionStorage
  // PIN key identical to the one the portal page writes.
  const token = (params.token as string).toLowerCase();
  const fileId = params.fileId as string;

  const [file, setFile] = useState<FileInfo | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { phase, onLeft: onLoaderLeft } = useLoaderPhase(loading);
  const [error, setError] = useState<string | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const pinRef = useRef<PinInputRef>(null);
  const [branding, setBranding] = useState<FileBranding | null>(null);

  const fetchFile = useCallback(async (pinValue?: string) => {
    if (pinValue) setPinSubmitting(true);
    else setLoading(true);
    setError(null);
    setPinError(false);

    try {
      const effectivePin = pinValue || getStoredPin(token) || undefined;
      const url = `/api/portal/${token}/file/${fileId}${portalDemoQuery()}`;

      // PIN travels in a header (like the rest of the portal), never in the
      // URL where it would leak into logs and browser history
      const headers: Record<string, string> = {};
      if (effectivePin) headers['x-portal-pin'] = effectivePin;
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
          return;
        }
      }

      if (res.status === 404) {
        setError('File not found.');
        return;
      }

      if (!res.ok) {
        setError('Something went wrong. Please try again later.');
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
      setPinSubmitting(false);
    }
  }, [token, fileId]);

  useEffect(() => {
    fetchFile();
  }, [fetchFile]);

  const submitPin = (value: string) => {
    if (pinSubmitting) return;
    fetchFile(value);
  };

  if (phase !== 'done') {
    return <PortalLoading leaving={phase === 'leaving'} onLeft={onLoaderLeft} label="Opening your file" />;
  }

  if (error) {
    return (
      <PortalError
        title="File unavailable"
        message={error}
        backHref={`/portal/${token}`}
      />
    );
  }

  if (pinRequired) {
    return (
      <PinGate
        projectName={branding?.project_name}
        logoUrl={branding?.logo_url || undefined}
        pin={pin}
        onChange={(value) => { setPin(value); setPinError(false); }}
        onComplete={submitPin}
        error={pinError}
        submitting={pinSubmitting}
        pinRef={pinRef}
      />
    );
  }

  if (!file) return null;

  return (
    <PortalRoot>
      <header className="vm-glass-strong sticky top-0 z-10 flex items-center gap-3 border-x-0 border-t-0 px-4 py-3 sm:px-6">
        <Link href={`/portal/${token}`} aria-label="Back to portal" className="vm-icon-btn shrink-0">
          <ArrowLeft size={18} aria-hidden="true" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-medium">{file.name}</h1>
          <p className="vm-mono vm-faint text-[11px] uppercase tracking-[0.14em]">{describeMime(file.mime_type)}</p>
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        {htmlContent ? (
          <iframe
            srcDoc={htmlContent}
            sandbox="allow-scripts"
            className="w-full flex-1 border-0 bg-white"
            title={file.name}
          />
        ) : (
          <iframe
            src={file.file_url}
            sandbox="allow-scripts"
            className="w-full flex-1 border-0 bg-white"
            title={file.name}
          />
        )}
      </main>

      <footer className="flex items-center justify-center gap-2.5 border-t border-(--vm-line) px-5 py-3.5">
        <span className="vm-mono vm-faint text-[11px] uppercase tracking-[0.14em]">Prepared by</span>
        <Logo variant="dark" className="h-4 w-auto" />
      </footer>
    </PortalRoot>
  );
}
