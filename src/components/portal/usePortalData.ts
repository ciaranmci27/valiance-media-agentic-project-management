'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PortalData } from '@/lib/types';
import type { PinInputRef } from '@/components/ui/PinInput';
import { toast } from '@/components/ui/Toast';
import { PORTAL_STEPS, loaderHoldMs } from './loaderSteps';
import { useLoaderPhase } from './useLoaderPhase';

export interface PortalBranding {
  logo_url: string;
  accent_color: string;
  project_name: string;
  welcome_message: string;
}

export type TrackFn = (eventType: string, metadata?: Record<string, unknown>) => void;

const HEARTBEAT_MS = 30_000;

/** The PIN a visitor already validated in this tab, or ''. */
export function getStoredPin(token: string): string {
  try {
    return sessionStorage.getItem(`portal-pin-${token}`) || '';
  } catch {
    return '';
  }
}

/** `?demo=true` when the app is in demo mode, otherwise ''. */
export function portalDemoQuery(): string {
  const isDemo = localStorage.getItem('valiance-demo-mode') === 'true'
    || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
  const params = new URLSearchParams();
  if (isDemo) params.set('demo', 'true');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

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

/**
 * Everything the portal page needs from the network: the single portal
 * fetch, the PIN flow and its sessionStorage memory, analytics tracking
 * (heartbeat while visible, section views via IntersectionObserver on
 * `[data-portal-section]`), and client file uploads.
 */
export function usePortalData(token: string) {
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  // The loader holds and then dissolves after `loading` clears; the page only
  // mounts its content at 'done', so anything that reads the DOM waits for it.
  const { phase, onLeft: onLoaderLeft } = useLoaderPhase(loading, loaderHoldMs(PORTAL_STEPS));
  const [error, setError] = useState<string | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const pinRef = useRef<PinInputRef>(null);
  const [branding, setBranding] = useState<PortalBranding | null>(null);

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
  const track = useCallback<TrackFn>((eventType, metadata = {}) => {
    if (!sessionId.current) return;
    try {
      const storedPin = getStoredPin(token);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-portal-session-id': sessionId.current,
      };
      if (storedPin) headers['x-portal-pin'] = storedPin;
      fetch(`/api/portal/${token}/track${portalDemoQuery()}`, {
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

  const fetchPortal = useCallback(async (pinValue?: string) => {
    if (pinValue) setPinSubmitting(true);
    else setLoading(true);
    setError(null);
    setPinError(false);

    // Reuse a previously validated PIN so a reload doesn't force re-entry
    const effectivePin = pinValue || getStoredPin(token) || undefined;

    try {
      const headers: Record<string, string> = {};
      if (effectivePin) headers['x-portal-pin'] = effectivePin;
      if (sessionId.current) headers['x-portal-session-id'] = sessionId.current;
      const res = await fetch(`/api/portal/${token}${portalDemoQuery()}`, { headers });

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
  }, [token]);

  useEffect(() => {
    fetchPortal();
  }, [fetchPortal]);

  const submitPin = useCallback((value: string) => {
    if (pinSubmitting) return;
    fetchPortal(value);
  }, [pinSubmitting, fetchPortal]);

  const changePin = useCallback((value: string) => {
    setPin(value);
    setPinError(false);
  }, []);

  // Heartbeat: ping while the tab is focused so the dashboard can show
  // "spent 4 minutes here" rather than just "opened it". Skipped on the PIN
  // screen because there's no session to attribute the ping to yet.
  useEffect(() => {
    if (!data || pinRequired) return;
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
  // re-renders don't re-fire events. The sections only exist once the loader
  // has left, so this waits for that rather than for the data alone.
  const firedSectionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!data || pinRequired || phase !== 'done') return;
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
  }, [data, pinRequired, phase, track]);

  // Client uploads land in local state so the list updates without a refetch.
  const [localFiles, setLocalFiles] = useState<PortalData['files']>([]);
  const [fileUploading, setFileUploading] = useState(false);

  useEffect(() => {
    if (data?.files) setLocalFiles(data.files);
  }, [data?.files]);

  const uploadFile = useCallback(async (file: File) => {
    setFileUploading(true);
    try {
      const storedPin = getStoredPin(token);
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
  }, [token]);

  return {
    data,
    loading,
    phase,
    onLoaderLeft,
    error,
    branding,
    pinRequired,
    pin,
    pinError,
    pinSubmitting,
    pinRef,
    changePin,
    submitPin,
    track,
    localFiles,
    fileUploading,
    uploadFile,
  };
}
