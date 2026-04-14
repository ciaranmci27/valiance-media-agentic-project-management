'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Loader2, X as XIcon, RotateCcw } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toast } from '@/components/ui/Toast';
import { useApp } from '@/lib/store';
import type { ClientCommType, ClientCommunication } from '@/lib/types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Slot configuration ──────────────────────────────────────────────────────

interface SlotField {
  key: string;
  label: string;
  kind: 'input' | 'textarea';
  rows?: number;
  hint?: string;
  placeholder?: string;
  optional?: boolean;
}

const SLOT_CONFIGS: Record<ClientCommType, { title: string; fields: SlotField[] }> = {
  portal_welcome: {
    title: 'Portal welcome email',
    fields: [
      { key: 'subject', label: 'Subject', kind: 'input' },
      { key: 'intro_paragraph', label: 'Intro paragraph', kind: 'textarea', rows: 3 },
      { key: 'welcome_message', label: 'Personal welcome (optional)', kind: 'textarea', rows: 3, optional: true },
      { key: 'features_heading', label: 'Features heading', kind: 'input' },
      { key: 'closing_note', label: 'Closing note (optional)', kind: 'textarea', rows: 2, optional: true },
    ],
  },
  project_summary: {
    title: 'Project summary email',
    fields: [
      { key: 'subject', label: 'Subject', kind: 'input' },
      { key: 'opening_line', label: 'Opening line', kind: 'textarea', rows: 2 },
      { key: 'custom_paragraph', label: 'Custom paragraph (optional)', kind: 'textarea', rows: 3, optional: true },
      { key: 'closing_line', label: 'Closing line', kind: 'input' },
    ],
  },
  budget_threshold: {
    title: 'Budget threshold alert',
    fields: [
      { key: 'subject', label: 'Subject', kind: 'input' },
      { key: 'alert_paragraph', label: 'Alert paragraph', kind: 'textarea', rows: 3 },
      { key: 'closing_line', label: 'Closing line', kind: 'input' },
    ],
  },
  dollar_interval: {
    title: 'Dollar interval alert',
    fields: [
      { key: 'subject', label: 'Subject', kind: 'input' },
      { key: 'alert_paragraph', label: 'Alert paragraph', kind: 'textarea', rows: 3 },
      { key: 'closing_line', label: 'Closing line', kind: 'input' },
    ],
  },
  budget_extended: {
    title: 'Budget update email',
    fields: [
      { key: 'subject', label: 'Subject', kind: 'input' },
      { key: 'alert_paragraph', label: 'Alert paragraph', kind: 'textarea', rows: 3 },
      { key: 'closing_line', label: 'Closing line', kind: 'input' },
    ],
  },
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RenderContext {
  thresholdPct?: number;
  milestone?: number;
  oldBudget?: number;
  newBudget?: number;
  oldBudgetType?: 'hours' | 'amount';
  newBudgetType?: 'hours' | 'amount';
}

interface PreviewResult {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  defaults: Record<string, string>;
  metadata: Record<string, any>;
}

export interface ClientEmailPreviewModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Manual send (triggered from Communications tab) */
  manual?: {
    type: ClientCommType;
    context?: RenderContext;
  };
  /** Pending approval (from the log) */
  pending?: ClientCommunication;
  /** Read-only preview of a past (sent / failed / dismissed) communication */
  readonlyComm?: ClientCommunication;
  onCompleted?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function contextFromPending(pending: ClientCommunication): RenderContext {
  const meta = pending.metadata || {};
  const oldT = meta.oldBudgetType;
  const newT = meta.newBudgetType;
  return {
    thresholdPct: typeof meta.threshold === 'number' ? meta.threshold : undefined,
    milestone: typeof meta.milestone === 'number' ? meta.milestone : undefined,
    oldBudget: typeof meta.oldBudget === 'number' ? meta.oldBudget : undefined,
    newBudget: typeof meta.newBudget === 'number' ? meta.newBudget : undefined,
    oldBudgetType: oldT === 'hours' || oldT === 'amount' ? oldT : undefined,
    newBudgetType: newT === 'hours' || newT === 'amount' ? newT : undefined,
  };
}

// ─── Modal ───────────────────────────────────────────────────────────────────

export default function ClientEmailPreviewModal(props: ClientEmailPreviewModalProps) {
  const { open, onClose, projectId, manual, pending, readonlyComm, onCompleted } = props;
  const { getContactsByProject } = useApp();

  const mode: 'manual' | 'pending' | 'readonly' = readonlyComm
    ? 'readonly'
    : pending
      ? 'pending'
      : 'manual';
  const type = (readonlyComm?.notification_type ?? pending?.notification_type ?? manual?.type) as
    | ClientCommType
    | undefined;
  const context = useMemo<RenderContext>(() => {
    if (readonlyComm) return contextFromPending(readonlyComm);
    if (pending) return contextFromPending(pending);
    return manual?.context || {};
  }, [readonlyComm, pending, manual?.context]);

  const config = type ? SLOT_CONFIGS[type] : null;

  const contactOptions = useMemo<ContactOption[]>(() => {
    return getContactsByProject(projectId)
      .map(pc => pc.contact)
      .filter((c): c is NonNullable<typeof c> => !!(c && c.email))
      .map(c => ({ email: c.email, name: c.name }));
  }, [getContactsByProject, projectId]);

  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const seededRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const recipientsSeededRef = useRef(false);

  // Reset state when modal (re)opens
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      recipientsSeededRef.current = false;
      setOverrides({});
      setPreview(null);
      setError(null);
      setSubmitting(false);
      setTo([]);
      setCc([]);
      setBcc([]);
      setShowCc(false);
      setShowBcc(false);
      return;
    }
    // Seed overrides from pending.slot_overrides only when the reviewer has
    // actually customized fields. Automated enqueues store an empty {} which
    // must fall through so the server-rendered defaults populate the inputs.
    const pendingOverrides = pending?.slot_overrides as Record<string, string> | undefined;
    if (pendingOverrides && Object.keys(pendingOverrides).length > 0 && !seededRef.current) {
      setOverrides({ ...pendingOverrides });
      seededRef.current = true;
    }
    // Seed recipients from pending.recipients if present
    if (pending?.recipients && !recipientsSeededRef.current) {
      const r = pending.recipients;
      if (r.to?.length) setTo(r.to);
      if (r.cc?.length) { setCc(r.cc); setShowCc(true); }
      if (r.bcc?.length) { setBcc(r.bcc); setShowBcc(true); }
      recipientsSeededRef.current = true;
    }
  }, [open, pending]);

  const runPreview = useCallback(async (nextOverrides: Record<string, string>) => {
    if (!type) return;
    setLoadingPreview(true);
    setError(null);
    try {
      const recipientsPayload = (to.length || cc.length || bcc.length)
        ? { to, cc, bcc }
        : undefined;
      const res = await fetch(`/api/projects/${projectId}/client-communications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'preview',
          type,
          slotOverrides: nextOverrides,
          context,
          recipients: recipientsPayload,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Preview failed');
        setPreview(null);
      } else {
        setPreview(data as PreviewResult);
        // Seed overrides with defaults on first successful preview
        if (!seededRef.current && data.defaults) {
          setOverrides({ ...(data.defaults as Record<string, string>) });
          seededRef.current = true;
        }
        // Adopt server's default recipients on first preview if we have none yet
        if (!recipientsSeededRef.current && Array.isArray(data.to) && data.to.length) {
          setTo(data.to);
          recipientsSeededRef.current = true;
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Preview failed');
      setPreview(null);
    } finally {
      setLoadingPreview(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, type, context]);

  // Initial preview when modal opens. In readonly mode we don't call the
  // preview API; the stored row already contains the exact subject and HTML
  // that was sent (or attempted), so we seed the preview state from it and
  // populate the recipient display from the stored row.
  useEffect(() => {
    if (!open || !type) return;
    if (readonlyComm) {
      setPreview({
        to: readonlyComm.recipients?.to || [],
        cc: readonlyComm.recipients?.cc || [],
        bcc: readonlyComm.recipients?.bcc || [],
        subject: readonlyComm.subject || '',
        html: readonlyComm.rendered_html || '',
        text: (readonlyComm as any).rendered_text || '',
        defaults: {},
        metadata: readonlyComm.metadata || {},
      });
      if (readonlyComm.recipients?.to?.length) setTo(readonlyComm.recipients.to);
      if (readonlyComm.recipients?.cc?.length) setCc(readonlyComm.recipients.cc);
      if (readonlyComm.recipients?.bcc?.length) setBcc(readonlyComm.recipients.bcc);
      return;
    }
    runPreview(pending?.slot_overrides ? (pending.slot_overrides as Record<string, string>) : {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type]);

  // Debounced re-render when overrides change. Skipped in readonly mode
  // (there is no editor pane, so overrides can't change).
  useEffect(() => {
    if (!open || !seededRef.current || readonlyComm) return;
    const h = setTimeout(() => runPreview(overrides), 400);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides]);

  // Paint preview HTML imperatively into the iframe. First paint does a full
  // document.write; subsequent paints swap only <body> innerHTML so the
  // browser doesn't navigate, doesn't flash white, and keeps scroll position.
  useEffect(() => {
    if (!preview || !iframeRef.current) return;
    const doc = iframeRef.current.contentDocument;
    if (!doc) return;

    const hasContent = !!doc.body && doc.body.children.length > 0;

    if (!hasContent) {
      doc.open();
      doc.write(preview.html);
      doc.close();
      return;
    }

    try {
      const parsed = new DOMParser().parseFromString(preview.html, 'text/html');
      // Sync head only when it actually changed (rare; keeps text-only edits cheap).
      if (parsed.head.innerHTML !== doc.head.innerHTML) {
        doc.head.innerHTML = parsed.head.innerHTML;
      }
      doc.body.innerHTML = parsed.body.innerHTML;
    } catch {
      // Fallback: full rewrite if parsing/swap fails for any reason.
      doc.open();
      doc.write(preview.html);
      doc.close();
    }
  }, [preview]);

  const handleSlotChange = (key: string, value: string) => {
    setOverrides(prev => ({ ...prev, [key]: value }));
  };

  const resetSlot = (key: string) => {
    if (!preview?.defaults) return;
    setOverrides(prev => ({ ...prev, [key]: preview.defaults[key] ?? '' }));
  };

  const handleSend = async () => {
    if (!type) return;
    if (to.length === 0) {
      toast('error', 'Add at least one recipient');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-communications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          type,
          slotOverrides: overrides,
          context,
          recipients: { to, cc, bcc },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast('error', data.error || 'Failed to send email');
      } else {
        toast('success', 'Email sent to client');
        onCompleted?.();
        onClose();
      }
    } catch (err: any) {
      toast('error', err?.message || 'Failed to send email');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApprove = async () => {
    if (!pending) return;
    if (to.length === 0) {
      toast('error', 'Add at least one recipient');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-communications/${pending.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          slotOverrides: overrides,
          recipients: { to, cc, bcc },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast('error', data.error || 'Failed to approve');
      } else {
        toast('success', 'Email approved and sent');
        onCompleted?.();
        onClose();
      }
    } catch (err: any) {
      toast('error', err?.message || 'Failed to approve');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDismiss = async () => {
    if (!pending) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-communications/${pending.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss' }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast('error', data.error || 'Failed to dismiss');
      } else {
        toast('success', 'Pending email dismissed');
        onCompleted?.();
        onClose();
      }
    } catch (err: any) {
      toast('error', err?.message || 'Failed to dismiss');
    } finally {
      setSubmitting(false);
    }
  };

  if (!type || !config) return null;

  const modalTitle =
    mode === 'readonly'
      ? `Preview: ${config.title}`
      : mode === 'pending'
        ? `Review: ${config.title}`
        : config.title;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={modalTitle}
      size="full"
    >
      {error && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      <div
        className={
          mode === 'readonly'
            ? 'grid grid-cols-1 gap-4'
            : 'grid grid-cols-1 gap-4 lg:grid-cols-2'
        }
      >
        {/* Left: slot editors + meta. Hidden in readonly mode — the sent
            email is immutable, so there's nothing to edit. */}
        {mode !== 'readonly' && (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 space-y-2">
            <RecipientRow
              label="To"
              value={to}
              onChange={setTo}
              contactOptions={contactOptions}
              excludeEmails={[...cc, ...bcc]}
              disabled={submitting}
            />
            {showCc ? (
              <RecipientRow
                label="Cc"
                value={cc}
                onChange={setCc}
                contactOptions={contactOptions}
                excludeEmails={[...to, ...bcc]}
                disabled={submitting}
                onRemove={() => { setCc([]); setShowCc(false); }}
              />
            ) : null}
            {showBcc ? (
              <RecipientRow
                label="Bcc"
                value={bcc}
                onChange={setBcc}
                contactOptions={contactOptions}
                excludeEmails={[...to, ...cc]}
                disabled={submitting}
                onRemove={() => { setBcc([]); setShowBcc(false); }}
              />
            ) : null}
            {(!showCc || !showBcc) && (
              <div className="flex items-center gap-3 pl-10 text-[11px]">
                {!showCc && (
                  <button
                    type="button"
                    onClick={() => setShowCc(true)}
                    className="text-zinc-500 hover:text-brand-600 transition-colors"
                    disabled={submitting}
                  >
                    + Add Cc
                  </button>
                )}
                {!showBcc && (
                  <button
                    type="button"
                    onClick={() => setShowBcc(true)}
                    className="text-zinc-500 hover:text-brand-600 transition-colors"
                    disabled={submitting}
                  >
                    + Add Bcc
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            {config.fields.map(field => (
              <SlotEditor
                key={field.key}
                field={field}
                value={overrides[field.key] ?? ''}
                defaultValue={preview?.defaults?.[field.key] ?? ''}
                onChange={v => handleSlotChange(field.key, v)}
                onReset={() => resetSlot(field.key)}
                disabled={submitting}
              />
            ))}
          </div>
        </div>
        )}

        {/* Right: live preview */}
        <div className="flex min-h-[520px] flex-col rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950">
          {mode === 'readonly' && readonlyComm && (
            <div className="border-b border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 space-y-1">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <span className="text-zinc-400">To</span>
                <span className="text-zinc-700 dark:text-zinc-200 break-all">
                  {(readonlyComm.recipients?.to || []).join(', ') || 'unknown'}
                </span>
              </div>
              {(readonlyComm.recipients?.cc?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <span className="text-zinc-400">Cc</span>
                  <span className="text-zinc-700 dark:text-zinc-200 break-all">
                    {(readonlyComm.recipients!.cc as string[]).join(', ')}
                  </span>
                </div>
              )}
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <span className="text-zinc-400">Subject</span>
                <span className="text-zinc-700 dark:text-zinc-200">
                  {readonlyComm.subject || '(no subject)'}
                </span>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
            <span>Preview</span>
            {loadingPreview && (
              <span className="flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" />
                Rendering
              </span>
            )}
          </div>
          <div className="flex-1 overflow-hidden p-2">
            {preview ? (
              <iframe
                ref={iframeRef}
                title="Email preview"
                className="h-full min-h-[480px] w-full rounded-md border border-zinc-200 bg-white dark:border-zinc-700"
                // allow-same-origin lets us write the new HTML into the same
                // document instead of navigating, which avoids the white flash
                // and preserves scroll. allow-scripts is intentionally omitted
                // so email HTML still cannot execute any JS.
                sandbox="allow-same-origin"
              />
            ) : (
              <div className="flex h-full min-h-[480px] items-center justify-center text-sm text-zinc-500">
                {loadingPreview ? 'Loading preview...' : error ? 'Preview unavailable' : ''}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer actions */}
      <div className="mt-5 flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
        {mode === 'readonly' ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : mode === 'pending' ? (
          <>
            <Button
              variant="secondary"
              onClick={handleDismiss}
              disabled={submitting}
              icon={<XIcon size={14} />}
            >
              Dismiss
            </Button>
            <Button
              variant="primary"
              onClick={handleApprove}
              disabled={submitting || loadingPreview || !preview}
              icon={submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            >
              {submitting ? 'Sending...' : 'Send email'}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={submitting || loadingPreview || !preview}
            icon={submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          >
            {submitting ? 'Sending...' : 'Send email'}
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ─── RecipientRow ────────────────────────────────────────────────────────────

interface ContactOption {
  email: string;
  name: string;
}

interface RecipientRowProps {
  label: 'To' | 'Cc' | 'Bcc';
  value: string[];
  onChange: (next: string[]) => void;
  contactOptions: ContactOption[];
  excludeEmails?: string[];
  disabled?: boolean;
  onRemove?: () => void;
}

function RecipientRow({ label, value, onChange, contactOptions, excludeEmails, disabled, onRemove }: RecipientRowProps) {
  const [input, setInput] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  const lookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of contactOptions) m.set(c.email.toLowerCase(), c.name);
    return m;
  }, [contactOptions]);

  const excludeSet = useMemo(
    () => new Set((excludeEmails || []).map(e => e.toLowerCase())),
    [excludeEmails],
  );

  const normInput = input.trim().toLowerCase();
  const available = useMemo(() => {
    const selected = new Set(value.map(v => v.toLowerCase()));
    return contactOptions
      .filter(c => {
        const key = c.email.toLowerCase();
        return !selected.has(key) && !excludeSet.has(key);
      })
      .filter(c => {
        if (!normInput) return true;
        return c.name.toLowerCase().includes(normInput) || c.email.toLowerCase().includes(normInput);
      });
  }, [contactOptions, value, normInput, excludeSet]);

  const addEmail = useCallback((email: string) => {
    const clean = email.trim();
    if (!clean || !EMAIL_RE.test(clean)) return false;
    const key = clean.toLowerCase();
    if (excludeSet.has(key)) {
      setInput('');
      return false;
    }
    if (value.some(v => v.toLowerCase() === key)) {
      setInput('');
      return true;
    }
    onChange([...value, clean]);
    setInput('');
    setHighlighted(0);
    return true;
  }, [value, onChange, excludeSet]);

  const removePill = (email: string) => {
    onChange(value.filter(v => v !== email));
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (showDropdown && available.length > 0 && highlighted < available.length && input) {
        e.preventDefault();
        addEmail(available[highlighted].email);
        return;
      }
      if (input.trim()) {
        e.preventDefault();
        addEmail(input);
      }
    } else if (e.key === 'Backspace' && !input && value.length > 0) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'ArrowDown' && available.length > 0) {
      e.preventDefault();
      setShowDropdown(true);
      setHighlighted(h => Math.min(h + 1, available.length - 1));
    } else if (e.key === 'ArrowUp' && available.length > 0) {
      e.preventDefault();
      setHighlighted(h => Math.max(h - 1, 0));
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  };

  return (
    <div className="flex items-start gap-2">
      <span className="mt-1.5 w-7 flex-shrink-0 text-[11px] font-medium text-zinc-500 uppercase tracking-wide">{label}</span>
      <div className="flex-1 min-w-0 min-h-[30px] rounded-md border border-zinc-200 bg-white px-1.5 py-1 flex flex-wrap items-center gap-1 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 transition-colors">
        {value.map(email => {
          const name = lookup.get(email.toLowerCase());
          return (
            <span key={email} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-brand-50 border border-brand-200 text-brand-700 text-[11px] font-medium max-w-full">
              <span className="truncate">{name ? `${name} <${email}>` : email}</span>
              <button
                type="button"
                onClick={() => removePill(email)}
                className="text-brand-400 hover:text-red-500 transition-colors flex-shrink-0"
                aria-label={`Remove ${email}`}
                disabled={disabled}
              >
                <XIcon size={10} />
              </button>
            </span>
          );
        })}
        <div className="relative flex-1 min-w-[120px]">
          <input
            type="text"
            value={input}
            onChange={e => { setInput(e.target.value); setShowDropdown(true); setHighlighted(0); }}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            onKeyDown={handleKey}
            placeholder={value.length === 0 ? 'Add recipient...' : ''}
            disabled={disabled}
            className="w-full text-xs px-1 py-0.5 bg-transparent outline-none placeholder:text-zinc-400"
          />
          {showDropdown && available.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-white border border-zinc-200 rounded-md shadow-lg max-h-48 overflow-auto">
              {available.map((c, i) => (
                <button
                  key={c.email}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); addEmail(c.email); }}
                  onMouseEnter={() => setHighlighted(i)}
                  className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center justify-between gap-2 transition-colors ${
                    i === highlighted ? 'bg-brand-50' : 'hover:bg-zinc-50'
                  }`}
                >
                  <span className="font-medium text-zinc-800 truncate">{c.name}</span>
                  <span className="text-zinc-500 truncate">{c.email}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="h-[30px] flex items-center text-zinc-400 hover:text-red-500 transition-colors flex-shrink-0"
          aria-label={`Remove ${label} row`}
          disabled={disabled}
        >
          <XIcon size={14} />
        </button>
      )}
    </div>
  );
}

// ─── SlotEditor ──────────────────────────────────────────────────────────────

interface SlotEditorProps {
  field: SlotField;
  value: string;
  defaultValue: string;
  onChange: (v: string) => void;
  onReset: () => void;
  disabled?: boolean;
}

function SlotEditor({ field, value, defaultValue, onChange, onReset, disabled }: SlotEditorProps) {
  const dirty = defaultValue !== undefined && value !== defaultValue;
  const labelRow = (
    <div className="mb-1 flex items-center justify-between">
      <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {field.label}
      </label>
      {dirty && (
        <button
          type="button"
          onClick={onReset}
          className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          disabled={disabled}
        >
          <RotateCcw size={10} />
          Reset
        </button>
      )}
    </div>
  );

  return (
    <div>
      {labelRow}
      {field.kind === 'textarea' ? (
        <Textarea
          value={value}
          onChange={onChange}
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
          disabled={disabled}
          size="sm"
          autoResize
        />
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          placeholder={field.placeholder}
          disabled={disabled}
          size="sm"
        />
      )}
    </div>
  );
}
