'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, ZoomIn, ZoomOut } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';

// Self-hosted worker. The matching `pdf.worker.min.mjs` is copied into
// public/ by the postinstall script in package.json so the version always
// tracks the bundled pdfjs-dist. Setting workerSrc once at module load is
// the documented react-pdf pattern.
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

// Zoom is applied as a scale multiplier on top of the fit-to-container width.
// 25% increments hit familiar "100% / 125% / 150%" steps; 2.5x ceiling is enough
// to read fine print without rendering a single page at 4000+ pixels.
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
// A page opens at 75%: the whole first page reads at a glance in the modal,
// and one step up is the fit-to-width 100%.
const ZOOM_DEFAULT = 0.75;

function clampZoom(z: number): number {
  // toFixed avoids accumulating float drift (e.g. 1 + 0.25 + 0.25 = 1.4999...).
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
}

interface PdfPagesPreviewProps {
  /** Blob URL or data URL pointing at a PDF. Null while the PDF is being generated. */
  file: string | null;
  /** Chrome variant, matching the hosting modal: 'themed' follows the app
   *  theme; 'light' keeps literal light styling for the pinned portal. */
  appearance?: 'themed' | 'light';
}

const ZOOM_CHROME = {
  themed: {
    toolbar: 'bg-surface-overlay/95 backdrop-blur-sm border border-white/[0.08]',
    button: 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]',
    label: 'text-zinc-300 hover:bg-white/[0.06]',
  },
  light: {
    toolbar: 'bg-white/95 backdrop-blur-sm border border-zinc-200',
    button: 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100',
    label: 'text-zinc-700 hover:bg-zinc-100',
  },
} as const;

/**
 * Scrollable canvas-based PDF preview. Renders every page stacked vertically
 * so users on mobile (where the native iframe PDF viewer typically only shows
 * page 1 with no controls) get the full document. Replaces
 * @react-pdf/renderer's <PDFViewer>, which delegates to the browser's native
 * viewer and is unreliable on iOS Safari and most Android browsers.
 */
export function PdfPagesPreview({ file, appearance = 'themed' }: PdfPagesPreviewProps) {
  const zoomChrome = ZOOM_CHROME[appearance];
  const containerRef = useRef<HTMLDivElement>(null);
  // Fallback for the brief window before the observer fires.
  const [pageWidth, setPageWidth] = useState<number>(800);
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  // Pair numPages with the file it belongs to so a `file` swap doesn't render
  // stale pages before onLoadSuccess fires for the new doc.
  const [loaded, setLoaded] = useState<{ file: string; numPages: number } | null>(null);
  const numPages = loaded && loaded.file === file ? loaded.numPages : 0;
  // The file whose first page has painted (or failed). Until the current file
  // settles, one "Generating preview" screen covers the document: without it a
  // regenerated PDF flashes three times on the way in (react-pdf's own loading
  // spinner, then empty page boxes, then the painted pages). The document
  // still mounts and renders underneath so the reveal is a single swap.
  const [settledFile, setSettledFile] = useState<string | null>(null);
  const settled = file !== null && settledFile === file;

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const apply = (w: number) => {
      if (w > 0) setPageWidth(w);
    };
    // Three measurements cover every layout race we've hit: synchronous for
    // the common case, rAF for when synchronous read happened before final
    // layout (modal animation / lazy mount), ResizeObserver for everything
    // after (window resize, mobile chrome toggling).
    apply(node.clientWidth - 32);
    const raf = requestAnimationFrame(() => apply(node.clientWidth - 32));
    const observer = new ResizeObserver((entries) => {
      apply(Math.floor(entries[0]?.contentRect.width ?? 0));
    });
    observer.observe(node);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      {/* One loading screen for every wait: no file yet, or a file whose
          pages have not painted. It sits over the document rather than
          replacing it so the pages are ready the moment it lifts. */}
      {!settled && (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center text-zinc-400"
          role="status"
          aria-live="polite"
        >
          <Loader2 size={28} className="animate-spin mb-3" aria-hidden="true" />
          <p className="text-sm">Generating preview…</p>
        </div>
      )}

      {/* overflow-auto handles both axes: vertical for page stacking, horizontal
          for zoomed-in pages that exceed the container width. */}
      {/* No own background: the hosting modal's body paints the surface so the
          scroll area matches its chrome variant. */}
      {/* `invisible` keeps layout (the width observer needs it) while hiding
          react-pdf's intermediate states behind the loading screen. */}
      <div
        ref={containerRef}
        className={`w-full h-full overflow-auto px-4 py-4 ${settled ? '' : 'invisible'}`}
        aria-hidden={!settled}
      >
        {file && (
          <Document
            file={file}
            onLoadSuccess={({ numPages: n }) => setLoaded({ file, numPages: n })}
            onLoadError={() => setSettledFile(file)}
            loading={null}
            error={
              <div className="w-full text-center text-zinc-500 py-8 text-sm">
                Couldn&apos;t render preview. Try downloading the PDF instead.
              </div>
            }
          >
            {/* inline-flex + min-w-full lets pages stay centered when they fit
                and pushes container scroll when they don't (zoomed in). Plain
                `flex items-center` would left-align overflowing children. */}
            <div className="inline-flex flex-col items-center min-w-full">
              {/* No paper-white plate behind a page: the document paints its own
                  canvas, and a hairline ring gives a dark page an edge against the
                  dark body. */}
              {Array.from({ length: numPages }, (_, i) => (
                <div key={i} className="mb-4 last:mb-0 shadow-lg ring-1 ring-white/10">
                  <Page
                    pageNumber={i + 1}
                    width={pageWidth}
                    scale={zoom}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    loading={null}
                    // The first painted page is the signal to lift the loading
                    // screen; the rest paint below the fold.
                    onRenderSuccess={i === 0 ? () => setSettledFile(file) : undefined}
                  />
                </div>
              ))}
            </div>
          </Document>
        )}
      </div>

      {/* Floating zoom toolbar. Only renders once the pages are on screen so
          the controls don't appear over the loading screen. */}
      {settled && numPages > 0 && (
        <div
          className={`absolute bottom-3 right-3 z-10 flex items-center gap-0.5 ${zoomChrome.toolbar} rounded-lg shadow-lg p-1`}
          role="toolbar"
          aria-label="Zoom"
        >
          <button
            type="button"
            onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
            disabled={zoom <= ZOOM_MIN}
            aria-label="Zoom out"
            title="Zoom out"
            className={`p-1.5 rounded ${zoomChrome.button} disabled:opacity-40 disabled:cursor-not-allowed transition-colors`}
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(ZOOM_DEFAULT)}
            aria-label={`Reset zoom to ${Math.round(ZOOM_DEFAULT * 100)}% (current ${Math.round(zoom * 100)}%)`}
            title={`Reset to ${Math.round(ZOOM_DEFAULT * 100)}%`}
            className={`px-2 py-1 text-[11px] font-medium ${zoomChrome.label} tabular-nums rounded transition-colors min-w-[42px] text-center`}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
            disabled={zoom >= ZOOM_MAX}
            aria-label="Zoom in"
            title="Zoom in"
            className={`p-1.5 rounded ${zoomChrome.button} disabled:opacity-40 disabled:cursor-not-allowed transition-colors`}
          >
            <ZoomIn size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
