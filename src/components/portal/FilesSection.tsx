'use client';

import { useRef } from 'react';
import { Download, Eye, Loader2, Upload } from 'lucide-react';
import type { PortalData } from '@/lib/types';
import { Tooltip } from '@/components/ui/Tooltip';
import { SectionCard, SectionCount, SectionHeader } from './SectionHeader';
import { FileTypeIcon, describeMime, formatFileSize, type PreviewFile } from './format';

type PortalFile = PortalData['files'][number];

export function FilesSection({
  files,
  uploading,
  onUpload,
  onPreview,
  onDownload,
}: {
  files: PortalData['files'];
  uploading: boolean;
  onUpload: (file: File) => void;
  onPreview: (file: PreviewFile) => void;
  onDownload: (file: PreviewFile & { id: string }) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const asPreview = (file: PortalFile) => ({
    id: file.id,
    name: file.name,
    file_url: file.file_url,
    mime_type: file.mime_type,
  });

  return (
    <SectionCard sectionKey="show_files">
      <SectionHeader title="Files" right={<SectionCount>{files.length}</SectionCount>} />

      {files.length > 0 ? (
        <ul>
          {files.map((file) => (
            <li key={file.id} className="vm-row flex items-center gap-3.5 py-3.5 first:pt-0 last:pb-0">
              <span
                className="vm-tile flex h-10 w-10 shrink-0 items-center justify-center vm-soft"
                aria-hidden="true"
              >
                <FileTypeIcon mimeType={file.mime_type} size={17} strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium">{file.name}</p>
                <p className="vm-faint mt-0.5 text-[13px]">
                  {formatFileSize(file.file_size)}
                  <span className="opacity-50" aria-hidden="true"> / </span>
                  {describeMime(file.mime_type)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip content="Preview">
                  <button
                    type="button"
                    onClick={() => onPreview(asPreview(file))}
                    aria-label={`Preview ${file.name}`}
                    className="vm-icon-btn"
                  >
                    <Eye size={16} aria-hidden="true" />
                  </button>
                </Tooltip>
                <Tooltip content="Download">
                  <button
                    type="button"
                    onClick={() => onDownload(asPreview(file))}
                    aria-label={`Download ${file.name}`}
                    className="vm-icon-btn"
                  >
                    <Download size={16} aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vm-muted text-[15px]">No files shared yet.</p>
      )}

      <div className="mt-7 flex flex-col items-center gap-4 rounded-2xl border border-dashed border-(--vm-line-strong) px-5 py-6 text-center sm:flex-row sm:justify-between sm:text-left">
        <div>
          <p className="text-[15px] font-medium">Send us a file</p>
          <p className="vm-muted mt-0.5 text-[13px]">Uploads go straight to the project team.</p>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="vm-btn vm-btn-ghost vm-btn-sm w-full sm:w-auto"
        >
          {uploading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />}
          {uploading ? 'Uploading' : 'Choose a file'}
        </button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            e.target.value = '';
          }}
        />
      </div>
    </SectionCard>
  );
}
