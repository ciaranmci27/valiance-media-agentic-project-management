'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Download, Eye, Pin } from 'lucide-react';
import type { PortalData, PortalUpdateType } from '@/lib/types';
import { Tooltip } from '@/components/ui/Tooltip';
import { SectionCard, SectionCount, SectionHeader } from './SectionHeader';
import { FileTypeIcon, formatFileSize, relativeTime, type PreviewFile } from './format';

const UPDATES_INITIAL_COUNT = 5;
const CONTENT_TRUNCATE_LENGTH = 180;

type Update = PortalData['updates'][number];
type Attachment = Update['attachments'][number];

/** Teal for things that are done, copper for things that want attention. */
const TYPE_CHIP: Partial<Record<PortalUpdateType, { label: string; className: string }>> = {
  milestone: { label: 'Milestone', className: 'vm-chip-teal' },
  deliverable: { label: 'Deliverable', className: 'vm-chip-teal' },
  note: { label: 'Note', className: 'vm-chip-copper' },
};

function UpdateContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = content.length > CONTENT_TRUNCATE_LENGTH;
  const shown = !needsTruncation || expanded ? content : `${content.slice(0, CONTENT_TRUNCATE_LENGTH).trimEnd()}…`;

  return (
    <div className="mt-2.5">
      <p className="vm-muted whitespace-pre-line text-[15px] leading-relaxed">{shown}</p>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="mt-1.5 text-[13px] font-medium text-(--vm-teal-200) transition-colors hover:text-(--vm-ink)"
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  );
}

function AttachmentRow({
  attachment,
  onPreview,
  onDownload,
}: {
  attachment: Attachment;
  onPreview: (file: PreviewFile) => void;
  onDownload: (file: PreviewFile & { id: string }) => void;
}) {
  const isImage = attachment.mime_type.startsWith('image/');
  const isHtml = attachment.mime_type === 'text/html';
  const file = { id: attachment.id, name: attachment.name, file_url: attachment.file_url, mime_type: attachment.mime_type };

  return (
    <li className="vm-tile flex items-center gap-3 py-1.5 pl-1.5 pr-1">
      {isImage ? (
        // User-uploaded content at an arbitrary URL; next/image has nothing to optimise here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={attachment.file_url} alt="" className="h-10 w-10 shrink-0 rounded-[10px] object-cover" />
      ) : (
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.04] vm-soft"
          aria-hidden="true"
        >
          <FileTypeIcon mimeType={attachment.mime_type} size={16} strokeWidth={1.75} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px]">{attachment.name}</span>
        <span className="vm-faint block text-[13px]">{formatFileSize(attachment.file_size)}</span>
      </span>
      <Tooltip content="Preview">
        <button type="button" onClick={() => onPreview(file)} aria-label={`Preview ${attachment.name}`} className="vm-icon-btn h-9 w-9">
          <Eye size={15} aria-hidden="true" />
        </button>
      </Tooltip>
      {!isHtml && (
        <Tooltip content="Download">
          <button type="button" onClick={() => onDownload(file)} aria-label={`Download ${attachment.name}`} className="vm-icon-btn h-9 w-9">
            <Download size={15} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </li>
  );
}

export function UpdatesSection({
  updates,
  onPreview,
  onDownload,
}: {
  updates: PortalData['updates'];
  onPreview: (file: PreviewFile) => void;
  /** Fires when the client downloads an attachment; the page emits file_download. */
  onDownload: (file: PreviewFile & { id: string }) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  // Pinned first, then newest. The glow marks the newest by date, which is
  // not always the first row once pins are hoisted.
  const { sorted, newestId } = useMemo(() => {
    const sorted = [...updates].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    let newest: Update | null = null;
    for (const u of updates) {
      if (!newest || u.created_at > newest.created_at) newest = u;
    }
    return { sorted, newestId: newest?.id ?? null };
  }, [updates]);

  const visible = showAll ? sorted : sorted.slice(0, UPDATES_INITIAL_COUNT);
  const hiddenCount = sorted.length - UPDATES_INITIAL_COUNT;

  return (
    <SectionCard sectionKey="show_updates">
      <SectionHeader title="Latest" serif="updates." right={<SectionCount>{updates.length}</SectionCount>} />

      <ol>
        {visible.map((update, index) => {
          const isLast = index === visible.length - 1;
          const isNewest = update.id === newestId;
          const chip = TYPE_CHIP[update.update_type];
          const fullDate = new Date(update.created_at).toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
          });

          return (
            <li key={update.id} className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-4 pb-8 last:pb-0">
              {!isLast && (
                <span className="absolute bottom-0 left-[9px] top-5 w-px bg-(--vm-line)" aria-hidden="true" />
              )}
              <span
                aria-hidden="true"
                className={`relative mt-[7px] h-2.5 w-2.5 justify-self-center rounded-full ${
                  isNewest
                    ? 'vm-dot-live'
                    : 'border border-(--vm-line-strong) bg-(--vm-bg)'
                }`}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <h3 className="text-[16px] font-medium leading-snug">{update.title}</h3>
                  {chip && <span className={`vm-chip ${chip.className}`}>{chip.label}</span>}
                  {update.pinned && (
                    <span className="vm-chip vm-chip-copper">
                      <Pin size={10} aria-hidden="true" />
                      Pinned
                    </span>
                  )}
                </div>
                <div className="vm-faint mt-1.5 flex flex-wrap items-center gap-x-2 text-[13px]">
                  <span>{update.author_name}</span>
                  <span className="opacity-50" aria-hidden="true">/</span>
                  <Tooltip content={fullDate}>
                    <time dateTime={update.created_at}>{relativeTime(update.created_at)}</time>
                  </Tooltip>
                </div>

                {update.content && <UpdateContent content={update.content} />}

                {update.attachments && update.attachments.length > 0 && (
                  <ul className="mt-3.5 flex flex-col gap-2">
                    {update.attachments.map((a) => (
                      <AttachmentRow key={a.id} attachment={a} onPreview={onPreview} onDownload={onDownload} />
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {sorted.length > UPDATES_INITIAL_COUNT && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
          className="vm-btn vm-btn-ghost vm-btn-sm mt-7 w-full sm:w-auto"
        >
          <ChevronDown size={15} aria-hidden="true" className={`transition-transform ${showAll ? 'rotate-180' : ''}`} />
          {showAll ? 'Show less' : `Show ${hiddenCount} more update${hiddenCount === 1 ? '' : 's'}`}
        </button>
      )}
    </SectionCard>
  );
}
