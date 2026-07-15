'use client';

import { useState, useEffect } from 'react';
import { Download, Pencil } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Modal from '@/components/ui/Modal';

const MARKDOWN_STYLES = `<style>
.md-preview{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2328;word-wrap:break-word}
.md-preview>*:first-child{margin-top:0}
.md-preview>*:last-child{margin-bottom:0}
.md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4,.md-preview h5,.md-preview h6{margin-top:24px;margin-bottom:16px;font-weight:600;line-height:1.25;color:#1f2328}
.md-preview h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid #d1d9e0}
.md-preview h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid #d1d9e0}
.md-preview h3{font-size:1.25em}
.md-preview h4{font-size:1em}
.md-preview h5{font-size:.875em}
.md-preview h6{font-size:.85em;color:#656d76}
.md-preview p{margin-top:0;margin-bottom:16px}
.md-preview a{color:#0969da;text-decoration:none}
.md-preview a:hover{text-decoration:underline}
.md-preview strong{font-weight:600}
.md-preview em{font-style:italic}
.md-preview ul,.md-preview ol{margin-top:0;margin-bottom:16px;padding-left:2em}
.md-preview ul{list-style-type:disc}
.md-preview ol{list-style-type:decimal}
.md-preview li+li{margin-top:.25em}
.md-preview li>ul,.md-preview li>ol{margin-top:.25em;margin-bottom:0}
.md-preview blockquote{margin:0 0 16px;padding:0 1em;color:#656d76;border-left:.25em solid #d1d9e0}
.md-preview blockquote>:last-child{margin-bottom:0}
.md-preview code{padding:.2em .4em;font-size:85%;white-space:break-spaces;background-color:rgba(175,184,193,.2);border-radius:6px;font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}
.md-preview pre{margin-top:0;margin-bottom:16px;padding:16px;overflow:auto;font-size:85%;line-height:1.45;background-color:#f6f8fa;border-radius:6px;border:1px solid #d1d9e0}
.md-preview pre code{padding:0;font-size:100%;background-color:transparent;border-radius:0;white-space:pre}
.md-preview hr{height:.25em;padding:0;margin:24px 0;background-color:#d1d9e0;border:0;border-radius:2px}
.md-preview table{border-spacing:0;border-collapse:collapse;margin-top:0;margin-bottom:16px;width:max-content;max-width:100%;overflow:auto;display:block}
.md-preview table th,.md-preview table td{padding:6px 13px;border:1px solid #d1d9e0}
.md-preview table th{font-weight:600;background-color:#f6f8fa}
.md-preview table tr:nth-child(2n){background-color:#f6f8fa}
.md-preview img{max-width:100%;height:auto;border-radius:6px}
.md-preview input[type="checkbox"]{margin:0 .2em .25em -1.4em;vertical-align:middle}
</style>`;

interface FilePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: { name: string; file_url: string; mime_type: string } | null;
  onEdit?: (file: { name: string; file_url: string; mime_type: string }) => void;
}

const TEXT_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.sh', '.bash', '.yml', '.yaml', '.toml', '.ini', '.env', '.sql', '.graphql', '.vue', '.svelte', '.md', '.txt', '.csv', '.json', '.xml', '.html', '.htm'];

function isTextBasedFile(mimeType: string, fileName: string): boolean {
  if (['text/html', 'text/markdown', 'text/plain', 'text/csv', 'text/xml', 'application/json'].includes(mimeType)) return true;
  if (mimeType.startsWith('text/')) return true;
  const ext = '.' + fileName.split('.').pop()?.toLowerCase();
  return TEXT_EXTENSIONS.includes(ext);
}

function isSpreadsheetFile(mimeType: string, fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return true;
  if (mimeType === 'text/csv' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mimeType === 'application/vnd.ms-excel') return true;
  return false;
}

function isEditableNote(mimeType: string, fileName: string): boolean {
  if (mimeType === 'text/markdown' || mimeType === 'text/plain') return true;
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'txt';
}

function parseCsvToRows(text: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let inQuotes = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(current);
        current = '';
      } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(current);
        current = '';
        rows.push(row);
        row = [];
        if (ch === '\r') i++;
      } else {
        current += ch;
      }
    }
  }
  if (current || row.length > 0) {
    row.push(current);
    rows.push(row);
  }
  return rows;
}

function SpreadsheetTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return <p className="text-sm text-zinc-500 p-4">Empty spreadsheet</p>;
  const header = rows[0];
  const body = rows.slice(1);

  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-zinc-200">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0">
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="px-3 py-2 text-left font-semibold text-zinc-700 bg-zinc-100 border-b border-r border-zinc-200 last:border-r-0 whitespace-nowrap"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-zinc-50/60'}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="px-3 py-1.5 text-zinc-600 border-b border-r border-zinc-100 last:border-r-0 whitespace-nowrap"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FilePreviewModal({ isOpen, onClose, file, onEdit }: FilePreviewModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [sheetRows, setSheetRows] = useState<string[][] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !file) {
      setContent(null);
      setSheetRows(null);
      return;
    }

    if (file.file_url === '#') return;

    // Reset state before fetching to prevent stale content flash
    setContent(null);
    setSheetRows(null);

    const ext = file.name.split('.').pop()?.toLowerCase();
    const isXlsx = ext === 'xlsx' || ext === 'xls' || file.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || file.mime_type === 'application/vnd.ms-excel';
    const isCsv = ext === 'csv' || file.mime_type === 'text/csv';

    if (isXlsx) {
      setLoading(true);
      (async () => {
        try {
          const XLSX = await import('xlsx');
          const res = await fetch(file.file_url);
          const buf = await res.arrayBuffer();
          const wb = XLSX.read(buf, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
          setSheetRows(rows);
        } catch {
          setSheetRows(null);
        } finally {
          setLoading(false);
        }
      })();
    } else if (isCsv) {
      setLoading(true);
      fetch(file.file_url)
        .then(res => res.text())
        .then(text => {
          setContent(text);
          setSheetRows(parseCsvToRows(text));
        })
        .catch(() => { setContent(null); setSheetRows(null); })
        .finally(() => setLoading(false));
    } else if (isTextBasedFile(file.mime_type, file.name)) {
      setLoading(true);
      fetch(file.file_url)
        .then(res => res.text())
        .then(text => setContent(text))
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    }
  }, [isOpen, file]);

  if (!file) return null;

  const handleDownload = async () => {
    try {
      const res = await fetch(file.file_url);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // silent
    }
  };

  const mime = file.mime_type;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';
  const isHtml = mime === 'text/html';
  const isMarkdown = mime === 'text/markdown' || ext === 'md';
  const isSpreadsheet = isSpreadsheetFile(mime, file.name);
  const isVideo = mime.startsWith('video/');
  const isAudio = mime.startsWith('audio/');
  const isPlainText = isTextBasedFile(mime, file.name) && !isHtml && !isMarkdown && !isSpreadsheet;
  const canEdit = isEditableNote(mime, file.name) && onEdit;

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-48">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      );
    }

    if (isImage) {
      return (
        <div className="flex items-center justify-center">
          <img src={file.file_url} alt={file.name} className="max-h-[70vh] max-w-full object-contain rounded-lg" />
        </div>
      );
    }

    if (isPdf) {
      return <iframe src={file.file_url} className="w-full h-[70vh] rounded-lg border border-zinc-200" title={file.name} />;
    }

    if (isHtml && content !== null) {
      return (
        <iframe
          srcDoc={content}
          sandbox="allow-scripts"
          className="w-full h-[70vh] rounded-lg border border-zinc-200"
          title={file.name}
        />
      );
    }

    if (isMarkdown && content !== null) {
      const html = DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
      const styledHtml = MARKDOWN_STYLES + html;
      return (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-zinc-200 bg-white">
          <div
            className="md-preview px-6 py-5"
            dangerouslySetInnerHTML={{ __html: styledHtml }}
          />
        </div>
      );
    }

    if (isSpreadsheet && sheetRows !== null) {
      return <SpreadsheetTable rows={sheetRows} />;
    }

    if (isPlainText && content !== null) {
      return (
        <pre className="text-sm font-mono whitespace-pre-wrap break-words max-h-[70vh] overflow-auto p-4 bg-zinc-50 rounded-lg border border-zinc-200 text-zinc-700">
          {content}
        </pre>
      );
    }

    if (isVideo) {
      return (
        <video controls className="w-full max-h-[70vh] rounded-lg">
          <source src={file.file_url} type={mime} />
          Your browser does not support video playback.
        </video>
      );
    }

    if (isAudio) {
      return (
        <div className="flex items-center justify-center py-12">
          <audio controls className="w-full max-w-md">
            <source src={file.file_url} type={mime} />
            Your browser does not support audio playback.
          </audio>
        </div>
      );
    }

    // Unsupported type
    return (
      <div className="text-center py-12">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-zinc-100 flex items-center justify-center">
          <Download size={24} className="text-zinc-400" />
        </div>
        <p className="text-sm font-medium text-zinc-700 mb-1">Preview not available</p>
        <p className="text-xs text-zinc-400 mb-4">This file type cannot be previewed in the browser.</p>
        <button
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
        >
          <Download size={14} />
          Download File
        </button>
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={file.name} size="4xl">
      {renderContent()}

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-zinc-200">
        {canEdit && (
          <button
            onClick={() => onEdit!(file)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 bg-brand-50 hover:bg-brand-100 rounded-lg transition-colors"
          >
            <Pencil size={14} />
            Edit
          </button>
        )}
        {file.file_url !== '#' && (
          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-lg transition-colors"
          >
            <Download size={14} />
            Download
          </button>
        )}
      </div>
    </Modal>
  );
}
