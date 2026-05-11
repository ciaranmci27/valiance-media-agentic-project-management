'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Download, Loader2, FileText, Settings, RotateCcw } from 'lucide-react';
import type { InvoicePdfData, InvoicePdfOptions } from '@/lib/invoice-pdf/types';
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

interface InvoicePreviewModalViewProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-built PDF data. Pass null while still loading. */
  pdfData: InvoicePdfData | null;
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
}

const TOGGLE_DEFINITIONS: { key: keyof InvoicePdfOptions; label: string; description: string }[] = [
  { key: 'showLogo',                label: 'Logo',                 description: 'Show the brand logo in the header.' },
  { key: 'showTopAccent',           label: 'Top accent bar',       description: 'Brand-colored bar at the top of every page.' },
  { key: 'showStatusStamp',         label: 'Status stamp',         description: 'Diagonal PAID / OVERDUE / CANCELLED stamp.' },
  { key: 'showSenderName',          label: 'Sender name',          description: 'Your name underneath the business in “From”.' },
  { key: 'showLineCaptions',        label: 'Line item captions',   description: 'Service period and frequency under each line item.' },
  { key: 'showPortalLink',          label: 'Client portal link',   description: 'Callout linking to the project portal (only shown when enabled).' },
  { key: 'showNotes',               label: 'Notes',                description: 'Per-invoice notes block.' },
  { key: 'showPaymentInstructions', label: 'Payment instructions', description: 'Payment instructions block from Business Info.' },
  { key: 'showFooter',              label: 'Footer',               description: 'Page numbers, business name, and generated date.' },
  { key: 'showTimeLogs',            label: 'Time log page',        description: 'Append a second page listing the time entries that back the hourly line items.' },
];

function sanitizeForFilename(input: string): string {
  return input.replace(/[^a-z0-9\-_.]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

export function InvoicePreviewModalView({
  isOpen,
  onClose,
  pdfData,
  invoiceNumber,
  clientLabel,
  invoiceDate,
  customizer,
  onDownload,
}: InvoicePreviewModalViewProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const customizeButtonRef = useRef<HTMLDivElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);

  const [pdfLib, setPdfLib] = useState<PdfModule | null>(null);
  const [docLib, setDocLib] = useState<DocModule | null>(null);
  const [previewLib, setPreviewLib] = useState<PreviewModule | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
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

  // Esc closes the dropdown first, then the modal.
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (settingsOpen) setSettingsOpen(false);
      else onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, settingsOpen]);

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

  const handleDownload = async () => {
    if (!pdfData) return;
    setDownloading(true);
    onDownload?.();
    try {
      // Reuse the preview blob when available so we don't pay the
      // generation cost twice. Only fall back to a fresh render if the
      // preview hasn't finished yet (rare race).
      let url = previewUrl;
      let createdHere = false;
      if (!url) {
        if (!pdfLib || !docLib) return;
        const blob = await pdfLib.pdf(<docLib.InvoiceDocument data={pdfData} />).toBlob();
        url = URL.createObjectURL(blob);
        createdHere = true;
      }
      const filename = `${sanitizeForFilename(invoiceNumber)}_${sanitizeForFilename(clientLabel)}_${invoiceDate}.pdf`;
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      if (createdHere) URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === overlayRef.current && onClose()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fadeIn" />

      {/* Use dynamic viewport height (dvh) so the modal sizes against the
          *visible* area on mobile — `vh` reports the large viewport (browser
          chrome hidden) and would clip the modal behind Safari's URL bar /
          bottom toolbar. Tailwind class provides a `vh` fallback for legacy
          browsers (iOS < 15.4); the inline `dvh` overrides on modern browsers
          and is silently dropped on older ones, falling back to the class. */}
      <div
        className="relative w-full max-w-4xl h-[90vh] bg-white rounded-xl shadow-2xl animate-scaleIn flex flex-col overflow-hidden"
        style={{ height: '90dvh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileText size={18} className="text-zinc-500 flex-shrink-0" />
            <h2 className="font-semibold text-zinc-900 truncate">
              Invoice Preview · {invoiceNumber}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {customizer && (
              <div ref={customizeButtonRef}>
                <button
                  onClick={() => setSettingsOpen(o => !o)}
                  aria-label="Preview settings"
                  aria-expanded={settingsOpen}
                  className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                    settingsOpen
                      ? 'bg-zinc-100 text-zinc-900'
                      : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100'
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

            <button
              onClick={handleDownload}
              disabled={!pdfData || (!previewUrl && (!pdfLib || !docLib)) || downloading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {downloading
                ? <><Loader2 size={14} className="animate-spin" /><span className="hidden sm:inline">Generating…</span></>
                : <><Download size={14} /><span className="hidden sm:inline">Download PDF</span></>}
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {customizer && settingsOpen && (
          <div
            ref={settingsPanelRef}
            className="absolute right-5 top-[60px] z-20 w-80 max-w-[calc(100%-2.5rem)] bg-white border border-zinc-200 rounded-lg shadow-xl animate-slideDown"
          >
            <div className="px-3 py-2.5 border-b border-zinc-100 flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-zinc-700">Show on PDF</h3>
                <p className="text-[10px] text-zinc-400 mt-0.5">Applies to downloads and the client portal.</p>
              </div>
              <button
                onClick={customizer.resetOptions}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 hover:text-brand-600 transition-colors"
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
                    className="w-full px-3 py-2 flex items-start gap-3 hover:bg-zinc-50 transition-colors text-left"
                    role="switch"
                    aria-checked={enabled}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-zinc-800">{label}</p>
                      <p className="text-[10px] text-zinc-400 mt-0.5 leading-relaxed">{description}</p>
                    </div>
                    <span
                      className={`relative mt-0.5 inline-flex h-[18px] w-8 flex-shrink-0 items-center rounded-full transition-colors ${
                        enabled ? 'bg-brand-600' : 'bg-zinc-200'
                      }`}
                    >
                      <span
                        className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
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
        <div className="flex-1 bg-zinc-100 min-h-0">
          {previewLib ? (
            <previewLib.PdfPagesPreview file={previewUrl} />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-zinc-400">
              <Loader2 size={28} className="animate-spin mb-3" />
              <p className="text-sm">Generating preview…</p>
            </div>
          )}
        </div>

        <div className="px-5 py-2 border-t border-zinc-100 flex-shrink-0 text-[11px] text-zinc-400 text-center">
          This preview reflects the invoice&apos;s current data. Changes update on reopen.
        </div>
      </div>
    </div>
  );
}
