'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';

// Self-hosted worker. The matching `pdf.worker.min.mjs` is copied into
// public/ by the postinstall script in package.json so the version always
// tracks the bundled pdfjs-dist. Setting workerSrc once at module load is
// the documented react-pdf pattern.
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

interface PdfPagesPreviewProps {
  /** Blob URL or data URL pointing at a PDF. Null while the PDF is being generated. */
  file: string | null;
}

/**
 * Scrollable canvas-based PDF preview. Renders every page stacked vertically
 * so users on mobile (where the native iframe PDF viewer typically only shows
 * page 1 with no controls) get the full document. Replaces
 * @react-pdf/renderer's <PDFViewer>, which delegates to the browser's native
 * viewer and is unreliable on iOS Safari and most Android browsers.
 */
export function PdfPagesPreview({ file }: PdfPagesPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Conservative initial width that fits any reasonable mobile viewport.
  // Real value is set by the ResizeObserver as soon as the container mounts.
  const [pageWidth, setPageWidth] = useState<number>(320);
  // Track numPages alongside the file it belongs to. When `file` changes
  // mid-render, `numPages` is treated as 0 until onLoadSuccess fires for the
  // new file, avoiding both stale page renders and a setState-in-effect.
  const [loaded, setLoaded] = useState<{ file: string; numPages: number } | null>(null);
  const numPages = loaded && loaded.file === file ? loaded.numPages : 0;

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => {
      // Subtract the container's horizontal padding (px-4 = 32px) and cap at
      // 800px so pages don't get gigantic on ultrawide screens. Letter at 800w
      // gives ~1035px tall, still crisp at typical zoom levels.
      const w = Math.min(800, node.clientWidth - 32);
      if (w > 0) setPageWidth(w);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!file) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-zinc-400">
        <Loader2 size={28} className="animate-spin mb-3" />
        <p className="text-sm">Generating preview…</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto bg-zinc-100 px-4 py-4">
      <Document
        file={file}
        onLoadSuccess={({ numPages: n }) => setLoaded({ file, numPages: n })}
        loading={
          <div className="w-full flex flex-col items-center justify-center text-zinc-400 py-8">
            <Loader2 size={28} className="animate-spin mb-3" />
            <p className="text-sm">Loading preview…</p>
          </div>
        }
        error={
          <div className="w-full text-center text-zinc-500 py-8 text-sm">
            Couldn&apos;t render preview. Try downloading the PDF instead.
          </div>
        }
        className="flex flex-col items-center"
      >
        {Array.from({ length: numPages }, (_, i) => (
          <div key={i} className="mb-4 last:mb-0 bg-white shadow-md">
            <Page
              pageNumber={i + 1}
              width={pageWidth}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              loading={null}
            />
          </div>
        ))}
      </Document>
    </div>
  );
}
