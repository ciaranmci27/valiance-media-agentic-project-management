'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Download, Loader2, FileText, Settings, RotateCcw } from 'lucide-react';
import type { InvoicePdfData, InvoicePdfOptions, InvoicePdfTheme } from '@/lib/invoice-pdf/types';
import { DEFAULT_INVOICE_PDF_OPTIONS } from '@/lib/invoice-pdf/types';

// React-PDF and pdfjs are heavy. Load them on demand so callers don't pay
// the cost until someone actually opens a preview.
type PdfModule = typeof import('@react-pdf/renderer');
type DocModule = typeof import('@/lib/invoice-pdf/InvoiceDocument');
type PreviewModule = typeof import('@/components/invoice-pdf/PdfPagesPreview');

interface CustomizerProps {
  options: InvoicePdfOptions;
  toggleOption: (key: keyof InvoicePdfOptions) => void;
  resetOptions: () => void;
}

/* Two chrome variants. 'themed' follows the app theme (dark glass chrome in
   dark mode, flipped to white by the light remap). 'light' keeps the literal
   white chrome for the always-light client portal, whose data-theme="dark"
   pin would otherwise resolve theme tokens to their dark values. */
export type ChromeAppearance = 'themed' | 'light';

const CHROME: Record<ChromeAppearance, {
  shell: string;
  headerBorder: string;
  title: string;
  customizeActive: string;
  customizeIdle: string;
  closeBtn: string;
  panel: string;
  panelDivider: string;
  panelHeading: string;
  panelReset: string;
  row: string;
  rowLabel: string;
  trackOff: string;
  knob: string;
  body: string;
  footer: string;
  errorCard: string;
  errorTitle: string;
  errorBody: string;
  errorFoot: string;
}> = {
  themed: {
    shell: 'bg-surface-overlay border border-white/[0.08] shadow-overlay',
    headerBorder: 'border-white/[0.08]',
    title: 'text-white',
    customizeActive: 'bg-white/[0.08] text-white',
    customizeIdle: 'text-zinc-400 hover:text-zinc-300 hover:bg-white/[0.06]',
    closeBtn: 'text-zinc-400 hover:text-zinc-300 hover:bg-white/[0.06]',
    panel: 'bg-surface-overlay border border-white/[0.08] shadow-overlay',
    panelDivider: 'border-white/[0.06]',
    panelHeading: 'text-zinc-200',
    panelReset: 'text-zinc-400 hover:text-brand-300',
    row: 'hover:bg-white/[0.03]',
    rowLabel: 'text-zinc-200',
    trackOff: 'bg-white/[0.08]',
    knob: 'bg-surface-raised shadow-sm',
    body: 'bg-surface',
    footer: 'border-white/[0.06] text-zinc-500',
    errorCard: 'border-red-500/30 bg-red-500/15',
    errorTitle: 'text-red-300',
    errorBody: 'text-red-300',
    errorFoot: 'text-red-400',
  },
  light: {
    shell: 'bg-white shadow-2xl',
    headerBorder: 'border-zinc-200',
    title: 'text-zinc-900',
    customizeActive: 'bg-zinc-100 text-zinc-900',
    customizeIdle: 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100',
    closeBtn: 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100',
    panel: 'bg-white border border-zinc-200 shadow-xl',
    panelDivider: 'border-zinc-100',
    panelHeading: 'text-zinc-700',
    panelReset: 'text-zinc-500 hover:text-brand-600',
    row: 'hover:bg-zinc-50',
    rowLabel: 'text-zinc-800',
    trackOff: 'bg-zinc-200',
    knob: 'bg-white',
    body: 'bg-zinc-100',
    footer: 'border-zinc-100 text-zinc-400',
    errorCard: 'border-red-200 bg-red-50',
    errorTitle: 'text-red-800',
    errorBody: 'text-red-700',
    errorFoot: 'text-red-600',
  },
};

interface InvoicePreviewModalViewProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-built PDF data. Pass null while still loading. */
  pdfData: InvoicePdfData | null;
  /** Blocks preview and download when billing facts fail integrity validation. */
  integrityError?: string | null;
  /** Header label and filename input. */
  invoiceNumber: string;
  /** Used in the download filename. */
  clientLabel: string;
  /** Used in the download filename (YYYY-MM-DD). */
  invoiceDate: string;
  /** Optional customizer panel. When provided, the Customize button is shown. */
  customizer?: CustomizerProps;
  /** Fires when the user clicks Download PDF. Used by the portal page to
   *  emit an analytics event; admin usage leaves this unset. */
  onDownload?: () => void;
  /** 'themed' (default) follows the app theme; the portal passes 'light'. */
  appearance?: ChromeAppearance;
}

const TOGGLE_DEFINITIONS: { key: keyof InvoicePdfOptions; label: string; description: string }[] = [
  { key: 'showLogo',                label: 'Logo',                 description: 'Show the brand logo in the header.' },
  { key: 'showStatusStamp',         label: 'Status stamp',         description: 'Letter-spaced PAID / OVERDUE / CANCELLED stamp.' },
  { key: 'showSenderName',          label: 'Sender name',          description: 'Your name underneath the business in “From”.' },
  { key: 'showLineCaptions',        label: 'Line item captions',   description: 'Service period and frequency under each line item.' },
  { key: 'showPortalLink',          label: 'Client portal link',   description: 'Callout linking to the project portal (only shown when enabled).' },
  { key: 'showNotes',               label: 'Notes',                description: 'Per-invoice notes block.' },
  { key: 'showPaymentInstructions', label: 'Payment instructions', description: 'Payment instructions block from Business Info.' },
  { key: 'showFooter',              label: 'Footer',               description: 'Page numbers, business name, and generated date.' },
  { key: 'showTimeLogs',            label: 'Time log page',        description: 'Append a second page listing the time entries that back the hourly line items.' },
];

/** The two editions a download can be: the dark canvas on screen, or white for paper. */
const EDITIONS: { theme: InvoicePdfTheme; label: string; description: string }[] = [
  { theme: 'dark', label: 'Dark', description: 'As shown on screen.' },
  { theme: 'paper', label: 'Light', description: 'On white, for printing and filing.' },
];

function sanitizeForFilename(input: string): string {
  return input.replace(/[^a-z0-9\-_.]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/** Hand a blob URL to the browser as a file download. */
function saveBlobUrl(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function InvoicePreviewModalView({
  isOpen,
  onClose,
  pdfData,
  integrityError,
  invoiceNumber,
  clientLabel,
  invoiceDate,
  customizer,
  onDownload,
  appearance = 'themed',
}: InvoicePreviewModalViewProps) {
  const chrome = CHROME[appearance];
  const overlayRef = useRef<HTMLDivElement>(null);
  const customizeButtonRef = useRef<HTMLDivElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const downloadButtonRef = useRef<HTMLDivElement>(null);
  const downloadMenuRef = useRef<HTMLDivElement>(null);

  const [pdfLib, setPdfLib] = useState<PdfModule | null>(null);
  const [docLib, setDocLib] = useState<DocModule | null>(null);
  const [previewLib, setPreviewLib] = useState<PreviewModule | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** Which edition is being generated for download, or null when idle. */
  const [downloading, setDownloading] = useState<InvoicePdfTheme | null>(null);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Memoize the document JSX. Without this, every parent re-render creates a
  // fresh element and triggers a costly PDF rebuild (visible flicker).
  const documentNode = useMemo(() => {
    if (!docLib || !pdfData) return null;
    return <docLib.InvoiceDocument data={pdfData} />;
  }, [docLib, pdfData]);

  // Lazy-load PDF runtime when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    Promise.all([
      import('@react-pdf/renderer'),
      import('@/lib/invoice-pdf/InvoiceDocument'),
      import('@/components/invoice-pdf/PdfPagesPreview'),
    ]).then(([pdf, doc, preview]) => {
      if (cancelled) return;
      setPdfLib(pdf);
      setDocLib(doc);
      setPreviewLib(preview);
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  // Render the document to a blob URL so the canvas-based PdfPagesPreview can
  // load it. Regenerates whenever documentNode changes (e.g. user toggles a
  // customizer option). The previous URL is kept alive until the new blob is
  // ready so the on-screen pages don't flash to a loading state mid-toggle.
  // We deliberately don't revoke the in-flight URL on cleanup: pdfjs may still
  // be loading the blob, and we'd rather leak briefly until it gets replaced
  // (next blob ready) or the modal unmounts than break a mid-load fetch.
  useEffect(() => {
    if (!pdfLib || !documentNode) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;

    pdfLib.pdf(documentNode).toBlob().then((blob: Blob) => {
      if (cancelled) return;
      const newUrl = URL.createObjectURL(blob);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return newUrl;
      });
    });

    return () => { cancelled = true; };
  }, [pdfLib, documentNode]);

  // Final cleanup: revoke the lingering URL when the modal unmounts.
  // Empty deps so it only fires once at unmount.
  useEffect(() => {
    return () => {
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  // Body scroll lock — independent of any nested popover state.
  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = 'unset'; };
  }, [isOpen]);

  // Esc closes an open dropdown first, then the modal.
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (downloadMenuOpen) setDownloadMenuOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, settingsOpen, downloadMenuOpen]);

  // Click outside the download menu closes it (without closing the modal).
  useEffect(() => {
    if (!downloadMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !downloadMenuRef.current?.contains(target) &&
        !downloadButtonRef.current?.contains(target)
      ) {
        setDownloadMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [downloadMenuOpen]);

  // Click outside the dropdown closes it (without closing the modal).
  useEffect(() => {
    if (!settingsOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !settingsPanelRef.current?.contains(target) &&
        !customizeButtonRef.current?.contains(target)
      ) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsOpen]);

  const baseFilename = `${sanitizeForFilename(invoiceNumber)}_${sanitizeForFilename(clientLabel)}_${invoiceDate}`;

  // One download, two editions. Dark is the one on screen, so the preview blob
  // is reused when it is ready; light is the same invoice on white for anyone
  // who prints or files a paper copy, rendered on demand.
  const downloadEdition = async (theme: InvoicePdfTheme) => {
    if (!pdfData || !pdfLib || !docLib) return;
    setDownloadMenuOpen(false);
    setDownloading(theme);
    onDownload?.();
    try {
      let url = theme === 'dark' ? previewUrl : null;
      let createdHere = false;
      if (!url) {
        const blob = await pdfLib.pdf(<docLib.InvoiceDocument data={pdfData} theme={theme} />).toBlob();
        url = URL.createObjectURL(blob);
        createdHere = true;
      }
      saveBlobUrl(url, `${baseFilename}${theme === 'paper' ? '_light' : ''}.pdf`);
      if (createdHere) URL.revokeObjectURL(url);
    } finally {
      setDownloading(null);
    }
  };

  // Badge counts toggles that have been changed from their default. This is
  // more accurate than "count of off toggles" once defaults include opt-in
  // values like showTimeLogs (default off): a fresh project would otherwise
  // always show "1" without the user having touched anything.
  const hiddenCount = customizer
    ? TOGGLE_DEFINITIONS.filter(t => customizer.options[t.key] !== DEFAULT_INVOICE_PDF_OPTIONS[t.key]).length
    : 0;

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      // The light variant pins data-theme="dark" to hold the standard palette,
      // so its literal bg-white/zinc chrome survives the light theme's ink
      // remap even if rendered outside the portal's pinned subtree.
      {...(appearance === 'light' ? { 'data-theme': 'dark' } : {})}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === overlayRef.current && onClose()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fadeIn" />

      {/* Use dynamic viewport height (dvh) so the modal sizes against the
          *visible* area on mobile — `vh` reports the large viewport (browser
          chrome hidden) and would clip the modal behind Safari's URL bar /
          bottom toolbar. Tailwind class provides a `vh` fallback for legacy
          browsers (iOS < 15.4); the inline `dvh` overrides on modern browsers
          and is silently dropped on older ones, falling back to the class.
          max-w-6xl gives the PDF preview enough horizontal room to render
          letter-size pages at readable detail without forcing horizontal scroll. */}
      <div
        className={`relative w-full max-w-6xl h-[90vh] ${chrome.shell} rounded-xl animate-scaleIn flex flex-col overflow-hidden`}
        style={{ height: '90dvh' }}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-3 border-b ${chrome.headerBorder} flex-shrink-0`}>
          <div className="flex items-center gap-2 min-w-0">
            <FileText size={18} className="text-zinc-500 flex-shrink-0" />
            <h2 className={`font-semibold ${chrome.title} truncate`}>
              Invoice Preview · {invoiceNumber}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {customizer && (
              <div ref={customizeButtonRef}>
                <button
                  onClick={() => { setDownloadMenuOpen(false); setSettingsOpen(o => !o); }}
                  aria-label="Preview settings"
                  aria-expanded={settingsOpen}
                  className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                    settingsOpen ? chrome.customizeActive : chrome.customizeIdle
                  }`}
                >
                  <Settings size={14} />
                  <span className="hidden sm:inline">Customize</span>
                  {hiddenCount > 0 && (
                    <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold text-white bg-brand-600 rounded-full">
                      {hiddenCount}
                    </span>
                  )}
                </button>
              </div>
            )}

            <div ref={downloadButtonRef}>
              <button
                onClick={() => { setSettingsOpen(false); setDownloadMenuOpen(o => !o); }}
                disabled={!pdfData || !pdfLib || !docLib || downloading !== null}
                aria-haspopup="menu"
                aria-expanded={downloadMenuOpen}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {downloading
                  ? <><Loader2 size={14} className="animate-spin" /><span className="hidden sm:inline">Generating…</span></>
                  : <><Download size={14} /><span className="hidden sm:inline">Download PDF</span></>}
              </button>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className={`p-1.5 rounded-lg ${chrome.closeBtn} transition-colors`}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Which edition to download. The swatch is the canvas each one is drawn on. */}
        {downloadMenuOpen && (
          <div
            ref={downloadMenuRef}
            role="menu"
            aria-label="Choose an edition to download"
            className={`absolute right-5 top-[60px] z-20 w-64 max-w-[calc(100%-2.5rem)] ${chrome.panel} rounded-lg animate-slideDown py-1`}
          >
            {EDITIONS.map(({ theme, label, description }) => (
              <button
                key={theme}
                role="menuitem"
                onClick={() => downloadEdition(theme)}
                className={`w-full px-3 py-2 flex items-start gap-3 ${chrome.row} transition-colors text-left`}
              >
                <span
                  className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 rounded-full border ${
                    theme === 'dark' ? 'bg-[#08090C] border-white/20' : 'bg-white border-black/15'
                  }`}
                  aria-hidden="true"
                />
                <span className="flex-1 min-w-0">
                  <span className={`block text-xs font-medium ${chrome.rowLabel}`}>{label}</span>
                  <span className="block text-[10px] text-zinc-400 mt-0.5 leading-relaxed">{description}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {customizer && settingsOpen && (
          <div
            ref={settingsPanelRef}
            className={`absolute right-5 top-[60px] z-20 w-80 max-w-[calc(100%-2.5rem)] ${chrome.panel} rounded-lg animate-slideDown`}
          >
            <div className={`px-3 py-2.5 border-b ${chrome.panelDivider} flex items-center justify-between`}>
              <div>
                <h3 className={`text-xs font-semibold ${chrome.panelHeading}`}>Show on PDF</h3>
                <p className="text-[10px] text-zinc-400 mt-0.5">Applies to downloads and the client portal.</p>
              </div>
              <button
                onClick={customizer.resetOptions}
                className={`inline-flex items-center gap-1 text-[11px] font-medium ${chrome.panelReset} transition-colors`}
                aria-label="Reset to defaults"
              >
                <RotateCcw size={11} />
                Reset
              </button>
            </div>
            <div className="max-h-[360px] overflow-y-auto py-1">
              {TOGGLE_DEFINITIONS.map(({ key, label, description }) => {
                const enabled = customizer.options[key];
                return (
                  <button
                    key={key}
                    onClick={() => customizer.toggleOption(key)}
                    className={`w-full px-3 py-2 flex items-start gap-3 ${chrome.row} transition-colors text-left`}
                    role="switch"
                    aria-checked={enabled}
                  >
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-medium ${chrome.rowLabel}`}>{label}</p>
                      <p className="text-[10px] text-zinc-400 mt-0.5 leading-relaxed">{description}</p>
                    </div>
                    <span
                      className={`relative mt-0.5 inline-flex h-[18px] w-8 flex-shrink-0 items-center rounded-full transition-colors ${
                        enabled ? 'bg-brand-600' : chrome.trackOff
                      }`}
                    >
                      <span
                        className={`inline-block h-3 w-3 transform rounded-full ${chrome.knob} transition-transform ${
                          enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                        }`}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Body. Canvas-based renderer (PdfPagesPreview) replaces the native
            iframe PDFViewer because mobile browsers can only show page 1 of
            iframe-embedded PDFs and provide no navigation controls. */}
        <div className={`flex-1 ${chrome.body} min-h-0`}>
          {integrityError ? (
            <div className="w-full h-full flex items-center justify-center p-8">
              <div className={`max-w-lg rounded-xl border ${chrome.errorCard} p-5 text-center`}>
                <p className={`text-sm font-semibold ${chrome.errorTitle}`}>PDF generation blocked</p>
                <p className={`mt-2 text-sm leading-relaxed ${chrome.errorBody}`}>{integrityError}</p>
                <p className={`mt-3 text-xs ${chrome.errorFoot}`}>
                  The invoice was not rendered or downloaded because its saved billing details did not reconcile.
                </p>
              </div>
            </div>
          ) : previewLib ? (
            <previewLib.PdfPagesPreview file={previewUrl} appearance={appearance} />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-zinc-400">
              <Loader2 size={28} className="animate-spin mb-3" />
              <p className="text-sm">Generating preview…</p>
            </div>
          )}
        </div>

        <div className={`px-5 py-2 border-t ${chrome.footer} flex-shrink-0 text-[11px] text-center`}>
          {integrityError
            ? 'Download disabled until the invoice billing data reconciles.'
            : 'This preview reflects the invoice\'s current data. Changes update on reopen.'}
        </div>
      </div>
    </div>
  );
}
